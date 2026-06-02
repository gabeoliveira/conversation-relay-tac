import { config as dotenvConfig } from 'dotenv';
import { languageOptions } from './languageOptions.js';

dotenvConfig();

export const config = {
  messagingMode: (process.env.MESSAGING_MODE || 'maestro') as 'maestro' | 'conversations-v1',
  // Memory recall strategy:
  //   'always'       - TAC calls Memory Recall before every inbound message (TAC default behavior)
  //   'never'        - no automatic recall; LLM gets no memory context
  //   'first-prompt' - template-level pattern: recall once per conversation,
  //                    reuse cached response for subsequent turns. For voice,
  //                    pre-fetches on ConversationRelay's `setup` event so the
  //                    recall round-trip runs in parallel with the welcome
  //                    greeting — saves ~400-1000 ms on the first response.
  memoryRecallMode: (process.env.MEMORY_RECALL_MODE || 'always') as
    | 'always'
    | 'never'
    | 'first-prompt',
  // Debounce window for messaging channels (SMS/WhatsApp). When the customer
  // sends multiple messages in quick succession, they're buffered and combined
  // into a single LLM turn. Voice is never debounced (ConversationRelay's
  // WebSocket handles turn-taking natively). Default 2000ms.
  messageDebounceMs: parseInt(process.env.MESSAGE_DEBOUNCE_MS || '2000', 10),
  // Inbound media handling (e.g., WhatsApp audio transcription). Off by
  // default so deployments that don't need it don't pay the OpenAI cost.
  // Set INBOUND_MEDIA_ENABLED=true to register the /inbound-message route
  // and route audio messages through Whisper. Requires OPENAI_API_KEY.
  inboundMedia: {
    enabled: process.env.INBOUND_MEDIA_ENABLED === 'true',
    routePath: process.env.INBOUND_MEDIA_ROUTE_PATH || '/inbound-message',
    // Audio transcription (Whisper)
    whisperModel: process.env.WHISPER_MODEL || 'whisper-1',
    whisperLanguage: process.env.WHISPER_LANGUAGE || 'pt',
    // Image description (vision)
    visionModel: process.env.VISION_MODEL || 'gpt-4o-mini',
    imagePrompt:
      process.env.IMAGE_DESCRIPTION_PROMPT ||
      // Generic default — works for any domain. Override per-deployment to
      // tailor description style (pharma, retail, insurance claims, etc.).
      'Describe this image in plain prose. If it shows a product or document, identify the brand, key text, codes, dates, and visible condition. If it is a personal or general photo, give a one-line description. Be direct and clinical — no preamble or "in this image" intros. Your description goes directly to a customer service agent.',
  },
  llm: {
    provider: (process.env.LLM_PROVIDER || 'openai-chat-completions') as
      | 'openai-chat-completions'
      | 'openai-responses'
      | 'openai-agents'
      | 'langflow',
    model: process.env.LLM_MODEL || 'gpt-4.1',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    maxCompletionTokens: process.env.OPENAI_MAX_COMPLETION_TOKENS
      ? parseInt(process.env.OPENAI_MAX_COMPLETION_TOKENS, 10)
      : undefined,
  },
  // Langflow is an optional alternative LLM backend, selected via
  // LLM_PROVIDER=langflow. The flow itself owns prompt, tools, knowledge —
  // TAC just streams turns through it and prepends memory/channel context
  // (which TAC fetches via the existing pipeline and accumulates through
  // addSystemContext) to the user input. See LANGFLOW_PROVIDER_PLAN.md.
  langflow: {
    baseUrl: process.env.LANGFLOW_BASE_URL,
    flowId: process.env.LANGFLOW_FLOW_ID,
    apiKey: process.env.LANGFLOW_API_KEY,
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
