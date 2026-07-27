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
// v0.2.4 round-2 (ARCH-1 first slice): pure helpers extracted to src/ modules.
// The IIFE body in buildIIFE stays in patch.ts (must be a single self-contained
// string for injection into CC's extension.js — see buildIIFE commentary).
// Subsequent slices (vscode-cli / companion-install / hooks-wire / install /
// status / cli) can ship one per round; this round lands the three pure-logic
// slices that have NO I/O or closure dependencies.
//
// v0.2.4 round-3 (architecture LOW cleanup): dropped unused re-exports.
// After the ARCH-1 extraction patch.ts only calls the HIGH-level wrappers
// (stripJsonc / surgicalSetTopLevelKey / surgicalRemoveTopLevelKey / cmpVerStr);
// the LOW-level helpers (skipWsAndComments / scanJsonValueEnd / findTopLevelKey
// / KeyRange) are now used ONLY inside their src/ modules and no longer need
// re-exposure at the patch.ts import surface. Removing them keeps `npx tsc
// --noUnusedLocals` clean (the project tsconfig doesn't enforce it today, but
// a future tightening would otherwise flag TS6133 on these 4 symbols — they
// appear only in comments here).
import { cmpVerStr } from "./src/semver.js";
import { stripJsonc } from "./src/jsonc.js";
import { surgicalSetTopLevelKey, surgicalRemoveTopLevelKey } from "./src/surgical-json.js";

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
const INJECT_VERSION = "v0.5.38";

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
const HOOK_VERSION = "v0.2.1";
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

// --- v0.2.4: writer↔reader contract constants (single source of truth) -----
// These mirror the writer's same-named consts in hooks/cc-status.js. The
// writer is a standalone .js (no import from this ESM patcher), so each side
// holds a copy — hooks/test-contract-sync.mjs pins the literal values so
// drift fails CI. Any contract change touches BOTH files in lockstep.

/** Token-stats window keys + insertion order. The writer (TOK_WIN_KEYS in
 *  cc-status.js) derives TOK_WINDOWS from this same array; the reader IIFE
 *  bakes the array (via JSON.stringify) into both the QuickPick detail string
 *  and the picker list. Pre-v0.2.4 each of the 5 sites (writer TOK_WINDOWS,
 *  writer docstring, IIFE detail string, IIFE picker list, test corpus)
 *  hard-coded the sequence independently — a 6th-window add (e.g. '15min')
 *  would have required hunting 5 sites. Now the IIFE sites derive from this
 *  const; the writer derives from its own copy; the test corpus is the
 *  cross-file pin. */
const TOK_WIN_KEYS = ["5min", "10min", "1h", "24h", "3d", "7d", "30d", "all"] as const;

/** Token-stats window key → millisecond span. Mirrors the writer's TOK_WINDOWS
 *  in hooks/cc-status.js (line 503) — the writer is the source of truth for
 *  the bucket cutoff (deriveTokensField iterates TOK_WINDOWS via Object.keys,
 *  cc-status.js:754-756). The IIFE needs the SAME ms values so its live-delta
 *  reader (computeLiveDelta) can apply an IDENTICAL time-window filter to the
 *  bytes it reads from the parent transcript — otherwise the IIFE's rolling-
 *  window dSum includes bytes OUTSIDE the window the hook used for its bucket
 *  sum, double-counting against a long streaming turn that spans past the
 *  rolling window edge (v0.2.5 round-3 MEDIUM fix). "all" maps to Infinity
 *  (cumulative — no filtering), mirroring the hook's `ms === Infinity ?
 *  -Infinity : now - ms` cutoff rule. Not referenced from TS code (only baked
 *  into the IIFE); hooks/test-contract-sync.mjs pins the values against the
 *  writer's TOK_WINDOWS so a future tuning edit (e.g. 15min) touching only
 *  one side fails CI. */
const TOK_WIN_MS: Record<(typeof TOK_WIN_KEYS)[number], number> = {
    "5min": 5 * 60 * 1000,
    "10min": 10 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "3d": 3 * 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    all: Infinity,
};

/** Extension for the per-source byte-offset sidecar (writer↔reader contract).
 *  The writer (TOK_OFFSET_EXT in cc-status.js) writes JSON to this file; the
 *  IIFE reader never reads it (only the writer does). v0.2.4 round-3
 *  (business-logic MEDIUM fix): the QuickPick "Reset session stats" handler
 *  NO LONGER deletes `<sid>.offset` — deleting it zeroed ctx.buckets on the
 *  next fire, so the forceFull subagent-preservation filter (`b.src &&
 *  b.src !== 'main'`) operated on an empty array and already-merged subagent
 *  tokens (SubagentStop fires once per subagent, no replay) were permanently
 *  lost. Reset now writes only `<sid>.forcereread; the offset sidecar stays
 *  intact so the preservation filter has subagent buckets to keep.
 *
 *  This const is kept as a CONTRACT-SURFACE declaration: hooks/test-contract-
 *  sync.mjs pins its value against the writer's TOK_OFFSET_EXT via source
 *  regex extraction, so any future rename on the writer side would otherwise
 *  silently desync the reader's GC pruning (which derives the .offset
 *  basename from this const). It is therefore intentionally NOT referenced
 *  from TS code right now — if a future feature (e.g. an "Open state dir"
 *  deep-link to the sidecar) re-references it, point the use here; if
 *  `noUnusedLocals` is later tightened, prefer `export`-ing this const over
 *  deleting it (the test relies on the source-text match).
 *
 *  v0.2.5 round-3 (MEDIUM): the IIFE's computeLiveDelta references this
 *  extension via a JSON.stringify'd literal baked into the IIFE bytes
 *  (tokOffsetExtLiteral below, mirroring tokForceRereadExtLiteral). The
 *  earlier round-3 comment said "no longer bake tokOffsetExtLiteral" — that
 *  was correct at the time because the QuickPick reset had stopped touching
 *  .offset, but it ignored that computeLiveDelta still hard-coded ".offset"
 *  as a raw string, breaking the single-source-of-truth discipline the
 *  other contract strings (tokForceRereadExtLiteral, tokWinKeysLiteral)
 *  enforce. We re-bake now so a future rename of TOK_OFFSET_EXT touches the
 *  IIFE bytes automatically (the cross-file contract test catches a writer
 *  rename; this catches the IIFE drift on the reader side). */
const TOK_OFFSET_EXT = ".offset";

/** Extension for the "force full re-read next fire" marker (writer↔reader
 *  contract). The QuickPick reset handler writes a `<sid>.forcereread` marker;
 *  the writer's TOK_EVENTS branch consumes it on the next fire. The writer
 *  also GCs stale markers under the same name. Naming it here + baking into
 *  the IIFE makes a future rename touch both sides at once. */
const TOK_FORCEREREAD_EXT = ".forcereread";

/** Extension for the independent token-snapshot file (writer↔reader contract).
 *  v0.2.7 (Q1 fix): the hook writes `<sid>.tokens.json` on every TOK_EVENT
 *  fire alongside `<sid>.json`. The IIFE reader (readTok below) prefers this
 *  file when present and falls back to `<sid>.json` for backward compat.
 *  Survival contract: `<sid>.tokens.json` survives SessionEnd (the GC sweep
 *  reclaims it on the same mtime schedule as .offset / .forcereread). This
 *  closes the post-VSCode-restart 0-window: the first IIFE tick on resume
 *  reads non-zero token count BEFORE any TOK_EVENT fire. Single source of
 *  truth: this const + the writer's TOK_TOKENS_EXT are pinned by
 *  hooks/test-contract-sync.mjs. */
const TOK_TOKENS_EXT = ".tokens.json";

/** Interrupted-state retention threshold (writer↔reader contract, §7.5).
 *  Crashed/killed CC sessions whose writer wrote state=interrupted never send
 *  SessionEnd, so without a retention heuristic the 🔴 light would grow
 *  monotonically. The reader (IIFE) decays interrupted files older than this
 *  to idle for COUNTING (file is NOT deleted — diagnostic value preserved).
 *  The writer GC reclaims interrupted files from disk at the SAME threshold
 *  (§7.5 contract: GC threshold === reader decay threshold — if they
 *  diverge, the reader would idle-mark files the writer hasn't reclaimed, or
 *  the writer would reclaim files the reader still counts).
 *
 *  v0.2.4 round-2 (ARCH-6): hoisted to a NAMED top-level const so the IIFE
 *  baked literal below derives from it via template substitution (mirrors
 *  the existing TOK_WIN_KEYS / TOK_OFFSET_EXT pattern). Both files still
 *  hold the literal value, but patch.ts's copy is now the one authoritative
 *  source for the IIFE; hooks/test-contract-sync.mjs pins the cross-file
 *  equality so a future tuning edit (e.g. 48h) that touches only one side
 *  fails CI. 24h >> SBI_RUNNING_STALE_MS (30min) because interrupted is a
 *  terminal state the user may want to inspect long after the fact.
 *
 *  v0.2.7 (Q2 interrupted sticky): extended from 24h to 7d. User report
 *  "interrupted 红色自己消了" had this decay as one of three suspects — 24h
 *  was borderline for cross-day workflows. 7d keeps the 🔴 sticky for
 *  "is the issue still open this week?" while still bounding disk residue
 *  from abandoned crashes (research warned unbounded growth if cancelled
 *  entirely). Mirrors GC_DRIFT_SINCE_MS for a single coherent "stale
 *  terminal session" horizon on both the interrupted-preservation path
 *  (§7.5) and the drift-prune path (§7.5 contract). */
const INTERRUPTED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Done-state to idle decay threshold (writer↔reader contract, §4).
 *  Reader-side: a `done` session older than this decays to idle for COUNTING
 *  (the green 🟢 light only reflects ACTIVELY-done sessions; a session done
 *  10min ago no longer counts toward 🟢). The value is pinned via the same
 *  cross-file contract as INTERRUPTED_RETENTION_MS — hooks/test-contract-sync.mjs
 *  asserts equality. 5min is the published §4 reader rule; the writer does
 *  not have its own decay threshold for done (it just writes state=done and
 *  lets the reader apply the rule). */
const DONE_TO_IDLE_MS = 5 * 60 * 1000;

/** Stale-running heuristic threshold (writer↔reader contract, §7.2).
 *  Reader-side: SBI aggregation decay — a `running` file whose `since` is older
 *  than this decays to idle for COUNTING (the 🟡 light only reflects sessions
 *  that transitioned to running within this window). v0.2.6 round-1 fix: keys
 *  off `since` (the *→running transition timestamp), NOT mtime — the prior
 *  mtime-based rule was defeated by cc-status.js Stop preserveSince path
 *  (Stop inflight>0 keeps state="running" + cur.since but writeJsonAtomic
 *  refreshes mtime on every Stop heartbeat; CC re-fires Stop on inflight
 *  workflows, so mtime stays fresh forever and the 30min clock never elapsed).
 *  30min chosen because PreToolUse fires every ~30s during active tool use,
 *  so a 30min `since` gap is unambiguous evidence of a dead/drifted session.
 *  Pinned via hooks/test-contract-sync.mjs.
 *
 *  v0.5.2 (#4): this is now the SOLE running-decay threshold — used by BOTH
 *  the §F aggregate tick AND the §H per-tab tick (the prior SINCE_STALE_MS
 *  15min per-tab constant is retired). Both surfaces also gate the
 *  running→idle downgrade on __ccsdTranscriptFresh (the transcript .jsonl
 *  mtime): a session whose transcript grew within this window is actively
 *  streaming, so a stale `since` alone no longer false-decays a genuinely
 *  active long workflow / subagent-waiting parent. The tab and the bottom 🟡
 *  therefore share ONE threshold + ONE activity predicate and can no longer
 *  disagree in a 15-30min window. The since-based stuck-drift catch is
 *  preserved (drifted Stop heartbeats refresh the state-file mtime but NOT
 *  the transcript → stale transcript → decay still fires). */
const SBI_RUNNING_STALE_MS = 30 * 60 * 1000;

/** Persistent runtime install dir. A copy of resources/*.svg + hooks/cc-status.js
 *  lives here so the patched extension and the CC hook keep working even if the
 *  source project dir is removed or the npx cache is purged. The injected IIFE
 *  references INSTALL_DIR/resources (baked in at patch time), and the wired hook
 *  command points at INSTALL_DIR/hooks/cc-status.js.
 *
 *  Distinct from STATE_DIR (~/.claude/cc-tab-status/) which is per-session USER
 *  DATA and is NOT touched by install / --revert.
 *
 *  v0.2.8 round-1 (MEDIUM): CCSD_INSTALL_DIR env override. Production callers
 *  NEVER set this — INSTALL_DIR resolves to ~/.claude/cc-status-dot as always.
 *  The override exists purely so hooks/test-standalone-patch.mjs can drive the
 *  real installCompanion() copy path into a sandbox tmp dir (instead of manually
 *  mirror-copying and bypassing installCompanion, which left the v0.2.7 bug
 *  covered). The override is consumed at process start (here) so every downstream
 *  reference (RUNTIME_RES_DIR, COMPANION_CONFIG_PATH, LAST_REPATCH_PATH, the
 *  status reporter) tracks it automatically. */
const INSTALL_DIR: string = process.env.CCSD_INSTALL_DIR
    ? path.resolve(process.env.CCSD_INSTALL_DIR)
    : path.join(os.homedir(), ".claude", "cc-status-dot");

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
const OUR_SVGS = [
    "claude-logo-idle.svg",
    "claude-logo-running.svg",
    "claude-logo-done.svg",
    "claude-logo-error.svg",
    "claude-logo-pending.svg",
    // v0.5.0 — favorited-session variants (gold underline at viewBox bottom).
    //   installRuntimeFiles auto-copies these via the OUR_SVGS loop; stale-sweep
    //   auto-preserves them via the OUR_SVGS.includes() guard. Base 5 unchanged.
    "claude-logo-idle-fav.svg",
    "claude-logo-running-fav.svg",
    "claude-logo-done-fav.svg",
    "claude-logo-error-fav.svg",
    "claude-logo-pending-fav.svg",
];

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
 *  wiring, audit F-5).
 *
 *  v0.2.9 adds `PostCompact`: CC fires this after /compact (or auto-compact)
 *  finishes. /compact aborts the in-flight turn → CC fires StopFailure (the
 *  SOLE interrupted writer) → without a clear, Q2's preserveInterrupted
 *  branch in Stop keeps the 🔴 sticky until the next UserPromptSubmit. The
 *  writer's PostCompact case clears interrupted → done so compact is NOT
 *  miscounted as a real failure. SessionStart stays excluded (audit F-5
 *  intact); PostCompact is no longer dead wiring. */
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
    "PostCompact",
] as const;

// ---------------------------------------------------------------------------
// SBI 4-light definitions (visual rationale: see docs/STATES.md §7 + CHANGELOG.md)
// ---------------------------------------------------------------------------

/** v0.2.3 — companion VS Code extension (NOT published to Marketplace; shipped
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
 *  SBI_DIM_EM is ⚪ (U+26AA, Miscellaneous Symbols) — v0.2.3 reverted the
 *  v0.1.17 ⚪→🟤 pivot because the user prefers gray over brown (commit
 *  55e18b4). The 5 balls therefore span 3 Unicode blocks again
 *  (🟢🟡 Geometric Shapes Extended / 🔴🔵 Miscellaneous Symbols And
 *  Pictographs / ⚪ Miscellaneous Symbols). Theoretical cross-block width
 *  risk is the trade-off for the gray visual — empirically (实测), modern emoji fonts (Apple
 *  Color Emoji / Noto Color Emoji / Segoe UI Emoji) render every emoji at
 *  1em square regardless of block, so the risk is latent rather than
 *  observable on mainstream fonts. The v0.1.17 ⚪→🟤 pivot's "guarantee
 *  equal width by Unicode-block allocation" argument is no longer in effect;
 *  see docs/STATES.md §7.5 for the v0.1.17 → v0.2.3 trail (pivot then
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
 *  (the user's "位置固定" (fixed-position) requirement covers BOTH per-light slot position
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
 *  width gamble; v0.2.3 reverted to ⚪ (commit 55e18b4) because the user
 *  prefers gray over brown. The cross-block width argument is now latent
 *  rather than enforced (modern emoji fonts render every emoji at 1em square
 *  regardless of block, so the practical risk is zero on mainstream fonts).
 *  See docs/STATES.md §7.5 for the full v0.1.17 → v0.2.3 trail. */
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
// v0.2.4: Token stats SBI (right-side, second SBI beside the 4-light aggregate)
// ---------------------------------------------------------------------------

/** Priority for the v0.2.4 token-stats StatusBarItem. Positioned at
 *  StatusBarAlignment.Right with priority -9995 so it sits as the rightmost
 *  Right-aligned item (closest to the visible center on the right half).
 *  Distinct side from the 4-light SBI (Left, -9996) so the two never collide
 *  regardless of how many other extensions contribute SBIs.
 *
 *  Rationale for Right side (vs another Left item beside the 4-light SBI):
 *  the 4-light SBI is the dominant "session overview" affordance and lives at
 *  Left -9996 (rightmost-of-Left); placing the token SBI on the Right gives
 *  the user a natural "left = sessions, right = cost" mental model and avoids
 *  visual contention at the same anchor. */
const TOK_SBI_PRIORITY = -9995;

/** Click-command id for the token SBI. Triggers the QuickPick config panel
 *  (window selector / display mode / notify toggle / sound / fast commands).
 *  Single source of truth — baked into the IIFE at the registerCommand site
 *  AND assigned to the token SBI's `.command` field. Mirrors SBI_CLICK_CMD's
 *  pattern. */
const TOK_CLICK_CMD = "ccStatusDot.tokClick";

// ---------------------------------------------------------------------------
// v0.4.0: Favorites session-focus command (companion ↔ IIFE EH bridge)
// ---------------------------------------------------------------------------
// The companion's Favorites tree wants to focus an already-open CC webview
// panel when the user clicks a session node. The IIFE holds the only ref to
// the panel (via t.panelTab inside the per-panel closure); the companion has
// no panel refs of its own. Two complementary channels exist (see
// docs/FAVORITES-DESIGN.md §4.1):
//   1. Shared globalThis — IIFE publishes `globalThis.__ccsdSidToPanel[sid] =
//      t.panelTab` in the §A preamble; the companion reads it directly (same
//      EH process, the bridge pattern already established for __ccsdSbi at
//      companion/extension.ts:621). PRIMARY path.
//   2. registerCommand — IIFE registers a command handler that does the
//      reveal; the companion calls it via
//      `vscode.commands.executeCommand("ccStatusDot.fav.focusSession", sid)`.
//      FALLBACK path — VSCode's command bridge handles the EH-boundary
//      orchestration if a future VSCode release splits EH per extension.
//      Mirrors the existing SBI_CLICK_CMD / TOK_CLICK_CMD pattern
//      (vs.commands.registerCommand needs NO package.json contribution).
// Like SBI_CLICK_CMD, this constant is the single source of truth baked into
// the IIFE at the registerCommand site AND surfaced to the companion via the
// shared command id string. Mirrors the SBI/Token click command discipline.
const FAV_FOCUS_CMD = "ccStatusDot.fav.focusSession";

