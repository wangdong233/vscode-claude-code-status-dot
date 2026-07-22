#!/usr/bin/env node
/**
 * test-smoke-journey.mjs — v0.1.14 SBI USER-JOURNEY smoke test.
 *
 * Sibling to test-sbi-aggregation.mjs. That file is organized as isolated
 * unit cases (one rule per block). THIS file is the complementary journey:
 * a single narrative that walks ONE virtual user through a full working
 * session — open the editor cold → spawn sessions → finish some → crash one
 * → hit permission prompts → walk away for coffee → come back — and asserts
 * the bottom StatusBarItem text (SBI.text) at EVERY step.
 *
 * Why a journey file (when aggregation is already covered)?
 *   - The unit file proves "each rule is correct in isolation". A journey
 *     proves "the rules compose correctly across state transitions on the
 *     SAME working set" — which is what users actually experience. The
 *     0→1→2→3→N cap progression, the "dim 🟤 ↔ colored+digit" flip (🟤 since
 *     the v0.1.17 ⚪→🟤 pivot; pre-pivot this read ⚪), the
 *     "blue pending is INDEPENDENT of state" claim, and the "idle decay
 *     does NOT light green" claim are all narrated in one place so a future
 *     regression in any of them surfaces as a broken step in the journey,
 *     not just an isolated assertion failure.
 *   - Mirrors the task's explicit ask: 多会话状态(running/done/pending/
 *     interrupted/idle) → 4 灯统计 + text 拼接(0-3+N 封顶, 0 灭🟤/非0亮,
 *     蓝 pending, 灰不计绿). (🟤 since the v0.1.17 ⚪→🟤 pivot; pre-pivot ⚪).
 *
 * Approach: replicate the IIFE aggregation (same DRY posture as
 * test-sbi-aggregation.mjs). The IIFE body is locked byte-for-byte by
 * test-iife.mjs; this replica exercises the SAME rules against a SHARED
 * isolated HOME so the journey walks a realistic state dir, not just
 * hand-planted fixtures. Where the journey's state transitions correspond
 * to real hook events, we ALSO drive cc-status.js (the real writer) for
 * those steps — so the journey proves writer→reader composition, not just
 * reader behavior on hand-written JSON.
 *
 * Phases (each prints BEFORE → AFTER SBI texts so the journey reads top-down):
 *   §0  Cold start — empty editor, SBI all dim ["0","0","0","0"]
 *   §1  Open first tab — 1 running → ["0","1","0","0"]
 *   §2  Open more tabs — count grows through 2 / 3 / N (cap@4+)
 *   §3  Some finish, one crashes — done + interrupted lit, running drops
 *   §4  Permission prompt fires — 🔵 pending INDEPENDENT of running state
 *   §5  All 4 lights lit — done + running + pending + interrupted
 *   §6  Coffee break — idle decay: 5min done / 30min running / 24h interrupted
 *       all decay to idle; IDLE sessions do NOT light 🟢 (灰不计绿)
 *   §7  Crashed-mid-permission GC — pending on an idle-decayed session does
 *       NOT false-stick 🔵 (stale-blue-light fix)
 *   §8  Close all tabs — back to ["0","0","0","0"]
 *
 * Run:  node hooks/test-smoke-journey.mjs
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CC_STATUS = path.join(__dirname, 'cc-status.js');

// --- Constants: mirror patch.ts (single source of truth). Same values the
// IIFE bakes (DONE_TO_IDLE_MS / SBI_RUNNING_STALE_MS / INTERRUPTED_RETENTION_MS
// / cap()) and the writer enforces. Any patch.ts change MUST be mirrored here
// — same DRY caveat as test-sbi-aggregation.mjs.
// v0.2.6 round-1: SBI_RUNNING_STALE_MS now keys off `since` (the *→running
// transition timestamp), NOT mtime. SINCE_STALE_MS is the per-tab decay
// threshold (15min) — mirrored for parity though not used by the SBI
// aggregation path in this replica.
const DONE_TO_IDLE_MS = 5 * 60 * 1000; // 5 min — §4 done→idle
const SBI_RUNNING_STALE_MS = 30 * 60 * 1000; // 30 min — §7.2 stale-running GC (since-based, v0.2.6)
const INTERRUPTED_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h — 🔴 retention cap
const SINCE_STALE_MS = 15 * 60 * 1000; // 15 min — per-tab running decay (v0.2.6)

// v0.1.16: each SBI is its own StatusBarItem with text `<ball><digit>`
// (e.g. "🟢3", "🟤0" — 🟤 since the v0.1.17 ⚪→🟤 pivot; pre-pivot "⚪0").
// The v0.1.15 colored-block treatment was reverted to
// emoji balls per user feedback, but the 4-SBI structure is KEPT. There is
// no single joined SBI.text — sbiTexts() below returns the array of 4
// per-SBI texts (digit-only — the emoji-ball prepend is exercised in
// test-iife.mjs IIFE.38). (v0.1.14 kept SBI_LIGHT_EMOJI + SBI_DIM_EMOJI
// here to build the joined "🟢3 🟡1 🔵2 🟤" string (🟤 since the v0.1.17
// ⚪→🟤 pivot; pre-pivot ⚪); both were gone in v0.1.15;
// v0.1.16 brings emoji balls back via CFG[k].em + DIM_EM in the IIFE but
// this replica stays digit-only since capping is what these journey
// assertions lock.)
// The LIGHT_NAMES array below stays — it's used for cosmetic journey-log lines.
const LIGHT_NAMES = ['done', 'running', 'pending', 'interrupted'];

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('    PASS  ' + name);
  } else {
    fail++;
    console.log('    FAIL  ' + name + (detail ? '   ' + detail : ''));
  }
}

// --- Replica of the IIFE aggregation body (patch.ts buildIIFE) ---------------
// Same body as test-sbi-aggregation.mjs's aggregate() — kept inline here so the
// journey file is self-contained. Reads every <sid>.json under
// <home>/.claude/cc-tab-status and applies the SAME decay/bucket rules the IIFE
// does — INCLUDING the v0.5.2 (#4) __ccsdTranscriptFresh activity gate on the
// running→idle decay (mirrored by transcriptFresh() below; a fresh .jsonl blocks
// false-decay of a long-streaming / subagent-waiting session). `now` is
// injectable so the "coffee break" phase can time-travel without real waiting.
// transcriptFresh() itself uses real Date.now() for the jsonl mtime comparison
// (the IIFE does not parameterize time there). Returns the raw uncapped counts.

// Mirror of the IIFE's __ccsdTranscriptFresh(j,sid,staleMs) — see
// test-sbi-aggregation.mjs's transcriptFresh() for the full rationale. Uses
// `home` in place of os.homedir() (the replica's home IS the IIFE's
// os.homedir() in tests). Any miss → false (safe decay direction).
function transcriptFresh(j, sid, staleMs, home) {
  try {
    if (!j || !sid) return false;
    let jsonlPath = null;
    if (typeof j.transcript_path === 'string' && j.transcript_path) {
      jsonlPath = j.transcript_path;
    } else if (typeof j.cwd === 'string' && j.cwd) {
      const escaped = j.cwd.replace(/[^a-zA-Z0-9._-]/g, '-');
      jsonlPath = path.join(home, '.claude', 'projects', escaped, sid + '.jsonl');
    }
    if (!jsonlPath) return false;
    const stt = fs.statSync(jsonlPath);
    if (!stt || !stt.isFile()) return false;
    return Date.now() - stt.mtimeMs < staleMs;
  } catch (_) {
    return false;
  }
}

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
      // §7.2 stale-running (v0.2.6: since-based, not mtime-based). since is
      // the *→running transition time. cc-status.js Stop preserveSince path
      // keeps cur.since on Stop heartbeats but writeJsonAtomic refreshes
      // mtime — so under CC's drifted inflight>0 Stop payload (the stuck-
      // yellow bug) mtime stays fresh forever and the 30min clock never
      // elapsed. since-decay fires correctly because since is preserved.
      // Mirrors done>5min one branch up.
      else if (st === 'running') {
        // v0.5.2 (#4): gate on transcriptFresh — a session whose transcript
        // (.jsonl) grew within SBI_RUNNING_STALE_MS is actively streaming → do
        // NOT false-decay. Mirrors patch.ts §F __ccsdTranscriptFresh exactly.
        if (since && now - since > SBI_RUNNING_STALE_MS) {
          if (!transcriptFresh(j, f.slice(0, -5), SBI_RUNNING_STALE_MS, home)) st = 'idle';
        }
      }
      // §7.5 interrupted>24h → idle. Keys off `since` (the TERMINAL timestamp),
      // NOT mtime — orphan SubagentStop/Notification writes refresh mtime while
      // preserving since (cc-status.js preserveSince/preserveError paths), so
      // mtime-based decay never fires under orphan activity and 🔴 would grow
      // monotonically. Mirrors test-sbi-aggregation.mjs's replica and the IIFE
      // source (patch.ts buildIIFE §7.5 branch, locked by IIFE.37d).
      else if (st === 'interrupted' && since && now - since > INTERRUPTED_RETENTION_MS) {
        st = 'idle';
      }
      if (st === 'running') ag.running++;
      else if (st === 'done') ag.done++;
      else if (st === 'interrupted') ag.interrupted++;
      // round-4 close (v0.1.15): unknown / corrupt / forward-incompatible
      // states are normalized to "idle" so the pending check below sees
      // st==="idle" and skips them — matches the IIFE's `else{st="idle";ag.idle++}`.
      // (The prior `else ag.idle++;` left st at the unknown value, so
      // state="foo"+pending:true still lit 🔵.)
      else {
        st = 'idle';
        ag.idle++;
      }
      // pending INDEPENDENT of state, with idle-GC: a session downgraded to idle
      // above does NOT count toward 🔵 (kills the stale-blue-light false-stick).
      // ORDER MATTERS: this check MUST run AFTER the three decay branches above
      // (test-iife.mjs IIFE.29b locks the same ordering at the source level).
      if (j.pending === true && st !== 'idle') ag.pending++;
    } catch {
      /* per-file JSON error — skip */
    }
  }
  return ag;
}

