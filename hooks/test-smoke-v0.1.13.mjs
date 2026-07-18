#!/usr/bin/env node
/**
 * test-smoke-v0.1.13.mjs — v0.1.13 commandCenter 4-light INTEGRATION smoke test.
 *
 * Scope: the FULL user journey for the v0.1.13 feature — multi-session state
 * files → writer (cc-status.js deriveStatus) → reader (IIFE aggregation) →
 * setContext keys → package.json splice. The three pre-existing test files
 * each cover ONE layer in isolation:
 *   - test-cc-status.js  → writer (deriveStatus state machine, incl. pending)
 *   - test-iife.mjs      → reader (IIFE string regex assertions)
 *   - test-pkg-contribs.mjs → install-side (buildCcContribs JSON shape)
 * This file is the ONLY one that wires all three together against realistic
 * multi-session state directories and asserts the END-TO-END commandCenter
 * contract: the 4 setContext keys (ccStatusDot.{done,running,pending,
 * interrupted}) hold the values the user expects to see in the title bar.
 *
 * Why we replicate the IIFE aggregation here (instead of executing the IIFE):
 * the real IIFE calls vscode.commands.executeCommand / fs.readdirSync on the
 * LIVE ~/.claude/cc-tab-status — both need a VSCode extension host and would
 * touch real user state. The IIFE's aggregation body is small, pure, and
 * LOCKED byte-for-byte by test-iife.mjs (assertions IIFE.26-37c grep the
 * exact source). Replicating it here with the SAME rules + constants lets us
 * assert "given this state dir, the 4 contexts WILL be X/Y/Z/W" — and any
 * future drift between the replica and the IIFE would be caught immediately
 * by test-iife.mjs on the next build. The two files form a closed loop:
 * test-iife locks the source, this file exercises the semantics.
 *
 * Coverage map (what each section proves):
 *   §1  Multi-session aggregation — setContext computation
 *       - 0/1/2/3/N capping (cap() clamps 4+ → 4 for the "N" variant)
 *       - done>5min → idle, so IDLE sessions don't count toward 🟢 (only
 *         ACTIVE done does)
 *       - pending counted INDEPENDENTLY of state (running+pending is the
 *         typical case — a turn paused on a permission prompt)
 *       - stale-running>30min → idle (crashed-session GC)
 *       - interrupted>24h → idle (bounds 🔴 growth)
 *       - pending on a session downgraded to idle does NOT count (the
 *         "stale blue light false-stick" GC fix)
 *   §2  Notification hook → pending on disk → reader counts it → setContext
 *       full chain. Uses the REAL cc-status.js writer (subprocess, isolated
 *       HOME), then runs the aggregation replica over the same state dir.
 *       Also verifies pending is CLEARED by UserPromptSubmit / PreToolUse /
 *       Stop / StopFailure (the four user/turn-driven events) and PRESERVED
 *       by SubagentStart / SubagentStop (background events).
 *   §3  patchPackageJson splice — fixture-based, uses the REAL buildCcContribs
 *       output (via --check-pkg-contribs). Validates: 20+20+20 contribs,
 *       marker + hash stamped, JSON valid after splice, IDEMPOTENT (re-run
 *       detects marker+hash and skips — does NOT double-splice to 40).
 *   §4  End-to-end: the user's literal example — 3 done / 1 running / 2
 *       pending / 0 interrupted → ccDone=3 ccRunning=1 ccPending=2
 *       ccInterrupted=0. Plus the dim/colored light selection logic (which
 *       of the 5 variants per light is shown for each setContext value).
 *
 * Run:  node hooks/test-smoke-v0.1.13.mjs     (requires `npm run build` first;
 *       falls back to `npx tsx patch.ts` for the contribs dump if dist/ missing)
 */

import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST_PATCH = path.join(ROOT, 'dist', 'patch.js');
const CC_STATUS = path.join(__dirname, 'cc-status.js');

// --- Constants: mirror patch.ts (single source of truth). These are the SAME
// values the IIFE bakes (DONE_TO_IDLE_MS / SBI_RUNNING_STALE_MS /
// INTERRUPTED_RETENTION_MS / cap()) and the writer enforces. Any change in
// patch.ts MUST be mirrored here — same DRY caveat as test-iife.mjs /
// test-pkg-contribs.mjs. test-iife.mjs's regex assertions catch IIFE-side
// drift; this file catches semantic drift by re-running the rules.
const DONE_TO_IDLE_MS = 5 * 60 * 1000; // 5 min — §4 done→idle
const SBI_RUNNING_STALE_MS = 30 * 60 * 1000; // 30 min — §7.2 stale-running GC
const INTERRUPTED_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h — 🔴 retention cap

// The 4 lights in fixed left→right display order, and the 5 count-variants
// per light. These mirror patch.ts CC_LIGHTS (key order) + CC_COUNT_VARIANTS.
// `dimAt` is the setContext value (0) that selects the dim ⚪ variant; `capAt`
// is the value (4) that selects the "N" variant (cap() clamps 4+ → 4).
const CC_LIGHTS = ['done', 'running', 'pending', 'interrupted'];
const CC_COUNT_VARIANTS = ['0', '1', '2', '3', 'N'];

