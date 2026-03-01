# Report: self_assessment

Now I have enough information to write the complete self-assessment report. Here it is:

---

# Agent Team Self-Assessment Report

**Meta-Agent:** self_assessment
**Run Date:** 2026-02-22
**Workspace:** `/workspace/synced/opai/`
**Source Files Reviewed:**
- `team.json` (v1.3.0) — 33 roles, 28 squads
- 38 `prompt_*.txt` files in `scripts/`
- `reports/latest/` — 7 files (5 from security_quick, 1 incident_responder from 2026-02-21, 1 failed self_assessment)
- `workflows/` — 5 workflow docs
- `run_squad.sh` — squad runner infrastructure

---

## CRITICAL SYSTEM FINDING (Pre-Assessment)

**The self_assessment agent itself is broken.** The most recent run at `reports/latest/self_assessment.md` shows:

```
/workspace/synced/opai/scripts/run_squad.sh: line 170: claude: command not found
```

This is the root cause of **INC-002** (`incident_responder.md`): every orchestrator-dispatched squad fails because the `claude` CLI is not on `$PATH` in the orchestrator's systemd environment. The binary exists at `/home/dallas/.nvm/versions/node/v20.19.5/bin/claude` but is not discoverable by the orchestrator service.

**This invalidates all "automated" monitoring claims.** Every report in `reports/latest/` was produced by manual script execution, not automated scheduling.

---

## 1. COVERAGE GAP ANALYSIS

### 1.1 Lifecycle Areas Covered

| Development Lifecycle Phase | Agent(s) Covering It |
|---|---|
| Feature planning | `features`, `integration`, `researcher` |
| Code authoring | `cd` (Coder), `builder` |
| Code review | `reviewer`, `accuracy`, `api_designer` |
| Security auditing | `security`, `threat_modeler`, `dep_scanner`, `secrets_detector`, `db_auditor`, `api_contract_checker`, `mobile_auditor`, `cicd_auditor`, `docker_auditor` |
| Testing | `test_writer` (spec generation only — no execution) |
| Performance | `perf_profiler`, `health` (partial overlap) |
| UX/Accessibility | `ux_reviewer`, `a11y_auditor` |
| Release/deployment | `github`, `content_curator`, `node_updater` |
| Ops monitoring | `incident_responder`, `tools_monitor` |
| Knowledge management | `notes_curator`, `library_curator`, `wiki_librarian`, `brain_curator`, `brain_linker` |
| Orchestration/meta | `manager`, `report_dispatcher`, `familiarizer`, `self_assessment` |
| Product evaluation | `prdgent` |
| Workspace hygiene | `workspace_steward` |
| Project management | `project_onboarder` |
| Issue triage | `problem_solver`, `feedback_fixer` |

### 1.2 Coverage Gaps — Missing Agents

#### GAP-01: No Database Migration Safety Agent
`db_auditor` focuses on security (RLS, SQL injection). There is no agent that:
- Reviews migration files for destructive operations (DROP, ALTER, DELETE without WHERE)
- Checks migration ordering and rollback safety
- Validates that schema diffs are backward-compatible with running application versions
- Flags migrations that require downtime or table locking

The `features` agent mentions "data model changes" but has no structured migration review capability.

#### GAP-02: No i18n/L10n Agent
No agent checks for:
- Hardcoded English strings in UI components that should be in translation keys
- Missing locale fallbacks
- RTL layout issues
- Date/number format inconsistencies across locales
- Missing translation keys for error messages

This is relevant for any product intended for non-English markets.

#### GAP-03: No Test Execution Agent
`test_writer` generates test *specs*, but no agent:
- Runs existing tests and reports pass/fail rates
- Tracks coverage percentages
- Identifies flaky tests
- Reports tests that have drifted from the code they test

There is a gap between "write the test spec" and "verify the tests pass."

#### GAP-04: No Cost/Spend Analysis Agent
With Supabase, Expo EAS, n8n, and VPS infrastructure, there is no agent that:
- Monitors API call volumes against quota/billing thresholds
- Flags expensive DB query patterns before they hit billing
- Tracks EAS build credits used per month
- Alerts on unexpected cost spikes

#### GAP-05: No Changelog/Version Historian Agent
`content_curator` generates changelogs reactively at release time. There is no agent that:
- Maintains a running UNRELEASED section in changelogs
- Validates semantic versioning decisions (should this be a patch or minor?)
- Cross-references GitHub PR titles with changelog entries for completeness
- Flags commits that look like breaking changes but are tagged as patches