// ---------------------------------------------------------------------------
// v0.2.4 (intra-version): QuickPick + token SBI tooltip i18n
// ---------------------------------------------------------------------------
// 8-language dictionary for every user-facing string in the QuickPick config
// panel (showTokQuickPick), the token SBI tooltip (§G tick), the threshold
// alert (dispatchNotify call), and the token-panel error fallback. The IIFE
// detects VSCode's UI language via `vs.env.language` (e.g. "zh-cn", "pt-br",
// "en", "ja"), lowercases it, and takes the primary subtag as LANG. Unknown
// languages fall back to English via the t() helper's `e[LANG]||e.en||k` chain.
//
// TERMINOLOGY (kept consistent across languages + with the 8 READMEs):
//   token  → token(zh, loanword — matches zh README which keeps it untranslated) /
//            トークン(ja) / Token(de/es/fr/pt/ru)
//   window → 窗口(zh) / ウィンドウ(ja) / Fenster(de) / ventana(es) /
//            fenêtre(fr) / janela(pt) / окно(ru)
//   cost   → 费用(zh) / コスト(ja) / Kosten(de) / coste(es) /
//             coût(fr) / custo(pt) / стоимость(ru)
//   session→ 会话(zh) / セッション(ja) / Sitzung(de) / sesión(es) /
//             session(fr) / sessão(pt) / сессия(ru)
//
// NOT TRANSLATED (config values + SBI text units, consistent across locales):
//   - window KEYS: 5min/10min/1h/24h/3d/7d/30d/all
//   - display mode VALUES: token / cost / both
//   - sound names: Basso/Bell/Blow/.../Tink (macOS system sound identifiers)
//   - SBI text symbols: $(clock)/$(pulse)/$(eye)/emoji/numbers/units tok/$
//   - settings keys: ccStatusDot.*
//
// Placeholder convention: complex strings use {name} tokens resolved at call
// sites via .replace("{name}", value). This lets each language reorder the
// phrase naturally (e.g. ja "X トークンを...コピー" vs en "Token count copied: X")
// without string concatenation gymnastics. For counted nouns, the count is
// placed as a suffix after a colon so plural agreement is not load-bearing
// (see fbCopiedTpl) — English avoids "1 tokens", Russian avoids the
// 1-token / 2-tokensa / 5-tokensov count agreement.
//
// Source convention (mirrors SBI_LIGHTS_CFG): patch.ts SOURCE uses \u{XXXX}
// escapes for non-ASCII where readable (em dash —, middot ·); CJK characters
// appear literally in the source for translation-review readability. Both
// survive JSON.stringify unchanged into the baked IIFE bytes (VSCode parses
// the IIFE as UTF-8). The 8-language completeness is asserted in
// hooks/test-iife.mjs (IIFE.68-IIFE.71 series).
const I18N_LANGS = ["zh", "en", "ja", "de", "es", "fr", "pt", "ru"] as const;
type I18NLang = (typeof I18N_LANGS)[number];
type I18NEntry = Record<I18NLang, string>;
const I18N_DICT: Record<string, I18NEntry> = {
    // === QuickPick main panel (showTokQuickPick) ===
    qpPlaceHolder: {
        zh: "cc-status-dot — token 统计与配置",
        en: "cc-status-dot — token stats & config",
        ja: "cc-status-dot — トークン統計と設定",
        de: "cc-status-dot — Token-Statistiken & Konfiguration",
        es: "cc-status-dot — estadísticas de tokens y configuración",
        fr: "cc-status-dot — statistiques de tokens et configuration",
        pt: "cc-status-dot — estatísticas de tokens e configuração",
        ru: "cc-status-dot — статистика токенов и настройки",
    },
    qpStatsWindowLabel: {
        zh: "统计窗口：",
        en: "Statistics window: ",
        ja: "統計ウィンドウ：",
        de: "Statistik-Fenster: ",
        es: "Ventana de estadísticas: ",
        fr: "Fenêtre de statistiques : ",
        pt: "Janela de estatísticas: ",
        ru: "Окно статистики: ",
    },
    qpStatsWindowDetail: {
        // Singular form matches qpStatsWindowLabel ("Statistics window: ")
        // — both describe the same singular window the user is about to pick.
        // v0.2.5 round-2 (MEDIUM, window labeling): distinguish 'all'
        // (cumulative, never resets) from the rolling windows (5min..30d,
        // which slide old turns out and can look like a "reset"). This was
        // the exact user confusion point ("不是移动窗口设计吧?持续用会清零")
        // that problem 3b addressed — the prior detail label branded the
        // WHOLE list as "(rolling)" including 'all', which INVERTED the
        // clarification and reinforced the "all also clears" misconception.
        zh: "统计窗口：5min..30d 滚动（旧 turn 滑出，看起来像清零）/ all 累积（整会话不清零，默认）",
        en: "Statistics window: 5min..30d rolling (old turns slide out, can look like a reset) / all cumulative (whole session, never resets, default)",
        ja: "統計ウィンドウ：5min..30d ローリング（古い turn は滑り落ちる、「リセット」に見えることがある）/ all 累積（セッション全体、リセットなし、デフォルト）",
        de: "Statistik-Fenster: 5min..30d gleitend (alte Turns fallen heraus, sieht wie ein „Reset“ aus) / all kumulativ (ganze Sitzung, kein Reset, Standard)",
        es: "Ventana de estadísticas: 5min..30d móvil (los turnos antiguos se deslizan fuera, puede parecer un «reset») / all acumulativo (toda la sesión, sin reset, por defecto)",
        fr: "Fenêtre de statistiques : 5min..30d glissante (les anciens turns sortent de la fenêtre, peut ressembler à un « reset ») / all cumulatif (toute la session, jamais remis à zéro, par défaut)",
        pt: "Janela de estatísticas: 5min..30d móvel (turns antigos saem da janela, pode parecer um «reset») / all cumulativo (sessão inteira, nunca zera, padrão)",
        ru: "Окно статистики: 5min..30d скользящее (старые turn'ы уходят, выглядит как «сброс») / all накопительный (вся сессия, без сброса, по умолчанию)",
    },
    qpDisplayLabel: {
        zh: "显示：",
        en: "Display: ",
        ja: "表示：",
        de: "Anzeige: ",
        es: "Mostrar: ",
        fr: "Affichage : ",
        pt: "Exibição: ",
        ru: "Отображение: ",
    },
    qpDisplayDetail: {
        // option VALUES (token/cost/both) are not translated — identical across locales
        zh: "token / cost / both",
        en: "token / cost / both",
        ja: "token / cost / both",
        de: "token / cost / both",
        es: "token / cost / both",
        fr: "token / cost / both",
        pt: "token / cost / both",
        ru: "token / cost / both",
    },
    qpSbiVisibleLabel: {
        // "Indicator" (not the internal "SBI" abbreviation for VS Code's
        // StatusBarItem API) — end users do not know what an SBI is.
        zh: "token 指示器可见：",
        en: "Token indicator visible: ",
        ja: "トークン インジケーター 表示：",
        de: "Token-Indikator sichtbar: ",
        es: "Indicador de tokens visible: ",
        fr: "Indicateur de tokens visible : ",
        pt: "Indicador de tokens visível: ",
        ru: "Индикатор токенов виден: ",
    },
    qpOn: {
        zh: "开",
        en: "on",
        ja: "オン",
        de: "an",
        es: "activado",
        fr: "activé",
        pt: "ativo",
        ru: "вкл",
    },
    qpOff: {
        zh: "关",
        en: "off",
        ja: "オフ",
        de: "aus",
        es: "desactivado",
        fr: "désactivé",
        pt: "desativado",
        ru: "выкл",
    },
    qpNotifyCompletion: {
        zh: "完成时通知",
        en: "Notify on completion",
        ja: "完了時に通知",
        de: "Bei Abschluss benachrichtigen",
        es: "Notificar al finalizar",
        fr: "Notifier à l'achèvement",
        pt: "Notificar ao concluir",
        ru: "Уведомлять при завершении",
    },
    qpNotifyFocused: {
        zh: "聚焦时也通知",
        en: "Also notify when focused",
        ja: "フォーカス時も通知",
        de: "Auch im fokussierten Zustand benachrichtigen",
        es: "Notificar también cuando tiene el foco",
        fr: "Notifier même lorsque la fenêtre est au premier plan",
        pt: "Notificar também quando em foco",
        ru: "Уведомлять даже при активном окне",
    },
    qpSoundLabel: {
        zh: "声音：",
        en: "Sound: ",
        ja: "サウンド：",
        de: "Ton: ",
        es: "Sonido: ",
        fr: "Son : ",
        pt: "Som: ",
        ru: "Звук: ",
    },
    qpSessionTotalPrefix: {
        zh: "会话总计：",
        en: "Session total: ",
        ja: "セッション合計：",
        de: "Sitzungsgesamt: ",
        es: "Total de la sesión: ",
        fr: "Total de la session : ",
        pt: "Total da sessão: ",
        ru: "Итого за сессию: ",
    },
    qpSessionTotalDetail: {
        zh: "全量父会话 token 数（含子代理）",
        en: "all-time parent session tokens (incl. subagents)",
        ja: "全期間の親セッションのトークン数（サブエージェント含む）",
        de: "alle Tokens der Eltern-Sitzung (inkl. Subagenten)",
        es: "tokens de toda la sesión padre (incl. subagentes)",
        fr: "tokens de toute la session parente (incl. sous-agents)",
        pt: "tokens de toda a sessão pai (incl. subagentes)",
        ru: "все токены родительской сессии (вкл. подагентов)",
    },
    qpCost24hLabel: {
        zh: "24h：",
        en: "24h: ",
        ja: "24h：",
        de: "24h: ",
        es: "24h: ",
        fr: "24h : ",
        pt: "24h: ",
        ru: "24h: ",
    },
    qpCost24hDetail: {
        zh: "滚动 24h 费用",
        en: "rolling 24h cost",
        ja: "直近 24h のコスト",
        de: "gleitende 24h-Kosten",
        es: "coste de 24h (móvil)",
        fr: "coût sur 24h glissantes",
        pt: "custo de 24h (móvel)",
        ru: "скользящие затраты за 24ч",
    },
    qpCost7dLabel: {
        zh: "7 天：",
        en: "7-day: ",
        ja: "7 日：",
        de: "7 Tage: ",
        es: "7 días: ",
        fr: "7 jours : ",
        pt: "7 dias: ",
        ru: "7 дней: ",
    },
    qpCost7dDetail: {
        zh: "滚动 7 天费用",
        en: "rolling 7d cost",
        ja: "直近 7 日間のコスト",
        de: "gleitende 7-Tage-Kosten",
        es: "coste de 7 días (móvil)",
        fr: "coût sur 7 jours glissants",
        pt: "custo de 7 dias (móvel)",
        ru: "скользящие затраты за 7 дней",
    },
    qpCost30dLabel: {
        zh: "30 天：",
        en: "30-day: ",
        ja: "30 日：",
        de: "30 Tage: ",
        es: "30 días: ",
        fr: "30 jours : ",
        pt: "30 dias: ",
        ru: "30 дней: ",
    },
    qpCost30dDetail: {
        zh: "滚动 30 天费用",
        en: "rolling 30d cost",
        ja: "直近 30 日間のコスト",
        de: "gleitende 30-Tage-Kosten",
        es: "coste de 30 días (móvil)",
        fr: "coût sur 30 jours glissants",
        pt: "custo de 30 dias (móvel)",
        ru: "скользящие затраты за 30 дней",
    },
    qpCostPartialLabel: {
        zh: "费用估算不完整",
        en: "Cost estimate is partial",
        ja: "コスト見積りは一部です",
        de: "Kostenschätzung ist unvollständig",
        es: "La estimación de coste es parcial",
        fr: "L'estimation du coût est partielle",
        pt: "A estimativa de custo é parcial",
        ru: "Оценка стоимости неполная",
    },
    qpCostPartialDetail: {
        zh: "部分轮次无单价记录——显示的 $ 为下限",
        en: "some turns had no rate entry — displayed $ is a lower bound",
        ja: "一部のターンに単価記録がありません——表示の $ は下限です",
        de: "einige Durchläufe ohne Preis-Eintrag — angezeigter $ ist eine Untergrenze",
        es: "algunos turnos no tenían entrada de precio — el $ mostrado es un límite inferior",
        fr: "certains tours n'avaient pas d'entrée de tarif — le $ affiché est un minimum",
        pt: "alguns turnos sem entrada de taxa — o $ exibido é um limite inferior",
        ru: "некоторые ходы без записи тарифа — показанный $ — это нижняя граница",
    },
    qpTurnRunningTpl: {
        zh: "本轮运行：{secs}s",
        en: "Turn running: {secs}s",
        ja: "ターン実行中：{secs}s",
        de: "Durchlauf läuft: {secs}s",
        es: "Turno en ejecución: {secs}s",
        fr: "Tour en cours : {secs}s",
        pt: "Turno em execução: {secs}s",
        ru: "Ход выполняется: {secs}s",
    },
    qpTurnRunningDetail: {
        zh: "当前轮次开始至今的时长",
        en: "time since current turn started",
        ja: "現在のターン開始からの経過時間",
        de: "Zeit seit Start des aktuellen Durchlaufs",
        es: "tiempo desde que empezó el turno actual",
        fr: "temps écoulé depuis le début du tour actuel",
        pt: "tempo desde o início do turno atual",
        ru: "время с начала текущего хода",
    },
    qpCopyLabel: {
        zh: "复制 token 数",
        en: "Copy token count",
        ja: "トークン数をコピー",
        de: "Token-Anzahl kopieren",
        es: "Copiar recuento de tokens",
        fr: "Copier le nombre de tokens",
        pt: "Copiar contagem de tokens",
        ru: "Копировать количество токенов",
    },
    qpCopyDetail: {
        zh: "将全量会话 token 总数复制到剪贴板",
        en: "copy all-time session total to clipboard",
        ja: "全期間のセッション合計をクリップボードにコピー",
        de: "Sitzungs-Gesamtanzahl in die Zwischenablage kopieren",
        es: "copiar el total de tokens de la sesión al portapapeles",
        fr: "copier le total de tokens de la session dans le presse-papiers",
        pt: "copiar o total de tokens da sessão para a área de transferência",
        ru: "скопировать общее число токенов сессии в буфер обмена",
    },
    qpResetLabel: {
        zh: "重置会话统计",
        en: "Reset session stats",
        ja: "セッション統計をリセット",
        de: "Sitzungsstatistiken zurücksetzen",
        es: "Reiniciar estadísticas de la sesión",
        fr: "Réinitialiser les statistiques de session",
        pt: "Redefinir estatísticas da sessão",
        ru: "Сбросить статистику сессии",
    },
    qpResetDetail: {
        zh: "标记下次触发时全量重读（大型 transcript 约 1 秒）",
        en: "mark for full re-read next fire (~1s for large transcripts)",
        ja: "次回起動時にフル再読み込みをマーク（大きな transcript で約 1 秒）",
        de: "Vollständiges Neu-Einlesen beim nächsten Tick markieren (~1s für große Transkripte)",
        es: "marcar para relectura completa en el próximo disparo (~1s para transcripciones grandes)",
        fr: "marquer pour une relecture complète au prochain déclencheur (~1s pour les gros relevés)",
        pt: "marcar para releitura completa na próxima execução (~1s para transcrições grandes)",
        ru: "отметить для полного перечитывания при следующем запуске (~1с для больших транскриптов)",
    },
    qpOpenDirLabel: {
        zh: "打开状态目录",
        en: "Open state dir",
        ja: "状態ディレクトリを開く",
        de: "Status-Verzeichnis öffnen",
        es: "Abrir directorio de estado",
        fr: "Ouvrir le répertoire d'état",
        pt: "Abrir diretório de estado",
        ru: "Открыть папку состояния",
    },
    qpOpenDirDetail: {
        zh: "在文件管理器中显示 ~/.claude/cc-tab-status",
        en: "reveal ~/.claude/cc-tab-status in your file manager",
        ja: "~/.claude/cc-tab-status をファイルマネージャーで表示",
        de: "~/.claude/cc-tab-status im Dateimanager anzeigen",
        es: "mostrar ~/.claude/cc-tab-status en tu gestor de archivos",
        fr: "révéler ~/.claude/cc-tab-status dans votre gestionnaire de fichiers",
        pt: "revelar ~/.claude/cc-tab-status no seu gerenciador de arquivos",
        ru: "показать ~/.claude/cc-tab-status в файловом менеджере",
    },
    qpOpenSettingsLabel: {
        zh: "打开设置",
        en: "Open Settings",
        ja: "設定を開く",
        de: "Einstellungen öffnen",
        es: "Abrir configuración",
        fr: "Ouvrir les paramètres",
        pt: "Abrir configurações",
        ru: "Открыть настройки",
    },
    qpOpenSettingsDetail: {
        zh: "完整的 ccStatusDot.* 设置",
        en: "full ccStatusDot.* settings",
        ja: "ccStatusDot.* の全設定",
        de: "alle ccStatusDot.*-Einstellungen",
        es: "todos los ajustes de ccStatusDot.*",
        fr: "tous les paramètres ccStatusDot.*",
        pt: "todos os ajustes ccStatusDot.*",
        ru: "все настройки ccStatusDot.*",
    },

    // === Sub-picker placeHolders (二级 picker) ===
    spSelectWindow: {
        zh: "选择窗口",
        en: "Select window",
        ja: "ウィンドウを選択",
        de: "Fenster wählen",
        es: "Seleccionar ventana",
        fr: "Choisir une fenêtre",
        pt: "Selecionar janela",
        ru: "Выбрать окно",
    },
    spSelectDisplay: {
        zh: "选择显示模式",
        en: "Select display mode",
        ja: "表示モードを選択",
        de: "Anzeigemodus wählen",
        es: "Seleccionar modo de visualización",
        fr: "Choisir le mode d'affichage",
        pt: "Selecionar modo de exibição",
        ru: "Выбрать режим отображения",
    },
    spSelectSound: {
        zh: "选择声音",
        en: "Select sound",
        ja: "サウンドを選択",
        de: "Ton wählen",
        es: "Seleccionar sonido",
        fr: "Choisir un son",
        pt: "Selecionar som",
        ru: "Выбрать звук",
    },

    // === Feedback messages ===
    // fbCopiedTpl: count {n} is placed as a SUFFIX after a colon (not as a
    // determiner before the noun). This avoids plural-agreement issues across
    // languages — English avoids "1 tokens", Russian avoids the 1/few/many
    // count agreement (1 токен / 2-4 токена / 5 токенов), Spanish/Portuguese
    // avoid "1 tokens". The noun stays fixed (Token count / Anzahl / Recuento /
    // Nombre / Contagem / genitive-plural after Скопировано), so any {n} value
    // reads grammatically.
    fbCopiedTpl: {
        zh: "已复制 token 数到剪贴板：{n}（{fmt}）",
        en: "Token count copied to clipboard: {n} ({fmt})",
        ja: "クリップボードにコピーしたトークン数：{n}（{fmt}）",
        de: "Token-Anzahl in die Zwischenablage kopiert: {n} ({fmt})",
        es: "Recuento de tokens copiado al portapapeles: {n} ({fmt})",
        fr: "Nombre de tokens copié dans le presse-papiers : {n} ({fmt})",
        pt: "Contagem de tokens copiada para a área de transferência: {n} ({fmt})",
        ru: "Скопировано токенов в буфер обмена: {n} ({fmt})",
    },
    fbResetOk: {
        zh: "token 统计已重置——下次 hook 触发将全量重读 transcript（大型会话可能约 1 秒）",
        en: "Token stats reset — next hook fire re-reads the full transcript (may take ~1s for large sessions)",
        ja: "トークン統計をリセットしました——次回の hook 起動時に transcript をフル再読み込みします（大きなセッションで約 1 秒かかる場合があります）",
        de: "Token-Statistiken zurückgesetzt — beim nächsten Hook-Aufruf wird das vollständige Transkript neu eingelesen (~1s für große Sitzungen)",
        es: "Estadísticas de tokens reiniciadas — el próximo disparo del hook releerá la transcripción completa (puede tardar ~1s en sesiones grandes)",
        fr: "Statistiques de tokens réinitialisées — au prochain déclencheur du hook, le relevé complet sera relu (peut prendre ~1s pour les grosses sessions)",
        pt: "Estatísticas de tokens redefinidas — a próxima execução do hook relerá a transcrição completa (pode levar ~1s para sessões grandes)",
        ru: "Статистика токенов сброшена — при следующем запуске hook будет перечитана полная транскрипция (может занять ~1с для больших сессий)",
    },
    fbResetFailPrefix: {
        zh: "重置失败：",
        en: "Reset failed: ",
        ja: "リセット失敗：",
        de: "Zurücksetzen fehlgeschlagen: ",
        es: "Reinicio fallido: ",
        fr: "Échec de la réinitialisation : ",
        pt: "Falha na redefinição: ",
        ru: "Сбой сброса: ",
    },
    fbPanelFailPrefix: {
        zh: "cc-status-dot：token 面板失败：",
        en: "cc-status-dot: token panel failed: ",
        ja: "cc-status-dot：トークンパネルが失敗しました：",
        de: "cc-status-dot: Token-Panel fehlgeschlagen: ",
        es: "cc-status-dot: panel de tokens fallido: ",
        fr: "cc-status-dot : panneau de tokens échoué : ",
        pt: "cc-status-dot: painel de tokens falhou: ",
        ru: "cc-status-dot: сбой панели токенов: ",
    },

    // === Token SBI tooltip (§G tick) ===
    ttWindowTpl: {
        zh: "窗口：{win}",
        en: "Window: {win}",
        ja: "ウィンドウ：{win}",
        de: "Fenster: {win}",
        es: "Ventana: {win}",
        fr: "Fenêtre : {win}",
        pt: "Janela: {win}",
        ru: "Окно: {win}",
    },
    ttSessionTotalTpl: {
        zh: "会话总计：{fmt} tok",
        en: "Session total: {fmt} tok",
        ja: "セッション合計：{fmt} tok",
        de: "Sitzungsgesamt: {fmt} tok",
        es: "Total de la sesión: {fmt} tok",
        fr: "Total de la session : {fmt} tok",
        pt: "Total da sessão: {fmt} tok",
        ru: "Итого за сессию: {fmt} tok",
    },
    ttSessionCostTpl: {
        zh: "会话费用：{cost}",
        en: "Session cost: {cost}",
        ja: "セッションコスト：{cost}",
        de: "Sitzungskosten: {cost}",
        es: "Coste de la sesión: {cost}",
        fr: "Coût de la session : {cost}",
        pt: "Custo da sessão: {cost}",
        ru: "Стоимость сессии: {cost}",
    },
    tt24hTpl: {
        zh: "24h：{cost}",
        en: "24h: {cost}",
        ja: "24h：{cost}",
        de: "24h: {cost}",
        es: "24h: {cost}",
        fr: "24h : {cost}",
        pt: "24h: {cost}",
        ru: "24h: {cost}",
    },
    tt7dayTpl: {
        zh: "7 天：{cost}",
        en: "7-day: {cost}",
        ja: "7 日：{cost}",
        de: "7 Tage: {cost}",
        es: "7 días: {cost}",
        fr: "7 jours : {cost}",
        pt: "7 dias: {cost}",
        ru: "7 дней: {cost}",
    },
    tt30dayTpl: {
        zh: "30 天：{cost}",
        en: "30-day: {cost}",
        ja: "30 日：{cost}",
        de: "30 Tage: {cost}",
        es: "30 días: {cost}",
        fr: "30 jours : {cost}",
        pt: "30 dias: {cost}",
        ru: "30 дней: {cost}",
    },
    ttPartial: {
        zh: "注：估算不完整——部分轮次无单价记录",
        en: "Note: partial estimate — some turns had no rate entry",
        ja: "注：見積りは一部です——一部ターンに単価記録がありません",
        de: "Hinweis: unvollständige Schätzung — einige Durchläufe ohne Preis-Eintrag",
        es: "Nota: estimación parcial — algunos turnos no tenían entrada de precio",
        fr: "Note : estimation partielle — certains tours n'avaient pas d'entrée de tarif",
        pt: "Nota: estimativa parcial — alguns turnos sem entrada de taxa",
        ru: "Примечание: неполная оценка — некоторые ходы без записи тарифа",
    },
    ttLastModelTpl: {
        zh: "最近模型：{model}",
        en: "Last model: {model}",
        ja: "最終モデル：{model}",
        de: "Letztes Modell: {model}",
        es: "Último modelo: {model}",
        fr: "Dernier modèle : {model}",
        pt: "Último modelo: {model}",
        ru: "Последняя модель: {model}",
    },
    ttProjectTpl: {
        zh: "项目：{project}",
        en: "Project: {project}",
        ja: "プロジェクト：{project}",
        de: "Projekt: {project}",
        es: "Proyecto: {project}",
        fr: "Projet : {project}",
        pt: "Projeto: {project}",
        ru: "Проект: {project}",
    },
    ttClickConfig: {
        zh: "（点击配置）",
        en: "(click to configure)",
        ja: "（クリックで設定）",
        de: "(zum Konfigurieren klicken)",
        es: "(clic para configurar)",
        fr: "(cliquer pour configurer)",
        pt: "(clique para configurar)",
        ru: "(щёлкните для настройки)",
    },
    ttNoDataTpl: {
        zh: "cc-status-dot：暂无 token 数据（sid：{sid}...）",
        en: "cc-status-dot: no token data yet (sid: {sid}...)",
        ja: "cc-status-dot：まだトークンデータがありません（sid：{sid}...）",
        de: "cc-status-dot: noch keine Token-Daten (sid: {sid}...)",
        es: "cc-status-dot: sin datos de tokens aún (sid: {sid}...)",
        fr: "cc-status-dot: pas encore de données de tokens (sid : {sid}...)",
        pt: "cc-status-dot: sem dados de tokens ainda (sid: {sid}...)",
        ru: "cc-status-dot: пока нет данных о токенах (sid: {sid}...)",
    },
    ttUnavailableTpl: {
        zh: "cc-status-dot：token 统计不可用（sid：{sid}...）",
        en: "cc-status-dot: token stats unavailable (sid: {sid}...)",
        ja: "cc-status-dot：トークン統計は利用できません（sid：{sid}...）",
        de: "cc-status-dot: Token-Statistiken nicht verfügbar (sid: {sid}...)",
        es: "cc-status-dot: estadísticas de tokens no disponibles (sid: {sid}...)",
        fr: "cc-status-dot: statistiques de tokens indisponibles (sid : {sid}...)",
        pt: "cc-status-dot: estatísticas de tokens indisponíveis (sid: {sid}...)",
        ru: "cc-status-dot: статистика токенов недоступна (sid: {sid}...)",
    },
    ttNoPanel: {
        // \n in the baked IIFE becomes a real newline when VSCode renders the tooltip.
        zh: "cc-status-dot：无激活的 CC 面板\n（打开一个 Claude Code 标签页以填充数据）",
        en: "cc-status-dot: no active CC panel\n(open a Claude Code tab to populate)",
        ja: "cc-status-dot：アクティブな CC パネルがありません\n（Claude Code タブを開くと表示されます）",
        de: "cc-status-dot: kein aktives CC-Panel\n(Öffne einen Claude-Code-Tab zum Befüllen)",
        es: "cc-status-dot: sin panel de CC activo\n(abre una pestaña de Claude Code para poblar)",
        fr: "cc-status-dot: aucun panneau CC actif\n(ouvrez un onglet Claude Code pour le remplir)",
        pt: "cc-status-dot: sem painel CC ativo\n(abra uma aba do Claude Code para popular)",
        ru: "cc-status-dot: нет активной панели CC\n(откройте вкладку Claude Code для заполнения)",
    },
    ttNoPanelCreation: {
        zh: "cc-status-dot：token 统计（无激活 CC 面板）",
        en: "cc-status-dot: token stats (no active CC panel)",
        ja: "cc-status-dot：トークン統計（アクティブな CC パネルがありません）",
        de: "cc-status-dot: Token-Statistiken (kein aktives CC-Panel)",
        es: "cc-status-dot: estadísticas de tokens (sin panel CC activo)",
        fr: "cc-status-dot: statistiques de tokens (aucun panneau CC actif)",
        pt: "cc-status-dot: estatísticas de tokens (sem painel CC ativo)",
        ru: "cc-status-dot: статистика токенов (нет активной панели CC)",
    },

    // === 4-light SBI tooltip (§F tick + creation-time zero tooltip) ===
    // Placeholders {done}/{running}/{pending}/{interrupted} are filled at call
    // sites via .replace() chains. "Claude Code: " is a brand prefix kept
    // untranslated (matches the threshold alert + token SBI tooltip style).
    ttCountsTpl: {
        zh: "Claude Code：{done} 完成，{running} 运行中，{pending} 待输入，{interrupted} 中断",
        en: "Claude Code: {done} done, {running} running, {pending} pending, {interrupted} interrupted",
        ja: "Claude Code：{done} 完了、{running} 実行中、{pending} 入力待ち、{interrupted} 中断",
        de: "Claude Code: {done} abgeschlossen, {running} laufend, {pending} ausstehend, {interrupted} unterbrochen",
        es: "Claude Code: {done} completados, {running} en ejecución, {pending} pendientes, {interrupted} interrumpidos",
        fr: "Claude Code : {done} terminés, {running} en cours, {pending} en attente, {interrupted} interrompus",
        pt: "Claude Code: {done} concluídos, {running} em execução, {pending} pendentes, {interrupted} interrompidos",
        ru: "Claude Code: {done} завершено, {running} выполняется, {pending} ожидает, {interrupted} прервано",
    },

    // === notify() messages (§B — turn-complete / error feedback) ===
    // ntTurnComplete carries the "Claude Code: " brand prefix baked in (it is
    // the FULL notification body for the done state). ntRateLimit /
    // ntOverloaded / ntInterrupted are the per-state短 messages concatenated
    // AFTER "Claude Code: " (kept untranslated — same brand decision as
    // ttCountsTpl above and alCostAlertTpl).
    ntTurnComplete: {
        zh: "Claude Code：本轮完成",
        en: "Claude Code: turn complete",
        ja: "Claude Code：ターン完了",
        de: "Claude Code: Durchlauf abgeschlossen",
        es: "Claude Code: turno completado",
        fr: "Claude Code : tour terminé",
        pt: "Claude Code: turno concluído",
        ru: "Claude Code: ход завершён",
    },
    ntRateLimit: {
        zh: "触发限速",
        en: "rate limit reached",
        ja: "レート制限に到達しました",
        de: "Ratenbegrenzung erreicht",
        es: "límite de tasa alcanzado",
        fr: "limite de débit atteinte",
        pt: "limite de taxa atingido",
        ru: "достигнут лимит запросов",
    },
    ntOverloaded: {
        zh: "服务器过载",
        en: "server overloaded",
        ja: "サーバーが過負荷です",
        de: "Server überlastet",
        es: "servidor sobrecargado",
        fr: "serveur surchargé",
        pt: "servidor sobrecarregado",
        ru: "сервер перегружен",
    },
    ntInterrupted: {
        zh: "已中断",
        en: "interrupted",
        ja: "中断されました",
        de: "unterbrochen",
        es: "interrumpido",
        fr: "interrompu",
        pt: "interrompido",
        ru: "прервано",
    },

    // === Threshold alert (dispatchNotify direct call in §G tick) ===
    alCostAlertTpl: {
        zh: "CC 费用告警：{cost}（24h）",
        en: "CC cost alert: {cost} (24h)",
        ja: "CC コスト警告：{cost}（24h）",
        de: "CC Kosten-Warnung: {cost} (24h)",
        es: "Alerta de coste de CC: {cost} (24h)",
        fr: "Alerte coût CC : {cost} (24h)",
        pt: "Alerta de custo do CC: {cost} (24h)",
        ru: "Предупреждение о стоимости CC: {cost} (24h)",
    },
    // v0.2.5 round-2 (MEDIUM, window-workflow gap surfacing): shown in the
    // token SBI tooltip ONLY when tj.activeSubagents>0 — i.e. CC has
    // in-flight subagents/workflow tasks whose tokens settle when the
    // children complete. Without this line the user sees a stalled count
    // during a pure-workflow run (parent idle, children working) with no
    // explanation. The hook's scanSubagentTranscripts (cc-status.js:1540)
    // gives partial real-time visibility at every parent TOK_EVENT, but a
    // pure-workflow phase can have the parent idle for an extended period
    // (no PostToolUse/Stop/UserPromptSubmit firing). The tooltip line tells
    // the user the displayed total is incrementing in real-time as children
    // stream AND will fully settle when they complete.
    //
    // v0.2.5 round-3 (MEDIUM): the round-2 wording ('tokens settle on
    // completion / 会计入会话总计') was future-tense and contradicted the
    // actual data flow — scanSubagentTranscripts (cc-status.js:1540, called
    // every parent TOK_EVENT at cc-status.js:2088) already attributes
    // in-flight subagent transcript bytes to the parent sid's buckets
    // real-time via deriveTokensField, so during a workflow the displayed
    // total visibly increments (100→600→900). The new wording reflects the
    // dual 'real-time partial + final settlement on completion' semantics.
    // Calibrated to match the current CC behavior; if CC starts writing
    // workflow transcripts to a discoverable file the message can be
    // retired (the count would then fully cover workflow tokens and the
    // caveat would mislead).
    ttWorkflowGap: {
        zh: "$(info) 子代理 / workflow 运行中：token 已部分实时计入，结束时补齐结算",
        en: "$(info) Subagents / workflow in flight — tokens incrementally counted, final settlement on completion",
        ja: "$(info) サブエージェント / ワークフロー実行中：トークンは部分的にリアルタイム計上され、完了時に最終確定",
        de: "$(info) Subagents / Workflow aktiv — Tokens werden schrittweise gezählt, Endabrechnung bei Abschluss",
        es: "$(info) Subagentes / workflow en ejecución — tokens contados incrementalmente, cierre final al completarse",
        fr: "$(info) Sous-agents / workflow en cours — tokens comptés incrémentalement, règlement final à l'achèvement",
        pt: "$(info) Subagentes / workflow em execução — tokens contados incrementalmente, liquidação final ao concluir",
        ru: "$(info) Субагенты / workflow выполняются — токены учитываются по мере поступления, финальный расчёт при завершении",
    },
    // === v0.3.0 (lane D): tok/s rate + sparkline (inline SBI suffix only) ===
    // v0.5.1: the chart panel (form C webview — showRateChart + its i18n keys
    //   qpShowChart*/wv*) was REMOVED. Rate sampling infra
    //   (__ccsdRateSample/__ccsdRateSpark/__ccsdRateFlush/__ccsdRateLoad) is
    //   KEPT — it powers the inline tok/s suffix on the §G tick + gives
    //   cross-reload continuity via <sid>.rate sidecar. fbPanelFailPrefix is
    //   KEPT (still used by the SBI click handler's showTokQuickPick catch).
};

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

