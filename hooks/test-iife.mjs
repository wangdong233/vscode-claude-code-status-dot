#!/usr/bin/env node
/**
 * test-iife.mjs — Reader (injected IIFE) smoke test.
 *
 * The state machine has TWO independent implementations: the writer's
 * deriveStatus (covered by test-cc-status.js) and the reader's injected IIFE
 * (state→SVG, notify dedup, __ccPending yield, done→idle fallback). Until now
 * only the writer side had automated coverage; the reader side relied on
 * `assertCompiles` (syntax only). This file nails the reader side to STATES.md
 * §1/§4/§4b by extracting the actual IIFE that patch.ts bakes (`--check-iife`)
 * and asserting on its contents + syntax-validity.
 *
 * It does NOT execute the IIFE — VSCode APIs (`vscode.window`, `setInterval`
 * on a fake panel) would need a heavy harness. String + `node --check`
 * assertions are enough to lock the public contract: which SVG each state
 * maps to, that dedup is `since`-based (not prevSt), that __ccPending yields,
 * that macOS notifications fall back to VSCode messages on osascript failure,
 * and that the timer is disposed with the panel.
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
// Locks the v0.1.5 algorithm change (CHANGELOG[Unreleased]). A regression
// that revived the old prevSt transition check would silently miss fast
// turns (running→done between two polls).
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
check('IIFE.21 banner carries marker+version', /\/\*cc-status-dot-injected:v\d+\.\d+\.\d+\*\//.test(iife));

// --- 10. flashSeq (renamed from `seq`, M8) ----------------------------------
check('IIFE.22 flashSeq drives interrupted flash', /flashSeq\s*%\s*2/.test(iife));
check('IIFE.23 no bare `seq` counter (M8 rename)', !/\bseq\s*%/.test(iife) && !/\bseq\+\+/.test(iife));

// --- 11. Aggregated status bar item (v0.1.11 singleton item + singleton timer) --
// The SBI is a window-scoped singleton so N panels share ONE item AND one
// aggregation timer (v0.1.11 lifted the refresh off the per-panel tick into
// globalThis.__ccsdSbiTimer so a P-panel window ticks the aggregation ONCE
// per 500ms, not P times — aligning timer scope with item scope). The item
// + timer + a per-window panel counter use the project-scoped __ccsd* prefix
// (NOT CC's __cc* namespace — see the `cc-status-bar-injected` tombstone in
// restoreWebview() in patch.ts).
// Aggregation now applies the §4 reader rules (done>5min→idle; running
// mtime>30min→idle) so per-tab dots and the SBI count agree. The panel
// counter enables a clean "last panel out → hide SBI + clear singleton timer"
// path in onDidDispose so the bar can't freeze on a stale count.
//
// Emoji use \u{...} escapes (ASCII-only injected source — a backslash-u-brace
// sequence in the IIFE string), so the regexes match the literal escape text,
// not the decoded codepoint.
check('IIFE.24 SBI globalThis singleton guard (item)', /globalThis\.__ccsdSbi/.test(iife));
// R3-5 (round 3): the original regex `/globalThis\.__ccSbi(?!s|d|T|P)/` had a negative
// lookahead that EXEMPTED exactly the suffixes a future bad refactor would produce
// (`__ccSbiTimer`'s `T`, `__ccSbiItem`'s... etc). A regression renaming `__ccsdSbiTimer`
// → `__ccSbiTimer` would slip past. The CC namespace is `__cc` + capital letter
// directly; our project namespace is `__cc` + lowercase `sd` + anything. So the
// correct discriminator is `/globalThis\.__cc[A-Z]/` — matches ANY bare CC-namespace
// global, ignores our `__ccsd*` (lowercase `s` after `__cc`). Asserts no `globalThis.__ccX`
// where X is a capital letter (the CC-native naming pattern) is present.
check('IIFE.24b SBI uses project-scoped __ccsd* (NOT CC __cc[A-Z] ns)', !/globalThis\.__cc[A-Z]/.test(iife));
check(
  'IIFE.25 SBI createStatusBarItem(Right)',
  /vs\.window\.createStatusBarItem\s*\(\s*vs\.StatusBarAlignment\.Right/.test(iife),
);
check('IIFE.26 SBI name set', iife.includes('"Claude Code Sessions"'));
check('IIFE.27 SBI reads ALL files via readdirSync(DIR)', /readdirSync\s*\(\s*DIR\s*\)/.test(iife));
check('IIFE.28 SBI done count = green circle (\\u{1F7E2})', /\\u\{1F7E2\}/.test(iife));
check('IIFE.29 SBI running count = yellow circle (\\u{1F7E1})', /\\u\{1F7E1\}/.test(iife));
check('IIFE.30 SBI interrupted count = red circle (\\u{1F534})', /\\u\{1F534\}/.test(iife));
check('IIFE.31 SBI idle fallback = white circle (\\u{26AA})', /\\u\{26AA\}/.test(iife));
// Crash-safety: the aggregation block must be wrapped in try/catch so a
// readdir/parse failure (race with SessionEnd's file delete, JSON corruption)
// cannot brick the per-panel tick that follows it. v0.1.11 structure is
// `setInterval(function(){try{var sbi=globalThis.__ccsdSbi;...}catch(e){}})`.
check(
  'IIFE.32 SBI aggregation wrapped in try/catch',
  /setInterval\s*\(\s*function\s*\(\s*\)\s*\{\s*try\s*\{\s*var\s+sbi\s*=\s*globalThis\.__ccsdSbi/.test(iife),
);
// The aggregation must NOT replace the per-tab dot — assert the iconPath
// assignment still exists after the aggregation block.
check('IIFE.33 per-tab p.iconPath assignment still present', /p\.iconPath\s*=\s*vs\.Uri\.file/.test(iife));

// --- 12. v0.1.11 lifecycle + reader-rule parity (this dimension's e2e concerns) --
// hide()/show() lifecycle (the e2e "hide-show toggle" concern): a regression
// that dropped either call (e.g. an accidental deletion during a version bump,
// or a refactor to always-show policy) would silently pass IIFE.1-33 because
// none of them grep for the toggle. Lock them explicitly.
check(
  'IIFE.34 SBI hide() called when total===0',
  /if\s*\(\s*total\s*===\s*0\s*\)\s*\{\s*try\s*\{\s*sbi\.hide\s*\(\s*\)/.test(iife),
);
check('IIFE.35 SBI show() called when total>0', /try\s*\{\s*sbi\.show\s*\(\s*\)/.test(iife));
// idle fallback must be CONDITIONAL on parts.length===0 — a regression that
// made it unconditional (always-push ⚪ alongside the other segments) would
// still satisfy IIFE.31 (which only checks the escape exists). Lock the guard.
check(
  'IIFE.36 SBI idle fallback guarded by parts.length===0',
  /if\s*\(\s*parts\.length\s*===\s*0\s*\)\s*parts\.push\s*\(\s*"\\u\{26AA\}"/.test(iife),
);
// tooltip content: the only place the human-readable color legend appears.
check(
  'IIFE.37 SBI tooltip labels present',
  /Claude Code sessions: done /.test(iife) && /\/ running /.test(iife) && /\/ interrupted /.test(iife),
);
// v0.1.11 reader-rule parity: aggregation applies §4 done>5min→idle so the
// SBI count matches per-tab rendering (without this, a 2h-old done would
// render as a gray idle dot on the tab but still count as 🟢 in the SBI).
check(
  'IIFE.38 SBI applies §4 done>5min→idle rule in aggregation',
  /if\s*\(\s*st\s*===\s*"done"\s*&&\s*since\s*&&\s*\(\s*Date\.now\s*\(\s*\)\s*-\s*since\s*\)\s*>\s*DONE_TO_IDLE_MS\s*\)\s*\{\s*st\s*=\s*"idle"\s*;\s*\}/.test(
    iife,
  ),
);
// v0.1.11 GC heuristic for crashed running sessions (§7.5): a state=running
// file whose mtime exceeds SBI_RUNNING_STALE_MS is counted as idle, not
// running — so a crashed/killed CC process (no SessionEnd) can't pin 🟡1
// forever.
check(
  'IIFE.39 SBI stale-running heuristic (mtime>SBI_RUNNING_STALE_MS→idle)',
  /\(\s*Date\.now\s*\(\s*\)\s*-\s*mt\s*\)\s*>\s*SBI_RUNNING_STALE_MS\s*\)\s*\{\s*st\s*=\s*"idle"\s*;\s*\}/.test(iife),
);
// v0.1.11 singleton timer: aggregation lifted off the per-panel tick into
// globalThis.__ccsdSbiTimer so P panels → 1 aggregation tick per 500ms.
check(
  'IIFE.40 SBI singleton timer guard',
  /if\s*\(\s*!globalThis\.__ccsdSbiTimer\s*\)\s*\{globalThis\.__ccsdSbiTimer\s*=\s*setInterval/.test(iife),
);
// v0.1.11 panel counter: enables "last panel out → hide SBI + clear timer"
// so the bar can't freeze on a stale count when no panel remains to refresh.
check(
  'IIFE.41 SBI panel counter increment at IIFE entry',
  /globalThis\.__ccsdPanelCount\s*=\s*\(\s*globalThis\.__ccsdPanelCount\s*\|\|\s*0\s*\)\s*\+\s*1/.test(iife),
);
check(
  'IIFE.42 SBI panel counter decrement + last-out teardown in onDidDispose',
  /globalThis\.__ccsdPanelCount\s*=\s*\(\s*globalThis\.__ccsdPanelCount\s*\|\|\s*1\s*\)\s*-\s*1/.test(iife) &&
    /if\s*\(\s*globalThis\.__ccsdPanelCount\s*<=\s*0\s*\)/.test(iife) &&
    /clearInterval\s*\(\s*globalThis\.__ccsdSbiTimer\s*\)/.test(iife),
);

// --- 13. v0.1.12 round-3 review: SBI setup-isolation + teardown wrap --------
// R3-1 (HIGH): the SBI singleton creation (vs.window.createStatusBarItem) and
// the SBI singleton timer creation (setInterval) must each be wrapped in their
// OWN try/catch. A throw inside createStatusBarItem (disposed host, transient
// VSCode API failure) would otherwise propagate up through the comma-operator
// chain into CC's update_session_state handler — bricking session-state
// tracking AND skipping the per-tab setInterval AND skipping onDidDispose
// registration (so the panel counter bumped at IIFE entry would never
// decrement, a permanent leak). The aggregation BODY's try/catch (IIFE.32)
// does NOT cover the SETUP — these are separate concerns, locked separately.
check(
  'IIFE.43 SBI singleton-item creation wrapped in try/catch (v0.1.12)',
  /try\s*\{\s*if\s*\(\s*!globalThis\.__ccsdSbi\s*\)\s*\{globalThis\.__ccsdSbi\s*=\s*vs\.window\.createStatusBarItem/.test(
    iife,
  ),
);
check(
  'IIFE.44 SBI singleton-timer creation wrapped in try/catch (v0.1.12)',
  /try\s*\{\s*if\s*\(\s*!globalThis\.__ccsdSbiTimer\s*\)\s*\{globalThis\.__ccsdSbiTimer\s*=\s*setInterval/.test(iife) &&
    /,\s*500\s*\)\s*;\s*\}\s*\}\s*catch\s*\(\s*e\s*\)\s*\{/.test(iife),
);
// R3-4 (MEDIUM): the onDidDispose teardown registration must remain wrapped in
// try/catch (matches the per-tab tick's existing isolation pattern since
// v0.1.9). A regression that dropped the outer try/catch (e.g. an accidental
// deletion during a refactor of the panel-counter teardown logic) would pass
// IIFE.1-44 because none of them assert the wrap — only the internals. Lock
// it explicitly so the failure-isolation guarantee cannot silently regress.
check(
  'IIFE.45 onDidDispose registration wrapped in try/catch',
  /try\s*\{\s*t\.panelTab\.onDidDispose\s*\(/.test(iife) &&
    /\)\s*\}\s*catch\s*\(\s*e\s*\)\s*\{\s*\}/.test(iife),
);

// --- summary ---------------------------------------------------------------

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
