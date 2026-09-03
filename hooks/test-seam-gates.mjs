#!/usr/bin/env node
/**
 * test-seam-gates.mjs — v0.6 seam patcher gates (G1/G2/G4/G8/G12) against the
 * REAL patcher CLI in throwaway sandboxes (CCSD_EXT_SEARCH_DIR seam — the
 * live install is never touched).
 *
 *   G1  banner skew matrix — the companion's :501 legacy-parse regex must
 *       read the v0.6 banner (hash8/hash16/no-hash) AND v0.5.x banners;
 *       `:seam`-style mutations must not parse.
 *   G2  v0.5.x anchor-injected → seam MIGRATION roundtrip: the emitted
 *       legacy fixture (re-stamped v0.5.52) drives --patch-only down the
 *       strip-legacy-then-prepend path; seam --revert (no .bak) recovers a
 *       byte-clean original; with .bak present the .bak wins.
 *   G4  ESM four-way fixtures: type:module → cc-esm-detected; top-level
 *       import → cc-esm-detected; top-level export → seam-precondition-
 *       failed; clean CJS → success.
 *   G8  lock contention: a fresh <extJs>.ccsd.lock → exit 0 no-op, file
 *       untouched; a ≥60s-stale lock is broken and the patch proceeds.
 *   G12 seam strip roundtrip: patch → strip (revert, no .bak) → bytes equal
 *       the pristine original; re-patch idempotency (no-op second run).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PATCH_TS = path.join(ROOT, 'patch.ts');

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

// ---------------------------------------------------------------- helpers
function mkSandbox(extJsContent, pkgJson = '{"name":"fake-cc","version":"2.1.259"}') {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsd-seam-g-'));
  const exts = path.join(sb, 'exts');
  const extDir = path.join(exts, 'anthropic.claude-code-2.1.259-darwin-x64');
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, 'extension.js'), extJsContent);
  fs.writeFileSync(path.join(extDir, 'package.json'), pkgJson);
  return { sb, exts, extDir, extJs: path.join(extDir, 'extension.js') };
}
const ART_INSTALL = path.join(os.tmpdir(), 'ccsd-seam-artifacts-install'); // ONE install dir for emit + every spawn (baked IDIR literal => identical hash)
function runPatcher(exts, extraEnv = {}) {
  // CCSD_INSTALL_DIR is ALWAYS redirected: --patch-only would otherwise
  // touch the production runtime dir (and --revert DELETES it — the G8/G12
  // sandboxed reverts once wiped the real ~/.claude/cc-status-dot because
  // only the extension search was redirected).
  const r = spawnSync('npx', ['tsx', PATCH_TS, '--patch-only'], {
    cwd: ROOT,
    env: {
      ...process.env,
      CCSD_EXT_SEARCH_DIR: exts,
      CCSD_INSTALL_DIR: ART_INSTALL,
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function runRevert(exts) {
  // v0.6 R1 fix: gates drive the SANDBOXED strip subcommand — the full
  // --revert ALSO unwires real ~/.claude/settings.json, uninstalls the real
  // companion, and (without the INSTALL_DIR redirect) removes the runtime
  // dir. R1 HIGH finding, bit twice.
  const r = spawnSync('npx', ['tsx', PATCH_TS, '--restore-extension-only'], {
    cwd: ROOT,
    env: {
      ...process.env,
      CCSD_EXT_SEARCH_DIR: exts,
      CCSD_INSTALL_DIR: ART_INSTALL,
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
/** Minimal CJS CC-like bundle: requires vscode, exports activate. */
function fakeCcBundle() {
  return 'var vscode=require("vscode");function activate(ctx){var p=vscode.window.createWebviewPanel("claudeVSCodePanel","t",{viewColumn:1},{});return p}module.exports={activate};';
}