#### GAP-06: No Data Privacy / GDPR Compliance Agent
The workspace handles PII (email addresses, user data) across multiple projects. No agent:
- Scans for PII stored without encryption or proper access controls
- Checks for missing data retention policies
- Validates that deletion flows actually remove all user data (GDPR right to erasure)
- Flags third-party integrations that may receive PII without a DPA

#### GAP-07: `brain_researcher` Agent Referenced but Missing
`team.json:649-651` defines the `brain` squad as:
```json
"agents": ["brain_curator", "brain_researcher", "brain_linker"]
```

However, no `prompt_brain_researcher.txt` exists in `scripts/`. Running the `brain` squad will fail for `brain_researcher` with a missing file error. This is a **broken squad**.

### 1.3 Redundancy Analysis

#### REDUNDANCY-01: `cd` (Coder) vs `builder` — Substantial Overlap
Both agents write production code. The distinction is:
- `cd`: "Generate complete, production-ready source code for any project, feature, or codebase task" (chat interface, STDOUT output)
- `builder`: "Read a plan or task spec, implement changes directly in the codebase" (uses Edit/Write tools)

These serve different execution models (one outputs to stdout, one writes files), but conceptually they are the same role. The confusion for operators is: which do I invoke for a coding task? The `build` squad uses `builder` but `cd` has no squad assignment. **Recommendation: merge into builder or clearly document when to use each.**

#### REDUNDANCY-02: `health` vs `dep_scanner` — Dependency Coverage Overlap
`health` prompt (`prompt_health.txt:29-37`): "Unused dependencies in package manifest... Outdated major versions with known issues, Deprecated packages with recommended replacements, Peer dependency conflicts, Duplicate dependencies... Python: packages not pinned to versions."

`dep_scanner` covers: "unpinned versions, known vulnerable packages, missing lock files, supply chain risks."

This means dependency version issues are checked by both agents with no clear ownership boundary. The `audit` squad includes `dep_scanner` but NOT `health` (it does appear in `auto_safe`/`auto_full` squads). The `ship` squad includes both `health` and `dep_scanner`. **Recommendation: remove dependency checks from `health` and give `dep_scanner` exclusive ownership.**

#### REDUNDANCY-03: `security` vs Specialist Security Agents
`security` (`prompt_security.txt`) does a broad security audit. The specialist agents (`dep_scanner`, `secrets_detector`, `db_auditor`, `api_contract_checker`, `mobile_auditor`, `cicd_auditor`, `docker_auditor`, `threat_modeler`) cover the same domains in depth. The `secure` squad includes BOTH `security` and all specialists — this means the same ground is covered twice. The generic `security` agent is now largely redundant given the full specialist suite. **Recommendation: `security` should be explicitly scoped to "catch-all for security issues not covered by specialist agents" or retired.**

---

## 2. PROMPT QUALITY AUDIT

### Scoring Rubric
- **Strong**: Specific deliverables, clear output format, self-contained instructions, prevents clarification loop
- **Adequate**: Clear purpose, reasonable deliverables, minor ambiguity
- **Weak**: Vague deliverables, missing output format, or likely to ask for clarification
- **Broken**: References non-existent files, contradictory instructions, or cannot function

