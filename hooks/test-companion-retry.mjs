#!/usr/bin/env node
/**
 * test-companion-retry.mjs — v0.5.53 behavioral gate for the auto-patch
 * retry policy + companion wiring pins.
 *
 * Part A tests the REAL compiled module (companion/dist/retry-policy.js —
 * `npm run build` in companion/ first): backoff math, shouldRetry decisions,
 * classifyClose classes, Detail composition.
 * Part B source-pins the extension.ts wiring (close handler binds signal;
 * ok-only recording; toast gated on attempts>=MAX; last-failure.log path) and
 * the patch.ts hardening (execFileSync timeout; stall markers before the
 * gate/write) — the repo's established source-scan-gate pattern.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RP = await import(path.resolve(ROOT, 'companion', 'dist', 'retry-policy.js'));
const extSrc = fs.readFileSync(path.join(ROOT, 'companion', 'extension.ts'), 'utf8');
const patchSrc = fs.readFileSync(path.join(ROOT, 'patch.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (detail ? '   ' + detail : ''));
  }
}

// KA.0-style dist-freshness gate: a src edit without `npm run build` would
// silently test STALE policy bytes.
{
  const rpSrcM = fs.statSync(path.join(ROOT, 'companion', 'retry-policy.ts')).mtimeMs;
  const rpDistM = fs.statSync(path.join(ROOT, 'companion', 'dist', 'retry-policy.js')).mtimeMs;
  const extSrcM = fs.statSync(path.join(ROOT, 'companion', 'extension.ts')).mtimeMs;
  const extDistM = fs.statSync(path.join(ROOT, 'companion', 'dist', 'extension.js')).mtimeMs;
  check(
    'RP.0 dist fresh: retry-policy.js AND extension.js >= their srcs (rebuild companion after ANY edit)',
    rpDistM >= rpSrcM && extDistM >= extSrcM,
    `rp: dist=${rpDistM} src=${rpSrcM}; ext: dist=${extDistM} src=${extSrcM}`,
  );
}

// --- Part A: pure module ---
const T0 = 1_000_000;
{
  check(
    'T0a backoff ladder 30s/60s/120s/240s/240s-cap',
    [RP.backoffDelayMs(1), RP.backoffDelayMs(2), RP.backoffDelayMs(3), RP.backoffDelayMs(4), RP.backoffDelayMs(9)].join(
      ',',
    ) === [30000, 60000, 120000, 240000, 240000].join(','),
  );
  check(
    'T0b shouldRetry: ok → wait forever',
    RP.shouldRetry({ status: 'ok', attempts: 1, lastAttemptMs: 0 }, T0) === 'wait',
  );
  check('T0c undefined → wait (tick must not auto-run)', RP.shouldRetry(undefined, T0) === 'wait');
  const f1 = { status: 'failed', attempts: 1, lastAttemptMs: T0 };
  check('T0d failed+inside backoff → wait', RP.shouldRetry(f1, T0 + 29999) === 'wait');
  check('T0e failed+backoff elapsed → run', RP.shouldRetry(f1, T0 + 30000) === 'run');
  const f5 = { status: 'failed', attempts: RP.RETRY_MAX_ATTEMPTS, lastAttemptMs: T0 };
  check('T0f exhausted → done', RP.shouldRetry(f5, T0 + 10 * 60_000) === 'done');
  check('T0g MAX=5', RP.RETRY_MAX_ATTEMPTS === 5);
}
{
  const c0 = RP.classifyClose(0, null, false);
  const cT = RP.classifyClose(null, 'SIGTERM', true);
  const cK = RP.classifyClose(null, 'SIGKILL', false);
  const cE = RP.classifyClose(1, null, false);
  check('T0h classify: exit0→ok', c0.kind === 'ok');
  check('T0i classify: SIGTERM+timer→timeout(transient)', cT.kind === 'timeout' && /TRANSIENT/i.test(cT.firstLine));
  check(
    'T0j classify: SIGKILL ext→external-signal',
    cK.kind === 'external-signal' && /no error output/i.test(cK.firstLine),
  );
  check('T0k classify: code1→hard-error', cE.kind === 'hard-error');
  const d = RP.composeFailureDetail(cT, '', 'log1\nbacked up → extension.js.bak');
  check(
    'T0l Detail: class-first + signal note + stdout tail',
    d.startsWith(cT.firstLine) && /empty stderr \+ signal death/.test(d) && /backed up/.test(d),
    d.slice(0, 120),
  );
  const dHard = RP.composeFailureDetail(cE, '[cc-status-dot][ERROR] boom', 'x');
  check(
    'T0m Detail hard-error: stderr tail present, no signal note',
    /boom/.test(dHard) && !/empty stderr/.test(dHard),
  );
}

// --- Part B: wiring pins (source-scan gates) ---
check('W.1 close handler binds (code, signal)', /child\.on\("close", \(code, signal\) =>/.test(extSrc));
check(
  'W.2 timerFired tracked and threaded into PatchResult',
  /let timerFired = false;/.test(extSrc) &&
    /closeSignal: signal,\s*timerFired,\s*exitCode: code,\s*anchorBMissing/.test(extSrc),
);
{
  // R1: W.3 must DISCRIMINATE — assert ok-recording sits AFTER the
  // post-verify marker-absent block (moving it before post-verify must fail).
  const pvIdx = extSrc.indexOf('postState === "absent"');
  const pvEnd = extSrc.indexOf('ownPatchArmed = true;');
  // (the FIRST ok-set is the legit fresh-path recording; the post-VERIFY one
  // must sit after the marker-absent block)
  const okIdx = extSrc.indexOf('dirStates.set(extDir, { status: "ok"', pvIdx);
  check(
    'W.3 ok recorded only AFTER the post-verify marker-absent block',
    /dirStates\.set\(extDir, \{ status: "ok"/.test(extSrc) && okIdx > pvIdx && okIdx < pvEnd,
    `ok=${okIdx} pv=${pvIdx} arm=${pvEnd}`,
  );
}
check(
  'W.4 failure recorded with attempts+1 and last-failure.log appended',
  /status: "failed",\s*attempts:/.test(extSrc) && /appendLastFailure\(/.test(extSrc),
);
check(
  'W.5 toast gated on attempts >= RETRY_MAX_ATTEMPTS (retry-then-toast)',
  /attempts >= RETRY_MAX_ATTEMPTS/.test(extSrc) &&
    /retryClassifyClose\(/.test(extSrc) &&
    /retryComposeDetail\(/.test(extSrc),
);
check(
  'W.6 tick: missing-entry→run fallback + shouldRetry (Map, not Set.has) — mid-session CC updates stay caught',
  /!states \|\| !states\.has\(curDir \?\? ""\)\s*\? "run"\s*: retryShouldRetry\(states\.get\(curDir \?\? ""\), Date\.now\(\)\)/.test(
    extSrc,
  ) && !/ran\.has\(curDir\)/.test(extSrc),
);
check(
  'W.6b fresh-path records ok (steady state one lookup) + tick-side convergence for self-healed failed entries',
  /if \(state === "fresh"\) \{[\s\S]{0,900}?dirStates\.set\(extDir, \{ status: "ok"/.test(extSrc) &&
    /if \(states && dec === "run"\) \{[\s\S]{0,400}?st\.status === "failed" && ccPatchState\(curDir \?\? ""\) === "fresh"[\s\S]{0,200}?status: "ok"/.test(
      extSrc,
    ),
);
check(
  'W.9 marker-absent toast gated on attempts>=MAX (retry-then-toast symmetry)',
  /postState === "absent"[\s\S]{0,2200}?attempts \?\? 0\) >= RETRY_MAX_ATTEMPTS/.test(extSrc),
);
check(
  'W.10 real exit code threaded (exitCode in PatchResult + classifyClose + log)',
  /exitCode: number \| null;/.test(extSrc) &&
    /retryClassifyClose\(result\.exitCode,/.test(extSrc) &&
    /exitCode: result\.exitCode,/.test(extSrc) &&
    /exitCode: code,/.test(extSrc),
);
check(
  'W.7 last-failure.log lives under INSTALL_DIR with a 10-entry ring (v0.6 widened)',
  /path\.join\(INSTALL_DIR, "last-failure\.log"\)/.test(extSrc) && /ring\.length > 10/.test(extSrc),
);
check(
  'W.8 marker-absent post-verify branch also records a failure for retry',
  extSrc.indexOf('postState === "absent"') > 0 &&
    extSrc
      .slice(extSrc.indexOf('postState === "absent"'), extSrc.indexOf('postState === "absent"') + 900)
      .includes('status: "failed"'),
);
check(
  'P.1 assertCompiles execFileSync has timeout: 10000',
  /execFileSync\(process\.execPath, \["--check", tmp\], \{[\s\S]{0,900}?timeout: 10000,/.test(patchSrc),
);
{
  // v0.6: TWO call sites (legacy injectFresh retired; injectSeamFresh live).
  // Pin the LIVE one (seam) and its write marker ordering.
  const gateIdx = patchSrc.indexOf('assertCompiles(next, "patched extension.js (seam prelude)")');
  const markerIdx = patchSrc.indexOf('log("syntax gate (node --check)…")');
  const writeMarkerIdx = patchSrc.indexOf('log("writing extension.js…")');
  const writeIdx = patchSrc.indexOf('writeAtomicSync(extJs, next)');
  check(
    'P.2 stall markers precede the seam assertCompiles and writeAtomicSync',
    gateIdx > 0 && markerIdx > 0 && markerIdx < gateIdx && writeMarkerIdx > 0 && writeMarkerIdx < writeIdx,
    `gate=${gateIdx} marker=${markerIdx} writeMarker=${writeMarkerIdx} write=${writeIdx}`,
  );
}

if (fail === 0) console.log(`All ${pass} companion-retry checks passed.`);
else {
  console.log(`${pass} passed, ${fail} failed.`);
  process.exit(1);
}
