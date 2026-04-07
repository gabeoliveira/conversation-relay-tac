import OpenAI from 'openai';
import type { TACTool } from 'twilio-agent-connect';

import { config } from '../config.js';
import { systemPrompt } from '../prompts/systemPrompt.js';
import { getAdditionalContext } from '../prompts/additionalContext.js';
import { executeTool } from '../tools/index.js';
import type { LLMProvider, ToolAction } from './types.js';

type ResponseInput = OpenAI.Responses.ResponseInput;
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;

export class OpenAIResponsesProvider implements LLMProvider {
  private openai: OpenAI;
  private conversationHistory: ResponseInput;
  private lastAction: ToolAction | undefined;

  constructor() {
    console.log('[Responses] Initializing provider');
    this.openai = new OpenAI({ apiKey: config.openai.apiKey });
    this.conversationHistory = [
      { type: 'message', role: 'system', content: getAdditionalContext() },
      { type: 'message', role: 'assistant', content: config.welcomeGreeting },
    ];
  }

  addSystemContext(content: string): void {
    this.conversationHistory.push({ type: 'message', role: 'system', content });
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
    this.conversationHistory.push({ type: 'message', role: 'user', content: userMessage });
    return this.complete(tools, signal);
  }

  async *streamResponse(
    userMessage: string,
    tools: TACTool[],
    signal?: AbortSignal
  ): AsyncIterable<string> {
    this.conversationHistory.push({ type: 'message', role: 'user', content: userMessage });
    yield* this.streamComplete(tools, signal);
  }

  // ── Non-streaming ────────────────────────────────────────────────────────

  private async complete(tools: TACTool[], signal?: AbortSignal): Promise<string> {
    const responsesTools = tools.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
      strict: false,
    }));

    while (true) {
      if (signal?.aborted) throw new Error('Aborted');

      const response = await this.openai.responses.create({
        model: config.llm.model,
        instructions: systemPrompt,
        input: this.conversationHistory,
        tools: responsesTools,
        ...(config.openai.maxCompletionTokens && {
          max_output_tokens: config.openai.maxCompletionTokens,
        }),
      });

      // Check for tool calls in output
      const functionCalls = response.output.filter(
        (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call'
      );

      if (functionCalls.length > 0) {
        // Add output items to history
        this.conversationHistory.push(...(response.output as ResponseInputItem[]));

        // Execute tools and add results
        for (const fc of functionCalls) {
          const result = await this.executeAndTrackAction(fc.name, fc.arguments);
          this.conversationHistory.push({
            type: 'function_call_output',
            call_id: fc.call_id,
            output: result,
          });
        }

        continue;
      }

      // Extract text output
      const textOutput = response.output.find(
        (item): item is OpenAI.Responses.ResponseOutputMessage => item.type === 'message'
      );
      const text =
        textOutput?.content
          .filter((c): c is OpenAI.Responses.ResponseOutputText => c.type === 'output_text')
          .map((c) => c.text)
          .join('') || '';

      this.conversationHistory.push(...(response.output as ResponseInputItem[]));
      return text;
    }
  }

  // ── Streaming ────────────────────────────────────────────────────────────

  private async *streamComplete(
    tools: TACTool[],
    signal?: AbortSignal
  ): AsyncIterable<string> {
    const responsesTools = tools.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
      strict: false,
    }));

    while (true) {
      if (signal?.aborted) return;

      const stream = await this.openai.responses.create({
        model: config.llm.model,
        instructions: systemPrompt,
        input: this.conversationHistory,
        tools: responsesTools,
        stream: true,
        ...(config.openai.maxCompletionTokens && {
          max_output_tokens: config.openai.maxCompletionTokens,
        }),
      });

      let hasToolCalls = false;
      const pendingToolCalls: Array<{ call_id: string; name: string; arguments: string }> = [];

      for await (const event of stream) {
        if (signal?.aborted) return;

        if (event.type === 'response.output_text.delta') {
          yield event.delta;
        }

        if (event.type === 'response.function_call_arguments.done') {
          hasToolCalls = true;
          const fcEvent = event as unknown as { call_id: string; name: string; arguments: string };
          pendingToolCalls.push({
            call_id: fcEvent.call_id,
            name: fcEvent.name,
            arguments: fcEvent.arguments,
          });
        }

        if (event.type === 'response.completed') {
          // Add all output to history
          this.conversationHistory.push(...(event.response.output as ResponseInputItem[]));
        }
      }

      if (hasToolCalls) {
        for (const tc of pendingToolCalls) {
          const result = await this.executeAndTrackAction(tc.name, tc.arguments);
          this.conversationHistory.push({
            type: 'function_call_output',
            call_id: tc.call_id,
            output: result,
          });
        }

        // Loop to re-invoke with tool results
        continue;
      }

      return;
    }
  }

  private async executeAndTrackAction(name: string, args: string): Promise<string> {
    const result = await executeTool(name, args);

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
