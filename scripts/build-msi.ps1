<#
.SYNOPSIS
  Per-release build script. Drives the Tauri build + the Advanced
  Installer CLI to produce a new MSI and updates.xml manifest, all in
  one command.

.DESCRIPTION
  Prerequisites:
    - Advanced Installer Enterprise or Architect installed
    - installer/SoqlForge.aip created (see installer/README.md for the
      one-time GUI setup)
    - Optional: -Version to bump the app version in tauri.conf.json

  What this script does:
    1. Calls scripts/release.ps1 to build soqlforge.exe and stage it.
    2. Resolves AdvancedInstaller.com from PATH or the default install
       location.
    3. Updates the .aip's ProductVersion to match.
    4. Replaces the bundled soqlforge.exe with the freshly built one.
    5. Builds the MSI (output: installer/SoqlForge-SetupFiles/<ver>/).
    6. Generates the updates.xml manifest.
    7. Copies MSI + updates.xml into dist-release/<ver>/ for upload.

  Advanced Installer CLI reference:
    https://www.advancedinstaller.com/user-guide/command-line.html

.PARAMETER Version
  Optional. Bumps tauri.conf.json + the .aip's ProductVersion in lockstep.

.PARAMETER SkipTauriBuild
  Reuses an existing soqlforge.exe staged in dist-release/<ver>/. Useful
  for iterating on AI config alone.

.PARAMETER AdvinstPath
  Override the path to AdvancedInstaller.com (defaults to the standard
  install location + the PATH).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-msi.ps1
  powershell -ExecutionPolicy Bypass -File scripts\build-msi.ps1 -Version 0.2.0
#>

[CmdletBinding()]
param(
  [string] $Version,
  [switch] $SkipTauriBuild,
  [string] $AdvinstPath
)

# Don't die on every stderr write from native commands - we $LASTEXITCODE
# check explicitly after each call.
$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Die($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Run($exe, $arguments) {
  Write-Host "  > $exe $($arguments -join ' ')" -ForegroundColor DarkGray
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) {
    Die "$([System.IO.Path]::GetFileName($exe)) failed (exit $LASTEXITCODE)"
  }
}

# --- 1. Build the Tauri release (or reuse a previous one) --------------------
$releaseArgs = @('-File', "$repoRoot\scripts\release.ps1")
if ($Version)         { $releaseArgs += '-Version'; $releaseArgs += $Version }
if ($SkipTauriBuild)  { $releaseArgs += '-SkipBuild' }

if (-not $SkipTauriBuild) {
  Write-Host '== Tauri build =================================================' -ForegroundColor Cyan
  & powershell -ExecutionPolicy Bypass @releaseArgs
  if ($LASTEXITCODE -ne 0) { Die "Tauri release script failed (exit $LASTEXITCODE)" }
}

# Re-read the version from tauri.conf.json (release.ps1 may have written
# the bumped value back).
$conf = Get-Content "$repoRoot\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$ver  = $conf.version
$stageDir = Join-Path $repoRoot "dist-release\$ver"
$stagedExe = Join-Path $stageDir 'soqlforge.exe'
if (-not (Test-Path $stagedExe)) {
  Die "Expected $stagedExe - re-run without -SkipTauriBuild?"
}

# --- 2. Locate Advanced Installer CLI ---------------------------------------
# AI installs to "Caphyon\Advanced Installer\" OR "Caphyon\Advanced Installer
# <version>\" depending on whether a side-by-side install happened. Glob both.
$candidates = @()
if ($AdvinstPath) { $candidates += $AdvinstPath }
$roots = @("${env:ProgramFiles(x86)}", "${env:ProgramFiles}") | Where-Object { $_ }
foreach ($root in $roots) {
  $caphyon = Join-Path $root 'Caphyon'
  if (-not (Test-Path $caphyon)) { continue }
  Get-ChildItem -Path $caphyon -Directory -Filter 'Advanced Installer*' -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |  # newest version first
    ForEach-Object {
      $candidates += @(
        (Join-Path $_.FullName 'bin\x86\AdvancedInstaller.com'),
        (Join-Path $_.FullName 'bin\x64\AdvancedInstaller.com')
      )
    }
}
$advinst = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $advinst) {
  $onPath = Get-Command AdvancedInstaller.com -ErrorAction SilentlyContinue
  if ($onPath) { $advinst = $onPath.Source }
}
if (-not $advinst) {
  Die @"
AdvancedInstaller.com not found. Pass -AdvinstPath, or install Advanced
Installer Enterprise/Architect, or add its bin\ folder to PATH.
Looked in:
  $($candidates -join "`n  ")
"@
}
Write-Host "Using $advinst" -ForegroundColor DarkGray

