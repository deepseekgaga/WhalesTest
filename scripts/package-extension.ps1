param(
  [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist')
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceDirectory = Join-Path $projectRoot 'extension'
$packageName = 'cc-batch-chrome-extension-v0.1.0'
$stagingDirectory = Join-Path $OutputDirectory $packageName
$zipPath = Join-Path $OutputDirectory ($packageName + '.zip')

$requiredFiles = @(
  'manifest.json',
  'background.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'totp-controller.js',
  'totp-page.js',
  'totp-lab-controller.js',
  'totp-lab-page.js'
)

if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) {
  throw "Extension source directory not found: $sourceDirectory"
}

foreach ($relativePath in $requiredFiles) {
  $sourcePath = Join-Path $sourceDirectory $relativePath
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "Required extension file not found: $relativePath"
  }
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
if (Test-Path -LiteralPath $stagingDirectory) {
  Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
New-Item -ItemType Directory -Force -Path $stagingDirectory | Out-Null

foreach ($relativePath in $requiredFiles) {
  Copy-Item -LiteralPath (Join-Path $sourceDirectory $relativePath) -Destination (Join-Path $stagingDirectory $relativePath)
}

Compress-Archive -LiteralPath $stagingDirectory -DestinationPath $zipPath -CompressionLevel Optimal
$manifestJson = [System.IO.File]::ReadAllText((Join-Path $stagingDirectory 'manifest.json'), [System.Text.Encoding]::UTF8)
$manifest = $manifestJson | ConvertFrom-Json
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()

Write-Output "Package directory: $stagingDirectory"
Write-Output "Package ZIP: $zipPath"
Write-Output "Manifest version: $($manifest.version)"
Write-Output "ZIP SHA256: $hash"
