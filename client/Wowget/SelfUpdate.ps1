# self-update (SPEC-POWERSHELL.md, "Self-update"), the release signature check and the clean-up of
# app and runtime versions that are no longer used.
#
# Install root layout: app/<version>/ (this module is app/<version>/Wowget), runtime/<version>/, and
# "current" holding "<app version> <runtime version>", which the launchers read.

$script:ReleaseRepo = 'axelekwall/wowget'
$script:ReleaseHosts = @('github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com')

# Runs "<pwsh> -File <wowget.ps1> --version" and returns its output. Tests replace it.
$script:WowgetVersionProbe = {
    param([string]$Pwsh, [string]$Script)
    $out = & $Pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Script --version 2>&1
    if ($LASTEXITCODE -ne 0) { throw "exited with code $LASTEXITCODE" }
    return (@($out) -join "`n")
}

# The release public key (base64 SubjectPublicKeyInfo of an ECDSA P-256 key). It is read from
# release-public-key.txt in the app directory, which the signed zip carries, so the key is defined in
# one file in the repository; tests set it directly.
$script:WowgetReleasePublicKey = $null

function Get-WowgetReleasePublicKey {
    if ($null -ne $script:WowgetReleasePublicKey) { return $script:WowgetReleasePublicKey }
    $path = [System.IO.Path]::Combine((Split-Path -Parent $script:WowgetModuleRoot), 'release-public-key.txt')
    $text = if ([System.IO.File]::Exists($path)) { (Read-WowgetText $path).Trim() } else { '' }
    return $text
}

# Whether $Signature (DER-encoded ECDSA) signs the SHA-256 of the file at $Path with $PublicKey.
function Test-WowgetReleaseSignature {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][byte[]]$Signature, [Parameter(Mandatory)][AllowEmptyString()][string]$PublicKey)
    try { $keyBytes = [System.Convert]::FromBase64String($PublicKey) } catch { $keyBytes = $null }
    if (-not $keyBytes) {
        throw (New-WowgetError 'source' 'This wowget has no valid release public key, so it cannot verify a release; reinstall it with the install script.')
    }
    $ecdsa = [System.Security.Cryptography.ECDsa]::Create()
    try {
        $read = 0
        $ecdsa.ImportSubjectPublicKeyInfo($keyBytes, [ref]$read)
        $stream = [System.IO.File]::OpenRead($Path)
        try { $hash = [System.Security.Cryptography.SHA256]::HashData($stream) } finally { $stream.Dispose() }
        return $ecdsa.VerifyHash($hash, $Signature, [System.Security.Cryptography.DSASignatureFormat]::Rfc3279DerSequence)
    } catch [System.Security.Cryptography.CryptographicException] {
        return $false
    } finally {
        $ecdsa.Dispose()
    }
}

function ConvertFrom-WowgetVersion {
    param([Parameter(Mandatory)][string]$Version)
    if ($Version.Trim() -notmatch '^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$') { return $null }
    return [pscustomobject]@{ Core = @([long]$Matches[1], [long]$Matches[2], [long]$Matches[3]); Pre = $Matches[4] }
}

