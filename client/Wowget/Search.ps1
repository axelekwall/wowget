# search over GET /v1/search, and suggest with the GitHub issue form of SPEC-REGISTRY-SUGGEST.md.

# The largest limit GET /v1/search accepts.
$script:SearchMaxLimit = 50

# GET /v1/search. Returns Rows (Name, Source, Origin, Flavors, Description, Downloads, Stars, UpdatedAt,
# Url) and Warnings. Rows the client cannot use are left out.
function Invoke-WowgetServiceSearch {
    param([Parameter(Mandatory)][string]$ApiUrl, [Parameter(Mandatory)][string]$Query, [string[]]$Flavors = $null, [switch]$Github, [int]$Limit = 20)
    $path = "/v1/search?q=$([System.Uri]::EscapeDataString($Query))"
    if ($Flavors) { $path += "&flavors=$([System.Uri]::EscapeDataString($Flavors -join ','))" }
    $path += "&github=$(if ($Github) { 1 } else { 0 })&limit=$Limit"
    $response = Invoke-WowgetApi -ApiUrl $ApiUrl -Path $path
    try {
        $doc = ConvertFrom-WowgetJson (Get-WowgetResponseText $response)
    } catch {
        throw (New-WowgetError 'network' "The wowget service returned an invalid search response ($(Get-WowgetErrorMessage $_)).")
    }
    if (-not (Test-WowgetJsonDictionary $doc) -or -not (Test-WowgetJsonList $doc['rows'])) {
        throw (New-WowgetError 'network' 'The wowget service returned an invalid search response.')
    }
    $number = { param($v) if ($v -is [long] -or $v -is [int] -or $v -is [double]) { [long]$v } else { $null } }
    $text = { param($v) if ($v -is [string] -and $v -ne '') { $v } else { $null } }
    $rows = foreach ($r in $doc['rows']) {
        if (-not (Test-WowgetJsonDictionary $r) -or -not (Test-WowgetNonEmptyString $r['name']) -or -not (Test-WowgetNonEmptyString $r['source'])) { continue }
        if ($r['origin'] -cnotin 'registry', 'wowi', 'github') { continue }
        # The filter's flavors first, then the rest in the usual order, as the Bun client lists them.
        $support = [ordered]@{}
        if (Test-WowgetJsonDictionary $r['flavors']) {
            foreach ($f in @(@($Flavors | Where-Object { $_ }) + $script:Flavors)) {
                if ($support.Contains($f) -or -not $r['flavors'].Contains($f)) { continue }
                if ($r['flavors'][$f] -cin 'yes', 'unknown') { $support[$f] = [string]$r['flavors'][$f] }
            }
        }
        [pscustomobject]@{
            Name = $r['name']; Source = $r['source']; Origin = $r['origin']; Flavors = $support; Description = (& $text $r['description'])
            Downloads = (& $number $r['downloads']); Stars = (& $number $r['stars']); UpdatedAt = (& $text $r['updatedAt']); Url = (& $text $r['url'])
        }
    }
    $warnings = @()
    if (Test-WowgetJsonList $doc['warnings']) { $warnings = @($doc['warnings'] | Where-Object { $_ -is [string] }) }
    return [pscustomobject]@{ Rows = @($rows); Warnings = [string[]]$warnings }
}

# The flavors to filter on: --flavor, else the selected targets', else none.
function Get-WowgetSearchFlavors {
    param([hashtable]$Options, $Manifest, $Flavor, [bool]$AllFlavors)
    $filter = [string[]]@(Get-WowgetOption $Options 'Targets' @())
    # Unknown -t names are an error even when --flavor or --all-flavors makes them irrelevant.
    $targets = $null
    if ($Manifest -and $filter.Count) { $targets = @(Select-WowgetTargets $Manifest $Options.ManifestPath $filter) }
    if ($AllFlavors) {
        if ($Flavor) { throw (New-WowgetError 'usage' '--flavor and --all-flavors cannot be combined.') }
        return $null
    }
    if ($Flavor) { return , [string[]]@($Flavor) }
    if (-not $Manifest -or $Manifest.Targets.Count -eq 0) { return $null }
    $from = if ($null -ne $targets) { $targets } else { $Manifest.Targets }
    return , [string[]]@($from | ForEach-Object Flavor | Select-Object -Unique)
}

