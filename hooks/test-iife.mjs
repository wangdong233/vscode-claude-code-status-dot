#!/usr/bin/env node
/**
 * test-iife.mjs — Reader (injected IIFE) smoke test.
 *
 * The state machine has TWO independent implementations: the writer's
 * deriveStatus (covered by test-cc-status.js) and the reader's injected IIFE
 * (state→SVG, notify dedup, __ccPending yield, done→idle fallback, SBI 4-light
 * aggregation + text-mutation driver). Until v0.1.10 only the writer side had
 * automated coverage; the reader side relied on `assertCompiles` (syntax only).
 * This file nails the reader side to STATES.md §1/§4/§4b/§7 by extracting the
 * actual IIFE that patch.ts bakes (`--check-iife`) and asserting on its
 * contents + syntax-validity.
 *
 * It does NOT execute the IIFE — VSCode APIs (`vscode.window`, `setInterval`
 * on a fake panel) would need a heavy harness. String + `node --check`
 * assertions are enough to lock the public contract: which SVG each state
 * maps to, that dedup is `since`-based (not prevSt), that __ccPending yields,
 * that macOS notifications fall back to VSCode messages on osascript failure,
 * that the timer is disposed with the panel, AND (v0.1.14) that the SBI
 * 4-light aggregation builds the right text and disposes on last-panel-out.
 *
 * v0.1.14 surface pivot: the v0.1.13 commandCenter 4-light (20 package.json
 * contribs + setContext driver) is GONE. The aggregation now feeds a single
 * runtime createStatusBarItem at StatusBarAlignment.Left (priority -9999 →
 * rightmost among Left items → near visible center), text mutated in place
 * every 500ms. v0.1.13 design improvements preserved across the pivot: NEW
 * 🔵 pending light (independent of state), 3-way stale-session GC
 * (done>5min / running>30min / interrupted>24h), pending-with-idle-GC.
 *
 * Run:  node hooks/test-iife.mjs     (requires `npm run build` first; falls
 *                                    back to `npx tsx patch.ts` if dist/ is
 *                                    missing)
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

// Mirror patch.ts SBI_LIGHTS_CFG — single source of truth is patch.ts; this
// local copy must stay in sync. v0.1.15 replaced the v0.1.14 SBI_LIGHTS emoji
// array + SBI_DIM_EMOJI with this config table: each entry pins the light's
// background ThemeColor id (a VScode built-in statusBarItem.* color) and
// StatusBarItem.priority. Order matches the IIFE's `var CFG=[...]` array:
//   done(🟢) / running(🟡) / pending(🔵) / interrupted(🔴)
// Used to assert the IIFE bakes the same config via JSON.stringify in buildIIFE.
const SBI_LIGHTS_CFG = [
  { key: 'done', bg: 'statusBarItem.remoteBackground', pri: -9996 }, // 🟢 leftmost
  { key: 'running', bg: 'statusBarItem.warningBackground', pri: -9997 }, // 🟡
  { key: 'pending', bg: 'statusBarItem.prominentBackground', pri: -9998 }, // 🔵
  { key: 'interrupted', bg: 'statusBarItem.errorBackground', pri: -9999 }, // 🔴 rightmost
];

// --- Obtain the IIFE string via --check-iife ---------------------------------
function getIife() {
  if (fs.existsSync(DIST_PATCH)) {
    const r = spawnSync(process.execPath, [DIST_PATCH, '--check-iife'], { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error('--check-iife failed via dist/patch.js: ' + (r.stderr || ''));
    }
    return stripShellNoise(r.stdout);
  }
  // Dev fallback: no build yet, try tsx. Note in failure if it's missing too.
  const r = spawnSync('npx', ['tsx', 'patch.ts', '--check-iife'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(
      'dist/patch.js missing and `npx tsx patch.ts --check-iife` failed. ' +
        'Run `npm run build` first. stderr: ' +
        (r.stderr || ''),
    );
  }
  return stripShellNoise(r.stdout);
}

// Some shells print nvm/etc init noise to stdout when node spawns under a
// non-interactive profile. The IIFE always starts with the marker comment —
// keep everything from there onward.
function stripShellNoise(stdout) {
  const idx = stdout.indexOf('/*cc-status-dot-injected');
  if (idx < 0) {
    throw new Error('IIFE marker `/*cc-status-dot-injected` not found in --check-iife output');
  }
  return stdout.slice(idx);
}

let iife;
try {
  iife = getIife();
} catch (e) {
  console.error('test-iife: could not obtain IIFE: ' + e.message);
  process.exit(1);
}

console.log('Reader (IIFE) smoke tests');
console.log('(extracting buildIIFE() output via `node dist/patch.js --check-iife`)\n');

// --- 1. Syntax validity (the same gate patch.ts uses pre-write) -------------
{
  const tmp = path.join(os.tmpdir(), 'cc-status-iife-' + process.pid + '.js');
  fs.writeFileSync(tmp, iife, 'utf8');
  const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  check('IIFE.1  syntax (node --check on extracted IIFE)', r.status === 0, (r.stderr || '').trim());
  // Bracket balance (cheap sanity since we hand-edit the template literal).
  const pairs = [
    ['(', ')'],
    ['{', '}'],
    ['[', ']'],
  ];
  let bal = true;
  const detail = [];
  for (const [o, c] of pairs) {
    const oc = (iife.match(new RegExp('\\' + o, 'g')) || []).length;
    const cc = (iife.match(new RegExp('\\' + c, 'g')) || []).length;
    if (oc !== cc) {
      bal = false;
      detail.push(o + c + ': ' + oc + '/' + cc);
    }
  }
  check('IIFE.2  bracket balance () {} []', bal, detail.join(' '));
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* best-effort */
  }
}

