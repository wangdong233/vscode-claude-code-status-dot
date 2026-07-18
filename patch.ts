#!/usr/bin/env node
/**
 * patch.ts — Claude Code tab status-dot patcher
 * ---------------------------------------------------------------------------
 * Patches the installed Claude Code VS Code extension so each session's tab icon
 * reflects per-session state (idle / running / done / interrupted) read from
 * `~/.claude/cc-tab-status/<session_id>.json`, which is written by the hook at
 * `hooks/cc-status.js`. The interrupted fast-flash animation is driven by a
 * self-injected 500 ms redraw timer (running/idle/done are static), because CC
 * itself only redraws the icon on sparse rename_tab events (see DESIGN §2).
 *
 * STATE CONTRACT: the four states, their events, colors and SVGs are defined
 * once in docs/STATES.md (single source of truth). This file, cc-status.js,
 * the SVG filenames and the docs must all stay in sync with it.
 *
 * RUN
 *   npx vscode-claude-code-status-dot            # install (published bin → dist/patch.js)
 *   tsx patch.ts                          # install from source (dev)
 *   tsx patch.ts --revert                 # undo everything (also: published bin --revert)
 *   tsx patch.ts --status                 # dry-run report, no changes
 *   tsx patch.ts --help
 *   # also works: bun run patch.ts  /  npx tsx patch.ts
 *
 * INJECTION STRATEGY (see docs/DESIGN-injection.md for full rationale)
 *   CC's minified extension.js redraws the panel tab icon in ONE place: the
 *   `rename_tab` handler, which only knows hasPendingPermissions /
 *   hasUnseenCompletion and carries NO sessionId. To bridge session→panel we
 *   patch the sibling `update_session_state` handler (same `ts` instance, and
 *   its request DOES carry sessionId) to stash `this.__ccSid` and start a
 *   500 ms setInterval that reads the external state file and asserts the
 *   icon. A second no-op-guarded copy of the starter is placed in the
 *   rename_tab handler to eliminate the ~500 ms flash after CC re-asserts its
 *   own icon (DESIGN §4.2, optional hardening).
 *
 *   The injected code references ZERO minified identifiers (no `ue`/`dn`/`r`);
 *   it only uses `require("fs"|"path"|"vscode"|"os")`, `this`, and `Date`. The
 *   only version-sensitive surface is therefore the two anchor strings below,
 *   which are asserted to match exactly once before any byte is written.
 *
 * SVG WIRING (DESIGN §5 — absolute path to a PERSISTENT copy, not the project)
 *   Our SVGs (claude-logo-idle.svg + claude-logo-running.svg + claude-logo-done.svg
 *   + claude-logo-error.svg = 4 files, ALL STATIC) are COPIED from this project's
 *   resources/ into INSTALL_DIR (~/.claude/cc-status-dot/resources/) at install
 *   time, and the injected IIFE references that absolute path — so it survives
 *   BOTH a CC auto-update (which wipes the extension dir) AND deletion of the
 *   source project / npx cache purge. Just re-run the patcher after a CC update.
 *   The interrupted "off-frame" reuses CC's own claude-logo.svg via
 *   this.context.extensionPath.
 *
 * LIMITATIONS (read before extending)
 *   - If the CC extension updates and the minified anchor strings drift, the
 *     patcher will refuse to write and ask the user to file an issue. It never
 *     partially mutates extension.js.
 *   - settings.json is round-tripped through JSON.parse/stringify, which drops
 *     comments. The original is preserved as settings.json.cc-status-dot.bak
 *     on first run. Revert does surgical marker-based removal (not a restore),
 *     so subsequent manual edits survive.
 *   - Each CC panel instance runs its own 500 ms timer (N tabs = N timers).
 *     Each tick is one tiny readFileSync; acceptable for normal use.
 * ------------------------------------------------------------------------- */

import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directory this script FILE lives in.
 *  Works under `tsx` (patch.ts at project root) and compiled ESM
 *  (dist/patch.js in the published package): this package is always ESM
 *  (package.json "type":"module" + tsconfig NodeNext), so import.meta.url is
 *  always available and is the reliable locator (under ESM __dirname is unset). */
const SCRIPT_DIR: string = (() => {
    try {
        const url = (import.meta as { url?: string }).url;
        if (url) return path.dirname(fileURLToPath(url));
    } catch {
        /* import.meta unavailable — extremely unlikely under our ESM setup */
    }
    // Last-resort fallback (only if import.meta.url ever surprises us).
    return path.dirname(path.resolve(process.argv[1] ?? process.cwd()));
})();

/** Project root = the directory holding the SOURCE `resources/` and `hooks/` we
 *  copy FROM at install time.
 *  - Dev (`npx tsx patch.ts`): SCRIPT_DIR is the project root → resources/ and
 *    hooks/ sit right beside patch.ts.
 *  - Compiled (`node dist/patch.js`): SCRIPT_DIR is dist/; the published package
 *    ships resources/ and hooks/ one level up, so resolve to the parent.
 *  Auto-detect by checking which candidate actually holds BOTH dirs. */
const PROJECT_ROOT: string = (() => {
    for (const c of [SCRIPT_DIR, path.dirname(SCRIPT_DIR)]) {
        if (fs.existsSync(path.join(c, "resources")) && fs.existsSync(path.join(c, "hooks"))) {
            return c;
        }
    }
    return SCRIPT_DIR;
})();

/** Substring baked into the injected JS block. Presence in extension.js === "already patched".
 *  MUST be a block comment (/* *​/) — a // line comment would comment out the rest of the
 *  minified single line and brick the extension.
 *
 *  The banner also carries INJECT_VERSION after a colon
 *  (`cc-status-dot-injected:<INJECT_VERSION>`). The bare marker (no version
 *  suffix) is what `isExtensionPatched` greps for (so injections from any
 *  version still match). `injectedVersion` parses the version suffix to
 *  detect an IIFE whose *logic* is stale even though the marker is present —
 *  see patchExtension. */
const INJECT_MARKER = "cc-status-dot-injected";

/** Version stamped into the injected IIFE banner comment. Bump this whenever the IIFE
 *  *logic* changes (NOT just the baked RES path). On install, if the marker is present
 *  but the stamped version differs, patchExtension restores extension.js from .bak and
 *  re-injects the current IIFE — otherwise structural IIFE changes (e.g. v0.1.4 reverting
 *  to static running, or v0.1.3 removing the aggregate bar) would be silently swallowed
 *  because the bare marker still matches.
 *
 *  v0.1.11 SBI aggregation refactor: per-panel-tick aggregation lifted into a window-
 *  scoped singleton timer (globalThis.__ccsdSbiTimer, aligned with the singleton
 *  StatusBarItem scope); aggregation now applies the §4 done>5min→idle rule and a
 *  §7.2 stale-running (>30min mtime)→idle heuristic so per-tab dots and the SBI show
 *  consistent counts; globalThis key is __ccsdSbi (project-scoped __ccsd*
 *  prefix keeps CC's __cc* namespace clean — see the `cc-status-bar-injected`
 *  tombstone in restoreWebview()); panel counter (__ccsdPanelCount) hides the SBI + clears the singleton timer when
 *  the last CC panel closes so the bar cannot freeze on a stale count;
 *  SBI tooltip now appends idle count when ag.idle>0; SBI block split into multiple
 *  array elements matching the surrounding "one-logical-step-per-element" style.
 *
 *  v0.1.12 round-3 review fixes: the SBI singleton creation (`vs.window.createStatusBarItem`)
 *  and the SBI singleton timer creation (`setInterval`) are each wrapped in their OWN
 *  try/catch — matching the per-tab tick's existing isolation pattern. Previously a
 *  transient VSCode API failure (disposed extension host, createStatusBarItem throw)
 *  would propagate up through the comma-operator chain into CC's `update_session_state`
 *  handler, bricking session-state tracking AND skipping the per-tab setInterval AND
 *  the onDidDispose registration (so the panel counter bumped at IIFE entry would
 *  never decrement — a permanent leak). Now: SBI failure degrades gracefully (no
 *  aggregation bar, but per-tab dots + notify + permission yield still work). Also
 *  fixed: §7.5→§7.2 attribution on the stale-running comment (the rule is DEFINED in
 *  §7.2; §7.5 only references it). */
const INJECT_VERSION = "v0.1.12";

/** Substring appended (as a shell comment) to every hook command we own in settings.json.
 *  Used for idempotent dedupe on install and surgical removal on --revert. */
