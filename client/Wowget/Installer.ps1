# Download cache, staging, folder swap with rollback, and uninstall (SPEC-POWERSHELL.md, "Installer").
#
# A resolved release is a [pscustomobject] with Source, ReleaseId, Version, Filename, DownloadUrl,
# FlavorVerified, and optionally Sha256 and Md5 (checksums a download must match), LocalPath (a file
# already on disk), AllowedHosts (download hosts; $null allows any http or https URL) and Note.

# A single path segment made from an arbitrary id or filename, valid on every platform: Windows
# rejects the characters <>:"/\|?* and control characters, drops trailing dots and spaces, and
# reserves device names such as CON or COM1 with any extension.
function Get-WowgetSafeSegment {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
    $cleaned = $Value -replace '[<>:"/\\|?*\x00-\x1f]', '_'
    $cleaned = $cleaned -replace '[. ]+$', { '_' * $_.Value.Length }
    if ($cleaned -eq '') { return '_' }
    if ($cleaned -match '^(?i:CON|PRN|AUX|NUL|COM[0-9\u00b9\u00b2\u00b3]|LPT[0-9\u00b9\u00b2\u00b3])(\.|$)') { return "_$cleaned" }
    return $cleaned
}

# Every cached release of an addon: "<cache>/<addon, lower-case>".
function Get-WowgetAddonCacheDir {
    param([Parameter(Mandatory)][string]$CacheDir, [Parameter(Mandatory)][string]$Addon)
    return [System.IO.Path]::Combine($CacheDir, (Get-WowgetSafeSegment $Addon.ToLowerInvariant()))
}

# Where a release's zip lives in the cache: "<cache>/<addon>/<releaseId>/<filename>".
function Get-WowgetCachedZipPath {
    param([Parameter(Mandatory)][string]$CacheDir, [Parameter(Mandatory)][string]$Addon, [Parameter(Mandatory)][string]$ReleaseId, [Parameter(Mandatory)][string]$Filename)
    $leaf = Get-WowgetSafeSegment ([System.IO.Path]::GetFileName($Filename.Replace('\', '/')))
    return [System.IO.Path]::Combine((Get-WowgetAddonCacheDir $CacheDir $Addon), (Get-WowgetSafeSegment $ReleaseId), $leaf)
}

function Get-WowgetFileHash {
    param([Parameter(Mandatory)][string]$Path, [ValidateSet('SHA256', 'MD5')][string]$Algorithm = 'SHA256')
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $bytes = if ($Algorithm -eq 'MD5') { [System.Security.Cryptography.MD5]::HashData($stream) } else { [System.Security.Cryptography.SHA256]::HashData($stream) }
    } finally {
        $stream.Dispose()
    }
    return [System.Convert]::ToHexString($bytes).ToLowerInvariant()
}

function Invoke-WowgetEvent {
    param([scriptblock]$OnEvent, [Parameter(Mandatory)][hashtable]$Fields)
    if ($null -ne $OnEvent) { & $OnEvent ([pscustomobject]$Fields) }
}

# The error for a download that is a web page rather than a zip, or $null. WoWInterface lists a new
# upload before moderators approve it and serves a page saying so until then.
function Get-WowgetWebPageError {
    param([Parameter(Mandatory)]$Resolved, [Parameter(Mandatory)][string]$Path)
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $buffer = [byte[]]::new(1024)
        $read = $stream.Read($buffer, 0, $buffer.Length)
    } finally {
        $stream.Dispose()
    }
    $head = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read).TrimStart().ToLowerInvariant()
    if (-not ($head.StartsWith('<!doctype html') -or $head.Contains('<html'))) { return $null }
    if ($Resolved.Source.StartsWith('wowi:')) {
        return New-WowgetError 'network' "WoWInterface served a web page instead of $($Resolved.Filename); the new version is probably still awaiting approval there. Try again later."
    }
    return New-WowgetError 'network' "$($Resolved.DownloadUrl) returned a web page instead of the zip $($Resolved.Filename)."
}

function Get-WowgetResolvedValue {
    param($Resolved, [string]$Name)
    $p = $Resolved.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
}

