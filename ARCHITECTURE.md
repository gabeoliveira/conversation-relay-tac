# Architecture Blueprint

**Conversation Relay — Twilio Agent Connect (TAC)**

This document provides a technical deep-dive into the architecture, component interactions, data flows, and design trade-offs.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Component Breakdown](#component-breakdown)
3. [Data Flows](#data-flows)
4. [Messaging Mode Details](#messaging-mode-details)
5. [Memory and Identity](#memory-and-identity)
6. [Handoff Flow](#handoff-flow--maestro-mode-studio-flow)
7. [What the template layers on top of TAC 1.0.0](#what-the-template-layers-on-top-of-tac-100)
8. [Known Limitations and Trade-offs](#known-limitations-and-trade-offs)

---

## System Overview

The application is structured in three layers:

1. **TAC Package** (`twilio-agent-connect@^1.0.0`) — single npm package: channel management, Maestro/Memora/Knowledge API clients, Fastify server, webhook handling, OOTB tools (knowledge search, Studio handoff), memory prompt builder
2. **Application Layer** (`src/app.ts` + supporting modules) — LLM orchestration, tool execution, memory + channel + profile injection, mode-based routing, humanization patterns (word-boundary streaming, message debouncing, typing indicators), inbound media side-channel
3. **Channel Handlers** — Maestro channels (via TAC's `VoiceChannel` / `SMSChannel` / `WhatsAppChannel`) or Conversations v1 (custom handler at `src/channels/conversations-v1.ts`)

TAC handles the infrastructure concerns (WebSocket protocol, webhook validation, session lifecycle, dedup, API clients), while the application layer owns the business logic (what the AI says, which tools it can call, how memory is used) and the *texture* of the conversation (pacing, prosody, channel adaptation) — see [HUMANIZING_AGENTS.md](HUMANIZING_AGENTS.md).

---

## Component Breakdown

### TAC (`twilio-agent-connect`)

All of TAC's surface lives in a single npm package. Key exports used by the template:

| Component | Role |
|---|---|
| `TAC` (static `TAC.create({ config })`) | Central orchestrator — config, channel registry, memory retrieval, profile fetch |
| `TACConfig.fromEnv()` | Environment-based configuration with Zod validation; auto-fetches `memoryStoreId` from the Conversation Configuration |
| `VoiceChannel(tac, { memoryMode })` | ConversationRelay WebSocket protocol, TwiML generation, stream tasks, `sendStreamingResponse(asyncIterable, { signal })` |
| `SMSChannel(tac, { memoryMode })` | Maestro v2 SMS webhook processing and Send API |
| `WhatsAppChannel(tac, { memoryMode })` | Maestro v2 WhatsApp webhook processing, Send API, typing indicators |
| `MemoryClient` (via `tac.getMemoryClient()`) | Memora API — profile lookup (`lookupProfile('phone', e164)`), memory retrieval, observation/summary management |
| `ConversationClient` (via `tac.getConversationClient()`) | Maestro Conversations API — create conversations, add participants, send communications, list participants |
| `KnowledgeClient` (via `tac.getKnowledgeClient()`) | Knowledge API — semantic search across uploaded knowledge bases |
| `createKnowledgeTools(knowledgeClient).forKnowledgeBase(...)` | OOTB factory for KB search tools — used by `src/tools/knowledgeTools.ts` |
| `createStudioHandoffTool(tac, session, { name })` | OOTB Studio-Flow-based handoff tool — wired automatically per-message in Maestro mode |
| `MemoryPromptBuilder.build(memory, session)` | OOTB formatter that turns memory observations / summaries / communications + profile traits into the system-context string injected before each LLM call |
| `TACServer(tac, { host, port })` | Fastify server with built-in routes (`/webhook`, `/twiml`, `/ws`, `/conversation-relay-callback`) and built-in dedup of Maestro `data.id` |
| `server.fastify` | Public Fastify instance — used by the template to register `/conversations-webhook` (v1 mode), `/inbound-message` (media), and a diagnostic `preHandler` hook |

### Application Layer

| Component | Role |
|---|---|
| `src/index.ts` | Thin entry point — calls `createApp({ ... })` from `app.ts` |
| `src/app.ts` | Boots TAC, registers channels, wires the message handler (with debounce + in-flight serialization), starts the server, wires the inbound-media webhook |
| `src/config.ts` | App-specific config (messaging mode, memory recall mode, debounce window, inbound-media flags, LLM provider) |
| `src/providers/*.ts` | Three OpenAI LLM providers (`openai-chat-completions`, `openai-responses`, `openai-agents`) implementing `LLMProvider` |
| `src/providers/streamBuffer.ts` | `bufferAtWordBoundaries(asyncIterable)` — provider-agnostic word-boundary buffer applied to voice streams to remove TTS stuttering and digraph mispronunciation |
| `src/tools/index.ts` | Tool definitions using `defineTool()`; `executeTool(name, args, tools)` runs the tool by name for the Chat Completions / Responses providers |
| `src/tools/knowledgeTools.ts` | Builds KB search tools dynamically from `KB_*_ID` env vars using TAC's `createKnowledgeTools` |
| `src/channels/conversations-v1.ts` | Conversations v1 webhook handler, typing indicators, direct Flex Interactions API handoff (only used when `MESSAGING_MODE=conversations-v1`) |
| `src/messaging/` | Inbound media side-channel: `inboundMediaWebhook` (Programmable Messaging webhook), `transcribeAudio` (Whisper), `describeImage` (OpenAI vision), `insertCommunication` (re-injects the result as a customer-attributed `POST /v2/Conversations/{id}/Communications`) |
| `src/prompts/*` | `systemPrompt.md`, `systemPrompt.ts` (loader), `additionalContext.ts` (current date / time, etc.) |

---

## Data Flows

### Voice Call (Both Modes)

```
 1. Incoming call -> POST /twiml
 2. TACServer generates TwiML with ConversationRelay <Connect>
 3. Twilio opens WebSocket to /ws
 4. VoiceChannel handles 'setup' message -> creates conversation in Maestro
 5. User speaks -> VoiceChannel receives 'prompt' message
 6. VoiceChannel retrieves memory (memoryMode='always') OR app retrieves once
    and caches (memoryMode='first-prompt') -> fires onMessageReady callback
 7. processMessageTurn:
      - gets/creates LLMProvider
      - injects channel context ("Current communication channel: voice") on
        channel change
      - injects memory + profile traits via MemoryPromptBuilder
      - adds createStudioHandoffTool to the per-message tool list
 8. voiceChannel.sendStreamingResponse(
        bufferAtWordBoundaries(provider.streamResponse(...))
    )
    Word-boundary wrapper buffers sub-word deltas to whitespace boundaries
    before forwarding to ConversationRelay — eliminates TTS stuttering and
    digraph mispronunciation (pt manhã, nh/lh/ch/rr; es ll/rr; fr gn/ch).
 9. ConversationRelay synthesizes speech in real-time
10. On interrupt: VoiceChannel cancels the stream task via AbortController;
    onInterrupt fires; the app injects "[Interruption] customer heard X" as
    system context so the next turn reasons correctly.
11. If the LLM called the Studio handoff tool mid-stream, session.pending-
    HandoffData is set; the app issues an empty sendResponse('') to dispatch
    the WS `end` message that triggers ConversationRelay's <Connect action>
    redirect to TWILIO_STUDIO_HANDOFF_FLOW_SID.
```

### WhatsApp Message — Maestro Mode

```
 1. Customer sends WhatsApp message
 2. Maestro captures via capture rules -> fires COMMUNICATION_CREATED webhook
 3. POST /webhook -> TACServer routes to WhatsAppChannel (by author.channel)
 4. WhatsAppChannel deduplicates by data.id, filters bot messages,
    retrieves memory (or skips if memoryMode='never' / 'first-prompt')
 5. Fires onMessageReady callback with message, memory, session, channel
 6. Application's onMessageReady entry:
      a. Fires WhatsApp typing indicator immediately (visible to customer
         within ~50ms; refreshes the sticky ~25s window on each arrival)
      b. Appends message to a per-conversation debounce buffer
         (MESSAGE_DEBOUNCE_MS, default 2000ms)
      c. If a turn is already in flight (inFlight=true), the message
         waits; fireDebounce reschedules once the in-flight turn finishes
 7. fireDebounce -> processMessageTurn(combined-buffer):
      - injects channel context on channel change
      - first-prompt mode: retrieves memory once if not cached
      - injects memory + profile via MemoryPromptBuilder
      - injects "Customer phone: <e164>"
      - builds per-message tool list (adds createStudioHandoffTool in
        Maestro mode, surfaced as `liveAgentHandoff`)
      - calls provider.generateResponse(combined, tools)
 8. whatsappChannel.sendResponse(conversationId, text)
 9. WhatsAppChannel sends via Maestro Send API (POST /v2/Communications)
10. While processing, new inbound messages append to the buffer and are
    picked up in the next debounce window (in-flight serialization)
```

### WhatsApp Message — Conversations v1 Mode

```
1. Customer sends WhatsApp message
2. Conversations v1 fires onMessageAdded webhook
3. POST /conversations-webhook -> conversations-v1.ts handler
4. Handler fetches participant details for phone number
5. Builds lightweight session -> calls tac.retrieveMemory() + tac.fetchProfile()
6. Injects memory + profile + phone -> calls generateResponse()
7. LLM generates complete response
8. Sends via client.conversations.v1.conversations(sid).messages.create()
9. Maestro passively captures both inbound and outbound messages
```

### Handoff Flow — Maestro Mode (Studio Flow)

The template wires `createStudioHandoffTool(tac, session, { name: 'liveAgentHandoff' })` automatically per-message in Maestro mode (see [src/app.ts:426](src/app.ts#L426)).

```
1. LLM calls `liveAgentHandoff` tool with a reason string
2. TAC's tool implementation sets session.pendingHandoffData and (for voice)
   stops the streaming response. No app-side action dispatch needed.
3. Voice path: VoiceChannel emits a WS `end` frame with handoff data;
   ConversationRelay redirects the call via <Connect action> to the
   Studio Flow at TWILIO_STUDIO_HANDOFF_FLOW_SID (incomingCall trigger).
   - Workaround: sendStreamingResponse does not dispatch pendingHandoffData
     in TAC 1.0.0, so the app issues an empty sendResponse('') after the
     stream completes to force the `end` frame.
4. Messaging path: TAC triggers the same Studio Flow via REST.
5. From this point, routing is owned by the Studio Flow — Flex (Send to
   Flex widget), an external IVR queue, a callback workflow, a different
   number, conditional logic by reason / business hours, etc.
```

This is the recommended path for the vast majority of deployments: no Flex requirement, and the Studio Flow gives non-engineers a place to change routing without code changes.

### Handoff Flow — Conversations v1 Mode (Direct Flex Interactions API)

```
1. LLM calls human_agent_handoff tool -> provider records
   lastAction = { type: 'handoff' }
2. handlePostCompletion() detects handoff action (Maestro path skips this
   block — handoff is tool-native there)
3. Calls handleHandoff(conversationSid, reason, phone, tac)
4. handleHandoff():
   a. Fetches profile from Memora -> extracts firstName + lastName for
      the Flex task name attribute
   b. Creates a Flex Interaction via client.flexApi.v1.interaction.create()
      - Links conversation via media_channel_sid
      - Routes to TaskRouter (workspace_sid + workflow_sid)
   c. Adds conversationSid to a handedOffConversations Set
   d. Removes bot webhooks matching the ngrok domain so the bot stops
      receiving messages on this conversation
   e. Updates conversation attributes (handedOff: true, interactionSid,
      timestamp)
5. Subsequent webhook events for this conversation are ignored
```

Use this path only when you need to hit Flex's Interactions API directly without going through Studio.

---

## Messaging Mode Details

### Webhook Routing in Maestro Mode

TACServer's `/webhook` endpoint handles all Maestro v2 events:

- **`COMMUNICATION_CREATED`**: Deduplicates by `data.id` (Maestro delivers at-least-once). Routes to `WhatsAppChannel` if `author.channel === 'WHATSAPP'` or `author.address.startsWith('whatsapp:')`, otherwise to `SMSChannel`.
- **Lifecycle events** (`CONVERSATION_CREATED`, `PARTICIPANT_ADDED`, `CONVERSATION_UPDATED`): No-op at the server level. Both channels auto-initialize sessions when they receive their first `COMMUNICATION_CREATED`.

The server responds 200 immediately before processing to prevent Maestro retry storms.

### AI Agent Participant Registration

TAC 1.0.0's `MessagingChannel.reconcileParticipants` auto-registers the AI agent participant on inbound webhooks, so Conversation Intelligence correctly distinguishes bot messages from customer messages. The template no longer calls `conversationClient.addParticipant({ type: 'AI_AGENT' })` manually — the legacy code was conflicting with the OOTB reconciliation and was removed in the 1.0.0 migration.

### Conversations v1 Webhook Format

Conversations v1 sends form-encoded POST requests with:
- `ConversationSid` — the v1 conversation identifier (`CH...`)
- `EventType` — `onMessageAdded`, `onParticipantAdded`, etc.
- `Body` — message text
- `Author` — sender identifier
- `ParticipantSid` — participant who sent the message

The handler filters out system messages and messages from the bot itself (matched against `TWILIO_CONVERSATIONS_SERVICE_SID`).

---

## Memory and Identity

### How Memory Works

Memory retrieval is phone-number based. The flow is owned by TAC:

1. Extract customer phone from `session.authorInfo.address` (Maestro) or the participant's `messagingBinding.address` (v1).
2. Strip the `whatsapp:` prefix before calling the Memora API.
3. `memoryClient.lookupProfile('phone', phoneE164)` → `profileId`. (The `memoryStoreId` is no longer a separate config — TAC 1.0.0 auto-fetches it from the Conversation Configuration.)
4. `tac.retrieveMemory(session, query)` → observations, summaries, communications.
5. `tac.fetchProfile(profileId)` → structured traits (nested under trait group name).

The template adds two pieces on top:

- **Address-based profile fallback.** When `fetchProfile` returns undefined (stale `profileId` pointing at an old store, or WhatsApp Business Calling where TAC uses `idType=phone` with a `whatsapp:`-prefixed address), the app retries with `memoryClient.lookupProfile('phone', strippedE164)` and refetches.
- **Recall modes.** `MEMORY_RECALL_MODE` controls the retrieval cadence:
  - `always` — TAC calls `retrieveMemory` before every inbound message (TAC native).
  - `never` — no automatic recall; the LLM gets no memory context.
  - `first-prompt` — template-level pattern. TAC channels are constructed with `memoryMode: 'never'`; the app calls `tac.retrieveMemory` once on the conversation's first message and caches the response in `memoryByConversation` for subsequent turns. Drops Memory API cost on long sessions. Tradeoff: observations added mid-conversation (e.g., by CI) only surface in the next conversation.

### Memory Injection

`MemoryPromptBuilder.build(memory, session)` (OOTB in TAC) formats observations / summaries / communications + profile traits into a system-context string. The template wraps the call in `injectMemoryContext` for diagnostic logging only — no formatting customization. Output shape (illustrative):

```
User observations:
- Prefers morning appointments
- Has a history of billing questions

Conversation summaries:
- Customer called about card delivery, resolved successfully

User profile:
Contact: {"firstName":"Rafaela","lastName":"Martins","email":"...","phone":"..."}
```

Profile traits are injected even when `memory` is undefined — the two are decoupled.

### Channel context injection

In addition to memory, the template injects `Current communication channel: <channel>` as system context **on channel change** (first turn, or a cross-channel transition like WhatsApp → voice on the same conversation under `GROUP_BY_PROFILE`). The system prompt uses this to adapt style (no markdown / emojis / digits on voice; light markdown OK on messaging). See [HUMANIZING_AGENTS.md](HUMANIZING_AGENTS.md#5-channel-awareness).

### Profile Trait Structure

Traits are returned nested under the trait group name (controlled by `TWILIO_MEMORY_PROFILE_TRAIT_GROUPS`):

```json
{
  "traits": {
    "Contact": {
      "firstName": "Rafaela",
      "lastName": "Martins",
      "email": "user@example.com",
      "phone": "+5511976932682"
    }
  }
}
```

`MemoryPromptBuilder` handles trait shape variations (nested vs flat, `camelCase` vs `snake_case`).

---

## What the template layers on top of TAC 1.0.0

TAC 1.0.0 (the published npm package) absorbed almost all of the patches that the pre-1.0 fork carried (WhatsApp channel, public Fastify, unified `/webhook`, dedup, etc.). The template no longer patches TAC. What it does add are runtime patterns and one helper that aren't OOTB:

| Layer | What | Where |
|---|---|---|
| Voice quality | Word-boundary buffering of LLM streams before TTS | [src/providers/streamBuffer.ts](src/providers/streamBuffer.ts), applied in [src/app.ts](src/app.ts) |
| Messaging pacing | Per-conversation debounce + in-flight serialization | [src/app.ts](src/app.ts) (`debounceStates`, `fireDebounce`, `processMessageTurn`) |
| WhatsApp typing | Eager indicator on every inbound message via Programmable Messaging REST | [src/app.ts](src/app.ts) (`sendWhatsAppTypingIndicator`) |
| Channel awareness | `Current communication channel: <channel>` system message, re-injected on channel change | [src/app.ts](src/app.ts) (`lastChannelByConversation`) |
| Interrupt context | `[Interruption] customer heard X` system message on voice barge-in | [src/app.ts](src/app.ts) (`onInterrupt`) |
| Memory recall modes | `first-prompt` cache layered on top of TAC's `always` \| `never` | [src/app.ts](src/app.ts) (`memoryByConversation`) |
| Profile fallback | Address-based `lookupProfile('phone', e164)` retry when `fetchProfile` returns undefined | [src/app.ts](src/app.ts) |
| Inbound media | `/inbound-message` Programmable Messaging webhook → Whisper / vision → `insertCommunication` | [src/messaging/](src/messaging/) |
| Inserting customer-attributed text into a CO conversation | REST `POST /v2/Conversations/{id}/Communications` helper (TAC 1.0.0's `ConversationClient` doesn't expose this — strong upstream PR candidate) | [src/messaging/insertCommunication.ts](src/messaging/insertCommunication.ts) |
| Diagnostic webhook hook | `preHandler` log of reqId / idempotency token / signature / body hash for `POST /webhook` — useful for spotting Twilio retries that bypass TAC's dedup | [src/app.ts](src/app.ts) |
| Voice handoff dispatch fix | After `sendStreamingResponse`, issue an empty `sendResponse('')` if `session.pendingHandoffData` is set (TAC 1.0.0's streaming path doesn't dispatch handoff data) | [src/app.ts](src/app.ts) |

The customer-facing playbook for these patterns lives in [HUMANIZING_AGENTS.md](HUMANIZING_AGENTS.md).

---

## Known Limitations and Trade-offs

### Voice TTS stuttering and digraph mispronunciation

LLM providers emit sub-word delta chunks during streaming. Forwarded verbatim to ConversationRelay, these produce audible stuttering at chunk boundaries and mispronunciation of non-English digraphs (Portuguese `manhã`, `nh`/`lh`/`ch`/`rr`; Spanish `ll`/`rr`; French `gn`/`ch`; English `th`/`sh`/`ph`). The template mitigates this by wrapping the LLM stream in `bufferAtWordBoundaries` before handing it to `sendStreamingResponse`. Cost: at most one delta of buffering latency. See [HUMANIZING_AGENTS.md §1](HUMANIZING_AGENTS.md#1-word-boundary-streaming-voice-tts).

### Memory Retrieval on Every Voice Prompt

With `MEMORY_RECALL_MODE=always` (the default), TAC's `VoiceChannel` calls `tac.retrieveMemory()` before firing `onMessageReady` for every voice prompt. This adds 500ms–2s of latency before the LLM starts generating. Set `MEMORY_RECALL_MODE=first-prompt` to recall once per conversation and reuse the cached response — same context for the LLM, dramatically lower latency on follow-up turns and lower Memory API spend. Tradeoff: observations added mid-conversation (e.g., by CI) won't appear until the next conversation.

### Voice handoff dispatch requires an empty sendResponse

In TAC 1.0.0, `sendStreamingResponse` does not dispatch `session.pendingHandoffData` (only `sendResponse` does). If the LLM calls `liveAgentHandoff` mid-stream, the template forces dispatch by issuing `await voiceChannel.sendResponse(conversationId, '')` after the stream completes — which sees `pendingHandoffData` and emits the WebSocket `end` frame that triggers ConversationRelay's `<Connect action>` redirect to the Studio Flow. Upstream PR candidate.

### No Passive Mode Toggle

There is no runtime switch between active and passive Maestro ingestion. The messaging mode is set at startup via `MESSAGING_MODE`. Switching requires a restart and reconfiguring webhooks.

### Conversations v1 Mode Limitations

- Handoff in v1 mode is direct to Flex via the Interactions API — Studio Flow handoff is Maestro-only.
- Memory is fetched once on first message and not refreshed on subsequent messages (the `memoryLoaded` flag in the v1 handler prevents re-fetching).
- The v1 handler uses a simple in-memory session store (`v1Sessions` Map) that does not survive server restarts.

### Duplicate Communications in CI

If the Maestro conversation configuration uses `GROUP_BY_PARTICIPANT_ADDRESSES` (without channel type), both VOICE and WHATSAPP capture rules may match the same outbound message, causing duplicates. Use `GROUP_BY_PARTICIPANT_ADDRESSES_AND_CHANNEL_TYPE` to avoid this.

### Inbound media: first message must be text

Maestro will not create a conversation for an audio-only or image-only inbound message. If the customer's very first WhatsApp message is a voice note or image, `findActiveConversation` returns null and the media handler logs a warning and skips. The customer must text first to establish the conversation. See the "Inbound Media" section of the [README](README.md#inbound-media-audio--image).
