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

## Known limitations

- **WhatsApp Business Calling — first 1-2s of greeting may clip.** Meta's WhatsApp calling API takes a moment to establish the audio path after SIP connects. Working around this requires a custom `<Pause>` injected before `<Connect>` in the TwiML; not currently available OOTB.
- **Memory retrieval is opt-in.** TAC 1.0.0 defaults channel `memoryMode` to `'never'` so customers aren't billed for Memory API calls they didn't ask for. The template opts in (`new VoiceChannel(tac, { memoryMode: 'always' })`) so the LLM receives memory context on every turn. Tradeoff: ~500ms-2s of Memory API latency + per-call billing per inbound message. There's no "once per conversation" mode upstream yet (filed as an upstream PR candidate).
- **Maestro handoff is no-op.** `tac.triggerHandoff()` was removed in `twilio-agent-connect@1.0.0` in favor of the tool-based pattern. To enable LLM-driven handoff in Maestro mode, add `createStudioHandoffTool(tac, session)` to your tools list.
- **Deepgram-specific ConversationRelay attrs unavailable.** `deepgramSmartFormat` and `speechTimeout` are not in TAC 1.0.0's schema, and `reportInputDuringAgentSpeech` is boolean-only (the TwiML spec also accepts `'any' | 'speech' | 'none'`). File an upstream PR or use `patch-package` if you need them.

## License

This project is licensed under the MIT License.
