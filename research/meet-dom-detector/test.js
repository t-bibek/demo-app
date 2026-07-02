'use strict';
// QA loop: run the fallback-chain detector against every scenario fixture and
// report pass/fail. This is the executable substitute for a live-meeting loop —
// the REAL fixtures are verbatim captured Meet DOM; SYNTHETIC ones assert logic.
//
// Run:  node research/meet-dom-detector/test.js

const D = require('./detector');
const { SCENARIOS } = require('./fixtures');

const sortedEq = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

function checkOne(result, expect) {
  const okVia = !expect.via || result.via === expect.via;
  let okNames;
  if (expect.namesSet) okNames = sortedEq(result.names, expect.namesSet);
  else okNames = JSON.stringify(result.names) === JSON.stringify(expect.names);
  return okVia && okNames;
}

let pass = 0, fail = 0;
const rows = [];

for (const sc of SCENARIOS) {
  const built = sc.build(D);
  const runs = built.ticks
    ? built.ticks.map((t, i) => ({ tag: `${sc.id}#${i + 1}`, ...t }))
    : [{ tag: sc.id, nodes: built.nodes, ctx: built.ctx, expect: sc.expect }];

  for (const run of runs) {
    const res = D.detectActiveSpeaker(run.nodes, run.ctx, D.DEFAULT_CONFIG);
    const ok = checkOne(res, run.expect);
    if (ok) pass++; else fail++;
    rows.push({
      kind: sc.kind, tag: run.tag, ok,
      got: `${JSON.stringify(res.names)} via ${res.via}`,
      want: `${JSON.stringify(run.expect.namesSet || run.expect.names)} via ${run.expect.via || '*'}`,
      desc: sc.desc,
    });
  }
}

const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
console.log('\nGoogle Meet active-speaker detector — scenario matrix\n' + '='.repeat(92));
console.log(pad('RESULT', 8) + pad('KIND', 11) + pad('SCENARIO', 26) + 'GOT  /  WANT');
console.log('-'.repeat(92));
for (const r of rows) {
  console.log(
    pad(r.ok ? 'PASS' : 'FAIL', 8) + pad(r.kind, 11) + pad(r.tag, 26) +
    `${r.got}   |   ${r.want}`);
  if (!r.ok) console.log(pad('', 45) + '↳ ' + r.desc);
}
console.log('-'.repeat(92));
const byKind = (k) => `${rows.filter(r => r.kind === k && r.ok).length}/${rows.filter(r => r.kind === k).length}`;
console.log(`\n${pass}/${pass + fail} passed  (${byKind('REAL')} REAL captured-DOM, ` +
  `${byKind('REAL-EXT')} REAL-EXT current-widget, ${byKind('SYNTHETIC')} synthetic)\n`);

process.exit(fail === 0 ? 0 : 1);
