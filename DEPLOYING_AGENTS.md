# Deploying a New Agent

This guide walks through creating a new AI agent using the Conversation Relay TAC template. Each agent is a lightweight project that provides its own persona (system prompt) and business logic (tools), while sharing the core runtime, Twilio infrastructure, and LLM providers.

---

## Prerequisites

- The template repo cloned locally
- The TAC package built (`samples/twilio-agent-connect-typescript`)
- A working `.env` in the template (you'll create a new one per agent)
- Node.js v20+

## Quick Start

### 1. Create the agent directory

```bash
mkdir -p demos/my-agent/src/{prompts,tools}
cd demos/my-agent
```

### 2. Initialize the project

```bash
npm init -y
```

Update `package.json`:

```json
{
  "name": "my-agent",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "conversation-relay-tac": "file:../../solutions/conversation-relay-tac",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.1.6"
  }
}
```

### 3. Create the system prompt

`src/prompts/systemPrompt.ts`:

```typescript
export const systemPrompt = `
## Objective
You are Alex, a friendly customer support agent for Acme Corp.
You help customers with order tracking, returns, and general inquiries.

## Guidelines
- Be concise and conversational
- Always verify the customer's identity before sharing account details
- If you can't help, offer to transfer to a human agent

## Tools
- Use check_order_status when customers ask about their orders
- Use initiate_return when customers want to return a product
- Use human_agent_handoff when the customer requests a live agent
`;
```

### 4. Define your tools

`src/tools/index.ts`:

```typescript
import { defineTool } from 'twilio-agent-connect';
import type { TACTool } from 'twilio-agent-connect';

const checkOrderStatus = defineTool(
  'check_order_status',
  'Check the status of a customer order',
  {
    type: 'object',
    properties: {
      orderId: { type: 'string', description: 'The order ID' },
    },
    required: ['orderId'],
  },
  async ({ orderId }) => {
    // Your business logic here — call an API, query a database, etc.
    return JSON.stringify({
      orderId,
      status: 'shipped',
      estimatedDelivery: '2026-04-10',
    });
  }
);

const initiateReturn = defineTool(
  'initiate_return',
  'Start a return process for a customer order',
  {
    type: 'object',
    properties: {
      orderId: { type: 'string', description: 'The order ID to return' },
      reason: { type: 'string', description: 'Reason for the return' },
    },
    required: ['orderId', 'reason'],
  },
  async ({ orderId, reason }) => {
    return JSON.stringify({
      returnId: `RET-${Date.now()}`,
      orderId,
      status: 'initiated',
      message: 'Return label will be sent via email',
    });
  }
);

// Re-export the handoff tool from the template (or define your own)
import { humanAgentHandoffTool } from 'conversation-relay-tac/tools';

export const allTools: TACTool[] = [
  checkOrderStatus,
  initiateReturn,
  humanAgentHandoffTool,
];
```

### 5. Create the entry point

`src/index.ts`:

```typescript
import { config } from 'dotenv';
config();

import { createApp } from 'conversation-relay-tac/app';
import { systemPrompt } from './prompts/systemPrompt.js';
import { allTools } from './tools/index.js';

createApp({
  systemPrompt,
  tools: allTools,
  // Optional overrides:
  // welcomeGreeting: 'Welcome to Acme Corp! How can I help you?',
  // defaultLanguage: { locale_code: 'en-US', ttsProvider: 'google', voice: 'en-US-Journey-O', ... },
  // additionalContext: () => `Date: ${new Date().toISOString()}`,
  //
  // Per-conversation tool factory — runs once when the LLM provider is
  // created. Use for tools that need a runtime dependency like the TAC
  // KnowledgeClient. The porto demo uses this to conditionally add
  // `search_porto_faz_kb` only when KB_PORTO_FAZ_ID is set.
  // buildDynamicTools: (tac) => [...],
  //
  // Per-turn tool factory — runs on EVERY inbound message with the live
  // ConversationSession bound in. Returned tools override same-named static
  // tools for that turn only. Use for runtime guards that need to see the
  // current channel (e.g., refuse to send a WhatsApp CTA when channel is
  // `voice`). The porto demo uses this to wrap `send_after_hours_call_cta`.
  // buildSessionTools: (tac, session) => [...],
});
```

### 6. Create the `.env`

Copy the template's `.env` as a starting point:

```bash
cp ../../solutions/conversation-relay-tac/.env .env
```

Adjust any agent-specific values:

```env
WELCOME_GREETING=Welcome to Acme Corp! How can I help you today?
# All other values (Twilio credentials, TAC config, etc.) stay the same
```

### 7. Install and run

```bash
npm install
npm run dev
```

---

## Project Structure

A typical agent project looks like this:

```
demos/my-agent/
├── src/
│   ├── index.ts              # Entry point — calls createApp()
│   ├── prompts/
│   │   └── systemPrompt.ts   # Agent persona and guidelines
│   └── tools/
│       └── index.ts          # Agent-specific tools
├── .env                      # Environment config
├── package.json
└── tsconfig.json
```

That's it. Everything else — TAC setup, channel management, memory injection, LLM providers, webhook handling — comes from the template.

---

## What You Can Customize

| Aspect | How | Where |
|---|---|---|
| **Persona** | Change the system prompt | `src/prompts/systemPrompt.ts` |
| **Business logic** | Add/remove tools | `src/tools/index.ts` |
| **Voice greeting** | Pass `welcomeGreeting` to `createApp()` | `src/index.ts` |
| **Voice language** | Pass `defaultLanguage` to `createApp()` | `src/index.ts` |
| **Dynamic context** | Pass `additionalContext` function to `createApp()` | `src/index.ts` |
| **Dynamic tools** (per-conversation) | Pass `buildDynamicTools(tac)` to `createApp()` | `src/index.ts` |
| **Session-bound tools** (per-turn) | Pass `buildSessionTools(tac, session)` to `createApp()` | `src/index.ts` |
| **LLM provider** | Set `LLM_PROVIDER` in `.env` | `.env` |
| **LLM model** | Set `LLM_MODEL` in `.env` | `.env` |
| **Messaging mode** | Set `MESSAGING_MODE` in `.env` | `.env` |

## What You Inherit (No Code Needed)

- TAC initialization and configuration
- Voice channel (ConversationRelay WebSocket)
- WhatsApp and SMS channels (Maestro mode)
- Conversations v1 handler (conversations-v1 mode)
- Customer memory retrieval (Memora)
- Profile trait injection
- Webhook deduplication and validation
- Typing indicators (WhatsApp)
- Human agent handoff (Flex / Interactions API)
- Graceful shutdown

---

## Reusing Template Tools

You can import tools from the template instead of redefining them:

```typescript
import {
  humanAgentHandoffTool,
  switchLanguageTool,
  bookDriverTool,
} from 'conversation-relay-tac/tools';
```

Mix template tools with your own:

```typescript
export const allTools: TACTool[] = [
  // Your custom tools
  checkOrderStatus,
  initiateReturn,
  // Template tools
  humanAgentHandoffTool,
  switchLanguageTool,
];
```

---

## Adding a Custom LLM Provider

The template ships with three OpenAI providers. If your agent needs a different provider (e.g., Anthropic Claude), you can create one that implements the `LLMProvider` interface:

```typescript
import type { LLMProvider, ToolAction } from 'conversation-relay-tac/providers/types';
import type { TACTool } from 'twilio-agent-connect';

export class MyCustomProvider implements LLMProvider {
  private lastAction?: ToolAction;

  async *streamResponse(
    message: string,
    tools: TACTool[],
    signal: AbortSignal
  ): AsyncIterable<string> {
    // Yield tokens for voice streaming
  }

  async generateResponse(message: string, tools: TACTool[]): Promise<string> {
    // Return complete response for messaging
  }

  addSystemContext(content: string): void {
    // Store system context for the LLM
  }

  getLastAction(): ToolAction | undefined {
    return this.lastAction;
  }

  clearLastAction(): void {
    this.lastAction = undefined;
  }
}
```

Then update the factory or pass it directly — the `createApp()` function uses the `LLM_PROVIDER` env var to select a provider via the factory.

---

## Sharing a Twilio Account Across Agents

Multiple agents can share the same Twilio account, phone numbers, and Flex environment. The `.env` controls which agent is active:

- **Same phone number**: Only one agent can be active per phone number at a time (the webhook points to one server)
- **Different phone numbers**: Multiple agents can run simultaneously on different ports, each with its own phone number configured in Twilio
- **Same Flex**: All agents share `TWILIO_WORKFLOW_SID` and `TWILIO_WORKSPACE_SID` for handoffs
- **Same Maestro**: All agents share `CONVERSATION_SERVICE_ID` and `MEMORY_STORE_ID` — Memora profiles are phone-number based, so customer memory persists across agents

---

## Checklist for a New Agent

- [ ] Create directory under `demos/`
- [ ] Write system prompt in `src/prompts/systemPrompt.ts`
- [ ] Define tools in `src/tools/index.ts`
- [ ] Create `src/index.ts` that calls `createApp()`
- [ ] Copy `.env` from template, adjust greeting and any agent-specific values
- [ ] `npm install && npm run dev`
- [ ] Configure Twilio phone number webhook to point to your ngrok URL
- [ ] Test voice, WhatsApp, and handoff (if applicable)
