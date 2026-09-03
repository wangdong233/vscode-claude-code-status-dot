// src/semver.ts — canonical semantic-version comparator.
//
// Extracted from patch.ts in the v0.2.5 round-2 architecture-debt slice
// (ARCH-1 first slice). Pure function — no I/O, no closure dependencies.
// Used by:
//   - patch.ts: discoverExtension sorts CC extension dirs by version.
//   - patch.ts: writeCompanionConfig flow (extractCmpVerStrBody reads this
//     file at install time and bakes the body into companion-config.json's
//     semverComparatorSrc field — see ARCH-3 / test-version-sync.mjs).
//
// ARCH-3 mirror-elimination (v0.2.5 round-2, final form in v0.2.8 round-2):
// through v0.2.4 the companion had a byte-for-byte mirror `cmpVerStr`
// function in companion/extension.ts. ARCH-3 eliminated the mirror by
// having patch.ts:extractCmpVerStrBody regex-extract the body from this
// file and bake it into companion-config.json; the companion then reads
// that field at activate() and `new Function('a','b', src)`-caches it on
// globalThis. The companion compiles standalone into a .vsix so it cannot
// `import` this module at runtime — the config-baked body is the runtime
// channel that keeps the canonical source flowing without a static mirror.
// extractCmpVerStrBody tries `dist/src/semver.js` (shipped in the npm
// tarball) first and falls back to this `src/semver.ts` (dev tsx mode); the
// two have byte-identical function bodies because tsc only strips type
// annotations. A future 4-segment or pre-release-tag change touches ONE
// function (this one); test-version-sync.mjs §Q asserts the config-baked
// body agrees with this source on a fixed test corpus, and test-contract-
// sync.mjs pins the IIFE-baked .tokens.json literal that the snapshot
// fallback reads.
/** Compare two `X.Y.Z` (or `X.Y`, or any segment count) version strings.
 *  Returns >0 if a>b, <0 if a<b, 0 if equal. Numeric per-segment comparison
 *  (not lexical). Missing segments on either side are treated as 0.
 *
 *  Canonical helper for ALL semver comparisons in the patcher + the companion
 *  (the companion reads this body from companion-config.json's
 *  semverComparatorSrc field at activate() — written by patch.ts:
 *  writeCompanionConfig via extractCmpVerStrBody — and `new Function`
 *  compiles it; keep this body self-contained, no closure captures).
 *  A future 4-segment or pre-release-tag change touches ONE function (this
 *  one) + the companion's whitelist (see getCmpVerStr's safe-tokens gate).
 *
 *  v0.2.4 follow-up: consolidated the prior cmpSemver/cmpVer/cmpVerStr trio
 *  (string-comparator + number[]-alias + thin-wrapper) into a single
 *  canonical name `cmpVerStr` that matches the companion's mirror symbol. */
export function cmpVerStr(a, b) {
    const pa = a.split(".").map((x) => Number(x) || 0);
    const pb = b.split(".").map((x) => Number(x) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const ai = pa[i] ?? 0;
        const bi = pb[i] ?? 0;
        if (ai !== bi)
            return ai - bi;
    }
    return 0;
}
