#!/bin/sh
# Installs wowget on macOS and Linux: the signed release zip and the PowerShell runtime it pins.
#   curl -fsSL https://github.com/axelekwall/wowget/releases/latest/download/install.sh | sh
# Environment:
#   WOWGET_VERSION        version to install, e.g. 1.2.0 (default: the latest release)
#   WOWGET_INSTALL_DIR    install root (default: $XDG_DATA_HOME/wowget, else ~/.local/share/wowget)
#   WOWGET_API_URL        the wowget service, asked for the latest version
#   WOWGET_CATALOGUE_CONTRIBUTIONS=off
#                         save an opt-out of catalogue contributions before any device enrollment
#   WOWGET_SKIP_PATH=1    do not mention PATH
#   WOWGET_DOWNLOAD_BASE, WOWGET_RUNTIME_BASE
#                         fetch the release files or the runtime archive from another URL or a
#                         file:// directory; signatures and checksums are checked all the same
# Needs curl, unzip, tar and openssl.
set -eu

repo="axelekwall/wowget"
public_key='@WOWGET_RELEASE_PUBLIC_KEY@'

fail() { echo "wowget: $*" >&2; exit 1; }
for tool in curl unzip tar openssl; do
  command -v "$tool" >/dev/null 2>&1 || fail "the installer needs $tool; install it and run the installer again"
done
if command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$1" | cut -d' ' -f1; }
else sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }; fi

case "$(uname -s)" in
  Darwin) os=osx ;;
  Linux) os=linux ;;
  *) fail "unsupported OS $(uname -s); on Windows use install.ps1" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
rid="$os-$arch"

root="${WOWGET_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/wowget}"
bin="$HOME/.local/bin"
api="${WOWGET_API_URL:-https://api.wowget.dev}"

# The Linux runtime aborts at start without libicu; invariant globalization lets it run.
if [ "$os" = linux ] && [ -z "${DOTNET_SYSTEM_GLOBALIZATION_INVARIANT:-}" ]; then
  icu=
  for dir in /usr/lib /usr/lib64 /lib /lib64 /usr/local/lib /usr/lib/*-linux-gnu /lib/*-linux-gnu; do
    for lib in "$dir"/libicuuc.so*; do
      if [ -e "$lib" ]; then icu=1; break 2; fi
    done
  done
  if [ -z "$icu" ]; then
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
    export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT
    echo "libicu was not found, so wowget runs PowerShell with invariant globalization."
  fi
fi

version="${WOWGET_VERSION:-}"
if [ -z "$version" ] && [ "$api" != off ]; then
  version=$(curl -fsSL "$api/v1/version" 2>/dev/null | sed -n 's/.*"app"[^{]*{[^}]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1) || version=
fi
if [ -z "$version" ]; then
  version=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1) \
    || fail "could not find the latest release; set WOWGET_VERSION"
fi
[ -n "$version" ] || fail "could not find the latest release; set WOWGET_VERSION"
version="${version#v}"
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "\"$version\" is not a release version" ;;
esac

base="${WOWGET_DOWNLOAD_BASE:-https://github.com/$repo/releases/download/v$version}"
zip="wowget-$version.zip"
mkdir -p "$root"
tmp=$(mktemp -d "$root/.install-XXXXXX")
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $zip"
curl -fsSL "$base/$zip" -o "$tmp/$zip" && curl -fsSL "$base/$zip.sig" -o "$tmp/$zip.sig" \
  || fail "download of $base/$zip failed; see https://github.com/$repo/releases"
{
  echo "-----BEGIN PUBLIC KEY-----"
  echo "$public_key" | fold -w 64
  echo "-----END PUBLIC KEY-----"
} > "$tmp/release.pem"
openssl dgst -sha256 -verify "$tmp/release.pem" -signature "$tmp/$zip.sig" "$tmp/$zip" >/dev/null 2>&1 \
  || fail "the signature of $zip does not verify; nothing was installed"

mkdir "$tmp/app"
unzip -q "$tmp/$zip" -d "$tmp/app"
runtime_json="$tmp/app/runtime.json"
rt_version=$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$runtime_json" | head -n 1)
asset=$(awk -v key="\"$rid\"" 'index($0, key) { found = 1 } found { print } found && /}/ { exit }' "$runtime_json")
rt_url=$(printf '%s\n' "$asset" | sed -n 's/.*"url": *"\([^"]*\)".*/\1/p')
rt_sha=$(printf '%s\n' "$asset" | sed -n 's/.*"sha256": *"\([0-9a-fA-F]*\)".*/\1/p')
[ -n "$rt_version" ] && [ -n "$rt_url" ] && [ -n "$rt_sha" ] || fail "wowget $version has no PowerShell runtime for $rid"

