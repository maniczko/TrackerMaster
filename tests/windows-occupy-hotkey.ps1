$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'This test requires a disposable GitHub-hosted runner.'
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TrackerOccupiedHotkey {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnregisterHotKey(IntPtr window, int id);
}
'@
if (-not [TrackerOccupiedHotkey]::RegisterHotKey([IntPtr]::Zero, 1, 0x0003, 0x79)) {
    throw "Could not reserve Ctrl+Alt+F10: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
}
try {
    [Console]::Out.WriteLine('reserved')
    [Console]::Out.Flush()
    [void][Console]::In.ReadLine()
} finally {
    if (-not [TrackerOccupiedHotkey]::UnregisterHotKey([IntPtr]::Zero, 1)) {
        throw 'Could not release the reserved test shortcut.'
    }
}
