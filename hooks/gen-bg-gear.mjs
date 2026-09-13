#!/usr/bin/env node
/**
 * gen-bg-gear.mjs — generate the 15 `-bg` (background-task gear badge) SVG
 * variants from the 15 base SVGs in resources/.
 *
 * v3.1 geometry (user ruling 2026-09-10, three look iterations, final preview
 * confirmed "很好"). The ruling chain, recorded in full:
 *
 *   - DOT-MIRROR POSITION: the gear sits DIRECTLY BELOW the status dot, on the
 *     same vertical axis — the dot is at (18,6) r6, the gear center at
 *     cx=18, cy=18.5. The v2 lower-edge badge (cx=12, coaxial with the
 *     underline) is RETIRED.
 *   - 1.0u CLEAR GAP ("分割一点"): the dot's bottom edge is y=12 (6+6); the
 *     gear's top edge is y=13 (18.5-5.5) — exactly 1.0 unit of clear canvas
 *     between the two marks.
 *   - 92% SIZE TRADE-OFF: tipR=5.5 is 92% of the dot's r6. A 24-unit canvas
 *     cannot fit a same-size r6 gear below the dot AND keep a clear gap
 *     (dot bottom 12 + r6 would need the gear top at >=13 → tipR <=5.5 anyway);
 *     the confirmed取舍 is 5.5 + a real gap. 0.67px smaller @16px.
 *   - NO WHITE RING: the v2 0.5u light separation ring is REMOVED (it read as
 *     a dirty halo at 1x/16px under the new position).
 *   - KNOCKOUT HALO = THE DOT'S OWN FAMILY LANGUAGE: separation from the logo
 *     rays comes from a r7.0 BLACK circle inserted into the existing
 *     badge-mask (1.5u beyond the 5.5 tooth tips) — the exact mechanism the
 *     status dot itself uses (its knockout is r7.5 around r6, also 1.5u). The
 *     logo path stays BYTE-IDENTICAL; only the mask gains one circle.
 *   - GREY/SILVER, NEVER A STATUS COLOR: v3.1 shipped #4D5157 (the N1 pick for the OLD small-badge size); 2026-09-13 the user re-ruled it too dark at the dot-sized geometry and confirmed #C6CCD4 via the docs/ladder-*.png renders (the G-A.6 re-walk). The
 *     #808080/#767676 mid-greys read as a washed-out smudge at 1x/16px and
 *     merged with the -arch grey underline; darker stays neutral-axis and
 *     survives both themes).
 *
 * TWO insertions per file (this is what distinguishes v3 from v2):
 *   (1) MASK_PUNCH — the knockout halo circle, inserted immediately before
 *       `</mask>`;
 *   (2) GEAR_GROUP — the gear `<g>`, inserted immediately before `</svg>`.
 * Round-trip gate: removing BOTH insertions must restore the base file BYTE
 * FOR BYTE (the "logo zero-shift / zero-scale" requirement made testable).
 *
 * The generated set is committed; this script is the regeneration tool (and
 * the resource-integrity gate's oracle: test-bg-gear.mjs re-derives the same
 * two insertions and compares, plus pins the sha256 of every output against
 * the user-confirmed v3.1 reference renders — "the pixels the user approved
 * are the pixels that ship").
 *
 * Run:  node hooks/gen-bg-gear.mjs   (writes resources/*-bg.svg; asserts
 *       round-trip byte equality for every file; exits non-zero on drift).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RES = path.join(__dirname, '..', 'resources');

// --- gear geometry (24x24 viewBox units; see header for the ruling chain) ----
const GEAR = {
  teeth: 8,
  cx: 18, // directly below the status dot (18,6) — same vertical axis
  cy: 18.5, // moved down 0.5u: 1.0u clear gap below the dot (top edge y=13 vs dot bottom y=12)
  tipR: 5.5, // tooth tip radius — 92% of the dot's r6 (canvas 24 has no room for r6 + gap; ruling-chain trade-off)
  rootR: 3.85, // root radius between teeth
  tipHalf: 10, // half-angle (deg) of the tooth tip arc
  rootHalf: 13, // half-angle (deg) of the root arc between teeth
  holeR: 1.6, // center bore (fill-rule evenodd)
  fill: '#C6CCD4', // bright silver-grey (2026-09-13 user ruling: #4D5157 too dark on dark theme, 2.09:1; reference image asked for bright silver ~#CDD2D9; picked half a step deeper: 10.2:1 dark / 1.65:1 light = same class as the -fav gold line 1.9:1 on light — attribute marks may be subtle on light theme, family precedent). Never a status color.
};
// Knockout halo inside badge-mask: r7.0 = tips 5.5 + 1.5u, the dot-family
// language (the dot's own knockout is r7.5 around its r6 — also 1.5u). NO
// white ring (v3 ruling: retired).
const PUNCH = { cx: 18, cy: 18.5, r: 7.0 };

function pt(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [GEAR.cx + r * Math.cos(a), GEAR.cy + r * Math.sin(a)];
}
function f(v) {
  return +v.toFixed(2);
}

/** Gear outline path: per tooth — root arc, rising flank, tip arc, falling
 *  flank. Angles increase clockwise on screen (SVG y-down) → sweep flag 1. */
