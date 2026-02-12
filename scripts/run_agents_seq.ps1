# ============================================================
# PaciNote Agent Team - Sequential Runner
# ============================================================
# Runs Claude agents one at a time for maximum reliability.
# Each agent reads its prompt from .agent/scripts/prompt_*.txt
# and writes its report to .agent/reports/<date>/<name>.md
#
# Usage:
#   .\.agent\scripts\run_agents_seq.ps1                  # run all
#   .\.agent\scripts\run_agents_seq.ps1 -Filter "accuracy,health"  # run specific
#   .\.agent\scripts\run_agents_seq.ps1 -Force            # re-run even if report exists
# ============================================================

param(
    [string]$Filter = "",
    [switch]$Force,
    [switch]$SkipPreflight
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $PSScriptRoot  # .agent/
$projectRoot = Split-Path -Parent $scriptRoot   # project root

Write-Host "`n=== PaciNote Agent Team (Sequential) ===" -ForegroundColor Cyan
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
$reportDir = Join-Path $scriptRoot "reports" $dateStamp
if (-not (Test-Path $reportDir)) {
    New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
}
# Also keep a "latest" symlink/copy
$latestDir = Join-Path $scriptRoot "reports" "latest"

# --- Discover all prompt files ---
$promptFiles = Get-ChildItem -Path "$PSScriptRoot\prompt_*.txt" | Sort-Object Name

if ($promptFiles.Count -eq 0) {
    Write-Error "No prompt files found in $PSScriptRoot"
    exit 1
}

# --- Filter if requested ---
$filterList = @()
if ($Filter -ne "") {
    $filterList = $Filter.ToLower() -split ","
}

# --- Run agents ---
$results = @()
$startTime = Get-Date

foreach ($promptFile in $promptFiles) {
    # Extract agent name from filename: prompt_accuracy.txt -> accuracy
    $agentName = $promptFile.BaseName -replace '^prompt_', ''

    # Apply filter
    if ($filterList.Count -gt 0 -and $agentName.ToLower() -notin $filterList) {
        Write-Host "  Skipping $agentName (not in filter)" -ForegroundColor DarkGray
        continue
    }

    $outputFile = Join-Path $reportDir "$agentName.md"

    # Skip if report exists and is substantial (>1KB), unless -Force
    if (-not $Force -and (Test-Path $outputFile)) {
        $size = (Get-Item $outputFile).Length
        if ($size -gt 1000) {
            Write-Host "  Skipping $agentName (report exists, ${size}B)" -ForegroundColor DarkGray
            $results += @{ Name = $agentName; Status = "skipped"; Size = $size }
            continue
        }
    }

    Write-Host "`n--- Agent: $agentName ---" -ForegroundColor Yellow

    # Read prompt content (preserve newlines, UTF-8)
    $promptContent = Get-Content -Path $promptFile.FullName -Raw -Encoding UTF8

    # Append standard instructions
    $fullPrompt = @"
$promptContent

IMPORTANT INSTRUCTIONS:
- Output the FULL report to STDOUT in markdown format.
- Do NOT use file write tools. Print everything to stdout.
- Do NOT ask for clarification. Analyze what you can and note assumptions.
- Be thorough and reference specific file paths and line numbers.
"@

    # Write prompt to temp file to avoid shell quoting issues
    $tempPrompt = Join-Path $env:TEMP "claude_prompt_$agentName.txt"
    Set-Content -Path $tempPrompt -Value $fullPrompt -Encoding UTF8 -NoNewline

    $agentStart = Get-Date
    Write-Host "  Running claude..." -ForegroundColor DarkGray

    try {
        # Pipe prompt via file to avoid all quoting/encoding issues
        $output = Get-Content -Path $tempPrompt -Raw | claude -p --output-format text 2>&1

        # Write report with UTF-8 encoding (no BOM)
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($outputFile, "# Report: $agentName`n`n$output", $utf8NoBom)

        $size = (Get-Item $outputFile).Length
        $elapsed = ((Get-Date) - $agentStart).TotalSeconds
        Write-Host "  Done (${size}B, ${elapsed}s)" -ForegroundColor Green
        $results += @{ Name = $agentName; Status = "success"; Size = $size; Time = $elapsed }
    }
    catch {
        Write-Host "  FAILED: $_" -ForegroundColor Red
        $results += @{ Name = $agentName; Status = "failed"; Error = $_.ToString() }
    }
    finally {
        Remove-Item -Path $tempPrompt -ErrorAction SilentlyContinue
    }

    # Brief pause between agents to avoid rate limiting
    Start-Sleep -Seconds 3
}

# --- Copy to "latest" ---
if (Test-Path $reportDir) {
    if (Test-Path $latestDir) { Remove-Item -Recurse -Force $latestDir }
    Copy-Item -Recurse -Path $reportDir -Destination $latestDir
}

# --- Summary ---
$totalTime = ((Get-Date) - $startTime).TotalSeconds
Write-Host "`n=== Summary ===" -ForegroundColor Cyan
Write-Host "Reports: $reportDir"
Write-Host "Total time: ${totalTime}s`n"

$results | ForEach-Object {
    $icon = switch ($_.Status) { "success" { "[OK]" } "skipped" { "[--]" } "failed" { "[!!]" } }
    $detail = if ($_.Size) { "$($_.Size)B" } elseif ($_.Error) { $_.Error.Substring(0, [Math]::Min(60, $_.Error.Length)) } else { "" }
    Write-Host "  $icon $($_.Name): $($_.Status) $detail" -ForegroundColor $(switch ($_.Status) { "success" { "Green" } "skipped" { "Gray" } "failed" { "Red" } })
}

Write-Host "`nDone." -ForegroundColor Cyan
