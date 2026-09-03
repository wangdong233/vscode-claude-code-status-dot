// src/jsonc.ts — JSONC (JSON with comments + trailing commas) scanner.
//
// Extracted from patch.ts in the v0.2.5 round-2 architecture-debt slice
// (ARCH-1 first slice). All functions are pure (no I/O, no closure
// dependencies). Used by:
//   - patch.ts: parseJsonc (settings.json read path) + surgical-json.ts
//     helpers (skipWsAndComments is the canonical comment-skip helper
//     shared by every site that walks JSONC bytes).
//   - hooks/test-patcher-io.mjs indirectly via the patch.ts --self-test-io
//     fixture corpus, which exercises these helpers end-to-end.
//
// Centralizing the JSONC discipline in one module means a future tweak
// (e.g. supporting `#` line comments) lands in one file instead of seven
// (the e2e code-style review that motivated this extraction flagged the
// prior triplication as a DRY violation).
/** Skip whitespace + JSONC comments (both `// line` and `/* block *​/`)
 *  starting at offset `i` in `raw`. Returns the index of the next
 *  significant (non-ws, non-comment) character, or `raw.length` if the rest
 *  of the string is all ws/comments.
 *
 *  Centralized helper for the 7+ sites that previously inlined this same
 *  scan (stripJsonc / scanJsonValueEnd / findTopLevelKey / surgicalSet… /
 *  surgicalRemove…) — the e2e code-style review flagged the triplication as
 *  a DRY violation that amplified any tweak (e.g. supporting `#` line
 *  comments) into a 7-site edit. Returns the new offset; callers MUST NOT
 *  assume the returned char is a value boundary (it could be `}`, `]`, `,`,
 *  or any structural char).
 *
 *  Does NOT track `inString` — callers that need string-aware scanning
 *  (stripJsonc's main loop) keep their own inString state and call this
 *  only at known syntax-level positions (e.g. right after a `,`). */
export function skipWsAndComments(raw, i) {
    while (i < raw.length) {
        const c = raw[i];
        const next = raw[i + 1];
        if (/\s/.test(c)) {
            i += 1;
            continue;
        }
        if (c === "/" && next === "/") {
            while (i < raw.length && raw[i] !== "\n")
                i += 1;
            continue;
        }
        if (c === "/" && next === "*") {
            i += 2;
            while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/"))
                i += 1;
            i += 2;
            continue;
        }
        break;
    }
    return i;
}
/** Strip JSONC comments (both // line and /* block *​/) and tolerate trailing
 *  commas (drop them before `}` or `]`). Returns a string that's safe to
 *  JSON.parse. Single-pass scanner that tracks `inString` so a `,}` or `,]`
 *  sequence INSIDE A STRING (e.g. a regex char class `[,}]` or a JSON
 *  one-liner arg) is NEVER mistaken for JSON syntax. The trailing-comma
 *  tolerance is done INLINE (not as a post-pass regex) precisely because a
 *  post-pass regex was a silent-corruption bug: it operated on the full
 *  flattened output, blind to string boundaries, so any user settings.json
 *  string holding `,}` or `,]` had its comma dropped at parse time and was
 *  then persisted back to disk via both the surgical-splice and round-trip
 *  write paths. */
export function stripJsonc(text) {
    let out = "";
    let i = 0;
    let inString = false;
    let quote = "";
    while (i < text.length) {
        const c = text[i];
        const next = text[i + 1];
        if (inString) {
            out += c;
            if (c === "\\") {
                // Keep escaped char verbatim.
                out += next ?? "";
                i += 2;
                continue;
            }
            if (c === quote)
                inString = false;
            i += 1;
            continue;
        }
        if (c === '"' || c === "'") {
            inString = true;
            quote = c;
            out += c;
            i += 1;
            continue;
        }
        if (c === "/" && next === "/") {
            while (i < text.length && text[i] !== "\n")
                i += 1;
            continue;
        }
        if (c === "/" && next === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/"))
                i += 1;
            i += 2;
            continue;
        }
        // Trailing-comma tolerance (string-aware): when we see a comma at the
        // syntax level (not inString), peek ahead past ws + comments; if the
        // next significant char closes a `}` or `]`, drop the comma. Uses
        // the canonical skipWsAndComments helper so any future tweak to the
        // comment-skip discipline (e.g. supporting `#` line comments) lands
        // in one place instead of seven.
        if (c === ",") {
            const j = skipWsAndComments(text, i + 1);
            if (text[j] === "}" || text[j] === "]") {
                i += 1; // drop the comma — it's trailing.
                continue;
            }
        }
        out += c;
        i += 1;
    }
    return out;
}
/** Scan one JSON value starting at offset `start` in `raw`. Returns the
 *  offset JUST PAST the value's last character (so raw.slice(start, end) is
 *  the value including its delimiters). Handles objects, arrays, strings,
 *  numbers, true, false, null, and skips // and /* *​/ comments inside
 *  composite values. */
export function scanJsonValueEnd(raw, start) {
    // Skip leading whitespace + comments (canonical helper — DRY across the
    // 7+ sites that previously inlined this scan).
    const valueStart = skipWsAndComments(raw, start);
    let i = valueStart;
    if (i >= raw.length)
        return i;
    const opener = raw[i];
    // Composite value: { ... } or [ ... ] — walk depth, skip strings + comments.
    if (opener === "{" || opener === "[") {
        let depth = 0;
        let inString = false;
        let quote = "";
        while (i < raw.length) {
            const c = raw[i];
            const next = raw[i + 1];
            if (inString) {
                if (c === "\\") {
                    i += 2;
                    continue;
                }
                if (c === quote)
                    inString = false;
                i += 1;
                continue;
            }
            if (c === "/" && next === "/") {
                while (i < raw.length && raw[i] !== "\n")
                    i += 1;
                continue;
            }
            if (c === "/" && next === "*") {
                i += 2;
                while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/"))
                    i += 1;
                i += 2;
                continue;
            }
            if (c === '"' || c === "'") {
                inString = true;
                quote = c;
                i += 1;
                continue;
            }
            if (c === "{" || c === "[")
                depth += 1;
            else if (c === "}" || c === "]") {
                depth -= 1;
                if (depth === 0) {
                    i += 1;
                    break;
                }
            }
            i += 1;
        }
        return i;
    }
    // String value.
    if (opener === '"' || opener === "'") {
        const quote = opener;
        i += 1;
        while (i < raw.length) {
            if (raw[i] === "\\") {
                i += 2;
                continue;
            }
            if (raw[i] === quote) {
                i += 1;
                break;
            }
            i += 1;
        }
        return i;
    }
    // Primitive (number / true / false / null) — walk until a top-level
    // separator or newline ends the token.
    while (i < raw.length && !/[,\]\}]/.test(raw[i]))
        i += 1;
    return i;
}