/**
 * Anchor C — INSIDE `uq.prototype.requestUserDialog` (inherited by each `go`
 * panel instance), the tail of the method after the
 * `if(!eve.includes(t.dialogKind))return{behavior:"cancelled"}` gate. Only
 * real consent/refusal/choice dialogs reach here (MCP elicitation is auto-
 * declined upstream by spawnClaude passing NO onElicitation, so it never
 * reaches requestUserDialog at all). Exact, must match 0 or 1 times.
 *
 * v0.5.35 ANCHOR_C / __ccsdUserDialogSet — covers consent/refusal dialogs CC
 * routes via request_user_dialog (fable_overage_consent_prompt,
 * refusal_fallback_prompt), which the Notification hook CANNOT see
 * (notification_type enum excludes them) and which do NOT set rename_tab
 * hasPendingPermissions.
 *
 * IMPLICIT DEPENDENCY: askUserQuestion blue is NOT covered by this anchor —
 * it relies on CC 2.1.220 routing askUserQuestion through can_use_tool ->
 * tool_permission_request -> permissionRequests -> rename_tab
 * hasPendingPermissions -> __ps (the Fact-1 path). A future CC refactor that
 * reroutes askUserQuestion to request_user_dialog would move coverage from
 * __ps to __ccsdUserDialogSet (still blue, but via the new term).
 *
 * RE-AUDIT TRIGGER: any CC update that (a) drifts ANCHOR_C's exact bytes,
 * (b) changes the can_use_tool routing for askUserQuestion, or (c) adds
 * notification_type coverage for consent — re-audit which term covers which
 * dialog. Three independent OR sources keyed by the SAME sid (real session
 * UUID), each read fresh per tick (R-INT-07: single-writer __ps via
 * rename_tab / single-writer __ccsdUserDialogSet via user_dialog_request /
 * single-writer j.pending via Notification hook — OR-ed at FRESH per-tick
 * consumer reads, the structural inverse of the v0.5.18 shared-sink trap).
 *
 * SID KEY: `this.__ccsdSid` (NOT the first arg `e`, which is the channelId
 * — a random webview string, NOT the session UUID). this.__ccsdSid is
 * written by replA/replB from update_session_state/rename_tab and is the
 * same key the §H/§F consumers use. The `if(this.__ccsdSid)` guard lets a
 * not-yet-set or pure-uq (non-panel) instance no-op harmlessly (consent at
 * session start before rename_tab: acceptable degradation, same class as
 * v0.5.22 sid-inference uncertainty).
 */
const ANCHOR_C =
    'return(await this.sendRequest(e,{type:"user_dialog_request",dialogKind:t.dialogKind,payload:t.payload,toolUseID:t.toolUseID},r)).result';

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
// v0.2.4 round-2 (ARCH-1 first slice): skipWsAndComments / stripJsonc /
// scanJsonValueEnd + the surgical-json helpers + cmpVerStr moved to src/
// modules (pure functions with no closure deps). parseJsonc stays here
// because it depends on the local fail() helper for anchor-tagged error
// formatting; it calls the imported stripJsonc via the import above.

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
// v0.2.4 round-2 (ARCH-1 first slice): scanJsonValueEnd / KeyRange /
// findTopLevelKey / surgicalSetTopLevelKey / surgicalRemoveTopLevelKey moved
// to src/surgical-json.ts (pure helpers, no closure deps). cmpVerStr moved
// to src/semver.ts. discoverExtension below uses the imported cmpVerStr.

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
    candidates.sort((a, b) => cmpVerStr(b.version.join("."), a.version.join(".")));
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
    // v0.2.6 round-3 HIGH (integrity): atomic copy. fs.copyFileSync does NOT
    // unlink the destination on partial failure (libuv opens with
    // O_CREAT|O_WRONLY|O_TRUNC and copies in chunks), so a partial .bak left
    // by ENOSPC/EINTR/SIGKILL/antivirus would be treated as "present" by the
    // existsSync gate above on the next call — silently becoming the permanent
    // backup, which a future restore propagates into CC's extension.js /
    // package.json / settings.json. The forward write path already uses
    // writeAtomicSync for exactly this reason — the reverse path (and the
    // .bak files those originals are restored from) must match.
    atomicCopyFileSync(srcPath, bakPath);
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
    try {
        fs.renameSync(tmp, filePath);
    } catch (e) {
        // v0.2.6 round-3 LOW (integrity): best-effort cleanup of orphan .tmp
        // when renameSync fails (EPERM / EXDEV / EACCES / antivirus lock on
        // Windows). Without this, every failed rename leaves a .tmp on disk
        // forever — none of the four write targets (CC ext dir, settings.json,
        // companion-config.json, last-repatch.json) are swept by the writer's
        // STATE_DIR .tmp GC, so orphans accumulated across install cycles.
        try {
            fs.unlinkSync(tmp);
        } catch {
            /* best-effort — orphan is no worse than today */
        }
        throw e;
    }
}

/**
 * Atomic write — Buffer variant. Identical tmp+rename discipline as
 * writeAtomicSync but accepts a Buffer for binary safety. v0.2.6 round-3 HIGH
 * (integrity): the reverse path (restoreExtension / restoreWebview /
 * restorePackageJson) and the runtime-file install path (installRuntimeFiles
 * for cc-status.js + token-rates.json, installCompanion for patch.js) all
 * previously used fs.copyFileSync — a partial copy under ENOSPC/EINTR/SIGKILL
 * leaves the destination half-written, and VSCode/Node load these files
 * verbatim so a half-written extension.js bricks the entire CC extension.
 * writeAtomicSync's JSDoc explicitly calls out package.json / extension.js /
 * settings.json as needing atomic protection — those same files are restored
 * via this helper on --revert, closing the asymmetric-protection gap.
 *
 * Buffer path avoids UTF-8 toString round-trip corruption of arbitrary bytes
 * (CC's minified extension.js is valid UTF-8 but a Buffer-based copy is the
 * canonical zero-loss form for file→file duplication).
 */
function writeAtomicSyncBuf(filePath: string, bytes: Buffer): void {
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, bytes);
    try {
        fs.renameSync(tmp, filePath);
    } catch (e) {
        try {
            fs.unlinkSync(tmp);
        } catch {
            /* best-effort */
        }
        throw e;
    }
}

/**
 * Atomic file copy — read source as Buffer, write via writeAtomicSyncBuf.
 * v0.2.6 round-3 HIGH/MEDIUM (integrity): replaces every bare
 * fs.copyFileSync used on CC-controlled files. fs.copyFileSync does NOT unlink
 * the destination on partial failure (libuv uv_fs_copyfile opens with
 * O_CREAT|O_WRONLY|O_TRUNC and copies in chunks; on ENOSPC/EINTR/EPERM
 * mid-copy the destination is left whatever length it reached). A subsequent
 * existsSync() gate (e.g. backupOnce) then sees the partial file as "present"
 * and silently skips, so the safety net becomes the corruption source. This
 * helper reads the source as a Buffer (fully in memory — CC's files are
 * bounded: extension.js ~3MB, cc-status.js ~100KB, token-rates.json ~1KB,
 * patch.js ~600KB) and writes via the atomic tmp+rename discipline. POSIX
 * rename is atomic so the destination is never observed half-written.
 */
