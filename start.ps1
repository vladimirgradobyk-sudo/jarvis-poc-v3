# JARVIS PoC launcher.
#
# Order is deliberate: validate configuration BEFORE starting the server, because the server
# refuses to start on invalid configuration anyway (CAP-ADMIN-01) and failing here gives a
# better message.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host ''
Write-Host '  JARVIS — proof of concept' -ForegroundColor White
Write-Host ''

# ── Node version ────────────────────────────────────────────────────────────────────────────
$nodeVersion = (& node --version) -replace '^v',''
$major = [int]($nodeVersion -split '\.')[0]
if ($major -lt 22) {
  Write-Host "  Node $nodeVersion found; 22 or later is required (node:sqlite)." -ForegroundColor Red
  exit 1
}
Write-Host "  node           $nodeVersion"

# ── Configuration ───────────────────────────────────────────────────────────────────────────
Write-Host '  validating configuration…'
& node scripts/config-validate.js | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  & node scripts/config-validate.js
  exit 1
}
Write-Host '  configuration  valid' -ForegroundColor Green

# ── Transport ───────────────────────────────────────────────────────────────────────────────
if (-not $env:JARVIS_MODEL_TRANSPORT) { $env:JARVIS_MODEL_TRANSPORT = 'fixture' }
if ($env:JARVIS_MODEL_TRANSPORT -eq 'bedrock') {
  Write-Host '  transport      bedrock — REAL MODEL CALLS WILL BE BILLED' -ForegroundColor Yellow
  if (-not $env:AWS_ACCESS_KEY_ID) {
    Write-Host '  AWS_ACCESS_KEY_ID is not set. Export credentials, or unset JARVIS_MODEL_TRANSPORT to use the fixture transport.' -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host '  transport      fixture — deterministic, no model calls, no cost' -ForegroundColor Green
}

Write-Host ''
Write-Host '  Starting. Open http://127.0.0.1:7701' -ForegroundColor Cyan
Write-Host ''

& node server/index.js
