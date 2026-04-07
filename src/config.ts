import { config as dotenvConfig } from 'dotenv';
import { languageOptions } from './languageOptions.js';

dotenvConfig();

export const config = {
  messagingMode: (process.env.MESSAGING_MODE || 'maestro') as 'maestro' | 'conversations-v1',
  llm: {
    provider: (process.env.LLM_PROVIDER || 'openai-chat-completions') as
      | 'openai-chat-completions'
      | 'openai-responses'
      | 'openai-agents',
    model: process.env.LLM_MODEL || 'gpt-4.1',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    maxCompletionTokens: process.env.OPENAI_MAX_COMPLETION_TOKENS
      ? parseInt(process.env.OPENAI_MAX_COMPLETION_TOKENS, 10)
      : undefined,
  },
  twilio: {
    workflowSid: process.env.TWILIO_WORKFLOW_SID,
    workspaceSid: process.env.TWILIO_WORKSPACE_SID,
    conversationsServiceSid: process.env.TWILIO_CONVERSATIONS_SERVICE_SID,
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
  },
  google: {
    spreadsheetId: process.env.GOOGLESHEETS_SPREADSHEET_ID,
    calendarId: process.env.GOOGLE_CALENDAR_ID,
  },
  welcomeGreeting:
    process.env.WELCOME_GREETING || 'Thanks for calling! How can I help you today?',
  languages: languageOptions,
};
