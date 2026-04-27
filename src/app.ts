/**
 * createApp() — configurable entry point for Conversation Relay + TAC
 *
 * Usage (simple — edit prompts/tools in place):
 *   import { createApp } from './app.js';
 *   import { systemPrompt } from './prompts/systemPrompt.js';
 *   import { allTools } from './tools/index.js';
 *   createApp({ systemPrompt, tools: allTools });
 *
 * Usage (multi-agent — import as dependency):
 *   import { createApp } from 'conversation-relay-tac/app';
 *   createApp({
 *     systemPrompt: 'You are a banking assistant...',
 *     tools: [myTool1, myTool2],
 *   });
 */

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
import type { TACTool } from 'twilio-agent-connect';

import { config } from './config.js';
import { createLLMProvider } from './providers/factory.js';
import { getAdditionalContext } from './prompts/additionalContext.js';
import { languageOptions, type LanguageOption } from './languageOptions.js';
import type { LLMProvider } from './providers/types.js';
import { registerConversationsV1Routes, handleHandoff } from './channels/conversations-v1.js';

// ─── App Options ─────────────────────────────────────────────────────────────

export interface AppOptions {
  /** System prompt — defines the AI persona and guidelines */
  systemPrompt: string;

  /** Static tools the LLM can call */
  tools: TACTool[];

  /**
   * Optional factory for tools that need access to the TAC instance
   * (e.g., knowledge base search tools). Called after TAC is initialized,
   * and the returned tools are appended to `tools`.
   */
  buildDynamicTools?: (tac: TAC) => TACTool[];

  /** Dynamic context injected on each message (e.g., current date/time). Defaults to date/time. */
  additionalContext?: () => string;

  /** Language config for voice TTS/STT. Defaults to Portuguese. */
  defaultLanguage?: LanguageOption;

  /** Welcome greeting for voice calls */
  welcomeGreeting?: string;

  /**
   * Additional ConversationRelay attributes to merge into the TwiML.
   * These override defaults set by createApp(). Use this for advanced settings
   * like intelligenceService, interruptSensitivity, preemptible, debug, etc.
   */
  conversationRelayConfig?: Record<string, unknown>;
}

// ─── createApp ───────────────────────────────────────────────────────────────

