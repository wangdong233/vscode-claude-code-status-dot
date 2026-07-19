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

/** Version stamped into the injected IIFE banner comment. Bump whenever the
 *  IIFE *logic* changes (NOT just the baked RES path). On install, if the
 *  marker is present but the stamped version differs from this const,
 *  patchExtension restores extension.js from .bak and re-injects the current
 *  IIFE — otherwise structural changes would be silently swallowed because
 *  the bare marker still matches. The content-hash suffix (STAMP_HASH_LEN)
 *  additionally catches intra-version drift.
 *
 *  Version-by-version rationale lives in CHANGELOG.md; SBI visual-design
 *  rationale lives in docs/STATES.md §7. Keep this JSDoc to purpose + bump
 *  rule so the two narratives don't drift apart. */
const INJECT_VERSION = "v0.2.0";

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
 *  patchExtension detects a stale IIFE.
 *
 *  Historical rationale: writer/reader drift detection was asymmetric — the
 *  reader side was hash-stamped and auto-reinjected, the writer side was
 *  copied verbatim with NO version check, so a user running an old hook
 *  against a new IIFE (e.g. the install copied the IIFE but the hook copy
 *  failed silently, or the user hand-edited
 *  INSTALL_DIR/hooks/cc-status.js) saw silent feature loss with no warning.
 *  MUST be kept in lockstep with the banner at the top of
 *  hooks/cc-status.js. */
const HOOK_VERSION = "v0.1.14";
const HOOK_BANNER_PREFIX = "cc-status-dot-hook:";

/** CC extension version against which the anchor strings (ANCHOR_A / ANCHOR_B)
 *  were last verified byte-exact. Historical rationale: the
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
 *  installRuntimeFiles + --status.
 *
 *  Historical rationale: a prior round added a writer version banner +
 *  version-string check, but the reader side had content-hash and the writer
 *  side did NOT — asymmetric drift detection. A dev who edited
 *  hooks/cc-status.js and forgot to bump the banner would have the patcher
 *  silently overwrite an installed hook whose body differed, no warn. The
 *  hash closes that gap: install compares BOTH version AND body hash,
 *  --status surfaces either drift. */
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
// SBI 4-light definitions (visual rationale: see docs/STATES.md §7 + CHANGELOG.md)
// ---------------------------------------------------------------------------

/** v0.2.0 — companion VS Code extension (NOT published to Marketplace; shipped
 *  inside this npm package as dist/cc-status-dot-companion-<ver>.vsix and
 *  installed into the user's VS Code via `code --install-extension` at install
 *  time). The companion watches CC auto-updates and re-applies this patcher
 *  automatically, so the user no longer needs to re-run
 *  `npx vscode-claude-code-status-dot` after every CC release.
 *
 *  - Id (publisher.name) used by every `code --install-extension` / uninstall
 *    command. MUST match companion/package.json's `publisher.name`.
 *  - VSIX_FILE is the relative path from PROJECT_ROOT to the prebuilt .vsix
 *    (produced by `npm run companion:package`). The filename is derived from
 *    companion/package.json's `version` so the patcher never has a stale
 *    version literal locked in — single source of truth is the .json. If the
 *    companion package.json can't be read (rare — corrupt install), we fall
 *    back to a hardcoded version constant so install still surfaces SOMETHING.
 *  - COMPANION_VERSION is the parsed version string; used for surfacing in
 *    --status and for the --force downgrade guard. */
const COMPANION_EXT_ID = "wangdong.cc-status-dot-companion";
const COMPANION_VERSION = (() => {
    // Single source of truth: companion/package.json. Read at runtime so a
    // version bump in companion/package.json flows everywhere automatically
    // (vsix filename + --status + downgrade guard + log lines).
    try {
        const p = path.join(PROJECT_ROOT, "companion", "package.json");
        const meta = JSON.parse(fs.readFileSync(p, "utf8")) as { version?: string };
        if (meta.version && /^\d+\.\d+\.\d+/.test(meta.version)) return meta.version;
    } catch {
        // fall through — corrupt or missing companion/package.json
    }
    // Last-resort fallback so the patcher never hard-fails on a missing
    // companion manifest. Bump this only when bumping the minimum supported
    // companion shape; the manifest above stays authoritative at runtime.
    return "0.2.0";
})();
const COMPANION_VSIX = `dist/cc-status-dot-companion-${COMPANION_VERSION}.vsix`;

/** This patcher's own version — single source of truth is the top-level
 *  package.json (`version` field). Read at runtime so a bump in package.json
 *  flows everywhere automatically. Used to stamp `INSTALL_DIR/companion-config.json`
 *  + `INSTALL_DIR/last-repatch.json` so the companion can detect a stale
 *  `INSTALL_DIR/patch.js` snapshot (the copy is taken once at install time and
 *  is NOT refreshed by `npm install -g vscode-claude-code-status-dot@latest`
 *  alone — only re-running the bin copies the new patch.js). The companion
 *  reads `patcherVersion` from companion-config.json and compares it to its
 *  own MIN_PATCHER_VERSION constant; if older, it warns the user to re-run
 *  `npx vscode-claude-code-status-dot`. */
const PATCHER_VERSION = (() => {
    try {
        const p = path.join(PROJECT_ROOT, "package.json");
        const meta = JSON.parse(fs.readFileSync(p, "utf8")) as { version?: string };
        if (meta.version && /^\d+\.\d+\.\d+/.test(meta.version)) return meta.version;
    } catch {
        // fall through — corrupt or missing top-level package.json
    }
    // Last-resort fallback. Bump only when bumping the package version itself.
    return "0.2.0";
})();

/** Path of the JSON config the patcher writes into INSTALL_DIR at install time
 *  so the companion can read its constants (INSTALL_DIR / INJECT_MARKER /
 *  INJECT_VERSION / SEARCH_DIRS / ccExtIdPrefix / patchJsPath / patcherVersion)
 *  from one place instead of hand-mirroring them in companion/extension.ts.
 *  Decouples the companion's build cadence from the patcher's internals — a
 *  future patch.ts that adds a new VS Code flavor to SEARCH_DIRS no longer
 *  requires shipping a new .vsix; the next `npx` run refreshes the config and
 *  the already-installed companion picks it up. */
const COMPANION_CONFIG_PATH = path.join(INSTALL_DIR, "companion-config.json");

/** Path of the JSON "repatch flag" the patcher writes after every successful
 *  --patch-only run (so the companion that did the patch writes it, AND so do
 *  subsequent companion runs in OTHER VS Code windows / a manual `npx` run).
 *  Companion instances in other still-running VS Code windows poll this file's
 *  embedded `ts` field; when it advances past what they last saw AND the
 *  `extDir` matches their own CC install, they prompt the user to reload —
 *  closing the "Window 2/3 still have stale CC memory after Window 1 patched"
 *  gap. */
const LAST_REPATCH_PATH = path.join(INSTALL_DIR, "last-repatch.json");

/** Marker stamped into CC's package.json by the abandoned v0.1.13 commandCenter
 *  patch. Kept only so install can DETECT stale v0.1.13 residue (and --revert
 *  can clean it) — v0.1.14+ no longer writes this field. */
const PKG_MARKER_FIELD = "__ccStatusDotPkgManaged";

/** The 4 lights, in fixed left→right display order. Each entry pins the
 *  light's "on" emoji ball. This table is the SINGLE source of truth consumed
 *  by buildIIFE (baked into the IIFE's `var CFG=[...]` via JSON.stringify)
 *  and mirrored in test-iife.mjs. Renaming an emoji codepoint or reordering
 *  lights here changes both the IIFE bytes and the test assertions in lockstep.
 *
 *  v0.1.17 dropped the v0.1.15/v0.1.16 `pri` field: the 4 lights render
 *  inside ONE window-scoped StatusBarItem (single-SBI concatenated text
 *  `<ball><digit><space><ball><digit>...`, see buildIIFE's per-tick join —
 *  VSCode's per-SBI CSS `margin:0 3px;padding:0 5px` makes a 4-SBI row look
 *  ~16px loose, uncontrollable via the public API). The single SBI's priority
 *  is pinned by the sibling SBI_PRIORITY constant. Position stability (digits
 *  never shift the row) comes from VSCode's `statusbarpart.css` forcing
 *  `font-variant-numeric:tabular-nums` on every statusbar item — ASCII digits
 *  0-9 render at equal width regardless of font, so count 0→1→2→3→N keeps the
 *  row byte-stable as long as the surrounding emoji are equal-width too.
 *
 *  SBI_DIM_EM is ⚪ (U+26AA, Miscellaneous Symbols) — v0.2.0 reverted the
 *  v0.1.17 ⚪→🟤 pivot because the user prefers gray over brown (commit
 *  55e18b4). The 5 balls therefore span 3 Unicode blocks again
 *  (🟢🟡 Geometric Shapes Extended / 🔴🔵 Miscellaneous Symbols And
 *  Pictographs / ⚪ Miscellaneous Symbols). Theoretical cross-block width
 *  risk is the trade-off for the gray visual —实测 modern emoji fonts (Apple
 *  Color Emoji / Noto Color Emoji / Segoe UI Emoji) render every emoji at
 *  1em square regardless of block, so the risk is latent rather than
 *  observable on mainstream fonts. The v0.1.17 ⚪→🟤 pivot's "guarantee
 *  equal width by Unicode-block allocation" argument is no longer in effect;
 *  see docs/STATES.md §7.5 for the v0.1.17 → v0.2.0 trail (pivot then
 *  revert).
 *
 *  Emoji escapes: patch.ts SOURCE stays ASCII-only (`\u{XXXX}`); the baked
 *  IIFE bytes do NOT — JSON.stringify embeds literal emoji chars. ⚪ is a BMP
 *  codepoint (single UTF-16 code unit), while 🟢🟡🔵🔴 are astral (surrogate
 *  pairs). VSCode loads extension.js as UTF-8 and recovers the emoji at
 *  parse time. Do NOT "fix" JSON.stringify to emit escapes: changing the IIFE
 *  bytes would shift the content hash and force unnecessary re-injects.
 *
 *  Visual-design rationale (why emoji balls vs ThemeColor blocks, why these
 *  4 codepoints, why single-SBI concat vs v0.1.16 4-SBI): see docs/STATES.md §7. */
const SBI_LIGHTS_CFG: ReadonlyArray<{ key: string; em: string }> = [
    { key: "done", em: "\u{1F7E2}" }, // 🟢 leftmost
    { key: "running", em: "\u{1F7E1}" }, // 🟡
    { key: "pending", em: "\u{1F535}" }, // 🔵
    { key: "interrupted", em: "\u{1F534}" }, // 🔴 rightmost
];

/** Priority of the single v0.1.17 StatusBarItem (StatusBarAlignment.Left).
 *  Replaces the v0.1.15/v0.1.16 per-light `pri` field that used to live in
 *  SBI_LIGHTS_CFG. -9996 keeps the SBI rightmost among Left items (closest
 *  to the visible center), matching the v0.1.16 leftmost-done priority so
 *  the SBI's screen position is preserved across the 4-SBI → 1-SBI pivot
 *  (the user's "位置固定" requirement covers BOTH per-light slot position
 *  AND whole-bar position — this const holds the latter). */
const SBI_PRIORITY = -9996;

/** Dim/zero emoji — used in place of any light's colored ball when its count
 *  is 0. Paired with digit "0" so the slot width at zero matches the non-zero
 *  width exactly (ball + 1 digit) — the position-stability guarantee (the
 *  4-SBI row never shifts when counts change). Baked into the IIFE as
 *  `var DIM_EM=<JSON.stringify(SBI_DIM_EM)>`. Visual rationale + baking
 *  discipline: see SBI_LIGHTS_CFG above + docs/STATES.md §7.
 *
 *  History: ⚪ (U+26AA, BMP) — v0.1.17 pivoted to 🟤 (U+1F7E4, Geometric
 *  Shapes Extended, same block as 🟢🟡) to retire a theoretical cross-block
 *  width gamble; v0.2.0 reverted to ⚪ (commit 55e18b4) because the user
 *  prefers gray over brown. The cross-block width argument is now latent
 *  rather than enforced (modern emoji fonts render every emoji at 1em square
 *  regardless of block, so the practical risk is zero on mainstream fonts).
 *  See docs/STATES.md §7.5 for the full v0.1.17 → v0.2.0 trail. */
const SBI_DIM_EM = "\u{26AA}"; // ⚪ (white/gray medium circle; user prefers gray over brown)