// cap() — exact replica of the IIFE's `var cap=function(n){return n>=4?4:n;}`.
function cap(n) {
  return n >= 4 ? 4 : n;
}

// sbiBlockText(n) — digit-only replica of the v0.1.16 IIFE's per-SBI text
// rule's DIGIT component. The full v0.1.16 rule is
//   `sbi.text=(n===0?DIM_EM:CFG[k].em)+(n>=4?"N":""+n)`
// — this function returns just the digit/"N" part (and "0" for the zero
// case so callers can compare a 4-array of digit-strings cleanly).
// n===0 → "0" (paired with 🟤 in the IIFE since the v0.1.17 ⚪→🟤 pivot); n=1/2/3 → digit (paired with
// the light's colored ball in the IIFE); n>=4 (capped to 4) → "N".
// (v0.1.14 used disp(em,n) that joined emoji+digit; v0.1.15 splits into 4
// SBIs with digit-in-colored-block; v0.1.16 splits into 4 SBIs with emoji-
// ball+digit. This replica tracks only the digit-capping behavior shared
// across v0.1.15 and v0.1.16 — the emoji prepend is exercised in
// test-iife.mjs IIFE.38.)
function sbiBlockText(n) {
  return n === 0 ? '0' : n >= 4 ? 'N' : String(n);
}

