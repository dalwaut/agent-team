#!/bin/bash
# Claude Code — WordPress profile (YouTube + Playwright + WordPress VEC)
cd /workspace/synced/opai
exec claude --mcp-config config/mcp-profiles/wordpress.json "$@"
