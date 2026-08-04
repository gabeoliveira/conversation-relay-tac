# Humanizing AI Agents on Twilio Agent Connect

**Audience:** customers and partners building conversational AI on TAC who want
agents that feel like a competent person — not a chat-completion endpoint with
a phone number wired to it.

Twilio Agent Connect gives you a lot for free: a WebSocket session lifecycle,
Maestro/Memora API clients, channel abstractions, webhook validation,
ConversationRelay TTS, and the right plumbing between LLM and customer. What
**TAC does not do for you** is shape the *texture* of the conversation —
pacing, prosody, deduplication, recovery from out-of-band content, knowing when
to stay quiet. Those choices live in your application code, and skipping them
is the single biggest reason demos feel like demos.

This document collects the patterns this template applies on top of TAC, why
each one matters, and how to port them into your own deployments. It is not
exhaustive — treat it as a starting checklist.

---

## TL;DR — the playbook

| # | Pattern | Channel | Why it matters | Lives in |
|---|---|---|---|---|
| 1 | **Clause-boundary streaming** | Voice | Removes TTS stuttering, fixes non-English digraph pronunciation, and makes voice robust to per-model streaming cadence | [src/providers/streamBuffer.ts](src/providers/streamBuffer.ts) |
| 2 | **Message debouncing** | Messaging | Combines rapid-fire customer messages into one LLM turn instead of two half-formed replies | [src/app.ts](src/app.ts) (`debounceStates` / `fireDebounce`) |
| 3 | **In-flight serialization** | Messaging | New messages mid-turn don't trigger a parallel reply — they're appended and run next | [src/app.ts](src/app.ts) (`inFlight` flag) |
| 4 | **Eager typing indicator** | WhatsApp | Customer sees "typing…" within ~50ms, before the debounce window opens | [src/app.ts](src/app.ts) (`sendWhatsAppTypingIndicator`) |
| 5 | **Channel awareness** | All | Same conversation across voice and messaging — the LLM gets the current channel so it adapts style (no markdown in TTS, no Portuguese number-spelling in WhatsApp) | [src/prompts/](src/prompts/) + dynamic context |
| 6 | **Interrupt-aware context** | Voice | If the customer barges in, the LLM is told what they *actually heard*, not what was generated | [src/app.ts](src/app.ts) (`onInterrupt`) |
| 7 | **Webhook deduplication** | Messaging | Maestro delivers `COMMUNICATION_CREATED` at-least-once; without dedup the agent answers the same message twice | TAC server (built-in) |
| 8 | **Side-channel for inbound media** | WhatsApp | Conversation Orchestrator drops media attachments; transcribed audio and described images get re-injected as customer messages | [src/messaging/](src/messaging/) |
| 9 | **Profile-aware greetings** | All | Use `firstName` from Memora — no `"Hi, I'm your assistant. What's your name?"` when you already have it | System prompt + memory injection |
| 10 | **Concise turns + no-content guardrails** | All | Walls of text and unprompted "Is there anything else?" feel robotic. Keep replies short; let the customer drive | System prompt + max tokens |

The rest of this document explains each pattern in detail.

---

## 1. Clause-boundary streaming (voice TTS)

### The problem

OpenAI's streaming APIs — and most LLM providers — emit deltas as sub-word
fragments, often 1–3 characters at a time, and *how burstily* they do so varies
by model. Forward each delta directly to ConversationRelay and three distinct
things go wrong:

- **Stuttering at chunk boundaries.** TTS engines have to coalesce sub-word
  tokens on the fly. At chunk boundaries the audio can repeat or drop
  phonemes — the classic "h-h-hello".
- **Mispronunciation of digraphs in non-English languages.** TTS applies
  grapheme-to-phoneme rules per chunk. When `manhã` arrives as `man` + `hã`,
  the engine has already committed to /n/ for the `n` before the `h` arrives
  — so you get /man.ha/ instead of the correct /ma.ɲɐ̃/. Same family of
  problems for Portuguese `nh`/`lh`/`ch`/`rr`, Spanish `ll`/`rr`, French
  `gn`/`ch`, English `th`/`sh`/`ph`.