// Compute the 4 per-SBI texts the IIFE would push for an aggregation. Returns
// an array [doneText, runningText, pendingText, interruptedText]. Fixed order
// done/running/pending/interrupted matches CFG[]/counts[] in the IIFE.
function sbiTexts(ag) {
  return [
    sbiBlockText(cap(ag.done)),
    sbiBlockText(cap(ag.running)),
    sbiBlockText(cap(ag.pending)),
    sbiBlockText(cap(ag.interrupted)),
  ];
}

// --- State file / HOME helpers ---------------------------------------------
function newTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-smoke-'));
}

function stateDir(home) {
  return path.join(home, '.claude', 'cc-tab-status');
}

/** Write a raw status object. `opts.ageMs` backdates mtime via utimesSync so
 *  the stale-running / interrupted-retention / done-decay branches can be
 *  exercised without waiting. */
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

/** Delete one session file (simulates SessionEnd cleanup or user closing tab). */
function removeStatus(home, sid) {
  try {
    fs.unlinkSync(path.join(stateDir(home), sid + '.json'));
  } catch {
    /* already gone */
  }
}

function readStatus(home, sid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(home), sid + '.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Fire one hook event against the REAL cc-status.js writer under an isolated
 *  HOME. Sets BOTH HOME and USERPROFILE so os.homedir() resolves under POSIX
 *  and Windows. */
function fireHook(home, sid, event, extra = {}) {
  const payload = Object.assign({ hook_event_name: event, session_id: sid }, extra);
  spawnSync(process.execPath, [CC_STATUS], {
    input: JSON.stringify(payload),
    env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }),
    encoding: 'utf8',
  });
  return readStatus(home, sid);
}

