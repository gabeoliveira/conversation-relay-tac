/**
 * Upload markdown files from knowledge/<kb>/ directories to Twilio Knowledge.
 *
 * Each subdirectory maps to a KB ID (via env vars). Each .md file becomes a
 * Knowledge Source of type "Text" with the file content as the source content.
 *
 * Usage:
 *   npx tsx scripts/upload-knowledge.ts
 */
import { readdirSync, readFileSync } from 'fs';
import { join, basename, extname } from 'path';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

const KB_MAPPINGS: Array<{ dir: string; kbId: string | undefined; label: string }> = [
  { dir: 'faq', kbId: process.env.KB_FAQ_ID, label: 'Support FAQ' },
  { dir: 'billing', kbId: process.env.KB_BILLING_ID, label: 'Medical Billing' },
  { dir: 'driver', kbId: process.env.KB_DRIVER_ID, label: 'Driver Service' },
];

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const KNOWLEDGE_DIR = join(process.cwd(), 'knowledge');

if (!ACCOUNT_SID || !AUTH_TOKEN) {
  console.error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in .env');
  process.exit(1);
}

const authHeader = 'Basic ' + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');

async function uploadSource(kbId: string, name: string, content: string): Promise<void> {
  // Name must be <= 30 chars and match [a-zA-Z0-9-]+ based on observations
  const cleanName = name.slice(0, 30).replace(/[^a-zA-Z0-9-]/g, '-');

  const response = await fetch(
    `https://knowledge.twilio.com/v2/KnowledgeBases/${kbId}/Knowledge`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify({
        name: cleanName,
        source: { type: 'Text', content },
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { id: string; status: string };
  console.log(`  ✓ ${cleanName} → ${data.id} (${data.status})`);
}

async function main(): Promise<void> {
  for (const { dir, kbId, label } of KB_MAPPINGS) {
    if (!kbId) {
      console.log(`Skipping ${label} — no KB ID set (${dir})`);
      continue;
    }

    const fullDir = join(KNOWLEDGE_DIR, dir);
    let files: string[];
    try {
      files = readdirSync(fullDir).filter(f => extname(f) === '.md');
    } catch (err) {
      console.log(`Skipping ${label} — directory not found: ${fullDir}`);
      continue;
    }

    console.log(`\n📚 Uploading ${files.length} file(s) to ${label} (${kbId})`);

    for (const file of files) {
      const path = join(fullDir, file);
      const content = readFileSync(path, 'utf-8');
      const name = basename(file, '.md');
      try {
        await uploadSource(kbId, name, content);
      } catch (err) {
        console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log('\nDone. Sources are queued for processing — check status in the Twilio Console.');
}

main().catch(err => {
  console.error('Upload error:', err);
  process.exit(1);
});