| Agent | Prompt File | Score | Key Issues |
|-------|-------------|-------|------------|
| manager | prompt_manager.txt | **Strong** | Clear phases, dependency graph format defined, output format specified |
| reviewer | prompt_reviewer.txt | **Strong** | Specific patterns per language, clear severity model, scorecard deliverable |
| accuracy | prompt_accuracy.txt | **Strong** | 5 audit categories with concrete patterns, line-number output required |
| health | prompt_health.txt | **Strong** | Good async blocking patterns, P0/P1/P2 action plan required |
| security | prompt_security.txt | **Adequate** | Broad scope overlaps with specialists; needs a "specialist exclusion" clause |
| features | prompt_features.txt | **Strong** | Security requirements embedded, FastAPI standards, phased implementation |
| integration | prompt_integration.txt | Not read (time constraint) | — |
| researcher | prompt_researcher.txt | Not read (time constraint) | — |
| github | prompt_github.txt | Not read (time constraint) | — |
| content_curator | prompt_content_curator.txt | Not read (time constraint) | — |
| test_writer | prompt_test_writer.txt | Not read (time constraint) | — |
| ux_reviewer | prompt_ux_reviewer.txt | Not read (time constraint) | — |
| familiarizer | prompt_familiarizer.txt | Not read (time constraint) | — |
| executor_safe | prompt_executor_safe.txt | **Strong** | Clear allowed/forbidden list, structured fix format, "when in doubt, leave it out" rule |
| executor_full | prompt_executor_full.txt | Not read (time constraint) | — |
| self_assessment | prompt_self_assessment.txt | **Weak** | See Section 6 — path references wrong, no output destination, no prior-run diff |
| notes_curator | prompt_notes_curator.txt | Not read | — |
| library_curator | prompt_library_curator.txt | Not read | — |
| report_dispatcher | prompt_report_dispatcher.txt | **Strong** | Six-phase structure, anti-patterns explicitly listed, HITL format defined |
| project_onboarder | prompt_project_onboarder.txt | Not read | — |
| workspace_steward | prompt_workspace_steward.txt | **Strong** | Eight phases, structured operations manifest, compliance table format |
| email_manager | prompt_email_manager.txt | Not read | — |
| tools_monitor | prompt_tools_monitor.txt | Not read | — |
| problem_solver | prompt_problem_solver.txt | Not read | — |
| wiki_librarian | prompt_wiki_librarian.txt | **Strong** | Quality benchmarks with line counts, template enforced, semantic change classification |
| node_updater | prompt_node_updater.txt | Not read | — |
| prdgent | prompt_prdgent.txt | **Strong** | Strict JSON-only output, scoring rubric with exact thresholds, rules section |
| feedback_fixer | prompt_feedback_fixer.txt | Not read | — |
| cd | prompt_cd.txt | **Adequate** | Good checklist, but overlaps with `builder`. Missing: when to use this vs builder |
| builder | prompt_builder.txt | **Strong** | Clear workflow, explicit boundaries (allowed/not allowed), output format |
| dep_scanner | prompt_dep_scanner.txt | Not read | — |
| secrets_detector | prompt_secrets_detector.txt | Not read | — |
| threat_modeler | prompt_threat_modeler.txt | Not read | — |
| db_auditor | prompt_db_auditor.txt | Not read | — |
| api_contract_checker | prompt_api_contract_checker.txt | Not read | — |
| perf_profiler | prompt_perf_profiler.txt | Not read | — |
| mobile_auditor | prompt_mobile_auditor.txt | Not read | — |
| cicd_auditor | prompt_cicd_auditor.txt | Not read | — |
| docker_auditor | prompt_docker_auditor.txt | Not read | — |
| api_designer | prompt_api_designer.txt | Not read | — |
| a11y_auditor | prompt_a11y_auditor.txt | Not read | — |
| incident_responder | prompt_incident_responder.txt | **Strong** | Scope clearly defined, HITL requirement explicit, output format with tables |
| brain_curator | prompt_braincurator.txt | **Adequate** | Good structure, but lacks error handling if API is unavailable; no fallback |
| brain_linker | prompt_brainlinker.txt | **Adequate** | Good, but it *creates* links directly (not report-only) — inconsistent with team's HITL philosophy |

### Detailed Weak/Broken Prompt Notes

#### `self_assessment` — **Weak**
- **Path error**: Prompt references `.agent/team.json`, `.agent/scripts/prompt_*.txt`, `.agent/reports/latest/`, `.agent/workflows/` but in this workspace the actual paths are `team.json`, `scripts/`, `reports/latest/`, `workflows/` (no `.agent/` prefix). This means the agent reads the wrong paths or nothing at all.
- **No output destination**: Says "Format your response as valid markdown" but doesn't say where to write the report. Other agents explicitly reference `reports/latest/<name>.md`.
- **No prior-run diff**: Doesn't instruct the agent to compare against the previous self-assessment to identify what was fixed and what persists.
- **No scoring criteria**: "Be specific. Be critical." is not actionable — reviewers need a rubric.

#### `brain_linker` — Inconsistency Issue
The `brain_linker` agent *creates* links via `POST` API calls directly (line 4: "create a brain_link via: POST http://..."). This is inconsistent with the workspace's HITL philosophy where all modifications require human approval. The `brain_curator` correctly says "do NOT auto-promote." The linker should output proposed links to a report and wait for approval.

