# Installs wowget on 64-bit Windows from the GitHub releases.
#   irm https://raw.githubusercontent.com/axelekwall/wowget/main/install.ps1 | iex
# Environment:
#   WOWGET_VERSION      version to install, e.g. 0.1.0 (default: latest release)
#   WOWGET_INSTALL_DIR  directory for the binary (default: %LOCALAPPDATA%\wowget\bin)
$ErrorActionPreference = "Stop"

$repo = "axelekwall/wowget"
$asset = "wowget-windows-x64.exe"
$installDir = if ($env:WOWGET_INSTALL_DIR) { $env:WOWGET_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "wowget\bin" }

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "wowget: only 64-bit Windows is supported"
}

$base = if ($env:WOWGET_DOWNLOAD_BASE) {
  $env:WOWGET_DOWNLOAD_BASE
} elseif ($env:WOWGET_VERSION) {
  "https://github.com/$repo/releases/download/v$($env:WOWGET_VERSION -replace '^v', '')"
} else {
  "https://github.com/$repo/releases/latest/download"
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("wowget-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading $base/$asset"
  Invoke-WebRequest -Uri "$base/$asset" -OutFile (Join-Path $tmp $asset) -UseBasicParsing
  Invoke-WebRequest -Uri "$base/SHA256SUMS.txt" -OutFile (Join-Path $tmp "SHA256SUMS.txt") -UseBasicParsing

  $expected = (Get-Content (Join-Path $tmp "SHA256SUMS.txt") | Where-Object { $_ -match "\s$([regex]::Escape($asset))$" }) -split '\s+' | Select-Object -First 1
  $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $asset)).Hash.ToLowerInvariant()
  if (-not $expected -or $expected -ne $actual) {
    throw "wowget: checksum mismatch for $asset"
  }

  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  $exe = Join-Path $installDir "wowget.exe"
  Move-Item -Force (Join-Path $tmp $asset) $exe

  $version = & $exe --version
  Write-Host "Installed $version to $exe"

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($userPath -split ';') -notcontains $installDir) {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$installDir", "User")
    Write-Host "Added $installDir to your user PATH; open a new terminal to use wowget."
  }
  $env:Path = "$env:Path;$installDir"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
