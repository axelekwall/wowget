# Default locations, environment overrides and game directory detection. Every function takes the
# platform ('Windows', 'MacOS' or 'Linux') and the environment as parameters, so tests cover all three
# platforms without touching real locations.

function Get-WowgetPlatform {
    if ($IsWindows) { return 'Windows' }
    if ($IsMacOS) { return 'MacOS' }
    return 'Linux'
}

# The process environment as a hashtable (case-insensitive, as Windows variable names are).
function Get-WowgetProcessEnv {
    $envTable = @{}
    foreach ($entry in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) { $envTable[[string]$entry.Key] = [string]$entry.Value }
    return $envTable
}

function Get-WowgetEnvValue {
    param([Parameter(Mandatory)][hashtable]$Env, [Parameter(Mandatory)][string]$Name)
    $value = $Env[$Name]
    if ([string]::IsNullOrEmpty($value)) { return $null }
    return [string]$value
}

function Join-WowgetPathFor {
    param([Parameter(Mandatory)][string]$Platform, [Parameter(Mandatory)][string[]]$Parts)
    $sep = if ($Platform -eq 'Windows') { '\' } else { '/' }
    $out = $Parts[0]
    for ($i = 1; $i -lt $Parts.Count; $i++) {
        $out = $out.TrimEnd('\', '/') + $sep + $Parts[$i].TrimStart('\', '/')
    }
    return $out
}

function Get-WowgetHome {
    param([hashtable]$Env, [string]$Platform)
    $fromEnv = if ($Platform -eq 'Windows') { Get-WowgetEnvValue $Env 'USERPROFILE' } else { Get-WowgetEnvValue $Env 'HOME' }
    if ($fromEnv) { return $fromEnv }
    return [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::UserProfile)
}

# Expands a leading "~" to the home directory.
function Expand-WowgetHome {
    param([Parameter(Mandatory)][string]$Path, [hashtable]$Env = (Get-WowgetProcessEnv), [string]$Platform = (Get-WowgetPlatform))
    $homeDir = Get-WowgetHome $Env $Platform
    if ($Path -eq '~') { return $homeDir }
    if ($Path.StartsWith('~/') -or ($Platform -eq 'Windows' -and $Path.StartsWith('~\'))) {
        return Join-WowgetPathFor $Platform @($homeDir, $Path.Substring(2))
    }
    return $Path
}

function Get-WowgetWindowsAppData {
    param([hashtable]$Env, [bool]$Local)
    $value = Get-WowgetEnvValue $Env $(if ($Local) { 'LOCALAPPDATA' } else { 'APPDATA' })
    if ($value) { return $value }
    $homeDir = Get-WowgetHome $Env 'Windows'
    return Join-WowgetPathFor 'Windows' @($homeDir, 'AppData', $(if ($Local) { 'Local' } else { 'Roaming' }))
}

# An XDG base directory: the variable when it is an absolute path, else "~/<fallback>".
function Get-WowgetXdgDir {
    param([hashtable]$Env, [string]$Name, [string[]]$Fallback)
    $value = Get-WowgetEnvValue $Env $Name
    if ($value -and $value.StartsWith('/')) { return $value }
    return Join-WowgetPathFor 'Linux' (@(Get-WowgetHome $Env 'Linux') + $Fallback)
}

function Get-WowgetManifestPath {
    # Untyped, since a [string] parameter would turn $null (no --manifest) into '' (an empty one).
    param($Override = $null, [hashtable]$Env = (Get-WowgetProcessEnv), [string]$Platform = (Get-WowgetPlatform))
    if ($null -ne $Override -and "$Override" -eq '') { throw (New-WowgetError 'usage' '--manifest must not be empty.') }
    $chosen = if ($Override) { $Override } else { Get-WowgetEnvValue $Env 'WOWGET_MANIFEST' }
    if ($chosen) { return Expand-WowgetHome $chosen $Env $Platform }
    switch ($Platform) {
        'Windows' { return Join-WowgetPathFor $Platform @((Get-WowgetWindowsAppData $Env $false), 'wowget', 'wowget.json') }
        'MacOS' { return Join-WowgetPathFor $Platform @((Get-WowgetHome $Env $Platform), '.config', 'wowget', 'wowget.json') }
        default { return Join-WowgetPathFor $Platform @((Get-WowgetXdgDir $Env 'XDG_CONFIG_HOME' @('.config')), 'wowget', 'wowget.json') }
    }
}

# Machine state: the lock file, and later the sync metadata.
function Get-WowgetStateDir {
    param([hashtable]$Env = (Get-WowgetProcessEnv), [string]$Platform = (Get-WowgetPlatform))
    $override = Get-WowgetEnvValue $Env 'WOWGET_STATE_DIR'
    if ($override) { return Expand-WowgetHome $override $Env $Platform }
    switch ($Platform) {
        'Windows' { return Join-WowgetPathFor $Platform @((Get-WowgetWindowsAppData $Env $true), 'wowget', 'state') }
        'MacOS' { return Join-WowgetPathFor $Platform @((Get-WowgetHome $Env $Platform), 'Library', 'Application Support', 'wowget') }
        default { return Join-WowgetPathFor $Platform @((Get-WowgetXdgDir $Env 'XDG_STATE_HOME' @('.local', 'state')), 'wowget') }
    }
}

function Get-WowgetCacheDir {
    param([hashtable]$Env = (Get-WowgetProcessEnv), [string]$Platform = (Get-WowgetPlatform))
    $override = Get-WowgetEnvValue $Env 'WOWGET_CACHE_DIR'
    if ($override) { return Expand-WowgetHome $override $Env $Platform }
    switch ($Platform) {
        'Windows' { return Join-WowgetPathFor $Platform @((Get-WowgetWindowsAppData $Env $true), 'wowget', 'cache') }
        'MacOS' { return Join-WowgetPathFor $Platform @((Get-WowgetHome $Env $Platform), 'Library', 'Caches', 'wowget') }
        default { return Join-WowgetPathFor $Platform @((Get-WowgetXdgDir $Env 'XDG_CACHE_HOME' @('.cache')), 'wowget') }
    }
}

# Game directories to scan for version folders, in order. WOWGET_GAME_DIR replaces the list.
function Get-WowgetGameDirCandidates {
    param([hashtable]$Env = (Get-WowgetProcessEnv), [string]$Platform = (Get-WowgetPlatform))
    $override = Get-WowgetEnvValue $Env 'WOWGET_GAME_DIR'
    if ($override) { return @(Expand-WowgetHome $override $Env $Platform) }
    switch ($Platform) {
        'MacOS' { return @('/Applications/World of Warcraft') }
        'Windows' {
            $dirs = [System.Collections.Generic.List[string]]::new()
            foreach ($name in 'PROGRAMFILES(X86)', 'PROGRAMFILES') {
                $root = Get-WowgetEnvValue $Env $name
                if (-not $root) { continue }
                $dir = Join-WowgetPathFor 'Windows' @($root, 'World of Warcraft')
                if (-not $dirs.Contains($dir)) { $dirs.Add($dir) }
            }
            return $dirs.ToArray()
        }
        default { return @() }
    }
}

# The service base URL, or 'off' when WOWGET_API_URL=off.
function Get-WowgetApiUrl {
    param([hashtable]$Env = (Get-WowgetProcessEnv))
    $value = Get-WowgetEnvValue $Env 'WOWGET_API_URL'
    if (-not $value) { return 'https://api.wowget.dev' }
    if ($value -eq 'off') { return 'off' }
    return $value.TrimEnd('/')
}

# The flavor of the progressive Classic line (_classic_), which moves with each expansion.
$script:ProgressiveClassicFlavor = 'mists'

# Version folders under the game directory, with the default target name and flavor of each.
$script:VersionFolders = @(
    [pscustomobject]@{ Folder = '_forever_'; Name = 'forever'; Flavor = 'forever' }
    [pscustomobject]@{ Folder = '_classic_era_'; Name = 'era'; Flavor = 'classic' }
    [pscustomobject]@{ Folder = '_classic_'; Name = 'classic'; Flavor = $script:ProgressiveClassicFlavor }
    [pscustomobject]@{ Folder = '_retail_'; Name = 'retail'; Flavor = 'mainline' }
)

# Files whose presence makes a version folder an installed game.
$script:GameMarkers = @('World of Warcraft.app', 'World of Warcraft Classic.app', 'Wow.exe', 'WowClassic.exe', '.flavor.info')

# The installed version folders in $GameDir, in the order of the version folder table.
function Find-WowgetInstalls {
    param([Parameter(Mandatory)][string]$GameDir)
    $found = foreach ($v in $script:VersionFolders) {
        $versionDir = [System.IO.Path]::Combine($GameDir, $v.Folder)
        if (-not [System.IO.Directory]::Exists($versionDir)) { continue }
        $installed = $false
        foreach ($m in $script:GameMarkers) {
            if (Test-WowgetPath ([System.IO.Path]::Combine($versionDir, $m))) { $installed = $true; break }
        }
        if ($installed) {
            [pscustomobject]@{
                Name = $v.Name; Flavor = $v.Flavor; Folder = $v.Folder; VersionDir = $versionDir
                AddonsDir = [System.IO.Path]::Combine($versionDir, 'Interface', 'AddOns')
            }
        }
    }
    return @($found)
}

# The AddOns directory of version folder $Folder in the first of $GameDirs that has that folder, or
# $null when none does. The AddOns directory itself may not exist yet.
function Find-WowgetVersionFolder {
    param([Parameter(Mandatory)][string]$Folder, [string[]]$GameDirs = @())
    foreach ($gameDir in $GameDirs) {
        $versionDir = [System.IO.Path]::Combine($gameDir, $Folder)
        if ([System.IO.Directory]::Exists($versionDir)) { return [System.IO.Path]::Combine($versionDir, 'Interface', 'AddOns') }
    }
    return $null
}