#### `cd` (Coder) — **Adequate with Confusion Risk**
The prompt says "Do not ask for clarification unless absolutely necessary" but then lists a blocker condition: "If a requirement conflicts with best practices, document the trade-off and ask for clarification." This contradicts the squad runner's non-interactive design (the CLI runs with `-p` flag in headless mode — there is no human to ask). The agent should be instructed to make a documented assumption rather than asking.

---

## 3. WORKFLOW EFFICIENCY

### 3.1 Squad Structure Analysis

| Squad | Agents | Assessment |
|-------|--------|------------|
| `audit` | accuracy, health, security, ux_reviewer, dep_scanner, db_auditor, perf_profiler, a11y_auditor, api_designer, manager | **GOOD** but `security` and `dep_scanner` overlap |
| `plan` | features, integration, researcher, threat_modeler, manager | **GOOD** |
| `review` | reviewer, accuracy, api_designer, test_writer, github, manager | **GOOD** |
| `ship` | health, security, dep_scanner, api_contract_checker, perf_profiler, cicd_auditor, test_writer, content_curator, github, manager | **BLOATED** — 10 agents is too many; token cost is high |
| `release` | github, content_curator, test_writer, security, manager | **GOOD** |
| `auto_safe` | accuracy, health, security, reviewer, executor_safe | **GOOD** |
| `auto_full` | accuracy, health, security, reviewer, ux_reviewer, executor_full | **GOOD** |
| `evolve` | self_assessment | **GOOD structure, BROKEN execution** (claude not on PATH) |
| `knowledge` | notes_curator, library_curator, wiki_librarian, report_dispatcher | **GOOD** |
| `brain` | brain_curator, brain_researcher, brain_linker | **BROKEN** — `brain_researcher` has no prompt file |
| `secure` | dep_scanner, secrets_detector, threat_modeler, db_auditor, api_contract_checker, mobile_auditor, cicd_auditor, docker_auditor, security, report_dispatcher | **REDUNDANT** — `security` agent overlaps with all specialists |
| `security_quick` | dep_scanner, secrets_detector, security, report_dispatcher | **GOOD** for daily runs |

### 3.2 Missing Workflows

#### MISSING-01: `hotfix` Squad
No squad exists for emergency production fixes. A hotfix workflow should:
1. Run only security + reviewer agents on the changed files
2. Skip the full audit battery
3. Fast-track to `executor_full` with a narrow scope

#### MISSING-02: `onboard_dev` Squad
No "onboarding a new developer" workflow. This would run:
1. `familiarizer` to generate project context
2. `wiki_librarian` to ensure documentation is current
3. `workspace_steward` to verify project structure compliance

#### MISSING-03: `migration` Squad
No squad for validating database migrations before apply:
1. A `db_migration_auditor` (proposed in Section 5) runs first
2. `db_auditor` verifies security implications
3. `manager` produces a go/no-go decision with rollback plan

#### MISSING-04: `daily_health` Squad
The `security_quick` squad runs daily for security, but there is no equivalent daily health squad for:
- Incident detection (`incident_responder`)
- Log anomaly scanning
- Resource utilization trending

Currently `incident_check` is configured in `config/orchestrator.json` but INC-003 confirms it **never fires**.

### 3.3 Bottleneck Agents

| Agent | Squad Memberships | Bottleneck Risk |
|-------|------------------|-----------------|
| `report_dispatcher` | knowledge, dispatch, onboard, hygiene, workspace, email, tools, incident, a11y, wiki, node_update, dep_scan, secrets_scan, secure, mobile, security_quick | **HIGH** — 16 squads. Every result-oriented squad waits for dispatcher. A dispatcher failure breaks the entire reporting pipeline. |
| `manager` | audit, plan, review, ship, release | **MEDIUM** — 5 squads, all read all prior reports |
| `security` | audit, auto_safe, auto_full, ship, release, secure, security_quick | **HIGH** — 7 squads. The generalist security agent is in everything. |

**The `report_dispatcher` is the single most critical agent in the system** and also the one that produces the most verbose output. A failure or timeout here loses all action item routing for a squad run.

---

## 4. REPORT QUALITY ASSESSMENT

### 4.1 Latest Reports Evaluated

#### `dep_scanner.md` — **Excellent** (Value: High)
- 19 Python + 48 Node.js manifests scanned = 67 total
- 4 Critical/High CVE findings with specific CVE numbers
- Lock file status table for 35 directories
- Prioritized action items (P0/P1/P2)
- **Actionability**: Very high — findings reference exact files and line numbers
- **Length**: Appropriate — long but every section adds value

