<#
.SYNOPSIS
  Build a release of SoqlForge locally using Tauri's native bundler.

.DESCRIPTION
  Produces the same NSIS + MSI installers that the GitHub Actions release
  workflow ships — handy for a local test build or a manual one-off. For
  the signed, auto-update-capable release, push a `v*` tag and let
  .github/workflows/release.yml build it (see DEPLOYMENT.md).

  Workflow:
    1. Reads the version from src-tauri/tauri.conf.json (single source of
       truth - bump that file, everything else follows).
    2. Runs `npm run tauri build` (release Rust + Vite frontend bundle).
    3. Copies the produced NSIS + MSI installers into a clean
       dist-release\<version>\ directory.

  NOTE: a *local* build produces unsigned updater artifacts unless the
  TAURI_SIGNING_PRIVATE_KEY / _PASSWORD env vars are set. Unsigned builds
  install fine but won't be accepted by the auto-updater — that's what the
  CI release path is for.

.PARAMETER Version
  Optional. Overrides the version from tauri.conf.json. If supplied, the
  script ALSO writes the new version back to tauri.conf.json.

.PARAMETER SkipBuild
  Skip the cargo build (useful when you only want to re-stage the
  artifacts produced by a previous run).

.EXAMPLE
  pwsh scripts/release.ps1                  # use the version already in tauri.conf.json
  pwsh scripts/release.ps1 -Version 1.2.0   # bump and build
#>

[CmdletBinding()]
param(
  [string] $Version,
  [switch] $SkipBuild
)

# Don't set $ErrorActionPreference = 'Stop' globally — npm and cargo
# write status lines to stderr, and PS5.1 would treat each one as a fatal
# error. We catch native-command failures via $LASTEXITCODE checks instead.
$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Die($msg) {
  Write-Host "ERROR: $msg" -ForegroundColor Red
  exit 1
}

$confPath = Join-Path $repoRoot 'src-tauri\tauri.conf.json'
$confText = Get-Content $confPath -Raw -Encoding UTF8

if ($Version) {
  $current = if ($confText -match '"version"\s*:\s*"([^"]+)"') { $Matches[1] } else { 'unknown' }
  Write-Host "Bumping version: $current -> $Version" -ForegroundColor Cyan
  # Minimal in-place rewrite of the top-level "version": "..." line.
  # Reserializing via ConvertTo-Json reformats the whole file and PS5.1's
  # Set-Content -Encoding UTF8 adds a BOM that the Tauri build can't parse,
  # so we do a targeted regex replace and write back with the encoding the
  # file already had (UTF-8 *without* BOM).
  $newText = [regex]::Replace(
    $confText,
    '("version"\s*:\s*")[^"]+(")',
    "`${1}$Version`${2}",
    [System.Text.RegularExpressions.RegexOptions]::None,
    1  # only the first match (the top-level version)
  )
  [System.IO.File]::WriteAllText($confPath, $newText, (New-Object System.Text.UTF8Encoding $false))
  $confText = $newText
}
$ver = if ($confText -match '"version"\s*:\s*"([^"]+)"') { $Matches[1] } else { Die 'Could not parse version from tauri.conf.json' }
Write-Host "Building SoqlForge v$ver" -ForegroundColor Green

# Ensure cargo is on PATH (rustup default install puts it under ~/.cargo/bin)
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if ((Test-Path $cargoBin) -and ($env:Path -notmatch [regex]::Escape($cargoBin))) {
  $env:Path = "$cargoBin;$env:Path"
}

if (-not $SkipBuild) {
  Write-Host '-> npm run tauri build' -ForegroundColor Yellow
  # cmd /c wraps the command so PS doesn't choke on its stderr stream
  # (Tauri logs status updates via stderr and PS5.1 with default settings
  # treats every stderr line as a NativeCommandError).
  cmd /c "npm run tauri build"
  if ($LASTEXITCODE -ne 0) { Die "tauri build failed (exit $LASTEXITCODE)" }
}

$bundleRoot = Join-Path $repoRoot 'src-tauri\target\release'
$exePath    = Join-Path $bundleRoot 'soqlforge.exe'
$nsisDir    = Join-Path $bundleRoot 'bundle\nsis'
$msiDir     = Join-Path $bundleRoot 'bundle\msi'

if (-not (Test-Path $exePath)) {
  Die "Expected $exePath after build - did the build actually succeed?"
}

$stageRoot = Join-Path $repoRoot "dist-release\$ver"
if (Test-Path $stageRoot) { Remove-Item -Recurse -Force $stageRoot }
New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null

# Tauri's NSIS + MSI installers — the distributable artifacts.
if (Test-Path $nsisDir) {
  Copy-Item $nsisDir -Destination (Join-Path $stageRoot 'nsis') -Recurse
}
if (Test-Path $msiDir) {
  Copy-Item $msiDir -Destination (Join-Path $stageRoot 'msi') -Recurse
}

Write-Host ''
Write-Host "OK - Staged release in $stageRoot" -ForegroundColor Green
Write-Host ''
Write-Host 'Installers:' -ForegroundColor Cyan
if (Test-Path (Join-Path $stageRoot 'nsis')) {
  Write-Host "  NSIS (.exe):  $stageRoot\nsis\"
}
if (Test-Path (Join-Path $stageRoot 'msi')) {
  Write-Host "  MSI:          $stageRoot\msi\"
}
Write-Host ''
Write-Host 'This is a LOCAL build. For a signed, auto-updating release,'
Write-Host "push a tag instead:  git tag v$ver && git push origin v$ver"
Write-Host '(see DEPLOYMENT.md).'
