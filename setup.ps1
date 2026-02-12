# ============================================================
# Agent Team - Quick Setup
# ============================================================
# Installs the agent team framework into a target project.
# Asks if you want to run the familiarizer to customize agents.
#
# Usage:
#   .\setup.ps1 -Target "C:\path\to\your\project"
#   .\setup.ps1 -Target "." -WithSpecialists
# ============================================================

param(
    [string]$Target = ".",
    [switch]$WithSpecialists
)

$agentDir = Join-Path $Target ".agent"

if (Test-Path $agentDir) {
    Write-Host ".agent/ already exists in $Target" -ForegroundColor Yellow
    $confirm = Read-Host "Overwrite? (y/N)"
    if ($confirm -ne "y") {
        Write-Host "Aborted." -ForegroundColor Red
        exit 0
    }
}

Write-Host "`nInstalling Agent Team..." -ForegroundColor Cyan

$sourceDir = $PSScriptRoot
if (-not $sourceDir) { $sourceDir = "." }

$dirs = @("scripts", "workflows", "templates", "reports")
foreach ($d in $dirs) {
    $path = Join-Path $agentDir $d
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
}

Copy-Item (Join-Path $sourceDir "team.json") $agentDir -Force
Get-ChildItem (Join-Path $sourceDir "scripts") | Copy-Item -Destination (Join-Path $agentDir "scripts") -Force
Get-ChildItem (Join-Path $sourceDir "workflows") | Copy-Item -Destination (Join-Path $agentDir "workflows") -Force
Get-ChildItem (Join-Path $sourceDir "templates") | Copy-Item -Destination (Join-Path $agentDir "templates") -Force

if ($WithSpecialists) {
    Write-Host "Activating specialist templates..." -ForegroundColor DarkGray
    Get-ChildItem (Join-Path $agentDir "templates") -Filter "prompt_*.txt" | ForEach-Object {
        $dest = Join-Path $agentDir "scripts" $_.Name
        if (-not (Test-Path $dest)) {
            Copy-Item $_.FullName $dest
            Write-Host "  Activated: $($_.Name)" -ForegroundColor DarkGray
        }
    }
}

$gitkeep = Join-Path $agentDir "reports" ".gitkeep"
if (-not (Test-Path $gitkeep)) { New-Item -ItemType File -Path $gitkeep -Force | Out-Null }

Write-Host "`nInstalled to: $agentDir" -ForegroundColor Green
Write-Host ""

# --- Ask to run familiarizer ---
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  The Familiarizer agent can scan this" -ForegroundColor Cyan
Write-Host "  project and customize all agents to be" -ForegroundColor Cyan
Write-Host "  hyper-relevant to YOUR codebase." -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "It will:" -ForegroundColor White
Write-Host "  - Detect your tech stack and conventions" -ForegroundColor DarkGray
Write-Host "  - Build a project_context.md shared by all agents" -ForegroundColor DarkGray
Write-Host "  - Recommend which specialist agents to activate" -ForegroundColor DarkGray
Write-Host "  - Output per-prompt customizations" -ForegroundColor DarkGray
Write-Host ""

$runFamiliarizer = Read-Host "Run the familiarizer now? (Y/n)"

if ($runFamiliarizer -ne "n" -and $runFamiliarizer -ne "N") {
    Write-Host ""
    & (Join-Path $agentDir "scripts" "familiarize.ps1") -Yes
}
else {
    Write-Host ""
    Write-Host "Skipped. You can run it later:" -ForegroundColor DarkGray
    Write-Host "  .\.agent\scripts\familiarize.ps1" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Other commands:" -ForegroundColor Cyan
    Write-Host "  List squads:    .\.agent\scripts\run_squad.ps1 -List"
    Write-Host "  First audit:    .\.agent\scripts\run_squad.ps1 -Squad 'audit'"
    Write-Host "  Self-assess:    .\.agent\scripts\run_squad.ps1 -Squad 'evolve'"
    Write-Host ""
}
