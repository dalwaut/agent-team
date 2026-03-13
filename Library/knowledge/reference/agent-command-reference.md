# OPAI Agent & Command Reference
> Created: 2026-02-20 | Last Updated: 2026-02-20 | Purpose: Complete inventory of all agents/commands + security gap map

---

## Executive Summary — Critical Gaps

| Priority | Gap | Risk | Status |
|----------|-----|------|--------|
| ✅ FIXED | No secrets detection | Data exfiltration | `secrets_detector` agent — daily at 7am |
| ✅ FIXED | No CVE scanning — dependencies never audited | Supply chain compromise | `dep_scanner` agent — daily at 6am |
| ✅ FIXED | `feedback_fixer` has no forbidden file list | Can modify auth/credentials | Forbidden file list added to prompt |
| ✅ FIXED | `tools_monitor` references dead services — misses 8+ active tools | Silent tool failures | Prompt updated with all 14 active tools |
| ✅ FIXED | No database RLS audit | Supabase data exposure | `db_auditor` agent — `secure` squad |
| ✅ FIXED | No threat modeling — trust boundaries undocumented | Unknown attack surface | `threat_modeler` agent — `secure` squad |
| ✅ FIXED | No API contract enforcement — routes drift silently | Mobile app breakage | `api_contract_checker` agent — `secure` squad |
| ✅ FIXED | `fnmatch **` bug — `notes/Access/**` blocks nothing in Python | Path traversal unblocked | Replaced with `is_relative_to()` + `fnmatch` on name in `context_resolver.py` |
| ✅ FIXED | No Docker/container security audit | Container escape, privilege escalation | `docker_auditor` agent — `secure` squad |
| ✅ FIXED | No CI/CD pipeline security audit | Secrets in GH Actions, unsigned commits | `cicd_auditor` agent — `secure` + `ship` squads |
| ✅ FIXED | No mobile security audit — Expo app has no review | Token storage, bundle secrets | `mobile_auditor` agent — `mobile` + `secure` squads |
| 🟡 MEDIUM | No WCAG automated tooling — ux_reviewer is manual only | Accessibility failures | WCAG checklist added to `ux_reviewer` |
| 🟡 MEDIUM | No prompt injection coverage (AI-specific) | LLM manipulation | Phase 2: manual review item |

---

## Section 1: Interactive Session Agents & Commands

These are available **only in active Claude Code interactive sessions**. They reset when the session ends. Use `/plugin install` at the start of each session (plugins reload from the marketplace, no disk changes).

### Currently Installed Plugins (3)

---

#### `agent-teams`
**Install:** `/plugin install agent-teams`

| Command | What It Does | Best For |
|---------|-------------|----------|
| `/agent-teams:team-review <target>` | Parallel multi-perspective review (security, performance, architecture) | Thorough pre-merge or pre-release code review |
| `/agent-teams:team-debug "<issue>"` | Parallel root-cause analysis with competing hypotheses | Bugs with multiple possible causes |
| `/agent-teams:team-feature "<description>"` | Parallel feature implementation with file ownership boundaries | Complex features touching many files |
| `/agent-teams:team-spawn <preset>` | Spin up a named team (presets: review, debug, feature, fullstack, research, security, migration) | Custom team compositions |
| `/agent-teams:team-delegate` | Redistribute work across active team members | Rebalancing in-progress work |
| `/agent-teams:team-status` | Check progress of running team | Monitoring parallel work |
| `/agent-teams:team-shutdown` | Gracefully tear down active team | Cleanup after team completes |

**Auto-loaded skills (active by context):**
- `multi-reviewer-patterns` — severity calibration, finding deduplication across reviewers
- `parallel-debugging` — competing hypothesis framework, evidence collection protocols
- `parallel-feature-development` — file ownership conflict avoidance, integration patterns
- `task-coordination-strategies` — dependency graph decomposition, workload balancing
- `team-communication-protocols` — message type selection, approval patterns, shutdown procedures
- `team-composition-patterns` — team sizing heuristics, preset configurations

