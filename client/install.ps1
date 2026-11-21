# Installs wowget on Windows: the signed release zip and the PowerShell runtime it pins.
#   irm https://github.com/axelekwall/wowget/releases/latest/download/install.ps1 | iex
# Runs in Windows PowerShell 5.1 and in PowerShell 7.
# Environment:
#   WOWGET_VERSION        version to install, e.g. 1.2.0 (default: the latest release)
#   WOWGET_INSTALL_DIR    install root (default: %LOCALAPPDATA%\wowget)
#   WOWGET_API_URL        the wowget service, asked for the latest version
#   WOWGET_CATALOGUE_CONTRIBUTIONS=off
#                         save an opt-out of catalogue contributions before any device enrollment
#   WOWGET_SKIP_PATH=1    leave the user PATH alone
#   WOWGET_DOWNLOAD_BASE, WOWGET_RUNTIME_BASE
#                         fetch the release files or the runtime archive from another URL or a local
#                         directory; signatures and checksums are checked all the same

function Install-Wowget {
    # The installer talks to the person running it; there is no pipeline to write to under "irm | iex".
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '')]
    param()
    $ErrorActionPreference = 'Stop'
    $repo = 'axelekwall/wowget'
    # Base64 SubjectPublicKeyInfo of the ECDSA P-256 release key.
    $publicKey = '@WOWGET_RELEASE_PUBLIC_KEY@'
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    if (-not [Environment]::Is64BitOperatingSystem) { throw 'wowget: only 64-bit Windows is supported.' }
    $root = if ($env:WOWGET_INSTALL_DIR) { $env:WOWGET_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'wowget' }
    $api = if ($env:WOWGET_API_URL) { $env:WOWGET_API_URL.TrimEnd('/') } else { 'https://api.wowget.dev' }

    # Downloads, or copies when $From is a local path or file: URL.
    function Get-File([string]$From, [string]$To) {
        if ($From -match '^https?://') {
            Invoke-WebRequest -Uri $From -OutFile $To -UseBasicParsing
        } else {
            $local = if ($From -match '^file:') { ([Uri]$From).LocalPath } else { $From }
            Copy-Item -LiteralPath $local -Destination $To
        }
    }

    # Writes $Text as UTF-8 without BOM through a temporary file and a rename.
    function Write-Atomic([string]$Path, [string]$Text) {
        $tmp = "$Path.tmp"
        [IO.File]::WriteAllText($tmp, $Text, $utf8)
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($tmp, $Path, $null) } else { [IO.File]::Move($tmp, $Path) }
    }

    # Verifies a DER-encoded ECDSA P-256 signature of the file's SHA-256 with the SubjectPublicKeyInfo
    # key. CNG takes the key as an ECCPUBLICBLOB and the signature as r||s, which works in .NET Framework.
    function Test-Signature([string]$File, [byte[]]$Der, [string]$Key) {
        $spki = [Convert]::FromBase64String($Key)
        if ($spki.Length -lt 65 -or $spki[$spki.Length - 65] -ne 4) { throw 'wowget: the release public key in this installer is not valid.' }
        # BCRYPT_ECDSA_PUBLIC_P256_MAGIC ("ECS1") and the key size in bytes, then X and Y.
        $blob = New-Object byte[] 72
        [Array]::Copy([byte[]](0x45, 0x43, 0x53, 0x31, 32, 0, 0, 0), $blob, 8)
        [Array]::Copy($spki, $spki.Length - 64, $blob, 8, 64)
        # SEQUENCE { INTEGER r, INTEGER s }, each as 32 bytes.
        if ($Der.Length -lt 8 -or $Der[0] -ne 0x30) { return $false }
        $pos = if ($Der[1] -band 0x80) { 2 + ($Der[1] -band 0x7f) } else { 2 }
        $sig = New-Object byte[] 64
        for ($part = 0; $part -lt 2; $part++) {
            if ($pos + 2 -gt $Der.Length -or $Der[$pos] -ne 2) { return $false }
            $len = $Der[$pos + 1]
            $start = $pos + 2
            if ($start + $len -gt $Der.Length) { return $false }
            while ($len -gt 32 -and $Der[$start] -eq 0) { $start++; $len-- }
            if ($len -gt 32) { return $false }
            [Array]::Copy($Der, $start, $sig, $part * 32 + (32 - $len), $len)
            $pos = $start + $len
        }
        $cng = [Security.Cryptography.CngKey]::Import($blob, [Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
        $ecdsa = New-Object Security.Cryptography.ECDsaCng $cng
        $sha = [Security.Cryptography.SHA256]::Create()
        $stream = [IO.File]::OpenRead($File)
        try { $hash = $sha.ComputeHash($stream) } finally { $stream.Dispose(); $sha.Dispose() }
        try { return $ecdsa.VerifyHash($hash, $sig) } finally { $ecdsa.Dispose(); $cng.Dispose() }
    }

    $version = $env:WOWGET_VERSION
    if (-not $version -and $api -ne 'off') {
        try { $version = (Invoke-RestMethod -Uri "$api/v1/version" -UseBasicParsing).app.version } catch { $version = $null }
    }
    if (-not $version) {
        try { $version = (Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -UseBasicParsing).tag_name } catch { $version = $null }
    }
    if (-not $version) { throw 'wowget: could not find the latest release; set WOWGET_VERSION.' }
    $version = $version -replace '^v', ''
    if ($version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { throw "wowget: `"$version`" is not a release version." }

    $base = if ($env:WOWGET_DOWNLOAD_BASE) { $env:WOWGET_DOWNLOAD_BASE.TrimEnd('/') } else { "https://github.com/$repo/releases/download/v$version" }
    $zipName = "wowget-$version.zip"
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $tmp = Join-Path $root ('.install-' + [IO.Path]::GetRandomFileName().Replace('.', ''))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $progress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        Write-Host "Downloading $zipName"
        $zip = Join-Path $tmp $zipName
        Get-File "$base/$zipName" $zip
        Get-File "$base/$zipName.sig" "$zip.sig"
        if (-not (Test-Signature $zip ([IO.File]::ReadAllBytes("$zip.sig")) $publicKey)) {
            throw "wowget: the signature of $zipName does not verify; nothing was installed."
        }
        $appTmp = Join-Path $tmp 'app'
        Expand-Archive -LiteralPath $zip -DestinationPath $appTmp
        $runtime = [IO.File]::ReadAllText((Join-Path $appTmp 'runtime.json')) | ConvertFrom-Json
        $rtVersion = $runtime.version
        $asset = $runtime.assets.'win-x64'
        if (-not $rtVersion -or $rtVersion -notmatch '^[0-9A-Za-z.-]+$' -or -not $asset -or $asset.sha256 -notmatch '^[0-9a-fA-F]{64}$') {
            throw "wowget: $zipName has no PowerShell runtime for win-x64."
        }

        $rtDir = Join-Path $root "runtime\$rtVersion"
        if (-not (Test-Path -LiteralPath (Join-Path $rtDir 'pwsh.exe'))) {
            $archiveName = ([Uri]$asset.url).Segments[-1]
            $from = if ($env:WOWGET_RUNTIME_BASE) { "$($env:WOWGET_RUNTIME_BASE.TrimEnd('/'))/$archiveName" } else { $asset.url }
            Write-Host "Downloading PowerShell $rtVersion ($archiveName)"
            $archive = Join-Path $tmp $archiveName
            Get-File $from $archive
            $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
            if ($actual -ne $asset.sha256.ToLowerInvariant()) { throw "wowget: checksum mismatch for ${archiveName}: expected $($asset.sha256), got $actual." }
            $rtTmp = Join-Path $tmp 'runtime'
            Expand-Archive -LiteralPath $archive -DestinationPath $rtTmp
            New-Item -ItemType Directory -Force -Path (Join-Path $root 'runtime') | Out-Null
            if (Test-Path -LiteralPath $rtDir) { Remove-Item -LiteralPath $rtDir -Recurse -Force }
            Move-Item -LiteralPath $rtTmp -Destination $rtDir
        }
        New-Item -ItemType Directory -Force -Path (Join-Path $root 'app') | Out-Null
        $appDir = Join-Path $root "app\$version"
        if (Test-Path -LiteralPath $appDir) { Move-Item -LiteralPath $appDir -Destination (Join-Path $tmp 'app-old') }
        Move-Item -LiteralPath $appTmp -Destination $appDir

        $bin = Join-Path $root 'bin'
        New-Item -ItemType Directory -Force -Path $bin | Out-Null
        # The Bun client's binary would be found before wowget.cmd on PATH.
        # The previous wowget's WOWGET_INSTALL_DIR named the directory of its binary, so look there too.
        $leftovers = @(foreach ($dir in @($bin, $root)) {
                Get-ChildItem -LiteralPath $dir -Force | Where-Object { $_.Name -eq 'wowget.exe' -or $_.Name -eq 'wowget.exe.old' -or $_.Name -like '.wowget.exe.new-*' }
            })
        foreach ($item in $leftovers) {
            try { Remove-Item -LiteralPath $item.FullName -Force; Write-Host "Removed the previous wowget's $($item.Name)" }
            catch { Write-Warning "Could not remove $($item.FullName); delete it by hand once no wowget is running." }
        }
        $launcher = [IO.File]::ReadAllText((Join-Path $appDir 'launchers\wowget.cmd'))
        Write-Atomic (Join-Path $bin 'wowget.cmd') ($launcher -replace "`r?`n", "`r`n")

        # The switch: the launcher reads both versions from this file.
        $currentPath = Join-Path $root 'current'
        if (Test-Path -LiteralPath $currentPath) {
            $old = @(([IO.File]::ReadAllText($currentPath)).Trim() -split '\s+')
            if ($old.Count -eq 2 -and $old[0] -ne $version) { Write-Atomic (Join-Path $root 'previous') "$($old[0]) $($old[1])`n" }
        }
        Write-Atomic $currentPath "$version $rtVersion`n"

        if ($env:WOWGET_CATALOGUE_CONTRIBUTIONS -eq 'off') {
            $state = if ($env:WOWGET_STATE_DIR) { $env:WOWGET_STATE_DIR } else { Join-Path $env:LOCALAPPDATA 'wowget\state' }
            New-Item -ItemType Directory -Force -Path $state | Out-Null
            Write-Atomic (Join-Path $state 'contributions.json') "{`n  `"version`": 1,`n  `"catalogueContributions`": `"off`"`n}`n"
            Write-Host 'Saved your opt-out of catalogue contributions.'
        }

        if ($env:WOWGET_SKIP_PATH -ne '1') {
            # Read and written unexpanded, so entries such as %USERPROFILE%\... keep their variables.
            $key = Get-Item -LiteralPath 'HKCU:\Environment'
            $userPath = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
            if (($userPath -split ';') -notcontains $bin) {
                $joined = if ($userPath) { "$userPath;$bin" } else { $bin }
                Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name 'Path' -Value $joined -Type ExpandString
                # Setting a variable through .NET tells running programs that the environment changed.
                [Environment]::SetEnvironmentVariable('WOWGET_INSTALLER', '1', 'User')
                [Environment]::SetEnvironmentVariable('WOWGET_INSTALLER', $null, 'User')
                Write-Host "Added $bin to your user PATH; open a new terminal to use wowget."
            }
            if (($env:Path -split ';') -notcontains $bin) { $env:Path = "$env:Path;$bin" }
        }

        $installed = & (Join-Path $bin 'wowget.cmd') --version
        if ($LASTEXITCODE -ne 0) { throw "wowget: the installed wowget does not start; run $bin\wowget.cmd --version to see why." }
        Write-Host "Installed $installed to $root"
        Write-Host 'wowget needs no account, and installing and using it uploads nothing about your addons.'
        Write-Host 'If you later enroll a device for sync, explicit syncs contribute public addon IDs to the'
        Write-Host 'catalogue unless you opt out: run this installer with WOWGET_CATALOGUE_CONTRIBUTIONS=off, or'
        Write-Host 'change the setting in the dashboard.'
    } finally {
        $ProgressPreference = $progress
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Install-Wowget
