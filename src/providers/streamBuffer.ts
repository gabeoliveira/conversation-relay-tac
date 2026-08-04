/**
 * Word-boundary buffer for LLM streaming deltas before they reach
 * ConversationRelay's TTS.
 *
 * OpenAI's streaming APIs can emit single-character or sub-word delta chunks.
 * Forwarding each one as a separate WebSocket text token to ConversationRelay
 * makes the TTS coalesce mid-word, which produces audible stuttering and
 * occasional token repetition at chunk boundaries. Buffering up to a word
 * boundary (whitespace or newline) before yielding gives the TTS clean,
 * speakable chunks.
 *
 * Latency cost: at most one extra delta of buffering — typically a few ms.
 * Quality benefit: removes mid-word artifacts.
 */

/**
 * Append `chunk` to `state.buffer`, then return the longest prefix that ends
 * at a whitespace/newline boundary. The remainder stays in `state.buffer`
 * for the next call.
 *
 * Stateful helper rather than a generator so it can be inlined into existing
 * streaming loops without restructuring them.
 */
export interface BoundaryBufferState {
  buffer: string;
}

export function flushAtWordBoundary(state: BoundaryBufferState, chunk: string): string {
  state.buffer += chunk;
  // Find the latest whitespace; flush everything up to and including it.
  let last = -1;
  for (let i = state.buffer.length - 1; i >= 0; i--) {
    const ch = state.buffer[i];
    if (ch === ' ' || ch === '\n' || ch === '\t') {
      last = i;
      break;
    }
  }
  if (last < 0) return '';
  const ready = state.buffer.slice(0, last + 1);
  state.buffer = state.buffer.slice(last + 1);
  return ready;
}

/**
 * Yield whatever's left in the buffer. Call at end-of-stream so the final
 * partial word ("...ajudar.") doesn't get dropped.
 */
export function drain(state: BoundaryBufferState): string {
  const rest = state.buffer;
  state.buffer = '';
  return rest;
}

/**
 * Async-generator wrapper: takes any `AsyncIterable<string>` (LLM provider
 * stream) and yields the same content but coalesced to word boundaries.
 *
 * Apply once at the voice call site in app.ts so any provider — OpenAI,
 * Anthropic, OpenAI Agents SDK, local LLM — benefits without per-provider
 * code changes. Messaging channels don't go through here (they use
 * `generateResponse`), so message-formatted output is unaffected.
 */
export async function* bufferAtWordBoundaries(
  source: AsyncIterable<string>
): AsyncIterable<string> {
  const state: BoundaryBufferState = { buffer: '' };
  for await (const chunk of source) {
    const ready = flushAtWordBoundary(state, chunk);
    if (ready) yield ready;
  }
  const tail = drain(state);
  if (tail) yield tail;
}

/**
 * Clause-boundary buffer — the preferred variant for voice.
 *
 * Word-boundary buffering removes mid-word artifacts but still feeds the TTS a
 * word at a time, so voice smoothness stays sensitive to how the *model*
 * streams: a burstier model (often a smaller/faster one) or one with choppier
 * punctuation turns into per-word stutter even though it never touches TTS.
 * Flushing at clause/sentence punctuation ( . , ; : ! ? … or newline ) hands
 * the TTS whole speakable clauses, which absorbs per-model cadence differences.
 *
 * Safety valve: if a clause runs long with no punctuation, fall back to a word
 * boundary once the buffer passes `maxChars`, so a comma-less run never stalls
 * the stream.
 *
 * Latency cost vs. word buffering: up to one clause (usually sub-second).
 * Quality benefit: no mid-clause seams; robust across models. See gotcha 10.4.
 */
const CLAUSE_BOUNDARY = /[.,;:!?…\n]/;

export function flushAtClauseBoundary(
  state: BoundaryBufferState,
  chunk: string,
  maxChars = 80,
): string {
  state.buffer += chunk;
  // Latest clause-ending punctuation.
  let last = -1;
  for (let i = state.buffer.length - 1; i >= 0; i--) {
    if (CLAUSE_BOUNDARY.test(state.buffer[i])) {
      last = i;
      break;
    }
  }
  if (last >= 0) {
    // Consume a trailing space too, so the next clause starts clean.
    let end = last + 1;
    if (state.buffer[end] === ' ') end++;
    const ready = state.buffer.slice(0, end);
    state.buffer = state.buffer.slice(end);
    return ready;
  }
  // No punctuation yet — only flush (at a word boundary) once we've buffered a
  // lot, so a long comma-less clause doesn't stall pickup.
  if (state.buffer.length >= maxChars) {
    return flushAtWordBoundary(state, '');
  }
  return '';
}

export async function* bufferAtClauseBoundaries(
  source: AsyncIterable<string>,
): AsyncIterable<string> {
  const state: BoundaryBufferState = { buffer: '' };
  for await (const chunk of source) {
    const ready = flushAtClauseBoundary(state, chunk);
    if (ready) yield ready;
  }
  const tail = drain(state);
  if (tail) yield tail;
}