function atomicCopyFileSync(srcPath: string, dstPath: string): void {
    const bytes = fs.readFileSync(srcPath);
    writeAtomicSyncBuf(dstPath, bytes);
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
                `${label} would be a SyntaxError — refusing to write (would break the Claude Code extension, so the patch was aborted).\n` +
                    `This is an internal patcher bug, not a Claude Code update. No files were changed. Please report it (with the node --check output below) at the project's issue tracker.\n` +
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
    // dim/zero emoji (⚪ U+26AA since v0.2.3, which reverted the v0.1.17 ⚪→🟤
    // pivot — see SBI_DIM_EM JSDoc) baked as a JSON-stringified string
    // literal — used by the per-tick loop for any light whose count is 0
    // (dim ball + digit "0", keeping the slot width fixed). Same baking
    // discipline as cfgLiteral: patch.ts SOURCE is ASCII-only, the baked IIFE
    // contains literal UTF-8 emoji bytes (see cfgLiteral above).
    const dimEmLiteral = JSON.stringify(SBI_DIM_EM);
    // v0.2.4 (code-style MEDIUM fix): bake TOK_WIN_KEYS as a JSON-stringified
    // array, then interpolate into the QuickPick template literal below
    // (showTokQuickPick's tokenStatsWindow picker). Eliminates 1 of the 5
    // independent copies of the window-key sequence (patch.ts IIFE picker
    // list); the writer's TOK_WIN_KEYS + docstring + test corpus + the former
    // slash-joined detail string are the remaining 4. v0.5.3 (code-standards
    // HIGH cleanup): the slash-joined `tokWinDetailLiteral` sibling that USED
    // to live here was dead (declared, never interpolated — only the array
    // form below is consumed) and its 6-line comment actively lied about
    // 'eliminating 2 of the 5 copies'; both removed.
    const tokWinKeysLiteral = JSON.stringify([...TOK_WIN_KEYS]);
    // v0.2.5 round-3 (MEDIUM): bake TOK_WIN_MS as a JS-object literal so the
    // IIFE can look up the rolling-window span (ms) for the currently-selected
    // tWin. computeLiveDelta uses this to filter transcript rows by timestamp
    // — mirroring the hook's deriveTokensField cutoff (cc-status.js:754-756)
    // so the IIFE's dSum only counts rows INSIDE the rolling window. Without
    // this filter, a long streaming turn (>5min on the 5min window, etc.)
    // causes the IIFE to add OUT-of-window bytes to the in-window bucket sum,
    // over-counting the displayed total. "all" maps to Infinity (cumulative —
    // no filter). JSON.stringify(Infinity) → null, so we hand-build the
    // literal with `Infinity` for the "all" key (valid JS, not valid JSON).
    // hooks/test-contract-sync.mjs pins these ms values against the writer's
    // TOK_WINDOWS so a future tuning edit touching only one side fails CI.
    const tokWinMsLiteral =
        "{" + TOK_WIN_KEYS.map((k) => JSON.stringify(k) + ":" + String(TOK_WIN_MS[k])).join(",") + "}";
    // v0.2.4 (code-style MEDIUM fix): bake the writer↔reader contract
    // extensions as JSON-stringified literals so the IIFE bytes follow a
    // future patch.ts rename (the writer is a standalone .js that cannot
    // import — its side mirrors these consts).
    // v0.2.5 round-3 (MEDIUM): re-bake tokOffsetExtLiteral. Round-2 of an
    // earlier fix stopped baking it because the QuickPick "Reset session
    // stats" branch no longer touches <sid>.offset. BUT computeLiveDelta
    // (added in v0.2.5 round-1) still references ".offset" — first as a
    // raw hard-coded string (silent desync risk if TOK_OFFSET_EXT is ever
    // renamed: the cross-file contract test would pass on the writer side
    // while the IIFE side would silently read the wrong filename and zero
    // the live delta forever). We therefore bake it from the const, the
    // same discipline as tokForceRereadExtLiteral — single source of truth.
    const tokOffsetExtLiteral = JSON.stringify(TOK_OFFSET_EXT);
    const tokForceRereadExtLiteral = JSON.stringify(TOK_FORCEREREAD_EXT);
    // v0.2.7 (Q1 fix): bake the new TOK_TOKENS_EXT literal so readTok's
    // three-tier fallback (`.tokens.json` → `.json` → null) follows a future
    // rename automatically. Same discipline as tokOffsetExtLiteral — single
    // source of truth on patch.ts; the writer side mirrors via TOK_TOKENS_EXT
    // and test-contract-sync.mjs pins cross-file equality.
    const tokTokensExtLiteral = JSON.stringify(TOK_TOKENS_EXT);
    // v0.4.0 round-2 (ARCH-6 HIGH fix): bake STATE_DIR as an absolute path
    // string literal so a future rename / relocation of the patch.ts:219
    // STATE_DIR const flows into the IIFE bytes automatically. Pre-fix, the
    // IIFE hardcoded `pth.join(os.homedir(),".claude","cc-tab-status")` — a
    // 4th independent copy of the path contract (alongside patch.ts:219,
    // hooks/cc-status.js:1166, and v0.4.0 companion/extension.ts:FAV_STATE_DIR).
    // A rename touching only STATE_DIR would leave the IIFE writing to the OLD
    // directory while the companion (FAV_STATE_DIR) writes favorites.json to
    // the NEW one → silent cross-surface break. Mirrors the resLiteral
    // discipline (bakes absolute paths at patch time from os.homedir()).
    // test-contract-sync.mjs §STATE_DIR pins all four expressions byte-equal.
    const stateDirLiteral = JSON.stringify(STATE_DIR);
    // v0.2.4 (intra-version i18n): bake the 8-language dictionary as a
    // JSON-stringified object literal. Mirrors the cfgLiteral / dimEmLiteral
    // baking discipline (single source of truth in patch.ts SOURCE; the IIFE
    // bytes follow a future dict edit automatically). LANG detection + the
    // t() helper are injected as small bodyLines entries in §A Preamble below.
    // JSON.stringify escapes the CJK / em-dash / middot chars into the baked
    // IIFE bytes as literal UTF-8 (VSCode parses the IIFE as UTF-8) — same as
    // SBI_LIGHTS_CFG's emoji bytes.
    const i18nLiteral = JSON.stringify(I18N_DICT);
    // State machine + notification + SBI aggregation mirror docs/STATES.md §1/§4/§4b/§7. Keep in sync.
    //
    // The banner carries INJECT_VERSION + a content hash of the body (everything
    // after the banner line). The hash lets patchExtension detect intra-version
    // drift — a re-run on an existing same-version install whose IIFE body
    // differs from the current buildIIFE() output triggers a .bak restore +
    // re-inject instead of silently skipping. See STAMP_HASH_LEN above.
    // v0.2.4 round-2 (ARCH-2): bodyLines is organized into 8 logical sections
    // (§A..§Z below) — each section starts with a `// === §X ... ===` banner
    // so a maintainer can locate any IIFE byte sequence by grep'ing the source
    // for the section name. The mega-line strings (showTokQuickPick, token SBI
    // tick) stay inline — splitting them is high-risk (any byte drift bricks
    // CC's extension.js); the banners make them findable without splitting.
    // Section list: §A Preamble · §B SBI helpers (dispatchNotify + notify) ·
    // §C 4-light SBI cmd + create · §D Token SBI cmd + create · §E Token panel
    // helpers + showTokQuickPick · §F Per-tick 4-light aggregation · §G Token
    // SBI tick + threshold alert · §H Per-panel tick · §Z onDidDispose + close.
    const bodyLines = [
        // === §A Preamble (open + panel counter + requires + decay constants) ===
        `(function(t){`,
        `if(t.__ccsdDotStarted||!t.panelTab)return;`,
        `t.__ccsdDotStarted=true;`,
        `/*SBI panel counter: bumped per IIFE entry; the onDidDispose teardown decrements and disposes the single v0.1.17 SBI on last-panel-out.*/`,
        `globalThis.__ccsdPanelCount=(globalThis.__ccsdPanelCount||0)+1;`,
        // v0.4.0 FAV BRIDGE §A: window-scoped sid → panel ref map. The
        // companion's Favorites tree reads this via shared globalThis (companion
        // + CC IIFE share the same EH process; the same pattern already powers
        // companion/extension.ts:621's __ccsdSbi read) to call .reveal() on an
        // open CC session. Populated here in the preamble — the
        // t.__ccsdDotStarted guard above guarantees this body runs exactly once
        // per panel, so publishing is idempotent without an extra flag. The sid
        // is set by replA/replB (this.__ccsdSid=e.request.sessionId) BEFORE the
        // IIFE is invoked in the comma-expression, so t.__ccsdSid is in scope
        // and non-empty on the first event fire. Cleared in §Z onDidDispose.
        // try/catch(_): defensive — globalThis writes can throw under
        // frozen-prototype scenarios (rare; the outer event parameter is `e`
        // so we use `catch(_)` to avoid shadowing it).
        `try{if(!globalThis.__ccsdSidToPanel)globalThis.__ccsdSidToPanel=Object.create(null);if(t.__ccsdSid)globalThis.__ccsdSidToPanel[t.__ccsdSid]=t.panelTab;}catch(_){}`,
        `/*v0.5.35: event-driven active-sid (onDidChangeViewState) — instant tab-switch update (was <=500ms tick delay). When this panel becomes active, immediately write __ccsdActiveSid + __ccsdLastActiveSid + refresh sidToPanel/sidToTitle, so token SBI + favorites reflect the switch with zero latency. R1 tick-gated write stays as backup. VSCode auto-disposes the listener on panel close.*/try{t.panelTab.onDidChangeViewState(function(ev){try{if(ev&&ev.webviewPanel&&ev.webviewPanel.active===true){if(t.__ccsdSid){globalThis.__ccsdActiveSid=t.__ccsdSid;globalThis.__ccsdLastActiveSid=t.__ccsdSid;if(globalThis.__ccsdSidToPanel)globalThis.__ccsdSidToPanel[t.__ccsdSid]=t.panelTab;if(globalThis.__ccsdSidToTitle&&t.__ccsdTitle)globalThis.__ccsdSidToTitle[t.__ccsdSid]=t.__ccsdTitle;}else{globalThis.__ccsdActiveSid="__switching__";}/*v0.5.36 rev5: event-driven §G refresh (mirrors companion favStatusBar's tabGroups activation trigger — immediate, not waiting for the 500ms tick). Removed rev3's unconditional $(sync~spin) which caused a loading flicker on EVERY loaded-session switch. The §G tick (now scanning __ccsdSidToPanel real-time active panel) handles the display: instant swap for loaded sessions, loading via __switching__ sentinel for initializing sessions.*/if(globalThis.__ccsdSbiTick){try{globalThis.__ccsdSbiTick()}catch(_){}}}}catch(_){}})}catch(_){}`,
        // v0.5.3 (F1/F2 e2e HIGH): sid→title bridge. The per-panel tick
        // refreshes globalThis.__ccsdSidToTitle[sid] every 500ms (below) so the
        // companion's favToggleTab can resolve the RIGHT-CLICKED background tab
        // (vs the welded __ccsdActiveSid) by matching activeTab.label, and so
        // favorites labels can prefer the live tab title over a cwd/UUID
        // fallback. Initialized here in the §A preamble (idempotent — the
        // t.__ccsdDotStarted guard above guarantees one-time-per-panel); cleared
        // in §Z onDidDispose. The companion reads this map read-only.
        `try{if(!globalThis.__ccsdSidToTitle)globalThis.__ccsdSidToTitle=Object.create(null);}catch(_){}`,
        `var fs=require("fs"),pth=require("path"),vs=require("vscode"),os=require("os");`,
        // v0.4.0 round-2 (ARCH-6 HIGH): bake STATE_DIR as an absolute path
        // literal (computed once at patch time from patch.ts:219 const + the
        // user's os.homedir()). Pre-fix the IIFE recomputed the path at runtime
        // from a hardcoded `pth.join(os.homedir(),".claude","cc-tab-status")`,
        // which was a 4th unsynced copy of the path contract. Renaming
        // patch.ts STATE_DIR now flows through automatically; the IIFE writes
        // to the SAME directory the hook (hooks/cc-status.js:1166) and the
        // companion (FAV_STATE_DIR) write to. See test-contract-sync.mjs
        // §STATE_DIR for the four-way cross-file byte-equality pin.
        `var DIR=${stateDirLiteral};`,
        `var RES=${resLiteral};`,
        `var CC_DEFAULT=pth.join(t.context.extensionPath,"resources","claude-logo.svg");`,
        // v0.2.9 (Q5 Fix 1): Uri cache for p.iconPath. VSCode's EH-side
        // WebviewPanel.iconPath setter dedups via reference equality
        // (`this.#iconPath !== value` — see microsoft/vscode extHostWebviewPanels.ts
        // set iconPath), but vs.Uri.file() constructs a FRESH Uri object on
        // every call, so the dedup NEVER fires — every 500ms tick sends N
        // redundant $setIconPath IPCs to the renderer (8 IPC/sec at 4 panels
        // steady-state, measured 2026-07-21). Memoize vs.Uri.file(p) by path
        // string so identical paths reuse the same Uri object → EH dedup
        // fires → IPC skipped. State transitions and the interrupted flash
        // (alternating error.svg ↔ CC_DEFAULT → alternating Uris) still
        // produce differing references → IPC still fires. CC-clobber defense
        // preserved: if CC overwrites #iconPath with a fresh CC_DEFAULT Uri,
        // our next tick compares ccuri(ourSvg) !== CC_clobber_Uri → true →
        // IPC re-asserts within 500ms. Mock benchmark: 8 IPC/sec → ~0 IPC/sec
        // steady state (99.6% reduction). See CHANGELOG v0.2.9 + docs/STATES.md
        // §9 perf section.
        `var __ccsdUriCache=Object.create(null);function ccuri(p){return __ccsdUriCache[p]||(__ccsdUriCache[p]=vs.Uri.file(p));}`,
        // v0.5.2 (#3/F3): removed the v0.2.9-debug __ccsdDbg anomaly logger
        // (_panel-debug.log) + its __ccsdRenderMap feeder. The Q7 tab-orange
        // root cause was confirmed + fixed in v0.2.9.1 (the __ccsdPending
        // yield was removed), but the logger — which its own comment said to
        // "remove after root cause confirmed + fix landed" — was left in
        // production through v0.5.1, firing unthrottled fs.statSync +
        // fs.appendFileSync ~6×/sec on the EH hot path (forensics on an
        // 857KB _panel-debug.log showed 14716 ELSE + 11873 NOSID events,
        // disproving its "rare early-return" comment). Pure removal — the log
        // is write-only (grep confirmed no runtime reader of the file). Users
        // may delete the leftover ~/.claude/cc-tab-status/_panel-debug.log.
        // v0.5.0: favorites.json path (same DIR as <sid>.json + <sid>.offset +
        // <sid>.tokens.json — companion FAV_STATE_DIR is the same path). Single
        // literal here so the contract is one-way (companion writes, IIFE reads)
        // and avoids a 4th hardcoded path; rename STATE_DIR flows through.
        `var FAVF=pth.join(DIR,"favorites.json");`,
        // v0.5.0 fav detection: mtime+size cache on favorites.json, mirroring
        // __ccsdAgCache (§F) and __ccsdOffCache (§G). Stat-first → cache hit
        // reuses parsed sid set; miss → re-read+parse+cache. Companion writes
        // favorites.json via atomic tmp+rename (writeFavAtomic extension.ts),
        // so (mt,sz) is a reliable content-change signal. Worst-case tick lag
        // = TICK_MS=500ms which is imperceptible. Returns a null-prototype
        // object whose keys are favorited sids, or null when file
        // absent/empty/unparseable. Keyed single-entry (not per-sid) because
        // favorites.json is one global file, not a per-sid sidecar.
        `function readFavSet(){try{var c=globalThis.__ccsdFavCache;if(!c)c=globalThis.__ccsdFavCache=Object.create(null);var mt=0,sz=0;try{var s=fs.statSync(FAVF);mt=s.mtimeMs;sz=s.size;}catch(_){return null;}var e=c.last;if(e&&e.mt===mt&&e.sz===sz&&mt>0)return e.set;if(sz<=0)return null;var j=null;try{j=JSON.parse(fs.readFileSync(FAVF,"utf8"));}catch(_){return null;}var set=Object.create(null);if(j&&Array.isArray(j.sessions)){for(var i=0;i<j.sessions.length;i++){var x=j.sessions[i];if(x&&typeof x.sid==="string")set[x.sid]=1;}}c.last={set:set,mt:mt,sz:sz};return set;}catch(_){return null;}}`,
        // v0.5.0: remap a base-state svg path to its -fav variant if the
        // panel's sid is favorited. CC_DEFAULT (interrupted off-frame, no
        // state leaf) and unknown leaves pass through unchanged so the flash
        // sequence still alternates correctly. Uses the same ccuri memoization
        // downstream — new -fav path strings cache independently.
        `function favOf(svgPath,sid){try{if(!svgPath||svgPath===CC_DEFAULT||!sid)return svgPath;var fset=readFavSet();if(!fset||!fset[sid])return svgPath;var leaf=svgPath.split(pth.sep).pop();if(/^claude-logo-(idle|running|done|error|pending)\\.svg$/.test(leaf)){return pth.join(RES,leaf.replace(/\\.svg$/,"-fav.svg"));}}catch(_){}return svgPath;}`,
        `var DONE_TO_IDLE_MS=${DONE_TO_IDLE_MS};`,
        `/*§7.2 stale-running heuristic: v0.2.6 keys off 'since' (the *→running transition time), not mtime. Stop preserveSince path (cc-status.js:390-401) keeps cur.since on inflight>0 Stop heartbeats while writeJsonAtomic refreshes mtime — mtime stays fresh forever under CC's repeated Stop fire on drifted inflight payloads, so mtime-decay never fires. since-decay fires correctly because since is preserved (not refreshed) across the same path. Mirrors done>5min / interrupted>24h decay which already key off since.*/`,
        `var SBI_RUNNING_STALE_MS=${SBI_RUNNING_STALE_MS};`,
        /*v0.5.2 (#4): the per-tab decay threshold is UNIFIED with §F — both
         surfaces now reference the single SBI_RUNNING_STALE_MS above + the
         __ccsdTranscriptFresh activity gate. The v0.2.6 round-1
         SINCE_STALE_MS=15min per-tab constant (and its distinct-name
         divergence lock IIFE.46b) are retired: a 15-30min window where the
         tab showed ⚪ idle while the bottom 🟡 stayed yellow was the user's
         #4 report, and the deeper false-decay of active long workflows is now
         cured by the transcript-mtime gate (a streaming session's .jsonl
         keeps growing even while `since` is frozen). See the JSDoc on the
         SBI_RUNNING_STALE_MS const above + STATES.md §7.4.*/
        /*§7.5 interrupted retention: crashed/killed CC sessions whose writer wrote
         state=interrupted never send SessionEnd, so without a retention heuristic
         the 🔴 light would grow monotonically. Decay interrupted files older
         than 24h to idle for COUNTING but keep the file on disk (diagnostic
         value preserved — see docs/STATES.md §7.5). 24h >> SBI_RUNNING_STALE_MS
         (30min) because interrupted is a terminal state the user may want to
         inspect long after the fact. v0.2.4 round-2 (ARCH-6): the literal is
         now template-substituted from the top-level INTERRUPTED_RETENTION_MS
         const (mirrors the existing TOK_WIN_KEYS / TOK_OFFSET_EXT pattern) so
         hooks/test-contract-sync.mjs can pin writer/reader equality via the
         named const on both sides.*/
        `var INTERRUPTED_RETENTION_MS=${INTERRUPTED_RETENTION_MS};`,
        ,
        /*v0.5.24 refactor (debt #1 fix): unified decay predicate shared by §F (four-light,
         * decayInterrupted=true) and §H (per-tab, decayInterrupted=false — interrupted stays
         * red on tab for diagnostics, see STATES.md §7.4). Eliminates byte-identical decay
         * chain duplication. Each consumer reads sid.json INDEPENDENTLY (§F readdirSync /
         * §H readFileSync — see rejected-by-design). Only the predicate is shared, not read.*/ `function __ccsdDecayState(st,since,j,now,decayInterrupted){if(st==="done"&&since&&(now-since)>DONE_TO_IDLE_MS)return "idle";if(decayInterrupted&&st==="interrupted"&&since&&(now-since)>INTERRUPTED_RETENTION_MS)return "idle";if(st==="running"&&since&&!(j.activeSubagents>0)&&(now-since)>SBI_RUNNING_STALE_MS&&j.tokens&&j.tokens.last_ts&&(now-j.tokens.last_ts)>SBI_RUNNING_STALE_MS)return "idle";return st;}`,
        // v0.2.5 round-3 (MEDIUM): rolling-window spans in ms. Used by
        // computeLiveDelta to filter transcript rows by timestamp so the
        // IIFE's live-delta dSum only counts rows INSIDE the rolling window
        // (mirrors the hook's deriveTokensField cutoff at cc-status.js:754-756).
        // "all" maps to Infinity (cumulative — no filter). Baked from the
        // top-level TOK_WIN_MS const so hooks/test-contract-sync.mjs can pin
        // writer/reader equality.
        `var TOK_WIN_MS=${tokWinMsLiteral};`,
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
        // v0.2.4 (code-style LOW fix): per-light digit cap. Counts >= cap
        // render as "N" instead of a multi-digit number, keeping the slot
        // width at `<ball><1-digit>` so count changes never shift the row.
        // Coupled to the SBI 4-light CFG table structure (the "N" variant
        // assumes a 1-digit slot). Named now so a future tuning edit (e.g.
        // cap=9 with a 2-digit slot) hits ONE site and reads clearly at
        // both call sites (the cap fn + the render ternary below).
        `var SBI_LIGHT_CAP=4;`,
        `var flashSeq=0,lastTermSince=null,seeded=false;/*flashSeq: interrupted on/off frame index (flashSeq%2)*/`,
        // === §A.2 i18n (v0.2.4 intra-version: QuickPick + token SBI tooltip + notify + 4-light SBI tooltip) ===
        // LANG detection: vs.env.language returns the VSCode UI locale as a
        // BCP-47-ish string ("zh-cn", "zh-tw", "pt-br", "en", "en-us", "ja",
        // "de", "es", "fr", "ru", ...). We lowercase + take the primary subtag
        // so all zh-* variants collapse to "zh" and pt-br collapses to "pt".
        // tr() helper: I18N[k][LANG] → I18N[k].en → k (key-as-fallback, makes a
        // missing dictionary entry visibly wrong instead of silently empty).
        // IMPORTANT: helper is named `tr` (not `t`) — the IIFE wrapper signature
        // is `(function(t){...})(this)` where the parameter `t` is the CC panel
        // `this` reference (used at runtime as t.panelTab / t.__ccsdSid /
        // t.__ccsdTitle / t.__ccsdPending). V8 hoists nested function
        // declarations ABOVE parameter assignment, so naming the helper `t`
        // would shadow the panel reference and silently no-op the entire IIFE
        // (line ~1488 `if(t.__ccsdDotStarted||!t.panelTab)return;` would fire
        // an immediate return on every activation). `tr` collides with no IIFE
        // local (e/en/k/fs/pth/vs/os/DIR/RES/CC_DEFAULT/CFG/DIM_EM/LANG/I18N/
        // SEP/cap/flashSeq/seeded/lastTermSince all disjoint).
        // Dictionary completeness (every key has all 8 languages) is asserted
        // in hooks/test-iife.mjs IIFE.68-71.
        `var LANG=(vs.env.language||"en").toLowerCase().split("-")[0];`,
        `var I18N=globalThis.__ccsdI18N||(globalThis.__ccsdI18N=${i18nLiteral});`,
        `function tr(k){var e=I18N[k];return e&&(e[LANG]||e.en)||k;}`,
        // === §B SBI helpers (dispatchNotify + notify — shared by §G threshold alert) ===
        // v0.2.4 (architecture MEDIUM fix): shared osascript dispatch helper.
        // Pre-refactor notify() and the threshold alert path (in the token
        // tick) each had their OWN copy of the escape regex + execFile call,
        // so a future fix to the escape rule (or adding sound for alerts)
        // landed in one path but not the other. dispatchNotify() is now the
        // single point: escapes `"` and `\\` against AppleScript injection,
        // shells out to osascript on darwin (falling through to a VS Code
        // message on async/sync failure), and falls straight through to a
        // VS Code message on non-darwin. `sev` selects info vs warn for the
        // fallback; `sndOpt` is an optional escaped sound-name string.
        `function dispatchNotify(msg,sev,sndOpt){var vsMsg=function(){if(sev==="info")vs.window.showInformationMessage(msg);else vs.window.showWarningMessage(msg);};if(os.platform()==="darwin"){var escMsg=(""+msg).replace(/["\\\\]/g,function(c){return "\\\\"+c;});var sndStr=sndOpt?(' sound name "'+sndOpt+'"'):'';try{require("child_process").execFile("osascript",["-e",'display notification "'+escMsg+'" with title "Claude Code"'+sndStr],function(err){if(err)vsMsg()})}catch(e){vsMsg()}}else{vsMsg()}}`,
        `function notify(st,err){`,
        `var c=vs.workspace.getConfiguration("ccStatusDot");`,
        `if(!c.get("notify",true))return;`,
        `var focused=vs.window.state.focused;`,
        `if(focused&&!c.get("notifyWhenFocused",true))return;`,
        `var msg,sev;`,
        `if(st==="done"){sev="info";msg=tr("ntTurnComplete")}`,
        `else{sev="warn";var m={rate_limit:tr("ntRateLimit"),overloaded:tr("ntOverloaded")}[err]||err||tr("ntInterrupted");msg="Claude Code: "+m}`,
        `if(t.__ccsdTitle)msg+=" ["+t.__ccsdTitle+"]";`,
        // v0.2.4 (architecture MEDIUM): delegate to dispatchNotify — escape
        // rule + osascript + VSCode fallback are now in ONE place. Sound name
        // is escaped here (read from ccStatusDot.notifySound) and passed as
        // sndOpt so dispatchNotify stays parameter-pure.
        `var snd=c.get("notifySound","Glass");var escSnd=(""+snd).replace(/["\\\\]/g,function(c){return "\\\\"+c;});dispatchNotify(msg,sev,escSnd);`,
        `}`,
        // === §C 4-light SBI click cmd + SBI creation (single v0.1.17 SBI) ===
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
        `try{if(!globalThis.__ccsdSbi){try{var sbi=vs.window.createStatusBarItem(vs.StatusBarAlignment.Left,${SBI_PRIORITY});sbi.name="CC Status";sbi.text=DIM_EM+"0"+DIM_EM+"0"+DIM_EM+"0"+DIM_EM+"0";sbi.tooltip=tr("ttCountsTpl").replace("{done}",0).replace("{running}",0).replace("{pending}",0).replace("{interrupted}",0);try{sbi.command=${JSON.stringify(SBI_CLICK_CMD)}}catch(e){};sbi.show();globalThis.__ccsdSbi=sbi;globalThis.__ccsdSbiLastKey=null;}catch(e){}}}catch(e){}`,
        // === §D Token SBI click cmd + creation (right-side, v0.2.4+) ===
        // === v0.2.4: token-stats SBI (right side) + QuickPick config panel ===
        // Created as a SECOND StatusBarItem at StatusBarAlignment.Right with
        // priority TOK_SBI_PRIORITY (-9995). Shows the active CC panel's token
        // usage for the configured window (default 1h) with optional USD cost
        // suffix. Click triggers the QuickPick config panel.
        //
        // try/catch wraps the whole creation block (layer 1 isolation) so a
        // throw inside createStatusBarItem / .command= / .show() is swallowed
        // and the IIFE continues to the per-tab tick + onDidDispose
        // registration. The 4-light SBI above is unaffected.
        //
        // __ccsdActiveSid is the per-window "currently focused CC panel sid".
        // Two publishers: ANCHOR_A's update_session_state handler (fires on
        // panel state changes including visibility switches) + the per-panel
        // tick (every 500ms when panelTab.active===true — the authoritative
        // source, see the per-panel tick commentary for the v0.2.4 multi-panel
        // race tighten). __ccsdLastActiveSid is the unconditional fallback
        // updated by every per-panel tick regardless of active state, so the
        // single-panel-with-undefined-active case still resolves to that
        // panel. Falls back to "" (no active panel) → SBI shows "$(clock) —".
        `try{if(!globalThis.__ccsdTokSbi){try{var tsbi=vs.window.createStatusBarItem(vs.StatusBarAlignment.Right,${TOK_SBI_PRIORITY});tsbi.name="CC Tokens";tsbi.text="$(clock) \\u2014";tsbi.tooltip=tr("ttNoPanelCreation");try{tsbi.command=${JSON.stringify(TOK_CLICK_CMD)}}catch(e){};tsbi.show();globalThis.__ccsdTokSbi=tsbi;globalThis.__ccsdActiveSid=globalThis.__ccsdActiveSid||"";globalThis.__ccsdLastActiveSid=globalThis.__ccsdLastActiveSid||"";}catch(e){}}}catch(e){}`,
        // QuickPick click-command registration for the token SBI. Mirrors the
        // 4-light SBI click-command pattern: idempotent via a globalThis flag,
        // wrapped in nested try/catch (registerCommand throws on duplicate id).
        // The handler opens a QuickPick config panel: window selector, display
        // mode toggle, notify/sound integration, fast commands (copy count /
        // reset / open state dir), and a link to the full Settings UI.
        // showTokQuickPick is defined below in the same IIFE.
        `try{if(!globalThis.__ccsdTokCmdRegistered){globalThis.__ccsdTokCmdRegistered=true;try{vs.commands.registerCommand(${JSON.stringify(TOK_CLICK_CMD)},function(){try{showTokQuickPick()}catch(e){try{vs.window.showErrorMessage(tr("fbPanelFailPrefix")+(e&&e.message||String(e)))}catch(_){}}})}catch(e){}}}catch(e){}`,
        // v0.4.0 FAV BRIDGE §D.5: register the ccStatusDot.fav.focusSession
        // command (FALLBACK path for companion's Favorites tree). Mirrors the
        // SBI_CLICK_CMD / TOK_CLICK_CMD registerCommand pattern (no package.json
        // contribution needed — vs.commands.registerCommand is enough, see
        // patch.ts:639-641). Idempotent via __ccsdFavCmdRegistered; nested
        // try/catch swallows registerCommand's duplicate-id throw.
        //
        // The companion's primary path reads globalThis.__ccsdSidToPanel[sid]
        // directly (same EH); this command exists so the bridge keeps working
        // if a future VSCode release splits EH per extension (vscode.commands
        // orchestrates the cross-EH dispatch). The handler does NOT show error
        // messages — fail-silent + return false is the right posture for a
        // reveal() that may race with panel close (the companion's tree
        // refreshes on the next fs.watch tick and downgrades the node).
        `try{if(!globalThis.__ccsdFavCmdRegistered){globalThis.__ccsdFavCmdRegistered=true;try{vs.commands.registerCommand(${JSON.stringify(FAV_FOCUS_CMD)},function(sid){try{if(sid&&globalThis.__ccsdSidToPanel&&globalThis.__ccsdSidToPanel[sid]){try{globalThis.__ccsdSidToPanel[sid].reveal()}catch(_){}return true}return false}catch(_){return false}})}catch(e){}}}catch(e){}`,
        // === §E Token panel helpers (fmtTok/fmtUsd/sumTok/readTok) + showTokQuickPick ===
        // v0.2.4 token-panel helpers + showTokQuickPick. Defined BEFORE the
        // tick body so the registerCommand handler above can reference
        // showTokQuickPick at call time (function declarations hoist, so
        // placement is technically free, but keeping the helpers next to the
        // QuickPick keeps the source readable).
        //
        // fmtTok: 1234567 → "1.2M", 12345 → "12.3k", 999 → "999".
        // fmtUsd: 0.423 → "$0.42", 0.005 → "$0.005" (sub-cent precision for
        //   low-cost sessions), null/NaN → "".
        // sumTok: adds the 6 token dimensions of a totals/window object.
        // readTok: reads the active sid's <sid>.json and returns the parsed
        //   object (so the QuickPick can show session total / 24h / 7d /
        //   30d). Returns null on any error.
        // showTokQuickPick: builds a QuickPick with 5 sections (stats / notify /
        //   totals / actions / settings). All configuration writes go through
        //   vscode.workspace.getConfiguration("ccStatusDot").update(...,
        //   ConfigurationTarget.Global) so they persist to settings.json
        //   immediately and the IIFE's next tick picks up the change
        //   (getConfiguration is re-read every tick — see plan §1.5).
        //
        // v0.2.4 consistency fixes folded into this helper:
        //   - "Today" label renamed to "24h" (rolling-24h cost is NOT a
        //     calendar-day "today" — the asymmetric label vs 7-day/30-day was
        //     misleading). Tooltip mirrors the change.
        //   - cost rows now carry the "~" prefix to match the SBI tooltip
        //     (cost is always an estimate — token-rates.json carries the
        //     approximation disclaimer, both surfaces should agree).
        //   - Statistics window selector + detail string list all 8 windows
        //     (5min/10min/1h/24h/3d/7d/30d/all) — the writer computes cost
        //     for all 8 and the user can now pick any of them as the main
        //     display window. Previously the selector exposed only 6 and
        //     7d/30d appeared only in the tooltip.
        //   - "Reset session stats" writes a <sid>.forcereread marker ONLY — it
        //     no longer also unlinks <sid>.offset. The marker tells the next
        //     hook fire to do a FULL re-read (bypassing the 256KB tail pre-
        //     warm), so reset actually returns the true full-history total
        //     instead of the tail slice. Keeping the offset sidecar is CRITICAL
        //     for subagent preservation: the hook's forceFull path filters
        //     ctx.buckets by `b.src && b.src !== 'main'` to keep already-merged
        //     subagent contributions while re-reading the parent transcript
        //     from byte 0. Unlinking the offset here would make the next fire
        //     start from ctx.buckets=[] → the preservation filter would have
        //     nothing to keep → already-merged subagent tokens (SubagentStop
        //     fires once per subagent, no replay) would be permanently lost,
        //     so Reset would silently DECREASE the displayed total by the
        //     subagent share — the opposite of the "get accurate total" UX.
        //     v0.2.4 round-3 (business-logic MEDIUM fix): dropped the
        //     fs.unlinkSync(<sid>.offset) call; forcereread marker alone
        //     carries the reset intent.
        // v0.3.0 (lane E): fmtTok upgraded from {k,M} ceiling to {k,M,B,T}
        // 4-sig-fig adaptive. The previous M ceiling would render 1.5B as
        // "1500.0M" — critical at the user's 796M→1B transition. New tiers
        // match Intl.NumberFormat('en') compact + d3 '~s' (lowercase k +
        // uppercase M/B/T, SI-correct: lowercase b would be ambiguous, m
        // reads as "milli"). Trailing-zero strip regex /\.0+$/ cleans round
        // tops ("796.0M" → "796M", "1.50B" stays). Math.floor at tier-top
        // (>=100x tier) keeps width stable at ≤5 chars. Manual locale-
        // independent formatter (NOT Intl.NumberFormat) because the plugin
        // supports 8 languages and locale-dependent output (zh→"8亿",
        // de→"796 Mio.") would break SBI visual stability. Sample verified
        // outputs: 1234→"1.23k", 12345→"12.3k", 123456→"123k", 1234567→
        // "1.23M", 123456789→"123M", 1234567890→"1.23B", 12345678901→
        // "12.3B", 796007504→"796M", 1500000000→"1.50B", 1e12→"1T".
        `function fmtTok(n){n=n||0;if(n<1000)return String(n);var u=[["k",1e3],["M",1e6],["B",1e9],["T",1e12]],t=u[0];for(var i=0;i<u.length;i++){if(n>=u[i][1])t=u[i];}var m=n/t[1];var s=m<10?m.toFixed(2):m<100?m.toFixed(1):String(Math.floor(m));return s.replace(/\\.0+$/,"")+t[0];}function fmtRate(r){r=r||0;if(r<1)return"0";if(r<1000)return r.toFixed(0);return fmtTok(r);}function fmtBytes(n){n=n||0;if(n<1024)return Math.max(0,n).toFixed(0)+"B";var u=[["k",1024],["M",1048576],["G",1073741824]],t=u[0];for(var i=0;i<u.length;i++){if(n>=u[i][1])t=u[i];}var m=n/t[1];return(m<10?m.toFixed(2):m<100?m.toFixed(1):String(Math.floor(m)))+t[0];}function fmtUsd(v){if(v==null||!isFinite(v))return"";if(v<0.01)return"$"+v.toFixed(3);return"$"+v.toFixed(2);}function fmtUsdApprox(v){var s=fmtUsd(v);return s?"~"+s:s;}function sumTok(w){if(!w)return 0;return (w.in||0)+(w.out||0)+(w.cr||0)+(w.cc5||0)+(w.cc1||0)+(w.cci||0);}function readTok(){try{var sid=globalThis.__ccsdActiveSid||globalThis.__ccsdLastActiveSid||"";if(!sid)return null;/*v0.2.7 Q1: prefer <sid>.tokens.json (survives SessionEnd) over <sid>.json for tokens display. Falls back to <sid>.json when the snapshot is absent (active sessions where the freshest tokens live in the in-flight .json pre-snapshot-write, or pre-v0.2.7 installs that never wrote a snapshot). Three-tier: .tokens.json -> .json -> null.*/var tf=pth.join(DIR,sid+${tokTokensExtLiteral});try{var t=JSON.parse(fs.readFileSync(tf,"utf8"));if(t&&t.tokens)return t}catch(_){}var f=pth.join(DIR,sid+".json");var j=JSON.parse(fs.readFileSync(f,"utf8"));if(!j||!j.tokens)return null;return j}catch(e){return null}}/*v0.2.5 (problem 2 fix): IIFE-side live delta. Reads the parent transcript's NEW bytes [sidecar.offset..jsonl.size] directly so the token SBI updates during CC streaming (between PostToolUse/Stop/SubagentStop fires when the hook is NOT running). Strict invariants to avoid double-count:(1) skip if !tj.tokens (no hook baseline yet \u2014 hook MUST fire first to set sidecar.offset);(2) skip if tj.state!=='running' (streaming only happens in running state \u2014 done/idle/interrupted have no new bytes);(3) skip if sidecar.offset<=0 (defensive: hook has not advanced the cursor);(4) hard cap toRead<=512KB (bounds the read; v0.2.5 round-3 MEDIUM: previously returned null on >512KB causing silent display freeze \u2014 now reads the 512KB tail with truncated=true so the tick can show a partial-delta indicator; bytes before the tail are missed until the next hook fire). IIFE never writes sidecar/jsonl \u2014 hook remains the sole writer, so the IIFE's read-only view is race-free. cache_creation dual form (object vs scalar) mirrors cc-status.js:1417-1425 exactly \u2014 hasCcObj chooses one, zeroes the other. isSidechain + <synthetic> skips mirror cc-status.js:1406-1408 \u2014 subagent rows are handled via the hook's scanSubagentTranscripts (problem 3a fix) and the parent's sidechain rows belong to subagent activity that the hook already counts via the nested subagents/ scan. v0.2.5 round-2 (MEDIUM): jsonl path is now AUTHORITATIVE via tj.transcript_path (carry-forward persisted by the hook on every TOK_EVENT fire). The cwd\u2192projects-dir escape rule ( /[^a-zA-Z0-9._-]/g \u2192 '-' ) is a FALLBACK for old <sid>.json files written before this fix; the hook itself distrusts the escape (cc-status.js:1502-1507 'has changed historically') so we prefer the path CC tells us directly. On any miss (path absent, jsonl absent, sidecar absent, partial line) returns null \u2192 tick falls back to hook.tokens-only display (zero delta), no crash. v0.2.5 round-3 (MEDIUM): (a) optional winMs param filters rows by timestamp (mirrors hook deriveTokensField cutoff cc-status.js:754-756 \u2014 without this, a long streaming turn that spans past the rolling-window edge would add OUT-of-window bytes to the in-window bucket sum, over-counting the displayed total); pass Infinity (or omit) for the cumulative 'all' window. (b) Row loop adds Number.isFinite(Date.parse(obj.timestamp)) guard mirroring hook cc-status.js:1411-1412 \u2014 without this, rows with missing/malformed timestamps are counted by the IIFE but skipped by the hook, causing a 'settlement shrink' on the next hook fire. (c) >512KB delta no longer returns null \u2014 reads the 512KB tail with truncated=true so the \u00a7G tick can prefix the displayed total with '\u2248' (U+2248 APPROXIMATELY EQUAL) to signal that bytes before the tail are missed until the next hook fire. v0.2.6 round-3 MEDIUM (reader-logic): the truncated boolean is now CONSUMED by the \u00a7G tick (livePrefix), closing the dead-flag gap left by the v0.2.5 static-tooltip fix (which removed the ttLiveDeltaTruncated tooltip push IIFE.95b but left the boolean orphaned). lastModel is overlaid onto tok.last_model when present so the tooltip shows the live-tail model even before the next hook fire stamps it.*/function computeLiveDelta(tj,sid,winMs){try{if(!tj||!tj.tokens||!tj.cwd||!sid||tj.state!=="running")return null;if(typeof winMs!=="number"||!Number.isFinite(winMs))winMs=Infinity;var nowMs=Date.now();var offPath=pth.join(DIR,sid+${tokOffsetExtLiteral});var offset=0;try{/*v0.2.9 (Q5 Fix 3): mtime+size cache for <sid>.offset sidecar parse, mirroring __ccsdAgCache (§F aggregation cc-status.js:2037-2040). Long sessions grow the sidecar to ~185KB (527 buckets, measured 2026-07-21) — JSON.parse takes ~1.04ms per tick = 58% of per-tick EH sync I/O during streaming. The hook writes <sid>.offset only on TOK_EVENT fires (sub-second to multi-second cadence) via atomic tmp+rename, so (mtimeMs,size) is a reliable content-change signal between fires. stat-first → cache hit reuses parsed sc; miss → re-read+parse+cache. Stale-cache risk: bounded — a stale offset makes computeLiveDelta read a few extra bytes from the jsonl tail (bounded by the 512KB cap above), corrected on the next hook fire (the sole writer of the canonical offset). No correctness impact on the displayed total. Cache keyed on offPath (changes when user switches CC panels → natural isolation). Bounded by unique sessions per machine lifetime (<100); no pruning needed. See docs/STATES.md §9 perf section + CHANGELOG v0.2.9.*/var __oc=globalThis.__ccsdOffCache;if(!__oc)__oc=globalThis.__ccsdOffCache=Object.create(null);var __omt=0,__osz=0;try{var __os=fs.statSync(offPath);__omt=__os.mtimeMs;__osz=__os.size;}catch(_){}var __oe=__oc[offPath];var sc=(__oe&&__oe.mt===__omt&&__oe.sz===__osz&&__omt>0)?__oe.j:null;if(!sc&&__osz>0){try{sc=JSON.parse(fs.readFileSync(offPath,"utf8"));}catch(_){}if(sc){__oc[offPath]={j:sc,mt:__omt,sz:__osz};}}if(sc&&Number.isFinite(sc.offset))offset=sc.offset;}catch(_){}if(offset<=0)return null;var jsonlPath=null;if(typeof tj.transcript_path==="string"&&tj.transcript_path){jsonlPath=tj.transcript_path}else{var escaped=tj.cwd.replace(/[^a-zA-Z0-9._-]/g,"-");jsonlPath=pth.join(os.homedir(),".claude","projects",escaped,sid+".jsonl")}var stt;try{stt=fs.statSync(jsonlPath);}catch(_){return null;}if(!stt||!stt.isFile()||stt.size<=offset)return null;var toRead=stt.size-offset;var truncated=false;if(toRead>524288){offset=stt.size-524288;toRead=524288;truncated=true;}var fd=null;var result=null;try{fd=fs.openSync(jsonlPath,"r");var buf=Buffer.alloc(toRead);var br=fs.readSync(fd,buf,0,toRead,offset);if(br<=0){return null;}var lastNl=buf.lastIndexOf(0x0a,br-1);if(lastNl<0){return null;}var text=buf.toString("utf8",0,lastNl+1);var lines=text.split("\\n");var d={in:0,out:0,cr:0,cc5:0,cc1:0,cci:0};var lm=null;for(var i=0;i<lines.length;i++){var ln=lines[i];if(!ln.trim())continue;var obj;try{obj=JSON.parse(ln);}catch(_){continue;}if(!obj||obj.type!=="assistant")continue;var ts=Date.parse(obj.timestamp);if(!Number.isFinite(ts))continue;if(winMs!==Infinity&&ts<(nowMs-winMs))continue;if(obj.isSidechain===true)continue;var model=(obj.message&&obj.message.model)||"";if(typeof model==="string"&&model.indexOf("<synthetic>")===0)continue;var u=(obj.message&&obj.message.usage)||{};var hasCcObj=u.cache_creation&&typeof u.cache_creation==="object";d.in+=u.input_tokens||0;d.out+=u.output_tokens||0;d.cr+=u.cache_read_input_tokens||0;d.cc5+=hasCcObj?(u.cache_creation.ephemeral_5m_input_tokens||0):0;d.cc1+=hasCcObj?(u.cache_creation.ephemeral_1h_input_tokens||0):0;d.cci+=hasCcObj?0:(u.cache_creation_input_tokens||0);if(model)lm=model;}result={delta:d,lastModel:lm,truncated:truncated};}finally{if(fd!==null){try{fs.closeSync(fd);}catch(_){}}}return result;}catch(_){return null;}}function showTokQuickPick(){if(typeof globalThis.__ccsdDebug==="undefined"){try{globalThis.__ccsdDebug=(process.env.CCSD_DEBUG==="1"||process.env.CCSD_DEBUG==="true")}catch(_){globalThis.__ccsdDebug=false}}/*v0.5.36 rev2: REMOVED the withProgress Notification (initial v0.5.36 draft) — it popped an intrusive "Loading token stats…" panel on EVERY click AND misleadingly suggested a network fetch. Config is 100% LOCAL: getConfiguration + readTok of ~/.claude/cc-status-dot/<sid>.json; ZERO network calls; works fully offline. The first-click latency is VSCode's showQuickPick cold-start (picker UI widget + codicon font first-init, ~200-500ms once per session) — extension code CANNOT eliminate it; subsequent clicks are warm + fast. Retained: zero-sync-I/O instrumentation gated by CCSD_DEBUG=1 (in-memory __marks + async OutputChannel dump) so the user can confirm the bottleneck via the "CCSD Debug" channel — avoids the Anchor B Heisenbug (patch.ts:2772: appendFileSync shifted tick timing -> masked the bug).*/var __dbg=globalThis.__ccsdDebug===true;var __marks=__dbg?[]:null;function __mk(p){if(__marks){__marks.push({p:p,t:(typeof performance!=="undefined"?performance.now():Date.now())})}}function __dump(){if(__marks&&__marks.length){try{if(!globalThis.__ccsdDbgCh){globalThis.__ccsdDbgCh=vs.window.createOutputChannel("CCSD Debug")}var __ms="[tokPick]";for(var __i=0;__i<__marks.length;__i++){__ms+=" "+__marks[__i].p+(__i>0?(" +"+(__marks[__i].t-__marks[__i-1].t).toFixed(1)+"ms"):"")}globalThis.__ccsdDbgCh.appendLine(__ms);globalThis.__ccsdDbgCh.show(true)}catch(_){}}}__mk("click");var cfg=vs.workspace.getConfiguration("ccStatusDot");var curWin=cfg.get("tokenStatsWindow","all");var curMode=cfg.get("tokenDisplayMode","both");var curNotify=cfg.get("notify",true);var curFocus=cfg.get("notifyWhenFocused",true);var curSound=cfg.get("notifySound","Glass");var curVis=cfg.get("tokenSbiVisible",true);var j=readTok();var tok=j&&j.tokens;var SEP={kind:vs.QuickPickItemKind.Separator,label:""};var items=[{label:tr("qpStatsWindowLabel")+curWin,detail:tr("qpStatsWindowDetail")},{label:tr("qpDisplayLabel")+curMode,detail:tr("qpDisplayDetail")}];items.push(SEP);items.push({label:(curVis?"$(eye) ":"$(eye-closed) ")+tr("qpSbiVisibleLabel")+(curVis?tr("qpOn"):tr("qpOff")),detail:"ccStatusDot.tokenSbiVisible"});items.push({label:(curNotify?"$(check) ":"")+tr("qpNotifyCompletion"),detail:"ccStatusDot.notify"});items.push({label:(curFocus?"$(check) ":"")+tr("qpNotifyFocused"),detail:"ccStatusDot.notifyWhenFocused"});items.push({label:tr("qpSoundLabel")+curSound,detail:"ccStatusDot.notifySound"});if(tok){items.push(SEP);items.push({label:"$(pulse) "+tr("qpSessionTotalPrefix")+fmtTok(sumTok(tok.total))+" tok"+(tok.cost!=null?" \u00b7 "+fmtUsdApprox(tok.cost):""),detail:tr("qpSessionTotalDetail")});if(tok.cost_24h!=null)items.push({label:"$(calendar) "+tr("qpCost24hLabel")+fmtUsdApprox(tok.cost_24h),detail:tr("qpCost24hDetail")});if(tok.cost_7d!=null)items.push({label:"$(calendar) "+tr("qpCost7dLabel")+fmtUsdApprox(tok.cost_7d),detail:tr("qpCost7dDetail")});if(tok.cost_30d!=null)items.push({label:"$(calendar) "+tr("qpCost30dLabel")+fmtUsdApprox(tok.cost_30d),detail:tr("qpCost30dDetail")});if(tok&&tok.cost_partial===true)items.push({label:"$(info) "+tr("qpCostPartialLabel"),detail:tr("qpCostPartialDetail")});if(j&&j.since){var el=Date.now()-j.since;if(el>0&&j.state==="running")items.push({label:"$(clock) "+tr("qpTurnRunningTpl").replace("{secs}",Math.round(el/1000)),detail:tr("qpTurnRunningDetail")})}}items.push(SEP);items.push({label:"$(clippy) "+tr("qpCopyLabel"),detail:tr("qpCopyDetail")});items.push({label:"$(trash) "+tr("qpResetLabel"),detail:tr("qpResetDetail")});items.push({label:"$(go-to-file) "+tr("qpOpenDirLabel"),detail:tr("qpOpenDirDetail")});items.push(SEP);items.push({label:"$(settings-gear) "+tr("qpOpenSettingsLabel"),detail:tr("qpOpenSettingsDetail")});if(__mk){__mk("bq")}vs.window.showQuickPick(items,{placeHolder:tr("qpPlaceHolder")}).then(function(p){__dump();if(!p)return;var label=p.label;if(label.indexOf(tr("qpStatsWindowLabel"))===0){vs.window.showQuickPick(${tokWinKeysLiteral},{placeHolder:tr("spSelectWindow")}).then(function(w){if(w)cfg.update("tokenStatsWindow",w,vs.ConfigurationTarget.Global)})}else if(label.indexOf(tr("qpDisplayLabel"))===0){vs.window.showQuickPick(["token","cost","both"],{placeHolder:tr("spSelectDisplay")}).then(function(m){if(m)cfg.update("tokenDisplayMode",m,vs.ConfigurationTarget.Global)})}else if(label.indexOf(tr("qpSbiVisibleLabel"))===0){cfg.update("tokenSbiVisible",!curVis,vs.ConfigurationTarget.Global)}else if(label.indexOf(tr("qpNotifyCompletion"))>=0){cfg.update("notify",!curNotify,vs.ConfigurationTarget.Global)}else if(label.indexOf(tr("qpNotifyFocused"))>=0){cfg.update("notifyWhenFocused",!curFocus,vs.ConfigurationTarget.Global)}else if(label.indexOf(tr("qpSoundLabel"))===0){vs.window.showQuickPick(["Basso","Bell","Blow","Bottle","Frog","Funk","Glass","Hero","Morse","Ping","Pop","Purr","Sosumi","Submarine","Tink"],{placeHolder:tr("spSelectSound")}).then(function(s){if(s)cfg.update("notifySound",s,vs.ConfigurationTarget.Global)})}else if(label.indexOf(tr("qpCopyLabel"))>=0){var tc=j&&j.tokens?sumTok(j.tokens.total):0;try{vs.env.clipboard.writeText(String(tc));vs.window.showInformationMessage(tr("fbCopiedTpl").replace("{n}",tc).replace("{fmt}",fmtTok(tc)))}catch(e){}}else if(label.indexOf(tr("qpResetLabel"))>=0){try{var sid=globalThis.__ccsdActiveSid||globalThis.__ccsdLastActiveSid||"";if(sid){try{fs.writeFileSync(pth.join(DIR,sid+${tokForceRereadExtLiteral}),String(Date.now()))}catch(e){}vs.window.showInformationMessage(tr("fbResetOk"))}}catch(e){vs.window.showErrorMessage(tr("fbResetFailPrefix")+(e&&e.message||String(e)))}}else if(label.indexOf(tr("qpOpenDirLabel"))>=0){try{vs.commands.executeCommand("revealFileInOS",DIR)}catch(e){}}else if(label.indexOf(tr("qpOpenSettingsLabel"))>=0){vs.commands.executeCommand("workbench.action.openSettings","ccStatusDot")}})}`,
        // === §E.2 v0.3.0 Rate sampling + sparkline + sidecar (lane D) ===
        // New helpers feed the §G tick's inline SBI suffix ("12.3k tok ·
        // 1.2k/s · ~$0.42"). v0.5.1 REMOVED the webview chart panel (form C:
        // showRateChart + __ccsdRateChartHtml/Css/Js + __ccsdGetNonce + the
        // chart-panel postMessage setInterval + its QuickPick entry) — the
        // inline suffix covers the user's actual need and the panel added
        // surface area + a 3rd setInterval. State lives on globalThis maps
        // keyed by sid (per-session isolation, N<100 bounded by unique
        // sessions per machine). Ring buffer cap 16 entries = 8s history @
        // 500ms tick; sparkline renders last 8 entries (4s). EMA peak
        // (τ≈2s, computed as max*0.85+delta*0.15 per tick when delta is
        // below max, immediate jump when delta exceeds max) auto-scales
        // sparkline so a single burst doesn't peg █ forever + idle doesn't
        // collapse to ▁▁▁▁. CRITICAL correctness (lane D R2): rate_real
        // samples INPUT+OUTPUT only (excludes cache_read, which at 85% of
        // a 796M session produces meaningless multi-M tok/s spikes). rate
        // window = 5s sliding (10 samples @ 500ms); single-hook-fire gap
        // = 1/10 weight = smoothing OK. Sidecar <sid>.rate written throttled
        // 2s (only when running) for cross-reload ring buffer continuity;
        // loaded back into __ccsdRateBuf on first §G tick for an active sid.
        // Hook is NOT the writer (职责分离 — hook owns jsonl+offset, IIFE
        // owns rate); tmp+rename atomic mirrors cc-status.js writeJsonAtomic.
        `var RATE_BUF_CAP=16;var RATE_SPARK_BARS=8;var RATE_WINDOW_MS=5000;var RATE_FLUSH_MS=5000;var RATE_SPARK_CHARS="▁▂▃▄▅▆▇█";if(!globalThis.__ccsdRateBuf)globalThis.__ccsdRateBuf=Object.create(null);if(!globalThis.__ccsdRatePrev)globalThis.__ccsdRatePrev=Object.create(null);if(!globalThis.__ccsdRateMax)globalThis.__ccsdRateMax=Object.create(null);if(!globalThis.__ccsdRateFlush)globalThis.__ccsdRateFlush=Object.create(null);if(!globalThis.__ccsdRateLoaded)globalThis.__ccsdRateLoaded=Object.create(null);function __ccsdRateFromBuf(arr,nowMs){try{if(!arr||arr.length===0)return 0;var cutoff=nowMs-RATE_WINDOW_MS;var sumD=0,oldestTs=nowMs;for(var i=arr.length-1;i>=0;i--){if(arr[i].ts<cutoff)break;sumD+=arr[i].d;if(arr[i].ts<oldestTs)oldestTs=arr[i].ts;}var windowS=(nowMs-oldestTs)/1000;return windowS>0.1?sumD/windowS:0;}catch(_){return 0;}}function __ccsdRateSample(sid,realNow,totalNow,isRunning,nowMs){try{if(!sid)return null;var buf=globalThis.__ccsdRateBuf,prev=globalThis.__ccsdRatePrev,mx=globalThis.__ccsdRateMax;if(!buf[sid]){buf[sid]=[];}if(typeof prev[sid]!=="number")prev[sid]=-1;if(typeof mx[sid]!=="number")mx[sid]=0;var delta=0;if(isRunning&&prev[sid]>=0&&realNow>=prev[sid]){delta=realNow-prev[sid];}prev[sid]=isRunning?realNow:-1;var arr=buf[sid];arr.push({ts:nowMs,d:delta,total:totalNow});while(arr.length>RATE_BUF_CAP)arr.shift();if(delta>mx[sid]){mx[sid]=delta;}else{mx[sid]=mx[sid]*0.85+delta*0.15;}if(mx[sid]<1)mx[sid]=1;var rate=__ccsdRateFromBuf(arr,nowMs);return{rate:rate,max:mx[sid],buf:arr,delta:delta};}catch(_){return null;}}function __ccsdRateSpark(arr,peak){try{if(!arr||arr.length===0||peak<1)return"";var n=arr.length,start=Math.max(0,n-RATE_SPARK_BARS);var out="";for(var i=start;i<n;i++){var v=arr[i].d/peak;var idx=Math.max(0,Math.min(7,Math.floor(v*8)));out+=RATE_SPARK_CHARS.charAt(idx);}while(out.length<RATE_SPARK_BARS&&out.length>0){out=RATE_SPARK_CHARS.charAt(0)+out;}return out;}catch(_){return "";}}function __ccsdRateFlush(sid,arr,mx,nowMs){try{if(!sid||!arr||arr.length===0)return;var fm=globalThis.__ccsdRateFlush;if(!fm[sid])fm[sid]=0;if(nowMs-fm[sid]<RATE_FLUSH_MS)return;fm[sid]=nowMs;var payload={v:1,sid:sid,last_ts:nowMs,recent_max:mx,samples:arr.slice(-600).map(function(s){return{t:s.ts,d:s.d,total:s.total};})};var tmpPath=pth.join(DIR,sid+".rate.tmp");var finalPath=pth.join(DIR,sid+".rate");try{fs.writeFileSync(tmpPath,JSON.stringify(payload));try{fs.renameSync(tmpPath,finalPath);}catch(_){try{fs.unlinkSync(tmpPath);}catch(__){}}}catch(_){}}catch(_){}}function __ccsdRateLoad(sid){try{if(!sid)return null;var ld=globalThis.__ccsdRateLoaded;if(ld[sid])return null;ld[sid]=true;var p=pth.join(DIR,sid+".rate");var raw=fs.readFileSync(p,"utf8");var obj=JSON.parse(raw);if(!obj||obj.sid!==sid||!Array.isArray(obj.samples))return null;var buf=globalThis.__ccsdRateBuf,mx=globalThis.__ccsdRateMax,prev=globalThis.__ccsdRatePrev;buf[sid]=obj.samples.slice(-RATE_BUF_CAP).map(function(s){return{ts:s.t,d:s.d,total:s.total};});mx[sid]=Number(obj.recent_max)||1;if(mx[sid]<1)mx[sid]=1;prev[sid]=-1;return obj;}catch(_){return null;}}`,
        ,
        // === §F Per-tick 4-light aggregation (the __ccsdSbiTimer body) ===
        // v0.5.2 (#4): shared transcript-activity gate used by BOTH the §F
        // aggregate decay and the §H per-tab decay. Keys the running→idle
        // downgrade off REAL transcript (.jsonl) freshness instead of the
        // `since` transition timestamp alone. `since` is frozen by Stop
        // inflight>0 preserveSince + by long single-tool execs (no hook fires
        // mid-tool), so it goes stale while a session is ACTIVELY streaming
        // → false-decay to gray. The .jsonl keeps growing during streaming, so
        // its mtime is the true activity signal. Resolution mirrors
        // computeLiveDelta's rule EXACTLY: prefer j.transcript_path
        // (authoritative, persisted by the hook); else the cwd→projects-dir
        // escape fallback ( /[^a-zA-Z0-9._-]/g → '-' ) for old pre-v0.2.5
        // <sid>.json without transcript_path. Stuck-drift case (CC Stop
        // inflight=1 payload drift + spurious Stop heartbeats refresh the
        // STATE-FILE mtime but NOT the transcript) → .jsonl stays stale →
        // returns false → decay still fires (the v0.2.6 since-decay fix is
        // PRESERVED; only the false-positive stale-since+FRESH-transcript =
        // active case is suppressed). statSync only reaches here on
        // decay-CANDIDATES (since>THRESH already true at the call site), so
        // the per-tick cost is bounded by N running sessions past the
        // threshold. Any miss (no transcript_path, no cwd, jsonl absent,
        // statSync throw) → returns false → safe decay direction.
        /*v0.5.5 cleanup: __ccsdTranscriptFresh removed (dead code — v0.5.4 removed the running→idle decay which was its only caller; proposal 2 state-machine makes it unnecessary).*/ `try{if(!globalThis.__ccsdSbiTimer){function __ccsdSbiTick(){`,
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
        // v0.2.8 round-2 (MEDIUM efficiency regression): the `.endsWith(".json")`
        // filter alone matches BOTH `<sid>.json` AND the v0.2.7-introduced
        // `<sid>.tokens.json` snapshot. The snapshot has no `state` field
        // (only v/sid/since/cwd/transcript_path/tokens/written_at), so its
        // JSON.parse contributes nothing to the 4-light counts (`j.state===
        // undefined` falls through to the idle catch-all). Skipping it here
        // restores v0.2.6 per-tick parse cost — every 500ms tick during an
        // active turn no longer re-parses a ~50KB snapshot per on-disk
        // session. The baked literal (tokTokensExtLiteral) is the single
        // source of truth, so a future rename of TOK_TOKENS_EXT flows through
        // automatically (pinned cross-file by test-contract-sync.mjs).
        `if(!files[i].endsWith(".json")||files[i].endsWith(${tokTokensExtLiteral}))continue;`,
        `try{`,
        `var fp=pth.join(DIR,files[i]);__stale[files[i]]=true;`,
        `var __mt=0,__sz=0;try{var __s=fs.statSync(fp);__mt=__s.mtimeMs;__sz=__s.size;}catch(e3){}`,
        `var __e=__cc[files[i]];`,
        `var j=(__e&&__e.mt===__mt&&__e.sz===__sz)?__e.j:JSON.parse(fs.readFileSync(fp,"utf8"));`,
        `if(!__e||__e.mt!==__mt||__e.sz!==__sz){__cc[files[i]]={j:j,mt:__mt,sz:__sz};}`,
        `var st=j.state;var since=j.since;`,
        /*§F four-light decay (done>5min / interrupted>7d / running-stale) — unified predicate __ccsdDecayState (decayInterrupted=true — four-light aggregates interrupted at 7d per STATES.md §7.5); see its declaration for full rationale.*/ `st=__ccsdDecayState(st,since,j,Date.now(),true);`,
        /*v0.5.13 (state-machine fix): count is PRIORITY-OVERLAY + mutually EXCLUSIVE — mirrors §H's early-return. A session goes into exactly ONE bucket. Priority: pending(🔵) > interrupted(🔴) > running(🟡) > done(🟢) > idle(⚪, not rendered). Pre-0.5.13 pending was counted INDEPENDENTLY of state (a running+pending session added +1 yellow AND +1 blue), violating the user spec "blue wins over yellow" (this was the exact cause of the reported "two-yellow one-blue": zombie 90cc10fb was running+pending and got double-counted). Two pending sources OR'd as before — file flag (Notification hook, cross-window) OR per-window __ccsdPendingSet (rename_tab IPC, sync) — now made exclusive with state via st!=="idle" (decayed → no 🔵 false-stick).*/
        // v0.2.5 (problem 1 fix): OR two sources — the file-pending flag
        // (Notification hook → cc-status.js atomic write, async but
        // cross-window) OR the per-window globalThis set (rename_tab IPC →
        // synchronous, source-of-truth, but only covers THIS window's
        // panels). files[i].slice(0,-5) strips the ".json" suffix to recover
        // the sid key the set uses. The set is maintained by Anchor B's replB
        // (in this same IIFE's host extension) and cleared by onDidDispose
        // below; the file-pending branch still covers cross-window scenarios
        // where the rename_tab for a panel in window W1 cannot update W2's
        // globalThis. decay (st!=="idle") still applies after the OR so the
        // 30min/5min/24h GC rules are not bypassed.
        `var __ps=globalThis.__ccsdPendingSet;`,
        `var isPend=((j.pending===true)||(__ps&&__ps[files[i].slice(0,-5)]===true)||(globalThis.__ccsdUserDialogSet&&globalThis.__ccsdUserDialogSet[files[i].slice(0,-5)]===true))&&st!=="idle";`,
        `if(isPend){ag.pending++;}`,
        `else if(st==="interrupted"){ag.interrupted++;}`,
        `else if(st==="running"){ag.running++;}`,
        `else if(st==="done"){ag.done++;}`,
        `else{st="idle";ag.idle++;}`,
        `}catch(e){}`,
        `}`,
        // Prune orphaned cache entries (files unlinked by writer GC since the
        // last tick). O(N) JS-object iteration; bounded by unique names seen.
        `try{var __ks=Object.keys(__cc);for(var k=0;k<__ks.length;k++){if(!__stale[__ks[k]]){delete __cc[__ks[k]];}}}catch(e){}`,
        `}catch(e){}`,
        `/*cap each light's count at 4 so the "N" variant displays for >=4.*/`,
        `var cap=function(n){return n>=SBI_LIGHT_CAP?SBI_LIGHT_CAP:n;};`,
        `var cd=cap(ag.done),cr=cap(ag.running),cp=cap(ag.pending),ci=cap(ag.interrupted);`,
        // counts[] indexes match CFG[]: done/running/pending/interrupted.
        // Per-SBI render: (n===0?DIM_EM:CFG[k].em)+(n>=4?"N":""+n). NO
        // backgroundColor / color field — the emoji ball carries its own color.
        // See docs/STATES.md §7 for the full render rule.
        `var counts=[cd,cr,cp,ci];`,
        `/*tooltip carries the UNcapped breakdown so the user sees actual counts even when lights cap at N.*/`,
        `var tip=tr("ttCountsTpl").replace("{done}",ag.done).replace("{running}",ag.running).replace("{pending}",ag.pending).replace("{interrupted}",ag.interrupted);`,
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
        // → "🟢3 🟡1 ⚪0 ⚪0" (v0.1.18 space-separated; ⚪ since v0.2.3
        //   reverted the ⚪→🟤 pivot back to gray)
        //   was v0.1.16 "🟢3" / "🟡1" / "⚪0" / "⚪0" as 4 separate SBI texts.
        `try{if(globalThis.__ccsdSbi){var key=ag.done+","+ag.running+","+ag.pending+","+ag.interrupted;if(key!==globalThis.__ccsdSbiLastKey){globalThis.__ccsdSbiLastKey=key;var parts=[];for(var k=0;k<CFG.length;k++){var n=counts[k];parts.push((n===0?DIM_EM:CFG[k].em)+(n>=SBI_LIGHT_CAP?"N":""+n));}globalThis.__ccsdSbi.text=parts.join(" ");globalThis.__ccsdSbi.tooltip=tip;globalThis.__ccsdSbi.show();}}}catch(e){}`,
        // === §G Token SBI tick + threshold alert (shares __ccsdSbiTimer) ===
        // === v0.2.4: token SBI tick update (shares the same 500ms tick) ===
        // Reads the active CC panel's <sid>.json tokens field and updates the
        // right-side token SBI's text + tooltip. Re-reads ccStatusDot.*
        // configuration every tick (no cached config — plan §1.5 decision A,
        // "final consistency via getConfiguration every tick").
        //
        // Display logic:
        //   - no active sid / file missing / no tokens → "$(clock) —"
        //   - mode "token": "$(clock) 12.3k tok"
        //   - mode "cost":  "$(pulse) ~$0.42" (or "$(clock) —" if cost null)
        //   - mode "both":  "$(clock) 12.3k tok · ~$0.42" (cost hidden if null)
        //
        // v0.2.4 scope-alignment fixes:
        //   - inline cost now reads tok['cost_'+tWin] (per-window cost) so the
        //     token count and the $ shown on the same line describe the SAME
        //     time window (previously tok.cost = all-time session total was
        //     paired with the selected window's tokens, mixing scopes). Falls
        //     back to tok.cost only when the per-window cost is null AND the
        //     session cost is not (e.g. the writer couldn't price any bucket
        //     in the window but could price some bucket session-wide).
        //   - tooltip "Today (24h)" → "24h" (rolling-24h is NOT a calendar
        //     day; label was asymmetric with 7-day/30-day and misled users).
        //   - the token tick now reuses the 4-light aggregation's
        //     __ccsdAgCache entry for activeSid+'.json' when its mtime+size
        //     match (the aggregation scan runs ~30 lines above in the same
        //     500ms tick and already stat+read+cached the file). Steady-state
        //     token ticks become zero-extra fs.readFileSync.
        //
        // Threshold alerts (rolling-24h cost vs warnThresholdUsd):
        //   - compares tok.cost_24h (rolling 24h) — matches the user's "daily
        //     budget" mental model and naturally RE-ARMS when the window
        //     slides past old expensive turns. The previous implementation
        //     compared tok.cost (monotonic session total) which never drops,
        //     so "re-arm on dip" was unreachable in practice.
        //   - hysterisis: fire ONLY when crossing UP (prev<thr && cur>=thr),
        //     tracked via __ccsdLastWarnBelow24h (true while cost_24h is
        //     below thr). This gives ONE notification per genuine crossing
        //     instead of the prior per-turn spam (the old `lastWarnTs <
        //     tj.since` re-armed every new turn, firing every prompt once the
        //     threshold was crossed).
        //   - bypasses the notify() completion/focus gating (cost alerts are
        //     a budget monitor, not a turn-done notification — the user
        //     explicitly set warnThresholdUsd and expects alerts even with
        //     "Notify on completion" off or while VS Code is focused).
        //   - v0.2.4 round-3 (business-logic LOW fix): the alert now reads
        //     cfg.notifySound (default "Glass") and escapes it the same way
        //     notify() does, passing the result as sndOpt to dispatchNotify.
        //     Pre-fix the call passed sndOpt=null → dispatchNotify's
        //     `sndStr=sndOpt?(' sound name "'+sndOpt+'"'):''` branch produced
        //     an empty string and the osascript notification played NO sound,
        //     so the user heard the completion chime but a budget breach
        //     (arguably the more important alert) was silent. Same cfg.read +
        //     escape rule as notify() so a future sound-handling change lands
        //     in both via dispatchNotify.
        `try{var tsbi=globalThis.__ccsdTokSbi;if(tsbi){var cfg=vs.workspace.getConfiguration("ccStatusDot");if(cfg.get("tokenSbiVisible",true)===false){tsbi.hide()}else{tsbi.show()}if(globalThis.__ccsdActiveSid==="__switching__"){/*v0.5.36 rev6: sentinel check FIRST (before scan) — if the active panel is initializing (sid not captured), per-panel tick rev4 / onDidChangeViewState rev5 set __ccsdActiveSid="__switching__". Show loading REGARDLESS of what the scan finds — fixes the case where the scan resolves a stale-active prev-session panel and skips the sentinel, reading stale tokens. By checking globalThis.__ccsdActiveSid directly, the sentinel takes absolute priority.*/if(globalThis.__ccsdTokSbiLastText!=="$(sync~spin)"){globalThis.__ccsdTokSbiLastText="$(sync~spin)";tsbi.text="$(sync~spin)"}return}var activeSid="";/*v0.5.36 rev5: mirror companion favStatusBar activeCcSidOrLoading — scan __ccsdSidToPanel for panelTab.active===true. VSCode's panelTab.active flips INSTANTLY on tab switch (real-time), unlike __ccsdActiveSid which lags ≤500ms (written by per-panel tick/Anchor A). This fixes: (a) loaded-session switch showing stale prev-session tokens — scan finds the new active panel immediately; (b) unnecessary loading flicker on loaded switches — no sentinel set when sid is known. The __switching__ sentinel (per-panel tick rev4) still handles the initializing case (active panel but sid not captured → not in the map → fallback to sentinel).*/var __spm=globalThis.__ccsdSidToPanel;if(__spm){for(var __pk in __spm){if(__spm[__pk]&&__spm[__pk].active===true){activeSid=__pk;break;}}}if(!activeSid){activeSid=globalThis.__ccsdActiveSid||globalThis.__ccsdLastActiveSid||"";}var tWin=cfg.get("tokenStatsWindow","all");var tMode=cfg.get("tokenDisplayMode","both");var showCost=cfg.get("showCost",true);if(activeSid){var tj=null;try{var ajf=activeSid+".json";var ag=globalThis.__ccsdAgCache;var cached=ag&&ag[ajf];if(cached){var __st2=0,__sz2=0;try{var __s2=fs.statSync(pth.join(DIR,ajf));__st2=__s2.mtimeMs;__sz2=__s2.size;}catch(e4){}if(__st2===cached.mt&&__sz2===cached.sz){tj=cached.j}}}catch(e4b){}if(!tj){try{tj=JSON.parse(fs.readFileSync(pth.join(DIR,activeSid+".json"),"utf8"))}catch(e5){}}/*v0.2.7 Q1 (tokens persistence): <sid>.tokens.json fallback. If tj is null (post-SessionEnd pre-resume-fire: <sid>.json was deleted by SessionEnd but the cumulative .tokens.json snapshot survives) OR tj.tokens is missing (SessionStart wrote a fresh <sid>.json with no tokens yet — TOK_EVENTS excludes SessionStart so no incremental read fired), try reading <sid>.tokens.json and merge its tokens + identifying fields (since/cwd/transcript_path for tooltip) into tj. This closes the post-restart 0-window: the FIRST IIFE tick on VSCode resume shows non-zero tokens BEFORE any TOK_EVENT fire writes them to <sid>.json. State stays tj.state (or undefined when .json is missing) — computeLiveDelta returns null on missing/!=='running' state so live-delta stays 0 (acceptable: the bar shows historical cumulative, just no live increment, until the next TOK_EVENT fire). The merge is field-by-field conditional so a later .json with fresh tokens takes precedence over a stale snapshot.*/if(!tj||!tj.tokens){try{var __snap=JSON.parse(fs.readFileSync(pth.join(DIR,activeSid+${tokTokensExtLiteral}),"utf8"));if(__snap&&__snap.tokens){if(!tj){tj={}}if(!tj.tokens)tj.tokens=__snap.tokens;if(!tj.since&&__snap.since)tj.since=__snap.since;if(!tj.cwd&&__snap.cwd)tj.cwd=__snap.cwd;if(!tj.transcript_path&&__snap.transcript_path)tj.transcript_path=__snap.transcript_path;}}catch(_){}}/*v0.2.5 problem 2: live delta = IIFE-side incremental read of the parent transcript's [sidecar.offset..jsonl.size] byte range. Strict invariants (see computeLiveDelta JSDoc above): skip unless tj.tokens + tj.cwd + activeSid + tj.state==='running' + sidecar.offset>0. IIFE never writes sidecar/jsonl, so the hook remains the sole writer and the delta is race-free. tokenLiveDeltaEnabled (default true) lets the user disable on perf-sensitive machines.*/var liveInfo=null;try{if(cfg.get("tokenLiveDeltaEnabled",true)===true){var __winMs=TOK_WIN_MS[tWin];liveInfo=computeLiveDelta(tj,activeSid,__winMs);}}catch(_){}var __ld=liveInfo?liveInfo.delta:null;var __lt=liveInfo?liveInfo.truncated===true:false;var __lm=liveInfo?liveInfo.lastModel:null;var dIn=__ld?__ld.in:0,dOut=__ld?__ld.out:0,dCr=__ld?__ld.cr:0,dCc5=__ld?__ld.cc5:0,dCc1=__ld?__ld.cc1:0,dCci=__ld?__ld.cci:0;var dSum=dIn+dOut+dCr+dCc5+dCc1+dCci;try{var tok=tj&&tj.tokens;if(tok&&tok.windows&&tok.windows[tWin]){var w=tok.windows[tWin];var total=sumTok(w)+dSum;/*v0.3.0 (lane D): rate sampling per-tick. real_now = input+output (hook baseline w.in+w.out + live delta dIn+dOut) \u2014 deliberately EXCLUDES cache_read/cache_creation because at the user's 796M cache-dominated session they would produce meaningless multi-M tok/s spikes (lane D R2). is_running gate: when state!=='running' the rate naturally decays to 0 (delta=0 every tick); sidecar flush only when running. Sparkline + numeric suffix format governed by cfg.rateDisplayMode (off|numeric|sparkline|both). v0.5.1: default changed both\u2192numeric (cleaner SBI; chart panel removed) AND separator changed from space to ' \u00b7 ' so rate sits at the same divider level as cost (renders '$(clock) 12.3k tok \u00b7 1.2k/s \u00b7 ~$0.42'). One-shot sidecar load via __ccsdRateLoad (idempotent via __ccsdRateLoaded) restores ring buffer from <sid>.rate cross-reload.*/var realNow=((w.in||0)+(w.out||0))+dIn+dOut;var isRunning=(tj.state==="running");try{__ccsdRateLoad(activeSid)}catch(_){}var rateInfo=__ccsdRateSample(activeSid,realNow,total,isRunning,Date.now());var rateSuffix="";var rateMode=cfg.get("rateDisplayMode","numeric");if(rateInfo&&rateMode!=="off"&&(isRunning||rateInfo.rate>0)){var sp=(rateMode==="both"||rateMode==="sparkline")?__ccsdRateSpark(rateInfo.buf,rateInfo.max):"";var nm=((rateMode==="both"||rateMode==="numeric")&&rateInfo.rate>0)?(fmtRate(rateInfo.rate)+"/s"):"";var rs=[sp,nm].filter(function(x){return x;}).join(" ");if(rs)rateSuffix=" \u00b7 "+rs;if(isRunning){try{__ccsdRateFlush(activeSid,rateInfo.buf,rateInfo.max,Date.now())}catch(_){}}}var winCost=tok["cost_"+tWin];if(winCost==null)winCost=tok.cost;/*v0.2.6 round-3 MEDIUM (reader-logic): cost mirrors ONLY the hook's last fire, while dSum adds live bytes the hook hasn't seen yet. Suppress the cost suffix during streaming (dSum>0) so the bar never pairs a fresh token count with a stale cost. Restored to fmtUsdApprox(winCost) once dSum===0 (idle/done/interrupted or steady state).*/if(showCost&&dSum===0){var costStr=winCost!=null?fmtUsdApprox(winCost):""}else{costStr=""}/*v0.2.6 round-3 MEDIUM (reader-logic): consume computeLiveDelta's truncated flag (was dead after v0.2.5 removed ttLiveDeltaTruncated tooltip). Prefix with '\u2248' (U+2248 APPROXIMATELY EQUAL) when the 512KB tail cap fired so the user sees the displayed total is approximate (bytes before the tail are missed until the next hook fire).*/var livePfx=__lt?"\u2248":"";var tlabel;if(tMode==="cost"){tlabel=costStr?("$(pulse) "+costStr):"$(clock) \u2014"}else if(tMode==="token"){tlabel="$(clock) "+livePfx+fmtTok(total)+" tok"+rateSuffix}else{tlabel="$(clock) "+livePfx+fmtTok(total)+" tok"+rateSuffix+(costStr?" \u00b7 "+costStr:"")}/*v0.2.9 (Q5 Fix 2): token SBI text dedup, mirroring __ccsdTokSbiLastTip tooltip pattern (v0.2.6 round-3). Without this, every 500ms tick rewrites tsbi.text even when tlabel is byte-identical to the prior tick (steady token count in an idle/done session) \u2014 ~2 redundant IPC writes/sec to the renderer. Wrap each tsbi.text assignment (4 branches: normal tlabel here + 3 error/empty literals below) with the same dedup pattern keyed on the EXACT computed string. No cache-reset needed on branch transitions (unlike the tooltip cache which resets to null): the dedup naturally fires when the new value differs from the cached value, regardless of which branch produced the cached value. See docs/STATES.md \u00a79 perf section + CHANGELOG v0.2.9.*/if(globalThis.__ccsdTokSbiLastText!==tlabel){globalThis.__ccsdTokSbiLastText=tlabel;tsbi.text=tlabel;}var ttip=[tr("ttWindowTpl").replace("{win}",tWin),tr("ttSessionTotalTpl").replace("{fmt}",livePfx+fmtTok(sumTok(tok.total)+dSum))];if(dSum===0&&tok.cost!=null)ttip.push(tr("ttSessionCostTpl").replace("{cost}",fmtUsdApprox(tok.cost)));if(dSum===0&&tok.cost_24h!=null)ttip.push(tr("tt24hTpl").replace("{cost}",fmtUsdApprox(tok.cost_24h)));if(dSum===0&&tok.cost_7d!=null)ttip.push(tr("tt7dayTpl").replace("{cost}",fmtUsdApprox(tok.cost_7d)));if(dSum===0&&tok.cost_30d!=null)ttip.push(tr("tt30dayTpl").replace("{cost}",fmtUsdApprox(tok.cost_30d)));if(tok.cost_partial===true)ttip.push(tr("ttPartial"));/*v0.2.6 round-3 MEDIUM (reader-logic): overlay tok.last_model with liveInfo.lastModel so the tooltip reflects the live-tail model even before the next hook fire stamps it.*/var __lmv=__lm||(tok.last_model);if(__lmv)ttip.push(tr("ttLastModelTpl").replace("{model}",__lmv));if(tj.cwd)ttip.push(tr("ttProjectTpl").replace("{project}",tj.cwd));if(tj.activeSubagents&&Number(tj.activeSubagents)>0)ttip.push(tr("ttWorkflowGap"));ttip.push(tr("ttClickConfig"));var __tip=ttip.join("\\n");if(globalThis.__ccsdTokSbiLastTip!==__tip){globalThis.__ccsdTokSbiLastTip=__tip;tsbi.tooltip=__tip;}/*threshold alert: rolling-24h cost vs warnThresholdUsd, hysterisis re-arm*/var thr=cfg.get("warnThresholdUsd",0);if(thr>0&&tok.cost_24h!=null){if(globalThis.__ccsdLastWarnBelow24h===undefined)globalThis.__ccsdLastWarnBelow24h=tok.cost_24h<thr;var below=tok.cost_24h<thr;if(below){globalThis.__ccsdLastWarnBelow24h=true}else if(globalThis.__ccsdLastWarnBelow24h===true){globalThis.__ccsdLastWarnBelow24h=false;/*Cost alerts bypass the notify() completion/focus gates (v0.2.4 architecture MEDIUM fix): the user explicitly set a budget threshold, so it should fire even with \"Notify on completion\" off and while VS Code is focused. We therefore call dispatchNotify() directly (no gate checks) — the osascript escape rule + VS Code fallback are SHARED with notify() so a future fix to one path lands in both.*/try{var alSnd=cfg.get("notifySound","Glass");var alEscSnd=(""+alSnd).replace(/["\\\\]/g,function(c){return "\\\\"+c;});dispatchNotify(tr("alCostAlertTpl").replace("{cost}",fmtUsdApprox(tok.cost_24h)),"warn",alEscSnd);}catch(e6){}}}else if(tok&&tok.cost_24h==null&&globalThis.__ccsdLastWarnBelow24h!==undefined){globalThis.__ccsdLastWarnBelow24h=undefined}}else{if(globalThis.__ccsdTokSbiLastText!=="$(clock) 0 tok"){globalThis.__ccsdTokSbiLastText="$(clock) 0 tok";tsbi.text="$(clock) 0 tok";}var __tip=tr("ttNoDataTpl").replace("{sid}",activeSid.slice(0,8))+"\\n"+tr("ttClickConfig");/*v0.3.0 round-1 MEDIUM (tooltip IPC dedup): mirror v0.2.9 Q5 Fix 2 text-dedup pattern \u2014 wrap tsbi.tooltip assignment in the same __ccsdTokSbiLastTip gate the success branch uses. Without this, every 500ms tick in this no-data state rewrites tsbi.tooltip with a byte-identical string (~2 redundant IPC writes/sec to the renderer, the exact cost Q5 Fix 2 closed for tsbi.text). The prior __ccsdTokSbiLastTip=null reset is REMOVED: with the gate managing the cache, the dedup naturally re-fires on branch transitions (success tip X vs this branch's no-data tip always differ, so __ccsdTokSbiLastTip!==__tip holds on the first success tick after a transition). Mirrors the v0.2.9 text-dedup rationale ("No cache-reset needed on branch transitions ... the dedup naturally fires when the new value differs").*/if(globalThis.__ccsdTokSbiLastTip!==__tip){globalThis.__ccsdTokSbiLastTip=__tip;tsbi.tooltip=__tip;}}}catch(e){if(globalThis.__ccsdTokSbiLastText!=="$(clock) \u2014"){globalThis.__ccsdTokSbiLastText="$(clock) \u2014";tsbi.text="$(clock) \u2014";}var __tip=tr("ttUnavailableTpl").replace("{sid}",activeSid.slice(0,8));/*v0.3.0 round-1 MEDIUM (tooltip IPC dedup): mirror v0.2.9 Q5 Fix 2 text-dedup pattern. See the ttNoDataTpl branch above for the full rationale (gate replaces the prior __ccsdTokSbiLastTip=null reset; dedup re-fires naturally on branch transitions because the tooltip strings differ across branches).*/if(globalThis.__ccsdTokSbiLastTip!==__tip){globalThis.__ccsdTokSbiLastTip=__tip;tsbi.tooltip=__tip;}}}else{if(globalThis.__ccsdTokSbiLastText!=="$(clock) \u2014"){globalThis.__ccsdTokSbiLastText="$(clock) \u2014";tsbi.text="$(clock) \u2014";}var __tip=tr("ttNoPanel");/*v0.3.0 round-1 MEDIUM (tooltip IPC dedup): mirror v0.2.9 Q5 Fix 2 text-dedup pattern. The prior round-3 __ccsdTokSbiLastTip=null reset here was the cache-desync symmetry fix (ttNoPanel was the branch round-3 originally missed); with the dedup gate now applied uniformly to ALL 3 non-success branches AND the success branch, the symmetry is preserved by STRING DIFFERENCE instead of by null-reset (success tip X !== ttNoPanel tip holds on the first success tick after a transition, so the write fires). The most persistent leak this closes: a user with VS Code open but no CC panel previously leaked ~2 tooltip IPC writes/sec indefinitely (every 500ms tick rewrote tsbi.tooltip=tr("ttNoPanel") unconditionally).*/if(globalThis.__ccsdTokSbiLastTip!==__tip){globalThis.__ccsdTokSbiLastTip=__tip;tsbi.tooltip=__tip;}}}}catch(e){}`,
        `}catch(e){}`,
        `}globalThis.__ccsdSbiTick=__ccsdSbiTick;globalThis.__ccsdSbiTimer=setInterval(__ccsdSbiTick,${TICK_MS});__ccsdSbiTick();}}catch(e){}`,
        // === §H Per-panel tick (state-machine + notify dedup + svg switch) ===
        `var timer=setInterval(function(){`,
        `var p=t.panelTab;if(!p)return;`,
        `var sid=t.__ccsdSid;if(!sid){try{p.iconPath=ccuri(pth.join(RES,"claude-logo-idle.svg"))}catch(e){}/*v0.5.36 rev4 Fix 1: active panel but sid not yet captured (session still loading — e.g. a resumed historical session whose update_session_state hasn't fired). Assert the __switching__ sentinel EVERY tick (500ms poll, mirrors companion favStatusBar activeCcSidOrLoading) so §G tick shows loading instead of stale prev-session tokens. Without this, __ccsdActiveSid stays at the previous session (A) until B's sid lands → token SBI shows A's stale value.*/if(p.active===true){globalThis.__ccsdActiveSid="__switching__"}return;}`,
        // v0.2.4: keep globalThis.__ccsdActiveSid fresh for the token SBI tick.
        // Each CC panel runs its own per-panel tick (this setInterval) — the
        // ACTIVE panel's tick fires here every 500ms and updates the global so
        // the SBI tick (in the shared __ccsdSbiTimer above) sees the right sid.
        // p.active is the VS Code WebviewPanel.active flag (true when this
        // panel is the currently focused one).
        //
        // v0.2.4 race tighten: previously `p.active===true || typeof
        // p.active==="undefined"` updated the global from ANY panel whose
        // active flag was unset (which the code comment explicitly noted
        // happens for "some panel types"). In a 2-CC-panel window where both
        // had active===undefined, both panels' 500ms ticks overwrote the
        // global in turn, making the token SBI oscillate between sessions.
        // Now we ONLY publish on p.active===true. The fallback for the
        // single-panel-with-undefined-active case (the original rationale) is
        // preserved via __ccsdLastActiveSid: the per-panel tick still tracks
        // its own sid unconditionally into __ccsdLastActiveSid, and the
        // shared SBI tick (above) prefers __ccsdActiveSid, falling back to
        // __ccsdLastActiveSid when __ccsdActiveSid is empty/stale. This
        // bounds the multi-panel race to ONE overwrite per panel-activate
        // event (the user actually switches tabs) instead of every 500ms.
        `if(p.active===true){globalThis.__ccsdActiveSid=sid;globalThis.__ccsdLastActiveSid=sid}else if(typeof p.active==="undefined"&&!globalThis.__ccsdActiveSid){globalThis.__ccsdActiveSid=sid}`,
        // v0.5.3 (F1/F2): refresh the sid→title bridge every tick so rename_tab
        // updates flow through (t.__ccsdTitle is kept fresh by replA/replB on
        // every event fire; t.panelTab.title is the live webview label). The
        // companion's favToggleTab reads this to (a) resolve the right-clicked
        // background tab via activeTab.label and (b) label favorites with the
        // real session title. Best-effort, wrapped in try/catch — a missing
        // title just leaves the bridge entry stale (companion falls back).
        `try{if(globalThis.__ccsdSidToTitle&&sid){var __tt=t.__ccsdTitle||(t.panelTab&&t.panelTab.title)||"";if(__tt)globalThis.__ccsdSidToTitle[sid]=__tt;}}catch(_){}`,
        `try{if(globalThis.__ccsdSidToPanel&&sid){globalThis.__ccsdSidToPanel[sid]=t.panelTab;}}catch(_){}`,
        // v0.5.9 tab-title star prefix. v0.5.8 injected a clickable star INTO
        // the CC webview HTML (Prong 1 prototype-setter monkey-patch + Prong 2
        // per-panel read-modify-write). Forensics on CC 2.1.218 extension.js
        // proved this architecturally infeasible: CC sets webview.html exactly
        // ONCE at panel creation (3 createPanel paths) and never reassigns it,
        // so Prong 1's setter installed AFTER the only write never fires
        // (timing deadlock); Prong 2's read-modify-write forces a full webview
        // reload (VSCode replaces entire content on any .html assignment) which
        // destroys CC's React session state (scroll position, in-flight agent
        // responses, input draft, postMessage handshake). CSP + MutationObserver
        // were NOT blockers (both verified compliant). The reliable replacement
        // is a "★ " prefix on the TAB TITLE itself: the IIFE already owns
        // panelTab.title (ANCHOR_B) and already reads favorites every 500ms tick
        // via readFavSet() (mtime+size cached → picks up a companion
        // writeFavAtomic within one tick = ≤500ms). This needs NO webview
        // injection, NO CSP nonce, NO DOM coupling, NO reload — VSCode's
        // panelTab.title API is stable and reload-free.
        //
        // Base title source: t.__ccsdTitle (the LOGICAL title cached by
        // replA/replB from e.request.title, NEVER carries a ★). Using __ccsdTitle
        // (not the live panelTab.title) as the base PREVENTS ★★ stacking across
        // ticks AND keeps the §A sid→title bridge above publishing the un-starred
        // logical title (so resolveActiveSid's exact-label match against the
        // active tab still hits — see companion favToggleTab FAV.34). The
        // assignment is guarded by `if(__base)` so the title is never blanked
        // before the first rename_tab/update_session_state fires (CC keeps its
        // own title until then). The `panelTab.title !== __want` gate avoids a
        // redundant write on every tick when the fav state is unchanged (VSCode
        // would otherwise re-render the tab label 2×/sec for no visible change).
        `try{var __fset=readFavSet();var __isFav=!(!__fset||!__fset[sid]);var __base=t.__ccsdTitle||"";if(__base){var __want=__isFav?("\\u2605 "+__base):__base;if(t.panelTab.title!==__want)t.panelTab.title=__want;}}catch(_){}`,
        `var st=null,since=null,err="",pend=false;`,
        /* rejected-by-design (R-CI-06): §H reads sid.json DIRECTLY (NOT via §F's
         * __ccsdAgCache). Intentional: §H = per-tab active display (latency-
         * sensitive, active tab must read latest); §F = four-light aggregation
         * batch scan (perf-bounded, mtime+size cache ok). v0.5.12 unified them
         * (QW4) → §H/§F tick desync → decay divergence (tab gray / lights green)
         * → v0.5.23 reverted. DO NOT re-unify — re-unifying = re-arming the
         * decay-desync bug. This is the 3rd flip (v0.5.11 direct → v0.5.12 cache
         * → v0.5.23 direct); the split is the stable decision. */
        // v0.5.35 SENTINEL — three independent OR sources for `pend`, mirroring
        // §F. (1) j.pending via the Notification hook (cross-window file flag;
        // askUserQuestion NOT covered here — see Fact 1). (2) __ps via rename_tab
        // hasPendingPermissions (per-window IPC; askUserQuestion IS covered here
        // via can_use_tool → tool_permission_request → permissionRequests →
        // rename_tab hasPendingPermissions; this is the IMPLICIT DEPENDENCY).
        // (3) __ccsdUserDialogSet via requestUserDialog/ANCHOR_C (per-window IPC;
        // covers consent/refusal dialogs the Notification hook CANNOT see).
        // Each source is a SINGLE-WRITER, read FRESH per tick — R-INT-07 not_a_
        // symptom ③: three independent authorities OR-ed at independent fresh-
        // reading consumers, the structural inverse of the v0.5.18 shared mutable-
        // sink trap. RE-AUDIT TRIGGER: any CC update that drifts ANCHOR_C bytes,
        // changes askUserQuestion's can_use_tool routing, or adds notification_
        // type coverage for consent → re-audit which term covers which dialog.
        `try{var j=JSON.parse(fs.readFileSync(pth.join(DIR,sid+".json"),"utf8"));st=j.state;since=j.since;err=j.error||"";pend=(j.pending===true)||(globalThis.__ccsdPendingSet&&globalThis.__ccsdPendingSet[sid]===true)||(globalThis.__ccsdUserDialogSet&&globalThis.__ccsdUserDialogSet[sid]===true)}catch(e){}`,
        `if(!seeded){seeded=true;if(st==="done"||st==="interrupted")lastTermSince=since}`,
        `else if((st==="done"||st==="interrupted")&&since!==lastTermSince){`,
        ,
        /*v0.2.4 follow-up (round-2 e2e fix): multi-panel notify dedup. Each panel
         * runs its own per-panel tick with its own `seeded`/`lastTermSince` closure,
         * so when N panels show the same session, each observes the running→done
         * transition within a 500ms window and each fires notify() — N macOS
         * notifications + N VS Code messages for the same session. Key a global
         * dedup on (sid, since): the first panel to see a given terminal
         * transition claims it; later panels within the same `since` epoch skip.
         * A subsequent transition (new since) still fires because the key moves.
         * Cost alerts (warnThresholdUsd) intentionally bypass this — they are
         * budget-driven, not transition-driven, and live on a separate path.*/ `var __nkey=sid+":"+(since||0);`,
        `if(globalThis.__ccsdLastNotifyKey===__nkey){lastTermSince=since;}`,
        `else{globalThis.__ccsdLastNotifyKey=__nkey;lastTermSince=since;try{notify(st,err)}catch(e){}}`,
        `}`,
        `/*v0.2.9.1 Q7 fix: REMOVED the if(t.__ccsdPending)return yield. It left the tab on CC's NATIVE ORANGE logo whenever rename_tab carried hasPendingPermissions=true, and CC 2.1.216 fires that during workflow tool-use (not just real permission prompts) — so background workflow tabs went orange while the sid-independent aggregation correctly showed yellow. Permission prompts still surface as our blue via the FILE pending field (Notification hook -> j.pending -> the pend render branch at IIFE.12a). The tab now ALWAYS renders our icon (file state, or idle fallback at the no-sid/else paths — v0.5.35 reverts v0.5.35's green-fallback: the unknown-state fallback must be grey (honest 'unknown'), not green — v0.5.35's green wrongly signalled 'done' on session init / history reopen; the real state shows once sid arrives via update_session_state), never native orange. t.__ccsdPending is still SET (rename_tab) + feeds the bottom 🔵 via __ccsdPendingSet (aggregation, separate dimension).*/`,
        // v0.5.29 reader-side pending branch. The tab renders our blue
        // claude-logo-pending.svg when EITHER (a) the on-disk file flag
        // j.pending===true (written by the Notification hook — a real
        // permission/choice prompt CC is presenting; cross-window via disk)
        // OR (b) the in-window IPC set globalThis.__ccsdPendingSet[sid]
        // (fed by rename_tab hasPendingPermissions / update_session_state
        // waiting_input — both derive from permissionRequests.length>0, a
        // genuine open permission dialog in THIS session's webview), AND the
        // state was not decayed to idle. This mirrors §F's two-source OR
        // (R-INT-07 not_a_symptom ③: file flag is the independent cross-window
        // fallback, __ps the low-latency per-window authority; both readers
        // read fresh each tick, no shared EH-cached sink). v0.5.29 REMOVED
        // the v0.2.6 "blue-via-content" path that inferred pending from
        // Claude's last_assistant_message text (AWAIT_USER_RE) — it over-
        // fired on greeting replies. Normal turn-end → j.pending=false (Stop
        // clears) + __ps empty → falls through to done→green.
        //
        // v0.2.6 round-2 (HIGH reader-logic fix): apply state decay BEFORE
        // the pending check. Round-1 placed the done>5min / running-stale
        // 15min decay INSIDE the SVG selection below — leaving the `st`
        // variable RAW at the pending check, so `st!=="idle"` was dead code
        // (the writer only ever writes state='running'|'done'|'interrupted',
        // NEVER 'idle' — see cc-status.js writeJsonAtomic). Result: a done+
        // pending session (CC said "等你测试反馈") rendered BLUE FOREVER on
        // the tab, even after the user walked away for hours/days, while
        // the SBI aggregation tick (which DOES decay before its pending
        // count) had already stopped counting it → tab-vs-SBI divergence
        // exactly like the comment below claimed to prevent. Fix mirrors
        // the SBI tick's decay chain at §F. v0.5.2 (#4): per-tab and §F now
        // share ONE threshold (SBI_RUNNING_STALE_MS) + the same
        // __ccsdTranscriptFresh activity gate — the prior intentional 15min
        // (per-tab) vs 30min (SBI) divergence (and the SINCE_STALE_MS constant)
        // are retired so the two surfaces never disagree. Does NOT decay
        // interrupted here (round-2 LOW finding left as-is; interrupted+pending
        // still renders blue — rare in practice because StopFailure clears
        // pending at cc-status.js:558; the §F aggregate decays interrupted at
        // 7d, the only remaining per-tab-vs-SBI divergence — see STATES.md §7.4).
        `var now=Date.now();`,
        /*§H per-tab decay (done>5min / running-stale) — BEFORE the pending check so a decayed session with j.pending=true does not false-stick 🔵. Unified predicate __ccsdDecayState (decayInterrupted=false — interrupted stays red on tab for diagnostics, STATES.md §7.4); see its declaration for the full running-decay rationale.*/ `st=__ccsdDecayState(st,since,j,now,false);`,
        `/*reader pending (Notification file-flag OR __ps IPC permission set): render our blue svg. Guard st!=="idle" so a session decayed to idle above does not false-stick 🔵 forever.*/`,
        `if(pend && st!=="idle"){try{p.iconPath=ccuri(favOf(pth.join(RES,"claude-logo-pending.svg"),sid))}catch(e){}return}`,
        `var svg;`,
        `if(st==="interrupted"){svg=(flashSeq%2===0)?favOf(pth.join(RES,"claude-logo-error.svg"),sid):CC_DEFAULT}`,
        `/*v0.5.2 (F4): the running/done decay ternaries that lived HERE in v0.2.6 round-1 are removed as dead code. The round-2 fix moved decay BEFORE the pending check (the st="idle" assignments above), so by the time this SVG switch runs, a stale running/done session has ALREADY been downgraded to st="idle" and renders claude-logo-idle.svg via the idle branch below. The old ternaries' idle branches were therefore unreachable, and they referenced the now-retired 15min per-tab constant. Single decay site (above) eliminates the copy-paste-with-divergence that let per-tab and §F drift.*/`,
        `else if(st==="running"){svg=favOf(pth.join(RES,"claude-logo-running.svg"),sid)}`,
        `else if(st==="done"){svg=favOf(pth.join(RES,"claude-logo-done.svg"),sid)}`,
        `else if(st==="idle"){svg=pth.join(RES,"claude-logo-idle.svg")}`,
        `else{try{p.iconPath=ccuri(pth.join(RES,"claude-logo-idle.svg"))}catch(e){}return}`,
        `flashSeq++;`,
        `try{p.iconPath=ccuri(favOf(svg,sid))}catch(e){}`,
        `},${TICK_MS});`,
        // === §Z onDidDispose teardown + IIFE close ===
        `/*release this panel's 500ms tick + closed-over refs on panel close; on LAST panel out also clear the SBI singleton timer + dispose the single v0.1.17 SBI so the bottom bar can't freeze on a stale count. (v0.1.15/v0.1.16 used to loop over the 4-element __ccsdSbis array — gone with the pivot to one SBI.)*/`,
        `try{t.panelTab.onDidDispose(function(){clearInterval(timer);/*v0.2.5 (problem 1 fix): release this panel's entry in the window-scoped pending set so a closed panel does not false-stick the bottom 🔵. v0.2.5 round-1 (HIGH) correction: delete uses t.__ccsdSid (IIFE parameter, in scope) — the per-panel tick declares its own var sid=t.__ccsdSid INSIDE the 500ms tick closure, which is a sibling of this onDidDispose closure, so that sid is NOT visible here. Referencing it (the prior code) threw ReferenceError — silently swallowed by the inner try/catch for the delete (set entry stuck), and NOT swallowed for the else-if below (escaped to VSCode's event dispatcher, __ccsdActiveSid stayed pointed at the closed session). Reading t.__ccsdSid directly closes over the IIFE parameter (always in scope) instead.*/try{if(globalThis.__ccsdPendingSet)delete globalThis.__ccsdPendingSet[t.__ccsdSid]}catch(_){}/*v0.5.35 ANCHOR_C teardown: release this panel's entry in the user-dialog set so a panel closed mid-consent/refusal dialog cannot false-stick the tab blue. Mirrors the __ps release above (single-writer __ccsdUserDialogSet is set in ANCHOR_C's try and deleted in its finally for normal exits; this is the safety-net for panel-close mid-dialog). Uses t.__ccsdSid (IIFE parameter, always in scope — same reasoning as the __ccsdPendingSet delete above).*/try{if(globalThis.__ccsdUserDialogSet)delete globalThis.__ccsdUserDialogSet[t.__ccsdSid]}catch(_){}/*v0.4.0 FAV BRIDGE §Z: release this panel's entry in the sid→panel map so the companion's Favorites tree sees the session as closed (node grayed out, click degrades to Copy resume cmd). Symmetric to the §A preamble publish; uses t.__ccsdSid (IIFE parameter, always in scope — same reasoning as the __ccsdPendingSet delete above).*/try{if(globalThis.__ccsdSidToPanel&&t.__ccsdSid)delete globalThis.__ccsdSidToPanel[t.__ccsdSid]}catch(_){}/*v0.5.3 FAV BRIDGE §Z: release this panel's entry in the sid→title map (symmetric to the sid→panel delete above + the §A title init).*/try{if(globalThis.__ccsdSidToTitle&&t.__ccsdSid)delete globalThis.__ccsdSidToTitle[t.__ccsdSid]}catch(_){}globalThis.__ccsdPanelCount=(globalThis.__ccsdPanelCount||1)-1;if(globalThis.__ccsdPanelCount<=0){globalThis.__ccsdPanelCount=0;if(globalThis.__ccsdSbiTimer){clearInterval(globalThis.__ccsdSbiTimer);globalThis.__ccsdSbiTimer=null;}if(globalThis.__ccsdSbi){try{globalThis.__ccsdSbi.dispose()}catch(e){};globalThis.__ccsdSbi=null;globalThis.__ccsdSbiLastKey=null;}/*v0.2.4: also dispose the token SBI + its click command on last-panel-out*/if(globalThis.__ccsdTokSbi){try{globalThis.__ccsdTokSbi.dispose()}catch(e){};globalThis.__ccsdTokSbi=null;}if(globalThis.__ccsdActiveSid){globalThis.__ccsdActiveSid=""}if(globalThis.__ccsdLastActiveSid){globalThis.__ccsdLastActiveSid=""}}/*v0.2.4: if the disposed panel WAS the active one (but other panels remain), clear __ccsdActiveSid so the token SBI does not keep reading a closed session's <sid>.json. The next still-alive panel's 500ms tick will publish its own sid and repopulate the global (within 500ms — acceptable glitch window for the multi-panel case). v0.2.5 round-1 (HIGH): uses t.__ccsdSid (IIFE parameter, in scope) for the same reason as the delete above — the per-panel tick's var sid is NOT visible here.*/else if(globalThis.__ccsdActiveSid===t.__ccsdSid){globalThis.__ccsdActiveSid="";if(globalThis.__ccsdLastActiveSid===t.__ccsdSid)globalThis.__ccsdLastActiveSid=""}})}catch(e){}`,
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
// Writer-hook content hash. The writer hook (hooks/cc-status.js) carries a banner
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
        // v0.2.4: also publish the active sid to globalThis so the token SBI
        // tick (window-scoped, outside this panel closure) picks it up.
        //
        // v0.2.4 (business-logic HIGH fix): gate the publish on this panel
        // being the currently-active one (this.panelTab.active===true). The
        // prior unconditional publish meant ANY panel's update_session_state
        // event — including background panels CC heartbeats state-refresh —
        // overwrote __ccsdActiveSid, then the per-panel tick (500ms later)
        // overwrote it back to the active panel. Two CC panels A(active)+B
        // (background) therefore oscillated the token SBI between sessions
        // every 500ms — exactly the oscillation v0.2.4 set out to fix, but
        // only the per-panel tick path was gated (line ~1452 of buildIIFE);
        // this event-driven publish path was missed. With the gate the
        // event-driven path and the tick-driven path agree: only the active
        // panel publishes. The `(...)` wrapping preserves the comma-expression
        // form so the trailing `,{type:...}` still binds to the return
        // statement (cannot switch to a block — see the comment at the top
        // of injectFresh re: the minified `else if(...)return a,b,c` shape).
        "(this.panelTab&&this.panelTab.active===true?(globalThis.__ccsdActiveSid=e.request.sessionId):0)," +
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
            // v0.5.35 FIX: the v0.2.5 premise "rename_tab carries sessionId" is FALSE
            // (verified: webview renameTab producer sends {title,hasPendingPermissions,
            // hasUnseenCompletion}, NO sessionId). The unconditional this.__ccsdSid=
            // e.request.sessionId CLEARED the real sid (set undefined) on every rename_tab
            // — at done CC sends rename_tab(hasUnseenCompletion), clearing sid -> §H read
            // undefined -> grey (Heisenbug: CCSD_DEBUG appendFileSync slowed the tick,
            // shifting it past the cleared window -> masked). GUARD: only write if present
            // (no-op for rename_tab). Symmetric intent with replA (line ~2136)
            // (the set sync below already uses it) and can fire BEFORE the first
            // update_session_state — e.g. VS Code restart restoring a persisted
            // panel, or CC reattaching a session tab title before the full
            // session-state handshake completes. Without this stash t.__ccsdSid
            // stays undefined until update_session_state eventually fires, so
            // onDidDispose's `delete globalThis.__ccsdPendingSet[t.__ccsdSid]`
            // degrades to a no-op `delete __ps[undefined]` if the panel is
            // closed in that window → __ccsdPendingSet entry leaks. Idempotent
            // with replA (both write the same value when both fire).
            "if(e.request.sessionId)this.__ccsdSid=e.request.sessionId;" +
            // v0.2.5 (problem 1 fix): mirror the per-panel __ccsdPending flag into
            // a window-scoped globalThis set so the §F 4-light aggregation (which
            // scans STATE_DIR files, not panel objects) can pick up the
            // authoritative hasPendingPermissions signal WITHOUT waiting for the
            // Notification hook → cc-status.js spawn → atomic write → next 500ms
            // reader tick chain. The set is keyed by e.request.sessionId (the
            // same sid the aggregation loop extracts via files[i].slice(0,-5)).
            // try/catch(_): the outer event parameter is `e` — using `catch(e)`
            // here would shadow it for any subsequent reference in this handler.
            // onDidDispose (§Z) deletes the entry on panel close; a CC crash
            // leaving a stale entry is bounded by the same decay chain
            // (running>30min mtime→idle) that governs the file-pending branch.
            // v0.2.5 round-2 (LOW): let (block-scoped) instead of var — var
            // hoists __ps to the rename_tab handler function top, leaking the
            // binding past the try block into the trailing iife + `;let r;…`
            // tail. No bug today (the tail does not reference __ps), but a
            // footgun for any future edit at the end of replB. let keeps the
            // binding local to the try block; behavior inside the try is
            // identical to var.
            "try{let __ps=globalThis.__ccsdPendingSet||(globalThis.__ccsdPendingSet=Object.create(null));if(this.__ccsdSid){if(e.request.hasPendingPermissions){__ps[this.__ccsdSid]=true}else{delete __ps[this.__ccsdSid]}}}catch(_){}" +
            iife +
            ";let r;if(e.request.hasPendingPermissions)";
        next = next.replace(ANCHOR_B, replB);
        if (countOccurrences(next, INJECT_MARKER) < 2) {
            fail("Anchor B replacement did not apply. No files were modified.");
        }
    }

    // Anchor C (optional v0.5.35): wrap requestUserDialog's outgoing
    // sendRequest(user_dialog_request) in try/finally so consent/refusal
    // dialogs (fable_overage_consent_prompt, refusal_fallback_prompt) turn
    // the tab blue while the dialog is open. Mirrors the optional-Anchor-B
    // pattern: cCount===0 is a SOFT warn (install proceeds A+B only,
    // consent-blue INACTIVE, askUserQuestion-blue still active via __ps).
    // cCount===1 wraps the sendRequest call; the original args + .result
    // return are preserved byte-for-byte; try/finally-without-catch is valid
    // JS (assertCompiles below verifies parse). Clearing is the finally
    // itself — every exit path (user response / abort on new user message /
    // channel close / any reject) flows through it. NO processRequest splice
    // is needed: the webview's user_dialog_response reply is routed by the
    // message dispatcher's case "response" keyed on requestId, NOT through
    // processRequest's case chain.
    const cCount = countOccurrences(src, ANCHOR_C);
    if (cCount > 1) {
        fail(`Anchor C (requestUserDialog) matched ${cCount} times, expected 0 or 1. ` + "No files were modified.");
    }
    if (cCount === 0) {
        warn(
            "Anchor C not found — installing with Anchor A+B only. The consent/refusal blue-dot fix will be INACTIVE (consent prompts fall back to CC's native presentation; askUserQuestion-blue still active via Anchor B/__ps).",
        );
    }
    if (cCount === 1) {
        // Wrap the requestUserDialog tail in try/finally. Reads this.__ccsdSid
        // fresh inside the try (NOT the channelId first arg `e`). The finally
        // re-reads this.__ccsdSid (cheap; defensive against any future code
        // path that nulls it mid-flight) and deletes unconditionally — the
        // if(this.__ccsdSid) guard inside the try prevented the set, so a
        // never-set sid yields no-op delete on an unused key. The sendRequest
        // call + args + .result return are preserved byte-for-byte.
        const replC =
            'try{var __csd=this.__ccsdSid;if(__csd){var __ud=globalThis.__ccsdUserDialogSet||(globalThis.__ccsdUserDialogSet=Object.create(null));__ud[__csd]=true}var __ccsdUdRes=await this.sendRequest(e,{type:"user_dialog_request",dialogKind:t.dialogKind,payload:t.payload,toolUseID:t.toolUseID},r);return __ccsdUdRes.result}finally{try{if(__csd&&globalThis.__ccsdUserDialogSet)delete globalThis.__ccsdUserDialogSet[__csd]}catch(_){}}';
        next = next.replace(ANCHOR_C, replC);
        if (!next.includes("__ccsdUserDialogSet")) {
            fail("Anchor C replacement did not apply. No files were modified.");
        }
    }

    assertCompiles(next, "patched extension.js");
    writeAtomicSync(extJs, next);
    log(`patched extension.js (anchors injected: A${bCount === 1 ? "+B" : " only"}${cCount === 1 ? "+C" : ""})`);
}

