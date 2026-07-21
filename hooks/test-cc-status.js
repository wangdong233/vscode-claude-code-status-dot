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
import { spawnSync, spawn } from 'child_process';
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
//     v0.1.20 contract fix (data-logic round-2 review): Notification now
//     ALSO preserves cur.error, mirroring SubagentStop's preserveError
//     guard. The pre-fix Notification branch returned {state, since,
//     pending:true} with NO error field, so a StopFailure→Notification
//     sequence on the same session silently dropped the error enum from
//     disk (writeJsonAtomic overwrote the file). The reader's notify()
//     would then surface generic "interrupted" wording instead of the
//     specific failure reason (e.g. "tool_blocked"). This test locks the
//     symmetric contract: any path that preserves cur.state on an
//     interrupted session MUST also preserve cur.error.
{
  const home = newTempHome();
  fire(home, 'UserPromptSubmit');
  fire(home, 'StopFailure', { error: 'rate_limit' });
  const final = fire(home, 'Notification');
  const ok = final && final.state === 'interrupted' && final.pending === true && final.error === 'rate_limit';
  if (ok) {
    pass++;
    console.log('  PASS  18. Notification on interrupted preserves state + error, sets pending=true');
  } else {
    fail++;
    console.log(
      '  FAIL  18. expected interrupted+pending=true+error=rate_limit, got state=' +
        (final && final.state) +
        ' pending=' +
        (final && final.pending) +
        ' error=' +
        (final && final.error),
    );
  }
}

// 18b. Notification on an interrupted session does NOT invent an error when
//      cur.error is absent (a hand-edited or pre-v0.1.20 file may have
//      {state:'interrupted'} with no error field). Locks the guard's strict
//      type check — only a string error from cur is preserved (no
//      defaulting to 'interrupted' or any other enum).
{
  const home = newTempHome();
  // Plant an interrupted file with NO error field (mimics a hand-edited
  // / pre-v0.1.20 disk state).
  plantStatus(home, SID, { state: 'interrupted', since: Date.now(), activeSubagents: 0 });
  const final = fire(home, 'Notification');
  const ok = final && final.state === 'interrupted' && final.pending === true && final.error === undefined;
  if (ok) {
    pass++;
    console.log('  PASS  18b. Notification on interrupted (no cur.error) does NOT invent error');
  } else {
    fail++;
    console.log(
      '  FAIL  18b. expected interrupted+pending=true+error=undefined, got state=' +
        (final && final.state) +
        ' pending=' +
        (final && final.pending) +
        ' error=' +
        (final && final.error),
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

// --- §C. Bounded GC (UserPromptSubmit prune of files > 7d) --------------
//
// R3 e2e-review high-priority gap: the GC at UserPromptSubmit unlinks stale
// files but had ZERO test coverage. Plant files at varied mtimes + states,
// fire UserPromptSubmit for a fresh session, and assert exactly which files
// survived. Locks the §7.5 interrupted-preservation contract + the skip-
// current rule + the cross-session prune.
// v0.2.7 (Q2 interrupted sticky): INTERRUPTED_RETENTION_MS bumped 24h → 7d
// to keep the 🔴 sticky across cross-day workflows. The "old" plants now use
// 8d (just past the new 7d cutoff) instead of 25h; the "near" plant uses 6d.
{
  const H24 = 24 * 60 * 60 * 1000;
  const HR = 60 * 60 * 1000;
  const MIN = 60 * 1000;
  const home = newTempHome();
  // 1: fresh running (5min ago) — KEEP
  plantStatus(home, 'gc-fresh-running', { state: 'running', since: Date.now() - 5 * MIN }, 5 * MIN);
  // 2: old done (8d ago) — PRUNE (no diagnostic value, reader already decayed)
  plantStatus(home, 'gc-old-done', { state: 'done', since: Date.now() - 8 * 24 * HR }, 8 * 24 * HR);
  // 3: old interrupted (8d ago) — KEEP (§7.5 diagnostic-preservation contract)
  plantStatus(
    home,
    'gc-old-interrupted',
    { state: 'interrupted', since: Date.now() - 8 * 24 * HR, error: 'rate_limit' },
    8 * 24 * HR,
  );
  // 4: old running (8d ago) — PRUNE (crashed session, no diagnostic value)
  plantStatus(home, 'gc-old-running', { state: 'running', since: Date.now() - 8 * 24 * HR }, 8 * 24 * HR);
  // 5: old idle-by-default (no state field, 8d ago) — PRUNE (corrupt, no value)
  plantStatus(home, 'gc-old-nostate', { foo: 'bar' }, 8 * 24 * HR);
  // 6: just-under-7d interrupted — KEEP (still within retention)
  plantStatus(home, 'gc-near-24h-int', { state: 'interrupted', since: Date.now() - 6 * 24 * HR }, 6 * 24 * HR);

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
  // Expected survivors: fresh-running (1), old-interrupted (3, §7.5), near-7d-int (6), new-session.
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
  checkSurvival('§C.3 old done (8d) PRUNED', 'gc-old-done', false);
  checkSurvival('§C.4 old interrupted (8d) KEPT (§7.5 diagnostic preservation)', 'gc-old-interrupted', true);
  checkSurvival('§C.5 old running (8d) PRUNED', 'gc-old-running', false);
  checkSurvival('§C.6 corrupt old no-state (8d) PRUNED', 'gc-old-nostate', false);
  checkSurvival('§C.7 near-7d interrupted (6d) KEPT', 'gc-near-24h-int', true);
  checkSurvival('§C.8 new session file written (skip-current)', newSid, true);

  // v0.2.6 round-3 regression-pin (regression §7.5 contract): GC_DRIFT_SINCE_MS
  // (7d) is defined to prune drifted Stop-payload .json files that preserveSince
  // (cc-status.js:390-401) keeps cur.since OLD on while writeJsonAtomic refreshes
  // mtime FRESH on every Stop heartbeat. The prior structure's
  // `if (st.mtimeMs >= cutoff) continue;` skipped fresh-mtime files before
  // parsing, so drifted files were never pruned. Without these plants CI was
  // green despite the constant being a phantom. We now plant the exact
  // fresh-mtime + old-since shape the doc comment promises and assert PRUNED.
  // Also pin the symmetric KEEP cases: 6d-old since (just under 7d) + fresh
  // mtime is KEPT (the 7d bound is intentionally longer than 24h so a
  // legitimately-running long session is not pruned by this path); and a
  // drifted-but-interrupted file is KEPT (interrupted-preservation dominates
  // drift per the new branch order). Uses spawnSync directly with
  // CC_STATUS_GC_INTERVAL_MS=0 (the §C.1 fire above already touched the .gc
  // sidecar, which would otherwise suppress this sweep for GC_INTERVAL_MS).
  {
    const driftHome = newTempHome();
    fs.mkdirSync(path.join(driftHome, '.claude', 'cc-tab-status'), { recursive: true });
    const ddir = path.join(driftHome, '.claude', 'cc-tab-status');
    const HR2 = 60 * 60 * 1000;
    const freshMtime = new Date(Date.now());
    // fresh mtime (now) + since 8d ago + state running → drifted → PRUNE
    {
      const fp = path.join(ddir, 'gc-drifted-running.json');
      fs.writeFileSync(fp, JSON.stringify({ state: 'running', since: Date.now() - 8 * 24 * HR2 }, null, 2));
      fs.utimesSync(fp, freshMtime, freshMtime);
    }
    // fresh mtime + since 6d ago + state running → just under 7d → KEEP
    {
      const fp = path.join(ddir, 'gc-near-drift-running.json');
      fs.writeFileSync(fp, JSON.stringify({ state: 'running', since: Date.now() - 6 * 24 * HR2 }, null, 2));
      fs.utimesSync(fp, freshMtime, freshMtime);
    }
    // fresh mtime + since 8d ago + state interrupted → KEEP (interrupted dominates)
    {
      const fp = path.join(ddir, 'gc-drifted-interrupted.json');
      fs.writeFileSync(
        fp,
        JSON.stringify({ state: 'interrupted', since: Date.now() - 8 * 24 * HR2, error: 'rate_limit' }, null, 2),
      );
      fs.utimesSync(fp, freshMtime, freshMtime);
    }
    // Force GC on this UserPromptSubmit (sweep throttle off).
    const driftEnv = Object.assign({}, process.env, {
      HOME: driftHome,
      USERPROFILE: driftHome,
      CC_STATUS_GC_INTERVAL_MS: '0',
    });
    const driftR = spawnSync(process.execPath, [SCRIPT], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'gc-drift-trigger', prompt: 'hi' }),
      env: driftEnv,
      encoding: 'utf8',
    });
    const driftSurvivors = fs.existsSync(ddir)
      ? fs
          .readdirSync(ddir)
          .filter((n) => n.endsWith('.json'))
          .sort()
      : [];
    function driftKept(sid) {
      return driftSurvivors.includes(sid + '.json');
    }
    function checkDrift(name, sid, expected) {
      const actual = driftKept(sid);
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
    checkDrift('§C.11 drifted running (8d since, fresh mtime) PRUNED', 'gc-drifted-running', false);
    checkDrift('§C.12 near-drift running (6d since, fresh mtime) KEPT', 'gc-near-drift-running', true);
    checkDrift(
      '§C.13 drifted interrupted (8d since, fresh mtime) KEPT (interrupted dominates drift)',
      'gc-drifted-interrupted',
      true,
    );
    // Confirm exit 0 + no stderr on the drift-GC run itself.
    if (driftR.status === 0 && !(driftR.stderr && driftR.stderr.trim())) {
      pass++;
      console.log('  PASS  §C.14 drift-GC run exit=0, no stderr');
    } else {
      fail++;
      console.log('  FAIL  §C.14 exit=' + driftR.status + ' stderr=' + JSON.stringify((driftR.stderr || '').trim()));
    }
  }

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

// --- §G2. CC_STATUS_GC_INTERVAL_MS=0 overrides a freshly-touched .gc sidecar
//
// v0.2.4 follow-up (round-2 e2e fix): the §G test above passes for the wrong
// reason — newTempHome() builds a fresh HOME with no .gc sidecar, so lastGc=0
// and `now - 0 >= DEFAULT_INTERVAL` is true regardless of the env value. The
// real test of the override is: plant a freshly-touched .gc sidecar (mtime=now,
// which would normally suppress the sweep for 10 min), set CC_STATUS_GC_INTERVAL_MS=0,
// and verify the sweep STILL fires. The prior `Number(env) || DEFAULT` form
// treated 0 as falsy and silently used the default — so env=0 would NOT force
// the sweep here, the stale .tmp would survive, and the assertion failed.
// With the fixed `Number(env ?? DEFAULT)` form, env=0 is honored and the sweep
// fires, reaping the stale .tmp.
{
  const home = newTempHome();
  fs.mkdirSync(path.join(home, '.claude', 'cc-tab-status'), { recursive: true });
  const dir = path.join(home, '.claude', 'cc-tab-status');
  const MIN = 60 * 1000;
  // Plant a FRESH .gc sidecar — sweep would normally be skipped for 10 min.
  const gcSidecar = path.join(dir, '.gc');
  fs.writeFileSync(gcSidecar, String(Date.now()));
  // Stale .tmp (10 min ago) — should be REAPED only if the sweep actually fires.
  const staleTmp = path.join(dir, 'stale.123.999.tmp');
  fs.writeFileSync(staleTmp, 'orphan');
  const dOld = new Date(Date.now() - 10 * MIN);
  fs.utimesSync(staleTmp, dOld, dOld);
  // env=0 — force the sweep past the fresh sidecar.
  const env = Object.assign({}, process.env, {
    HOME: home,
    USERPROFILE: home,
    CC_STATUS_GC_INTERVAL_MS: '0',
  });
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'gc-interval-override-test',
      prompt: 'x',
    }),
    env,
    encoding: 'utf8',
  });
  const okExit = r.status === 0 && !(r.stderr && r.stderr.trim());
  const staleGone = !fs.existsSync(staleTmp);
  if (okExit && staleGone) {
    pass++;
    console.log('  PASS  §G2 CC_STATUS_GC_INTERVAL_MS=0 overrides fresh .gc sidecar (sweep fires)');
  } else {
    fail++;
    console.log(
      '  FAIL  §G2 exit=' +
        r.status +
        ' staleGone=' +
        staleGone +
        ' stderr=' +
        JSON.stringify((r.stderr || '').trim().slice(0, 100)),
    );
  }
}

// --- §G3. Without the env override, a fresh .gc sidecar SUPPRESSES the sweep
//
// Companion to §G2: with the same fresh .gc sidecar but NO env override, the
// sweep must NOT fire (10 min throttle). Verifies the throttle still works
// after the override path was tightened. The stale .tmp must SURVIVE here.
{
  const home = newTempHome();
  fs.mkdirSync(path.join(home, '.claude', 'cc-tab-status'), { recursive: true });
  const dir = path.join(home, '.claude', 'cc-tab-status');
  const MIN = 60 * 1000;
  const gcSidecar = path.join(dir, '.gc');
  fs.writeFileSync(gcSidecar, String(Date.now()));
  const staleTmp = path.join(dir, 'stale.123.999.tmp');
  fs.writeFileSync(staleTmp, 'orphan');
  const dOld = new Date(Date.now() - 10 * MIN);
  fs.utimesSync(staleTmp, dOld, dOld);
  // No env override — sweep must skip (fresh sidecar).
  const env = Object.assign({}, process.env, {
    HOME: home,
    USERPROFILE: home,
  });
  delete env.CC_STATUS_GC_INTERVAL_MS;
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'gc-throttle-test', prompt: 'x' }),
    env,
    encoding: 'utf8',
  });
  const okExit = r.status === 0 && !(r.stderr && r.stderr.trim());
  const staleKept = fs.existsSync(staleTmp);
  if (okExit && staleKept) {
    pass++;
    console.log('  PASS  §G3 fresh .gc sidecar suppresses sweep when env override absent (10min throttle holds)');
  } else {
    fail++;
    console.log(
      '  FAIL  §G3 exit=' +
        r.status +
        ' staleKept=' +
        staleKept +
        ' stderr=' +
        JSON.stringify((r.stderr || '').trim().slice(0, 100)),
    );
  }
}