// --- Journey log helpers (cosmetic — make the BEFORE/AFTER narrative read) ---
function dimOf(ag) {
  // Return a 4-char string showing which blocks are dim ("0") vs lit ("●")
  // purely for the journey log. Not consumed by assertions.
  return [ag.done, ag.running, ag.pending, ag.interrupted].map((n) => (n === 0 ? '0' : '●')).join('');
}

function logPhase(title) {
  console.log('\n--- ' + title + ' ---');
}

function logStep(label, home, expectedTexts, expectedAg) {
  const ag = aggregate(home);
  const texts = sbiTexts(ag);
  const agStr =
    '{done:' +
    ag.done +
    ', running:' +
    ag.running +
    ', pending:' +
    ag.pending +
    ', interrupted:' +
    ag.interrupted +
    ', idle:' +
    ag.idle +
    '}';
  console.log('    step: ' + label);
  console.log('      ag = ' + agStr + '   blocks=' + dimOf(ag));
  console.log('      SBI texts = ' + JSON.stringify(texts));
  if (expectedTexts !== undefined) {
    check(
      'SBI texts === ' + JSON.stringify(expectedTexts),
      JSON.stringify(texts) === JSON.stringify(expectedTexts),
      'got=' + JSON.stringify(texts),
    );
  }
  if (expectedAg !== undefined) {
    for (const k of Object.keys(expectedAg)) {
      check('ag.' + k + ' === ' + expectedAg[k], ag[k] === expectedAg[k], 'got ag.' + k + '=' + ag[k]);
    }
  }
  return ag;
}

// ===========================================================================
// THE JOURNEY
// ===========================================================================
console.log('SBI user-journey smoke test (v0.1.15)');
console.log('(real cc-status.js writer + replica IIFE aggregation, isolated HOME)');
console.log('Legend: 🟢done  🟡running  🔵pending  🔴interrupted  0=dim block  ● colored block (non-zero)');

let home;
try {
  home = newTempHome();
} catch (e) {
  console.error('setup failed: ' + e.message);
  process.exit(1);
}

// === §0  Cold start — empty editor =========================================
logPhase('§0  Cold start — no CC tabs open');
// State dir does not even exist yet (fresh HOME). Aggregation must NOT throw.
{
  const ag = aggregate(home);
  const texts = sbiTexts(ag);
  console.log('    ag = {all zeros}   blocks=' + dimOf(ag));
  console.log('    SBI texts = ' + JSON.stringify(texts));
  check('§0a  cold-start ag all zeros', ag.done === 0 && ag.running === 0 && ag.pending === 0 && ag.interrupted === 0);
  check(
    '§0b  cold-start SBI all dim ["0","0","0","0"]',
    JSON.stringify(texts) === '["0","0","0","0"]',
    'texts=' + JSON.stringify(texts),
  );
}

