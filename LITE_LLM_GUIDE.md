# LiteLLM Guide — TAC Template Integration + Testing

The template supports any **OpenAI-compatible endpoint** via the `OPENAI_BASE_URL` env var. LiteLLM, Azure OpenAI, vLLM, Ollama, Bedrock via LiteLLM — all work the same way. This guide walks two paths:

1. **[Local test](#local-test)** — run a LiteLLM proxy in Docker on your machine that routes to OpenAI. Fastest way to validate the code path works.
2. **[Production endpoint](#production-endpoint)** — real integration testing against a hosted LiteLLM gateway once you have URL + key.

Then a [verification checklist](#verification-checklist) that applies to both.

---

## What changed in the template

Four files, one env var, one optional log:

| File | Change |
|---|---|
| `src/config.ts` | Reads `OPENAI_BASE_URL` (optional) and `OPENAI_LOG_MODEL` (default `true`) |
| `src/providers/openai-chat-completions.ts` | OpenAI SDK constructor accepts `baseURL`; response `model` is logged once per completion (streaming + non-streaming) |
| `src/providers/openai-responses.ts` | Same `baseURL` support |
| `src/messaging/describeImage.ts` | Same for Vision (only if `INBOUND_MEDIA_ENABLED=true`) |
| `src/messaging/transcribeAudio.ts` | Same for Whisper (only if `INBOUND_MEDIA_ENABLED=true`) |

`.env` addition:

```
# Optional — points OpenAI SDK at any OpenAI-compatible gateway
OPENAI_BASE_URL=http://localhost:4000/v1

# Optional — silence the response-model log if it's noisy
# OPENAI_LOG_MODEL=false
```

**When `OPENAI_BASE_URL` is unset, the app behaves exactly as before** — hits `api.openai.com`. Zero-risk change for existing deployments.

---

## Local test

Best for the initial validation. Confirms the code path works before you touch any production gateway.

### 1. Run LiteLLM locally

```bash
# Ephemeral (no database — config in memory):
docker run -it --rm -p 4000:4000 \
  -e OPENAI_API_KEY=<your real OpenAI key> \
  ghcr.io/berriai/litellm:main-latest \
  --model gpt-4o-mini --port 4000

# You'll see something like:
#   LiteLLM: Proxy initialized with Config, Set models: ['gpt-4o-mini']
#   Uvicorn running on http://0.0.0.0:4000
```

Verify it's running:

```bash
curl http://localhost:4000/v1/models
# → {"data":[{"id":"gpt-4o-mini",...}], "object": "list"}

curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-1234" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
# → OpenAI-shaped response
```

Note: LiteLLM's default local mode accepts **any** bearer token in `Authorization` — set `--api_key sk-real` on the command line if you want it to enforce a specific key.

### 2. Point your TAC app at it

In your demo's `.env`:

```
OPENAI_API_KEY=sk-anything-litellm-doesnt-care
OPENAI_BASE_URL=http://localhost:4000/v1
LLM_MODEL=gpt-4o-mini
LLM_PROVIDER=openai-chat-completions
```

Restart the app:

```bash
npm run dev
```

You should see in the boot log:

```
[ChatCompletions] Initializing provider (baseURL=http://localhost:4000/v1)
```

Fire a test conversation (WhatsApp message or voice call). In the app logs you should see:

```
[ChatCompletions] response model=gpt-4o-mini (requested=gpt-4o-mini)
```

If yes: the code path works. Move to the production endpoint test.

### 3. Test multi-model routing (optional but recommended)

LiteLLM lets you define virtual model names that route to different backends. Create a `litellm-config.yaml`:

```yaml
model_list:
  - model_name: virtual-fast
    litellm_params:
      model: openai/gpt-4o-mini
      api_key: os.environ/OPENAI_API_KEY

  - model_name: virtual-heavy
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY

  # Uncomment when you want to swap in Gemini for testing the "silent swap"
  # scenario the docs warn about:
  # - model_name: virtual-fast
  #   litellm_params:
  #     model: gemini/gemini-2.0-flash-exp
  #     api_key: os.environ/GEMINI_API_KEY
```

Run:

```bash
docker run -it --rm -p 4000:4000 \
  -v $(pwd)/litellm-config.yaml:/app/config.yaml \
  -e OPENAI_API_KEY=<real openai key> \
  ghcr.io/berriai/litellm:main-latest \
  --config /app/config.yaml
```

In the app's `.env`:

```
LLM_MODEL=virtual-fast   # or virtual-heavy — the virtual name, not the underlying model
```

The app requests `virtual-fast`, LiteLLM routes to `gpt-4o-mini`, and the response `model` field logs the *actual* model that served — so you'll see:

```
[ChatCompletions] response model=gpt-4o-mini (requested=virtual-fast)
```

That's the drift-detection log doing its job. This is what you'd use in a real POC to catch silent routing changes on a production gateway.

---

## Production endpoint

Once you have a URL + key for a hosted LiteLLM gateway. Applies whether it's a customer-hosted proxy, a shared internal gateway, or anything else that speaks OpenAI at scale.

### 1. Confirm you have these from whoever owns the gateway

- Proxy URL (e.g., `https://litellm.<host>/v1`)
- Virtual API key issued for your integration
- Model name(s) exposed for you to use (may be virtual names like `<team>-fast`, or standard names like `gpt-4o-mini`)
- Confirmation that **tool calling** is enabled and tested (test with a curl before wiring the app)
- Confirmation that **streaming (SSE)** works end-to-end
- Where the proxy is hosted (region — matters for voice latency)
- Rate limits on your key

### 2. Sanity-check with curl before wiring the app

**Non-streaming, no tools:**

```bash
curl -X POST "https://litellm.example.com/v1/chat/completions" \
  -H "Authorization: Bearer <virtual key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<model name>",
    "messages": [{"role":"user","content":"hello, test"}]
  }'
```

Expect an OpenAI-shaped response. If this fails, stop and take it back to the gateway owner.

**Streaming:**

```bash
curl -X POST "https://litellm.example.com/v1/chat/completions" \
  -H "Authorization: Bearer <virtual key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<model name>",
    "messages": [{"role":"user","content":"count to 5 words"}],
    "stream": true
  }'
```

Expect `data: {...}` SSE chunks with `delta.content`. If they come as one big blob at the end, streaming isn't really working — flag it.

**Tool call:**

```bash
curl -X POST "https://litellm.example.com/v1/chat/completions" \
  -H "Authorization: Bearer <virtual key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<model name>",
    "messages": [{"role":"user","content":"what is the weather in São Paulo?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather for a city",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }],
    "tool_choice": "auto"
  }'
```

Expect `message.tool_calls[0].function.name === "get_weather"` in the response. If the model answers with prose ("I can't check live weather") instead of calling the tool, then either (a) tool routing is off in the gateway config, or (b) the underlying model is bad at tool selection. Either way, flag it before the integration goes live.

### 3. Wire the app

In your `.env`:

```
LLM_PROVIDER=openai-chat-completions
OPENAI_API_KEY=<virtual key>
OPENAI_BASE_URL=https://litellm.example.com/v1
LLM_MODEL=<model name>
```

Restart. Watch the boot log for `baseURL=https://litellm.example.com/v1`. Fire a real conversation.

### 4. Watch the response-model log for drift

Every completion will log:

```
[ChatCompletions] response model=<actual> (requested=<virtual>)
```

If `<actual>` changes across requests in the same session, LiteLLM is doing dynamic routing — flag it. If `<actual>` differs from what you expect (e.g., you asked for `virtual-fast`, LiteLLM served `gemini-2.0-flash`), that's a silent swap — get the gateway pinned to a specific underlying model for the duration of your evaluation window.

---

## Verification checklist

Run this for both the local test and the production endpoint before declaring the integration works:

- [ ] **Boot log** shows `[ChatCompletions] Initializing provider (baseURL=<url>)` — proves the env var was picked up
- [ ] **Simple response** — send "olá" via WhatsApp or voice, agent replies. Confirms basic routing works.
- [ ] **Response-model log** shows the underlying model, not the virtual name
- [ ] **Tool call fires** — trigger a KB search or any tool. Verify the tool ran (check its own logs) AND the model uses the result in its response. This is the biggest LiteLLM smoke test — a working "OpenAI compatible" gateway that silently drops tool calls is a real thing.
- [ ] **Streaming works over voice** — Lucy responds token-by-token, no big pauses between "phrase" and "next phrase". If voice feels laggy vs. GPT-4o direct, the streaming path is buffering somewhere.
- [ ] **Multi-turn context preserved** — turn 1: "meu nome é X". Turn 2: "qual meu nome?" Agent remembers. Confirms the request/response chain isn't being reset.
- [ ] **Long system prompt handled** — TAC injects Memory context on every turn. That's a big system message. Some LiteLLM/Gemini combinations truncate. Verify the agent remembers what's in the injected Memory block.
- [ ] **Groundedness holds** — ask a KB question, agent uses the KB verbatim. Then ask something clearly out-of-scope, verify it says "não sei" / escalates rather than inventing. Weaker models via LiteLLM fail this silently.
- [ ] **Handoff works** — trigger `liveAgentHandoff`, verify Studio flow fires. Handoff is a specific tool call — if tool calls work in general (previous item), this should work too, but worth confirming.
- [ ] **Latency check (voice only)** — timestamp first ASR final → timestamp first audible response. Compare against your baseline against direct OpenAI. LiteLLM adds ~50-250ms depending on hop distance. Note the delta in the POC docs.

---

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Boot log doesn't show `baseURL=...` | `.env` not reloaded OR `OPENAI_BASE_URL` misspelled | Restart, verify env var: `node -e "require('dotenv').config(); console.log(process.env.OPENAI_BASE_URL)"` |
| `401 Unauthorized` from proxy | LiteLLM is enforcing a master key you didn't set | Check LiteLLM startup logs for the key; set `OPENAI_API_KEY` to match. For a hosted gateway, ask the gateway owner for the virtual key. |
| Tool calls never fire | Underlying model is weak at tool selection OR LiteLLM strips `tools` field | curl-test the tool call directly (see Option B step 2). If it works via curl but not the app, check `openaiTools` payload in `openai-chat-completions.ts`. |
| Stream returns as one giant chunk | LiteLLM is buffering; underlying provider isn't streaming; or SSE headers wrong | curl-test the stream (see step 2 of the production endpoint section). If curl also blobs, it's the gateway — file with the owner. |
| `[ChatCompletions] response model=<X>` shows `<X>` different from requested | Silent routing on the LiteLLM side | Not necessarily broken; but flag to the gateway owner so you know what you're actually testing against |
| Latency spikes intermittently | LiteLLM cold-starting a backend OR fallback triggered | Watch the proxy dashboard — if the gateway owner exposes one — for retries/fallbacks. Adjust the latency threshold or get the gateway pinned. |
| Response `model` field is empty in log | Underlying provider doesn't return `model` (rare, some Bedrock configs) OR LiteLLM strips it | Not a functional problem; silence with `OPENAI_LOG_MODEL=false` if it's spammy. |
| Memory injection appears in transcript but agent ignores it | System messages are being collapsed/dropped by LiteLLM → provider (Gemini via LiteLLM has done this) | Test with a shorter injection. If short works, it's a token limit. If not, it's the collapse issue — file with LiteLLM/provider. |
| First LiteLLM call works, subsequent calls hang | Sticky connection issue; some Docker configs need `--http-timeout` bumped | Restart the proxy. In prod, ask their infra team about idle timeouts. |

---

## What NOT to change in the app when moving to LiteLLM

- `LLM_PROVIDER` stays `openai-chat-completions`. Do NOT set `LLM_PROVIDER=litellm` — that doesn't exist; LiteLLM speaks OpenAI, so we use the OpenAI provider with a different base URL.
- Tools stay the same. The template's `defineTool` output serializes to OpenAI-shaped JSON, which LiteLLM understands.
- Prompt stays the same. Any prompt tuning you did for GPT-4o might need re-tuning against another underlying model, but the systemPrompt.md file structure doesn't change.
- Memory + KB + handoff stay the same. All unaffected by the LLM provider.

---

## Rolling back to direct OpenAI

Unset `OPENAI_BASE_URL`:

```
# Comment or delete this line, restart:
# OPENAI_BASE_URL=http://localhost:4000/v1
```

Or override at runtime:

```bash
OPENAI_BASE_URL= npm run dev
```

Boot log will show `Initializing provider` with no `baseURL=` suffix, meaning it's back to `api.openai.com`. Zero rebuild needed.
