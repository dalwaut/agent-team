# Multi-Model AI API Gateways — Reference

**Date saved:** 2026-02-28
**Source:** [iampauljames — YouTube](https://www.youtube.com/watch?v=bi-ma2WE1mE) + independent research

---

## What Are They

Unified API gateways that provide access to hundreds of AI models (Claude, GPT, Gemini, DeepSeek, Llama, Mistral, etc.) through a single API endpoint and key. Instead of managing separate API keys and integrations per provider, one integration handles everything. OpenAI-compatible API format means most existing code works with a URL change.

**Why this matters for OPAI:** Internal OPAI work uses Claude CLI (`claude -p`) — no API keys needed. But HELM-managed businesses, customer-facing products, and bulk/repetitive tasks could use cheaper models via these gateways instead of consuming Claude subscription tokens.

---

## OpenRouter

**URL:** https://openrouter.ai
**Docs:** https://openrouter.ai/docs

### What It Is
The leading unified AI API gateway. 290+ models from every major provider through one OpenAI-compatible API.

### Pricing Model
- **No markup** — prices match what providers charge directly
- **Pay-as-you-go** — buy credits, use them across any model
- **Free tier** — 29 models at zero cost (rate-limited)
- **BYOK** — bring your own provider API keys, first 1M requests/month free (then 5% fee)

### Free Models (29 available, Feb 2026)
| Category | Notable Models | Context |
|----------|---------------|---------|
| Coding | Qwen3 Coder 480B | 262K |
| Reasoning | Qwen3 235B Thinking, DeepSeek R1 | 128K-262K |
| Vision | Qwen3 VL 235B Thinking, NVIDIA Nemotron Nano 12B VL | Varies |
| General | Llama 3.3 70B, Mistral Small 3.1 24B, Gemma 3 series | 128K |
| Lightweight | Step 3.5 Flash, NVIDIA Nemotron 3 Nano 30B | 256K |

Access free models by appending `:free` to any model ID.

### Rate Limits
| Tier | Requests/Min | Requests/Day |
|------|-------------|-------------|
| Free (no credits) | 20 | 50 |
| Free ($10+ credits purchased) | 20 | 1,000 |
| Paid models | Provider-dependent | No daily cap |

### Key Features
- **OpenAI-compatible API** — drop-in replacement, change base URL only
- **Provider routing** — automatic fallback across providers if one fails
- **BYOK (Bring Your Own Key)** — use your own provider API keys through OpenRouter's routing
- **Model fallback** — if primary model is rate-limited, automatically routes to backup
- **Supports text, images, PDFs** — multimodal out of the box
- **Zero data retention option** — for sensitive workloads

### BYOK Details
- Supports 60+ inference providers
- Your keys are encrypted at rest
- First 1M BYOK requests/month = free
- After 1M: 5% fee on upstream usage (plans to move to fixed subscription)
- Fallback: if your key hits rate limits, can fall back to OpenRouter shared capacity
- Can disable fallback to force BYOK-only routing

---

## Puter

**URL:** https://puter.com
**Developer docs:** https://developer.puter.com
**Tutorial:** https://developer.puter.com/tutorials/free-unlimited-openrouter-api/

### What It Is
A browser-based operating system / developer platform that wraps OpenRouter's API in a serverless JavaScript SDK. Claims "free unlimited" AI access through a "User-Pays" model.

### The "User-Pays" Model
Instead of developers paying for API usage, end users cover their own costs through their Puter account. Developers don't need API keys or billing infrastructure — Puter handles everything client-side.

### How It Works
```html
<!-- Single script tag — no server, no API key -->
<script src="https://js.puter.com/v2/"></script>

<script>
// Basic usage
puter.ai.chat("Explain quantum computing",
    {model: 'openrouter:meta-llama/llama-3.1-8b-instruct'});

// Streaming with Claude
const response = await puter.ai.chat(prompt,
    {model: 'openrouter:anthropic/claude-sonnet-4.5', stream: true});
</script>
```

### Supported Models
400+ models through OpenRouter, including:
- Anthropic (Claude family)
- OpenAI (GPT-4o, o1, o3)
- Meta (Llama 3.x, Llama 4)
- Google (Gemini 2.5, Gemma)
- Mistral, DeepSeek, Qwen, and more

### Caveats
- **No documented rate limits** — "unlimited" claim lacks quantitative definition
- **No SLA or uptime guarantees**
- **Client-side only** — JavaScript SDK, runs in browser, not suitable for server-side/agent work
- **User-Pays means user needs a Puter account** — friction for end users
- **Best for:** learning projects, prototypes, browser-based apps

### OPAI Relevance
Limited for backend/agent work (client-side JS only). Could be relevant if HELM builds web-based products where the end user's browser calls AI directly. Not suitable for agent pipelines or server-side processing.

---

## AIMLAPI

**URL:** https://aimlapi.com
**Docs:** https://docs.aimlapi.com

### What It Is
Another unified AI API gateway. 400+ models, claims 80% cheaper than direct OpenAI pricing.

### Free Tier
- 10 requests/hour for new accounts
- No credit card required

### Notable Features
- Supports text, image, and video generation models
- liteLLM compatible
- OpenRouter integration (can route through OpenRouter models too)

### OPAI Relevance
Similar to OpenRouter but less mature. OpenRouter is the better choice for OPAI given its larger model catalog, BYOK support, and established documentation.

---

## Comparison for OPAI Use

| Feature | OpenRouter | Puter | AIMLAPI |
|---------|-----------|-------|---------|
| Models | 290+ | 400+ (via OpenRouter) | 400+ |
| Free tier | 29 models, 50-1000 req/day | "Unlimited" (undefined) | 10 req/hour |
| Server-side use | Yes (REST API) | No (browser JS only) | Yes (REST API) |
| BYOK | Yes (60+ providers) | No | No |
| OpenAI-compatible | Yes | Via wrapper | Yes |
| Agent/pipeline use | Excellent | Not suitable | Good |
| Production-ready | Yes | Prototype-only | Developing |

**Winner for OPAI: OpenRouter** — server-side compatible, BYOK for cost control, automatic failover, production-grade.

---

## OPAI Integration Opportunities

### 1. HELM Business AI Layer
HELM-managed businesses need AI capabilities. Instead of requiring each business to have a Claude subscription:
- OpenRouter provides cheap/free multi-model access
- Routine tasks (content generation, email classification, data extraction) use cheaper models
- Complex tasks still route to Claude when needed

### 2. Task Offloading by Complexity
| Task Type | Model Tier | Estimated Cost |
|-----------|-----------|---------------|
| Classification, triage, tagging | Free models (Llama 3.3 70B, Gemma) | $0 |
| Content generation, summaries | Cheap models (DeepSeek, Mistral) | ~$0.10-0.50/1M tokens |
| Code generation, analysis | Mid-tier (GPT-4o, Sonnet) | ~$3-10/1M tokens |
| Complex reasoning, planning | Premium (Claude Opus, o3) | ~$15-75/1M tokens |

### 3. claude_api.py Extension
`tools/shared/claude_api.py` currently falls back from API to CLI. Could add OpenRouter as a third tier:
1. Anthropic API (if key exists) → 2. OpenRouter (if key exists, cheaper models) → 3. Claude CLI (always available)

### 4. Customer-Facing Product AI
Products HELM builds for clients can use OpenRouter for their AI needs without touching OPAI's Claude subscription. Clean separation of internal vs customer-facing AI costs.

---

## Quick Start (for future implementation)

```python
# OpenRouter is OpenAI-compatible — use the openai Python package
from openai import OpenAI

client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key="sk-or-v1-YOUR_KEY_HERE",
)

response = client.chat.completions.create(
    model="meta-llama/llama-3.3-70b-instruct:free",  # Free model
    messages=[{"role": "user", "content": "Classify this email as urgent or not: ..."}],
)
```

```bash
# curl example
curl https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "meta-llama/llama-3.3-70b-instruct:free", "messages": [{"role": "user", "content": "Hello"}]}'
```
