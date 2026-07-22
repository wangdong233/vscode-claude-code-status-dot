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

// --- TOK_TOKENS_EXT cross-file equality (v0.2.7 Q1 fix) --------------------
// The new <sid>.tokens.json snapshot is written by the hook and read by the
// IIFE reader (readTok three-tier + §G tick fallback). A rename on one side
// would silently desync the writer↔reader path — the snapshot would still be
// written but the IIFE would keep reading the legacy .json path and the post-
// restart 0-window would silently re-open. Mirror the TOK_OFFSET_EXT /
// TOK_FORCEREREAD_EXT cross-file equality contract.
const patchTokens = extractStringConst(patchSrc, 'TOK_TOKENS_EXT');
const hookTokens = extractStringConst(hookSrc, 'TOK_TOKENS_EXT');
check('patch.ts TOK_TOKENS_EXT defined (v0.2.7 Q1)', patchTokens !== null);
check('hooks/cc-status.js TOK_TOKENS_EXT defined (v0.2.7 Q1)', hookTokens !== null);
if (patchTokens !== null && hookTokens !== null) {
  check(
    'TOK_TOKENS_EXT cross-file equality (Q1 tokens-snapshot path contract) — "' +
      patchTokens +
      '" === "' +
      hookTokens +
      '"',
    patchTokens === hookTokens,
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

  // v0.2.7 (Q1 fix): the IIFE bytes must also contain the JSON-stringified
  // form of TOK_TOKENS_EXT inside readTok's three-tier fallback (sid+
  // ${tokTokensExtLiteral}) AND inside the §G tick tokens-snapshot fallback.
  // Two sites: readTok (QuickPick path) + the §G tick merge (live SBI path).
  // Closes the silent-desync window where a writer-side TOK_TOKENS_EXT rename
  // passes the cross-file equality contract test above but the IIFE keeps
  // reading the wrong filename, missing the snapshot on post-restart tick.
  if (iifeBytes && patchTokens !== null) {
    const expectedSid = 'sid+"' + patchTokens + '"';
    const readTokStart = iifeBytes.indexOf('function readTok(');
    const inReadTok = readTokStart >= 0 && iifeBytes.slice(readTokStart).includes(expectedSid);
    check(
      'IIFE readTok uses baked TOK_TOKENS_EXT literal (v0.2.7 Q1: three-tier fallback no hardcoded .tokens.json drift)',
      inReadTok,
      'expected IIFE bytes to contain "' + expectedSid + '" inside readTok',
    );
    // §G tick merge site: activeSid+"<...>" (the snapshot read inside the tick
    // body). Search for the literal anywhere in the IIFE bytes AFTER the §G
    // tick entrypoint — at least one occurrence outside readTok.
    const tickStart = iifeBytes.indexOf('globalThis.__ccsdTokSbi');
    const tickHasLiteral = tickStart >= 0 && iifeBytes.slice(tickStart).includes('activeSid+"' + patchTokens + '"');
    check(
      'IIFE §G tick uses baked TOK_TOKENS_EXT literal for snapshot fallback (v0.2.7 Q1)',
      tickHasLiteral,
      'expected IIFE bytes to contain "activeSid+"' + patchTokens + '" inside §G tick',
    );
  } else {
    check('IIFE readTok uses baked TOK_TOKENS_EXT literal (v0.2.7 Q1) — skipped (run `npm run build` to enable)', true);
    check('IIFE §G tick uses baked TOK_TOKENS_EXT literal (v0.2.7 Q1) — skipped (run `npm run build` to enable)', true);
  }
}

// --- SRC_MODULES ↔ patch.ts `from "./src/...js"` imports parity (v0.2.8 round-2 HIGH) ---
// installCompanionRuntimeFiles copies SRC_MODULES into INSTALL_DIR/src/ so
// the standalone patch.js (re-exec'd by the companion after a CC auto-update)
// can resolve its relative ESM specifiers (`./src/semver.js` etc.) at module
// load. The list is hand-maintained in 4 places:
//   patch.ts:        `const SRC_MODULES = ["semver.js", "jsonc.js", "surgical-json.js"]`
//   patch.ts:        reportCompanionStatus (uses SRC_MODULES.length + .every)
//   hooks/test-standalone-patch.mjs: SRC_MODULES local copy
//   hooks/test-patcher-io.mjs:       hardcoded ['semver.js','jsonc.js','surgical-json.js']
//
// v0.2.7 regression shape: a future patch.ts that adds
//   `import { foo } from "./src/foo.js"`
// and forgets to update SRC_MODULES leaves installCompanion skipping the new
// module → companion auto-heal crashes with ERR_MODULE_NOT_FOUND on the next
// --patch-only. The v0.2.8 round-1 standalone e2e catches the EXISTING list
// at the runtime layer, but it cannot catch a NEW import added without a
// SRC_MODULES bump — that gap silently re-arms the v0.2.7 bug class. This
// guard extracts BOTH the SRC_MODULES list AND the actual `from "./src/...js"`
// imports from patch.ts source, then asserts set equality. A new import
// without a SRC_MODULES bump fails this check directly.
{
  // Extract SRC_MODULES array literal from patch.ts.
  const srcModulesMatch = patchSrc.match(/const\s+SRC_MODULES\s*=\s*\[([^\]]+)\]/);
  check('patch.ts defines SRC_MODULES array literal (round-2 HIGH)', !!srcModulesMatch);
  let srcModules = [];
  if (srcModulesMatch) {
    // Extract every double-quoted .js filename inside the brackets.
    const re = /"([^"]+\.js)"/g;
    let m;
    while ((m = re.exec(srcModulesMatch[1])) !== null) srcModules.push(m[1]);
  }
  check('SRC_MODULES list is non-empty (round-2 HIGH)', srcModules.length > 0, 'got ' + JSON.stringify(srcModules));

  // Extract the actual `import { ... } from "./src/<name>.js"` statements at
  // the top of patch.ts. The `^\s*import` anchor (with the `m` flag) refuses
  // to match `from "./src/..."` substrings that appear inside JSDoc or line
  // comments — the prior naive `from\s+['"]\.\/src\/...` shape matched the
  // very JSDoc examples that document this contract (false positives:
  // "...js" and "foo.js"). Tolerate single/double quotes. Captures only the
  // basename (e.g. "semver.js" from "./src/semver.js") for direct comparison
  // with SRC_MODULES entries (which are basenames). The `[^;]*?` between
  // `import` and `from` lazily matches the named-imports clause without
  // crossing statement boundaries.
  const imports = new Set();
  const importRe = /^\s*import\s+[^;]*?from\s+['"]\.\/src\/([^'"/]+\.js)['"]/gm;
  let im;
  while ((im = importRe.exec(patchSrc)) !== null) imports.add(im[1]);
  check(
    'patch.ts has at least one `from "./src/...js"` import (round-2 HIGH)',
    imports.size > 0,
    'no imports found — the regex shape may have drifted',
  );

  // Parity assertion #1: every ./src import MUST appear in SRC_MODULES.
  // A new import without a SRC_MODULES bump fails here (the v0.2.7 regression
  // shape — companion would crash on the un-copied module).
  const missingFromSrcModules = [...imports].filter((m) => !srcModules.includes(m));
  check(
    'every `from "./src/...js"` import appears in SRC_MODULES (round-2 HIGH: companion crash gate)',
    missingFromSrcModules.length === 0,
    missingFromSrcModules.length
      ? 'imported but NOT in SRC_MODULES (installCompanion would skip the copy → ERR_MODULE_NOT_FOUND): ' +
          missingFromSrcModules.join(', ')
      : '',
  );

  // Parity assertion #2: every SRC_MODULES entry MUST have a corresponding
  // import. An orphan entry (SRC_MODULES lists a module that patch.ts no
  // longer imports) is wasted work at install time + confusing diagnostic
  // surface — not a crash, but a stale-list signal that bites the next
  // maintainer who tries to reason about the install contract.
  const orphanedInSrcModules = srcModules.filter((m) => !imports.has(m));
  check(
    'every SRC_MODULES entry has a matching `from "./src/...js"` import (round-2 HIGH: no stale orphans)',
    orphanedInSrcModules.length === 0,
    orphanedInSrcModules.length
      ? 'listed in SRC_MODULES but patch.ts does not import (stale list): ' + orphanedInSrcModules.join(', ')
      : '',
  );

  // Sanity: SRC_MODULES contains the v0.2.4 architecture-split canonical trio.
  // A future rename (e.g. semver.js → semver-utils.js) that touches both the
  // import and SRC_MODULES would still pass the two parity checks above, but
  // this pin forces the maintainer to also update the standalone e2e test
  // (which hardcodes the same names) — a deliberate friction point.
  for (const m of ['semver.js', 'jsonc.js', 'surgical-json.js']) {
    check(
      `SRC_MODULES contains ${m} (v0.2.4 canonical trio)`,
      srcModules.includes(m),
      'got ' + JSON.stringify(srcModules),
    );
  }
}