---

#### `security-scanning`
**Install:** `/plugin install security-scanning`

| Command | What It Does | Best For |
|---------|-------------|----------|
| `/security-scanning:security-hardening` | 13-step security hardening orchestrator (4 phases: Assessment → Remediation → Controls → Validation) | Comprehensive security hardening of a tool |
| `/security-scanning:security-sast` | SAST: semgrep (OWASP Top Ten), bandit (Python), eslint-security (JS), gosec (Go) — produces SARIF output with CWE/OWASP mapping | Pre-release vulnerability scan |
| `/security-scanning:security-dependencies` | Scan dependencies for CVEs and security advisories | Dependency audit |
| `/security-scanning:compliance-check` | Validate against SOC2/HIPAA/GDPR requirements | Compliance review |
| `/security-scanning:xss-scan` | Scan frontend code for XSS vulnerabilities | Frontend security review |

**Auto-loaded skills:**
- `attack-tree-construction` — attack path visualization, defense gap identification
- `sast-configuration` — semgrep custom rules, CWE/OWASP mapping, CI/CD integration
- `security-requirement-extraction` — derive security requirements from threat models
- `stride-analysis-patterns` — STRIDE-per-interaction, trust boundary detection, risk scoring
- `threat-mitigation-mapping` — map threats to controls, validate control effectiveness

---

#### `full-stack-orchestration`
**Install:** `/plugin install full-stack-orchestration`

| Command | What It Does | Best For |
|---------|-------------|----------|
| `/full-stack-orchestration:full-stack-feature "<description>"` | 9-phase gated feature build: requirements → architecture (HITL) → API design → DB schema → test spec → backend → frontend (HITL) → integration testing → deployment prep | Building a complete feature from scratch with human approval before implementation |

---

### High-Priority Plugins to Install Next

Run these in any Claude Code session to immediately unlock additional expertise:

```bash
/plugin install python-development        # python-pro, fastapi-pro (opus) + 16 Python skills
/plugin install database-design           # database-architect, sql-pro + PostgreSQL SKILL.md
/plugin install payment-processing        # payment-integration + stripe, pci-compliance skills
/plugin install accessibility-compliance  # ui-visual-validator + wcag-audit-patterns
/plugin install backend-api-security      # backend-security-coder + API auth patterns
/plugin install javascript-typescript     # typescript-pro (opus) + modern-javascript-patterns
/plugin install shell-scripting           # bash-pro + bash-defensive-patterns
/plugin install comprehensive-review      # code-reviewer, architect-review (opus) + full-review command
/plugin install codebase-cleanup          # refactor-clean, tech-debt, deps-audit commands
/plugin install frontend-mobile-security  # mobile-security-coder + xss-scan
```

---

## Section 2: Automated Pipeline Agents (42 Active Roles)

These run headlessly via `./scripts/run_squad.sh -s <squad>` using `claude -p` batch mode. They run on schedule via the orchestrator or on-demand from the Task Control Panel.

### Quality Agents

| Agent | Model | Run Order | Squads | Gaps |
|-------|-------|-----------|--------|------|
| `security` | opus | parallel | audit, ship, release, auto_safe, auto_full, security_quick, secure | No SAST tooling, no container security, no prompt injection awareness |
| `health` | sonnet | parallel | audit, ship, auto_safe, auto_full | ✅ Python async blocking patterns added |
| `accuracy` | sonnet | parallel | audit, review, auto_safe, auto_full | No currency/decimal precision check despite Stripe billing |
| `reviewer` | sonnet | parallel | review, auto_safe, auto_full | ✅ Python + bash review sections added |
| `test_writer` | sonnet | parallel | review, ship, release | No E2E, no load testing — OPAI has zero test infrastructure |
| `ux_reviewer` | sonnet | parallel | audit, auto_full | ✅ WCAG 2.1 AA 11-item checklist added |

### Performance Agents

