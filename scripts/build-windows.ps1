# Build a self-contained Windows .exe installer for Mycelium-for-Speckle.
# Runs on Windows only (needs Inno Setup's iscc). Used by CI on a windows-latest
# runner; embeds its own Node runtime so the end user needs nothing installed.
#
#   pwsh scripts/build-windows.ps1     # -> dist\Mycelium-for-Speckle-<ver>-windows-setup.exe
#
# Env: NODE_VERSION (default v24.17.0).
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$Root = (Get-Location).Path

$NodeVersion = if ($env:NODE_VERSION) { $env:NODE_VERSION } else { 'v24.17.0' }
$AppName = 'mycelium-for-speckle'
$Version = (node -p 'require("./package.json").version')
$Build   = Join-Path $Root '.build\windows'
$AppDir  = Join-Path $Build 'app'
$Dist    = Join-Path $Root 'dist'

Write-Host "> Building $AppName $Version (Windows x64, Node $NodeVersion)"
if (Test-Path $Build) { Remove-Item -Recurse -Force $Build }
New-Item -ItemType Directory -Force -Path $Build, $Dist | Out-Null

# 1. App files
node "$Root\scripts\stage-app.mjs" $AppDir

# 2. Embedded Node runtime (node.exe next to the app)
$nodeZip = Join-Path $Build 'node.zip'
$nodeUrl = "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip"
Write-Host "  v node $NodeVersion win-x64"
Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip
Expand-Archive -Path $nodeZip -DestinationPath $Build -Force
Copy-Item (Join-Path $Build "node-$NodeVersion-win-x64\node.exe") (Join-Path $AppDir 'node.exe')

# 3. Launchers (.cmd) — {app} is added to PATH by the installer
@"
@echo off
"%~dp0node.exe" "%~dp0connector.mjs" %*
"@ | Set-Content -Encoding ASCII (Join-Path $AppDir "$AppName.cmd")
@"
@echo off
"%~dp0node.exe" "%~dp0src\webhook.mjs" %*
"@ | Set-Content -Encoding ASCII (Join-Path $AppDir "$AppName-webhook.cmd")

# 4. Locate Inno Setup compiler
$iscc = Get-Command iscc.exe -ErrorAction SilentlyContinue
if (-not $iscc) {
  foreach ($p in @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles}\Inno Setup 6\ISCC.exe")) {
    if (Test-Path $p) { $iscc = $p; break }
  }
} else { $iscc = $iscc.Source }
if (-not $iscc) { throw 'Inno Setup (iscc.exe) not found. Install it (choco install innosetup).' }

# 5. Compile
$outBase = "Mycelium-for-Speckle-$Version-windows-setup"
& $iscc `
  "/DMyAppVersion=$Version" `
  "/DSourceDir=$AppDir" `
  "/DOutputDir=$Dist" `
  "/DOutputBase=$outBase" `
  "$Root\installer\windows\mycelium.iss"
if ($LASTEXITCODE -ne 0) { throw "iscc failed ($LASTEXITCODE)" }

$out = Join-Path $Dist "$outBase.exe"
Write-Host "[ok] $out"
Get-Item $out | Format-List Name, Length
