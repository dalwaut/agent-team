---
title: Agentic File System Management
type: system-evaluation
version: 1.0.0
date: 2026-02-09
status: active
tags: [system-design, file-management, agent-framework, evolution]
---

# Agentic File System Management

> Strategic evaluation and evolution roadmap for the OPAI workspace file system, its agent coverage, and the gaps between intent and reality.

---

## 1. Current State Assessment

### 1.1 System Identity

OPAI is a **dual-purpose workspace** — it is simultaneously:

1. The **Agent Team framework source** (v1.2.0) — 18 agents, 10 squads, PowerShell orchestration
2. An **Obsidian vault** — 30+ projects, client work, research, n8n workflows, personal notes

This duality creates tension. Framework conventions (diamond workflow, report-only agents, timestamped reports) coexist with organic project growth (codebases with their own structures, ad-hoc notes, pasted screenshots).

### 1.2 Health Score: 6/10

| Dimension | Score | Assessment |
|-----------|-------|------------|
| Agent Framework | 9/10 | Well-architected. 18 roles, 10 squads, clean execution model |
| Knowledge Management | 7/10 | Notes Curator + Library Curator designed. Library dirs empty but ready |
| Project Structure | 4/10 | Only 3 of 30+ projects follow diamond workflow |
| Naming Conventions | 3/10 | No enforced standard. Mixed spaces, kebab, camelCase, SCREAMING_SNAKE |
| File Hygiene | 5/10 | Root-level screenshots, orphan `nul` file, empty project folders, duplicates |
| Documentation | 7/10 | CLAUDE.md and gemini-scribe/AGENTS.md are strong. Gaps in conventions |
| Automation | 4/10 | Agents designed but never executed. reports/ empty. No INDEX.md yet |
| Templates | 3/10 | Template dirs exist but are largely empty. Typo in folder name |

---

## 2. Structural Findings

### 2.1 Project Structure Compliance

The diamond workflow defines 7 standard subfolders per project:

```
Research/ -> Dev-Plan/ -> Agent-Tasks/ -> Codebase/ -> Notes/ -> Review-log/ -> Debug-log/
```

**Reality across 30+ projects:**

| Category | Count | Diamond? | Actual Structure |
|----------|-------|----------|-----------------|
| Framework examples | 3 | Yes | SEO-GEO-Automator, Example-Python, n8n-export-to-import |
| Web/mobile apps | 9 | No | Native codebase: `src/`, `docs/`, `node_modules/`, `supabase/` |
| Documentation-only | 3 | No | Loose markdown files, no subfolders |
| Client projects | 2 | No | Flat files, no organizational structure |
| Empty/abandoned | 3 | No | WE Sticker, WE WebApps, image-optimizer |

> [!warning] 91% Non-Compliance
> The diamond workflow is the documented standard but only 3 projects implement it. The remaining projects grew organically with their own structures.

### 2.2 Naming Chaos

| Location | Pattern Found | Example |
|----------|--------------|---------|
| Project folders | PascalCase + spaces | `WE Code`, `Lace & Pearl`, `BB Drive` |
| Project folders | Hyphenated | `Bouta-Core`, `SEO-GEO-Automator` |
| Project folders | Ampersand | `Lace&Pearl` (Clients/) vs `Lace & Pearl` (Projects/) |
| Notes files | Kebab-case | `expo-build-commands.md` (post-cleanup) |
| Notes files | Spaces + dates | `General note 1-6-26.md` (pre-cleanup) |
| n8n workflows | HexID-underscore | `05v5fA1PpspT3IYF-Email_Article_Extraction...` |
| Agent prompts | snake_case | `prompt_notes_curator.txt` |
| Scripts | snake_case | `run_squad.ps1` |
| Research folders | Mixed | `GEO_Optimization`, `Hostinger Migration`, `Lead Generation` |
| Root screenshots | Auto-generated | `Pasted image 20260115124651.png` |

### 2.3 Orphaned & Misplaced Content