/** The SBI click-command id. Registered at runtime via
 *  vs.commands.registerCommand (no package.json contribution needed for
 *  registerCommand). Single source of truth — baked into the IIFE at the
 *  registerCommand site AND assigned to the single v0.1.17 StatusBarItem's
 *  `.command` field via ${JSON.stringify(SBI_CLICK_CMD)} (v0.1.14-v0.1.16
 *  assigned it to EACH of 4 SBIs), and mirrored in test-iife.mjs.
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
function skipWsAndComments(raw: string, i: number): number {
    while (i < raw.length) {
        const c = raw[i];
        const next = raw[i + 1];
        if (/\s/.test(c)) {
            i += 1;
            continue;
        }
        if (c === "/" && next === "/") {
            while (i < raw.length && raw[i] !== "\n") i += 1;
            continue;
        }
        if (c === "/" && next === "*") {
            i += 2;
            while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i += 1;
            i += 2;
            continue;
        }
        break;
    }
    return i;
}

function stripJsonc(text: string): string {
    // Single-pass scanner: copies every byte that isn't a // or /* */ comment
    // verbatim, while tracking `inString` so a `,}` or `,]` SEQUENCE INSIDE A
    // STRING (e.g. a regex char class `[,}]` or a JSON one-liner arg) is NEVER
    // mistaken for JSON syntax. The trailing-comma tolerance is done INLINE
    // (not as a post-pass regex) precisely because a post-pass regex was a
    // silent-corruption bug: it operated on the full flattened output, blind
    // to string boundaries, so any user settings.json string holding `,}` or
    // `,]` had its comma dropped at parse time and was then persisted back to
    // disk via both the surgical-splice and round-trip write paths.
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
// Surgical JSONC editor
// ---------------------------------------------------------------------------
// The pre-fix wireHooks/unwireHooks used a parse-mutate-stringify round-trip
// that DROPPED user // and /* */ comments and reformatted the entire file.
// Users who keep notes / section headers in settings.json lost them on every
// install + every re-wire triggered by a hook-command change. These helpers
// locate the byte range of ONE top-level key's value and let us splice just
// that range, leaving the rest of the file byte-for-byte identical.
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
// ---------------------------------------------------------------------------

/**
 * Scan one JSON value starting at offset `start` in `raw`. Returns the offset
 * JUST PAST the value's last character (so raw.slice(start, end) is the value
 * including its delimiters). Handles objects, arrays, strings, numbers, true,
 * false, null, and skips // and /* *​/ comments inside composite values.
 */