const HOOK_MARKER = "cc-status-dot-managed";

/** Redraw cadence (ms). 500 drives:
 *   - the interrupted on/off flash (flashSeq%2 → ~500 ms on, ~500 ms off — an
 *     alert-grade fast flash),
 *   - the done→idle 5-min fallback poll, and
 *   - the terminal-`since` dedup that fires done/interrupted notifications.
 *   running/idle/done are STATIC (no animation) — iconPath frame-switching is
 *   inherently discrete and reads as flicker, so v0.1.4 reverted running to a
 *   steady yellow dot. The timer still ticks at 500 ms because interrupted
 *   needs it and the static states are a cheap no-op read. One tiny
 *   readFileSync per tick. */
const TICK_MS = 500;

/** Per-session state directory read by the injected timer. */
const STATE_DIR = path.join(os.homedir(), ".claude", "cc-tab-status");

/** Persistent runtime install dir. A copy of resources/*.svg + hooks/cc-status.js
 *  lives here so the patched extension and the CC hook keep working even if the
 *  source project dir is removed or the npx cache is purged. The injected IIFE
 *  references INSTALL_DIR/resources (baked in at patch time), and the wired hook
 *  command points at INSTALL_DIR/hooks/cc-status.js.
 *
 *  Distinct from STATE_DIR (~/.claude/cc-tab-status/) which is per-session USER
 *  DATA and is NOT touched by install / --revert. */
const INSTALL_DIR = path.join(os.homedir(), ".claude", "cc-status-dot");

/** Runtime resources dir — the absolute path baked into the injected IIFE.
 *  A const (not a fn) because INSTALL_DIR is itself a const: the path is fixed
 *  once the patcher starts and never varies between call sites. Keeps it in
 *  line with the sibling UPPER_SNAKE path consts. */
const RUNTIME_RES_DIR = path.join(INSTALL_DIR, "resources");

/** All SVGs the IIFE can reference + installRuntimeFiles copies + cleanup
 *  keeps. Since v0.1.4 running is again a **single static yellow dot**
 *  (`claude-logo-running.svg`, fill #CCA700) — the v0.1.3 8-frame breathing
 *  experiment read as discrete flicker because iconPath frame-switching is
 *  inherently jumpy, not smooth. idle/running/done/error are now all static;
 *  only interrupted animates (flashSeq%2 on/off fast-flash between error.svg and
 *  CC's default). installRuntimeFiles auto-sweeps the stale v0.1.3
 *  `claude-logo-running-{0..7}.svg` frames on upgrade. */
const OUR_SVGS = ["claude-logo-idle.svg", "claude-logo-running.svg", "claude-logo-done.svg", "claude-logo-error.svg"];

/** Extension directories to search, highest version wins. */
const SEARCH_DIRS = [
    path.join(os.homedir(), ".vscode", "extensions"),
    path.join(os.homedir(), ".vscode-insiders", "extensions"),
    path.join(os.homedir(), ".vscode-server", "extensions"), // remote/SSH scenarios
    path.join(os.homedir(), ".cursor", "extensions"),
    path.join(os.homedir(), ".vscodium", "extensions"),
];

/** CC hook events that feed session-state transitions to cc-status.js.
 *  MUST equal the event set handled by hooks/cc-status.js (docs/STATES.md §2).
 *  SubagentStart / SubagentStop feed the activeSubagents early-signal counter
 *  (and also carry background_tasks for authoritative correction) so the dot
 *  stays yellow while a workflow / background subagent runs; see
 *  docs/SUBAGENT-design.md §4–§5. Intentionally excludes Notification (CC's
 *  native blue dot handles permission, reader does not override that state) and
 *  SessionStart (no writer case — wiring it would be dead wiring, audit F-5). */
const HOOK_EVENTS = [
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "StopFailure",
    "SessionEnd",
] as const;

// --- Anchor strings (verified byte-exact against CC 2.1.204) ---------------

/**
 * Anchor A — the `update_session_state` handler. Same `ts` (per-panel) instance
 * as rename_tab, and its request carries sessionId. We wrap its body in a block
 * to (1) stash this.__ccSid and (2) start the redraw timer before the original
 * return. Exact, must match ONCE.
 */
const ANCHOR_A =
    'else if(e.request.type==="update_session_state")return this.onSessionStateChanged?.(e.request.sessionId,e.request.state,e.request.title),{type:"update_session_state_response"}';

/**
 * Anchor B — inside the `rename_tab` handler, just after the title is set and
 * before CC chooses its own icon. We insert the same guarded starter here so
 * the timer begins on the very first rename_tab (which can precede the first
 * update_session_state) and so CC's icon assignment is re-asserted within one
 * tick. Exact, must match ONCE.
 *
 * The injected replB stashes TWO live flags on every rename_tab fire:
 *   - this.__ccTitle = e.request.title    — keeps the cached panel title fresh
 *     so notify()'s "["+__ccTitle+"]" suffix matches the CURRENT tab title
 *     even after CC fires rename_tab multiple times post-update_session_state
 *     (truncation, user rename). Without this the title would freeze at the
 *     last update_session_state value.
 *   - this.__ccPending = !!e.request.hasPendingPermissions — the same flag CC
 *     uses to paint its native blue pending dot. The IIFE's tick reads this
 *     live and yields when set, so the reader stops overriding CC's blue dot
 *     during a permission prompt (the PreToolUse heartbeat leaves state=running
 *     on disk, which previously caused the yellow running dot to cover the
 *     blue pending dot).
 */
const ANCHOR_B = "this.panelTab.title=e.request.title;let r;if(e.request.hasPendingPermissions)";

// ---------------------------------------------------------------------------
// Logging — plain text, no emojis (kept terminal-friendly & greppable)
// ---------------------------------------------------------------------------

function log(msg: string): void {
    console.log(`[cc-status-dot] ${msg}`);
}
function warn(msg: string): void {
    console.warn(`[cc-status-dot][WARN] ${msg}`);
}
function fail(msg: string): never {
    // Tag anchor problems so the top-level handler can append a version hint.
    if (/anchor/i.test(msg)) throw new Error(`Anchor mismatch: ${msg}`);
    throw new Error(msg);
}

// ---------------------------------------------------------------------------
// JSONC: settings.json may contain // and /* */ comments + trailing commas.
// Strip them with a tiny scanner that respects string literals, then JSON.parse.
// ---------------------------------------------------------------------------

function stripJsonc(text: string): string {
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
            if (c === quote) inString = false;
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
            while (i < text.length && text[i] !== "\n") i += 1;
            continue;
        }
        if (c === "/" && next === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
            i += 2;
            continue;
        }
        out += c;
        i += 1;
    }
    // Tolerate trailing commas before } or ].
    return out.replace(/,(\s*[}\]])/g, "$1");
}

function parseJsonc(text: string, sourceLabel: string): Record<string, unknown> {
    try {
        return JSON.parse(stripJsonc(text));
    } catch (e) {
        fail(
            `Could not parse ${sourceLabel} as JSON/JSONC (${(e as Error).message}). ` +
                `Fix it manually, then re-run. No files were changed.`,
        );
    }
}

// ---------------------------------------------------------------------------
// Extension discovery — find the highest-version anthropic.claude-code-* dir
// ---------------------------------------------------------------------------

function cmpVer(a: number[], b: number[]): number {
    // Compare semver-style numeric arrays component-wise, treating a missing
    // component as 0 (so [1,2] === [1,2,0]). Robust to future 4-segment
    // version schemes without a magic count; coupled to but not hard-tied to
    // the 3-capture regex in discoverExtension.
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const ai = a[i] ?? 0;
        const bi = b[i] ?? 0;
        if (ai !== bi) return ai - bi;
    }
    return 0;
}

interface DiscoveredExt {
    dir: string;
    version: string;
}