/** Extract the baked `var RES="..."` path from an already-patched extension.js.
 *  The IIFE bakes `var RES=<JSON.stringify(resDir)>;` once per injection site
 *  (Anchor A, optionally Anchor B → 1 or 2 occurrences, all identical). We read
 *  the first to detect a STALE baked path — e.g. a v0.1 install baked
 *  PROJECT_ROOT/resources; phase1 bakes INSTALL_DIR/resources. Returns null if
 *  the literal cannot be found/parsed (treat as "not stale, leave alone").
 *
 *  The match is anchored on `var DIR="...";var RES=` — the DIR literal always
 *  immediately precedes RES inside OUR IIFE (since v0.4.0 round-2, DIR is baked
 *  as `var DIR=${JSON.stringify(STATE_DIR)};` — an absolute path string literal)
 *  — so a coincidental CC-native `var RES=` elsewhere in the minified bundle
 *  can never be misread. The legacy `cc-tab-status"\);var RES=` anchor (pre-v0.4
 *  IIFE recomputed DIR via `pth.join(os.homedir(),".claude","cc-tab-status")`)
 *  is retained as a fallback so already-patched installs from older versions
 *  still detect + migrate cleanly. */
function bakedResPath(content: string): string | null {
    // v0.4.0+ IIFE shape: `var DIR="<absolute-state-dir>";var RES="<res>";`.
    const mNew = content.match(/var DIR="[^"]+";var RES=("[^"]*");/);
    if (mNew) {
        try {
            return JSON.parse(mNew[1]);
        } catch {
            /* fall through to legacy anchor */
        }
    }
    // Legacy (pre-v0.4) IIFE shape: `var DIR=pth.join(os.homedir(),".claude","cc-tab-status");var RES=...;`
    // — kept so bakedResPath still works on extension.js patched by an older
    // patcher (otherwise a v0.4.0 install running over a v0.3.x-patched CC
    // would fail to detect + refresh the stale baked RES path).
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
    //
    // v0.2.4 form note: replA now includes a `globalThis.__ccsdActiveSid=`
    // assignment between __ccsdTitle and the IIFE banner — the regex below
    // accepts BOTH the legacy (pre-v0.2.4) and the new form by making the
    // globalThis assignment optional via `(?:globalThis\\.__ccsdActiveSid=[^,]*,)?`.
    //
    // v0.2.4 form note: replA's publish is now gated as
    //   `(this.panelTab&&this.panelTab.active===true?(globalThis.__ccsdActiveSid=e.request.sessionId):0),`
    // (business-logic HIGH fix — multi-panel oscillation). The optional
    // middle group is widened from the literal `globalThis.__ccsdActiveSid=
    // e.request.sessionId,` form to `[^,]*,` "any comma-free segment then a
    // comma" — this still anchors on the leading __ccsdTitle= and the
    // following `/*cc-status-dot-injected:…*/` banner, and accepts all
    // historical and future single-segment (no embedded comma) publish
    // expressions. A future replA that embeds a comma in this slot would
    // break stripIifeInPlace — the post-strip INJECT_MARKER-free + compile
    // checks below are the safety net.
    const segA =
        /this\.__ccsdSid=e\.request\.sessionId,this\.__ccsdTitle=e\.request\.title,(?:[^,]*?,)?\/\*cc-status-dot-injected:[^*]*?\*\/\(function\(t\){[\s\S]*?}\)\(this\),/g;
    // Anchor B segment: stash fields + (v0.2.5: optional pending-set sync) +
    // IIFE + trailing semicolon. The leading
    // `this.__ccsdTitle=…;this.__ccsdPending=…` pair is unique to our injection.
    // v0.2.5 widened the form: between the __ccsdPending assignment and the
    // IIFE banner, replB now emits a try{...}catch(_){} block that maintains
    // globalThis.__ccsdPendingSet. The block has no nested IIFE marker and no
    // `})(this)` form, so the same non-greedy match to the first `})(this);`
    // still captures the whole segment. Pre-v0.2.5 strips are accepted via the
    // optional `(?:try\{[\s\S]*?\}catch\(_\)\{\})?` group (matches the v0.2.5
    // try-block OR nothing, never crosses the IIFE banner).
    const segB =
        /this\.__ccsdTitle=e\.request\.title;this\.__ccsdPending=!!e\.request\.hasPendingPermissions;(?:try\{[\s\S]*?\}catch\(_\)\{\})?\/\*cc-status-dot-injected:[^*]*?\*\/\(function\(t\){[\s\S]*?}\)\(this\);/g;

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
    // v0.2.6 round-3 HIGH (integrity): atomic restore. The forward-write path
    // (injectFresh) uses writeAtomicSync + assertCompiles; the reverse path
    // must match. fs.copyFileSync leaves extension.js half-written on partial
    // failure (disk full / SIGKILL / EINTR between copy_file_range chunks),
    // and VSCode loads extension.js verbatim — a half-written extension.js
    // bricks the entire CC extension (commands vanish, new sessions refuse to
    // open). restoreExtension is also the rollback path triggered by wireHooks
    // failure in run() (line ~4496) — a rollback under disk pressure must not
    // take the user from "install failed cleanly" to "CC installation broken".
    atomicCopyFileSync(bak, extJs);
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
            // v0.2.6 round-3 HIGH (integrity): atomic restore (mirrors
            // restoreExtension). A partial restore of webview/index.js bricks
            // every CC webview the user opens.
            atomicCopyFileSync(bak, f);
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
    // v0.2.6 round-3 HIGH (integrity): atomic restore. A partial
    // package.json write bricks CC at module-load (VSCode parses it on every
    // activation).
    atomicCopyFileSync(bak, pkgPath);
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
        // v0.2.6 round-3 MEDIUM (integrity): atomic write. The wrapper is the
        // single point of failure for every CC hook invocation — settings.json
        // bakes a command that execs this wrapper on every hook event. A
        // partial wrapper write (ENOSPC/EINTR/antivirus real-time scan holding
        // the file mid-write on Windows) means every subsequent hook spawn
        // shells a malformed .cmd that fails to exec node, and because
        // cc-status.js's contract is silent-exit(0) on any error, the user
        // sees "status dots stopped updating" with zero diagnostic. Worse: the
        // malformed wrapper is sticky until the next successful install run.
        writeAtomicSync(wrapperAbs, body, "utf8");
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
        // v0.2.6 round-3 MEDIUM (integrity): atomic write (see Windows branch
        // comment above). Then chmod +x on the FINAL path (rename preserves
        // the tmp's mode on POSIX; chmod-ing after rename is simplest and
        // matches hookCommand's `sh <wrapper>` invocation contract).
        writeAtomicSync(wrapperAbs, body, "utf8");
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
// Companion VS Code extension (v0.2.3)
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
 *  v0.2.3 — known-install-path fallback: macOS users who never ran "Shell
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
 *  v0.2.3 — downgrade guard: BEFORE the `--force` we ask the CLI what version
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
        // v0.5.38: fallback — bare CLI install failed (broken shim, e.g. Windows
        // code.cmd resolving Code.exe to a wrong/cwd-relative path; reported on
        // Win10 with a stray code.cmd in the project folder). resolveVscodeCli
        // returned the bare name because `code --version` happened to work, but
        // `--install-extension` exercises the broken Code.exe path. Try the well-
        // known VS Code install path directly (bypasses the broken PATH entry).
        if (cliPath === cliName) {
            const known = resolveKnownVscodeCliPath(cliName);
            if (known) {
                try {
                    const out2 = cp.execSync(`"${known}" --install-extension "${vsixAbs}" --force`, {
                        encoding: "utf8",
                        stdio: ["ignore", "pipe", "pipe"],
                        timeout: 30000,
                    });
                    const last2 = (out2.split(/\r?\n/).filter(Boolean).pop() || "").trim();
                    log(
                        `  ${cliName}: ${last2 || "installed"} (via fallback ${known} — bare CLI "${cliName}" --install-extension was broken)`,
                    );
                    return true;
                } catch (e2) {
                    warn(`  ${cliName}: install-extension failed via bare CLI AND well-known-path fallback ${known}`);
                    return false;
                }
            }
        }
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
 *  SEARCH_DIRS hand-mirrored"): the v0.2.3 companion mirrored INSTALL_DIR /
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
    // v0.2.4 round-2 (ARCH-3): bake the canonical cmpVerStr body into the
    // config so the companion can `new Function('a','b', src)`-cache it at
    // activate() — eliminating the prior byte-for-byte mirror copy that
    // lived in companion/extension.ts through v0.2.4. Extracted from
    // src/semver.ts via the SAME regex shape hooks/test-version-sync.mjs uses
    // (extractFnBody), so the body that ships in the config is byte-identical
    // to the body the CI test asserts against. The src/semver.ts file is the
    // single canonical source; both the patcher's runtime import (above) and
    // the companion's runtime config-read derive from it.
    const semverComparatorSrc = extractCmpVerStrBody();
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
        // ARCH-3: comparator body (see comment above). Optional in the schema
        // — older companions ignore the field; the v0.2.4+ companion requires
        // it for the staleness check (degrades to skip-check when absent).
        semverComparatorSrc,
        writtenAt: Date.now(),
    };
    try {
        fs.mkdirSync(INSTALL_DIR, { recursive: true });
        writeAtomicSync(COMPANION_CONFIG_PATH, JSON.stringify(config, null, 2));
        log(`wrote companion config → ${COMPANION_CONFIG_PATH} (patcherVersion ${PATCHER_VERSION})`);
        if (!semverComparatorSrc) {
            warn(
                `semverComparatorSrc extraction failed — companion will skip the staleness check until next patcher run`,
            );
        }
    } catch (e) {
        warn(
            `failed to write ${COMPANION_CONFIG_PATH} (non-fatal — companion will fall back to its hardcoded constants): ${(e as Error).message ?? String(e)}`,
        );
    }
}

