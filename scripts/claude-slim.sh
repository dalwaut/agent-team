#!/bin/bash
# Claude Code — Slim profile (YouTube only, no Playwright/ClickUp/GoDaddy)
# Saves ~4,300 tokens vs default by dropping Playwright
cd /workspace/synced/opai
exec claude --mcp-config config/mcp-profiles/slim.json "$@"
