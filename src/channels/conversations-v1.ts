/**
 * Conversations v1 messaging handler
 *
 * Handles inbound WhatsApp/SMS messages via Twilio Conversations v1 webhooks.
 * Used when MESSAGING_MODE=conversations-v1 for Flex handoff support.
 *
 * TAC is still used for:
 *  - Memory retrieval (Memora)
 *  - Profile lookup
 *  - Tool definitions and execution
 *  - LLM providers
 *
 * What this module handles:
 *  - Processing Conversations v1 webhook events (onMessageAdded)
 *  - Sending responses via Conversations v1 API
 *  - Handoff to Flex via Interactions API
 *  - Typing indicators
 */

import Twilio from 'twilio';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { TAC, ConversationSession, TACMemoryResponse, ConversationId } from 'twilio-agent-connect';
import type { LLMProvider } from '../providers/types.js';
import { config } from '../config.js';
import { allTools } from '../tools/index.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ConversationWebhookPayload {
  ConversationSid: string;
  MessageSid?: string;
  Body?: string;
  Author?: string;
  ParticipantSid?: string;
  EventType: string;
  Source?: string;
  ClientIdentity?: string;
}

interface ConversationsV1Options {
  tac: TAC;
  getProvider: (conversationId: ConversationId) => Promise<LLMProvider>;
  handlePostCompletion: (provider: LLMProvider, conversationId: ConversationId, channel: string) => Promise<void>;
  injectMemoryContext: (provider: LLMProvider, memory: TACMemoryResponse, session: ConversationSession) => void;
}

// ─── State ───────────────────────────────────────────────────────────────────

const client = new Twilio.Twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

/** Tracks conversations that have been handed off to a human agent */
const handedOffConversations = new Set<string>();

/** Simple session store for v1 conversations (keyed by ConversationSid) */
const v1Sessions = new Map<string, {
  customerPhone: string;
  profileId?: string;
  customerName?: string;
  memoryLoaded: boolean;
}>();

// ─── Typing Indicator ────────────────────────────────────────────────────────

const TYPING_INDICATOR_DELAY_MS = 1000;

async function sendTypingIndicator(customerPhone: string): Promise<void> {
  try {
    await new Promise(resolve => setTimeout(resolve, TYPING_INDICATOR_DELAY_MS));

    const authHeader =
      'Basic ' +
      Buffer.from(
        `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
      ).toString('base64');

    const listUrl = new URL(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`
    );
    listUrl.searchParams.set('From', customerPhone);
    listUrl.searchParams.set('PageSize', '1');

    const listResponse = await fetch(listUrl.toString(), {
      headers: { Authorization: authHeader },
    });

    if (!listResponse.ok) {
      console.warn(`[V1] Typing indicator: message list failed (${listResponse.status})`);
      return;
    }

    const listData = (await listResponse.json()) as { messages?: { sid: string }[] };
    if (!listData.messages || listData.messages.length === 0) {
      console.warn(`[V1] Typing indicator: no messages found for ${customerPhone}`);
      return;
    }

    const messageSid = listData.messages[0]!.sid;

    const typingResponse = await fetch('https://messaging.twilio.com/v2/Indicators/Typing.json', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: authHeader,
      },
      body: new URLSearchParams({
        messageId: messageSid,
        channel: 'whatsapp',
      }).toString(),
    });

    if (!typingResponse.ok) {
      const errorText = await typingResponse.text();
      console.warn(`[V1] Typing indicator failed (${typingResponse.status}): ${errorText}`);
    }
  } catch (error) {
    console.warn('[V1] Typing indicator error:', error);
  }
}

// ─── Handoff via Interactions API ────────────────────────────────────────────

/**
 * Removes bot webhooks from a conversation so the bot stops receiving messages
 * after handoff to a human agent. Matches webhooks by the VOICE_PUBLIC_DOMAIN
 * (ngrok domain) in the webhook URL.
 */