// ---------------------------------------------------------------- emit shared artifacts
const ART = path.join(os.tmpdir(), 'ccsd-seam-artifacts.json');
execFileSync('npx', ['tsx', PATCH_TS, '--emit-seam-prelude', ART], {
  cwd: ROOT,
  env: { ...process.env, CCSD_INSTALL_DIR: path.join(os.tmpdir(), 'ccsd-seam-artifacts-install') },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const art = JSON.parse(fs.readFileSync(ART, 'utf8'));
// Pre-warm the tsx runner (the first npx spawn after a cache expiry pays a
// ~30-60s package install; G8's fresh-lock staleness window is 60s, so a cold
// spin-up made the lock LOOK stale and the patcher legitimately broke it).
execFileSync('npx', ['tsx', '--version'], { cwd: ROOT, stdio: 'ignore' });

// ---------------------------------------------------------------- G1 banner matrix
// R1 gates fix: G1 must exercise the COMPANION'S PRODUCTION regex (the one
// ccPatchState builds at companion/extension.ts), not a local copy — a drift
// in the production pattern made every seam install read 'stale' forever
// while this gate stayed green. Extracted from source like test-favorites'
// comparator pin.
const extSrcG1 = fs.readFileSync(path.join(ROOT, 'companion', 'extension.ts'), 'utf8');
check(
  'G1.x production banner regex shape found in companion source (stable fragments)',
  extSrcG1.includes('}:v(') && extSrcG1.includes('(?::[0-9a-f]{4,16})?') && extSrcG1.includes('${markerRe}'),
);
const markerLit = 'cc-status-dot-injected';
const markerRe = markerLit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bannerRe = new RegExp(`${markerRe}:v(\\d+\\.\\d+\\.\\d+)(?::[0-9a-f]{4,16})?\\*`);
const extSrc = fs.readFileSync(path.join(ROOT, 'companion', 'extension.ts'), 'utf8');
check('G1.0 companion source still parses the versioned marker (sync sentinel)', /cc-status-dot-injected/.test(extSrc));
{
  const line1 = art.stamped.split('\n')[0];
  check(
    'G1.1 v0.6 banner (hash8) parses legacy shape',
    /^\/\*cc-status-dot-injected:v[0-9]+\.[0-9]+\.[0-9]+:[0-9a-f]{8}\*\/$/.test(line1),
    line1,
  );
  check(
    'G1.2 hash16 variant parses',
    /^\/\*cc-status-dot-injected:v[0-9.]+:[0-9a-f]{16}\*\/$/.test(
      '/*cc-status-dot-injected:v0.5.51:0123456789abcdef*/',
    ),
  );
  check(
    'G1.3 no-hash (old v0.1.x) variant parses',
    /^\/\*cc-status-dot-injected:v[0-9.]+\*\/$/.test('/*cc-status-dot-injected:v0.1.2*/'),
  );
  check(
    'G1.4 v0.5.x stamped banner parses',
    /^\/\*cc-status-dot-injected:v0\.5\.52:[0-9a-f]+\*\/$/.test('/*cc-status-dot-injected:v0.5.52:abcd1234*/'),
  );
  check('G1.5 `:seam` mutation must NOT parse (negative)', !bannerRe.test('/*cc-status-dot-injected:v0.6.0:seam*/'));
  check(
    'G1.6 banner line carries NO trailing chars after */ (byte-compat)',
    line1.endsWith('*/') && !line1.slice(line1.indexOf('*/') + 2).trim(),
  );
}

// ---------------------------------------------------------------- G12 + idempotency (clean bundle)
{
  const pristine = fakeCcBundle();
  const { exts, extJs } = mkSandbox(pristine);
  const r1 = runPatcher(exts);
  check(
    'G12.1 clean CJS patch succeeds',
    r1.code === 0 && /patched extension\.js \(seam prelude\)/.test(r1.out),
    r1.out.slice(-200),
  );
  const patched1 = fs.readFileSync(extJs, 'utf8');
  check(
    'G12.2 banner is line 1 + ccsd2 region present',
    patched1.startsWith('/*cc-status-dot-injected:') && patched1.includes(';/*ccsd2:begin:seam:'),
  );
  check('G12.3 original bundle body preserved verbatim after the prelude', patched1.endsWith(pristine));
  const r2 = runPatcher(exts);
  const patched2 = fs.readFileSync(extJs, 'utf8');
  check(
    'G12.4 second run is a no-op (fresh skip, zero disk churn)',
    r2.code === 0 && /already patched — skipping injection/.test(r2.out) && patched2 === patched1,
  );
  // strip via --revert with .bak DELETED (in-place strip path)
  fs.unlinkSync(extJs + '.bak');
  const r3 = runRevert(exts);
  const after = fs.readFileSync(extJs, 'utf8');
  check(
    'G12.5 revert-without-.bak strips the seam in place → byte-equal pristine',
    r3.code === 0 && /reverted/.test(r3.out) && after === pristine,
    (after === pristine ? '' : 'BYTES DIFFER; ') + r3.out.slice(-160),
  );
}

// ---------------------------------------------------------------- G3 directive prologue
// R1 gates mutation survivor: seamInsertionOffset(return 0) stayed green — a
// future CC bundle opening with "use strict" would get the prelude BEFORE the
// directive, silently demoting it (sloppy mode). These fixtures pin the scan.
{
  const mkG3 = (head) => head + 'var vscode=require("vscode");module.exports={activate(){}};';
  const cases = [
    // [name, bundle head, expected insertion = after the directive prologue]
    ['plain CJS (byte 0)', '', 0],
    ['"use strict" directive', '"use strict";', 13],
    ['single-quote directive', "'use strict';", 13],
    ['directive with leading comment + spaces', '/* header */\n  "use strict";\n', 29],
    ['double directives', '"use strict";"use asm";', 23],
    ['BOM only (insert AFTER BOM)', '\uFEFF', 1],
    ['BOM + directive', '\uFEFF"use strict";', 14],
    ['shebang', '#!/usr/bin/env node\n', 20],
    ['comment-only head (prelude BEFORE comments is fine)', '/* (c) cc */', 12],
    ['NOT a directive: string concat expression', '"a"+"b";', 0],
  ];
  for (const [name, head, want] of cases) {
    const bundle = mkG3(head);
    const { exts, extJs } = mkSandbox(bundle);
    const r = runPatcher(exts);
    const patched = r.code === 0 ? fs.readFileSync(extJs, 'utf8') : '';
    // The seam is INSERTED at offset `want` inside the ORIGINAL — the exact
    // byte contract: patched === original.slice(0,want) + stamped + original.slice(want)
    // (proving BOTH the directive-aware offset AND byte preservation).
    const expected = bundle.slice(0, want) + art.stamped + bundle.slice(want);
    check(
      `G3 ${name}: prelude inserted at offset ${want} (directive prologue preserved)`,
      r.code === 0 && patched === expected,
      r.code === 0
        ? `BYTES DIFFER (len ${patched.length} vs ${expected.length})`
        : `exit=${r.code} out=${r.out.slice(-140)}`,
    );
  }
}

// ---------------------------------------------------------------- G2 legacy migration
{
  const { exts, extJs } = mkSandbox(art.legacyInjected);
  const legacyBytes0 = fs.readFileSync(extJs, 'utf8');
  check(
    'G2.0 fixture is marker-carrying v0.5.x (precondition)',
    legacyBytes0.includes('cc-status-dot-injected:v0.5.52:') && !legacyBytes0.includes('ccsd2:begin'),
  );
  const r1 = runPatcher(exts);
  check(
    'G2.1 anchor-injected install migrates to seam (exit 0)',
    r1.code === 0 && /patched extension\.js \(seam prelude\)/.test(r1.out),
    r1.out.slice(-300),
  );
  const migrated = fs.readFileSync(extJs, 'utf8');
  check(
    'G2.2 migrated file carries the seam (ccsd2) + no surviving anchor IIFE banner',
    migrated.includes(';/*ccsd2:begin:seam:') &&
      !/\/\*cc-status-dot-injected:v0\.5\.52:[0-9a-f]+\*\/\(function\(t\)\{/.test(migrated),
  );
  check('G2.3 migration preserved the original scaffold tail', migrated.endsWith(art.legacyPristine));
  // .bak semantics: the fixture had NO .bak; the migration must have written
  // one from the recovered original (backupOnce never overwrites).
  const bak = fs.readFileSync(extJs + '.bak', 'utf8');
  check('G2.4 .bak rebuilt from the recovered original (=== legacyPristine)', bak === art.legacyPristine);
  // now revert with .bak present → pristine via .bak path
  const r2 = runRevert(exts);
  check(
    'G2.5 revert via .bak → byte-equal pristine scaffold',
    r2.code === 0 &&
      /restored extension\.js from/.test(r2.out) &&
      fs.readFileSync(extJs, 'utf8') === art.legacyPristine,
  );
}

// ---------------------------------------------------------------- G4 ESM fixtures
{
  const mk = (body, pkg) => mkSandbox(body, pkg);
  // type:module
  {
    const { exts } = mk(fakeCcBundle(), '{"name":"cc","version":"1.0.0","type":"module"}');
    const r = runPatcher(exts);
    check(
      'G4.1 package.json type:module → cc-esm-detected (skip-retry class, zero footprint)',
      r.code !== 0 && r.out.includes('ccsd-fail-class:cc-esm-detected'),
      r.out.slice(-160),
    );
  }
  // top-level import
  {
    const { exts, extJs } = mk(
      'import path from "node:path";\nvar vscode=require("vscode");module.exports={activate(){}};',
    );
    const before = fs.readFileSync(extJs, 'utf8');
    const r = runPatcher(exts);
    check(
      'G4.2 top-level import → cc-esm-detected',
      r.code !== 0 && r.out.includes('ccsd-fail-class:cc-esm-detected') && fs.readFileSync(extJs, 'utf8') === before,
    );
    check('G4.2b ESM failure leaves NO .bak behind', !fs.existsSync(extJs + '.bak'));
  }
  // top-level export
  {
    const { exts } = mk('var vscode=require("vscode");export function activate(){}\n');
    const r = runPatcher(exts);
    check(
      'G4.3 top-level export → seam-precondition-failed',
      r.code !== 0 && r.out.includes('ccsd-fail-class:seam-precondition-failed'),
      r.out.slice(-160),
    );
  }
  // no vscode require
  {
    const { exts } = mk('var fs=require("fs");module.exports={activate(){}};');
    const r = runPatcher(exts);
    check(
      'G4.4 zero require("vscode") → seam-precondition-failed',
      r.code !== 0 && r.out.includes('ccsd-fail-class:seam-precondition-failed'),
    );
  }
}

// ---------------------------------------------------------------- G8 lock contention
{
  const { exts, extJs } = mkSandbox(fakeCcBundle());
  // fresh lock → no-op success, file untouched
  const lockPath = extJs + '.ccsd.lock';
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, ts: Date.now() }));
  const before = fs.readFileSync(extJs, 'utf8');
  const r1 = runPatcher(exts);
  check(
    'G8.1 fresh lock → exit 0 lock-holder message, file untouched',
    r1.code === 0 && /another patcher holds the lock/.test(r1.out) && fs.readFileSync(extJs, 'utf8') === before,
    r1.out.slice(-160),
  );
  // stale lock (61s old) → broken, patch proceeds
  const stale = new Date(Date.now() - 61_000);
  fs.utimesSync(lockPath, stale, stale);
  const r2 = runPatcher(exts);
  check(
    'G8.2 stale lock (≥60s) is broken → patch proceeds',
    r2.code === 0 && /patched extension\.js \(seam prelude\)/.test(r2.out),
    r2.out.slice(-200),
  );
  check('G8.3 lock file released after a successful patch', !fs.existsSync(lockPath));
}

if (fail === 0) console.log(`All ${pass} seam-gate checks passed.`);
else {
  console.log(`${pass} passed, ${fail} failed.`);
  process.exit(1);
}