- **Per-model cadence sensitivity.** A smaller/faster model often streams
  choppier — higher inter-token-latency variance, more fragmented punctuation
  — so word-at-a-time forwarding becomes per-word stutter that a smoother model
  wouldn't show, even though the model never touches TTS.

### The fix

Wrap the LLM stream in an async generator that buffers until the next
clause/sentence boundary (`. , ; : ! ? …` or newline), then yields a whole
clause — with a word-boundary fallback so a long comma-less run never stalls.
Feeding the TTS whole clauses instead of single words makes voice smoothness
robust to per-model streaming cadence. Implementation:
[src/providers/streamBuffer.ts](src/providers/streamBuffer.ts)
(`bufferAtClauseBoundaries`; the older `bufferAtWordBoundaries` stays as the
fallback).

Applied once at the voice call site in
[src/app.ts](src/app.ts) so any provider — OpenAI Responses, Chat Completions,
the Agents SDK, Anthropic, local LLMs — benefits without per-provider code:

```ts
await voiceChannel.sendStreamingResponse(
  conversationId,
  bufferAtClauseBoundaries(
    provider.streamResponse(message, callTools, signal)
  ),
  { signal }
);
```

Messaging channels skip the wrapper entirely (they call `generateResponse`,
not the streaming path), so markdown/emoji output on WhatsApp is unaffected.

### Cost / benefit

- **Cost:** up to one clause of buffering — usually sub-second. Adds a little to
  time-to-first-audio vs. word buffering; instrument it with
  `VOICE_LATENCY_DEBUG=true` (logs the first-token→first-flush wait).
- **Benefit:** dramatically smoother TTS, robust across models, plus correct
  pronunciation for any non-English voice deployment.

### When you can skip it

Never, for voice. The clause wait is small and bounded (the word-boundary
fallback caps the worst case), and the quality delta — smoothness +
cadence-robustness + pronunciation — is always positive. We considered making it
optional and decided no.

---

## 2. Message debouncing

### The problem

Default flow is 1:1 — every inbound `onMessageReady` triggers an LLM call and
a reply. That breaks down the moment a customer types like a normal human:

> 16:42:01 — `"oi"`
> 16:42:01 — `"preciso de ajuda com o pedido 1234"`

Without debounce, the first message kicks off an LLM call that says "Olá! Como
posso te ajudar?" — by the time it's sent, the second message has arrived and
triggers a *second* LLM call, which now has to apologize for the half-formed
greeting and pivot to the actual question. Two API calls, two replies, one
confused customer.

### The fix

Per-conversation debounce window for messaging only. Default `2000ms`,
configurable via `MESSAGE_DEBOUNCE_MS`. Implementation lives in
[src/app.ts](src/app.ts) (`debounceStates` map + `fireDebounce`):

```ts
state.buffer.push(params.message);
if (!state.inFlight) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => fireDebounce(convKey), config.messageDebounceMs);
}
```

When the window goes quiet, the buffered messages are joined with `\n` and
run as a single LLM turn — the model sees both `"oi"` and the follow-up at
the same time and answers the *real* question without the false start.

### Voice is excluded

ConversationRelay's WebSocket handles natural turn-taking via barge-in and
speech endpointing. Adding a debounce on top would be audible as a hesitation
before every reply. Voice never enters the debounce path; the `voice`
channel branch short-circuits to `processMessageTurn` directly.

### Tuning

- **`2000ms`** is the default and a good starting point for WhatsApp /
  SMS / chat.
- Drop to **`1500ms`** if you get feedback that single-message customers
  feel the agent is slow to respond.
