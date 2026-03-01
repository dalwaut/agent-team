#!/bin/bash
#
# OPAI Daily Git Push — Commit and push changes on OPAI-Server branch.
#
# Only commits if there are actual changes. Sends email notification
# via the email-checker sender when changes are pushed.
#
# Usage:
#   ./scripts/daily-git-push.sh           # Normal run
#   ./scripts/daily-git-push.sh --dry-run # Preview only
#

set -euo pipefail

OPAI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_PREFIX="[daily-git-push]"
DRY_RUN=false
NOTIFY_EMAIL="dalwaut@gmail.com"
REPO_URL="https://github.com/dalwaut/agent-team"
BRANCH="OPAI-Server"

if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=true
    echo "$LOG_PREFIX DRY RUN — no changes will be made"
fi

cd "$OPAI_ROOT"

# Ensure we're on the right branch
CURRENT_BRANCH=$(git branch --show-current)
if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
    echo "$LOG_PREFIX Not on $BRANCH (on $CURRENT_BRANCH), skipping"
    exit 0
fi

# Check for changes (staged + unstaged + untracked)
if git diff --quiet && git diff --cached --quiet && [[ -z "$(git ls-files --others --exclude-standard)" ]]; then
    echo "$LOG_PREFIX No changes detected, skipping"
    exit 0
fi

echo "$LOG_PREFIX Changes detected, preparing commit..."

# Build changelog from changed files
# Use temp var to avoid SIGPIPE (exit 141) when head closes pipe early with pipefail set
ALL_STATUS=$(git status --porcelain)
CHANGED_FILES=$(echo "$ALL_STATUS" | head -30)
CHANGE_COUNT=$(echo "$ALL_STATUS" | wc -l)
DATE=$(date '+%Y-%m-%d')
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S %Z')

# Categorize changes for commit message
TOOLS_CHANGED=$(echo "$CHANGED_FILES" | grep -c 'tools/' || true)
CONFIG_CHANGED=$(echo "$CHANGED_FILES" | grep -c 'config/' || true)
WIKI_CHANGED=$(echo "$CHANGED_FILES" | grep -c 'Library/' || true)
SCRIPTS_CHANGED=$(echo "$CHANGED_FILES" | grep -c 'scripts/' || true)

# Build commit summary
PARTS=()
[[ $TOOLS_CHANGED -gt 0 ]] && PARTS+=("tools")
[[ $CONFIG_CHANGED -gt 0 ]] && PARTS+=("config")
[[ $WIKI_CHANGED -gt 0 ]] && PARTS+=("wiki")
[[ $SCRIPTS_CHANGED -gt 0 ]] && PARTS+=("scripts")

if [[ ${#PARTS[@]} -eq 0 ]]; then
    SUMMARY="misc updates"
else
    SUMMARY=$(IFS=', '; echo "${PARTS[*]}")
fi

COMMIT_MSG="chore: daily sync — $SUMMARY ($DATE)

Auto-committed by OPAI daily sync.
$CHANGE_COUNT file(s) changed.

Co-Authored-By: OPAI System <system@opai.local>"

if $DRY_RUN; then
    echo "$LOG_PREFIX [DRY] Would commit $CHANGE_COUNT file(s):"
    echo "$CHANGED_FILES"
    echo ""
    echo "$LOG_PREFIX [DRY] Commit message: $COMMIT_MSG"
    exit 0
fi

# Stage all changes and commit
git add -A
git commit -m "$COMMIT_MSG"
COMMIT_HASH=$(git rev-parse --short HEAD)

# Push to remote
git push origin "$BRANCH" 2>&1 || {
    echo "$LOG_PREFIX Push failed, will retry next run"
    exit 1
}

echo "$LOG_PREFIX Pushed $COMMIT_HASH to origin/$BRANCH"

# ── Send email notification ──
# Use Node.js with the email-checker sender module
CHANGELOG="OPAI Server — Daily Sync ($DATE)

Branch: $BRANCH
Commit: $COMMIT_HASH
Time: $TIMESTAMP
Files changed: $CHANGE_COUNT

View on GitHub: $REPO_URL/tree/$BRANCH

Changed files:
$CHANGED_FILES"

# Send via nodemailer using the email-checker sender
node -e "
const path = require('path');
require('dotenv').config({ path: path.join('$OPAI_ROOT', 'tools', 'email-checker', '.env') });
const nodemailer = require(path.join('$OPAI_ROOT', 'tools', 'email-checker', 'node_modules', 'nodemailer'));

const host = process.env.SMTP_HOST_GMAIL || process.env.SMTP_HOST || 'smtp.gmail.com';
const port = parseInt(process.env.SMTP_PORT_GMAIL || process.env.SMTP_PORT || '587');
const user = process.env.SMTP_USER_GMAIL || process.env.IMAP_USER_GMAIL;
const pass = process.env.SMTP_PASS_GMAIL || process.env.IMAP_PASS_GMAIL;

if (!user || !pass) {
    console.log('No email credentials configured, skipping notification');
    process.exit(0);
}

const transport = nodemailer.createTransport({
    host, port,
    secure: port === 465,
    auth: { user, pass },
});

transport.sendMail({
    from: user,
    to: '$NOTIFY_EMAIL',
    subject: 'OPAI Server Sync — $DATE ($CHANGE_COUNT files)',
    text: \`$CHANGELOG\`,
}).then(() => {
    console.log('Notification email sent to $NOTIFY_EMAIL');
}).catch(err => {
    console.error('Email notification failed:', err.message);
});
" 2>&1 || echo "$LOG_PREFIX Email notification failed (non-fatal)"

echo "$LOG_PREFIX Done"
