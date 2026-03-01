# wshobson/agents Integration
> Last updated: 2026-02-28 | Source: `mcps/wshobson-agents/`, `team.json`, `scripts/prompt_*.txt`

## Overview

The [wshobson/agents](https://github.com/wshobson/agents) marketplace provides 72 specialist plugins covering every domain of software development — 112 agents, 146 SKILL.md knowledge files, and 79 slash commands. OPAI integrates these across three paths, permanently embedding their methodology into the batch agent pipeline without incurring per-session token cost.

**Repository cloned to:** `mcps/wshobson-agents/`
**Skill catalog:** `Library/knowledge/WSHOBSON-SKILLS-SUMMARY.md` (146 skills, 46 active plugins)
**Batch install script:** `scripts/plugins-install.sh` (groups: core/security/workflows/frontend/business/infra/ai/backend/all)

---

## Integration Philosophy: Three Paths

| Path | Mechanism | Permanence | Token Cost | Status |
|------|-----------|-----------|------------|--------|
| **A — Plugin Install** | `/plugin install <name>` → loads SKILL.md into session context | Session-only, resets on new Claude Code session | High — full SKILL.md loaded upfront | Partial (3 of 72 installed) |
| **B — Skill Injection** | Extract SKILL.md content → append to `scripts/prompt_*.txt` | Permanent — baked into agent prompts | Zero per-session (loaded only when agent runs) | ✅ Complete |
| **C — New Batch Agents** | New `scripts/prompt_<role>.txt` + `team.json` registration | Permanent — full squad integration | Zero per-session (loaded only when agent runs) | ✅ Complete |

**Why we prioritized B+C over A:** Path A loads SKILL.md content into every session context, even when those skills aren't needed. With 72 plugins averaging 2-4KB each, auto-loading all would add 150-300KB to every session startup. Paths B+C pay the token cost only when the relevant agent actually runs.

**Path A is still useful for:** Interactive sessions when you need a specific slash command (e.g., `/full-stack-orchestration:full-stack-feature`) or agent type (e.g., `opus`-class code reviewers) that aren't available as OPAI batch agents. Install on-demand, don't configure persistence.

---

## Installed Plugins (Path A — Session-Based)

These three plugins are installed at the start of sessions that need them. They reset each session — do NOT configure them for auto-load.

### `agent-teams` ✅ Installed
**Category:** workflows | **When:** Parallel multi-agent code reviews, feature development, debugging

**Slash Commands:**
| Command | What It Does |
|---------|-------------|
| `/agent-teams:team-review` | Multi-reviewer parallel code review across security/performance/architecture dimensions |
| `/agent-teams:team-debug` | Competing hypothesis debugging with parallel investigation |
| `/agent-teams:team-feature` | Parallel feature development with file ownership boundaries |
| `/agent-teams:team-spawn` | Spawn a team using preset compositions (review/debug/feature/security) |
| `/agent-teams:team-delegate` | Task delegation dashboard for workload management |
| `/agent-teams:team-status` | Show active team members and task progress |
| `/agent-teams:team-shutdown` | Gracefully shut down an agent team |

**Skills (permanently injected into prompts via Path B):**
- `multi-reviewer-patterns` → `prompt_reviewer.txt` — structured finding format, severity calibration
- `parallel-debugging` → `prompt_health.txt` — competing hypothesis root cause framework
- `task-coordination-strategies` → `prompt_manager.txt` — dependency graph decomposition
- `team-communication-protocols` → `prompt_report_dispatcher.txt` — HITL message selection, approval patterns
- `team-composition-patterns`, `parallel-feature-development` — referenced in planning agents

**Install for session:** `/plugin install agent-teams`

---

### `security-scanning` ✅ Installed
**Category:** security | **When:** Interactive security reviews, ad-hoc threat modeling

**Slash Commands:**
| Command | What It Does |
|---------|-------------|
| `/security-scanning:security-hardening` | Defense-in-depth security hardening across all layers |
| `/security-scanning:security-sast` | SAST vulnerability scan across multiple languages |

**Skills (permanently injected into prompts via Path B):**
- `stride-analysis-patterns` → `prompt_security.txt` — STRIDE at each OPAI trust boundary
- `attack-tree-construction` → `prompt_security.txt` — attack path visualization, defense gaps
- `sast-configuration` → `prompt_security.txt` — Semgrep rule patterns, CWE/OWASP mapping
- `threat-mitigation-mapping` → `prompt_security.txt` — control validation, remediation priority
- `security-requirement-extraction` → `prompt_features.txt` — derive security requirements during planning
- `wcag-audit-patterns` → `prompt_ux_reviewer.txt` — WCAG 2.1 AA checklist

**Install for session:** `/plugin install security-scanning`

---

### `full-stack-orchestration` ✅ Installed
**Category:** workflows | **When:** End-to-end feature development with backend/frontend/DB/infra gates

**Slash Commands:**
| Command | What It Does |
|---------|-------------|
| `/full-stack-orchestration:full-stack-feature` | 9-phase gated feature development (spec → DB → backend → frontend → testing → deployment) |

**Install for session:** `/plugin install full-stack-orchestration`

---

## Path A: On-Demand Plugins (Install When Needed)

These are **not installed by default**. Install in a session when working on the relevant domain.

### High Priority — Core Stack
```bash
/plugin install python-development     # FastAPI async patterns, Python anti-patterns, uv/ruff
/plugin install database-design        # PostgreSQL-specific patterns, RLS, migration safety
/plugin install payment-processing     # Stripe webhook verification, PCI compliance
/plugin install accessibility-compliance  # WCAG audit command, ARIA testing
/plugin install javascript-typescript  # Node.js async patterns, TypeScript advanced types
/plugin install shell-scripting        # Bash defensive patterns, ShellCheck config
/plugin install backend-api-security   # API auth patterns, rate limiting, input validation
/plugin install comprehensive-review   # Multi-arch review with opus-class agents
/plugin install codebase-cleanup       # Tech debt classification, deps-audit command
/plugin install application-performance # Performance optimization, observability
/plugin install cicd-automation        # CI/CD workflow automation, deployment patterns
/plugin install frontend-mobile-security # XSS scan command, mobile security patterns
/plugin install database-migrations    # Migration safety, sql-migrations command
/plugin install security-compliance    # SOC2/HIPAA/GDPR compliance check command
```

### When Working on Mobile App
```bash
/plugin install react-native           # Expo/React Native specialist, EAS Build patterns
/plugin install api-testing-observability # API mock generation, OpenAPI docs
```

### When Working on PRD / Business Analysis
```bash
/plugin install startup-business-analyst  # Market sizing, financial modeling for PRD pipeline
/plugin install content-marketing      # Blog posts, SEO strategy
/plugin install seo-content-creation   # Client WordPress sites
```

### Low Priority / Future
```bash
/plugin install api-scaffolding        # fastapi-pro, graphql-architect, FastAPI templates
/plugin install technical-writing      # API docs, READMEs, changelogs
/plugin install unit-testing           # test-generate command
/plugin install documentation-generation # openapi-spec-generation, changelog-automation
/plugin install incident-response      # incident-response + smart-fix commands
```

### Not Relevant to OPAI Stack
Blockchain/Web3, quantitative trading, game development, JVM languages, functional programming (Elixir/Haskell), Julia, ARM microcontrollers, PHP/Ruby, Rust/Go/C (unless a client project requires these).

---

## Path B: Skills Permanently Injected (90 Injections Across 30 Prompts)

Skill knowledge extracted from 146 SKILL.md files and injected into OPAI's batch agent prompts. Every squad run benefits permanently — no session action required. Each injection is a condensed 10-bullet summary appended as `## Enhanced Knowledge:` sections.

### Security Agents (17 injections)

| Skill Source | → Injected Into | What It Adds |
|-------------|-----------------|-------------|
| `stride-analysis-patterns` | `prompt_security.txt` | STRIDE-per-interaction at each trust boundary |
| `attack-tree-construction` | `prompt_security.txt` | Attack path visualization + defense gaps |
| `sast-configuration` | `prompt_security.txt` | Semgrep patterns, CWE/OWASP mapping |
| `threat-mitigation-mapping` | `prompt_security.txt` | Control validation, remediation priority |
| `stripe-integration` | `prompt_security.txt` | Webhook signature verification, PCI scoping |
| `pci-compliance` | `prompt_security.txt` | Decimal precision, currency handling |
| `auth-implementation-patterns` | `prompt_security.txt` | Auth patterns, session management |
| `gdpr-data-handling` | `prompt_security.txt` | GDPR compliance, data handling |
| `stride-analysis-patterns` | `prompt_threat_modeler.txt` | STRIDE methodology application |
| `attack-tree-construction` | `prompt_threat_modeler.txt` | Attack tree visualization |
| `threat-mitigation-mapping` | `prompt_threat_modeler.txt` | Threat-to-control mapping |
| `secrets-management` | `prompt_secrets_detector.txt` | CI/CD secrets management patterns |
| `github-actions-templates` | `prompt_cicd_auditor.txt` | GitHub Actions workflow patterns |
| `deployment-pipeline-design` | `prompt_cicd_auditor.txt` | Multi-stage pipeline design |
| `secrets-management` | `prompt_cicd_auditor.txt` | Secrets management for CI/CD |
| `shellcheck-configuration` | `prompt_cicd_auditor.txt` | ShellCheck static analysis |
| `k8s-security-policies` | `prompt_docker_auditor.txt` | Kubernetes security policies |

### Quality Agents (17 injections)

| Skill Source | → Injected Into | What It Adds |
|-------------|-----------------|-------------|
| `multi-reviewer-patterns` | `prompt_reviewer.txt` | Structured finding format, severity calibration |
| `code-review-excellence` | `prompt_reviewer.txt` | Code review practices |
| `error-handling-patterns` | `prompt_reviewer.txt` | Error handling patterns |
| `parallel-debugging` | `prompt_health.txt` | Competing hypothesis root cause framework |
| `debugging-strategies` | `prompt_health.txt` | Debugging techniques |
| `python-performance-optimization` | `prompt_perf_profiler.txt` | Python profiling and optimization |
| `sql-optimization-patterns` | `prompt_perf_profiler.txt` | SQL query optimization |
| `python-testing-patterns` | `prompt_test_writer.txt` | pytest patterns and best practices |
| `javascript-testing-patterns` | `prompt_test_writer.txt` | JS/TS testing patterns |
| `e2e-testing-patterns` | `prompt_test_writer.txt` | End-to-end testing |
| `bats-testing-patterns` | `prompt_test_writer.txt` | Bash testing with Bats |
| `screen-reader-testing` | `prompt_a11y_auditor.txt` | Screen reader compatibility |
| `wcag-audit-patterns` | `prompt_a11y_auditor.txt` | WCAG 2.1 AA checklist |
| `accessibility-compliance` | `prompt_a11y_auditor.txt` | Accessibility compliance |
| `design-system-patterns` | `prompt_ux_reviewer.txt` | Design systems |
| `responsive-design` | `prompt_ux_reviewer.txt` | Responsive layout patterns |
| `interaction-design` | `prompt_ux_reviewer.txt` | Microinteractions and motion |

### Builder & Planning Agents (15 injections)

| Skill Source | → Injected Into | What It Adds |
|-------------|-----------------|-------------|
| `async-python-patterns` | `prompt_builder.txt` | Python asyncio programming |
| `python-error-handling` | `prompt_builder.txt` | Error handling patterns |
| `python-project-structure` | `prompt_builder.txt` | Project organization |
| `modern-javascript-patterns` | `prompt_builder.txt` | ES6+ features |
| `nodejs-backend-patterns` | `prompt_builder.txt` | Node.js backend services |
| `bash-defensive-patterns` | `prompt_builder.txt` | Defensive Bash programming |
| `security-requirement-extraction` | `prompt_features.txt` | Security requirements during planning |
| `fastapi-templates` | `prompt_features.txt` | FastAPI project patterns |
| `api-design-principles` | `prompt_features.txt` | REST/GraphQL API design |
| `architecture-patterns` | `prompt_features.txt` | Backend architecture patterns |
| `typescript-advanced-types` | `prompt_features.txt` | TypeScript advanced types |
| `task-coordination-strategies` | `prompt_manager.txt` | Dependency graph decomposition |
| `team-composition-patterns` | `prompt_manager.txt` | Team composition optimization |
| `architecture-decision-records` | `prompt_manager.txt` | ADR documentation |
| `team-communication-protocols` | `prompt_report_dispatcher.txt` | HITL message type selection |

### Operations & Misc Agents (11 injections)

| Skill Source | → Injected Into | What It Adds |
|-------------|-----------------|-------------|
| `market-sizing-analysis` | `prompt_prdgent.txt` | TAM/SAM/SOM framework |
| `competitive-landscape` | `prompt_prdgent.txt` | Porter's Five Forces, positioning |
| `startup-metrics-framework` | `prompt_prdgent.txt` | Unit economics, SaaS metrics |
| `git-advanced-workflows` | `prompt_github.txt` | Advanced Git workflows |
| `changelog-automation` | `prompt_github.txt` | Changelog generation |
| `dependency-upgrade` | `prompt_dep_scanner.txt` | Dependency upgrade strategy |
| `dependency-upgrade` | `prompt_node_updater.txt` | Node.js dependency upgrades |
| `data-storytelling` | `prompt_content_curator.txt` | Data-driven narrative creation |
| `distributed-tracing` | `prompt_tools_monitor.txt` | OpenTelemetry, trace/span concepts |
| `slo-implementation` | `prompt_tools_monitor.txt` | SLI/SLO/SLA, error budgets |
| `prometheus-configuration` | `prompt_tools_monitor.txt` | Prometheus scrape/alert rules |

### Specialized Agents (14 injections)

| Skill Source | → Injected Into | What It Adds |
|-------------|-----------------|-------------|
| `architecture-decision-records` | `prompt_wiki_librarian.txt` | ADR structure, MADR format |
| `openapi-spec-generation` | `prompt_wiki_librarian.txt` | OpenAPI 3.1 specification patterns |
| `incident-runbook-templates` | `prompt_incident_responder.txt` | SEV1-4 severity levels, triage |
| `postmortem-writing` | `prompt_incident_responder.txt` | Blameless postmortems, 5 Whys |
| `on-call-handoff-patterns` | `prompt_incident_responder.txt` | On-call handoff protocol |
| `slo-implementation` | `prompt_incident_responder.txt` | SLI/SLO hierarchy, error budgets |
| `postgresql` | `prompt_db_auditor.txt` | PK preferences, RLS, partitioning |
| `sql-optimization-patterns` | `prompt_db_auditor.txt` | EXPLAIN ANALYZE, index strategies |
| `database-migration` | `prompt_db_auditor.txt` | Zero-downtime migrations |
| `api-design-principles` | `prompt_api_designer.txt` | Resource-oriented architecture |
| `openapi-spec-generation` | `prompt_api_designer.txt` | OpenAPI spec design approaches |
| `api-design-principles` | `prompt_api_contract_checker.txt` | HTTP method semantics, naming |
| `react-native-architecture` | `prompt_mobile_auditor.txt` | Expo Router, offline-first patterns |
| `react-native-design` | `prompt_mobile_auditor.txt` | StyleSheet patterns, gestures |

### New Agent Prompts (16 injections — Path C)

| Skill Source | → Injected Into | What It Adds |
|-------------|-----------------|-------------|
| `rag-implementation` | `prompt_llm_engineer.txt` | RAG pipeline architecture |
| `prompt-engineering-patterns` | `prompt_llm_engineer.txt` | Advanced prompt engineering |
| `embedding-strategies` | `prompt_llm_engineer.txt` | Embedding model optimization |
| `hybrid-search-implementation` | `prompt_llm_engineer.txt` | Vector + keyword fusion |
| `llm-evaluation` | `prompt_llm_engineer.txt` | LLM evaluation metrics |
| `vector-index-tuning` | `prompt_llm_engineer.txt` | HNSW tuning, quantization |
| `react-state-management` | `prompt_frontend_auditor.txt` | React state management |
| `react-native-architecture` | `prompt_frontend_auditor.txt` | React Native architecture |
| `web-component-design` | `prompt_frontend_auditor.txt` | React/Vue/Svelte components |
| `responsive-design` | `prompt_frontend_auditor.txt` | Modern responsive layouts |
| `tailwind-design-system` | `prompt_frontend_auditor.txt` | Design systems with Tailwind |
| `market-sizing-analysis` | `prompt_business_analyst.txt` | TAM/SAM/SOM methodology |
| `competitive-landscape` | `prompt_business_analyst.txt` | Porter's Five Forces, positioning |
| `startup-financial-modeling` | `prompt_business_analyst.txt` | Revenue modeling, projections |
| `startup-metrics-framework` | `prompt_business_analyst.txt` | Unit economics, SaaS metrics |
| `kpi-dashboard-design` | `prompt_business_analyst.txt` | KPI selection and visualization |

---

## Path C: New Batch Agents (15 Roles)

All 15 agents are permanently registered in `team.json` and fully integrated into OPAI squads. Run via `./scripts/run_squad.sh` or from the Task Control Panel.

### Phase 1 — Security Agents (Closes Critical Coverage Gaps)

#### `dep_scanner` — Dependency CVE Scanner (DS)
**Closes:** CVE/Known Vulnerabilities (OWASP A06) — was zero automated coverage
**Model:** sonnet | **Max turns:** 6 | **Squads:** audit, ship, secure, security_quick, dep_scan
**What it checks:**
- `npm audit` output across all `package.json` manifests
- `pip-audit` / `safety` across all `requirements.txt` files
- Unpinned version ranges (`^`, `~`, `*`, `latest`)
- Abandoned packages (no release >2 years)
- Suspicious postinstall scripts (supply chain risk)
- Missing lock files (`package-lock.json`, `requirements.txt`)

**Output format:** `[CRITICAL]`/`[HIGH]`/`[MEDIUM]`/`[LOW]` with CVE ID, current version, fixed version, upgrade command

---

#### `secrets_detector` — Secrets & Credential Detector (SD)
**Closes:** Hardcoded secrets — was zero automated protection
**Model:** sonnet | **Max turns:** 8 | **Squads:** audit, ship, secure, security_quick, secrets_scan
**What it checks:**
- API key patterns: `sk-`, `AIza`, `ghp_`, `xoxb-`, `Bearer `, `AKIA` (AWS), private key headers
- Hardcoded IP addresses and credentials in source
- `.gitignore` correctness for `notes/Access/`, `Credentials.md`, `.env` files
- Git history for removed-but-committed secrets
- `.env.example` vs `.env` file hygiene

**Safety:** Never outputs full secret values — masks after first 8 characters

---

#### `threat_modeler` — STRIDE Threat Modeler (TH)
**Closes:** No systematic threat modeling — trust boundaries were uncatalogued
**Model:** opus | **Squads:** secure, plan | **HITL:** Yes for architecture change recommendations
**What it checks:**
- Maps all OPAI trust boundaries: user→Caddy→FastAPI, FastAPI→Claude CLI, FastAPI→Supabase, Discord→bridge, orchestrator→agent subprocesses
- Enumerates S/T/R/I/D/E threats at each crossing
- Attack trees for Critical findings
- Validates existing controls (RLS, auth middleware, JWT verification)
- Proposes missing controls with priority scoring

---

#### `db_auditor` — Database Security Auditor (DB)
**Closes:** No RLS audit, migration safety, or index analysis for Supabase
**Model:** sonnet | **Max turns:** 8 | **Squads:** audit, secure, dep_scan
**What it checks:**
- RLS enabled on all public schema tables
- No self-referencing RLS policies (infinite recursion trap — use `get_my_role()` instead)
- Migration files for destructive ops: `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `ALTER TYPE` without backup step
- Missing FK indexes (PostgreSQL doesn't auto-create these)
- `SELECT *` in application queries
- `timestamp` vs `TIMESTAMPTZ` usage (always prefer TIMESTAMPTZ)
- PII columns without encryption or access controls
- N+1 query patterns via ORM
- `char(n)` usage (use `text` or `varchar(n)` instead)

---

#### `api_contract_checker` — API Contract Checker (AC)
**Closes:** Route drift from documented contracts — mobile app APIs were undocumented
**Model:** sonnet | **Max turns:** 8 | **Squads:** review, ship, secure, mobile
**What it checks:**
- All routes have auth middleware attached
- Request/response schemas validated with Pydantic
- Error codes consistent (422 for validation, 401 for auth, 403 for authz)
- Pagination on all list endpoints
- Cross-references against `docs/mobile-api-reference.md` for mobile API compliance
- CORS configuration correctness
- Rate limiting presence on public endpoints

---

### Phase 2 — Performance & Infrastructure Agents

#### `perf_profiler` — Performance Profiler (PP)
**Closes:** health agent had no real profiling — missed FastAPI async blocking patterns
**Model:** sonnet | **Max turns:** 8 | **Squads:** audit, ship, mobile
**What it checks:**
- Sync I/O in async handlers: `open()`, `json.load()`, `json.dump()`, `subprocess.Popen` in `async def` routes
- Missing `asyncio.to_thread()` wrappers
- Unthrottled `Promise.all()` / `asyncio.gather()` without semaphore
- Missing pagination on collection endpoints (O(n) response size growth)
- Subprocess spawning without `asyncio.Semaphore` (runaway concurrency)
- Memory leak patterns: event listeners without cleanup, growing caches without LRU
- Service configuration: missing timeouts, connection pool limits

**Output:** PERF-NNN findings with P0/P1/P2/P3 severity

---

#### `mobile_auditor` — Mobile Security Auditor (MA)
**Closes:** No mobile security despite a live Expo React Native app in production
**Model:** sonnet | **Max turns:** 6 | **Squads:** mobile, secure
**Target:** `Projects/OPAI Mobile App/opai-mobile/`
**What it checks:**
- `AsyncStorage` storing tokens or credentials (unencrypted on device)
- Hardcoded API keys, URLs, or secrets in bundle source
- Missing certificate pinning for production API calls
- Insecure deep link handling (no intent verification)
- Expo SDK currency — flags outdated versions
- EAS Build secrets exposure in `eas.json` or CI config
- API responses exposing server-side implementation details
- `console.log` with sensitive data left in production builds

**Output:** MOB-NNN findings

---

#### `cicd_auditor` — CI/CD Security Auditor (CI)
**Closes:** No audit of GitHub Actions workflows or systemd service hardening
**Model:** sonnet | **Max turns:** 6 | **Squads:** secure, ship | **HITL:** Yes for remediation
**What it checks:**
- GitHub Actions: action pinning (must use SHA, not tag), `pull_request_target` misuse, secret injection via environment
- systemd services: `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=strict`, `CapabilityBoundingSet`
- Caddy configuration: security headers (`Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`), CORS wildcard
- Deployment scripts: `set -euo pipefail`, unquoted variable expansion, unvalidated inputs
- Hardcoded paths and user assumptions in scripts

---

#### `docker_auditor` — Docker Security Auditor (DK)
**Closes:** No container security despite n8n and Coolify running in Docker on BB VPS
**Model:** sonnet | **Max turns:** 6 | **Squads:** secure
**What it checks:**
- Containers running as root (missing `USER` directive)
- Dangerous mounts: Docker socket (`/var/run/docker.sock`) = critical severity
- Secrets in Dockerfile `ENV` or `ARG` instructions
- Base image hygiene: `:latest` tag ban, outdated base images, digest pinning
- Missing `--memory` and `--cpus` resource limits
- Privileged mode (`--privileged`) or unnecessary capabilities (`--cap-add`)
- Network exposure: ports bound to `0.0.0.0` unnecessarily
- `.dockerignore` coverage for sensitive files

**Output:** DOCK-NNN findings with container inventory table

---

### Phase 3 — Quality & Design Agents

#### `api_designer` — API Design Reviewer (AD)
**Closes:** No API consistency enforcement — routes were added ad-hoc without standards
**Model:** sonnet | **Max turns:** 6 | **Squads:** review, audit, plan
**What it checks:**
- REST naming: plural nouns, no verbs in paths, consistent casing
- HTTP method correctness: GET is idempotent/side-effect-free, POST for creation, PUT/PATCH distinction
- Status codes: 201 for creation, 422 for validation errors, 204 for empty success
- Pagination on all list endpoints: `page`/`per_page` or cursor-based
- Request validation: Pydantic schemas required on all POST/PUT/PATCH
- Versioning strategy: `/api/v1/` prefix consistency
- Error response standardization: `{"error": "...", "detail": "...", "code": "..."}` format
- Mobile Impact Assessment: cross-references `docs/mobile-api-reference.md`

**Output:** API-NNN findings

---

#### `a11y_auditor` — Accessibility Auditor (A1)
**Closes:** ux_reviewer did manual accessibility — no WCAG tooling or systematic coverage
**Model:** sonnet | **Max turns:** 6 | **Squads:** audit, ship, a11y
**Standard:** WCAG 2.1 Level AA
**What it checks:**
- Images & media: `alt` attributes, decorative image `alt=""`, video captions
- Color & contrast: 4.5:1 for normal text, 3:1 for large text (18pt+) and UI components
- Keyboard navigation: all interactive elements reachable, logical tab order, no keyboard traps
- Focus visibility: no `outline: none` without alternative focus indicator
- Forms & inputs: every input has `<label>`, error messages associated via `aria-describedby`
- Page structure: exactly one `<main>`, one `<h1>`, skip navigation link present
- ARIA usage: roles/properties match element semantics, no redundant ARIA

**Output:** A11Y-NNN findings with WCAG criterion cited (e.g., WCAG 1.4.3)

---

#### `incident_responder` — Incident Response Coordinator (IR)
**Closes:** No incident detection — service failures were discovered reactively
**Model:** sonnet | **Max turns:** 8 | **Squads:** tools, incident | **HITL:** Always required
**What it checks:**
- Service health: 13 OPAI services scanned for ERROR/CRITICAL/FATAL/Traceback patterns
- Error spike detection: >5 errors in any 10-minute window
- Orchestrator health: missed schedules, empty report files, queue depth >20
- Auth anomalies: >10 failed attempts from same IP, unusual user agents, JWT decode errors
- Disk & resource pressure: log files >100MB, data files >10MB, reports >500 files
- Integration health: Supabase timeouts, Discord WebSocket drops, Email IMAP failures, Stripe 4xx/5xx
- Stale data: tasks in_progress >48h, email processing stopped >24h

**Severity levels:** SEV1 (service down) → SEV2 (degraded) → SEV3 (warning) → SEV4 (advisory)
**Output:** INC-NNN findings with postmortem trigger identification. Never auto-remediates.

#### `llm_engineer` — LLM Application Specialist (LE)
**Closes:** No review of RAG pipelines, prompt quality, embedding strategies, or LLM evaluation
**Model:** sonnet | **Max turns:** 8 | **Squads:** audit, review
**Target:** `tools/shared/claude_api.py`, `tools/opai-chat/`, `tools/opai-prd/`, `tools/opai-dam/`, `tools/opai-brain/`
**What it checks:**
- RAG pipeline architecture: chunking strategy, retrieval quality, context window management
- Prompt engineering quality: system prompts, few-shot examples, structured output
- Embedding & vector search: model selection, preprocessing, batching, caching
- Hybrid search implementation: vector+keyword fusion, RRF, weight tuning
- LLM evaluation: faithfulness, regression testing, hallucination detection
- Vector index performance: HNSW tuning, quantization, latency monitoring

**Output:** LLM-NNN findings

---

#### `frontend_auditor` — Frontend Code Quality Auditor (FR)
**Closes:** No systematic frontend pattern review beyond UX/accessibility
**Model:** sonnet | **Max turns:** 6 | **Squads:** audit, review, mobile
**Target:** All OPAI tool UIs (`tools/*/static/`), mobile app (`Projects/OPAI Mobile App/`)
**What it checks:**
- State management: colocating, server state duplication, optimistic updates
- Component architecture: SRP, composition, memoization, error boundaries
- Styling & design system: Tailwind tokens, CVA, dark mode, design token hierarchy
- Responsive design: mobile-first breakpoints, container queries, fluid typography
- React Native / mobile: Expo Router, offline-first, secure storage, FlashList
- Accessibility & performance: ARIA, keyboard nav, lazy loading, bundle size

**Output:** FE-NNN findings

---

#### `business_analyst` — Business & Market Analyst (BA)
**Closes:** No structured business analysis capability for HELM playbooks or PRD evaluations
**Model:** sonnet | **Max turns:** 6 | **Squads:** plan
**Target:** `Library/helm-playbooks/`, `tools/opai-prd/`, `notes/Improvements/`
**What it analyzes:**
- Market sizing & opportunity: TAM/SAM/SOM, methodology, data triangulation
- Competitive landscape: Porter's Five Forces, positioning maps, moats
- Financial model: revenue model, cohort projections, cost structure, scenarios
- Key metrics & unit economics: CAC, LTV, burn multiple, NDR, Rule of 40
- KPI dashboard: metric selection, SMART criteria, visualization, cadence
- Business model viability: problem-solution fit, pricing, GTM, path to profitability

**Output:** BIZ-NNN findings

---

## Complete Squad Reference

All 26 squads in `team.json`. Run with `./scripts/run_squad.sh -s <squad>`.

### Standard Development Squads

| Squad | Agents | Use Case |
|-------|--------|----------|
| `audit` | accuracy, health, security, ux_reviewer, dep_scanner, db_auditor, perf_profiler, a11y_auditor, api_designer, llm_engineer, frontend_auditor, manager | Full codebase health check — weekly or post-major changes |
| `plan` | features, integration, researcher, threat_modeler, business_analyst, manager | Feature planning with security + business analysis |
| `review` | reviewer, accuracy, api_designer, test_writer, github, llm_engineer, frontend_auditor, manager | Post-change code review |
| `ship` | health, security, dep_scanner, api_contract_checker, perf_profiler, cicd_auditor, test_writer, content_curator, github, manager | Pre-release gate |
| `release` | github, content_curator, test_writer, security, manager | Version bump and release workflow |
| `build` | builder | Implement a task/feature from spec (`run_builder.sh`) |

### Security Squads

| Squad | Agents | Schedule / Use Case |
|-------|--------|---------------------|
| `security_quick` | dep_scanner, secrets_detector, security, report_dispatcher | Daily (Mon 8am) — fast security check under 5 minutes |
| `secure` | dep_scanner, secrets_detector, threat_modeler, db_auditor, api_contract_checker, mobile_auditor, cicd_auditor, docker_auditor, security, report_dispatcher | Weekly / pre-release — full security suite |
| `dep_scan` | dep_scanner, report_dispatcher | Daily (6am) — dependency CVE scan only |
| `secrets_scan` | secrets_detector, report_dispatcher | Daily (7am) — secrets detection only |

### Specialized Squads

| Squad | Agents | Use Case |
|-------|--------|----------|
| `mobile` | mobile_auditor, api_contract_checker, perf_profiler, frontend_auditor, report_dispatcher | Mobile app security and performance audit |
| `a11y` | a11y_auditor, report_dispatcher | Weekly (Tue 10am) — WCAG 2.1 AA review |
| `incident` | incident_responder, report_dispatcher | Every 4h (automated) — incident detection, always HITL |

### Operations / Maintenance Squads

| Squad | Agents | Use Case |
|-------|--------|----------|
| `tools` | tools_monitor, incident_responder, report_dispatcher | Tools ecosystem health audit |
| `workspace` | notes_curator, library_curator, workspace_steward, wiki_librarian, tools_monitor, report_dispatcher | Full workspace audit |
| `knowledge` | notes_curator, library_curator, wiki_librarian, report_dispatcher | Knowledge management only |
| `hygiene` | workspace_steward, report_dispatcher | File cleanup, naming conventions |
| `wiki` | wiki_librarian, report_dispatcher | Update system wiki after changes |
| `email` | email_manager, report_dispatcher | Email management and task extraction |
| `node_update` | node_updater, tools_monitor, report_dispatcher | Safe Node.js dependency upgrades |
| `onboard` | project_onboarder, report_dispatcher | Onboard external projects |
| `evolve` | self_assessment | Assess team gaps, propose new agents |
| `dispatch` | report_dispatcher | Process all reports in latest/, generate briefings |
| `familiarize` | familiarizer | First-run project onboarding |

### Auto-Fix Squads (Use with caution)

| Squad | Agents | Use Case |
|-------|--------|----------|
| `auto_safe` | accuracy, health, security, reviewer, executor_safe | Audit then auto-apply non-breaking fixes only |
| `auto_full` | accuracy, health, security, reviewer, ux_reviewer, executor_full | Audit then auto-apply all improvements |

---

## Orchestrator Schedule

These squads run automatically via `tools/opai-orchestrator/`:

| Schedule Name | Cron | Squad | Purpose |
|--------------|------|-------|---------|
| `dep_scan_daily` | `0 6 * * *` | dep_scan | Daily 6am — CVE scan |
| `secrets_scan_daily` | `0 7 * * *` | secrets_scan | Daily 7am — secrets scan |
| `security_quick` | `0 8 * * 1` | security_quick | Monday 8am — quick security sweep |
| `incident_check` | `0 */4 * * *` | incident | Every 4h — incident detection |
| `a11y_weekly` | `0 10 * * 2` | a11y | Tuesday 10am — accessibility |
| `feedback_process` | `*/5 * * * *` | — | Every 5min — feedback fixer |
| `health_check` | `*/5 * * * *` | — | Every 5min — service health |
| `task_process` | `*/15 * * * *` | — | Every 15min — task queue |
| `knowledge_sync` | `0 18 * * *` | — | Daily 6pm — knowledge sync |
| `workspace_audit` | `0 9 * * 1` | — | Monday 9am — workspace audit |

---

## How to Use

### Running Squads

```bash
# Quick daily security check
./scripts/run_squad.sh -s security_quick

# Full security sweep (weekly)
./scripts/run_squad.sh -s secure

# Mobile app audit
./scripts/run_squad.sh -s mobile

# Full audit (all health agents)
./scripts/run_squad.sh -s audit

# Pre-release gate
./scripts/run_squad.sh -s ship

# Accessibility review
./scripts/run_squad.sh -s a11y

# Incident scan (always produces HITL)
./scripts/run_squad.sh -s incident

# Force re-run (ignore cached reports)
./scripts/run_squad.sh -s audit --force
```

### Running Individual Agents

```bash
# Run specific agents by name
./scripts/run_agents_seq.sh --filter "dep_scanner,secrets_detector"

# Run dep_scanner standalone
./scripts/run_agents_seq.sh --filter "dep_scanner"
```

### Builder Agent

```bash
# Implement from a spec file
./scripts/run_builder.sh specs/my-feature.md

# Inline task
./scripts/run_builder.sh -t "Add rate limiting to /api/feedback"

# Dry run (plan only, no file changes)
./scripts/run_builder.sh -t "Add dark mode to Monitor" --dry-run

# With context scope
./scripts/run_builder.sh -t "Fix async blocking" --context tools/opai-agents
```

### Session-Based Plugin Installs (Path A)

Use these when you need the interactive slash commands or opus-class agents in a Claude Code session:

```bash
# To use /agent-teams:team-review for interactive code review
/plugin install agent-teams

# To use /security-scanning:security-hardening interactively
/plugin install security-scanning

# To use /full-stack-orchestration:full-stack-feature for end-to-end feature work
/plugin install full-stack-orchestration

# When working on the mobile app
/plugin install react-native

# When doing Python/FastAPI work interactively
/plugin install python-development

# When doing database work
/plugin install database-design
```

### Report Outputs

All squad runs produce reports in `reports/<date>/` and `reports/latest/`. Always includes:
- `_run_summary.md` — run metadata, per-agent status table, duration (always written, even on failure)
- Per-agent markdown report (e.g., `dep_scanner_report.md`)
- HITL items → `reports/HITL/` (requires human review before action)

---

## Coverage Scorecard

| Domain | Before Integration | After Integration | Automated | Squads |
|--------|-------------------|------------------|-----------|--------|
| Injection / path traversal | Moderate | **Strong** | Y | audit, secure |
| Broken authentication | Strong | Strong | Y | audit, ship |
| Secrets in code | **None** | **Strong — daily** | Y | security_quick, secrets_scan |
| Secrets in git history | **None** | **Strong — daily** | Y | secrets_scan |
| CVE / known vulnerabilities | **None** | **Strong — daily** | Y | security_quick, dep_scan |
| Broken access control (IDOR) | Moderate | **Strong** | Y | secure, audit |
| Security misconfiguration | Moderate | **Strong** | Y | secure |
| XSS / DOM injection | Moderate | **Strong** | Y | secure |
| Docker / container security | **None** | **Strong** | Y | secure |
| CI/CD pipeline security | **None** | **Strong** | Y | secure, ship |
| Mobile security | **None** | **Strong** | Y | mobile, secure |
| Database (RLS, migrations) | **None** | **Strong** | Y | audit, secure |
| API contract compliance | **None** | **Strong** | Y | review, ship, mobile |
| Performance profiling | Weak | **Moderate** | Y | audit, ship, mobile |
| Accessibility (WCAG) | Weak | **Strong** | Y | a11y, audit |
| Incident detection | **None** | **Moderate (HITL)** | Y | incident, tools |
| Threat modeling | **None** | **Strong** | Y | secure, plan |
| PCI / payment security | **None** | **Strong** | Y | secure, audit |
| API design consistency | **None** | **Strong** | Y | review, audit |
| LLM/RAG architecture | **None** | **Strong** | Y | audit, review |
| Frontend code quality | Weak | **Strong** | Y | audit, review, mobile |
| Business analysis | **None** | **Strong** | Y | plan |

---

## Complete Role Roster (45 Roles)

| Role | Emoji | Category | Run Order | Squads |
|------|-------|----------|-----------|--------|
| `manager` | PM | leadership | last | audit, plan, review, ship, release |
| `reviewer` | CR | quality | parallel | review, auto_safe, auto_full |
| `accuracy` | AC | quality | parallel | audit, review, auto_safe, auto_full |
| `health` | HL | quality | parallel | audit, ship, auto_safe, auto_full |
| `security` | SC | quality | parallel | audit, ship, release, auto_safe, auto_full, security_quick, secure |
| `features` | FA | planning | parallel | plan |
| `integration` | IA | planning | parallel | plan |
| `researcher` | RS | research | parallel | plan |
| `github` | GH | operations | parallel | review, ship, release |
| `content_curator` | CC | content | parallel | ship, release |
| `test_writer` | TE | quality | parallel | review, ship, release |
| `ux_reviewer` | UX | quality | parallel | audit, auto_full |
| `familiarizer` | HI | meta | first | familiarize |
| `executor_safe` | E1 | execution | last | auto_safe |
| `executor_full` | E2 | execution | last | auto_full |
| `self_assessment` | SA | meta | last | evolve |
| `notes_curator` | NC | operations | parallel | knowledge, workspace |
| `library_curator` | LC | operations | parallel | knowledge, workspace |
| `report_dispatcher` | RD | orchestration | last | most squads |
| `project_onboarder` | OB | operations | parallel | onboard |
| `workspace_steward` | WS | operations | parallel | hygiene, workspace |
| `email_manager` | EM | operations | parallel | email |
| `tools_monitor` | TM | operations | parallel | tools, workspace, node_update |
| `wiki_librarian` | WK | operations | parallel | knowledge, workspace, wiki |
| `node_updater` | NU | operations | parallel | node_update |
| `prdgent` | 🧪 | research | parallel | (PRD Pipeline only — not in squads) |
| `feedback_fixer` | 🔧 | execution | parallel | (orchestrator only) |
| `problem_solver` | PS | research | parallel | (on-demand) |
| `cd` | Cd | content | parallel | (on-demand) |
| `builder` | BL | execution | parallel | build |
| `dep_scanner` | DS | security | parallel | audit, ship, secure, security_quick, dep_scan |
| `secrets_detector` | SD | security | parallel | audit, ship, secure, security_quick, secrets_scan |
| `threat_modeler` | TH | security | parallel | secure, plan |
| `db_auditor` | DB | security | parallel | audit, secure |
| `api_contract_checker` | AC | security | parallel | review, ship, secure, mobile |
| `perf_profiler` | PP | quality | parallel | audit, ship, mobile |
| `mobile_auditor` | MA | security | parallel | mobile, secure |
| `cicd_auditor` | CI | security | parallel | secure, ship |
| `docker_auditor` | DK | security | parallel | secure |
| `api_designer` | AD | quality | parallel | review, audit, plan |
| `a11y_auditor` | A1 | quality | parallel | audit, ship, a11y |
| `incident_responder` | IR | operations | parallel | tools, incident |
| `llm_engineer` | LE | quality | parallel | audit, review |
| `frontend_auditor` | FR | quality | parallel | audit, review, mobile |
| `business_analyst` | BA | research | parallel | plan |

---

## Key Technical Notes

- **CLAUDECODE env var**: Claude Code sets this env var which blocks nested `claude` spawns. `run_squad.sh` explicitly runs `unset CLAUDECODE` before every `claude -p` invocation.
- **run_summary.md**: Every squad run writes `_run_summary.md` with agent status table, duration, and report file list — even if all agents fail.
- **Failed agents write reports**: Failed agents produce a markdown error report rather than no output, so the dispatcher always has something to work with.
- **Path A does NOT persist**: `/plugin install` resets on every new Claude Code session. Do not configure wshobson as an auto-loaded MCP — the token cost (150-300KB upfront) is not worth it for batch squad workflows.
- **Specialist templates**: `team.json` → `specialist_templates` lists 7 project-specific agent templates in `Templates/` (expo_expert, supabase_expert, n8n_connector, wordpress_expert, etc.). Copy to `scripts/` and customize per project.

---

## Dependencies

- **CLI**: `claude` (Claude Code CLI via nvm), `jq`
- **Source**: `mcps/wshobson-agents/` — full 72-plugin repository
- **Config**: `team.json` (45 roles, 26 squads), `scripts/prompt_*.txt` (30 enhanced prompt files, 90 skill injections), `config/orchestrator.json`
- **Skills Catalog**: `Library/knowledge/WSHOBSON-SKILLS-SUMMARY.md`, `Library/knowledge/wshobson-skills-catalog.csv`
- **Batch Install**: `scripts/plugins-install.sh` (groups: core/security/workflows/frontend/business/infra/ai/backend/all)
- **Reports**: `reports/<date>/*.md`, `reports/latest/`, `reports/HITL/`
- **Related**: [Agent Framework](agent-framework.md), [Orchestrator](orchestrator.md), [Task Control Panel](task-control-panel.md), [Agent Studio](agent-studio.md)
