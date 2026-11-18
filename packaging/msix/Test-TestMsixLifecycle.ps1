[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $InitialPackage,
    [Parameter(Mandatory)] [string] $UpdatedPackage
)

$ErrorActionPreference = 'Stop'
$packageName = 'TrackerMaster.TestOnly'
$testData = Join-Path $env:APPDATA 'pl.tracker.personal.testonly'
$normalData = Join-Path $env:APPDATA 'pl.tracker.personal'
$database = Join-Path $testData 'tracker.sqlite3'
$reportFilter = Join-Path $testData 'report-date-filter.txt'
$widgetPin = Join-Path $testData 'widget-on-top.txt'
$clientName = 'MSIX lifecycle test client'

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Run this lifecycle test on a GitHub-hosted Windows runner.'
}
if ((Get-AppxPackage -Name $packageName) -or (Test-Path -LiteralPath $testData) -or (Test-Path -LiteralPath $normalData)) {
    throw 'The test requires a clean runner profile.'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
function Get-TestManifest([string] $Path) {
    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $reader = [IO.StreamReader]::new($archive.GetEntry('AppxManifest.xml').Open())
        try { [xml] ($reader.ReadToEnd()) } finally { $reader.Dispose() }
    } finally { $archive.Dispose() }
}

$initialPath = (Get-Item -LiteralPath $InitialPackage).FullName
$updatedPath = (Get-Item -LiteralPath $UpdatedPackage).FullName
$initialIdentity = (Get-TestManifest $initialPath).Package.Identity
$updatedIdentity = (Get-TestManifest $updatedPath).Package.Identity
foreach ($identity in @($initialIdentity, $updatedIdentity)) {
    if ($identity.Name -cne $packageName -or $identity.ProcessorArchitecture -cne 'x64' -or
        $identity.Publisher -cne 'CN=TrackerMaster-TestOnly, OID.2.25.311729368913984317654407730594956997722=1') {
        throw 'Only the isolated x64 packages can be installed in this test.'
    }
}
if ([version] $initialIdentity.Version -ge [version] $updatedIdentity.Version) {
    throw 'The update must have a higher package version.'
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("45ba127d-10a8-46ea-8ab7-56ea9078943c")]
class TrackerApplicationActivationManager {}

[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ITrackerApplicationActivationManager {
    void ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appId,
        [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
}

public static class TestPackageActivation {
    public static int Launch(string appId) {
        var manager = (ITrackerApplicationActivationManager)new TrackerApplicationActivationManager();
        try {
            uint processId;
            manager.ActivateApplication(appId, null, 2, out processId);
            return checked((int)processId);
        } finally {
            Marshal.ReleaseComObject(manager);
        }
    }
}
'@

function Install-TestVersion([string] $Path, [version] $Version) {
    Write-Host "Installing test package $Version"
    Add-AppxPackage -Path $Path -AllowUnsigned
    $instance = Get-AppxPackage -Name $packageName
    if (!$instance -or [version] $instance.Version -ne $Version) {
        throw "Windows did not register test version $Version."
    }
    $instance
}

function Start-TestVersion($Instance) {
    $processId = [TestPackageActivation]::Launch("$($Instance.PackageFamilyName)!TrackerMaster")
    $process = Get-Process -Id $processId
    $expectedExe = Join-Path $Instance.InstallLocation 'tracker-master.exe'
    if ($process.Path -ine $expectedExe) { throw "Unexpected process from test package activation." }
    try {
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            $process.Refresh()
            if ($process.HasExited) { throw "Packaged application exited with code $($process.ExitCode)." }
            if ($process.MainWindowHandle -ne 0 -and (Test-Path -LiteralPath $database)) { return }
            Start-Sleep -Seconds 1
        }
        throw 'Packaged application did not open a window and database in the test profile.'
    } finally {
        $process.Refresh()
        if (!$process.HasExited) {
            [void] $process.CloseMainWindow()
            if (!$process.WaitForExit(3000)) { Stop-Process -Id $process.Id -Force }
        }
    }
}

function Test-LocalData([string] $Mode) {
    if (!(Test-Path -LiteralPath $database -PathType Leaf)) { throw 'Isolated database is missing.' }
    if (Test-Path -LiteralPath $normalData) { throw 'The normal data directory was touched.' }
    @'
const { DatabaseSync } = require('node:sqlite');
const [, , path, name, mode] = process.argv;
const db = new DatabaseSync(path, { readOnly: mode === 'check' });
try {
    if (mode === 'seed') db.prepare('INSERT INTO clients(name) VALUES (?)').run(name);
    const client = db.prepare('SELECT COUNT(*) AS total FROM clients WHERE name = ?').get(name);
    const integrity = db.prepare('PRAGMA quick_check').get();
    if (client.total !== 1 || integrity.quick_check !== 'ok') throw Error('Test client or database integrity check failed');
} finally { db.close(); }
'@ | node - "$database" "$clientName" "$Mode"
    if ($LASTEXITCODE -ne 0) { throw 'Failed to verify the test database.' }
    if ($Mode -eq 'seed') {
        [IO.File]::WriteAllText($reportFilter, 'week')
        [IO.File]::WriteAllText($widgetPin, 'true')
    }
    if ([IO.File]::ReadAllText($reportFilter) -cne 'week' -or [IO.File]::ReadAllText($widgetPin) -cne 'true') {
        throw 'An application preference did not survive.'
    }
}

$initial = Install-TestVersion $initialPath ([version] $initialIdentity.Version)
Start-TestVersion $initial
Test-LocalData 'seed'
Write-Host 'Clean installation opened with an isolated database.'

$updated = Install-TestVersion $updatedPath ([version] $updatedIdentity.Version)
Start-TestVersion $updated
Test-LocalData 'check'
Write-Host 'Update preserved the test client and preferences.'

Remove-AppxPackage -Package $updated.PackageFullName
if (Get-AppxPackage -Name $packageName) { throw 'Test package is still registered after removal.' }
Test-LocalData 'check'
Write-Host 'Uninstall preserved the database and preferences.'

$reinstalled = Install-TestVersion $updatedPath ([version] $updatedIdentity.Version)
Start-TestVersion $reinstalled
Test-LocalData 'check'
Write-Host 'Reinstall reopened the test profile and preserved its data.'
