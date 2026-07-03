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
