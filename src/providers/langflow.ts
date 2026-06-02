/**
 * Langflow provider.
 *
 * Lets adopters use a visual Langflow flow as the LLM brain while keeping
 * everything else TAC owns (channels, memory pipeline, voice streaming,
 * debouncing, inbound media side-channel, conversation continuity).
 *
 * Limitations of this first-pass integration — see LANGFLOW_PROVIDER_PLAN.md
 * for full context:
 *
 *   - **Tools live in the flow.** The `tools` argument to generate/stream is
 *     ignored. Anything the flow needs to call must be defined as Langflow
 *     components inside the flow.
 *   - **Memory is prepended as context.** TAC fetches via `MEMORY_RECALL_MODE`
 *     and calls `addSystemContext`; this provider concatenates all blocks and
 *     prepends them to the user prompt. The flow does not need a Memora node.
 *   - **No action detection.** `getLastAction()` always returns undefined.
 *     Handoff / language-switch / end-interaction signals from the flow can't
 *     be observed in this version.
 *   - **Voice streaming requires** the model component in the flow to have
 *     streaming enabled (controls -> Stream switches on).
 */
import { randomUUID } from 'crypto';
import { LangflowClient } from '@datastax/langflow-client';
import type { Flow, StreamEvent } from '@datastax/langflow-client/flow';

import { config } from '../config.js';
import type { LLMProvider, ToolAction } from './types.js';

export class LangflowProvider implements LLMProvider {
  private readonly flow: Flow;
  private readonly sessionId: string;
  private readonly systemContext: string[] = [];

  constructor(conversationId?: string) {
    const baseUrl = config.langflow.baseUrl;
    const flowId = config.langflow.flowId;
    const apiKey = config.langflow.apiKey;

    if (!baseUrl) throw new Error('LANGFLOW_BASE_URL is not set');
    if (!flowId) throw new Error('LANGFLOW_FLOW_ID is not set');
    // apiKey is optional — Langflow allows unauthenticated access in dev.

    const client = new LangflowClient({ baseUrl, apiKey });
    this.flow = client.flow(flowId);

    if (conversationId) {
      this.sessionId = conversationId;
    } else {
      // Falls back to a fresh UUID so the SDK call doesn't error, but warns
      // because losing the conversationId mapping breaks cross-channel /
      // multi-turn continuity for this conversation.
      this.sessionId = randomUUID();
      console.warn(
        `[Langflow] no conversationId provided; falling back to generated session_id=${this.sessionId}`,
      );
    }

    console.log(
      `[Langflow] Initializing provider flowId=${flowId} session_id=${this.sessionId}`,
    );
  }

  addSystemContext(content: string): void {
    this.systemContext.push(content);
  }

  getLastAction(): ToolAction | undefined {
    return undefined;
  }

  clearLastAction(): void {
    /* no-op — see file header */
  }

  async generateResponse(
    userMessage: string,
    _tools: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    const input = this.buildPrependedPrompt(userMessage);
    try {
      const response = await this.flow.run(input, {
        session_id: this.sessionId,
        signal,
      });
      const text = response.chatOutputText();
      if (!text) {
        console.warn(
          `[Langflow] flow returned no chat output for session_id=${this.sessionId}; returning empty string`,
        );
        return '';
      }
      return text;
    } catch (err) {
      console.error(`[Langflow] flow.run failed for session_id=${this.sessionId}:`, err);
      throw err;
    }
  }

  streamResponse(
    userMessage: string,
    _tools: unknown,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    const input = this.buildPrependedPrompt(userMessage);
    const sessionId = this.sessionId;
    const flow = this.flow;

    return (async function* (): AsyncGenerator<string, void, unknown> {
      let stream: ReadableStream<StreamEvent>;
      try {
        stream = await flow.stream(input, { session_id: sessionId, signal });
      } catch (err) {
        console.error(`[Langflow] flow.stream init failed for session_id=${sessionId}:`, err);
        throw err;
      }

      // ReadableStream is async-iterable in modern Node; we iterate it
      // directly. Each chunk is a StreamEvent — only `token` events carry
      // user-visible text. `add_message` events carry the full assembled
      // message (already covered by the token stream) and we ignore them
      // to avoid double-emission. `end` events terminate the iteration.
      try {
        for await (const event of stream) {
          if (signal?.aborted) return;
          if (event.event === 'token') {
            yield event.data.chunk;
          } else if (event.event === 'end') {
            return;
          }
        }
      } catch (err) {
        if (signal?.aborted) return;
        console.error(`[Langflow] stream error for session_id=${sessionId}:`, err);
        throw err;
      }
    })();
  }

  /**
   * Joins all accumulated `addSystemContext` blocks with separators and
   * prepends them to the user prompt under a labeled header so the flow's
   * LLM can distinguish context from user input.
   *
   * Matches the OpenAI providers' accumulate-don't-replace semantics — every
   * call rebuilds the prepended block from the current `systemContext`.
   */
  private buildPrependedPrompt(userMessage: string): string {
    if (this.systemContext.length === 0) {
      console.log(`[Langflow] -> flow session_id=${this.sessionId} (no context): ${userMessage.substring(0, 200)}`);
      return userMessage;
    }
    const context = this.systemContext.join('\n\n');
    const full = `[Context]\n${context}\n\n[Message]\n${userMessage}`;
    console.log(
      `[Langflow] -> flow session_id=${this.sessionId} | ${this.systemContext.length} ctx block(s), ${full.length} chars\n--- payload ---\n${full}\n--- end payload ---`,
    );
    return full;
  }
}