| Item | Location | Problem |
|------|----------|---------|
| `nul` (51 bytes) | Root | PowerShell pipe remnant. Corrupted file |
| 3x `Pasted image *.png` | Root | Auto-pasted screenshots with no semantic name |
| `QUICK_REFERENCE (1).txt` | Cursor/ | Duplicate of `QUICK_REFERENCE.txt` |
| `setup.ps1` | Root | Should be in `scripts/` with other runners |
| `Notes.md` | Root | Overlaps with CLAUDE.md purpose |
| Empty projects | Obsidian/Projects/ | WE Sticker, WE WebApps, image-optimizer |

### 2.4 Agent Coverage Map

```
                     FILE SYSTEM AREAS
                     =================

  notes/          Library/        Obsidian/       Clients/
  [NC] covered    [LC] covered    [ ] NO AGENT    [ ] NO AGENT

  Research/       tasks/          reports/        Templates/
  [ ] NO AGENT    [ ] NO AGENT    [ ] NO AGENT    [ ] NO AGENT

  Root files      Naming          Archival        Cross-project
  [ ] NO AGENT    [ ] NO AGENT    [ ] NO AGENT    [ ] NO AGENT

  NC = Notes Curator    LC = Library Curator
```

> [!important] Coverage Gap
> Only 2 of 12 file system areas have dedicated agent coverage. The remaining 10 areas operate without automated oversight.

---

## 3. Evolution Roadmap

### 3.1 Tier 1 — Immediate Fixes (No New Agents)

These are structural corrections that should happen now:

#### 3.1.1 File Hygiene Cleanup

| Action | Target | Reason |
|--------|--------|--------|
| Delete | `nul` at root | PowerShell pipe artifact, 51 bytes of nothing |
| Move | 3x `Pasted image *.png` at root to `notes/Archive/` or delete | Clutter with no semantic name |
| Delete | `Cursor/QUICK_REFERENCE (1).txt` | Exact duplicate |
| Rename | `Templates/templates-projects/wprdpress_plugin_structure/` | Typo: `wprdpress` -> `wordpress` |
| Archive | Empty projects: WE Sticker, WE WebApps, image-optimizer | Move to `Obsidian/Projects/_archived/` |

#### 3.1.2 Naming Standard

Establish one convention and document it in CLAUDE.md:

```
OPAI NAMING CONVENTION
======================
Folders:   PascalCase or Kebab-Case  (e.g., DevPlan/ or Dev-Plan/)
Files:     kebab-case.md             (e.g., expo-build-commands.md)
Agents:    snake_case                (e.g., prompt_notes_curator.txt)
Scripts:   snake_case.ps1            (e.g., run_squad.ps1)
Projects:  PascalCase                (e.g., BoutaCare, SEOGeoAutomator)
Clients:   PascalCase                (e.g., LacePearl, Westberg)

NEVER: Spaces in folder/file names (breaks paths, wikilinks, CLI)
NEVER: Special characters (&, !, #) in names
ALWAYS: .md extension for documentation
ALWAYS: .txt extension for agent prompts
```

#### 3.1.3 Update CLAUDE.md Counts

The Agents table says "16 Roles" and Squads says "9 Groups" — now 18 roles and 10 squads. The scripts/ description says "16 agent prompt files" — now 18. Update to match reality.

---

### 3.2 Tier 2 — Two-Tier Project Model

> [!note] The Core Insight
> The diamond workflow is excellent for **agent-driven planning projects**. But it doesn't fit **active codebases** that have their own structure (`src/`, `node_modules/`, `supabase/`). Forcing diamond onto these projects creates friction and gets ignored.

**Proposal: Two-tier project model**

#### Tier A — Agent-Managed Projects (Diamond)

For projects where agents drive the workflow. The full diamond structure applies:

```
Obsidian/Projects/<ProjectName>/
  Research/          # Sources, findings, competitor analysis
  Dev-Plan/          # Architecture decisions, implementation plans
  Agent-Tasks/       # YAML task definitions for agents
  Codebase/          # Actual source code (or link to external repo)
  Notes/             # Project-specific notes
  Review-log/        # Agent review entries
  Debug-log/         # Debug traces and error analysis
  PROJECT.md         # Project metadata (YAML frontmatter + summary)
```

#### Tier B — Codebase Projects (Native + Metadata)

