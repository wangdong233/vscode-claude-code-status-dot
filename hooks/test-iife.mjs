#!/usr/bin/env node
/**
 * test-iife.mjs — Reader (injected IIFE) smoke test.
 *
 * The state machine has TWO independent implementations: the writer's
 * deriveStatus (covered by test-cc-status.js) and the reader's injected IIFE
 * (state→SVG, notify dedup, __ccPending yield, done→idle fallback,
 * commandCenter 4-light aggregation + setContext driver). Until v0.1.10 only
 * the writer side had automated coverage; the reader side relied on
 * `assertCompiles` (syntax only). This file nails the reader side to
 * STATES.md §1/§4/§4b/§7 by extracting the actual IIFE that patch.ts bakes
 * (`--check-iife`) and asserting on its contents + syntax-validity.
 *
 * It does NOT execute the IIFE — VSCode APIs (`vscode.window`, `setInterval`
 * on a fake panel) would need a heavy harness. String + `node --check`
 * assertions are enough to lock the public contract: which SVG each state
 * maps to, that dedup is `since`-based (not prevSt), that __ccPending yields,
 * that macOS notifications fall back to VSCode messages on osascript failure,
 * that the timer is disposed with the panel, AND (v0.1.13) that the
 * commandCenter 4-light aggregation pushes the right setContext keys with the
 * right capping rules.
 *
 * Run:  node hooks/test-iife.mjs     (requires `npm run build` first; falls
 *                                    back to `npx tsx patch.ts` if dist/ is
 *                                    missing)
 */

import { spawnSync } from 'child_process';
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

// Mirror patch.ts CC_LIGHTS / CC_COUNT_VARIANTS (single source of truth is
// patch.ts; this local copy must stay in sync — these are the 4 commandCenter
// lights and the 5 count-variants per light that patchPackageJson contributes
// and the IIFE registers handlers for).
const CC_LIGHTS = ['done', 'running', 'pending', 'interrupted'];
const CC_COUNT_VARIANTS = ['0', '1', '2', '3', 'N'];

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
check('IIFE.12 __ccPending yield present', /if\s*\(\s*t\.__ccPending\s*\)\s*return/.test(iife));

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

