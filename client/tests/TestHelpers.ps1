# Shared test helpers, dot-sourced inside InModuleScope so they can reach the module's functions.
# Every test works in its own temporary directory and never touches the network: HTTP goes to the fake
# set with Set-WgFakeHttp.

function New-WgTestDirs {
    $root = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'wowget-test-' + [System.IO.Path]::GetRandomFileName().Replace('.', ''))
    [void][System.IO.Directory]::CreateDirectory($root)
    # A real path, so comparisons with resolved paths hold on macOS where the temp dir is a symlink.
    $root = Resolve-WowgetExistingPath $root
    $dirs = [pscustomobject]@{
        Root     = $root
        Manifest = [System.IO.Path]::Combine($root, 'config', 'wowget.json')
        Cache    = [System.IO.Path]::Combine($root, 'cache')
        State    = [System.IO.Path]::Combine($root, 'state')
        Game     = [System.IO.Path]::Combine($root, 'game')
    }
    return $dirs
}

function Remove-WgTestDirs {
    param($Dirs)
    if ($Dirs -and [System.IO.Directory]::Exists($Dirs.Root)) { [System.IO.Directory]::Delete($Dirs.Root, $true) }
}

# A directory under the test root, created.
function New-WgDir {
    param($Dirs, [string[]]$Parts)
    $path = [System.IO.Path]::Combine([string[]](@($Dirs.Root) + $Parts))
    [void][System.IO.Directory]::CreateDirectory($path)
    return $path
}

# Writes a zip with the given entries: name -> text (a name ending in "/" is a directory).
function New-WgZip {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][System.Collections.IDictionary]$Entries)
    [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($Path))
    $stream = [System.IO.File]::Create($Path)
    try {
        $zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($name in $Entries.Keys) {
                $entry = $zip.CreateEntry($name)
                if ($name.EndsWith('/')) { continue }
                $writer = [System.IO.StreamWriter]::new($entry.Open(), [System.Text.UTF8Encoding]::new($false))
                try { $writer.Write([string]$Entries[$name]) } finally { $writer.Dispose() }
            }
        } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }
    return $Path
}

# The bytes of a zip with one addon folder per key of $Folders, each with a TOC listing the given
# interface list (default: classic and forever) and a file holding $Content.
function New-WgAddonZipBytes {
    param([Parameter(Mandatory)][hashtable]$Folders, [string]$Content = 'v1', [string]$Prefix = '')
    $entries = [ordered]@{}
    foreach ($name in ($Folders.Keys | Sort-Object)) {
        $iface = if ($Folders[$name]) { $Folders[$name] } else { '11507, 16000' }
        $entries["$Prefix$name/$name.toc"] = "## Interface: $iface`n## Title: $name`n"
        $entries["$Prefix$name/code.lua"] = $Content
    }
    $tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'wowget-zip-' + [System.IO.Path]::GetRandomFileName() + '.zip')
    try {
        [void](New-WgZip -Path $tmp -Entries $entries)
        return , [System.IO.File]::ReadAllBytes($tmp)
    } finally {
        [System.IO.File]::Delete($tmp)
    }
}

