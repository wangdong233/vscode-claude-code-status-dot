#!/usr/bin/env node
/**
 * test-seam-restore-fix.mjs — T4 POST-FIX gate for the v0.6.2 RESTORE-EARLY-BIND.
 *
 * The T3 harness (test-seam-restore.mjs) pins the DEFECT with fixture sid
 * 'sid-r' — which the fix's SID_RE shape gate ([0-9a-f-]{8,64}, mirroring CC's
 * D0$ uuid-hex format) correctly REJECTS, so that harness stays green and now
 * doubles as the INV-R2 negative (bad-shape sid → no seed → sentinel fallback).
 * This gate drives the SAME machinery with REALISTIC dashed-hex uuid sids
 * (field-confirmed format: 42242dfe-…, 1e1c4c18-…) and asserts the fixed
 * behavior:
 *   FX.1  INV-R1a seed lands at deserialize instant (bridge bind, no message)
 *   FX.2  INV-R1b active-at-restore: __ccsdActiveSid published; token SBI
 *         paints REAL tokens from <sid>.json with NO spinner ever
 *   FX.3  INV-R1c dead-webview permanence: no update_session_state EVER; click
 *         + multiple §H/§G ticks → still real values, sentinel never latches
 *   FX.4  INV-R2 absent sessionID / non-uuid shape ('sid-r', 'remote:x') →
 *         no seed; sentinel latches on activation (defensible default)
 *   FX.5  INV-R3 delegation verbatim (same objects, byte-identical state,
 *         forwarded return) — unchanged by the fix
 *   FX.6  skew reconcile: seeded A + first update_session_state(B) removes A
 *         from the bridges, rebinds B, publishes B
 *   FX.7  seed confirm: update_session_state(A) keeps the entry, lands title
 *   FX.8  sweep grace: seeded entry survives an outbound session_states_update
 *         whose open set does NOT contain it (lastMsgTs stamped at seed)
 *   FX.9  heartbeat observability: obs.seeded >= 1
 *   FX.10 farewell unbind: isFarewell on the seeded sid removes the entry
 *   FX.11 background-tab restore: seed binds map but does NOT publish active;
 *         first click publishes via §A (no sentinel) — the exact field flow
 *   FX.12 companion mirror: active panel resolvable from __ccsdSidToPanel via
 *         companion/extension.ts:2904 scan (loading:false)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PATCH_TS = path.join(ROOT, 'patch.ts');

const A = '42242dfe-a1b2-c3d4-e5f6-a7b8c9d0e1f2'; // seeded (skew guess)
const B = '1e1c4c18-1122-3344-5566-778899aabbcc'; // authoritative after hydrate

let pass = 0,
  fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (detail ? '   ' + detail : ''));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsd-t4-fix-'));
const IDIR = path.join(SANDBOX, 'install');
const FAKE_HOME = path.join(SANDBOX, 'home');
const CC_DIR = path.join(FAKE_HOME, '.claude', 'cc-tab-status');
fs.mkdirSync(IDIR, { recursive: true });
fs.mkdirSync(CC_DIR, { recursive: true });
const EMIT = path.join(SANDBOX, 'prelude.json');
execFileSync('npx', ['tsx', PATCH_TS, '--emit-seam-prelude', EMIT], {
  cwd: ROOT,
  env: { ...process.env, CCSD_INSTALL_DIR: IDIR, HOME: FAKE_HOME },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const PRELUDE = JSON.parse(fs.readFileSync(EMIT, 'utf8')).body;
check(
  'FX.0a prelude carries the seed machinery',
  PRELUDE.includes('function seedSid(') && PRELUDE.includes('SID_RE') && PRELUDE.includes('unseedCtx'),
  'seedSid/SID_RE/unseedCtx missing from emitted prelude',
);

const tokWin = { in: 1234567, out: 234567, cr: 8_000_000, cc5: 1_000_000, cc1: 100_000, cci: 50_000 };
for (const s of [A, B]) {
  fs.writeFileSync(
    path.join(CC_DIR, s + '.json'),
    JSON.stringify({
      state: 'running',
      since: Date.now() - 60_000,
      cwd: '/Users/x/proj',
      tokens: { total: tokWin, windows: { all: tokWin }, cost: 0.42, cost_24h: 0.42 },
    }),
  );
}

class FakePanel {
  constructor(viewType) {
    this.viewType = viewType;
    this._title = 'Claude Code';
    this._icon = null;
    this.active = false;
    this.visible = false;
    this.viewColumn = 1;
    this.webview = new FakeWebview();
    this._vsCb = [];
    this._disposeCb = [];
  }
  get title() {
    return this._title;
  }
  set title(v) {
    this._title = v;
  }
  get iconPath() {
    return this._icon;
  }
  set iconPath(v) {
    this._icon = v;
  }
  onDidChangeViewState(cb) {
    this._vsCb.push(cb);
    return { dispose() {} };
  }
  onDidDispose(cb) {
    this._disposeCb.push(cb);
    return { dispose() {} };
  }
  reveal() {}
}
class FakeWebview {
  constructor() {
    this._msgCb = [];
  }
  onDidReceiveMessage(cb) {
    this._msgCb.push(cb);
    return { dispose() {} };
  }
  postMessage(msg) {
    (this._sent = this._sent || []).push(msg);
    return Promise.resolve(true);
  }
}
const sbiItems = [];
const capturedRaw = {};
function makeFakeVs() {
  return {
    Uri: { file: (p) => ({ fsPath: p, scheme: 'file', __uri: true }) },
    QuickPickItemKind: { Separator: 0 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1 },
    env: { clipboard: { writeText() {} }, language: 'en' },
    window: {
      createWebviewPanel: (viewType) => new FakePanel(viewType),
      registerWebviewViewProvider: (viewId, provider) => {
        capturedRaw['view:' + viewId] = provider;
      },
      registerWebviewPanelSerializer: (viewType, serializer) => {
        capturedRaw['ser:' + viewType] = serializer;
      },
      createStatusBarItem: () => {
        const it = {
          name: '',
          text: '',
          tooltip: '',
          command: '',
          show() {},
          hide() {},
          dispose() {
            it._disposed = true;
          },
        };
        sbiItems.push(it);
        return it;
      },
      createOutputChannel: () => ({ appendLine() {}, show() {} }),
      showQuickPick: () => Promise.resolve(undefined),
      showInformationMessage: () => Promise.resolve(undefined),
      showErrorMessage: () => Promise.resolve(undefined),
    },
    commands: { registerCommand: () => ({ dispose() {} }), getCommands: () => Promise.resolve([]) },
    workspace: { getConfiguration: () => ({ get: (_k, d) => d, update: () => Promise.resolve() }) },
  };
}
function fakeRawRequireFactory(fakeVs) {
  const req = (id) => {
    if (id === 'vscode') return fakeVs;
    if (id === 'fs' || id === 'node:fs') return fs;
    if (id === 'path' || id === 'node:path') return path;
    if (id === 'os' || id === 'node:os') return os;
    throw new Error('test fake require: unexpected module ' + id);
  };
  req.resolve = (r) => '/fake/resolve/' + r;
  req.main = { id: 'fake-main' };
  req.cache = { '/fake': 1 };
  return req;
}

const wrapperSrc =
  '(function(exports, require, module, __filename, __dirname){\n' +
  PRELUDE +
  '\n;module.exports.__req = require; module.exports.__G = globalThis;\n})';
const fakeVs = makeFakeVs();
const rawReq = fakeRawRequireFactory(fakeVs);
const factory = new Function('return ' + wrapperSrc)();
const moduleObj = { exports: {} };
const BRIDGES = [
  '__ccsdSidToPanel',
  '__ccsdSidToTitle',
  '__ccsdPendingSet',
  '__ccsdUserDialogSet',
  '__ccsdWireState',
  '__ccsdToolPermSet',
  '__ccsdSbi',
  '__ccsdPanelCount',
  '__ccsdActiveSid',
  '__ccsdLastActiveSid',
];
const savedGlobals = {};
for (const k of BRIDGES) savedGlobals[k] = globalThis[k];
factory(moduleObj.exports, rawReq, moduleObj, path.join(SANDBOX, 'cc-ext'), path.join(SANDBOX, 'cc-ext'));
const { __req: req, __G: G } = moduleObj.exports;
const vs = req('vscode');
function msg(panel, envelope) {
  for (const cb of panel.webview._msgCb) cb(envelope);
}
function fireViewState(panel) {
  for (const cb of panel._vsCb) cb({ webviewPanel: panel });
}
function hbRead() {
  return JSON.parse(fs.readFileSync(path.join(IDIR, 'seam-state-' + process.pid + '.json'), 'utf8'));
}
const tokSbi = () => G.__ccsdTokSbi;
const companionScan = () => {
  // companion/extension.ts:2904-2910 level-2 scan
  const m = G.__ccsdSidToPanel;
  if (!m) return null;
  return Object.keys(m).find((sid) => m[sid] && m[sid].active === true) || null;
};

// ---- scenario 1: ACTIVE-at-restore panel (restart restores focused tab)
const CC_RET = { __ccReturn: true };
const stateA = { sessionID: A, sessionUpdatedAt: 12345, isFullEditor: true };
const stateSnapA = JSON.stringify(stateA);
let deleArgs = null;
const origSer = {
  deserializeWebviewPanel(panel, state) {
    deleArgs = { panel, state };
    return CC_RET;
  },
};
vs.window.registerWebviewPanelSerializer('claudeVSCodePanel', origSer);
const shim = capturedRaw['ser:claudeVSCodePanel'];
const active1 = new FakePanel('claudeVSCodePanel');
active1.active = true;
active1.visible = true; // focused at restore
const ret1 = shim.deserializeWebviewPanel(active1, stateA);

check(
  'FX.1 INV-R1a seed lands at deserialize instant: bridge bound BEFORE any webview message',
  G.__ccsdSidToPanel[A] === active1,
  `sidToPanel[${A.slice(0, 8)}]=${G.__ccsdSidToPanel[A]}`,
);
check(
  'FX.2a INV-R1b active-at-restore publishes __ccsdActiveSid (sentinel never latches)',
  G.__ccsdActiveSid === A && G.__ccsdLastActiveSid === A,
  JSON.stringify(G.__ccsdActiveSid),
);
check(
  'FX.2b INV-R1b token SBI paints REAL tokens immediately (no spinner)',
  tokSbi() && tokSbi().text !== '$(sync~spin)' && /\d/.test(tokSbi().text),
  `text=${tokSbi() && tokSbi().text}`,
);
check(
  'FX.5 INV-R3a delegation VERBATIM: same panel+state objects',
  deleArgs.panel === active1 && deleArgs.state === stateA,
);
check('FX.5 INV-R3b state byte-identical (not mutated)', JSON.stringify(stateA) === stateSnapA);
check('FX.5 INV-R3c return forwarded untouched', ret1 === CC_RET);
check('FX.12 companion mirror: level-2 scan resolves the active panel (loading=false)', companionScan() === A);

// dead-webview permanence: click + ticks, NEVER any update_session_state
fireViewState(active1);
await sleep(700); // ≥1 §H tick + several §G ticks
let spinnerSeen = false;
for (let i = 0; i < 5; i++) {
  G.__ccsdSbiTick();
  if (tokSbi().text === '$(sync~spin)') spinnerSeen = true;
}
check(
  'FX.3 INV-R1c dead webview: click + 700ms + 5 ticks — sentinel never latched, no spinner ever',
  !spinnerSeen && G.__ccsdActiveSid === A && tokSbi().text !== '$(sync~spin)',
  `activeSid=${G.__ccsdActiveSid} text=${tokSbi().text}`,
);

// sweep grace: outbound session_states_update whose open set EXCLUDES A
active1.webview.postMessage({
  type: 'request',
  requestId: 'ssu1',
  request: { type: 'session_states_update', openSessionIds: [], activeSessionId: '' },
});
check(
  'FX.8 seeded entry survives the outbound open-set sweep (lastMsgTs stamped at seed)',
  G.__ccsdSidToPanel[A] === active1,
  'seeded entry reaped by session_states_update sweep',
);

// heartbeat observability
check('FX.9 heartbeat obs.seeded >= 1', (hbRead().obs.seeded || 0) >= 1, JSON.stringify(hbRead().obs.seeded));

// skew reconcile: hydration lands a DIFFERENT authoritative sid B
msg(active1, {
  type: 'request',
  channelId: 'c1',
  requestId: 'q1',
  request: { type: 'update_session_state', sessionId: B, state: 'running', title: 'Novel_Workflow' },
});
check(
  'FX.6a skew reconcile: wrong guess A removed from sidToPanel',
  G.__ccsdSidToPanel[A] === undefined,
  `sidToPanel[A]=${G.__ccsdSidToPanel[A]}`,
);
check(
  'FX.6b skew reconcile: authoritative B bound',
  G.__ccsdSidToPanel[B] === active1 && G.__ccsdSidToTitle[B] === 'Novel_Workflow',
);
check('FX.6c skew reconcile: active publishes B', G.__ccsdActiveSid === B);

// farewell on B removes the entry (existing path; hosted registered by reconcile)
msg(active1, {
  type: 'request',
  channelId: 'c1',
  requestId: 'q2',
  request: { type: 'update_session_state', sessionId: B, state: 'idle', isFarewell: true },
});
check(
  'FX.10 farewell on the bound sid removes the bridge entry',
  G.__ccsdSidToPanel[B] === undefined,
  `sidToPanel[B]=${G.__ccsdSidToPanel[B]}`,
);

// ---- scenario 2: background-tab restore + first click (exact field flow)
const bg = new FakePanel('claudeVSCodePanel');
const preActive = G.__ccsdActiveSid;
shim.deserializeWebviewPanel(bg, { sessionID: B, sessionUpdatedAt: 9, isFullEditor: true });
check('FX.11a background restore: map bound', G.__ccsdSidToPanel[B] === bg);
check(
  'FX.11b background restore: does NOT steal __ccsdActiveSid',
  G.__ccsdActiveSid === preActive,
  `active=${G.__ccsdActiveSid} pre=${preActive}`,
);
bg.active = true;
bg.visible = true;
fireViewState(bg);
check(
  'FX.11c first click of a seeded background tab publishes the sid via §A — NO sentinel',
  G.__ccsdActiveSid === B && tokSbi().text !== '$(sync~spin)',
  `activeSid=${G.__ccsdActiveSid} text=${tokSbi().text}`,
);

// ---- scenario 3: INV-R2 negatives — absent / bad-shape sessionID
const ghost = new FakePanel('claudeVSCodePanel');
shim.deserializeWebviewPanel(ghost, { isFullEditor: true }); // no sessionID
check(
  'FX.4a INV-R2 absent sessionID: no seed',
  G.__ccsdSidToPanel['undefined'] === undefined &&
    Object.keys(G.__ccsdSidToPanel).every((k) => G.__ccsdSidToPanel[k] !== ghost),
);
ghost.active = true;
ghost.visible = true;
fireViewState(ghost);
check(
  'FX.4b INV-R2 absent sessionID: sentinel latches on activation (defensible default preserved)',
  G.__ccsdActiveSid === '__switching__',
  JSON.stringify(G.__ccsdActiveSid),
);
const ghost2 = new FakePanel('claudeVSCodePanel');
shim.deserializeWebviewPanel(ghost2, { sessionID: 'sid-r', sessionUpdatedAt: 1 });
const seededGhost2 = Object.keys(G.__ccsdSidToPanel).some((k) => G.__ccsdSidToPanel[k] === ghost2);
check('FX.4c INV-R2 non-uuid shape ("sid-r"): rejected by SID_RE, no seed', !seededGhost2);
const ghost3 = new FakePanel('claudeVSCodePanel');
shim.deserializeWebviewPanel(ghost3, { sessionID: 'remote:xyz', sessionUpdatedAt: 1 });
check(
  'FX.4d INV-R2 remote: sessionKey rejected ("remote:" prefix)',
  !Object.keys(G.__ccsdSidToPanel).some((k) => G.__ccsdSidToPanel[k] === ghost3),
);

// ---- scenario 4: seed confirm (same sid) keeps entry + lands title
const conf = new FakePanel('claudeVSCodePanel');
shim.deserializeWebviewPanel(conf, { sessionID: A, sessionUpdatedAt: 5, isFullEditor: true });
msg(conf, {
  type: 'request',
  channelId: 'c2',
  requestId: 'q3',
  request: { type: 'update_session_state', sessionId: A, state: 'running', title: 'project_cc-control' },
});
check(
  'FX.7 seed confirm: same-sid message keeps the entry and lands the title',
  G.__ccsdSidToPanel[A] === conf && G.__ccsdSidToTitle[A] === 'project_cc-control',
);

// restore globals + exit
for (const cb of [
  ...active1._disposeCb,
  ...bg._disposeCb,
  ...ghost._disposeCb,
  ...ghost2._disposeCb,
  ...ghost3._disposeCb,
  ...conf._disposeCb,
])
  cb();
for (const k of BRIDGES) {
  if (savedGlobals[k] === undefined) delete globalThis[k];
  else globalThis[k] = savedGlobals[k];
}
if (fail === 0) console.log(`All ${pass} post-fix (RESTORE-EARLY-BIND) checks passed.`);
else {
  console.log(`${pass} passed, ${fail} failed.`);
  process.exitCode = 1;
}
process.exit(process.exitCode || 0);
