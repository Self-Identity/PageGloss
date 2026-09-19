# PageGloss - Windows deploy fallback used by deploy.bat when bash is absent.
# Verifies the extension, runs the tests, packs a zip and stages a loadable
# unpacked extension directory.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\deploy.ps1 [--no-tests]
#
# Environment:
#   DEPLOY_TARGET   directory that receives the packaged extension
#                   (default: <repo>\build\pagegloss)

[CmdletBinding()]
param(
  [switch]$NoTests,
  [switch]$NoPause,
  [switch]$Install
)

$ErrorActionPreference = 'Stop'

function Write-Log([string]$Message) {
  Write-Host "[deploy] $Message"
}

function Fail([string]$Message) {
  Write-Host "[deploy] ERROR: $Message" -ForegroundColor Red
  exit 1
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = (Resolve-Path (Join-Path $scriptDir '..')).Path
Set-Location $rootDir

Write-Log 'checking node toolchain'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail 'node is required to verify and pack the extension'
}
$nodeVersion = (& node --version).Trim()
Write-Log "node $nodeVersion"

if (-not (Test-Path (Join-Path $rootDir 'manifest.json'))) {
  Fail "manifest.json not found in $rootDir"
}

Write-Log 'validating manifest, locales, icons and layout rules'
& node 'tools/check.js'
if ($LASTEXITCODE -ne 0) { Fail 'static validation failed' }

if (-not $NoTests) {
  Write-Log 'running the matcher test suite'
  & node 'tests/matcher.test.js'
  if ($LASTEXITCODE -ne 0) { Fail 'matcher test suite failed' }
  Write-Log 'running the content script integration tests'
  & node 'tests/integration.test.js'
  if ($LASTEXITCODE -ne 0) { Fail 'integration tests failed' }
  Write-Log 'running the service worker pipeline tests'
  & node 'tests/service-worker.test.js'
  if ($LASTEXITCODE -ne 0) { Fail 'service worker tests failed' }
  Write-Log 'running the ES module smoke test'
  & node 'tests/esm.test.js'
  if ($LASTEXITCODE -ne 0) { Fail 'ESM smoke test failed' }
  Write-Log 'running the content script load tests'
  & node 'tests/content-load.test.js'
  if ($LASTEXITCODE -ne 0) { Fail 'content script load tests failed' }
} else {
  Write-Log 'skipping the test suite'
}

Write-Log 'building the release zip'
& node 'tools/package.js'
if ($LASTEXITCODE -ne 0) { Fail 'packaging failed' }

$manifest = Get-Content (Join-Path $rootDir 'manifest.json') -Raw | ConvertFrom-Json
$version = $manifest.version
$zipPath = Join-Path $rootDir "build/pagegloss-$version.zip"
if (-not (Test-Path $zipPath)) {
  Fail "expected archive was not created: $zipPath"
}

$targetDir = $env:DEPLOY_TARGET
if ([string]::IsNullOrWhiteSpace($targetDir)) {
  $targetDir = Join-Path $rootDir 'build/pagegloss'
}

Write-Log "staging the unpacked extension into $targetDir"
if (Test-Path $targetDir) {
  Remove-Item $targetDir -Recurse -Force
}
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null

foreach ($item in @('manifest.json', 'src', 'icons', '_locales', 'docs')) {
  $source = Join-Path $rootDir $item
  if (-not (Test-Path $source)) { Fail "missing runtime path: $item" }
  Copy-Item $source -Destination $targetDir -Recurse -Force
}

if (-not (Test-Path (Join-Path $targetDir 'manifest.json'))) {
  Fail 'staged directory has no manifest.json'
}

$count = (Get-ChildItem $targetDir -Recurse -File | Measure-Object).Count
Write-Log "staged $count file(s)"
Write-Log "archive: $zipPath"
Write-Log "unpacked extension: $targetDir"
Write-Log "next: open chrome://extensions, enable Developer mode, choose Load unpacked and pick $targetDir"
Write-Log 'done'

# Keep the console open when the script was launched by double click, so the
# summary is readable instead of the window closing immediately.
$interactiveHost = $false
try {
  if ([Environment]::UserInteractive -and $Host.Name -eq 'ConsoleHost' -and -not $Host.UI.IsRunspace) {
    $interactiveHost = $true
  }
} catch {
  $interactiveHost = $false
}

if ($interactiveHost -and -not $NoPause -and -not $env:DEPLOY_NO_PAUSE) {
  Write-Host ''
  Read-Host '[deploy] press Enter to close this window' | Out-Null
}