mkdir -p "$root/runtime" "$root/app"
if [ ! -x "$root/runtime/$rt_version/pwsh" ]; then
  archive="${rt_url##*/}"
  rt_from="$rt_url"
  if [ -n "${WOWGET_RUNTIME_BASE:-}" ]; then rt_from="$WOWGET_RUNTIME_BASE/$archive"; fi
  echo "Downloading PowerShell $rt_version ($archive)"
  curl -fsSL "$rt_from" -o "$tmp/$archive" || fail "download of $rt_from failed"
  actual=$(sha256 "$tmp/$archive")
  [ "$actual" = "$(echo "$rt_sha" | tr 'A-F' 'a-f')" ] || fail "checksum mismatch for $archive: expected $rt_sha, got $actual"
  mkdir "$tmp/runtime"
  tar -xzf "$tmp/$archive" -C "$tmp/runtime"
  chmod +x "$tmp/runtime/pwsh"
  rm -rf "$root/runtime/$rt_version"
  mv "$tmp/runtime" "$root/runtime/$rt_version"
fi
if [ -d "$root/app/$version" ]; then
  mv "$root/app/$version" "$tmp/app-old"
fi
mv "$tmp/app" "$root/app/$version"

# The launcher, with the install root filled in.
mkdir -p "$bin"
launcher="$bin/wowget"
if [ -f "$launcher" ]; then
  magic=$(head -c 4 "$launcher" | od -An -tx1 | tr -d ' \n')
  case "$magic" in
    7f454c46 | cffaedfe | cefaedfe | feedfacf | feedface | cafebabe)
      echo "Replacing the previous wowget binary at $launcher" ;;
  esac
fi
quoted_root=$(printf '%s' "$root" | sed "s/'/'\\\\''/g")
ROOT_LINE="root='$quoted_root'" awk '$0 == "root=@WOWGET_ROOT@" { print ENVIRON["ROOT_LINE"]; next } { print }' \
  "$root/app/$version/launchers/wowget.sh" > "$tmp/wowget"
chmod +x "$tmp/wowget"
mv -f "$tmp/wowget" "$launcher"

# The switch: the launcher reads both versions from this file.
if [ -f "$root/current" ]; then
  read -r old_app old_rt < "$root/current" || true
  if [ -n "${old_app:-}" ] && [ "$old_app" != "$version" ]; then
    printf '%s %s\n' "$old_app" "$old_rt" > "$tmp/previous" && mv -f "$tmp/previous" "$root/previous"
  fi
fi
printf '%s %s\n' "$version" "$rt_version" > "$tmp/current"
mv -f "$tmp/current" "$root/current"

if [ "${WOWGET_CATALOGUE_CONTRIBUTIONS:-}" = off ]; then
  if [ "$os" = osx ]; then state_default="$HOME/Library/Application Support/wowget"; else state_default="${XDG_STATE_HOME:-$HOME/.local/state}/wowget"; fi
  state="${WOWGET_STATE_DIR:-$state_default}"
  mkdir -p "$state"
  printf '{\n  "version": 1,\n  "catalogueContributions": "off"\n}\n' > "$state/contributions.json.tmp"
  mv -f "$state/contributions.json.tmp" "$state/contributions.json"
  echo "Saved your opt-out of catalogue contributions."
fi

echo "Installed $("$launcher" --version) to $root"
echo "wowget needs no account, and installing and using it uploads nothing about your addons."
echo "If you later enroll a device for sync, explicit syncs contribute public addon IDs to the"
echo "catalogue unless you opt out: run this installer with WOWGET_CATALOGUE_CONTRIBUTIONS=off, or"
echo "change the setting in the dashboard."
if [ "${WOWGET_SKIP_PATH:-}" != 1 ]; then
  case ":$PATH:" in
    *":$bin:"*) ;;
    *) echo "Add $bin to your PATH, for example: export PATH=\"$bin:\$PATH\"" ;;
  esac
fi
