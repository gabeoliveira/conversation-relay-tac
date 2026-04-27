# Enterprise Knowledge

This template integrates with **Twilio Enterprise Knowledge** (Memora) — a managed RAG service that stores, indexes, and searches your content so the LLM can retrieve relevant context on demand.

## Overview

```
+------------------+      +------------------------+      +--------------+
|   LLM decides    |      | search_xxx tool calls  |      | Twilio       |
|  "I need info    | -->  | searchKnowledgeBase()  | -->  | Knowledge    |
|   about X"       |      | on the right KB        |      | (Memora)     |
+------------------+      +------------------------+      +--------------+
                                     |
                                     v
                          Top-K chunks returned
                          to the LLM as context
```

Each **Knowledge Base** (KB) is a container for one domain (e.g., FAQ, product catalog, policies). Each KB holds up to 10 **Knowledge Sources** (markdown, text, or web content), and each source is chunked and embedded on upload. The LLM queries a KB via a dedicated tool like `search_support_faq` and gets back the most relevant chunks.

## Limits

- **5 Knowledge Bases** per account
- **10 Sources** per Knowledge Base
- **16 MB** per source

See [ARCHITECTURE.md](ARCHITECTURE.md) for details on how these limits shape the design.

## Built-in Knowledge Bases

This template ships with three domain-scoped KBs:

| KB | Purpose | Env var |
|---|---|---|
| `search_support_faq` | Owl Bank general support (hours, contact, accounts, security) | `KB_FAQ_ID` |
| `search_medical_billing` | Medical billing concepts (deductibles, copays, HSA) | `KB_BILLING_ID` |
| `search_driver_service` | Motorista da Rodada (pricing, coverage, booking rules) | `KB_DRIVER_ID` |

Each tool is dynamically registered at startup via `buildKnowledgeTools(tac)`. If the env var for a KB isn't set, its tool isn't registered — so you can run the template without any KBs at all.

## Content Structure

Source content lives under [knowledge/](knowledge/), one subdirectory per KB:

```
knowledge/
├── faq/
│   ├── general_info.md
│   └── accounts_and_products.md
├── billing/
│   ├── medical_billing_concepts.md
│   └── disputes_and_corrections.md
└── driver/
    ├── service_overview.md
    └── pricing_and_booking.md
```

Each markdown file becomes one Knowledge Source. File names are sanitized to `a-zA-Z0-9-` (max 30 chars) to satisfy Twilio's naming constraints.

## Creating a New KB

### Option 1: Twilio Console (recommended for ad-hoc setup)

1. Go to **Foundations > Knowledge Bases** in the Twilio Console
2. Click **Create Knowledge Base**
3. Copy the resulting `know_knowledgebase_*` ID

### Option 2: API (scriptable)

```bash
curl -X POST "https://knowledge.twilio.com/v2/ControlPlane/KnowledgeBases" \
  -H 'Content-Type: application/json' \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  -d '{
    "displayName": "My-New-KB",
    "description": "Description of what this KB contains"
  }'
```

**Naming rule**: `displayName` must match `^[a-zA-Z0-9-]+$` (letters, numbers, and hyphens only).

## Uploading Sources

### Using the bundled uploader script

1. Create a new subdirectory under `knowledge/` matching your KB (e.g., `knowledge/policies/`)
2. Drop `.md` files into it
3. Add the KB ID to `.env`
4. Run:

```bash
npx tsx scripts/upload-knowledge.ts
```

The script reads `KB_FAQ_ID`, `KB_BILLING_ID`, and `KB_DRIVER_ID` from the env and uploads each `.md` file as a `Text` source. Extend the `KB_MAPPINGS` array in the script to add new KBs.

**Important**: The script creates new sources every time. It doesn't upsert. To replace content, delete the existing sources first (via the Console or `DELETE /v2/KnowledgeBases/{kbId}/Knowledge/{knowledgeId}`).

### Source types

Twilio supports three source types:

| Type | How to upload | Use case |
|---|---|---|
| `Text` | Pass content directly in the API call | Markdown, plain text, pre-formatted docs |
| `File` | Upload PDF, CSV, or MD file | Official documents, formatted content |
| `Web` | Provide a URL, Twilio crawls it | Public help sites, documentation portals |

The template's uploader uses `Text` exclusively (via markdown files). For `Web` sources, use the Console or call the API directly:

