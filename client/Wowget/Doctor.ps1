# doctor: target, TOC interface, marker and cache checks, and the portable_target hints.

$script:FolderProducts = @{ '_forever_' = 'wowf'; '_classic_era_' = 'wow_classic_era'; '_classic_' = 'wow_classic'; '_retail_' = 'wow' }

# A client build version ("1.15.7.60000", "11.1.5.59000") as an Interface number, or $null.
function ConvertTo-WowgetInterfaceNumber {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Version)
    if ($Version.Trim() -notmatch '^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$') { return $null }
    $major = [long]$Matches[1]; $minor = [long]$Matches[2]; $patch = [long]$Matches[3]
    if (($major -eq 1 -and $minor -eq 16) -or ($major -eq 16 -and $minor -eq 0)) { return 16000 + $patch }
    return $major * 10000 + $minor * 100 + $patch
}

# Battle.net's .build.info: product code to the active Version and Interface number.
function ConvertFrom-WowgetBuildInfo {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $out = @{}
    $lines = @($Text -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
    if ($lines.Count -lt 2) { return $out }
    $headers = @($lines[0].Split('|') | ForEach-Object { $_.Split('!')[0].Trim().ToLowerInvariant() })
    $active = [array]::IndexOf($headers, 'active')
    $versionAt = [array]::IndexOf($headers, 'version')
    $productAt = [array]::IndexOf($headers, 'product')
    if ($versionAt -lt 0 -or $productAt -lt 0) { return $out }
    foreach ($line in $lines[1..($lines.Count - 1)]) {
        $cols = $line.Split('|')
        if ($active -ge 0 -and ($cols.Count -le $active -or $cols[$active].Trim() -ne '1')) { continue }
        if ($cols.Count -le [Math]::Max($versionAt, $productAt)) { continue }
        $product = $cols[$productAt].Trim()
        $version = $cols[$versionAt].Trim()
        if (-not $product -or -not $version) { continue }
        $out[$product] = [pscustomobject]@{ Version = $version; Interface = (ConvertTo-WowgetInterfaceNumber $version) }
    }
    return $out
}

# The client build of the version folder above <versionDir>/Interface/AddOns, from .build.info.
function Get-WowgetClientBuild {
    param([Parameter(Mandatory)][string]$AddonsDir)
    $versionDir = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($AddonsDir, '..', '..'))
    $gameDir = [System.IO.Path]::GetDirectoryName($versionDir)
    $product = $null
    try {
        $lines = @(([System.IO.File]::ReadAllText([System.IO.Path]::Combine($versionDir, '.flavor.info')) -split "`r?`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        if ($lines.Count -gt 1) { $product = $lines[1] }
    } catch {
        $product = $null
    }
    if (-not $product) { $product = $script:FolderProducts[[System.IO.Path]::GetFileName($versionDir)] }
    if (-not $product -or -not $gameDir) { return $null }
    try { $info = ConvertFrom-WowgetBuildInfo ([System.IO.File]::ReadAllText([System.IO.Path]::Combine($gameDir, '.build.info'))) } catch { return $null }
    return $info[$product]
}

# The TOC suffixes that count for a flavor: its own, its family's, and unsuffixed.
function Get-WowgetFlavorSuffixes {
    param([Parameter(Mandatory)][string]$Flavor)
    return @(@('') + @($script:OwnSuffixes[$Flavor]) + @($script:FamilySuffixes[$Flavor]))
}

# The Interface numbers of the flavor's range a folder's TOCs list for it, sorted.
function Get-WowgetFolderInterfaces {
    param([Parameter(Mandatory)][string]$Dir, [Parameter(Mandatory)][string]$Flavor)
    $name = [System.IO.Path]::GetFileName($Dir.TrimEnd('\', '/'))
    $allowed = @(Get-WowgetFlavorSuffixes $Flavor | ForEach-Object { $_.ToLowerInvariant() })
    $found = [System.Collections.Generic.SortedSet[long]]::new()
    foreach ($file in (Get-WowgetAddonTocs $Dir)) {
        $suffix = Get-WowgetTocSuffix $file $name
        if ($null -eq $suffix -or $allowed -notcontains $suffix.ToLowerInvariant()) { continue }
        $toc = ConvertFrom-WowgetToc ([System.IO.File]::ReadAllText([System.IO.Path]::Combine($Dir, $file)))
        foreach ($n in $toc.Interface) { if ((Test-WowgetInterfaceFlavor $n $Flavor) -eq 'yes') { [void]$found.Add($n) } }
        foreach ($key in $toc.Fields.Keys) {
            if ($key -notmatch '^(?i)interface-(.+)$' -or $allowed -notcontains $Matches[1].ToLowerInvariant()) { continue }
            foreach ($n in (ConvertFrom-WowgetInterfaceList $toc.Fields[$key])) { if ((Test-WowgetInterfaceFlavor $n $Flavor) -eq 'yes') { [void]$found.Add($n) } }
        }
    }
    return , [long[]]@($found)
}

function New-WowgetIssue {
    param([string]$Kind, [string]$Target, [string]$Addon, [string]$Path, [string[]]$Folders, [string]$Message)
    $fields = [ordered]@{ kind = $Kind }
    Add-WowgetOptionalField $fields 'target' $Target
    Add-WowgetOptionalField $fields 'addon' $Addon
    Add-WowgetOptionalField $fields 'path' $Path
    if ($Folders) { $fields['folders'] = $Folders }
    $fields['message'] = $Message
    return [pscustomobject]$fields
}

function Invoke-WowgetDoctor {
    param([Parameter(Mandatory)][hashtable]$Options, [switch]$Clean)
    $loaded = Read-WowgetLoaded $Options
    $env = Get-WowgetOptionEnv $Options
    $cacheDir = Get-WowgetOption $Options 'CacheDir' (Get-WowgetCacheDir $env (Get-WowgetOptionPlatform $Options))
    $manifest = $loaded.Manifest
    $reports = [System.Collections.Generic.List[object]]::new()
    $issues = [System.Collections.Generic.List[object]]::new()
    $hints = [System.Collections.Generic.List[object]]::new()
    $cleaned = [System.Collections.Generic.List[string]]::new()

    foreach ($target in $loaded.Targets) {
        $exists = [System.IO.Directory]::Exists($target.Path)
        $build = Get-WowgetClientBuild $target.Path
        $report = [ordered]@{ name = $target.Name; flavor = $target.Flavor; path = $target.Path; exists = $exists }
        if ($build) { $report['clientVersion'] = $build.Version; if ($null -ne $build.Interface) { $report['clientInterface'] = $build.Interface } }
        $reports.Add([pscustomobject]$report)
        $named = Find-WowgetTarget $manifest $target.Name
        if ($null -ne $named.Path) {
            $check = Test-WowgetPortable $named $manifest.Targets $loaded.GameDirs $Options
            if ($check.Folder) {
                $hints.Add([pscustomobject][ordered]@{
                        kind = 'portable_target'; target = $target.Name; folder = $check.Folder
                        message = "$($target.Name): can be written as folder $($check.Folder), so the manifest also works on machines with the game elsewhere; run `"wowget target portable $($target.Name)`"."
                    })
            }
        }
        if (-not $exists) {
            $issues.Add((New-WowgetIssue 'missing_target_dir' $target.Name -Path $target.Path -Message "$($target.Name): AddOns directory $($target.Path) does not exist."))
            continue
        }

        foreach ($dir in [System.IO.Directory]::GetDirectories($target.Path)) {
            $name = [System.IO.Path]::GetFileName($dir)
            if (-not $name.StartsWith('.wowget-old-') -and -not $name.StartsWith('.wowget-tmp-')) { continue }
            if ($Clean -and (Remove-WowgetBestEffort $dir)) { $cleaned.Add($dir); continue }
            $issues.Add((New-WowgetIssue 'leftover_temp_dir' $target.Name -Path $dir -Message "$($target.Name): leftover temporary directory $dir."))
        }

        $markers = Get-WowgetTargetMarkers $target.Path
        foreach ($entry in ($markers.Values | Where-Object Status -EQ 'invalid' | Sort-Object Folder)) {
            $path = [System.IO.Path]::Combine($target.Path, $entry.Folder, $script:MarkerFile)
            $issues.Add((New-WowgetIssue 'invalid_marker' $target.Name -Path $path -Message "$($target.Name): $path is not a valid wowget marker; the folder counts as unmanaged."))
        }

        $on = @(Get-WowgetSortedByName @($manifest.Addons | Where-Object { (Get-WowgetAddonTargets $manifest $_) -ccontains $target.Name }))
        foreach ($markedName in (Get-WowgetLowerSorted @(Get-WowgetMarkedAddons $markers))) {
            if (Find-WowgetAddon ([pscustomobject]@{ Addons = $on }) $markedName) { continue }
            $folders = Get-WowgetLowerSorted @($markers.Values | Where-Object { $_.Status -eq 'ok' -and $_.Marker.Addon -eq $markedName } | ForEach-Object Folder)
            $issues.Add((New-WowgetIssue 'orphan_marker' $target.Name $markedName -Folders $folders -Message "$($target.Name): folders $($folders -join ', ') belong to $markedName, which the manifest does not have on this target; run `"wowget remove $markedName -t $($target.Name)`" to delete them."))
        }

        foreach ($entry in $on) {
            $install = Get-WowgetInstall $markers $entry.Name
            if (-not $install) { continue }
            # Folders of one install carry the same marker; differing ones come from an interrupted or hand-made change.
            $own = @($markers.Values | Where-Object { $_.Status -eq 'ok' -and $_.Marker.Addon -eq $entry.Name })
            $shapes = @($own | ForEach-Object { "$($_.Marker.ReleaseId)`0$($_.Marker.Source)`0$((@($_.Marker.Folders) | Sort-Object) -join '/')" } | Select-Object -Unique)
            if ($shapes.Count -gt 1) {
                $issues.Add((New-WowgetIssue 'marker_mismatch' $target.Name $entry.Name -Folders (Get-WowgetLowerSorted @($own | ForEach-Object Folder)) -Message "$($target.Name) ($($entry.Name)): its folders carry different markers; run `"wowget update $($entry.Name) --force`" to reinstall it."))
            }
            if ($install.ReleaseId -ne 'unknown') {
                $zip = Get-WowgetCachedZipPath $cacheDir $entry.Name $install.ReleaseId $install.Filename
                if (-not [System.IO.File]::Exists($zip)) {
                    $issues.Add((New-WowgetIssue 'missing_cached_zip' $target.Name $entry.Name -Path $zip -Message "$($target.Name) ($($entry.Name)): cached zip $zip is missing."))
                }
            }
            $missing = @(Get-WowgetMissingFolders $markers $install)
            foreach ($folder in $install.Folders) {
                if ($missing -contains $folder) { continue }
                $folderDir = [System.IO.Path]::Combine($target.Path, $markers[$folder].Folder)
                $support = Test-WowgetFolderFlavor $folderDir $target.Flavor
                if ($support -eq 'no') {
                    $issues.Add((New-WowgetIssue 'flavor_mismatch' $target.Name $entry.Name -Path $folderDir -Message "$($target.Name) ($($entry.Name)): folder $folder has no TOC for flavor `"$($target.Flavor)`"."))
                } elseif ($build -and $null -ne $build.Interface) {
                    $ifaces = Get-WowgetFolderInterfaces $folderDir $target.Flavor
                    if ($ifaces.Count -and $ifaces -notcontains $build.Interface) {
                        $issues.Add((New-WowgetIssue 'interface_drift' $target.Name $entry.Name -Path $folderDir -Message "$($target.Name) ($($entry.Name)): folder $folder lists Interface $($ifaces -join ', '), but client is $($build.Interface) ($($build.Version))."))
                    }
                }
            }
            if ($missing.Count) {
                $issues.Add((New-WowgetIssue 'missing_folders' $target.Name $entry.Name -Message "$($target.Name) ($($entry.Name)): missing folders $($missing -join ', ')."))
            }
        }
    }

    # Release directories no marker on a target on this machine names, as current or previous.
    $kept = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($t in $loaded.All) {
        if ($null -eq $t.Path) { continue }
        foreach ($m in (Get-WowgetTargetMarkers $t.Path).Values) {
            if ($m.Status -ne 'ok') { continue }
            [void]$kept.Add([System.IO.Path]::GetDirectoryName((Get-WowgetCachedZipPath $cacheDir $m.Marker.Addon $m.Marker.ReleaseId $m.Marker.Filename)))
            $p = $m.Marker.Previous
            if ($p) { [void]$kept.Add([System.IO.Path]::GetDirectoryName((Get-WowgetCachedZipPath $cacheDir $m.Marker.Addon $p.ReleaseId $p.Filename))) }
        }
    }
    $stale = @()
    if ([System.IO.Directory]::Exists($cacheDir)) {
        # Dot entries are not addon caches.
        $stale = foreach ($addonDir in [System.IO.Directory]::GetDirectories($cacheDir)) {
            if ([System.IO.Path]::GetFileName($addonDir).StartsWith('.')) { continue }
            foreach ($rel in [System.IO.Directory]::GetDirectories($addonDir)) { if (-not $kept.Contains($rel)) { $rel } }
        }
    }
    foreach ($dir in (@($stale) | Sort-Object)) {
        if ($Clean -and (Remove-WowgetBestEffort $dir)) { $cleaned.Add($dir); continue }
        $issues.Add((New-WowgetIssue 'stale_cache' -Path $dir -Message "cache: unreferenced release directory $dir."))
    }

    return New-WowgetResult ([ordered]@{ targets = $reports.ToArray(); issues = $issues.ToArray(); hints = $hints.ToArray(); cleaned = $cleaned.ToArray() })
}