# The cache path of a release and its SHA-256, downloading or copying it there if needed. Only
# readable zips that match the expected checksums are stored; a cached file that is not a readable zip
# is deleted and fetched again.
function Save-WowgetRelease {
    param([Parameter(Mandatory)][string]$Addon, [Parameter(Mandatory)]$Resolved, [Parameter(Mandatory)][string]$CacheDir, [scriptblock]$OnEvent)
    $zipPath = Get-WowgetCachedZipPath $CacheDir $Addon $Resolved.ReleaseId $Resolved.Filename
    $expected = Get-WowgetResolvedValue $Resolved 'Sha256'
    if ($expected) { $expected = $expected.ToLowerInvariant() }
    $expectedMd5 = Get-WowgetResolvedValue $Resolved 'Md5'
    if ($expectedMd5) { $expectedMd5 = $expectedMd5.ToLowerInvariant() }

    if ([System.IO.File]::Exists($zipPath)) {
        $hash = Get-WowgetFileHash $zipPath
        $readable = Test-WowgetZip $zipPath
        $md5Ok = -not $expectedMd5 -or (Get-WowgetFileHash $zipPath 'MD5') -eq $expectedMd5
        if ((-not $expected -or $hash -eq $expected) -and $md5Ok -and $readable) {
            Invoke-WowgetEvent $OnEvent @{ type = 'download:done'; addon = $Addon; bytes = ([System.IO.FileInfo]::new($zipPath)).Length; sha256 = $hash; cached = $true }
            return [pscustomobject]@{ ZipPath = $zipPath; Sha256 = $hash }
        }
        if (-not $readable) { [void](Remove-WowgetBestEffort $zipPath) }
    }
    # The local file may be the cached copy that was just deleted; download it again then.
    $localPath = Get-WowgetResolvedValue $Resolved 'LocalPath'
    if ($localPath -and -not [System.IO.File]::Exists($localPath)) { $localPath = $null }

    [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($zipPath))
    $part = "$zipPath.part-" + [System.IO.Path]::GetRandomFileName().Replace('.', '')
    try {
        if ($localPath) {
            [System.IO.File]::Copy($localPath, $part, $true)
        } else {
            Invoke-WowgetEvent $OnEvent @{ type = 'download:start'; addon = $Addon; url = $Resolved.DownloadUrl; filename = $Resolved.Filename }
            $result = Invoke-WowgetDownload -Url $Resolved.DownloadUrl -OutFile $part -AllowedHosts (Get-WowgetResolvedValue $Resolved 'AllowedHosts')
            if ($result.Response.StatusCode -ne 200) {
                throw (New-WowgetError 'network' "Download of $($Resolved.DownloadUrl) failed: HTTP $($result.Response.StatusCode).")
            }
        }
        # Checked before the checksums, so a web page served in place of the zip is not reported as corruption.
        if (-not (Test-WowgetZip $part)) {
            $page = Get-WowgetWebPageError $Resolved $part
            if ($page) { throw $page }
            throw (New-WowgetError 'zip' "Could not read zip: $($Resolved.Filename) is not a readable zip file.")
        }
        $hash = Get-WowgetFileHash $part
        if ($expected -and $hash -ne $expected) {
            throw (New-WowgetError 'network' "Checksum mismatch for $($Resolved.Filename): expected $expected, got $hash.")
        }
        if ($expectedMd5 -and (Get-WowgetFileHash $part 'MD5') -ne $expectedMd5) {
            throw (New-WowgetError 'network' "Checksum mismatch for $($Resolved.Filename): the source lists MD5 $expectedMd5.")
        }
        [System.IO.File]::Move($part, $zipPath, $true)
        Invoke-WowgetEvent $OnEvent @{ type = 'download:done'; addon = $Addon; bytes = ([System.IO.FileInfo]::new($zipPath)).Length; sha256 = $hash; cached = $false }
        return [pscustomobject]@{ ZipPath = $zipPath; Sha256 = $hash }
    } finally {
        [void](Remove-WowgetBestEffort $part)
    }
}

function Test-WowgetPlainName {
    param([AllowEmptyString()][string]$Name)
    return $Name -ne '' -and $Name -ne '.' -and $Name -ne '..' -and $Name -notmatch '[/\\]'
}

