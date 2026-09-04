#!/usr/bin/env node
/**
 * test-seam-favpaint.mjs — v0.6.1 regression gate for the two P0 bugs shipped
 * in 0.6.0 (found live by the user within hours of release):
 *
 *   FAV.1  title star-stacking: the rc1 shadowTitle set-callback recorded
 *          EVERY title write back into ctx.__ccsdTitle + the sidToTitle
 *          bridge — including our own §H paint ("★ X") — so the paint loop
 *          fed its own output back as the base: ★ ★ ★ … at ~2/s, unbounded
 *          (empirically 6 stars in 3.2s). Fixed by making the shadow a pure
 *          passthrough; the seam observers are the ONLY __ccsdTitle writers
 *          (clean wire titles), restoring the v0.5.x invariant.
 *   FAV.2  token-SBI spinner deadlock: the seam registers the ported
 *          onDidChangeViewState listener at PANEL CREATION (anchor era
 *          registered it inside the first handler fire, after sid had
 *          landed), so the creation-time activation event fires with
 *          sid="" and latches the "__switching__" sentinel — which nothing
 *          ever cleared (the ported §G tick checks the sentinel BEFORE the
 *          map scan and returns). Fixed: when a sid lands on an ACTIVE
 *          panel, the observers publish it to __ccsdActiveSid immediately.
 *
 * Runs the REAL emitted prelude with a sandboxed HOME (favorites/sid files
 * under tmp), drives the real 500ms §H tick by wall-clock, and pins both
 * outcomes. Async (needs real timer ticks) — self-contained process, so the
 * HOME mutation below cannot leak into any other suite.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PATCH_TS = path.join(ROOT, 'patch.ts');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsd-favpaint-'));
const HOME = path.join(SANDBOX, 'home');
fs.mkdirSync(path.join(HOME, '.claude', 'cc-tab-status'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.claude', 'cc-status-dot'), { recursive: true });
// Sandbox HOME BEFORE the prelude runs in-process (DIR/FAVF are computed from
// process.env.HOME at prelude module scope).
process.env.HOME = HOME;
const DIR = path.join(HOME, '.claude', 'cc-tab-status');
const IDIR = path.join(SANDBOX, 'idir');
fs.mkdirSync(IDIR, { recursive: true });

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

// --- emit the REAL prelude (sandboxed INSTALL_DIR) ---
const EMIT = path.join(SANDBOX, 'prelude.json');
execFileSync('npx', ['tsx', PATCH_TS, '--emit-seam-prelude', EMIT], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 120000,
  maxBuffer: 64 << 20,
  env: { ...process.env, CCSD_INSTALL_DIR: IDIR },
});
const PRELUDE = JSON.parse(fs.readFileSync(EMIT, 'utf8')).body;
check('FP.0 emitted prelude loads (v0.6.1+)', /__ccsdPanelInit/.test(PRELUDE));

// --- fixtures: a running session + a favorited sid (REAL file shape) ---
fs.writeFileSync(
  path.join(DIR, 'sid-fav.json'),
  JSON.stringify({
    state: 'running',
    since: 1,
    cwd: '/x',
    tokens: { total: { in: 10, out: 5 }, windows: { all: { in: 10, out: 5 } } },
    offset: 0,
  }),
);
fs.writeFileSync(
  path.join(DIR, 'favorites.json'),
  JSON.stringify({
    version: 1,
    updatedAt: Date.now(),
    sessions: [{ sid: 'sid-fav', label: 'Fav Session', cwd: '/x', transcript_path: '/x.jsonl', addedAt: 1 }],
  }),
);

// --- fakes (real VSCode descriptor shapes: PROTOTYPE accessors) ---
class FakeWebview {
  constructor() {
    this._msgCb = [];
  }
  onDidReceiveMessage(cb) {
    this._msgCb.push(cb);
    return { dispose() {} };
  }
  postMessage() {
    return Promise.resolve(true);
  }
}
class FakePanel {
  constructor(vt) {
    this.viewType = vt;
    this._t = 'Claude Code';
    this._i = null;
    this.active = false;
    this.visible = true;
    this.webview = new FakeWebview();
    this._vsCb = [];
    this._dispCb = [];
  }
  get title() {
    return this._t;
  }
  set title(v) {
    this._t = v;
  }
  get iconPath() {
    return this._i;
  }
  set iconPath(v) {
    this._i = v;
  }
  onDidChangeViewState(cb) {
    this._vsCb.push(cb);
    return { dispose() {} };
  }
  onDidDispose(cb) {
    this._dispCb.push(cb);
    return { dispose() {} };
  }
  reveal() {}
}
const sbis = [];
const fakeVs = {
  window: {
    createWebviewPanel: (vt) => new FakePanel(vt),
    createStatusBarItem: () => {
      const it = { text: '', tooltip: '', show() {}, hide() {}, dispose() {} };
      sbis.push(it);
      return it;
    },
    createOutputChannel: () => ({ appendLine() {}, show() {} }),
    showQuickPick: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
  },
  env: { language: 'en', clipboard: { writeText() {} } },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    getCommands: () => Promise.resolve([]),
  },
  workspace: { getConfiguration: () => ({ get: (_k, d) => d, update: () => Promise.resolve() }) },
};
function fakeRawRequire(id) {
  if (id === 'vscode') return fakeVs;
  if (id === 'fs' || id === 'node:fs') return fs;
  if (id === 'path' || id === 'node:path') return path;
  if (id === 'os' || id === 'node:os') return os;
  throw new Error('unexpected module ' + id);
}
fakeRawRequire.resolve = (r) => '/fake/' + r;
fakeRawRequire.main = { id: 'm' };
fakeRawRequire.cache = {};

const wrapperSrc =
  '(function(exports, require, module, __filename, __dirname){\n' +
  PRELUDE +
  '\n;module.exports.__G=globalThis;module.exports.__mk=function(){return require("vscode").window.createWebviewPanel("claudeVSCodePanel","Claude",{viewColumn:1},{})};})';
const factory = new Function('return ' + wrapperSrc)();
const mod = { exports: {} };
factory(mod.exports, fakeRawRequire, mod, '/cc-ext/extension.js', '/cc-ext');
const { __G: G, __mk: mk } = mod.exports;
const p1 = mk();
check('FP.1 panel armed at creation (viewState listener registered)', p1._vsCb.length > 0);

// FAV.2 sequence: creation-time activation with sid EMPTY latches the sentinel…
p1.active = true;
p1._vsCb.forEach((cb) => {
  try {
    cb({ webviewPanel: p1 });
  } catch (_e) {}
});
check('FP.2 creation-activation latches __switching__ (session still loading)', G.__ccsdActiveSid === '__switching__');

// …the session lands — the v0.6.1 fix must clear the sentinel THIS event.
p1.webview._msgCb.forEach((cb) => {
  try {
    cb({
      type: 'request',
      requestId: 'r1',
      request: { type: 'update_session_state', sessionId: 'sid-fav', state: 'running', title: 'Fav Session' },
    });
  } catch (_e) {}
});
check(
  'FP.3 sid landing on an ACTIVE panel publishes __ccsdActiveSid (spinner deadlock fixed)',
  G.__ccsdActiveSid === 'sid-fav' && G.__ccsdLastActiveSid === 'sid-fav',
  'got ' + JSON.stringify(G.__ccsdActiveSid),
);
check('FP.4 logical title recorded from the CLEAN wire title', G.__ccsdSidToTitle['sid-fav'] === 'Fav Session');

// FAV.1: let the REAL 500ms §H tick paint the favorited tab for ~3s.
await new Promise((r) => setTimeout(r, 3200));
const stars = (p1.title.match(/★/g) || []).length;
check(
  'FP.5 exactly ONE ★ after 3.2s of ticks (star-stacking fixed; 0.6.0 stacked 6)',
  stars === 1 && p1.title === '★ Fav Session',
  'title=' + JSON.stringify(p1.title),
);
check(
  'FP.6 bridge stays un-starred after paint cycles',
  G.__ccsdSidToTitle['sid-fav'] === 'Fav Session',
  'bridge=' + JSON.stringify(G.__ccsdSidToTitle['sid-fav']),
);

// FP.8/9 steady-state resource assertions (the meta-lesson of 0.6.0): stable
// input state MUST produce bounded work — no title writes, no string growth.
// The 0.6.0 stacking violated both (one renderer IPC write per tick per
// favorited tab + ~4 chars/s unbounded growth). Count setter invocations via
// a per-panel counter installed on the fake BEFORE this window.
let fp8_writes = 0;
const origT = Object.getOwnPropertyDescriptor(FakePanel.prototype, 'title').set;
Object.defineProperty(p1, 'title', {
  configurable: true,
  get() {
    return this._t;
  },
  set(v) {
    fp8_writes++;
    this._t = v;
  },
});
const tBefore = p1.title;
await new Promise((r) => setTimeout(r, 2100));
const tAfter = p1.title;
check(
  'FP.8 steady state (fav unchanged 2.1s): title byte-stable, ZERO setter writes (bounded-work invariant)',
  tBefore === tAfter && tAfter === '★ Fav Session' && fp8_writes === 0,
  `writes=${fp8_writes} title=${JSON.stringify(tAfter)}`,
);
check('FP.9 title length bounded (no amplification): ' + tAfter.length + ' chars', tAfter.length < 40);

// FP.7 direct passthrough: an out-of-band title write must NOT poison the cache.
p1.title = 'Manual Rename';
check(
  'FP.7 shadowTitle is a pure passthrough — manual title writes do not touch __ccsdSidToTitle',
  G.__ccsdSidToTitle['sid-fav'] === 'Fav Session',
  'bridge=' + JSON.stringify(G.__ccsdSidToTitle['sid-fav']),
);

if (fail === 0) {
  console.log(`All ${pass} seam-favpaint checks passed.`);
  process.exit(0); // the prelude's live tick/heartbeat intervals keep the loop alive
} else {
  console.log(`${pass} passed, ${fail} failed.`);
  process.exit(1);
}
