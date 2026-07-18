#!/usr/bin/env node
/**
 * test-sbi-aggregation.mjs — v0.1.14 SBI aggregation INTEGRATION smoke test.
 *
 * Scope: the FULL user journey for the v0.1.14 SBI feature — multi-session
 * state files → writer (cc-status.js deriveStatus) → reader aggregation →
 * SBI.text (the user-visible bottom-bar string). The sibling test files each
 * cover ONE layer in isolation:
 *   - test-cc-status.js  → writer (deriveStatus state machine, incl. pending)
 *   - test-iife.mjs      → reader (IIFE source-text regex assertions)
 * This file is the ONLY one that EXECUTES the aggregation rules against
 * realistic multi-session state directories and asserts the END-TO-END SBI
 * text contract.
 *
 * Restoration note (e2e-test round-2 review): v0.1.13 shipped a sibling file
 * test-smoke-v0.1.13.mjs that did exactly this for the v0.1.13 commandCenter
 * surface (setContext keys). v0.1.14 deleted it ENTIRELY because §3 (package
 * json contribs splice) was v0.1.13-specific — but §1/§2/§4 covered
 * AGGREGATION BEHAVIOR that v0.1.14 PRESERVES (just feeding SBI.text instead
 * of setContext keys). With the deletion, the aggregation rules had ZERO
 * behavioral coverage: test-iife.mjs only does source-text regex over the
 * IIFE, which verifies the rules EXIST but not that they RUN CORRECTLY. This
 * file restores that behavioral coverage.
 *
 * Why we replicate the IIFE aggregation here (instead of executing the IIFE):
 * the real IIFE calls vscode.commands.executeCommand / fs.readdirSync on the
 * LIVE ~/.claude/cc-tab-status — both need a VSCode extension host and would
 * touch real user state. The IIFE's aggregation body is small, pure, and
 * LOCKED byte-for-byte by test-iife.mjs (assertions IIFE.27-37d grep the
 * exact source). Replicating it here with the SAME rules + constants lets us
 * assert "given this state dir, the SBI text WILL be X" — and any future
 * drift between the replica and the IIFE would be caught immediately by
 * test-iife.mjs on the next build. The two files form a closed loop:
 * test-iife locks the source, this file exercises the semantics.
 *
 * Coverage map (what each section proves):
 *   §1  Multi-session aggregation — SBI.text computation
 *       - 0/1/2/3/N capping (cap() clamps 4+ → 4 for the "N" variant)
 *       - done>5min → idle, so IDLE sessions don't count toward 🟢 (only
 *         ACTIVE done does)
 *       - pending counted INDEPENDENTLY of state (running+pending is the
 *         typical case — a turn paused on a permission prompt)
 *       - stale-running>30min → idle (crashed-session GC)
 *       - interrupted>24h → idle (bounds 🔴 growth)
 *       - pending on a session downgraded to idle does NOT count (the
 *         "stale blue light false-stick" GC fix) — this is the case
 *         test-iife.mjs IIFE.29b's ordering lock structurally mirrors
 *   §2  Notification hook → pending on disk → reader counts it → SBI.text
 *       full chain. Uses the REAL cc-status.js writer (subprocess, isolated
 *       HOME), then runs the aggregation replica over the same state dir.
 *       Also verifies pending is CLEARED by UserPromptSubmit / PreToolUse /
 *       PostToolUse / Stop / StopFailure (the five user/turn-driven events)
 *       and PRESERVED by SubagentStart / SubagentStop (background events).
 *   §4  End-to-end: the user's literal example — 3 done / 1 running / 2
 *       pending / 0 interrupted → SBI.text "🟢3 🟡1 🔵2 ⚪". Plus the
 *       dim/colored light selection logic per count.
 *
 * Run:  node hooks/test-sbi-aggregation.mjs
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CC_STATUS = path.join(__dirname, 'cc-status.js');

// --- Constants: mirror patch.ts (single source of truth). These are the SAME
// values the IIFE bakes (DONE_TO_IDLE_MS / SBI_RUNNING_STALE_MS /
// INTERRUPTED_RETENTION_MS / cap()) and the writer enforces. Any change in
// patch.ts MUST be mirrored here — same DRY caveat as test-iife.mjs. The
// IIFE's regex assertions catch IIFE-side drift; this file catches semantic
// drift by re-running the rules.
const DONE_TO_IDLE_MS = 5 * 60 * 1000; // 5 min — §4 done→idle
const SBI_RUNNING_STALE_MS = 30 * 60 * 1000; // 30 min — §7.2 stale-running GC
const INTERRUPTED_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h — 🔴 retention cap

// The 4 SBI lights in fixed left→right display order, plus the dim emoji.
// Mirror patch.ts SBI_LIGHTS (single source of truth). Order matches the IIFE's
// `var EM=[...]` array: done(🟢) / running(🟡) / pending(🔵) / interrupted(🔴),
// shared dim ⚪.
const SBI_LIGHT_EMOJI = ['\u{1F7E2}', '\u{1F7E1}', '\u{1F535}', '\u{1F534}']; // 🟢 🟡 🔵 🔴
const SBI_DIM_EMOJI = '\u{26AA}'; // ⚪

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

// --- Replica of the IIFE aggregation body (patch.ts buildIIFE) ---------------
// Reads every <sid>.json under <home>/.claude/cc-tab-status and applies the
// SAME decay/bucket rules the IIFE does. `now` is injectable so time-based
// decay tests are deterministic (no real-time waiting). Returns the raw
// uncapped counts; callers apply cap() + disp() to get the SBI.text value.
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
        } catch {
          /* keep mt=0 — won't decay */
        }
        if (mt && now - mt > SBI_RUNNING_STALE_MS) st = 'idle';
      }
      // v0.1.13/v0.1.14 interrupted mtime>24h → idle (bounds 🔴 accumulation)
      else if (st === 'interrupted') {
        let mt = 0;
        try {
          mt = fs.statSync(fp).mtimeMs;
        } catch {
          /* keep mt=0 */
        }
        if (mt && now - mt > INTERRUPTED_RETENTION_MS) st = 'idle';
      }
      if (st === 'running') ag.running++;
      else if (st === 'done') ag.done++;
      else if (st === 'interrupted') ag.interrupted++;
      // R3 review fix (M8/M9): catch-all idle bucket. Matches the IIFE's
      // 'else ag.idle++' — any unrecognized state (corrupt / hand-edited /
      // forward-incompatible) is treated as idle for state-bucketing, so it
      // is NOT silently dropped. This keeps the file's pending===true (if
      // any) from lighting 🔵 without any state light — the pending check
      // below sees st==="idle" and skips it too. (The replica's st variable
      // is let-typed so we can normalize it the same way here.)
      else ag.idle++;
      // pending INDEPENDENT of state, but with the idle-GC: a session downgraded
      // to idle above is NOT counted toward 🔵 (kills the stale-blue-light stick).
      // ORDER MATTERS: this check MUST run after the three decay branches above
      // (test-iife.mjs IIFE.29b locks the same ordering at the source level).
      if (j.pending === true && st !== 'idle') ag.pending++;
    } catch {
      /* per-file JSON error — skip */
    }
  }
  return ag;
}

