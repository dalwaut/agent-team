---
description: How to use this agent framework in any project, not just PaciNote.
---

# Portability Guide

This `.agent/` framework is designed to be project-agnostic. Drop it into any codebase.

## Quick Setup for a New Project

```powershell
# 1. Copy the .agent folder
Copy-Item -Recurse path\to\existing\.agent path\to\new\project\.agent

# 2. Remove project-specific prompts you don't need
# Keep universal: reviewer, health, security, manager, self_assessment, researcher, test_writer
# Remove or modify: features, integration, expo_expert, n8n_connector, supabase_expert

# 3. Edit specialist prompts to match the new tech stack

# 4. Run pre-flight
.\.agent\scripts\preflight.ps1

# 5. Run evolve to see what agents the new project needs
.\.agent\scripts\run_squad.ps1 -Squad "evolve"
```

## Universal Agents (work in any project)

No modification needed:
- **reviewer**: Code quality review (language-agnostic)
- **health**: Performance, dead code, security
- **security**: OWASP-based security audit
- **manager**: Consolidates any set of reports
- **self_assessment**: Meta-analysis of the team
- **researcher**: Tech stack analysis
- **content_curator**: Changelogs, app descriptions from git history
- **test_writer**: Test strategy and scaffolding
- **ux_reviewer**: UX quality audit

## Specialist Agents (adapt per project)

- **expo_expert** -> Replace with: nextjs_expert, django_expert, rails_expert, etc.
- **n8n_connector** -> Replace with: zapier_connector, github_actions, custom_ci
- **supabase_expert** -> Replace with: firebase_expert, prisma_expert, custom_api
- **features** / **integration** -> Always project-specific

## team.json Customization

When porting:
1. Update `name` and `description`
2. Remove inapplicable specialist roles
3. Add new specialists for the project's stack
4. Adjust squad compositions
5. Run `evolve` to get AI-suggested additions

## Gitignore Recommendations

```
# Reports are generated output -- optionally track them
# .agent/reports/

# Always track the framework itself
# .agent/scripts/
# .agent/workflows/
# .agent/team.json
```
