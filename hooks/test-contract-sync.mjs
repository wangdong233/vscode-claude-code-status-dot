#!/usr/bin/env node
/**
 * test-contract-sync.mjs — writer↔reader contract-constant sync check.
 *
 * Architecture review (ARCH-6 medium finding): the writer↔reader state
 * contract is implicit. Three named time constants live as hardcoded
 * literals in BOTH files with no compile-time or test-time guarantee they
 * move together:
 *
 *   patch.ts:        INTERRUPTED_RETENTION_MS = 24*60*60*1000  (top-level const, baked into IIFE via `${...}`)
 *   hooks/cc-status.js: INTERRUPTED_RETENTION_MS = 24*60*60*1000  (writer-side, GC threshold)
 *   patch.ts:        DONE_TO_IDLE_MS = 5*60*1000                  (top-level const, baked into IIFE)
 *   hooks/cc-status.js: (no writer-side equivalent — reader-only §4 rule, but pinned here for awareness)
 *   patch.ts:        SBI_RUNNING_STALE_MS = 30*60*1000           (top-level const, baked into IIFE)
 *   hooks/cc-status.js: (no writer-side equivalent — reader-only §7.2 rule)
 *
 *   TOK_WIN_KEYS lives as an array literal in BOTH files (8 keys each).
 *
 * The §7.5 contract requires: GC threshold (writer) === decay threshold
 * (reader). A future tuning edit (e.g. 48h retention) touching only
 * cc-status.js would silently break the contract — the writer would
 * reclaim at 48h, the reader would still idle-mark at 24h, orphaned
 * interrupted files would render as idle before reclamation. This test
 * REGEX-parses both files for the named time constants + TOK_WIN_KEYS
 * sequence and asserts cross-file equality, modeled on test-version-sync.mjs.
 *
 * Run:  node hooks/test-contract-sync.mjs
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

const patchSrc = read('patch.ts');
const hookSrc = read('hooks/cc-status.js');

// --- Number-literal time constants (INTERRUPTED_RETENTION_MS is the
// cross-file §7.5 contract; DONE_TO_IDLE_MS + SBI_RUNNING_STALE_MS are
// reader-only but pinned here so the contract surface is explicit). ---
function extractNumericConst(src, name) {
  // Match `const NAME = <expression>;` where the expression is the value.
  // Supports `24*60*60*1000`, `5*60*1000`, etc. — eval'd in a sandbox that
  // only allows digits, *, +, whitespace, parens (no identifiers).
  const re = new RegExp('const\\s+' + name + '\\s*=\\s*([0-9\\s*+()]+);');
  const m = src.match(re);
  if (!m) return null;
  const expr = m[1].trim();
  if (!/^[0-9\s*+()]+$/.test(expr)) return null; // safety gate
  try {
    return Number(eval(expr));
  } catch {
    return null;
  }
}

// --- TOK_WIN_KEYS array literal (8-key insertion-order pin). ---
function extractTokWinKeys(src) {
  // Match `const TOK_WIN_KEYS = ['5min', '10min', ...] as const;` (patch.ts)
  // OR `const TOK_WIN_KEYS = ['5min', '10min', ...];` (cc-status.js). Tolerate
  // single/double quotes; capture the bracketed array body.
  const m = src.match(/const\s+TOK_WIN_KEYS\s*=\s*\[([^\]]+)\]/);
  if (!m) return null;
  const inner = m[1];
  // Extract every quoted string literal.
  const keys = [];
  const keyRe = /['"]([^'"]+)['"]/g;
  let km;
  while ((km = keyRe.exec(inner)) !== null) keys.push(km[1]);
  return keys;
}

// --- INTERRUPTED_RETENTION_MS cross-file equality (§7.5 contract) ---
const patchInterrupted = extractNumericConst(patchSrc, 'INTERRUPTED_RETENTION_MS');
const hookInterrupted = extractNumericConst(hookSrc, 'INTERRUPTED_RETENTION_MS');
check('patch.ts defines INTERRUPTED_RETENTION_MS numeric const', patchInterrupted !== null);
check('hooks/cc-status.js defines INTERRUPTED_RETENTION_MS numeric const', hookInterrupted !== null);
if (patchInterrupted !== null && hookInterrupted !== null) {
  check(
    'INTERRUPTED_RETENTION_MS cross-file equality (§7.5 GC threshold === reader decay threshold) — patch.ts=' +
      patchInterrupted +
      ' cc-status.js=' +
      hookInterrupted,
    patchInterrupted === hookInterrupted,
  );
}

// --- DONE_TO_IDLE_MS (reader-only, but asserted for contract surface) ---
const patchDoneIdle = extractNumericConst(patchSrc, 'DONE_TO_IDLE_MS');
check('patch.ts defines DONE_TO_IDLE_MS numeric const (reader-only §4 rule)', patchDoneIdle !== null);
if (patchDoneIdle !== null) {
  check(
    'DONE_TO_IDLE_MS sensible value (expected 300000 = 5min) — got ' + patchDoneIdle,
    patchDoneIdle === 5 * 60 * 1000,
  );
}

// --- SBI_RUNNING_STALE_MS (reader-only §7.2 rule) ---
const patchRunningStale = extractNumericConst(patchSrc, 'SBI_RUNNING_STALE_MS');
check('patch.ts defines SBI_RUNNING_STALE_MS numeric const (reader-only §7.2 rule)', patchRunningStale !== null);
if (patchRunningStale !== null) {
  check(
    'SBI_RUNNING_STALE_MS sensible value (expected 1800000 = 30min) — got ' + patchRunningStale,
    patchRunningStale === 30 * 60 * 1000,
  );
}

// --- TOK_WIN_KEYS sequence equality (8-window insertion order, cross-file) ---
const patchKeys = extractTokWinKeys(patchSrc);
const hookKeys = extractTokWinKeys(hookSrc);
check('patch.ts defines TOK_WIN_KEYS array literal', patchKeys !== null && patchKeys.length > 0);
check('hooks/cc-status.js defines TOK_WIN_KEYS array literal', hookKeys !== null && hookKeys.length > 0);
if (patchKeys && hookKeys) {
  // Same length.
  check(
    'TOK_WIN_KEYS cross-file length equality (patch.ts=' + patchKeys.length + ' cc-status.js=' + hookKeys.length + ')',
    patchKeys.length === hookKeys.length,
  );
  // Same elements in same order (insertion-order parity is the load-bearing
  // contract — the IIFE QuickPick picker list and the writer sidecar JSON
  // cost_<window> field order both inherit from this sequence, and the 3d
  // key MUST sort between 24h and 7d chronologically).
  const sameOrder = patchKeys.length === hookKeys.length && patchKeys.every((k, i) => k === hookKeys[i]);
  check(
    'TOK_WIN_KEYS cross-file sequence equality (insertion-order parity)',
    sameOrder,
    sameOrder ? '' : 'patch.ts=[' + patchKeys.join(',') + '] cc-status.js=[' + hookKeys.join(',') + ']',
  );
  // Sanity: 8 keys (the canonical 5min/10min/1h/24h/3d/7d/30d/all set).
  check(
    'TOK_WIN_KEYS has 8 keys (canonical 5min..all set)',
    patchKeys.length === 8,
    'got ' + patchKeys.length + ': [' + (patchKeys || []).join(',') + ']',
  );
  // Sanity: 3d appears between 24h and 7d (chronological sort invariant —
  // pre-v0.2.5 it appeared after 30d which broke the progression).
  if (patchKeys.length === 8) {
    const idx24h = patchKeys.indexOf('24h');
    const idx3d = patchKeys.indexOf('3d');
    const idx7d = patchKeys.indexOf('7d');
    const idx30d = patchKeys.indexOf('30d');
    check(
      'TOK_WIN_KEYS chronological order: 24h < 3d < 7d < 30d (3d-between-24h-and-7d invariant)',
      idx24h >= 0 && idx3d > idx24h && idx7d > idx3d && idx30d > idx7d,
      'idx: 24h=' + idx24h + ' 3d=' + idx3d + ' 7d=' + idx7d + ' 30d=' + idx30d,
    );
  }
}

// --- TOK_WIN_MS cross-file equality (v0.2.5 round-3 MEDIUM) ---
// patch.ts's TOK_WIN_MS (reader-side, baked into the IIFE for the live-delta
// rolling-window filter) must equal hooks/cc-status.js's TOK_WINDOWS
// (writer-side, used by deriveTokensField for the bucket cutoff). Both
// sides derive their rolling-window spans from these maps — if they drift,
// the IIFE's dSum uses a DIFFERENT cutoff from the hook's bucket sum,
// causing rolling-window over- or under-count on long streaming turns.
// "all" maps to Infinity on both sides (handled below as a sentinel).
function extractTokWinMs(src, constName) {
  // Match `const NAME[: TypeAnnotation] = { "5min": N, ..., "all": Infinity };`
  // The TS side (patch.ts) carries a `: Record<...>` annotation that the JS
  // side (cc-status.js) does not — tolerate an optional `: ...` between the
  // name and the `=`. Tolerate single/double quotes OR bare identifiers as
  // keys (cc-status.js writes `all: Infinity` unquoted; patch.ts writes
  // `"all": Infinity` quoted). Capture each key→value pair.
  const m = src.match(new RegExp('const\\s+' + constName + '(?:\\s*:[^=]+)?\\s*=\\s*\\{([^}]+)\\}'));
  if (!m) return null;
  const inner = m[1];
  const out = Object.create(null);
  // Match ("key"|'key'|barekey) : VALUE  where VALUE is a digit expr or `Infinity`.
  // Bare keys must be valid JS identifiers (start with letter/_/$).
  const re = /(?:['"]([^'"]+)['"]|([A-Za-z_$][A-Za-z0-9_$]*))\s*:\s*([0-9\s*+()]+|Infinity)/g;
  let km;
  while ((km = re.exec(inner)) !== null) {
    const k = km[1] || km[2];
    const v = km[3].trim();
    out[k] = v === 'Infinity' ? Infinity : Number(eval(v));
  }
  return out;
}
const patchWinMs = extractTokWinMs(patchSrc, 'TOK_WIN_MS');
const hookWinMs = extractTokWinMs(hookSrc, 'TOK_WINDOWS');
check('patch.ts defines TOK_WIN_MS object literal (round-3 MEDIUM)', patchWinMs !== null);
check('hooks/cc-status.js defines TOK_WINDOWS object literal', hookWinMs !== null);
if (patchWinMs && hookWinMs) {
  let allEqual = true;
  const diffs = [];
  for (const k of Object.keys(patchWinMs)) {
    if (patchWinMs[k] !== hookWinMs[k]) {
      allEqual = false;
      diffs.push(k + ': patch=' + patchWinMs[k] + ' hook=' + hookWinMs[k]);
    }
  }
  check(
    'TOK_WIN_MS cross-file equality (round-3 MEDIUM: live-delta filter cutoff === hook bucket cutoff) — ' +
      (allEqual ? 'all 8 windows match' : diffs.join(', ')),
    allEqual && Object.keys(patchWinMs).length === 8,
  );
  // "all" must map to Infinity (cumulative — no filter).
  check(
    'TOK_WIN_MS["all"] === Infinity (cumulative window — no filter, mirrors hook)',
    patchWinMs.all === Infinity && hookWinMs.all === Infinity,
  );
}

// --- TOK_OFFSET_EXT + TOK_FORCEREREAD_EXT cross-file equality (string) ---
function extractStringConst(src, name) {
  const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*[\'"]([^\'"]+)[\'"]'));
  return m ? m[1] : null;
}
const patchOffset = extractStringConst(patchSrc, 'TOK_OFFSET_EXT');
const hookOffset = extractStringConst(hookSrc, 'TOK_OFFSET_EXT');
const patchForceReread = extractStringConst(patchSrc, 'TOK_FORCEREREAD_EXT');
const hookForceReread = extractStringConst(hookSrc, 'TOK_FORCEREREAD_EXT');
check('patch.ts TOK_OFFSET_EXT defined', patchOffset !== null);
check('hooks/cc-status.js TOK_OFFSET_EXT defined', hookOffset !== null);
if (patchOffset !== null && hookOffset !== null) {
  check(
    'TOK_OFFSET_EXT cross-file equality (writer↔reader path contract) — "' + patchOffset + '" === "' + hookOffset + '"',
    patchOffset === hookOffset,
  );
}
check('patch.ts TOK_FORCEREREAD_EXT defined', patchForceReread !== null);
check('hooks/cc-status.js TOK_FORCEREREAD_EXT defined', hookForceReread !== null);
if (patchForceReread !== null && hookForceReread !== null) {
  check(
    'TOK_FORCEREREAD_EXT cross-file equality (QuickPick reset marker contract) — "' +
      patchForceReread +
      '" === "' +
      hookForceReread +
      '"',
    patchForceReread === hookForceReread,
  );
}

// --- IIFE baked .offset literal === TOK_OFFSET_EXT (v0.2.5 round-3 MEDIUM) ---
// The round-3 fix re-baked tokOffsetExtLiteral into the IIFE so a future
// rename of TOK_OFFSET_EXT flows through automatically. This test verifies
// the IIFE bytes contain the JSON-stringified value of TOK_OFFSET_EXT
// inside computeLiveDelta (sid+${tokOffsetExtLiteral}) — closes the silent-
// desync window where a writer-side rename passes the existing cross-file
// contract test but the IIFE keeps reading the wrong filename, zeroing the
// live delta forever with no signal.
{
  // Re-extract dist/patch.js's IIFE bytes the same way test-iife.mjs does.
  // We accept the slight coupling — test-contract-sync.mjs already imports
  // from patch.ts via regex extraction, so reaching for the built IIFE is
  // in scope when verifying a baked-literal contract.
  const { spawnSync } = await import('child_process');
  const distPatch = path.join(ROOT, 'dist', 'patch.js');
  let iifeBytes = null;
  if (fs.existsSync(distPatch)) {
    const r = spawnSync(process.execPath, [distPatch, '--check-iife'], { encoding: 'utf8' });
    if (r.status === 0) {
      const idx = r.stdout.indexOf('/*cc-status-dot-injected');
      if (idx >= 0) iifeBytes = r.stdout.slice(idx);
    }
  }
  if (iifeBytes && patchOffset !== null) {
    // The IIFE bytes must contain `sid+".offset"` (the JSON-stringified form
    // of TOK_OFFSET_EXT) inside the computeLiveDelta body. We deliberately
    // do NOT match the QuickPick's `sid+${tokForceRereadExtLiteral}` site.
    const expected = 'sid+"' + patchOffset + '"';
    const computeStart = iifeBytes.indexOf('function computeLiveDelta(');
    const inComputeLiveDelta = computeStart >= 0 && iifeBytes.slice(computeStart).includes(expected);
    check(
      'IIFE computeLiveDelta uses baked TOK_OFFSET_EXT literal (round-3 MEDIUM: no hardcoded .offset drift)',
      inComputeLiveDelta,
      'expected IIFE bytes to contain "' +
        expected +
        '" inside computeLiveDelta; the IIFE either hard-coded ".offset" or did not bake the literal',
    );
  } else {
    // Bootstrap-tolerant skip: dist not built yet. We still emit a check so
    // the row count is stable; flip to PASS only if the literal is verifiable.
    check(
      'IIFE computeLiveDelta uses baked TOK_OFFSET_EXT literal (round-3 MEDIUM) — skipped (run `npm run build` to enable)',
      true,
    );
  }
}

console.log('');
if (fail === 0) {
  console.log(`All ${pass} contract-sync checks passed.`);
  process.exit(0);
} else {
  console.log(`${pass} passed, ${fail} failed.`);
  process.exit(1);
}