```bash
curl -X POST "https://knowledge.twilio.com/v2/KnowledgeBases/$KB_ID/Knowledge" \
  -H 'Content-Type: application/json' \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  -d '{
    "name": "product-docs",
    "source": {
      "type": "Web",
      "url": "https://docs.example.com",
      "crawlDepth": 3,
      "crawlPeriod": "WEEKLY"
    }
  }'
```

## Registering a New KB as a Tool

If you add a KB beyond the three built-in ones, update [src/tools/knowledgeTools.ts](src/tools/knowledgeTools.ts):

```typescript
const policiesKbId = process.env.KB_POLICIES_ID;

if (policiesKbId) {
  tools.push(
    defineTool(
      'search_policies',
      'Search company policies — refunds, warranties, terms of service, privacy.',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The customer question' },
          topK: { type: 'number', description: 'Number of results (default 5, max 20)' },
        },
        required: ['query'],
      },
      makeSearchKnowledge(tac, policiesKbId, 'policies')
    )
  );
}
```

Then:
1. Add `KB_POLICIES_ID=know_knowledgebase_...` to `.env` and `.env.example`
2. Document the new tool in `src/prompts/systemPrompt.md`
3. Rebuild the package: `npm run build`

## Search Behavior

The LLM calls `search_xxx({ query, topK? })` via its tool interface:

- `query` — the customer's question, passed as-is (max 2048 chars)
- `topK` — number of chunks to return (default 5, max 20)

Each chunk includes:
- `content` — the text snippet
- `knowledgeId` — which source it came from
- `score` — relevance (optional)
- `createdAt` — when it was indexed

The template's `makeSearchKnowledge()` helper joins chunks with `[N]` prefixes for readability. You can customize this format in [src/tools/searchKnowledge.ts](src/tools/searchKnowledge.ts).

## Best Practices

### Content

- **One topic per file** — easier for retrieval to find the right chunk
- **Use headings and bullets** — Twilio's chunking respects markdown structure
- **Keep files under 100KB** — larger files create too many chunks and dilute retrieval quality
- **Avoid redundancy** — duplicate information across sources causes ambiguity in retrieval
- **Remove stale content** — outdated docs are worse than no docs; they misinform the bot

### Scope

- **One KB per domain** — don't mix policies with product info
- **Descriptive tool names** — `search_returns_policy` is clearer than `search_kb_3`
- **Descriptive tool descriptions** — the LLM uses these to decide when to call your tool
- **Keep scope narrow** — for a bot that answers billing questions, don't also give it an `search_everything` tool

### Refreshing content

- **Text/File sources**: delete and re-upload to update
- **Web sources**: set `crawlPeriod: "WEEKLY"` for auto-refresh, or use `PATCH ?refresh=true` for on-demand
- **Regular audits**: review sources quarterly; remove anything no longer relevant

## Checking Processing Status

Sources are `QUEUED` on upload, transition to `PROCESSING`, then `COMPLETED` or `FAILED`.

```bash
curl "https://knowledge.twilio.com/v2/KnowledgeBases/$KB_ID/Knowledge" \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" | jq '.knowledge[] | {name, status}'
```

The search API returns empty results until sources are `COMPLETED`. Expect processing to take seconds to minutes depending on content size.

## Listing Chunks for Debugging

If search returns poor results, inspect how Twilio chunked your content:

```bash
curl "https://knowledge.twilio.com/v2/KnowledgeBases/$KB_ID/Knowledge/$KNOWLEDGE_ID/Chunks" \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" | jq '.chunks[].content'
```

If chunks are too large or too small, restructure your markdown (more/fewer headings, shorter sections) and re-upload.

## Troubleshooting

### "Knowledge base not configured"

The KB ID env var isn't set, or the TAC memory client isn't initialized. Check `.env` and ensure `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are valid.

### Search returns no results

1. Check source status — they may still be `PROCESSING`
2. Check chunks — maybe the query doesn't match any indexed content
3. Try broader queries — semantic search works on meaning, not keywords

### LLM picks the wrong KB

1. Tighten tool descriptions — be specific about when to use each
2. Update the system prompt — add explicit disambiguation rules
3. Consider consolidating overlapping KBs

### "Request input may be invalid" on upload

The `source.type` must be `Text`, `File`, or `Web` (case-sensitive). `Text` requires `content`, `Web` requires `url`, `File` requires a multipart upload.
