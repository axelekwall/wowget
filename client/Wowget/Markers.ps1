# Marker files (.wowget.json) in installed addon folders: what is installed (SPEC-POWERSHELL.md, "Markers").

$script:MarkerFile = '.wowget.json'
$script:MarkerFormatVersion = 1

function New-WowgetMarker {
    param(
        [Parameter(Mandatory)][string]$Addon,
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$ReleaseId,
        $AddonVersion = $null,
        [Parameter(Mandatory)][string]$Filename,
        $Sha256 = $null,
        [Parameter(Mandatory)][string[]]$Folders,
        [string]$InstalledAt = ([DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [System.Globalization.CultureInfo]::InvariantCulture)),
        $Previous = $null
    )
    return [pscustomobject]@{
        Addon = $Addon; Source = $Source; ReleaseId = $ReleaseId; AddonVersion = $AddonVersion; Filename = $Filename
        Sha256 = $Sha256; Folders = [string[]]$Folders; InstalledAt = $InstalledAt; Previous = $Previous
    }
}

# The release part of a marker, as kept in "previous" of the install that replaces it.
function Get-WowgetMarkerRelease {
    param([Parameter(Mandatory)]$Marker)
    return [pscustomobject]@{ ReleaseId = $Marker.ReleaseId; AddonVersion = $Marker.AddonVersion; Filename = $Marker.Filename; Sha256 = $Marker.Sha256 }
}

function ConvertTo-WowgetMarkerText {
    param([Parameter(Mandatory)]$Marker)
    $doc = [ordered]@{
        version = $script:MarkerFormatVersion; addon = $Marker.Addon; source = $Marker.Source; releaseId = $Marker.ReleaseId
        addonVersion = $Marker.AddonVersion; filename = $Marker.Filename; sha256 = $Marker.Sha256; folders = @($Marker.Folders)
        installedAt = $Marker.InstalledAt
    }
    if ($null -ne $Marker.Previous) {
        $p = $Marker.Previous
        $doc['previous'] = [ordered]@{ releaseId = $p.ReleaseId; addonVersion = $p.AddonVersion; filename = $p.Filename; sha256 = $p.Sha256 }
    }
    return (ConvertTo-WowgetJsonText $doc -MultilineDepth 1) + "`n"
}

function Test-WowgetOptionalString { param($Value) return $null -eq $Value -or $Value -is [string] }
function Test-WowgetNonEmptyString { param($Value) return $Value -is [string] -and $Value -ne '' }

