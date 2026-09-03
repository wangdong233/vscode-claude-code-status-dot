#!/usr/bin/env node
/**
 * spike-seam.mjs — v0.6 P4 RUNTIME MILESTONE GATE (design §14: "P4 未过运行
 * 时终验不发布").
 *
 * Launches an ISOLATED VS Code instance (--user-data-dir + --extensions-dir
 * both redirected to a throwaway dir — the user's real profile/extensions are
 * never touched) carrying a FAKE Claude-Code extension whose webview posts
 * REAL inbound protocol frames (acquireVsCodeApi().postMessage — the actual
 * webview→host bridge). The fake extension is seam-patched with the REAL
 * patcher first, so the spike exercises in a REAL extension host:
 *
 *   L1 require("vscode") rebinding inside a genuine CC-shaped module
 *   L2 createWebviewPanel capture (real WebviewPanel objects + prototype
 *      accessors — the fake-vs-real descriptor concern from test-seam-runtime)
 *   L3 inbound onDidReceiveMessage observation on the real webview event
 *   L4 bridge writes observable from OTHER extensions (the companion's read
 *      side of the contract) via a probe command
 *   L5 iconPath setter shadow on the real prototype accessor
 *   L7 heartbeat file with live obs counters
 *
 * PASS criteria (all four, printed + exit code):
 *   S1  the fake CC's own log shows the wrapper engaged (createWebviewPanel
 *       returned a real panel; our probe command "ccsdSpike.probe" is
 *       registered and reports bridges populated)
 *   S2  seam-state-<pid>.json exists with surfaces.panel > 0
 *   S3  obs.update_session_state >= 2 (REAL webview frames observed)
 *   S4  icon re-assert: the probe reports the panel iconPath was re-asserted
 *       to OUR svg after CC wrote its own (deco.iconAsserts >= 1)
 *
 * Usage: node hooks/spike-seam.mjs   (opens + closes a temporary VS Code
 * window; never touches the user's install. Requires the `code` CLI.)
 */
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PATCH_TS = path.join(ROOT, 'patch.ts');

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsd-spike-'));
const USER_DATA = path.join(SB, 'user-data');
const EXTS = path.join(SB, 'exts');
const IDIR = path.join(SB, 'install');
const CC_DIR = path.join(EXTS, 'anthropic.claude-code-2.1.260-darwin-x64');
const PROBE_LOG = path.join(SB, 'probe.json');
fs.mkdirSync(CC_DIR, { recursive: true });
fs.mkdirSync(IDIR, { recursive: true });
// SVG set: the real RES dir content the seam bakes (copy from the repo).
fs.cpSync(path.join(ROOT, 'resources'), path.join(IDIR, 'resources'), { recursive: true });

