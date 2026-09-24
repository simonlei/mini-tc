<#
.SYNOPSIS
  Builds a Velopack release of the native Windows MiniTC.

.DESCRIPTION
  Produces an installer, a portable archive and the delta/full packages plus the
  `releases.win.json` feed that the in-app updater reads. Upload the whole
  output directory to the static host (the existing COS bucket, under the
  `win-native/` prefix that UpdateService points at).

.PARAMETER Version
  Semantic version for this release, e.g. 0.2.0.

.PARAMETER SelfContained
  Bundle the .NET runtime (~90 MB installer, no prerequisites). Without it the
  installer stays around 6 MB and Velopack installs the .NET 8 Desktop Runtime
  on demand.

.EXAMPLE
  ./build-release.ps1 -Version 0.2.0
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version,

  [switch]$SelfContained,

  [string]$Channel = 'win'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root 'src/MiniTC/MiniTC.csproj'
$publishDir = Join-Path $root 'artifacts/publish'
$releaseDir = Join-Path $root 'artifacts/releases'

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  $dotnetRoot = 'C:\Program Files\dotnet'
  if (Test-Path (Join-Path $dotnetRoot 'dotnet.exe')) {
    $env:PATH = "$dotnetRoot;$env:PATH"
  }
  else {
    throw 'dotnet SDK not found on PATH.'
  }
}

Write-Host "==> Restoring and testing" -ForegroundColor Cyan
dotnet test (Join-Path $root 'tests/MiniTC.Tests/MiniTC.Tests.csproj') --nologo -v q
if ($LASTEXITCODE -ne 0) { throw 'Unit tests failed; release aborted.' }

Write-Host "==> Publishing $Version" -ForegroundColor Cyan
if (Test-Path $publishDir) { Remove-Item $publishDir -Recurse -Force }

$publishArgs = @(
  'publish', $project,
  '-c', 'Release',
  '-r', 'win-x64',
  '-o', $publishDir,
  "-p:Version=$Version",
  "-p:AssemblyVersion=$Version.0",
  "-p:FileVersion=$Version.0",
  '-p:PublishReadyToRun=true',
  '--nologo'
)

# ReadyToRun precompiles our IL, which is what keeps cold start near 300 ms.
if ($SelfContained) {
  $publishArgs += '--self-contained'
}
else {
  $publishArgs += '--self-contained'
  $publishArgs += 'false'
}

dotnet @publishArgs
if ($LASTEXITCODE -ne 0) { throw 'Publish failed.' }

Write-Host "==> Ensuring vpk tool" -ForegroundColor Cyan
if (-not (Get-Command vpk -ErrorAction SilentlyContinue)) {
  dotnet tool install -g vpk
  $env:PATH = "$env:USERPROFILE\.dotnet\tools;$env:PATH"
}

Write-Host "==> Packing Velopack release" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

$packArgs = @(
  'pack',
  '--packId', 'MiniTC',
  '--packVersion', $Version,
  '--packDir', $publishDir,
  '--mainExe', 'MiniTC.exe',
  '--packTitle', 'MiniTC',
  '--packAuthors', 'MiniTC',
  '--outputDir', $releaseDir,
  '--channel', $Channel
)

$icon = Join-Path $root 'src/MiniTC/Assets/minitc.ico'
if (Test-Path $icon) { $packArgs += @('--icon', $icon) }

# Without --self-contained the installer must be able to bring the runtime in.
if (-not $SelfContained) {
  $packArgs += @('--framework', 'net8.0-x64-desktop')
}

vpk @packArgs
if ($LASTEXITCODE -ne 0) { throw 'vpk pack failed.' }

Write-Host ""
Write-Host "Release artifacts in $releaseDir" -ForegroundColor Green
Get-ChildItem $releaseDir | Select-Object Name, @{ n = 'Size'; e = { "{0:N1} MB" -f ($_.Length / 1MB) } } | Format-Table -AutoSize

Write-Host "Upload the contents of that folder to <cdn-base>/win-native/ to publish the update." -ForegroundColor Yellow
