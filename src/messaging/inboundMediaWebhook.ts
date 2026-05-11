/**
 * Inbound media webhook handler (Programmable Messaging — direct Sender path).
 *
 * Why we need this: Conversation Orchestrator drops media attachments — only
 * the text body of WhatsApp/SMS/RCS messages enters the conversation. To keep
 * Conversation Intelligence + Memora aware of media content (audio
 * transcriptions today, image descriptions next), we listen on the underlying
 * Programmable Messaging webhook for the WhatsApp Sender, transcribe / extract
 * locally, and inject the resulting text back into CO via insertCommunication.
 *
 * Wiring:
 *   1. In Twilio Console → WhatsApp Senders → set "Webhook URL for incoming
 *      messages" to `https://<your-host><INBOUND_MEDIA_ROUTE_PATH>`
 *      (default `/inbound-message`).
 *   2. The route is only registered when `config.inboundMedia.enabled` is true
 *      AND `OPENAI_API_KEY` is set (Whisper requires it).
 *
 * Signature validation uses TAC's auth token (the same one TAC uses to
 * validate its own webhooks). Unsigned/invalid requests get 403'd.
 */
import { type FastifyInstance } from 'fastify';
import twilio from 'twilio';
import type { TAC } from 'twilio-agent-connect';

const { validateRequest } = twilio;

import { config } from '../config.js';
import { transcribeAudio } from './transcribeAudio.js';
import { describeImage } from './describeImage.js';
import { insertCommunication, type ParticipantRef } from './insertCommunication.js';

interface ProgrammableMessagingPayload {
  MessageSid?: string;
  AccountSid?: string;
  From?: string;
  To?: string;
  Body?: string;
  NumMedia?: string;
  [key: string]: string | undefined;
}

interface InboundMediaContext {
  messageSid: string;
  from: string; // e.g. "whatsapp:+5511..."
  to: string;   // e.g. "whatsapp:+5511..."
  mediaUrl: string;
  contentType: string;
}

export function registerInboundMediaWebhook(server: { fastify: FastifyInstance }, tac: TAC): void {
  if (!config.inboundMedia.enabled) {
    console.log('[InboundMedia] disabled (set INBOUND_MEDIA_ENABLED=true to enable)');
    return;
  }
  if (!config.openai.apiKey) {
    console.warn('[InboundMedia] enabled but OPENAI_API_KEY is missing; route not registered.');
    return;
  }

  const path = config.inboundMedia.routePath;
  const tacConfig = tac.getConfig();

  server.fastify.register(async (instance) => {
    instance.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          const parsed: Record<string, string> = {};
          for (const [k, v] of new URLSearchParams(body as string)) parsed[k] = v;
          done(null, parsed);
        } catch (err) {
          done(err as Error, undefined);
        }
      }
    );

    instance.post(path, async (req, reply) => {
      const sig = req.headers['x-twilio-signature'] as string | undefined;
      const proto =
        (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
      const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
      const url = `${proto}://${host}${req.url}`;
      const params = (req.body ?? {}) as ProgrammableMessagingPayload;

      if (!sig || !validateRequest(tacConfig.authToken, sig, url, params as Record<string, string>)) {
        console.warn('[InboundMedia] signature validation failed', { url, hasSig: !!sig });
        await reply.code(403).send({ error: 'invalid signature' });
        return;
      }

      // ACK immediately (Twilio retries slow webhooks).
      await reply.code(200).send();

      // Process async — we already responded to Twilio.
      void processInboundMessage(params, tac).catch((err) =>
        console.error('[InboundMedia] processing error:', err)
      );
    });

    console.log(`[InboundMedia] route registered at ${path}`);
  });
}

async function processInboundMessage(
  params: ProgrammableMessagingPayload,
  tac: TAC
): Promise<void> {
  const numMedia = parseInt(params.NumMedia || '0', 10);
  if (!numMedia) {
    // No media. CO has already captured any text portion — nothing to do.
    return;
  }

  const messageSid = params.MessageSid || '';
  const from = params.From || '';
  const to = params.To || '';

  if (!from || !to) {
    console.warn('[InboundMedia] missing From/To, skipping', { messageSid });
    return;
  }

  // Find the active conversation for this customer/agent address pair.
  const targetConv = await findActiveConversation(tac, from, to);
  if (!targetConv) {
    console.warn(
      `[InboundMedia] no active conversation found for ${maskAddress(from)} → ${maskAddress(to)}; ` +
      'customer needs to send a text message first to establish a conversation.'
    );
    return;
  }

  for (let i = 0; i < numMedia; i++) {
    const mediaUrl = params[`MediaUrl${i}`];
    const contentType = params[`MediaContentType${i}`] || 'application/octet-stream';
    if (!mediaUrl) continue;

    const ctx: InboundMediaContext = { messageSid, from, to, mediaUrl, contentType };
    try {
      await handleMediaItem(ctx, targetConv, tac);
    } catch (err) {
      console.error(`[InboundMedia] failed to handle ${contentType}:`, err);
    }
  }
}

