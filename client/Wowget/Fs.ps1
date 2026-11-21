# File helpers: atomic writes through symlinks, the JSON text wowget writes, and the lock.

$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

# The file a write to $Path lands in: the final target when $Path is a symlink, so a manifest kept in a
# dotfiles repository is written through and the link itself is never replaced.
function Resolve-WowgetWriteTarget {
    param([Parameter(Mandatory)][string]$Path)
    $info = [System.IO.FileInfo]::new($Path)
    if ($null -ne $info.LinkTarget) {
        $final = $info.ResolveLinkTarget($true)
        if ($null -ne $final) { return $final.FullName }
    }
    return $info.FullName
}

# Replaces the file at $Path, or at its symlink target, with $Text as UTF-8 without BOM. The text goes
# to "<target>.tmp" first and is moved over the target, keeping the target's mode on macOS and Linux.
function Write-WowgetFileAtomic {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Text
    )
    $target = Resolve-WowgetWriteTarget $Path
    $tmp = "$target.tmp"
    $mode = $null
    if (-not $IsWindows -and [System.IO.File]::Exists($target)) { $mode = [System.IO.File]::GetUnixFileMode($target) }
    try {
        [System.IO.File]::WriteAllText($tmp, $Text, $script:Utf8NoBom)
        if ($null -ne $mode) { [System.IO.File]::SetUnixFileMode($tmp, $mode) }
        [System.IO.File]::Move($tmp, $target, $true)
    } catch {
        if ([System.IO.File]::Exists($tmp)) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
        throw
    }
}

function Read-WowgetText {
    param([Parameter(Mandatory)][string]$Path)
    return [System.IO.File]::ReadAllText($Path, $script:Utf8NoBom)
}

function Test-WowgetPath {
    param([Parameter(Mandatory)][string]$Path)
    # Also true for a dangling symlink, which still occupies the name.
    $info = [System.IO.FileInfo]::new($Path)
    return $info.Exists -or [System.IO.Directory]::Exists($Path) -or $null -ne $info.LinkTarget
}

function Test-WowgetDirectory {
    param([Parameter(Mandatory)][string]$Path)
    return [System.IO.Directory]::Exists($Path)
}

# Creates the directory; returns whether it was created.
function New-WowgetDirectory {
    param([Parameter(Mandatory)][string]$Path)
    if ([System.IO.Directory]::Exists($Path)) { return $false }
    if ([System.IO.File]::Exists($Path)) { throw (New-WowgetError 'io' "$Path exists and is not a directory.") }
    [void][System.IO.Directory]::CreateDirectory($Path)
    return $true
}

# A new, empty directory "<Parent>/<Prefix><random>", like mkdtemp.
function New-WowgetTempDirectory {
    param([Parameter(Mandatory)][string]$Parent, [Parameter(Mandatory)][string]$Prefix)
    for ($i = 0; $i -lt 10; $i++) {
        $path = [System.IO.Path]::Combine($Parent, $Prefix + [System.IO.Path]::GetRandomFileName().Replace('.', ''))
        if (-not (Test-WowgetPath $path)) {
            [void][System.IO.Directory]::CreateDirectory($path)
            return $path
        }
    }
    throw (New-WowgetError 'io' "Could not create a temporary directory in $Parent.")
}

# Deletes $Path recursively; returns $false instead of throwing when that fails.
function Remove-WowgetBestEffort {
    param([Parameter(Mandatory)][string]$Path)
    try {
        if ([System.IO.Directory]::Exists($Path)) { [System.IO.Directory]::Delete($Path, $true) }
        elseif ([System.IO.File]::Exists($Path)) { [System.IO.File]::Delete($Path) }
        return $true
    } catch {
        return $false
    }
}

# Whether an exception from renaming or deleting means the file is in use or not writable, as on
# Windows while the game has files in an addon folder open.
function Test-WowgetLockedException {
    param([Parameter(Mandatory)]$ErrorOrException)
    $ex = Get-WowgetException $ErrorOrException
    if ($ex -is [System.UnauthorizedAccessException]) { return $true }
    if ($ex -is [System.IO.IOException] -and -not ($ex -is [System.IO.FileNotFoundException]) -and -not ($ex -is [System.IO.DirectoryNotFoundException])) {
        # ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION, ERROR_DIR_NOT_EMPTY
        $win32 = $ex.HResult -band 0xFFFF
        if ($win32 -in 5, 32, 33, 145) { return $true }
    }
    return $false
}

