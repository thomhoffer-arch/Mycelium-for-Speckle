# ─────────────────────────────────────────────────────────────────────────────
# Mycelium-for-Speckle — one-command installer (Windows / PowerShell)
#
# One-liner (no clone needed):
#   irm https://raw.githubusercontent.com/thomhoffer-arch/Mycelium-for-Speckle/main/install.ps1 | iex
#
# Or, from a checkout:
#   ./install.ps1
#
# It will: ensure Node.js >= 18 (installing via winget if missing), fetch the
# project (or use the current checkout), install the `mycelium-for-speckle`
# command onto your PATH, verify with the offline conformance suite, and print
# next steps.
#
# Env knobs:
#   $env:MYCELIUM_DIR  install location when cloning (default: %USERPROFILE%\.mycelium-for-speckle)
#   $env:MYCELIUM_REF  git ref to install            (default: main)
# ─────────────────────────────────────────────────────────────────────────────
$ErrorActionPreference = 'Stop'

$RepoUrl    = 'https://github.com/thomhoffer-arch/Mycelium-for-Speckle.git'
$AppName    = 'mycelium-for-speckle'
$InstallDir = if ($env:MYCELIUM_DIR) { $env:MYCELIUM_DIR } else { Join-Path $HOME ".$AppName" }
$Ref        = if ($env:MYCELIUM_REF) { $env:MYCELIUM_REF } else { 'main' }
$MinNode    = 18

function Say  ($m) { Write-Host "> $m" -ForegroundColor Cyan }
function Ok   ($m) { Write-Host "[ok] $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "[!] $m"  -ForegroundColor Yellow }
function Die  ($m) { Write-Host "[x] $m"  -ForegroundColor Red; exit 1 }
function Have ($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

# ── 1. Node.js >= 18 ─────────────────────────────────────────────────────────
function Ensure-Node {
  if (Have node) {
    $major = (& node -v) -replace '^v(\d+)\..*','$1'
    if ([int]$major -ge $MinNode) { Ok "Node.js $(node -v) detected"; return }
    Warn "Node.js $(node -v) is too old (need >= $MinNode)."
  } else {
    Warn 'Node.js not found.'
  }
  if (Have winget) {
    Say 'Installing Node.js LTS via winget...'
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('Path','User')
    if (-not (Have node)) { Die 'Node.js installed but not on PATH — open a new terminal and re-run.' }
    Ok "Node.js $(node -v) ready"
  } else {
    Die "Install Node.js >= $MinNode from https://nodejs.org and re-run."
  }
}

# ── 2. Locate or fetch the project ───────────────────────────────────────────
function Locate-App {
  $candidates = @()
  if ($PSScriptRoot) { $candidates += $PSScriptRoot }
  $candidates += (Get-Location).Path
  foreach ($d in $candidates) {
    if ((Test-Path (Join-Path $d 'connector.mjs')) -and
        (Test-Path (Join-Path $d 'vendor\mycelium-sdk.mjs'))) {
      Ok "Using checkout at $d"; return $d
    }
  }
  Say "Fetching $AppName into $InstallDir..."
  if (-not (Have git)) { Die 'git is required to fetch the project (or run install.ps1 from a checkout).' }
  if (Test-Path (Join-Path $InstallDir '.git')) {
    git -C $InstallDir fetch --depth 1 origin $Ref | Out-Null
    git -C $InstallDir checkout -q FETCH_HEAD
  } else {
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    git clone --depth 1 --branch $Ref $RepoUrl $InstallDir 2>$null
    if ($LASTEXITCODE -ne 0) { git clone --depth 1 $RepoUrl $InstallDir }
  }
  Ok "Fetched into $InstallDir"
  return $InstallDir
}

# ── 3. Install onto PATH ─────────────────────────────────────────────────────
function Install-Cli ($AppDir) {
  Say "Installing the $AppName command..."
  Push-Location $AppDir
  try { npm link | Out-Null } catch { } finally { Pop-Location }
  if (Have $AppName) { Ok "Linked via npm ($((Get-Command $AppName).Source))"; return }

  Warn 'npm link unavailable — creating launcher scripts.'
  $binDir = Join-Path $env:LOCALAPPDATA "Programs\$AppName"
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  "@echo off`r`nnode `"$AppDir\connector.mjs`" %*"      | Set-Content -Encoding ASCII (Join-Path $binDir "$AppName.cmd")
  "@echo off`r`nnode `"$AppDir\src\webhook.mjs`" %*"    | Set-Content -Encoding ASCII (Join-Path $binDir "$AppName-webhook.cmd")
  Ok "Installed launchers in $binDir"

  $userPath = [System.Environment]::GetEnvironmentVariable('Path','User')
  if ($userPath -notlike "*$binDir*") {
    [System.Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
    $env:Path += ";$binDir"
    Warn "Added $binDir to your user PATH — open a new terminal for it to take effect."
  }
}

# ── 4. Verify ────────────────────────────────────────────────────────────────
function Verify ($AppDir) {
  Say 'Verifying (offline conformance suite)...'
  Push-Location $AppDir
  try { node --test | Out-Null; $okTests = $? } finally { Pop-Location }
  if ($okTests) { Ok 'All conformance checks pass' } else { Die "Conformance suite failed — run: npm test (in $AppDir)" }
}

Write-Host "Installing Mycelium-for-Speckle`n" -ForegroundColor White
Ensure-Node
$AppDir = Locate-App
Install-Cli $AppDir
Verify $AppDir

Write-Host "`nDone." -ForegroundColor Green
@"

Try it now (offline demo, no setup):
    $AppName
    $AppName --jsonl

Go live against your Speckle project:
    `$env:SPECKLE_SERVER     = 'https://app.speckle.systems'
    `$env:SPECKLE_TOKEN      = '<personal access token — scope: Streams read>'
    `$env:SPECKLE_PROJECT_ID = '<project (stream) id>'
    `$env:SPECKLE_MODEL_ID   = '<model (branch) id>'
    $AppName --out spine.json

Push-live webhook receiver (no polling):
    `$env:SPECKLE_WEBHOOK_SECRET = '<shared secret>'; $AppName-webhook

Help:  $AppName --help
"@ | Write-Host
