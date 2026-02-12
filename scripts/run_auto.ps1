# ============================================================
# Agent Team - Auto-Executor
# ============================================================
# Reads agent reports and automatically applies fixes.
#
# Mode 1 (safe):  Only non-breaking, trivially correct changes
# Mode 2 (full):  All safe changes + structural improvements
#
# Safety: creates a git branch, shows dry-run diff, asks to confirm.
#
# Usage:
#   .\.agent\scripts\run_auto.ps1 -Mode safe
#   .\.agent\scripts\run_auto.ps1 -Mode full
#   .\.agent\scripts\run_auto.ps1 -Mode safe -DryRun       # plan only, don't apply
#   .\.agent\scripts\run_auto.ps1 -Mode full -NoBranch      # skip branch creation
#   .\.agent\scripts\run_auto.ps1 -Mode safe -Yes           # skip confirmation
# ============================================================

param(
    [Parameter(Mandatory)]
    [ValidateSet("safe", "full")]
    [string]$Mode,

    [switch]$DryRun,
    [switch]$NoBranch,
    [switch]$Yes,
    [switch]$SkipPreflight
)

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot
$agentDir = Split-Path -Parent $scriptDir
$projectRoot = Split-Path -Parent $agentDir

Write-Host ""
Write-Host "============================================" -ForegroundColor $(if ($Mode -eq "safe") { "Green" } else { "Yellow" })
Write-Host "  Agent Team - Auto-Executor" -ForegroundColor $(if ($Mode -eq "safe") { "Green" } else { "Yellow" })
Write-Host "  Mode: $($Mode.ToUpper())" -ForegroundColor $(if ($Mode -eq "safe") { "Green" } else { "Yellow" })
Write-Host "============================================" -ForegroundColor $(if ($Mode -eq "safe") { "Green" } else { "Yellow" })
Write-Host ""

if ($Mode -eq "safe") {
    Write-Host "  SAFE MODE: Only non-breaking, trivially correct changes" -ForegroundColor Green
    Write-Host "  - Remove unused imports, dead code, console.logs" -ForegroundColor DarkGray
    Write-Host "  - Uninstall unused npm deps" -ForegroundColor DarkGray
    Write-Host "  - Fix typos in comments" -ForegroundColor DarkGray
    Write-Host "  - NO logic changes, NO refactors" -ForegroundColor DarkGray
}
else {
    Write-Host "  FULL MODE: Safe changes + structural improvements" -ForegroundColor Yellow
    Write-Host "  - Everything in safe mode" -ForegroundColor DarkGray
    Write-Host "  - Bug fixes from accuracy reports" -ForegroundColor DarkGray
    Write-Host "  - Refactors from health/reviewer reports" -ForegroundColor DarkGray
    Write-Host "  - Missing error handling and UX states" -ForegroundColor DarkGray
    Write-Host "  - Query optimizations" -ForegroundColor DarkGray
}
Write-Host ""

# --- Check for reports ---
$latestDir = Join-Path $agentDir "reports" "latest"
if (-not (Test-Path $latestDir)) {
    Write-Error "No reports found. Run a squad first: .\.agent\scripts\run_squad.ps1 -Squad 'audit'"
    exit 1
}

$reportCount = (Get-ChildItem $latestDir -Filter "*.md").Count
if ($reportCount -eq 0) {
    Write-Error "No reports in $latestDir. Run a squad first."
    exit 1
}
Write-Host "  Found $reportCount reports in $latestDir" -ForegroundColor DarkGray

# --- Pre-flight ---
if (-not $SkipPreflight) {
    & "$scriptDir\preflight.ps1"
    if ($LASTEXITCODE -ne 0) { exit 1 }
}

# --- Safety: check for uncommitted changes ---
$gitStatus = git -C $projectRoot status --porcelain 2>&1
if ($gitStatus -and -not $NoBranch) {
    Write-Host ""
    Write-Host "  WARNING: You have uncommitted changes." -ForegroundColor Yellow
    Write-Host "  The auto-executor will create a new branch from current state." -ForegroundColor Yellow
    Write-Host "  Uncommitted changes will be included." -ForegroundColor Yellow
    Write-Host ""
    if (-not $Yes) {
        $confirm = Read-Host "  Continue? (y/N)"
        if ($confirm -ne "y" -and $confirm -ne "Y") {
            Write-Host "  Aborted." -ForegroundColor Red
            exit 0
        }
    }
}

# --- Safety: create a branch ---
$branchName = "agent/auto-$Mode-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
if (-not $NoBranch -and -not $DryRun) {
    Write-Host ""
    Write-Host "  Creating safety branch: $branchName" -ForegroundColor Cyan
    git -C $projectRoot checkout -b $branchName 2>&1 | Out-Null
    Write-Host "  Branch created. Original branch preserved." -ForegroundColor DarkGray
}

# --- Phase 1: Generate the fix plan ---
$promptFile = if ($Mode -eq "safe") {
    Join-Path $scriptDir "prompt_executor_safe.txt"
} else {
    Join-Path $scriptDir "prompt_executor_full.txt"
}

if (-not (Test-Path $promptFile)) {
    Write-Error "Executor prompt not found: $promptFile"
    exit 1
}

$dateStamp = Get-Date -Format "yyyy-MM-dd"
$reportDir = Join-Path $agentDir "reports" $dateStamp
if (-not (Test-Path $reportDir)) {
    New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
}

$planFile = Join-Path $reportDir "executor_${Mode}_plan.md"

$promptContent = Get-Content -Path $promptFile -Raw -Encoding UTF8
$fullPrompt = @"
$promptContent

