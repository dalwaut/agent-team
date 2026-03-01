# ============================================================
# Pre-flight Checks for Agent Team
# ============================================================
# Validates environment before running agents.
# Exit code 0 = all good, 1 = something is wrong.
# ============================================================

$errors = @()

Write-Host "`n  Pre-flight checks..." -ForegroundColor DarkGray

# 1. Claude CLI available
try {
    $null = Get-Command claude -ErrorAction Stop
    Write-Host "    [OK] claude CLI found" -ForegroundColor DarkGray
}
catch {
    $errors += "claude CLI not found in PATH"
    Write-Host "    [!!] claude CLI not found" -ForegroundColor Red
}

# 2. Prompt files exist and are non-empty
$scriptDir = $PSScriptRoot
$prompts = Get-ChildItem -Path "$scriptDir\prompt_*.txt" -ErrorAction SilentlyContinue

if ($prompts.Count -eq 0) {
    $errors += "No prompt_*.txt files found in $scriptDir"
    Write-Host "    [!!] No prompt files found" -ForegroundColor Red
}
else {
    $emptyPrompts = $prompts | Where-Object { $_.Length -lt 10 }
    if ($emptyPrompts.Count -gt 0) {
        $names = ($emptyPrompts | ForEach-Object { $_.Name }) -join ", "
        $errors += "Empty prompt files: $names"
        Write-Host "    [!!] Empty prompts: $names" -ForegroundColor Red
    }
    else {
        Write-Host "    [OK] $($prompts.Count) prompt files found" -ForegroundColor DarkGray
    }
}

# 3. Reports directory writable
$reportDir = Join-Path (Split-Path -Parent $scriptDir) "reports"
if (-not (Test-Path $reportDir)) {
    try {
        New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
        Write-Host "    [OK] Created reports directory" -ForegroundColor DarkGray
    }
    catch {
        $errors += "Cannot create reports directory: $reportDir"
        Write-Host "    [!!] Cannot create reports dir" -ForegroundColor Red
    }
}
else {
    Write-Host "    [OK] Reports directory exists" -ForegroundColor DarkGray
}

# 4. Project root has expected structure
# Framework-mode: if team.json exists one level up (scripts/ lives directly in the framework root),
# then this IS the framework source and the root is one level up, not two.
$agentDir = Split-Path -Parent $scriptDir
$frameworkMode = Test-Path (Join-Path $agentDir "team.json")

if ($frameworkMode) {
    $projectRoot = $agentDir
    $expectedFiles = @("CLAUDE.md", "team.json")
    Write-Host "    [OK] Framework-mode detected (root: $projectRoot)" -ForegroundColor DarkGray
}
else {
    $projectRoot = Split-Path -Parent $agentDir
    $expectedFiles = @("app.json", "package.json", "CLAUDE.md")
}

foreach ($f in $expectedFiles) {
    if (-not (Test-Path (Join-Path $projectRoot $f))) {
        $errors += "Expected project file missing: $f"
        Write-Host "    [!!] Missing: $f" -ForegroundColor Red
    }
}
if ($errors.Count -eq 0 -or ($errors | Where-Object { $_ -match "Expected project" }).Count -eq 0) {
    Write-Host "    [OK] Project structure valid" -ForegroundColor DarkGray
}

# --- Result ---
if ($errors.Count -gt 0) {
    Write-Host "`n  Pre-flight FAILED ($($errors.Count) issues)" -ForegroundColor Red
    exit 1
}
else {
    Write-Host "    All checks passed.`n" -ForegroundColor DarkGray
    exit 0
}
