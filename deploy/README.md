# Deploying Conversation Relay (TAC) to the cloud

This guide is for adopters of the template who want to take their working local setup and run it somewhere that isn't `ngrok` on a laptop. **Almost nothing about the application has to change** — the deployment work is mostly about giving the app a stable URL, a way to read secrets, and a container host that supports WebSockets.

> **TL;DR**: Build the `Dockerfile` at the repo root, deploy that image to any host that supports long-lived WebSocket upgrades + a stable HTTPS URL. The supplied per-provider configs in this directory are starting points, not requirements.

---

## What the application needs from any host

| Requirement | Why | Hosts this rules out |
|---|---|---|
| **Long-lived WebSocket support** | ConversationRelay opens a WSS to `/ws` and keeps it open for the entire voice call — minutes, sometimes longer. | Vercel / Netlify Functions, Cloudflare Workers, Cloud Run beyond 60-min cap, Lambda. |
| **Stable HTTPS URL with custom domain** | Twilio's `X-Twilio-Signature` is computed against the full URL, and your TwiML / webhooks reference it. Per-deploy ephemeral subdomains break webhook signature validation and force Twilio Console re-configuration on every deploy. | Anything where the URL changes per deploy unless you pin a custom domain. |
| **Always-on (or near-zero cold start)** | A voice call that hits a cold container fails before the WebSocket handshake completes. Messaging tolerates 1–2s warm-up; voice does not. | Aggressively scale-to-zero serverless platforms without a `min-instances=1` config. |
| **Egress to OpenAI, Twilio, Airtable** | LLM streams, Twilio REST, optional Airtable / Dynamics365 lookups. | Hosts with low egress caps on hobby tiers. |
| **No database, no queue, no file storage** | Memora handles persistence; everything else is stateless or in-memory. | Nothing — this is a *simplifier*. |

If the host you're considering ticks all five, the rest is preferences (cost, region, ergonomics).

---

## What changes vs your local setup

The honest list, for a single-instance deployment:

| Local today | Cloud |
|---|---|
| `ngrok http 3000` | Stable custom domain. Point its DNS at the host. |
| Local `.env` file | Host's secret manager / env-var UI. **Never bake secrets into the image.** |
| `TWILIO_VOICE_PUBLIC_DOMAIN=<your>.ngrok.app` | `TWILIO_VOICE_PUBLIC_DOMAIN=<your custom domain>` |
| Twilio webhooks pointing at the ngrok URL | One-time: update the same webhooks in the Twilio Console to point at the deployed domain. |
| `npm run dev` | `npm start` (or `node dist/index.js` — same thing, baked into the container). |

That's the entire delta. **No code changes** for the median customer.

The application's own architecture — providers, tools, prompts, channels, memory recall, debouncing, the inbound-media side-channel — all stay exactly as they are.

---

## When you DO need code changes

The only scenario that forces a code change is **horizontal scaling beyond a single container instance**.

The reason is in [`src/app.ts`](../src/app.ts): per-conversation state (`memoryByConversation`, `lastChannelByConversation`, `debounceStates`, the LLM provider closures) lives in process memory. Two containers behind a round-robin load balancer will not be able to share that state, which breaks debouncing, channel-context injection, and the memory recall cache.

There are two solutions, and **you don't need either of them until you outgrow one container**:

| Path | What it looks like | When to pick |
|---|---|---|
| **Sticky sessions** | Configure the load balancer to route a given conversation's traffic to the same pod (cookie-based, header-based, or app-level via something like Fly's `fly-replay`). | Single-region, small fleet, willing to drop in-flight state during rolling deploys. |
| **Externalize state to Redis** | Replace the `Map<conversationId, ...>` patterns with Redis-backed equivalents. Any pod can handle any turn. | Multi-region, large fleet, zero-downtime rolling deploys required. |

For most adopters the answer is "I'll cross that bridge when I get there." A single container on a modest plan comfortably handles ~50–150 concurrent voice calls and a few hundred concurrent messaging conversations — the bottleneck is almost always OpenAI rate limits, not the host.

---

## Picking a host: comparison matrix

