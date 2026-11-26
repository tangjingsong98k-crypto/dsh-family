# dsh-family-kit: portable Node.js fetcher.
# Deliberately pure ASCII: Windows PowerShell 5.1 decodes a BOM-less .ps1 with the
# system ANSI code page and would corrupt any non-ASCII byte.
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$root = Split-Path -Parent $PSScriptRoot
$version = '24.19.0'
$mirrorFile = Join-Path $root 'mirror.json'
if (Test-Path -LiteralPath $mirrorFile) {
  try {
    $cfg = (Get-Content -LiteralPath $mirrorFile -Raw -Encoding UTF8) | ConvertFrom-Json
    if ($cfg.dsh.nodeVersion) { $version = [string]$cfg.dsh.nodeVersion }
  } catch { }
}

$runtime = Join-Path $root 'runtime'
$dest = Join-Path $runtime 'node'
if (Test-Path -LiteralPath (Join-Path $dest 'node.exe')) {
  Write-Host ('[get-node] already present: ' + $dest)
  exit 0
}
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

$zip = Join-Path $env:TEMP ('node-v' + $version + '-win-x64.zip')
$urls = @(
  ('https://nodejs.org/dist/v' + $version + '/node-v' + $version + '-win-x64.zip'),
  ('https://npmmirror.com/mirrors/node/v' + $version + '/node-v' + $version + '-win-x64.zip')
)
$ok = $false
foreach ($url in $urls) {
  try {
    Write-Host ('[get-node] downloading ' + $url)
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 900
    $ok = $true
    break
  } catch {
    Write-Host ('[get-node] failed: ' + $_.Exception.Message)
  }
}
if (-not $ok) {
  Write-Host '[get-node] no download mirror reachable'
  exit 1
}

Write-Host '[get-node] extracting...'
Expand-Archive -LiteralPath $zip -DestinationPath $runtime -Force
$inner = Join-Path $runtime ('node-v' + $version + '-win-x64')
if (-not (Test-Path -LiteralPath (Join-Path $inner 'node.exe'))) {
  Write-Host '[get-node] unexpected archive layout'
  exit 1
}
Move-Item -LiteralPath $inner -Destination $dest
Write-Host ('[get-node] installed ' + $version + ' -> ' + $dest)
exit 0
