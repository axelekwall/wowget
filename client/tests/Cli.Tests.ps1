BeforeDiscovery {
    Import-Module ([System.IO.Path]::Combine($PSScriptRoot, '..', 'Wowget', 'Wowget.psd1'))
}

InModuleScope Wowget {
    BeforeAll { . ([System.IO.Path]::Combine($PSScriptRoot, 'TestHelpers.ps1')) }

    Describe 'cli' {
        BeforeEach { $dirs = New-WgTestDirs; Set-WgFakeHttp; Set-WgFakeService }
        AfterEach { Remove-WgTestDirs $dirs; Clear-WgFakeHttp }

        It 'prints the version and help, and exits 2 on usage errors' {
            $r = Invoke-WgCli $dirs @('--version')
            $r.Exit | Should -Be 0
            $r.Out | Should -BeExactly "wowget $script:WowgetVersion`n"
            $r = Invoke-WgCli $dirs @('--help')
            $r.Exit | Should -Be 0
            $r.Out | Should -Match 'Usage: wowget <command>'
            $r = Invoke-WgCli $dirs @()
            $r.Exit | Should -Be 2
            $r.Err | Should -Match 'Usage: wowget'
            (Invoke-WgCli $dirs @('frob')).Exit | Should -Be 2
            (Invoke-WgCli $dirs @('list', '--manifest', '')).Exit | Should -Be 2
            (Invoke-WgCli $dirs @('list', '--prerelease')).Err | Should -Match '--prerelease is not an option of "list"'
            (Invoke-WgCli $dirs @('unpin')).Err | Should -Match 'Wrong number of arguments'
            (Invoke-WgCli $dirs @('add', 'x', '--name')).Err | Should -Match 'argument missing'
            (Invoke-WgCli $dirs @('init', '--flavor', 'tbc')).Err | Should -Match 'Unknown flavor'
            $limit = Invoke-WgCli $dirs @('search', 'questie', '--limit', '51')
            $limit.Exit | Should -Be 2
            $limit.Err | Should -Match '--limit must be a whole number from 1 to 50'
        }

        It 'prints search results, marking those in the manifest, and notes that --refresh does nothing' {
            [void](New-WowgetManifestFile $dirs.Manifest @(New-WowgetTarget -Name 'era' -Path (New-WgDir $dirs @('era')) -Flavor 'classic'))
            Add-WgRelease -Source 'github:Questie/Questie' -ReleaseId 'v1' | Out-Null
            (Invoke-WgCli $dirs @('add', 'github:Questie/Questie', '--name', 'Questie')).Exit | Should -Be 0
            $script:WgRoutes['https://api.test/v1/search?q=ques&flavors=classic&github=0&limit=20'] = @{
                StatusCode = 200
                Body       = '{"rows":[{"name":"Questie","source":"github:questie/questie","origin":"registry","flavors":{"classic":"yes","mists":"unknown"},"folders":["Questie"],"description":null,"downloads":null,"stars":null,"updatedAt":null,"url":null},{"name":"QuestHelper","source":"wowi:1","origin":"wowi","flavors":{"classic":"yes"},"folders":[],"description":"x","downloads":12,"stars":null,"updatedAt":"2026-01-02T03:04:05Z","url":"https://example.com"}],"warnings":["WoWInterface catalogue unavailable"]}'
            }
            $r = Invoke-WgCli $dirs @('search', 'ques', '--refresh')
            $r.Err | Should -Not -Match 'error'
            $r.Exit | Should -Be 0
            $lines = $r.Out.TrimEnd("`n") -split "`n"
            $lines[0] | Should -Match '^\s+NAME\s+SOURCE\s+FLAVORS\s+POPULARITY\s+UPDATED$'
            $lines[1] | Should -Match '^\*\s+Questie\s+github:questie/questie\s+classic mists\?'
            $lines[2] | Should -Match 'QuestHelper\s+wowi:1\s+classic\s+12/month\s+2026-01-02$'
            $r.Err | Should -Match 'note: --refresh does nothing'
            $r.Err | Should -Match 'warning: WoWInterface catalogue unavailable'
            $j = Invoke-WgCli $dirs @('search', 'ques', '--json')
            $doc = $j.Out | ConvertFrom-Json -AsHashtable
            $doc['results'][0]['inManifest'] | Should -BeTrue
            $doc['results'][1]['downloadsMonthly'] | Should -Be 12
            $doc['flavors'] | Should -Be @('classic')
        }

        It 'opens the suggestion issue in a browser unless --print is given' {
            [void](New-WowgetManifestFile $dirs.Manifest @(New-WowgetTarget -Name 'era' -Path (New-WgDir $dirs @('era')) -Flavor 'classic'))
            Add-WgRelease -Source 'github:o/foo' -ReleaseId 'v1' | Out-Null
            (Invoke-WgCli $dirs @('add', 'github:o/foo', '--name', 'Foo')).Exit | Should -Be 0
            $script:WgRoutes['https://api.test/v1/registry'] = @{ StatusCode = 200; Body = '{"version":"x","addons":[]}' }
            $script:WgOpened = [System.Collections.Generic.List[string]]::new()
            $saved = $script:WowgetOpenUrl
            $script:WowgetOpenUrl = { param($u) $script:WgOpened.Add($u); $true }
            try {
                $r = Invoke-WgCli $dirs @('suggest')
                $r.Exit | Should -Be 0
                $r.Out | Should -Match 'Foo\s+github:o/foo\s+not in the registry'
                $script:WgOpened.Count | Should -Be 1
                $script:WgOpened[0] | Should -Match 'addons=github%3Ao%2Ffoo\+Foo'
                (Invoke-WgCli $dirs @('suggest', '--print')).Exit | Should -Be 0
                $script:WgOpened.Count | Should -Be 1
            } finally {
                $script:WowgetOpenUrl = $saved
            }
        }

        It 'reports the automatic first start on stderr and keeps --json output clean' {
            $era = New-WgDir $dirs @('era')
            $dir = New-WgDir $dirs @('wowget')
            [System.IO.File]::WriteAllText([System.IO.Path]::Combine($dir, 'wowget.toml'), "[targets.era]`npath = $(ConvertTo-WowgetJsonString $era)`nflavor = `"classic`"`n")
            $r = Invoke-WgCli $dirs @('list', '--json') @{ WOWGET_MANIFEST = $null; XDG_CONFIG_HOME = $dirs.Root; APPDATA = $dirs.Root }
            $r.Out | Should -Not -Match '"error"'
            $r.Exit | Should -Be 0
            ($r.Out | ConvertFrom-Json).targets[0].name | Should -Be 'era'
            $r.Err | Should -Match 'wowget: Converted .*wowget.toml'
            $again = Invoke-WgCli $dirs @('list') @{ WOWGET_MANIFEST = $null; XDG_CONFIG_HOME = $dirs.Root; APPDATA = $dirs.Root }
            $again.Err | Should -BeNullOrEmpty
        } -Skip:($IsMacOS)

        It 'exits 1 when doctor finds issues, and refuses self-update outside an install' {
            [void](New-WowgetManifestFile $dirs.Manifest @(New-WowgetTarget -Name 'era' -Path ([System.IO.Path]::Combine($dirs.Root, 'nowhere')) -Flavor 'classic'))
            $d = Invoke-WgCli $dirs @('doctor')
            $d.Exit | Should -Be 1
            $d.Out | Should -Match 'Issue \[missing_target_dir\]'
            $s = Invoke-WgCli $dirs @('self-update', '--check')
            $s.Exit | Should -Be 2
            $s.Err | Should -Match 'development copy'
        }

        It 'prints only JSON on stdout for init and list --json' {
            $addons = New-WgDir $dirs @('AddOns')
            $init = Invoke-WgCli $dirs @('init', '--path', $addons, '--flavor', 'classic', '--json')
            $init.Exit | Should -Be 0
            ($init.Out | ConvertFrom-Json).targets[0].path | Should -Be $addons
            $list = Invoke-WgCli $dirs @('list', '--json')
            $list.Exit | Should -Be 0
            $doc = $list.Out | ConvertFrom-Json -AsHashtable
            $doc['addons'].Count | Should -Be 0
            $doc['targets'][0]['name'] | Should -Be 'classic'
        }

        It 'exits 1 for a missing manifest, with a JSON error under --json' {
            $r = Invoke-WgCli $dirs @('list')
            $r.Exit | Should -Be 1
            $r.Err | Should -Match 'Manifest not found'
            $j = Invoke-WgCli $dirs @('list', '--json')
            $j.Exit | Should -Be 1
            ($j.Out | ConvertFrom-Json).error.code | Should -Be 'not_found'
            $u = Invoke-WgCli $dirs @('list', '--json', '-t', 'x', '--manifest', '')
            $u.Exit | Should -Be 2
            ($u.Out | ConvertFrom-Json).error.code | Should -Be 'usage'
        }

        It 'adds targets, lists them, filters with -t, and adds, updates and removes an addon' {
            [void](New-WowgetManifestFile $dirs.Manifest @())
            $era = New-WgDir $dirs @('era')
            $forever = [System.IO.Path]::Combine($dirs.Root, 'forever')
            (Invoke-WgCli $dirs @('target', 'add', 'era', '--path', $era, '--flavor', 'classic')).Exit | Should -Be 0
            $added = Invoke-WgCli $dirs @('target', 'add', 'forever', '--path', $forever, '--flavor', 'forever')
            $added.Out | Should -Match "Created $([regex]::Escape($forever))"
            $targets = Invoke-WgCli $dirs @('target', 'list')
            $targets.Out | Should -Match 'TARGET\s+FLAVOR\s+PATH\s+EXISTS'

            [void](Add-WgRelease -Source 'github:a/Foo' -ReleaseId 'v1' -Folders @{ Foo = '' })
            $add = Invoke-WgCli $dirs @('add', 'github:a/Foo', '-t', 'era')
            $add.Exit | Should -Be 0
            $add.Out | Should -Match 'Added Foo 1 to era \(Foo\)'
            $add.Err | Should -Match 'Foo: downloading'
            $list = Invoke-WgCli $dirs @('list', '-t', 'era')
            $list.Out | Should -Match 'Foo\s+era\s+1\s+ok\s+github:a/Foo'
            [void](Add-WgRelease -Source 'github:a/Foo' -ReleaseId 'v2' -Folders @{ Foo = '' })
            (Invoke-WgCli $dirs @('outdated')).Out | Should -Match 'Foo\s+era\s+1\s+2\s+outdated'
            (Invoke-WgCli $dirs @('update')).Out | Should -Match 'Foo\s+era\s+updated\s+1 -> 2'
            (Invoke-WgCli $dirs @('remove', 'Foo')).Out | Should -Match "Removed Foo`n  era: removed Foo"
        }

        It 'exits 1 when a row fails' {
            [void](New-WgManifest $dirs)
            $read = Read-WowgetManifestText $dirs.Manifest
            $m = New-WowgetManifestObject -Targets $read.Manifest.Targets -Addons @(New-WowgetAddonEntry -Name 'Broken' -Source 'github:a/Broken')
            [void](Save-WowgetManifest $dirs.Manifest $read.Text $m)
            $r = Invoke-WgCli $dirs @('update')
            $r.Exit | Should -Be 1
            $r.Out | Should -Match 'Broken\s+forever\s+error'
        }

        It 'fails a write command with a locked error while another process holds the lock' {
            [void](New-WgManifest $dirs)
            $held = Enter-WowgetLock -StateDir $dirs.State
            try {
                $r = Invoke-WgCli $dirs @('install') -LockTimeoutMs 200
                $r.Exit | Should -Be 1
                $r.Err | Should -Match 'Another wowget process is running'
                (Invoke-WgCli $dirs @('list') -LockTimeoutMs 200).Exit | Should -Be 0
            } finally {
                $held.Dispose()
            }
        }
    }

    Describe 'entry point' {
        BeforeAll {
            $pwsh = [System.Environment]::ProcessPath
            $entry = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($PSScriptRoot, '..', 'wowget.ps1'))
            $run = {
                param([string[]]$Arguments)
                $out = & $pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $entry @Arguments 2>$null
                [pscustomobject]@{ Exit = $LASTEXITCODE; Out = ($out -join "`n") }
            }
        }

        It 'runs as a script and prints the version' {
            $r = & $run @('--version')
            $r.Exit | Should -Be 0
            $r.Out | Should -Match '^wowget '
        }

        It 'passes options, values with spaces and percent signs through to the CLI' {
            $missing = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "wowget no such dir %OS% $([guid]::NewGuid())", 'wowget.json')
            $r = & $run @('list', '--json', '-t', 'x', '--manifest', $missing)
            $r.Exit | Should -Be 1
            $doc = $r.Out | ConvertFrom-Json
            $doc.error.code | Should -Be 'not_found'
            $doc.error.message | Should -Match ([regex]::Escape($missing))
        }
    }
}