// === §1  Open first tab — 1 running ========================================
logPhase('§1  Open first CC tab — session A starts running');
// Drive through the real writer so the journey exercises the writer→reader chain.
fireHook(home, 'A', 'UserPromptSubmit');
logStep('A: UserPromptSubmit', home, ['0', '1', '0', '0'], {
  running: 1,
  done: 0,
  pending: 0,
  interrupted: 0,
  idle: 0,
});

// === §2  Open more tabs — count grows 2 → 3 → N (cap@4+) ====================
logPhase('§2  Spawn more tabs — 🟡 count grows through 2 / 3 / N (cap clamps 4+ to "N")');
fireHook(home, 'B', 'UserPromptSubmit');
logStep('B: UserPromptSubmit (2 running)', home, ['0', '2', '0', '0'], { running: 2 });
fireHook(home, 'C', 'UserPromptSubmit');
logStep('C: UserPromptSubmit (3 running)', home, ['0', '3', '0', '0'], { running: 3 });
// Cap boundary: 4 sessions → "N" (the cap() variant), not literal "4".
fireHook(home, 'D', 'UserPromptSubmit');
logStep('D: UserPromptSubmit (4 running → cap=4 → "N")', home, ['0', 'N', '0', '0'], { running: 4 });
// 5 sessions — still "N" (cap stays at 4 once you cross it).
fireHook(home, 'E', 'UserPromptSubmit');
logStep('E: UserPromptSubmit (5 running → still "N")', home, ['0', 'N', '0', '0'], { running: 5 });

// === §3  Some finish, one crashes ===========================================
logPhase('§3  A finishes (done), C crashes (interrupted) — three different lights turn on');
fireHook(home, 'A', 'Stop'); // A → done
// For C, simulate a crash via StopFailure (writer marks interrupted).
fireHook(home, 'C', 'StopFailure', { error: 'rate_limit' }); // C → interrupted
logStep(
  'A: Stop (done)  C: StopFailure (interrupted)',
  home,
  // 1 done + 3 running (B,D,E) + 0 pending + 1 interrupted → ["1","3","0","1"]
  ['1', '3', '0', '1'],
  { done: 1, running: 3, pending: 0, interrupted: 1 },
);

// === §4  Permission prompt — 🔵 pending INDEPENDENT of state ================
logPhase('§4  D hits a permission prompt — 🔵 pending lights INDEPENDENT of running state');
// Writer's Notification hook sets pending=true while PRESERVING state=running.
// The 🔵 light must count this session WITHOUT removing it from the 🟡 running
// count (the user's running+pending typical case).
fireHook(home, 'D', 'Notification');
{
  const onDisk = readStatus(home, 'D');
  check(
    '§4-writer  Notification preserves state=running',
    onDisk && onDisk.state === 'running',
    'state=' + (onDisk && onDisk.state),
  );
  check(
    '§4-writer  Notification sets pending=true',
    onDisk && onDisk.pending === true,
    'pending=' + (onDisk && onDisk.pending),
  );
}
logStep(
  'D: Notification (running + pending)',
  home,
  // done=1, running=3 (B,D,E — D is BOTH running and pending), pending=1, interrupted=1
  ['1', '3', '1', '1'],
  { done: 1, running: 3, pending: 1, interrupted: 1 },
);

// === §5  All 4 lights lit ===================================================
logPhase('§5  Confirm ALL 4 lights lit simultaneously (the v0.1.15 4-light headline)');
{
  const ag = aggregate(home);
  check('§5a  🟢 done > 0', ag.done > 0);
  check('§5b  🟡 running > 0', ag.running > 0);
  check('§5c  🔵 pending > 0', ag.pending > 0);
  check('§5d  🔴 interrupted > 0', ag.interrupted > 0);
  // No dim "0" in the SBI texts — all 4 blocks are lit (non-zero).
  const texts = sbiTexts(ag);
  check('§5e  SBI texts contain NO "0" (all 4 blocks lit)', !texts.includes('0'), 'texts=' + JSON.stringify(texts));
  // §5f locks the literal form of a fully-lit 4-block SBI. At this step
  // (per §3 + §4) the counts are concrete: done=1, running=3, pending=1,
  // interrupted=1. Each non-zero block renders as its digit. Asserting the
  // exact array is the cleanest way to lock both the per-block form AND the
  // fixed left→right order (done/running/pending/interrupted).
  check(
    '§5f  SBI texts exactly ["1","3","1","1"] (4 colored blocks, fixed order)',
    JSON.stringify(texts) === '["1","3","1","1"]',
    'texts=' + JSON.stringify(texts),
  );
}

