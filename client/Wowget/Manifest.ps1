# The manifest, wowget.json: parse, validate and write (SPEC-POWERSHELL.md, "Manifest").
# A manifest is a [pscustomobject] with Targets (Name, Path, Folder, Flavor) and Addons (Name, Source,
# Prerelease, Pin, Targets), each in file order. Writes rewrite the whole file and read it back.

$script:ManifestFormatVersion = 1
$script:TopKeys = @('version', 'targets', 'addons')
$script:TargetKeys = @('path', 'folder', 'flavor')
$script:AddonKeys = @('name', 'source', 'targets', 'pin', 'prerelease')

function Test-WowgetTargetName {
    param([AllowNull()][string]$Name)
    return $Name -cmatch '^[a-z0-9][a-z0-9_-]*$'
}

# A single folder name: no separators, drive letters, "." or "..".
function Test-WowgetVersionFolderName {
    param([AllowNull()][string]$Name)
    return $Name -cmatch '^[A-Za-z0-9_.-]+$' -and $Name -ne '.' -and $Name -ne '..'
}

# Why $Name cannot be an addon name, or $null when it can. Names become cache directory names, where
# "." and ".." would point at the cache itself or its parent.
function Get-WowgetAddonNameProblem {
    param([AllowEmptyString()][string]$Name)
    if ($Name.Trim() -eq '') { return 'must not be blank' }
    if ($Name.Trim() -eq '.' -or $Name.Trim() -eq '..') { return 'must not be "." or ".."' }
    return $null
}

