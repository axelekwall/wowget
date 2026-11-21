# One function per command. Each takes an options hashtable and returns a [pscustomobject] whose
# property names are the --json field names; progress goes to the OnEvent script block. Nothing here
# writes to the host.
#
# Options: ManifestPath, CacheDir, Targets (target filter), Force, OnEvent, ApiUrl, GameDirs (searched
# for folder targets; default from Env and Platform), Env, Platform.

function Get-WowgetOption {
    param([Parameter(Mandatory)][hashtable]$Options, [Parameter(Mandatory)][string]$Name, $Default = $null)
    if ($Options.ContainsKey($Name) -and $null -ne $Options[$Name]) { return $Options[$Name] }
    return $Default
}

function Get-WowgetOptionEnv { param([hashtable]$Options) return (Get-WowgetOption $Options 'Env' (Get-WowgetProcessEnv)) }
function Get-WowgetOptionPlatform { param([hashtable]$Options) return (Get-WowgetOption $Options 'Platform' (Get-WowgetPlatform)) }

function Get-WowgetFullPath {
    param([Parameter(Mandatory)][string]$Path, [hashtable]$Options = @{})
    return [System.IO.Path]::GetFullPath((Expand-WowgetHome $Path (Get-WowgetOptionEnv $Options) (Get-WowgetOptionPlatform $Options)))
}

function Get-WowgetGameDirs {
    param([Parameter(Mandatory)][hashtable]$Options)
    $dirs = Get-WowgetOption $Options 'GameDirs'
    if ($null -eq $dirs) { $dirs = Get-WowgetGameDirCandidates (Get-WowgetOptionEnv $Options) (Get-WowgetOptionPlatform $Options) }
    return @($dirs | ForEach-Object { Get-WowgetFullPath $_ $Options })
}

function Send-WowgetEvent {
    param([hashtable]$Options, [hashtable]$Event)
    Invoke-WowgetEvent (Get-WowgetOption $Options 'OnEvent') $Event
}

# Whether two resolved paths name the same directory; macOS and Windows file systems ignore case by default.
function Test-WowgetSamePath {
    param([string]$A, [string]$B)
    if ($IsWindows -or $IsMacOS) { return $A -eq $B }
    return $A -ceq $B
}

