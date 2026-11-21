BeforeDiscovery {
    Import-Module ([System.IO.Path]::Combine($PSScriptRoot, '..', 'Wowget', 'Wowget.psd1'))
}

InModuleScope Wowget {
    BeforeAll { . ([System.IO.Path]::Combine($PSScriptRoot, 'TestHelpers.ps1')) }

    Describe 'TOC parsing' {
        It 'reads an interface list, title, version and typed interface fields' {
            $toc = ConvertFrom-WowgetToc ([char]0xFEFF + "## Interface: 11507, 16000`r`n## Title: Questie`n## Version: 1.2`n## Interface-Classic: 11507`n")
            $toc.Interface | Should -Be @(11507, 16000)
            $toc.Title | Should -Be 'Questie'
            $toc.Version | Should -Be '1.2'
            $toc.Fields['Interface-Classic'] | Should -Be '11507'
        }

        It 'gives an empty interface list without an interface line' {
            @((ConvertFrom-WowgetToc "## Title: X`n").Interface).Count | Should -Be 0
        }

        It 'recognises flavor suffixes with either separator' {
            (Split-WowgetTocName 'Questie-Classic.toc').Suffix | Should -Be 'Classic'
            (Split-WowgetTocName 'Questie_Vanilla.toc').Suffix | Should -Be 'Vanilla'
            (Split-WowgetTocName 'Questie_Vanilla.toc').Base | Should -Be 'Questie'
            (Split-WowgetTocName 'Questie-Unknown.toc').Suffix | Should -Be ''
        }

        It 'treats a TOC whose whole stem is the folder name as unsuffixed' {
            Get-WowgetTocSuffix 'BigWigs_Classic.toc' 'BigWigs_Classic' | Should -Be ''
            Get-WowgetTocSuffix 'BigWigs_Classic.toc' 'BigWigs' | Should -Be 'Classic'
            Get-WowgetTocSuffix 'Other.toc' 'BigWigs' | Should -BeNullOrEmpty
        }
    }

    Describe 'folder flavor check' {
        BeforeEach {
            $dirs = New-WgTestDirs
            $write = {
                param([string]$folder, [hashtable]$files)
                $dir = New-WgDir $dirs @($folder)
                foreach ($name in $files.Keys) { [System.IO.File]::WriteAllText([System.IO.Path]::Combine($dir, $name), $files[$name]) }
                $dir
            }
        }
        AfterEach { Remove-WgTestDirs $dirs }

        It 'says yes for a TOC with the flavor suffix' {
            $dir = & $write 'Foo' @{ 'Foo_Vanilla.toc' = '## Title: Foo' }
            Test-WowgetFolderFlavor $dir 'classic' | Should -Be 'yes'
        }

        It 'decides an unsuffixed TOC by its interface' {
            $dir = & $write 'Foo' @{ 'Foo.toc' = '## Interface: 11507' }
            Test-WowgetFolderFlavor $dir 'classic' | Should -Be 'yes'
            Test-WowgetFolderFlavor $dir 'forever' | Should -Be 'no'
        }

        It 'says unknown for an unsuffixed TOC without an interface line' {
            $dir = & $write 'Foo' @{ 'Foo.toc' = '## Title: Foo' }
            Test-WowgetFolderFlavor $dir 'classic' | Should -Be 'unknown'
        }

        It 'says no when only TOCs of other flavors exist' {
            $dir = & $write 'Foo' @{ 'Foo_Mainline.toc' = '## Interface: 110000'; 'Foo_TBC.toc' = '## Interface: 20504' }
            Test-WowgetFolderFlavor $dir 'classic' | Should -Be 'no'
        }

        It 'counts a family suffix only by its interface list' {
            $dir = & $write 'Foo' @{ 'Foo_Classic.toc' = '## Interface: 50500' }
            Test-WowgetFolderFlavor $dir 'mists' | Should -Be 'yes'
            Test-WowgetFolderFlavor $dir 'classic' | Should -Be 'no'
        }

        It 'counts typed interface lines like a TOC with that suffix' {
            $dir = & $write 'Foo' @{ 'Foo.toc' = "## Interface: 110000`n## Interface-Vanilla: 11507" }
            Test-WowgetFolderFlavor $dir 'classic' | Should -Be 'yes'
        }

        It 'uses the whole-name TOC of a folder named with a suffix word' {
            $dir = & $write 'BigWigs_Classic' @{ 'BigWigs_Classic.toc' = '## Interface: 11507' }
            Test-WowgetFolderFlavor $dir 'classic' | Should -Be 'yes'
        }
    }
}
