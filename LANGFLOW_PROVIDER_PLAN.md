# Langflow Provider — Integration Plan

> **Status:** DRAFT. Not yet implemented. This document captures the design *before* writing code so we can review it, push back on choices, and amend before the implementation lands.

## Goal

Add Langflow as a fourth `LLMProvider` implementation alongside the existing OpenAI Chat Completions / Responses / Agents providers, so adopters can use a visual flow editor as the LLM brain while keeping every other piece of TAC: channel handling, voice ConversationRelay streaming, memory recall pipeline, debouncing, eager typing indicator, inbound media side-channel, conversation continuity.

The integration must be **purely additive** — existing providers and existing adopters keep working with zero behavior change.

## Why this is feasible

Three findings from a recent Langflow blog post and SDK review:

1. `@datastax/langflow-client` exposes `flow.run(prompt, { session_id })` (non-streaming) and `flow.stream(prompt, { session_id })` (token-streaming).
2. Streaming emits chunks of shape `{ event: 'token', data: { chunk: string } }` and a terminal `{ event: 'end' }`. That maps directly onto our existing `LLMProvider.streamResponse` contract (`AsyncIterable<string>`).
3. Our [`bufferAtWordBoundaries`](src/providers/streamBuffer.ts) wrapper is provider-agnostic — any source of sub-word deltas works. Langflow's stream slots in unchanged.

## Design decisions (already taken)

### 1. Tools live in the flow, not in TAC

TAC's `tools` array (the second argument to `generateResponse` / `streamResponse`) is **ignored** by the Langflow provider. Any tools the flow needs must be defined as Langflow components inside the flow.

- **Why**: bridging TAC's tool registry into Langflow's tool-node system would require a callback protocol for the flow to invoke TAC's tools. That's a substantial design (definition translation, dispatch RPC, schema mapping, side-effect plumbing for `getLastAction`) and out of scope for v1.
- **Consequence**: adopters using `LLM_PROVIDER=langflow` will not get the OOTB tools the OpenAI providers receive (`createKnowledgeTools`, `createStudioHandoffTool`). We document this clearly. If they want those behaviors, they re-implement them inside the flow.

### 2. Memory is injected as prepended context, not via a flow node

TAC's memory recall pipeline (`MEMORY_RECALL_MODE`) already runs before each LLM call and supplies memory to the provider through repeated `addSystemContext(...)` calls. The Langflow provider concatenates all accumulated context blocks and **prepends them to the user prompt** as a labeled header before passing to `flow.run` / `flow.stream`.

- **Why TAC-owned, not flow-owned**: the recall pipeline is non-trivial (memory mode handling, address-based profile fallback, MemoryPromptBuilder formatting). Replicating that inside every adopter's flow would be wasteful and inconsistent.
- **Why prepending, not Langflow `tweaks`**: prepending is universal — it works regardless of how the customer designed their flow's Prompt component. `tweaks` requires the flow to expose a context variable, which we can't assume.
- **Future**: a `langflow-twilio-memora` custom component package could provide flow-owned memory retrieval for adopters who want it. Not in v1.

### 3. Knowledge is a flow concern, not TAC's

Unlike memory (proactively fetched every turn before the LLM runs), Knowledge search is invoked **by the LLM** when it judges a search is needed — i.e., it's a tool call. Since "tools live in the flow" (decision 1), Knowledge access is also a flow concern.

Three options the adopter has, none of which involve TAC's `KnowledgeClient`:

- Call Twilio's Knowledge API from a generic HTTP node inside the flow.
- Use Langflow's built-in vector store nodes with their own dataset.
- (Future) Use a `langflow-twilio-knowledge` custom component package.

### 4. Session continuity uses TAC's `conversationId`

Both Langflow APIs accept `session_id`. We pass TAC's `conversationId` — the Maestro `conv_conversation_*` ID. This yields:

- Cross-channel continuity under `GROUP_BY_PROFILE` (voice + WhatsApp on the same conversationId share Langflow session state).
- Langflow's built-in Chat Memory component, if used, picks up the right turn history.

### 5. Voice streaming uses `bufferAtWordBoundaries` unchanged