// cap() — exact replica of the IIFE's `var cap=function(n){return n>=4?4:n;}`.
// 0..3 select the literal-count variant; 4+ selects the "N" variant.
function cap(n) {
  return n >= 4 ? 4 : n;
}

// disp() — exact replica of the IIFE's
//   `var disp=function(em,n){return n===0?DIM:(em+" "+(n>=4?"N":n));};`
// n===0 → dim ⚪ (no number); n=1/2/3 → colored emoji + " " + digit;
// n>=4 (capped to 4) → colored emoji + " N".
function disp(em, n) {
  return n === 0 ? SBI_DIM_EMOJI : em + ' ' + (n >= 4 ? 'N' : n);
}

// Compute the SBI.text the IIFE would push for an aggregation. This is the
// user-visible bottom-bar string ("🟢3 🟡1 🔵2 ⚪" style). Locks both the
// disp() form and the fixed left→right order done/running/pending/interrupted.
function expectedSbiText(ag) {
  const cd = cap(ag.done),
    cr = cap(ag.running),
    cp = cap(ag.pending),
    ci = cap(ag.interrupted);
  return (
    disp(SBI_LIGHT_EMOJI[0], cd) +
    ' ' +
    disp(SBI_LIGHT_EMOJI[1], cr) +
    ' ' +
    disp(SBI_LIGHT_EMOJI[2], cp) +
    ' ' +
    disp(SBI_LIGHT_EMOJI[3], ci)
  );
}

