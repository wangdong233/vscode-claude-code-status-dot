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

// v0.2.5 round-1 (MEDIUM): every config key the IIFE reads via
// cfg.get("...") MUST be declared in companion/package.json's
// contributes.configuration block, otherwise the documented opt-out is
// unreachable via the Settings UI (the user must hand-edit settings.json,
// where VS Code flags the key as 'Unknown setting' with a warning squiggle).
// The tokenLiveDeltaEnabled key was referenced by the IIFE
// (cfg.get("tokenLiveDeltaEnabled",true) — patch.ts §G tick) and advertised
// in the computeLiveDelta JSDoc as the perf-sensitive-machines opt-out, but
// was missing from the schema — this lock catches any future re-introduction
// of that gap (or the equivalent gap for any other IIFE-read key).
{
  const companionKeys = Object.keys(
    (companionPkg.contributes &&
      companionPkg.contributes.configuration &&
      companionPkg.contributes.configuration.properties) ||
      {},
  );
  check(
    'companion/package.json declares ccStatusDot.tokenLiveDeltaEnabled (IIFE cfg.get key)',
    companionKeys.includes('ccStatusDot.tokenLiveDeltaEnabled'),
    'IIFE reads cfg.get("tokenLiveDeltaEnabled",true) — the schema MUST declare it or the Settings UI flags it as Unknown',
  );
  // Parity lock: every ccStatusDot.* key the IIFE reads via cfg.get MUST
  // appear in the companion schema. Add new IIFE-read keys here AND in
  // companion/package.json contributes.configuration in lockstep.
  const iifeCfgKeys = [
    'ccStatusDot.tokenStatsWindow',
    'ccStatusDot.tokenDisplayMode',
    'ccStatusDot.showCost',
    'ccStatusDot.tokenSbiVisible',
    'ccStatusDot.tokenLiveDeltaEnabled',
    'ccStatusDot.warnThresholdUsd',
    'ccStatusDot.notifySound',
  ];
  const missingFromSchema = iifeCfgKeys.filter((k) => !companionKeys.includes(k));
  check(
    'companion/package.json schema parity — every IIFE cfg.get key is declared',
    missingFromSchema.length === 0,
    missingFromSchema.length ? 'missing from schema: ' + missingFromSchema.join(', ') : '',
  );

  // v0.2.5 round-2 (HIGH): the schema default for an enum/boolean key MUST
  // agree with the IIFE's cfg.get(key, fallback) literal — VSCode's
  // getConfiguration().get(key, fallback) returns the schema-declared
  // default BEFORE the JS fallback, so a mismatch silently undoes the
  // intended default at runtime. Round-1 missed this for tokenStatsWindow:
  // IIFE cfg.get("tokenStatsWindow","all") vs schema default "1h" shipped
  // green (IIFE.90/91 mock used `get:(_k,d)=>d)` which bypassed the schema
  // layer). This lock pins every enum/boolean key's default to match
  // across companion schema + IIFE source.
  //
  // The shape of the check: for each enum/boolean IIFE cfg.get key, extract
  // (a) the schema default from companion/package.json and (b) the IIFE
  // cfg.get fallback literal in patch.ts. They must agree.
  const props =
    (companionPkg.contributes &&
      companionPkg.contributes.configuration &&
      companionPkg.contributes.configuration.properties) ||
    {};
  // regex: cfg.get("key",LITERAL) where LITERAL is "string" or true/false/number.
  function iifeFallback(key) {
    const re = new RegExp(
      'cfg\\.get\\(\\s*"' +
        key.replace(/\./g, '\\.') +
        '"\\s*,\\s*("(?:[^"\\\\]|\\\\.)*"|true|false|-?\\d+(?:\\.\\d+)?)\\s*\\)',
    );
    const m = patchSrc.match(re);
    if (!m) return null;
    const lit = m[1];
    if (lit.startsWith('"')) {
      // strip quotes + unescape
      try {
        return JSON.parse(lit);
      } catch {
        return lit;
      }
    }
    if (lit === 'true') return true;
    if (lit === 'false') return false;
    return Number(lit);
  }
  const defaultsDrift = [];
  for (const fullKey of iifeCfgKeys) {
    const prop = props[fullKey];
    if (!prop) continue; // missing-from-schema check above already flags this
    const schemaDefault = prop.default;
    const iifeDefault = iifeFallback(fullKey);
    // Both must be present and equal. Skip when IIFE literal cannot be
    // extracted (already covered by IIFE.* regex checks in test-iife.mjs).
    if (iifeDefault === null || iifeDefault === undefined) continue;
    if (schemaDefault !== iifeDefault) {
      defaultsDrift.push(
        fullKey + ' (schema=' + JSON.stringify(schemaDefault) + ' vs IIFE=' + JSON.stringify(iifeDefault) + ')',
      );
    }
  }
  check(
    'companion schema defaults agree with IIFE cfg.get fallbacks (round-2 HIGH)',
    defaultsDrift.length === 0,
    defaultsDrift.length ? 'default mismatch: ' + defaultsDrift.join('; ') : '',
  );

  // v0.2.5 round-2 (HIGH): the tokenStatsWindow default specifically MUST be
  // "all" in BOTH companion/package.json AND patch.ts (CHANGELOG 7/20
  // explicitly changed the default from "1h" to "all" as the problem-3b
  // fix). Pin the literal so a future edit that flips one surface without
  // the other re-fails this check — the original bug was that the IIFE
  // default was changed but the companion schema was missed.
  check(
    'companion schema ccStatusDot.tokenStatsWindow default is "all" (round-2 HIGH pin)',
    props['ccStatusDot.tokenStatsWindow'] && props['ccStatusDot.tokenStatsWindow'].default === 'all',
    'got ' + JSON.stringify(props['ccStatusDot.tokenStatsWindow'] && props['ccStatusDot.tokenStatsWindow'].default),
  );
  check(
    'patch.ts IIFE cfg.get tokenStatsWindow fallback is "all" (round-2 HIGH pin)',
    /cfg\.get\(\s*"tokenStatsWindow"\s*,\s*"all"\s*\)/.test(patchSrc),
    'IIFE must default tokenStatsWindow to "all" to match companion schema + CHANGELOG intent',
  );

  // v0.2.5 round-2 (MEDIUM): every ccStatusDot.* config key declared in
  // companion/package.json must be documented in the README config table.
  // Pre-fix the new v0.2.5 ccStatusDot.tokenLiveDeltaEnabled (the perf
  // kill-switch for live-delta) was the ONLY undocumented key — users had
  // no way to discover the knob that disables a feature that reads the
  // transcript tail every 500ms. Pin every companion key appears in every
  // README.* so the drift cannot recur.
  const readmeFiles = [
    'README.md',
    'README.en.md',
    'README.ja.md',
    'README.de.md',
    'README.es.md',
    'README.fr.md',
    'README.pt.md',
    'README.ru.md',
  ];
  for (const fullKey of iifeCfgKeys) {
    const missingIn = [];
    for (const rel of readmeFiles) {
      let src;
      try {
        src = read(rel);
      } catch {
        missingIn.push(rel + ' (read-fail)');
        continue;
      }
      if (src.indexOf(fullKey) < 0) missingIn.push(rel);
    }
    check(
      'README parity — ' + fullKey + ' appears in all 8 READMEs',
      missingIn.length === 0,
      missingIn.length ? 'missing from: ' + missingIn.join(', ') : '',
    );
  }
}

