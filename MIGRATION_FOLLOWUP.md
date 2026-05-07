# Migration Follow-up

Open work after migrating the template from the patched TAC fork to `twilio-agent-connect@1.0.0` (npm). Items are grouped by intent and roughly ordered by recommended priority within each group.

This list reflects the audit done at migration time — re-validate before tackling each item, since TAC and the template both keep evolving.

## Debugging / correctness

### 1. ~~Investigate why TAC's memory recall returned undefined~~ — **RESOLVED**

Root cause: TAC 1.0.0's channel `memoryMode` default is `'never'`, not `'always'`. Channels instantiated without `{ memoryMode: 'always' }` short-circuit out of `retrieveMemoryIfEnabled` and the callback receives `undefined` for `memory`.

Fix applied: `new VoiceChannel(tac, { memoryMode: 'always' })`, `new SMSChannel(tac, { memoryMode: 'always' })`, `new WhatsAppChannel(tac, { memoryMode: 'always' })` in `src/app.ts`. README "known limitations" section updated to reflect the actual default.

### 2. Delete the orphan empty profile

`mem_profile_01kqz1hg6qf3srzyefvyfsetrc` (or whichever ID exists by then) — auto-created by TAC during the WhatsApp-prefix lookup mismatch. Empty traits, polluting Memora identity index.

```bash
# Once removed: confirm only intentional profiles remain in Gleet-v2
curl -sS "https://memory.twilio.com/v1/Stores/<storeId>/Profiles" -u "$TWILIO_API_KEY:$TWILIO_API_SECRET"
```

## OOTB swaps (drop custom code, gain consistency)

### 3. ~~Replace `injectMemoryContext` with `MemoryPromptBuilder`~~ — **RESOLVED**

`injectMemoryContext` body shrank to a single `MemoryPromptBuilder.build(memory, session)` call. Output now uses TAC's structured markdown sections (Customer Profile, Key Observations, Past Conversation Summaries, Recent Message History). Diagnostic logs preserved. Slice limits moved to retrieval-side env vars (`TWILIO_MEMORY_OBSERVATIONS_LIMIT`, etc.) if the template ever wants to cap them.

### 4. Replace neutralized `triggerHandoff` with `createStudioHandoffTool`

`tac.triggerHandoff(...)` was removed in TAC 1.0.0. The current code path (`src/app.ts` `case 'handoff'`) only logs a TODO/warn for Maestro mode. To restore handoff:

- Add `createStudioHandoffTool(tac, session)` to the LLM tools list (likely in `app.ts` after the session is available, or via a per-conversation tool factory)
- Set `studioHandoffFlowSid` via `TWILIO_STUDIO_HANDOFF_FLOW_SID` env var
- The LLM calls `handoff({ reason })` directly; remove the `case 'handoff'` action-based dispatch from providers/

This also lets you delete the action-based protocol that flows through the providers.

### 5. Verify providers use OOTB tool format conversion

Inspect `src/providers/openai-responses.ts`, `openai-chat-completions.ts`, `openai-agents.ts`. If they hand-roll the OpenAI tool spec, swap to:

- `tool.toOpenAIFormat()` for HTTP API providers (Responses, Chat Completions)
- `await tool.toOpenAIAgentsSDKTool()` for the Agents SDK provider

Removes duplicated conversion logic.

## Best practices (currently missing)

### 6. PII scrubbing in logs

Template logs raw phone numbers (`Customer phone: ${customerPhone}`, the `[TAC] Inbound session` debug log, etc.). TAC ships `maskPhone(phone)`, `maskEmail(email)`, `maskAddress(address)`, `scrubPii(value)`, `scrubObject(obj)`.

Wrap log statements that include customer-derived strings. Cheap, fire-and-forget hygiene win.

### 7. CI Operator → Memory wiring via `OperatorResultProcessor`

TAC ships `OperatorResultProcessor` that ingests Conversation Intelligence operator webhook events and writes them as Memory observations. The template currently has no CI webhook route at all.

Steps:
- Register a route on `server.fastify` for the CI webhook (path defined by your CI configuration in Twilio)
- Instantiate `new OperatorResultProcessor(memoryClient, ciConfig, logger)`
- Pipe the webhook payload through `processor.process(payload)`

Closes the loop on auto-saving customer insights from CI runs into Memora — without manual write code.

### 8. (Optional) `createMemoryTools().forProfile()`

Gives the LLM a tool to *retrieve* memory mid-conversation, in addition to the upfront injection. Useful for long sessions where memory might otherwise be stale.

## Config / observability

### 9. Memora onboarding documentation

Customer-facing note (potentially in `KNOWLEDGE.md` or a new `OPERATIONS.md`):

> When populating Memora `Contact` traits for new customers, set both:
> - `phone = "+E.164"` — canonical, used by SMS / voice / CRM sync
> - `whatsapp = "whatsapp:+E.164"` — Twilio-prefixed, used by TAC's WhatsApp lookup
>
> The prefix isn't optional — Memora indexes `whatsapp:+...` and `+...` as distinct values.
>
> Also: the Memory Store must have `whatsapp` (and optionally `chat`) added to its identity types — older stores ship with just `[email, phone]`.

### 10. Decide on diagnostic logging

Two `console.log` blocks were added during migration debugging:
- `[TAC] Inbound session: profileId=... | hasProfile=... | memoryProvided=...` in `app.ts:onMessageReady`
- `[MemoryContext] ...` in `injectMemoryContext`

Useful for ongoing observability. Either keep as permanent operator-friendly logs, or revert if you'd rather rely on TAC's structured pino output exclusively.

## Future / blocked

### 11. WhatsApp Business Calling pause (Patch 9)

The fork injected `<Pause length="1"/>` before `<Connect>` for `whatsapp:` callers (Meta WhatsApp calling API takes 1-2s to establish audio after SIP connect, clipping the welcome greeting). Currently documented as a known limitation in `README.md`.

If revisited: subclass `VoiceChannel` and override `handleIncomingCall` to inject the pause when `from.startsWith('whatsapp:')`. Project-specific (Meta-only) — not a good upstream PR candidate.

### 12. ConversationRelay schema gaps (Patch 11)

TAC 1.0.0's `ConversationRelayConfigSchema` is missing:
- `deepgramSmartFormat: boolean`
- `speechTimeout: number`
- Widened `reportInputDuringAgentSpeech` (currently boolean-only; spec also accepts `'any' | 'speech' | 'none'`)

Currently documented as a known limitation. If needed:
- File upstream PR (good candidate — these reflect the actual TwiML spec)
- Or `patch-package` as an interim measure

### 13. Upstream PRs to file

Each landing would shrink this followup list. Strong candidates:
- "memoryMode: session" — retrieve memory once per voice conversation rather than every prompt (Patch 3 from the fork)
- ConversationRelay schema widening (Patch 11)
- WhatsApp identity prefix handling — either auto-strip on lookup, or document the prefix expectation
- `info` WebSocket message type (Patch 13)
- Make `MessagingChannel.resolveCustomerProfile` `protected` instead of `private` so customers can override identity-resolution behavior without `patch-package`

## Suggested sequencing

1. (1) Debug memory recall — unblocks real memory context
2. (3, 4) Memory/Handoff OOTB swaps — small, aligned with the "less custom code" direction
3. (6) PII scrubbing — quick hygiene win
4. (7) CI → Memory wiring — meaningful feature add
5. Everything else as backlog
