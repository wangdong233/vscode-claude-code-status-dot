#!/usr/bin/env node
/**
 * test-pkg-contribs.mjs — install-side (patchPackageJson / buildCcContribs) test.
 *
 * test-iife.mjs covers the reader (injected IIFE) side — 43+ assertions on the
 * IIFE string that ships in extension.js. But until v0.1.13 the install side
 * (buildCcContribs → 20 commands + 20 commandCenter menu items + 20 palette
 * hides that get spliced into CC's package.json) had ZERO automated coverage:
 * any refactor that broke the variant→K mapping, dropped the dim emoji, changed
 * the command-id shape, or revised the dim-`when` reload-resilience clause
 * would silently pass every existing test. This file closes that gap by
 * dumping buildCcContribs() via `--check-pkg-contribs` and asserting on the
 * JSON output:
 *
 *   (a) 4 lights × 5 variants = 20 each of {commands, ccMenu, palette}.
 *   (b) Command IDs are `ccStatusDot.<key>.<variant>` (key ∈ LK, variant ∈ VR).
 *   (c) ccMenu `when` clauses:
 *         - variant==="0" (dim): `!ccStatusDot.<key> || ccStatusDot.<key> == 0`
 *           (the v0.1.13 reload-resilience fix — undefined key also matches).
 *         - variant==="N": `ccStatusDot.<key> == 4` (cap-clamped to "N").
 *         - variants 1/2/3: `ccStatusDot.<key> == <int>` (literal match).
 *       group is always "navigation" (VSCode commandCenter center group).
 *   (d) emoji: variant==="0" → CC_DIM_EMOJI (⚪ U+26AA); others → CC_LIGHTS[i].emoji.
 *   (e) palette entries all carry `when:"false"` (hide from command palette).
 *
 * Run:  node hooks/test-pkg-contribs.mjs     (requires `npm run build` first;
 *                                              falls back to `npx tsx patch.ts`
 *                                              if dist/ is missing)
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

// Mirror patch.ts CC_LIGHTS / CC_COUNT_VARIANTS (single source of truth is
// patch.ts; this local copy must stay in sync — same DRY caveat as test-iife.mjs).
// The CC_LIGHTS emoji codepoints MUST match patch.ts exactly:
//   done='\u{1F7E2}' (🟢), running='\u{1F7E1}' (🟡), pending='\u{1F535}' (🔵),
//   interrupted='\u{1F534}' (🔴), dim='\u{26AA}' (⚪).
const CC_LIGHTS = [
  { key: 'done', emoji: '\u{1F7E2}' },
  { key: 'running', emoji: '\u{1F7E1}' },
  { key: 'pending', emoji: '\u{1F535}' },
  { key: 'interrupted', emoji: '\u{1F534}' },
];
const CC_COUNT_VARIANTS = ['0', '1', '2', '3', 'N'];
const CC_DIM_EMOJI = '\u{26AA}';

// --- Obtain buildCcContribs() JSON via --check-pkg-contribs ----------------
function getContribs() {
  if (fs.existsSync(DIST_PATCH)) {
    const r = spawnSync(process.execPath, [DIST_PATCH, '--check-pkg-contribs'], { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error('--check-pkg-contribs failed via dist/patch.js: ' + (r.stderr || ''));
    }
    return stripShellNoise(r.stdout);
  }
  // Dev fallback: no build yet, try tsx.
  const r = spawnSync('npx', ['tsx', 'patch.ts', '--check-pkg-contribs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(
      'dist/patch.js missing and `npx tsx patch.ts --check-pkg-contribs` failed. ' +
        'Run `npm run build` first. stderr: ' +
        (r.stderr || ''),
    );
  }
  return stripShellNoise(r.stdout);
}

// Some shells print nvm/etc init noise to stdout. The JSON output always
// starts with `{` — keep everything from the first top-level `{` onward.
function stripShellNoise(stdout) {
  const idx = stdout.indexOf('{');
  if (idx < 0) {
    throw new Error('No JSON object found in --check-pkg-contribs output');
  }
  return JSON.parse(stdout.slice(idx));
}

let contribs;
try {
  contribs = getContribs();
} catch (e) {
  console.error('test-pkg-contribs: could not obtain buildCcContribs output: ' + e.message);
  process.exit(1);
}

console.log('Install-side (buildCcContribs) tests');
console.log('(extracting via `node dist/patch.js --check-pkg-contribs`)\n');

// --- 1. Structural counts: 4 lights × 5 variants = 20 each -----------------
check(
  'PKG.1  commands length = 20 (4 lights × 5 variants)',
  Array.isArray(contribs.commands) && contribs.commands.length === 20,
  'got ' + (contribs.commands && contribs.commands.length),
);
check(
  'PKG.2  ccMenu length = 20',
  Array.isArray(contribs.ccMenu) && contribs.ccMenu.length === 20,
  'got ' + (contribs.ccMenu && contribs.ccMenu.length),
);
check(
  'PKG.3  palette length = 20',
  Array.isArray(contribs.palette) && contribs.palette.length === 20,
  'got ' + (contribs.palette && contribs.palette.length),
);

// --- 2. Command ID shape: ccStatusDot.<key>.<variant> ----------------------
// Index by command id for cross-referencing between the 3 buckets.
const byCommandId = new Map();
for (const c of contribs.commands) {
  byCommandId.set(c.command, c);
}

let idsWellFormed = true;
const expectedIds = new Set();
for (const light of CC_LIGHTS) {
  for (const variant of CC_COUNT_VARIANTS) {
    expectedIds.add(`ccStatusDot.${light.key}.${variant}`);
  }
}
for (const id of byCommandId.keys()) {
  if (!expectedIds.has(id)) idsWellFormed = false;
}
check(
  'PKG.4  all 20 command ids match ccStatusDot.<key>.<variant> (4×5 grid)',
  idsWellFormed && byCommandId.size === 20,
  'unexpected ids: ' + JSON.stringify([...byCommandId.keys()].filter((id) => !expectedIds.has(id))),
);

// --- 3. Title format: `<emoji> <variant>` with dim emoji for variant==="0" --
// v0.1.13 finding: title for variant==="0" was previously `${emoji} ${variant}`
// = "⚪ 0", contradicting the patch.ts:1030 comment ("count=0 → dim ⚪ (no
// number)") and STATES.md §7.1 ("计数 0：灯灭——显示 ⚪（暗/灰白圈，无数字）").
// NOTE: this review round did NOT change the title (LOW severity, deferred).
// We lock the CURRENT behavior (`<emoji> <variant>` even for variant==="0")
// so any future fix to drop the number for dim is a deliberate assertion
// update, not a silent drift.
let titleOk = true;
const titleDetail = [];
for (const light of CC_LIGHTS) {
  for (const variant of CC_COUNT_VARIANTS) {
    const id = `ccStatusDot.${light.key}.${variant}`;
    const cmd = byCommandId.get(id);
    if (!cmd) {
      titleOk = false;
      titleDetail.push(`${id}: missing`);
      continue;
    }
    const expectedEmoji = variant === '0' ? CC_DIM_EMOJI : light.emoji;
    const expectedTitle = `${expectedEmoji} ${variant}`;
    if (cmd.title !== expectedTitle) {
      titleOk = false;
      titleDetail.push(`${id}: expected ${JSON.stringify(expectedTitle)} got ${JSON.stringify(cmd.title)}`);
    }
  }
}
check(
  'PKG.5  title = `<emoji> <variant>` (dim ⚪ for variant==="0", colored otherwise)',
  titleOk,
  titleDetail.slice(0, 3).join(' | '),
);

// --- 4. ccMenu when clauses (the v0.1.13 reload-resilience contract) -------
// dim variant (variant==="0") uses `!ccStatusDot.<key> || ccStatusDot.<key> == 0`
// so it matches when the context key is UNDEFINED (reload, no CC panel yet) —
// without the `!` arm, the commandCenter would be completely blank after a
// reload until the user opens a CC panel. The colored variants use
// `ccStatusDot.<key> == <K>` where K = 4 for "N" (cap-clamped) and 1/2/3
// otherwise.
const ccMenuByCommandId = new Map();
for (const m of contribs.ccMenu) {
  ccMenuByCommandId.set(m.command, m);
}

let whenOk = true;
const whenDetail = [];
for (const light of CC_LIGHTS) {
  for (const variant of CC_COUNT_VARIANTS) {
    const id = `ccStatusDot.${light.key}.${variant}`;
    const m = ccMenuByCommandId.get(id);
    if (!m) {
      whenOk = false;
      whenDetail.push(`${id}: no ccMenu entry`);
      continue;
    }
    // group must be "navigation" (VSCode commandCenter center group —
    // contributes.menus.commandCenter.group semantics).
    if (m.group !== 'navigation') {
      whenOk = false;
      whenDetail.push(`${id}: group=${JSON.stringify(m.group)} expected "navigation"`);
    }
    const expectedK = variant === 'N' ? 4 : Number(variant);
    let expectedWhen;
    if (variant === '0') {
      // Reload-resilience: undefined key ALSO matches dim.
      expectedWhen = `!ccStatusDot.${light.key} || ccStatusDot.${light.key} == 0`;
    } else {
      expectedWhen = `ccStatusDot.${light.key} == ${expectedK}`;
    }
    if (m.when !== expectedWhen) {
      whenOk = false;
      whenDetail.push(`${id}: when=${JSON.stringify(m.when)} expected ${JSON.stringify(expectedWhen)}`);
    }
  }
}
check(
  'PKG.6  ccMenu when clauses correct (dim uses `!X || X==0`, N→4, others literal) + group "navigation"',
  whenOk,
  whenDetail.slice(0, 3).join(' | '),
);

// --- 5. Dim reload-resilience: every one of the 4 lights has the `!` arm ----
// Dedicated assertion for the HIGH-severity v0.1.13 fix so a regression that
// dropped `|| ccStatusDot.X == 0` (keeping only `!X`) — or vice versa — on a
// SINGLE light would surface distinctly. Lock each of the 4 dim when strings.
for (const light of CC_LIGHTS) {
  const id = `ccStatusDot.${light.key}.0`;
  const m = ccMenuByCommandId.get(id);
  check(
    `PKG.7  ${light.key}.0 dim when has reload-resilience ('!' + '== 0')`,
    !!m && m.when === `!ccStatusDot.${light.key} || ccStatusDot.${light.key} == 0`,
    m ? 'when=' + JSON.stringify(m.when) : 'missing entry',
  );
}

// --- 6. palette hide-entries: all 20 carry when:"false" --------------------
let paletteOk = true;
const paletteDetail = [];
const paletteByCommandId = new Map();
for (const p of contribs.palette) {
  paletteByCommandId.set(p.command, p);
}
for (const light of CC_LIGHTS) {
  for (const variant of CC_COUNT_VARIANTS) {
    const id = `ccStatusDot.${light.key}.${variant}`;
    const p = paletteByCommandId.get(id);
    if (!p) {
      paletteOk = false;
      paletteDetail.push(`${id}: no palette entry`);
      continue;
    }
    if (p.when !== 'false') {
      paletteOk = false;
      paletteDetail.push(`${id}: when=${JSON.stringify(p.when)} expected "false"`);
    }
  }
}
check('PKG.8  palette hide-entries: all 20 carry when:"false"', paletteOk, paletteDetail.slice(0, 3).join(' | '));

// --- 7. Cross-bucket coherence: same 20 command ids across all 3 buckets ---
const commandsIds = new Set(contribs.commands.map((c) => c.command));
const ccMenuIds = new Set(contribs.ccMenu.map((m) => m.command));
const paletteIds = new Set(contribs.palette.map((p) => p.command));
const sameSet =
  commandsIds.size === 20 &&
  ccMenuIds.size === 20 &&
  paletteIds.size === 20 &&
  [...commandsIds].every((id) => ccMenuIds.has(id) && paletteIds.has(id));
check(
  'PKG.9  commands / ccMenu / palette reference the SAME 20 command ids',
  sameSet,
  'size mismatch or id divergence',
);

// --- summary ---------------------------------------------------------------

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