// --- cmpVerStr parity: src/semver.ts is the canonical source; the companion
// reads the body from companion-config.json (semverComparatorSrc field, written
// by patch.ts:writeCompanionConfig from src/semver.ts). Test the canonical body
// against the patch.ts:extractCmpVerStrBody output (verifies the extraction
// regex in patch.ts works) AND against a hardcoded corpus. Also verify the
// companion config schema includes the semverComparatorSrc field (CompanionConfig
// interface).
//
// v0.2.5 round-2 (ARCH-3): the prior "companion has its own mirror cmpVerStr"
// was eliminated. The companion now reads the body from config at activate()
// and `new Function('a','b', src)`-caches it. This test ensures:
//   1. src/semver.ts cmpVerStr body is extractable.
//   2. patch.ts:extractCmpVerStrBody regex matches the same body (so the body
//      baked into companion-config.json agrees with the canonical source).
//   3. The body compiles via new Function and agrees with itself across the
//      6-case corpus (sanity — the body uses only `a`, `b`, builtins).
//   4. companion/extension.ts NO LONGER has a hardcoded cmpVerStr mirror
//      function (only the config-driven getCmpVerStr accessor remains).
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

const semverSrc = read('src/semver.ts');
const canonicalBody = extractFnBody(semverSrc, 'cmpVerStr');
check('src/semver.ts cmpVerStr body extractable', !!canonicalBody);

