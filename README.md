# Conversation Relay — Twilio Agent Connect (TAC)

## Overview

An AI-powered conversational assistant built on **Twilio Agent Connect (TAC)** that works across **Voice**, **WhatsApp**, and **SMS** channels. This application replaces the original Express + WebSocket + Redis architecture with TAC's built-in channel management, session handling, and memory retrieval — while retaining full control over LLM providers, tools, and prompts.

### Key Differences from the Application Template

| Concern | Application Template | This (TAC) |
|---|---|---|
| **Server** | Express + custom WebSocket | TAC's built-in Fastify server |
| **Session state** | Redis | In-memory (TAC `ConversationSession`) |
| **Conversation history** | Redis persistence | Maestro (Memora) |
| **User identity** | Google Sheets lookup (`identify_user` tool) | Memora profile traits (automatic) |
| **Messaging inbound** | Conversations v1 `onMessageAdded` webhook | Maestro v2 `COMMUNICATION_CREATED` or Conversations v1 (configurable) |
| **Messaging outbound** | Conversations v1 `messages.create()` | Maestro Send API or Conversations v1 (configurable) |
| **Voice** | ConversationRelay WebSocket | ConversationRelay WebSocket (via TAC `VoiceChannel`) |
| **Memory** | None | Memora observations, summaries, profile traits |
| **Human handoff** | Interactions API + webhook removal | Interactions API + webhook removal (conversations-v1 mode) |
| **Webhook validation** | Custom middleware | TAC built-in |

## Features

- **Voice Channel**: ConversationRelay with real-time WebSocket streaming
- **WhatsApp Channel**: Custom `WhatsAppChannel` with typing indicators
- **SMS Channel**: TAC built-in `SMSChannel`
- **Dual Messaging Modes**: Maestro (active) or Conversations v1 (Flex-compatible)
- **Customer Memory**: Automatic Memora integration — observations, summaries, profile traits
- **Enterprise Knowledge**: Domain-scoped knowledge base search via dynamically registered tools (see [KNOWLEDGE.md](KNOWLEDGE.md))
- **Multi-Provider LLM**: OpenAI Chat Completions, Responses API, and Agents SDK
- **Human Agent Handoff**: Flex integration via Interactions API (conversations-v1 mode)
- **Typing Indicators**: WhatsApp typing indicators via Programmable Messaging API
- **Tool System**: Extensible tools using TAC's `defineTool` / `TACTool`
- **Conversation Intelligence**: Maestro passive capture feeds CI operators
- **Humanization patterns**: Word-boundary TTS streaming, message debouncing, eager typing indicators, interrupt-aware context, channel-adaptive output (see [HUMANIZING_AGENTS.md](HUMANIZING_AGENTS.md))

## Prerequisites

- Node.js (v20+)
- npm
- Twilio Account with:
  - A phone number configured for voice and WhatsApp
  - Maestro conversation configuration (with memory store)
  - API Key and Token (for Maestro/Memora APIs)
  - Twilio Flex (if using human agent handoff)
- OpenAI API Key
- ngrok (for local development)

## Setup

### 1. Open ngrok tunnel

```bash
ngrok http 3000
```

Copy the forwarding URL (e.g., `https://your-domain.ngrok.app`).

### 2. Install dependencies

The TAC package is linked locally from the monorepo. Build it first:

```bash
cd samples/twilio-agent-connect-typescript
npm install && npm run build
```

Then install the app:

