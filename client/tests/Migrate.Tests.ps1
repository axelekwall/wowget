BeforeDiscovery {
    Import-Module ([System.IO.Path]::Combine($PSScriptRoot, '..', 'Wowget', 'Wowget.psd1'))
}

InModuleScope Wowget {
    BeforeAll {
        . ([System.IO.Path]::Combine($PSScriptRoot, 'TestHelpers.ps1'))

        # Puts a zip into the cache as the Bun client kept it: <cache>/<addon, lower-case>/<dir>/<file>.
        function Add-WgBunCache {
            param($Dirs, [string]$Addon, [string]$Dir, [string]$Filename, [byte[]]$Bytes, [int]$AgeMinutes = 0)
            $path = [System.IO.Path]::Combine($Dirs.Cache, $Addon.ToLowerInvariant(), $Dir, $Filename)
            [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($path))
            [System.IO.File]::WriteAllBytes($path, $Bytes)
            [System.IO.File]::SetLastWriteTimeUtc($path, [DateTime]::UtcNow.AddMinutes(-$AgeMinutes))
            return $path
        }

        # Extracts a zip into an AddOns directory the way an install by the Bun client left it: no markers.
        function Install-WgBunZip {
            param([byte[]]$Bytes, [string]$AddonsDir)
            $tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'wowget-bun-' + [System.IO.Path]::GetRandomFileName() + '.zip')
            [System.IO.File]::WriteAllBytes($tmp, $Bytes)
            try { [System.IO.Compression.ZipFile]::ExtractToDirectory($tmp, $AddonsDir, $true) } finally { [System.IO.File]::Delete($tmp) }
        }

        function Set-WgRegistry {
            param([object[]]$Addons)
            $doc = @{ version = 'abc'; updatedAt = $null; addons = @($Addons) }
            $script:WgRoutes['https://api.test/v1/registry'] = @{ StatusCode = 200; Headers = @{ ETag = '"abc"' }; Body = (ConvertTo-Json $doc -Depth 10) }
        }

        # A fake resolve answer for a pinned release whose zip is $Bytes.
        function Add-WgPinned {
            param([string]$Source, [string]$Pin, [string]$ReleaseId, [string]$Filename, [byte[]]$Bytes)
            $script:WgPins["$Source|$Pin"] = @{ ok = $true; releaseId = $ReleaseId; version = $ReleaseId.TrimStart('v'); filename = $Filename; url = "https://github.com/dl/$Filename"; sha256 = (Get-WgSha256 $Bytes); md5 = $null; flavorVerified = $true; folders = $null }
        }
    }

    Describe 'migrate' {
        BeforeEach {
            $dirs = New-WgTestDirs
            Set-WgFakeHttp
            Set-WgFakeService
            $script:WgPins = @{}
            $script:WgReleases['github:o/questie|*'] = { param($item) $script:WgPins["github:o/questie|$($item['pin'])"] }
            $script:WgReleases['github:o/bar|*'] = { param($item) $script:WgPins["github:o/bar|$($item['pin'])"] }
            $paths = New-WgManifest $dirs ([ordered]@{ era = 'classic'; retail = 'mainline' })
            $o = New-WgOptions $dirs
        }
        AfterEach {
            Remove-WgTestDirs $dirs
            Clear-WgFakeHttp
        }

        It 'adopts with the release found by content, a previous release and the recovered ids' {
            $old = New-WgAddonZipBytes @{ Questie = ''; QuestieDB = '' } -Content 'old'
            $new = New-WgAddonZipBytes @{ Questie = ''; QuestieDB = '' } -Content 'new'
            Add-WgBunCache $dirs 'Questie' 'v1.0' 'Questie-v1.0.zip' $old -AgeMinutes 60 | Out-Null
            Add-WgBunCache $dirs 'Questie' 'v2.0' 'Questie-v2.0.zip' $new | Out-Null
            Add-WgPinned 'github:o/questie' 'v1.0' 'v1.0' 'Questie-v1.0.zip' $old
            Add-WgPinned 'github:o/questie' 'v2.0' 'v2.0' 'Questie-v2.0.zip' $new
            Install-WgBunZip $new $paths.era
            Install-WgBunZip $old $paths.retail
            $m = Read-WowgetManifest $dirs.Manifest
            [void](Save-WowgetManifest $dirs.Manifest (Read-WowgetText $dirs.Manifest) (New-WowgetManifestObject -Targets $m.Targets -Addons @(New-WowgetAddonEntry -Name 'Questie' -Source 'github:o/questie')))

            $r = Invoke-WowgetMigrate -Options $o
            $era = $r.adopted | Where-Object target -EQ 'era'
            $era.how | Should -Be 'cache'
            $era.releaseId | Should -Be 'v2.0'
            $era.previous | Should -Be 'v1.0'
            $era.folders | Should -Be @('Questie', 'QuestieDB')
            ($r.adopted | Where-Object target -EQ 'retail').releaseId | Should -Be 'v1.0'

            $list = Invoke-WowgetList -Options $o
            ($list.addons | Where-Object target -EQ 'era').version | Should -Be '2.0'
            ($list.addons | Where-Object target -EQ 'era').status | Should -Be 'ok'
            # rollback on era reinstalls v1.0 from the cache.
            $o.Targets = @('era')
            (Invoke-WowgetRollback -Options $o -Name 'Questie').addons[0].releaseId | Should -Be 'v1.0'
            [System.IO.File]::Exists((Get-WowgetMigrationRecordPath $o.Env)) | Should -BeTrue
        }

        It 'moves a cached zip to the path this client computes for the recovered release id' -Skip:($IsWindows) {
            $zip = New-WgAddonZipBytes @{ Questie = '' } -Content 'q'
            $bunPath = Add-WgBunCache $dirs 'Questie' 'v1?beta' 'Questie.zip' $zip
            Add-WgPinned 'github:o/questie' 'v1?beta' 'v1?beta' 'Questie.zip' $zip
            Install-WgBunZip $zip $paths.era
            $m = Read-WowgetManifest $dirs.Manifest
            [void](Save-WowgetManifest $dirs.Manifest (Read-WowgetText $dirs.Manifest) (New-WowgetManifestObject -Targets $m.Targets -Addons @(New-WowgetAddonEntry -Name 'Questie' -Source 'github:o/questie' -Targets @('era'))))
            $r = Invoke-WowgetMigrate -Options $o
            $r.adopted[0].releaseId | Should -Be 'v1?beta'
            [System.IO.File]::Exists($bunPath) | Should -BeFalse
            [System.IO.File]::Exists((Get-WowgetCachedZipPath $dirs.Cache 'Questie' 'v1?beta' 'Questie.zip')) | Should -BeTrue
        }

        It 'writes releaseId unknown when the service cannot be reached' {
            $zip = New-WgAddonZipBytes @{ Questie = '' } -Content 'q'
            Add-WgBunCache $dirs 'Questie' 'v1.0' 'Questie-v1.0.zip' $zip | Out-Null
            Install-WgBunZip $zip $paths.era
            $m = Read-WowgetManifest $dirs.Manifest
            [void](Save-WowgetManifest $dirs.Manifest (Read-WowgetText $dirs.Manifest) (New-WowgetManifestObject -Targets $m.Targets -Addons @(New-WowgetAddonEntry -Name 'Questie' -Source 'github:o/questie' -Targets @('era'))))
            $o.ApiUrl = 'off'
            $r = Invoke-WowgetMigrate -Options $o
            $r.adopted[0].releaseId | Should -Be 'unknown'
            $r.adopted[0].how | Should -Be 'cache'
            $marker = (Read-WowgetMarker ([System.IO.Path]::Combine($paths.era, 'Questie'))).Marker
            $marker.Sha256 | Should -Be (Get-WgSha256 $zip)
            Get-WgErrorCode { Invoke-WowgetPin -Options $o -Name 'Questie' } | Should -Be 'usage'
        }

        It 'uses the SHA-256 as the release id of a url: source' {
            $zip = New-WgAddonZipBytes @{ Foo = '' } -Content 'f'
            $sha = Get-WgSha256 $zip
            Add-WgBunCache $dirs 'Foo' $sha 'Foo.zip' $zip | Out-Null
            Install-WgBunZip $zip $paths.era
            $m = Read-WowgetManifest $dirs.Manifest
            [void](Save-WowgetManifest $dirs.Manifest (Read-WowgetText $dirs.Manifest) (New-WowgetManifestObject -Targets $m.Targets -Addons @(New-WowgetAddonEntry -Name 'Foo' -Source 'url:https://example.com/Foo.zip' -Targets @('era'))))
            $r = Invoke-WowgetMigrate -Options $o
            $r.adopted[0].releaseId | Should -Be $sha
            $script:WgResolveBatches.Count | Should -Be 0
        }

        It 'falls back to registry folders, leaves folders two addons claim and lists unmarked folders' {
            Set-WgRegistry @(
                @{ name = 'Questie'; source = 'github:O/Questie'; folders = @('Questie', 'Shared'); aliases = @(); flavors = @('classic') }
                @{ name = 'Bar'; source = 'github:o/bar'; folders = @('Bar', 'Shared'); aliases = @(); flavors = @('classic') }
            )
            foreach ($f in 'Questie', 'Shared', 'Bar', 'Leftover') {
                $dir = New-WgDir $dirs @('wow', 'era', 'Interface', 'AddOns', $f)
                [System.IO.File]::WriteAllText([System.IO.Path]::Combine($dir, "$f.toc"), "## Interface: 11507`n")
            }
            $m = Read-WowgetManifest $dirs.Manifest
            $addons = @(
                New-WowgetAddonEntry -Name 'Questie' -Source 'github:o/questie' -Targets @('era')
                New-WowgetAddonEntry -Name 'Bar' -Source 'github:o/bar' -Targets @('era')
            )
            [void](Save-WowgetManifest $dirs.Manifest (Read-WowgetText $dirs.Manifest) (New-WowgetManifestObject -Targets $m.Targets -Addons $addons))
            $r = Invoke-WowgetMigrate -Options $o
            ($r.adopted | Where-Object name -EQ 'Questie').folders | Should -Be @('Questie')
            ($r.adopted | Where-Object name -EQ 'Questie').how | Should -Be 'fallback'
            ($r.adopted | Where-Object name -EQ 'Bar').releaseId | Should -Be 'unknown'
            $r.conflicts[0].folder | Should -Be 'Shared'
            $r.unmarked[0].folders | Should -Be @('Leftover', 'Shared')
            (Invoke-WowgetOutdated -Options (New-WgOptions $dirs -Targets @('era'))).addons.status | Should -Not -Contain 'not installed'
        }

        It 'converts a wowget.toml next to the default manifest path before adopting' {
            $dir = [System.IO.Path]::GetDirectoryName($dirs.Manifest)
            [System.IO.File]::Delete($dirs.Manifest)
            $toml = "[targets.era]`npath = $(ConvertTo-WowgetJsonString $paths.era)`nflavor = `"classic`"`n"
            [System.IO.File]::WriteAllText([System.IO.Path]::Combine($dir, 'wowget.toml'), $toml)
            (Get-WowgetMigrationNeed $dirs.Manifest $false $o.Env).Adopt | Should -BeTrue
            $r = Invoke-WowgetMigrate -Options $o
            $r.converted.written | Should -BeTrue
            $r.manifestPath | Should -Be $dirs.Manifest
            (Read-WowgetManifest $dirs.Manifest).Targets[0].Name | Should -Be 'era'
            (Get-WowgetMigrationNeed $dirs.Manifest $false $o.Env).Adopt | Should -BeFalse
        }

        It 'needs adoption on first start only where the Bun client left its state database' {
            (Get-WowgetMigrationNeed $dirs.Manifest $false $o.Env).Adopt | Should -BeFalse
            [void][System.IO.Directory]::CreateDirectory($dirs.State)
            [System.IO.File]::WriteAllText([System.IO.Path]::Combine($dirs.State, 'state.db'), '')
            (Get-WowgetMigrationNeed $dirs.Manifest $false $o.Env).Adopt | Should -BeTrue
        }
    }
}
