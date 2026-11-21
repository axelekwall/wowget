# Installer smoke test: builds a release signed with a throwaway key, runs this platform's installer
# against it from local files in a temporary install root, then runs "wowget --version" and help through
# the installed launcher. Nothing touches the real install root, PATH or home directory.
#   pwsh client/tests/smoke-install.ps1 -RuntimeArchive <the runtime.json archive for this platform>
param(
    [Parameter(Mandatory)][string]$RuntimeArchive,
    [switch]$Keep
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
$client = Split-Path -Parent $PSScriptRoot
$version = '0.0.1'
$work = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'wowget-smoke-' + [System.IO.Path]::GetRandomFileName().Replace('.', ''))
[void][System.IO.Directory]::CreateDirectory($work)

# Runs a program with extra environment variables; returns Exit and Output (stdout and stderr).
function Invoke-Program {
    param([string]$File, [string[]]$Arguments, [hashtable]$Environment = @{})
    $info = [System.Diagnostics.ProcessStartInfo]::new($File)
    foreach ($a in $Arguments) { $info.ArgumentList.Add($a) }
    foreach ($k in $Environment.Keys) {
        if ($null -eq $Environment[$k]) { [void]$info.Environment.Remove($k) } else { $info.Environment[$k] = $Environment[$k] }
    }
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.UseShellExecute = $false
    $p = [System.Diagnostics.Process]::Start($info)
    $err = $p.StandardError.ReadToEndAsync()
    $out = $p.StandardOutput.ReadToEnd()
    $p.WaitForExit()
    return [pscustomobject]@{ Exit = $p.ExitCode; Output = ($out + $err.Result) }
}

function Assert-That {
    param([bool]$Condition, [string]$Message, $Detail = $null)
    if (-not $Condition) {
        if ($Detail) { Write-Output $Detail }
        throw "smoke test failed: $Message"
    }
    Write-Output "ok: $Message"
}

try {
    $ecdsa = [System.Security.Cryptography.ECDsa]::Create([System.Security.Cryptography.ECCurve+NamedCurves]::nistP256)
    $keyPath = [System.IO.Path]::Combine($work, 'test-signing-key.pem')
    $publicPath = [System.IO.Path]::Combine($work, 'test-public-key.txt')
    [System.IO.File]::WriteAllText($keyPath, $ecdsa.ExportPkcs8PrivateKeyPem())
    [System.IO.File]::WriteAllText($publicPath, [System.Convert]::ToBase64String($ecdsa.ExportSubjectPublicKeyInfo()))
    $ecdsa.Dispose()

    $release = [System.IO.Path]::Combine($work, 'release')
    $pwsh = [System.Environment]::ProcessPath
    $build = Invoke-Program $pwsh @('-NoLogo', '-NoProfile', '-File', [System.IO.Path]::Combine($client, 'build-release.ps1'), '-Version', $version, '-OutDir', $release, '-SigningKeyPath', $keyPath, '-PublicKeyPath', $publicPath)
    Assert-That ($build.Exit -eq 0) 'the release builds' $build.Output

    # The runtime archive under the name runtime.json gives it, as the installers look it up.
    $platform = if ($IsWindows) { 'win-x64' } elseif ($IsMacOS) { if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'osx-arm64' } else { 'osx-x64' } } else { if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'linux-arm64' } else { 'linux-x64' } }
    $runtimeJson = Get-Content -Raw ([System.IO.Path]::Combine($client, 'runtime.json')) | ConvertFrom-Json
    $runtimeDir = [System.IO.Path]::Combine($work, 'runtime-src')
    [void][System.IO.Directory]::CreateDirectory($runtimeDir)
    $archiveName = ([System.Uri]$runtimeJson.assets.$platform.url).Segments[-1]
    Copy-Item -LiteralPath $RuntimeArchive -Destination ([System.IO.Path]::Combine($runtimeDir, $archiveName))

    $root = [System.IO.Path]::Combine($work, 'root')
    $homeDir = [System.IO.Path]::Combine($work, 'home')
    [void][System.IO.Directory]::CreateDirectory($homeDir)
    $toUrl = { param($p) ([System.Uri]::new($p)).AbsoluteUri }
    $environment = @{
        WOWGET_VERSION = $version; WOWGET_INSTALL_DIR = $root; WOWGET_SKIP_PATH = '1'; WOWGET_API_URL = 'off'
        WOWGET_DOWNLOAD_BASE = (& $toUrl $release); WOWGET_RUNTIME_BASE = (& $toUrl $runtimeDir)
        WOWGET_STATE_DIR = [System.IO.Path]::Combine($work, 'state'); WOWGET_CATALOGUE_CONTRIBUTIONS = 'off'
        HOME = $homeDir; XDG_DATA_HOME = $null; XDG_STATE_HOME = $null; XDG_CONFIG_HOME = $null
    }
    if ($IsWindows) {
        # Users run install.ps1 through "irm | iex" in Windows PowerShell 5.1.
        $shell = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
        if (-not $shell) { $shell = $pwsh }
        # PowerShell 7's module path would load its own modules into Windows PowerShell.
        $environment['PSModulePath'] = $null
        $install = { Invoke-Program $shell @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', [System.IO.Path]::Combine($release, 'install.ps1')) $environment }
        $run = { param([string[]]$a) Invoke-Program $env:ComSpec (@('/d', '/c', [System.IO.Path]::Combine($root, 'bin', 'wowget.cmd')) + $a) }
    } else {
        $install = { Invoke-Program '/bin/sh' @([System.IO.Path]::Combine($release, 'install.sh')) $environment }
        $run = { param([string[]]$a) Invoke-Program ([System.IO.Path]::Combine($homeDir, '.local', 'bin', 'wowget')) $a @{ HOME = $homeDir } }
    }

    $installed = & $install
    Assert-That ($installed.Exit -eq 0) "the installer installs wowget $version" $installed.Output
    Assert-That ($installed.Output -match "Installed wowget $([regex]::Escape($version))") 'the installer reports the installed version' $installed.Output
    $current = (Get-Content -Raw ([System.IO.Path]::Combine($root, 'current'))).Trim()
    Assert-That ($current -eq "$version $($runtimeJson.version)") "current names the app and runtime ($current)"
    Assert-That (Test-Path ([System.IO.Path]::Combine($work, 'state', 'contributions.json'))) 'the contribution opt-out is saved'

    $v = & $run @('--version')
    Assert-That ($v.Exit -eq 0 -and $v.Output.Trim() -eq "wowget $version") 'the launcher runs wowget --version' $v.Output
    $help = & $run @('--help')
    Assert-That ($help.Exit -eq 0 -and $help.Output -match 'Usage: wowget <command>') 'the launcher runs wowget --help' $help.Output

    # A zip that does not match its signature is refused before anything changes.
    $zip = [System.IO.Path]::Combine($release, "wowget-$version.zip")
    $bytes = [System.IO.File]::ReadAllBytes($zip)
    $bytes[$bytes.Length - 1] = $bytes[$bytes.Length - 1] -bxor 0xff
    [System.IO.File]::WriteAllBytes($zip, $bytes)
    $tampered = & $install
    Assert-That ($tampered.Exit -ne 0 -and $tampered.Output -match 'signature') 'the installer refuses a zip whose signature does not verify' $tampered.Output
    $v = & $run @('--version')
    Assert-That ($v.Output.Trim() -eq "wowget $version") 'the installed wowget still runs after the refused install' $v.Output
} finally {
    if ($Keep) { Write-Output "kept $work" } else { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
