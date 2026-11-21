[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Executable,
    [Parameter(Mandatory)] [string] $Output,
    [Parameter(Mandatory)] [string] $PackageName,
    [Parameter(Mandatory)] [string] $Publisher,
    [Parameter(Mandatory)] [string] $PublisherDisplayName,
    [Parameter(Mandatory)] [string] $Version
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($PackageName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$') {
    throw 'Invalid Package/Identity/Name. Use the exact name from Partner Center.'
}
if ([string]::IsNullOrWhiteSpace($Publisher) -or $Publisher -notmatch '^CN=' -or
    $Publisher -match '[<>\x00-\x1f]') {
    throw 'Invalid Package/Identity/Publisher. Copy the exact DN from Partner Center.'
}
if ([string]::IsNullOrWhiteSpace($PublisherDisplayName) -or
    $PublisherDisplayName -match '[\x00-\x1f]') {
    throw 'Invalid PublisherDisplayName.'
}
if ($Version -notmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}\.0$') {
    throw 'Store MSIX version must have four parts and end in .0.'
}
$numbers = $Version.Split('.') | ForEach-Object { [int] $_ }
if (@($numbers | Where-Object { $_ -gt 65535 }).Count -gt 0 -or
    ($numbers[0] -eq 0 -and $numbers[1] -eq 0 -and $numbers[2] -eq 0)) {
    throw 'Invalid MSIX version.'
}

$source = (Get-Item -LiteralPath $Executable -ErrorAction Stop).FullName
$destination = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Output)
if ([IO.Path]::GetExtension($destination) -ine '.msix' -or (Test-Path -LiteralPath $destination)) {
    throw 'Output must be a new .msix path.'
}
$binary = [IO.File]::ReadAllBytes($source)
if ($binary.Length -lt 64 -or $binary[0] -ne 77 -or $binary[1] -ne 90) {
    throw 'Expected a Windows PE executable.'
}
$peOffset = [BitConverter]::ToInt32($binary, 60)
if ($peOffset -lt 64 -or $peOffset -gt $binary.Length - 6 -or
    [BitConverter]::ToUInt32($binary, $peOffset) -ne 0x00004550 -or
    [BitConverter]::ToUInt16($binary, $peOffset + 4) -ne 0x8664) {
    throw 'Expected a Windows x64 executable.'
}
if (![Text.Encoding]::UTF8.GetString($binary).Contains('pl.tracker.personal.testonly')) {
    throw 'Refusing to package a binary without the isolated test profile.'
}

$sdkRoot = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Windows Kits\10\bin'
$sdk = Get-ChildItem -LiteralPath $sdkRoot -Directory |
    Where-Object { $_.Name -as [version] } |
    Sort-Object { [version] $_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName 'x64\makeappx.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
if (!$sdk) { throw 'MakeAppx.exe missing from Windows SDK.' }

$manifestTemplate = Join-Path $PSScriptRoot 'AppxManifest.template.xml'
$icons = Join-Path $PSScriptRoot '..\..\..\src-tauri\icons'
[xml] $manifestXml = Get-Content -Raw -LiteralPath $manifestTemplate
$manifestXml.Package.Identity.SetAttribute('Name', $PackageName)
$manifestXml.Package.Identity.SetAttribute('Publisher', $Publisher)
$manifestXml.Package.Identity.SetAttribute('Version', $Version)
$manifestXml.SelectSingleNode("//*[local-name()='PublisherDisplayName']").InnerText = $PublisherDisplayName

$parent = Split-Path -Parent $destination
if (!(Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
}
$temp = Join-Path ([IO.Path]::GetTempPath()) ('trackermaster-msix-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    $manifestPath = Join-Path $temp 'AppxManifest.xml'
    $mappingPath = Join-Path $temp 'mapping.txt'
    $manifestXml.Save($manifestPath)
    $map = @('[Files]', ('"{0}" "AppxManifest.xml"' -f $manifestPath), ('"{0}" "tracker-master.exe"' -f $source))
    foreach ($name in @('StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png')) {
        $icon = (Get-Item -LiteralPath (Join-Path $icons $name)).FullName
        $map += ('"{0}" "Assets\{1}"' -f $icon, $name)
    }
    Set-Content -LiteralPath $mappingPath -Value $map -Encoding Unicode
    & $sdk pack /f $mappingPath /p $destination /no
    if ($LASTEXITCODE -ne 0) { throw "MakeAppx pack failed with exit code $LASTEXITCODE" }

    # Validate the manifest in the actual package, not only the template.
    $unpacked = Join-Path $temp 'unpacked'
    & $sdk unpack /p $destination /d $unpacked /no
    if ($LASTEXITCODE -ne 0) { throw "MakeAppx unpack failed with exit code $LASTEXITCODE" }
    [xml] $packedManifest = Get-Content -Raw -LiteralPath (Join-Path $unpacked 'AppxManifest.xml')
    $actual = $packedManifest.Package.Identity
    if ($actual.Name -cne $PackageName -or $actual.Publisher -cne $Publisher -or
        $actual.Version -cne $Version -or $actual.ProcessorArchitecture -ne 'x64' -or
        $packedManifest.SelectSingleNode("//*[local-name()='PublisherDisplayName']").InnerText -cne $PublisherDisplayName) {
        throw 'Packaged identity does not match the requested Partner Center values.'
    }
    if (!(Test-Path -LiteralPath (Join-Path $unpacked 'tracker-master.exe'))) {
        throw 'Package is missing tracker-master.exe.'
    }
    Get-FileHash -LiteralPath $destination -Algorithm SHA256 | Format-List
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
