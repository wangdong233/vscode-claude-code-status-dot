#!/usr/bin/env node
/**
 * test-version-sync.mjs — Version-constant sync check.
 *
 * Architecture review (HIGH finding): six version-like constants live across
 * two repos with no compile-time or test-time guarantee they move together:
 *
 *   patch.ts:        INJECT_VERSION  = "v0.1.19"  (literal, baked into IIFE)
 *   patch.ts:        HOOK_VERSION    = "v0.1.14"  (literal, baked into hook banner)
 *   patch.ts:        PATCHER_VERSION = (reads package.json at runtime)
 *   companion/...:   MIN_PATCHER_VERSION = "0.1.19" (literal)
 *   companion/...:   COMPANION_VERSION  = (reads companion/package.json at runtime)
 *   package.json:    version = "0.1.19"  (canonical SSOT)
 *
 * A future bump of package.json that forgets to bump INJECT_VERSION or
 * MIN_PATCHER_VERSION silently breaks the patcher↔companion handshake
 * (companion sees staleVersion=older, decides "stale" → re-execs old
 * patch.js logic against new CC; or the IIFE idempotency gate `ver===
 * INJECT_VERSION → skip` masks a body drift).
 *
 * This test asserts the cross-file invariants that CAN be checked statically:
 *
 *   1. patch.ts INJECT_VERSION literal === `v${package.json.version}`.
 *   2. companion MIN_PATCHER_VERSION literal === package.json.version
 *      (without the `v` prefix — companion's comparator works on bare
 *      semver strings).
 *   3. companion injectVersion() fallback literal === `v${package.json.version}`.
 *   4. HOOK_VERSION is independent (writer's own contract) — but MUST be
 *      parseable and present. (A separate test in test-iife.mjs locks the
 *      IIFE-banner hash; this test locks the version-stamp half.)
 *
 * Run:  node hooks/test-version-sync.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// --- canonical SSOT ---
const pkg = JSON.parse(read('package.json'));
const pkgVersion = pkg.version; // e.g. "0.1.19"
check('package.json has a X.Y.Z version', /^\d+\.\d+\.\d+$/.test(pkgVersion), 'got ' + pkgVersion);

// --- patch.ts INJECT_VERSION literal ---
const patchSrc = read('patch.ts');
const injectVerMatch = patchSrc.match(/const\s+INJECT_VERSION\s*=\s*"v(\d+\.\d+\.\d+)"/);
check('patch.ts defines INJECT_VERSION literal', !!injectVerMatch);
if (injectVerMatch) {
  check(
    `patch.ts INJECT_VERSION (v${injectVerMatch[1]}) === package.json version (${pkgVersion})`,
    injectVerMatch[1] === pkgVersion,
  );
}

// --- patch.ts HOOK_VERSION literal (independent but must be present + parseable) ---
const hookVerMatch = patchSrc.match(/const\s+HOOK_VERSION\s*=\s*"(v\d+\.\d+\.\d+)"/);
check('patch.ts defines HOOK_VERSION literal', !!hookVerMatch);
if (hookVerMatch) {
  // No cross-equality asserted here — HOOK_VERSION is the writer-contract
  // version and bumps independently from the IIFE INJECT_VERSION. The
  // cc-status.js banner hash test (test-cc-status.js / IIFE checks) handles
  // hook-body drift separately.
  check(`patch.ts HOOK_VERSION (${hookVerMatch[1]}) is a v-prefixed X.Y.Z`, /^v\d+\.\d+\.\d+$/.test(hookVerMatch[1]));
}

// --- companion MIN_PATCHER_VERSION literal === package.json.version ---
const companionSrc = read('companion/extension.ts');
const minPatcherMatch = companionSrc.match(/const\s+MIN_PATCHER_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/);
check('companion defines MIN_PATCHER_VERSION literal', !!minPatcherMatch);
if (minPatcherMatch) {
  check(
    `companion MIN_PATCHER_VERSION (${minPatcherMatch[1]}) === package.json.version (${pkgVersion})`,
    minPatcherMatch[1] === pkgVersion,
  );
}

// --- companion injectVersion() fallback === `v${package.json.version}` ---
// The companion reads companion-config.json at runtime, but its hardcoded
// fallback literal MUST match the current patcher version (otherwise an
// install with a missing/stale config silently uses an outdated threshold).
// Allow multiline function body AND a TS return-type annotation between the
// `)` and the `{`.
const injectVerFallbackMatch = companionSrc.match(
  /function\s+injectVersion\([^)]*\)(?::[^{]*)?{[\s\S]*?\?\?\s*"v(\d+\.\d+\.\d+)"/,
);
check('companion defines injectVersion() fallback literal', !!injectVerFallbackMatch);
if (injectVerFallbackMatch) {
  check(
    `companion injectVersion() fallback (v${injectVerFallbackMatch[1]}) === package.json.version (${pkgVersion})`,
    injectVerFallbackMatch[1] === pkgVersion,
  );
}

// --- companion/package.json version (companion releases can decouple from
// the patcher's package.json version, but the v0.2.x line currently keeps
// them in lockstep — flag if they drift so the maintainer makes an
// intentional choice rather than an accidental one) ---
const companionPkg = JSON.parse(read('companion/package.json'));
check(
  `companion/package.json version (${companionPkg.version}) is a valid X.Y.Z`,
  /^\d+\.\d+\.\d+$/.test(companionPkg.version),
  'got ' + companionPkg.version,
);

// --- cmpVerStr mirror parity: patch.ts and companion must implement the
// same per-segment numeric comparison. Extract the two function bodies and
// run a shared test corpus through them by re-evaluating their bodies in a
// shared sandbox. (DRY guard — the architecture review's "triplicated
// comparator" finding is closed at CI time by this assertion.)
function extractFnBody(src, fnName) {
  // Match `function <fnName>(a, b) { ... }` (non-greedy, balanced via simple
  // brace scan). The functions in question are short and brace-balanced.
  const startIdx = src.indexOf('function ' + fnName + '(');
  if (startIdx === -1) return null;
  let i = src.indexOf('{', startIdx);
  if (i === -1) return null;
  let depth = 1;
  i += 1;
  const start = i;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    i += 1;
  }
  return src.slice(start, i - 1);
}

const patchCmpVerStrBody = extractFnBody(patchSrc, 'cmpVerStr');
const companionCmpVerStrBody = extractFnBody(companionSrc, 'cmpVerStr');
check('patch.ts cmpVerStr body extractable', !!patchCmpVerStrBody);
check('companion cmpVerStr body extractable', !!companionCmpVerStrBody);
if (patchCmpVerStrBody && companionCmpVerStrBody) {
  // Construct two side-by-side evaluators. The bodies reference `cmpSemver`
  // (patch.ts's wrapper delegates to it) — handle both the inline body and
  // the wrapper form by giving the wrapper access to cmpSemver too.
  const patchCmpSemverBody = extractFnBody(patchSrc, 'cmpSemver');
  // Build a synthetic module that defines both implementations side by side.
  const sandboxSrc = `
    ${patchCmpSemverBody ? 'function cmpSemver(a, b) {' + patchCmpSemverBody + '}' : ''}
    function patchCmpVerStr(a, b) { ${patchCmpVerStrBody} }
    function companionCmpVerStr(a, b) { ${companionCmpVerStrBody} }
    return { patchCmpVerStr, companionCmpVerStr };
  `;
  let sandbox;
  try {
    sandbox = new Function(sandboxSrc)();
  } catch (e) {
    check('cmpVerStr sandbox compiles', false, e.message);
    sandbox = null;
  }
  if (sandbox) {
    check('cmpVerStr sandbox compiles', true);
    const corpus = [
      ['0.1.19', '0.1.19'],
      ['0.2.0', '0.1.99'],
      ['0.1.18', '0.1.19'],
      ['1.0.0', '0.9.9'],
      ['0.1', '0.1.0'],
      ['0.1.1', '0.1'],
    ];
    let corpusOk = true;
    for (const [a, b] of corpus) {
      const p = sandbox.patchCmpVerStr(a, b);
      const c = sandbox.companionCmpVerStr(a, b);
      if (Math.sign(p) !== Math.sign(c)) {
        corpusOk = false;
        check(`cmpVerStr patch.ts vs companion agree on (${a}, ${b})`, false, 'patch.ts=' + p + ' companion=' + c);
      }
    }
    if (corpusOk) {
      check('cmpVerStr patch.ts vs companion agree on full corpus (' + corpus.length + ' cases)', true);
    }
  }
}

console.log('');
if (fail === 0) {
  console.log(`All ${pass} version-sync checks passed.`);
  process.exit(0);
} else {
  console.log(`${pass} passed, ${fail} failed.`);
  process.exit(1);
}