No special handling for sub-word Langflow chunks. The existing word-boundary buffer at the call site in [`src/app.ts`](src/app.ts) consumes any `AsyncIterable<string>` and produces clean whole-word chunks for ConversationRelay TTS.

### 6. `addSystemContext` accumulates; nothing is dropped

The provider holds a `string[]` of context blocks. Every call to `generateResponse` / `streamResponse` joins them with `\n\n` separators and prepends to the user message, exactly matching the OpenAI providers' "context grows over the conversation" behavior. No deduplication, no replacement — that's consistent with the rest of the providers and avoids subtle differences.

### 7. Tool actions (handoff, language switch, end interaction) are not detectable in v1

The OpenAI providers detect these via the LLM's structured tool-call output and surface them through `getLastAction()`. With tools-in-flow, we can't observe tool calls inside the flow. First pass: `getLastAction()` always returns `undefined`. Documented limitation.

A future v2 protocol could have the flow emit a structured token (e.g., `<<HANDOFF:reason>>`) that the provider parses out of the stream — but that's fragile and we're not designing it now.

## Provider construction needs a small factory change

The current `createLLMProvider()` factory takes no arguments. The Langflow provider needs the `conversationId` for `session_id` mapping (decision 4). The smallest change that supports this:

```ts
// before
export async function createLLMProvider(): Promise<LLMProvider>

// after
export async function createLLMProvider(conversationId?: string): Promise<LLMProvider>
```

- The OpenAI providers ignore the parameter — no behavior change for them.
- The Langflow provider captures it in its constructor closure.
- `app.ts:getProvider` already has `conversationId` in scope and just passes it through.

This is a tiny change but it's the only modification to the shared interface seam.

## File-by-file work

### New files

| File | Purpose |
|---|---|
| [`src/providers/langflow.ts`](src/providers/langflow.ts) | The provider implementation. Exports `LangflowProvider` class implementing `LLMProvider`. |

### Modified files

| File | Change |
|---|---|
| [`src/providers/factory.ts`](src/providers/factory.ts) | Add `langflow` case. Change signature to `createLLMProvider(conversationId?: string)`. |
| [`src/app.ts`](src/app.ts) | One-line change in `getProvider` to pass `conversationId` into `createLLMProvider`. |
| [`src/config.ts`](src/config.ts) | Add `langflow.baseUrl`, `langflow.flowId`, `langflow.apiKey` env-var wiring. Extend the `provider` enum to include `'langflow'`. |
| [`.env.example`](.env.example) | Add `LANGFLOW_BASE_URL`, `LANGFLOW_FLOW_ID`, `LANGFLOW_API_KEY` with comments. |
| [`package.json`](package.json) | Add `@datastax/langflow-client` dependency. |
| [`README.md`](README.md) | Add `langflow` row to the LLM Providers table; add a "Using Langflow" section covering tools-in-flow, memory-as-context, streaming setup, the limitations. |

### Dependencies

- `@datastax/langflow-client`, latest stable, pinned exactly. Small surface area; one library to vet.

## Provider interface mapping (concrete)

### Constructor

```ts
new LangflowProvider(conversationId?: string)
```

