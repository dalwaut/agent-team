# Reference Index — OPAI Knowledge Library

> **Purpose:** Quick-lookup index for all reference material in the knowledge library.
> This is the document to consult when looking for "where is the guide for X?"
> Content here is NOT loaded into context by default — read on demand when needed.

---

## How This Index Works

- Each entry has a **topic**, **path**, and **brief description**
- Organized by category for fast scanning
- When a user asks about a topic, check here first before searching the filesystem
- Add new entries when saving reference material to the library

---

## Reference Docs (`Library/knowledge/reference/`)

### OPAI System & Context

| Topic | Path | Description |
|-------|------|-------------|
| OPAI System Context | `reference/OPAI-System-Context.md` | High-level system overview, architecture context |
| OPAI Tools API Context | `reference/OPAI-Tools-API-Context.md` | API surface for OPAI tools |
| OPAI Mobile Context | `reference/OPAI-Mobile-Context.md` | Mobile app architecture, endpoints, stores |
| OPAI Agent/Wshobson Context | `reference/OPAI-Agent-Wshobson-Context.md` | Wshobson plugin/agent integration context |
| Agent Command Reference | `reference/agent-command-reference.md` | Agent CLI commands, squad runner usage |
| Claude Code Agent Teams | `reference/claude-code-agent-teams.md` | 7 agent team patterns (parallel, sequential, hybrid), prompt templates, best practices. Source: Mark Kashef + Anthropic docs. |
| File Structure Visual | `reference/User - File structure visual.md` | Visual directory tree for user orientation |
| **OPAI Glossary** | `reference/opai-glossary.md` | Canonical definitions for all OPAI terms and acronyms (AIOS, GEO, ARL, RALPH, HITL, HELM, DAM, PRDgent, etc.). Platform versions, infrastructure concepts, business terms. Quick-lookup acronym table. |
| **Environment Variables Reference** | `reference/environment-variables.md` | Central index of all env vars across 10+ services. Organized by service (Engine, Portal, Team Hub, Brain, Telegram, WordPress, Email Agent, Vault). Shared vars, defaults, descriptions. |

### Business Operations & Client Delivery

| Topic | Path | Description |
|-------|------|-------------|
| **Tool Selection Guide** | `reference/tool-selection-guide.md` | Decision tree for choosing the right OPAI tool, agent, or squad for any task. Multi-tool workflow patterns, common mistakes. |
| **Client Onboarding Checklist** | `reference/client-onboarding-checklist.md` | 6-phase checklist: lead qualification → discovery → contract → setup → kickoff → ongoing. Emergency procedures + offboarding. |
| **Service Delivery Workflow** | `reference/service-delivery-workflow.md` | End-to-end lead-to-invoice workflow: acquisition, scoping, delivery models, invoicing, retention. Metrics and upsell paths. |
| **Agency Pricing Framework** | `reference/agency-pricing-framework.md` | Pricing methodology: cost model, 4-tier pricing ($200-$30K), decision matrix, competitive positioning, payment structures. |
| **OPAI Troubleshooting Guide** | `reference/opai-troubleshooting-guide.md` | Common issues + fixes: services, auth, database, Caddy, Telegram, email, WordPress, Engine. Quick diagnosis checklist. Emergency procedures. |

### Dev Commands & Tools

| Topic | Path | Description |
|-------|------|-------------|
| Dev Commands | `reference/Dev Commands.md` | Common development commands cheat sheet |
| Expo Commands | `reference/Expo-Commands.md` | React Native / Expo CLI reference |
| Linux 24.04 LTS | `reference/Linux 24.04 LTS.md` | Ubuntu/Linux admin commands and setup notes |
| AI Build Instructions | `reference/AI-Build-Instructions.md` | Instructions for AI-assisted code generation |

### Google Workspace & Drive

| Topic | Path | Description |
|-------|------|-------------|
| **ALL Drives Master Index** | `ALL-DRIVES-INDEX.md` | **Master index of all 38 shared drives** — drive IDs, categories, file counts, links to per-drive structure docs. Scanned 2026-03-05. |
| ParadiseWebFL Drive Structure | `ParadiseWebFL-Structure.md` | Original 6 drives — folder trees, file IDs, brand asset locations. Scanned via agent@paradisewebfl.com. |
| Per-Client Drive Structures | `*-Structure.md` (32 files) | Individual structure docs for each client/resource drive. ~21K total files indexed across 32 drives. |
| Google Workspace API | `google-workspace-api.md` | Python usage examples, method signatures, Drive/Gmail query syntax, rate limits |

