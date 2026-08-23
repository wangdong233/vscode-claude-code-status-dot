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
 *       pending / 0 interrupted → SBI.text "🟢3 🟡1 🔵2 🟤" (🟤 since the
 *       v0.1.17 ⚪→🟤 pivot; pre-pivot the dim slot read ⚪). Plus the
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
// v0.2.6 round-1: SBI_RUNNING_STALE_MS now keys off `since` (the *→running
// transition timestamp), NOT mtime — same defensive form as the done>5min
// and interrupted>24h rules. SINCE_STALE_MS is the per-tab decay threshold
// (15min) but is NOT used by the SBI aggregation path (SBI uses the more
// conservative 30min SBI_RUNNING_STALE_MS). Mirrored here for parity; the
// per-tab tick is NOT replicated in this file (covered by test-iife.mjs
// IIFE.46c regex).
const DONE_TO_IDLE_MS = 5 * 60 * 1000; // 5 min — §4 done→idle
const SBI_RUNNING_STALE_MS = 30 * 60 * 1000; // 30 min — §7.2 stale-running GC (since-based, v0.2.6)
const INTERRUPTED_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h — 🔴 retention cap
const SBI_AS_PROTECT_MAX_MS = 24 * 60 * 60 * 1000; // 24h — v0.5.49 as-protection expiry horizon (mtime-based)
const SINCE_STALE_MS = 15 * 60 * 1000; // 15 min — per-tab running decay (v0.2.6)

// v0.1.16: the SBI surface renders each light as its own StatusBarItem with
// text `<ball><digit>` (e.g. "🟢3", "🟤0" — 🟤 since the v0.1.17 ⚪→🟤 pivot;
// pre-pivot this example read "⚪0"). The v0.1.15 colored-block treatment
// (digit on themed backgroundColor + white text) was reverted to emoji balls
// per user feedback, but the 4-SBI structure is KEPT (positions stay fixed
// when counts change). This replica covers ONLY the DIGIT-capping part of
// the v0.1.16 per-SBI text rule (n===0→"0", 1/2/3→digit, >=4→"N"); the
// emoji-ball prepend (`<ball>` selection via DIM_EM vs CFG[k].em) is
// exercised in test-iife.mjs IIFE.38. (v0.1.14 baked a SBI_LIGHT_EMOJI array
// + SBI_DIM_EMOJI here to build the joined "🟢3 🟡1 🔵2 🟤" string; both
// were gone in v0.1.15; v0.1.16 brings emoji balls back via CFG[k].em +
// DIM_EM in the IIFE but this replica stays digit-only since capping is
// what these assertions lock.)

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
// SAME decay/bucket rules the IIFE does — INCLUDING the v0.5.2 (#4)
// __ccsdTranscriptFresh activity gate on the running→idle decay (a session
// whose transcript (.jsonl) grew within SBI_RUNNING_STALE_MS is actively
// streaming → not false-decayed; mirrored by transcriptFresh() below). `now`
// is injectable so time-based decay tests are deterministic (no real-time
// waiting) — NOTE transcriptFresh() uses real Date.now() for the jsonl mtime
// comparison, matching the IIFE which does NOT take a `now` param; plant a
// real-fresh .jsonl to exercise the gate. Returns the raw uncapped counts;
// callers apply cap() + sbiBlockText() to get the per-SBI texts.

