<#
.SYNOPSIS
    Onboard an external project into Obsidian/Projects/ with diamond workflow scaffolding.

.DESCRIPTION
    Moves or copies a project from an external location into the OPAI workspace.
    Creates diamond workflow structure, generates PROJECT.md, and queues follow-up tasks.
    Falls back to queue mode if the source is unavailable.

.PARAMETER Source
    Full path to the external project folder.

.PARAMETER Name
    Project name (used as folder name under Obsidian/Projects/).

.PARAMETER Move
    If set, moves files instead of copying (default: copy).

.PARAMETER Force
    Skip confirmation prompt.

.PARAMETER ProcessQueue
    Instead of onboarding a new project, process all queued onboarding tasks.

.EXAMPLE
    .\scripts\onboard_project.ps1 -Source "D:\SD\Home\Everglades IT\IT\Projects\FarmView - webapp" -Name "FarmView"
    .\scripts\onboard_project.ps1 -ProcessQueue
#>

param(
    [string]$Source,
    [string]$Name,
    [switch]$Move,
    [switch]$Force,
    [switch]$ProcessQueue
)

$ErrorActionPreference = "Stop"
$OpaiRoot = Split-Path -Parent $PSScriptRoot
$ProjectsDir = Join-Path $OpaiRoot "Obsidian\Projects"
$QueueFile = Join-Path $OpaiRoot "tasks\queue.json"
$ReportsDir = Join-Path $OpaiRoot "reports"
$LatestDir = Join-Path $ReportsDir "latest"

# ── Helpers ──────────────────────────────────────────────────────────────────

