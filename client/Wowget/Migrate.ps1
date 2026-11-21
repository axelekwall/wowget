# The first start after the Bun client (SPEC-POWERSHELL.md, "First start after the Bun client"): the
# TOML import, then markers for the addons the Bun client installed, identified from its download cache.

# The Bun client's state database. It is never read; it only shows that the Bun client ran here.
function Get-WowgetBunStateDbPath {
    param([hashtable]$Env = (Get-WowgetProcessEnv), [string]$Platform = (Get-WowgetPlatform))
    $override = Get-WowgetEnvValue $Env 'WOWGET_STATE_DIR'
    if ($override) { return Join-WowgetPathFor $Platform @((Expand-WowgetHome $override $Env $Platform), 'state.db') }
    if ($Platform -eq 'Windows') { return Join-WowgetPathFor $Platform @((Get-WowgetWindowsAppData $Env $true), 'wowget', 'state.db') }
    return Join-WowgetPathFor $Platform @((Get-WowgetStateDir $Env $Platform), 'state.db')
}

# Written once adoption ran, so it runs by itself only on the first start.
function Get-WowgetMigrationRecordPath {
    param([hashtable]$Env = (Get-WowgetProcessEnv), [string]$Platform = (Get-WowgetPlatform))
    return Join-WowgetPathFor $Platform @((Get-WowgetStateDir $Env $Platform), 'migration.json')
}

# The TOML manifest to convert, or $null: the manifest path itself when it ends in .toml, or
# wowget.toml next to a default manifest path that does not exist.
function Get-WowgetTomlImportPath {
    param([Parameter(Mandatory)][string]$ManifestPath, [bool]$Overridden)
    if ($ManifestPath -match '(?i)\.toml$') { return $ManifestPath }
    if ($Overridden -or (Test-WowgetPath $ManifestPath)) { return $null }
    $toml = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($ManifestPath), 'wowget.toml')
    if (Test-WowgetPath $toml) { return $toml }
    return $null
}

# What the automatic first start has to do: Toml (the file to convert, or $null) and Adopt.
function Get-WowgetMigrationNeed {
    param([Parameter(Mandatory)][string]$ManifestPath, [bool]$Overridden, [hashtable]$Env = (Get-WowgetProcessEnv), [string]$Platform = (Get-WowgetPlatform))
    $toml = Get-WowgetTomlImportPath $ManifestPath $Overridden
    $adopt = $false
    if (-not (Test-WowgetPath (Get-WowgetMigrationRecordPath $Env $Platform))) {
        $adopt = $null -ne $toml -or (Test-WowgetPath (Get-WowgetBunStateDbPath $Env $Platform))
    }
    return [pscustomobject]@{ Toml = $toml; Adopt = $adopt }
}

# The Bun client's cache directory name for a string: "/", "\", ":" and NUL replaced by "_".
function Get-WowgetBunSegment {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
    $cleaned = $Value -replace '[/\\:\x00]', '_'
    if ($cleaned -eq '' -or $cleaned -eq '.' -or $cleaned -eq '..') { return '_' }
    return $cleaned
}

# Cached zips of an addon, from the Bun client's cache directory and this client's: Path, Dir (the
# release directory name), Filename and Time (last write, UTC).
function Get-WowgetCachedReleases {
    param([Parameter(Mandatory)][string]$CacheDir, [Parameter(Mandatory)][string]$Addon)
    $dirs = @(
        [System.IO.Path]::Combine($CacheDir, (Get-WowgetBunSegment $Addon.ToLowerInvariant()))
        Get-WowgetAddonCacheDir $CacheDir $Addon
    ) | Select-Object -Unique
    $found = foreach ($addonDir in $dirs) {
        if ([System.IO.Path]::GetFileName($addonDir).StartsWith('.') -or -not [System.IO.Directory]::Exists($addonDir)) { continue }
        foreach ($releaseDir in [System.IO.Directory]::GetDirectories($addonDir)) {
            foreach ($zip in [System.IO.Directory]::GetFiles($releaseDir, '*.zip')) {
                [pscustomobject]@{
                    Path = $zip; Dir = [System.IO.Path]::GetFileName($releaseDir); Filename = [System.IO.Path]::GetFileName($zip)
                    Time = [System.IO.File]::GetLastWriteTimeUtc($zip)
                }
            }
        }
    }
    return @($found | Sort-Object Time -Descending)
}