| Agent | Model | Run Order | Squads | What It Does |
|-------|-------|-----------|--------|-------------|
| `perf_profiler` | sonnet | parallel | audit, ship, mobile | Sync I/O in async handlers, unbounded concurrency, missing pagination, subprocess semaphores, memory leaks, hot path analysis. |

### Phase 1 Security Agents (NEW — 2026-02-20)

| Agent | Model | Run Order | Squads | What It Does |
|-------|-------|-----------|--------|-------------|
| `dep_scanner` | sonnet | parallel | dep_scan, security_quick, secure | Scans all manifests for unpinned versions, known vulnerable packages, missing lock files, lifecycle script risks. Daily 6am. |
| `secrets_detector` | sonnet | parallel | secrets_scan, security_quick, secure | Pattern-based scan for API keys, tokens, private keys, DB creds, env hygiene. Never outputs full secret values. Daily 7am. |
| `threat_modeler` | sonnet | parallel | secure | STRIDE analysis across all trust boundaries — Caddy, auth, agent pipeline, Discord bridge, RLS, orchestrator. Attack trees for top 3 threats. |
| `db_auditor` | sonnet | parallel | secure | RLS coverage matrix for all tables, SQL injection vectors, connection security, migration file safety (DROP/TRUNCATE), unbounded queries. |
| `api_contract_checker` | sonnet | parallel | secure, ship, mobile | Auth coverage per endpoint, HTTP method correctness, request validation (Pydantic), response format consistency, rate limit gaps, CORS. |

### Phase 2 Security Agents (NEW — 2026-02-20)

| Agent | Model | Run Order | Squads | What It Does |
|-------|-------|-----------|--------|-------------|
| `mobile_auditor` | sonnet | parallel | mobile, secure | AsyncStorage token storage, hardcoded secrets in bundle, network security, deep link safety, Expo SDK/EAS build hygiene, API contract compliance. |
| `cicd_auditor` | sonnet | parallel | secure, ship | GH Actions SHA pinning, secret injection vectors, systemd hardening (NoNewPrivileges/PrivateTmp), Caddy security headers, deployment script safety. HITL for remediation. |
| `docker_auditor` | sonnet | parallel | secure | Container privilege (root/privileged), Docker socket mounts, secrets in ENV/ARG, base image hygiene, resource limits, port binding. |

### Phase 3 Agents (NEW — 2026-02-20)

| Agent | Model | Run Order | Squads | What It Does |
|-------|-------|-----------|--------|-------------|
| `api_designer` | sonnet | parallel | audit, review | REST naming, HTTP method correctness, status codes, pagination, request validation, versioning, error schema consistency across all tools. |
| `a11y_auditor` | sonnet | parallel | audit, a11y | WCAG 2.1 AA: images/alt text, color contrast, keyboard nav, focus visibility, form labels, page structure (landmarks/headings), ARIA usage. |
| `incident_responder` | sonnet | parallel | tools, incident | Service log anomaly detection, orchestrator health, auth pattern analysis, disk pressure, integration failures. Always HITL — never auto-remediates. Every 4h + daily tools run. |

### Planning Agents

| Agent | Model | Run Order | Squads | Gaps |
|-------|-------|-----------|--------|------|
| `features` | opus | parallel | plan | No OPAI-specific service architecture knowledge |
| `integration` | opus | parallel | plan | No knowledge of OPAI's actual integration landscape |
| `researcher` | sonnet | parallel | plan | No Python/pip ecosystem research capability |

### Operations Agents

| Agent | Model | Run Order | Squads | Gaps |
|-------|-------|-----------|--------|------|
| `github` | sonnet | parallel | review, ship, release | Strongest prompt in system — no major gaps |
| `content_curator` | sonnet | parallel | ship, release | No OPAI brand voice guidance |
| `notes_curator` | sonnet | parallel | knowledge, workspace | — |
| `library_curator` | sonnet | parallel | knowledge, workspace | — |
| `report_dispatcher` | opus | last | knowledge, dispatch, onboard, hygiene, workspace, email, tools, wiki, node_update | Orchestration brain — no major gaps |
| `project_onboarder` | sonnet | parallel | onboard | — |
| `workspace_steward` | sonnet | parallel | hygiene, workspace | — |
| `email_manager` | sonnet | parallel | email | HITL required for all email actions |
| `tools_monitor` | sonnet | parallel | tools, workspace | ✅ Updated — dead services removed, all 14 active tools now covered |
| `wiki_librarian` | sonnet | parallel | knowledge, wiki, workspace, node_update | — |
| `node_updater` | sonnet | parallel | node_update | No Python pip equivalent |

