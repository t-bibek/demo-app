#!/usr/bin/env bash
# (Re)create the HOST profile for fake-audio-rig.js as a lean COPY of the signed-in
# .live-profile, excluding regenerable caches and the 4GB on-device model store.
# Does NOT touch the original .live-profile. Run once before the rig (idempotent).
set -euo pipefail
cd "$(dirname "$0")"
SRC=".live-profile"
DST=".rig-profiles/host"
[ -d "$SRC" ] || { echo "ERROR: $SRC not found (need a signed-in profile)"; exit 1; }
mkdir -p .rig-profiles
rm -rf "$DST"
echo "copying $SRC -> $DST (lean)..."
rsync -a \
  --exclude 'Default/Cache' --exclude 'Default/Code Cache' --exclude 'Default/GPUCache' \
  --exclude 'Default/DawnGraphiteCache' --exclude 'Default/DawnWebGPUCache' \
  --exclude 'Default/Service Worker/CacheStorage' \
  --exclude 'GraphiteDawnCache' --exclude 'GPUPersistentCache' --exclude 'ShaderCache' \
  --exclude 'OptGuideOnDeviceModel' --exclude 'optimization_guide_model_store' \
  --exclude 'WasmTtsEngine' --exclude 'OnDeviceHeadSuggestModel' \
  --exclude 'component_crx_cache' --exclude 'BrowserMetrics' --exclude '*.pma' \
  --exclude 'SingletonLock' --exclude 'SingletonCookie' --exclude 'SingletonSocket' \
  "$SRC/" "$DST/"
echo "host profile ready: $(du -sh "$DST" | cut -f1)"
[ -f "$DST/Default/Cookies" ] && echo "  sign-in cookies present ✅" || echo "  WARN: no Cookies — sign-in may not carry"