async function removeBotWebhooks(conversationSid: string): Promise<void> {
  const publicDomain = process.env.VOICE_PUBLIC_DOMAIN;

  if (!publicDomain) {
    console.warn('[V1] VOICE_PUBLIC_DOMAIN not configured, cannot identify bot webhooks to remove');
    return;
  }

  try {
    const webhooks = await client.conversations.v1
      .conversations(conversationSid)
      .webhooks
      .list();

    for (const webhook of webhooks) {
      const webhookUrl = (webhook.configuration as { url?: string })?.url;

      if (webhookUrl && webhookUrl.includes(publicDomain)) {
        console.log(`[V1] Removing bot webhook ${webhook.sid} with URL: ${webhookUrl}`);
        await client.conversations.v1
          .conversations(conversationSid)
          .webhooks(webhook.sid)
          .remove();
      }
    }
  } catch (error) {
    console.error('[V1] Error removing bot webhooks:', error);
    // Don't throw — we still want the handoff to proceed
  }
}

export async function handleHandoff(
  conversationSid: string,
  reason: string,
  customerPhone?: string,
  tac?: InstanceType<typeof import('twilio-agent-connect').TAC>
): Promise<void> {
  try {
    const v1Session = v1Sessions.get(conversationSid);
    const phone = v1Session?.customerPhone || customerPhone || 'unknown';

    // Fetch customer name from profile if we have a profileId
    let customerName: string | undefined;
    if (tac && v1Session?.profileId) {
      try {
        const profile = await tac.fetchProfile(v1Session.profileId);
        if (profile?.traits) {
          // Traits may be nested under a group (e.g. { Contact: { firstName, lastName } })
          // or flat (e.g. { firstName, lastName }). Search both levels.
          const traits = profile.traits as Record<string, unknown>;
          let firstName: string | undefined;
          let lastName: string | undefined;

          for (const value of Object.values(traits)) {
            if (typeof value === 'object' && value !== null) {
              const nested = value as Record<string, unknown>;
              if (nested.firstName) firstName = String(nested.firstName);
              if (nested.lastName) lastName = String(nested.lastName);
              if (nested.first_name) firstName = String(nested.first_name);
              if (nested.last_name) lastName = String(nested.last_name);
            }
          }
          // Also check flat keys
          if (!firstName && traits.firstName) firstName = String(traits.firstName);
          if (!lastName && traits.lastName) lastName = String(traits.lastName);
          if (!firstName && traits.first_name) firstName = String(traits.first_name);
          if (!lastName && traits.last_name) lastName = String(traits.last_name);

          const nameParts = [firstName, lastName].filter(Boolean);
          if (nameParts.length > 0) {
            customerName = nameParts.join(' ');
          }
        }
      } catch (err) {
        console.warn(`[V1] Failed to fetch profile for handoff name:`, err);
      }
    }

    const taskAttributes = {
      type: 'conversation',
      conversationSid,
      name: customerName || phone,
      channel_type: 'chat',
      direction: 'inbound',
      handoff_reason: reason,
    };

    console.log(`[V1] Creating Flex interaction for handoff:`, { conversationSid, reason });

    // 1. Create a Flex Interaction — links the existing v1 conversation to Flex
    const interaction = await client.flexApi.v1.interaction.create({
      channel: {
        type: 'whatsapp',
        initiated_by: 'customer',
        properties: {
          media_channel_sid: conversationSid,
        },
      },
      routing: {
        properties: {
          workspace_sid: config.twilio.workspaceSid!,
          workflow_sid: config.twilio.workflowSid!,
          task_channel_unique_name: 'chat',
          attributes: taskAttributes,
        },
      },
    });

    console.log(`[V1] Flex interaction created: ${interaction.sid}`);

    // 2. Mark as handed off so we stop processing messages
    handedOffConversations.add(conversationSid);

    // 3. Remove bot webhooks so the bot stops receiving messages
    await removeBotWebhooks(conversationSid);

    // 4. Update conversation attributes
    const conversation = await client.conversations.v1.conversations(conversationSid).fetch();
    const existingAttrs = JSON.parse(conversation.attributes || '{}');

    await client.conversations.v1.conversations(conversationSid).update({
      attributes: JSON.stringify({
        ...existingAttrs,
        handedOff: true,
        interactionSid: interaction.sid,
        handoffTimestamp: new Date().toISOString(),
      }),
    });

    console.log(`[V1] Handoff complete for ${conversationSid}`);
  } catch (error) {
    console.error('[V1] Failed to create Flex interaction:', error);
    throw error;
  }
}

