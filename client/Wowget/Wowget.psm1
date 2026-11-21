Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
# Invoke-WebRequest would draw a progress bar on the host for every request.
$ProgressPreference = 'SilentlyContinue'

$script:WowgetModuleRoot = $PSScriptRoot
# Replaced with the release version when a release is packaged.
$script:WowgetVersion = '0.0.0-dev'

# Order matters: classes and helpers come before the files that use them.
foreach ($file in @('Errors', 'Fs', 'Paths', 'Flavor', 'Zip', 'Manifest', 'TomlImport', 'Markers', 'Http', 'Api', 'UrlSource', 'Installer', 'Ops', 'Cli')) {
    . ([System.IO.Path]::Combine($PSScriptRoot, "$file.ps1"))
}

Export-ModuleMember -Function Invoke-WowgetCli
