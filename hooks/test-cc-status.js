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
 *  {error:'rate_limit'} for StopFailure). Returns the post-fire status, or
 *  `undefined` when the child crashed — calling check/checkBoth on undefined
 *  is a no-op so a single crash is counted exactly ONCE (here) instead of
 *  being double-counted as both 'child crash' and a misleading 'expected
 *  done got null' next. Captures the spawnSync result and loudly fails the
 *  test if the child crashed (non-zero exit OR stderr output). Without this,
 *  a writer regression (dynamic-import error, accidental syntax error, Node-
 *  version incompatibility) leaves no file on disk and the test reports a
 *  generic "expected=done got=null" with no hint that the child crashed —
 *  actively hurting diagnosis. The check is per-fire so the failing case is
 *  pinpointed, not a single global assertion. */
function fire(home, event, extra) {
  const payload = Object.assign({ hook_event_name: event, session_id: SID }, extra || {});
  // HOME + USERPROFILE override → os.homedir() inside the child resolves to
  // our temp dir under BOTH POSIX (HOME) AND Windows (USERPROFILE), so all
  // writes land under <temp>/.claude/cc-tab-status/ cross-platform. Windows
  // Node ignores HOME and reads USERPROFILE (or HOMEDRIVE+HOMEPATH) for
  // os.homedir(); without USERPROFILE the spawned cc-status.js would resolve
  // to the real C:\Users\<user> and corrupt real state.
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload),
    env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }),
    encoding: 'utf8',
  });
  if (r.status !== 0 || (r.stderr && r.stderr.trim())) {
    fail++;
    console.log(
      '  FAIL  ' +
        event +
        ' (child crash) exit=' +
        r.status +
        ' stderr=' +
        JSON.stringify((r.stderr || '').trim().slice(0, 200)),
    );
    // Return undefined so check/checkBoth can recognize the crash and skip
    // their own fail++ (otherwise a single crash would surface as 2 fails
    // and the second message would point at a fake logic bug).
    return undefined;
  }
  return readState(home);
}

/** Fire one hook event with an explicit session_id (used by the path-traversal
 *  + cross-session-GC tests where SID is not the right key). Mirrors fire()'s
 *  child-crash assertion. Returns the spawnSync result so callers can inspect
 *  exit status + stderr directly (the path-traversal + robustness tests assert
 *  silent exit(0) + no file written, NOT a status read). */
function fireRaw(home, payload) {
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }),
    encoding: 'utf8',
  });
  return r;
}

/** List the .json files currently in the STATE_DIR under `home`. Used by the
 *  GC + cross-session tests. */
function listStateFiles(home) {
  const dir = path.join(home, '.claude', 'cc-tab-status');
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

/** Write a status file directly to <home>/.claude/cc-tab-status/<sid>.json
 *  with a specific mtime — used by the GC tests to plant stale / fresh files
 *  and assert which survive a UserPromptSubmit fire. `mtimeMsAgo` is ms
 *  before Date.now(); 0 = now. */
function plantStatus(home, sid, obj, mtimeMsAgo) {
  const dir = path.join(home, '.claude', 'cc-tab-status');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, sid + '.json');
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2));
  if (mtimeMsAgo && mtimeMsAgo > 0) {
    const d = new Date(Date.now() - mtimeMsAgo);
    fs.utimesSync(fp, d, d);
  }
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
  // Skip if fire() already recorded a child crash (got === undefined) —
  // avoids double-counting the same crash as both 'child crash' and a
  // misleading 'expected done got null'.
  if (got === undefined) return false;
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
  if (got === undefined) return false;
  const gotState = got ? got.state : null;
  const gotActive = got ? got.activeSubagents : null;
  const ok = gotState === expectedState && gotActive === expectedActive;
  if (ok) {
    pass++;
    console.log('  PASS  ' + name + '   -> state=' + gotState + ' activeSubagents=' + gotActive);
  } else {
    fail++;
    console.log(
      '  FAIL  ' +
        name +
        '   expected state=' +
        expectedState +
        ' active=' +
        expectedActive +
        ' got state=' +
        gotState +
        ' active=' +
        gotActive,
    );
  }
  return ok;
}

