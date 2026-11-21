# Argument parsing, output, --json and exit codes. The only part of the module that writes output.

$script:StringOptions = @('manifest', 'path', 'flavor', 'name', 'pin', 'target', 'game-dir', 'folder', 'limit')
$script:BooleanOptions = @('json', 'force', 'verbose', 'help', 'version', 'prerelease', 'portable', 'adopt', 'clean', 'check', 'all-flavors', 'github', 'refresh', 'print')
$script:ShortOptions = @{ t = 'target'; h = 'help' }
$script:GlobalOptions = @('manifest', 'json', 'force', 'verbose', 'help', 'version')

# Options each command accepts beyond the global ones, and its positional argument count.
$script:Commands = [ordered]@{
    'init'            = @{ Flags = @('path', 'flavor', 'name', 'game-dir', 'portable'); Min = 0; Max = 0 }
    'target list'     = @{ Flags = @(); Min = 0; Max = 0 }
    'target add'      = @{ Flags = @('path', 'folder', 'flavor'); Min = 1; Max = 1 }
    'target remove'   = @{ Flags = @(); Min = 1; Max = 1 }
    'target portable' = @{ Flags = @(); Min = 0; Max = [int]::MaxValue }
    'add'             = @{ Flags = @('name', 'prerelease', 'pin', 'target'); Min = 1; Max = 1 }
    'remove'          = @{ Flags = @('target'); Min = 1; Max = 1 }
    'list'            = @{ Flags = @('target'); Min = 0; Max = 0 }
    'outdated'        = @{ Flags = @('target'); Min = 0; Max = 0 }
    'update'          = @{ Flags = @('target'); Min = 0; Max = [int]::MaxValue }
    'install'         = @{ Flags = @('target'); Min = 0; Max = 0 }
    'pin'             = @{ Flags = @(); Min = 1; Max = 2 }
    'unpin'           = @{ Flags = @(); Min = 1; Max = 1 }
    'rollback'        = @{ Flags = @('target'); Min = 1; Max = 1 }
    'search'          = @{ Flags = @('target', 'flavor', 'all-flavors', 'github', 'limit', 'refresh'); Min = 1; Max = [int]::MaxValue }
    'reconcile'       = @{ Flags = @('target', 'adopt'); Min = 0; Max = 0 }
    'doctor'          = @{ Flags = @('target', 'clean'); Min = 0; Max = 0 }
    'suggest'         = @{ Flags = @('print'); Min = 0; Max = [int]::MaxValue }
    'migrate'         = @{ Flags = @(); Min = 0; Max = 0 }
    'self-update'     = @{ Flags = @('check'); Min = 0; Max = 0 }
}

# Commands that do not run the automatic first-start migration.
$script:NoMigrationCommands = @('migrate', 'self-update')

