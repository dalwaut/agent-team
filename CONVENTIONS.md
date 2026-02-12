# OPAI Conventions

> Single source of truth for naming, structure, knowledge flow, and security rules.
> All agents read this file and flag violations in their reports.

---

## File Naming

| Context | Convention | Example |
|---------|-----------|---------|
| Folders | PascalCase or kebab-case | `DevPlan/`, `Dev-Plan/` |
| Markdown files | kebab-case.md | `expo-build-commands.md` |
| Agent prompts | `prompt_<name>.txt` (snake_case) | `prompt_notes_curator.txt` |
| Scripts | `<name>.ps1` (snake_case) | `run_squad.ps1` |
| Project folders | PascalCase | `BoutaCare`, `FarmView` |
| Client folders | PascalCase | `LacePearl`, `Westberg` |
| n8n workflows | `<HexID>-<Name>.json` (keep original) | `05v5fA1P-Email_Extraction.json` |

### Rules
- **NEVER** use spaces in folder or file names (breaks paths, wikilinks, CLI)
- **NEVER** use special characters (`&`, `!`, `#`, `@`) in names
- **ALWAYS** use `.md` extension for documentation
- **ALWAYS** use `.txt` extension for agent prompts
- **ALWAYS** use `.ps1` extension for PowerShell scripts
- Rename existing violations incrementally (don't break Obsidian links all at once)

---

## Project Structure

### Tier A — Agent-Managed Projects (Diamond Workflow)

For projects where agents drive the workflow:

```
Obsidian/Projects/<ProjectName>/
  Research/          # Sources, findings, competitor analysis
  Dev-Plan/          # Architecture decisions, implementation plans
  Agent-Tasks/       # YAML task definitions for agents
  Codebase/          # Actual source code (or link to external repo)
  Notes/             # Project-specific notes
  Review-log/        # Agent review entries
  Debug-log/         # Debug traces and error analysis
  PROJECT.md         # REQUIRED: Project metadata
```

### Tier B — Codebase Projects (Native + Metadata)

For projects with their own build systems — keep native structure, add metadata:

```
Obsidian/Projects/<ProjectName>/
  src/               # (native)
  docs/              # (native — maps to Dev-Plan + Notes)
  supabase/          # (native)
  node_modules/      # (native)
  PROJECT.md         # REQUIRED: Project metadata + agent instructions
  CLAUDE.md          # Optional: AI agent instructions
  CHANGELOG.md       # Optional: version history
```

### Tier C — Client Projects

```
Clients/<ClientName>/
  PROJECT.md         # REQUIRED: Client info, contacts, project scope
  Notes/             # Meeting notes, correspondence
  Deliverables/      # Final outputs sent to client
  Assets/            # Logos, brand guides, provided materials
```

### Universal Requirements
- **Every project and client folder MUST have `PROJECT.md`**
- `PROJECT.md` contains: name, description, tier, tech stack, status, key links
- Empty projects (no meaningful content for 90+ days) should be archived to `_archived/`

---

## Knowledge Flow

```
Problem Solved in Project
         |
         v
  Notes/ in project (immediate capture)
         |
         v
  notes_curator COPIES to notes/ (source of truth for personal reference)
         |
         v
  library_curator PROMOTES to Library/ (reusable knowledge)
         |
         v
  INDEX.md updated (searchable)
```

### Rules
- `notes/` is the **source of truth** for personal reference
- `Library/` is the **source of truth** for reusable knowledge
- Projects get **COPIES**, never originals
- Research/ findings get **PROMOTED** to Library/ when mature
- Never move originals out of their source location — always copy first

---

## Security

- Credentials ONLY in `notes/Access/` (nowhere else in the workspace)
- No `.env` files committed to version control
- No API keys in code or notes outside `notes/Access/`
- Flag any credentials found outside `notes/Access/` as P0 security issue
- Agent prompts must never contain actual API keys, tokens, or passwords

---

## Reports

- Reports go to `reports/<YYYY-MM-DD>/` with a copy in `reports/latest/`
- Report Dispatcher reads `reports/latest/` and produces:
  - Agent instructions (for next squad run)
  - HITL briefings (for human review in `reports/HITL/`)
- Processed reports move to `reports/Archive/`
- Reports use UTF-8 encoding (no BOM)
- Minimum report size: 1000 bytes (anything less suggests a broken prompt)

---

## Archival

- Empty projects older than 90 days → move to `Obsidian/Projects/_archived/`
- Stale tasks older than 30 days → flag for review
- Completed research → promote to Library/, archive original
- Queue items blocked for 7+ days → escalate to HITL

---

## Commits & Git (for versioned projects)

- **Conventional commits**: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`
- **Branch naming**: `feature/`, `bugfix/`, `hotfix/`, `docs/` prefixes
- Never force-push to main/master
- Always use `.gitignore` appropriate for the project's stack

---

## Queue Operations

- When a resource is unavailable, **queue** the operation to `tasks/queue.json`
- Never block or spin-wait on unavailable resources
- Document the full state (what's done, what remains) in the queue entry
- Process the queue later via `scripts/process_queue.ps1`
- Queue states: `queued` → `in_progress` → `completed` (or `blocked` → `failed`)

---

*This file is maintained at workspace root and should be updated as conventions evolve. All agents should reference it.*
