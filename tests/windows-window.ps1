param(
    [Parameter(Mandatory)][ValidateSet('Find', 'Close', 'Visibility')][string] $Action,
    [Parameter(Mandatory)][int] $PrimaryPid,
    [long] $WindowHandle = 0
)
$ErrorActionPreference = 'Stop'

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'This test requires a disposable GitHub-hosted runner.'
}

if ($Action -eq 'Find') {
    $process = Get-Process -Id $PrimaryPid -ErrorAction Stop
    if ($process.MainWindowTitle -eq 'Personal Time Tracker') {
        $process.MainWindowHandle.ToInt64()
    }
    return
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class TrackerTestWindow {
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint owner);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessageW(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
}
'@

$window = [IntPtr]::new($WindowHandle)
[uint32] $owner = 0
if ([TrackerTestWindow]::GetWindowThreadProcessId($window, [ref] $owner) -eq 0 -or $owner -ne $PrimaryPid) {
    throw 'The original test window no longer belongs to the launched application.'
}
if ($Action -eq 'Close') {
    if (![TrackerTestWindow]::PostMessageW($window, 0x0010, [UIntPtr]::Zero, [IntPtr]::Zero)) {
        throw "WM_CLOSE failed with error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
    }
    'posted'
} elseif ([TrackerTestWindow]::IsWindowVisible($window)) {
    'visible'
} else {
    'hidden'
}
