BeforeDiscovery {
    Import-Module ([System.IO.Path]::Combine($PSScriptRoot, '..', 'Wowget', 'Wowget.psd1'))
}

InModuleScope Wowget {
    BeforeAll { . ([System.IO.Path]::Combine($PSScriptRoot, 'TestHelpers.ps1')) }

  Describe 'ops' {
    BeforeEach {
        $dirs = New-WgTestDirs
        Set-WgFakeHttp
        Set-WgFakeService
    }
    AfterEach {
        Remove-WgTestDirs $dirs
        Clear-WgFakeHttp
    }

    Describe 'ops end to end' {
        It 'runs init, add, list, outdated, update and remove with a url: source' {
            $addons = New-WgDir $dirs @('AddOns')
            $o = New-WgOptions $dirs
            $init = Invoke-WowgetInit -Options $o -Path $addons -Flavor 'classic'
            $init.targets[0].name | Should -Be 'classic'

            $url = 'https://example.com/dl/Foo.zip'
            Set-WgUrlZip $url (New-WgAddonZipBytes @{ Foo = '' } -Content 'one') 'e1'
            $added = Invoke-WowgetAdd -Options $o -Source "url:$url"
            $added.name | Should -Be 'Foo'
            $added.addons[0].folders | Should -Be @('Foo')
            (Read-WowgetManifest $dirs.Manifest).Addons.Source | Should -Be @("url:$url")

            $list = Invoke-WowgetList -Options $o
            $list.addons[0].status | Should -Be 'ok'
            $list.addons[0].version | Should -Be $added.addons[0].version

            (Invoke-WowgetOutdated -Options $o).addons[0].status | Should -Be 'current'
            Set-WgUrlZip $url (New-WgAddonZipBytes @{ Foo = '' } -Content 'two') 'e2'
            (Invoke-WowgetOutdated -Options $o).addons[0].status | Should -Be 'outdated'
            $updated = Invoke-WowgetUpdate -Options $o
            $updated.addons[0].status | Should -Be 'updated'
            [System.IO.File]::ReadAllText([System.IO.Path]::Combine($addons, 'Foo', 'code.lua')) | Should -Be 'two'
            (Invoke-WowgetUpdate -Options $o).addons[0].status | Should -Be 'current'

            $removed = Invoke-WowgetRemove -Options $o -Name 'foo'
            $removed.removedEntry | Should -BeTrue
            $removed.addons[0].removedFolders | Should -Be @('Foo')
            Get-WgFolders $addons | Should -Be @()
            (Read-WowgetManifest $dirs.Manifest).Addons.Count | Should -Be 0
        }

        It 'writes nothing for a failed add, and outdated and update keep going past a broken addon' {
            $paths = New-WgManifest $dirs
            $o = New-WgOptions $dirs
            [void](Add-WgRelease -Source 'github:a/Good' -ReleaseId 'v1' -Folders @{ Good = '' })
            $script:WgReleases['github:a/Broken|*'] = @{ ok = $false; error = @{ code = 'upstream'; message = 'GitHub answered 500' } }
            $before = [System.IO.File]::ReadAllText($dirs.Manifest)
            Get-WgErrorCode { Invoke-WowgetAdd -Options $o -Source 'github:a/Broken' } | Should -Be 'source'
            [System.IO.File]::ReadAllText($dirs.Manifest) | Should -BeExactly $before

            [void](Invoke-WowgetAdd -Options $o -Source 'github:a/Good')
            $read = Read-WowgetManifestText $dirs.Manifest
            $m = $read.Manifest
            $withBroken = New-WowgetManifestObject -Targets $m.Targets -Addons (@($m.Addons) + (New-WowgetAddonEntry -Name 'Broken' -Source 'github:a/Broken'))
            [void](Save-WowgetManifest $dirs.Manifest $read.Text $withBroken)
            $outdated = Invoke-WowgetOutdated -Options $o
            ($outdated.addons | ForEach-Object { "$($_.name)=$($_.status)" }) | Should -Be @('Broken=error', 'Good=current')
            $update = Invoke-WowgetUpdate -Options $o
            ($update.addons | ForEach-Object { "$($_.name)=$($_.status)" }) | Should -Be @('Broken=error', 'Good=current')
            $update.addons[0].error | Should -Match 'GitHub answered 500'
        }

        It 'reports folders deleted after install as missing, and update and install repair them' {
            $paths = New-WgManifest $dirs
            $o = New-WgOptions $dirs
            [void](Add-WgRelease -Source 'github:a/Foo' -ReleaseId 'v1' -Folders @{ Foo = ''; FooData = '' })
            [void](Invoke-WowgetAdd -Options $o -Source 'github:a/Foo')
            [System.IO.Directory]::Delete([System.IO.Path]::Combine($paths.forever, 'FooData'), $true)
            $list = Invoke-WowgetList -Options $o
            $list.addons[0].status | Should -Be 'missing'
            $list.addons[0].missingFolders | Should -Be @('FooData')
            (Invoke-WowgetOutdated -Options $o).addons[0].status | Should -Be 'missing'
            (Invoke-WowgetUpdate -Options $o).addons[0].status | Should -Be 'repaired'
            Get-WgFolders $paths.forever | Should -Be @('Foo', 'FooData')
            [System.IO.Directory]::Delete([System.IO.Path]::Combine($paths.forever, 'Foo'), $true)
            (Invoke-WowgetInstall -Options $o).addons[0].status | Should -Be 'repaired'
            (Invoke-WowgetInstall -Options $o).addons[0].status | Should -Be 'skipped'
        }

        It 'counts a folder another addon took over with --force as missing until that addon is removed' {
            $paths = New-WgManifest $dirs
            [void](Add-WgRelease -Source 'github:a/One' -ReleaseId 'v1' -Folders @{ Shared = ''; OneOnly = '' })
            [void](Add-WgRelease -Source 'github:a/Two' -ReleaseId 'v1' -Folders @{ Shared = '' })
            [void](Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'github:a/One')
            Get-WgErrorCode { Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'github:a/Two' } | Should -Be 'conflict'
            [void](Invoke-WowgetAdd -Options (New-WgOptions $dirs -Force) -Source 'github:a/Two')
            $one = (Invoke-WowgetList -Options (New-WgOptions $dirs)).addons | Where-Object name -EQ 'One'
            $one.status | Should -Be 'missing'
            $one.missingFolders | Should -Be @('Shared')
            (Invoke-WowgetUpdate -Options (New-WgOptions $dirs) -Names @('One')).addons[0].status | Should -Be 'error'
            [void](Invoke-WowgetRemove -Options (New-WgOptions $dirs) -Name 'Two')
            (Invoke-WowgetUpdate -Options (New-WgOptions $dirs) -Names @('One')).addons[0].status | Should -Be 'repaired'
        }

        It 'reports a release without a build for the flavor as a per-addon error' {
            [void](New-WgManifest $dirs ([ordered]@{ era = 'classic'; forever = 'forever' }))
            $o = New-WgOptions $dirs
            [void](Add-WgRelease -Source 'github:a/Foo' -Flavor 'forever' -ReleaseId 'v1' -Folders @{ Foo = '' })
            $script:WgReleases['github:a/Foo|classic'] = @{ ok = $false; error = @{ code = 'flavor'; message = 'release.json lists forever but not classic' } }
            $err = Get-WgErrorText { Invoke-WowgetAdd -Options $o -Source 'github:a/Foo' }
            $err | Should -Match '^era: release.json lists forever but not classic'
            $added = Invoke-WowgetAdd -Options (New-WgOptions $dirs -Targets @('forever')) -Source 'github:a/Foo'
            $added.targets | Should -Be @('forever')
            $outdated = Invoke-WowgetOutdated -Options $o
            $outdated.addons.target | Should -Be @('forever')
        }

        It 'rejects an entry the manifest would not accept before any download' {
            [void](New-WgManifest $dirs)
            Get-WgErrorCode { Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'github:a/b' -Name '..' } | Should -Be 'usage'
            Get-WgErrorCode { Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'url:https://example.com/a.zip' -Prerelease $true } | Should -Be 'usage'
            $script:WgRequests.Count | Should -Be 0
        }

        It 'refuses a name already in the manifest, and remove refuses an unknown one' {
            [void](New-WgManifest $dirs)
            [void](Add-WgRelease -Source 'github:a/Foo' -ReleaseId 'v1' -Folders @{ Foo = '' })
            [void](Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'github:a/Foo')
            Get-WgErrorCode { Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'github:a/Foo' } | Should -Be 'duplicate'
            Get-WgErrorCode { Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'github:b/Foo' } | Should -Be 'duplicate'
            Get-WgErrorCode { Invoke-WowgetRemove -Options (New-WgOptions $dirs) -Name 'Nope' } | Should -Be 'not_found'
        }

        It 'adds a bare name from the registry, naming the addon after the entry' {
            [void](New-WgManifest $dirs)
            $script:WgRoutes['https://api.test/v1/registry'] = @{ StatusCode = 200; Body = '{"version":1,"addons":[{"name":"Questie","aliases":[],"source":"github:Questie/Questie","flavors":["forever"],"folders":["Questie"],"disabled":null}]}' }
            [void](Add-WgRelease -Source 'github:Questie/Questie' -ReleaseId 'v1' -Folders @{ Questie = '' })
            $added = Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'questie'
            $added.name | Should -Be 'Questie'
            $added.registryName | Should -Be 'questie'
            Get-WgErrorText { Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'owner/repo' } | Should -Match 'github:owner/repo'
        }

        It 'keeps url: sources working with the service off, and fails github: rows with a network error' {
            [void](New-WgManifest $dirs)
            $o = New-WgOptions $dirs
            $o.ApiUrl = 'off'
            $url = 'https://example.com/Foo.zip'
            Set-WgUrlZip $url (New-WgAddonZipBytes @{ Foo = '' })
            [void](Invoke-WowgetAdd -Options $o -Source "url:$url")
            Get-WgErrorCode { Invoke-WowgetAdd -Options $o -Source 'github:a/Bar' } | Should -Be 'network'
        }
    }

    Describe 'init' {
        It 'scans the game directory and adds a target per installed version folder' {
            foreach ($f in '_classic_era_', '_retail_') {
                $d = New-WgDir $dirs @('game', $f)
                [System.IO.File]::WriteAllText([System.IO.Path]::Combine($d, 'Wow.exe'), '')
            }
            $o = New-WgOptions $dirs -GameDirs @([System.IO.Path]::Combine($dirs.Root, 'none'), $dirs.Game)
            $result = Invoke-WowgetInit -Options $o
            $result.targets.name | Should -Be @('era', 'retail')
            $result.targets[0].createdAddonsDir | Should -BeTrue
            [System.IO.Directory]::Exists([System.IO.Path]::Combine($dirs.Game, '_retail_', 'Interface', 'AddOns')) | Should -BeTrue
            Get-WgErrorCode { Invoke-WowgetInit -Options $o } | Should -Be 'manifest_exists'
        }

        It 'names a single --path target after the flavor unless named, and checks its flags' {
            $o = New-WgOptions $dirs
            $result = Invoke-WowgetInit -Options $o -Path ([System.IO.Path]::Combine($dirs.Root, 'x')) -Flavor 'mists' -Name 'cata-ish'
            $result.targets[0].name | Should -Be 'cata-ish'
            Remove-Item -LiteralPath $dirs.Manifest
            Get-WgErrorCode { Invoke-WowgetInit -Options $o -Path '/x' -GameDir '/y' } | Should -Be 'usage'
            Get-WgErrorCode { Invoke-WowgetInit -Options $o -Path '' } | Should -Be 'usage'
            Get-WgErrorCode { Invoke-WowgetInit -Options $o -Portable -Path '/x' } | Should -Be 'usage'
            Get-WgErrorCode { Invoke-WowgetInit -Options $o } | Should -Be 'not_found'
        }

        It 'writes folder targets with --portable, which another machine finds in its own game directory' {
            $d = New-WgDir $dirs @('game', '_forever_')
            [System.IO.File]::WriteAllText([System.IO.Path]::Combine($d, '.flavor.info'), '')
            [void](Invoke-WowgetInit -Options (New-WgOptions $dirs -GameDirs @($dirs.Game)) -Portable)
            $m = Read-WowgetManifest $dirs.Manifest
            $m.Targets[0].Folder | Should -Be '_forever_'
            $other = New-WgDir $dirs @('elsewhere', '_forever_', 'Interface', 'AddOns')
            $list = Invoke-WowgetTargetList -Options (New-WgOptions $dirs -GameDirs @([System.IO.Path]::Combine($dirs.Root, 'elsewhere')))
            $list.targets[0].path | Should -Be $other
        }
    }

    Describe 'targets' {
        It 'adds to all or some targets, lists per target, and removes from one target then the last' {
            $paths = New-WgManifest $dirs ([ordered]@{ era = 'classic'; forever = 'forever' })
            [void](Add-WgRelease -Source 'github:a/Foo' -ReleaseId 'v1' -Folders @{ Foo = '' })
            [void](Add-WgRelease -Source 'github:a/Bar' -ReleaseId 'v1' -Folders @{ Bar = '' })
            $all = Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'github:a/Foo'
            $all.addons.target | Should -Be @('era', 'forever')
            $all.PSObject.Properties['targets'] | Should -BeNullOrEmpty
            $some = Invoke-WowgetAdd -Options (New-WgOptions $dirs -Targets @('era')) -Source 'github:a/Bar'
            $some.targets | Should -Be @('era')
            $grown = Invoke-WowgetAdd -Options (New-WgOptions $dirs -Targets @('forever')) -Source 'github:a/Bar'
            $grown.addons.target | Should -Be @('forever')
            (Read-WowgetManifest $dirs.Manifest).Addons[1].Targets | Should -BeNullOrEmpty

            $list = Invoke-WowgetList -Options (New-WgOptions $dirs -Targets @('forever'))
            ($list.addons | ForEach-Object { "$($_.name)@$($_.target)" }) | Should -Be @('Bar@forever', 'Foo@forever')

            $partial = Invoke-WowgetRemove -Options (New-WgOptions $dirs -Targets @('era')) -Name 'Foo'
            $partial.removedEntry | Should -BeFalse
            $partial.remainingTargets | Should -Be @('forever')
            Get-WgFolders $paths.era | Should -Be @('Bar')
            $last = Invoke-WowgetRemove -Options (New-WgOptions $dirs -Targets @('forever')) -Name 'Foo'
            $last.removedEntry | Should -BeTrue
        }

        It 'uninstalls what is on a removed target and drops addons left without targets' {
            $paths = New-WgManifest $dirs ([ordered]@{ era = 'classic'; forever = 'forever' })
            [void](Add-WgRelease -Source 'github:a/Foo' -ReleaseId 'v1' -Folders @{ Foo = '' })
            [void](Add-WgRelease -Source 'github:a/Bar' -ReleaseId 'v1' -Folders @{ Bar = '' })
            [void](Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'github:a/Foo')
            [void](Invoke-WowgetAdd -Options (New-WgOptions $dirs -Targets @('era')) -Source 'github:a/Bar')
            $result = Invoke-WowgetTargetRemove -Options (New-WgOptions $dirs) -Name 'era'
            $result.removedAddons | Should -Be @('Bar')
            $result.addons.name | Should -Be @('Bar', 'Foo')
            Get-WgFolders $paths.era | Should -Be @()
            (Read-WowgetManifest $dirs.Manifest).Addons.Name | Should -Be @('Foo')
        }

        It 'rolls back the targets it installed when a later target fails' {
            $paths = New-WgManifest $dirs ([ordered]@{ era = 'classic'; forever = 'forever' })
            [void](Add-WgRelease -Source 'github:a/Foo' -Flavor 'classic' -ReleaseId 'v1' -Folders @{ Foo = '' })
            [void](New-WgDir $dirs @('wow', 'forever', 'Interface', 'AddOns', 'Foo'))
            Get-WgErrorText { Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'github:a/Foo' } | Should -Match '^forever:'
            Get-WgFolders $paths.era | Should -Be @()
            (Read-WowgetManifest $dirs.Manifest).Addons.Count | Should -Be 0
        }

        It 'puts back the folders a failed forced add replaced' {
            $paths = New-WgManifest $dirs ([ordered]@{ era = 'classic'; forever = 'forever' })
            [void](Add-WgRelease -Source 'github:a/Old' -ReleaseId 'v1' -Folders @{ Shared = '' })
            [void](Invoke-WowgetAdd -Options (New-WgOptions $dirs -Targets @('era')) -Source 'github:a/Old')
            [void](Add-WgRelease -Source 'github:a/New' -Flavor 'classic' -ReleaseId 'v1' -Folders @{ Shared = '' })
            $script:WgReleases['github:a/New|forever'] = @{ ok = $false; error = @{ code = 'flavor'; message = 'no forever build' } }
            Get-WgErrorCode { Invoke-WowgetAdd -Options (New-WgOptions $dirs -Force) -Source 'github:a/New' } | Should -Be 'flavor'
            (Read-WowgetMarker ([System.IO.Path]::Combine($paths.era, 'Shared'))).Marker.Addon | Should -Be 'Old'
        }

        It 'resolves once for targets that share a flavor' {
            [void](New-WgManifest $dirs ([ordered]@{ a = 'classic'; b = 'classic'; c = 'forever' }))
            [void](Add-WgRelease -Source 'github:a/Foo' -ReleaseId 'v1' -Folders @{ Foo = '' })
            [void](Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'github:a/Foo')
            $script:WgResolveBatches.Clear()
            [void](Invoke-WowgetOutdated -Options (New-WgOptions $dirs))
            $script:WgResolveBatches.Count | Should -Be 1
            @($script:WgResolveBatches[0]).Count | Should -Be 2
        }

        It 'downloads a url: addon on targets of two flavors once' {
            [void](New-WgManifest $dirs ([ordered]@{ era = 'classic'; mists = 'mists' }))
            $url = 'https://example.com/Foo.zip'
            Set-WgUrlZip $url (New-WgAddonZipBytes @{ Foo = '11507, 50500' })
            [void](Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source "url:$url")
            @($script:WgRequests | Where-Object Uri -EQ $url).Count | Should -Be 1
        }

        It 'checks every target directory before installing anything' {
            $paths = New-WgManifest $dirs ([ordered]@{ era = 'classic'; forever = 'forever' })
            [System.IO.Directory]::Delete($paths.forever, $true)
            [void](Add-WgRelease -Source 'github:a/Foo' -ReleaseId 'v1' -Folders @{ Foo = '' })
            Get-WgErrorCode { Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'github:a/Foo' } | Should -Be 'io'
            $script:WgRequests.Count | Should -Be 0
        }

        It 'refuses a target path another target already uses, and usage errors for addons not on a target' {
            $paths = New-WgManifest $dirs ([ordered]@{ era = 'classic'; forever = 'forever' })
            Get-WgErrorCode { Invoke-WowgetTargetAdd -Options (New-WgOptions $dirs) -Name 'dup' -Path $paths.era -Flavor 'classic' } | Should -Be 'usage'
            [void](Add-WgRelease -Source 'github:a/Foo' -ReleaseId 'v1' -Folders @{ Foo = '' })
            [void](Invoke-WowgetAdd -Options (New-WgOptions $dirs -Targets @('era')) -Source 'github:a/Foo')
            Get-WgErrorCode { Invoke-WowgetRemove -Options (New-WgOptions $dirs -Targets @('forever')) -Name 'Foo' } | Should -Be 'usage'
            Get-WgErrorCode { Invoke-WowgetUpdate -Options (New-WgOptions $dirs -Targets @('forever')) -Names @('Foo') } | Should -Be 'usage'
            Get-WgErrorCode { Invoke-WowgetList -Options (New-WgOptions $dirs -Targets @('nope')) } | Should -Be 'usage'
        }

        It 'removes the folders of an orphaned marker with remove -t' {
            $paths = New-WgManifest $dirs
            [void](Add-WgRelease -Source 'github:a/Foo' -ReleaseId 'v1' -Folders @{ Foo = '' })
            [void](Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'github:a/Foo')
            $read = Read-WowgetManifestText $dirs.Manifest
            [void](Save-WowgetManifest $dirs.Manifest $read.Text (Set-WowgetManifestAddon $read.Manifest 'Foo' $null))
            Get-WgErrorCode { Invoke-WowgetRemove -Options (New-WgOptions $dirs) -Name 'Foo' } | Should -Be 'not_found'
            $result = Invoke-WowgetRemove -Options (New-WgOptions $dirs -Targets @('forever')) -Name 'Foo'
            $result.orphan | Should -BeTrue
            Get-WgFolders $paths.forever | Should -Be @()
        }
    }

    Describe 'folder targets' {
        It 'skips a target not on this machine with an event, and a filter naming it is not_found' {
            $here = New-WgDir $dirs @('wow', 'here', 'Interface', 'AddOns')
            [void](New-WowgetManifestFile $dirs.Manifest @(
                    New-WowgetTarget -Name 'here' -Path $here -Flavor 'classic'
                    New-WowgetTarget -Name 'away' -Folder '_classic_' -Flavor 'mists'
                ))
            [void](Add-WgRelease -Source 'github:a/Foo' -ReleaseId 'v1' -Folders @{ Foo = '' })
            $o = New-WgOptions $dirs -GameDirs @($dirs.Game)
            $added = Invoke-WowgetAdd -Options $o -Source 'github:a/Foo'
            $added.addons.target | Should -Be @('here')
            ($script:WgEvents | Where-Object type -EQ 'target:absent').target | Should -Be @('away')
            (Read-WowgetManifest $dirs.Manifest).Addons[0].Targets | Should -BeNullOrEmpty
            Get-WgErrorCode { Invoke-WowgetList -Options (New-WgOptions $dirs -GameDirs @($dirs.Game) -Targets @('away')) } | Should -Be 'not_found'
            (Invoke-WowgetTargetList -Options $o).targets[1].path | Should -BeNullOrEmpty
        }

        It 'fails when a folder target comes to resolve to another target directory' {
            $addons = New-WgDir $dirs @('game', '_retail_', 'Interface', 'AddOns')
            [void](New-WowgetManifestFile $dirs.Manifest @(
                    New-WowgetTarget -Name 'path' -Path $addons -Flavor 'mainline'
                    New-WowgetTarget -Name 'folder' -Folder '_retail_' -Flavor 'mainline'
                ))
            Get-WgErrorText { Invoke-WowgetList -Options (New-WgOptions $dirs -GameDirs @($dirs.Game)) } | Should -Match 'both use'
        }

        It 'rewrites a path target as a folder target where that locates the same directory' {
            $addons = New-WgDir $dirs @('game', '_retail_', 'Interface', 'AddOns')
            $elsewhere = New-WgDir $dirs @('other', 'AddOns')
            [void](New-WowgetManifestFile $dirs.Manifest @(
                    New-WowgetTarget -Name 'retail' -Path $addons -Flavor 'mainline'
                    New-WowgetTarget -Name 'odd' -Path $elsewhere -Flavor 'classic'
                ))
            $result = Invoke-WowgetTargetPortable -Options (New-WgOptions $dirs -GameDirs @($dirs.Game))
            $result.converted.name | Should -Be @('retail')
            $result.skipped.name | Should -Be @('odd')
            (Read-WowgetManifest $dirs.Manifest).Targets[0].Folder | Should -Be '_retail_'
            Get-WgErrorCode { Invoke-WowgetTargetPortable -Options (New-WgOptions $dirs) -Names @('nope') } | Should -Be 'usage'
        }

        It 'refuses a folder target that would share a directory, with several game directories' {
            $second = [System.IO.Path]::Combine($dirs.Root, 'game2')
            $addons = [System.IO.Path]::Combine($second, '_retail_', 'Interface', 'AddOns')
            [void](New-WowgetManifestFile $dirs.Manifest @(New-WowgetTarget -Name 'retail' -Path $addons -Flavor 'mainline'))
            $o = New-WgOptions $dirs -GameDirs @($dirs.Game, $second)
            Get-WgErrorCode { Invoke-WowgetTargetAdd -Options $o -Name 'r2' -Folder '_retail_' -Flavor 'mainline' } | Should -Be 'usage'
        }

        It 'removes a duplicate target without uninstalling the addons the other target keeps' {
            $paths = New-WgManifest $dirs
            [void](Add-WgRelease -Source 'github:a/Foo' -ReleaseId 'v1' -Folders @{ Foo = '' })
            [void](Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'github:a/Foo')
            $read = Read-WowgetManifestText $dirs.Manifest
            $dup = New-WowgetManifestObject -Targets (@($read.Manifest.Targets) + (New-WowgetTarget -Name 'dup' -Path $paths.forever -Flavor 'forever')) -Addons $read.Manifest.Addons
            [void](Save-WowgetManifest $dirs.Manifest $read.Text $dup)
            $result = Invoke-WowgetTargetRemove -Options (New-WgOptions $dirs) -Name 'dup'
            @($result.addons).Count | Should -Be 0
            Get-WgFolders $paths.forever | Should -Be @('Foo')
        }

        It 'adds a folder target, refusing a folder another target has' {
            [void](New-WgDir $dirs @('game', '_classic_era_'))
            [void](New-WowgetManifestFile $dirs.Manifest @())
            $o = New-WgOptions $dirs -GameDirs @($dirs.Game)
            $result = Invoke-WowgetTargetAdd -Options $o -Name 'era' -Folder '_classic_era_' -Flavor 'classic'
            $result.createdAddonsDir | Should -BeTrue
            Get-WgErrorCode { Invoke-WowgetTargetAdd -Options $o -Name 'era2' -Folder '_CLASSIC_ERA_' -Flavor 'classic' } | Should -Be 'usage'
            (Invoke-WowgetTargetAdd -Options $o -Name 'retail' -Folder '_retail_' -Flavor 'mainline').target.path | Should -BeNullOrEmpty
        }
    }

    Describe 'pin, unpin and rollback' {
        It 'pins the installed release, rolls back to the previous one from the cache and pins it' {
            $paths = New-WgManifest $dirs
            [void](Add-WgRelease -Source 'github:a/Foo' -ReleaseId 'v1' -Folders @{ Foo = '' })
            [void](Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'github:a/Foo')
            [void](Add-WgRelease -Source 'github:a/Foo' -ReleaseId 'v2' -Folders @{ Foo = '' })
            (Invoke-WowgetUpdate -Options (New-WgOptions $dirs)).addons[0].status | Should -Be 'updated'

            $pin = Invoke-WowgetPin -Options (New-WgOptions $dirs) -Name 'Foo'
            $pin.pin | Should -Be 'v2'
            (Invoke-WowgetUnpin -Options (New-WgOptions $dirs) -Name 'Foo').previousPin | Should -Be 'v2'
            (Invoke-WowgetUnpin -Options (New-WgOptions $dirs) -Name 'Foo').PSObject.Properties['previousPin'] | Should -BeNullOrEmpty

            $script:WgRequests.Clear()
            $rollback = Invoke-WowgetRollback -Options (New-WgOptions $dirs) -Name 'Foo'
            $rollback.addons[0].from | Should -Be '2'
            $rollback.addons[0].to | Should -Be '1'
            $rollback.pinned | Should -Be 'v1'
            $script:WgRequests.Count | Should -Be 0
            [System.IO.File]::ReadAllText([System.IO.Path]::Combine($paths.forever, 'Foo', 'code.lua')) | Should -Be 'v1'
            (Read-WowgetManifest $dirs.Manifest).Addons[0].Pin | Should -Be 'v1'
            (Invoke-WowgetUpdate -Options (New-WgOptions $dirs)).addons[0].status | Should -Be 'current'
        }

        It 'installs an explicit release before writing the pin' {
            [void](New-WgManifest $dirs)
            [void](Add-WgRelease -Source 'github:a/Foo' -ReleaseId 'v2' -Folders @{ Foo = '' })
            [void](Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'github:a/Foo')
            $script:WgReleases['github:a/Foo|*'] = { param($item) if ($item['pin'] -eq 'v1') { $script:WgReleases['v1'] } }
            $bytes = New-WgAddonZipBytes @{ Foo = '' } -Content 'v1'
            $script:WgRoutes['https://github.com/dl/foo-v1.zip'] = @{ StatusCode = 200; Body = $bytes }
            $script:WgReleases['v1'] = @{ ok = $true; releaseId = 'v1'; version = '1'; filename = 'foo-v1.zip'; url = 'https://github.com/dl/foo-v1.zip'; sha256 = (Get-WgSha256 $bytes); md5 = $null; flavorVerified = $true; folders = $null }
            $pin = Invoke-WowgetPin -Options (New-WgOptions $dirs) -Name 'Foo' -Release 'v1'
            $pin.addons[0].releaseId | Should -Be 'v1'
            (Read-WowgetManifest $dirs.Manifest).Addons[0].Pin | Should -Be 'v1'
            $before = [System.IO.File]::ReadAllText($dirs.Manifest)
            Get-WgErrorCode { Invoke-WowgetPin -Options (New-WgOptions $dirs) -Name 'Foo' -Release 'v9' } | Should -Be 'source'
            [System.IO.File]::ReadAllText($dirs.Manifest) | Should -BeExactly $before
        }

        It 'refuses to pin an install whose release is unknown' {
            $paths = New-WgManifest $dirs
            [void](Add-WgRelease -Source 'github:a/Foo' -ReleaseId 'v1' -Folders @{ Foo = '' })
            [void](Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'github:a/Foo')
            $folder = [System.IO.Path]::Combine($paths.forever, 'Foo')
            $marker = (Read-WowgetMarker $folder).Marker
            $marker.ReleaseId = 'unknown'
            Write-WowgetMarker $folder $marker
            Get-WgErrorText { Invoke-WowgetPin -Options (New-WgOptions $dirs) -Name 'Foo' } | Should -Match 'update'
            (Invoke-WowgetOutdated -Options (New-WgOptions $dirs)).addons[0].status | Should -Be 'outdated'
        }
    }
  }
}
