[CmdletBinding()]
param(
    # Unpackaged: run after tests/windows-application.mjs on the isolated test exe.
    # Packaged: run after packaging/msix/Test-TestMsixLifecycle.ps1 (ACL and privacy checks only).
    [ValidateSet('Unpackaged', 'Packaged')] [string] $Mode = 'Unpackaged',
    [string] $Executable = 'src-tauri/target/release/tracker-master.exe'
)

# DEV-14: file protection of the isolated test profile. Runs only on a disposable
# GitHub-hosted runner; the temporary second account exists only on that runner.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Run this file-protection test on a GitHub-hosted Windows runner.'
}

$identifier = 'pl.tracker.personal.testonly'
$dataDir = Join-Path $env:APPDATA $identifier
$normalData = Join-Path $env:APPDATA 'pl.tracker.personal'
$database = Join-Path $dataDir 'tracker.sqlite3'
$trace = Join-Path $dataDir 'window-diagnostic.txt'
$latin1 = [Text.Encoding]::GetEncoding(28591)
$failures = [Collections.Generic.List[string]]::new()
function Fail([string] $Message) { $failures.Add($Message); Write-Host "FAIL: $Message" }

if (!(Test-Path -LiteralPath $database -PathType Leaf)) { throw 'Run the application test first: the isolated database is missing.' }
if (Test-Path -LiteralPath $normalData) { throw 'The normal profile exists on the runner.' }

$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowedSids = @($currentSid, 'S-1-5-18', 'S-1-5-32-544') # current user, SYSTEM, Administrators
$broadSids = @{
    'S-1-1-0' = 'Everyone'; 'S-1-5-32-545' = 'Users'; 'S-1-5-11' = 'Authenticated Users'
    'S-1-5-4' = 'INTERACTIVE'; 'S-1-5-32-546' = 'Guests'; 'S-1-15-2-1' = 'ALL APPLICATION PACKAGES'
}

