# Project Onboarding Workflow

## Purpose
Bring external projects into the OPAI managed workspace with proper structure, documentation, and traceability.

## When to Use
- A project exists outside `Obsidian/Projects/` and needs to be brought under management
- A new project is being created and needs diamond workflow scaffolding
- A client project needs a managed workspace copy

## Components

| Component | Location | Purpose |
|-----------|----------|---------|
| Onboard script | `scripts/onboard_project.ps1` | Handles file transfer + scaffolding |
| Queue processor | `scripts/process_queue.ps1` | Retries blocked operations |
| Agent prompt | `scripts/prompt_project_onboarder.txt` | AI agent for discovery + evaluation |
| Task queue | `tasks/queue.json` | Deferred operations storage |
| Squad | `onboard` in team.json | Agent team for full onboarding workflow |

## Usage

### Direct Onboarding (source available)
```powershell
# Copy project into Projects/ with diamond scaffold
.\scripts\onboard_project.ps1 -Source "D:\path\to\project" -Name "ProjectName"

# Move instead of copy
.\scripts\onboard_project.ps1 -Source "D:\path\to\project" -Name "ProjectName" -Move

# Skip confirmation
.\scripts\onboard_project.ps1 -Source "D:\path\to\project" -Name "ProjectName" -Force
```

### Queue Mode (source unavailable)
When the source path is not accessible, the script automatically queues the operation:
```powershell
# This will auto-queue if source is unavailable
.\scripts\onboard_project.ps1 -Source "D:\unavailable\path" -Name "ProjectName"

# Later, process the queue
.\scripts\process_queue.ps1

# Or just process onboarding tasks
.\scripts\onboard_project.ps1 -ProcessQueue
```

### Queue Management
```powershell
# List all queued items
.\scripts\process_queue.ps1 -List

# Dry run (show what would happen)
.\scripts\process_queue.ps1 -DryRun

# Process specific type
.\scripts\process_queue.ps1 -Type "project-onboard"
```

### Agent-Driven Onboarding
```powershell
# Run the onboarding squad (evaluates + onboards)
.\scripts\run_squad.ps1 -Squad "onboard" -SkipPreflight
```

## Flow

```
User identifies project → Confirms onboarding
         ↓
  Source accessible?
    YES → Copy/Move to Obsidian/Projects/<Name>/Codebase/
         → Create diamond scaffold
         → Generate PROJECT.md
         → Save report to reports/<date>/
         → Done
    NO  → Queue to tasks/queue.json
         → Document state fully
         → Move to next task
         → Later: process_queue.ps1 retries
```

## Queue System Design

### States
| Status | Meaning |
|--------|---------|
| `queued` | Ready to process |
| `in_progress` | Currently being processed |
| `completed` | Successfully finished (moved to `completed` array) |
| `failed` | Exceeded max retries |
| `blocked` | Resource unavailable, will retry |

### Retry Logic
- Default: 3 retries
- Each `process_queue.ps1` run counts as one retry
- After max retries, status becomes `failed`
- Failed items remain visible for manual intervention

### Task Types
| Type | Handler |
|------|---------|
| `project-onboard` | `onboard_project.ps1 -ProcessQueue` |
| `file-transfer` | Built into `process_queue.ps1` |
| `agent-task` | Delegated to appropriate agent |
| `maintenance` | Manual processing |

## Philosophy

> **Queue, don't block.** When a resource is unavailable, document state fully and move on. Hardware and time are finite — keep production moving.

This aligns with the OPAI principle of intelligent resource usage: never spin wheels on a hung operation when there's other productive work to be done.
