import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type { TACTool } from 'twilio-agent-connect';

import { config } from '../config.js';
import { executeTool } from '../tools/index.js';
import type { LLMProvider, ToolAction } from './types.js';

export class OpenAIChatCompletionsProvider implements LLMProvider {
  private openai: OpenAI;
  private messages: ChatCompletionMessageParam[];
  private lastAction: ToolAction | undefined;
  private currentTools: TACTool[] = [];

  constructor() {
    console.log(
      `[ChatCompletions] Initializing provider${config.openai.baseURL ? ` (baseURL=${config.openai.baseURL})` : ''}`,
    );
    this.openai = new OpenAI({
      apiKey: config.openai.apiKey,
      ...(config.openai.baseURL && { baseURL: config.openai.baseURL }),
    });
    this.messages = [
      { role: 'assistant', content: config.welcomeGreeting },
    ];
  }

  addSystemContext(content: string): void {
    this.messages.push({ role: 'system', content });
  }

  getLastAction(): ToolAction | undefined {
    return this.lastAction;
  }

  clearLastAction(): void {
    this.lastAction = undefined;
  }

  async generateResponse(
    userMessage: string,
    tools: TACTool[],
    signal?: AbortSignal
  ): Promise<string> {
    this.currentTools = tools;
    this.messages.push({ role: 'user', content: userMessage });
    return this.complete(tools, signal);
  }

  async *streamResponse(
    userMessage: string,
    tools: TACTool[],
    signal?: AbortSignal
  ): AsyncIterable<string> {
    this.currentTools = tools;
    this.messages.push({ role: 'user', content: userMessage });
    yield* this.streamComplete(tools, signal);
  }

  // ── Non-streaming completion with tool loop ──────────────────────────────

  private async complete(tools: TACTool[], signal?: AbortSignal): Promise<string> {
    const openaiTools = tools.map((t) => t.toOpenAIFormat()) as ChatCompletionTool[];

    while (true) {
      if (signal?.aborted) throw new Error('Aborted');

      const completion = await this.openai.chat.completions.create({
        model: config.llm.model,
        messages: this.messages,
        tools: openaiTools,
        tool_choice: 'auto',
        ...(config.openai.maxCompletionTokens && {
          max_completion_tokens: config.openai.maxCompletionTokens,
        }),
      });

      if (config.openai.logResponseModel && completion.model) {
        // Actual model that served this request. When behind LiteLLM, this
        // reflects the underlying provider's model — useful for spotting
        // silent routing drift (e.g. gpt-4o → gemini-1.5-flash-latest).
        console.log(
          `[ChatCompletions] response model=${completion.model} (requested=${config.llm.model})`,
        );
      }

      const message = completion.choices[0]?.message;
      if (!message) throw new Error('No message received');

      if (message.tool_calls && message.tool_calls.length > 0) {
        // Add assistant message with tool calls
        this.messages.push(message);

        // Execute tools and add results
        for (const tc of message.tool_calls) {
          const result = await this.executeAndTrackAction(tc.function.name, tc.function.arguments);
          this.messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }

        // Loop — the next iteration will send tool results back to the LLM
        continue;
      }

      // Final text response
      this.messages.push(message);
      return message.content || '';
    }
  }

  // ── Streaming completion with tool loop ──────────────────────────────────

  private async *streamComplete(
    tools: TACTool[],
    signal?: AbortSignal
  ): AsyncIterable<string> {
    const openaiTools = tools.map((t) => t.toOpenAIFormat()) as ChatCompletionTool[];

    while (true) {
      if (signal?.aborted) return;

      const stream = await this.openai.chat.completions.create({
        stream: true,
        model: config.llm.model,
        messages: this.messages,
        tools: openaiTools,
        tool_choice: 'auto',
        ...(config.openai.maxCompletionTokens && {
          max_completion_tokens: config.openai.maxCompletionTokens,
        }),
      });

      let fullResponse = '';
      const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
      let modelLogged = false;

      for await (const chunk of stream) {
        if (signal?.aborted) return;

        if (config.openai.logResponseModel && !modelLogged && chunk.model) {
          console.log(
            `[ChatCompletions] response model=${chunk.model} (requested=${config.llm.model})`,
          );
          modelLogged = true;
        }

        const delta = chunk.choices[0]?.delta;
        const finishReason = chunk.choices[0]?.finish_reason;

        // Stream text tokens
        if (delta?.content) {
          fullResponse += delta.content;
          yield delta.content;
        }

        // Accumulate tool calls
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id) {
              toolCalls.push({ id: tc.id, name: tc.function?.name || '', arguments: tc.function?.arguments || '' });
            } else if (toolCalls.length > 0) {
              toolCalls[toolCalls.length - 1].arguments += tc.function?.arguments || '';
            }
          }
        }

        if (finishReason === 'stop') {
          this.messages.push({ role: 'assistant', content: fullResponse });
          return;
        }

        if (finishReason === 'tool_calls') {
          // Add assistant message with tool calls
          this.messages.push({
            role: 'assistant',
            content: null,
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          });

          // Execute tools
          for (const tc of toolCalls) {
            const result = await this.executeAndTrackAction(tc.name, tc.arguments);
            this.messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
          }

          // Loop — will re-invoke the LLM with tool results
          break;
        }
      }
    }
  }

  // ── Tool execution + side-effect tracking ────────────────────────────────

  private async executeAndTrackAction(name: string, args: string): Promise<string> {
    const result = await executeTool(name, args, this.currentTools);

    if (name === 'human_agent_handoff') {
      const parsed = JSON.parse(args);
      this.lastAction = { type: 'handoff', reason: parsed.reason, context: parsed.context };
    } else if (name === 'switch_language') {
      const parsed = JSON.parse(args);
      this.lastAction = { type: 'switchLanguage', targetLanguage: parsed.targetLanguage };
    } else if (name === 'add_survey_response') {
      this.lastAction = { type: 'endInteraction' };
    }

    return result;
  }
}
