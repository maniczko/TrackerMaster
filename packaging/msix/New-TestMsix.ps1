[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Executable,
    [Parameter(Mandatory)] [string] $Output,
    [version] $Version = '0.1.0.0'
)

$ErrorActionPreference = 'Stop'
$parts = @($Version.Major, $Version.Minor, $Version.Build, $Version.Revision)
if ($Version.Major -eq 0 -and $Version.Minor -eq 0 -and $Version.Build -eq 0 -and $Version.Revision -eq 0) {
    throw 'Package version must be greater than 0.0.0.0.'
}
if (@($parts | Where-Object { $_ -lt 0 -or $_ -gt 65535 }).Count -ne 0) {
    throw 'Use a four-part package version with values from 0 to 65535.'
}
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
$manifestTemplate = Join-Path $PSScriptRoot 'AppxManifest.test.xml'
[xml] $manifestXml = Get-Content -Raw -LiteralPath $manifestTemplate
$manifestXml.Package.Identity.SetAttribute('Version', $Version.ToString())
$manifest = New-TemporaryFile
$mapping = New-TemporaryFile
try {
    $manifestXml.Save($manifest.FullName)
    $map = @('[Files]', ('"{0}" "AppxManifest.xml"' -f $manifest.FullName), ('"{0}" "tracker-master.exe"' -f $source))
    foreach ($name in @('StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png')) {
        $icon = (Get-Item -LiteralPath (Join-Path $icons $name)).FullName
        $map += ('"{0}" "Assets\{1}"' -f $icon, $name)
    }
    Set-Content -LiteralPath $mapping.FullName -Value $map -Encoding Unicode
    & $sdk pack /f $mapping.FullName /p $destination /no
    if ($LASTEXITCODE -ne 0) { throw "MakeAppx failed ($LASTEXITCODE)." }
    Get-FileHash -LiteralPath $destination -Algorithm SHA256
} finally {
    Remove-Item -LiteralPath $mapping.FullName, $manifest.FullName
}