/** Extract the canonical cmpVerStr body from src/semver.ts as a string for
 *  baking into companion-config.json. The body uses only `a`, `b`, and standard
 *  JS builtins — no closure captures — so it's safe to ship to the companion's
 *  `new Function('a','b', src)` constructor. Returns null on extraction
 *  failure (writeCompanionConfig logs a warning in that case).
 *
 *  v0.2.8 round-2 (HIGH integrity): the prior implementation only tried
 *  `src/semver.ts`, which is NOT shipped in the npm tarball (the published
 *  package ships `dist/src/*.js`, not `src/*.ts` — verified via `npm pack
 *  --dry-run`). In production, the prior code returned null → the
 *  companion-config.json's `semverComparatorSrc` field was null for every
 *  production user → the companion's ARCH-3 stale-patcher check silently
 *  degraded to skip. The CI test passed only because it reads the source
 *  tree directly. Fix: try the compiled `dist/src/semver.js` (shipped) at
 *  every level, alongside the TS source (dev tsx). The body is byte-identical
 *  to the TS source because tsc strips only the type annotations
 *  (`a: string, b: string` → `a, b`) without transforming the function body. */
function extractCmpVerStrBody(): string | null {
    // Candidate loaders in priority order. Each entry tries .ts (dev tsx)
    // first, then .js (compiled mode). The TS-first ordering is purely
    // cosmetic — dev mode has the freshest source, so dev prefers it;
    // production has only the compiled .js, so it falls through to it.
    const candidates = [
        path.join(SCRIPT_DIR, "src", "semver.ts"), // dev tsx: <root>/src/semver.ts
        path.join(SCRIPT_DIR, "src", "semver.js"), // compiled: dist/src/semver.js (SHIPPED)
        path.join(SCRIPT_DIR, "..", "src", "semver.ts"), // older dev layout
        path.join(SCRIPT_DIR, "..", "src", "semver.js"), // unusual: <root>/src/semver.js
    ];
    let src = "";
    for (const c of candidates) {
        try {
            src = fs.readFileSync(c, "utf8");
            if (src) break;
        } catch {
            /* try next candidate */
        }
    }
    if (!src) return null;
    // Match `export function cmpVerStr(a: string, b: string): number { ... }`
    // OR `export function cmpVerStr(a, b) { ... }` (compiled JS — tsc strips
    // the type annotations). The body extraction is brace-balanced and works
    // identically on both forms because tsc does not transform the function
    // body. Use the SAME brace-balanced extraction as test-version-sync.mjs:
    // extractFnBody.
    const startIdx = src.indexOf("function cmpVerStr(");
    if (startIdx === -1) return null;
    let i = src.indexOf("{", startIdx);
    if (i === -1) return null;
    let depth = 1;
    i += 1;
    const start = i;
    while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === "{") depth += 1;
        else if (c === "}") depth -= 1;
        i += 1;
    }
    if (depth !== 0) return null;
    return src.slice(start, i - 1);
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

