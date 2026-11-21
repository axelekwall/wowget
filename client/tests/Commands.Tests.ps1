BeforeDiscovery {
    Import-Module ([System.IO.Path]::Combine($PSScriptRoot, '..', 'Wowget', 'Wowget.psd1'))
}

InModuleScope Wowget {
    BeforeAll {
        . ([System.IO.Path]::Combine($PSScriptRoot, 'TestHelpers.ps1'))

        function Set-WgRegistry {
            param([object[]]$Addons)
            $doc = @{ version = 'abc'; updatedAt = $null; addons = @($Addons) }
            $script:WgRoutes['https://api.test/v1/registry'] = @{ StatusCode = 200; Body = (ConvertTo-Json $doc -Depth 10) }
        }

        # An addon folder with one TOC holding $Toc after the Interface line.
        function New-WgAddonFolder {
            param([string]$Dir, [string]$Name, [string]$Toc = '', [string]$Interface = '11507')
            $path = [System.IO.Path]::Combine($Dir, $Name)
            [void][System.IO.Directory]::CreateDirectory($path)
            [System.IO.File]::WriteAllText([System.IO.Path]::Combine($path, "$Name.toc"), "## Interface: $Interface`n$Toc")
            return $path
        }
    }

    Describe 'commands' {
        BeforeEach {
            $dirs = New-WgTestDirs
            Set-WgFakeHttp
            Set-WgFakeService
            Set-WgRegistry @()
        }
        AfterEach {
            Remove-WgTestDirs $dirs
            Clear-WgFakeHttp
        }

        Describe 'search' {
            It 'filters on the flavors of the selected targets and asks the service' {
                [void](New-WgManifest $dirs ([ordered]@{ era = 'classic'; retail = 'mainline' }))
                $script:WgRoutes['https://api.test/v1/search?q=deadly%20boss&flavors=mainline&github=1&limit=5'] = @{ StatusCode = 200; Body = '{"rows":[],"warnings":[]}' }
                $r = Invoke-WowgetSearch -Options (New-WgOptions $dirs -Targets @('retail')) -Query ' deadly boss ' -Github -Limit 5
                $r.flavors | Should -Be @('mainline')
                @($r.results).Count | Should -Be 0
            }

            It 'works without a manifest, and rejects empty queries and --flavor with --all-flavors' {
                $script:WgRoutes['https://api.test/v1/search?q=dbm&github=0&limit=20'] = @{ StatusCode = 200; Body = '{"rows":[{"name":"DBM","source":"wowi:8814","origin":"wowi","flavors":{"classic":"unknown"},"folders":[],"downloads":5}],"warnings":[]}' }
                $r = Invoke-WowgetSearch -Options (New-WgOptions $dirs) -Query 'dbm'
                $r.results[0].inManifest | Should -BeFalse
                $r.results[0].downloadsMonthly | Should -Be 5
                $r.flavors | Should -BeNullOrEmpty
                Get-WgErrorCode { Invoke-WowgetSearch -Options (New-WgOptions $dirs) -Query ' - ' } | Should -Be 'usage'
                Get-WgErrorCode { Invoke-WowgetSearch -Options (New-WgOptions $dirs) -Query 'x' -Flavor 'classic' -AllFlavors } | Should -Be 'usage'
            }

            It 'is a network error when the service is off or rate limits' {
                $o = New-WgOptions $dirs
                $o.ApiUrl = 'off'
                Get-WgErrorCode { Invoke-WowgetSearch -Options $o -Query 'dbm' } | Should -Be 'network'
                $script:WgRoutes['https://api.test/v1/search?q=dbm&github=0&limit=20'] = @{ StatusCode = 429; Headers = @{ 'Retry-After' = '60' }; Body = '{"error":{"code":"rate_limited","message":"slow down"}}' }
                Get-WgErrorText { Invoke-WowgetSearch -Options (New-WgOptions $dirs) -Query 'dbm' } | Should -Match 'try again in 60 seconds'
            }
        }

        Describe 'suggest' {
            It 'lists registry and url: addons and builds the issue URL for the others' {
                [void](New-WgManifest $dirs)
                $m = Read-WowgetManifest $dirs.Manifest
                $addons = @(
                    New-WowgetAddonEntry -Name 'Questie' -Source 'github:questie/QUESTIE'
                    New-WowgetAddonEntry -Name 'Foo' -Source 'url:https://example.com/Foo.zip'
                    New-WowgetAddonEntry -Name 'Bar Baz' -Source 'wowi:123'
                )
                [void](Save-WowgetManifest $dirs.Manifest (Read-WowgetText $dirs.Manifest) (New-WowgetManifestObject -Targets $m.Targets -Addons $addons))
                Set-WgRegistry @(@{ name = 'Questie'; source = 'github:Questie/Questie'; folders = @(); aliases = @(); flavors = @() })
                $r = Invoke-WowgetSuggest -Options (New-WgOptions $dirs)
                $r.addons.name | Should -Be @('Bar Baz', 'Foo', 'Questie')
                $r.addons.status | Should -Be @('suggested', 'url', 'listed')
                $r.url | Should -BeExactly 'https://github.com/axelekwall/wowget/issues/new?template=registry-addon.yml&title=Registry%3A+add+Bar+Baz&addons=wowi%3A123+Bar+Baz'
                Get-WgErrorCode { Invoke-WowgetSuggest -Options (New-WgOptions $dirs) -Names @('Nope') } | Should -Be 'usage'
            }

            It 'falls back to the registry snapshot and says so when the service is off' {
                [void](New-WgManifest $dirs)
                $o = New-WgOptions $dirs
                $o.ApiUrl = 'off'
                $script:WowgetRegistrySnapshot = [System.IO.Path]::Combine($dirs.Root, 'registry.json')
                [System.IO.File]::WriteAllText($script:WowgetRegistrySnapshot, '{"version":"s","addons":[]}')
                try {
                    $r = Invoke-WowgetSuggest -Options $o
                    $r.warnings[0] | Should -Match 'turned off; using the registry snapshot'
                } finally {
                    $script:WowgetRegistrySnapshot = $null
                }
            }
        }

        Describe 'reconcile' {
            It 'groups companion folders, takes sources from TOCs and the registry, and leaves marked folders out' {
                $paths = New-WgManifest $dirs ([ordered]@{ era = 'classic' })
                $dir = $paths.era
                New-WgAddonFolder $dir 'DBM-Core' "## Version: 1.2`n## X-Website: https://github.com/DeadlyBossMods/DBM-Classic`n" | Out-Null
                New-WgAddonFolder $dir 'DBM-Raids' "## Dependencies: DBM-Core`n" | Out-Null
                New-WgAddonFolder $dir 'Bagnon' | Out-Null
                New-WgAddonFolder $dir 'Bagnon_Config' | Out-Null
                New-WgAddonFolder $dir 'Mystery' "## X-Curse-Project-ID: 123`n" | Out-Null
                New-WgAddonFolder $dir 'Managed' | Out-Null
                Write-WowgetMarker ([System.IO.Path]::Combine($dir, 'Managed')) (New-WowgetMarker -Addon 'Managed' -Source 'wowi:1' -ReleaseId '1' -Filename 'm.zip' -Folders @('Managed'))
                Set-WgRegistry @(@{ name = 'Bagnon'; source = 'github:tullamods/Bagnon'; folders = @('Bagnon', 'Bagnon_Config'); aliases = @(); flavors = @('classic') })
                $r = Invoke-WowgetReconcile -Options (New-WgOptions $dirs)
                $r.addons.name | Should -Be @('Bagnon', 'DBM-Core', 'Mystery')
                $dbm = $r.addons | Where-Object name -EQ 'DBM-Core'
                $dbm.source | Should -Be 'github:DeadlyBossMods/DBM-Classic'
                $dbm.folders | Should -Be @('DBM-Core', 'DBM-Raids')
                $dbm.version | Should -Be '1.2'
                $dbm.status | Should -Be 'unmanaged'
                ($r.addons | Where-Object name -EQ 'Bagnon').folders | Should -Be @('Bagnon', 'Bagnon_Config')
                $mystery = $r.addons | Where-Object name -EQ 'Mystery'
                $mystery.status | Should -Be 'unmatched'
                $mystery.curseforge | Should -BeTrue
            }

            It 'adopts a matched addon: installs it over the folders and adds it to the manifest' {
                $paths = New-WgManifest $dirs ([ordered]@{ era = 'classic'; retail = 'mainline' })
                New-WgAddonFolder $paths.era 'Addon' "## X-GitHub: o/addon`n" | Out-Null
                Add-WgRelease -Source 'github:o/addon' -ReleaseId 'v2' | Out-Null
                $r = Invoke-WowgetReconcile -Options (New-WgOptions $dirs) -Adopt
                $r.addons[0].status | Should -Be 'adopted'
                $r.addons[0].version | Should -Be '2'
                $entry = (Read-WowgetManifest $dirs.Manifest).Addons[0]
                $entry.Name | Should -Be 'addon'
                $entry.Targets | Should -Be @('era')
                (Read-WowgetMarker ([System.IO.Path]::Combine($paths.era, 'Addon'))).Marker.ReleaseId | Should -Be 'v2'
            }
        }

        Describe 'reconcile with an existing entry' {
            It 'matches a manifest source that differs only in GitHub owner and repository case' {
                $paths = New-WgManifest $dirs ([ordered]@{ era = 'classic' })
                $m = Read-WowgetManifest $dirs.Manifest
                [void](Save-WowgetManifest $dirs.Manifest (Read-WowgetText $dirs.Manifest) (New-WowgetManifestObject -Targets $m.Targets -Addons @(New-WowgetAddonEntry -Name 'Addon' -Source 'github:O/Addon')))
                New-WgAddonFolder $paths.era 'Addon' "## X-GitHub: o/addon`n" | Out-Null
                Add-WgRelease -Source 'github:O/Addon' -ReleaseId 'v2' | Out-Null
                $r = Invoke-WowgetReconcile -Options (New-WgOptions $dirs) -Adopt
                $r.addons[0].status | Should -Be 'adopted'
                $addons = @((Read-WowgetManifest $dirs.Manifest).Addons)
                $addons.Count | Should -Be 1
                $addons[0].Source | Should -BeExactly 'github:O/Addon'
                (Read-WowgetMarker ([System.IO.Path]::Combine($paths.era, 'Addon'))).Marker.Addon | Should -Be 'Addon'
            }
        }

        Describe 'doctor' {
            It 'reports invalid, orphaned and mismatched markers, missing folders and stale cache, and cleans' {
                $paths = New-WgManifest $dirs ([ordered]@{ era = 'classic' })
                Add-WgRelease -Source 'github:o/addon' -ReleaseId 'v1' -Folders @{ Addon = '11507'; AddonExtra = '11507' } | Out-Null
                [void](Invoke-WowgetAdd -Options (New-WgOptions $dirs) -Source 'github:o/addon' -Name 'Addon')
                $dir = $paths.era
                [System.IO.Directory]::Delete([System.IO.Path]::Combine($dir, 'AddonExtra'), $true)
                $broken = New-WgAddonFolder $dir 'Broken'
                [System.IO.File]::WriteAllText([System.IO.Path]::Combine($broken, '.wowget.json'), '{ nope')
                $gone = New-WgAddonFolder $dir 'Gone'
                Write-WowgetMarker $gone (New-WowgetMarker -Addon 'Gone' -Source 'wowi:9' -ReleaseId '9' -Filename 'g.zip' -Folders @('Gone'))
                [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::Combine($dirs.Cache, 'gone', 'old'))
                [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::Combine($dir, '.wowget-tmp-abc'))
                $r = Invoke-WowgetDoctor -Options (New-WgOptions $dirs)
                $kinds = @($r.issues | ForEach-Object kind)
                $kinds | Should -Contain 'invalid_marker'
                $kinds | Should -Contain 'missing_folders'
                $kinds | Should -Contain 'leftover_temp_dir'
                $kinds | Should -Contain 'stale_cache'
                ($r.issues | Where-Object kind -EQ 'orphan_marker').folders | Should -Be @('Gone')
                $kinds | Should -Not -Contain 'missing_cached_zip'

                # Two folders of one install with different markers.
                $other = New-WowgetMarker -Addon 'Addon' -Source 'github:o/addon' -ReleaseId 'v0' -Filename 'a.zip' -Folders @('Addon')
                $extra = New-WgAddonFolder $dir 'AddonExtra'
                Write-WowgetMarker $extra $other
                @((Invoke-WowgetDoctor -Options (New-WgOptions $dirs)).issues | ForEach-Object kind) | Should -Contain 'marker_mismatch'

                $c = Invoke-WowgetDoctor -Options (New-WgOptions $dirs) -Clean
                $c.cleaned | Should -Contain ([System.IO.Path]::Combine($dir, '.wowget-tmp-abc'))
                $c.cleaned | Should -Contain ([System.IO.Path]::Combine($dirs.Cache, 'gone', 'old'))
            }

            It 'reads the client build and reports interface drift, and hints at portable targets' {
                $game = New-WgDir $dirs @('game')
                $addons = New-WgDir $dirs @('game', '_classic_era_', 'Interface', 'AddOns')
                [System.IO.File]::WriteAllText([System.IO.Path]::Combine($game, '.build.info'), "Branch!STRING:0|Active!DEC:1|Version!STRING:0|Product!STRING:0`neu|1|1.15.8.63000|wow_classic_era`n")
                [System.IO.File]::WriteAllText([System.IO.Path]::Combine($game, '_classic_era_', 'Wow.exe'), '')
                [void](New-WowgetManifestFile $dirs.Manifest @(New-WowgetTarget -Name 'era' -Path $addons -Flavor 'classic'))
                Add-WgRelease -Source 'github:o/addon' -ReleaseId 'v1' -Folders @{ Addon = '11507' } | Out-Null
                $o = New-WgOptions $dirs -GameDirs @($game)
                [void](Invoke-WowgetAdd -Options $o -Source 'github:o/addon' -Name 'Addon')
                $r = Invoke-WowgetDoctor -Options $o
                $r.targets[0].clientInterface | Should -Be 11508
                ($r.issues | Where-Object kind -EQ 'interface_drift').message | Should -Match 'lists Interface 11507, but client is 11508'
                $r.hints[0].kind | Should -Be 'portable_target'
                $r.hints[0].folder | Should -Be '_classic_era_'
            }
        }
    }
}
