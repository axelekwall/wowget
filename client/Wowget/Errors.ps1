# Errors that reach the user carry a code (see SPEC-POWERSHELL.md) and a message meant for a person.
class WowgetError : System.Exception {
    [string]$Code

    WowgetError([string]$code, [string]$message) : base($message) {
        $this.Code = $code
    }

    WowgetError([string]$code, [string]$message, [System.Exception]$inner) : base($message, $inner) {
        $this.Code = $code
    }
}

$script:ErrorCodes = @(
    'usage', 'manifest', 'manifest_exists', 'duplicate', 'not_found', 'network', 'rate_limited',
    'zip', 'flavor', 'conflict', 'locked', 'source', 'io'
)

function New-WowgetError {
    param(
        [Parameter(Mandatory)][string]$Code,
        [Parameter(Mandatory)][string]$Message,
        [System.Exception]$Inner
    )
    if ($Inner) { return [WowgetError]::new($Code, $Message, $Inner) }
    return [WowgetError]::new($Code, $Message)
}

# The exception behind an error record or exception, unwrapping the wrappers PowerShell adds around
# exceptions thrown from .NET methods.
function Get-WowgetException {
    param([Parameter(Mandatory)]$ErrorOrException)
    $ex = if ($ErrorOrException -is [System.Management.Automation.ErrorRecord]) { $ErrorOrException.Exception } else { $ErrorOrException }
    while ($ex -is [System.Management.Automation.MethodInvocationException] -and $ex.InnerException) { $ex = $ex.InnerException }
    return $ex
}

# The WowgetError code of an error record or exception, or $null for any other error.
function Get-WowgetErrorCode {
    param([Parameter(Mandatory)]$ErrorOrException)
    $ex = Get-WowgetException $ErrorOrException
    if ($ex -is [WowgetError]) { return $ex.Code }
    return $null
}

function Get-WowgetErrorMessage {
    param([Parameter(Mandatory)]$ErrorOrException)
    return (Get-WowgetException $ErrorOrException).Message
}