# A marker parsed from its text, or $null when it is not a valid marker of a known format version.
function ConvertFrom-WowgetMarkerText {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    try { $d = ConvertFrom-WowgetJson $Text } catch { return $null }
    if (-not (Test-WowgetJsonDictionary $d)) { return $null }
    if ($d['version'] -ne $script:MarkerFormatVersion) { return $null }
    foreach ($key in 'addon', 'source', 'releaseId', 'filename') { if (-not (Test-WowgetNonEmptyString $d[$key])) { return $null } }
    foreach ($key in 'addonVersion', 'sha256', 'installedAt') { if (-not (Test-WowgetOptionalString $d[$key])) { return $null } }
    $folders = $d['folders']
    if (-not (Test-WowgetJsonList $folders) -or $folders.Count -eq 0 -or @($folders | Where-Object { -not (Test-WowgetNonEmptyString $_) }).Count) { return $null }
    $previous = $null
    if ($null -ne $d['previous']) {
        $p = $d['previous']
        if (-not (Test-WowgetJsonDictionary $p)) { return $null }
        if (-not (Test-WowgetNonEmptyString $p['releaseId']) -or -not (Test-WowgetNonEmptyString $p['filename'])) { return $null }
        if (-not (Test-WowgetOptionalString $p['addonVersion']) -or -not (Test-WowgetOptionalString $p['sha256'])) { return $null }
        $previous = [pscustomobject]@{ ReleaseId = $p['releaseId']; AddonVersion = $p['addonVersion']; Filename = $p['filename']; Sha256 = $p['sha256'] }
    }
    $installedAt = if ($null -ne $d['installedAt']) { $d['installedAt'] } else { '' }
    return New-WowgetMarker -Addon $d['addon'] -Source $d['source'] -ReleaseId $d['releaseId'] -AddonVersion $d['addonVersion'] `
        -Filename $d['filename'] -Sha256 $d['sha256'] -Folders ([string[]]@($folders)) -InstalledAt $installedAt -Previous $previous
}

function Write-WowgetMarker {
    param([Parameter(Mandatory)][string]$FolderPath, [Parameter(Mandatory)]$Marker)
    Write-WowgetFileAtomic ([System.IO.Path]::Combine($FolderPath, $script:MarkerFile)) (ConvertTo-WowgetMarkerText $Marker)
}

# Status 'none' (no marker file), 'invalid' (a marker that does not parse) or 'ok', with the marker.
function Read-WowgetMarker {
    param([Parameter(Mandatory)][string]$FolderPath)
    $path = [System.IO.Path]::Combine($FolderPath, $script:MarkerFile)
    if (-not [System.IO.File]::Exists($path)) { return [pscustomobject]@{ Status = 'none'; Marker = $null } }
    try { $text = Read-WowgetText $path } catch { return [pscustomobject]@{ Status = 'invalid'; Marker = $null } }
    $marker = ConvertFrom-WowgetMarkerText $text
    if ($null -eq $marker) { return [pscustomobject]@{ Status = 'invalid'; Marker = $null } }
    return [pscustomobject]@{ Status = 'ok'; Marker = $marker }
}

# Whether wowget considers a folder in an AddOns directory at all: not hidden, not Blizzard's.
function Test-WowgetConsideredFolder {
    param([Parameter(Mandatory)][string]$Name)
    return -not $Name.StartsWith('.') -and -not $Name.StartsWith('Blizzard_')
}

# Every folder of an AddOns directory with its marker status, keyed by folder name (case-insensitive).
function Get-WowgetTargetMarkers {
    param([Parameter(Mandatory)][string]$Dir)
    $table = @{}
    if (-not [System.IO.Directory]::Exists($Dir)) { return $table }
    foreach ($path in [System.IO.Directory]::GetDirectories($Dir)) {
        $name = [System.IO.Path]::GetFileName($path)
        if (-not (Test-WowgetConsideredFolder $name)) { continue }
        $read = Read-WowgetMarker $path
        $table[$name] = [pscustomobject]@{ Folder = $name; Status = $read.Status; Marker = $read.Marker }
    }
    return $table
}

# The install of $Addon in an AddOns directory, from the markers of its folders, or $null. Folders of
# one install carry the same marker; if they disagree, the most recent one wins.
function Get-WowgetInstall {
    param([Parameter(Mandatory)][hashtable]$Markers, [Parameter(Mandatory)][string]$Addon)
    $own = @($Markers.Values | Where-Object { $_.Status -eq 'ok' -and $_.Marker.Addon -eq $Addon })
    if ($own.Count -eq 0) { return $null }
    $latest = $own | Sort-Object { $_.Marker.InstalledAt } -Descending | Select-Object -First 1
    $m = $latest.Marker
    return [pscustomobject]@{
        Addon = $m.Addon; Source = $m.Source; ReleaseId = $m.ReleaseId; AddonVersion = $m.AddonVersion; Filename = $m.Filename
        Sha256 = $m.Sha256; Folders = [string[]]$m.Folders; InstalledAt = $m.InstalledAt; Previous = $m.Previous
        MarkerFolders = [string[]]@($own | ForEach-Object Folder)
    }
}

# The version an install shows: its addon version, else its release id.
function Get-WowgetInstallVersion {
    param([Parameter(Mandatory)]$Install)
    if ($Install.AddonVersion) { return $Install.AddonVersion }
    return $Install.ReleaseId
}

# Folders of an install that are absent, or that carry a marker for another addon (taken over with
# --force), sorted.
function Get-WowgetMissingFolders {
    param([Parameter(Mandatory)][hashtable]$Markers, [Parameter(Mandatory)]$Install)
    $missing = foreach ($folder in $Install.Folders) {
        $entry = $Markers[$folder]
        if ($null -eq $entry) { $folder; continue }
        if ($entry.Status -eq 'ok' -and $entry.Marker.Addon -ne $Install.Addon) { $folder }
    }
    $sorted = [string[]]@($missing)
    [Array]::Sort($sorted, [System.StringComparer]::Ordinal)
    return $sorted
}

# The names of the addons with markers in an AddOns directory, each once.
function Get-WowgetMarkedAddons {
    param([Parameter(Mandatory)][hashtable]$Markers)
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $names = foreach ($entry in $Markers.Values) {
        if ($entry.Status -eq 'ok' -and $seen.Add($entry.Marker.Addon)) { $entry.Marker.Addon }
    }
    return @($names)
}
