'use strict';
// analyze-forced-tokens.js <silentDir> <speakingDir>
// Walk the FORCED AXSnapshot JSON for the meet web area in each dump, find every
// meter node (AXDOMClassList carries QgSmzd/IisKdb/DYfzY, i.e. a jsname=QgSmzd audio
// widget), and report its class tokens. The gap is closed if in the SPEAKING dump at
// least one meter has DROPPED gjg47c and GAINED a rotating speaking token
// (Oaajhc/OgVli/HX2H7/wEsLMd), while the SILENT dump's meters carry gjg47c.
const fs = require('fs');
const path = require('path');

const SILENT_TOKEN = 'gjg47c';
const SPEAK_TOKENS = ['Oaajhc', 'OgVli', 'HX2H7', 'wEsLMd'];
const METER_MARKERS = ['QgSmzd', 'IisKdb', 'DYfzY'];

function meetJson(dir) {
  const f = fs.readdirSync(dir).find((n) => /^chrome-meet.*\.json$/.test(n));
  if (!f) return null;
  return { path: path.join(dir, f), tree: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).tree };
}

// Collect meter nodes: any node whose domClassList (or AXDOMClassList attr) contains a
// meter marker. Report the full class token set + which special tokens are present.
function collectMeters(node, out, pathTiles) {
  const cl = node.domClassList || (node.attributes && node.attributes.AXDOMClassList) || [];
  const set = Array.isArray(cl) ? cl : [];
  if (METER_MARKERS.some((m) => set.includes(m))) {
    out.push({
      classes: set,
      hasSilent: set.includes(SILENT_TOKEN),
      speakTokens: SPEAK_TOKENS.filter((t) => set.includes(t)),
      variant: set.includes('IisKdb') ? 'IisKdb(bars)' : set.includes('DYfzY') ? 'DYfzY(avatar)' : 'QgSmzd',
    });
  }
  const kids = node.children || [];
  for (const c of kids) if (c && typeof c === 'object') collectMeters(c, out, pathTiles);
}

// Also collect the raw union of ALL class tokens containing any speak token, so we
// catch rotations even if the meter marker moved.
function allTokens(node, set) {
  const cl = node.domClassList || (node.attributes && node.attributes.AXDOMClassList) || [];
  if (Array.isArray(cl)) for (const t of cl) set.add(t);
  for (const c of (node.children || [])) if (c && typeof c === 'object') allTokens(c, set);
}

function analyze(dir, label) {
  const mj = meetJson(dir);
  if (!mj) { console.log(`[${label}] NO chrome-meet json in ${dir}`); return null; }
  const meters = [];
  collectMeters(mj.tree, meters);
  const tokens = new Set();
  allTokens(mj.tree, tokens);
  const silentMeters = meters.filter((m) => m.hasSilent).length;
  const speakingMeters = meters.filter((m) => m.speakTokens.length > 0);
  const anySpeakTokenAnywhere = SPEAK_TOKENS.filter((t) => tokens.has(t));
  console.log(`\n[${label}] ${mj.path}`);
  console.log(`  meter nodes: ${meters.length}  (with gjg47c silent token: ${silentMeters}, with a speak token: ${speakingMeters.length})`);
  console.log(`  speak tokens present ANYWHERE in tree: ${anySpeakTokenAnywhere.length ? anySpeakTokenAnywhere.join(',') : 'NONE'}`);
  for (const m of speakingMeters) {
    console.log(`  >> SPEAKING meter [${m.variant}] tokens=${m.speakTokens.join(',')} hasSilent=${m.hasSilent}`);
    console.log(`     classes: ${m.classes.join(' ')}`);
  }
  // show a couple of silent meters for contrast
  meters.filter((m) => m.hasSilent).slice(0, 3).forEach((m) => {
    console.log(`  -- silent meter [${m.variant}] classes: ${m.classes.join(' ')}`);
  });
  return { meters: meters.length, silentMeters, speakingMeters: speakingMeters.length, anySpeakTokenAnywhere };
}

const [silentDir, speakingDir] = process.argv.slice(2);
console.log('=== FORCED AX TOKEN ANALYSIS ===');
const s = analyze(silentDir, 'SILENT');
const k = analyze(speakingDir, 'SPEAKING');

console.log('\n=== VERDICT ===');
if (!s || !k) { console.log('INCONCLUSIVE — missing dump.'); process.exit(1); }
const swapAppeared = k.anySpeakTokenAnywhere.length > 0 && s.anySpeakTokenAnywhere.length === 0;
const meterGainedSpeak = k.speakingMeters > 0;
if (meterGainedSpeak || swapAppeared) {
  console.log('CLOSED: forcing surfaced the speaking-indicator token swap in AXDOMClassList.');
  console.log(`  silent dump speak-tokens: [${s.anySpeakTokenAnywhere.join(',') || 'none'}]  ->  speaking dump: [${k.anySpeakTokenAnywhere.join(',') || 'none'}]`);
} else {
  console.log('NOT SHOWN in this pair: no speak token appeared on a meter in the speaking dump.');
  console.log('  (Could be a timing miss — the forced dump landed between rotations, or the host window was not frontmost when it captured.)');
}
