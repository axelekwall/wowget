#!/bin/sh
# Installs wowget on macOS or Linux from the GitHub releases.
#   curl -fsSL https://raw.githubusercontent.com/axelekwall/wowget/main/install.sh | sh
# Environment:
#   WOWGET_VERSION      version to install, e.g. 0.1.0 (default: latest release)
#   WOWGET_INSTALL_DIR  directory for the binary (default: ~/.local/bin)
set -eu

repo="axelekwall/wowget"
version="${WOWGET_VERSION:-}"
install_dir="${WOWGET_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) echo "wowget: unsupported OS $(uname -s); on Windows use install.ps1" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) echo "wowget: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
asset="wowget-${os}-${arch}"

if [ -n "${WOWGET_DOWNLOAD_BASE:-}" ]; then
  base="$WOWGET_DOWNLOAD_BASE"
elif [ -n "$version" ]; then
  base="https://github.com/${repo}/releases/download/v${version#v}"
else
  base="https://github.com/${repo}/releases/latest/download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading ${base}/${asset}"
curl -fsSL "${base}/${asset}" -o "${tmp}/${asset}" && curl -fsSL "${base}/SHA256SUMS.txt" -o "${tmp}/SHA256SUMS.txt" \
  || { echo "wowget: download failed; see https://github.com/${repo}/releases for the available builds" >&2; exit 1; }

if command -v sha256sum >/dev/null 2>&1; then
  sum_cmd="sha256sum"
else
  sum_cmd="shasum -a 256"
fi
(cd "$tmp" && grep " ${asset}\$" SHA256SUMS.txt | $sum_cmd -c - >/dev/null) \
  || { echo "wowget: checksum mismatch for ${asset}" >&2; exit 1; }

mkdir -p "$install_dir"
chmod +x "${tmp}/${asset}"
mv -f "${tmp}/${asset}" "${install_dir}/wowget"

echo "Installed $("${install_dir}/wowget" --version) to ${install_dir}/wowget"
case ":${PATH}:" in
  *":${install_dir}:"*) ;;
  *) echo "Add ${install_dir} to your PATH, for example: export PATH=\"${install_dir}:\$PATH\"" ;;
esac
