/**
 * Describe an image using OpenAI's vision API.
 *
 * Used by the inbound-media webhook to convert images sent by WhatsApp
 * customers (medication photos, document scans, receipts, etc.) into text
 * that can be inserted as a customer Communication via insertCommunication.
 *
 * Requires OPENAI_API_KEY. Model is configurable via `VISION_MODEL` env var
 * (default `gpt-4o-mini`). The prompt is configurable via
 * `IMAGE_DESCRIPTION_PROMPT` — let the deployment tailor it to its domain
 * (pharma logistics, retail, insurance claims, etc.).
 */
import OpenAI from 'openai';

import { config } from '../config.js';

let openai: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (openai) return openai;
  const apiKey = config.openai.apiKey;
  if (!apiKey) return null;
  openai = new OpenAI({ apiKey });
  return openai;
}

export interface DescribeImageOptions {
  /** MIME type of the image (e.g., `image/jpeg`, `image/png`, `image/webp`). */
  contentType: string;
  /** Optional prompt override. Falls back to `IMAGE_DESCRIPTION_PROMPT` env or a generic default. */
  prompt?: string;
}

export interface DescribeImageResult {
  text: string;
  /** Model name used (for logging/observability). */
  model: string;
}

/**
 * Describe an image Buffer.
 *
 * Sends the image inline as a base64 data URL — no need to host the bytes
 * anywhere. OpenAI's vision API decodes and analyzes it on their end.
 *
 * @returns Description text + metadata. Returns `null` if no OpenAI API key
 *          is configured (so callers can gracefully skip).
 */
export async function describeImage(
  buffer: Buffer,
  options: DescribeImageOptions
): Promise<DescribeImageResult | null> {
  const client = getClient();
  if (!client) return null;

  const prompt = options.prompt || config.inboundMedia.imagePrompt;
  const model = config.inboundMedia.visionModel;
  const mime = options.contentType.split(';')[0].trim() || 'image/jpeg';
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

  const completion = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  });

  const text = completion.choices[0]?.message?.content?.trim() ?? '';
  return { text, model };
}
