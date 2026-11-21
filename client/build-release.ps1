#Requires -Version 7.6
# Builds a release of the PowerShell client into $OutDir:
#   wowget-<version>.zip         the module, wowget.ps1, runtime.json, registry.json, the release public
#                                key, the launchers, LICENSE and THIRD-PARTY-NOTICES.txt
#   wowget-<version>.zip.sha256  "<sha256>  wowget-<version>.zip"
#   wowget-<version>.zip.sig     ECDSA P-256 signature (DER) of the zip's SHA-256
#   install.ps1, install.sh      the installers with the release public key filled in
#
# The signing key is a PKCS#8 PEM file (-SigningKeyPath) or the PEM text in WOWGET_SIGNING_KEY. It
# must belong to the public key in release-public-key.txt (or -PublicKeyPath), the one place that key
# is defined. registry.json is -RegistryJson (the service's /v1/registry response) when given, else it
# is built from registry/addons.toml.
param(
    [Parameter(Mandatory)][string]$Version,
    [string]$OutDir = ([System.IO.Path]::Combine($PSScriptRoot, '..', 'dist', 'client')),
    [string]$SigningKeyPath,
    [string]$PublicKeyPath = ([System.IO.Path]::Combine($PSScriptRoot, 'release-public-key.txt')),
    [string]$RegistryJson,
    [string]$RegistryToml = ([System.IO.Path]::Combine($PSScriptRoot, '..', 'registry', 'addons.toml'))
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
$Version = $Version.TrimStart('v')
if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { throw "Version `"$Version`" is not a release version such as 1.2.0." }

$module = Import-Module ([System.IO.Path]::Combine($PSScriptRoot, 'Wowget', 'Wowget.psd1')) -Force -PassThru
$utf8 = [System.Text.UTF8Encoding]::new($false)

# Keys: the public key must be a P-256 key, and the signing key its private half.
$publicKey = ([System.IO.File]::ReadAllText($PublicKeyPath)).Trim()
$pem = if ($SigningKeyPath) { [System.IO.File]::ReadAllText($SigningKeyPath) } else { $env:WOWGET_SIGNING_KEY }
if (-not $pem) { throw 'No signing key: pass -SigningKeyPath or set WOWGET_SIGNING_KEY.' }
$signer = [System.Security.Cryptography.ECDsa]::Create()
$verifier = [System.Security.Cryptography.ECDsa]::Create()
try {
    $signer.ImportFromPem($pem)
    try {
        $read = 0
        $verifier.ImportSubjectPublicKeyInfo([System.Convert]::FromBase64String($publicKey), [ref]$read)
    } catch {
        throw "$PublicKeyPath does not hold a base64 SubjectPublicKeyInfo public key; put the release public key there."
    }
    # install.ps1 imports the key as a NIST P-256 key blob.
    if ($verifier.ExportParameters($false).Curve.Oid.Value -ne '1.2.840.10045.3.1.7') { throw "$PublicKeyPath is not a NIST P-256 key." }
    $probe = [System.Security.Cryptography.SHA256]::HashData([byte[]](1, 2, 3))
    $format = [System.Security.Cryptography.DSASignatureFormat]::Rfc3279DerSequence
    if (-not $verifier.VerifyHash($probe, $signer.SignHash($probe, $format), $format)) {
        throw "The signing key does not belong to the public key in $PublicKeyPath; clients would refuse this release."
    }

    $files = [ordered]@{}
    $source = [System.IO.Path]::Combine($PSScriptRoot, 'Wowget')
    foreach ($path in ([System.IO.Directory]::GetFiles($source) | Sort-Object)) {
        $name = [System.IO.Path]::GetFileName($path)
        $text = [System.IO.File]::ReadAllText($path)
        if ($name -eq 'Wowget.psm1') {
            $stamped = $text -replace "(?m)^\`$script:WowgetVersion = '[^']*'", "`$script:WowgetVersion = '$Version'"
            if ($stamped -eq $text) { throw 'Wowget.psm1 has no $script:WowgetVersion line to stamp.' }
            $text = $stamped
        }
        $files["Wowget/$name"] = $text
    }
    $files['wowget.ps1'] = [System.IO.File]::ReadAllText([System.IO.Path]::Combine($PSScriptRoot, 'wowget.ps1'))
    $files['runtime.json'] = [System.IO.File]::ReadAllText([System.IO.Path]::Combine($PSScriptRoot, 'runtime.json'))
    $files['release-public-key.txt'] = "$publicKey`n"
    # cmd.exe expects CRLF line endings in batch files.
    $files['launchers/wowget.cmd'] = ([System.IO.File]::ReadAllText([System.IO.Path]::Combine($PSScriptRoot, 'launchers', 'wowget.cmd')) -replace "`r?`n", "`r`n")
    $files['launchers/wowget.sh'] = [System.IO.File]::ReadAllText([System.IO.Path]::Combine($PSScriptRoot, 'launchers', 'wowget.sh'))
    $files['LICENSE'] = [System.IO.File]::ReadAllText([System.IO.Path]::Combine($PSScriptRoot, '..', 'LICENSE'))
    $files['THIRD-PARTY-NOTICES.txt'] = "wowget's release zip contains no third-party code. The installers download PowerShell`n" +
    "from Microsoft's release (https://github.com/PowerShell/PowerShell), which is MIT licensed and carries`n" +
    "its own notices in its archive.`n"

    $registry = & $module {
        param($RegistryJson, $RegistryToml)
        if ($RegistryJson) {
            $text = Read-WowgetText $RegistryJson
            [void](ConvertFrom-WowgetRegistryDoc (ConvertFrom-WowgetJson $text))
            return $text
        }
        $data = ConvertFrom-WowgetToml (Read-WowgetText $RegistryToml) $RegistryToml
        $list = { param($v) if ($v -is [System.Collections.IList]) { , [string[]]@($v | Where-Object { $_ -is [string] }) } else { , [string[]]@() } }
        $addons = foreach ($a in @($data['addon'])) {
            if (-not ($a['name'] -is [string]) -or -not ($a['source'] -is [string])) { continue }
            [ordered]@{
                name = $a['name']; aliases = (& $list $a['aliases']); source = $a['source']; flavors = (& $list $a['flavors'])
                folders = (& $list $a['folders']); description = $(if ($a['description'] -is [string]) { $a['description'] } else { $null })
                disabled = $(if ($a['disabled'] -is [string]) { $a['disabled'] } else { $null })
            }
        }
        # Like the service, the version is a hash of the content.
        $body = ConvertTo-WowgetJsonText ([ordered]@{ version = ''; updatedAt = $null; addons = @($addons) }) -MultilineDepth 0
        $hash = [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($body))).ToLowerInvariant().Substring(0, 16)
        return (ConvertTo-WowgetJsonText ([ordered]@{ version = $hash; updatedAt = $null; addons = @($addons) }) -MultilineDepth 0) + "`n"
    } $RegistryJson $RegistryToml
    $files['registry.json'] = $registry

    [void][System.IO.Directory]::CreateDirectory($OutDir)
    $zipName = "wowget-$Version.zip"
    $zipPath = [System.IO.Path]::Combine($OutDir, $zipName)
    if ([System.IO.File]::Exists($zipPath)) { [System.IO.File]::Delete($zipPath) }
    $stream = [System.IO.File]::Create($zipPath)
    try {
        $zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($name in $files.Keys) {
                $entry = $zip.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
                $bytes = $utf8.GetBytes($files[$name])
                $out = $entry.Open()
                try { $out.Write($bytes, 0, $bytes.Length) } finally { $out.Dispose() }
            }
        } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }

    $read = [System.IO.File]::OpenRead($zipPath)
    try { $hash = [System.Security.Cryptography.SHA256]::HashData($read) } finally { $read.Dispose() }
    $hex = [System.Convert]::ToHexString($hash).ToLowerInvariant()
    [System.IO.File]::WriteAllText("$zipPath.sha256", "$hex  $zipName`n", $utf8)
    [System.IO.File]::WriteAllBytes("$zipPath.sig", $signer.SignHash($hash, $format))

    foreach ($installer in 'install.ps1', 'install.sh') {
        $text = [System.IO.File]::ReadAllText([System.IO.Path]::Combine($PSScriptRoot, $installer))
        if (-not $text.Contains('@WOWGET_RELEASE_PUBLIC_KEY@')) { throw "$installer has no @WOWGET_RELEASE_PUBLIC_KEY@ to fill in." }
        [System.IO.File]::WriteAllText([System.IO.Path]::Combine($OutDir, $installer), $text.Replace('@WOWGET_RELEASE_PUBLIC_KEY@', $publicKey), $utf8)
    }
    Write-Output "Built $zipPath ($hex)"
} finally {
    $signer.Dispose()
    $verifier.Dispose()
}
