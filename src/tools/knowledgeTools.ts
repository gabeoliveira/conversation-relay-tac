/**
 * Knowledge base search tools for the Owl Bank agent.
 *
 * Each tool binds to a specific Twilio Knowledge Base by ID. The LLM picks
 * the right tool based on the customer's question, making retrieval domain-scoped.
 *
 * Configure KB IDs via environment variables — see .env.example for the required keys.
 */
import { defineTool, TACTool } from 'twilio-agent-connect';
import type { TAC } from 'twilio-agent-connect';
import { makeSearchKnowledge } from './searchKnowledge.js';

export function buildKnowledgeTools(tac: TAC): TACTool[] {
  const tools: TACTool[] = [];

  const faqKbId = process.env.KB_FAQ_ID;
  const billingKbId = process.env.KB_BILLING_ID;
  const driverKbId = process.env.KB_DRIVER_ID;

  if (faqKbId) {
    tools.push(
      defineTool(
        'search_support_faq',
        'Search Owl Bank general support FAQ. Use this for questions about business hours, contact channels, account types, security, fraud reporting, branches, and general "how does Owl Bank work" questions.',
        {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The customer question to search for' },
            topK: { type: 'number', description: 'Number of results to return (default 5, max 20)' },
          },
          required: ['query'],
        },
        makeSearchKnowledge(tac, faqKbId, 'support FAQ')
      )
    );
  }

  if (billingKbId) {
    tools.push(
      defineTool(
        'search_medical_billing',
        'Search medical billing domain knowledge. Use this for questions about accepted insurance plans, explanations of common charges, payment options, billing terminology (deductible, copay, coinsurance, out-of-pocket max), how HSA accounts work, and pre-authorization.',
        {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The customer question to search for' },
            topK: { type: 'number', description: 'Number of results to return (default 5, max 20)' },
          },
          required: ['query'],
        },
        makeSearchKnowledge(tac, billingKbId, 'medical billing')
      )
    );
  }

  if (driverKbId) {
    tools.push(
      defineTool(
        'search_driver_service',
        'Search the Motorista da Rodada (Conductor Eligido) driver service knowledge base. Use this for pre-booking questions like how the service works, coverage area, pricing, cancellation policy, booking rules, driver credentials, and general "what if" scenarios.',
        {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The customer question to search for' },
            topK: { type: 'number', description: 'Number of results to return (default 5, max 20)' },
          },
          required: ['query'],
        },
        makeSearchKnowledge(tac, driverKbId, 'driver service')
      )
    );
  }

  return tools;
}
