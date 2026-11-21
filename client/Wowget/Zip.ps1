# Zip extraction with System.IO.Compression and addon-folder normalisation (SPEC-MVP.md, "Zip handling").

# Path segments of a zip entry name; throws on absolute paths and "..".
function Get-WowgetZipEntrySegments {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Name)
    $normalised = $Name.Replace('\', '/')
    if ($normalised.StartsWith('/') -or $normalised -match '^[A-Za-z]:') {
        throw (New-WowgetError 'zip' "Refusing zip entry with an absolute path: $Name")
    }
    $segments = @($normalised.Split('/') | Where-Object { $_ -ne '' -and $_ -ne '.' })
    if ($segments -contains '..') {
        throw (New-WowgetError 'zip' "Refusing zip entry that escapes the target directory: $Name")
    }
    return $segments
}

function Open-WowgetZip {
    param([Parameter(Mandatory)][string]$Path)
    try {
        return [System.IO.Compression.ZipFile]::OpenRead($Path)
    } catch {
        throw (New-WowgetError 'zip' "Could not read zip: $(Get-WowgetErrorMessage $_)")
    }
}

# Whether $Path is a zip whose entries can all be read.
function Test-WowgetZip {
    param([Parameter(Mandatory)][string]$Path)
    try {
        $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
    } catch {
        return $false
    }
    try {
        $buffer = [byte[]]::new(81920)
        foreach ($entry in $archive.Entries) {
            $stream = $entry.Open()
            try { while ($stream.Read($buffer, 0, $buffer.Length) -gt 0) { } } finally { $stream.Dispose() }
        }
        return $true
    } catch {
        return $false
    } finally {
        $archive.Dispose()
    }
}

# Extracts $Path into $Dest. All entries are checked before anything is written.
function Expand-WowgetZip {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Dest)
    $archive = Open-WowgetZip $Path
    try {
        $plan = foreach ($entry in $archive.Entries) {
            $name = $entry.FullName
            [pscustomobject]@{
                Entry    = $entry
                Segments = @(Get-WowgetZipEntrySegments $name)
                IsDir    = $name.EndsWith('/') -or $name.EndsWith('\')
            }
        }
        foreach ($item in @($plan)) {
            if ($item.Segments.Count -eq 0) { continue }
            $target = [System.IO.Path]::Combine([string[]](@($Dest) + $item.Segments))
            if ($item.IsDir) {
                [void][System.IO.Directory]::CreateDirectory($target)
                continue
            }
            [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target))
            try {
                [System.IO.Compression.ZipFileExtensions]::ExtractToFile($item.Entry, $target, $true)
            } catch {
                if (Test-WowgetLockedException $_) { throw }
                throw (New-WowgetError 'zip' "Could not read zip: $(Get-WowgetErrorMessage $_)")
            }
        }
    } finally {
        $archive.Dispose()
    }
}

function Test-WowgetAddonFolder {
    param([Parameter(Mandatory)][string]$Dir)
    return @(Get-WowgetAddonTocs $Dir).Count -gt 0
}

function Get-WowgetSubdirectories {
    param([Parameter(Mandatory)][string]$Dir)
    $names = foreach ($d in [System.IO.Directory]::GetDirectories($Dir)) {
        $n = [System.IO.Path]::GetFileName($d)
        if ($n -ne '__MACOSX' -and -not $n.StartsWith('.')) { $n }
    }
    $sorted = [string[]]@($names)
    [Array]::Sort($sorted, [System.StringComparer]::Ordinal)
    return $sorted
}

# Addon folders under an extracted zip: those at the top level, or, when the top level is a single
# directory that is not an addon folder, those one level below it.
function Find-WowgetAddonFolders {
    param([Parameter(Mandatory)][string]$Root)
    $collect = {
        param($dir)
        $found = foreach ($name in @(Get-WowgetSubdirectories $dir)) {
            $path = [System.IO.Path]::Combine($dir, $name)
            if (Test-WowgetAddonFolder $path) { [pscustomobject]@{ Name = $name; Path = $path } }
        }
        @($found)
    }
    $folders = @(& $collect $Root)
    if ($folders.Count -eq 0) {
        $top = @(Get-WowgetSubdirectories $Root)
        if ($top.Count -eq 1) { $folders = @(& $collect ([System.IO.Path]::Combine($Root, $top[0]))) }
    }
    if ($folders.Count -eq 0) {
        throw (New-WowgetError 'zip' 'The zip contains no addon folder (a directory with a matching .toc file).')
    }
    return $folders
}

function Expand-WowgetAddons {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Dest)
    Expand-WowgetZip $Path $Dest
    return Find-WowgetAddonFolders $Dest
}