### Meta Agents

| Agent | Model | Run Order | Squads | Gaps |
|-------|-------|-----------|--------|------|
| `familiarizer` | opus | first | familiarize | One-time only — generates `project_context.md` |
| `self_assessment` | opus | last | evolve | Team gap analysis — no major gaps |

### Execution Agents

| Agent | Model | Run Order | Squads | Gaps |
|-------|-------|-----------|--------|------|
| `executor_safe` | opus | last | auto_safe | Applies non-breaking fixes only (dead code, console.log, type annotations) |
| `executor_full` | opus | last | auto_full | All safe fixes + refactoring, bug fixes, auth improvements |
| `feedback_fixer` | sonnet | parallel | (feedback system) | ✅ Forbidden file list added — credentials/auth/Caddyfile/team.json protected |
| `builder` | opus | parallel | build | Reads wiki, explores, plans, implements, verifies — solid prompt |
| `cd` | opus | parallel | standalone | Production-ready code generation to stdout |
| `problem_solver` | sonnet | parallel | standalone | Bridges ambiguous problems to discrete tasks |
| `prdgent` | sonnet | parallel | PRD pipeline | Idea evaluation, JSON verdict output |

---

### Squad Reference

| Squad | Agents | Trigger |
|-------|--------|---------|
| `audit` | security, health, accuracy, ux_reviewer, manager | Manual / weekly |
| `plan` | features, integration, researcher, manager | Before new feature work |
| `review` | reviewer, accuracy, test_writer, github, manager | After code changes |
| `ship` | security, health, test_writer, content_curator, github, manager | Pre-release gate |
| `release` | github, content_curator, test_writer, security, manager | Version release |
| `auto_safe` | security, health, accuracy, reviewer, executor_safe | Safe auto-fix cycle |
| `auto_full` | security, health, accuracy, reviewer, ux_reviewer, executor_full | Full auto-fix cycle |
| `build` | builder | On-demand feature implementation |
| `knowledge` | notes_curator, library_curator, wiki_librarian, report_dispatcher | Daily 6pm (orchestrator) |
| `hygiene` | workspace_steward, report_dispatcher | On-demand |
| `workspace` | notes_curator, library_curator, workspace_steward, tools_monitor, wiki_librarian, report_dispatcher | Weekly Monday 9am |
| `email` | email_manager, report_dispatcher | Every 30min (orchestrator) |
| `tools` | tools_monitor, report_dispatcher | Every 5min (orchestrator) |
| `wiki` | wiki_librarian, report_dispatcher | Post-implementation |
| `node_update` | node_updater, tools_monitor, wiki_librarian, report_dispatcher | On-demand |
| `evolve` | self_assessment | On-demand |
| `dispatch` | report_dispatcher | On-demand |
| `onboard` | project_onboarder, report_dispatcher | On-demand |
| `familiarize` | familiarizer | One-time setup |
| `dep_scan` | dep_scanner, report_dispatcher | Daily 6am (orchestrator) |
| `secrets_scan` | secrets_detector, report_dispatcher | Daily 7am (orchestrator) |
| `security_quick` | dep_scanner, secrets_detector, security, report_dispatcher | Weekly Monday 8am (orchestrator) |
| `secure` | dep_scanner, secrets_detector, threat_modeler, db_auditor, api_contract_checker, security, report_dispatcher | Weekly + pre-release |
| `mobile` *(Phase 2)* | mobile_auditor, api_contract_checker, a11y_auditor, report_dispatcher | On-demand |