function scanJsonValueEnd(raw: string, start: number): number {
    // Skip leading whitespace + comments (canonical helper — DRY across the
    // 7+ sites that previously inlined this scan).
    const valueStart = skipWsAndComments(raw, start);
    let i = valueStart;
    if (i >= raw.length) return i;
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
                if (c === quote) inString = false;
                i += 1;
                continue;
            }
            if (c === "/" && next === "/") {
                while (i < raw.length && raw[i] !== "\n") i += 1;
                continue;
            }
            if (c === "/" && next === "*") {
                i += 2;
                while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i += 1;
                i += 2;
                continue;
            }
            if (c === '"' || c === "'") {
                inString = true;
                quote = c;
                i += 1;
                continue;
            }
            if (c === "{" || c === "[") depth += 1;
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
    while (i < raw.length && !/[,\]\}]/.test(raw[i])) i += 1;
    return i;
}

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
interface KeyRange {
    keyStart: number;
    keyEnd: number;
    colon: number;
    valueStart: number;
    valueEnd: number;
}
function findTopLevelKey(raw: string, key: string): KeyRange | null {
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
            if (c === quote) inString = false;
            i += 1;
            continue;
        }
        if (c === "/" && next === "/") {
            while (i < raw.length && raw[i] !== "\n") i += 1;
            continue;
        }
        if (c === "/" && next === "*") {
            i += 2;
            while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i += 1;
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
    if (depth !== 1) return null; // no root object
    // Walk the top-level object's members.
    while (i < raw.length) {
        const c = raw[i];
        const next = raw[i + 1];
        if (inString) {
            if (c === "\\") {
                i += 2;
                continue;
            }
            if (c === quote) inString = false;
            i += 1;
            continue;
        }
        if (c === "/" && next === "/") {
            while (i < raw.length && raw[i] !== "\n") i += 1;
            continue;
        }
        if (c === "/" && next === "*") {
            i += 2;
            while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i += 1;
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
            if (raw[i] === ",") i += 1;
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
function surgicalSetTopLevelKey(raw: string, key: string, valueJson: string): string {
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
function surgicalRemoveTopLevelKey(raw: string, key: string): string {
    const range = findTopLevelKey(raw, key);
    if (!range) return raw;
    // We need to remove the key token + colon + value + trailing comma (if any).
    // Start from keyStart; end at valueEnd, then consume any trailing comma
    // (skipping ws + comments via the canonical helper).
    const end = skipWsAndComments(raw, range.valueEnd);
    let consume = end;
    if (raw[consume] === ",") consume += 1;
    // Also trim trailing whitespace on the value's line so we don't leave a
    // dangling blank line. Walk start backward to include the key's leading
    // newline (if present) so we don't leave a blank line above either.
    let start = range.keyStart;
    // Walk backward over whitespace but stop at a newline boundary so we eat
    // the indentation + the preceding newline (cleaner result).
    while (start > 0 && /[ \t]/.test(raw[start - 1])) start -= 1;
    if (start > 0 && raw[start - 1] === "\n") start -= 1;
    return raw.slice(0, start) + raw.slice(consume);
}

// ---------------------------------------------------------------------------
// Extension discovery — find the highest-version anthropic.claude-code-* dir
// ---------------------------------------------------------------------------

/** Compare two `X.Y.Z` (or `X.Y`, or any segment count) version strings.
 *  Returns >0 if a>b, <0 if a<b, 0 if equal. Numeric per-segment comparison
 *  (not lexical). Missing segments on either side are treated as 0.
 *
 *  Canonical helper for ALL semver comparisons in this file + the companion
 *  (companion/extension.ts has its own cmpVerStr that MIRRORS this body —
 *  keep them in lockstep; the companion compiles standalone into a .vsix so
 *  it cannot import from patch.ts at runtime). A future 4-segment or
 *  pre-release-tag change touches ONE function (this one) + the mirror. */
function cmpSemver(a: string, b: string): number {
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

function cmpVerStr(a: string, b: string): number {
    // Thin wrapper around cmpSemver — kept as a local alias so existing call
    // sites stay readable; the canonical helper name is cmpSemver.
    return cmpSemver(a, b);
}

function cmpVer(a: number[], b: number[]): number {
    // Compare semver-style numeric arrays component-wise, treating a missing
    // component as 0 (so [1,2] === [1,2,0]). Robust to future 4-segment
    // version schemes without a magic count; coupled to but not hard-tied to
    // the 3-capture regex in discoverExtension. Uses the same per-segment
    // logic as cmpSemver (canonical comparator) — kept as a number[]-flavored
    // alias because discoverExtension already parses versions into number[]s
    // at scan time and a round-trip through string join/split would be silly.
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
//   Reads ~/.claude/cc-tab-status/<sid>.json -> {state, since, error?, pending?}
//   References ZERO minified identifiers — only `require("fs"|"path"|"vscode"|"os")`,
//   `this`, and `Date`. The only version-sensitive surface is the two anchor
//   strings (ANCHOR_A / ANCHOR_B).
//
//   Architecture + design rationale:
//     - Per-tab state machine (running/done/interrupted/idle SVG mapping,
//       done>5min→idle fallback, __ccsdPending yield, notify dedup keyed on
//       terminal `since`, macOS osascript + VSCode fallback): docs/STATES.md
//       §1/§4/§4b + docs/DESIGN-injection.md §2/§4.2.
//     - SBI aggregation (v0.1.17: ONE window-scoped StatusBarItem rendering
//       4 lights as concatenated `<ball><digit>` text at 0px gap; v0.1.15/
//       v0.1.16 used 4 independent SBIs but VSCode's statusbarpart.css
//       `margin:0 3px;padding:0 5px` per item makes a 4-SBI row look ~16px
//       loose, uncontrollable via public API. Position stability comes from
//       VSCode's `font-variant-numeric:tabular-nums` on every statusbar item,
//       which forces ASCII digits 0-9 to equal advance width), §4 decay
//       rules applied for counting, pending counted independently of state,
//       singleton timer + panel-counter lifecycle, 3-layer try/catch
//       isolation, __ccsd* prefix): docs/STATES.md §7 + docs/DESIGN-injection.md.
//     - Version history (v0.1.11 aggregation refactor → v0.1.12 isolation →
//       v0.1.13 commandCenter → v0.1.14 SBI pivot → v0.1.15 4-SBI split →
//       v0.1.16 emoji-ball restoration → v0.1.17 single-SBI compact concat):
//       CHANGELOG.md.
// ---------------------------------------------------------------------------

function buildIIFE(resDir: string): string {
    // JSON.stringify yields a safely-quoted, escaped JS string literal for the path
    // (also handles the non-ASCII chars in the project path correctly).
    const resLiteral = JSON.stringify(resDir);
    // SBI 4-light config table baked into the IIFE as a JSON-stringified array
    // literal. v0.1.17 dropped the v0.1.15/v0.1.16 `pri` field (the 4 lights
    // now render in ONE SBI; the per-light priority became dead data — see
    // SBI_LIGHTS_CFG + SBI_PRIORITY JSDoc above). Each entry pins only the
    // light's "on" emoji ball. Patch.ts SOURCE is ASCII-only (emoji as
    // `\u{XXXX}` escapes); the baked IIFE bytes are NOT — JSON.stringify
    // embeds literal emoji chars, not `\uXXXX` escapes, so the on-disk IIFE
    // contains literal UTF-8 emoji bytes. VSCode loads as UTF-8 and recovers
    // the emoji at parse time. SBI_LIGHTS_CFG is the SINGLE source of truth
    // (patch.ts); the IIFE's per-tick loop iterates CFG[k] for {key,em}.
    // Order matches aggregation output: done/running/pending/interrupted
    // (left→right in concatenated text).
    const cfgLiteral = JSON.stringify(SBI_LIGHTS_CFG);
    // dim/zero emoji (⚪ U+26AA since v0.2.0, which reverted the v0.1.17 ⚪→🟤
    // pivot — see SBI_DIM_EM JSDoc) baked as a JSON-stringified string
    // literal — used by the per-tick loop for any light whose count is 0
    // (dim ball + digit "0", keeping the slot width fixed). Same baking
    // discipline as cfgLiteral: patch.ts SOURCE is ASCII-only, the baked IIFE
    // contains literal UTF-8 emoji bytes (see cfgLiteral above).
    const dimEmLiteral = JSON.stringify(SBI_DIM_EM);
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
        `/*SBI panel counter: bumped per IIFE entry; the onDidDispose teardown decrements and disposes the single v0.1.17 SBI on last-panel-out.*/`,
        `globalThis.__ccsdPanelCount=(globalThis.__ccsdPanelCount||0)+1;`,
        `var fs=require("fs"),pth=require("path"),vs=require("vscode"),os=require("os");`,
        `var DIR=pth.join(os.homedir(),".claude","cc-tab-status");`,
        `var RES=${resLiteral};`,
        `var CC_DEFAULT=pth.join(t.context.extensionPath,"resources","claude-logo.svg");`,
        `var DONE_TO_IDLE_MS=5*60*1000;`,
        `/*§7.2 stale-running heuristic: running files get tool heartbeats, so mtime>SBI_RUNNING_STALE_MS→idle (crashed session whose SessionEnd never fired).*/`,
        `var SBI_RUNNING_STALE_MS=30*60*1000;`,
        /*§7.5 interrupted retention: crashed/killed CC sessions whose writer wrote
         state=interrupted never send SessionEnd, so without a retention heuristic
         the 🔴 light would grow monotonically. Decay interrupted files older
         than 24h to idle for COUNTING but keep the file on disk (diagnostic
         value preserved — see docs/STATES.md §7.5). 24h >> SBI_RUNNING_STALE_MS
         (30min) because interrupted is a terminal state the user may want to
         inspect long after the fact.*/
        `var INTERRUPTED_RETENTION_MS=24*60*60*1000;`,
        // SBI 4-light config table — baked from SBI_LIGHTS_CFG via JSON.stringify.
        // v0.1.17 dropped the v0.1.15/v0.1.16 `pri` field (single SBI uses one
        // SBI_PRIORITY const; per-light priority became dead data). Each entry
        // now pins only the light's "on" emoji ball. See SBI_LIGHTS_CFG JSDoc
        // above + docs/STATES.md §7. Indexes match counts[] below: k=0 done /
        // k=1 running / k=2 pending / k=3 interrupted.
        `var CFG=${cfgLiteral};`,
        // Dim/zero emoji (shared across all 4 lights). Paired with digit "0"
        // the slot width stays `<ball><1-digit>` regardless of count (position
        // stability). See SBI_DIM_EM JSDoc + docs/STATES.md §7.
        `var DIM_EM=${dimEmLiteral};`,
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
        `/*macOS: osascript system notification; fall through to VSCode message on async/sync failure. Both escMsg and escSnd escape " and \\ so a malicious settings.json cannot break or inject AppleScript.*/`,
        `if(os.platform()==="darwin"){var snd=c.get("notifySound","Glass");var escSnd=(""+snd).replace(/["\\\\]/g,function(c){return "\\\\"+c;});var sndStr=escSnd?(' sound name "'+escSnd+'"'):'';var escMsg=(""+msg).replace(/["\\\\]/g,function(c){return "\\\\"+c;});var vsMsg=function(){if(sev==="info")vs.window.showInformationMessage(msg);else vs.window.showWarningMessage(msg);};try{require("child_process").execFile("osascript",["-e",'display notification "'+escMsg+'" with title "Claude Code"'+sndStr],function(err){if(err)vsMsg()})}catch(e){vsMsg()}}`,
        `else{if(sev==="info")vs.window.showInformationMessage(msg);else vs.window.showWarningMessage(msg);}`,
        `}`,
        // SBI click command — ONE runtime-registered command wired to the
        // single v0.1.17 SBI (v0.1.14-v0.1.16 used to wire it to all 4 SBIs).
        // Idempotent across panels via __ccsdSbiCmdRegistered; registerCommand
        // throws on re-registration so the whole block is wrapped in try/catch.
        // Handler reads __ccsdSbi.tooltip (the single SBI carries the breakdown).
        `try{if(!globalThis.__ccsdSbiCmdRegistered){globalThis.__ccsdSbiCmdRegistered=true;try{vs.commands.registerCommand(${JSON.stringify(SBI_CLICK_CMD)},function(){try{if(globalThis.__ccsdSbi)vs.window.showInformationMessage(globalThis.__ccsdSbi.tooltip||"cc-status-dot")}catch(e){}})}catch(e){}}}catch(e){}`,
        // v0.1.17 SINGLE StatusBarItem creation. Replaces the v0.1.15/v0.1.16
        // 4-SBI creation loop (4 independent SBIs at priority -9996..-9999
        // looked loose because VSCode's statusbarpart.css hardcodes
        // `margin:0 3px;padding:0 5px` per item → ~6-16px inter-SBI gap that
        // NO public API can compress; the internal IStatusbarEntryLocation.compact
        // flag is not reachable from extension code). v0.1.17 renders the 4
        // lights inside ONE SBI as concatenated text `<ball><digit> `×4 (one
        // space between tokens since v0.1.18 — see per-tick join below).
        // Position-stability (digits never shift the row on count change) is
        // guaranteed by VSCode's own statusbarpart.css
        // `font-variant-numeric:tabular-nums`, which forces ASCII digits 0-9
        // to equal advance width regardless of font.
        // Wrapped in try/catch (isolation layer 1 of 3 — see docs/STATES.md §7.5).
        `try{if(!globalThis.__ccsdSbi){try{var sbi=vs.window.createStatusBarItem(vs.StatusBarAlignment.Left,${SBI_PRIORITY});sbi.name="CC Status";sbi.text=DIM_EM+"0"+DIM_EM+"0"+DIM_EM+"0"+DIM_EM+"0";sbi.tooltip="Claude Code: 0 done, 0 running, 0 pending, 0 interrupted";try{sbi.command=${JSON.stringify(SBI_CLICK_CMD)}}catch(e){};sbi.show();globalThis.__ccsdSbi=sbi;globalThis.__ccsdSbiLastKey=null;}catch(e){}}}catch(e){}`,
        `try{if(!globalThis.__ccsdSbiTimer){globalThis.__ccsdSbiTimer=setInterval(function(){`,
        `try{`,
        `var ag={running:0,done:0,interrupted:0,idle:0,pending:0};`,
        `try{`,
        `var files=fs.readdirSync(DIR);`,
        // mtime+size cache short-circuit: the writer uses atomic tmp+rename, so
        // (mtimeMs,size) is a reliable content-change signal. Stat first, only
        // readFileSync+JSON.parse if mtime/size differ from the cached entry.
        // Bounds per-tick sync I/O when STATE_DIR has many files; same-process
        // multi-window shares globalThis so the scan is computed ONCE. Cache
        // entries for deleted files are pruned below (bounded by unique names
        // ever seen). Self-heals within TICK_MS if a cross-process write lands
        // between our statSync and readFileSync.
        `var __cc=globalThis.__ccsdAgCache;if(!__cc){__cc=globalThis.__ccsdAgCache=Object.create(null);}var __stale=Object.create(null);`,
        `for(var i=0;i<files.length;i++){`,
        `if(!files[i].endsWith(".json"))continue;`,
        `try{`,
        `var fp=pth.join(DIR,files[i]);__stale[files[i]]=true;`,
        `var __mt=0,__sz=0;try{var __s=fs.statSync(fp);__mt=__s.mtimeMs;__sz=__s.size;}catch(e3){}`,
        `var __e=__cc[files[i]];`,
        `var j=(__e&&__e.mt===__mt&&__e.sz===__sz)?__e.j:JSON.parse(fs.readFileSync(fp,"utf8"));`,
        `if(!__e||__e.mt!==__mt||__e.sz!==__sz){__cc[files[i]]={j:j,mt:__mt,sz:__sz};}`,
        `var st=j.state;var since=j.since;`,
        `/*§4 reader rule: done>5min→idle — IDLE sessions don't count toward the green light.*/`,
        `if(st==="done"&&since&&(Date.now()-since)>DONE_TO_IDLE_MS){st="idle";}`,
        `/*§7.2 stale-running: mtime>SBI_RUNNING_STALE_MS→idle (running files get tool heartbeats; old mtime=crashed session).*/`,
        `else if(st==="running"){var mt=0;try{mt=fs.statSync(fp).mtimeMs}catch(e2){}if(mt&&(Date.now()-mt)>SBI_RUNNING_STALE_MS){st="idle";}}`,
        `/*§7.5 interrupted retention: mtime>INTERRUPTED_RETENTION_MS(24h)→idle — bounds 🔴 growth from abandoned crashes. File is NOT deleted (diagnostic value preserved).*/`,
        `else if(st==="interrupted"){var mt=0;try{mt=fs.statSync(fp).mtimeMs}catch(e2){}if(mt&&(Date.now()-mt)>INTERRUPTED_RETENTION_MS){st="idle";}}`,
        `if(st==="running")ag.running++;`,
        `else if(st==="done")ag.done++;`,
        `else if(st==="interrupted")ag.interrupted++;`,
        `/*catch-all idle bucket: any unknown/corrupt state is normalized to idle so the pending check below treats it consistently (a corrupt file cannot be "not yellow" yet "still blue").*/`,
        `else{st="idle";ag.idle++;}`,
        `/*pending is counted INDEPENDENTLY of state (a session can be running AND pending). Skip when st was downgraded to idle above so a stale crashed-mid-prompt session does not false-stick 🔵 forever.*/`,
        `if(j.pending===true&&st!=="idle")ag.pending++;`,
        `}catch(e){}`,
        `}`,
        // Prune orphaned cache entries (files unlinked by writer GC since the
        // last tick). O(N) JS-object iteration; bounded by unique names seen.
        `try{var __ks=Object.keys(__cc);for(var k=0;k<__ks.length;k++){if(!__stale[__ks[k]]){delete __cc[__ks[k]];}}}catch(e){}`,
        `}catch(e){}`,
        `/*cap each light's count at 4 so the "N" variant displays for >=4.*/`,
        `var cap=function(n){return n>=4?4:n;};`,
        `var cd=cap(ag.done),cr=cap(ag.running),cp=cap(ag.pending),ci=cap(ag.interrupted);`,
        // counts[] indexes match CFG[]: done/running/pending/interrupted.
        // Per-SBI render: (n===0?DIM_EM:CFG[k].em)+(n>=4?"N":""+n). NO
        // backgroundColor / color field — the emoji ball carries its own color.
        // See docs/STATES.md §7 for the full render rule.
        `var counts=[cd,cr,cp,ci];`,
        `/*tooltip carries the UNcapped breakdown so the user sees actual counts even when lights cap at N.*/`,
        `var tip="Claude Code: "+ag.done+" done, "+ag.running+" running, "+ag.pending+" pending, "+ag.interrupted+" interrupted";`,
        // v0.1.17 per-tick SBI update: concatenate 4 (ball+digit) tokens into
        // ONE text string assigned to the single SBI. v0.1.18 changed the
        // join from `""` to `" "` (single space) for token-to-token visual
        // separation; the tabular-nums CSS still keeps digits equal-width so
        // count changes don't shift the row. Replaces the v0.1.16 per-iteration
        // try/catch loop over __ccsdSbis (no longer needed — there's only one
        // SBI; a per-token failure would only corrupt a locally-scoped string,
        // not a global StatusBarItem reference). Preserves the lastKey memo
        // short-circuit keyed on the UNcapped aggregation tuple (steady-state
        // IPC writes drop from ~40/s to 0).
        // Per-token render rule (unchanged from v0.1.16):
        //   txt += (n===0 ? DIM_EM : CFG[k].em) + (n>=4 ? "N" : ""+n)
        // → "🟢3 🟡1 ⚪0 ⚪0" (v0.1.18 space-separated; ⚪ since v0.2.0
        //   reverted the ⚪→🟤 pivot back to gray)
        //   was v0.1.16 "🟢3" / "🟡1" / "⚪0" / "⚪0" as 4 separate SBI texts.
        `try{if(globalThis.__ccsdSbi){var key=ag.done+","+ag.running+","+ag.pending+","+ag.interrupted;if(key!==globalThis.__ccsdSbiLastKey){globalThis.__ccsdSbiLastKey=key;var parts=[];for(var k=0;k<CFG.length;k++){var n=counts[k];parts.push((n===0?DIM_EM:CFG[k].em)+(n>=4?"N":""+n));}globalThis.__ccsdSbi.text=parts.join(" ");globalThis.__ccsdSbi.tooltip=tip;globalThis.__ccsdSbi.show();}}}catch(e){}`,
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
        `/*release this panel's 500ms tick + closed-over refs on panel close; on LAST panel out also clear the SBI singleton timer + dispose the single v0.1.17 SBI so the bottom bar can't freeze on a stale count. (v0.1.15/v0.1.16 used to loop over the 4-element __ccsdSbis array — gone with the pivot to one SBI.)*/`,
        `try{t.panelTab.onDidDispose(function(){clearInterval(timer);globalThis.__ccsdPanelCount=(globalThis.__ccsdPanelCount||1)-1;if(globalThis.__ccsdPanelCount<=0){globalThis.__ccsdPanelCount=0;if(globalThis.__ccsdSbiTimer){clearInterval(globalThis.__ccsdSbiTimer);globalThis.__ccsdSbiTimer=null;}if(globalThis.__ccsdSbi){try{globalThis.__ccsdSbi.dispose()}catch(e){};globalThis.__ccsdSbi=null;globalThis.__ccsdSbiLastKey=null;}}})}catch(e){}`,
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
// Writer-hook content hash . The writer hook (hooks/cc-status.js) carries a banner
// `/*cc-status-dot-hook:vX.Y.Z:HASH*/` on its first line; the hash is sha1 of
// everything AFTER that banner line. installRuntimeFiles + reportStatus use
// these helpers to detect BOTH inter-version drift (banner version differs
// from HOOK_VERSION) AND intra-version drift (banner hash differs from the
// current body hash — a dev edited the hook but forgot to bump the banner).
// Symmetric to the IIFE gate so writer/reader drift detection is no longer
// the half-rounded thing an earlier round left.
// ---------------------------------------------------------------------------

/** Parse `vX.Y.Z` out of a `cc-status-dot-hook:vX.Y.Z[:HASH]` banner line.
 *  Returns null if the line has no recognizable banner (e.g. hand-edited or
 *  pre-v0.1.14 hook). Tolerates a missing hash segment (pre-hash-scheme banner). */
function parseHookBannerVersion(bannerLine: string): string | null {
    const m = bannerLine.match(/cc-status-dot-hook:v(\d+\.\d+\.\d+)/);
    return m ? "v" + m[1] : null;
}

/** Parse the `:HASH` suffix out of a `cc-status-dot-hook:vX.Y.Z:HASH` banner.
 *  Returns null when the banner pre-dates the hash scheme — callers
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
    // Historical rationale: rather than baking the absolute node binary
    // (process.execPath) into settings.json — which breaks on `nvm uninstall` /
    // `asdf uninstall nodejs` / `volta uninstall node` because the path
    // disappears before our silent-exit(0) fallback can fire — we install a
    // tiny wrapper script at INSTALL_DIR/bin/cc-status-hook (POSIX shell) or
    // .cmd (Windows) and bake the WRAPPER PATH into settings.json instead.
    // The wrapper internally tries the install-time node path first, then
    // falls back to PATH lookup, then common system locations, then version-
    // manager installs — so node version switches / uninstalls no longer
    // freeze every status dot on its last frame. settings.json also no longer
    // contains the user's private node install path (info disclosure side fix).
    // See installNodeWrapper() for the wrapper body + fallback order.
    //
    // The baked node path is captured at install time (warnIfVolatileNodePath
    // still fires for nvm/asdf/volta paths so the user knows); the wrapper
    // makes the volatility SURVIVABLE instead of fatal.
    const nodeBin = process.execPath && fs.existsSync(process.execPath) ? process.execPath : "node";
    const wrapperAbs = wrapperPathFor(hookAbs);
    // Best-effort: write the wrapper now so a same-process `--status` run
    // immediately after install can stat it. installRuntimeFiles also writes
    // it on every install so the wrapper stays in sync with hookAbs.
    try {
        installNodeWrapper(hookAbs, nodeBin);
    } catch {
        // Non-fatal — wireHooks proceeds; the wrapper will be (re)written on
        // the next install runtime-files pass.
    }
    // Invoke via `sh <wrapper>` on POSIX so we don't depend on the +x bit
    // surviving across sync tools / cloud-home setups. The wrapper shebang is
    // also `#!/bin/sh`, so direct execution works too. Windows uses .cmd
    // directly (cmd.exe is always present).
    const invoke = process.platform === "win32" ? `"${wrapperAbs}"` : `sh "${wrapperAbs}"`;
    return `${invoke}  # ${HOOK_MARKER}`;
}

/**
 * Path of the node-locating wrapper script that lives next to the hook.
 * Unix: INSTALL_DIR/bin/cc-status-hook (POSIX shell script).
 * Windows: INSTALL_DIR/bin/cc-status-hook.cmd (batch).
 */
function wrapperPathFor(hookAbs: string): string {
    const binDir = path.join(path.dirname(hookAbs), "..", "bin");
    const name = process.platform === "win32" ? "cc-status-hook.cmd" : "cc-status-hook";
    return path.join(binDir, name);
}

/**
 * Write the node-locating wrapper script. Idempotent — every call rewrites.
 *
 * Wrapper behavior:
 *   1. Try the install-time baked node binary first (preserves the no-PATH-
 *      required property that matters for macOS Finder-launched VS Code).
 *   2. Fall back to `command -v node` (PATH lookup) — works after `nvm use`
 *      switches the active version, even if the baked path is gone.
 *   3. Fall back to common system locations (/usr/local/bin, /opt/homebrew/bin,
 *      /usr/bin) — covers brew installs that aren't on the reduced PATH CC
 *      inherits from Finder launches.
 *   4. Fall back to a glob over version-manager installs (nvm/asdf/volta) —
 *      picks the highest-version node available when the baked one is gone.
 *   5. If everything fails, exit 0 silently — matches cc-status.js's silent-
 *      exit contract so a missing node never breaks the user's CC turn.
 *
 * The wrapper is intentionally tiny and POSIX-sh-only (no bashisms) so it
 * runs on /bin/dash, /bin/sh, busybox sh, etc.
 */
function installNodeWrapper(hookAbs: string, bakedNodeBin: string): void {
    const wrapperAbs = wrapperPathFor(hookAbs);
    const binDir = path.dirname(wrapperAbs);
    fs.mkdirSync(binDir, { recursive: true });
    if (process.platform === "win32") {
        // .cmd batch wrapper. Quote paths for spaces (common in
        // C:\Program Files\nodejs or %LOCALAPPDATA%\Volta\...).
        const hookWin = hookAbs.replace(/\\/g, "\\\\");
        const bakedWin = bakedNodeBin.replace(/\\/g, "\\\\");
        const body = [
            "@echo off",
            "REM cc-status-dot node-locating wrapper (adapts to node path changes after install).",
            "REM Adapts to node path changes after install; silent-exit on total failure.",
            "setlocal",
            `set "HOOK_ABS=${hookWin}"`,
            `set "BAKED=${bakedWin}"`,
            'if exist "%BAKED%" (',
            '  "%BAKED%" "%HOOK_ABS%"',
            "  exit /b %errorlevel%",
            ")",
            "where node >nul 2>&1",
            "if %errorlevel%==0 (",
            '  node "%HOOK_ABS%"',
            "  exit /b %errorlevel%",
            ")",
            "REM All paths failed — silent-exit (do not break the user's CC turn).",
            "exit /b 0",
            "",
        ].join("\r\n");
        fs.writeFileSync(wrapperAbs, body, "utf8");
    } else {
        // POSIX shell wrapper. The shebang is `#!/bin/sh` (not /bin/bash) for
        // portability; we avoid bash-only constructs. Glob expansion in the
        // version-manager fallback relies on POSIX-shell wildcard expansion.
        const body = `#!/bin/sh
# cc-status-dot node-locating wrapper (adapts to node path changes after install).
# Adapts to node path changes (nvm/asdf/volta uninstall or version switch)
# after install. The baked node binary path was captured at install time and
# may disappear; this wrapper tries the baked path, then PATH lookup, then
# common system locations, then version-manager installs. Silent-exit on
# total failure so the user's CC turn is never broken by a missing node.

HOOK_ABS=${JSON.stringify(hookAbs)}
BAKED=${JSON.stringify(bakedNodeBin)}

# 1. Install-time baked path (preferred — preserves no-PATH-required property).
if [ -x "$BAKED" ]; then exec "$BAKED" "$HOOK_ABS"; fi

# 2. PATH lookup (works after nvm use / asdf local switches the active version).
if command -v node >/dev/null 2>&1; then exec node "$HOOK_ABS"; fi

# 3. Common system locations (covers Homebrew / system installs not on the
#    reduced PATH that VS Code inherits when launched from Finder/Spotlight).
for N in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    if [ -x "$N" ]; then exec "$N" "$HOOK_ABS"; fi
done

# 4. Version-manager installs (nvm/asdf/volta) — pick whichever exists.
#    POSIX shell expands the globs; nullglob is not POSIX so we rely on the
#    default behavior (literal pattern if no match) and the -x test filters
#    non-existent paths. We try multiple version-manager roots in case the
#    user has more than one installed.
for N in \\
    "$HOME/.nvm/versions/node"/*/bin/node \\
    "$HOME/.asdf/installs/nodejs"/*/bin/node \\
    "$HOME/.asdf/installs/node"/*/bin/node \\
    "$HOME/.volta/tools/image/node"/*/bin/node \\
    "$HOME/.volta/bin/node" \\
    "$HOME/.local/bin/node" \\
; do
    if [ -x "$N" ]; then exec "$N" "$HOOK_ABS"; fi
done

# 5. All paths failed. Silent-exit (do not break the user's CC turn — mirrors
#    cc-status.js's own silent-exit(0) contract on the writer side).
exit 0
`;
        fs.writeFileSync(wrapperAbs, body, "utf8");
        // chmod +x so direct execution works (we still invoke via `sh <wrapper>`
        // from hookCommand to be safe across +x-bit-stripping sync tools, but
        // the +x bit means `./<wrapper>` also works for direct CLI testing).
        try {
            fs.chmodSync(wrapperAbs, 0o755);
        } catch {
            // Non-fatal — `sh <wrapper>` invocation in hookCommand still works.
        }
    }
}

/**
 * Warn when the baked node binary path lives under a version-managed install
 * (nvm / asdf / volta). Those directories disappear on `nvm uninstall`,
 * `asdf uninstall nodejs`, `volta uninstall node`, etc.
 *
 * Historical rationale: this is now INFORMATIONAL, not fatal. The wrapper script
 * at INSTALL_DIR/bin/cc-status-hook[.cmd] tries the baked path first, then
 * falls back to PATH lookup, common system locations, and version-manager
 * installs — so even when the baked node disappears, the wrapper self-heals
 * at the next hook spawn. The warn remains so users who see dots stop
 * updating know to check `--status` (which reports wrapper presence/absence)
 * and re-run install if needed (refreshes the baked path to the current node).
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
    log(`hook wrapper will bake a version-managed node path: ${p}`);
    log(`  this path may disappear on \`nvm uninstall\` / \`asdf uninstall nodejs\` / \`volta uninstall node\`.`);
    log(`  the wrapper falls back to PATH + system + version-manager`);
    log(`  locations if the baked path disappears, so status dots stay responsive.`);
    log(`  re-run install after a node version switch to refresh the baked path (optional).`);
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

/** Owns the surgical-splice-or-round-trip-fallback dance shared by wireHooks
 *  (writing the hooks value) and unwireHooks (removing it when empty, else
 *  replacing). Validates raw parses as JSONC before attempting a surgical
 *  splice, sanity-parses the spliced result, and falls back to a whole-file
 *  JSON.stringify round-trip on any failure path (malformed raw, surgical
 *  editor declined to splice, spliced output failed JSON.parse). Returns the
 *  next raw text + a short note explaining which path was taken.
 *
 *  `removeIfEmpty`: when true and obj.hooks is empty/absent, REMOVE the key
 *  entirely (preserving comments around it). When false, always REPLACE the
 *  hooks value. wireHooks passes false; unwireHooks passes true. */
function commitSettingsSurgically(
    raw: string,
    parsedOk: boolean,
    obj: Record<string, unknown>,
    removeIfEmpty: boolean,
): { nextRaw: string; note: string } {
    if (!parsedOk) {
        return {
            nextRaw: JSON.stringify(obj, null, 2) + "\n",
            note: " (round-trip fallback — raw was malformed JSONC)",
        };
    }
    const hooksNowEmpty =
        !obj.hooks || typeof obj.hooks !== "object" || Object.keys(obj.hooks as HooksMap).length === 0;
    let candidate: string;
    if (removeIfEmpty && hooksNowEmpty) {
        candidate = surgicalRemoveTopLevelKey(raw, "hooks");
    } else {
        candidate = surgicalSetTopLevelKey(raw, "hooks", JSON.stringify(obj.hooks, null, 2));
    }
    if (candidate === raw) {
        return {
            nextRaw: JSON.stringify(obj, null, 2) + "\n",
            note: " (round-trip fallback — surgical editor declined to splice)",
        };
    }
    // Sanity check: the spliced result must still parse.
    try {
        JSON.parse(stripJsonc(candidate));
    } catch {
        return {
            nextRaw: JSON.stringify(obj, null, 2) + "\n",
            note: " (round-trip fallback — surgical result failed JSON.parse)",
        };
    }
    return { nextRaw: candidate, note: " (surgical edit preserved user comments)" };
}

function wireHooks(): void {
    const settings = settingsPath();
    const hookAbs = path.join(INSTALL_DIR, "hooks", "cc-status.js");

    let raw = "{}";
    if (fs.existsSync(settings)) raw = fs.readFileSync(settings, "utf8");
    // Validate the raw text parses as JSONC BEFORE we attempt a surgical splice.
    // If it doesn't parse, fall back to the legacy round-trip (which will fail
    // loudly via parseJsonc) — we never splice into malformed JSON.
    let parsedOk = true;
    try {
        JSON.parse(stripJsonc(raw));
    } catch {
        parsedOk = false;
    }
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
                // point at a STALE form. Three stale shapes are migrated:
                //   (a) v0.1 baked PROJECT_ROOT/hooks/cc-status.js — phase1 moved
                //       to INSTALL_DIR/hooks/cc-status.js.
                //   (b) Pre-wrapper baked `<nodeBin> "<hookAbs>"` form —
                //       the wrapper migration moved to the multi-path wrapper at
                //       INSTALL_DIR/bin/cc-status-hook[.cmd]. The wrapper path
                //       is stable across node version switches.
                //   (c) Wrapper path itself changed (rare — only if INSTALL_DIR
                //       moves, which only happens if the user's HOME changes).
                // Only touch commands carrying our HOOK_MARKER so user-owned
                // hooks are never mutated. We detect staleness by checking that
                // the current wrapper path is NOT present in the existing
                // command — covers all three stale shapes above.
                const wrapperAbs = wrapperPathFor(hookAbs);
                const g = arr[oursIdx] as HookGroup;
                for (const h of g.hooks) {
                    if (
                        typeof h?.command === "string" &&
                        h.command.includes(HOOK_MARKER) &&
                        !h.command.includes(wrapperAbs)
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
    const { nextRaw, note: surgicalNote } = commitSettingsSurgically(raw, parsedOk, obj, false);
    writeAtomicSync(settings, nextRaw);
    log(`wrote ${HOOK_EVENTS.length} hook event(s) into ${settings}${surgicalNote}`);
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
    let parsedOk = true;
    try {
        JSON.parse(stripJsonc(raw));
    } catch {
        parsedOk = false;
    }
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
        const { nextRaw, note: surgicalNote } = commitSettingsSurgically(raw, parsedOk, obj, true);
        writeAtomicSync(settings, nextRaw);
        log(`removed cc-status-dot hook entries from ${settings}${surgicalNote}`);
    } else {
        log("no cc-status-dot hook entries found in settings.json");
    }
}

// ---------------------------------------------------------------------------
// Companion VS Code extension (v0.2.0)
// ---------------------------------------------------------------------------
// The companion is a tiny .vsix that watches CC auto-updates and re-applies
// this patcher automatically. It is NOT published to the Marketplace — it ships
// inside this npm package (dist/cc-status-dot-companion-<ver>.vsix) and
// gets installed into the user's VS Code via the `code --install-extension` CLI
// (or cursor / codium / insiders — we probe each). If NO code CLI is on PATH
// we warn and continue: the IIFE patch still works without the companion, the
// user just loses the auto-re-patch convenience.
//
// Why CLI vs unzip-into-~/.vscode/extensions:
//   - `code --install-extension` is the official install path; VS Code's
//     extension manager then tracks the extension (shows in the Extensions
//     panel, can be uninstalled from the UI, survives `code --update-extensions`).
//   - Manually unzipping bypasses that tracking and risks corruption if VS Code
//     is mid-startup. We only fall back to unzip when the CLI is genuinely
//     unavailable AND the user has no other option.
//
// Cross-platform note:
//   - The `code` executable is `code` on POSIX, `code.cmd` on Windows (cmd.exe
//     looks up PATHEXT). cp.execSync("code --version") works on both because
//     Node spawns through the shell on Windows.
//   - We probe `code`, `vscode`, `vscode-insiders`, `cursor`, `codium` so the
//     companion lands in whatever VS Code-family editors the user has. Each
//     install is independent and best-effort.
// ---------------------------------------------------------------------------

/** The set of VS Code-family CLI binaries we'll probe for companion install.
 *  Order matters only for log clarity — each is tried independently and the
 *  user may have several installed simultaneously (e.g. VS Code stable + VS
 *  Code Insiders + Cursor). `code.cmd` on Windows is resolved automatically by
 *  cmd.exe PATHEXT, so we list the bare names here. */
const VSCODE_CLIS = ["code", "code-insiders", "vscode-insiders", "cursor", "codium", "vscode"];

/** Probe whether a single CLI binary exists and is invokable. Returns the
 *  trimmed first-line output of `<cli> --version` (e.g. "1.129.1") on success,
 *  or null on any spawn failure / non-zero exit. We use `--version` (not
 *  `--list-extensions`) because it's the cheapest invocable command and exists
 *  on every VS Code-family fork.
 *
 *  v0.2.0 — known-install-path fallback: macOS users who never ran "Shell
 *  Command: Install 'code' command in PATH" have `code` only inside the .app
 *  bundle (e.g. /Applications/Visual Studio Code.app/Contents/Resources/app/
 *  bin/code). Windows installs similarly land in %ProgramFiles%\Microsoft VS
 *  Code\bin\code.cmd. We probe these well-known paths as a fallback when the
 *  bare CLI name is not on PATH, so the companion auto-installs for the
 *  common "I just dragged VS Code to /Applications" case instead of warning
 *  "no VS Code-family CLI detected". Each fallback path is stat-checked first
 *  so we don't spawn a process we know will fail.
 *
 *  Callers that need to invoke the CLI after probing MUST call
 *  resolveVscodeCli (not the bare `cli` name) — that's the function that
 *  returns the actual executable path (bare name if on PATH, or the resolved
 *  known install path otherwise). probeVscodeCli is for "is it present?"
 *  detection only. */
function probeVscodeCli(cli: string): string | null {
    // hideOutput: spawn through shell on Windows so PATHEXT resolves `code.cmd`.
    try {
        const out = cp.execSync(`${cli} --version`, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 8000,
        });
        const firstLine = (out.split(/\r?\n/)[0] || "").trim();
        // VS Code prints 3 lines (version, hash, arch). We only care that it ran.
        return firstLine || "(present)";
    } catch {
        /* not on PATH — fall through to known-install-path probe */
    }
    return probeKnownVscodeCliPath(cli);
}

/** Resolve the executable path for a VS Code-family CLI. Returns the bare
 *  `cli` name if it's invokable on PATH (preferred — survives app updates that
 *  move the .app bundle), or the first well-known install path that actually
 *  exists + runs, or null if neither works. Callers should use the returned
 *  value verbatim when invoking the CLI (it's already shell-quoted-safe via
 *  the surrounding `"${resolved}"` template — bare names contain no spaces,
 *  absolute paths may). */
function resolveVscodeCli(cli: string): string | null {
    // Fast path — bare name on PATH. execSync is the same check probeVscodeCli
    // uses; cheaper than re-implementing with `which`.
    try {
        cp.execSync(`${cli} --version`, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 8000,
        });
        return cli;
    } catch {
        /* fall through to known paths */
    }
    return resolveKnownVscodeCliPath(cli);
}

/** Per-platform well-known install paths for each VS Code-family CLI. Used as
 *  a fallback when the bare CLI name is not on PATH (common on macOS where
 *  users must explicitly run "Shell Command: Install 'code' command in PATH"
 *  from the command palette). Returns the trimmed --version first line on
 *  success, or null if no known path resolves. */
function probeKnownVscodeCliPath(cli: string): string | null {
    const candidates = knownVscodeCliCandidates(cli);
    for (const c of candidates) {
        if (!fs.existsSync(c)) continue;
        try {
            const out = cp.execSync(`"${c}" --version`, {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 8000,
            });
            const firstLine = (out.split(/\r?\n/)[0] || "").trim();
            log(`  ${cli}: not on PATH but found at ${c} (use 'Shell Command: Install code in PATH' to fix)`);
            return firstLine || "(present)";
        } catch {
            /* continue to next candidate */
        }
    }
    return null;
}

/** Same path enumeration as probeKnownVscodeCliPath but returns the resolved
 *  executable path (or null). Used by resolveVscodeCli so install/uninstall
 *  can invoke the CLI at the discovered location, not just detect it. */
function resolveKnownVscodeCliPath(cli: string): string | null {
    for (const c of knownVscodeCliCandidates(cli)) {
        if (!fs.existsSync(c)) continue;
        try {
            cp.execSync(`"${c}" --version`, {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 8000,
            });
            log(`  ${cli}: not on PATH but found at ${c} (use 'Shell Command: Install code in PATH' to fix)`);
            return c;
        } catch {
            /* continue to next candidate */
        }
    }
    return null;
}

/** Enumerate the well-known install paths for `cli` on the current platform.
 *  Pure data — no stat, no spawn — so callers can reuse the list for both
 *  probe (return version string) and resolve (return path). */
function knownVscodeCliCandidates(cli: string): string[] {
    const candidates: string[] = [];
    const home = os.homedir();
    if (process.platform === "darwin") {
        // macOS .app bundles ship the CLI under Contents/Resources/app/bin.
        // User-installed (default): /Applications; per-user: ~/Applications.
        const appRoots = ["/Applications", path.join(home, "Applications")];
        const appDirs: Record<string, string[]> = {
            code: ["Visual Studio Code.app/Contents/Resources/app/bin/code"],
            "code-insiders": ["Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders"],
            cursor: ["Cursor.app/Contents/Resources/app/bin/cursor"],
            codium: ["VSCodium.app/Contents/Resources/app/bin/codium"],
        };
        const rels = appDirs[cli] ?? [];
        for (const root of appRoots) for (const rel of rels) candidates.push(path.join(root, rel));
    } else if (process.platform === "win32") {
        const progFiles = process.env.ProgramFiles ?? "C:\\Program Files";
        const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
        const winDirs: Record<string, string[]> = {
            code: [
                `${progFiles}\\Microsoft VS Code\\bin\\code.cmd`,
                `${localAppData}\\Programs\\Microsoft VS Code\\bin\\code.cmd`,
            ],
            "code-insiders": [
                `${progFiles}\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd`,
                `${localAppData}\\Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd`,
            ],
            cursor: [`${localAppData}\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd`],
        };
        const rels = winDirs[cli] ?? [];
        for (const rel of rels) candidates.push(rel);
    }
    return candidates;
}

/** Run `code --install-extension <vsix>` (idempotent — VS Code skips if the
 *  same version is already installed; --force re-installs otherwise). Returns
 *  true on exit 0, false on any failure. We pass `--force` so a same-version
 *  re-install (user re-runs npx) refreshes the bits instead of being skipped
 *  silently.
 *
 *  v0.2.0 — downgrade guard: BEFORE the `--force` we ask the CLI what version
 *  of the companion it already has installed (`--list-extensions --show-
 *  versions` prints `publisher.name@x.y.z`). If the installed version is
 *  STRICTLY GREATER than the .vsix we're about to install, we SKIP that CLI
 *  (and log why) instead of `--force`-downgrading it. This protects users who
 *  installed a newer companion from some other source (self-build, separate
 *  npm publish, etc.) from a silent regression. Equal / older / absent all
 *  still go through `--force` as before.
 *
 *  `cliName` is the bare CLI name (e.g. "code") for log readability; `cliPath`
 *  is the resolved executable path (bare name OR an absolute well-known
 *  install path returned by resolveVscodeCli) used for the actual spawn. */
function installCompanionIntoCli(cliName: string, cliPath: string, vsixAbs: string, vsixVersion: string): boolean {
    // Downgrade guard — query the installed version (if any) and bail out if
    // the user already has a strictly newer one. Failures to query are non-
    // fatal (treat as "version unknown, proceed with --force").
    const installed = installedCompanionVersion(cliPath);
    if (installed !== null && cmpVerStr(installed, vsixVersion) > 0) {
        log(
            `  ${cliName}: SKIP — installed companion ${installed} is newer than the .vsix ${vsixVersion} (downgrade guard). Run \`code --uninstall-extension ${COMPANION_EXT_ID}\` first if you want to install the older version.`,
        );
        return false;
    }
    try {
        const out = cp.execSync(`"${cliPath}" --install-extension "${vsixAbs}" --force`, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30000,
        });
        // VS Code prints "Successfully installed" or "already installed" on
        // success; surface a trimmed hint for the install log.
        const last = (out.split(/\r?\n/).filter(Boolean).pop() || "").trim();
        log(`  ${cliName}: ${last || "installed"}`);
        return true;
    } catch (e) {
        warn(`  ${cliName}: install-extension failed (${(e as Error).message ?? String(e)})`);
        return false;
    }
}

/** Parse the installed companion version out of `<cliPath> --list-extensions
 *  --show-versions` (prints `publisher.name@x.y.z`, one per line). Returns the
 *  version string ("0.2.0") if the companion is installed, or null if not
 *  installed / the CLI failed / the version line didn't parse. `cliPath` is
 *  the resolved executable path (bare name OR absolute path from
 *  resolveVscodeCli). */
function installedCompanionVersion(cliPath: string): string | null {
    try {
        const out = cp.execSync(`"${cliPath}" --list-extensions --show-versions`, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 10000,
        });
        // Match "wangdong.cc-status-dot-companion@1.2.3" anywhere on a line.
        const m = out.match(
            new RegExp(`${COMPANION_EXT_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@(\\d+\\.\\d+\\.\\d+)`),
        );
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

/** Locate the prebuilt companion .vsix. Dev (`tsx patch.ts`) resolves it from
 *  PROJECT_ROOT/companion/<vsix>; the published package ships the same path
 *  (companion/ is listed in package.json `files`). Returns the absolute path
 *  or null if absent (caller warns + continues — install must NOT fail just
 *  because the .vsix is missing, the IIFE patch is the critical surface). */
function locateCompanionVsix(): string | null {
    const candidate = path.join(PROJECT_ROOT, COMPANION_VSIX);
    return fs.existsSync(candidate) ? candidate : null;
}

/** Write `INSTALL_DIR/companion-config.json` containing every constant the
 *  companion currently hand-mirrors in companion/extension.ts: installDir,
 *  patchJsPath, patcherVersion, injectMarker, injectVersion, ccExtIdPrefix,
 *  searchDirs. The companion reads this at activate() and uses the values
 *  instead of its hardcoded fallbacks — decoupling the companion's build
 *  cadence from the patcher's internals.
 *
 *  Architecture rationale (review finding: "INSTALL_DIR/patch.js snapshot +
 *  SEARCH_DIRS hand-mirrored"): the v0.2.0 companion mirrored INSTALL_DIR /
 *  INJECT_MARKER / INJECT_VERSION / SEARCH_DIRS as TypeScript consts with a
 *  "must match patch.ts:LINE" comment but no compile-time check. A future
 *  patch.ts that added a new VS Code flavor to SEARCH_DIRS would silently
 *  break the companion's fallback disk scan — only the next .vsix rebuild
 *  would carry the new list. Writing the constants to a JSON config the
 *  companion reads at runtime means a simple `npx` re-run refreshes the
 *  companion's behavior WITHOUT rebuilding / re-shipping the .vsix.
 *
 *  The config also carries `patcherVersion` so the companion can detect a
 *  stale `INSTALL_DIR/patch.js` snapshot: if the user did
 *  `npm install -g vscode-claude-code-status-dot@latest` (updates the npm
 *  package) WITHOUT re-running the bin, INSTALL_DIR/patch.js is the OLD
 *  version while companion-config.json... is ALSO old (it's written by the
 *  same old patch.js). To detect this case the companion compares
 *  `config.patcherVersion` against its own MIN_PATCHER_VERSION constant; if
 *  older, it warns the user to re-run `npx` so both patch.js AND config.json
 *  get refreshed together.
 *
 *  Best-effort: a write failure is warned, never fatal (the IIFE patch is
 *  the critical surface, not this config file — the companion falls back to
 *  its hardcoded constants). Idempotent: re-writing on every install
 *  refreshes the values. */
function writeCompanionConfig(): void {
    const config = {
        patcherVersion: PATCHER_VERSION,
        installDir: INSTALL_DIR,
        patchJsPath: path.join(INSTALL_DIR, "patch.js"),
        injectMarker: INJECT_MARKER,
        injectVersion: INJECT_VERSION,
        // Same prefix the patcher's discoverExtension regex matches against
        // (`^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)`). The companion uses
        // this in its vscode.extensions.all scan as a startsWith filter.
        ccExtIdPrefix: "anthropic.claude-code",
        searchDirs: SEARCH_DIRS,
        writtenAt: Date.now(),
    };
    try {
        fs.mkdirSync(INSTALL_DIR, { recursive: true });
        writeAtomicSync(COMPANION_CONFIG_PATH, JSON.stringify(config, null, 2));
        log(`wrote companion config → ${COMPANION_CONFIG_PATH} (patcherVersion ${PATCHER_VERSION})`);
    } catch (e) {
        warn(
            `failed to write ${COMPANION_CONFIG_PATH} (non-fatal — companion will fall back to its hardcoded constants): ${(e as Error).message ?? String(e)}`,
        );
    }
}

/** Write `INSTALL_DIR/last-repatch.json` after a successful --patch-only run so
 *  companion instances in OTHER still-running VS Code windows can detect that
 *  the CC extension.js was just re-patched and prompt their users to reload.
 *  Closes the multi-window gap: pre-fix, Window 1 patched → reloaded → happy,
 *  but Windows 2/3 still had the OLD CC in memory and never prompted.
 *
 *  Schema: { ts, extDir, version, anchorB, patcherVersion, source }.
 *  - `ts` (epoch ms) is what other windows poll to detect change.
 *  - `extDir` lets a multi-flavor install (stable + insiders) discriminate:
 *    stable's companion only prompts when insiders' CC was patched if stable
 *    shares the SAME CC install (it doesn't — different flavors have different
 *    ext dirs). So this scoping prevents cross-flavor false positives.
 *  - `anchorB` is reused in the prompt body ("with warnings" vs "clean").
 *  - `source` is "companion" when the companion triggered the patch (via
 *    `--patch-only`) or "npx" when the user ran the bin manually — informational.
 *
 *  Best-effort: write failure is warned but does NOT fail the patch (the
 *  on-disk extension.js is already correct; only the cross-window signal
 *  is lost — those windows will catch up on their own reload). */
function writeRepatchFlag(extDir: string, anchorB: boolean, source: "companion" | "npx"): void {
    const flag = {
        ts: Date.now(),
        extDir,
        version: INJECT_VERSION,
        anchorB,
        patcherVersion: PATCHER_VERSION,
        source,
    };
    try {
        fs.mkdirSync(INSTALL_DIR, { recursive: true });
        writeAtomicSync(LAST_REPATCH_PATH, JSON.stringify(flag, null, 2));
    } catch (e) {
        warn(
            `failed to write ${LAST_REPATCH_PATH} (non-fatal — other VS Code windows won't get the cross-window reload signal): ${(e as Error).message ?? String(e)}`,
        );
    }
}

/** Install (or refresh) the companion .vsix into every detected VS Code-family
 *  CLI on PATH. Idempotent: re-running refreshes via `--force`. If NO CLI is
 *  detected we warn and continue — the IIFE patch alone still works. Also
 *  copies our compiled patch.js to INSTALL_DIR so the companion has a stable
 *  path to re-exec at VS Code startup (see companion/extension.ts). */
function installCompanion(): void {
    // 1. Copy dist/patch.js → INSTALL_DIR/patch.js so the companion can re-exec
    //    the patcher without depending on the user's npx cache (which may be
    //    purged). dist/patch.js exists in the published package; in dev
    //    (`tsx patch.ts`) it may be absent — best-effort copy.
    const srcPatchJs = path.join(SCRIPT_DIR, "patch.js");
    const dstPatchJs = path.join(INSTALL_DIR, "patch.js");
    try {
        if (fs.existsSync(srcPatchJs)) {
            fs.mkdirSync(INSTALL_DIR, { recursive: true });
            fs.copyFileSync(srcPatchJs, dstPatchJs);
            log(`copied patch.js → ${dstPatchJs} (companion re-execs this)`);
        } else {
            // Dev mode without a build: warn — the companion will fall through
            // to its "patcher not found" message at startup. Non-fatal.
            warn(
                `dist/patch.js not found at ${srcPatchJs} — companion will not be able to re-patch until \`npm run build\` is run`,
            );
        }
    } catch (e) {
        warn(`failed to copy patch.js to INSTALL_DIR (non-fatal): ${(e as Error).message ?? String(e)}`);
    }

    // 1b. Write INSTALL_DIR/companion-config.json with the constants the
    //     companion currently hand-mirrors (INSTALL_DIR / INJECT_MARKER /
    //     INJECT_VERSION / SEARCH_DIRS / ccExtIdPrefix / patchJsPath /
    //     patcherVersion). Best-effort — companion falls back to its hardcoded
    //     values if this file is missing or stale. See writeCompanionConfig.
    writeCompanionConfig();

    // 2. Install the .vsix into every detected VS Code-family CLI.
    const vsixAbs = locateCompanionVsix();
    if (!vsixAbs) {
        warn(
            `companion .vsix not found at ${path.join(PROJECT_ROOT, COMPANION_VSIX)} — run \`npm run companion:package\` to build it (the patch still works without the companion; you just won't get auto-re-patch after a CC update)`,
        );
        return;
    }
    log(`installing companion extension (${COMPANION_VERSION}) into detected VS Code-family CLIs…`);
    log(`  vsix: ${vsixAbs}`);
    let anyOk = false;
    let anyDetected = false;
    for (const cli of VSCODE_CLIS) {
        const resolved = resolveVscodeCli(cli);
        if (resolved === null) continue;
        const probe = probeVscodeCli(cli);
        anyDetected = true;
        log(`  ${cli}: detected (${probe})${resolved !== cli ? ` at ${resolved}` : ""}`);
        if (installCompanionIntoCli(cli, resolved, vsixAbs, COMPANION_VERSION)) anyOk = true;
    }
    if (!anyDetected) {
        warn(
            "no VS Code-family CLI detected on PATH or at well-known install paths " +
                "(looked for: " +
                VSCODE_CLIS.join(", ") +
                "; on macOS also try /Applications/<App>.app/Contents/Resources/app/bin/). " +
                "The patch is installed, but the companion extension was NOT installed. " +
                "Open VS Code → Cmd/Ctrl+Shift+P → 'Shell Command: Install code in PATH' and re-run if you want auto-re-patch.",
        );
        return;
    }
    if (anyOk) {
        log(`companion extension installed — CC auto-updates will be self-healed (reload VS Code once)`);
    } else {
        warn("companion .vsix install failed for every detected CLI — see warnings above. Patch is still active.");
    }
}

/** Uninstall the companion extension from every detected VS Code-family CLI.
 *  Best-effort: failures are warned, never fatal (the .vsix may already be gone
 *  or the CLI may be locked). v0.2.0: uses resolveVscodeCli so the uninstall
 *  works even when `code` is not on PATH (macOS well-known install paths). */
function uninstallCompanion(): void {
    log("uninstalling companion extension from detected VS Code-family CLIs…");
    let anyDetected = false;
    for (const cli of VSCODE_CLIS) {
        const resolved = resolveVscodeCli(cli);
        if (resolved === null) continue;
        anyDetected = true;
        try {
            cp.execSync(`"${resolved}" --uninstall-extension ${COMPANION_EXT_ID}`, {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 15000,
            });
            log(`  ${cli}: uninstalled ${COMPANION_EXT_ID}`);
        } catch (e) {
            // Non-fatal — most likely "extension not installed" which is the
            // desired post-condition anyway. Surface the trimmed stderr.
            const msg = (e as { stderr?: string; message?: string }).stderr || (e as Error).message || String(e);
            const trimmed = String(msg).split(/\r?\n/)[0]?.trim() || "(unknown)";
            log(`  ${cli}: ${trimmed}`);
        }
    }
    if (!anyDetected) {
        // v0.2.0: surface this as a warn (not log) so the user notices the
        // companion .vsix is left behind — the previous bare log line was
        // easy to miss in scrollback. The next companion startup (post-fix)
        // would then warn "patcher not found" because removeInstallDir()
        // below already deleted INSTALL_DIR/patch.js.
        warn(
            `no VS Code-family CLI on PATH or at well-known install paths — companion .vsix left installed. Manually run \`code --uninstall-extension ${COMPANION_EXT_ID}\` if you want it gone.`,
        );
    }
    // Also remove the INSTALL_DIR/patch.js copy we placed for the companion.
    const dstPatchJs = path.join(INSTALL_DIR, "patch.js");
    try {
        if (fs.existsSync(dstPatchJs)) {
            fs.unlinkSync(dstPatchJs);
            log(`removed companion patch.js copy: ${dstPatchJs}`);
        }
    } catch (e) {
        warn(`could not remove ${dstPatchJs}: ${(e as Error).message ?? String(e)} (remove manually)`);
    }
}

/** Surface companion install health in --status. Reports: vsix presence in the
 *  package, each detected CLI's install state + version (queried via
 *  `code --list-extensions --show-versions`), and the INSTALL_DIR/patch.js copy.
 *  v0.2.0: surfaces installed-vs-packaged version drift per CLI so a user
 *  running an older companion can see "installed 0.1.0 (packaged 0.2.0) —
 *  re-run npx to upgrade" instead of a bare "INSTALLED" with no signal. */
function reportCompanionStatus(): void {
    log(`companion version: ${COMPANION_VERSION}`);
    const vsixAbs = locateCompanionVsix();
    log(`  packaged .vsix: ${vsixAbs ? vsixAbs : "(missing — run `npm run companion:package`)"}`);
    const dstPatchJs = path.join(INSTALL_DIR, "patch.js");
    log(
        `  INSTALL_DIR/patch.js: ${fs.existsSync(dstPatchJs) ? "present" : "(missing — companion will warn at startup)"}`,
    );
    // v0.2.1: also surface the companion-config.json + last-repatch.json files
    // the patcher writes for the companion to read. A missing config means
    // the companion will fall back to its hardcoded constants (v0.2.0
    // behavior); a missing repatch flag means cross-window reload signaling
    // is inactive. Both are non-fatal but worth surfacing so a user
    // diagnosing "why doesn't the companion pick up my new patcher version?"
    // can see immediately that the config wasn't written.
    const configExists = fs.existsSync(COMPANION_CONFIG_PATH);
    let configVer = "(missing)";
    if (configExists) {
        try {
            const parsed = JSON.parse(fs.readFileSync(COMPANION_CONFIG_PATH, "utf8")) as { patcherVersion?: string };
            if (parsed.patcherVersion) configVer = parsed.patcherVersion;
        } catch {
            configVer = "(corrupt)";
        }
    }
    log(
        `  INSTALL_DIR/companion-config.json: ${configExists ? `present (patcherVersion ${configVer})` : "(missing — companion falls back to hardcoded constants)"}`,
    );
    const flagExists = fs.existsSync(LAST_REPATCH_PATH);
    let flagTs = "(missing)";
    if (flagExists) {
        try {
            const parsed = JSON.parse(fs.readFileSync(LAST_REPATCH_PATH, "utf8")) as { ts?: number };
            if (typeof parsed.ts === "number") flagTs = new Date(parsed.ts).toISOString();
        } catch {
            flagTs = "(corrupt)";
        }
    }
    log(
        `  INSTALL_DIR/last-repatch.json: ${flagExists ? `present (ts ${flagTs})` : "(missing — cross-window reload signal inactive until next patch)"}`,
    );
    let anyDetected = false;
    for (const cli of VSCODE_CLIS) {
        if (probeVscodeCli(cli) === null) continue;
        anyDetected = true;
        const installed = installedCompanionVersion(cli);
        if (installed === null) {
            log(`  ${cli}: companion not installed`);
        } else if (cmpVerStr(installed, COMPANION_VERSION) < 0) {
            // Installed older than packaged → user is behind.
            log(
                `  ${cli}: companion INSTALLED ${installed} (packaged ${COMPANION_VERSION} — re-run \`npx vscode-claude-code-status-dot\` to upgrade)`,
            );
        } else if (cmpVerStr(installed, COMPANION_VERSION) > 0) {
            // Installed newer than packaged → user is ahead (self-build etc.).
            log(`  ${cli}: companion INSTALLED ${installed} (newer than packaged ${COMPANION_VERSION} — keeping)`);
        } else {
            log(`  ${cli}: companion INSTALLED ${installed} (matches packaged)`);
        }
    }
    if (!anyDetected) {
        log(`  no VS Code-family CLI on PATH (looked for: ${VSCODE_CLIS.join(", ")})`);
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
                // Drift detection (version + hash gate):
                // assert the source hook carries the HOOK_VERSION banner we expect AND
                // that the banner's hash matches the source body hash. A version
                // mismatch is a dev error (forgot to bump the banner in cc-status.js
                // when bumping HOOK_VERSION); a hash mismatch is the intra-version
                // equivalent (edited the hook body but forgot to re-stamp the banner
                // hash). Both are surfaced loudly so the build ships self-consistent.
                // Mirrors the IIFE's INJECT_VERSION+hash gate (closes the prior asymmetry where only the reader side had a hash check).
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
                        `source hooks/cc-status.js banner ${srcVer} has no :HASH suffix — re-stamp with ${srcBodyHash} (hash scheme)`,
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
        // also install the node-locating wrapper at
        // INSTALL_DIR/bin/cc-status-hook (POSIX) or .cmd (Windows). The hook
        // command in settings.json invokes this wrapper instead of baking the
        // absolute node path, so node version switches / uninstalls no longer
        // freeze every status dot. Idempotent: re-writing on every install
        // keeps the wrapper's baked-node-path field current (warnIfVolatile-
        // NodePath still fires so the user knows, but the wrapper makes the
        // volatility survivable instead of fatal).
        try {
            const installedHookAbs = path.join(destHooks, "cc-status.js");
            const nodeBin = process.execPath && fs.existsSync(process.execPath) ? process.execPath : "node";
            installNodeWrapper(installedHookAbs, nodeBin);
        } catch (e) {
            warn(`failed to write node-locating wrapper (non-fatal): ${(e as Error).message}`);
            warn(`  hooks will use the legacy baked-node-binary fallback until next successful install.`);
        }
        log(`installed runtime files → ${INSTALL_DIR} (${copied}/${OUR_SVGS.length} SVGs + hook + wrapper)`);
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
 * Detect hook commands whose wrapper script is missing, or whose wrapper's
 * baked node binary (stored inside the wrapper) no longer exists on disk.
 *
 * Historical rationale: the baked-node-binary architecture changed to a wrapper
 * script (INSTALL_DIR/bin/cc-status-hook[.cmd]). The wrapper internally tries
 * the install-time node path, then PATH lookup, then common system locations,
 * then version-manager installs — so even when the baked node path disappears
 * (nvm/asdf/volta uninstall), the wrapper self-heals at the next hook spawn.
 * This diagnostic therefore checks TWO things:
 *   (1) Does the wrapper script itself exist? If not, install is broken.
 *   (2) Does the wrapper's baked node path still exist? If not, we surface a
 *       INFO (not a warn) that the wrapper will fall back to PATH/system
 *       locations at spawn time — non-fatal thanks to the multi-path search.
 *
 * Pre-wrapper installs (pre-wrapper) baked `${nodeBin} "<hookAbs>"` directly
 * in settings.json; we still detect that shape and warn on missing binaries,
 * so users upgrading from an older install are also covered.
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
    // Track wrapper script paths seen in hook commands (new architecture).
    const wrapperSeen = new Set<string>();
    let wrapperMissing = false;
    // Track pre-wrapper baked node binaries still present in settings.json
    // (older installs not yet re-run after the wrapper migration).
    const seen = new Set<string>();
    let warnedAny = false;
    for (const ev of Object.keys(hooks)) {
        const arr = hooks[ev];
        if (!Array.isArray(arr)) continue;
        for (const g of arr) {
            if (!groupIsOurs(g)) continue;
            for (const h of (g as HookGroup).hooks) {
                const cmd = typeof h?.command === "string" ? h.command : "";
                // New wrapper shape: `sh "<wrapperAbs>"  # cc-status-dot-managed`
                // (POSIX) or `"<wrapperAbs>.cmd"  # cc-status-dot-managed` (Win).
                const w = cmd.match(/(?:^|\s)("?)([^\s"]*cc-status-hook(?:\.cmd)?)\1\s+#\s*cc-status-dot-managed/);
                if (w) {
                    const wrapperAbs = w[2];
                    if (wrapperSeen.has(wrapperAbs)) continue;
                    wrapperSeen.add(wrapperAbs);
                    if (!fs.existsSync(wrapperAbs)) {
                        warn(`hook command references a wrapper script that no longer exists: ${wrapperAbs}`);
                        warn(`  hooks will fail to spawn — re-run install to re-create the wrapper.`);
                        wrapperMissing = true;
                    }
                    continue;
                }
                // Legacy pre-wrapper shape: `<nodeBin> "<hookAbs>"  # cc-status-dot-managed`
                const m = cmd.match(/^(\S+)\s+"[^"]*cc-status\.js"\s+#\s*cc-status-dot-managed/);
                if (!m) continue;
                const nodeBin = m[1];
                if (seen.has(nodeBin)) continue;
                seen.add(nodeBin);
                if (nodeBin === "node") continue; // already a bare PATH fallback
                if (!fs.existsSync(nodeBin)) {
                    warn(
                        `hook command bakes a node binary that no longer exists (legacy pre-wrapper install): ${nodeBin}`,
                    );
                    warn(`  hooks will fail to spawn (ENOENT) — re-run install to migrate to the multi-path wrapper.`);
                    warnedAny = true;
                }
            }
        }
    }
    if (wrapperSeen.size > 0 && !wrapperMissing) {
        log(`hook wrapper script: present (${[...wrapperSeen].join(", ")})`);
    }
    if (!warnedAny && !wrapperMissing && seen.size > 0) {
        log(`hook baked node binary (legacy): present (${[...seen].join(", ")})`);
    }
}

/** Report extension.js patch health: patched flag, anchor count (A-only vs
 *  A+B), injected IIFE version + content-hash drift, and baked RES path
 *  staleness. Each line surfaces a separate detection result so a user
 *  inspecting --status knows exactly which axis is fresh vs. stale. */
function reportExtensionPatchHealth(extDir: string, extSrc: string): void {
    const patched = isExtensionPatched(extSrc);
    log(`extension.js patched: ${patched ? "YES" : "no"}`);
    if (!patched) return;
    // Anchor injection health: INJECT_MARKER appears once per injection site
    // (Anchor A always, Anchor B when present). 1 = A only (the blue-dot fix
    // is INACTIVE); 2 = A+B (fix active). A CC update that drifted Anchor B's
    // exact bytes leaves the user on the A-only path silently; this line
    // makes that downgrade visible so the user re-runs install.
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
    // Injected IIFE version + content-hash drift. The hash catches intra-
    // version drift (same INJECT_VERSION, body differs from buildIIFE()).
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
    // Stale baked RES path (e.g. a v0.1 install pointing at PROJECT_ROOT).
    const baked = bakedResPath(extSrc);
    if (baked === null) {
        log(`  baked RES: (not detectable)`);
    } else if (baked === RUNTIME_RES_DIR) {
        log(`  baked RES: ${baked} (matches INSTALL_DIR)`);
    } else {
        log(`  baked RES: ${baked} (STALE — expected ${RUNTIME_RES_DIR}; re-run to update)`);
    }
}

/** Report legacy-residue layers: the v0.1.2 webview aggregate bar and the
 *  v0.1.13 commandCenter package.json patch. Both are detected and surfaced
 *  so the user re-runs install to clean them. */
function reportLegacyResidue(extDir: string): void {
    const legacyBar = hasLegacyWebviewPatch(extDir);
    log(`legacy webview bar (v0.1.2): ${legacyBar ? "detected — re-run install to clean" : "clean"}`);
    const pkgPath = path.join(extDir, "package.json");
    const pkgSrc = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, "utf8") : "";
    const pkgStale = isPackageJsonPatched(pkgSrc);
    log(`package.json (v0.1.13 commandCenter residue): ${pkgStale ? "STALE — re-run install to clean" : "clean"}`);
}

/** Report on-disk hook script health: parses the
 *  `cc-status-dot-hook:vX.Y.Z:HASH` banner at the top of
 *  INSTALL_DIR/hooks/cc-status.js and surfaces EITHER a version mismatch
 *  (older writer contract) OR a hash mismatch (same version but drifted
 *  body). Mirrors the IIFE's stale-version + stale-hash surfacing so a
 *  stale hook against a fresh IIFE is no longer silent feature loss. */
function reportHookScriptHealth(): void {
    const installedHook = path.join(INSTALL_DIR, "hooks", "cc-status.js");
    if (!fs.existsSync(installedHook)) {
        log(`  hook script: (not installed — re-run install)`);
        return;
    }
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
            log(`  hook script: ${insVer} (STALE — expected ${HOOK_BANNER_PREFIX}${HOOK_VERSION}; re-run to refresh)`);
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
}

/** Report runtime files: hooks-wired flag, on-disk hook script health,
 *  SVG presence in RUNTIME_RES_DIR (NOT PROJECT_ROOT — the IIFE references
 *  the INSTALL_DIR path, so a fallback to the source copy would hide a real
 *  "icons will go blank" risk), install dir + state dir presence. */
function reportRuntimeFiles(): void {
    log(`hooks wired: ${isHooksWired() ? "YES" : "no"}`);
    reportHookScriptHealth();
    checkSvgs(RUNTIME_RES_DIR);
    log(
        `runtime install dir: ${INSTALL_DIR} ${fs.existsSync(INSTALL_DIR) ? "(exists)" : "(will be created on install)"}`,
    );
    log(`state dir: ${STATE_DIR} ${fs.existsSync(STATE_DIR) ? "(exists)" : "(will be created on first hook fire)"}`);
    reportBakedNodeHealth();
}

function reportStatus(): void {
    const { dir, version } = discoverExtension();
    log(`CC extension: v${version}`);
    log(`  ${dir}`);
    // Surface the CC version against which the anchor strings were last
    // verified byte-exact. install does NOT hard-gate against older/newer CC —
    // the countOccurrences==1 anchor check is the actual safety net — but a
    // user inspecting --status after a CC upgrade can see whether their
    // running CC matches the verified baseline or is in untested-but-anchor-
    // stable territory.
    if (version !== LAST_VERIFIED_CC) {
        log(
            `  last verified: ${LAST_VERIFIED_CC} (CC ${version} is untested — anchors may still match, install proceeds if countOccurrences==1)`,
        );
    } else {
        log(`  last verified: ${LAST_VERIFIED_CC} (matches)`);
    }
    const extJs = path.join(dir, "extension.js");
    const extSrc = fs.existsSync(extJs) ? fs.readFileSync(extJs, "utf8") : "";
    reportExtensionPatchHealth(dir, extSrc);
    reportLegacyResidue(dir);
    reportRuntimeFiles();
    reportCompanionStatus();
}

function printHelp(): void {
    console.log(
        [
            "cc-status-dot patcher",
            "",
            "Usage:",
            "  vscode-claude-code-status-dot                  install patch + wire hooks (idempotent)",
            "  vscode-claude-code-status-dot --patch-only     re-apply ONLY the extension.js patch (used by the companion; skips hooks/runtime/companion install)",
            "  vscode-claude-code-status-dot --revert         restore extension.js + package.json (cleans v0.1.13 commandCenter residue + legacy v0.1.2 webview), remove hooks + runtime copy",
            "  vscode-claude-code-status-dot --status         show detection results, change nothing",
            "  vscode-claude-code-status-dot --help           this message",
            "",
            "  (from source, replace the command with: npx tsx patch.ts)",
            "",
            "Runtime files (resources/*.svg, hooks/cc-status.js) are copied to:",
            "  " + INSTALL_DIR,
            "",
            "After install/revert, reload VS Code: Cmd+Shift+P (macOS) / Ctrl+Shift+P (Win/Linux) → 'Developer: Reload Window'.",
        ].join("\n"),
    );
}

function reloadHint(): void {
    // v0.2.0: cross-platform shortcut hint. Cmd+Shift+P on macOS, Ctrl+Shift+P
    // everywhere else (Win/Linux). Older builds printed a Mac-only hint that
    // Win/Linux users saw verbatim — accurate shortcut matters because this is
    // the only on-screen instruction the user gets after install/revert.
    const palette = process.platform === "darwin" ? "Cmd+Shift+P" : "Ctrl+Shift+P";
    log(`Done. Reload VS Code to apply: ${palette} → 'Developer: Reload Window'.`);
}

// ---------------------------------------------------------------------------
// Self-test I/O — fixture corpus for the pure patcher functions.
//
// Invoked via `--self-test-io`. Emits a JSON array of { name, pass, expected,
// actual } rows; hooks/test-patcher-io.mjs parses the array and asserts every
// row pass===true. Closes the e2e-review HIGH gap: wireHooks /
// commitSettingsSurgically / surgicalSetTopLevelKey / surgicalRemoveTopLevelKey
// / stripJsonc / parseJsonc had ZERO automated coverage, so a 4-line unit test
// over `,}` inside a string would have caught the trailing-comma regex
// string-boundary bug that corrupted user settings.json before this round.
//
// Fixtures live IN patch.ts (not in the test file) because the functions under
// test are module-private; exposing them via `export` would widen the public
// API for a dev-only need. The test driver stays trivial (spawn + parse JSON).
// ---------------------------------------------------------------------------

interface SelfTestRow {
    name: string;
    pass: boolean;
    expected: string;
    actual: string;
}

function runSelfTestIo(): void {
    const rows: SelfTestRow[] = [];
    const eq = (name: string, expected: unknown, actual: unknown): void => {
        const e = JSON.stringify(expected);
        const a = JSON.stringify(actual);
        rows.push({ name, pass: e === a, expected: e, actual: a });
    };

    // --- stripJsonc: comments stripped, strings preserved ---
    // Note: the scanner removes only the comment bytes themselves; surrounding
    // whitespace + the newline that terminates a // comment are preserved
    // byte-for-byte (this is intentional — surgicalSetTopLevelKey relies on
    // the scanner leaving the file's overall layout alone).
    eq("stripJsonc strips // line comment but keeps newline", `{ "a": 1 \n }`, stripJsonc(`{ "a": 1 // hello\n }`));
    eq("stripJsonc strips /* block comment */ bytes only", `{ "a": 1  }`, stripJsonc(`{ "a": 1 /* hello */ }`));
    // CRITICAL regression: a `,}` substring inside a string literal MUST be
    // preserved byte-for-byte. The pre-fix post-pass regex dropped the comma.
    // Use a content-agnostic fixture (X,}Y) so the assertion is unambiguous
    // about what is being protected: the literal substring `,}` inside a
    // JSON string value.
    eq(
        "stripJsonc preserves ',}' inside a string (regex char class / JSON arg)",
        `{"x":"X,}Y"}`,
        stripJsonc(`{"x":"X,}Y"}`),
    );
    eq("stripJsonc preserves ',]' inside a string", `{"x":"X,]Y"}`, stripJsonc(`{"x":"X,]Y"}`));
    eq("stripJsonc preserves ',}' at string boundaries", `{"x":",}a"}`, stripJsonc(`{"x":",}a"}`));
    // Trailing-comma tolerance still works at the syntax level.
    eq("stripJsonc tolerates trailing comma in object", `{"a":1}`, stripJsonc(`{"a":1,}`));
    eq("stripJsonc tolerates trailing comma in array", `{"a":[1,2]}`, stripJsonc(`{"a":[1,2,]}`));
    eq("stripJsonc tolerates trailing comma with whitespace", `{"a":1   }`, stripJsonc(`{"a":1 ,  }`));
    eq("stripJsonc tolerates trailing comma with block comment between", `{"a":1  }`, stripJsonc(`{"a":1, /* c */ }`));
    eq("stripJsonc tolerates trailing comma with line comment between", `{"a":1 \n }`, stripJsonc(`{"a":1, // c\n }`));
    // CRITICAL regression guard: a comma OUTSIDE a string but immediately
    // followed by a string-value whose first char is `}` (extremely contrived
    // but pins the string/syntax boundary).
    eq(
        "stripJsonc leaves comma before a string-value that starts with }",
        `{"a":1,"x":"}leaf"}`,
        stripJsonc(`{"a":1,"x":"}leaf"}`),
    );

    // --- parseJsonc: JSONC → object ---
    eq("parseJsonc parses trailing comma", { a: 1 }, parseJsonc(`{"a":1,}`, "test"));
    eq("parseJsonc parses comments", { a: 1, b: "2" }, parseJsonc(`{ "a": 1, // x\n "b": "2" /* y */ }`, "test"));
    eq(
        "parseJsonc preserves string with ,} substring (regex char class)",
        { x: "X,}Y" },
        parseJsonc(`{"x":"X,}Y"}`, "test"),
    );
    eq("parseJsonc preserves string with ,] substring (JSON arg)", { x: "X,]Y" }, parseJsonc(`{"x":"X,]Y"}`, "test"));

    // --- surgicalSetTopLevelKey: byte-preserving splice ---
    // Replace existing key — surrounding comments + sibling keys preserved.
    {
        const src = `{
  // my config
  "a": 1,
  "hooks": { "old": true },
  "b": 2
}`;
        const want = `{
  // my config
  "a": 1,
  "hooks": {"new":true},
  "b": 2
}`;
        eq(
            "surgicalSetTopLevelKey replaces value, preserves surroundings",
            want,
            surgicalSetTopLevelKey(src, "hooks", `{"new":true}`),
        );
    }
    // Insert absent key — adds after opening brace.
    {
        const src = `{\n  "a": 1\n}`;
        const want = `{\n  "hooks": {"x":1},\n  "a": 1\n}`;
        eq("surgicalSetTopLevelKey inserts new key after brace", want, surgicalSetTopLevelKey(src, "hooks", `{"x":1}`));
    }
    // Insert into empty object.
    eq(
        "surgicalSetTopLevelKey inserts into empty object",
        `{\n  "hooks": {"x":1},}`,
        surgicalSetTopLevelKey(`{}`, "hooks", `{"x":1}`),
    );

    // --- surgicalRemoveTopLevelKey: byte-preserving deletion ---
    {
        const src = `{
  "a": 1,
  "hooks": { "old": true },
  "b": 2
}`;
        const want = `{
  "a": 1,
  "b": 2
}`;
        eq("surgicalRemoveTopLevelKey removes key + trailing comma", want, surgicalRemoveTopLevelKey(src, "hooks"));
    }
    // Remove absent key is a no-op.
    {
        const src = `{"a":1}`;
        eq("surgicalRemoveTopLevelKey absent key is a no-op", src, surgicalRemoveTopLevelKey(src, "hooks"));
    }
    // Remove last key with trailing comma doesn't leave a dangling comma.
    // (The splice removes the `,"hooks":{...}` token range but leaves the
    // preceding `,` if any; this is acceptable — JSONC tolerates it.)
    {
        const src = `{"a":1, "hooks":{"x":1},}`;
        const want = `{"a":1,}`;
        eq(
            "surgicalRemoveTopLevelKey removes last-member trailing comma",
            want,
            surgicalRemoveTopLevelKey(src, "hooks"),
        );
    }

    // --- cmpSemver / cmpVer / cmpVerStr ---
    eq("cmpSemver equal", 0, cmpSemver("1.2.3", "1.2.3"));
    eq("cmpSemver a>b (major)", 1, Math.sign(cmpSemver("2.0.0", "1.9.9")));
    eq("cmpSemver a<b (patch)", -1, Math.sign(cmpSemver("1.0.0", "1.0.1")));
    eq("cmpSemver missing segment treated as 0", 0, cmpSemver("1.2", "1.2.0"));
    eq("cmpSemver X.Y vs X.Y.Z", -1, Math.sign(cmpSemver("1.2", "1.2.1")));
    eq("cmpVer [1,2,3] vs [1,2,3]", 0, cmpVer([1, 2, 3], [1, 2, 3]));
    eq("cmpVer [2,0] vs [1,9,9]", 1, Math.sign(cmpVer([2, 0], [1, 9, 9])));
    eq("cmpVerStr equal", 0, cmpVerStr("0.2.0", "0.2.0"));
    eq("cmpVerStr a>b", 1, Math.sign(cmpVerStr("0.2.0", "0.1.99")));
    eq("cmpVerStr a<b", -1, Math.sign(cmpVerStr("0.1.18", "0.2.0")));

    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
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
    if (args.includes("--self-test-io")) {
        // Dev: run the patcher's pure I/O functions (stripJsonc / parseJsonc /
        // surgicalSetTopLevelKey / surgicalRemoveTopLevelKey / cmpSemver /
        // cmpVer) over a fixed fixture corpus and emit a JSON array of
        // { name, pass, expected, actual } rows. hooks/test-patcher-io.mjs
        // invokes this and asserts every row is `pass:true` — the patcher's
        // I/O surface had ZERO automated coverage before this gate (e2e
        // review HIGH finding), so silent regressions in the JSONC editor
        // (e.g. the trailing-comma regex string-boundary bug that corrupted
        // user settings.json strings containing `,}`) shipped uncaught.
        runSelfTestIo();
        return;
    }
    if (args.includes("--status")) {
        reportStatus();
        return;
    }
    if (args.includes("--patch-only")) {
        // v0.2.0: companion-only entry. Runs ONLY discoverExtension +
        // patchExtension. Deliberately skips installRuntimeFiles / wireHooks /
        // installNodeWrapper / installCompanion — the companion re-execs this
        // at every VS Code startup and we must NOT re-run installNodeWrapper
        // (would bake the EH's Electron path into the wrapper), re-spawn N
        // `code --install-extension` calls (freezes the EH), or duplicate I/O
        // that already ran at the user's last `npx` install.
        //
        // Output discipline: emit only the lines companion/extension.ts parses
        // for its post-verify + reload UI:
        //   - "patched extension.js (anchors injected: A only)"  → work done, partial
        //   - "patched extension.js (anchors injected: A+B)"     → work done, full
        //   - "extension.js already patched — skipping injection" → no-op (fresh)
        //   - "updated stale baked RES path: …"                   → work done (RES only)
        //   - "[WARN] Anchor B not found …"                       → warning (downgrade UI)
        // patchExtension itself is idempotent — fresh installs log "already
        // patched — skipping" and exit 0 with zero disk writes, so the
        // companion can safely run this on EVERY startup without a separate
        // marker check (the companion still pre-checks the marker to avoid
        // the ~300ms spawn in the steady state — see extension.ts).
        const { dir, version } = discoverExtension();
        log(`CC extension v${version}: ${dir}`);
        patchExtension(dir);
        // After a successful patch, write the cross-window reload signal so
        // companion instances in OTHER still-running VS Code windows can detect
        // the change and prompt their users to reload. anchorB is parsed from
        // the on-disk marker count (2 = A+B applied, 1 = A only). source =
        // "companion" when triggered by the companion (we can't tell from here
        // who invoked us, so we look at the CCSD_INVOKED_BY_COMPANION env var
        // the companion sets before spawning us — see companion/extension.ts).
        try {
            const extJsPath = path.join(dir, "extension.js");
            const extSrc = fs.existsSync(extJsPath) ? fs.readFileSync(extJsPath, "utf8") : "";
            const markerN = countOccurrences(extSrc, INJECT_MARKER);
            const anchorB = markerN >= 2;
            const source: "companion" | "npx" = process.env.CCSD_INVOKED_BY_COMPANION === "1" ? "companion" : "npx";
            writeRepatchFlag(dir, anchorB, source);
        } catch (e) {
            // Non-fatal — extension.js is already patched; only the cross-window
            // signal is lost. Other windows will catch up on their own reload.
            warn(`failed to write repatch flag (non-fatal): ${(e as Error).message ?? String(e)}`);
        }
        return;
    }
    if (args.includes("--revert")) {
        log("Reverting…");
        const { dir, version } = discoverExtension();
        log(`CC extension v${version}: ${dir}`);
        // Per-step error isolation: each revert step runs in its own try/catch
        // so a failure in one (e.g. .bak read failure, EACCES, disk full) does
        // NOT skip the remaining steps. Without this, a step-1 throw would exit
        // the process with extension.js restored but hooks still wired and
        // INSTALL_DIR still present — a mixed state where the writer keeps
        // spawning with no reader. Best-effort + per-step summary at the end.
        const failures: string[] = [];
        const steps: Array<[string, () => void]> = [
            ["restoreExtension", () => restoreExtension(dir)],
            ["restoreWebview", () => restoreWebview(dir)],
            ["restorePackageJson", () => restorePackageJson(dir)],
            ["unwireHooks", () => unwireHooks()],
            // v0.2.0: also uninstall the companion .vsix from every detected
            // VS Code-family CLI. Best-effort — failures are warned, never
            // fatal (an already-uninstalled extension is the desired state).
            ["uninstallCompanion", () => uninstallCompanion()],
            // Remove our persistent runtime copy (resources + hook). STATE_DIR
            // holds per-session USER DATA and is intentionally kept.
            ["removeInstallDir", () => removeInstallDir()],
        ];
        for (const [name, fn] of steps) {
            try {
                fn();
            } catch (e) {
                failures.push(name);
                log(
                    `[WARN] revert step "${name}" failed: ${(e as Error).message || String(e)} — continuing with remaining steps`,
                );
            }
        }
        log(`Per-session state dir left in place (user data): ${STATE_DIR}`);
        reportResidualBaks(dir);
        if (failures.length > 0) {
            log(
                `[WARN] revert INCOMPLETE — these steps failed: ${failures.join(", ")}. Re-run \`npx vscode-claude-code-status-dot --revert\` to retry.`,
            );
        }
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
    // Architecture fix: mirror --revert's per-step isolation onto install.
    // wireHooks can throw (read-only settings.json, EACCES, disk full, corrupt
    // JSONC, parseJsonc->fail). Without rollback, an exception here would leave
    // extension.js patched (reader IIFE active) with NO writer wired — the SBI
    // would render ⚪0🟡0🔵0🔴0 forever and no per-tab dots. The .bak written
    // inside injectFresh() is the original unpatched CC bytes, so restoreExtension
    // makes install atomic: either BOTH reader+writer land or neither does.
    // Best-effort rollback (restoreExtension itself wrapped) — even if rollback
    // fails the user is no worse off than today, and the explicit fail() below
    // tells them to run `--revert` to clean up manually.
    try {
        wireHooks();
    } catch (e) {
        const msg = (e as Error).message || String(e);
        log(`[WARN] wireHooks failed (${msg}) — rolling back extension.js patch for atomic install`);
        try {
            restoreExtension(dir);
        } catch (rollbackErr) {
            log(
                `[WARN] extension.js rollback failed (${(rollbackErr as Error).message || String(rollbackErr)}) — extension.js still patched; run \`npx vscode-claude-code-status-dot --revert\` to clean up manually`,
            );
        }
        fail(
            `Failed to wire hooks: ${msg}. settings.json may be read-only, EACCES, disk full, or corrupt JSONC — resolve and re-run \`npx vscode-claude-code-status-dot\`.`,
        );
    }
    checkSvgs(RUNTIME_RES_DIR);
    // v0.2.0: also install the companion .vsix into every detected VS Code-
    // family CLI. Best-effort — failure here does NOT roll back the patch
    // (the IIFE patch is the critical surface; the companion is a convenience
    // that auto-re-applies this patch after a CC auto-update). installCompanion
    // is non-throwing.
    try {
        installCompanion();
    } catch (e) {
        warn(`companion install failed (non-fatal): ${(e as Error).message ?? String(e)}`);
    }
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
