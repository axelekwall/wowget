#!/bin/sh
# The wowget launcher for macOS and Linux. install.sh writes it to ~/.local/bin/wowget with the install
# root filled in below. It runs the app and runtime versions named in <root>/current.
root=@WOWGET_ROOT@
{ read -r app rt; } < "$root/current" 2>/dev/null
if [ -z "${app:-}" ] || [ -z "${rt:-}" ]; then
  echo "wowget: cannot read $root/current; run the install script again" >&2
  exit 1
fi
# The Linux runtime aborts at start without libicu; invariant globalization lets it run.
if [ -z "${DOTNET_SYSTEM_GLOBALIZATION_INVARIANT:-}" ] && [ "$(uname -s)" = Linux ]; then
  icu=
  for dir in /usr/lib /usr/lib64 /lib /lib64 /usr/local/lib /usr/lib/*-linux-gnu /lib/*-linux-gnu; do
    for lib in "$dir"/libicuuc.so*; do
      if [ -e "$lib" ]; then icu=1; break 2; fi
    done
  done
  if [ -z "$icu" ]; then
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
    export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT
  fi
fi
exec "$root/runtime/$rt/pwsh" -NoLogo -NoProfile -File "$root/app/$app/wowget.ps1" "$@"
