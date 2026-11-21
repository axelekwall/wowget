# reconcile: addon folders without a marker, grouped and matched to a source from their TOC fields or
# the registry's folder lists. Matching runs on this machine only; folder names are never sent anywhere.

$script:GithubSlug = '^([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+)$'
$script:GithubUrl = '(?i)(?:https?://|git@)?github\.com[:/]([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+)'

function ConvertFrom-WowgetGithubRef {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Raw, [bool]$AllowBareSlug)
    $trimmed = $Raw.Trim().TrimEnd('/')
    $m = [regex]::Match($trimmed, $script:GithubUrl)
    if (-not $m.Success -and $AllowBareSlug) { $m = [regex]::Match($trimmed, $script:GithubSlug) }
    if (-not $m.Success) { return $null }
    $candidate = "github:$($m.Groups[1].Value)/$($m.Groups[2].Value -replace '(?i)\.git$', '')"
    try { [void](ConvertFrom-WowgetSource $candidate) } catch { return $null }
    return $candidate
}

function Get-WowgetTocField {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Fields, [Parameter(Mandatory)][string]$Name)
    foreach ($k in $Fields.Keys) {
        if ($k -eq $Name -and ([string]$Fields[$k]).Trim() -ne '') { return ([string]$Fields[$k]).Trim() }
    }
    return $null
}

# A github: or wowi: source named by TOC fields, or $null.
function Get-WowgetTocSource {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Fields)
    foreach ($key in 'X-GitHub', 'X-GitHub-Repo', 'X-Repository') {
        $value = Get-WowgetTocField $Fields $key
        if ($value) { $gh = ConvertFrom-WowgetGithubRef $value $true; if ($gh) { return $gh } }
    }
    foreach ($key in 'X-Website', 'X-Curse-Repository-ID') {
        $value = Get-WowgetTocField $Fields $key
        if ($value) { $gh = ConvertFrom-WowgetGithubRef $value $false; if ($gh) { return $gh } }
    }
    $wowi = Get-WowgetTocField $Fields 'X-WoWI-ID'
    if ($wowi -and $wowi -match '^[1-9][0-9]*$') { return "wowi:$wowi" }
    return $null
}

function Get-WowgetFolderMeta {
    param([Parameter(Mandatory)][string]$TargetDir, [Parameter(Mandatory)][string]$Folder)
    $dir = [System.IO.Path]::Combine($TargetDir, $Folder)
    $version = $null
    $source = $null
    $curse = $false
    $deps = [System.Collections.Generic.List[string]]::new()
    foreach ($file in (Get-WowgetAddonTocs $dir)) {
        $toc = ConvertFrom-WowgetToc ([System.IO.File]::ReadAllText([System.IO.Path]::Combine($dir, $file)))
        if (-not $version -and $toc.Version) { $version = $toc.Version }
        if (-not $source) { $source = Get-WowgetTocSource $toc.Fields }
        if (@($toc.Fields.Keys | Where-Object { $_ -like 'X-Curse-*' }).Count) { $curse = $true }
        foreach ($key in 'Dependencies', 'RequiredDeps') {
            $value = Get-WowgetTocField $toc.Fields $key
            if (-not $value) { continue }
            foreach ($part in ($value -split '[,\s]+')) { if ($part -and -not $deps.Contains($part)) { $deps.Add($part) } }
        }
    }
    return [pscustomobject]@{ Folder = $Folder; Version = $version; Source = $source; Curse = $curse; Deps = $deps.ToArray(); RegistryName = $null }
}

# Folder name (lower-case) to the registry entry listing it, leaving out folders that several entries list.
function Get-WowgetRegistryFolderMap {
    param([object[]]$Entries = @())
    $owners = @{}
    foreach ($entry in $Entries) {
        foreach ($folder in $entry.Folders) {
            $key = $folder.ToLowerInvariant()
            if (-not $owners.ContainsKey($key)) { $owners[$key] = $entry }
            elseif ($null -ne $owners[$key] -and -not [object]::ReferenceEquals($owners[$key], $entry)) { $owners[$key] = $null }
        }
    }
    $map = @{}
    foreach ($k in $owners.Keys) { if ($null -ne $owners[$k]) { $map[$k] = $owners[$k] } }
    return $map
}

function Compare-WowgetLower { param([string]$A, [string]$B) return [string]::CompareOrdinal($A.ToLowerInvariant(), $B.ToLowerInvariant()) }

function Get-WowgetLowerSorted {
    param([string[]]$Items = @())
    $arr = [string[]]@($Items)
    [Array]::Sort($arr, [System.Comparison[string]] { param($a, $b) Compare-WowgetLower $a $b })
    return , $arr
}

