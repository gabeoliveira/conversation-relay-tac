import { config } from '../config.js';
import type { LLMProvider } from './types.js';

export async function createLLMProvider(): Promise<LLMProvider> {
  switch (config.llm.provider) {
    case 'openai-chat-completions': {
      const { OpenAIChatCompletionsProvider } = await import('./openai-chat-completions.js');
      return new OpenAIChatCompletionsProvider();
    }
    case 'openai-responses': {
      const { OpenAIResponsesProvider } = await import('./openai-responses.js');
      return new OpenAIResponsesProvider();
    }
    case 'openai-agents': {
      const { OpenAIAgentsProvider } = await import('./openai-agents.js');
      return new OpenAIAgentsProvider();
    }
    default:
      throw new Error(`Unknown LLM provider: ${config.llm.provider}`);
  }
}
