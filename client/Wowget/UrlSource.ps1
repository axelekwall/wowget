# url: sources, resolved by the client (SPEC-MVP.md, "URL"). The release id is the file's SHA-256. The
# zip stays in the download cache; "<cache>/http/<sha1 of url>.json" keeps the validators and which file
# they belong to.

function Get-WowgetUrlRecordPath {
    param([Parameter(Mandatory)][string]$CacheDir, [Parameter(Mandatory)][string]$Url)
    $sha1 = [System.Convert]::ToHexString([System.Security.Cryptography.SHA1]::HashData([System.Text.Encoding]::UTF8.GetBytes($Url))).ToLowerInvariant()
    return [System.IO.Path]::Combine($CacheDir, 'http', "$sha1.json")
}

function Read-WowgetUrlRecord {
    param([Parameter(Mandatory)][string]$Path)
    if (-not [System.IO.File]::Exists($Path)) { return $null }
    try { $d = ConvertFrom-WowgetJson (Read-WowgetText $Path) } catch { return $null }
    if (-not (Test-WowgetJsonDictionary $d) -or -not (Test-WowgetNonEmptyString $d['sha256']) -or -not (Test-WowgetNonEmptyString $d['filename'])) { return $null }
    return [pscustomobject]@{ ETag = $d['etag']; LastModified = $d['lastModified']; Sha256 = $d['sha256']; Filename = $d['filename'] }
}

function Resolve-WowgetUrlSource {
    param(
        [Parameter(Mandatory)][string]$Addon,
        [Parameter(Mandatory)]$Spec,
        $Pin = $null,
        [Parameter(Mandatory)][string]$CacheDir,
        [scriptblock]$OnEvent
    )
    $recordPath = Get-WowgetUrlRecordPath $CacheDir $Spec.Url
    $record = Read-WowgetUrlRecord $recordPath
    $previousPath = if ($record) { Get-WowgetCachedZipPath $CacheDir $Addon $record.Sha256 $record.Filename } else { $null }
    $usable = $null -ne $previousPath -and [System.IO.File]::Exists($previousPath)

    $headers = @{}
    if ($usable) {
        if ($record.ETag) { $headers['If-None-Match'] = $record.ETag }
        if ($record.LastModified) { $headers['If-Modified-Since'] = $record.LastModified }
    }
    [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($recordPath))
    $part = "$recordPath.part-" + [System.IO.Path]::GetRandomFileName().Replace('.', '')
    try {
        $result = Invoke-WowgetDownload -Url $Spec.Url -OutFile $part -Headers $headers
        $response = $result.Response
        if ($response.StatusCode -eq 304 -and $headers.Count) {
            $sha256 = $record.Sha256
            $filename = $record.Filename
            $localPath = $previousPath
        } elseif ($response.StatusCode -eq 200) {
            if (-not (Test-WowgetZip $part)) {
                throw (New-WowgetError 'zip' "$($Spec.Url) did not return a readable zip.")
            }
            $sha256 = Get-WowgetFileHash $part
            $filename = Get-WowgetUrlLastSegment $Spec.Url
            if (-not $filename) { $filename = "$Addon.zip" }
            Invoke-WowgetEvent $OnEvent @{ type = 'download:start'; addon = $Addon; url = $Spec.Url; filename = $filename }
            $localPath = Get-WowgetCachedZipPath $CacheDir $Addon $sha256 $filename
            [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($localPath))
            [System.IO.File]::Move($part, $localPath, $true)
            $doc = [ordered]@{ etag = $response.Headers['ETag']; lastModified = $response.Headers['Last-Modified']; sha256 = $sha256; filename = $filename }
            Write-WowgetFileAtomic $recordPath ((ConvertTo-WowgetJsonText $doc) + "`n")
            Invoke-WowgetEvent $OnEvent @{ type = 'download:done'; addon = $Addon; bytes = ([System.IO.FileInfo]::new($localPath)).Length; sha256 = $sha256; cached = $false }
        } else {
            throw (New-WowgetError 'network' "GET $($Spec.Url) failed: HTTP $($response.StatusCode).")
        }
    } finally {
        [void](Remove-WowgetBestEffort $part)
    }

    if ($null -ne $Pin -and $Pin -cne $sha256) {
        throw (New-WowgetError 'source' "$($Spec.Url) now serves a file with sha256 $sha256, but the addon is pinned to $Pin.")
    }
    return [pscustomobject]@{
        Source = $Spec.Raw; ReleaseId = $sha256; Version = $sha256.Substring(0, 12); Filename = $filename
        DownloadUrl = $Spec.Url; FlavorVerified = $false; LocalPath = $localPath; Sha256 = $sha256; Md5 = $null
        AllowedHosts = $null; Note = $null; Folders = $null
    }
}