# Addon folders in $TargetDir without a valid marker, with companion folders grouped under their
# parent addon (by TOC dependency or name prefix) and groups of the same source merged.
function Find-WowgetUnmanaged {
    param([Parameter(Mandatory)][string]$TargetDir, [Parameter(Mandatory)][string]$TargetName, [object[]]$Registry = @())
    if (-not [System.IO.Directory]::Exists($TargetDir)) { return @() }
    $markers = Get-WowgetTargetMarkers $TargetDir
    $candidates = Get-WowgetLowerSorted @($markers.Values | Where-Object { $_.Status -ne 'ok' -and $_.Folder -ne '__MACOSX' } | ForEach-Object Folder)
    $metas = @(foreach ($folder in $candidates) {
            if (-not (Test-WowgetAddonFolder ([System.IO.Path]::Combine($TargetDir, $folder)))) { continue }
            Get-WowgetFolderMeta $TargetDir $folder
        })
    if ($metas.Count -eq 0) { return @() }
    $byLower = @{}
    foreach ($m in $metas) { $byLower[$m.Folder.ToLowerInvariant()] = $m }
    $compatible = { param($a, $b) -not $a.Source -or -not $b.Source -or $a.Source -ceq $b.Source }
    $parentOf = {
        param($meta)
        foreach ($dep in $meta.Deps) {
            $t = $byLower[$dep.ToLowerInvariant()]
            if ($t -and -not [object]::ReferenceEquals($t, $meta) -and (& $compatible $meta $t)) { return $t }
        }
        $best = $null
        $lower = $meta.Folder.ToLowerInvariant()
        foreach ($other in $metas) {
            if ([object]::ReferenceEquals($other, $meta)) { continue }
            $prefix = $other.Folder.ToLowerInvariant()
            if (($lower.StartsWith("${prefix}_") -or $lower.StartsWith("${prefix}-")) -and (-not $best -or $prefix.Length -gt $best.Folder.Length)) {
                if (& $compatible $meta $other) { $best = $other }
            }
        }
        return $best
    }
    $groups = [System.Collections.Specialized.OrderedDictionary]::new()
    $roots = @{}
    foreach ($meta in $metas) {
        $seen = [System.Collections.Generic.HashSet[object]]::new([System.Collections.Generic.ReferenceEqualityComparer]::Instance)
        [void]$seen.Add($meta)
        $cur = $meta
        while ($true) {
            $next = & $parentOf $cur
            if (-not $next -or -not $seen.Add($next)) { break }
            $cur = $next
        }
        $key = $cur.Folder.ToLowerInvariant()
        if (-not $groups.Contains($key)) { $groups[$key] = [System.Collections.Generic.List[object]]::new(); $roots[$key] = $cur }
        $groups[$key].Add($meta)
    }

    # A group whose TOCs name no source takes it from the registry entry listing one of its folders, root
    # first. Grouping comes first, so a companion folder never gets a source that differs from its parent's.
    $byFolder = Get-WowgetRegistryFolderMap $Registry
    foreach ($key in $groups.Keys) {
        $root = $roots[$key]
        $members = $groups[$key]
        if (@($members | Where-Object Source).Count) { continue }
        $entry = @(@($root) + @($members) | ForEach-Object { $byFolder[$_.Folder.ToLowerInvariant()] } | Where-Object { $_ }) | Select-Object -First 1
        if ($entry) { $root.Source = $entry.Source; $root.RegistryName = $entry.Name }
    }

    $sourceOf = { param($root, $members) if ($root.Source) { $root.Source } else { $members | Where-Object Source | ForEach-Object Source | Select-Object -First 1 } }
    $bySource = @{}
    $unmerged = [System.Collections.Generic.List[object]]::new()
    foreach ($key in $groups.Keys) {
        $root = $roots[$key]
        $members = $groups[$key]
        $source = & $sourceOf $root $members
        if ($source) {
            if ($bySource.ContainsKey($source)) { $bySource[$source].AddRange($members); continue }
            $bySource[$source] = [System.Collections.Generic.List[object]]::new($members)
        }
        $unmerged.Add([pscustomobject]@{ Root = $root; Members = $members })
    }
    $emitted = [System.Collections.Generic.HashSet[string]]::new()
    $out = foreach ($g in $unmerged) {
        $source = & $sourceOf $g.Root $g.Members
        if ($source -and -not $emitted.Add($source)) { continue }
        $members = if ($source) { $bySource[$source] } else { $g.Members }
        $folders = Get-WowgetLowerSorted @($members | ForEach-Object Folder)
        $version = if ($g.Root.Version) { $g.Root.Version } else { $members | Where-Object Version | ForEach-Object Version | Select-Object -First 1 }
        $name = $g.Root.Folder
        $registryName = $members | Where-Object { $_.RegistryName -and $_.Source -ceq $source } | ForEach-Object RegistryName | Select-Object -First 1
        if ($registryName) { $name = $registryName }
        elseif ($source) {
            $preferred = Get-WowgetDefaultAddonName (ConvertFrom-WowgetSource $source)
            $match = $members | Where-Object { $_.Folder -eq $preferred } | Select-Object -First 1
            if ($match) { $name = $match.Folder }
        }
        $fields = [ordered]@{ name = $name; target = $TargetName; folders = $folders; version = $version; source = $source }
        # The CurseForge fields name no source wowget installs from; they only say where the addon is from.
        if (-not $source -and @($members | Where-Object Curse).Count) { $fields['curseforge'] = $true }
        [pscustomobject]$fields
    }
    return @(Get-WowgetSortedByName @($out))
}

