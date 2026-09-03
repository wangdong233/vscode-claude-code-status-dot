#!/usr/bin/env node
/**
 * test-canary-judge.mjs — G9: the seam canary judgment matrix, driven as a
 * REAL fixture matrix over the compiled pure judge (companion/dist/canary.js).
 *
 * R1 gates track: the entire L7 canary layer had ZERO tests (mutation of any
 * branch stayed green) while it is simultaneously the last line of defense
 * for every static-gate blind spot (g4 escape, code-splitting, protocol
 * drift, payload-field drift, decoration death). This gate pins every rule's
 * fire/no-fire boundary + the one-shot semantics + the degraded-is-not-an-
 * alarm contract.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CJ = await import(path.join(ROOT, 'companion', 'dist', 'canary.js'));

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

// Dist freshness (RP.0 discipline): source edits without companion:build
// would silently test stale judge bytes.
{
  const srcM = fs.statSync(path.join(ROOT, 'companion', 'canary.ts')).mtimeMs;
  const distM = fs.statSync(path.join(ROOT, 'companion', 'dist', 'canary.js')).mtimeMs;
  check('CJ.0 dist fresh (canary.js >= canary.ts — rebuild companion after edits)', distM >= srcM);
}

const NOW = 1_000_000;
const MIN = 60 * 1000;
function mkSummary(over = {}) {
  return {
    files: 1,
    totalObs: 0,
    binds: 0,
    envelopeFail: 0,
    panelSurfaces: 0,
    ourWrites: 0,
    foreignClobbers: 0,
    degraded: [],
    ...over,
  };
}
function freshState() {
  return CJ.initCanaryState(NOW);
}
const INPUT = (summary, over = {}) => ({
  summary,
  hookActive: false,
  now: NOW,
  sinceActivateMs: 0,
  ...over,
});

// ---- healthy baselines ----
{
  const st = freshState();
  const v = CJ.judgeSeamCanary(st, INPUT(mkSummary({ totalObs: 50, binds: 5, panelSurfaces: 1, ourWrites: 12 })));
  check('H.1 healthy stream (obs+binds+ourWrites) fires NOTHING', v.fired.length === 0 && v.degradedInfo.length === 0);
}
{
  const st = freshState();
  const v = CJ.judgeSeamCanary(st, INPUT(mkSummary({ files: 0 })));
  check('H.2 no heartbeat files → canary off (fired empty)', v.fired.length === 0);
}
{
  const st = freshState();
  const v = CJ.judgeSeamCanary(
    st,
    INPUT(mkSummary({ totalObs: 3, binds: 1 }), { hookActive: false, sinceActivateMs: 20 * MIN }),
  );
  check('H.3 obs=0 needs hookActive — quiet hooks stay silent', v.fired.length === 0);
}

// ---- obs-silent (g4 / code-split escape) ----
{
  const st = freshState();
  const v1 = CJ.judgeSeamCanary(st, INPUT(mkSummary(), { hookActive: true, sinceActivateMs: 5 * MIN }));
  check('S.1 obs-silent NOT inside the 10min grace', v1.fired.length === 0);
  const v2 = CJ.judgeSeamCanary(st, INPUT(mkSummary(), { hookActive: true, sinceActivateMs: 11 * MIN }));
  check('S.2 boot-heartbeat file + hookActive >10min + obs=0 → obs-silent', v2.fired.includes('obs-silent'));
  const v3 = CJ.judgeSeamCanary(st, INPUT(mkSummary(), { hookActive: true, sinceActivateMs: 12 * MIN }));
  check('S.3 one-shot: second tick does not re-fire', !v3.fired.includes('obs-silent'));
}

// ---- obs-dropped (frozen cumulative counters — the R1 dead-code fix) ----
{
  const st = freshState();
  CJ.judgeSeamCanary(st, INPUT(mkSummary({ totalObs: 40, binds: 3 }), { hookActive: true }));
  const v1 = CJ.judgeSeamCanary(
    st,
    INPUT(mkSummary({ totalObs: 40, binds: 3 }), { hookActive: true, now: NOW + 5 * MIN }),
  );
  check('D.1 frozen counters <10min → silent', v1.fired.length === 0);
  const v2 = CJ.judgeSeamCanary(
    st,
    INPUT(mkSummary({ totalObs: 40, binds: 3 }), { hookActive: true, now: NOW + 11 * MIN }),
  );
  check('D.2 frozen counters >10min with hooks active → obs-dropped', v2.fired.includes('obs-dropped'));
  const v3 = CJ.judgeSeamCanary(
    st,
    INPUT(mkSummary({ totalObs: 41, binds: 3 }), { hookActive: true, now: NOW + 12 * MIN }),
  );
  check('D.3 counter moved again → no new alarm (recovery)', !v3.fired.includes('obs-dropped'));
  const v4 = CJ.judgeSeamCanary(
    st,
    INPUT(mkSummary({ totalObs: 41, binds: 3 }), { hookActive: true, now: NOW + 40 * MIN }),
  );
  check('D.4 re-frozen >10min → STILL one-shot (fired once per EH)', !v4.fired.includes('obs-dropped'));
}

// ---- env-fail ----
{
  const st = freshState();
  const v = CJ.judgeSeamCanary(st, INPUT(mkSummary({ envelopeFail: 10 })));
  check('E.1 envelopeFail>=10 → env-fail', v.fired.includes('env-fail'));
  const st2 = freshState();
  const v2 = CJ.judgeSeamCanary(st2, INPUT(mkSummary({ envelopeFail: 9 })));
  check('E.2 envelopeFail=9 → silent (boundary)', v2.fired.length === 0);
}

// ---- payload-drift (sessionId renamed — the negation MED fix) ----
{
  const st = freshState();
  const v1 = CJ.judgeSeamCanary(st, INPUT(mkSummary({ totalObs: 9 })));
  check('P.1 obs=9 binds=0 → silent (below threshold)', v1.fired.length === 0);
  const v2 = CJ.judgeSeamCanary(st, INPUT(mkSummary({ totalObs: 10 })));
  check('P.2 obs>=10 binds=0 → payload-drift', v2.fired.includes('payload-drift'));
  const st3 = freshState();
  const v3 = CJ.judgeSeamCanary(st3, INPUT(mkSummary({ totalObs: 10, binds: 1 })));
  check('P.3 binds>0 with obs=10 → silent (binding works)', v3.fired.length === 0);
}

// ---- deco-silent (keys on OUR writes, not foreign clobbers — negation fix) ----
{
  const st = freshState();
  // tick 1: panels+messages, ourWrites=0 → arms the 2-tick rule, no alarm
  const v1 = CJ.judgeSeamCanary(st, INPUT(mkSummary({ totalObs: 5, panelSurfaces: 1, ourWrites: 0 })));
  check('K.1 deco-silent needs 2 consecutive ticks (first tick silent)', v1.fired.length === 0);
  const v2 = CJ.judgeSeamCanary(st, INPUT(mkSummary({ totalObs: 6, panelSurfaces: 1, ourWrites: 0 })));
  check('K.2 second tick with ourWrites=0 → deco-silent', v2.fired.includes('deco-silent'));
  const st3 = freshState();
  CJ.judgeSeamCanary(st3, INPUT(mkSummary({ totalObs: 5, panelSurfaces: 1, ourWrites: 0 })));
  const v3 = CJ.judgeSeamCanary(st3, INPUT(mkSummary({ totalObs: 6, panelSurfaces: 1, ourWrites: 1 })));
  check('K.3 ourWrites>0 → healthy CC that never clobbers stays SILENT (R1 false-positive fix)', v3.fired.length === 0);
  const v4 = CJ.judgeSeamCanary(
    st3,
    INPUT(mkSummary({ totalObs: 7, panelSurfaces: 1, ourWrites: 2, foreignClobbers: 5 })),
  );
  check('K.4 foreign clobbers alone never trigger deco-silent', !v4.fired.includes('deco-silent'));
}

// ---- degraded is INFO, never an alarm ----
{
  const st = freshState();
  const v = CJ.judgeSeamCanary(
    st,
    INPUT(
      mkSummary({ totalObs: 5, binds: 1, ourWrites: 1, degraded: ['titleShadow', 'titleShadow', 'outboundShadow'] }),
    ),
  );
  check(
    'G.1 degraded dedup + surfaced as info, NEVER as a fired alarm (§7.3 tooltip-only)',
    v.degradedInfo.length === 2 && v.fired.length === 0,
    JSON.stringify({ fired: v.fired, info: v.degradedInfo }),
  );
}

if (fail === 0) console.log(`All ${pass} canary-judge checks passed.`);
else {
  console.log(`${pass} passed, ${fail} failed.`);
  process.exit(1);
}