function Get-RuleSid($Rule) {
    try { $Rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { [string] $Rule.IdentityReference }
}

# Only the current user, SYSTEM and Administrators may hold access. Two further SIDs are
# allowed, each only inside its own subtree and only as computed in this run:
# - the test package capability SID (S-1-15-3- + sub-authorities of
#   DeriveAppContainerSidFromAppContainerName(PackageFamilyName)), inside the package LocalCache
#   that Windows creates for the package;
# - the WebView2 network-service LPAC capability, DeriveCapabilitySidsFromName("lpacEdgeStableNetworkSandbox"),
#   inside EBWebView<profile>{Network,Cache,Shared Dictionary}. Chromium grants exactly these
#   directories in content/browser/network_sandbox.cc (MaybeGrantAccessToDataPath, via
#   Sid::FromNamedCapabilityVector of ContentBrowserClient::GetLPACCapabilityNameForNetworkService);
#   Chrome names it lpacChrome<Channel>NetworkSandbox, Edge/WebView2 Stable lpacEdgeStableNetworkSandbox.
# Windows grants an AppContainer/LPAC token access only if its user SID also passes the DACL,
# so neither SID gives another account access. Any other SID, or these SIDs elsewhere, fails.
$script:scopedSids = [Collections.Generic.List[object]]::new()
$script:seenScoped = [Collections.Generic.HashSet[string]]::new()
$script:vanished = 0
function Add-ScopedSid([string] $Sid, [string[]] $Roots, [string] $Reason) {
    $script:scopedSids.Add([pscustomobject] @{ Sid = $Sid; Roots = $Roots; Reason = $Reason })
    Write-Host "ACL scoped allowance $Sid ($Reason) under: $($Roots -join ' | ')"
}
function Test-ScopedSid([string] $Sid, [string] $Path) {
    foreach ($entry in $script:scopedSids) {
        if ($entry.Sid -ne $Sid) { continue }
        foreach ($root in $entry.Roots) {
            if ($Path -eq $root -or $Path.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) { [void] $script:seenScoped.Add($Sid); return $true }
        }
    }
    $false
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Dev14Token {
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, int length, out int returned);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr text);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    static string Text(IntPtr sid) {
        IntPtr text;
        if (sid == IntPtr.Zero || !ConvertSidToStringSidW(sid, out text)) return "";
        try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
    }
    static IntPtr Query(IntPtr token, int cls) {
        int length;
        GetTokenInformation(token, cls, IntPtr.Zero, 0, out length);
        if (length <= 0) return IntPtr.Zero;
        IntPtr buffer = Marshal.AllocHGlobal(length);
        if (GetTokenInformation(token, cls, buffer, length, out length)) return buffer;
        Marshal.FreeHGlobal(buffer);
        return IntPtr.Zero;
    }
    // [0] token user, [1] AppContainer SID (empty when none), [2..] capability SIDs.
    public static string[] Describe(int pid) {
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return null;
        try {
            IntPtr token;
            if (!OpenProcessToken(process, 0x8, out token)) return null;
            try {
                var result = new List<string>();
                IntPtr user = Query(token, 1);
                result.Add(user == IntPtr.Zero ? "" : Text(Marshal.ReadIntPtr(user)));
                if (user != IntPtr.Zero) Marshal.FreeHGlobal(user);
                IntPtr container = Query(token, 31);
                result.Add(container == IntPtr.Zero ? "" : Text(Marshal.ReadIntPtr(container)));
                if (container != IntPtr.Zero) Marshal.FreeHGlobal(container);
                IntPtr groups = Query(token, 30);
                if (groups != IntPtr.Zero) {
                    int count = Marshal.ReadInt32(groups);
                    for (int i = 0; i < count; i++) result.Add(Text(Marshal.ReadIntPtr(groups, IntPtr.Size + i * IntPtr.Size * 2)));
                    Marshal.FreeHGlobal(groups);
                }
                return result.ToArray();
            } finally { CloseHandle(token); }
        } finally { CloseHandle(process); }
    }
    [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groupSids, out uint groupCount, out IntPtr capabilitySids, out uint capabilityCount);
    public static string CapabilitySid(string name) {
        IntPtr groups, capabilities; uint groupCount, capabilityCount;
        if (!DeriveCapabilitySidsFromName(name, out groups, out groupCount, out capabilities, out capabilityCount) || capabilityCount < 1)
            throw new InvalidOperationException("DeriveCapabilitySidsFromName failed: " + Marshal.GetLastWin32Error());
        try { return Text(Marshal.ReadIntPtr(capabilities)); }
        finally {
            for (uint i = 0; i < groupCount; i++) LocalFree(Marshal.ReadIntPtr(groups, (int) i * IntPtr.Size));
            for (uint i = 0; i < capabilityCount; i++) LocalFree(Marshal.ReadIntPtr(capabilities, (int) i * IntPtr.Size));
            LocalFree(groups); LocalFree(capabilities);
        }
    }
    public static string AppContainerSid(string name) {
        IntPtr sid;
        int hr = DeriveAppContainerSidFromAppContainerName(name, out sid);
        if (hr != 0) throw new InvalidOperationException("DeriveAppContainerSidFromAppContainerName failed: 0x" + hr.ToString("x8"));
        try { return Text(sid); } finally { FreeSid(sid); }
    }
}
'@

function Test-PrivateAcl([string] $Path, [string] $Label) {
    try { $acl = Get-Acl -LiteralPath $Path }
    catch [Management.Automation.ItemNotFoundException] { $script:vanished++; Write-Host "ACL $Label vanished before check: $Path"; return }
    $entries = foreach ($rule in $acl.Access) {
        $sid = Get-RuleSid $rule
        "$($rule.AccessControlType):$sid=$($rule.FileSystemRights)$(if ($rule.IsInherited) { '(inherited)' })"
        if ($rule.AccessControlType -ne 'Allow') { continue }
        if ($sid -eq 'S-1-3-0' -and $rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
        if ($broadSids.ContainsKey($sid)) { Fail "$Label grants $($broadSids[$sid]) ($sid) $($rule.FileSystemRights): $Path" }
        elseif (Test-ScopedSid $sid $Path) { }
        elseif ($allowedSids -notcontains $sid) { Fail "$Label grants an unexpected identity $sid ($($rule.IdentityReference)): $Path" }
    }
    Write-Host "ACL $Label $Path :: $($entries -join '; ')"
}

# A stopped app can leave WebView2 helper processes cleaning up its profile for a moment.
function Wait-WebViewExit {
    $deadline = (Get-Date).AddSeconds(30)
    do {
        $left = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like "*$identifier*" })
        if (!$left.Count) { return }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    Write-Host "WebView2 processes still running for the test profile: $($left.Count)"
}

