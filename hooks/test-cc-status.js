#!/usr/bin/env node
'use strict';
/**
 * test-cc-status.js — Phase-2 state-machine integration test.
 *
 * Spawns the REAL hooks/cc-status.js once per hook event (exactly how Claude
 * Code fires hooks — one node process per event), with HOME pointed at a
 * throwaway temp dir so the real ~/.claude is never touched. Each event's JSON
 * is fed on stdin; after each fire we read back the resulting status file and
 * assert the state.
 *
 * This exercises the full path: main() → readStdin → read-modify-write cur →
 * deriveStatus(payload, cur) → atomic write. No logic is duplicated — if this
 * test passes/fails, the real hook passes/fails identically.
 *
 * Run:  node hooks/test-cc-status.js
 */

// NOTE: project package.json is "type":"module", so this file is ESM. The
// cc-status.js hook itself uses dynamic import() to stay module-agnostic; this
// test simply uses static ESM imports since it only runs under `node` in-tree.
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'cc-status.js');
const SID = 'test-session-001';

let pass = 0;
let fail = 0;

// --- helpers --------------------------------------------------------------

function newTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-status-test-'));
}

function stateFile(home) {
  return path.join(home, '.claude', 'cc-tab-status', SID + '.json');
}

/** Read the on-disk status for SID under `home`. Returns null if no file
 *  (deleted by SessionEnd, or never written). */
function readState(home) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(home), 'utf8'));
  } catch {
    return null;
  }
}

/** Fire one hook event against a fresh-ish cc-status.js process. `extra` is
 *  merged into the payload (use {background_tasks:[...]} to drive method B,
 *  {error:'rate_limit'} for StopFailure). Returns the post-fire status. */
function fire(home, event, extra) {
  const payload = Object.assign(
    { hook_event_name: event, session_id: SID },
    extra || {}
  );
  // HOME override → os.homedir() inside the child resolves to our temp dir,
  // so all writes land under <temp>/.claude/cc-tab-status/.
  spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload),
    env: Object.assign({}, process.env, { HOME: home }),
    encoding: 'utf8',
  });
  return readState(home);
}

/** Run a sequence of events against a fresh temp HOME. Each item is either a
 *  bare event name or {event, extra}. Returns the final on-disk status. */
function runSeq(events) {
  const home = newTempHome();
  let last = null;
  for (const ev of events) {
    const e = typeof ev === 'string' ? { event: ev } : ev;
    last = fire(home, e.event, e.extra);
  }
  return last;
}

function check(name, got, expectedState) {
  const gotState = got ? got.state : null;
  const ok = gotState === expectedState;
  if (ok) {
    pass++;
    console.log('  PASS  ' + name + '   -> state=' + gotState);
  } else {
    fail++;
    const extra = got ? ' (activeSubagents=' + got.activeSubagents + ')' : ' (no file)';
    console.log('  FAIL  ' + name + '   expected=' + expectedState + ' got=' + gotState + extra);
  }
  return ok;
}

/** Like check(), but also asserts activeSubagents — used for regression cases
 *  that care about residual-counter cleanup, not just the visible state. */
function checkBoth(name, got, expectedState, expectedActive) {
  const gotState = got ? got.state : null;
  const gotActive = got ? got.activeSubagents : null;
  const ok = gotState === expectedState && gotActive === expectedActive;
  if (ok) {
    pass++;
    console.log('  PASS  ' + name + '   -> state=' + gotState + ' activeSubagents=' + gotActive);
  } else {
    fail++;
    console.log(
      '  FAIL  ' + name +
      '   expected state=' + expectedState + ' active=' + expectedActive +
      ' got state=' + gotState + ' active=' + gotActive
    );
  }
  return ok;
}

// --- scenarios ------------------------------------------------------------

console.log('Phase-2 state machine integration tests');
console.log('(real hooks/cc-status.js, isolated HOME, method A counting + method B payload)\n');

// 1. Baseline: plain turn, no subagent -> done.
check(
  '1. UserPromptSubmit -> Stop = done (no subagent)',
  runSeq(['UserPromptSubmit', 'Stop']),
  'done'
);

