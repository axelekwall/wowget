BeforeDiscovery {
    Import-Module ([System.IO.Path]::Combine($PSScriptRoot, '..', 'Wowget', 'Wowget.psd1'))
}

InModuleScope Wowget {
    BeforeAll { . ([System.IO.Path]::Combine($PSScriptRoot, 'TestHelpers.ps1')) }

    Describe 'default locations' {
        It 'uses ~/.config and ~/Library on macOS' {
            $envTable = @{ HOME = '/Users/me' }
            Get-WowgetManifestPath -Env $envTable -Platform 'MacOS' | Should -Be '/Users/me/.config/wowget/wowget.json'
            Get-WowgetStateDir $envTable 'MacOS' | Should -Be '/Users/me/Library/Application Support/wowget'
            Get-WowgetCacheDir $envTable 'MacOS' | Should -Be '/Users/me/Library/Caches/wowget'
        }

        It 'uses APPDATA and LOCALAPPDATA on Windows, matched case-insensitively' {
            $envTable = @{ appdata = 'C:\Users\me\AppData\Roaming'; LocalAppData = 'C:\Users\me\AppData\Local' }
            Get-WowgetManifestPath -Env $envTable -Platform 'Windows' | Should -Be 'C:\Users\me\AppData\Roaming\wowget\wowget.json'
            Get-WowgetStateDir $envTable 'Windows' | Should -Be 'C:\Users\me\AppData\Local\wowget\state'
            Get-WowgetCacheDir $envTable 'Windows' | Should -Be 'C:\Users\me\AppData\Local\wowget\cache'
        }

        It 'falls back to the home directory on Windows without APPDATA' {
            Get-WowgetManifestPath -Env @{ USERPROFILE = 'C:\Users\me' } -Platform 'Windows' | Should -Be 'C:\Users\me\AppData\Roaming\wowget\wowget.json'
        }

        It 'follows XDG on Linux and ignores relative XDG values' {
            $envTable = @{ HOME = '/home/me'; XDG_CONFIG_HOME = '/xdg/config'; XDG_STATE_HOME = 'relative'; XDG_CACHE_HOME = '/xdg/cache' }
            Get-WowgetManifestPath -Env $envTable -Platform 'Linux' | Should -Be '/xdg/config/wowget/wowget.json'
            Get-WowgetStateDir $envTable 'Linux' | Should -Be '/home/me/.local/state/wowget'
            Get-WowgetCacheDir $envTable 'Linux' | Should -Be '/xdg/cache/wowget'
        }

        It 'lets WOWGET_* variables and --manifest win on every platform' {
            $envTable = @{ HOME = '/home/me'; WOWGET_MANIFEST = '/m/wowget.json'; WOWGET_STATE_DIR = '/s'; WOWGET_CACHE_DIR = '~/c' }
            foreach ($platform in 'Linux', 'MacOS') {
                Get-WowgetManifestPath -Env $envTable -Platform $platform | Should -Be '/m/wowget.json'
                Get-WowgetManifestPath -Override '/other.json' -Env $envTable -Platform $platform | Should -Be '/other.json'
                Get-WowgetStateDir $envTable $platform | Should -Be '/s'
                Get-WowgetCacheDir $envTable $platform | Should -Be '/home/me/c'
            }
            Get-WgErrorCode { Get-WowgetManifestPath -Override '' -Env $envTable -Platform 'Linux' } | Should -Be 'usage'
        }

        It 'reads WOWGET_API_URL, with off turning the service off' {
            Get-WowgetApiUrl @{} | Should -Be 'https://api.wowget.dev'
            Get-WowgetApiUrl @{ WOWGET_API_URL = 'http://localhost:8787/' } | Should -Be 'http://localhost:8787'
            Get-WowgetApiUrl @{ WOWGET_API_URL = 'off' } | Should -Be 'off'
        }
    }

    Describe 'game directories' {
        It 'has candidates per platform' {
            @(Get-WowgetGameDirCandidates @{} 'MacOS') | Should -Be @('/Applications/World of Warcraft')
            @(Get-WowgetGameDirCandidates @{ 'PROGRAMFILES(X86)' = 'C:\PF86'; PROGRAMFILES = 'C:\PF' } 'Windows') | Should -Be @('C:\PF86\World of Warcraft', 'C:\PF\World of Warcraft')
            @(Get-WowgetGameDirCandidates @{} 'Linux').Count | Should -Be 0
        }

        It 'replaces the list with WOWGET_GAME_DIR' {
            @(Get-WowgetGameDirCandidates @{ WOWGET_GAME_DIR = '/games/wow' } 'MacOS') | Should -Be @('/games/wow')
        }

        Context 'detection' {
            BeforeEach { $dirs = New-WgTestDirs }
            AfterEach { Remove-WgTestDirs $dirs }

            It 'finds version folders that hold a game, in table order, and ignores the rest' {
                foreach ($f in '_retail_', '_classic_era_', '_ptr_', '_classic_') { [void](New-WgDir $dirs @('game', $f)) }
                [System.IO.File]::WriteAllText([System.IO.Path]::Combine($dirs.Game, '_retail_', 'Wow.exe'), '')
                [System.IO.File]::WriteAllText([System.IO.Path]::Combine($dirs.Game, '_classic_era_', '.flavor.info'), '')
                [System.IO.File]::WriteAllText([System.IO.Path]::Combine($dirs.Game, '_ptr_', 'Wow.exe'), '')
                $found = @(Find-WowgetInstalls $dirs.Game)
                $found.Name | Should -Be @('era', 'retail')
                $found.Flavor | Should -Be @('classic', 'mainline')
                $found[0].AddonsDir | Should -Be ([System.IO.Path]::Combine($dirs.Game, '_classic_era_', 'Interface', 'AddOns'))
            }

            It 'finds nothing in an empty version folder or a missing game directory' {
                [void](New-WgDir $dirs @('game', '_retail_'))
                @(Find-WowgetInstalls $dirs.Game).Count | Should -Be 0
                @(Find-WowgetInstalls ([System.IO.Path]::Combine($dirs.Root, 'nope'))).Count | Should -Be 0
            }
        }
    }
}