function discoverExtension(): DiscoveredExt {
    const candidates: { dir: string; version: number[] }[] = [];
    for (const base of SEARCH_DIRS) {
        let entries: string[];
        try {
            entries = fs.readdirSync(base);
        } catch {
            continue; // dir absent or unreadable
        }
        for (const name of entries) {
            // Dir name shape: anthropic.claude-code-<X.Y.Z>-<platform>
            // (publisher "anthropic" + "." + extension "claude-code" + "-<version>"...)
            // Note the hyphen between "claude" and "code" — not a dot.
            const m = name.match(/^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/);
            if (!m) continue;
            const dir = path.join(base, name);
            if (!fs.existsSync(path.join(dir, "extension.js"))) continue;
            candidates.push({ dir, version: [Number(m[1]), Number(m[2]), Number(m[3])] });
        }
    }
    if (candidates.length === 0) {
        fail(
            `No anthropic.claude-code-* (with extension.js) found under:\n` +
                SEARCH_DIRS.map((d) => "  " + d).join("\n") +
                `\nIs the Claude Code extension installed?`,
        );
    }
    candidates.sort((a, b) => cmpVer(b.version, a.version));
    const top = candidates[0];
    if (candidates.length > 1) {
        log(`Multiple CC extensions found; using highest version ${top.version.join(".")} at ${top.dir}`);
        // Surface every other detected install so users with simultaneous
        // stable + insiders (or .cursor / .vscodium) installs can see why
        // the other CC tab isn't getting a status dot. Re-running install
        // after the lower-version one updates will pick the new top.
        for (let i = 1; i < candidates.length; i++) {
            log(
                `  skipping lower version ${candidates[i].version.join(".")} at ${candidates[i].dir} (only one CC install is patched per run)`,
            );
        }
    }
    return { dir: top.dir, version: top.version.join(".") };
}

// ---------------------------------------------------------------------------
// Backup helper — copy once, never overwrite an existing .bak (keep original)
// ---------------------------------------------------------------------------

function backupOnce(srcPath: string, bakPath: string): boolean {
    if (fs.existsSync(bakPath)) {
        log(`backup already exists: ${path.basename(bakPath)}`);
        return false;
    }
    // Nothing to back up if the source doesn't exist yet (e.g. first-created
    // settings.json). In that case there's no original to preserve.
    if (!fs.existsSync(srcPath)) return false;
    fs.copyFileSync(srcPath, bakPath);
    log(`backed up → ${path.basename(bakPath)}`);
    return true;
}

function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let n = 0;
    let i = 0;
    while ((i = haystack.indexOf(needle, i)) !== -1) {
        n += 1;
        i += needle.length;
    }
    return n;
}

// ---------------------------------------------------------------------------
// Syntax gate — refuse to write a malformed extension.js. Validates the FINAL
// spliced bytes the way Node/VSCode actually load CC's bundle (`node --check`),
// so a typo in buildIIFE's template-literal array — e.g. a missing `}` that
// turns the whole 2.6 MB bundle into a SyntaxError and bricks the CC extension
// (its commands, incl. claude-vscode.editor.openLast, vanish and new sessions
// refuse to open) — is caught BEFORE any byte reaches disk. Catches anchor/
// replace mistakes too, since it checks the assembled `next`, not just the IIFE.
//
// `node --check` parses CJS at module top level (matching CC's loader). We do
// NOT use `new Function(code)` / `new vm.Script(code)` here: both would
// false-positive on a top-level `return`, which a bundled CJS extension may
// legitimately contain. If node can't be spawned at all (broken execPath), we
// warn and skip rather than block install on an environment issue.
// ---------------------------------------------------------------------------

function assertCompiles(code: string, label: string): void {
    const tmp = path.join(os.tmpdir(), `cc-status-dot-syntax-${process.pid}.js`);
    try {
        fs.writeFileSync(tmp, code, "utf8");
        try {
            cp.execFileSync(process.execPath, ["--check", tmp], {
                stdio: ["ignore", "pipe", "pipe"],
                encoding: "utf8",
            });
        } catch (e) {
            const err = e as { status?: number; stderr?: string; code?: string; message?: string };
            // Spawn failure (e.g. execPath unusable) — don't block install on environment.
            if (typeof err.status !== "number") {
                warn(`could not run 'node --check' to validate ${label} (${err.message}); skipping syntax gate`);
                return;
            }
            const stderr = (err.stderr || err.message || "").trim();
            fail(
                `${label} would be a SyntaxError — refusing to write (would brick the CC extension).\n` +
                    `This is a bug in the injected code, not a Claude Code update — fix buildIIFE, then re-run. No files were changed.\n` +
                    `node --check output:\n` +
                    stderr
                        .split("\n")
                        .map((l) => "    " + l)
                        .join("\n"),
            );
        }
    } finally {
        try {
            fs.unlinkSync(tmp);
        } catch {
            /* best-effort cleanup of the probe file */
        }
    }
}

// ---------------------------------------------------------------------------
// Build the injected IIFE. Single line, version-robust, no minified refs.
//   t = the `ts` panel instance (has panelTab, context.extensionPath).
//   Reads ~/.claude/cc-tab-status/<sid>.json -> {state, since, error?}
//   State machine + notification mirror docs/STATES.md §1/§4/§4b/§7 — keep in sync.
//     running     -> steady claude-logo-running.svg (static yellow #CCA700).
//                    v0.1.3 tried an 8-frame breathing animation, but iconPath
//                    frame-switching is inherently discrete and read as flicker,
//                    so v0.1.4 reverted to a single static dot (same shape as
//                    idle/done/error). The 500 ms timer still ticks but running
//                    reassigns the same path each tick (cheap no-op).
//     interrupted -> flash claude-logo-error.svg <-> CC's claude-logo.svg (off-frame)
//                    at ~500 ms on/off (flashSeq%2) — alerts stay intentionally fast.
//     done        -> steady claude-logo-done.svg; if since older than 5 min -> idle
//     idle        -> steady claude-logo-idle.svg
//     missing/unknown -> return (don't fight CC's own pending/done icon)
//     permission pending -> return (don't fight CC's native blue dot). The
//                    rename_tab handler stashes `this.__ccPending` from
//                    `e.request.hasPendingPermissions` (the same flag CC uses to
//                    paint its blue dot) on every fire; the tick yields when it
//                    is set, so CC's pending icon shows through. Fixes the bug
//                    where a PreToolUse heartbeat leaves state=running on disk
//                    during a permission prompt and the reader overrides CC's
//                    blue dot with the yellow running dot.
//   On a NEW terminal `since` (done/interrupted): notify once.
//   Config: ccStatusDot.{notify,notifyWhenFocused,notifySound}.
//   notifyWhenFocused defaults to true (foreground still notifies — "window
//   focused" ≠ "watching the CC tab"). Dedup is keyed on the terminal `since`
//   timestamp (refreshed by Stop/StopFailure; SubagentStop on an already-terminal
//   state with next=0 preserves cur.since to avoid spurious re-notify — see
//   cc-status.js SubagentStop), seeded on the first poll so a reload into a
//   stale done does not fire. This catches fast turns that finish between two
//   500 ms polls (the old prevSt transition check missed them).
//   macOS notify path: osascript system notification, with a callback that
//   falls back to vs.window.show{Information,Warning}Message if osascript
//   itself fails (permission denied / binary missing / escape bug) — so the
//   "completion/interruption notification" feature stays observable even on
//   the failure path. Non-macOS always uses VSCode messages.
//   Timer lifecycle: setInterval is captured into `timer` and cleared via
//   t.panelTab.onDidDispose so closing the CC panel releases the 500 ms tick
//   (otherwise the interval + its closed-over `t`/`panelTab` refs leak for
//   the lifetime of the VSCode window).
//
//   SBI (status-bar aggregation, v0.1.10+; see docs/STATES.md §7):
//     Window-scoped StatusBarItem at StatusBarAlignment.Right showing
//     "🟢{done} 🟡{running} 🔴{interrupted}" with 0-count segments omitted and
//     ⚪{idle} as a fallback when only idle sessions exist; hidden entirely
//     when the state directory has zero parseable *.json (so CC-less windows
//     stay clean). Sits ALONGSIDE the per-tab dot (does NOT replace it).
//   SBI singleton scope (v0.1.11 refactor):
//     BOTH the item (globalThis.__ccsdSbi) AND its refresh timer
//     (globalThis.__ccsdSbiTimer) are window-scoped singletons — the first
//     CC panel creates them, every subsequent panel's IIFE reuses them, so
//     a window with P panels ticks the aggregation ONCE per 500 ms (not P
//     times), aligning timer scope with item scope (previously every panel
//     recomputed the same aggregation; correct but O(P×S) I/O).
//   SBI reader-rule parity (v0.1.11):
//     The aggregation applies the SAME §4 reader rules as per-tab rendering
//     — done with since>5min → idle, and running with mtime>30min → idle
//     (the latter is a §7.5 heuristic for crashed/killed CC processes whose
//     SessionEnd never fires) — so the SBI count and the per-tab dots agree
//     on what "done"/"running" mean. Without this, a 2-hour-old done would
//     render as a gray idle dot on its tab but still be counted as 🟢 in
//     the SBI.
//   SBI panel-counter lifecycle (v0.1.11):
//     Each IIFE entry bumps globalThis.__ccsdPanelCount; onDidDispose
//     decrements and, when the count hits zero (last CC panel in the window
//     closed), clears the singleton timer and hides the SBI — so the bar
//     can no longer freeze on a stale count when no panel remains to
//     refresh it. Opening a fresh CC panel re-arms the timer + shows the
//     SBI again on its first tick.
//   SBI isolation:
//     The aggregation lives in its own try/catch inside the singleton timer
//     callback — a readdir/stat/parse failure can never brick the per-panel
//     tick (which has its own setInterval) nor vice-versa.
//   SBI naming:
//     globalThis.__ccsdSbi / __ccsdSbiTimer / __ccsdPanelCount use a
//     project-scoped __ccsd* prefix (mirrors INJECT_MARKER / HOOK_MARKER),
//     NOT the bare __cc* prefix — see the `cc-status-bar-injected` tombstone
//     in restoreWebview(): `__cc*` is CC's own namespace and a future CC
//     release could occupy the same globalThis key, silently disabling our guard.
//     Emoji (🟢🟡🔴⚪) are written as \u{...} escapes to keep the injected
//     source ASCII-only (matches test-iife.mjs L163-L165 note).
// ---------------------------------------------------------------------------