The application is well-behaved on any container host that satisfies the requirements above. The differences below are about price, region, ergonomics, and operational maturity — not about whether the app works.

### Tier 1 — Container PaaS (lowest friction)

| Host | Pros | Cons |
|---|---|---|
| **Fly.io** | First-class WSS. Multi-region with deploys in seconds. Always-on hobby tier. Excellent for our use case — see [`deploy/fly/`](./fly/) (coming soon). | Smaller community than the big PaaS players. Occasional reliability bumps. |
| **Render** | Dockerfile deploys via Git. Native WSS. Built-in TLS + custom domain. Predictable pricing. | No LATAM region (closest is US-East). Free tier spins down — unusable for voice. |
| **Railway** | Fastest deploys, generous free tier, WSS supported, minimal setup. | Smaller ecosystem. No SLA on hobby. Per-resource billing can surprise at scale. |
| **DigitalOcean App Platform** | Predictable pricing, São Paulo region available. WSS supported. | No autoscaling on cheaper tiers. Less feature-rich than Fly / Render. |
| **Heroku** | Most mature PaaS. Mature dyno model. | Dynos restart every 24h (loses in-memory state — disruptive for long demos). No LATAM region. Increasingly outpaced. |

### Tier 2 — Managed container services (cloud-provider native)

| Host | Pros | Cons |
|---|---|---|
| **AWS ECS Fargate + ALB** | The AWS-native answer. ALB handles WSS natively. Full IAM. Autoscaling. Integrates with everything in AWS. | Significant setup (Task Definition, Service, ALB, Target Group, Security Group, VPC). Higher baseline cost than Tier 1. **Set ALB idle timeout to 4000s** — the default 60s will kill quiet WSS turns. |
| **AWS App Runner** | Managed containers with auto-scaling and IAM integration. WSS support added in 2023. | Concurrency limits per instance scale pricing fast on long-lived WS. Limited regions. |
| **GCP Cloud Run** | Serverless containers, scale-to-zero, generous free tier. | **60-minute request cap** — a deal-breaker for marathon voice calls. Scale-to-zero means cold start failures. Workable for messaging-only. |
| **Azure Container Apps** | Serverless containers built on K8s / KEDA. WSS supported. | Newer, smaller community. Bicep / ARM is verbose. |

### Tier 3 — Raw VMs

| Host | Pros | Cons |
|---|---|---|
| **AWS EC2, GCP GCE, Azure VM** | Full control. Can use spot / preemptible to cut cost dramatically. | You operate the OS, patches, Docker host, restart policies, log forwarding, TLS rotation. |
| **Hetzner / Linode / Vultr / Scaleway / OVH** | Dirt cheap. Several have São Paulo regions. | Same operational overhead as the big-cloud VMs, with less surrounding ecosystem. |

A raw VM is the right choice if you want to learn the ops layer or have unusual requirements (kernel modules, hardware acceleration). For a Twilio bot, it's almost never worth it over Tier 1 / 2.

### Tier 4 — Kubernetes (EKS / GKE / AKS / self-managed)

The right choice **if you're already running a fleet of services on Kubernetes** and want to add this one to the existing platform. Massive operational overhead for a single app. Skip unless your org already lives there.

---

## Region selection

A common mistake: deploying close to your end users.

The voice path actually goes:

```
end-user phone  →  Twilio media gateway (regional, e.g., Brazil)
                →  ConversationRelay (us-east-1)
                →  YOUR APP  ← the only hop you control
                →  OpenAI (us-east-1 / us-west-2)
```

The latency-sensitive hop is **ConversationRelay → your app**, and ConversationRelay is hosted in `us-east-1`. So:

- **Deploy your app in `us-east-1`** (AWS) or **`iad`** (Fly) — wherever the host's closest US-East datacenter is.
- This is true even if your end users are in Brazil, Europe, or Asia.
- Deploying in São Paulo / Frankfurt / Tokyo *increases* the round-trip to CRelay, audibly stuttering voice under load.

