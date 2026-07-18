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
 *     0→1→2→3→N cap progression, the "dim ⚪ ↔ colored+digit" flip, the
 *     "blue pending is INDEPENDENT of state" claim, and the "idle decay
 *     does NOT light green" claim are all narrated in one place so a future
 *     regression in any of them surfaces as a broken step in the journey,
 *     not just an isolated assertion failure.
 *   - Mirrors the task's explicit ask: 多会话状态(running/done/pending/
 *     interrupted/idle) → 4 灯统计 + text 拼接(0-3+N 封顶, 0 灭⚪/非0亮,
 *     蓝 pending, 灰不计绿).
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
 * Phases (each prints BEFORE → AFTER SBI.text so the journey reads top-down):
 *   §0  Cold start — empty editor, SBI all dim ⚪ ⚪ ⚪ ⚪
 *   §1  Open first tab — 1 running → "⚪ 🟡1 ⚪ ⚪"
 *   §2  Open more tabs — count grows through 2 / 3 / N (cap@4+)
 *   §3  Some finish, one crashes — done + interrupted lit, running drops
 *   §4  Permission prompt fires — 🔵 pending INDEPENDENT of running state
 *   §5  All 4 lights lit — done + running + pending + interrupted
 *   §6  Coffee break — idle decay: 5min done / 30min running / 24h interrupted
 *       all decay to idle; IDLE sessions do NOT light 🟢 (灰不计绿)
 *   §7  Crashed-mid-permission GC — pending on an idle-decayed session does
 *       NOT false-stick 🔵 (stale-blue-light fix)
 *   §8  Close all tabs — back to ⚪ ⚪ ⚪ ⚪
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
const DONE_TO_IDLE_MS = 5 * 60 * 1000; // 5 min — §4 done→idle
const SBI_RUNNING_STALE_MS = 30 * 60 * 1000; // 30 min — §7.2 stale-running GC
const INTERRUPTED_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h — 🔴 retention cap

// The 4 SBI lights in fixed left→right display order, plus the dim emoji.
// Mirror patch.ts SBI_LIGHTS (single source of truth). Order matches the IIFE's
// `var EM=[...]` array: done(🟢) / running(🟡) / pending(🔵) / interrupted(🔴),
// shared dim ⚪.
const SBI_LIGHT_EMOJI = ['\u{1F7E2}', '\u{1F7E1}', '\u{1F535}', '\u{1F534}']; // 🟢 🟡 🔵 🔴
const SBI_DIM_EMOJI = '\u{26AA}'; // ⚪
// Human-readable names for the journey log (purely cosmetic — not consumed by logic).
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
// does. `now` is injectable so the "coffee break" phase can time-travel without
// real waiting. Returns the raw uncapped counts.
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
      // §7.2 stale-running mtime>30min → idle
      else if (st === 'running') {
        let mt = 0;
        try {
          mt = fs.statSync(fp).mtimeMs;
        } catch {
          /* keep mt=0 — won't decay */
        }
        if (mt && now - mt > SBI_RUNNING_STALE_MS) st = 'idle';
      }
      // interrupted mtime>24h → idle (bounds 🔴 growth)
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
      else ag.idle++; // includes unknown / corrupt / forward-incompatible states
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

// disp() — exact replica of the IIFE's
//   `var disp=function(em,n){return n===0?DIM:(em+" "+(n>=4?"N":n));};`
function disp(em, n) {
  return n === 0 ? SBI_DIM_EMOJI : em + ' ' + (n >= 4 ? 'N' : n);
}

// Compute SBI.text from raw aggregation. Fixed order done/running/pending/
// interrupted, joined with single space.
function sbiText(ag) {
  return [
    disp(SBI_LIGHT_EMOJI[0], cap(ag.done)),
    disp(SBI_LIGHT_EMOJI[1], cap(ag.running)),
    disp(SBI_LIGHT_EMOJI[2], cap(ag.pending)),
    disp(SBI_LIGHT_EMOJI[3], cap(ag.interrupted)),
  ].join(' ');
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
  // Return a 4-char string showing which lights are dim (⚪) vs colored (●)
  // purely for the journey log. Not consumed by assertions.
  return [ag.done, ag.running, ag.pending, ag.interrupted].map((n) => (n === 0 ? SBI_DIM_EMOJI : '●')).join('');
}

function logPhase(title) {
  console.log('\n--- ' + title + ' ---');
}

