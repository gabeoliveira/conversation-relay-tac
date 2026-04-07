import type { TACTool } from 'twilio-agent-connect';

/**
 * Thin LLM provider interface.
 *
 * Each provider only needs to implement two methods:
 * - generateResponse: non-streaming, for SMS/WhatsApp
 * - streamResponse: streaming, for voice (yields tokens as they arrive)
 *
 * TAC handles everything else: WebSocket protocol, session state,
 * interruptions (via AbortSignal), memory retrieval, and channel routing.
 */
export interface LLMProvider {
  /**
   * Add a message to conversation history and get a complete response.
   * Used for SMS/WhatsApp channels.
   */
  generateResponse(
    userMessage: string,
    tools: TACTool[],
    signal?: AbortSignal
  ): Promise<string>;

  /**
   * Add a message to conversation history and stream back tokens.
   * Used for voice channel via ConversationRelay.
   * Yields partial tokens; the caller sends each to the WebSocket.
   */
  streamResponse(
    userMessage: string,
    tools: TACTool[],
    signal?: AbortSignal
  ): AsyncIterable<string>;

  /**
   * Inject a system-level context message (e.g., call context, memory).
   */
  addSystemContext(content: string): void;

  /**
   * Check if a special action was triggered during the last completion
   * (e.g., handoff, language switch, end interaction).
   */
  getLastAction(): ToolAction | undefined;

  /** Clear the last action after it's been consumed. */
  clearLastAction(): void;
}

export type ToolAction =
  | { type: 'handoff'; reason: string; context?: string }
  | { type: 'switchLanguage'; targetLanguage: string }
  | { type: 'endInteraction' };
