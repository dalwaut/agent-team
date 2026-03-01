# Agent-Team Quick Reference

## 🚀 Common Commands

```bash
# List all available squads
./scripts/run_squad.sh --list

# Run a full audit
./scripts/run_squad.sh -s audit

# Run workspace organization
./scripts/run_squad.sh -s workspace

# Run specific agents
./scripts/run_agents_seq.sh --filter "security,health"

# Force re-run (ignore existing reports)
./scripts/run_squad.sh -s audit --force
```

## 📊 Recommended First Runs

1. **Familiarize** - Scan your project
   ```bash
   ./scripts/run_squad.sh -s familiarize
   ```

2. **Workspace** - Organize notes and library
   ```bash
   ./scripts/run_squad.sh -s workspace
   ```

3. **Audit** - Full codebase health check
   ```bash
   ./scripts/run_squad.sh -s audit
   ```

## 🎯 For SEO-GEO-Automator

### Activate n8n Specialist

```bash
# Copy n8n specialist template
cp Templates/prompt_n8n_connector.txt scripts/
```

Then edit `team.json` to add the n8n role and custom squad (see walkthrough.md).

## 📁 Reports Location

```
reports/latest/
```

All agent reports are markdown files you can read directly.
