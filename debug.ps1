param([switch]$Test)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Node.js is required. Install Node.js 20 or newer, or add node.exe to PATH.' }
if ($Test) { & $nodeCommand.Source (Join-Path $projectRoot 'scripts/debug.js') --test }
else { & $nodeCommand.Source (Join-Path $projectRoot 'scripts/debug.js') }
exit $LASTEXITCODE