```bash
cd solutions/conversation-relay-tac
npm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

#### Required Variables

| Variable | Description | Example |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | Your Twilio Account SID | `ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `TWILIO_AUTH_TOKEN` | Your Twilio Auth Token | `your_auth_token` |
| `TWILIO_API_KEY` | Twilio API Key SID | `SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `TWILIO_API_SECRET` | Twilio API Key Secret | `your_api_secret` |
| `TWILIO_PHONE_NUMBER` | Your Twilio phone number (voice/SMS) | `+1234567890` |
| `TWILIO_WHATSAPP_NUMBER` | Your WhatsApp sender | `whatsapp:+1234567890` |
| `TWILIO_CONVERSATION_CONFIGURATION_ID` | Maestro conversation configuration ID | `conv_configuration_xxxxx` |
| `OPENAI_API_KEY` | Your OpenAI API Key | `sk-...` |

#### Optional Variables

| Variable | Description | Default |
|---|---|---|
| `TWILIO_MEMORY_PROFILE_TRAIT_GROUPS` | Comma-separated trait group names for profile fetch | - |
| `TWILIO_REGION` | Twilio region subdomain for API routing (rarely needed) | - |
| `MEMORY_RECALL_MODE` | Memory recall strategy: `always`, `never`, or `first-prompt` (template-level, recall once per conversation) | `always` |
| `TWILIO_VOICE_PUBLIC_DOMAIN` | Public domain for voice WebSocket (no protocol/port/path, e.g. `abc123.ngrok.app`) | - |
| `MESSAGING_MODE` | `maestro` or `conversations-v1` | `maestro` |
| `TWILIO_CONVERSATIONS_SERVICE_SID` | Conversations Service SID (for v1 mode) | - |
| `TWILIO_WORKFLOW_SID` | TaskRouter Workflow SID (for Flex handoff) | - |
| `TWILIO_WORKSPACE_SID` | TaskRouter Workspace SID (for Flex handoff) | - |
| `KB_FAQ_ID` | Knowledge Base ID for general FAQ | - |
| `KB_BILLING_ID` | Knowledge Base ID for medical billing | - |
| `KB_DRIVER_ID` | Knowledge Base ID for driver service | - |
| `LLM_PROVIDER` | `openai-chat-completions`, `openai-responses`, or `openai-agents` | `openai-chat-completions` |
| `LLM_MODEL` | OpenAI model | `gpt-4.1` |
| `OPENAI_MAX_COMPLETION_TOKENS` | Max tokens for LLM responses | - |
| `PORT` | Server port | `3000` |
| `WELCOME_GREETING` | Voice greeting message | `Thanks for calling! How can I help you today?` |

### 4. Configure Twilio webhooks

#### Voice (Incoming Calls)

1. Go to **Phone Numbers > Manage > Active Numbers** in Twilio Console
2. Select your phone number
3. Under **Voice & Fax**, set:
   - **A call comes in**: Webhook
   - **URL**: `https://your-domain.ngrok.app/twiml`
   - **HTTP Method**: POST

#### Messaging — Maestro Mode (default)

In your Maestro conversation configuration, set the status callback:
- **URL**: `https://your-domain.ngrok.app/webhook`
- **Method**: POST

This single endpoint handles all Maestro v2 events (SMS + WhatsApp). The server routes `COMMUNICATION_CREATED` events to the correct channel based on `author.channel`.

#### Messaging — Conversations v1 Mode

1. Go to **Conversations > Manage > Services** in Twilio Console
2. Select your Conversations Service
3. Under **Webhooks**, add:
   - **Post-Event URL**: `https://your-domain.ngrok.app/conversations-webhook`
   - **Events**: `onMessageAdded`

### 5. Run the app

```bash
npm run dev
```

## Messaging Modes

This application supports two mutually exclusive messaging modes, controlled by the `MESSAGING_MODE` environment variable.

### Maestro Mode (`MESSAGING_MODE=maestro`)

- **Default mode** — Maestro is the active conversation orchestrator
- TAC's `WhatsAppChannel` and `SMSChannel` process Maestro v2 webhook events
- Outbound messages sent via Maestro Send API (`POST /v2/Communications`)
- Memory, CI, and profile traits all flow through Maestro natively
- **No Flex handoff support** — Flex requires Conversations v1

### Conversations v1 Mode (`MESSAGING_MODE=conversations-v1`)

