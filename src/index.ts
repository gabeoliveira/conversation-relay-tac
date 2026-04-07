/**
 * Conversation Relay Application — powered by Twilio Agent Connect
 *
 * This replaces the original Express + WebSocket + Redis architecture with TAC's
 * built-in channel management, session handling, and memory retrieval.
 *
 * What TAC handles:
 *  - WebSocket protocol (ConversationRelay setup/prompt/interrupt messages)
 *  - Conversation lifecycle (Maestro create/close/participants)
 *  - Session state (ConversationSession per active conversation)
 *  - Memory retrieval (Memora observations/summaries, or Maestro fallback)
 *  - Webhook validation (Twilio signature checks)
 *  - TwiML generation for incoming calls
 *  - Graceful shutdown
 *
 * What this application handles:
 *  - LLM integration (3 providers: Chat Completions, Responses, Agents)
 *  - Tool definitions and execution (business logic)
 *  - Prompts (system prompt, additional context)
 *  - Side-effect routing (handoff, language switch, end interaction)
 */
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import {
  TAC,
  TACConfig,
  TACServer,
  VoiceChannel,
  SMSChannel,
  WhatsAppChannel,
  ConversationId,
  ConversationSession,
  TACMemoryResponse,
} from 'twilio-agent-connect';

import { config } from './config.js';
import { allTools } from './tools/index.js';
import { createLLMProvider } from './providers/factory.js';
import { languageOptions } from './languageOptions.js';
import type { LLMProvider } from './providers/types.js';
import { registerConversationsV1Routes, handleHandoff } from './channels/conversations-v1.js';

// ─── Initialize TAC ──────────────────────────────────────────────────────────

const isMaestroMode = config.messagingMode === 'maestro';

const tac = new TAC({ config: TACConfig.fromEnv() });
const voiceChannel = new VoiceChannel(tac);
tac.registerChannel(voiceChannel);

// Messaging channels are only registered in Maestro mode.
// In conversations-v1 mode, messaging is handled via a custom webhook route.
let smsChannel: InstanceType<typeof SMSChannel> | undefined;
let whatsappChannel: InstanceType<typeof WhatsAppChannel> | undefined;

if (isMaestroMode) {
  smsChannel = new SMSChannel(tac);
  whatsappChannel = new WhatsAppChannel(tac);
  tac.registerChannel(smsChannel);
  tac.registerChannel(whatsappChannel);
}

// ─── LLM Provider per conversation ──────────────────────────────────────────

const providers = new Map<string, LLMProvider>();
const aiParticipantRegistered = new Set<string>();

async function getProvider(conversationId: ConversationId): Promise<LLMProvider> {
  const key = conversationId as string;
  let provider = providers.get(key);
  if (!provider) {
    provider = await createLLMProvider();
    providers.set(key, provider);
  }
  return provider;
}

// ─── Message Handler (unified for voice and SMS) ─────────────────────────────

tac.onMessageReady(async ({ conversationId, message, memory, session, channel }) => {
  console.log(`[TAC] Message from ${channel}: "${message.substring(0, 80)}..."`);

  const provider = await getProvider(conversationId);

  // Fetch profile traits if we have a profileId but no profile yet
  if (session.profileId && !session.profile) {
    try {
      const profileResponse = await tac.fetchProfile(session.profileId);
      if (profileResponse) {
        session.profile = { profileId: profileResponse.id, traits: profileResponse.traits };
      }
    } catch (err) {
      console.warn(`[TAC] Failed to fetch profile for ${session.profileId}:`, err);
    }
  }

  // Inject memory context if available
  if (memory) {
    injectMemoryContext(provider, memory, session);
  }

  // Inject customer phone for messaging channels (voice gets it via the setup callback)
  if (channel !== 'voice' && session.authorInfo?.address) {
    const customerPhone = session.authorInfo.address.replace(/^whatsapp:/i, '');
    provider.addSystemContext(`Customer phone: ${customerPhone}`);

    // Register AI agent participant on first message so Maestro tags it as AI_AGENT
    const convKey = conversationId as string;
    if (!aiParticipantRegistered.has(convKey)) {
      aiParticipantRegistered.add(convKey);
      const tacConfig = tac.getConfig();
      const agentAddress = channel === 'whatsapp'
        ? tacConfig.twilioWhatsAppNumber!
        : tacConfig.twilioPhoneNumber;
      const agentChannel = channel === 'whatsapp' ? 'WHATSAPP' : 'SMS';
      try {
        await tac.getConversationClient().addParticipant(
          convKey,
          [{ channel: agentChannel, address: agentAddress }],
          'AI_AGENT'
        );
      } catch (err) {
        console.warn(`[TAC] Failed to register AI agent participant:`, err);
      }
    }
  }

  if (channel === 'voice') {
    // ── Voice: stream tokens to WebSocket ──
    const streamController = voiceChannel.startStreamTask(conversationId);

    try {
      for await (const token of provider.streamResponse(message, allTools, streamController.signal)) {
        if (streamController.signal.aborted) break;
        if (token) {
          voiceChannel.sendResponse(conversationId, token);
        }
      }
    } catch (err) {
      if (!streamController.signal.aborted) {
        console.error(`[Voice] Stream error for ${conversationId}:`, err);
      }
    } finally {
      voiceChannel.completeStreamTask(conversationId);
    }

    // Handle side effects after streaming
    await handlePostCompletion(provider, conversationId, channel);

  } else if (isMaestroMode) {
    // ── Messaging (SMS / WhatsApp) via Maestro ──
    const messagingChannel = channel === 'whatsapp' ? whatsappChannel! : smsChannel!;
    try {
      const response = await provider.generateResponse(message, allTools);
      await messagingChannel.sendResponse(conversationId, response);
      await handlePostCompletion(provider, conversationId, channel);
    } catch (err) {
      console.error(`[${channel.toUpperCase()}] Error for ${conversationId}:`, err);
    }
  }
});