# Compares two release versions; a pre-release sorts before its release.
function Compare-WowgetVersion {
    param([Parameter(Mandatory)][string]$A, [Parameter(Mandatory)][string]$B)
    $pa = ConvertFrom-WowgetVersion $A
    $pb = ConvertFrom-WowgetVersion $B
    if (-not $pa -or -not $pb) { throw (New-WowgetError 'source' "Cannot compare versions `"$A`" and `"$B`".") }
    for ($i = 0; $i -lt 3; $i++) {
        if ($pa.Core[$i] -ne $pb.Core[$i]) { return [Math]::Sign($pa.Core[$i] - $pb.Core[$i]) }
    }
    if ($pa.Pre -ceq $pb.Pre) { return 0 }
    if (-not $pa.Pre) { return 1 }
    if (-not $pb.Pre) { return -1 }
    # Dot-separated identifiers, numeric ones compared as numbers.
    $xa = $pa.Pre.Split('.'); $xb = $pb.Pre.Split('.')
    for ($i = 0; $i -lt [Math]::Min($xa.Count, $xb.Count); $i++) {
        $na = 0L; $nb = 0L
        $numA = [long]::TryParse($xa[$i], [ref]$na); $numB = [long]::TryParse($xb[$i], [ref]$nb)
        $c = if ($numA -and $numB) { [Math]::Sign($na - $nb) } elseif ($numA) { -1 } elseif ($numB) { 1 } else { [Math]::Sign([string]::CompareOrdinal($xa[$i], $xb[$i])) }
        if ($c -ne 0) { return $c }
    }
    return [Math]::Sign($xa.Count - $xb.Count)
}

# The install root this module runs from, or $null when it does not run from an installed layout.
function Get-WowgetInstallRoot {
    param([string]$ModuleRoot = $script:WowgetModuleRoot)
    $appDir = Split-Path -Parent $ModuleRoot
    $apps = Split-Path -Parent $appDir
    if (-not $apps -or [System.IO.Path]::GetFileName($apps) -cne 'app') { return $null }
    $root = Split-Path -Parent $apps
    if (-not [System.IO.File]::Exists([System.IO.Path]::Combine($root, 'current'))) { return $null }
    return $root
}

# The two words of "current" (or "previous"): App and Runtime, or $null.
function Read-WowgetVersionsFile {
    param([Parameter(Mandatory)][string]$Path)
    if (-not [System.IO.File]::Exists($Path)) { return $null }
    $words = @((Read-WowgetText $Path).Trim() -split '\s+')
    if ($words.Count -ne 2) { return $null }
    return [pscustomobject]@{ App = $words[0]; Runtime = $words[1] }
}

# The runtime archive name in runtime.json for this machine.
function Get-WowgetRuntimeAsset {
    param([string]$Platform = (Get-WowgetPlatform))
    $arm = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64
    switch ($Platform) {
        'Windows' { return 'win-x64' }
        'MacOS' { return $(if ($arm) { 'osx-arm64' } else { 'osx-x64' }) }
        default { return $(if ($arm) { 'linux-arm64' } else { 'linux-x64' }) }
    }
}

# Deletes app and runtime directories that are neither current nor previous, and the temporary
# directories of interrupted updates and installs. Directories changed in the last hour are kept, since
# an installer, which takes no lock, may be about to switch to them. Never fails.
function Remove-WowgetOldVersions {
    param([Parameter(Mandatory)][string]$Root)
    try {
        $current = Read-WowgetVersionsFile ([System.IO.Path]::Combine($Root, 'current'))
        if (-not $current) { return }
        $previous = Read-WowgetVersionsFile ([System.IO.Path]::Combine($Root, 'previous'))
        $cutoff = [DateTime]::UtcNow.AddHours(-1)
        $old = { param($path) [System.IO.Directory]::GetLastWriteTimeUtc($path) -lt $cutoff }
        foreach ($kind in 'app', 'runtime') {
            $dir = [System.IO.Path]::Combine($Root, $kind)
            if (-not [System.IO.Directory]::Exists($dir)) { continue }
            $keep = @(if ($kind -eq 'app') { $current.App; if ($previous) { $previous.App } } else { $current.Runtime; if ($previous) { $previous.Runtime } })
            foreach ($sub in [System.IO.Directory]::GetDirectories($dir)) {
                if ($keep -ccontains [System.IO.Path]::GetFileName($sub) -or -not (& $old $sub)) { continue }
                [void](Remove-WowgetBestEffort $sub)
            }
        }
        foreach ($sub in [System.IO.Directory]::GetDirectories($Root)) {
            $name = [System.IO.Path]::GetFileName($sub)
            if (($name.StartsWith('.update-') -or $name.StartsWith('.install-')) -and (& $old $sub)) { [void](Remove-WowgetBestEffort $sub) }
        }
    } catch {
        return
    }
}

# The latest release version: GET /v1/version, else GitHub's latest release.
function Get-WowgetLatestVersion {
    param([Parameter(Mandatory)][string]$ApiUrl)
    $why = $null
    if ($ApiUrl -ne 'off') {
        try {
            $response = Invoke-WowgetApi -ApiUrl $ApiUrl -Path '/v1/version'
            $doc = ConvertFrom-WowgetJson (Get-WowgetResponseText $response)
            $v = if ((Test-WowgetJsonDictionary $doc) -and (Test-WowgetJsonDictionary $doc['app'])) { $doc['app']['version'] } else { $null }
            if ($v -is [string] -and (ConvertFrom-WowgetVersion $v)) { return $v.TrimStart('v') }
            $why = 'it returned an invalid version'
        } catch {
            $why = Get-WowgetErrorMessage $_
        }
    }
    $url = "https://api.github.com/repos/$script:ReleaseRepo/releases/latest"
    $response = Invoke-WowgetHttp -Uri $url -Headers @{ Accept = 'application/vnd.github+json' }
    if ($response.StatusCode -ne 200) {
        $more = if ($why) { "; the wowget service failed too ($why)" } else { '' }
        throw (New-WowgetError 'network' "GET $url failed: HTTP $($response.StatusCode)$more.")
    }
    try { $tag = (ConvertFrom-WowgetJson (Get-WowgetResponseText $response))['tag_name'] } catch { $tag = $null }
    if (-not ($tag -is [string]) -or -not (ConvertFrom-WowgetVersion $tag)) { throw (New-WowgetError 'network' "GitHub's latest release of $script:ReleaseRepo has no version tag.") }
    return $tag.TrimStart('v')
}

# Downloads $Url into $OutFile from a GitHub release; anything but 200 is a network error.
function Save-WowgetReleaseFile {
    param([Parameter(Mandatory)][string]$Url, [Parameter(Mandatory)][string]$OutFile)
    $result = Invoke-WowgetDownload -Url $Url -OutFile $OutFile -AllowedHosts $script:ReleaseHosts
    if ($result.Response.StatusCode -ne 200) { throw (New-WowgetError 'network' "Download of $Url failed: HTTP $($result.Response.StatusCode).") }
}

# Extracts a runtime archive (.zip, or .tar.gz with file modes kept) into $Dest.
function Expand-WowgetRuntimeArchive {
    param([Parameter(Mandatory)][string]$Archive, [Parameter(Mandatory)][string]$Dest, [Parameter(Mandatory)][string]$Name)
    if ($Name -match '(?i)\.zip$') {
        [System.IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Dest)
        return
    }
    $file = [System.IO.File]::OpenRead($Archive)
    try {
        $gzip = [System.IO.Compression.GZipStream]::new($file, [System.IO.Compression.CompressionMode]::Decompress)
        try { [System.Formats.Tar.TarFile]::ExtractToDirectory($gzip, $Dest, $false) } finally { $gzip.Dispose() }
    } finally {
        $file.Dispose()
    }
}

# Moves the directory $From to $To, replacing what is there.
function Move-WowgetDirectoryInto {
    param([Parameter(Mandatory)][string]$From, [Parameter(Mandatory)][string]$To)
    if ([System.IO.Directory]::Exists($To)) {
        $aside = New-WowgetTempDirectory ([System.IO.Path]::GetDirectoryName($To)) '.old-'
        [System.IO.Directory]::Delete($aside)
        [System.IO.Directory]::Move($To, $aside)
        [System.IO.Directory]::Move($From, $To)
        [void](Remove-WowgetBestEffort $aside)
        return
    }
    [System.IO.Directory]::Move($From, $To)
}

function Invoke-WowgetSelfUpdate {
    param([Parameter(Mandatory)][hashtable]$Options, [switch]$Check, [string]$Root = $null)
    $current = $script:WowgetVersion
    if (-not (ConvertFrom-WowgetVersion $current) -or $current -like '*-dev') {
        throw (New-WowgetError 'usage' 'This is a development copy run from source; self-update only updates an installed wowget.')
    }
    if (-not $Root) { $Root = Get-WowgetInstallRoot }
    if (-not $Root) { throw (New-WowgetError 'usage' 'This wowget does not run from an install root; reinstall it with the install script.') }
    $env = Get-WowgetOptionEnv $Options
    $apiUrl = Get-WowgetOption $Options 'ApiUrl' (Get-WowgetApiUrl $env)
    $force = [bool](Get-WowgetOption $Options 'Force' $false)
    $latest = Get-WowgetLatestVersion $apiUrl
    $newer = (Compare-WowgetVersion $latest $current) -gt 0
    if (-not $newer -and -not $force) { return New-WowgetResult ([ordered]@{ status = 'current'; current = $current; latest = $latest }) }
    if ($Check) { return New-WowgetResult ([ordered]@{ status = $(if ($newer) { 'available' } else { 'current' }); current = $current; latest = $latest }) }

    # The download URL comes from the version, never from the service.
    $base = "https://github.com/$script:ReleaseRepo/releases/download/v$latest"
    $zipName = "wowget-$latest.zip"
    $work = New-WowgetTempDirectory $Root '.update-'
    try {
        $zip = [System.IO.Path]::Combine($work, $zipName)
        $sig = "$zip.sig"
        Send-WowgetEvent $Options @{ type = 'download:start'; addon = 'wowget'; filename = $zipName }
        Save-WowgetReleaseFile "$base/$zipName" $zip
        Save-WowgetReleaseFile "$base/$zipName.sig" $sig
        Send-WowgetEvent $Options @{ type = 'download:done'; addon = 'wowget'; bytes = ([System.IO.FileInfo]::new($zip)).Length }
        if (-not (Test-WowgetReleaseSignature $zip ([System.IO.File]::ReadAllBytes($sig)) (Get-WowgetReleasePublicKey))) {
            throw (New-WowgetError 'source' "The signature of $zipName does not verify with this wowget's release key; nothing was changed.")
        }
        $appTmp = [System.IO.Path]::Combine($work, 'app')
        [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $appTmp)
        $runtime = ConvertFrom-WowgetJson (Read-WowgetText ([System.IO.Path]::Combine($appTmp, 'runtime.json')))
        $rtVersion = $runtime['version']
        if (-not (Test-WowgetNonEmptyString $rtVersion) -or $rtVersion -notmatch '^[0-9A-Za-z.-]+$') { throw (New-WowgetError 'source' "runtime.json of $zipName has no valid version.") }

        $platform = Get-WowgetOptionPlatform $Options
        $rtDir = [System.IO.Path]::Combine($Root, 'runtime', $rtVersion)
        $pwsh = [System.IO.Path]::Combine($rtDir, $(if ($platform -eq 'Windows') { 'pwsh.exe' } else { 'pwsh' }))
        if (-not [System.IO.File]::Exists($pwsh)) {
            $assetName = Get-WowgetRuntimeAsset $platform
            $asset = $runtime['assets'][$assetName]
            if (-not (Test-WowgetJsonDictionary $asset) -or -not (Test-WowgetNonEmptyString $asset['url']) -or $asset['sha256'] -notmatch '^[0-9a-fA-F]{64}$') {
                throw (New-WowgetError 'source' "runtime.json of $zipName has no $assetName runtime.")
            }
            $fileName = [System.IO.Path]::GetFileName(([System.Uri]$asset['url']).AbsolutePath)
            $archive = [System.IO.Path]::Combine($work, $fileName)
            Send-WowgetEvent $Options @{ type = 'download:start'; addon = 'wowget'; filename = $fileName }
            Save-WowgetReleaseFile $asset['url'] $archive
            Send-WowgetEvent $Options @{ type = 'download:done'; addon = 'wowget'; bytes = ([System.IO.FileInfo]::new($archive)).Length }
            $hash = Get-WowgetFileHash $archive
            if ($hash -ne $asset['sha256'].ToLowerInvariant()) { throw (New-WowgetError 'network' "Checksum mismatch for $fileName`: expected $($asset['sha256']), got $hash.") }
            $rtTmp = [System.IO.Path]::Combine($work, 'runtime')
            [void][System.IO.Directory]::CreateDirectory($rtTmp)
            Expand-WowgetRuntimeArchive $archive $rtTmp $fileName
            [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($rtDir))
            Move-WowgetDirectoryInto $rtTmp $rtDir
        }
        $appDir = [System.IO.Path]::Combine($Root, 'app', $latest)
        [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($appDir))
        Move-WowgetDirectoryInto $appTmp $appDir

        try {
            $reported = ([string](& $script:WowgetVersionProbe $pwsh ([System.IO.Path]::Combine($appDir, 'wowget.ps1')))).Trim()
            if ($reported -cne "wowget $latest") { throw "it reported `"$reported`"" }
        } catch {
            throw (New-WowgetError 'source' "wowget $latest did not start on PowerShell $rtVersion ($(Get-WowgetErrorMessage $_)); the installed version was kept.")
        }

        # The switch: the launchers read both versions from this one file.
        $currentPath = [System.IO.Path]::Combine($Root, 'current')
        $old = Read-WowgetVersionsFile $currentPath
        if ($old -and $old.App -cne $latest) { Write-WowgetFileAtomic ([System.IO.Path]::Combine($Root, 'previous')) "$($old.App) $($old.Runtime)`n" }
        Write-WowgetFileAtomic $currentPath "$latest $rtVersion`n"
    } finally {
        [void](Remove-WowgetBestEffort $work)
    }
    return New-WowgetResult ([ordered]@{ status = 'updated'; current = $current; latest = $latest; path = $Root })
}
