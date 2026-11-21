BeforeDiscovery {
    Import-Module ([System.IO.Path]::Combine($PSScriptRoot, '..', 'Wowget', 'Wowget.psd1'))
}

InModuleScope Wowget {
    BeforeAll {
        . ([System.IO.Path]::Combine($PSScriptRoot, 'TestHelpers.ps1'))

        # A release of this client as 9.9.9, built by build-release.ps1 and signed with a key made here.
        $script:WgBuild = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'wowget-selfupdate-' + [System.IO.Path]::GetRandomFileName().Replace('.', ''))
        [void][System.IO.Directory]::CreateDirectory($script:WgBuild)
        $script:WgKey = [System.Security.Cryptography.ECDsa]::Create([System.Security.Cryptography.ECCurve+NamedCurves]::nistP256)
        $keyPath = [System.IO.Path]::Combine($script:WgBuild, 'key.pem')
        $pubPath = [System.IO.Path]::Combine($script:WgBuild, 'key.pub')
        [System.IO.File]::WriteAllText($keyPath, $script:WgKey.ExportPkcs8PrivateKeyPem())
        $script:WgPublicKey = [System.Convert]::ToBase64String($script:WgKey.ExportSubjectPublicKeyInfo())
        [System.IO.File]::WriteAllText($pubPath, $script:WgPublicKey)
        $out = & ([System.Environment]::ProcessPath) -NoLogo -NoProfile -File ([System.IO.Path]::Combine($PSScriptRoot, '..', 'build-release.ps1')) -Version 9.9.9 -OutDir $script:WgBuild -SigningKeyPath $keyPath -PublicKeyPath $pubPath 2>&1
        if ($LASTEXITCODE -ne 0) { throw "build-release.ps1 failed: $out" }
        $script:WgZip = [System.IO.File]::ReadAllBytes([System.IO.Path]::Combine($script:WgBuild, 'wowget-9.9.9.zip'))
        $script:WgSig = [System.IO.File]::ReadAllBytes([System.IO.Path]::Combine($script:WgBuild, 'wowget-9.9.9.zip.sig'))
        $script:WgReleaseUrl = 'https://github.com/axelekwall/wowget/releases/download/v9.9.9'

        # The release zip with runtime.json replaced, signed again.
        function New-WgZipWithRuntime {
            param([string]$RuntimeJson)
            $dir = [System.IO.Path]::Combine($script:WgBuild, 'repack-' + [System.IO.Path]::GetRandomFileName())
            $src = [System.IO.Path]::Combine($script:WgBuild, 'wowget-9.9.9.zip')
            [System.IO.Compression.ZipFile]::ExtractToDirectory($src, $dir)
            [System.IO.File]::WriteAllText([System.IO.Path]::Combine($dir, 'runtime.json'), $RuntimeJson)
            $zip = "$dir.zip"
            [System.IO.Compression.ZipFile]::CreateFromDirectory($dir, $zip)
            $bytes = [System.IO.File]::ReadAllBytes($zip)
            $sig = $script:WgKey.SignHash([System.Security.Cryptography.SHA256]::HashData($bytes), [System.Security.Cryptography.DSASignatureFormat]::Rfc3279DerSequence)
            return [pscustomobject]@{ Zip = $bytes; Sig = $sig }
        }

        function New-WgInstallRoot {
            param($Dirs, [string]$Runtime = '7.6.10')
            $root = [System.IO.Path]::Combine($Dirs.Root, 'root')
            [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::Combine($root, 'app', '1.0.0'))
            $rt = [System.IO.Path]::Combine($root, 'runtime', $Runtime)
            [void][System.IO.Directory]::CreateDirectory($rt)
            [System.IO.File]::WriteAllText([System.IO.Path]::Combine($rt, $(if ($IsWindows) { 'pwsh.exe' } else { 'pwsh' })), '')
            [System.IO.File]::WriteAllText([System.IO.Path]::Combine($root, 'current'), "1.0.0 $Runtime`n")
            return $root
        }

        function Set-WgRelease {
            param([byte[]]$Zip = $script:WgZip, [byte[]]$Sig = $script:WgSig)
            $script:WgRoutes["$script:WgReleaseUrl/wowget-9.9.9.zip"] = @{ StatusCode = 302; Headers = @{ Location = 'https://release-assets.githubusercontent.com/z' } }
            $script:WgRoutes['https://release-assets.githubusercontent.com/z'] = @{ StatusCode = 200; Body = $Zip }
            $script:WgRoutes["$script:WgReleaseUrl/wowget-9.9.9.zip.sig"] = @{ StatusCode = 200; Body = $Sig }
        }
    }
    AfterAll {
        $script:WgKey.Dispose()
        Remove-Item -LiteralPath $script:WgBuild -Recurse -Force -ErrorAction SilentlyContinue
    }

    Describe 'build-release' {
        It 'packages the client with the registry snapshot, checksum and filled-in installers' {
            $zipPath = [System.IO.Path]::Combine($script:WgBuild, 'wowget-9.9.9.zip')
            $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
            try {
                $names = @($archive.Entries | ForEach-Object FullName)
                foreach ($n in 'wowget.ps1', 'runtime.json', 'registry.json', 'release-public-key.txt', 'Wowget/Wowget.psm1', 'launchers/wowget.cmd', 'launchers/wowget.sh', 'LICENSE', 'THIRD-PARTY-NOTICES.txt') {
                    $names | Should -Contain $n
                }
                $names | Where-Object { $_ -like 'tests/*' -or $_.Contains('\') } | Should -BeNullOrEmpty
                $read = { param($n) $s = [System.IO.StreamReader]::new($archive.GetEntry($n).Open()); try { $s.ReadToEnd() } finally { $s.Dispose() } }
                $registry = ConvertFrom-WowgetRegistryDoc (ConvertFrom-WowgetJson (& $read 'registry.json'))
                $registry.Entries.Count | Should -BeGreaterThan 0
                (& $read 'launchers/wowget.cmd') | Should -Match "`r`n"
                (& $read 'release-public-key.txt').Trim() | Should -Be $script:WgPublicKey
            } finally {
                $archive.Dispose()
            }
            (Get-Content -Raw "$zipPath.sha256") | Should -BeExactly "$(Get-WgSha256 $script:WgZip)  wowget-9.9.9.zip`n"
            Test-WowgetReleaseSignature $zipPath $script:WgSig $script:WgPublicKey | Should -BeTrue
            foreach ($installer in 'install.ps1', 'install.sh') {
                $text = Get-Content -Raw ([System.IO.Path]::Combine($script:WgBuild, $installer))
                $text | Should -Match ([regex]::Escape($script:WgPublicKey))
                $text | Should -Not -Match '@WOWGET_RELEASE_PUBLIC_KEY@'
            }
        }
    }

    Describe 'self-update' {
        BeforeEach {
            $dirs = New-WgTestDirs
            Set-WgFakeHttp
            $script:WgSavedVersion = $script:WowgetVersion
            $script:WgSavedProbe = $script:WowgetVersionProbe
            $script:WowgetVersion = '1.0.0'
            $script:WowgetReleasePublicKey = $script:WgPublicKey
            $script:WowgetVersionProbe = { param($pwsh, $script) $script:WgProbed = @($pwsh, $script); 'wowget 9.9.9' }
            $script:WgRoutes['https://api.test/v1/version'] = @{ StatusCode = 200; Body = '{"app":{"version":"9.9.9","url":"x","sha256":"y"}}' }
            $o = New-WgOptions $dirs
        }
        AfterEach {
            $script:WowgetVersion = $script:WgSavedVersion
            $script:WowgetVersionProbe = $script:WgSavedProbe
            $script:WowgetReleasePublicKey = $null
            Remove-WgTestDirs $dirs
            Clear-WgFakeHttp
        }

        It 'reports available, current and the GitHub fallback with --check' {
            $root = New-WgInstallRoot $dirs
            (Invoke-WowgetSelfUpdate -Options $o -Check -Root $root).status | Should -Be 'available'
            $script:WowgetVersion = '9.9.9'
            (Invoke-WowgetSelfUpdate -Options $o -Check -Root $root).status | Should -Be 'current'
            $script:WgRoutes['https://api.test/v1/version'] = @{ StatusCode = 404; Body = '{"error":{"code":"not_found","message":"none yet"}}' }
            $script:WgRoutes['https://api.github.com/repos/axelekwall/wowget/releases/latest'] = @{ StatusCode = 200; Body = '{"tag_name":"v10.0.0-beta.2"}' }
            $r = Invoke-WowgetSelfUpdate -Options $o -Check -Root $root
            $r.status | Should -Be 'available'
            $r.latest | Should -Be '10.0.0-beta.2'
        }

        It 'installs the verified release beside the current one and switches current' {
            $root = New-WgInstallRoot $dirs
            Set-WgRelease
            $r = Invoke-WowgetSelfUpdate -Options $o -Root $root
            $r.status | Should -Be 'updated'
            (Get-Content -Raw ([System.IO.Path]::Combine($root, 'current'))) | Should -BeExactly "9.9.9 7.6.10`n"
            (Get-Content -Raw ([System.IO.Path]::Combine($root, 'previous'))) | Should -BeExactly "1.0.0 7.6.10`n"
            [System.IO.File]::Exists([System.IO.Path]::Combine($root, 'app', '9.9.9', 'wowget.ps1')) | Should -BeTrue
            (Get-Content -Raw ([System.IO.Path]::Combine($root, 'app', '9.9.9', 'Wowget', 'Wowget.psm1'))) | Should -Match "WowgetVersion = '9.9.9'"
            # The probe runs on the staged copy, before it is moved into app/.
            $script:WgProbed[1] | Should -BeLike '*wowget.ps1'
            $script:WgProbed[1] | Should -Not -Be ([System.IO.Path]::Combine($root, 'app', '9.9.9', 'wowget.ps1'))
            # The next run keeps current and previous and removes the rest.
            $stale = [System.IO.Path]::Combine($root, 'app', '0.9.0')
            $recent = [System.IO.Path]::Combine($root, 'app', '9.9.10')
            [void][System.IO.Directory]::CreateDirectory($stale)
            [void][System.IO.Directory]::CreateDirectory($recent)
            [System.IO.Directory]::SetLastWriteTimeUtc($stale, [DateTime]::UtcNow.AddHours(-2))
            Remove-WowgetOldVersions $root
            # A directory changed in the last hour may be one an installer is about to switch to.
            Get-WgFolders ([System.IO.Path]::Combine($root, 'app')) | Should -Be @('1.0.0', '9.9.10', '9.9.9')
        }

        It 'refuses a release whose signature does not verify, and one that does not start' {
            $root = New-WgInstallRoot $dirs
            Set-WgRelease
            $other = [System.Security.Cryptography.ECDsa]::Create([System.Security.Cryptography.ECCurve+NamedCurves]::nistP256)
            $script:WowgetReleasePublicKey = [System.Convert]::ToBase64String($other.ExportSubjectPublicKeyInfo())
            $other.Dispose()
            Get-WgErrorText { Invoke-WowgetSelfUpdate -Options $o -Root $root } | Should -Match 'signature of wowget-9.9.9.zip does not verify'
            $script:WowgetReleasePublicKey = $script:WgPublicKey
            $script:WowgetVersionProbe = { param($pwsh, $script) 'wowget 1.0.0' }
            Get-WgErrorText { Invoke-WowgetSelfUpdate -Options $o -Root $root } | Should -Match 'did not start'
            (Get-Content -Raw ([System.IO.Path]::Combine($root, 'current'))) | Should -BeExactly "1.0.0 7.6.10`n"
            $script:WowgetReleasePublicKey = 'not-a-key'
            Get-WgErrorText { Invoke-WowgetSelfUpdate -Options $o -Root $root } | Should -Match 'no valid release public key'
        }

        It 'keeps the running version when a forced reinstall of it fails to start' {
            $root = New-WgInstallRoot $dirs
            Set-WgRelease
            $script:WowgetVersion = '9.9.9'
            $running = [System.IO.Path]::Combine($root, 'app', '9.9.9')
            [void][System.IO.Directory]::CreateDirectory($running)
            [System.IO.File]::WriteAllText([System.IO.Path]::Combine($running, 'wowget.ps1'), 'the running copy')
            Write-WowgetFileAtomic ([System.IO.Path]::Combine($root, 'current')) "9.9.9 7.6.10`n"
            $script:WowgetVersionProbe = { param($pwsh, $script) 'wowget broken' }
            $o.Force = $true
            Get-WgErrorText { Invoke-WowgetSelfUpdate -Options $o -Root $root } | Should -Match 'did not start'
            [System.IO.File]::ReadAllText([System.IO.Path]::Combine($running, 'wowget.ps1')) | Should -BeExactly 'the running copy'
            (Get-Content -Raw ([System.IO.Path]::Combine($root, 'current'))) | Should -BeExactly "9.9.9 7.6.10`n"
        }

        It 'downloads, checks and extracts a runtime the new release pins' {
            $root = New-WgInstallRoot $dirs
            $asset = Get-WowgetRuntimeAsset
            $rtSrc = New-WgDir $dirs @('rt-src')
            $exe = if ($IsWindows) { 'pwsh.exe' } else { 'pwsh' }
            [System.IO.File]::WriteAllText([System.IO.Path]::Combine($rtSrc, $exe), "#!/bin/sh`necho fake`n")
            if (-not $IsWindows) { [System.IO.File]::SetUnixFileMode([System.IO.Path]::Combine($rtSrc, $exe), [System.IO.UnixFileMode]'UserRead, UserWrite, UserExecute') }
            $archive = [System.IO.Path]::Combine($dirs.Root, $(if ($IsWindows) { 'rt.zip' } else { 'rt.tar.gz' }))
            if ($IsWindows) {
                [System.IO.Compression.ZipFile]::CreateFromDirectory($rtSrc, $archive)
            } else {
                $fs = [System.IO.File]::Create($archive)
                $gz = [System.IO.Compression.GZipStream]::new($fs, [System.IO.Compression.CompressionLevel]::Optimal)
                [System.Formats.Tar.TarFile]::CreateFromDirectory($rtSrc, $gz, $false)
                $gz.Dispose(); $fs.Dispose()
            }
            $bytes = [System.IO.File]::ReadAllBytes($archive)
            $name = "powershell-9.0.0-$asset$(if ($IsWindows) { '.zip' } else { '.tar.gz' })"
            $url = "https://github.com/PowerShell/PowerShell/releases/download/v9.0.0/$name"
            $json = ConvertTo-WowgetJsonText ([ordered]@{ version = '9.0.0'; assets = [ordered]@{ $asset = [ordered]@{ url = $url; sha256 = (Get-WgSha256 $bytes) } } })
            $pack = New-WgZipWithRuntime $json
            Set-WgRelease -Zip $pack.Zip -Sig $pack.Sig
            $script:WgRoutes[$url] = @{ StatusCode = 200; Body = ([byte[]]($bytes[0..($bytes.Length - 2)])) }
            Get-WgErrorText { Invoke-WowgetSelfUpdate -Options $o -Root $root } | Should -Match 'Checksum mismatch'
            $script:WgRoutes[$url] = @{ StatusCode = 200; Body = $bytes }
            (Invoke-WowgetSelfUpdate -Options $o -Root $root).status | Should -Be 'updated'
            $pwsh = [System.IO.Path]::Combine($root, 'runtime', '9.0.0', $exe)
            $script:WgProbed[0] | Should -Be $pwsh
            if (-not $IsWindows) { ([System.IO.File]::GetUnixFileMode($pwsh) -band [System.IO.UnixFileMode]::UserExecute) | Should -Not -Be 0 }
            (Get-Content -Raw ([System.IO.Path]::Combine($root, 'current'))) | Should -BeExactly "9.9.9 9.0.0`n"
        }

        It 'starts the new release on the runtime to check its version' -Skip:($IsWindows) {
            $runtime = (Get-Content -Raw ([System.IO.Path]::Combine($PSScriptRoot, '..', 'runtime.json')) | ConvertFrom-Json).version
            $root = [System.IO.Path]::Combine($dirs.Root, 'root')
            [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::Combine($root, 'app', '1.0.0'))
            [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::Combine($root, 'runtime'))
            # This test's own PowerShell stands in for the pinned runtime.
            [void][System.IO.Directory]::CreateSymbolicLink([System.IO.Path]::Combine($root, 'runtime', $runtime), $PSHOME)
            [System.IO.File]::WriteAllText([System.IO.Path]::Combine($root, 'current'), "1.0.0 $runtime`n")
            $script:WowgetVersionProbe = $script:WgSavedProbe
            Set-WgRelease
            (Invoke-WowgetSelfUpdate -Options $o -Root $root).status | Should -Be 'updated'
            (Get-Content -Raw ([System.IO.Path]::Combine($root, 'current'))) | Should -BeExactly "9.9.9 $runtime`n"
        }

        It 'compares versions with pre-releases before their release' {
            Compare-WowgetVersion '1.2.0' '1.10.0' | Should -Be -1
            Compare-WowgetVersion '1.2.0-beta.2' '1.2.0' | Should -Be -1
            Compare-WowgetVersion '1.2.0-beta.10' '1.2.0-beta.2' | Should -Be 1
            Compare-WowgetVersion 'v2.0.0' '2.0.0' | Should -Be 0
        }
    }
}