function Invoke-WowgetReconcile {
    param([Parameter(Mandatory)][hashtable]$Options, [switch]$Adopt)
    $ctx = New-WowgetContext $Options
    $registry = Get-WowgetRegistry -ApiUrl $ctx.ApiUrl -CacheDir $ctx.CacheDir
    if ($registry.Stale) { Send-WowgetEvent $Options @{ type = 'registry:stale'; message = $registry.Stale } }
    $enabled = @($registry.Entries | Where-Object { -not $_.Disabled })
    $discovered = foreach ($target in (Get-WowgetSortedByName $ctx.Targets)) {
        foreach ($group in (Find-WowgetUnmanaged $target.Path $target.Name $enabled)) { [pscustomobject]@{ Target = $target; Group = $group } }
    }
    $discovered = @($discovered)
    $withStatus = {
        param($group, $status)
        $copy = [ordered]@{}
        foreach ($p in $group.PSObject.Properties) { $copy[$p.Name] = $p.Value }
        $copy['status'] = $status
        $copy
    }
    if (-not $Adopt) {
        $addons = foreach ($d in $discovered) { [pscustomobject](& $withStatus $d.Group $(if ($d.Group.source) { 'unmanaged' } else { 'unmatched' })) }
        return New-WowgetResult ([ordered]@{ addons = @($addons) })
    }

    $addons = foreach ($d in $discovered) {
        $group = $d.Group
        $target = $d.Target
        if (-not $group.source) { [pscustomobject](& $withStatus $group 'unmatched'); continue }
        try {
            $read = Read-WowgetManifestText $Options.ManifestPath
            $manifest = $read.Manifest
            # GitHub owners and repositories are case-insensitive, so sources compare by their key.
            $sourceKey = Get-WowgetSourceKey $group.source
            $bySource = $manifest.Addons | Where-Object { (Get-WowgetSourceKey $_.Source) -ceq $sourceKey } | Select-Object -First 1
            $byName = Find-WowgetAddon $manifest $group.name
            if ($byName -and (Get-WowgetSourceKey $byName.Source) -cne $sourceKey) {
                throw (New-WowgetError 'conflict' "Manifest already has `"$($byName.Name)`" with source `"$($byName.Source)`".")
            }
            $existing = if ($bySource) { $bySource } else { $byName }
            $addonName = if ($existing) { $existing.Name } else { $group.name }
            $entry = if ($existing) { $existing } else { New-WowgetAddonEntry -Name $addonName -Source $group.source }
            $resolved = Get-WowgetResolved $ctx ([pscustomobject]@{ Entry = $entry; Target = $target })
            $installed = Install-WowgetRelease -Addon $addonName -Resolved $resolved -TargetDir $target.Path -Flavor $target.Flavor -CacheDir $ctx.CacheDir `
                -Force:$ctx.Force -AdoptFolders $group.folders -OnEvent (Get-WowgetOption $Options 'OnEvent')
            if (-not $existing) {
                $targets = if ($manifest.Targets.Count -gt 1) { [string[]]@($target.Name) } else { $null }
                $next = New-WowgetManifestObject -Targets $manifest.Targets -Addons (@($manifest.Addons) + (New-WowgetAddonEntry -Name $addonName -Source $group.source -Targets $targets))
                [void](Save-WowgetManifest $Options.ManifestPath $read.Text $next)
            } else {
                $on = @(Get-WowgetAddonTargets $manifest $existing)
                if ($on -cnotcontains $target.Name) {
                    $combined = @($manifest.Targets | ForEach-Object Name | Where-Object { $on -ccontains $_ -or $_ -ceq $target.Name })
                    $copy = Copy-WowgetAddonEntry $existing
                    $copy.Targets = if ($combined.Count -lt $manifest.Targets.Count) { [string[]]$combined } else { $null }
                    [void](Save-WowgetManifest $Options.ManifestPath $read.Text (Set-WowgetManifestAddon $manifest $existing.Name $copy))
                }
            }
            $fields = [ordered]@{ name = $addonName; target = $target.Name; folders = [string[]]$installed.Folders; version = $installed.Version; source = $group.source; status = 'adopted' }
            Add-WowgetOptionalField $fields 'leftoverDir' $installed.LeftoverDir
            [pscustomobject]$fields
        } catch {
            $fields = & $withStatus $group 'error'
            $fields['error'] = Get-WowgetErrorMessage $_
            [pscustomobject]$fields
        }
    }
    return New-WowgetResult ([ordered]@{ addons = @($addons) })
}