- Conversations v1 is the messaging backbone — compatible with Flex
- Custom webhook handler at `/conversations-webhook` processes `onMessageAdded` events
- Outbound messages sent via `client.conversations.v1.conversations(sid).messages.create()`
- Maestro runs passively (capture rules observe traffic for CI and memory)
- **Full Flex handoff support** via Interactions API
- TAC is still used for: memory retrieval, profile lookup, tool definitions, LLM providers, voice

### Choosing a Mode

| Use Case | Recommended Mode |
|---|---|
| AI-only (no human escalation) | `maestro` |
| Flex handoff required | `conversations-v1` |
| Conversation Intelligence only | Either (Maestro passive in v1 mode) |
| Voice + messaging | Either (voice always uses TAC) |

## Architecture

### Maestro Mode

```
Customer (WhatsApp/SMS/Voice)
        |
        v
  Twilio Platform
        |
        +---> Voice Call ---> /twiml ---> ConversationRelay WebSocket
        |                                        |
        +---> Maestro v2 ---> /webhook ---> Route by author.channel
                                               |             |
                                          SMSChannel   WhatsAppChannel
                                               |             |
                                               +------+------+
                                                      |
                                                      v
                                            TAC onMessageReady
                                                      |
                                          +-----------+-----------+
                                          |                       |
                                    Memory/Profile           LLM Provider
                                    (Memora)              (OpenAI stream/generate)
                                                              |
                                                              v
                                                         Tool Execution
                                                              |
                                                              v
                                                      Send Response
                                                   (Maestro Send API)
```

### Conversations v1 Mode

```
Customer (WhatsApp/SMS/Voice)
        |
        v
  Twilio Platform
        |
        +---> Voice Call ---> /twiml ---> ConversationRelay WebSocket
        |                                        |
        +---> Conversations v1 ---> /conversations-webhook
                                            |
                                            v
                                    conversations-v1.ts
                                            |
                                +-----------+-----------+
                                |                       |
                          Memory/Profile           LLM Provider
                          (Memora via TAC)      (OpenAI generate)
                                                        |
                                                        v
                                                   Tool Execution
                                                        |
                                          +-------------+-------------+
                                          |                           |
                                    Send Response              Handoff to Flex
                                 (Conversations v1 API)    (Interactions API)
```

## Human Agent Handoff

Handoff is supported in **conversations-v1 mode** and follows this flow:

1. **LLM triggers `human_agent_handoff` tool** — the tool returns a confirmation, and the provider records it as a side-effect action
2. **Post-completion routing** — `handlePostCompletion()` detects the handoff action and calls `handleHandoff()`
3. **Flex Interaction created** — the Interactions API links the existing Conversations v1 conversation to Flex via `media_channel_sid`, routing to TaskRouter
4. **Bot webhooks removed** — all webhooks matching the ngrok domain are removed from the conversation so the bot stops receiving messages
5. **Conversation marked** — attributes updated with `handedOff: true`, interaction SID, and timestamp
6. **Customer name resolution** — the Flex task `name` attribute is populated from Memora profile traits (`firstName` + `lastName`), falling back to the customer phone number

## Customer Memory (Memora)

TAC automatically retrieves customer memory before each message is processed:

- **Profile lookup**: Phone number -> Profile ID (via identity resolution)
- **Observations**: Things Memora knows about the customer (extracted from past conversations)
- **Summaries**: AI-generated summaries of past conversations
- **Communications**: Recent message history
- **Profile traits**: Structured customer data (name, email, preferences) from trait groups

Memory context is injected as a system message to the LLM, so the AI knows the customer's history without any explicit tool call.

## Conversation Intelligence

When Maestro capture rules are configured for your phone number, all conversations (both AI and human-assisted) are automatically analyzed by CI operators. This works in both modes:

- **Maestro mode**: Active capture — Maestro records communications directly
- **Conversations v1 mode**: Passive capture — Maestro observes the v1 traffic via capture rules

**Important**: To avoid duplicate communications in CI, ensure your Maestro conversation configuration uses `GROUP_BY_PARTICIPANT_ADDRESSES_AND_CHANNEL_TYPE` as the grouping type.