# An existing path with every symlink and junction in it followed.
function Resolve-WowgetExistingPath {
    param([Parameter(Mandatory)][string]$Path)
    $current = [System.IO.Path]::GetFullPath($Path)
    for ($round = 0; $round -lt 40; $round++) {
        $root = [System.IO.Path]::GetPathRoot($current)
        $parts = $current.Substring($root.Length).Split([char[]]@('/', '\'), [System.StringSplitOptions]::RemoveEmptyEntries)
        $built = $root
        $changed = $false
        foreach ($part in $parts) {
            $next = [System.IO.Path]::Combine($built, $part)
            $info = [System.IO.DirectoryInfo]::new($next)
            if ($null -ne $info.LinkTarget) {
                $target = $info.ResolveLinkTarget($true)
                if ($null -ne $target) { $next = $target.FullName; $changed = $true }
            }
            $built = $next
        }
        if (-not $changed -or $built -eq $current) { return $built }
        $current = $built
    }
    return $current
}

# $Path with symlinks and junctions followed. A directory that does not exist yet is taken as its
# nearest existing ancestor's real path plus the rest.
function Resolve-WowgetRealDir {
    param([Parameter(Mandatory)][string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    $rest = [System.Collections.Generic.List[string]]::new()
    $dir = $full
    while ($true) {
        if (Test-WowgetPath $dir) {
            $real = Resolve-WowgetExistingPath $dir
            return [System.IO.Path]::Combine([string[]](@($real) + $rest.ToArray()))
        }
        $parent = [System.IO.Path]::GetDirectoryName($dir)
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $dir) { return $full }
        $rest.Insert(0, [System.IO.Path]::GetFileName($dir))
        $dir = $parent
    }
}

# Each target with the AddOns directory it has on this machine; Path is $null for a folder target
# whose version folder is in none of the game directories.
function Find-WowgetTargetDirs {
    param([object[]]$Targets = @(), [string[]]$GameDirs = @())
    $located = foreach ($t in $Targets) {
        $path = if ($null -eq $t.Folder) { $t.Path } else { Find-WowgetVersionFolder $t.Folder $GameDirs }
        [pscustomobject]@{ Name = $t.Name; Flavor = $t.Flavor; Folder = $t.Folder; Path = $path }
    }
    return @($located)
}

function Get-WowgetAbsentReason {
    param($Target, [string[]]$GameDirs)
    if ($GameDirs.Count -eq 0) { return "no game directory to look for $($Target.Folder) in; set WOWGET_GAME_DIR" }
    return "no $($Target.Folder) folder in $($GameDirs -join ', ')"
}

function Select-WowgetTargets {
    param([Parameter(Mandatory)]$Manifest, [Parameter(Mandatory)][string]$ManifestPath, [string[]]$Filter = @())
    if ($Manifest.Targets.Count -eq 0) {
        throw (New-WowgetError 'manifest' "$ManifestPath has no targets; add one with `"wowget target add`".")
    }
    if ($Filter.Count -eq 0) { return @($Manifest.Targets) }
    $names = @($Manifest.Targets | ForEach-Object Name)
    $unknown = @($Filter | Where-Object { $names -cnotcontains $_ })
    if ($unknown.Count) {
        $list = ($unknown | ForEach-Object { "`"$_`"" }) -join ', '
        throw (New-WowgetError 'usage' "Unknown target $list; the manifest has: $($names -join ', ').")
    }
    return @($Manifest.Targets | Where-Object { $Filter -ccontains $_.Name })
}

# Throws when two located targets share an AddOns directory. Each target keeps its own markers, so a
# shared directory would let one overwrite or delete the other's addons.
function Assert-WowgetDistinctDirs {
    param([object[]]$Located = @(), [string]$ManifestPath)
    $present = @($Located | Where-Object { $null -ne $_.Path })
    $real = @($present | ForEach-Object { Resolve-WowgetRealDir $_.Path })
    for ($i = 0; $i -lt $present.Count; $i++) {
        for ($j = $i + 1; $j -lt $present.Count; $j++) {
            if (Test-WowgetSamePath $real[$i] $real[$j]) {
                throw (New-WowgetError 'manifest' "Targets `"$($present[$i].Name)`" and `"$($present[$j].Name)`" both use $($real[$i]); edit $ManifestPath so each target has its own AddOns directory.")
            }
        }
    }
}

# Reads the manifest and locates the selected targets. Without a filter, targets that are not on this
# machine are skipped with an event; a filter naming one is an error.
function Read-WowgetLoaded {
    param([Parameter(Mandatory)][hashtable]$Options)
    $manifestPath = $Options.ManifestPath
    $read = Read-WowgetManifestText $manifestPath
    $manifest = $read.Manifest
    $gameDirs = @(Get-WowgetGameDirs $Options)
    $filter = [string[]]@(Get-WowgetOption $Options 'Targets' @())
    $selected = @(Select-WowgetTargets $manifest $manifestPath $filter | ForEach-Object Name)
    $all = @(Find-WowgetTargetDirs $manifest.Targets $gameDirs)
    Assert-WowgetDistinctDirs $all $manifestPath
    $located = @($all | Where-Object { $selected -ccontains $_.Name })
    $targets = @($located | Where-Object { $null -ne $_.Path })
    $absent = @($located | Where-Object { $null -eq $_.Path })
    if ($absent.Count -and ($filter.Count -or $targets.Count -eq 0)) {
        throw (New-WowgetError 'not_found' "Target `"$($absent[0].Name)`" is not on this machine: $(Get-WowgetAbsentReason $absent[0] $gameDirs).")
    }
    foreach ($t in $absent) {
        Send-WowgetEvent $Options @{ type = 'target:absent'; target = $t.Name; message = "skipping target `"$($t.Name)`": $(Get-WowgetAbsentReason $t $gameDirs)" }
    }
    return [pscustomobject]@{
        Manifest = $manifest; Text = $read.Text; Targets = $targets; All = $all; GameDirs = $gameDirs
    }
}

function New-WowgetContext {
    param([Parameter(Mandatory)][hashtable]$Options)
    $loaded = Read-WowgetLoaded $Options
    $env = Get-WowgetOptionEnv $Options
    return [pscustomobject]@{
        Manifest     = $loaded.Manifest
        Text         = $loaded.Text
        Targets      = $loaded.Targets
        All          = $loaded.All
        GameDirs     = $loaded.GameDirs
        Options      = $Options
        CacheDir     = (Get-WowgetOption $Options 'CacheDir' (Get-WowgetCacheDir $env (Get-WowgetOptionPlatform $Options)))
        ApiUrl       = (Get-WowgetOption $Options 'ApiUrl' (Get-WowgetApiUrl $env))
        Force        = [bool](Get-WowgetOption $Options 'Force' $false)
        Resolutions  = @{}
        MarkerCache  = @{}
    }
}

# $Items sorted by their Name, compared lower-cased and ordinally.
function Get-WowgetSortedByName {
    param([object[]]$Items = @())
    $arr = @(foreach ($item in $Items) { [pscustomobject]@{ K = ([string]$item.Name).ToLowerInvariant(); V = $item } })
    $comparer = [System.StringComparer]::Ordinal
    $sorted = [System.Linq.Enumerable]::OrderBy([object[]]$arr, [Func[object, string]] { param($x) $x.K }, $comparer)
    return @($sorted | ForEach-Object { $_.V })
}

# The (addon, target) pairs for $Entries on the selected targets, by addon name then target name.
function Get-WowgetRows {
    param([Parameter(Mandatory)]$Loaded, [object[]]$Entries = @())
    $rows = foreach ($entry in (Get-WowgetSortedByName $Entries)) {
        $on = @(Get-WowgetAddonTargets $Loaded.Manifest $entry)
        $targets = Get-WowgetSortedByName @($Loaded.Targets | Where-Object { $on -ccontains $_.Name })
        foreach ($target in $targets) { [pscustomobject]@{ Entry = $entry; Target = $target } }
    }
    return @($rows)
}

# The markers of a target's AddOns directory, read once per run until $Refresh.
function Get-WowgetContextMarkers {
    param([Parameter(Mandatory)]$Ctx, [Parameter(Mandatory)]$Target, [switch]$Refresh)
    if ($Refresh -or -not $Ctx.MarkerCache.ContainsKey($Target.Name)) {
        $Ctx.MarkerCache[$Target.Name] = Get-WowgetTargetMarkers $Target.Path
    }
    return $Ctx.MarkerCache[$Target.Name]
}

function Get-WowgetRowKey {
    param([Parameter(Mandatory)]$Row)
    $spec = ConvertFrom-WowgetSource $Row.Entry.Source
    if ($spec.Kind -eq 'url') {
        # A url: source serves one file whatever the flavor, so targets of different flavors share one
        # download; its cache record is per addon, so addons sharing a URL each resolve.
        return ConvertTo-WowgetJsonText @('url', $Row.Entry.Name.ToLowerInvariant(), $Row.Entry.Source, $Row.Entry.Pin) -MultilineDepth 0
    }
    return Get-WowgetResolveKey ([pscustomobject]@{ source = $Row.Entry.Source; flavor = $Row.Target.Flavor; prerelease = $Row.Entry.Prerelease; pin = $Row.Entry.Pin })
}

# Resolves every row not resolved yet in this run: github: and wowi: rows in one batched service
# request, url: rows locally. Results and errors stay in the context, per row.
function Resolve-WowgetRows {
    param([Parameter(Mandatory)]$Ctx, [object[]]$Rows = @())
    $items = [System.Collections.Generic.List[object]]::new()
    foreach ($row in $Rows) {
        $key = Get-WowgetRowKey $row
        if ($Ctx.Resolutions.ContainsKey($key)) { continue }
        $spec = ConvertFrom-WowgetSource $row.Entry.Source
        if ($spec.Kind -eq 'url') {
            try {
                $Ctx.Resolutions[$key] = Resolve-WowgetUrlSource -Addon $row.Entry.Name -Spec $spec -Pin $row.Entry.Pin -CacheDir $Ctx.CacheDir -OnEvent (Get-WowgetOption $Ctx.Options 'OnEvent')
            } catch {
                $Ctx.Resolutions[$key] = Get-WowgetException $_
            }
            continue
        }
        $Ctx.Resolutions[$key] = $null
        $items.Add([pscustomobject]@{ source = $row.Entry.Source; flavor = $row.Target.Flavor; prerelease = $row.Entry.Prerelease; pin = $row.Entry.Pin })
    }
    if ($items.Count) {
        $results = Invoke-WowgetResolve -ApiUrl $Ctx.ApiUrl -Items $items.ToArray()
        foreach ($k in $results.Keys) { $Ctx.Resolutions[$k] = $results[$k] }
    }
}

# The resolved release of a row; throws the row's resolution error.
function Get-WowgetResolved {
    param([Parameter(Mandatory)]$Ctx, [Parameter(Mandatory)]$Row)
    $key = Get-WowgetRowKey $Row
    if (-not $Ctx.Resolutions.ContainsKey($key)) { Resolve-WowgetRows $Ctx @($Row) }
    $value = $Ctx.Resolutions[$key]
    if ($value -is [System.Exception]) { throw $value }
    return $value
}

function Install-WowgetRow {
    param([Parameter(Mandatory)]$Ctx, [Parameter(Mandatory)]$Row, [Parameter(Mandatory)]$Resolved, [switch]$KeepOld)
    $result = Install-WowgetRelease -Addon $Row.Entry.Name -Resolved $Resolved -TargetDir $Row.Target.Path -Flavor $Row.Target.Flavor `
        -CacheDir $Ctx.CacheDir -Force:$Ctx.Force -KeepOld:$KeepOld -OnEvent (Get-WowgetOption $Ctx.Options 'OnEvent')
    [void](Get-WowgetContextMarkers $Ctx $Row.Target -Refresh)
    return $result
}

# Deletes cached releases of $Addon that no install on a target on this machine names.
function Invoke-WowgetCachePrune {
    param([Parameter(Mandatory)]$Ctx, [Parameter(Mandatory)][string]$Addon)
    $installs = foreach ($t in $Ctx.All) {
        if ($null -eq $t.Path) { continue }
        Get-WowgetInstall (Get-WowgetTargetMarkers $t.Path) $Addon
    }
    [void](Remove-WowgetUnusedCache -CacheDir $Ctx.CacheDir -Addon $Addon -Installs @($installs))
}

function Test-WowgetCurrent {
    param($Install, [Parameter(Mandatory)]$Entry, [Parameter(Mandatory)]$Resolved)
    return $null -ne $Install -and $Install.Source -ceq $Entry.Source -and $Install.ReleaseId -ceq $Resolved.ReleaseId
}

# The install when the entry is pinned and that release is installed with all its folders. Such rows
# are current without asking the source, which for url: sources can only serve the latest file.
function Get-WowgetInstalledAtPin {
    param([Parameter(Mandatory)]$Ctx, [Parameter(Mandatory)]$Row)
    if ($null -eq $Row.Entry.Pin) { return $null }
    $markers = Get-WowgetContextMarkers $Ctx $Row.Target
    $install = Get-WowgetInstall $markers $Row.Entry.Name
    if ($null -eq $install -or $install.Source -cne $Row.Entry.Source -or $install.ReleaseId -cne $Row.Entry.Pin) { return $null }
    if (@(Get-WowgetMissingFolders $markers $install).Count) { return $null }
    return $install
}

function Assert-WowgetTargetDir {
    param([Parameter(Mandatory)]$Target)
    if (-not [System.IO.Directory]::Exists($Target.Path)) {
        throw (New-WowgetError 'io' "Target `"$($Target.Name)`": $($Target.Path) does not exist or is not a directory.")
    }
}

function Assert-WowgetTargetNameValid {
    param([Parameter(Mandatory)][string]$Name)
    if (-not (Test-WowgetTargetName $Name)) {
        throw (New-WowgetError 'usage' "Target name `"$Name`" must start with a-z or 0-9 and contain only a-z, 0-9, `"_`" and `"-`".")
    }
}

function Get-WowgetAbsolutePath {
    param($Path, [string]$Flag, [hashtable]$Options)
    if ([string]::IsNullOrEmpty($Path)) { throw (New-WowgetError 'usage' "$Flag must not be empty.") }
    return Get-WowgetFullPath $Path $Options
}

function New-WowgetResult {
    param([Parameter(Mandatory)][System.Collections.Specialized.OrderedDictionary]$Fields)
    return [pscustomobject]$Fields
}

function Get-WowgetErrorText { param($ErrorRecord) return Get-WowgetErrorMessage $ErrorRecord }

# Prefixes the error message with the target name, keeping the code.
function ConvertTo-WowgetTargetError {
    param([string]$Target, $ErrorRecord)
    $ex = Get-WowgetException $ErrorRecord
    if ($ex -is [WowgetError]) { return New-WowgetError $ex.Code "${Target}: $($ex.Message)" $ex }
    return $ex
}

# Removes what an install did on one target and puts back the folders it replaced.
function Undo-WowgetInstall {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)]$Done)
    [void](Uninstall-WowgetAddon -TargetDir $Done.Target.Path -Addon $Name)
    if ($Done.OldDir) {
        $unrestored = foreach ($path in [System.IO.Directory]::GetDirectories($Done.OldDir)) {
            $folder = [System.IO.Path]::GetFileName($path)
            try { [System.IO.Directory]::Move($path, [System.IO.Path]::Combine($Done.Target.Path, $folder)) } catch { $folder }
        }
        if (@($unrestored).Count) { throw (New-WowgetError 'io' "restoring $(@($unrestored) -join ', ') failed") }
        [void](Remove-WowgetBestEffort $Done.OldDir)
    }
}

# Undoes $Done in reverse order and rethrows $Failure, naming anything that could not be undone.
function Invoke-WowgetUndo {
    param([Parameter(Mandatory)][string]$Name, [object[]]$Done = @(), [Parameter(Mandatory)]$Failure, [string]$What = 'install')
    $failed = [System.Collections.Generic.List[string]]::new()
    for ($i = $Done.Count - 1; $i -ge 0; $i--) {
        $d = $Done[$i]
        try {
            Undo-WowgetInstall $Name $d
        } catch {
            $kept = if ($d.OldDir) { "; the replaced folders are in $($d.OldDir)" } else { '' }
            $failed.Add("$($d.Target.Name): $(Get-WowgetErrorMessage $_)$kept")
        }
    }
    $ex = Get-WowgetException $Failure
    if ($failed.Count) {
        $code = if ($ex -is [WowgetError]) { $ex.Code } else { 'io' }
        throw (New-WowgetError $code "$($ex.Message) Undoing the $What of $Name also failed ($($failed -join '; ')).")
    }
    throw $ex
}

# Installs $Rows with the replaced folders kept, runs $Commit, and undoes every install when an
# install or the commit fails. Returns the done records (Target, OldDir, Installed, Resolved, Previous).
function Invoke-WowgetInstallAll {
    param([Parameter(Mandatory)]$Ctx, [Parameter(Mandatory)][string]$Name, [object[]]$Rows = @(), [scriptblock]$Resolve, [scriptblock]$Commit, [string]$What = 'install')
    $done = [System.Collections.Generic.List[object]]::new()
    try {
        foreach ($row in $Rows) {
            try {
                $markers = Get-WowgetContextMarkers $Ctx $row.Target
                $previous = Get-WowgetInstall $markers $Name
                $resolved = & $Resolve $row
                $installed = Install-WowgetRow $Ctx $row $resolved -KeepOld
                $done.Add([pscustomobject]@{ Target = $row.Target; OldDir = $installed.OldDir; Installed = $installed; Resolved = $resolved; Previous = $previous })
            } catch {
                if ($Rows.Count -gt 1) { throw (ConvertTo-WowgetTargetError $row.Target.Name $_) }
                throw
            }
        }
        if ($Commit) { & $Commit }
    } catch {
        Invoke-WowgetUndo -Name $Name -Done $done.ToArray() -Failure $_ -What $What
    }
    foreach ($d in $done) {
        $leftover = $null
        if ($d.OldDir -and -not (Remove-WowgetBestEffort $d.OldDir)) { $leftover = $d.OldDir }
        $d | Add-Member -NotePropertyName LeftoverDir -NotePropertyValue $leftover
    }
    return $done.ToArray()
}

function Add-WowgetOptionalField {
    param([System.Collections.Specialized.OrderedDictionary]$Fields, [string]$Name, $Value)
    if ($null -ne $Value -and $Value -ne '') { $Fields[$Name] = $Value }
}

# init

function Invoke-WowgetInit {
    param(
        [Parameter(Mandatory)][hashtable]$Options,
        $Path = $null,
        $Flavor = $null,
        $Name = $null,
        $GameDir = $null,
        [switch]$Portable
    )
    $manifestPath = $Options.ManifestPath
    if (Test-WowgetPath $manifestPath) { throw (New-WowgetError 'manifest_exists' "A manifest already exists at $manifestPath.") }
    if ($Portable -and ($null -ne $Path -or $null -ne $GameDir)) {
        throw (New-WowgetError 'usage' '--portable does not apply together with --path or --game-dir; set WOWGET_GAME_DIR instead.')
    }
    if ($null -ne $Path) {
        if ($null -ne $GameDir) { throw (New-WowgetError 'usage' '--game-dir does not apply together with --path.') }
        $full = Get-WowgetAbsolutePath $Path '--path' $Options
        $flavorName = if ($Flavor) { $Flavor } else { 'forever' }
        $targetName = if ($null -ne $Name) { $Name } else { $flavorName }
        Assert-WowgetTargetNameValid $targetName
        $targets = @(New-WowgetTarget -Name $targetName -Path $full -Flavor $flavorName)
        $paths = @($full)
    } else {
        if ($null -ne $Name -or $null -ne $Flavor) {
            throw (New-WowgetError 'usage' '--name and --flavor only apply together with --path.')
        }
        $candidates = @(if ($null -ne $GameDir) { Get-WowgetAbsolutePath $GameDir '--game-dir' $Options } else { Get-WowgetGameDirs $Options })
        $found = @()
        foreach ($dir in $candidates) {
            $found = @(Find-WowgetInstalls $dir)
            if ($found.Count) { break }
        }
        if ($found.Count -eq 0) {
            $tried = if ($candidates.Count) { "No World of Warcraft installs found in $($candidates -join ', ')" } else { 'No default game directory on this platform' }
            throw (New-WowgetError 'not_found' "$tried; pass --game-dir, or --path to an AddOns directory.")
        }
        # A folder target resolves to the first game directory holding that folder, which may not be
        # the one scanned here; the path is written instead so it cannot point elsewhere later.
        $targets = foreach ($d in $found) {
            $locatedHere = Find-WowgetVersionFolder $d.Folder $candidates
            if ($Portable -and $locatedHere -eq $d.AddonsDir) { New-WowgetTarget -Name $d.Name -Folder $d.Folder -Flavor $d.Flavor }
            else { New-WowgetTarget -Name $d.Name -Path $d.AddonsDir -Flavor $d.Flavor }
        }
        $targets = @($targets)
        $paths = @($found | ForEach-Object AddonsDir)
    }
    $created = @($paths | ForEach-Object { New-WowgetDirectory $_ })
    $manifest = New-WowgetManifestFile $manifestPath $targets
    $rows = for ($i = 0; $i -lt $manifest.Targets.Count; $i++) {
        $info = ConvertTo-WowgetTargetInfo $manifest.Targets[$i] $paths[$i]
        $info | Add-Member -NotePropertyName createdAddonsDir -NotePropertyValue ([bool]$created[$i])
        $info
    }
    return New-WowgetResult ([ordered]@{ manifestPath = $manifestPath; targets = @($rows) })
}

function ConvertTo-WowgetTargetInfo {
    param([Parameter(Mandatory)]$Target, $Path)
    $fields = [ordered]@{ name = $Target.Name; flavor = $Target.Flavor }
    if ($null -ne $Target.Folder) { $fields['folder'] = $Target.Folder }
    $fields['path'] = $Path
    return [pscustomobject]$fields
}

# target list, add, remove, portable

function Invoke-WowgetTargetList {
    param([Parameter(Mandatory)][hashtable]$Options)
    $manifest = Read-WowgetManifest $Options.ManifestPath
    $located = @(Find-WowgetTargetDirs $manifest.Targets @(Get-WowgetGameDirs $Options))
    $rows = for ($i = 0; $i -lt $manifest.Targets.Count; $i++) {
        $path = $located[$i].Path
        $info = ConvertTo-WowgetTargetInfo $manifest.Targets[$i] $path
        $info | Add-Member -NotePropertyName exists -NotePropertyValue ($null -ne $path -and [System.IO.Directory]::Exists($path))
        $info
    }
    return New-WowgetResult ([ordered]@{ targets = @($rows) })
}

# Adds a target. A folder target that is not on this machine is added all the same, for the other machines.
function Invoke-WowgetTargetAdd {
    param([Parameter(Mandatory)][hashtable]$Options, [Parameter(Mandatory)][string]$Name, $Path = $null, $Folder = $null, [Parameter(Mandatory)][string]$Flavor)
    Assert-WowgetTargetNameValid $Name
    if (($null -eq $Path) -eq ($null -eq $Folder)) { throw (New-WowgetError 'usage' '"target add" needs either --path or --folder.') }
    $read = Read-WowgetManifestText $Options.ManifestPath
    $manifest = $read.Manifest
    if (Find-WowgetTarget $manifest $Name) { throw (New-WowgetError 'duplicate' "A target named `"$Name`" is already in the manifest.") }
    $gameDirs = @(Get-WowgetGameDirs $Options)
    if ($null -ne $Folder) {
        if (-not (Test-WowgetVersionFolderName $Folder)) {
            throw (New-WowgetError 'usage' "--folder `"$Folder`" must be a single folder name in the game directory, such as `"_retail_`".")
        }
        # Game directories are on case-insensitive file systems on macOS and Windows.
        $clash = $manifest.Targets | Where-Object { $null -ne $_.Folder -and $_.Folder -eq $Folder } | Select-Object -First 1
        if ($clash) { throw (New-WowgetError 'usage' "$Folder is already the folder of target `"$($clash.Name)`".") }
        $target = New-WowgetTarget -Name $Name -Folder $Folder -Flavor $Flavor
        $here = Find-WowgetVersionFolder $Folder $gameDirs
    } else {
        $here = Get-WowgetAbsolutePath $Path '--path' $Options
        $target = New-WowgetTarget -Name $Name -Path $here -Flavor $Flavor
    }
    # A folder target not on this machine would resolve to its folder in any game directory once that
    # folder exists, which creating the new target's directory could make happen.
    $possible = {
        param($t)
        if ($null -ne $t.Path) { , @(Resolve-WowgetRealDir $t.Path) }
        else { , @($gameDirs | ForEach-Object { Resolve-WowgetRealDir ([System.IO.Path]::Combine($_, $t.Folder, 'Interface', 'AddOns')) }) }
    }
    $mine = @(if ($null -ne $here) { Resolve-WowgetRealDir $here } else { & $possible ([pscustomobject]@{ Path = $null; Folder = $Folder }) })
    foreach ($t in (Find-WowgetTargetDirs $manifest.Targets $gameDirs)) {
        foreach ($p in (& $possible $t)) {
            foreach ($m in $mine) {
                if (Test-WowgetSamePath $p $m) {
                    $what = if ($null -ne $here) { $here } else { "the $Folder folder" }
                    throw (New-WowgetError 'usage' "$what is already the AddOns directory of target `"$($t.Name)`", or would be once it exists.")
                }
            }
        }
    }
    $created = $null -ne $here -and (New-WowgetDirectory $here)
    $next = New-WowgetManifestObject -Targets (@($manifest.Targets) + $target) -Addons $manifest.Addons
    [void](Save-WowgetManifest $Options.ManifestPath $read.Text $next)
    return New-WowgetResult ([ordered]@{ target = (ConvertTo-WowgetTargetInfo $target $here); createdAddonsDir = [bool]$created })
}