// 2. (Semantics fix, bug e434c0a2): a counter bump with NO payload at Stop
//    no longer false-sticks at running. The drift-prone activeSubagents counter
//    is not consulted at Stop; only the payload is authoritative. The real
//    "workflow in flight -> running" guarantee is covered by the payload-driven
//    cases (7 and 10 below). Same sequence that used to assert 'running'.
check(
  '2. UserPromptSubmit -> SubagentStart -> Stop (no payload) = done',
  runSeq(['UserPromptSubmit', 'SubagentStart', 'Stop']),
  'done'
);

// 3. Subagent finishes before Stop -> done. (Exposes the SubagentStop null-return bug.)
check(
  '3. UserPromptSubmit -> SubagentStart -> SubagentStop -> Stop = done',
  runSeq(['UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop']),
  'done'
);

// 4. (Semantics fix): counter says "1 left" but Stop has no payload -> done.
//    Only an authoritative inflight payload keeps it running at Stop.
check(
  '4. 2xStart -> SubagentStop -> Stop (no payload) = done (counter ignored at Stop)',
  runSeq(['UserPromptSubmit', 'SubagentStart', 'SubagentStart', 'SubagentStop', 'Stop']),
  'done'
);

// 5. StopFailure always wins interrupted, even with a subagent in flight.
check(
  '5. SubagentStart -> StopFailure = interrupted (interrupt wins)',
  runSeq([
    'UserPromptSubmit',
    'SubagentStart',
    { event: 'StopFailure', extra: { error: 'rate_limit' } },
  ]),
  'interrupted'
);

// 6. SessionEnd removes the status file.
{
  const got = runSeq(['UserPromptSubmit', { event: 'SessionEnd' }]);
  const ok = got === null;
  if (ok) { pass++; console.log('  PASS  6. SessionEnd deletes status file   -> (no file)'); }
  else    { fail++; console.log('  FAIL  6. SessionEnd should delete file, got state=' + (got && got.state)); }
}

// 7. Method B (authoritative): Stop with non-empty background_tasks -> running,
//    even though the activeSubagents counter was never incremented. Proves the
//    primary (B) path is independent of the (A) counter.
check(
  '7. Stop w/ background_tasks=[workflow] = running (method B, no counter)',
  runSeq([
    'UserPromptSubmit',
    { event: 'Stop', extra: { background_tasks: [{ id: 'w1', type: 'workflow' }] } },
  ]),
  'running'
);

// 8. Method B authoritative correction on SubagentStop: a workflow still in
//    flight keeps running; the counter is also corrected to the payload value.
{
  const got = runSeq([
    'UserPromptSubmit',
    'SubagentStart',                                                       // counter=1
    { event: 'SubagentStop', extra: { background_tasks: [{ id: 'w1', type: 'workflow' }, { id: 's1', type: 'subagent' }] } },
  ]);
  // SubagentStop sees inflight=2 -> next=2>0 -> writes running, activeSubagents=2
  check('8. SubagentStop w/ background_tasks=2 = running (B corrects A)', got, 'running');
}

// --- summary --------------------------------------------------------------

//
// Regression cases for bug e434c0a2 (Stop with no background_tasks payload
// false-stuck at "running" because it fell back to a drifted activeSubagents
// counter). These pin the fixed semantics: at Stop, ONLY the payload count
// decides state; a missing payload means done + counter cleared.
//

// 9. [REGRESSION] The exact bug: a stale activeSubagents=1 on disk (left by a
//    SubagentStart with no matching SubagentStop) + Stop with no background_tasks
//    payload -> done, counter cleared to 0. Old code returned running here.
checkBoth(
  '9. [REGRESSION] Start -> Stop (no payload, stale counter=1) = done, counter=0',
  runSeq(['UserPromptSubmit', 'SubagentStart', 'Stop']),
  'done',
  0
);