function Get-Inventory([string] $Root) {
    if (!(Test-Path -LiteralPath $Root)) { return @() }
    @(Get-Item -LiteralPath $Root -Force) + @(Get-ChildItem -LiteralPath $Root -Recurse -Force)
}

# Files that are user data by design (may contain client names and descriptions).
function Test-DataFile([IO.FileSystemInfo] $Item) {
    if ($Item.PSIsContainer) { return $true }
    $name = $Item.Name
    $name -like 'tracker.sqlite3*' -or $Item.DirectoryName -like '*\entry-drafts' -or
        ($Item.DirectoryName -match '\\(saved-)?backups(-test)?$' -and $name -like '*.sqlite3*')
}

function Test-NoSecret([IO.FileSystemInfo[]] $Items, [string[]] $Secrets, [string] $Label) {
    $scanned = 0
    foreach ($item in $Items) {
        if ($item.PSIsContainer -or (Test-DataFile $item) -or $item.Length -gt 64MB) { continue }
        try { $text = $latin1.GetString([IO.File]::ReadAllBytes($item.FullName)) }
        catch [IO.IOException] { Write-Host "SKIP locked $($item.FullName)"; continue }
        catch [UnauthorizedAccessException] { Write-Host "SKIP no access $($item.FullName)"; continue }
        $scanned++
        foreach ($secret in $Secrets) {
            $utf8 = $latin1.GetString([Text.Encoding]::UTF8.GetBytes($secret))
            $utf16 = $latin1.GetString([Text.Encoding]::Unicode.GetBytes($secret))
            if ($text.Contains($utf8) -or $text.Contains($utf16)) { Fail "$Label contains user data '$secret': $($item.FullName)" }
        }
    }
    Write-Host "PRIVACY $Label scanned $scanned diagnostic/preference/cache files for $($Secrets.Count) markers"
}

function Invoke-Sqlite([string] $Script, [string[]] $Arguments) {
    $output = $Script | node - @Arguments
    if ($LASTEXITCODE -ne 0) { throw "SQLite helper failed ($LASTEXITCODE)." }
    $output
}

$exeItem = Get-Item -LiteralPath $Executable -ErrorAction SilentlyContinue
$since = if ($exeItem) { $exeItem.CreationTime } else { (Get-Date).AddHours(-2) }
# Names the application could produce: database, backups, drafts, SQLite temp files, diagnostics.
$appPattern = 'etilqs|\.sqlite3|testonly|window-diagnostic|instance\.lock|entry-\d+\.json'