For projects with their own build systems. Keep native structure, add a thin metadata layer:

```
Obsidian/Projects/<ProjectName>/
  src/               # (native)
  docs/              # (native - maps to Dev-Plan + Notes)
  supabase/          # (native)
  node_modules/      # (native)
  PROJECT.md         # REQUIRED: Project metadata + agent instructions
  CHANGELOG.md       # Optional: version history
```

**PROJECT.md** serves as the bridge — it tells agents what the project is, what tech it uses, and where to find things within the native structure. The `familiarizer` agent already generates something similar (`project_context.md`).

#### Tier C — Client Projects

Clients need their own standard too:

```
Clients/<ClientName>/
  PROJECT.md         # Client info, contacts, project scope
  Notes/             # Meeting notes, correspondence
  Deliverables/      # Final outputs sent to client
  Assets/            # Logos, brand guides, provided materials
```

---

### 3.3 Tier 3 — New Agent: Workspace Steward

The biggest gap is that **no agent oversees the workspace as a whole**. Notes Curator handles `notes/`. Library Curator handles `Library/`. But nothing watches the full tree.

#### Workspace Steward Agent

```
Role:       workspace_steward
Category:   operations
Run Order:  parallel
Emoji:      WS
Squad:      hygiene (new)
```

**Responsibilities:**

1. **Structure Compliance** — Scan every project in `Obsidian/Projects/` and `Clients/`. Report which tier (A/B/C) each project is, whether it has `PROJECT.md`, and what's missing from its expected structure.

