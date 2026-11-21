#Requires -Version 7.4
# Entry point: the launchers run this script with the pinned PowerShell runtime.
$ErrorActionPreference = 'Stop'
Import-Module ([System.IO.Path]::Combine($PSScriptRoot, 'Wowget', 'Wowget.psd1')) -Force
exit (Invoke-WowgetCli -Argv ([string[]]$args))