function logStep(label, home, expectedText, expectedAg) {
  const ag = aggregate(home);
  const text = sbiText(ag);
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
  console.log('      ag = ' + agStr + '   lights=' + dimOf(ag));
  console.log('      SBI.text = ' + JSON.stringify(text));
  if (expectedText !== undefined) {
    check('SBI.text === ' + JSON.stringify(expectedText), text === expectedText, 'got=' + text);
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
console.log('SBI user-journey smoke test (v0.1.14)');
console.log('(real cc-status.js writer + replica IIFE aggregation, isolated HOME)');
console.log('Legend: 🟢done  🟡running  🔵pending  🔴interrupted  ⚪dim(0)  ● colored(non-zero)');

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
  const text = sbiText(ag);
  console.log('    ag = {all zeros}   lights=' + dimOf(ag));
  console.log('    SBI.text = ' + JSON.stringify(text));
  check('§0a  cold-start ag all zeros', ag.done === 0 && ag.running === 0 && ag.pending === 0 && ag.interrupted === 0);
  check(
    '§0b  cold-start SBI all dim ⚪ ⚪ ⚪ ⚪',
    text === [SBI_DIM_EMOJI, SBI_DIM_EMOJI, SBI_DIM_EMOJI, SBI_DIM_EMOJI].join(' '),
    'text=' + text,
  );
}

// === §1  Open first tab — 1 running ========================================
logPhase('§1  Open first CC tab — session A starts running');
// Drive through the real writer so the journey exercises the writer→reader chain.
fireHook(home, 'A', 'UserPromptSubmit');
logStep(
  'A: UserPromptSubmit',
  home,
  SBI_DIM_EMOJI + ' ' + SBI_LIGHT_EMOJI[1] + ' 1 ' + SBI_DIM_EMOJI + ' ' + SBI_DIM_EMOJI,
  { running: 1, done: 0, pending: 0, interrupted: 0, idle: 0 },
);

// === §2  Open more tabs — count grows 2 → 3 → N (cap@4+) ====================
logPhase('§2  Spawn more tabs — 🟡 count grows through 2 / 3 / N (cap clamps 4+ to "N")');
fireHook(home, 'B', 'UserPromptSubmit');
logStep(
  'B: UserPromptSubmit (2 running)',
  home,
  SBI_DIM_EMOJI + ' ' + SBI_LIGHT_EMOJI[1] + ' 2 ' + SBI_DIM_EMOJI + ' ' + SBI_DIM_EMOJI,
  { running: 2 },
);
fireHook(home, 'C', 'UserPromptSubmit');
logStep(
  'C: UserPromptSubmit (3 running)',
  home,
  SBI_DIM_EMOJI + ' ' + SBI_LIGHT_EMOJI[1] + ' 3 ' + SBI_DIM_EMOJI + ' ' + SBI_DIM_EMOJI,
  { running: 3 },
);
// Cap boundary: 4 sessions → "N" (the cap() variant), not literal "4".
fireHook(home, 'D', 'UserPromptSubmit');
logStep(
  'D: UserPromptSubmit (4 running → cap=4 → "N")',
  home,
  SBI_DIM_EMOJI + ' ' + SBI_LIGHT_EMOJI[1] + ' N ' + SBI_DIM_EMOJI + ' ' + SBI_DIM_EMOJI,
  { running: 4 },
);
// 5 sessions — still "N" (cap stays at 4 once you cross it).
fireHook(home, 'E', 'UserPromptSubmit');
logStep(
  'E: UserPromptSubmit (5 running → still "N")',
  home,
  SBI_DIM_EMOJI + ' ' + SBI_LIGHT_EMOJI[1] + ' N ' + SBI_DIM_EMOJI + ' ' + SBI_DIM_EMOJI,
  { running: 5 },
);

// === §3  Some finish, one crashes ===========================================
logPhase('§3  A finishes (done), C crashes (interrupted) — three different lights turn on');
fireHook(home, 'A', 'Stop'); // A → done
// For C, simulate a crash via StopFailure (writer marks interrupted).
fireHook(home, 'C', 'StopFailure', { error: 'rate_limit' }); // C → interrupted
logStep(
  'A: Stop (done)  C: StopFailure (interrupted)',
  home,
  // 1 done + 3 running (B,D,E) + 0 pending + 1 interrupted → "🟢1 🟡 N ⚪ 🔴1"
  // running is still 3 but cap shows "N" — wait, 3 sessions = literal "3", not N.
  // Recompute: B,D,E running = 3 → literal "3" (not "N"). done=1, interrupted=1.
  SBI_LIGHT_EMOJI[0] + ' 1 ' + SBI_LIGHT_EMOJI[1] + ' 3 ' + SBI_DIM_EMOJI + ' ' + SBI_LIGHT_EMOJI[3] + ' 1',
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
  SBI_LIGHT_EMOJI[0] + ' 1 ' + SBI_LIGHT_EMOJI[1] + ' 3 ' + SBI_LIGHT_EMOJI[2] + ' 1 ' + SBI_LIGHT_EMOJI[3] + ' 1',
  { done: 1, running: 3, pending: 1, interrupted: 1 },
);

// === §5  All 4 lights lit ===================================================
logPhase('§5  Confirm ALL 4 lights lit simultaneously (the v0.1.14 4-light headline)');
{
  const ag = aggregate(home);
  check('§5a  🟢 done > 0', ag.done > 0);
  check('§5b  🟡 running > 0', ag.running > 0);
  check('§5c  🔵 pending > 0', ag.pending > 0);
  check('§5d  🔴 interrupted > 0', ag.interrupted > 0);
  // No dim ⚪ in the SBI text — all 4 lights are colored (non-zero).
  const text = sbiText(ag);
  check('§5e  SBI.text contains NO dim ⚪', !text.includes(SBI_DIM_EMOJI), 'text=' + text);
  // §5f locks the literal form of a fully-lit 4-light SBI.text. At this step
  // (per §3 + §4) the counts are concrete: done=1, running=3, pending=1,
  // interrupted=1. Each non-zero light renders as "EMOJI + space + digit-or-N",
  // so the full text has 4 light groups joined by single spaces (8 raw tokens
  // after .split(' '), since each colored light is 2 tokens). Asserting the
  // exact literal is the cleanest way to lock both the per-light form AND the
  // fixed left→right order (done/running/pending/interrupted).
  check(
    '§5f  SBI.text exact form "🟢 1 🟡 3 🔵 1 🔴 1" (4 colored lights, fixed order)',
    text ===
      SBI_LIGHT_EMOJI[0] + ' 1 ' + SBI_LIGHT_EMOJI[1] + ' 3 ' + SBI_LIGHT_EMOJI[2] + ' 1 ' + SBI_LIGHT_EMOJI[3] + ' 1',
    'text=' + text,
  );
}

// === §6  Coffee break — idle decay (灰不计绿) ===============================
logPhase('§6  Coffee break — idle decay kicks in (灰/idle sessions do NOT light 🟢)');
// Close B and E (clean Stop) so the only running is D (which also holds pending).
fireHook(home, 'B', 'Stop'); // B → done
fireHook(home, 'E', 'Stop'); // E → done
// Now: done=3 (A,B,E), running=1 (D), pending=1 (D), interrupted=1 (C)
logStep(
  'B,E: Stop → done (now 3 done + 1 running+pending + 1 interrupted)',
  home,
  SBI_LIGHT_EMOJI[0] + ' 3 ' + SBI_LIGHT_EMOJI[1] + ' 1 ' + SBI_LIGHT_EMOJI[2] + ' 1 ' + SBI_LIGHT_EMOJI[3] + ' 1',
  { done: 3, running: 1, pending: 1, interrupted: 1 },
);

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
  SBI_LIGHT_EMOJI[0] + ' 2 ' + SBI_LIGHT_EMOJI[1] + ' 1 ' + SBI_LIGHT_EMOJI[2] + ' 1 ' + SBI_LIGHT_EMOJI[3] + ' 1',
  { done: 2, running: 1, pending: 1, interrupted: 1, idle: 1 },
);