- Going below `1000ms` defeats the purpose — most rapid-fire bursts have
  natural pauses of 800–1500ms between messages.

---

## 3. In-flight serialization

### The problem

Debouncing handles the case where messages arrive *before* an LLM call starts.
But what if a customer sends a third message *while* the LLM is generating?

If you naively start a parallel LLM call you get two interleaved replies and
a contradictory conversation log. If you drop the message you've silently
lost customer input.

### The fix

The same per-conversation state machine has an `inFlight` flag:

```ts
state.inFlight = true;
try {
  await processMessageTurn(combined, state.lastParams);
} finally {
  state.inFlight = false;
  // If new messages arrived during processing, reschedule.
  if (state.buffer.length > 0) {
    state.timer = setTimeout(() => fireDebounce(convKey), config.messageDebounceMs);
  }
}
```

While `inFlight === true`, new messages append to the buffer but **do not**
arm a new timer. The moment the current turn finishes, the `finally` block
sees a non-empty buffer and reschedules — so the next turn picks up everything
that arrived during the previous one.

### Why not just queue everything

Could you serialize all turns via a per-conversation `Promise` chain? Yes.
The debounce + in-flight pattern is slightly more deliberate: it gives the
customer a 2s window to finish typing *after* the agent stops responding
before the next turn kicks off, which matches how WhatsApp conversations
actually flow.

---

## 4. Eager typing indicator (WhatsApp)

### The problem

Even with debouncing, there's a 2-second window between the customer hitting
send and the agent's reply starting to stream. Two silent seconds in a
messaging UI feels like the bot is ignoring them — they often send another
message ("alô?"), which arrives in the middle of generation and breaks
serialization.

### The fix

Fire the WhatsApp typing indicator **immediately on every inbound message**,
before the debounce window opens. Implementation: `sendWhatsAppTypingIndicator`
in [src/app.ts](src/app.ts).

```ts
if (channel === 'whatsapp' && session.authorInfo?.address?.startsWith('whatsapp:')) {
  sendWhatsAppTypingIndicator(session.authorInfo.address);
}
```

The indicator is sticky for ~25 seconds in WhatsApp. Re-firing on each
inbound message refreshes the window, so customers see "typing…" the entire
way through a debounced burst *and* the LLM call.

### Channel coverage

- **WhatsApp**: Twilio's Programmable Messaging API exposes a typing
  indicator endpoint (`POST /v2/Indicators/Typing.json`). Used here.
- **SMS**: No protocol-level typing indicator. Nothing you can do at the
  network level — keep replies short instead.
- **Chat / RCS**: Vary by client. RCS supports `IS_TYPING` events but
  Twilio's surface for it is limited at the time of writing.
- **Voice**: ConversationRelay's TTS starts streaming as soon as the LLM
  yields its first token — no equivalent needed.

### Implementation note

The typing endpoint requires a `messageId` of a recent inbound message. The
template fetches the latest inbound message via
`GET /2010-04-01/Accounts/{sid}/Messages.json?From=<customer>` with
`PageSize=1`. Fire-and-forget on error — a missed indicator is never worth
blocking the actual reply.

---

## 5. Channel awareness

### The problem

A reply that works in WhatsApp doesn't work on voice:

> **WhatsApp (good):**
> ✅ Pedido #1234 saiu para entrega às **14:30**.
> Motorista: João — placa ABC-1234.
>
> **Voice (bad — same text spoken via TTS):**
> "Tick pedido número um dois três quatro saiu para entrega às catorze
> dois pontos três zero. Asterisco asterisco Motorista..."

Markdown, emojis, numerics, and special characters that read fine in a
chat bubble are pronounced literally by TTS.

### The fix

The system prompt has a **"Channel Awareness"** section that the LLM reads
on every turn, plus a dynamic `Current communication channel: <channel>`
message injected before each LLM call. The channel value is the same one
TAC passes to `onMessageReady` (`voice` / `whatsapp` / `sms` / `chat`).