export function createApp(options: AppOptions): void {
  const {
    systemPrompt,
    tools: staticTools,
    buildDynamicTools,
    additionalContext = getAdditionalContext,
    defaultLanguage = languageOptions.portuguese,
    welcomeGreeting = config.welcomeGreeting,
    conversationRelayConfig: extraRelayConfig = {},
  } = options;

  // ─── Initialize TAC ────────────────────────────────────────────────────────

  const isMaestroMode = config.messagingMode === 'maestro';

  const tac = new TAC({ config: TACConfig.fromEnv() });
  const voiceChannel = new VoiceChannel(tac);
  tac.registerChannel(voiceChannel);

  // Build final tools list — static + dynamic (e.g. knowledge tools that need tac)
  const tools: TACTool[] = buildDynamicTools
    ? [...staticTools, ...buildDynamicTools(tac)]
    : staticTools;

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
      // Inject system prompt and additional context on first creation
      provider.addSystemContext(systemPrompt);
      provider.addSystemContext(additionalContext());
      providers.set(key, provider);
    }
    return provider;
  }

  // ─── WhatsApp Typing Indicator ───────────────────────────────────────────────

  function sendWhatsAppTypingIndicator(customerPhone: string): void {
    const tacConfig = tac.getConfig();
    void (async () => {
      try {
        await new Promise(resolve => setTimeout(resolve, 1000));

        const authHeader =
          'Basic ' +
          Buffer.from(`${tacConfig.twilioAccountSid}:${tacConfig.twilioAuthToken}`).toString('base64');

        const listUrl = new URL(
          `https://api.twilio.com/2010-04-01/Accounts/${tacConfig.twilioAccountSid}/Messages.json`
        );
        listUrl.searchParams.set('From', customerPhone);
        listUrl.searchParams.set('PageSize', '1');

        const listResponse = await fetch(listUrl.toString(), {
          headers: { Authorization: authHeader },
        });
        if (!listResponse.ok) return;

        const listData = (await listResponse.json()) as { messages?: { sid: string }[] };
        if (!listData.messages || listData.messages.length === 0) return;

        await fetch('https://messaging.twilio.com/v2/Indicators/Typing.json', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: authHeader,
          },
          body: new URLSearchParams({
            messageId: listData.messages[0]!.sid,
            channel: 'whatsapp',
          }).toString(),
        });
      } catch {
        // Fire-and-forget
      }
    })();
  }

  // ─── Memory Context Injection ───────────────────────────────────────────────

  function injectMemoryContext(
    provider: LLMProvider,
    memory: TACMemoryResponse,
    session: ConversationSession
  ): void {
    const parts: string[] = [];

    if (memory.observations.length > 0) {
      parts.push('User observations:');
      for (const obs of memory.observations.slice(0, 5)) {
        parts.push(`- ${obs.content}`);
      }
    }

    if (memory.summaries.length > 0) {
      parts.push('\nConversation summaries:');
      for (const summary of memory.summaries.slice(0, 3)) {
        parts.push(`- ${summary.content}`);
      }
    }

    if (memory.communications.length > 0) {
      parts.push('\nRecent conversation history:');
      for (const comm of memory.communications.slice(0, 10)) {
        const author = comm.author?.name || 'Unknown';
        const content = comm.content?.text || '';
        if (content) parts.push(`${author}: ${content}`);
      }
    }

    if (session.profileId) {
      parts.push(`\nProfile ID: ${session.profileId}`);
    }

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
        break;

      case 'endInteraction':
        console.log(`[Action] End interaction after survey`);
        break;
    }
  }

  // ─── Message Handler ────────────────────────────────────────────────────────

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

    // Inject customer phone for messaging channels
    if (channel !== 'voice' && session.authorInfo?.address) {
      const customerPhone = session.authorInfo.address.replace(/^whatsapp:/i, '');

      // Send typing indicator for WhatsApp (fire-and-forget)
      if (channel === 'whatsapp' && session.authorInfo.address.startsWith('whatsapp:')) {
        sendWhatsAppTypingIndicator(session.authorInfo.address);
      }
      provider.addSystemContext(`Customer phone: ${customerPhone}`);

      // Register AI agent participant on first message (Maestro mode only)
      if (isMaestroMode) {
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
    }

    if (channel === 'voice') {
      // ── Voice: stream tokens to WebSocket ──
      const streamController = voiceChannel.startStreamTask(conversationId);

      try {
        for await (const token of provider.streamResponse(message, tools, streamController.signal)) {
          if (streamController.signal.aborted) break;
          if (token) {
            voiceChannel.sendResponse(conversationId, token, { last: false });
          }
        }
        // Send empty token with last: true to signal end of stream
        if (!streamController.signal.aborted) {
          voiceChannel.sendResponse(conversationId, '', { last: true });
        }
      } catch (err) {
        if (!streamController.signal.aborted) {
          console.error(`[Voice] Stream error for ${conversationId}:`, err);
        }
      } finally {
        voiceChannel.completeStreamTask(conversationId);
      }

      await handlePostCompletion(provider, conversationId, channel);

    } else if (isMaestroMode) {
      // ── Messaging (SMS / WhatsApp) via Maestro ──
      const messagingChannel = channel === 'whatsapp' ? whatsappChannel! : smsChannel!;
      try {
        const response = await provider.generateResponse(message, tools);
        await messagingChannel.sendResponse(conversationId, response);
        await handlePostCompletion(provider, conversationId, channel);
      } catch (err) {
        console.error(`[${channel.toUpperCase()}] Error for ${conversationId}:`, err);
      }
    }
  });

  // ─── Voice Interrupt Handler ────────────────────────────────────────────────

  tac.onInterrupt(async ({ conversationId, reason, utteranceUntilInterrupt }) => {
    console.log(`[TAC] Interrupt on ${conversationId}: ${reason}`);

    // Tell the LLM what the customer actually heard before interrupting
    if (utteranceUntilInterrupt) {
      const provider = providers.get(conversationId as string);
      if (provider) {
        provider.addSystemContext(
          `[Interruption] The customer interrupted you. They only heard: "${utteranceUntilInterrupt}". They did NOT hear the rest of your response. Adjust your next reply accordingly.`
        );
      }
    }
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
      const customerPhone = session.authorInfo?.address;
      await handleHandoff(conversationId as string, reason, customerPhone);
    }
  });

  // ─── Voice Setup Callback ──────────────────────────────────────────────────

  voiceChannel.on('setup', ({ conversationId, from, customParameters }: {
    conversationId: ConversationId;
    profileId: string | undefined;
    callSid: string;
    from: string;
    to: string;
    customParameters: Record<string, string> | undefined;
  }) => {
    getProvider(conversationId).then((provider) => {
      const userContext: Record<string, unknown> = { customerPhone: from };
      if (customParameters) {
        userContext.customParameters = customParameters;
      }
      provider.addSystemContext(`Call Context: ${JSON.stringify(userContext, null, 2)}`);
    });
  });

  // ─── Start Server ──────────────────────────────────────────────────────────

  const server = new TACServer(tac, {
    voice: {
      host: '0.0.0.0',
      port: config.server.port,
    },
    conversationRelayConfig: {
      welcomeGreeting,
      dtmfDetection: true,
      interruptible: 'any',
      ttsProvider: defaultLanguage.ttsProvider,
      ttsLanguage: defaultLanguage.ttsLanguage,
      voice: defaultLanguage.voice,
      transcriptionProvider: defaultLanguage.transcriptionProvider,
      transcriptionLanguage: defaultLanguage.transcriptionLanguage,
      speechModel: defaultLanguage.speechModel,
      ...extraRelayConfig,
    },
    development: true,
  });

  if (!isMaestroMode) {
    registerConversationsV1Routes(server.app, {
      tac,
      tools,
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
}