// === §7  Crashed-mid-permission GC (stale-blue-light fix) ===================
logPhase('§7  D crashed mid-permission 30+ min ago — both 🟡 and 🔵 must drop (stale-blue fix)');
// D is running+pending. Backdate D's mtime to 31min so §7.2 stale-running decay
// fires (D→idle). Pending on an idle-decayed session MUST NOT count toward 🔵
// — otherwise a crashed session killed mid-permission would false-stick 🔵 forever.
{
  const dPath = path.join(stateDir(home), 'D.json');
  const j = JSON.parse(fs.readFileSync(dPath, 'utf8'));
  // mtime must be >30min stale. utimes the file (since is NOT the decay key for
  // running — mtime is; §1.6a-decouple in test-sbi-aggregation.mjs locks this).
  const past = new Date(Date.now() - 31 * 60 * 1000);
  fs.utimesSync(dPath, past, past);
}
logStep(
  'D: mtime aged to 31min (past stale-running threshold) → D idle, pending NOT counted',
  home,
  // D decayed from running to idle. running drops 1→0 (D was the only running),
  // pending drops 1→0 (D held pending but is now idle — stale-blue fix).
  // done=2 (B,E), interrupted=1 (C), idle=2 (A,D).
  SBI_LIGHT_EMOJI[0] + ' 2 ' + SBI_DIM_EMOJI + ' ' + SBI_DIM_EMOJI + ' ' + SBI_LIGHT_EMOJI[3] + ' 1',
  { done: 2, running: 0, pending: 0, interrupted: 1, idle: 2 },
);

