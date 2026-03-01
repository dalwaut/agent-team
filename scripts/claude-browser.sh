#!/bin/bash
# Claude Code — Browser profile (YouTube + Playwright)
# Same as default .mcp.json
cd /workspace/synced/opai
exec claude --mcp-config config/mcp-profiles/browser.json "$@"