// --- §H. v0.2.4 token stats: transcript_path incremental read ----------------
//
// Plant a fake CC jsonl transcript at a known path, fire PostToolUse with
// transcript_path pointing at it, and verify <sid>.json grows a `tokens`
// field with the expected cumulative totals + windows. Then fire a second
// event with new bytes appended and verify the offset sidecar advances
// (incremental, not full re-read). Finally fire a SessionEnd and verify both
// <sid>.json and <sid>.offset are unlinked.
{
  const home = newTempHome();
  const tsDir = path.join(home, '.claude', 'projects', 'test-proj');
  fs.mkdirSync(tsDir, { recursive: true });
  const tsPath = path.join(tsDir, SID + '.jsonl');
  // Two assistant rows: glm-5.2 (scalar cache_creation_input_tokens=0).
  const now = Date.now();
  const row1 = {
    type: 'assistant',
    isSidechain: false,
    sessionId: SID,
    timestamp: new Date(now - 60000).toISOString(),
    message: {
      role: 'assistant',
      model: 'glm-5.2',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 0,
      },
    },
  };
  const row2 = {
    type: 'assistant',
    isSidechain: false,
    sessionId: SID,
    timestamp: new Date(now - 30000).toISOString(),
    message: {
      role: 'assistant',
      model: 'glm-5.2',
      usage: {
        input_tokens: 200,
        output_tokens: 100,
        cache_read_input_tokens: 10000,
        cache_creation_input_tokens: 0,
      },
    },
  };
  fs.writeFileSync(tsPath, JSON.stringify(row1) + '\n');

  // First fire: only row1 should be counted.
  let got = fire(home, 'PostToolUse', { transcript_path: tsPath });
  const okPresence = got && typeof got === 'object' && got.tokens && typeof got.tokens.total === 'object';
  if (okPresence) {
    pass++;
    console.log('  PASS  §H.1 PostToolUse writes tokens field after transcript read');
  } else {
    fail++;
    console.log('  FAIL  §H.1 expected tokens field, got ' + JSON.stringify(got && got.tokens));
  }
  const okTotal1 =
    got &&
    got.tokens &&
    got.tokens.total &&
    got.tokens.total.in === 100 &&
    got.tokens.total.out === 50 &&
    got.tokens.total.cr === 5000;
  if (okTotal1) {
    pass++;
    console.log('  PASS  §H.2 first-fire totals match row1 (100/50/5000)');
  } else {
    fail++;
    console.log('  FAIL  §H.2 expected 100/50/5000, got ' + JSON.stringify(got && got.tokens && got.tokens.total));
  }

  // offset sidecar should exist + match the transcript size.
  const offsetPath = path.join(home, '.claude', 'cc-tab-status', SID + '.offset');
  let offsetObj = null;
  try {
    offsetObj = JSON.parse(fs.readFileSync(offsetPath, 'utf8'));
  } catch {
    /* ignore */
  }
  const expectedOff = fs.statSync(tsPath).size;
  if (offsetObj && offsetObj.offset === expectedOff) {
    pass++;
    console.log('  PASS  §H.3 offset sidecar created at byte ' + expectedOff);
  } else {
    fail++;
    console.log('  FAIL  §H.3 expected offset=' + expectedOff + ', got ' + (offsetObj && offsetObj.offset));
  }

  // GLM-5.2 has no rate entry → cost should be null (SBI hides $).
  if (got && got.tokens && got.tokens.cost === null) {
    pass++;
    console.log('  PASS  §H.4 cost null for unknown model (GLM-5.2 hidden $)');
  } else {
    fail++;
    console.log('  FAIL  §H.4 expected cost=null, got ' + JSON.stringify(got && got.tokens && got.tokens.cost));
  }

  // Append row2 and re-fire. Incremental read should pick up only row2.
  fs.appendFileSync(tsPath, JSON.stringify(row2) + '\n');
  got = fire(home, 'PostToolUse', { transcript_path: tsPath });
  const okTotal2 =
    got &&
    got.tokens &&
    got.tokens.total &&
    got.tokens.total.in === 300 && // 100 + 200
    got.tokens.total.out === 150 && // 50 + 100
    got.tokens.total.cr === 15000; // 5000 + 10000
  if (okTotal2) {
    pass++;
    console.log('  PASS  §H.5 incremental read accumulates row2 (300/150/15000)');
  } else {
    fail++;
    console.log('  FAIL  §H.5 expected 300/150/15000, got ' + JSON.stringify(got && got.tokens && got.tokens.total));
  }

  // Windows: row1 is 60s ago, row2 is 30s ago. 5min window should contain both.
  if (got && got.tokens && got.tokens.windows && got.tokens.windows['5min'] && got.tokens.windows['5min'].in === 300) {
    pass++;
    console.log('  PASS  §H.6 5min window aggregates both rows');
  } else {
    fail++;
    console.log(
      '  FAIL  §H.6 expected 5min.in=300, got ' +
        JSON.stringify(got && got.tokens && got.tokens.windows && got.tokens.windows['5min']),
    );
  }

  // v0.2.7 (Q1 fix): SessionEnd now unlinks ONLY <sid>.json — the .offset
  // sidecar (cumulative read cursor) AND the new <sid>.tokens.json snapshot
  // MUST survive so the next resume picks up cumulative state + non-zero
  // display on the first tick. Pre-Q1 both were deleted here, zeroing the
  // cumulative state on every VSCode restart.
  fire(home, 'SessionEnd');
  const jsonGone = !fs.existsSync(stateFile(home));
  const offsetPathStill = path.join(home, '.claude', 'cc-tab-status', SID + '.offset');
  const tokensPath = path.join(home, '.claude', 'cc-tab-status', SID + '.tokens.json');
  const offKept = fs.existsSync(offsetPathStill);
  const tokensKept = fs.existsSync(tokensPath);
  if (jsonGone && offKept && tokensKept) {
    pass++;
    console.log('  PASS  §H.7 SessionEnd deletes <sid>.json but preserves .offset + .tokens.json (Q1)');
  } else {
    fail++;
    console.log('  FAIL  §H.7 jsonGone=' + jsonGone + ' offKept=' + offKept + ' tokensKept=' + tokensKept);
  }

  // v0.2.7 (Q1 fix): the preserved <sid>.tokens.json must carry the SAME
  // cumulative tokens the hook wrote to <sid>.json before SessionEnd. This is
  // the load-bearing assertion that the post-restart IIFE tick can render
  // non-zero token count BEFORE any TOK_EVENT fire.
  if (tokensKept) {
    let snap = null;
    try {
      snap = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
    } catch {
      /* corrupt — fall through */
    }
    const okSnap =
      snap &&
      snap.v === 1 &&
      snap.sid === SID &&
      typeof snap.written_at === 'number' &&
      snap.tokens &&
      snap.tokens.total &&
      snap.tokens.total.in === 300 && // matches §H.5 accumulated total
      snap.tokens.total.out === 150 &&
      snap.tokens.total.cr === 15000;
    if (okSnap) {
      pass++;
      console.log('  PASS  §H.8 <sid>.tokens.json carries cumulative tokens across SessionEnd (Q1 sticky)');
    } else {
      fail++;
      console.log(
        '  FAIL  §H.8 expected snap.v=1 sid=' +
          SID +
          ' tokens.total=300/150/15000, got ' +
          JSON.stringify(snap && snap.tokens && snap.tokens.total),
      );
    }
  }
}

// --- §I. v0.2.4 token stats: cache_creation object form (Anthropic) ---------
//
// Verify the dual-form cache_creation parser handles Anthropic's object shape
// { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } alongside the
// scalar form (cc5/cc1/cci).
{
  const home = newTempHome();
  const tsDir = path.join(home, '.claude', 'projects', 'anth-proj');
  fs.mkdirSync(tsDir, { recursive: true });
  const tsPath = path.join(tsDir, SID + '.jsonl');
  const now = Date.now();
  const row = {
    type: 'assistant',
    isSidechain: false,
    sessionId: SID,
    timestamp: new Date(now - 10000).toISOString(),
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 50000,
        cache_creation: {
          ephemeral_5m_input_tokens: 200,
          ephemeral_1h_input_tokens: 80,
        },
        cache_creation_input_tokens: 0,
      },
    },
  };
  fs.writeFileSync(tsPath, JSON.stringify(row) + '\n');

  // Plant a token-rates.json so cost can be computed.
  const installDir = path.join(home, '.claude', 'cc-status-dot');
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'token-rates.json'),
    JSON.stringify({
      _default: null,
      'claude-sonnet-*': { in: 3, out: 15, cacheRead: 0.3, cacheCreate5m: 3.75, cacheCreate1h: 6 },
    }),
  );

  const got = fire(home, 'PostToolUse', { transcript_path: tsPath });
  const t = got && got.tokens && got.tokens.total;
  const okDual = t && t.in === 1000 && t.out === 500 && t.cr === 50000 && t.cc5 === 200 && t.cc1 === 80 && t.cci === 0;
  if (okDual) {
    pass++;
    console.log('  PASS  §I.1 cache_creation object form parsed (cc5=200, cc1=80)');
  } else {
    fail++;
    console.log('  FAIL  §I.1 expected 1000/500/50000/200/80/0, got ' + JSON.stringify(t));
  }

  // Cost should be a positive number for a matched model.
  if (got && got.tokens && typeof got.tokens.cost === 'number' && got.tokens.cost > 0) {
    pass++;
    console.log('  PASS  §I.2 cost positive for matched claude-sonnet-* ($' + got.tokens.cost.toFixed(4) + ')');
  } else {
    fail++;
    console.log('  FAIL  §I.2 expected positive cost, got ' + JSON.stringify(got && got.tokens && got.tokens.cost));
  }
}

// --- §J. v0.2.4 token stats: sidechain rows skipped, synthetic filtered -----
//
// Plant a transcript with a sidechain row (subagent leak into parent) and a
// <synthetic> model row. Both should be SKIPPED by readTranscriptIncremental.
{
  const home = newTempHome();
  const tsDir = path.join(home, '.claude', 'projects', 'skip-proj');
  fs.mkdirSync(tsDir, { recursive: true });
  const tsPath = path.join(tsDir, SID + '.jsonl');
  const now = Date.now();
  const rows = [
    {
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(now - 60000).toISOString(),
      message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 10, output_tokens: 5 } },
    },
    {
      type: 'assistant',
      isSidechain: true, // SKIP (subagent in parent transcript — should not happen but defensive)
      timestamp: new Date(now - 50000).toISOString(),
      message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 9999, output_tokens: 9999 } },
    },
    {
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(now - 40000).toISOString(),
      message: {
        role: 'assistant',
        model: '<synthetic>', // SKIP
        usage: { input_tokens: 9999, output_tokens: 9999 },
      },
    },
    {
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(now - 30000).toISOString(),
      message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 20, output_tokens: 10 } },
    },
  ];
  fs.writeFileSync(tsPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const got = fire(home, 'PostToolUse', { transcript_path: tsPath });
  const t = got && got.tokens && got.tokens.total;
  // Only rows 0 and 3 counted: 10+20=30 input, 5+10=15 output.
  if (t && t.in === 30 && t.out === 15) {
    pass++;
    console.log('  PASS  §J.1 sidechain + <synthetic> rows skipped (in=30 out=15)');
  } else {
    fail++;
    console.log('  FAIL  §J.1 expected 30/15, got ' + JSON.stringify(t));
  }
}

// --- §K. v0.2.4 token stats: cwd passthrough --------------------------------
//
// Verify that payload.cwd flows through to <sid>.json.cwd so the IIFE tooltip
// can show the project path.
{
  const home = newTempHome();
  const got = fire(home, 'UserPromptSubmit', { cwd: '/tmp/my-project' });
  if (got && got.cwd === '/tmp/my-project') {
    pass++;
    console.log('  PASS  §K.1 payload.cwd written to status.cwd');
  } else {
    fail++;
    console.log('  FAIL  §K.1 expected cwd=/tmp/my-project, got ' + JSON.stringify(got && got.cwd));
  }
}

// --- §L. v0.2.4 token stats: bug #41310 — transcript absent -----------------
//
// UserPromptSubmit fires before CC creates the transcript (CC v2.1.204 bug).
// Verify the writer skips silently and writes the status file without tokens.
{
  const home = newTempHome();
  const got = fire(home, 'UserPromptSubmit', {
    transcript_path: path.join(home, '.claude', 'projects', 'nope', 'missing.jsonl'),
  });
  if (got && got.state === 'running' && got.tokens === undefined) {
    pass++;
    console.log('  PASS  §L.1 missing transcript_path → status written, no tokens field');
  } else {
    fail++;
    console.log(
      '  FAIL  §L.1 expected running+no tokens, got state=' +
        (got && got.state) +
        ' tokens=' +
        JSON.stringify(got && got.tokens),
    );
  }
}

// --- §M. v0.2.5 critical: SubagentStop must not corrupt parent sid totals -
//
// Plant a parent transcript, fire PostToolUse (parent's tokens recorded), then
// fire SubagentStop with a DIFFERENT agent_transcript_path (smaller than the
// parent's offset). Pre-fix, this would have triggered a size-shrink reset of
// the WHOLE ctx, zeroing the parent's totals/buckets/perTurn. Post-fix, the
// subagent gets its own per-source cursor in ctx.subOffsets; the parent's
// cumulative state is untouched AND the subagent's tokens are merged in.
{
  const home = newTempHome();
  const parentDir = path.join(home, '.claude', 'projects', 'parent-proj');
  const subDir = path.join(home, '.claude', 'projects', 'sub-proj');
  fs.mkdirSync(parentDir, { recursive: true });
  fs.mkdirSync(subDir, { recursive: true });
  // Parent transcript: LARGE (a few rows so offset grows well past the
  // subagent's size — the pre-fix size-shrink reset would then trigger).
  const parentPath = path.join(parentDir, SID + '.jsonl');
  const subAgentHex = 'deadbeef';
  // Use a recognizable agentId-bearing filename so the writer extracts the
  // agentId from the basename (round-3: full basename, not hex run).
  const subPath = path.join(subDir, 'agent-' + subAgentHex + '.jsonl');
  const now = Date.now();
  const parentRows = [];
  for (let i = 0; i < 5; i++) {
    parentRows.push({
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(now - (5 - i) * 60000).toISOString(),
      message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 100, output_tokens: 50 } },
    });
  }
  fs.writeFileSync(parentPath, parentRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // Fire PostToolUse to load the parent transcript → ctx.offset = parentSize.
  let got = fire(home, 'PostToolUse', { transcript_path: parentPath });
  const parentTotalAfterFirst = got && got.tokens && got.tokens.total;
  const okParentLoaded = parentTotalAfterFirst && parentTotalAfterFirst.in === 500 && parentTotalAfterFirst.out === 250;
  if (okParentLoaded) {
    pass++;
    console.log('  PASS  §M.1 PostToolUse loads parent transcript (500/250)');
  } else {
    fail++;
    console.log('  FAIL  §M.1 expected 500/250, got ' + JSON.stringify(parentTotalAfterFirst));
  }

  // Now plant a SMALLER subagent transcript (size < parentOffset) and fire
  // SubagentStop. Pre-fix: this triggered size-shrink reset → parent totals
  // zeroed. Post-fix: per-source cursor isolates the read.
  const subRows = [
    {
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(now - 30000).toISOString(),
      message: {
        role: 'assistant',
        model: 'glm-5.2',
        usage: { input_tokens: 50, output_tokens: 25 },
      },
    },
  ];
  fs.writeFileSync(subPath, subRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  got = fire(home, 'SubagentStop', {
    transcript_path: parentPath,
    agent_transcript_path: subPath,
  });
  // Verify: parent's totals should INCLUDE the subagent's 50/25 contribution
  // on top of the original 500/250 → 550/275. Pre-fix this would have been
  // reset to ~just the subagent (50/25) or worse.
  const mergedTotal = got && got.tokens && got.tokens.total;
  if (mergedTotal && mergedTotal.in === 550 && mergedTotal.out === 275) {
    pass++;
    console.log('  PASS  §M.2 SubagentStop merges subagent (50/25) into parent (500/250) → 550/275');
  } else {
    fail++;
    console.log('  FAIL  §M.2 expected 550/275 (parent+subagent), got ' + JSON.stringify(mergedTotal));
  }

  // Fire another PostToolUse on the parent transcript — the parent's offset
  // must NOT have been corrupted by the SubagentStop. No new bytes added so
  // totals should stay the same; pre-fix this would either re-read everything
  // or skip everything.
  got = fire(home, 'PostToolUse', { transcript_path: parentPath });
  const totalsAfterRepost = got && got.tokens && got.tokens.total;
  if (totalsAfterRepost && totalsAfterRepost.in === 550 && totalsAfterRepost.out === 275) {
    pass++;
    console.log('  PASS  §M.3 PostSubagent PostToolUse preserves merged totals (550/275)');
  } else {
    fail++;
    console.log('  FAIL  §M.3 expected 550/275 to persist, got ' + JSON.stringify(totalsAfterRepost));
  }

  // Verify the sidecar has the subagent's per-source cursor recorded.
  const sidecar = path.join(home, '.claude', 'cc-tab-status', SID + '.offset');
  let sidecarObj = null;
  try {
    sidecarObj = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  } catch {
    /* ignore */
  }
  // Round-3 keys by full basename ('agent-deadbeef'), not hex run ('deadbeef').
  const subKey = 'sub:agent-' + subAgentHex;
  if (
    sidecarObj &&
    sidecarObj.subOffsets &&
    sidecarObj.subOffsets[subKey] &&
    typeof sidecarObj.subOffsets[subKey].offset === 'number'
  ) {
    pass++;
    console.log('  PASS  §M.4 sidecar records per-source sub cursor for ' + subKey);
  } else {
    fail++;
    console.log(
      '  FAIL  §M.4 expected subOffsets[' +
        subKey +
        '] with numeric offset, got ' +
        JSON.stringify(sidecarObj && sidecarObj.subOffsets),
    );
  }
}

// --- §N. v0.2.5 high: mixed-model session cost uses per-bucket rates -------
//
// Sonnet turn (in=3, out=15) followed by Opus turn (in=15, out=75) must price
// each turn at its OWN model's rate. Pre-fix the session total used lastModel
// (Opus) for both turns → ~5x overestimate for the Sonnet part.
{
  const home = newTempHome();
  const tsDir = path.join(home, '.claude', 'projects', 'mix-proj');
  fs.mkdirSync(tsDir, { recursive: true });
  const tsPath = path.join(tsDir, SID + '.jsonl');
  const now = Date.now();
  const rows = [
    {
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(now - 60000).toISOString(),
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
    },
    {
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(now - 30000).toISOString(),
      message: {
        role: 'assistant',
        model: 'claude-opus-4-20250514',
        usage: { input_tokens: 500, output_tokens: 200 },
      },
    },
  ];
  fs.writeFileSync(tsPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const installDir = path.join(home, '.claude', 'cc-status-dot');
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'token-rates.json'),
    JSON.stringify({
      _default: null,
      'claude-sonnet-*': { in: 3, out: 15 },
      'claude-opus-*': { in: 15, out: 75 },
    }),
  );
  const got = fire(home, 'PostToolUse', { transcript_path: tsPath });
  // Sonnet turn: 1000*3 + 500*15 = 3000+7500 = 10500 / 1M = $0.0105
  // Opus turn: 500*15 + 200*75 = 7500+15000 = 22500 / 1M = $0.0225
  // Total: $0.033. Pre-fix (Opus rate for both): (1000+500)*15 + (500+200)*75
  //   = 22500 + 52500 = 75000 / 1M = $0.075 (2.27x overestimate).
  const cost = got && got.tokens && got.tokens.cost;
  const okCost = typeof cost === 'number' && Math.abs(cost - 0.033) < 1e-9;
  if (okCost) {
    pass++;
    console.log('  PASS  §N.1 mixed-model cost $' + cost.toFixed(4) + ' (sonnet@sonnet + opus@opus, not all@opus)');
  } else {
    fail++;
    console.log('  FAIL  §N.1 expected $0.0330, got $' + (typeof cost === 'number' ? cost.toFixed(6) : cost));
  }
}