The canonical pattern in the sample prompts instructs:

- **`voice`** — no markdown, no asterisks, no emojis. Spell out long
  numbers. Short conversational sentences.
- **`whatsapp` / `sms` / `chat`** — light markdown and emojis OK, digits
  written normally, lists welcome.

### Why one prompt, not two

GROUP_BY_PROFILE in Maestro lets the same conversation span channels —
customer calls in, gets disconnected, picks back up on WhatsApp. Same
`conversationId`, same memory, same provider instance. A single prompt
with channel-conditional rules keeps state coherent across the switch;
two separate prompts would require restarting the provider every time.

---

## 6. Interrupt-aware context (voice)

### The problem

On voice, a customer can barge in (interrupt the agent mid-sentence).
ConversationRelay cuts the TTS, but the LLM's *internal* message history
still contains the full generated response. If the customer interrupted
halfway through "...so the total is going to be R$ 1,247 plus shipping..."
and asked "wait, how much was that?", the LLM thinks the customer already
heard the full number — it'll just say "as I mentioned, R$ 1,247" and
the customer will be confused.

### The fix

TAC fires `onInterrupt` with `utteranceUntilInterrupt` — the portion of the
response that actually reached the customer before they cut in. Inject it
as a system context note so the next turn reasons correctly:

```ts
tac.onInterrupt(async ({ conversationId, utteranceUntilInterrupt }) => {
  if (utteranceUntilInterrupt) {
    provider.addSystemContext(
      `[Interruption] The customer interrupted you. They only heard:
      "${utteranceUntilInterrupt}". They did NOT hear the rest of your
      response. Adjust your next reply accordingly.`
    );
  }
});
```

Now when they ask "how much?", the LLM knows the number never made it across
and can repeat it cleanly.

---

## 7. Webhook deduplication

### The problem

Maestro delivers `COMMUNICATION_CREATED` *at-least-once*. Under load — or
when your webhook responds slowly — Maestro retries. Without dedup, the
same customer message triggers two LLM calls and two replies.

### The fix