function Write-Status($msg) { Write-Host "[onboard] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)     { Write-Host "[onboard] OK: $msg" -ForegroundColor Green }
function Write-Warn($msg)   { Write-Host "[onboard] WARN: $msg" -ForegroundColor Yellow }
function Write-Fail($msg)   { Write-Host "[onboard] FAIL: $msg" -ForegroundColor Red }

function Get-Queue {
    if (Test-Path $QueueFile) {
        return (Get-Content $QueueFile -Raw | ConvertFrom-Json)
    }
    return $null
}

function Save-Queue($queueData) {
    $queueData | ConvertTo-Json -Depth 10 | Set-Content $QueueFile -Encoding UTF8
}

function Get-NextQueueId {
    $today = Get-Date -Format "yyyyMMdd"
    $queue = Get-Queue
    if (-not $queue -or -not $queue.queue) { return "q-$today-001" }

    $todayItems = $queue.queue | Where-Object { $_.id -like "q-$today-*" }
    $completedToday = $queue.completed | Where-Object { $_.id -like "q-$today-*" }
    $allToday = @($todayItems) + @($completedToday) | Where-Object { $_ }

    if ($allToday.Count -eq 0) { return "q-$today-001" }

    $maxNum = ($allToday | ForEach-Object {
        if ($_.id -match "q-\d{8}-(\d{3})") { [int]$Matches[1] } else { 0 }
    } | Measure-Object -Maximum).Maximum

    return "q-$today-{0:D3}" -f ($maxNum + 1)
}

function Add-ToQueue {
    param($Type, $Description, $Payload, $Priority = "normal", $BlockedReason = "")

    $queue = Get-Queue
    if (-not $queue) {
        Write-Fail "Queue file not found at $QueueFile"
        return $null
    }

    $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    $item = [PSCustomObject]@{
        id             = Get-NextQueueId
        type           = $Type
        status         = if ($BlockedReason) { "blocked" } else { "queued" }
        priority       = $Priority
        created        = $now
        updated        = $now
        description    = $Description
        payload        = $Payload
        blocked_reason = $BlockedReason
        retry_count    = 0
        max_retries    = 3
    }

    $queue.queue += $item
    Save-Queue $queue
    Write-Ok "Queued: $($item.id) — $Description"
    return $item.id
}

function New-DiamondScaffold($destPath, $projectName) {
    $dirs = @("Research", "Dev-Plan", "Agent-Tasks", "Codebase", "Notes", "Review-log", "Debug-log")
    foreach ($dir in $dirs) {
        $p = Join-Path $destPath $dir
        if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
    }

    # PROJECT.md
    $projectMd = @"
# $projectName

## Status
- **Onboarded:** $(Get-Date -Format "yyyy-MM-dd")
- **Origin:** External project brought into OPAI workspace
- **Workflow:** Diamond (Research → Dev-Plan → Tasks → Build → Logs/Notes)

## Quick Links
- Codebase: ``Codebase/``
- Dev Plan: ``Dev-Plan/``
- Agent Tasks: ``Agent-Tasks/``

## Notes
Onboarded via ``scripts/onboard_project.ps1``. See status report in ``reports/`` for full analysis.
"@
    $projectMd | Set-Content (Join-Path $destPath "PROJECT.md") -Encoding UTF8
    Write-Ok "Diamond scaffold created at $destPath"
}

# ── Process Queue Mode ───────────────────────────────────────────────────────

if ($ProcessQueue) {
    Write-Status "Processing queued onboarding tasks..."
    $queue = Get-Queue
    if (-not $queue -or -not $queue.queue) {
        Write-Ok "Queue is empty. Nothing to process."
        exit 0
    }

    $onboardItems = $queue.queue | Where-Object {
        $_.type -eq "project-onboard" -and ($_.status -eq "queued" -or $_.status -eq "blocked")
    }

    if ($onboardItems.Count -eq 0) {
        Write-Ok "No pending onboarding tasks in queue."
        exit 0
    }

    foreach ($item in $onboardItems) {
        Write-Status "Processing $($item.id): $($item.description)"
        $src = $item.payload.source

        if (-not (Test-Path $src)) {
            $item.retry_count = [int]$item.retry_count + 1
            $item.updated = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

            if ($item.retry_count -ge $item.max_retries) {
                $item.status = "failed"
                $item.blocked_reason = "Source path unavailable after $($item.max_retries) retries: $src"
                Write-Fail "$($item.id) failed: source still unavailable after $($item.max_retries) attempts"
            } else {
                $item.status = "blocked"
                $item.blocked_reason = "Source path unavailable (retry $($item.retry_count)/$($item.max_retries)): $src"
                Write-Warn "$($item.id) blocked: source unavailable (retry $($item.retry_count)/$($item.max_retries))"
            }
            continue
        }

        # Source is available — proceed with onboarding
        $item.status = "in_progress"
        $item.updated = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        Save-Queue $queue

        $dest = $item.payload.destination
        try {
            # Create diamond scaffold
            New-DiamondScaffold $dest $item.payload.project_name

            # Copy source into Codebase/
            $codebaseDest = Join-Path $dest "Codebase"
            Write-Status "Copying from $src to $codebaseDest..."
            Copy-Item -Path "$src\*" -Destination $codebaseDest -Recurse -Force

            # Mark completed
            $item.status = "completed"
            $item.completed_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            $item.updated = $item.completed_at
            Write-Ok "$($item.id) completed: $($item.payload.project_name) onboarded"

            # Move to completed array
            $queue.completed += $item
            $queue.queue = @($queue.queue | Where-Object { $_.id -ne $item.id })

        } catch {
            $item.status = "failed"
            $item.blocked_reason = "Error during onboarding: $_"
            $item.updated = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            Write-Fail "$($item.id) error: $_"
        }
    }

    Save-Queue $queue
    Write-Status "Queue processing complete."
    exit 0
}

# ── Direct Onboard Mode ─────────────────────────────────────────────────────

if (-not $Source -or -not $Name) {
    Write-Fail "Usage: .\scripts\onboard_project.ps1 -Source <path> -Name <ProjectName>"
    Write-Fail "   or: .\scripts\onboard_project.ps1 -ProcessQueue"
    exit 1
}

$Destination = Join-Path $ProjectsDir $Name

Write-Status "Onboarding: $Name"
Write-Status "  Source:      $Source"
Write-Status "  Destination: $Destination"

# Check if destination already exists
if (Test-Path $Destination) {
    Write-Warn "Destination already exists: $Destination"
    if (-not $Force) {
        $confirm = Read-Host "Overwrite? (y/N)"
        if ($confirm -ne "y") { Write-Status "Aborted."; exit 0 }
    }
}

# Check if source is accessible
if (-not (Test-Path $Source)) {
    Write-Warn "Source path is not accessible: $Source"
    Write-Status "Queueing for later processing..."

    $payload = [PSCustomObject]@{
        project_name = $Name
        source       = $Source
        destination  = $Destination
        steps        = @(
            "Verify source path is accessible",
            "Create destination folder with diamond scaffold",
            "Copy source files into Codebase/",
            "Generate PROJECT.md from status report",
            "Generate CLAUDE.md with tech stack and conventions",
            "Save onboarding report to reports/"
        )
    }

    $queueId = Add-ToQueue -Type "project-onboard" `
        -Description "Move $Name from external location into Obsidian/Projects/$Name" `
        -Payload $payload `
        -BlockedReason "Source path not accessible: $Source"

    Write-Status "Queued as $queueId. Run with -ProcessQueue later to retry."
    exit 0
}

# Source is available — proceed
if (-not $Force) {
    Write-Status "Ready to onboard. This will:"
    Write-Status "  1. Create diamond scaffold at $Destination"
    if ($Move) {
        Write-Status "  2. MOVE source files into Codebase/ (source will be removed)"
    } else {
        Write-Status "  2. Copy source files into Codebase/"
    }
    Write-Status "  3. Generate PROJECT.md"
    $confirm = Read-Host "Proceed? (Y/n)"
    if ($confirm -eq "n") { Write-Status "Aborted."; exit 0 }
}

# Create diamond scaffold
New-DiamondScaffold $Destination $Name

# Copy or move source into Codebase/
$codebaseDest = Join-Path $Destination "Codebase"
Write-Status "$(if ($Move) { 'Moving' } else { 'Copying' }) from $Source to $codebaseDest..."

if ($Move) {
    Move-Item -Path "$Source\*" -Destination $codebaseDest -Force
    Write-Ok "Source files moved (original location cleared)"
} else {
    Copy-Item -Path "$Source\*" -Destination $codebaseDest -Recurse -Force
    Write-Ok "Source files copied"
}

# Save report copy
$today = Get-Date -Format "yyyy-MM-dd"
$reportDir = Join-Path $ReportsDir $today
if (-not (Test-Path $reportDir)) { New-Item -ItemType Directory -Path $reportDir -Force | Out-Null }
if (-not (Test-Path $LatestDir)) { New-Item -ItemType Directory -Path $LatestDir -Force | Out-Null }

$reportContent = @"
# $Name — Onboarding Report

**Date:** $today
**Source:** $Source
**Destination:** $Destination
**Method:** $(if ($Move) { "Move" } else { "Copy" })
**Diamond Scaffold:** Created
**PROJECT.md:** Generated

## Next Steps
- Run familiarize squad: ``.\scripts\run_squad.ps1 -Squad "familiarize" -SkipPreflight``
- Generate CLAUDE.md for the project
- Initialize git if not present
- Connect to Supabase if applicable
"@

$reportFile = Join-Path $reportDir "onboard-$($Name.ToLower()).md"
$reportContent | Set-Content $reportFile -Encoding UTF8
Copy-Item $reportFile (Join-Path $LatestDir "onboard-$($Name.ToLower()).md") -Force

Write-Ok "$Name onboarded successfully at $Destination"
Write-Status "Report saved to $reportFile"
