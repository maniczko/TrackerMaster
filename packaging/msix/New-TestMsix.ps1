[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Executable,
    [Parameter(Mandatory)] [string] $Output
)

$ErrorActionPreference = 'Stop'
$source = (Get-Item -LiteralPath $Executable).FullName
$destination = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Output)
if ([IO.Path]::GetExtension($destination) -ine '.msix' -or (Test-Path -LiteralPath $destination)) {
    throw 'Output must be a new .msix file.'
}

$binary = [IO.File]::ReadAllBytes($source)
$utf8 = [Text.Encoding]::UTF8.GetString($binary)
if (!$utf8.Contains('pl.tracker.personal.testonly')) {
    throw 'Use the executable built with src-tauri/tauri.isolated.conf.json.'
}
if ($binary.Length -lt 64 -or $binary[0] -ne 77 -or $binary[1] -ne 90) {
    throw 'Expected a Windows PE executable.'
}
$peOffset = [BitConverter]::ToInt32($binary, 60)
if ($peOffset -lt 64 -or $peOffset -gt $binary.Length - 6 -or
    [BitConverter]::ToUInt32($binary, $peOffset) -ne 0x00004550 -or
    [BitConverter]::ToUInt16($binary, $peOffset + 4) -ne 0x8664) {
    throw 'Expected a Windows x64 executable.'
}

$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$sdk = Get-ChildItem -LiteralPath $sdkRoot -Directory |
    Where-Object { $_.Name -as [version] } |
    Sort-Object { [version] $_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName 'x64\makeappx.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
if (!$sdk) { throw 'Windows SDK MakeAppx.exe was not found.' }

$icons = Join-Path $PSScriptRoot '..\..\src-tauri\icons'
$manifest = Join-Path $PSScriptRoot 'AppxManifest.test.xml'
$mapping = New-TemporaryFile
try {
    $map = @('[Files]', ('"{0}" "AppxManifest.xml"' -f $manifest), ('"{0}" "tracker-master.exe"' -f $source))
    foreach ($name in @('StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png')) {
        $icon = (Get-Item -LiteralPath (Join-Path $icons $name)).FullName
        $map += ('"{0}" "Assets\{1}"' -f $icon, $name)
    }
    Set-Content -LiteralPath $mapping.FullName -Value $map -Encoding Unicode
    & $sdk pack /f $mapping.FullName /p $destination /no
    if ($LASTEXITCODE -ne 0) { throw "MakeAppx failed ($LASTEXITCODE)." }
    Get-FileHash -LiteralPath $destination -Algorithm SHA256
} finally {
    Remove-Item -LiteralPath $mapping.FullName
}
