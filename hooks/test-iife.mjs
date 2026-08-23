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
import vm from 'vm';
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

// Mirror patch.ts SBI_LIGHTS_CFG + SBI_DIM_EM + SBI_PRIORITY — single source
// of truth is patch.ts; this local copy must stay in sync. v0.1.16 replaced
// the v0.1.15 `bg` field (a ThemeColor id for a colored block background)
// with the `em` field (the "on" emoji ball codepoint — a pre-colored Unicode
// circle that carries its own green/yellow/blue/red fill, no theme
// dependency). The shared dim/zero ball SBI_DIM_EM (⚪ U+26AA white/gray
// medium circle, in the Miscellaneous Symbols block — v0.2.0 reverted the
// v0.1.17 ⚪→🟤 pivot back to gray because the user prefers gray over brown,
// commit 55e18b4; see patch.ts SBI_DIM_EM JSDoc + docs/STATES.md §7.5)
// replaces any light's colored ball when its count is 0.
// v0.1.17 DROPPED the v0.1.15/v0.1.16 `pri` field — the 4 lights now render
// inside ONE StatusBarItem (concatenated text, single-space separator since
// v0.1.18), so per-light priority became dead data. The single SBI's
// priority lives in its own SBI_PRIORITY const (-9996, leftmost-of-the-old-4
// → preserves screen position across the 4-SBI → 1-SBI pivot). Order matches
// the IIFE's `var CFG=[...]` array: done(🟢) / running(🟡) / pending(🔵) /
// interrupted(🔴). Used to assert the IIFE bakes the same config via
// JSON.stringify in buildIIFE. Emoji written as \u{XXXX} escapes so the
// test file mirrors patch.ts source form (ASCII-only); the parsed values
// are the actual emoji chars.
const SBI_LIGHTS_CFG = [
  { key: 'done', em: '\u{1F7E2}' }, // 🟢 leftmost
  { key: 'running', em: '\u{1F7E1}' }, // 🟡
  { key: 'pending', em: '\u{1F535}' }, // 🔵
  { key: 'interrupted', em: '\u{1F534}' }, // 🔴 rightmost
];
const SBI_DIM_EM = '\u{26AA}'; // ⚪ — shared zero-count dim ball (user prefers gray over brown)
const SBI_PRIORITY = -9996; // single v0.1.17 SBI's priority (Left, rightmost)

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
// v0.2.6 blue-via-content: reader renders a 5th our-svg for the pending
// state (Notification OR Stop last-message semantic match). The svg is
// shipped in resources/ and the IIFE references it by name from the
// per-panel tick's new `pend && st!=="idle"` branch.
check('IIFE.6a pending    -> claude-logo-pending.svg', iife.includes('claude-logo-pending.svg'));
// interrupted off-frame falls back to CC's claude-logo.svg (not one of ours).
check('IIFE.7  interrupted off-frame -> CC claude-logo.svg', iife.includes('claude-logo.svg'));

// --- 3. Notify dedup mechanism — since+seeded, NOT prevSt -------------------
// Locks the v0.1.5 algorithm change. A regression that revived the old prevSt
// transition check would silently miss fast turns (running→done between polls).
check('IIFE.8  dedup uses seeded flag', /seeded\s*=\s*true/.test(iife));
check('IIFE.9  dedup uses lastTermSince', /lastTermSince/.test(iife));
check('IIFE.10 dedup keyed on since change', /since\s*!==\s*lastTermSince/.test(iife));
check('IIFE.11 no prevSt field (old dedup)', !/\bprevSt\b/.test(iife));
// v0.2.5 round-3 (e2e MEDIUM regression-lock): cross-panel notify dedup. The
// round-2 e2e fix introduced globalThis.__ccsdLastNotifyKey — keyed on
// (sid, since), it lets the FIRST panel to observe a running→done transition
// claim it; later panels within the same `since` epoch skip notify() so N
// panels showing the same session produce ONE notification instead of N.
// Without this lock a focused refactor that strips ONLY __ccsdLastNotifyKey
// (leaving the per-panel transition detection intact — IIFE.8/IIFE.9/IIFE.10
// all still pass) would silently re-introduce the N-panels=N-notifications
// bug for the same terminal transition. The mechanism is correct (verified
// by trace: single-threaded JS makes the check-and-set atomic; a subsequent
// transition moves the key so it still fires; SessionEnd→reopen with
// preserved-since is correctly suppressed); the gap was purely regression
// coverage. The regex lock below closes that window cheaply and matches the
// discipline of IIFE.8-IIFE.11 (which lock the OLDER per-panel dedup).
check(
  'IIFE.11b cross-panel notify dedup keyed on __ccsdLastNotifyKey (round-2 e2e fix regression lock)',
  /globalThis\.__ccsdLastNotifyKey/.test(iife),
  'missing __ccsdLastNotifyKey — multi-panel dedup regressed (N panels would each fire notify for the same terminal transition)',
);

