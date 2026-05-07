/**
 * Knowledge base search tools for the Owl Bank agent.
 *
 * Each tool binds to a specific Twilio Knowledge Base by ID. The LLM picks
 * the right tool based on the customer's question, making retrieval domain-scoped.
 *
 * Configure KB IDs via environment variables — see .env.example for the required keys.
 */
import { createKnowledgeTools, TACTool } from 'twilio-agent-connect';
import type { TAC } from 'twilio-agent-connect';

export function buildKnowledgeTools(tac: TAC): TACTool[] {
  const knowledgeClient = tac.getKnowledgeClient();
  if (!knowledgeClient) return [];

  const factory = createKnowledgeTools(knowledgeClient);
  const tools: TACTool[] = [];

  const faqKbId = process.env.KB_FAQ_ID;
  const billingKbId = process.env.KB_BILLING_ID;
  const driverKbId = process.env.KB_DRIVER_ID;

  if (faqKbId) {
    tools.push(
      factory.forKnowledgeBase(faqKbId, {
        name: 'search_support_faq',
        description:
          'Search Owl Bank general support FAQ. Use this for questions about business hours, contact channels, account types, security, fraud reporting, branches, and general "how does Owl Bank work" questions.',
      })
    );
  }

  if (billingKbId) {
    tools.push(
      factory.forKnowledgeBase(billingKbId, {
        name: 'search_medical_billing',
        description:
          'Search medical billing domain knowledge. Use this for questions about accepted insurance plans, explanations of common charges, payment options, billing terminology (deductible, copay, coinsurance, out-of-pocket max), how HSA accounts work, and pre-authorization.',
      })
    );
  }

  if (driverKbId) {
    tools.push(
      factory.forKnowledgeBase(driverKbId, {
        name: 'search_driver_service',
        description:
          'Search the Motorista da Rodada (Conductor Eligido) driver service knowledge base. Use this for pre-booking questions like how the service works, coverage area, pricing, cancellation policy, booking rules, driver credentials, and general "what if" scenarios.',
      })
    );
  }

  return tools;
}
