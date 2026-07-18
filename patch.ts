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
import * as crypto from "crypto";
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
 *  v0.1.13 commandCenter 4-light redesign: the v0.1.10-v0.1.12 window-scoped SBI
 *  (StatusBarItem at Right) is REMOVED and replaced by 4 fixed lights in the VSCode
 *  commandCenter (title-bar top center). 4 lights 🟢done 🟡running 🔵pending 🔴interrupted
 *  in fixed left→right order, each either dim (⚪ at count 0) or colored with a capped
 *  count (1/2/3/N where N>=4). Implementation = 20 static menu items (4 lights × 5 count
 *  variants) contributed to CC's package.json under contributes.menus.commandCenter +
 *  contributes.commands, visibility toggled per-tick by 4 `setContext` keys
 *  (ccStatusDot.{done,running,pending,interrupted} = 0..4). A new singleton timer
 *  (globalThis.__ccsdCcTimer) aggregates counts every 500ms and pushes the 4 contexts.
 *  done>5min→idle and running stale>30min→idle reader rules still apply (counts agree
 *  with per-tab dots); idle sessions are NOT counted as green (only active done is).
 *  🔵 pending is a NEW state fed by the CC Notification hook (writer marks pending:true
 *  on the session file; reader counts it independently from running/done/interrupted).
 *  onDidDispose last-panel-out clears the singleton timer AND resets all 4 contexts to 0
 *  so lights go dim when no CC panel survives. package.json patch is managed by the new
 *  patchPackageJson (marker `__ccStatusDotPkgManaged` + .bak + version-stamped re-inject,
 *  same model as extension.js). The per-tab 4-state dot, __ccPending yield, notify, and
 *  onDidDispose panel-counter are all preserved unchanged.
 *
 *  Earlier history:
 *  v0.1.11 SBI aggregation refactor (per-panel-tick aggregation lifted into window-
 *  scoped singleton timer; §4 done>5min→idle + §7.2 stale-running(>30min)→idle applied
 *  so SBI matches per-tab counts; __ccsdPanelCount last-panel-out teardown).
 *  v0.1.12 round-3 review fixes (SBI singleton createStatusBarItem + setInterval each
 *  in their own try/catch; §7.5→§7.2 attribution fix). */
const INJECT_VERSION = "v0.1.13";

/** Length (hex chars) of the content-hash suffix appended to the version stamp
 *  in both the IIFE banner (cc-status-dot-injected:vX.Y.Z:HASH) and the
 *  package.json hash field (__ccStatusDotPkgHash). The hash captures intra-
 *  version drift — dev iterations that change buildIIFE()/buildCcContribs()
 *  output without bumping INJECT_VERSION would otherwise be invisible to the
 *  idempotency gate (ver===INJECT_VERSION → "skip"), so re-running the patcher
 *  on an existing same-version install would leave stale logic in place. With
 *  the hash, ANY content change forces a .bak restore + re-inject. 8 hex chars
 *  = 32 bits = collision space of ~4 billion, plenty for a per-version stamp. */
const STAMP_HASH_LEN = 8;

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
 *  docs/SUBAGENT-design.md §4–§5.
 *
 *  v0.1.13 adds `Notification`: the writer marks `pending:true` on the session
 *  file so the reader can count 🔵 pending sessions in the commandCenter (CC's
 *  Notification hook covers permission / question / elicit prompts — the same
 *  set of "user input needed" signals that previously only fed CC's native blue
 *  per-tab dot). `SessionStart` is still intentionally excluded (no writer case
 *  — wiring it would be dead wiring, audit F-5). */
const HOOK_EVENTS = [
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "Notification",
    "Stop",
    "StopFailure",
    "SessionEnd",
] as const;

// ---------------------------------------------------------------------------
// commandCenter 4-light definitions (v0.1.13)
// ---------------------------------------------------------------------------
// The VSCode commandCenter (title-bar top center) only renders a command's
// `title` text — there is NO per-menu-item title override (see VScode issue
// #34048). So 5 distinct visible texts per light (0/1/2/3/N) REQUIRE 5
// distinct commands, and 4 lights × 5 variants = 20 commands + 20 menu items
// + 20 commandPalette hide-entries (the palette would otherwise list all 20
// commands, which is noise — `when:"false"` hides them cleanly).
//
// Visibility is then driven by 4 `setContext` keys the IIFE ticks every 500ms:
//   ccStatusDot.<lightKey> = N  where N is 0..4 and 4 means "4+ (display N)"
// Each of the 5 variants per light carries a `when: "ccStatusDot.<key> == K"`
// clause; exactly one variant per light is visible at any moment, the other
// four are filtered out. Lights are declared in fixed left→right order
// (done/running/pending/interrupted); within a light, only one variant shows,
// so declaration order across lights determines the visible on-screen order.

/** Top-level field stamped into CC's patched package.json. Presence === "already
 *  patched by us"; the string value is the INJECT_VERSION stamp, so a stale
 *  patch (older version) triggers re-injection from package.json.bak on next
 *  install — same model as extension.js. VSCode ignores unknown top-level fields
 *  (CC's own package.json carries `__metadata`, `capabilities`, etc.), so this
 *  is safe. CC auto-update replaces the entire extension dir → marker gone →
 *  re-run install patches fresh (project-normal behavior). */
const PKG_MARKER_FIELD = "__ccStatusDotPkgManaged";

/** Top-level field stamped into CC's patched package.json carrying the content
 *  hash of buildCcContribs(). Presence-with-matching-hash === "truly up to
 *  date"; a hash mismatch (intra-version dev iteration that changed the
 *  contribs output) triggers re-injection from package.json.bak on next install
 *  — same model as the IIFE hash. Sits next to PKG_MARKER_FIELD so a single
 *  JSON.parse surface carries both version and hash. */