// --- 7. __ccTitle suffix in notify message (M20 doc, IIFE-side contract) ----
// The only use of t.__ccTitle in the IIFE is the notify-suffix `" ["+title+"]"`.
// Asserting on the substring is enough; a regex over the JS source is brittle
// because `+` and `.` need careful escaping.
check(
  'IIFE.18 notify references __ccTitle for message suffix',
  iife.includes('t.__ccTitle') && iife.includes('["+t.__ccTitle+"]'),
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

// --- 10. flashSeq (renamed from `seq`, M8) ----------------------------------
check('IIFE.22 flashSeq drives interrupted flash', /flashSeq\s*%\s*2/.test(iife));
check('IIFE.23 no bare `seq` counter (M8 rename)', !/\bseq\s*%/.test(iife) && !/\bseq\+\+/.test(iife));

// --- 11. commandCenter 4-light (v0.1.13): aggregation + setContext driver --
// The v0.1.10-v0.1.12 StatusBarItem-at-Right is GONE. v0.1.13 contributes 20
// commands + 20 commandCenter menu items (group "navigation") + 20 palette
// hide-entries via patchPackageJson; the IIFE ticks a window-scoped singleton
// timer (__ccsdCcTimer, 500ms) that aggregates counts every 500ms and pushes
// 4 setContext keys (ccStatusDot.{done,running,pending,interrupted} = 0..4,
// 4 = "N" display). Exactly one variant per light shows at any moment.
//
// The aggregation applies the SAME §4 reader rules as per-tab rendering
// (done>5min→idle so IDLE sessions don't count toward green; running stale
// >30min→idle to GC crashed sessions). pending is counted INDEPENDENTLY of
// state — a session can be both running AND pending (running turn paused on
// a permission prompt). The v0.1.13 IIFE retains the project-scoped __ccsd*
// prefix (NOT CC's __cc* namespace — see the `cc-status-bar-injected`
// tombstone in restoreWebview()).
check(
  'IIFE.24 Cc singleton timer guard (replaces SBI singleton)',
  /if\s*\(\s*!globalThis\.__ccsdCcTimer\s*\)\s*\{globalThis\.__ccsdCcTimer\s*=\s*setInterval/.test(iife),
);
// R3-5 (round 3, ported): assert no `globalThis.__cc<SOMETHING-WRONG>` leaks —
// the only legitimate prefix is `__ccsd*` (lowercase s after __cc). CC's own
// namespace is `__cc` + capital letter directly. Lock the discriminator so a
// future bad refactor cannot silently occupy CC's __cc* namespace.
check('IIFE.24b Cc uses project-scoped __ccsd* (NOT CC __cc[A-Z] ns)', !/globalThis\.__cc[A-Z]/.test(iife));
// Cc aggregation must NOT touch vs.window.createStatusBarItem (removed in
// v0.1.13). Assert the SBI API call is GONE — a regression that revived it
// would silently bring back the removed "Right" SBI alongside the new
// commandCenter lights.
check('IIFE.25 SBI createStatusBarItem removed (v0.1.13)', !/vs\.window\.createStatusBarItem/.test(iife));
// Aggregation reads ALL session files via fs.readdirSync(DIR) — same data
// source as the removed SBI, just feeding setContext instead of item.text.
check('IIFE.26 Cc reads ALL files via readdirSync(DIR)', /readdirSync\s*\(\s*DIR\s*\)/.test(iife));
// 4 setContext pushes (one per light), each clamped through cap() to 0..4.
check(
  'IIFE.27 Cc pushes 4 setContext keys (done/running/pending/interrupted)',
  /vs\.commands\.executeCommand\s*\(\s*"setContext"\s*,\s*"ccStatusDot\.done"/.test(iife) &&
    /vs\.commands\.executeCommand\s*\(\s*"setContext"\s*,\s*"ccStatusDot\.running"/.test(iife) &&
    /vs\.commands\.executeCommand\s*\(\s*"setContext"\s*,\s*"ccStatusDot\.pending"/.test(iife) &&
    /vs\.commands\.executeCommand\s*\(\s*"setContext"\s*,\s*"ccStatusDot\.interrupted"/.test(iife),
);
// cap() clamps 4+ to 4 (so ccStatusDot.<k>==4 selects the "N" variant).
check(
  'IIFE.28 Cc cap() clamps 4+ to 4 (display N)',
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
// dropped it would re-open the silent false-stick.
check(
  'IIFE.29 Cc counts pending independent of state with idle GC (j.pending===true && st!=="idle")',
  /if\s*\(\s*j\.pending\s*===\s*true\s*&&\s*st\s*!==\s*"idle"\s*\)\s*ag\.pending\+\+/.test(iife),
);

// --- 12. v0.1.13 lifecycle: panel counter + teardown reset of 4 contexts ---
// IIFE entry bumps __ccsdPanelCount; onDidDispose decrements and on the LAST
// panel out (count→0) clears the singleton Cc timer AND resets all 4
// setContext keys to 0 so every light goes dim — the commandCenter can't
// freeze on a stale count when no panel survives to refresh it.
check(
  'IIFE.30 Cc panel counter increment at IIFE entry',
  /globalThis\.__ccsdPanelCount\s*=\s*\(\s*globalThis\.__ccsdPanelCount\s*\|\|\s*0\s*\)\s*\+\s*1/.test(iife),
);
check(
  'IIFE.31 Cc panel counter decrement + last-out teardown in onDidDispose',
  /globalThis\.__ccsdPanelCount\s*=\s*\(\s*globalThis\.__ccsdPanelCount\s*\|\|\s*1\s*\)\s*-\s*1/.test(iife) &&
    /if\s*\(\s*globalThis\.__ccsdPanelCount\s*<=\s*0\s*\)/.test(iife) &&
    /clearInterval\s*\(\s*globalThis\.__ccsdCcTimer\s*\)/.test(iife),
);
// Last-panel-out teardown must reset all 4 contexts to 0 — locks v0.1.13
// "lights go dim when no CC panel survives" behavior.
check(
  'IIFE.32 Cc last-panel-out resets 4 setContext keys to 0',
  /vs\.commands\.executeCommand\s*\(\s*"setContext"\s*,\s*"ccStatusDot\.done"\s*,\s*0\s*\)/.test(iife) &&
    /vs\.commands\.executeCommand\s*\(\s*"setContext"\s*,\s*"ccStatusDot\.running"\s*,\s*0\s*\)/.test(iife) &&
    /vs\.commands\.executeCommand\s*\(\s*"setContext"\s*,\s*"ccStatusDot\.pending"\s*,\s*0\s*\)/.test(iife) &&
    /vs\.commands\.executeCommand\s*\(\s*"setContext"\s*,\s*"ccStatusDot\.interrupted"\s*,\s*0\s*\)/.test(iife),
);

// --- 13. v0.1.13 isolation: setup try/catch + teardown wrap (R3 carryover) --
// Carried over from v0.1.12 round-3 review: (1) Cc singleton-timer creation
// wrapped in try/catch — a throw inside setInterval registration (disposed
// host, transient VSCode API failure) is swallowed and the IIFE continues to
// the per-tab tick + onDidDispose registration. (2) The aggregation BODY
// inside the setInterval callback has its OWN try/catch so a readdir/stat/
// parse/setContext failure can never brick the per-panel tick. (3) The
// onDidDispose teardown registration remains wrapped in try/catch (matches
// the per-tab tick's isolation pattern).
check(
  'IIFE.33 Cc singleton-timer creation wrapped in try/catch (v0.1.13)',
  /try\s*\{\s*if\s*\(\s*!globalThis\.__ccsdCcTimer\s*\)\s*\{globalThis\.__ccsdCcTimer\s*=\s*setInterval/.test(iife) &&
    /,\s*500\s*\)\s*;\s*\}\s*\}\s*catch\s*\(\s*e\s*\)\s*\{\s*\}/.test(iife),
);
check(
  'IIFE.34 Cc aggregation body wrapped in try/catch',
  /setInterval\s*\(\s*function\s*\(\s*\)\s*\{\s*try\s*\{\s*var\s+ag\s*=\s*\{running:0,done:0,interrupted:0,idle:0,pending:0\}/.test(
    iife,
  ),
);
check(
  'IIFE.35 Cc onDidDispose registration wrapped in try/catch',
  /try\s*\{\s*t\.panelTab\.onDidDispose\s*\(/.test(iife) && /\)\s*\}\s*catch\s*\(\s*e\s*\)\s*\{\s*\}/.test(iife),
);
// Reader-rule parity: aggregation applies §4 done>5min→idle so IDLE sessions
// are NOT counted toward the green light (only ACTIVE done is). A regression
// that dropped this clause would make the 🟢 light over-count stale done.
check(
  'IIFE.36 Cc applies §4 done>5min→idle rule in aggregation',
  /if\s*\(\s*st\s*===\s*"done"\s*&&\s*since\s*&&\s*\(\s*Date\.now\s*\(\s*\)\s*-\s*since\s*\)\s*>\s*DONE_TO_IDLE_MS\s*\)\s*\{\s*st\s*=\s*"idle"\s*;\s*\}/.test(
    iife,
  ),
);
// §7.2 stale-running heuristic (mtime>SBI_RUNNING_STALE_MS→idle) is preserved
// in the Cc aggregation (variable name kept for grep continuity).
check(
  'IIFE.37 Cc stale-running heuristic (mtime>SBI_RUNNING_STALE_MS→idle)',
  /\(\s*Date\.now\s*\(\s*\)\s*-\s*mt\s*\)\s*>\s*SBI_RUNNING_STALE_MS\s*\)\s*\{\s*st\s*=\s*"idle"\s*;\s*\}/.test(iife),
);
// v0.1.13 interrupted retention (architecture-review fix): interrupted files
// older than 24h decay to idle so the 🔴 red light doesn't monotonically grow
// from accumulated abandoned interrupted sessions (crashed/killed CC never
// sends SessionEnd). File is NOT deleted — only the count drops. Lock the
// constant + the decay branch so a regression that dropped the GC would
// re-open the unbounded 🔴 growth.
check(
  'IIFE.37b Cc INTERRUPTED_RETENTION_MS constant (24h decay for 🔴)',
  /var\s+INTERRUPTED_RETENTION_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(iife),
);
check(
  'IIFE.37c Cc interrupted>24h mtime decay →idle (bounds 🔴 growth)',
  /else if\s*\(\s*st\s*===\s*"interrupted"\s*\)\s*\{\s*var\s+mt\s*=\s*0;try\s*\{\s*mt\s*=\s*fs\.statSync\s*\(\s*fp\s*\)\.mtimeMs\s*\}\s*catch\s*\(\s*e2\s*\)\s*\{\s*\}\s*;?\s*if\s*\(\s*mt\s*&&\s*\(\s*Date\.now\s*\(\s*\)\s*-\s*mt\s*\)\s*>\s*INTERRUPTED_RETENTION_MS\s*\)\s*\{\s*st\s*=\s*"idle"\s*;\s*\}\s*\}/.test(
    iife,
  ),
);
// v0.1.13 LL map derivation: previously the IIFE hardcoded its own LL map
// with divergent wording while CC_LIGHTS.label was dead code. The fix makes
// CC_LIGHTS.tooltip the single source — buildIIFE interpolates a literal
// derived from CC_LIGHTS so adding a 5th light only touches CC_LIGHTS. Lock
// each of the 4 tooltip strings inside the IIFE so a regression that
// reverted to the hardcoded form (or dropped a tooltip) would surface.
check(
  'IIFE.37d Cc LL map carries CC_LIGHTS.tooltip for done ("turn complete (last 5 min)")',
  iife.includes('done:"turn complete (last 5 min)"'),
);
check(
  'IIFE.37e Cc LL map carries CC_LIGHTS.tooltip for pending ("awaiting user input")',
  iife.includes('pending:"awaiting user input"'),
);

// --- 14. commandCenter command handlers (v0.1.13): 20 registerCommand calls --
// patchPackageJson contributes 20 commands (ccStatusDot.<key>.<variant>) to
// CC's package.json. VSCode shows "command 'X' not found" if a contributed
// command is not registered — so the IIFE registers all 20 as info-message
// no-ops, idempotent across panels via globalThis.__ccsdCcCmdsRegistered.
// Lock the registration block: a regression that dropped it would make every
// CC light click pop a "command not found" error.
check(
  'IIFE.38 Cc command registration guarded by __ccsdCcCmdsRegistered',
  /if\s*\(\s*!globalThis\.__ccsdCcCmdsRegistered\s*\)\s*\{globalThis\.__ccsdCcCmdsRegistered\s*=\s*true/.test(iife),
);
check('IIFE.39 Cc uses vs.commands.registerCommand', /vs\.commands\.registerCommand\s*\(\s*"ccStatusDot\./.test(iife));
// The 20 command IDs are built dynamically as `"ccStatusDot."+k+"."+v` where
// k ∈ LK and v ∈ VR. The IIFE source therefore contains the LK array (4 light
// keys) + VR array (5 variants); together they prove the 4×5=20 coverage
// without needing literal IDs in source (which would balloon the IIFE).
check(
  'IIFE.40 Cc LK array covers all 4 lights',
  CC_LIGHTS.every((k) => iife.includes('"' + k + '"')),
);
check(
  'IIFE.40b Cc VR array covers all 5 variants (0/1/2/3/N)',
  CC_COUNT_VARIANTS.every((v) => iife.includes('"' + v + '"')),
);
// Per-tab rendering is UNCHANGED by v0.1.13 — assert the iconPath assignment
// still exists AFTER the aggregation block (regression check: a refactor that
// dropped per-tab dots while leaving only the commandCenter lights would pass
// every other assertion).
check('IIFE.41 per-tab p.iconPath assignment still present', /p\.iconPath\s*=\s*vs\.Uri\.file/.test(iife));

// --- summary ---------------------------------------------------------------

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