// --- §N.2 v0.2.5 round-2 regression: Opus 4.5+ must use $5/$25, NOT $15/$75 --
//
// token-rates.json has both `claude-opus-4-*` (historical Opus 4/4.1 $15/$75)
// and `claude-opus-4-5*` (Opus 4.5+ launched 2025-11-24 at $5/$25). Pre-fix the
// `claude-opus-4-*` glob (specificity 14) shadowed the broader `claude-opus-*`
// catch-all (specificity 11) for Opus 4.5+ ids like `claude-opus-4-5-20251124`
// → 3x cost over-estimation on the current flagship Opus model. Post-fix the
// `claude-opus-4-5*` entry (specificity 15) wins. This test plants the rate
// table (mirrors token-rates.json's opus entries 1:1) and asserts the model
// id `claude-opus-4-5-20251124` prices at $5/$25, NOT $15/$75.
{
  const home = newTempHome();
  const tsDir = path.join(home, '.claude', 'projects', 'opus45-proj');
  fs.mkdirSync(tsDir, { recursive: true });
  const tsPath = path.join(tsDir, SID + '.jsonl');
  const now = Date.now();
  const rows = [
    {
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(now - 30000).toISOString(),
      message: {
        role: 'assistant',
        model: 'claude-opus-4-5-20251124',
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
    },
  ];
  fs.writeFileSync(tsPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const installDir = path.join(home, '.claude', 'cc-status-dot');
  fs.mkdirSync(installDir, { recursive: true });
  // Mirror the production token-rates.json opus section verbatim so a future
  // maintainer editing the glob set sees this test break alongside the file.
  fs.writeFileSync(
    path.join(installDir, 'token-rates.json'),
    JSON.stringify({
      _default: null,
      'claude-3-opus-*': { in: 15, out: 75 },
      'claude-opus-4-1*': { in: 15, out: 75 },
      'claude-opus-4-*': { in: 15, out: 75 },
      'claude-opus-4-5*': { in: 5, out: 25 },
      'claude-opus-*': { in: 5, out: 25 },
    }),
  );
  const got = fire(home, 'PostToolUse', { transcript_path: tsPath });
  // Opus 4.5 turn: 1000*$5 + 500*$25 = 5000+12500 = 17500 / 1M = $0.0175.
  // Pre-fix ($15/$75 from claude-opus-4-* shadow): 1000*15 + 500*75 =
  //   15000+37500 = 52500 / 1M = $0.0525 (3x over-estimate).
  const cost = got && got.tokens && got.tokens.cost;
  const okCost = typeof cost === 'number' && Math.abs(cost - 0.0175) < 1e-9;
  if (okCost) {
    pass++;
    console.log('  PASS  §N.2 Opus 4.5 priced at $5/$25 (cost $' + cost.toFixed(4) + ', not 3x at $0.0525)');
  } else {
    fail++;
    console.log(
      '  FAIL  §N.2 expected $0.0175 (Opus 4.5 $5/$25), got $' +
        (typeof cost === 'number' ? cost.toFixed(6) : cost) +
        ' — likely the claude-opus-4-* glob is shadowing claude-opus-4-5* for the Opus 4.5 model id',
    );
  }
}

// --- §N.3 v0.2.4 round-3 MEDIUM regression: last_model after foldBuckets interleave --
//
// deriveTokensField builds tokens.last_model for the tooltip's "Last model:"
// line. Pre-fix this was ctx.buckets[length-1].model — the array tail. But
// foldBuckets produces FIRST-SIGHTING order per (window, model) key, so when
// distinct models interleave within a fold window the tail reflects the
// most-recent FIRST-sighting, NOT the model of the chronologically-latest row.
// Example: rows M2@t1, M1@t2, M2@t3 (same 5min window) yield folded result
// [M2_bucket(seen@t1, ts=t3), M1_bucket(seen@t2, ts=t2)] — tail was M1 even
// though the latest row was M2@t3. Post-fix: scan for the bucket with the
// maximum .ts. Trigger the bug by forcing foldBuckets to run (>1000 buckets)
// with an interleave pattern that puts the older-model bucket at the array
// tail but a newer-model bucket at the max .ts.
{
  const home = newTempHome();
  const tsDir = path.join(home, '.claude', 'projects', 'lastmodel-proj');
  fs.mkdirSync(tsDir, { recursive: true });
  const tsPath = path.join(tsDir, SID + '.jsonl');
  const installDir = path.join(home, '.claude', 'cc-status-dot');
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'token-rates.json'),
    JSON.stringify({ _default: null, 'claude-sonnet-*': { in: 3, out: 15 }, 'claude-opus-*': { in: 15, out: 75 } }),
  );
  const now = Date.now();
  // Build a transcript that forces foldBuckets (>1000 buckets) AND lands the
  // first-seen-last-in-array bucket at a model that's NOT the latest-row model.
  // Strategy: emit alternating opus/sonnet rows at 6min apart (different 5min
  // windows each → no 5min fold; same 1h window per pair → 1h fold groups
  // them by (1h-window, model)). End with a sonnet row that's the chronologically
  // latest, but its (1h, sonnet) bucket is FIRST-seen EARLIER than the (1h,
  // opus) bucket, so foldBuckets puts opus at the array tail.
  //
  // Simpler trigger: emit 1001 opus rows first, then 1 sonnet row last. After
  // fold, the opus bucket (first sighting) sits at index 0 of the folded
  // array, the sonnet bucket (first sighting later) sits at the tail. The
  // latest row is sonnet, but pre-fix foldBuckets ALSO preserves first-sighting
  // order so sonnet IS the tail here → that wouldn't catch the bug.
  //
  // Real trigger: rows in order [opus@t1, sonnet@t2, opus@t3]. After fold to
  // (window, model): opus_bucket seen@t1 with ts=t3, sonnet_bucket seen@t2
  // with ts=t2. Folded result preserves first-sighting order: [opus, sonnet].
  // Tail = sonnet. But latest row is opus@t3 → pre-fix returned sonnet (wrong).
  //
  // To force foldBuckets to actually run we need >1000 buckets. Generate
  // 1002 interleaved rows spread across many windows. Use distinct 5min
  // windows so 5min fold doesn't merge. The 1h stage then merges by (1h,
  // model). Within each 1h window we have one opus and one sonnet row, in
  // the order [opus_first, sonnet_second]. After 1h fold: [opus_bucket,
  // sonnet_bucket] per window. After all merges: array is opus_window1,
  // sonnet_window1, opus_window2, sonnet_window2, ... The TAIL is the latest
  // sonnet, which IS the latest row chronologically (sonnet always second).
  // To trigger the bug, we need the LATEST row's MODEL to differ from the
  // tail bucket's MODEL — i.e. emit one more opus row at the very end.
  const rows = [];
  // 500 pairs of (opus, sonnet) across 500 distinct 5min windows.
  for (let i = 0; i < 500; i++) {
    const t = now - (1000 - i) * 6 * 60 * 1000;
    rows.push({
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(t).toISOString(),
      message: { role: 'assistant', model: 'claude-opus-4-20250514', usage: { input_tokens: 1, output_tokens: 1 } },
    });
    rows.push({
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(t + 60000).toISOString(),
      message: { role: 'assistant', model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 1, output_tokens: 1 } },
    });
  }
  // Final opus row at the chronologically-latest timestamp. After fold:
  // sonnet buckets (first-seen in each 1h window before the final opus
  // bucket) fill the array; the final opus bucket sits at the tail IF its
  // 1h window is distinct from the previous. With t = now - 6*60*1000 the
  // final opus lands in a NEW 1h window → new (1h, opus) bucket at the tail.
  // That's the OPPOSITE of the bug — the tail IS the latest model. To
  // expose the bug we need the latest row's (window, model) bucket to be
  // first-seen BEFORE a different-model bucket that ends up at the tail.
  //
  // Construct: [opus_A, sonnet_B] in window W (1h). opus_A first-seen at
  // index N, sonnet_B first-seen at index N+1. The folded array preserves
  // first-sighting order → [..., opus_A_bucket, sonnet_B_bucket, ...]. The
  // sonnet_B_bucket sits AFTER opus_A_bucket in the array. If sonnet_B is
  // chronologically LATER than opus_A, both are valid; tail = sonnet_B =
  // latest row → no bug.
  //
  // The bug requires: latest row's bucket is FIRST-seen BEFORE another
  // bucket that ends up at the array tail. So: [opus_A@t1, sonnet_B@t2,
  // opus_A@t3] in same 1h window W. opus_A bucket first-seen at t1 (tail ts
  // = t3), sonnet_B bucket first-seen at t2 (tail ts = t2). Folded order:
  // [opus_A_bucket, sonnet_B_bucket]. Tail = sonnet_B = model sonnet.
  // Latest row = opus_A@t3 = model opus. Pre-fix lastModel = sonnet (WRONG).
  // Post-fix lastModel = opus (CORRECT).
  //
  // To trigger foldBuckets we still need >1000 buckets, so we replicate this
  // pattern across 501 distinct 1h windows.
  for (let i = 0; i < 501; i++) {
    const wBase = now - (501 - i) * 60 * 60 * 1000; // distinct 1h windows
    rows.push({
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(wBase).toISOString(),
      message: { role: 'assistant', model: 'claude-opus-4-20250514', usage: { input_tokens: 1, output_tokens: 1 } },
    });
    rows.push({
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(wBase + 60000).toISOString(),
      message: { role: 'assistant', model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 1, output_tokens: 1 } },
    });
    // Third row in the SAME 1h window: opus again, chronologically latest.
    rows.push({
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(wBase + 120000).toISOString(),
      message: { role: 'assistant', model: 'claude-opus-4-20250514', usage: { input_tokens: 1, output_tokens: 1 } },
    });
  }
  fs.writeFileSync(tsPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const got = fire(home, 'PostToolUse', { transcript_path: tsPath });
  const lastModel = got && got.tokens && got.tokens.last_model;
  // The very last row written is opus (the third row in the last 1h window).
  // Pre-fix: foldBuckets preserves first-sighting order; the final window's
  // buckets are [opus_bucket, sonnet_bucket] → tail = sonnet. Post-fix: scan
  // by max .ts → the third opus row has the latest ts → last_model = opus.
  if (lastModel === 'claude-opus-4-20250514') {
    pass++;
    console.log('  PASS  §N.3 last_model = opus (chronologically latest after fold), not sonnet (array tail)');
  } else {
    fail++;
    console.log(
      '  FAIL  §N.3 expected last_model=claude-opus-4-20250514 (latest row), got ' +
        JSON.stringify(lastModel) +
        ' — likely the array-tail derivation still misattributes after foldBuckets',
    );
  }
}

// --- §O. v0.2.5 high: cache_creation dual form — object wins, no 2x -------
//
// Plant a row with BOTH cache_creation (object) and cache_creation_input_tokens
// (scalar = legacy sum of 5m+1h). Pre-fix this would have double-counted
// (~2x cost). Post-fix the object form wins and cci is zeroed.
{
  const home = newTempHome();
  const tsDir = path.join(home, '.claude', 'projects', 'cc2x-proj');
  fs.mkdirSync(tsDir, { recursive: true });
  const tsPath = path.join(tsDir, SID + '.jsonl');
  const now = Date.now();
  // Anthropic legacy transition: BOTH forms present. Object form: 200+80=280.
  // Scalar: 280 (sum). Old parser: cc5=200, cc1=80, cci=280 → cci DOUBLE-COUNTS.
  // New parser: cc5=200, cc1=80, cci=0 (object form preferred).
  const row = {
    type: 'assistant',
    isSidechain: false,
    timestamp: new Date(now - 10000).toISOString(),
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 0,
        cache_creation: {
          ephemeral_5m_input_tokens: 200,
          ephemeral_1h_input_tokens: 80,
        },
        cache_creation_input_tokens: 280,
      },
    },
  };
  fs.writeFileSync(tsPath, JSON.stringify(row) + '\n');
  const installDir = path.join(home, '.claude', 'cc-status-dot');
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'token-rates.json'),
    JSON.stringify({
      _default: null,
      'claude-sonnet-*': { in: 3, out: 15, cacheCreate5m: 3.75, cacheCreate1h: 6 },
    }),
  );
  const got = fire(home, 'PostToolUse', { transcript_path: tsPath });
  const t = got && got.tokens && got.tokens.total;
  // Verify cci was zeroed (object form won).
  if (t && t.cci === 0 && t.cc5 === 200 && t.cc1 === 80) {
    pass++;
    console.log('  PASS  §O.1 dual-form dedup: object form wins, cci=0 (no 2x double-count)');
  } else {
    fail++;
    console.log('  FAIL  §O.1 expected cc5=200/cc1=80/cci=0, got ' + JSON.stringify(t));
  }
  // Cost should NOT include the 280 scalar double-count.
  // Expected: 1000*3 + 500*15 + 200*3.75 + 80*6 = 3000+7500+750+480 = 11730 / 1M = $0.01173
  // Pre-fix would have added 280*3.75 = $0.00105 extra → $0.01278.
  const cost = got && got.tokens && got.tokens.cost;
  const okCost = typeof cost === 'number' && Math.abs(cost - 0.01173) < 1e-9;
  if (okCost) {
    pass++;
    console.log('  PASS  §O.2 dual-form cost $' + cost.toFixed(5) + ' (no scalar double-count)');
  } else {
    fail++;
    console.log('  FAIL  §O.2 expected $0.01173, got $' + (typeof cost === 'number' ? cost.toFixed(6) : cost));
  }
}

// --- §P. v0.2.5 medium: cost_partial flag when some buckets are unrated ---
//
// Mix a rated model (Sonnet) with an unrated model (GLM) → cost is computable
// for the Sonnet part only. The writer must set cost_partial=true so the IIFE
// can flag the displayed $ as a lower bound.
{
  const home = newTempHome();
  const tsDir = path.join(home, '.claude', 'projects', 'partial-proj');
  fs.mkdirSync(tsDir, { recursive: true });
  const tsPath = path.join(tsDir, SID + '.jsonl');
  const now = Date.now();
  const rows = [
    {
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(now - 60000).toISOString(),
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
    },
    {
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(now - 30000).toISOString(),
      message: {
        role: 'assistant',
        model: 'glm-5.2', // no rate entry
        usage: { input_tokens: 9999, output_tokens: 9999 },
      },
    },
  ];
  fs.writeFileSync(tsPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const installDir = path.join(home, '.claude', 'cc-status-dot');
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'token-rates.json'),
    JSON.stringify({ _default: null, 'claude-sonnet-*': { in: 3, out: 15 } }),
  );
  const got = fire(home, 'PostToolUse', { transcript_path: tsPath });
  const partial = got && got.tokens && got.tokens.cost_partial;
  const cost = got && got.tokens && got.tokens.cost;
  // Cost = sonnet part only = (1000*3 + 500*15) / 1M = 10500 / 1M = $0.0105
  // GLM part is unrated → skipped → cost_partial=true.
  if (partial === true && typeof cost === 'number' && Math.abs(cost - 0.0105) < 1e-9) {
    pass++;
    console.log('  PASS  §P.1 cost_partial=true + cost=$' + cost.toFixed(5) + ' (sonnet-only, glm skipped)');
  } else {
    fail++;
    console.log(
      '  FAIL  §P.1 expected partial=true cost=$0.0105, got partial=' +
        partial +
        ' cost=' +
        (typeof cost === 'number' ? cost.toFixed(6) : cost),
    );
  }
}

// --- §Q. v0.2.5 high: cost_3d / cost_7d / cost_30d / cost_all exposed -----
//
// Verify the writer now exposes cost_<window> for ALL 8 TOK_WINDOWS entries
// (previously only 5min/1h/24h/7d/30d). The IIFE inline SBI reads
// tok['cost_'+tWin] for the selected window — all 8 must be present.
{
  const home = newTempHome();
  const tsDir = path.join(home, '.claude', 'projects', 'allwin-proj');
  fs.mkdirSync(tsDir, { recursive: true });
  const tsPath = path.join(tsDir, SID + '.jsonl');
  const now = Date.now();
  fs.writeFileSync(
    tsPath,
    JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(now - 60000).toISOString(),
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
    }) + '\n',
  );
  const installDir = path.join(home, '.claude', 'cc-status-dot');
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'token-rates.json'),
    JSON.stringify({ _default: null, 'claude-sonnet-*': { in: 3, out: 15 } }),
  );
  const got = fire(home, 'PostToolUse', { transcript_path: tsPath });
  const windows = ['5min', '10min', '1h', '24h', '3d', '7d', '30d', 'all'];
  let allPresent = true;
  for (const w of windows) {
    const key = 'cost_' + w;
    if (!got || !got.tokens || typeof got.tokens[key] !== 'number') {
      allPresent = false;
      console.log('    missing cost field: ' + key);
    }
  }
  if (allPresent) {
    pass++;
    console.log('  PASS  §Q.1 all 8 cost_<window> fields exposed (5min/10min/1h/24h/3d/7d/30d/all)');
  } else {
    fail++;
    console.log(
      '  FAIL  §Q.1 missing some cost_<window> fields, got keys=' + Object.keys((got && got.tokens) || {}).join(','),
    );
  }
}

