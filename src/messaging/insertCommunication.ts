/**
 * Insert a Communication into an existing Maestro conversation, attributed to
 * an arbitrary participant — typically the customer. Useful for surfacing
 * application-side content (audio transcriptions, OCR'd images, etc.) into
 * the conversation so that:
 *
 *  - TAC's `onMessageReady` fires for it (the agent processes it as a normal
 *    inbound turn);
 *  - Conversation Intelligence operators run on it (observations and
 *    summaries pick up the content as if it were a native text message);
 *  - The customer's conversation history reflects the actual content of the
 *    media they sent, not just a media URL.
 *
 * TAC's `ConversationClient` doesn't ship a builder for this — only
 * `createAction(SEND_MESSAGE)`. Worth filing an upstream PR.
 *
 * ## Mechanism
 *
 *   POST /v2/Conversations/{id}/Communications
 *   {
 *     "author":     { "channel": "WHATSAPP", "address": "...", "participantId": "..." },
 *     "recipients": [{ "channel": "WHATSAPP", "address": "...", "participantId": "..." }],
 *     "content":    { "type": "TEXT", "text": "..." }
 *   }
 *
 * Returns `201 Created` with the Communication's id and underlying messaging
 * channel SID. Channel must be WHATSAPP, SMS, CHAT, or RCS — VOICE is not
 * supported (voice transcripts arrive natively via ConversationRelay).
 *
 * NOTES (the hard-won kind):
 *
 *  - `content.type: "TEXT"` is **required** despite the API spec marking it
 *    optional with enum `["TRANSCRIPTION"]`. Without it the runtime returns a
 *    misleading 400 "Request input may be invalid".
 *  - `participantId` is **required** on both author and recipients[] despite
 *    the spec marking it optional.
 *  - The sibling `Actions/INSERT_COMMUNICATION` endpoint requires the
 *    participant to have a v1-bridge `CH...` channelId on its address;
 *    without that binding it 400s with "could not find a Channel with the
 *    specified From address". This REST endpoint has no such requirement —
 *    works in pure-Maestro setups without any v1 bridge.
 *
 * ## Typical flow (audio transcription)
 *
 *   1. WhatsApp inbound webhook with `content.media` (audio, no text)
 *   2. Application short-circuits normal LLM processing (no text, nothing for
 *      the agent to reply to yet)
 *   3. Application downloads the media and runs it through a transcription
 *      model (Whisper, Deepgram, etc.)
 *   4. `insertCommunication(tac, { ... text: transcription })` posts the
 *      transcribed text as a customer message
 *   5. The newly-inserted communication fires `COMMUNICATION_CREATED` →
 *      TAC's `onMessageReady` → the agent replies normally
 *   6. CI operators run on the inserted text just like any other message
 */
import type { TAC } from 'twilio-agent-connect';

/** Channels for which Maestro accepts INSERT_COMMUNICATION. */
export type InsertCommunicationChannel = 'WHATSAPP' | 'SMS' | 'CHAT' | 'RCS';

export interface ParticipantRef {
  channel: InsertCommunicationChannel;
  /** Channel-formatted address (e.g. `whatsapp:+5511...`, `+15551...`). REQUIRED. */
  address: string;
  /** Conversation Orchestrator participant ID (`conv_participant_*`). REQUIRED. */
  participantId: string;
}

export interface InsertCommunicationOptions {
  conversationId: string;
  /** The participant the communication is attributed to (typically the customer). */
  from: ParticipantRef;
  /** Recipient(s). Normally a single agent participant. */
  to: ParticipantRef[];
  /** The text content (transcription, OCR result, etc.). */
  text: string;
  /**
   * Optional. WhatsApp Sender SID etc. Must match the participant's address
   * channelId for some channels. If your conversation's WhatsApp participants
   * have a `channelId` populated, pass it through.
   */
  channelSettings?: { channelId?: string };
}

export interface InsertCommunicationResult {
  success: boolean;
  /** Maestro action id (`conv_action_*`) when 202 Accepted. */
  actionId?: string;
  /** Underlying messaging SID (`IM*`) for the inserted communication. */
  messageSid?: string;
  status?: number;
  error?: string;
}

/**
 * POST an INSERT_COMMUNICATION action to Maestro.
 *
 * Uses the credentials and region from `tac.getConfig()` so it picks up the
 * same auth + base URL as the rest of TAC. Does NOT require any extra setup.
 */
export async function insertCommunication(
  tac: TAC,
  options: InsertCommunicationOptions
): Promise<InsertCommunicationResult> {
  const config = tac.getConfig();
  const baseUrl = config.region
    ? `https://conversations.${config.region}.twilio.com`
    : 'https://conversations.twilio.com';
  // Uses the REST `POST /v2/Conversations/{id}/Communications` endpoint, NOT
  // the `Actions/INSERT_COMMUNICATION` variant. The REST path attributes the
  // communication to the supplied participant without requiring a v1-bridge
  // `CH...` channelId binding (which the Action API silently demands). The
  // request MUST include `content.type: "TEXT"` — the API spec marks it
  // optional but the runtime returns a vague 400 without it.
  const url = `${baseUrl}/v2/Conversations/${options.conversationId}/Communications`;
  const auth = 'Basic ' + Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString('base64');

  const body: Record<string, unknown> = {
    author: options.from,
    recipients: options.to,
    content: { type: 'TEXT', text: options.text },
  };
  if (options.channelSettings?.channelId) {
    body.channelId = options.channelSettings.channelId;
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { success: false, status: resp.status, error: text };
    }
    const data = (await resp.json()) as {
      id?: string;
      channelId?: string | null;
      author?: { participantId?: string };
    };
    return {
      success: true,
      status: resp.status,
      // The REST endpoint returns the Communication directly. Surface its id
      // and channelId (the underlying message SID, IM... for WhatsApp).
      actionId: data.id,
      messageSid: data.channelId ?? undefined,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
