// hooks/assert-companion-vsix.mjs
// Release gate — runs as the last step of prepublishOnly. FAILS the publish if
// the companion .vsix is missing or its embedded version doesn't match
// companion/package.json. Without this gate, a maintainer who forgets
// `npm run companion:package` would silently ship an npm tarball with NO
// .vsix — `npx vscode-claude-code-status-dot` would then warn every user
// "companion .vsix not found" and the entire v0.2.0 auto-heal surface would
// be dark for everyone.
//
// Logic:
//   1. Read companion/package.json → expect version X.Y.Z.
//   2. Check companion/cc-status-dot-companion-X.Y.Z.vsix exists.
//   3. Open the .vsix as a zip, read the inner package.json, and verify its
//      `version` AND `activationEvents` match what we expect. The activation
//      check is specifically the regression that bit v0.2.0 (illegal
//      "onStartup" event silently disabled the companion).
//   4. v0.2.8 round-1 (HIGH) — also extract extension/dist/extension.js from
//      the .vsix and verify its embedded MIN_PATCHER_VERSION + injectVersion
//      fallback literals match the source (companion/extension.ts). The
//      v0.2.8 release shipped a .vsix with MIN_PATCHER_VERSION="0.2.7" while
//      source said "0.2.8" — companion:build was last run before the source
//      bump and companion:package was never re-run. This gate catches the
//      same drift class at the release boundary, complementing the
//      dev-loop drift gate in test-version-sync.mjs (which checks
//      companion/dist/extension.js directly).
//
// Zero runtime deps — uses only Node's built-in zlib + a minimal zip central-
// directory reader (the .vsix is a standard ZIP archive, same as .vsix files
// published to the Marketplace). Avoids pulling in yauzl/adm-zip just for a
// one-shot release gate.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, '..');
const COMPANION_DIR = join(ROOT, 'companion');
const MANIFEST = join(COMPANION_DIR, 'package.json');

function fail(msg) {
  console.error(`[assert-companion-vsix][FAIL] ${msg}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const expectedVersion = manifest.version;
if (!expectedVersion || !/^\d+\.\d+\.\d+/.test(expectedVersion)) {
  fail(`companion/package.json has no valid semver 'version' (got ${JSON.stringify(expectedVersion)})`);
}

const expectedActivation = manifest.activationEvents || [];
const illegalEvents = expectedActivation.filter((e) => e === 'onStartup');
if (illegalEvents.length > 0) {
  fail(
    `companion/package.json declares activationEvents containing the illegal token "onStartup" — VS Code silently ignores it (only onStartupFinished and "*" activate). The companion would never activate. Use "onStartupFinished" instead.`,
  );
}

const vsixPath = join(COMPANION_DIR, `cc-status-dot-companion-${expectedVersion}.vsix`);
if (!existsSync(vsixPath)) {
  fail(
    `companion .vsix missing at ${vsixPath} — run \`npm run companion:package\` before publishing. The npm tarball would otherwise ship without the companion and every user would see the "companion .vsix not found" warning at install time.`,
  );
}

// Read extension/package.json from inside the .vsix zip. We only need the
// central directory + the package.json entry; minimal CDH reader below.
const buf = readFileSync(vsixPath);

// Find the End of Central Directory record (EOCD-64 skipped — vsce produces
// classic ZIPs well under the 4GB threshold).
let eocd = -1;
for (let i = buf.length - 22; i >= 0; i -= 1) {
  if (buf.readUInt32LE(i) === 0x06054b50) {
    eocd = i;
    break;
  }
}
if (eocd === -1) fail(`${vsixPath} is not a valid ZIP (no EOCD record)`);

const cdEntries = buf.readUInt16LE(eocd + 10);
const cdSize = buf.readUInt32LE(eocd + 12);
const cdOffset = buf.readUInt32LE(eocd + 16);
if (cdOffset + cdSize > buf.length) fail(`${vsixPath} central directory is truncated`);