function buildIIFE(resDir: string): string {
    // JSON.stringify yields a safely-quoted, escaped JS string literal for the path
    // (also handles the non-ASCII chars in the project path correctly).
    const resLiteral = JSON.stringify(resDir);
    // State machine + notification + SBI aggregation mirror docs/STATES.md §1/§4/§4b/§7. Keep in sync.
    return [
        `/*${INJECT_MARKER}:${INJECT_VERSION}*/`,
        `(function(t){`,
        `if(t.__ccDotStarted||!t.panelTab)return;`,
        `t.__ccDotStarted=true;`,
        `/*SBI panel counter: bumped per IIFE entry so the onDidDispose teardown at the tail of this IIFE can detect the last panel out and tear down the singleton SBI timer + hide the item (v0.1.11).*/`,
        `globalThis.__ccsdPanelCount=(globalThis.__ccsdPanelCount||0)+1;`,
        `var fs=require("fs"),pth=require("path"),vs=require("vscode"),os=require("os");`,
        `var DIR=pth.join(os.homedir(),".claude","cc-tab-status");`,
        `var RES=${resLiteral};`,
        `var CC_DEFAULT=pth.join(t.context.extensionPath,"resources","claude-logo.svg");`,
        `var DONE_TO_IDLE_MS=5*60*1000;`,
        `/*SBI stale-running heuristic (§7.2; referenced from §7.5): a legit running session gets PreToolUse/PostToolUse heartbeats every tool call, so a state=running file whose mtime exceeds this window is almost certainly a crashed/killed CC process whose SessionEnd never fired — count it as idle, not running.*/`,
        `var SBI_RUNNING_STALE_MS=30*60*1000;`,
        `var flashSeq=0,lastTermSince=null,seeded=false;/*flashSeq: interrupted on/off frame index (flashSeq%2)*/`,
        `function notify(st,err){`,
        `var c=vs.workspace.getConfiguration("ccStatusDot");`,
        `if(!c.get("notify",true))return;`,
        `var focused=vs.window.state.focused;`,
        `if(focused&&!c.get("notifyWhenFocused",true))return;`,
        `var msg,sev;`,
        `if(st==="done"){sev="info";msg="Claude Code: turn complete"}`,
        `else{sev="warn";var m={rate_limit:"rate limit reached",overloaded:"server overloaded"}[err]||err||"interrupted";msg="Claude Code: "+m}`,
        `if(t.__ccTitle)msg+=" ["+t.__ccTitle+"]";`,
        `/*macOS: osascript system notification; on async OR sync failure fall through to VSCode message so the notification feature stays observable when osascript is denied / missing / mis-escaped.*/`,
        `if(os.platform()==="darwin"){var snd=c.get("notifySound","Glass");var sndStr=snd?(' sound name "'+snd+'"'):'';var escMsg=(""+msg).replace(/["\\\\]/g,function(c){return "\\\\"+c;});var vsMsg=function(){if(sev==="info")vs.window.showInformationMessage(msg);else vs.window.showWarningMessage(msg);};try{require("child_process").execFile("osascript",["-e",'display notification "'+escMsg+'" with title "Claude Code"'+sndStr],function(e){if(e)vsMsg()})}catch(e){vsMsg()}}`,
        `else{if(sev==="info")vs.window.showInformationMessage(msg);else vs.window.showWarningMessage(msg);}`,
        `}`,
        /* v0.1.11 SBI singleton item + singleton timer. Both window-scoped
         * (one per VSCode window, NOT per panel) — first CC panel creates them,
         * every later panel's IIFE reuses them, so a P-panel window ticks the
         * aggregation ONCE per 500ms (not P times) and writes the SAME item.
         * Project-scoped __ccsd* prefix keeps CC's __cc* namespace clean (see
         * the `cc-status-bar-injected` tombstone in restoreWebview()). Aggregation
         * applies §4 reader rules (done>5min→idle; running stale>30min→idle) so
         * per-tab dots and the SBI agree on counts.
         *
         * TWO independent try/catch wrappers (v0.1.12 round-3 fix):
         *   (1) Each SETUP step (SBI creation, SBI timer creation) is wrapped
         *       individually — a throw inside `vs.window.createStatusBarItem`
         *       (transient VSCode API failure, disposed host) is swallowed and
         *       the IIFE continues to the per-tab tick. Without this, a throw
         *       would propagate up through the comma-operator chain into CC's
         *       `update_session_state` handler (bricking session-state tracking),
         *       skip the per-tab setInterval, AND skip onDidDispose registration
         *       (so the panel counter bumped at IIFE entry would never decrement
         *       — a permanent leak).
         *   (2) The aggregation BODY inside the setInterval callback has its
         *       own try/catch so a readdir/stat/parse failure can never brick
         *       the per-panel tick (which has its own setInterval).
         * Emoji (🟢🟡🔴⚪) use \u{...} escapes to keep injected source ASCII-only. */
        `try{if(!globalThis.__ccsdSbi){globalThis.__ccsdSbi=vs.window.createStatusBarItem(vs.StatusBarAlignment.Right,0);globalThis.__ccsdSbi.name="Claude Code Sessions";}}catch(e){}`,
        `try{if(!globalThis.__ccsdSbiTimer){globalThis.__ccsdSbiTimer=setInterval(function(){`,
        `try{`,
        `var sbi=globalThis.__ccsdSbi;`,
        `var ag={running:0,done:0,interrupted:0,idle:0};`,
        `try{`,
        `var files=fs.readdirSync(DIR);`,
        `for(var i=0;i<files.length;i++){`,
        `if(!files[i].endsWith(".json"))continue;`,
        `try{`,
        `var fp=pth.join(DIR,files[i]);`,
        `var j=JSON.parse(fs.readFileSync(fp,"utf8"));`,
        `var st=j.state;var since=j.since;`,
        `/*§4 reader rule: done>5min→idle so SBI matches per-tab rendering*/`,
        `if(st==="done"&&since&&(Date.now()-since)>DONE_TO_IDLE_MS){st="idle";}`,
        `/*§7.2 stale-running heuristic: mtime>SBI_RUNNING_STALE_MS→idle (running files get tool heartbeats, so old mtime=crashed session)*/`,
        `else if(st==="running"){var mt=0;try{mt=fs.statSync(fp).mtimeMs}catch(e2){}if(mt&&(Date.now()-mt)>SBI_RUNNING_STALE_MS){st="idle";}}`,
        `if(st==="running")ag.running++;`,
        `else if(st==="done")ag.done++;`,
        `else if(st==="interrupted")ag.interrupted++;`,
        `else if(st==="idle")ag.idle++;`,
        `}catch(e){}`,
        `}`,
        `}catch(e){}`,
        `var total=ag.running+ag.done+ag.interrupted+ag.idle;`,
        `if(total===0){try{sbi.hide()}catch(e){}}`,
        `else{`,
        `var parts=[];`,
        `if(ag.done>0)parts.push("\\u{1F7E2}"+ag.done);`,
        `if(ag.running>0)parts.push("\\u{1F7E1}"+ag.running);`,
        `if(ag.interrupted>0)parts.push("\\u{1F534}"+ag.interrupted);`,
        `/*idle fallback: only when done/running/interrupted are all 0 (e.g. crashed running sessions counted as idle, or aged done files post-5-min rule)*/`,
        `if(parts.length===0)parts.push("\\u{26AA}"+ag.idle);`,
        `sbi.text=parts.join(" ");`,
        `/*tooltip lists all four states' counts, with idle appended only when nonzero so the white-circle fallback has a legend*/`,
        `sbi.tooltip="Claude Code sessions: done "+ag.done+" / running "+ag.running+" / interrupted "+ag.interrupted+(ag.idle>0?" / idle "+ag.idle:"");`,
        `try{sbi.show()}catch(e){}`,
        `}`,
        `}catch(e){}`,
        `},${TICK_MS});}}catch(e){}`,
        `var timer=setInterval(function(){`,
        `var p=t.panelTab;if(!p)return;`,
        `var sid=t.__ccSid;if(!sid)return;`,
        `var st=null,since=null,err="";`,
        `try{var j=JSON.parse(fs.readFileSync(pth.join(DIR,sid+".json"),"utf8"));st=j.state;since=j.since;err=j.error||""}catch(e){}`,
        `if(!seeded){seeded=true;if(st==="done"||st==="interrupted")lastTermSince=since}`,
        `else if((st==="done"||st==="interrupted")&&since!==lastTermSince){lastTermSince=since;try{notify(st,err)}catch(e){}}`,
        `/*permission pending: yield to CC native blue dot*/if(t.__ccPending)return;`,
        `var now=Date.now();`,
        `var svg;`,
        `if(st==="interrupted"){svg=(flashSeq%2===0)?pth.join(RES,"claude-logo-error.svg"):CC_DEFAULT}`,
        `else if(st==="running"){svg=pth.join(RES,"claude-logo-running.svg")}`,
        `else if(st==="done"){svg=(since&&(now-since>DONE_TO_IDLE_MS))?pth.join(RES,"claude-logo-idle.svg"):pth.join(RES,"claude-logo-done.svg")}`,
        `else if(st==="idle"){svg=pth.join(RES,"claude-logo-idle.svg")}`,
        `else{return}`,
        `flashSeq++;`,
        `try{p.iconPath=vs.Uri.file(svg)}catch(e){}`,
        `},${TICK_MS});`,
        `/*release this panel's 500ms tick + closed-over refs when the panel closes; also decrement the SBI panel counter, and on the LAST panel out (count→0) clear the singleton SBI timer + hide the item so the bar can't freeze on a stale count with no surviving panel to refresh it (v0.1.11).*/`,
        `try{t.panelTab.onDidDispose(function(){clearInterval(timer);globalThis.__ccsdPanelCount=(globalThis.__ccsdPanelCount||1)-1;if(globalThis.__ccsdPanelCount<=0){globalThis.__ccsdPanelCount=0;if(globalThis.__ccsdSbiTimer){clearInterval(globalThis.__ccsdSbiTimer);globalThis.__ccsdSbiTimer=null;}try{if(globalThis.__ccsdSbi)globalThis.__ccsdSbi.hide()}catch(e){}}})}catch(e){}`,
        `})(this)`,
    ].join("");
}

