#!/usr/bin/env node
/**
 * test-bg-gear.mjs — v0.6.5 background-task gear badge gates (v3.1 geometry).
 *
 * Four gate families for the "Plan C final-2" feature (user ruling
 * 2026-09-10, three look iterations, v3.1 preview confirmed "很好") — the
 * ruling is enforced MECHANICALLY, not by eyeball:
 *
 *   G-A resource integrity — all 15 `-bg` variants exist, and each one is
 *      EXACTLY its base file plus TWO insertions: the badge-mask knockout
 *      halo before `</mask>` and the gear `<g>` before `</svg>`. Removing
 *      BOTH restores the base BYTE FOR BYTE — that is the "logo zero-shift /
 *      zero-scale" requirement made testable. G-A.6 pins the sha256 of every
 *      output to the USER-CONFIRMED v3.1 reference renders (2026-09-10
 *      preview): the pixels the user approved are the pixels that ship — any
 *      regeneration that drifts a single byte fails here even if round-trip
 *      still holds (e.g. a "harmless" constant tweak in the generator).
 *
 *   G-B gear spec pins (v3.1) — grey #4D5157 (never a status color), 8-tooth
 *      (8 tip arcs + 8 root arcs + 2 bore arcs), cx=18 DIRECTLY BELOW the
 *      status dot (same vertical axis), cy=18.5, tipR=5.5 (= 92% of the dot's
 *      r6 — canvas 24 cannot fit r6 + a clear gap; ruling-chain trade-off),
 *      NO white ring (v2's ring retired), separation = the dot's own family
 *      language (a badge-mask knockout r7.0 = tips + 1.5u, mirroring the dot's
 *      r7.5 knockout around its r6), gear top edge y=13 keeping a >=1.0u clear
 *      gap to the dot's bottom edge y=12 ("分割一点"), gear bottom edge
 *      (cy+tipR=24.0) not past the y=24 canvas edge.
 *
 *   G-C reader wiring — the baked IIFE (via --check-iife, same extraction
 *      as test-iife.mjs) defines bgOf() with the CC_DEFAULT guard + the
 *      idempotent leaf regex + the existsSync fail-open cache; the §H tick
 *      parses __bgN WITH the Number.isFinite guard (V-FLAW-1: a hand-edited
 *      bg:Infinity must not pin the gear on forever — verified FUNCTIONALLY
 *      too), computes the mtime freshness gate __bgOn against the INDEPENDENT
 *      BG_STALE_MS=24h constant (23:59 on / 24:01 off / 2h still on, executed
 *      at the boundary; the 2h SBI_MISSING_LT_STALE_MS decay witness must NOT
 *      be dragged along — asserted separately), composes bgOf(favOf(...)) on
 *      BOTH icon assignment sites, and paints the tooltip with the dedup gate
 *      + localized count. bgOf is also EXECUTED (extracted from the baked
 *      bytes, run against the real resources/ dir). The writer side
 *      (shellBgFromPayload + carry-forward) is pinned here at source level
 *      and behaviorally by test-cc-status.js §V3.10.
 *
 * Run:  node hooks/test-bg-gear.mjs   (dist/patch.js if built, else npx tsx)
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RES = path.join(ROOT, 'resources');

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

const STATES = ['idle', 'running', 'done', 'error', 'pending'];
const FAMS = ['', '-fav', '-arch'];
const BASES = STATES.flatMap((s) => FAMS.map((f) => `claude-logo-${s}${f}.svg`));

// --- obtain the generator's oracle (single source of truth for the gear) ---
const { gearGroup, maskPunch, bgContentOf, bgLeafOf } = await import('./gen-bg-gear.mjs');
const GEAR = gearGroup();
const PUNCH = maskPunch();

console.log('bg-gear gates (v0.6.5 Plan C final-2, geometry v3.1)');
console.log('(oracle: hooks/gen-bg-gear.mjs gearGroup + maskPunch)\n');

// ---------------------------------------------------------------------------
// G-A resource integrity
// ---------------------------------------------------------------------------
console.log('G-A resource integrity (logo zero-shift, byte level)');
for (const base of BASES) {
  const bgLeaf = bgLeafOf(base);
  const basePath = path.join(RES, base);
  const bgPath = path.join(RES, bgLeaf);
  check(`G-A.1 ${bgLeaf} exists`, fs.existsSync(bgPath), 'regenerate with `node hooks/gen-bg-gear.mjs`');
  if (!fs.existsSync(bgPath) || !fs.existsSync(basePath)) continue;
  const src = fs.readFileSync(basePath, 'utf8');
  const out = fs.readFileSync(bgPath, 'utf8');
  // round-trip: output minus BOTH insertions === source, byte for byte
  check(
    `G-A.2 ${bgLeaf} minus (punch+gear) insertions === ${base} (byte level)`,
    out.split(PUNCH).join('').split(GEAR).join('') === src,
    'logo/underline/title bytes must not move — rerun the generator',
  );
  // forward derivation: base + punch before </mask> + gear before </svg> === output
  check(
    `G-A.3 ${bgLeaf} === base with punch+</mask> and gear+</svg> insertions`,
    bgContentOf(src, PUNCH, GEAR) === out,
  );
  // everything BEFORE the punch insertion point is byte-identical (svg attrs,
  // <title>, the mask's white rect + the dot's own r7.5 knockout) — names the
  // "existing mask/defs untouched" requirement; G-A.2 already covers the rest.
  check(
    `G-A.4 ${bgLeaf} prefix through the dot knockout byte-identical to base`,
    out.startsWith(src.slice(0, src.lastIndexOf('</mask>'))) && out.endsWith(src.slice(src.lastIndexOf('</svg>'))),
  );
}
check(
  'G-A.5 resources/ holds exactly the 30 claude-logo SVGs (15 base + 15 -bg)',
  fs.readdirSync(RES).filter((n) => n.startsWith('claude-logo') && n.endsWith('.svg')).length === 30,
);
// G-A.6 — the USER-CONFIRMED PIXELS anchor: sha256 of every -bg output pinned
// to the v3.1 reference renders the user approved on 2026-09-10 ("很好").
// Derived once from the confirmed artifacts; a regeneration that drifts even
// one byte (e.g. someone nudges a generator constant and re-runs) fails here
// even though round-trip still holds. Updating these hashes REQUIRES a new
// user-confirmed preview — do not edit them to "make the test pass".
{
  const REF_SHA256 = {
    'claude-logo-idle-bg.svg': '4ca5dade8044b2154a768473581358dd45cb9c85c9b64e59606e9ebe05eb1a7e',
    'claude-logo-running-bg.svg': '3744731c6b65f42d9905e3aa84f95683076e686afdc3bc5668b4cf8281027e21',
    'claude-logo-done-bg.svg': 'ac266292d098233067e11cda6a89f2d8629b16789811dcd858b395daab62ad74',
    'claude-logo-error-bg.svg': 'a08eb8f2eab68bb0c046ff3e9bc7f23cee8d27aff5f7747b90a2441960938b46',
    'claude-logo-pending-bg.svg': '6285f01f7b5c9be60ecd6e9dfb33ee8b2cc4364f0c9ecf2ffdbb237dbf1eb6d3',
    'claude-logo-idle-fav-bg.svg': '520e09326f1046317226a393a04cc371978d039b695129b675baced2941dd7c5',
    'claude-logo-running-fav-bg.svg': '09f246a67820406a873de0ded8bb448248298fe8c2c5e01beb07ce6e57e2b667',
    'claude-logo-done-fav-bg.svg': '6ad1d6f121356383e4f4743267fb5babff6fe0a365f0419d5a030a3d4c3942bb',
    'claude-logo-error-fav-bg.svg': '6f8e85939c7a7d91a1831d61ecbc2b02de762488c9e7b0833ead14ce2cc29815',
    'claude-logo-pending-fav-bg.svg': '40bf99cb66134b774c2a9802758a53161877ede383cd3e20590e3da9697c1d25',
    'claude-logo-idle-arch-bg.svg': '2de88ea23c82b6a0f2f7ccdf994c9e5dc26f5d3cb3ef976b108dd239b1c8297f',
    'claude-logo-running-arch-bg.svg': 'e7f93d5471afe917ff250ad3c404f3dc9db94a72f457fcdc80bbe511987f410f',
    'claude-logo-done-arch-bg.svg': '024d326cfe54af162f7d7430d763c2e94ed509bfa63fb88ae0345dae3cb4178c',
    'claude-logo-error-arch-bg.svg': 'e5c04313d8d97a89a477794c1e4ae8f293bc6973bf34774e28c70ca5f0610564',
    'claude-logo-pending-arch-bg.svg': 'ceb3de8deb50c1cd5b382a1a2576ea9c8a3b4ebf59125b132f8251f372c691ee',
  };
  for (const [leaf, want] of Object.entries(REF_SHA256)) {
    const got = createHash('sha256')
      .update(fs.readFileSync(path.join(RES, leaf)))
      .digest('hex');
    check(`G-A.6 ${leaf} sha256 === user-confirmed v3.1 reference render`, got === want, `got ${got}`);
  }
}

// ---------------------------------------------------------------------------
// G-B gear spec pins (v3.1 ruling: dot-mirror position, knockout halo, no ring)
// ---------------------------------------------------------------------------
console.log('\nG-B gear spec pins (v3.1: dot-mirror, knockout halo, no ring)');
{
  const sample = fs.readFileSync(path.join(RES, 'claude-logo-done-bg.svg'), 'utf8');
  const g = sample.slice(sample.indexOf('<g id="ccsd-bg-gear"'), sample.lastIndexOf('</svg>'));
  check(
    'G-B.1 gear fill is #4D5157 (neutral dark grey — never a status color)',
    g.includes('fill="#4D5157"') &&
      !['#3FB950', '#CCA700', '#F85149', '#58A6FF', '#808080', '#F5A623', '#D97757'].some((c) =>
        g.includes(`fill="${c}"`),
      ),
    'status colors: green/yellow/red/blue/idle-arch-grey/fav-gold/logo-orange',
  );
  // v3.1: NO separation ring — the gear group is exactly one <path>, zero
  // <circle> (v2's 0.5u white ring is retired by the ruling).
  check(
    'G-B.2 NO separation ring (gear group = 1 <path>, 0 <circle> — v2 ring retired)',
    (g.match(/<path /g) || []).length === 1 && !g.includes('<circle'),
  );
  check(
    'G-B.3 8 teeth: 8 tip arcs (A5.5) + 8 root arcs (A3.85) + 2 bore arcs (A1.6)',
    (g.match(/A5\.5 5\.5 0 0 1 /g) || []).length === 8 &&
      (g.match(/A3\.85 3\.85 0 0 1 /g) || []).length === 8 &&
      (g.match(/A1\.6 1\.6 0 1 0 /g) || []).length === 2,
  );
  check('G-B.4 center bore punched via fill-rule evenodd', g.includes('fill-rule="evenodd"'));
  // knockout halo: r7.0 black circle inside badge-mask, AFTER the dot's own
  // r7.5 knockout — the dot-family separation language (both = body + 1.5u).
  const pm = sample.match(
    /<circle cx="18" cy="6" r="7\.5" fill="black"\/>(<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" fill="black"\/>)<\/mask>/,
  );
  check(
    "G-B.5 badge-mask gains exactly one knockout after the dot's own: (18,18.5) r7.0",
    !!pm && pm[2] === '18' && pm[3] === '18.5' && pm[4] === '7.0',
    pm ? `punch=(${pm[2]},${pm[3]}) r${pm[4]}` : 'punch circle not found in badge-mask',
  );
  // geometry from the FILE (not the oracle): the bore arcs expose cx/cy/holeR.
  const bm = g.match(/M([\d.]+) ([\d.]+)A1\.6 1\.6 0 1 0 ([\d.]+) ([\d.]+)A1\.6/);
  const cx = bm ? (+bm[1] + +bm[3]) / 2 : NaN;
  const cy = bm ? +bm[2] : NaN;
  check('G-B.6 gear cx=18 — DIRECTLY BELOW the status dot (18,6), same vertical axis', cx === 18, 'cx=' + cx);
  check('G-B.7 gear cy=18.5 (ruling: 0.5u below the flush cy=18 draft)', cy === 18.5, 'cy=' + cy);
  const dotM = sample.match(/<circle cx="18" cy="6" r="6" fill="#3FB950"\/>/);
  const tipR = 5.5; // pinned by G-B.3's arc radii
  check(
    'G-B.8 dot-to-gear clear gap >= 1.0u ("分割一点": dot bottom y12, gear top y13)',
    dotM && cy - tipR - 12 >= 1.0 - 1e-9,
    `gap=${(cy - tipR - 12).toFixed(2)}u (dot bottom=12, gear top=${cy - tipR})`,
  );
  check(
    'G-B.9 tipR 5.5 = 92% of the dot r6 (canvas 24 cannot fit r6 + gap — ruling trade-off)',
    !!dotM && Math.abs(tipR / 6 - 5.5 / 6) < 1e-9 && tipR < 6,
    `tipR/r6=${(tipR / 6).toFixed(3)}`,
  );
  check(
    'G-B.10 gear bottom edge (cy+tipR) does not pass the y=24 canvas edge',
    cy + tipR <= 24 + 1e-9,
    `bottom=${cy + tipR}`,
  );
  // knockout halo family language: punch r = tips + 1.5u, exactly mirroring
  // the dot's knockout (r7.5 = body 6 + 1.5u).
  check(
    "G-B.11 knockout halo = tips + 1.5u, mirroring the dot's r7.5 = r6 + 1.5u (family language)",
    !!pm && +pm[4] - tipR === 1.5 && 7.5 - 6 === 1.5,
    `punch-tips=${pm ? +pm[4] - tipR : 'n/a'}u`,
  );
  // every -bg file carries the identical gear group AND punch (uniform badge)
  check(
    'G-B.12 all 15 -bg files embed the IDENTICAL gear group + knockout punch',
    BASES.every((b) => {
      const t = fs.readFileSync(path.join(RES, bgLeafOf(b)), 'utf8');
      return t.includes(GEAR) && t.includes(PUNCH);
    }),
  );
}

// ---------------------------------------------------------------------------
// G-C reader wiring (baked IIFE source-pins + functional bgOf / __bgN / __bgOn)
// ---------------------------------------------------------------------------
console.log('\nG-C reader wiring (baked IIFE)');
const DIST_PATCH = path.join(ROOT, 'dist', 'patch.js');
function getIife() {
  if (fs.existsSync(DIST_PATCH)) {
    const r = spawnSync(process.execPath, [DIST_PATCH, '--check-iife'], { encoding: 'utf8' });
    if (r.status === 0) return r.stdout.slice(r.stdout.indexOf('/*cc-status-dot-injected'));
    throw new Error('--check-iife failed via dist/patch.js: ' + (r.stderr || ''));
  }
  const r = spawnSync('npx', ['tsx', 'patch.ts', '--check-iife'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status === 0) return r.stdout.slice(r.stdout.indexOf('/*cc-status-dot-injected'));
  throw new Error('--check-iife failed via tsx: ' + (r.stderr || ''));
}
const iife = getIife();

// C.1 bgOf definition + guards
check('G-C.1 IIFE defines bgOf(p,on) overlay', iife.includes('function bgOf(p,on){'));
check(
  'G-C.2 bgOf guards CC_DEFAULT (interrupted flash off-frame carries no badge)',
  /function bgOf\(p,on\)\{try\{if\(!on\|\|!p\|\|p===CC_DEFAULT\)return p;/.test(iife),
);
check(
  'G-C.3 bgOf leaf regex is the idempotent 3-family form (base|-fav|-arch, never -bg twice)',
  /claude-logo-\(idle\|running\|done\|error\|pending\)\(-fav\|-arch\)\?\\\.svg\$/.test(iife),
);
check(
  'G-C.4 bgOf fail-open: per-leaf statSync cache resolves missing -bg to the gear-less original',
  iife.includes('__ccsdBgRes') && /catch\(_\)\{c\[leaf\]=null\}\}return c\[leaf\]\|\|p/.test(iife),
);
// C.2 tick wiring
check(
  'G-C.5 §H tick parses __bgN from j.bg WITH the Number.isFinite guard (V-FLAW-1)',
  iife.includes('__bgN=(typeof j.bg==="number"&&Number.isFinite(j.bg)&&j.bg>0&&Math.floor(j.bg)===j.bg)?j.bg:0'),
);
// C.6 __bgOn freshness gate — 24h boundary, INDEPENDENT from the 2h SBI witness
check(
  'G-C.6a __bgOn mtime gate keys off the INDEPENDENT BG_STALE_MS (<24h, __adj-aware)',
  iife.includes('var __bgOn=__bgN>0&&__mt>0&&(__adj?__adj(__mt)-__mt:now-__mt)<BG_STALE_MS;'),
);
check(
  'G-C.6b IIFE bakes BG_STALE_MS=24h AND SBI_MISSING_LT_STALE_MS=2h (two knobs, not one)',
  /var BG_STALE_MS=86400000;/.test(iife) && /var SBI_MISSING_LT_STALE_MS=7200000;/.test(iife),
);
check(
  'G-C.6c decay predicate still uses SBI_MISSING_LT_STALE_MS — NOT dragged to BG_STALE_MS',
  /E\(mt\)\)>SBI_MISSING_LT_STALE_MS\)\)\)return __ccsdWfAlive/.test(iife) &&
    !/__bgOn=[^;]*SBI_MISSING_LT_STALE_MS/.test(iife),
);
check(
  'G-C.7 pending branch composes bgOf(favOf(...)) (blue frame can carry the badge)',
  iife.includes('bgOf(favOf(pth.join(RES,"claude-logo-pending.svg"),sid),__bgOn)'),
);
check(
  'G-C.8 final icon assignment composes bgOf(favOf(svg,sid),__bgOn) (overlay AFTER fav/arch layer)',
  iife.includes('p.iconPath=ccuri(bgOf(favOf(svg,sid),__bgOn))'),
);
// C.3 tooltip
check(
  'G-C.9 tooltip paints the localized count via tr("ttBgTasksTpl").replace("{n}",__bgN)',
  iife.includes('tr("ttBgTasksTpl").replace("{n}",__bgN)'),
);
check(
  'G-C.10 tooltip dedup gate + bg→0 collapse (no IPC leak, no stale count)',
  /if\(t\.panelTab\.tooltip!==__wt\)t\.panelTab\.tooltip=__wt;/.test(iife) &&
    iife.includes('var __wt=__bgOn?(__tt+" \\u2014 "+tr("ttBgTasksTpl")'),
);
// C.4 i18n completeness (8 languages), pinned against patch.ts source too
{
  const patchSrc = fs.readFileSync(path.join(ROOT, 'patch.ts'), 'utf8');
  const m = patchSrc.match(/ttBgTasksTpl:\s*\{([\s\S]*?)\n    \},/);
  const langs = ['zh', 'en', 'ja', 'de', 'es', 'fr', 'pt', 'ru'];
  check(
    'G-C.11 I18N ttBgTasksTpl has all 8 languages with the ⚙ glyph',
    !!m &&
      langs.every(
        (l) =>
          new RegExp(`${l}:\\s*"\\u2699`).test(m[1].replace(/⚙/g, '\\u2699')) ||
          new RegExp(`${l}:\\s*"[^"]*⚙`).test(m[1]),
      ),
    'langs=' + langs.filter((l) => m && m[1].includes(l + ':')).join(','),
  );
  check('G-C.12 baked IIFE carries ttBgTasksTpl through the I18N literal', iife.includes('ttBgTasksTpl'));
}
// C.5 writer source pins (behavioral matrix lives in test-cc-status.js §V3.10)
{
  const hookSrc = fs.readFileSync(path.join(ROOT, 'hooks', 'cc-status.js'), 'utf8');
  check(
    'G-C.13 writer defines shellBgFromPayload (type===shell counting, null when absent)',
    /function shellBgFromPayload\(payload\) \{[\s\S]*?t\.type === 'shell'[\s\S]*?return shell;\n\}/.test(hookSrc),
  );
  check(
    'G-C.14 deriveStatus carries bg on EVERY case return (10 literal `bg,` sites)',
    (
      hookSrc.slice(hookSrc.indexOf('function deriveStatus'), hookSrc.indexOf('function finiteOr')).match(/\bbg,\n/g) ||
      []
    ).length === 10,
  );
  check(
    'G-C.15 cur whitelist loads prev.bg with the finite/non-negative clamp',
    hookSrc.includes('bg: Number.isFinite(prev.bg) && prev.bg >= 0 ? prev.bg : 0,'),
  );
}

// C.6 FUNCTIONAL __bgN / __bgOn — execute the baked expressions at the edges
console.log('\nG-C functional (execute baked __bgN / __bgOn / bgOf)');
{
  // __bgN parse: extract the exact conditional from the baked bytes and run
  // it against the corrupt-value zoo (V-FLAW-1 regression).
  const nm = iife.match(/__bgN=\(typeof j\.bg==="number"&&[^?]+\)\?j\.bg:0/);
  check('G-C.16 __bgN literal extractable from baked bytes', !!nm);
  if (nm) {
    const parseBg = new Function('j', 'return ' + nm[0]);
    check('G-C.17 __bgN(bg=3) → 3 (happy path)', parseBg({ bg: 3 }) === 3);
    check('G-C.18 __bgN(bg=Infinity) → 0 (V-FLAW-1: gear must not pin on forever)', parseBg({ bg: Infinity }) === 0);
    check(
      'G-C.19 __bgN(bg=NaN / -2 / 2.5 / "2" / absent) → 0',
      [NaN, -2, 2.5, '2', undefined].every((v) => parseBg({ bg: v }) === 0),
    );
  }
  // __bgOn freshness: extract the baked gate + the baked constants, execute
  // at the 24h boundary. Ages: 2h (T2's premature-hide case) and 23h59m must
  // stay ON; 24h01m must go OFF. SBI 2h stays 2h (G-C.6b pinned the bake;
  // here the VALUE extracted from the baked bytes must keep them distinct).
  const om = iife.match(/var __bgOn=__bgN>0&&__mt>0&&\(__adj\?__adj\(__mt\)-__mt:now-__mt\)<BG_STALE_MS;/);
  const bgStale = +(iife.match(/var BG_STALE_MS=(\d+);/) || [])[1];
  const sbiStale = +(iife.match(/var SBI_MISSING_LT_STALE_MS=(\d+);/) || [])[1];
  check('G-C.20 __bgOn literal + baked constants extractable', !!om && bgStale === 86400000 && sbiStale === 7200000);
  if (om) {
    const gate = new Function('__bgN', '__mt', '__adj', 'now', 'BG_STALE_MS', om[0] + ';return __bgOn;');
    const now = 1e15;
    const H = 3600000;
    check(
      'G-C.21 badge ON at mtime age 2h (T2 2h gate prematurely hid it — N1 VPN-probe class)',
      gate(2, now - 2 * H, null, now, bgStale) === true,
    );
    check(
      'G-C.22 badge ON at 23h59m (one minute before the window)',
      gate(1, now - (24 * H - 60000), null, now, bgStale) === true,
    );
    check(
      'G-C.23 badge OFF at 24h01m (one minute past the window)',
      gate(1, now - (24 * H + 60000), null, now, bgStale) === false,
    );
    check(
      'G-C.24 badge OFF when bg=0 or mtime missing (__mt=0)',
      gate(0, now, null, now, bgStale) === false && gate(2, 0, null, now, bgStale) === false,
    );
    check(
      'G-C.25 __adj-aware age (sleep ledger subtracted, not wall clock)',
      (() => {
        const adj = (ts) => ts + 10 * H; // 10h of recorded sleep overlap
        return gate(1, now - 30 * H, adj, now, bgStale) === true; // awake age 20h < 24h
      })(),
    );
    check(
      'G-C.26 BG_STALE_MS (24h) ≠ SBI_MISSING_LT_STALE_MS (2h) — independence is real, not commented',
      bgStale === 12 * sbiStale,
    );
  }
  // bgOf behavior against the real resources
  const start = iife.indexOf('function bgOf(p,on){');
  const tailMark = 'catch(_){return p}}';
  const end = iife.indexOf(tailMark, start);
  check('G-C.27 bgOf literal extractable from baked bytes', start >= 0 && end > start);
  if (start >= 0 && end > start) {
    const src = iife.slice(start, end + tailMark.length);
    const CC_DEFAULT = path.join('/fake', 'cc', 'default-logo.svg');
    const mk = (resDir) =>
      new Function('pth', 'fs', 'RES', 'CC_DEFAULT', 'globalThis', src + '; return bgOf;')(
        path,
        fs,
        resDir,
        CC_DEFAULT,
        Object.create(null),
      );
    const bgOf = mk(RES);
    check(
      'G-C.28 base leaf → -bg.svg (on=true)',
      bgOf(path.join(RES, 'claude-logo-done.svg'), true) === path.join(RES, 'claude-logo-done-bg.svg'),
    );
    check(
      'G-C.29 -fav leaf → -fav-bg.svg (layers compose)',
      bgOf(path.join(RES, 'claude-logo-running-fav.svg'), true) === path.join(RES, 'claude-logo-running-fav-bg.svg'),
    );
    check(
      'G-C.30 -arch leaf → -arch-bg.svg',
      bgOf(path.join(RES, 'claude-logo-error-arch.svg'), true) === path.join(RES, 'claude-logo-error-arch-bg.svg'),
    );
    check(
      'G-C.31 already-suffixed -bg leaf passes through (idempotent second hop)',
      bgOf(path.join(RES, 'claude-logo-done-fav-bg.svg'), true) === path.join(RES, 'claude-logo-done-fav-bg.svg'),
    );
    check('G-C.32 CC_DEFAULT passes through even when on=true', bgOf(CC_DEFAULT, true) === CC_DEFAULT);
    check(
      'G-C.33 gate off (on=false) → unchanged',
      bgOf(path.join(RES, 'claude-logo-done.svg'), false) === path.join(RES, 'claude-logo-done.svg'),
    );
    check(
      'G-C.34 non-icon path → unchanged',
      bgOf('/somewhere/claude-logo.svg', true) === '/somewhere/claude-logo.svg',
    );
    // fail-open: RES without the -bg files degrades to the gear-less original
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bgof-empty-'));
    const bgOfEmpty = mk(empty);
    check(
      'G-C.35 missing -bg file (stale install) → original icon (fail-open, never blank)',
      bgOfEmpty(path.join(empty, 'claude-logo-done.svg'), true) === path.join(empty, 'claude-logo-done.svg'),
    );
    // cached path identity: second call returns the same resolved file
    check(
      'G-C.36 per-leaf cache returns the resolved path consistently',
      bgOf(path.join(RES, 'claude-logo-pending.svg'), true) === bgOf(path.join(RES, 'claude-logo-pending.svg'), true),
    );
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
