# Runs the Pester tests and, with -Lint, PSScriptAnalyzer over the client. Exits non-zero on any
# failure. Pester 5 and PSScriptAnalyzer must be importable (for example from a folder on
# $env:PSModulePath).
param(
    [switch]$Lint,
    [string[]]$Path = @($PSScriptRoot),
    [string]$Output = 'Normal'
)
$ErrorActionPreference = 'Stop'
$client = Split-Path -Parent $PSScriptRoot

if ($Lint) {
    Import-Module PSScriptAnalyzer
    $settings = [System.IO.Path]::Combine($client, 'PSScriptAnalyzerSettings.psd1')
    $testSettings = [System.IO.Path]::Combine($PSScriptRoot, 'PSScriptAnalyzerSettings.psd1')
    $findings = @(
        Invoke-ScriptAnalyzer -Path ([System.IO.Path]::Combine($client, 'Wowget')) -Recurse -Settings $settings
        foreach ($script in 'wowget.ps1', 'build-release.ps1', 'install.ps1') {
            Invoke-ScriptAnalyzer -Path ([System.IO.Path]::Combine($client, $script)) -Settings $settings
        }
        Invoke-ScriptAnalyzer -Path $PSScriptRoot -Recurse -Settings $testSettings
    )
    $findings | Format-Table -AutoSize RuleName, Severity, ScriptName, Line, Message | Out-String -Width 200
    "PSScriptAnalyzer: $($findings.Count) finding(s)"
    exit $(if ($findings.Count) { 1 } else { 0 })
}

Import-Module Pester -MinimumVersion 5.0
$config = New-PesterConfiguration
$config.Run.Path = $Path
$config.Run.Exit = $true
$config.Output.Verbosity = $Output
Invoke-Pester -Configuration $config
