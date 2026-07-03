#!/usr/bin/env bash
# One-shot BlackHole 2ch recovery. REQUIRES sudo (you'll be prompted once).
# Root cause: the BlackHole driver instance wedged (loopback passes 0 audio,
# ~-91 dB) while the machine's CoreAudio loopback is otherwise healthy (the
# "Microsoft Teams Audio" virtual device loops fine at ~-18 dB). A clean driver
# reinstall + coreaudiod restart clears the wedged HAL plugin instance.
set -uo pipefail

PKG=$(ls -t "$HOME/Library/Caches/Homebrew/downloads/"*BlackHole2ch-*.pkg 2>/dev/null | head -1)
[ -z "${PKG:-}" ] && PKG=$(ls -t "$HOME/Library/Caches/Homebrew/Cask/"BlackHole2ch-*.pkg* 2>/dev/null | head -1)

echo "This reinstalls the BlackHole 2ch driver and restarts coreaudiod (needs your password)."
if [ -n "${PKG:-}" ] && [ -e "$PKG" ]; then
  echo "Using cached pkg: $PKG"
  sudo installer -pkg "$PKG" -target / || { echo "installer failed"; exit 1; }
else
  echo "No cached pkg found; fetching via brew (re)install ..."
  brew reinstall --cask blackhole-2ch || { echo "brew reinstall failed"; exit 1; }
fi
sudo killall coreaudiod 2>/dev/null || true
sleep 3
echo "Done. Re-checking loopback ..."
bash "$(dirname "$0")/bh-loopback-check.sh"
