<#
.SYNOPSIS
    Process deferred operations from the task queue.

.DESCRIPTION
    Reads tasks/queue.json and processes items by type.
    Supports: project-onboard, file-transfer, maintenance.
    Items that can't be completed are retried or marked failed.

.PARAMETER Type
    Filter by task type (e.g., "project-onboard"). Default: process all types.

.PARAMETER DryRun
    Show what would be processed without executing.

.PARAMETER List
    Just list all queued/blocked items without processing.

.EXAMPLE
    .\scripts\process_queue.ps1
    .\scripts\process_queue.ps1 -Type "project-onboard"
    .\scripts\process_queue.ps1 -List
    .\scripts\process_queue.ps1 -DryRun
#>

param(
    [string]$Type,
    [switch]$DryRun,
    [switch]$List
)

$ErrorActionPreference = "Stop"
$OpaiRoot = Split-Path -Parent $PSScriptRoot
$QueueFile = Join-Path $OpaiRoot "tasks\queue.json"

function Write-Status($msg) { Write-Host "[queue] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)     { Write-Host "[queue] OK: $msg" -ForegroundColor Green }
function Write-Warn($msg)   { Write-Host "[queue] WARN: $msg" -ForegroundColor Yellow }
function Write-Fail($msg)   { Write-Host "[queue] FAIL: $msg" -ForegroundColor Red }

if (-not (Test-Path $QueueFile)) {
    Write-Fail "Queue file not found: $QueueFile"
    exit 1
}

$queueData = Get-Content $QueueFile -Raw | ConvertFrom-Json

$pending = $queueData.queue | Where-Object {
    ($_.status -eq "queued" -or $_.status -eq "blocked") -and
    (-not $Type -or $_.type -eq $Type)
}

# ── List Mode ────────────────────────────────────────────────────────────────

if ($List) {
    Write-Status "=== Task Queue ==="
    Write-Status ""

    if (-not $pending -or $pending.Count -eq 0) {
        Write-Ok "No pending items."
    } else {
        foreach ($item in $pending) {
            $statusColor = switch ($item.status) {
                "queued"  { "White" }
                "blocked" { "Yellow" }
                "failed"  { "Red" }
                default   { "Gray" }
            }
            Write-Host "  [$($item.status.ToUpper().PadRight(7))] " -ForegroundColor $statusColor -NoNewline
            Write-Host "$($item.id) " -ForegroundColor Cyan -NoNewline
            Write-Host "($($item.type)) " -ForegroundColor DarkGray -NoNewline
            Write-Host "$($item.description)"
            if ($item.blocked_reason) {
                Write-Host "           Reason: $($item.blocked_reason)" -ForegroundColor DarkYellow
            }
        }
    }

    Write-Status ""
    $completedCount = if ($queueData.completed) { $queueData.completed.Count } else { 0 }
    Write-Status "Pending: $($pending.Count)  |  Completed: $completedCount"
    exit 0
}

# ── Process Mode ─────────────────────────────────────────────────────────────

if (-not $pending -or $pending.Count -eq 0) {
    Write-Ok "No pending items to process."
    exit 0
}

Write-Status "Processing $($pending.Count) queued item(s)..."
if ($DryRun) { Write-Warn "DRY RUN — no changes will be made" }

foreach ($item in $pending) {
    Write-Status "─────────────────────────────────────────"
    Write-Status "Item: $($item.id) [$($item.type)]"
    Write-Status "  $($item.description)"

    switch ($item.type) {
        "project-onboard" {
            if ($DryRun) {
                Write-Status "  Would run: onboard_project.ps1 -ProcessQueue"
                continue
            }
            # Delegate to the onboard script's queue processor
            & (Join-Path $PSScriptRoot "onboard_project.ps1") -ProcessQueue
        }

        "file-transfer" {
            $src = $item.payload.source
            $dst = $item.payload.destination

            if (-not (Test-Path $src)) {
                $item.retry_count = [int]$item.retry_count + 1
                $item.updated = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
                if ($item.retry_count -ge $item.max_retries) {
                    $item.status = "failed"
                    Write-Fail "$($item.id): source unavailable after max retries"
                } else {
                    $item.status = "blocked"
                    Write-Warn "$($item.id): source unavailable (retry $($item.retry_count)/$($item.max_retries))"
                }
                continue
            }

            if ($DryRun) {
                Write-Status "  Would copy: $src → $dst"
                continue
            }

            try {
                Copy-Item -Path $src -Destination $dst -Recurse -Force
                $item.status = "completed"
                $item.completed_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
                $item.updated = $item.completed_at
                $queueData.completed += $item
                $queueData.queue = @($queueData.queue | Where-Object { $_.id -ne $item.id })
                Write-Ok "$($item.id) completed"
            } catch {
                $item.status = "failed"
                $item.blocked_reason = "Error: $_"
                Write-Fail "$($item.id): $_"
            }
        }

        default {
            Write-Warn "$($item.id): Unknown type '$($item.type)' — skipping"
        }
    }
}

# Save updated queue
$queueData | ConvertTo-Json -Depth 10 | Set-Content $QueueFile -Encoding UTF8
Write-Status "Queue updated."