const PKG_HASH_FIELD = "__ccStatusDotPkgHash";

/** The 4 lights, in fixed left→right display order. `key` is the setContext
 *  key suffix; `emoji` is the colored form (count > 0); `tooltip` is the
 *  user-facing descriptive string shown in the InformationMessage when the
 *  user clicks the commandCenter light (the SINGLE source of truth for the
 *  IIFE's per-light click-feedback text — do NOT duplicate these strings
 *  inside buildIIFE). Emoji codepoints match v0.1.12's SBI palette so per-tab
 *  SVG dots and the commandCenter lights agree (color fidelity depends on the
 *  OS emoji font stack — same documented tradeoff as the removed SBI). */
interface CcLight {
    key: "done" | "running" | "pending" | "interrupted";
    emoji: string; // colored circle when count > 0
    tooltip: string; // user-facing click-feedback text (injected into the IIFE LL map)
}

const CC_LIGHTS: CcLight[] = [
    { key: "done", emoji: "\u{1F7E2}", tooltip: "turn complete (last 5 min)" }, // green circle
    { key: "running", emoji: "\u{1F7E1}", tooltip: "running" }, // yellow circle
    { key: "pending", emoji: "\u{1F535}", tooltip: "awaiting user input" }, // blue circle (NEW v0.1.13)
    { key: "interrupted", emoji: "\u{1F534}", tooltip: "interrupted" }, // red circle
];

/** Off-state emoji shared by all 4 lights (medium white circle). */
const CC_DIM_EMOJI = "\u{26AA}";

/** Count variants per light. "N" is the display form for "4 or more" — the
 *  setContext value is capped at 4 (so `== 4` selects the N variant). */
const CC_COUNT_VARIANTS = ["0", "1", "2", "3", "N"] as const;

// ---------------------------------------------------------------------------
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

/**
 * Atomic write — tmp file + rename. Mirrors the writer's `writeJsonAtomic` in
 * hooks/cc-status.js (line ~308): write a sibling .tmp suffixed with
 * `process.pid + Date.now()` (so concurrent patcher processes never share the
 * same tmp path), then `fs.renameSync` over the target. POSIX rename is atomic
 * by spec, so a crash mid-write at worst leaves an orphan .tmp next to the
 * target — the target itself is never observed half-written. Critical for
 * CC's package.json / extension.js / settings.json, where a truncated write
 * bricks the entire CC extension or silently breaks the writer→reader chain.
 *
 * `assertCompiles` only validates byte-level syntax AFTER the write in the
 * extension.js path; it does NOT protect against writeFileSync being
 * interrupted by disk full / SIGKILL / power loss mid-write. This helper does.
 */
function writeAtomicSync(filePath: string, content: string, encoding: BufferEncoding = "utf8"): void {
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, content, encoding);
    fs.renameSync(tmp, filePath);
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
//   commandCenter 4-light (v0.1.13; see docs/STATES.md §7):
//     The v0.1.10-v0.1.12 StatusBarItem-at-Right aggregation is GONE. Instead
//     the CC extension's package.json is patched (patchPackageJson) to contribute
//     20 commands + 20 commandCenter menu items (group "navigation") + 20
//     commandPalette hide-entries. The 4 lights 🟢done 🟡running 🔵pending
//     🔴interrupted appear in fixed left→right order in the title-bar top center;
//     each light is either dim (⚪ at count 0) or colored with a capped count
//     (1/2/3/N where N means >=4). VSCode has NO per-menu-item title override
//     (issue #34048), so each (light,count) variant is its OWN command — 5
//     variants × 4 lights = 20 commands total.
//   Visibility driver — setContext:
//     A window-scoped singleton timer (globalThis.__ccsdCcTimer, 500ms) reads
//     every <sid>.json, applies the SAME §4 reader rules as per-tab rendering
//     (done>5min→idle so idle sessions are NOT counted as green; running stale
//     >30min→idle to GC crashed sessions), counts running/done/interrupted
//     (idle is NOT a light — it just means "not counted"), ALSO counts pending
//     (j.pending===true, independent of state — the NEW 🔵 light), caps each
//     count at 4, and pushes 4 setContext keys:
//       vs.commands.executeCommand("setContext","ccStatusDot.done",N)  // and
//       .running / .pending / .interrupted — N ∈ {0,1,2,3,4}, 4 = "N" display.
//     VSCode then shows exactly one variant per light (the `when` clause
//     `ccStatusDot.<key> == K` selects it). setContext is idempotent — pushing
//     the same value twice is a no-op, so the 500ms tick is cheap.
//   🔵 pending (NEW v0.1.13):
//     The CC Notification hook (permission/question/elicit prompt) makes the
//     writer mark pending:true on the session file (every non-Notification
//     event clears it). The reader counts pending INDEPENDENTLY of state — a
//     session can be both running AND pending (typical: running turn paused on
//     a permission prompt). Per-tab rendering is UNCHANGED (the __ccPending
//     yield still lets CC's native blue dot show through).
//   commandCenter singleton scope:
//     globalThis.__ccsdCcTimer is window-scoped — first CC panel creates it,
//     every later panel reuses it, so a P-panel window ticks aggregation ONCE
//     per 500ms (not P times). Project-scoped __ccsd* prefix keeps CC's __cc*
//     namespace clean (see the `cc-status-bar-injected` tombstone in
//     restoreWebview()).
//   commandCenter panel-counter lifecycle:
//     Each IIFE entry bumps globalThis.__ccsdPanelCount; onDidDispose
//     decrements and, when the count hits zero (last CC panel in the window
//     closed), clears the singleton timer AND resets all 4 contexts to 0 so
//     every light goes dim — the commandCenter can't freeze on a stale count
//     when no panel survives to refresh it. Opening a fresh CC panel re-arms
//     the timer; the first tick re-pushes the real counts.
//   commandCenter isolation:
//     The singleton timer creation AND the aggregation body each live in their
//     OWN try/catch (carried over from v0.1.12's round-3 fix) — a readdir/stat/
//     parse/setContext failure can never brick the per-panel tick (which has
//     its own setInterval) nor vice-versa, and a timer-creation throw cannot
//     propagate up through the comma-operator chain into CC's
//     update_session_state handler.
//   Naming:
//     globalThis.__ccsdCcTimer / __ccsdPanelCount use the project-scoped
//     __ccsd* prefix (mirrors INJECT_MARKER / HOOK_MARKER), NOT the bare __cc*
//     prefix — see the `cc-status-bar-injected` tombstone in restoreWebview():
//     `__cc*` is CC's own namespace and a future CC release could occupy the
//     same globalThis key, silently disabling our guard.
//     Emoji handling: the IIFE uses NO \u{...} escapes — emoji (🟢🟡🔵🔴⚪) live
//     ONLY in CC_LIGHTS / CC_DIM_EMOJI (patch.ts source) and ship to the user
//     via package.json command titles (buildCcContribs), never in the IIFE's
//     runtime code paths. The only emoji that appear inside the IIFE are inside
//     developer-facing /* */ comments (e.g. "🔴 growth"), not executable values.
// ---------------------------------------------------------------------------