# 1. Inventory of everything the application wrote for this user.
$webDirs = @(Join-Path $env:LOCALAPPDATA $identifier)
$osPackagePaths = @()
$osPackageFiles = @()
if ($Mode -eq 'Packaged') {
    $package = Get-AppxPackage -Name 'TrackerMaster.TestOnly'
    if (!$package) { throw 'The test package is not installed.' }
    $packageRoot = Join-Path $env:LOCALAPPDATA "Packages\$($package.PackageFamilyName)"
    $webDirs += Join-Path $packageRoot "LocalCache\Local\$identifier"
    if (Test-Path -LiteralPath (Join-Path $packageRoot "LocalCache\Roaming\$identifier")) {
        Fail "Packaged data was virtualized into the package cache instead of $dataDir."
    }
    Write-Host "Package $($package.PackageFullName)"
    # The package's AppContainer SID is derived from its family name; Windows labels the
    # package's LocalCache with the matching capability form (S-1-15-3- + same sub-authorities).
    $packageContainerSid = [Dev14Token]::AppContainerSid($package.PackageFamilyName)
    if ($packageContainerSid -notlike 'S-1-15-2-*') { throw "Unexpected package SID $packageContainerSid." }
    $packageCapabilitySid = 'S-1-15-3-' + $packageContainerSid.Substring('S-1-15-2-'.Length)
    Add-ScopedSid $packageCapabilitySid @(Join-Path $packageRoot 'LocalCache') "capability form of the test package SID $packageContainerSid ($($package.PackageFamilyName))"
    Write-Host "PACKAGE_SID derived=$packageContainerSid capability=$packageCapabilitySid"
    # Launch the packaged app to read its token and the WebView2 sandbox it starts.
    Start-Process -FilePath "shell:AppsFolder\$($package.PackageFamilyName)!TrackerMaster"
    $deadline = (Get-Date).AddSeconds(60)
    do { Start-Sleep -Milliseconds 500; $packaged = Get-Process -Name 'tracker-master' -ErrorAction SilentlyContinue | Select-Object -First 1 } while (!$packaged -and (Get-Date) -lt $deadline)
    if (!$packaged) { throw 'The packaged application did not start.' }
    try {
        $appToken = [Dev14Token]::Describe($packaged.Id)
        Write-Host "PACKAGE_TOKEN pid=$($packaged.Id) user=$($appToken[0]) appContainer=$($appToken[1]) capabilities=$(($appToken | Select-Object -Skip 2) -join ',')"
        if ($appToken[0] -ne $currentSid) { Fail "The packaged app runs as $($appToken[0]), not the current user." }
        Write-Host "PACKAGE_TOKEN holds derived package capability: $(($appToken | Select-Object -Skip 2) -contains $packageCapabilitySid)"
    } finally {
        Get-Process -Name 'tracker-master' -ErrorAction SilentlyContinue | Stop-Process -Force
        Wait-WebViewExit
    }
    # Package registration that Windows itself keeps in ProgramData (manifest copy, per-user
    # package state). Listed and scanned for user data, not treated as application files.
    $osPackageItems = @(
        Get-ChildItem -LiteralPath (Join-Path $env:ProgramData 'Microsoft\Windows\AppRepository') -Force -ErrorAction SilentlyContinue | Where-Object Name -like "$($package.Name)_*"
        Get-ChildItem -LiteralPath (Join-Path $env:ProgramData 'Microsoft\Windows\AppRepository\Packages') -Force -ErrorAction SilentlyContinue | Where-Object Name -like "$($package.Name)_*"
        Get-ChildItem -LiteralPath (Join-Path $env:ProgramData 'Packages') -Force -ErrorAction SilentlyContinue | Where-Object Name -eq $package.PackageFamilyName
    )
    $osPackagePaths = @($osPackageItems | ForEach-Object FullName)
    $osPackageFiles = @($osPackageItems | ForEach-Object { $_; if ($_.PSIsContainer) { Get-ChildItem -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue } })
    Write-Host "INVENTORY OS package registration in ProgramData: $($osPackagePaths -join ', ') ($($osPackageFiles.Count) items)"
    $osPackageFiles | ForEach-Object { Write-Host "  $($_.FullName)$(if (!$_.PSIsContainer) { " [$($_.Length) B]" })" }
}
Wait-WebViewExit
$networkSandboxSid = [Dev14Token]::CapabilitySid('lpacEdgeStableNetworkSandbox')
$networkRoots = foreach ($dir in $webDirs) { foreach ($name in 'Network', 'Cache', 'Shared Dictionary') { Join-Path $dir "EBWebView\Default\$name" } }
Add-ScopedSid $networkSandboxSid $networkRoots 'WebView2 network-service LPAC capability lpacEdgeStableNetworkSandbox'

