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

// Walk the central directory looking for `package.json` at the root.
let ptr = cdOffset;
let pkgEntry = null;
for (let i = 0; i < cdEntries; i += 1) {
  if (buf.readUInt32LE(ptr) !== 0x02014b50) fail(`${vsixPath} central directory corrupt at entry ${i}`);
  const compMethod = buf.readUInt16LE(ptr + 10);
  const compSize = buf.readUInt32LE(ptr + 20);
  const uncompressedSize = buf.readUInt32LE(ptr + 24);
  const fnLen = buf.readUInt16LE(ptr + 28);
  const extraLen = buf.readUInt16LE(ptr + 30);
  const commentLen = buf.readUInt16LE(ptr + 32);
  const localHeaderOffset = buf.readUInt32LE(ptr + 42);
  const fn = buf.subarray(ptr + 46, ptr + 46 + fnLen).toString('utf8');
  if (fn === 'extension/package.json') {
    pkgEntry = { compMethod, compSize, uncompressedSize, localHeaderOffset };
    break;
  }
  ptr += 46 + fnLen + extraLen + commentLen;
}
if (!pkgEntry) fail(`${vsixPath} is missing extension/package.json — the .vsix is malformed`);

// Read the local file header to find the data offset.
const lh = pkgEntry.localHeaderOffset;
if (buf.readUInt32LE(lh) !== 0x04034b50) fail(`${vsixPath} local header for package.json corrupt`);
const lhFnLen = buf.readUInt16LE(lh + 26);
const lhExtraLen = buf.readUInt16LE(lh + 28);
const dataStart = lh + 30 + lhFnLen + lhExtraLen;
const compData = buf.subarray(dataStart, dataStart + pkgEntry.compSize);

let pkgJsonText;
if (pkgEntry.compMethod === 0) {
  pkgJsonText = compData.toString('utf8');
} else if (pkgEntry.compMethod === 8) {
  pkgJsonText = inflateRawSync(compData).toString('utf8');
} else {
  fail(`${vsixPath} package.json uses unsupported compression method ${pkgEntry.compMethod}`);
}

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

console.log(
  `[assert-companion-vsix] OK — vsix ${expectedVersion} present, embedded version matches, activationEvents clean (${JSON.stringify(
    innerActivation,
  )})`,
);