function aggregate(home, now = Date.now(), pendingSet = null) {
  const DIR = path.join(home, '.claude', 'cc-tab-status');
  const ag = { running: 0, done: 0, interrupted: 0, idle: 0, pending: 0 };
  let files = [];
  try {
    files = fs.readdirSync(DIR);
  } catch {
    return ag; // no dir -> all zeros (matches IIFE's outer try/catch)
  }
  for (const f of files) {
    // v0.2.8 round-2 (MEDIUM efficiency): skip <sid>.tokens.json snapshots.
    // The IIFE aggregation filter was tightened to exclude them (they have
    // no `state` field → JSON.parse was wasted work on every tick). Mirror
    // the same filter here so the replica's bucket counts match the IIFE's
    // exactly when a future test plants a .tokens.json in the state dir.
    if (!f.endsWith('.json') || f.endsWith('.tokens.json')) continue;
    const fp = path.join(DIR, f);
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      let st = j.state;
      const since = j.since;
      // v0.2.6 round-1: the per-file stat was removed — the SBI decay no
      // longer reads mtime (switched to since-based; see comment below).
      // The IIFE still computes __mt for its cache-key short-circuit
      // (mtimeMs+size === cached values) but the replica has no cache, so
      // there is no reason to stat here. SINCE_STALE_MS / mtime is still
      // computed by the §5.5 regression below via fs.utimesSync to verify
      // the OLD mtime scenario does not cause false decay (decay should
      // depend on since, not mtime).
      // §4 done>5min → idle (ACTIVE done only counts toward 🟢)
      if (st === 'done' && since && now - since > DONE_TO_IDLE_MS) {
        st = 'idle';
      }
      // §7.2 stale-running (v0.2.6: since-based, not mtime-based). since is
      // the *→running transition time. cc-status.js Stop preserveSince path
      // (line 390-401) keeps cur.since on Stop heartbeats but writeJsonAtomic
      // refreshes mtime — so under CC's drifted inflight>0 Stop payload (the
      // stuck-yellow bug) mtime stays fresh forever and the 30min clock never
      // elapsed. since-decay fires correctly because since is preserved
      // across the same path. Mirrors done>5min one branch up.
      else if (st === 'running') {
        // v0.5.49 replica fix: this branch now mirrors the REAL __ccsdDecayState
        // running predicate (the v0.5.2 __ccsdTranscriptFresh jsonl gate was
        // RETIRED in v0.5.13 — the replica had drifted 30+ versions). Decay iff
        // since>30m AND tokens.last_ts>30m AND NOT protected, where protection =
        // activeSubagents>0 AND the file mtime (per-EVENT liveness witness — every
        // hook fire rewrites the file, SubagentStart/Stop included) is fresh
        // within SBI_AS_PROTECT_MAX_MS (24h). The v0.5.49 expiry kills the
        // crash-frozen-as=1 zombie class (baeddc1d: running+as=1 untouched 5.3
        // days → permanent phantom 🟡). Stat miss (mt=0) fails TOWARD decay,
        // mirroring the !mt disjunct — behaviorally untestable here (stat+parse
        // read the same file); the disjunct is source-pinned by IIFE.12e.
        let mt = 0;
        try {
          mt = fs.statSync(fp).mtimeMs;
        } catch {
          mt = 0;
        }
        const lt = j.tokens && j.tokens.last_ts;
        const asProtect = j.activeSubagents > 0 && mt > 0 && now - mt <= SBI_AS_PROTECT_MAX_MS;
        if (since && now - since > SBI_RUNNING_STALE_MS && lt && now - lt > SBI_RUNNING_STALE_MS && !asProtect) {
          st = 'idle';
        }
      }
      // v0.1.13/v0.1.14 interrupted>24h → idle, keyed on SINCE (the terminal
      // timestamp). v0.2.4 follow-up (round-2 data-logic fix): previously
      // keyed on mtime, but orphan SubagentStop / Notification writes on an
      // interrupted parent refresh mtime while preserving since — under orphan
      // activity the 24h clock never elapsed. Mirrors the done>5min rule.
      else if (st === 'interrupted' && since && now - since > INTERRUPTED_RETENTION_MS) {
        st = 'idle';
      }
      if (st === 'running') ag.running++;
      else if (st === 'done') ag.done++;
      else if (st === 'interrupted') ag.interrupted++;
      // R3 review fix (M8/M9), round-4 close (v0.1.15): catch-all idle bucket
      // REASSIGNS st to "idle" — matches the IIFE's `else{st="idle";ag.idle++}`.
      // Any unrecognized state (corrupt / hand-edited / forward-incompatible) is
      // treated as idle for state-bucketing AND normalized on the pending axis,
      // so a corrupt file with state="foo"+pending:true does NOT light 🔵 (the
      // prior form `else ag.idle++` ran the count but left st="foo", so the
      // pending check below saw unknown!=="idle"===true and over-counted blue).
      // The replica's st variable is let-typed so we can normalize it the same
      // way the IIFE now does.
      else {
        st = 'idle';
        ag.idle++;
      }
      // pending INDEPENDENT of state, but with the idle-GC: a session downgraded
      // to idle above is NOT counted toward 🔵 (kills the stale-blue-light stick).
      // ORDER MATTERS: this check MUST run after the three decay branches above
      // (test-iife.mjs IIFE.29b locks the same ordering at the source level).
      //
      // v0.2.5 (problem 1 fix): OR two sources — file-pending (Notification
      // hook → cc-status.js atomic write, async but cross-window) OR
      // per-window globalThis.__ccsdPendingSet (rename_tab IPC → synchronous,
      // source-of-truth, but only covers THIS window's panels). The set is
      // passed in via the optional pendingSet parameter (mirror of the
      // globalThis the IIFE reads). See aggregate() signature below.
      const sidFromName = f.slice(0, -5); // strip ".json"
      const inSet = !!(pendingSet && pendingSet[sidFromName] === true);
      if ((j.pending === true || inSet) && st !== 'idle') ag.pending++;
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

// sbiBlockText(n) — digit-only replica of the v0.1.16 IIFE's per-SBI text
// rule's DIGIT component. The full v0.1.16 rule is
//   `sbi.text=(n===0?DIM_EM:CFG[k].em)+(n>=4?"N":""+n)`
// — this function returns just the `(n>=4?"N":""+n)` part (or "0" for the
// zero case so callers can compare a 4-array of digit-strings cleanly).
// n===0 → "0" (paired with 🟤 in the IIFE since the v0.1.17 ⚪→🟤 pivot); n=1/2/3 → digit (paired with
// the light's colored ball in the IIFE); n>=4 (capped to 4) → "N".
// (v0.1.14 used a separate disp(em,n) that joined emoji+digit into one
// StatusBarItem.text; v0.1.15 split into 4 SBIs with digit-in-colored-block;
// v0.1.16 split into 4 SBIs with emoji-ball+digit. This replica tracks only
// the digit-capping behavior shared across v0.1.15 and v0.1.16 — the emoji
// prepend is exercised in test-iife.mjs IIFE.38.)
function sbiBlockText(n) {
  return n === 0 ? '0' : n >= 4 ? 'N' : String(n);
}

// Compute the 4 per-SBI texts the IIFE would push for an aggregation. Returns
// an array [doneText, runningText, pendingText, interruptedText] — each entry
// is the digit-or-"N" the corresponding colored block shows. Indexes match
// CFG[] / counts[] in the IIFE (done/running/pending/interrupted, left→right).
// Callers compare via JSON.stringify for a single-shot full-array assertion.
function expectedSbiTexts(ag) {
  return [
    sbiBlockText(cap(ag.done)),
    sbiBlockText(cap(ag.running)),
    sbiBlockText(cap(ag.pending)),
    sbiBlockText(cap(ag.interrupted)),
  ];
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
  // 5 fresh running sessions → uncapped ag.running=5, capped SBI block shows "N"
  for (let i = 0; i < 5; i++) {
    writeStatus(home, 'run-' + i, { state: 'running', since: Date.now(), activeSubagents: 0, pending: false });
  }
  const ag = aggregate(home);
  const texts = expectedSbiTexts(ag);
  check('§1.1a  5 running sessions → ag.running=5 (uncapped)', ag.running === 5, 'ag.running=' + ag.running);
  check(
    '§1.1b  cap(5)=4 → SBI blocks ["0","N","0","0"] (running block lit with "N")',
    JSON.stringify(texts) === '["0","N","0","0"]',
    'texts=' + JSON.stringify(texts),
  );
}

// §1.2  Exact boundary: 4 sessions → cap(4)=4 ("N"), 3 sessions → cap(3)=3
{
  const home = newTempHome();
  for (let i = 0; i < 4; i++) {
    writeStatus(home, 'd-' + i, { state: 'done', since: Date.now(), activeSubagents: 0, pending: false });
  }
  check(
    '§1.2a  exactly 4 done → cap=4 (boundary, "N" variant) → SBI blocks ["N","0","0","0"]',
    JSON.stringify(expectedSbiTexts(aggregate(home))) === '["N","0","0","0"]',
  );
  const home2 = newTempHome();
  for (let i = 0; i < 3; i++) {
    writeStatus(home2, 'd-' + i, { state: 'done', since: Date.now(), activeSubagents: 0, pending: false });
  }
  check(
    '§1.2b  exactly 3 done → cap=3 (literal "3" variant) → SBI blocks ["3","0","0","0"]',
    JSON.stringify(expectedSbiTexts(aggregate(home2))) === '["3","0","0","0"]',
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
    '§1.3c  SBI blocks ["2","0","0","0"] (only 2 fresh done counted; stale decayed)',
    JSON.stringify(expectedSbiTexts(ag)) === '["2","0","0","0"]',
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
    '§1.5c  SBI blocks ["0","0","0","0"] (nothing counted; pending NOT lit)',
    JSON.stringify(expectedSbiTexts(ag)) === '["0","0","0","0"]',
    'texts=' + JSON.stringify(expectedSbiTexts(ag)),
  );
}

// §1.6  stale-running since>30min → idle (crashed CC process GC)
// v0.2.6 round-1: decay now keys off `since` (the *→running transition time),
// NOT mtime — the prior mtime-based rule was defeated by cc-status.js:390-401
// Stop preserveSince path (inflight>0 keeps cur.since but writeJsonAtomic
// refreshes mtime on every Stop heartbeat; CC re-fires Stop on drifted inflight
// payloads so mtime stays fresh forever and the 30min clock never elapsed).
// Mirrors §1.7 interrupted-decay which already keys off since. The §1.6a-decouple
// case below isolates the since-old/mtime-fresh inversion (the actual
// stuck-yellow bug scenario); §5.6 covers the same inversion end-to-end.
{
  const home = newTempHome();
  writeStatus(home, 'crashed', {
    state: 'running',
    since: Date.now() - 31 * 60 * 1000, // OLD since (decay key under new rule)
    tokens: { last_ts: Date.now() - 31 * 60 * 1000 }, // OLD last_ts (v0.5.13 AND-conjunct)
    activeSubagents: 0,
    pending: false,
  });
  writeStatus(home, 'live', { state: 'running', since: Date.now(), activeSubagents: 0, pending: false });
  const ag = aggregate(home);
  check(
    '§1.6a  running since>30min (+stale last_ts) decays to idle',
    ag.idle === 1 && ag.running === 1,
    'ag.running=' + ag.running + ' ag.idle=' + ag.idle,
  );
}

// §1.6a-decouple  v0.2.6 round-1 fix: prove the running branch now keys on
// SINCE (not mtime) — Stop-preserveSince-safe. Set mtime=31min-ago (OLD) but
// since=fresh (NOW). Under the new since-based rule this session STAYS running
// (since is fresh). Under the prior mtime-based rule it would have decayed to
// idle (mtime is old) — the assertion below locks the inversion. This case is
// the EXACT inverse of the stuck-yellow bug scenario (since=OLD + mtime=FRESH
// → decay, covered by §5.6); here we invert the inputs to lock the new key:
// mtime OLD, since FRESH → no decay (the old mtime-based rule WOULD have
// decayed). Mirrors §1.7-decouple's pattern for interrupted.
{
  const home = newTempHome();
  writeStatus(
    home,
    'fresh-since-old-mtime',
    {
      state: 'running',
      since: Date.now(), // FRESH since (decay key under new rule)
      activeSubagents: 0,
      pending: false,
    },
    { ageMs: 31 * 60 * 1000 }, // OLD mtime (would have triggered decay under old rule)
  );
  const ag = aggregate(home);
  check(
    '§1.6a-decouple  since=FRESH, mtime=OLD → STAYS running (since is the decay key, not mtime)',
    ag.running === 1 && ag.idle === 0,
    'ag.running=' + ag.running + ' ag.idle=' + ag.idle,
  );
}

// §1.6b  stale running WITH pending=true: both running and pending drop (stale-blue GC)
{
  const home = newTempHome();
  writeStatus(home, 'crashed-pending', {
    state: 'running',
    since: Date.now() - 31 * 60 * 1000, // OLD since (decay key under new rule)
    tokens: { last_ts: Date.now() - 31 * 60 * 1000 }, // OLD last_ts (v0.5.13 AND-conjunct)
    activeSubagents: 0,
    pending: true,
  });
  const ag = aggregate(home);
  check(
    '§1.6b  stale-running+pending → idle; pending NOT counted (the false-stick fix)',
    ag.idle === 1 && ag.running === 0 && ag.pending === 0,
    'ag.running=' + ag.running + ' ag.pending=' + ag.pending + ' ag.idle=' + ag.idle,
  );
}

// §1.6c  v0.5.49 rewrite: the v0.5.2 transcriptFresh jsonl gate was RETIRED in
// v0.5.13 (the replica had drifted and kept mirroring it until now). The REAL
// running-decay blockers are (1) fresh tokens.last_ts (model still producing)
// and (2) the v0.5.16 activeSubagents protection, which v0.5.49 gates on file
// mtime freshness (per-EVENT liveness witness). Three real-semantics cases:
{
  // §1.6c1: stale since BUT fresh tokens.last_ts → STAYS running (the real
  // active-streaming block — long turn freezes `since` while last_ts advances
  // on every TOK_EVENT).
  const home = newTempHome();
  writeStatus(home, 'long-stream-c1', {
    state: 'running',
    since: Date.now() - 31 * 60 * 1000, // OLD since
    tokens: { last_ts: Date.now() }, // FRESH last_ts (streaming NOW)
    activeSubagents: 0,
    pending: false,
  });
  // NOTE: real `now` (no future injection) — the fresh last_ts must stay fresh
  // for the gate to block decay; since is already 31min old in the fixture.
  const ag = aggregate(home);
  check(
    '§1.6c1  stale-since + FRESH tokens.last_ts → STAYS running (v0.5.13+ real gate)',
    ag.running === 1 && ag.idle === 0,
    'ag.running=' + ag.running + ' ag.idle=' + ag.idle,
  );
}
{
  // §1.6c2: missing tokens.last_ts entirely → NO decay (R3 known limitation:
  // a running file lacking last_ts blocks decay via the j.tokens&&j.tokens.last_ts
  // conjunct — not live today, UserPromptSubmit derives last_ts; pinned here as
  // CURRENT behavior so a future tightening flips this assert deliberately).
  const home = newTempHome();
  writeStatus(home, 'no-last-ts-c2', {
    state: 'running',
    since: Date.now() - 31 * 60 * 1000,
    activeSubagents: 0,
    pending: false,
  });
  const ag = aggregate(home, Date.now() + 31 * 60 * 1000);
  check(
    '§1.6c2  stale-since + NO tokens.last_ts → stays running (R3 pin: last_ts conjunct blocks decay)',
    ag.running === 1 && ag.idle === 0,
    'ag.running=' + ag.running + ' ag.idle=' + ag.idle,
  );
}
{
  // §1.6c3: as>0 + FRESH mtime → STAYS running (v0.5.16 active-workflow
  // protection, v0.5.49 mtime-gated — the REGRESSION-CRITICAL case: a parent
  // blocked on a Workflow tool with subagents streaming fires hook events
  // (SubagentStart/Stop) that refresh mtime while since/last_ts stay stale).
  const home = newTempHome();
  writeStatus(home, 'wf-protect-c3', {
    state: 'running',
    since: Date.now() - 2 * 60 * 60 * 1000, // OLD since (parent silent 2h)
    tokens: { last_ts: Date.now() - 2 * 60 * 60 * 1000 }, // OLD last_ts (parent silent)
    activeSubagents: 1,
    pending: false,
  }); // NO ageMs → mtime FRESH (subagent events keep rewriting the file)
  const ag = aggregate(home);
  check(
    '§1.6c3  as=1 + since/last_ts stale + mtime FRESH → STAYS running (v0.5.16 protection, NOT regressed)',
    ag.running === 1 && ag.idle === 0,
    'ag.running=' + ag.running + ' ag.idle=' + ag.idle,
  );
}

// §1.6z  v0.5.49 as-protection expiry (the baeddc1d zombie-kill cases):
{
  // (a) as=1 + since/last_ts/mtime ALL 2d old → idle. THE 5.3-day zombie class:
  // crashed mid-workflow, SessionEnd never fired, as frozen at 1; pre-v0.5.49
  // the !(as>0) gate blocked decay FOREVER → permanent phantom 🟡 +1.
  const home = newTempHome();
  writeStatus(
    home,
    'zombie-a',
    {
      state: 'running',
      since: Date.now() - 2 * 24 * 60 * 60 * 1000,
      tokens: { last_ts: Date.now() - 2 * 24 * 60 * 60 * 1000 },
      activeSubagents: 1,
      pending: false,
    },
    { ageMs: 2 * 24 * 60 * 60 * 1000 }, // mtime ALSO 2d old (no event since the crash)
  );
  const ag = aggregate(home);
  check(
    '§1.6za  as=1 zombie (all timestamps 2d old) → idle (v0.5.49 expiry KILLS the phantom 🟡)',
    ag.idle === 1 && ag.running === 0,
    'ag.running=' + ag.running + ' ag.idle=' + ag.idle,
  );
}
{
  // (c) as=1 + mtime 25h old (just past the 24h horizon) → idle (protection
  // expires at the boundary, not just at multi-day scales).
  const home = newTempHome();
  writeStatus(
    home,
    'zombie-c',
    {
      state: 'running',
      since: Date.now() - 25 * 60 * 60 * 1000,
      tokens: { last_ts: Date.now() - 25 * 60 * 60 * 1000 },
      activeSubagents: 1,
      pending: false,
    },
    { ageMs: 25 * 60 * 60 * 1000 },
  );
  const ag = aggregate(home);
  check(
    '§1.6zc  as=1 + mtime 25h (just past horizon) → idle',
    ag.idle === 1 && ag.running === 0,
    'ag.running=' + ag.running + ' ag.idle=' + ag.idle,
  );
}
{
  // (d) as=0 + mtime 2d stale → idle (byte-identical class: the as-gate's first
  // disjunct is true for as==0, mtime expiry changes nothing).
  const home = newTempHome();
  writeStatus(
    home,
    'plain-d',
    {
      state: 'running',
      since: Date.now() - 2 * 24 * 60 * 60 * 1000,
      tokens: { last_ts: Date.now() - 2 * 24 * 60 * 60 * 1000 },
      activeSubagents: 0,
      pending: false,
    },
    { ageMs: 2 * 24 * 60 * 60 * 1000 },
  );
  const ag = aggregate(home);
  check(
    '§1.6zd  as=0 + all stale (incl. mtime) → idle (unchanged for as==0)',
    ag.idle === 1 && ag.running === 0,
    'ag.running=' + ag.running + ' ag.idle=' + ag.idle,
  );
}

// §1.7  interrupted>24h since → idle (bounds 🔴 growth from abandoned sessions)
// v0.2.4 follow-up (round-2 data-logic fix): the decay now keys on SINCE
// (the terminal timestamp), not mtime. The prior version of this test set
// BOTH since and mtime to 25h-ago, so it could not distinguish which key
// the branch read. Now decoupled: since=25h-ago (OLD), mtime=fresh (NOW).
// Under the new since-based rule this session decays to idle (since is old);
// under the old mtime-based rule it would have stayed interrupted (mtime is
// fresh) — the assertion below locks the new behavior.
{
  const home = newTempHome();
  writeStatus(
    home,
    'old-int',
    {
      state: 'interrupted',
      since: Date.now() - 25 * 60 * 60 * 1000, // OLD since (decay key under new rule)
      error: 'rate_limit',
      activeSubagents: 0,
      pending: false,
    }, // NO ageMs → mtime is fresh (NOW), proving the branch no longer reads mtime
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
    '§1.7  interrupted since>24h decays to idle; fresh interrupted stays',
    ag.interrupted === 1 && ag.idle === 1,
    'ag.interrupted=' + ag.interrupted + ' ag.idle=' + ag.idle,
  );
}

// §1.7-decouple  v0.2.4 round-2 data-logic fix: prove the interrupted branch
// now keys on SINCE (not mtime) — orphan-write-safe. Set mtime=25h-ago (OLD)
// but since=fresh (NOW). Under the new since-based rule this session STAYS
// interrupted (since is fresh). Under the old mtime-based rule it would have
// decayed to idle (mtime is old) — the assertion below locks the inversion.
// This case is the EXACT orphan-activity scenario the fix targets: a parent
// that crashed mid-subagent-workflow (StopFailure wrote interrupted with
// since=T0) is later touched by a SubagentStop/Notification that preserves
// since=T0 but refreshes mtime; under the old rule the 24h clock kept
// resetting. Here we invert the inputs to lock the new key: mtime OLD,
// since FRESH → no decay (the old rule WOULD have decayed).
{
  const home = newTempHome();
  writeStatus(
    home,
    'old-mtime-fresh-since-int',
    {
      state: 'interrupted',
      since: Date.now(), // FRESH since (decay key under new rule)
      error: 'rate_limit',
      activeSubagents: 0,
      pending: false,
    },
    { ageMs: 25 * 60 * 60 * 1000 }, // mtime = 25h AGO (proves branch no longer reads mtime)
  );
  const ag = aggregate(home);
  check(
    '§1.7-decouple  mtime=OLD, since=FRESH → STAYS interrupted (since is the decay key, not mtime)',
    ag.interrupted === 1 && ag.idle === 0,
    'ag.interrupted=' + ag.interrupted + ' ag.idle=' + ag.idle,
  );
}

// §1.8  Empty state dir / missing dir → SBI all blocks "0" (dim)
{
  const home = newTempHome();
  fs.mkdirSync(stateDir(home), { recursive: true }); // exists but empty
  const ag = aggregate(home);
  const texts = expectedSbiTexts(ag);
  check(
    '§1.8a  empty state dir → ag all zeros',
    ag.done === 0 && ag.running === 0 && ag.pending === 0 && ag.interrupted === 0,
  );
  check(
    '§1.8b  empty state dir → SBI blocks ["0","0","0","0"]',
    JSON.stringify(texts) === '["0","0","0","0"]',
    'texts=' + JSON.stringify(texts),
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

// §1.10  Round-4 close (v0.1.15): unknown-state × pending:true does NOT light 🔵.
// The R3 catch-all idle fix claimed corrupt / forward-incompatible files were
// normalized to idle on BOTH the state axis and the pending axis, but the
// `else ag.idle++` arm only ran the count without reassigning st — so a file
// with state="foo" (or undefined) + pending:true still satisfied
// `unknown!=="idle"` and over-counted blue. This test locks the round-4
// `else{st="idle";ag.idle++}` close: state="weird"+pending=true lands in the
// idle bucket AND pending stays 0. The behavioral assertion here is the
// ground truth the test-iife.mjs IIFE.29 source-regex cannot reach (regex
// can only verify the clause exists; this verifies it RUNS correctly for the
// unknown-state × pending combination).
{
  const home = newTempHome();
  fs.mkdirSync(stateDir(home), { recursive: true });
  // unknown state + pending=true → must NOT light 🔵
  fs.writeFileSync(
    path.join(stateDir(home), 'corrupt.json'),
    JSON.stringify({ state: 'weird', since: Date.now(), pending: true, activeSubagents: 0 }),
  );
  // also test missing state field (forward-incompatible / hand-deleted)
  fs.writeFileSync(
    path.join(stateDir(home), 'nostate.json'),
    JSON.stringify({ since: Date.now(), pending: true, activeSubagents: 0 }),
  );
  // control: a known-state pending session DOES light 🔵 (proves the assertion
  // isn't trivially satisfied by "pending never counts")
  writeStatus(home, 'control-r-p', {
    state: 'running',
    since: Date.now(),
    activeSubagents: 0,
    pending: true,
  });
  const ag = aggregate(home);
  check(
    '§1.10a  state="weird" + pending=true → idle bucket (NOT any state light)',
    ag.idle === 2 && ag.done === 0 && ag.interrupted === 0,
    'ag.idle=' + ag.idle + ' ag.done=' + ag.done + ' ag.interrupted=' + ag.interrupted,
  );
  check(
    '§1.10b  only the control running session counts toward running (corrupt sessions skipped)',
    ag.running === 1,
    'ag.running=' + ag.running + ' (expected 1: only control-r-p)',
  );
  check(
    '§1.10c  pending count === 1 (only the control running session; corrupt sessions skipped)',
    ag.pending === 1,
    'ag.pending=' + ag.pending + ' (expected 1: only control-r-p)',
  );
  check(
    '§1.10d  SBI blocks ["0","1","1","0"] (only the control session lights its lights)',
    JSON.stringify(expectedSbiTexts(ag)) === '["0","1","1","0"]',
    'texts=' + JSON.stringify(expectedSbiTexts(ag)),
  );
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
  // SBI blocks: running=1, pending=1 → ["0","1","1","0"] (running + pending blocks lit)
  check(
    '§2.1e  SBI blocks ["0","1","1","0"] (running + pending lit)',
    JSON.stringify(expectedSbiTexts(ag)) === '["0","1","1","0"]',
    'texts=' + JSON.stringify(expectedSbiTexts(ag)),
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

// §4.1  Exact scenario: SBI blocks = ["3","1","2","0"]
// Pending is INDEPENDENT of state, so:
//   - s1: done + pending=true  (counts done AND pending)
//   - s2: done                 (counts done)
//   - s3: done                 (counts done)
//   - s4: running + pending=true (counts running AND pending)
//   → done=3, running=1, pending=2, interrupted=0 → blocks ["3","1","2","0"]
{
  const home = newTempHome();
  writeStatus(home, 's1', { state: 'done', since: Date.now(), activeSubagents: 0, pending: true });
  writeStatus(home, 's2', { state: 'done', since: Date.now(), activeSubagents: 0, pending: false });
  writeStatus(home, 's3', { state: 'done', since: Date.now(), activeSubagents: 0, pending: false });
  writeStatus(home, 's4', { state: 'running', since: Date.now(), activeSubagents: 0, pending: true });
  const ag = aggregate(home);
  const texts = expectedSbiTexts(ag);
  check('§4.1a  ag.done=3', ag.done === 3, 'ag.done=' + ag.done);
  check('§4.1a2 ag.running=1', ag.running === 1, 'ag.running=' + ag.running);
  check('§4.1a3 ag.pending=2', ag.pending === 2, 'ag.pending=' + ag.pending);
  check('§4.1a4 ag.interrupted=0', ag.interrupted === 0, 'ag.interrupted=' + ag.interrupted);
  check(
    '§4.1b  SBI blocks ["3","1","2","0"] (3 done + 1 running + 2 pending + 0 interrupted)',
    JSON.stringify(texts) === '["3","1","2","0"]',
    'texts=' + JSON.stringify(texts),
  );
}

// §4.2  Per-block text selection: which digit/"N"/"0" form each block takes for
// a given aggregation. "0" for dim (count 0), digit for 1/2/3, "N" for 4+
// (capped). This is the sbiBlockText() rule applied to all 4 blocks.
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
  const texts = expectedSbiTexts(aggregate(home));
  check(
    '§4.2  6 done + 2 running + 0 pending + 1 interrupted → blocks ["N","2","0","1"]',
    JSON.stringify(texts) === '["N","2","0","1"]',
    'texts=' + JSON.stringify(texts),
  );
}

// §4.3  Full end-to-end via the REAL writer for a mixed scenario — proves the
// writer produces the on-disk shape the reader aggregates correctly.
// 4 sessions, driven entirely through real hook events:
//   A: UserPromptSubmit → PreToolUse → Stop (done, pending=false)
//   B: UserPromptSubmit → Notification (running, pending=true)
//   C: UserPromptSubmit → StopFailure (interrupted)
//   D: UserPromptSubmit → Stop (done)
//   → 2 done, 1 running, 1 pending, 1 interrupted → blocks ["2","1","1","1"]
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
  const texts = expectedSbiTexts(ag);
  check('§4.3a  writer-driven: 2 done (A, D)', ag.done === 2, 'ag.done=' + ag.done);
  check('§4.3b  writer-driven: 1 running (B, paused on Notification)', ag.running === 1, 'ag.running=' + ag.running);
  check(
    '§4.3c  writer-driven: 1 pending (B holds the Notification flag)',
    ag.pending === 1,
    'ag.pending=' + ag.pending,
  );
  check('§4.3d  writer-driven: 1 interrupted (C)', ag.interrupted === 1, 'ag.interrupted=' + ag.interrupted);
  check(
    '§4.3e  SBI blocks ["2","1","1","1"] (all 4 blocks lit)',
    JSON.stringify(texts) === '["2","1","1","1"]',
    'texts=' + JSON.stringify(texts),
  );
}

// §4.4  All-dim scenario: no sessions → all 4 SBI blocks "0"
{
  const home = newTempHome();
  fs.mkdirSync(stateDir(home), { recursive: true });
  const texts = expectedSbiTexts(aggregate(home));
  check(
    '§4.4  no sessions → SBI blocks ["0","0","0","0"]',
    JSON.stringify(texts) === '["0","0","0","0"]',
    'texts=' + JSON.stringify(texts),
  );
}

// ===========================================================================
// v0.2.5 problem 1: pending aggregation ORs TWO sources (file + globalThis set)
//
// Pre-fix: the bottom 🔵 pending count read ONLY <sid>.json.pending (written
// async by cc-status.js Notification hook → atomic write → next 500ms tick).
// The per-tab __ccsdPending flag was set synchronously by Anchor B from
// rename_tab.hasPendingPermissions — a strictly fresher signal. Fast-approve
// scenarios (<500ms between Notification and PreToolUse clear) saw the per-tab
// blue dot light up but the bottom count stay 0 (the async file write hadn't
// landed before PreToolUse cleared pending).
//
// Post-fix: the aggregation ORs the file-pending flag with a window-scoped
// globalThis.__ccsdPendingSet maintained by Anchor B. The set covers THIS
// window's panels (rename_tab IPC); the file branch covers cross-window
// scenarios (Notification write is global). decay (st!=="idle") still applies
// AFTER the OR so 30min/5min/24h GC rules are not bypassed.
// ===========================================================================
{
  const home = newTempHome();
  fs.mkdirSync(stateDir(home), { recursive: true });
  const sid = 'aaa-set-only-1111111111';
  // running session, file pending EXPLICITLY false (PreToolUse already cleared)
  // but globalThis set has the sid (Anchor B caught rename_tab.hasPending=true)
  fs.writeFileSync(
    path.join(stateDir(home), sid + '.json'),
    JSON.stringify({ state: 'running', since: Date.now() - 1000, pending: false }),
  );
  const pendingSet = Object.create(null);
  pendingSet[sid] = true;
  const ag = aggregate(home, Date.now(), pendingSet);
  check(
    '§5.1  set-only branch counts pending (file=false, set has sid) → 1',
    ag.pending === 1,
    'ag.pending=' + ag.pending,
  );
}
{
  const home = newTempHome();
  fs.mkdirSync(stateDir(home), { recursive: true });
  const sid = 'bbb-file-only-2222222222';
  // running session, file pending=true, set EMPTY (cross-window: rename_tab
  // for a panel in W1 cannot update W2's globalThis — file branch covers this)
  fs.writeFileSync(
    path.join(stateDir(home), sid + '.json'),
    JSON.stringify({ state: 'running', since: Date.now() - 1000, pending: true }),
  );
  const ag = aggregate(home, Date.now(), Object.create(null));
  check(
    '§5.2  file-only branch counts pending (cross-window fallback) → 1',
    ag.pending === 1,
    'ag.pending=' + ag.pending,
  );
}
{
  const home = newTempHome();
  fs.mkdirSync(stateDir(home), { recursive: true });
  const sid = 'ccc-both-sources-33333333';
  // running session, BOTH file pending=true AND set has sid → MUST count 1 (not 2)
  fs.writeFileSync(
    path.join(stateDir(home), sid + '.json'),
    JSON.stringify({ state: 'running', since: Date.now() - 1000, pending: true }),
  );
  const pendingSet = Object.create(null);
  pendingSet[sid] = true;
  const ag = aggregate(home, Date.now(), pendingSet);
  check('§5.3  both sources → counts 1 (OR dedup, not 2)', ag.pending === 1, 'ag.pending=' + ag.pending);
}
{
  const home = newTempHome();
  fs.mkdirSync(stateDir(home), { recursive: true });
  const sid = 'ddd-neither-4444444444';
  // running session, NEITHER source has pending → 0
  fs.writeFileSync(
    path.join(stateDir(home), sid + '.json'),
    JSON.stringify({ state: 'running', since: Date.now() - 1000, pending: false }),
  );
  const ag = aggregate(home, Date.now(), Object.create(null));
  check('§5.4  neither source → 0', ag.pending === 0, 'ag.pending=' + ag.pending);
}
{
  // decay still applies: set has sid + running since>30min → idle (decay
  // upgrades st to idle) → pending NOT counted, even though the set has sid.
  // Locks the "OR is gated by st!=='idle'" invariant — the OR must NOT
  // bypass the existing decay chain (running-stale is a crashed/drifted
  // session whose pending flag is meaningless).
  // v0.2.6: comment updated — decay now keys off `since`, not mtime. Test
  // still passes because BOTH since (60min ago) AND mtime (31min ago) are
  // stale; the new v0.2.6 §5.6 case below isolates the since-old/mtime-fresh
  // path (the actual stuck-yellow bug scenario).
  const home = newTempHome();
  fs.mkdirSync(stateDir(home), { recursive: true });
  const sid = 'eee-stale-running-55555555';
  const filePath = path.join(stateDir(home), sid + '.json');
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      state: 'running',
      since: Date.now() - 60 * 60 * 1000,
      tokens: { last_ts: Date.now() - 60 * 60 * 1000 }, // v0.5.13 AND-conjunct
      pending: false,
    }),
  );
  // Backdate mtime to >30min ago to trigger running-stale decay.
  const stale = new Date(Date.now() - (SBI_RUNNING_STALE_MS + 60000));
  fs.utimesSync(filePath, stale, stale);
  const pendingSet = Object.create(null);
  pendingSet[sid] = true;
  const ag = aggregate(home, Date.now(), pendingSet);
  check(
    '§5.5  decay bypassed-NOT: set has sid + stale-running (since AND mtime old) → 0 (OR gated by st!==idle)',
    ag.pending === 0,
    'ag.pending=' + ag.pending,
  );
  check(
    '§5.5b stale-running (since AND mtime old) → idle, not counted as 🟡',
    ag.running === 0 && ag.idle === 1,
    'ag.running=' + ag.running + ' ag.idle=' + ag.idle,
  );
}
{
  // v0.2.6 round-1 stuck-yellow regression (the ACTUAL user-reported bug):
  // CC Stop payload inflight=1 drift + cc-status.js:390-401 preserveSince path
  // → state="running" + activeSubagents=1 written to file, mtime FRESH (writer
  // just wrote), but since OLD (preserveSince kept cur.since from the
  // original *→running transition 2h ago). Under the PRIOR mtime-based decay
  // this session would never decay (mtime always fresh from the Stop write),
  // sticking 🟡 at 1 in the SBI aggregate AND rendering yellow on the per-tab
  // icon (the visible symptom). v0.2.6 fix: decay keys off since instead, so
  // this drifted scenario now correctly decays to idle. Lock the regression
  // so a future revert (mtime-based decay) would surface here.
  const home = newTempHome();
  fs.mkdirSync(stateDir(home), { recursive: true });
  const sid = 'fff-stuck-yellow-666666666';
  const filePath = path.join(stateDir(home), sid + '.json');
  // Simulate the drift: since=2h ago (preserveSince kept it), but mtime=now
  // (writer just wrote via Stop heartbeat).
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      state: 'running',
      since: Date.now() - 2 * 60 * 60 * 1000, // 2h ago
      activeSubagents: 1,
      pending: false,
    }),
  );
  // mtime is already fresh (just written). DO NOT backdate it — that's the
  // whole point: the bug scenario has fresh mtime + old since.
  // v0.5.49 SEMANTICS UPDATE: under the REAL v0.5.13+/v0.5.16 predicate this
  // scenario STAYS RUNNING — as=1 with fresh mtime means hook events are still
  // firing (per-event liveness witness), i.e. CC is ALIVE and honestly
  // ambiguous (drifted heartbeats vs real workflow). This is protected BY
  // DESIGN (synthesis R2) and bounded by the writer's 7d GC drift rule. The
  // pre-v0.5.49 assertion (decays) passed only because the replica still
  // mirrored the retired v0.5.2 transcriptFresh gate. The zombie twin (same
  // fixture with mtime backdated >24h) is §5.7 below.
  const ag = aggregate(home, Date.now(), Object.create(null));
  check(
    '§5.6 drifted-CC alive (as=1 + mtime fresh, since stale) → STAYS running (v0.5.16 protection; honest ambiguity, 7d-GC-bounded)',
    ag.running === 1 && ag.idle === 0,
    'ag.running=' + ag.running + ' ag.idle=' + ag.idle,
  );
}
{
  // §5.7 v0.5.49: the §5.6 twin with the mtime backdated 2 days — the crash
  // variant (no hook event since the crash) → protection EXPIRED → decays.
  const home = newTempHome();
  fs.mkdirSync(stateDir(home), { recursive: true });
  const sid = 'ggg-zombie-77777777777';
  const filePath = path.join(stateDir(home), sid + '.json');
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      state: 'running',
      since: Date.now() - 2 * 24 * 60 * 60 * 1000,
      tokens: { last_ts: Date.now() - 2 * 24 * 60 * 60 * 1000 },
      activeSubagents: 1,
      pending: false,
    }),
  );
  const stale = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(filePath, stale, stale); // no event since the crash
  const ag2 = aggregate(home, Date.now(), Object.create(null));
  check(
    '§5.7 §5.6 twin with 2d-stale mtime → idle (v0.5.49 as-protection expiry)',
    ag2.running === 0 && ag2.idle === 1,
    'ag2.running=' + ag2.running + ' ag2.idle=' + ag2.idle,
  );
}
{
  // v0.2.6 counter-regression: a REAL active running session (since=2min ago,
  // mtime=now) must NOT decay — the fix is specifically about OLD since, not
  // fresh since. Locks the false-positive guard: a too-aggressive threshold
  // or a regression dropping the `now - since > THRESH` comparison would
  // falsely idle legitimate running sessions.
  const home = newTempHome();
  fs.mkdirSync(stateDir(home), { recursive: true });
  const sid = 'ggg-real-running-777777777';
  fs.writeFileSync(
    path.join(stateDir(home), sid + '.json'),
    JSON.stringify({ state: 'running', since: Date.now() - 2 * 60 * 1000, pending: false }),
  );
  const ag = aggregate(home, Date.now(), Object.create(null));
  check(
    '§5.7 real running (since=2min) → still running (NOT decayed)',
    ag.running === 1 && ag.idle === 0,
    'ag.running=' + ag.running + ' ag.idle=' + ag.idle,
  );
}
{
  // v0.2.6 since=0 corrupt-file defensive guard: decay does NOT fire when
  // since=0 (the `since && ...` falsy guard). Matches the IIFE defensive
  // form. A corrupt/hand-edited file with since=0 should not be falsely
  // decayed; it stays running until the next hook event writes a valid since.
  const home = newTempHome();
  fs.mkdirSync(stateDir(home), { recursive: true });
  const sid = 'hhh-corrupt-since-0-88888888';
  fs.writeFileSync(
    path.join(stateDir(home), sid + '.json'),
    JSON.stringify({ state: 'running', since: 0, pending: false }),
  );
  const ag = aggregate(home, Date.now(), Object.create(null));
  check(
    '§5.8 since=0 corrupt file → NOT decayed (falsy guard)',
    ag.running === 1 && ag.idle === 0,
    'ag.running=' + ag.running + ' ag.idle=' + ag.idle,
  );
}
{
  // Multi-sid accumulation: 3 sessions in set + 2 sessions in file + 1 in both.
  // Expected pending = 5 (3 set-only + 2 file-only + 0 from "both" since the
  // 6th's sid is in both but counts once). Locks the multi-source OR over N
  // files, not just one.
  const home = newTempHome();
  fs.mkdirSync(stateDir(home), { recursive: true });
  const sids = [
    'multi-set-1-aaaaaaaa',
    'multi-set-2-bbbbbbbb',
    'multi-set-3-cccccccc',
    'multi-file-1-dddddddd',
    'multi-file-2-eeeeeeee',
    'multi-both-1-ffffffff',
  ];
  const pendingSet = Object.create(null);
  pendingSet[sids[0]] = true;
  pendingSet[sids[1]] = true;
  pendingSet[sids[2]] = true;
  pendingSet[sids[5]] = true;
  for (let i = 0; i < sids.length; i++) {
    const filePending = i >= 3 && i <= 5; // last 3 in file
    fs.writeFileSync(
      path.join(stateDir(home), sids[i] + '.json'),
      JSON.stringify({ state: 'running', since: Date.now() - 1000, pending: filePending }),
    );
  }
  const ag = aggregate(home, Date.now(), pendingSet);
  check('§5.6  multi-sid OR (3 set + 2 file-only + 1 both) → 6 pending', ag.pending === 6, 'ag.pending=' + ag.pending);
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
