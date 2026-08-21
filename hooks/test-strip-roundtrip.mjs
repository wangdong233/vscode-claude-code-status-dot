#!/usr/bin/env node
/**
 * test-strip-roundtrip.mjs — inject→strip lifecycle lockstep pin (v0.5.47).
 *
 * Review round-1 MEDIUM: stripIifeInPlace's segA/segB patterns had drifted
 * from the emitted replA/replB forms TWICE (segB dead since v0.5.33, segA
 * dead since the v0.5.44 Layer-1a ternary) with ZERO test coverage — silently
 * killing the stale-IIFE + missing-.bak recovery path. This test gates dist
 * freshness (round-2 [3]) and spawns the patcher's --self-test-strip
 * subcommand, which splices a pristine scaffold with the EXACT production
 * builders (buildReplA/buildReplB/buildReplC over the real buildIIFE output,
 * plus a legacy v0.5.44-46 comma-form fixture) and asserts stripIifeInPlace
 * recovers the pristine scaffold BYTE-FOR-BYTE.
 *
 * Run:  node hooks/test-strip-roundtrip.mjs   (after `npm run build`)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PATCH = path.join(ROOT, 'dist', 'patch.js');

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

// v0.5.47 round-2 [3]: STALE-DIST GATE — the drift-detector must never
// validate a stale build (patch.ts edited after the last `npm run build`
// would false-green: the compiled builders and patterns are always mutually
// in lockstep, so only a FRESH build exercises the current source). Mirrors
// test-version-sync.mjs's companion dist drift-gate rationale (v0.2.8).
const srcMtime = fs.statSync(path.join(ROOT, 'patch.ts')).mtimeMs;
const distMtime = fs.statSync(PATCH).mtimeMs;
check(
  'STRIP.0 dist/patch.js is FRESH (not older than patch.ts — run npm run build)',
  distMtime >= srcMtime,
  'patch.ts mtime ' +
    new Date(srcMtime).toISOString() +
    ' > dist/patch.js mtime ' +
    new Date(distMtime).toISOString() +
    ' — the strip round-trip would validate a STALE build (false green)',
);

const r = spawnSync(process.execPath, [PATCH, '--self-test-strip'], { encoding: 'utf8' });
const out = (r.stdout || '') + (r.stderr || '');

check(
  'STRIP.1 dist/patch.js --self-test-strip exits 0 (inject→strip byte-exact round trip incl. Anchor C + legacy comma fixture)',
  r.status === 0,
  'exit=' + r.status + ' output=' + out.slice(0, 400),
);
check(
  'STRIP.2 the subcommand reports the OK line (not a silent 0)',
  out.includes('[cc-status-dot][self-test-strip] OK'),
  out.slice(0, 200),
);

console.log('');
if (fail === 0) {
  console.log(`All ${pass} strip-roundtrip checks passed.`);
  process.exit(0);
} else {
  console.log(`${pass} passed, ${fail} failed.`);
  process.exit(1);
}