// --- State file / HOME helpers ---------------------------------------------
function newTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sbi-'));
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
    } catch {
      /* best-effort */
    }
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
 *  HOME. Returns the post-fire on-disk status (or null if deleted/missing).
 *  Sets BOTH HOME and USERPROFILE so os.homedir() resolves correctly under
 *  POSIX and Windows (test-cc-status.js shares this pattern). */
function fireHook(home, sid, event, extra = {}) {
  const payload = Object.assign({ hook_event_name: event, session_id: sid }, extra);
  spawnSync(process.execPath, [CC_STATUS], {
    input: JSON.stringify(payload),
    env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }),
    encoding: 'utf8',
  });
  return readStatus(home, sid);
}

// ===========================================================================
// §1  Multi-session aggregation — SBI.text computation
// ===========================================================================
console.log('SBI aggregation integration tests');
console.log('(real cc-status.js writer + replica IIFE aggregation, isolated HOME)\n');
console.log('=== §1  Multi-session aggregation (SBI.text computation) ===');

// §1.1  Capping: 0 / 1 / 2 / 3 are passthrough; 4+ clamps to 4 (the "N" variant)
{
  const home = newTempHome();
  // 5 fresh running sessions → uncapped ag.running=5, capped SBI shows "🟡 N"
  for (let i = 0; i < 5; i++) {
    writeStatus(home, 'run-' + i, { state: 'running', since: Date.now(), activeSubagents: 0, pending: false });
  }
  const ag = aggregate(home);
  const text = expectedSbiText(ag);
  check('§1.1a  5 running sessions → ag.running=5 (uncapped)', ag.running === 5, 'ag.running=' + ag.running);
  check(
    '§1.1b  cap(5)=4 → SBI shows "⚪ 🟡 N ⚪ ⚪"',
    text === SBI_DIM_EMOJI + ' ' + SBI_LIGHT_EMOJI[1] + ' N ' + SBI_DIM_EMOJI + ' ' + SBI_DIM_EMOJI,
    'text=' + text,
  );
}

// §1.2  Exact boundary: 4 sessions → cap(4)=4 ("N"), 3 sessions → cap(3)=3
{
  const home = newTempHome();
  for (let i = 0; i < 4; i++) {
    writeStatus(home, 'd-' + i, { state: 'done', since: Date.now(), activeSubagents: 0, pending: false });
  }
  check(
    '§1.2a  exactly 4 done → cap=4 (boundary, "N" variant) → SBI "🟢 N ⚪ ⚪ ⚪"',
    expectedSbiText(aggregate(home)) ===
      SBI_LIGHT_EMOJI[0] + ' N ' + SBI_DIM_EMOJI + ' ' + SBI_DIM_EMOJI + ' ' + SBI_DIM_EMOJI,
  );
  const home2 = newTempHome();
  for (let i = 0; i < 3; i++) {
    writeStatus(home2, 'd-' + i, { state: 'done', since: Date.now(), activeSubagents: 0, pending: false });
  }
  check(
    '§1.2b  exactly 3 done → cap=3 (literal "3" variant) → SBI "🟢 3 ⚪ ⚪ ⚪"',
    expectedSbiText(aggregate(home2)) ===
      SBI_LIGHT_EMOJI[0] + ' 3 ' + SBI_DIM_EMOJI + ' ' + SBI_DIM_EMOJI + ' ' + SBI_DIM_EMOJI,
  );
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
  check(
    '§1.3c  SBI shows "🟢 2 ⚪ ⚪ ⚪"',
    expectedSbiText(ag) === SBI_LIGHT_EMOJI[0] + ' 2 ' + SBI_DIM_EMOJI + ' ' + SBI_DIM_EMOJI + ' ' + SBI_DIM_EMOJI,
  );
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
// hold the 🔵 light on forever). This is the BEHAVIORAL assertion that
// test-iife.mjs IIFE.29b's source-level ordering lock structurally mirrors.
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
  check(
    '§1.5a  stale-done with pending=true → idle, pending NOT counted',
    ag.pending === 0,
    'ag.pending=' + ag.pending,
  );
  check('§1.5b  same session counted in idle (not done)', ag.idle === 1 && ag.done === 0);
  check(
    '§1.5c  SBI all dim ⚪ ⚪ ⚪ ⚪ (nothing counted; pending NOT lit)',
    expectedSbiText(ag) === [SBI_DIM_EMOJI, SBI_DIM_EMOJI, SBI_DIM_EMOJI, SBI_DIM_EMOJI].join(' '),
    'text=' + expectedSbiText(ag),
  );
}