function New-WowgetLockedError {
    param([string]$Addon, [string]$Path, $ErrorRecord)
    return New-WowgetError 'locked' "${Addon}: $Path is in use or not writable ($(Get-WowgetErrorMessage $ErrorRecord)); close World of Warcraft and try again." (Get-WowgetException $ErrorRecord)
}

# Entries of an AddOns directory that are not hidden, keyed by lower-case name.
function Get-WowgetDirEntries {
    param([Parameter(Mandatory)][string]$Dir)
    $map = @{}
    foreach ($path in [System.IO.Directory]::GetFileSystemEntries($Dir)) {
        $name = [System.IO.Path]::GetFileName($path)
        if (-not $name.StartsWith('.')) { $map[$name.ToLowerInvariant()] = $name }
    }
    return $map
}

# Installs a resolved release into $TargetDir: download into the cache, extract into a temporary
# directory next to the AddOns folders, check flavor and ownership, write the marker into every new
# folder, and swap the folders in. A failed swap puts the previous folders back.
function Install-WowgetRelease {
    param(
        [Parameter(Mandatory)][string]$Addon,
        [Parameter(Mandatory)]$Resolved,
        [Parameter(Mandatory)][string]$TargetDir,
        [Parameter(Mandatory)][string]$Flavor,
        [Parameter(Mandatory)][string]$CacheDir,
        [switch]$Force,
        # Keep the previous copies of replaced folders in OldDir instead of deleting them.
        [switch]$KeepOld,
        # Unmanaged folders this install may replace without -Force (adopting hand-installed copies).
        [string[]]$AdoptFolders = @(),
        [scriptblock]$OnEvent
    )
    if (-not [System.IO.Directory]::Exists($TargetDir)) {
        throw (New-WowgetError 'io' "Install path $TargetDir does not exist or is not a directory.")
    }
    $saved = Save-WowgetRelease -Addon $Addon -Resolved $Resolved -CacheDir $CacheDir -OnEvent $OnEvent
    $markers = Get-WowgetTargetMarkers $TargetDir
    $previous = Get-WowgetInstall $markers $Addon

    $tmpDir = New-WowgetTempDirectory $TargetDir '.wowget-tmp-'
    try {
        Invoke-WowgetEvent $OnEvent @{ type = 'extract'; addon = $Addon }
        $extracted = @(Expand-WowgetAddons $saved.ZipPath $tmpDir)
        $folders = [string[]]@($extracted | ForEach-Object Name)

        Invoke-WowgetEvent $OnEvent @{ type = 'verify'; addon = $Addon; folders = $folders }
        if (-not $Resolved.FlavorVerified) {
            foreach ($folder in $extracted) {
                $support = Test-WowgetFolderFlavor $folder.Path $Flavor
                if ($support -eq 'no') {
                    throw (New-WowgetError 'flavor' "${Addon}: folder $($folder.Name) has no TOC for flavor `"$Flavor`".")
                }
                if ($support -eq 'unknown' -and -not $Force) {
                    throw (New-WowgetError 'flavor' "${Addon}: cannot tell whether folder $($folder.Name) supports flavor `"$Flavor`"; use --force to install anyway.")
                }
            }
        }

        $onDisk = Get-WowgetDirEntries $TargetDir
        if (-not $Force) {
            foreach ($name in $folders) {
                $existingName = $onDisk[$name.ToLowerInvariant()]
                if (-not $existingName) { continue }
                $entry = $markers[$existingName]
                if ($null -ne $entry -and $entry.Status -eq 'ok' -and $entry.Marker.Addon -eq $Addon) { continue }
                $managed = $null -ne $entry -and $entry.Status -eq 'ok'
                if (-not $managed -and ($AdoptFolders -contains $name)) { continue }
                $owner = if ($managed) { "belongs to `"$($entry.Marker.Addon)`"" } else { 'is not managed by wowget' }
                throw (New-WowgetError 'conflict' "${Addon}: folder $existingName already exists in $TargetDir and $owner; use --force to replace it.")
            }
        }

        $newKeys = @($folders | ForEach-Object { $_.ToLowerInvariant() })
        $stale = @()
        if ($previous) { $stale = @($previous.Folders | Where-Object { $newKeys -notcontains $_.ToLowerInvariant() -and (Test-WowgetPlainName $_) }) }

        # A reinstall of the same release keeps the older release as the one to roll back to.
        $previousRelease = $null
        if ($previous) {
            $same = $previous.ReleaseId -ceq $Resolved.ReleaseId -and $previous.Source -ceq $Resolved.Source
            $previousRelease = if ($same) { $previous.Previous } else { Get-WowgetMarkerRelease $previous }
        }
        $marker = New-WowgetMarker -Addon $Addon -Source $Resolved.Source -ReleaseId $Resolved.ReleaseId -AddonVersion $Resolved.Version `
            -Filename $Resolved.Filename -Sha256 $saved.Sha256 -Folders $folders -Previous $previousRelease
        foreach ($folder in $extracted) { Write-WowgetMarker $folder.Path $marker }

        Invoke-WowgetEvent $OnEvent @{ type = 'swap'; addon = $Addon; folders = $folders }
        $oldDir = New-WowgetTempDirectory $TargetDir '.wowget-old-'
        $movedOld = [System.Collections.Generic.List[string]]::new()
        $placed = [System.Collections.Generic.List[string]]::new()
        $removedFolders = [System.Collections.Generic.List[string]]::new()
        # The folder being moved when a rename fails, for the error message.
        $moving = $TargetDir
        try {
            foreach ($folder in $extracted) {
                $existingName = $onDisk[$folder.Name.ToLowerInvariant()]
                if ($existingName -and (Test-WowgetPath ([System.IO.Path]::Combine($TargetDir, $existingName)))) {
                    $moving = [System.IO.Path]::Combine($TargetDir, $existingName)
                    [System.IO.Directory]::Move($moving, [System.IO.Path]::Combine($oldDir, $existingName))
                    $movedOld.Add($existingName)
                }
                $moving = [System.IO.Path]::Combine($TargetDir, $folder.Name)
                [System.IO.Directory]::Move($folder.Path, $moving)
                $placed.Add($folder.Name)
            }
            foreach ($name in $stale) {
                # Another addon may have taken the folder over with --force; leave it alone then.
                $entry = $markers[$name]
                if ($null -ne $entry -and $entry.Status -eq 'ok' -and $entry.Marker.Addon -ne $Addon) { continue }
                $existingName = $onDisk[$name.ToLowerInvariant()]
                if (-not $existingName) { continue }
                $path = [System.IO.Path]::Combine($TargetDir, $existingName)
                if (-not (Test-WowgetPath $path)) { continue }
                $moving = $path
                [System.IO.Directory]::Move($moving, [System.IO.Path]::Combine($oldDir, $existingName))
                $movedOld.Add($existingName)
                $removedFolders.Add($name)
            }
        } catch {
            $failure = $_
            $unrestored = [System.Collections.Generic.List[string]]::new()
            foreach ($name in $placed) { [void](Remove-WowgetBestEffort ([System.IO.Path]::Combine($TargetDir, $name))) }
            foreach ($name in $movedOld) {
                try { [System.IO.Directory]::Move([System.IO.Path]::Combine($oldDir, $name), [System.IO.Path]::Combine($TargetDir, $name)) }
                catch { $unrestored.Add($name) }
            }
            if ($unrestored.Count) {
                throw (New-WowgetError 'io' "${Addon}: install failed ($(Get-WowgetErrorMessage $failure)) and restoring $($unrestored -join ', ') also failed; the previous copies are in $oldDir.")
            }
            [void](Remove-WowgetBestEffort $oldDir)
            if (Test-WowgetLockedException $failure) { throw (New-WowgetLockedError $Addon $moving $failure) }
            throw $failure
        }
        # The install is in place, so failing to delete the previous copies must not fail it.
        $leftover = $null
        if (-not $KeepOld -and -not (Remove-WowgetBestEffort $oldDir)) { $leftover = $oldDir }

        Invoke-WowgetEvent $OnEvent @{ type = 'done'; addon = $Addon; releaseId = $Resolved.ReleaseId; folders = $folders }
        return [pscustomobject]@{
            Addon = $Addon; ReleaseId = $Resolved.ReleaseId; Version = $Resolved.Version; Folders = $folders
            RemovedFolders = $removedFolders.ToArray(); ZipPath = $saved.ZipPath; Sha256 = $saved.Sha256
            LeftoverDir = $leftover; OldDir = $(if ($KeepOld) { $oldDir } else { $null })
        }
    } finally {
        # Best effort, so that a cleanup failure does not hide the error that got here.
        [void](Remove-WowgetBestEffort $tmpDir)
    }
}

# Removes the folders whose marker names $Addon. They are all moved aside first, so a locked folder
# leaves the install whole rather than half deleted.
function Uninstall-WowgetAddon {
    param([Parameter(Mandatory)][string]$TargetDir, [Parameter(Mandatory)][string]$Addon)
    $markers = Get-WowgetTargetMarkers $TargetDir
    $folders = @($markers.Values | Where-Object { $_.Status -eq 'ok' -and $_.Marker.Addon -eq $Addon } | ForEach-Object Folder | Sort-Object)
    if ($folders.Count -eq 0) {
        return [pscustomobject]@{ Addon = $Addon; RemovedFolders = [string[]]@(); WasInstalled = $false; LeftoverDir = $null }
    }
    try {
        $holdDir = New-WowgetTempDirectory $TargetDir '.wowget-old-'
    } catch {
        if (Test-WowgetLockedException $_) { throw (New-WowgetLockedError $Addon $TargetDir $_) }
        throw
    }
    $moved = [System.Collections.Generic.List[string]]::new()
    foreach ($folder in $folders) {
        try {
            [System.IO.Directory]::Move([System.IO.Path]::Combine($TargetDir, $folder), [System.IO.Path]::Combine($holdDir, $folder))
            $moved.Add($folder)
        } catch {
            $failure = $_
            $unrestored = [System.Collections.Generic.List[string]]::new()
            foreach ($name in $moved) {
                try { [System.IO.Directory]::Move([System.IO.Path]::Combine($holdDir, $name), [System.IO.Path]::Combine($TargetDir, $name)) }
                catch { $unrestored.Add($name) }
            }
            if ($unrestored.Count) {
                throw (New-WowgetError 'io' "${Addon}: uninstall failed ($(Get-WowgetErrorMessage $failure)) and restoring $($unrestored -join ', ') also failed; they are in $holdDir.")
            }
            [void](Remove-WowgetBestEffort $holdDir)
            if (Test-WowgetLockedException $failure) { throw (New-WowgetLockedError $Addon ([System.IO.Path]::Combine($TargetDir, $folder)) $failure) }
            throw $failure
        }
    }
    $leftover = if (Remove-WowgetBestEffort $holdDir) { $null } else { $holdDir }
    return [pscustomobject]@{ Addon = $Addon; RemovedFolders = $moved.ToArray(); WasInstalled = $true; LeftoverDir = $leftover }
}

# Deletes cached releases of $Addon that none of $Installs (installs of the addon on the targets on this
# machine) names as current or previous. Returns the deleted directories.
function Remove-WowgetUnusedCache {
    param([Parameter(Mandatory)][string]$CacheDir, [Parameter(Mandatory)][string]$Addon, [object[]]$Installs = @())
    $addonDir = Get-WowgetAddonCacheDir $CacheDir $Addon
    # Dot entries are not addon caches, even for an addon whose name starts with ".".
    if ([System.IO.Path]::GetFileName($addonDir).StartsWith('.') -or -not [System.IO.Directory]::Exists($addonDir)) { return @() }
    $kept = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($install in $Installs) {
        if ($null -eq $install) { continue }
        [void]$kept.Add([System.IO.Path]::GetDirectoryName((Get-WowgetCachedZipPath $CacheDir $Addon $install.ReleaseId $install.Filename)))
        if ($install.Previous) {
            [void]$kept.Add([System.IO.Path]::GetDirectoryName((Get-WowgetCachedZipPath $CacheDir $Addon $install.Previous.ReleaseId $install.Previous.Filename)))
        }
    }
    $removed = foreach ($dir in [System.IO.Directory]::GetDirectories($addonDir)) {
        if ($kept.Contains($dir)) { continue }
        if (Remove-WowgetBestEffort $dir) { $dir }
    }
    if (@([System.IO.Directory]::GetFileSystemEntries($addonDir)).Count -eq 0) { [void](Remove-WowgetBestEffort $addonDir) }
    return @($removed)
}