// ---------------------------------------------------------------------------
// Patch / restore extension.js
// ---------------------------------------------------------------------------

function isExtensionPatched(content: string): boolean {
    return content.includes(INJECT_MARKER);
}

/** Parse the version stamp from an already-patched extension.js.
 *  Returns the stamped version (e.g. "v<INJECT_VERSION>"), or null when the
 *  marker is present but has no version suffix (pre-v0.1.3 injection) — null
 *  is treated as "stale, re-inject" by patchExtension. */
function injectedVersion(content: string): string | null {
    const m = content.match(/cc-status-dot-injected:v(\d+\.\d+\.\d+)\*/);
    return m ? "v" + m[1] : null;
}

/** Validate anchors, back up once, and write the IIFE into extension.js.
 *  `src` is the CURRENT unpatched content of extension.js (must NOT contain
 *  INJECT_MARKER — pre-v0.1.3 originals never do; restoreExtension yields one
 *  from .bak). Throws on anchor mismatch without writing anything. */
function injectFresh(extJs: string, src: string): void {
    // Validate anchors BEFORE creating any backup or writing anything, so a
    // failed run leaves zero footprint on disk (no half-written file, no .bak).
    const aCount = countOccurrences(src, ANCHOR_A);
    if (aCount !== 1) {
        fail(
            `Anchor A (update_session_state handler) matched ${aCount} time(s), expected 1. ` +
                `The CC extension has likely changed. No files were modified.`,
        );
    }
    const bCount = countOccurrences(src, ANCHOR_B);
    if (bCount > 1) {
        fail(
            `Anchor B (rename_tab icon branch) matched ${bCount} times, expected 0 or 1. ` + `No files were modified.`,
        );
    }
    if (bCount === 0) {
        warn(
            "Anchor B not found — installing with Anchor A only. The permission-pending blue-dot fix will be INACTIVE (a yellow running dot may cover CC's native blue pending dot during a permission prompt), and ~500 ms flash may occur after CC rename_tab.",
        );
    }

    // One-time original backup, only after we know injection will succeed.
    backupOnce(extJs, extJs + ".bak");

    const iife = buildIIFE(RUNTIME_RES_DIR);

    // Anchor A: splice side effects into the return expression via the comma operator.
    // IMPORTANT: we must NOT wrap the consequent in a block. The original chain is
    //   `else if(update_session_state)return ...,{...};else if(show_notification){...}`
    // where the trailing `;` ends the ReturnStatement and the following `else` still
    // binds to this if. If we replaced the consequent with `{...}` the `};` would
    // complete the IfStatement and orphan the next `else` → SyntaxError. Keeping the
    // consequent as a single `return a,b,c,d` expression preserves the binding.
    const replA =
        'else if(e.request.type==="update_session_state")return ' +
        "this.__ccSid=e.request.sessionId,this.__ccTitle=e.request.title," +
        iife +
        ',this.onSessionStateChanged?.(e.request.sessionId,e.request.state,e.request.title),{type:"update_session_state_response"}';

    let next = src.replace(ANCHOR_A, replA);
    if (!next.includes(INJECT_MARKER)) fail("Anchor A replacement did not apply. No files were modified.");

    // Anchor B (optional hardening): start the same guarded timer from rename_tab too.
    if (bCount === 1) {
        // replB also refreshes this.__ccTitle from the live rename_tab title —
        // CC may fire rename_tab multiple times AFTER update_session_state
        // (truncation, user rename, panel title reassignment) and replA's
        // stashed value would otherwise go stale. notify() appends
        // "["+__ccTitle+"]" to the notification body, so keeping it fresh
        // matters for the message shown to the user.
        const replB =
            "this.panelTab.title=e.request.title;this.__ccTitle=e.request.title;this.__ccPending=!!e.request.hasPendingPermissions;" +
            iife +
            ";let r;if(e.request.hasPendingPermissions)";
        next = next.replace(ANCHOR_B, replB);
        if (countOccurrences(next, INJECT_MARKER) < 2) {
            fail("Anchor B replacement did not apply. No files were modified.");
        }
    }

    assertCompiles(next, "patched extension.js");
    fs.writeFileSync(extJs, next, "utf8");
    log(`patched extension.js (anchors injected: A${bCount === 1 ? "+B" : " only"})`);
}

/** Extract the baked `var RES="..."` path from an already-patched extension.js.
 *  The IIFE bakes `var RES=<JSON.stringify(resDir)>;` once per injection site
 *  (Anchor A, optionally Anchor B → 1 or 2 occurrences, all identical). We read
 *  the first to detect a STALE baked path — e.g. a v0.1 install baked
 *  PROJECT_ROOT/resources; phase1 bakes INSTALL_DIR/resources. Returns null if
 *  the literal cannot be found/parsed (treat as "not stale, leave alone").
 *
 *  The match is anchored on `cc-tab-status");var RES=` — the DIR literal always
 *  immediately precedes RES inside OUR IIFE — so a coincidental CC-native
 *  `var RES=` elsewhere in the minified bundle can never be misread. */
