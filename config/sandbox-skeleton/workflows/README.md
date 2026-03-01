# Your OPAI Sandbox

Welcome to your personal OPAI workspace. Here's what you have:

## Directory Structure

```
files/              Your personal file storage (synced to NAS)
agents/
  team.json         Your agent roster — customize freely
  prompts/          Agent prompt files
scripts/
  run_agent.sh      Run a single agent
  run_squad.sh      Run a squad (group of agents)
  submit_task.sh    Submit work to the central queue
reports/latest/     Agent output goes here
tasks/queue.json    Your task queue (orchestrator reads this)
config/sandbox.json Your limits and settings
```

## Quick Start

```bash
# List available squads
./scripts/run_squad.sh --list

# Run the review squad
./scripts/run_squad.sh review

# Run a single agent
./scripts/run_agent.sh reviewer

# Submit a task to the central system
./scripts/submit_task.sh "Review my latest changes" "Focus on security"
```

## Customizing Agents

Edit `agents/team.json` to:
- Change agent prompts (edit files in `agents/prompts/`)
- Add new agents (create a prompt file, add entry to team.json)
- Create new squads (group agents together)

## Limits

Your sandbox has resource limits set by your admin. Check `config/sandbox.json` for details.