For messaging-only deployments, region matters far less (a few hundred ms doesn't impact text UX). Pick whatever's cheapest or closest to OpenAI.

---

## Recommendations by use case

| Use case | Recommendation |
|---|---|
| Local dev | `ngrok` + `npm run dev` (already in the README). Don't over-engineer. |
| Single-customer demos / POCs | **Fly.io in `iad`** — see [`deploy/fly/`](./fly/) (coming soon). ~$3–15/mo. |
| Mid-volume production (single tenant per Twilio account) | Fly.io with multiple machines, or DigitalOcean App Platform. |
| Enterprise / regulated / already-AWS | **AWS ECS Fargate** behind ALB in `us-east-1`. See [`deploy/aws/ecs-fargate/`](./aws/ecs-fargate/) (coming soon). |
| Beyond a single instance | Externalize state to Redis (see the section above) — then any of the above. |

---

## Cost ballparks

Real numbers for a single always-on instance handling ~20 concurrent voice calls, in `us-east-1` / `iad`. These are approximate, change over time, and exclude OpenAI + Twilio usage (which dwarf hosting cost at any real volume).

| Component | Fly.io | AWS |
|---|---|---|
| Compute | ~$8 (shared-cpu-2x@1024) | ~$18 (Fargate 0.5 vCPU + 1GB) |
| Load balancer | included | ~$27 (ALB base + low LCU) |
| NAT Gateway (if needed) | n/a | ~$32 |
| Egress (10GB/mo) | free under fair use | ~$1 |
| Logs | included dashboard | ~$0.50 CloudWatch |
| **Monthly all-in** | **~$8–15** | **~$80–100** |

The AWS baseline doesn't really scale down — ALB + NAT alone are ~$60/mo regardless of load. AWS becomes cost-competitive around several hundred concurrent calls or when you're consolidating onto an existing AWS-shop's account.

---

## What every host needs from you

Regardless of which path you take, these one-time settings apply:

1. **Stable custom domain**, with TLS terminated by the host. Point its DNS at the host's load balancer or container.
2. **`TWILIO_VOICE_PUBLIC_DOMAIN`** in env, set to that custom domain. **No protocol, no port, no path** — e.g., `agent.example.com`.
3. **Twilio Console webhook URLs** updated one-time:
   - Voice number's TwiML URL → `https://agent.example.com/twiml`
   - WhatsApp Sender's incoming webhook (only if `INBOUND_MEDIA_ENABLED=true`) → `https://agent.example.com/inbound-message`
   - Conversations v1 service (only if `MESSAGING_MODE=conversations-v1`) → `https://agent.example.com/conversations-webhook`
4. **All env vars from [`.env.example`](../.env.example)** loaded into the host's secret manager.
5. **`NODE_OPTIONS=--max-old-space-size=<container-RAM>`** — without it, Node defaults to ~4GB regardless of container memory, leading to abrupt OOM-kills inside smaller containers. Set it to roughly 80% of your container's RAM cap.
6. **Single instance** by default — see "When you DO need code changes" above before turning on autoscaling.
7. **Healthcheck path: `GET /health`** — returns `200 {"status":"ok","uptime":<seconds>}` when the process is alive. Liveness only; does not probe downstream services. Hosts that auto-discover container healthchecks will already use the one in the `Dockerfile`. If you're configuring the host's own probe (Fly health, ALB target health, k8s livenessProbe), point it at `/health`.

---

## Per-host walkthroughs

These will be added incrementally. The Dockerfile at the repo root is the canonical artifact for all of them.

- **[Fly.io](./fly/)** *(coming soon)* — recommended starting point.
- **[AWS ECS Fargate](./aws/ecs-fargate/)** *(coming soon)* — enterprise / AWS-native.
- **Other hosts** — the Dockerfile works as-is on any container PaaS. If your host isn't listed but supports containers and WSS, you can adapt one of the above configs. We welcome PRs adding more guides.

---

## Compatibility note

The Dockerfile is built and tested on Node 20. It will work on Node 18+ but we don't run CI against older versions. If you need to pin to a different Node major, edit the `FROM node:20-alpine AS builder` lines in the [`Dockerfile`](../Dockerfile).