// v0.2.8 round-1 (HIGH): factor the central-directory walk into a helper so we
// can pull BOTH extension/package.json (manifest version/activationEvents
// check) AND extension/dist/extension.js (compiled-in MIN_PATCHER_VERSION +
// injectVersion fallback check) out of the same .vsix. Returns the inflated
// file text or null if the entry is absent.
function readVsixEntry(entryName) {
  let ptr = cdOffset;
  for (let i = 0; i < cdEntries; i += 1) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) fail(`${vsixPath} central directory corrupt at entry ${i}`);
    const compMethod = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const fnLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);
    const fn = buf.subarray(ptr + 46, ptr + 46 + fnLen).toString('utf8');
    if (fn === entryName) {
      // Read the local file header to find the data offset.
      const lh = localHeaderOffset;
      if (buf.readUInt32LE(lh) !== 0x04034b50) fail(`${vsixPath} local header for ${entryName} corrupt`);
      const lhFnLen = buf.readUInt16LE(lh + 26);
      const lhExtraLen = buf.readUInt16LE(lh + 28);
      const dataStart = lh + 30 + lhFnLen + lhExtraLen;
      const compData = buf.subarray(dataStart, dataStart + compSize);
      if (compMethod === 0) return compData.toString('utf8');
      if (compMethod === 8) return inflateRawSync(compData).toString('utf8');
      fail(`${vsixPath} ${entryName} uses unsupported compression method ${compMethod}`);
    }
    ptr += 46 + fnLen + extraLen + commentLen;
  }
  return null;
}

const pkgJsonText = readVsixEntry('extension/package.json');
if (pkgJsonText === null) fail(`${vsixPath} is missing extension/package.json — the .vsix is malformed`);

let innerPkg;
try {
  innerPkg = JSON.parse(pkgJsonText);
} catch (e) {
  fail(`${vsixPath} extension/package.json is not valid JSON: ${e.message}`);
}

if (innerPkg.version !== expectedVersion) {
  fail(
    `${vsixPath} version drift: companion/package.json declares ${expectedVersion}, the .vsix embeds ${innerPkg.version}. Re-run \`npm run companion:package\` after bumping the manifest.`,
  );
}

const innerActivation = innerPkg.activationEvents || [];
const innerIllegal = innerActivation.filter((e) => e === 'onStartup');
if (innerIllegal.length > 0) {
  fail(
    `${vsixPath} ships the illegal activationEvents token "onStartup" — the companion would never activate. Rebuild the .vsix after switching to "onStartupFinished".`,
  );
}

