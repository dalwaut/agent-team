#!/bin/bash
# Claude Code — Full profile (all local MCPs: YouTube, Playwright, ClickUp, GoDaddy)
cd /workspace/synced/opai
exec claude --mcp-config config/mcp-profiles/full.json "$@"
