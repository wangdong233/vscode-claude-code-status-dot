#!/usr/bin/env node
/**
 * test-anchor-tiers.mjs — two-tier anchor resolution behavioral gate.
 *
 * Spawns `node dist/patch.js --self-test-anchors` (which exercises the REAL
 * matchAnchorA/B/C resolvers + builders + strip against synthetic bundles:
 * 9 rows T1-T9: 238-shape tier-2, 240-shape tier-1, renamed-ids capture
 * (A=T3 / B=T8 / C=T9), double-arm / structural-drift / SDK-alias /
 * ambiguity fail-closed). Mirrors the
 */
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, '..', 'dist', 'patch.js');

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

let out = '';
let code = 0;
try {
  out = execFileSync(process.execPath, [dist, '--self-test-anchors'], { encoding: 'utf8' });
} catch (e) {
  out = (e.stdout || '') + (e.stderr || '');
  code = e.status ?? 1;
}

check('ANCH.0 dist/patch.js --self-test-anchors exits 0', code === 0, `exit=${code}`);
const rows = (out.match(/PASS T\d/g) || []).length;
check('ANCH.1 all 9 tier rows PASS', rows === 9, `rows=${rows}`);
check(
  'ANCH.2 ambiguity + drift rows explicitly pass (fail-closed semantics)',
  /PASS T4/.test(out) && /PASS T5/.test(out) && /PASS T7/.test(out),
);
check('ANCH.3 renamed-ids capture row passes', /PASS T3/.test(out));

if (fail === 0) console.log(`All ${pass} anchor-tier checks passed.`);
else {
  console.log(`${pass} passed, ${fail} failed.`);
  process.exit(1);
}