# Whether the path target can become a folder target: its path must be <game dir>/<folder>/Interface/AddOns
# for the game directory a folder target would locate on this machine.
function Test-WowgetPortable {
    param([Parameter(Mandatory)]$Target, [object[]]$Others = @(), [string[]]$GameDirs = @(), [hashtable]$Options = @{})
    if ($null -eq $Target.Path) { return [pscustomobject]@{ Folder = $null; Reason = "already a folder target ($($Target.Folder))" } }
    $addonsDir = Get-WowgetFullPath $Target.Path $Options
    $interfaceDir = [System.IO.Path]::GetDirectoryName($addonsDir)
    $folder = [System.IO.Path]::GetFileName([System.IO.Path]::GetDirectoryName($interfaceDir))
    if (-not (Test-WowgetSamePath ([System.IO.Path]::GetFileName($addonsDir)) 'AddOns') -or -not (Test-WowgetSamePath ([System.IO.Path]::GetFileName($interfaceDir)) 'Interface') -or -not (Test-WowgetVersionFolderName $folder)) {
        return [pscustomobject]@{ Folder = $null; Reason = "$($Target.Path) is not <game dir>/<version folder>/Interface/AddOns" }
    }
    $located = Find-WowgetVersionFolder $folder $GameDirs
    if ($null -eq $located -or -not (Test-WowgetSamePath $located $addonsDir)) {
        $where = if ($located) { "would locate $located instead" } else { "would not be found in $(if ($GameDirs.Count) { $GameDirs -join ', ' } else { 'any game directory' })" }
        return [pscustomobject]@{ Folder = $null; Reason = "a folder target $folder $where" }
    }
    $clash = $Others | Where-Object { $_.Name -cne $Target.Name -and $null -ne $_.Folder -and $_.Folder -eq $folder } | Select-Object -First 1
    if ($clash) { return [pscustomobject]@{ Folder = $null; Reason = "$folder is already the folder of target `"$($clash.Name)`"" } }
    return [pscustomobject]@{ Folder = $folder; Reason = $null }
}

function Invoke-WowgetTargetPortable {
    param([Parameter(Mandatory)][hashtable]$Options, [string[]]$Names = @())
    $read = Read-WowgetManifestText $Options.ManifestPath
    $manifest = $read.Manifest
    if ($Names.Count) {
        $unknown = @($Names | Where-Object { -not (Find-WowgetTarget $manifest $_) })
        if ($unknown.Count) {
            $valid = if ($manifest.Targets.Count) { ($manifest.Targets | ForEach-Object Name) -join ', ' } else { 'none' }
            $list = ($unknown | ForEach-Object { '"' + $_ + '"' }) -join ', '
            throw (New-WowgetError 'usage' "Unknown target $list; the manifest has $valid.")
        }
    }
    $gameDirs = @(Get-WowgetGameDirs $Options)
    $selected = @($manifest.Targets | Where-Object { if ($Names.Count) { $Names -ccontains $_.Name } else { $null -ne $_.Path } })
    # Checked in manifest order against the result so far, so two targets cannot take one folder.
    $after = @($manifest.Targets)
    $converted = [System.Collections.Generic.List[object]]::new()
    $skipped = [System.Collections.Generic.List[object]]::new()
    foreach ($t in $selected) {
        $check = Test-WowgetPortable $t $after $gameDirs $Options
        if ($null -eq $check.Folder) {
            $skipped.Add([pscustomobject]@{ name = $t.Name; reason = $check.Reason })
            continue
        }
        $after = @($after | ForEach-Object { if ($_.Name -ceq $t.Name) { New-WowgetTarget -Name $_.Name -Folder $check.Folder -Flavor $_.Flavor } else { $_ } })
        $converted.Add([pscustomobject][ordered]@{ name = $t.Name; flavor = $t.Flavor; folder = $check.Folder; path = (Get-WowgetFullPath $t.Path $Options) })
    }
    if ($converted.Count) {
        [void](Save-WowgetManifest $Options.ManifestPath $read.Text (New-WowgetManifestObject -Targets $after -Addons $manifest.Addons))
    }
    return New-WowgetResult ([ordered]@{ converted = $converted.ToArray(); skipped = $skipped.ToArray() })
}

function ConvertTo-WowgetRemoveEntry {
    param([string]$Name, [string]$Target, $Result)
    $fields = [ordered]@{ name = $Name; target = $Target; wasInstalled = [bool]$Result.WasInstalled; removedFolders = [string[]]@($Result.RemovedFolders) }
    Add-WowgetOptionalField $fields 'leftoverDir' $Result.LeftoverDir
    return [pscustomobject]$fields
}

# Names what was already uninstalled in an error that stops a removal before the manifest is written.
function ConvertTo-WowgetStoppedError {
    param($ErrorRecord, [object[]]$Done = @())
    $ex = Get-WowgetException $ErrorRecord
    $uninstalled = @($Done | Where-Object { $_.wasInstalled } | ForEach-Object { "$($_.name) from $($_.target)" })
    if ($uninstalled.Count -eq 0) { return $ex }
    $code = if ($ex -is [WowgetError]) { $ex.Code } else { 'io' }
    return New-WowgetError $code "$($ex.Message) Already uninstalled: $($uninstalled -join ', '); the manifest was not changed."
}

# Uninstalls from a located target. Markers on a target not on this machine cannot be reached; they stay,
# and doctor there reports them as orphaned.
function Uninstall-WowgetFromTarget {
    param([Parameter(Mandatory)]$Target, [Parameter(Mandatory)][string]$Addon, [hashtable]$Options)
    if ($null -ne $Target.Path) { return Uninstall-WowgetAddon -TargetDir $Target.Path -Addon $Addon }
    Send-WowgetEvent $Options @{ type = 'target:absent'; target = $Target.Name; message = "target `"$($Target.Name)`" is not on this machine; folders of $Addon there were not touched" }
    return [pscustomobject]@{ Addon = $Addon; RemovedFolders = [string[]]@(); WasInstalled = $false; LeftoverDir = $null }
}

# Uninstalls everything wowget installed on the target, then removes it from the manifest. The manifest
# edit is computed and checked first, so an edit that cannot be made uninstalls nothing.
function Invoke-WowgetTargetRemove {
    param([Parameter(Mandatory)][hashtable]$Options, [Parameter(Mandatory)][string]$Name)
    $read = Read-WowgetManifestText $Options.ManifestPath
    $manifest = $read.Manifest
    $target = Find-WowgetTarget $manifest $Name
    if (-not $target) { throw (New-WowgetError 'not_found' "No target named `"$Name`" in the manifest.") }
    $plan = Remove-WowgetManifestTarget $manifest $target.Name
    [void](Assert-WowgetManifestPlanned $Options.ManifestPath $plan.Manifest)
    $located = @(Find-WowgetTargetDirs @($target) @(Get-WowgetGameDirs $Options))[0]
    $addons = [System.Collections.Generic.List[object]]::new()
    try {
        $names = @()
        if ($null -ne $located.Path) { $names = Get-WowgetMarkedAddons (Get-WowgetTargetMarkers $located.Path) }
        else { Send-WowgetEvent $Options @{ type = 'target:absent'; target = $target.Name; message = "target `"$($target.Name)`" is not on this machine; its addon folders there were not touched" } }
        foreach ($markerName in (Get-WowgetSortedByName @($names | ForEach-Object { [pscustomobject]@{ Name = $_ } }) | ForEach-Object Name)) {
            $entry = Find-WowgetAddon $manifest $markerName
            $addonName = if ($entry) { $entry.Name } else { $markerName }
            $result = Uninstall-WowgetAddon -TargetDir $located.Path -Addon $addonName
            $addons.Add((ConvertTo-WowgetRemoveEntry $addonName $target.Name $result))
        }
        [void](Save-WowgetManifest $Options.ManifestPath $read.Text $plan.Manifest)
    } catch {
        throw (ConvertTo-WowgetStoppedError $_ $addons.ToArray())
    }
    return New-WowgetResult ([ordered]@{ name = $target.Name; removedAddons = [string[]]@($plan.RemovedAddons); addons = $addons.ToArray() })
}

# add

# The registry entry for an "add" argument without a source kind; a source error when there is none.
function Get-WowgetRegistryEntryFor {
    param([Parameter(Mandatory)]$Ctx, [Parameter(Mandatory)][string]$Name)
    $registry = Get-WowgetRegistry -ApiUrl $Ctx.ApiUrl -CacheDir $Ctx.CacheDir
    if ($registry.Stale) { Send-WowgetEvent $Ctx.Options @{ type = 'registry:stale'; message = $registry.Stale } }
    $entry = Find-WowgetRegistryEntry $registry.Entries $Name
    if (-not $entry) {
        $hint = if ($Name -match '^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$') { "Did you mean `"github:$Name`"?" } else { "Try `"wowget search $Name`", or give a source such as github:owner/repo." }
        throw (New-WowgetError 'source' "`"$Name`" is not in the addon registry. $hint")
    }
    if ($entry.Disabled) {
        throw (New-WowgetError 'source' "$($entry.Name) is disabled in the addon registry: $($entry.Disabled). Give its source ($($entry.Source)) to add it anyway.")
    }
    return $entry
}

# The registry name of a source, or $null when the registry does not list it or cannot be read.
function Get-WowgetRegistryNameForSource {
    param([Parameter(Mandatory)]$Ctx, [Parameter(Mandatory)][string]$Source)
    try { $registry = Get-WowgetRegistry -ApiUrl $Ctx.ApiUrl -CacheDir $Ctx.CacheDir } catch { return $null }
    $entry = $registry.Entries | Where-Object { $_.Source -eq $Source -and -not $_.Disabled } | Select-Object -First 1
    if ($entry) { return $entry.Name }
    return $null
}

function Invoke-WowgetAdd {
    param([Parameter(Mandatory)][hashtable]$Options, [Parameter(Mandatory)][AllowEmptyString()][string]$Source, $Name = $null, $Prerelease = $null, $Pin = $null)
    if ($Source.Trim() -eq '') { throw (New-WowgetError 'usage' 'add needs a source or an addon name.') }
    if ($null -ne $Pin -and "$Pin" -eq '') { throw (New-WowgetError 'usage' 'Pin must not be empty.') }
    $ctx = New-WowgetContext $Options
    if (-not $Source.Contains(':')) {
        $registryEntry = Get-WowgetRegistryEntryFor $ctx $Source
        # An addon already in the manifest with this source keeps its name, as with "add <source>".
        $known = @($ctx.Manifest.Addons | Where-Object { $_.Source -ceq $registryEntry.Source }).Count -gt 0
        $useName = if ($null -ne $Name) { $Name } elseif ($known) { $null } else { $registryEntry.Name }
        $result = Invoke-WowgetAdd -Options $Options -Source $registryEntry.Source -Name $useName -Prerelease $Prerelease -Pin $Pin
        $result | Add-Member -NotePropertyName registryName -NotePropertyValue $Source
        return $result
    }
    $spec = ConvertFrom-WowgetSource $Source
    if ($Prerelease -and $spec.Kind -ne 'github') { throw (New-WowgetError 'usage' '--prerelease only applies to GitHub sources.') }
    $existingBySource = if ($null -eq $Name) { $ctx.Manifest.Addons | Where-Object { $_.Source -ceq $Source } | Select-Object -First 1 } else { $null }
    $inferred = if ($null -ne $Name) { $Name } elseif ($existingBySource) { $existingBySource.Name } else { $null }
    if ($null -eq $inferred -and $spec.Kind -eq 'wowi') { $inferred = Get-WowgetRegistryNameForSource $ctx $Source }
    $default = Get-WowgetDefaultAddonName $spec
    $existing = Find-WowgetAddon $ctx.Manifest $(if ($null -ne $inferred) { $inferred } else { $default })
    $addonName = if ($existing) { $existing.Name } elseif ($null -ne $inferred) { $inferred } else { $default }

    $filter = [string[]]@(Get-WowgetOption $Options 'Targets' @())
    if ($existing) {
        $existingOn = @(Get-WowgetAddonTargets $ctx.Manifest $existing)
        $addedTargets = @()
        if ($filter.Count) { $addedTargets = @($ctx.Targets | Where-Object { $existingOn -cnotcontains $_.Name }) }
        if ($addedTargets.Count -eq 0) { throw (New-WowgetError 'duplicate' "An addon named `"$addonName`" is already in the manifest.") }
        if ($existing.Source -cne $Source) {
            throw (New-WowgetError 'duplicate' "An addon named `"$addonName`" is already in the manifest with source `"$($existing.Source)`".")
        }
        if ($null -ne $Prerelease -and [bool]$Prerelease -ne $existing.Prerelease) { throw (New-WowgetError 'usage' "Cannot change --prerelease on existing addon `"$addonName`".") }
        if ($null -ne $Pin -and $Pin -cne $existing.Pin) { throw (New-WowgetError 'usage' "Cannot change --pin on existing addon `"$addonName`".") }
        $addedNames = @($addedTargets | ForEach-Object Name)
        $combined = @($ctx.Manifest.Targets | ForEach-Object Name | Where-Object { $existingOn -ccontains $_ -or $addedNames -ccontains $_ })
        $entry = Copy-WowgetAddonEntry $existing
        $entry.Targets = $null
        if ($combined.Count -lt $ctx.Manifest.Targets.Count) { $entry.Targets = [string[]]$combined }
        $installTargets = $addedTargets
    } else {
        $entryTargets = $null
        # Without a filter the addon is on every target, also those skipped because they are not on this machine.
        if ($filter.Count -and $ctx.Targets.Count -lt $ctx.Manifest.Targets.Count) { $entryTargets = [string[]]@($ctx.Targets | ForEach-Object Name) }
        $entry = New-WowgetAddonEntry -Name $addonName -Source $Source -Prerelease ([bool]$Prerelease) -Pin $Pin -Targets $entryTargets
        $installTargets = @($ctx.Targets)
    }
    $nextManifest = if ($existing) { Set-WowgetManifestAddon $ctx.Manifest $existing.Name $entry } else { New-WowgetManifestObject -Targets $ctx.Manifest.Targets -Addons (@($ctx.Manifest.Addons) + $entry) }
    # Catch an entry the manifest would reject before downloading anything.
    try {
        [void](Assert-WowgetManifestPlanned $Options.ManifestPath $nextManifest)
    } catch {
        if ((Get-WowgetErrorCode $_) -ne 'manifest') { throw }
        throw (New-WowgetError 'usage' "Cannot add `"$addonName`": $(Get-WowgetErrorMessage $_)")
    }

    # A missing target would only fail after the others were installed.
    foreach ($t in $installTargets) { Assert-WowgetTargetDir $t }
    $rows = @(Get-WowgetSortedByName $installTargets | ForEach-Object { [pscustomobject]@{ Entry = $entry; Target = $_ } })
    Resolve-WowgetRows $ctx $rows
    $manifestPath = $Options.ManifestPath
    $text = $ctx.Text
    $done = Invoke-WowgetInstallAll -Ctx $ctx -Name $addonName -Rows $rows -Resolve { param($row) Get-WowgetResolved $ctx $row } -Commit {
        [void](Save-WowgetManifest $manifestPath $text $nextManifest)
    }
    Invoke-WowgetCachePrune $ctx $addonName
    $addons = foreach ($d in $done) {
        $fields = [ordered]@{ name = $addonName; target = $d.Target.Name; releaseId = $d.Installed.ReleaseId; version = $d.Installed.Version; folders = [string[]]$d.Installed.Folders }
        Add-WowgetOptionalField $fields 'leftoverDir' $d.LeftoverDir
        Add-WowgetOptionalField $fields 'note' $d.Resolved.Note
        [pscustomobject]$fields
    }
    $result = [ordered]@{ name = $addonName; source = $Source }
    if ($null -ne $entry.Targets) { $result['targets'] = [string[]]$entry.Targets }
    $result['addons'] = @($addons)
    return New-WowgetResult $result
}

# remove

# Without a target filter, uninstalls the addon everywhere and removes its entry. With one, uninstalls
# it from those targets and drops them from its targets list, removing the entry when none are left.
# A name the manifest does not have, with a filter, removes folders whose markers name it there.
function Invoke-WowgetRemove {
    param([Parameter(Mandatory)][hashtable]$Options, [Parameter(Mandatory)][string]$Name)
    $read = Read-WowgetManifestText $Options.ManifestPath
    $manifest = $read.Manifest
    $filter = [string[]]@(Get-WowgetOption $Options 'Targets' @())
    $selected = @(Select-WowgetTargets $manifest $Options.ManifestPath $filter)
    $all = @(Find-WowgetTargetDirs $manifest.Targets @(Get-WowgetGameDirs $Options))
    $entry = Find-WowgetAddon $manifest $Name
    if (-not $entry) {
        if ($filter.Count) { return Remove-WowgetOrphan $Options $Name $all $selected }
        throw (New-WowgetError 'not_found' "No addon named `"$Name`" in the manifest.")
    }
    $filtered = $filter.Count -gt 0
    $on = @(Get-WowgetAddonTargets $manifest $entry)
    $notOn = @($selected | Where-Object { $on -cnotcontains $_.Name } | ForEach-Object Name)
    if ($filtered -and $notOn.Count) {
        throw (New-WowgetError 'usage' "$($entry.Name) is not on target $($notOn -join ', '); it is on $($on -join ', ').")
    }

    # The manifest edit is computed and checked first, so an edit that cannot be made uninstalls nothing.
    $dropped = @($selected | ForEach-Object Name)
    $remaining = @()
    if ($filtered) { $remaining = @($on | Where-Object { $dropped -cnotcontains $_ }) }
    if ($remaining.Count) {
        $copy = Copy-WowgetAddonEntry $entry
        $copy.Targets = [string[]]$remaining
        $next = Set-WowgetManifestAddon $manifest $entry.Name $copy
    } else {
        $next = Set-WowgetManifestAddon $manifest $entry.Name $null
    }
    [void](Assert-WowgetManifestPlanned $Options.ManifestPath $next)

    Assert-WowgetDistinctDirs $all $Options.ManifestPath
    # Without a filter every target is checked, so installs left behind by a hand edit go too.
    $targets = Get-WowgetSortedByName @($all | Where-Object { -not $filtered -or $dropped -ccontains $_.Name })
    $addons = [System.Collections.Generic.List[object]]::new()
    try {
        foreach ($target in $targets) {
            $result = Uninstall-WowgetFromTarget $target $entry.Name $Options
            if ($filtered -or $on -ccontains $target.Name -or $result.WasInstalled) { $addons.Add((ConvertTo-WowgetRemoveEntry $entry.Name $target.Name $result)) }
        }
        [void](Save-WowgetManifest $Options.ManifestPath $read.Text $next)
    } catch {
        throw (ConvertTo-WowgetStoppedError $_ $addons.ToArray())
    }
    $fields = [ordered]@{ name = $entry.Name; removedEntry = ($remaining.Count -eq 0) }
    if ($remaining.Count) { $fields['remainingTargets'] = [string[]]$remaining }
    $fields['addons'] = $addons.ToArray()
    return New-WowgetResult $fields
}

function Remove-WowgetOrphan {
    param([hashtable]$Options, [string]$Name, [object[]]$All, [object[]]$Selected)
    $names = @($Selected | ForEach-Object Name)
    $addons = foreach ($target in (Get-WowgetSortedByName @($All | Where-Object { $names -ccontains $_.Name }))) {
        if ($null -eq $target.Path) { throw (New-WowgetError 'not_found' "Target `"$($target.Name)`" is not on this machine.") }
        $result = Uninstall-WowgetAddon -TargetDir $target.Path -Addon $Name
        if ($result.WasInstalled) { ConvertTo-WowgetRemoveEntry $Name $target.Name $result }
    }
    $addons = @($addons)
    if ($addons.Count -eq 0) { throw (New-WowgetError 'not_found' "No addon named `"$Name`" in the manifest or in the markers of $($names -join ', ').") }
    return New-WowgetResult ([ordered]@{ name = $Name; removedEntry = $false; orphan = $true; addons = $addons })
}

# list

function Invoke-WowgetList {
    param([Parameter(Mandatory)][hashtable]$Options)
    $loaded = Read-WowgetLoaded $Options
    $markerCache = @{}
    $addons = foreach ($row in (Get-WowgetRows $loaded $loaded.Manifest.Addons)) {
        $t = $row.Target
        if (-not $markerCache.ContainsKey($t.Name)) { $markerCache[$t.Name] = Get-WowgetTargetMarkers $t.Path }
        $markers = $markerCache[$t.Name]
        $install = Get-WowgetInstall $markers $row.Entry.Name
        $fields = [ordered]@{ name = $row.Entry.Name; target = $t.Name; source = $row.Entry.Source }
        if (-not $install) {
            $fields['version'] = $null; $fields['releaseId'] = $null; $fields['status'] = 'not installed'; $fields['missingFolders'] = [string[]]@()
        } else {
            $missing = @(Get-WowgetMissingFolders $markers $install)
            $fields['version'] = Get-WowgetInstallVersion $install
            $fields['releaseId'] = $install.ReleaseId
            $fields['status'] = $(if ($missing.Count) { 'missing' } else { 'ok' })
            $fields['missingFolders'] = [string[]]$missing
            $fields['installedAt'] = $install.InstalledAt
        }
        [pscustomobject]$fields
    }
    $targets = foreach ($t in $loaded.Targets) { ConvertTo-WowgetTargetInfo $t $t.Path }
    return New-WowgetResult ([ordered]@{ targets = @($targets); addons = @($addons) })
}

# outdated

function Invoke-WowgetOutdated {
    param([Parameter(Mandatory)][hashtable]$Options)
    $ctx = New-WowgetContext $Options
    $rows = @(Get-WowgetRows $ctx $ctx.Manifest.Addons)
    $atPin = @{}
    foreach ($row in $rows) {
        $pinned = Get-WowgetInstalledAtPin $ctx $row
        if ($pinned) { $atPin[(Get-WowgetRowId $row)] = $pinned }
    }
    Resolve-WowgetRows $ctx @($rows | Where-Object { -not $atPin.ContainsKey((Get-WowgetRowId $_)) })
    $addons = foreach ($row in $rows) {
        $ids = [ordered]@{ name = $row.Entry.Name; target = $row.Target.Name }
        $pinned = $atPin[(Get-WowgetRowId $row)]
        if ($pinned) { [pscustomobject]($ids + [ordered]@{ status = 'current'; version = (Get-WowgetInstallVersion $pinned) }); continue }
        try {
            $resolved = Get-WowgetResolved $ctx $row
            $note = [ordered]@{}
            Add-WowgetOptionalField $note 'note' $resolved.Note
            $markers = Get-WowgetContextMarkers $ctx $row.Target
            $install = Get-WowgetInstall $markers $row.Entry.Name
            if (-not $install) { [pscustomobject]($ids + $note + [ordered]@{ status = 'not installed'; latest = $resolved.Version }); continue }
            $installed = Get-WowgetInstallVersion $install
            $missing = @(Get-WowgetMissingFolders $markers $install)
            if ($missing.Count) { [pscustomobject]($ids + $note + [ordered]@{ status = 'missing'; installed = $installed; latest = $resolved.Version; missingFolders = [string[]]$missing }) }
            elseif (Test-WowgetCurrent $install $row.Entry $resolved) { [pscustomobject]($ids + $note + [ordered]@{ status = 'current'; version = $resolved.Version }) }
            else { [pscustomobject]($ids + $note + [ordered]@{ status = 'outdated'; installed = $installed; latest = $resolved.Version }) }
        } catch {
            [pscustomobject]($ids + [ordered]@{ status = 'error'; error = (Get-WowgetErrorMessage $_) })
        }
    }
    return New-WowgetResult ([ordered]@{ addons = @($addons) })
}

function Get-WowgetRowId {
    param([Parameter(Mandatory)]$Row)
    return "$($Row.Entry.Name.ToLowerInvariant())`0$($Row.Target.Name)"
}

# update and install

function ConvertTo-WowgetInstalledEntry {
    param([System.Collections.Specialized.OrderedDictionary]$Ids, [string]$Status, $Installed, $Resolved, $Install)
    $fields = [ordered]@{} + $Ids
    Add-WowgetOptionalField $fields 'note' $Resolved.Note
    $fields['status'] = $Status
    switch ($Status) {
        'updated' { $fields['from'] = Get-WowgetInstallVersion $Install; $fields['to'] = $Installed.Version }
        'repaired' { $fields['version'] = $Installed.Version }
        'installed' { $fields['version'] = $Installed.Version }
    }
    $fields['folders'] = [string[]]$Installed.Folders
    Add-WowgetOptionalField $fields 'leftoverDir' $Installed.LeftoverDir
    return [pscustomobject]$fields
}

# Installs over an existing install, which is a repair when the release is unchanged.
function Update-WowgetRow {
    param([Parameter(Mandatory)]$Ctx, [Parameter(Mandatory)]$Row, [Parameter(Mandatory)]$Resolved, $Install, [System.Collections.Specialized.OrderedDictionary]$Ids)
    $installed = Install-WowgetRow $Ctx $Row $Resolved
    Invoke-WowgetCachePrune $Ctx $Row.Entry.Name
    if (-not $Install) { return ConvertTo-WowgetInstalledEntry $Ids 'installed' $installed $Resolved $null }
    if (Test-WowgetCurrent $Install $Row.Entry $Resolved) { return ConvertTo-WowgetInstalledEntry $Ids 'repaired' $installed $Resolved $Install }
    return ConvertTo-WowgetInstalledEntry $Ids 'updated' $installed $Resolved $Install
}

function Invoke-WowgetUpdate {
    param([Parameter(Mandatory)][hashtable]$Options, [string[]]$Names = @())
    $ctx = New-WowgetContext $Options
    $entries = if ($Names.Count) {
        foreach ($n in $Names) {
            $e = Find-WowgetAddon $ctx.Manifest $n
            if (-not $e) { throw (New-WowgetError 'not_found' "No addon named `"$n`" in the manifest.") }
            $e
        }
    } else { $ctx.Manifest.Addons }
    $entries = @($entries | Group-Object { $_.Name.ToLowerInvariant() } | ForEach-Object { $_.Group[0] })
    if ($Names.Count) {
        foreach ($e in $entries) {
            if (@(Get-WowgetRows $ctx @($e)).Count) { continue }
            $on = (Get-WowgetAddonTargets $ctx.Manifest $e) -join ', '
            throw (New-WowgetError 'usage' "$($e.Name) is not on target $(($ctx.Targets | ForEach-Object Name) -join ', '); it is on $on.")
        }
    }
    $rows = @(Get-WowgetRows $ctx $entries)
    $atPin = @{}
    foreach ($row in $rows) {
        $pinned = Get-WowgetInstalledAtPin $ctx $row
        if ($pinned) { $atPin[(Get-WowgetRowId $row)] = $pinned }
    }
    Resolve-WowgetRows $ctx @($rows | Where-Object { -not $atPin.ContainsKey((Get-WowgetRowId $_)) })
    $addons = foreach ($row in $rows) {
        $ids = [ordered]@{ name = $row.Entry.Name; target = $row.Target.Name }
        $pinned = $atPin[(Get-WowgetRowId $row)]
        if ($pinned) { [pscustomobject]($ids + [ordered]@{ status = 'current'; version = (Get-WowgetInstallVersion $pinned) }); continue }
        try {
            $resolved = Get-WowgetResolved $ctx $row
            $markers = Get-WowgetContextMarkers $ctx $row.Target
            $install = Get-WowgetInstall $markers $row.Entry.Name
            $intact = $install -and @(Get-WowgetMissingFolders $markers $install).Count -eq 0
            if ($intact -and (Test-WowgetCurrent $install $row.Entry $resolved)) {
                $fields = [ordered]@{} + $ids
                Add-WowgetOptionalField $fields 'note' $resolved.Note
                [pscustomobject]($fields + [ordered]@{ status = 'current'; version = $resolved.Version })
                continue
            }
            Update-WowgetRow $ctx $row $resolved $install $ids
        } catch {
            [pscustomobject]($ids + [ordered]@{ status = 'error'; error = (Get-WowgetErrorMessage $_) })
        }
    }
    return New-WowgetResult ([ordered]@{ addons = @($addons) })
}

# Installs every manifest addon without an install and reinstalls those with missing folders; the rest
# are skipped without network access.
function Invoke-WowgetInstall {
    param([Parameter(Mandatory)][hashtable]$Options)
    $ctx = New-WowgetContext $Options
    $rows = @(Get-WowgetRows $ctx $ctx.Manifest.Addons)
    $intact = @{}
    foreach ($row in $rows) {
        $markers = Get-WowgetContextMarkers $ctx $row.Target
        $install = Get-WowgetInstall $markers $row.Entry.Name
        if ($install -and @(Get-WowgetMissingFolders $markers $install).Count -eq 0) { $intact[(Get-WowgetRowId $row)] = $install }
    }
    Resolve-WowgetRows $ctx @($rows | Where-Object { -not $intact.ContainsKey((Get-WowgetRowId $_)) })
    $addons = foreach ($row in $rows) {
        $ids = [ordered]@{ name = $row.Entry.Name; target = $row.Target.Name }
        $skipped = $intact[(Get-WowgetRowId $row)]
        if ($skipped) { [pscustomobject]($ids + [ordered]@{ status = 'skipped'; version = (Get-WowgetInstallVersion $skipped) }); continue }
        try {
            $install = Get-WowgetInstall (Get-WowgetContextMarkers $ctx $row.Target) $row.Entry.Name
            $resolved = Get-WowgetResolved $ctx $row
            Update-WowgetRow $ctx $row $resolved $install $ids
        } catch {
            [pscustomobject]($ids + [ordered]@{ status = 'error'; error = (Get-WowgetErrorMessage $_) })
        }
    }
    return New-WowgetResult ([ordered]@{ addons = @($addons) })
}

# pin, unpin, rollback

function Invoke-WowgetPin {
    param([Parameter(Mandatory)][hashtable]$Options, [Parameter(Mandatory)][string]$Name, $Release = $null)
    if ($null -ne $Release -and "$Release" -eq '') { throw (New-WowgetError 'usage' 'Pin must not be empty.') }
    $read = Read-WowgetManifestText $Options.ManifestPath
    $manifest = $read.Manifest
    $entry = Find-WowgetAddon $manifest $Name
    if (-not $entry) { throw (New-WowgetError 'not_found' "No addon named `"$Name`" in the manifest.") }

    if ($null -eq $Release) {
        $on = @(Get-WowgetAddonTargets $manifest $entry)
        [void](Select-WowgetTargets $manifest $Options.ManifestPath @())
        $located = @(Find-WowgetTargetDirs @($manifest.Targets | Where-Object { $on -ccontains $_.Name }) @(Get-WowgetGameDirs $Options))
        $installs = @(foreach ($t in $located) {
                if ($null -eq $t.Path) { continue }
                $i = Get-WowgetInstall (Get-WowgetTargetMarkers $t.Path) $entry.Name
                if ($i) { [pscustomobject]@{ Target = $t.Name; Install = $i } }
            })
        if ($installs.Count -eq 0) {
            throw (New-WowgetError 'not_found' "$($entry.Name) is not installed; pass a release id to `"wowget pin $($entry.Name) <release>`".")
        }
        if (@($installs | Where-Object { $_.Install.ReleaseId -eq 'unknown' }).Count) {
            throw (New-WowgetError 'usage' "The installed release of $($entry.Name) is not known; pass a release id to `"wowget pin $($entry.Name) <release>`", or run `"wowget update $($entry.Name)`" first.")
        }
        $ids = @($installs | ForEach-Object { $_.Install.ReleaseId } | Select-Object -Unique)
        if ($ids.Count -gt 1) {
            $detail = ($installs | ForEach-Object { "$($_.Target)=$($_.Install.ReleaseId)" }) -join ', '
            throw (New-WowgetError 'conflict' "$($entry.Name) has different releases installed across targets ($detail); pass an explicit release id to `"wowget pin`".")
        }
        $copy = Copy-WowgetAddonEntry $entry
        $copy.Pin = $ids[0]
        [void](Save-WowgetManifest $Options.ManifestPath $read.Text (Set-WowgetManifestAddon $manifest $entry.Name $copy))
        return New-WowgetResult ([ordered]@{ name = $entry.Name; pin = $ids[0]; addons = @() })
    }

    $pinned = Copy-WowgetAddonEntry $entry
    $pinned.Pin = $Release
    $next = Set-WowgetManifestAddon $manifest $entry.Name $pinned
    [void](Assert-WowgetManifestPlanned $Options.ManifestPath $next)
    $ctxOptions = @{} + $Options
    $ctxOptions.Remove('Targets')
    $ctx = New-WowgetContext $ctxOptions
    $rows = foreach ($row in (Get-WowgetRows $ctx @($pinned))) {
        $markers = Get-WowgetContextMarkers $ctx $row.Target
        $install = Get-WowgetInstall $markers $entry.Name
        if ($install -and $install.ReleaseId -ceq $Release -and @(Get-WowgetMissingFolders $markers $install).Count -eq 0) { continue }
        $row
    }
    $rows = @($rows)
    foreach ($row in $rows) { Assert-WowgetTargetDir $row.Target }
    Resolve-WowgetRows $ctx $rows
    $manifestPath = $Options.ManifestPath
    $text = $read.Text
    $done = Invoke-WowgetInstallAll -Ctx $ctx -Name $entry.Name -Rows $rows -Resolve { param($row) Get-WowgetResolved $ctx $row } -Commit {
        [void](Save-WowgetManifest $manifestPath $text $next)
    }
    $addons = foreach ($d in $done) {
        $fields = [ordered]@{ name = $entry.Name; target = $d.Target.Name; releaseId = $d.Installed.ReleaseId; version = $d.Installed.Version; folders = [string[]]$d.Installed.Folders }
        Add-WowgetOptionalField $fields 'leftoverDir' $d.LeftoverDir
        [pscustomobject]$fields
    }
    return New-WowgetResult ([ordered]@{ name = $entry.Name; pin = $Release; addons = @($addons) })
}

function Invoke-WowgetUnpin {
    param([Parameter(Mandatory)][hashtable]$Options, [Parameter(Mandatory)][string]$Name)
    $read = Read-WowgetManifestText $Options.ManifestPath
    $entry = Find-WowgetAddon $read.Manifest $Name
    if (-not $entry) { throw (New-WowgetError 'not_found' "No addon named `"$Name`" in the manifest.") }
    $copy = Copy-WowgetAddonEntry $entry
    $copy.Pin = $null
    [void](Save-WowgetManifest $Options.ManifestPath $read.Text (Set-WowgetManifestAddon $read.Manifest $entry.Name $copy))
    $fields = [ordered]@{ name = $entry.Name }
    if ($null -ne $entry.Pin) { $fields['previousPin'] = $entry.Pin }
    return New-WowgetResult $fields
}

# Reinstalls the release named in each install's marker as "previous", from the cache. The manifest is
# pinned to it when the rollback covers every target of the addon and lands on one release.
function Invoke-WowgetRollback {
    param([Parameter(Mandatory)][hashtable]$Options, [Parameter(Mandatory)][string]$Name)
    $ctx = New-WowgetContext $Options
    $entry = Find-WowgetAddon $ctx.Manifest $Name
    if (-not $entry) { throw (New-WowgetError 'not_found' "No addon named `"$Name`" in the manifest.") }
    $rows = @(Get-WowgetRows $ctx @($entry))
    if ($rows.Count -eq 0) {
        $on = (Get-WowgetAddonTargets $ctx.Manifest $entry) -join ', '
        throw (New-WowgetError 'usage' "$($entry.Name) is not on target $(($ctx.Targets | ForEach-Object Name) -join ', '); it is on $on.")
    }
    $plans = foreach ($row in $rows) {
        Assert-WowgetTargetDir $row.Target
        $install = Get-WowgetInstall (Get-WowgetContextMarkers $ctx $row.Target) $entry.Name
        if (-not $install -or -not $install.Previous) {
            throw (New-WowgetError 'not_found' "$($row.Target.Name): no previous install recorded for $($entry.Name).")
        }
        $p = $install.Previous
        $zip = Get-WowgetCachedZipPath $ctx.CacheDir $entry.Name $p.ReleaseId $p.Filename
        if (-not [System.IO.File]::Exists($zip)) {
            $label = if ($p.AddonVersion) { $p.AddonVersion } else { $p.ReleaseId }
            throw (New-WowgetError 'not_found' "$($row.Target.Name): cached zip for $($entry.Name) $label ($zip) is missing.")
        }
        $resolved = [pscustomobject]@{
            Source = $install.Source; ReleaseId = $p.ReleaseId; Version = $(if ($p.AddonVersion) { $p.AddonVersion } else { $p.ReleaseId })
            Filename = $p.Filename; DownloadUrl = ([System.Uri]::new($zip)).AbsoluteUri; FlavorVerified = $false; LocalPath = $zip
            Sha256 = $p.Sha256; Md5 = $null; AllowedHosts = @(); Note = $null; Folders = $null
        }
        [pscustomobject]@{ Row = $row; Install = $install; Resolved = $resolved }
    }
    $plans = @($plans)
    $releaseIds = @($plans | ForEach-Object { $_.Resolved.ReleaseId } | Select-Object -Unique)
    $coversAll = $rows.Count -eq @(Get-WowgetAddonTargets $ctx.Manifest $entry).Count
    $pinTo = if ($coversAll -and $releaseIds.Count -eq 1) { $releaseIds[0] } else { $null }
    $next = $null
    if ($null -ne $pinTo) {
        $copy = Copy-WowgetAddonEntry $entry
        $copy.Pin = $pinTo
        $next = Set-WowgetManifestAddon $ctx.Manifest $entry.Name $copy
        [void](Assert-WowgetManifestPlanned $Options.ManifestPath $next)
    }
    $byTarget = @{}
    foreach ($plan in $plans) { $byTarget[$plan.Row.Target.Name] = $plan }
    $manifestPath = $Options.ManifestPath
    $text = $ctx.Text
    $done = Invoke-WowgetInstallAll -Ctx $ctx -Name $entry.Name -Rows @($plans | ForEach-Object Row) -What 'rollback' -Resolve { param($row) $byTarget[$row.Target.Name].Resolved } -Commit {
        if ($null -ne $next) { [void](Save-WowgetManifest $manifestPath $text $next) }
    }
    $addons = foreach ($d in $done) {
        $from = Get-WowgetInstallVersion $byTarget[$d.Target.Name].Install
        $fields = [ordered]@{ name = $entry.Name; target = $d.Target.Name; from = $from; to = $d.Installed.Version; releaseId = $d.Installed.ReleaseId; folders = [string[]]$d.Installed.Folders }
        Add-WowgetOptionalField $fields 'leftoverDir' $d.LeftoverDir
        [pscustomobject]$fields
    }
    $result = [ordered]@{ name = $entry.Name; addons = @($addons) }
    if ($null -ne $pinTo) { $result['pinned'] = $pinTo } else { $result['notPinned'] = $(if (-not $coversAll) { 'partial' } else { 'mixed' }) }
    return New-WowgetResult $result
}