// --- §R. v0.2.5 high: forceFull marker triggers full re-read --------------
//
// Plant a transcript, fire once (offset advances), then write a <sid>.forcereread
// marker. Next fire must re-read the WHOLE file from byte 0 (not tail pre-warm
// and not incremental). Verifies the QuickPick "Reset session stats" path.
{
  const home = newTempHome();
  const tsDir = path.join(home, '.claude', 'projects', 'force-proj');
  fs.mkdirSync(tsDir, { recursive: true });
  const tsPath = path.join(tsDir, SID + '.jsonl');
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < 3; i++) {
    rows.push({
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(now - (3 - i) * 60000).toISOString(),
      message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 100, output_tokens: 50 } },
    });
  }
  fs.writeFileSync(tsPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // First fire: normal read, all 3 rows counted.
  let got = fire(home, 'PostToolUse', { transcript_path: tsPath });
  const total1 = got && got.tokens && got.tokens.total;
  if (total1 && total1.in === 300 && total1.out === 150) {
    pass++;
    console.log('  PASS  §R.1 first fire counts all 3 rows (300/150)');
  } else {
    fail++;
    console.log('  FAIL  §R.1 expected 300/150, got ' + JSON.stringify(total1));
  }
  // Write the forcerEAD marker. v0.2.5 round-3: NO offset unlink (mirrors the
  // new IIFE behavior — the QuickPick Reset handler now writes ONLY the marker,
  // keeping the offset sidecar so the forceFull subagent-preservation filter
  // has already-merged buckets to keep; see §R.4 below for the subagent
  // preservation regression lock).
  const stateDir = path.join(home, '.claude', 'cc-tab-status');
  const markP = path.join(stateDir, SID + '.forcereread');
  fs.writeFileSync(markP, String(Date.now()));
  // Second fire: marker consumed, full re-read → totals match first fire.
  got = fire(home, 'PostToolUse', { transcript_path: tsPath });
  const total2 = got && got.tokens && got.tokens.total;
  if (total2 && total2.in === 300 && total2.out === 150) {
    pass++;
    console.log('  PASS  §R.2 forcererEAD marker triggers full re-read (300/150 restored)');
  } else {
    fail++;
    console.log('  FAIL  §R.2 expected 300/150 after re-read, got ' + JSON.stringify(total2));
  }
  // Marker must be consumed.
  const markerGone = !fs.existsSync(markP);
  if (markerGone) {
    pass++;
    console.log('  PASS  §R.3 forcererEAD marker consumed by hook fire');
  } else {
    fail++;
    console.log('  FAIL  §R.3 marker still present at ' + markP);
  }
}

// --- §R.4 v0.2.5 round-3 MEDIUM regression: QuickPick Reset preserves subagent
//
// Architecture round-3 fix: the QuickPick "Reset session stats" handler in the
// IIFE previously called BOTH fs.unlinkSync(<sid>.offset) AND wrote a
// <sid>.forcereread marker. Deleting the offset sidecar meant the next fire
// read ctx = fresh default (ctx.buckets=[]). The forceFull path's subagent
// preservation filter `b.src && b.src !== 'main'` then operated on an EMPTY
// array → keptBuckets=[] → all already-merged subagent tokens permanently
// lost (SubagentStop fires once per subagent — no replay). The user would
// click Reset and see the displayed total DROP by the subagent share, which
// is the OPPOSITE of the "get accurate total" UX the detail string promises.
//
// Fix: the IIFE now writes ONLY the marker (no unlink). The hook's forceFull
// path keeps the offset sidecar, so the preservation filter has subagent
// buckets to keep; re-reading main transcript from byte 0 adds fresh main
// tokens on top of the preserved subagent share.
//
// This test plants main + sub transcripts, fires SubagentStop to merge the
// subagent, writes the marker (mirroring the new IIFE — NO offset unlink),
// then fires again and asserts the subagent tokens SURVIVE the reset.
// Pre-fix behavior would fail this test: deleting the offset before writing
// the marker → ctx.buckets=[] on the next fire → subagent share dropped.
{
  const home = newTempHome();
  const parentDir = path.join(home, '.claude', 'projects', 'reset-sub-proj');
  const subDir = path.join(home, '.claude', 'projects', 'reset-sub-sub');
  fs.mkdirSync(parentDir, { recursive: true });
  fs.mkdirSync(subDir, { recursive: true });
  const parentPath = path.join(parentDir, SID + '.jsonl');
  const subAgentHex = 'cafef00d';
  const subPath = path.join(subDir, 'agent-' + subAgentHex + '.jsonl');
  const installDir = path.join(home, '.claude', 'cc-status-dot');
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'token-rates.json'),
    JSON.stringify({ _default: null, 'glm-*': { in: 1, out: 5 } }),
  );
  const now = Date.now();
  // 2 MAIN rows (200/100) + 3 SUB rows (300/150) → post-SubagentStop total
  // should be 500/250. After Reset+forceFull the SUBAGENT 300/150 MUST survive
  // (preservation filter keeps src!=='main') and the MAIN 200/100 is re-read
  // from byte 0 → final total still 500/250.
  const mainRows = [];
  for (let i = 0; i < 2; i++) {
    mainRows.push({
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(now - (2 - i) * 60000).toISOString(),
      message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 100, output_tokens: 50 } },
    });
  }
  fs.writeFileSync(parentPath, mainRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const subRows = [];
  for (let i = 0; i < 3; i++) {
    subRows.push({
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(now - (3 - i) * 60000 - 1000).toISOString(),
      message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 100, output_tokens: 50 } },
    });
  }
  fs.writeFileSync(subPath, subRows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // Fire 1: PostToolUse reads 2 main rows.
  let got = fire(home, 'PostToolUse', { transcript_path: parentPath });
  const totalFire1 = got && got.tokens && got.tokens.total;
  if (totalFire1 && totalFire1.in === 200 && totalFire1.out === 100) {
    pass++;
    console.log('  PASS  §R.4a fire 1 reads 2 main rows (200/100)');
  } else {
    fail++;
    console.log('  FAIL  §R.4a expected 200/100, got ' + JSON.stringify(totalFire1));
  }

  // Fire 2: SubagentStop merges 3 subagent rows → total = 200+300 / 100+150 = 500/250.
  got = fire(home, 'SubagentStop', { transcript_path: parentPath, agent_transcript_path: subPath });
  const totalFire2 = got && got.tokens && got.tokens.total;
  if (totalFire2 && totalFire2.in === 500 && totalFire2.out === 250) {
    pass++;
    console.log('  PASS  §R.4b SubagentStop merges 3 subagent rows (500/250)');
  } else {
    fail++;
    console.log('  FAIL  §R.4b expected 500/250, got ' + JSON.stringify(totalFire2));
  }

  // Write the forcerEAD marker ONLY (mirrors new IIFE — NO offset unlink).
  // Pre-fix IIFE would have also unlinked <sid>.offset here, zeroing ctx.buckets
  // and making the §R.4c preservation assertion fail with main-only (200/100).
  const stateDir = path.join(home, '.claude', 'cc-tab-status');
  const markP = path.join(stateDir, SID + '.forcereread');
  fs.writeFileSync(markP, String(Date.now()));

  // Fire 3: forceFull path runs (marker consumed). MAIN entries are cleared +
  // re-read from byte 0; SUBAGENT entries survive the preservation filter.
  // Final total = subagent (preserved 300/150) + main (re-read 200/100) = 500/250.
  // Pre-fix would produce 200/100 (subagent lost — ctx.buckets was zeroed by
  // the now-removed offset unlink, so the preservation filter had nothing to keep).
  got = fire(home, 'PostToolUse', { transcript_path: parentPath });
  const totalFire3 = got && got.tokens && got.tokens.total;
  if (totalFire3 && totalFire3.in === 500 && totalFire3.out === 250) {
    pass++;
    console.log(
      '  PASS  §R.4c QuickPick Reset preserves subagent through forceFull (500/250 survived — pre-fix would have been 200/100)',
    );
  } else {
    fail++;
    console.log(
      '  FAIL  §R.4c expected 500/250 (subagent preserved through Reset), got ' +
        JSON.stringify(totalFire3) +
        ' — likely the IIFE Reset handler is still unlinking <sid>.offset and zeroing ctx.buckets before forceFull can preserve subagent',
    );
  }

  // Marker must be consumed.
  const markerGone = !fs.existsSync(markP);
  if (markerGone) {
    pass++;
    console.log('  PASS  §R.4d forcererEAD marker consumed by hook fire (subagent-preservation fire)');
  } else {
    fail++;
    console.log('  FAIL  §R.4d marker still present at ' + markP);
  }
}

// --- §S. v0.2.5 critical: first-fire tail pre-warm backfill (was dead code) --
//
// Plant a transcript LARGER than TOK_TAIL_PRESET_BYTES (256KB) and fire
// PostToolUse twice. Pre-fix: fire 1 set ctx.tailWarmed=true and advanced
// srcView.offset to stat.size; fire 2's gate required srcView.offset===0,
// which was false, so the backfill branch was UNREACHABLE. Cumulative
// totals were permanently stuck at the partial tail-only values for any
// parent transcript >256KB at VS Code startup. Verified on a 5000-row /
// 885KB transcript returning only ~30% of expected totals, identical on
// fire 2. Post-fix: fire 1 still does the tail pre-warm but fire 2
// (regardless of new bytes) backfills via a full re-read, replacing
// partial totals with accurate ones.
{
  const home = newTempHome();
  const tsDir = path.join(home, '.claude', 'projects', 'big-prewarm-proj');
  fs.mkdirSync(tsDir, { recursive: true });
  const tsPath = path.join(tsDir, SID + '.jsonl');
  // 2000 rows × ~175 bytes each ≈ 350KB total (> 256KB threshold). Each row
  // has input_tokens=10 / output_tokens=5 → full-session sum is 20000/10000.
  // Fire 1's tail pre-warm slice (last 256KB) only sees the trailing ~1500
  // rows, so its total is partial (~15000/7500).
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < 2000; i++) {
    rows.push({
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(now - (2000 - i) * 1000).toISOString(),
      message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 10, output_tokens: 5 } },
    });
  }
  fs.writeFileSync(tsPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const statSize = fs.statSync(tsPath).size;
  const bigEnough = statSize > 256 * 1024;
  if (bigEnough) {
    pass++;
    console.log('  PASS  §S.0 synthetic transcript > 256KB (' + statSize + ' bytes)');
  } else {
    fail++;
    console.log('  FAIL  §S.0 expected > 256KB, got ' + statSize);
  }

  // Fire 1: tail pre-warm. Totals must be PARTIAL (non-zero but less than
  // the full sum). A full read on fire 1 would mean the gate didn't fire.
  let got = fire(home, 'PostToolUse', { transcript_path: tsPath });
  const totalFire1 = got && got.tokens && got.tokens.total;
  const fire1Partial = totalFire1 && totalFire1.in < 20000 && totalFire1.in > 0;
  if (fire1Partial) {
    pass++;
    console.log('  PASS  §S.1 fire 1 tail pre-warm returns PARTIAL total (in=' + totalFire1.in + ' < 20000)');
  } else {
    fail++;
    console.log('  FAIL  §S.1 expected partial total < 20000, got ' + JSON.stringify(totalFire1));
  }

  // Sidecar must record tailWarmed=true (backfill pending).
  const offsetP = path.join(home, '.claude', 'cc-tab-status', SID + '.offset');
  let sc1 = null;
  try {
    sc1 = JSON.parse(fs.readFileSync(offsetP, 'utf8'));
  } catch {
    /* ignore */
  }
  if (sc1 && sc1.tailWarmed === true) {
    pass++;
    console.log('  PASS  §S.2 sidecar.tailWarmed=true after fire 1 (backfill pending)');
  } else {
    fail++;
    console.log('  FAIL  §S.2 expected tailWarmed=true, got ' + JSON.stringify(sc1 && sc1.tailWarmed));
  }

  // Fire 2: backfill — NO new bytes added, but the prefix must now be read.
  // Pre-fix: this returned the SAME partial totals (backfill branch was dead).
  got = fire(home, 'PostToolUse', { transcript_path: tsPath });
  const totalFire2 = got && got.tokens && got.tokens.total;
  const fire2Full = totalFire2 && totalFire2.in === 20000 && totalFire2.out === 10000;
  if (fire2Full) {
    pass++;
    console.log('  PASS  §S.3 fire 2 backfill returns FULL total (in=20000, out=10000)');
  } else {
    fail++;
    console.log('  FAIL  §S.3 expected full 20000/10000, got ' + JSON.stringify(totalFire2));
  }

  // tailWarmed must be cleared so subsequent fires do plain incremental reads.
  let sc2 = null;
  try {
    sc2 = JSON.parse(fs.readFileSync(offsetP, 'utf8'));
  } catch {
    /* ignore */
  }
  if (sc2 && sc2.tailWarmed === false) {
    pass++;
    console.log('  PASS  §S.4 sidecar.tailWarmed=false after fire 2 backfill consumed');
  } else {
    fail++;
    console.log('  FAIL  §S.4 expected tailWarmed=false, got ' + JSON.stringify(sc2 && sc2.tailWarmed));
  }

  // Fire 3: still no new bytes, no backfill pending. Totals stay full and
  // the fire is a no-op read (offset === stat.size, no new bytes).
  got = fire(home, 'PostToolUse', { transcript_path: tsPath });
  const totalFire3 = got && got.tokens && got.tokens.total;
  if (totalFire3 && totalFire3.in === 20000 && totalFire3.out === 10000) {
    pass++;
    console.log('  PASS  §S.5 fire 3 (post-backfill steady state) preserves full total');
  } else {
    fail++;
    console.log('  FAIL  §S.5 expected 20000/10000, got ' + JSON.stringify(totalFire3));
  }

  // Fire 4 with new bytes appended: incremental read adds the new row's
  // tokens on top of the full backfilled baseline. This proves the post-
  // backfill steady state behaves as a normal incremental reader.
  const newRow = {
    type: 'assistant',
    isSidechain: false,
    timestamp: new Date(now + 1000).toISOString(),
    message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 7, output_tokens: 3 } },
  };
  fs.appendFileSync(tsPath, JSON.stringify(newRow) + '\n');
  got = fire(home, 'PostToolUse', { transcript_path: tsPath });
  const totalFire4 = got && got.tokens && got.tokens.total;
  if (totalFire4 && totalFire4.in === 20007 && totalFire4.out === 10003) {
    pass++;
    console.log('  PASS  §S.6 fire 4 incremental adds new row on full baseline (20007/10003)');
  } else {
    fail++;
    console.log('  FAIL  §S.6 expected 20007/10003, got ' + JSON.stringify(totalFire4));
  }
}

