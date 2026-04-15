import { Agent, run, tool } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents';
import type { TACTool } from 'twilio-agent-connect';
import { z } from 'zod';

import { config } from '../config.js';
import { executeTool } from '../tools/index.js';
import type { LLMProvider, ToolAction } from './types.js';

export class OpenAIAgentsProvider implements LLMProvider {
  private agent: Agent | undefined;
  private conversationHistory: AgentInputItem[];
  private lastAction: ToolAction | undefined;
  private systemInstructions: string = '';
  private currentTools: TACTool[] = [];

  constructor() {
    console.log('[Agents] Initializing provider');
    this.conversationHistory = [
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: config.welcomeGreeting }],
      } as AgentInputItem,
    ];
  }

  private getAgent(): Agent {
    if (!this.agent) {
      this.agent = new Agent({
        name: 'ConversationRelayAgent',
        instructions: this.systemInstructions,
        model: config.llm.model,
        tools: this.buildAgentTools(),
      });
    }
    return this.agent;
  }

  private buildAgentTools() {
    const self = this;
    return this.currentTools.map((t) =>
      tool({
        name: t.name,
        description: t.description,
        parameters: z.object({}).passthrough(),
        execute: async (args) => {
          const r = await executeTool(t.name, JSON.stringify(args), self.currentTools);
          self.trackAction(t.name, JSON.stringify(args));
          return r;
        },
      })
    );
  }

  addSystemContext(content: string): void {
    this.systemInstructions += (this.systemInstructions ? '\n\n' : '') + content;
    // Reset agent so it picks up new instructions
    this.agent = undefined;
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
    _signal?: AbortSignal
  ): Promise<string> {
    this.currentTools = tools;
    this.agent = undefined; // Rebuild agent with current tools
    this.conversationHistory.push({ role: 'user', content: userMessage });

    const result = await run(this.getAgent(), this.conversationHistory);
    const response = result.finalOutput || '';

    this.conversationHistory.push({
      role: 'assistant',
      content: [{ type: 'output_text', text: response }],
    } as AgentInputItem);
    return response;
  }

  async *streamResponse(
    userMessage: string,
    _tools: TACTool[],
    _signal?: AbortSignal
  ): AsyncIterable<string> {
    // The Agents SDK doesn't natively support token-level streaming,
    // so we fall back to generating the full response and yielding it at once.
    const response = await this.generateResponse(userMessage, _tools, _signal);
    yield response;
  }

  private trackAction(name: string, args: string): void {
    if (name === 'human_agent_handoff') {
      const parsed = JSON.parse(args);
      this.lastAction = { type: 'handoff', reason: parsed.reason, context: parsed.context };
    } else if (name === 'switch_language') {
      const parsed = JSON.parse(args);
      this.lastAction = { type: 'switchLanguage', targetLanguage: parsed.targetLanguage };
    } else if (name === 'add_survey_response') {
      this.lastAction = { type: 'endInteraction' };
    }
  }
}
