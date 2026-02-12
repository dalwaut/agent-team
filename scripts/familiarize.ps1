# ============================================================
# Agent Team - Project Familiarizer
# ============================================================
# Run this ONCE after installing Agent Team into a new project.
# It scans the codebase, builds a project profile, and outputs
# customizations to make every agent hyper-relevant.
#
# Usage:
#   .\.agent\scripts\familiarize.ps1
#   .\.agent\scripts\familiarize.ps1 -Yes    # skip confirmation
# ============================================================

param(
    [switch]$Yes
)

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot
$agentDir = Split-Path -Parent $scriptDir
$projectRoot = Split-Path -Parent $agentDir

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Agent Team - Project Familiarizer" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "This agent will scan your project to understand:" -ForegroundColor White
Write-Host "  - Tech stack, framework, and language" -ForegroundColor DarkGray
Write-Host "  - Directory structure and key files" -ForegroundColor DarkGray
Write-Host "  - Naming conventions and patterns" -ForegroundColor DarkGray
Write-Host "  - Recent git history and active work" -ForegroundColor DarkGray
Write-Host "  - Dependencies and configuration" -ForegroundColor DarkGray
Write-Host ""
Write-Host "It will then produce:" -ForegroundColor White
Write-Host "  - A project_context.md (shared context for all agents)" -ForegroundColor DarkGray
Write-Host "  - Per-prompt customization recommendations" -ForegroundColor DarkGray
Write-Host "  - Specialist agent recommendations" -ForegroundColor DarkGray
Write-Host "  - Squad adjustments for your project" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Project root: $projectRoot" -ForegroundColor Yellow
Write-Host ""

# --- Check if already familiarized ---
$contextFile = Join-Path $agentDir "project_context.md"
if (Test-Path $contextFile) {
    $size = (Get-Item $contextFile).Length
    Write-Host "NOTE: project_context.md already exists (${size}B)." -ForegroundColor Yellow
    Write-Host "Running again will regenerate it." -ForegroundColor Yellow
    Write-Host ""
}

# --- Ask for confirmation ---
if (-not $Yes) {
    $confirm = Read-Host "Run the familiarizer now? (Y/n)"
    if ($confirm -eq "n" -or $confirm -eq "N") {
        Write-Host "Aborted. Run later with: .\.agent\scripts\familiarize.ps1" -ForegroundColor DarkGray
        exit 0
    }
}

# --- Pre-flight ---
Write-Host ""
& "$scriptDir\preflight.ps1"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Pre-flight checks failed."
    exit 1
}

# --- Run the familiarizer ---
$promptFile = Join-Path $scriptDir "prompt_familiarizer.txt"
if (-not (Test-Path $promptFile)) {
    Write-Error "prompt_familiarizer.txt not found in $scriptDir"
    exit 1
}

$dateStamp = Get-Date -Format "yyyy-MM-dd"
$reportDir = Join-Path $agentDir "reports" $dateStamp
if (-not (Test-Path $reportDir)) {
    New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
}
$outputFile = Join-Path $reportDir "familiarizer.md"

$promptContent = Get-Content -Path $promptFile -Raw -Encoding UTF8

$fullPrompt = @"
$promptContent

IMPORTANT INSTRUCTIONS:
- Output the FULL report to STDOUT in markdown format.
- Do NOT use file write tools. Print everything to stdout.
- Do NOT ask for clarification. Analyze what you can and note assumptions.
- Be thorough and reference specific file paths and line numbers.
"@

$tempPrompt = Join-Path $env:TEMP "claude_prompt_familiarizer.txt"
Set-Content -Path $tempPrompt -Value $fullPrompt -Encoding UTF8 -NoNewline

Write-Host ""
Write-Host "Scanning project..." -ForegroundColor Cyan
Write-Host "(This may take 1-3 minutes)" -ForegroundColor DarkGray
Write-Host ""

$startTime = Get-Date

try {
    $output = Get-Content -Path $tempPrompt -Raw | claude -p --output-format text 2>&1

    # Write full report
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($outputFile, "# Report: familiarizer`n`n$output", $utf8NoBom)

    # Also extract and write project_context.md if the agent produced one
    # Look for the YAML block between ```yaml and ```
    if ($output -match '(?s)## .*PROJECT.SPECIFIC CONTEXT.*?\n(.*?)$') {
        $contextContent = $Matches[1]
        [System.IO.File]::WriteAllText($contextFile, "# Project Context`n`n$contextContent", $utf8NoBom)
        Write-Host "  project_context.md written." -ForegroundColor Green
    }

    $elapsed = ((Get-Date) - $startTime).TotalSeconds
    $size = (Get-Item $outputFile).Length

    Write-Host ""
    Write-Host "============================================" -ForegroundColor Green
    Write-Host "  Familiarization Complete" -ForegroundColor Green
    Write-Host "============================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Report: $outputFile (${size}B, ${elapsed}s)" -ForegroundColor White
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "  1. Read the report: $outputFile" -ForegroundColor DarkGray
    Write-Host "  2. Review the project_context.md" -ForegroundColor DarkGray
    Write-Host "  3. Apply the prompt customizations it recommends" -ForegroundColor DarkGray
    Write-Host "  4. Activate any specialist templates it suggests" -ForegroundColor DarkGray
    Write-Host "  5. Run your first squad: .\.agent\scripts\run_squad.ps1 -Squad 'audit'" -ForegroundColor DarkGray
    Write-Host ""

    # Copy to latest
    $latestDir = Join-Path $agentDir "reports" "latest"
    if (-not (Test-Path $latestDir)) {
        New-Item -ItemType Directory -Path $latestDir -Force | Out-Null
    }
    Copy-Item $outputFile (Join-Path $latestDir "familiarizer.md") -Force
}
catch {
    Write-Host "  FAILED: $_" -ForegroundColor Red
    exit 1
}
finally {
    Remove-Item -Path $tempPrompt -ErrorAction SilentlyContinue
}