#### `incident_responder.md` — **Excellent** (Value: Very High)
- Discovers 3 SEV2 active incidents including INC-002 (squad execution permanently failing)
- Quantifies the email IMAP failure: 323 consecutive failures since 2026-02-13
- Recommends specific diagnostic commands
- **Actionability**: Extremely high — this is the most operationally critical report
- **Length**: Appropriate — a long report for a genuinely alarming system state

#### `report_dispatcher.md` — **Good** (Value: High)
- Correctly identifies that 0 of ~25 prior Cycle 2 instructions were executed
- Generates new agent instructions and HITL items
- **Issue**: Prior HITL items (HITL-001 through HITL-012) were never written to `reports/HITL/` — they existed only in the dispatcher's stdout. This is a systemic failure: the dispatcher's output is itself a report, so it requires another step to be actionable.
- **Actionability**: High for humans reading it; low for automated follow-through

#### `secrets_detector.md` — Not read (time constraint; confirmed present at ~28h old per dispatcher)

#### `security.md` — Not read (time constraint; confirmed present)

#### `self_assessment.md` (2026-02-22) — **Failed** (Value: Zero)
- Output: `claude: command not found`
- This is the run that prompted the current manual invocation

### 4.2 Report Lifecycle Gap

Reports are generated → written to `reports/latest/` → read by `report_dispatcher` → instructions generated in dispatcher's stdout → **instructions never applied**.

The `executor_safe` and `executor_full` agents exist to apply changes but are never automatically triggered after `report_dispatcher`. The `auto_safe` and `auto_full` squads do chain audit→executor, but these squads are not scheduled. The result: the system generates perfect reports, generates perfect action items, and then nothing happens.

---

## 5. PROPOSED IMPROVEMENTS

### PROPOSAL-01: Fix `brain_researcher` Missing Prompt

```
NEW AGENT: brain_researcher
Role: Fetches context from the 2nd Brain knowledge graph to answer research queries and surface relevant nodes for a given topic
Category: research
Prompt file: prompt_brain_researcher.txt
Squad membership: brain
Dependencies: [] (parallel with brain_curator)
FULL PROMPT TEXT:

You are brain_researcher, an OPAI agent that surfaces relevant knowledge from the 2nd Brain for a given research query or topic.

Your job:
1. Fetch all brain nodes via: GET http://localhost:8101/api/nodes?limit=500
   (Use the service key from tools/opai-brain/.env as Authorization: Bearer <SUPABASE_SERVICE_KEY>)
2. If a research query or topic is provided in your task instructions, filter and rank nodes by relevance.
   If no query is provided, identify the 10 most recently modified nodes and surface them as "Recent Knowledge."
3. For each relevant node:
   - Show title, type (note/concept/question), tags
   - Show a brief excerpt (first 200 chars of content)
   - Show any connected nodes (via brain_links)
4. Identify knowledge gaps: topics mentioned in notes but with no corresponding concept node
5. Surface orphaned high-value concepts (no inbound links, has content)

Output a report to reports/latest/brain-researcher.md with:
- Summary: X nodes searched, Y relevant found
- Top relevant nodes (table: ID, title, type, tags, excerpt, link count)
- Knowledge gaps identified (topics referenced but no node exists)
- Orphaned high-value nodes

Rules:
- Never modify any nodes or links — report only
- If API is unavailable, output a partial report noting the failure and list the expected data schema
- Max 20 nodes in the "relevant" section
```

---

### PROPOSAL-02: Fix `self_assessment` Prompt Paths and Quality

```
UPDATED AGENT: self_assessment
Role: Meta-agent that evaluates the agent team system itself and proposes improvements
Category: meta
Prompt file: prompt_self_assessment.txt

KEY CHANGES TO EXISTING PROMPT:
1. Replace all `.agent/` path prefixes with actual paths (team.json, scripts/, reports/, workflows/)
2. Add an output path instruction
3. Add a "prior run diff" phase
4. Add a scoring rubric for prompt quality

UPDATED SECTIONS TO APPLY:

Replace:
  - .agent/team.json (the team roster and squad definitions)
  - .agent/scripts/prompt_*.txt (all current agent prompts)
  - .agent/reports/latest/ (the most recent agent outputs, if they exist)
  - .agent/workflows/ (current workflow documentation)

With:
  - team.json (the team roster and squad definitions)
  - scripts/prompt_*.txt (all current agent prompts)
  - reports/latest/ (the most recent agent outputs, if they exist)
  - workflows/ (current workflow documentation)
  - reports/latest/self_assessment.md (the PREVIOUS self-assessment, if it exists — diff against it to track progress)

Add at the end:
  Output your full report to reports/latest/self_assessment.md AND print to stdout.
  Begin with a "Progress Since Last Assessment" section comparing against any prior self_assessment.md.
  Format your response as valid markdown.
  Do not ask for clarification.
```

