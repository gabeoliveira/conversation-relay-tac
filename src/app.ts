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

import { createHash } from 'crypto';
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
import { bufferAtWordBoundaries } from './providers/streamBuffer.js';
import { registerInboundMediaWebhook } from './messaging/inboundMediaWebhook.js';
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

  /**
   * Optional per-message factory for tools that need access to the live
   * `ConversationSession`. Called inside processMessageTurn on every turn,
   * just before the tool list is handed to the LLM provider.
   *
   * Returned tools are appended to the per-call tool list. If a returned
   * tool's `name` matches a tool already in the list (including the OOTB
   * `liveAgentHandoff` that the template auto-wires in Maestro mode), the
   * session tool *replaces* it. Use this to ship a domain-specific handoff
   * tool that bakes session-derived attributes (e.g., current order number)
   * into the Studio Flow payload.
   */
  buildSessionTools?: (tac: TAC, session: ConversationSession) => TACTool[];

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
    buildSessionTools,
  } = options;

  // ─── Initialize TAC ────────────────────────────────────────────────────────

  const isMaestroMode = config.messagingMode === 'maestro';

  const tac = await TAC.create({ config: TACConfig.fromEnv() });

  // Memory recall mode (set per-channel below). TAC ships only 'always' | 'never';
  // we extend with 'first-prompt' (recall once per conversation, app-level cache).
  // For 'first-prompt' we tell TAC to NEVER auto-recall, then handle retrieval
  // ourselves on the first message of each conversation.
  const tacMemoryMode: 'always' | 'never' =
    config.memoryRecallMode === 'always' ? 'always' : 'never';
  console.log(`[Memory] Recall mode: ${config.memoryRecallMode} (TAC channel memoryMode=${tacMemoryMode})`);

  const voiceChannel = new VoiceChannel(tac, { memoryMode: tacMemoryMode });
  tac.registerChannel(voiceChannel);

  // Pre-setup memory recall (voice + 'first-prompt' mode only).
  // ConversationRelay's `setup` message fires the moment the call connects,
  // before the welcome greeting plays — we use that window to start the
  // memory recall in parallel. By the time the customer finishes speaking
  // their first utterance, the recall is usually done and the first turn
  // latency drops by the recall round-trip time.
  if (config.memoryRecallMode === 'first-prompt') {
    const memoryClient = tac.getMemoryClient();
    voiceChannel.on('setup', ({ from, callSid }: { from: string; callSid: string }) => {
      if (!memoryClient || !from) return;
      const phone = from.replace(/^whatsapp:/i, '');
      const startedAt = Date.now();
      const promise: Promise<TACMemoryResponse | null> = (async () => {
        try {
          const lookup = await memoryClient.lookupProfile('phone', phone);
          const profileId = lookup.profiles[0];
          if (!profileId) {
            console.log(`[Memory] Pre-fetch (voice setup, callSid=${callSid}, ${phone}): no profile (${Date.now() - startedAt}ms)`);
            return new TACMemoryResponse([]);
          }
          const data = await memoryClient.retrieveMemories(profileId);
          console.log(`[Memory] Pre-fetch (voice setup, callSid=${callSid}, profile=${profileId}) done in ${Date.now() - startedAt}ms`);
          return new TACMemoryResponse(data);
        } catch (err) {
          console.warn(`[Memory] Pre-fetch failed for callSid=${callSid}:`, err);
          return null;
        }
      })();
      prefetchByPhone.set(phone, promise);
    });
  }

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
    smsChannel = new SMSChannel(tac, { memoryMode: tacMemoryMode });
    whatsappChannel = new WhatsAppChannel(tac, { memoryMode: tacMemoryMode });
    tac.registerChannel(smsChannel);
    tac.registerChannel(whatsappChannel);
  }

  // ─── LLM Provider per conversation ──────────────────────────────────────────

  const providers = new Map<string, LLMProvider>();
  // Last channel we told the LLM about, per conversation. Re-injected on
  // change so the agent adapts style when the customer moves between voice
  // and messaging mid-conversation (GROUP_BY_PROFILE keeps the same convId).
  const lastChannelByConversation = new Map<string, string>();
  // Cache for memoryRecallMode='first-prompt': memory retrieved once on
  // conversation's first message and reused for subsequent turns.
  const memoryByConversation = new Map<string, TACMemoryResponse>();
  // Voice-only optimization: under 'first-prompt' mode, kick off recall the
  // moment ConversationRelay sends the `setup` message (call connected,
  // welcome greeting starts playing). By the time the customer speaks, the
  // recall is usually done — first response is faster by the duration of the
  // recall round-trip (typically 400–1000 ms). Keyed by caller phone since
  // the conversationId/session doesn't exist yet at setup time (CO creates
  // them on the first transcription event).
  const prefetchByPhone = new Map<string, Promise<TACMemoryResponse | null>>();
  // Per-conversation message-debouncer state. Buffers rapid-fire messages
  // ("oi" + "preciso de ajuda" 300ms apart → one combined LLM turn) and
  // serializes turns when new messages arrive while a turn is in flight.
  // Voice is never debounced.
  type MessageReadyParams = Parameters<Parameters<typeof tac.onMessageReady>[0]>[0];
  type DebounceState = {
    buffer: string[];
    timer: ReturnType<typeof setTimeout> | null;
    inFlight: boolean;
    lastParams: MessageReadyParams;
  };
  const debounceStates = new Map<string, DebounceState>();

  // Diagnostic helper for VOICE_STREAM_DEBUG. Wraps any AsyncIterable<string>
  // and prints each chunk with a label so we can compare what the provider
  // emitted vs. what we hand to ConversationRelay. Used at the call site to
  // distinguish pipeline-side duplication from TTS-side artifacts.
  async function* tapStream(
    source: AsyncIterable<string>,
    label: string,
    convId: ConversationId,
  ): AsyncIterable<string> {
    let n = 0;
    for await (const chunk of source) {
      n++;
      console.log(`[VoiceStream:${label}] ${convId} #${n} (${chunk.length}c): ${JSON.stringify(chunk)}`);
      yield chunk;
    }
    console.log(`[VoiceStream:${label}] ${convId} END (${n} chunks)`);
  }

  async function getProvider(conversationId: ConversationId): Promise<LLMProvider> {
    const key = conversationId as string;
    let provider = providers.get(key);
    if (!provider) {
      // Pass conversationId so session-scoped providers (e.g. Langflow) can
      // use it as their session identifier. Other providers ignore it.
      provider = await createLLMProvider(key);
      // Langflow's Agent component owns the system prompt inside the flow,
      // so injecting TAC's systemPrompt would compete with it (it lands in
      // the user message as [Context], not as a system role). Dynamic
      // per-turn context like the date still goes through.
      if (config.llm.provider !== 'langflow') {
        provider.addSystemContext(systemPrompt);
      }
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

        // Use API Key/Secret rather than Auth Token — API Keys are the
        // recommended credential for REST calls and match what the rest of
        // TAC uses, so we don't depend on TWILIO_AUTH_TOKEN being set/fresh.
        const credUser = tacConfig.apiKey;
        const credPass = tacConfig.apiSecret;
        const acctSid = tacConfig.accountSid;
        const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
        console.log(
          `[Typing] auth user=${credUser?.slice(0, 4) ?? 'MISSING'}...${credUser?.slice(-4) ?? ''} (len=${credUser?.length ?? 0} sha=${credUser ? sha(credUser) : 'n/a'}) pass_len=${credPass?.length ?? 0} pass_sha=${credPass ? sha(credPass) : 'n/a'} acct=${acctSid?.slice(0, 6) ?? 'MISSING'}...`,
        );
        const authHeader = 'Basic ' + Buffer.from(`${credUser}:${credPass}`).toString('base64');

        const listUrl = new URL(
          `https://api.twilio.com/2010-04-01/Accounts/${tacConfig.accountSid}/Messages.json`
        );
        listUrl.searchParams.set('From', customerPhone);
        listUrl.searchParams.set('PageSize', '1');

        const listResponse = await fetch(listUrl.toString(), {
          headers: { Authorization: authHeader },
        });
        if (!listResponse.ok) {
          console.warn(`[Typing] list messages failed (${listResponse.status}): ${await listResponse.text()}`);
          return;
        }

        const listData = (await listResponse.json()) as { messages?: { sid: string }[] };
        if (!listData.messages || listData.messages.length === 0) {
          console.warn(`[Typing] no recent inbound message found for ${customerPhone}`);
          return;
        }

        const typingResponse = await fetch('https://messaging.twilio.com/v2/Indicators/Typing.json', {
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
        if (!typingResponse.ok) {
          console.warn(`[Typing] indicator POST failed (${typingResponse.status}): ${await typingResponse.text()}`);
        } else {
          console.log(`[Typing] indicator sent for ${customerPhone} (msg ${listData.messages[0]!.sid})`);
        }
      } catch (err) {
        console.error('[Typing] unexpected error:', err);
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

  // Thin entry: typing indicator first (visible to customer fast), then voice
  // bypasses debouncing while messaging buffers and serializes turns.
  tac.onMessageReady(async (params) => {
    const { conversationId, channel, session } = params;

    // Fire typing indicator immediately on every messaging arrival. Re-firing
    // refreshes WhatsApp's ~25s sticky window, so customers see "typing..." the
    // entire way through a debounced burst + LLM call.
    if (channel === 'whatsapp' && session.authorInfo?.address?.startsWith('whatsapp:')) {
      sendWhatsAppTypingIndicator(session.authorInfo.address);
    }

    // Voice path: no debounce. ConversationRelay's WebSocket handles natural
    // turn-taking and any added latency would be audible.
    if (channel === 'voice') {
      return processMessageTurn(params.message, params);
    }

    // Conversations v1 path doesn't go through onMessageReady's LLM branch
    // either (it's handled by registerConversationsV1Routes); short-circuit.
    if (!isMaestroMode) {
      return processMessageTurn(params.message, params);
    }

    // Maestro messaging: buffer + debounce. If a turn is already in flight,
    // append to the buffer and let fireDebounce reschedule once it completes.
    const convKey = conversationId as string;
    let state = debounceStates.get(convKey);
    if (!state) {
      state = { buffer: [], timer: null, inFlight: false, lastParams: params };
      debounceStates.set(convKey, state);
    }
    state.buffer.push(params.message);
    state.lastParams = params;
    if (!state.inFlight) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => fireDebounce(convKey), config.messageDebounceMs);
    }
  });

  async function fireDebounce(convKey: string): Promise<void> {
    const state = debounceStates.get(convKey);
    if (!state || state.inFlight || state.buffer.length === 0) return;
    const combined = state.buffer.join('\n');
    state.buffer = [];
    state.timer = null;
    state.inFlight = true;
    try {
      await processMessageTurn(combined, state.lastParams);
    } catch (err) {
      console.error(`[Debounce] processMessageTurn failed for ${convKey}:`, err);
    } finally {
      state.inFlight = false;
      // If new messages arrived during processing, reschedule.
      if (state.buffer.length > 0) {
        state.timer = setTimeout(() => fireDebounce(convKey), config.messageDebounceMs);
      }
    }
  }

  async function processMessageTurn(message: string, params: MessageReadyParams): Promise<void> {
    const { conversationId, memory, session, channel } = params;
    console.log(`[TAC] Message from ${channel}: "${message.substring(0, 80)}..."`);
    console.log('[TAC] Inbound session: profileId=%s | hasProfile=%s | memoryProvided=%s',
      session.profileId ?? 'none',
      session.profile ? 'yes' : 'no',
      memory ? 'yes' : 'no'
    );

    const provider = await getProvider(conversationId);
    const convKey = conversationId as string;

    // first-prompt mode: TAC won't auto-recall (we set memoryMode='never' for
    // it), so retrieve once here and cache for the rest of the conversation.
    // For voice, a pre-fetch was already kicked off on the `setup` event —
    // we just await it here (usually already resolved by the time the
    // customer's first utterance lands).
    let effectiveMemory = memory;
    if (config.memoryRecallMode === 'first-prompt') {
      let cached = memoryByConversation.get(convKey);
      if (!cached) {
        const phone = session.authorInfo?.address?.replace(/^whatsapp:/i, '');
        const prefetched = channel === 'voice' && phone ? prefetchByPhone.get(phone) : undefined;
        try {
          if (prefetched) {
            const awaitStart = Date.now();
            const result = await prefetched;
            prefetchByPhone.delete(phone!);
            if (result) {
              cached = result;
              memoryByConversation.set(convKey, cached);
              console.log(`[Memory] Recalled (first-prompt via voice pre-fetch) — await took ${Date.now() - awaitStart}ms (0ms means already resolved)`);
            }
          }
          if (!cached) {
            cached = await tac.retrieveMemory(session, message);
            memoryByConversation.set(convKey, cached);
            console.log('[Memory] Recalled (first-prompt) and cached for conversation');
          }
        } catch (err) {
          console.warn('[Memory] retrieveMemory failed in first-prompt mode:', err);
        }
      } else {
        console.log('[Memory] Reusing cached recall (first-prompt)');
      }
      effectiveMemory = cached;
    }

    // Inject the current channel so the LLM can adapt its style. Only
    // re-inject when the channel changes (first turn, or cross-channel
    // transition like WhatsApp → voice on the same conversation).
    //
    // Providers' addSystemContext is append-only — the prior channel line
    // stays in the prompt. On a switch we explicitly announce supersede so
    // the model treats the new line as authoritative and ignores the older
    // one. Without this, a WhatsApp→voice handoff (e.g., tapping a CTA
    // button) leaves the LLM anchored on the chat framing of the previous
    // turn ("é só tocar no botão...") even after the voice call lands.
    if (lastChannelByConversation.get(convKey) !== channel) {
      const prev = lastChannelByConversation.get(convKey);
      lastChannelByConversation.set(convKey, channel);
      const line = prev
        ? `Communication channel switched from "${prev}" to "${channel}". IGNORE any earlier "Current communication channel:" line — only the most recent one is authoritative. Current channel: ${channel}.`
        : `Current communication channel: ${channel}`;
      provider.addSystemContext(line);
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
    injectMemoryContext(provider, effectiveMemory, session);

    // Inject customer phone for messaging channels.
    // Typing indicator already fired in the onMessageReady entry — no re-fire here.
    // TAC 1.0.0 auto-reconciles the AI agent participant on inbound webhooks
    // via MessagingChannel.reconcileParticipants — no manual addParticipant needed.
    if (channel !== 'voice' && session.authorInfo?.address) {
      const customerPhone = session.authorInfo.address.replace(/^whatsapp:/i, '');
      provider.addSystemContext(`Customer phone: ${customerPhone}`);
    }

    // Per-session tools: handoff tool needs session in closure. Built fresh per
    // message — cheap, and `session` may be mutated mid-conversation as profile
    // resolves. Voice path also gets the tool: handoff sets pendingHandoffData
    // and the WebSocket gracefully closes, redirecting the call to Studio.
    // Only added in Maestro mode (the tool throws if Conversation Orchestrator
    // isn't initialized).
    let callTools: TACTool[] = isMaestroMode
      ? [...baseTools, createStudioHandoffTool(tac, session, { name: 'liveAgentHandoff' })]
      : baseTools;

    // Session-aware tool overrides: a tool returned by buildSessionTools with
    // the same name as one already in the list replaces it (so demos can swap
    // out the OOTB liveAgentHandoff for a domain-specific variant that carries
    // per-conversation state into Studio Flow attributes).
    if (buildSessionTools) {
      const overrides = buildSessionTools(tac, session);
      if (overrides.length > 0) {
        const overrideNames = new Set(overrides.map((t) => t.name));
        callTools = [...callTools.filter((t) => !overrideNames.has(t.name)), ...overrides];
      }
    }

    if (channel === 'voice') {
      const streamController = voiceChannel.startStreamTask(conversationId);

      try {
        // Buffer the LLM stream to word boundaries before handing it to
        // ConversationRelay. Avoids TTS stuttering on sub-word delta chunks.
        // Provider-agnostic — works for any AsyncIterable<string> source.
        //
        // VOICE_STREAM_DEBUG=true wraps the raw provider stream and the
        // post-buffer stream with tap loggers. Use to diagnose TTS hiccups
        // like duplicated tokens — if a word shows up twice in `raw` but
        // once in `tts`, the source emitted it twice; if it shows up once
        // in both but you still hear it twice, the duplication is in
        // ConversationRelay's TTS, not us. Off by default.
        const debug = process.env.VOICE_STREAM_DEBUG === 'true';
        const rawStream = provider.streamResponse(message, callTools, streamController.controller.signal);
        const tappedRaw = debug ? tapStream(rawStream, 'raw', conversationId) : rawStream;
        const bufferedStream = bufferAtWordBoundaries(tappedRaw);
        const tappedBuffered = debug ? tapStream(bufferedStream, 'tts', conversationId) : bufferedStream;
        await voiceChannel.sendStreamingResponse(
          conversationId,
          tappedBuffered,
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
        // Axios errors hide the response body in `data: [Object]` by default,
        // which obscures the actual Twilio error code/message (e.g.
        // "Participant ... does not have an address on channel WHATSAPP").
        // Surface it so failures are diagnosable from the log alone.
        const responseData = (err as { cause?: { response?: { data?: unknown } } })?.cause?.response?.data;
        if (responseData) {
          console.error(
            `[${channel.toUpperCase()}] Error for ${conversationId} — Twilio response:`,
            JSON.stringify(responseData),
          );
        }
        console.error(`[${channel.toUpperCase()}] Error for ${conversationId}:`, err);
      }
    }
  } // end processMessageTurn

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
    memoryByConversation.delete(key);
    const debounce = debounceStates.get(key);
    if (debounce?.timer) clearTimeout(debounce.timer);
    debounceStates.delete(key);
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

  // Healthcheck. Liveness only — returns 200 OK if the process is alive and
  // serving HTTP. Deliberately does NOT probe downstream dependencies
  // (Twilio, OpenAI, Memora). If those go down we want the container to stay
  // up and return useful errors, not get restart-looped by the orchestrator.
  // Adopters who need a separate readiness probe (k8s, etc.) can add a
  // `/ready` route that does check dependencies.
  server.fastify.get('/health', async (_req, reply) => {
    return reply.status(200).send({
      status: 'ok',
      uptime: process.uptime(),
    });
  });

  // Diagnostic hook: log every inbound /webhook POST with its idempotency
  // token and a hash of the body. Use this to spot Twilio webhook retries
  // delivered with no/different idempotency tokens (TAC's dedup misses
  // those, leading to double LLM invocation).
  server.fastify.addHook('preHandler', async (req) => {
    if (req.method !== 'POST' || !req.url.startsWith('/webhook')) return;
    const idem = req.headers['i-twilio-idempotency-token'] ?? '(absent)';
    const sig = req.headers['x-twilio-signature'] ? 'present' : 'absent';
    const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    const bodyHash = createHash('sha256').update(bodyStr).digest('hex').slice(0, 12);
    const eventType = (req.body as { type?: string } | undefined)?.type ?? '?';
    console.log(
      `[Webhook] reqId=${req.id} url=${req.url.split('?')[0]} type=${eventType} idem=${idem} sig=${sig} bodyHash=${bodyHash}`
    );
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

  // Inbound media (Programmable Messaging webhook): registers the
  // /inbound-message route only when INBOUND_MEDIA_ENABLED=true and
  // OPENAI_API_KEY is set. Demos that don't need audio transcription
  // pay nothing for this code path.
  registerInboundMediaWebhook(server, tac);

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
