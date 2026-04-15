/**
 * Conversation Relay Application — powered by Twilio Agent Connect
 *
 * Simple mode: edit prompts/ and tools/ in this repo, then run.
 * Multi-agent mode: import createApp from this package and pass your own config.
 */
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { createApp } from './app.js';
import { systemPrompt } from './prompts/systemPrompt.js';
import { allTools } from './tools/index.js';

createApp({
  systemPrompt,
  tools: allTools,
});