2. **File Hygiene** — Detect:
   - Root-level orphans (files that don't belong at workspace root)
   - Empty directories older than 30 days
   - Duplicate files (same name, similar size across locations)
   - Files with spaces or special characters in names
   - Auto-generated filenames (`Pasted image`, `Untitled`, `New-for-review`)
   - Oversized files that shouldn't be in an Obsidian vault (`.zip`, `node_modules/`)

3. **Cross-Reference Integrity** — Check:
   - Obsidian wikilinks that point to non-existent files
   - Client folders that have no corresponding project mirror
   - Project names that differ between locations (e.g., `Lace&Pearl` vs `Lace & Pearl`)

4. **Freshness Audit** — Flag:
   - Projects with no changes in 90+ days (candidate for archive)
   - `tasks/` items older than 30 days (stale)
   - `reports/` older than 60 days (candidate for cleanup)

> [!tip] Steward + Curators = Full Coverage
> The Workspace Steward handles the tree structure. The Notes Curator handles `notes/` content. The Library Curator handles `Library/` knowledge. Together they cover the full workspace.

---

### 3.4 Tier 4 — Expanded Squads

#### Current Squad Gaps

| Need | Current Coverage | Proposed |
|------|-----------------|----------|
| Knowledge management | `knowledge` squad (notes + library) | Keep as-is |
| File hygiene | None | New `hygiene` squad |
| Project onboarding | `familiarize` (one agent) | Expand to include steward |
| Full workspace audit | None | New `workspace` squad |

#### Proposed New Squads

**`hygiene` squad** — Run periodically to keep the workspace clean:
```json
{
  "hygiene": {
    "description": "Workspace hygiene: file cleanup, naming, structure compliance",
    "agents": ["workspace_steward"]
  }
}
```

**`workspace` squad** — Full workspace evaluation (knowledge + hygiene combined):
```json
{
  "workspace": {
    "description": "Complete workspace audit: notes, library, structure, hygiene",
    "agents": ["notes_curator", "library_curator", "workspace_steward"]
  }
}
```

This gives operators a choice:
- `.\scripts\run_squad.ps1 -Squad "knowledge"` — just notes + library
- `.\scripts\run_squad.ps1 -Squad "hygiene"` — just structure + cleanup
- `.\scripts\run_squad.ps1 -Squad "workspace"` — everything

---

### 3.5 Tier 5 — Library as the Knowledge Engine

The Library is currently 100+ n8n workflow JSONs and 4 empty directories. It should become the **searchable knowledge engine** that prevents re-research.

#### Proposed Library Structure

```
Library/
  INDEX.md                    # Generated by library_curator
  n8n/
    Workflows/                # 100+ workflow JSONs (existing)
    Patterns/                 # n8n-specific patterns (error handling, loops)
  Patterns/
    Supabase-RLS.md           # Row-level security patterns
    Expo-Navigation.md        # Navigation stack patterns
    Stripe-Webhooks.md        # Payment webhook handling
    Auth-Flows.md             # Authentication implementation patterns
  Solutions/
    Expo-Build-Errors.md      # Build issues and fixes
    Supabase-Migration.md     # Database migration gotchas
    n8n-Rate-Limiting.md      # Rate limit handling in workflows
  References/
    CLI-Cheatsheet.md         # Combined CLI reference (expo, n8n, supabase, git)
    API-Patterns.md           # REST/GraphQL patterns used across projects
    Config-Templates.md       # Standard config files (tsconfig, eslint, etc.)
  Stack/
    Supabase/                 # Auth, RLS, Edge Functions, Migrations
    Expo/                     # Build, Navigation, Native Modules
    Stripe/                   # Payments, Subscriptions, Webhooks
    WordPress/                # Avada, Plugins, REST API
    n8n/                      # Nodes, Error Handling, Webhook Design
    Hostinger/                # Deployment, DNS, Server Management
    PowerShell/               # Script Patterns, Agent Framework Internals
```

#### How Content Flows Into Library

```
Problem Solved in Project
         |
         v
  Notes/ in project (immediate capture)
         |
         v
  notes_curator COPIES to notes/ (source of truth)
         |
         v
  library_curator PROMOTES to Library/ (reusable knowledge)
         |
         v
  INDEX.md updated (searchable)
```

The key insight: **every solved problem should end up in Library/** within one squad run. The Notes Curator identifies project-relevant content. The Library Curator decides what's reusable.

---

### 3.6 Tier 6 — Convention Enforcement via Agents

Rather than documenting conventions and hoping they're followed, agents should **detect violations** in their reports.

#### Convention Rules for Agents

Add a `CONVENTIONS.md` file at workspace root that all agents read:

```markdown
# OPAI Conventions

## File Naming
- Files: kebab-case.md (lowercase, hyphens, .md extension)
- Folders: PascalCase or kebab-case (no spaces, no special characters)
- Agent prompts: prompt_<name>.txt (snake_case)
- Scripts: <name>.ps1 (snake_case)

## Project Structure
- Every project MUST have PROJECT.md at its root
- Tier A projects: full diamond (Research/ Dev-Plan/ Agent-Tasks/ etc.)
- Tier B projects: native structure + PROJECT.md
- Client projects: PROJECT.md + Notes/ + Deliverables/

## Knowledge Flow
- notes/ is source of truth for personal reference
- Library/ is source of truth for reusable knowledge
- Projects get COPIES, never originals
- Research/ findings get PROMOTED to Library/ when mature

## Security
- Credentials ONLY in notes/Access/ (nowhere else)
- No .env files committed
- No API keys in code or notes outside Access/

## Archival
- Empty projects older than 90 days: move to _archived/
- Stale tasks older than 30 days: flag for review
- Completed research: promote to Library/, archive original
```

Every agent that touches files should read `CONVENTIONS.md` and flag violations in their reports.

---

## 4. Implementation Priority

| Priority | Action | Effort | Impact |
|----------|--------|--------|--------|
| P0 | Clean root orphans (nul, pasted images, duplicate) | 5 min | Immediate hygiene |
| P0 | Fix CLAUDE.md counts (18 agents, 10 squads) | 5 min | Accuracy |
| P0 | Fix template typo (wprdpress -> wordpress) | 1 min | Correctness |
| P1 | Create `CONVENTIONS.md` at root | 30 min | Foundation for all agents |
| P1 | Create Workspace Steward agent + hygiene squad | 1 hr | Covers the structural gap |
| P1 | Run `knowledge` squad for first time | 10 min | Populate Library/INDEX.md |
| P2 | Adopt two-tier project model | 2 hr | Resolves diamond vs native tension |
| P2 | Create `PROJECT.md` template | 30 min | Standardizes project metadata |
| P2 | Normalize project/client folder names (remove spaces/ampersands) | 1 hr | Prevents reference breaks |
| P3 | Populate Library/ with initial content from existing projects | Ongoing | Knowledge engine bootstrap |
| P3 | Archive empty/abandoned projects | 15 min | Reduce clutter |
| P3 | Expand `workspace` squad (all 3 curators together) | 15 min | Full coverage audit |

---

## 5. Target State

After implementing the evolution roadmap, the OPAI workspace reaches:

```
OPAI (Master Workspace)
  |
  |-- CLAUDE.md              # System instructions for Claude Code
  |-- CONVENTIONS.md         # Naming, structure, and knowledge flow rules
  |-- team.json              # 19+ agents, 12+ squads
  |
  |-- scripts/               # Agent prompts + PowerShell runners
  |-- workflows/             # Framework documentation + this file
  |-- Templates/             # Project scaffolding + agent templates
  |
  |-- Obsidian/Projects/     # 30+ projects (Tier A or Tier B)
  |   |-- <each>/PROJECT.md  # Standardized metadata
  |
  |-- Clients/               # Client projects (Tier C)
  |   |-- <each>/PROJECT.md  # Client metadata + scope
  |
  |-- notes/                 # Personal reference (source of truth)
  |   |-- Access/            # Credentials (secured)
  |   |-- Archive/           # Superseded content
  |   |-- Review/            # Inbox for new notes
  |   `-- (references)       # Dev commands, CLI guides
  |
  |-- Library/               # Reusable knowledge engine
  |   |-- INDEX.md           # Auto-generated searchable index
  |   |-- n8n/Workflows/     # 100+ workflow templates
  |   |-- Patterns/          # Proven architecture patterns
  |   |-- Solutions/         # Solved problems with context
  |   |-- References/        # API docs, CLI cheatsheets
  |   `-- Stack/<tech>/      # Per-technology knowledge
  |
  |-- Research/              # Active research (promotes to Library/)
  |-- reports/               # Agent reports (timestamped)
  |-- tasks/                 # Global task queues
  `-- logs/                  # System-wide logs
```

### Agent Coverage at Target State

```
  notes/          Library/        Obsidian/       Clients/
  [NC] covered    [LC] covered    [WS] covered    [WS] covered

  Research/       tasks/          reports/        Templates/
  [LC] covered    [WS] covered    [WS] covered    [WS] covered

  Root files      Naming          Archival        Cross-project
  [WS] covered    [WS] covered    [WS] covered    [WS] covered

  NC = Notes Curator
  LC = Library Curator
  WS = Workspace Steward
```

**Coverage: 12/12 areas** (up from 2/12 today).

### Health Score Projection

| Dimension | Current | Target | Driver |
|-----------|---------|--------|--------|
| Agent Framework | 9/10 | 9/10 | Already strong |
| Knowledge Management | 7/10 | 9/10 | Library populated, INDEX.md active |
| Project Structure | 4/10 | 8/10 | Two-tier model, PROJECT.md everywhere |
| Naming Conventions | 3/10 | 8/10 | CONVENTIONS.md + steward enforcement |
| File Hygiene | 5/10 | 9/10 | Steward + periodic hygiene squad |
| Documentation | 7/10 | 9/10 | CONVENTIONS.md fills gaps |
| Automation | 4/10 | 7/10 | Squads running, reports generating |
| Templates | 3/10 | 7/10 | PROJECT.md template, scaffolding |

**Projected health: 8.3/10** (up from 6/10).

---

## 6. Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-09 | Created Notes Curator + Library Curator agents | First knowledge management coverage |
| 2026-02-09 | Established `knowledge` squad | Groups related agents |
| 2026-02-09 | Created Library subdirectories | Infrastructure for knowledge engine |
| | | |
| *Pending* | *Adopt two-tier project model* | *Resolves diamond vs native structure tension* |
| *Pending* | *Create Workspace Steward agent* | *Covers structural oversight gap* |
| *Pending* | *Create CONVENTIONS.md* | *Single source of truth for all naming/structure rules* |

---

*This document is maintained in `workflows/agentic-file-system-management.md` and should be updated as the system evolves.*
