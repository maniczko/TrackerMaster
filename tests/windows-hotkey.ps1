$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'This test requires a disposable GitHub-hosted runner.'
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class TrackerHotkeyTest {
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extraInfo);
}
'@

# Release every modifier even if a test step fails.
try {
    [TrackerHotkeyTest]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
    [TrackerHotkeyTest]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [TrackerHotkeyTest]::keybd_event(0x7B, 0, 0, [UIntPtr]::Zero)
} finally {
    [TrackerHotkeyTest]::keybd_event(0x7B, 0, 2, [UIntPtr]::Zero)
    [TrackerHotkeyTest]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [TrackerHotkeyTest]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
}
