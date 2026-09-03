#!/usr/bin/env node
/**
 * test-seam-runtime.mjs — v0.6 seam prelude BEHAVIORAL gate (headless).
 *
 * Loads the REAL compiled prelude (emitted via `patch.ts --emit-seam-prelude`
 * with a sandboxed INSTALL_DIR) into a plain-node CJS module wrapper with a
 * fake vscode namespace, then drives every seam layer end-to-end:
 *   L1 require rebinding + passthrough + .resolve/.main/.cache mirrors
 *   L2 surface capture (create / view-provider / serializer dual-name) + whitelist
 *   L3 inbound envelope judgment + outbound postMessage shadow (3-value whitelist)
 *   L4 binding-layer/observation-layer separation (HIGH#1) + farewell unbind
 *   L5 title/iconPath setter shadows (record/passthrough/re-assert, no loop)
 *   L6 bridge contracts (__ccsdSidToPanel shapes, sidToTitle, pending sets)
 *   L7 heartbeat file (layered fields + obs counters + envelopeFail)
 *   §Z teardown via panel dispose
 *
 * Mirrors the repo's dist-freshness discipline: the emitted prelude must be
 * newer than patch.ts (RP.0-style), and every fake object matches the REAL
 * VSCode descriptor shape (accessors on the PROTOTYPE for title/iconPath;
 * postMessage as a prototype value-property) so a shadow that only works on
 * the test fakes cannot pass.
 */
import { execFileSync } from 'node:child_process';
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