// === §6  Coffee break — idle decay (灰不计绿) ===============================
logPhase('§6  Coffee break — idle decay kicks in (灰/idle sessions do NOT light 🟢)');
// Close B and E (clean Stop) so the only running is D (which also holds pending).
fireHook(home, 'B', 'Stop'); // B → done
fireHook(home, 'E', 'Stop'); // E → done
// Now: done=3 (A,B,E), running=1 (D), pending=1 (D), interrupted=1 (C)
logStep('B,E: Stop → done (now 3 done + 1 running+pending + 1 interrupted)', home, ['3', '1', '1', '1'], {
  done: 3,
  running: 1,
  pending: 1,
  interrupted: 1,
});

// Time-travel: 10 minutes pass. A's done (since=10min-ago-ish) decays to idle
// — the 🟢 light should DROP by however many sessions crossed the 5-min line,
// because IDLE sessions are NOT counted as done (灰不计绿).
// We simulate this by manually aging the done files' `since` field to >5min ago.
// (The writer's `since` is the completion timestamp; reading happens at "now".)
{
  // Pick the first done session (A) and backdate its `since` to 6min ago.
  // stat() mtime is fresh (just written) so the file itself is "live" — only
  // `since` is old, which is the done-decay trigger.
  const aPath = path.join(stateDir(home), 'A.json');
  const j = JSON.parse(fs.readFileSync(aPath, 'utf8'));
  j.since = Date.now() - 6 * 60 * 1000; // 6min ago — past DONE_TO_IDLE_MS
  fs.writeFileSync(aPath, JSON.stringify(j, null, 2));
}
logStep(
  'A: done.since aged to 6min ago (past 5min decay) → A is now idle (NOT green)',
  home,
  // done drops 3→2 (A decayed), running=1 (D), pending=1 (D), interrupted=1 (C)
  ['2', '1', '1', '1'],
  { done: 2, running: 1, pending: 1, interrupted: 1, idle: 1 },
);

// === §7  Crashed-mid-permission GC (stale-blue-light fix) ===================
logPhase('§7  D crashed mid-permission 30+ min ago — both 🟡 and 🔵 must drop (stale-blue fix)');
// D is running+pending. Backdate D's `since` to 31min ago so §7.2 stale-running
// decay fires (D→idle). Pending on an idle-decayed session MUST NOT count toward 🔵
// — otherwise a crashed session killed mid-permission would false-stick 🔵 forever.
// v0.2.6 round-1: decay now keys off `since` (the *→running transition time),
// NOT mtime — the prior mtime-based rule was defeated by cc-status.js:390-401
// Stop preserveSince path (mtime refreshed by every Stop heartbeat; since
// preserved). Test now backdates `since` directly (was: utimes mtime only).
// mtime is also backdated for symmetry with the real-crash scenario (both old).
{
  const dPath = path.join(stateDir(home), 'D.json');
  const j = JSON.parse(fs.readFileSync(dPath, 'utf8'));
  // since must be >30min stale. Rewrite the file with an aged since, then
  // utimes mtime to match (both stale — mirrors a real crashed process whose
  // last hook fire wrote the file 31min ago and never wrote again).
  j.since = Date.now() - 31 * 60 * 1000;
  fs.writeFileSync(dPath, JSON.stringify(j, null, 2));
  const past = new Date(Date.now() - 31 * 60 * 1000);
  fs.utimesSync(dPath, past, past);
}
logStep(
  'D: since aged to 31min (past stale-running threshold) → D idle, pending NOT counted',
  home,
  // D decayed from running to idle. running drops 1→0 (D was the only running),
  // pending drops 1→0 (D held pending but is now idle — stale-blue fix).
  // done=2 (B,E), interrupted=1 (C), idle=2 (A,D).
  ['2', '0', '0', '1'],
  { done: 2, running: 0, pending: 0, interrupted: 1, idle: 2 },
);

