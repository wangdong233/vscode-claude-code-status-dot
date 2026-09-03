// src/surgical-json.ts — top-level-key surgical JSONC editor.
//
// Extracted from patch.ts in the v0.2.5 round-2 architecture-debt slice
// (ARCH-1 first slice). All functions are pure (no I/O, no closure
// dependencies). Used by:
//   - patch.ts: wireHooks / unwireHooks (settings.json "hooks" key splice
//     preserves user // comments and surrounding layout byte-for-byte,
//     replacing the prior parse-mutate-stringify round-trip that dropped
//     comments and reformatted).
//
// The pre-fix wireHooks/unwireHooks round-trip DROPPED user // and /* */
// comments and reformatted the entire file. Users who keep notes / section
// headers in settings.json lost them on every install + every re-wire
// triggered by a hook-command change. These helpers locate the byte range
// of ONE top-level key's value and let us splice just that range, leaving
// the rest of the file byte-for-byte identical.
//
// Limitations (acceptable for our use case):
//   - Only finds keys at the TOP LEVEL of the root object (settings.json's
//     "hooks" key lives at top level, so this is fine).
//   - The REPLACED value loses any comments that were INSIDE it (e.g. inside
//     the hooks object). Comments ELSEWHERE in the file are preserved
//     verbatim. The user almost never comments inside "hooks"; the common
//     case (top-level // notes, section headers) is fully preserved.
//   - Single-quoted strings (tolerated by stripJsonc) at top level are also
//     tolerated by the scanner.
import { skipWsAndComments, scanJsonValueEnd } from "./jsonc.js";
/**
 * Find the byte range of a top-level key's value in a JSONC object literal.
 * Returns `{ keyStart, keyEnd, colon, valueStart, valueEnd }` describing the
 * key token, the colon after it, and the value byte range — or `null` if the
 * key is absent or the root is not an object literal.
 *
 * `valueStart` is the offset of the first non-whitespace, non-comment char of
 * the value; `valueEnd` is just past the value's last char (so
 * `raw.slice(valueStart, valueEnd)` is the value text including delimiters).
 */
export function findTopLevelKey(raw, key) {
    let i = 0;
    let inString = false;
    let quote = "";
    let depth = 0;
    // Find the opening brace of the root object.
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
        if (c === "{") {
            depth = 1;
            i += 1;
            break;
        }
        // Skip leading whitespace / BOM / etc before the root brace.
        i += 1;
    }
    if (depth !== 1)
        return null; // no root object
    // Walk the top-level object's members.
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
        if (/\s/.test(c)) {
            i += 1;
            continue;
        }
        if (c === "}") {
            // End of root object.
            return null;
        }
        if (c === '"' || c === "'") {
            // Member key.
            const keyStart = i;
            quote = c;
            inString = true;
            i += 1;
            let keyValue = "";
            while (i < raw.length) {
                if (raw[i] === "\\") {
                    keyValue += raw[i] + (raw[i + 1] ?? "");
                    i += 2;
                    continue;
                }
                if (raw[i] === quote) {
                    inString = false;
                    i += 1;
                    break;
                }
                keyValue += raw[i];
                i += 1;
            }
            const keyEnd = i;
            // Find the colon, allowing ws + JSONC comments between key and
            // colon (uncommon but valid JSONC). Uses the canonical
            // skipWsAndComments helper so the comment-skip discipline is
            // shared with stripJsonc / scanJsonValueEnd.
            i = skipWsAndComments(raw, i);
            if (raw[i] !== ":") {
                // Malformed — bail.
                return null;
            }
            const colon = i;
            i += 1;
            const valueEnd = scanJsonValueEnd(raw, i);
            // scanJsonValueEnd returns offset past leading whitespace+comments
            // too — recompute valueStart as the first non-ws/non-comment char
            // via the canonical helper.
            const vStart = skipWsAndComments(raw, i);
            if (keyValue === key) {
                return { keyStart, keyEnd, colon, valueStart: vStart, valueEnd };
            }
            i = valueEnd;
            // Skip the trailing comma if present (and any comments / ws around it).
            i = skipWsAndComments(raw, i);
            if (raw[i] === ",")
                i += 1;
            continue;
        }
        // Unexpected token at top level — bail.
        i += 1;
    }
    return null;
}
/**
 * Splice a top-level key's value in a JSONC object literal, preserving the
 * rest of the file byte-for-byte. If the key is absent, inserts a new
 * `"key": <valueJson>` member after the opening brace (with 2-space indent
 * matching the conventional settings.json style). Returns the new raw text.
 *
 * For our use case (settings.json "hooks" key), the value is always a JSON
 * object we computed ourselves, so it contains no comments to preserve. The
 * surrounding file (other top-level keys + their comments) is untouched.
 */
export function surgicalSetTopLevelKey(raw, key, valueJson) {
    const range = findTopLevelKey(raw, key);
    if (range) {
        // Replace just the value byte range.
        return raw.slice(0, range.valueStart) + valueJson + raw.slice(range.valueEnd);
    }
    // Key absent — insert after the opening brace of the root object.
    // Find the opening brace, skipping leading comments / whitespace / BOM
    // via the canonical helper. (The prior hand-rolled loop tracked
    // inString against the pathological "string before root brace" case,
    // which is invalid JSONC anyway — skipWsAndComments covers every
    // real-world prefix: BOM, whitespace, // line notes, /* file headers */.)
    const braceIdx = skipWsAndComments(raw, 0);
    if (raw[braceIdx] !== "{") {
        // Root is not an object (could be `[`, end-of-input, or any other
        // unexpected token) — can't safely splice. Return raw unchanged so
        // the caller falls through to its non-surgical handling.
        return raw;
    }
    // Heuristic indentation: 2 spaces (matches the JSON.stringify(obj, null, 2)
    // style the prior code wrote). If the existing file uses a different indent,
    // the inserted block still parses correctly (JSON is whitespace-agnostic).
    const member = `\n  ${JSON.stringify(key)}: ${valueJson},`;
    // Insert immediately AFTER the opening brace. If there's already content on
    // the same line, the leading \n moves our entry to its own line.
    return raw.slice(0, braceIdx + 1) + member + raw.slice(braceIdx + 1);
}
/**
 * Remove a top-level key (and its trailing comma) from a JSONC object literal,
 * preserving the rest of the file byte-for-byte. Returns the new raw text, or
 * the original text if the key is absent. Handles the trailing-comma-after-
 * last-member edge case so the result is still valid JSONC.
 */
export function surgicalRemoveTopLevelKey(raw, key) {
    const range = findTopLevelKey(raw, key);
    if (!range)
        return raw;
    // We need to remove the key token + colon + value + trailing comma (if any).
    // Start from keyStart; end at valueEnd, then consume any trailing comma
    // (skipping ws + comments via the canonical helper).
    const end = skipWsAndComments(raw, range.valueEnd);
    let consume = end;
    if (raw[consume] === ",")
        consume += 1;
    // Also trim trailing whitespace on the value's line so we don't leave a
    // dangling blank line. Walk start backward to include the key's leading
    // newline (if present) so we don't leave a blank line above either.
    let start = range.keyStart;
    // Walk backward over whitespace but stop at a newline boundary so we eat
    // the indentation + the preceding newline (cleaner result).
    while (start > 0 && /[ \t]/.test(raw[start - 1]))
        start -= 1;
    if (start > 0 && raw[start - 1] === "\n")
        start -= 1;
    return raw.slice(0, start) + raw.slice(consume);
}