function ConvertTo-WowgetJsonString {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
    $sb = [System.Text.StringBuilder]::new($Value.Length + 2)
    [void]$sb.Append('"')
    foreach ($c in $Value.ToCharArray()) {
        switch ($c) {
            '"' { [void]$sb.Append('\"'); continue }
            '\' { [void]$sb.Append('\\'); continue }
            "`n" { [void]$sb.Append('\n'); continue }
            "`r" { [void]$sb.Append('\r'); continue }
            "`t" { [void]$sb.Append('\t'); continue }
            "`b" { [void]$sb.Append('\b'); continue }
            "`f" { [void]$sb.Append('\f'); continue }
            default {
                if ([int]$c -lt 0x20) { [void]$sb.Append(('\u{0:x4}' -f [int]$c)) } else { [void]$sb.Append($c) }
            }
        }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

# JSON text with two-space indentation and LF line endings. Objects and arrays nested less than
# $MultilineDepth levels deep take one line per member; deeper ones are written on one line.
function ConvertTo-WowgetJsonText {
    param(
        [AllowNull()]$Value,
        [int]$MultilineDepth = 1,
        [int]$Depth = 0
    )
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { return $(if ($Value) { 'true' } else { 'false' }) }
    if ($Value -is [string]) { return ConvertTo-WowgetJsonString $Value }
    if ($Value -is [int] -or $Value -is [long]) { return $Value.ToString([System.Globalization.CultureInfo]::InvariantCulture) }
    if ($Value -is [double]) {
        # JSON has no infinity or NaN; such a value can only end up in a field that rejects it anyway.
        if ([double]::IsNaN($Value) -or [double]::IsInfinity($Value)) { return 'null' }
        return $Value.ToString('R', [System.Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $dict = [ordered]@{}
        foreach ($p in $Value.PSObject.Properties) { $dict[$p.Name] = $p.Value }
        $Value = $dict
    }
    $pad = '  ' * ($Depth + 1)
    $end = '  ' * $Depth
    $multi = $Depth -lt $MultilineDepth
    if ($Value -is [System.Collections.IDictionary]) {
        if ($Value.Count -eq 0) { return '{}' }
        $parts = foreach ($k in $Value.Keys) {
            (ConvertTo-WowgetJsonString ([string]$k)) + ': ' + (ConvertTo-WowgetJsonText $Value[$k] -MultilineDepth $MultilineDepth -Depth ($Depth + 1))
        }
        if ($multi) { return "{`n$pad" + ($parts -join ",`n$pad") + "`n$end}" }
        return '{ ' + ($parts -join ', ') + ' }'
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $parts = @(foreach ($item in $Value) { ConvertTo-WowgetJsonText $item -MultilineDepth $MultilineDepth -Depth ($Depth + 1) })
        if ($parts.Count -eq 0) { return '[]' }
        if ($multi) { return "[`n$pad" + ($parts -join ",`n$pad") + "`n$end]" }
        return '[' + ($parts -join ', ') + ']'
    }
    throw "Cannot write a value of type $($Value.GetType().FullName) as JSON."
}

# Parses JSON text into ordered hashtables, arrays and plain values. Date-like strings stay strings.
function ConvertFrom-WowgetJson {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    if ($Text.Trim() -eq '') { throw 'the file is empty' }
    return ConvertFrom-Json -InputObject $Text -AsHashtable -DateKind String -Depth 64 -NoEnumerate
}

# Takes the exclusive write lock "<StateDir>/wowget.lock". Waits up to $TimeoutMs for another wowget
# process to finish, then fails with a "locked" error. Dispose the returned stream to release it.
function Enter-WowgetLock {
    param([Parameter(Mandatory)][string]$StateDir, [int]$TimeoutMs = 10000)
    [void](New-WowgetDirectory $StateDir)
    $path = [System.IO.Path]::Combine($StateDir, 'wowget.lock')
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ($true) {
        try {
            return [System.IO.File]::Open($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        } catch {
            $ex = Get-WowgetException $_
            if (-not ($ex -is [System.IO.IOException])) { throw }
            if ([DateTime]::UtcNow -ge $deadline) {
                throw (New-WowgetError 'locked' "Another wowget process is running (it holds $path); try again when it has finished.")
            }
            Start-Sleep -Milliseconds 100
        }
    }
}