// --- §T. v0.2.5 high: MAIN-source size-shrink (CC compaction) no double-count -
//
// Build a transcript, fire PostToolUse (fire 1 totals = full original). Then
// REWRITE the transcript SMALLER (simulating CC compaction) with a subset of
// the original rows keeping their original timestamps. Pre-fix: the size-
// shrink reset srcView.{offset,lastTs,lastSize} but kept
// ctx.totals/buckets/perTurn, so the per-source ts dedup was neutralized
// (lastTs=0) and every retained compacted row was re-added on top of the
// pre-compaction totals → inflation by retained_fraction. Verified on a
// 5-row (500/250) transcript compacted to last-3 rows returning 800/400.
// Post-fix: MAIN size-shrink also resets totals/buckets/perTurn, mirroring
// forceFull.
{
  const home = newTempHome();
  const tsDir = path.join(home, '.claude', 'projects', 'compact-proj');
  fs.mkdirSync(tsDir, { recursive: true });
  const tsPath = path.join(tsDir, SID + '.jsonl');
  const now = Date.now();
  // 5 rows: in=100/out=50 each → total in=500/out=250.
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push({
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(now - (5 - i) * 60000).toISOString(),
      message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 100, output_tokens: 50 } },
    });
  }
  fs.writeFileSync(tsPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // Fire 1: full read → totals = 500/250.
  let got = fire(home, 'PostToolUse', { transcript_path: tsPath });
  const totalFire1 = got && got.tokens && got.tokens.total;
  if (totalFire1 && totalFire1.in === 500 && totalFire1.out === 250) {
    pass++;
    console.log('  PASS  §T.1 fire 1 reads all 5 rows (500/250)');
  } else {
    fail++;
    console.log('  FAIL  §T.1 expected 500/250, got ' + JSON.stringify(totalFire1));
  }

  // Rewrite the transcript SMALLER (last 3 rows only, original timestamps).
  // CC compaction: size goes from N to ~3/5·N; srcView.offset now exceeds
  // stat.size, triggering the size-shrink reset.
  const compacted = rows.slice(-3);
  fs.writeFileSync(tsPath, compacted.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // Fire 2: post-compaction. Pre-fix: totals = 500 + 300 = 800 (double-count).
  // Post-fix: totals = 300 (reset + re-read compacted content).
  got = fire(home, 'PostToolUse', { transcript_path: tsPath });
  const totalFire2 = got && got.tokens && got.tokens.total;
  if (totalFire2 && totalFire2.in === 300 && totalFire2.out === 150) {
    pass++;
    console.log('  PASS  §T.2 fire 2 post-compaction resets + reads compacted (300/150, no double-count)');
  } else {
    fail++;
    console.log('  FAIL  §T.2 expected 300/150, got ' + JSON.stringify(totalFire2));
  }

  // Fire 3 (no further changes): totals stable at the post-compaction value.
  // A second compaction-miscount would inflate again here.
  got = fire(home, 'PostToolUse', { transcript_path: tsPath });
  const totalFire3 = got && got.tokens && got.tokens.total;
  if (totalFire3 && totalFire3.in === 300 && totalFire3.out === 150) {
    pass++;
    console.log('  PASS  §T.3 fire 3 (steady state) holds compacted total (300/150)');
  } else {
    fail++;
    console.log('  FAIL  §T.3 expected 300/150, got ' + JSON.stringify(totalFire3));
  }
}

// --- §T.4 v0.2.5 round-2 regression: fold-then-MAIN-reset preserves subagent --
//
// Architecture round-2 NEW medium finding: foldBuckets pre-fix seeded merged
// buckets WITHOUT a `src` field, so progressive folding (>TOK_BUCKETS_MAX=1000)
// silently stripped `src`. The round-1 MAIN-reset preservation filter
// (`b.src && b.src !== 'main'`) then treated every folded bucket as
// src===undefined → falsy → filtered OUT, dropping ALL folded history on
// the next forceFull / size-shrink / corrupt-sidecar recovery. To exercise
// the bug we need the SUBAGENT data to be FOLDED (so its src gets stripped
// pre-fix); 1 main row + 1001 subagent rows triggers fold (ctx.buckets.length
// > 1000) and the subagent rows are the ones that get folded. Then a MAIN
// size-shrink reset exercises the filter. Pre-fix the filter drops every
// folded subagent bucket (src=undefined → falsy) → 0 tokens after reset.
// Post-fix folded subagent buckets carry src='subagent' → kept.
{
  const home = newTempHome();
  const parentDir = path.join(home, '.claude', 'projects', 'fold-proj');
  const subDir = path.join(home, '.claude', 'projects', 'fold-sub');
  fs.mkdirSync(parentDir, { recursive: true });
  fs.mkdirSync(subDir, { recursive: true });
  const parentPath = path.join(parentDir, SID + '.jsonl');
  const subAgentHex = 'feedface';
  // Subagent transcript path uses an agentId-bearing basename so the writer
  // extracts the agentId from the basename (round-3: full basename).
  const subPath = path.join(subDir, 'agent-' + subAgentHex + '.jsonl');
  const installDir = path.join(home, '.claude', 'cc-status-dot');
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'token-rates.json'),
    JSON.stringify({ _default: null, 'glm-*': { in: 1, out: 5 } }),
  );
  const now = Date.now();
  // Plant 1 MAIN row (so ctx.buckets has src='main' contribution) + 1001
  // SUBAGENT rows (so fold runs on SubagentStop, exercising the bug path).
  // Subagent rows use 6min-apart timestamps so the 1h stage of fold actually
  // merges them (10 rows/hour → ~101 buckets after fold).
  const mainRows = [
    {
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(now - 60000).toISOString(),
      message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 3, output_tokens: 3 } },
    },
  ];
  fs.writeFileSync(parentPath, mainRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const subRows = [];
  for (let i = 0; i < 1001; i++) {
    subRows.push({
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(now - (1001 - i) * 6 * 60 * 1000).toISOString(),
      message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 1, output_tokens: 1 } },
    });
  }
  fs.writeFileSync(subPath, subRows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // Fire 1: load the 1 main row.
  let got = fire(home, 'PostToolUse', { transcript_path: parentPath });
  const totalFire1 = got && got.tokens && got.tokens.total;
  const okFire1 = totalFire1 && totalFire1.in === 3 && totalFire1.out === 3;
  if (okFire1) {
    pass++;
    console.log('  PASS  §T.4a fire 1 reads 1 main row (3/3)');
  } else {
    fail++;
    console.log('  FAIL  §T.4a expected 3/3, got ' + JSON.stringify(totalFire1));
  }

  // Fire 2: SubagentStop merges 1001 subagent rows. ctx.buckets.length becomes
  // 1 + 1001 = 1002 > TOK_BUCKETS_MAX (1000) → foldBuckets runs. Pre-fix the
  // folded subagent buckets lose `src`; post-fix they carry src='subagent'.
  got = fire(home, 'SubagentStop', { transcript_path: parentPath, agent_transcript_path: subPath });
  const totalFire2 = got && got.tokens && got.tokens.total;
  // 3 main + 1001 subagent × (1+1) = 3+1001 / 3+1001 = 1004 each side.
  const okFire2 = totalFire2 && totalFire2.in === 1004 && totalFire2.out === 1004;
  if (okFire2) {
    pass++;
    console.log('  PASS  §T.4b SubagentStop merges 1001 subagent rows + fold (1004/1004)');
  } else {
    fail++;
    console.log('  FAIL  §T.4b expected 1004/1004, got ' + JSON.stringify(totalFire2));
  }

  // Now REWRITE main transcript to a 1-byte stub. Empty file (size=0) bails
  // early in readTranscriptIncremental (line ~962 `stat.size <= 0 → return
  // null`) so the size-shrink branch is never reached. A 1-byte stub keeps
  // the path open and triggers MAIN size-shrink reset: filter ctx.buckets by
  // `b.src && b.src !== 'main'`, keeping only subagent-tagged buckets.
  //   - Pre-fix: folded buckets all have src=undefined → ALL filtered OUT
  //     (the round-2 bug) → totals=0/0 after reset (subagent data LOST).
  //   - Post-fix: folded buckets carry src='subagent' (pure-subagent fold
  //     keys) or 'mixed' (main+subagent same-window same-model collisions;
  //     the filter keeps 'mixed' too because the subagent preservation
  //     contract prioritizes "don't lose subagent data" over "drop every
  //     main byte on MAIN reset"). Either way the subagent tokens survive.
  //
  // The exact post-reset total depends on whether the main row's 1d fold
  // window happened to overlap with any subagent row's 1d fold window (rare
  // but possible — main at "now-60s" and subagent row 1 at "now-6min" both
  // fall in the same "today" 1d bucket → mixed bucket kept, total = 1004).
  // When the main row lands in a separate 1d window the main bucket is
  // 'main' (dropped) and the surviving pure-subagent total is 1001. Either
  // outcome satisfies the round-2 contract (subagent survives). The hard
  // gate is `total >= 1001` (subagent preservation); the pre-fix bug
  // produced 0/0.
  fs.writeFileSync(parentPath, '\n');
  got = fire(home, 'PostToolUse', { transcript_path: parentPath });
  const totalFire3 = got && got.tokens && got.tokens.total;
  // Accept 1001 (pure-subagent survival, main dropped) OR 1004 (main row
  // landed in a mixed fold bucket, kept too). Pre-fix would produce 0/0.
  const okFire3 =
    totalFire3 &&
    ((totalFire3.in === 1001 && totalFire3.out === 1001) || (totalFire3.in === 1004 && totalFire3.out === 1004));
  if (okFire3) {
    pass++;
    console.log(
      '  PASS  §T.4c MAIN-reset post-fold preserves folded subagent (' +
        totalFire3.in +
        '/' +
        totalFire3.out +
        ' survived — pre-fix would have been 0/0)',
    );
  } else {
    fail++;
    console.log(
      '  FAIL  §T.4c expected 1001/1001 or 1004/1004 (folded subagent survived MAIN reset), got ' +
        JSON.stringify(totalFire3) +
        ' — likely the round-2 fold-then-MAIN-reset dropped folded subagent data (architecture regression)',
    );
  }
}

// --- §U. v0.2.5 medium: SubagentStop / Stop preserve since in running -------
//
// The per-tab tooltip's 'Turn running: Xs' metric is Date.now() - tj.since.
// Refreshing since on every mid-turn SubagentStop / Stop-with-inflight would
// reset the timer to ~0s on every fire, hiding how long the turn has actually
// been active. Verify: UserPromptSubmit (turn start) sets since, then any
// number of SubagentStop / Stop-with-inflight events preserve it.
{
  const home = newTempHome();
  // Start the turn with UserPromptSubmit — sets since=now (T0).
  let got = fire(home, 'UserPromptSubmit');
  const sinceTurnStart = got && got.since;
  if (sinceTurnStart && typeof sinceTurnStart === 'number' && sinceTurnStart > 0) {
    pass++;
    console.log('  PASS  §U.1 UserPromptSubmit sets since=' + sinceTurnStart);
  } else {
    fail++;
    console.log('  FAIL  §U.1 expected since > 0, got ' + JSON.stringify(got && got.since));
  }

  // SubagentStop with background_tasks=[] (next=0): curState is 'running' so
  // preserveSince fires (staying in running). since must equal T0.
  got = fire(home, 'SubagentStop', { background_tasks: [] });
  if (got && got.since === sinceTurnStart) {
    pass++;
    console.log('  PASS  §U.2 SubagentStop (next=0, staying in running) preserves since');
  } else {
    fail++;
    console.log('  FAIL  §U.2 expected since=' + sinceTurnStart + ', got ' + JSON.stringify(got && got.since));
  }

  // SubagentStop with one inflight task (next=1): still staying in running
  // (state was 'running' and remains 'running'). since preserved.
  got = fire(home, 'SubagentStop', { background_tasks: [{ name: 'workflow-1' }] });
  if (got && got.state === 'running' && got.since === sinceTurnStart) {
    pass++;
    console.log('  PASS  §U.3 SubagentStop (next=1, staying in running) preserves since + state=running');
  } else {
    fail++;
    console.log('  FAIL  §U.3 expected state=running since=' + sinceTurnStart + ', got ' + JSON.stringify(got));
  }

  // Stop with one inflight task (workflow still running): stays 'running',
  // since preserved. The main turn's wall-clock time stays visible.
  got = fire(home, 'Stop', { background_tasks: [{ name: 'workflow-1' }] });
  if (got && got.state === 'running' && got.since === sinceTurnStart) {
    pass++;
    console.log('  PASS  §U.4 Stop with inflight>0 preserves since (workflow still running)');
  } else {
    fail++;
    console.log('  FAIL  §U.4 expected state=running since=' + sinceTurnStart + ', got ' + JSON.stringify(got));
  }

  // Stop with no background_tasks (clean done): genuine *→done transition.
  // since=now (new metric: time since the turn ended / done→idle countdown).
  const preStopSince = Date.now();
  got = fire(home, 'Stop', {});
  if (got && got.state === 'done' && got.since >= preStopSince) {
    pass++;
    console.log('  PASS  §U.5 Stop with inflight=0 transitions to done with since=now');
  } else {
    fail++;
    console.log('  FAIL  §U.5 expected state=done since>=now, got ' + JSON.stringify(got));
  }
}

// --- §V. v0.2.5 medium: SubagentStop uses FULL basename (no hex-substring collide) -
//
// Two subagent transcripts whose basenames share a hex run must NOT collide
// into the same ctx.subOffsets['sub:<key>'] slot. Round-2 fix removed the
// 8-char truncation but still keyed by the longest hex SUBSTRING of the
// basename; round-3 fix keys by the FULL basename (path.basename minus .jsonl)
// so even basenames that share the same hex run ('task_<hex>' vs
// 'worker_<hex>') get distinct slots. Pre-fix both map to sub:<hex> →
// collision. Post-fix each gets its own slot.
{
  const home = newTempHome();
  const tsDir = path.join(home, '.claude', 'projects', 'collision-proj');
  fs.mkdirSync(tsDir, { recursive: true });
  const parentPath = path.join(tsDir, SID + '.jsonl');
  // Two distinct subagent basenames. Round-2 (regex /([0-9a-fA-F]{8,})/.exec)
  // keys both to the longest hex run; round-3 keys by full basename. We pick
  // basenames that share NO hex-run overlap to verify the post-fix format
  // AND a pair that DOES share a hex run to verify the round-3 collision
  // class is eliminated. Both pairs must end up in distinct slots.
  // Pair A: distinct hex runs (round-2 safe).
  const subPath1 = path.join(tsDir, 'agent-deadbeefAAAA1111.jsonl');
  const subPath2 = path.join(tsDir, 'agent-deadbeefBBBB2222.jsonl');
  // Pair B (round-3 collision class): same hex run, different non-hex prefix.
  // Round-2 regex /([0-9a-fA-F]{8,})/ extracts 'deadbeefround3test' from BOTH
  // → both map to 'sub:deadbeefround3test' → collision. Round-3 (full
  // basename) maps them to 'sub:task-deadbeefround3test' vs
  // 'sub:worker-deadbeefround3test' → distinct.
  const subPath3 = path.join(tsDir, 'task-deadbeefround3test.jsonl');
  const subPath4 = path.join(tsDir, 'worker-deadbeefround3test.jsonl');
  const now = Date.now();
  // Minimal parent transcript (1 row, 0 tokens — keeps ctx.offset > 0 so
  // the size-shrink path would trigger for a smaller subagent file if a
  // collision happened to share the cursor across sources).
  const parentRow = {
    type: 'assistant',
    isSidechain: false,
    timestamp: new Date(now - 60000).toISOString(),
    message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 0, output_tokens: 0 } },
  };
  fs.writeFileSync(parentPath, JSON.stringify(parentRow) + '\n');
  // Four distinct subagent transcripts. Each has unique token amounts so we
  // can detect missing/merged contributions.
  const subRow1 = {
    type: 'assistant',
    isSidechain: false,
    timestamp: new Date(now - 50000).toISOString(),
    message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 100, output_tokens: 50 } },
  };
  const subRow2 = {
    type: 'assistant',
    isSidechain: false,
    timestamp: new Date(now - 40000).toISOString(),
    message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 200, output_tokens: 100 } },
  };
  const subRow3 = {
    type: 'assistant',
    isSidechain: false,
    timestamp: new Date(now - 30000).toISOString(),
    message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 1000, output_tokens: 500 } },
  };
  const subRow4 = {
    type: 'assistant',
    isSidechain: false,
    timestamp: new Date(now - 20000).toISOString(),
    message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 2000, output_tokens: 1000 } },
  };
  fs.writeFileSync(subPath1, JSON.stringify(subRow1) + '\n');
  fs.writeFileSync(subPath2, JSON.stringify(subRow2) + '\n');
  fs.writeFileSync(subPath3, JSON.stringify(subRow3) + '\n');
  fs.writeFileSync(subPath4, JSON.stringify(subRow4) + '\n');

  // Load parent first so ctx.offset is established.
  fire(home, 'PostToolUse', { transcript_path: parentPath });

  // Fire SubagentStop for subagent 1.
  let got = fire(home, 'SubagentStop', {
    transcript_path: parentPath,
    agent_transcript_path: subPath1,
  });
  const totalAfter1 = got && got.tokens && got.tokens.total;
  if (totalAfter1 && totalAfter1.in === 100 && totalAfter1.out === 50) {
    pass++;
    console.log('  PASS  §V.1 SubagentStop #1 (deadbeefAAAA1111) → 100/50 attributed');
  } else {
    fail++;
    console.log('  FAIL  §V.1 expected 100/50, got ' + JSON.stringify(totalAfter1));
  }

  // Fire SubagentStop for subagent 2 — pre-fix this would pick up sub1's
  // cursor and silently drop sub2's rows (collision). Post-fix both
  // contributions merge → 100+200 = 300, 50+100 = 150.
  got = fire(home, 'SubagentStop', {
    transcript_path: parentPath,
    agent_transcript_path: subPath2,
  });
  const totalAfter2 = got && got.tokens && got.tokens.total;
  if (totalAfter2 && totalAfter2.in === 300 && totalAfter2.out === 150) {
    pass++;
    console.log('  PASS  §V.2 SubagentStop #2 (deadbeefBBBB2222) → 300/150 (both merged, no collision)');
  } else {
    fail++;
    console.log('  FAIL  §V.2 expected 300/150, got ' + JSON.stringify(totalAfter2));
  }

  // Pair B (round-3 collision class): fire SubagentStop for sub3 and sub4.
  // Round-2 would have collided both into 'sub:deadbeefround3test'. Round-3
  // (full basename) keeps them distinct. sub3 → 1000/500. sub4 merges on top
  // → 300+2000=2300 in / 150+1000=1150 out.
  got = fire(home, 'SubagentStop', {
    transcript_path: parentPath,
    agent_transcript_path: subPath3,
  });
  const totalAfter3 = got && got.tokens && got.tokens.total;
  if (totalAfter3 && totalAfter3.in === 1300 && totalAfter3.out === 650) {
    pass++;
    console.log('  PASS  §V.3 SubagentStop #3 (task-deadbeefround3test) → 1300/650 attributed');
  } else {
    fail++;
    console.log('  FAIL  §V.3 expected 1300/650, got ' + JSON.stringify(totalAfter3));
  }
  got = fire(home, 'SubagentStop', {
    transcript_path: parentPath,
    agent_transcript_path: subPath4,
  });
  const totalAfter4 = got && got.tokens && got.tokens.total;
  if (totalAfter4 && totalAfter4.in === 3300 && totalAfter4.out === 1650) {
    pass++;
    console.log(
      '  PASS  §V.4 SubagentStop #4 (worker-deadbeefround3test) → 3300/1650 (round-3 collision class eliminated)',
    );
  } else {
    fail++;
    console.log('  FAIL  §V.4 expected 3300/1650, got ' + JSON.stringify(totalAfter4));
  }

  // Verify the sidecar has FOUR distinct sub-source cursors keyed by the
  // full basename — the proof that both the round-2 truncation AND the
  // round-3 hex-substring extraction are eliminated.
  const offsetP = path.join(home, '.claude', 'cc-tab-status', SID + '.offset');
  let sc = null;
  try {
    sc = JSON.parse(fs.readFileSync(offsetP, 'utf8'));
  } catch {
    /* ignore */
  }
  const subKeys = sc && sc.subOffsets ? Object.keys(sc.subOffsets) : [];
  const expected = [
    'sub:agent-deadbeefAAAA1111',
    'sub:agent-deadbeefBBBB2222',
    'sub:task-deadbeefround3test',
    'sub:worker-deadbeefround3test',
  ];
  const hasAll = expected.every((k) => subKeys.indexOf(k) >= 0);
  if (hasAll && subKeys.length === 4) {
    pass++;
    console.log('  PASS  §V.5 sidecar has 4 distinct full-basename sub cursors (round-3 collision class eliminated)');
  } else {
    fail++;
    console.log(
      '  FAIL  §V.5 expected 4 full-basename sub keys ' + JSON.stringify(expected) + ', got ' + JSON.stringify(subKeys),
    );
  }
}

