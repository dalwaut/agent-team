# React Doctor — Wiki

> **Status**: Phase 1 Live (2026-03-09)
> **Type**: CLI tool (no service/port) — runs via `npx -y react-doctor@latest`
> **Skill**: `/home/dallas/.agents/skills/react-doctor/SKILL.md`
> **Squad agent**: `react_doctor` in `team.json` (audit squad)

---

## Concept

React Doctor is a **static anti-pattern scanner** for React and React Native projects. It runs 60+ analysis rules against a codebase and produces a health score (0-100) with categorized findings. It's part of Aiden Bai's React tooling suite (52k+ GitHub stars combined).

**OPAI integration**: Available as an interactive Claude Code skill (`/react-doctor`) and as a squad agent in the `audit` squad. Report-only — never auto-fixes code.

---

## Architecture

```
No service — ephemeral CLI execution via npx

npx -y react-doctor@latest <path> --verbose
     │
     ├── Scans JSX/TSX files for 60+ anti-pattern rules
     ├── Categorizes: Performance, Patterns, Accessibility, Best Practices
     └── Outputs: health score (0-100) + detailed findings
```

No daemon, no port, no process — runs on-demand and exits. Uses `npx -y` for zero-install ephemeral execution.

---

## Key Files

| File | Purpose |
|------|---------|
| `/home/dallas/.agents/skills/react-doctor/SKILL.md` | Interactive Claude Code skill definition |
| `/home/dallas/.claude/skills/react-doctor` | Symlink → skill (enables Claude Code discovery) |
| `scripts/prompt_react_doctor.txt` | Squad agent prompt (used by `run_squad.sh`) |
| `team.json` | Role definition (`react_doctor`) + audit squad membership |

---

## Usage

### Interactive Skill (Claude Code)

Say any of these trigger phrases in a Claude Code session:

- "react doctor tools/opai-agent"
- "scan react code"
- "check react anti-patterns"
- "react health check"

The skill will detect React projects, run the scanner, and present findings.

### Squad Agent (Automated)

The `react_doctor` agent runs as part of the `audit` squad:

```bash
./scripts/run_squad.sh -s "audit"
```

It's also in the audit `dynamic_pool` for selective runs.

### Manual CLI

```bash
export PATH="/home/dallas/.nvm/versions/node/v20.19.5/bin:$PATH"
npx -y react-doctor@latest tools/opai-agent/ --verbose
```

---

## Target Projects

| Project | Path | Framework | Notes |
|---------|------|-----------|-------|
| OPAIxClaude | `tools/opai-agent/` | Electron 31 + React 18 + TS | Primary target |
| Various | `Projects/*/` | Mixed | Auto-detected by package.json scan |

**Excluded**: `tools/scc-ide/` (staged for deletion on OPAI.v3 branch).

---

## React Tooling Suite — Phase Status

| Phase | Tool | Purpose | Status |
|-------|------|---------|--------|
| **1** | **React Doctor** | Static anti-pattern scanner | **Live** |
| 2 | React Scan | Runtime performance profiler | Planned |
| 3 | React Grab | AI context selection (hover → source) | Planned |

---

## Dependencies

- **Node.js**: v20.19.5 via NVM (`/home/dallas/.nvm/versions/node/v20.19.5/bin`)
- **npx**: Included with Node.js — handles ephemeral package execution
- **react-doctor**: `@latest` fetched on each run (no global install)
