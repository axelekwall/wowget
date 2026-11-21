# The wowget service client (SPEC-SERVICE.md, "API"): release resolution and the registry. Search,
# version and suggestions come with the commands that use them.

# Items per POST /v1/resolve request; the service's provisional cap.
$script:ResolveBatchSize = 20

# Hosts a download URL from the service may point at, on every redirect hop.
$script:DownloadHosts = @('github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'cdn.wowinterface.com')

# Calls the service. HTTP errors become WowgetErrors: rate_limited (naming Retry-After), else network.
function Invoke-WowgetApi {
    param(
        [Parameter(Mandatory)][string]$ApiUrl,
        [string]$Method = 'GET',
        [Parameter(Mandatory)][string]$Path,
        $Body = $null,
        [hashtable]$Headers = @{}
    )
    if ($ApiUrl -eq 'off') {
        throw (New-WowgetError 'network' 'The wowget service is turned off (WOWGET_API_URL=off).')
    }
    $sendHeaders = @{ Accept = 'application/json' }
    foreach ($k in $Headers.Keys) { $sendHeaders[$k] = $Headers[$k] }
    $response = Invoke-WowgetHttp -Method $Method -Uri "$ApiUrl$Path" -Headers $sendHeaders -Body $Body
    $code = $response.StatusCode
    if (($code -ge 200 -and $code -lt 300) -or $code -eq 304) { return $response }

    $errorCode = $null
    $message = "HTTP $code"
    try {
        $doc = ConvertFrom-WowgetJson (Get-WowgetResponseText $response)
        if ((Test-WowgetJsonDictionary $doc) -and (Test-WowgetJsonDictionary $doc['error'])) {
            $errorCode = $doc['error']['code']
            if ($doc['error']['message'] -is [string]) { $message = "$message, $($doc['error']['message'])" }
        }
    } catch {
        $errorCode = $null
    }
    if ($code -eq 429 -or $errorCode -eq 'rate_limited') {
        $retry = $response.Headers['Retry-After']
        $when = if ($retry) { "; try again in $retry seconds" } else { '; try again later' }
        throw (New-WowgetError 'rate_limited' "The wowget service is rate limiting requests from this address$when.")
    }
    throw (New-WowgetError 'network' "The wowget service failed: $Method $Path answered $message.")
}

function Get-WowgetResolveKey {
    param([Parameter(Mandatory)]$Item)
    return ConvertTo-WowgetJsonText @($Item.source, $Item.flavor, [bool]$Item.prerelease, $Item.pin) -MultilineDepth 0
}

# A resolved release from one service result, or a WowgetError for the row.
function ConvertFrom-WowgetResolveResult {
    param([Parameter(Mandatory)]$Result, [Parameter(Mandatory)]$Item)
    $invalid = { New-WowgetError 'source' "The wowget service returned an invalid result for $($Item.source)." }
    if (-not (Test-WowgetJsonDictionary $Result)) { return & $invalid }
    if ($Result['ok'] -ne $true) {
        $err = $Result['error']
        $code = if (Test-WowgetJsonDictionary $err) { $err['code'] } else { $null }
        $message = if ((Test-WowgetJsonDictionary $err) -and $err['message'] -is [string]) { $err['message'] } else { "the wowget service could not resolve $($Item.source)" }
        $mapped = switch ($code) {
            'flavor' { 'flavor' }
            { $_ -in 'source', 'upstream', 'not_found', 'bad_request' } { 'source' }
            'rate_limited' { 'rate_limited' }
            default { 'network' }
        }
        return New-WowgetError $mapped $message
    }
    foreach ($key in 'releaseId', 'filename', 'url') { if (-not (Test-WowgetNonEmptyString $Result[$key])) { return & $invalid } }
    foreach ($key in 'version', 'sha256', 'md5', 'publishedAt') { if (-not (Test-WowgetOptionalString $Result[$key])) { return & $invalid } }
    if ($Result['sha256'] -and $Result['sha256'] -notmatch '^[0-9a-fA-F]{64}$') { return & $invalid }
    if ($Result['md5'] -and $Result['md5'] -notmatch '^[0-9a-fA-F]{32}$') { return & $invalid }
    $folders = $Result['folders']
    if ($null -ne $folders -and (-not (Test-WowgetJsonList $folders) -or @($folders | Where-Object { -not (Test-WowgetNonEmptyString $_) }).Count)) { return & $invalid }
    $uri = $null
    if (-not [System.Uri]::TryCreate($Result['url'], [System.UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or $script:DownloadHosts -notcontains $uri.Host) {
        return New-WowgetError 'source' "The wowget service returned a download URL for $($Item.source) on a host wowget does not download from: $($Result['url'])"
    }
    $version = if ($Result['version']) { $Result['version'] } else { $Result['releaseId'] }
    return [pscustomobject]@{
        Source = $Item.source; ReleaseId = $Result['releaseId']; Version = $version; Filename = $Result['filename']
        DownloadUrl = $uri.AbsoluteUri; FlavorVerified = ($Result['flavorVerified'] -eq $true); LocalPath = $null
        Sha256 = $Result['sha256']; Md5 = $Result['md5']; AllowedHosts = $script:DownloadHosts; Note = $null
        Folders = $(if ($null -ne $folders) { [string[]]@($folders) } else { $null }); PublishedAt = $Result['publishedAt']
    }
}

# Resolves github: and wowi: items through POST /v1/resolve, in batches, sending each distinct
# (source, flavor, prerelease, pin) once. Returns a hashtable from Get-WowgetResolveKey to a resolved
# release or a WowgetError; a failed request is the error of every item it carried.
function Invoke-WowgetResolve {
    param([Parameter(Mandatory)][string]$ApiUrl, [object[]]$Items = @())
    $results = @{}
    $unique = [System.Collections.Generic.List[object]]::new()
    foreach ($item in $Items) {
        $key = Get-WowgetResolveKey $item
        if ($results.ContainsKey($key)) { continue }
        $results[$key] = $null
        $unique.Add($item)
    }
    for ($start = 0; $start -lt $unique.Count; $start += $script:ResolveBatchSize) {
        $batch = @($unique.GetRange($start, [Math]::Min($script:ResolveBatchSize, $unique.Count - $start)))
        $body = ConvertTo-WowgetJsonText ([ordered]@{
                items = @($batch | ForEach-Object { [ordered]@{ source = $_.source; flavor = $_.flavor; prerelease = [bool]$_.prerelease; pin = $_.pin } })
            }) -MultilineDepth 0
        try {
            $response = Invoke-WowgetApi -ApiUrl $ApiUrl -Method 'POST' -Path '/v1/resolve' -Body $body
            $doc = ConvertFrom-WowgetJson (Get-WowgetResponseText $response)
            $list = $null
            if (Test-WowgetJsonDictionary $doc) { $list = $doc['results'] }
            if (-not (Test-WowgetJsonList $list) -or $list.Count -ne $batch.Count) {
                throw (New-WowgetError 'network' 'The wowget service returned an invalid resolve response.')
            }
            for ($i = 0; $i -lt $batch.Count; $i++) {
                $results[(Get-WowgetResolveKey $batch[$i])] = ConvertFrom-WowgetResolveResult $list[$i] $batch[$i]
            }
        } catch {
            $failure = Get-WowgetException $_
            if (-not ($failure -is [WowgetError])) { $failure = New-WowgetError 'network' "The wowget service returned an invalid resolve response ($($failure.Message))." }
            foreach ($item in $batch) { $results[(Get-WowgetResolveKey $item)] = $failure }
        }
    }
    return $results
}

function ConvertTo-WowgetNormalisedName {
    param([AllowEmptyString()][string]$Text)
    return ($Text.ToLowerInvariant() -replace '[^\p{L}\p{N}]+', '')
}

function ConvertFrom-WowgetRegistryDoc {
    param([Parameter(Mandatory)]$Doc)
    if (-not (Test-WowgetJsonDictionary $Doc) -or -not (Test-WowgetJsonList $Doc['addons'])) { throw 'not a registry document' }
    $entries = foreach ($a in $Doc['addons']) {
        if (-not (Test-WowgetJsonDictionary $a) -or -not (Test-WowgetNonEmptyString $a['name']) -or -not (Test-WowgetNonEmptyString $a['source'])) { continue }
        $aliases = [string[]]@()
        if (Test-WowgetJsonList $a['aliases']) { $aliases = [string[]]@($a['aliases'] | Where-Object { $_ -is [string] }) }
        $folders = [string[]]@()
        if (Test-WowgetJsonList $a['folders']) { $folders = [string[]]@($a['folders'] | Where-Object { $_ -is [string] }) }
        [pscustomobject]@{
            Name = $a['name']; Aliases = $aliases; Source = $a['source']; Folders = $folders
            Disabled = $(if ($a['disabled'] -is [string] -and $a['disabled'] -ne '') { $a['disabled'] } else { $null })
        }
    }
    return [pscustomobject]@{ Version = $Doc['version']; Entries = @($entries) }
}

# The registry snapshot shipped in the release zip, the offline fallback.
function Get-WowgetRegistrySnapshotPath {
    return [System.IO.Path]::Combine((Split-Path -Parent $script:WowgetModuleRoot), 'registry.json')
}

# The service registry, with an ETag cache in "<cache>/registry.json". When the service cannot be
# reached, the cached copy or the snapshot is used and Stale says so.
function Get-WowgetRegistry {
    param([Parameter(Mandatory)][string]$ApiUrl, [Parameter(Mandatory)][string]$CacheDir)
    $cachePath = [System.IO.Path]::Combine($CacheDir, 'registry.json')
    $cached = $null
    if ([System.IO.File]::Exists($cachePath)) {
        try {
            $d = ConvertFrom-WowgetJson (Read-WowgetText $cachePath)
            $cached = [pscustomobject]@{ ETag = $d['etag']; Registry = (ConvertFrom-WowgetRegistryDoc $d['registry']); Doc = $d['registry'] }
        } catch {
            $cached = $null
        }
    }
    $failure = $null
    if ($ApiUrl -ne 'off') {
        try {
            $headers = @{}
            if ($cached -and $cached.ETag) { $headers['If-None-Match'] = $cached.ETag }
            $response = Invoke-WowgetApi -ApiUrl $ApiUrl -Path '/v1/registry' -Headers $headers
            if ($response.StatusCode -eq 304 -and $cached) { return [pscustomobject]@{ Entries = $cached.Registry.Entries; Stale = $null } }
            $doc = ConvertFrom-WowgetJson (Get-WowgetResponseText $response)
            $registry = ConvertFrom-WowgetRegistryDoc $doc
            [void][System.IO.Directory]::CreateDirectory($CacheDir)
            $record = [ordered]@{ etag = $response.Headers['ETag']; registry = $doc }
            Write-WowgetFileAtomic $cachePath ((ConvertTo-WowgetJsonText $record -MultilineDepth 0) + "`n")
            return [pscustomobject]@{ Entries = $registry.Entries; Stale = $null }
        } catch {
            $failure = Get-WowgetErrorMessage $_
        }
    }
    $why = if ($failure) { "the wowget service could not be reached ($failure)" } else { 'the wowget service is turned off' }
    if ($cached) {
        return [pscustomobject]@{ Entries = $cached.Registry.Entries; Stale = "$why; using the registry copy from an earlier run." }
    }
    $snapshot = Get-WowgetRegistrySnapshotPath
    if ([System.IO.File]::Exists($snapshot)) {
        $registry = ConvertFrom-WowgetRegistryDoc (ConvertFrom-WowgetJson (Read-WowgetText $snapshot))
        return [pscustomobject]@{ Entries = $registry.Entries; Stale = "$why; using the registry snapshot of this wowget release." }
    }
    throw (New-WowgetError 'network' "The addon registry is not available: $why, and there is no registry snapshot.")
}

# The registry entry whose name or alias equals $Name after normalisation.
function Find-WowgetRegistryEntry {
    param([object[]]$Entries = @(), [Parameter(Mandatory)][string]$Name)
    $key = ConvertTo-WowgetNormalisedName $Name
    if (-not $key) { return $null }
    foreach ($e in $Entries) {
        if ((ConvertTo-WowgetNormalisedName $e.Name) -eq $key) { return $e }
        foreach ($alias in $e.Aliases) { if ((ConvertTo-WowgetNormalisedName $alias) -eq $key) { return $e } }
    }
    return $null
}