// --- §W. v0.2.5 medium: StopFailure honors inflight payload (symmetric Stop) -
//
// Stop treats payload.background_tasks as authoritative. StopFailure
// previously ignored the payload and wrote `activeSubagents: a` (cur —
// possibly drifted), an asymmetry with the sibling Stop case. The reader
// doesn't currently consult this field, but removing the asymmetry
// eliminates a latent drift-freeze for the 24h interrupted-retention window.
{
  const home = newTempHome();
  // Plant a running state with activeSubagents=0.
  let got = fire(home, 'UserPromptSubmit');
  if (got && got.state === 'running' && got.activeSubagents === 0) {
    pass++;
    console.log('  PASS  §W.1 UserPromptSubmit → running, activeSubagents=0');
  } else {
    fail++;
    console.log('  FAIL  §W.1 expected running/0, got ' + JSON.stringify(got));
  }
  // StopFailure with background_tasks=[X, Y] — payload says 2 in-flight.
  // Pre-fix: wrote a=0 (cur, ignoring payload). Post-fix: writes 2.
  got = fire(home, 'StopFailure', {
    error: 'rate_limit',
    background_tasks: [{ name: 'workflow-1' }, { name: 'workflow-2' }],
  });
  if (
    got &&
    got.state === 'interrupted' &&
    got.activeSubagents === 2 &&
    got.error === 'rate_limit' &&
    got.pending === false
  ) {
    pass++;
    console.log('  PASS  §W.2 StopFailure honors inflight payload (activeSubagents=2, not cur=0)');
  } else {
    fail++;
    console.log('  FAIL  §W.2 expected interrupted/2/rate_limit/pending=false, got ' + JSON.stringify(got));
  }
}

// --- §X. v0.2.5 medium: readStdin timeout unblocks NEVER-block-CC contract ---
//
// CC_STATUS_STDIN_TIMEOUT_MS override + a deliberately hung stdin (spawn
// with stdio:[pipe,...] but never write/close). Pre-fix the child would
// hang indefinitely, violating the file-level "NEVER block or break CC"
// contract. Post-fix the child self-terminates within ~override ms and
// exits 0 silently (same path as empty stdin).
//
// We use a 200ms override via env so the test runs fast; production default
// is 5000ms. Uses spawn (not spawnSync) so we can measure wall-clock exit
// time and hold stdin open ourselves.
{
  const home = newTempHome();
  const child = spawn(process.execPath, [SCRIPT], {
    env: Object.assign({}, process.env, {
      HOME: home,
      USERPROFILE: home,
      CC_STATUS_STDIN_TIMEOUT_MS: '200',
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // DELIBERATELY do NOT write to stdin nor close it — simulate a hung CC.
  let stderr = '';
  child.stdout.on('data', () => {}); // drain
  child.stderr.on('data', (c) => (stderr += c.toString()));
  const startMs = Date.now();
  let exited = false;
  let exitCode = null;
  let elapsedMs = 0;
  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
    elapsedMs = Date.now() - startMs;
  });
  // Wait up to 3s for the child to self-exit. Pre-fix this would time out.
  await new Promise((r) => setTimeout(r, 3000));
  // Force-kill if still alive (cleanup; pre-fix would land here).
  if (!exited) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  const okExit = exited && exitCode === 0;
  const okTimely = elapsedMs > 0 && elapsedMs < 1500; // 200ms timeout + jitter
  const okSilent = !stderr.trim();
  if (okExit && okTimely && okSilent) {
    pass++;
    console.log(
      '  PASS  §X.1 hung-stdin child self-exits 0 within ' +
        elapsedMs +
        'ms (timeout=' +
        (okTimely ? 'ok' : 'TOO SLOW') +
        ')',
    );
  } else {
    fail++;
    console.log(
      '  FAIL  §X.1 exited=' +
        exited +
        ' code=' +
        exitCode +
        ' elapsed=' +
        elapsedMs +
        'ms stderr=' +
        JSON.stringify(stderr.trim().slice(0, 120)),
    );
  }
}

// --- §Y. v0.2.4 round-3 HIGH: partial-tail row must not be permanently lost ---
//
// When CC flushes a row incrementally (the file's tail has no trailing '\n'
// yet on fire-1), the incremental reader must NOT advance srcView.offset all
// the way to stat.size. Pre-fix trace:
//   fire-1 reads [0..1000] where row_X is bytes [990..1010] and only
//   [990..1000] is on disk → row_X_incomp JSON.parse-fails → offset=1000.
//   fire-2 reads [1000..1100] = "lete\nrow_Y..." → "lete" fails JSON.parse,
//   row_X is never reassembled, permanently lost (silent under-count of
//   tokens/cost).
// Post-fix: srcView.offset advances only to just past the last '\n' in buf,
// so fire-2 re-reads the partial tail + new bytes → row_X parses once
// complete. The per-source ts dedup prevents double-counting rows that
// already parsed on fire-1.
{
  const home = newTempHome();
  const tsDir = path.join(home, '.claude', 'projects', 'partial-proj');
  fs.mkdirSync(tsDir, { recursive: true });
  const parentPath = path.join(tsDir, SID + '.jsonl');
  const now = Date.now();
  // Row A (complete on disk before fire-1, will parse on fire-1).
  const rowA = {
    type: 'assistant',
    isSidechain: false,
    timestamp: new Date(now - 60000).toISOString(),
    message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 100, output_tokens: 50 } },
  };
  fs.writeFileSync(parentPath, JSON.stringify(rowA) + '\n');
  // Fire 1: read row A.
  let got = fire(home, 'PostToolUse', { transcript_path: parentPath });
  const totalAfter1 = got && got.tokens && got.tokens.total;
  if (totalAfter1 && totalAfter1.in === 100 && totalAfter1.out === 50) {
    pass++;
    console.log('  PASS  §Y.1 fire 1 reads complete row A (100/50)');
  } else {
    fail++;
    console.log('  FAIL  §Y.1 expected 100/50, got ' + JSON.stringify(totalAfter1));
  }

  // Now append row B as a PARTIAL tail — no trailing '\n'. This simulates
  // CC mid-flush: the bytes are on disk but the row is not yet complete.
  // Use a 1-line partial that's clearly incomplete JSON.
  const partialB = JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: new Date(now - 50000).toISOString(),
    message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 200, output_tokens: 100 } },
  }).slice(0, -3); // chop off the closing brace + 1 quote — invalid JSON, partial flush
  fs.appendFileSync(parentPath, partialB);
  // Fire 2: should NOT parse the partial, should NOT advance offset past it.
  got = fire(home, 'PostToolUse', { transcript_path: parentPath });
  const totalAfter2 = got && got.tokens && got.tokens.total;
  if (totalAfter2 && totalAfter2.in === 100 && totalAfter2.out === 50) {
    pass++;
    console.log('  PASS  §Y.2 fire 2 sees partial tail, does NOT attribute it (still 100/50)');
  } else {
    fail++;
    console.log('  FAIL  §Y.2 expected 100/50 (partial tail not yet parseable), got ' + JSON.stringify(totalAfter2));
  }

  // Verify sidecar offset is held back: must be at the byte position just
  // past the last '\n' (= byte length of rowA + its '\n'), NOT at stat.size.
  // rowA + '\n' = the only complete bytes. The partial tail's bytes must
  // still be in the "to re-read" window.
  const sidecar = path.join(home, '.claude', 'cc-tab-status', SID + '.offset');
  let sidecarObj = null;
  try {
    sidecarObj = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  } catch {
    /* ignore */
  }
  const expectedOffset = Buffer.byteLength(JSON.stringify(rowA) + '\n', 'utf8');
  const fileSize = fs.statSync(parentPath).size;
  if (
    sidecarObj &&
    typeof sidecarObj.offset === 'number' &&
    sidecarObj.offset === expectedOffset &&
    sidecarObj.offset < fileSize
  ) {
    pass++;
    console.log(
      '  PASS  §Y.3 sidecar offset held back to ' +
        sidecarObj.offset +
        ' (past last \\n, < file size ' +
        fileSize +
        ') — partial tail will be re-read',
    );
  } else {
    fail++;
    console.log(
      '  FAIL  §Y.3 expected offset=' +
        expectedOffset +
        ' < fileSize=' +
        fileSize +
        ', got sidecar.offset=' +
        (sidecarObj && sidecarObj.offset) +
        ' (pre-fix bug: offset advanced to fileSize, partial row permanently lost)',
    );
  }

  // Now complete row B: rewrite the file with rowA + complete rowB + '\n'.
  // Fire 3 should re-read from offset (= just past rowA's '\n'), concat the
  // rest of rowB (now complete on disk), parse it, and merge → 100+200=300
  // in / 50+100=150 out. The ts dedup keeps rowA from double-counting.
  const rowB = {
    type: 'assistant',
    isSidechain: false,
    timestamp: new Date(now - 50000).toISOString(),
    message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 200, output_tokens: 100 } },
  };
  fs.writeFileSync(parentPath, JSON.stringify(rowA) + '\n' + JSON.stringify(rowB) + '\n');
  got = fire(home, 'PostToolUse', { transcript_path: parentPath });
  const totalAfter3 = got && got.tokens && got.tokens.total;
  if (totalAfter3 && totalAfter3.in === 300 && totalAfter3.out === 150) {
    pass++;
    console.log('  PASS  §Y.4 fire 3 re-reads partial tail + new bytes → row B parses (300/150, no permanent loss)');
  } else {
    fail++;
    console.log(
      '  FAIL  §Y.4 expected 300/150 (row B recovered), got ' +
        JSON.stringify(totalAfter3) +
        ' (pre-fix bug: row B permanently lost, expected 100/50)',
    );
  }
}

// --- §Z. v0.2.5 problem 3a: scanSubagentTranscripts picks up IN-FLIGHT
//     subagent transcripts at every TOK_EVENT (no SubagentStart contract
//     for agent_transcript_path — see docs/SUBAGENT-design.md §1.1). The
//     scan targets ONLY the current-CC nested layout
//     <parentDir>/<sid>/subagents/*.jsonl; legacy top-level layout is
//     intentionally NOT scanned (see scanSubagentTranscripts JSDoc).
{
  const home = newTempHome();
  const tsDir = path.join(home, '.claude', 'projects', 'scan-proj');
  const parentDir = path.join(tsDir, SID);
  fs.mkdirSync(parentDir, { recursive: true });
  const parentPath = path.join(parentDir, SID + '.jsonl');
  // Nested subagents dir: <parentDir>/<sid>/subagents/agent-*.jsonl
  const subAgentsDir = path.join(parentDir, SID, 'subagents');
  fs.mkdirSync(subAgentsDir, { recursive: true });
  const now = Date.now();
  // Parent transcript with 0 tokens (lets us attribute the entire total
  // to subagents — clean signal that the scan picked them up).
  const parentRow = {
    type: 'assistant',
    isSidechain: false,
    timestamp: new Date(now - 60000).toISOString(),
    message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 0, output_tokens: 0 } },
  };
  fs.writeFileSync(parentPath, JSON.stringify(parentRow) + '\n');
  // Two IN-FLIGHT subagent transcripts (no SubagentStop has fired yet —
  // this is the realistic "subagents still running" scenario).
  const subPath1 = path.join(subAgentsDir, 'agent-aaa111.jsonl');
  const subPath2 = path.join(subAgentsDir, 'agent-bbb222.jsonl');
  const subRow1 = {
    type: 'assistant',
    isSidechain: false,
    timestamp: new Date(now - 30000).toISOString(),
    message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 500, output_tokens: 250 } },
  };
  const subRow2 = {
    type: 'assistant',
    isSidechain: false,
    timestamp: new Date(now - 20000).toISOString(),
    message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 1000, output_tokens: 500 } },
  };
  fs.writeFileSync(subPath1, JSON.stringify(subRow1) + '\n');
  fs.writeFileSync(subPath2, JSON.stringify(subRow2) + '\n');

  // Fire ONE PostToolUse on the parent. Pre-fix (v0.2.4): subagents not
  // visible until their SubagentStop fires. Post-fix (v0.2.5): the scan
  // picks up BOTH subagents at the parent's PostToolUse → tokens = 1500
  // in / 750 out (sum of both subagents; parent contributes 0).
  const got = fire(home, 'PostToolUse', { transcript_path: parentPath });
  const total = got && got.tokens && got.tokens.total;
  if (total && total.in === 1500 && total.out === 750) {
    pass++;
    console.log('  PASS  §Z.1 PostToolUse scan picks up in-flight subagents (1500/750 attributed)');
  } else {
    fail++;
    console.log('  FAIL  §Z.1 expected 1500/750 (scan picks up in-flight subagents), got ' + JSON.stringify(total));
  }

  // Verify sidecar has 2 distinct sub cursors (per-source offset isolation
  // makes the scan idempotent with subsequent SubagentStop fires).
  const sidecar = path.join(home, '.claude', 'cc-tab-status', SID + '.offset');
  let sidecarObj = null;
  try {
    sidecarObj = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  } catch {
    /* ignore */
  }
  const subKeys = sidecarObj && sidecarObj.subOffsets ? Object.keys(sidecarObj.subOffsets) : [];
  const hasAAA = subKeys.indexOf('sub:agent-aaa111') >= 0;
  const hasBBB = subKeys.indexOf('sub:agent-bbb222') >= 0;
  if (hasAAA && hasBBB) {
    pass++;
    console.log('  PASS  §Z.2 sidecar has 2 distinct sub cursors (per-source offset isolation)');
  } else {
    fail++;
    console.log(
      '  FAIL  §Z.2 expected sub:agent-aaa111 + sub:agent-bbb222 in subOffsets, got ' + JSON.stringify(subKeys),
    );
  }

  // Idempotency: fire another PostToolUse (no new bytes in any subagent).
  // The per-source offset isolation must prevent double-counting — total
  // must still be 1500/750.
  const got2 = fire(home, 'PostToolUse', { transcript_path: parentPath });
  const total2 = got2 && got2.tokens && got2.tokens.total;
  if (total2 && total2.in === 1500 && total2.out === 750) {
    pass++;
    console.log('  PASS  §Z.3 re-fire without new bytes is idempotent (1500/750 unchanged)');
  } else {
    fail++;
    console.log('  FAIL  §Z.3 expected 1500/750 (idempotent rescan), got ' + JSON.stringify(total2));
  }

  // Incremental: append new bytes to agent-aaa111.jsonl. Fire another
  // PostToolUse — only the NEW bytes should be attributed.
  const newRowAAA = {
    type: 'assistant',
    isSidechain: false,
    timestamp: new Date(now - 10000).toISOString(),
    message: { role: 'assistant', model: 'glm-5.2', usage: { input_tokens: 200, output_tokens: 100 } },
  };
  fs.appendFileSync(subPath1, JSON.stringify(newRowAAA) + '\n');
  const got3 = fire(home, 'PostToolUse', { transcript_path: parentPath });
  const total3 = got3 && got3.tokens && got3.tokens.total;
  if (total3 && total3.in === 1700 && total3.out === 850) {
    pass++;
    console.log('  PASS  §Z.4 incremental scan picks up only new bytes (1700/850)');
  } else {
    fail++;
    console.log('  FAIL  §Z.4 expected 1700/850 (1500+200/750+100 incremental), got ' + JSON.stringify(total3));
  }

  // Robustness: empty subagents/ dir is a silent no-op (the common case
  // for sessions without subagents). Use a fresh sid.
  const home2 = newTempHome();
  const tsDir2 = path.join(home2, '.claude', 'projects', 'scan-proj2');
  const parentDir2 = path.join(tsDir2, SID);
  fs.mkdirSync(parentDir2, { recursive: true });
  const parentPath2 = path.join(parentDir2, SID + '.jsonl');
  fs.writeFileSync(parentPath2, JSON.stringify(parentRow) + '\n');
  // No subagents/ dir created — scan must silently no-op, not throw.
  let threw = false;
  try {
    fire(home2, 'PostToolUse', { transcript_path: parentPath2 });
  } catch {
    threw = true;
  }
  if (!threw) {
    pass++;
    console.log('  PASS  §Z.5 missing subagents/ dir is silent no-op (hook never throws)');
  } else {
    fail++;
    console.log('  FAIL  §Z.5 expected silent no-op for missing subagents/ dir');
  }
}

