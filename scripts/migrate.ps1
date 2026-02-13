<#
.SYNOPSIS
    OPAI Mid-Flight Migration Script — Merge a newer OPAI version into an existing installation.

.DESCRIPTION
    Run this AFTER pulling/copying a newer OPAI version into a system already running an older one.
    It backs up instance data, merges team.json (preserving custom agents), updates scripts,
    restores instance data, and runs preflight validation.

.PARAMETER DryRun
    Preview what would change without making any modifications.

.PARAMETER Force
    Skip confirmation prompts.

.PARAMETER BackupDir
    Custom backup directory. Defaults to _backup_<timestamp> in OPAI root.

.EXAMPLE
    .\scripts\migrate.ps1 -DryRun
    .\scripts\migrate.ps1
    .\scripts\migrate.ps1 -Force
#>

param(
    [switch]$DryRun,
    [switch]$Force,
    [string]$BackupDir
)

$ErrorActionPreference = "Stop"
$OpaiRoot = Split-Path -Parent $PSScriptRoot
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

if (-not $BackupDir) {
    $BackupDir = Join-Path $OpaiRoot "_backup_$Timestamp"
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  OPAI Mid-Flight Migration v1.3.0" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

if ($DryRun) {
    Write-Host "[DRY RUN] No changes will be made.`n" -ForegroundColor Yellow
}

# ── Step 1: Detect Existing Installation ──

Write-Host "[1/8] Detecting existing installation..." -ForegroundColor White

$TeamFile = Join-Path $OpaiRoot "team.json"
$ScriptsDir = Join-Path $OpaiRoot "scripts"
$TasksDir = Join-Path $OpaiRoot "tasks"
$ReportsDir = Join-Path $OpaiRoot "reports"
$ToolsDir = Join-Path $OpaiRoot "tools"

$existing = @{
    TeamJson    = Test-Path $TeamFile
    Scripts     = Test-Path $ScriptsDir
    Tasks       = Test-Path (Join-Path $TasksDir "registry.json")
    Queue       = Test-Path (Join-Path $TasksDir "queue.json")
    Reports     = Test-Path $ReportsDir
    EmailEnv    = Test-Path (Join-Path $ToolsDir "email-checker\.env")
    DiscordEnv  = Test-Path (Join-Path $ToolsDir "discord-bridge\.env")
    WpMcpEnv    = Test-Path (Join-Path $OpaiRoot "mcps\Wordpress-VEC\.env")
    BbMcpEnv    = Test-Path (Join-Path $OpaiRoot "mcps\boutabyte-mcp\.env")
}

$existingCount = ($existing.Values | Where-Object { $_ }).Count
Write-Host "  Found $existingCount existing components:" -ForegroundColor Gray

foreach ($key in $existing.Keys | Sort-Object) {
    $status = if ($existing[$key]) { "[EXISTS]" } else { "[MISSING]" }
    $color = if ($existing[$key]) { "Green" } else { "DarkGray" }
    Write-Host "    $status $key" -ForegroundColor $color
}

if ($existingCount -eq 0) {
    Write-Host "`n  Fresh installation detected. No migration needed — just run preflight." -ForegroundColor Yellow
    Write-Host "  .\scripts\preflight.ps1`n" -ForegroundColor Yellow
    exit 0
}

# ── Step 2: Backup Instance Data ──

Write-Host "`n[2/8] Backing up instance data to $BackupDir..." -ForegroundColor White

$backupItems = @()

# .env files
$envFiles = @(
    "tools\email-checker\.env",
    "tools\discord-bridge\.env",
    "mcps\Wordpress-VEC\.env",
    "mcps\boutabyte-mcp\.env"
)

foreach ($envFile in $envFiles) {
    $fullPath = Join-Path $OpaiRoot $envFile
    if (Test-Path $fullPath) {
        $backupItems += @{ Source = $fullPath; Relative = $envFile }
    }
}

# Task registry and queue
foreach ($taskFile in @("tasks\registry.json", "tasks\queue.json")) {
    $fullPath = Join-Path $OpaiRoot $taskFile
    if (Test-Path $fullPath) {
        $backupItems += @{ Source = $fullPath; Relative = $taskFile }
    }
}

# Reports directory
if (Test-Path $ReportsDir) {
    $backupItems += @{ Source = $ReportsDir; Relative = "reports"; IsDir = $true }
}

Write-Host "  Backing up $($backupItems.Count) items:" -ForegroundColor Gray

foreach ($item in $backupItems) {
    $dest = Join-Path $BackupDir $item.Relative
    Write-Host "    $($item.Relative)" -ForegroundColor DarkGray

    if (-not $DryRun) {
        $destDir = Split-Path -Parent $dest
        if (-not (Test-Path $destDir)) {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        }
        if ($item.IsDir) {
            Copy-Item -Path $item.Source -Destination $dest -Recurse -Force
        } else {
            Copy-Item -Path $item.Source -Destination $dest -Force
        }
    }
}

# ── Step 3: Merge team.json ──

Write-Host "`n[3/8] Merging team.json (preserving custom agents)..." -ForegroundColor White

if ($existing.TeamJson) {
    $oldTeam = Get-Content $TeamFile -Raw | ConvertFrom-Json
    $oldVersion = $oldTeam.version

    # The incoming team.json is already in place (git pull put it there)
    # We need to check if the old version had custom roles/squads not in the new one
    $incomingTeam = Get-Content $TeamFile -Raw | ConvertFrom-Json

    # If we have a backup, compare against it
    $backupTeamFile = Join-Path $BackupDir "team.json"
    if (-not $DryRun -and (Test-Path $TeamFile)) {
        Copy-Item $TeamFile $backupTeamFile -Force
    }

    $incomingRoles = @($incomingTeam.roles.PSObject.Properties.Name)
    $incomingSquads = @($incomingTeam.squads.PSObject.Properties.Name)

    Write-Host "  Incoming version: $($incomingTeam.version)" -ForegroundColor Gray
    Write-Host "  Incoming roles: $($incomingRoles.Count)" -ForegroundColor Gray
    Write-Host "  Incoming squads: $($incomingSquads.Count)" -ForegroundColor Gray

    # Check backup for custom roles that were in the old system
    if (Test-Path $backupTeamFile) {
        $backupTeam = Get-Content $backupTeamFile -Raw | ConvertFrom-Json
        $oldRoles = @($backupTeam.roles.PSObject.Properties.Name)
        $oldSquads = @($backupTeam.squads.PSObject.Properties.Name)

        $customRoles = $oldRoles | Where-Object { $_ -notin $incomingRoles }
        $customSquads = $oldSquads | Where-Object { $_ -notin $incomingSquads }

        if ($customRoles.Count -gt 0) {
            Write-Host "  Custom roles to preserve: $($customRoles -join ', ')" -ForegroundColor Yellow
            if (-not $DryRun) {
                foreach ($role in $customRoles) {
                    $incomingTeam.roles | Add-Member -NotePropertyName $role -NotePropertyValue $backupTeam.roles.$role -Force
                }
            }
        }

        if ($customSquads.Count -gt 0) {
            Write-Host "  Custom squads to preserve: $($customSquads -join ', ')" -ForegroundColor Yellow
            if (-not $DryRun) {
                foreach ($squad in $customSquads) {
                    $incomingTeam.squads | Add-Member -NotePropertyName $squad -NotePropertyValue $backupTeam.squads.$squad -Force
                }
            }
        }

        $newRoles = $incomingRoles | Where-Object { $_ -notin $oldRoles }
        $newSquads = $incomingSquads | Where-Object { $_ -notin $oldSquads }

        if ($newRoles.Count -gt 0) {
            Write-Host "  New roles added: $($newRoles -join ', ')" -ForegroundColor Green
        }
        if ($newSquads.Count -gt 0) {
            Write-Host "  New squads added: $($newSquads -join ', ')" -ForegroundColor Green
        }

        if (-not $DryRun -and ($customRoles.Count -gt 0 -or $customSquads.Count -gt 0)) {
            $incomingTeam | ConvertTo-Json -Depth 10 | Set-Content $TeamFile -Encoding UTF8
            Write-Host "  team.json merged successfully." -ForegroundColor Green
        }
    }
} else {
    Write-Host "  No existing team.json — using incoming version as-is." -ForegroundColor Gray
}

# ── Step 4: Preserve Custom Prompts ──

Write-Host "`n[4/8] Checking for custom prompt files..." -ForegroundColor White

$incomingPrompts = Get-ChildItem (Join-Path $ScriptsDir "prompt_*.txt") -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
$backupScriptsDir = Join-Path $BackupDir "scripts"

if (Test-Path $backupScriptsDir) {
    $oldPrompts = Get-ChildItem (Join-Path $backupScriptsDir "prompt_*.txt") -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
    $customPrompts = $oldPrompts | Where-Object { $_ -notin $incomingPrompts }

    if ($customPrompts.Count -gt 0) {
        Write-Host "  Custom prompts to preserve: $($customPrompts.Count)" -ForegroundColor Yellow
        foreach ($prompt in $customPrompts) {
            Write-Host "    + $prompt" -ForegroundColor Yellow
            if (-not $DryRun) {
                Copy-Item (Join-Path $backupScriptsDir $prompt) (Join-Path $ScriptsDir $prompt) -Force
            }
        }
    } else {
        Write-Host "  No custom prompts found." -ForegroundColor Gray
    }
} else {
    Write-Host "  No backup scripts to compare — skipping." -ForegroundColor Gray
}

# ── Step 5: Update Runner Scripts ──

Write-Host "`n[5/8] Runner scripts updated via git pull (latest versions in place)." -ForegroundColor White

$runners = @("run_squad.ps1", "run_agents.ps1", "run_agents_seq.ps1", "run_auto.ps1", "preflight.ps1", "familiarize.ps1", "process_queue.ps1", "onboard_project.ps1")
foreach ($runner in $runners) {
    $path = Join-Path $ScriptsDir $runner
    $status = if (Test-Path $path) { "OK" } else { "MISSING" }
    $color = if ($status -eq "OK") { "Green" } else { "Red" }
    Write-Host "    [$status] $runner" -ForegroundColor $color
}

# ── Step 6: Restore Instance Data ──

Write-Host "`n[6/8] Restoring instance data from backup..." -ForegroundColor White

$restoreItems = @(
    "tools\email-checker\.env",
    "tools\discord-bridge\.env",
    "mcps\Wordpress-VEC\.env",
    "mcps\boutabyte-mcp\.env",
    "tasks\registry.json",
    "tasks\queue.json"
)

foreach ($item in $restoreItems) {
    $backupPath = Join-Path $BackupDir $item
    $targetPath = Join-Path $OpaiRoot $item

    if (Test-Path $backupPath) {
        Write-Host "    Restored: $item" -ForegroundColor Green
        if (-not $DryRun) {
            $targetDir = Split-Path -Parent $targetPath
            if (-not (Test-Path $targetDir)) {
                New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
            }
            Copy-Item $backupPath $targetPath -Force
        }
    }
}

# ── Step 7: Run Preflight ──

Write-Host "`n[7/8] Running preflight validation..." -ForegroundColor White

if (-not $DryRun) {
    $preflightScript = Join-Path $ScriptsDir "preflight.ps1"
    if (Test-Path $preflightScript) {
        try {
            & $preflightScript
            Write-Host "  Preflight passed." -ForegroundColor Green
        } catch {
            Write-Host "  Preflight had warnings: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  preflight.ps1 not found — skipping." -ForegroundColor Yellow
    }
} else {
    Write-Host "  [DRY RUN] Would run preflight.ps1" -ForegroundColor Yellow
}

# ── Step 8: Generate Diff Report ──

Write-Host "`n[8/8] Migration Summary" -ForegroundColor White
Write-Host "========================================" -ForegroundColor Cyan

$summary = @{
    "Backup location"    = $BackupDir
    "Components found"   = $existingCount
    "Items backed up"    = $backupItems.Count
    "Items restored"     = ($restoreItems | Where-Object { Test-Path (Join-Path $BackupDir $_) }).Count
}

foreach ($key in $summary.Keys) {
    Write-Host "  $key`: $($summary[$key])" -ForegroundColor Gray
}

if ($DryRun) {
    Write-Host "`n  [DRY RUN] No changes were made. Run without -DryRun to apply." -ForegroundColor Yellow
} else {
    Write-Host "`n  Migration complete. Backup saved to:" -ForegroundColor Green
    Write-Host "  $BackupDir" -ForegroundColor Green
}

Write-Host "`n========================================`n" -ForegroundColor Cyan
