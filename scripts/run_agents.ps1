# ============================================================
# PaciNote Agent Team - Parallel Runner
# ============================================================
# Runs Claude agents in parallel using PowerShell jobs.
# Faster but uses more resources. Falls back to sequential on failure.
#
# Usage:
#   .\.agent\scripts\run_agents.ps1                # run all in parallel
#   .\.agent\scripts\run_agents.ps1 -Filter "accuracy,health"
#   .\.agent\scripts\run_agents.ps1 -Force         # re-run all
#   .\.agent\scripts\run_agents.ps1 -MaxParallel 2 # limit concurrency
# ============================================================

param(
    [string]$Filter = "",
    [switch]$Force,
    [switch]$SkipPreflight,
    [int]$MaxParallel = 4
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $PSScriptRoot  # .agent/
$projectRoot = Split-Path -Parent $scriptRoot   # project root

Write-Host "`n=== PaciNote Agent Team (Parallel, max $MaxParallel) ===" -ForegroundColor Green
Write-Host "Project: $projectRoot" -ForegroundColor DarkGray

# --- Pre-flight checks ---
if (-not $SkipPreflight) {
    & "$PSScriptRoot\preflight.ps1"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Pre-flight checks failed. Use -SkipPreflight to bypass."
        exit 1
    }
}

# --- Timestamped report directory ---
$dateStamp = Get-Date -Format "yyyy-MM-dd"
$reportDir = Join-Path (Join-Path $scriptRoot "reports") $dateStamp
if (-not (Test-Path $reportDir)) {
    New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
}
$latestDir = Join-Path (Join-Path $scriptRoot "reports") "latest"

# --- Discover prompt files ---
$promptFiles = Get-ChildItem -Path "$PSScriptRoot\prompt_*.txt" | Sort-Object Name

$filterList = @()
if ($Filter -ne "") {
    $filterList = $Filter.ToLower() -split ","
}

# --- Launch parallel jobs ---
$jobs = @()
$startTime = Get-Date

foreach ($promptFile in $promptFiles) {
    $agentName = $promptFile.BaseName -replace '^prompt_', ''

    if ($filterList.Count -gt 0 -and $agentName.ToLower() -notin $filterList) {
        continue
    }

    $outputFile = Join-Path $reportDir "$agentName.md"

    if (-not $Force -and (Test-Path $outputFile) -and (Get-Item $outputFile).Length -gt 1000) {
        Write-Host "  Skipping $agentName (report exists)" -ForegroundColor DarkGray
        continue
    }

    # Write prompt to a temp file (avoids quoting issues in job scope)
    $promptContent = Get-Content -Path $promptFile.FullName -Raw -Encoding UTF8
    $fullPrompt = @"
$promptContent

IMPORTANT INSTRUCTIONS:
- Output the FULL report to STDOUT in markdown format.
- Do NOT use file write tools. Print everything to stdout.
- Do NOT ask for clarification. Analyze what you can and note assumptions.
- Be thorough and reference specific file paths and line numbers.
"@
    $tempPrompt = Join-Path $env:TEMP "claude_prompt_$agentName.txt"
    Set-Content -Path $tempPrompt -Value $fullPrompt -Encoding UTF8 -NoNewline

    Write-Host "  Launching: $agentName" -ForegroundColor Yellow

    # Throttle if we've hit max parallel
    while (($jobs | Where-Object { $_.State -eq 'Running' }).Count -ge $MaxParallel) {
        Start-Sleep -Milliseconds 500
    }

    $jobs += Start-Job -Name $agentName -ScriptBlock {
        param($tempPrompt, $outputFile, $agentName, $projectRoot)

        Set-Location $projectRoot

        $output = Get-Content -Path $tempPrompt -Raw | claude -p --output-format text 2>&1

        # Write UTF-8 no BOM
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($outputFile, "# Report: $agentName`n`n$output", $utf8NoBom)

        return @{
            Name   = $agentName
            Size   = (Get-Item $outputFile).Length
            Status = "success"
        }
    } -ArgumentList $tempPrompt, $outputFile, $agentName, $projectRoot
}

if ($jobs.Count -eq 0) {
    Write-Host "`nNo agents to run." -ForegroundColor DarkGray
    exit 0
}

# --- Wait and collect results ---
Write-Host "`nWaiting for $($jobs.Count) agents..." -ForegroundColor DarkGray

$jobs | Wait-Job | Out-Null

$results = @()
foreach ($job in $jobs) {
    $agentName = $job.Name
    if ($job.State -eq 'Completed') {
        $r = Receive-Job $job
        Write-Host "  [OK] $agentName ($($r.Size)B)" -ForegroundColor Green
        $results += $r
    }
    else {
        $err = Receive-Job $job -ErrorAction SilentlyContinue 2>&1
        Write-Host "  [!!] $agentName FAILED: $err" -ForegroundColor Red
        $results += @{ Name = $agentName; Status = "failed" }
    }
    Remove-Job $job
}

# --- Cleanup temp files ---
Get-ChildItem "$env:TEMP\claude_prompt_*.txt" -ErrorAction SilentlyContinue | Remove-Item

# --- Merge into latest (preserves reports from other squads) ---
if (Test-Path $reportDir) {
    if (-not (Test-Path $latestDir)) {
        New-Item -ItemType Directory -Path $latestDir -Force | Out-Null
    }
    Get-ChildItem -Path $reportDir -File | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination $latestDir -Force
    }
}

# --- Summary ---
$totalTime = ((Get-Date) - $startTime).TotalSeconds
Write-Host "`n=== Summary ($([Math]::Round($totalTime))s) ===" -ForegroundColor Green
$results | ForEach-Object {
    $icon = if ($_.Status -eq "success") { "[OK]" } else { "[!!]" }
    Write-Host "  $icon $($_.Name)" -ForegroundColor $(if ($_.Status -eq "success") { "Green" } else { "Red" })
}
Write-Host "`nReports: $reportDir" -ForegroundColor Cyan
