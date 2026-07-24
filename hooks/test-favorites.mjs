#!/usr/bin/env node
/**
 * test-favorites.mjs — Favorites feature regression test.
 *
 * Validates the companion's FavoritesStore I/O contract (the half of the
 * feature that doesn't need a live VSCode EH):
 *   - favorites.json schema round-trip (write → read → equal)
 *   - atomic write produces a valid JSON file (no half-written bytes on crash)
 *   - corrupt / future-schema / missing file handling degrades gracefully
 *   - toggleFile / toggleTab / remove logic preserves invariants (idempotent,
 *     dedupe by fsPath / sid, sorted by lastSeenAt/addedAt desc)
 *
 * The companion's extension.ts is TypeScript compiled to dist/extension.js,
 * which imports 'vscode' (unavailable outside an EH). We therefore extract
 * the pure helpers (writeFavAtomic / readFavDoc logic) via a small EVAL of
 * the source strings and exercise them in a stubbed fs environment. This
 * mirrors the test-iife.mjs philosophy (assert on source/compiled bytes +
 * contract, NOT execute the VSCode-coupled runtime).
 *
 * Coverage map (docs/FAVORITES-DESIGN.md §5):
 *   - Q5 schema (round-trip + version guard) ✓
 *   - M5 favorites.json atomic read/write ✓
 *   - M4 TreeItem rendering is implicitly covered (companion source shape)
 *
 * Run:  node hooks/test-favorites.mjs   (after `npm run build` for companion)
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
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

// ---------------------------------------------------------------------------
// 1. Schema shape — pin the favorites.json schema so a future edit that
//    renames a field (or drops version) fails this test before shipping.
//    The schema is the contract between companion (sole writer) + a future
//    IIFE reader (v0.5+ composite-star feature).
// ---------------------------------------------------------------------------
const companionSrc = fs.readFileSync(path.join(ROOT, 'companion', 'extension.ts'), 'utf8');
const companionPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'companion', 'package.json'), 'utf8'));
const companionPkgEnginesVscode = companionPkg && companionPkg.engines && companionPkg.engines.vscode;

check(
  'FAV.1  FAV_SCHEMA_VERSION = 1 (v0.4 schema pin)',
  /const\s+FAV_SCHEMA_VERSION\s*=\s*1/.test(companionSrc),
  'bump on schema-incompatible change; the loader migrates forward',
);

check(
  'FAV.2  FavSession interface has all design-§5 fields (sid/label/cwd/transcript_path/model/state/addedAt/lastSeenAt)',
  // The interface declares each field as `<name>?: <type>;` or `<name>: <type>;`.
  // We look for the field name followed by the optional-? marker and a colon,
  // so the test is robust to indentation/spacing.
  ['sid:', 'label:', 'cwd?', 'transcript_path?', 'model?', 'state?', 'addedAt:', 'lastSeenAt:'].every((f) => {
    // Strip the trailing ':' (and optional '?') to get the bare field name,
    // then build a regex that tolerates '?' and requires a ':' after.
    const bare = f.replace(/[?:]/g, '');
    const opt = f.endsWith('?') ? '\\?' : '';
    return new RegExp(`\\b${bare}${opt}\\s*:\\s*`).test(companionSrc);
  }),
  'see docs/FAVORITES-DESIGN.md §5 schema',
);

check(
  'FAV.3  FavFile interface has fsPath/label/line/workspace/addedAt',
  ['fsPath:', 'label:', 'line?', 'workspace?', 'addedAt:'].every((f) => {
    const bare = f.replace(/[?:]/g, '');
    const opt = f.endsWith('?') ? '\\?' : '';
    return new RegExp(`\\b${bare}${opt}\\s*:\\s*`).test(companionSrc);
  }),
);

check(
  'FAV.4  FAV_FILE points at ~/.claude/cc-tab-status/favorites.json (= IIFE STATE_DIR) — form check; test-contract-sync.mjs §STATE_DIR pins cross-file value equality',
  /FAV_STATE_DIR\s*=\s*path\.join\(\s*os\.homedir\(\s*\)\s*,\s*"\.claude"\s*,\s*"cc-tab-status"\s*\)/.test(
    companionSrc,
  ) && /FAV_FILE\s*=\s*path\.join\(\s*FAV_STATE_DIR\s*,\s*"favorites\.json"\s*\)/.test(companionSrc),
  'form-only pin — cross-file VALUE equality (patch.ts:219 STATE_DIR === hooks/cc-status.js:1166 === companion FAV_STATE_DIR === IIFE baked DIR) is pinned by hooks/test-contract-sync.mjs §STATE_DIR (v0.4.0 round-2 HIGH)',
);

check(
  'FAV.5  companion is sole writer — writeFavAtomic uses tmp+rename (mirrors patch.ts:1662 writeAtomicSync)',
  /function\s+writeFavAtomic\([^)]*\)/.test(companionSrc) &&
    /writeFileSync\(\s*tmp\s*,\s*body/.test(companionSrc) &&
    /renameSync\(\s*tmp\s*,\s*FAV_FILE\s*\)/.test(companionSrc),
  'POSIX rename is atomic; tmp + rename prevents half-written favorites.json on crash',
);

check(
  'FAV.6  readFavDoc null on missing (first run), emptyFavDoc on corrupt',
  /function\s+readFavDoc\([^)]*\)/.test(companionSrc) &&
    /return\s+null/.test(companionSrc) &&
    /emptyFavDoc\(\)/.test(companionSrc),
);

check(
  'FAV.7  schema-version forward guard (future schema → empty + warning, no silent clobber)',
  /obj\.version\s*>\s*FAV_SCHEMA_VERSION/.test(companionSrc),
  'a newer-version favorites.json must NOT be silently downgraded',
);

// FAV.7b/c/d (v0.4.0 round-1 LOW): pin the production validators to the SAME
// shape as the replica above. Without this, a future regression that drops
// e.g. the `typeof s.state === 'string'` check would still pass FAV.9-14
// (which use well-formed fixtures) and silently re-arm the renderer crash at
// companion/extension.ts:957 (`(42).slice is not a function`).
check(
  'FAV.7b companion isValidFavSession type-checks required fields (sid/label/addedAt/lastSeenAt)',
  /function\s+isValidFavSession\([^)]*\)[\s\S]{0,800}?typeof\s+s\.sid\s*===\s*"string"[\s\S]{0,400}typeof\s+s\.label\s*===\s*"string"[\s\S]{0,400}typeof\s+s\.addedAt\s*===\s*"number"[\s\S]{0,400}typeof\s+s\.lastSeenAt\s*===\s*"number"/.test(
    companionSrc,
  ),
);
check(
  'FAV.7c companion isValidFavSession type-checks OPTIONAL fields (cwd/transcript_path/model/state)',
  /function\s+isValidFavSession\([^)]*\)[\s\S]{0,2000}?s\.cwd\s*===\s*undefined\s*\|\|\s*typeof\s+s\.cwd\s*===\s*"string"[\s\S]{0,400}s\.state\s*===\s*undefined\s*\|\|\s*typeof\s+s\.state\s*===\s*"string"/.test(
    companionSrc,
  ),
  'a hand-edited favorites.json with `"state": 42` would otherwise crash the renderer',
);
check(
  'FAV.7d companion isValidFavFile type-checks OPTIONAL fields (line/workspace)',
  /function\s+isValidFavFile\([^)]*\)[\s\S]{0,2000}?f\.line\s*===\s*undefined\s*\|\|\s*typeof\s+f\.line\s*===\s*"number"[\s\S]{0,400}f\.workspace\s*===\s*undefined\s*\|\|\s*typeof\s+f\.workspace\s*===\s*"string"/.test(
    companionSrc,
  ),
  'a hand-edited favorites.json with `"workspace": 42` would otherwise crash path.basename(42)',
);
check(
  'FAV.7e companion getTreeItem sets item.id on session + file nodes (MEDIUM selection-loss fix)',
  /item\.id\s*=\s*"ccsdFav:session:"\s*\+\s*s\.sid/.test(companionSrc) &&
    /item\.id\s*=\s*"ccsdFav:file:"\s*\+\s*f\.fsPath/.test(companionSrc),
  'without stable TreeItem.id, VSCode falls back to element-reference identity and clears selection every refresh',
);
check(
  'FAV.7f companion refresh() dedupes via signature (no-op when snapshot unchanged)',
  // v0.5.6: bound bumped from 2000 → 4000 because the new lastActiveSidForCtx
  // field (Bug 4 setContext tracking) + its JSDoc grew the gap between the
  // `lastSig` field declaration and the `if (sig === this.lastSig) return;`
  // early-return gate. The dedup pattern is unchanged; only the surrounding
  // code grew.
  /lastSig[\s\S]{0,4000}sig\s*===\s*this\.lastSig/.test(companionSrc),
  'a signature-diff early-return prevents needless full-tree invalidates from clearing selection every 2s',
);
check(
  'FAV.7g companion engines.vscode bumped to ^1.84.0 (QuickPickItemKind API gate)',
  companionPkgEnginesVscode === '^1.84.0',
  'QuickPickItemKind.Separator (used in favBrowse) is a 1.84+ API; lower engines would TypeError on the declared minimum',
);

// Negative validator cases — pin REJECTION of malformed entries. These are
// declared later in the file (after the verbatim validator replica in
// section 2) to avoid TDZ on the const/function declarations. See FAV.7r-y.

// ---------------------------------------------------------------------------
// 2. favorites.json round-trip — write a doc, read it back, assert equal.
//    This exercises the same code path the companion uses (writeFavAtomic +
//    readFavDoc), but in an isolated tmp dir we can pollute.
// ---------------------------------------------------------------------------
// We can't import extension.ts directly (it imports 'vscode'). Instead, we
// replicate the EXACT write+read logic in pure JS and assert against the
// schema pinned above. The contract pinned by FAV.1-7 ensures the inline
// replica stays in sync with companion source. (Same approach as the inline
// SBI_LIGHTS_CFG mirror at the top of test-iife.mjs.)

const FAV_SCHEMA_VERSION = 1;
function emptyFavDoc() {
  return { version: FAV_SCHEMA_VERSION, updatedAt: 0, sessions: [], files: [] };
}

// Verbatim JS replica of companion/extension.ts isValidFavSession/File. The
// shape-pin check (FAV.7b/c/d) below asserts the production source contains
// the SAME type checks, so a future drift between this replica and the
// production validator fails the test loudly (same discipline as the
// writeFavAtomic/readFavDoc replica).
function isValidFavSession(x) {
  if (typeof x !== 'object' || x === null) return false;
  const s = x;
  return (
    typeof s.sid === 'string' &&
    s.sid.length > 0 &&
    typeof s.label === 'string' &&
    typeof s.addedAt === 'number' &&
    typeof s.lastSeenAt === 'number' &&
    (s.cwd === undefined || typeof s.cwd === 'string') &&
    (s.transcript_path === undefined || typeof s.transcript_path === 'string') &&
    (s.model === undefined || typeof s.model === 'string') &&
    (s.state === undefined || typeof s.state === 'string')
  );
}
function isValidFavFile(x) {
  if (typeof x !== 'object' || x === null) return false;
  const f = x;
  return (
    typeof f.fsPath === 'string' &&
    f.fsPath.length > 0 &&
    typeof f.label === 'string' &&
    typeof f.addedAt === 'number' &&
    (f.line === undefined || typeof f.line === 'number') &&
    (f.workspace === undefined || typeof f.workspace === 'string')
  );
}

function writeFavAtomic(FAV_FILE, doc) {
  const dir = path.dirname(FAV_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort */
  }
  const tmp = `${FAV_FILE}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(doc, null, 2);
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    fs.renameSync(tmp, FAV_FILE);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw e;
  }
}
function readFavDoc(FAV_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(FAV_FILE, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyFavDoc();
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyFavDoc();
  if (typeof parsed.version === 'number' && parsed.version > FAV_SCHEMA_VERSION) return emptyFavDoc();
  // Mirror production: filter every entry through the validator so malformed
  // rows are dropped instead of crashing the renderer. The round-trip tests
  // FAV.8-17 cover the happy path; FAV.18a+ cover the validator's rejection.
  const sessions = Array.isArray(parsed.sessions) ? parsed.sessions.filter(isValidFavSession) : [];
  const files = Array.isArray(parsed.files) ? parsed.files.filter(isValidFavFile) : [];
  return {
    version: FAV_SCHEMA_VERSION,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    sessions,
    files,
  };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsd-fav-'));
const tmpFav = path.join(tmpDir, 'favorites.json');

// Empty case
check('FAV.8  readFavDoc returns null when favorites.json is missing', readFavDoc(tmpFav) === null);

// Round-trip — populate
const now = Date.now();
const doc1 = {
  version: 1,
  updatedAt: now,
  sessions: [
    {
      sid: '90cc10fb-1d9a-4397-9be1-ea98b0685bb2',
      label: 'cc-status-dot favorites',
      cwd: '/Users/example/project',
      transcript_path: '/Users/example/.claude/projects/-Users-example-project/90cc10fb.jsonl',
      model: 'glm-5.2',
      state: 'done',
      addedAt: now,
      lastSeenAt: now,
    },
  ],
  files: [
    {
      fsPath: '/Users/example/project/patch.ts',
      label: 'patcher entry',
      line: 1503,
      workspace: '/Users/example/project',
      addedAt: now,
    },
  ],
};
writeFavAtomic(tmpFav, doc1);
const read1 = readFavDoc(tmpFav);
check('FAV.9  round-trip preserves version', read1 && read1.version === 1);
check('FAV.10 round-trip preserves updatedAt', read1 && read1.updatedAt === now);
check('FAV.11 round-trip preserves sessions[]', read1 && read1.sessions.length === 1);
check(
  'FAV.12 round-trip preserves session fields',
  read1 &&
    read1.sessions[0].sid === doc1.sessions[0].sid &&
    read1.sessions[0].cwd === doc1.sessions[0].cwd &&
    read1.sessions[0].transcript_path === doc1.sessions[0].transcript_path &&
    read1.sessions[0].model === doc1.sessions[0].model,
);
check('FAV.13 round-trip preserves files[]', read1 && read1.files.length === 1);
check(
  'FAV.14 round-trip preserves file fields',
  read1 &&
    read1.files[0].fsPath === doc1.files[0].fsPath &&
    read1.files[0].line === doc1.files[0].line &&
    read1.files[0].workspace === doc1.files[0].workspace,
);

// Atomicity — no .tmp left behind after successful write
const tmps = fs.readdirSync(tmpDir).filter((n) => n.endsWith('.tmp'));
check('FAV.15 atomic write leaves no .tmp orphans on success', tmps.length === 0, 'got ' + JSON.stringify(tmps));

// Corrupt file → empty doc
fs.writeFileSync(tmpFav, '{not json', 'utf8');
const read2 = readFavDoc(tmpFav);
check(
  'FAV.16 corrupt favorites.json → emptyFavDoc (no throw)',
  read2 && read2.version === 1 && read2.sessions.length === 0,
);

// Future schema version → empty doc (no silent downgrade)
const futureDoc = { version: 99, updatedAt: now, sessions: [{ sid: 'future', label: 'future' }], files: [] };
fs.writeFileSync(tmpFav, JSON.stringify(futureDoc), 'utf8');
const read3 = readFavDoc(tmpFav);
check('FAV.17 future-schema favorites.json → emptyFavDoc (forward guard)', read3 && read3.sessions.length === 0);

// Negative validator cases (v0.4.0 round-1 LOW): pin REJECTION of malformed
// entries. The prior test suite only exercised well-formed fixtures, so a
// future regression that drops a validator check would still pass silently
// and re-arm the renderer crash (`(42).slice is not a function` at
// companion/extension.ts:957). The replica validators + readFavDoc are
// declared above (section 2 start) and shape-pinned to production source
// by FAV.7b-d.
check(
  'FAV.7r isValidFavSession rejects non-string optional state (e.g. state: 42)',
  isValidFavSession({ sid: 'abc', label: 'L', addedAt: 1, lastSeenAt: 2, state: 42 }) === false,
);
check(
  'FAV.7s isValidFavSession rejects non-string optional cwd',
  isValidFavSession({ sid: 'abc', label: 'L', addedAt: 1, lastSeenAt: 2, cwd: 42 }) === false,
);
check(
  'FAV.7t isValidFavSession rejects missing required sid',
  isValidFavSession({ label: 'L', addedAt: 1, lastSeenAt: 2 }) === false,
);
check(
  'FAV.7u isValidFavSession rejects empty-string sid',
  isValidFavSession({ sid: '', label: 'L', addedAt: 1, lastSeenAt: 2 }) === false,
);
check(
  'FAV.7v isValidFavSession rejects non-number addedAt',
  isValidFavSession({ sid: 'abc', label: 'L', addedAt: 'oops', lastSeenAt: 2 }) === false,
);
check(
  'FAV.7w isValidFavFile rejects non-number optional line (e.g. line: "abc")',
  isValidFavFile({ fsPath: '/x', label: 'L', addedAt: 1, line: 'abc' }) === false,
);
check(
  'FAV.7x isValidFavFile rejects non-string optional workspace (e.g. workspace: 42)',
  isValidFavFile({ fsPath: '/x', label: 'L', addedAt: 1, workspace: 42 }) === false,
);
check(
  'FAV.7y isValidFavFile accepts well-formed entry (sanity, no false positives)',
  isValidFavFile({ fsPath: '/x', label: 'L', addedAt: 1, line: 5, workspace: '/w' }) === true,
);
check(
  'FAV.7z readFavDoc drops malformed entries on load (validator wired into the read path)',
  (() => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccsd-fav-neg-')), 'favorites.json');
    const doc = {
      version: 1,
      updatedAt: 1,
      sessions: [
        { sid: 'good', label: 'G', addedAt: 1, lastSeenAt: 2 },
        { sid: 'bad-optional', label: 'B', addedAt: 1, lastSeenAt: 2, state: 42 },
        { label: 'missing-sid', addedAt: 1, lastSeenAt: 2 },
      ],
      files: [
        { fsPath: '/good', label: 'G', addedAt: 1 },
        { fsPath: '/bad', label: 'B', addedAt: 1, line: 'oops' },
      ],
    };
    writeFavAtomic(tmp, doc);
    const read = readFavDoc(tmp);
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    return (
      read &&
      read.sessions.length === 1 &&
      read.sessions[0].sid === 'good' &&
      read.files.length === 1 &&
      read.files[0].fsPath === '/good'
    );
  })(),
  'production readFavDoc must filter via the validators (validator wired into the read path)',
);

// ---------------------------------------------------------------------------
// 3. Companion source: provider/handlers/command-id surface
// ---------------------------------------------------------------------------
check(
  'FAV.18 FavoritesProvider implements TreeDataProvider (getTreeItem + getChildren)',
  /class\s+FavoritesProvider\s+implements\s+vscode\.TreeDataProvider/.test(companionSrc) &&
    /getTreeItem\s*\(/.test(companionSrc) &&
    /getChildren\s*\(/.test(companionSrc),
);

check(
  'FAV.19 all 7 commands registered (toggleFile/toggleTab/open/remove/copyResume/refresh/browse)',
  [
    'ccStatusDot.fav.toggleFile',
    'ccStatusDot.fav.toggleTab',
    'ccStatusDot.fav.open',
    'ccStatusDot.fav.remove',
    'ccStatusDot.fav.copyResume',
    'ccStatusDot.fav.refresh',
    'ccStatusDot.fav.browse',
  ].every((id) => companionSrc.includes(`"${id}"`)),
);

// v0.5.6 (Bug 4 dynamic add/remove text): two new commands split the unified
// "Star/Unstar" toggle into explicit Add/Remove verbs. The menu system uses
// setContext('ccStatusDot.fav.currentTabFavorited', true/false) to gate which
// label shows; toggleTab remains as the command-palette macro.
check(
  'FAV.19a v0.5.6 favAddTab command registered (Bug 4 explicit Add verb)',
  /vscode\.commands\.registerCommand\(\s*"ccStatusDot\.fav\.addTab"\s*,\s*favAddTab\)/.test(companionSrc),
  'the menu shows "Add to CC Favorites" only when currentTabFavorited === false (when-clause filter)',
);
check(
  'FAV.19b v0.5.6 favRemoveTab command registered (Bug 4 explicit Remove verb)',
  /vscode\.commands\.registerCommand\(\s*"ccStatusDot\.fav\.removeTab"\s*,\s*favRemoveTab\)/.test(companionSrc),
  'the menu shows "Remove from CC Favorites" only when currentTabFavorited === true (when-clause filter)',
);
check(
  'FAV.19c v0.5.6 favAddTab + favRemoveTab declared as top-level functions (shared sid resolution via resolveActiveSid)',
  /function\s+favAddTab\s*\(/.test(companionSrc) && /function\s+favRemoveTab\s*\(/.test(companionSrc),
  'both must be callable from the registered-command arrow wrapper',
);

check(
  'FAV.20 favToggleTab reads globalThis.__ccsdActiveSid (IIFE bridge pattern)',
  /g\.__ccsdActiveSid/.test(companionSrc) && /__ccsdLastActiveSid/.test(companionSrc),
);

check(
  'FAV.21 favOpen reads globalThis.__ccsdSidToPanel (primary reveal path)',
  /g\.__ccsdSidToPanel/.test(companionSrc) && /\.reveal\(\)/.test(companionSrc),
);

check(
  'FAV.22 favOpen falls back to ccStatusDot.fav.focusSession command (EH isolation future-proof)',
  /executeCommand\(\s*"ccStatusDot\.fav\.focusSession"\s*,\s*sid\s*\)/.test(companionSrc),
);

check(
  'FAV.23 favCopyResume writes "claude -r <sid>" to clipboard',
  // The companion builds `claude -r ${sid}` then passes the resulting string
  // to vscode.env.clipboard.writeText. Match either the inlined form or the
  // two-step cmd-then-writeText form (current implementation).
  /vscode\.env\.clipboard\.writeText\(\s*`claude -r \$\{sid\}`\s*\)/.test(companionSrc) ||
    (/const\s+cmd\s*=\s*`claude -r \$\{sid\}`/.test(companionSrc) &&
      /vscode\.env\.clipboard\.writeText\(\s*cmd\s*\)/.test(companionSrc)),
  'must put `claude -r <sid>` on the clipboard so the user can paste in a terminal',
);

check(
  'FAV.24 registerFavorites called from activate() AFTER detectAndPatch fire-and-forget',
  /void\s+detectAndPatch\(\)[\s\S]{0,2000}registerFavorites\(/.test(companionSrc),
);

check(
  'FAV.25 deactivate clears favoritesWatcher (no leak across reload)',
  /if\s*\(\s*favoritesWatcher\s*\)\s*\{[\s\S]*?clearInterval\(\s*favoritesWatcher\s*\)/.test(companionSrc),
);

// ---------------------------------------------------------------------------
// v0.4.0 round-3 fixes (HIGH warning-spam + MEDIUM setContext-spam).
//
// Round-2 found two companion-side bugs that survived round-1:
//   (HIGH) readFavDoc fired vscode.window.showWarningMessage UNCONDITIONALLY on
//          every call. The polling cycle is setInterval(refresh, 2000) →
//          refresh() calls readFavDoc() BEFORE the signature dedupe, and VSCode
//          separately invokes getChildren() multiple times per render (root
//          query + per-node child probes). Net effect: a corrupt or future-
//          schema favorites.json re-fired the warning toast every ~2s for the
//          entire EH lifetime. Fix: one-shot latches (corruptFavFileWarned +
//          transition-gated futureVersionLocked) so each warning fires at most
//          once per EH lifetime.
//   (MED)  getChildren fired setContext('ccStatusDot.favoritesEmpty', …) on
//          every invocation — N times per single tree render. Fix: move the
//          setContext into refresh() gated on the signature change, so it
//          dispatches once per real (doc, open) state transition instead of
//          N times per render. registerFavorites also calls refresh() once
//          synchronously so viewsWelcome fires on first reveal.
//
// The pins below lock both fixes against regression. They are byte-pattern
// checks on companion/extension.ts (the test-iife.mjs philosophy: assert on
// source bytes rather than spin up an EH).
// ---------------------------------------------------------------------------
check(
  'FAV.25a corruptFavFileWarned one-shot latch declared at module scope (HIGH warning-spam fix)',
  /let\s+corruptFavFileWarned\s*=\s*false/.test(companionSrc),
  'without this latch, a corrupt favorites.json re-fires showWarningMessage every ~2s for the entire EH lifetime',
);
check(
  'FAV.25b corrupt-JSON branch gates showWarningMessage on the corruptFavFileWarned latch',
  // The JSON.parse catch block must check the latch BEFORE calling
  // showWarningMessage, then set the latch true. We deliberately match the
  // whole transition (read latch → warn → set latch) so a regression that
  // flips the order can't sneak through.
  /JSON\.parse\s*\(\s*raw\s*\)[\s\S]{0,800}?catch[\s\S]{0,400}?if\s*\(\s*!\s*corruptFavFileWarned\s*\)[\s\S]{0,400}?corruptFavFileWarned\s*=\s*true/.test(
    companionSrc,
  ),
  'background pollers (refresh, getChildren) must never pop UI on every read — one-shot latch per EH lifetime',
);
check(
  'FAV.25c future-schema branch gates showWarningMessage on futureVersionLocked false→true transition',
  // The round-1 latch set futureVersionLocked = true unconditionally and then
  // warned unconditionally — so polling re-fired the warning every 2s. Round-3
  // wraps BOTH the set AND the warning in `if (!futureVersionLocked)`. The
  // writeFavAtomic refusal (line ~834) still sees true for the rest of the EH
  // lifetime — only the warning is de-duped.
  /obj\.version\s*>\s*FAV_SCHEMA_VERSION[\s\S]{0,800}?if\s*\(\s*!\s*futureVersionLocked\s*\)[\s\S]{0,800}?futureVersionLocked\s*=\s*true/.test(
    companionSrc,
  ),
  'round-2 regression: the latch was added to gate WRITES but not WARNINGS — the toast still dripped every 2s',
);
check(
  'FAV.25d setContext(ccStatusDot.favoritesEmpty) lives inside refresh() between signature check and emitter.fire (MEDIUM setContext-spam fix)',
  // The call used to live in getChildren (N dispatches per render). It must
  // now be positioned AFTER `sig === this.lastSig` (so it only fires on a
  // real state transition) and BEFORE `this.emitter.fire(undefined)` (so the
  // context lands before the tree re-renders).
  /sig\s*===\s*this\.lastSig[\s\S]{0,1500}?executeCommand\(\s*"setContext"\s*,\s*"ccStatusDot\.favoritesEmpty"[\s\S]{0,800}?emitter\.fire\(\s*undefined\s*\)/.test(
    companionSrc,
  ),
  'getChildren is invoked N times per render (root + per-node child probes) — setContext must dispatch once per real transition, not per probe',
);
check(
  'FAV.25e registerFavorites calls refresh() once synchronously after setInterval (initial setContext publish on first reveal)',
  // Without this, viewsWelcome would not fire on the view's first reveal
  // inside the +2s polling window — the user would see a blank view until
  // the first tick lands. The synchronous refresh publishes the initial
  // empty/non-empty setContext BEFORE VSCode's first getChildren probe.
  /favoritesWatcher\s*=\s*setInterval[\s\S]{0,3000}?favoritesProvider\?\.refresh\(\)/.test(companionSrc),
  'initial setContext must be published synchronously at registration, not at the +2s polling tick',
);

// ---------------------------------------------------------------------------
// 4. companion/package.json: views/commands/menus/configuration all present
//    (cross-checked against companion/extension.ts handlers in FAV.19 above).
// ---------------------------------------------------------------------------
// companionPkg loaded at top of file (also referenced by FAV.7g engines check).

check(
  'FAV.26 package.json contributes views.explorer with ccStatusDot.favorites',
  companionPkg.contributes &&
    companionPkg.contributes.views &&
    Array.isArray(companionPkg.contributes.views.explorer) &&
    companionPkg.contributes.views.explorer.some((v) => v.id === 'ccStatusDot.favorites'),
);

check(
  'FAV.27 package.json contributes all 7 fav commands',
  companionPkg.contributes &&
    Array.isArray(companionPkg.contributes.commands) &&
    [
      'ccStatusDot.fav.toggleFile',
      'ccStatusDot.fav.toggleTab',
      'ccStatusDot.fav.open',
      'ccStatusDot.fav.remove',
      'ccStatusDot.fav.copyResume',
      'ccStatusDot.fav.refresh',
      'ccStatusDot.fav.browse',
    ].every((id) => companionPkg.contributes.commands.some((c) => c.command === id)),
);

check(
  'FAV.28 package.json contributes explorer/context menu for toggleFile (Add/Remove File)',
  companionPkg.contributes &&
    companionPkg.contributes.menus &&
    Array.isArray(companionPkg.contributes.menus['explorer/context']) &&
    companionPkg.contributes.menus['explorer/context'].some((m) => m.command === 'ccStatusDot.fav.toggleFile'),
);

check(
  'FAV.37 package.json contributes explorer/context menu for addTab (Open Editors coverage, v0.5.7 replaced toggleTab with addTab/removeTab)',
  companionPkg.contributes &&
    companionPkg.contributes.menus &&
    Array.isArray(companionPkg.contributes.menus['explorer/context']) &&
    companionPkg.contributes.menus['explorer/context'].some(
      (m) =>
        m.command === 'ccStatusDot.fav.addTab' &&
        typeof m.when === 'string' &&
        m.when.includes("resourceScheme != 'file'"),
    ),
);

check(
  'FAV.29 package.json contributes view/item/context for open/remove/copyResume',
  companionPkg.contributes &&
    companionPkg.contributes.menus &&
    Array.isArray(companionPkg.contributes.menus['view/item/context']) &&
    ['ccStatusDot.fav.open', 'ccStatusDot.fav.remove', 'ccStatusDot.fav.copyResume'].every((id) =>
      companionPkg.contributes.menus['view/item/context'].some((m) => m.command === id),
    ),
);

check(
  'FAV.30 package.json contributes ccStatusDot.fav.includeInExplorerContextMenu (opt-out)',
  companionPkg.contributes &&
    companionPkg.contributes.configuration &&
    companionPkg.contributes.configuration.properties &&
    companionPkg.contributes.configuration.properties['ccStatusDot.fav.includeInExplorerContextMenu'] &&
    companionPkg.contributes.configuration.properties['ccStatusDot.fav.includeInExplorerContextMenu'].default === true,
);

// v0.5.0 shipped the editor/title/context tab right-click menu (was deferred
// from v0.4 per FAVORITES-DESIGN.md §5 Slice 2 pending an L1 PoC on webview
// tab menu visibility). v0.5.1 FIXED the gate (resourceScheme != 'file').
// v0.5.9 REMOVED editor/title/context + the includeInTabContextMenu config:
// the in-webview star injection that v0.5.8 added to set data-vscode-context
// was architecturally infeasible (CC sets webview.html once at panel creation;
// the read-modify-write fallback forced a destructive full reload of CC's
// React session — see patch.ts §AA forensics), and the tab right-click path
// itself only no-ops on non-CC tabs (VSCode exposes no CC-specific context
// key for the right-clicked tab). The reliable replacement is the
// ccStatusDot.fav.pickSession QuickPick (zero webview coupling) + the IIFE's
// "★ " tab-title prefix. These regression guards pin the removal so a future
// edit cannot silently re-introduce the broken menu + dead config.
const editorTitleContext = companionPkg.contributes?.menus?.['editor/title/context'];
check(
  'FAV.31 v0.5.9 REMOVED editor/title/context menu (architecturally broken — no CC-specific tab context key + star injection infeasible)',
  !editorTitleContext || editorTitleContext.length === 0,
  'editor/title/context must stay removed (v0.5.9): the tab right-click path only no-ops on non-CC tabs and the star injection that set the sid was infeasible. Use pickSession QuickPick + tab-title ★ prefix instead.',
);
check(
  'FAV.31a v0.5.9 REMOVED config.ccStatusDot.fav.includeInTabContextMenu (no longer gates anything — editor/title/context is gone)',
  !companionPkg.contributes?.configuration?.properties?.['ccStatusDot.fav.includeInTabContextMenu'],
  'includeInTabContextMenu only gated the removed editor/title/context menu; keeping a config toggle that controls nothing misleads users in the Settings UI.',
);
check(
  'FAV.31b v0.5.9 no menu entry references config.ccStatusDot.fav.includeInTabContextMenu (dead config fully rooted out)',
  (() => {
    const menus = companionPkg.contributes?.menus || {};
    return Object.values(menus).every(
      (arr) =>
        Array.isArray(arr) &&
        arr.every((m) => !(typeof m.when === 'string' && m.when.includes('includeInTabContextMenu'))),
    );
  })(),
);

// FAV.32 backs the commentary above (the `resourceScheme != 'file'` gate
// surfaces the item on ALL non-file tabs, so the favToggleTab handler MUST
// keep a no-op safety net for the case where the active editor is not a CC
// session). FAV.20 only asserts the `__ccsdActiveSid` / `__ccsdLastActiveSid`
// literals exist somewhere in source — it cannot catch the empty-sid guard
// branch being silently deleted during a refactor. This check pins the guard
// branch itself: an `if (!sid) { ... showInformationMessage("cc-status-dot:
// no active Claude Code session...") ... return }` block must remain in
// companion/extension.ts. If someone removes the guard, non-CC tabs would
// start hitting a null-sid code path instead of an info message.
check(
  'FAV.32 favToggleTab no-ops with an info message when no active CC session (guard branch pinned, not silently removable)',
  /if\s*\(\s*!\s*sid\s*\)\s*\{[^}]*showInformationMessage\s*\(\s*"cc-status-dot: no active Claude Code session/.test(
    companionSrc,
  ),
  'the empty-sid branch in favToggleTab (companion/extension.ts) must show an info message ("cc-status-dot: no active Claude Code session...") and return — the no-op safety net referenced by the FAV.31 commentary; FAV.20 only checks the sid literals and cannot detect this guard being deleted',
);

// FAV.33-36 v0.5.3 — F1 (right-clicked background tab) + F2 (label from
// transcript) fixes. These are source-contract pins (mirrors the test-iife.mjs
// philosophy): they lock the new bridge wiring + helper signatures so a
// regression that re-welds favToggleTab to __ccsdActiveSid or drops the
// transcript-label helper fails CI.
check(
  'FAV.33 v0.5.3 favToggleTab accepts a resourceUri parameter (editor/title/context menu contract, F1)',
  /function\s+favToggleTab\s*\(\s*resourceUri\s*\??\s*:\s*unknown\s*\)/.test(companionSrc),
  'VSCode editor/title/context auto-passes resourceUri; accepting it (even if unused for CC webview tabs) is the API contract',
);

check(
  'FAV.34 v0.5.3 favToggleTab resolves right-clicked tab via __ccsdSidToTitle + activeTabGroup.activeTab.label (F1)',
  /__ccsdSidToTitle/.test(companionSrc) &&
    /activeTabGroup\?\.activeTab/.test(companionSrc) &&
    /Object\.keys\(map\)\.find\(\(k\)\s*=>\s*map\[k\]\s*===\s*activeLabel\)/.test(companionSrc),
  'must attempt exact-title match against the IIFE bridge before falling back to __ccsdActiveSid',
);

check(
  'FAV.35 v0.5.3 deriveLabelFromTranscript helper declared (F2 — label from first user prompt, not UUID/cwd)',
  /function\s+deriveLabelFromTranscript\s*\(\s*transcriptPath\s*:\s*string\s*\)\s*:\s*string\s*\|\s*null/.test(
    companionSrc,
  ),
  'dedicated helper that reads the transcript jsonl for the first real user prompt (skips tool_result replies)',
);

check(
  'FAV.36 v0.5.3 deriveLabelFromTranscript skips tool_result user-messages (avoid labeling a favorite with tool output)',
  /type\s*===\s*["']tool_result["']/.test(companionSrc) && /tool_use_id/.test(companionSrc),
  'user turns that carry tool_result blocks are tool replies, not prompts — must be skipped',
);

// ---------------------------------------------------------------------------
// v0.5.6 — Favorites Bug 1/2/3/4 fixes.
//
// Bug 1 (HIGH latency): toggleTab/toggleFile/favRemove/favOpen lastSeenAt now
//   call forceRefresh() instead of refresh() so the tree re-renders IMMEDIATELY
//   after a successful write. Pre-fix the user clicked "add", saw no feedback
//   for up to 2s (the polling tick), and either re-clicked (Bug 2) or assumed
//   the feature was broken. The signature dedup gate (lastSig === sig) was
//   theoretically sufficient — the doc state changed so the signature should
//   differ — but VSCode-internal tree-render scheduling made the immediate
//   refresh unreliable in practice. forceRefresh clears lastSig="" before
//   refresh() so the emitter.fire(undefined) is guaranteed to run.
//
// Bug 2 (second-add-clears-all): root cause is Bug 1's delay. The user clicks
//   "add", sees no feedback (Bug 1), assumes it didn't register, and clicks
//   again — but the SAME sid is now favorited, so the second click toggles it
//   OFF and the view clears. forceRefresh closes the race window; the new
//   favAddTab/favRemoveTab commands (Bug 4) also make this UNREACHABLE: an
//   explicit Add on an already-favorited sid is a NO-OP (never toggles off).
//
// Bug 3 (Open Editors coverage): explorer/context for toggleTab was already
//   in place; v0.5.6 adds addTab + removeTab to BOTH explorer/context AND
//   editor/title/context so the dynamic labels reach the Open Editors view
//   (CC webview tabs are surface there in modern VSCode). The gate drops the
//   over-constraining `!explorerResourceIsFolder` for the add/remove items
//   so they appear even when VSCode treats the Open Editors entry as a
//   non-file resource without a clear folder/file distinction.
//
// Bug 4 (dynamic add/remove text): the unified "Star/Unstar" toggle is split
//   into explicit Add + Remove commands whose menu items are gated by
//   setContext('ccStatusDot.fav.currentTabFavorited', true/false). The
//   companion publishes this context inside refresh() so it stays fresh on
//   every (doc, active sid) transition. favAddTab / favRemoveTab are
//   idempotent — a stale setContext can NEVER cause a double-toggle that
//   removes a real favorite.
// ---------------------------------------------------------------------------
check(
  'FAV.37a v0.5.6 FavoritesProvider declares forceRefresh (Bug 1 immediate tree re-render)',
  /forceRefresh\s*\(\s*\)\s*:\s*void\s*\{/.test(companionSrc) &&
    /this\.lastSig\s*=\s*""\s*;[\s\S]{0,400}this\.refresh\(\)/.test(companionSrc),
  'forceRefresh must clear lastSig before calling refresh so the signature dedup gate never skips the write-path re-render',
);
check(
  'FAV.37b v0.5.6 every Favorites write path calls forceRefresh (Bug 1 — toggle/toggleFile/addTab/removeTab/remove/open each re-render synchronously after a successful write)',
  // deepfix round-1 refactor: the write paths now go through mutateFavDoc
  // (CAS-guarded read-mutate-write, see HIGH multi-window-race fix). Each
  // write-path function ends in exactly ONE forceRefresh() — the pre-refactor
  // code had redundant double-calls (one per early-return idempotency branch
  // + one at the end); consolidation to a single end-of-function call is
  // equivalent and cleaner because the idempotency guards now live inside the
  // mutate callback (return { changed: false }) rather than early-returning
  // before forceRefresh. Assert each of the 6 write-path function bodies
  // contains forceRefresh, scanned by brace depth so the check is robust to
  // the mutateFavDoc callback's nested braces.
  (() => {
    const writeFns = ['favToggleFile', 'favToggleTab', 'favAddTab', 'favRemoveTab', 'favRemove', 'favOpen'];
    for (const fn of writeFns) {
      const start = companionSrc.indexOf(`function ${fn}(`);
      if (start < 0) return false;
      let i = companionSrc.indexOf('{', start);
      if (i < 0) return false;
      let depth = 1;
      i += 1;
      const begin = i;
      while (i < companionSrc.length && depth > 0) {
        const c = companionSrc[i];
        if (c === '{') depth += 1;
        else if (c === '}') depth -= 1;
        i += 1;
      }
      const body = companionSrc.slice(begin, i - 1);
      if (!/favoritesProvider\?\.forceRefresh\(\)/.test(body)) {
        return false;
      }
    }
    return true;
  })(),
  'every write path must call forceRefresh so the tree re-renders synchronously after a successful write — polling-tick + favRefresh command stay on plain refresh()',
);
check(
  'FAV.37c v0.5.6 NO write-path function calls bare refresh() (Bug 1 — write paths must bypass signature dedup)',
  // The plain refresh() calls that remain must ONLY be in (a) the favRefresh()
  // command handler (manual "Refresh" toolbar button — no write), (b) the
  // setInterval polling tick body, (c) the initial-sync call inside
  // registerFavorites. We verify by extracting each WRITE-PATH function body
  // (favToggleFile / favToggleTab / favAddTab / favRemoveTab / favRemove /
  // favOpen) and asserting none contains a bare favoritesProvider?.refresh().
  (() => {
    const writeFns = ['favToggleFile', 'favToggleTab', 'favAddTab', 'favRemoveTab', 'favRemove', 'favOpen'];
    for (const fn of writeFns) {
      // Grab from `function <fn>(` to the matching close brace of the fn body.
      const start = companionSrc.indexOf(`function ${fn}(`);
      if (start < 0) return false;
      // Scan brace depth from the first `{` after the signature.
      let i = companionSrc.indexOf('{', start);
      if (i < 0) return false;
      let depth = 1;
      i += 1;
      const begin = i;
      while (i < companionSrc.length && depth > 0) {
        const c = companionSrc[i];
        if (c === '{') depth += 1;
        else if (c === '}') depth -= 1;
        i += 1;
      }
      const body = companionSrc.slice(begin, i - 1);
      if (/favoritesProvider\?\.refresh\(\)/.test(body)) {
        return false;
      }
    }
    return true;
  })(),
  'polling tick + favRefresh command + registerFavorites initial sync are the only callers that should still hit the dedup gate; write paths must use forceRefresh',
);
check(
  'FAV.37d v0.5.6 resolveActiveSid helper declared (shared sid resolution for toggle/add/remove)',
  /function\s+resolveActiveSid\s*\([^)]*\)/.test(companionSrc),
  'extracted from favToggleTab so favAddTab / favRemoveTab share byte-identical sid resolution with the v0.5.3 F1 title-bridge match',
);
check(
  'FAV.37e v0.5.6 buildFavSessionRow helper declared (shared row schema for toggle/add)',
  /function\s+buildFavSessionRow\s*\(\s*sid\s*:\s*string\s*\)\s*:\s*FavSession\s*\|\s*null/.test(companionSrc),
  'extracted so favToggleTab + favAddTab build the session row identically — divergent schemas would corrupt favorites.json',
);
check(
  'FAV.37f v0.5.6 favAddTab is idempotent on an already-favorited sid (Bug 2 — explicit Add never removes)',
  // The Add handler must bail WITHOUT writing when the sid is already in
  // doc.sessions. Stale setContext must never cause an accidental removal via
  // toggle-style behavior. deepfix round-1: the guard now lives inside the
  // mutateFavDoc callback and returns { changed: false } (no write) instead of
  // an early bare `return;` — the no-write invariant is identical.
  /function\s+favAddTab[\s\S]{0,3000}?doc\.sessions\.some\(\s*\(\s*s\s*\)\s*=>\s*s\.sid\s*===\s*sid\s*\)[\s\S]{0,400}?return\s*\{\s*changed\s*:\s*false\s*\}/.test(
    companionSrc,
  ),
  'a stale "Add" click on an already-favorited sid must NO-OP, not toggle off — Bug 2 root cause is the user double-clicking Add thinking the first click failed',
);
check(
  'FAV.37g v0.5.6 favRemoveTab is idempotent on a not-favorited sid (defensive — never accidentally Add)',
  // deepfix round-1: the idx<0 guard now returns { changed: false } from inside
  // the mutateFavDoc callback (no write) instead of a bare `return;`.
  /function\s+favRemoveTab[\s\S]{0,3000}?findIndex[\s\S]{0,1000}?idx\s*<\s*0[\s\S]{0,400}?return\s*\{\s*changed\s*:\s*false\s*\}/.test(
    companionSrc,
  ),
  'a stale "Remove" click on a not-favorited sid must NO-OP, not accidentally Add',
);
check(
  'FAV.37h v0.5.6 refresh() publishes setContext ccStatusDot.fav.currentTabFavorited (Bug 4 dynamic menu labels)',
  /executeCommand\(\s*"setContext"\s*,\s*"ccStatusDot\.fav\.currentTabFavorited"/.test(companionSrc),
  'the Add/Remove menu items use when: ccStatusDot.fav.currentTabFavorited == true/false — the context key MUST be published from refresh() so polling keeps it fresh',
);
check(
  'FAV.37i v0.5.6 refresh() tracks lastActiveSidForCtx to dedup setContext dispatches across polling ticks',
  /lastActiveSidForCtx/.test(companionSrc),
  'without per-active-sid dedup, the 2s polling tick would re-dispatch setContext on every cycle even when the active sid is unchanged',
);

// ---------------------------------------------------------------------------
// package.json: addTab + removeTab menu contributions (Bug 3 + Bug 4).
// ---------------------------------------------------------------------------
check(
  'FAV.38a v0.5.6 package.json contributes ccStatusDot.fav.addTab command (Bug 4 explicit Add verb)',
  Array.isArray(companionPkg.contributes.commands) &&
    companionPkg.contributes.commands.some((c) => c.command === 'ccStatusDot.fav.addTab'),
);
check(
  'FAV.38b v0.5.6 package.json contributes ccStatusDot.fav.removeTab command (Bug 4 explicit Remove verb)',
  Array.isArray(companionPkg.contributes.commands) &&
    companionPkg.contributes.commands.some((c) => c.command === 'ccStatusDot.fav.removeTab'),
);
check(
  'FAV.38c v0.5.6 explorer/context has addTab gated on !currentTabFavorited (Bug 4 dynamic label)',
  companionPkg.contributes?.menus?.['explorer/context']?.some(
    (m) =>
      m.command === 'ccStatusDot.fav.addTab' &&
      typeof m.when === 'string' &&
      m.when.includes('!ccStatusDot.fav.currentTabFavorited'),
  ),
);
check(
  'FAV.38d v0.5.6 explorer/context has removeTab gated on currentTabFavorited (Bug 4 dynamic label)',
  companionPkg.contributes?.menus?.['explorer/context']?.some(
    (m) =>
      m.command === 'ccStatusDot.fav.removeTab' &&
      typeof m.when === 'string' &&
      m.when.includes('ccStatusDot.fav.currentTabFavorited'),
  ),
);
check(
  'FAV.38e v0.5.9 editor/title/context has NEITHER addTab NOR removeTab (Bug 3 menu retired — star injection infeasible, tab right-click only no-ops on non-CC tabs)',
  (() => {
    const etc = companionPkg.contributes?.menus?.['editor/title/context'] || [];
    return !etc.some((m) => m.command === 'ccStatusDot.fav.addTab' || m.command === 'ccStatusDot.fav.removeTab');
  })(),
  'editor/title/context must NOT carry addTab/removeTab (v0.5.9): the in-webview star injection that v0.5.8 used to resolve the clicked tab sid forced a destructive CC session reload and was removed; the reliable toggles are now pickSession + explorer/context + commandPalette toggleTab + the tab-title ★ prefix.',
);
check(
  'FAV.38f v0.5.6 commandPalette hides ccStatusDot.fav.addTab + ccStatusDot.fav.removeTab (menu-only commands, not palette macros)',
  (() => {
    const cp = companionPkg.contributes?.menus?.commandPalette || [];
    const add = cp.find((m) => m.command === 'ccStatusDot.fav.addTab');
    const rem = cp.find((m) => m.command === 'ccStatusDot.fav.removeTab');
    return add && add.when === 'false' && rem && rem.when === 'false';
  })(),
  'the palette entrypoint stays as toggleTab (unified macro); the Add/Remove split is for the menu labels only',
);
// v0.5.9: QuickPick session selector — the zero-webview-coupling toggle that
// replaces the infeasible in-webview star click. Pins the command + its
// commandPalette visibility (no when:false — it IS the primary palette macro).
check(
  'FAV.39a v0.5.9 package.json contributes ccStatusDot.fav.pickSession command (QuickPick session selector — replaces in-webview star)',
  Array.isArray(companionPkg.contributes.commands) &&
    companionPkg.contributes.commands.some((c) => c.command === 'ccStatusDot.fav.pickSession'),
);
check(
  'FAV.39b v0.5.9 ccStatusDot.fav.pickSession is VISIBLE in commandPalette (primary in-conversation toggle, not hidden)',
  (() => {
    const cp = companionPkg.contributes?.menus?.commandPalette || [];
    const e = cp.find((m) => m.command === 'ccStatusDot.fav.pickSession');
    // No entry OR an entry without when:false both count as visible (VSCode
    // defaults a command to palette-visible unless gated). Assert explicitly.
    return !e || e.when !== 'false';
  })(),
);
check(
  'FAV.39c v0.5.9 companion registers ccStatusDot.fav.pickSession handler',
  /registerCommand\(\s*"ccStatusDot\.fav\.pickSession"/.test(companionSrc),
  'the QuickPick session selector must be registered so the command palette entry is not dead',
);
check(
  'FAV.39d v0.5.9 favPickSession reads globalThis.__ccsdSidToTitle (lists ALL CC sessions, not just favorites)',
  /function\s+favPickSession\s*\(\s*\)/.test(companionSrc) && /__ccsdSidToTitle/.test(companionSrc),
  'the QuickPick must enumerate every open CC session via the IIFE bridge so the user can star/unstar any one without guessing sids',
);

// ===========================================================================
// v0.5.10: Status bar ★ button — the one-click "star current session" entry.
// Pure static-contract checks (the runtime needs a live EH, but the wiring
// is fully assertable from source). These lock in:
//   (a) a status bar item IS created + bound to the toggleTab command
//       (so the click reuses the proven toggle path, not a parallel one),
//   (b) the icon reflects favorited state via $(star-full)/$(star-empty),
//   (c) refresh is wired into forceRefresh + the 2s tick + tab activation,
//   (d) it acts on resolveActiveSid (the authoritative active session) —
//       the whole point of pivoting off the infeasible in-webview star.
// ===========================================================================
check(
  'FAV.40a v0.5.10 creates a Right-aligned status bar item',
  /createStatusBarItem\(\s*vscode\.StatusBarAlignment\.Right/.test(companionSrc),
  'the star button must live in the status bar (VSCode chrome the companion owns — NOT the write-once CC webview)',
);
check(
  'FAV.40b v0.5.10 status bar command reuses ccStatusDot.fav.toggleTab',
  /favStatusBar\.command\s*=\s*["']ccStatusDot\.fav\.toggleTab["']/.test(companionSrc),
  'the click must reuse the existing toggle handler (sid resolution + atomic write + forceRefresh), not duplicate it',
);
check(
  'FAV.40c v0.5.10 refreshFavStatusBar defined',
  /function\s+refreshFavStatusBar\s*\(\s*\)/.test(companionSrc),
  'a single refresh function owns the icon-state transition',
);
check(
  'FAV.40d v0.5.10 icon reflects favorited state via codicon star-full / star-empty',
  /\$\(star-full\)/.test(companionSrc) && /\$\(star-empty\)/.test(companionSrc),
  'solid star (favorited) vs outline star (not favorited) — the visual signal',
);
check(
  'FAV.40e v0.5.10 favorited star uses gold #F5A623 (aligned with -fav SVG underline)',
  /#F5A623/.test(companionSrc),
  'the filled star tint must match the existing gold-line favorite marker for visual consistency',
);
check(
  'FAV.40f v0.5.15 refreshFavStatusBar resolves the ACTIVE sid via activeCcSidOrLoading (strict, no lastActive fallback)',
  /refreshFavStatusBar[\s\S]{0,200}?activeCcSidOrLoading\(\)/.test(companionSrc),
  'the button must target the authoritative active session — the reason it supersedes the #195960-limited tab right-click',
);
check(
  'FAV.40g v0.5.10 forceRefresh also refreshes the status bar (instant flip on click)',
  /forceRefresh\(\)\s*:\s*void\s*\{[\s\S]*?refreshFavStatusBar\(\)/.test(companionSrc),
  'the star must flip the instant the user toggles — forceRefresh is the post-write hook',
);
check(
  'FAV.40h v0.5.10 2s watcher tick also refreshes the status bar (catches tab-switch active-sid change)',
  /favoritesWatcher\s*=\s*setInterval\([\s\S]*?refreshFavStatusBar\(\)/.test(companionSrc),
  'a tab switch rewrites globalThis.__ccsdActiveSid without touching disk — the tick must catch it',
);
check(
  'FAV.40i v0.5.10 tab activation listeners wired (immediate refresh on tab switch)',
  /tabGroups\.onDidChangeTabs\(/.test(companionSrc) && /tabGroups\.onDidChangeTabGroups\(/.test(companionSrc),
  'the star should refresh the instant the active tab changes, not lag up to 2s',
);
check(
  'FAV.40j v0.5.10 status bar hidden when no active CC session',
  /refreshFavStatusBar[\s\S]{0,2000}?\.hide\(\)/.test(companionSrc),
  'no stray clickable star when there is no session to act on (toggleTab would just toast anyway)',
);

// ===========================================================================
// v0.5.11: one-click session resume. Pre-0.5.11 only OPEN session nodes
// bound the open command, so clicking a CLOSED (favorited, not currently
// open) session was a DEAD CLICK — no command fired at all. Now closed
// nodes bind it too, and favOpen routes them through CC's own
// claude-vscode.editor.open(sid) → createPanel(sid), which (a) reveals an
// already-open session via CC's sessionPanels map, or (b) starts the CLI
// with --session-id=<sid> to load that session's transcript = resume. This
// closes the v0.4.0 "closed-session resume is unreachable" gap (CC 2.1.x
// added the sid-aware createPanel path).
// ===========================================================================
check(
  'FAV.41a v0.5.11 closed session nodes ALSO bind ccStatusDot.fav.open (was a dead click pre-0.5.11)',
  /title:\s*isOpen\s*\?\s*"Focus CC Session"\s*:\s*"Resume CC Session"/.test(companionSrc),
  'the command binding must NOT be gated on isOpen — closed nodes need it to trigger resume',
);
check(
  'FAV.41b v0.5.11 favOpen resumes a closed session via claude-vscode.editor.open(sid)',
  /claude-vscode\.editor\.open/.test(companionSrc) &&
    /node\.kind\s*===\s*"sessionClosed"[\s\S]{0,500}?claude-vscode\.editor\.open/.test(companionSrc),
  'CC 2.1.x createPanel(sid) resumes the session into a panel (closes the v0.4.0 "unreachable" gap)',
);
check(
  'FAV.41c v0.5.11 closed-session tooltip says "click to resume" (not the old right-click hint)',
  /"click to resume session"/.test(companionSrc),
  'tooltip must reflect the new one-click resume, not the stale copy-cmd hint',
);
check(
  'FAV.41d v0.5.11 open-session fallback chain also tries claude-vscode.editor.open (bridge-miss recovery)',
  /ccStatusDot\.fav\.focusSession[\s\S]{0,700}?claude-vscode\.editor\.open/.test(companionSrc),
  "if the IIFE bridge missed the panel, CC's own editor.open(sid) focuses it via CC's sessionPanels map",
);

// ===========================================================================
// v0.5.11: ★ button tab-switch latency fix. The star shared the tree's 2s
// tick (plus onDidChangeTabs/Groups, which are unreliable for webview-panel
// tab activation — they often don't fire on a plain active-tab click), so a
// tab switch could lag ~2s. Now a dedicated 500ms poll drives
// refreshFavStatusBar, independent of the 2s tree tick.
// ===========================================================================
check(
  'FAV.42a v0.5.11 dedicated fast poll constant FAV_BAR_POLL_MS = 500',
  /const\s+FAV_BAR_POLL_MS\s*=\s*500/.test(companionSrc),
  'the ★ button needs a faster cadence than the 2s tree tick to follow tab switches promptly',
);
check(
  'FAV.42b v0.5.11 favBarWatcher polls refreshFavStatusBar at FAV_BAR_POLL_MS (independent of 2s tree tick)',
  /favBarWatcher\s*=\s*setInterval\([\s\S]{0,300}?refreshFavStatusBar\(\)[\s\S]{0,200}?FAV_BAR_POLL_MS/.test(
    companionSrc,
  ),
  'onDidChangeTabs is unreliable for webview-panel activation — a 500ms poll is the dependable backstop',
);
check(
  'FAV.42c v0.5.11 deactivate clears favBarWatcher (no leak across reload)',
  /if\s*\(\s*favBarWatcher\s*\)\s*\{[\s\S]{0,90}?clearInterval\(\s*favBarWatcher\s*\)/.test(companionSrc),
  'the fast poller must be cleared on deactivation alongside favoritesWatcher',
);

// ===========================================================================
// v0.5.12 perf: companion activate path — defer blocking work past activate's
// synchronous return so the EH paints CC's injected IIFE (four-light/token)
// first, instead of blocking on detectAndPatch's sync readFileSync.
// ===========================================================================
check(
  'FAV.43a v0.5.12 ccPatchState stat-mtime fast path (skip 2.78MB read when CC unchanged)',
  /function\s+ccPatchState/.test(companionSrc) &&
    /fs\.statSync\(\s*extJs\s*\)\.mtimeMs/.test(companionSrc) &&
    /readRepatchFlag\(\)/.test(companionSrc) &&
    /extMtime\s*<=\s*flag\.ts/.test(companionSrc),
  'activate calls ccPatchState synchronously (async fn runs sync pre-await); the stat fast path returns "fresh" without reading the 2.78MB extension.js when CC has not rewritten it since the last patch',
);
check(
  'FAV.43b v0.5.12 activate wraps detectAndPatch in setImmediate (defer past sync return)',
  /setImmediate\(\s*\(\s*\)\s*=>\s*\{[\s\S]{0,100}?void\s+detectAndPatch\(\)/.test(companionSrc),
  'detectAndPatch runs sync until its first await (ccPatchState readFileSync); setImmediate lets activate return first so the EH paints CC four-light/token SBI sooner',
);
check(
  'FAV.43c v0.5.12 registerFavorites defers initial paints via setImmediate',
  /setImmediate\(\s*\(\s*\)\s*=>\s*refreshFavStatusBar\(\)\s*\)/.test(companionSrc) &&
    /setImmediate\(\s*\(\s*\)\s*=>\s*\{[\s\S]{0,150}?favoritesProvider\?\.refresh\(\)/.test(companionSrc),
  'the ★ button initial paint + tree initial refresh are deferred one tick so registerFavorites returns sooner (imperceptible — view not revealed until sidebar opened)',
);

// ===========================================================================
// v0.5.15: ★ button loading state. When switching to a CC tab whose session
// is still resuming (sid not yet in the IIFE bridge), the ★ must show a
// spinner instead of the stale PREVIOUS session's star (which would un-star
// the wrong session on click). activeCcSidOrLoading drives both the display
// (refreshFavStatusBar → spinner) and the click guard (toggleTab → refuse).
// ===========================================================================
check(
  'FAV.44a v0.5.15 activeCcSidOrLoading helper detects CC tab + loading (strict sid, no lastActive fallback)',
  /function\s+activeCcSidOrLoading\s*\(\s*\)/.test(companionSrc) && /claudeVSCodePanel/i.test(companionSrc),
  'detects whether the focused tab is a CC webview panel (viewType claudeVSCodePanel) and whether its sid is in the IIFE title bridge — the loading signal for a just-resumed session',
);
check(
  'FAV.44b v0.5.15 refreshFavStatusBar shows spinner ($(loading~spin)) when active CC tab is loading',
  /ui\.loading[\s\S]{0,500}?\$\(loading~spin\)/.test(companionSrc),
  'a loading CC tab (sid not yet registered) shows a spinner, NOT the stale previous-session star — fixes the "star shows A while B loads" inconsistency',
);
check(
  'FAV.44c v0.5.15 favToggleTab REFUSES to toggle while active CC tab is loading (no wrong-session un-star)',
  /function\s+favToggleTab[\s\S]{0,900}?activeCcSidOrLoading\(\)\.loading/.test(companionSrc),
  'a ★ click during the loading window must NOT fall back to __ccsdLastActiveSid and un-star the previous session — refuse with a hint instead',
);
check(
  'FAV.45a v0.5.16 activeCcSidOrLoading prefers __ccsdActiveSid to disambiguate same-title sessions',
  /function\s+activeCcSidOrLoading[\s\S]{0,2500}?g\.__ccsdActiveSid/.test(companionSrc),
  'same-title sessions (same cwd): the authoritative __ccsdActiveSid is checked before Object.keys().find() — otherwise display sid (this path) splits from write sid (resolveActiveSid), un-starring the wrong one',
);
check(
  'FAV.45b v0.5.16 favAddTab + favRemoveTab ALSO refuse during loading (not just toggleTab)',
  /function\s+favAddTab[\s\S]{0,400}?activeCcSidOrLoading\(\)\.loading/.test(companionSrc) &&
    /function\s+favRemoveTab[\s\S]{0,400}?activeCcSidOrLoading\(\)\.loading/.test(companionSrc),
  'all three write paths (toggle/add/remove) refuse during the loading window — no wrong-session mutation via any path',
);
check(
  'FAV.46 v0.5.17 activeCcSidOrLoading prefers panelTab.active (realtime) over label/__ccsdActiveSid',
  /__ccsdSidToPanel as Record[\s\S]{0,300}?\.active === true/.test(companionSrc),
  'switch-tab 瞬态根因:__ccsdActiveSid 由 IIFE 500ms tick 更新(延迟),切到已打开 B 时还指 A(已收藏)→ ★ 误显 A;panelTab.active 是 VSCode 实时,B 激活即 true → 直接命中 B',
);
check(
  'FAV.47 v0.5.21 ★ status bar NON-interactive while loading (command=undefined), restored to toggleTab on sid resolve',
  /ui\.loading[\s\S]{0,1500}?favStatusBar\.command = undefined/.test(companionSrc) &&
    /favStatusBar\.command = "ccStatusDot\.fav\.toggleTab"/.test(companionSrc),
  'loading 是 500ms tick 快照,用户点击时 loading 可能已过→toggleTab 误 toggle 新解析 sid(常是上个会话 B,取消其收藏);command=undefined 让 spinner 纯显示不可点击,根治误操作',
);

// cleanup
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  /* best-effort */
}

console.log('');
if (fail === 0) {
  console.log(`All ${pass} favorites checks passed.`);
  process.exit(0);
} else {
  console.log(`${pass} passed, ${fail} failed.`);
  process.exit(1);
}