// --- 2. State → SVG mapping (STATES.md §1) ----------------------------------
check('IIFE.3  running   -> claude-logo-running.svg', iife.includes('claude-logo-running.svg'));
check('IIFE.4  done      -> claude-logo-done.svg', iife.includes('claude-logo-done.svg'));
check('IIFE.5  idle      -> claude-logo-idle.svg', iife.includes('claude-logo-idle.svg'));
check('IIFE.6  interrupted -> claude-logo-error.svg', iife.includes('claude-logo-error.svg'));
// interrupted off-frame falls back to CC's claude-logo.svg (not one of ours).
check('IIFE.7  interrupted off-frame -> CC claude-logo.svg', iife.includes('claude-logo.svg'));

// --- 3. Notify dedup mechanism — since+seeded, NOT prevSt -------------------
// Locks the v0.1.5 algorithm change. A regression that revived the old prevSt
// transition check would silently miss fast turns (running→done between polls).
check('IIFE.8  dedup uses seeded flag', /seeded\s*=\s*true/.test(iife));
check('IIFE.9  dedup uses lastTermSince', /lastTermSince/.test(iife));
check('IIFE.10 dedup keyed on since change', /since\s*!==\s*lastTermSince/.test(iife));
check('IIFE.11 no prevSt field (old dedup)', !/\bprevSt\b/.test(iife));

// --- 4. Permission pending yield (STATES.md §1 v0.1.8) ----------------------
check('IIFE.12 __ccsdPending yield present', /if\s*\(\s*t\.__ccsdPending\s*\)\s*return/.test(iife));

// --- 5. done → idle 5-min fallback (STATES.md §4) ---------------------------
check('IIFE.13 DONE_TO_IDLE_MS constant', /DONE_TO_IDLE_MS/.test(iife));
check('IIFE.14 5min value (5*60*1000)', /5\s*\*\s*60\s*\*\s*1000/.test(iife));