function gearPathD() {
  const step = 360 / GEAR.teeth;
  let d = '';
  for (let i = 0; i < GEAR.teeth; i++) {
    const a = i * step;
    const p0 = pt(GEAR.rootR, a - GEAR.rootHalf);
    const p1 = pt(GEAR.tipR, a - GEAR.tipHalf);
    const p2 = pt(GEAR.tipR, a + GEAR.tipHalf);
    const p3 = pt(GEAR.rootR, a + GEAR.rootHalf);
    const p4 = pt(GEAR.rootR, a + step - GEAR.rootHalf);
    d += i === 0 ? 'M' + f(p0[0]) + ' ' + f(p0[1]) : '';
    // rising flank (line)
    d += 'L' + f(p1[0]) + ' ' + f(p1[1]);
    // tooth tip arc (clockwise)
    d += 'A' + GEAR.tipR + ' ' + GEAR.tipR + ' 0 0 1 ' + f(p2[0]) + ' ' + f(p2[1]);
    // falling flank (line)
    d += 'L' + f(p3[0]) + ' ' + f(p3[1]);
    // root arc into the next tooth (clockwise)
    d += 'A' + GEAR.rootR + ' ' + GEAR.rootR + ' 0 0 1 ' + f(p4[0]) + ' ' + f(p4[1]);
  }
  d += 'Z';
  // center bore — opposite winding, punched by fill-rule="evenodd"
  d +=
    'M' +
    f(GEAR.cx + GEAR.holeR) +
    ' ' +
    f(GEAR.cy) +
    'A' +
    GEAR.holeR +
    ' ' +
    GEAR.holeR +
    ' 0 1 0 ' +
    f(GEAR.cx - GEAR.holeR) +
    ' ' +
    f(GEAR.cy) +
    'A' +
    GEAR.holeR +
    ' ' +
    GEAR.holeR +
    ' 0 1 0 ' +
    f(GEAR.cx + GEAR.holeR) +
    ' ' +
    f(GEAR.cy) +
    'Z';
  return d;
}

/** Insertion (1): the badge-mask knockout halo (dot-family language, no ring).
 *  r is formatted toFixed(1) so the baked attribute reads r="7.0" — the exact
 *  byte form of the user-confirmed reference renders. */
export function maskPunch() {
  return '<circle cx="' + PUNCH.cx + '" cy="' + PUNCH.cy + '" r="' + PUNCH.r.toFixed(1) + '" fill="black"/>';
}

/** Insertion (2): the gear group appended before `</svg>` (grey, evenodd bore). */
export function gearGroup() {
  return '<g id="ccsd-bg-gear"><path d="' + gearPathD() + '" fill="' + GEAR.fill + '" fill-rule="evenodd"/></g>';
}

/** Map claude-logo-X.svg / -fav.svg / -arch.svg → claude-logo-X-bg.svg etc. */
export function bgLeafOf(leaf) {
  return leaf.replace(/\.svg$/, '-bg.svg');
}

/** base → bg variant: TWO insertions — punch before the final `</mask>`, gear
 *  before the final `</svg>`. Byte-exact inverse: removing both === src. */
export function bgContentOf(src, punch, gear) {
  const im = src.lastIndexOf('</mask>');
  const is = src.lastIndexOf('</svg>');
  if (im < 0 || is < 0) throw new Error('no </mask>/</svg> anchor');
  return src.slice(0, im) + punch + src.slice(im, is) + gear + src.slice(is);
}

// --- CLI --------------------------------------------------------------------
// Main-module guard: importing this file (test-bg-gear.mjs pulls the pure
// helpers as its oracle) must NOT regenerate the resources — a test run that
// silently rewrites the files under test would mask hand-edit drift instead
// of failing G-A. Only a direct `node hooks/gen-bg-gear.mjs` run writes.
const BASES = [
  'claude-logo-idle.svg',
  'claude-logo-running.svg',
  'claude-logo-done.svg',
  'claude-logo-error.svg',
  'claude-logo-pending.svg',
  'claude-logo-idle-fav.svg',
  'claude-logo-running-fav.svg',
  'claude-logo-done-fav.svg',
  'claude-logo-error-fav.svg',
  'claude-logo-pending-fav.svg',
  'claude-logo-idle-arch.svg',
  'claude-logo-running-arch.svg',
  'claude-logo-done-arch.svg',
  'claude-logo-error-arch.svg',
  'claude-logo-pending-arch.svg',
];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const punch = maskPunch();
  const gear = gearGroup();
  let n = 0;
  for (const base of BASES) {
    const src = fs.readFileSync(path.join(RES, base), 'utf8');
    const out = bgContentOf(src, punch, gear);
    // round-trip byte gate: removing BOTH insertions restores the source EXACTLY
    const rt = out.split(punch).join('').split(gear).join('');
    if (rt !== src) {
      console.error('ROUND-TRIP FAIL ' + base);
      process.exit(1);
    }
    if (
      !out.includes('<path mask="url(#badge-mask)"') ||
      !out.includes('id="ccsd-bg-gear"') ||
      !out.includes(
        '<mask id="badge-mask"><rect width="24" height="24" fill="white"/><circle cx="18" cy="6" r="7.5" fill="black"/>' +
          punch,
      )
    ) {
      console.error('SHAPE FAIL ' + base);
      process.exit(1);
    }
    const dst = path.join(RES, bgLeafOf(base));
    fs.writeFileSync(dst, out);
    n++;
    console.log('wrote ' + path.basename(dst) + ' (' + Buffer.byteLength(out) + 'B)');
  }
  console.log('OK: ' + n + ' v3.1 -bg variants regenerated; all round-trip byte-equal.');
}