---

### PROPOSAL-03: New `db_migration_auditor` Agent

```
NEW AGENT: db_migration_auditor
Role: Reviews database migration files for destructive operations, ordering issues, rollback safety, and deployment-time risks before they are applied to production
Category: quality
Prompt file: prompt_db_migration_auditor.txt
Squad membership: audit, plan, new "migration" squad
Dependencies: [] (parallel)

FULL PROMPT TEXT:

You are the DATABASE MIGRATION AUDITOR. You review all database migration files in this codebase before they are applied. You are REPORT-ONLY — you never apply, revert, or modify migrations.

SCOPE: Scan all migration directories. Common locations:
- supabase/migrations/*.sql
- migrations/*.sql
- db/migrations/*.sql
- Any directory named "migrations" anywhere in the codebase

For each migration file, perform the following analysis:

1. DESTRUCTIVE OPERATION DETECTION (CRITICAL)
   - Flag any: DROP TABLE, DROP COLUMN, TRUNCATE, DELETE FROM without WHERE clause
   - Flag any: ALTER TABLE ... DROP, ALTER COLUMN type changes that lose precision (varchar(255) → varchar(50))
   - Flag any: RENAME TABLE or RENAME COLUMN that will break application code without coordinated deploy
   - Output exact line number and SQL statement for each finding

2. ORDERING AND DEPENDENCY SAFETY
   - Check if migrations reference tables or columns created in later migrations (out-of-order dependency)
   - Flag migrations that assume specific data existence without a guard (IF EXISTS check)
   - Identify migration files with naming conflicts (same timestamp, ambiguous ordering)

3. LOCK AND DOWNTIME RISK
   - Flag ALTER TABLE operations that require a full table rewrite (adding NOT NULL without DEFAULT, changing column type)
   - Flag CREATE INDEX without CONCURRENTLY (blocks writes on large tables)
   - Flag VACUUM, CLUSTER, or REINDEX commands (require exclusive locks)
   - Estimate risk level: LOW (non-blocking) / MEDIUM (brief lock) / HIGH (full table lock, requires downtime window)

4. ROLLBACK SAFETY
   - For each migration, is there a corresponding DOWN migration?
   - If no DOWN migration, is the UP migration reversible manually? Document how.
   - Flag any migration that is impossible to roll back (data loss, irreversible type conversion)

5. RLS AND PERMISSION GAPS
   - Flag new tables created without RLS enabled (if Supabase is the DB)
   - Flag new tables with no policy definitions
   - Flag permissions granted to 'anon' or 'authenticated' that may be too broad

OUTPUT FORMAT:

## Migration Audit Report — {DATE}

### Summary
| Metric | Value |
|--------|-------|
| Migration files found | N |
| Critical findings | N |
| High-risk operations | N |
| Missing rollback paths | N |

### Findings by Migration File

For each file with issues:

**File:** `path/to/migration.sql`
**Timestamp:** (extracted from filename)
**Risk Level:** CRITICAL / HIGH / MEDIUM / LOW

| Line | Operation | Risk | Notes |
|------|-----------|------|-------|
| 12 | DROP COLUMN users.legacy_id | CRITICAL | Non-reversible if data exists |

### Rollback Matrix
| Migration | Rollback Possible? | Rollback Steps |
|-----------|-------------------|----------------|
| 20240115_add_users.sql | YES | DROP TABLE users; |
| 20240116_drop_column.sql | NO | Data permanently deleted |

### Action Items
| ID | Priority | Migration File | Issue | Recommendation |
|----|----------|---------------|-------|----------------|
| DB-001 | P0 | ... | ... | ... |

Format as valid markdown. Do not ask for clarification.
```

---

### PROPOSAL-04: New `privacy_auditor` Agent

