#!/usr/bin/env node
/**
 * test-seam-restore.mjs — v0.6.1 RESTART-RESTORE repro gate (headless).
 *
 * Reproduces the 2026-09-04 field report: after a VSCode restart (sessions
 * restored via registerWebviewPanelSerializer), clicking a restored session
 * tab latches the `__ccsdActiveSid="__switching__"` sentinel and BOTH the
 * token SBI and the companion favorites SBI spin for as long as the webview
 * takes to hydrate — forever when the session never opens (the 194.9MB
 * transcript case). The hook fast path (~/.claude/cc-tab-status/<sid>.json)
 * keeps working the whole time because it never consults the sentinel.
 *
 * Root cause under test (v0.6.1 behavior):
 *   CC's serializer state carries sessionID (decompiled 2.1.259:
 *   `deserializeWebviewPanel(M,F){...let I=j?.sessionID; if(D0$(I)&&e$$(I,
 *   j?.sessionUpdatedAt)) G.registerPanelSession(I,M)}`), but the seam's
 *   shimSerializer only calls armSurface(panel, viewType, "restore") and
 *   never reads `state.sessionID` — so ctx.__ccsdSid stays "" until the
 *   heavyweight webview sends its first update_session_state.
 *
 * Harness mirrors test-seam-runtime.mjs: the REAL compiled prelude (via
 * `patch.ts --emit-seam-prelude`, sandboxed INSTALL_DIR + sandboxed HOME so
 * the baked DIR literal points at the sandbox ~/.claude/cc-tab-status) runs
 * inside a plain-node CJS wrapper with fake vscode primitives shaped like the
 * real ext-host (title/iconPath PROTOTYPE accessors).
 *
 * Assertions:
 *   RST.0   emitted prelude freshness + DIR literal baked to sandbox HOME
 *   RST.1   serializer path arms the restored panel (observer subscribed)
 *   RST.2   CURRENT BEHAVIOR: serializer state.sessionID does NOT land —
 *           no bridge bind, no __ccsdActiveSid publish (the defect)
 *   RST.3   shim delegates (panel,state) VERBATIM (identity + no mutation +
 *           return-value forwarding) — CC's own restore is unaffected by seam
 *   RST.4   viewState activation with ctx.__ccsdSid==="" latches the
 *           "__switching__" sentinel AND paints $(sync~spin) in the same event
 *   RST.5   §G sentinel branch returns BEFORE the file read: spinner persists
 *           across ticks even though sandbox HOME holds a real sid-r.json
 *           (hook fast path data present on disk)
 *   RST.6   LOCK: the per-panel §H 500ms tick RE-ASSERTS the sentinel — an
 *           externally forced clear is reverted within one tick
 *   RST.7   NO-TIMEOUT: N ticks + seconds of wall clock never clear the
 *           sentinel by themselves (only an inbound message can)
 *   RST.8   HYDRATION: the first update_session_state clears the sentinel
 *           SYNCHRONOUSLY (v0.6.1 BUGFIX path) and the next tick paints real
 *           tokens from sid-r.json; measured spinner window ≈ simulated
 *           hydration delay (spinner duration == hydration duration)
 *   RST.9   negative control (no prelude): the raw host hands CC its own
 *           serializer object; CC's state.sessionID-driven restore works and
 *           zero __ccsd* surfaces exist — CC本体 is fine without the seam
 *   RST.10  favorites-SBI mirror: while spinning, __ccsdSidToPanel has no
 *           entry for the active panel → companion activeCcSidOrLoading()
 *           (companion/extension.ts:2891) cannot resolve → loading=true —
 *           both SBIs spin off the SAME empty-bridge root cause
 *
 * INVARIANTS this test is expected to PIN after the fix (§2.1 item 10 —
 * assertion sources must be the seam's own primitives, never re-derived):
 *   INV-R1  shim.deserializeWebviewPanel must seed ctx.__ccsdSid from
 *           state.sessionID (validated shape: non-empty string) and publish
 *           sidToPanel/title bridges BEFORE the webview hydrates — RST.2
 *           flips to assert the seed, RST.4/RST.5 then assert NO sentinel
 *           latch on first activation (the restored panel is known).
 *   INV-R2  the seeded sid must not survive a serializer state whose
 *           sessionID is absent/!D0$-shaped — seeding is conditional, and an
 *           unknown-state restore still latches the sentinel (defensible
 *           default) and still clears on first update_session_state.
 *   INV-R3  RST.3 (verbatim delegation) is UNCHANGED by the fix — the fix may
 *           read state but must never rewrite/mutate it before delegating.
 *   INV-R4  RST.9 (no-seam CC restore) is UNCHANGED by the fix.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PATCH_TS = path.join(ROOT, 'patch.ts');

const SID = 'sid-r';
const HYDRATE_DELAY_MS = 1200; // simulated slow webview hydration (194.9MB transcript)

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- sandbox
// Sandbox BOTH the install dir (heartbeat writes) and HOME (the prelude's
// baked DIR literal — STATE_DIR = path.join(os.homedir(), ".claude",
// "cc-tab-status") is computed at patch.ts module load, and os.homedir()
// honors $HOME on POSIX, so the emit child bakes the sandbox path).
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsd-seam-restore-'));
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
const mtimePre = fs.statSync(EMIT).mtimeMs;
const mtimeTs = fs.statSync(PATCH_TS).mtimeMs;
check('RST.0a emitted prelude is fresh vs patch.ts', mtimePre >= mtimeTs, `${mtimePre} < ${mtimeTs}`);
const emitted = JSON.parse(fs.readFileSync(EMIT, 'utf8'));
const PRELUDE = emitted.body;
check(
  'RST.0b baked DIR literal points at the sandbox HOME (real ~/.claude untouched)',
  PRELUDE.includes(JSON.stringify(CC_DIR).slice(1, -1)) || PRELUDE.includes(CC_DIR),
  'DIR literal not found in prelude body',
);

// Real hook-written <sid>.json in the sandbox (writer contract:
// hooks/cc-status.js:20 "{ state, since, error?, activeSubagents, pending?,
// cwd?, tokens? }" + tokens.windows per patch.ts §G reader). THE FAST PATH IS
// GREEN FROM t=0 — this is what makes RST.5 the interesting assertion.
const tokWin = { in: 1234567, out: 234567, cr: 8_000_000, cc5: 1_000_000, cc1: 100_000, cci: 50_000 };
fs.writeFileSync(
  path.join(CC_DIR, SID + '.json'),
  JSON.stringify({
    state: 'running',
    since: Date.now() - 60_000,
    cwd: '/Users/x/proj',
    tokens: { total: tokWin, windows: { all: tokWin }, cost: 0.42, cost_24h: 0.42 },
  }),
);

// ---------------------------------------------------------------- fakes
// Same shapes as test-seam-runtime.mjs — title/iconPath PROTOTYPE accessors
// (real extHostWebviewPanels.ts), postMessage prototype value-property.
class FakePanel {
  constructor(viewType) {
    this.viewType = viewType;
    this._title = 'Claude Code';
    this._icon = null;
    this.active = false; // restored panels deserialize INACTIVE (background tab)
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
    this._sent = this._sent || [];
    this._sent.push(msg);
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
      createWebviewPanel(viewType, title, showOptions, options) {
        return new FakePanel(viewType);
      },
      registerWebviewViewProvider(viewId, provider, opts) {
        capturedRaw['view:' + viewId] = provider;
      },
      registerWebviewPanelSerializer(viewType, serializer) {
        capturedRaw['ser:' + viewType] = serializer;
      },
      createStatusBarItem: (..._a) => {
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
    commands: {
      registerCommand: () => ({ dispose() {} }),
      getCommands: () => Promise.resolve([]),
    },
    workspace: {
      getConfiguration: () => ({ get: (_k, d) => d, update: () => Promise.resolve() }),
    },
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

// ---------------------------------------------------------------- WITH prelude
// Run the REAL prelude in a CJS module wrapper (probe appended in-scope so the
// REBOUND require binding is observable).
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
const hbPath = path.join(IDIR, 'seam-state-' + process.pid + '.json');
function hbRead() {
  return JSON.parse(fs.readFileSync(hbPath, 'utf8'));
}

// ================================================================ RST.1-3
// CC (already activated by the restart) registers its serializer; the seam
// wrapper hands the HOST a shim. VSCode then restores the persisted panel and
// calls deserializeWebviewPanel(panel, state) — state carries sessionID per
// the decompiled CC 2.1.259 serializer.
const ccPanelSessions = Object.create(null); // models CC's G.registerPanelSession
const CC_RET = { __ccReturn: true };
const stateObj = { sessionID: SID, sessionUpdatedAt: 12345, isFullEditor: true };
const stateSnapshot = JSON.stringify(stateObj);
let deleArgs = null;
const origSer = {
  deserializeWebviewPanel(panel, state) {
    deleArgs = { panel, state };
    // faithful CC 2.1.259 shape: let I=j?.sessionID; if(valid) registerPanelSession(I,M)
    const sid = state && typeof state.sessionID === 'string' ? state.sessionID : '';
    if (sid) ccPanelSessions[sid] = panel;
    return CC_RET;
  },
};
vs.window.registerWebviewPanelSerializer('claudeVSCodePanel', origSer);
const shim = capturedRaw['ser:claudeVSCodePanel'];
check(
  'RST.1a host received the serializer shim',
  shim !== origSer && typeof shim.deserializeWebviewPanel === 'function',
);
const restored = new FakePanel('claudeVSCodePanel'); // the panel VSCode resurrects
const shimRet = shim.deserializeWebviewPanel(restored, stateObj);
check(
  'RST.1b serializer shim armed the restored panel (observer subscribed via armSurface kind="restore")',
  restored.webview._msgCb.length >= 1,
);
check(
  'RST.3a delegation VERBATIM: CC receives the SAME panel object and the SAME state object',
  deleArgs.panel === restored && deleArgs.state === stateObj,
);
check('RST.3b state not mutated by the shim (byte-identical)', JSON.stringify(stateObj) === stateSnapshot);
check('RST.3c CC serializer return value forwarded untouched', shimRet === CC_RET);
check(
  'RST.3d CC-side restore succeeded off state.sessionID (its own registerPanelSession ran)',
  ccPanelSessions[SID] === restored,
);
check(
  'RST.2 CURRENT BEHAVIOR (defect): serializer state.sessionID does NOT land — no bridge bind, no active-sid publish',
  !G.__ccsdSidToPanel || !(SID in G.__ccsdSidToPanel) || G.__ccsdSidToPanel[SID] === undefined,
  `sidToPanel[${SID}]=${G.__ccsdSidToPanel && G.__ccsdSidToPanel[SID]}`,
);
check(
  'RST.2b ...and __ccsdActiveSid is NOT the restored sid (still unpublished/empty)',
  G.__ccsdActiveSid !== SID,
  `__ccsdActiveSid=${JSON.stringify(G.__ccsdActiveSid)}`,
);

// ================================================================ RST.4-7
// User clicks the restored tab: VSCode flips panel.active and fires
// onDidChangeViewState. ctx.__ccsdSid is "" (nothing seeded it) → §A handler
// (patch.ts:2084) latches __ccsdActiveSid="__switching__" and calls
// __ccsdSbiTick() in the same event; §G (patch.ts:2629) checks the sentinel
// FIRST and paints $(sync~spin).
const tokSbi = () => G.__ccsdTokSbi;
check('RST.0c token SBI singleton created at panel init', !!tokSbi() && typeof G.__ccsdSbiTick === 'function');
const tLatch = Date.now();
restored.active = true;
restored.visible = true;
fireViewState(restored);
check(
  'RST.4a viewState activation with empty ctx.__ccsdSid latches the __switching__ sentinel',
  G.__ccsdActiveSid === '__switching__',
  JSON.stringify(G.__ccsdActiveSid),
);
check(
  'RST.4b ...and the same-event __ccsdSbiTick paints the spinner on the token SBI',
  tokSbi().text === '$(sync~spin)' && G.__ccsdTokSbiLastText === '$(sync~spin)',
  `text=${tokSbi().text}`,
);
check(
  'RST.10 favorites-SBI mirror: active panel absent from __ccsdSidToPanel → companion activeCcSidOrLoading() cannot resolve (loading=true)',
  !(SID in G.__ccsdSidToPanel) && Object.keys(G.__ccsdSidToPanel).length === 0,
  JSON.stringify(Object.keys(G.__ccsdSidToPanel)),
);

// §G sentinel branch returns BEFORE the DIR read — data on disk is irrelevant.
let spinnerTicks = 0;
for (let i = 0; i < 3; i++) {
  G.__ccsdSbiTick();
  if (tokSbi().text === '$(sync~spin)') spinnerTicks++;
}
check(
  'RST.5 sentinel branch short-circuits BEFORE the file read: spinner persists across ticks despite a real, valid sid-r.json in the sandbox HOME',
  spinnerTicks === 3 && fs.existsSync(path.join(CC_DIR, SID + '.json')),
  `spinnerTicks=${spinnerTicks}`,
);

// LOCK: the per-panel §H 500ms tick re-asserts the sentinel while sid==="".
await sleep(650); // ≥1 §H tick
check(
  'RST.6a sentinel still latched after real 500ms §H ticks (nothing else clears it)',
  G.__ccsdActiveSid === '__switching__',
);
G.__ccsdActiveSid = SID; // force-clear: simulate any hypothetical external writer
await sleep(650); // next §H tick must re-latch (patch.ts:2636)
check(
  'RST.6b LOCK: forced external clear is REVERTED by the next §H tick (sentinel re-asserted)',
  G.__ccsdActiveSid === '__switching__',
  JSON.stringify(G.__ccsdActiveSid),
);

// NO-TIMEOUT: nothing time-based ever clears the sentinel.
let noTimeoutTicks = 0;
for (let i = 0; i < 10; i++) {
  await sleep(150);
  G.__ccsdSbiTick();
  if (tokSbi().text === '$(sync~spin)') noTimeoutTicks++;
}
check(
  'RST.7 NO-TIMEOUT: 10 ticks / 1.5s wall clock never clear the spinner without an inbound message (permanent spin when hydration never completes)',
  noTimeoutTicks === 10 && G.__ccsdActiveSid === '__switching__',
  `noTimeoutTicks=${noTimeoutTicks}`,
);

// ================================================================ RST.8
// Hydration finally completes: the webview's FIRST update_session_state.
// v0.6.1 BUGFIX path (patch.ts:2984) publishes sid on an ACTIVE panel inside
// the handler → sentinel cleared SYNCHRONOUSLY; the next §G tick reads the
// (long-available) sid-r.json and paints real tokens.
const elapsedAtHydrate = Date.now() - tLatch;
check(
  'RST.8a (setup) simulated hydration delay elapsed',
  elapsedAtHydrate >= HYDRATE_DELAY_MS,
  `${elapsedAtHydrate}ms`,
);
const hbPre = hbRead();
msg(restored, {
  type: 'request',
  channelId: 'c1',
  requestId: 'q1',
  request: { type: 'update_session_state', sessionId: SID, state: 'running', title: 'Restored Session' },
});
const clearedInHandler = G.__ccsdActiveSid === SID && G.__ccsdLastActiveSid === SID;
check(
  'RST.8b first update_session_state clears the sentinel SYNCHRONOUSLY (in-handler, pre-tick)',
  clearedInHandler,
  JSON.stringify(G.__ccsdActiveSid),
);
check(
  'RST.8c bridge bound by the same message',
  G.__ccsdSidToPanel[SID] === restored && G.__ccsdSidToTitle[SID] === 'Restored Session',
);
G.__ccsdSbiTick();
const spinnerMs = Date.now() - tLatch;
console.log(
  `  INFO  RST.8e spinner window ${spinnerMs}ms vs simulated hydration ${elapsedAtHydrate}ms (Δ=${spinnerMs - elapsedAtHydrate}ms = tick-sampling noise only)`,
);
check(
  'RST.8d next tick paints REAL tokens from sid-r.json (spinner gone)',
  tokSbi().text !== '$(sync~spin)' && /\d/.test(tokSbi().text),
  `text=${tokSbi().text}`,
);
check(
  'RST.8e CAUSAL QUANTIFICATION: measured spinner window ≈ hydration window',
  spinnerMs >= HYDRATE_DELAY_MS && spinnerMs - elapsedAtHydrate < 800,
  `spinner=${spinnerMs}ms, hydrate=${elapsedAtHydrate}ms (spinner − hydrate = ${spinnerMs - elapsedAtHydrate}ms = tick-sampling noise)`,
);
const hbPost = hbRead();
check(
  'RST.8f heartbeat obs confirms the clear source was the inbound message (update_session_state 0→1 only now)',
  (hbPre.obs.update_session_state || 0) === 0 && hbPost.obs.update_session_state >= 1,
  `${hbPre.obs.update_session_state} → ${hbPost.obs.update_session_state}`,
);

// ================================================================ RST.9
// Negative control — identical flow with NO prelude loaded. Faithfulness
// demands a SEPARATE process (a window whose CC extension.js was never
// patched has no seam state by construction; running this in-process after
// the prelude would see the prelude's own globals still alive on globalThis).
const CHILD_SRC = `
const captured = {};
const sbis = [];
const fakeVs = {
  Uri: { file: (p) => ({ fsPath: p }) },
  StatusBarAlignment: { Left: 1, Right: 2 },
  window: {
    createStatusBarItem: () => { const it = { text: '', dispose(){} }; sbis.push(it); return it; },
    registerWebviewPanelSerializer(viewType, serializer) { captured['ser:' + viewType] = serializer; },
    createWebviewPanel(viewType) { return new FakePanelCls(viewType); },
    createOutputChannel: () => ({ appendLine(){} }),
    showInformationMessage: () => Promise.resolve(),
  },
  commands: { registerCommand: () => ({ dispose(){} }) },
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
};
class FakeWebview { constructor() { this._msgCb = []; } onDidReceiveMessage(cb) { this._msgCb.push(cb); return { dispose(){} }; } postMessage() { return Promise.resolve(true); } }
class FakePanelCls {
  constructor(viewType) { this.viewType = viewType; this.active = false; this.visible = false; this.webview = new FakeWebview(); this._vsCb = []; this._disposeCb = []; }
  get title() { return this._t || ''; } set title(v) { this._t = v; }
  get iconPath() { return this._i || null; } set iconPath(v) { this._i = v; }
  onDidChangeViewState(cb) { this._vsCb.push(cb); return { dispose(){} }; }
  onDidDispose(cb) { this._disposeCb.push(cb); return { dispose(){} }; }
  reveal() {}
}
// CC 2.1.259 decompiled shape: deserializeWebviewPanel(M,F){ ... let I=j?.sessionID;
// if(D0$(I)&&e$$(I,j?.sessionUpdatedAt)) G.registerPanelSession(I,M) }
const ccSessions = {};
const origSer = {
  deserializeWebviewPanel(panel, state) {
    const sid = state && typeof state.sessionID === 'string' ? state.sessionID : '';
    if (sid) ccSessions[sid] = panel;
    return Promise.resolve();
  },
};
fakeVs.window.registerWebviewPanelSerializer('claudeVSCodePanel', origSer);
const panel = new FakePanelCls('claudeVSCodePanel');
const state = { sessionID: process.env.RST_SID, sessionUpdatedAt: 1, isFullEditor: true };
origSer.deserializeWebviewPanel(panel, state); // VSCode would call what it stored
const results = [
  ['RST.9a WITHOUT prelude: the raw host stores CC\\'s OWN serializer object (identity, no shim)', captured['ser:claudeVSCodePanel'] === origSer],
  ['RST.9b CC restore works unaided off state.sessionID (its registerPanelSession ran)', ccSessions[process.env.RST_SID] === panel],
  ['RST.9c zero seam surfaces exist in the no-prelude world — no SBI/no sentinel/no observer/nothing to spin', globalThis.__ccsdActiveSid === undefined && globalThis.__ccsdSbi === undefined && globalThis.__ccsdSbiTick === undefined && sbis.length === 0 && panel.webview._msgCb.length === 0],
];
let ok = true;
for (const [name, cond] of results) { console.log((cond ? '  PASS  ' : '  FAIL  ') + name); if (!cond) ok = false; }
process.exit(ok ? 0 : 1);
`;
let childOut = '';
try {
  childOut = execFileSync('node', ['-e', CHILD_SRC], {
    env: { ...process.env, RST_SID: SID },
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString();
} catch (_e) {
  childOut = (_e.stdout || '').toString();
  fail++; // fallthrough: the child's own FAIL lines print below
}
const childPassed = /PASS/.test(childOut) && !/FAIL/.test(childOut);
console.log(childOut.trimEnd());
if (childPassed) pass += 3;
check('RST.9 (process-isolated negative control) all three no-prelude assertions green', childPassed, childOut.trim());
// NOTE: CC本体不受影响的完整论证 = RST.3(a-d) [with-prelude verbatim delegation
// + CC's own sessionID restore ran THROUGH the shim] + RST.9 [without-prelude
// world has no seam surfaces at all]. The seam ADDS the spinner-on-hydration
// UX; it never removes or alters CC behavior.

// ---------------------------------------------------------------- teardown
for (const cb of restored._disposeCb) cb();
for (const k of BRIDGES) {
  if (savedGlobals[k] === undefined) delete globalThis[k];
  else globalThis[k] = savedGlobals[k];
}
if (fail === 0) console.log(`All ${pass} seam-restore checks passed.`);
else {
  console.log(`${pass} passed, ${fail} failed.`);
  process.exitCode = 1;
}
// HB_TIMER (30s) + per-panel ticks hold the event loop; the harness owns exit.
process.exit(process.exitCode || 0);
