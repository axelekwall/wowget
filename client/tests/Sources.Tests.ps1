BeforeDiscovery {
    Import-Module ([System.IO.Path]::Combine($PSScriptRoot, '..', 'Wowget', 'Wowget.psd1'))
}

InModuleScope Wowget {
    BeforeAll { . ([System.IO.Path]::Combine($PSScriptRoot, 'TestHelpers.ps1')) }

    Describe 'url source' {
        BeforeEach { $dirs = New-WgTestDirs; Set-WgFakeHttp }
        AfterEach { Remove-WgTestDirs $dirs; Clear-WgFakeHttp }

        It 'saves a 200 under its hash, reuses it on 304, and gives a new release for a new body' {
            $url = 'https://example.com/dl/Foo.zip'
            $spec = ConvertFrom-WowgetSource "url:$url"
            $one = New-WgAddonZipBytes @{ Foo = '' } -Content 'one'
            Set-WgUrlZip $url $one 'etag-1'
            $first = Resolve-WowgetUrlSource -Addon 'Foo' -Spec $spec -CacheDir $dirs.Cache
            $first.ReleaseId | Should -Be (Get-WgSha256 $one)
            $first.Version | Should -Be (Get-WgSha256 $one).Substring(0, 12)
            $first.Filename | Should -Be 'Foo.zip'
            [System.IO.File]::Exists($first.LocalPath) | Should -BeTrue

            $second = Resolve-WowgetUrlSource -Addon 'Foo' -Spec $spec -CacheDir $dirs.Cache
            $script:WgRequests[-1].Headers['If-None-Match'] | Should -Be 'etag-1'
            $second.ReleaseId | Should -Be $first.ReleaseId

            $two = New-WgAddonZipBytes @{ Foo = '' } -Content 'two'
            Set-WgUrlZip $url $two 'etag-2'
            (Resolve-WowgetUrlSource -Addon 'Foo' -Spec $spec -CacheDir $dirs.Cache).ReleaseId | Should -Be (Get-WgSha256 $two)
        }

        It 'fetches again without validators when the cached file disappeared' {
            $url = 'https://example.com/Foo.zip'
            $spec = ConvertFrom-WowgetSource "url:$url"
            Set-WgUrlZip $url (New-WgAddonZipBytes @{ Foo = '' }) 'etag-1'
            $first = Resolve-WowgetUrlSource -Addon 'Foo' -Spec $spec -CacheDir $dirs.Cache
            [System.IO.File]::Delete($first.LocalPath)
            $again = Resolve-WowgetUrlSource -Addon 'Foo' -Spec $spec -CacheDir $dirs.Cache
            $script:WgRequests[-1].Headers.ContainsKey('If-None-Match') | Should -BeFalse
            [System.IO.File]::Exists($again.LocalPath) | Should -BeTrue
        }

        It 'reports a body that is not a zip as a zip error and caches nothing' {
            $url = 'https://example.com/Foo.zip'
            $script:WgRoutes[$url] = @{ StatusCode = 200; Body = 'nope' }
            Get-WgErrorCode { Resolve-WowgetUrlSource -Addon 'Foo' -Spec (ConvertFrom-WowgetSource "url:$url") -CacheDir $dirs.Cache } | Should -Be 'zip'
            [System.IO.Directory]::Exists([System.IO.Path]::Combine($dirs.Cache, 'foo')) | Should -BeFalse
        }

        It 'follows redirects to any https host and fails a pin the file no longer matches' {
            $script:WgRoutes['https://example.com/latest'] = @{ StatusCode = 302; Headers = @{ Location = 'https://cdn.example.net/Foo-2.zip' } }
            $bytes = New-WgAddonZipBytes @{ Foo = '' }
            $script:WgRoutes['https://cdn.example.net/Foo-2.zip'] = @{ StatusCode = 200; Body = $bytes }
            $spec = ConvertFrom-WowgetSource 'url:https://example.com/latest'
            (Resolve-WowgetUrlSource -Addon 'Foo' -Spec $spec -CacheDir $dirs.Cache).ReleaseId | Should -Be (Get-WgSha256 $bytes)
            Get-WgErrorText { Resolve-WowgetUrlSource -Addon 'Foo' -Spec $spec -Pin 'abc' -CacheDir $dirs.Cache } | Should -Match 'pinned to abc'
        }
    }

    Describe 'service client' {
        BeforeEach { $dirs = New-WgTestDirs; Set-WgFakeHttp; Set-WgFakeService }
        AfterEach { Remove-WgTestDirs $dirs; Clear-WgFakeHttp; $script:ResolveBatchSize = 20 }

        It 'sends each distinct item once, in batches of the service size' {
            $script:ResolveBatchSize = 2
            foreach ($n in 1..3) { [void](Add-WgRelease -Source "github:a/r$n" -ReleaseId "v$n") }
            $items = @(
                [pscustomobject]@{ source = 'github:a/r1'; flavor = 'classic'; prerelease = $false; pin = $null }
                [pscustomobject]@{ source = 'github:a/r1'; flavor = 'classic'; prerelease = $false; pin = $null }
                [pscustomobject]@{ source = 'github:a/r2'; flavor = 'classic'; prerelease = $false; pin = $null }
                [pscustomobject]@{ source = 'github:a/r3'; flavor = 'forever'; prerelease = $false; pin = $null }
            )
            $results = Invoke-WowgetResolve -ApiUrl 'https://api.test' -Items $items
            $script:WgResolveBatches.Count | Should -Be 2
            @($script:WgResolveBatches[0]).Count | Should -Be 2
            @($script:WgResolveBatches[1]).Count | Should -Be 1
            $results[(Get-WowgetResolveKey $items[3])].ReleaseId | Should -Be 'v3'
            $script:WgRequests[0].Headers['Accept'] | Should -Be 'application/json'
        }

        It 'maps per-item errors to flavor and source, and refuses download hosts outside the allowlist' {
            $script:WgReleases['github:a/flavor|*'] = @{ ok = $false; error = @{ code = 'flavor'; message = 'lists classic, mists but not forever' } }
            $script:WgReleases['github:a/up|*'] = @{ ok = $false; error = @{ code = 'upstream'; message = 'GitHub failed' } }
            $script:WgReleases['github:a/host|*'] = @{ ok = $true; releaseId = 'v1'; version = '1'; filename = 'a.zip'; url = 'https://evil.example/a.zip'; sha256 = $null; md5 = $null; flavorVerified = $true; folders = $null }
            $items = @('github:a/flavor', 'github:a/up', 'github:a/host') | ForEach-Object { [pscustomobject]@{ source = $_; flavor = 'forever'; prerelease = $false; pin = $null } }
            $results = Invoke-WowgetResolve -ApiUrl 'https://api.test' -Items $items
            $results[(Get-WowgetResolveKey $items[0])].Code | Should -Be 'flavor'
            $results[(Get-WowgetResolveKey $items[0])].Message | Should -Match 'not forever'
            $results[(Get-WowgetResolveKey $items[1])].Code | Should -Be 'source'
            $results[(Get-WowgetResolveKey $items[2])].Code | Should -Be 'source'
        }

        It 'turns a rate limit into a rate_limited error naming Retry-After, and other failures into network errors' {
            $item = [pscustomobject]@{ source = 'github:a/b'; flavor = 'forever'; prerelease = $false; pin = $null }
            $script:WgRoutes['https://api.test/v1/resolve'] = @{ StatusCode = 429; Headers = @{ 'Retry-After' = '30' }; Body = '{"error":{"code":"rate_limited","message":"slow down"}}' }
            $err = (Invoke-WowgetResolve -ApiUrl 'https://api.test' -Items @($item))[(Get-WowgetResolveKey $item)]
            $err.Code | Should -Be 'rate_limited'
            $err.Message | Should -Match '30 seconds'
            $script:WgRoutes['https://api.test/v1/resolve'] = @{ StatusCode = 500; Body = '{"error":{"code":"internal","message":"boom"}}' }
            (Invoke-WowgetResolve -ApiUrl 'https://api.test' -Items @($item))[(Get-WowgetResolveKey $item)].Code | Should -Be 'network'
            (Invoke-WowgetResolve -ApiUrl 'off' -Items @($item))[(Get-WowgetResolveKey $item)].Code | Should -Be 'network'
        }

        It 'reads the registry with an ETag cache and falls back to the cached copy when offline' {
            $doc = '{"version":3,"addons":[{"name":"Questie","aliases":["questie-classic"],"source":"github:Questie/Questie","flavors":["classic"],"folders":["Questie"],"disabled":null}]}'
            $script:WgRoutes['https://api.test/v1/registry'] = { param($r) if ($r.Headers['If-None-Match'] -eq '"3"') { @{ StatusCode = 304 } } else { @{ StatusCode = 200; Headers = @{ ETag = '"3"' }; Body = $doc } } }
            $first = Get-WowgetRegistry -ApiUrl 'https://api.test' -CacheDir $dirs.Cache
            (Find-WowgetRegistryEntry $first.Entries 'Questie Classic').Source | Should -Be 'github:Questie/Questie'
            $again = Get-WowgetRegistry -ApiUrl 'https://api.test' -CacheDir $dirs.Cache
            $script:WgRequests[-1].Headers['If-None-Match'] | Should -Be '"3"'
            $again.Entries.Count | Should -Be 1
            $offline = Get-WowgetRegistry -ApiUrl 'off' -CacheDir $dirs.Cache
            $offline.Stale | Should -Match 'earlier run'
            $offline.Entries.Count | Should -Be 1
        }
    }

    Describe 'markers' {
        BeforeEach { $dirs = New-WgTestDirs }
        AfterEach { Remove-WgTestDirs $dirs }

        It 'reads back what it writes, and treats a marker that does not parse as no marker' {
            $folder = New-WgDir $dirs @('AddOns', 'Questie')
            $marker = New-WowgetMarker -Addon 'Questie' -Source 'github:Questie/Questie' -ReleaseId 'v11.4.2' -AddonVersion '11.4.2' -Filename 'Q.zip' -Sha256 'ab' -Folders @('Questie') -InstalledAt '2026-11-20T10:00:00Z' -Previous ([pscustomobject]@{ ReleaseId = 'v11.4.1'; AddonVersion = '11.4.1'; Filename = 'Q1.zip'; Sha256 = $null })
            Write-WowgetMarker $folder $marker
            $read = Read-WowgetMarker $folder
            $read.Status | Should -Be 'ok'
            $read.Marker.InstalledAt | Should -Be '2026-11-20T10:00:00Z'
            $read.Marker.Previous.ReleaseId | Should -Be 'v11.4.1'
            [System.IO.File]::WriteAllText([System.IO.Path]::Combine($folder, '.wowget.json'), '{ "version": 1 }')
            (Read-WowgetMarker $folder).Status | Should -Be 'invalid'
            [void](New-WgDir $dirs @('AddOns', 'Blizzard_UI'))
            (Get-WowgetTargetMarkers ([System.IO.Path]::Combine($dirs.Root, 'AddOns'))).Keys | Should -Be @('Questie')
        }
    }
}