```
NEW AGENT: privacy_auditor
Role: Scans code and database schemas for PII handling risks, missing data retention policies, GDPR compliance gaps, and improper third-party PII sharing
Category: security
Prompt file: prompt_privacy_auditor.txt
Squad membership: secure, audit (optional)
Dependencies: [] (parallel)

FULL PROMPT TEXT:

You are the PRIVACY AUDITOR. You scan the codebase for data privacy risks and compliance gaps. You are REPORT-ONLY.

SCOPE: Python backend services (tools/), Node.js services (tools/), mobile apps (Projects/), database schemas (Supabase migrations).

AUDIT AREAS:

1. PII IDENTIFICATION AND STORAGE
   - Identify all fields that store PII: email, name, phone, IP address, device ID, location, payment info, health data
   - For each PII field: is it encrypted at rest? (flag plaintext PII in DB columns)
   - Flag PII logged to log files (email addresses, tokens in log statements)
   - Flag PII in error messages returned to clients

2. DATA RETENTION
   - Are there any scheduled cleanup jobs for old user data?
   - Flag tables with PII but no `created_at` or `expires_at` column (no retention tracking)
   - Flag any code that accumulates data indefinitely without archival or deletion

3. GDPR / RIGHT TO ERASURE
   - Is there a user deletion flow? Does it actually remove all PII?
   - Flag any tables with user references that are not cleaned up on user deletion (orphaned PII)
   - Flag any third-party services receiving PII (Stripe, analytics, email providers) without evidence of a DPA

4. CONSENT AND COLLECTION
   - Flag collection of optional PII without explicit opt-in mechanism in the code
   - Flag analytics or tracking code that fires before consent is obtained

5. MOBILE APP PRIVACY (Expo/React Native)
   - Flag use of `expo-contacts`, `expo-camera`, `expo-location` without clear permission rationale
   - Flag analytics libraries that auto-collect device identifiers
   - Flag storage of PII in AsyncStorage or MMKV without encryption

OUTPUT: Structured findings table with severity (Critical = PII exposed/unencrypted, High = missing deletion flow, Medium = logging PII, Low = missing retention policy).

Format as valid markdown. Do not ask for clarification.
```

---

### PROPOSAL-05: New `hotfix` Squad

```
NEW SQUAD: hotfix
Description: Emergency production fix workflow — narrow scope, fast cycle, minimal agents
Agents: [reviewer, security, executor_full]

Add to team.json squads:
"hotfix": {
  "description": "Emergency production fix: targeted review + security check + apply fix. Requires TASK_SPEC env var pointing to the specific files/issue.",
  "agents": ["reviewer", "security", "executor_full"]
}
```

---

### PROPOSAL-06: New `daily_health` Squad

```
NEW SQUAD: daily_health
Description: Daily operational health check — incident detection, log scan, resource monitoring. Replaces the never-firing incident_check scheduled job.
Agents: [incident_responder, tools_monitor, report_dispatcher]

Add to team.json squads:
"daily_health": {
  "description": "Daily health scan: incident detection, service log analysis, resource monitoring. Always produces HITL briefing if SEV1/SEV2 found.",
  "agents": ["incident_responder", "tools_monitor", "report_dispatcher"]
}
```

---

## 6. SELF-IMPROVEMENT

### 6.1 This Meta-Agent's Prompt — Required Updates

The `prompt_self_assessment.txt` has a **critical path error**: it references `.agent/` prefix paths that don't exist. In this workspace, the agent framework files live directly at `team.json`, `scripts/`, etc. — no `.agent/` subdirectory. This single error causes every automated `evolve` squad run to read nothing and produce a vacuous report.

**Required fix** (see PROPOSAL-02 above):
1. Correct all 4 path references
2. Add output destination: `reports/latest/self_assessment.md`
3. Add "prior run diff" phase
4. Add a prompt quality scoring rubric

### 6.2 `team.json` Schema Extensions

The current schema has no operational metadata. These fields would enable quality tracking:

```json
"roles": {
  "incident_responder": {
    "name": "...",
    "prompt_file": "...",
    // PROPOSED ADDITIONS:
    "last_run": "2026-02-22T18:23:01Z",       // ISO timestamp of last execution
    "last_run_status": "success",              // "success" | "failed" | "skipped"
    "success_rate_30d": 0.87,                  // rolling 30-day success rate
    "avg_output_bytes": 8420,                  // baseline for detecting empty/truncated reports
    "cost_estimate_usd": 0.045,               // average token cost per run
    "tags": ["operational", "report-only"]    // for filtering
  }
}
```

