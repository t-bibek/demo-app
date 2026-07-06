#!/usr/bin/env node
// Bootstrap a native Zoom host meeting + harvest the invite URL, using the shared
// zoom-host-lib. Prints the invite URL on the LAST line (INVITE=<url>) so Bash can capture
// it. Also admits web guests on demand when run with `admit <targetCount>`.
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const lib = await import(join(REPO, 'qa', 'zoom-live', 'zoom-host-lib.mjs'));
const { makeLog, prebuild, preflightAxTrust, preflightSignedIn, bootstrapMeeting,
        harvestInvite, admitLoop, endMeeting, rosterCount, meetingWindowPresent } = lib;
const log = makeLog('zw-host');

const action = process.argv[2] || 'start';

if (action === 'start') {
  if (!preflightAxTrust()) { console.error('AX NOT TRUSTED'); process.exit(3); }
  preflightSignedIn();
  if (!await bootstrapMeeting(log)) { console.error('BOOTSTRAP_FAILED'); process.exit(4); }
  const invite = process.env.ZOOM_MEETING_URL || await harvestInvite(log);
  if (!invite) { console.error('NO_INVITE'); process.exit(5); }
  log(`roster=${rosterCount()} meetingWindow=${meetingWindowPresent()}`);
  console.log(`INVITE=${invite}`);
  process.exit(0);
}

if (action === 'admit') {
  const target = Number(process.argv[3] || 2);
  const ok = await admitLoop({ targetCount: target, waitMs: 120_000 }, log);
  console.log(`ADMIT ok=${ok} roster=${rosterCount()}`);
  process.exit(ok ? 0 : 6);
}

if (action === 'roster') {
  console.log(`ROSTER=${rosterCount()} meetingWindow=${meetingWindowPresent()}`);
  process.exit(0);
}

if (action === 'end') {
  const ok = await endMeeting(log);
  console.log(`END ok=${ok} meetingWindow=${meetingWindowPresent()}`);
  process.exit(0);
}

console.error('usage: host-bootstrap.mjs start|admit <n>|roster|end');
process.exit(2);