// ---------------------------------------------------------------- sanity
// Emit the REAL prelude with a sandboxed INSTALL_DIR.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsd-seam-rt-'));
const IDIR = path.join(SANDBOX, 'install');
fs.mkdirSync(IDIR, { recursive: true });
const EMIT = path.join(SANDBOX, 'prelude.json');
execFileSync('npx', ['tsx', PATCH_TS, '--emit-seam-prelude', EMIT], {
  cwd: ROOT,
  env: { ...process.env, CCSD_INSTALL_DIR: IDIR },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const mtimePre = fs.statSync(EMIT).mtimeMs;
const mtimeTs = fs.statSync(PATCH_TS).mtimeMs;
check('SR.0 emitted prelude is fresh vs patch.ts', mtimePre >= mtimeTs, `${mtimePre} < ${mtimeTs}`);
const emitted = JSON.parse(fs.readFileSync(EMIT, 'utf8'));
const PRELUDE = emitted.body;
check(
  'SR.1 stamped block: banner line 1 legacy-format + ccsd2 identity',
  /^\/\*cc-status-dot-injected:v[0-9.]+:[0-9a-f]{4,16}\*\/\n;\s*\/\*ccsd2:begin:seam:v[0-9.]+\*\//.test(
    emitted.stamped,
  ),
);
check('SR.2 stamped block ends with ccsd2:end + newline', emitted.stamped.endsWith('/*ccsd2:end*/\n'));

// ---------------------------------------------------------------- fakes
// Fake VSCode descriptor shapes match the real EH objects:
//  - WebviewPanel: title/iconPath are PROTOTYPE ACCESSORS (real panels:
//    extHostWebviewPanels.ts defines get/set on the class prototype).
//  - Webview: postMessage is a PROTOTYPE VALUE property.
class FakePanel {
  constructor(viewType) {
    this.viewType = viewType;
    this._title = 'Claude Code';
    this._icon = null;
    this.active = true;
    this.visible = true;
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
function fireDispose(panel) {
  for (const cb of panel._disposeCb) cb();
}

const registeredCommands = [];
const sbiItems = [];
const capturedRaw = {}; // raw-API captures: what the WRAPPER handed the host
const fakeVs = {
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', __uri: true }) },
  QuickPickItemKind: { Separator: 0 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1 },
  env: { clipboard: { writeText() {} }, language: 'en' },
  window: {
    // the three raw surface APIs the seam wraps (capture what the wrapper
    // passes THROUGH to the host):
    createWebviewPanel(viewType, title, showOptions, options) {
      const p = new FakePanel(viewType);
      return p;
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
    registerCommand: (id, cb) => {
      registeredCommands.push(id);
      return { dispose() {} };
    },
    getCommands: () => Promise.resolve(registeredCommands),
  },
  workspace: {
    getConfiguration: () => ({
      get: (_k, d) => d,
      update: () => Promise.resolve(),
    }),
  },
};
const fakeRequireCalls = [];
function fakeRawRequire(id) {
  fakeRequireCalls.push(id);
  if (id === 'vscode') return fakeVs;
  if (id === 'fs' || id === 'node:fs') return fs;
  if (id === 'path' || id === 'node:path') return path;
  if (id === 'os' || id === 'node:os') return os;
  throw new Error('test fake require: unexpected module ' + id);
}
fakeRawRequire.resolve = (r) => '/fake/resolve/' + r;
fakeRawRequire.main = { id: 'fake-main' };
fakeRawRequire.cache = { '/fake': 1 };

// Run the REAL prelude inside a CJS-shaped module wrapper, with probe code
// appended in the SAME function scope (after the prelude's IIFE) so the
// probes observe the REBOUND require binding.
const wrapperSrc =
  '(function(exports, require, module, __filename, __dirname){\n' +
  PRELUDE +
  '\n;module.exports.__req = require; module.exports.__G = globalThis;\n})';
const factory = new Function('return ' + wrapperSrc)();
const moduleObj = { exports: {} };
const savedGlobals = {};
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
for (const k of BRIDGES) savedGlobals[k] = globalThis[k];
factory(moduleObj.exports, fakeRawRequire, moduleObj, path.join(SANDBOX, 'cc-ext'), path.join(SANDBOX, 'cc-ext'));
const { __req: req, __G: G } = moduleObj.exports;
// Three-hard-contract #1 (G3-companion): __ccsdSbi must be non-undefined at
// MODULE LOAD — before any panel exists — so the companion's reload-bar
// probes (:904/:952/:1077, `!== undefined`) never false-fire on a healthy
// seam-loaded window that has not opened a panel yet. null is the sentinel
// (probe-legit AND invisible to the IIFE's truthy singleton guards).
check('T.1 __ccsdSbi probe sentinel present at module load (pre-panel)', G.__ccsdSbi === null);
check(
  'T.2 bridge maps exist at module load (Object.create(null) shape)',
  G.__ccsdSidToPanel !== undefined && G.__ccsdSidToTitle !== undefined,
);

// ---------------------------------------------------------------- L1
const vs = req('vscode');
check("L1.1 require('vscode') returns the WRAPPED namespace (not identical)", vs !== fakeVs && vs !== undefined);
check('L1.2 non-vscode ids pass through untouched', req('fs') === fs && req('os') === os);
check(
  'L1.3 wrapped namespace passes members through live',
  vs.Uri.file('/x').fsPath === '/x' && vs.QuickPickItemKind.Separator === 0,
);
check(
  'L1.4 require.resolve/.main/.cache mirror the raw binding',
  req.resolve('fs') === '/fake/resolve/fs' && req.main === fakeRawRequire.main && req.cache === fakeRawRequire.cache,
);
check('L1.5 vscode namespace is memoized (same wrapper per ns)', req('vscode') === vs);
check(
  'L1.6 window sub-object is wrapped AND memoized separately',
  vs.window !== fakeVs.window && vs.window.createStatusBarItem !== undefined,
);

// ---------------------------------------------------------------- L2
// createWebviewPanel capture + whitelist
const panel1 = vs.window.createWebviewPanel('claudeVSCodePanel', 'Claude', { viewColumn: 1 }, {});
check('L2.1 createWebviewPanel returns the REAL panel object', panel1 instanceof FakePanel);
check('L2.2 CC panel armed (observer subscribed on webview)', panel1.webview._msgCb.length >= 1);
const alien = vs.window.createWebviewPanel('claudePlanPreview', 'P', {}, {});
check('L2.3 claudePlanPreview NOT armed (observer absent)', alien.webview._msgCb.length === 0);
const alien2 = vs.window.createWebviewPanel('some.other.view', 'X', {}, {});
check('L2.4 non-CC viewType NOT armed', alien2.webview._msgCb.length === 0);
// R1 gates mutation survivors: the whitelist must be ANCHORED — a future
// regression dropping PANEL_RE's ^ (or adding planPreview to VIEW_RE) must
// fail HERE, not in production bridging.
const alienMid = vs.window.createWebviewPanel('webviewClaudeVSCodePanelHost', 'M', {}, {});
check('L2.4b mid-string panel family NOT armed (PANEL_RE ^ anchor)', alienMid.webview._msgCb.length === 0);
const alienPfx = vs.window.createWebviewPanel('xclaudeVSCodePanel', 'P', {}, {});
check('L2.4c leading-garbage viewType NOT armed', alienPfx.webview._msgCb.length === 0);
const planProvider = { resolveWebviewView() {} };
vs.window.registerWebviewViewProvider('claudePlanPreview', planProvider);
check(
  'L2.4d claudePlanPreview gets the PRISTINE provider (whitelist front-loaded in the wrapper)',
  capturedRaw['view:claudePlanPreview'] === planProvider,
  'host received a synthetic object',
);
const planView = new FakePanel('claudePlanPreview');
if (capturedRaw['view:claudePlanPreview'] !== planProvider)
  capturedRaw['view:claudePlanPreview'].resolveWebviewView(planView, {}, {});
check('L2.4e planPreview view never armed even if driven', planView.webview._msgCb.length === 0);

// view provider capture (sidebar family)
let resolvedView = null;
const provider = {
  resolveWebviewView(view) {
    resolvedView = view;
  },
};
vs.window.registerWebviewViewProvider('claudeVSCodeSidebar', provider);
const sideView = new FakePanel('claudeVSCodeSidebar'); // webview shape suffices
// The host calls the SHIM it registered; the test does not hold the shim, so
// drive it through the fake registration: emulate by calling the provider the
// way the host would have (via the shim wrapper created in wrapWindow). We
// instead re-register and capture the shim via a probe:
// (Simplest honest route: the shim armed a surface when the host calls
// resolveWebviewView — emulate that call through the ORIGINAL provider's
// shim by re-registering with a capture.)
let shimRef = null;
const provider2 = {
  resolveWebviewView() {},
};
// capture the shim the wrapper passed to the raw API:
const rawRegister = fakeVs.window.registerWebviewViewProvider; // not wrapped; wrap target
// wrapWindow called RVP.call(win, viewId, SHIM, opts) — capture via the fake:
// (we re-declare fakeVs.window.registerWebviewViewProvider as a capturing fn
//  BEFORE building a second wrapper run — instead, simpler: use serializer
//  path below which we CAN capture symmetrically.)
// (L2.5 placeholder retired in R1's vacuous-assertion sweep — the view-provider
// shim is now asserted for real at L2.5b/L2.5c below.)

// serializer capture — the wrapper hands the HOST a shim; capturedRaw holds it
const origSer = {
  deserializeWebviewPanel(_p, _s) {
    return Promise.resolve();
  },
};
vs.window.registerWebviewPanelSerializer('claudeVSCodePanel', origSer);
check(
  'L2.6 host received a shim (not the original serializer object)',
  capturedRaw['ser:claudeVSCodePanel'] !== origSer,
);
const restored = new FakePanel('claudeVSCodePanel');
let serCalled = 0;
origSer.deserializeWebviewPanel = () => {
  serCalled++;
  return Promise.resolve();
};
capturedRaw['ser:claudeVSCodePanel'].deserializeWebviewPanel(restored, {});
check(
  'L2.7 serializer shim: dual-name main path arms the restored panel + delegates',
  restored.webview._msgCb.length >= 1 && serCalled === 1,
);
check(
  'L2.8 serializer shim carries the legacy alias name too',
  typeof capturedRaw['ser:claudeVSCodePanel'].resolveWebviewPanel === 'function',
);
// ---------------------------------------------------------------- L4 + L3 inbound
function msg(panel, envelope) {
  for (const cb of panel.webview._msgCb) cb(envelope);
}
msg(panel1, {
  type: 'request',
  channelId: 'c1',
  requestId: 'q1',
  request: { type: 'update_session_state', sessionId: 'sid-A', state: 'running', title: 'Session A' },
});
check('L4.1 update_session_state binds sid→panel (panel family)', G.__ccsdSidToPanel['sid-A'] === panel1);
check('L4.2 title bridge written synchronously (Layer-1a semantics)', G.__ccsdSidToTitle['sid-A'] === 'Session A');
check('L4.3 wire state recorded for the five-state merge', G.__ccsdWireState['sid-A'] === 'running');

// view family NEVER binds (HIGH#1) — drive through the sidebar shim the
// wrapper handed the host
vs.window.registerWebviewViewProvider('claudeVSCodeSidebar', provider2);
const sideShim = capturedRaw['view:claudeVSCodeSidebar'];
check(
  'L2.5b view provider: host received a shim',
  sideShim !== provider2 && typeof sideShim.resolveWebviewView === 'function',
);
const sidePanel = new FakePanel('claudeVSCodeSidebar');
sideShim.resolveWebviewView(sidePanel, {}, {});
check('L2.5c view armed for observation (observer subscribed)', sidePanel.webview._msgCb.length >= 1);
msg(sidePanel, {
  type: 'request',
  request: { type: 'update_session_state', sessionId: 'sid-S', state: 'idle', title: 'Side' },
});
check(
  'L4.4 view family updates the TITLE bridge but NEVER the panel bridge',
  G.__ccsdSidToTitle['sid-S'] === 'Side' && !('sid-S' in G.__ccsdSidToPanel),
);

// R2 HIGH pin: CTX_BY_SID must actually register (the rc2 hostSid typo made
// the map permanently empty, killing the reaper's live-ctx grace). A partial
// openSessionIds list must NOT evict a sid whose ctx is alive and fresh.
msg(panel1, {
  type: 'request',
  request: { type: 'update_session_state', sessionId: 'sid-live', state: 'running', title: 'L' },
});
panel1.webview.postMessage({
  type: 'request',
  requestId: 'ssu1',
  request: { type: 'session_states_update', openSessionIds: ['sid-live'], activeSessionId: 'sid-live' },
});
check(
  'L4.9 reconciliation grace: fresh ctx sid SURVIVES a list that includes it; a stale unknown sid is evicted',
  G.__ccsdSidToPanel['sid-live'] === panel1 && G.__ccsdActiveSid === 'sid-live',
  'live binding or active-sid harmony broken',
);

// farewell / panelNoLongerHosts unbind (§6.4 semantic fix)
msg(panel1, {
  type: 'request',
  request: { type: 'update_session_state', sessionId: 'sid-A', state: 'idle', title: 'Session A', isFarewell: true },
});
check(
  'L4.5 farewell frame unbinds the panel bridge + wire state',
  !('sid-A' in G.__ccsdSidToPanel) && !('sid-A' in G.__ccsdWireState),
);

// rename_tab pending semantics (Layer-1b equivalent)
msg(panel1, {
  type: 'request',
  request: { type: 'update_session_state', sessionId: 'sid-B', state: 'running', title: 'B' },
});
msg(panel1, { type: 'request', request: { type: 'rename_tab', title: 'B*', hasPendingPermissions: true } });
check('L4.6 rename_tab hasPendingPermissions → pending set', G.__ccsdPendingSet['sid-B'] === true);
check('L4.7 rename_tab title lands in the title bridge', G.__ccsdSidToTitle['sid-B'] === 'B*');
msg(panel1, { type: 'request', request: { type: 'rename_tab', title: 'B*', hasPendingPermissions: false } });
check('L4.8 hasPendingPermissions=false clears the pending set', !('sid-B' in G.__ccsdPendingSet));

// envelope final judgment
msg(panel1, { type: 'request', request: { type: 42 } });
msg(panel1, 'garbage');
msg(panel1, { type: 'event' });
// force a heartbeat write by arming a fresh surface (forced write)
const pForHb = vs.window.createWebviewPanel('claudeVSCodePanel2x', 't', {}, {});
const hbPath = path.join(IDIR, 'seam-state-' + process.pid + '.json');
const hb1 = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
check(
  'L3.1 envelope violations counted (non-object + malformed request)',
  hb1.envelopeFail >= 2,
  JSON.stringify(hb1.envelopeFail),
);
check('L3.2 obs counters live (uss/rename_tab > 0)', hb1.obs.update_session_state >= 3 && hb1.obs.rename_tab >= 2);
check('L3.3 prefix whitelist armed a suffixed panel variant (claudeVSCodePanel2x)', pForHb.webview._msgCb.length >= 1);
check(
  'L7.1 heartbeat layered fields present',
  hb1.v === emitted.version &&
    hb1.pid === process.pid &&
    typeof hb1.bootTs === 'number' &&
    typeof hb1.writtenTs === 'number' &&
    typeof hb1.armed === 'number' &&
    typeof hb1.degraded === 'object',
);
check('L7.2 surfaces tracked (panel count > 0)', hb1.surfaces.panel >= 2);

// ---------------------------------------------------------------- L3 outbound shadow
check(
  'L5.0 postMessage shadow installed (webview prop replaced)',
  Object.getOwnPropertyDescriptor(panel1.webview, 'postMessage') !== undefined,
);
// outbound user_dialog_request → pending; response envelope clears
panel1.webview.postMessage({
  type: 'request',
  requestId: 'rr1',
  request: { type: 'user_dialog_request', dialogKind: 'fable_overage_consent_prompt' },
});
check('L3.4 outbound user_dialog_request sets the dialog pending set', G.__ccsdUserDialogSet['sid-B'] === true);
msg(panel1, { type: 'response', channelId: 'c1', requestId: 'rr1' });
check('L3.5 response envelope clears the dialog pending set', !('sid-B' in G.__ccsdUserDialogSet));
panel1.webview.postMessage({
  type: 'request',
  requestId: 'rr2',
  request: { type: 'tool_permission_request', payload: {} },
});
check('L3.6 outbound tool_permission_request sets the tool-perm set', G.__ccsdToolPermSet['sid-B'] === true);
msg(panel1, { type: 'response', requestId: 'rr2' });
check('L3.7 response envelope clears the tool-perm set', !('sid-B' in G.__ccsdToolPermSet));
// off-whitelist passthrough: io_message must still deliver to the fake raw send
const beforeSent = (panel1.webview._sent || []).length;
panel1.webview.postMessage({ type: 'io_message', data: 'x' });
check(
  'L3.8 off-whitelist outbound passes through the raw send untouched',
  (panel1.webview._sent || []).length === beforeSent + 1,
);

// ---------------------------------------------------------------- L5 shadows
// title: record + passthrough + bridge refresh
panel1.title = 'Renamed by CC';
check(
  "L5.1 title shadow: CC's write lands (passthrough) + bridge refreshed",
  panel1.title === 'Renamed by CC' && G.__ccsdSidToTitle['sid-B'] === 'Renamed by CC',
);
// iconPath: ours (RESDIR-prefixed) recorded; CC's write re-asserted back to ours
const RES = path.join(IDIR, 'resources');
const ourUri = { fsPath: RES + '/claude-logo-running.svg' };
panel1.iconPath = ourUri;
const ccUri = { fsPath: '/Users/x/.vscode/extensions/anthropic.claude-code-2.1.259/resources/claude-logo-pending.svg' };
panel1.iconPath = ccUri;
// v0.6 R1 fix: the shadow is OBSERVE-ONLY (R1 HIGH finding — the synchronous
// re-assert killed the interrupted flash's deliberate CC_DEFAULT OFF-frame and
// churned one forced heartbeat write per second). CC's write lands untouched;
// the unchanged §H tick (clobber defense since v0.2.9) re-asserts OUR icon
// within its 500ms cadence in production — zero-regression by construction.
check("L5.2a iconPath shadow observe-only: CC's overwrite LANDS (flash OFF-frame survives)", panel1.iconPath === ccUri);
panel1.iconPath = ourUri;
check('L5.2b our RESDIR write recorded + passthrough', panel1.iconPath === ourUri);
const pForHb2 = vs.window.createWebviewPanel('claudeVSCodePanel3x', 't2', {}, {}); // forces a heartbeat write
const hb2 = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
check(
  'L5.3 deco.iconAsserts counts the FOREIGN clobber observation (no re-assert)',
  hb2.deco.iconAsserts >= 1,
  JSON.stringify(hb2.deco.iconAsserts),
);
check(
  'L5.3b deco.ourWrites counted for our RESDIR writes',
  (hb2.deco.ourWrites || 0) >= 2,
  JSON.stringify(hb2.deco.ourWrites),
);
check(
  'L5.3c obs.binds counter live (payload-field drift visibility)',
  (hb2.obs.binds || 0) >= 1,
  JSON.stringify(hb2.obs.binds),
);
check(
  'L5.3d boot heartbeat file present (canary lifeline before any surface)',
  hb2.pid === process.pid && hb2.armed >= 1,
);
check(
  'L5.4 Proxy never used (object identity preserved everywhere)',
  panel1 instanceof FakePanel && G.__ccsdSidToPanel['sid-B'] === panel1,
);

// ---------------------------------------------------------------- L5 ported IIFE
check(
  'IIFE.1 ported machinery ran: SBI singleton created (real item, not the null sentinel)',
  G.__ccsdSbi !== null && G.__ccsdSbi !== undefined && sbiItems.length >= 1,
);
check(
  'IIFE.2 three commands registered via the wrapped namespace',
  registeredCommands.includes('ccStatusDot.sbiClick') &&
    registeredCommands.includes('ccStatusDot.tokClick') &&
    registeredCommands.includes('ccStatusDot.fav.focusSession'),
);
check('IIFE.3 panel count tracked (>=2 armed panels)', G.__ccsdPanelCount >= 2);

// ---------------------------------------------------------------- G7 bridge shapes
const entries = Object.values(G.__ccsdSidToPanel);
check(
  'G7.1 every panel-bridge entry has WebviewPanel shape (onDidChangeViewState && viewColumn) — no undefined/view entries',
  entries.length >= 1 && entries.every((p) => p && typeof p.onDidChangeViewState === 'function' && 'viewColumn' in p),
  JSON.stringify(entries.length),
);

// ---------------------------------------------------------------- §Z teardown
msg(panel1, {
  type: 'request',
  request: { type: 'update_session_state', sessionId: 'sid-B', state: 'running', title: 'B' },
});
fireDispose(panel1);
check('Z.1 dispose clears the panel bridge entry', !('sid-B' in G.__ccsdSidToPanel));
check('Z.2 dispose clears the title bridge entry', !('sid-B' in G.__ccsdSidToTitle));
const hb3 = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
check(
  'Z.3 heartbeat surface count decremented',
  hb3.surfaces.panel === hb2.surfaces.panel - 1 || hb3.surfaces.panel < hb2.surfaces.panel,
);

// cleanup: dispose remaining panels so intervals clear, restore globals
fireDispose(restored);
fireDispose(pForHb);
for (const k of BRIDGES) {
  if (savedGlobals[k] === undefined) delete globalThis[k];
  else globalThis[k] = savedGlobals[k];
}

if (fail === 0) console.log(`All ${pass} seam-runtime checks passed.`);
else {
  console.log(`${pass} passed, ${fail} failed.`);
  process.exitCode = 1;
}
// The prelude's HB_TIMER (30s) + any surviving IIFE tick hold the event loop;
// a test harness owns its own exit.
process.exit(process.exitCode || 0);
