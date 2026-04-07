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
6. [Handoff Flow](#handoff-flow)
7. [TAC Package Customizations](#tac-package-customizations)
8. [Known Limitations and Trade-offs](#known-limitations-and-trade-offs)

---

## System Overview

The application is structured in three layers:

1. **TAC Package** (`twilio-agent-connect`) — channel management, Maestro/Memora API clients, Fastify server, webhook handling
2. **Application Layer** (`src/index.ts`) — LLM orchestration, tool execution, memory injection, mode-based routing
3. **Channel Handlers** — Maestro channels (via TAC) or Conversations v1 (custom handler)

TAC handles the infrastructure concerns (WebSocket protocol, webhook validation, session lifecycle, API clients), while the application layer owns the business logic (what the AI says, which tools it can call, how memory is used).

---

## Component Breakdown

### TAC Core (`@twilio/tac-core`)

| Component | Role |
|---|---|
| `TAC` | Central orchestrator — config, channel registry, memory retrieval, profile fetch |
| `VoiceChannel` | ConversationRelay WebSocket protocol, TwiML generation, stream tasks |
| `SMSChannel` | Maestro v2 SMS webhook processing and Send API |
| `WhatsAppChannel` | Custom — Maestro v2 WhatsApp webhook processing, Send API, typing indicators |
| `MemoryClient` | Memora API — profile lookup, memory retrieval, observation/summary management |
| `ConversationClient` | Maestro Conversations API — create conversations, add participants, send communications, list participants |
| `KnowledgeClient` | Knowledge API — semantic search across uploaded knowledge bases |
| `TACConfig` | Environment-based configuration with Zod validation |

### TAC Server (`@twilio/tac-server`)

| Component | Role |
|---|---|
| `TACServer` | Fastify server with built-in routes for `/webhook`, `/twiml`, `/ws`, `/conversation-relay-callback` |
| `server.app` | Public Fastify instance — allows registering custom routes (e.g., `/conversations-webhook`) |

### Application Layer

| Component | Role |
|---|---|
| `index.ts` | Entry point — initializes TAC, registers channels, wires handlers, starts server |
| `config.ts` | App-specific config (messaging mode, LLM provider, Twilio SIDs) |
| `providers/*.ts` | Three OpenAI LLM providers implementing `LLMProvider` interface |
| `tools/index.ts` | Tool definitions using `defineTool()` and unified `executeTool()` |
| `channels/conversations-v1.ts` | Conversations v1 webhook handler, typing indicators, Flex handoff |
| `prompts/*.ts` | System prompt and dynamic context injection |

---

## Data Flows

### Voice Call (Both Modes)

```
1. Incoming call -> POST /twiml
2. TACServer generates TwiML with ConversationRelay <Connect>
3. Twilio opens WebSocket to /ws
4. VoiceChannel handles 'setup' message -> creates conversation in Maestro
5. User speaks -> VoiceChannel receives 'prompt' message
6. VoiceChannel retrieves memory (Memora) -> fires onMessageReady callback
7. Application gets/creates LLMProvider -> injects memory + profile -> calls streamResponse()
8. Tokens yielded from async generator -> voiceChannel.sendResponse() per token
9. ConversationRelay synthesizes speech in real-time
10. On interrupt: VoiceChannel cancels stream task via AbortController
```

### WhatsApp Message — Maestro Mode

```
1. Customer sends WhatsApp message
2. Maestro captures via capture rules -> fires COMMUNICATION_CREATED webhook
3. POST /webhook -> TACServer routes to WhatsAppChannel (based on author.channel)
4. WhatsAppChannel deduplicates, filters bot messages, retrieves memory
5. Fires onMessageReady callback with message, memory, session
6. Application injects memory + profile + phone -> calls generateResponse()
7. LLM generates complete response -> whatsappChannel.sendResponse()
8. WhatsAppChannel sends via Maestro Send API (POST /v2/Communications)
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

### Handoff Flow (Conversations v1 Mode Only)

```
1. LLM calls human_agent_handoff tool -> provider records lastAction = { type: 'handoff' }
2. handlePostCompletion() detects handoff action
3. Calls handleHandoff(conversationSid, reason, phone, tac)
4. handleHandoff():
   a. Fetches profile from Memora -> extracts firstName + lastName for task name
   b. Creates Flex Interaction via client.flexApi.v1.interaction.create()
      - Links conversation via media_channel_sid
      - Routes to TaskRouter (workspace_sid + workflow_sid)
   c. Adds conversationSid to handedOffConversations Set
   d. Removes bot webhooks matching ngrok domain
   e. Updates conversation attributes (handedOff: true, interactionSid, timestamp)
5. Subsequent webhook events for this conversation are ignored
```

---

## Messaging Mode Details

### Webhook Routing in Maestro Mode

TACServer's `/webhook` endpoint handles all Maestro v2 events:

- **`COMMUNICATION_CREATED`**: Deduplicates by `data.id` (Maestro delivers at-least-once). Routes to `WhatsAppChannel` if `author.channel === 'WHATSAPP'` or `author.address.startsWith('whatsapp:')`, otherwise to `SMSChannel`.
- **Lifecycle events** (`CONVERSATION_CREATED`, `PARTICIPANT_ADDED`, `CONVERSATION_UPDATED`): No-op at the server level. Both channels auto-initialize sessions when they receive their first `COMMUNICATION_CREATED`.

The server responds 200 immediately before processing to prevent Maestro retry storms.

### AI Agent Participant Registration

In Maestro mode, the first time a messaging conversation receives a message, the app calls `conversationClient.addParticipant()` with type `AI_AGENT`. This ensures Conversation Intelligence correctly identifies bot messages vs. customer messages. Without this, Maestro defaults the participant to `HUMAN_AGENT`.

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

Memory retrieval is phone-number based. The flow:

1. Extract customer phone from `session.authorInfo.address` (Maestro) or participant's `messagingBinding.address` (v1)
2. Strip `whatsapp:` prefix for Memora API lookup
3. `memoryClient.lookupProfile(storeId, 'phone', phoneNumber)` -> returns profileId
4. `memoryClient.retrieveMemories(storeId, profileId, { query })` -> returns observations, summaries, communications
5. `tac.fetchProfile(profileId)` -> returns structured traits (nested under trait group)

### Memory Injection

Memory is injected as a system message to the LLM:

```
User observations:
- Prefers morning appointments
- Has a history of billing questions

Conversation summaries:
- Customer called about card delivery, resolved successfully

User profile:
Contact: {"firstName":"Rafaela","lastName":"Martins","email":"...","phone":"..."}
```

### Profile Trait Structure

Traits are returned nested under the trait group name:

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

The application searches both nested (under group names) and flat trait structures, and both `camelCase` and `snake_case` naming conventions.

---

## TAC Package Customizations

This application required several changes to the TAC packages:

### Core Package (`@twilio/tac-core`)

| Change | Reason |
|---|---|
| Added `'whatsapp'` to `ChannelTypeSchema` | Support WhatsApp as a distinct channel type |
| Added `twilioWhatsAppNumber` config field | Separate WhatsApp sender from voice/SMS number |
| Created `WhatsAppChannel` class | WhatsApp-specific: separate number, typing indicators, `channel: 'WHATSAPP'` in Send API |
| Strip `whatsapp:` prefix in profile lookup | Memora expects plain phone numbers |

### Server Package (`@twilio/tac-server`)

| Change | Reason |
|---|---|
| Made `app` (Fastify instance) public | Allow registering custom routes (e.g., `/conversations-webhook`) |
| Unified messaging webhook | Single `/webhook` endpoint routes SMS and WhatsApp based on `author.channel` |
| Respond 200 before processing | Prevent Maestro retry storms during slow LLM responses |
| Communication deduplication | Track `data.id` in a Set to ignore Maestro's at-least-once redelivery |
| Skip lifecycle event broadcasting | Lifecycle events are no-ops; sessions are created lazily on first message |

---

## Known Limitations and Trade-offs

### Voice Streaming with `sendResponse()`

TAC's `VoiceChannel.sendResponse()` sends `{ type: 'text', token, last: true }` on every call. It was designed for sending complete messages, not individual streaming tokens. When used in a streaming loop (as this app does), every token is marked as the final token, which may cause ConversationRelay's TTS to flush after each chunk instead of buffering naturally. This can result in choppier speech compared to the original template's approach.

### Memory Retrieval on Every Voice Prompt

TAC's `VoiceChannel` calls `tac.retrieveMemory()` before firing the `onMessageReady` callback for every voice prompt. This adds 500ms-2s of latency before the LLM starts generating. The original template had no memory retrieval in the voice path.

### No Passive Mode Toggle

There is no runtime switch between active and passive Maestro ingestion. The messaging mode is set at startup via `MESSAGING_MODE`. Switching requires a restart and reconfiguring webhooks.

### Conversations v1 Mode Limitations

- No TAC session for v1 conversations — `tac.triggerHandoff()` cannot be used (handoff calls `handleHandoff()` directly)
- Memory is fetched once on first message and not refreshed on subsequent messages (the `memoryLoaded` flag prevents re-fetching)
- The v1 handler uses a simple in-memory session store (`v1Sessions` Map) that doesn't survive server restarts

### Duplicate Communications in CI

If the Maestro conversation configuration uses `GROUP_BY_PARTICIPANT_ADDRESSES` (without channel type), both VOICE and WHATSAPP capture rules may match the same outbound message, causing duplicates. Use `GROUP_BY_PARTICIPANT_ADDRESSES_AND_CHANNEL_TYPE` to avoid this.
