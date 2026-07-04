#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Locale anchor diff (plan #4). Teams speaker detection leans on two KINDS of
// anchor:
//   • STABLE code identifiers — locale-INDEPENDENT (a class/ID is the same in
//     every language): vdi-frame-occlusion (the ring), vdi-dynamic-occlusion
//     (self), aria_calling_roster_(un)muted, calling_is_me_video.
//   • ENGLISH text anchors — locale-DEPENDENT, and the real exposure: we find a
//     participant TILE by matching "context menu" in its AXDescription, read mute
//     from ", muted", self from "myself video"/"(you)", and DRIVE controls by
//     "Leave"/"Mute mic"/"People". If those localize, we may fail to FIND the tile
//     (so the ring never gets scanned) even though the ring class itself is fine.
//
// This walks an AXSnapshot dump (`swift run AXSnapshot teams` →
// ax-dumps/<ts>/teams.json) and reports which anchors survive, so a non-English
// capture tells us EXACTLY what breaks — the raw material for a per-locale token
// table (dropped via teams-rules.json) — instead of guessing.
//
//   swift run AXSnapshot teams            # capture (switch tenant/OS language first)
//   node qa/teams-live/locale-anchor-diff.mjs [path/to/teams.json]
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

// STABLE identifiers — expected present in EVERY locale (a break here is a bigger
// problem than localization). Matched against domClassList/domIdentifier + any
// string attribute value.
const STABLE = ['vdi-frame-occlusion', 'vdi-dynamic-occlusion', 'aria_calling_roster_muted', 'aria_calling_roster_unmuted', 'calling_is_me_video'];
// ENGLISH text anchors — matched against title/description/value (case-insensitive).
// If these vanish in a non-English dump, they need a per-locale table.
const ENGLISH_TEXT = ['context menu', 'is available', ', muted', ', unmuted', 'myself video', '(you)', 'is active speaker', ', speaking', 'leave', 'mute mic', 'unmute', 'people', 'attendees'];

// AXSnapshot writes one JSON per Teams window (teams-native-win1.json, …), not a
// single teams.json. Collect ALL teams*.json from a dump directory so tiles (in the
// meeting window) and controls (possibly another window) are analyzed together.
const teamsJsonsIn = (dir) => { try { return readdirSync(dir).filter((f) => /^teams.*\.json$/i.test(f)).map((f) => join(dir, f)); } catch { return []; } };

// Resolve the arg to a LIST of teams*.json paths: a file → [file]; a dir → its
// teams*.json; nothing → the newest ax-dumps/<ts>/ that has any.
function resolveTeamsJsons(arg) {
  if (arg) {
    const p = resolve(arg);
    if (!existsSync(p)) return [];
    return statSync(p).isDirectory() ? teamsJsonsIn(p) : [p];
  }
  const dir = join(REPO, 'ax-dumps');
  if (!existsSync(dir)) return [];
  const stamps = readdirSync(dir).map((s) => join(dir, s)).filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } })
    .filter((p) => teamsJsonsIn(p).length > 0).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return stamps.length ? teamsJsonsIn(stamps[0]) : [];
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  const kids = node.children;
  if (Array.isArray(kids)) for (const c of kids) walk(c, visit);
}

function nodeStrings(n) {
  const out = [];
  for (const k of ['title', 'description', 'value', 'help', 'roleDescription', 'placeholder']) if (typeof n[k] === 'string') out.push(n[k]);
  return out;
}
function nodeCodeTokens(n) {
  const out = [];
  if (Array.isArray(n.domClassList)) out.push(...n.domClassList);
  if (typeof n.domIdentifier === 'string') out.push(n.domIdentifier);
  if (typeof n.identifier === 'string') out.push(n.identifier);
  if (n.attributes && typeof n.attributes === 'object') {
    for (const v of Object.values(n.attributes)) {
      if (typeof v === 'string') out.push(v);
      else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') out.push(x);
    }
  }
  return out;
}

