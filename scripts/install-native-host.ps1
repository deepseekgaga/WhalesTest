param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$installRoot = Join-Path $env:LOCALAPPDATA 'WhalestestCcBatch'
$hostRoot = Join-Path $installRoot 'native_host'
$manifestDirectory = Join-Path $installRoot 'manifest'
$manifestPath = Join-Path $manifestDirectory 'com.whalestest.cc_batch.json'
$installManifestPath = Join-Path $installRoot 'install-manifest.json'
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.whalestest.cc_batch'

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

New-Item -ItemType Directory -Force -Path $hostRoot, $manifestDirectory | Out-Null
$pythonPath = (Get-Command python -ErrorAction Stop).Source
$pythonVersion = [Version](& $pythonPath -c "import sys; print('.'.join(map(str, sys.version_info[:3])))")
if ($pythonVersion -lt [Version]'3.11') { throw "Python 3.11 or newer is required; found $pythonVersion" }

Copy-Item -Force (Join-Path $projectRoot 'native_host\__init__.py') $hostRoot
Copy-Item -Force (Join-Path $projectRoot 'native_host\host.py') $hostRoot
Copy-Item -Force (Join-Path $projectRoot 'native_host\config.json') $hostRoot
$packageRoot = Join-Path $hostRoot 'cc_batch'
New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null
Copy-Item -Force (Join-Path $projectRoot 'native_host\cc_batch\*.py') $packageRoot

$launcher = "@echo off`r`ncd /d `"%~dp0..`"`r`n`"$pythonPath`" -m native_host.host`r`n"
[System.IO.File]::WriteAllText((Join-Path $hostRoot 'host.cmd'), $launcher, [System.Text.UTF8Encoding]::new($false))

$hostPath = Join-Path $hostRoot 'host.cmd'
$packageSources = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'native_host\cc_batch') -Filter '*.py' | Sort-Object Name)
$installManifest = [ordered]@{
  name = 'com.whalestest.cc_batch'
  extension_id = $ExtensionId
  installed_utc = [DateTime]::UtcNow.ToString('o')
  registry_path = $registryPath
  manifest_path = $manifestPath
  files = [ordered]@{
    'native_host/__init__.py' = [ordered]@{
      source_sha256 = Get-FileSha256 (Join-Path $projectRoot 'native_host\__init__.py')
      installed_sha256 = Get-FileSha256 (Join-Path $hostRoot '__init__.py')
    }
    'native_host/host.py' = [ordered]@{
      source_sha256 = Get-FileSha256 (Join-Path $projectRoot 'native_host\host.py')
      installed_sha256 = Get-FileSha256 (Join-Path $hostRoot 'host.py')
    }
    'native_host/config.json' = [ordered]@{
      source_sha256 = Get-FileSha256 (Join-Path $projectRoot 'native_host\config.json')
      installed_sha256 = Get-FileSha256 (Join-Path $hostRoot 'config.json')
    }
  }
}
foreach ($sourceFile in $packageSources) {
  $relativePath = 'native_host/cc_batch/' + $sourceFile.Name
  $installManifest.files[$relativePath] = [ordered]@{
    source_sha256 = Get-FileSha256 $sourceFile.FullName
    installed_sha256 = Get-FileSha256 (Join-Path $packageRoot $sourceFile.Name)
  }
}
$installManifest.files['native_host/host.cmd'] = [ordered]@{
  installed_sha256 = Get-FileSha256 $hostPath
  python_path = $pythonPath
}
[System.IO.File]::WriteAllText($installManifestPath, ($installManifest | ConvertTo-Json -Depth 6), [System.Text.UTF8Encoding]::new($false))

$manifest = [ordered]@{
  name = 'com.whalestest.cc_batch'
  description = 'Authorized CC batch TXT processor'
  path = $hostPath
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifestJson = $manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, [System.Text.UTF8Encoding]::new($false))
$installManifest.files['manifest/com.whalestest.cc_batch.json'] = [ordered]@{
  installed_sha256 = Get-FileSha256 $manifestPath
}
[System.IO.File]::WriteAllText($installManifestPath, ($installManifest | ConvertTo-Json -Depth 6), [System.Text.UTF8Encoding]::new($false))

New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath
Write-Output "Installed Native Host: $manifestPath"
Write-Output "Extension origin: chrome-extension://$ExtensionId/"
