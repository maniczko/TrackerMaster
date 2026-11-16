<#
.SYNOPSIS
  Non-destructive Windows process smoke for the unsigned TrackerMaster build.
.DESCRIPTION
  Probes real process startup, first-run SQLite creation, clean data-file header
  and restart on the same isolated test database. It does not validate GUI
  controls, signing, backup/restore UI or resume from actual system sleep.
  Intended for a GitHub-hosted Windows runner. Changes APPDATA and LOCALAPPDATA
  only in this PowerShell process and its children.
#>
[CmdletBinding()]
param(
  [string]$Executable = 'src-tauri/target/release/tracker-master.exe',
  [int]$StartupSeconds = 20
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') {
  throw 'This process probe is restricted to disposable GitHub-hosted runners. Do not run it against a real user profile.'
}
$exe = (Resolve-Path -LiteralPath $Executable).Path
$originalAppData = $env:APPDATA
$originalLocalAppData = $env:LOCALAPPDATA
$nativeAppData = Join-Path $originalAppData 'pl.tracker.personal'
if (Test-Path -LiteralPath $nativeAppData) {
  throw 'The runner already contains TrackerMaster data. Refusing to touch an existing profile.'
}
$root = Join-Path ([IO.Path]::GetTempPath()) ("trackermaster-smoke-{0}-{1}" -f $PID, [guid]::NewGuid().ToString('N'))
$process = $null
$pass = $false

function Stop-TrackerProcess {
  if ($null -eq $script:process) { return }
  try {
    $script:process.Refresh()
    if (-not $script:process.HasExited) {
      Stop-Process -Id $script:process.Id -Force -ErrorAction Stop
      $script:process.WaitForExit(10000) | Out-Null
    }
  } finally {
    $script:process.Dispose()
    $script:process = $null
  }
}
function Start-And-Probe([string]$label) {
  $script:process = Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) -PassThru
  Write-Host "${label}: launched PID=$($script:process.Id)"
  $database = $null
  for ($i = 0; $i -lt $StartupSeconds; $i++) {
    Start-Sleep -Seconds 1
    $script:process.Refresh()
    if ($script:process.HasExited) {
      throw "${label}: application exited during startup (exit code $($script:process.ExitCode)); GUI session or WebView2 may be unavailable."
    }
    # On Windows, Tauri may use SHGetKnownFolderPath and ignore APPDATA overrides.
    # Both locations are inside this disposable CI runner, and the native
    # profile is verified nonexistent before the process is launched.
    $dbs = @(
      foreach ($searchRoot in @($root, $nativeAppData)) {
        if (Test-Path -LiteralPath $searchRoot) {
          Get-ChildItem -LiteralPath $searchRoot -Recurse -File -Filter 'tracker.sqlite3' -ErrorAction SilentlyContinue
        }
      }
    )
    if ($dbs.Count -eq 1) { $database = $dbs[0].FullName; break }
    if ($dbs.Count -gt 1) { throw "${label}: unexpectedly created multiple databases." }
  }
  if ($null -eq $database) {
    throw "${label}: no tracker.sqlite3 was created within $StartupSeconds seconds."
  }
  $file = [IO.File]::Open($database, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    $bytes = New-Object byte[] 16
    if ($file.Read($bytes, 0, 16) -ne 16) { throw "${label}: SQLite header too short." }
    $magic = [Text.Encoding]::ASCII.GetString($bytes, 0, 15)
    if ($magic -ne 'SQLite format 3') { throw "${label}: invalid SQLite header." }
  } finally { $file.Dispose() }
  Write-Host "${label}: process running; isolated SQLite file has valid header."
  return $database
}

try {
  New-Item -ItemType Directory -Path @((Join-Path $root 'Roaming'), (Join-Path $root 'Local')) -Force | Out-Null
  $env:APPDATA = Join-Path $root 'Roaming'
  $env:LOCALAPPDATA = Join-Path $root 'Local'

  $firstDb = Start-And-Probe -label 'First launch'
  Stop-TrackerProcess
  $secondDb = Start-And-Probe -label 'Restart'
  if ($firstDb -ne $secondDb) { throw 'Restart changed SQLite data location.' }

  $pass = $true
  Write-Host 'PROCESS_SMOKE_PASS: first launch, SQLite file creation and restart.'
} finally {
  Stop-TrackerProcess
  $env:APPDATA = $originalAppData
  $env:LOCALAPPDATA = $originalLocalAppData
  if (Test-Path -LiteralPath $root) {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $nativeAppData) {
    Remove-Item -LiteralPath $nativeAppData -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (-not $pass) {
    Write-Host 'PROCESS_SMOKE_FAIL: this is an environment-dependent executable smoke; investigate runner GUI/WebView2 before attributing failure to the product.'
  }
}