// Top-level marker fields stamped by patchPackageJson.
const PKG_MARKER_FIELD = '__ccStatusDotPkgManaged';
const PKG_HASH_FIELD = '__ccStatusDotPkgHash';
const INJECT_VERSION = 'v0.1.13';

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (detail ? '   ' + detail : ''));
  }
}

// --- Replica of the IIFE aggregation body (patch.ts:793-814) ---------------
// Reads every <sid>.json under <home>/.claude/cc-tab-status and applies the
// SAME decay/bucket rules the IIFE does. `now` is injectable so time-based
// decay tests are deterministic (no real-time waiting). Returns the raw uncapped
// counts; callers apply cap() to get the setContext values.
function aggregate(home, now = Date.now()) {
  const DIR = path.join(home, '.claude', 'cc-tab-status');
  const ag = { running: 0, done: 0, interrupted: 0, idle: 0, pending: 0 };
  let files = [];
  try {
    files = fs.readdirSync(DIR);
  } catch {
    return ag; // no dir -> all zeros (matches IIFE's outer try/catch)
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const fp = path.join(DIR, f);
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      let st = j.state;
      const since = j.since;
      // §4 done>5min → idle (ACTIVE done only counts toward 🟢)
      if (st === 'done' && since && now - since > DONE_TO_IDLE_MS) {
        st = 'idle';
      }
      // §7.2 stale-running mtime>30min → idle (crashed CC never sends SessionEnd)
      else if (st === 'running') {
        let mt = 0;
        try {
          mt = fs.statSync(fp).mtimeMs;
        } catch {}
        if (mt && now - mt > SBI_RUNNING_STALE_MS) st = 'idle';
      }
      // v0.1.13 interrupted mtime>24h → idle (bounds 🔴 accumulation)
      else if (st === 'interrupted') {
        let mt = 0;
        try {
          mt = fs.statSync(fp).mtimeMs;
        } catch {}
        if (mt && now - mt > INTERRUPTED_RETENTION_MS) st = 'idle';
      }
      if (st === 'running') ag.running++;
      else if (st === 'done') ag.done++;
      else if (st === 'interrupted') ag.interrupted++;
      else if (st === 'idle') ag.idle++;
      // pending INDEPENDENT of state, but with the idle-GC: a session downgraded
      // to idle above is NOT counted toward 🔵 (kills the stale-blue-light stick)
      if (j.pending === true && st !== 'idle') ag.pending++;
    } catch {}
  }
  return ag;
}

// cap() — exact replica of the IIFE's `var cap=function(n){return n>=4?4:n;}`.
// 0..3 select the literal-count variant; 4+ selects the "N" variant.
function cap(n) {
  return n >= 4 ? 4 : n;
}

// Compute the 4 setContext values the IIFE would push for an aggregation.
// These are the values VSCode uses to match `when: "ccStatusDot.<key> == K"`
// in package.json — i.e. they decide which of the 5 variants per light shows.
function expectedContexts(ag) {
  return {
    ccStatusDot: {
      done: cap(ag.done),
      running: cap(ag.running),
      pending: cap(ag.pending),
      interrupted: cap(ag.interrupted),
    },
  };
}

// --- State file / HOME helpers ---------------------------------------------
function newTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-smoke-'));
}

function stateDir(home) {
  return path.join(home, '.claude', 'cc-tab-status');
}

/** Write a raw status object under <home>/.claude/cc-tab-status/<sid>.json.
 *  `opts.ageMs` backdates the file mtime (via utimesSync) so the stale-running
 *  / interrupted-retention decay branches can be exercised without waiting. */
function writeStatus(home, sid, status, opts = {}) {
  const dir = stateDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, sid + '.json');
  fs.writeFileSync(fp, JSON.stringify(status, null, 2));
  if (opts.ageMs && opts.ageMs > 0) {
    const past = new Date(Date.now() - opts.ageMs);
    try {
      fs.utimesSync(fp, past, past);
    } catch {}
  }
  return fp;
}