// --- 4. Permission pending yield (STATES.md §1 v0.1.8) ----------------------
// v0.2.9.1 (Q7 tab-orange fix): the `if(t.__ccsdPending)return` YIELD was REMOVED —
// it left the tab on CC's native ORANGE logo when rename_tab carried
// hasPendingPermissions=true (CC 2.1.216 fires this during workflow tool-use).
// Permission prompts now surface via the FILE pending field (Notification hook →
// j.pending → the IIFE.12a blue-render branch). The per-panel tick must NEVER
// leave native orange: the no-sid + read-fail (else) paths render idle fallback
// (v0.5.35 reverts v0.5.35's green-fallback: unknown-state must be GREY — honest
// 'unknown' — not green, which wrongly signalled 'done' on session init/reopen.
// The real state shows once sid arrives via update_session_state).
check(
  'IIFE.12 __ccsdPending yield REMOVED (Q7) — no code-path return-without-render',
  !/if\s*\(\s*t\.__ccsdPending\s*\)\s*\{[^}]*return/.test(iife),
);
check(
  'IIFE.12b no-sid path renders idle (grey) fallback (v0.5.35 revert, never native orange)',
  /if\(!sid\)\{try\{p\.iconPath=ccuri[^}]*claude-logo-idle\.svg/.test(iife),
);
check(
  'IIFE.12c else read-fail path renders idle (grey) fallback (v0.5.35 revert)',
  /else\{try\{p\.iconPath=ccuri[^}]*claude-logo-idle\.svg/.test(iife),
);
// v0.5.2 (#3/F3): the v0.2.9-debug __ccsdDbg anomaly logger + _panel-debug.log
// + __ccsdRenderMap were removed (their own comment said to remove after the
// Q7 fix landed — it landed in v0.2.9.1 but the logger survived through v0.5.1,
// firing unthrottled fs.statSync+appendFileSync ~6×/sec). Assert the symbols
// are GONE from the baked IIFE so a regression that re-adds the dead logger
// surfaces here.
check(
  'IIFE.12b2 v0.2.9-debug dead loggers REMOVED (F3): __ccsdDbg/__ccsdRenderMap/_panel-debug.log absent [v0.5.36: __ccsdDebug re-added as zero-sync-I/O flag — see IIFE.12b3]',
  !/__(?:ccsdDbg(?:Log)?|ccsdRenderMap)\b/.test(iife) && !/_panel-debug\.log/.test(iife),
  'v0.5.2 removed __ccsdDbg + __ccsdRenderMap (dead loggers). v0.5.27 temporarily re-added __ccsdDebug writing _panel-debug.log via appendFileSync; v0.5.29 removed it after root-causing (Stop awaitsUser text heuristic). v0.5.36 re-added __ccsdDebug as a zero-sync-I/O boolean FLAG (NOT a logger) for QuickPick click-timing — the dead __ccsdDbg/__ccsdRenderMap loggers + _panel-debug.log sync file stay removed forever.',
);
// v0.5.36 __ccsdDebug re-introduction contract. The 03-review HIGH finding
// flagged that the QuickPick root cause was L1 inference; the zero-sync-I/O
// instrumentation here elevates it to L2. The CRITICAL guard: this __ccsdDebug
// must NEVER pair with appendFileSync / _panel-debug.log (the v0.5.27 Anchor B
// Heisenbug, patch.ts:2772: sync I/O shifted tick timing -> masked the bug).
check(
  'IIFE.12b3 v0.5.36 __ccsdDebug zero-sync-I/O QuickPick timing: env-gated + in-memory marks + OutputChannel dump (NOT appendFileSync — Anchor B Heisenbug guard)',
  /typeof globalThis\.__ccsdDebug\s*===\s*"undefined"\s*\)\s*\{\s*try\s*\{\s*globalThis\.__ccsdDebug\s*=\s*\(process\.env\.CCSD_DEBUG/.test(
    iife,
  ) &&
    /__marks\.push\(\{p:p,t:/.test(iife) &&
    /createOutputChannel\("CCSD Debug"\)/.test(iife) &&
    !/_panel-debug\.log/.test(iife),
  'v0.5.36 re-introduces __ccsdDebug (removed v0.5.29) as a zero-sync-I/O boolean flag for QuickPick click-timing instrumentation. Contract: (1) lazy-init gated by typeof-undefined + process.env.CCSD_DEBUG (off by default, zero overhead in production); (2) timing marks are in-memory __marks.push({p,t}) — microseconds, no I/O; (3) dump via vs.window.createOutputChannel("CCSD Debug").appendLine (async, non-blocking). NEVER appendFileSync/_panel-debug.log (Anchor B Heisenbug, patch.ts:2772). If a future change pairs __ccsdDebug with sync file I/O, this assertion + 12b2 together must catch it.',
);
// v0.2.6 blue-via-content: per-panel reader pending branch. The IIFE's
// per-panel tick reads j.pending from the status file and renders our blue
// claude-logo-pending.svg when pending=true && state!=="idle". Priority:
// this branch fires AFTER the __ccsdPending yield (so CC's native permission
// blue dot wins when both flags active) and BEFORE the state-based if-chain
// (so pending=true overrides running-yellow / done-green). The position lock
// asserts pend branch index > yield index, and the svg assertion above
// (IIFE.6a) asserts the path reference exists.
check(
  'IIFE.12a per-panel reader pending branch (pend && st!=="idle") -> claude-logo-pending.svg',
  /if\s*\(\s*pend\s*&&\s*st\s*!==\s*"idle"\s*\)\s*\{[^}]*claude-logo-pending\.svg/.test(iife),
);
check(
  'IIFE.12b per-panel tick reads (j.pending===true) OR (__ccsdPendingSet[sid]===true) OR (__ccsdUserDialogSet[sid]===true) into pend (v0.5.35 three-source OR mirroring §F)',
  /pend\s*=\s*\(\s*j\.pending\s*===\s*true\s*\)\s*\|\|\s*\(\s*globalThis\.__ccsdPendingSet\s*&&\s*globalThis\.__ccsdPendingSet\[sid\]\s*===\s*true\s*\)\s*\|\|\s*\(\s*globalThis\.__ccsdUserDialogSet\s*&&\s*globalThis\.__ccsdUserDialogSet\[sid\]\s*===\s*true\s*\)/.test(
    iife,
  ),
);
{
  // Position lock: the pend branch must fire AFTER the __ccsdPending yield
  // (so CC's native permission blue dot wins) and BEFORE the per-tab
  // interrupted state branch (so pending overrides running/done/idle).
  // Anchor interrupted to `flashSeq%2===0` (unique to the per-tab interrupted
  // flash; the aggregation block's `st==="interrupted"` decay check appears
  // earlier in the IIFE and would false-index).
  const yieldIdx = iife.indexOf('t.__ccsdPending');
  const pendIdx = iife.indexOf('pend && st!=="idle"');
  const perTabInterruptedIdx = iife.indexOf('flashSeq%2===0');
  check(
    'IIFE.12c pend branch positioned AFTER __ccsdPending yield AND BEFORE per-tab interrupted branch',
    yieldIdx >= 0 && pendIdx >= 0 && perTabInterruptedIdx >= 0 && pendIdx > yieldIdx && pendIdx < perTabInterruptedIdx,
    'yield=' + yieldIdx + ' pend=' + pendIdx + ' perTabInterrupted(flashSeq%2===' + perTabInterruptedIdx + ')',
  );
}
{
  // v0.2.6 round-2 (HIGH reader-logic fix): pin decay-BEFORE-pending-check
  // ordering. Round-1 placed the done>5min / running-stale decay INSIDE the
  // SVG selection (after the pend check) — leaving `st` RAW at the pend check,
  // so a done+pending session stuck blue forever. This block asserts:
  //   (a) the per-tab tick now contains a decay chain `st="idle"`
  //       assignment BEFORE the pend check;
  //   (b) v0.5.2 (#4): the decay chain now shares the §F threshold
  //       (DONE_TO_IDLE_MS for done, SBI_RUNNING_STALE_MS for running) +
  //       gates the running→idle downgrade on __ccsdTranscriptFresh — the
  //       prior 15min SINCE_STALE_MS per-tab constant is retired so the tab
  //       and the bottom 🟡 can never disagree in a 15-30min window;
  //   (c) `var now=Date.now()` is hoisted BEFORE the decay chain (the chain
  //       reads `now` so it must be defined first);
  //   (d) the decay chain sits BETWEEN the __ccsdPending yield and the pend
  //       check (so the yield's early-return still wins for CC-native
  //       permission blue, and the decay runs only for the file-pending path).
  const yieldIdx = iife.indexOf('t.__ccsdPending');
  const pendIdx = iife.indexOf('pend && st!=="idle"');
  const perTabNowIdx = iife.indexOf('var now=Date.now();');
  // v0.5.24 (debt #1): §F/§H inline decay chains unified into the
  // __ccsdDecayState predicate; the per-tab tick now CALLS it
  // (decayInterrupted=false). Position locks anchor on the call site
  // instead of the retired inline done-decay string.
  const perTabDecayCallIdx = iife.indexOf('st=__ccsdDecayState(st,since,j,now,false,__mt)');
  check(
    'IIFE.12d per-tab tick applies decay BEFORE pending check (HIGH round-2: done>5min→idle)',
    perTabDecayCallIdx >= 0 && pendIdx >= 0 && perTabDecayCallIdx < pendIdx,
    'decayCall=' + perTabDecayCallIdx + ' pend=' + pendIdx,
  );
  check(
    'IIFE.12e v0.5.24: __ccsdDecayState unified predicate (done/interrupted/running) — replaces inline §F/§H decay chains',
    /function __ccsdDecayState\(st,since,j,now,decayInterrupted,mt\)/.test(iife) &&
      /st==="done"&&since&&\(now-since\)>DONE_TO_IDLE_MS\)return "idle"/.test(iife) &&
      /decayInterrupted&&st==="interrupted"&&since&&\(now-since\)>INTERRUPTED_RETENTION_MS\)return "idle"/.test(iife) &&
      /st==="running"&&since&&\(!\(j\.activeSubagents>0\)\|\|!mt\|\|\(now-mt\)>SBI_AS_PROTECT_MAX_MS\)&&\(now-since\)>SBI_RUNNING_STALE_MS&&j\.tokens&&j\.tokens\.last_ts&&\(now-j\.tokens\.last_ts\)>SBI_RUNNING_STALE_MS\)return "idle"/.test(
        iife,
      ) &&
      /var SBI_AS_PROTECT_MAX_MS=\d+;/.test(iife),
    'v0.5.24 debt #1: §F/§H decay unified into one predicate. running decay gated on since AND tokens.last_ts AND !activeSubagents (v0.5.13/14/16 rationale preserved in the declaration comment).',
  );
  check(
    'IIFE.12f per-tab decay call sits AFTER __ccsdPending yield (yield still wins for CC-native blue)',
    yieldIdx >= 0 && perTabDecayCallIdx >= 0 && yieldIdx < perTabDecayCallIdx,
    'yield=' + yieldIdx + ' decayCall=' + perTabDecayCallIdx,
  );
  check(
    'IIFE.12g per-tab `var now=Date.now()` hoisted BEFORE decay call (decay reads `now`)',
    perTabNowIdx >= 0 && perTabDecayCallIdx >= 0 && perTabNowIdx < perTabDecayCallIdx,
    'now=' + perTabNowIdx + ' decayCall=' + perTabDecayCallIdx,
  );
}

// --- 5. done → idle 5-min fallback (STATES.md §4) ---------------------------
check('IIFE.13 DONE_TO_IDLE_MS constant', /DONE_TO_IDLE_MS/.test(iife));
// v0.2.5 round-2 (ARCH-6): DONE_TO_IDLE_MS is now template-substituted from
// the patch.ts top-level const, so the IIFE bytes carry either the computed
// numeric form (`var DONE_TO_IDLE_MS=300000;`) OR the prior expression form
// (`var DONE_TO_IDLE_MS=5*60*1000;`). Accept either; the value is also
// pinned by test-contract-sync.mjs's extractNumericConst extraction.
check(
  'IIFE.14 5min value (5*60*1000)',
  /5\s*\*\s*60\s*\*\s*1000/.test(iife) || /DONE_TO_IDLE_MS\s*=\s*300000/.test(iife),
);

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
// v0.1.17 banner specifically: locks the single-SBI compact-concat pivot
// (a regression that rolled back to v0.1.16 4-SBI would surface here
// before any SBI assertion fires).
// v0.2.7: stamp bumped for Q1 (tokens persistence) + Q2 (interrupted sticky).
// v0.2.8: stamp bumped for INSTALL_DIR/src/ copy fix (IIFE body unchanged;
// bump triggers companion IIFE-version drift detect → restore+reinject →
// installCompanion re-runs and copies the missing src/ modules).
// v0.2.9: stamp bumped for Q4 (PostCompact in HOOK_EVENTS, no IIFE change)
// + Q5 (IIFE body changed: Uri cache ccuri() for iconPath, token SBI text
// dedup __ccsdTokSbiLastText, .offset sidecar mtime+size cache
// __ccsdOffCache in computeLiveDelta).
// v0.5.6: stamp bumped for Favorites Bug 1/2/4 fixes (forceRefresh + dynamic
// Add/Remove menu labels via setContext('ccStatusDot.fav.currentTabFavorited');
// IIFE body unchanged — bump triggers companion IIFE-version drift detect so
// the new companion's setContext dispatches land cleanly across a CC update).
// v0.5.21: loading 图标不可点击(refreshFavStatusBar loading→command undefined;sid→恢复 toggleTab)。根治"显示 loading 但点击时 loading 已过→误 toggle 上个会话"。IIFE body 未变(companion-only);stamp 跟随 5-way pin。
check('IIFE.21c banner carries v0.5.50 stamp', /\/\*cc-status-dot-injected:v0.5.50:/.test(iife));

// --- 10. flashSeq (renamed from `seq`, M8) ----------------------------------
check('IIFE.22 flashSeq drives interrupted flash', /flashSeq\s*%\s*2/.test(iife));
check('IIFE.23 no bare `seq` counter (M8 rename)', !/\bseq\s*%/.test(iife) && !/\bseq\+\+/.test(iife));

// --- 11. SBI aggregation (v0.1.17: single SBI + compact concat text) --------
// The v0.1.13 commandCenter 4-light (20 package.json contribs + setContext
// driver) is GONE. v0.1.14 pivoted to a single runtime StatusBarItem;
// v0.1.15 split into 4 SBIs for fixed per-light slots; v0.1.16 restored
// emoji balls but kept the 4-SBI structure. v0.1.17 COLLAPSES back to a
// single SBI rendering 4 lights as concatenated text `🟢N🟡N🔵N🔴N` (no
// separator) — VSCode's statusbarpart.css `margin:0 3px;padding:0 5px`
// per-SBI made the v0.1.16 4-SBI row look ~16px loose, uncontrollable
// via public API. Position stability (digits never shift the row on count
// change) comes from VSCode's statusbarpart.css `font-variant-numeric:
// tabular-nums`, which forces ASCII digits 0-9 to equal advance width.
//
// ALL the v0.1.14+ aggregation design is preserved: 4 lights incl. NEW
// 🔵 pending; 3-way stale-session GC; pending counted INDEPENDENTLY of
// state; project-scoped __ccsd* prefix (NOT CC's __cc* namespace — see
// the `cc-status-bar-injected` tombstone in restoreWebview()).

// SBI text set at CREATION TIME (not only inside the timer tick).
// Business-logic review round-2 (carried from v0.1.14 → v0.1.15 → v0.1.16
// → v0.1.17): the SBI was created with .tooltip set but .text NEVER set,
// leaving it zero-width/invisible for the ~500ms until the first tick —
// and silently permanent if the timer-setup try/catch swallowed a throw.
// v0.1.17 creates ONE SBI starting at the all-zero form: text
// DIM_EM+"0"+DIM_EM+"0"+DIM_EM+"0"+DIM_EM+"0" (= "⚪0⚪0⚪0⚪0" since v0.2.0
// reverted the ⚪→🟤 pivot back to gray — four zero-slots concatenated, dim
// ball + "0" each) so the slot is born at the full 4-light row width and
// visible from the very first paint. The first aggregation tick rewrites
// text to the live concat (e.g. "🟢3 🟡1 ⚪0 ⚪0" with v0.1.18+ space
// separator). Assert the literal creation-time text appears at the creation
// site so a regression that dropped the assignment would re-open the
// invisibility window.
check(
  'IIFE.23b SBI.text=DIM_EM+"0"+DIM_EM+"0"+DIM_EM+"0"+DIM_EM+"0" set at creation (no 500ms invisibility window)',
  iife.includes('sbi.text=DIM_EM+"0"+DIM_EM+"0"+DIM_EM+"0"+DIM_EM+"0"'),
  'expected creation-time sbi.text=DIM_EM+"0"+DIM_EM+"0"+DIM_EM+"0"+DIM_EM+"0"',
);
check(
  'IIFE.23c NO creation-time sbi.color= assignment (v0.1.16 drops the v0.1.15 dim ThemeColor)',
  !/sbi\.color\s*=/.test(iife),
  'v0.1.16 must not set sbi.color — emoji ball carries its own color',
);
check(
  'IIFE.23d NO creation-time sbi.backgroundColor= assignment (v0.1.16 drops the v0.1.15 themed block)',
  !/sbi\.backgroundColor\s*=/.test(iife),
  'v0.1.16 must not set sbi.backgroundColor — emoji ball carries its own color',
);
check(
  'IIFE.23e NO deactivatedForeground ThemeColor (v0.1.15 dim color gone)',
  !/statusBarItem\.deactivatedForeground/.test(iife),
  'v0.1.16+ uses a dim emoji ball (⚪ — v0.2.0 reverted the v0.1.17 ⚪→🟤 pivot back to gray) for dim, not statusBarItem.deactivatedForeground',
);

// v0.1.17 SINGLE-SBI creation — collapses the v0.1.15/v0.1.16 4-SBI loop
// (4 independent createStatusBarItem at priority -9996..-9999) into ONE
// StatusBarItem at priority SBI_PRIORITY (-9996). The 4 lights now render
// as concatenated text inside the single SBI's `.text` (single-space
// separator since v0.1.18; was no-separator in v0.1.17), NOT as 4 separate
// statusbar items. Why: VSCode's statusbarpart.css hardcodes
// `margin:0 3px;padding:0 5px` per SBI (6-16px gap, uncontrollable via
// public API — the internal IStatusbarEntryLocation.compact flag is not
// reachable from extension code); 4 SBIs therefore always looked loose.
// Single-SBI guard is idempotent across panels via `if(!globalThis.__ccsdSbi)`.
// Per-failure try/catch wraps the whole create-call so a throw inside
// createStatusBarItem / .command= / .show() is swallowed and the IIFE
// continues to the per-tab tick + onDidDispose registration. No
// commit-atomic / partial-failure-cleanup needed (only one resource).
check(
  'IIFE.24a single-SBI idempotent guard (if !globalThis.__ccsdSbi)',
  /if\s*\(\s*!globalThis\.__ccsdSbi\s*\)\s*\{/.test(iife),
);
check(
  'IIFE.24b single-SBI createStatusBarItem(Left, SBI_PRIORITY) with per-failure try/catch',
  /try\s*\{\s*var\s+sbi\s*=\s*vs\.window\.createStatusBarItem\s*\(\s*vs\.StatusBarAlignment\.Left\s*,\s*-9996\s*\)/.test(
    iife,
  ),
);
check(
  'IIFE.24c single-SBI stored to globalThis.__ccsdSbi (NOT __ccsdSbis array)',
  /globalThis\.__ccsdSbi\s*=\s*sbi/.test(iife),
);
// v0.1.17 SIMPLIFICATION: assert the v0.1.15/v0.1.16 4-SBI loop is GONE.
// A regression that revived `var arr=[]` + per-iteration push would
// silently re-introduce the loose 4-SBI row + resurrect the
// commit-atomic / partial-failure-cleanup branches — surface it here.
check(
  'IIFE.24d NO v0.1.16 4-SBI creation loop (no var arr=[], no CFG[k].pri)',
  !/var\s+arr\s*=\s*\[\s*\]/.test(iife) && !/CFG\[k\]\.pri/.test(iife),
);
// R3-5 (round 3, ported): assert no `globalThis.__cc<SOMETHING-WRONG>` leaks —
// the only legitimate prefix is `__ccsd*` (lowercase s after __cc). CC's own
// namespace is `__cc` + capital letter directly. Lock the discriminator so a
// future bad refactor cannot silently occupy CC's __cc* namespace.
check('IIFE.24e SBI uses project-scoped __ccsd* (NOT CC __cc[A-Z] ns)', !/globalThis\.__cc[A-Z]/.test(iife));
// v0.1.14 review round-1 widened the __ccsd* rule to ALSO cover per-panel-
// instance fields stashed on the same `this`/`t` object CC's minified code
// operates on (was: __ccDotStarted / __ccSid / __ccTitle / __ccPending; now
// __ccsd*). The collision rationale is identical to globalThis — a future CC
// release could mint a minified `this.__ccXxx` field that silently overwrites
// our stash. Lock the same discriminator on the panel-instance surface so a
// regression that revived the bare prefix would surface here.
check('IIFE.24f panel-instance stash uses __ccsd* (NOT CC __cc[A-Z] ns)', !/(\bt|this)\.__cc[A-Z]/.test(iife));
// SBI singleton timer — one window-scoped setInterval, idempotent via the
// __ccsdSbiTimer guard.
check(
  'IIFE.25 SBI singleton timer guard (__ccsdSbiTimer) + v0.5.12 immediate first paint (no 500ms delay)',
  /if\s*\(\s*!globalThis\.__ccsdSbiTimer\s*\)\s*\{function\s+__ccsdSbiTick/.test(iife) &&
    /globalThis\.__ccsdSbiTimer\s*=\s*setInterval\(\s*__ccsdSbiTick/.test(iife) &&
    /;__ccsdSbiTick\(\);/.test(iife),
  'v0.5.12 perf: guard prevents duplicate timers; tick extracted to named __ccsdSbiTick + invoked once immediately after setInterval registration (four-light first paint without waiting 500ms)',
);
check(
  'IIFE.25b v0.5.23 §H per-panel tick reads sid.json DIRECTLY (no __ccsdAgCache — fixes §H/§F decay divergence; v0.5.35: pend carries the third __ccsdUserDialogSet OR term)',
  /st=j\.state;since=j\.since;err=j\.error\|\|"";pend=\(j\.pending===true\)\|\|\(globalThis\.__ccsdPendingSet&&globalThis\.__ccsdPendingSet\[sid\]===true\)\|\|\(globalThis\.__ccsdUserDialogSet&&globalThis\.__ccsdUserDialogSet\[sid\]===true\)\}catch\(e\)\{\}/.test(
    iife,
  ) && !/__ccsdAgCache[\s\S]{0,100}?__ch\.j/.test(iife),
  'v0.5.23: §H reads sid.json directly (JSON.parse(readFileSync)), NOT via §F cache. QW4 (v0.5.12 cache reuse) caused §H/§F tick desync — §H read stale cache (running, since=old) while §F read fresh (done, since=Stop) → §H decayed to idle (gray) while §F stayed done (green). Direct read ensures §H always reads latest, same as §F. v0.5.35: pend OR-chain extended with __ccsdUserDialogSet (consent/refusal coverage) mirroring §F.',
);
check(
  'IIFE.25c v0.5.12 I18N dictionary guarded by globalThis.__ccsdI18N (no per-panel 19KB re-alloc)',
  /var\s+I18N\s*=\s*globalThis\.__ccsdI18N\s*\|\|\s*\(\s*globalThis\.__ccsdI18N\s*=/.test(iife),
  'v0.5.12 perf: the 19KB I18N literal is allocated once (first panel) and reused via globalThis — every subsequent panel binds the cached ref instead of re-allocating',
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
// v0.2.5 code-style LOW fix: cap() now uses the named SBI_LIGHT_CAP const
// instead of the bare literal 4 (same value, but the regex needs to accept
// either form for forward/backward compat with older IIFE bodies on disk).
check(
  'IIFE.28 SBI cap() clamps 4+ to 4 (display N)',
  /cap\s*=\s*function\s*\(\s*n\s*\)\s*\{\s*return\s+n\s*>=\s*(?:4|SBI_LIGHT_CAP)\s*\?\s*(?:4|SBI_LIGHT_CAP)\s*:\s*n/.test(
    iife,
  ),
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
//
// v0.2.5 (problem 1 fix): the pending check is now a two-source OR —
// `j.pending===true` (Notification hook → file) OR `__ps[<sid>]===true`
// (rename_tab IPC → globalThis.__ccsdPendingSet). Both branches still gate
// on `st!=="idle"` so decay remains authoritative. The regex below accepts
// EITHER the legacy single-source form OR the new OR form — the OR form's
// definitive tokens (`j.pending===true`, `__ps[`, `st!=="idle"`,
// `ag.pending++`) all appear in order. The strict position lock (IIFE.29b)
// pins the new OR form's `ag.pending++` AFTER the interrupted-decay block.
check(
  'IIFE.29 v0.5.13: SBI count is blue-priority mutually exclusive (pending wins over running/done; OR file-pending OR globalThis set)',
  /var\s+isPend\s*=\s*\(\(j\.pending\s*===\s*true\)/.test(iife) &&
    /__ps\s*=\s*globalThis\.__ccsdPendingSet/.test(iife) &&
    /__ps\[files\[i\]\.slice\(0,-5\)\]/.test(iife) &&
    /st\s*!==\s*"idle"/.test(iife) &&
    /if\(isPend\)\{ag\.pending\+\+;\}/.test(iife) &&
    /else if\(st==="running"\)\{ag\.running\+\+;\}/.test(iife),
  'v0.5.13: pending is priority-overlay + exclusive with state (blue wins; running+pending = +1 blue only). Pre-0.5.13 counted pending INDEPENDENTLY (running+pending → +1 yellow AND +1 blue) — the cause of "two-yellow one-blue".',
);
// v0.5.35 ANCHOR_C sibling assertion: §F isPend must include the third OR term
// __ccsdUserDialogSet[files[i].slice(0,-5)]===true (consent/refusal coverage),
// mirroring the IIFE.12b three-source OR for §H. askUserQuestion is implicitly
// covered via __ps (Fact 1: can_use_tool → tool_permission_request → rename_tab
// hasPendingPermissions → __ps); consent/refusal via __ccsdUserDialogSet.
check(
  'IIFE.29b2 v0.5.35: §F isPend includes __ccsdUserDialogSet third OR term (consent/refusal coverage mirroring §H)',
  /globalThis\.__ccsdUserDialogSet\s*&&\s*globalThis\.__ccsdUserDialogSet\[files\[i\]\.slice\(0,-5\)\]\s*===\s*true/.test(
    iife,
  ),
);
check(
  'IIFE.29a v0.5.24: §F aggregation decay via __ccsdDecayState (decayInterrupted=true, shares the predicate with §H)',
  /st=__ccsdDecayState\(st,since,j,Date\.now\(\),true,__mt\)/.test(iife),
  '§F four-light aggregation calls __ccsdDecayState with decayInterrupted=true (done/interrupted/running all decay) so the tab color and the bottom count NEVER disagree; the predicate is shared with §H (only the read source + decayInterrupted flag differ).',
);
{
  // Position lock: pending check must come AFTER the §F decay call.
  // v0.5.24 (debt #1): the inline interrupted-decay block is gone (unified
  // into __ccsdDecayState); anchor on the §F decay CALL SITE instead.
  // v0.2.5: pendingToken matches the OR form literal
  // (`__ps[files[i].slice(0,-5)]===true` is unique to the OR'd second branch).
  const decayCallToken = 'st=__ccsdDecayState(st,since,j,Date.now(),true,__mt)';
  const pendingToken = '__ps[files[i].slice(0,-5)]===true';
  const decayIdx = iife.indexOf(decayCallToken);
  const pendingIdx = iife.indexOf(pendingToken);
  check(
    'IIFE.29b pending check positioned AFTER §F decay call (ordering lock)',
    decayIdx >= 0 && pendingIdx >= 0 && pendingIdx > decayIdx,
    'decayCall=' + decayIdx + ' pending=' + pendingIdx,
  );
}
// v0.2.5 (problem 1 fix): the per-panel __ccsdPending flag set by Anchor B
// is mirrored into globalThis.__ccsdPendingSet (window-scoped) so the §F
// aggregation (which scans files, not panel objects) can pick up the
// authoritative hasPendingPermissions signal synchronously. The set sync
// lives in replB; onDidDispose clears the entry on panel close. Both
// fragments must be present — the set is the single source of the OR'd
// second branch above. The set-sync block is added at patch time, NOT
// baked into buildIIFE — verify against patch.ts source (mirrors the
// IIFE.55 ANCHOR_A replA pattern).
{
  const patchSrc = fs.readFileSync(path.join(ROOT, 'patch.ts'), 'utf8');
  check(
    'IIFE.29c ANCHOR_B __ps keyed by this.__ccsdSid (v0.5.35: not e.request.sessionId, which is absent in rename_tab)',
    patchSrc.includes('globalThis.__ccsdPendingSet||(globalThis.__ccsdPendingSet=Object.create(null))') &&
      patchSrc.includes(
        'if(this.__ccsdSid){if(${e}.request.hasPendingPermissions){__ps[this.__ccsdSid]=true}else{delete __ps[this.__ccsdSid]}}',
      ),
  );
  check(
    'IIFE.29c2 ANCHOR_B sid-set guarded (v0.5.35: if(e.request.sessionId) — rename_tab must NOT clear the real sid)',
    patchSrc.includes('if(${e}.request.sessionId)this.__ccsdSid=${e}.request.sessionId;'),
  );
}
check(
  'IIFE.29d onDidDispose clears the panel sid from globalThis.__ccsdPendingSet (teardown)',
  /if\s*\(\s*globalThis\.__ccsdPendingSet\s*\)\s*delete globalThis\.__ccsdPendingSet\[t\.__ccsdSid\]/.test(iife) &&
    /else if\s*\(\s*globalThis\.__ccsdActiveSid\s*===\s*t\.__ccsdSid\s*\)/.test(iife),
  'round-1 HIGH fix: both onDidDispose sid references must read t.__ccsdSid (IIFE parameter, in scope) — the per-panel tick var sid is NOT visible here',
);
// v0.2.5 round-2 (MEDIUM): rename_tab can fire BEFORE update_session_state
// (VS Code restart restoring a persisted panel, or CC reattaching a session
// tab title before the full session-state handshake completes). replB must
// therefore stash this.__ccsdSid on rename_tab too — otherwise onDidDispose's
// `delete globalThis.__ccsdPendingSet[t.__ccsdSid]` degrades to a no-op if
// the panel closes in that window, and the set entry leaks. The fix is one
// line `this.__ccsdSid=e.request.sessionId;` in replB; this check pins both
// the literal AND the var→let fix (round-2 LOW: block-scope to the try).
{
  const patchSrc = fs.readFileSync(path.join(ROOT, 'patch.ts'), 'utf8');
  // Count occurrences of the sid-assignment literal. It must appear in BOTH
  // replA (update_session_state, v0.1.x baseline) AND replB (rename_tab,
  // round-2 fix). Pre-round-2 patch.ts has it only once (replA); post-fix
  // patch.ts has it twice (replA + replB). We assert >= 2 occurrences, which
  // uniquely identifies the round-2 addition without being sensitive to
  // surrounding whitespace or comment edits.
  const sidAssignments = patchSrc.split('this.__ccsdSid=${e}.request.sessionId').length - 1;
  check(
    'IIFE.29f ANCHOR_B replB stashes this.__ccsdSid on rename_tab (event-order lock)',
    sidAssignments >= 2,
    'round-2 MEDIUM: replB must assign this.__ccsdSid (>= 2 occurrences expected: replA stash + replB guard, v0.5.49 template form); got ' +
      sidAssignments,
  );
  check(
    'IIFE.29g ANCHOR_B replB uses let __ps (block-scoped, not var hoist)',
    patchSrc.includes('try{let __ps=globalThis.__ccsdPendingSet') &&
      !patchSrc.includes('try{var __ps=globalThis.__ccsdPendingSet'),
    'round-2 LOW: var hoists __ps to the rename_tab handler function top, leaking the binding past the try block; let keeps it local',
  );
  // v0.5.35 ANCHOR_C sentinel: askUserQuestion regression sentinel. The patch.ts
  // ANCHOR_C const + replC must co-exist (the splice wraps requestUserDialog's
  // sendRequest(user_dialog_request) in try/finally). The patched extension.js
  // (built by buildIIFE -> injectFresh) gets verified end-to-end by test-
  // standalone-patch.mjs; here we lock the patch.ts SOURCE so a regression
  // that removes ANCHOR_C (or the co-located user_dialog_request + try/finally)
  // is detected before the standalone suite runs. Sentinel documents the
  // IMPLICIT askUserQuestion dependency (Fact 1: covered via __ps, NOT __ccsd
  // UserDialogSet — re-audit if a future CC reroutes askUserQuestion).
  check(
    'IIFE.29h v0.5.35 ANCHOR_C: patch.ts injects __ccsdUserDialogSet try/finally into requestUserDialog (consent/refusal sentinel; askUserQuestion implicitly via __ps)',
    patchSrc.includes('const ANCHOR_C = anchorCFrom(IDS_C_DEFAULT);') &&
      patchSrc.includes(
        'dialogKind:${ids.dlg}.dialogKind,payload:${ids.dlg}.payload,toolUseID:${ids.dlg}.toolUseID},${ids.cbsink}',
      ) &&
      patchSrc.includes(
        'try{var __csd=this.__ccsdSid;if(__csd){var __ud=globalThis.__ccsdUserDialogSet||(globalThis.__ccsdUserDialogSet=Object.create(null));__ud[__csd]=true}',
      ) &&
      patchSrc.includes(
        'finally{try{if(__csd&&globalThis.__ccsdUserDialogSet)delete globalThis.__ccsdUserDialogSet[__csd]}catch(_){}}',
      ) &&
      patchSrc.includes('if(globalThis.__ccsdUserDialogSet)delete globalThis.__ccsdUserDialogSet[t.__ccsdSid]'),
    'v0.5.35 ANCHOR_C / __ccsdUserDialogSet: three independent OR sources for pend (j.pending / __ps / __ccsdUserDialogSet) per R-INT-07. askUserQuestion is covered via __ps (Fact 1) — re-audit if CC reroutes it.',
  );
  check(
    'IIFE.29i v0.5.35 ANCHOR_C replC keyed by this.__ccsdSid (NOT the channelId first arg e)',
    patchSrc.includes('__ud[__csd]=true') && !/__ud\[e\]=true/.test(patchSrc),
    'channelId != sessionId (webview launchClaude: channelId=Math.random()...; sessionId is the second arg). Keying by `e` would false-key on a random webview string.',
  );
}

// v0.2.5 round-1 (HIGH e2e regression lock): IIFE.29d above is a STRUCTURAL
// regex check — it locks the source literal but cannot detect a scope error.
// The round-1 HIGH bug was exactly that: the onDidDispose callback referenced
// bare `sid` (declared as `var sid` inside the setInterval callback — NOT
// visible to the sibling onDidDispose closure), so
// `delete globalThis.__ccsdPendingSet[sid]` threw ReferenceError (silently
// swallowed by the inner try/catch — set entry stuck), and
// `else if(globalThis.__ccsdActiveSid===sid)` threw too (NOT swallowed —
// escaped to VSCode's event dispatcher, __ccsdActiveSid stayed pointed at
// the closed session, token SBI kept reading the dead <sid>.json). The
// regex-only IIFE.29d test PASSED while the bug shipped.
//
// This block runs the ACTUAL IIFE body in a vm sandbox with mocked
// fs/path/vscode/os and fires the registered onDidDispose callback to verify
// the teardown actually clears the entries. A future re-introduction of the
// scope bug would throw ReferenceError inside the vm context, which we catch
// and surface as a test failure.
{
  // Strip the banner — the body must be the raw `(function(t){...})(this)`.
  const bannerEnd = iife.indexOf('*/');
  const iifeBody = bannerEnd >= 0 ? iife.slice(bannerEnd + 2) : iife;

  // Build a minimal mock for the vscode module. Only the surface reachable
  // at IIFE entry + at dispose time needs to behave; everything else is
  // inert (function bodies that never run because setInterval is a no-op).
  function makeMockVs() {
    return {
      workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
      window: {
        createStatusBarItem: () => ({
          show() {},
          hide() {},
          text: '',
          tooltip: '',
          name: '',
          command: null,
          dispose() {},
        }),
        showInformationMessage() {},
        showErrorMessage() {},
        showWarningMessage() {},
        showQuickPick() {},
        setStatusBarMessage() {},
        state: { active: true },
      },
      commands: {
        registerCommand: () => ({ dispose() {} }),
        executeCommand() {},
      },
      env: { language: 'en', clipboard: { writeText() {} } },
      Uri: { file: (p) => ({ fsPath: p }) },
      StatusBarAlignment: { Left: 1, Right: 2 },
      QuickPickItemKind: { Separator: -1 },
      ConfigurationTarget: { Global: 1 },
    };
  }

  function makeMockFs() {
    return {
      readFileSync: (p, _enc) => {
        if (typeof p === 'string' && p.endsWith('.json')) return JSON.stringify({ state: 'idle', since: null });
        return '';
      },
      statSync: () => ({ mtimeMs: 0, size: 0 }),
      readdirSync: () => [],
      existsSync: () => false,
      openSync: () => 0,
      closeSync: () => undefined,
      readSync: () => 0,
    };
  }

  // Build a fresh sandbox. `initialPanelCount` lets the multi-panel case
  // simulate a pre-existing panel without running a second IIFE entry.
  function makeSandbox(initialPanelCount, sid) {
    const pendingSet = Object.create(null);
    if (sid) pendingSet[sid] = true;
    const requireFn = (mod) => {
      if (mod === 'fs') return makeMockFs();
      if (mod === 'path') return path;
      if (mod === 'vscode') return makeMockVs();
      if (mod === 'os') return { homedir: () => '/tmp/ccsd-test-home' };
      throw new Error('test requires unknown module: ' + mod);
    };
    return {
      require: requireFn,
      // setInterval as no-op: we only care about the dispose callback, which
      // is registered synchronously at IIFE entry. Returning 0 lets the
      // IIFE's `var timer=setInterval(...)` succeed; clearInterval(0) is a
      // no-op on the real API and our mock matches that.
      setInterval: () => 0,
      clearInterval: () => {},
      console: { log() {}, error() {}, warn() {} },
      // Pre-set the globals the onDidDispose teardown will read/mutate so we
      // can assert the delta without depending on ticks actually firing.
      __ccsdPanelCount: initialPanelCount,
      __ccsdPendingSet: pendingSet,
      __ccsdActiveSid: sid || '',
      __ccsdLastActiveSid: sid || '',
    };
  }

  // Minimal panel mock. onDidDispose stores the callback so the test can
  // fire it after IIFE entry; _fireDispose() is the test-only trigger.
  function makePanel(sid) {
    let disposeCb = null;
    const panel = {
      __ccsdSid: sid,
      panelTab: {
        active: true,
        iconPath: null,
        onDidDispose: (cb) => {
          disposeCb = cb;
        },
      },
      context: { extensionPath: '/tmp/ccsd-ext' },
    };
    panel.panelTab._fireDispose = () => {
      if (disposeCb) disposeCb();
    };
    panel._disposeRegistered = () => typeof disposeCb === 'function';
    return panel;
  }

  // Run the IIFE so `this` (which the IIFE passes as `t`) is the panel. We
  // wrap the IIFE in an outer function whose `this` is the panel; the IIFE
  // inside reads that `this` and forwards it as `t`.
  function runIifeEntry(panel, sandbox) {
    sandbox.__panel = panel; // make the panel reachable inside the context
    vm.createContext(sandbox);
    vm.runInContext('(function(){' + iifeBody + '}).call(this.__panel)', sandbox);
  }

  // --- Case A: SINGLE panel. Dispose brings count to 0 → last-panel-out
  //     teardown path. Verifies the delete succeeds (set cleared) AND the
  //     last-panel-out branch clears __ccsdActiveSid/__ccsdLastActiveSid.
  {
    const sid = 'S1';
    const panel = makePanel(sid);
    const sandbox = makeSandbox(0, sid);
    let entryErr = null;
    try {
      runIifeEntry(panel, sandbox);
    } catch (e) {
      entryErr = e;
    }
    check(
      'IIFE.29e (e2e) SINGLE-panel IIFE entry runs without throwing',
      entryErr === null,
      entryErr ? entryErr.message : '',
    );
    check(
      'IIFE.29e (e2e) SINGLE-panel onDidDispose callback was registered',
      panel._disposeRegistered(),
      'panel.panelTab.onDidDispose was not called during IIFE entry',
    );
    let disposeErr = null;
    try {
      panel.panelTab._fireDispose();
    } catch (e) {
      disposeErr = e;
    }
    check(
      'IIFE.29e (e2e) SINGLE-panel onDidDispose fires without ReferenceError',
      disposeErr === null,
      disposeErr ? disposeErr.message : '',
    );
    check(
      'IIFE.29e (e2e) SINGLE-panel onDidDispose clears __ccsdPendingSet[sid]',
      sandbox.__ccsdPendingSet && sandbox.__ccsdPendingSet[sid] === undefined,
      'pendingSet=' + JSON.stringify(sandbox.__ccsdPendingSet || {}),
    );
    check(
      'IIFE.29e (e2e) SINGLE-panel onDidDispose decrements __ccsdPanelCount to 0',
      sandbox.__ccsdPanelCount === 0,
      'count=' + sandbox.__ccsdPanelCount,
    );
    check(
      'IIFE.29e (e2e) SINGLE-panel last-panel-out clears __ccsdActiveSid',
      sandbox.__ccsdActiveSid === '',
      'activeSid="' + sandbox.__ccsdActiveSid + '"',
    );
    check(
      'IIFE.29e (e2e) SINGLE-panel last-panel-out clears __ccsdLastActiveSid',
      sandbox.__ccsdLastActiveSid === '',
      'lastActiveSid="' + sandbox.__ccsdLastActiveSid + '"',
    );
  }

  // --- Case B: MULTI panel (count=2 after entry, dispose → 1). The else-if
  //     branch `else if(globalThis.__ccsdActiveSid===t.__ccsdSid)` is the
  //     critical HIGH-bug path — pre-fix it threw ReferenceError that escaped
  //     to VSCode's event dispatcher (no inner try/catch on this branch).
  //     This case is the regression lock for that specific path: with the
  //     bug, __ccsdActiveSid would stay pointed at the closed 'S1'.
  {
    const sid = 'S1';
    const panel = makePanel(sid);
    const sandbox = makeSandbox(1, sid); // pre-existing panel → entry bumps to 2
    let entryErr = null;
    try {
      runIifeEntry(panel, sandbox);
    } catch (e) {
      entryErr = e;
    }
    check(
      'IIFE.29e (e2e) MULTI-panel IIFE entry runs without throwing',
      entryErr === null,
      entryErr ? entryErr.message : '',
    );
    let disposeErr = null;
    try {
      panel.panelTab._fireDispose();
    } catch (e) {
      disposeErr = e;
    }
    check(
      'IIFE.29e (e2e) MULTI-panel onDidDispose fires without ReferenceError (HIGH-bug path)',
      disposeErr === null,
      disposeErr ? disposeErr.message : '',
    );
    check(
      'IIFE.29e (e2e) MULTI-panel onDidDispose clears __ccsdPendingSet[sid]',
      sandbox.__ccsdPendingSet && sandbox.__ccsdPendingSet[sid] === undefined,
      'pendingSet=' + JSON.stringify(sandbox.__ccsdPendingSet || {}),
    );
    check(
      'IIFE.29e (e2e) MULTI-panel onDidDispose decrements __ccsdPanelCount to 1',
      sandbox.__ccsdPanelCount === 1,
      'count=' + sandbox.__ccsdPanelCount,
    );
    check(
      'IIFE.29e (e2e) MULTI-panel else-if clears __ccsdActiveSid (HIGH-bug regression lock)',
      sandbox.__ccsdActiveSid === '',
      'activeSid="' + sandbox.__ccsdActiveSid + '" — pre-fix ReferenceError left it pointed at the closed session',
    );
  }
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
// Last-panel-out teardown must DISPOSE the single v0.1.17 SBI — locks
// v0.1.17 "light goes away when no CC panel survives" behavior (same UX
// as v0.1.15/v0.1.16 had via the 4-SBI loop). The onDidDispose callback
// calls __ccsdSbi.dispose() wrapped in try/catch, then nulls the ref.
// (was v0.1.15/v0.1.16: `for(k<__ccsdSbis.length) __ccsdSbis[k].dispose()`
// loop; was v0.1.14: single __ccsdSbi.dispose — v0.1.17 returns to this
// shape; was v0.1.13: 4 setContext resets; was v0.1.11: SBI hide.)
check(
  'IIFE.32 SBI last-panel-out disposes the single v0.1.17 SBI (try/catch + null reset)',
  /if\s*\(\s*globalThis\.__ccsdSbi\s*\)\s*\{\s*try\s*\{\s*globalThis\.__ccsdSbi\.dispose\s*\(\s*\)\s*\}\s*catch\s*\(\s*e\s*\)\s*\{\s*\}\s*;\s*globalThis\.__ccsdSbi\s*=\s*null/.test(
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
  'IIFE.33 SBI creation wrapped in try/catch (v0.1.17 single-SBI form)',
  /try\s*\{\s*if\s*\(\s*!globalThis\.__ccsdSbi\s*\)/.test(iife),
);
check(
  'IIFE.34 SBI singleton-timer creation wrapped in try/catch (v0.5.12: named tick + immediate invoke)',
  /try\s*\{\s*if\s*\(\s*!globalThis\.__ccsdSbiTimer\s*\)\s*\{function\s+__ccsdSbiTick/.test(iife) &&
    /setInterval\(\s*__ccsdSbiTick\s*,\s*500\s*\)\s*;\s*__ccsdSbiTick\(\)\s*;\s*\}\s*\}\s*catch\s*\(\s*e\s*\)\s*\{\s*\}/.test(
      iife,
    ),
  'v0.5.12: outer try/catch intact; inner declares named __ccsdSbiTick + registers setInterval + invokes once for immediate first paint',
);
check(
  'IIFE.35 SBI aggregation body wrapped in try/catch (v0.5.12: named __ccsdSbiTick)',
  /function\s+__ccsdSbiTick\s*\(\s*\)\s*\{\s*try\s*\{\s*var\s+ag\s*=\s*\{running:0,done:0,interrupted:0,idle:0,pending:0\}/.test(
    iife,
  ),
  'v0.5.12: tick extracted to named __ccsdSbiTick; aggregation body still opens with try{var ag={...',
);
check(
  'IIFE.36 SBI onDidDispose registration wrapped in try/catch',
  /try\s*\{\s*t\.panelTab\.onDidDispose\s*\(/.test(iife) && /\)\s*\}\s*catch\s*\(\s*e\s*\)\s*\{\s*\}/.test(iife),
);
// Reader-rule parity: aggregation applies §4 done>5min→idle so IDLE sessions
// are NOT counted toward the green light (only ACTIVE done is). A regression
// that dropped this clause would make the 🟢 light over-count stale done.
// v0.5.24 (debt #1): §F done>5min decay moved into __ccsdDecayState. Assert
// the predicate carries the done branch (IIFE.12e pins the full predicate;
// IIFE.29a pins that §F calls it, wiring done decay into aggregation).
check(
  'IIFE.37 SBI applies §4 done>5min→idle rule via __ccsdDecayState (aggregation)',
  /st==="done"&&since&&\(now-since\)>DONE_TO_IDLE_MS\)return "idle"/.test(iife),
);
// §7.2 stale-running heuristic — v0.2.6 round-1 fix: switched from mtime
// (__mt>SBI_RUNNING_STALE_MS) to since-based decay (since>SBI_RUNNING_STALE_MS).
// Rationale: cc-status.js:390-401 Stop case preserveSince path keeps cur.since
// across Stop heartbeats (does NOT refresh since) while writeJsonAtomic
// refreshes mtime — so under CC's drifted inflight>0 Stop payload (workflow
// actually finished but CC keeps re-firing Stop with background_tasks.length=1)
// mtime stays fresh forever and the 30min clock never elapsed. since is
// preserved across the same path so since-decay fires correctly. Lock the
// since-based form so a regression reverting to mtime (and the silent
// stuck-yellow-at-scale bug) would surface. The cache-probe __mt is still
// computed above (used for mtime+size content-change short-circuit) but is
// no longer the decay signal.
// v0.5.2 (#4): the running→idle downgrade is now GATED on
// __ccsdTranscriptFresh(j, files[i].slice(0,-5), …) — a session whose
// transcript (.jsonl) grew within SBI_RUNNING_STALE_MS is actively streaming
// and must NOT decay (long turn / subagent-wait freezes `since` but the jsonl
// keeps growing). The since-based stuck-drift catch is preserved (drifted Stop
// heartbeats refresh the state-file mtime but NOT the transcript).
check(
  'IIFE.37b v0.5.4: SBI running→idle decay REMOVED (proposal 2: gray only from green/done; running stays yellow, active workflows no longer false-gray)',
  !/st\s*===\s*"running"\s*\)\s*\{\s*if\s*\(\s*since.*SBI_RUNNING_STALE_MS.*st\s*=\s*"idle"/.test(iife),
);
// e2e-test round-2: lock the VALUE of SBI_RUNNING_STALE_MS, not just its
// use. The sibling constants DONE_TO_IDLE_MS (IIFE.14) and
// INTERRUPTED_RETENTION_MS (IIFE.37c) both have their literal values locked
// (5*60*1000 and 24*60*60*1000); SBI_RUNNING_STALE_MS did NOT — a regression
// changing 30min to 30sec (would GC legitimate running sessions, killing
// the yellow light) or to 30h (would never GC crashed sessions, re-opening
// the false-stick-at-1 yellow) would not be caught. Mirror the sibling
// assertions so all three decay thresholds have their values pinned.
// v0.2.5 round-2 (ARCH-6): SBI_RUNNING_STALE_MS is template-substituted
// from the patch.ts top-level const, so the IIFE bytes carry either the
// computed numeric form (`var SBI_RUNNING_STALE_MS=1800000;`) OR the prior
// expression form (`var SBI_RUNNING_STALE_MS=30*60*1000;`). Accept either;
// the value is also pinned by test-contract-sync.mjs.
check(
  'IIFE.37b2 SBI_RUNNING_STALE_MS value (30*60*1000)',
  /var\s+SBI_RUNNING_STALE_MS\s*=\s*(?:30\s*\*\s*60\s*\*\s*1000|1800000)/.test(iife),
);
// v0.1.13/v0.1.14 interrupted retention (architecture-review fix): interrupted
// files older than the retention threshold decay to idle so the 🔴 red light
// doesn't monotonically grow from accumulated abandoned interrupted sessions
// (crashed/killed CC never sends SessionEnd). File is NOT deleted — only the
// count drops.
// v0.2.5 round-2 (ARCH-6): INTERRUPTED_RETENTION_MS is template-substituted
// from the patch.ts top-level const, so accept the computed numeric form
// OR the prior expression form.
// v0.2.7 (Q2 interrupted sticky): extended 24h → 7d to keep the 🔴 sticky
// across cross-day workflows. Accept either 24h or 7d so a future revert
// (e.g. user feedback "7d too long, want shorter") only needs to update the
// value without rewriting this test's regex; the load-bearing invariant is
// "the IIFE bytes bake the constant" — the actual value is also pinned by
// test-contract-sync.mjs (cross-file equality with cc-status.js).
check(
  'IIFE.37c SBI INTERRUPTED_RETENTION_MS constant (decay for 🔴, v0.2.7=7d)',
  /var\s+INTERRUPTED_RETENTION_MS\s*=\s*(?:7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000|604800000)/.test(iife),
);
// v0.2.4 follow-up (round-2 data-logic fix): the decay used to key off mtime,
// but orphan SubagentStop / Notification writes on an interrupted parent
// refresh the file's mtime while preserving since (see cc-status.js
// SubagentStop preserveSince + Notification preserveError paths) — under
// orphan activity the retention clock never elapsed. The decay now keys off
// `since` (the terminal timestamp set by StopFailure), mirroring the
// done>5min branch one block up. Lock the since-based form so a regression
// reverting to mtime (and the silent 🔴-grows-forever bug) would surface.
// v0.5.24 (debt #1): interrupted decay moved into __ccsdDecayState, gated by
// decayInterrupted (§F passes true). Assert the predicate carries the
// interrupted branch with the gate + since-based form.
check(
  'IIFE.37d SBI interrupted>retention since decay →idle via __ccsdDecayState (bounds 🔴 growth, orphan-write-proof)',
  /decayInterrupted&&st==="interrupted"&&since&&\(now-since\)>INTERRUPTED_RETENTION_MS\)return "idle"/.test(iife),
);

// --- 14. v0.1.17 per-tick concat render (single SBI, compact text) ----------
// v0.1.17 collapses the v0.1.15/v0.1.16 4-SBI loop back into a SINGLE SBI
// whose text is a 4-token concatenation `🟢N 🟡N 🔵N 🔴N` (single-space
// separator since v0.1.18 — the user's "4 圆点之间间隔不紧凑" feedback
// under v0.1.16 is fixed by removing the 4-SBI row that VSCode's CSS
// forces ~6-16px gap between). Position stability (digits never shift the
// row on count change) is guaranteed by VSCode's statusbarpart.css
// `font-variant-numeric:tabular-nums`, which forces ASCII digits 0-9 to
// equal advance width regardless of font — the explicit "数字不位移"
// requirement is satisfied by this CSS rule alone, independent of emoji
// rendering width.
//
// Per-token render rule (UNCHANGED from v0.1.16, just collected into txt):
//   txt += (n===0 ? DIM_EM : CFG[k].em) + (n>=SBI_LIGHT_CAP ? "N" : ""+n)
// → "🟢3 🟡1 ⚪0 ⚪0" (v0.1.18 space-separated; ⚪ since v0.2.0 reverted
//   the ⚪→🟤 pivot back to gray)
//   was v0.1.16 4 separate SBI texts "🟢3" / "🟡1" / "⚪0" / "⚪0" with
//   ~16px gap between each pair.
// v0.2.5 code-style LOW fix: n>=4 became n>=SBI_LIGHT_CAP (same value).
// The regex accepts either form so the test stays green on pre-v0.2.5 IIFE
// bodies (e.g. on-disk installs that haven't been re-injected yet).
check(
  'IIFE.38 per-tick concat: parts.push((n===0?DIM_EM:CFG[k].em)+(n>=(4|SBI_LIGHT_CAP)?"N":""+n)) + parts.join(" ") (v0.1.18 space-separated)',
  /parts\.push\(\(n===0\?DIM_EM:CFG\[k\]\.em\)\+\(n>=(?:4|SBI_LIGHT_CAP)\?"N":""\+n\)\)/.test(iife) &&
    iife.includes('parts.join(" ")'),
  'expected: parts.push(...) + parts.join(" ") for space-separated lights',
);
check(
  'IIFE.38b NO sbi.backgroundColor assignment in executable code (v0.1.16 drops themed block)',
  !/sbi\.backgroundColor\s*=/.test(iife),
  'v0.1.16 must not set sbi.backgroundColor — emoji carries its own color',
);
check(
  'IIFE.38c NO sbi.color assignment in executable code (v0.1.16 drops white/gray text flip)',
  !/sbi\.color\s*=/.test(iife),
  'v0.1.16 must not set sbi.color — emoji carries its own color',
);
check(
  'IIFE.38c2 NO __ccsdSbiLitBgs / __ccsdSbiDimClr in executable code (only in historical comments)',
  !/__ccsdSbiLitBgs|__ccsdSbiDimClr/.test(iife.replace(/\/\*[\s\S]*?\*\//g, '')),
  'cached ThemeColor identifiers must be gone from executable code',
);
// The cap() helper is UNCHANGED from v0.1.14/v0.1.15 — still clamps 4+ to 4
// so the "N" variant kicks in for >=4 sessions. v0.2.5 code-style LOW fix:
// cap() now uses the named SBI_LIGHT_CAP const instead of the bare literal
// 4 (same value); regex accepts either form for forward/backward compat.
check(
  'IIFE.38d cap() helper unchanged (4+ → 4, drives the "N" variant)',
  /var\s+cap\s*=\s*function\s*\(\s*n\s*\)\s*\{\s*return\s+n\s*>=\s*(?:4|SBI_LIGHT_CAP)\s*\?\s*(?:4|SBI_LIGHT_CAP)\s*:\s*n/.test(
    iife,
  ),
);
// counts[] array indexes match CFG[] (done/running/pending/interrupted). The
// per-SBI loop reads counts[k] — a regression that permuted the order would
// silently swap two lights' digits.
check(
  'IIFE.39 counts[] array indexed in fixed order done/running/pending/interrupted',
  /var\s+counts\s*=\s*\[\s*cd\s*,\s*cr\s*,\s*cp\s*,\s*ci\s*\]/.test(iife),
);
// Tooltip carries the UNcapped breakdown so the user can see real counts even
// when the lights cap at N. All 4 SBIs carry the same tooltip.
// v0.2.4 intra-version i18n round-1: the literal now lives in the I18N dict's
// ttCountsTpl key ("Claude Code: {done} done, {running} running, {pending}
// pending, {interrupted} interrupted" for en) and is filled at runtime via
// tr("ttCountsTpl").replace("{done}",ag.done).... Accept EITHER the pre-i18n
// inline literal form OR the post-i18n tr("ttCountsTpl") form so the
// assertion stays green across the i18n pivot and on pre-i18n on-disk IIFEs.
// The full wiring (per-tick + creation) is pinned by IIFE.79 below.
check(
  'IIFE.40 SBI tooltip = "Claude Code: N done, N running, N pending, N interrupted"',
  iife.includes(
    '"Claude Code: "+ag.done+" done, "+ag.running+" running, "+ag.pending+" pending, "+ag.interrupted+" interrupted"',
  ) || /tr\(\s*"ttCountsTpl"\s*\)\.replace\(\s*"\{done\}"\s*,\s*ag\.done\s*\)/.test(iife),
);
// v0.1.17 per-tick update: STILL has the lastKey memo short-circuit keyed
// on the UNcapped aggregation tuple (steady-state IPC writes drop from
// ~40/s to 0). DROPS the v0.1.15/v0.1.16 per-iteration try/catch loop
// (no longer needed — there's only ONE SBI; a per-token failure would
// only corrupt a locally-scoped `txt` string, not a global SBI reference).
// A regression that dropped the lastKey short-circuit OR revived the
// 4-SBI loop form would surface here.
check(
  'IIFE.40b per-tick update: lastKey short-circuit + single-text concat (v0.1.17)',
  /var\s+key\s*=\s*ag\.done\s*\+\s*","\s*\+\s*ag\.running\s*\+\s*","\s*\+\s*ag\.pending\s*\+\s*","\s*\+\s*ag\.interrupted/.test(
    iife,
  ) &&
    /if\s*\(\s*key\s*!==\s*globalThis\.__ccsdSbiLastKey\s*\)/.test(iife) &&
    /var\s+parts\s*=\s*\[\]\s*;\s*for\s*\(\s*var\s+k\s*=\s*0\s*;\s*k<CFG\.length\s*;\s*k\+\+\s*\)/.test(iife) &&
    /globalThis\.__ccsdSbi\.text\s*=\s*parts\.join\(\s*" "\s*\)/.test(iife) &&
    /globalThis\.__ccsdSbi\.tooltip\s*=\s*tip/.test(iife) &&
    /globalThis\.__ccsdSbi\.show\s*\(\s*\)/.test(iife),
);

// --- 15. SBI config baking (v0.1.17: {key,em}; pri dropped, SBI_PRIORITY const) ---
// The 4-light config (key/em per light) is baked into the IIFE as a
// JSON-stringified array literal `var CFG=[...]` from SBI_LIGHTS_CFG
// (patch.ts source). v0.1.17 dropped the v0.1.15/v0.1.16 `pri` field —
// the 4 lights now render inside ONE SBI, so per-light priority became
// dead data. The single SBI's priority is baked as a separate numeric
// literal at the createStatusBarItem call site (SBI_PRIORITY = -9996).
// Locking the exact CFG content matters: a permutation would silently
// swap two lights' emoji/order, and a wrong codepoint would make a light
// render with the wrong colored ball.
check(
  'IIFE.41 SBI CFG array baked from SBI_LIGHTS_CFG (4 lights, key/em per entry — v0.1.17 drops pri)',
  iife.includes('var CFG=' + JSON.stringify(SBI_LIGHTS_CFG) + ';'),
);
// DIM_EM baked as a sibling string literal — locks the shared zero-count
// dim ball. JSON.stringify emits the ⚪ literal (BMP codepoint U+26AA;
// v0.2.0 reverted the v0.1.17 ⚪→🟤 pivot back to gray), which VSCode
// parses back to ⚪ at load time.
check(
  'IIFE.41a SBI DIM_EM baked from SBI_DIM_EM (shared zero-count dim ball ⚪)',
  iife.includes('var DIM_EM=' + JSON.stringify(SBI_DIM_EM) + ';'),
);
// Lock the 4 on-color emoji codepoints explicitly so a wrong codepoint (e.g.
// 🟠 U+1F7E0 instead of 🟢 U+1F7E2) would surface before any visual test.
// The bake emits each emoji as a surrogate pair; comparing via the parsed
// SBI_LIGHTS_CFG value (not raw bytes) is what we want.
check(
  'IIFE.41b CFG em[0] done = 🟢 U+1F7E2 (green large circle)',
  iife.includes('"em":"' + SBI_LIGHTS_CFG[0].em + '"'),
);
check(
  'IIFE.41c CFG em[1] running = 🟡 U+1F7E1 (yellow large circle)',
  iife.includes('"em":"' + SBI_LIGHTS_CFG[1].em + '"'),
);
check(
  'IIFE.41d CFG em[2] pending = 🔵 U+1F535 (blue large circle)',
  iife.includes('"em":"' + SBI_LIGHTS_CFG[2].em + '"'),
);
check(
  'IIFE.41e CFG em[3] interrupted = 🔴 U+1F534 (red large circle)',
  iife.includes('"em":"' + SBI_LIGHTS_CFG[3].em + '"'),
);
// v0.1.17 SBI_PRIORITY baked as the literal -9996 at the createStatusBarItem
// call site (replaces the v0.1.15/v0.1.16 per-light pri field). Locks the
// leftmost-of-the-old-4 priority so the single SBI lands at the same screen
// position as the v0.1.16 done-slot did.
check(
  'IIFE.41f single-SBI priority literal -9996 at createStatusBarItem call',
  /vs\.window\.createStatusBarItem\s*\(\s*vs\.StatusBarAlignment\.Left\s*,\s*-9996\s*\)/.test(iife),
);
// v0.1.17 CFG MUST NOT carry a per-light pri field — a regression that
// revived it would indicate a partial rollback to v0.1.16 4-SBI structure.
check(
  'IIFE.41g NO CFG "pri" field (v0.1.17 single-SBI, per-light priority gone)',
  !/"pri"\s*:/.test(iife),
  'v0.1.17 CFG must use {key,em} only — pri dropped when 4 SBI → 1 SBI',
);
// v0.1.15 ThemeColor bg field MUST be gone — a regression that revived it
// would indicate a partial rollback to the colored-block treatment. The
// `bg` key should not appear anywhere in CFG.
check(
  'IIFE.41h NO CFG "bg" field (v0.1.15 ThemeColor ids gone)',
  !/"bg"\s*:/.test(iife),
  'v0.1.16 CFG must use "em" (emoji), not "bg" (ThemeColor id)',
);
// v0.1.14 emoji artifacts (EM array, DIM, disp fn) MUST ALSO be gone —
// v0.1.16 brought emoji balls back but via CFG[k].em + DIM_EM, NOT via the
// v0.1.14 single-SBI `var EM=[...]` + `var DIM=...` + `disp(em,n)` join.
check('IIFE.41i no var EM (v0.1.14 emoji array form not revived)', !/var\s+EM\s*=/.test(iife));
check('IIFE.41j no var DIM (v0.1.14 dim emoji form not revived)', !/var\s+DIM\s*=/.test(iife));
check('IIFE.41k no disp() function (v0.1.14 single-SBI render fn not revived)', !/var\s+disp\s*=/.test(iife));

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
  'IIFE.44 SBI.command wired to ccStatusDot.sbiClick on the single v0.1.17 SBI',
  /sbi\.command\s*=\s*"ccStatusDot\.sbiClick"/.test(iife),
);

// --- 17. per-tab rendering unchanged (regression check) ---------------------
// Per-tab rendering is UNCHANGED by v0.1.14 — assert the iconPath assignment
// still exists AFTER the aggregation block (a refactor that dropped per-tab
// dots while leaving only the SBI would pass every other assertion).
// v0.2.9: regex updated from `p.iconPath=vs.Uri.file` to `p.iconPath=ccuri`
// (Q5 Fix 1 — Uri cache memoizes vs.Uri.file; the per-tab assignment is
// unchanged in semantics, only the wrapping helper changed).
check('IIFE.45 per-tab p.iconPath assignment still present', /p\.iconPath\s*=\s*ccuri/.test(iife));

// --- 18. Decay-profile UNIFICATION lock (v0.5.2 #4) ---------------------------
// HISTORY: through v0.5.1 the per-tab tick and the §F aggregate tick maintained
// PARALLEL copies of the running-decay logic with subtly different thresholds —
// per-tab SINCE_STALE_MS=15min vs aggregate SBI_RUNNING_STALE_MS=30min. The
// architecture-review round-2 (IIFE.46b) deliberately LOCKED that divergence.
// v0.5.2 (#4) COLLAPSES it: both surfaces now share ONE threshold
// (SBI_RUNNING_STALE_MS, 30min) AND ONE activity predicate
// (__ccsdTranscriptFresh — transcript .jsonl mtime), so the tab and the bottom
// 🟡 can never disagree in a 15-30min window, and a genuinely-active long
// workflow no longer false-decays when `since` (the *→running transition time)
// is frozen mid-turn. The retired SINCE_STALE_MS constant and the dead
// SVG-selection decay ternaries (F4) are asserted ABSENT below so the
// copy-paste-with-divergence cannot silently return.
{
  // SINCE_STALE_MS must be GONE from the entire IIFE (constant + every
  // reference). A regression that re-introduced the 15min per-tab split would
  // re-open the 15-30min tab-gray/bottom-yellow window the user reported.
  check(
    'IIFE.46 v0.5.2: SINCE_STALE_MS fully RETIRED from the IIFE (no constant, no reference)',
    !/SINCE_STALE_MS/.test(iife),
    'SINCE_STALE_MS survived — the per-tab/SBI decay divergence must stay collapsed',
  );
  // v0.5.5: __ccsdTranscriptFresh removed (dead after v0.5.4 running-decay removal).
  check(
    'IIFE.46a v0.5.5: __ccsdTranscriptFresh REMOVED (dead code — v0.5.4 removed running decay which was its only caller)',
    !/function\s+__ccsdTranscriptFresh/.test(iife),
    'the function must NOT be present (it was the transcript-mtime gate for running decay, now removed by proposal 2)',
  );
  // Split the IIFE at the per-tab tick to isolate the two decay sites.
  const perTabAnchor = 'var timer=setInterval(function(){';
  const splitIdx = iife.indexOf(perTabAnchor);
  const sbiPart = splitIdx >= 0 ? iife.slice(0, splitIdx) : iife;
  const perTabPart = splitIdx >= 0 ? iife.slice(splitIdx) : '';
  check(
    'IIFE.46b SBI tick body references SBI_RUNNING_STALE_MS + INTERRUPTED_RETENTION_MS (aggregate decay)',
    /SBI_RUNNING_STALE_MS/.test(sbiPart) && /INTERRUPTED_RETENTION_MS/.test(sbiPart),
    'SBI tick should apply running-stale + interrupted-retention decay',
  );
  // v0.5.24 (debt #1): per-tab decay unified into __ccsdDecayState. The
  // per-tab tick CALLS the predicate with decayInterrupted=false — only
  // done/running decay on the tab; interrupted stays red for diagnostics
  // (STATES.md §7.4). Thresholds (SBI_RUNNING_STALE_MS etc.) now live in
  // the shared declaration, not the per-tab body.
  check(
    'IIFE.46b2 v0.5.24: per-tab tick decays via __ccsdDecayState(decayInterrupted=false) — interrupted stays red on tab',
    /st=__ccsdDecayState\(st,since,j,now,false,__mt\)/.test(perTabPart) &&
      /var __mt=0;try\{var __s2=fs\.statSync\(pth\.join\(DIR/.test(perTabPart) &&
      /__mt=__s2\.mtimeMs;\}catch\(_\)\{\}/.test(perTabPart),
    'per-tab tick calls __ccsdDecayState with decayInterrupted=false (done/running decay only; interrupted stays red on tab per STATES.md §7.4). Predicate + thresholds live in the shared declaration.',
  );
  // v0.5.2 (F4): the per-tab SVG-selection running/done decay ternaries are
  // REMOVED as dead code (decay now happens once, BEFORE the pending check).
  // Assert the simplified unconditional branches + that NO SINCE_STALE_MS
  // ternary survived in the SVG switch.
  check(
    'IIFE.46c v0.5.2 (F4): per-tab SVG running/done branches simplified (dead decay ternaries removed); decay consolidated above the pending check',
    /else if\s*\(\s*st\s*===\s*"running"\s*\)\s*\{\s*svg\s*=\s*favOf\s*\(\s*pth\.join\s*\(\s*RES\s*,\s*"claude-logo-running\.svg"\s*\)\s*,\s*sid\s*\)\s*\}/.test(
      perTabPart,
    ) && !/svg\s*=\s*\(\s*since\s*&&\s*\(\s*now\s*-\s*since\s*>\s*SINCE_STALE_MS/.test(perTabPart),
    'per-tab running branch should be a plain favOf(running.svg); the stale-ternary dead code must stay removed',
  );
}

// v0.5.2 (#4): SINCE_STALE_MS is retired — no value to pin. Instead assert the
// UNIFICATION invariant: per-tab and §F share SBI_RUNNING_STALE_MS, whose value
// is still pinned at IIFE.37b2 (30min). A future split that re-introduced a
// distinct per-tab constant would have to add a NEW var declaration, which the
// IIFE.46 absence-assertion above already catches.
check(
  'IIFE.46d v0.5.2: no per-tab SINCE_STALE_MS declaration (retired; per-tab shares SBI_RUNNING_STALE_MS)',
  !/var\s+SINCE_STALE_MS\s*=/.test(iife),
  'SINCE_STALE_MS declaration survived retirement',
);

// --- 19. Writer-hook content-hash gate (R3 architecture fix; mirrors IIFE.21b) ---
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
  const SRC_HOOK_VERSION = 'v0.2.2'; // mirror HOOK_VERSION in patch.ts (v0.2.2 headless-exclusion contract bump)
  const HOOK_HASH_LEN = 8;
  let hookSrc = '';
  try {
    hookSrc = fs.readFileSync(HOOK_SRC, 'utf8');
  } catch (e) {
    // read failure -> skip section but record a fail so the missing file is loud
    check('IIFE.47a source hook readable', false, String(e));
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

// --- 20. v0.2.4 token-stats SBI: creation, priority, click command, tick ----
// Verify the IIFE bakes the v0.2.4 token-stats SBI (right side, -9995 priority)
// wired to its own click command, plus the QuickPick panel + helpers. The
// 4-light SBI (Left, -9996) must remain intact alongside it.
check(
  'IIFE.48 token SBI created at StatusBarAlignment.Right, -9995',
  /vs\.window\.createStatusBarItem\s*\(\s*vs\.StatusBarAlignment\.Right\s*,\s*-9995\s*\)/.test(iife),
);
check('IIFE.49 token SBI stored to globalThis.__ccsdTokSbi', /globalThis\.__ccsdTokSbi\s*=\s*tsbi/.test(iife));
check(
  'IIFE.50 token SBI click command registered (ccStatusDot.tokClick)',
  /vs\.commands\.registerCommand\s*\(\s*"ccStatusDot\.tokClick"/.test(iife),
);
check(
  'IIFE.51 token SBI.command wired to ccStatusDot.tokClick',
  /tsbi\.command\s*=\s*"ccStatusDot\.tokClick"/.test(iife),
);
// 4-light SBI MUST remain at Left -9996 (regression — token SBI pivot must
// not have moved the existing SBI).
check(
  'IIFE.52 4-light SBI still at StatusBarAlignment.Left, -9996',
  /vs\.window\.createStatusBarItem\s*\(\s*vs\.StatusBarAlignment\.Left\s*,\s*-9996\s*\)/.test(iife),
);
// Token SBI tick update: reads <activeSid>.json tokens field, formats as text.
// v0.2.5 round-3 (code-style LOW fix): the cache-miss branch dropped its
// redundant `var` keyword (the cache-probe slot `var tj=null;` declares tj
// for the whole function scope — re-declaring with a second `var` inside the
// `if(!tj){try{...}}` branch was a no-op). The regex now accepts BOTH the
// legacy `var tj=JSON.parse(...)` form AND the cleaned `tj=JSON.parse(...)`
// form so the test stays green on pre-v0.2.5 IIFE bodies (e.g. on-disk
// installs that haven't been re-injected yet).
check(
  'IIFE.53 token SBI tick reads active sid JSON',
  /(?:var\s+)?tj\s*=\s*JSON\.parse\s*\(\s*fs\.readFileSync\s*\(\s*pth\.join\s*\(\s*DIR\s*,\s*activeSid\s*\+\s*"\.json"\s*\)/.test(
    iife,
  ),
);
// Active-sid tracking in per-panel tick.
check(
  'IIFE.54 per-panel tick updates globalThis.__ccsdActiveSid from t.__ccsdSid',
  /globalThis\.__ccsdActiveSid\s*=\s*sid/.test(iife),
);
// ANCHOR_A also publishes the active sid on every update_session_state fire.
// (replA is added at patch time, NOT baked into buildIIFE — verify against
// patch.ts source rather than the IIFE output.)
{
  const patchSrc = fs.readFileSync(path.join(ROOT, 'patch.ts'), 'utf8');
  check(
    'IIFE.55 ANCHOR_A replA publishes globalThis.__ccsdActiveSid=e.request.sessionId',
    patchSrc.includes('globalThis.__ccsdActiveSid=${e}.request.sessionId;'),
  );
}
// fmtTok helper present.
// v0.3.0 (lane E): regex unchanged (format-agnostic — only asserts the
// function name exists). Descriptive label updated to reflect the new
// k/M/B/T 4-sig-fig adaptive format. Sample outputs verified at 1234→
// "1.23k", 1234567→"1.23M", 1234567890→"1.23B", 796007504→"796M",
// 1500000000→"1.50B" (the user complaint case), 1e12→"1T".
check(
  'IIFE.56 fmtTok helper present (v0.3.0: k/M/B/T 4-sig-fig adaptive, trailing-zero strip)',
  /function\s+fmtTok\s*\(/.test(iife),
);
// fmtUsd helper present.
check('IIFE.57 fmtUsd helper present (null → "", <0.01 → 3-decimal)', /function\s+fmtUsd\s*\(/.test(iife));
// showTokQuickPick present (token SBI click handler).
check('IIFE.58 showTokQuickPick function defined', /function\s+showTokQuickPick\s*\(/.test(iife));
// QuickPick carries the standard sections (window / display / notify / actions).
check('IIFE.59 QuickPick offers Statistics window selector', iife.includes('Statistics window: '));
check('IIFE.60 QuickPick offers Display mode selector', iife.includes('Display: '));
check('IIFE.61 QuickPick carries Copy token count action', iife.includes('Copy token count'));
check('IIFE.62 QuickPick carries Reset session stats action', iife.includes('Reset session stats'));
check('IIFE.63 QuickPick carries Open Settings action', iife.includes('Open Settings'));
// onDidDispose teardown must dispose BOTH SBIs.
check(
  'IIFE.64 onDidDispose disposes token SBI on last-panel-out',
  /if\s*\(\s*globalThis\.__ccsdTokSbi\s*\)\s*\{\s*try\s*\{\s*globalThis\.__ccsdTokSbi\.dispose\s*\(\s*\)/.test(iife),
);
// Threshold alert wired (warnThresholdUsd → fires alert notification).
// v0.2.5: the alert BYPASSES the notify() completion/focus gates (the user
// explicitly set a budget threshold — it should fire even with notify=false
// or while VS Code is focused). Accept either the legacy notify("warn",...)
// call or the new direct showWarningMessage + osascript path. v0.2.5
// architecture dedup: the alert path now calls dispatchNotify() (shared
// with notify()) instead of open-coding showWarningMessage + osascript.
// v0.2.4 intra-version i18n: the alert message is now built via
// tr("alCostAlertTpl").replace("{cost}", ...) instead of an inline literal,
// so the dispatchNotify first-arg is tr(...) not a string. Accept BOTH the
// pre-i18n literal form and the post-i18n tr("alCostAlertTpl") form so the
// assertion stays green across the i18n pivot and on pre-i18n on-disk IIFEs.
check(
  'IIFE.65 threshold alert reads warnThresholdUsd and fires alert',
  /cfg\.get\s*\(\s*"warnThresholdUsd"\s*,\s*0\s*\)/.test(iife) &&
    /CC cost alert/.test(iife) &&
    (/notify\s*\(\s*"warn"\s*,\s*"CC cost alert/.test(iife) ||
      /showWarningMessage\s*\(\s*alertMsg/.test(iife) ||
      /dispatchNotify\s*\(\s*"CC cost alert/.test(iife) ||
      /dispatchNotify\s*\(\s*tr\(\s*"alCostAlertTpl"\s*\)/.test(iife)),
);
// Token SBI tick is INSIDE __ccsdSbiTimer (shares the 500ms tick — no new setInterval for token update).
// v0.3.0 added a 3rd setInterval inside showRateChart for the webview postMessage
// refresh. v0.5.1 REMOVED the chart panel entirely (inline tok/s suffix covers
// the user's actual need) — the chart-panel setInterval went with it, so the
// expected count drops back from 3 to 2 (__ccsdSbiTimer + per-panel timer).
check(
  'IIFE.66 token SBI tick shares __ccsdSbiTimer (no new setInterval for token update; v0.5.1 chart-panel timer removed)',
  (iife.match(/setInterval/g) || []).length === 2, // __ccsdSbiTimer + per-panel timer (chart panel removed v0.5.1)
);
// Turn-running tooltip is present.
// v0.2.4 intra-version i18n: the literal now lives in the I18N dict's en
// value "Turn running: {secs}s" — substring "Turn running:" still matches.
check('IIFE.67 turn-running tooltip rendered when state=running', iife.includes('Turn running:'));

// --- 21. v0.2.4 intra-version i18n: LANG detection + I18N dict + t() ------
// The QuickPick config panel + token SBI tooltip + threshold alert now route
// every user-facing string through t(key). LANG follows vscode.env.language
// (BCP-47 primary subtag: zh-cn→zh, pt-br→pt, unknown→en fallback). The dict
// is baked via JSON.stringify(I18N_DICT) in patch.ts; every key must carry
// all 8 languages (zh/en/ja/de/es/fr/pt/ru) or t() returns the key itself
// (visibly broken). These assertions pin the i18n MECHANISM; per-key value
// correctness is covered by the source-of-truth I18N_DICT in patch.ts.
check(
  'IIFE.68 LANG detection from vs.env.language (lowercase + primary subtag)',
  /var\s+LANG\s*=\s*\(vs\.env\.language\s*\|\|\s*"en"\s*\)\.toLowerCase\(\)\.split\(\s*"-"\s*\)\[0\]/.test(iife),
);
check(
  'IIFE.69 I18N dictionary baked into IIFE (v0.5.12: globalThis.__ccsdI18N guard)',
  /globalThis\.__ccsdI18N\s*\|\|\s*\(\s*globalThis\.__ccsdI18N\s*=\s*\{/.test(iife),
);
check(
  'IIFE.70 tr() helper with en fallback (I18N[k][LANG]→I18N[k].en→k)',
  /function\s+tr\(\s*k\s*\)\s*\{\s*var\s+e\s*=\s*I18N\[k\]\s*;\s*return\s+e\s*&&\s*\(\s*e\[LANG\]\s*\|\|\s*e\.en\s*\)\s*\|\|\s*k/.test(
    iife,
  ),
);
// Every I18N dict key must carry all 8 languages. We extract the baked dict
// from the IIFE and assert key-count × 8-lang completeness. This is the
// strongest structural gate: a missing language on any key would make t()
// return the key itself for that locale (visibly broken UI).
{
  // Locate `var I18N={...};` in the IIFE and extract the object literal.
  const m = iife.match(/globalThis\.__ccsdI18N\s*=\s*(\{[^;]*\})\s*\)\s*;\s*function\s+tr\(/);
  if (!m) {
    check('IIFE.71 I18N dict extractable for completeness check', false);
  } else {
    let dict;
    try {
      dict = JSON.parse(m[1]);
    } catch (e) {
      check('IIFE.71 I18N dict is valid JSON', false);
      dict = null;
    }
    if (dict) {
      const LANGS = ['zh', 'en', 'ja', 'de', 'es', 'fr', 'pt', 'ru'];
      const keys = Object.keys(dict);
      // Sanity: the dict covers the known surface area (QuickPick + tooltip +
      // feedback + alert). Pin a representative lower bound so a future
      // refactor that accidentally drops a category fails loudly.
      check('IIFE.71a I18N dict has >=40 keys (covers QuickPick+tooltip+feedback+alert)', keys.length >= 40);
      // Every key must have all 8 languages with a non-empty string value.
      let complete = true;
      const missing = [];
      for (const k of keys) {
        for (const lang of LANGS) {
          const v = dict[k] && dict[k][lang];
          if (typeof v !== 'string' || v.length === 0) {
            complete = false;
            missing.push(k + '.' + lang);
          }
        }
      }
      check(
        'IIFE.71b every I18N key has all 8 languages non-empty' +
          (missing.length
            ? ' (missing: ' + missing.slice(0, 5).join(', ') + (missing.length > 5 ? ', …' : '') + ')'
            : ''),
        complete,
      );
      // LANG fallback chain: t() returns e[LANG]||e.en||k. Verify the dict
      // actually has an "en" entry for every key (otherwise fallback crashes).
      check(
        'IIFE.71c every I18N key has an "en" fallback entry',
        keys.every((k) => typeof dict[k].en === 'string' && dict[k].en.length > 0),
      );
    }
  }
}
// LANG detection normalizes regional variants to the primary subtag. The
// regex above (IIFE.68) pins the IMPLEMENTATION; this assertion pins the
// BEHAVIOR by evaluating the detection expression with stubbed inputs.
{
  const stub = (lang) => (lang || 'en').toLowerCase().split('-')[0];
  check('IIFE.72a LANG(zh-cn) → zh (regional variant collapses)', stub('zh-cn') === 'zh');
  check('IIFE.72b LANG(zh-tw) → zh (traditional also collapses)', stub('zh-tw') === 'zh');
  check('IIFE.72c LANG(pt-br) → pt (Brazilian collapses to pt)', stub('pt-br') === 'pt');
  check('IIFE.72d LANG(en-us) → en', stub('en-us') === 'en');
  check('IIFE.72e LANG(ja) → ja', stub('ja') === 'ja');
  check('IIFE.72f LANG(undef) → en (null/undefined falls back to en)', stub(undefined) === 'en');
  check('IIFE.72g LANG(ko) → ko (unknown passes through; t() falls back to en value)', stub('ko') === 'ko');
}
// showTokQuickPick routes its placeHolder + every label/detail through tr().
// Sample a few representative keys to confirm the wiring survived minification.
check(
  'IIFE.73 QuickPick placeHolder routed through tr("qpPlaceHolder")',
  /showQuickPick\s*\(\s*items\s*,\s*\{\s*placeHolder\s*:\s*tr\(\s*"qpPlaceHolder"\s*\)/.test(iife),
);
check(
  'IIFE.74 QuickPick Statistics-window label routed through tr("qpStatsWindowLabel")',
  /tr\(\s*"qpStatsWindowLabel"\s*\)\s*\+\s*curWin/.test(iife),
);
check(
  'IIFE.75 QuickPick item matching uses LOCALIZED label prefix (not English literal)',
  /label\.indexOf\s*\(\s*tr\(\s*"qpStatsWindowLabel"\s*\)\s*\)\s*===\s*0/.test(iife),
);
// Token SBI tooltip routes Window/Session-total/partial through tr().
check(
  'IIFE.76 token SBI tooltip Window line via tr("ttWindowTpl")',
  /tr\(\s*"ttWindowTpl"\s*\)\.replace\(\s*"\{win\}"\s*,\s*tWin\s*\)/.test(iife),
);
check(
  'IIFE.77 token SBI tooltip partial-estimate note via tr("ttPartial")',
  /ttip\.push\s*\(\s*tr\(\s*"ttPartial"\s*\)\s*\)/.test(iife),
);
// Threshold alert message routed through tr("alCostAlertTpl").
check(
  'IIFE.78 threshold alert message via tr("alCostAlertTpl").replace("{cost}",...)',
  /dispatchNotify\s*\(\s*tr\(\s*"alCostAlertTpl"\s*\)\.replace\(\s*"\{cost\}"\s*,\s*fmtUsdApprox\s*\(\s*tok\.cost_24h\s*\)\s*\)/.test(
    iife,
  ),
);
// v0.2.4 intra-version i18n round-1: the 4-light SBI tooltip (§F per-tick
// + §C creation-time zero-tooltip) now routes through tr("ttCountsTpl")
// instead of the hardcoded English "Claude Code: N done, N running, N
// pending, N interrupted" literal. Both sites fill {done}/{running}/
// {pending}/{interrupted} via .replace() chains. Accept EITHER the pre-i18n
// literal form OR the post-i18n tr("ttCountsTpl") form so the assertion
// stays green on pre-i18n on-disk IIFEs too.
check(
  'IIFE.79 4-light SBI tooltip routed through tr("ttCountsTpl") (per-tick + creation)',
  /tr\(\s*"ttCountsTpl"\s*\)\.replace\(\s*"\{done\}"\s*,\s*ag\.done\)/.test(iife) &&
    /tr\(\s*"ttCountsTpl"\s*\)\.replace\(\s*"\{done\}"\s*,\s*0\)/.test(iife),
);

// --- 22. v0.2.5 problem 2: IIFE-side live delta (computeLiveDelta) ---------
// The token SBI tick now reads the parent transcript's [sidecar.offset..
// jsonl.size] tail directly so token counts update during CC streaming
// (between hook fires). computeLiveDelta is a read-only helper with strict
// invariants — every miss returns null and the tick falls back to
// hook.tokens-only display (zero delta). Lock the helper signature +
// integration so a refactor that drops the helper or the tick call-site
// lights up these assertions.
check(
  'IIFE.80 computeLiveDelta(tj,sid,winMs) helper defined (round-3 MEDIUM: winMs param added for rolling-window filter)',
  /function\s+computeLiveDelta\s*\(\s*tj\s*,\s*sid\s*,\s*winMs\s*\)\s*\{/.test(iife),
);
// Strict invariants — must skip when:
//   - !tj.tokens (no baseline; hook MUST fire first to set sidecar.offset)
//   - !tj.cwd (cannot locate jsonl)
//   - tj.state !== 'running' (streaming only happens in running state)
//   - sidecar.offset <= 0 (defensive; hook cursor has not advanced)
// Each guard is documented in the helper JSDoc; lock them so a refactor
// that silently drops any guard re-introduces a double-count or null-deref.
check(
  'IIFE.81 computeLiveDelta skip guards (no tokens / no cwd / not running / offset<=0)',
  /if\s*\(\s*!tj\s*\|\|\s*!tj\.tokens\s*\|\|\s*!tj\.cwd\s*\|\|\s*!sid\s*\|\|\s*tj\.state\s*!==\s*"running"\s*\)\s*return\s+null/.test(
    iife,
  ) && /if\s*\(\s*offset\s*<=\s*0\s*\)\s*return\s+null/.test(iife),
);
// cache_creation dual-form (object vs scalar) — mirrors cc-status.js:1417-1425.
// hasCcObj chooses the object form (ephemeral_5m_input_tokens + ephemeral_1h_input_tokens)
// and zeroes the scalar (cache_creation_input_tokens); the inverse when no object.
check(
  'IIFE.82 computeLiveDelta mirrors hook cache_creation dual-form (hasCcObj)',
  /var\s+hasCcObj\s*=\s*u\.cache_creation\s*&&\s*typeof\s+u\.cache_creation\s*===\s*"object"/.test(iife) &&
    /d\.cc5\s*\+=\s*hasCcObj\s*\?\s*\(u\.cache_creation\.ephemeral_5m_input_tokens\s*\|\|\s*0\)\s*:\s*0/.test(iife) &&
    /d\.cci\s*\+=\s*hasCcObj\s*\?\s*0\s*:\s*\(u\.cache_creation_input_tokens\s*\|\|\s*0\)/.test(iife),
);
// Hard cap toRead<=512KB bounds worst-case streaming catch-up so a multi-MB
// tail (long streaming on a slow hook path) cannot stall the 500ms tick.
// v0.2.5 round-3 (MEDIUM): previously the cap RETURNED null on >512KB,
// silently freezing the displayed total. Now it READS the 512KB tail with
// truncated=true so computeLiveDelta can signal partial-delta to callers
// (the boolean is kept on the result even though the v0.2.5 tooltip no
// longer surfaces it — the cap+tail read itself is the behavior locked here).
check(
  'IIFE.83 computeLiveDelta 512KB hard cap on tail read (round-3 MEDIUM: cap→tail+truncated, no silent null)',
  /if\s*\(\s*toRead\s*>\s*524288\s*\)\s*\{[^}]*truncated\s*=\s*true/.test(iife),
);
// Partial-line safety: if the read buffer has no trailing '\n', the last
// row may be a half-flushed byte stream — return null so the tick shows
// no delta (next tick re-reads once the row completes).
check(
  'IIFE.84 computeLiveDelta partial-line guard (no \\n in buf → null)',
  /var\s+lastNl\s*=\s*buf\.lastIndexOf\s*\(\s*0x0a\s*,\s*br\s*-\s*1\s*\)/.test(iife) &&
    /if\s*\(\s*lastNl\s*<\s*0\s*\)\s*\{?\s*return\s+null/.test(iife),
);
// cwd→projects-dir escape rule: /[^a-zA-Z0-9._-]/g (verified against
// ~/.claude/projects/ on disk — matches CC's escape for both ASCII and
// non-ASCII paths; e.g. /Users/wangdong/.../vscode-cc-提示插件/... →
// -Users-wangdong-...-vscode-cc------...).
// v0.2.5 round-2 (MEDIUM): the escape rule is now a FALLBACK — the IIFE
// prefers tj.transcript_path (authoritative, persisted by the hook on every
// TOK_EVENT fire). The escape rule only runs for old <sid>.json files
// written before the round-2 fix (no transcript_path field). Lock the
// fallback stays in place so the IIFE can still locate the jsonl on stale
// state files; the transcript_path-preferred path is locked by IIFE.93.
check(
  'IIFE.85 computeLiveDelta cwd escape rule /[^a-zA-Z0-9._-]/g (fallback path)',
  /tj\.cwd\.replace\s*\(\s*\/\[\^a-zA-Z0-9\._-\]\/g\s*,\s*"-"s*\)/.test(iife),
);
// v0.2.5 round-2 (MEDIUM): the hook now persists status.transcript_path on
// every TOK_EVENT fire (cc-status.js near line 1948), so the IIFE can
// locate the parent jsonl AUTHORITATIVELY instead of reverse-deriving it
// via the cwd-escape rule. The hook ITSELF distrusts the escape rule
// (cc-status.js:1502-1507 — 'CC's cwd→projects-dir escape function is not
// part of the public contract and has changed historically') and reads
// payload.transcript_path directly; the IIFE previously re-derived the
// path via the fragile rule while the hook held — but discarded — the
// authoritative value. The fix is a 2-line change: hook persists it, IIFE
// prefers it. Test pins both sides of the contract: (a) the IIFE prefers
// tj.transcript_path when present; (b) the fallback to the escape rule
// still runs for old state files. Behavioral coverage lives in the
// computeLiveDelta fixture harness in test-iife.mjs §26.
check(
  'IIFE.93 computeLiveDelta prefers tj.transcript_path (authoritative) over cwd-escape',
  /if\s*\(\s*typeof\s+tj\.transcript_path\s*===\s*"string"\s*&&\s*tj\.transcript_path\s*\)\s*\{\s*jsonlPath\s*=\s*tj\.transcript_path\s*\}\s*else\s*\{/.test(
    iife,
  ),
  'round-2 MEDIUM: jsonl path must be tj.transcript_path when present (hook-persisted, authoritative) with the cwd-escape rule as a fallback for old <sid>.json files',
);
// §G tick calls computeLiveDelta and adds the delta to the displayed total.
// The integration has 2 parts: (1) tokenLiveDeltaEnabled config gate,
// (2) total = sumTok(w) + dSum. The v0.2.5 live-delta tooltip lines
// (ttLiveDeltaTpl / ttLiveDeltaTruncated / ttTurnRunningTpl) were REMOVED
// to make the tooltip static (stop hover flicker — the 500ms tick changed
// tooltip content every cycle). The live delta itself is still computed
// and added to the SBI text count + session-total tooltip line below.
check(
  'IIFE.86 §G tick gated by cfg.tokenLiveDeltaEnabled (default true)',
  /cfg\.get\s*\(\s*"tokenLiveDeltaEnabled"\s*,\s*true\s*\)/.test(iife),
);
check(
  'IIFE.87 §G tick total = sumTok(w) + dSum (live delta added to window total)',
  /var\s+total\s*=\s*sumTok\s*\(\s*w\s*\)\s*\+\s*dSum/.test(iife),
);
check(
  'IIFE.88 §G tick NO LONGER pushes ttLiveDeltaTpl tooltip (v0.2.5 static-tooltip fix: line removed)',
  !/ttip\.push\s*\(\s*tr\s*\(\s*"ttLiveDeltaTpl"\s*\)/.test(iife),
  'v0.2.5 static-tooltip: the live-delta tooltip push must be gone (it caused hover flicker); the delta still flows into total/sumTok(tok.total)+dSum',
);
// Session-total tooltip also includes dSum so the user sees the live delta
// reflected in BOTH the per-window count and the session total.
check(
  'IIFE.89 §G session-total tooltip includes dSum (sumTok(tok.total)+dSum)',
  /fmtTok\s*\(\s*sumTok\s*\(\s*tok\.total\s*\)\s*\+\s*dSum\s*\)/.test(iife),
);

// --- 23. v0.2.5 problem 3b: default window changed from '1h' to 'all' ------
// Users were surprised by window "清零" — the rolling windows naturally
// age out old turns, which felt like data loss. The 'all' window is
// monotonic (per-session) and matches the "status bar shows my total usage"
// mental model. The default is now 'all' in BOTH the QuickPick (showTokQuickPick)
// and the §G tick. Lock the literal so a refactor that flips the default
// back to '1h' (or any other window) lights up the assertion.
check(
  'IIFE.90 default window is "all" in §G tick (cfg.get tokenStatsWindow,"all")',
  /cfg\.get\s*\(\s*"tokenStatsWindow"\s*,\s*"all"\s*\)/.test(iife),
);
{
  // QuickPick default also "all" — read patch.ts source (showTokQuickPick
  // is in the IIFE body but uses var curWin assignment; lock the literal).
  const patchSrc = fs.readFileSync(path.join(ROOT, 'patch.ts'), 'utf8');
  check(
    'IIFE.91 default window is "all" in showTokQuickPick (patch.ts source)',
    patchSrc.includes('var curWin=cfg.get("tokenStatsWindow","all")'),
  );
}

// --- 24. v0.2.5 problem 2 → static-tooltip: ttLiveDeltaTpl i18n key REMOVED --
// The live-delta tooltip line was localized via the I18N dict + tr() helper,
// but v0.2.5 static-tooltip removed the tooltip push (hover flicker fix).
// Lock the key is GONE from the dict so a stale push() or leftover key
// fails loudly. (The live delta itself still flows into total + session-
// total tooltip via sumTok(tok.total)+dSum — locked by IIFE.87/89 above.)
check('IIFE.92 ttLiveDeltaTpl key REMOVED from I18N dict (v0.2.5 static-tooltip)', !/"ttLiveDeltaTpl"\s*:/.test(iife));

// --- 25. v0.2.5 round-2 (MEDIUM): workflow gap tooltip + window labeling --
// Two MEDIUM findings from round-2 window-workflow review:
//   (1) The hook's own docstring (cc-status.js:1517-1535) admits pure
//       workflow phases can leave the token count visually stalled with no
//       user-visible caveat. The hook gives partial real-time visibility
//       via scanSubagentTranscripts (fires on every parent TOK_EVENT), but
//       a pure-workflow phase can keep the parent idle for an extended
//       period (no PostToolUse/Stop/UserPromptSubmit firing). Surfacing a
//       ttWorkflowGap tooltip line when tj.activeSubagents>0 closes the
//       "stalled count with no explanation" UX gap.
//   (2) qpStatsWindowDetail branded the WHOLE list "(rolling)" — including
//       'all', which is cumulative, not rolling. That inverted the very
//       clarification problem 3b was supposed to fix (users seeing "清零"
//       for rolling windows thought 'all' would clear too). Lock the new
//       rolling/cumulative distinction in both the detail label and the
//       §G tooltip ttWindowTpl.
check('IIFE.94 ttWorkflowGap key present in I18N dict', /"ttWorkflowGap"\s*:/.test(iife));
check(
  'IIFE.95 §G tick pushes ttWorkflowGap when tj.activeSubagents>0',
  /if\s*\(\s*tj\.activeSubagents\s*&&\s*Number\s*\(\s*tj\.activeSubagents\s*\)\s*>\s*0\s*\)\s*ttip\.push\s*\(\s*tr\s*\(\s*"ttWorkflowGap"\s*\)\s*\)/.test(
    iife,
  ),
  'round-2 MEDIUM: when subagents/workflow are in flight the tooltip must surface the settle-on-completion caveat — pre-fix the count visibly stalled with no explanation',
);

// v0.2.5 round-3 (MEDIUM) source locks: the §G tick still (a) passes winMs
// derived from the baked TOK_WIN_MS map into computeLiveDelta so the
// rolling-window filter is wired correctly. The v0.2.5 static-tooltip fix
// REMOVED the ttLiveDeltaTruncated tooltip push + dict key (hover flicker
// fix), but the truncated BOOLEAN is still computed by computeLiveDelta
// (locked by IIFE.83/105) — it is just no longer surfaced via tooltip.
// The behavioral correctness of the winMs filter is locked by IIFE.106-109
// below; this regex lock guards the IIFE-side wiring so a future edit that
// drops the wire fails loudly at the source level.
check(
  'IIFE.95a §G tick passes TOK_WIN_MS[tWin] as winMs to computeLiveDelta (round-3 MEDIUM: rolling-window filter wiring)',
  /var\s+__winMs\s*=\s*TOK_WIN_MS\s*\[\s*tWin\s*\]\s*;\s*liveInfo\s*=\s*computeLiveDelta\s*\(\s*tj\s*,\s*activeSid\s*,\s*__winMs\s*\)/.test(
    iife,
  ),
  'round-3 MEDIUM: the live-delta rolling-window filter requires the tick to pass the current window ms into computeLiveDelta; without this, all windows are treated as cumulative',
);
check(
  'IIFE.95b §G tick NO LONGER pushes ttLiveDeltaTruncated tooltip (v0.2.5 static-tooltip: push removed; boolean still computed)',
  !/ttip\.push\s*\(\s*tr\s*\(\s*"ttLiveDeltaTruncated"\s*\)/.test(iife),
  'v0.2.5 static-tooltip: the truncated-tooltip push must be gone (caused hover flicker); the underlying truncated boolean on computeLiveDelta result is unchanged (IIFE.83/105)',
);
check(
  'IIFE.95c ttLiveDeltaTruncated key REMOVED from I18N dict (v0.2.5 static-tooltip)',
  !/"ttLiveDeltaTruncated"\s*:/.test(iife),
);
// TOK_WIN_MS baked into IIFE (single source of truth: patch.ts const,
// pinned against the writer's TOK_WINDOWS by test-contract-sync.mjs).
check(
  'IIFE.95d TOK_WIN_MS map baked into IIFE preamble (round-3 MEDIUM: enables winMs lookup at tick)',
  /var\s+TOK_WIN_MS\s*=\s*\{[^}]*"[^"]+"\s*:/.test(iife) && iife.includes('TOK_WIN_MS[tWin]'),
);
{
  // qpStatsWindowDetail — lock the rolling/cumulative distinction so a
  // future edit that re-brands 'all' as rolling re-fails this check.
  // The new detail label explicitly contrasts "rolling" (5min..30d) with
  // "all cumulative" in the same string, separated by a '/'. The prior
  // label "(rolling): ... / all" branded the WHOLE list as rolling.
  const patchSrc = fs.readFileSync(path.join(ROOT, 'patch.ts'), 'utf8');
  check(
    'IIFE.96 qpStatsWindowDetail distinguishes rolling (5min..30d) from cumulative (all)',
    /rolling[\s\S]{0,200}all cumulative/.test(patchSrc) && !/Statistics window \(rolling\):/.test(patchSrc),
    'round-2 MEDIUM: the prior detail labeled the whole list "(rolling)" — including all (cumulative). The new label distinguishes them.',
  );
}

// --- 25b. v0.3.0 round-1 MEDIUM (tooltip IPC dedup): all 4 §G-tick branches
// use the SAME __ccsdTokSbiLastTip dedup gate (REPLACES the prior round-3
// __ccsdTokSbiLastTip=null reset pattern).
//
// History — round-3 cache-desync symmetry fix (v0.2.6): added
// `globalThis.__ccsdTokSbiLastTip=null` to all 3 non-success branches
// (ttNoDataTpl + ttUnavailableTpl + ttNoPanel) to fix a cache-desync bug:
// hold good tip X → ttNoPanel → return to SAME CC session → recompute
// identical X → `__ccsdTokSbiLastTip!==__tip` was false → tsbi.tooltip write
// skipped → tooltip stuck on "no panel". The null-reset dropped the cache so
// the next good tick re-wrote.
//
// v0.2.9 Q5 Fix 2 then added __ccsdTokSbiLastText dedup to tsbi.text in all
// 4 branches (text dedup), but the matching tsbi.tooltip dedup was only
// applied to the SUCCESS branch — the 3 non-success branches still assigned
// tsbi.tooltip UNCONDITIONALLY every 500ms tick even when the string was
// byte-identical, leaking ~2 redundant IPC writes/sec to the renderer. The
// ttNoPanel case was the most persistent: a user with VS Code open but no CC
// panel leaked ~2 tooltip IPC writes/sec indefinitely.
//
// v0.3.0 round-1 MEDIUM fix: wrap all 3 non-success branches' tsbi.tooltip
// assignment in the SAME dedup gate the success branch uses, and REMOVE the
// now-redundant __ccsdTokSbiLastTip=null resets. The dedup naturally re-fires
// on branch transitions because the tooltip strings differ across branches
// (success tip X !== ttNoPanel tip, etc.), so the cache-desync symmetry is
// preserved by STRING DIFFERENCE instead of by null-reset. See patch.ts
// "v0.3.0 round-1 MEDIUM" comments at each branch for the full per-branch
// rationale.
//
// These locks pin: (96a) exactly 4 gates total (one per branch), (96b) NO
// null resets remain (negative regression pin against re-introducing the old
// pattern alongside the gate), (96c-e) each non-success branch has its own
// gate (position-locked on the branch's unique signature string). Without
// 96b, a future editor could re-add the null-reset "for safety" beside the
// gate, signalling they misunderstood the branch-transition reasoning.
{
  const GATE_PAT =
    'if(globalThis.__ccsdTokSbiLastTip!==__tip){globalThis.__ccsdTokSbiLastTip=__tip;tsbi.tooltip=__tip;}';
  const gateOccurrences = iife.split(GATE_PAT).length - 1;
  check(
    'IIFE.96a §G tick has exactly 4 __ccsdTokSbiLastTip dedup gates (v0.3.0 round-1: success + 3 non-success branches)',
    gateOccurrences === 4,
    'expected 4 dedup gates (success + ttNoDataTpl + ttUnavailableTpl + ttNoPanel), found ' + gateOccurrences,
  );
  // Negative regression pin: the old __ccsdTokSbiLastTip=null reset pattern
  // must be COMPLETELY ABSENT. The dedup gate makes the null resets redundant
  // (branch transitions re-fire the gate naturally because the tooltip strings
  // differ across branches). A non-zero count here means someone re-introduced
  // the old pattern alongside the gate — both redundant and a signal that the
  // branch-transition reasoning was misunderstood.
  const RESET_PAT = 'globalThis.__ccsdTokSbiLastTip=null';
  const resetOccurrences = iife.split(RESET_PAT).length - 1;
  check(
    'IIFE.96b §G tick has NO __ccsdTokSbiLastTip=null resets (v0.3.0 round-1 replaced all with dedup gate)',
    resetOccurrences === 0,
    'expected 0 null-reset branches (all replaced by dedup gate), found ' + resetOccurrences,
  );
  // Position locks: each non-success branch must contain its own dedup gate.
  // Anchor on each branch's unique signature string and assert a gate occurs
  // AT OR AFTER it. The gates appear in source order (success → ttNoDataTpl →
  // ttUnavailableTpl → ttNoPanel), so the first gate after each signature is
  // that branch's gate. Without these locks, IIFE.96a could pass with 4 gates
  // all clustered in one branch.
  const noPanelIdx = iife.indexOf('tr("ttNoPanel")');
  const noPanelGateIdx = iife.indexOf(GATE_PAT, noPanelIdx);
  check(
    'IIFE.96c ttNoPanel branch contains dedup gate (v0.3.0 round-1: closes the most persistent IPC leak — no-panel state)',
    noPanelIdx >= 0 && noPanelGateIdx >= 0,
    'noPanelIdx=' + noPanelIdx + ' gateIdx=' + noPanelGateIdx,
  );
  const noDataIdx = iife.indexOf('tr("ttNoDataTpl")');
  const noDataGateIdx = iife.indexOf(GATE_PAT, noDataIdx);
  check(
    'IIFE.96d ttNoDataTpl branch contains dedup gate (v0.3.0 round-1: no-data state IPC dedup)',
    noDataIdx >= 0 && noDataGateIdx >= 0,
    'noDataIdx=' + noDataIdx + ' gateIdx=' + noDataGateIdx,
  );
  const unavailIdx = iife.indexOf('tr("ttUnavailableTpl")');
  const unavailGateIdx = iife.indexOf(GATE_PAT, unavailIdx);
  check(
    'IIFE.96e ttUnavailableTpl branch contains dedup gate (v0.3.0 round-1: read-threw state IPC dedup)',
    unavailIdx >= 0 && unavailGateIdx >= 0,
    'unavailIdx=' + unavailIdx + ' gateIdx=' + unavailGateIdx,
  );
}

// --- 26. v0.2.5 round-2 (MEDIUM): computeLiveDelta behavioral test harness --
// IIFE.80-89 only regex-match the SOURCE STRING of computeLiveDelta — they
// never execute the function. A logic bug (off-by-one in lastNl+1, wrong
// field routed to d.in vs d.cr, accumulation into the wrong side of
// hasCcObj) would pass every assertion. This block closes that hole: it
// extracts the function from the baked IIFE, runs it against a tempdir
// with fixture {sid}.jsonl + {sid}.offset sidecar, and asserts on the
// returned delta. The double-count-avoidance contract (delta = bytes in
// [hook.sidecar.offset..jsonl.size]) is the entire safety premise of the
// feature and is now verified by execution.
{
  // Extract `function computeLiveDelta(tj,sid){...}` from the baked IIFE.
  // The body uses only `fs`, `pth`, `os`, `Buffer`, and `JSON` — we provide
  // all of them via the vm context. `Number.isFinite` is on globalThis.
  const fnStart = iife.indexOf('function computeLiveDelta(');
  if (fnStart < 0) {
    check('IIFE.97 computeLiveDelta extractable for behavioral test', false);
  } else {
    // Brace-balanced extraction of the function body.
    let depth = 0;
    let i = iife.indexOf('{', fnStart);
    const start = i + 1;
    depth = 1;
    i += 1;
    while (i < iife.length && depth > 0) {
      const c = iife[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      i += 1;
    }
    const fnSrc = iife.slice(fnStart, i);
    check('IIFE.97 computeLiveDelta extractable for behavioral test', fnSrc.length > 100);

    // The function source closes over `fs`, `pth`, `os`, `Buffer`, `Number`,
    // `JSON`, AND `DIR` (the STATE_DIR constant baked into the IIFE outer
    // scope). Re-compile with all of them injected so the standalone
    // extraction can run. This is the SAME shape the IIFE uses at runtime —
    // DIR is captured from the IIFE's outer scope. Since v0.4.0 round-2
    // (ARCH-6 HIGH) the IIFE bakes DIR as an absolute path string literal
    // `var DIR=${JSON.stringify(STATE_DIR)};` (e.g.
    // `var DIR="/Users/me/.claude/cc-tab-status";`) computed once at patch
    // time from patch.ts:219 const + os.homedir(). Pre-v0.4 the IIFE
    // recomputed the path at runtime via `pth.join(os.homedir(),".claude",
    // "cc-tab-status")`; both forms resolve to the same absolute path under
    // a real user HOME, but the literal form lets a STATE_DIR rename flow
    // into the IIFE bytes automatically (see test-contract-sync.mjs
    // §STATE_DIR). tmpdir used as a fake HOME so the state path inside the
    // harness resolves to our fixture tree (we inject DIR directly via new
    // Function so the baked literal is not consulted here).
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsd-delta-'));
    const shimOs = { ...os, homedir: () => tmpHome };
    const stateDir = path.join(tmpHome, '.claude', 'cc-tab-status');
    fs.mkdirSync(stateDir, { recursive: true });
    let fn = null;
    try {
      // eslint-disable-next-line no-new-func
      fn = new Function('fs', 'pth', 'os', 'Buffer', 'Number', 'JSON', 'DIR', 'return ' + fnSrc)(
        fs,
        path,
        shimOs,
        Buffer,
        Number,
        JSON,
        stateDir,
      );
      check('IIFE.98 computeLiveDelta compiles via new Function (behavioral harness, DIR injected)', true);
    } catch (e) {
      check('IIFE.98 computeLiveDelta compiles via new Function (behavioral harness, DIR injected)', false, e.message);
    }

    if (fn) {
      // Fixture tree under tmpHome (already created stateDir above):
      //   $tmpHome/.claude/projects/<escaped-cwd>/<sid>.jsonl   (CC transcript)
      //   $tmpHome/.claude/cc-tab-status/<sid>.offset           (hook sidecar)
      // Already created: tmpHome + stateDir. Build the projects dir + jsonl
      // fixture per-case below.
      const sid = 'test-sid-1234';
      const cwd = '/fake/proj';
      const escaped = cwd.replace(/[^a-zA-Z0-9._-]/g, '-');
      const projDir = path.join(tmpHome, '.claude', 'projects', escaped);
      fs.mkdirSync(projDir, { recursive: true });
      const jsonlPath = path.join(projDir, sid + '.jsonl');

      if (fn) {
        // Helper: build an assistant jsonl row mirroring CC's format.
        // v0.2.5 round-3 (MEDIUM): include `timestamp` so the row passes the
        // IIFE's new finite-ts guard (mirrors hook cc-status.js:1411-1412).
        // Default to 'now' (ISO 8601) so rows are inside any rolling window
        // the test exercises. Tests that need OUT-of-window rows override ts.
        const row = (opts) => {
          const o = {
            type: 'assistant',
            timestamp: opts.ts || new Date().toISOString(),
            message: {
              model: opts.model || 'claude-sonnet-4-5-20250929',
              usage: opts.usage || {},
            },
          };
          return JSON.stringify(o);
        };

        // --- Case 1: skip invariants return null on bad inputs.
        check('IIFE.99a computeLiveDelta(null,sid) → null (skip !tj)', fn(null, sid) === null);
        check(
          'IIFE.99b computeLiveDelta(tj with no tokens,sid) → null (skip !tj.tokens)',
          fn({ cwd, state: 'running' }, sid) === null,
        );
        check(
          'IIFE.99c computeLiveDelta(tj not running) → null (skip state!==running)',
          fn({ cwd, tokens: { total: {} }, state: 'done' }, sid) === null,
        );
        check(
          'IIFE.99d computeLiveDelta(tj no cwd) → null (skip !tj.cwd)',
          fn({ tokens: { total: {} }, state: 'running' }, sid) === null,
        );

        // --- Case 2: skip when no sidecar (offset<=0).
        // Write jsonl but NO sidecar → offset stays 0 → null.
        const row1 = row({ usage: { input_tokens: 100, output_tokens: 50 } }) + '\n';
        fs.writeFileSync(jsonlPath, row1);
        // Ensure no sidecar
        try {
          fs.unlinkSync(path.join(stateDir, sid + '.offset'));
        } catch {
          /* fine */
        }
        check(
          'IIFE.99e computeLiveDelta no sidecar (offset<=0) → null',
          fn({ tokens: { total: {} }, cwd, state: 'running' }, sid) === null,
        );

        // --- Case 3: full happy path. Hook previously advanced sidecar.offset
        //     to the end of row1; CC then streamed rows 2 and 3. IIFE must
        //     read [offset..size] = rows 2+3 and sum their tokens. The
        //     offset>0 invariant (round-1 fix) is what prevents the IIFE
        //     from racing the hook's first-ever fire — pre-hook, offset is 0
        //     and the IIFE correctly bails (Case 2 above).
        const rows = [
          row({ usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200 } }),
          row({ usage: { input_tokens: 30, output_tokens: 20 } }),
          row({
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_creation: { ephemeral_5m_input_tokens: 80, ephemeral_1h_input_tokens: 40 },
            },
          }),
        ];
        // Write row1 first; advance sidecar.offset to its byte length (hook
        // has absorbed it). Then append rows 2+3 (IIFE will see these).
        fs.writeFileSync(jsonlPath, rows[0] + '\n');
        const offset = fs.statSync(jsonlPath).size; // hook cursor after row1
        fs.writeFileSync(jsonlPath, rows.map((r) => r + '\n').join(''));
        // Sidecar: offset > 0 → IIFE reads [offset..size] = rows 2+3.
        fs.writeFileSync(path.join(stateDir, sid + '.offset'), JSON.stringify({ offset }));

        const r = fn({ tokens: { total: {} }, cwd, state: 'running' }, sid);
        check(
          'IIFE.100 computeLiveDelta happy path returns non-null delta',
          r !== null && r.delta !== null,
          'got ' + JSON.stringify(r),
        );
        if (r && r.delta) {
          check(
            'IIFE.101a delta.in sums input_tokens for UNREAD rows (30+10=40)',
            r.delta.in === 40,
            'got ' + r.delta.in,
          );
          check(
            'IIFE.101b delta.out sums output_tokens for UNREAD rows (20+5=25)',
            r.delta.out === 25,
            'got ' + r.delta.out,
          );
          check(
            'IIFE.101c delta.cr=0 for UNREAD rows (no cache_read in rows 2+3)',
            r.delta.cr === 0,
            'got ' + r.delta.cr,
          );
          check(
            'IIFE.101d delta.cc5 sums ephemeral_5m_input_tokens (80, row3 only)',
            r.delta.cc5 === 80,
            'got ' + r.delta.cc5,
          );
          check(
            'IIFE.101e delta.cc1 sums ephemeral_1h_input_tokens (40, row3 only)',
            r.delta.cc1 === 40,
            'got ' + r.delta.cc1,
          );
          // cache_creation OBJECT form zeroes cci (mirror of hook).
          check(
            'IIFE.101f delta.cci=0 when cache_creation object form present (mirror hook)',
            r.delta.cci === 0,
            'got ' + r.delta.cci,
          );
          check(
            'IIFE.101g lastModel captured from last row',
            r.lastModel === 'claude-sonnet-4-5-20250929',
            'got ' + r.lastModel,
          );
        }

        // --- Case 4: double-count avoidance. Advance sidecar.offset to
        //     the END of all rows → next read returns no new bytes →
        //     stat.size<=offset → null (NOT zero-count, just no new work).
        const sz = fs.statSync(jsonlPath).size;
        fs.writeFileSync(path.join(stateDir, sid + '.offset'), JSON.stringify({ offset: sz }));
        const r2 = fn({ tokens: { total: {} }, cwd, state: 'running' }, sid);
        check(
          'IIFE.102 computeLiveDelta double-count avoidance (sidecar.offset==size → null)',
          r2 === null,
          'When the hook advances offset to size, the IIFE sees no new bytes and returns null — no double-count at any hook cadence. got ' +
            JSON.stringify(r2),
        );

        // --- Case 5: partial-line guard. Sidecar.offset > 0 at start of
        //     a full row0; append a half-row (no trailing newline) AFTER
        //     the full row → the trailing partial bytes are excluded; the
        //     leading full row IS counted.
        fs.writeFileSync(jsonlPath, rows[0] + '\n');
        const offset5 = fs.statSync(jsonlPath).size;
        // Append a partial line with NO trailing newline.
        fs.writeFileSync(jsonlPath, rows[0] + '\n' + '{"type":"assistant","message":');
        fs.writeFileSync(
          path.join(stateDir, sid + '.offset'),
          JSON.stringify({ offset: 0 }), // start at 0 → but invariant requires >0
        );
        // Override: use a tiny positive offset so the invariant passes,
        // but the buffer still contains a full row followed by a partial.
        // Easiest: put one byte at the front (any byte), then full row,
        // then partial — but JSON.parse would skip the leading non-JSON.
        // Simpler: just write a full row, advance offset to 1 (skip the
        // leading '{' so JSON.parse fails for the first partial), then a
        // partial tail. To stay realistic, set offset to the start of a
        // full row that ends with \n followed by a partial line.
        fs.writeFileSync(jsonlPath, 'X' + rows[0] + '\n' + '{"type":"assistant","message":');
        fs.writeFileSync(path.join(stateDir, sid + '.offset'), JSON.stringify({ offset: 1 }));
        const r3 = fn({ tokens: { total: {} }, cwd, state: 'running' }, sid);
        // Read window is [1..size]. Last \n is the one after row0.
        // text contains 'X' + row0 (the X prefix fails JSON.parse but
        // row0 itself parses after the split). Partial trailing bytes
        // are excluded.
        check(
          'IIFE.103 computeLiveDelta partial-tail guard (excludes half-flushed bytes)',
          r3 !== null && r3.delta !== null && r3.delta.in === 100,
          'partial trailing bytes must be excluded; got ' + JSON.stringify(r3),
        );

        // --- Case 6: tj.transcript_path AUTHORITATIVE (round-2 fix).
        //     Provide a transcript_path pointing at a different file —
        //     the function must use it, NOT the cwd-escaped path.
        const altJsonl = path.join(tmpHome, 'alt-transcript.jsonl');
        fs.writeFileSync(
          altJsonl,
          // Two rows: row0 advances offset, row1 is the delta.
          row({ usage: { input_tokens: 1 } }) + '\n' + row({ usage: { input_tokens: 999, output_tokens: 1 } }) + '\n',
        );
        const altOffset = (row({ usage: { input_tokens: 1 } }) + '\n').length;
        fs.writeFileSync(path.join(stateDir, sid + '.offset'), JSON.stringify({ offset: altOffset }));
        const r4 = fn({ tokens: { total: {} }, cwd, state: 'running', transcript_path: altJsonl }, sid);
        check(
          'IIFE.104 computeLiveDelta prefers tj.transcript_path (round-2 MEDIUM)',
          r4 !== null && r4.delta !== null && r4.delta.in === 999,
          'transcript_path must override the cwd-escape fallback; got ' + JSON.stringify(r4),
        );

        // --- Case 7: 512KB hard cap. Build a >512KB delta window by
        //     advancing offset a tiny bit and writing a huge jsonl.
        //     v0.2.5 round-3 (MEDIUM): the cap no longer returns null.
        //     Instead it reads the 512KB tail with truncated=true so the
        //     partial-delta signal is preserved on the computeLiveDelta
        //     result (v0.2.5 static-tooltip removed the tooltip line that
        //     previously surfaced this, but the boolean itself is unchanged
        //     so the cap+tail-read behavior is still locked here).
        const bigRow = row({ usage: { input_tokens: 1 } }) + '\n';
        const bigSize = 600000;
        // Write bigRow repeatedly to exceed 512KB AFTER a small offset.
        const repeats = Math.ceil(bigSize / bigRow.length) + 5;
        fs.writeFileSync(jsonlPath, bigRow.repeat(repeats));
        fs.writeFileSync(path.join(stateDir, sid + '.offset'), JSON.stringify({ offset: 1 }));
        const r5 = fn({ tokens: { total: {} }, cwd, state: 'running' }, sid);
        check(
          'IIFE.105 computeLiveDelta 512KB hard cap (>512KB delta → partial delta + truncated=true)',
          r5 !== null && r5.delta !== null && r5.truncated === true,
          'round-3 MEDIUM: toRead>524288 must read the 512KB tail with truncated=true (not silent null); got ' +
            JSON.stringify(r5),
        );

        // --- Case 8 (v0.2.5 round-3 MEDIUM): rows without a finite timestamp
        //     are SKIPPED, mirroring hook cc-status.js:1411-1412. The hook
        //     bails on Number.isFinite(Date.parse(obj.timestamp))===false;
        //     if the IIFE counted those rows the next hook fire would
        //     'settlement-shrink' the displayed total. Build two rows: one
        //     with a valid timestamp (counted), one without (skipped).
        fs.writeFileSync(jsonlPath, '');
        const tsRow = row({ usage: { input_tokens: 111 } });
        // Manually build a row with NO timestamp (bypasses the row() helper
        // which now defaults to new Date().toISOString()).
        const noTsRow = JSON.stringify({
          type: 'assistant',
          message: { model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 999 } },
        });
        fs.writeFileSync(jsonlPath, tsRow + '\n' + noTsRow + '\n');
        const offsetTs = tsRow.length + 1;
        fs.writeFileSync(path.join(stateDir, sid + '.offset'), JSON.stringify({ offset: offsetTs }));
        const r6 = fn({ tokens: { total: {} }, cwd, state: 'running' }, sid);
        check(
          'IIFE.106 computeLiveDelta skips rows without finite timestamp (round-3 MEDIUM: settlement-shrink guard)',
          r6 !== null && r6.delta !== null && r6.delta.in === 0,
          'the no-timestamp row (input_tokens=999) must be SKIPPED, so delta.in=0; got ' + JSON.stringify(r6),
        );

        // --- Case 9 (v0.2.5 round-3 MEDIUM): rolling-window filter. Rows
        //     OUTSIDE the winMs window are skipped, mirroring hook
        //     deriveTokensField (cc-status.js:754-756). Build two rows:
        //     row A 10min ago, row B now. With winMs=5min (5*60*1000), row A
        //     is OUT-of-window and skipped; row B is IN-window and counted.
        //     Cumulative (winMs=Infinity) counts both.
        fs.writeFileSync(jsonlPath, '');
        const oldRow = row({
          ts: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          usage: { input_tokens: 222 },
        });
        const newRow = row({ usage: { input_tokens: 333 } });
        fs.writeFileSync(jsonlPath, oldRow + '\n' + newRow + '\n');
        fs.writeFileSync(path.join(stateDir, sid + '.offset'), JSON.stringify({ offset: 0 }));
        // offset=0 fails the offset>0 invariant; use a tiny positive offset
        // by prefixing one byte (the leading byte fails JSON.parse and is
        // skipped, but the rest of the buffer parses).
        fs.writeFileSync(jsonlPath, 'X' + oldRow + '\n' + newRow + '\n');
        fs.writeFileSync(path.join(stateDir, sid + '.offset'), JSON.stringify({ offset: 1 }));
        // 5min window: only newRow (333) is in-window.
        const r7 = fn({ tokens: { total: {} }, cwd, state: 'running' }, sid, 5 * 60 * 1000);
        check(
          'IIFE.107 computeLiveDelta winMs filter excludes out-of-window rows (round-3 MEDIUM)',
          r7 !== null && r7.delta !== null && r7.delta.in === 333,
          '5min window: the 10min-old row (222) must be EXCLUDED; got ' + JSON.stringify(r7),
        );
        // "all" window (Infinity): both rows counted (222 + 333 = 555).
        const r8 = fn({ tokens: { total: {} }, cwd, state: 'running' }, sid, Infinity);
        check(
          'IIFE.108 computeLiveDelta winMs=Infinity includes ALL rows (cumulative window, round-3 MEDIUM)',
          r8 !== null && r8.delta !== null && r8.delta.in === 555,
          'Infinity (all) window: both rows must be counted (222+333=555); got ' + JSON.stringify(r8),
        );
        // No third arg → defaults to Infinity (cumulative, backward-compat
        // with v0.2.5 round-2 call sites that don't pass winMs).
        const r9 = fn({ tokens: { total: {} }, cwd, state: 'running' }, sid);
        check(
          'IIFE.109 computeLiveDelta winMs omitted → defaults to Infinity (round-3 MEDIUM: backward-compat)',
          r9 !== null && r9.delta !== null && r9.delta.in === 555,
          'omitted winMs must default to Infinity (cumulative); got ' + JSON.stringify(r9),
        );
      }

      // Cleanup tempdir.
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        /* fine */
      }
    }
  }
}

// --- summary ---------------------------------------------------------------

// v0.2.6 blue-via-content: resources/claude-logo-pending.svg MUST exist on
// disk (installRuntimeFiles copies OUR_SVGS to the runtime dir; the IIFE
// references the file by name from the per-panel pend branch). Asserts the
// SVG file exists, has the expected title, and the badge fill is the new
// blue (#58A6FF) — a regression that dropped the file or kept an old color
// would silently render nothing (VS Code falls back to no icon) or render
// the wrong color.
{
  const pendingSvgPath = path.join(ROOT, 'resources', 'claude-logo-pending.svg');
  let pendingSvg = '';
  try {
    pendingSvg = fs.readFileSync(pendingSvgPath, 'utf8');
  } catch (e) {
    check('IIFE.110 resources/claude-logo-pending.svg exists on disk', false, String(e));
  }
  if (pendingSvg) {
    check('IIFE.110 resources/claude-logo-pending.svg exists on disk', true);
    check('IIFE.111 pending.svg title is "Claude (Pending)"', /<title>Claude \(Pending\)<\/title>/.test(pendingSvg));
    check(
      'IIFE.112 pending.svg badge circle fill is #58A6FF (blue)',
      /<circle\s+cx="18"\s+cy="6"\s+r="6"\s+fill="#58A6FF"\s*\/>/.test(pendingSvg),
    );
    // Geometry MUST match done.svg exactly (same Claude logo path, same mask).
    // A hand-drawn pending.svg that diverged would visually clash with the
    // other 4 dots. Asserts path d attr + mask shape match done.svg.
    const doneSvg = fs.readFileSync(path.join(ROOT, 'resources', 'claude-logo-done.svg'), 'utf8');
    const extractPath = (s) => {
      const m = s.match(/d="([^"]+)"/);
      return m ? m[1] : null;
    };
    const extractMask = (s) => {
      const m = s.match(/<mask id="badge-mask">(\s*<rect[^/]*\/>\s*<circle[^/]*\/>\s*)<\/mask>/);
      return m ? m[1].replace(/\s+/g, ' ') : null;
    };
    const donePath = extractPath(doneSvg);
    const pendPath = extractPath(pendingSvg);
    const doneMask = extractMask(doneSvg);
    const pendMask = extractMask(pendingSvg);
    check(
      'IIFE.113 pending.svg Claude logo path d= matches done.svg (geometry parity)',
      donePath !== null && donePath === pendPath,
      donePath === pendPath ? '' : 'done path and pending path differ',
    );
    check(
      'IIFE.114 pending.svg mask geometry matches done.svg (cx=18 cy=6 r=7.5)',
      doneMask !== null && doneMask === pendMask,
      doneMask === pendMask ? '' : 'mask geometry differs',
    );
  }
}

// v0.2.6 blue-via-content: OUR_SVGS (patch.ts) MUST include the new svg so
// installRuntimeFiles copies it to ~/.claude/cc-status-dot/ and the cleanup
// sweep preserves it. A regression that omitted it from OUR_SVGS would
// silently ship without the pending dot (the IIFE references the file by
// name but installRuntimeFiles never copies it → file not found → no icon).
//
// v0.5.0: extended to 10 entries (5 base + 5 -fav variants). The -fav
// variants carry a gold underline at the viewBox bottom (fill #F5A623);
// installRuntimeFiles auto-copies them via the OUR_SVGS loop, and the
// stale-sweep auto-preserves them via the OUR_SVGS.includes() guard. A
// regression that drops any -fav from OUR_SVGS would silently make the
// favorited tab fall back to the base variant (no gold underline) instead
// of crashing — but the user-facing feature would be invisibly broken,
// hence this lock.
{
  const patchSrc = fs.readFileSync(path.join(ROOT, 'patch.ts'), 'utf8');
  const m = patchSrc.match(/const\s+OUR_SVGS\s*=\s*\[([^\]]+)\]/);
  check('IIFE.115 patch.ts defines OUR_SVGS literal', !!m);
  if (m) {
    check(
      'IIFE.116 OUR_SVGS includes claude-logo-pending.svg (v0.2.6)',
      m[1].includes('"claude-logo-pending.svg"'),
      'OUR_SVGS body: ' + m[1],
    );
    // v0.5.39+: length is 15 (5 base + 5 -fav + 5 -arch variants). The -arch
    // set MUST be in the manifest or installRuntimeFiles never copies them,
    // stale-sweep deletes any prior copy, and favOf()'s -arch.svg path 404s →
    // archived tabs render a broken icon (review high finding).
    const count = (m[1].match(/"claude-logo-/g) || []).length;
    check('IIFE.117 OUR_SVGS contains 15 entries (5 base + 5 -fav + 5 -arch)', count === 15, 'count=' + count);
    // v0.5.0: every base variant has a -fav twin.
    const baseStates = ['idle', 'running', 'done', 'error', 'pending'];
    for (const st of baseStates) {
      check(
        `IIFE.117a OUR_SVGS includes claude-logo-${st}-fav.svg (v0.5.0)`,
        m[1].includes(`"claude-logo-${st}-fav.svg"`),
        'OUR_SVGS body: ' + m[1],
      );
    }
    // v0.5.39: every base variant has a -arch twin (archived-session grey icon).
    for (const st of baseStates) {
      check(
        `IIFE.117a2 OUR_SVGS includes claude-logo-${st}-arch.svg (v0.5.39 archive)`,
        m[1].includes(`"claude-logo-${st}-arch.svg"`),
        'OUR_SVGS body: ' + m[1],
      );
    }
    // v0.5.0: IIFE defines FAVF + readFavSet + favOf (fav-detection helpers).
    check('IIFE.117f IIFE body defines readFavSet helper (v0.5.0 fav detection)', /function readFavSet\(/.test(iife));
    check(
      'IIFE.117f2 IIFE body defines __ccsdFavCache (mtime+size cache on favorites.json)',
      /globalThis\.__ccsdFavCache/.test(iife),
    );
    check(
      'IIFE.117g IIFE body defines favOf helper with leaf-swap to -fav.svg',
      /function favOf\([^)]*\)[\s\S]*?\.replace\([^)]*?\.svg[^)]*?,\s*["']-fav\.svg["']\)/.test(iife),
    );
    check(
      'IIFE.117h IIFE body references favorites.json via FAVF=pth.join(DIR,...)',
      /FAVF\s*=\s*pth\.join\(\s*DIR\s*,\s*["']favorites\.json["']\s*\)/.test(iife),
    );
    // v0.5.0: the 3 iconPath apply sites (pending early-return, interrupted
    // on-frame, final apply) MUST be wrapped in favOf(svg,sid) so a favorited
    // session renders the -fav variant. A regression that dropped any wrap
    // would leave that one state un-gold-underlined while the others work.
    check(
      'IIFE.117i pending early-return iconPath wrapped in favOf (v0.5.0)',
      /ccuri\(\s*favOf\(\s*pth\.join\(\s*RES\s*,\s*["']claude-logo-pending\.svg["']\s*\)\s*,\s*sid\s*\)\s*\)/.test(
        iife,
      ),
    );
    check(
      'IIFE.117j interrupted on-frame iconPath wrapped in favOf (v0.5.0)',
      /\(\s*flashSeq\s*%\s*2\s*===\s*0\s*\)\s*\?\s*favOf\(\s*pth\.join\(\s*RES\s*,\s*["']claude-logo-error\.svg["']\s*\)\s*,\s*sid\s*\)\s*:\s*CC_DEFAULT/.test(
        iife,
      ),
    );
    check(
      'IIFE.117k final iconPath apply wrapped in favOf(svg,sid) (v0.5.0)',
      /ccuri\(\s*favOf\(\s*svg\s*,\s*sid\s*\)\s*\)/.test(iife),
    );
    // v0.5.40 archive detection: archive.json is an INDEPENDENT file from
    // favorites.json. Companion writes archive.json separately; the IIFE reads
    // it via ARCF + readArchivedSet (mtime+size cache via __ccsdArchCache) and
    // returns ALL sids in archive.json (the file only contains archived
    // sessions, so no archived===true filter is needed). Favorites (★) and
    // archive (◆) are MUTUALLY EXCLUSIVE at the tab-prefix layer: a session is
    // either ★, ◆, or bare — never both. readFavSet returns every favorites.json
    // sid (no archived filter), and the prefix ternary composes them exclusively
    // (__isFav?★:__isArch?◆:bare).
    check(
      'IIFE.117l IIFE body defines readArchivedSet helper (v0.5.X archive detection)',
      /function readArchivedSet\(/.test(iife),
    );
    check(
      'IIFE.117l2 IIFE body defines __ccsdArchCache (mtime+size cache on archive.json, parallel to __ccsdFavCache)',
      /globalThis\.__ccsdArchCache/.test(iife),
    );
    check(
      'IIFE.117l3 IIFE body defines ARCF=pth.join(DIR,"archive.json") (independent from FAVF/favorites.json)',
      /ARCF\s*=\s*pth\.join\(\s*DIR\s*,\s*["']archive\.json["']\s*\)/.test(iife),
      'archive.json is a separate file from favorites.json (independent files, independent caches) — the prefixes are composed mutually-exclusively at the tab layer',
    );
    check(
      'IIFE.117m readFavSet does NOT filter on archived (favorites and archive are independent) — restored to v0.5.0 behavior returning all favorites.json sids',
      !/typeof x\.sid==="string"&&x\.archived!==true/.test(iife),
      'readFavSet must return every favorited sid regardless of archived state; the archived!==true filter was a v0.5.X mistake that coupled favorites to archive',
    );
    check(
      'IIFE.117n readArchivedSet reads ARCF (archive.json), not FAVF (favorites.json)',
      /statSync\(ARCF\)/.test(iife) && /readFileSync\(ARCF/.test(iife),
      'readArchivedSet must read the independent archive.json (ARCF); archive.json contains only archived sessions so all sids are returned without any archived===true filter',
    );
    check(
      'IIFE.117o favOf now handles BOTH favorited (→-fav.svg gold underline) AND archived (→-arch.svg grey underline, MUTEX)',
      (() => {
        const m = iife.match(/function favOf\([\s\S]*?\}catch\(_\)\{\}return svgPath;\}/);
        return (
          !!m &&
          /aset&&aset\[sid\]\)return pth\.join\(RES,leaf\.replace.*-arch\.svg/.test(m[0]) &&
          /fset&&fset\[sid\]\)return pth\.join\(RES,leaf\.replace.*-fav\.svg/.test(m[0])
        );
      })(),
      'favOf manages BOTH favorited (→-fav.svg gold underline) AND archived (→-arch.svg grey underline) under the mutex; favorited is checked first so a both-files state reconciles to the gold icon, matching the ★ tab-title prefix and the gold status-bar highlight',
    );
  }
}

// v0.5.0: 5 -fav SVG files MUST exist on disk in resources/. Each is a
// byte-copy of its base variant + a single <rect> gold underline (fill
// #F5A623) at viewBox bottom (y≈22). Mask/path/circle geometry MUST match
// the base exactly (a hand-drawn -fav that diverged would visually clash
// with the base 5 across state transitions — same parity rule as
// IIFE.113/114 between pending.svg and done.svg).
{
  const baseStates = ['idle', 'running', 'done', 'error', 'pending'];
  const extractPath = (s) => {
    const m = s.match(/d="([^"]+)"/);
    return m ? m[1] : null;
  };
  const extractMask = (s) => {
    const m = s.match(/<mask id="badge-mask">(\s*<rect[^/]*\/>\s*<circle[^/]*\/>\s*)<\/mask>/);
    return m ? m[1].replace(/\s+/g, ' ') : null;
  };
  for (const st of baseStates) {
    const favPath = path.join(ROOT, 'resources', `claude-logo-${st}-fav.svg`);
    let favSvg = '';
    try {
      favSvg = fs.readFileSync(favPath, 'utf8');
    } catch (e) {
      check(`IIFE.117c resources/claude-logo-${st}-fav.svg exists on disk (v0.5.0)`, false, String(e));
      continue;
    }
    check(`IIFE.117c resources/claude-logo-${st}-fav.svg exists on disk (v0.5.0)`, true);
    // Gold underline rect: must be present, fill #F5A623, thin (height ≤ 1.0).
    const rectMatch = favSvg.match(
      /<rect\s+x="4"\s+y="22"\s+width="16"\s+height="([0-9.]+)"\s+rx="0\.3"\s+fill="#F5A623"\s*\/>/,
    );
    check(
      `IIFE.117d ${st}-fav.svg contains gold underline rect (fill="#F5A623", height<=1.0)`,
      !!rectMatch && parseFloat(rectMatch[1]) <= 1.0,
      'rect: ' + (rectMatch ? rectMatch[0] : '<missing>'),
    );
    // Geometry parity with base: path d= + mask MUST match byte-for-byte.
    const basePath = path.join(ROOT, 'resources', `claude-logo-${st}.svg`);
    let baseSvg = '';
    try {
      baseSvg = fs.readFileSync(basePath, 'utf8');
    } catch (e) {
      check(`IIFE.117e ${st}-fav.svg base file readable for parity check`, false, String(e));
      continue;
    }
    check(
      `IIFE.117e ${st}-fav.svg path d= + mask byte-identical to base ${st}.svg (geometry parity)`,
      extractPath(favSvg) !== null &&
        extractPath(favSvg) === extractPath(baseSvg) &&
        extractMask(favSvg) !== null &&
        extractMask(favSvg) === extractMask(baseSvg),
    );
  }
}

// v0.2.7 Q1 (tokens persistence): readTok three-tier fallback — extract the
// function from the baked IIFE and behaviorally test that <sid>.tokens.json
// is preferred over <sid>.json, and that <sid>.json is used when the snapshot
// is absent. Mirrors the IIFE.97-109 computeLiveDelta behavioral extraction
// harness (new Function with fs/pth/os/Buffer/Number/JSON/DIR injected).
{
  const fnStart = iife.indexOf('function readTok(');
  if (fnStart < 0) {
    check('IIFE.118 readTok extractable for behavioral test (v0.2.7 Q1)', false);
  } else {
    // Brace-balanced extraction of the function body.
    let depth = 0;
    let i = iife.indexOf('{', fnStart);
    depth = 1;
    i += 1;
    while (i < iife.length && depth > 0) {
      const c = iife[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      i += 1;
    }
    const fnSrc = iife.slice(fnStart, i);
    check('IIFE.118 readTok extractable for behavioral test (v0.2.7 Q1)', fnSrc.length > 80);

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsd-readtok-'));
    const shimOs = { ...os, homedir: () => tmpHome };
    const stateDir = path.join(tmpHome, '.claude', 'cc-tab-status');
    fs.mkdirSync(stateDir, { recursive: true });
    let fn = null;
    try {
      // eslint-disable-next-line no-new-func
      fn = new Function('fs', 'pth', 'os', 'JSON', 'globalThis', 'DIR', 'return ' + fnSrc)(
        fs,
        path,
        shimOs,
        JSON,
        globalThis,
        stateDir,
      );
      check('IIFE.119 readTok compiles via new Function (v0.2.7 Q1 harness)', true);
    } catch (e) {
      check('IIFE.119 readTok compiles via new Function (v0.2.7 Q1 harness)', false, e.message);
    }

    if (fn) {
      // IIFE.120: when only <sid>.tokens.json exists (post-SessionEnd state),
      // readTok returns its tokens + envelope. This is the load-bearing
      // assertion for the Q1 0-window fix.
      const SID_A = 'q1-snap-only';
      const snapA = {
        v: 1,
        sid: SID_A,
        since: 1700000000000,
        cwd: '/proj-A',
        transcript_path: '/path/A.jsonl',
        tokens: { total: { in: 777, out: 888, cr: 0, cc5: 0, cc1: 0, cci: 0 }, windows: {} },
        written_at: 1700000001000,
      };
      fs.writeFileSync(path.join(stateDir, SID_A + '.tokens.json'), JSON.stringify(snapA));
      globalThis.__ccsdActiveSid = SID_A;
      try {
        const got = fn();
        const ok = got && got.tokens && got.tokens.total && got.tokens.total.in === 777 && got.sid === SID_A;
        check('IIFE.120 readTok prefers <sid>.tokens.json when only snapshot exists (Q1 0-window fix)', ok);
      } catch (e) {
        check(
          'IIFE.120 readTok prefers <sid>.tokens.json when only snapshot exists (Q1 0-window fix)',
          false,
          e.message,
        );
      }

      // IIFE.121: when BOTH <sid>.tokens.json AND <sid>.json exist, the
      // snapshot is still preferred (it survived SessionEnd; the in-flight
      // .json may be stale from SessionStart's no-tokens write). Wait —
      // actually the design is: snapshot is freshest cumulative, .json is
      // for active sessions where the in-flight fire just updated tokens.
      // The current implementation tries snapshot FIRST and returns if it has
      // tokens — so when both exist, snapshot wins. Pin that.
      const SID_B = 'q1-both-exist';
      const snapB = {
        v: 1,
        sid: SID_B,
        tokens: { total: { in: 111, out: 0, cr: 0, cc5: 0, cc1: 0, cci: 0 }, windows: {} },
      };
      const jsonB = { state: 'running', tokens: { total: { in: 222, out: 0, cr: 0, cc5: 0, cc1: 0, cci: 0 } } };
      fs.writeFileSync(path.join(stateDir, SID_B + '.tokens.json'), JSON.stringify(snapB));
      fs.writeFileSync(path.join(stateDir, SID_B + '.json'), JSON.stringify(jsonB));
      globalThis.__ccsdActiveSid = SID_B;
      try {
        const got = fn();
        // Snapshot wins (in=111 from .tokens.json, not in=222 from .json).
        const ok = got && got.tokens && got.tokens.total && got.tokens.total.in === 111;
        check('IIFE.121 readTok prefers <sid>.tokens.json when both files exist (snapshot wins)', ok);
      } catch (e) {
        check('IIFE.121 readTok prefers <sid>.tokens.json when both files exist (snapshot wins)', false, e.message);
      }

      // IIFE.122: when only <sid>.json exists (pre-v0.2.7 install OR active
      // session where snapshot write hasn't fired yet), readTok falls back
      // to .json. Pin the legacy-compat fallback.
      const SID_C = 'q1-json-only';
      const jsonC = { state: 'running', tokens: { total: { in: 333, out: 0, cr: 0, cc5: 0, cc1: 0, cci: 0 } } };
      fs.writeFileSync(path.join(stateDir, SID_C + '.json'), JSON.stringify(jsonC));
      globalThis.__ccsdActiveSid = SID_C;
      try {
        const got = fn();
        const ok = got && got.tokens && got.tokens.total && got.tokens.total.in === 333;
        check('IIFE.122 readTok falls back to <sid>.json when snapshot absent (legacy compat)', ok);
      } catch (e) {
        check('IIFE.122 readTok falls back to <sid>.json when snapshot absent (legacy compat)', false, e.message);
      }

      // IIFE.123: when NEITHER exists (truly fresh session), readTok returns
      // null. Pin the null fallback so the §E QuickPick + §G tick can detect
      // "no data" and render the placeholder.
      const SID_D = 'q1-neither';
      globalThis.__ccsdActiveSid = SID_D;
      try {
        const got = fn();
        check('IIFE.123 readTok returns null when neither file exists', got === null);
      } catch (e) {
        check('IIFE.123 readTok returns null when neither file exists', false, e.message);
      }

      // IIFE.124: when <sid>.tokens.json exists but has NO tokens field
      // (corrupt/partial), readTok must fall back to <sid>.json. Pin the
      // "snapshot present but invalid → fall through" path.
      const SID_E = 'q1-snap-no-tokens';
      fs.writeFileSync(path.join(stateDir, SID_E + '.tokens.json'), JSON.stringify({ v: 1, sid: SID_E }));
      fs.writeFileSync(
        path.join(stateDir, SID_E + '.json'),
        JSON.stringify({ state: 'running', tokens: { total: { in: 444, out: 0, cr: 0, cc5: 0, cc1: 0, cci: 0 } } }),
      );
      globalThis.__ccsdActiveSid = SID_E;
      try {
        const got = fn();
        const ok = got && got.tokens && got.tokens.total && got.tokens.total.in === 444;
        check('IIFE.124 readTok falls back to <sid>.json when snapshot has no tokens field', ok);
      } catch (e) {
        check('IIFE.124 readTok falls back to <sid>.json when snapshot has no tokens field', false, e.message);
      }

      // Cleanup: clear the active sid so subsequent sections don't see a
      // leftover value (this is globalThis-pinned across the test process).
      globalThis.__ccsdActiveSid = undefined;
    }
  }
}

// --- v0.2.9 Q5: render-churn dedup gates (Uri cache + token SBI text dedup +
//     offset sidecar mtime+size cache). Source-text presence assertions —
//     behavioral testing of the in-IIFE closures would require a full VSCode
//     EH mock (vs.Uri.file / vs.window.createStatusBarItem), out of scope for
//     this test suite (the existing IIFE.97-124 computeLiveDelta/readTok
//     harness covers behavior for those pure helpers; these three are
//     impure — they call into vscode API + globalThis caches). Source
//     presence + banner-stamp + paren-balance is the right gate here; the
//     measured-numbers rationale lives in docs/STATES.md §9 + git history (pre-0.5.10 CHANGELOG).

// IIFE.125 v0.2.9 Q5 Fix 1: ccuri() Uri cache helper defined (vs.Uri.file
// memoization by path string). Source-text presence.
check(
  'IIFE.125 v0.2.9 Q5 Fix 1: ccuri() Uri cache helper present (iconPath dedup)',
  /function ccuri\(p\)\{return __ccsdUriCache\[p\]\|\|\(__ccsdUriCache\[p\]=vs\.Uri\.file\(p\)\);\}/.test(iife),
);

// IIFE.126 v0.2.9 Q5 Fix 1: __ccsdUriCache global declared (Object.create(null)).
check(
  'IIFE.126 v0.2.9 Q5 Fix 1: __ccsdUriCache Object.create(null) declaration present',
  /var __ccsdUriCache=Object\.create\(null\)/.test(iife),
);

// IIFE.127 v0.2.9 Q5 Fix 1: p.iconPath assigns via ccuri(), not vs.Uri.file.
// Both iconPath assignment sites (pending branch + state-driven svg branch)
// must go through ccuri() so the EH-side reference-equality dedup fires.
check(
  'IIFE.127 v0.2.9 Q5 Fix 1: p.iconPath uses ccuri() (not vs.Uri.file) at all sites',
  /p\.iconPath=ccuri\(/.test(iife) && !/p\.iconPath=vs\.Uri\.file\(/.test(iife),
);

// IIFE.128 v0.2.9 Q5 Fix 2: token SBI text dedup via __ccsdTokSbiLastText.
// The existing tooltip dedup pattern is mirrored for text. The cache variable
// MUST appear at least twice (read + write in the dedup check), and the
// legacy unconditional `tsbi.text=tlabel` (no surrounding dedup check) must
// be gone.
check(
  'IIFE.128 v0.2.9 Q5 Fix 2: __ccsdTokSbiLastText dedup pattern present for tsbi.text',
  /__ccsdTokSbiLastText!==tlabel\)\{globalThis\.__ccsdTokSbiLastText=tlabel;tsbi\.text=tlabel;/.test(iife),
);

// IIFE.129 v0.2.9 Q5 Fix 2: tsbi.text dedup pattern fires on the 3 error/empty
// branches too (no-data "$(clock) 0 tok" + 2x "$(clock) —"). Confirms the
// dedup is applied uniformly, not only on the normal tlabel branch.
check(
  'IIFE.129 v0.2.9 Q5 Fix 2: tsbi.text dedup fires on error/empty branches too',
  /__ccsdTokSbiLastText!=="\$\(clock\) 0 tok"/.test(iife) && /__ccsdTokSbiLastText!=="\$\(clock\) —"/.test(iife),
);

// IIFE.130 v0.2.9 Q5 Fix 3: __ccsdOffCache mtime+size short-circuit in
// computeLiveDelta (mirrors __ccsdAgCache pattern at §F aggregation).
check(
  'IIFE.130 v0.2.9 Q5 Fix 3: __ccsdOffCache mtime+size cache in computeLiveDelta',
  /var __oc=globalThis\.__ccsdOffCache[\s\S]{0,400}?__oe\.mt===__omt&&__oe\.sz===__osz/.test(iife),
);

// IIFE.131 v0.2.9 Q5 Fix 3: cache MISS path falls through to JSON.parse +
// populates the cache (the write side of the contract).
check(
  'IIFE.131 v0.2.9 Q5 Fix 3: __ccsdOffCache populated on miss (JSON.parse + __oc[offPath]=)',
  /__oc\[offPath\]=\{j:sc,mt:__omt,sz:__osz\}/.test(iife),
);

// IIFE.132 v0.2.9 Q4: HOOK_EVENTS includes PostCompact (the writer-side fix
// surfaces in the IIFE banner through HOOK_EVENTS being baked into the
// settings.json hook-writer loop). Source check on patch.ts instead.
check(
  'IIFE.132 v0.2.9 Q4: no vs.Uri.file CALL outside ccuri definition (defense: every iconPath uses cache)',
  // The only vs.Uri.file call remaining is INSIDE the ccuri definition itself.
  (iife.match(/vs\.Uri\.file\(/g) || []).length === 1,
);

// === v0.3.0 (lane D+E): tok/s rate sampling, sparkline, webview chart ===

// IIFE.133 fmtTok now scales to B/T (the v0.2.9 fmtTok ceiling was M, which
// rendered 1.5B as "1500.0M" — the explicit user complaint at the 796M→1B
// threshold). The new tiers (1e9→B, 1e12→T) must both be present.
check('IIFE.133 v0.3.0 fmtTok scales to B (1e9 tier)', /\["B",1e9\]/.test(iife));
check('IIFE.134 v0.3.0 fmtTok scales to T (1e12 tier)', /\["T",1e12\]/.test(iife));

// IIFE.135 fmtTok trailing-zero strip regex (clears "796.0M" → "796M").
// The IIFE contains s.replace(/\.0+$/,"") — match the literal form.
check('IIFE.135 v0.3.0 fmtTok trailing-zero strip regex', /s\.replace\(\/\\\.0\+\$\/,""\)/.test(iife));

// IIFE.136 rate sampling core: __ccsdRateSample function present. Per-sid
// ring buffer keyed on globalThis.__ccsdRateBuf; samples {ts,d,total}.
check(
  'IIFE.136 v0.3.0 __ccsdRateSample function present',
  /function\s+__ccsdRateSample\s*\(\s*sid\s*,\s*realNow\s*,\s*totalNow\s*,\s*isRunning\s*,\s*nowMs\s*\)/.test(iife),
);

// IIFE.137 ring buffer cap constant (16 entries = 8s @ 500ms tick).
check('IIFE.137 v0.3.0 RATE_BUF_CAP=16 (8s @ 500ms tick)', /var\s+RATE_BUF_CAP=16/.test(iife));

// IIFE.138 sparkline chars present (▁▂▃▄▅▆▇█ U+2581..U+2588).
check('IIFE.138 v0.3.0 sparkline chars ▁▂▃▄▅▆▇█ (U+2581..U+2588)', iife.includes('▁▂▃▄▅▆▇█'));

// IIFE.139 §G tick calls __ccsdRateSample (rate sampling wired into the
// 500ms token SBI tick).
check(
  'IIFE.139 v0.3.0 §G tick calls __ccsdRateSample',
  /var\s+rateInfo\s*=\s*__ccsdRateSample\s*\(\s*activeSid\s*,\s*realNow\s*,\s*total\s*,\s*isRunning\s*,\s*Date\.now\(\s*\)\s*\)/.test(
    iife,
  ),
);

// IIFE.140 rate gated by cfg.rateDisplayMode (off|numeric|sparkline|both).
// v0.5.1: default changed both→numeric (chart panel removed; inline numeric
// suffix is now the only rate surface; users wanting sparkline opt in).
check(
  'IIFE.140 v0.5.1 §G tick reads cfg.rateDisplayMode (default numeric)',
  /cfg\.get\s*\(\s*"rateDisplayMode"\s*,\s*"numeric"\s*\)/.test(iife),
);

// IIFE.141 rate sampling uses INPUT+OUTPUT only (lane D R2 critical): cache_read
// at 85% of a 796M session would produce meaningless multi-M tok/s spikes.
// Verify realNow formula = (w.in+w.out) + (dIn+dOut), NOT including dCr/dCc5/dCc1/dCci.
check(
  'IIFE.141 v0.3.0 rate samples INPUT+OUTPUT only (excludes cache per lane D R2)',
  /var\s+realNow\s*=\s*\(\s*\(\s*w\.in\|\|0\s*\)\s*\+\s*\(\s*w\.out\|\|0\s*\)\s*\)\s*\+\s*dIn\s*\+\s*dOut/.test(iife),
);

// IIFE.142 sparkline renderer function present.
check(
  'IIFE.142 v0.3.0 __ccsdRateSpark renderer present',
  /function\s+__ccsdRateSpark\s*\(\s*arr\s*,\s*peak\s*\)/.test(iife),
);

// IIFE.143 sidecar flush (atomic tmp+rename, throttled 5s).
check(
  'IIFE.143 v0.3.0 __ccsdRateFlush atomic tmp+rename (throttled 2s)',
  /fs\.renameSync\s*\(\s*tmpPath\s*,\s*finalPath\s*\)/.test(iife) && /RATE_FLUSH_MS\s*=\s*5000/.test(iife),
);

// IIFE.144 sidecar load (one-shot via __ccsdRateLoaded) for cross-reload.
check(
  'IIFE.144 v0.3.0 __ccsdRateLoad one-shot sidecar load (cross-reload)',
  /function\s+__ccsdRateLoad\s*\(\s*sid\s*\)/.test(iife) && /globalThis\.__ccsdRateLoaded/.test(iife),
);

// IIFE.145-150, 152, 153a/b/c v0.5.1 REMOVED — these asserted the chart panel
// (showRateChart + __ccsdRateChartHtml/Css/Js + __ccsdGetNonce + the CSP nonce
// posture + the chart-panel setInterval read-only-ness). v0.5.1 removed the
// chart panel entirely (inline tok/s suffix on the §G tick covers the user's
// actual need; the panel added surface area + a 3rd setInterval). The rate-
// sampling infra that POWERED the chart is KEPT (IIFE.136-144, 151) because it
// also powers the inline suffix + cross-reload continuity. The chart removal
// is gated by IIFE.66 (setInterval count 3→2), IIFE.71 (qpShowChart*/wv* keys
// dropped from the dict), and the negative assertions below.
check(
  'IIFE.145a v0.5.1 chart panel removed — showRateChart function absent',
  !/function\s+showRateChart\s*\(/.test(iife),
);
check('IIFE.145b v0.5.1 chart panel removed — __ccsdRateChartHtml absent', !/__ccsdRateChartHtml/.test(iife));
check('IIFE.145c v0.5.1 chart panel removed — __ccsdGetNonce absent', !/__ccsdGetNonce/.test(iife));
check('IIFE.145d v0.5.1 chart i18n keys dropped — qpShowChartLabel absent', !iife.includes('qpShowChartLabel'));
check('IIFE.145e v0.5.1 chart i18n keys dropped — wvChartTitle absent', !iife.includes('wvChartTitle'));
check('IIFE.145f v0.5.1 chart webview artifacts gone — no <svg literal', !iife.includes('<svg'));

// IIFE.151 __ccsdRateFromBuf read-only helper present (extracted from
// __ccsdRateSample's former inline rate compute — same windowed-sum math, just
// hoisted to a pure function). v0.5.1 KEEPS this helper even though the chart
// panel is gone — __ccsdRateSample calls it internally to compute the rate
// that drives the inline tok/s SBI suffix.
check(
  'IIFE.151 v0.3.0 fix __ccsdRateFromBuf read-only helper present (rate-from-buffer, no mutation)',
  /function\s+__ccsdRateFromBuf\s*\(\s*arr\s*,\s*nowMs\s*\)/.test(iife),
);

// IIFE.160 v0.5.1: rate suffix is '·'-separated like cost. The §G tick builds
// rateSuffix as ' · ' + <sparkline/numeric> (was previously space-separated),
// so the bar renders '$(clock) 12.3k tok · 1.2k/s · ~$0.42' — rate and cost at
// the same divider level. Verified by the literal '" · "' push inside the
// rateSuffix assignment block.
check(
  'IIFE.160 v0.5.1 rate suffix uses "·" separator (mirrors cost divider)',
  /rateSuffix\s*=\s*" · "\s*\+\s*rs/.test(iife),
);

// IIFE.154-157 v0.4.0 Favorites bridge. The companion's Favorites tree needs
// to focus an already-open CC webview panel from outside the IIFE's per-panel
// closure. The IIFE publishes globalThis.__ccsdSidToPanel[sid] = t.panelTab
// in §A preamble (idempotent — the __ccsdDotStarted guard at IIFE entry
// guarantees one-shot per panel); §Z onDidDispose deletes the entry; a
// ccStatusDot.fav.focusSession command is registered as a fallback path
// (companion's primary path reads the map directly via shared globalThis).
// See docs/FAVORITES-DESIGN.md §4.1-4.2 for the dual-channel bridge design.
check(
  'IIFE.154 v0.4.0 FAV BRIDGE §A — __ccsdSidToPanel initialized + populated',
  /if\(!globalThis\.__ccsdSidToPanel\)globalThis\.__ccsdSidToPanel=Object\.create\(null\)/.test(iife) &&
    /globalThis\.__ccsdSidToPanel\[t\.__ccsdSid\]=t\.panelTab/.test(iife),
  '§A preamble must publish t.panelTab into the window-scoped sid→panel map',
);

check(
  'IIFE.155 v0.4.0 FAV BRIDGE §Z — onDidDispose deletes __ccsdSidToPanel[sid]',
  /if\(globalThis\.__ccsdSidToPanel&&t\.__ccsdSid\)delete globalThis\.__ccsdSidToPanel\[t\.__ccsdSid\]/.test(iife),
  '§Z onDidDispose must clear the panel entry so the Favorites tree can mark closed sessions',
);

check(
  'IIFE.156 v0.4.0 FAV BRIDGE §D.5 — ccStatusDot.fav.focusSession command registered',
  /__ccsdFavCmdRegistered/.test(iife) && /vs\.commands\.registerCommand\("ccStatusDot\.fav\.focusSession"/.test(iife),
  'registerCommand fallback path for EH-isolation future-proofing (mirrors SBI_CLICK_CMD pattern)',
);

check(
  'IIFE.157 v0.4.0 FAV BRIDGE focusSession handler is fail-safe (returns false on miss, no error popup)',
  /function\(sid\)\{try\{if\(sid&&globalThis\.__ccsdSidToPanel&&globalThis\.__ccsdSidToPanel\[sid\]\)/.test(iife) &&
    /return false/.test(iife),
  'focusSession must NOT throw or show error UI on miss (race with panel close is normal)',
);

// IIFE.161-163 v0.5.3 FAV BRIDGE §A/§tick/§Z — sid→title map. The companion's
// favToggleTab resolves the RIGHT-CLICKED background tab (F1) by matching
// activeTabGroup.activeTab.label against this map, and labels favorites with
// the live title (F2). The map is initialized in the §A preamble (idempotent),
// refreshed every 500ms tick (rename_tab picks up), and cleared in §Z
// onDidDispose — same lifecycle discipline as the v0.4 __ccsdSidToPanel map
// (IIFE.154/155). See companion/extension.ts:favToggleTab for the consumer.
check(
  'IIFE.161 v0.5.3 FAV BRIDGE §A — __ccsdSidToTitle initialized in preamble',
  /if\(!globalThis\.__ccsdSidToTitle\)globalThis\.__ccsdSidToTitle=Object\.create\(null\)/.test(iife),
  '§A preamble must init the sid→title map so the companion can resolve right-clicked tabs + label favorites',
);

check(
  'IIFE.162 v0.5.3 FAV BRIDGE §tick — __ccsdSidToTitle[sid] refreshed from t.__ccsdTitle each tick; panelTab.title fallback STRIPS the painted ★/● prefix (v0.5.46.1)',
  /globalThis\.__ccsdSidToTitle\[sid\]=__tt/.test(iife) &&
    /var __tt=t\.__ccsdTitle\|\|\(t\.panelTab&&t\.panelTab\.title\?t\.panelTab\.title\.replace\(\/\^\[★●\]\\s\/,""\):""\)/.test(
      iife,
    ),
  'per-tick refresh picks up rename_tab title changes (t.__ccsdTitle kept fresh by replA/replB). v0.5.46.1 (review MEDIUM): the panelTab.title FALLBACK now strips the painted ★/● prefix before publishing — when a title-less update_session_state clobbers t.__ccsdTitle to falsy (real CC caller sends no title), the old fallback republished the PAINTED "★ X"/"● X" tab title into the bridge, violating the v0.5.9 "bare logical title" invariant and letting the companion close-time persist durably store the prefixed label. Same char class as the paint ternary + companion stripTabMarkers (contract-sync pinned).',
);

check(
  'IIFE.163 v0.5.3 FAV BRIDGE §Z — onDidDispose deletes __ccsdSidToTitle[sid]',
  /if\(globalThis\.__ccsdSidToTitle&&t\.__ccsdSid\)delete globalThis\.__ccsdSidToTitle\[t\.__ccsdSid\]/.test(iife),
  '§Z onDidDispose must clear the title entry (symmetric to the sid→panel delete at IIFE.155)',
);

// --- v0.5.9 Star-in-webview removal + tab-title ★ prefix --------------------
// v0.5.8 injected a clickable star into the CC webview HTML via two paths
// (Prong 1 prototype html-setter monkey-patch + Prong 2 per-panel
// read-modify-write). CC 2.1.218 forensics proved this architecturally
// infeasible: CC sets webview.html exactly once at panel creation (3
// createPanel paths) and never reassigns it, so Prong 1's setter installs
// AFTER the only write and never fires; Prong 2 forces a full webview reload
// (VSCode replaces entire content on any .html assignment) which destroys
// CC's React session state. v0.5.9 DELETES all of that and replaces it with
// a "★ " prefix on the TAB TITLE (the IIFE already owns panelTab.title and
// already reads favorites every tick). These guards pin both halves so the
// broken injection cannot silently return and the tab-title signal cannot
// be dropped during a refactor.
check(
  'IIFE.170 v0.5.9 in-webview star injection REMOVED — no injectStarHtml',
  !/injectStarHtml/.test(iife),
  'injectStarHtml (Prong 2 read-modify-write) forces a destructive CC session reload and was removed',
);
check(
  'IIFE.171 v0.5.9 in-webview star injection REMOVED — no __ccsdStar / STAR_SRC / html setter patch',
  !/__ccsdStar|STAR_SRC|__ccsdHtmlSetterPatched|__ccsdStarInjected|ccsdToggleFav|ccsdFavState|ccsdSidSync/.test(iife),
  'the entire §AA injection surface (script src, prototype setter, read-modify-write, message bridge) was removed',
);
check(
  'IIFE.172 v0.5.42.2 tab-title ★ and ● are MUTUALLY EXCLUSIVE — a ternary, not prefix accumulation',
  /var __want=__isFav\?\(\"\\u2605 \"\+__base\):\(__isArch\?\(\"\\u25CF \"\+__base\):__base\)/.test(iife),
  'v0.5.42.2: archive tab-title marker is ● (BLACK CIRCLE, U+25CF) — same shape as the status-bar archive button ($(circle-filled) codicon), so tab + status bar stay consistent. Circle is the only full-size codicon (besides ★) with hollow+filled variants. Ternary __isFav?"★ ":__isArch?"● ":bare; favorited wins the tiebreak.',
);
check(
  'IIFE.172b v0.5.40 tab-title archived prefix reads readArchivedSet() — __aset/__isArch declared in the same tick block',
  /var __fset=readFavSet\(\);var __aset=readArchivedSet\(\);var __isFav=!?\(!__fset\|\|!__fset\[sid\]\);var __isArch=!?\(!__aset\|\|!__aset\[sid\]\)/.test(
    iife,
  ),
  'the archived state is resolved per-tick from readArchivedSet() (mirrors readFavSet/__isFav in the same try block) — drives the ◆ title prefix and is independent of the fav cache',
);
check(
  'IIFE.173 v0.5.9 tab-title prefix bases on t.__ccsdTitle (logical title — no ★★ stacking)',
  /var __base=t\.__ccsdTitle\|\|"";if\(__base\)/.test(iife),
  'the ★ prefix must use the cached LOGICAL title (t.__ccsdTitle, set by replA/replB) as the base so repeated ticks do not stack ★★★ and the §A sid→title bridge keeps publishing the un-starred label',
);
check(
  'IIFE.174 v0.5.9 tab-title write guarded by `panelTab.title !== __want` (no redundant 2×/sec IPC)',
  /if\(t\.panelTab\.title!==__want\)t\.panelTab\.title=__want/.test(iife),
  'only re-assign panelTab.title when the desired value differs from the current — avoids a redundant renderer write every 500ms tick when fav state is unchanged',
);
check(
  'IIFE.175 v0.5.36 Fix 1 rev5: onDidChangeViewState sets __switching__ sentinel (when sid unset) + triggers event-driven __ccsdSbiTick refresh; NO unconditional loading icon (rev3 removed — caused loaded-switch flicker)',
  /if\(ev&&ev\.webviewPanel&&ev\.webviewPanel\.active===true\)\{if\(t\.__ccsdSid\)\{globalThis\.__ccsdActiveSid=t\.__ccsdSid/.test(
    iife,
  ) &&
    /\}else\{globalThis\.__ccsdActiveSid="__switching__";\}/.test(iife) &&
    /if\(globalThis\.__ccsdSbiTick\)\{try\{globalThis\.__ccsdSbiTick\(\)\}catch/.test(iife) &&
    !/__ccsdTokSbi\.text="\$\(sync~spin\)";globalThis\.__ccsdTokSbiLastText=""/.test(iife),
  'v0.5.36 Fix 1 evolved through 5 revs. rev1 gated loading on t.__ccsdSid (failed for initializing sessions). rev3 added unconditional $(sync~spin) on every activation — but user reported this caused a loading FLICKER on loaded-session switches (unnecessary transition). rev5 mirrors the companion favStatusBar exactly: (1) onDidChangeViewState sets the __switching__ sentinel ONLY when t.__ccsdSid is unset (initializing); (2) triggers an event-driven __ccsdSbiTick refresh (immediate, like favStatusBar tabGroups activation — not waiting for the 500ms tick); (3) NO unconditional loading icon. The §G tick (IIFE.179) scans __ccsdSidToPanel for the real-time active panel → instant swap for loaded sessions, loading via sentinel for initializing. Asserts: active=true gate + sentinel when sid unset + __ccsdSbiTick trigger + NO unconditional tsbi.text=$(sync~spin).',
);
check(
  'IIFE.179 v0.5.36 Fix 1 rev5: §G tick scans __ccsdSidToPanel for panelTab.active===true (real-time, mirrors favStatusBar) + __ccsdSbiTick exposed on globalThis for event-driven refresh',
  /var __spm=globalThis\.__ccsdSidToPanel;if\(__spm\)\{for\(var __pk in __spm\)/.test(iife) &&
    /if\(__spm\[__pk\]&&__spm\[__pk\]\.active===true\)\{activeSid=__pk;break/.test(iife) &&
    /globalThis\.__ccsdSbiTick=__ccsdSbiTick/.test(iife),
  'THE specific difference (user ask "为什么收藏能 token 不能"): companion favStatusBar activeCcSidOrLoading() scans globalThis.__ccsdSidToPanel for the panel with .active===true — VSCode panelTab.active is a REAL-TIME property that flips the instant a tab is switched (does NOT wait for the 500ms per-panel tick to write __ccsdActiveSid). The token SBI formerly read __ccsdActiveSid (lagging ≤500ms) → stale prev-session data during switch + loading flicker. rev5 fix: §G tick now scans __ccsdSidToPanel the same way (real-time active panel) → instant correct sid on switch. __ccsdSbiTick is exposed on globalThis so onDidChangeViewState (event-driven, fires on tab switch) can trigger an immediate §G refresh — matching favStatusBar tabGroups activation timing. Loading (via __switching__ sentinel, IIFE.177/178) only fires when the active panel has no captured sid (truly initializing). Asserts: scan loop + active===true check + globalThis.__ccsdSbiTick exposure.',
);
check(
  'IIFE.177 v0.5.36 Fix 1 rev6: §G tick checks __switching__ sentinel FIRST (before scan) → shows $(sync~spin) + returns',
  /if\(globalThis\.__ccsdActiveSid==="__switching__"\)\{[^]*?tsbi\.text="\$\(sync~spin\)"\}return/.test(iife) &&
    !/if\(activeSid==="__switching__"\)/.test(iife),
  'rev6 moved the sentinel check to the TOP of the §G tick (before the __ccsdSidToPanel scan), checking globalThis.__ccsdActiveSid directly. Previously the sentinel check was AFTER the scan+fallback — if the scan resolved activeSid to a real sid (e.g. a stale-active prev-session panel whose panelTab.active transiently lagged the tab switch), the sentinel was skipped → stale prev-session tokens shown during initializing-session switch. rev6: sentinel takes ABSOLUTE priority — if __ccsdActiveSid is "__switching__" (set by per-panel tick rev4 / onDidChangeViewState rev5 when the active panel sid is not captured), show loading + return, regardless of scan result. The old post-scan if(activeSid===...) check is removed (dead code). Asserts: globalThis.__ccsdActiveSid sentinel check + loading+return + NO leftover activeSid===sentinel check.',
);
check(
  'IIFE.178 v0.5.36 Fix 1 rev4: per-panel tick ASSERTS __switching__ sentinel when active && sid unset (500ms poll — mirrors companion favStatusBar activeCcSidOrLoading)',
  /claude-logo-idle\.svg/.test(iife) &&
    /if\(p\.active===true\)\{globalThis\.__ccsdActiveSid="__switching__"\}return/.test(iife),
  'rev3 relied on onDidChangeViewState (one-time event) to set the sentinel — but for a resumed HISTORICAL session the per-panel tick (500ms poll) is the robust path, mirroring the companion favStatusBar activeCcSidOrLoading() which pulls the active tab registration status every tick. Root cause traced by user-reported asymmetry: favStatusBar showed loading immediately while token SBI showed stale prev-session tokens — because the per-panel tick early-returned at if(!sid) WITHOUT touching __ccsdActiveSid, so the global stayed at the previous session A until B sid landed. rev4 fix: in the !sid early-return, if p.active===true assert globalThis.__ccsdActiveSid="__switching__" every tick → §G tick (IIFE.177) shows loading. Once Anchor A captures the real sid, the active-gate (if(p.active===true){__ccsdActiveSid=sid}) overwrites the sentinel. Asserts: idle.svg catch immediately followed by the active-gate sentinel assertion.',
);
check(
  'IIFE.176 v0.5.36 rev2: showQuickPick().then dumps timing marks via __dump() — NO withProgress notification, NO qpLoadingTitle (cancel/Esc just closes picker, nothing to leak)',
  /showQuickPick\(items,\{placeHolder:tr\("qpPlaceHolder"\)\}\)\.then\(function\(p\)\{__dump\(\);if\(!p\)return/.test(
    iife,
  ) &&
    !/vs\.window\.withProgress/.test(iife) &&
    !/qpLoadingTitle/.test(iife),
  'rev2 removed the initial v0.5.36 withProgress wrapper — it popped an intrusive "Loading token stats…" notification on EVERY click, and misleadingly suggested a network fetch. The config panel is 100 percent local: getConfiguration("ccStatusDot") + readTok() reading ~/.claude/cc-status-dot/<sid>.json; ZERO network calls; works fully offline. The first-click latency is VSCode showQuickPick cold-start (picker UI + codicon first-init, once per session) — extension code cannot eliminate it. The .then callback now just dumps timing marks (gated by CCSD_DEBUG) then handles the pick. resolveCb is gone (no withProgress Promise) so cancel/Esc has nothing to leak. Asserts: .then(function(p){__dump();if(!p)return + NO withProgress + NO qpLoadingTitle (unused i18n key removed with the notification).',
);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
