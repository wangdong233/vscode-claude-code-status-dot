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
      'Run `npm run build` first. stderr: ' + (r.stderr || '')
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
  const pairs = [['(', ')'], ['{', '}'], ['[', ']']];
  let bal = true;
  const detail = [];
  for (const [o, c] of pairs) {
    const oc = (iife.match(new RegExp('\\' + o, 'g')) || []).length;
    const cc = (iife.match(new RegExp('\\' + c, 'g')) || []).length;
    if (oc !== cc) { bal = false; detail.push(o + c + ': ' + oc + '/' + cc); }
  }
  check('IIFE.2  bracket balance () {} []', bal, detail.join(' '));
  try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
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
check('IIFE.18 notify references __ccTitle for message suffix', iife.includes('t.__ccTitle') && iife.includes('["+t.__ccTitle+"]'));

// --- 8. Timer lifecycle (M21) — setInterval captured + onDidDispose clear ---
check('IIFE.19 setInterval captured to var', /var\s+timer\s*=\s*setInterval/.test(iife));
check('IIFE.20 onDidDispose clears timer', /onDidDispose/.test(iife) && /clearInterval\s*\(\s*timer\s*\)/.test(iife));

// --- 9. Inject marker banner + version stamp --------------------------------
check('IIFE.21 banner carries marker+version', /\/\*cc-status-dot-injected:v\d+\.\d+\.\d+\*\//.test(iife));

// --- 10. flashSeq (renamed from `seq`, M8) ----------------------------------
check('IIFE.22 flashSeq drives interrupted flash', /flashSeq\s*%\s*2/.test(iife));
check('IIFE.23 no bare `seq` counter (M8 rename)', !/\bseq\s*%/.test(iife) && !/\bseq\+\+/.test(iife));

// --- summary ---------------------------------------------------------------

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