---

## Section 3: Security Coverage Map

### Attack Vector Coverage (23 Vectors)

| # | Attack Vector | Agent(s) | Automated | Strength | Gap |
|---|--------------|----------|-----------|----------|-----|
| 1 | SQL Injection | security | Y | Moderate | No SAST tooling, pattern-based only |
| 2 | Command Injection / Path Traversal | security | Y | Moderate | fnmatch `**` bug means `notes/Access/**` is unblocked |
| 3 | Prompt Injection (AI-specific) | — | **N** | **None** | No agent reviews LLM input handling |
| 4 | Broken Authentication | security | Y | Strong | OWASP A07 — auth reviewer covers this well |
| 5 | Sensitive Data Exposure in Code | ✅ `secrets_detector` | Y | **Strong — daily 7am** | Covers all pattern types, env hygiene, never outputs full values |
| 6 | Secrets in Git History | ✅ `secrets_detector` | Y | Moderate | Source scan daily; git history scan needs explicit `--no-skip-binary` run |
| 7 | XXE / JSON External Entities | security | Y | Weak | Mentioned in security prompt, not focused |
| 8 | Broken Access Control (IDOR) | security | Y | Moderate | Identified in opai-chat review (H-2, H-11) but not auto-remediated |
| 9 | Security Misconfiguration (CORS, headers, debug) | security | Y | Moderate | CORS wildcard + `AUTH_DISABLED` identified but not tracked |
| 10 | XSS (reflected, stored, DOM) | security | Y | Moderate | DOM XSS via `innerHTML` not caught — `marked.js` without DOMPurify |
| 11 | Insecure Deserialization | security | Y | Weak | Mentioned in OWASP list, not deeply audited |
| 12 | CVE / Known Vulnerabilities | ✅ `dep_scanner` | Y | **Strong — daily 6am** | All manifests: requirements.txt, package.json, lock file audit, lifecycle scripts |
| 13 | Insufficient Logging & Monitoring | security | Y | Weak | Referenced but not verified against actual log output |
| 14 | SSRF | security | Y | Weak | Gemini URL handling flagged, no systematic check |
| 15 | Supply Chain (postinstall scripts, malicious packages) | ✅ `dep_scanner` | Y | Moderate | Checks postinstall/preinstall scripts, lock file presence, duplicate packages |
| 16 | DoS / Rate Limiting | security | Y | Moderate | Identified in reviews, not auto-enforced |
| 17 | Docker / Container Security | — | **N** | **None** | n8n + Coolify on BB VPS — never audited |
| 18 | CI/CD Pipeline Security (GH Actions, systemd) | — | **N** | **None** | systemd services, GH Actions — no audit |
| 19 | Mobile Security (AsyncStorage, certificate pinning) | — | **N** | **None** | Expo app — never audited |
| 20 | WebSocket Security | security | Y | Weak | Message size limit, auth checks — basic coverage |
| 21 | Data Privacy / GDPR / PII | security | Y | Weak | Mentioned in OWASP A02, not GDPR-specific |
| 22 | Stripe / Payment Security (PCI) | — | **N** | **None** | Stripe live in production — no PCI audit |
| 23 | Infrastructure (Caddy, Tailscale, Supabase RLS) | — | **N** | **None** | **CRITICAL: RLS on all tables never audited** |

**Coverage score: 8/23 vectors with meaningful automated coverage (35%)**

### Priority Gap Table