/** Source modules dist/patch.js imports via relative ESM specifiers. The
 *  install path copies each of these into INSTALL_DIR/src/ so the standalone
 *  patch.js can resolve them at module load. Listed here (and re-declared in
 *  reportCompanionStatus + hooks/test-standalone-patch.mjs + test-patcher-io.mjs)
 *  — hooks/test-contract-sync.mjs §SRC_MODULES guards this list against the
 *  actual `from "./src/...js"` imports in patch.ts source (extracts both via
 *  regex, asserts set equality). A future patch.ts that adds a new
 *  `import { foo } from "./src/foo.js"` and forgets to update SRC_MODULES
 *  fails that test directly — closing the silent regression window where
 *  installCompanionRuntimeFiles skips the new module and the companion
 *  crashes with ERR_MODULE_NOT_FOUND on the next --patch-only. */
const SRC_MODULES = ["semver.js", "jsonc.js", "surgical-json.js"];

/** Copy dist/patch.js + dist/src/*.js + companion-config.json into INSTALL_DIR
 *  so the companion can re-exec the patcher without depending on the user's
 *  npx cache. This is the file-copy half of installCompanion — extracted into
 *  its own function in v0.2.8 round-1 so hooks/test-standalone-patch.mjs can
 *  drive the REAL install path (via the `--install-companion-runtime` dev
 *  subcommand) into a sandbox tmp dir (CCSD_INSTALL_DIR=<tmp>) instead of
 *  mirror-copying the files manually. The manual copy in the prior test version
 *  bypassed installCompanion entirely, so the v0.2.7 regression (step 1a
 *  missing — no src/ copy) was INVISIBLE to the test (it passed on v0.2.7
 *  too). Calling this function directly reproduces the bug class.
 *
 *  Idempotent + atomic per file (atomicCopyFileSync uses tmp+rename, so no
 *  half-written patch.js or src/*.js is ever observed even if the process is
 *  killed mid-copy). Stale src/*.js orphans from prior versions are swept
 *  before the fresh copies land — mirrors installRuntimeFiles' SVG sweep. */
