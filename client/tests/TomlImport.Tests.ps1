BeforeDiscovery {
    Import-Module ([System.IO.Path]::Combine($PSScriptRoot, '..', 'Wowget', 'Wowget.psd1'))
}

InModuleScope Wowget {
    BeforeAll {
        . ([System.IO.Path]::Combine($PSScriptRoot, 'TestHelpers.ps1'))

        # The toml-test JSON encoding of a parsed value: tables as objects, arrays as arrays, and
        # every other value as { type, value }.
        function ConvertTo-WgTagged {
            param($Value)
            if ($Value -is [System.Collections.IDictionary]) {
                $out = New-WowgetTomlTable
                foreach ($k in $Value.Keys) { $out[$k] = ConvertTo-WgTagged $Value[$k] }
                return $out
            }
            if ($Value -is [System.Collections.IList]) { return , @(foreach ($v in $Value) { , (ConvertTo-WgTagged $v) }) }
            if ($Value -is [string]) { return @{ type = 'string'; value = $Value } }
            if ($Value -is [bool]) { return @{ type = 'bool'; value = $Value.ToString().ToLowerInvariant() } }
            if ($Value -is [long]) { return @{ type = 'integer'; value = $Value } }
            if ($Value -is [double]) { return @{ type = 'float'; value = $Value } }
            throw "unexpected value of type $($Value.GetType())"
        }

        # JSON parsed into case-sensitive tables, since TOML keys are case-sensitive.
        function ConvertFrom-WgJsonElement {
            param([System.Text.Json.JsonElement]$Element)
            switch ($Element.ValueKind) {
                'Object' {
                    $out = New-WowgetTomlTable
                    foreach ($p in $Element.EnumerateObject()) { $out[$p.Name] = ConvertFrom-WgJsonElement $p.Value }
                    return , $out
                }
                'Array' { return , @(foreach ($v in $Element.EnumerateArray()) { , (ConvertFrom-WgJsonElement $v) }) }
                default { return $Element.GetString() }
            }
        }

        # Differences between a parsed value and the expected toml-test JSON, as path: message lines.
        function Compare-WgTagged {
            param($Actual, $Expected, [string]$Path = '$')
            $isTagged = { param($x) $x -is [System.Collections.IDictionary] -and $x.Count -eq 2 -and $x.Contains('type') -and $x.Contains('value') -and $x['type'] -is [string] }
            if ($Expected -is [System.Collections.IDictionary] -and -not (& $isTagged $Expected)) {
                if (-not ($Actual -is [System.Collections.IDictionary]) -or (& $isTagged $Actual)) { return "${Path}: expected a table" }
                $keys = @($Expected.Keys) + @($Actual.Keys) | Sort-Object -Unique -CaseSensitive
                foreach ($k in $keys) {
                    if (-not $Actual.Contains($k)) { "${Path}.${k}: missing"; continue }
                    if (-not $Expected.Contains($k)) { "${Path}.${k}: unexpected"; continue }
                    Compare-WgTagged $Actual[$k] $Expected[$k] "$Path.$k"
                }
                return
            }
            if ($Expected -is [System.Collections.IList]) {
                if (-not ($Actual -is [System.Collections.IList])) { return "${Path}: expected an array" }
                if ($Actual.Count -ne $Expected.Count) { return "${Path}: $($Actual.Count) elements, expected $($Expected.Count)" }
                for ($i = 0; $i -lt $Expected.Count; $i++) { Compare-WgTagged $Actual[$i] $Expected[$i] "$Path[$i]" }
                return
            }
            if (-not (& $isTagged $Actual) -or $Actual['type'] -ne $Expected['type']) { return "${Path}: expected a $($Expected['type'])" }
            $inv = [System.Globalization.CultureInfo]::InvariantCulture
            switch ($Expected['type']) {
                'integer' { if ($Actual['value'] -ne [long]::Parse($Expected['value'], $inv)) { "${Path}: $($Actual['value']) <> $($Expected['value'])" } }
                'float' {
                    $e = switch ($Expected['value']) { { $_ -in 'inf', '+inf' } { [double]::PositiveInfinity } '-inf' { [double]::NegativeInfinity } { $_ -in 'nan', '+nan', '-nan' } { [double]::NaN } default { [double]::Parse($_, $inv) } }
                    $a = [double]$Actual['value']
                    if (-not (([double]::IsNaN($e) -and [double]::IsNaN($a)) -or $a -eq $e)) { "${Path}: $a <> $e" }
                }
                default { if ($Actual['value'] -cne $Expected['value']) { "${Path}: '$($Actual['value'])' <> '$($Expected['value'])'" } }
            }
        }
    }

    Describe 'TOML reader' {
        # The valid TOML 1.0.0 cases of toml-lang/toml-test (commit 96fd088), without those holding
        # dates or times. MIT licence in toml-test/LICENSE.
        $root = [System.IO.Path]::Combine($PSScriptRoot, 'toml-test')
        $cases = foreach ($file in (Get-ChildItem -LiteralPath $root -Recurse -Filter '*.toml' | Sort-Object FullName)) {
            @{ Name = [System.IO.Path]::GetRelativePath($root, $file.FullName).Replace('\', '/'); Toml = $file.FullName; Json = [System.IO.Path]::ChangeExtension($file.FullName, '.json') }
        }

        It 'reads toml-test <Name>' -ForEach $cases {
            $parsed = ConvertFrom-WowgetToml (Read-WowgetText $Toml)
            $expected = ConvertFrom-WgJsonElement ([System.Text.Json.JsonDocument]::Parse((Read-WowgetText $Json)).RootElement)
            @(Compare-WgTagged (ConvertTo-WgTagged $parsed) $expected) | Should -BeNullOrEmpty
        }

        It 'reads the registry file of this repository' {
            $path = [System.IO.Path]::Combine($PSScriptRoot, '..', '..', 'registry', 'addons.toml')
            $text = Read-WowgetText $path
            $parsed = ConvertFrom-WowgetToml $text
            $parsed['addon'].Count | Should -Be ([regex]::Matches($text, '(?m)^\[\[addon\]\]').Count)
            @($parsed['addon'] | Where-Object { -not ($_['source'] -is [string]) }) | Should -BeNullOrEmpty
        }

        It 'rejects <Name> naming the line' -ForEach @(
            @{ Name = 'a date'; Text = "a = 1`nb = 1979-05-27"; Line = 2 }
            @{ Name = 'a time'; Text = "t = 07:32:00"; Line = 1 }
            @{ Name = 'a duplicate key'; Text = "a = 1`na = 2"; Line = 2 }
            @{ Name = 'a duplicate table'; Text = "[a]`n[a]"; Line = 2 }
            @{ Name = 'dotted keys into a header table'; Text = "[a.b.c]`nz = 9`n[a]`nb.c.t = 1"; Line = 4 }
            @{ Name = 'extending an inline table'; Text = "a = {b = 1}`n[a]"; Line = 2 }
            @{ Name = 'an unterminated string'; Text = "a = `"abc"; Line = 1 }
            @{ Name = 'a trailing comma in an inline table'; Text = "a = {b = 1,}"; Line = 1 }
            @{ Name = 'a leading zero'; Text = "a = 012"; Line = 1 }
        ) {
            $err = Get-WgErrorText { ConvertFrom-WowgetToml $Text 'm.toml' }
            $err | Should -BeLike "m.toml: line ${Line}: *"
            Get-WgErrorCode { ConvertFrom-WowgetToml $Text } | Should -Be 'manifest'
        }
    }

    Describe 'TOML manifest conversion' {
        BeforeEach { $dirs = New-WgTestDirs }
        AfterEach { Remove-WgTestDirs $dirs }

        It 'maps targets and [[addon]] tables to the JSON manifest' {
            $toml = @'
# my addons
[targets.era]
folder = "_classic_era_"   # shared
flavor = "classic"

[targets.laptop]
path = 'D:\Games\WoW\_retail_\Interface\AddOns'
flavor = "mainline"

[[addon]]
name = "Questie"
source = "github:Questie/Questie"
targets = [
  "era",
]

[[addon]]
name = "Bar"
source = "github:owner/bar"
prerelease = true
pin = "v1.0"
'@
            $m = ConvertFrom-WowgetTomlManifest $toml 'w.toml'
            $m.Targets.Name | Should -Be @('era', 'laptop')
            $m.Targets[1].Path | Should -Be 'D:\Games\WoW\_retail_\Interface\AddOns'
            $m.Addons[0].Targets | Should -Be @('era')
            $m.Addons[1].Prerelease | Should -BeTrue
            $m.Addons[1].Pin | Should -Be 'v1.0'
        }

        It 'reports manifest problems with the TOML file name' {
            Get-WgErrorText { ConvertFrom-WowgetTomlManifest "[[addon]]`nname = 3`nsource = `"github:a/b`"" 'w.toml' } | Should -BeLike 'w.toml: addon #1.name must be a non-empty string'
            Get-WgErrorText { ConvertFrom-WowgetTomlManifest "version = 1" 'w.toml' } | Should -BeLike '*unknown key "version"*'
            Get-WgErrorText { ConvertFrom-WowgetTomlManifest "[install]`npath = `"x`"" 'w.toml' } | Should -BeLike '*[install]*'
        }

        It 'writes wowget.json next to the TOML file and keeps the TOML file' {
            $dir = New-WgDir $dirs @('config')
            $toml = [System.IO.Path]::Combine($dir, 'wowget.toml')
            [System.IO.File]::WriteAllText($toml, "[targets.era]`nfolder = `"_classic_era_`"`nflavor = `"classic`"`n")
            $r = Convert-WowgetTomlManifestFile $toml
            $r.Converted | Should -BeTrue
            $r.ManifestPath | Should -Be ([System.IO.Path]::Combine($dir, 'wowget.json'))
            (Read-WowgetManifest $r.ManifestPath).Targets[0].Folder | Should -Be '_classic_era_'
            [System.IO.File]::Exists($toml) | Should -BeTrue
            # A second run uses the converted file.
            (Convert-WowgetTomlManifestFile $toml).Converted | Should -BeFalse
        }

        It 'converts inside the directory a TOML symlink points to and links the JSON file' -Skip:($IsWindows) {
            $repo = New-WgDir $dirs @('dotfiles')
            $config = New-WgDir $dirs @('config')
            $real = [System.IO.Path]::Combine($repo, 'wowget.toml')
            [System.IO.File]::WriteAllText($real, "[targets.era]`nfolder = `"_classic_era_`"`nflavor = `"classic`"`n")
            $link = [System.IO.Path]::Combine($config, 'wowget.toml')
            [void][System.IO.File]::CreateSymbolicLink($link, $real)
            $r = Convert-WowgetTomlManifestFile $link -Platform 'Linux'
            [System.IO.File]::Exists([System.IO.Path]::Combine($repo, 'wowget.json')) | Should -BeTrue
            $r.ManifestPath | Should -Be ([System.IO.Path]::Combine($config, 'wowget.json'))
            ([System.IO.FileInfo]::new($r.ManifestPath)).LinkTarget | Should -Be ([System.IO.Path]::Combine($repo, 'wowget.json'))
        }
    }
}