- Captures `conversationId` for use as `session_id`.
- If `conversationId` is undefined (shouldn't happen in normal use), generates a UUID fallback so the SDK call doesn't fail.
- Reads `config.langflow.{baseUrl, flowId, apiKey}` to construct the underlying `LangflowClient` and `flow` handles.

### `addSystemContext(content: string)`

```ts
this.systemContext.push(content);
```

No formatting, no normalization. Matches other providers.

### Internal: `buildPrependedPrompt(userMessage)`

```ts
const ctx = this.systemContext.length > 0
  ? `[Context]\n${this.systemContext.join('\n\n')}\n\n[Message]\n`
  : '';
return ctx + userMessage;
```

Clear delimiter so the flow's LLM can recognize the context block as system instruction-level material vs the actual user input.

### `generateResponse(userMessage, _tools, signal?)`

- `tools` argument ignored.
- Build prepended prompt.
- `await this.flow.run(prepended, { session_id: this.conversationId })`.
- Return `response.chatOutputText()`. If empty, log a warning and return an empty string (matching other providers' behavior — TAC's downstream code handles empty responses).
- `signal`: if SDK supports `AbortSignal`, pass through. Otherwise, log a TODO and ignore. Document.

### `streamResponse(userMessage, _tools, signal?)`

- `tools` argument ignored.
- Build prepended prompt.
- Async generator:
  ```ts
  const stream = await this.flow.stream(prepended, { session_id: this.conversationId });
  for await (const chunk of stream) {
    if (signal?.aborted) return;
    if (chunk.event === 'token') yield chunk.data.chunk;
    if (chunk.event === 'end') return;
    // chunk.event === 'error' or unexpected: throw or log + break
  }
  ```
- The `for await ... yield` shape produces an `AsyncIterable<string>` that the voice path wraps in `bufferAtWordBoundaries`.

### `getLastAction()`, `clearLastAction()`

```ts
getLastAction(): undefined { return undefined; }
clearLastAction(): void { /* no-op */ }
```

First pass. Documented limitation.

## What we are explicitly NOT doing

- ❌ No tool registry bridge between TAC and Langflow. Tools are flow-owned.
- ❌ No `langflow-twilio-memora` custom component. TAC injects memory as context.
- ❌ No `langflow-twilio-knowledge` custom component. Flow owns search.
- ❌ No structured action emission protocol for handoff / language switch / end interaction.
- ❌ No demo wiring. Adopters who want to try Langflow just flip the env var; if they want to ship a Langflow-based demo, they fork the template and build it.
- ❌ No reference Langflow flow shipped with the template. Flows are customer artifacts.

## Open questions

1. **AbortSignal support in `@datastax/langflow-client`** — does it accept a signal for `run` / `stream`? If not, voice interrupts will continue streaming briefly. Need to read the SDK source before implementation; document the behavior either way.
2. **Stream error event shape** — exact shape of `chunk.event === 'error'` not visible in the blog. Need to handle robustly with `try/catch` and log meaningfully.
3. **Empty `chatOutputText`** — what shape does the response have if the flow misroutes and returns nothing? Guard with a default + warning log.
4. **`conversationId` undefined fallback** — should we throw at construction, or fall back to a UUID? Falling back is safer (no crashes), but the warning log helps the adopter notice.

## Acceptance criteria

The provider is "done" when all of these hold:

1. Setting `LLM_PROVIDER=langflow` and the three env vars is sufficient to run the template against a working Langflow flow.
2. Voice calls stream tokens through `bufferAtWordBoundaries` without modification, with audible quality equivalent to the OpenAI providers (assuming the customer enabled streaming in their flow's model component).
3. Messaging (WhatsApp / SMS) responses come back cleanly via `flow.run`.
4. Memory recall modes (`always`, `never`, `first-prompt`) all work — the provider observes the memory pipeline via accumulated `addSystemContext` calls and prepends correctly.
5. Channel awareness injection works — the provider sees `Current communication channel: <channel>` as context.
6. Conversation continuity via `conversationId` as `session_id` — multi-turn conversations within a Langflow flow using its Chat Memory component return context-aware responses.
7. README clearly states the limitations: tools-in-flow, no handoff via Langflow first-pass, streaming setup required in flow's model component.
8. `npm run build` succeeds.
9. `npm run dev` starts the app with `LLM_PROVIDER=langflow` and connects to a live Langflow flow.
10. All existing tests / existing providers continue to behave exactly as before.

## Out of scope (future work, captured for memory)

- Custom Langflow components: `langflow-twilio-memora`, `langflow-twilio-knowledge`. Worth open-sourcing as standalone packages once we have one. Both would be small (~150-300 LOC Python each).
- Structured action emission from flow → TAC (handoff signal, etc.).
- Tools-in-TAC with flow-callback dispatch (the harder bridge).
- A reference Langflow flow shipped with the template (template stays code-only; flows are customer-owned artifacts).
- Flow versioning / GitOps recommendations (a separate "deploying Langflow flows" doc; not part of this provider).