# The addon folders a zip produces and the SHA-256 of every file in them, or $null for a zip that
# cannot be read. Extracted in a temporary directory under the cache.
function Get-WowgetZipContents {
    param([Parameter(Mandatory)][string]$Zip, [Parameter(Mandatory)][string]$CacheDir)
    [void](New-WowgetDirectory $CacheDir)
    $tmp = New-WowgetTempDirectory $CacheDir '.wowget-migrate-'
    try {
        $folders = @(Expand-WowgetAddons $Zip $tmp)
        $entries = foreach ($folder in $folders) {
            $files = foreach ($file in [System.IO.Directory]::GetFiles($folder.Path, '*', [System.IO.SearchOption]::AllDirectories)) {
                [pscustomobject]@{ Path = [System.IO.Path]::GetRelativePath($folder.Path, $file); Sha256 = (Get-WowgetFileHash $file) }
            }
            [pscustomobject]@{ Name = $folder.Name; Files = @($files) }
        }
        return [pscustomobject]@{ Folders = @($entries); Sha256 = (Get-WowgetFileHash $Zip) }
    } catch {
        return $null
    } finally {
        [void](Remove-WowgetBestEffort $tmp)
    }
}

# Whether every folder of $Contents is in the AddOns directory without a marker, with every file the
# zip extracts into it present and identical. Returns the folder names as they are on disk, or $null.
function Find-WowgetInstalledContents {
    param([Parameter(Mandatory)]$Contents, [Parameter(Mandatory)][string]$TargetDir, [Parameter(Mandatory)][hashtable]$Markers)
    $names = foreach ($folder in $Contents.Folders) {
        $entry = $Markers[$folder.Name]
        if ($null -eq $entry -or $entry.Status -eq 'ok') { return $null }
        foreach ($file in $folder.Files) {
            $path = [System.IO.Path]::Combine($TargetDir, $entry.Folder, $file.Path)
            if (-not [System.IO.File]::Exists($path) -or (Get-WowgetFileHash $path) -ne $file.Sha256) { return $null }
        }
        $entry.Folder
    }
    return , [string[]]@($names)
}

# Folders of $Names present in the AddOns directory without a marker, as they are on disk.
function Get-WowgetUnmarkedFolders {
    param([string[]]$Names = @(), [Parameter(Mandatory)][hashtable]$Markers)
    $present = foreach ($name in $Names) {
        $entry = $Markers[$name]
        if ($null -ne $entry -and $entry.Status -ne 'ok') { $entry.Folder }
    }
    return , [string[]]@($present | Select-Object -Unique)
}

# Recovers release ids of cached zips through POST /v1/resolve: a result for the release directory name,
# the manifest pin or the latest release whose filename and checksum are the zip's gives the id. The
# directory name is not the id when the Bun client had to replace characters in it, which the latest
# release often still covers. Fills ReleaseId and Version on each candidate it can; the rest keep $null.
function Resolve-WowgetCachedReleaseIds {
    param([Parameter(Mandatory)][string]$ApiUrl, [object[]]$Candidates = @())
    $items = [System.Collections.Generic.List[object]]::new()
    foreach ($c in $Candidates) {
        $pins = @($c.Release.Dir)
        if ($c.Entry.Pin -and $c.Entry.Pin -cne $c.Release.Dir) { $pins += $c.Entry.Pin }
        if (-not $c.Entry.Pin) { $pins += $null }
        $c | Add-Member -NotePropertyName Items -NotePropertyValue @(foreach ($pin in $pins) {
                [pscustomobject]@{ source = $c.Entry.Source; flavor = $c.Flavor; prerelease = $c.Entry.Prerelease; pin = $pin }
            }) -Force
        foreach ($item in $c.Items) { $items.Add($item) }
    }
    if ($items.Count -eq 0 -or $ApiUrl -eq 'off') { return }
    $results = Invoke-WowgetResolve -ApiUrl $ApiUrl -Items $items.ToArray()
    foreach ($c in $Candidates) {
        foreach ($item in $c.Items) {
            $r = $results[(Get-WowgetResolveKey $item)]
            if ($null -eq $r -or $r -is [System.Exception] -or $r.Filename -cne $c.Release.Filename) { continue }
            # A filename alone does not tell releases apart when assets carry no version in their name.
            if (-not $r.Sha256 -and -not $r.Md5) { continue }
            if ($r.Sha256 -and $r.Sha256.ToLowerInvariant() -ne $c.Sha256) { continue }
            if ($r.Md5 -and $r.Md5.ToLowerInvariant() -ne (Get-WowgetFileHash $c.Release.Path 'MD5')) { continue }
            $c.ReleaseId = $r.ReleaseId
            $c.Version = $r.Version
            break
        }
    }
}