function buildIIFE(resDir: string): string {
    // JSON.stringify yields a safely-quoted, escaped JS string literal for the path
    // (also handles the non-ASCII chars in the project path correctly).
    const resLiteral = JSON.stringify(resDir);
    // LL map (per-light click-feedback tooltip strings) is derived from CC_LIGHTS
    // — the SINGLE source of truth. v0.1.13 fix: previously the IIFE hardcoded its
    // own LL map with divergent wording while CC_LIGHTS carried a dead `label`
    // field that was never read. Now CC_LIGHTS.tooltip drives both the IIFE LL
    // map and any future doc/audit; adding a 5th light only touches CC_LIGHTS.
    const LLLiteral = "{" + CC_LIGHTS.map((l) => `${l.key}:${JSON.stringify(l.tooltip)}`).join(",") + "}";
    // State machine + notification + commandCenter aggregation mirror docs/STATES.md §1/§4/§4b/§7. Keep in sync.
    //
    // The banner carries INJECT_VERSION + a content hash of the body (everything
    // after the banner line). The hash lets patchExtension detect intra-version
    // drift — a re-run on an existing same-version install whose IIFE body
    // differs from the current buildIIFE() output triggers a .bak restore +
    // re-inject instead of silently skipping. See STAMP_HASH_LEN above.
    const bodyLines = [
        `(function(t){`,
        `if(t.__ccDotStarted||!t.panelTab)return;`,
        `t.__ccDotStarted=true;`,
        `/*commandCenter panel counter: bumped per IIFE entry so the onDidDispose teardown at the tail of this IIFE can detect the last panel out and clear the singleton Cc timer + reset all 4 setContext keys to 0 (v0.1.13; was SBI hide in v0.1.11).*/`,
        `globalThis.__ccsdPanelCount=(globalThis.__ccsdPanelCount||0)+1;`,
        `var fs=require("fs"),pth=require("path"),vs=require("vscode"),os=require("os");`,
        `var DIR=pth.join(os.homedir(),".claude","cc-tab-status");`,
        `var RES=${resLiteral};`,
        `var CC_DEFAULT=pth.join(t.context.extensionPath,"resources","claude-logo.svg");`,
        `var DONE_TO_IDLE_MS=5*60*1000;`,
        `/*Stale-running heuristic (§7.2; was named SBI_RUNNING_STALE_MS in v0.1.11-v0.1.12 — kept verbatim for grep continuity): a legit running session gets PreToolUse/PostToolUse heartbeats every tool call, so a state=running file whose mtime exceeds this window is almost certainly a crashed/killed CC process whose SessionEnd never fired — count it as idle, not running (so the commandCenter yellow light doesn't false-stick at 1).*/`,
        `var SBI_RUNNING_STALE_MS=30*60*1000;`,
        /*v0.1.13 interrupted retention (architecture review fix): a crashed/killed
         CC session whose writer wrote state=interrupted NEVER gets a SessionEnd
         (CC didn't shut down cleanly), so without a retention heuristic the 🔴
         red light would monotonically grow as users accumulate abandoned
         interrupted sessions. We decay interrupted files older than 24h to idle
         so they stop counting toward 🔴 (the file is NOT deleted — diagnostic
         value preserved; user can still inspect / manually clean). 24h keeps
         "today's interrupts" highly visible (the original §7.5 rationale:
         "中断态需保持可见以提醒用户") while bounding the long-tail growth. The
         threshold is intentionally much larger than SBI_RUNNING_STALE_MS (30min)
         because interrupted is a terminal state the user may want to inspect
         long after the fact, whereas running is a live heartbeat state whose
         staleness is unambiguous. We reuse the same mtime stat the running
         branch below already needs (best-effort: on stat failure we keep the
         interrupted file counted, never silently drop it).*/
        `var INTERRUPTED_RETENTION_MS=24*60*60*1000;`,
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
        /*commandCenter command handlers (v0.1.13): register the 20 contributed
         commands (ccStatusDot.<key>.<variant>) as info-message no-ops so VSCode
         doesn't pop "command not found" when the user clicks a CC light. The 20
         command IDs are the ones patchPackageJson spliced into CC's package.json
         (4 lights × 5 variants). Idempotent: globalThis.__ccsdCcCmdsRegistered
         ensures only the first CC panel in the extension host registers them;
         subsequent panels reuse. registerCommand can throw on re-register within
         the same host, so the whole block is wrapped in try/catch too — a
         failure here must not propagate up through the comma-operator chain into
         CC's update_session_state handler (same isolation rule as the Cc timer
         setup block below). Click feedback is a one-line InformationMessage so
         the click is acknowledged but not disruptive (no CC tab opened, no
         modal).*/
        `try{if(!globalThis.__ccsdCcCmdsRegistered){globalThis.__ccsdCcCmdsRegistered=true;var LK=["done","running","pending","interrupted"],LL=${LLLiteral},VR=["0","1","2","3","N"];for(var li=0;li<LK.length;li++){for(var vi=0;vi<VR.length;vi++){try{(function(k,v){vs.commands.registerCommand("ccStatusDot."+k+"."+v,function(){try{vs.window.showInformationMessage("cc-status-dot "+k+": "+(v==="N"?"4+":v)+" "+LL[k])}catch(e){}})})(LK[li],VR[vi])}catch(e){}}}}}catch(e){}`,
        /* v0.1.13 commandCenter aggregation singleton timer (replaces the
         * v0.1.10-v0.1.12 SBI StatusBarItem-at-Right). Window-scoped — first
         * CC panel creates it, every later panel reuses it, so a P-panel
         * window ticks aggregation ONCE per 500ms. Project-scoped __ccsd*
         * prefix keeps CC's __cc* namespace clean (see the `cc-status-bar-
         * injected` tombstone in restoreWebview()).
         *
         * The aggregation applies §4 reader rules (done>5min→idle so IDLE
         * sessions are NOT counted toward the green light — only ACTIVE done
         * counts; running stale>30min→idle to GC crashed sessions) so the
         * commandCenter lights agree with the per-tab dots on what
         * "done"/"running" mean. Pending is counted INDEPENDENTLY of state
         * (a session can be both running AND pending).
         *
         * TWO independent try/catch wrappers (carried over from v0.1.12's
         * round-3 fix):
         *   (1) The SETUP step (singleton timer creation) is wrapped
         *       individually — a throw inside setInterval registration
         *       (disposed host, transient VSCode API failure) is swallowed
         *       and the IIFE continues to the per-tab tick. Without this,
         *       a throw would propagate up through the comma-operator chain
         *       into CC's `update_session_state` handler (bricking session-
         *       state tracking), skip the per-tab setInterval, AND skip
         *       onDidDispose registration (so the panel counter bumped at
         *       IIFE entry would never decrement — a permanent leak).
         *   (2) The aggregation BODY inside the setInterval callback has its
         *       own try/catch so a readdir/stat/parse/setContext failure can
         *       never brick the per-panel tick (which has its own setInterval).
         * Emoji note: the IIFE uses no \u{...} escapes — see the buildIIFE
         * header comment above. */
        `try{if(!globalThis.__ccsdCcTimer){globalThis.__ccsdCcTimer=setInterval(function(){`,
        `try{`,
        `var ag={running:0,done:0,interrupted:0,idle:0,pending:0};`,
        `try{`,
        `var files=fs.readdirSync(DIR);`,
        `for(var i=0;i<files.length;i++){`,
        `if(!files[i].endsWith(".json"))continue;`,
        `try{`,
        `var fp=pth.join(DIR,files[i]);`,
        `var j=JSON.parse(fs.readFileSync(fp,"utf8"));`,
        `var st=j.state;var since=j.since;`,
        `/*§4 reader rule: done>5min→idle — IDLE sessions don't count toward the green light (only active done does)*/`,
        `if(st==="done"&&since&&(Date.now()-since)>DONE_TO_IDLE_MS){st="idle";}`,
        `/*§7.2 stale-running heuristic: mtime>SBI_RUNNING_STALE_MS→idle (running files get tool heartbeats, so old mtime=crashed session)*/`,
        `else if(st==="running"){var mt=0;try{mt=fs.statSync(fp).mtimeMs}catch(e2){}if(mt&&(Date.now()-mt)>SBI_RUNNING_STALE_MS){st="idle";}}`,
        `/*v0.1.13 interrupted retention: mtime>INTERRUPTED_RETENTION_MS(24h)→idle — bounds 🔴 growth from accumulated abandoned interrupted sessions (crashed/killed CC never sends SessionEnd). File is NOT deleted (diagnostic value preserved).*/`,
        `else if(st==="interrupted"){var mt=0;try{mt=fs.statSync(fp).mtimeMs}catch(e2){}if(mt&&(Date.now()-mt)>INTERRUPTED_RETENTION_MS){st="idle";}}`,
        `if(st==="running")ag.running++;`,
        `else if(st==="done")ag.done++;`,
        `else if(st==="interrupted")ag.interrupted++;`,
        `else if(st==="idle")ag.idle++;`,
        `/*v0.1.13: pending counted INDEPENDENTLY of state — a session can be both running AND pending (running turn paused on a permission prompt). The writer marks pending:true on Notification and clears it on user/turn-driven events (UserPromptSubmit / Pre/PostToolUse / Stop / StopFailure); SubagentStart / SubagentStop PRESERVE cur.pending (background events carry no signal about the parent's open prompt). GC: skip pending for sessions downgraded to "idle" above (crashed running with pending:true, stale done with pending:true, or interrupted>24h with pending:true) — otherwise a session killed mid-permission-prompt would false-stick the 🔵 light forever (SessionEnd never fires on crash). This mirrors the §7.2 / interrupted-retention treatment: the SAME 'st' value computed above (with all three decay rules applied) gates both the state buckets AND the pending bucket, so a single stale session cannot be "not yellow" yet "still blue".*/`,
        `if(j.pending===true&&st!=="idle")ag.pending++;`,
        `}catch(e){}`,
        `}`,
        `}catch(e){}`,
        `/*cap each count at 4: ccStatusDot.<key>==4 means "4+ (display N)". Clamps via inline ternary — no helper fn to keep IIFE flat.*/`,
        `var cap=function(n){return n>=4?4:n;};`,
        `try{`,
        `vs.commands.executeCommand("setContext","ccStatusDot.done",cap(ag.done));`,
        `vs.commands.executeCommand("setContext","ccStatusDot.running",cap(ag.running));`,
        `vs.commands.executeCommand("setContext","ccStatusDot.pending",cap(ag.pending));`,
        `vs.commands.executeCommand("setContext","ccStatusDot.interrupted",cap(ag.interrupted));`,
        `}catch(e){}`,
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
        `/*release this panel's 500ms tick + closed-over refs when the panel closes; also decrement the commandCenter panel counter, and on the LAST panel out (count→0) clear the singleton Cc timer AND reset all 4 setContext keys to 0 so every light goes dim — the commandCenter can't freeze on a stale count with no surviving panel to refresh it (v0.1.13; was SBI hide in v0.1.11).*/`,
        `try{t.panelTab.onDidDispose(function(){clearInterval(timer);globalThis.__ccsdPanelCount=(globalThis.__ccsdPanelCount||1)-1;if(globalThis.__ccsdPanelCount<=0){globalThis.__ccsdPanelCount=0;if(globalThis.__ccsdCcTimer){clearInterval(globalThis.__ccsdCcTimer);globalThis.__ccsdCcTimer=null;}try{vs.commands.executeCommand("setContext","ccStatusDot.done",0);vs.commands.executeCommand("setContext","ccStatusDot.running",0);vs.commands.executeCommand("setContext","ccStatusDot.pending",0);vs.commands.executeCommand("setContext","ccStatusDot.interrupted",0)}catch(e){}}})}catch(e){}`,
        `})(this)`,
    ];
    // Join with "" (not "\n") to match the historical on-disk byte shape that
    // assertCompiles + existing tests expect; the body hash is computed over the
    // same string so it is stable across patcher runs.
    const body = bodyLines.join("");
    const hash = crypto.createHash("sha1").update(body).digest("hex").slice(0, STAMP_HASH_LEN);
    return `/*${INJECT_MARKER}:${INJECT_VERSION}:${hash}*/` + body;
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
 *  is treated as "stale, re-inject" by patchExtension. Accepts an optional
 *  `:HASH` suffix after the version (added when the content-hash scheme landed)
 *  so a hash-bearing banner still parses cleanly. */
function injectedVersion(content: string): string | null {
    const m = content.match(/cc-status-dot-injected:v(\d+\.\d+\.\d+)(?::[0-9a-f]{4,16})?\*/);
    return m ? "v" + m[1] : null;
}

/** Parse the content-hash suffix from an already-patched extension.js banner.
 *  Returns null when the marker is present but pre-dates the hash scheme (the
 *  banner has only `vX.Y.Z` and no `:HASH`) — patchExtension treats null as
 *  "stale, re-inject" so legacy same-version installs pick up the new scheme. */
function injectedIifeHash(content: string): string | null {
    const m = content.match(/cc-status-dot-injected:v\d+\.\d+\.\d+:([0-9a-f]{4,16})\*/);
    return m ? m[1] : null;
}

/** Current IIFE body hash — the value a fresh buildIIFE() stamps into its
 *  banner. patchExtension compares this to injectedIifeHash(on-disk extension.js)
 *  to detect intra-version drift (dev iterations within the same INJECT_VERSION).
 *  The body excludes the banner line, so the hash does not depend on itself. */
function currentIifeHash(): string {
    const full = buildIIFE(RUNTIME_RES_DIR);
    const markerEnd = full.indexOf("*/");
    const body = markerEnd === -1 ? full : full.slice(markerEnd + 2);
    return crypto.createHash("sha1").update(body).digest("hex").slice(0, STAMP_HASH_LEN);
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
    writeAtomicSync(extJs, next);
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

    // Already patched. Three independent staleness axes:
    //   (1) IIFE *logic* version — the marker matches but the stamped version is
    //       absent (pre-v0.1.3) or older than INJECT_VERSION. The bare marker
    //       match alone cannot detect this, so a re-run would otherwise skip and
    //       leave the old IIFE body (e.g. v0.1.2 breathing frames) in place.
    //       Fix: restore extension.js from .bak and re-inject the current IIFE.
    //   (2) IIFE *content hash* — the version matches but the body differs from
    //       the current buildIIFE() output (intra-version dev iteration). Without
    //       this check, re-running the patcher on an existing same-version
    //       install would silently skip and leave stale logic on disk. The hash
    //       is also bumped by any RES path change, which is fine — a stale RES
    //       path is also a reason to re-inject (the surgical RES rewrite below
    //       is only a best-effort fallback when .bak is unavailable).
    //   (3) baked RES path — a v0.1 install baked PROJECT_ROOT/resources; we
    //       surgically rewrite that one literal in place (cheaper than full re-inject).
    const ver = injectedVersion(src);
    const diskHash = injectedIifeHash(src);
    const wantHash = currentIifeHash();
    if (ver !== INJECT_VERSION || diskHash !== wantHash) {
        const why =
            ver !== INJECT_VERSION
                ? `version ${ver ?? "pre-v0.1.3"}`
                : `hash ${diskHash ?? "(pre-hash-scheme)"} (expected ${wantHash})`;
        const bak = extJs + ".bak";
        if (fs.existsSync(bak)) {
            const original = fs.readFileSync(bak, "utf8");
            if (!isExtensionPatched(original)) {
                log(`stale injected IIFE (${why}) — re-injecting from extension.js.bak`);
                injectFresh(extJs, original);
                return;
            }
            warn(`extension.js.bak is itself patched — cannot cleanly re-inject; falling back to RES rewrite`);
        } else {
            warn(
                `stale injected IIFE (${why}) but no extension.js.bak — cannot re-inject; falling back to RES rewrite`,
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
    writeAtomicSync(extJs, next);
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
// CC package.json patch (v0.1.13 commandCenter 4-light)
// ---------------------------------------------------------------------------
// VSCode's commandCenter (title-bar top center) only renders a command's `title`
// text — there is NO per-menu-item title override (VSCode issue #34048 is open).
// So 5 distinct visible texts per light (0/1/2/3/N) require 5 distinct commands,
// and 4 lights × 5 variants = 20 commands + 20 commandCenter menu items (group
// "navigation", `when: "ccStatusDot.<key> == K"`) + 20 commandPalette hide-entries
// (when:"false" keeps the palette clean). Visibility is driven by 4 setContext
// keys the IIFE ticks every 500ms — exactly one variant per light shows at any
// moment. macOS renders colored emoji (🟢🟡🔵🔴⚪) via Apple Color Emoji in the
// Chromium title-bar; Win7/font-less Linux may show monochrome (same documented
// tradeoff as the removed v0.1.12 SBI).
//
// Idempotent + version-stamped, mirroring the extension.js injection model:
// PKG_MARKER_FIELD at top level carries INJECT_VERSION; a stale stamp triggers
// re-injection from package.json.bak on the next install. VSCode ignores
// unknown top-level fields (CC's own package.json carries `__metadata` etc.),
// so the marker is safe. CC auto-update replaces the entire extension dir →
// marker gone → re-run install patches fresh (project-normal, same as extension.js).

/** Build the 20 managed commands + 20 commandCenter menu items + 20 palette hides.
 *  Pure data — no side effects, easy to unit-test if we ever add one. */
function buildCcContribs(): { commands: object[]; ccMenu: object[]; palette: object[] } {
    const commands: object[] = [];
    const ccMenu: object[] = [];
    const palette: object[] = [];
    for (const light of CC_LIGHTS) {
        for (const variant of CC_COUNT_VARIANTS) {
            const commandId = `ccStatusDot.${light.key}.${variant}`;
            // count=0 → dim ⚪ (no number, light is "off"); count=1/2/3 → colored + digit;
            // N → colored + "N" (means >=4, capped by reader).
            const emoji = variant === "0" ? CC_DIM_EMOJI : light.emoji;
            const title = `${emoji} ${variant}`;
            // Map display variant to the setContext integer it matches. The "N"
            // variant matches the capped value 4 (cap() in the IIFE clamps 4+ to 4).
            const k = variant === "N" ? 4 : Number(variant);
            // v0.1.13 reload-resilience: setContext is window-scoped runtime state
            // that resets to undefined on extension host restart. Before the first
            // IIFE tick fires (i.e. before any CC panel opens and calls
            // update_session_state / rename_tab), `ccStatusDot.<key> == 0` evaluates
            // FALSE because VSCode treats an undefined context key as not matching
            // any `== <int>` clause — so every dim variant would be hidden and the
            // commandCenter would be completely blank (not even the dim ⚪ shows),
            // violating the §7.1 "4 lights always displayed" contract. The dim form
            // therefore uses `!ccStatusDot.X || ccStatusDot.X == 0` so it ALSO
            // matches the undefined (pre-tick / post-reload-no-panel) state. `!key`
            // is VSCode's falsy test (true for undefined/false/0/"") so it covers
            // the == 0 case too — the explicit `|| == 0` is belt-and-braces for
            // readers auditing the when clause.
            const when =
                variant === "0"
                    ? `!ccStatusDot.${light.key} || ccStatusDot.${light.key} == 0`
                    : `ccStatusDot.${light.key} == ${k}`;
            commands.push({ command: commandId, title: title });
            ccMenu.push({
                command: commandId,
                when: when,
                group: "navigation",
            });
            // Hide from commandPalette — otherwise all 20 show as noise.
            palette.push({ command: commandId, when: "false" });
        }
    }
    return { commands, ccMenu, palette };
}

function isPackageJsonPatched(content: string): boolean {
    return content.includes(`"${PKG_MARKER_FIELD}"`);
}

/** Parse the INJECT_VERSION stamp from an already-patched CC package.json.
 *  Returns null for a pre-version stamp (shouldn't happen — PKG_MARKER_FIELD is
 *  always written together with the version string). */
function injectedPkgVersion(content: string): string | null {
    const re = new RegExp(`"${PKG_MARKER_FIELD}"\\s*:\\s*"(v\\d+\\.\\d+\\.\\d+)"`);
    const m = content.match(re);
    return m ? m[1] : null;
}

/** Parse the content-hash stamp from an already-patched CC package.json. Returns
 *  null for a pre-hash-scheme injection — patchPackageJson treats null as
 *  "stale, re-inject" so a same-version legacy install picks up the new scheme. */
function injectedPkgHash(content: string): string | null {
    const re = new RegExp(`"${PKG_HASH_FIELD}"\\s*:\\s*"([0-9a-f]{4,16})"`);
    const m = content.match(re);
    return m ? m[1] : null;
}

/** Current hash of buildCcContribs() — the value a fresh patch stamps into
 *  PKG_HASH_FIELD. patchPackageJson compares this to injectedPkgHash() to
 *  detect intra-version drift (e.g. tooltip/emoji/when changes that ship under
 *  the same INJECT_VERSION). */
function currentPkgHash(contribs: { commands: object[]; ccMenu: object[]; palette: object[] }): string {
    return crypto.createHash("sha1").update(JSON.stringify(contribs)).digest("hex").slice(0, STAMP_HASH_LEN);
}

/** Splice our 20 commands + 20 commandCenter items + 20 palette hides into the
 *  CC package.json object and write it back. Mutates `obj`, writes file once. */
function writePkgInject(
    pkgPath: string,
    obj: Record<string, unknown>,
    contribs: { commands: object[]; ccMenu: object[]; palette: object[] },
): void {
    const contributes = (obj.contributes as Record<string, unknown> | undefined) || {};
    obj.contributes = contributes;

    // commands: append ours after CC's existing commands (array order is not
    // load-bearing — VSCode indexes by command id; CC's own commands all still
    // resolve because we never touch their entries).
    const cmds = Array.isArray(contributes.commands) ? (contributes.commands as object[]) : [];
    contributes.commands = cmds.concat(contribs.commands);

    // menus: ensure the map exists, then append to commandCenter + commandPalette.
    const menus = (contributes.menus as Record<string, unknown> | undefined) || {};
    contributes.menus = menus;
    const cc = Array.isArray(menus.commandCenter) ? (menus.commandCenter as object[]) : [];
    menus.commandCenter = cc.concat(contribs.ccMenu);
    const pal = Array.isArray(menus.commandPalette) ? (menus.commandPalette as object[]) : [];
    menus.commandPalette = pal.concat(contribs.palette);

    // Stamp marker + content hash at top level so subsequent installs can detect
    // both cross-version staleness (PKG_MARKER_FIELD = INJECT_VERSION) and
    // intra-version drift (PKG_HASH_FIELD = currentPkgHash). The hash covers
    // the contribs JSON, so any change to commands/menus/titles/emoji/when
    // trips a re-inject on the next run even without a version bump.
    obj[PKG_MARKER_FIELD] = INJECT_VERSION;
    obj[PKG_HASH_FIELD] = currentPkgHash(contribs);

    writeAtomicSync(pkgPath, JSON.stringify(obj, null, 2) + "\n");
}

function patchPackageJson(extDir: string): void {
    const pkgPath = path.join(extDir, "package.json");
    if (!fs.existsSync(pkgPath)) fail(`package.json not found in ${extDir}`);

    const raw = fs.readFileSync(pkgPath, "utf8");
    let obj: Record<string, unknown>;
    try {
        obj = JSON.parse(raw);
    } catch (e) {
        fail(`Could not parse CC package.json (${(e as Error).message}). No files were changed.`);
    }

    const contribs = buildCcContribs();

    if (!isPackageJsonPatched(raw)) {
        // Fresh injection — back up the original first (only after parse succeeded,
        // so a corrupt package.json never gets a .bak).
        backupOnce(pkgPath, pkgPath + ".bak");
        writePkgInject(pkgPath, obj, contribs);
        log(`patched package.json (20 commands + 20 commandCenter items + 20 palette hides)`);
        return;
    }

    // Already patched — check version AND content-hash staleness. The hash
    // catches intra-version drift (dev iterations that changed contribs output
    // under the same INJECT_VERSION); without it, a same-version re-run would
    // skip and leave the stale contribs on disk.
    const ver = injectedPkgVersion(raw);
    const diskHash = injectedPkgHash(raw);
    const wantHash = currentPkgHash(contribs);
    if (ver === INJECT_VERSION && diskHash === wantHash) {
        log("package.json already patched — skipping");
        return;
    }

    // Stale version or hash — restore from .bak and re-inject.
    const why =
        ver !== INJECT_VERSION
            ? `version ${ver ?? "unknown"}`
            : `hash ${diskHash ?? "(pre-hash-scheme)"} (expected ${wantHash})`;
    const bak = pkgPath + ".bak";
    if (fs.existsSync(bak)) {
        const original = fs.readFileSync(bak, "utf8");
        if (!isPackageJsonPatched(original)) {
            log(`stale package.json injection (${why}) — re-injecting from package.json.bak`);
            let origObj: Record<string, unknown>;
            try {
                origObj = JSON.parse(original);
            } catch {
                warn(`package.json.bak unreadable — skipping re-inject (manual edit needed)`);
                return;
            }
            writePkgInject(pkgPath, origObj, contribs);
            log(`re-patched package.json (20 commands + 20 commandCenter items + 20 palette hides)`);
            return;
        }
        warn(`package.json.bak is itself patched — cannot cleanly re-inject; skipping`);
    } else {
        warn(`stale package.json injection (${why}) but no .bak — cannot re-inject; skipping`);
    }
}

function restorePackageJson(extDir: string): void {
    const pkgPath = path.join(extDir, "package.json");
    const bak = pkgPath + ".bak";
    if (!fs.existsSync(bak)) {
        log("no package.json.bak found — package.json was not patched by this tool");
        return;
    }
    fs.copyFileSync(bak, pkgPath);
    log("restored package.json from package.json.bak");
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

/**
 * Warn when the baked node binary path lives under a version-managed install
 * (nvm / asdf / volta). Those directories disappear on `nvm uninstall`,
 * `asdf uninstall nodejs`, `volta uninstall node`, etc. — and the baked hook
 * command then ENOENTs at spawn time, BEFORE our silent-exit(0) fallback can
 * fire, so the writer→reader chain silently breaks (every status dot freezes
 * on its last frame). This is the architecture's core install/runtime
 * coupling: the writer is the root of the data pipeline.
 *
 * Not a hard error — the path may survive the user's workflow (e.g. they keep
 * that nvm version around). We surface the risk so the user knows to re-run
 * install after a node version change if dots stop updating. A wrapper-script
 * fix would be more robust but is a larger architectural change (see CHANGELOG
 * note in architecture-review).
 */
function warnIfVolatileNodePath(): void {
    const p = process.execPath || "";
    if (!p) return;
    // Match the typical install roots: .nvm/versions/node/<ver>/bin/node,
    // .asdf/installs/nodejs/<ver>/bin/node (asdf uses "nodejs" service name),
    // .volta/tools/image/node/<ver>/bin/node. POSIX + Windows separators both
    // accepted so the check works cross-platform.
    const volatile =
        /[\\/]\.nvm[\\/]versions[\\/]node[\\/]/.test(p) ||
        /[\\/]\.asdf[\\/]installs[\\/]node(?:js)?[\\/]/.test(p) ||
        /[\\/]\.volta[\\/]tools[\\/]image[\\/]node[\\/]/.test(p);
    if (!volatile) return;
    warn(`hook commands will bake a version-managed node binary path: ${p}`);
    warn(`  this path disappears on \`nvm uninstall\` / \`asdf uninstall nodejs\` / \`volta uninstall node\`.`);
    warn(`  if status dots stop updating after a node version switch, re-run install (it re-bakes the current path).`);
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
    writeAtomicSync(settings, JSON.stringify(obj, null, 2) + "\n");
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
        writeAtomicSync(settings, JSON.stringify(obj, null, 2) + "\n");
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
        path.join(extDir, "package.json.bak"),
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
        // Surface a stale injected IIFE: a pre-v0.1.3 (or older) IIFE has the
        // marker but old logic (breathing frames etc.) — re-run re-injects.
        // Since the content-hash scheme landed, an intra-version drift (same
        // INJECT_VERSION but a body that differs from current buildIIFE()) is
        // ALSO surfaced here, so dev iterations on a same-version install no
        // longer falsely report "up to date".
        const ver = injectedVersion(extSrc);
        const diskHash = injectedIifeHash(extSrc);
        const wantHash = currentIifeHash();
        const hashStale = diskHash !== wantHash;
        if (ver === null) {
            log(`  injected IIFE: pre-v0.1.3 (STALE — re-run to re-inject)`);
        } else if (ver !== INJECT_VERSION) {
            log(`  injected IIFE: ${ver} (STALE — expected ${INJECT_VERSION}; re-run to re-inject)`);
        } else if (hashStale) {
            log(
                `  injected IIFE: ${ver} hash ${diskHash ?? "(pre-hash-scheme)"} (STALE — expected ${wantHash}; re-run to re-inject)`,
            );
        } else {
            log(`  injected IIFE: ${ver} hash ${diskHash} (up to date)`);
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
    // package.json commandCenter patch (v0.1.13+).
    const pkgPath = path.join(dir, "package.json");
    const pkgSrc = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, "utf8") : "";
    const pkgPatched = isPackageJsonPatched(pkgSrc);
    log(`package.json patched (commandCenter 4-light): ${pkgPatched ? "YES" : "no"}`);
    if (pkgPatched) {
        const pver = injectedPkgVersion(pkgSrc);
        const diskHash = injectedPkgHash(pkgSrc);
        const wantHash = currentPkgHash(buildCcContribs());
        const hashStale = diskHash !== wantHash;
        if (pver === null) {
            log(`  package.json injection: pre-v0.1.13 marker (STALE — re-run to re-inject)`);
        } else if (pver !== INJECT_VERSION) {
            log(`  package.json injection: ${pver} (STALE — expected ${INJECT_VERSION}; re-run to re-inject)`);
        } else if (hashStale) {
            log(
                `  package.json injection: ${pver} hash ${diskHash ?? "(pre-hash-scheme)"} (STALE — expected ${wantHash}; re-run to re-inject)`,
            );
        } else {
            log(`  package.json injection: ${pver} hash ${diskHash} (up to date)`);
        }
    }
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
            "  vscode-claude-code-status-dot --revert   restore extension.js + package.json (and legacy v0.1.2 webview), remove hooks + runtime copy",
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
    if (args.includes("--check-pkg-contribs")) {
        // Dev: dump buildCcContribs() output as JSON so test-pkg-contribs.mjs
        // can lock the 20-command / 20-menu / 20-palette contract + the dim-when
        // reload-resilience clause. Mirrors --check-iife's role: zero install-side
        // coverage was a v0.1.13 blind spot (test-iife.mjs only saw the IIFE
        // string), so any refactor breaking buildCcContribs (cap value, dim emoji,
        // when clause form, command id shape) would pass every existing test.
        console.log(JSON.stringify(buildCcContribs(), null, 2));
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
        restorePackageJson(dir);
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
    patchPackageJson(dir);
    // Surface the install/runtime coupling BEFORE wiring hooks: hookCommand
    // bakes process.execPath into settings.json, and if that path lives under
    // nvm/asdf/volta it can disappear later. Warned here so the user sees it
    // in the same install log as the "wrote N hook events" line that follows.
    warnIfVolatileNodePath();
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
