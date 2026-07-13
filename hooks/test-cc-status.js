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

// --- scenarios ------------------------------------------------------------

console.log('Phase-2 state machine integration tests');
console.log('(real hooks/cc-status.js, isolated HOME, method A counting path)\n');

// 1. Baseline: plain turn, no subagent -> done.
check(
  '1. UserPromptSubmit -> Stop = done (no subagent)',
  runSeq(['UserPromptSubmit', 'Stop']),
  'done'
);

// 2. CORE REQUIREMENT: workflow in flight -> Stop must NOT flip to done.
check(
  '2. UserPromptSubmit -> SubagentStart -> Stop = running [CORE]',
  runSeq(['UserPromptSubmit', 'SubagentStart', 'Stop']),
  'running'
);

// 3. Subagent finishes before Stop -> done. (Exposes the SubagentStop null-return bug.)
check(
  '3. UserPromptSubmit -> SubagentStart -> SubagentStop -> Stop = done',
  runSeq(['UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop']),
  'done'
);

// 4. Two subagents start, one stops, then Stop -> still running (1 in flight).
check(
  '4. 2xStart -> SubagentStop -> Stop = running (1 left)',
  runSeq(['UserPromptSubmit', 'SubagentStart', 'SubagentStart', 'SubagentStop', 'Stop']),
  'running'
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