function installCompanionRuntimeFiles(): void {
    // 1. Copy dist/patch.js → INSTALL_DIR/patch.js so the companion can re-exec
    //    the patcher without depending on the user's npx cache (which may be
    //    purged). dist/patch.js exists in the published package; in dev
    //    (`tsx patch.ts`) it may be absent — best-effort copy.
    const srcPatchJs = path.join(SCRIPT_DIR, "patch.js");
    const dstPatchJs = path.join(INSTALL_DIR, "patch.js");
    try {
        if (fs.existsSync(srcPatchJs)) {
            fs.mkdirSync(INSTALL_DIR, { recursive: true });
            // v0.2.6 round-3 MEDIUM (integrity): atomic copy. The companion
            // .vsix (companion/extension.ts runPatcher) re-execs `node
            // ${PATCH_JS} --patch-only` on every VS Code startup to detect +
            // heal CC auto-updates. A partial patch.js fails to parse at
            // module load → runPatcher's child exits non-zero → the companion
            // shows "cc-status-dot: auto-patch failed. Run `npx
            // vscode-claude-code-status-dot` manually." on EVERY window
            // startup until the user re-runs npx. This is the auto-healing
            // safety net being bricked by the very install step that's
            // supposed to set it up. atomicCopyFileSync uses tmp+rename so
            // patch.js is never observed half-written.
            atomicCopyFileSync(srcPatchJs, dstPatchJs);
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

    // 1a. Copy dist/src/*.js → INSTALL_DIR/src/ so the runtime patch.js can
    //     resolve its ESM imports (./src/semver.js | jsonc.js | surgical-json.js).
    //     v0.2.4 split patch.ts into src/ three modules and dist/patch.js
    //     imports them via relative ESM specifiers that resolve against
    //     patch.js's own URL. When the companion re-execs
    //     INSTALL_DIR/patch.js --patch-only, Node's ESM loader resolves those
    //     specifiers to INSTALL_DIR/src/*.js BEFORE any code runs — so without
    //     these files the companion auto-heal crashes at module load with
    //     ERR_MODULE_NOT_FOUND (v0.2.8 fix; latent since v0.2.4, exposed when
    //     a CC auto-update overwrote extension.js and triggered companion
    //     re-patch). Mirrors the resources/hooks/token-rates copy discipline
    //     (atomicCopyFileSync — tmp+rename, never observed half-written) and
    //     the SVG stale-sweep pattern from installRuntimeFiles.
    //
    //     Guard discipline matches step 1 above: the OUTER guard is directory
    //     existence, the INNER guard is per-file .js existence. In dev (tsx)
    //     SCRIPT_DIR=project root and src/*.TS exists → enters the if branch,
    //     but every per-file existsSync(src/*.js) is false → 3× warn. That is
    //     the intended dev signal (run `npm run build`). The else branch is
    //     reserved for the genuinely-broken-build case: compiled mode where
    //     SCRIPT_DIR/dist but dist/src/ is entirely absent.
    const srcSrcDir = path.join(SCRIPT_DIR, "src");
    const dstSrcDir = path.join(INSTALL_DIR, "src");
    try {
        if (fs.existsSync(srcSrcDir)) {
            fs.mkdirSync(dstSrcDir, { recursive: true });
            // Sweep stale modules from prior versions (e.g. a future rename/drop
            // that leaves an orphan .js the new patch.js no longer imports).
            // Only touches *.js in dstSrcDir — never other files.
            try {
                for (const name of fs.readdirSync(dstSrcDir)) {
                    if (name.endsWith(".js") && !SRC_MODULES.includes(name)) {
                        try {
                            fs.unlinkSync(path.join(dstSrcDir, name));
                            log(`removed stale src/ module: ${name}`);
                        } catch {
                            /* best-effort — non-fatal */
                        }
                    }
                }
            } catch {
                /* readdir failure — non-fatal, proceed to copy */
            }
            let copied = 0;
            let failed = 0;
            // v0.2.8 round-2 (MEDIUM integrity): per-iteration try/catch so a
            // mid-loop failure (ENOSPC, EACCES on one file) does NOT leave
            // some modules fresh and others absent → companion crashes on next
            // reload with ERR_MODULE_NOT_FOUND pointing at the missing one.
            // Without this guard, atomicCopyFileSync's own atomicity only
            // protects PER-FILE state (no half-written .js) — it does NOT
            // protect PER-LIST state (3 files become 2). Mirrors step 1's
            // outer try/catch discipline (patch.js copy is also isolated
            // from src/*.js copy).
            for (const mod of SRC_MODULES) {
                const s = path.join(srcSrcDir, mod);
                const d = path.join(dstSrcDir, mod);
                if (fs.existsSync(s)) {
                    try {
                        atomicCopyFileSync(s, d);
                        copied += 1;
                    } catch (e) {
                        failed += 1;
                        warn(
                            `failed to copy src/${mod} → ${d} (companion may crash with ERR_MODULE_NOT_FOUND when importing this module): ${(e as Error).message ?? String(e)}`,
                        );
                    }
                } else {
                    warn(`source module missing, not copied: src/${mod}`);
                }
            }
            log(
                `copied src/*.js → ${dstSrcDir} (${copied}/${SRC_MODULES.length} modules${failed > 0 ? `, ${failed} failed` : ""} — companion re-execs patch.js which imports these)`,
            );
        } else {
            // Compiled mode WITHOUT `npm run build`: SCRIPT_DIR is dist/ but
            // dist/src/ is entirely absent — broken build (npm run build did
            // not emit dist/src/) or patch.js was run from an unexpected
            // location. Surface loudly so the user runs `npm run build` before
            // publishing. (Dev tsx mode has SCRIPT_DIR=project root where
            // src/*.ts exists → enters the if branch above → per-file
            // existsSync fails → 3× warn. The else here is NOT the dev case.)
            warn(
                `dist/src/ not found at ${srcSrcDir} — companion will crash with ERR_MODULE_NOT_FOUND on next --patch-only until \`npm run build\` is run`,
            );
        }
    } catch (e) {
        warn(
            `failed to copy src/*.js to INSTALL_DIR (companion may fail to re-patch): ${(e as Error).message ?? String(e)}`,
        );
    }

    // 1b. Write INSTALL_DIR/companion-config.json with the constants the
    //     companion currently hand-mirrors (INSTALL_DIR / INJECT_MARKER /
    //     INJECT_VERSION / SEARCH_DIRS / ccExtIdPrefix / patchJsPath /
    //     patcherVersion). Best-effort — companion falls back to its hardcoded
    //     values if this file is missing or stale. See writeCompanionConfig.
    writeCompanionConfig();
}

/** Install (or refresh) the companion .vsix into every detected VS Code-family
 *  CLI on PATH. Idempotent: re-running refreshes via `--force`. If NO CLI is
 *  detected we warn and continue — the IIFE patch alone still works. Also
 *  copies our compiled patch.js to INSTALL_DIR so the companion has a stable
 *  path to re-exec at VS Code startup (see companion/extension.ts). */
function installCompanion(): void {
    // 1+1a+1b. Copy patch.js + src/*.js + companion-config.json into INSTALL_DIR.
    //    Extracted to installCompanionRuntimeFiles() in v0.2.8 round-1 so the
    //    standalone e2e (hooks/test-standalone-patch.mjs) can drive the real
    //    copy path via `--install-companion-runtime` + CCSD_INSTALL_DIR=<tmp>.
    installCompanionRuntimeFiles();

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
 *  or the CLI may be locked). v0.2.3: uses resolveVscodeCli so the uninstall
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
        // v0.2.3: surface this as a warn (not log) so the user notices the
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
    // v0.2.8: also remove INSTALL_DIR/src/ (the semver/jsonc/surgical-json
    // modules copied by installCompanion step 1a). Symmetric cleanup so
    // --uninstall-companion (and the revert path that calls into it) does
    // not leave orphan module files behind. --revert's removeInstallDir
    // already recursive-rms INSTALL_DIR so this is cosmetic for that path,
    // but --uninstall-companion does NOT touch INSTALL_DIR otherwise.
    const dstSrcDir = path.join(INSTALL_DIR, "src");
    try {
        if (fs.existsSync(dstSrcDir)) {
            fs.rmSync(dstSrcDir, { recursive: true, force: true });
            log(`removed companion src/ copy: ${dstSrcDir}`);
        }
    } catch (e) {
        warn(`could not remove ${dstSrcDir}: ${(e as Error).message ?? String(e)} (remove manually)`);
    }
}

/** Surface companion install health in --status. Reports: vsix presence in the
 *  package, each detected CLI's install state + version (queried via
 *  `code --list-extensions --show-versions`), and the INSTALL_DIR/patch.js copy.
 *  v0.2.3: surfaces installed-vs-packaged version drift per CLI so a user
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
    // v0.2.8: surface INSTALL_DIR/src/ module presence so a user diagnosing
    // "auto-patch failed" can self-check whether the ESM-import dependencies
    // are in place. Missing any of the three modules guarantees
    // ERR_MODULE_NOT_FOUND on the next companion --patch-only.
    const dstSrcDir = path.join(INSTALL_DIR, "src");
    const srcPresent = SRC_MODULES.every((m) => fs.existsSync(path.join(dstSrcDir, m)));
    log(
        `  INSTALL_DIR/src/: ${srcPresent ? `present (${SRC_MODULES.length} modules)` : "(missing — companion will crash with ERR_MODULE_NOT_FOUND on next --patch-only, re-run `npx vscode-claude-code-status-dot`)"}`,
    );
    // v0.2.3: also surface the companion-config.json + last-repatch.json files
    // the patcher writes for the companion to read. A missing config means
    // the companion will fall back to its hardcoded constants (v0.2.3
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
                    // v0.2.8 round-3 MEDIUM (integrity): the LAST non-atomic copy in
                    // installRuntimeFiles. cc-status.js (line ~4109) and token-rates.json
                    // (line ~4194) both moved to atomicCopyFileSync in v0.2.6 round-3, but
                    // this SVG loop was missed — same partial-copy risk under
                    // ENOSPC/EINTR/SIGKILL: libuv uv_fs_copyfile opens dst with
                    // O_CREAT|O_WRONLY|O_TRUNC and copies in chunks, so a mid-copy failure
                    // leaves a truncated claude-logo-*.svg on disk. A partial SVG renders
                    // as broken-emoji in the CC status bar, and the next install's stale
                    // sweep (below) doesn't catch it because the filename still matches
                    // OUR_SVGS. atomicCopyFileSync reads the source as a Buffer and writes
                    // via tmp+rename (POSIX rename is atomic → dst is never observed
                    // half-written), matching the discipline already used for hook/token
                    // files in this same function.
                    atomicCopyFileSync(srcFile, path.join(destRes, svg));
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
                // v0.2.6 round-3 MEDIUM (integrity): atomic copy. A partial
                // cc-status.js truncates the Node script on disk; the next
                // hook fire spawns `node cc-status.js` which either fails to
                // parse (SyntaxError at module load → silent exit(0) per the
                // final catch at line ~2300 → ALL status dots freeze, status
                // files go stale, SBI ticks show stale state forever) or
                // parses but lands a subtle logic bug. The forward install
                // runs on every npx re-run, but a single failed install under
                // disk pressure would leave the hook corrupt until the next
                // successful install. atomicCopyFileSync uses tmp+rename so
                // the destination is never observed half-written.
                atomicCopyFileSync(srcHook, path.join(destHooks, "cc-status.js"));
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
        // v0.2.4: copy token-rates.json (model→USD-per-1M-tokens pricing table)
        // to INSTALL_DIR so the writer hook can read it via loadRates(). Hot-
        // editable: a user adjusting prices only edits this file, no re-patch
        // needed. Best-effort — missing rates just hides the $ suffix (cost=null).
        //
        // v0.2.4 user-edit preservation: previously this copy was unconditional,
        // so any re-patch (manual re-run, CC auto-update via companion, or a
        // version upgrade) silently clobbered user customizations (added GLM
        // rates, tuned Opus prices, etc.). Now we compare source vs destination
        // content: if they differ the user has edited the file, so we back it
        // up to token-rates.json.bak (one slot — we do NOT overwrite an existing
        // .bak, so the FIRST user customization survives across multiple
        // upgrades) and warn before overwriting. Identical content = no edits =
        // no backup needed, plain overwrite.
        try {
            const srcRates = path.join(PROJECT_ROOT, "token-rates.json");
            if (fs.existsSync(srcRates)) {
                const dstRates = path.join(INSTALL_DIR, "token-rates.json");
                if (fs.existsSync(dstRates)) {
                    let userEdited = false;
                    try {
                        const srcBuf = fs.readFileSync(srcRates);
                        const dstBuf = fs.readFileSync(dstRates);
                        userEdited = !srcBuf.equals(dstBuf);
                    } catch {
                        /* compare failed — assume not edited, plain overwrite */
                    }
                    if (userEdited) {
                        const bakRates = dstRates + ".bak";
                        try {
                            if (!fs.existsSync(bakRates)) {
                                // v0.2.6 round-3 MEDIUM (integrity): atomic
                                // copy for the user-edit backup. A partial
                                // .bak here would silently become the permanent
                                // backup (next call sees existsSync(bak)===true
                                // and skips), and a future overwrite would
                                // propagate the partial bytes into the user's
                                // token-rates.json — losing their custom rates.
                                atomicCopyFileSync(dstRates, bakRates);
                                warn(`token-rates.json has user edits — backed up to ${bakRates}`);
                                warn(
                                    `  re-apply your custom rates after this upgrade (or restore the .bak) — cost estimates revert to bundled defaults until then.`,
                                );
                            } else {
                                warn(
                                    `token-rates.json has user edits but a .bak already exists (preserving the older backup).`,
                                );
                                warn(`  your current edits will be overwritten — back them up manually if needed.`);
                            }
                        } catch (e) {
                            warn(
                                `could not back up user token-rates.json (proceeding with overwrite): ${(e as Error).message}`,
                            );
                        }
                    }
                }
                // v0.2.6 round-3 MEDIUM (integrity): atomic copy. A partial
                // token-rates.json leaves loadRates()'s JSON.parse throwing →
                // catch returns {_default: null} → cost suffix silently
                // disappears from every session SBI. Less severe than a partial
                // cc-status.js (no state freeze) but still a silent regression
                // the user would only notice by inspecting the SBI tooltip.
                atomicCopyFileSync(srcRates, dstRates);
            } else {
                warn(
                    "source token-rates.json missing — cost estimation will be disabled (token SBI still works, $ hidden)",
                );
            }
        } catch (e) {
            warn(`failed to copy token-rates.json (non-fatal): ${(e as Error).message}`);
        }
        log(
            `installed runtime files → ${INSTALL_DIR} (${copied}/${OUR_SVGS.length} SVGs + hook + wrapper + token-rates.json)`,
        );
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
function reportExtensionPatchHealth(extSrc: string): void {
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
    reportExtensionPatchHealth(extSrc);
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
    // v0.2.3: cross-platform shortcut hint. Cmd+Shift+P on macOS, Ctrl+Shift+P
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

    // --- cmpVerStr (consolidated canonical comparator; cmpSemver/cmpVer
    // aliases were removed in the v0.2.4 follow-up) ---
    eq("cmpVerStr equal", 0, cmpVerStr("1.2.3", "1.2.3"));
    eq("cmpVerStr a>b (major)", 1, Math.sign(cmpVerStr("2.0.0", "1.9.9")));
    eq("cmpVerStr a<b (patch)", -1, Math.sign(cmpVerStr("1.0.0", "1.0.1")));
    eq("cmpVerStr missing segment treated as 0", 0, cmpVerStr("1.2", "1.2.0"));
    eq("cmpVerStr X.Y vs X.Y.Z", -1, Math.sign(cmpVerStr("1.2", "1.2.1")));
    eq(
        "cmpVerStr number[] join parity ([2,0] vs [1,9,9])",
        1,
        Math.sign(cmpVerStr([2, 0].join("."), [1, 9, 9].join("."))),
    );
    eq("cmpVerStr 0.2.0 vs 0.1.99", 1, Math.sign(cmpVerStr("0.2.0", "0.1.99")));
    eq("cmpVerStr 0.1.18 vs 0.2.0", -1, Math.sign(cmpVerStr("0.1.18", "0.2.0")));

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
        // surgicalSetTopLevelKey / surgicalRemoveTopLevelKey / cmpVerStr)
        // over a fixed fixture corpus and emit a JSON array of
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
    if (args.includes("--install-companion-runtime")) {
        // v0.2.8 round-1 (MEDIUM): dev/test-only entry. Runs ONLY the file-copy
        // half of installCompanion (patch.js + src/*.js + companion-config.json
        // → INSTALL_DIR) — skips the `code --install-extension` step so the test
        // environment is not mutated. Used by hooks/test-standalone-patch.mjs
        // with CCSD_INSTALL_DIR=<tmp> to verify the REAL install path copies
        // src/*.js (the v0.2.7 regression was step 1a missing — the prior test
        // mirror-copied the files itself, bypassing installCompanion, so it
        // passed on v0.2.7 too and the regression was invisible). Calling this
        // subcommand reproduces the bug class directly. Never advertised in
        // --help; intentionally undocumented outside the test + this comment.
        installCompanionRuntimeFiles();
        return;
    }
    if (args.includes("--patch-only")) {
        // v0.2.3: companion-only entry. Runs ONLY discoverExtension +
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
            // v0.2.3: also uninstall the companion .vsix from every detected
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
    // v0.2.3: also install the companion .vsix into every detected VS Code-
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