function bakedResPath(content: string): string | null {
    const m = content.match(/cc-tab-status"\);var RES=("[^"]*");/);
    if (!m) return null;
    try {
        return JSON.parse(m[1]);
    } catch {
        return null;
    }
}

function patchExtension(extDir: string): void {
    const extJs = path.join(extDir, "extension.js");
    if (!fs.existsSync(extJs)) fail(`extension.js not found in ${extDir}`);

    const src = fs.readFileSync(extJs, "utf8");
    if (!isExtensionPatched(src)) {
        injectFresh(extJs, src);
        return;
    }

    // Already patched. Two independent staleness axes:
    //   (1) IIFE *logic* version — the marker matches but the stamped version is
    //       absent (pre-v0.1.3) or older than INJECT_VERSION. The bare marker
    //       match alone cannot detect this, so a re-run would otherwise skip and
    //       leave the old IIFE body (e.g. v0.1.2 breathing frames) in place.
    //       Fix: restore extension.js from .bak and re-inject the current IIFE.
    //   (2) baked RES path — a v0.1 install baked PROJECT_ROOT/resources; we
    //       surgically rewrite that one literal in place (cheaper than full re-inject).
    const ver = injectedVersion(src);
    if (ver !== INJECT_VERSION) {
        const bak = extJs + ".bak";
        if (fs.existsSync(bak)) {
            const original = fs.readFileSync(bak, "utf8");
            if (!isExtensionPatched(original)) {
                log(`stale injected IIFE (${ver ?? "pre-v0.1.3"}) — re-injecting from extension.js.bak`);
                injectFresh(extJs, original);
                return;
            }
            warn(`extension.js.bak is itself patched — cannot cleanly re-inject; falling back to RES rewrite`);
        } else {
            warn(
                `stale injected IIFE (${ver ?? "pre-v0.1.3"}) but no extension.js.bak — cannot re-inject; falling back to RES rewrite`,
            );
        }
        // Fall through to baked-RES check as a best-effort refresh.
    }

    const wantRes = RUNTIME_RES_DIR;
    const baked = bakedResPath(src);
    if (baked === null || baked === wantRes) {
        log("extension.js already patched — skipping injection");
        return;
    }
    const oldLit = JSON.stringify(baked);
    const newLit = JSON.stringify(wantRes);
    const needle = `var RES=${oldLit};`;
    if (!src.includes(needle)) {
        warn(`extension.js patched but baked RES literal not found (got ${baked}); skipping RES rewrite`);
        return;
    }
    backupOnce(extJs, extJs + ".bak");
    // split/join replaces ALL occurrences (Anchor A + optional Anchor B).
    const next = src.split(needle).join(`var RES=${newLit};`);
    assertCompiles(next, "patched extension.js (RES path rewrite)");
    fs.writeFileSync(extJs, next, "utf8");
    log(`updated stale baked RES path: ${baked} → ${wantRes}`);
}

function restoreExtension(extDir: string): void {
    const extJs = path.join(extDir, "extension.js");
    const bak = extJs + ".bak";
    if (!fs.existsSync(bak)) {
        log("no extension.js.bak found — extension.js was not patched by this tool (nothing to restore)");
        return;
    }
    fs.copyFileSync(bak, extJs);
    log("restored extension.js from extension.js.bak");
    // Intentionally keep extension.js.bak as a safety net.
}

// ---------------------------------------------------------------------------
// Webview restore — removes the legacy aggregate status bar injected by
//   v0.1.2 (ACQUIRE_RE / WV_JS_MARKER / WV_API_MARKER / WV_CSS_MARKER).
//   The injection itself was removed in v0.1.3 (the bar was more noise than
//   signal — the per-tab dot already tells you every session's state). We keep
//   this restore so (a) --revert still undoes a v0.1.2 install, and (b) install
//   auto-detects a leftover v0.1.2 webview patch and cleans it (see run()).
//
//   Detection uses the `cc-status-bar-injected` comment tombstone — a string
//   CC's minified webview bundle will never produce (it's our v0.1.2 banner
//   comment), so the check is forward-safe against future CC versions. We do
//   NOT use v0.1.2's `window.__ccVsApi=` literal here: that name follows CC's
//   own `__cc*` convention and could one day be re-used by CC natively, which
//   would cause a false positive and clobber a fresh CC webview with a stale
//   .bak. Defined locally in this restore section (not hoisted to the top
//   Constants block) on purpose — it's a tombstone scoped to the removed
//   injection code.
// ---------------------------------------------------------------------------

/** Literal marker baked into webview/index.js by v0.1.2's patchWebview (the
 *  banner comment at the head of the injected block). Presence === "legacy
 *  aggregate bar present, please clean". */
const LEGACY_WV_MARKER = "cc-status-bar-injected";

/** Does webview/index.js still carry the v0.1.2 aggregate-bar injection? */
function hasLegacyWebviewPatch(extDir: string): boolean {
    const wvJs = path.join(extDir, "webview", "index.js");
    if (!fs.existsSync(wvJs)) return false;
    try {
        return fs.readFileSync(wvJs, "utf8").includes(LEGACY_WV_MARKER);
    } catch {
        return false;
    }
}

function restoreWebview(extDir: string): void {
    for (const name of ["index.js", "index.css"]) {
        const f = path.join(extDir, "webview", name);
        const bak = f + ".bak";
        if (fs.existsSync(bak)) {
            fs.copyFileSync(bak, f);
            log(`restored webview/${name} from .bak`);
        } else {
            log(`no webview/${name}.bak — was not patched (nothing to restore)`);
        }
    }
}

// ---------------------------------------------------------------------------
// Hooks in ~/.claude/settings.json — idempotent, marker-tagged
// ---------------------------------------------------------------------------

interface HookGroup {
    matcher?: string;
    hooks: { type: string; command: string }[];
}

type HooksMap = Record<string, HookGroup[]>;

function settingsPath(): string {
    return path.join(os.homedir(), ".claude", "settings.json");
}

function hookCommand(hookAbs: string): string {
    // CC pipes the hook JSON via stdin; the script reads hook_event_name from
    // stdin, so no positional arg is needed. `# ${HOOK_MARKER}` is a shell
    // comment — harmless at runtime, greppable for idempotent removal.
    //
    // Bake the ABSOLUTE node binary (process.execPath) rather than bare `node`:
    // when VS Code is launched from Finder/Spotlight (macOS) it inherits a
    // reduced PATH where nvm/asdf-managed node bins are often absent, which
    // would make a bare-`node` hook silently no-op (state file never written →
    // icon never updates, with no error). An absolute execPath resolves
    // independently of PATH. Falls back to `node` only if execPath is unset.
    const nodeBin = process.execPath && fs.existsSync(process.execPath) ? process.execPath : "node";
    return `${nodeBin} "${hookAbs}"  # ${HOOK_MARKER}`;
}

/** Build our owned hooks entries (one group per event in HOOK_EVENTS). */
function buildOurHooks(hookAbs: string): HooksMap {
    const out: HooksMap = {};
    for (const ev of HOOK_EVENTS) {
        out[ev] = [{ matcher: "", hooks: [{ type: "command", command: hookCommand(hookAbs) }] }];
    }
    return out;
}

/** Does a group contain a command we own? */
function groupIsOurs(g: unknown): boolean {
    if (!g || typeof g !== "object") return false;
    const hooks = (g as HookGroup).hooks;
    if (!Array.isArray(hooks)) return false;
    return hooks.some((h) => typeof h?.command === "string" && h.command.includes(HOOK_MARKER));
}