## Inbound Media (Audio & Image)

WhatsApp customers can send voice notes and images (medication photos, document scans, receipts, etc.). Maestro's Conversation Orchestrator drops media attachments — only text bodies enter the conversation. To make audio + images reach the LLM and CI operators, the template runs a second webhook outside Maestro that runs the media through the appropriate model (Whisper for audio, GPT-4o-mini vision for images) and inserts the result back as a customer-attributed Communication.

The agent treats the transcribed audio or described image as a normal turn. CI operators run on it. Memora extracts observations from it. From everyone downstream of CO, it's indistinguishable from a real text message.

### Pipeline

```
WhatsApp customer sends audio or image
  │
  ├──── Maestro / CO ────────────────────────────────────────────────────────────
  │     Drops the media. No COMMUNICATION_CREATED fires for media-only.
  │     (CO will however fire COMMUNICATION_CREATED for the *inserted* text
  │      message later in this pipeline — see step 5 below.)
  │
  └──── Programmable Messaging webhook ──────────────────────────────────────────
        POST /inbound-message  (template-managed, signed)
        │
        1. Validate X-Twilio-Signature against TAC's auth token
        2. Download media via Twilio Basic Auth (API_KEY / API_SECRET)
        3. Run the appropriate model:
              audio/*  →  Whisper transcription                      → text
              image/*  →  Vision model (gpt-4o-mini) + custom prompt → text
        4. Find the active CO conversation for the customer/agent address pair
        5. POST /v2/Conversations/{id}/Communications with:
             author     = customer participant (full address + participantId)
             recipients = [agent participant]
             content    = { type: "TEXT", text: "[áudio transcrito] <text>"
                                                  or "[imagem recebida] <text>" }
           ↓
        6. CO fires COMMUNICATION_CREATED → TAC.onMessageReady → agent processes
        7. CI operators (if configured) extract observations from the text
```

### Where each Twilio resource fits

| Resource | Role | Where configured |
|---|---|---|
| **WhatsApp Sender** | Receives the inbound audio. Webhook fires per message regardless of CO. | Console → Messaging → Senders → WhatsApp → "Webhook URL for incoming messages" |
| **Conversation Orchestrator (Maestro)** | Groups conversations, manages participants, fires `COMMUNICATION_CREATED` on the inserted message, hosts CI operators. **Not** involved in transcription or media handling. | Console → Conversation Orchestrator → Configurations |
| **Twilio Media API** | Hosts the media file behind `MediaUrl0` for ~one hour after delivery. | Auto, no setup |
| **OpenAI Whisper** | Transcribes the audio buffer to text. | `OPENAI_API_KEY` env var; model via `WHISPER_MODEL`; language via `WHISPER_LANGUAGE` |
| **OpenAI vision (GPT-4o-mini default)** | Describes the image as plain text. Prompt is customizable per deployment. | `OPENAI_API_KEY`; model via `VISION_MODEL`; prompt via `IMAGE_DESCRIPTION_PROMPT` |
| **Memora** | Receives observations once CI operators run on the inserted text. | Linked to the conv config's `memoryStoreId` |

### Setup steps

1. **Enable the feature in env**:
   ```bash
   INBOUND_MEDIA_ENABLED=true
   # optional overrides:
   INBOUND_MEDIA_ROUTE_PATH=/inbound-message   # default
   WHISPER_MODEL=whisper-1                     # audio model, default
   WHISPER_LANGUAGE=pt                         # audio language hint, default
   VISION_MODEL=gpt-4o-mini                    # image model, default
   IMAGE_DESCRIPTION_PROMPT=<your prompt>      # tailor to your domain (pharma, retail, etc.)
   ```
   `OPENAI_API_KEY` is already required by the LLM providers — Whisper + vision reuse it.
   One flag turns both audio and image handling on — they share the cost and the route.

