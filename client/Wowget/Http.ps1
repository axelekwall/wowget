# The only network call site. Tests set $script:WowgetHttpFake to a script block that receives the
# request (Method, Uri, Headers, Body) and returns @{ StatusCode; Headers; Body }, or throws to simulate
# a connection failure; nothing then reaches the network.

$script:WowgetHttpFake = $null

function Get-WowgetUserAgent {
    $os = switch (Get-WowgetPlatform) { 'Windows' { 'windows' } 'MacOS' { 'macos' } default { 'linux' } }
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    return "wowget/$script:WowgetVersion ($os-$arch)"
}

function ConvertTo-WowgetBytes {
    param($Body)
    if ($null -eq $Body) { return , [byte[]]@() }
    if ($Body -is [byte[]]) { return , $Body }
    return , [System.Text.Encoding]::UTF8.GetBytes([string]$Body)
}

# Sends one request without following redirects. Returns StatusCode, Headers (a case-insensitive
# hashtable of strings) and Bytes (the body; $null when it went to $OutFile). A failure to connect or
# read is a "network" error; any HTTP status is returned to the caller.
function Invoke-WowgetHttp {
    param(
        [string]$Method = 'GET',
        [Parameter(Mandatory)][string]$Uri,
        [hashtable]$Headers = @{},
        $Body = $null,
        $OutFile = $null
    )
    $sendHeaders = @{}
    foreach ($k in $Headers.Keys) { $sendHeaders[$k] = $Headers[$k] }
    $failure = { param($message) New-WowgetError 'network' "$Method $Uri failed: $message" }

    if ($null -ne $script:WowgetHttpFake) {
        $request = [pscustomobject]@{ Method = $Method; Uri = $Uri; Headers = $sendHeaders; Body = $Body }
        try {
            $response = & $script:WowgetHttpFake $request
        } catch {
            throw (& $failure (Get-WowgetErrorMessage $_))
        }
        $responseHeaders = @{}
        $fake = [hashtable]$response
        if ($fake['Headers']) { foreach ($k in $fake['Headers'].Keys) { $responseHeaders[$k] = [string]$fake['Headers'][$k] } }
        $bytes = ConvertTo-WowgetBytes $fake['Body']
        if ($OutFile) {
            [System.IO.File]::WriteAllBytes($OutFile, $bytes)
            $bytes = $null
        }
        return [pscustomobject]@{ StatusCode = [int]$fake['StatusCode']; Headers = $responseHeaders; Bytes = $bytes }
    }

    $params = @{
        Uri                      = $Uri
        Method                   = $Method
        Headers                  = $sendHeaders
        UserAgent                = Get-WowgetUserAgent
        MaximumRedirection       = 0
        SkipHttpErrorCheck       = $true
        ConnectionTimeoutSeconds = 30
        OperationTimeoutSeconds  = 120
        # With -MaximumRedirection 0 a 3xx answer is returned and also reported as a non-terminating
        # error, so errors are collected and only raised when no response came back.
        ErrorAction              = 'SilentlyContinue'
        ErrorVariable            = 'requestErrors'
    }
    if ($null -ne $Body) {
        $params['Body'] = [string]$Body
        $params['ContentType'] = 'application/json; charset=utf-8'
    }
    if ($OutFile) {
        $params['OutFile'] = $OutFile
        $params['PassThru'] = $true
    }
    try {
        $response = Invoke-WebRequest @params
    } catch {
        throw (& $failure (Get-WowgetErrorMessage $_))
    }
    if ($null -eq $response) {
        $message = if ($requestErrors.Count) { Get-WowgetErrorMessage $requestErrors[0] } else { 'no response' }
        throw (& $failure $message)
    }
    $responseHeaders = @{}
    foreach ($k in $response.Headers.Keys) { $responseHeaders[$k] = (@($response.Headers[$k]) -join ', ') }
    $bytes = $null
    if (-not $OutFile) { $bytes = $response.RawContentStream.ToArray() }
    return [pscustomobject]@{ StatusCode = [int]$response.StatusCode; Headers = $responseHeaders; Bytes = $bytes }
}

function Get-WowgetResponseText {
    param([Parameter(Mandatory)]$Response)
    if ($null -eq $Response.Bytes) { return '' }
    return [System.Text.Encoding]::UTF8.GetString($Response.Bytes)
}

# GETs $Url into $OutFile, following up to 5 redirects by hand. With $AllowedHosts every hop must be
# https on one of those hosts ("source" error otherwise); without, any http or https URL is followed.
# Returns the final response (its body is in $OutFile) and the URL it came from.
function Invoke-WowgetDownload {
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$OutFile,
        [string[]]$AllowedHosts = $null,
        [hashtable]$Headers = @{}
    )
    $current = [System.Uri]$Url
    for ($hop = 0; $hop -le 5; $hop++) {
        Assert-WowgetDownloadUrl $current $AllowedHosts
        $response = Invoke-WowgetHttp -Uri $current.AbsoluteUri -Headers $Headers -OutFile $OutFile
        $code = $response.StatusCode
        if ($code -ge 300 -and $code -lt 400 -and $code -ne 304) {
            $location = $response.Headers['Location']
            if (-not $location) { throw (New-WowgetError 'network' "GET $($current.AbsoluteUri) failed: HTTP $code without a Location header.") }
            $current = [System.Uri]::new($current, $location)
            continue
        }
        return [pscustomobject]@{ Response = $response; Url = $current.AbsoluteUri }
    }
    throw (New-WowgetError 'network' "GET $Url failed: more than 5 redirects.")
}

function Assert-WowgetDownloadUrl {
    param([Parameter(Mandatory)][System.Uri]$Uri, [string[]]$AllowedHosts)
    if ($null -eq $AllowedHosts) {
        if ($Uri.Scheme -ne 'https' -and $Uri.Scheme -ne 'http') {
            throw (New-WowgetError 'source' "Refusing to download $($Uri.AbsoluteUri): only http and https URLs are followed.")
        }
        return
    }
    if ($Uri.Scheme -ne 'https' -or $AllowedHosts -notcontains $Uri.Host) {
        throw (New-WowgetError 'source' "Refusing to download from $($Uri.Scheme)://$($Uri.Host): not an allowed download host.")
    }
}