| Priority | Gap | Risk Level | Recommended Agent |
|----------|-----|-----------|-------------------|
| P1 — Immediate | Secrets in code/git history | CRITICAL | `secrets_detector` (new) |
| P1 — Immediate | CVE in npm/pip dependencies | CRITICAL | `dep_scanner` (new) |
| P1 — Immediate | `feedback_fixer` no forbidden file list | CRITICAL | Fix `prompt_feedback_fixer.txt` |
| P1 — Immediate | `notes/Access/` API readable via fnmatch bug | CRITICAL | Fix `context_resolver.py` (opai-chat) |
| P2 — This sprint | Supabase RLS audit | HIGH | `db_auditor` (new) |
| P2 — This sprint | Mobile security (Expo app) | HIGH | `mobile_auditor` (new) |
| P2 — This sprint | Docker container security (BB VPS) | HIGH | `docker_auditor` (new) |
| P2 — This sprint | CI/CD + systemd hardening | HIGH | `cicd_auditor` (new) |
| P2 — This sprint | PCI compliance (Stripe live) | HIGH | Install `payment-processing` plugin |
| P3 — This month | Threat modeling — trust boundaries | MEDIUM | `threat_modeler` (new) |
| P3 — This month | API contract drift | MEDIUM | `api_contract_checker` (new) |
| P3 — This month | WCAG compliance tooling | MEDIUM | `a11y_auditor` (new) |
| P3 — This month | Incident detection | MEDIUM | `incident_responder` (new) |

### Post-Integration Coverage (After All 12 New Agents)

| Attack Vector | Coverage | Strength |
|--------------|----------|----------|
| All injection types | Y | Strong |
| Authentication | Y | Strong |
| Secrets in code/git | Y | **Strong — daily** |
| Known CVEs | Y | **Strong — daily** |
| Access control | Y | Strong |
| Security misconfiguration | Y | Strong |
| XSS | Y | Strong |
| Supply chain | Y | **Strong** |
| DoS / rate limiting | Y | Moderate |
| Docker/container | Y | **Strong** |
| CI/CD pipeline | Y | **Strong** |
| Mobile security | Y | **Strong** |
| Supabase RLS | Y | **Strong** |
| PCI / payments | Y | **Strong** |
| GDPR / privacy | Y | Moderate |
| Threat modeling | Y | **Strong** |
| Incident detection | Y | Moderate (HITL) |
| **Coverage score** | | **20/23 (87%)** |

---

## Section 4: Agent Invocation Reference

### From Interactive Claude Code Session

```bash
# Installed plugin commands (available now)
/agent-teams:team-review tools/opai-chat
/agent-teams:team-review tools/opai-portal/
/agent-teams:team-debug "Monitor WebSocket connections dropping after 30s"
/agent-teams:team-feature "Add notification preferences to user settings"
/agent-teams:team-spawn security
/security-scanning:security-sast tools/opai-wordpress/
/security-scanning:security-hardening tools/opai-portal/
/security-scanning:security-dependencies
/security-scanning:xss-scan tools/opai-chat/static/
/full-stack-orchestration:full-stack-feature "Add OAuth2 login to the portal"

# After installing python-development
/python-development:python-scaffold

# After installing comprehensive-review
/comprehensive-review:full-review tools/opai-team-hub/
/comprehensive-review:pr-enhance

# After installing codebase-cleanup
/codebase-cleanup:tech-debt tools/opai-chat/
/codebase-cleanup:deps-audit
```

### From Terminal (Automated Pipeline)

```bash
# Run a squad
./scripts/run_squad.sh -s audit
./scripts/run_squad.sh -s ship
./scripts/run_squad.sh -s review
./scripts/run_squad.sh -s secure          # Full security suite (Phase 1 complete)
./scripts/run_squad.sh -s security_quick  # Fast daily check (Phase 1 complete)
./scripts/run_squad.sh -s dep_scan        # Dependency scan only
./scripts/run_squad.sh -s secrets_scan    # Secrets scan only
./scripts/run_squad.sh -s mobile          # NEW (planned Phase 2)

# Run a specific agent
./scripts/run_agents_seq.sh --filter security
./scripts/run_agents_seq.sh --filter "security,dep_scanner"  # after Phase 1
./scripts/run_agents_seq.sh --filter feedback_fixer

# Force re-run ignoring cache
./scripts/run_squad.sh -s audit --force

# Builder: implement a task
./scripts/run_builder.sh -t "Fix the fnmatch ** bug in context_resolver.py" --context tools/opai-chat
./scripts/run_builder.sh -t "Add DOMPurify to marked.js rendering in opai-chat"
./scripts/run_builder.sh specs/my-feature.md
./scripts/run_builder.sh --dry-run -t "Add dark mode to Monitor"

# Full auto-fix cycles
./scripts/run_squad.sh -s auto_safe
./scripts/run_squad.sh -s auto_full
```

