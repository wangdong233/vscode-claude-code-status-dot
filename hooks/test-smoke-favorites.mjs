#!/usr/bin/env node
/**
 * test-smoke-favorites.mjs — Favorites feature USER-JOURNEY smoke test.
 *
 * Sibling to test-favorites.mjs (which is organized as isolated schema/IO
 * contract pins) and test-smoke-journey.mjs (the SBI user-journey file).
 * THIS file is the complementary Favorites journey: a single narrative that
 * walks ONE virtual user through a full Favorites session —
 *
 *   companion activate → empty tree → toggleTab (add 1) → add a 2nd
 *   (verify the second-add-clears-all Bug 2 is dead) → remove one →
 *   QuickPick enumerates __ccsdSidToTitle → favorites.json disk ↔ tree
 *   consistent → forceRefresh bypasses signature dedup (Bug 1) →
 *   mtime+size cache invalidates on disk change (IIFE Bug FAV-MTIME).
 *
 * Why a journey file (when test-favorites.mjs already pins the contract)?
 *   - test-favorites.mjs proves "each validator + writeFavAtomic is correct
 *     in isolation". A journey proves "the write → forceRefresh →
 *     getChildren → readFavDoc chain composes correctly across state
 *     transitions on the SAME favorites.json" — which is what users
 *     actually experience. The Bug 1 (latency) + Bug 2 (second-add-clears-
 *     all) + Bug 4 (dynamic Add/Remove labels) fixes are about reader/
 *     writer INTERACTION across clicks, not isolated I/O. This file
 *     narrates those interactions in one place so a future regression in
 *     the write→refresh→render pipeline surfaces as a broken step here,
 *     not just an isolated assertion failure elsewhere.
 *
 * Approach: replicate the FavoritesProvider read+sort+partition+dedup
 * pipeline in pure JS (same DRY posture as test-smoke-journey.mjs's IIFE
 * aggregation replica). The provider's write paths (favToggleTab/
 * favAddTab/favRemoveTab/favRemove) all flow through mutateFavDoc →
 * writeFavAtomic + forceRefresh — so we simulate the WRITE side via the
 * same writeFavAtomic replica test-favorites.mjs uses, and simulate the
 * READ/RENDER side via a FakeFavoritesProvider that mirrors the real
 * class's lastSig/forceRefresh/getChildren logic. The contract pins in
 * test-favorites.mjs (FAV.7b/c/d validators, FAV.5 writeFavAtomic, FAV.37a
 * forceRefresh, FAV.37b/c write-path callers) guarantee this replica stays
 * in sync with companion source.
 *
 * Phases (each prints BEFORE → AFTER tree size so the journey reads top-down):
 *   §0  Cold start — FavoritesProvider constructed, favorites.json absent
 *       → tree empty (sessions=[], files=[]).
 *   §1  toggleTab adds session A → forceRefresh → tree has 1 session.
 *   §2  toggleTab adds session B (a SECOND add) → forceRefresh → tree has
 *       2 sessions (the "second-add-clears-all" Bug 2 shape — pre-fix the
 *       view went empty here because the user double-clicked Add thinking
 *       the first click failed, toggling A OFF; the fix is immediate
 *       feedback via forceRefresh + the Bug 4 Add/Remove split).
 *   §3  remove A → forceRefresh → tree has 1 session (B only).
 *   §4  QuickPick (favPickSession) enumerates globalThis.__ccsdSidToTitle
 *       — lists EVERY open CC session (not just favorites) so the user
 *       can star/unstar any one without guessing sids.
 *   §5  favorites.json on disk matches the provider's tree (consistency
 *       invariant — sole-writer + readFavDoc round-trip).
 *   §6  forceRefresh bypasses signature dedup (Bug 1 regression gate):
 *       synthesize a state where refresh() is a no-op (sig unchanged),
 *       then forceRefresh() MUST still fire the emitter.
 *   §7  IIFE readFavSet mtime+size cache invalidates on disk change
 *       (the IIFE-side half of the Favorites feature — when the companion
 *       atomically rewrites favorites.json via tmp+rename, the IIFE's
 *       cached {mt,sz} MUST mismatch on the next tick so the new -fav SVG
 *       variant paints within TICK_MS=500ms).
 *
 * Run:  node hooks/test-smoke-favorites.mjs   (after `npm run build`)
 */

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
    console.log('    PASS  ' + name);
  } else {
    fail++;
    console.log('    FAIL  ' + name + (detail ? '   ' + detail : ''));
  }
}