function Get-WgSha256 {
    param([byte[]]$Bytes)
    return [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function Get-WgMd5 {
    param([byte[]]$Bytes)
    return [System.Convert]::ToHexString([System.Security.Cryptography.MD5]::HashData($Bytes)).ToLowerInvariant()
}

# Routes the module's HTTP layer to $script:WgRoutes (URL -> response hashtable, or a script block
# that receives the request and returns one). Unknown URLs answer 404. Requests are recorded in
# $script:WgRequests.
function Set-WgFakeHttp {
    $script:WgRoutes = @{}
    $script:WgRequests = [System.Collections.Generic.List[object]]::new()
    $script:WowgetHttpFake = {
        param($request)
        $script:WgRequests.Add($request)
        $handler = $script:WgRoutes[$request.Uri]
        if ($null -eq $handler) { return @{ StatusCode = 404; Body = 'not found' } }
        if ($handler -is [scriptblock]) { return & $handler $request }
        return $handler
    }
}

function Clear-WgFakeHttp {
    $script:WowgetHttpFake = $null
}

# Serves a fake /v1/resolve: $script:WgReleases maps "source|flavor" (or "source|*" for every flavor)
# to a result hashtable, or to a script block that receives the item. Each request's items are
# recorded in $script:WgResolveBatches.
function Set-WgFakeService {
    param([string]$ApiUrl = 'https://api.test')
    $script:WgReleases = @{}
    $script:WgResolveBatches = [System.Collections.Generic.List[object]]::new()
    $script:WgRoutes["$ApiUrl/v1/resolve"] = {
        param($request)
        $doc = ConvertFrom-Json $request.Body -AsHashtable
        $script:WgResolveBatches.Add(@($doc['items']))
        $results = foreach ($item in $doc['items']) {
            $value = $script:WgReleases["$($item['source'])|$($item['flavor'])"]
            if ($null -eq $value) { $value = $script:WgReleases["$($item['source'])|*"] }
            if ($value -is [scriptblock]) { $value = & $value $item }
            if ($null -eq $value) { $value = @{ ok = $false; error = @{ code = 'not_found'; message = "no release for $($item['source'])" } } }
            $value
        }
        return @{ StatusCode = 200; Headers = @{ 'Content-Type' = 'application/json' }; Body = (ConvertTo-Json -InputObject @{ results = @($results) } -Depth 10) }
    }
}

# Publishes a release on the fake service and its zip on a fake download host. Returns the zip bytes.
function Add-WgRelease {
    param(
        [Parameter(Mandatory)][string]$Source,
        [string]$Flavor = '*',
        [Parameter(Mandatory)][string]$ReleaseId,
        [byte[]]$Bytes,
        [hashtable]$Folders = @{ Addon = '11507' },
        [bool]$FlavorVerified = $true,
        [switch]$NoSha
    )
    if (-not $Bytes) { $Bytes = New-WgAddonZipBytes -Folders $Folders -Content $ReleaseId }
    $filename = "$($Source -replace '[^A-Za-z0-9]', '-')-$ReleaseId.zip"
    $url = "https://github.com/dl/$filename"
    $script:WgRoutes[$url] = @{ StatusCode = 200; Body = $Bytes }
    $script:WgReleases["$Source|$Flavor"] = @{
        ok = $true; releaseId = $ReleaseId; version = $ReleaseId.TrimStart('v'); filename = $filename; url = $url
        sha256 = $(if ($NoSha) { $null } else { Get-WgSha256 $Bytes }); md5 = $null; size = $Bytes.Length
        publishedAt = '2026-11-20T10:00:00Z'; flavorVerified = $FlavorVerified; folders = $null
    }
    return , $Bytes
}

# Serves a url: source zip at $Url.
function Set-WgUrlZip {
    param([Parameter(Mandatory)][string]$Url, [Parameter(Mandatory)][byte[]]$Bytes, [string]$ETag = $null)
    $headers = @{}
    if ($ETag) { $headers['ETag'] = $ETag }
    $script:WgRoutes[$Url] = {
        param($request)
        if ($ETag -and $request.Headers['If-None-Match'] -eq $ETag) { return @{ StatusCode = 304; Headers = $headers } }
        return @{ StatusCode = 200; Headers = $headers; Body = $Bytes }
    }.GetNewClosure()
}

# Ops options for the test directories, with events collected in $script:WgEvents.
function New-WgOptions {
    param([Parameter(Mandatory)]$Dirs, [string[]]$Targets = @(), [switch]$Force, [string[]]$GameDirs = @())
    $script:WgEvents = [System.Collections.Generic.List[object]]::new()
    return @{
        ManifestPath = $Dirs.Manifest
        CacheDir     = $Dirs.Cache
        Env          = @{ WOWGET_STATE_DIR = $Dirs.State; WOWGET_CACHE_DIR = $Dirs.Cache; WOWGET_MANIFEST = $Dirs.Manifest }
        GameDirs     = $GameDirs
        ApiUrl       = 'https://api.test'
        Targets      = $Targets
        Force        = [bool]$Force
        OnEvent      = { param($e) $script:WgEvents.Add($e) }
    }
}

# Creates a manifest with path targets (name -> flavor) under the test root; returns the AddOns paths.
function New-WgManifest {
    param([Parameter(Mandatory)]$Dirs, [System.Collections.IDictionary]$Targets = [ordered]@{ forever = 'forever' })
    $list = foreach ($name in $Targets.Keys) {
        $path = New-WgDir $Dirs @('wow', $name, 'Interface', 'AddOns')
        New-WowgetTarget -Name $name -Path $path -Flavor $Targets[$name]
    }
    [void](New-WowgetManifestFile $Dirs.Manifest @($list))
    $paths = @{}
    foreach ($t in $list) { $paths[$t.Name] = $t.Path }
    return $paths
}

# Runs the CLI in-process; returns Exit, Out and Err.
function Invoke-WgCli {
    param([Parameter(Mandatory)]$Dirs, [string[]]$Argv, [hashtable]$ExtraEnv = @{}, [int]$LockTimeoutMs = 10000)
    $envTable = @{ WOWGET_STATE_DIR = $Dirs.State; WOWGET_CACHE_DIR = $Dirs.Cache; WOWGET_MANIFEST = $Dirs.Manifest; WOWGET_API_URL = 'https://api.test'; WOWGET_GAME_DIR = $Dirs.Game; HOME = $Dirs.Root; USERPROFILE = $Dirs.Root }
    foreach ($k in $ExtraEnv.Keys) { $envTable[$k] = $ExtraEnv[$k] }
    $out = [System.IO.StringWriter]::new()
    $err = [System.IO.StringWriter]::new()
    $code = Invoke-WowgetCli -Argv $Argv -Env $envTable -Stdout $out -Stderr $err -LockTimeoutMs $LockTimeoutMs
    return [pscustomobject]@{ Exit = $code; Out = $out.ToString(); Err = $err.ToString() }
}

# The WowgetError code thrown by $Script, or $null when it does not throw a WowgetError.
function Get-WgErrorCode {
    param([Parameter(Mandatory)][scriptblock]$Script)
    try { & $Script | Out-Null } catch { return Get-WowgetErrorCode $_ }
    return '<no error>'
}

function Get-WgErrorText {
    param([Parameter(Mandatory)][scriptblock]$Script)
    try { & $Script | Out-Null } catch { return Get-WowgetErrorMessage $_ }
    return '<no error>'
}

function Get-WgFolders {
    param([Parameter(Mandatory)][string]$Dir)
    $names = foreach ($d in [System.IO.Directory]::GetDirectories($Dir)) { [System.IO.Path]::GetFileName($d) }
    return [string[]]@($names | Sort-Object)
}
