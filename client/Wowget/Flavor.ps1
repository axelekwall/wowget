# Flavors, TOC parsing and the flavor check of addon folders (SPEC-MVP.md, "Flavor and TOC").

$script:Flavors = @('forever', 'mainline', 'classic', 'bcc', 'wrath', 'cata', 'mists')

# TOC suffixes that name exactly one flavor.
$script:OwnSuffixes = @{
    forever  = @('Forever', 'Camelot')
    mainline = @('Mainline', 'Standard')
    classic  = @('Vanilla')
    bcc      = @('TBC', 'BCC')
    wrath    = @('Wrath', 'WOTLKC')
    cata     = @('Cata')
    mists    = @('Mists')
}

# TOC suffixes shared by several flavors; they count only when their interface list is in range.
$script:FamilySuffixes = @{
    forever  = @('Mainline')
    mainline = @()
    classic  = @('Classic')
    bcc      = @('Classic')
    wrath    = @('Classic')
    cata     = @('Classic')
    mists    = @('Classic')
}

$script:KnownSuffixes = @(@($script:OwnSuffixes.Values | ForEach-Object { $_ }) + @($script:FamilySuffixes.Values | ForEach-Object { $_ }) | Select-Object -Unique)

function Test-WowgetFlavor {
    param([AllowNull()]$Value)
    return $Value -is [string] -and $script:Flavors -ccontains $Value
}

# Splits "Questie-Classic.toc" into base "Questie" and suffix "Classic".
function Split-WowgetTocName {
    param([Parameter(Mandatory)][string]$FileName)
    $stem = $FileName -replace '(?i)\.toc$', ''
    if ($stem -match '^(.*)[_-]([A-Za-z]+)$') {
        $base = $Matches[1]
        $word = $Matches[2]
        $known = $script:KnownSuffixes | Where-Object { $_ -eq $word } | Select-Object -First 1
        if ($known -and $base) { return [pscustomobject]@{ Base = $base; Suffix = $known } }
    }
    return [pscustomobject]@{ Base = $stem; Suffix = '' }
}

# The flavor suffix of TOC file $FileName in folder $FolderName ('' for an unsuffixed TOC), or $null
# when the TOC does not belong to the folder. A TOC whose whole stem is the folder name is unsuffixed,
# so "BigWigs_Classic/BigWigs_Classic.toc" belongs to its folder.
function Get-WowgetTocSuffix {
    param([Parameter(Mandatory)][string]$FileName, [Parameter(Mandatory)][string]$FolderName)
    if ($FileName -notmatch '(?i)\.toc$') { return $null }
    $stem = $FileName -replace '(?i)\.toc$', ''
    if ($stem -eq $FolderName) { return '' }
    $split = Split-WowgetTocName $FileName
    if ($split.Base -eq $FolderName) { return $split.Suffix }
    return $null
}

function Test-WowgetInterfaceFlavor {
    param([Parameter(Mandatory)][long]$Interface, [Parameter(Mandatory)][string]$Flavor)
    $ok = switch ($Flavor) {
        'forever' { $Interface -ge 16000 -and $Interface -le 16999 }
        'classic' { $Interface -ge 11000 -and $Interface -le 11999 }
        'mainline' { $Interface -ge 100000 }
        'bcc' { $Interface -ge 20000 -and $Interface -le 29999 }
        'wrath' { $Interface -ge 30000 -and $Interface -le 39999 }
        'cata' { $Interface -ge 40000 -and $Interface -le 49999 }
        'mists' { $Interface -ge 50000 -and $Interface -le 59999 }
        default { $null }
    }
    if ($null -eq $ok) { return 'unknown' }
    return $(if ($ok) { 'yes' } else { 'no' })
}

function ConvertFrom-WowgetInterfaceList {
    param([AllowEmptyString()][string]$Value)
    $list = foreach ($part in $Value.Split(',')) {
        $t = $part.Trim()
        if ($t -match '^\d+$') { [long]$t }
    }
    return @($list)
}

