---
description: Delegate complex analysis or planning tasks to multiple Claude agents in parallel.
---

# Delegate Analysis to Claude Engines

This workflow spins up multiple instances of Claude Code to analyze different aspects of the codebase.

## Role & Goal
Your role is the **High-Level Orchestrator**. You delegate work to Claude agents (Execution Engines).
- **Memory Management**: All agent outputs are stored in `.agent/reports/<date>/` (with a `latest/` copy).
- **Context**: You read these reports to build the Master Plan in `implementation_plan.md`.

## Quick Start

```powershell
# Run a full audit
.\.agent\scripts\run_squad.ps1 -Squad "audit"

# Plan new features
.\.agent\scripts\run_squad.ps1 -Squad "plan"

# Review after code changes
.\.agent\scripts\run_squad.ps1 -Squad "review"

# Pre-release checks
.\.agent\scripts\run_squad.ps1 -Squad "ship"

# Self-improvement: assess team gaps
.\.agent\scripts\run_squad.ps1 -Squad "evolve"

# List all available squads
.\.agent\scripts\run_squad.ps1 -List

# Run specific agents only
.\.agent\scripts\run_agents_seq.ps1 -Filter "accuracy,health"

# Force re-run (ignore existing reports)
.\.agent\scripts\run_squad.ps1 -Squad "audit" -Force
```

## How It Works

1. **team.json** defines all agents (roles) and squads (groups of agents)
2. **prompt_*.txt** files contain the instructions for each agent
3. **run_squad.ps1** reads team.json, resolves the squad, runs parallel agents first, then "last" agents (like manager) that need prior reports
4. **run_agents.ps1 / run_agents_seq.ps1** run all prompt files directly (parallel or sequential)
5. **preflight.ps1** validates the environment before any run

## Reports

Reports are stored with timestamps:
```
.agent/reports/
├── 2026-02-09/
│   ├── accuracy.md
│   ├── health.md
│   └── manager.md
├── 2026-02-10/
│   ├── accuracy.md
│   └── health.md
└── latest/
    ├── accuracy.md
    └── health.md
```

## Consolidation
1. Read all files in `.agent/reports/latest/`
2. The **manager** agent auto-consolidates into a prioritized plan
3. Or manually: summarize findings into `implementation_plan.md`