function wireHooks(): void {
    const settings = settingsPath();
    const hookAbs = path.join(INSTALL_DIR, "hooks", "cc-status.js");

    let raw = "{}";
    if (fs.existsSync(settings)) raw = fs.readFileSync(settings, "utf8");
    const obj = parseJsonc(raw, settings) as Record<string, unknown>;

    const ourHooks = buildOurHooks(hookAbs);
    const existing = obj.hooks as HooksMap | undefined;
    let changed = false;

    if (!existing || typeof existing !== "object") {
        obj.hooks = ourHooks;
        changed = true;
    } else {
        for (const ev of Object.keys(ourHooks)) {
            const arr = Array.isArray(existing[ev]) ? existing[ev] : (existing[ev] = []);
            const oursIdx = arr.findIndex(groupIsOurs);
            if (oursIdx >= 0) {
                // Our group already exists for this event. But its command may
                // point at a STALE path (v0.1 baked PROJECT_ROOT/hooks/cc-status.js;
                // phase1 wires INSTALL_DIR/hooks/cc-status.js). If so, rewrite the
                // command in place rather than skipping — otherwise the hook keeps
                // firing a script under a dir the user is expected to delete, and
                // the state machine silently stops writing. Only touch commands
                // carrying our HOOK_MARKER so user-owned hooks are never mutated.
                const g = arr[oursIdx] as HookGroup;
                for (const h of g.hooks) {
                    if (
                        typeof h?.command === "string" &&
                        h.command.includes(HOOK_MARKER) &&
                        !h.command.includes(hookAbs)
                    ) {
                        h.command = hookCommand(hookAbs);
                        changed = true;
                    }
                }
            } else {
                arr.push(ourHooks[ev][0]);
                changed = true;
            }
        }
    }

    if (!changed) {
        log("settings.json hooks already wired — skipping");
        return;
    }

    backupOnce(settings, settings + ".cc-status-dot.bak");
    fs.writeFileSync(settings, JSON.stringify(obj, null, 2) + "\n", "utf8");
    log(`wrote ${HOOK_EVENTS.length} hook event(s) into ${settings}`);
    if (!fs.existsSync(hookAbs)) {
        warn(`hook target does not exist yet: ${hookAbs}`);
        warn("create it (it receives JSON on stdin, writes ~/.claude/cc-tab-status/<sid>.json).");
    }
}

function unwireHooks(): void {
    const settings = settingsPath();
    if (!fs.existsSync(settings)) {
        log("no settings.json — nothing to revert");
        return;
    }
    const raw = fs.readFileSync(settings, "utf8");
    let obj: Record<string, unknown>;
    try {
        obj = JSON.parse(stripJsonc(raw));
    } catch {
        warn("settings.json unreadable — skipping hook removal (remove entries with " + HOOK_MARKER + " manually)");
        return;
    }
    const hooks = obj.hooks as HooksMap | undefined;
    if (!hooks || typeof hooks !== "object") {
        log("no hooks key in settings.json — nothing to revert");
        return;
    }

    let changed = false;
    for (const ev of Object.keys(hooks)) {
        const arr = hooks[ev];
        if (!Array.isArray(arr)) continue;
        const kept = arr.filter((g) => !groupIsOurs(g));
        if (kept.length !== arr.length) changed = true;
        if (kept.length === 0) delete hooks[ev];
        else hooks[ev] = kept;
    }
    if (Object.keys(hooks).length === 0) delete obj.hooks;

    if (changed) {
        fs.writeFileSync(settings, JSON.stringify(obj, null, 2) + "\n", "utf8");
        log("removed cc-status-dot hook entries from settings.json");
    } else {
        log("no cc-status-dot hook entries found in settings.json");
    }
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function ensureStateDir(): void {
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
    } catch {
        // Non-fatal — the hook is responsible for this dir at runtime too.
    }
}

/**
 * Copy our runtime files (resources/*.svg + hooks/cc-status.js) from PROJECT_ROOT
 * into INSTALL_DIR so the patched extension (IIFE bakes INSTALL_DIR/resources) and
 * the wired CC hook (INSTALL_DIR/hooks/cc-status.js) keep resolving after the
 * source project is deleted or the npx cache is purged.
 *
 * Idempotent: every install overwrites — updating is just "re-run". Copy failures
 * are warned, never fatal (so a single unreadable SVG never blocks the whole patch).
 */
function installRuntimeFiles(): void {
    try {
        fs.mkdirSync(INSTALL_DIR, { recursive: true });
        const destRes = path.join(INSTALL_DIR, "resources");
        const destHooks = path.join(INSTALL_DIR, "hooks");
        fs.mkdirSync(destRes, { recursive: true });
        fs.mkdirSync(destHooks, { recursive: true });
        const srcRes = path.join(PROJECT_ROOT, "resources");
        let copied = 0;
        for (const svg of OUR_SVGS) {
            const srcFile = path.join(srcRes, svg);
            try {
                if (fs.existsSync(srcFile)) {
                    fs.copyFileSync(srcFile, path.join(destRes, svg));
                    copied += 1;
                } else {
                    warn(`source SVG missing, not copied: ${svg}`);
                }
            } catch {
                warn(`failed to copy ${svg} (non-fatal)`);
            }
        }
        // Sweep stale SVGs from older versions (e.g. v0.1.2's running-dim/-1/-2/-bright.svg,
        // or v0.1.3's claude-logo-running-{0..7}.svg 8-frame breathing set). Only touches
        // our own claude-logo-*.svg namespace — never other files in destRes.
        try {
            for (const name of fs.readdirSync(destRes)) {
                if (!name.startsWith("claude-logo-") || !name.endsWith(".svg")) continue;
                if (OUR_SVGS.includes(name)) continue;
                try {
                    fs.unlinkSync(path.join(destRes, name));
                    log(`removed stale SVG: ${name}`);
                } catch {
                    // Non-fatal — best-effort cleanup.
                }
            }
        } catch {
            // Non-fatal.
        }
        const srcHook = path.join(PROJECT_ROOT, "hooks", "cc-status.js");
        try {
            if (fs.existsSync(srcHook)) {
                fs.copyFileSync(srcHook, path.join(destHooks, "cc-status.js"));
            } else {
                warn("source hook missing, not copied: hooks/cc-status.js");
            }
        } catch {
            warn("failed to copy hooks/cc-status.js (non-fatal)");
        }
        log(`installed runtime files → ${INSTALL_DIR} (${copied}/${OUR_SVGS.length} SVGs + hook)`);
    } catch (e) {
        warn(`runtime install dir setup failed: ${(e as Error).message}`);
        warn(`the IIFE/hook will reference ${INSTALL_DIR} — ensure files exist there or re-run.`);
    }
}

/**
 * Remove our persistent runtime install dir (--revert). Per-session STATE_DIR is
 * USER DATA and is intentionally left untouched.
 */
function removeInstallDir(): void {
    if (!fs.existsSync(INSTALL_DIR)) {
        log(`runtime install dir absent — nothing to clean: ${INSTALL_DIR}`);
        return;
    }
    try {
        fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
        log(`removed runtime install dir: ${INSTALL_DIR}`);
    } catch (e) {
        warn(`could not remove ${INSTALL_DIR}: ${(e as Error).message} (remove manually)`);
    }
}

/**
 * Report `.bak` files left behind by --revert. These are kept intentionally as a
 * safety net (backupOnce never overwrites an existing .bak, so they hold the
 * PRE-patch originals), but the user should know they exist and how to remove
 * them once they're confident the revert is good.
 */
function reportResidualBaks(extDir: string): void {
    const candidates = [
        path.join(extDir, "extension.js.bak"),
        path.join(extDir, "webview", "index.js.bak"),
        path.join(extDir, "webview", "index.css.bak"),
        settingsPath() + ".cc-status-dot.bak",
    ];
    const left = candidates.filter((p) => fs.existsSync(p));
    if (left.length === 0) return;
    log(`Intentionally kept ${left.length} .bak safety cop${left.length === 1 ? "y" : "ies"} (pre-patch originals):`);
    for (const p of left) log(`  - ${p}`);
    log(`Remove manually if you're confident the revert is good.`);
}

function checkSvgs(resDir: string): void {
    const missing = OUR_SVGS.filter((f) => !fs.existsSync(path.join(resDir, f)));
    if (missing.length === 0) {
        log(`all ${OUR_SVGS.length} status SVGs present in ${resDir}`);
        return;
    }
    warn(`missing SVGs in ${resDir}:`);
    for (const f of missing) warn(`  - ${f}`);
    warn("The injected timer references these files; the tab icon may go blank for the");
    warn("corresponding state until they are added. See docs/DESIGN-injection.md §5.");
}

function isHooksWired(): boolean {
    const settings = settingsPath();
    if (!fs.existsSync(settings)) return false;
    try {
        return fs.readFileSync(settings, "utf8").includes(HOOK_MARKER);
    } catch {
        return false;
    }
}

