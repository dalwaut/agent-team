# ============================================================
# PaciNote Agent Team - Squad Runner
# ============================================================
# Reads team.json to run a named squad of agents.
# Handles run_order (parallel first, then "last" agents sequentially).
#
# Usage:
#   .\.agent\scripts\run_squad.ps1 -Squad "audit"
#   .\.agent\scripts\run_squad.ps1 -Squad "plan" -Force
#   .\.agent\scripts\run_squad.ps1 -Squad "evolve"
#   .\.agent\scripts\run_squad.ps1 -List              # show available squads
# ============================================================

param(
    [string]$Squad = "",
    [switch]$Force,
    [switch]$SkipPreflight,
    [switch]$List,
    [int]$MaxParallel = 4
)

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot
$agentDir = Split-Path -Parent $scriptDir          # .agent/
$projectRoot = Split-Path -Parent $agentDir        # project root
$teamFile = Join-Path $agentDir "team.json"

# --- Load team config ---
if (-not (Test-Path $teamFile)) {
    Write-Error "team.json not found at $teamFile"
    exit 1
}

$team = Get-Content -Path $teamFile -Raw | ConvertFrom-Json

# --- List squads ---
if ($List) {
    Write-Host "`n=== Available Squads ===" -ForegroundColor Cyan
    $team.squads.PSObject.Properties | ForEach-Object {
        $s = $_.Value
        $agents = ($s.agents -join ", ")
        Write-Host "  $($_.Name): $($s.description)" -ForegroundColor Yellow
        Write-Host "    Agents: $agents" -ForegroundColor DarkGray
    }
    Write-Host ""
    exit 0
}

if ($Squad -eq "") {
    Write-Error "Specify a squad with -Squad <name>. Use -List to see options."
    exit 1
}

# --- Resolve squad ---
$squadConfig = $team.squads.PSObject.Properties | Where-Object { $_.Name -eq $Squad }
if (-not $squadConfig) {
    Write-Error "Squad '$Squad' not found. Use -List to see options."
    exit 1
}

$squadAgents = $squadConfig.Value.agents
Write-Host "`n=== Squad: $Squad ===" -ForegroundColor Cyan
Write-Host "Description: $($squadConfig.Value.description)" -ForegroundColor DarkGray
Write-Host "Agents: $($squadAgents -join ', ')`n" -ForegroundColor DarkGray

# --- Pre-flight ---
if (-not $SkipPreflight) {
    & "$scriptDir\preflight.ps1"
    if ($LASTEXITCODE -ne 0) { exit 1 }
}

# --- Report directory ---
$dateStamp = Get-Date -Format "yyyy-MM-dd"
$reportDir = Join-Path $agentDir "reports" $dateStamp
if (-not (Test-Path $reportDir)) {
    New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
}
$latestDir = Join-Path $agentDir "reports" "latest"

# --- Separate parallel vs sequential agents ---
$parallelAgents = @()
$lastAgents = @()

foreach ($agentName in $squadAgents) {
    $roleDef = $team.roles.PSObject.Properties | Where-Object { $_.Name -eq $agentName }
    if (-not $roleDef) {
        Write-Host "  [!!] Unknown agent: $agentName (skipping)" -ForegroundColor Red
        continue
    }
    $role = $roleDef.Value
    $promptFile = Join-Path $scriptDir $role.prompt_file

    if (-not (Test-Path $promptFile)) {
        Write-Host "  [!!] Missing prompt: $($role.prompt_file) (skipping $agentName)" -ForegroundColor Red
        continue
    }

    $agent = @{
        Name       = $agentName
        PromptFile = $promptFile
        OutputFile = Join-Path $reportDir "$agentName.md"
        RunOrder   = $role.run_order
    }

    if ($role.run_order -eq "last") {
        $lastAgents += $agent
    }
    else {
        $parallelAgents += $agent
    }
}

