param([switch]$Force)

$ErrorActionPreference = 'Stop'
if (-not $Force) {
  $answer = Read-Host 'Remove the installed Native Host registration and code? (type YES)'
  if ($answer -ne 'YES') { throw 'Cancelled' }
}
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.whalestest.cc_batch'
if (Test-Path $registryPath) { Remove-Item $registryPath -Recurse -Force }
$installRoot = Join-Path $env:LOCALAPPDATA 'WhalestestCcBatch'
if (Test-Path $installRoot) { Remove-Item $installRoot -Recurse -Force }
Write-Output 'Native Host uninstalled. User output directories were not touched.'