TAC server tracks recently-seen `data.id` values in a Set and silently
ignores redelivery. **You get this for free** as a customer of this
template — no code to write. Architectural details in
[ARCHITECTURE.md](ARCHITECTURE.md#tac-package-customizations).

### What you still need to handle

- **Conversations v1 mode** uses a different webhook envelope. The v1
  handler in [src/channels/conversations-v1.ts](src/channels/conversations-v1.ts)
  does its own filtering (system messages, bot self-messages).
- **Inbound media webhook** (`POST /inbound-message`) does not currently
  dedup by `MessageSid`. Twilio Programmable Messaging is at-least-once
  too — if you observe duplicate transcriptions in production, add a
  bounded Set similar to the Maestro path.

---

## 8. Side-channel for inbound media

### The problem

Twilio Conversation Orchestrator's documentation is explicit:

> Communications support text and template messages. Media attachments on
> inbound or outbound WhatsApp messages aren't added to the conversation.

So when a customer sends an audio voice note or a photo of a damaged
package, *nothing* enters CO. The LLM doesn't see it, Memora doesn't extract
observations from it, Conversation Intelligence operators don't run on it.
The customer thinks the agent ignored them.

### The fix

Register a **second webhook** that bypasses CO and consumes the underlying
Programmable Messaging webhook directly. Enabled via `INBOUND_MEDIA_ENABLED=true`:

```
WhatsApp inbound media
    │
    ▼
POST /inbound-message  (Programmable Messaging webhook — NOT a CO webhook)
    │
    ├─ audio/*  → Whisper transcription   → [áudio transcrito] <text>
    ├─ image/*  → OpenAI vision description → [imagem recebida] <description>
    └─ other    → log and skip
    │
    ▼
insertCommunication() → POST /v2/Conversations/{id}/Communications
    │
    ▼
COMMUNICATION_CREATED fires → TAC's onMessageReady → agent processes as normal turn
                            → CI operators run on the text
                            → Memora extracts observations
```

From CO's, Memora's, CI's, and the LLM's perspective the media "is" a
customer message. The application boundary owns transcription/description;
the platform owns insight extraction.

Implementation:
- [src/messaging/inboundMediaWebhook.ts](src/messaging/inboundMediaWebhook.ts)
  — webhook handler with content-type dispatch
- [src/messaging/transcribeAudio.ts](src/messaging/transcribeAudio.ts)
  — Whisper wrapper
- [src/messaging/describeImage.ts](src/messaging/describeImage.ts)
  — OpenAI vision wrapper
- [src/messaging/insertCommunication.ts](src/messaging/insertCommunication.ts)
  — re-injection into CO

### Why prefixes matter

The agent sees `[áudio transcrito] tô precisando saber do pedido` or
`[imagem recebida] Paracetamol 500mg, embalagem violada` as inbound
customer messages. The prompt tells it how to interpret each prefix
(treat audio transcription as customer speech; treat image description as
analysis of something the customer sent, not as their own words). Without
the prefix, the agent might think the customer literally wrote "Paracetamol
500mg, embalagem violada" — which changes the appropriate response.

See the "Conteúdo Multimídia do Cliente" section of the canonical prompt for the reference wording.

### Cost

- Whisper: ~$0.006 / minute of audio
- gpt-4o-mini vision: ~$0.0001 / image
- One extra webhook endpoint, opt-in via flag

Off by default. Don't pay for it on text-only deployments.

---

## 9. Profile-aware greetings

### The problem

Nothing announces "this is a bot" faster than:

> Hi! I'm your assistant. To better help you, could I get your name and
> phone number, please?

You already have both. The phone number is in the inbound message
envelope; the name is one Memora profile lookup away. Asking is friction
that proves you don't know your customer.

### The fix

TAC's `MemoryPromptBuilder` already injects the profile traits as a system
message. The job in the system prompt is to **tell the model to use it**:

```markdown
## Identidade do Cliente
- O perfil do cliente já está disponível no seu contexto via Memora.
  Nome, telefone, e histórico de interações anteriores estão lá.
- Sempre cumprimente e se dirija ao cliente pelo **primeiro nome**
  (do `customerName` ou dos traits de perfil no contexto). Não use o
  nome completo a menos que o cliente peça.
- **Não pergunte** o nome do cliente — você já tem.
```

This template also injects the customer phone explicitly so tools that
need it (`list_customer_orders`, `list_customer_tickets`) don't have to
ask either:

> Use the phone of the customer that's in the conversation context
> (`Customer phone:` in messages, or the number in `Call Context` in
> calls). **Don't ask** for the phone — you already have it.

### When the profile is missing

For first-time callers Memora has no profile yet. The prompt should
fall back gracefully — greet without a name, ask only if the customer's
request requires it (delivery address, account lookup). Don't *demand*
identification just to start.

---

## 10. Concise turns + no-content guardrails

### The problem

Default LLM behavior is to fill silence. Without constraints you'll see:

> Of course! I'd be happy to help you with that. Let me check the
> details of your order for you. Looking up your order now...
>
> I can see that your order #1234 was placed on March 15th, 2026 and
> contains 2 units of Paracetamol 500mg, manufactured by Pharma Inc.,
> with an expected delivery date of March 18th, 2026, and a current
> status of "In Transit". The delivery driver is João, license plate
> ABC-1234, currently routing through the metropolitan São Paulo area.
>
> Is there anything else I can help you with today? Don't hesitate to
> ask if you have any other questions or concerns!

That's three paragraphs to answer "where's my order?". On voice it's 25
seconds of TTS the customer wants to interrupt. On WhatsApp it's a wall
the customer has to read.

### The fix

Three levers:

1. **Cap output tokens.** This template defaults to
   `OPENAI_MAX_COMPLETION_TOKENS=150` — about 2-3 sentences. Hard ceiling,
   model can't go past it.

2. **Tell the model the channel.** The "Channel Awareness" section in the
   prompt explicitly says:
   > Mantenha respostas curtas — longas paragráfas cansam quem ouve.
   > […]
   > Ainda assim, prefira respostas concisas — paredes de texto cansam de
   > ler também.

3. **Forbid filler.** Remove "Of course!", "I'd be happy to help", "Is
   there anything else?" via explicit prompt rules. The customer asked
   a question — answer it.

### Tradeoff

A 150-token cap is aggressive. Some legitimately complex answers will get
cut off. The right answer is rarely "raise the cap" — it's "have the LLM
ask a clarifying question instead of dumping a kitchen-sink response", or
"break the answer into a follow-up turn that the customer drives by asking
for more detail." Force the model to be a conversation partner, not a
report generator.

---

## What's NOT in this list (and why)

- **Punctuation normalization.** ConversationRelay handles intonation
  fairly well from punctuation. Pre-processing the LLM output (adding
  commas, breaking long sentences) is high effort for marginal gain.
  Spend the budget on prompt quality first.
- **Sentiment-aware tone.** Building real-time sentiment detection on top
  of customer messages and shifting agent tone is doable but expensive.
  For most deployments a single consistent professional tone outperforms
  a system that *sometimes* switches well and *sometimes* picks badly.
- **Backchannel sounds.** "Mhm", "uh-huh" between customer sentences feels
  human but is hard to get right without a duplex audio model. Skip until
  you have one.
- **Speech-rate matching.** Matching customer cadence requires a
  pipeline ConversationRelay doesn't currently expose. Skip.

These aren't *wrong* to build — they're just not where the leverage is
for most customers. The 10 patterns above account for the bulk of the
"feels like a bot" → "feels like a person" delta on TAC.

---

## How to evaluate

For each pattern, the test is the same: run a real customer through the
flow, listen/read, and ask:

- "Did the agent stutter or mispronounce a word?" → pattern 1
- "Did the agent answer two messages with two replies?" → patterns 2 & 3
- "Did the customer get bored before the first response arrived?" → pattern 4
- "Did the agent send markdown to TTS or sound stilted on WhatsApp?" → pattern 5
- "Did the agent repeat information the customer already heard?" → pattern 6
- "Did the agent reply twice to one message?" → pattern 7
- "Did the agent ignore audio/image attachments?" → pattern 8
- "Did the agent ask for the customer's name?" → pattern 9
- "Did the agent answer in three paragraphs when one would do?" → pattern 10

If any answer is yes, the corresponding pattern is missing or misconfigured.

---

## Porting this to your own application

If you're not using this template directly, the porting order is:

1. **Clause-boundary streaming** — drop in
   [src/providers/streamBuffer.ts](src/providers/streamBuffer.ts) verbatim and
   wrap your voice stream with `bufferAtClauseBoundaries`. Provider-agnostic.
2. **Channel-aware prompt** — copy the structure from the canonical sample prompt (voice-first channel awareness + multimedia handling sections) and adapt to your domain.
3. **Message debounce + in-flight serialization** — pattern from
   [src/app.ts](src/app.ts) translates directly. Per-conversation state
   keyed by `conversationId`.
4. **Typing indicator** — copy `sendWhatsAppTypingIndicator` from
   [src/app.ts](src/app.ts). Works against Twilio's REST API directly,
   no SDK dependency.
5. **Interrupt context** — one `onInterrupt` callback.
6. **Inbound media side-channel** — opt-in. Implement when you actually
   need audio or image handling.
7. **Concise-turn guardrails** — one env var (`OPENAI_MAX_COMPLETION_TOKENS`)
   and a few lines of prompt.

The first three are the bulk of the win. Get those in before worrying about
the rest.