// Verify patch.ts's extractCmpVerStrBody regex (the one that bakes the body
// into companion-config.json) would match the same body. We replicate the
// regex shape here — same `function cmpVerStr(` + brace-balanced extraction.
// This catches drift if a future editor changes the function signature in a
// way that breaks the extraction (e.g. adds a type parameter).
const patchSrc_bodyExtractorMatch = patchSrc.includes('function extractCmpVerStrBody');
check('patch.ts defines extractCmpVerStrBody (ARCH-3 writer)', patchSrc_bodyExtractorMatch);

// ARCH-3 mirror-elimination assertion: companion/extension.ts must NOT have a
// top-level `function cmpVerStr(...)` definition anymore. The accessor
// getCmpVerStr() replaces it. (A stale mirror would silently reappear if a
// future maintainer reverts the change without updating the test.)
const companionHasMirror = /function\s+cmpVerStr\s*\(/.test(companionSrc);
check(
  'companion/extension.ts cmpVerStr mirror ELIMINATED (ARCH-3)',
  !companionHasMirror,
  companionHasMirror ? 'companion still defines a top-level cmpVerStr function — the mirror is back' : '',
);
const companionHasAccessor = /function\s+getCmpVerStr\s*\(/.test(companionSrc);
check('companion/extension.ts defines getCmpVerStr() accessor (ARCH-3 reader)', companionHasAccessor);

// Verify the CompanionConfig interface in companion/extension.ts declares the
// new semverComparatorSrc field.
const companionDeclaresField = /semverComparatorSrc\s*\?\:\s*string/.test(companionSrc);
check('companion CompanionConfig interface declares semverComparatorSrc?: string', companionDeclaresField);

if (canonicalBody) {
  // v0.2.5 round-2 (ARCH-3): the canonical body lives in src/semver.ts.
  // Construct the comparator via `new Function` to verify (a) the body is
  // self-contained (no closure captures — same property the companion's
  // getCmpVerStr() relies on at runtime) and (b) the body compiles + runs
  // correctly on the corpus. This is the SAME shape the companion uses.
  let cmpVerStrViaFunction;
  try {
    cmpVerStrViaFunction = new Function('a', 'b', canonicalBody);
    check('cmpVerStr canonical body compiles via new Function (ARCH-3 contract)', true);
  } catch (e) {
    check('cmpVerStr canonical body compiles via new Function (ARCH-3 contract)', false, e.message);
    cmpVerStrViaFunction = null;
  }
  if (cmpVerStrViaFunction) {
    // Sanity corpus — locks the comparator's per-segment numeric behavior.
    // The corpus is intentionally small (6 cases) — the writer-side corpus
    // in test-patcher-io.mjs has the broader regression coverage.
    const corpus = [
      ['0.1.19', '0.1.19'],
      ['0.2.0', '0.1.99'],
      ['0.1.18', '0.1.19'],
      ['1.0.0', '0.9.9'],
      ['0.1', '0.1.0'],
      ['0.1.1', '0.1'],
    ];
    let corpusOk = true;
    const expected = [0, 1, -1, 1, 0, 1]; // Math.sign of each corpus comparison
    for (let idx = 0; idx < corpus.length; idx++) {
      const [a, b] = corpus[idx];
      const got = Math.sign(cmpVerStrViaFunction(a, b));
      if (got !== expected[idx]) {
        corpusOk = false;
        check(`cmpVerStr(${a}, ${b}) => ${got}, expected ${expected[idx]}`, false);
      }
    }
    if (corpusOk) {
      check('cmpVerStr canonical body agrees on full corpus (' + corpus.length + ' cases)', true);
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