// ─── Register Routes ─────────────────────────────────────────────────────────

export function registerConversationsV1Routes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fastify: any,
  options: ConversationsV1Options
): void {
  const { tac, getProvider, handlePostCompletion, injectMemoryContext } = options;

  fastify.post(
    '/conversations-webhook',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const payload = request.body as ConversationWebhookPayload;

      // Respond immediately
      await reply.code(200).send({ status: 'ok' });

      try {
        const { ConversationSid, Body, Author, EventType, ParticipantSid } = payload;
        console.log(`[V1] Webhook received: ${EventType} on ${ConversationSid} from ${Author}`);

        // Only process actual messages
        if (EventType !== 'onMessageAdded') return;

        // Ignore system/bot messages
        const conversationsServiceSid = config.twilio.conversationsServiceSid;
        if (Author === 'system' || Author === 'assistant' || Author === conversationsServiceSid) {
          return;
        }

        // Ignore if already handed off to human agent
        if (handedOffConversations.has(ConversationSid)) {
          console.log(`[V1] Ignoring message for handed-off conversation: ${ConversationSid}`);
          return;
        }

        if (!Body?.trim()) return;

        // Get participant details for phone number
        let customerPhone = '';
        if (ParticipantSid) {
          try {
            const participant = await client.conversations.v1
              .conversations(ConversationSid)
              .participants(ParticipantSid)
              .fetch();
            customerPhone = String(participant.messagingBinding?.address || '');
          } catch (err) {
            console.warn(`[V1] Failed to fetch participant:`, err);
          }
        }

        const conversationId = ConversationSid as ConversationId;
        const provider = await getProvider(conversationId);

        // Build a lightweight session for TAC memory/profile
        let v1Session = v1Sessions.get(ConversationSid);
        if (!v1Session) {
          v1Session = { customerPhone, memoryLoaded: false };
          v1Sessions.set(ConversationSid, v1Session);
        }

        // Retrieve memory and profile via TAC (phone-number based, no Maestro dependency)
        if (!v1Session.memoryLoaded && customerPhone) {
          const phoneForLookup = customerPhone.replace(/^whatsapp:/i, '');

          // Build a mock ConversationSession for TAC's memory retrieval
          const session: ConversationSession = {
            conversationId: ConversationSid,
            channel: 'whatsapp',
            startedAt: new Date(),
            metadata: {},
            authorInfo: { address: customerPhone },
          };

          try {
            const memory = await tac.retrieveMemory(session, Body);
            v1Session.profileId = session.profileId;
            v1Session.memoryLoaded = true;

            // Fetch profile traits
            if (session.profileId) {
              const profileResponse = await tac.fetchProfile(session.profileId);
              if (profileResponse) {
                session.profile = { profileId: profileResponse.id, traits: profileResponse.traits };
              }
            }

            injectMemoryContext(provider, memory, session);
          } catch (err) {
            console.warn(`[V1] Memory retrieval failed:`, err);
            v1Session.memoryLoaded = true; // Don't retry on failure
          }

          provider.addSystemContext(`Customer phone: ${phoneForLookup}`);
        }

        // Send typing indicator for WhatsApp (fire-and-forget)
        if (customerPhone.startsWith('whatsapp:')) {
          sendTypingIndicator(customerPhone);
        }

        // Generate LLM response
        const response = await provider.generateResponse(Body, allTools);

        // Send response via Conversations v1
        await client.conversations.v1
          .conversations(ConversationSid)
          .messages
          .create({
            body: response,
            author: 'assistant',
          });

        // Handle post-completion side effects (handoff, language switch, etc.)
        await handlePostCompletion(provider, conversationId, 'whatsapp');
      } catch (error) {
        console.error('[V1] Error processing message:', error);
      }
    }
  );
}

/**
 * Check if a conversation has been handed off
 */
export function isHandedOff(conversationSid: string): boolean {
  return handedOffConversations.has(conversationSid);
}

/**
 * Clean up v1 session state
 */
export function cleanupV1Session(conversationSid: string): void {
  v1Sessions.delete(conversationSid);
  handedOffConversations.delete(conversationSid);
}
