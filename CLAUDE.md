# Working with This Template — A Guide for AI Coding Agents

You're helping someone customize this **Twilio Agent Connect (TAC)** template into a working voice/messaging agent for their use case. This file captures patterns, gotchas, and load-bearing knowledge so you don't have to rediscover them.

Read this top-to-bottom on the first message of a TAC-related task. Then keep it in context — several gotchas have eaten multi-hour debug sessions.

For the architectural overview of what this specific template provides (channels, providers, comparison to a vanilla Express app), see `README.md` and `ARCHITECTURE.md` in this directory. This file is the **practical operator's manual** — what to do, what to avoid, how to ship.

---

## 0. What is TAC?

TAC is a Twilio SDK that wires three primitives together:

1. **Conversation Orchestrator (CO/Maestro)** — channel-agnostic conversation lifecycle, profile resolution, capture rules. IDs look like `conv_conversation_*`.
2. **Conversation Memory (Memora)** — persistent customer profiles, traits, observations, summaries. Store IDs look like `mem_store_*`.
3. **Conversation Intelligence (CI)** — language operators (sentiment, summary, script adherence, custom GenAI) that run on conversation transcripts. Operator IDs look like `intelligence_operator_*`.

TAC also provides:
- Channel adapters: `VoiceChannel` (ConversationRelay WebSocket), `WhatsAppChannel`, `SMSChannel`
- API clients: `ConversationClient`, `MemoryClient`, `KnowledgeClient`
- Tool plumbing: `defineTool`, `executeTool`, OOTB helpers like `createStudioHandoffTool` and `createKnowledgeSearchTool`

SDKs ship for TypeScript (`twilio-agent-connect@^1.0.0`) and Python. This template is TypeScript; default to TypeScript unless the user explicitly asks for Python.