// === §8  Close all tabs — back to all dim ===================================
logPhase('§8  Close all tabs — editor returns to all-dim');
// Remove every session file (simulates SessionEnd firing on each as tabs close).
for (const sid of ['A', 'B', 'C', 'D', 'E']) {
  removeStatus(home, sid);
}
logStep('all sessions removed (SessionEnd)', home, ['0', '0', '0', '0'], {
  done: 0,
  running: 0,
  pending: 0,
  interrupted: 0,
  idle: 0,
});

// === §9  Bonus: explicit 0→1→2→3→N cap sweep for EACH light ================
// The journey above naturally sweeps the running light through 0..N. This block
// sweeps each of the OTHER three lights (done / pending / interrupted) through
// the same cap progression in isolation, so the 0-dim / non0-lit / 0-3-digit /
// N-cap contract is asserted per light (not just running).
logPhase('§9  Per-light cap sweep — 0→1→2→3→N for done, pending, interrupted (isolated)');

function capSweep(stateName, lightIdx, plant, opts = {}) {
  // plant(count, home) writes `count` sessions of the target state into home.
  // opts.otherLights = { lightIdx: countFn(n), ... } — for lights OTHER than the
  //   target that will ALSO light up because of how the plant works. Default {}
  //   means "all other lights are 0/dim" (true for done / interrupted sweeps).
  //   The pending sweep plants running+pending sessions (pending REQUIRES a non-
  //   idle state — there is NO way to plant pending without also lighting some
  //   state light), so its `otherLights` is { 1: (n) => n } (running lit too).
  // For each count 0..5 we build the EXPECTED 4-block texts array directly and
  // compare to the actual sbiTexts().
  const otherLights = opts.otherLights || {};
  const allIdx = [0, 1, 2, 3];
  for (const n of [0, 1, 2, 3, 4, 5]) {
    const h = newTempHome();
    if (n > 0) plant(n, h);
    const ag = aggregate(h);
    const texts = sbiTexts(ag);
    // Build expected: 4 block texts, fixed order. Default every block to "0",
    // then set the target block AND any co-lit blocks from otherLights.
    const rawCounts = { 0: 0, 1: 0, 2: 0, 3: 0 };
    rawCounts[lightIdx] = n; // target light's raw (uncapped) count
    for (const i of allIdx) {
      if (otherLights[i]) rawCounts[i] = otherLights[i](n);
    }
    const expected = allIdx.map((i) => sbiBlockText(cap(rawCounts[i])));
    check(
      stateName + ' x' + n + ' → SBI texts === ' + JSON.stringify(expected),
      JSON.stringify(texts) === JSON.stringify(expected),
      'got=' + JSON.stringify(texts),
    );
    // Assert each OTHER block matches its expected text ("0" by default, or the
    // co-lit count if the plant makes it light up too).
    for (const i of allIdx) {
      if (i === lightIdx) continue;
      const expectedOther = sbiBlockText(cap(rawCounts[i]));
      check(
        stateName +
          ' x' +
          n +
          ' → block[' +
          i +
          '] (' +
          ['done', 'running', 'pending', 'interrupted'][i] +
          ') === ' +
          JSON.stringify(expectedOther),
        JSON.stringify(texts) === JSON.stringify(expected) && texts[i] === expectedOther,
        'expected=' + JSON.stringify(expectedOther),
      );
    }
    // The target light's raw (uncapped) aggregation count must equal n — proves
    // aggregation counted every planted session, independent of the cap() display.
    const agField = ['done', 'running', 'pending', 'interrupted'][lightIdx];
    check(
      stateName + ' x' + n + ' → ag.' + agField + ' === ' + n + ' (uncapped)',
      ag[agField] === n,
      'ag.' + agField + '=' + ag[agField],
    );
  }
}