// --- scenarios ------------------------------------------------------------

console.log('Phase-2 state machine integration tests');
console.log('(real hooks/cc-status.js, isolated HOME, method A counting + method B payload)\n');

// 1. Baseline: plain turn, no subagent -> done.
check('1. UserPromptSubmit -> Stop = done (no subagent)', runSeq(['UserPromptSubmit', 'Stop']), 'done');

// 2. (Semantics fix, bug e434c0a2): a counter bump with NO payload at Stop
//    no longer false-sticks at running. The drift-prone activeSubagents counter
//    is not consulted at Stop; only the payload is authoritative. The real
//    "workflow in flight -> running" guarantee is covered by the payload-driven
//    cases (7 and 10 below). Same sequence that used to assert 'running'.
check(
  '2. UserPromptSubmit -> SubagentStart -> Stop (no payload) = done',
  runSeq(['UserPromptSubmit', 'SubagentStart', 'Stop']),
  'done',
);

// 3. Subagent finishes before Stop -> done. (Exposes the SubagentStop null-return bug.)
check(
  '3. UserPromptSubmit -> SubagentStart -> SubagentStop -> Stop = done',
  runSeq(['UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop']),
  'done',
);

// 4. (Semantics fix): counter says "1 left" but Stop has no payload -> done.
//    Only an authoritative inflight payload keeps it running at Stop.
check(
  '4. 2xStart -> SubagentStop -> Stop (no payload) = done (counter ignored at Stop)',
  runSeq(['UserPromptSubmit', 'SubagentStart', 'SubagentStart', 'SubagentStop', 'Stop']),
  'done',
);

// 5. StopFailure always wins interrupted, even with a subagent in flight.
check(
  '5. SubagentStart -> StopFailure = interrupted (interrupt wins)',
  runSeq(['UserPromptSubmit', 'SubagentStart', { event: 'StopFailure', extra: { error: 'rate_limit' } }]),
  'interrupted',
);

// 6. SessionEnd removes the status file.
{
  const got = runSeq(['UserPromptSubmit', { event: 'SessionEnd' }]);
  const ok = got === null;
  if (ok) {
    pass++;
    console.log('  PASS  6. SessionEnd deletes status file   -> (no file)');
  } else {
    fail++;
    console.log('  FAIL  6. SessionEnd should delete file, got state=' + (got && got.state));
  }
}

// 7. Method B (authoritative): Stop with non-empty background_tasks -> running,
//    even though the activeSubagents counter was never incremented. Proves the
//    primary (B) path is independent of the (A) counter.
check(
  '7. Stop w/ background_tasks=[workflow] = running (method B, no counter)',
  runSeq(['UserPromptSubmit', { event: 'Stop', extra: { background_tasks: [{ id: 'w1', type: 'workflow' }] } }]),
  'running',
);

// 8. Method B authoritative correction on SubagentStop: a workflow still in
//    flight keeps running; the counter is also corrected to the payload value.
{
  const got = runSeq([
    'UserPromptSubmit',
    'SubagentStart', // counter=1
    {
      event: 'SubagentStop',
      extra: {
        background_tasks: [
          { id: 'w1', type: 'workflow' },
          { id: 's1', type: 'subagent' },
        ],
      },
    },
  ]);
  // SubagentStop sees inflight=2 -> next=2>0 -> writes running, activeSubagents=2
  check('8. SubagentStop w/ background_tasks=2 = running (B corrects A)', got, 'running');
}

// --- regression cases (bug e434c0a2: Stop w/o background_tasks payload) ---

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
  0,
);

// 10. Stop with inflight=2 (authoritative payload) -> running, counter=2.
checkBoth(
  '10. Stop w/ background_tasks=[a,b] = running, counter=2',
  runSeq([{ event: 'Stop', extra: { background_tasks: [{ id: 'a' }, { id: 'b' }] } }]),
  'running',
  2,
);

// 11. Stop with inflight=0 (explicit empty payload array) -> done, counter=0.
checkBoth(
  '11. Stop w/ background_tasks=[] = done, counter=0',
  runSeq([{ event: 'Stop', extra: { background_tasks: [] } }]),
  'done',
  0,
);

