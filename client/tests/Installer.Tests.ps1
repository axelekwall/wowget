BeforeDiscovery {
    Import-Module ([System.IO.Path]::Combine($PSScriptRoot, '..', 'Wowget', 'Wowget.psd1'))
}

InModuleScope Wowget {
    BeforeAll {
        . ([System.IO.Path]::Combine($PSScriptRoot, 'TestHelpers.ps1'))
        # A resolved release whose zip is the local file $zip, as the url: source produces.
        $release = {
            param([string]$releaseId, [byte[]]$bytes, [string]$source = 'url:https://example.com/a.zip', [bool]$verified = $false)
            $zip = [System.IO.Path]::Combine($dirs.Root, "src-$releaseId.zip")
            [System.IO.File]::WriteAllBytes($zip, $bytes)
            [pscustomobject]@{
                Source = $source; ReleaseId = $releaseId; Version = $releaseId; Filename = "a-$releaseId.zip"; DownloadUrl = 'https://example.com/a.zip'
                FlavorVerified = $verified; LocalPath = $zip; Sha256 = $null; Md5 = $null; AllowedHosts = $null; Note = $null; Folders = $null
            }
        }
        $install = {
            param($resolved, [string]$addon = 'Addon', [switch]$Force, [string]$flavor = 'classic')
            Install-WowgetRelease -Addon $addon -Resolved $resolved -TargetDir $addons -Flavor $flavor -CacheDir $dirs.Cache -Force:$Force -OnEvent { param($e) $script:WgEvents.Add($e) }
        }
    }

    Describe 'install' {
        BeforeEach {
            $dirs = New-WgTestDirs
            $addons = New-WgDir $dirs @('AddOns')
            $script:WgEvents = [System.Collections.Generic.List[object]]::new()
            Set-WgFakeHttp
        }
        AfterEach { Remove-WgTestDirs $dirs; Clear-WgFakeHttp }

        It 'places folders with markers, caches the zip and emits events' {
            $r = & $release 'v1' (New-WgAddonZipBytes @{ Addon = ''; AddonData = '' })
            $result = & $install $r
            $result.Folders | Should -Be @('Addon', 'AddonData')
            Get-WgFolders $addons | Should -Be @('Addon', 'AddonData')
            [System.IO.File]::Exists((Get-WowgetCachedZipPath $dirs.Cache 'Addon' 'v1' 'a-v1.zip')) | Should -BeTrue
            $marker = (Read-WowgetMarker ([System.IO.Path]::Combine($addons, 'AddonData'))).Marker
            $marker.Addon | Should -Be 'Addon'
            $marker.ReleaseId | Should -Be 'v1'
            $marker.Folders | Should -Be @('Addon', 'AddonData')
            $marker.Sha256 | Should -Match '^[0-9a-f]{64}$'
            $marker.Previous | Should -BeNullOrEmpty
            $script:WgEvents.type | Should -Be @('download:done', 'extract', 'verify', 'swap', 'done')
            @([System.IO.Directory]::GetDirectories($addons, '.wowget-*')).Count | Should -Be 0
        }

        It 'replaces folders on update, drops a folder the new release lacks, and records the previous release' {
            [void](& $install (& $release 'v1' (New-WgAddonZipBytes @{ Addon = ''; Old = '' } -Content 'one')))
            $result = & $install (& $release 'v2' (New-WgAddonZipBytes @{ Addon = '' } -Content 'two'))
            $result.RemovedFolders | Should -Be @('Old')
            Get-WgFolders $addons | Should -Be @('Addon')
            [System.IO.File]::ReadAllText([System.IO.Path]::Combine($addons, 'Addon', 'code.lua')) | Should -Be 'two'
            $marker = (Read-WowgetMarker ([System.IO.Path]::Combine($addons, 'Addon'))).Marker
            $marker.Previous.ReleaseId | Should -Be 'v1'
            $marker.Previous.Filename | Should -Be 'a-v1.zip'
        }

        It 'keeps the older previous release when the same release is reinstalled' {
            [void](& $install (& $release 'v1' (New-WgAddonZipBytes @{ Addon = '' } -Content 'one')))
            [void](& $install (& $release 'v2' (New-WgAddonZipBytes @{ Addon = '' } -Content 'two')))
            [void](& $install (& $release 'v2' (New-WgAddonZipBytes @{ Addon = '' } -Content 'two')))
            (Read-WowgetMarker ([System.IO.Path]::Combine($addons, 'Addon'))).Marker.Previous.ReleaseId | Should -Be 'v1'
        }

        It 'refuses an unmanaged folder without force and replaces it with force' {
            [void](New-WgDir $dirs @('AddOns', 'Addon'))
            $r = & $release 'v1' (New-WgAddonZipBytes @{ Addon = '' })
            Get-WgErrorText { & $install $r } | Should -Match 'is not managed by wowget; use --force'
            [void](& $install $r -Force)
            (Read-WowgetMarker ([System.IO.Path]::Combine($addons, 'Addon'))).Status | Should -Be 'ok'
        }

        It 'names the owner of a folder another addon installed' {
            [void](& $install (& $release 'v1' (New-WgAddonZipBytes @{ Shared = '' })) 'First')
            Get-WgErrorText { & $install (& $release 'v2' (New-WgAddonZipBytes @{ Shared = '' })) 'Second' } | Should -Match 'belongs to "First"'
        }

        It 'checks the flavor: wrong flavor fails, unknown needs force, verified releases skip it' {
            $wrong = & $release 'v1' (New-WgAddonZipBytes @{ Addon = '110000' })
            Get-WgErrorCode { & $install $wrong } | Should -Be 'flavor'
            $unknown = & $release 'v2' (New-WgAddonZipBytes @{ Addon = 'x' })
            Get-WgErrorText { & $install $unknown } | Should -Match 'use --force'
            $verified = & $release 'v3' (New-WgAddonZipBytes @{ Addon = '110000' }) -verified $true
            (& $install $verified).Folders | Should -Be @('Addon')
        }

        It 'downloads through redirects on allowed hosts, verifies the checksum and then reuses the cache' {
            $bytes = New-WgAddonZipBytes @{ Addon = '' }
            $script:WgRoutes['https://github.com/a/a.zip'] = @{ StatusCode = 302; Headers = @{ Location = 'https://release-assets.githubusercontent.com/x' } }
            $script:WgRoutes['https://release-assets.githubusercontent.com/x'] = @{ StatusCode = 200; Body = $bytes }
            $r = [pscustomobject]@{
                Source = 'github:a/a'; ReleaseId = 'v1'; Version = '1'; Filename = 'a.zip'; DownloadUrl = 'https://github.com/a/a.zip'
                FlavorVerified = $true; LocalPath = $null; Sha256 = (Get-WgSha256 $bytes); Md5 = (Get-WgMd5 $bytes); AllowedHosts = $script:DownloadHosts; Note = $null
            }
            [void](& $install $r)
            $script:WgRequests.Count | Should -Be 2
            [void](& $install $r)
            $script:WgRequests.Count | Should -Be 2
            $script:WgEvents | Where-Object { $_.type -eq 'download:done' } | ForEach-Object cached | Should -Be @($false, $true)
        }

        It 'refuses a redirect to a host outside the allowlist and downloads nothing' {
            $script:WgRoutes['https://github.com/a/a.zip'] = @{ StatusCode = 302; Headers = @{ Location = 'https://evil.example/x.zip' } }
            $r = [pscustomobject]@{
                Source = 'github:a/a'; ReleaseId = 'v1'; Version = '1'; Filename = 'a.zip'; DownloadUrl = 'https://github.com/a/a.zip'
                FlavorVerified = $true; LocalPath = $null; Sha256 = $null; Md5 = $null; AllowedHosts = $script:DownloadHosts; Note = $null
            }
            Get-WgErrorCode { & $install $r } | Should -Be 'source'
            @($script:WgRequests | Where-Object { $_.Uri -like '*evil*' }).Count | Should -Be 0
            Get-WgFolders $addons | Should -Be @()
        }

        It 'fails a checksum mismatch, a web page or a non-zip without caching or installing anything' {
            $bytes = New-WgAddonZipBytes @{ Addon = '' }
            $script:WgRoutes['https://github.com/a/a.zip'] = @{ StatusCode = 200; Body = $bytes }
            $script:WgRoutes['https://github.com/a/page.zip'] = @{ StatusCode = 200; Body = '<!DOCTYPE html><html>wait</html>' }
            $base = @{ Source = 'wowi:1'; ReleaseId = 'v1'; Version = '1'; Filename = 'a.zip'; FlavorVerified = $true; LocalPath = $null; Md5 = $null; AllowedHosts = $script:DownloadHosts; Note = $null }
            Get-WgErrorText { & $install ([pscustomobject]($base + @{ DownloadUrl = 'https://github.com/a/a.zip'; Sha256 = ('0' * 64) })) } | Should -Match 'Checksum mismatch'
            Get-WgErrorText { & $install ([pscustomobject]($base + @{ DownloadUrl = 'https://github.com/a/page.zip'; Sha256 = $null })) } | Should -Match 'awaiting approval'
            [System.IO.Directory]::Exists([System.IO.Path]::Combine($dirs.Cache, 'addon', 'v1')) -and @([System.IO.Directory]::GetFiles([System.IO.Path]::Combine($dirs.Cache, 'addon', 'v1'))).Count | Should -BeFalse
            Get-WgFolders $addons | Should -Be @()
        }

        It 'deletes a corrupt cached zip and downloads it again' {
            $bytes = New-WgAddonZipBytes @{ Addon = '' }
            $script:WgRoutes['https://github.com/a/a.zip'] = @{ StatusCode = 200; Body = $bytes }
            $cached = Get-WowgetCachedZipPath $dirs.Cache 'Addon' 'v1' 'a.zip'
            [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($cached))
            [System.IO.File]::WriteAllText($cached, 'garbage')
            $r = [pscustomobject]@{ Source = 'github:a/a'; ReleaseId = 'v1'; Version = '1'; Filename = 'a.zip'; DownloadUrl = 'https://github.com/a/a.zip'; FlavorVerified = $true; LocalPath = $null; Sha256 = $null; Md5 = $null; AllowedHosts = $script:DownloadHosts; Note = $null }
            [void](& $install $r)
            Test-WowgetZip $cached | Should -BeTrue
        }

        It 'takes over a folder with force, which the other addon then counts as missing' {
            [void](& $install (& $release 'v1' (New-WgAddonZipBytes @{ Shared = ''; FirstOnly = '' })) 'First')
            [void](& $install (& $release 'v2' (New-WgAddonZipBytes @{ Shared = '' })) 'Second' -Force)
            $markers = Get-WowgetTargetMarkers $addons
            $first = Get-WowgetInstall $markers 'First'
            Get-WowgetMissingFolders $markers $first | Should -Be @('Shared')
            $result = Uninstall-WowgetAddon -TargetDir $addons -Addon 'First'
            $result.RemovedFolders | Should -Be @('FirstOnly')
            Get-WgFolders $addons | Should -Be @('Shared')
        }
    }

    Describe 'uninstall' {
        BeforeEach {
            $dirs = New-WgTestDirs
            $addons = New-WgDir $dirs @('AddOns')
            $script:WgEvents = [System.Collections.Generic.List[object]]::new()
        }
        AfterEach { Remove-WgTestDirs $dirs }

        It 'removes the folders whose marker names the addon, leaves the rest, and tolerates missing ones' {
            [void](& $install (& $release 'v1' (New-WgAddonZipBytes @{ Addon = ''; AddonData = '' })))
            [void](New-WgDir $dirs @('AddOns', 'Unmanaged'))
            [System.IO.Directory]::Delete([System.IO.Path]::Combine($addons, 'AddonData'), $true)
            $result = Uninstall-WowgetAddon -TargetDir $addons -Addon 'addon'
            $result.WasInstalled | Should -BeTrue
            $result.RemovedFolders | Should -Be @('Addon')
            Get-WgFolders $addons | Should -Be @('Unmanaged')
            (Uninstall-WowgetAddon -TargetDir $addons -Addon 'Addon').WasInstalled | Should -BeFalse
        }

        It 'maps a folder it cannot move to a locked error and leaves the install whole (POSIX only: uses file modes)' -Skip:($IsWindows) {
            [void](& $install (& $release 'v1' (New-WgAddonZipBytes @{ Addon = ''; Zed = '' })))
            $zed = [System.IO.Path]::Combine($addons, 'Zed')
            # A read-only AddOns directory makes moving folders aside fail, as files the game holds
            # open do on Windows.
            [System.IO.File]::SetUnixFileMode($addons, [System.IO.UnixFileMode]'UserRead, UserExecute')
            try {
                Get-WgErrorCode { Uninstall-WowgetAddon -TargetDir $addons -Addon 'Addon' } | Should -Be 'locked'
            } finally {
                [System.IO.File]::SetUnixFileMode($addons, [System.IO.UnixFileMode]'UserRead, UserWrite, UserExecute')
            }
            Get-WgFolders $addons | Should -Be @('Addon', 'Zed')
            [System.IO.Directory]::Exists($zed) | Should -BeTrue
        }
    }

    Describe 'cache pruning' {
        BeforeEach { $dirs = New-WgTestDirs }
        AfterEach { Remove-WgTestDirs $dirs }

        It 'keeps the current and previous releases and deletes the rest' {
            foreach ($id in 'v1', 'v2', 'v3') {
                $path = Get-WowgetCachedZipPath $dirs.Cache 'Addon' $id "a-$id.zip"
                [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($path))
                [System.IO.File]::WriteAllText($path, 'x')
            }
            $installs = @([pscustomobject]@{ ReleaseId = 'v3'; Filename = 'a-v3.zip'; Previous = [pscustomobject]@{ ReleaseId = 'v2'; Filename = 'a-v2.zip' } })
            $removed = @(Remove-WowgetUnusedCache -CacheDir $dirs.Cache -Addon 'Addon' -Installs $installs)
            $removed.Count | Should -Be 1
            (Get-WgFolders ([System.IO.Path]::Combine($dirs.Cache, 'addon'))) | Should -Be @('v2', 'v3')
        }
    }
}
