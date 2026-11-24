# One packer for both MSIX variants (D11), from one manifest template (AppxManifest.template.xml) and one
# identity file (identities.json). "Test" is installed and tested in CI (msix-lifecycle, DEV-14); "Store" is
# the Partner Center candidate built only by windows-msix-store.yml (workflow_dispatch on main). Neither is
# signed here. Both package only the isolated test build (profile pl.tracker.personal.testonly).
[CmdletBinding()]
param(
    [string] $Executable,
    [Parameter(Mandatory)] [string] $Output,
    [version] $Version = '0.1.0.0',
    [ValidateSet('Test', 'Store')] [string] $Variant = 'Test',
    # Write only the filled-in AppxManifest.xml to -Output (for review and comparison); nothing is packed.
    [switch] $ManifestOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$parts = @($Version.Major, $Version.Minor, $Version.Build, $Version.Revision)
if ($Version.Major -eq 0 -and $Version.Minor -eq 0 -and $Version.Build -eq 0 -and $Version.Revision -eq 0) {
    throw 'Package version must be greater than 0.0.0.0.'
}
if (@($parts | Where-Object { $_ -lt 0 -or $_ -gt 65535 }).Count -ne 0) {
    throw 'Use a four-part package version with values from 0 to 65535.'
}
# Microsoft Store packages must keep the fourth part at 0; the test variant uses it for updates in CI.
if ($Variant -eq 'Store' -and $Version.Revision -ne 0) {
    throw 'A Store package version must end in .0 (for example 0.1.1.0).'
}

$identities = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'identities.json') | ConvertFrom-Json
$identity = $identities.($Variant.ToLowerInvariant())
if (!$identity) { throw "identities.json has no '$($Variant.ToLowerInvariant())' identity." }
if ($identity.name -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$') { throw 'Invalid package identity name.' }
if ($identity.publisher -notmatch '^CN=' -or $identity.publisher -match '[<>\x00-\x1f]') { throw 'Invalid package publisher.' }
foreach ($field in 'publisherDisplayName', 'displayName', 'description') {
    if ([string]::IsNullOrWhiteSpace($identity.$field) -or $identity.$field -match '[\x00-\x1f]') { throw "Invalid $field." }
}

# Fill the template. Only identity, version and the three names differ between the variants.
[xml] $manifestXml = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'AppxManifest.template.xml')
$ns = [Xml.XmlNamespaceManager]::new($manifestXml.NameTable)
$ns.AddNamespace('m', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10')
$ns.AddNamespace('uap', 'http://schemas.microsoft.com/appx/manifest/uap/windows10')
$identityNode = $manifestXml.SelectSingleNode('/m:Package/m:Identity', $ns)
$identityNode.SetAttribute('Name', $identity.name)
$identityNode.SetAttribute('Publisher', $identity.publisher)
$identityNode.SetAttribute('Version', $Version.ToString())
$manifestXml.SelectSingleNode('/m:Package/m:Properties/m:DisplayName', $ns).InnerText = $identity.displayName
$manifestXml.SelectSingleNode('/m:Package/m:Properties/m:PublisherDisplayName', $ns).InnerText = $identity.publisherDisplayName
$visual = $manifestXml.SelectSingleNode('/m:Package/m:Applications/m:Application/uap:VisualElements', $ns)
$visual.SetAttribute('DisplayName', $identity.displayName)
$visual.SetAttribute('Description', $identity.description)
if ($manifestXml.OuterXml -match '@[A-Za-z]+@') { throw 'The manifest template has an unfilled value.' }

$destination = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Output)
if (Test-Path -LiteralPath $destination) { throw 'Output must be a new file.' }
if ($ManifestOnly) {
    if ([IO.Path]::GetExtension($destination) -ine '.xml') { throw 'With -ManifestOnly, Output must be a new .xml file.' }
    $manifestXml.Save($destination)
    return
}
if ([IO.Path]::GetExtension($destination) -ine '.msix') { throw 'Output must be a new .msix file.' }
if ([string]::IsNullOrWhiteSpace($Executable)) { throw 'Executable is required to build a package.' }
$source = (Get-Item -LiteralPath $Executable).FullName

# Isolation: package only the build made with tauri.isolated.conf.json and VITE_TRACKER_TEST_MODE=1.
# build.rs embeds TRACKERMASTER_BUILD_PROFILE=testonly only for that build; the identifier text alone is also
# present in a production build, so it is checked in addition, never on its own.
$binary = [IO.File]::ReadAllBytes($source)
$utf8 = [Text.Encoding]::UTF8.GetString($binary)
if (!$utf8.Contains('TRACKERMASTER_BUILD_PROFILE=testonly;') -or $utf8.Contains('TRACKERMASTER_BUILD_PROFILE=production;') -or
    !$utf8.Contains('pl.tracker.personal.testonly')) {
    throw 'Refusing to package: not the isolated test build (build with VITE_TRACKER_TEST_MODE=1 and src-tauri/tauri.isolated.conf.json).'
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
$temp = Join-Path ([IO.Path]::GetTempPath()) ('trackermaster-msix-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    $manifest = Join-Path $temp 'AppxManifest.xml'
    $mapping = Join-Path $temp 'mapping.txt'
    $manifestXml.Save($manifest)
    $map = @('[Files]', ('"{0}" "AppxManifest.xml"' -f $manifest), ('"{0}" "tracker-master.exe"' -f $source))
    foreach ($name in @('StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png')) {
        $icon = (Get-Item -LiteralPath (Join-Path $icons $name)).FullName
        $map += ('"{0}" "Assets\{1}"' -f $icon, $name)
    }
    Set-Content -LiteralPath $mapping -Value $map -Encoding Unicode
    & $sdk pack /f $mapping /p $destination /no
    if ($LASTEXITCODE -ne 0) { throw "MakeAppx failed ($LASTEXITCODE)." }

    # Check the package itself, not only the template: identity, version, names and the executable.
    $unpacked = Join-Path $temp 'unpacked'
    & $sdk unpack /p $destination /d $unpacked /no
    if ($LASTEXITCODE -ne 0) { throw "MakeAppx unpack failed ($LASTEXITCODE)." }
    [xml] $packed = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $unpacked 'AppxManifest.xml')
    $packedNs = [Xml.XmlNamespaceManager]::new($packed.NameTable)
    $packedNs.AddNamespace('m', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10')
    $actual = $packed.SelectSingleNode('/m:Package/m:Identity', $packedNs)
    if ($actual.GetAttribute('Name') -cne $identity.name -or $actual.GetAttribute('Publisher') -cne $identity.publisher -or
        $actual.GetAttribute('Version') -cne $Version.ToString() -or $actual.GetAttribute('ProcessorArchitecture') -cne 'x64' -or
        $packed.SelectSingleNode('/m:Package/m:Properties/m:PublisherDisplayName', $packedNs).InnerText -cne $identity.publisherDisplayName -or
        $packed.SelectSingleNode('/m:Package/m:Properties/m:DisplayName', $packedNs).InnerText -cne $identity.displayName) {
        throw 'The packaged manifest does not match identities.json.'
    }
    $packedExe = Join-Path $unpacked 'tracker-master.exe'
    if (!(Test-Path -LiteralPath $packedExe) -or (Get-FileHash -LiteralPath $packedExe).Hash -ne (Get-FileHash -LiteralPath $source).Hash) {
        throw 'The package does not contain the checked executable.'
    }
    Write-Host "MSIX $Variant $($identity.name) $Version -> $destination"
    Get-FileHash -LiteralPath $destination -Algorithm SHA256
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
