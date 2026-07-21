#!/usr/bin/env node
/**
 * test-patcher-io.mjs — Patcher pure-I/O regression test.
 *
 * Coverage gap this closes (e2e review HIGH finding): the patcher's I/O
 * surface — stripJsonc / parseJsonc / surgicalSetTopLevelKey /
 * surgicalRemoveTopLevelKey / cmpVerStr — had ZERO automated regression
 * coverage before this file. The npm `test` script ran only writer-state,
 * baked-IIFE-bytes, and aggregation-replica suites; the JSONC editor's
 * actual behavior was untested. A direct consequence: the trailing-comma
 * regex string-boundary bug in stripJsonc (a `,}` substring inside a user
 * settings.json string was silently stripped at parse time, then persisted
 * back to disk via both the surgical-splice and round-trip write paths)
 * shipped uncaught.
 *
 * Approach: invokes `dist/patch.js --self-test-io` (or `npx tsx patch.ts
 * --self-test-io` as a dev fallback), which runs the module-private
 * functions over a fixed fixture corpus INSIDE patch.ts (the functions are
 * not exported — widening the public API for a dev-only need is the wrong
 * trade). The flag emits a JSON array of { name, pass, expected, actual }
 * rows; this file parses the array and asserts every row is pass===true.
 *
 * Fixtures live in patch.ts so they sit beside the functions they cover
 * (reviewers see both in one place); this file stays a thin driver.
 *
 * Run:  node hooks/test-patcher-io.mjs     (requires `npm run build` first;
 *                                            falls back to `npx tsx patch.ts`
 *                                            if dist/ is missing)
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
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

/**
 * Invoke patch.js --self-test-io and return the parsed JSON rows array.
 * Strips nvm lazy-load noise ("Now using node vX.Y.Z…") from stdout.
 */
function getSelfTestRows() {
  let stdout;
  let stderr;
  if (fs.existsSync(DIST_PATCH)) {
    const r = spawnSync(process.execPath, [DIST_PATCH, '--self-test-io'], { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error('--self-test-io failed via dist/patch.js: ' + (r.stderr || ''));
    }
    stdout = r.stdout;
    stderr = r.stderr;
  } else {
    // Dev fallback: no build yet, try tsx.
    const r = spawnSync('npx', ['tsx', 'patch.ts', '--self-test-io'], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(
        'dist/patch.js missing and `npx tsx patch.ts --self-test-io` failed. ' +
          'Run `npm run build` first. stderr: ' +
          (r.stderr || ''),
      );
    }
    stdout = r.stdout;
    stderr = r.stderr;
  }
  if (stderr && stderr.trim()) {
    // Surface unexpected stderr (the self-test path should be silent).
    console.log('  [stderr from --self-test-io]: ' + stderr.trim());
  }
  // Strip a leading "Now using node vX.Y.Z" line that nvm lazy-load emits.
  const cleaned = stdout.replace(/^Now using[^\n]*\n/, '').trim();
  let rows;
  try {
    rows = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('could not parse --self-test-io output as JSON: ' + e.message + '\nraw stdout:\n' + stdout);
  }
  if (!Array.isArray(rows)) {
    throw new Error('--self-test-io did not emit a JSON array; got: ' + typeof rows);
  }
  return rows;
}

let rows;
try {
  rows = getSelfTestRows();
} catch (e) {
  console.log('FAIL  could not obtain self-test rows: ' + e.message);
  process.exit(1);
}

// Drive every row produced by patch.ts. The fixture decisions live in
// patch.ts so they sit beside the functions under test; this file just
// asserts the gate (`pass===true` on every row).
for (const row of rows) {
  check(
    'patcher-io: ' + row.name,
    row.pass === true,
    row.pass ? '' : 'expected=' + row.expected + ' actual=' + row.actual,
  );
}

// Sanity: the corpus MUST cover the critical regression — stripJsonc
// preserving a `,}` substring inside a string. If a future refactor
// accidentally drops that fixture, surface it here instead of letting the
// regression silently ship again.
const hasCommaBraceStringFixture = rows.some((r) => /preserves.*,}.*string/i.test(r.name) && r.pass === true);
check(
  'corpus covers stripJsonc string-boundary regression (,} inside string)',
  hasCommaBraceStringFixture,
  hasCommaBraceStringFixture ? '' : 'expected a "preserves ,} inside string" row in pass state',
);

// Sanity: corpus covers cmpVerStr equal + a>b + a<b (the canonical comparator
// is now the single source of truth — its behavior must be locked).
const cmpRows = rows.filter((r) => /^cmpVerStr/.test(r.name));
check('corpus covers cmpVerStr (>=3 rows)', cmpRows.length >= 3, 'found ' + cmpRows.length);

// v0.2.8 build-integrity gate: dist/patch.js imports three sibling modules
// via relative ESM specifiers (`./src/semver.js`, `./src/jsonc.js`,
// `./src/surgical-json.js`). The build MUST emit all three under dist/src/
// or installCompanion's copy step has nothing to copy → the companion
// auto-heal crashes at module load with ERR_MODULE_NOT_FOUND. Hooks the
// v0.2.4 latent bug at the build layer (separate from the standalone e2e
// in test-standalone-patch.mjs, which hooks it at the runtime layer).
if (fs.existsSync(DIST_PATCH)) {
  const DIST_SRC = path.join(ROOT, 'dist', 'src');
  for (const m of ['semver.js', 'jsonc.js', 'surgical-json.js']) {
    check(
      `dist/src/${m} present (patch.js imports it via ESM)`,
      fs.existsSync(path.join(DIST_SRC, m)),
      'run `npm run build` — dist/src/ missing',
    );
  }
} else {
  // Dev fallback path (tsx): src/*.ts exists in project root, dist/src/*.js
  // is not expected. Skip rather than fail — the standalone e2e covers the
  // built-product check.
  for (const m of ['semver.js', 'jsonc.js', 'surgical-json.js']) {
    check(`dist/src/${m} present — skipped (dev tsx fallback)`, true);
  }
}

console.log('');
if (fail === 0) {
  console.log(`All ${pass} patcher-I/O self-test rows passed.`);
  process.exit(0);
} else {
  console.log(`${pass} passed, ${fail} failed.`);
  process.exit(1);
}