// §1.6  stale-running mtime>30min → idle (crashed CC process GC)
{
  const home = newTempHome();
  writeStatus(
    home,
    'crashed',
    { state: 'running', since: Date.now(), activeSubagents: 0, pending: false },
    { ageMs: 31 * 60 * 1000 },
  );
  writeStatus(home, 'live', { state: 'running', since: Date.now(), activeSubagents: 0, pending: false });
  const ag = aggregate(home);
  check(
    '§1.6a  running mtime>30min decays to idle',
    ag.idle === 1 && ag.running === 1,
    'ag.running=' + ag.running + ' ag.idle=' + ag.idle,
  );
}

// §1.6a-decouple  R3 e2e-review fix: prove the running branch keys on MTIME
// (not since). Set since=31min-ago (OLD) but mtime=fresh (NOW). If a refactor
// incorrectly switched the branch to read since, this session would decay to
// idle — the assertion below would fail. Locks the mtime-not-since invariant
// the §7.2 doc comment warns about. Mirrors §1.3's existing since/decoupling.
{
  const home = newTempHome();
  writeStatus(home, 'old-since-fresh-mtime', {
    state: 'running',
    since: Date.now() - 31 * 60 * 1000, // OLD since
    activeSubagents: 0,
    pending: false,
  }); // NO ageMs → mtime is fresh (NOW)
  const ag = aggregate(home);
  check(
    '§1.6a-decouple  since=OLD, mtime=FRESH → STAYS running (mtime is the decay key, not since)',
    ag.running === 1 && ag.idle === 0,
    'ag.running=' + ag.running + ' ag.idle=' + ag.idle,
  );
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
// R3 e2e-review fix: the prior version set BOTH since and mtime to 25h-ago,
// so the test could not distinguish whether the interrupted branch keys on
// mtime or since. Now decoupled: since=fresh (NOW), mtime=25h-ago. If a
// refactor switched the branch to read since, this test would fail (since is
// fresh, no decay). Mirrors §1.6a-decouple above.
{
  const home = newTempHome();
  writeStatus(
    home,
    'old-int',
    {
      state: 'interrupted',
      since: Date.now(), // FRESH since (decoupled from mtime)
      error: 'rate_limit',
      activeSubagents: 0,
      pending: false,
    },
    { ageMs: 25 * 60 * 60 * 1000 }, // mtime = 25h ago
  );
  writeStatus(home, 'fresh-int', {
    state: 'interrupted',
    since: Date.now(),
    error: 'interrupted',
    activeSubagents: 0,
    pending: false,
  });
  const ag = aggregate(home);
  check(
    '§1.7  interrupted mtime>24h decays to idle; fresh interrupted stays',
    ag.interrupted === 1 && ag.idle === 1,
    'ag.interrupted=' + ag.interrupted + ' ag.idle=' + ag.idle,
  );
}

// §1.7-decouple  R3 e2e-review fix: prove the interrupted branch keys on
// MTIME (not since). Set since=25h-ago (OLD) but mtime=fresh (NOW). If a
// refactor incorrectly switched the branch to read since, this session would
// decay to idle — the assertion below would fail.
{
  const home = newTempHome();
  writeStatus(
    home,
    'old-since-fresh-mtime-int',
    {
      state: 'interrupted',
      since: Date.now() - 25 * 60 * 60 * 1000, // OLD since
      error: 'rate_limit',
      activeSubagents: 0,
      pending: false,
    }, // NO ageMs → mtime is fresh (NOW)
  );
  const ag = aggregate(home);
  check(
    '§1.7-decouple  since=OLD, mtime=FRESH → STAYS interrupted (mtime is the decay key, not since)',
    ag.interrupted === 1 && ag.idle === 0,
    'ag.interrupted=' + ag.interrupted + ' ag.idle=' + ag.idle,
  );
}

// §1.8  Empty state dir / missing dir → SBI shows all dim ⚪
{
  const home = newTempHome();
  fs.mkdirSync(stateDir(home), { recursive: true }); // exists but empty
  const ag = aggregate(home);
  const text = expectedSbiText(ag);
  check(
    '§1.8a  empty state dir → ag all zeros',
    ag.done === 0 && ag.running === 0 && ag.pending === 0 && ag.interrupted === 0,
  );
  check(
    '§1.8b  empty state dir → SBI all dim ⚪ ⚪ ⚪ ⚪',
    text === [SBI_DIM_EMOJI, SBI_DIM_EMOJI, SBI_DIM_EMOJI, SBI_DIM_EMOJI].join(' '),
    'text=' + text,
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
// §2  Notification hook → pending on disk → reader counts it → SBI.text
//     (full writer→reader chain; uses the REAL cc-status.js writer)
// ===========================================================================
console.log('\n=== §2  Notification hook → reader aggregation → SBI.text (full chain) ===');

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
  check(
    '§2.1c  reader: 1 pending counted from Notification-written file',
    ag.pending === 1,
    'ag.pending=' + ag.pending,
  );
  check('§2.1d  reader: same session also counted in running (state preserved)', ag.running === 1);
  // SBI shows "⚪ 🟡1 🔵1 ⚪" (running + pending, no done/interrupted)
  check(
    '§2.1e  SBI shows "⚪ 🟡1 🔵1 ⚪"',
    expectedSbiText(ag) ===
      SBI_DIM_EMOJI + ' ' + SBI_LIGHT_EMOJI[1] + ' 1 ' + SBI_LIGHT_EMOJI[2] + ' 1 ' + SBI_DIM_EMOJI,
    'text=' + expectedSbiText(ag),
  );
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
// CLEAR pending (user answered the prompt). One combined loop. Restores the
// 5-clearer coverage the deleted test-smoke-v0.1.13.mjs §2.3 had (test-cc-status
// only pins 3 of the 5 — PostToolUse and StopFailure are uncovered there).
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
      check('§2.3[' + ev + ']  reader: no pending counted after clear', ag.pending === 0, 'ag.pending=' + ag.pending);
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
  check(
    '§2.5a  3 sessions: 2 running + 1 done',
    ag.running === 2 && ag.done === 1,
    'r=' + ag.running + ' d=' + ag.done,
  );
  check(
    '§2.5b  only session A holds pending (B never had it, C cleared at Stop)',
    ag.pending === 1,
    'ag.pending=' + ag.pending,
  );
}

// ===========================================================================
// §4  End-to-end — the user's literal scenario + dim/colored light selection
// ===========================================================================
console.log('\n=== §4  End-to-end (user scenario: 3 done / 1 running / 2 pending / 0 interrupted) ===');

// §4.1  Exact scenario: SBI.text = "🟢3 🟡1 🔵2 ⚪"
// Pending is INDEPENDENT of state, so:
//   - s1: done + pending=true  (counts done AND pending)
//   - s2: done                 (counts done)
//   - s3: done                 (counts done)
//   - s4: running + pending=true (counts running AND pending)
//   → done=3, running=1, pending=2, interrupted=0 → "🟢3 🟡1 🔵2 ⚪"
{
  const home = newTempHome();
  writeStatus(home, 's1', { state: 'done', since: Date.now(), activeSubagents: 0, pending: true });
  writeStatus(home, 's2', { state: 'done', since: Date.now(), activeSubagents: 0, pending: false });
  writeStatus(home, 's3', { state: 'done', since: Date.now(), activeSubagents: 0, pending: false });
  writeStatus(home, 's4', { state: 'running', since: Date.now(), activeSubagents: 0, pending: true });
  const ag = aggregate(home);
  const text = expectedSbiText(ag);
  check('§4.1a  ag.done=3', ag.done === 3, 'ag.done=' + ag.done);
  check('§4.1a2 ag.running=1', ag.running === 1, 'ag.running=' + ag.running);
  check('§4.1a3 ag.pending=2', ag.pending === 2, 'ag.pending=' + ag.pending);
  check('§4.1a4 ag.interrupted=0', ag.interrupted === 0, 'ag.interrupted=' + ag.interrupted);
  check(
    '§4.1b  SBI.text = "🟢3 🟡1 🔵2 ⚪"',
    text === SBI_LIGHT_EMOJI[0] + ' 3 ' + SBI_LIGHT_EMOJI[1] + ' 1 ' + SBI_LIGHT_EMOJI[2] + ' 2 ' + SBI_DIM_EMOJI,
    'text=' + text,
  );
}

// §4.2  Light-variant selection: which count form each light takes for a given
// aggregation. dim ⚪ for 0, colored + " " + digit for 1/2/3, colored + " N"
// for 4+ (capped). This is the disp() rule applied to all 4 lights.
{
  const home = newTempHome();
  // 6 done (cap→4="N"), 2 running, 0 pending, 1 interrupted
  for (let i = 0; i < 6; i++) {
    writeStatus(home, 'd' + i, { state: 'done', since: Date.now(), activeSubagents: 0, pending: false });
  }
  writeStatus(home, 'r1', { state: 'running', since: Date.now(), activeSubagents: 0, pending: false });
  writeStatus(home, 'r2', { state: 'running', since: Date.now(), activeSubagents: 0, pending: false });
  writeStatus(home, 'i1', {
    state: 'interrupted',
    since: Date.now(),
    error: 'rate_limit',
    activeSubagents: 0,
    pending: false,
  });
  const text = expectedSbiText(aggregate(home));
  check(
    '§4.2  6 done + 2 running + 0 pending + 1 interrupted → "🟢 N 🟡 2 ⚪ 🔴 1"',
    text === SBI_LIGHT_EMOJI[0] + ' N ' + SBI_LIGHT_EMOJI[1] + ' 2 ' + SBI_DIM_EMOJI + ' ' + SBI_LIGHT_EMOJI[3] + ' 1',
    'text=' + text,
  );
}

// §4.3  Full end-to-end via the REAL writer for a mixed scenario — proves the
// writer produces the on-disk shape the reader aggregates correctly.
// 4 sessions, driven entirely through real hook events:
//   A: UserPromptSubmit → PreToolUse → Stop (done, pending=false)
//   B: UserPromptSubmit → Notification (running, pending=true)
//   C: UserPromptSubmit → StopFailure (interrupted)
//   D: UserPromptSubmit → Stop (done)
//   → 2 done, 1 running, 1 pending, 1 interrupted → "🟢2 🟡1 🔵1 🔴1"
{
  const home = newTempHome();
  fireHook(home, 'A', 'UserPromptSubmit');
  fireHook(home, 'A', 'PreToolUse');
  fireHook(home, 'A', 'Stop'); // done, pending=false
  fireHook(home, 'B', 'UserPromptSubmit');
  fireHook(home, 'B', 'Notification'); // running, pending=true
  fireHook(home, 'C', 'UserPromptSubmit');
  fireHook(home, 'C', 'StopFailure', { error: 'rate_limit' }); // interrupted
  fireHook(home, 'D', 'UserPromptSubmit');
  fireHook(home, 'D', 'Stop'); // done

  const ag = aggregate(home);
  const text = expectedSbiText(ag);
  check('§4.3a  writer-driven: 2 done (A, D)', ag.done === 2, 'ag.done=' + ag.done);
  check('§4.3b  writer-driven: 1 running (B, paused on Notification)', ag.running === 1, 'ag.running=' + ag.running);
  check(
    '§4.3c  writer-driven: 1 pending (B holds the Notification flag)',
    ag.pending === 1,
    'ag.pending=' + ag.pending,
  );
  check('§4.3d  writer-driven: 1 interrupted (C)', ag.interrupted === 1, 'ag.interrupted=' + ag.interrupted);
  check(
    '§4.3e  SBI.text = "🟢2 🟡1 🔵1 🔴1"',
    text ===
      SBI_LIGHT_EMOJI[0] + ' 2 ' + SBI_LIGHT_EMOJI[1] + ' 1 ' + SBI_LIGHT_EMOJI[2] + ' 1 ' + SBI_LIGHT_EMOJI[3] + ' 1',
    'text=' + text,
  );
}

// §4.4  All-dim scenario: no sessions → SBI shows all dim ⚪
{
  const home = newTempHome();
  fs.mkdirSync(stateDir(home), { recursive: true });
  const text = expectedSbiText(aggregate(home));
  check(
    '§4.4  no sessions → SBI all dim ⚪ ⚪ ⚪ ⚪',
    text === [SBI_DIM_EMOJI, SBI_DIM_EMOJI, SBI_DIM_EMOJI, SBI_DIM_EMOJI].join(' '),
    'text=' + text,
  );
}

// ===========================================================================
// summary
// ===========================================================================
console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  console.error('\n*** ' + fail + ' SBI AGGREGATION TEST(S) FAILED — see above ***');
  process.exit(1);
}
console.log('\nAll SBI aggregation integration tests passed.');
process.exit(0);
