import { Agent, run, tool } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents';
import type { TACTool } from 'twilio-agent-connect';
import { z } from 'zod';

import { config } from '../config.js';
import { systemPrompt } from '../prompts/systemPrompt.js';
import { getAdditionalContext } from '../prompts/additionalContext.js';
import { executeTool } from '../tools/index.js';
import type { LLMProvider, ToolAction } from './types.js';

export class OpenAIAgentsProvider implements LLMProvider {
  private agent: Agent;
  private conversationHistory: AgentInputItem[];
  private lastAction: ToolAction | undefined;

  constructor() {
    console.log('[Agents] Initializing provider');
    this.conversationHistory = [
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: config.welcomeGreeting }],
      } as AgentInputItem,
    ];
    this.agent = this.createAgent();
  }

  private createAgent(): Agent {
    return new Agent({
      name: 'ConversationRelayAgent',
      instructions: `${systemPrompt}\n\n${getAdditionalContext()}`,
      model: config.llm.model,
      tools: this.buildAgentTools(),
    });
  }

  private buildAgentTools() {
    const self = this;
    return [
      tool({ name: 'book_driver', description: 'Books a driver using Motorista da Rodada', parameters: z.object({ date: z.string(), time: z.string(), duration: z.number(), summary: z.string(), description: z.string().optional(), timezone: z.string().optional() }), execute: async (args) => { const r = await executeTool('book_driver', JSON.stringify(args)); self.trackAction('book_driver', JSON.stringify(args)); return r; } }),
      tool({ name: 'check_pending_bill', description: 'Check pending medical bill', parameters: z.object({ userId: z.string() }), execute: async (args) => { const r = await executeTool('check_pending_bill', JSON.stringify(args)); return r; } }),
      tool({ name: 'check_card_delivery', description: 'Check card delivery status', parameters: z.object({ userId: z.string() }), execute: async (args) => { const r = await executeTool('check_card_delivery', JSON.stringify(args)); return r; } }),
      tool({ name: 'check_hsa_account', description: 'Check HSA balance', parameters: z.object({ userId: z.string() }), execute: async (args) => { const r = await executeTool('check_hsa_account', JSON.stringify(args)); return r; } }),
      tool({ name: 'check_increase_limit', description: 'Check limit increase eligibility', parameters: z.object({ userId: z.string() }), execute: async (args) => { const r = await executeTool('check_increase_limit', JSON.stringify(args)); return r; } }),
      tool({ name: 'troubleshoot_login_issues', description: 'Assist with login issues', parameters: z.object({ userId: z.string() }), execute: async (args) => { const r = await executeTool('troubleshoot_login_issues', JSON.stringify(args)); return r; } }),
      tool({ name: 'check_payment_options', description: 'Check payment options', parameters: z.object({ userId: z.string(), hsaAccountBalance: z.number(), balance: z.number() }), execute: async (args) => { const r = await executeTool('check_payment_options', JSON.stringify(args)); return r; } }),
      tool({ name: 'search_common_medical_terms', description: 'Search medical terms', parameters: z.object({ inquiry: z.enum(['DEDUCTIBLE', 'COPAY', 'HSA', 'OUT_OF_POCKET_MAX']) }), execute: async (args) => { const r = await executeTool('search_common_medical_terms', JSON.stringify(args)); return r; } }),
      tool({ name: 'switch_language', description: 'Switch conversation language', parameters: z.object({ targetLanguage: z.enum(['portuguese', 'english', 'spanish']) }), execute: async (args) => { const r = await executeTool('switch_language', JSON.stringify(args)); self.trackAction('switch_language', JSON.stringify(args)); return r; } }),
      tool({ name: 'human_agent_handoff', description: 'Transfer to live agent', parameters: z.object({ reason: z.string(), context: z.string().optional() }), execute: async (args) => { const r = await executeTool('human_agent_handoff', JSON.stringify(args)); self.trackAction('human_agent_handoff', JSON.stringify(args)); return r; } }),
      tool({ name: 'add_survey_response', description: 'Add CSAT survey response', parameters: z.object({ customerPhone: z.string(), inGeneral: z.string(), lastService: z.string(), lastDriver: z.string(), observations: z.string().optional() }), execute: async (args) => { const r = await executeTool('add_survey_response', JSON.stringify(args)); self.trackAction('add_survey_response', JSON.stringify(args)); return r; } }),
    ];
  }

  addSystemContext(content: string): void {
    this.conversationHistory.push({ role: 'system', content });
  }

  getLastAction(): ToolAction | undefined {
    return this.lastAction;
  }

  clearLastAction(): void {
    this.lastAction = undefined;
  }

  async generateResponse(
    userMessage: string,
    _tools: TACTool[],
    _signal?: AbortSignal
  ): Promise<string> {
    this.conversationHistory.push({ role: 'user', content: userMessage });

    const result = await run(this.agent, this.conversationHistory);
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
