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

# Only the current user, SYSTEM and Administrators may hold access. A packaged
# app's own AppContainer SID is reported and allowed only when -AllowPackageSid.
function Test-PrivateAcl([string] $Path, [string] $Label, [string] $PackageSid = '') {
    $acl = Get-Acl -LiteralPath $Path
    $entries = foreach ($rule in $acl.Access) {
        $sid = Get-RuleSid $rule
        "$($rule.AccessControlType):$sid=$($rule.FileSystemRights)$(if ($rule.IsInherited) { '(inherited)' })"
        if ($rule.AccessControlType -ne 'Allow') { continue }
        if ($sid -eq 'S-1-3-0' -and $rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
        if ($broadSids.ContainsKey($sid)) { Fail "$Label grants $($broadSids[$sid]) ($sid) $($rule.FileSystemRights): $Path" }
        elseif ($allowedSids -notcontains $sid -and $sid -ne $PackageSid) { Fail "$Label grants an unexpected identity $sid ($($rule.IdentityReference)): $Path" }
    }
    Write-Host "ACL $Label $Path :: $($entries -join '; ')"
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
$packageSid = ''
if ($Mode -eq 'Packaged') {
    $package = Get-AppxPackage -Name 'TrackerMaster.TestOnly'
    if (!$package) { throw 'The test package is not installed.' }
    $packageRoot = Join-Path $env:LOCALAPPDATA "Packages\$($package.PackageFamilyName)"
    $webDirs += Join-Path $packageRoot "LocalCache\Local\$identifier"
    if (Test-Path -LiteralPath (Join-Path $packageRoot "LocalCache\Roaming\$identifier")) {
        Fail "Packaged data was virtualized into the package cache instead of $dataDir."
    }
    $packageSid = (Get-Acl -LiteralPath $packageRoot).Access | ForEach-Object { Get-RuleSid $_ } |
        Where-Object { $_ -like 'S-1-15-2-*' -and $_ -ne 'S-1-15-2-1' -and $_ -ne 'S-1-15-2-2' } | Select-Object -First 1
    Write-Host "Package $($package.PackageFullName) AppContainer SID: $packageSid"
}

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
        Where-Object { $_.CreationTime -ge $since -and ($_.Name -match $appPattern) })
    if ($shared -eq $env:TEMP) {
        # Per-user TEMP is private to the account; SQLite temp files (etilqs_*) must still be gone.
        if ($hits.Count) { Fail "Leftover files in the user's TEMP: $($hits.FullName -join ', ')" }
        Test-PrivateAcl $env:TEMP 'user-temp'
    } elseif ($hits.Count) { Fail "Application files in a shared location: $($hits.FullName -join ', ')" }
    Write-Host "OUTSIDE $shared new matching items: $($hits.Count)"
}

# 4. ACL of every file and folder in the profile.
foreach ($item in $dataItems) { Test-PrivateAcl $item.FullName 'data' }
foreach ($item in $webItems) { Test-PrivateAcl $item.FullName 'webview' $packageSid }
Write-Host "ACL checked $(@($dataItems).Count) data items and $(@($webItems).Count) webview items"

# 5. Logs and diagnostics contain no client, project, task names or descriptions.
Test-NoSecret ($dataItems + @($webItems)) $secrets 'profile'
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
        # net user creates a standard account (local Users group only). The password is never printed.
        & net.exe user $userName $plain /add /comment:"TrackerMaster CI DEV-14 (ephemeral)" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not create the temporary account ($LASTEXITCODE)." }
        Remove-Variable plain
        $userSid = ([Security.Principal.NTAccount] "$env:COMPUTERNAME\$userName").Translate([Security.Principal.SecurityIdentifier]).Value
        Copy-Item -LiteralPath (Resolve-Path $Executable) -Destination (Join-Path $shared 'tracker-master.exe')
        Set-Content -LiteralPath (Join-Path $shared 'targets.txt') -Value $targets -Encoding utf8
        Set-Content -LiteralPath (Join-Path $shared 'second-user.ps1') -Encoding utf8 -Value @'
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
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
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
$admin = $principal.IsInRole([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
[pscustomobject] @{ user = $env:USERNAME; admin = $admin; appData = $env:APPDATA; ownDataExistedBefore = $existedBefore; ready = $ready; exit = "$exitCode"; reads = @($reads) } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $root 'result.json') -Encoding utf8
'@
        & icacls.exe $shared /grant "${userName}:(OI)(CI)M" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not grant the test account access to the exchange folder.' }
        $credential = [pscredential]::new("$env:COMPUTERNAME\$userName", $secure)
        $pwsh = (Get-Command pwsh).Source
        $helper = Start-Process -FilePath $pwsh -Credential $credential -LoadUserProfile -WorkingDirectory $shared -PassThru -Wait `
            -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $shared 'second-user.ps1'))
        if ($helper.ExitCode -ne 0) { Fail "The second account helper exited with $($helper.ExitCode)." }
        $result = Get-Content -LiteralPath (Join-Path $shared 'result.json') -Raw | ConvertFrom-Json
        Write-Host "SECOND_ACCOUNT user=$($result.user) admin=$($result.admin) appData=$($result.appData) ownDataExistedBefore=$($result.ownDataExistedBefore) ready=$($result.ready) exit=$($result.exit)"
        if ($result.user -ne $userName) { Fail "The helper ran as '$($result.user)', not the test account." }
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
            & net.exe user $userName /delete | Out-Null
            Get-CimInstance Win32_UserProfile | Where-Object SID -eq $userSid | Remove-CimInstance -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $shared -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($failures.Count) { throw "DEV-14 file protection: $($failures.Count) failure(s)." }
Write-Host "PASS: DEV-14 file protection ($Mode): private ACLs, nothing in shared locations, no user data in diagnostics$(if ($Mode -eq 'Unpackaged') { ', second account isolated' })"