### From Orchestrator API

```bash
# Trigger squad via orchestrator REST API (port 3737)
curl -s http://localhost:3737/api/run-squad -d '{"squad":"security_quick"}'
curl -s http://localhost:3737/api/run-squad -d '{"squad":"audit"}'
curl -s http://localhost:3737/api/status
```

### From Agent Studio (UI)

- Navigate to `/agents/` → select agent → configure model/turns → "Run Task"
- Supports: model selection (haiku/sonnet/opus), max turns, project context toggle
- Shows audit trail with resolved model and turn count
- All 28 active agents are available from the UI

### From Service Control Script

```bash
./scripts/opai-control.sh status          # all service statuses
./scripts/opai-control.sh logs opai-tasks # logs for specific service
./scripts/opai-control.sh restart opai-chat
```

---

## Section 5: Prompt Quality Audit

| Agent | Prompt Quality | Primary Gap | Priority to Fix |
|-------|---------------|-------------|-----------------|
| `security` | ✅ Strong | No SAST tooling references, no container/Docker knowledge | Low |
| `health` | ✅ Strong | ✅ Python async blocking + Node.js patterns added 2026-02-20 | Done |
| `accuracy` | ✅ Strong | No Stripe decimal precision / currency handling | Medium |
| `github` | ✅ Strong | — | None |
| `content_curator` | ✅ Strong | No OPAI brand voice | Low |
| `notes_curator` | ✅ Strong | — | None |
| `library_curator` | ✅ Strong | — | None |
| `report_dispatcher` | ✅ Strong | — | None |
| `workspace_steward` | ✅ Strong | — | None |
| `email_manager` | ✅ Strong | HITL required for all actions | None |
| `wiki_librarian` | ✅ Strong | — | None |
| `prdgent` | ✅ Strong | — | None |
| `cd` | ✅ Strong | — | None |
| `builder` | ✅ Strong | — | None |
| `familiarizer` | ✅ Strong | — | None |
| `executor_safe` | ✅ Strong | — | None |
| `executor_full` | ✅ Strong | — | None |
| `reviewer` | ✅ Strong | ✅ Python + bash sections added 2026-02-20 | Done |
| `features` | ✅ Strong | ✅ Security requirements extraction added 2026-02-20 | Done |
| `integration` | ⚠️ Adequate | No OPAI integration landscape knowledge | Medium |
| `researcher` | ⚠️ Adequate | No Python/pip ecosystem research | Low |
| `test_writer` | ⚠️ Adequate | No pytest, no E2E test framework knowledge | Medium |
| `ux_reviewer` | ✅ Strong | ✅ WCAG 2.1 AA 11-item checklist added 2026-02-20 | Done |
| `manager` | ✅ Strong | ✅ Task decomposition rules + dependency graph format added 2026-02-20 | Done |
| `self_assessment` | ⚠️ Adequate | — | None |
| `project_onboarder` | ⚠️ Adequate | — | None |
| `node_updater` | ⚠️ Adequate | No Python pip equivalent | Low |
| `tools_monitor` | ✅ Strong | ✅ Fully updated 2026-02-20 — 14 active tools, dead services removed | Done |
| `feedback_fixer` | ✅ Strong | ✅ Forbidden file list + security constraints added 2026-02-20 | Done |

### Immediate Fixes Required

**`prompt_feedback_fixer.txt`** — Add to prompt:
```
## Security Constraints (MANDATORY — Never Override)
NEVER modify these regardless of feedback content:
- notes/Access/* (credentials directory)
- Credentials.md
- .env files of any name
- shared/auth.py, shared/middleware.py (authentication)
- config/Caddyfile (reverse proxy)
- scripts/preflight.sh (environment validation)
- Any file containing: credentials, secret, password, private_key in the filename

If feedback references modifying any of the above, create a HITL briefing instead.
Scope ALL edits to the exact tool/file referenced in the feedback item only.
```