// 12. [REGRESSION] UserPromptSubmit with no payload resets a drifted counter to
//     0, so drift cannot cross into the new turn.
checkBoth(
  '12. [REGRESSION] SubagentStart -> UserPromptSubmit (no payload) = running, counter=0',
  runSeq(['SubagentStart', 'UserPromptSubmit']),
  'running',
  0,
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
  0,
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
  const ok = final && final.state === 'done' && final.since === sinceAfterStop && final.activeSubagents === 0;
  if (ok) {
    pass++;
    console.log('  PASS  14. [REGRESSION] SubagentStop after Stop preserves done + since + counter=0');
  } else {
    fail++;
    console.log(
      '  FAIL  14. expected done+preserved since(' +
        sinceAfterStop +
        ')+0,' +
        ' got state=' +
        (final && final.state) +
        ' since=' +
        (final && final.since) +
        ' active=' +
        (final && final.activeSubagents),
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
        ' got state=' +
        (final && final.state) +
        ' error=' +
        (final && JSON.stringify(final.error)),
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
        (final && final.state) +
        ' pending=' +
        (final && final.pending),
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
  const ok =
    final &&
    final.state === 'running' &&
    final.since === sinceBefore && // PRESERVED, not refreshed
    final.pending === true;
  if (ok) {
    pass++;
    console.log('  PASS  17. Notification preserves state=running + since, sets pending=true');
  } else {
    fail++;
    console.log(
      '  FAIL  17. expected running+preserved since(' +
        sinceBefore +
        ')+pending=true,' +
        ' got state=' +
        (final && final.state) +
        ' since=' +
        (final && final.since) +
        ' pending=' +
        (final && final.pending),
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
  const ok = final && final.state === 'interrupted' && final.pending === true;
  if (ok) {
    pass++;
    console.log('  PASS  18. Notification on interrupted preserves state, sets pending=true');
  } else {
    fail++;
    console.log(
      '  FAIL  18. expected interrupted+pending=true, got state=' +
        (final && final.state) +
        ' pending=' +
        (final && final.pending),
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
        (final && final.state) +
        ' pending=' +
        (final && final.pending),
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
        (final && final.state) +
        ' pending=' +
        (final && final.pending),
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
        (final && final.state) +
        ' pending=' +
        (final && final.pending),
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
        (final && final.state) +
        ' pending=' +
        (final && final.pending),
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
        (final && final.state) +
        ' pending=' +
        (final && final.pending),
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
        (final && final.state) +
        ' pending=' +
        (final && final.pending),
    );
  }
}

// --- summary --------------------------------------------------------------

// R3 e2e-review high-priority coverage gap: the writer has three "defensive
// code" surfaces with ZERO behavioral coverage as of round-2 — (a) the bounded
// GC at cc-status.js's UserPromptSubmit path (deletes files older than 24h
// except interrupted-preservation), (b) the session_id path-traversal guard
// (rejects /, \, '.', '..'), and (c) the "NEVER block or break CC" robustness
// contract (empty stdin, invalid JSON, missing session_id, non-string
// session_id → silent exit(0) with no stderr). All three were asserted only
// in comments. This section pins them as executable invariants so future
// drift is caught. Plus the medium-severity StopFailure error-coercion tests
// (the `typeof payload.error === "string" && payload.error` branch was only
// ever exercised with the happy-path 'rate_limit' string).

// --- §A. "NEVER break CC" robustness: empty/bad stdin → silent exit(0) ----
//
// The most load-bearing behavioral contract: a hook that throws or writes to
// stderr corrupts the user's real CC sessions. Each input below must produce
// exit 0, empty stderr, and no file written under temp HOME.
{
  const cases = [
    { name: 'empty stdin', input: '' },
    { name: 'whitespace-only stdin', input: '   \n  ' },
    { name: 'invalid JSON (open brace)', input: '{not json' },
    { name: 'invalid JSON (truncated)', input: '{"hook_event_name":"Stop","session' },
    { name: 'JSON but no session_id', input: '{"hook_event_name":"Stop"}' },
    { name: 'JSON but no hook_event_name', input: '{"session_id":"' + SID + '"}' },
    { name: 'session_id is null', input: '{"session_id":null,"hook_event_name":"Stop"}' },
    { name: 'session_id is a number', input: '{"session_id":12345,"hook_event_name":"Stop"}' },
    { name: 'session_id is an object', input: '{"session_id":{"x":1},"hook_event_name":"Stop"}' },
  ];
  for (const c of cases) {
    const home = newTempHome();
    const r = fireRaw(home, c.input);
    const okExit = r.status === 0;
    const okStderr = !(r.stderr && r.stderr.trim());
    const okNoFile = listStateFiles(home).length === 0;
    const ok = okExit && okStderr && okNoFile;
    if (ok) {
      pass++;
      console.log('  PASS  §A ' + c.name + ' → exit 0, no stderr, no file');
    } else {
      fail++;
      console.log(
        '  FAIL  §A ' +
          c.name +
          ' → exit=' +
          r.status +
          ' stderr=' +
          JSON.stringify((r.stderr || '').trim().slice(0, 100)) +
          ' files=' +
          JSON.stringify(listStateFiles(home)),
      );
    }
  }
}

// --- §B. Path-traversal / session_id validation guard --------------------
//
// session_id values that could escape STATE_DIR via path.join (CC never sends
// these, but a hook is a passive receiver of arbitrary stdin). Each must
// produce exit 0, empty stderr, and no file written ANYWHERE under temp HOME
// (the test verifies by listing the whole temp tree, not just STATE_DIR — a
// '../../../tmp/escape.json' would land outside STATE_DIR but still under our
// temp HOME if the guard regressed).
function listAllJsonUnder(home) {
  const out = [];
  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.json')) out.push(path.relative(home, full));
    }
  }
  walk(home);
  return out.sort();
}
{
  const malicious = [
    '../escape',
    '../../etc/foo',
    'a/b',
    'a\\b', // Windows separator
    '.',
    '..',
    '.../foo',
    '', // arch-r2 medium fix: empty string must be rejected (else path.join
    //   produces STATE_DIR/.json — a hidden file at the dir root).
  ];
  for (const sid of malicious) {
    const home = newTempHome();
    const r = fireRaw(home, { hook_event_name: 'Stop', session_id: sid });
    const files = listAllJsonUnder(home);
    const ok = r.status === 0 && !(r.stderr && r.stderr.trim()) && files.length === 0;
    if (ok) {
      pass++;
      console.log('  PASS  §B session_id=' + JSON.stringify(sid) + ' → no file written');
    } else {
      fail++;
      console.log(
        '  FAIL  §B session_id=' + JSON.stringify(sid) + ' exit=' + r.status + ' files=' + JSON.stringify(files),
      );
    }
  }
}

// --- §C. Bounded GC (UserPromptSubmit prune of files > 24h) --------------
//
// R3 e2e-review high-priority gap: the GC at UserPromptSubmit unlinks stale
// files but had ZERO test coverage. Plant files at varied mtimes + states,
// fire UserPromptSubmit for a fresh session, and assert exactly which files
// survived. Locks the §7.5 interrupted-preservation contract + the skip-
// current rule + the cross-session prune.
{
  const H24 = 24 * 60 * 60 * 1000;
  const HR = 60 * 60 * 1000;
  const MIN = 60 * 1000;
  const home = newTempHome();
  // 1: fresh running (5min ago) — KEEP
  plantStatus(home, 'gc-fresh-running', { state: 'running', since: Date.now() - 5 * MIN }, 5 * MIN);
  // 2: old done (25h ago) — PRUNE (no diagnostic value, reader already decayed)
  plantStatus(home, 'gc-old-done', { state: 'done', since: Date.now() - 25 * HR }, 25 * HR);
  // 3: old interrupted (25h ago) — KEEP (§7.5 diagnostic-preservation contract)
  plantStatus(
    home,
    'gc-old-interrupted',
    { state: 'interrupted', since: Date.now() - 25 * HR, error: 'rate_limit' },
    25 * HR,
  );
  // 4: old running (25h ago) — PRUNE (crashed session, no diagnostic value)
  plantStatus(home, 'gc-old-running', { state: 'running', since: Date.now() - 25 * HR }, 25 * HR);
  // 5: old idle-by-default (no state field, 25h ago) — PRUNE (corrupt, no value)
  plantStatus(home, 'gc-old-nostate', { foo: 'bar' }, 25 * HR);
  // 6: just-under-24h interrupted — KEEP (still within retention)
  plantStatus(home, 'gc-near-24h-int', { state: 'interrupted', since: Date.now() - 23 * HR }, 23 * HR);

  // Fire UserPromptSubmit for a NEW session (different sid) — exercises the
  // cross-session prune + skip-current rule (the new session's file must be
  // written, not pruned, even though its mtime is fresh).
  const newSid = 'gc-new-session';
  const r = fireRaw(home, { hook_event_name: 'UserPromptSubmit', session_id: newSid, prompt: 'hi' });
  const survivors = listStateFiles(home);

  // Assert exit + the new session's file was written (skip-current rule).
  checkBoth(
    '§C.1 UserPromptSubmit writes the new session (skip-current rule)',
    JSON.parse(fs.readFileSync(path.join(home, '.claude', 'cc-tab-status', newSid + '.json'), 'utf8')),
    'running',
    0,
  );

  function survived(sid) {
    return survivors.includes(sid + '.json');
  }
  // Expected survivors: fresh-running (1), old-interrupted (3, §7.5), near-24h-int (6), new-session.
  function checkSurvival(name, sid, expected) {
    const actual = survived(sid);
    if (actual === expected) {
      pass++;
      console.log('  PASS  ' + name);
    } else {
      fail++;
      console.log(
        '  FAIL  ' + name + ' expected ' + (expected ? 'KEEP' : 'PRUNE') + ', got ' + (actual ? 'KEEP' : 'PRUNE'),
      );
    }
  }
  checkSurvival('§C.2 fresh running (5min) KEPT', 'gc-fresh-running', true);
  checkSurvival('§C.3 old done (25h) PRUNED', 'gc-old-done', false);
  checkSurvival('§C.4 old interrupted (25h) KEPT (§7.5 diagnostic preservation)', 'gc-old-interrupted', true);
  checkSurvival('§C.5 old running (25h) PRUNED', 'gc-old-running', false);
  checkSurvival('§C.6 corrupt old no-state (25h) PRUNED', 'gc-old-nostate', false);
  checkSurvival('§C.7 near-24h interrupted (23h) KEPT', 'gc-near-24h-int', true);
  checkSurvival('§C.8 new session file written (skip-current)', newSid, true);

  // Confirm exit 0 + no stderr on the GC run itself.
  if (r.status === 0 && !(r.stderr && r.stderr.trim())) {
    pass++;
    console.log('  PASS  §C.9 UserPromptSubmit GC run exit=0, no stderr');
  } else {
    fail++;
    console.log('  FAIL  §C.9 exit=' + r.status + ' stderr=' + JSON.stringify((r.stderr || '').trim()));
  }
}

// --- §C.2: GC does NOT fire on non-UserPromptSubmit events ---------------
//
// Pins that the GC is gated on event==='UserPromptSubmit' specifically — a
// regression that fired the GC on PreToolUse / Stop / etc would prune files
// at the wrong cadence (Stop fires multiple times per turn during subagent
// workflows).
{
  const H24 = 24 * 60 * 1000;
  const home = newTempHome();
  plantStatus(home, 'no-gc-old', { state: 'done', since: 0 }, 25 * H24); // 25 days old
  // Fire Stop — old file MUST survive (GC does not run on Stop).
  fire(home, 'Stop', {});
  const survivors = listStateFiles(home);
  if (survivors.includes('no-gc-old.json') && survivors.includes(SID + '.json')) {
    pass++;
    console.log('  PASS  §C.10 Stop does NOT trigger GC (only UserPromptSubmit does)');
  } else {
    fail++;
    console.log('  FAIL  §C.10 expected [no-gc-old, ' + SID + '], got ' + JSON.stringify(survivors));
  }
}

// --- §D. StopFailure error-coercion (typeof string + truthy) ------------
//
// R3 e2e-review medium gap: StopFailure's `typeof payload.error === "string"
// && payload.error ? payload.error : "interrupted"` branch (the defense
// against non-string truthy payloads like 42 / [1,2] / {x:1} that would
// JSON.stringify to "[object Object]" or similar) was only ever exercised
// with the happy-path 'rate_limit' string. Pin the coercion for omitted,
// empty string, number, array, object — each must persist error='interrupted'.
{
  const badErrs = [
    { label: 'omitted', val: undefined },
    { label: 'empty string', val: '' },
    { label: 'number 42', val: 42 },
    { label: 'array [1,2]', val: [1, 2] },
    { label: 'object {x:1}', val: { x: 1 } },
    { label: 'null', val: null },
    { label: 'boolean true', val: true },
    { label: 'boolean false', val: false },
  ];
  for (const e of badErrs) {
    const home = newTempHome();
    const extra = e.val === undefined ? {} : { error: e.val };
    const got = fire(home, 'StopFailure', extra);
    const okErr = got && got.error === 'interrupted';
    const okState = got && got.state === 'interrupted';
    if (okErr && okState) {
      pass++;
      console.log('  PASS  §D StopFailure error=' + e.label + ' → coerced to "interrupted"');
    } else {
      fail++;
      console.log(
        '  FAIL  §D StopFailure error=' +
          e.label +
          ' expected state=interrupted error=interrupted, got state=' +
          (got && got.state) +
          ' error=' +
          JSON.stringify(got && got.error),
      );
    }
  }
}

// --- §E. cur.since=0 corrupt-file guards (preserveSince + Notification) ----
//
// Round-2 code-style review gap: the strict `> 0` guards in deriveStatus —
// preserveSince (SubagentStop line ~240) and curSince (Notification line ~273)
// — were added specifically so a corrupt/hand-edited file with cur.since=0
// does NOT permanently stick the session in a terminal state (the reader's
// `since && now-since>DONE_TO_IDLE_MS` tick is falsy for 0, so the file would
// never decay to idle). Until now these guards had ZERO direct coverage —
// every other test enters via UserPromptSubmit/Stop which writes since=now(>0),
// so the `> 0` branch was never exercised. These two tests plant cur.since=0
// directly and assert the writer refreshes since=now on the next event.
{
  // §E.1 SubagentStop on a corrupt {state:'done', since:0} file must
  //      REFRESH since=now (the > 0 guard rejects the corrupt since=0 and
  //      falls through to the since=now branch). Regression: flipping `> 0`
  //      back to `>= 0` would preserve the corrupt 0 and the session would
  //      permanently read done.
  const home = newTempHome();
  plantStatus(home, SID, { state: 'done', since: 0, activeSubagents: 0 });
  const before = readState(home);
  const got = fire(home, 'SubagentStop');
  const okRefreshed = got && typeof got.since === 'number' && got.since > 0 && got.since !== before.since;
  if (okRefreshed) {
    pass++;
    console.log('  PASS  §E.1 SubagentStop on corrupt since=0 → since refreshed to now (>0 guard)');
  } else {
    fail++;
    console.log(
      '  FAIL  §E.1 SubagentStop on corrupt since=0 expected since refreshed to >0,' +
        ' got since=' +
        (got && got.since) +
        ' (before=' +
        before.since +
        ')',
    );
  }
}
{
  // §E.2 Notification on a corrupt {state:'running', since:0} file must
  //      ALSO refresh since=now (same > 0 guard in the Notification case).
  const home = newTempHome();
  plantStatus(home, SID, { state: 'running', since: 0, activeSubagents: 0 });
  const before = readState(home);
  const got = fire(home, 'Notification');
  const okRefreshed = got && typeof got.since === 'number' && got.since > 0 && got.since !== before.since;
  const okPending = got && got.pending === true;
  if (okRefreshed && okPending) {
    pass++;
    console.log('  PASS  §E.2 Notification on corrupt since=0 → since refreshed to now + pending=true');
  } else {
    fail++;
    console.log(
      '  FAIL  §E.2 Notification on corrupt since=0 expected since>0 + pending=true,' +
        ' got since=' +
        (got && got.since) +
        ' pending=' +
        (got && got.pending),
    );
  }
}

// --- §F. SubagentStop preserves error on already-interrupted sessions ------
//
// Round-3 business-logic fix: an orphan SubagentStop arriving AFTER StopFailure
// already wrote {state:'interrupted', error:'tool_blocked'} would rewrite the
// file as {state:'interrupted'} (no error) — silently dropping the error enum
// that the reader surfaces in the user-visible notification (STATES.md §4b).
// Pin the fix: when SubagentStop preserves an interrupted state (preserveSince
// path), it must ALSO propagate cur.error.
{
  const home = newTempHome();
  fire(home, 'UserPromptSubmit');
  fire(home, 'StopFailure', { error: 'rate_limit' });
  // File now: {state:'interrupted', error:'rate_limit', since:now, ...}
  const afterFail = readState(home);
  const okSetup = afterFail && afterFail.state === 'interrupted' && afterFail.error === 'rate_limit';
  // Orphan SubagentStop arrives — should preserve interrupted + since + error.
  const got = fire(home, 'SubagentStop');
  const okState = got && got.state === 'interrupted';
  const okError = got && got.error === 'rate_limit';
  const okSince = got && got.since === afterFail.since;
  if (okSetup && okState && okError && okSince) {
    pass++;
    console.log('  PASS  §F SubagentStop after StopFailure preserves interrupted + error enum + since');
  } else {
    fail++;
    console.log(
      '  FAIL  §F expected interrupted+error=rate_limit+preserved since(' +
        (afterFail && afterFail.since) +
        '),' +
        ' got state=' +
        (got && got.state) +
        ' error=' +
        JSON.stringify(got && got.error) +
        ' since=' +
        (got && got.since) +
        (okSetup ? '' : ' [setup failed]'),
    );
  }
}

// --- §G. GC also reaps orphan .tmp files -----------------------------------
//
// Round-3 architecture fix: writeJsonAtomic uses `<sid>.<pid>.<ts>.tmp` +
// renameSync; a SIGKILL/EPERM between writeFileSync and renameSync leaves an
// orphan .tmp that the `.endsWith('.json')` filter would skip forever. The
// GC now also reaps .tmp files older than GC_TMP_AGE_MS (5 min). Plant a
// stale .tmp + a fresh .tmp, fire UserPromptSubmit (with CC_STATUS_GC_INTERVAL_MS=0
// to force the sweep), and assert exactly which survived.
{
  const home = newTempHome();
  fs.mkdirSync(path.join(home, '.claude', 'cc-tab-status'), { recursive: true });
  const dir = path.join(home, '.claude', 'cc-tab-status');
  const MIN = 60 * 1000;
  // Stale .tmp (10 min ago) — should be REAPED.
  const staleTmp = path.join(dir, 'stale.123.999.tmp');
  fs.writeFileSync(staleTmp, 'orphan');
  const dOld = new Date(Date.now() - 10 * MIN);
  fs.utimesSync(staleTmp, dOld, dOld);
  // Fresh .tmp (10s ago) — should SURVIVE (could be a legitimate renameSync in flight).
  const freshTmp = path.join(dir, 'fresh.456.888.tmp');
  fs.writeFileSync(freshTmp, 'in-flight');
  const dNew = new Date(Date.now() - 10 * 1000);
  fs.utimesSync(freshTmp, dNew, dNew);
  // Force GC on this UserPromptSubmit (sweep throttle off).
  const env = Object.assign({}, process.env, {
    HOME: home,
    USERPROFILE: home,
    CC_STATUS_GC_INTERVAL_MS: '0',
  });
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'gc-tmp-test', prompt: 'x' }),
    env,
    encoding: 'utf8',
  });
  const okExit = r.status === 0 && !(r.stderr && r.stderr.trim());
  const staleGone = !fs.existsSync(staleTmp);
  const freshKept = fs.existsSync(freshTmp);
  if (okExit && staleGone && freshKept) {
    pass++;
    console.log('  PASS  §G GC reaps stale .tmp (>5min) and keeps fresh .tmp (<5min)');
  } else {
    fail++;
    console.log(
      '  FAIL  §G exit=' +
        r.status +
        ' staleGone=' +
        staleGone +
        ' freshKept=' +
        freshKept +
        ' stderr=' +
        JSON.stringify((r.stderr || '').trim().slice(0, 100)),
    );
  }
}

// --- summary --------------------------------------------------------------

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
