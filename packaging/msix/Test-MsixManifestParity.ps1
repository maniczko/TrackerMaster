# Store manifest = tested manifest (D11). Builds both manifests with New-TestMsix.ps1 -ManifestOnly (no package)
# and checks that they differ only in identity, publisher display name, display name and description; that both
# target Windows 11 (MinVersion 10.0.22000.0); that neither turns off write virtualization globally (desktop6);
# and that the capabilities and the excluded data folder are exactly those of the package tested in CI.
[CmdletBinding()]
param([version] $Version = '0.1.0.0')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$temp = Join-Path ([IO.Path]::GetTempPath()) ('trackermaster-manifest-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    $manifests = @{}
    foreach ($variant in 'Test', 'Store') {
        $path = Join-Path $temp "$variant.xml"
        & (Join-Path $PSScriptRoot 'New-TestMsix.ps1') -Variant $variant -Version $Version -Output $path -ManifestOnly
        $manifests[$variant] = [xml] (Get-Content -Raw -Encoding UTF8 -LiteralPath $path)
    }
    $identities = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'identities.json') | ConvertFrom-Json
    foreach ($variant in 'Test', 'Store') {
        $xml = $manifests[$variant]
        $ns = [Xml.XmlNamespaceManager]::new($xml.NameTable)
        $ns.AddNamespace('m', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10')
        $ns.AddNamespace('uap', 'http://schemas.microsoft.com/appx/manifest/uap/windows10')
        $ns.AddNamespace('rescap', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities')
        $ns.AddNamespace('virtualization', 'http://schemas.microsoft.com/appx/manifest/virtualization/windows10')
        $family = $xml.SelectSingleNode('/m:Package/m:Dependencies/m:TargetDeviceFamily', $ns)
        if ($family.GetAttribute('Name') -cne 'Windows.Desktop' -or $family.GetAttribute('MinVersion') -cne '10.0.22000.0') {
            throw "${variant}: the package must target Windows 11 (MinVersion 10.0.22000.0)."
        }
        if ($xml.OuterXml -match 'windows10/6' -or $xml.OuterXml -match 'desktop6') {
            throw "${variant}: desktop6 (global FileSystemWriteVirtualization) is not part of the tested manifest."
        }
        $capabilities = @($xml.SelectNodes('/m:Package/m:Capabilities/*', $ns) | ForEach-Object { "$($_.Prefix):$($_.GetAttribute('Name'))" })
        if (($capabilities -join ',') -cne 'rescap:runFullTrust,rescap:unvirtualizedResources') {
            throw "${variant}: unexpected capabilities $($capabilities -join ', ')."
        }
        $excluded = @($xml.SelectNodes('//virtualization:ExcludedDirectory', $ns) | ForEach-Object { $_.InnerText })
        if (($excluded -join ',') -cne '$(KnownFolder:RoamingAppData)\pl.tracker.personal.testonly') {
            throw "${variant}: only the isolated test data folder may be excluded from virtualization."
        }
        $identity = $identities.($variant.ToLowerInvariant())
        $node = $xml.SelectSingleNode('/m:Package/m:Identity', $ns)
        if ($node.GetAttribute('Name') -cne $identity.name -or $node.GetAttribute('Publisher') -cne $identity.publisher -or $node.GetAttribute('Version') -cne $Version.ToString()) {
            throw "${variant}: identity does not match identities.json."
        }
        # Blank what is allowed to differ, so the rest can be compared byte for byte.
        foreach ($attribute in 'Name', 'Publisher') { $node.SetAttribute($attribute, '') }
        $xml.SelectSingleNode('/m:Package/m:Properties/m:DisplayName', $ns).InnerText = ''
        $xml.SelectSingleNode('/m:Package/m:Properties/m:PublisherDisplayName', $ns).InnerText = ''
        $visual = $xml.SelectSingleNode('/m:Package/m:Applications/m:Application/uap:VisualElements', $ns)
        foreach ($attribute in 'DisplayName', 'Description') { $visual.SetAttribute($attribute, '') }
    }
    if ($manifests['Test'].OuterXml -cne $manifests['Store'].OuterXml) {
        throw 'The Store manifest differs from the tested manifest in more than identity and names.'
    }
    Write-Host 'PASS: Store manifest = tested manifest except identity and names; Windows 11 only; no desktop6; same capabilities and excluded data folder.'
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