### External Services & APIs

| Topic | Path | Description |
|-------|------|-------------|
| n8n Commands | `reference/n8n commands.md` | n8n workflow CLI and admin commands |
| n8n API Reference | `reference/n8n-API-Reference.md` | n8n REST API endpoints and usage |
| n8n Automation Preferences | `reference/n8n-Automation-Preferences.md` | Preferred automation patterns for n8n |
| Gemini CLI Reference | `reference/Gemini-CLI-Reference.md` | Google Gemini CLI usage |
| Gemini Help | `reference/Gemini help.md` | Gemini troubleshooting and tips |
| Multi-Model API Gateways | `reference/multi-model-api-gateways.md` | OpenRouter, Puter, AIMLAPI — unified AI API gateways for cheap/free multi-model access. 290+ models, free tiers, BYOK, task offloading strategy. Key for HELM businesses. |
| Supadata API | *(vault + youtube.py)* | YouTube transcript API. Key: vault `SUPADATA_API_KEY`. 100 free/month, fallback in `tools/shared/youtube.py`. Affiliate: 33% recurring. |

### Infrastructure & Deployment

| Topic | Path | Description |
|-------|------|-------------|
| Coolify Docker (SSL) | `reference/coolify/docker compose SSL.md` | Docker Compose with SSL via Coolify |
| Coolify Docker (no SSL) | `reference/coolify/docker compose NO SSL.md` | Docker Compose without SSL via Coolify |
| ZeroClaw on Raspberry Pi | `reference/zeroclaw-raspberry-pi.md` | Full install guide: ZeroClaw (Rust OpenClaw rewrite) on Pi Zero 2 W. Cross-compile, systemd, Tailscale, security hardening. Source: PJ Bell YouTube tutorial. |
| **Disaster Recovery Plan** | `reference/disaster-recovery-plan.md` | Step-by-step recovery for 7 scenarios: service crash, full reboot, Supabase outage, disk failure, Caddy/SSL, git corruption, security incident. RTO/RPO targets, data priority tiers, post-incident checklist. |

---

## Concept Docs (`Library/knowledge/concepts/`)

| Topic | Path | Description |
|-------|------|-------------|
| OPAI System Context | `concepts/OPAI-System-Context.md` | Conceptual architecture overview |
| Generative Engine Optimization (GEO) | `concepts/generative-engine-optimization.md` | GEO explained: optimizing for AI search (ChatGPT, Perplexity, Gemini). Key signals, llms.txt spec, 5-dimension scoring. |
| **Business Growth Frameworks** | `concepts/business-growth-frameworks.md` | Distilled frameworks for HELM business management: 1-1-1 Rule (focus until $1M), 4-4-4 Operating Cadence (promote/deliver/build), Top 10% Analysis (iterative learning loop), Maker vs Manager blocking, Spend Framework (tools/implementation/trials). |
| **Harness Engineering** | `concepts/harness-engineering.md` | The discipline behind OPAI's architecture. Three principles for long-running autonomous agents: legible environments (progressive disclosure, structured task lists, progress files), verification over declaration (end-to-end testing, evidence-based completion), generic tools over specialized tools (Vercel case study: 3.5x faster, 100% success with bash-only). Includes synthesized autonomous workflow pattern and OPAI mapping. |

---

## Reusable Libraries (`Library/OPAI-Reusable/`)

| Topic | Path | Description |
|-------|------|-------------|
| TUI Frameworks | `OPAI-Reusable/tui-frameworks.md` | Comprehensive guide to terminal UI frameworks across languages. Decision matrices, architecture patterns, capability comparison. |
| Agent Orchestra Reference | `OPAI-Reusable/agent-orchestra-reference.md` | Orchestra UI component reference |

---

## HELM Business Playbooks (`Library/helm-playbooks/`)

> Curated business models and service offerings HELM can autonomously plan, build, and operate.
> Index: `Library/helm-playbooks/README.md`