# Reads "## Key: Value" lines. Interface may be a comma-separated list.
function ConvertFrom-WowgetToc {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $toc = [pscustomobject]@{ Interface = @(); Title = $null; Version = $null; Fields = [ordered]@{} }
    foreach ($raw in ($Text.TrimStart([char]0xFEFF) -split "`r?`n")) {
        if ($raw -notmatch '^##\s*([^:]+?)\s*:\s*(.*?)\s*$') { continue }
        $key = $Matches[1]
        $value = $Matches[2]
        $toc.Fields[$key] = $value
        switch ($key.ToLowerInvariant()) {
            'interface' { $toc.Interface = @(ConvertFrom-WowgetInterfaceList $value) }
            'title' { $toc.Title = $value }
            'version' { $toc.Version = $value }
        }
    }
    return $toc
}

# TOC file names in $Dir that belong to the folder.
function Get-WowgetAddonTocs {
    param([Parameter(Mandatory)][string]$Dir)
    $name = [System.IO.Path]::GetFileName($Dir.TrimEnd('\', '/'))
    $tocs = foreach ($file in [System.IO.Directory]::GetFiles($Dir)) {
        $fileName = [System.IO.Path]::GetFileName($file)
        if ($null -ne (Get-WowgetTocSuffix $fileName $name)) { $fileName }
    }
    return @($tocs)
}

function Test-WowgetSameSuffix {
    param([string[]]$List, [string]$Suffix)
    return @($List | Where-Object { $_ -eq $Suffix }).Count -gt 0
}

# 'yes', 'no' or 'unknown'. A TOC with the flavor's own suffix means yes. A family-suffixed or
# unsuffixed TOC, and each "## Interface-<Suffix>:" line, counts by its interface list: yes when a
# number is in the flavor's range, no when every list is entirely outside it, unknown otherwise.
function Test-WowgetFolderFlavor {
    param([Parameter(Mandatory)][string]$Dir, [Parameter(Mandatory)][string]$Flavor)
    $name = [System.IO.Path]::GetFileName($Dir.TrimEnd('\', '/'))
    $tocs = @(Get-WowgetAddonTocs $Dir)
    if ($tocs.Count -eq 0) { return 'unknown' }
    $own = $script:OwnSuffixes[$Flavor]
    $family = $script:FamilySuffixes[$Flavor]
    foreach ($file in $tocs) {
        if (Test-WowgetSameSuffix $own (Get-WowgetTocSuffix $file $name)) { return 'yes' }
    }

    $lists = [System.Collections.Generic.List[object]]::new()
    foreach ($file in $tocs) {
        $suffix = Get-WowgetTocSuffix $file $name
        if ($suffix -ne '' -and -not (Test-WowgetSameSuffix $family $suffix)) { continue }
        $toc = ConvertFrom-WowgetToc ([System.IO.File]::ReadAllText([System.IO.Path]::Combine($Dir, $file)))
        $lists.Add(@($toc.Interface))
        foreach ($key in $toc.Fields.Keys) {
            if ($key -notmatch '^(?i)interface-(.+)$') { continue }
            $typed = $Matches[1]
            $parsed = @(ConvertFrom-WowgetInterfaceList $toc.Fields[$key])
            if ((Test-WowgetSameSuffix $own $typed) -and $parsed.Count) { return 'yes' }
            if (Test-WowgetSameSuffix $family $typed) { $lists.Add($parsed) }
        }
    }

    $result = 'no'
    foreach ($list in $lists) {
        if (@($list).Count -eq 0) { $result = 'unknown'; continue }
        $support = @(foreach ($n in $list) { Test-WowgetInterfaceFlavor $n $Flavor })
        if ($support -contains 'yes') { return 'yes' }
        if ($support -contains 'unknown') { $result = 'unknown' }
    }
    return $result
}