// 10. Stop with inflight=2 (authoritative payload) -> running, counter=2.
checkBoth(
  '10. Stop w/ background_tasks=[a,b] = running, counter=2',
  runSeq([{ event: 'Stop', extra: { background_tasks: [{ id: 'a' }, { id: 'b' }] } }]),
  'running',
  2
);

// 11. Stop with inflight=0 (explicit empty payload array) -> done, counter=0.
checkBoth(
  '11. Stop w/ background_tasks=[] = done, counter=0',
  runSeq([{ event: 'Stop', extra: { background_tasks: [] } }]),
  'done',
  0
);

// 12. [REGRESSION] UserPromptSubmit with no payload resets a drifted counter to
//     0, so drift cannot cross into the new turn.
checkBoth(
  '12. [REGRESSION] SubagentStart -> UserPromptSubmit (no payload) = running, counter=0',
  runSeq(['SubagentStart', 'UserPromptSubmit']),
  'running',
  0
);

// 13. PreToolUse/PostToolUse heartbeat path. Both events must:
//   (a) keep state='running' (per deriveStatus case 'PreToolUse'/'PostToolUse'),
//   (b) refresh `since` each fire (verified indirectly via the counter rule),
//   (c) write activeSubagents=0 when no payload is present (the same reset
//       semantics as UserPromptSubmit — locks the heartbeat against the
//       drifted-counter bleed-through bug).
//   No prior test directly exercised this case; a regression that made
//   PreToolUse carry drift across events would only be caught here.
checkBoth(
  '13. UserPromptSubmit -> PreToolUse -> PostToolUse -> Stop = done, counter=0 (heartbeat)',
  runSeq(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']),
  'done',
  0
);

// 14. SubagentStop arriving AFTER Stop (late / orphan) must NOT refresh the
//     terminal `since` timestamp. The reader's notify-dedup keys on the
//     terminal `since`, so refreshing it would re-fire a duplicate "turn
//     complete" notification for the SAME turn AND reset the done→idle 5-min
//     countdown. Locks the M13 fix (preserve cur.since when cur.state is
//     already terminal AND next===0). Also confirms counter stays 0.
{
  const home = newTempHome();
  fire(home, 'UserPromptSubmit');
  fire(home, 'Stop');
  const sinceAfterStop = readState(home).since;
  // Simulate a late SubagentStop arriving after Stop (orphan / race).
  fire(home, 'SubagentStop');
  const final = readState(home);
  const ok = final
    && final.state === 'done'
    && final.since === sinceAfterStop
    && final.activeSubagents === 0;
  if (ok) {
    pass++;
    console.log('  PASS  14. [REGRESSION] SubagentStop after Stop preserves done + since + counter=0');
  } else {
    fail++;
    console.log(
      '  FAIL  14. expected done+preserved since(' + sinceAfterStop + ')+0,' +
      ' got state=' + (final && final.state) +
      ' since=' + (final && final.since) +
      ' active=' + (final && final.activeSubagents)
    );
  }
}

// 15. StopFailure persists the error enum verbatim. The reader maps known
//     enums (rate_limit/overloaded) to friendlier text; a missing/typed-wrong
//     error falls back to 'interrupted' (aligned writer/reader default per
//     STATES.md §4b). Pin the disk-side half: error must be a string and must
//     equal the payload value when one is supplied. Also assert state.
{
  const home = newTempHome();
  fire(home, 'UserPromptSubmit');
  // `fire` takes (home, event, extra) — three args, NOT a {event,extra} object.
  const final = fire(home, 'StopFailure', { error: 'rate_limit' });
  const okState = final && final.state === 'interrupted';
  const okError = final && typeof final.error === 'string' && final.error === 'rate_limit';
  if (okState && okError) {
    pass++;
    console.log('  PASS  15. StopFailure w/ error=rate_limit -> interrupted, error="rate_limit" persisted');
  } else {
    fail++;
    console.log(
      '  FAIL  15. expected interrupted+error=rate_limit,' +
      ' got state=' + (final && final.state) +
      ' error=' + (final && JSON.stringify(final.error))
    );
  }
}

// --- v0.1.13: Notification pending flag (🔵 commandCenter light) ------------
// Notification marks pending:true on the session file; every non-Notification
// event clears it. The reader counts pending INDEPENDENTLY of state, so a
// session can be both running AND pending (a running turn paused on a
// permission/question/elicit prompt — the typical case).

// 16. Notification on a fresh session (no prior file) writes pending:true,
//     state coerced to running (Notification can fire first — default cur is
//     also running), since=now (cur.since defaults to 0, falsy → now).
{
  const home = newTempHome();
  const final = fire(home, 'Notification');
  const ok = final && final.state === 'running' && final.pending === true;
  if (ok) {
    pass++;
    console.log('  PASS  16. Notification (no prior file) -> running, pending=true');
  } else {
    fail++;
    console.log(
      '  FAIL  16. expected running+pending=true, got state=' +
      (final && final.state) + ' pending=' + (final && final.pending)
    );
  }
}

// 17. Notification on an existing running turn PRESERVES state + since and
//     ONLY adds pending:true. Regression check: a refactor that re-wrote
//     since=now on Notification would race with the reader's notify-dedup
//     (which keys on terminal since — though Notification doesn't fire on
//     terminal states, locking the preserve-since rule is still correct).
{
  const home = newTempHome();
  fire(home, 'UserPromptSubmit');
  const before = readState(home);
  const sinceBefore = before.since;
  const final = fire(home, 'Notification');
  const ok = final
    && final.state === 'running'
    && final.since === sinceBefore  // PRESERVED, not refreshed
    && final.pending === true;
  if (ok) {
    pass++;
    console.log('  PASS  17. Notification preserves state=running + since, sets pending=true');
  } else {
    fail++;
    console.log(
      '  FAIL  17. expected running+preserved since(' + sinceBefore + ')+pending=true,' +
      ' got state=' + (final && final.state) +
      ' since=' + (final && final.since) +
      ' pending=' + (final && final.pending)
    );
  }
}

// 18. Notification on an interrupted session preserves interrupted state +
//     adds pending:true (e.g. user is prompted while an error is showing).
//     error is dropped by the writer on every non-StopFailure write — locks
//     the existing behavior pattern (every other case also drops error).
{
  const home = newTempHome();
  fire(home, 'UserPromptSubmit');
  fire(home, 'StopFailure', { error: 'rate_limit' });
  const final = fire(home, 'Notification');
  const ok = final
    && final.state === 'interrupted'
    && final.pending === true;
  if (ok) {
    pass++;
    console.log('  PASS  18. Notification on interrupted preserves state, sets pending=true');
  } else {
    fail++;
    console.log(
      '  FAIL  18. expected interrupted+pending=true, got state=' +
      (final && final.state) + ' pending=' + (final && final.pending)
    );
  }
}

// 19. UserPromptSubmit clears pending (the user answered the prompt).
{
  const home = newTempHome();
  fire(home, 'UserPromptSubmit');
  fire(home, 'Notification');
  // pending now true
  const final = fire(home, 'UserPromptSubmit');
  const ok = final && final.state === 'running' && final.pending === false;
  if (ok) {
    pass++;
    console.log('  PASS  19. UserPromptSubmit after Notification clears pending');
  } else {
    fail++;
    console.log(
      '  FAIL  19. expected running+pending=false, got state=' +
      (final && final.state) + ' pending=' + (final && final.pending)
    );
  }
}

// 20. PreToolUse clears pending (heartbeat = progress, not waiting).
{
  const home = newTempHome();
  fire(home, 'UserPromptSubmit');
  fire(home, 'Notification');
  const final = fire(home, 'PreToolUse');
  const ok = final && final.state === 'running' && final.pending === false;
  if (ok) {
    pass++;
    console.log('  PASS  20. PreToolUse after Notification clears pending');
  } else {
    fail++;
    console.log(
      '  FAIL  20. expected running+pending=false, got state=' +
      (final && final.state) + ' pending=' + (final && final.pending)
    );
  }
}

// 21. Stop clears pending and writes done.
{
  const home = newTempHome();
  fire(home, 'UserPromptSubmit');
  fire(home, 'Notification');
  const final = fire(home, 'Stop');
  const ok = final && final.state === 'done' && final.pending === false;
  if (ok) {
    pass++;
    console.log('  PASS  21. Stop after Notification -> done, pending=false');
  } else {
    fail++;
    console.log(
      '  FAIL  21. expected done+pending=false, got state=' +
      (final && final.state) + ' pending=' + (final && final.pending)
    );
  }
}

// 22. SessionEnd still deletes the status file even if pending was set —
//     no half-state leaks when the session closes mid-prompt.
{
  const home = newTempHome();
  fire(home, 'UserPromptSubmit');
  fire(home, 'Notification');
  const final = fire(home, 'SessionEnd');
  const ok = final === null;
  if (ok) {
    pass++;
    console.log('  PASS  22. SessionEnd deletes file even with pending=true   -> (no file)');
  } else {
    fail++;
    console.log('  FAIL  22. SessionEnd should delete file, got state=' + (final && final.state));
  }
}

// --- v0.1.13 review round-2: Subagent* preserves cur.pending (MEDIUM fix) ---
// SubagentStart / SubagentStop are BACKGROUND events on the parent session
// with no signal about whether a parent permission/question/elicit prompt is
// still open. They must therefore PRESERVE cur.pending instead of clearing it.
// Previously both wrote `pending:false` unconditionally, which false-negatived
// the 🔵 commandCenter light whenever a background subagent event fired during
// a Notification prompt. These tests lock the preserve-pending behavior.

// 23. SubagentStop after Notification PRESERVES pending=true. Sequence mirrors
//     the bug report: parent running, hits a permission prompt (Notification),
//     then a background subagent wraps up while the prompt is still open.
{
  const home = newTempHome();
  fire(home, 'UserPromptSubmit');
  fire(home, 'Notification');
  // pending now true; a subagent finishing must NOT extinguish it.
  const final = fire(home, 'SubagentStop');
  const ok = final && final.state === 'running' && final.pending === true;
  if (ok) {
    pass++;
    console.log('  PASS  23. SubagentStop after Notification preserves pending=true');
  } else {
    fail++;
    console.log(
      '  FAIL  23. expected running+pending=true (preserve), got state=' +
      (final && final.state) + ' pending=' + (final && final.pending)
    );
  }
}

// 24. SubagentStart after Notification PRESERVES pending=true. A subagent
//     spawning mid-prompt is the canonical "workflow helper fired while the
//     user is answering a permission prompt" case.
{
  const home = newTempHome();
  fire(home, 'UserPromptSubmit');
  fire(home, 'Notification');
  const final = fire(home, 'SubagentStart');
  const ok = final && final.state === 'running' && final.pending === true;
  if (ok) {
    pass++;
    console.log('  PASS  24. SubagentStart after Notification preserves pending=true');
  } else {
    fail++;
    console.log(
      '  FAIL  24. expected running+pending=true (preserve), got state=' +
      (final && final.state) + ' pending=' + (final && final.pending)
    );
  }
}

// 25. REGRESSION GUARD: SubagentStart on a fresh session (no prior Notification,
//     so cur.pending defaults to false) must NOT fabricate pending=true. The
//     preserve rule is `cur.pending === true` — a falsy cur.pending stays falsy.
//     Without this guard, a future refactor that flipped the default could turn
//     every subagent into a false 🔵 pending count.
{
  const home = newTempHome();
  const final = fire(home, 'SubagentStart');
  const ok = final && final.state === 'running' && final.pending === false;
  if (ok) {
    pass++;
    console.log('  PASS  25. SubagentStart on fresh session writes pending=false (no fabrication)');
  } else {
    fail++;
    console.log(
      '  FAIL  25. expected running+pending=false, got state=' +
      (final && final.state) + ' pending=' + (final && final.pending)
    );
  }
}

// --- summary --------------------------------------------------------------

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
