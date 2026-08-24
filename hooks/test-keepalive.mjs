#!/usr/bin/env node
/**
 * test-keepalive.mjs — v0.5.51 behavioral gate for the transcript keep-alive.
 *
 * Tests the REAL compiled module (companion/dist/keepalive.js — run
 * `npm run build` in companion/ first) against temp dirs. No vscode import
 * by design. Rows:
 *  T1 snapshot survives a simulated CC retention sweep (unlink of the CC path)
 *  T2 restoreForClick resurrects the swept transcript (link + mtime freshen)
 *  T3 /compact rename-over-original → reconcile re-links to the fresh inode
 *  T4 mutex move (fav→arch) keeps protection (ownership = union)
 *  T5 unfavorite (sid leaves the union) → reconcile prunes the keepalive link
 *  T6 legacy backfill: scan finds a transcript under a NON-naive escaped dir
 *     name and persists transcript_path via the injected CAS callback
 *  T7 expired degrade: neither path nor keepalive → "expired" (caller shows
 *     the honest message; editor.open is NOT called)
 *  T8 idempotent fresh; T8b EEXIST race = success; T8c EXDEV copy + no-re-copy gate
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KA = await import(path.resolve(__dirname, '..', 'companion', 'dist', 'keepalive.js'));
// R1 (STRIP-style freshness gate): the module under test is the COMPILED
// dist — refuse a stale build (keepalive.ts newer than dist/keepalive.js).
const srcMt = fs.statSync(path.resolve(__dirname, '..', 'companion', 'keepalive.ts')).mtimeMs;
const distMt = fs.statSync(path.resolve(__dirname, '..', 'companion', 'dist', 'keepalive.js')).mtimeMs;
if (distMt < srcMt) {
  console.error('  FAIL  KA.0 dist/keepalive.js is STALE (older than keepalive.ts) — run npm run build in companion/');
  process.exit(1);
}
console.log('  PASS  KA.0 dist/keepalive.js fresh');

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
function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ka-test-'));
}
function ino(p) {
  try {
    return fs.statSync(p).ino;
  } catch {
    return null;
  }
}
function mkSession(home, sid, escapedName, content) {
  const dir = path.join(home, 'projects', escapedName);
  fs.mkdirSync(dir, { recursive: true });
  const tp = path.join(dir, sid + '.jsonl');
  fs.writeFileSync(tp, content || `{"type":"user","sid":"${sid}"}\n`);
  return tp;
}
function io(home, rows, persisted) {
  return {
    stateDir: path.join(home, 'state'),
    projectsDir: path.join(home, 'projects'),
    readRows: () => rows.slice(),
    persistTranscriptPath: (doc, sid, tp) => {
      persisted.push({ doc, sid, tp });
      const row = rows.find((r) => r.sid === sid);
      if (row) row.transcript_path = tp;
      return true;
    },
  };
}

// T1+T2: sweep survival + click-restore.
{
  const home = tmpHome();
  const sid = '11111111-2222-3333-4444-555555555555';
  const tp = mkSession(home, sid, 'weird-escaped-NAME', 'LINE1\n');
  const r = KA.ensureKeepalive(path.join(home, 'state'), sid, tp);
  const ka = path.join(home, 'state', 'keepalive', sid + '.jsonl');
  check('T1a ensureKeepalive links', r === 'linked' && fs.existsSync(ka) && ino(ka) === ino(tp), `r=${r}`);
  // Simulate CC retention: unlink the CC path (Tde semantics).
  fs.unlinkSync(tp);
  check('T1b keepalive survives the sweep', fs.existsSync(ka) && fs.readFileSync(ka, 'utf8') === 'LINE1\n');
  // The ROW retains transcript_path even after the sweep — that's how the
  // real favOpen path calls it (node.session.transcript_path); a bare scan
  // cannot rediscover a swept file (its only copy was the unlinked path).
  const out = KA.restoreForClick(path.join(home, 'state'), path.join(home, 'projects'), sid, tp);
  const fresh = Date.now() - fs.statSync(tp).mtimeMs < 1500;
  check(
    'T2 restoreForClick resurrects + freshens',
    out === 'restored' && fs.existsSync(tp) && ino(tp) === ino(ka) && fresh,
    `out=${out} fresh=${fresh}`,
  );
}
// T3: /compact rename-over-original → resync.
{
  const home = tmpHome();
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const tp = mkSession(home, sid, 'd1', 'PRE\n');
  const state = path.join(home, 'state');
  KA.ensureKeepalive(state, sid, tp);
  const kaIno = ino(path.join(state, 'keepalive', sid + '.jsonl'));
  // CC /compact: write new file + rename over the original (GE semantics).
  const tmp = tp + '.compact';
  fs.writeFileSync(tmp, 'POST\n');
  fs.renameSync(tmp, tp);
  check('T3a divergence exists pre-resync', ino(tp) !== kaIno);
  const r = KA.ensureKeepalive(state, sid, tp);
  check(
    'T3b reconcile resyncs to the fresh inode',
    r === 'resynced' && ino(path.join(state, 'keepalive', sid + '.jsonl')) === ino(tp),
    `r=${r}`,
  );
}
// T4+T5: union ownership — move keeps, removal prunes.
{
  const home = tmpHome();
  const sid = '11111111-0000-0000-0000-00000000000a';
  const tp = mkSession(home, sid, 'd2', 'X\n');
  const state = path.join(home, 'state');
  let rows = [{ sid, transcript_path: tp, doc: 'fav' }];
  const persisted = [];
  const i = io(home, rows, persisted);
  KA.reconcile(i);
  const ka = path.join(state, 'keepalive', sid + '.jsonl');
  check('T4a union link created', fs.existsSync(ka));
  rows = [{ sid, transcript_path: tp, doc: 'arch' }]; // mutex move fav→arch
  KA.reconcile(io(home, rows, persisted));
  check('T4b mutex move keeps protection', fs.existsSync(ka));
  rows = []; // unfavorite/unarchive
  const st = KA.reconcile(io(home, rows, persisted));
  check('T5 removal prunes the orphan link', !fs.existsSync(ka) && st.pruned === 1, JSON.stringify(st));
}
// T6: legacy backfill under a NON-naive escaped dir name.
{
  const home = tmpHome();
  const sid = '22222222-3333-4444-5555-666666666666';
  // The dir name deliberately does NOT match the naive cwd escape of any
  // plausible cwd — scan must NOT derive, only readdir.
  const tp = mkSession(home, sid, '-Users-x-Weird-Case-mix', 'L\n');
  const rows = [{ sid, doc: 'fav' }]; // legacy: no transcript_path
  const persisted = [];
  const st = KA.reconcile(io(home, rows, persisted));
  check(
    'T6 scan backfills transcript_path via injected CAS',
    persisted.length === 1 &&
      persisted[0].tp === tp &&
      rows[0].transcript_path === tp &&
      fs.existsSync(path.join(home, 'state', 'keepalive', sid + '.jsonl')),
    JSON.stringify({ persisted, st }),
  );
}
// T7: expired degrade.
{
  const home = tmpHome();
  const sid = '99999999-9999-9999-9999-999999999999';
  const out = KA.restoreForClick(path.join(home, 'state'), path.join(home, 'projects'), sid, undefined);
  check('T7 neither path nor keepalive → expired', out === 'expired', `out=${out}`);
}
// T8: idempotent second link = "fresh" (same-inode no-op).
{
  const home = tmpHome();
  const sid = 'abcdefab-cdef-abcd-efab-cdefabcdefab';
  const tp = mkSession(home, sid, 'd3', 'Y\n');
  const state = path.join(home, 'state');
  const r1 = KA.ensureKeepalive(state, sid, tp);
  const r2 = KA.ensureKeepalive(state, sid, tp);
  check('T8a second ensure is fresh (idempotent)', r1 === 'linked' && r2 === 'fresh', `${r1}/${r2}`);
}
// T8b: REAL EEXIST branch — ka already exists and shares the inode, but a
// raced unlink+link cycle would throw EEXIST; simulate by pre-creating the
// ka as a link then removing inode knowledge (unlink live, recreate live at
// the SAME path via link FROM ka — then ensure sees EEXIST path? Instead:
// direct branch probe — ka exists (same inode) is 'fresh'; ka exists on a
// DIFFERENT inode is resync. The EEXIST escape only fires on a true race,
// so probe it by stubbing linkSync's first call to throw EEXIST.
{
  const home = tmpHome();
  const sid = 'bacdfabd-efab-cdef-abcd-efabcdefabcd';
  const tp = mkSession(home, sid, 'd4', 'Z\n');
  const state = path.join(home, 'state');
  KA.ensureKeepalive(state, sid, tp);
  const ka = path.join(state, 'keepalive', sid + '.jsonl');
  fs.unlinkSync(ka); // force the link path; stub linkSync to throw EEXIST once
  const realLink = fs.linkSync;
  let threw = 0;
  fs.linkSync = (...a) => {
    threw++;
    const err = new Error('EEXIST-stub');
    err.code = 'EEXIST';
    throw err;
  };
  let r;
  try {
    r = KA.ensureKeepalive(state, sid, tp);
  } finally {
    fs.linkSync = realLink;
  }
  check('T8b EEXIST race is success (fresh)', threw === 1 && r === 'fresh', `threw=${threw} r=${r}`);
}
// T8c: REAL EXDEV branch — stub linkSync to throw EXDEV; assert the copy
// fallback ran (ka exists with content) AND the second pass skips the copy
// when size+mtime already match (R1 re-copy fix).
{
  const home = tmpHome();
  const sid = 'cdefabcd-efab-cdef-abcd-efabcdefabcd';
  const tp = mkSession(home, sid, 'd5', 'W\n');
  const state = path.join(home, 'state');
  const realLink = fs.linkSync;
  let linkThrows = 0;
  fs.linkSync = (...a) => {
    linkThrows++;
    const err = new Error('EXDEV-stub');
    err.code = 'EXDEV';
    throw err;
  };
  let r1;
  try {
    r1 = KA.ensureKeepalive(state, sid, tp);
  } finally {
    fs.linkSync = realLink;
  }
  const ka = path.join(state, 'keepalive', sid + '.jsonl');
  const copied1 = fs.existsSync(ka) && fs.readFileSync(ka, 'utf8') === 'W\n';
  // second pass: stub again — the SIZE gate (size-only by design: jsonl is
  // append-only; our own touches make mtime meaningless) must short-circuit
  // BEFORE linkSync (linkThrows stays 0 on pass 2).
  fs.linkSync = (...a) => {
    linkThrows++;
    const err = new Error('EXDEV-stub2');
    err.code = 'EXDEV';
    throw err;
  };
  let r2;
  try {
    r2 = KA.ensureKeepalive(state, sid, tp);
  } finally {
    fs.linkSync = realLink;
  }
  check(
    'T8c EXDEV copy fallback + second pass skips (no re-copy)',
    r1 === 'linked' && copied1 && r2 === 'fresh' && linkThrows === 1,
    `r1=${r1} copied1=${copied1} r2=${r2}`,
  );
}

if (fail === 0) console.log(`All ${pass} keepalive checks passed.`);
else {
  console.log(`${pass} passed, ${fail} failed.`);
  process.exit(1);
}