function main() {
  const paths = resolveTeamsJsons(process.argv[2]);
  if (!paths.length) {
    console.error('No teams*.json found. Capture one first:  swift run --package-path macos AXSnapshot teams');
    console.error('Then:  node qa/teams-live/locale-anchor-diff.mjs [ax-dumps/<ts>/ | path/to/teams-native-win1.json]');
    process.exit(2);
  }
  // AXSnapshot wraps the node under { meta, tree }; older/other dumps may be the bare
  // node or under .root. Unwrap to the actual AX node before walking.
  const roots = paths.map((p) => { const o = JSON.parse(readFileSync(p, 'utf8')); return o.tree || o.root || o; });

  const stableHits = Object.fromEntries(STABLE.map((s) => [s, 0]));
  const englishHits = Object.fromEntries(ENGLISH_TEXT.map((s) => [s, { count: 0, samples: [] }]));
  const tileCandidates = [];   // AXMenuItem nodes (native tile grammar) — show their localized anchor
  let nodes = 0;

  const visit = (n) => {
    nodes++;
    for (const tok of nodeCodeTokens(n)) {
      const low = tok.toLowerCase();
      for (const s of STABLE) if (low.includes(s.toLowerCase())) stableHits[s]++;
    }
    const strs = nodeStrings(n).map((s) => s.toLowerCase());
    for (const s of ENGLISH_TEXT) {
      for (const str of strs) if (str.includes(s)) { const h = englishHits[s]; h.count++; if (h.samples.length < 2) h.samples.push(str.slice(0, 70)); break; }
    }
    // Native participant tiles are AXMenuItem with a person-name + "context menu"-ish
    // phrase in the description. Surface them so a non-English anchor is visible.
    if (n.role === 'AXMenuItem' && (n.description || n.title)) {
      tileCandidates.push((n.description || n.title).slice(0, 90));
    }
  };
  for (const root of roots) walk(root, visit);

  const stablePresent = STABLE.filter((s) => stableHits[s] > 0);
  const stableMissing = STABLE.filter((s) => stableHits[s] === 0);
  const has = (s) => englishHits[s] && englishHits[s].count > 0;
  // Verdict keys on SEMANTIC anchor groups, not every string — several English
  // anchors are transient ("is active speaker") or panel-dependent ("attendees"),
  // so their absence from a valid en capture must NOT read as "localized". A group
  // is satisfied if ANY of its members is present.
  const groups = {
    tile: ['context menu'],                    // tile RECOGNITION — the critical one
    mute: [', muted', ', unmuted'],            // per-remote mute read
    self: ['myself video', '(you)'],           // self tile
    control: ['leave', 'mute mic', 'unmute'],  // AX-driver controls
  };
  const groupPresent = Object.fromEntries(Object.entries(groups).map(([k, arr]) => [k, arr.some(has)]));
  const groupsMissing = Object.entries(groupPresent).filter(([, v]) => !v).map(([k]) => k);

  console.log(`\nLOCALE ANCHOR DIFF — ${paths.map((p) => p.replace(REPO + '/', '')).join(', ')}`);
  console.log(`nodes walked: ${nodes}\n`);
  console.log('STABLE code identifiers (expected in EVERY locale):');
  for (const s of STABLE) console.log(`  ${stableHits[s] > 0 ? 'OK  ' : 'MISS'} ${s}  (${stableHits[s]})`);
  console.log('\nENGLISH text anchors (localize in a non-English tenant):');
  for (const s of ENGLISH_TEXT) {
    const h = englishHits[s];
    console.log(`  ${h.count > 0 ? 'OK  ' : 'MISS'} "${s}"  (${h.count})${h.samples.length ? '  e.g. ' + JSON.stringify(h.samples[0]) : ''}`);
  }
  console.log('\nEnglish anchor GROUPS (verdict keys on these, not every string):');
  for (const [k, arr] of Object.entries(groups)) console.log(`  ${groupPresent[k] ? 'OK  ' : 'MISS'} ${k}  (${arr.filter(has).map((s) => JSON.stringify(s)).join(', ') || 'none present'})`);
  console.log('\nParticipant-tile candidates (AXMenuItem descriptions) — inspect the localized anchor:');
  for (const t of [...new Set(tileCandidates)].slice(0, 12)) console.log('  •', JSON.stringify(t));

  // Verdict.
  console.log('\nVERDICT:');
  const ringOk = stableHits['vdi-frame-occlusion'] > 0;
  if (stableMissing.length === STABLE.length) {
    console.log('  INCONCLUSIVE — no stable identifiers found at all. Is this dump from an ACTIVE call (tiles rendered)?');
  } else if (groupsMissing.length === 0) {
    console.log('  ENGLISH BASELINE — every anchor group is present. This looks like an en-* capture.');
    console.log('  Re-run in a non-English tenant/OS-language to exercise the localization risk.');
    console.log(`  (Stable identifiers present: ${stablePresent.join(', ') || 'none'})`);
  } else if (!groupPresent.tile) {
    console.log(`  LOCALIZED — the tile-recognition anchor ("context menu") is GONE (missing groups: ${groupsMissing.join(', ')}).`);
    console.log(`  Ring class ${ringOk ? 'STILL PRESENT (locale-free ✓)' : 'MISSING (!)'} — the SIGNAL survives, but we can't`);
    console.log('  FIND the tile to scan it, so this locale gets ZERO detection until we add a per-locale table.');
    console.log('  Use the tile-candidate strings above as the localized "context menu"/mute source → teams-rules.json.');
  } else {
    console.log(`  PARTIAL — some anchor groups localized: ${groupsMissing.join(', ')} (tile anchor itself still present).`);
    console.log('  Tiles are still findable; add per-locale entries for the missing groups (mute/self/control).');
  }
}

main();
