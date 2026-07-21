#!/usr/bin/env node
/**
 * test-standalone-patch.mjs — Standalone patch.js ESM-import regression test.
 *
 * Coverage gap this closes (v0.2.8 fix): the runtime patch.js imports three
 * sibling modules via relative ESM specifiers (`./src/semver.js`,
 * `./src/jsonc.js`, `./src/surgical-json.js`) — a v0.2.4 architecture split.
 * Node's ESM loader resolves these against patch.js's own URL BEFORE any
 * code runs, so if patch.js is copied somewhere WITHOUT its src/ siblings
 * the process crashes at module load with ERR_MODULE_NOT_FOUND — exactly
 * what the companion auto-heal path does:
 *
 *     companion/extension.ts → cp.spawn(node, [INSTALL_DIR/patch.js,
 *                                              '--patch-only'])
 *
 * installCompanion() copies patch.js → INSTALL_DIR/patch.js. v0.2.4-v0.2.7
 * forgot to also copy dist/src/*.js → INSTALL_DIR/src/, so the first time
 * the companion tried to re-patch after a CC auto-update, it crashed with
 * ERR_MODULE_NOT_FOUND and surfaced a generic "auto-patch failed" message.
 * Latent since v0.2.4; exposed when CC auto-updated.
 *
 * v0.2.8 round-1 (MEDIUM) rewrite: the PRIOR version of this test manually
 * fs.copyFileSync'd patch.js + src/*.js into a tmp dir, which BYPASSED
 * installCompanion entirely. That meant the test passed on v0.2.7 too (where
 * installCompanion step 1a was missing) — the "v0.2.7 FAIL / v0.2.8 PASS"
 * claim was inaccurate and the test was not a real regression gate for the
 * install path. The new version drives the REAL install path via the
 * `--install-companion-runtime` dev subcommand + CCSD_INSTALL_DIR=<tmp> env
 * override — so a future regression that drops step 1a from
 * installCompanionRuntimeFiles() fails this test directly.
 *
 * Approach:
 *   1. Build gate — dist/patch.js + dist/src/*.js exist.
 *   2. Set CCSD_INSTALL_DIR=<tmp>; spawn `node dist/patch.js
 *      --install-companion-runtime`. This runs installCompanionRuntimeFiles()
 *      against the tmp dir (real install path, no `code --install-extension`).
 *   3. Assert tmp/patch.js + tmp/src/{semver,jsonc,surgical-json}.js all
 *      exist (THIS is the v0.2.7 regression gate — step 1a missing would
 *      fail here).
 *   4. Spawn `node <tmp>/patch.js --status` (without CCSD_INSTALL_DIR — the
 *      standalone patch.js must run from any cwd and resolve its src/*.js
 *      siblings via its own URL, not via env). Assert exit 0 + no
 *      ERR_MODULE_NOT_FOUND + normal cc-status-dot output.
 *   5. Inverse regression: remove <tmp>/src/, re-run, assert it DOES crash
 *      — proves the test is not vacuous (catches a future patch.js that
 *      stopped importing src/ entirely).
 *
 * Run:  node hooks/test-standalone-patch.mjs     (requires `npm run build`)
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST_PATCH = path.join(ROOT, 'dist', 'patch.js');
const DIST_SRC = path.join(ROOT, 'dist', 'src');
const PATCH_TS = path.join(ROOT, 'patch.ts');

// v0.2.8 round-3 MEDIUM (regression-round-2 finding): previously this list was
// hardcoded as `['semver.js', 'jsonc.js', 'surgical-json.js']`, which mirrored
// patch.ts's SRC_MODULES but was NOT pinned to it. The standalone e2e uses this
// list to decide which files installCompanionRuntimeFiles MUST have copied — if
// a future change adds a 4th `import { foo } from "./src/foo.js"` + a matching
// SRC_MODULES entry, contract-sync (§SRC_MODULES) would pass, but this test
// would silently keep checking only the original trio, re-arming the exact
// v0.2.7 regression shape (installCompanion skips the new module's copy →
// ERR_MODULE_NOT_FOUND on next companion re-patch). Extract from patch.ts
// source at runtime using the SAME regex shape contract-sync uses (single
// source of truth): `/const\s+SRC_MODULES\s*=\s*\[([^\]]+)\]/` then scan for
// double-quoted .js basenames. If the extraction fails (patch.ts shape drift),
// fail loudly with an actionable message instead of silently falling back to a
// stale hardcoded list.
function extractSrcModulesFromPatchTs() {
  const src = fs.readFileSync(PATCH_TS, 'utf8');
  const arrMatch = src.match(/const\s+SRC_MODULES\s*=\s*\[([^\]]+)\]/);
  if (!arrMatch) return null;
  const out = [];
  const re = /"([^"]+\.js)"/g;
  let m;
  while ((m = re.exec(arrMatch[1])) !== null) out.push(m[1]);
  return out.length > 0 ? out : null;
}
const SRC_MODULES = extractSrcModulesFromPatchTs();
if (!SRC_MODULES) {
  console.log(
    'FAIL  could not extract SRC_MODULES from patch.ts (shape drift?). ' +
      'Check `const SRC_MODULES = [...]` in patch.ts and update the regex in test-standalone-patch.mjs.',
  );
  process.exit(1);
}

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

// Build gate — the test is meaningless without dist/patch.js + dist/src/.
check('dist/patch.js exists (run `npm run build` first)', fs.existsSync(DIST_PATCH));
check(
  'dist/src/ has all three ESM-import sibling modules',
  SRC_MODULES.every((m) => fs.existsSync(path.join(DIST_SRC, m))),
);
if (!fs.existsSync(DIST_PATCH) || !SRC_MODULES.every((m) => fs.existsSync(path.join(DIST_SRC, m)))) {
  console.log('\nFAIL  standalone test requires a successful build.');
  process.exit(1);
}

// Subcommand gate — the --install-companion-runtime entry point must exist in
// the compiled patch.js. (Guards against running this test against an older
// dist/patch.js that lacks the v0.2.8 round-1 subcommand — fail loudly with
// an actionable message instead of a confusing spawn failure.)
const patchJsText = fs.readFileSync(DIST_PATCH, 'utf8');
check(
  'dist/patch.js defines --install-companion-runtime (v0.2.8 round-1 subcommand)',
  /--install-companion-runtime/.test(patchJsText),
  'rebuild dist/patch.js via `npm run build` after the patch.ts subcommand addition',
);
if (!/--install-companion-runtime/.test(patchJsText)) {
  console.log('\nFAIL  standalone test requires the --install-companion-runtime subcommand.');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsd-standalone-'));
try {
  // 1. Drive the REAL install path: invoke installCompanionRuntimeFiles()
  //    against a sandbox tmp dir via CCSD_INSTALL_DIR. This is the actual
  //    install code path — if a future regression removes the src/*.js copy
  //    step, this test catches it directly (the prior version of the test
  //    mirror-copied the files itself and could not catch the regression).
  const env = { ...process.env, CCSD_INSTALL_DIR: tmp };
  const rInstall = spawnSync(process.execPath, [DIST_PATCH, '--install-companion-runtime'], {
    encoding: 'utf8',
    timeout: 15000,
    env,
  });
  const installCombined = (rInstall.stdout || '') + (rInstall.stderr || '');
  check(
    'installCompanionRuntimeFiles via CCSD_INSTALL_DIR=<tmp> exits 0',
    rInstall.status === 0,
    'status=' + rInstall.status + ' stderr0=' + (installCombined.split('\n')[0] || ''),
  );

  // 2. Assert installCompanion ACTUALLY copied the runtime files. This is the
  //    core v0.2.7 regression gate — missing step 1a would fail here.
  check(
    'INSTALL_DIR/patch.js copied by installCompanionRuntimeFiles',
    fs.existsSync(path.join(tmp, 'patch.js')),
    'installCompanion step 1 (patch.js copy) did not run',
  );
  check(
    'INSTALL_DIR/src/ created by installCompanionRuntimeFiles',
    fs.existsSync(path.join(tmp, 'src')),
    'installCompanion step 1a (src/ dir) did not run',
  );
  for (const m of SRC_MODULES) {
    check(
      `INSTALL_DIR/src/${m} copied by installCompanionRuntimeFiles (v0.2.7 regression gate)`,
      fs.existsSync(path.join(tmp, 'src', m)),
      'installCompanion step 1a missed src/' + m + ' — the v0.2.7 bug is back',
    );
  }
  // companion-config.json is step 1b — also worth pinning since it's how the
  // companion reads the patcher version (and is part of the same install path).
  check(
    'INSTALL_DIR/companion-config.json written by installCompanionRuntimeFiles',
    fs.existsSync(path.join(tmp, 'companion-config.json')),
    'installCompanion step 1b (writeCompanionConfig) did not run',
  );

  // Bail early if the install step itself failed — the standalone run below
  // cannot succeed without the files in place, and the per-file assertions
  // above already named the exact missing piece.
  const installOk =
    rInstall.status === 0 &&
    fs.existsSync(path.join(tmp, 'patch.js')) &&
    SRC_MODULES.every((m) => fs.existsSync(path.join(tmp, 'src', m)));
  if (!installOk) {
    console.log('\nFAIL  install path did not produce the expected files; standalone run skipped.');
    process.exit(1);
  }

  // 3. Forward regression: standalone patch.js --status MUST exit 0 and emit
  //    normal status output. Spawn WITHOUT CCSD_INSTALL_DIR so the standalone
  //    patch.js uses the production INSTALL_DIR resolution (~/.claude/...) —
  //    this verifies the ESM loader resolves src/*.js via patch.js's own URL,
  //    which is the actual contract the companion relies on at runtime. The
  //    --status path is read-only and does not mutate the production
  //    INSTALL_DIR.
  const r = spawnSync(process.execPath, [path.join(tmp, 'patch.js'), '--status'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  const combined = (r.stdout || '') + (r.stderr || '');
  check('standalone patch.js --status exits 0', r.status === 0, 'got status=' + r.status);
  check(
    'no ERR_MODULE_NOT_FOUND when src/ is present',
    !/ERR_MODULE_NOT_FOUND/.test(combined),
    combined.split('\n').find((l) => /ERR_MODULE_NOT_FOUND/.test(l)) || '',
  );
  check(
    'emits normal cc-status-dot status output',
    /\[cc-status-dot\]/.test(r.stdout || ''),
    'first line: ' + (r.stdout || '').split('\n')[0],
  );

  // 4. Inverse regression: remove src/, re-run, assert it DOES crash —
  //    proves the test would catch a future regression that drops the
  //    installCompanion src/ copy. Without this, the forward assertion could
  //    silently vacuate (e.g. patch.js stopped importing src/ entirely).
  fs.rmSync(path.join(tmp, 'src'), { recursive: true, force: true });
  const r2 = spawnSync(process.execPath, [path.join(tmp, 'patch.js'), '--status'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  const combined2 = (r2.stdout || '') + (r2.stderr || '');
  check(
    'without src/ standalone patch.js DOES crash (test is meaningful)',
    r2.status !== 0 && /ERR_MODULE_NOT_FOUND/.test(combined2),
    'status=' + r2.status + ' stderr0=' + (combined2.split('\n')[0] || ''),
  );
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

console.log('');
if (fail === 0) {
  console.log(`All ${pass} standalone-patch assertions passed.`);
  process.exit(0);
} else {
  console.log(`${pass} passed, ${fail} failed.`);
  process.exit(1);
}