/**
 * Detect hook commands whose baked absolute node binary no longer exists on
 * disk (typical trigger: the node used at install time was later removed by an
 * nvm/asdf version switch, a Node.app uninstall, or an npx cache purge). When
 * that binary disappears, CC's hook spawn fails with ENOENT BEFORE our script
 * gets a chance to run its own silent-exit(0) fallback, so the writer→reader
 * chain silently stops and every status dot freezes on its last frame.
 *
 * The `nodeBin === "node"` fallback path (used only when execPath is missing
 * at install time) is taken to be present-by-definition and skipped. Otherwise
 * we stat the baked path; on miss we tell the user to re-run install (which
 * re-bakes the current process.execPath). Wrapper-script / multi-path search
 * would be more robust but is a larger architectural change; this diagnostic
 * at least makes the failure mode visible in `--status` instead of silent.
 */
function reportBakedNodeHealth(): void {
    const settings = settingsPath();
    if (!fs.existsSync(settings)) return;
    let obj: Record<string, unknown>;
    try {
        obj = parseJsonc(fs.readFileSync(settings, "utf8"), settings);
    } catch {
        return; // malformed settings — discoverExtension etc. will surface this
    }
    const hooks = obj.hooks as HooksMap | undefined;
    if (!hooks || typeof hooks !== "object") return;
    const seen = new Set<string>();
    let warnedAny = false;
    for (const ev of Object.keys(hooks)) {
        const arr = hooks[ev];
        if (!Array.isArray(arr)) continue;
        for (const g of arr) {
            if (!groupIsOurs(g)) continue;
            for (const h of (g as HookGroup).hooks) {
                const cmd = typeof h?.command === "string" ? h.command : "";
                // cmd shape: `<nodeBin> "<hookAbs>"  # cc-status-dot-managed`
                const m = cmd.match(/^(\S+)\s+"[^"]*cc-status\.js"\s+#\s*cc-status-dot-managed/);
                if (!m) continue;
                const nodeBin = m[1];
                if (seen.has(nodeBin)) continue;
                seen.add(nodeBin);
                if (nodeBin === "node") continue; // already a bare PATH fallback
                if (!fs.existsSync(nodeBin)) {
                    warn(`hook command bakes a node binary that no longer exists: ${nodeBin}`);
                    warn(`  hooks will fail to spawn (ENOENT) — re-run install to re-bake the current node path.`);
                    warnedAny = true;
                }
            }
        }
    }
    if (!warnedAny && seen.size > 0) {
        log(`hook baked node binary: present (${[...seen].join(", ")})`);
    }
}

function reportStatus(): void {
    const { dir, version } = discoverExtension();
    log(`CC extension: v${version}`);
    log(`  ${dir}`);
    const extJs = path.join(dir, "extension.js");
    const extSrc = fs.existsSync(extJs) ? fs.readFileSync(extJs, "utf8") : "";
    const patched = isExtensionPatched(extSrc);
    log(`extension.js patched: ${patched ? "YES" : "no"}`);
    if (patched) {
        // Surface a stale injected IIFE first: a pre-v0.1.3 (or older) IIFE has
        // the marker but old logic (breathing frames etc.) — re-run re-injects.
        const ver = injectedVersion(extSrc);
        if (ver === null) {
            log(`  injected IIFE: pre-v0.1.3 (STALE — re-run to re-inject)`);
        } else if (ver !== INJECT_VERSION) {
            log(`  injected IIFE: ${ver} (STALE — expected ${INJECT_VERSION}; re-run to re-inject)`);
        } else {
            log(`  injected IIFE: ${ver} (up to date)`);
        }
        // Surface a stale baked RES (e.g. v0.1 install pointing at PROJECT_ROOT)
        // so upgrading users can see they need a re-run, not just a reload.
        const baked = bakedResPath(extSrc);
        if (baked === null) {
            log(`  baked RES: (not detectable)`);
        } else if (baked === RUNTIME_RES_DIR) {
            log(`  baked RES: ${baked} (matches INSTALL_DIR)`);
        } else {
            log(`  baked RES: ${baked} (STALE — expected ${RUNTIME_RES_DIR}; re-run to update)`);
        }
    }
    const legacyBar = hasLegacyWebviewPatch(dir);
    log(`legacy webview bar (v0.1.2): ${legacyBar ? "detected — re-run install to clean" : "clean"}`);
    log(`hooks wired: ${isHooksWired() ? "YES" : "no"}`);
    // The injected IIFE references RUNTIME_RES_DIR (INSTALL_DIR/resources).
    // Check THERE honestly — do NOT silently fall back to the project source
    // copy, which would hide a real "icons will go blank" risk (a fallback to
    // PROJECT_ROOT would report "all present" while the baked path points at an
    // empty/missing INSTALL_DIR). Before install this will (correctly) warn.
    checkSvgs(RUNTIME_RES_DIR);
    log(
        `runtime install dir: ${INSTALL_DIR} ${fs.existsSync(INSTALL_DIR) ? "(exists)" : "(will be created on install)"}`,
    );
    log(`state dir: ${STATE_DIR} ${fs.existsSync(STATE_DIR) ? "(exists)" : "(will be created on first hook fire)"}`);
    reportBakedNodeHealth();
}

function printHelp(): void {
    console.log(
        [
            "cc-status-dot patcher",
            "",
            "Usage:",
            "  vscode-claude-code-status-dot            install patch + wire hooks (idempotent)",
            "  vscode-claude-code-status-dot --revert   restore extension.js (and legacy v0.1.2 webview), remove hooks + runtime copy",
            "  vscode-claude-code-status-dot --status   show detection results, change nothing",
            "  vscode-claude-code-status-dot --help     this message",
            "",
            "  (from source, replace the command with: npx tsx patch.ts)",
            "",
            "Runtime files (resources/*.svg, hooks/cc-status.js) are copied to:",
            "  " + INSTALL_DIR,
            "",
            "After install/revert, reload VS Code: Cmd+Shift+P → 'Developer: Reload Window'.",
        ].join("\n"),
    );
}

function reloadHint(): void {
    log("Done. Reload VS Code to apply: Cmd+Shift+P → 'Developer: Reload Window'.");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function run(argv: string[]): void {
    const args = argv.slice(2);
    if (args.includes("-h") || args.includes("--help")) {
        printHelp();
        return;
    }
    if (args.includes("--check-iife")) {
        // Dev: dump the injected IIFE string for syntax verification (node --check).
        console.log(buildIIFE(RUNTIME_RES_DIR));
        return;
    }
    if (args.includes("--status")) {
        reportStatus();
        return;
    }
    if (args.includes("--revert")) {
        log("Reverting…");
        const { dir, version } = discoverExtension();
        log(`CC extension v${version}: ${dir}`);
        restoreExtension(dir);
        restoreWebview(dir);
        unwireHooks();
        // Remove our persistent runtime copy (resources + hook). STATE_DIR holds
        // per-session USER DATA and is intentionally kept.
        removeInstallDir();
        log(`Per-session state dir left in place (user data): ${STATE_DIR}`);
        reportResidualBaks(dir);
        reloadHint();
        return;
    }

    // Default: install.
    log("Installing…");
    const { dir, version } = discoverExtension();
    log(`CC extension v${version}: ${dir}`);
    ensureStateDir();
    // Persist runtime files FIRST: the IIFE baked into extension.js references
    // INSTALL_DIR/resources, and the wired hook references INSTALL_DIR/hooks.
    installRuntimeFiles();
    // Auto-clean: a v0.1.2 install left an aggregate status bar baked into
    // webview/index.js (+index.css). v0.1.3 dropped that feature, so if we see
    // the legacy marker, restore webview from .bak before patching. Users
    // upgrading just re-run `npx vscode-claude-code-status-dot` and the bar is
    // removed for them — no manual --revert needed.
    if (hasLegacyWebviewPatch(dir)) {
        log("detected legacy aggregate bar (v0.1.2) in webview — removing");
        restoreWebview(dir);
    }
    patchExtension(dir);
    wireHooks();
    checkSvgs(RUNTIME_RES_DIR);
    reloadHint();
}

try {
    run(process.argv);
} catch (e) {
    const msg = (e as Error).message || String(e);
    console.error(`\n[cc-status-dot][ERROR] ${msg}`);
    if (/anchor/i.test(msg)) {
        console.error(
            "\nThis usually means the Claude Code extension updated and its minified code shifted.\n" +
                "No files were changed. Please open an issue with your CC version so anchors can be updated:\n" +
                "  https://github.com/anthropics/claude-code/issues  (or this project's issue tracker).",
        );
    }
    process.exit(1);
}
