/**
 * Transcribe an audio buffer using OpenAI's Whisper API.
 *
 * Used by the inbound-media webhook to convert WhatsApp voice notes into text
 * that can be inserted as a customer Communication via insertCommunication.
 *
 * Requires OPENAI_API_KEY. Model and language are configurable via env vars
 * (`WHISPER_MODEL`, default `whisper-1`; `WHISPER_LANGUAGE`, default `pt`).
 *
 * Whisper accepts a `Blob` or `File`. We construct a Blob from the buffer and
 * use OpenAI's SDK directly. The SDK accepts a File-like object via `toFile()`.
 */
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';

import { config } from '../config.js';

let openai: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (openai) return openai;
  const apiKey = config.openai.apiKey;
  if (!apiKey) return null;
  openai = new OpenAI({
    apiKey,
    ...(config.openai.baseURL && { baseURL: config.openai.baseURL }),
  });
  return openai;
}

export interface TranscribeAudioOptions {
  /** MIME type of the audio (e.g., `audio/ogg`, `audio/mpeg`). Used to set the filename extension Whisper expects. */
  contentType: string;
  /** Optional language hint (ISO-639-1, e.g., `pt`, `es`, `en`). Falls back to `WHISPER_LANGUAGE` env or `pt`. */
  language?: string;
  /** Optional prompt to guide transcription style/vocabulary (Whisper feature). */
  prompt?: string;
}

export interface TranscribeAudioResult {
  text: string;
  /** Detected or supplied language code. */
  language?: string;
  /** Whisper-reported duration in seconds, if returned. */
  durationSeconds?: number;
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/oga': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/aac': 'aac',
  'audio/3gpp': '3gp',
  'audio/amr': 'amr',
};

function extFromContentType(contentType: string): string {
  const base = contentType.split(';')[0].trim().toLowerCase();
  return EXT_BY_CONTENT_TYPE[base] ?? 'bin';
}

/**
 * Transcribe an audio Buffer.
 *
 * @returns The transcribed text + metadata. Throws on API errors. Returns
 *          `null` if no OpenAI API key is configured (so the caller can
 *          gracefully skip when the feature is enabled but credentials
 *          are missing).
 */
export async function transcribeAudio(
  buffer: Buffer,
  options: TranscribeAudioOptions
): Promise<TranscribeAudioResult | null> {
  const client = getClient();
  if (!client) return null;

  const ext = extFromContentType(options.contentType);
  const file = await toFile(buffer, `audio.${ext}`, { type: options.contentType });
  const language = options.language || config.inboundMedia.whisperLanguage;

  const result = await client.audio.transcriptions.create({
    file,
    model: config.inboundMedia.whisperModel,
    language,
    ...(options.prompt ? { prompt: options.prompt } : {}),
  });

  // The non-verbose response shape is `{ text: string }`. We only need the text.
  return { text: result.text, language };
}