// === §8  Close all tabs — back to ⚪ ⚪ ⚪ ⚪ =================================
logPhase('§8  Close all tabs — editor returns to all-dim');
// Remove every session file (simulates SessionEnd firing on each as tabs close).
for (const sid of ['A', 'B', 'C', 'D', 'E']) {
  removeStatus(home, sid);
}
logStep(
  'all sessions removed (SessionEnd)',
  home,
  [SBI_DIM_EMOJI, SBI_DIM_EMOJI, SBI_DIM_EMOJI, SBI_DIM_EMOJI].join(' '),
  { done: 0, running: 0, pending: 0, interrupted: 0, idle: 0 },
);

// === §9  Bonus: explicit 0→1→2→3→N cap sweep for EACH light ================
// The journey above naturally sweeps the running light through 0..N. This block
// sweeps each of the OTHER three lights (done / pending / interrupted) through
// the same cap progression in isolation, so the 0-灭⚪ / 非0-亮 / 0-3-digit /
// N-cap contract is asserted per light (not just running).
logPhase('§9  Per-light cap sweep — 0→1→2→3→N for done, pending, interrupted (isolated)');

function capSweep(stateName, lightIdx, plant, opts = {}) {
  // plant(count, home) writes `count` sessions of the target state into home.
  // opts.otherLights = { lightIdx: countFn(n), ... } — for lights OTHER than the
  //   target that will ALSO light up because of how the plant works. Default {}
  //   means "all other lights are dim ⚪" (true for done / interrupted sweeps).
  //   The pending sweep plants running+pending sessions (pending REQUIRES a non-
  //   idle state — there is NO way to plant pending without also lighting some
  //   state light), so its `otherLights` is { 1: (n) => n } (running lit too).
  // For each count 0..5 we build the EXPECTED 4-light text directly (no split-
  // based indexing — the SBI text has variable token count per light, so
  // positional indexing is wrong) and compare to the actual sbiText().
  const otherLights = opts.otherLights || {};
  const allIdx = [0, 1, 2, 3];
  for (const n of [0, 1, 2, 3, 4, 5]) {
    const h = newTempHome();
    if (n > 0) plant(n, h);
    const ag = aggregate(h);
    const text = sbiText(ag);
    // Build expected: 4 light slots, fixed order. Default every slot to dim ⚪,
    // then set the target light AND any co-lit lights from otherLights.
    const slots = [SBI_DIM_EMOJI, SBI_DIM_EMOJI, SBI_DIM_EMOJI, SBI_DIM_EMOJI];
    const rawCounts = { 0: 0, 1: 0, 2: 0, 3: 0 };
    rawCounts[lightIdx] = n; // target light's raw (uncapped) count
    for (const i of allIdx) {
      if (otherLights[i]) rawCounts[i] = otherLights[i](n);
    }
    for (const i of allIdx) {
      slots[i] = disp(SBI_LIGHT_EMOJI[i], cap(rawCounts[i]));
    }
    const expected = slots.join(' ');
    check(stateName + ' x' + n + ' → SBI.text === ' + JSON.stringify(expected), text === expected, 'got=' + text);
    // Assert each OTHER light matches its expected form (dim by default, or the
    // co-lit count if the plant makes it light up too).
    for (const i of allIdx) {
      if (i === lightIdx) continue;
      const expectedOther = disp(SBI_LIGHT_EMOJI[i], cap(rawCounts[i]));
      check(
        stateName +
          ' x' +
          n +
          ' → light[' +
          i +
          '] (' +
          ['done', 'running', 'pending', 'interrupted'][i] +
          ') === ' +
          JSON.stringify(expectedOther),
        text === expected && slots[i] === expectedOther,
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
