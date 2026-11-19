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

public static class TestPackageWindow {
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint owner);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessageW(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
}
'@

function Install-TestVersion([string] $Path, [version] $Version, [switch] $Updating) {
    Write-Host "Installing test package $Version"
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        try {
            # On the clean runner, only the verified test package can still
            # hold resources after its main window and process exit.
            Add-AppxPackage -Path $Path -AllowUnsigned -ForceTargetApplicationShutdown:($Updating -and $attempt -eq 2)
            break
        } catch {
            if (!$Updating -or $attempt -ge 2 -or $_.Exception.Message -notmatch '0x80073D02') { throw }
            Write-Host 'The test MSIX is still releasing resources. Retrying the update.'
            Start-Sleep -Seconds 3
        }
    }
    $instance = Get-AppxPackage -Name $packageName
    if (!$instance -or [version] $instance.Version -ne $Version) {
        throw "Windows did not register test version $Version."
    }
    $instance
}

function Write-TestWindowState([string] $Phase, $Process, [IntPtr] $Window, [version] $Version) {
    $Process.Refresh()
    $exited = $Process.HasExited
    $exitCode = if ($exited) { try { $Process.ExitCode } catch { 'unavailable' } } else { 'running' }
    $valid = [TestPackageWindow]::IsWindow($Window)
    [uint32] $owner = 0
    $thread = [TestPackageWindow]::GetWindowThreadProcessId($Window, [ref] $owner)
    $visible = $valid -and [TestPackageWindow]::IsWindowVisible($Window)
    Write-Host "WINDOW_DIAGNOSTIC phase=$Phase version=$Version pid=$($Process.Id) exited=$exited exitCode=$exitCode hwnd=$($Window.ToInt64()) valid=$valid owner=$owner thread=$thread visible=$visible"
}

function Start-TestVersion($Instance) {
    $processId = [TestPackageActivation]::Launch("$($Instance.PackageFamilyName)!TrackerMaster")
    $process = Get-Process -Id $processId
    $expectedExe = Join-Path $Instance.InstallLocation 'tracker-master.exe'
    if ($process.Path -ine $expectedExe) { throw "Unexpected process from test package activation." }
    try {
        $window = [IntPtr]::Zero
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            $process.Refresh()
            if ($process.HasExited) { throw "Packaged application exited with code $($process.ExitCode)." }
            if ($process.MainWindowHandle -ne 0 -and $process.MainWindowTitle -eq 'Personal Time Tracker' -and
                (Test-Path -LiteralPath $database)) {
                $window = $process.MainWindowHandle
                break
            }
            Start-Sleep -Seconds 1
        }
        if ($window -eq [IntPtr]::Zero) { throw 'Packaged application did not open a window and database in the test profile.' }
        [uint32] $windowOwner = 0
        if ([TestPackageWindow]::GetWindowThreadProcessId($window, [ref] $windowOwner) -eq 0 -or $windowOwner -ne $processId) {
            throw 'The window does not belong to the launched test package.'
        }
        Start-Sleep -Seconds 2
        Write-TestWindowState 'before-close' $process $window ([version] $Instance.Version)
        if (![TestPackageWindow]::PostMessageW($window, 0x0010, [UIntPtr]::Zero, [IntPtr]::Zero)) {
            throw "Could not request window close: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
        }
        $hidden = $false
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            $process.Refresh()
            if ($process.HasExited) {
                Write-TestWindowState 'after-close-process-exited' $process $window ([version] $Instance.Version)
                throw "The packaged process exited after the close request with code $($process.ExitCode)."
            }
            if (![TestPackageWindow]::IsWindow($window)) {
                Write-TestWindowState 'after-close-window-invalid' $process $window ([version] $Instance.Version)
                throw 'The packaged process remained running but its original window became invalid after the close request.'
            }
            if (![TestPackageWindow]::IsWindowVisible($window)) { $hidden = $true; break }
            Start-Sleep -Milliseconds 250
        }
        if (!$hidden) {
            Write-TestWindowState 'after-close-still-visible' $process $window ([version] $Instance.Version)
            throw 'The packaged window stayed visible after the close request.'
        }
        Write-TestWindowState 'after-close-hidden' $process $window ([version] $Instance.Version)
        $reactivatedId = [TestPackageActivation]::Launch("$($Instance.PackageFamilyName)!TrackerMaster")
        Write-Host "WINDOW_DIAGNOSTIC phase=reactivation version=$($Instance.Version) originalPid=$processId activatedPid=$reactivatedId"
        if ($reactivatedId -ne $processId) {
            $second = Get-Process -Id $reactivatedId -ErrorAction SilentlyContinue
            if ($second -and !$second.WaitForExit(10000)) { throw 'A second packaged process remained running.' }
        }
        $visible = $false
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            $process.Refresh()
            if ($process.HasExited) {
                Write-TestWindowState 'after-reactivation-process-exited' $process $window ([version] $Instance.Version)
                throw "The original packaged process exited after reactivation with code $($process.ExitCode)."
            }
            if (![TestPackageWindow]::IsWindow($window)) {
                Write-TestWindowState 'after-reactivation-window-invalid' $process $window ([version] $Instance.Version)
                throw 'The original packaged window became invalid after reactivation.'
            }
            if ([TestPackageWindow]::IsWindowVisible($window)) { $visible = $true; break }
            Start-Sleep -Milliseconds 250
        }
        if (!$visible) {
            Write-TestWindowState 'after-reactivation-still-hidden' $process $window ([version] $Instance.Version)
            throw 'Reactivating the package did not show the original window.'
        }
        Write-TestWindowState 'after-reactivation-visible' $process $window ([version] $Instance.Version)
        Write-Host 'PASS: close hid the packaged window and reactivation restored the original process and window.'
    } finally {
        $process.Refresh()
        if (!$process.HasExited) {
            [void] $process.CloseMainWindow()
            if (!$process.WaitForExit(3000)) {
                Stop-Process -Id $process.Id -Force
                if (!$process.WaitForExit(5000)) { throw 'The test application did not exit.' }
            }
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

$updated = Install-TestVersion $updatedPath ([version] $updatedIdentity.Version) -Updating
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