# Opens a URL in the default browser; returns whether that worked. Tests replace it.
$script:WowgetOpenUrl = {
    param([string]$Url)
    try {
        if ($IsWindows) { Start-Process -FilePath $Url; return $true }
        $opener = if ($IsMacOS) { 'open' } else { 'xdg-open' }
        & $opener $Url *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

# Commands that only read; every other command takes the write lock.
$script:ReadOnlyCommands = @('target list', 'list')

class WowgetUsageError : System.Exception {
    WowgetUsageError([string]$message) : base($message) {}
}

function Get-WowgetHelp {
    param([hashtable]$Env, [string]$Platform)
    $noOverride = @{} + $Env
    $noOverride.Remove('WOWGET_MANIFEST')
    $defaultManifest = Get-WowgetManifestPath -Env $noOverride -Platform $Platform
    return @"
Usage: wowget <command> [options]

Commands:
  init [--path P --flavor F --name N] [--game-dir D] [--portable]
                                        create the manifest: one target for the AddOns directory P,
                                        or one per World of Warcraft version found in the game dir;
                                        --portable names version folders instead of paths, so the
                                        manifest works on other machines
  target list                           show the targets and whether their AddOns directories exist
  target add <name> (--path P | --folder D) --flavor F
                                        add a target: the AddOns directory P, or the version folder D
                                        (such as _retail_) in the game directory of each machine
  target remove <name>                  uninstall everything on a target and remove it
  target portable [name...]             rewrite path targets as version folders where that finds
                                        the same AddOns directory here (all path targets by default)
  search <query...> [--flavor F | --all-flavors] [--github] [--limit N]
                                        find addons in the registry and on WoWInterface
                                        (and GitHub with --github); filters on the targets' flavors
  add <source|name> [--name N] [--prerelease] [--pin ID]
                                        install an addon and add it to the manifest; a bare name
                                        is looked up in the addon registry
  remove <name>                         uninstall an addon and drop it from the manifest
  list                                  show manifest addons and what is installed
  outdated                              check every addon for a newer release
  update [name...]                      install newer releases (all addons by default)
  install                               install manifest addons that are not installed
  pin <name> [release]                  freeze an addon at its installed release or a given release
  unpin <name>                          remove the release pin from an addon
  rollback <name>                       reinstall the previous release of an addon from the cache
  reconcile [--adopt]                   find hand-installed addons and optionally adopt them
  doctor [--clean]                      check targets, markers, TOC interfaces and cache health
  suggest [name...] [--print]           open a GitHub issue that proposes the manifest addons
                                        missing from the addon registry
  migrate                               convert a TOML manifest and adopt the addons the previous
                                        wowget installed (runs by itself on the first start)
  self-update [--check]                 install the latest wowget release

search, add, remove, list, outdated, update, install, rollback, reconcile and doctor act on every
target unless filtered with -t/--target, which can be repeated. "add -t" records the targets in the
manifest; "remove -t" removes the addon from those targets only. Targets whose version folder is
not on this machine are skipped.

Sources: github:owner/repo, wowi:<id>, url:https://...
Flavors: $($script:Flavors -join ', ')

Options:
  -t, --target <name> act on this target only (repeatable)
  --adopt             with reconcile: install and add matched addons to the manifest
  --clean             with doctor: remove leftover temp folders and unreferenced cache dirs
  --check             with self-update: only report whether a newer release exists
  --all-flavors       with search: do not filter on flavors
  --github            with search: also search GitHub repositories tagged wow-addon
  --limit <n>         with search: show at most n results (default 20, at most 50)
  --print             with suggest: print the issue URL without opening a browser
  --manifest <path>   manifest file (default `$WOWGET_MANIFEST, else $defaultManifest)
  --json              print the result as JSON
  --force             install over unmanaged folders and unverifiable flavors;
                      with self-update: reinstall the latest release even if it is not newer
  --verbose           show every progress step and stack traces
  -h, --help          show this help
  --version           show the version

"@
}

function ConvertFrom-WowgetArgs {
    param([string[]]$Argv = @())
    $values = @{}
    $positionals = [System.Collections.Generic.List[string]]::new()
    $i = 0
    while ($i -lt $Argv.Count) {
        $arg = [string]$Argv[$i]
        $i++
        if ($arg -eq '--') {
            while ($i -lt $Argv.Count) { $positionals.Add([string]$Argv[$i]); $i++ }
            break
        }
        $name = $null
        $inline = $null
        if ($arg.StartsWith('--') -and $arg.Length -gt 2) {
            $body = $arg.Substring(2)
            $eq = $body.IndexOf('=')
            if ($eq -ge 0) { $name = $body.Substring(0, $eq); $inline = $body.Substring($eq + 1) } else { $name = $body }
        } elseif ($arg.StartsWith('-') -and $arg.Length -eq 2 -and $arg -ne '--') {
            $name = $script:ShortOptions[$arg.Substring(1)]
            if (-not $name) { throw [WowgetUsageError]::new("Unknown option '$arg'.") }
        } else {
            $positionals.Add($arg)
            continue
        }
        if ($script:BooleanOptions -ccontains $name) {
            if ($null -ne $inline) { throw [WowgetUsageError]::new("Option '--$name' does not take a value.") }
            $values[$name] = $true
            continue
        }
        if ($script:StringOptions -cnotcontains $name) { throw [WowgetUsageError]::new("Unknown option '$arg'.") }
        $value = $inline
        if ($null -eq $value) {
            if ($i -ge $Argv.Count) { throw [WowgetUsageError]::new("Option '--$name <value>' argument missing.") }
            $value = [string]$Argv[$i]
            if ($value.StartsWith('-') -and $value -ne '-') {
                throw [WowgetUsageError]::new("Option '--$name <value>' argument is ambiguous; did you forget its value? To give a value that starts with a dash, use '--$name=$value'.")
            }
            $i++
        }
        if ($name -ceq 'target') {
            if (-not $values.ContainsKey('target')) { $values['target'] = [System.Collections.Generic.List[string]]::new() }
            $values['target'].Add($value)
        } else {
            $values[$name] = $value
        }
    }
    return [pscustomobject]@{ Values = $values; Positionals = $positionals.ToArray() }
}

# Writes progress to stderr: one line per download, every step with --verbose.
function New-WowgetProgress {
    param([System.IO.TextWriter]$Stderr, [bool]$Verbose)
    $state = [pscustomobject]@{ Open = $false; Stderr = $Stderr; Verbose = $Verbose }
    $flush = { if ($state.Open) { $state.Stderr.Write("`n"); $state.Open = $false } }.GetNewClosure()
    $onEvent = {
        param($e)
        switch ($e.type) {
            'registry:stale' { & $flush; $state.Stderr.Write("wowget: warning: $($e.message)`n") }
            'target:absent' { & $flush; $state.Stderr.Write("wowget: $($e.message)`n") }
            'download:start' { & $flush; $state.Stderr.Write("$($e.addon): downloading $($e.filename)"); $state.Open = $true }
            'download:done' {
                if ($state.Open) {
                    $bytes = [long]$e.bytes
                    $size = if ($bytes -lt 1024) { "$bytes B" } elseif ($bytes -lt 1048576) { ($bytes / 1024).ToString('0.0', [System.Globalization.CultureInfo]::InvariantCulture) + ' KB' } else { ($bytes / 1048576).ToString('0.0', [System.Globalization.CultureInfo]::InvariantCulture) + ' MB' }
                    $state.Stderr.Write(" ($size)`n")
                    $state.Open = $false
                } elseif ($state.Verbose) {
                    $state.Stderr.Write("$($e.addon): download:done`n")
                }
            }
            default {
                if ($state.Verbose -and $null -ne $e.PSObject.Properties['addon']) {
                    & $flush
                    $detail = if ($null -ne $e.PSObject.Properties['folders']) { ' ' + (@($e.folders) -join ', ') } else { '' }
                    $state.Stderr.Write("$($e.addon): $($e.type)$detail`n")
                }
            }
        }
    }.GetNewClosure()
    return [pscustomobject]@{ OnEvent = $onEvent; Flush = $flush }
}

function Format-WowgetTable {
    param([object[]]$Rows)
    $widths = @{}
    foreach ($r in $Rows) { for ($i = 0; $i -lt $r.Count; $i++) { $len = ([string]$r[$i]).Length; if (-not $widths.ContainsKey($i) -or $widths[$i] -lt $len) { $widths[$i] = $len } } }
    $lines = foreach ($r in $Rows) {
        $cells = for ($i = 0; $i -lt $r.Count; $i++) {
            $cell = [string]$r[$i]
            if ($i -eq $r.Count - 1) { $cell } else { $cell.PadRight($widths[$i]) }
        }
        $cells -join '  '
    }
    return $lines -join "`n"
}

function Get-WowgetVersionLabel {
    param($Value)
    if ($null -eq $Value) { return '-' }
    return [string]$Value
}

function Format-WowgetUpdateResult {
    param($Result)
    if (@($Result.addons).Count -eq 0) { return 'No addons in the manifest.' }
    $rows = @(foreach ($a in $Result.addons) {
        $cells = switch ($a.status) {
            'current' { @($a.name, $a.target, 'current', $a.version) }
            'updated' { @($a.name, $a.target, 'updated', "$($a.from) -> $($a.to)") }
            'installed' { @($a.name, $a.target, 'installed', $a.version) }
            'repaired' { @($a.name, $a.target, 'repaired', "$($a.version) reinstalled") }
            'skipped' { @($a.name, $a.target, 'skipped', "$($a.version) already installed") }
            default { @($a.name, $a.target, 'error', $a.error) }
        }
        , $cells
    })
    return Format-WowgetTable $rows
}

function Format-WowgetRemoved {
    param([object[]]$Rows = @())
    return @(foreach ($r in $Rows) {
            if (-not $r.wasInstalled) { "  $($r.target): was not installed"; continue }
            $folders = if (@($r.removedFolders).Count) { ' ' + (@($r.removedFolders) -join ', ') } else { '' }
            "  $($r.target): removed$folders"
        })
}

function Format-WowgetResult {
    param([string]$Command, $Result)
    switch ($Command) {
        'init' {
            $rows = @(, @('TARGET', 'FLAVOR', 'PATH')) + @(foreach ($t in $Result.targets) {
                    $extra = $(if ($t.createdAddonsDir) { ' (created)' } else { '' }) + $(if ($t.PSObject.Properties['folder']) { " (folder $($t.folder))" } else { '' })
                    , @($t.name, $t.flavor, "$($t.path)$extra")
                })
            return "Created $($Result.manifestPath)`n" + (Format-WowgetTable $rows)
        }
        'target list' {
            if (@($Result.targets).Count -eq 0) { return 'No targets in the manifest. Add one with "wowget target add".' }
            $rows = @(, @('TARGET', 'FLAVOR', 'PATH', 'EXISTS')) + @(foreach ($t in $Result.targets) {
                    $hasFolder = $null -ne $t.PSObject.Properties['folder']
                    $where = if ($null -eq $t.path) { "$($t.folder) (not on this machine)" } else { "$($t.path)$(if ($hasFolder) { " (folder $($t.folder))" })" }
                    , @($t.name, $t.flavor, $where, $(if ($t.exists) { 'yes' } else { 'no' }))
                })
            return Format-WowgetTable $rows
        }
        'target add' {
            $t = $Result.target
            $where = if ($null -ne $t.path) { $t.path } else { "$($t.folder), which is not on this machine" }
            $lines = @("Added target $($t.name) ($($t.flavor)) at $where")
            if ($Result.createdAddonsDir) { $lines += "Created $($t.path)" }
            return $lines -join "`n"
        }
        'target remove' {
            $lines = @("Removed target $($Result.name)")
            foreach ($a in $Result.addons) { $lines += "  uninstalled $($a.name)$(if (@($a.removedFolders).Count) { " ($(@($a.removedFolders) -join ', '))" })" }
            foreach ($n in $Result.removedAddons) { $lines += "  removed $n from the manifest (it had no other target)" }
            return $lines -join "`n"
        }
        'target portable' {
            $lines = @(foreach ($t in $Result.converted) { "Converted $($t.name) to folder $($t.folder) ($($t.path))" })
            foreach ($t in $Result.skipped) { $lines += "Skipped $($t.name): $($t.reason)" }
            if (@($Result.converted).Count -eq 0) { $lines += 'Nothing to convert; the manifest was not changed.' }
            return $lines -join "`n"
        }
        'add' {
            $lines = @(foreach ($a in $Result.addons) { "Added $($Result.name) $($a.version) to $($a.target) ($(@($a.folders) -join ', '))" })
            if ($null -ne $Result.PSObject.Properties['registryName']) { $lines = @("Using $($Result.source) for `"$($Result.registryName)`" from the addon registry") + $lines }
            return $lines -join "`n"
        }
        'remove' {
            $head = if ($Result.removedEntry) { "Removed $($Result.name)" } else { "Removed $($Result.name) from $((@($Result.addons) | ForEach-Object target) -join ', ')$(if ($Result.PSObject.Properties['remainingTargets']) { "; still on $(@($Result.remainingTargets) -join ', ')" })" }
            return (@($head) + @(Format-WowgetRemoved @($Result.addons))) -join "`n"
        }
        'list' {
            if (@($Result.addons).Count -eq 0) { return 'No addons in the manifest.' }
            $rows = @(, @('NAME', 'TARGET', 'VERSION', 'STATUS', 'SOURCE')) + @(foreach ($a in $Result.addons) {
                    $status = if ($a.status -eq 'missing') { "missing ($(@($a.missingFolders) -join ', '))" } else { $a.status }
                    , @($a.name, $a.target, (Get-WowgetVersionLabel $a.version), $status, $a.source)
                })
            return Format-WowgetTable $rows
        }
        'outdated' {
            if (@($Result.addons).Count -eq 0) { return 'No addons in the manifest.' }
            $rows = @(, @('NAME', 'TARGET', 'INSTALLED', 'LATEST', 'STATUS')) + @(foreach ($a in $Result.addons) {
                    $cells = switch ($a.status) {
                        'current' { @($a.name, $a.target, $a.version, $a.version, 'current') }
                        'outdated' { @($a.name, $a.target, $a.installed, $a.latest, 'outdated') }
                        'not installed' { @($a.name, $a.target, '-', $a.latest, 'not installed') }
                        'missing' { @($a.name, $a.target, $a.installed, $a.latest, "missing ($(@($a.missingFolders) -join ', '))") }
                        default { @($a.name, $a.target, '-', '-', "error: $($a.error)") }
                    }
                    , $cells
                })
            return Format-WowgetTable $rows
        }
        'pin' {
            $lines = @(foreach ($a in $Result.addons) { "Installed $($Result.name) $($a.version) on $($a.target) ($(@($a.folders) -join ', '))" })
            $lines += "Pinned $($Result.name) to $($Result.pin)"
            return $lines -join "`n"
        }
        'unpin' {
            if ($null -ne $Result.PSObject.Properties['previousPin']) { return "Unpinned $($Result.name) (was $($Result.previousPin))" }
            return "$($Result.name) was not pinned"
        }
        'rollback' {
            $lines = @(foreach ($a in $Result.addons) { "Rolled back $($a.name) on $($a.target): $(if ($null -ne $a.from) { $a.from } else { 'none' }) -> $($a.to) ($(@($a.folders) -join ', '))" })
            if ($null -ne $Result.PSObject.Properties['pinned']) {
                $lines += "Pinned $($Result.name) to $($Result.pinned); run `"wowget unpin $($Result.name)`" to resume updates."
            } else {
                $why = if ($Result.notPinned -eq 'partial') { 'the rollback did not cover all its targets' } else { 'its targets are on different releases' }
                $lines += "$($Result.name) was not pinned because $why; the next update reinstalls the newer release."
            }
            return $lines -join "`n"
        }
        'search' {
            if (@($Result.results).Count -eq 0) {
                if ($null -ne $Result.flavors) { return "No addons found for $(@($Result.flavors) -join ', '); --all-flavors searches every flavor." }
                return 'No addons found.'
            }
            # The "*" column only appears when a result is already in the manifest.
            $marked = @($Result.results | Where-Object inManifest).Count -gt 0
            $head = @('NAME', 'SOURCE', 'FLAVORS', 'POPULARITY', 'UPDATED')
            if ($marked) { $head = @('') + $head }
            $rows = @(, $head) + @(foreach ($a in $Result.results) {
                    # Nothing about a GitHub result's releases is known, so it gets a single "?".
                    $flavors = if ($a.origin -eq 'github') { '?' } else { (@($a.flavors.GetEnumerator() | ForEach-Object { if ($_.Value -eq 'unknown') { "$($_.Key)?" } else { $_.Key } }) -join ' ') }
                    if (-not $flavors) { $flavors = '?' }
                    $popularity = if ($null -ne $a.downloadsMonthly) { "$($a.downloadsMonthly)/month" } elseif ($null -ne $a.stars) { "$($a.stars) stars" } else { '' }
                    $updated = if ($a.updatedAt) { $a.updatedAt.Substring(0, [Math]::Min(10, $a.updatedAt.Length)) } else { '' }
                    $cells = @($a.name, $a.source, $flavors, $popularity, $updated)
                    if ($marked) { $cells = @($(if ($a.inManifest) { '*' } else { '' })) + $cells }
                    , $cells
                })
            return Format-WowgetTable $rows
        }
        'reconcile' {
            if (@($Result.addons).Count -eq 0) { return 'No unmanaged addon folders found.' }
            $rows = @(, @('NAME', 'TARGET', 'VERSION', 'STATUS', 'SOURCE', 'FOLDERS')) + @(foreach ($a in $Result.addons) {
                    $status = if ($a.status -eq 'error') { "error: $($a.error)" } else { $a.status }
                    $source = if ($a.source) { $a.source } elseif ($null -ne $a.PSObject.Properties['curseforge']) { 'CurseForge only' } else { '-' }
                    , @($a.name, $a.target, (Get-WowgetVersionLabel $a.version), $status, $source, (@($a.folders) -join ', '))
                })
            return Format-WowgetTable $rows
        }
        'doctor' {
            $rows = @(, @('TARGET', 'FLAVOR', 'CLIENT', 'EXISTS', 'PATH')) + @(foreach ($t in $Result.targets) {
                    $client = if ($null -ne $t.PSObject.Properties['clientInterface']) { "$($t.clientInterface) ($($t.clientVersion))" } else { '-' }
                    , @($t.name, $t.flavor, $client, $(if ($t.exists) { 'yes' } else { 'no' }), $t.path)
                })
            $lines = @(Format-WowgetTable $rows)
            foreach ($path in $Result.cleaned) { $lines += "Cleaned $path" }
            if (@($Result.issues).Count -eq 0) { $lines += 'No issues found.' }
            foreach ($issue in $Result.issues) { $lines += "Issue [$($issue.kind)]: $($issue.message)" }
            foreach ($hint in $Result.hints) { $lines += "Hint [$($hint.kind)]: $($hint.message)" }
            return $lines -join "`n"
        }
        'suggest' {
            if (@($Result.addons).Count -eq 0) { return 'No addons in the manifest.' }
            $rows = @(, @('NAME', 'SOURCE', 'STATUS')) + @(foreach ($a in $Result.addons) {
                    $status = switch ($a.status) {
                        'listed' { "in the registry$(if ($a.registryName -cne $a.name) { " as $($a.registryName)" })" }
                        'url' { 'url: sources cannot be in the registry' }
                        default { 'not in the registry' }
                    }
                    , @($a.name, $a.source, $status)
                })
            $lines = @(Format-WowgetTable $rows)
            if ($Result.url) {
                $count = @($Result.addons | Where-Object status -EQ 'suggested').Count
                $what = if ($count -eq 1) { 'the addon' } else { "the $count addons" }
                $lines += @('', "Submit this issue to suggest $what for the registry; a bot checks them and opens a pull request:", $Result.url)
            } else {
                $lines += @('', 'Nothing to suggest.')
            }
            return $lines -join "`n"
        }
        'migrate' { return Format-WowgetMigrateResult $Result }
        'self-update' {
            if ($Result.status -eq 'updated') { return "Updated wowget $($Result.current) -> $($Result.latest) at $($Result.path)" }
            if ($Result.status -eq 'available') { return "wowget $($Result.latest) is available (installed: $($Result.current)); run `"wowget self-update`" to install it." }
            return "wowget $($Result.current) is up to date (latest release: $($Result.latest))."
        }
        default { return Format-WowgetUpdateResult $Result }
    }
}

function Format-WowgetMigrateResult {
    param($Result)
    $lines = @($Result.notes)
    if ($null -ne $Result.PSObject.Properties['adopted']) {
        foreach ($a in $Result.adopted) {
            $release = if ($a.releaseId -eq 'unknown') { 'release unknown until the next update' } elseif ($a.version) { $a.version } else { $a.releaseId }
            $how = if ($a.how -eq 'cache') { 'identified in the download cache' } else { 'folders from the registry or the cache' }
            $lines += "Adopted $($a.name) on $($a.target): $release, $how ($(@($a.folders) -join ', '))"
        }
        foreach ($s in $Result.skipped) { $lines += "Not adopted $($s.name) on $($s.target): $($s.reason)" }
        foreach ($c in $Result.conflicts) { $lines += "Left without a marker on $($c.target): $($c.folder), claimed by $(@($c.addons) -join ', ')" }
        foreach ($u in $Result.unmarked) { $lines += "Folders without a marker on $($u.target): $(@($u.folders) -join ', '); see `"wowget reconcile`"" }
    }
    if ($lines.Count -eq 0) { $lines += 'Nothing to migrate.' }
    return $lines -join "`n"
}

function Get-WowgetResultRows {
    param($Result)
    $p = $Result.PSObject.Properties['addons']
    if ($null -eq $p) { return @() }
    return @($p.Value)
}

function Test-WowgetResultErrors {
    param($Result)
    $issues = $Result.PSObject.Properties['issues']
    if ($null -ne $issues -and @($issues.Value).Count) { return $true }
    foreach ($a in (Get-WowgetResultRows $Result)) {
        if ($null -ne $a.PSObject.Properties['status'] -and $a.status -eq 'error') { return $true }
    }
    return $false
}

function Invoke-WowgetCommand {
    param([string]$Key, [string[]]$CmdArgs, [hashtable]$Values, [hashtable]$Options)
    $flavor = $Values['flavor']
    $targets = [string[]]@()
    if ($Values.ContainsKey('target')) { $targets = [string[]]$Values['target'].ToArray() }
    $base = @{} + $Options
    $base['Targets'] = $targets
    switch ($Key) {
        'init' { return Invoke-WowgetInit -Options $Options -Path $Values['path'] -Flavor $flavor -Name $Values['name'] -GameDir $Values['game-dir'] -Portable:([bool]$Values['portable']) }
        'target list' { return Invoke-WowgetTargetList -Options $Options }
        'target add' {
            if (($null -eq $Values['path']) -eq ($null -eq $Values['folder']) -or $null -eq $flavor) {
                throw [WowgetUsageError]::new('"target add" needs --flavor and either --path or --folder.')
            }
            return Invoke-WowgetTargetAdd -Options $Options -Name $CmdArgs[0] -Path $Values['path'] -Folder $Values['folder'] -Flavor $flavor
        }
        'target remove' { return Invoke-WowgetTargetRemove -Options $Options -Name $CmdArgs[0] }
        'target portable' { return Invoke-WowgetTargetPortable -Options $Options -Names $CmdArgs }
        'add' {
            $prerelease = if ($Values['prerelease']) { $true } else { $null }
            return Invoke-WowgetAdd -Options $base -Source $CmdArgs[0] -Name $Values['name'] -Prerelease $prerelease -Pin $Values['pin']
        }
        'remove' { return Invoke-WowgetRemove -Options $base -Name $CmdArgs[0] }
        'list' { return Invoke-WowgetList -Options $base }
        'outdated' { return Invoke-WowgetOutdated -Options $base }
        'update' { return Invoke-WowgetUpdate -Options $base -Names $CmdArgs }
        'install' { return Invoke-WowgetInstall -Options $base }
        'pin' { return Invoke-WowgetPin -Options $base -Name $CmdArgs[0] -Release $(if ($CmdArgs.Count -gt 1) { $CmdArgs[1] } else { $null }) }
        'unpin' { return Invoke-WowgetUnpin -Options $base -Name $CmdArgs[0] }
        'rollback' { return Invoke-WowgetRollback -Options $base -Name $CmdArgs[0] }
        'search' {
            $limit = $null
            if ($Values.ContainsKey('limit')) {
                $n = 0
                if ($Values['limit'] -notmatch '^[1-9][0-9]{0,8}$' -or -not [int]::TryParse($Values['limit'], [ref]$n)) { throw [WowgetUsageError]::new("--limit must be a whole number from 1 to $script:SearchMaxLimit.") }
                $limit = $n
            }
            return Invoke-WowgetSearch -Options $base -Query ($CmdArgs -join ' ') -Flavor $flavor -AllFlavors:([bool]$Values['all-flavors']) -Github:([bool]$Values['github']) -Limit $limit
        }
        'reconcile' { return Invoke-WowgetReconcile -Options $base -Adopt:([bool]$Values['adopt']) }
        'doctor' { return Invoke-WowgetDoctor -Options $base -Clean:([bool]$Values['clean']) }
        'suggest' { return Invoke-WowgetSuggest -Options $base -Names $CmdArgs }
        'migrate' { return Invoke-WowgetMigrate -Options $base }
        'self-update' { return Invoke-WowgetSelfUpdate -Options $base -Check:([bool]$Values['check']) }
    }
    throw [WowgetUsageError]::new("Unknown command `"$Key`". Run `"wowget --help`".")
}

function Invoke-WowgetCli {
    param(
        [string[]]$Argv = @(),
        [hashtable]$Env = (Get-WowgetProcessEnv),
        [System.IO.TextWriter]$Stdout = [Console]::Out,
        [System.IO.TextWriter]$Stderr = [Console]::Error,
        [int]$LockTimeoutMs = 10000
    )
    $verbose = $Argv -ccontains '--verbose'
    $json = $Argv -ccontains '--json'
    $progress = New-WowgetProgress $Stderr $verbose
    $lock = $null
    $platform = Get-WowgetPlatform
    try {
        $parsed = ConvertFrom-WowgetArgs $Argv
        $values = $parsed.Values
        $verbose = [bool]$values['verbose']
        $json = [bool]$values['json']
        $progress = New-WowgetProgress $Stderr $verbose
        $positionals = $parsed.Positionals
        if ($values['version']) {
            $Stdout.Write("wowget $script:WowgetVersion`n")
            return 0
        }
        if ($values['help'] -or $positionals.Count -eq 0) {
            $writer = if ($values['help']) { $Stdout } else { $Stderr }
            $writer.Write((Get-WowgetHelp $Env $platform))
            return $(if ($values['help']) { 0 } else { 2 })
        }
        $command = $positionals[0]
        $rest = @($positionals | Select-Object -Skip 1)
        $key = $command
        if ($command -ceq 'target') {
            if ($rest.Count -eq 0) { throw [WowgetUsageError]::new('"target" needs a subcommand: list, add, remove or portable.') }
            $key = "target $($rest[0])"
            $rest = @($rest | Select-Object -Skip 1)
        }
        $spec = $script:Commands[$key]
        if ($null -eq $spec) { throw [WowgetUsageError]::new("Unknown command `"$key`". Run `"wowget --help`".") }
        foreach ($flag in $values.Keys) {
            if ($script:GlobalOptions -ccontains $flag) { continue }
            if ($spec.Flags -cnotcontains $flag) { throw [WowgetUsageError]::new("--$flag is not an option of `"$key`".") }
        }
        if ($rest.Count -lt $spec.Min -or $rest.Count -gt $spec.Max) {
            throw [WowgetUsageError]::new("Wrong number of arguments for `"$key`". Run `"wowget --help`".")
        }
        foreach ($flag in 'path', 'folder', 'game-dir') {
            if ($values.ContainsKey($flag) -and $values[$flag] -eq '') { throw [WowgetUsageError]::new("--$flag must not be empty.") }
        }
        if ($values.ContainsKey('flavor') -and -not (Test-WowgetFlavor $values['flavor'])) {
            throw [WowgetUsageError]::new("Unknown flavor `"$($values['flavor'])`"; expected one of $($script:Flavors -join ', ').")
        }

        $manifestPath = Get-WowgetManifestPath -Override $values['manifest'] -Env $Env -Platform $platform
        $overridden = $values.ContainsKey('manifest') -or $null -ne (Get-WowgetEnvValue $Env 'WOWGET_MANIFEST')
        $options = @{
            ManifestPath       = $manifestPath
            ManifestOverridden = $overridden
            Env                = $Env
            Platform           = $platform
            Force              = [bool]$values['force']
            OnEvent            = $progress.OnEvent
        }
        $need = $null
        if ($script:NoMigrationCommands -cnotcontains $key) { $need = Get-WowgetMigrationNeed $manifestPath $overridden $Env $platform }
        $migrating = $null -ne $need -and ($null -ne $need.Toml -or $need.Adopt)
        if ($migrating -or $script:ReadOnlyCommands -cnotcontains $key) {
            $lock = Enter-WowgetLock -StateDir (Get-WowgetStateDir $Env $platform) -TimeoutMs $LockTimeoutMs
            # Under the lock, so no self-update of another wowget is between installing and switching.
            $root = Get-WowgetInstallRoot
            if ($root) { Remove-WowgetOldVersions $root }
        }
        if ($migrating) { $options.ManifestPath = Invoke-WowgetFirstStart $options $need $progress $Stderr }
        if ($key -ceq 'search' -and $values['refresh']) {
            $Stderr.Write("wowget: note: --refresh does nothing: the addon catalogue is kept by the wowget service.`n")
        }
        $result = Invoke-WowgetCommand -Key $key -CmdArgs $rest -Values $values -Options $options

        & $progress.Flush
        $text = if ($json) { ConvertTo-WowgetJsonText $result -MultilineDepth 64 } else { Format-WowgetResult $key $result }
        $Stdout.Write("$text`n")
        $seen = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($row in (Get-WowgetResultRows $result)) {
            if ($null -ne $row.PSObject.Properties['note'] -and $seen.Add("$($row.name)`0$($row.note)")) { $Stderr.Write("wowget: note: $($row.name): $($row.note)`n") }
        }
        $warnings = $result.PSObject.Properties['warnings']
        if (-not $json -and $null -ne $warnings) { foreach ($w in @($warnings.Value)) { $Stderr.Write("wowget: warning: $w`n") } }
        if ($key -ceq 'suggest' -and -not $values['print'] -and -not $json -and $result.url) {
            if (-not (& $script:WowgetOpenUrl $result.url)) { $Stderr.Write("wowget: warning: could not open a browser; open the URL above.`n") }
        }
        foreach ($row in (Get-WowgetResultRows $result)) {
            if ($null -ne $row.PSObject.Properties['leftoverDir']) {
                $Stderr.Write("wowget: warning: $($row.name) ($($row.target)): could not delete the old folders moved to $($row.leftoverDir); remove it by hand.`n")
            }
        }
        return $(if (Test-WowgetResultErrors $result) { 1 } else { 0 })
    } catch {
        & $progress.Flush
        $ex = Get-WowgetException $_
        $usage = $ex -is [WowgetUsageError] -or ($ex -is [WowgetError] -and $ex.Code -eq 'usage')
        $message = $ex.Message
        $stack = $_.ScriptStackTrace
        if ($json) {
            $code = if ($usage) { 'usage' } elseif ($ex -is [WowgetError]) { $ex.Code } else { 'unexpected' }
            $Stdout.Write((ConvertTo-WowgetJsonText ([ordered]@{ error = [ordered]@{ code = $code; message = $message } }) -MultilineDepth 64) + "`n")
            if ($verbose -and $stack) { $Stderr.Write("$stack`n") }
            return $(if ($usage) { 2 } else { 1 })
        }
        if ($usage) {
            $Stderr.Write("wowget: $message`n")
            return 2
        }
        if ($ex -is [WowgetError]) {
            $Stderr.Write("wowget: $message`n")
            if ($verbose -and $stack) { $Stderr.Write("$stack`n") }
            return 1
        }
        $Stderr.Write("wowget: unexpected error: $message`n")
        if ($verbose -and $stack) { $Stderr.Write("$stack`n") } else { $Stderr.Write("Run again with --verbose for details.`n") }
        return 1
    } finally {
        if ($null -ne $lock) { $lock.Dispose() }
    }
}

# The automatic first start after the Bun client: the TOML import and adoption, reported on stderr so
# that the command's own output stays as it is. Returns the manifest path to use. A failed TOML import
# stops the command; a failed adoption is a warning, and the command runs anyway.
function Invoke-WowgetFirstStart {
    param([hashtable]$Options, $Need, $Progress, [System.IO.TextWriter]$Stderr)
    $report = {
        param($result)
        & $Progress.Flush
        $text = Format-WowgetMigrateResult $result
        if ($text -ne 'Nothing to migrate.') { foreach ($line in ($text -split "`n")) { $Stderr.Write("wowget: $line`n") } }
    }
    $path = $Options.ManifestPath
    if ($null -ne $Need.Toml) {
        $converted = Invoke-WowgetMigrate -Options $Options -SkipAdoption
        $path = $converted.manifestPath
        & $report $converted
    }
    if (-not $Need.Adopt -or -not [System.IO.File]::Exists($path)) { return $path }
    $adoptOptions = @{} + $Options
    $adoptOptions.ManifestPath = $path
    try {
        & $report (Invoke-WowgetMigrate -Options $adoptOptions)
    } catch {
        & $Progress.Flush
        $Stderr.Write("wowget: warning: adopting the addons the previous wowget installed failed: $(Get-WowgetErrorMessage $_); run `"wowget migrate`" to try again.`n")
    }
    return $path
}