2. **Point your WhatsApp Sender's webhook URL at the route**:
   - Console → Messaging → Senders → WhatsApp → click your sender (e.g., `whatsapp:+551132304091`)
   - Set "Webhook URL for incoming messages" to `https://<your-host><INBOUND_MEDIA_ROUTE_PATH>` (e.g. `https://goliveira.ngrok.app/inbound-message`)
   - Method: `POST`
   - Save

3. **Start the app** — at boot you should see:
   ```
   [InboundMedia] route registered at /inbound-message
   ```

4. **Test**: open WhatsApp on the customer's phone, send any text first to establish an active CO conversation, then send a voice note. In logs you'll see:
   ```
   [InboundMedia] transcribed audio (N chars), inserting into conv_conversation_...
   [InboundMedia] insert OK — actionId=conv_communication_... messageSid=IM...
   ```
   And the agent should reply to the transcription in the customer's WhatsApp.

### What's NOT going through Maestro

- The audio file itself — never enters CO. Lives only in Twilio Media (transient) and Whisper's API (transient).
- The transcription step — pure application + OpenAI. CO has no visibility until step 5.
- Signature validation — uses TAC's auth token, no CO involvement.

What IS through Maestro: only the final `POST /v2/Conversations/{id}/Communications`. That's the boundary where application content re-enters the platform and becomes visible to CO/CI/Memora.

### Limitations & extension points

- **First message must be text**. Maestro won't create a conversation for audio-only inbound. If the customer's very first WhatsApp message is a voice note, `findActiveConversation` returns null and the transcription is skipped with a warning. Customer needs to text first.
- **Audio and image only for now**. The dispatch in [src/messaging/inboundMediaWebhook.ts](src/messaging/inboundMediaWebhook.ts) branches on `audio/*` (Whisper) and `image/*` (vision). PDF (OCR), video (frame extraction), and vCard are natural extensions — same shape, different model.
- **OpenAI costs apply per media item** — Whisper per audio second, vision per token. Set `INBOUND_MEDIA_ENABLED=false` to opt out entirely.

### Why a REST endpoint, not the Action API

The matching endpoint `POST /v2/Conversations/{id}/Actions` with `INSERT_COMMUNICATION` looks tempting and is documented, but it silently requires the participant's address to carry a `CH...` channelId binding — which only exists when a Conversations v1 bridge is active on the WhatsApp Sender. The REST endpoint `POST /v2/Conversations/{id}/Communications` has no such requirement and works in pure-Maestro deployments. Worth knowing if anyone tries to "simplify" the helper by switching to the Action API.

## Enterprise Knowledge

The template integrates with **Twilio Enterprise Knowledge** (Memora) — a managed RAG service that stores, chunks, and semantically searches your content. Each domain (FAQ, billing, driver service) gets its own Knowledge Base and a dedicated search tool, so the LLM can pick the right source based on the question.

**Built-in tools:**
- `search_support_faq` — general support questions
- `search_medical_billing` — medical billing concepts
- `search_driver_service` — Motorista da Rodada info

Each tool is registered dynamically from env vars (`KB_FAQ_ID`, `KB_BILLING_ID`, `KB_DRIVER_ID`) — missing env var = tool not registered, so you can run without any KBs.

**Content** lives in the [knowledge/](knowledge/) directory as markdown files, organized by KB. An uploader script at [scripts/upload-knowledge.ts](scripts/upload-knowledge.ts) walks the directory and creates Twilio Knowledge Sources.

**To add a new KB**, see [KNOWLEDGE.md](KNOWLEDGE.md) — covers creating KBs, uploading sources, registering new tools, best practices, and troubleshooting.

## LLM Providers

Three OpenAI providers are supported, selectable via `LLM_PROVIDER`:

| Provider | Streaming (Voice) | Non-Streaming (Messaging) | Tool Execution |
|---|---|---|---|
| `openai-chat-completions` | Yes (async generator) | Yes | Manual loop |
| `openai-responses` | Yes (async generator) | Yes | Manual loop |
| `openai-agents` | Yes (async generator) | Yes | Automatic (agent loop) |

