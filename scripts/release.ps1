<#
.SYNOPSIS
  Build a release of SoqlForge and stage the artifacts that Advanced
  Installer needs to ingest.

.DESCRIPTION
  Workflow:
    1. Reads the version from src-tauri/tauri.conf.json (single source of
       truth - bump that file, everything else follows).
    2. Runs `npm run tauri build` (release Rust + Vite frontend bundle).
    3. Copies the produced soqlforge.exe + Tauri's NSIS/MSI bundles into
       a clean dist-release\<version>\ directory for hand-off.
    4. Prints the paths you'll point Advanced Installer at.

.PARAMETER Version
  Optional. Overrides the version from tauri.conf.json. If supplied, the
  script ALSO writes the new version back to tauri.conf.json so subsequent
  builds line up with the Advanced Installer ProductVersion.

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

# Bare executable - what you'd point Advanced Installer's "Files and Folders" at.
Copy-Item $exePath (Join-Path $stageRoot 'soqlforge.exe')

# Tauri's own NSIS + MSI artifacts (handy reference / fallback distribution
# while the AI project is still being authored).
if (Test-Path $nsisDir) {
  Copy-Item $nsisDir -Destination (Join-Path $stageRoot 'tauri-nsis') -Recurse
}
if (Test-Path $msiDir) {
  Copy-Item $msiDir -Destination (Join-Path $stageRoot 'tauri-msi') -Recurse
}

Write-Host ''
Write-Host "OK - Staged release in $stageRoot" -ForegroundColor Green
Write-Host ''
Write-Host 'Hand-off to Advanced Installer:' -ForegroundColor Cyan
Write-Host "  Exe:        $stageRoot\soqlforge.exe"
if (Test-Path (Join-Path $stageRoot 'tauri-nsis')) {
  Write-Host "  NSIS:       $stageRoot\tauri-nsis\"
}
if (Test-Path (Join-Path $stageRoot 'tauri-msi')) {
  Write-Host "  MSI:        $stageRoot\tauri-msi\"
}
Write-Host ''
Write-Host 'Next steps (see DEPLOYMENT.md for detail):'
Write-Host '  1. Open the SoqlForge.aip project in Advanced Installer'
Write-Host '  2. Project > Product Details > set Product Version to' $ver
Write-Host '  3. Files and Folders > Application Folder > refresh from'
Write-Host "       $stageRoot\soqlforge.exe"
Write-Host '  4. Build > produces SoqlForge-<ver>.msi'
Write-Host '  5. Upload MSI + regenerated updates.xml to internal host'