// --- 6. macOS osascript path + VSCode fallback (M17) ------------------------
// The fallback is critical: without it, a notification permission denial or
// a missing/mis-escaped osascript would silently drop the feature on macOS.
check('IIFE.15 macOS osascript branch', /osascript/.test(iife));
check('IIFE.16 VSCode message fallback fn', /vs\.window\.show(Information|Warning)Message/.test(iife));
// The fallback must be wired into the osascript catch (sync) AND the execFile
// callback (async) — assert the callback-form `function(e){if(e)vsMsg()}` is
// present (async path). The bare catch is harder to grep uniquely, so we
// rely on the presence of `vsMsg` reference at the call sites.
check('IIFE.17 async osascript failure -> vsMsg()', /vsMsg\s*\(/.test(iife));

// --- 7. __ccsdTitle suffix in notify message (M20 doc, IIFE-side contract) ----
// The only use of t.__ccsdTitle in the IIFE is the notify-suffix `" ["+title+"]"`.
// Asserting on the substring is enough; a regex over the JS source is brittle
// because `+` and `.` need careful escaping.
check(
  'IIFE.18 notify references __ccsdTitle for message suffix',
  iife.includes('t.__ccsdTitle') && iife.includes('["+t.__ccsdTitle+"]'),
);

// --- 8. Timer lifecycle (M21) — setInterval captured + onDidDispose clear ---
check('IIFE.19 setInterval captured to var', /var\s+timer\s*=\s*setInterval/.test(iife));
check('IIFE.20 onDidDispose clears timer', /onDidDispose/.test(iife) && /clearInterval\s*\(\s*timer\s*\)/.test(iife));

// --- 9. Inject marker banner + version stamp --------------------------------
// Banner format: /*cc-status-dot-injected:vX.Y.Z:HASH*/ where HASH is an 8-hex
// content fingerprint of the IIFE body (lets patchExtension detect intra-
// version drift without a version bump). Pre-hash-scheme injections lack the
// :HASH suffix, so the regex accepts both shapes.
check(
  'IIFE.21 banner carries marker+version(+hash)',
  /\/\*cc-status-dot-injected:v\d+\.\d+\.\d+(?::[0-9a-f]{4,16})?\*\//.test(iife),
);
// v0.1.13+ content-hash scheme: confirm the on-disk banner actually carries a
// hash (not just the legacy version-only form), so a stale same-version
// install is detectable. If buildIIFE ever forgets to stamp the hash this
// catches it before the idempotency gate silently skips a real change.
check(
  'IIFE.21b banner carries content-hash suffix',
  /\/\*cc-status-dot-injected:v\d+\.\d+\.\d+:[0-9a-f]{8}\*\//.test(iife),
);
// v0.1.15 banner specifically: locks the digit-in-block pivot version (a
// regression that rolled back to v0.1.14 would surface here before any SBI
// assertion fires).
check('IIFE.21c banner carries v0.1.15 stamp', /\/\*cc-status-dot-injected:v0\.1\.15:/.test(iife));

// --- 10. flashSeq (renamed from `seq`, M8) ----------------------------------
check('IIFE.22 flashSeq drives interrupted flash', /flashSeq\s*%\s*2/.test(iife));
check('IIFE.23 no bare `seq` counter (M8 rename)', !/\bseq\s*%/.test(iife) && !/\bseq\+\+/.test(iife));

// --- 11. SBI 4-light (v0.1.14): aggregation + text-mutation driver ----------
// The v0.1.13 commandCenter 4-light (20 package.json contribs + setContext
// driver) is GONE. v0.1.14 keeps ALL the design improvements (4 lights incl.
// NEW 🔵 pending; 3-way stale-session GC; pending counted INDEPENDENTLY of
// state) but moves the surface to a single runtime StatusBarItem at
// StatusBarAlignment.Left with very negative priority (-9999 → rightmost
// among Left items → closest to visible center). Text + tooltip are mutated
// every 500ms by __ccsdSbiTimer; the SBI is disposed on last-panel-out.
//
// The aggregation applies the SAME §4 reader rules as per-tab rendering
// (done>5min→idle so IDLE sessions don't count toward green; running stale
// >30min→idle to GC crashed sessions; interrupted >24h→idle to bound 🔴
// growth). pending is counted INDEPENDENTLY of state — a session can be both
// running AND pending (running turn paused on a permission prompt). The IIFE
// retains the project-scoped __ccsd* prefix (NOT CC's __cc* namespace — see
// the `cc-status-bar-injected` tombstone in restoreWebview()).

// SBI text + dim color set at CREATION TIME (not only inside the timer tick).
// Business-logic review round-2 (carried from v0.1.14): the SBI was created
// with .tooltip set but .text NEVER set, leaving it zero-width/invisible for
// the ~500ms until the first tick — and silently permanent if the timer-setup
// try/catch swallowed a throw. v0.1.15 creates 4 SBIs, each starting at the
// count=0 dim form: text "0" + color statusBarItem.deactivatedForeground
// (gray) + transparent background. The first aggregation tick flips any
// non-zero light to its colored form. Assert the literal "0" text + the
// deactivatedForeground dim color appear at the creation site so a regression
// that dropped the creation-time assignment would re-open the invisibility
// window.
check(
  'IIFE.23b each SBI.text="0" set at creation (no 500ms invisibility window)',
  iife.includes('sbi.text="0"'),
  'expected creation-time sbi.text="0"',
);
check(
  'IIFE.23c each SBI created with dim color statusBarItem.deactivatedForeground',
  iife.includes('new vs.ThemeColor("statusBarItem.deactivatedForeground")'),
  'expected creation-time deactivatedForeground dim color',
);

// SBI 4-item creation — one window-scoped createStatusBarItem PER LIGHT,
// idempotent across panels via the __ccsdSbis-array guard. v0.1.15 split the
// v0.1.14 single SBI into 4 so each light's digit renders inside its own
// colored block. The creation loop iterates CFG (the baked config table);
// each iteration createStatusBarItem(Left, CFG[k].pri) and pushes into a
// local `arr`. Priorities -9996..-9999 keep the 4 blocks bunched at the
// rightmost end of Left (done leftmost, interrupted rightmost).
//
// Round-4 (v0.1.15) hardening: the guard is a LENGTH check, not a truthiness
// check, so a prior partial-failure run (e.g. createStatusBarItem threw at
// k=2 on a disposed host) that left a length<4 truthy array is detected and
// rebuilt. The 4 creates are per-iteration try/catch wrapped and accumulated
// in `arr`; the array is committed to globalThis ONLY when arr.length===
// CFG.length (all-or-nothing). This closes the "permanently stuck at N<4
// lights" silent degradation v0.1.14's single-SBI path could not have.
check(
  'IIFE.24a length-guarded rebuild detects partial prior array + disposes it',
  /if\s*\(\s*!globalThis\.__ccsdSbis\s*\|\|\s*globalThis\.__ccsdSbis\.length\s*!==\s*CFG\.length\s*\)\s*\{/.test(
    iife,
  ) &&
    /if\s*\(\s*globalThis\.__ccsdSbis\s*\)\s*\{for\(var j=0;j<globalThis\.__ccsdSbis\.length;j\+\+\)\{try\{globalThis\.__ccsdSbis\[j\]\.dispose\s*\(\s*\)\}catch\(e\)\{\}\};globalThis\.__ccsdSbis\s*=\s*null/.test(
      iife,
    ),
);
check(
  'IIFE.24b per-iteration try/catch around createStatusBarItem + push into local arr',
  /for\(var k=0;k<CFG\.length;k\+\+\)\{try\{var sbi=vs\.window\.createStatusBarItem\s*\(\s*vs\.StatusBarAlignment\.Left\s*,\s*CFG\[k\]\.pri\s*\)/.test(
    iife,
  ),
);
check(
  'IIFE.24c commit-atomic: arr committed to globalThis only when arr.length===CFG.length',
  /if\s*\(\s*arr\.length\s*===\s*CFG\.length\s*\)\s*\{\s*globalThis\.__ccsdSbis\s*=\s*arr/.test(iife),
);
// Round-5 leak fix (v0.1.15): partial-failure cleanup. When the per-iteration
// try/catch catches a throw mid-loop (e.g. createStatusBarItem throws at k=2 on
// a disposed host), the previously successful iterations' SBIs (already
// .show()n and pushed into local `arr`) are NOT reachable via globalThis —
// without an explicit dispose they would leak as visible-orphan colored blocks
// on the status bar forever (and every panel-retry would stack another partial
// set). The fix adds an `else` branch on the commit-atomic `if` that walks
// `arr` and disposes each shown SBI before discarding it. A regression that
// dropped the else (or rearranged the loop to push AFTER show without a
// cleanup path) would re-open the visible-orphan leak. The regex tolerates any
// loop-counter identifier (the IIFE uses `f` to avoid the k/j shadow already
// in scope) and requires the dispose call to be wrapped in its own try/catch
// (mirror of the rebuild-dispose loop's pattern).
check(
  'IIFE.24d partial-failure cleanup: shown-but-untracked SBIs disposed when arr.length!==CFG.length',
  /else\s*\{\s*for\s*\(\s*var\s+\w+\s*=\s*0\s*;\s*\w+\s*<\s*arr\.length\s*;\s*\w+\+\+\s*\)\s*\{\s*try\s*\{\s*arr\s*\[\s*\w+\s*\]\.dispose\s*\(\s*\)\s*\}\s*catch\s*\(\s*e\s*\)\s*\{\s*\}\s*\}\s*;\s*\}/.test(
    iife,
  ),
);
// R3-5 (round 3, ported): assert no `globalThis.__cc<SOMETHING-WRONG>` leaks —
// the only legitimate prefix is `__ccsd*` (lowercase s after __cc). CC's own
// namespace is `__cc` + capital letter directly. Lock the discriminator so a
// future bad refactor cannot silently occupy CC's __cc* namespace.
check('IIFE.24b SBI uses project-scoped __ccsd* (NOT CC __cc[A-Z] ns)', !/globalThis\.__cc[A-Z]/.test(iife));
// v0.1.14 review round-1 widened the __ccsd* rule to ALSO cover per-panel-
// instance fields stashed on the same `this`/`t` object CC's minified code
// operates on (was: __ccDotStarted / __ccSid / __ccTitle / __ccPending; now
// __ccsd*). The collision rationale is identical to globalThis — a future CC
// release could mint a minified `this.__ccXxx` field that silently overwrites
// our stash. Lock the same discriminator on the panel-instance surface so a
// regression that revived the bare prefix would surface here.
check('IIFE.24c panel-instance stash uses __ccsd* (NOT CC __cc[A-Z] ns)', !/(\bt|this)\.__cc[A-Z]/.test(iife));
// SBI singleton timer — one window-scoped setInterval, idempotent via the
// __ccsdSbiTimer guard.
check(
  'IIFE.25 SBI singleton timer guard (__ccsdSbiTimer)',
  /if\s*\(\s*!globalThis\.__ccsdSbiTimer\s*\)\s*\{globalThis\.__ccsdSbiTimer\s*=\s*setInterval/.test(iife),
);
// v0.1.13 setContext driver is GONE — no `executeCommand("setContext", ...)` in
// the executable IIFE code (the only matches should be inside developer-facing
// /* */ comments). A regression that revived the commandCenter path would
// silently bring back the failed-silently-after-reload setContext chain.
check('IIFE.26 no setContext calls in executable code', !/vs\.commands\.executeCommand\s*\(\s*"setContext"/.test(iife));
// Aggregation reads ALL session files via fs.readdirSync(DIR) — same data
// source as the v0.1.13 commandCenter path, just feeding SBI.text instead of
// 4 setContext keys.
check('IIFE.27 SBI reads ALL files via readdirSync(DIR)', /readdirSync\s*\(\s*DIR\s*\)/.test(iife));
// cap() clamps 4+ to 4 so the disp() "N" variant kicks in for >=4 sessions.
check(
  'IIFE.28 SBI cap() clamps 4+ to 4 (display N)',
  /cap\s*=\s*function\s*\(\s*n\s*\)\s*\{\s*return\s+n\s*>=\s*4\s*\?\s*4\s*:\s*n/.test(iife),
);
// pending counted INDEPENDENTLY of state but WITH a stale-session GC: the
// v0.1.13 review found a crashed CC session killed mid-permission-prompt
// (state=running, pending=true, mtime>30min) was downgraded to idle for the
// 🟡 running bucket yet still counted toward 🔵 pending — so the blue light
// would false-stick at 1 forever (SessionEnd never fires on crash). The fix
// reuses the SAME post-decay `st` value the state buckets use: if `st` is
// "idle" (after done>5min / running-stale / interrupted-24h decay), pending
// is skipped too. Lock the `&& st!=="idle"` clause so a regression that
// dropped it would re-open the silent false-stick. PRESERVED across the
// v0.1.13→v0.1.14 pivot.
//
// e2e-test round-2 tightening: the original IIFE.29 regex only verified the
// clause EXISTS somewhere in the IIFE — NOT that it runs AFTER the three
// decay branches (done/running/interrupted). A refactor that hoisted the
// pending check above the decay chain would pass the old regex while re-
// opening the silent false-stick the comment claims is locked (st would
// still be 'running'/'done'/'interrupted' at the pending check, so stale+
// pending sessions would count toward blue). The POSITION check below uses
// indexOf to assert the pending check fires AFTER the interrupted-decay
// block closes — closing the ordering hole. (Behavioral coverage of this
// ordering lives in test-sbi-aggregation.mjs §1.5/§1.6b.)
check(
  'IIFE.29 SBI counts pending independent of state with idle GC (j.pending===true && st!=="idle")',
  /if\s*\(\s*j\.pending\s*===\s*true\s*&&\s*st\s*!==\s*"idle"\s*\)\s*ag\.pending\+\+/.test(iife),
);
{
  // Position lock: pending check must come AFTER all three decay branches.
  // Anchor on the interrupted-decay block's closing form (the LAST decay
  // branch before the pending check); if the pending check appears earlier
  // in the IIFE source than that close, the ordering regressed.
  const decayCloseToken = 'INTERRUPTED_RETENTION_MS){st="idle";}';
  const pendingToken = 'j.pending===true&&st!=="idle")';
  const decayIdx = iife.indexOf(decayCloseToken);
  const pendingIdx = iife.indexOf(pendingToken);
  check(
    'IIFE.29b pending check positioned AFTER decay branches (ordering lock)',
    decayIdx >= 0 && pendingIdx >= 0 && pendingIdx > decayIdx,
    'decayClose=' + decayIdx + ' pending=' + pendingIdx,
  );
}

// --- 12. v0.1.14 lifecycle: panel counter + teardown dispose of SBI ----------
// IIFE entry bumps __ccsdPanelCount; onDidDispose decrements and on the LAST
// panel out (count→0) clears the singleton SBI timer AND disposes the SBI so
// the bottom bar can't freeze on a stale count with no surviving panel.
check(
  'IIFE.30 SBI panel counter increment at IIFE entry',
  /globalThis\.__ccsdPanelCount\s*=\s*\(\s*globalThis\.__ccsdPanelCount\s*\|\|\s*0\s*\)\s*\+\s*1/.test(iife),
);
check(
  'IIFE.31 SBI panel counter decrement + last-out teardown in onDidDispose',
  /globalThis\.__ccsdPanelCount\s*=\s*\(\s*globalThis\.__ccsdPanelCount\s*\|\|\s*1\s*\)\s*-\s*1/.test(iife) &&
    /if\s*\(\s*globalThis\.__ccsdPanelCount\s*<=\s*0\s*\)/.test(iife) &&
    /clearInterval\s*\(\s*globalThis\.__ccsdSbiTimer\s*\)/.test(iife),
);
// Last-panel-out teardown must DISPOSE all 4 SBIs — locks v0.1.15 "lights go
// away when no CC panel survives" behavior. The onDidDispose callback loops
// over __ccsdSbis and disposes each, then nulls the array. (was: single
// __ccsdSbi.dispose in v0.1.14; was: 4 setContext resets in v0.1.13; was: SBI
// hide in v0.1.11.)
check(
  'IIFE.32 SBI last-panel-out disposes all 4 SBIs (loop + null reset)',
  /for\(var k=0;k<globalThis\.__ccsdSbis\.length;k\+\+\)\{try\{globalThis\.__ccsdSbis\[k\]\.dispose\s*\(\s*\)\}catch\(e\)\{\}\};globalThis\.__ccsdSbis\s*=\s*null/.test(
    iife,
  ),
);

// --- 13. v0.1.14 isolation: setup try/catch + teardown wrap (R3 carryover) ---
// Carried over from v0.1.12/v0.1.13 round-3 review: (1) SBI creation wrapped in
// try/catch — a throw inside createStatusBarItem / registerCommand-wiring is
// swallowed and the IIFE continues to the per-tab tick + onDidDispose
// registration. (2) The SBI singleton-timer creation is wrapped in its OWN
// try/catch — a throw inside setInterval registration is swallowed the same
// way. (3) The aggregation BODY inside the setInterval callback has its OWN
// try/catch so a readdir/stat/parse/text-mutate failure can never brick the
// per-panel tick. (4) The onDidDispose teardown registration remains wrapped
// in try/catch (matches the per-tab tick's isolation pattern).
check(
  'IIFE.33 SBI creation wrapped in try/catch (v0.1.15 round-4 length-guarded form)',
  /try\s*\{\s*if\s*\(\s*!globalThis\.__ccsdSbis\s*\|\|\s*globalThis\.__ccsdSbis\.length\s*!==\s*CFG\.length\s*\)/.test(
    iife,
  ),
);
check(
  'IIFE.34 SBI singleton-timer creation wrapped in try/catch',
  /try\s*\{\s*if\s*\(\s*!globalThis\.__ccsdSbiTimer\s*\)\s*\{globalThis\.__ccsdSbiTimer\s*=\s*setInterval/.test(iife) &&
    /,\s*500\s*\)\s*;\s*\}\s*\}\s*catch\s*\(\s*e\s*\)\s*\{\s*\}/.test(iife),
);
check(
  'IIFE.35 SBI aggregation body wrapped in try/catch',
  /setInterval\s*\(\s*function\s*\(\s*\)\s*\{\s*try\s*\{\s*var\s+ag\s*=\s*\{running:0,done:0,interrupted:0,idle:0,pending:0\}/.test(
    iife,
  ),
);
check(
  'IIFE.36 SBI onDidDispose registration wrapped in try/catch',
  /try\s*\{\s*t\.panelTab\.onDidDispose\s*\(/.test(iife) && /\)\s*\}\s*catch\s*\(\s*e\s*\)\s*\{\s*\}/.test(iife),
);
// Reader-rule parity: aggregation applies §4 done>5min→idle so IDLE sessions
// are NOT counted toward the green light (only ACTIVE done is). A regression
// that dropped this clause would make the 🟢 light over-count stale done.
check(
  'IIFE.37 SBI applies §4 done>5min→idle rule in aggregation',
  /if\s*\(\s*st\s*===\s*"done"\s*&&\s*since\s*&&\s*\(\s*Date\.now\s*\(\s*\)\s*-\s*since\s*\)\s*>\s*DONE_TO_IDLE_MS\s*\)\s*\{\s*st\s*=\s*"idle"\s*;\s*\}/.test(
    iife,
  ),
);
// §7.2 stale-running heuristic (mtime>SBI_RUNNING_STALE_MS→idle) is preserved
// in the SBI aggregation (variable name kept for grep continuity).
check(
  'IIFE.37b SBI stale-running heuristic (mtime>SBI_RUNNING_STALE_MS→idle)',
  /\(\s*Date\.now\s*\(\s*\)\s*-\s*mt\s*\)\s*>\s*SBI_RUNNING_STALE_MS\s*\)\s*\{\s*st\s*=\s*"idle"\s*;\s*\}/.test(iife),
);
// e2e-test round-2: lock the VALUE of SBI_RUNNING_STALE_MS, not just its
// use. The sibling constants DONE_TO_IDLE_MS (IIFE.14) and
// INTERRUPTED_RETENTION_MS (IIFE.37c) both have their literal values locked
// (5*60*1000 and 24*60*60*1000); SBI_RUNNING_STALE_MS did NOT — a regression
// changing 30min to 30sec (would GC legitimate running sessions, killing
// the yellow light) or to 30h (would never GC crashed sessions, re-opening
// the false-stick-at-1 yellow) would not be caught. Mirror the sibling
// assertions so all three decay thresholds have their values pinned.
check(
  'IIFE.37b2 SBI_RUNNING_STALE_MS value (30*60*1000)',
  /var\s+SBI_RUNNING_STALE_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/.test(iife),
);
// v0.1.13/v0.1.14 interrupted retention (architecture-review fix): interrupted
// files older than 24h decay to idle so the 🔴 red light doesn't monotonically
// grow from accumulated abandoned interrupted sessions (crashed/killed CC
// never sends SessionEnd). File is NOT deleted — only the count drops. Lock
// the constant + the decay branch so a regression that dropped the GC would
// re-open the unbounded 🔴 growth.
check(
  'IIFE.37c SBI INTERRUPTED_RETENTION_MS constant (24h decay for 🔴)',
  /var\s+INTERRUPTED_RETENTION_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(iife),
);
check(
  'IIFE.37d SBI interrupted>24h mtime decay →idle (bounds 🔴 growth)',
  /else if\s*\(\s*st\s*===\s*"interrupted"\s*\)\s*\{\s*var\s+mt\s*=\s*0;try\s*\{\s*mt\s*=\s*fs\.statSync\s*\(\s*fp\s*\)\.mtimeMs\s*\}\s*catch\s*\(\s*e2\s*\)\s*\{\s*\}\s*;?\s*if\s*\(\s*mt\s*&&\s*\(\s*Date\.now\s*\(\s*\)\s*-\s*mt\s*\)\s*>\s*INTERRUPTED_RETENTION_MS\s*\)\s*\{\s*st\s*=\s*"idle"\s*;\s*\}\s*\}/.test(
    iife,
  ),
);

// --- 14. v0.1.15 per-SBI render (digit-in-block) ---------------------------
// v0.1.15 replaced v0.1.14's disp()/text-join with a per-SBI update loop.
// Each of the 4 SBIs gets its OWN text + color + backgroundColor assigned
// from counts[k] (the capped count for that light). The render rules:
//   n===0 → text "0" + color deactivatedForeground (gray) + bg undefined (dim)
//   n>0   → text (n>=4?"N":""+n) + color "#ffffff" (white) + bg themed block
// Round-4 (v0.1.15): the bg + dim-color ThemeColors are now allocated ONCE
// at creation time (cached in globalThis.__ccsdSbiLitBgs[k] +
// globalThis.__ccsdSbiDimClr) and REUSED per tick — was `new vs.ThemeColor(...)`
// per block per tick (~8 allocations/tick). The cached form locks the same
// lit/dim intent, just via the cached identifier.
check(
  'IIFE.38 per-SBI text ternary (0→"0", 1-3→digit, >=4→"N")',
  iife.includes('sbi.text=n===0?"0":(n>=4?"N":""+n)'),
  'expected: sbi.text=n===0?"0":(n>=4?"N":""+n)',
);
check(
  'IIFE.38b per-SBI lit branch (n>0 → cached themed bg + white text)',
  iife.includes('if(n>0){sbi.backgroundColor=globalThis.__ccsdSbiLitBgs[k];sbi.color="#ffffff"}'),
);
check(
  'IIFE.38c per-SBI dim branch (n===0 → bg undefined + cached deactivatedForeground)',
  iife.includes('else{sbi.backgroundColor=undefined;sbi.color=globalThis.__ccsdSbiDimClr}'),
);
// The cap() helper is UNCHANGED from v0.1.14 — still clamps 4+ to 4 so the
// "N" variant kicks in for >=4 sessions.
check(
  'IIFE.38d cap() helper unchanged (4+ → 4, drives the "N" variant)',
  /var\s+cap\s*=\s*function\s*\(\s*n\s*\)\s*\{\s*return\s+n\s*>=\s*4\s*\?\s*4\s*:\s*n/.test(iife),
);
// counts[] array indexes match CFG[] (done/running/pending/interrupted). The
// per-SBI loop reads counts[k] — a regression that permuted the order would
// silently swap two lights' digits.
check(
  'IIFE.39 counts[] array indexed in fixed order done/running/pending/interrupted',
  /var\s+counts\s*=\s*\[\s*cd\s*,\s*cr\s*,\s*cp\s*,\s*ci\s*\]/.test(iife),
);
// Tooltip carries the UNcapped breakdown so the user can see real counts even
// when the lights cap at N. All 4 SBIs carry the same tooltip. UNCHANGED from
// v0.1.14 — lock the literal format string.
check(
  'IIFE.40 SBI tooltip = "Claude Code: N done, N running, N pending, N interrupted"',
  iife.includes(
    '"Claude Code: "+ag.done+" done, "+ag.running+" running, "+ag.pending+" pending, "+ag.interrupted+" interrupted"',
  ),
);
// Per-tick update loop iterates globalThis.__ccsdSbis and mutates each item's
// text + tooltip + (bg/color per count) + show. Round-4 (v0.1.15) hardening:
// (a) the loop body is now per-iteration try/catch (was a single outer
// try/catch — one disposed SBI froze ALL later blocks for that tick and every
// future tick); (b) the whole mutate pass is short-circuited via a lastKey
// memo keyed on the UNcapped aggregation tuple, so a long-running session
// whose capped counts don't change for hours skips the loop entirely
// (steady-state IPC writes drop from ~40/s to 0); (c) bg + dim-color reuse
// the cached ThemeColor identifiers (no `new` per tick). A regression that
// dropped the per-iteration try/catch OR the short-circuit OR the cached
// identifiers would surface here.
check(
  'IIFE.40b per-tick update: lastKey short-circuit + per-iteration try/catch + cached ThemeColor',
  /var\s+key\s*=\s*ag\.done\s*\+\s*","\s*\+\s*ag\.running\s*\+\s*","\s*\+\s*ag\.pending\s*\+\s*","\s*\+\s*ag\.interrupted/.test(
    iife,
  ) &&
    /if\s*\(\s*key\s*!==\s*globalThis\.__ccsdSbiLastKey\s*\)/.test(iife) &&
    /for\s*\(\s*var\s+k\s*=\s*0\s*;\s*k<globalThis\.__ccsdSbis\.length\s*;\s*k\+\+\s*\)\s*\{\s*try\s*\{\s*var\s+sbi\s*=\s*globalThis\.__ccsdSbis\[k\]\s*;\s*var\s+n\s*=\s*counts\[k\]\s*;\s*sbi\.text\s*=/.test(
      iife,
    ) &&
    /sbi\.show\s*\(\s*\)\s*\}\s*catch\s*\(\s*e\s*\)\s*\{\s*\}/.test(iife) &&
    /sbi\.tooltip\s*=\s*tip/.test(iife),
);

// --- 15. SBI config baking (v0.1.15; replaces v0.1.14 emoji baking) ---------
// The 4-light config (key/bg/pri per light) is baked into the IIFE as a
// JSON-stringified array literal `var CFG=[...]` from SBI_LIGHTS_CFG (patch.ts
// source). Locking the exact content matters: a permutation would silently
// swap two lights' colors/positions, and a wrong bg id would make a light
// render with the wrong theme color.
check(
  'IIFE.41 SBI CFG array baked from SBI_LIGHTS_CFG (4 lights, bg/pri per entry)',
  iife.includes('var CFG=' + JSON.stringify(SBI_LIGHTS_CFG) + ';'),
);
// Lock the 4 background ThemeColor ids explicitly so a typo (e.g.
// "statusBarItem.remoteBackgroud") would surface before any visual test.
check(
  'IIFE.41b CFG bg[0] done = statusBarItem.remoteBackground',
  iife.includes('"bg":"statusBarItem.remoteBackground"'),
);
check(
  'IIFE.41c CFG bg[1] running = statusBarItem.warningBackground',
  iife.includes('"bg":"statusBarItem.warningBackground"'),
);
check(
  'IIFE.41d CFG bg[2] pending = statusBarItem.prominentBackground',
  iife.includes('"bg":"statusBarItem.prominentBackground"'),
);
check(
  'IIFE.41e CFG bg[3] interrupted = statusBarItem.errorBackground',
  iife.includes('"bg":"statusBarItem.errorBackground"'),
);
// Lock the 4 priorities (done leftmost / interrupted rightmost).
check('IIFE.41f CFG pri done=-9996 (leftmost)', iife.includes('"pri":-9996'));
check('IIFE.41g CFG pri interrupted=-9999 (rightmost)', iife.includes('"pri":-9999'));
// v0.1.14 emoji artifacts (EM array, DIM) MUST be gone — a regression that
// revived them would indicate a partial rollback.
check('IIFE.41h no var EM (v0.1.14 emoji array gone)', !/var\s+EM\s*=/.test(iife));
check('IIFE.41i no var DIM (v0.1.14 dim emoji gone)', !/var\s+DIM\s*=/.test(iife));
check('IIFE.41j no disp() function (v0.1.14 render fn gone)', !/var\s+disp\s*=/.test(iife));

// --- 16. SBI click command (v0.1.14; replaces v0.1.13 20-command pkg block) -
// ONE command registered via runtime vs.commands.registerCommand (no
// package.json contribution needed for registerCommand). Idempotent across
// panels via globalThis.__ccsdSbiCmdRegistered — registerCommand throws on
// re-registration of the same ID within one host. The handler reads the SBI's
// CURRENT tooltip (kept fresh every 500ms) and echoes it via
// InformationMessage. The SBI.command field is set to this ID so VSCode
// executes it on click. A regression that dropped this block would make the
// SBI click pop "command not found".
check(
  'IIFE.42 SBI click command guarded by __ccsdSbiCmdRegistered',
  /if\s*\(\s*!globalThis\.__ccsdSbiCmdRegistered\s*\)\s*\{globalThis\.__ccsdSbiCmdRegistered\s*=\s*true/.test(iife),
);
check(
  'IIFE.43 SBI registers ccStatusDot.sbiClick via vs.commands.registerCommand',
  /vs\.commands\.registerCommand\s*\(\s*"ccStatusDot\.sbiClick"/.test(iife),
);
check(
  'IIFE.44 SBI.command wired to ccStatusDot.sbiClick on each sbi in creation loop',
  /sbi\.command\s*=\s*"ccStatusDot\.sbiClick"/.test(iife),
);

// --- 17. per-tab rendering unchanged (regression check) ---------------------
// Per-tab rendering is UNCHANGED by v0.1.14 — assert the iconPath assignment
// still exists AFTER the aggregation block (a refactor that dropped per-tab
// dots while leaving only the SBI would pass every other assertion).
check('IIFE.45 per-tab p.iconPath assignment still present', /p\.iconPath\s*=\s*vs\.Uri\.file/.test(iife));

// --- 18. Decay-profile divergence lock (architecture-review round-2) ----------
// STATES.md §7.4 documents an INTENTIONAL asymmetry: the SBI aggregation tick
// applies all three decay rules (DONE_TO_IDLE_MS 5min, SBI_RUNNING_STALE_MS
// 30min-mtime, INTERRUPTED_RETENTION_MS 24h-mtime) so abandoned sessions
// don't false-stick lights at scale; the per-tab tick applies ONLY
// done>5min so a crashed session's TAB keeps yellow/red as a per-tab alert
// (the user can see WHICH tab crashed). Nothing structural enforces this —
// a future edit could quietly collapse the two paths and silently regress
// the "tab stays yellow for crashed session" UX (or vice versa). These
// assertions lock the divergence:
//   - SBI tick body references SBI_RUNNING_STALE_MS AND INTERRUPTED_RETENTION_MS
//   - per-tab tick body references NEITHER (only DONE_TO_IDLE_MS)
// A refactor that added running/interrupted decay to the per-tab tick would
// fail IIFE.46b; a refactor that dropped running/interrupted decay from the
// SBI tick would fail IIFE.46.
{
  // The SBI tick body is setInterval(... 500) inside the __ccsdSbiTimer
  // branch; the per-tab tick body is `var timer=setInterval(... 500)` further
  // down. Split the IIFE at the per-tab tick's setInterval to isolate the
  // two bodies.
  const perTabAnchor = 'var timer=setInterval(function(){';
  const splitIdx = iife.indexOf(perTabAnchor);
  const sbiPart = splitIdx >= 0 ? iife.slice(0, splitIdx) : iife;
  const perTabPart = splitIdx >= 0 ? iife.slice(splitIdx) : '';
  check(
    'IIFE.46 SBI tick body references both SBI_RUNNING_STALE_MS and INTERRUPTED_RETENTION_MS',
    /SBI_RUNNING_STALE_MS/.test(sbiPart) && /INTERRUPTED_RETENTION_MS/.test(sbiPart),
    'SBI tick should apply running-stale + interrupted-24h decay',
  );
  check(
    'IIFE.46b per-tab tick body references NEITHER SBI_RUNNING_STALE_MS nor INTERRUPTED_RETENTION_MS (intentional divergence)',
    !/SBI_RUNNING_STALE_MS/.test(perTabPart) && !/INTERRUPTED_RETENTION_MS/.test(perTabPart),
    'per-tab tick should NOT decay running/interrupted (per-tab alert preserved)',
  );
}

// --- 17. Writer-hook content-hash gate (R3 architecture fix; mirrors IIFE.21b) ---
// The writer hook (hooks/cc-status.js) carries a banner
// `/*cc-status-dot-hook:vX.Y.Z:HASH*/` where HASH is sha1 of the body with
// the banner line replaced by an empty line, truncated to 8 hex chars. The
// patcher's installRuntimeFiles + --status compare this hash to the current
// body hash to detect intra-HOOK_VERSION drift (a dev edited the hook but
// forgot to bump the banner). This section mirrors the IIFE.21b hash check
// for the writer side, closing the round-2 asymmetry where only the reader
// had a content hash.
{
  const HOOK_SRC = path.join(ROOT, 'hooks', 'cc-status.js');
  const SRC_HOOK_VERSION = 'v0.1.14'; // mirror HOOK_VERSION in patch.ts
  const HOOK_HASH_LEN = 8;
  let hookSrc = '';
  try {
    hookSrc = fs.readFileSync(HOOK_SRC, 'utf8');
  } catch (e) {
    // read failure -> skip section but record a fail so the missing file is loud
    check('IIFE.47 source hook readable', false, String(e));
    hookSrc = '';
  }
  if (hookSrc) {
    // Banner is on line 3 (after shebang + 'use strict'); find it by regex.
    const lines = hookSrc.split('\n');
    const head = lines.slice(0, 10);
    const bannerIdx = head.findIndex((l) => /cc-status-dot-hook:v\d+\.\d+\.\d+/.test(l));
    check('IIFE.47 source hook has cc-status-dot-hook banner', bannerIdx !== -1);
    if (bannerIdx !== -1) {
      const banner = head[bannerIdx];
      const vm = banner.match(/cc-status-dot-hook:v(\d+\.\d+\.\d+)/);
      check('IIFE.47b source hook banner version matches HOOK_VERSION', vm && vm[1] === SRC_HOOK_VERSION.slice(1));
      const hashSuffixRe = new RegExp(':([0-9a-f]{' + HOOK_HASH_LEN + '})\\*');
      const hm = banner.match(hashSuffixRe);
      check('IIFE.47c source hook banner carries 8-hex hash suffix', !!hm);
      if (hm) {
        // Recompute the body hash the same way patch.ts splitHookBanner does:
        // replace the banner line with an empty line, hash the full content.
        const bodyLines = lines.slice();
        bodyLines[bannerIdx] = '';
        const body = bodyLines.join('\n');
        const recomputed = crypto.createHash('sha1').update(body).digest('hex').slice(0, HOOK_HASH_LEN);
        check(
          'IIFE.47d source hook banner hash === recomputed body hash (intra-version drift gate)',
          recomputed === hm[1],
          'banner claims ' + hm[1] + ', body recomputes to ' + recomputed + ' — re-stamp the banner',
        );
      }
    }
  }
}

// --- summary ---------------------------------------------------------------

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
