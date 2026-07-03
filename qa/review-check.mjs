#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Independent review gate — RUNNABLE, not prose. Encodes the 2026-07 QA-suite
// review's findings as executable invariants over the CHECKS THEMSELVES (not the
// product), so a future regression of those exact issues fails CI instead of
// slipping through green. Exits non-zero on any violation.
//
// Extend by appending an invariant block below (read a file, assert, pass()/fail()).
// This is the deterministic floor; point review.cmd at an LLM reviewer to layer a
// judgement pass on top. See docs/qa-review-findings-2026-07.md + QA_AUTOMATION_FLOW.md.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CONFIG_PATH = process.env.QA_CONFIG ? resolve(process.cwd(), process.env.QA_CONFIG) : resolve(HERE, 'qa.config.mjs');
const config = (await import(pathToFileURL(CONFIG_PATH).href)).default;
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
// Like read() but returns null instead of throwing when the file is absent — so a
// guard over a file a PARALLEL agent may not have written yet FAILS with a clear
// message instead of crashing the whole review script (INV-5..8 use this).
const readOrNull = (p) => { try { return readFileSync(resolve(ROOT, p), 'utf8'); } catch (e) { return null; } };
const stripComments = (s) => s.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const results = [];
const pass = (inv, msg) => results.push({ inv, ok: true, msg });
const fail = (inv, msg) => results.push({ inv, ok: false, msg });
const guard = (inv, fn) => { try { fn(); } catch (e) { fail(inv, `check errored: ${e.message}`); } };

// INV-1 — every Meet active-speaker attribution path excludes the SELF tile.
// (The ring path shipped without `!isMe` and named the local user — 2026-07-03.)
// Order-insensitive: assert the self-exclusion token is present IN the predicate,
// not in a fixed operand order, so a harmless `&&` reorder isn't a false alarm.
guard('INV-1 self-exclusion', () => {
  const src = read('macos/Sources/SpeakerCore/MeetActiveSpeaker.swift');
  const excludesSelf = (closure) => /!\s*\$0\.isMe|isMe\s*==\s*false/.test(closure);
  const closures = [
    { name: 'ring (classSpeaking)', re: /filter\s*\{([^}]*classSpeaking[^}]*)\}/ },
    { name: 'focused (AXFocused)',  re: /first\(\s*where:\s*\{([^}]*isFocused[^}]*)\}/ },
  ];
  for (const c of closures) {
    const m = c.re.exec(src);
    if (!m) fail('INV-1 self-exclusion', `${c.name} predicate not found (refactored? tighten the matcher)`);
    else if (excludesSelf(m[1])) pass('INV-1 self-exclusion', `${c.name} excludes self`);
    else fail('INV-1 self-exclusion', `${c.name} does NOT exclude the self tile — it can name the local user`);
  }
  // geometry: the promoted tile is returned only when it is not self (single token).
  if (/isMe\s*!=\s*true|!\s*\w*\.?isMe/.test(src)) pass('INV-1 self-exclusion', 'geometry (promoted) excludes self');
  else fail('INV-1 self-exclusion', 'geometry path does NOT exclude the self tile');
});