# --- 3. Verify the .aip exists ---------------------------------------------
# Look at repo root first (where the GUI's "New Project" defaults dropped it),
# then fall back to installer\ if someone moved it.
$aipCandidates = @(
  (Join-Path $repoRoot 'SoqlForge.aip'),
  (Join-Path $repoRoot 'installer\SoqlForge.aip')
)
$aipPath = $aipCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $aipPath) {
  Die @"
SoqlForge.aip not found. Looked in:
  $($aipCandidates -join "`n  ")
Follow installer\README.md for the one-time Advanced Installer GUI setup,
then re-run this script.
"@
}
Write-Host "Using project: $aipPath" -ForegroundColor DarkGray

# --- 4. Drive the AI CLI ----------------------------------------------------
# Pattern: AdvancedInstaller.com /edit <project> /<command> [args] - each
# call commits the change to the .aip on disk.
Write-Host '' ; Write-Host '== Advanced Installer ==========================================' -ForegroundColor Cyan

# Bump the ProductVersion to match tauri.conf.json. AI auto-regenerates
# the ProductCode (per-build GUID) when SetVersion changes it; keep the
# UpgradeCode fixed (it's set in the GUI; don't touch).
Write-Host "Setting ProductVersion = $ver"
Run $advinst @('/edit', $aipPath, '/SetVersion', $ver)

# Refresh the staged exe inside the project's Application Folder. AI's
# /UpdateFile takes the destination path inside the install dir + the
# source path on disk. The destination "soqlforge.exe" assumes you added the
# file at the root of Application Folder per installer/README.md step 4.
Write-Host "Refreshing soqlforge.exe from $stagedExe"
Run $advinst @('/edit', $aipPath, '/UpdateFile', 'APPDIR\soqlforge.exe', $stagedExe)

# Build the MSI. Output path is whatever you set in Builds > DefaultBuild;
# the script reads it back from the .aip to find the produced file.
Write-Host 'Building MSI'
Run $advinst @('/build', $aipPath)

# Locate the produced MSI. AI defaults output to <aip-dir>\SoqlForge-SetupFiles\.
# Search next to the .aip first, then under installer\ as a fallback.
$aipDir = Split-Path -Parent $aipPath
$msiSearchRoots = @($aipDir, (Join-Path $repoRoot 'installer')) | Select-Object -Unique | Where-Object { Test-Path $_ }
$msi = $msiSearchRoots | ForEach-Object {
  Get-ChildItem -Path $_ -Recurse -Filter 'SoqlForge*.msi' -ErrorAction SilentlyContinue
} | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $msi) { Die "No MSI found under $($msiSearchRoots -join ', ') after build - check AI output path." }
Write-Host "Built $($msi.FullName)" -ForegroundColor Green

# Generate updates.xml. AI's /BuildUpdatesFile flag emits the manifest to
# wherever the Updater page's "Updates file" path points (we recommend
# ..\dist-release\updates.xml in installer/README.md). The Updater feature
# is Enterprise-tier only; if the project is Professional this fails with
# "The updater could not be found in your project." Treat as a soft warn.
Write-Host 'Generating updates.xml (skips if Updater not enabled)'
Write-Host "  > $advinst /edit $aipPath /BuildUpdatesFile" -ForegroundColor DarkGray
& $advinst /edit $aipPath /BuildUpdatesFile
if ($LASTEXITCODE -ne 0) {
  Write-Host '  Updater not configured (Enterprise tier required). MSI built; skipping updates.xml.' -ForegroundColor Yellow
}

# --- 5. Stage final artifacts for upload -----------------------------------
# Rename to SoqlForge-<ver>.msi on stage so multiple versions can coexist on
# the upload share without overwriting each other.
$msiTargetName = "SoqlForge-$ver.msi"
$msiTarget = Join-Path $stageDir $msiTargetName
Copy-Item $msi.FullName $msiTarget -Force
Write-Host "Staged MSI: $msiTarget" -ForegroundColor Green

$updatesSrc = Join-Path $repoRoot 'dist-release\updates.xml'
if (Test-Path $updatesSrc) {
  $updatesTarget = Join-Path $stageDir 'updates.xml'
  Copy-Item $updatesSrc $updatesTarget -Force
  Write-Host "Staged updates.xml: $updatesTarget" -ForegroundColor Green
} else {
  Write-Host 'updates.xml not produced - check the Updater "Updates file" path in the .aip points to ..\dist-release\updates.xml' -ForegroundColor Yellow
}

Write-Host ''
Write-Host "DONE. Upload these to your internal host:" -ForegroundColor Cyan
Write-Host "  $msiTarget"
if (Test-Path "$stageDir\updates.xml") {
  Write-Host "  $stageDir\updates.xml"
}
Write-Host ''
Write-Host 'Suggested:'
Write-Host "  robocopy $stageDir \\fileserver\soqlforge SoqlForge-$ver.msi updates.xml /Z"
