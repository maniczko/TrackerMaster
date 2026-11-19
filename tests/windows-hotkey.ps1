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
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
}
'@
Add-Type -AssemblyName System.Windows.Forms
$otherApp = [System.Windows.Forms.Form]::new()
$otherApp.Text = 'TrackerMaster independent hotkey test'
$otherApp.TopMost = $true
$otherApp.ShowInTaskbar = $false
try {
    $otherApp.Show()
    $otherApp.Activate()
    [void][TrackerHotkeyTest]::SetForegroundWindow($otherApp.Handle)
    [System.Windows.Forms.Application]::DoEvents()
    if ([TrackerHotkeyTest]::GetForegroundWindow() -ne $otherApp.Handle) {
        throw 'Could not focus the independent test window.'
    }
    try {
        [TrackerHotkeyTest]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
        [TrackerHotkeyTest]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
        [TrackerHotkeyTest]::keybd_event(0x7A, 0, 0, [UIntPtr]::Zero)
        # Simulate repeated key-down messages while the same key remains held.
        for ($i = 0; $i -lt 12; $i++) {
            Start-Sleep -Milliseconds 100
            [TrackerHotkeyTest]::keybd_event(0x7A, 0, 0, [UIntPtr]::Zero)
        }
    } finally {
        [TrackerHotkeyTest]::keybd_event(0x7A, 0, 2, [UIntPtr]::Zero)
        [TrackerHotkeyTest]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
        [TrackerHotkeyTest]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
    }
    [Console]::Out.WriteLine('hotkey-sent')
    [Console]::Out.Flush()
    Start-Sleep -Seconds 8
    if ([TrackerHotkeyTest]::GetForegroundWindow() -ne $otherApp.Handle) {
        throw 'The independent test window lost focus during the hotkey test.'
    }
    'independent-window-focused'
} finally {
    $otherApp.Dispose()
}