IMPORTANT INSTRUCTIONS:
- Output the FULL fix plan to STDOUT in markdown format.
- Do NOT use file write tools. Print everything to stdout.
- Do NOT ask for clarification.
- Read the agent reports in .agent/reports/latest/ to find actionable fixes.
- Be precise with file paths, line numbers, and code content.
"@

$tempPrompt = Join-Path $env:TEMP "claude_prompt_executor.txt"
Set-Content -Path $tempPrompt -Value $fullPrompt -Encoding UTF8 -NoNewline

Write-Host ""
Write-Host "  Phase 1: Generating fix plan..." -ForegroundColor Cyan
Write-Host "  (Reading $reportCount agent reports, this takes 1-3 min)" -ForegroundColor DarkGray

$startTime = Get-Date

try {
    $planOutput = Get-Content -Path $tempPrompt -Raw | claude -p --output-format text 2>&1

    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($planFile, "# Executor Plan ($Mode mode)`n`n$planOutput", $utf8NoBom)

    $planSize = (Get-Item $planFile).Length
    $elapsed = ((Get-Date) - $startTime).TotalSeconds
    Write-Host "  Plan generated (${planSize}B, ${elapsed}s)" -ForegroundColor Green
    Write-Host "  Saved to: $planFile" -ForegroundColor DarkGray
}
catch {
    Write-Host "  Plan generation FAILED: $_" -ForegroundColor Red
    exit 1
}
finally {
    Remove-Item -Path $tempPrompt -ErrorAction SilentlyContinue
}

# --- If dry-run, stop here ---
if ($DryRun) {
    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "  DRY RUN - No changes applied" -ForegroundColor Cyan
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "  Review the plan: $planFile" -ForegroundColor DarkGray
    Write-Host "  To apply: .\.agent\scripts\run_auto.ps1 -Mode $Mode" -ForegroundColor DarkGray
    Write-Host ""
    exit 0
}

# --- Phase 2: Ask user to confirm ---
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Fix plan ready. Review:" -ForegroundColor Cyan
Write-Host "  $planFile" -ForegroundColor White
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

if (-not $Yes) {
    Write-Host "  The executor will now apply fixes using Claude Code." -ForegroundColor White
    Write-Host "  Changes are on branch: $branchName" -ForegroundColor DarkGray
    Write-Host "  You can always revert with: git checkout - && git branch -D $branchName" -ForegroundColor DarkGray
    Write-Host ""
    $confirm = Read-Host "  Apply fixes now? (y/N)"
    if ($confirm -ne "y" -and $confirm -ne "Y") {
        Write-Host "  Aborted. Plan saved at: $planFile" -ForegroundColor Yellow
        if (-not $NoBranch) {
            git -C $projectRoot checkout - 2>&1 | Out-Null
            git -C $projectRoot branch -D $branchName 2>&1 | Out-Null
            Write-Host "  Branch removed." -ForegroundColor DarkGray
        }
        exit 0
    }
}

# --- Phase 3: Apply fixes via Claude ---
Write-Host ""
Write-Host "  Phase 2: Applying fixes..." -ForegroundColor Cyan

$applyPrompt = @"
You are applying the fix plan below to this codebase. Execute each fix block precisely.

For each ``fix block with ACTION: delete_line, replace_line, replace_block, insert_after:
- Read the target file
- Find the exact BEFORE content
- Apply the change
- Verify the edit was applied

For ACTION: run_command:
- Execute the command

For ACTION: create_file:
- Write the file with the specified content

SKIP any fix where:
- The BEFORE content doesn't match what's in the file (file was already changed)
- The file doesn't exist
- The change looks risky in context

After all fixes, output a summary of what was applied vs skipped.

THE PLAN:
$(Get-Content -Path $planFile -Raw)
"@

$tempApply = Join-Path $env:TEMP "claude_prompt_apply.txt"
Set-Content -Path $tempApply -Value $applyPrompt -Encoding UTF8 -NoNewline

$resultFile = Join-Path $reportDir "executor_${Mode}_result.md"

try {
    $applyOutput = Get-Content -Path $tempApply -Raw | claude -p --output-format text 2>&1
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($resultFile, "# Executor Result ($Mode mode)`n`n$applyOutput", $utf8NoBom)
    Write-Host "  Fixes applied." -ForegroundColor Green
    Write-Host "  Result: $resultFile" -ForegroundColor DarkGray
}
catch {
    Write-Host "  Apply FAILED: $_" -ForegroundColor Red
}
finally {
    Remove-Item -Path $tempApply -ErrorAction SilentlyContinue
}

# --- Phase 4: Show diff ---
Write-Host ""
Write-Host "  Phase 3: Reviewing changes..." -ForegroundColor Cyan

$diff = git -C $projectRoot diff --stat 2>&1
if ($diff) {
    Write-Host ""
    Write-Host $diff
    Write-Host ""

    $filesChanged = git -C $projectRoot diff --name-only 2>&1
    Write-Host "  Files changed:" -ForegroundColor Cyan
    $filesChanged | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}
else {
    Write-Host "  No file changes detected." -ForegroundColor Yellow
}

# --- Summary ---
Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  Auto-Executor Complete" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Mode:    $($Mode.ToUpper())" -ForegroundColor White
Write-Host "  Branch:  $branchName" -ForegroundColor White
Write-Host "  Plan:    $planFile" -ForegroundColor DarkGray
Write-Host "  Result:  $resultFile" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Cyan
Write-Host "    Review changes:    git diff" -ForegroundColor DarkGray
Write-Host "    Accept & merge:    git checkout master && git merge $branchName" -ForegroundColor DarkGray
Write-Host "    Reject & revert:   git checkout master && git branch -D $branchName" -ForegroundColor DarkGray
Write-Host "    Cherry-pick:       git checkout master && git cherry-pick <commit>" -ForegroundColor DarkGray
Write-Host ""