All providers implement the `LLMProvider` interface with:
- `streamResponse()` — returns `AsyncIterable<string>` for voice
- `generateResponse()` — returns complete string for messaging
- `addSystemContext()` — injects context (memory, phone number, etc.)
- `getLastAction()` / `clearLastAction()` — side-effect tracking (handoff, language switch)

## Tools

Tools are defined using TAC's `defineTool()` and executed via a unified `executeTool()` function.

| Tool | Description |
|---|---|
| `book_driver` | Books a driver via Google Calendar |
| `check_pending_bill` | Checks for pending medical bills |
| `check_card_delivery` | Checks card delivery status |
| `check_hsa_account` | Checks HSA account balance |
| `check_increase_limit` | Checks credit limit eligibility |
| `troubleshoot_login_issues` | Helps resolve login issues |
| `check_payment_options` | Gets available payment options |
| `search_common_medical_terms` | Searches medical terminology |
| `switch_language` | Switches conversation language |
| `human_agent_handoff` | Transfers to a Flex agent |
| `add_survey_response` | Records CSAT survey responses |

## API Endpoints

### Always Available

| Endpoint | Method | Description |
|---|---|---|
| `/twiml` | POST | Voice webhook — generates ConversationRelay TwiML |
| `/ws` | GET | WebSocket endpoint for ConversationRelay |
| `/conversation-relay-callback` | POST | ConversationRelay callback (handoff, end) |

### Maestro Mode Only

| Endpoint | Method | Description |
|---|---|---|
| `/webhook` | POST | Maestro v2 webhook — routes SMS/WhatsApp events |

### Conversations v1 Mode Only

| Endpoint | Method | Description |
|---|---|---|
| `/conversations-webhook` | POST | Conversations v1 `onMessageAdded` webhook |

## Project Structure

```
src/
+-- index.ts                          # Main entry point — TAC init, handlers, server startup
+-- config.ts                         # Environment configuration
+-- languageOptions.ts                # TTS/STT language settings
+-- channels/
|   +-- conversations-v1.ts           # Conversations v1 webhook handler + Flex handoff
+-- providers/
|   +-- factory.ts                    # LLM provider factory
|   +-- types.ts                      # LLMProvider interface and ToolAction types
|   +-- openai-chat-completions.ts    # Chat Completions provider
|   +-- openai-responses.ts           # Responses API provider
|   +-- openai-agents.ts              # Agents SDK provider
+-- prompts/
|   +-- systemPrompt.ts              # System prompt (persona, guidelines, tool instructions)
|   +-- additionalContext.ts          # Dynamic context (date/time)
+-- tools/
|   +-- index.ts                      # Tool definitions and executeTool()
|   +-- *.ts                          # Individual tool implementations
+-- data/
    +-- mock-data.ts                  # Mock data for tool responses
```

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload (tsx watch) |
| `npm run build` | Compile TypeScript |
| `npm start` | Run production build |

## Design Decisions

> The sections below cover individual design choices. For the consolidated
> playbook on what to do (and why) to make a TAC agent feel human across
> all the surfaces — TTS stuttering, message debouncing, typing indicators,
> interrupt context, channel-adaptive output, inbound media — see
> **[HUMANIZING_AGENTS.md](HUMANIZING_AGENTS.md)**.

### Why TAC over the original template?

1. **No Redis dependency** — TAC manages sessions in-memory, Memora handles persistence
2. **Unified channel abstraction** — voice, SMS, and WhatsApp share the same handler interface
3. **Built-in memory** — customer history and profile traits are automatic, no manual integration
4. **Simpler codebase** — ~350 lines in `index.ts` vs. multiple controllers, routes, middleware, and utilities
5. **Webhook deduplication** — TAC server handles Maestro's at-least-once delivery

### Why two messaging modes?

Maestro (Conversations v2) is the modern path — active conversation management, native memory, CI integration. But Flex only supports Conversations v1. Rather than choosing one, this app supports both:

