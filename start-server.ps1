Set-Location -LiteralPath $PSScriptRoot

$serverControl = Join-Path $PSScriptRoot "scripts\server-control.cjs"
$nodeExe = Join-Path ${env:ProgramFiles} "nodejs\node.exe"

if (-not (Test-Path -LiteralPath $serverControl)) {
  Write-Error "Missing server control script: scripts/server-control.cjs"
  exit 1
}

if (-not (Test-Path -LiteralPath $nodeExe)) {
  Write-Error "Missing Node.js runtime: $nodeExe"
  exit 1
}

& $nodeExe $serverControl start

if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to start the server control script."
  exit 1
}