// ─── Voice Interrupt Handler ────────────────────────────────────────────────

tac.onInterrupt(async ({ conversationId, reason }) => {
  console.log(`[TAC] Interrupt on ${conversationId}: ${reason}`);
  // Stream task is already cancelled by VoiceChannel.handleInterruptMessage
  // The provider's AbortSignal will break the stream loop
});

// ─── Conversation Ended Handler ─────────────────────────────────────────────

tac.onConversationEnded(async ({ session }) => {
  const key = session.conversationId as string;
  providers.delete(key);
  console.log(`[TAC] Conversation ended: ${session.conversationId}`);
});

// ─── Handoff Handler ────────────────────────────────────────────────────────

tac.onHandoff(async ({ conversationId, reason, session }) => {
  console.log(`[TAC] Handoff requested for ${conversationId}: ${reason}`);

  if (!isMaestroMode) {
    // In v1 mode, hand off via Interactions API
    const customerPhone = session.authorInfo?.address;
    await handleHandoff(conversationId as string, reason, customerPhone);
  }
});

// ─── Post-Completion Side Effects ───────────────────────────────────────────

async function handlePostCompletion(
  provider: LLMProvider,
  conversationId: ConversationId,
  channel: string
): Promise<void> {
  const action = provider.getLastAction();
  if (!action) return;

  provider.clearLastAction();

  switch (action.type) {
    case 'handoff':
      console.log(`[Action] Triggering handoff: ${action.reason}`);
      if (isMaestroMode) {
        await tac.triggerHandoff(conversationId, action.reason);
      } else {
        await handleHandoff(conversationId as string, action.reason, undefined, tac);
      }
      break;

    case 'switchLanguage':
      console.log(`[Action] Language switch to: ${action.targetLanguage}`);
      // For voice, the language switch would be handled via ConversationRelay
      // protocol if supported. For now, we log it.
      break;

    case 'endInteraction':
      console.log(`[Action] End interaction after survey`);
      // The VoiceChannel will handle closing the conversation
      // when the WebSocket disconnects
      break;
  }
}

// ─── Memory Context Injection ───────────────────────────────────────────────

function injectMemoryContext(
  provider: LLMProvider,
  memory: TACMemoryResponse,
  session: ConversationSession
): void {
  const parts: string[] = [];

  // Add observations (things Memora knows about this user)
  if (memory.observations.length > 0) {
    parts.push('User observations:');
    for (const obs of memory.observations.slice(0, 5)) {
      parts.push(`- ${obs.content}`);
    }
  }

  // Add summaries (past conversation summaries)
  if (memory.summaries.length > 0) {
    parts.push('\nConversation summaries:');
    for (const summary of memory.summaries.slice(0, 3)) {
      parts.push(`- ${summary.content}`);
    }
  }

  // Add recent communications
  if (memory.communications.length > 0) {
    parts.push('\nRecent conversation history:');
    for (const comm of memory.communications.slice(0, 10)) {
      const author = comm.author?.name || 'Unknown';
      const content = comm.content?.text || '';
      if (content) parts.push(`${author}: ${content}`);
    }
  }

  // Add profile traits if available
  if (session.profile?.traits) {
    parts.push('\nUser profile:');
    for (const [key, value] of Object.entries(session.profile.traits)) {
      if (value !== null && value !== undefined) {
        parts.push(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
      }
    }
  }

  if (parts.length > 0) {
    provider.addSystemContext(parts.join('\n'));
  }
}

// ─── Voice Setup Callback (inject call context) ─────────────────────────────

voiceChannel.on('setup', ({ conversationId, from, customParameters }: {
  conversationId: ConversationId;
  profileId: string | undefined;
  callSid: string;
  from: string;
  to: string;
  customParameters: Record<string, string> | undefined;
}) => {
  // Inject call context into the LLM provider (async, fire-and-forget)
  getProvider(conversationId).then((provider) => {
    const userContext: Record<string, unknown> = { customerPhone: from };
    if (customParameters) {
      userContext.customParameters = customParameters;
    }
    provider.addSystemContext(`Call Context: ${JSON.stringify(userContext, null, 2)}`);
  });
});

// ─── Start Server ───────────────────────────────────────────────────────────

const defaultLanguage = languageOptions.portuguese;

const server = new TACServer(tac, {
  voice: {
    host: '0.0.0.0',
    port: config.server.port,
  },
  conversationRelayConfig: {
    welcomeGreeting: config.welcomeGreeting,
    dtmfDetection: true,
    interruptible: 'any',
    ttsProvider: defaultLanguage.ttsProvider,
    ttsLanguage: defaultLanguage.ttsLanguage,
    voice: defaultLanguage.voice,
    transcriptionProvider: defaultLanguage.transcriptionProvider,
    transcriptionLanguage: defaultLanguage.transcriptionLanguage,
    speechModel: defaultLanguage.speechModel,
  },
  development: true,
});

// In conversations-v1 mode, register the v1 webhook route on the same Fastify instance
if (!isMaestroMode) {
  registerConversationsV1Routes(server.app, {
    tac,
    getProvider,
    handlePostCompletion,
    injectMemoryContext,
  });
}

server
  .start()
  .then(() => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Conversation Relay (TAC) — port ${config.server.port}`);
    console.log(`  LLM Provider: ${config.llm.provider}`);
    console.log(`  Model: ${config.llm.model}`);
    console.log(`  Messaging Mode: ${config.messagingMode}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  })
  .catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