| Playbook | Status | Description |
|----------|--------|-------------|
| GEO Audit & Optimization Service | **Draft** | AI search visibility audit + optimization as agency service. 5-dimension scoring, PDF reports, $1K-5K/client. 3-phase implementation plan, 6-week timeline, 15 Team Hub tasks. |
| AIOS Consulting & Vertical Packages | **Draft** | Package OPAI as customized AI Operating Systems for businesses. Audit → build → train → retainer. $8K-30K/build + $1.5K-5K/mo. 6 vertical templates. Implementation timeline, next steps, review checklist added. |
| Affiliate Revenue Streams | Idea | Portfolio of affiliate programs from tools we use (Supadata 33%, Hostinger, etc.). HELM-managed content + link placement for passive recurring commissions. |
| **Customer Onboarding Playbook** | **Draft** | SOP for deploying AIOS consulting to paying customers. Pre-sale qualification, technical assessment, deployment checklist, training plan, retainer tiers ($1.5K-5K/mo), 30/60/90 day success milestones. |

---

## External References (`Library/References/`)

| Topic | Path | Description |
|-------|------|-------------|
| 3D Scroll Animation Websites | `References/Animated_Website_Resources.md` | Full workflow: Nano Banana 2 → Cling 3.0 → ffmpeg → Claude Code. Apple-style scroll-driven frame animations. Prompts, best practices, tech stack (Next.js, Framer Motion, Canvas). Source: Chase AI. |
| Flipper Zero / Marauder | `References/Flipper/` | Flipper Zero resources, Marauder companion app |

---

## Software Catalog (`Library/knowledge/softwares/`)

> Tools, apps, and platforms worth tracking — either as inspiration, potential integrations, or competitive reference.

| Software | Path | Description |
|----------|------|-------------|
| **AnythingLLM** | `softwares/anythingllm.md` | Open-source self-hosted AI workspace. All-in-one RAG + chat + visual agent builder + REST API + embeddable widget. Inspiration for Brain UX, client-facing widgets, workspace isolation patterns. |

---

## Trading Knowledge (`Library/knowledge/trading/`)

> Building toward automated futures trading — suggestions, predictions, and profitable execution.
> Index: `Library/knowledge/trading/README.md`

| Topic | Path | Description |
|-------|------|-------------|
| **Trading Branch Index** | `trading/README.md` | Master index, roadmap (6 phases), sources log, planned docs |
| **Trading Foundations** | `trading/foundations.md` | Core concepts: risk-reward, win rate, position sizing, market structure, day trading framework, scaling path |
| **Futures Day Trading** | `trading/futures-day-trading.md` | Futures mechanics, E-mini/Micro contracts, margin, Riley Coleman's reversal strategy, entry checklist, NinjaTrader |
| **Futures Deep Dive** | `trading/futures-deep-dive.md` | 3-hour masterclass: pricing (points/ticks), margin deep-dive, market personalities (ES/NQ/Gold/Oil), supply & demand zones, top 6 candlestick patterns, trend lines, live psychology, scaling blueprint, tax advantages |
| **Order Flow Scalping** | `trading/order-flow-scalping.md` | Fabio Valentino method: absorption, volume profile (VAH/VAL/POC/VWAP), AAA setup, momentum squeeze, dynamic risk management, auction market theory, statistics-driven optimization, multiple portfolio approach. Live NQ session. |
| **Candlestick Patterns** | `trading/candlestick-patterns.md` | Complete reference: anatomy, ~20 patterns (single/double/triple candle), bullish-bearish spectrum, context rules, confirmation/entry framework, real trade examples. Source: Ross Cameron / Warrior Trading. |
| **4-Hour Range Scalping** | `trading/four-hour-range-scalping.md` | Rule-based failed-breakout scalping: mark first 4hr candle range (NY time), fade breakouts on 5-min chart, 3-step checklist, fixed 2R target. Backtested 70% win rate across crypto/forex/gold. Source: Data Trader. |
| **Opening Range Breakout** | `trading/opening-range-breakout.md` | Breakout-with-retest system: first 5-min candle range (9:35 EST), trade WITH confirmed breakouts, SL at midpoint, 2:1 R:R. Retest filter doubles win rate (70% vs 33%). Source: Casper SMC. |
| **Small Account Growth** | `trading/small-account-growth.md` | 3 strategies + compounding framework for 10x growth: FVG pullback (50 EMA + fair value gap), volume divergence reversal (volume oscillator), trend line breakout (3-point + pullback entry). Rules: 20% risk, 1:3 R:R, compound winners, 15min-4hr TF. Source: Data Trader. |

---

## Adding New Entries

When saving a new reference doc:
1. Save the file to `Library/knowledge/reference/` (or appropriate subfolder)
2. Add a row to the relevant table above
3. Keep descriptions to one line — enough to know if you need to read the full doc