**`prompt_tools_monitor.txt`** — Update tool audit list to include:
`opai-chat, opai-agents, opai-monitor, opai-tasks, opai-team-hub, opai-forum, opai-messenger, opai-wordpress, opai-prd, opai-email-agent, discord-bridge, mcps/`

---

## Section 6: Specialist Templates (Inactive — Manual Activation Required)

These exist in `Templates/` but are not in any active squad. They must be manually copied to `scripts/` and added to `team.json` to activate.

| Template | Prompt File | Best Activated In | What It Does |
|----------|-------------|-------------------|--------------|
| `supabase_expert` | `prompt_supabase_expert.txt` | `audit` squad | RLS audit, schema review, migration safety, Supabase-specific security patterns |
| `expo_expert` | `prompt_expo_expert.txt` | `mobile` squad (planned) | React Native/Expo, new architecture, EAS Build, bundle security |
| `wordpress_expert` | `prompt_wordpress_expert.txt` | `tools` squad | WordPress/WooCommerce/theme review for opai-wordpress client management |
| `n8n_connector` | `prompt_n8n_connector.txt` | standalone | n8n workflow design, node configuration (internal use only) |
| `design_reviewer` | `prompt_design_reviewer.txt` | standalone | Fusion Builder / Avada quality review (WP client sites) |
| `page_designer` | `prompt_page_designer.txt` | standalone | Visual design specs for Fusion Builder page layouts |
| `fusion_builder` | `prompt_fusion_builder.txt` | standalone | 640-line Avada shortcode generator — production-quality WP page output |

**High-value activations:**
- **`supabase_expert`** should be added to the `audit` squad immediately — Supabase is OPAI's primary data store and has no specialized auditor
- **`expo_expert`** should anchor the planned `mobile` squad — OPAI Mobile App has no expert reviewer currently

---

## Section 7: New Agents Rollout Status

### Phase 1 — COMPLETE ✅ (2026-02-20)

| Agent | Status | Squads | Gap Closed |
|-------|--------|--------|------------|
| `dep_scanner` | ✅ Active | dep_scan, security_quick, secure | CVE scanning — OWASP A06 — daily 6am |
| `secrets_detector` | ✅ Active | secrets_scan, security_quick, secure | Secrets in code + env hygiene — daily 7am |
| `threat_modeler` | ✅ Active | secure | STRIDE threat modeling — full trust boundary map |
| `db_auditor` | ✅ Active | secure | Supabase RLS matrix + migration safety + SQL injection |
| `api_contract_checker` | ✅ Active | secure | Auth coverage, validation, rate limit gaps, CORS |

**Post-Phase-1 report routing**: All squad reports → `tasks/registry.json` + email to Dallas@paradisewebfl.com. Email from Agent@paradisewebfl.com. HITL tasks appear in Tasks Control Panel.

### Phase 2 — Planned

| Agent | Phase | Model | Squads | Gap Closed |
|-------|-------|-------|--------|------------|
| `perf_profiler` | 2 | sonnet | audit, ship | FastAPI async blocking, O(n) hot paths |
| `mobile_auditor` | 2 | sonnet | mobile, secure | Expo app — AsyncStorage, bundle secrets |
| `cicd_auditor` | 2 | sonnet | secure, ship | GH Actions, systemd hardening |
| `docker_auditor` | 2 | sonnet | secure | n8n + Coolify container security |

### Phase 3 — Planned

| Agent | Phase | Model | Squads | Gap Closed |
|-------|-------|-------|--------|------------|
| `api_designer` | 3 | sonnet | review, plan | API consistency enforcement |
| `a11y_auditor` | 3 | sonnet | audit, ship | WCAG 2.1 AA — structured tooling |
| `incident_responder` | 3 | sonnet | tools, secure | Incident triage — always HITL |
