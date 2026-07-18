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
 *   its request DOES carry sessionId) to stash `this.__ccsdSid` and start a
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
 *  v0.1.15 SBI digit-in-block pivot: the v0.1.14 single SBI rendered
 *  "🟢N 🟡N 🔵N 🔴N" (emoji ball + digit as separate tokens inside one
 *  StatusBarItem.text). User feedback: the ball+digit-separate read was
 *  unsatisfying. v0.1.15 splits into FOUR runtime StatusBarItem instances
 *  (one per light) so each light's digit renders INSIDE its own colored
 *  block — count>0 → themed backgroundColor block + "#ffffff" white digit
 *  text; count=0 → "0" text in statusBarItem.deactivatedForeground gray +
 *  transparent background (block visible but dim). 4 SBI-specific built-in
 *  ThemeColors are reused so NO package.json patch is needed (preserving
 *  the v0.1.14 "CC upgrade doesn't break" design):
 *    🟢 done        → statusBarItem.remoteBackground    (green, priority -9996)
 *    🟡 running     → statusBarItem.warningBackground   (yellow, -9997)
 *    🔵 pending     → statusBarItem.prominentBackground (saturated blue, -9998)
 *    🔴 interrupted → statusBarItem.errorBackground     (red, -9999)
 *  VSCode's StatusBarItem.backgroundColor field accepts ThemeColor only
 *  (NOT hex strings) — verified against mainThreadStatusBar.ts source — so
 *  these 4 built-in SBI theme colors are the only route to 4 distinct
 *  colored backgrounds. Priorities -9996..-9999 keep the 4 blocks at the
 *  rightmost end of StatusBarAlignment.Left (closest to visible center),
 *  in fixed left→right order done/running/pending/interrupted (higher
 *  priority = more to the left per vscode.d.ts). The aggregation GC rules
 *  (done>5min, running>30min, interrupted>24h, pending-with-idle-GC) are
 *  UNCHANGED — only the rendering surface changed. Per-tab 4-state dots,
 *  __ccsdPending yield, notify, panel-counter lifecycle all preserved.
 *  The singleton timer now mutates all 4 SBIs each tick; onDidDispose
 *  disposes all 4 on last-panel-out. SBI_LIGHTS (emoji array) /
 *  SBI_DIM_EMOJI / SBI_LEFT_PRIORITY are REMOVED — replaced by the
 *  SBI_LIGHTS_CFG table (key/bg/pri per light). SBI_CLICK_CMD is unchanged.
 *
 *  Earlier history:
 *  v0.1.14 SBI pivot (commandCenter → bottom StatusBarItem 4-light): the
 *  v0.1.13 commandCenter 4-light redesign (20 commands + 20 commandCenter
 *  menu items + 20 palette hides + IIFE-driven setContext + VSCode title-bar
 *  commandCenter visibility) was empirically unreliable — after a Reload
 *  Window / full VSCode restart the commandCenter 4 lights often failed to
 *  render at all. v0.1.14 kept the v0.1.13 DESIGN improvements (4-light
 *  with NEW 🔵 pending, 3-way stale-session GC for done/running/interrupted,
 *  pending counted INDEPENDENTLY of state) but moved the SURFACE back to a
 *  single StatusBarItem at the BOTTOM. The text was "🟢N 🟡N 🔵N 🔴N".
 *  package.json was NO LONGER patched by install.
 *  v0.1.13 commandCenter 4-light (now abandoned — see v0.1.14 note above).
 *  v0.1.11 SBI aggregation refactor (per-panel-tick aggregation lifted into window-
 *  scoped singleton timer; §4 done>5min→idle + §7.2 stale-running(>30min)→idle applied
 *  so SBI matches per-tab counts; __ccsdPanelCount last-panel-out teardown).
 *  v0.1.12 round-3 review fixes (SBI singleton createStatusBarItem + setInterval each
 *  in their own try/catch; §7.5→§7.2 attribution fix). */
const INJECT_VERSION = "v0.1.15";

/** Length (hex chars) of the content-hash suffix appended to the version stamp
 *  in the IIFE banner (cc-status-dot-injected:vX.Y.Z:HASH). The hash captures
 *  intra-version drift — dev iterations that change buildIIFE() output without
 *  bumping INJECT_VERSION would otherwise be invisible to the idempotency gate
 *  (ver===INJECT_VERSION → "skip"), so re-running the patcher on an existing
 *  same-version install would leave stale logic in place. With the hash, ANY
 *  content change forces a .bak restore + re-inject. 8 hex chars = 32 bits =
 *  collision space of ~4 billion, plenty for a per-version stamp. */
const STAMP_HASH_LEN = 8;

/** Substring appended (as a shell comment) to every hook command we own in settings.json.
 *  Used for idempotent dedupe on install and surgical removal on --revert. */
const HOOK_MARKER = "cc-status-dot-managed";

/** Version banner stamped at the top of hooks/cc-status.js
 *  (`cc-status-dot-hook:vX.Y.Z`). Mirrors the IIFE's INJECT_VERSION+hash gate
 *  so installRuntimeFiles can detect a stale on-disk hook copy the same way
 *  patchExtension detects a stale IIFE. Architecture-review round-2 finding:
 *  writer/reader drift detection was asymmetric — the reader side was hash-
 *  stamped and auto-reinjected, the writer side was copied verbatim with NO
 *  version check, so a user running an old hook against a new IIFE (e.g. the
 *  install copied the IIFE but the hook copy failed silently, or the user
 *  hand-edited INSTALL_DIR/hooks/cc-status.js) saw silent feature loss with
 *  no warning. MUST be kept in lockstep with the banner at the top of
 *  hooks/cc-status.js. */
const HOOK_VERSION = "v0.1.14";
const HOOK_BANNER_PREFIX = "cc-status-dot-hook:";

/** CC extension version against which the anchor strings (ANCHOR_A / ANCHOR_B)
 *  were last verified byte-exact. Architecture-review round-3 finding: the
 *  'verified byte-exact against CC X.Y.Z' comment lived inline at the anchor
 *  declarations but was NOT surfaced anywhere user-visible. CC updates that
 *  drift either anchor's bytes are still caught by countOccurrences==1 (the
 *  patcher fails loud), but a user running an older CC whose anchors happen to
 *  still match would silently install against a never-verified version.
 *  --status now surfaces this const so the user can self-check after a CC
 *  upgrade; install does NOT hard-gate (preserves forward compat — a future CC
 *  that keeps the anchor bytes identical still installs cleanly). */
const LAST_VERIFIED_CC = "2.1.204";

/** Length (hex chars) of the content-hash suffix appended to the writer hook
 *  banner (`cc-status-dot-hook:vX.Y.Z:HASH`). Mirrors STAMP_HASH_LEN — same
 *  sha1-over-body scheme as the IIFE hash, so a dev iteration on
 *  hooks/cc-status.js that doesn't bump HOOK_VERSION is still detectable by
 *  installRuntimeFiles + --status. Architecture-review round-3 finding:
 *  round-2 added a writer version banner + version-string check, but the
 *  reader side had content-hash and the writer side did NOT — asymmetric
 *  drift detection. A dev who edited hooks/cc-status.js and forgot to bump
 *  the banner would have the patcher silently overwrite an installed hook
 *  whose body differed, no warn. The hash closes that gap: install compares
 *  BOTH version AND body hash, --status surfaces either drift. */
