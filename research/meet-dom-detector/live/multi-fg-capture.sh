#!/usr/bin/env bash
# Foreground the host meeting window + AX-dump repeatedly while the user speaks
# non-stop, checking the guest DOM speaking state around each capture, so at least
# one dump lands during BOTH foreground AND active remote speech.
set +e
LIVE=/Users/bibekthapa/projects/work/demo-app/research/meet-dom-detector/live
MAC=/Users/bibekthapa/projects/work/demo-app/macos
CODE=yzs-mvzw-rkv
for i in 1 2 3 4 5; do
  # 1) was the guest speaking (DOM) just before this capture?
  SPK=$(cd "$LIVE" && node -e 'const{attachToPage}=require("./cdp-lib");(async()=>{const g=await attachToPage(9318,/meet/);const s=await g.evalJs(`[...document.querySelectorAll("[jsname=QgSmzd]")].map(w=>w.className).filter(c=>!/gjg47c/.test(c))`);console.log(JSON.stringify(s));process.exit(0)})().catch(()=>{console.log("[]");process.exit(0)})' 2>/dev/null)
  # 2) foreground the host meeting window
  osascript -e "tell application \"System Events\" to repeat with p in (every process whose name is \"Google Chrome\")
    repeat with w in (every window of p)
      if title of w contains \"Meet - $CODE\" then
        set frontmost of p to true
        perform action \"AXRaise\" of w
      end if
    end repeat
  end repeat" 2>/dev/null
  sleep 1
  # 3) dump AX
  (cd "$MAC" && swift run AXSnapshot chrome --url "$CODE" >/tmp/mfc.log 2>&1)
  LATEST=$(ls -td "$MAC"/ax-dumps/*/ 2>/dev/null | head -1)
  AXC="no-meeting"
  if [ -f "$LATEST/chrome-meet-1.txt" ]; then
    n=$(grep -c "OgVli\|Oaajhc\|HX2H7\|wEsLMd\|IisKdb\|QgSmzd\|DYfzY" "$LATEST/chrome-meet-1.txt" | head -1)
    real=$(grep -E "OgVli|Oaajhc|HX2H7|wEsLMd|IisKdb|QgSmzd|DYfzY" "$LATEST/chrome-meet-1.txt" | grep -v '^#' | grep -vc 'PARTICIPANT TILE')
    nodes=$(head -3 "$LATEST/chrome-meet-1.txt" | grep -o '[0-9]* nodes')
    AXC="nodes=$nodes audioWidgetClasses=$real"
  fi
  echo "capture $i: guestDOMspeaking=$SPK  |  AX: $AXC"
done
echo "--- if any row shows guestDOMspeaking non-empty AND audioWidgetClasses>0, the className IS in AX ---"