The official TAC SDK lives at [github.com/twilio/twilio-agent-connect-typescript](https://github.com/twilio/twilio-agent-connect-typescript). When the docs don't match what you see, that repo's README + examples are the source of truth.

---

## 1. Spinning Up a Working Instance

### 1.1 Required Twilio resources

Before code, the account needs:

| Resource | How | Why |
|---|---|---|
| **Conversation Configuration** | Console → CO → Configurations → New. Pick channels (Voice + WhatsApp typically). Attach a Memory Store and Intelligence Configuration if available. | The "config" that ties channels + memory + CI together. ID is `conv_configuration_*`. |
| **Memory Store** | Console → Customer Memory → Stores → New. Set trait groups (e.g. `Contact`). | Where customer traits, observations, summaries live. ID is `mem_store_*`. |
| **Intelligence Configuration** | Console → CI → Configurations → New. Add operators (Summary, Sentiment, Script Adherence, plus customs). Attach to the conversation config. | Defines what CI runs on every conversation. ID is `intelligence_configuration_*`. |
| **API Key + Secret** | Console → API Keys → New (Standard). **Not the Auth Token** — use API Keys for REST calls. | Twilio's recommended credential. Format `SK...` + secret. |
| **Voice phone number** | Console → Phone Numbers → Buy a number. Set Voice URL to `/twiml` once deployed. | Inbound call entry. |
| **WhatsApp Sender** | Console → Messaging → Senders → WhatsApp. Requires Meta Business approval. | Inbound WhatsApp. Format `whatsapp:+...`. |
| **Studio Flow** (optional) | Console → Studio → New Flow. For handoff to Flex. | Triggered via REST when an agent needs to escalate. |

### 1.2 Minimum `.env`

```
# Required
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_API_KEY=SK...
TWILIO_API_SECRET=...
TWILIO_PHONE_NUMBER=+1...
TWILIO_WHATSAPP_NUMBER=whatsapp:+1...
TWILIO_CONVERSATION_CONFIGURATION_ID=conv_configuration_...

# LLM
OPENAI_API_KEY=sk-...
LLM_PROVIDER=openai-chat-completions   # or openai-responses, openai-agents, langflow
LLM_MODEL=gpt-4.1

# Deployment
TWILIO_VOICE_PUBLIC_DOMAIN=your-domain.com  # NO protocol, NO path
PORT=3000
```

### 1.3 Local dev loop

```bash
# Tunnel
ngrok http 3000        # paid plan reserved domain recommended

# Wire Twilio Console webhooks once:
#   Voice number → https://<your>.ngrok.app/twiml
#   WhatsApp Sender → https://<your>.ngrok.app/inbound-message (if media handling)
#   Conversations v1 service → https://<your>.ngrok.app/conversations-webhook (if v1 mode)

npm install
npm run dev
```

---

## 2. Architecture Patterns

Default patterns for new builds. Adjust based on what the user actually needs.

### 2.1 Data layer: customer data via system-of-record

Pick an external data store for customer/order/contract data — Airtable, a real database, an internal API, whatever fits. Two rules:

1. **Never put data layer credentials in client-side code.** If using Airtable, route through a Twilio Function that holds the PAT server-side and exposes a `?phone=+...` endpoint.
2. **Key on `phone` in E.164 format.** This is the lingua franca across Twilio + Memora + most CRMs. ASCII-only field names; the field name IS the API key.

### 2.2 Memory layer: Memora

Always use it for any non-trivial deployment. The TAC SDK exposes `tac.getMemoryClient()`. Critical patterns:

- **Lookup by phone**: `POST /v1/Stores/{storeId}/Profiles/Lookup` with `{"idType":"phone","value":"+...."}`
- **Write observation**: `POST /v1/Stores/{storeId}/Profiles/{profileId}/Observations` with `{"observations":[{"content":"...","source":"...","occurredAt":"<ISO>"}]}`
- **`occurredAt` is REQUIRED** despite the SDK signature suggesting otherwise — set it to `new Date().toISOString()`
- SDK 1.0.x `createObservation` has historically sent the wrong body shape (legacy `{content, source}`). Verify against the current SDK; if needed, POST directly via `fetch` until patched.

### 2.3 LLM provider choice

Four providers are wired in this template:

| Provider | Use when |
|---|---|
| `openai-chat-completions` | Default. Most predictable, tight tool integration. |
| `openai-responses` | When you want the Responses API features. |
| `openai-agents` | OpenAI Agents SDK if the customer is already building there. |
| `langflow` | Visual flow brain — flow owns prompt + tools + knowledge. TAC injects memory + channel context as prepended `[Context]` block. **TAC's `tools` array is IGNORED when using Langflow — tools live inside the flow.** |

For demos where the customer wants visual control over agent logic, default to Langflow. For tight engineering integration with OOTB tools, default to `openai-chat-completions`.

### 2.4 Human handoff: Studio Flow → Flex

The OOTB `createStudioHandoffTool` (Maestro mode) wires this automatically for `openai-*` providers. For Langflow, build a Custom Component that POSTs to Studio Executions.

The Studio Flow needs:
- Trigger: `incomingRequest` (REST) for messaging, `incomingCall` for voice
- Parameters: `HandoffData` containing `conversationId` AND `attributes` (object, not stringified)
- The flow's Send-to-Flex widget reads `attributes` via `| to_json` filter — this becomes the Flex task's attributes

---

## 3. Tools — How to Build Them

### 3.1 TAC native tools (for openai-* providers)

```ts
import { defineTool } from 'twilio-agent-connect';

const lookupTool = defineTool(
  'lookup_customer_X',                  // tool name — matches what prompt references
  'Description for the LLM...',          // PRIMARY signal for tool selection
  {                                      // JSON Schema for arguments
    type: 'object',
    properties: {
      customer_phone: {
        type: 'string',
        description: 'E.164 format, e.g. +1...',
      },
    },
    required: ['customer_phone'],
  },
  async (params) => { /* implementation */ },
);
```

**Tool description rules** (these matter a lot for LLM tool-use accuracy):

1. **Specific trigger words**: list the actual products/topics the LLM should match on. Vague = unused.
2. **Both positive AND negative triggers**: "Use FOR X, Y, Z. DO NOT USE for A — those go to `liveAgentHandoff`."
3. **Forbid hallucination explicitly**: "Use values returned by the tool VERBATIM. Don't invent."
4. **Tool name must match the prompt's references exactly** — the LLM picks by name.

For tools that need TAC state (the `TAC` instance or per-session context), wire via the extension hooks on `createApp`:
- `buildDynamicTools(tac)` — once at startup; good for KB search (needs `tac.getKnowledgeClient()`)
- `buildSessionTools(tac, session)` — per-conversation; good for tools that need the active `ConversationSession` (e.g., runtime guards like "refuse `send_voice_cta` when channel is already `voice`")

### 3.2 Langflow Custom Components (for langflow provider)

If using Langflow, write tools as Custom Components in Python. Standard pattern:

```python
from langflow.custom import Component
from langflow.inputs import StrInput, SecretStrInput
from langflow.template import Output
from langflow.field_typing import Tool


class MyTool(Component):
    display_name = "..."
    description = "..."
    icon = "search"
    name = "MyTool"

    inputs = [
        # Configurable per-instance — credentials, IDs, customization
        SecretStrInput(name="api_key", display_name="API Key", required=True),
        StrInput(name="resource_id", display_name="Resource ID", required=True),
        # ALWAYS expose tool_name + tool_description as instance inputs
        StrInput(name="tool_name", display_name="Tool Name", value="default_name"),
        StrInput(name="tool_description", display_name="Tool Description", value="..."),
    ]

    outputs = [Output(name="tool", display_name="Tool", method="build_tool")]

    def build_tool(self) -> Tool:
        import requests
        from pydantic import BaseModel, Field
        from langchain_core.tools import StructuredTool

        # Capture self.* into closure variables once
        api_key = self.api_key
        # Capture session_id for tools that need TAC's conversationId
        captured_session_id = (
            getattr(self, "session_id", None)
            or getattr(getattr(self, "graph", None), "session_id", None)
        )

        class Input(BaseModel):
            arg: str = Field(description="...")  # description tells LLM what to pass

        def run(arg: str) -> str:
            try:
                resp = requests.post(url, headers={...}, json={...}, timeout=15)
            except requests.exceptions.RequestException as e:
                return f"Network error: {e}"
            if not resp.ok:
                # CRITICAL: surface the actual response body, not just status
                return f"Error {resp.status_code}: {resp.text}"
            data = resp.json()
            return format_response(data)  # natural-language string for the LLM

        return StructuredTool.from_function(
            name=self.tool_name,
            description=self.tool_description,
            func=run,
            args_schema=Input,
        )
```

**Common Custom Component patterns:**

- **Knowledge search**: Use Twilio Enterprise Knowledge API `POST /v2/KnowledgeBases/{kb_id}/Search` with `{query, top}` — needs `TWILIO_API_KEY_SID` + `TWILIO_API_KEY_SECRET` Global Variables
- **Airtable lookup**: GET `https://api.airtable.com/v0/{base}/{table}?filterByFormula={phone}='...'&maxRecords=1` with Bearer PAT
- **Send WhatsApp template**: POST `/2010-04-01/Accounts/{sid}/Messages.json` with `ContentSid` and (optionally) `ContentVariables`
- **Memora observation writer**: lookup profile → POST observation as shown in 2.2
- **Studio Flow handoff**: POST `/v2/Flows/{flow_sid}/Executions` with `Parameters` JSON containing `HandoffData.{conversationId, attributes}`

**Saving Custom Components for reuse across flows:**

Drop `.py` files in `LANGFLOW_COMPONENTS_PATH` (mount via persistent volume), restart Langflow, every flow's component picker sees them under a custom category. This beats Langflow's UI "Save Component" because it's version-controllable and survives Langflow rebuilds.

### 3.3 OOTB tools (when using openai-* providers)

- `createKnowledgeSearchTool(knowledgeClient, kbId, {name, description, topK})` — Twilio Enterprise Knowledge wrapper. Sync version; needs `tac.getKnowledgeClient()`. Wire via `buildDynamicTools`.
- `createKnowledgeSearchToolAsync(knowledgeClient, kbId, config?)` — async version that auto-fetches KB metadata to derive `name`/`description` defaults.
- `createStudioHandoffTool(tac, session, {name: 'liveAgentHandoff'})` — Studio Flow REST trigger; auto-injects HandoffData. **Auto-wired by `createApp` when `MESSAGING_MODE=maestro`** — no manual registration needed in that mode.

---

## 4. Prompt Patterns

The system prompt is where most of the agent's behavior actually lives. Patterns that work:

1. **Language enforced first**: `- All responses MUST be in <locale>.` LLMs drift to English easily on non-English tasks.
2. **Persona + objective**: one paragraph naming the assistant and what they help with.
3. **Channel awareness block**: tell the model how to adapt for `voice` vs `whatsapp|sms|chat`. Voice = no markdown/emojis/lists, short sentences, spell out long numbers. Messaging = markdown OK, emojis sparingly.
4. **Multimedia content prefixes**: customer's audio comes prefixed `[audio transcribed] ...`; images come as `[image received] ...`. Tell the model how to treat each.
5. **Customer identity via Memora**: instruct the model to use the `[Memory]` block, greet by first name *when natural* (don't prefix every message), don't ask for data already there.
6. **Tools section** with concrete triggers and "use it BEFORE answering from memory" framing.
7. **Tone and constraints**: write 4-6 explicit constraints. The compliance / hallucination-prevention ones are load-bearing.

For voice/WhatsApp channel switching in the same conversation, **the `Current communication channel: <channel>` system message is appended on every channel change**. `addSystemContext` is append-only — without a "supersede" hint, the model anchors on the older marker. The hardened pattern is to include in the new injection:

> "Communication channel switched from "X" to "Y". IGNORE any earlier 'Current communication channel:' line — only the most recent one is authoritative."

---

## 5. Content Templates & WhatsApp Quirks

Twilio's Content API at `POST https://content.twilio.com/v1/Content`. Template types:

| Type | Use case | Notes |
|---|---|---|
| `twilio/text` | Plain text with variables | Variables `{{1}}`, `{{2}}` work |
| `twilio/call-to-action` | Button (URL, PHONE, VOICE_CALL) | `VOICE_CALL` opens in-WhatsApp voice call to the same sender. **In-session sends work unapproved.** |
| `twilio/quick-reply` | Customer taps preset reply | In-session works unapproved |
| `twilio/card` | Header + body + buttons | Approval often needed |
| `twilio/pay` | **WhatsApp Pay (Pix in BR)** | **REQUIRES Meta approval AND WhatsApp Pay enablement on the WABA**. Even in-session. Plan around this. |

**`twilio/pay` gotchas — read before using:**

- **Approval requirement is HARD** — every send returns `63013 Channel policy violation` until the template is approved AND WhatsApp Pay is enabled on the WABA via Meta. No in-session bypass like `twilio/call-to-action` enjoys.
- **`order_expiration` is BAKED in at template creation**. `Math.floor(Date.now()/1000) + 3600` means every send after 1 hour fails as expired. Either omit the field or set it 1+ years out.
- **Body variables `{{1}}` are NOT honored** by `twilio/pay` like they are by `twilio/text`. You get `21656 Content Variables invalid`. Hardcode the body.
- **All amounts must agree**: `items[i].amount × quantity`, `subtotal_amount`, `total_amount`, AND any embedded payment-code amount (e.g., Pix BR Code EMV tag 54). Any mismatch is a 63013.
- **Pix BR Code parsing**: TLV format. Tag `54` = amount, tag `26` sub-tags `00` = key type marker / `01` = key value, tag `58` = country, tag `59` = merchant name.

**Error codes you'll see:**

| Code | Meaning | Fix |
|---|---|---|
| 21656 | Content Variables invalid | Template type doesn't support body variables, or variable name mismatch |
| 63013 | Channel policy violation | `twilio/pay`: check `order_expiration`, then approval status |
| 63016 | Outside session window | Customer hasn't messaged in 24h. Need approved template. |
| 63017 | Rate limit / Channel doesn't support content type | Check WABA capabilities |
| 63029 | Receiver failed to download | Bad media URL or unreachable button URL |

---

## 6. Memora Observation Hygiene

Observations are recalled across conversations — so wording matters more than people expect.

**Real-world bug**: A tool wrote *"Received CTA via WhatsApp at X. Awaiting call to reschedule."* When the customer actually called back hours later, the agent's recall surfaced *"Awaiting call"* (present tense, pending) and the agent told the customer to "tap the button" — even though the call had just arrived.

**Rules:**
1. Write observations in **past tense**, factual: "Received CTA at X. Button sent to initiate voice call."
2. Avoid pending-state phrasing ("awaiting", "pending", "expecting") unless it's still genuinely true after the conversation ends.
3. **Add temporal anchoring**: include the date so future-agent knows it's old context.
4. The **`source` field** is your filtering key — use a `{brand}-{flow}` pattern like `<app>-negotiation`, `<app>-after-hours`, `<app>-payment-recovery`. Helps cleanup scripts and CI operator filters.
5. Build a cleanup script for stale observations early — they accumulate across testing and you don't want recall poisoned by old test data.

---

## 7. Conversation Intelligence — Custom Operators

For dashboards, enrichment, and quality scoring. Configure via Console or `POST /v3/ControlPlane/Operators`.

**Schema rules** (these will silently break you):

- Root `type` must be `"object"`
- Supported types: `string`, `number`, `boolean`, `integer`, `object`, `array`, `enum`, `anyOf`
- Max 100 properties, 5 nesting levels, 500 enum values total
- **Twilio AUTO-SETS `additionalProperties: false` AND marks ALL fields as `required`**. Don't include `required` arrays — they're silently overwritten. Every field becomes mandatory.
- Unsupported keywords: string `minLength|maxLength|pattern|format`, number `minimum|maximum|multipleOf`, array `minItems|maxItems|uniqueItems`, object `additionalProperties|patternProperties|minProperties|maxProperties`
- 8800 char output cap. Flatten nesting. Avoid redundant fields (LLM has to output them all and risks inconsistency).
- Properties returned in same order as schema keys.

**Script Adherence** is the built-in operator for "did the agent follow the playbook?". Each category gets a name + description; the underlying GenAI evaluator scores `adhered` / `not_adhered` / `not_applicable`. Six categories is the practical upper bound — beyond that, per-category quality drops. Configure via Console (safer than API PATCH on the rules array, which has overwrite risks).

**Custom GenAI operator example** (analytics enrichment):

```json
{
  "displayName": "...",
  "description": "...",
  "outputFormat": "JSON",
  "prompt": "Analyze the transcript. Identify...",
  "outputSchema": {
    "type": "object",
    "properties": {
      "items": {
        "type": "array",
        "items": { "type": "object", "properties": { "field": { "type": "string" } } }
      }
    }
  }
}
```

**PII Redaction** is a Service-level toggle (Intelligence Service config), not a per-rule operator. Auto-redacts Address, CVV, City, Country, CreditCard, CreditCardExpiration, DOB, Date, Email, Name, PhoneNumber, SSN, ZipCode from transcripts. One checkbox; strong compliance story for regulated industries. Note: also masks Custom GenAI Operator results by default — fetch with `?Redacted=false` to see the raw JSON.

**Triggers**:
- `COMMUNICATION` — fires once per communication. For voice, ConversationRelay writes one communication per TTS fragment, so this multiplies operator cost. Avoid for summaries.
- `CONVERSATION_END` — fires when CO conversation hits `CLOSED`. Right choice for summaries, sentiment, script adherence.
- (Console UI) "Conversation moved to inactive" — useful for messaging handoff cases where INACTIVE is the natural pre-CLOSED state.

For voice, configure the Voice channel "Closed" timeout to "On hangup" so conversations close at call end and CI operators fire.

---

## 8. Flex Plugin for Customer Context (when applicable)

When agents pick up handoff tasks in Flex, they need customer context immediately.

**Architecture:**
- Twilio Function proxies the data layer (PAT/API keys stay server-side)
- Flex Plugin reads `task.attributes` (set by Studio Flow's Send-to-Flex from `HandoffData.attributes`)
- Plugin fetches data, renders a tab in `TaskCanvasTabs`

**Minimum plugin structure:**

```
plugin-X/
├── package.json           # @twilio/flex-plugin-scripts ^7.1
├── public/appConfig.js    # accountSid required (real SID, not placeholder)
├── src/
│   ├── index.ts           # loadPlugin(MyPlugin)
│   ├── MyPlugin.tsx       # adds tab to TaskCanvasTabs
│   ├── api/fetchX.ts      # calls the Twilio Function
│   └── components/...     # Paste-styled tab content
```

`MyPlugin.tsx`:

```tsx
flex.TaskCanvasTabs.Content.add(
  <Flex.Tab key="my-tab" uniqueName="my-tab" label="Customer">
    <Theme.Provider theme="default">
      <MyTabContent />
    </Theme.Provider>
  </Flex.Tab>,
  {
    sortOrder: -1,
    if: (props) => Boolean(props.task?.attributes?.customer_phone),
  },
);
```

**Gotchas:**

- **`appConfig.js` `accountSid` must be the real SID** — placeholder breaks Flex on boot (`/v1/Configuration/Public` 400)
- **`FLEX_APP_*` env vars** are inlined at build time. Use `FLEX_APP_FUNCTIONS_BASE_URL` for the serverless URL.
- **Deploy + release**: `npm run deploy` registers the version; `twilio flex:plugins:release --plugin name@version --name "..." --description "..."` activates it on Flex. Both steps required.
- **Em-dashes in changelog/description break the deploy** — use plain ASCII (`-` not `—`).
- **Paste version**: Flex 2.x bundles Paste 15. `description-list` and some icons aren't deep-importable; use manual label/value rows.
- Set a `SHOW_TAB_ALWAYS = true` toggle for local dev so you can verify rendering without triggering a real handoff.

---

## 9. Deployment (Fly.io is the opinionated default)

For voice quality, the app **must be in `iad` (us-east-1)** — Twilio's ConversationRelay is hosted there and the LLM streaming RTT is the dominant latency cost. Deploying in São Paulo for "closer to Brazilian users" actually makes voice worse because the user→app path goes through CRelay anyway.

If using a different platform (Render, Railway, Vercel functions, Kubernetes, etc.), the principles transfer: long-running process, WebSocket support, sticky sessions if scaling horizontally, `iad`-equivalent region.

### 9.1 Standard Fly app for TAC

```toml
app = "your-app"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "3000"
  NODE_OPTIONS = "--max-old-space-size=800"   # ~80% of VM memory
  TWILIO_VOICE_PUBLIC_DOMAIN = "your-app.fly.dev"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "off"                  # voice can't tolerate cold start
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

[[vm]]
  size = "shared-cpu-2x"
  memory = "1gb"
```

Dockerfile pattern: two-stage (Node 20 Alpine builder → tini PID 1 + non-root + drop devDeps).

### 9.2 If running Langflow on Fly too

Langflow is stateful (Postgres + volume). Different `fly.toml` shape. Key gotchas:

- **`LANGFLOW_HOST=::` will crash with Python `gaierror`**. Bind IPv4 (`0.0.0.0`).
- **flycast LB can reach IPv4 backends** despite IPv6-only DNS. Fine.
- **`force_https = true` on a flycast endpoint causes 301→HTTPS redirects that break plain-HTTP internal calls**. Set `force_https = false` on Langflow's services block if using flycast for internal traffic.
- **`LANGFLOW_AUTO_LOGIN=true`** removes the API key requirement but ONLY safe if the public URL is closed off (release public IPs, expose only via flycast or a Cloudflare Access proxy). When forced, an external auth layer (Caddy basic_auth, Cloudflare Access) is mandatory.
- **`LANGFLOW_SECRET_KEY` MUST be a Fernet key** (32 random bytes urlsafe-base64 encoded — 44 chars). Generate with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '\n'`. Hex keys (from `openssl rand -hex 32`) fail credential encryption silently in 1.9+.
- **Pin the image tag** — `:latest` and rolling `:2-alpine`-style tags have bitten teams with schema migrations and basic_auth syntax changes. Use `langflowai/langflow:1.9.0` or whatever specific version is being tested. Back up Postgres before upgrades.

### 9.3 Internal-only Langflow access

When TAC + Langflow are in the same Fly org, use internal networking and skip the public proxy:

- `LANGFLOW_BASE_URL=http://langflow-app.flycast` (no port — flycast LB maps to `internal_port`)
- OR `LANGFLOW_BASE_URL=http://langflow-app.internal:7860` (direct machine IPv6, bypasses LB)
- **Never** `https://` with `.flycast` / `.internal` (no TLS) and **never** `:7860` with `.flycast` (LB on port 80)

For UI access, `fly proxy 7860 --app langflow-app` opens an authenticated tunnel — leave it running, hit `http://localhost:7860` in your browser. AUTO_LOGIN=true means no login screen.

**Multi-machine Langflow without shared state**: Fly volumes are per-machine, so scaling to `count > 1` gives each machine its own SQLite DB. The flow only exists on the machine where it was saved → intermittent 404s on the others. Either keep `count = 1` OR use Postgres via `LANGFLOW_DATABASE_URL` so both machines share state.

---

## 10. Common Gotchas Hall of Fame

Things that have eaten >1 hour of debugging time.

### 10.1 Channel-switch supersede

`addSystemContext` is append-only on every provider. When WhatsApp→voice (e.g., a Content Template VOICE_CALL button), naïvely injecting `Current communication channel: voice` leaves the prior `whatsapp` line in place. Model anchors on the older one and outputs "tap the button" on a voice call.

**Fix**: in `app.ts`, when channel changes, inject:

```
Communication channel switched from "<prev>" to "<new>". IGNORE any earlier
"Current communication channel:" line — only the most recent one is authoritative.
Current channel: <new>.
```

### 10.2 ESM `require()` is a silent bomb

The template is `"type": "module"`. Any `require('crypto')` or similar will throw `ReferenceError: require is not defined` at runtime in unrelated debug paths. Search for stray `require(`.

### 10.3 Conversation Orchestrator duplicate AI_AGENT participants

If the Conversation Configuration has `conversationsV1Bridge` enabled, CO creates a shadow agent participant on the v1 side that often lacks channel address bindings. TAC's `WhatsAppChannel.sendResponse` picks the first AI_AGENT it finds — often the broken one — and gets a 400: *"Participant X does not have an address on channel WHATSAPP"*.

**Fix options**: disable the v1 bridge on the configuration, OR patch TAC to filter agents by `addresses[channel]` match. Disabling the bridge is the demo-friendly path.

### 10.4 Voice TTS duplicated tokens

"Re-foi remarcado" sounds like duplicated tokens, but is usually TTS chunk-boundary stutter, not actual duplication. Verify with `VOICE_STREAM_DEBUG=true` (taps the raw provider stream + post-buffer stream). If both logs show "foi" once but you hear "re-foi", it's TTS. Mitigation: buffer at clause/sentence boundaries instead of word boundaries, but visit only if measurably impactful.

### 10.5 Payment template amounts must match EXACTLY

Per-item amount × quantity, subtotal, total, AND any embedded payment code (Pix BR Code EMV tag 54 in BR; bank routing/account amounts in other regions). Off by 1 cent = `63013`.

### 10.6 Langflow Postgres rebuilds wipe everything

Every time someone destroys + recreates the Langflow Fly app, the new Postgres has no flows. **Always export flow JSON** (Langflow UI → kebab → Download Flow) after meaningful changes. Keep exports in `infra/langflow/flows/` in the repo. Treat Postgres as cache.

### 10.7 zsh chokes on `?` when sourcing `.env`

`WELCOME_GREETING=...help you today?` makes `source .env` print `no matches found: today?`. Wrap the value in double quotes in the `.env` to silence it. dotenv strips the quotes at app load time.

### 10.8 Twilio API delete patterns

- `DELETE /v1/Stores/{storeId}/Profiles/{profileId}/Observations/{observationId}` — observations
- `DELETE /v2/Conversations/{Sid}` — conversations (async)
- `PUT /v2/Conversations/{Sid}` with `{"status":"CLOSED"}` (JSON, uppercase status) — gentler than delete; closes for handoff/cleanup
- `DELETE /v1/Services/{sid}` — Serverless services

Build cleanup scripts EARLY. Tested conversations accumulate fast and start breaking things (e.g., 413 on `GET /v2/Conversations/` when Studio's HTTP widget tries to list).

### 10.9 Studio Flow handoff requires the right HandoffData shape

Studio Flows wired for TAC's OOTB handoff helper expect `Parameters.HandoffData.conversationId` (used in the messaging path's `GET /v2/Conversations/...` lookups) AND `Parameters.HandoffData.attributes` (Flex task attributes via `| to_json`). Missing `attributes` = handoff lands but the Flex task has no useful context. Langflow Custom Components need to capture `self.session_id` or `self.graph.session_id` to fill `conversationId`.

### 10.10 CI Operators auto-mark everything as required

A CI Custom Operator with optional fields declared via `required: [...]` will have that array silently replaced — Twilio marks EVERY property as required. So "optional" fields force the LLM to emit them (empty string usually). Design the schema accordingly. Don't bother including `required` arrays.

### 10.11 Memora traits are schema-strict

Memory store trait groups have a registered schema. The Create Profile (POST) endpoint silently drops unknown traits; the Patch (PATCH) endpoint hard-rejects with `400 Trait not registered for this service: <Group>.<trait>`. If a Custom Component writes `Contact.name` but the schema defines `firstName/lastName/fullName`, every PATCH fails. Inspect the schema with `GET /v1/ControlPlane/Stores/{storeId}/TraitGroups` before assuming field names.

### 10.12 Memora read-after-write lag

Observations written via POST aren't immediately readable via the list endpoint — there's a 0.5-3s lag while the index updates. Tools that write an observation and then expect a subsequent tool (in the same agent turn) to read it will see an empty list. Either poll for visibility before returning, or use a different pattern (e.g., pass state via tool return value, not via Memora roundtrip).

---

## 11. Operational Habits

### 11.1 Build these scripts early

| Script | Why |
|---|---|
| `seed-<resource>.ts` | Idempotent persona seed for demo data layer. Reruns reset state. |
| `cleanup-closed-conversations.ts` | Bulk delete CLOSED conversations to keep list calls fast |
| `cleanup-stale-observations.ts` | Remove observations matching a content pattern (e.g., outdated wording poisoning recall) |
| `create-<template>-template.ts` | Content Template creator per use case |

### 11.2 Demo persona convention

Pick one canonical test persona (phone + name) and reuse it across deployments in the same Twilio account. Memora is shared per-store; reusing the persona means the memory context stays coherent across testing, which makes cross-feature testing easier. Document the persona somewhere obvious (e.g., a `PERSONA.md`) so seed scripts and team members agree on the values.

### 11.3 Environment hygiene

- Different `PORT=` per app instance so they can run in parallel locally
- Same Twilio account credentials across instances (set once in `.env`)
- Customer/use-case-specific values appended at the bottom of `.env` under a `─── X overrides ───` divider
- Wrap any value containing `?` in double quotes (see gotcha 10.7)

### 11.4 Avoid these failure modes

- **Don't recommend a `twilio/pay` (or any payment-template) flow as a demo finale unless approval is in hand**. Plan around 63013.
- **Don't skip the 60s wait after Langflow boot**. The proxy errors during boot are not real failures.
- **Don't ignore observation source tagging** — you'll regret it during cleanup.
- **Don't put real secrets in flow JSON exports** — they get committed. Use Langflow Global Variables (which read `LANGFLOW_*` env vars on the Langflow side).
- **Don't use the rolling `:latest` or `:2-alpine` Docker tags in production** — pin the version (see 9.2).

---

## 12. Quick-reference command cheatsheet

```bash
# Close a CO conversation
curl -X PUT "https://conversations.twilio.com/v2/Conversations/$CONV_ID" \
  -u "$TWILIO_API_KEY:$TWILIO_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"status":"CLOSED"}'

# Get Memory Store ID from Conversation Configuration
curl -u "$TWILIO_API_KEY:$TWILIO_API_SECRET" \
  "https://conversations.twilio.com/v2/Configurations/$TWILIO_CONVERSATION_CONFIGURATION_ID" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('memoryStoreId'))"

# Inspect a Memory Store's trait schema (find trait field names)
curl -u "$TWILIO_API_KEY:$TWILIO_API_SECRET" \
  "https://memory.twilio.com/v1/ControlPlane/Stores/$STORE_ID/TraitGroups" | python3 -m json.tool

# Look up a customer profile by phone
curl -X POST -u "$TWILIO_API_KEY:$TWILIO_API_SECRET" \
  "https://memory.twilio.com/v1/Stores/$STORE_ID/Profiles/Lookup" \
  -H "Content-Type: application/json" \
  -d '{"idType":"phone","value":"+1..."}'

# Look up Airtable record by phone (when using Airtable for data layer)
curl -G "https://api.airtable.com/v0/$BASE/$TABLE" \
  -H "Authorization: Bearer $PAT" \
  --data-urlencode "filterByFormula={phone}='+1...'" \
  --data-urlencode "maxRecords=1"

# Inspect Pix BR Code amount (BR only)
python3 -c "
code = 'YOUR_PIX_CODE'
i = 0
while i < len(code):
    tag = code[i:i+2]; ln = int(code[i+2:i+4]); val = code[i+4:i+4+ln]
    if tag == '54': print('amount:', val); break
    i += 4 + ln
"

# Fly proxy to a private Langflow UI
fly proxy 7860 --app <langflow-app>
# then open http://localhost:7860

# List Langflow flows (from inside the Langflow container)
python -c "
import urllib.request, json
data = json.loads(urllib.request.urlopen('http://localhost:7860/api/v1/flows/').read())
for f in data: print(f.get('id'), '-', f.get('name'))
"
```

---

## 13. When to push back on the user

Patterns where the right answer is "actually, don't":

- **"Can we just use the Auth Token?"** → No, use API Key + Secret. That's Twilio's recommendation and what all template patterns assume.
- **"Can we use Date.now() in a Workflow script?"** → No, Workflow scripts forbid it for resume semantics. Pass timestamps in via `args`.
- **"Can we ship `twilio/pay` for a demo without approval?"** → No (almost certainly). 63013 every time. Use `twilio/text` or `twilio/call-to-action` with the payment instructions/code as text.
- **"Let's reuse a single Langflow flow across two different use cases."** → No, duplicate the flow per use case. Tool descriptions are use-case-specific and you can't parameterize the Prompt component cleanly enough.
- **"Can we deploy in São Paulo / Sydney / wherever for our local users?"** → No, `iad` for voice latency. CRelay is us-east-1; non-iad regions add a perceptible RTT penalty on voice.
- **"Skip approval for the demo, send it in-session."** → For `twilio/call-to-action` and `twilio/quick-reply` yes; for `twilio/pay` no.
- **"Let me use my Auth Token in a frontend / Flex plugin / browser."** → No. PAT/API keys/auth tokens NEVER ship to the client. Route through a Twilio Function or serverless proxy.

---

## 14. What this guide deliberately doesn't cover

- **Twilio Console UI specifics** — the Console changes; rely on the API + docs for anything that needs to be reproducible.
- **Specific industry compliance** (HIPAA, PCI-DSS, GDPR/LGPD, FINRA) — the patterns here are demo/PoC-grade. Production deployments in regulated industries need separate compliance review.
- **Custom AI/LLM tuning** — fine-tuning models, training embeddings, RAG architecture beyond Knowledge Base lookup. Those are downstream of getting the agent working at all.

---

## End

When you finish a task that surfaces a new gotcha or pattern, propose adding it to this file. Operational knowledge that took an hour to figure out should not require another hour for the next person.
