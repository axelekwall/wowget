@{
    RootModule           = 'Wowget.psm1'
    ModuleVersion        = '0.0.0'
    GUID                 = '6f0c6b1e-3f7a-4a59-9a43-6c1b6b0f7d21'
    Author               = 'wowget contributors'
    Description          = 'Installs, lists and updates World of Warcraft addons from a declarative manifest.'
    PowerShellVersion    = '7.6'
    CompatiblePSEditions = @('Core')
    FunctionsToExport    = @('Invoke-WowgetCli')
    CmdletsToExport      = @()
    VariablesToExport    = @()
    AliasesToExport      = @()
}