// v0.2.8 round-1 (HIGH): cross-check the compiled-in version constants inside
// the .vsix against companion/extension.ts source. This is the exact drift
// that bit v0.2.8: extension.ts source said MIN_PATCHER_VERSION="0.2.8" but
// the compiled artifact embedded in the .vsix still said "0.2.7" because
// companion:package ran before the source bump. Without this gate, the only
// thing checking the .vsix is the manifest version (already checked above) —
// the JS-embedded literals sail through unchecked.
const companionSrc = readFileSync(join(COMPANION_DIR, 'extension.ts'), 'utf8');
const srcMinPatcher = companionSrc.match(/const\s+MIN_PATCHER_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/);
const srcInjectFallback = companionSrc.match(
  /function\s+injectVersion\([^)]*\)(?::[^{]*)?{[\s\S]*?\?\?\s*"v(\d+\.\d+\.\d+)"/,
);
if (!srcMinPatcher) fail(`companion/extension.ts missing MIN_PATCHER_VERSION literal — source drift`);
if (!srcInjectFallback) fail(`companion/extension.ts missing injectVersion() ?? "vX.Y.Z" fallback — source drift`);

const extJsText = readVsixEntry('extension/dist/extension.js');
if (extJsText === null) {
  fail(
    `${vsixPath} is missing extension/dist/extension.js — the .vsix was packaged before \`npm run companion:build\` emitted the compiled artifact. Re-run \`npm run companion:build && npm run companion:package\`.`,
  );
}

const distMinPatcher = extJsText.match(/MIN_PATCHER_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/);
if (!distMinPatcher) {
  fail(
    `${vsixPath} extension/dist/extension.js missing MIN_PATCHER_VERSION literal — compiled artifact shape changed?`,
  );
}
if (distMinPatcher[1] !== srcMinPatcher[1]) {
  fail(
    `${vsixPath} STALE compiled artifact: extension.ts source has MIN_PATCHER_VERSION="${srcMinPatcher[1]}" but the embedded extension.js has "${distMinPatcher[1]}". Re-run \`npm run companion:build && npm run companion:package\` after editing extension.ts. This exact drift shipped the v0.2.8 HIGH finding.`,
  );
}

// The TS compiler keeps `?? "vX.Y.Z"` literal verbatim in the emitted JS, so
// the same regex shape works against the compiled output.
const distInjectFallback = extJsText.match(/\?\?\s*"v(\d+\.\d+\.\d+)"/);
if (!distInjectFallback) {
  fail(`${vsixPath} extension/dist/extension.js missing injectVersion() ?? "vX.Y.Z" fallback literal`);
}
if (distInjectFallback[1] !== srcInjectFallback[1]) {
  fail(
    `${vsixPath} STALE compiled artifact: extension.ts source has injectVersion fallback v${srcInjectFallback[1]} but the embedded extension.js has v${distInjectFallback[1]}. Re-run \`npm run companion:build && npm run companion:package\`.`,
  );
}

// v0.6 R3 recommendation — CONTENT markers: the version/activation checks
// above cannot see a .vsix whose embedded RUNTIME SET or canary judge is
// STALE BYTES (the 0.6.0 rc3 incident: a pre-fix vsix carried the rc2
// hostSid self-recursion + sidebar false-positive in extension/runtime/patch.js
// and extension/dist/canary.js). Pin the load-bearing literals that must
// exist in the packaged artifacts — a stale rebuild fails HERE, at the
// release boundary, instead of shipping.
{
  const runtimePatch = readVsixEntry('extension/runtime/patch.js');
  if (runtimePatch === null) {
    fail(
      `${vsixPath} missing extension/runtime/patch.js — run \`npm run build && npm run companion:package\` (embed-runtime step).`,
    );
  }
  const markers = [
    ['CTX_BY_SID registration present', /CTX_BY_SID\[sid\d?\]=ctx/.test(runtimePatch)],
    ['no hostSid self-recursion residue (rc2 bug)', !/hostSid\(ctx,sid\d?\)}catch/.test(runtimePatch)],
    ['directive scanner accepts newline terminator', /\(\[,;\]\|\\r\?\\n\)/.test(runtimePatch)],
    ['boot heartbeat at module load', /hbWrite\(true\)/.test(runtimePatch)],
  ];
  for (const [name, ok] of markers) {
    if (!ok)
      fail(
        `${vsixPath} embedded runtime/patch.js: ${name} — STALE artifact; re-run \`npm run build && npm run companion:package\`.`,
      );
  }
  const canaryJs = readVsixEntry('extension/dist/canary.js');
  if (canaryJs === null) {
    fail(
      `${vsixPath} missing extension/dist/canary.js — run \`npm run companion:build && npm run companion:package\`.`,
    );
  }
  if (!/s\.panelSurfaces\s*>\s*0/.test(canaryJs)) {
    fail(
      `${vsixPath} embedded dist/canary.js missing the payload-drift panelSurfaces gate (rc2 bug) — STALE artifact; re-run \`npm run companion:build && npm run companion:package\`.`,
    );
  }
}

console.log(
  `[assert-companion-vsix] OK — vsix ${expectedVersion} present, embedded version matches, activationEvents clean (${JSON.stringify(
    innerActivation,
  )}), compiled MIN_PATCHER_VERSION=${distMinPatcher[1]} + injectVersion fallback v${distInjectFallback[1]} match source, runtime/canary content markers verified`,
);
