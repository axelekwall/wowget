BeforeDiscovery {
    Import-Module ([System.IO.Path]::Combine($PSScriptRoot, '..', 'Wowget', 'Wowget.psd1'))
}

InModuleScope Wowget {
    BeforeAll { . ([System.IO.Path]::Combine($PSScriptRoot, 'TestHelpers.ps1')) }

    Describe 'zip extraction' {
        BeforeEach {
            $dirs = New-WgTestDirs
            $dest = New-WgDir $dirs @('out')
            $zip = [System.IO.Path]::Combine($dirs.Root, 'a.zip')
        }
        AfterEach { Remove-WgTestDirs $dirs }

        It 'finds two addon folders in a flat zip' {
            [void](New-WgZip $zip ([ordered]@{ 'A/A.toc' = '## Interface: 11507'; 'B/B.toc' = '## Interface: 11507'; 'B/x.lua' = 'x'; 'readme.txt' = 'hi' }))
            $folders = @(Expand-WowgetAddons $zip $dest)
            $folders.Name | Should -Be @('A', 'B')
            [System.IO.File]::ReadAllText([System.IO.Path]::Combine($dest, 'B', 'x.lua')) | Should -Be 'x'
        }

        It 'descends into a single wrapping directory' {
            [void](New-WgZip $zip ([ordered]@{ 'wrap/A/A.toc' = '## Interface: 11507'; 'wrap/B/B_Vanilla.toc' = '' }))
            (@(Expand-WowgetAddons $zip $dest)).Name | Should -Be @('A', 'B')
        }

        It 'recognises folders whose name ends in a flavor word' {
            [void](New-WgZip $zip ([ordered]@{ 'BigWigs_Classic/BigWigs_Classic.toc' = '' }))
            (@(Expand-WowgetAddons $zip $dest)).Name | Should -Be @('BigWigs_Classic')
        }

        It 'fails for a zip without a matching TOC' {
            [void](New-WgZip $zip ([ordered]@{ 'A/Other.toc' = '' }))
            Get-WgErrorCode { Expand-WowgetAddons $zip $dest } | Should -Be 'zip'
        }

        It 'rejects path traversal before anything is written' {
            [void](New-WgZip $zip ([ordered]@{ 'A/A.toc' = ''; '../evil.txt' = 'x' }))
            Get-WgErrorCode { Expand-WowgetZip $zip $dest } | Should -Be 'zip'
            @([System.IO.Directory]::GetFileSystemEntries($dest)).Count | Should -Be 0
            [System.IO.File]::Exists([System.IO.Path]::Combine($dirs.Root, 'evil.txt')) | Should -BeFalse
        }

        It 'rejects a drive-letter segment inside an entry name' {
            [void](New-WgZip $zip ([ordered]@{ 'A/A.toc' = ''; 'A/D:/evil.txt' = 'x' }))
            Get-WgErrorCode { Expand-WowgetZip $zip $dest } | Should -Be 'zip'
            @([System.IO.Directory]::GetFileSystemEntries($dest)).Count | Should -Be 0
        }

        It 'reports garbage bytes as a zip error' {
            [System.IO.File]::WriteAllText($zip, 'not a zip')
            Test-WowgetZip $zip | Should -BeFalse
            Get-WgErrorCode { Expand-WowgetZip $zip $dest } | Should -Be 'zip'
        }
    }
}