# --- Helper: Run a single agent ---
function Invoke-Agent {
    param($Agent)

    $name = $Agent.Name
    $outputFile = $Agent.OutputFile

    # Skip if already done
    if (-not $Force -and (Test-Path $outputFile) -and (Get-Item $outputFile).Length -gt 1000) {
        Write-Host "  [--] $name (exists, skipping)" -ForegroundColor DarkGray
        return @{ Name = $name; Status = "skipped" }
    }

    Write-Host "  [>>] $name" -ForegroundColor Yellow

    $promptContent = Get-Content -Path $Agent.PromptFile -Raw -Encoding UTF8
    $fullPrompt = @"
$promptContent

IMPORTANT INSTRUCTIONS:
- Output the FULL report to STDOUT in markdown format.
- Do NOT use file write tools. Print everything to stdout.
- Do NOT ask for clarification. Analyze what you can and note assumptions.
- Be thorough and reference specific file paths and line numbers.
"@

    $tempPrompt = Join-Path $env:TEMP "claude_prompt_$name.txt"
    Set-Content -Path $tempPrompt -Value $fullPrompt -Encoding UTF8 -NoNewline

    try {
        $output = Get-Content -Path $tempPrompt -Raw | claude -p --output-format text 2>&1
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($outputFile, "# Report: $name`n`n$output", $utf8NoBom)
        $size = (Get-Item $outputFile).Length
        Write-Host "  [OK] $name (${size}B)" -ForegroundColor Green
        return @{ Name = $name; Status = "success"; Size = $size }
    }
    catch {
        Write-Host "  [!!] $name FAILED: $_" -ForegroundColor Red
        return @{ Name = $name; Status = "failed" }
    }
    finally {
        Remove-Item -Path $tempPrompt -ErrorAction SilentlyContinue
    }
}

# --- Phase 1: Run parallel agents ---
$startTime = Get-Date
$results = @()

if ($parallelAgents.Count -gt 0) {
    Write-Host "Phase 1: Parallel agents ($($parallelAgents.Count))" -ForegroundColor Cyan

    $jobs = @()
    foreach ($agent in $parallelAgents) {
        # Throttle
        while (($jobs | Where-Object { $_.State -eq 'Running' }).Count -ge $MaxParallel) {
            Start-Sleep -Milliseconds 500
        }

        $promptContent = Get-Content -Path $agent.PromptFile -Raw -Encoding UTF8
        $fullPrompt = @"
$promptContent

IMPORTANT INSTRUCTIONS:
- Output the FULL report to STDOUT in markdown format.
- Do NOT use file write tools. Print everything to stdout.
- Do NOT ask for clarification. Analyze what you can and note assumptions.
- Be thorough and reference specific file paths and line numbers.
"@
        $tempPrompt = Join-Path $env:TEMP "claude_prompt_$($agent.Name).txt"
        Set-Content -Path $tempPrompt -Value $fullPrompt -Encoding UTF8 -NoNewline

        $jobs += Start-Job -Name $agent.Name -ScriptBlock {
            param($tempPrompt, $outputFile, $agentName, $projectRoot)
            Set-Location $projectRoot
            $output = Get-Content -Path $tempPrompt -Raw | claude -p --output-format text 2>&1
            $utf8NoBom = New-Object System.Text.UTF8Encoding $false
            [System.IO.File]::WriteAllText($outputFile, "# Report: $agentName`n`n$output", $utf8NoBom)
            return @{ Name = $agentName; Size = (Get-Item $outputFile).Length; Status = "success" }
        } -ArgumentList $tempPrompt, $agent.OutputFile, $agent.Name, $projectRoot
    }

    $jobs | Wait-Job | Out-Null

    foreach ($job in $jobs) {
        if ($job.State -eq 'Completed') {
            $r = Receive-Job $job
            Write-Host "  [OK] $($job.Name) ($($r.Size)B)" -ForegroundColor Green
            $results += $r
        }
        else {
            Write-Host "  [!!] $($job.Name) FAILED" -ForegroundColor Red
            $results += @{ Name = $job.Name; Status = "failed" }
        }
        Remove-Job $job
    }

    Get-ChildItem "$env:TEMP\claude_prompt_*.txt" -ErrorAction SilentlyContinue | Remove-Item
}

# --- Phase 2: Run "last" agents sequentially (they depend on prior reports) ---
if ($lastAgents.Count -gt 0) {
    Write-Host "`nPhase 2: Sequential agents ($($lastAgents.Count))" -ForegroundColor Cyan

    foreach ($agent in $lastAgents) {
        $r = Invoke-Agent -Agent $agent
        $results += $r
        Start-Sleep -Seconds 3
    }
}

# --- Copy to latest ---
if (Test-Path $reportDir) {
    if (Test-Path $latestDir) { Remove-Item -Recurse -Force $latestDir }
    Copy-Item -Recurse -Path $reportDir -Destination $latestDir
}

# --- Summary ---
$totalTime = ((Get-Date) - $startTime).TotalSeconds
Write-Host "`n=== Squad '$Squad' Complete ($([Math]::Round($totalTime))s) ===" -ForegroundColor Cyan
$results | ForEach-Object {
    $icon = switch ($_.Status) { "success" { "[OK]" } "skipped" { "[--]" } "failed" { "[!!]" } default { "[??]" } }
    Write-Host "  $icon $($_.Name)" -ForegroundColor $(switch ($_.Status) { "success" { "Green" } "skipped" { "Gray" } "failed" { "Red" } default { "Yellow" } })
}
Write-Host "`nReports: $reportDir" -ForegroundColor Cyan
