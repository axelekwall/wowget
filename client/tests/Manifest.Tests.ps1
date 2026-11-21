BeforeDiscovery {
    Import-Module ([System.IO.Path]::Combine($PSScriptRoot, '..', 'Wowget', 'Wowget.psd1'))
}

InModuleScope Wowget {
    BeforeAll {
        . ([System.IO.Path]::Combine($PSScriptRoot, 'TestHelpers.ps1'))
        $parse = { param([string]$text) ConvertFrom-WowgetManifestText $text 'wowget.json' }
        $valid = @'
{
  "version": 1,
  "targets": {
    "forever": { "folder": "_forever_", "flavor": "forever" },
    "laptop": { "path": "D:\\Games\\AddOns", "flavor": "mainline" }
  },
  "addons": [
    { "name": "Questie", "source": "github:Questie/Questie" },
    { "name": "WeakAuras", "source": "github:WeakAuras/WeakAuras2", "targets": ["laptop"] },
    { "name": "Foo", "source": "url:https://example.com/Foo.zip", "pin": "3f2a" },
    { "name": "Bar", "source": "github:owner/bar", "prerelease": true }
  ]
}

'@
    }

    Describe 'manifest parsing' {
        It 'parses targets and addons with defaults' {
            $m = & $parse $valid
            $m.Targets.Name | Should -Be @('forever', 'laptop')
            $m.Targets[0].Folder | Should -Be '_forever_'
            $m.Targets[1].Path | Should -Be 'D:\Games\AddOns'
            $m.Addons.Name | Should -Be @('Questie', 'WeakAuras', 'Foo', 'Bar')
            $m.Addons[0].Prerelease | Should -BeFalse
            $m.Addons[0].Targets | Should -BeNullOrEmpty
            $m.Addons[1].Targets | Should -Be @('laptop')
            $m.Addons[2].Pin | Should -Be '3f2a'
            $m.Addons[3].Prerelease | Should -BeTrue
        }

        It 'renders the format of the spec and reads back to the same text' {
            $text = ConvertTo-WowgetManifestText (& $parse $valid)
            $text | Should -BeExactly ($valid.Replace("`r`n", "`n").TrimEnd() + "`n")
        }

        It 'accepts a manifest without addons' {
            (& $parse '{ "version": 1, "targets": {} }').Addons.Count | Should -Be 0
        }

        It 'rejects a newer format version and asks for an update' {
            Get-WgErrorText { & $parse '{ "version": 2, "targets": {}, "addons": [] }' } | Should -Match 'self-update'
        }

        It 'requires addon targets to name existing targets and not be empty' {
            Get-WgErrorText { & $parse '{ "version": 1, "targets": { "a": { "path": "/x", "flavor": "forever" } }, "addons": [ { "name": "X", "source": "github:a/b", "targets": ["b"] } ] }' } | Should -Match 'unknown target "b"'
            Get-WgErrorText { & $parse '{ "version": 1, "targets": { "a": { "path": "/x", "flavor": "forever" } }, "addons": [ { "name": "X", "source": "github:a/b", "targets": [] } ] }' } | Should -Match 'must not be empty'
        }

        It 'requires exactly one of path and folder' {
            Get-WgErrorText { & $parse '{ "version": 1, "targets": { "a": { "flavor": "forever" } } }' } | Should -Match 'exactly one of path and folder'
            Get-WgErrorText { & $parse '{ "version": 1, "targets": { "a": { "path": "/x", "folder": "_retail_", "flavor": "forever" } } }' } | Should -Match 'exactly one of path and folder'
            Get-WgErrorText { & $parse '{ "version": 1, "targets": { "a": { "folder": "../x", "flavor": "forever" } } }' } | Should -Match 'single folder name'
        }

        It 'names unknown keys, also those that differ only in case' {
            Get-WgErrorText { & $parse '{ "version": 1, "targets": {}, "extra": 1 }' } | Should -Match 'unknown key "extra"'
            Get-WgErrorText { & $parse '{ "version": 1, "targets": {}, "addons": [ { "Name": "X", "source": "github:a/b" } ] }' } | Should -Match 'unknown key "Name"'
        }

        It 'rejects duplicate names case-insensitively, bad flavors, bad sources and bad names' {
            Get-WgErrorText { & $parse '{ "version": 1, "addons": [ { "name": "X", "source": "github:a/b" }, { "name": "x", "source": "github:a/c" } ] }' } | Should -Match 'duplicate addon name'
            Get-WgErrorText { & $parse '{ "version": 1, "targets": { "a": { "path": "/x", "flavor": "tbc" } } }' } | Should -Match 'is not one of'
            Get-WgErrorText { & $parse '{ "version": 1, "addons": [ { "name": "X", "source": "curse:1" } ] }' } | Should -Match 'Unknown source'
            Get-WgErrorText { & $parse '{ "version": 1, "addons": [ { "name": "..", "source": "github:a/b" } ] }' } | Should -Match 'must not be'
            Get-WgErrorText { & $parse '{ "version": 1, "addons": [ { "name": "X", "source": "github:a/b", "prerelease": "yes" } ] }' } | Should -Match 'true or false'
        }

        It 'reports invalid JSON as a manifest error' {
            Get-WgErrorCode { & $parse '{ "version": 1,' } | Should -Be 'manifest'
            Get-WgErrorCode { & $parse '' } | Should -Be 'manifest'
        }
    }

    Describe 'manifest writes' {
        BeforeEach { $dirs = New-WgTestDirs }
        AfterEach { Remove-WgTestDirs $dirs }

        It 'creates the file and its directories, and refuses to overwrite' {
            $m = New-WowgetManifestFile $dirs.Manifest @(New-WowgetTarget -Name 'forever' -Path '/x/AddOns' -Flavor 'forever')
            $m.Targets.Name | Should -Be @('forever')
            $bytes = [System.IO.File]::ReadAllBytes($dirs.Manifest)
            $bytes[0] | Should -Be ([byte][char]'{')
            [System.Text.Encoding]::UTF8.GetString($bytes) | Should -Not -Match "`r"
            Get-WgErrorCode { New-WowgetManifestFile $dirs.Manifest @() } | Should -Be 'manifest_exists'
        }

        It 'refuses to write when the file changed since it was read' {
            [void](New-WowgetManifestFile $dirs.Manifest @())
            $read = Read-WowgetManifestText $dirs.Manifest
            [System.IO.File]::WriteAllText($dirs.Manifest, $read.Text.Replace('"addons"', ' "addons"'))
            $next = New-WowgetManifestObject -Targets @(New-WowgetTarget -Name 'a' -Path '/a' -Flavor 'forever')
            Get-WgErrorText { Save-WowgetManifest $dirs.Manifest $read.Text $next } | Should -Match 'changed while wowget was running'
        }

        It 'checks a planned manifest before writing anything' {
            [void](New-WowgetManifestFile $dirs.Manifest @())
            $before = [System.IO.File]::ReadAllText($dirs.Manifest)
            $read = Read-WowgetManifestText $dirs.Manifest
            $bad = New-WowgetManifestObject -Addons @(New-WowgetAddonEntry -Name 'X' -Source 'github:a/b' -Targets @('missing'))
            Get-WgErrorCode { Save-WowgetManifest $dirs.Manifest $read.Text $bad } | Should -Be 'manifest'
            [System.IO.File]::ReadAllText($dirs.Manifest) | Should -BeExactly $before
        }

        It 'removes a target and drops it from addon lists, removing addons left without targets' {
            $m = & $parse '{ "version": 1, "targets": { "a": { "path": "/a", "flavor": "forever" }, "b": { "path": "/b", "flavor": "classic" } }, "addons": [ { "name": "X", "source": "github:a/x", "targets": ["a", "b"] }, { "name": "Y", "source": "github:a/y", "targets": ["b"] }, { "name": "Z", "source": "github:a/z" } ] }'
            $plan = Remove-WowgetManifestTarget $m 'b'
            $plan.RemovedAddons | Should -Be @('Y')
            $plan.Manifest.Targets.Name | Should -Be @('a')
            $plan.Manifest.Addons.Name | Should -Be @('X', 'Z')
            $plan.Manifest.Addons[0].Targets | Should -Be @('a')
        }

        It 'writes through a symlink and keeps the link (POSIX only: symlinks need privileges on Windows)' -Skip:($IsWindows) {
            $real = [System.IO.Path]::Combine((New-WgDir $dirs @('dotfiles')), 'wowget.json')
            [void](New-WowgetManifestFile $real @())
            [System.IO.File]::SetUnixFileMode($real, [System.IO.UnixFileMode]'UserRead, UserWrite')
            [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($dirs.Manifest))
            [void][System.IO.File]::CreateSymbolicLink($dirs.Manifest, $real)
            $read = Read-WowgetManifestText $dirs.Manifest
            $next = New-WowgetManifestObject -Targets @(New-WowgetTarget -Name 'a' -Path '/a' -Flavor 'forever')
            [void](Save-WowgetManifest $dirs.Manifest $read.Text $next)
            ([System.IO.FileInfo]::new($dirs.Manifest)).LinkTarget | Should -Be $real
            (Read-WowgetManifest $real).Targets.Name | Should -Be @('a')
            [System.IO.File]::GetUnixFileMode($real) | Should -Be ([System.IO.UnixFileMode]'UserRead, UserWrite')
        }
    }

    Describe 'sources' {
        It 'parses the three source kinds and names the supported forms otherwise' {
            (ConvertFrom-WowgetSource 'github:Questie/Questie').Repo | Should -Be 'Questie'
            (ConvertFrom-WowgetSource 'wowi:7032').Id | Should -Be '7032'
            (ConvertFrom-WowgetSource 'url:https://example.com/a%20b.zip').Url | Should -Be 'https://example.com/a%20b.zip'
            Get-WgErrorText { ConvertFrom-WowgetSource 'github:onlyowner' } | Should -Match 'github:owner/repo'
            Get-WgErrorText { ConvertFrom-WowgetSource 'url:ftp://x/y.zip' } | Should -Match 'only http and https'
            Get-WgErrorText { ConvertFrom-WowgetSource 'wowi:abc' } | Should -Match 'numeric id'
        }

        It 'derives default names' {
            Get-WowgetDefaultAddonName (ConvertFrom-WowgetSource 'github:a/MyAddon') | Should -Be 'MyAddon'
            Get-WowgetDefaultAddonName (ConvertFrom-WowgetSource 'url:https://example.com/dl/Some%20Addon.zip') | Should -Be 'Some Addon'
            Get-WowgetDefaultAddonName (ConvertFrom-WowgetSource 'url:https://example.com/') | Should -Be 'example.com'
            Get-WowgetDefaultAddonName (ConvertFrom-WowgetSource 'wowi:12') | Should -Be 'wowi-12'
        }
    }

    Describe 'lock' {
        BeforeEach { $dirs = New-WgTestDirs }
        AfterEach { Remove-WgTestDirs $dirs }

        It 'lets one holder in and fails a second with a locked error naming the lock file' {
            $first = Enter-WowgetLock -StateDir $dirs.State -TimeoutMs 100
            try {
                Get-WgErrorCode { Enter-WowgetLock -StateDir $dirs.State -TimeoutMs 300 } | Should -Be 'locked'
                Get-WgErrorText { Enter-WowgetLock -StateDir $dirs.State -TimeoutMs 100 } | Should -Match 'wowget\.lock'
            } finally {
                $first.Dispose()
            }
            $again = Enter-WowgetLock -StateDir $dirs.State -TimeoutMs 100
            $again.Dispose()
        }
    }
}