// INV-2 — every MeetSpeakerSignal case (bar .none) is asserted by a self-test.
// Comment-stripped (a commented-out assertion must not rubber-stamp coverage) and
// call-shape-agnostic (`via, .case` | `via == .case` | `via: .case`).
guard('INV-2 signal coverage', () => {
  const src = read('macos/Sources/SpeakerCore/MeetActiveSpeaker.swift');
  const tests = stripComments(read('macos/Sources/SpeakerCoreSelfTest/main.swift'));
  const block = (src.match(/enum\s+MeetSpeakerSignal[^{]*\{([\s\S]*?)\n\}/) || [, ''])[1];
  const cases = [...block.matchAll(/case\s+(\w+)/g)].map((m) => m[1]).filter((c) => c !== 'none');
  if (!cases.length) return fail('INV-2 signal coverage', 'could not parse MeetSpeakerSignal cases');
  for (const c of cases) {
    if (new RegExp(`via\\s*(?:,|==|:)\\s*\\.${c}\\b`).test(tests)) pass('INV-2 signal coverage', `.${c} is asserted`);
    else fail('INV-2 signal coverage', `MeetSpeakerSignal .${c} has no via/.${c} self-test assertion`);
  }
});

// INV-3 — token-independence scenarios still exist. Detection must never depend on
// a rotating Google CSS token; these scenarios prove it and must not be deleted.
guard('INV-3 token-independence', () => {
  const specs = [
    { f: 'research/meet-dom-detector/fixtures.js', id: 'structural-anchor-no-tokens' },
    { f: 'research/meet-dom-detector/browser-qa/meet-sim.html', id: 'rotation-state-class' },
    { f: 'research/meet-dom-detector/browser-qa/meet-sim.html', id: 'structural-no-jsname' },
  ];
  for (const s of specs) {
    if (read(s.f).includes(s.id)) pass('INV-3 token-independence', `${s.f.split('/').pop()} keeps '${s.id}'`);
    else fail('INV-3 token-independence', `${s.f} is missing '${s.id}' — detection may be depending on a rotating CSS token`);
  }
});

// INV-4 — each suite's baseline in the manifest matches CI + README, SCOPED to that
// suite's own context (a bare file-wide `.includes` rubber-stamps a swapped baseline
// because both counts legitimately appear in both files). The `N/N` token must sit
// on a line that also identifies the suite.
guard('INV-4 baseline drift', () => {
  const ci = read('.github/workflows/meet-detector-qa.yml');
  const readme = read('research/meet-dom-detector/README.md');
  // suite id -> a keyword that identifies ITS line (must not collide with the other suite)
  const CTX = { 'node-harness': /logic harness|test\.js/i, 'browser-qa': /real-browser|browser-qa|run-browser/i };
  const onScopedLine = (text, tok, kw) => text.split('\n').some((ln) => ln.includes(tok) && kw.test(ln));
  for (const s of config.suites) {
    if (s.minCount == null) continue;
    const tok = `${s.minCount}/${s.minCount}`;
    const kw = CTX[s.id];
    if (!kw) {
      const okC = ci.includes(tok), okR = readme.includes(tok);
      (okC && okR ? pass : fail)('INV-4 baseline drift', `${s.id} baseline ${tok} ${okC && okR ? 'present (unscoped)' : 'missing'} in CI+README`);
      continue;
    }
    const okC = onScopedLine(ci, tok, kw), okR = onScopedLine(readme, tok, kw);
    if (okC && okR) pass('INV-4 baseline drift', `${s.id} baseline ${tok} on a ${s.id}-scoped line in CI + README`);
    else fail('INV-4 baseline drift', `${s.id} baseline ${tok} not on a ${s.id}-scoped line in ${!okC ? 'CI ' : ''}${!okR ? 'README' : ''} (drift or mislabel)`);
  }
});

// INV-5 — event/transition attribution paths exclude the SELF tile, same as the
// legacy paths (INV-1). The edge path can name the local user just as easily as the
// ring path did, so guard it explicitly. Both MeetActiveSpeaker.swift (the resolver's
// new .ringTransition path) and MeetEdgeEvents.swift (the pure diff→edge extractor)
// must filter isMe, AND a self-focus-edge-yields-no-name self-test must exist.
guard('INV-5 event self-exclusion', () => {
  const selfTok = /!\s*\$0\.isMe|isMe\s*==\s*false|!\s*\w*\.?isMe|isMe\s*!=\s*true/;
  for (const f of ['macos/Sources/SpeakerCore/MeetActiveSpeaker.swift', 'macos/Sources/SpeakerCore/MeetEdgeEvents.swift']) {
    const src = readOrNull(f);
    if (src == null) { fail('INV-5 event self-exclusion', `${f} is missing — the event/edge path is unverifiable (parallel Swift work not landed?)`); continue; }
    if (selfTok.test(stripComments(src))) pass('INV-5 event self-exclusion', `${f.split('/').pop()} excludes the self tile`);
    else fail('INV-5 event self-exclusion', `${f.split('/').pop()} does NOT exclude the self tile — the edge/transition path can name the local user`);
  }
  const tests = readOrNull('macos/Sources/SpeakerCoreSelfTest/main.swift');
  if (tests == null) { fail('INV-5 event self-exclusion', 'SpeakerCoreSelfTest/main.swift is missing — no self-exclusion self-test'); return; }
  // A test that a self-owned focus/ring edge yields no name (isMe target is dropped).
  const stripped = stripComments(tests);
  if (/isMe\s*:\s*true/.test(stripped) && /(focus|ring).{0,80}(edge|Edge|Transition)/i.test(stripped)) {
    pass('INV-5 event self-exclusion', 'a self-focus/ring-edge-yields-no-name self-test exists');
  } else {
    fail('INV-5 event self-exclusion', 'no self-focus-edge self-test (expected an isMe:true focus/ring edge asserted to yield no name)');
  }
});

// INV-6 — the decay math in TransitionConfidence.swift is TIME-INJECTED (all
// timestamps passed in as monotonic nowMs), never read from a clock inside SpeakerCore
// — otherwise the decay self-tests are non-deterministic. Comment-stripped so a clock
// call named only in a comment doesn't false-alarm. AND a decay self-test must exist.
guard('INV-6 decay time-injected', () => {
  const src = readOrNull('macos/Sources/SpeakerCore/TransitionConfidence.swift');
  if (src == null) { fail('INV-6 decay time-injected', 'macos/Sources/SpeakerCore/TransitionConfidence.swift is missing — decay purity unverifiable'); return; }
  const stripped = stripComments(src);
  const banned = [/\bDate\s*\(\s*\)/, /DispatchTime\.now/, /CACurrentMediaTime/, /mach_absolute_time/];
  const hits = banned.filter((re) => re.test(stripped)).map((re) => re.source);
  if (hits.length) fail('INV-6 decay time-injected', `TransitionConfidence.swift reads a clock directly (${hits.join(', ')}) — inject nowMs instead; decay tests become non-deterministic`);
  else pass('INV-6 decay time-injected', 'no Date()/DispatchTime.now/CACurrentMediaTime/mach_absolute_time in TransitionConfidence.swift');
  const tests = readOrNull('macos/Sources/SpeakerCoreSelfTest/main.swift');
  if (tests == null) { fail('INV-6 decay time-injected', 'SpeakerCoreSelfTest/main.swift is missing — no decay self-test'); return; }
  // A decay test references the confidence type and asserts a decayed value (e.g. 0.625 at half-life, or a halfLife/decay token).
  if (/TransitionConfidence|halfLife|0\.625|decay/i.test(stripComments(tests))) pass('INV-6 decay time-injected', 'a TransitionConfidence decay self-test exists');
  else fail('INV-6 decay time-injected', 'no decay self-test found in SpeakerCoreSelfTest (expected a TransitionConfidence/halfLife/0.625 assertion)');
});

// INV-7 — the LIVE manifest must NEVER be wired into CI. CI runs the default,
// deterministic manifest only; qa.live.config.mjs launches Chrome + the detector app
// and must stay out of the GitHub Actions workflow.
guard('INV-7 live manifest not in CI', () => {
  const ci = readOrNull('.github/workflows/meet-detector-qa.yml');
  if (ci == null) { fail('INV-7 live manifest not in CI', 'CI workflow .github/workflows/meet-detector-qa.yml is missing'); return; }
  for (const manifest of ['qa.live.config.mjs', 'qa.teams.config.mjs']) {
    if (new RegExp(manifest.replace(/\./g, '\\.')).test(ci)) fail('INV-7 live manifest not in CI', `CI references ${manifest} — the live gate would try to launch apps in CI`);
    else pass('INV-7 live manifest not in CI', `CI does not reference ${manifest}`);
  }
});

// INV-8 — the A/B flag is wired in the engine: the source handles BOTH MSD_MODE=event
// (observer path) and legacy (500ms polling). cpu-compare-live's baseline depends on
// legacy still counting full_walks per scan; ax-events depends on event mode emitting
// edges. Search the engine/app sources for both modes being handled.
guard('INV-8 A/B flag wired', () => {
  const files = [
    'macos/Sources/MeetSpeakerDetector/ViewModel/AppModel.swift',
    'macos/Sources/MeetSpeakerDetector/Engine/DetectionEngine.swift',
  ];
  const present = files.map((f) => ({ f, src: readOrNull(f) }));
  const missing = present.filter((p) => p.src == null).map((p) => p.f);
  if (missing.length === present.length) { fail('INV-8 A/B flag wired', `engine/app sources missing (${missing.join(', ')}) — A/B flag unverifiable`); return; }
  const all = present.map((p) => p.src || '').join('\n');
  const handlesMode = /MSD_MODE/.test(all);
  const handlesEvent = /"event"|'event'|\.event\b|== *"event"|eventDrivenMeet/.test(all);
  const handlesLegacy = /"legacy"|'legacy'|\.legacy\b|== *"legacy"/.test(all) || /eventDrivenMeet/.test(all); // legacy = the eventDrivenMeet=false default path
  if (handlesMode && handlesEvent && handlesLegacy) pass('INV-8 A/B flag wired', 'engine handles MSD_MODE=event and legacy');
  else fail('INV-8 A/B flag wired', `engine A/B flag incomplete (MSD_MODE:${handlesMode} event:${handlesEvent} legacy:${handlesLegacy}) — cpu-compare cannot A/B`);
});

// INV-9 — Teams speaking is CLASS-FREE (docs/teams-active-speaker-detection.md §7:
// no passive who-is-speaking signal exists). The builtin rules must ship an EMPTY
// speakingClasses — `vdi-frame-occlusion` (a video-placement token that shipped
// briefly as a speaking class) must never return outside a comment — and the
// self-test must assert the ring names the speaker so a regression fails loudly.
// INV-9 (2026-07-04, SUPERSEDES the earlier "class-free" stance): Teams DOES
// expose a per-speaker ring (vdi-frame-occlusion, live-verified 3-party
// co-variance). The invariant now guards that the ring is (a) shipped as the
// speaking signal and (b) read STRUCTURALLY — inside a resolved tile's subtree,
// never a whole-window `.contains` (which would mismark the tile-wide
// vdi-occlusion / self vdi-dynamic-occlusion).
guard('INV-9 teams ring structural', () => {
  const rules = stripComments(readOrNull('macos/Sources/SpeakerCore/TeamsSpeakerRules.swift') || '');
  if (!rules) { fail('INV-9 teams ring structural', 'TeamsSpeakerRules.swift is missing'); return; }
  if (/speakingClasses:\s*\[[^\]]*vdi-frame-occlusion/.test(rules)) pass('INV-9 teams ring structural', 'builtin speakingClasses ships vdi-frame-occlusion (the ring)');
  else fail('INV-9 teams ring structural', 'builtin speakingClasses no longer carries vdi-frame-occlusion — the live-verified speaker ring was dropped');
  // The ring MUST be read per-tile (a bounded subtree scan), not whole-window.
  const ext = stripComments(readOrNull('macos/Sources/SpeakerCore/TeamsTileExtraction.swift') || '');
  if (/teamsTileSubtreeSpeaks\s*\(/.test(ext) && /func\s+teamsTileSubtreeSpeaks/.test(ext)) pass('INV-9 teams ring structural', 'ring read via a per-tile subtree scan (teamsTileSubtreeSpeaks), not whole-window');
  else fail('INV-9 teams ring structural', 'no per-tile subtree scan for the ring — a whole-window class scan would mismark vdi-occlusion/vdi-dynamic-occlusion');
  const tests = stripComments(readOrNull('macos/Sources/SpeakerCoreSelfTest/main.swift') || '');
  if (/names EXACTLY Alice|resolver names BOTH remotes/.test(tests)) pass('INV-9 teams ring structural', 'self-test asserts the ring names the exact speaker(s)');
  else fail('INV-9 teams ring structural', 'no self-test asserts the ring-based speaker timeline');
});

// INV-10 — Teams attribution paths exclude the SELF tile (the exact bug INV-1/5
// guard on Meet): the structural path must filter isMe, the geometry path must
// refuse a self winner, and a token-on-self self-test must exist.
guard('INV-10 teams self-exclusion', () => {
  const src = readOrNull('macos/Sources/SpeakerCore/TeamsActiveSpeaker.swift');
  if (src == null) { fail('INV-10 teams self-exclusion', 'TeamsActiveSpeaker.swift is missing'); return; }
  const stripped = stripComments(src);
  const m = /filter\s*\{([^}]*isSpeaking[^}]*)\}/.exec(stripped);
  if (!m) fail('INV-10 teams self-exclusion', 'structural isSpeaking predicate not found (refactored? tighten the matcher)');
  else if (/!\s*\$0\.isMe|isMe\s*==\s*false/.test(m[1])) pass('INV-10 teams self-exclusion', 'structural path excludes self');
  else fail('INV-10 teams self-exclusion', 'structural path does NOT exclude the self tile — it can name the local user');
  if (/isMe\s*!=\s*true/.test(stripped)) pass('INV-10 teams self-exclusion', 'geometry (promoted) excludes self');
  else fail('INV-10 teams self-exclusion', 'geometry path does NOT exclude the self tile');
  const tests = stripComments(readOrNull('macos/Sources/SpeakerCoreSelfTest/main.swift') || '');
  if (/isSpeaking:\s*true,\s*isMe:\s*true/.test(tests)) pass('INV-10 teams self-exclusion', 'a token-on-SELF self-test exists');
  else fail('INV-10 teams self-exclusion', 'no token-on-SELF self-test (expected an isSpeaking:true, isMe:true tile asserted unnamed)');
});