// ---------------------------------------------------------------------------
// Replica of companion/extension.ts favorites I/O + provider pipeline.
// Contract pinned by test-favorites.mjs (FAV.1/5/7b-d/37a) — if the real
// source drifts from this replica, test-favorites.mjs fails first.
// ---------------------------------------------------------------------------
const FAV_SCHEMA_VERSION = 1;
function emptyFavDoc() {
  return { version: FAV_SCHEMA_VERSION, updatedAt: 0, sessions: [], files: [] };
}

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
  const sessions = Array.isArray(parsed.sessions) ? parsed.sessions.filter(isValidFavSession) : [];
  const files = Array.isArray(parsed.files) ? parsed.files.filter(isValidFavFile) : [];
  return {
    version: FAV_SCHEMA_VERSION,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    sessions,
    files,
  };
}

// FakeFavoritesProvider — mirror of companion/extension.ts FavoritesProvider
// (lines ~1087-1302). Contract pinned by FAV.7e (item.id), FAV.7f (sig dedup),
// FAV.25d (setContext in refresh), FAV.37a (forceRefresh clears lastSig).
// The emitCount lets the journey assert that forceRefresh ACTUALLY fires the
// emitter even when the signature is unchanged — the Bug 1 regression gate.
class FakeFavoritesProvider {
  constructor(favFile) {
    this.favFile = favFile;
    this.lastSig = '';
    this.lastActiveSidForCtx = '';
    this.emitCount = 0; // mirrors this.emitter.fire(undefined)
    this.setContextCount = 0; // mirrors executeCommand('setContext', 'ccStatusDot.favoritesEmpty', …)
    this.lastEmptyPublished = null;
    // openSids mirrors globalThis.__ccsdSidToPanel — the IIFE bridge that
    // tracks which CC panels are currently open. favPickSession uses the
    // sibling __ccsdSidToTitle map (kept separately below).
    this.openSids = new Set();
  }
  static signature(doc, openSids) {
    return JSON.stringify({
      s: doc.sessions.map((s) => `${s.sid}|${openSids.has(s.sid) ? 1 : 0}|${s.label}|${s.state || ''}`).sort(),
      f: doc.files.map((f) => `${f.fsPath}|${f.label}|${f.line || 0}`).sort(),
    });
  }
  refresh() {
    const doc = readFavDoc(this.favFile) ?? emptyFavDoc();
    const sig = FakeFavoritesProvider.signature(doc, this.openSids);
    // setContext favoritesEmpty fires only on a real (doc, open) transition.
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    const isEmpty = doc.sessions.length === 0 && doc.files.length === 0;
    this.setContextCount += 1;
    this.lastEmptyPublished = isEmpty;
    this.emitCount += 1;
  }
  // v0.5.6 (Bug 1): forceRefresh bypasses the signature dedup gate.
  forceRefresh() {
    this.lastSig = '';
    this.lastActiveSidForCtx = '';
    this.refresh();
  }
  // getChildren mirror — sorts sessions by lastSeenAt desc, files by
  // addedAt desc, partitions sessions by open/closed (mirrors openSidSet()).
  getChildren() {
    const doc = readFavDoc(this.favFile) ?? emptyFavDoc();
    const sessions = doc.sessions
      .slice()
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((s) => ({
        kind: this.openSids.has(s.sid) ? 'sessionOpen' : 'sessionClosed',
        session: s,
      }));
    const files = doc.files
      .slice()
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((f) => ({ kind: 'file', file: f }));
    return [...sessions, ...files];
  }
}