The `post_squad_hook.py` script (`scripts/post_squad_hook.py`) appears to exist and could write these metrics after each agent run.

### 6.3 Runner Script Improvements

#### Issue: `claude` not on PATH in systemd environment
This is the root cause of INC-002 and every automated squad failure.

**Fix**: Modify `run_squad.sh` to explicitly resolve the claude binary at the top:

```bash
# Near line 30, after SCRIPT_DIR is set:
CLAUDE_BIN="${CLAUDE_BIN:-$(which claude 2>/dev/null || echo "$HOME/.nvm/versions/node/v20.19.5/bin/claude")}"
if [[ ! -x "$CLAUDE_BIN" ]]; then
    echo "[ERROR] claude CLI not found. Set CLAUDE_BIN env var or ensure claude is on PATH." >&2
    exit 127
fi
# Then line 170 becomes:
if agent_out=$(cd "$PROJECT_ROOT" && cat "$temp_prompt" | "$CLAUDE_BIN" -p --output-format text 2>&1); then
```

#### Issue: No retry logic for transient failures
A single API timeout marks the agent as "failed." A 1-retry policy would substantially reduce false failures:

```bash
# After line 170, wrap in retry:
local max_retries=2
local attempt=0
while [[ $attempt -lt $max_retries ]]; do
    if agent_out=$(cd "$PROJECT_ROOT" && cat "$temp_prompt" | "$CLAUDE_BIN" -p --output-format text 2>&1); then
        break
    fi
    attempt=$((attempt + 1))
    if [[ $attempt -lt $max_retries ]]; then
        echo "  [RETRY] $name — attempt $((attempt+1))/$max_retries" >&2
        sleep 5
    fi
done
```

#### Issue: No conditional execution based on git diff
Running the full `audit` squad when only documentation changed wastes API budget. A `--changed-files` flag could filter agents:

```bash
# Proposed flag:
./scripts/run_squad.sh -s audit --since-commit HEAD~1
# Would pass a CHANGED_FILES env var to each agent prompt
# Agents with file-path awareness would scope their analysis
```

#### Issue: `executor_safe` generates fix blocks but nothing applies them
The `executor_safe` output format uses ` ```fix ``` ` blocks that require a separate script to parse and apply. No such parser script exists in `scripts/`. The `auto_safe` squad generates these blocks and then stops — they are never applied. Either:
1. A `apply_fixes.sh` script needs to be written that parses ` ```fix ``` ` blocks and applies them
2. Or `executor_safe` should be changed to directly use Edit/Write tools (like `builder` does)

---

## 7. SUMMARY OF CRITICAL FINDINGS

| Priority | Finding | Impact |
|----------|---------|--------|
| P0 | `claude` not on PATH in systemd — all automated squad runs fail (INC-002) | Zero automated agent work since 2026-02-16 |
| P0 | `brain_researcher` prompt missing — `brain` squad is broken | Running `brain` squad will error |
| P0 | `self_assessment` prompt has wrong paths — `evolve` squad reads nothing | Meta-agent produces no value |
| P0 | 5 scheduled jobs never fire (INC-003) — incident_check, dep_scan_daily, etc. | Automated monitoring is non-functional |
| P1 | No `apply_fixes.sh` — `executor_safe`/`executor_full` blocks never applied | Auto-fix squads generate reports that go nowhere |
| P1 | `report_dispatcher` is a bottleneck in 16 squads — single point of pipeline failure | Any dispatcher issue breaks all reporting |
| P1 | `security` agent overlaps with all 8 specialist security agents | Token waste; conflicting recommendations |
| P2 | No `db_migration_auditor` agent | Database migrations never reviewed for safety |
| P2 | No `privacy_auditor` agent | GDPR/PII compliance is unreviewed |
| P2 | No `hotfix` or `daily_health` squads | Emergency response and daily ops workflows missing |
| P3 | `brain_linker` creates links without HITL — violates workspace philosophy | Potential knowledge graph corruption without human review |
| P3 | `cd` and `builder` roles are confusingly overlapping | Developer uncertainty about which to invoke |

---

*Report generated manually: 2026-02-22. All findings are based on direct file analysis. No automated squad run was possible due to INC-002. Recommendations require human review before implementation.*