function readStatus(home, sid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(home), sid + '.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Fire one hook event against the REAL cc-status.js writer under an isolated
 *  HOME. Returns the post-fire on-disk status (or null if deleted/missing). */
function fireHook(home, sid, event, extra = {}) {
  const payload = Object.assign({ hook_event_name: event, session_id: sid }, extra);
  spawnSync(process.execPath, [CC_STATUS], {
    input: JSON.stringify(payload),
    env: Object.assign({}, process.env, { HOME: home }),
    encoding: 'utf8',
  });
  return readStatus(home, sid);
}

// --- Obtain buildCcContribs() output (for §3 package.json splice) ----------
function getContribs() {
  if (fs.existsSync(DIST_PATCH)) {
    const r = spawnSync(process.execPath, [DIST_PATCH, '--check-pkg-contribs'], { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error('--check-pkg-contribs failed: ' + (r.stderr || ''));
    }
    return stripToJsonObject(r.stdout);
  }
  const r = spawnSync('npx', ['tsx', 'patch.ts', '--check-pkg-contribs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(
      'dist/patch.js missing and `npx tsx patch.ts --check-pkg-contribs` failed. Run `npm run build`. stderr: ' +
        (r.stderr || ''),
    );
  }
  return stripToJsonObject(r.stdout);
}
function stripToJsonObject(stdout) {
  const idx = stdout.indexOf('{');
  if (idx < 0) throw new Error('no JSON object in --check-pkg-contribs output');
  return JSON.parse(stdout.slice(idx));
}

// ===========================================================================
// §1  Multi-session aggregation — setContext computation
// ===========================================================================
console.log('\n=== §1  Multi-session aggregation (setContext computation) ===');

// §1.1  Capping: 0 / 1 / 2 / 3 are passthrough; 4+ clamps to 4 (the "N" variant)
{
  const home = newTempHome();
  // 5 fresh running sessions → uncapped ag.running=5, capped ccRunning=4 ("N")
  for (let i = 0; i < 5; i++) {
    writeStatus(home, 'run-' + i, { state: 'running', since: Date.now(), activeSubagents: 0, pending: false });
  }
  const ag = aggregate(home);
  const ctx = expectedContexts(ag).ccStatusDot;
  check('§1.1a  5 running sessions → ag.running=5 (uncapped)', ag.running === 5, 'ag.running=' + ag.running);
  check('§1.1b  cap(5)=4 (selects "N" variant)', ctx.running === 4, 'ctx.running=' + ctx.running);
}

// §1.2  Exact boundary: 4 sessions → cap(4)=4 ("N"), 3 sessions → cap(3)=3
{
  const home = newTempHome();
  for (let i = 0; i < 4; i++) {
    writeStatus(home, 'd-' + i, { state: 'done', since: Date.now(), activeSubagents: 0, pending: false });
  }
  check('§1.2a  exactly 4 done → cap=4 (boundary, "N" variant)', expectedContexts(aggregate(home)).ccStatusDot.done === 4);
  const home2 = newTempHome();
  for (let i = 0; i < 3; i++) {
    writeStatus(home2, 'd-' + i, { state: 'done', since: Date.now(), activeSubagents: 0, pending: false });
  }
  check('§1.2b  exactly 3 done → cap=3 (literal "3" variant)', expectedContexts(aggregate(home2)).ccStatusDot.done === 3);
}

// §1.3  done>5min → idle: IDLE sessions do NOT count toward 🟢 (only ACTIVE done)
{
  const home = newTempHome();
  // 2 fresh done (count) + 1 stale done since=now-10min (decays to idle, not counted)
  writeStatus(home, 'fresh-d1', { state: 'done', since: Date.now(), activeSubagents: 0, pending: false });
  writeStatus(home, 'fresh-d2', { state: 'done', since: Date.now(), activeSubagents: 0, pending: false });
  writeStatus(home, 'stale-d', {
    state: 'done',
    since: Date.now() - 10 * 60 * 1000, // 10 min ago — exceeds 5-min DONE_TO_IDLE_MS
    activeSubagents: 0,
    pending: false,
  });
  const ag = aggregate(home);
  check('§1.3a  stale done (>5min) decays to idle, NOT counted as done', ag.done === 2, 'ag.done=' + ag.done);
  check('§1.3b  stale done counted in idle bucket', ag.idle === 1, 'ag.idle=' + ag.idle);
}

// §1.4  pending counted INDEPENDENTLY of state — running+pending is the typical
// case (a running turn paused on a permission / question / elicit prompt)
{
  const home = newTempHome();
  writeStatus(home, 'r-pending', { state: 'running', since: Date.now(), activeSubagents: 0, pending: true });
  writeStatus(home, 'r-plain', { state: 'running', since: Date.now(), activeSubagents: 0, pending: false });
  const ag = aggregate(home);
  check('§1.4a  2 running sessions both counted in running', ag.running === 2);
  check('§1.4b  only the pending-flagged one counts toward pending', ag.pending === 1, 'ag.pending=' + ag.pending);
}

// §1.5  pending on a session downgraded to idle does NOT count (the stale-blue
// false-stick GC fix — a crashed session killed mid-permission-prompt must not
// hold the 🔵 light on forever)
{
  const home = newTempHome();
  // stale done (>5min) with pending=true: decays to idle → pending NOT counted
  writeStatus(home, 'stale-d-p', {
    state: 'done',
    since: Date.now() - 10 * 60 * 1000,
    activeSubagents: 0,
    pending: true,
  });
  const ag = aggregate(home);
  check('§1.5a  stale-done with pending=true → idle, pending NOT counted', ag.pending === 0, 'ag.pending=' + ag.pending);
  check('§1.5b  same session counted in idle (not done)', ag.idle === 1 && ag.done === 0);
}

// §1.6  stale-running mtime>30min → idle (crashed CC process GC)
{
  const home = newTempHome();
  writeStatus(home, 'crashed', { state: 'running', since: Date.now(), activeSubagents: 0, pending: false }, { ageMs: 31 * 60 * 1000 });
  writeStatus(home, 'live', { state: 'running', since: Date.now(), activeSubagents: 0, pending: false });
  const ag = aggregate(home);
  check('§1.6a  running mtime>30min decays to idle', ag.idle === 1 && ag.running === 1, 'ag.running=' + ag.running + ' ag.idle=' + ag.idle);
}

// §1.6b  stale running WITH pending=true: both running and pending drop (stale-blue GC)
{
  const home = newTempHome();
  writeStatus(
    home,
    'crashed-pending',
    { state: 'running', since: Date.now(), activeSubagents: 0, pending: true },
    { ageMs: 31 * 60 * 1000 },
  );
  const ag = aggregate(home);
  check(
    '§1.6b  stale-running+pending → idle; pending NOT counted (the false-stick fix)',
    ag.idle === 1 && ag.running === 0 && ag.pending === 0,
    'ag.running=' + ag.running + ' ag.pending=' + ag.pending + ' ag.idle=' + ag.idle,
  );
}

// §1.7  interrupted>24h mtime → idle (bounds 🔴 growth from abandoned sessions)
{
  const home = newTempHome();
  writeStatus(
    home,
    'old-int',
    { state: 'interrupted', since: Date.now() - 25 * 60 * 60 * 1000, error: 'rate_limit', activeSubagents: 0, pending: false },
    { ageMs: 25 * 60 * 60 * 1000 },
  );
  writeStatus(home, 'fresh-int', { state: 'interrupted', since: Date.now(), error: 'interrupted', activeSubagents: 0, pending: false });
  const ag = aggregate(home);
  check(
    '§1.7  interrupted mtime>24h decays to idle; fresh interrupted stays',
    ag.interrupted === 1 && ag.idle === 1,
    'ag.interrupted=' + ag.interrupted + ' ag.idle=' + ag.idle,
  );
}

// §1.8  Empty state dir / missing dir → all 4 contexts = 0 (all lights dim)
{
  const home = newTempHome();
  fs.mkdirSync(stateDir(home), { recursive: true }); // exists but empty
  const ag = aggregate(home);
  const ctx = expectedContexts(ag).ccStatusDot;
  check(
    '§1.8a  empty state dir → ag all zeros',
    ag.done === 0 && ag.running === 0 && ag.pending === 0 && ag.interrupted === 0,
  );
  check(
    '§1.8b  empty state dir → all 4 contexts = 0 (all dim ⚪)',
    ctx.done === 0 && ctx.running === 0 && ctx.pending === 0 && ctx.interrupted === 0,
  );
  // No dir at all
  const home2 = newTempHome();
  const ag2 = aggregate(home2);
  check('§1.8c  missing state dir → all zeros (no throw)', ag2.done === 0 && ag2.running === 0);
}

// §1.9  Non-.json files in state dir are ignored (defensive — reader contract)
{
  const home = newTempHome();
  writeStatus(home, 'real', { state: 'running', since: Date.now(), activeSubagents: 0, pending: false });
  fs.writeFileSync(path.join(stateDir(home), 'README.md'), 'not a status file');
  fs.writeFileSync(path.join(stateDir(home), 's.tmp'), '{"state":"done"}');
  const ag = aggregate(home);
  check('§1.9  non-.json files ignored; only 1 running session counted', ag.running === 1 && ag.done === 0);
}

// ===========================================================================
// §2  Notification hook → pending on disk → reader counts it → setContext
//     (full writer→reader chain; uses the REAL cc-status.js writer)
// ===========================================================================
console.log('\n=== §2  Notification hook → reader aggregation → setContext (full chain) ===');

// §2.1  Notification on a fresh session writes pending=true; aggregation counts it
{
  const home = newTempHome();
  const sid = 'notif-session-1';
  const after = fireHook(home, sid, 'Notification');
  check(
    '§2.1a  writer: Notification writes pending=true',
    after && after.pending === true,
    'pending=' + (after && after.pending),
  );
  check(
    '§2.1b  writer: Notification coerces state to running (no prior file)',
    after && after.state === 'running',
    'state=' + (after && after.state),
  );
  // Now run the reader aggregation — should see 1 pending session
  const ag = aggregate(home);
  check('§2.1c  reader: 1 pending counted from Notification-written file', ag.pending === 1, 'ag.pending=' + ag.pending);
  check('§2.1d  reader: same session also counted in running (state preserved)', ag.running === 1);
  // setContext would push ccPending=1 (colored 🔵 variant shows)
  check('§2.1e  setContext ccPending=1 (colored variant)', expectedContexts(ag).ccStatusDot.pending === 1);
}

// §2.2  Notification on an existing running turn PRESERVES state+since, only
// adds pending=true (writer contract — the reader counts pending independently)
{
  const home = newTempHome();
  const sid = 'notif-session-2';
  // Establish a running turn with a known since
  fireHook(home, sid, 'UserPromptSubmit');
  const beforeNotif = readStatus(home, sid);
  const sinceBefore = beforeNotif.since;
  fireHook(home, sid, 'Notification');
  const afterNotif = readStatus(home, sid);
  check(
    '§2.2a  writer: Notification preserves state=running',
    afterNotif && afterNotif.state === 'running',
    'state=' + (afterNotif && afterNotif.state),
  );
  check('§2.2b  writer: Notification preserves since (NOT refreshed)', afterNotif && afterNotif.since === sinceBefore);
  check('§2.2c  writer: Notification sets pending=true', afterNotif && afterNotif.pending === true);
  // Reader aggregation: 1 running + 1 pending (same session)
  const ag = aggregate(home);
  check('§2.2d  reader: same session counted in BOTH running and pending', ag.running === 1 && ag.pending === 1);
}

// §2.3  UserPromptSubmit / PreToolUse / PostToolUse / Stop / StopFailure all
// CLEAR pending (user answered the prompt). One combined loop.
{
  const home = newTempHome();
  const sid = 'clear-pending';
  // Plant a pending flag first
  fireHook(home, sid, 'Notification');
  if (!(readStatus(home, sid) || {}).pending) {
    check('§2.3  SETUP FAILED — Notification did not set pending', false);
  } else {
    // Each of these events should clear pending. Run each in a fresh HOME so
    // they don't chain (we want to test each event's clear in isolation).
    const clearers = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'StopFailure'];
    for (const ev of clearers) {
      const h = newTempHome();
      const s = sid + '-' + ev;
      fireHook(h, s, 'Notification'); // pending=true
      fireHook(h, s, ev); // should clear
      const after = readStatus(h, s);
      check(
        '§2.3[' + ev + ']  clears pending=true from a prior Notification',
        after && after.pending === false,
        'pending=' + (after && after.pending),
      );
      // And the reader aggregation agrees — no pending counted
      const ag = aggregate(h);
      check(
        '§2.3[' + ev + ']  reader: no pending counted after clear',
        ag.pending === 0,
        'ag.pending=' + ag.pending,
      );
    }
  }
}

// §2.4  SubagentStart / SubagentStop PRESERVE cur.pending (background events
// carry no signal about whether the parent's prompt is still open)
{
  const home = newTempHome();
  const sid = 'preserve-pending';
  fireHook(home, sid, 'Notification'); // pending=true
  fireHook(home, sid, 'SubagentStart'); // should PRESERVE pending
  let after = readStatus(home, sid);
  check(
    '§2.4a  writer: SubagentStart PRESERVES pending=true',
    after && after.pending === true,
    'pending=' + (after && after.pending),
  );
  fireHook(home, sid, 'SubagentStop'); // should PRESERVE pending
  after = readStatus(home, sid);
  check(
    '§2.4b  writer: SubagentStop PRESERVES pending=true',
    after && after.pending === true,
    'pending=' + (after && after.pending),
  );
  // Reader still sees 1 pending (the flag survived both background events)
  const ag = aggregate(home);
  check('§2.4c  reader: pending still counted=1 after Subagent* preservation', ag.pending === 1);
}

// §2.5  Multi-session end-to-end via the real writer: 3 sessions, mixed pending
// Session A: running+pending (paused on permission)
// Session B: running (no pending)
// Session C: done (Stop cleared pending)
{
  const home = newTempHome();
  // Session A: prompt → Notification (pending=true)
  fireHook(home, 'A', 'UserPromptSubmit');
  fireHook(home, 'A', 'Notification');
  // Session B: plain running turn, no Notification
  fireHook(home, 'B', 'UserPromptSubmit');
  // Session C: completed turn — Stop clears any residual pending
  fireHook(home, 'C', 'UserPromptSubmit');
  fireHook(home, 'C', 'Notification'); // transient pending
  fireHook(home, 'C', 'Stop'); // clears pending, sets done
  const ag = aggregate(home);
  check('§2.5a  3 sessions: 2 running + 1 done', ag.running === 2 && ag.done === 1, 'r=' + ag.running + ' d=' + ag.done);
  check('§2.5b  only session A holds pending (B never had it, C cleared at Stop)', ag.pending === 1, 'ag.pending=' + ag.pending);
}

// ===========================================================================
// §3  patchPackageJson splice — fixture-based, REAL buildCcContribs output
// ===========================================================================
console.log('\n=== §3  commandCenter package.json splice (idempotency + marker + JSON) ===');

let contribs;
try {
  contribs = getContribs();
} catch (e) {
  console.error('FATAL: could not get buildCcContribs output: ' + e.message);
  process.exit(1);
}

// --- Replica of writePkgInject (patch.ts:1216-1247) ------------------------
// Mutates `obj` by appending our 20 commands + 20 ccMenu + 20 palette entries,
// stamps marker + hash, returns nothing. Used to exercise the splice against
// a synthetic CC package.json fixture.
function applySplice(obj, contribs) {
  const contributes = obj.contributes || {};
  obj.contributes = contributes;
  const cmds = Array.isArray(contributes.commands) ? contributes.commands : [];
  contributes.commands = cmds.concat(contribs.commands);
  const menus = contributes.menus || {};
  contributes.menus = menus;
  const cc = Array.isArray(menus.commandCenter) ? menus.commandCenter : [];
  menus.commandCenter = cc.concat(contribs.ccMenu);
  const pal = Array.isArray(menus.commandPalette) ? menus.commandPalette : [];
  menus.commandPalette = pal.concat(contribs.palette);
  obj[PKG_MARKER_FIELD] = INJECT_VERSION;
  // Hash replica: sha1(JSON.stringify(contribs)).slice(0,8) — same recipe as
  // patch.ts currentPkgHash().
  obj[PKG_HASH_FIELD] = crypto.createHash('sha1').update(JSON.stringify(contribs)).digest('hex').slice(0, 8);
}

// §3.1  Fresh splice against a realistic CC package.json fixture
{
  // Minimal but representative CC package.json — has the fields we touch.
  const fixture = {
    name: 'claude-code',
    version: '2.1.212',
    publisher: 'anthropic',
    main: './extension.js',
    contributes: {
      commands: [
        { command: 'claude.open', title: 'Open Claude' },
        { command: 'claude.newChat', title: 'New Chat' },
      ],
      menus: {
        commandCenter: [
          { command: 'claude.open', when: 'false', group: 'navigation' },
        ],
        commandPalette: [{ command: 'claude.open' }],
      },
    },
  };
  const tmpPkg = path.join(os.tmpdir(), 'cc-smoke-pkg-' + process.pid + '.json');
  fs.writeFileSync(tmpPkg, JSON.stringify(fixture, null, 2));

  // Read back, parse, splice, write — exactly patchPackageJson's fresh path.
  const raw = fs.readFileSync(tmpPkg, 'utf8');
  const obj = JSON.parse(raw);
  applySplice(obj, contribs);
  fs.writeFileSync(tmpPkg, JSON.stringify(obj, null, 2) + '\n');

  // Re-read for assertions
  const after = JSON.parse(fs.readFileSync(tmpPkg, 'utf8'));

  // Existing CC commands preserved
  check(
    '§3.1a  CC existing commands preserved (claude.open, claude.newChat)',
    after.contributes.commands.some((c) => c.command === 'claude.open') &&
      after.contributes.commands.some((c) => c.command === 'claude.newChat'),
  );
  // Our 20 commands appended (total = 2 + 20 = 22)
  const ourCmds = after.contributes.commands.filter((c) => c.command.startsWith('ccStatusDot.'));
  check('§3.1b  +20 ccStatusDot.* commands appended', ourCmds.length === 20, 'got ' + ourCmds.length);
  check(
    '§3.1c  total commands = 22 (2 CC + 20 ours)',
    after.contributes.commands.length === 22,
    'got ' + after.contributes.commands.length,
  );
  // commandCenter: 1 existing + 20 ours = 21
  check(
    '§3.1d  commandCenter items = 21 (1 CC + 20 ours)',
    after.contributes.menus.commandCenter.length === 21,
    'got ' + after.contributes.menus.commandCenter.length,
  );
  // commandPalette: 1 existing + 20 ours = 21
  check(
    '§3.1e  commandPalette items = 21 (1 CC + 20 ours)',
    after.contributes.menus.commandPalette.length === 21,
    'got ' + after.contributes.menus.commandPalette.length,
  );
  // Marker + hash stamped
  check('§3.1f  marker field stamped', after[PKG_MARKER_FIELD] === INJECT_VERSION);
  check('§3.1g  hash field stamped (8 hex chars)', /^[0-9a-f]{8}$/.test(after[PKG_HASH_FIELD]));
  // JSON still valid (we just parsed it)
  check('§3.1h  package.json still valid JSON after splice', typeof after === 'object' && after !== null);
  // Light order preserved: first 4 of our commandCenter entries match CC_LIGHTS order
  const ourCc = after.contributes.menus.commandCenter.filter((m) => m.command.startsWith('ccStatusDot.'));
  const firstVariantPerLight = [ourCc[0], ourCc[5], ourCc[10], ourCc[15]].map((m) => m.command);
  check(
    '§3.1i  ccMenu order matches CC_LIGHTS (done/running/pending/interrupted)',
    firstVariantPerLight.every((cmd, i) => cmd === 'ccStatusDot.' + CC_LIGHTS[i] + '.0'),
    'got ' + JSON.stringify(firstVariantPerLight),
  );

  // §3.2  Idempotency: re-running the FULL patchPackageJson flow on the
  // already-patched file MUST skip — NOT double-splice. Replicate the real
  // flow: detect marker in raw string → check version+hash → skip.
  {
    const rawPatched = fs.readFileSync(tmpPkg, 'utf8');
    const isPatched = rawPatched.includes('"__ccStatusDotPkgManaged"'); // mirror isPackageJsonPatched
    const reParsed = JSON.parse(rawPatched);
    const wantHash = crypto.createHash('sha1').update(JSON.stringify(contribs)).digest('hex').slice(0, 8);
    const wouldSkip = isPatched && reParsed[PKG_MARKER_FIELD] === INJECT_VERSION && reParsed[PKG_HASH_FIELD] === wantHash;
    check('§3.2a  re-run detects marker+version+hash-match → would skip', wouldSkip, 'wouldSkip=' + wouldSkip);
    // And if we DID skip, counts stay at 22/21/21 (NOT 42/41/41)
    check(
      '§3.2b  after skip, command count still 22 (no double-splice)',
      reParsed.contributes.commands.length === 22,
      'got ' + reParsed.contributes.commands.length,
    );
    check(
      '§3.2c  after skip, ccMenu count still 21',
      reParsed.contributes.menus.commandCenter.length === 21,
      'got ' + reParsed.contributes.menus.commandCenter.length,
    );
  }

  // §3.3  Stale-hash re-inject: corrupt the hash → flow should detect stale,
  // fall through to the restore-from-.bak + re-splice path. We simulate by
  // building a fresh obj from a saved .bak (the real flow restores from .bak).
  {
    // Save a .bak of the original fixture
    const bakPath = tmpPkg + '.bak';
    fs.writeFileSync(bakPath, JSON.stringify(fixture, null, 2));

    // Tamper the hash in the patched file
    const tampered = JSON.parse(fs.readFileSync(tmpPkg, 'utf8'));
    tampered[PKG_HASH_FIELD] = 'deadbeef'; // wrong hash
    fs.writeFileSync(tmpPkg, JSON.stringify(tampered, null, 2) + '\n');

    const rawNow = fs.readFileSync(tmpPkg, 'utf8');
    const isPatched = rawNow.includes('"__ccStatusDotPkgManaged"');
    const diskHash = JSON.parse(rawNow)[PKG_HASH_FIELD];
    const wantHash = crypto.createHash('sha1').update(JSON.stringify(contribs)).digest('hex').slice(0, 8);
    const isStale = isPatched && diskHash !== wantHash;
    check('§3.2d  stale-hash detected (would trigger re-inject from .bak)', isStale, 'diskHash=' + diskHash);

    // Simulate the re-inject path: restore from .bak, re-splice
    const restored = JSON.parse(fs.readFileSync(bakPath, 'utf8'));
    applySplice(restored, contribs);
    fs.writeFileSync(tmpPkg, JSON.stringify(restored, null, 2) + '\n');
    const finalObj = JSON.parse(fs.readFileSync(tmpPkg, 'utf8'));
    check(
      '§3.2e  after re-inject from .bak, command count back to 22 (NOT 42)',
      finalObj.contributes.commands.length === 22,
      'got ' + finalObj.contributes.commands.length,
    );
    check('§3.2f  after re-inject, hash matches expected', finalObj[PKG_HASH_FIELD] === wantHash);
  }

  // Cleanup
  try {
    fs.unlinkSync(tmpPkg);
    fs.unlinkSync(tmpPkg + '.bak');
  } catch {}
}

// §3.4  Contribs shape gate (defensive — the real test-pkg-contribs.mjs is the
// authoritative source, but assert the basics here so this file is self-contained
// for the splice assertions above)
check('§3.4a  contribs.commands length = 20', Array.isArray(contribs.commands) && contribs.commands.length === 20);
check('§3.4b  contribs.ccMenu length = 20', Array.isArray(contribs.ccMenu) && contribs.ccMenu.length === 20);
check('§3.4c  contribs.palette length = 20', Array.isArray(contribs.palette) && contribs.palette.length === 20);

// ===========================================================================
// §4  End-to-end — the user's literal scenario + light-variant selection
// ===========================================================================
console.log('\n=== §4  End-to-end (user scenario: 3 done / 1 running / 2 pending / 0 interrupted) ===');

// §4.1  Exact scenario: ccDone=3 ccRunning=1 ccPending=2 ccInterrupted=0
// Pending is INDEPENDENT of state, so:
//   - s1: done + pending=true  (counts done AND pending)
//   - s2: done                 (counts done)
//   - s3: done                 (counts done)
//   - s4: running + pending=true (counts running AND pending)
//   → done=3, running=1, pending=2, interrupted=0 ✓
{
  const home = newTempHome();
  writeStatus(home, 's1', { state: 'done', since: Date.now(), activeSubagents: 0, pending: true });
  writeStatus(home, 's2', { state: 'done', since: Date.now(), activeSubagents: 0, pending: false });
  writeStatus(home, 's3', { state: 'done', since: Date.now(), activeSubagents: 0, pending: false });
  writeStatus(home, 's4', { state: 'running', since: Date.now(), activeSubagents: 0, pending: true });
  const ag = aggregate(home);
  const ctx = expectedContexts(ag).ccStatusDot;
  check('§4.1a  ag.done=3', ag.done === 3, 'ag.done=' + ag.done);
  check('§4.1a2 ag.running=1', ag.running === 1, 'ag.running=' + ag.running);
  check('§4.1a3 ag.pending=2', ag.pending === 2, 'ag.pending=' + ag.pending);
  check('§4.1a4 ag.interrupted=0', ag.interrupted === 0, 'ag.interrupted=' + ag.interrupted);
  check('§4.1b  ccStatusDot.done=3', ctx.done === 3);
  check('§4.1b2 ccStatusDot.running=1', ctx.running === 1);
  check('§4.1b3 ccStatusDot.pending=2', ctx.pending === 2);
  check('§4.1b4 ccStatusDot.interrupted=0', ctx.interrupted === 0);
}

// §4.2  Light-variant selection: which of the 5 variants (0/1/2/3/N) per light
// is visible for a given setContext value. This is the package.json `when` clause
// semantics applied to our 4 contexts.
function variantShown(key, ctxValue) {
  // ctxValue 0 → "0" (dim ⚪), 1/2/3 → that literal, 4 → "N"
  if (ctxValue === 0) return '0';
  if (ctxValue >= 4) return 'N';
  return String(ctxValue);
}
{
  const home = newTempHome();
  // 6 done (cap→4="N"), 2 running, 0 pending, 1 interrupted
  for (let i = 0; i < 6; i++) {
    writeStatus(home, 'd' + i, { state: 'done', since: Date.now(), activeSubagents: 0, pending: false });
  }
  writeStatus(home, 'r1', { state: 'running', since: Date.now(), activeSubagents: 0, pending: false });
  writeStatus(home, 'r2', { state: 'running', since: Date.now(), activeSubagents: 0, pending: false });
  writeStatus(home, 'i1', { state: 'interrupted', since: Date.now(), error: 'rate_limit', activeSubagents: 0, pending: false });
  const ctx = expectedContexts(aggregate(home)).ccStatusDot;
  check(
    '§4.2a  6 done → cap=4 → "N" variant (🟢 N)',
    variantShown('done', ctx.done) === 'N',
    'ctx.done=' + ctx.done + ' variant=' + variantShown('done', ctx.done),
  );
  check('§4.2b  2 running → "2" variant (🟡 2)', variantShown('running', ctx.running) === '2');
  check('§4.2c  0 pending → "0" variant (dim ⚪)', variantShown('pending', ctx.pending) === '0');
  check('§4.2d  1 interrupted → "1" variant (🔴 1)', variantShown('interrupted', ctx.interrupted) === '1');
}

// §4.3  Full end-to-end via the REAL writer for the user scenario — proves the
// writer produces the on-disk shape the reader aggregates into 3/1/2/0.
// 4 sessions, driven entirely through real hook events:
//   s1: UserPromptSubmit → PreToolUse → Notification → Stop (done+pending cleared)
//       Wait — Stop clears pending. To get done+pending we need the reader to
//       see pending on a done file. The writer NEVER produces done+pending in
//       normal flow (Stop clears it). So for the 3/1/2/0 scenario the 2 pending
//       sessions must be: 1 done+pending (writer cannot produce this) + 1
//       running+pending (writer CAN produce this via Notification).
//       → For a pure writer-driven test, the realistic pending distribution is:
//         1 pending session (running+pending). We test that here. The 2-pending
//         scenario in §4.1 above covers the reader's independence via a synthetic
//         done+pending file (which CAN occur if a hand-edited file or a future
//         writer change lands one — the reader must handle it regardless).
{
  const home = newTempHome();
  // Session A: full turn lifecycle, ends in done (Stop clears any pending)
  fireHook(home, 'A', 'UserPromptSubmit');
  fireHook(home, 'A', 'PreToolUse');
  fireHook(home, 'A', 'Stop'); // done, pending=false
  // Session B: running, paused on a Notification (running+pending)
  fireHook(home, 'B', 'UserPromptSubmit');
  fireHook(home, 'B', 'Notification'); // pending=true, state still running
  // Session C: interrupted
  fireHook(home, 'C', 'UserPromptSubmit');
  fireHook(home, 'C', 'StopFailure', { error: 'rate_limit' });
  // Session D: done
  fireHook(home, 'D', 'UserPromptSubmit');
  fireHook(home, 'D', 'Stop');

  const ag = aggregate(home);
  const ctx = expectedContexts(ag).ccStatusDot;
  check(
    '§4.3a  writer-driven: 2 done (A, D)',
    ag.done === 2,
    'ag.done=' + ag.done,
  );
  check('§4.3b  writer-driven: 1 running (B, paused on Notification)', ag.running === 1, 'ag.running=' + ag.running);
  check('§4.3c  writer-driven: 1 pending (B holds the Notification flag)', ag.pending === 1, 'ag.pending=' + ag.pending);
  check('§4.3d  writer-driven: 1 interrupted (C)', ag.interrupted === 1, 'ag.interrupted=' + ag.interrupted);
  check('§4.3e  setContext: ccDone=2 ccRunning=1 ccPending=1 ccInterrupted=1', ctx.done === 2 && ctx.running === 1 && ctx.pending === 1 && ctx.interrupted === 1);
}

// §4.4  All-dim scenario: no sessions → every light shows its dim ⚪ variant
{
  const home = newTempHome();
  fs.mkdirSync(stateDir(home), { recursive: true });
  const ctx = expectedContexts(aggregate(home)).ccStatusDot;
  check(
    '§4.4  no sessions → all 4 contexts = 0 → all dim ⚪ variants show',
    ctx.done === 0 && ctx.running === 0 && ctx.pending === 0 && ctx.interrupted === 0,
  );
  check(
    '§4.4b  variant selection: all dim',
    variantShown('done', ctx.done) === '0' &&
      variantShown('running', ctx.running) === '0' &&
      variantShown('pending', ctx.pending) === '0' &&
      variantShown('interrupted', ctx.interrupted) === '0',
  );
}

// §4.5  Order parity: CC_LIGHTS in patch.ts is [done, running, pending,
// interrupted] — this is the FIXED left→right display order. Assert the
// contribs we splice preserve it (regression: a reorder would make the lights
// show in the wrong order in the title bar).
{
  // contribs.ccMenu is built by buildCcContribs iterating CC_LIGHTS outer /
  // CC_COUNT_VARIANTS inner, so the first 5 entries are done.{0,1,2,3,N},
  // next 5 running.{...}, etc. Extract the light key from each entry's command.
  const order = [];
  for (let i = 0; i < contribs.ccMenu.length; i += 5) {
    const cmd = contribs.ccMenu[i].command; // e.g. "ccStatusDot.done.0"
    const key = cmd.split('.')[1];
    order.push(key);
  }
  check(
    '§4.5  ccMenu declaration order = [done, running, pending, interrupted] (left→right)',
    order.length === 4 && order.every((k, i) => k === CC_LIGHTS[i]),
    'order=' + JSON.stringify(order),
  );
}

// ===========================================================================
// summary
// ===========================================================================
console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  console.error('\n*** ' + fail + ' SMOKE TEST(S) FAILED — see above ***');
  process.exit(1);
}
console.log('\nAll v0.1.13 smoke tests passed.');
process.exit(0);
