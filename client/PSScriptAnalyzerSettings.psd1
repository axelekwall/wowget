@{
    Severity     = @('Error', 'Warning', 'Information')
    ExcludeRules = @(
        # Internal functions of a command-line tool, not cmdlets: -WhatIf and -Confirm do not apply.
        'PSUseShouldProcessForStateChangingFunctions'
        # Names such as Get-WowgetTargetMarkers return collections and say so.
        'PSUseSingularNouns'
        # Positional arguments for the module's own short helper functions keep calls readable.
        'PSAvoidUsingPositionalParameters'
    )
}