// INV-11 — the Teams deterministic loop replays the REAL captured fixtures. The
// committed distillations must exist and the self-test must load each — deleting a
// fixture (or the loader) silently un-tests a whole matrix cell.
guard('INV-11 teams fixture replay', () => {
  const fixtures = [
    'native-2p-share-cameraoff-remote',
    'native-3p-sidegallery-share',
    'native-home-meet-tab-negative',
  ];
  const tests = stripComments(readOrNull('macos/Sources/SpeakerCoreSelfTest/main.swift') || '');
  for (const f of fixtures) {
    if (readOrNull(`macos/Fixtures/teams/${f}.json`) == null) fail('INV-11 teams fixture replay', `macos/Fixtures/teams/${f}.json is missing`);
    else if (tests.includes(`loadTeamsFixture("${f}")`)) pass('INV-11 teams fixture replay', `${f} exists + replayed in the self-test`);
    else fail('INV-11 teams fixture replay', `${f}.json exists but is never replayed by the self-test`);
  }
});

// INV-12 — ONE Teams extractor. The scanner must consume the pure
// SpeakerCore.teamsExtractWindow (what the fixtures replay), never a second
// AX-side reimplementation (the drift the Meet subtree scan already solved);
// and the pure module must stay AppKit-free or the fixture replay dies.
guard('INV-12 teams single extractor', () => {
  const scanner = stripComments(readOrNull('macos/Sources/MeetSpeakerDetector/Engine/AccessibilityScanner.swift') || '');
  if (/teamsExtractWindow\s*\(/.test(scanner)) pass('INV-12 teams single extractor', 'scanner consumes SpeakerCore.teamsExtractWindow');
  else fail('INV-12 teams single extractor', 'scanner does not call teamsExtractWindow — Teams extraction forked from the tested path');
  if (/isTeamsParticipantTile|teamsTileObservations/.test(scanner)) fail('INV-12 teams single extractor', 'scanner still carries a second Teams tile extractor (isTeamsParticipantTile/teamsTileObservations) — drift risk');
  else pass('INV-12 teams single extractor', 'no duplicate Teams tile extractor in the scanner');
  const pure = stripComments(readOrNull('macos/Sources/SpeakerCore/TeamsTileExtraction.swift') || '');
  if (!pure) fail('INV-12 teams single extractor', 'TeamsTileExtraction.swift is missing');
  else if (/import\s+(AppKit|ApplicationServices|CoreGraphics)/.test(pure)) fail('INV-12 teams single extractor', 'TeamsTileExtraction.swift imports AX/AppKit — no longer pure/fixture-replayable');
  else pass('INV-12 teams single extractor', 'TeamsTileExtraction.swift is Foundation-only (fixture-replayable)');
});

// --- report ---------------------------------------------------------------
const bad = results.filter((r) => !r.ok);
console.log('QA-check review — executable invariants over the checks themselves');
for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} [${r.inv}] ${r.msg}`);
if (bad.length) {
  console.log(`\n${bad.length} violation(s) — the QA suite has regressed on a reviewed invariant.`);
  process.exit(1);
}
console.log(`\nall ${results.length} invariants hold.`);
process.exit(0);
