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
  MemoryPromptBuilder,
  createStudioHandoffTool,
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

export async function createApp(options: AppOptions): Promise<void> {
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

  const tac = await TAC.create({ config: TACConfig.fromEnv() });
  // memoryMode defaults to 'never' in TAC 1.0.0+. Opt in to per-message memory
  // retrieval so onMessageReady callbacks receive a populated `memory` argument.
  const voiceChannel = new VoiceChannel(tac, { memoryMode: 'always' });
  tac.registerChannel(voiceChannel);

  // Build final tools list — static + dynamic (e.g. knowledge tools that need tac).
  // In Maestro mode, the OOTB createStudioHandoffTool replaces the legacy
  // humanAgentHandoffTool — strip the legacy one so they don't compete.
  const tools: TACTool[] = buildDynamicTools
    ? [...staticTools, ...buildDynamicTools(tac)]
    : staticTools;
  const baseTools: TACTool[] = isMaestroMode
    ? tools.filter(t => t.name !== 'human_agent_handoff')
    : tools;

  let smsChannel: SMSChannel | undefined;
  let whatsappChannel: WhatsAppChannel | undefined;

  if (isMaestroMode) {
    smsChannel = new SMSChannel(tac, { memoryMode: 'always' });
    whatsappChannel = new WhatsAppChannel(tac, { memoryMode: 'always' });
    tac.registerChannel(smsChannel);
    tac.registerChannel(whatsappChannel);
  }

  // ─── LLM Provider per conversation ──────────────────────────────────────────

  const providers = new Map<string, LLMProvider>();
  // Last channel we told the LLM about, per conversation. Re-injected on
  // change so the agent adapts style when the customer moves between voice
  // and messaging mid-conversation (GROUP_BY_PROFILE keeps the same convId).
  const lastChannelByConversation = new Map<string, string>();

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
          Buffer.from(`${tacConfig.accountSid}:${tacConfig.authToken}`).toString('base64');

        const listUrl = new URL(
          `https://api.twilio.com/2010-04-01/Accounts/${tacConfig.accountSid}/Messages.json`
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
    memory: TACMemoryResponse | undefined,
    session: ConversationSession
  ): void {
    const contextString = MemoryPromptBuilder.build(memory, session);
    console.log('[MemoryContext] profileId=%s | traits=%s | observations=%d | summaries=%d | communications=%d',
      session.profileId ?? 'none',
      session.profile?.traits ? JSON.stringify(session.profile.traits) : 'none',
      memory?.observations.length ?? 0,
      memory?.summaries.length ?? 0,
      memory?.communications.length ?? 0
    );
    console.log('[MemoryContext] System context being injected:\n%s', contextString || '(empty)');

    if (contextString) {
      provider.addSystemContext(contextString);
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
        // In Maestro mode, the LLM calls the OOTB liveAgentHandoff tool directly
        // (createStudioHandoffTool) — no action dispatch needed here. Conversations
        // v1 mode still uses the legacy handleHandoff path until v1 is retired.
        if (!isMaestroMode) {
          console.log(`[Action] Triggering v1 handoff: ${action.reason}`);
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
    console.log('[TAC] Inbound session: profileId=%s | hasProfile=%s | memoryProvided=%s',
      session.profileId ?? 'none',
      session.profile ? 'yes' : 'no',
      memory ? 'yes' : 'no'
    );

    const provider = await getProvider(conversationId);

    // Inject the current channel so the LLM can adapt its style. Only
    // re-inject when the channel changes (first turn, or cross-channel
    // transition like WhatsApp → voice on the same conversation).
    const convKey = conversationId as string;
    if (lastChannelByConversation.get(convKey) !== channel) {
      lastChannelByConversation.set(convKey, channel);
      provider.addSystemContext(`Current communication channel: ${channel}`);
    }

    // Fetch profile traits if we have a profileId but no profile yet
    if (session.profileId && !session.profile) {
      try {
        const profileResponse = await tac.fetchProfile(session.profileId);
        if (profileResponse) {
          session.profile = { profileId: profileResponse.id, traits: profileResponse.traits };
          console.log('[TAC] Profile fetched: %s', JSON.stringify(profileResponse.traits));
        }
      } catch (err) {
        // Swallowed — fall through to address-based lookup below.
      }
    }

    // Fallback: if we still don't have a profile, look it up by phone (E.164)
    // derived from session.authorInfo.address. Recovers from two common gaps:
    //   1. Stale participant.profileId pointing at a profile in a previous
    //      memory store (cross-store migration leftovers).
    //   2. WhatsApp Business Calling: TAC uses idType=phone for VOICE channel,
    //      but the call's address is `whatsapp:+...`. Stripping the prefix
    //      lets the phone-identity lookup succeed.
    if (!session.profile && session.authorInfo?.address) {
      const memoryClient = tac.getMemoryClient();
      if (memoryClient) {
        const phoneE164 = session.authorInfo.address.replace(/^whatsapp:/i, '');
        if (phoneE164.startsWith('+')) {
          try {
            const lookup = await memoryClient.lookupProfile('phone', phoneE164);
            const resolvedId = lookup.profiles?.[0];
            if (resolvedId) {
              const profileResponse = await tac.fetchProfile(resolvedId);
              if (profileResponse) {
                session.profileId = resolvedId;
                session.profile = { profileId: profileResponse.id, traits: profileResponse.traits };
                console.log('[TAC] Profile recovered via address lookup: %s', JSON.stringify(profileResponse.traits));
              }
            } else {
              console.warn('[TAC] No profile found for %s', phoneE164);
            }
          } catch (err) {
            console.warn(`[TAC] Address-based profile lookup failed for ${phoneE164}:`, err);
          }
        }
      }
    }

    // Inject context (profile traits + memory if any). injectMemoryContext
    // handles undefined memory gracefully — profile traits alone still go through.
    injectMemoryContext(provider, memory, session);

    // Inject customer phone for messaging channels
    if (channel !== 'voice' && session.authorInfo?.address) {
      const customerPhone = session.authorInfo.address.replace(/^whatsapp:/i, '');

      // Send typing indicator for WhatsApp (fire-and-forget)
      if (channel === 'whatsapp' && session.authorInfo.address.startsWith('whatsapp:')) {
        sendWhatsAppTypingIndicator(session.authorInfo.address);
      }
      provider.addSystemContext(`Customer phone: ${customerPhone}`);
      // TAC 1.0.0 auto-reconciles the AI agent participant on inbound webhooks
      // via MessagingChannel.reconcileParticipants — no manual addParticipant needed.
    }

    // Per-session tools: handoff tool needs session in closure. Built fresh per
    // message — cheap, and `session` may be mutated mid-conversation as profile
    // resolves. Voice path also gets the tool: handoff sets pendingHandoffData
    // and the WebSocket gracefully closes, redirecting the call to Studio.
    // Only added in Maestro mode (the tool throws if Conversation Orchestrator
    // isn't initialized).
    const callTools: TACTool[] = isMaestroMode
      ? [...baseTools, createStudioHandoffTool(tac, session, { name: 'liveAgentHandoff' })]
      : baseTools;

    if (channel === 'voice') {
      const streamController = voiceChannel.startStreamTask(conversationId);

      try {
        await voiceChannel.sendStreamingResponse(
          conversationId,
          provider.streamResponse(message, callTools, streamController.controller.signal),
          { signal: streamController.controller.signal }
        );
      } catch (err) {
        if (!streamController.controller.signal.aborted) {
          console.error(`[Voice] Stream error for ${conversationId}:`, err);
        }
      } finally {
        voiceChannel.completeStreamTask(conversationId);
      }

      // Workaround for TAC 1.0.0: sendStreamingResponse doesn't dispatch
      // session.pendingHandoffData (only sendResponse does). If the LLM called
      // the handoff tool mid-stream, force the dispatch by issuing an empty
      // sendResponse — which sees pendingHandoffData and emits the WS `end`
      // message that triggers ConversationRelay's <Connect action> redirect.
      if (session.pendingHandoffData) {
        console.log('[Voice] Dispatching pending handoff data to ConversationRelay');
        await voiceChannel.sendResponse(conversationId, '');
      }

      await handlePostCompletion(provider, conversationId, channel);

    } else if (isMaestroMode) {
      // ── Messaging (SMS / WhatsApp) via Maestro ──
      const messagingChannel = channel === 'whatsapp' ? whatsappChannel! : smsChannel!;
      try {
        const response = await provider.generateResponse(message, callTools);
        await messagingChannel.sendResponse(conversationId, response);
        await handlePostCompletion(provider, conversationId, channel);
      } catch (err) {
        console.error(`[${channel.toUpperCase()}] Error for ${conversationId}:`, err);
      }
    }
  });

  // ─── Voice Interrupt Handler ────────────────────────────────────────────────

  tac.onInterrupt(async ({ conversationId, utteranceUntilInterrupt }) => {
    console.log(`[TAC] Interrupt on ${conversationId}`);

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
    lastChannelByConversation.delete(key);
    console.log(`[TAC] Conversation ended: ${session.conversationId}`);
  });

  // ─── Handoff ────────────────────────────────────────────────────────────────
  // tac.onHandoff was removed in twilio-agent-connect@1.0.0. Handoff is now
  // tool-driven via createStudioHandoffTool(tac, session). For Maestro mode,
  // add it to the LLM tools list. For Conversations v1, handleHandoff is
  // invoked directly from handlePostCompletion above.

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
    host: '0.0.0.0',
    port: config.server.port,
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
  });

  if (!isMaestroMode) {
    registerConversationsV1Routes(server.fastify, {
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