// --- summary --------------------------------------------------------------

// --- §AA v0.2.6 blue-via-content: Stop last_assistant_message → pending ---
// The Stop case now reads payload.last_assistant_message and, if it clearly
// awaits user input/decision/feedback (AWAIT_USER_RE match or short
// standalone question to user), writes pending:true instead of the
// historical pending:false. This extends the existing permission-blue
// (Notification → pending:true) to cover "Claude replied and is waiting on
// you" — the reader's per-tab tick renders blue (pending.svg) over green
// (done.svg) and the bottom SBI 🔵 counts it. Done/green logic is untouched
// when the message is neutral.
//
// Key invariants under test:
//  1. ZH idiom "等你测试反馈" → pending:true (user's primary luceo scenario)
//  2. ZH decision "你决定" / "你来选" → pending:true
//  3. EN idiom "let me know" / "please confirm" / "your call" → pending:true
//  4. Short standalone question "Should I proceed with the migration?"
//     → pending:true (fallback rule, <=60 chars + ?)
//  5. Neutral completion "已完成所有改动" / "Done. Shipped." → pending:false
//  6. Technical "等待加载完成" (no 你) → pending:false (specificity win)
//  7. LLM self-narration "我不确定该怎么做" → pending:false (no idiom match)
//  8. Missing field (old CC) → pending:false (typeof === 'string' guard)
//  9. stop_hook_active=true → pending:false (CC anti-loop gate, even with
//     keyword in message)
// 10. Code block stripped: ```letMeKnow``` inside fenced code → pending:false
// 11. Stuck-running (luceo): background_tasks drift + "等你测试反馈" →
//     state='running' AND pending=true (the bug-fix scenario)
// 12. stop_hook_active missing/false + keyword → pending:true (default path)

function checkPending(name, got, expectedPending, expectedState) {
  if (got === undefined) return;
  const gotPending = got ? got.pending === true : false;
  const gotState = got ? got.state : null;
  const ok = gotPending === expectedPending && (expectedState === undefined || gotState === expectedState);
  if (ok) {
    pass++;
    console.log(
      '  PASS  ' + name + '   -> pending=' + gotPending + (expectedState !== undefined ? ' state=' + gotState : ''),
    );
  } else {
    fail++;
    console.log(
      '  FAIL  ' +
        name +
        '   expected pending=' +
        expectedPending +
        (expectedState !== undefined ? ' state=' + expectedState : '') +
        ' got pending=' +
        gotPending +
        (expectedState !== undefined ? ' state=' + gotState : ''),
    );
  }
}

// §AA.1 ZH "等你测试反馈" → pending:true + state=done (user's luceo scenario)
checkPending(
  '§AA.1 Stop last_message contains "等你测试反馈" -> pending=true, state=done',
  fire(newTempHome(), 'Stop', { last_assistant_message: '已完成实现，等你测试反馈' }),
  true,
  'done',
);

// §AA.2 ZH decision "你决定" → pending:true
checkPending(
  '§AA.2 Stop last_message contains "下一步你决定" -> pending=true',
  fire(newTempHome(), 'Stop', { last_assistant_message: '改完了，下一步你决定' }),
  true,
);

// §AA.3 ZH "请确认" / "你来选" → pending:true
checkPending(
  '§AA.3 Stop last_message contains "请确认是否继续" -> pending=true',
  fire(newTempHome(), 'Stop', { last_assistant_message: '代码已改完，请确认是否继续' }),
  true,
);

// §AA.4 EN "let me know" → pending:true
checkPending(
  '§AA.4 Stop last_message contains "let me know" -> pending=true',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'Done. Let me know if you want tests added.' }),
  true,
);

// §AA.5 EN "please confirm" → pending:true
checkPending(
  '§AA.5 Stop last_message contains "please confirm" -> pending=true',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'Rebased onto main. Please confirm the branch.' }),
  true,
);

// §AA.6 EN "your call" → pending:true
checkPending(
  '§AA.6 Stop last_message contains "your call" -> pending=true',
  fire(newTempHome(), 'Stop', { last_assistant_message: "It's your call — ship now or wait for QA." }),
  true,
);

// §AA.7 short standalone question fallback → pending:true
checkPending(
  '§AA.7 Stop last_message short "?" ending -> pending=true (fallback)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'Should I proceed with the migration?' }),
  true,
);

// §AA.8 ZH short standalone "？" ending → pending:true
checkPending(
  '§AA.8 Stop last_message short "？" ending -> pending=true (fallback)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '需要现在执行吗？' }),
  true,
);

// §AA.9 NEUTRAL completion → pending:false (green logic untouched)
checkPending(
  '§AA.9 Stop neutral completion "已完成所有改动" -> pending=false',
  fire(newTempHome(), 'Stop', { last_assistant_message: '已完成所有改动并跑了测试，全绿。' }),
  false,
);

// §AA.10 EN neutral "Done. Shipped." → pending:false
checkPending(
  '§AA.10 Stop neutral "Done. Shipped." -> pending=false',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'Done. Shipped in commit abc123.' }),
  false,
);

// §AA.11 technical "等待加载完成" (no "你") → pending:false (specificity win)
checkPending(
  '§AA.11 Stop technical "等待加载完成" -> pending=false (no 你 marker)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '等待加载完成，然后退出。' }),
  false,
);

// §AA.12 LLM self-narration "我不确定该怎么做" → pending:false
checkPending(
  '§AA.12 Stop "我不确定该怎么做" -> pending=false (LLM self-narration)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '我不确定该怎么做，需要查文档。' }),
  false,
);

// §AA.13 missing last_assistant_message field (old CC) → pending:false
checkPending(
  '§AA.13 Stop with no last_assistant_message field -> pending=false (backward-compat)',
  fire(newTempHome(), 'Stop', {}),
  false,
);

// §AA.14 non-string last_assistant_message (defensive) → pending:false
checkPending(
  '§AA.14 Stop non-string last_assistant_message (12345) -> pending=false',
  fire(newTempHome(), 'Stop', { last_assistant_message: 12345 }),
  false,
);

// §AA.15 stop_hook_active=true → pending:false (CC anti-loop gate)
{
  const home = newTempHome();
  const final = fire(home, 'Stop', {
    stop_hook_active: true,
    last_assistant_message: '等你反馈再继续',
  });
  // Even with "等你" keyword, stop_hook_active=true MUST skip the pending
  // decision (CC's anti-loop gate: Stop hook firing on its own continuation
  // leaves an empty/stale message).
  checkPending('§AA.15 Stop stop_hook_active=true + keyword -> pending=false (anti-loop gate)', final, false);
}

// §AA.16 code block stripped: ```letMeKnow``` inside fenced code → pending:false
checkPending(
  '§AA.16 Stop fenced-code-block "letMeKnow" identifier stripped -> pending=false',
  fire(newTempHome(), 'Stop', {
    last_assistant_message: 'Example:\n```js\nconst letMeKnow = () => {};\n```\n完成。',
  }),
  false,
);

// §AA.17 inline code stripped: `letMeKnow` → pending:false
checkPending(
  '§AA.17 Stop inline-code `letMeKnow` stripped -> pending=false',
  fire(newTempHome(), 'Stop', {
    last_assistant_message: 'Use the `letMeKnow` helper. Done.',
  }),
  false,
);

// §AA.18 STUCK-RUNNING scenario (luceo): inflight>0 + "等你测试反馈" →
// state=running AND pending=true (the bug-fix scenario — pending overrides
// running-yellow at the reader).
{
  const home = newTempHome();
  const final = fire(home, 'Stop', {
    background_tasks: [{ id: 'w1', type: 'workflow' }],
    last_assistant_message: '实现完成，等你测试反馈。',
  });
  checkPending(
    '§AA.18 Stop stuck-running + last_message 等你 -> state=running AND pending=true (luceo)',
    final,
    true,
    'running',
  );
}

// §AA.19 cross-event: Stop writes pending:true, next UserPromptSubmit clears it
// (verifies pending is cleared when user actually replies — blue light turns
// green/yellow on the new turn, doesn't false-stick).
{
  const home = newTempHome();
  fire(home, 'Stop', { last_assistant_message: '等你测试反馈' });
  const before = readState(home);
  const beforePending = before && before.pending;
  const after = fire(home, 'UserPromptSubmit');
  const afterPending = after && after.pending;
  const ok = beforePending === true && afterPending === false;
  if (ok) {
    pass++;
    console.log('  PASS  §AA.19 Stop pending=true cleared by next UserPromptSubmit');
  } else {
    fail++;
    console.log(
      '  FAIL  §AA.19 expected pending true->false across Stop->UserPromptSubmit, got before=' +
        beforePending +
        ' after=' +
        afterPending,
    );
  }
}

// §AA.20 Notification still writes pending:true (regression — blue-via-content
// must not break the existing permission path).
checkPending(
  '§AA.20 Notification still writes pending=true (permission regression)',
  fire(newTempHome(), 'Notification'),
  true,
);

// §AA.21 StopFailure with last_message (error string) → pending:false (does
// NOT walk the Stop pending path; interrupted state preserved, error kept).
// Guards against a future refactor merging the StopFailure case into Stop.
checkPending(
  '§AA.21 StopFailure carries error string but -> pending=false, state=interrupted',
  fire(newTempHome(), 'StopFailure', {
    error: 'rate_limit',
    last_assistant_message: 'API Error: Rate limit reached',
  }),
  false,
  'interrupted',
);

// --- §AB v0.2.6 round-2: keyword-accuracy regression locks (HIGH/MEDIUM) ---
// The v0.2.6 round-1 list had three HIGH-severity ZH false-positive vectors
// and three MEDIUM EN/fallback vectors. Round-2 tightened the list (removed
// bare '你定' / '看你的' / '告诉我' / 'wait for you' / 'your input'; added
// user-direct forms like '你来定' / '听你的' / '告诉我你的'; added semantic
// anchor to the '?' fallback rule). These tests pin BOTH directions:
//   (a) the previously-firing false-positive strings now return pending:false;
//   (b) the new precision entries still return pending:true (no over-tighten).
// A future edit that re-added a bare 2-char "你X" form or dropped the
// fallback semantic anchor would fail one of these.

// §AB.1 HIGH: '你定' substring matched "你定义/你定制/你定位/你定期"
checkPending(
  '§AB.1 Stop "你定义的函数有问题" -> pending=false (你定 false+)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '你定义的函数有问题' }),
  false,
);
checkPending(
  '§AB.1b Stop "你定制了 UI 组件" -> pending=false (你定 false+)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '你定制了 UI 组件' }),
  false,
);
checkPending(
  '§AB.1c Stop "你定位到了问题" -> pending=false (你定 false+)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '你定位到了问题' }),
  false,
);

// §AB.2 HIGH: '看你的' substring matched "我看你的代码" (CC code-review)
checkPending(
  '§AB.2 Stop "我看你的代码发现 bug" -> pending=false (看你的 false+)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '我看你的代码发现 bug' }),
  false,
);
checkPending(
  '§AB.2b Stop "我看了你的 PR" -> pending=false (看你的 false+)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '我看了你的 PR，有几处建议' }),
  false,
);

// §AB.3 HIGH: '告诉我' substring matched past-tense/3rd-person
checkPending(
  '§AB.3 Stop "你昨天告诉我的接口名" -> pending=false (告诉我 past-tense)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '你昨天告诉我的接口名我用了' }),
  false,
);
checkPending(
  '§AB.3b Stop "文档告诉我" -> pending=false (告诉我 3rd-person)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '文档告诉我这个参数是可选的' }),
  false,
);
checkPending(
  '§AB.3c Stop "日志告诉我" -> pending=false (告诉我 3rd-person log)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '日志告诉我服务已启动' }),
  false,
);

// §AB.4 MEDIUM: 'wait for you' substring matched "wait for your input file"
checkPending(
  '§AB.4 Stop "wait for your input file" -> pending=false (wait for your X)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'I will wait for your input file to parse it.' }),
  false,
);

// §AB.5 MEDIUM: 'your input' substring matched "your input handler/validation"
checkPending(
  '§AB.5 Stop "updated your input handler" -> pending=false (your input + technical)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'I updated your input handler to validate the form.' }),
  false,
);
checkPending(
  '§AB.5b Stop "your input is invalid" -> pending=false (your input + technical)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'your input is invalid; please retry.' }),
  false,
);

// §AB.6 MEDIUM: fallback '?' rule matched rhetorical/informational questions
checkPending(
  '§AB.6 Stop "Why?" -> pending=false (rhetorical, no user anchor)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'Why?' }),
  false,
);
checkPending(
  '§AB.6b Stop "什么意思?" -> pending=false (info question, no user anchor)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '什么意思?' }),
  false,
);
checkPending(
  '§AB.6c Stop "效果如何?" -> pending=false (info question, no user anchor)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '效果如何?' }),
  false,
);
checkPending(
  '§AB.6d Stop "How does this work?" -> pending=false (info question, no user anchor)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'How does this work?' }),
  false,
);
checkPending(
  '§AB.6e Stop "What did the refactor break?" -> pending=false (info question, no user anchor)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'What did the refactor break?' }),
  false,
);
checkPending(
  '§AB.6f Stop "为什么这样设计?" -> pending_false (rhetorical, no user anchor)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '为什么这样设计?' }),
  false,
);

// §AB.7 VALID precision entries STILL fire (no over-tighten regression)
checkPending(
  '§AB.7 Stop "你来定吧" -> pending=true (你来定 — v0.2.6 round-2 added)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '这事你来定吧' }),
  true,
);
checkPending(
  '§AB.7b Stop "听你的" -> pending=true (听你的 — v0.2.6 round-2 added)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '都行，听你的' }),
  true,
);
checkPending(
  '§AB.7c Stop "你说呢" -> pending=true (你说呢 — v0.2.6 round-2 added)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '你说呢' }),
  true,
);
checkPending(
  '§AB.7d Stop "告诉我你的决定" -> pending=true (告诉我你的 — suffix-anchored)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '告诉我你的决定，我继续推进' }),
  true,
);
checkPending(
  '§AB.7e Stop "What do you think?" -> pending=true (EN round-2 added)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'What do you think?' }),
  true,
);
checkPending(
  '§AB.7f Stop "Over to you." -> pending=true (EN round-2 added)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'Over to you.' }),
  true,
);
checkPending(
  '§AB.7g Stop "wait for you to respond" -> pending=true (wait for you to — suffix-anchored)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'I will wait for you to respond before continuing.' }),
  true,
);

// --- §AC v0.2.6 round-3: EN substring-FP + ZH 您 + code-strip locks --------
// Round-2 closed the ZH substring-FP family (你定/看你的/告诉我) but the SAME
// FP class survived on the EN side: 'your call'→callback, 'waiting for
// you'→waiting for your X, 'over to you'→over to your team, 'you pick'→
// you picked, 'you decide'→you decided. Polite 您 form was also missing
// (false-negative for formal register). Code-strip missed CommonMark
// indented blocks and leaked nested-fence inner content.
// All entries migrated to AWAIT_USER_PHRASES_RE with \b / (?!X) anchors;
// escapeRe() helper now wraps AWAIT_USER_PHRASES so future phrases can
// safely include regex metachars ('?', '.') without silent corruption.