if ($Mode -eq 'Unpackaged') {
    # 2. Unique synthetic marker: written to the database, then rendered by the app.
    $marker = 'DEV14MARK' + [guid]::NewGuid().ToString('N')
    Get-Process -Name 'tracker-master' -ErrorAction SilentlyContinue | Stop-Process -Force
    Invoke-Sqlite @'
const { DatabaseSync } = require('node:sqlite');
const [, , path, marker] = process.argv;
const db = new DatabaseSync(path);
try {
  db.exec('BEGIN');
  const client = db.prepare('INSERT INTO clients(name) VALUES (?)').run(marker + '-klient').lastInsertRowid;
  const project = db.prepare('INSERT INTO projects(client_id,name) VALUES (?,?)').run(client, marker + '-projekt').lastInsertRowid;
  const task = db.prepare('INSERT INTO tasks(project_id,name) VALUES (?,?)').run(project, marker + '-zadanie').lastInsertRowid;
  const entry = db.prepare("INSERT INTO time_entries(task_id,project_id,started_at,ended_at,duration_seconds) VALUES (?,?,'2026-01-05T08:00:00Z','2026-01-05T09:00:00Z',3600)").run(task, project).lastInsertRowid;
  db.prepare('INSERT INTO entry_descriptions(entry_id,description) VALUES (?,?)').run(entry, marker + '-opis');
  db.exec('COMMIT');
} finally { db.close(); }
'@ @($database, $marker) | Out-Null

    if (Test-Path -LiteralPath $trace) { Remove-Item -LiteralPath $trace }
    $env:WEBVIEW2_USER_DATA_FOLDER = $null
    $app = Start-Process -FilePath (Resolve-Path $Executable) -PassThru
    try {
        $deadline = (Get-Date).AddSeconds(90)
        while ((Get-Date) -lt $deadline -and !((Test-Path -LiteralPath $trace) -and (Select-String -LiteralPath $trace -SimpleMatch 'setup-complete' -Quiet))) {
            if ($app.HasExited) { throw "The test application exited with $($app.ExitCode)." }
            Start-Sleep -Milliseconds 250
        }
        if (!(Select-String -LiteralPath $trace -SimpleMatch 'setup-complete' -Quiet)) { throw 'The test application did not finish setup.' }
        $deadline = (Get-Date).AddSeconds(30)
        do { Start-Sleep -Milliseconds 250; $app.Refresh() } while ($app.MainWindowHandle -eq 0 -and (Get-Date) -lt $deadline)
        Start-Sleep -Seconds 3 # let the window render the marker data
        Add-Type -Namespace Dev14 -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessageW(System.IntPtr h, uint m, System.UIntPtr w, System.IntPtr l);'
        if ($app.MainWindowHandle -ne 0) { [void] [Dev14.Native]::PostMessageW($app.MainWindowHandle, 0x0010, [UIntPtr]::Zero, [IntPtr]::Zero) }
        $deadline = (Get-Date).AddSeconds(15)
        while ((Get-Date) -lt $deadline -and !(Select-String -LiteralPath $trace -SimpleMatch 'main-hide-ok' -Quiet)) { Start-Sleep -Milliseconds 250 }
    } finally {
        if (!$app.HasExited) { Stop-Process -Id $app.Id -Force; $app.WaitForExit(10000) | Out-Null }
        Wait-WebViewExit
    }
    $traceText = Get-Content -LiteralPath $trace -Raw
    foreach ($expected in 'setup-complete', 'main-close-requested', 'main-hide-ok') {
        if (!$traceText.Contains($expected)) { Fail "Diagnostic trace lacks '$expected' (the marker run did not exercise it)." }
    }
    Write-Host "Diagnostic trace lines: $(($traceText -split "`r?`n" | Where-Object { $_ }) -join ', ')"
    $secrets = @("$marker-klient", "$marker-projekt", "$marker-zadanie", "$marker-opis", $marker)
    # Positive control: the scanner finds the marker where it belongs.
    if (!$latin1.GetString([IO.File]::ReadAllBytes($database)).Contains($marker)) { Fail 'Positive control: marker not found in the database file.' }
    # Names the E2E entered through the UI must not leak into diagnostics either.
    $known = Invoke-Sqlite @'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  const rows = [...db.prepare('SELECT name AS v FROM clients UNION SELECT name FROM projects UNION SELECT name FROM tasks UNION SELECT description FROM entry_descriptions').all()];
  console.log(rows.map(row => row.v).filter(value => value && value.length >= 6).join('\n'));
} finally { db.close(); }
'@ @($database)
    $secrets += @($known | Where-Object { $_ })
} else {
    $secrets = @('MSIX lifecycle test client')
}

$dataItems = Get-Inventory $dataDir
$webItems = foreach ($dir in $webDirs) { Get-Inventory $dir }
Write-Host "INVENTORY data ($dataDir):"
$dataItems | ForEach-Object { Write-Host "  $($_.FullName.Substring($dataDir.Length))$(if (!$_.PSIsContainer) { " [$($_.Length) B]" })" }
foreach ($dir in $webDirs) { Write-Host "INVENTORY webview ($dir): $(@(Get-Inventory $dir).Count) items" }
$wal = @($dataItems | Where-Object { $_.Name -like '*-wal' -or $_.Name -like '*-shm' })
Write-Host "INVENTORY WAL/SHM files: $($wal.Count)"
if (@($webItems).Count -eq 0) { Write-Host 'INVENTORY webview profile not present for this mode.' }