async function handleMediaItem(
  ctx: InboundMediaContext,
  target: ActiveConv,
  tac: TAC
): Promise<void> {
  // Audio → Whisper
  if (ctx.contentType.startsWith('audio/')) {
    const buffer = await downloadMedia(ctx.mediaUrl, tac);
    const transcription = await transcribeAudio(buffer, { contentType: ctx.contentType });
    if (!transcription) {
      console.warn('[InboundMedia] transcription returned null (no API key?)');
      return;
    }
    await insertWithLog(
      tac,
      target,
      `[áudio transcrito] ${transcription.text}`,
      `transcribed audio (${transcription.text.length} chars)`
    );
    return;
  }

  // Image → vision model
  if (ctx.contentType.startsWith('image/')) {
    const buffer = await downloadMedia(ctx.mediaUrl, tac);
    const description = await describeImage(buffer, { contentType: ctx.contentType });
    if (!description) {
      console.warn('[InboundMedia] image description returned null (no API key?)');
      return;
    }
    await insertWithLog(
      tac,
      target,
      `[imagem recebida] ${description.text}`,
      `described image (${description.text.length} chars, model=${description.model})`
    );
    return;
  }

  // Other media types (video, document, vCard) — not handled yet.
  // Extend by adding a new branch + helper following the audio/image pattern.
  console.log(`[InboundMedia] no handler for ${ctx.contentType}, skipping`);
}

async function insertWithLog(
  tac: TAC,
  target: ActiveConv,
  text: string,
  summary: string
): Promise<void> {
  console.log(`[InboundMedia] ${summary}, inserting into ${target.conversationId}`);
  const result = await insertCommunication(tac, {
    conversationId: target.conversationId,
    from: target.customer,
    to: [target.agent],
    text,
  });
  if (result.success) {
    console.log(`[InboundMedia] insert OK — actionId=${result.actionId} messageSid=${result.messageSid}`);
  } else {
    console.error(`[InboundMedia] insert FAILED — status=${result.status} error=${result.error}`);
  }
}

async function downloadMedia(mediaUrl: string, tac: TAC): Promise<Buffer> {
  const cfg = tac.getConfig();
  const auth = 'Basic ' + Buffer.from(`${cfg.apiKey}:${cfg.apiSecret}`).toString('base64');
  const resp = await fetch(mediaUrl, { headers: { Authorization: auth } });
  if (!resp.ok) {
    throw new Error(`Media download ${resp.status} ${resp.statusText} for ${mediaUrl}`);
  }
  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

interface ActiveConv {
  conversationId: string;
  customer: ParticipantRef;
  agent: ParticipantRef;
}

async function findActiveConversation(tac: TAC, fromAddr: string, toAddr: string): Promise<ActiveConv | null> {
  const cfg = tac.getConfig();
  const baseUrl = cfg.region
    ? `https://conversations.${cfg.region}.twilio.com`
    : 'https://conversations.twilio.com';
  const auth = 'Basic ' + Buffer.from(`${cfg.apiKey}:${cfg.apiSecret}`).toString('base64');

  let pageToken: string | undefined;
  let scanned = 0;
  const maxToScan = 200;

  while (scanned < maxToScan) {
    const url = new URL(`${baseUrl}/v2/Conversations`);
    url.searchParams.set('Status', 'ACTIVE');
    url.searchParams.set('PageSize', '50');
    if (pageToken) url.searchParams.set('PageToken', pageToken);

    const resp = await fetch(url.toString(), { headers: { Authorization: auth } });
    if (!resp.ok) {
      console.warn(`[InboundMedia] list conversations failed: ${resp.status}`);
      return null;
    }
    const data = (await resp.json()) as {
      conversations?: Array<{
        id: string;
        participants?: Array<{
          id: string;
          type: string;
          addresses?: Array<{ address?: string; channel?: string }>;
        }>;
      }>;
      meta?: { nextToken?: string };
    };
    for (const conv of data.conversations ?? []) {
      const customer = conv.participants?.find((p) =>
        p.addresses?.some((a) => a.address === fromAddr)
      );
      const agent = conv.participants?.find((p) =>
        p.addresses?.some((a) => a.address === toAddr)
      );
      if (customer && agent && customer.id !== agent.id) {
        const customerAddr = customer.addresses?.find((a) => a.address === fromAddr);
        const agentAddr = agent.addresses?.find((a) => a.address === toAddr);
        if (!customerAddr?.channel || !agentAddr?.channel || !customerAddr.address || !agentAddr.address) continue;
        return {
          conversationId: conv.id,
          customer: {
            channel: customerAddr.channel as ParticipantRef['channel'],
            address: customerAddr.address,
            participantId: customer.id,
          },
          agent: {
            channel: agentAddr.channel as ParticipantRef['channel'],
            address: agentAddr.address,
            participantId: agent.id,
          },
        };
      }
      scanned++;
    }
    pageToken = data.meta?.nextToken;
    if (!pageToken) break;
  }
  return null;
}

function maskAddress(s: string): string {
  if (s.length < 6) return '***';
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
}