// §AC.1 HIGH: 'your call' substring matched 'your callback' / 'your callable'
checkPending(
  '§AC.1 Stop "updated your callback" -> pending=false (your call → callback HIGH)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'I updated your callback to handle the error.' }),
  false,
);
checkPending(
  '§AC.1b Stop "your callable interface" -> pending=false (your call → callable HIGH)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'The your callable interface needs an explicit thisArg.' }),
  false,
);
// §AC.2 HIGH: 'waiting for you' substring matched 'waiting for your X'
checkPending(
  '§AC.2 Stop "waiting for your input file" -> pending=false (waiting for you → your X HIGH)',
  fire(newTempHome(), 'Stop', {
    last_assistant_message: 'I am waiting for your input file to parse before proceeding.',
  }),
  false,
);
checkPending(
  '§AC.2b Stop "waiting for your review" -> pending=false (waiting for you → your X HIGH)',
  fire(newTempHome(), 'Stop', { last_assistant_message: "I'm waiting for your review on the PR." }),
  false,
);
// §AC.3 HIGH: 'over to you' substring matched 'over to your X'
checkPending(
  '§AC.3 Stop "hand this over to your team" -> pending=false (over to you → your X HIGH)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'I will hand this over to your team for review.' }),
  false,
);
checkPending(
  '§AC.3b Stop "pass over to your reviewer" -> pending=false (over to you → your X HIGH)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'I will pass over to your reviewer now.' }),
  false,
);
// §AC.4 MEDIUM: 'you pick' / 'you decide' matched past-tense 'picked' / 'decided'
checkPending(
  '§AC.4 Stop "option you picked earlier" -> pending=false (you pick → picked MEDIUM)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'I used the option you picked earlier.' }),
  false,
);
checkPending(
  '§AC.4b Stop "approach you decided on" -> pending=false (you decide → decided MEDIUM)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'The approach you decided on is shipped.' }),
  false,
);
// §AC.5 MEDIUM: polite 您 form absent from ZH list (false-negative for formal register)
checkPending(
  '§AC.5 Stop "等您决定" -> pending=true (等您 form MEDIUM)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '下一步等您决定。' }),
  true,
);
checkPending(
  '§AC.5b Stop "您来选吧" -> pending=true (您来选 MEDIUM)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '方案 A 和 B,您来选吧。' }),
  true,
);
checkPending(
  '§AC.5c Stop "您确认一下" -> pending=true (您确认 MEDIUM)',
  fire(newTempHome(), 'Stop', { last_assistant_message: '请您确认一下是否继续。' }),
  true,
);
// §AC.6 MEDIUM: CommonMark indented code block exposes // / # line-comment prose
checkPending(
  '§AC.6 Stop indented // let me know -> pending=false (indented block MEDIUM)',
  fire(newTempHome(), 'Stop', {
    last_assistant_message: 'Done.\n\n    // let me know if you want me to extend\n    return x;',
  }),
  false,
);
checkPending(
  '§AC.6b Stop tab-indented # please confirm -> pending=false (indented block MEDIUM)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'Done.\n\n\t# please confirm the deploy' }),
  false,
);
// §AC.7 MEDIUM: nested-fence (4-backtick outer wrapping 3-backtick inner)
checkPending(
  '§AC.7 Stop nested-fence 4-outer/3-inner -> pending=false (nested fence MEDIUM)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'Done.\n````md\nExample:\n```js\nplease confirm\n```\n````' }),
  false,
);
// §AC.8 VALID precision entries STILL fire (no over-tighten regression on round-3)
checkPending(
  '§AC.8 Stop "your call —" -> pending=true (valid your call HIGH)',
  fire(newTempHome(), 'Stop', { last_assistant_message: "It's your call — ship now or wait for QA." }),
  true,
);
checkPending(
  '§AC.8b Stop "waiting for you to respond" -> pending=true (valid waiting for you to HIGH)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'I am waiting for you to respond before continuing.' }),
  true,
);
checkPending(
  '§AC.8c Stop "Over to you." -> pending=true (valid over to you HIGH — pin no over-tighten)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'Over to you.' }),
  true,
);
checkPending(
  '§AC.8d Stop "You pick the option." -> pending=true (valid you pick MEDIUM)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'You pick the option, I will code it.' }),
  true,
);
checkPending(
  '§AC.8e Stop "You decide the next step." -> pending=true (valid you decide MEDIUM)',
  fire(newTempHome(), 'Stop', { last_assistant_message: 'You decide the next step.' }),
  true,
);

// --- §AD v0.2.7 Q1: tokens persist across SessionEnd -----------------------
//
// Pin the Q1 contract: SessionEnd no longer wipes token state. The cumulative
// .offset sidecar + the new <sid>.tokens.json snapshot both survive, so a
// VSCode restart (SessionEnd → SessionStart on the same sid) renders non-zero
// tokens IMMEDIATELY on the first IIFE tick (no 0-window). The §H.7/§H.8 tests
// above already pin the SessionEnd-no-unlink behavior end-to-end via the
// transcript-driven fire path. Here we add targeted assertions for the
// explicit "restart" sequence and the .tokens.json write-on-every-TOK_EVENT
// discipline (writes happen even on non-token events that carry forward
// cur.tokens, so the snapshot stays fresh across background events too).

// §AD.1 StopFailure does NOT write .tokens.json (no tokens field to snapshot).
// Background event → status.tokens carried forward from cur.tokens; if cur has
// no tokens (fresh session), status.tokens is undefined → no snapshot write.
// Asserts the `if (status.tokens && typeof status.tokens === 'object')` gate.
{
  const home = newTempHome();
  const got = fire(home, 'StopFailure', { error: 'rate_limit' });
  const tokensPath = path.join(home, '.claude', 'cc-tab-status', SID + '.tokens.json');
  const noSnap = !fs.existsSync(tokensPath);
  if (got && got.state === 'interrupted' && noSnap) {
    pass++;
    console.log('  PASS  §AD.1 StopFailure (no tokens field) does NOT write .tokens.json snapshot');
  } else {
    fail++;
    console.log(
      '  FAIL  §AD.1 expected interrupted + no .tokens.json, got state=' +
        (got && got.state) +
        ' snapExists=' +
        !noSnap,
    );
  }
}

// §AD.2 Restart sequence: write tokens via PostToolUse → SessionEnd → assert
// .tokens.json survives + carries correct cumulative totals. This is the
// "VSCode restart" simulation: SessionEnd is the LAST event CC fires on
// restart; SessionStart (which we don't simulate here because the hook ignores
// it — TOK_EVENTS excludes SessionStart) is the FIRST event of the resumed
// session, but the IIFE tick reads .tokens.json directly (no hook fire needed).
{
  const home = newTempHome();
  const tsDir = path.join(home, '.claude', 'projects', 'q1-restart-proj');
  fs.mkdirSync(tsDir, { recursive: true });
  const tsPath = path.join(tsDir, SID + '.jsonl');
  const now = Date.now();
  const row = {
    type: 'assistant',
    isSidechain: false,
    sessionId: SID,
    timestamp: new Date(now - 60000).toISOString(),
    message: {
      role: 'assistant',
      model: 'glm-5.2',
      usage: { input_tokens: 500, output_tokens: 250, cache_read_input_tokens: 50000, cache_creation_input_tokens: 0 },
    },
  };
  fs.writeFileSync(tsPath, JSON.stringify(row) + '\n');
  const before = fire(home, 'PostToolUse', { transcript_path: tsPath });
  const tokensPath = path.join(home, '.claude', 'cc-tab-status', SID + '.tokens.json');
  const snapBefore = fs.existsSync(tokensPath) ? JSON.parse(fs.readFileSync(tokensPath, 'utf8')) : null;
  // SessionEnd fires — pre-Q1 this would unlink BOTH .json AND .offset, losing
  // all cumulative state. Post-Q1 it unlinks ONLY .json (state carrier).
  fire(home, 'SessionEnd');
  const jsonGone = !fs.existsSync(stateFile(home));
  const offsetKept = fs.existsSync(path.join(home, '.claude', 'cc-tab-status', SID + '.offset'));
  const tokensKept = fs.existsSync(tokensPath);
  let snapAfter = null;
  try {
    snapAfter = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
  } catch {
    /* ignore — tokensKept will be false */
  }
  const ok =
    jsonGone &&
    offsetKept &&
    tokensKept &&
    snapBefore &&
    snapBefore.tokens &&
    snapBefore.tokens.total &&
    snapBefore.tokens.total.in === 500 &&
    snapAfter &&
    snapAfter.v === 1 &&
    snapAfter.sid === SID &&
    snapAfter.tokens &&
    snapAfter.tokens.total &&
    snapAfter.tokens.total.in === 500;
  if (ok) {
    pass++;
    console.log(
      '  PASS  §AD.2 SessionEnd preserves .offset + .tokens.json (cumulative=500/250/50000 survives restart)',
    );
  } else {
    fail++;
    console.log(
      '  FAIL  §AD.2 jsonGone=' +
        jsonGone +
        ' offsetKept=' +
        offsetKept +
        ' tokensKept=' +
        tokensKept +
        ' snapBefore.in=' +
        (snapBefore && snapBefore.tokens && snapBefore.tokens.total && snapBefore.tokens.total.in) +
        ' snapAfter.in=' +
        (snapAfter && snapAfter.tokens && snapAfter.tokens.total && snapAfter.tokens.total.in),
    );
  }
}

// §AD.3 GC sweep reaps .tokens.json + .offset past INTERRUPTED_RETENTION_MS
// (7d) but keeps them fresh. Plant a stale .tokens.json + .offset pair at 8d,
// fire UserPromptSubmit for a different sid, assert both are reaped. Pin the
// mtime-only GC contract (no .json presence check, which would falsely reap
// them immediately post-SessionEnd).
{
  const home = newTempHome();
  const dir = path.join(home, '.claude', 'cc-tab-status');
  fs.mkdirSync(dir, { recursive: true });
  const staleSid = 'stale-tokens-sid';
  const staleTokens = path.join(dir, staleSid + '.tokens.json');
  const staleOffset = path.join(dir, staleSid + '.offset');
  fs.writeFileSync(
    staleTokens,
    JSON.stringify({ v: 1, sid: staleSid, tokens: { total: { in: 1 } }, written_at: Date.now() }),
  );
  fs.writeFileSync(
    staleOffset,
    JSON.stringify({ offset: 0, lastTs: 0, lastSize: 0, totals: { in: 1 }, buckets: [], perTurn: [] }),
  );
  // Set mtime to 8d ago (> 7d cutoff → reap target).
  const staleAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(staleTokens, staleAt, staleAt);
  fs.utimesSync(staleOffset, staleAt, staleAt);
  // Also plant a FRESH pair (< 7d) to assert they survive.
  const freshSid = 'fresh-tokens-sid';
  const freshTokens = path.join(dir, freshSid + '.tokens.json');
  const freshOffset = path.join(dir, freshSid + '.offset');
  fs.writeFileSync(
    freshTokens,
    JSON.stringify({ v: 1, sid: freshSid, tokens: { total: { in: 2 } }, written_at: Date.now() }),
  );
  fs.writeFileSync(
    freshOffset,
    JSON.stringify({ offset: 0, lastTs: 0, lastSize: 0, totals: { in: 2 }, buckets: [], perTurn: [] }),
  );
  // Fire UserPromptSubmit for an unrelated sid — triggers GC.
  fireRaw(home, { hook_event_name: 'UserPromptSubmit', session_id: 'gc-trigger-sid', prompt: 'hi' });
  const staleReaped = !fs.existsSync(staleTokens) && !fs.existsSync(staleOffset);
  const freshKept = fs.existsSync(freshTokens) && fs.existsSync(freshOffset);
  if (staleReaped && freshKept) {
    pass++;
    console.log('  PASS  §AD.3 GC reaps stale (8d) .tokens.json + .offset, keeps fresh (Q1 mtime-only rule)');
  } else {
    fail++;
    console.log('  FAIL  §AD.3 staleReaped=' + staleReaped + ' freshKept=' + freshKept + ' (mtime-only GC contract)');
  }
}

// §AD.4 isTokens-order guard: a corrupt <sid>.tokens.json with NO v/sid/tokens
// fields would historically have been matched by isJson (it ends with .json)
// and parsed as a state file → no .state → fall through to prune. The isTokens
// check now fires FIRST, so the file goes through the pure-mtime branch and is
// KEPT if fresh (even though its content is non-state). This is the
// load-bearing pin on the isTokens/isJson ordering.
{
  const home = newTempHome();
  const dir = path.join(home, '.claude', 'cc-tab-status');
  fs.mkdirSync(dir, { recursive: true });
  const bogusSid = 'bogus-tokens-sid';
  // Write a .tokens.json with content that would parse as no-state under isJson.
  const bogusPath = path.join(dir, bogusSid + '.tokens.json');
  fs.writeFileSync(bogusPath, JSON.stringify({ foo: 'bar', not_a_state: true }));
  // Fire UserPromptSubmit for an unrelated sid (triggers GC). The bogus file is
  // fresh (< 7d) and must SURVIVE — mtime-only rule on the isTokens branch.
  fireRaw(home, { hook_event_name: 'UserPromptSubmit', session_id: 'gc-trigger-sid2', prompt: 'hi' });
  const survived = fs.existsSync(bogusPath);
  if (survived) {
    pass++;
    console.log('  PASS  §AD.4 <sid>.tokens.json survives GC even with non-state content (isTokens-before-isJson)');
  } else {
    fail++;
    console.log('  FAIL  §AD.4 expected bogus .tokens.json to survive GC (was reaped — isJson-order regression)');
  }
}

// --- §AE v0.2.7 Q2: interrupted sticky across Stop + SessionEnd -------------
//
// User report: "interrupted 红色自己消了" — three suspects identified:
//   (a) SessionEnd deletes <sid>.json (interrupted state lost)
//   (b) reader decay since>24h → idle (now extended to 7d, see INTERRUPTED_RETENTION_MS)
//   (c) CC's automatic Stop event overwrites interrupted → done
// All three fixed in cc-status.js. These tests pin the writer-side invariants.
// Reader-side decay behavior is exercised in test-iife.mjs (IIFE.37c).

// §AE.1 Stop after StopFailure PRESERVES interrupted (the core Q2c fix).
// Pre-Q2: `state: stayRunning ? 'running' : 'done'` overwrote interrupted.
// Post-Q2: cur.state===interrupted && !stayRunning → stay interrupted.
{
  const home = newTempHome();
  fire(home, 'UserPromptSubmit');
  fire(home, 'StopFailure', { error: 'rate_limit' });
  // StopFailure wrote state=interrupted. Now fire a Stop WITHOUT inflight —
  // this is the suspected "CC auto-fires Stop after StopFailure" path that
  // was clearing the red.
  const got = fire(home, 'Stop');
  const ok = got && got.state === 'interrupted' && got.error === 'rate_limit';
  if (ok) {
    pass++;
    console.log('  PASS  §AE.1 Stop after StopFailure preserves interrupted (Q2c sticky)');
  } else {
    fail++;
    console.log(
      '  FAIL  §AE.1 expected interrupted+error=rate_limit, got state=' +
        (got && got.state) +
        ' error=' +
        (got && got.error),
    );
  }
}

// §AE.2 Stop with inflight>0 after StopFailure → running (genuine workflow
// continuation un-blocks the turn; rare path but correct). This pins that the
// preserve-interrupted rule fires ONLY when !stayRunning.
{
  const home = newTempHome();
  fire(home, 'UserPromptSubmit');
  fire(home, 'StopFailure', { error: 'rate_limit' });
  const got = fire(home, 'Stop', { background_tasks: [{ id: 'w1', type: 'workflow' }] });
  const ok = got && got.state === 'running';
  if (ok) {
    pass++;
    console.log('  PASS  §AE.2 Stop inflight>0 after StopFailure → running (workflow un-blocks turn)');
  } else {
    fail++;
    console.log('  FAIL  §AE.2 expected running (inflight un-blocks interrupted), got state=' + (got && got.state));
  }
}

// §AE.3 UserPromptSubmit clears interrupted (correct — user is starting a new
// turn, the interrupted session is now continuing). This is the user-stated
// semantic: "持续到用户发新 prompt 会话继续".
{
  const home = newTempHome();
  fire(home, 'UserPromptSubmit');
  fire(home, 'StopFailure', { error: 'rate_limit' });
  const got = fire(home, 'UserPromptSubmit');
  const ok = got && got.state === 'running' && got.pending === false;
  if (ok) {
    pass++;
    console.log(
      '  PASS  §AE.3 UserPromptSubmit clears interrupted → running (sticky contract: user prompt clears red)',
    );
  } else {
    fail++;
    console.log(
      '  FAIL  §AE.3 expected running+pending=false, got state=' +
        (got && got.state) +
        ' pending=' +
        (got && got.pending),
    );
  }
}

// §AE.4 SessionEnd PRESERVES interrupted <sid>.json (Q2a fix). Pre-Q2:
// SessionEnd → DELETE → file removed → IIFE renders no red. Post-Q2: when
// cur.state===interrupted, SessionEnd returns null (no delete, no write).
{
  const home = newTempHome();
  fire(home, 'UserPromptSubmit');
  fire(home, 'StopFailure', { error: 'rate_limit' });
  // Snapshot the interrupted file's state for comparison after SessionEnd.
  const before = readState(home);
  const final = fire(home, 'SessionEnd');
  const after = readState(home);
  // `fire` returns readState() result; for SessionEnd-on-interrupted the hook
  // exits early (status===null) and leaves the file untouched, so `final`
  // and `after` read the SAME persisted interrupted state (deep-equal content,
  // not object identity — JSON.parse returns fresh objects each call).
  const ok =
    before &&
    before.state === 'interrupted' &&
    final &&
    final.state === 'interrupted' &&
    after &&
    after.state === 'interrupted' &&
    after.error === 'rate_limit';
  if (ok) {
    pass++;
    console.log('  PASS  §AE.4 SessionEnd preserves interrupted <sid>.json (Q2a sticky)');
  } else {
    fail++;
    console.log(
      '  FAIL  §AE.4 before=' +
        (before && before.state) +
        ' final=' +
        (final && final.state) +
        ' after=' +
        (after && after.state),
    );
  }
}

// §AE.5 SessionEnd STILL deletes non-interrupted states (regression guard:
// the Q2a fix only protects interrupted; done/running/pending still cleanup).
{
  const home = newTempHome();
  fire(home, 'UserPromptSubmit');
  fire(home, 'Stop'); // → done
  const before = readState(home);
  fire(home, 'SessionEnd');
  const after = readState(home);
  const ok = before && before.state === 'done' && after === null;
  if (ok) {
    pass++;
    console.log('  PASS  §AE.5 SessionEnd still deletes done state (regression: only interrupted is protected)');
  } else {
    fail++;
    console.log('  FAIL  §AE.5 expected done→deleted, got before=' + (before && before.state) + ' after=' + after);
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