capSweep('done', 0, (n, h) => {
  for (let i = 0; i < n; i++)
    writeStatus(h, 'd' + i, { state: 'done', since: Date.now(), activeSubagents: 0, pending: false });
});
// pending sweep: plant running+pending sessions (pending REQUIRES a non-idle
// state — the most natural is running). The 🟡 running light is ALSO lit at
// the same count n; we declare that via otherLights so the assertion accounts
// for it. This is the user's "running+pending typical case" made explicit.
capSweep(
  'pending',
  2,
  (n, h) => {
    for (let i = 0; i < n; i++)
      writeStatus(h, 'p' + i, { state: 'running', since: Date.now(), activeSubagents: 0, pending: true });
  },
  { otherLights: { 1: (n) => n } }, // 🟡 running co-lit at count n
);
capSweep('interrupted', 3, (n, h) => {
  for (let i = 0; i < n; i++)
    writeStatus(h, 'i' + i, {
      state: 'interrupted',
      since: Date.now(),
      error: 'rate_limit',
      activeSubagents: 0,
      pending: false,
    });
});

// === §10  Interrupted >24h decay keyed on `since` (not mtime) ===============
// v0.2.5 round-2 e2e medium: this phase exercises the IIFE §7.5 rule that the
// smoke-journey replica now mirrors (changed from mtime-keyed to since-keyed
// decay). Plant an interrupted session whose `since` is 25h ago but whose
// mtime is FRESH (simulating an orphan SubagentStop/Notification write that
// refreshed mtime via cc-status.js's preserveSince/preserveError paths). The
// IIFE MUST decay this session to idle (the mtime-based variant would NOT,
// since the orphan write reset the mtime clock). Pre-fix the smoke-journey
// replica's mtime-based branch never fired under this scenario (silent
// divergence from the IIFE source the journey file claims to mirror).
logPhase('§10  Interrupted >24h decays via `since` (not mtime — orphan-write-proof)');
{
  const h = newTempHome();
  // Session X crashed 25h ago (since=Date.now()-25h), but an orphan write
  // (SubagentStop arriving after the crash) refreshed its mtime to NOW. The
  // IIFE's §7.5 rule decays interrupted→idle when since>24h regardless of
  // mtime. So the count MUST be: interrupted=0 (decayed to idle), idle=1.
  const oldSince = Date.now() - 25 * 60 * 60 * 1000;
  writeStatus(h, 'X', {
    state: 'interrupted',
    since: oldSince,
    error: 'interrupted',
    activeSubagents: 0,
    pending: false,
  });
  // Touch the file's mtime to "now" — simulates an orphan write that landed
  // AFTER the crash. mtime-based decay would NOT fire (mtime is fresh); the
  // since-based decay (correct) DOES fire.
  const xPath = path.join(stateDir(h), 'X.json');
  const fresh = new Date();
  fs.utimesSync(xPath, fresh, fresh);
  // Aggregate with default `now` (Date.now). X has since=now-25h → decay fires.
  const got = aggregate(h);
  const ok = got.interrupted === 0 && got.idle === 1;
  if (ok) {
    pass++;
    console.log('  PASS  §10.1 interrupted since>24h → idle (orphan-write mtime refresh does NOT prevent decay)');
  } else {
    fail++;
    console.log(
      '  FAIL  §10.1 expected interrupted=0 idle=1, got ' +
        JSON.stringify(got) +
        ' (mtime-based decay would have left interrupted=1; the IIFE source uses since-based)',
    );
  }
  // cleanup
  try {
    fs.rmSync(h, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// cleanup the journey's shared HOME (best-effort; tempdir will reap on reboot)
try {
  fs.rmSync(home, { recursive: true, force: true });
} catch {
  /* best-effort */
}

// ===========================================================================
// summary
// ===========================================================================
console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  console.error('\n*** ' + fail + ' JOURNEY SMOKE TEST(S) FAILED — see above ***');
  process.exit(1);
}
console.log('\nAll SBI user-journey smoke tests passed.');
process.exit(0);