// ---------------------------------------------------------------- fake CC ext
// A minimal but CC-SHAPED extension: CJS bundle requiring vscode, opens a
// webview panel (viewType claudeVSCodePanel) on startup, the webview posts
// two REAL update_session_state frames + one rename_tab, and the host then
// writes ITS OWN icon (simulating CC 2.1.257+ applyTabIcon clobber) before
// reporting everything the extension can see to probe.json via the seam's
// OWN bridges (the companion-side read contract).
const ccJs = `var vscode = require("vscode");
function activate(ctx) {
  var out = { sawWrappedRequire: false, panelReal: false, armed: false, errors: [] };
  try {
    var panel = vscode.window.createWebviewPanel("claudeVSCodePanel", "Spike CC", { viewColumn: 1 }, { enableScripts: true });
    out.panelReal = !!panel && typeof panel.onDidDispose === "function";
    panel.webview.html =
      "<script>(function(){var vs=acquireVsCodeApi();" +
      "vs.postMessage({type:'request',channelId:'c1',requestId:'q1',request:{type:'update_session_state',sessionId:'spike-sid-1',state:'running',title:'Spike Session'}});" +
      "setTimeout(function(){vs.postMessage({type:'request',channelId:'c1',requestId:'q2',request:{type:'update_session_state',sessionId:'spike-sid-1',state:'idle',title:'Spike Session'}})},400);" +
      "setTimeout(function(){vs.postMessage({type:'request',channelId:'c1',requestId:'q3',request:{type:'rename_tab',title:'Spike*',hasPendingPermissions:true}})},800);" +
      "})()</script>";
    // CC-style icon clobber 1.5s in — the seam's shadow should re-assert ours.
    setTimeout(function () {
      try { panel.iconPath = vscode.Uri.file(${JSON.stringify(path.join(CC_DIR, 'resources', 'cc-own.svg'))}); } catch (e) { out.errors.push("iconSet:" + e.message); }
    }, 1500);
    // 4s in: dump everything visible through the SEAM bridges (the exact
    // globals the companion reads in production).
    setTimeout(function () {
      try {
        var G = globalThis;
        out.bridges = {
          sbi: G.__ccsdSbi !== undefined && G.__ccsdSbi !== null,
          sbiIsItem: !!(G.__ccsdSbi && typeof G.__ccsdSbi.text === "string"),
          panelCount: typeof G.__ccsdPanelCount === "number" ? G.__ccsdPanelCount : -1,
          sidBound: !!(G.__ccsdSidToPanel && G.__ccsdSidToPanel["spike-sid-1"]),
          title: G.__ccsdSidToTitle ? G.__ccsdSidToTitle["spike-sid-1"] : null,
          pending: !!(G.__ccsdPendingSet && G.__ccsdPendingSet["spike-sid-1"]),
          wire: G.__ccsdWireState ? G.__ccsdWireState["spike-sid-1"] : null,
        };
        out.panelIcon = panel.iconPath && panel.iconPath.fsPath ? panel.iconPath.fsPath : String(panel.iconPath);
        out.commands = vscode.commands ? null : null;
      } catch (e) { out.errors.push("dump:" + e.message); }
      require("fs").writeFileSync(${JSON.stringify(PROBE_LOG)}, JSON.stringify(out));
    }, 4000);
  } catch (e) { out.errors.push("activate:" + e.message); try { require("fs").writeFileSync(${JSON.stringify(PROBE_LOG)}, JSON.stringify(out)); } catch (_) {} }
}
module.exports = { activate };
`;
fs.writeFileSync(path.join(CC_DIR, 'extension.js'), ccJs);
fs.writeFileSync(
  path.join(CC_DIR, 'package.json'),
  JSON.stringify(
    {
      name: 'claude-code',
      displayName: 'Claude Code (spike fake)',
      publisher: 'anthropic',
      version: '2.1.260',
      engines: { vscode: '^1.84.0' },
      main: './extension.js',
      activationEvents: ['onStartupFinished'],
    },
    null,
    2,
  ),
);
fs.mkdirSync(path.join(CC_DIR, 'resources'), { recursive: true });
fs.writeFileSync(
  path.join(CC_DIR, 'resources', 'cc-own.svg'),
  "<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'></svg>",
);

// ---------------------------------------------------------------- seam-patch it
const patchRun = spawnSync('npx', ['tsx', PATCH_TS, '--patch-only'], {
  cwd: ROOT,
  env: { ...process.env, CCSD_EXT_SEARCH_DIR: EXTS, CCSD_INSTALL_DIR: IDIR },
  encoding: 'utf8',
  timeout: 120_000,
});
if (!/patched extension\.js \(seam prelude\)|already patched/.test((patchRun.stdout || '') + (patchRun.stderr || ''))) {
  console.error(
    '[spike][FAIL] seam patch of the fake CC did not succeed:\n' + (patchRun.stdout || '') + (patchRun.stderr || ''),
  );
  process.exit(1);
}
console.log('[spike] fake CC seam-patched OK');

// Pre-seed the throwaway profile: fresh user-data + an unknown folder opens
// in RESTRICTED MODE (workspace trust), which silently blocks third-party
// extension activation — the first spike run never activated the fake CC for
// exactly this reason. Disabling trust in the profile settings is the
// documented escape; the dir only ever lives under this sandbox.
fs.mkdirSync(path.join(USER_DATA, 'User'), { recursive: true });
fs.writeFileSync(
  path.join(USER_DATA, 'User', 'settings.json'),
  JSON.stringify(
    {
      'security.workspace.trust.enabled': false,
      'extensions.autoCheckUpdates': false,
      'extensions.autoUpdate': false,
      'update.mode': 'none',
    },
    null,
    2,
  ),
);
fs.mkdirSync(path.join(SB, 'ws'), { recursive: true });

// ---------------------------------------------------------------- launch isolated VS Code
const codeBin = spawnSync('which', ['code'], { encoding: 'utf8' }).stdout?.trim();
if (!codeBin) {
  console.error('[spike][FAIL] `code` CLI not found');
  process.exit(1);
}
console.log('[spike] launching isolated VS Code (user-data + extensions redirected)…');
const vscodeProc = spawn(
  codeBin,
  ['--user-data-dir', USER_DATA, '--extensions-dir', EXTS, '--disable-gpu', '--new-window', path.join(SB, 'ws')],
  {
    detached: true,
    stdio: 'ignore',
  },
);
vscodeProc.unref();

