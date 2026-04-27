/**
 * Generic knowledge base search function.
 * Used by specific search tools (FAQ, medical billing, driver service) that bind
 * to a particular KB ID.
 */
import type { TAC } from 'twilio-agent-connect';

export interface SearchKnowledgeParams {
  query: string;
  topK?: number;
}

export function makeSearchKnowledge(tac: TAC, knowledgeBaseId: string, label: string) {
  return async function searchKnowledge(params: SearchKnowledgeParams): Promise<string> {
    const client = tac.getKnowledgeClient();
    if (!client) {
      return 'Knowledge base not configured.';
    }

    const topK = params.topK ?? 5;

    try {
      const chunks = await client.searchKnowledgeBase(knowledgeBaseId, params.query, topK);
      if (!chunks || chunks.length === 0) {
        return `No relevant content found in ${label}.`;
      }

      return chunks
        .map((c, i) => `[${i + 1}] ${c.content}`)
        .join('\n\n');
    } catch (error) {
      console.error(`[searchKnowledge:${label}] Search error:`, error);
      return `Failed to search ${label}.`;
    }
  };
}