const HOOK_HASH_LEN = 8;

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
 *  file so the reader can count 🔵 pending sessions in the bottom SBI 4-light
 *  aggregate (v0.1.14 surface; v0.1.13 attempted this via commandCenter — the
 *  pending light + the Notification hook that feeds it are PRESERVED across
 *  the v0.1.13→v0.1.14 pivot). CC's Notification hook covers permission /
 *  question / elicit prompts — the same set of "user input needed" signals
 *  that previously only fed CC's native blue per-tab dot. `SessionStart` is
 *  still intentionally excluded (no writer case — wiring it would be dead
 *  wiring, audit F-5). */
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
// SBI 4-light definitions (v0.1.15: 4 StatusBarItem instances, digit-in-block)
// ---------------------------------------------------------------------------
// The bottom status bar shows 4 lights in fixed left→right order: 🟢done
// 🟡running 🔵pending 🔴interrupted. v0.1.15 renders each light as its OWN
// runtime StatusBarItem so the count digit sits INSIDE a colored block (the
// v0.1.14 single-SBI "emoji ball + digit separate" read was the user-rejected
// prior art). VSCode's StatusBarItem.backgroundColor field accepts ThemeColor
// ONLY (not hex strings — verified against mainThreadStatusBar.ts $setEntry:
// `backgroundColor: ThemeColor | undefined`), so we reuse 4 built-in SBI
// theme colors. No package.json contribution is needed — createStatusBarItem
// + .backgroundColor = new ThemeColor(id) renders any registered SBI theme
// color (statusbarItem.ts applyColor resolves whatever the active color theme
// provides). Priorities -9996..-9999 put the 4 blocks at the rightmost end
// of StatusBarAlignment.Left (closest to visible center); within that, higher
// priority = more to the left (vscode.d.ts StatusBarItem.priority doc), so
// done(-9996) is leftmost, interrupted(-9999) rightmost. count=0 → "0" text
// in statusBarItem.deactivatedForeground gray + transparent background (dim
// but visible); count>0 → digit-or-"N" white text + themed bg block (lit).
// The single click-command `ccStatusDot.sbiClick` is set on all 4 SBIs and
// registered via runtime `vs.commands.registerCommand` (no contribution
// needed); handler reads globalThis.__ccsdSbis[0].tooltip.

/** Marker stamped into CC's package.json by the abandoned v0.1.13 commandCenter
 *  patch. Kept only so install can DETECT stale v0.1.13 residue (and --revert
 *  can clean it) — v0.1.14+ no longer writes this field. */
const PKG_MARKER_FIELD = "__ccStatusDotPkgManaged";

/** The 4 lights, in fixed left→right display order. Each entry pins the
 *  light's background ThemeColor id (a VSCode built-in statusBarItem.*
 *  color, stable across themes) and its StatusBarItem.priority (higher =
 *  more to the left; -9996..-9999 keeps the 4 blocks bunched at the
 *  rightmost end of the Left alignment). This table is the SINGLE source
 *  of truth consumed by buildIIFE (baked into the IIFE's `var CFG=[...]`
 *  via JSON.stringify) and mirrored in test-iife.mjs. Renaming a bg id or
 *  reordering lights here changes both the IIFE bytes and the test
 *  assertions in lockstep.
 *
 *  Why these 4 theme colors:
 *   - statusBarItem.remoteBackground — the SSH/WSL remote-indicator button
 *     color; green in every built-in theme. We borrow the COLOR not the
 *     semantic (users who re-theme the remote button get their "done"
 *     block re-themed too, which is a feature: theme consistency).
 *   - statusBarItem.warningBackground — yellow/orange; added in VSCode 1.66
 *     specifically for SBI warning-state backgrounds.
 *   - statusBarItem.prominentBackground — the saturated "prominent" SBI
 *     background; blue in most themes (purple in a few dark themes — still
 *     distinguishable from green/yellow/red). If a user reports the pending
 *     block reads purple in their theme, swap to editor.selectionBackground
 *     or activityBarBadge.background (both more stably blue).
 *   - statusBarItem.errorBackground — red; standard SBI error background.
 *
 *  The public StatusBarItemKind enum (normal/warning/error/prominent) only
 *  has 4 values and gives only 3 non-default colors, so it cannot produce 4
 *  distinct backgrounds — that's why we use the lower-level backgroundColor
 *  = new ThemeColor(id) path instead of the `kind` API. */
const SBI_LIGHTS_CFG: ReadonlyArray<{ key: string; bg: string; pri: number }> = [
    { key: "done", bg: "statusBarItem.remoteBackground", pri: -9996 }, // 🟢 leftmost
    { key: "running", bg: "statusBarItem.warningBackground", pri: -9997 }, // 🟡
    { key: "pending", bg: "statusBarItem.prominentBackground", pri: -9998 }, // 🔵
    { key: "interrupted", bg: "statusBarItem.errorBackground", pri: -9999 }, // 🔴 rightmost
];

/** The SBI click-command id. Registered at runtime via
 *  vs.commands.registerCommand (no package.json contribution needed for
 *  registerCommand). Single source of truth — baked into the IIFE at the
 *  registerCommand site AND assigned to EACH of the 4 SBIs' `.command`
 *  field via ${JSON.stringify(SBI_CLICK_CMD)}, and mirrored in test-iife.mjs.
 *  Renaming the command touches this const once; the IIFE bytes + the test
 *  assertions both follow. */
const SBI_CLICK_CMD = "ccStatusDot.sbiClick";

// ---------------------------------------------------------------------------
// --- Anchor strings (verified byte-exact against CC 2.1.204) ---------------