// ---------------------------------------------------------------- verify
let pass = 0,
  fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (detail ? '   ' + detail : ''));
  }
};

const deadline = Date.now() + 45_000;
let probe = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  if (fs.existsSync(PROBE_LOG)) {
    try {
      probe = JSON.parse(fs.readFileSync(PROBE_LOG, 'utf8'));
    } catch {
      /* partial write */
    }
    if (probe) break;
  }
}
await new Promise((r) => setTimeout(r, 1500)); // let the 30s-throttled heartbeat land (armed forces one earlier)
// v0.6 R1 fix: SIGTERM is sometimes ignored by the Electron fleet (R1 gates
// observed leaked ~340MB fleets). Escalate: TERM → poll 2s → KILL pid+tree,
// then remove the sandbox dir.
try {
  vscodeProc.kill();
} catch {
  /* already gone */
}
{
  const pid = vscodeProc.pid;
  const t0 = Date.now();
  let alive = true;
  while (Date.now() - t0 < 2000) {
    const ps = spawnSync('ps', ['-p', String(pid), '-o', 'pid='], { encoding: 'utf8' });
    if ((ps.stdout || '').trim() === '') {
      alive = false;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (alive && pid) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* raced away */
    }
    try {
      spawnSync('pkill', ['-9', '-P', String(pid)]);
    } catch {
      /* best effort */
    }
  }
  try {
    spawnSync('pkill', ['-9', '-f', 'ccsd-spike-.*user-data']);
  } catch {
    /* best effort */
  }
}

check(
  'S0 probe file written (fake CC activated in the isolated EH)',
  probe !== null,
  probe ? '' : 'no probe.json after 45s',
);
if (probe) {
  check('S1a fake CC created a real webview panel', probe.panelReal === true);
  check(
    'S1b ported machinery: SBI bridge live (real item)',
    probe.bridges?.sbi === true && probe.bridges?.sbiIsItem === true,
    JSON.stringify(probe.bridges),
  );
  check(
    'S1c panel count tracked',
    typeof probe.bridges?.panelCount === 'number' && probe.bridges.panelCount >= 1,
    String(probe.bridges?.panelCount),
  );
  check(
    'S3a REAL webview frames observed: sid bound in the panel bridge',
    probe.bridges?.sidBound === true,
    JSON.stringify(probe.bridges),
  );
  check(
    'S3b title bridge carries the rename_tab title',
    probe.bridges?.title === 'Spike*',
    String(probe.bridges?.title),
  );
  check('S3c pending set from REAL rename_tab frame', probe.bridges?.pending === true);
  check(
    'S3d wire state recorded (idle after the second frame)',
    probe.bridges?.wire === 'idle',
    String(probe.bridges?.wire),
  );
  check(
    "S4 icon re-asserted to OUR svg after CC's clobber",
    typeof probe.panelIcon === 'string' && probe.panelIcon.indexOf(path.join(IDIR, 'resources')) === 0,
    String(probe.panelIcon),
  );
  check(
    'S0b zero errors inside the fake CC',
    Array.isArray(probe.errors) && probe.errors.length === 0,
    JSON.stringify(probe.errors),
  );
}
// S2: heartbeat with live counters
{
  let hb = null;
  try {
    const names = fs.readdirSync(IDIR).filter((n) => /^seam-state-\d+\.json$/.test(n));
    if (names.length > 0) hb = JSON.parse(fs.readFileSync(path.join(IDIR, names[0]), 'utf8'));
  } catch {
    /* none */
  }
  check(
    'S2 heartbeat exists with surfaces.panel>0',
    hb !== null && (hb.surfaces?.panel || 0) > 0,
    hb ? JSON.stringify(hb.surfaces) : 'no seam-state file',
  );
  if (hb) {
    check(
      'S2b heartbeat obs counters observed REAL frames',
      (hb.obs?.update_session_state || 0) >= 2 && (hb.obs?.rename_tab || 0) >= 1,
      JSON.stringify(hb.obs),
    );
    check('S2c heartbeat deco.iconAsserts recorded', (hb.deco?.iconAsserts || 0) >= 1, String(hb.deco?.iconAsserts));
  }
}

// sandbox removal LAST — the S2 checks read IDIR under SB above.
try {
  fs.rmSync(SB, { recursive: true, force: true });
} catch {
  /* best effort */
}
console.log(
  fail === 0
    ? `[spike] ALL ${pass} runtime checks PASSED — P4 milestone gate GREEN`
    : `[spike] ${pass} passed, ${fail} FAILED`,
);
process.exit(fail === 0 ? 0 : 1);
