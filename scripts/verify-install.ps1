param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$installRoot = Join-Path $env:LOCALAPPDATA 'WhalestestCcBatch'
$manifestPath = Join-Path $installRoot 'manifest\com.whalestest.cc_batch.json'
$installManifestPath = Join-Path $installRoot 'install-manifest.json'
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.whalestest.cc_batch'

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Test-InstalledSourceTree {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][object]$Manifest
  )

  $expectedFiles = @(
    'native_host/__init__.py',
    'native_host/host.py',
    'native_host/config.json'
  )
  $expectedFiles += Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'native_host\cc_batch') -Filter '*.py' | Sort-Object Name | ForEach-Object {
    'native_host/cc_batch/' + $_.Name
  }

  foreach ($relativePath in $expectedFiles) {
    $entry = $Manifest.files.PSObject.Properties[$relativePath].Value
    if (-not $entry) {
      return $false
    }
    $sourcePath = Join-Path $ProjectRoot ($relativePath -replace '/', '\')
    $installedPath = Join-Path $InstallRoot ($relativePath -replace '/', '\')
    if (-not (Test-Path $sourcePath) -or -not (Test-Path $installedPath)) {
      return $false
    }
    $sourceHash = Get-FileSha256 $sourcePath
    $installedHash = Get-FileSha256 $installedPath
    if ($entry.source_sha256 -ne $sourceHash -or $entry.installed_sha256 -ne $installedHash -or $sourceHash -ne $installedHash) {
      return $false
    }
  }

  return $true
}

function Read-Exact {
  param(
    [Parameter(Mandatory = $true)][System.IO.Stream]$Stream,
    [Parameter(Mandatory = $true)][int]$Count
  )

  $buffer = New-Object byte[] $Count
  $offset = 0
  while ($offset -lt $Count) {
    $read = $Stream.Read($buffer, $offset, $Count - $offset)
    if ($read -le 0) { break }
    $offset += $read
  }
  if ($offset -ne $Count) {
    throw "short_read"
  }
  return $buffer
}

function Invoke-NativeMessagingPing {
  param(
    [Parameter(Mandatory = $true)][string]$LauncherPath,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $env:ComSpec
  $startInfo.Arguments = '/d /s /c "' + $LauncherPath + '"'
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true

  $process = [System.Diagnostics.Process]::Start($startInfo)
  try {
    $requestBytes = [System.Text.Encoding]::UTF8.GetBytes('{"command":"ping","request_id":"verify-install"}')
    $prefixBytes = [BitConverter]::GetBytes([uint32]$requestBytes.Length)
    $process.StandardInput.BaseStream.Write($prefixBytes, 0, $prefixBytes.Length)
    $process.StandardInput.BaseStream.Write($requestBytes, 0, $requestBytes.Length)
    $process.StandardInput.Close()
    $process.WaitForExit()

    $stderr = $process.StandardError.ReadToEnd()
    if ($process.ExitCode -ne 0) {
      throw "native_exit_$($process.ExitCode):$stderr"
    }

    $stdoutStream = $process.StandardOutput.BaseStream
    $header = Read-Exact -Stream $stdoutStream -Count 4
    $size = [BitConverter]::ToUInt32($header, 0)
    if ($size -gt 0x800000) {
      throw 'response_too_large'
    }
    $body = Read-Exact -Stream $stdoutStream -Count ([int]$size)
    $response = [System.Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
    return $response
  }
  finally {
    $process.Dispose()
  }
}

$checks = New-Object System.Collections.Generic.List[object]
$checks.Add([ordered]@{ Name = 'Install manifest'; Pass = (Test-Path $installManifestPath) })
$installManifest = $null
if (Test-Path $installManifestPath) {
  try { $installManifest = Get-Content -Raw $installManifestPath | ConvertFrom-Json } catch { $installManifest = $null }
}
$manifestValid = $false
if ((Test-Path $manifestPath) -and $null -ne $installManifest) {
  try {
    $manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
    $canonicalHostPath = [System.IO.Path]::GetFullPath((Join-Path $installRoot 'native_host\host.cmd'))
    $manifestHostPath = [System.IO.Path]::GetFullPath([string]$manifest.path)
    $manifestHash = Get-FileSha256 $manifestPath
    $manifestEntry = $installManifest.files.PSObject.Properties['manifest/com.whalestest.cc_batch.json'].Value
    $manifestValid = (
      $manifest.name -eq 'com.whalestest.cc_batch' -and
      $manifest.type -eq 'stdio' -and
      $manifestHostPath -eq $canonicalHostPath -and
      @($manifest.allowed_origins).Count -eq 1 -and
      $manifest.allowed_origins[0] -eq "chrome-extension://$($installManifest.extension_id)/" -and
      $manifestEntry.installed_sha256 -eq $manifestHash
    )
  } catch {
    $manifestValid = $false
  }
}
$checks.Add([ordered]@{ Name = 'Host manifest'; Pass = $manifestValid })

if ((Test-Path $installManifestPath) -and (Test-Path (Join-Path $installRoot 'native_host\host.cmd'))) {
  $checks.Add([ordered]@{ Name = 'Installed host'; Pass = (Test-InstalledSourceTree -ProjectRoot $projectRoot -InstallRoot $installRoot -Manifest $installManifest) })
  $launcherHash = Get-FileSha256 (Join-Path $installRoot 'native_host\host.cmd')
  $launcherEntry = $installManifest.files.PSObject.Properties['native_host/host.cmd'].Value
  $launcherPass = ($launcherEntry.installed_sha256 -eq $launcherHash)
  $checks.Add([ordered]@{ Name = 'Launcher hash'; Pass = $launcherPass })
} else {
  $checks.Add([ordered]@{ Name = 'Installed host'; Pass = $false })
  $checks.Add([ordered]@{ Name = 'Launcher hash'; Pass = $false })
}

if (Test-Path $manifestPath) {
  $checks.Add([ordered]@{ Name = 'Allowed origin'; Pass = ($manifestValid -and $manifest.allowed_origins -contains "chrome-extension://$ExtensionId/") })
} else { $checks.Add([ordered]@{ Name = 'Allowed origin'; Pass = $false }) }

if (Test-Path $registryPath) {
  $registeredManifest = (Get-Item $registryPath).GetValue('')
  $checks.Add([ordered]@{ Name = 'Registry manifest path'; Pass = ($registeredManifest -eq $manifestPath) })
  $checks.Add([ordered]@{ Name = 'Registry registration'; Pass = $true })
} else {
  $checks.Add([ordered]@{ Name = 'Registry manifest path'; Pass = $false })
  $checks.Add([ordered]@{ Name = 'Registry registration'; Pass = $false })
}

if ($manifestValid) {
  try {
    $ping = Invoke-NativeMessagingPing -LauncherPath ([string]$manifest.path) -WorkingDirectory $installRoot
    $checks.Add([ordered]@{ Name = 'Native Messaging ping'; Pass = ($ping.ok -eq $true -and $ping.command -eq 'ping') })
  } catch {
    $checks.Add([ordered]@{ Name = 'Native Messaging ping'; Pass = $false })
  }
} else {
  $checks.Add([ordered]@{ Name = 'Native Messaging ping'; Pass = $false })
}

$checks | ForEach-Object { Write-Output ("{0}: {1}" -f $_.Name, $(if ($_.Pass) { 'PASS' } else { 'FAIL' })) }
if ((@($checks | ForEach-Object { $_.Pass }) -contains $false) -or ($checks.Count -eq 0)) { exit 1 }