function Invoke-WowgetSearch {
    param([Parameter(Mandatory)][hashtable]$Options, [Parameter(Mandatory)][AllowEmptyString()][string]$Query, $Flavor = $null, [switch]$AllFlavors, [switch]$Github, $Limit = $null)
    $q = $Query.Trim()
    if (-not (ConvertTo-WowgetNormalisedName $q)) { throw (New-WowgetError 'usage' 'search needs a query with at least one letter or digit.') }
    $max = if ($null -ne $Limit) { $Limit } else { 20 }
    if (-not ($max -is [int]) -or $max -lt 1 -or $max -gt $script:SearchMaxLimit) {
        throw (New-WowgetError 'usage' "--limit must be a whole number from 1 to $script:SearchMaxLimit.")
    }
    $manifest = $null
    try {
        $manifest = Read-WowgetManifest $Options.ManifestPath
    } catch {
        # Search works without a manifest, unless targets were asked for.
        if ((Get-WowgetErrorCode $_) -ne 'not_found' -or @(Get-WowgetOption $Options 'Targets' @()).Count) { throw }
    }
    $flavors = Get-WowgetSearchFlavors $Options $manifest $Flavor $AllFlavors.IsPresent
    $apiUrl = Get-WowgetOption $Options 'ApiUrl' (Get-WowgetApiUrl (Get-WowgetOptionEnv $Options))
    $found = Invoke-WowgetServiceSearch -ApiUrl $apiUrl -Query $q -Flavors $flavors -Github:$Github -Limit $max
    $sources = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    if ($manifest) { foreach ($a in $manifest.Addons) { [void]$sources.Add($a.Source) } }
    $results = foreach ($row in $found.Rows) {
        [pscustomobject][ordered]@{
            name = $row.Name; source = $row.Source; origin = $row.Origin; flavors = $row.Flavors; description = $row.Description
            downloadsMonthly = $row.Downloads; stars = $row.Stars; updatedAt = $row.UpdatedAt; url = $row.Url; inManifest = $sources.Contains($row.Source)
        }
    }
    return New-WowgetResult ([ordered]@{ results = @($results); flavors = $flavors; warnings = $found.Warnings })
}

# The new-issue page of the registry suggestion form.
$script:SuggestIssueUrl = 'https://github.com/axelekwall/wowget/issues/new'
$script:SuggestTemplate = 'registry-addon.yml'
# GitHub rejects longer URLs.
$script:MaxIssueUrlLength = 8000

# A query string value encoded as URLSearchParams does it, with spaces as "+".
function ConvertTo-WowgetFormValue {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
    return [System.Uri]::EscapeDataString($Value).Replace('%20', '+')
}

# The new-issue URL with the addons field prefilled, one "<source> <name>" line per suggestion.
function Get-WowgetSuggestIssueUrl {
    param([Parameter(Mandatory)][object[]]$Suggestions)
    $title = 'Registry: add ' + (($Suggestions | ForEach-Object name) -join ', ')
    if ($title.Length -gt 200) { $title = $title.Substring(0, 200) }
    $lines = ($Suggestions | ForEach-Object { "$($_.source) $($_.name)" }) -join "`n"
    return "$($script:SuggestIssueUrl)?template=$(ConvertTo-WowgetFormValue $script:SuggestTemplate)&title=$(ConvertTo-WowgetFormValue $title)&addons=$(ConvertTo-WowgetFormValue $lines)"
}

# Lists the manifest addons (or $Names) against the registry and builds the prefilled issue URL for
# those it lacks. Opening the browser is left to the caller.
function Invoke-WowgetSuggest {
    param([Parameter(Mandatory)][hashtable]$Options, [string[]]$Names = @())
    $manifest = Read-WowgetManifest $Options.ManifestPath
    $addons = $manifest.Addons
    if ($Names.Count) {
        $unknown = @($Names | Where-Object { -not (Find-WowgetAddon $manifest $_) })
        if ($unknown.Count) {
            $verb = if ($unknown.Count -gt 1) { 'are' } else { 'is' }
            $list = ($unknown | ForEach-Object { '"' + $_ + '"' }) -join ', '
            throw (New-WowgetError 'usage' "$list $verb not in the manifest.")
        }
        $addons = @($Names | ForEach-Object { Find-WowgetAddon $manifest $_ })
    }
    $env = Get-WowgetOptionEnv $Options
    $apiUrl = Get-WowgetOption $Options 'ApiUrl' (Get-WowgetApiUrl $env)
    $cacheDir = Get-WowgetOption $Options 'CacheDir' (Get-WowgetCacheDir $env (Get-WowgetOptionPlatform $Options))
    $registry = Get-WowgetRegistry -ApiUrl $apiUrl -CacheDir $cacheDir
    $listed = @{}
    foreach ($e in $registry.Entries) {
        $listed[(Get-WowgetSourceKey $e.Source)] = $e.Name
    }
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $entries = foreach ($a in (Get-WowgetSortedByName @($addons))) {
        if (-not $seen.Add($a.Name)) { continue }
        $key = Get-WowgetSourceKey $a.Source
        if ($listed.ContainsKey($key)) { [pscustomobject][ordered]@{ name = $a.Name; source = $a.Source; status = 'listed'; registryName = $listed[$key] }; continue }
        $status = if ($a.Source.StartsWith('url:')) { 'url' } else { 'suggested' }
        [pscustomobject][ordered]@{ name = $a.Name; source = $a.Source; status = $status }
    }
    $entries = @($entries)
    $suggested = @($entries | Where-Object status -EQ 'suggested')
    $url = if ($suggested.Count) { Get-WowgetSuggestIssueUrl $suggested } else { $null }
    if ($url -and $url.Length -gt $script:MaxIssueUrlLength) {
        throw (New-WowgetError 'usage' "$($suggested.Count) addons make the issue URL too long for GitHub; name some of them: wowget suggest <name>...")
    }
    $warnings = [string[]]@($registry.Stale | Where-Object { $_ })
    return New-WowgetResult ([ordered]@{ addons = $entries; url = $url; warnings = $warnings })
}