# 3. Nothing outside the per-user data folders: next to the exe, ProgramData, Public, Windows\Temp.
if ($Mode -eq 'Unpackaged') {
    $exeDir = $exeItem.DirectoryName
    $extra = @(Get-ChildItem -LiteralPath $exeDir -Force | Where-Object Name -ne 'tracker-master.exe')
    if ($extra.Count) { Fail "Files next to the executable: $($extra.Name -join ', ')" } else { Write-Host "OUTSIDE exe directory contains only tracker-master.exe" }
}
foreach ($shared in @($env:ProgramData, (Join-Path $env:SystemDrive 'Users\Public'), (Join-Path $env:SystemRoot 'Temp'), $env:TEMP)) {
    $hits = @(Get-ChildItem -LiteralPath $shared -Recurse -Depth 4 -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.CreationTime -ge $since -and ($_.Name -match $appPattern) } |
        Where-Object { $path = $_.FullName; !($osPackagePaths | Where-Object { $path -eq $_ -or $path.StartsWith("$_\") }) })
    if ($shared -eq $env:TEMP) {
        # Per-user TEMP is private to the account; SQLite temp files (etilqs_*) must still be gone.
        if ($hits.Count) { Fail "Leftover files in the user's TEMP: $($hits.FullName -join ', ')" }
        Test-PrivateAcl $env:TEMP 'user-temp'
    } elseif ($hits.Count) { Fail "Application files in a shared location: $($hits.FullName -join ', ')" }
    Write-Host "OUTSIDE $shared new matching items: $($hits.Count)"
}

# 4. ACL of every file and folder in the profile.
foreach ($item in $dataItems) { Test-PrivateAcl $item.FullName 'data' }
foreach ($item in $webItems) { Test-PrivateAcl $item.FullName 'webview' }
Write-Host "ACL checked $(@($dataItems).Count) data items and $(@($webItems).Count) webview items ($script:vanished vanished during the check)"
foreach ($entry in $script:scopedSids) { Write-Host "ACL scoped $($entry.Sid) present on checked items: $($script:seenScoped.Contains($entry.Sid))" }

# 5. Logs and diagnostics contain no client, project, task names or descriptions.
Test-NoSecret ($dataItems + @($webItems)) $secrets 'profile'
if ($osPackageFiles) { Test-NoSecret $osPackageFiles $secrets 'os-package-registration' }
$tempItems = @(Get-ChildItem -LiteralPath $env:TEMP -Recurse -Depth 4 -Force -File -ErrorAction SilentlyContinue | Where-Object LastWriteTime -ge $since)
Test-NoSecret $tempItems $secrets 'user-temp'

# 6. A second, non-administrator local account (ephemeral runner only).
if ($Mode -eq 'Unpackaged') {
    $shared = Join-Path $env:SystemDrive 'TrackerMasterDev14'
    $userName = 'tmdev14' + (Get-Random -Minimum 10000 -Maximum 99999)
    $bytes = [byte[]]::new(24); [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $plain = 'Aa1-' + [Convert]::ToHexString($bytes)
    $secure = ConvertTo-SecureString $plain -AsPlainText -Force
    $userSid = $null
    $targets = @($dataItems | ForEach-Object FullName) + @($webItems | Select-Object -First 20 | ForEach-Object FullName)
    try {
        New-Item -ItemType Directory -Path $shared | Out-Null
        # A standard local account (member of Users only), created through ADSI so no prompt can
        # block it. The password is never printed.
        $computer = [ADSI] "WinNT://$env:COMPUTERNAME,computer"
        $account = $computer.Create('User', $userName)
        $account.SetPassword($plain)
        $account.Put('Description', 'TrackerMaster CI DEV-14 (ephemeral)')
        $account.SetInfo()
        $account.Put('PasswordExpired', 0)
        $account.SetInfo()
        Remove-Variable plain
        $userSid = ([Security.Principal.NTAccount] "$env:COMPUTERNAME\$userName").Translate([Security.Principal.SecurityIdentifier]).Value
        $usersName = ([Security.Principal.SecurityIdentifier] 'S-1-5-32-545').Translate([Security.Principal.NTAccount]).Value.Split('\')[-1]
        try { ([ADSI] "WinNT://$env:COMPUTERNAME/$usersName,group").Add("WinNT://$env:COMPUTERNAME/$userName,user") }
        catch { if ($_.Exception.InnerException.ErrorCode -ne -2147023518) { throw } } # already a member
        Copy-Item -LiteralPath (Resolve-Path $Executable) -Destination (Join-Path $shared 'tracker-master.exe')
        Set-Content -LiteralPath (Join-Path $shared 'targets.txt') -Value $targets -Encoding utf8
        Set-Content -LiteralPath (Join-Path $shared 'second-user.ps1') -Encoding utf8 -Value @'
param([string] $Root)
$ErrorActionPreference = 'Stop'
trap { Set-Content -LiteralPath (Join-Path $Root 'error.txt') -Value ($_ | Out-String) -Encoding utf8; exit 1 }
$root = $Root
# Start-Process -Credential passes the parent environment, and known folders expand
# %USERPROFILE% from it. Take this account's own profile from the registry instead.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$profileKey = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$($identity.User.Value)"
$profilePath = [Environment]::ExpandEnvironmentVariables((Get-ItemProperty -LiteralPath $profileKey).ProfileImagePath)
$env:USERNAME = $identity.Name.Split('\')[-1]
$env:USERPROFILE = $profilePath
$env:HOMEDRIVE = Split-Path -Qualifier $profilePath
$env:HOMEPATH = Split-Path -NoQualifier $profilePath
$env:APPDATA = Join-Path $profilePath 'AppData\Roaming'
$env:LOCALAPPDATA = Join-Path $profilePath 'AppData\Local'
$env:TEMP = $env:TMP = Join-Path $env:LOCALAPPDATA 'Temp'
foreach ($folder in $env:APPDATA, $env:TEMP) { [void] (New-Item -ItemType Directory -Force -Path $folder) }
if ([Environment]::GetFolderPath('ApplicationData') -ne $env:APPDATA) { throw "Known folder ApplicationData still resolves to $([Environment]::GetFolderPath('ApplicationData'))." }
$reads = foreach ($target in Get-Content -LiteralPath (Join-Path $root 'targets.txt')) {
    $result = try {
        if ([IO.Directory]::Exists($target)) { [void] [IO.Directory]::GetFileSystemEntries($target) } else { [void] [IO.File]::ReadAllBytes($target) }
        'read'
    } catch [UnauthorizedAccessException] { 'denied' } catch { 'error:' + $_.Exception.GetType().Name }
    [pscustomobject] @{ path = $target; result = $result }
}
$own = Join-Path $env:APPDATA 'pl.tracker.personal.testonly'
$existedBefore = Test-Path -LiteralPath $own
$app = Start-Process -FilePath (Join-Path $root 'tracker-master.exe') -PassThru
$ready = $false
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
    $trace = Join-Path $own 'window-diagnostic.txt'
    if ((Test-Path -LiteralPath (Join-Path $own 'tracker.sqlite3')) -and (Test-Path -LiteralPath $trace) -and
        (Select-String -LiteralPath $trace -SimpleMatch 'setup-complete' -Quiet)) { $ready = $true; break }
    if ($app.HasExited) { break }
    Start-Sleep -Milliseconds 250
}
$exitCode = if ($app.HasExited) { $app.ExitCode } else { 'running' }
if (!$app.HasExited) { Stop-Process -Id $app.Id -Force; [void] $app.WaitForExit(10000) }
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$admin = $principal.IsInRole([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
[pscustomobject] @{ user = $identity.Name.Split('\')[-1]; sid = $identity.User.Value; admin = $admin; appData = $env:APPDATA; ownDataExistedBefore = $existedBefore; ready = $ready; exit = "$exitCode"; reads = @($reads) } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $root 'result.json') -Encoding utf8
'@
        & icacls.exe $shared /grant "${userName}:(OI)(CI)M" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not grant the test account access to the exchange folder.' }
        $credential = [pscredential]::new("$env:COMPUTERNAME\$userName", $secure)
        $pwsh = (Get-Command pwsh).Source
        $helper = Start-Process -FilePath $pwsh -Credential $credential -LoadUserProfile -WorkingDirectory $shared -PassThru -Wait `
            -RedirectStandardOutput (Join-Path $env:RUNNER_TEMP 'dev14-helper.out') -RedirectStandardError (Join-Path $env:RUNNER_TEMP 'dev14-helper.err') `
            -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $shared 'second-user.ps1'), '-Root', $shared)
        foreach ($log in (Join-Path $env:RUNNER_TEMP 'dev14-helper.out'), (Join-Path $env:RUNNER_TEMP 'dev14-helper.err'), (Join-Path $shared 'error.txt')) {
            if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length) { Write-Host "SECOND_ACCOUNT log $(Split-Path -Leaf $log):"; Get-Content -LiteralPath $log | ForEach-Object { Write-Host "  $_" } }
        }
        if ($helper.ExitCode -ne 0) { throw "The second account helper exited with $($helper.ExitCode)." }
        $result = Get-Content -LiteralPath (Join-Path $shared 'result.json') -Raw | ConvertFrom-Json
        Write-Host "SECOND_ACCOUNT user=$($result.user) admin=$($result.admin) appData=$($result.appData) ownDataExistedBefore=$($result.ownDataExistedBefore) ready=$($result.ready) exit=$($result.exit)"
        if ($result.user -ne $userName -or $result.sid -ne $userSid) { Fail "The helper ran as '$($result.user)' ($($result.sid)), not the test account." }
        if ($result.admin -ne $false) { Fail 'The second account has administrator rights.' }
        foreach ($read in $result.reads) {
            if ($read.result -ne 'denied') { Fail "Second account could access ($($read.result)): $($read.path)" }
        }
        Write-Host "SECOND_ACCOUNT denied $(@($result.reads | Where-Object result -eq 'denied').Count) of $(@($result.reads).Count) first-account items"
        $profilePath = (Get-CimInstance Win32_UserProfile | Where-Object SID -eq $userSid).LocalPath
        $secondDb = Join-Path $profilePath "AppData\Roaming\$identifier\tracker.sqlite3"
        if ($result.ownDataExistedBefore) { Fail 'The second account already had test data before its first start.' }
        if (!$result.ready -or !(Test-Path -LiteralPath $secondDb)) { Fail "The second account's own instance did not start with its own database ($secondDb)." }
        else {
            $counts = Invoke-Sqlite @'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  const one = sql => db.prepare(sql).get().n;
  const version = db.prepare('PRAGMA user_version').get().user_version;
  console.log(JSON.stringify({ version, clients: one('SELECT COUNT(*) AS n FROM clients'), entries: one('SELECT COUNT(*) AS n FROM time_entries'), check: db.prepare('PRAGMA quick_check').get().quick_check }));
} finally { db.close(); }
'@ @($secondDb) | ConvertFrom-Json
            Write-Host "SECOND_ACCOUNT database $secondDb version=$($counts.version) clients=$($counts.clients) entries=$($counts.entries) quick_check=$($counts.check)"
            if ($counts.version -lt 1 -or $counts.clients -ne 0 -or $counts.entries -ne 0 -or $counts.check -ne 'ok') { Fail 'The second account database is not a separate, empty, initialised database.' }
            if ($secondDb -eq $database) { Fail 'Both accounts use the same database path.' }
        }
        if (!(Test-Path -LiteralPath $database)) { Fail 'The first account database disappeared.' }
    } finally {
        Get-CimInstance Win32_Process -Filter "Name='tracker-master.exe'" | Where-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq $userName } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        if ($userSid) {
            ([ADSI] "WinNT://$env:COMPUTERNAME,computer").Delete('User', $userName)
            Get-CimInstance Win32_UserProfile | Where-Object SID -eq $userSid | Remove-CimInstance -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $shared -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($failures.Count) { throw "DEV-14 file protection: $($failures.Count) failure(s)." }
Write-Host "PASS: DEV-14 file protection ($Mode): private ACLs, nothing in shared locations, no user data in diagnostics$(if ($Mode -eq 'Unpackaged') { ', second account isolated' })"