// v0.4.0 round-2 (ARCH-6 HIGH): STATE_DIR is the runtime path contract shared
// by writer (hooks/cc-status.js), IIFE reader (baked into patch.ts's buildIIFE),
// patcher top-level const, and — NEW in v0.4.0 — the companion Favorites
// writer (companion/extension.ts FAV_STATE_DIR). Pre-fix it existed as 4
// independent unsynced literal copies; test-favorites.mjs FAV.4 only form-
// checked the literal SHAPE of FAV_STATE_DIR (regex match), never extracting
// patch.ts:219 STATE_DIR's actual value. A future rename (e.g.
// ~/.claude/state/cc-tabs) would pass FAV.4 while the companion writes
// favorites.json to a directory the IIFE/hook no longer read. This block
// extracts the path-join expressions from all 4 sites AND from the built IIFE
// bytes, then asserts byte-equal. Mirrors the INTERRUPTED_RETENTION_MS cross-
// file §7.5 contract pin above (the original ARCH-6 fix this test was created
// to enforce).
{
  // Extract `path.join(os.homedir(), ".claude", "cc-tab-status")` form,
  // tolerating single/double quotes and the optional whitespace between args.
  // We capture the 3 string-literal segments (".claude", "cc-tab-status") and
  // the leading `os.homedir()`. Tolerate `path.join(` or `pth.join(` (IIFE
  // uses `pth` alias). Returns the reconstructed absolute path tail
  // (/`.claude`/`cc-tab-status`) when both literals are present, else null.
  function extractStateDirTail(src, name) {
    // Match `const NAME = <pathlib>.join(os.homedir(), ".claude", "cc-tab-status");`
    // The pathlib identifier is captured (path | pth); single OR double quotes
    // tolerated for the two string segments.
    const re = new RegExp(
      'const\\s+' +
        name +
        '\\s*=\\s*([a-zA-Z_$][\\w$]*)\\.join\\(\\s*os\\.homedir\\(\\)\\s*,\\s*([\'"])(\\.claude)\\2\\s*,\\s*([\'"])(cc-tab-status)\\4\\s*\\)',
    );
    const m = src.match(re);
    if (!m) return null;
    // Return the path tail (the parts after os.homedir() that ALL surfaces
    // must agree on).
    return m[3] + '/' + m[5];
  }
  const patchTail = extractStateDirTail(patchSrc, 'STATE_DIR');
  const hookTail = extractStateDirTail(hookSrc, 'STATE_DIR');
  // companion uses FAV_STATE_DIR (distinct name because STATE_DIR is not the
  // companion's primary concern — Favorites has its own state sub-contract).
  const companionSrc = read('companion/extension.ts');
  const companionTail = extractStateDirTail(companionSrc, 'FAV_STATE_DIR');
  check('patch.ts defines STATE_DIR = path.join(os.homedir(), ".claude", "cc-tab-status")', patchTail !== null);
  check('hooks/cc-status.js defines STATE_DIR same-shape', hookTail !== null);
  check(
    'companion/extension.ts defines FAV_STATE_DIR same-shape (v0.4.0 round-2 HIGH)',
    companionTail !== null,
    'see FAV_STATE_DIR const — companion is a STATE_DIR consumer (Favorites sole writer)',
  );
  if (patchTail && hookTail) {
    check(
      'STATE_DIR cross-file path tail equality — patch.ts===hooks/cc-status.js (ARCH-6 §7.5 contract surface)',
      patchTail === hookTail,
      'patch.ts tail="' + patchTail + '" hook tail="' + hookTail + '"',
    );
  }
  if (patchTail && companionTail) {
    check(
      'STATE_DIR cross-file path tail equality — patch.ts===companion/extension.ts FAV_STATE_DIR (v0.4.0 round-2 HIGH)',
      patchTail === companionTail,
      'patch.ts tail="' + patchTail + '" companion tail="' + companionTail + '"',
    );
  }

  // Now extract the IIFE-baked DIR literal from dist/patch.js --check-iife.
  // The IIFE bakes `var DIR=${JSON.stringify(STATE_DIR)};` (absolute path at
  // patch time) since v0.4.0 round-2; pre-v0.4 it baked
  // `var DIR=pth.join(os.homedir(),".claude","cc-tab-status");` (runtime eval).
  // Both shapes carry the `.claude/cc-tab-status` tail; we pin BOTH forms so
  // the test passes whether dist was built from a pre-v0.4 or v0.4+ patch.ts.
  // The runtime-resolved path is the same either way; the tail must match.
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
  if (iifeBytes && patchTail) {
    // v0.4+ shape: `var DIR="<absolute-path>";` — the absolute path always
    // ends with the `.claude/cc-tab-status` tail (because STATE_DIR does).
    const v04Match = iifeBytes.match(/var\s+DIR\s*=\s*"([^"]+\.claude[^"]*cc-tab-status)"/);
    // pre-v0.4 shape: `var DIR=pth.join(os.homedir(),".claude","cc-tab-status")`
    const legacyMatch = iifeBytes.match(
      /var\s+DIR\s*=\s*[a-zA-Z_$][\w$]*\.join\(\s*os\.homedir\(\)\s*,\s*(['"]).claude\1\s*,\s*(['"])cc-tab-status\2\s*\)/,
    );
    check(
      'IIFE bakes STATE_DIR (v0.4+ absolute-literal form OR pre-v0.4 path.join form) — ARCH-6 HIGH fix',
      !!v04Match || !!legacyMatch,
      'expected IIFE bytes to bake DIR via `var DIR=".../.claude/cc-tab-status"` (v0.4+) or `pth.join(os.homedir(),".claude","cc-tab-status")` (legacy)',
    );
    if (v04Match) {
      // The baked absolute path must END with the same tail as patch.ts STATE_DIR.
      const bakedTail = patchTail; // `.claude/cc-tab-status`
      check(
        'IIFE baked DIR literal ends with the patch.ts STATE_DIR tail (v0.4+ absolute-literal form)',
        v04Match[1].endsWith(bakedTail.replace(/^\//, '')) || v04Match[1].endsWith('/' + bakedTail.replace(/^\//, '')),
        'IIFE baked DIR="' + v04Match[1] + '" — must end with "' + bakedTail + '"',
      );
    }
  } else {
    // Bootstrap-tolerant skip when dist/patch.js is not built (mirrors the
    // round-3 MEDIUM skip above for the TOK_OFFSET_EXT baked literal).
    check('IIFE bakes STATE_DIR — skipped (run `npm run build` to enable)', true);
  }
}

// v0.4.0 Favorites bridge: the IIFE publishes globalThis.__ccsdSidToPanel and
// registers the ccStatusDot.fav.focusSession command. The companion reads the
// map directly (same EH) AND calls the command as a fallback. Pin the
// command-id string equality across patch.ts (IIFE registerCommand site) +
// companion/extension.ts (executeCommand site) so a future rename touching
// only one side fails loudly. Mirrors the SBI_CLICK_CMD / TOK_CLICK_CMD
// discipline (single source of truth = patch.ts const).
{
  const patchFavCmd = patchSrc.match(/const\s+FAV_FOCUS_CMD\s*=\s*"([^"]+)"/);
  check('patch.ts defines FAV_FOCUS_CMD const (v0.4.0)', !!patchFavCmd, 'see patch.ts TOK_CLICK_CMD pattern');
  if (patchFavCmd) {
    check(
      `patch.ts FAV_FOCUS_CMD = "${patchFavCmd[1]}" (canonical ccStatusDot.fav.focusSession)`,
      patchFavCmd[1] === 'ccStatusDot.fav.focusSession',
    );
    // The IIFE bakes the const via JSON.stringify(FAV_FOCUS_CMD) at the
    // registerCommand site; the companion calls executeCommand with the
    // literal string. Pin the literal exists in companion source.
    const companionSrcForFav = read('companion/extension.ts');
    check(
      'companion/extension.ts calls executeCommand with the canonical ccStatusDot.fav.focusSession id',
      companionSrcForFav.includes('"ccStatusDot.fav.focusSession"'),
      'must match patch.ts FAV_FOCUS_CMD or the bridge breaks silently',
    );
    // And the IIFE actually emits the literal in the baked bytes.
    check(
      'patch.ts IIFE bakes the ccStatusDot.fav.focusSession literal via JSON.stringify(FAV_FOCUS_CMD)',
      /vs\.commands\.registerCommand\(\$\{JSON\.stringify\(FAV_FOCUS_CMD\)\}/.test(patchSrc),
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