/**
 * Anchor A — the `update_session_state` handler. Same `ts` (per-panel) instance
 * as rename_tab, and its request carries sessionId. We splice side effects into
 * the return expression via the comma operator (NOT a block — a block would
 * orphan the trailing `else` and brick the extension; see injectFresh for the
 * full syntactic constraint) to (1) stash this.__ccsdSid and (2) start the
 * redraw timer before the original return. Exact, must match ONCE.
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
 *   - this.__ccsdTitle = e.request.title    — keeps the cached panel title fresh
 *     so notify()'s "["+__ccsdTitle+"]" suffix matches the CURRENT tab title
 *     even after CC fires rename_tab multiple times post-update_session_state
 *     (truncation, user rename). Without this the title would freeze at the
 *     last update_session_state value.
 *   - this.__ccsdPending = !!e.request.hasPendingPermissions — the same flag CC
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
//                    rename_tab handler stashes `this.__ccsdPending` from
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
//   SBI 4-light (v0.1.15; see docs/STATES.md §7):
//     v0.1.14 rendered "🟢N 🟡N 🔵N 🔴N" inside a single StatusBarItem.text
//     (emoji ball + digit as separate tokens). v0.1.15 splits into FOUR
//     runtime StatusBarItem instances so each light's digit renders INSIDE
//     its own colored block (white digit on themed background). The v0.1.13
//     commandCenter surface and the v0.1.14 single-SBI emoji format are both
//     gone; ALL design improvements are preserved (4 lights incl. NEW 🔵
//     pending; 3-way stale-session GC for done/running/interrupted; pending
//     counted INDEPENDENTLY of state).
//   Surface — 4 StatusBarItem instances (v0.1.15):
//     globalThis.__ccsdSbis is a window-scoped ARRAY of 4 createStatusBarItem
//     instances (one per light), each with its own backgroundColor
//     (ThemeColor), color (white/gray), and text (the digit). Priorities
//     -9996..-9999 keep them bunched at the rightmost end of
//     StatusBarAlignment.Left. All 4 are mutated in place every 500ms by the
//     __ccsdSbiTimer singleton. NO package.json patch (the v0.1.13
//     commandCenter contribs are GONE; v0.1.15 reuses built-in SBI theme
//     colors so no contributes.colors either). Click feedback via a single
//     runtime-registered command `ccStatusDot.sbiClick` wired to all 4 SBIs
//     — shows an InformationMessage with the current breakdown.
//   Per-block render (built each tick, v0.1.15):
//     count 0 → text "0" + color statusBarItem.deactivatedForeground (gray)
//               + backgroundColor undefined (transparent — dim but visible).
//     count 1/2/3 → text digit + color "#ffffff" (white) + backgroundColor
//                   CFG[k].bg (the light's themed block color: green/yellow/
//                   blue/red).
//     count >=4 → text "N" (cap() clamps 4+ to 4) + white + themed bg.
//     Tooltip (same on all 4 SBIs) carries the uncapped breakdown
//     ("X done, Y running, Z pending, W interrupted").
//   Aggregation rules (SAME as v0.1.13/v0.1.14 — preserved across pivot):
//     Window-scoped singleton timer globalThis.__ccsdSbiTimer (500ms) reads
//     every <sid>.json, applies the SAME §4 reader rules as per-tab rendering
//     (done>5min→idle so idle sessions are NOT counted as green; running stale
//     >30min→idle to GC crashed sessions; interrupted >24h→idle to bound 🔴
//     growth from abandoned crashes), counts running/done/interrupted (idle is
//     NOT a light — it just means "not counted"), ALSO counts pending
//     (j.pending===true, independent of state — the 🔵 light, NEW v0.1.13).
//   🔵 pending (NEW v0.1.13, preserved):
//     The CC Notification hook (permission/question/elicit prompt) makes the
//     writer mark pending:true on the session file (every non-Notification
//     event clears it). The reader counts pending INDEPENDENTLY of state — a
//     session can be both running AND pending (typical: running turn paused on
//     a permission prompt). Per-tab rendering is UNCHANGED (the __ccsdPending
//     yield still lets CC's native blue dot show through).
//   SBI singleton scope:
//     globalThis.__ccsdSbis (4-element array) + __ccsdSbiTimer are window-
//     scoped — first CC panel creates them, every later panel reuses them, so
//     a P-panel window ticks aggregation ONCE per 500ms (not P times).
//     Project-scoped __ccsd* prefix keeps CC's __cc* namespace clean (see the
//     `cc-status-bar-injected` tombstone in restoreWebview()).
//   SBI panel-counter lifecycle:
//     Each IIFE entry bumps globalThis.__ccsdPanelCount; onDidDispose
//     decrements and, when the count hits zero (last CC panel in the window
//     closed), clears the singleton timer AND disposes ALL 4 SBIs so they go
//     away — the bottom bar can't freeze on a stale count when no panel
//     survives to refresh it. Opening a fresh CC panel re-creates both; the
//     first tick re-pushes the real counts.
//   SBI isolation:
//     The SBI creation (4-item loop), the singleton timer creation, AND the
//     aggregation body each live in their OWN try/catch (carried over from
//     v0.1.12/v0.1.13/v0.1.14) — a readdir/stat/parse/text-mutate failure
//     can never brick the per-panel tick (which has its own setInterval) nor
//     vice-versa, and a creation or timer-creation throw cannot propagate up
//     through the comma-operator chain into CC's update_session_state handler.
//   Naming:
//     ALL project-injected fields — BOTH globalThis singletons
//     (__ccsdSbis / __ccsdSbiTimer / __ccsdPanelCount / __ccsdSbiCmdRegistered)
//     AND per-panel-instance fields stashed on the same `this`/`t` object CC's
//     minified code operates on (__ccsdDotStarted / __ccsdSid / __ccsdTitle /
//     __ccsdPending) — use the project-scoped __ccsd* prefix (mirrors
//     INJECT_MARKER / HOOK_MARKER), NOT the bare __cc* prefix. The rationale
//     is the same for both surfaces and applies by *reason*, not by literal
//     scope: `__cc*` is CC's own namespace (see the `cc-status-bar-injected`
//     tombstone in restoreWebview()) and a future CC release could occupy the
//     same key on EITHER globalThis OR the panel instance, silently disabling
//     our guard / overwriting our stash. The earlier v0.1.x field names
//     __ccDotStarted / __ccSid / __ccTitle / __ccPending were renamed to the
//     __ccsd* form in the v0.1.14 pivot for this consistency.
//     Config baking (v0.1.15): the SBI_LIGHTS_CFG table (key/bg/pri per light)
//     is the SINGLE source of truth in patch.ts source, baked into the IIFE
//     as a JSON-stringified array literal `var CFG=[...]` via JSON.stringify
//     in buildIIFE — never as raw escapes in the IIFE source. The IIFE
//     comments reference theme-color ids (e.g. "🔴 growth"), not executable
//     color values.
// ---------------------------------------------------------------------------

function buildIIFE(resDir: string): string {
    // JSON.stringify yields a safely-quoted, escaped JS string literal for the path
    // (also handles the non-ASCII chars in the project path correctly).
    const resLiteral = JSON.stringify(resDir);
    // SBI 4-light config table baked into the IIFE as a JSON-stringified array
    // literal (so no raw escapes in the IIFE source). SBI_LIGHTS_CFG is the
    // SINGLE source of truth (patch.ts); the IIFE's per-tick loop iterates
    // CFG[k] for {key,bg,pri}. Order matches aggregation output:
    // done/running/pending/interrupted (left→right on the status bar).
    const cfgLiteral = JSON.stringify(SBI_LIGHTS_CFG);
    // State machine + notification + SBI aggregation mirror docs/STATES.md §1/§4/§4b/§7. Keep in sync.
    //
    // The banner carries INJECT_VERSION + a content hash of the body (everything
    // after the banner line). The hash lets patchExtension detect intra-version
    // drift — a re-run on an existing same-version install whose IIFE body
    // differs from the current buildIIFE() output triggers a .bak restore +
    // re-inject instead of silently skipping. See STAMP_HASH_LEN above.
    const bodyLines = [
        `(function(t){`,
        `if(t.__ccsdDotStarted||!t.panelTab)return;`,
        `t.__ccsdDotStarted=true;`,
        `/*SBI panel counter: bumped per IIFE entry so the onDidDispose teardown at the tail of this IIFE can detect the last panel out and dispose the 4 singleton SBIs + clear their timer (v0.1.15: 4-SBI dispose loop; was single __ccsdSbi.dispose in v0.1.14; was Cc timer + 4 setContext resets in v0.1.13; was SBI hide in v0.1.11).*/`,
        `globalThis.__ccsdPanelCount=(globalThis.__ccsdPanelCount||0)+1;`,
        `var fs=require("fs"),pth=require("path"),vs=require("vscode"),os=require("os");`,
        `var DIR=pth.join(os.homedir(),".claude","cc-tab-status");`,
        `var RES=${resLiteral};`,
        `var CC_DEFAULT=pth.join(t.context.extensionPath,"resources","claude-logo.svg");`,
        `var DONE_TO_IDLE_MS=5*60*1000;`,
        `/*Stale-running heuristic (§7.2; was named SBI_RUNNING_STALE_MS in v0.1.11-v0.1.12 — kept verbatim for grep continuity): a legit running session gets PreToolUse/PostToolUse heartbeats every tool call, so a state=running file whose mtime exceeds this window is almost certainly a crashed/killed CC process whose SessionEnd never fired — count it as idle, not running (so the SBI yellow light doesn't false-stick at 1).*/`,
        `var SBI_RUNNING_STALE_MS=30*60*1000;`,
        /*v0.1.13 interrupted retention (architecture review fix, preserved in v0.1.14):
         a crashed/killed CC session whose writer wrote state=interrupted NEVER
         gets a SessionEnd (CC didn't shut down cleanly), so without a retention
         heuristic the 🔴 red light would monotonically grow as users accumulate
         abandoned interrupted sessions. We decay interrupted files older than
         24h to idle so they stop counting toward 🔴 (the file is NOT deleted —
         diagnostic value preserved; user can still inspect / manually clean).
         24h keeps "today's interrupts" highly visible (the original §7.5
         rationale: "中断态需保持可见以提醒用户") while bounding the long-tail
         growth. The threshold is intentionally much larger than
         SBI_RUNNING_STALE_MS (30min) because interrupted is a terminal state
         the user may want to inspect long after the fact, whereas running is a
         live heartbeat state whose staleness is unambiguous. We reuse the same
         mtime stat the running branch below already needs (best-effort: on
         stat failure we keep the interrupted file counted, never silently
         drop it).*/
        `var INTERRUPTED_RETENTION_MS=24*60*60*1000;`,
        /*v0.1.15 SBI 4-light config table — baked from SBI_LIGHTS_CFG (patch.ts
         single source of truth) via JSON.stringify so the IIFE source contains
         no raw escapes. Each entry pins the light's background ThemeColor id
         (a VSCode built-in statusBarItem.* color) and StatusBarItem.priority
         (-9996..-9999 → rightmost Left items, done leftmost / interrupted
         rightmost). The creation loop + per-tick update loop both index CFG[k]
         — k=0 done / k=1 running / k=2 pending / k=3 interrupted, matching the
         counts[] array built inside the aggregation tick. VSCode's SBI
         backgroundColor field accepts ThemeColor only (NOT hex), so these 4
         built-in SBI theme colors are the only route to 4 distinct colored
         blocks without re-introducing a package.json patch.*/
        `var CFG=${cfgLiteral};`,
        `var flashSeq=0,lastTermSince=null,seeded=false;/*flashSeq: interrupted on/off frame index (flashSeq%2)*/`,
        `function notify(st,err){`,
        `var c=vs.workspace.getConfiguration("ccStatusDot");`,
        `if(!c.get("notify",true))return;`,
        `var focused=vs.window.state.focused;`,
        `if(focused&&!c.get("notifyWhenFocused",true))return;`,
        `var msg,sev;`,
        `if(st==="done"){sev="info";msg="Claude Code: turn complete"}`,
        `else{sev="warn";var m={rate_limit:"rate limit reached",overloaded:"server overloaded"}[err]||err||"interrupted";msg="Claude Code: "+m}`,
        `if(t.__ccsdTitle)msg+=" ["+t.__ccsdTitle+"]";`,
        `/*macOS: osascript system notification; on async OR sync failure fall through to VSCode message so the notification feature stays observable when osascript is denied / missing / mis-escaped. R3 review fix: escMsg escapes the message body; the same escape is now applied to the notifySound config value too — a sound name containing " or \\ would otherwise either break the AppleScript (caught silently → no sound plays, indistinguishable from "sound not found") or inject arbitrary AppleScript from the user's own settings.json. The two interpolations are now symmetric (both halves of the same command string defended the same way).*/`,
        `if(os.platform()==="darwin"){var snd=c.get("notifySound","Glass");var escSnd=(""+snd).replace(/["\\\\]/g,function(c){return "\\\\"+c;});var sndStr=escSnd?(' sound name "'+escSnd+'"'):'';var escMsg=(""+msg).replace(/["\\\\]/g,function(c){return "\\\\"+c;});var vsMsg=function(){if(sev==="info")vs.window.showInformationMessage(msg);else vs.window.showWarningMessage(msg);};try{require("child_process").execFile("osascript",["-e",'display notification "'+escMsg+'" with title "Claude Code"'+sndStr],function(err){if(err)vsMsg()})}catch(e){vsMsg()}}`,
        `else{if(sev==="info")vs.window.showInformationMessage(msg);else vs.window.showWarningMessage(msg);}`,
        `}`,
        /*v0.1.15 SBI click command (carried over from v0.1.14; handler now reads
         globalThis.__ccsdSbis[0].tooltip since the single __ccsdSbi became a
         4-element array). ONE command registered via runtime
         vs.commands.registerCommand — no package.json contribution needed for
         registerCommand (it adds the command to VSCode's command registry at
         runtime; package.json contribution is only needed for palette/menu/
         keybinding wiring, none of which we use here). Idempotent across panels
         via globalThis.__ccsdSbiCmdRegistered — registerCommand throws on
         re-registration of the same ID within one host, so the whole block is
         wrapped in try/catch too. The handler reads the FIRST SBI's CURRENT
         tooltip (all 4 SBIs carry the same full breakdown, kept fresh every
         500ms by __ccsdSbiTimer) and shows it as an InformationMessage —
         clicking ANY of the 4 blocks echoes the current breakdown without
         modal / tab-switch disruption. Each SBI.command field is set to this
         command's ID in the 4-SBI creation block just below, so VSCode
         executes it on click of any block.*/
        `try{if(!globalThis.__ccsdSbiCmdRegistered){globalThis.__ccsdSbiCmdRegistered=true;try{vs.commands.registerCommand(${JSON.stringify(SBI_CLICK_CMD)},function(){try{if(globalThis.__ccsdSbis&&globalThis.__ccsdSbis[0])vs.window.showInformationMessage(globalThis.__ccsdSbis[0].tooltip||"cc-status-dot")}catch(e){}})}catch(e){}}}catch(e){}`,
        /* v0.1.15 SBI 4-light digit-in-block creation (replaces v0.1.14's single
         * SBI). FOUR window-scoped createStatusBarItem instances — one per
         * light — each rendered as a colored block with the count digit
         * INSIDE it (white text on themed background). count=0 → "0" text in
         * statusBarItem.deactivatedForeground gray + transparent background
         * (block visible but dim); count>0 → digit-or-"N" white + themed bg
         * block (lit). The singleton is globalThis.__ccsdSbis (ARRAY of 4
         * StatusBarItem instances); guard `!globalThis.__ccsdSbis` ensures
         * only the first CC panel creates them. Project-scoped __ccsd* prefix
         * keeps CC's __cc* namespace clean (see the `cc-status-bar-injected`
         * tombstone in restoreWebview()).
         *
         * The aggregation applies §4 reader rules (done>5min→idle so IDLE
         * sessions are NOT counted toward the green light — only ACTIVE done
         * counts; running stale>30min→idle to GC crashed sessions; interrupted
         * >24h→idle to bound 🔴 growth) so the SBI blocks agree with the
         * per-tab dots on what "done"/"running"/"interrupted" mean. Pending is
         * counted INDEPENDENTLY of state (a session can be both running AND
         * pending — the typical case: a running turn paused on a permission
         * prompt).
         *
         * THREE independent try/catch wrappers (carried over from v0.1.12/
         * v0.1.13/v0.1.14 round-3 fix):
         *   (1) SBI CREATION (the 4-item createStatusBarItem loop +
         *       registerCommand wiring) is wrapped individually — a throw
         *       here is swallowed and the IIFE continues to the per-tab tick.
         *       Round-4 hardening (v0.1.15): the loop body is now per-iteration
         *       try/catch + commit-atomic. The guard is a LENGTH check
         *       (`!__ccsdSbis || __ccsdSbis.length !== CFG.length`) — a prior
         *       partial-failure run that left a length<4 truthy array is
         *       detected, the residual items are disposed, and the array is
         *       rebuilt from scratch. The 4 createStatusBarItem results are
         *       accumulated in a LOCAL `arr`; only when `arr.length===CFG.length`
         *       (all 4 succeeded) is the array committed to globalThis — a
         *       partial run leaves globalThis unset so the next panel retries.
         *       This closes the "permanently stuck at N<4 lights" silent
         *       degradation that v0.1.14's single-SBI path could not have.
         *       Round-5 leak fix (v0.1.15): the prior round-4 comment claimed
         *       "a partial run leaves globalThis unset so the next panel
         *       retries" — but said nothing about the N<4 SBIs that were
         *       already `.show()`n inside the loop before the iteration that
         *       threw. Those SBIs are visible on the status bar yet unreachable
         *       (never assigned to globalThis), so neither the per-tick update
         *       loop nor the last-panel-out teardown can dispose them — every
         *       retry would stack another partial set of orphan blocks. The
         *       commit-atomic `if` now has an `else` that walks `arr` and
         *       disposes each already-shown SBI before discarding it, so a
         *       partial failure leaves ZERO visible residue (the next panel
         *       retries from a clean slate).
         *   (2) The singleton TIMER SETUP is wrapped individually — a throw
         *       inside setInterval registration (disposed host, transient
         *       VSCode API failure) is swallowed and the IIFE continues to the
         *       per-tab tick + onDidDispose registration. Without this, a
         *       throw would propagate up through the comma-operator chain into
         *       CC's `update_session_state` handler (bricking session-state
         *       tracking), skip the per-tab setInterval, AND skip onDidDispose
         *       registration (so the panel counter bumped at IIFE entry would
         *       never decrement — a permanent leak).
         *   (3) The aggregation BODY inside the setInterval callback has its
         *       own try/catch so a readdir/stat/parse/text-mutate failure can
         *       never brick the per-panel tick (which has its own setInterval).
         */
        `try{if(!globalThis.__ccsdSbis||globalThis.__ccsdSbis.length!==CFG.length){if(globalThis.__ccsdSbis){for(var j=0;j<globalThis.__ccsdSbis.length;j++){try{globalThis.__ccsdSbis[j].dispose()}catch(e){}};globalThis.__ccsdSbis=null;}var arr=[];var litBgs=[];var dimClr=new vs.ThemeColor("statusBarItem.deactivatedForeground");for(var k=0;k<CFG.length;k++){try{var sbi=vs.window.createStatusBarItem(vs.StatusBarAlignment.Left,CFG[k].pri);sbi.name="CC "+CFG[k].key;sbi.text="0";sbi.tooltip="Claude Code: 0 done, 0 running, 0 pending, 0 interrupted";try{sbi.command=${JSON.stringify(SBI_CLICK_CMD)}}catch(e){};sbi.color=dimClr;sbi.show();litBgs.push(new vs.ThemeColor(CFG[k].bg));arr.push(sbi)}catch(e){}};if(arr.length===CFG.length){globalThis.__ccsdSbis=arr;globalThis.__ccsdSbiLitBgs=litBgs;globalThis.__ccsdSbiDimClr=dimClr;globalThis.__ccsdSbiLastKey=null;}else{for(var f=0;f<arr.length;f++){try{arr[f].dispose()}catch(e){}};}}}catch(e){}`,
        `try{if(!globalThis.__ccsdSbiTimer){globalThis.__ccsdSbiTimer=setInterval(function(){`,
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
        `/*v0.1.13/v0.1.14 interrupted retention: mtime>INTERRUPTED_RETENTION_MS(24h)→idle — bounds 🔴 growth from accumulated abandoned interrupted sessions (crashed/killed CC never sends SessionEnd). File is NOT deleted (diagnostic value preserved).*/`,
        `else if(st==="interrupted"){var mt=0;try{mt=fs.statSync(fp).mtimeMs}catch(e2){}if(mt&&(Date.now()-mt)>INTERRUPTED_RETENTION_MS){st="idle";}}`,
        `if(st==="running")ag.running++;`,
        `else if(st==="done")ag.done++;`,
        `else if(st==="interrupted")ag.interrupted++;`,
        `/*R3 review fix (M8/M9): catch-all idle bucket. The prior 'else if(st==="idle")ag.idle++;' chain silently dropped any file whose state field was neither of the four known values — a hand-edited / corrupt / forward-incompatible file with state="foo" or state=undefined matched NONE of the branches, so its counts vanished from ALL state totals while its pending===true STILL counted toward 🔵 (because undefined!=="idle" is true). That incoherence ("too corrupt to bucket by state yet trusted for pending") is now closed two ways: (1) any unknown state is treated as idle (matches the aggregation's unknown→idle posture already used on stat failure) AND its st is REASSIGNED to "idle" so the pending check below sees the normalized value; (2) the pending check below then sees st==="idle" and skips pending too — consistent treatment of the same corrupt file across both axes. Round-4 (v0.1.15) closes the half-fix where the prior else arm only ran ag.idle++ without reassigning st — that left st at the original unknown value (e.g. 'foo'/undefined), so the pending check still evaluated unknown!=="idle" as true and over-counted 🔵. The writer never produces such files (every deriveStatus return has a known state), so this is pure defensive hardening.*/`,
        `else{st="idle";ag.idle++;}`,
        `/*v0.1.13/v0.1.14: pending counted INDEPENDENTLY of state — a session can be both running AND pending (running turn paused on a permission prompt). The writer marks pending:true on Notification and clears it on user/turn-driven events (UserPromptSubmit / Pre/PostToolUse / Stop / StopFailure); SubagentStart / SubagentStop PRESERVE cur.pending (background events carry no signal about the parent's open prompt). GC: skip pending for sessions downgraded to "idle" above (crashed running with pending:true, stale done with pending:true, or interrupted>24h with pending:true) — otherwise a session killed mid-permission-prompt would false-stick the 🔵 light forever (SessionEnd never fires on crash). This mirrors the §7.2 / interrupted-retention treatment: the SAME 'st' value computed above (with all three decay rules applied) gates both the state buckets AND the pending bucket, so a single stale session cannot be "not yellow" yet "still blue".*/`,
        `if(j.pending===true&&st!=="idle")ag.pending++;`,
        `}catch(e){}`,
        `}`,
        `}catch(e){}`,
        `/*cap each light's count at 4 so the "N" variant displays for >=4. Clamps via inline ternary — no helper fn to keep IIFE flat.*/`,
        `var cap=function(n){return n>=4?4:n;};`,
        `var cd=cap(ag.done),cr=cap(ag.running),cp=cap(ag.pending),ci=cap(ag.interrupted);`,
        /*v0.1.15 digit-in-block render: each of the 4 SBIs shows just the
         count digit INSIDE its own colored block. counts[] indexes match
         CFG[] (done/running/pending/interrupted). Per-SBI update rules:
           n===0 → text "0" + deactivatedForeground gray + transparent bg
                   (block visible but dim; user always sees the 4 categories)
           n>0   → text (n>=4?"N":""+n) + "#ffffff" white + themed bg block
                   (lit colored block with white digit inside)
         The dim/lit flip is the v0.1.15 equivalent of v0.1.14's disp()/DIM
         emoji swap — same semantic (0=dim, non-0=lit), new visual primitive
         (transparent+gray vs themed-block+white). No disp()/EM/DIM needed
         anymore. cap() still clamps 4+ to 4 so the "N" variant kicks in.*/
        `var counts=[cd,cr,cp,ci];`,
        `/*tooltip carries the UNcapped breakdown so the user can see actual counts even when the lights cap at N. All 4 SBIs carry the same tooltip (hovering any block shows the full breakdown).*/`,
        `var tip="Claude Code: "+ag.done+" done, "+ag.running+" running, "+ag.pending+" pending, "+ag.interrupted+" interrupted";`,
        /*v0.1.15 round-4 hardening: per-tick SBI update loop now (a) wraps each
         SBI mutate in its OWN try/catch (was a single outer try/catch over the
         whole for-loop — one disposed SBI throwing froze ALL later blocks for
         that tick AND every subsequent tick); (b) reuses cached ThemeColor
         instances built once at creation time (globalThis.__ccsdSbiLitBgs +
         __ccsdSbiDimClr) instead of allocating `new vs.ThemeColor(...)` per
         block per tick — ThemeColor is an immutable id wrapper so cross-tick
         reuse is safe, and this cuts ~8 allocations/tick to 0 in steady state;
         (c) short-circuits via a lastKey memo (globalThis.__ccsdSbiLastKey)
         keyed on the UNcapped aggregation tuple — long-running sessions where
         the capped counts don't change for hours skip the mutate loop entirely
         (~40 IPC writes/s → 0 in steady state). The key uses uncapped values
         so an ag.done 4→5 (both cap to "N") still refreshes the tooltip's "4 done"
         → "5 done" breakdown. Per-iteration try/catch aligns with the dispose
         loop's existing isolation pattern (round-3 already had try/catch IN
         the dispose loop — only create/update were the asymmetric outliers).*/
        `try{if(globalThis.__ccsdSbis&&globalThis.__ccsdSbiLitBgs){var key=ag.done+","+ag.running+","+ag.pending+","+ag.interrupted;if(key!==globalThis.__ccsdSbiLastKey){globalThis.__ccsdSbiLastKey=key;for(var k=0;k<globalThis.__ccsdSbis.length;k++){try{var sbi=globalThis.__ccsdSbis[k];var n=counts[k];sbi.text=n===0?"0":(n>=4?"N":""+n);sbi.tooltip=tip;if(n>0){sbi.backgroundColor=globalThis.__ccsdSbiLitBgs[k];sbi.color="#ffffff"}else{sbi.backgroundColor=undefined;sbi.color=globalThis.__ccsdSbiDimClr};sbi.show()}catch(e){}}}}}catch(e){}`,
        `}catch(e){}`,
        `},${TICK_MS});}}catch(e){}`,
        `var timer=setInterval(function(){`,
        `var p=t.panelTab;if(!p)return;`,
        `var sid=t.__ccsdSid;if(!sid)return;`,
        `var st=null,since=null,err="";`,
        `try{var j=JSON.parse(fs.readFileSync(pth.join(DIR,sid+".json"),"utf8"));st=j.state;since=j.since;err=j.error||""}catch(e){}`,
        `if(!seeded){seeded=true;if(st==="done"||st==="interrupted")lastTermSince=since}`,
        `else if((st==="done"||st==="interrupted")&&since!==lastTermSince){lastTermSince=since;try{notify(st,err)}catch(e){}}`,
        `/*permission pending: yield to CC native blue dot*/if(t.__ccsdPending)return;`,
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
        `/*release this panel's 500ms tick + closed-over refs when the panel closes; also decrement the SBI panel counter, and on the LAST panel out (count→0) clear the singleton SBI timer AND dispose ALL 4 SBIs so they go away — the bottom bar can't freeze on a stale count with no surviving panel to refresh it (v0.1.15: 4-SBI dispose loop; was single __ccsdSbi.dispose in v0.1.14; was Cc timer + 4 setContext resets in v0.1.13; was SBI hide in v0.1.11).*/`,
        `try{t.panelTab.onDidDispose(function(){clearInterval(timer);globalThis.__ccsdPanelCount=(globalThis.__ccsdPanelCount||1)-1;if(globalThis.__ccsdPanelCount<=0){globalThis.__ccsdPanelCount=0;if(globalThis.__ccsdSbiTimer){clearInterval(globalThis.__ccsdSbiTimer);globalThis.__ccsdSbiTimer=null;}if(globalThis.__ccsdSbis){for(var k=0;k<globalThis.__ccsdSbis.length;k++){try{globalThis.__ccsdSbis[k].dispose()}catch(e){}};globalThis.__ccsdSbis=null;globalThis.__ccsdSbiLitBgs=null;globalThis.__ccsdSbiDimClr=null;globalThis.__ccsdSbiLastKey=null;}}})}catch(e){}`,
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

// ---------------------------------------------------------------------------
// Writer-hook content hash (architecture-review round-3 fix; mirrors the IIFE
// hash scheme above). The writer hook (hooks/cc-status.js) carries a banner
// `/*cc-status-dot-hook:vX.Y.Z:HASH*/` on its first line; the hash is sha1 of
// everything AFTER that banner line. installRuntimeFiles + reportStatus use
// these helpers to detect BOTH inter-version drift (banner version differs
// from HOOK_VERSION) AND intra-version drift (banner hash differs from the
// current body hash — a dev edited the hook but forgot to bump the banner).
// Symmetric to the IIFE gate so writer/reader drift detection is no longer
// the half-rounded thing round-2 left.
// ---------------------------------------------------------------------------

/** Parse `vX.Y.Z` out of a `cc-status-dot-hook:vX.Y.Z[:HASH]` banner line.
 *  Returns null if the line has no recognizable banner (e.g. hand-edited or
 *  pre-v0.1.14 hook). Tolerates a missing hash segment (pre-round-3 banner). */
function parseHookBannerVersion(bannerLine: string): string | null {
    const m = bannerLine.match(/cc-status-dot-hook:v(\d+\.\d+\.\d+)/);
    return m ? "v" + m[1] : null;
}

/** Parse the `:HASH` suffix out of a `cc-status-dot-hook:vX.Y.Z:HASH` banner.
 *  Returns null when the banner pre-dates the hash scheme (round-3) — callers
 *  treat null as "stale, re-stamp" so legacy same-version hooks pick up the
 *  new scheme on the next install. */
function parseHookBannerHash(bannerLine: string): string | null {
    const m = bannerLine.match(/cc-status-dot-hook:v\d+\.\d+\.\d+:([0-9a-f]{4,16})/);
    return m ? m[1] : null;
}

/** Split a hook file's content into (bannerLine, body). The writer hook
 *  (hooks/cc-status.js) starts with `#!/usr/bin/env node` + `'use strict';`
 *  so the cc-status-dot-hook banner lives on line 3 — find it by regex over
 *  the first ~10 lines instead of assuming it's the first line. The body is
 *  the full content with the banner line replaced by an empty line, so the
 *  hash is robust to changes ANYWHERE in the file (including the banner line
 *  itself — the banner's hash claims to be the hash of everything that is
 *  NOT the banner). Returns { banner: "", body: content } when no banner is
 *  recognizable so callers can hash uniformly. */
function splitHookBanner(content: string): { banner: string; body: string } {
    const lines = content.split("\n");
    const head = lines.slice(0, 10);
    const idx = head.findIndex((l) => /cc-status-dot-hook:v\d+\.\d+\.\d+/.test(l));
    if (idx === -1) return { banner: "", body: content };
    const banner = head[idx];
    // Replace the banner line with an empty string (preserving line count so
    // byte offsets elsewhere in the file are unaffected — important if a
    // future maintainer greps line numbers from a stack trace).
    lines[idx] = "";
    return { banner, body: lines.join("\n") };
}

/** Body hash for a hook file's content (sha1 over the body after the first
 *  line, truncated to HOOK_HASH_LEN). Used both for the source hook
 *  (currentHookBodyHash) and for installed hooks (installRuntimeFiles /
 *  reportStatus compare the two). */
function hookBodyHashOf(content: string): string {
    const { body } = splitHookBanner(content);
    return crypto.createHash("sha1").update(body).digest("hex").slice(0, HOOK_HASH_LEN);
}

/** Current source-hook body hash — sha1 over PROJECT_ROOT/hooks/cc-status.js
 *  body (everything after the first banner line). installRuntimeFiles and
 *  reportStatus compare this to the on-disk installed hook's body hash to
 *  detect intra-HOOK_VERSION drift. Returns null when the source hook is
 *  absent (caller treats as "skip hash check" — the copy already warned). */
function currentHookBodyHash(): string | null {
    const srcHook = path.join(PROJECT_ROOT, "hooks", "cc-status.js");
    try {
        const src = fs.readFileSync(srcHook, "utf8");
        return hookBodyHashOf(src);
    } catch {
        return null;
    }
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
        "this.__ccsdSid=e.request.sessionId,this.__ccsdTitle=e.request.title," +
        iife +
        ',this.onSessionStateChanged?.(e.request.sessionId,e.request.state,e.request.title),{type:"update_session_state_response"}';

    let next = src.replace(ANCHOR_A, replA);
    if (!next.includes(INJECT_MARKER)) fail("Anchor A replacement did not apply. No files were modified.");

    // Anchor B (optional hardening): start the same guarded timer from rename_tab too.
    if (bCount === 1) {
        // replB also refreshes this.__ccsdTitle from the live rename_tab title —
        // CC may fire rename_tab multiple times AFTER update_session_state
        // (truncation, user rename, panel title reassignment) and replA's
        // stashed value would otherwise go stale. notify() appends
        // "["+__ccsdTitle+"]" to the notification body, so keeping it fresh
        // matters for the message shown to the user.
        const replB =
            "this.panelTab.title=e.request.title;this.__ccsdTitle=e.request.title;this.__ccsdPending=!!e.request.hasPendingPermissions;" +
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

/** Inverse of injectFresh — strip our injected IIFE + the stash-field
 *  assignments we added around ANCHOR_A / ANCHOR_B from a patched
 *  extension.js. Returns the recovered original (suitable for re-inject), or
 *  null if the input doesn't match our injection shape (so callers can fall
 *  back to the baked-RES rewrite without crashing).
 *
 *  Round-4 (v0.1.15) addition: when `patchExtension` detects a stale IIFE
 *  (version or content-hash mismatch) and `extension.js.bak` is missing OR
 *  itself patched, this helper lets us recover by stripping from the CURRENT
 *  extension.js. Without this, a stale-but-no-.bak install was permanently
 *  stuck on the old IIFE body with no in-product recovery path (the user had
 *  to wait for the next CC update to reset extension.js to fresh).
 *
 *  Strategy: at each anchor we injected a single contiguous segment —
 *    anchor A: `this.__ccsdSid=…,this.__ccsdTitle=…,` + IIFE + `,`
 *              (between `return ` and `this.onSessionStateChanged`)
 *    anchor B: `this.__ccsdTitle=…;this.__ccsdPending=…;` + IIFE + `;`
 *              (between `…title=…;` and `let r`)
 *  We match each segment as ONE regex (stash + IIFE + trailing separator) so
 *  removing it leaves the original byte sequence intact. The IIFE banner is
 *  `/*cc-status-dot-injected:…*\/(function(t){…})(this)` and the body has no
 *  internal `})(this)` (setInterval/arrows close with `},N)` or `})`), so
 *  non-greedy `[\s\S]*?` to the first `})(this)` is safe.
 *
 *  Sanity checks before returning: assertCompiles + no leftover stash tokens +
 *  INJECT_MARKER-free. The caller (patchExtension) further verifies ANCHOR_A
 *  appears exactly once before trusting the result.
 *
 *  The segment patterns are pinned to the EXACT forms produced by replA /
 *  replB in injectFresh. A future refactor that changes those forms MUST
 *  update the patterns here in lockstep — the post-strip INJECT_MARKER-free
 *  check is the safety net if a pattern drifts undetected. */
function stripIifeInPlace(content: string): string | null {
    // Anchor A segment: stash fields + IIFE + trailing comma. The leading
    // `this.__ccsdSid=…` is unique to our injection (never appears in fresh
    // CC code), so a failed match here means the on-disk form is something we
    // don't recognize — bail to the safe RES-rewrite path.
    const segA =
        /this\.__ccsdSid=e\.request\.sessionId,this\.__ccsdTitle=e\.request\.title,\/\*cc-status-dot-injected:[^*]*?\*\/\(function\(t\){[\s\S]*?}\)\(this\),/g;
    // Anchor B segment: stash fields + IIFE + trailing semicolon. The leading
    // `this.__ccsdTitle=…;this.__ccsdPending=…` pair is unique to our injection.
    const segB =
        /this\.__ccsdTitle=e\.request\.title;this\.__ccsdPending=!!e\.request\.hasPendingPermissions;\/\*cc-status-dot-injected:[^*]*?\*\/\(function\(t\){[\s\S]*?}\)\(this\);/g;

    // Pre-check: at least one segment must match, otherwise this isn't ours.
    if (!segA.test(content) && !segB.test(content)) return null;
    segA.lastIndex = 0;
    segB.lastIndex = 0;

    let out = content.replace(segA, "").replace(segB, "");

    // Sanity check the result compiles (anchor shape preserved). If anything
    // looks off, return null so the caller falls through to the safe RES
    // rewrite path.
    try {
        assertCompiles(out, "stripIifeInPlace output (recovered original)");
    } catch {
        return null;
    }
    if (out.includes(INJECT_MARKER)) {
        // A segment didn't match the form we expected and an IIFE fragment
        // survived — bail.
        return null;
    }
    return out;
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
            warn(`extension.js.bak is itself patched — trying to strip IIFE from current extension.js`);
        } else {
            warn(
                `stale injected IIFE (${why}) but no extension.js.bak — trying to strip IIFE from current extension.js`,
            );
        }
        // Round-4 fallback (architecture-review fix): when .bak is missing OR
        // itself patched, recover the original by INVERTING the splice in-place
        // — strip our IIFE + the stash-field assignments we added around it.
        // If the strip yields a clean (unpatched, INJECT_MARKER-free) text with
        // the anchor intact, we feed it to injectFresh and the user gets the
        // current IIFE body. If the strip is inconclusive (unrecognized stash
        // form from a future version, or anchor shape changed), we fall through
        // to the baked-RES rewrite so the install is never left worse than
        // "stale IIFE but RES path corrected".
        const stripped = stripIifeInPlace(src);
        if (stripped !== null && !isExtensionPatched(stripped)) {
            log(`stripped stale IIFE from current extension.js — re-injecting fresh`);
            injectFresh(extJs, stripped);
            return;
        }
        warn(`could not cleanly strip IIFE from current extension.js — falling back to RES rewrite`);
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
// CC package.json — v0.1.14 residue cleanup only (no install-time patching)
// ---------------------------------------------------------------------------
// v0.1.13 patched CC's package.json to contribute 20 commands + 20
// commandCenter menu items + 20 commandPalette hide-entries; v0.1.14 removed
// that entire surface (the SBI is a single runtime createStatusBarItem, no
// package.json contribution). These two helpers remain ONLY to (1) detect a
// stale v0.1.13 patch on sight at install time (so upgrade restores the
// original package.json cleanly) and (2) back the --revert path for users
// whose last install was v0.1.13. Both rely on the marker
// `__ccStatusDotPkgManaged` that v0.1.13 stamped at the top level of CC's
// package.json — VSCode ignores unknown top-level fields (CC's own
// package.json carries `__metadata`, `capabilities`, etc.), so the marker
// never affected CC's behavior, but the contrib arrays it shipped alongside
// DID register 20 phantom commands whose handlers existed only inside the
// v0.1.13 IIFE; cleaning those up on upgrade/revert is the job here.

/** Does CC's package.json still carry the v0.1.13 commandCenter patch? Presence
 *  of the marker string === "v0.1.13-patched; restore on sight". The check is
 *  a plain substring test (no JSON parse) so a corrupt package.json still
 *  answers correctly — the caller (run() install path) then defers to
 *  restorePackageJson which DOES parse + .bak-restore. */
function isPackageJsonPatched(content: string): boolean {
    return content.includes(`"${PKG_MARKER_FIELD}"`);
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
                // Drift detection (architecture-review round-2 + round-3 hash gate):
                // assert the source hook carries the HOOK_VERSION banner we expect AND
                // that the banner's hash matches the source body hash. A version
                // mismatch is a dev error (forgot to bump the banner in cc-status.js
                // when bumping HOOK_VERSION); a hash mismatch is the intra-version
                // equivalent (edited the hook body but forgot to re-stamp the banner
                // hash). Both are surfaced loudly so the build ships self-consistent.
                // Mirrors the IIFE's INJECT_VERSION+hash gate (round-3 closes the
                // prior asymmetry where only the reader side had a hash check).
                const srcContent = fs.readFileSync(srcHook, "utf8");
                const { banner: srcBanner } = splitHookBanner(srcContent);
                const srcVer = parseHookBannerVersion(srcBanner);
                const srcBannerHash = parseHookBannerHash(srcBanner);
                const srcBodyHash = hookBodyHashOf(srcContent);
                if (srcVer === null) {
                    warn(
                        `source hooks/cc-status.js is missing the cc-status-dot-hook banner — version drift undetectable; copy proceeds but --status cannot report hook version`,
                    );
                } else if (srcVer !== HOOK_VERSION) {
                    warn(
                        `source hooks/cc-status.js banner ${srcVer} != HOOK_VERSION ${HOOK_VERSION} — bump the banner in cc-status.js to match`,
                    );
                } else if (srcBannerHash === null) {
                    warn(
                        `source hooks/cc-status.js banner ${srcVer} has no :HASH suffix — re-stamp with ${srcBodyHash} (round-3 hash scheme)`,
                    );
                } else if (srcBannerHash !== srcBodyHash) {
                    warn(
                        `source hooks/cc-status.js banner hash ${srcBannerHash} != body hash ${srcBodyHash} — hook body changed but banner not re-stamped; re-stamp the banner to match`,
                    );
                }
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
    // Surface the CC version against which the anchor strings were last
    // verified byte-exact (architecture-review round-3 finding). install does
    // NOT hard-gate against older/newer CC — the countOccurrences==1 anchor
    // check is the actual safety net — but a user inspecting --status after a
    // CC upgrade can see whether their running CC matches the verified baseline
    // or is in untested-but-anchor-stable territory. Mirrors the inline comment
    // at ANCHOR_A / ANCHOR_B ('verified byte-exact against CC X.Y.Z') by
    // lifting that constant to a user-visible line.
    if (version !== LAST_VERIFIED_CC) {
        log(
            `  last verified: ${LAST_VERIFIED_CC} (CC ${version} is untested — anchors may still match, install proceeds if countOccurrences==1)`,
        );
    } else {
        log(`  last verified: ${LAST_VERIFIED_CC} (matches)`);
    }
    const extJs = path.join(dir, "extension.js");
    const extSrc = fs.existsSync(extJs) ? fs.readFileSync(extJs, "utf8") : "";
    const patched = isExtensionPatched(extSrc);
    log(`extension.js patched: ${patched ? "YES" : "no"}`);
    if (patched) {
        // Surface anchor injection health: INJECT_MARKER appears once per
        // injection site (Anchor A always, Anchor B when present). 1 = A only
        // (the v0.1.8 permission-pending blue-dot fix is INACTIVE — a yellow
        // running dot may cover CC's native blue pending dot during a
        // permission prompt); 2 = A+B (fix active). A CC update that drifted
        // Anchor B's exact bytes leaves the user on the A-only path silently;
        // this line makes that downgrade visible in --status so the user knows
        // to re-run install after a CC update instead of discovering it via a
        // miscolored tab during a permission prompt.
        const markerN = countOccurrences(extSrc, INJECT_MARKER);
        if (markerN >= 2) {
            log(`  anchors injected: A+B (blue-dot fix ACTIVE)`);
        } else if (markerN === 1) {
            log(
                `  anchors injected: A only (blue-dot fix INACTIVE — Anchor B not found at inject time; CC update likely drifted Anchor B's exact bytes. Re-run install.)`,
            );
        } else {
            log(`  anchors injected: unexpected marker count ${markerN}`);
        }
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
    // Stale v0.1.13 commandCenter residue on CC's package.json (v0.1.14+ no
    // longer patches package.json). Detected → re-run install to clean.
    const pkgPath = path.join(dir, "package.json");
    const pkgSrc = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, "utf8") : "";
    const pkgStale = isPackageJsonPatched(pkgSrc);
    log(`package.json (v0.1.13 commandCenter residue): ${pkgStale ? "STALE — re-run install to clean" : "clean"}`);
    log(`hooks wired: ${isHooksWired() ? "YES" : "no"}`);
    // On-disk hook version + content hash (architecture-review round-2 + round-3
    // hash gate): parse the banner at the top of INSTALL_DIR/hooks/cc-status.js
    // and warn when EITHER the version differs from HOOK_VERSION OR the body
    // hash differs from the current source body hash — mirrors the IIFE's
    // stale-version + stale-hash surfacing above. A stale hook (older writer
    // contract, or same version but drifted body) against a fresh IIFE is
    // otherwise silent feature loss; these lines surface it so the user knows
    // to re-run install. Round-3 closes the round-2 asymmetry: reader had a
    // hash check, writer did not.
    const installedHook = path.join(INSTALL_DIR, "hooks", "cc-status.js");
    if (fs.existsSync(installedHook)) {
        try {
            const hdr = fs.readFileSync(installedHook, "utf8");
            const { banner: insBanner } = splitHookBanner(hdr);
            const insVer = parseHookBannerVersion(insBanner);
            const insHash = parseHookBannerHash(insBanner);
            const insBodyHash = hookBodyHashOf(hdr);
            const wantHash = currentHookBodyHash();
            if (insVer === null) {
                log(`  hook script: (no version banner — pre-v0.1.14 or hand-edited; re-run install)`);
            } else if (insVer !== HOOK_VERSION) {
                log(
                    `  hook script: ${insVer} (STALE — expected ${HOOK_BANNER_PREFIX}${HOOK_VERSION}; re-run to refresh)`,
                );
            } else if (insHash === null) {
                log(`  hook script: ${insVer} hash (pre-hash-scheme — STALE; re-run install to stamp ${insBodyHash})`);
            } else if (wantHash !== null && insBodyHash !== wantHash) {
                log(
                    `  hook script: ${insVer} hash ${insHash} (STALE — body ${insBodyHash} != source ${wantHash}; re-run to refresh)`,
                );
            } else {
                log(`  hook script: ${insVer} hash ${insHash} (up to date)`);
            }
        } catch {
            log(`  hook script: (unreadable — ${INSTALL_DIR}/hooks/cc-status.js)`);
        }
    } else {
        log(`  hook script: (not installed — re-run install)`);
    }
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
            "  vscode-claude-code-status-dot --revert   restore extension.js + package.json (cleans v0.1.13 commandCenter residue + legacy v0.1.2 webview), remove hooks + runtime copy",
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
    // Auto-clean: v0.1.13 left a commandCenter patch (20 commands + 20 menu
    // items + 20 palette hides) on CC's package.json. v0.1.14 removed that
    // surface (the SBI is a single runtime createStatusBarItem, no package.json
    // contribution). If we detect the v0.1.13 marker, restore package.json
    // from .bak before patching. Users upgrading from v0.1.13 just re-run
    // `npx vscode-claude-code-status-dot` and the residue is cleaned for them
    // — no manual --revert needed.
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath) && isPackageJsonPatched(fs.readFileSync(pkgPath, "utf8"))) {
        log("detected stale v0.1.13 commandCenter patch in package.json — removing");
        restorePackageJson(dir);
    }
    patchExtension(dir);
    // (v0.1.14: no patchPackageJson — the SBI is a runtime createStatusBarItem,
    //  no package.json contribution. --revert still cleans any residue.)
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