# Moves a cached zip whose release id was recovered to the path this client looks it up at, when the
# Bun client's directory name for it differs. Returns where the zip is now.
function Move-WowgetCachedRelease {
    param([Parameter(Mandatory)][string]$CacheDir, [Parameter(Mandatory)][string]$Addon, [Parameter(Mandatory)]$Candidate)
    $want = Get-WowgetCachedZipPath $CacheDir $Addon $Candidate.ReleaseId $Candidate.Release.Filename
    $from = $Candidate.Release.Path
    if ($want -eq $from -or [System.IO.File]::Exists($want)) { return $want }
    try {
        [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($want))
        [System.IO.File]::Move($from, $want)
        $oldDir = [System.IO.Path]::GetDirectoryName($from)
        if (@([System.IO.Directory]::GetFileSystemEntries($oldDir)).Count -eq 0) { [void](Remove-WowgetBestEffort $oldDir) }
        return $want
    } catch {
        return $from
    }
}

# Writes markers for the manifest addons installed on each target on this machine without one.
function Invoke-WowgetAdoption {
    param([Parameter(Mandatory)][hashtable]$Options, [Parameter(Mandatory)][string]$ManifestPath)
    $env = Get-WowgetOptionEnv $Options
    $platform = Get-WowgetOptionPlatform $Options
    $cacheDir = Get-WowgetOption $Options 'CacheDir' (Get-WowgetCacheDir $env $platform)
    $apiUrl = Get-WowgetOption $Options 'ApiUrl' (Get-WowgetApiUrl $env)
    $manifest = Read-WowgetManifest $ManifestPath
    $gameDirs = @(Get-WowgetGameDirs $Options)
    $targets = @(Find-WowgetTargetDirs $manifest.Targets $gameDirs | Where-Object { $null -ne $_.Path -and [System.IO.Directory]::Exists($_.Path) })
    $registry = $null
    try {
        $registry = Get-WowgetRegistry -ApiUrl $apiUrl -CacheDir $cacheDir
        if ($registry.Stale) { Send-WowgetEvent $Options @{ type = 'registry:stale'; message = $registry.Stale } }
    } catch {
        $registry = $null
    }

    $contentsByZip = @{}
    $contentsOf = {
        param($release)
        if (-not $contentsByZip.ContainsKey($release.Path)) { $contentsByZip[$release.Path] = Get-WowgetZipContents $release.Path $cacheDir }
        $contentsByZip[$release.Path]
    }
    $adopted = [System.Collections.Generic.List[object]]::new()
    $skipped = [System.Collections.Generic.List[object]]::new()
    $conflicts = [System.Collections.Generic.List[object]]::new()
    $plans = [System.Collections.Generic.List[object]]::new()

    foreach ($target in (Get-WowgetSortedByName $targets)) {
        $markers = Get-WowgetTargetMarkers $target.Path
        $entries = @(Get-WowgetSortedByName @($manifest.Addons | Where-Object { (Get-WowgetAddonTargets $manifest $_) -ccontains $target.Name }))
        $targetPlans = [System.Collections.Generic.List[object]]::new()
        foreach ($entry in $entries) {
            if (Get-WowgetInstall $markers $entry.Name) { continue }
            $releases = @(Get-WowgetCachedReleases $cacheDir $entry.Name)
            $hits = @(foreach ($release in $releases) {
                    $contents = & $contentsOf $release
                    if ($null -eq $contents) { continue }
                    $folders = Find-WowgetInstalledContents $contents $target.Path $markers
                    if ($null -ne $folders) { [pscustomobject]@{ Release = $release; Contents = $contents; Folders = $folders } }
                })
            # A release that only adds files to an older one matches where the older one is installed too;
            # the candidate whose files include every other match's is the installed one.
            if ($hits.Count -gt 1) {
                $sets = @($hits | ForEach-Object { , [string[]]@($_.Contents.Folders | ForEach-Object { $f = $_.Name; $_.Files | ForEach-Object { "$f/$($_.Path)" } }) })
                $widest = @(for ($i = 0; $i -lt $hits.Count; $i++) {
                        $mine = [System.Collections.Generic.HashSet[string]]::new([string[]]$sets[$i])
                        $covers = $true
                        for ($j = 0; $j -lt $hits.Count; $j++) {
                            if ($j -ne $i -and ($sets[$j].Count -ge $sets[$i].Count -or -not $mine.IsSupersetOf([string[]]$sets[$j]))) { $covers = $false }
                        }
                        if ($covers) { $hits[$i] }
                    })
                if ($widest.Count -eq 1) { $hits = $widest }
            }
            if ($hits.Count -eq 1) {
                $m = $hits[0]
                $others = @($releases | Where-Object { $_.Path -ne $m.Release.Path -and $null -ne (& $contentsOf $_) })
                $previous = $null
                if ($others.Count) { $previous = [pscustomobject]@{ Entry = $entry; Flavor = $target.Flavor; Release = $others[0]; Sha256 = (& $contentsOf $others[0]).Sha256; ReleaseId = $null; Version = $null } }
                $targetPlans.Add([pscustomobject]@{
                        Entry = $entry; Target = $target; How = 'cache'; Folders = $m.Folders
                        Current = [pscustomobject]@{ Entry = $entry; Flavor = $target.Flavor; Release = $m.Release; Sha256 = $m.Contents.Sha256; ReleaseId = $null; Version = $null }
                        Previous = $previous
                    })
                continue
            }
            # Without one identified archive: the folders the registry names, else those of the newest
            # cached zip whose folders are all here.
            $folders = [string[]]@()
            if ($registry) {
                $key = Get-WowgetSourceKey $entry.Source
                $listed = $registry.Entries | Where-Object { (Get-WowgetSourceKey $_.Source) -eq $key } | Select-Object -First 1
                if ($listed) { $folders = Get-WowgetUnmarkedFolders $listed.Folders $markers }
            }
            if ($folders.Count -eq 0) {
                foreach ($release in $releases) {
                    $contents = & $contentsOf $release
                    if ($null -eq $contents) { continue }
                    $names = [string[]]@($contents.Folders | ForEach-Object Name)
                    $present = Get-WowgetUnmarkedFolders $names $markers
                    if ($present.Count -eq $names.Count) { $folders = $present; break }
                }
            }
            if ($folders.Count -eq 0) {
                $why = if ($hits.Count -gt 1) { 'several cached releases match the installed files, and no folders are known otherwise' } else { 'no installed folders found' }
                $skipped.Add([pscustomobject][ordered]@{ name = $entry.Name; target = $target.Name; reason = $why })
                continue
            }
            $targetPlans.Add([pscustomobject]@{ Entry = $entry; Target = $target; How = 'fallback'; Folders = $folders; Current = $null; Previous = $null })
        }

        # A folder two addons would claim stays without a marker.
        $claims = @{}
        foreach ($plan in $targetPlans) {
            foreach ($f in $plan.Folders) {
                $key = $f.ToLowerInvariant()
                if (-not $claims.ContainsKey($key)) { $claims[$key] = [System.Collections.Generic.List[string]]::new() }
                $claims[$key].Add($plan.Entry.Name)
            }
        }
        foreach ($key in @($claims.Keys | Sort-Object)) {
            if ($claims[$key].Count -lt 2) { continue }
            $conflicts.Add([pscustomobject][ordered]@{ target = $target.Name; folder = $markers[$key].Folder; addons = $claims[$key].ToArray() })
        }
        foreach ($plan in $targetPlans) {
            $kept = [string[]]@($plan.Folders | Where-Object { $claims[$_.ToLowerInvariant()].Count -lt 2 })
            if ($kept.Count -eq 0) {
                $skipped.Add([pscustomobject][ordered]@{ name = $plan.Entry.Name; target = $target.Name; reason = 'its folders are claimed by another addon too' })
                continue
            }
            if ($kept.Count -ne @($plan.Folders).Count -and $plan.How -eq 'cache') { $plan.How = 'fallback'; $plan.Current = $null; $plan.Previous = $null }
            $plan.Folders = $kept
            $plans.Add($plan)
        }
    }

    # url: release ids are the zip's SHA-256; github: and wowi: ones come from the service.
    $candidates = @(@(foreach ($plan in $plans) { $plan.Current; $plan.Previous }) | Where-Object { $null -ne $_ })
    foreach ($c in $candidates) {
        if ($c.Entry.Source.StartsWith('url:')) { $c.ReleaseId = $c.Sha256; $c.Version = $c.Sha256.Substring(0, 12) }
    }
    try {
        Resolve-WowgetCachedReleaseIds -ApiUrl $apiUrl -Candidates @($candidates | Where-Object { -not $_.Entry.Source.StartsWith('url:') })
    } catch {
        Send-WowgetEvent $Options @{ type = 'migrate:resolve-failed'; message = "release ids could not be recovered ($(Get-WowgetErrorMessage $_))" }
    }

    foreach ($plan in $plans) {
        $entry = $plan.Entry
        $releaseId = 'unknown'
        $version = $null
        $filename = 'unknown'
        $sha = $null
        $previous = $null
        if ($plan.Current) {
            $filename = $plan.Current.Release.Filename
            $sha = $plan.Current.Sha256
            if ($plan.Current.ReleaseId) {
                $releaseId = $plan.Current.ReleaseId
                $version = $plan.Current.Version
                [void](Move-WowgetCachedRelease $cacheDir $entry.Name $plan.Current)
            }
            # rollback finds the previous zip by its release id, so a previous release whose id stays
            # unknown is not recorded.
            $p = $plan.Previous
            if ($p -and $p.ReleaseId) {
                [void](Move-WowgetCachedRelease $cacheDir $entry.Name $p)
                $previous = [pscustomobject]@{ ReleaseId = $p.ReleaseId; AddonVersion = $p.Version; Filename = $p.Release.Filename; Sha256 = $p.Sha256 }
            }
        }
        $marker = New-WowgetMarker -Addon $entry.Name -Source $entry.Source -ReleaseId $releaseId -AddonVersion $version -Filename $filename `
            -Sha256 $sha -Folders $plan.Folders -Previous $previous
        foreach ($folder in $plan.Folders) { Write-WowgetMarker ([System.IO.Path]::Combine($plan.Target.Path, $folder)) $marker }
        $adopted.Add([pscustomobject][ordered]@{
                name = $entry.Name; target = $plan.Target.Name; how = $plan.How; releaseId = $releaseId; version = $version
                folders = [string[]]$plan.Folders; previous = $(if ($previous) { $previous.ReleaseId } else { $null })
            })
    }

    $unmarked = foreach ($target in (Get-WowgetSortedByName $targets)) {
        $markers = Get-WowgetTargetMarkers $target.Path
        $names = [string[]]@($markers.Values | Where-Object { $_.Status -ne 'ok' } | ForEach-Object Folder)
        [Array]::Sort($names, [System.StringComparer]::OrdinalIgnoreCase)
        if ($names.Count) { [pscustomobject][ordered]@{ target = $target.Name; folders = $names } }
    }
    return [pscustomobject]@{ Adopted = $adopted.ToArray(); Skipped = $skipped.ToArray(); Conflicts = $conflicts.ToArray(); Unmarked = @($unmarked) }
}

# migrate: the TOML import when there is a TOML manifest to convert, then adoption, recorded so that
# the automatic first start does not run it again. Options also takes ManifestOverridden.
function Invoke-WowgetMigrate {
    param([Parameter(Mandatory)][hashtable]$Options, [switch]$SkipAdoption)
    $env = Get-WowgetOptionEnv $Options
    $platform = Get-WowgetOptionPlatform $Options
    $manifestPath = $Options.ManifestPath
    $overridden = [bool](Get-WowgetOption $Options 'ManifestOverridden' $false)
    $converted = $null
    $notes = [System.Collections.Generic.List[string]]::new()
    $toml = Get-WowgetTomlImportPath $manifestPath $overridden
    if ($null -ne $toml) {
        $conversion = Convert-WowgetTomlManifestFile $toml -Platform $platform -Named:($overridden -and $manifestPath -match '(?i)\.toml$')
        foreach ($n in $conversion.Notes) { $notes.Add($n) }
        $manifestPath = $conversion.ManifestPath
        $converted = [pscustomobject][ordered]@{ from = $conversion.From; to = $conversion.JsonPath; written = $conversion.Converted }
    }
    $fields = [ordered]@{ manifestPath = $manifestPath; converted = $converted; notes = $notes.ToArray() }
    if ($SkipAdoption) { return New-WowgetResult $fields }
    if (-not [System.IO.File]::Exists($manifestPath)) {
        throw (New-WowgetError 'not_found' "Manifest not found at $manifestPath. Run `"wowget init`" first.")
    }
    $result = Invoke-WowgetAdoption -Options $Options -ManifestPath $manifestPath
    $record = Get-WowgetMigrationRecordPath $env $platform
    [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($record))
    $stamp = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [System.Globalization.CultureInfo]::InvariantCulture)
    Write-WowgetFileAtomic $record ((ConvertTo-WowgetJsonText ([ordered]@{ version = 1; adoptedAt = $stamp })) + "`n")
    $fields['adopted'] = $result.Adopted
    $fields['skipped'] = $result.Skipped
    $fields['conflicts'] = $result.Conflicts
    $fields['unmarked'] = $result.Unmarked
    return New-WowgetResult $fields
}
