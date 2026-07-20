// src/semver.ts — canonical semantic-version comparator.
//
// Extracted from patch.ts in the v0.2.5 round-2 architecture-debt slice
// (ARCH-1 first slice). Pure function — no I/O, no closure dependencies.
// Used by:
//   - patch.ts: discoverExtension sorts CC extension dirs by version.
//   - patch.ts: writeCompanionConfig flow (the comparator body is mirrored
//     by the companion; see ARCH-3 / test-version-sync.mjs).
//
// MIRROR NOTE: companion/extension.ts:cmpVerStr is a byte-for-byte mirror
// of this body. The companion compiles standalone into a .vsix so it cannot
// import this module at runtime — the price of distribution isolation is a
// mirror copy. A future 4-segment or pre-release-tag change touches BOTH
// sides; see hooks/test-version-sync.mjs for the CI assertion that the two
// implementations agree on a fixed test corpus.

/** Compare two `X.Y.Z` (or `X.Y`, or any segment count) version strings.
 *  Returns >0 if a>b, <0 if a<b, 0 if equal. Numeric per-segment comparison
 *  (not lexical). Missing segments on either side are treated as 0.
 *
 *  Canonical helper for ALL semver comparisons in the patcher + the companion
 *  (companion/extension.ts has its own cmpVerStr that MIRRORS this body —
 *  keep them in lockstep; the companion compiles standalone into a .vsix so
 *  it cannot import from here at runtime). A future 4-segment or
 *  pre-release-tag change touches ONE function (this one) + the mirror.
 *
 *  v0.2.4 follow-up: consolidated the prior cmpSemver/cmpVer/cmpVerStr trio
 *  (string-comparator + number[]-alias + thin-wrapper) into a single
 *  canonical name `cmpVerStr` that matches the companion's mirror symbol. */
export function cmpVerStr(a: string, b: string): number {
    const pa = a.split(".").map((x) => Number(x) || 0);
    const pb = b.split(".").map((x) => Number(x) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const ai = pa[i] ?? 0;
        const bi = pb[i] ?? 0;
        if (ai !== bi) return ai - bi;
    }
    return 0;
}