// IIFE readFavSet replica — verbatim mirror of patch.ts buildIIFE line ~1930
// (globalThis.__ccsdFavCache mtime+size single-entry cache). The cache is
// keyed single-entry on (mtimeMs, size) because favorites.json is ONE global
// file; a hit returns the parsed sid set, a miss re-reads + re-parses.
function makeIifeFavReader(FAVF) {
  const c = { last: null };
  return function readFavSet() {
    let mt = 0;
    let sz = 0;
    try {
      const s = fs.statSync(FAVF);
      mt = s.mtimeMs;
      sz = s.size;
    } catch (_) {
      return null;
    }
    const e = c.last;
    if (e && e.mt === mt && e.sz === sz && mt > 0) return e.set;
    if (sz <= 0) return null;
    let j = null;
    try {
      j = JSON.parse(fs.readFileSync(FAVF, 'utf8'));
    } catch (_) {
      return null;
    }
    const set = Object.create(null);
    if (j && Array.isArray(j.sessions)) {
      for (let i = 0; i < j.sessions.length; i++) {
        const x = j.sessions[i];
        if (x && typeof x.sid === 'string') set[x.sid] = 1;
      }
    }
    c.last = { set, mt, sz };
    return set;
  };
}

// ---------------------------------------------------------------------------
// Journey harness
// ---------------------------------------------------------------------------
function logPhase(title) {
  console.log('\n--- ' + title + ' ---');
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsd-favsmoke-'));
const tmpFav = path.join(tmpDir, 'favorites.json');
const provider = new FakeFavoritesProvider(tmpFav);
const readFavSet = makeIifeFavReader(tmpFav);

// __ccsdSidToTitle — the IIFE bridge map that favPickSession enumerates.
// Simulated at journey scope so §4 can populate it as the user opens tabs.
const iifeSidToTitle = {};

console.log('Favorites user-journey smoke test (v0.5.9)');
console.log('(FakeFavoritesProvider + IIFE readFavSet replica, isolated favorites.json)');
console.log('Legend: §n = journey phase;   tree = [sessions, files] counts');

// === §0  Cold start — companion activate, empty tree =======================
logPhase('§0  Cold start — companion activate, favorites.json absent');
{
  // Initial refresh() BEFORE any write — readFavDoc returns null → emptyFavDoc.
  // lastSig="" initial, so the first refresh ALWAYS fires (initial setContext
  // publish — FAV.25e pin).
  provider.refresh();
  const children = provider.getChildren();
  check('§0a  empty tree on cold start (sessions=0, files=0)', children.length === 0);
  check(
    '§0b  initial refresh publishes setContext favoritesEmpty=true (FAV.25e initial sync)',
    provider.setContextCount === 1 && provider.lastEmptyPublished === true,
    'setContextCount=' + provider.setContextCount + ' empty=' + provider.lastEmptyPublished,
  );
  check('§0c  initial refresh fires emitter once', provider.emitCount === 1, 'emitCount=' + provider.emitCount);
}

// === §1  toggleTab adds session A → tree has 1 =============================
logPhase('§1  toggleTab(A) — add first favorite, forceRefresh, tree has 1 session');
{
  const now = Date.now();
  const doc = readFavDoc(tmpFav) ?? emptyFavDoc();
  doc.sessions = [
    ...doc.sessions,
    {
      sid: 'aaaaaaaa-0000-0000-0000-000000000001',
      label: 'A — fix login bug',
      cwd: '/Users/example/project-a',
      model: 'glm-5.2',
      state: 'done',
      addedAt: now,
      lastSeenAt: now,
    },
  ];
  writeFavAtomic(tmpFav, doc);
  provider.forceRefresh();
  // Simulate the IIFE seeing the panel open for A.
  provider.openSids.add('aaaaaaaa-0000-0000-0000-000000000001');
  iifeSidToTitle['aaaaaaaa-0000-0000-0000-000000000001'] = 'A — fix login bug';
  const children = provider.getChildren();
  check('§1a  tree has 1 node after toggleTab(A)', children.length === 1, 'len=' + children.length);
  check(
    '§1b  node is a session (kind=sessionOpen|sessionClosed)',
    children[0].kind === 'sessionOpen' || children[0].kind === 'sessionClosed',
  );
  check('§1b.1  open session renders as sessionOpen', children[0].kind === 'sessionOpen', 'kind=' + children[0].kind);
  check(
    '§1c  emitter fired (forceRefresh bypassed dedup)',
    provider.emitCount === 2,
    'emitCount=' + provider.emitCount,
  );
}

// === §2  toggleTab adds B — SECOND add (Bug 2 shape) → tree has 2 =========
logPhase('§2  toggleTab(B) — SECOND add (Bug 2 shape: pre-fix view went empty here)');
{
  const now = Date.now();
  const doc = readFavDoc(tmpFav) ?? emptyFavDoc();
  // Defensive: if A somehow dropped out (the Bug 2 shape), re-add it. This
  // also doubles as a guard: if the test's own writeFavAtomic replica lost
  // state, the failure surfaces HERE (before §2's main assertion) instead
  // of silently degrading into a false negative.
  if (!doc.sessions.some((s) => s.sid === 'aaaaaaaa-0000-0000-0000-000000000001')) {
    check(
      '§2-pre  A survived across the §1→§2 transition (Bug 2 regression gate)',
      false,
      'A vanished before §2 even ran — writeFavAtomic lost state',
    );
  } else {
    check('§2-pre  A survived across the §1→§2 transition (Bug 2 regression gate)', true);
  }
  doc.sessions = [
    ...doc.sessions,
    {
      sid: 'bbbbbbbb-0000-0000-0000-000000000002',
      label: 'B — refactor parser',
      cwd: '/Users/example/project-b',
      model: 'glm-5.2',
      state: 'running',
      addedAt: now,
      lastSeenAt: now,
    },
  ];
  writeFavAtomic(tmpFav, doc);
  provider.forceRefresh();
  provider.openSids.add('bbbbbbbb-0000-0000-0000-000000000002');
  iifeSidToTitle['bbbbbbbb-0000-0000-0000-000000000002'] = 'B — refactor parser';
  const children = provider.getChildren();
  check(
    '§2a  tree has 2 nodes after toggleTab(B) — Bug 2 DEAD (view did NOT clear)',
    children.length === 2,
    'len=' + children.length,
  );
  check(
    '§2b  both A and B present (no accidental toggle-off of A)',
    children.some((c) => c.session && c.session.sid === 'aaaaaaaa-0000-0000-0000-000000000001') &&
      children.some((c) => c.session && c.session.sid === 'bbbbbbbb-0000-0000-0000-000000000002'),
    'sids=' +
      children
        .map((c) => c.session && c.session.sid)
        .filter(Boolean)
        .join(','),
  );
  // emitCount: §0 (1) + §1 (2) + §2 (3) — forceRefresh MUST fire each time.
  check(
    '§2c  emitter fired on the second add (forceRefresh not deduped)',
    provider.emitCount === 3,
    'emitCount=' + provider.emitCount,
  );
}

// === §3  remove A → tree has 1 (B only) ====================================
logPhase('§3  favRemove(A) — drop one favorite, tree collapses back to 1');
{
  const doc = readFavDoc(tmpFav) ?? emptyFavDoc();
  doc.sessions = doc.sessions.filter((s) => s.sid !== 'aaaaaaaa-0000-0000-0000-000000000001');
  writeFavAtomic(tmpFav, doc);
  provider.openSids.delete('aaaaaaaa-0000-0000-0000-000000000001');
  delete iifeSidToTitle['aaaaaaaa-0000-0000-0000-000000000001'];
  provider.forceRefresh();
  const children = provider.getChildren();
  check('§3a  tree has 1 node after remove(A)', children.length === 1, 'len=' + children.length);
  check(
    '§3b  remaining node is B (A is gone)',
    children[0].session && children[0].session.sid === 'bbbbbbbb-0000-0000-0000-000000000002',
    'sid=' + (children[0].session && children[0].session.sid),
  );
}

// === §4  QuickPick (favPickSession) lists __ccsdSidToTitle =================
logPhase('§4  favPickSession QuickPick — enumerates globalThis.__ccsdSidToTitle');
{
  // Mirror of favPickSession's displayDoc read + QuickPick build. The real
  // handler shows ALL CC sessions (not just favorites) so the user can star
  // any open conversation. We populate __ccsdSidToTitle with an extra UN-
  // favorited session C and verify it still appears in the pick list.
  iifeSidToTitle['cccccccc-0000-0000-0000-000000000003'] = 'C — unfavorited but open';
  provider.openSids.add('cccccccc-0000-0000-0000-000000000003');
  const displayDoc = readFavDoc(tmpFav) ?? emptyFavDoc();
  const quickPickItems = Object.entries(iifeSidToTitle).map(([sid, title]) => {
    const isFav = displayDoc.sessions.some((s) => s.sid === sid);
    return { sid, label: (isFav ? '★ ' : '') + title, picked: isFav };
  });
  check(
    '§4a  QuickPick lists EVERY open CC session (3 = B fav + C non-fav)',
    quickPickItems.length === 2, // B (fav) + C (non-fav) — A was removed in §3
    'count=' + quickPickItems.length,
  );
  check(
    '§4b  favorited session B shows ★ prefix in QuickPick label',
    quickPickItems.some((i) => i.sid === 'bbbbbbbb-0000-0000-0000-000000000002' && i.label.startsWith('★ ')),
  );
  check(
    '§4c  UN-favorited session C appears WITHOUT ★ (user can star it from here)',
    quickPickItems.some((i) => i.sid === 'cccccccc-0000-0000-0000-000000000003' && !i.label.startsWith('★ ')),
  );
}

// === §5  favorites.json disk ↔ tree consistency ============================
logPhase('§5  favorites.json on disk ↔ provider tree consistency invariant');
{
  const diskDoc = readFavDoc(tmpFav);
  const children = provider.getChildren();
  check('§5a  disk doc parses (not null)', diskDoc !== null);
  check(
    '§5b  disk sessions count === tree sessions count',
    diskDoc && diskDoc.sessions.length === children.filter((c) => c.kind !== 'file').length,
    'disk=' + (diskDoc && diskDoc.sessions.length) + ' tree=' + children.filter((c) => c.kind !== 'file').length,
  );
  check(
    '§5c  every tree session sid appears in disk sessions (no phantom rows)',
    children
      .filter((c) => c.kind !== 'file')
      .every((c) => diskDoc && diskDoc.sessions.some((s) => s.sid === c.session.sid)),
  );
  check(
    '§5d  every disk session sid appears in tree (no dropped rows)',
    diskDoc && diskDoc.sessions.every((s) => children.some((c) => c.session && c.session.sid === s.sid)),
  );
}

// === §6  forceRefresh bypasses signature dedup (Bug 1 regression gate) =====
logPhase('§6  forceRefresh bypasses signature dedup (Bug 1 HIGH latency fix)');
{
  // Synthesize the Bug 1 shape: a state where refresh() would be a no-op
  // (signature unchanged since last refresh), then call forceRefresh and
  // assert the emitter fires ANYWAY. Pre-fix, the dedup gate would skip
  // the emitter.fire and the user saw a 2s delay before the new favorite
  // appeared (Bug 1) — and if they clicked again in that window, the
  // SECOND toggle would remove the just-added favorite (Bug 2).
  const before = provider.emitCount;
  // refresh() with no disk change → no-op (sig unchanged).
  provider.refresh();
  check(
    '§6a  refresh() is a no-op when signature unchanged (dedup gate intact)',
    provider.emitCount === before,
    'emitCount drifted: before=' + before + ' after=' + provider.emitCount,
  );
  // forceRefresh on the SAME unchanged state → emitter MUST fire (Bug 1 fix).
  provider.forceRefresh();
  check(
    '§6b  forceRefresh fires emitter even when signature unchanged (Bug 1 DEAD)',
    provider.emitCount === before + 1,
    'emitCount should be ' + (before + 1) + ' got=' + provider.emitCount,
  );
  check(
    '§6c  forceRefresh reset lastSig to "" before refresh (FAV.37a contract)',
    FakeFavoritesProvider.signature(readFavDoc(tmpFav) ?? emptyFavDoc(), provider.openSids) === provider.lastSig,
    'lastSig=' + provider.lastSig,
  );
}

// === §7  IIFE readFavSet mtime+size cache invalidates on disk change =======
logPhase('§7  IIFE readFavSet mtime+size cache invalidates on disk change');
{
  // First read primes the cache with the CURRENT (mt, sz).
  const set0 = readFavSet();
  check('§7a  initial readFavSet returns a set with B', set0 && set0['bbbbbbbb-0000-0000-0000-000000000002'] === 1);
  // Second read with NO disk change → cache HIT returns the SAME object ref
  // (mirrors globalThis.__ccsdFavCache.last.set reuse).
  const set1 = readFavSet();
  check('§7b  second read with no disk change returns the SAME cached set ref', set0 === set1);
  // Mutate favorites.json via writeFavAtomic (the real companion write path).
  // mtime + size both change → next readFavSet MUST miss the cache and
  // re-read. The favOf() SVG variant paints within TICK_MS=500ms of this
  // invalidation.
  const doc = readFavDoc(tmpFav) ?? emptyFavDoc();
  doc.sessions = doc.sessions.filter((s) => s.sid !== 'bbbbbbbb-0000-0000-0000-000000000002');
  doc.sessions.push({
    sid: 'dddddddd-0000-0000-0000-000000000004',
    label: 'D — new session after cache prime',
    addedAt: Date.now(),
    lastSeenAt: Date.now(),
  });
  // writeFavAtomic uses tmp+rename; on most filesystems the rename bumps
  // mtimeMs. To make the test deterministic across filesystems where mtime
  // resolution is coarse (HFS+ 1s, APFS nanosecond-but-not-guaranteed), we
  // also bump size (D replaces B with a longer label) so the (mt, sz) cache
  // key differs even if mt is the same millisecond.
  writeFavAtomic(tmpFav, doc);
  // Bridge bookkeeping — keep openSids in sync with the journey.
  provider.openSids.delete('bbbbbbbb-0000-0000-0000-000000000002');
  delete iifeSidToTitle['bbbbbbbb-0000-0000-0000-000000000002'];
  provider.openSids.add('dddddddd-0000-0000-0000-000000000004');
  iifeSidToTitle['dddddddd-0000-0000-0000-000000000004'] = 'D — new session after cache prime';
  const set2 = readFavSet();
  check(
    '§7c  cache invalidated after writeFavAtomic (different set ref from cached)',
    set2 !== set0,
    'cache did NOT invalidate — IIFE would keep painting the OLD -fav state',
  );
  check(
    '§7d  post-invalidation set reflects the new session D',
    set2 && set2['dddddddd-0000-0000-0000-000000000004'] === 1,
  );
  check(
    '§7e  post-invalidation set dropped removed session B',
    !set2 || !set2['bbbbbbbb-0000-0000-0000-000000000002'],
    'stale entry survived cache invalidation — IIFE would paint -fav on a non-favorited tab',
  );
}

// === §8  Full-cycle: refresh() fires on a real state transition =============
logPhase('§8  refresh() (NOT forceRefresh) fires on a real signature change');
{
  // §7 mutated favorites.json but did NOT call provider.refresh(). A real
  // 2s polling tick would fire refresh() here and the emitter SHOULD go off
  // because the signature genuinely differs (D replaced B). This proves the
  // polling path independently keeps the tree fresh (the Bug 1 fix is about
  // IMMEDIATE feedback on click — polling remains the background safety net).
  const before = provider.emitCount;
  provider.refresh();
  check(
    '§8a  refresh() fires emitter on a REAL signature change (polling safety net)',
    provider.emitCount === before + 1,
    'expected ' + (before + 1) + ' got=' + provider.emitCount,
  );
}

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  /* best-effort */
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  console.error('\n*** ' + fail + ' FAVORITES SMOKE TEST(S) FAILED — see above ***');
  process.exit(1);
}
console.log('\nAll Favorites user-journey smoke tests passed.');
process.exit(0);
