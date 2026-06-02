import { config } from '../config.js';
import type { LLMProvider } from './types.js';

/**
 * Construct an LLM provider matching the `LLM_PROVIDER` env var.
 *
 * The `conversationId` param is needed by the Langflow provider, which uses
 * it as `session_id` for Langflow's chat memory + multi-turn continuity. The
 * OpenAI providers don't need it and ignore it — it's optional so external
 * callers don't have to pass anything.
 */
export async function createLLMProvider(conversationId?: string): Promise<LLMProvider> {
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
    case 'langflow': {
      const { LangflowProvider } = await import('./langflow.js');
      return new LangflowProvider(conversationId);
    }
    default:
      throw new Error(`Unknown LLM provider: ${config.llm.provider}`);
  }
}
