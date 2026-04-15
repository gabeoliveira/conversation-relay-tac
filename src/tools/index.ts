/**
 * Tool definitions using TACTool / defineTool from Twilio Agent Connect.
 *
 * Each tool is defined once and can be converted to OpenAI or Anthropic format
 * via .toOpenAIFormat() or .toAnthropicFormat() — no manual converter needed.
 */
import { defineTool, TACTool } from 'twilio-agent-connect';

import { bookDriver } from './bookDriver.js';
import { checkPendingBill } from './checkPendingBill.js';
import { checkCardDelivery } from './checkCardDelivery.js';
import { checkHsaAccount } from './checkHsaAccount.js';
import { checkIncreaseLimit } from './checkIncreaseLimit.js';
import { troubleshootLoginIssues } from './troubleshootLoginIssues.js';
import { checkPaymentOptions } from './checkPaymentOptions.js';
import { searchCommonMedicalTerms } from './searchCommonMedicalTerms.js';
import { switchLanguage } from './switchLanguage.js';
import { humanAgentHandoff } from './humanAgentHandoff.js';
import { addSurveyResponse } from './addSurveyResponse.js';

// ─── Tool Definitions ────────────────────────────────────────────────────────

export const bookDriverTool = defineTool(
  'book_driver',
  'Books a driver using Conductor Eligido or Motorista da Rodada services with specified details.',
  {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'Date of the booking in YYYY-MM-DD format' },
      time: { type: 'string', description: 'Time of the booking in HH:mm format (24h)' },
      duration: { type: 'number', description: 'Duration of the booking in minutes' },
      summary: { type: 'string', description: 'Customer name as summary of the booking' },
      description: { type: 'string', description: 'Optional description for the booking' },
      timezone: { type: 'string', description: 'Timezone (default: America/Bogota)' },
    },
    required: ['date', 'time', 'duration', 'summary'],
  },
  bookDriver
);

export const checkPendingBillTool = defineTool(
  'check_pending_bill',
  'Check if the user has a pending medical bill',
  {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'The user ID from verify_user_identity' },
    },
    required: ['userId'],
  },
  checkPendingBill
);

export const checkCardDeliveryTool = defineTool(
  'check_card_delivery',
  'Checks the status of a card delivery for the user',
  {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'The user ID from verify_user_identity' },
    },
    required: ['userId'],
  },
  checkCardDelivery
);

export const checkHsaAccountTool = defineTool(
  'check_hsa_account',
  "Check the balance of a user's Health Savings Account (HSA)",
  {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'The user ID from verify_user_identity' },
    },
    required: ['userId'],
  },
  checkHsaAccount
);

export const checkIncreaseLimitTool = defineTool(
  'check_increase_limit',
  'Checks whether the user is eligible for a credit or account limit increase',
  {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'The user ID from verify_user_identity' },
    },
    required: ['userId'],
  },
  checkIncreaseLimit
);

export const troubleshootLoginIssuesTool = defineTool(
  'troubleshoot_login_issues',
  'Assists the user in resolving common login issues',
  {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'The user ID from verify_user_identity' },
    },
    required: ['userId'],
  },
  troubleshootLoginIssues
);

export const checkPaymentOptionsTool = defineTool(
  'check_payment_options',
  'Check available payment options based on HSA balance and bill amount',
  {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'The user ID' },
      hsaAccountBalance: { type: 'number', description: 'HSA account balance' },
      balance: { type: 'number', description: 'Bill balance due' },
    },
    required: ['userId', 'hsaAccountBalance', 'balance'],
  },
  checkPaymentOptions
);

export const searchCommonMedicalTermsTool = defineTool(
  'search_common_medical_terms',
  'Check knowledge base for medical terms',
  {
    type: 'object',
    properties: {
      inquiry: {
        type: 'string',
        enum: ['DEDUCTIBLE', 'COPAY', 'HSA', 'OUT_OF_POCKET_MAX'],
        description: 'The medical term to search for',
      },
    },
    required: ['inquiry'],
  },
  searchCommonMedicalTerms
);

export const switchLanguageTool = defineTool(
  'switch_language',
  'Switch the language of the conversation',
  {
    type: 'object',
    properties: {
      targetLanguage: {
        type: 'string',
        enum: ['portuguese', 'english', 'spanish'],
        description: 'The target language to switch to',
      },
    },
    required: ['targetLanguage'],
  },
  switchLanguage
);

export const humanAgentHandoffTool = defineTool(
  'human_agent_handoff',
  'Transfers the customer to a live agent in case they request help from a real person.',
  {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'The reason for the handoff' },
      context: { type: 'string', description: 'Any relevant conversation context' },
    },
    required: ['reason'],
  },
  humanAgentHandoff
);

export const addSurveyResponseTool = defineTool(
  'add_survey_response',
  "Add a Customer Satisfaction Survey Response. This should be called everytime the user says there's nothing else you can help with",
  {
    type: 'object',
    properties: {
      customerPhone: { type: 'string', description: "Customer's phone number" },
      inGeneral: { type: 'string', description: 'General satisfaction (1-5 as string)' },
      lastService: { type: 'string', description: 'Last service satisfaction (1-5 as string)' },
      lastDriver: { type: 'string', description: 'Last driver satisfaction (1-5 as string)' },
      observations: { type: 'string', description: "Customer's comments" },
    },
    required: ['customerPhone', 'inGeneral', 'lastService', 'lastDriver'],
  },
  addSurveyResponse
);

// ─── All tools as an array ───────────────────────────────────────────────────

export const allTools: TACTool[] = [
  bookDriverTool,
  checkPendingBillTool,
  checkCardDeliveryTool,
  checkHsaAccountTool,
  checkIncreaseLimitTool,
  troubleshootLoginIssuesTool,
  checkPaymentOptionsTool,
  searchCommonMedicalTermsTool,
  switchLanguageTool,
  humanAgentHandoffTool,
  addSurveyResponseTool,
];

/**
 * Execute a tool by name. Searches the provided tools array, or falls back to allTools.
 */
export async function executeTool(name: string, args: string, tools?: TACTool[]): Promise<string> {
  const searchList = tools || allTools;
  const tool = searchList.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not implemented`);
  let parsed;
  try {
    parsed = JSON.parse(args);
  } catch (err) {
    console.error(`[executeTool] Malformed JSON for tool ${name}:`, args);
    return `Error: received malformed arguments for ${name}. Please try again.`;
  }
  const result = await tool.implementation(parsed);
  return typeof result === 'string' ? result : JSON.stringify(result);
}