- **Maestro** for AI-only deployments where Flex isn't needed
- **Conversations v1** when human escalation via Flex is a requirement

Maestro still runs passively in v1 mode, so CI and memory work regardless.

### Why fetch profile at handoff time?

Profile traits (customer name) are needed for the Flex task `name` attribute. Rather than caching trait data in memory and risking staleness, the handoff calls `tac.fetchProfile()` at the moment of handoff — ensuring the latest data from Memora.

### Why debounce messaging turns?

Default flow is 1:1 — every inbound `onMessageReady` triggers an LLM call and a reply. That breaks down when a customer types `"oi"` and immediately follows with `"preciso de ajuda"`: the agent generates a half-formed greeting before the second message even arrives, then a second turn for the follow-up. Confusing for the customer, two API calls for what's logically one turn.

The template applies a per-conversation debounce window for **messaging channels** (`MESSAGE_DEBOUNCE_MS`, default 2000ms). Inbound messages buffer until the window goes quiet, then run as a single LLM turn with combined text. Voice channels are never debounced (ConversationRelay's WebSocket handles natural turn-taking and added latency would be audible).

The debounce also coordinates with in-flight LLM calls: if a new message arrives mid-turn, it's appended to the buffer and a fresh debounce kicks in once the current turn completes. Avoids overlapping responses.

A typing indicator (WhatsApp only — Twilio's typing-indicator API is messaging-channel-specific) fires immediately on every inbound message, before the buffer/debounce logic. Customers see "typing…" within ~50ms of sending, refreshed on every additional message — natural discouragement against piling up more messages while the agent works.

### Why a side-channel for inbound media (audio, eventually images)?

Conversation Orchestrator's docs spell this out: "Communications support text and template messages. Media attachments on inbound or outbound WhatsApp messages aren't added to the conversation." Same for RCS. So an audio voice note from a WhatsApp customer never enters CO — neither the media URL nor any transcription. Memora has nothing to extract observations from. CI operators run on nothing.

The template solves this by registering a **second webhook** that bypasses CO and consumes the underlying Programmable Messaging webhook directly. Wired by setting `INBOUND_MEDIA_ENABLED=true`:

1. WhatsApp inbound media → Programmable Messaging webhook fires `POST /inbound-message`
2. Template validates `X-Twilio-Signature` against TAC's auth token
3. Audio media: downloads, transcribes via Whisper (`WHISPER_MODEL`, `WHISPER_LANGUAGE`)
4. Looks up the active CO conversation for the customer/agent address pair
5. Calls `insertCommunication` with `[áudio transcrito] <text>` — the inserted message fires `COMMUNICATION_CREATED` → TAC's `onMessageReady` → the agent processes it as a normal customer turn → CI operators run on the transcription

Result: from CO's, Memora's, CI's, and the LLM's perspective, the audio "is" a customer message. The application boundary owns transcription; the platform owns insight extraction. That's the pitch.

Off by default — costs nothing to demos that don't need it. Adding image-description, document OCR, etc. follows the same pattern: extend the dispatch in `src/messaging/inboundMediaWebhook.ts` to handle the appropriate `MediaContentType*`.

### Why expose `insertCommunication`?

Maestro's `SEND_MESSAGE` Actions API only emits messages *from* the agent. There's no built-in way to **inject application-side content as a customer message** — useful for surfacing audio transcriptions, OCR'd images, or any content your app produces on behalf of the customer back into the conversation.

Twilio's Conversation Orchestrator does support this via a separate Actions API type:

```
POST /v2/Conversations/{id}/Actions
{ "type": "INSERT_COMMUNICATION", "payload": { "from": ..., "to": ..., "content": ... } }
```

But TAC 1.0.0's `ConversationClient` doesn't expose it. The template adds [src/messaging/insertCommunication.ts](src/messaging/insertCommunication.ts) — a thin helper that POSTs the action using the credentials from `tac.getConfig()`.

Importable as:

```ts
import { insertCommunication } from 'conversation-relay-tac/messaging';

await insertCommunication(tac, {
  conversationId,
  from: { channel: 'WHATSAPP', participantId: customerParticipantId },
  to:   [{ channel: 'WHATSAPP', participantId: agentParticipantId }],
  text: '<the transcription / OCR / etc.>',
});
```

The inserted communication:

- Is attributed to the customer participant in conversation history.
- Fires `COMMUNICATION_CREATED` → TAC's `onMessageReady` → the agent processes it as a normal turn.
- Is visible to **Conversation Intelligence** — operators run on the text just like any other message, so audio transcriptions surface as observations and summaries in Memora.

Channels supported: `WHATSAPP`, `SMS`, `CHAT`, `RCS`. Voice transcripts arrive natively via ConversationRelay, so this isn't needed for voice. Strong upstream PR candidate for TAC's `ConversationClient`.

### Why buffer LLM streams to word boundaries on voice?

OpenAI's streaming APIs (and Anthropic's, and most LLM providers) emit deltas as sub-word fragments — often 1-3 characters at a time. Forwarding each delta verbatim to ConversationRelay's TTS produces two distinct problems:

1. **Stuttering at chunk boundaries.** TTS engines have to coalesce sub-word tokens on the fly; at chunk boundaries the audio can repeat or drop tokens.
2. **Mispronunciation of digraphs in non-English languages.** TTS applies grapheme-to-phoneme rules per chunk. When `manhã` arrives as `man` + `hã`, the engine has already committed to a /n/ for the `n` before the `h` arrives — so you get /man.ha/ instead of the correct /ma.ɲɐ̃/. Same issue applies to Portuguese `nh`/`lh`/`ch`/`rr`, Spanish `ll`/`rr`, French `gn`/`ch`, English `th`/`sh`/`ph`, etc.

The fix lives in [src/providers/streamBuffer.ts](src/providers/streamBuffer.ts): a `bufferAtWordBoundaries` async-generator wrapper that holds the partial trailing word until whitespace arrives, then yields whole words. Applied once at the voice call site in [app.ts](src/app.ts) so any provider — OpenAI Responses, OpenAI Chat Completions, OpenAI Agents SDK, Anthropic, local LLMs — benefits without per-provider code. Messaging channels skip the wrapper entirely (they call `generateResponse`, not `sendStreamingResponse`), so markdown/emoji output is unaffected.

Cost: one delta of latency. Benefit: dramatically smoother TTS, plus correct pronunciation for any non-English voice deployment.

## Known limitations

- **WhatsApp Business Calling — first 1-2s of greeting may clip.** Meta's WhatsApp calling API takes a moment to establish the audio path after SIP connects. Working around this requires a custom `<Pause>` injected before `<Connect>` in the TwiML; not currently available OOTB.
- **Memory retrieval mode** is controlled by `MEMORY_RECALL_MODE` (default `always`). TAC 1.0.0 itself only ships `'always' | 'never'` so customers aren't billed for Memory API calls they didn't ask for. The template adds a third option, `'first-prompt'`, that recalls memory once per conversation and reuses the cached response on subsequent turns — same context for the LLM, dramatically lower Memory API cost on long conversations. Tradeoff: observations/summaries added mid-conversation (e.g., by Conversation Intelligence) won't appear until the next conversation. Filed upstream as a TAC PR candidate.
- **Maestro handoff is no-op.** `tac.triggerHandoff()` was removed in `twilio-agent-connect@1.0.0` in favor of the tool-based pattern. To enable LLM-driven handoff in Maestro mode, add `createStudioHandoffTool(tac, session)` to your tools list.
- **Deepgram-specific ConversationRelay attrs unavailable.** `deepgramSmartFormat` and `speechTimeout` are not in TAC 1.0.0's schema, and `reportInputDuringAgentSpeech` is boolean-only (the TwiML spec also accepts `'any' | 'speech' | 'none'`). File an upstream PR or use `patch-package` if you need them.

## License

This project is licensed under the MIT License.