# Parses "github:owner/repo", "wowi:<id>" or "url:https://...".
function ConvertFrom-WowgetSource {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Raw)
    $colon = $Raw.IndexOf(':')
    $kind = if ($colon -lt 0) { '' } else { $Raw.Substring(0, $colon) }
    $rest = if ($colon -lt 0) { '' } else { $Raw.Substring($colon + 1) }
    switch -CaseSensitive ($kind) {
        'github' {
            if ($rest -cnotmatch '^([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+)$' -or $Matches[2] -eq '.' -or $Matches[2] -eq '..') {
                throw (New-WowgetError 'source' "Invalid GitHub source `"$Raw`"; expected `"github:owner/repo`".")
            }
            return [pscustomobject]@{ Kind = 'github'; Raw = $Raw; Owner = $Matches[1]; Repo = $Matches[2]; Id = $null; Url = $null }
        }
        'wowi' {
            if ($rest -cnotmatch '^[1-9][0-9]*$') {
                throw (New-WowgetError 'source' "Invalid WoWInterface source `"$Raw`"; expected `"wowi:<id>`" with a numeric id.")
            }
            return [pscustomobject]@{ Kind = 'wowi'; Raw = $Raw; Owner = $null; Repo = $null; Id = $rest; Url = $null }
        }
        'url' {
            $uri = $null
            if (-not [System.Uri]::TryCreate($rest, [System.UriKind]::Absolute, [ref]$uri) -or $rest -notmatch '^[A-Za-z][A-Za-z0-9+.-]*://') {
                throw (New-WowgetError 'source' "Invalid URL source `"$Raw`"; expected `"url:https://...`".")
            }
            if ($uri.Scheme -ne 'https' -and $uri.Scheme -ne 'http') {
                throw (New-WowgetError 'source' "Invalid URL source `"$Raw`"; only http and https URLs are supported.")
            }
            return [pscustomobject]@{ Kind = 'url'; Raw = $Raw; Owner = $null; Repo = $null; Id = $null; Url = $uri.AbsoluteUri }
        }
    }
    throw (New-WowgetError 'source' "Unknown source `"$Raw`"; supported forms are `"github:owner/repo`", `"wowi:<id>`" and `"url:https://...`".")
}

# The last path segment of a URL, decoded.
function Get-WowgetUrlLastSegment {
    param([Parameter(Mandatory)][string]$Url)
    $segments = @(([System.Uri]$Url).AbsolutePath.Split('/') | Where-Object { $_ -ne '' })
    if ($segments.Count -eq 0) { return '' }
    return [System.Uri]::UnescapeDataString($segments[-1])
}

# Name used on "add" when none is given: the repo name, or the URL's last path segment without ".zip".
function Get-WowgetDefaultAddonName {
    param([Parameter(Mandatory)]$Spec)
    switch ($Spec.Kind) {
        'github' { return $Spec.Repo }
        'wowi' { return "wowi-$($Spec.Id)" }
    }
    $name = (Get-WowgetUrlLastSegment $Spec.Url) -replace '(?i)\.zip$', ''
    if ($name) { return $name }
    return ([System.Uri]$Spec.Url).Host
}

function New-WowgetTarget {
    param([Parameter(Mandatory)][string]$Name, $Path = $null, $Folder = $null, [Parameter(Mandatory)][string]$Flavor)
    return [pscustomobject]@{ Name = $Name; Path = $Path; Folder = $Folder; Flavor = $Flavor }
}

function New-WowgetAddonEntry {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Source,
        [bool]$Prerelease = $false,
        $Pin = $null,
        $Targets = $null
    )
    $list = $null
    if ($null -ne $Targets) { $list = [string[]]@($Targets) }
    return [pscustomobject]@{ Name = $Name; Source = $Source; Prerelease = $Prerelease; Pin = $Pin; Targets = $list }
}

function Copy-WowgetAddonEntry {
    param([Parameter(Mandatory)]$Entry)
    return New-WowgetAddonEntry -Name $Entry.Name -Source $Entry.Source -Prerelease $Entry.Prerelease -Pin $Entry.Pin -Targets $Entry.Targets
}

function New-WowgetManifestObject {
    param([object[]]$Targets = @(), [object[]]$Addons = @())
    return [pscustomobject]@{ Targets = @($Targets); Addons = @($Addons) }
}

function Test-WowgetJsonDictionary { param($Value) return $Value -is [System.Collections.IDictionary] }
function Test-WowgetJsonList { param($Value) return $Value -is [System.Collections.IList] -and -not ($Value -is [System.Collections.IDictionary]) }

function Assert-WowgetKnownKeys {
    param($Table, [string[]]$Allowed, [string]$Where, [scriptblock]$Fail)
    foreach ($key in $Table.Keys) {
        if ($Allowed -cnotcontains $key) { & $Fail "unknown key `"$key`" in $Where" }
    }
}

function Get-WowgetRequiredString {
    param($Table, [string]$Key, [string]$Where, [scriptblock]$Fail)
    $value = $Table[$Key]
    if (-not ($value -is [string]) -or $value -eq '') { & $Fail "$Where.$Key must be a non-empty string" }
    return $value
}

# Parses and validates manifest text. Errors are "manifest" errors prefixed with $File.
function ConvertFrom-WowgetManifestText {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text, [string]$File = '')
    $prefix = if ($File) { "${File}: " } else { '' }
    $fail = {
        param([string]$message)
        throw (New-WowgetError 'manifest' "$prefix$message")
    }

    try {
        $data = ConvertFrom-WowgetJson $Text
    } catch {
        & $fail "invalid JSON: $(Get-WowgetErrorMessage $_)"
    }
    if (-not (Test-WowgetJsonDictionary $data)) { & $fail 'the manifest must be a JSON object' }
    Assert-WowgetKnownKeys $data $script:TopKeys 'the top level' $fail

    $version = $data['version']
    if (-not ($version -is [long] -or $version -is [int]) -or $version -lt 1) {
        & $fail "version must be $script:ManifestFormatVersion"
    }
    if ($version -gt $script:ManifestFormatVersion) {
        & $fail "the manifest is format version $version, which this wowget does not read; run `"wowget self-update`""
    }

    $rawTargets = if ($data.Contains('targets')) { $data['targets'] } else { [ordered]@{} }
    if (-not (Test-WowgetJsonDictionary $rawTargets)) { & $fail 'targets must be an object of named targets' }
    $targets = foreach ($name in @($rawTargets.Keys)) {
        $where = "targets.$name"
        if (-not (Test-WowgetTargetName $name)) {
            & $fail "target name `"$name`" must start with a-z or 0-9 and contain only a-z, 0-9, `"_`" and `"-`""
        }
        $value = $rawTargets[$name]
        if (-not (Test-WowgetJsonDictionary $value)) { & $fail "$where must be an object" }
        Assert-WowgetKnownKeys $value $script:TargetKeys $where $fail
        if ($value.Contains('path') -eq $value.Contains('folder')) { & $fail "$where must have exactly one of path and folder" }
        $flavor = Get-WowgetRequiredString $value 'flavor' $where $fail
        if (-not (Test-WowgetFlavor $flavor)) { & $fail "$where.flavor `"$flavor`" is not one of $($script:Flavors -join ', ')" }
        if ($value.Contains('path')) {
            New-WowgetTarget -Name $name -Path (Get-WowgetRequiredString $value 'path' $where $fail) -Flavor $flavor
            continue
        }
        $folder = Get-WowgetRequiredString $value 'folder' $where $fail
        if (-not (Test-WowgetVersionFolderName $folder)) {
            & $fail "$where.folder `"$folder`" must be a single folder name in the game directory, such as `"_retail_`""
        }
        New-WowgetTarget -Name $name -Folder $folder -Flavor $flavor
    }
    $targets = @($targets)
    $targetNames = @($targets | ForEach-Object Name)

    # Assigned without an if expression, which would unroll a one-element array.
    $rawAddons = @()
    if ($data.Contains('addons')) { $rawAddons = $data['addons'] }
    if (-not (Test-WowgetJsonList $rawAddons)) { & $fail 'addons must be an array of addon objects' }
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $addons = for ($i = 0; $i -lt $rawAddons.Count; $i++) {
        $raw = $rawAddons[$i]
        $where = "addon #$($i + 1)"
        if (-not (Test-WowgetJsonDictionary $raw)) { & $fail "$where must be an object" }
        Assert-WowgetKnownKeys $raw $script:AddonKeys $where $fail
        $name = Get-WowgetRequiredString $raw 'name' $where $fail
        $problem = Get-WowgetAddonNameProblem $name
        if ($problem) { & $fail "${where}: name `"$name`" $problem" }
        $source = Get-WowgetRequiredString $raw 'source' $where $fail
        try { [void](ConvertFrom-WowgetSource $source) } catch { & $fail "$where ($name): $(Get-WowgetErrorMessage $_)" }
        if ($raw.Contains('prerelease') -and -not ($raw['prerelease'] -is [bool])) { & $fail "$where.prerelease must be true or false" }
        if ($raw.Contains('pin') -and (-not ($raw['pin'] -is [string]) -or $raw['pin'] -eq '')) { & $fail "$where.pin must be a non-empty string" }
        if (-not $seen.Add($name)) { & $fail "duplicate addon name `"$name`"" }
        $list = $null
        if ($raw.Contains('targets')) {
            $value = $raw['targets']
            if (-not (Test-WowgetJsonList $value) -or @($value | Where-Object { -not ($_ -is [string]) }).Count) {
                & $fail "$where ($name): targets must be an array of target names"
            }
            if ($value.Count -eq 0) { & $fail "$where ($name): targets must not be empty; remove the key to mean every target" }
            foreach ($t in $value) {
                if ($targetNames -cnotcontains $t) { & $fail "$where ($name): unknown target `"$t`"" }
            }
            if ([System.Collections.Generic.HashSet[string]]::new([string[]]@($value), [System.StringComparer]::Ordinal).Count -ne $value.Count) {
                & $fail "$where ($name): targets lists a target twice"
            }
            $list = [string[]]@($value)
        }
        $pin = if ($raw.Contains('pin')) { $raw['pin'] } else { $null }
        New-WowgetAddonEntry -Name $name -Source $source -Prerelease ($raw['prerelease'] -eq $true) -Pin $pin -Targets $list
    }
    return New-WowgetManifestObject -Targets $targets -Addons @($addons)
}

function ConvertTo-WowgetManifestText {
    param([Parameter(Mandatory)]$Manifest)
    $targets = [ordered]@{}
    foreach ($t in $Manifest.Targets) {
        $value = [ordered]@{}
        if ($null -ne $t.Folder) { $value['folder'] = $t.Folder } else { $value['path'] = $t.Path }
        $value['flavor'] = $t.Flavor
        $targets[$t.Name] = $value
    }
    $addons = foreach ($a in $Manifest.Addons) {
        $value = [ordered]@{ name = $a.Name; source = $a.Source }
        if ($null -ne $a.Targets) { $value['targets'] = @($a.Targets) }
        if ($null -ne $a.Pin) { $value['pin'] = $a.Pin }
        if ($a.Prerelease) { $value['prerelease'] = $true }
        $value
    }
    $doc = [ordered]@{ version = $script:ManifestFormatVersion; targets = $targets; addons = @($addons) }
    return (ConvertTo-WowgetJsonText $doc -MultilineDepth 2) + "`n"
}

function Read-WowgetManifestText {
    param([Parameter(Mandatory)][string]$Path)
    if (-not [System.IO.File]::Exists($Path)) {
        throw (New-WowgetError 'not_found' "Manifest not found at $Path. Run `"wowget init`" first.")
    }
    $text = Read-WowgetText $Path
    return [pscustomobject]@{ Text = $text; Manifest = (ConvertFrom-WowgetManifestText $text $Path) }
}

function Read-WowgetManifest {
    param([Parameter(Mandatory)][string]$Path)
    return (Read-WowgetManifestText $Path).Manifest
}

function Find-WowgetAddon {
    param([Parameter(Mandatory)]$Manifest, [Parameter(Mandatory)][string]$Name)
    return $Manifest.Addons | Where-Object { $_.Name -eq $Name } | Select-Object -First 1
}

function Find-WowgetTarget {
    param([Parameter(Mandatory)]$Manifest, [Parameter(Mandatory)][string]$Name)
    return $Manifest.Targets | Where-Object { $_.Name -ceq $Name } | Select-Object -First 1
}

# The names of the targets $Entry is on, in manifest order.
function Get-WowgetAddonTargets {
    param([Parameter(Mandatory)]$Manifest, [Parameter(Mandatory)]$Entry)
    $names = @($Manifest.Targets | ForEach-Object Name)
    if ($null -eq $Entry.Targets) { return $names }
    return @($names | Where-Object { $Entry.Targets -ccontains $_ })
}

# Throws unless $Manifest renders to text that parses back to the same manifest; nothing is written.
function Assert-WowgetManifestPlanned {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Manifest)
    $text = ConvertTo-WowgetManifestText $Manifest
    try {
        $parsed = ConvertFrom-WowgetManifestText $text $Path
        $reason = if ((ConvertTo-WowgetManifestText $parsed) -cne $text) { 'the result did not match the expected manifest' } else { $null }
    } catch {
        $reason = Get-WowgetErrorMessage $_
    }
    if ($reason) { throw (New-WowgetError 'manifest' "Updating $Path failed ($reason); the file was left unchanged.") }
    return $text
}

# Writes $Manifest, reads the file back, and restores $Previous (or removes the file when there was
# none) unless it holds exactly the manifest that was meant.
function Write-WowgetManifestChecked {
    param([Parameter(Mandatory)][string]$Path, [AllowNull()][string]$Previous, [Parameter(Mandatory)]$Manifest)
    $text = Assert-WowgetManifestPlanned $Path $Manifest
    Write-WowgetFileAtomic $Path $text
    $reason = $null
    try {
        $back = Read-WowgetText $Path
        $parsed = ConvertFrom-WowgetManifestText $back $Path
        if ($back -cne $text -or (ConvertTo-WowgetManifestText $parsed) -cne $text) { $reason = 'the file did not read back as written' }
    } catch {
        $reason = Get-WowgetErrorMessage $_
    }
    if (-not $reason) { return $parsed }
    if ([string]::IsNullOrEmpty($Previous)) { [void](Remove-WowgetBestEffort (Resolve-WowgetWriteTarget $Path)) }
    else { Write-WowgetFileAtomic $Path $Previous }
    throw (New-WowgetError 'manifest' "Updating $Path failed ($reason); the file was left unchanged.")
}

# Writes $Manifest, computed from $PreviousText, unless the file no longer holds $PreviousText.
function Save-WowgetManifest {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$PreviousText, [Parameter(Mandatory)]$Manifest)
    $current = if ([System.IO.File]::Exists($Path)) { Read-WowgetText $Path } else { $null }
    if ($current -cne $PreviousText) {
        throw (New-WowgetError 'manifest' "$Path changed while wowget was running, so it was not updated.")
    }
    return Write-WowgetManifestChecked $Path $PreviousText $Manifest
}

function New-WowgetManifestFile {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Targets)
    if (Test-WowgetPath $Path) { throw (New-WowgetError 'manifest_exists' "A manifest already exists at $Path.") }
    [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($Path)))
    return Write-WowgetManifestChecked $Path $null (New-WowgetManifestObject -Targets $Targets -Addons @())
}

# The manifest with $Entry replaced by $Replacement ($null removes it).
function Set-WowgetManifestAddon {
    param([Parameter(Mandatory)]$Manifest, [Parameter(Mandatory)][string]$Name, $Replacement)
    $addons = foreach ($a in $Manifest.Addons) {
        if ($a.Name -ne $Name) { $a } elseif ($null -ne $Replacement) { $Replacement }
    }
    return New-WowgetManifestObject -Targets $Manifest.Targets -Addons @($addons)
}

# The manifest without target $Name, with the name dropped from every addon's targets list; addons
# left with an empty list are removed and named in RemovedAddons.
function Remove-WowgetManifestTarget {
    param([Parameter(Mandatory)]$Manifest, [Parameter(Mandatory)][string]$Name)
    $removed = [System.Collections.Generic.List[string]]::new()
    $addons = foreach ($a in $Manifest.Addons) {
        if ($null -eq $a.Targets -or $a.Targets -cnotcontains $Name) { $a; continue }
        $remaining = @($a.Targets | Where-Object { $_ -cne $Name })
        if ($remaining.Count) {
            $copy = Copy-WowgetAddonEntry $a
            $copy.Targets = [string[]]$remaining
            $copy
        } else {
            $removed.Add($a.Name)
        }
    }
    $targets = @($Manifest.Targets | Where-Object { $_.Name -cne $Name })
    return [pscustomobject]@{ Manifest = (New-WowgetManifestObject -Targets $targets -Addons @($addons)); RemovedAddons = $removed.ToArray() }
}
