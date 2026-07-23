// companion/extension.ts — cc-status-dot companion VS Code extension.
//
// PURPOSE (v0.2.3)
//   The patcher (vscode-claude-code-status-dot on npm) injects an IIFE into the
//   Claude Code extension.js. CC auto-updates frequently (2.1.204 → 2.1.214 →
//   2.1.215 …) and each update REPLACES extension.js with a fresh unpatched
//   copy, silently breaking the status dots until the user notices and re-runs
//   `npx vscode-claude-code-status-dot`.
//
//   This companion extension closes that gap. On VS Code startup it checks
//   whether CC's extension.js still carries our IIFE marker; if not (CC update
//   wiped it), it re-runs the patcher automatically and reloads the window ONCE
//   so the user never has to do it by hand.
//
// SCOPE — INTENTIONALLY MINIMAL
//   This extension does NOT duplicate any IIFE logic. The detect→patch→reload
//   safety net (its original purpose) does exactly three things:
//     1. Detect (grep the CC extension.js for `cc-status-dot-injected`).
//     2. If absent/stale, exec the patcher in --patch-only mode
//        (`node <INSTALL_DIR>/patch.js --patch-only`).
//     3. Reload the window once and show an informational message.
//   The patcher's IIFE remains the only thing that paints status-dot UI.
//
//   v0.4.0 adds the Favorites feature (docs/FAVORITES-DESIGN.md): a CC
//   Favorites view in the Explorer sidebar + commands for adding/removing
//   files and CC sessions, plus navigation back to open sessions. The
//   Favorites surface lives in THIS extension because VSCode requires a
//   package.json `contributes.views.explorer` declaration for a tree view to
//   appear — the IIFE has no package.json to contribute into. The IIFE only
//   publishes the minimal `globalThis.__ccsdSidToPanel` bridge (§A preamble +
//   §Z onDidDispose clear) + registers a `ccStatusDot.fav.focusSession`
//   fallback command; all UI, command handlers, persistence, and tree
//   rendering live here. detectAndPatch() is unchanged and runs first —
//   Favorites initialization is fire-and-forget AFTER detect, so a CC update
//   that needs re-patching is never delayed by Favorites I/O.
//
// ACTIVATION
//   activationEvents: ["onStartupFinished"] (VS Code 1.74+; fires once after
//   startup completes, asynchronously — does not block the EH like onStartup
//   would, and is the documented replacement for the never-standardized
//   "onStartup" token which VS Code silently ignored in early v0.2.3 builds
//   and thereby disabled this entire safety net). The detect step is cheap
//   (one file read + substring search) and self-rate-limits via a per-extDir
//   globalThis Set so the same CC install is checked at most once per window
//   lifetime even under multi-root workspaces. If the user dismisses the
//   auto-patch (declines the reload), we don't fight them — the next window
//   reload re-runs detection.
//
// CROSS-PLATFORM
//   The patch.js re-exec is spawned asynchronously (NOT execFileSync, which
//   blocked the EH for hundreds of ms). We deliberately invoke the EH's own
//   Electron binary (process.execPath) with ELECTRON_RUN_AS_NODE=1 forced into
//   the child env so the Electron wrapper degrades to a plain Node — this is
//   the same trick VS Code uses internally to spawn the EH itself. As a
//   portable fallback we also try plain `node` on PATH.

import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

/** Absolute path to the patcher's runtime install dir. Must match
 *  patch.ts:INSTALL_DIR — single source of truth is the patcher; we mirror it
 *  here because the companion is shipped inside the patcher's .vsix and has no
 *  other way to learn it. If the patcher ever moves INSTALL_DIR, update this
 *  constant in lockstep.
 *
 *  v0.2.3: this constant is now a FALLBACK. The patcher writes its actual
 *  INSTALL_DIR (along with all other constants the companion needs) to
 *  `INSTALL_DIR/companion-config.json` at install time; the companion reads
 *  that file at activate() and prefers its values. The fallback is taken only
 *  when the config is missing (e.g. the companion was installed by an older
 *  patcher that pre-dates the config write — in that case we behave exactly
 *  like v0.2.3). */
const INSTALL_DIR = path.join(os.homedir(), ".claude", "cc-status-dot");

/** The patch.js runtime copy. The patcher's installRuntimeFiles() step copies
 *  its own compiled patch.js here so this extension can re-exec it without
 *  depending on the user's npx cache (which may be purged). */
const PATCH_JS = path.join(INSTALL_DIR, "patch.js");

/** Path of the JSON config the patcher writes at install time. The companion
 *  reads this to decouple from patch.ts internals — see CompanionConfig. */
const CONFIG_PATH = path.join(INSTALL_DIR, "companion-config.json");

/** Path of the JSON "repatch flag" the patcher writes after each successful
 *  --patch-only run. The companion polls this file's `ts` field to detect
 *  cross-window patches (Window 1 patched → Windows 2/3 prompt reload). */
const LAST_REPATCH_PATH = path.join(INSTALL_DIR, "last-repatch.json");

/** Minimum patcher version that produces a companion-config.json with the
 *  schema this companion expects. If the config's `patcherVersion` is OLDER
 *  than this, INSTALL_DIR/patch.js is a stale snapshot (user did
 *  `npm install -g ...@latest` without re-running the bin) — we warn the user
 *  to re-run `npx vscode-claude-code-status-dot` so both patch.js AND config
 *  get refreshed together. Bump this ONLY when the config schema or patch.js
 *  CLI contract changes — not on every patcher release. */
const MIN_PATCHER_VERSION = "0.5.5";

/** Shape of the JSON config written by patch.ts:writeCompanionConfig(). Every
 *  field is optional from the companion's perspective — a missing or partial
 *  config degrades gracefully to the hardcoded fallbacks above. */
interface CompanionConfig {
    patcherVersion?: string;
    installDir?: string;
    patchJsPath?: string;
    injectMarker?: string;
    injectVersion?: string;
    ccExtIdPrefix?: string;
    searchDirs?: string[];
    writtenAt?: number;
    /** v0.2.4 round-2 (ARCH-3): source text of the canonical cmpVerStr body
     *  (the SAME body that lives in src/semver.ts). patch.ts:writeCompanionConfig
     *  extracts the body via regex and writes it here so the companion can
     *  `new Function('a','b', src)`-cache it on globalThis at activate() —
     *  eliminating the prior mirror copy at companion/extension.ts. The
     *  companion compiles standalone into a .vsix so it cannot import
     *  src/semver.ts at runtime; this field is the runtime channel that
     *  keeps the canonical source flowing to the companion without a static
     *  mirror. When absent (older patcher wrote the config), the staleness
     *  check that uses the comparator is silently skipped (degraded mode). */
    semverComparatorSrc?: string;
}

/** Read INSTALL_DIR/companion-config.json. Returns null if missing / corrupt
 *  (the companion falls back to its hardcoded constants in that case — same
 *  behavior as v0.2.3). Logs nothing on failure; the caller decides whether
 *  to surface a warning (we only warn if the patcher version is stale, not if
 *  the file is missing — a missing file is normal for installs done by an
 *  older patcher). */
function readCompanionConfig(): CompanionConfig | null {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf8");
        const parsed = JSON.parse(raw) as CompanionConfig;
        if (typeof parsed === "object" && parsed !== null) return parsed;
    } catch {
        /* missing or corrupt — fall through to null */
    }
    return null;
}

/** Effective config: the loaded CompanionConfig if present, else null. Computed
 *  once at activate() (the file does not change during a window lifetime — it
 *  is written by the patcher at install time, not at companion runtime). */
let effectiveConfig: CompanionConfig | null = null;

/** Marker grepped in CC's extension.js. Falls back to the v0.2.3 hardcoded
 *  value if the config is missing. */
function injectMarker(): string {
    return effectiveConfig?.injectMarker ?? "cc-status-dot-injected";
}

/** Expected IIFE version stamp. Falls back to the v0.2.8 hardcoded value if
 *  the config is missing. Returned (not const) because it depends on the
 *  runtime-loaded config. */
function injectVersion(): string {
    return effectiveConfig?.injectVersion ?? "v0.5.5";
}

/** Effective CC extension id prefix (`anthropic.claude-code`). Used by
 *  discoverCcInThisFlavor's vscode.extensions.all scan. */
function ccExtIdPrefix(): string {
    return effectiveConfig?.ccExtIdPrefix ?? CC_EXT_ID_PREFIX_FALLBACK;
}

/** Effective SEARCH_DIRS for the disk-only fallback scan. Returns the
 *  config's list if present (so new flavors added by a future patcher flow
 *  through without a .vsix rebuild), else the v0.2.3 hardcoded list. */
function searchDirs(): string[] {
    if (Array.isArray(effectiveConfig?.searchDirs) && effectiveConfig!.searchDirs!.length > 0) {
        return effectiveConfig!.searchDirs!;
    }
    return [
        path.join(os.homedir(), ".vscode", "extensions"),
        path.join(os.homedir(), ".vscode-insiders", "extensions"),
        path.join(os.homedir(), ".vscode-server", "extensions"),
        path.join(os.homedir(), ".cursor", "extensions"),
        path.join(os.homedir(), ".vscodium", "extensions"),
    ];
}

/** Global guard key — per-extDir, ensures detect+patch runs at most once per
 *  CC install per extension host lifetime, even if onStartupFinished fires for
 *  multiple roots in a multi-root workspace or the user re-opens a folder
 *  without reloading the window. v0.2.3 changed from a single boolean to a
 *  Set<string> keyed by extDir so a multi-root workspace with CC installed in
 *  multiple flavors can be checked independently per flavor. */
const ALREADY_RAN_KEY = "__ccsdCompanionRanDirs";

/** Set of `${extDir}:${ts}` keys for which we've already prompted the user
 *  about a cross-window repatch. Prevents re-prompting the same window for
 *  the same repatch event on every poll tick. Reset only by EH restart
 *  (i.e. window reload) — matches user expectation that a dismissed prompt
 *  doesn't fire again until reload. */
const PROMPTED_REPATCH_KEY = "__ccsdCompanionPromptedRepatch";

/** Handle to the cross-window repatch poller so deactivate() can clear it. */
let repatchTimer: NodeJS.Timeout | null = null;

/** Handle to the one-shot "Later" re-prompt timer (10 min after the user
 *  dismisses the post-patch reload prompt). Cleared on deactivate. */
let laterRetryTimer: NodeJS.Timeout | null = null;

/** Extension publisher.name prefix that CC's extension id always starts with.
 *  VS Code exposes the extension via vscode.extensions.all regardless of
 *  activation state, so we can find CC's on-disk path WITHOUT scanning SEARCH_DIRS.
 *  This is the same prefix patch.ts uses in its dir-name regex
 *  /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/.
 *
 *  v0.2.3: this is now a fallback default; the effective value is read from
 *  companion-config.json (ccExtIdPrefix accessor). Kept as a const so the
 *  fallback has a stable name (vs an inline string). */
const CC_EXT_ID_PREFIX_FALLBACK = "anthropic.claude-code";

/** Find the Claude Code extension installed in THIS VS Code flavor (the one
 *  whose extension host we're running in), preferring the vscode.extensions
 *  API (which scopes to the current flavor automatically) and falling back to
 *  a SEARCH_DIRS scan if the API can't see CC for any reason.
 *
 *  v0.2.3 fix (architecture review, was HIGH): the pre-fix version scanned ALL
 *  SEARCH_DIRS and picked the highest version globally. With stable + insiders
 *  both having CC, stable's companion would detect insiders' higher CC version,
 *  decide "already patched", and never re-patch stable's own CC — stable users
 *  saw no status dots while companion reported success. Using vscode.extensions
 *  scopes us to THIS flavor's CC install, so each VS Code flavor's companion
 *  heals its OWN CC. Returns null if no CC is visible in this flavor.
 *
 *  Mirrors the patcher's discoverExtension but returns null instead of throwing
 *  on not-found (the patcher's contract is "CC must be installable, throw if
 *  not"; the companion's contract is "if not visible, no-op"). */
function discoverCcInThisFlavor(): string | null {
    const prefix = ccExtIdPrefix();
    const dirs = searchDirs();
    // Primary path — ask VS Code's own extension manager. Extensions listed
    // here all live in THIS flavor's extension dir, so stable's EH never sees
    // insiders' CC installs and vice versa.
    try {
        const cands: { dir: string; version: number[] }[] = [];
        for (const ext of vscode.extensions.all) {
            if (!ext.id.startsWith(prefix)) continue;
            // VS Code's extension.id is `publisher.name` (no version suffix).
            // CC versions itself via the dir name (anthropic.claude-code-X.Y.Z),
            // but the runtime id is publisher.name — so we cannot get the
            // version from ext.id. Parse it out of extensionPath's basename
            // instead, which is the dir name and DOES carry the version.
            const base = path.basename(ext.extensionPath);
            const m = base.match(/(\d+)\.(\d+)\.(\d+)/);
            const version = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
            const extJs = path.join(ext.extensionPath, "extension.js");
            if (!fs.existsSync(extJs)) continue;
            cands.push({ dir: ext.extensionPath, version });
        }
        if (cands.length > 0) {
            cands.sort((a, b) => {
                for (let i = 0; i < 3; i++) {
                    const ai = a.version[i] ?? 0;
                    const bi = b.version[i] ?? 0;
                    if (ai !== bi) return bi - ai;
                }
                return 0;
            });
            return cands[0].dir;
        }
    } catch {
        // fall through to SEARCH_DIRS scan
    }
    // Fallback — disk-only scan across all flavors (preserves old behavior if
    // vscode.extensions.all is somehow empty/unavailable). Picks highest
    // version globally, same as pre-v0.2.3; not ideal for stable+insiders
    // split but better than silently no-oping.
    let best: { dir: string; version: number[] } | null = null;
    for (const base of dirs) {
        let entries: string[];
        try {
            entries = fs.readdirSync(base);
        } catch {
            continue;
        }
        for (const name of entries) {
            const m = name.match(/^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/);
            if (!m) continue;
            const dir = path.join(base, name);
            if (!fs.existsSync(path.join(dir, "extension.js"))) continue;
            const version = [Number(m[1]), Number(m[2]), Number(m[3])];
            if (
                !best ||
                version[0] > best.version[0] ||
                (version[0] === best.version[0] && version[1] > best.version[1]) ||
                (version[0] === best.version[0] && version[1] === best.version[1] && version[2] > best.version[2])
            ) {
                best = { dir, version };
            }
        }
    }
    return best?.dir ?? null;
}

/** v0.2.4 round-2 (ARCH-3): compare two `X.Y.Z` version strings numerically.
 *  Returns >0 if a>b, <0 if a<b, 0 if equal. Used to detect a stale
 *  INSTALL_DIR/patch.js snapshot (config.patcherVersion < MIN_PATCHER_VERSION).
 *
 *  CANONICAL SOURCE: src/semver.ts. The companion compiles standalone into a
 *  .vsix so it cannot import src/semver.ts at runtime. Instead,
 *  patch.ts:writeCompanionConfig extracts the canonical body via regex and
 *  writes it to companion-config.json as `semverComparatorSrc`. The companion
 *  reads that field once at activate() and `new Function('a','b', src)`-caches
 *  it on globalThis.__ccsdCmpVerStr — eliminating the prior byte-for-byte
 *  mirror copy that lived here through v0.2.4.
 *
 *  When `semverComparatorSrc` is absent (older patcher wrote the config before
 *  the field was added), getCmpVerStr() returns null and the staleness check
 *  is skipped (degraded mode — the check is best-effort, not load-bearing; a
 *  stale patch.js is still detected via the IIFE-content-hash mismatch on the
 *  next patcher run).
 *
 *  See hooks/test-version-sync.mjs §Q for the CI assertion that the
 *  config-baked body agrees with src/semver.ts on a fixed test corpus, and
 *  hooks/test-contract-sync.mjs for the cross-file shape pin. */
type CmpVerStr = (a: string, b: string) => number;
const CMP_VER_STR_CACHE_KEY = "__ccsdCmpVerStr";

function getCmpVerStr(): CmpVerStr | null {
    const cached = (globalThis as Record<string, unknown>)[CMP_VER_STR_CACHE_KEY] as CmpVerStr | undefined;
    if (cached) return cached;
    const src = effectiveConfig?.semverComparatorSrc;
    if (typeof src !== "string" || src.trim() === "") return null;
    // v0.2.8 round-2 (MEDIUM version-sync / defense-in-depth): the src text
    // comes from companion-config.json, a user-writable file under
    // INSTALL_DIR (~/.claude/cc-status-dot/). Anyone with write access to
    // that dir already has arbitrary code execution (they could just edit
    // INSTALL_DIR/patch.js directly), so `new Function(src)` does NOT
    // escalate privilege. BUT — defense-in-depth is cheap here, and a future
    // reuse of this pattern in a more sensitive context would inherit the
    // gate. Reject any src that contains tokens outside the canonical
    // cmpVerStr body's safe vocabulary:
    //   - identifiers: a, b, pa, pb, len, i, ai, bi, x, Number, Math
    //   - punctuation: . , ; : ( ) { } [ ] = + - * % ? < > ! | & _
    //   - string literal: "." (one-character string for split separator)
    //   - digits + whitespace
    // Anything else (backticks, $, template literals, function expressions,
    // globalThis/process/require/import, eval, Function constructor) is
    // rejected → staleness check degrades to skip. The canonical body (see
    // src/semver.ts) passes this gate trivially.
    const SAFE_TOKEN_RE = /^[A-Za-z0-9_.,;:()?<>!=|&+\-*/%\s"{}\[\]]+$/;
    if (!SAFE_TOKEN_RE.test(src)) {
        return null;
    }
    // Block-list of dangerous keywords that the conservative char-class above
    // already excludes (kept explicit so a future loosening of the regex is
    // forced to confront each one). The canonical body uses none of these.
    const DANGEROUS =
        /\b(?:function|=>|import|require|process|globalThis|window|eval|Function|fetch|setTimeout|setInterval|setImmediate|this|constructor|prototype|__proto__)\b/;
    if (DANGEROUS.test(src)) {
        return null;
    }
    try {
        // Construct the comparator from the config-baked source. The body
        // uses only `a`, `b`, `.split`, `.map`, `Number`, `Math.max`, `pa[i]
        // ?? 0`, and arithmetic — no closure captures, so the Function
        // constructor is safe (no access to companion scope).
        const fn = new Function("a", "b", src) as CmpVerStr;
        (globalThis as Record<string, unknown>)[CMP_VER_STR_CACHE_KEY] = fn;
        return fn;
    } catch {
        // Malformed source — degrade. A future patcher run refreshes the
        // config with a valid body.
        return null;
    }
}

/** Freshness check for the on-disk CC extension.js.
 *   "fresh"  — marker present AND version stamp matches the effective
 *              INJECT_VERSION (from companion-config.json, falling back to
 *              the hardcoded default baked into injectVersion() if config
 *              is missing).
 *   "stale"  — marker present BUT version stamp differs (older patcher was
 *              used last time; CC hasn't auto-updated since). We re-run patch
 *              so the new INJECT_VERSION's IIFE body lands.
 *   "absent" — marker missing (CC auto-update wiped it, or never patched).
 *  Any I/O error → "absent" (the patcher will fail loudly on its own if CC
 *  truly is broken). The hash axis (intra-version dev iteration) is NOT
 *  checked here — it's an intra-version concern, the patcher's patchExtension
 *  does it authoritatively, and re-spawning patch.js for hash-only drift
 *  would add startup cost for a case that only manifests during dev.
 *
 *  v0.2.3: marker + expected version are taken from accessors (which read
 *  companion-config.json) so a version bump in patch.ts that ships via `npx`
 *  flows through without a .vsix rebuild. */
function ccPatchState(extDir: string): "fresh" | "stale" | "absent" {
    try {
        const extJs = path.join(extDir, "extension.js");
        if (!fs.existsSync(extJs)) return "absent";
        const content = fs.readFileSync(extJs, "utf8");
        const marker = injectMarker();
        const want = injectVersion();
        if (!content.includes(marker)) return "absent";
        // Parse the version stamp from `<marker>:vX.Y.Z[:HASH]*/`.
        // Mirrors patch.ts:injectedVersion regex; tolerate an optional `:HASH`
        // suffix added by the content-hash scheme. The marker is regex-escaped
        // so a future marker containing metacharacters still parses correctly.
        const markerRe = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const m = content.match(new RegExp(`${markerRe}:v(\\d+\\.\\d+\\.\\d+)(?::[0-9a-f]{4,16})?\\*`));
        if (!m) return "stale"; // marker present but pre-v0.1.3 (no version) — treat as stale
        const stamped = "v" + m[1];
        return stamped === want ? "fresh" : "stale";
    } catch {
        return "absent";
    }
}

/** Locate a usable node binary for re-execing patch.js. Resolution order:
 *    1. process.execPath (the extension host's own Electron binary — always
 *       present and known-good; we force ELECTRON_RUN_AS_NODE=1 in the
 *       child env so Electron degrades to a plain Node runner, exactly as VS
 *       Code itself spawns the EH).
 *    2. `node` on PATH (fallback for the rare case execPath is unwritable /
 *       blocked by corporate policy, or for non-EH test harnesses that lack
 *       a real Electron wrapper).
 *  Returns the absolute path or the string "node" as a PATH fallback.
 *
 *  JSDoc correction (v0.2.3 architecture review): the prior comment claimed
 *  process.execPath "is a node binary" — it is NOT, it's an Electron wrapper.
 *  It only behaves as Node when ELECTRON_RUN_AS_NODE=1 is in the env, which
 *  we now set explicitly in runPatcher (no longer relying on EH-internal env
 *  inheritance that VS Code could change at any time). */
function findNodeBin(): string {
    try {
        if (process.execPath && fs.existsSync(process.execPath)) return process.execPath;
    } catch {
        /* ignore — fall through to PATH */
    }
    return "node";
}

/** Spawned-process result returned by runPatcher. `anchorBMissing` is parsed
 *  out of patch.js's stdout so the companion can downgrade its UI from
 *  "patch re-applied" to "patch re-applied WITH WARNINGS" — without this,
 *  an A-only fallback (Anchor B missing → permission-pending blue-dot fix is
 *  inactive) would surface as a normal success message. */
interface PatchResult {
    ok: boolean;
    stdout: string;
    stderr: string;
    /** True if patch.js logged the Anchor-B-not-found warning. Means the
     *  permission-pending blue-dot fix is inactive (yellow running dot may
     *  cover CC's native blue pending dot during a permission prompt). */
    anchorBMissing: boolean;
}

/** Run the patcher asynchronously in --patch-only mode. --patch-only skips
 *  installRuntimeFiles / wireHooks / installNodeWrapper / installCompanion
 *  (the latter would re-spawn N `code --install-extension` calls and freeze
 *  the EH for tens of seconds — see architecture review). The patcher's own
 *  patchExtension is idempotent and will no-op ("already patched — skipping
 *  injection") if the IIFE on disk is already fresh, so this is safe to call
 *  even when ccPatchState returned "fresh" (defensive — shouldn't normally
 *  happen).
 *
 *  Non-blocking: uses cp.spawn + Promise (NOT execFileSync). The EH event
 *  loop stays responsive for other extensions' activations during the
 *  hundred-ms-or-so patch.js run. Stdio is piped (NOT inherited) so we can
 *  parse stdout for the Anchor-B warning — inherited stdio would dump
 *  patch.js's logs into the hidden 'Extension Host' Output channel where
 *  users never see them. */
function runPatcher(): Promise<PatchResult> {
    if (!fs.existsSync(PATCH_JS)) {
        vscode.window.showWarningMessage(
            `cc-status-dot: patcher not found at ${PATCH_JS}. Re-run \`npx vscode-claude-code-status-dot\` to install.`,
        );
        return Promise.resolve({ ok: false, stdout: "", stderr: "", anchorBMissing: false });
    }
    const node = findNodeBin();
    return new Promise((resolve) => {
        // Force ELECTRON_RUN_AS_NODE so process.execPath (an Electron binary
        // inside the EH) behaves as plain Node. VS Code may or may not set
        // this in the EH's own env depending on version/platform; setting it
        // explicitly removes the dependence on undocumented inheritance.
        //
        // Also set CCSD_INVOKED_BY_COMPANION=1 so patch.js's --patch-only mode
        // knows it was triggered by the companion (informational — patch.js
        // stamps `source: "companion"` into last-repatch.json so other windows
        // can see who patched. Future use: patch.js could skip additional
        // work when invoked by the companion if needed).
        const env = {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            CCSD_INVOKED_BY_COMPANION: "1",
        };
        const child = cp.spawn(node, [PATCH_JS, "--patch-only"], {
            stdio: ["ignore", "pipe", "pipe"],
            env,
        });
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        child.stdout.on("data", (d) => stdoutChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
        child.stderr.on("data", (d) => stderrChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
        // 30s ceiling — patch.js normally runs <1s. If it somehow hangs (disk
        // I/O stall, antivirus scan, etc.) we kill it so the EH doesn't wait
        // forever on a fire-and-forget activate() promise.
        const timer = setTimeout(() => {
            try {
                child.kill("SIGTERM");
            } catch {
                /* ignore — child may already be gone */
            }
        }, 30000);
        child.on("error", (e) => {
            clearTimeout(timer);
            resolve({ ok: false, stdout: "", stderr: e.message, anchorBMissing: false });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            const stdout = Buffer.concat(stdoutChunks).toString("utf8");
            const stderr = Buffer.concat(stderrChunks).toString("utf8");
            // Anchor B missing is a warning, not a failure — patch.js still
            // exits 0 with the A-only patch written. Parse stdout so we can
            // surface it to the user instead of reporting a hollow "success".
            const anchorBMissing = /Anchor B not found/i.test(stdout) || /anchors injected: A only/i.test(stdout);
            resolve({ ok: code === 0, stdout, stderr, anchorBMissing });
        });
    });
}

/** Detect → patch → reload, gated by the per-extDir globalThis Set. Designed
 *  to be safe to call from activation on every startup. */
async function detectAndPatch(): Promise<void> {
    const g = globalThis as Record<string, unknown>;
    const ranDirs = (g[ALREADY_RAN_KEY] as Set<string> | undefined) ?? new Set<string>();
    g[ALREADY_RAN_KEY] = ranDirs;

    const extDir = discoverCcInThisFlavor();
    if (!extDir) {
        // No CC install visible from this VS Code flavor — nothing to do.
        // We do NOT cache this in ranDirs: if the user installs CC later in
        // this window's lifetime, the next window reload re-runs detection.
        return;
    }
    if (ranDirs.has(extDir)) return; // already checked this extDir this EH lifetime
    ranDirs.add(extDir);

    const state = ccPatchState(extDir);
    if (state === "fresh") return; // happy path — nothing to do.

    // CC is installed but unpatched (CC update wiped the IIFE) OR stale
    // (older patcher was used; the marker is present but the version stamp
    // doesn't match INJECT_VERSION). Either way, re-run patch.js.
    const result = await runPatcher();
    if (!result.ok) {
        const detail = result.stderr || result.stdout || "(no output)";
        vscode.window.showErrorMessage(
            `cc-status-dot: auto-patch failed. Run \`npx vscode-claude-code-status-dot\` manually.\nDetail: ${detail.slice(-500)}`,
        );
        return;
    }

    // Post-verify (architecture review): patch.js exit 0 does NOT guarantee
    // the marker landed — edge cases include ANCHOR_A drifted while ANCHOR_B
    // also absent (patch.js would still exit 0 with an A-only fallback that
    // we DID see logged, but a future bug or a partial-write could exit 0
    // with no marker at all). Re-check the disk before claiming success.
    const postState = ccPatchState(extDir);
    if (postState === "absent") {
        vscode.window.showErrorMessage(
            `cc-status-dot: auto-patch reported success but the marker is still absent from ${path.basename(
                extDir,
            )}. Run \`npx vscode-claude-code-status-dot\` manually to diagnose.\nDetail: ${result.stdout.slice(-500)}`,
        );
        return;
    }

    // Cross-platform shortcut for the prompt body — matches reloadHint() in
    // patch.ts (Cmd on macOS, Ctrl elsewhere).
    const palette = process.platform === "darwin" ? "Cmd+Shift+P" : "Ctrl+Shift+P";
    const reason = state === "stale" ? "stale patch refreshed" : "Claude Code updated";
    if (result.anchorBMissing) {
        // A-only fallback — warn the user the permission-pending blue-dot fix
        // is inactive instead of claiming a clean success.
        const choice = await vscode.window.showWarningMessage(
            `cc-status-dot: ${reason} — patch re-applied WITH WARNINGS (Anchor B not found → permission-pending blue-dot fix inactive; a yellow running dot may briefly cover CC's native blue pending dot during a permission prompt). Reload window to activate?`,
            "Reload Window",
            "Later",
        );
        if (choice === "Reload Window") {
            await vscode.commands.executeCommand("workbench.action.reloadWindow");
        } else if (choice === "Later") {
            scheduleLaterRetry(extDir);
        }
        return;
    }
    const choice = await vscode.window.showInformationMessage(
        `cc-status-dot: ${reason} — status-dot patch re-applied. Reload window to activate? (or ${palette} → 'Developer: Reload Window')`,
        "Reload Window",
        "Later",
    );
    if (choice === "Reload Window") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
    } else if (choice === "Later") {
        scheduleLaterRetry(extDir);
    }
}

/** Schedule a single 10-minute re-prompt after the user dismisses the post-
 *  patch reload message with "Later". Closes the v0.2.3 half-state gap:
 *  pre-fix, clicking Later left the on-disk extension.js patched but the
 *  window's in-memory CC code still stale, with NO follow-up — the user had
 *  to remember to reload manually. The 10-minute interval is a compromise:
 *  long enough to not nag during active use, short enough to land within a
 *  typical work session. Only one retry fires per EH lifetime (we don't fight
 *  a user who dismisses twice — the JSDoc contract "we don't fight them, the
 *  next window reload re-runs detection" still holds).
 *
 *  The retry checks both the disk state AND the in-memory IIFE globals. If
 *  the user has already reloaded (or another window's patch.js wrote fresh
 *  bytes AND CC has since re-loaded the patched extension in this EH), the
 *  retry is a no-op.
 *
 *  IIFE-loaded probe: the v0.1.17+ IIFE sets `globalThis.__ccsdSbi`
 *  (singular) — the v0.1.16 `__ccsdSbis` (plural array) name was renamed
 *  away and is never written, so we check ONLY the singular form. If a
 *  future patcher renames `__ccsdSbi`, update this probe in lockstep (the
 *  name is part of the patcher↔companion contract). */
function scheduleLaterRetry(extDir: string): void {
    if (laterRetryTimer) return; // already scheduled — don't stack
    laterRetryTimer = setTimeout(() => {
        laterRetryTimer = null;
        // If the IIFE global is now present, CC has re-loaded the patched
        // extension in this EH (user manually reloaded, or some other path
        // activated CC fresh) — no prompt needed.
        const g = globalThis as Record<string, unknown>;
        if (g.__ccsdSbi !== undefined) return;
        // Disk says patched but EH memory doesn't have the IIFE globals → the
        // patch is on disk but inactive in this window. Re-prompt once.
        const state = ccPatchState(extDir);
        if (state !== "fresh") return; // disk regressed? let the next activation handle it
        const palette = process.platform === "darwin" ? "Cmd+Shift+P" : "Ctrl+Shift+P";
        void vscode.window
            .showInformationMessage(
                `cc-status-dot: status-dot patch is on disk but not active in this window yet. Reload to activate? (or ${palette} → 'Developer: Reload Window')`,
                "Reload Window",
                "Dismiss",
            )
            .then((c) => {
                if (c === "Reload Window") {
                    void vscode.commands.executeCommand("workbench.action.reloadWindow");
                }
            });
    }, 10 * 60_000);
    // .unref() so the timer never keeps the EH alive on shutdown.
    if (typeof laterRetryTimer.unref === "function") laterRetryTimer.unref();
}

/** Read `ts` + `extDir` from INSTALL_DIR/last-repatch.json. Returns null if
 *  the file is missing or unparseable (typical for installs done by a
 *  patcher that pre-dates the flag write — same v0.2.3 behavior, no
 *  cross-window signal). */
function readRepatchFlag(): { ts: number; extDir: string } | null {
    try {
        const raw = fs.readFileSync(LAST_REPATCH_PATH, "utf8");
        const parsed = JSON.parse(raw) as { ts?: number; extDir?: string };
        if (typeof parsed.ts === "number" && typeof parsed.extDir === "string") {
            return { ts: parsed.ts, extDir: parsed.extDir };
        }
    } catch {
        /* missing or corrupt */
    }
    return null;
}

/** Start the cross-window repatch poller. Reads the current flag value once
 *  (baseline) and then polls every 30 seconds. When the flag's `ts` advances
 *  AND `extDir` matches our CC install AND we haven't yet loaded the patched
 *  IIFE in this EH, we prompt the user to reload — closing the multi-window
 *  gap (Window 1 patched → Window 2/3 still have stale CC memory and would
 *  never know without this signal).
 *
 *  We poll instead of fs.watch because:
 *   1. fs.watch is unreliable across platforms (Linux inotify, macOS FSEvents,
 *      Windows ReadDirectoryChangesW all have edge cases — missed events,
 *      duplicate events, recursive-watch limitations).
 *   2. the flag file is tiny (one short read per 30s); polling cost is
 *      negligible vs. the complexity of a watcher that works everywhere.
 *  30s matches VS Code's own settings.json reload-after-change delay. */
function startRepatchWatcher(extDir: string): void {
    if (repatchTimer) return; // idempotent — only one watcher per EH lifetime
    const baseline = readRepatchFlag();
    let lastTs = baseline?.ts ?? 0;
    const g = globalThis as Record<string, unknown>;
    const prompted = (g[PROMPTED_REPATCH_KEY] as Set<string> | undefined) ?? new Set<string>();
    g[PROMPTED_REPATCH_KEY] = prompted;

    repatchTimer = setInterval(() => {
        const flag = readRepatchFlag();
        if (!flag || flag.ts <= lastTs) return;
        lastTs = flag.ts;
        // Cross-flavor safety: only react if the flag is about OUR CC install
        // (a stable companion shouldn't prompt when insiders' CC gets patched
        // — different ext dir, different memory).
        if (flag.extDir !== extDir) return;
        // Already-prompted guard for this (extDir, ts) — survives across poll
        // ticks within the same EH lifetime, resets on reload (new EH).
        const key = `${flag.extDir}:${flag.ts}`;
        if (prompted.has(key)) return;
        // If the IIFE global is present, our EH has already loaded the
        // patched CC code — no reload needed (Window might have been the one
        // that did the patch, or CC re-activated post-reload already).
        // See scheduleLaterRetry for the __ccsdSbi-vs-__ccsdSbis rationale
        // (singular only since v0.1.17; plural name was renamed away).
        const mem = globalThis as Record<string, unknown>;
        if (mem.__ccsdSbi !== undefined) return;
        prompted.add(key);
        const palette = process.platform === "darwin" ? "Cmd+Shift+P" : "Ctrl+Shift+P";
        void vscode.window
            .showInformationMessage(
                `cc-status-dot: CC was patched in another window. Reload this window to activate the status-dot patch? (or ${palette} → 'Developer: Reload Window')`,
                "Reload Window",
                "Later",
            )
            .then((c) => {
                if (c === "Reload Window") {
                    void vscode.commands.executeCommand("workbench.action.reloadWindow");
                }
            });
    }, 30_000);
    if (typeof (repatchTimer as NodeJS.Timeout).unref === "function") {
        (repatchTimer as NodeJS.Timeout).unref();
    }
}

// =============================================================================
// v0.4.0 — Favorites (Explorer tree view + commands + favorites.json)
// =============================================================================
// Design contract: docs/FAVORITES-DESIGN.md. The companion owns ALL Favorites
// UI (this file). The IIFE only publishes `globalThis.__ccsdSidToPanel[sid] =
// panel` (so we can reveal an open session) + registers the
// `ccStatusDot.fav.focusSession` fallback command. We never touch the IIFE's
// status-dot / SBI / token surfaces.
//
// Persistence: ~/.claude/cc-tab-status/favorites.json (= IIFE's STATE_DIR,
// patch.ts:219). Companion is the SOLE writer (atomic tmp+rename, mirrors
// patch.ts:1662 writeAtomicSync). Since v0.5.0 the IIFE ALSO reads
// favorites.json (readFavSet, mtime+size cached at patch.ts:1918) to paint
// the -fav gold-line tab icon variant via favOf() (patch.ts:1924); the
// companion remains the sole WRITER, so the IIFE↔favorites coupling is
// read-only on the IIFE side.
//
// CC coupling: the session-toggle handler reads `globalThis.__ccsdActiveSid`
// (already maintained by the IIFE — see scheduleLaterRetry:621 for the
// established globalThis-bridge pattern). The reveal path reads
// `globalThis.__ccsdSidToPanel[sid]` first (primary, same-EH) and falls back
// to `vscode.commands.executeCommand("ccStatusDot.fav.focusSession", sid)`
// (defensive — future-proof if VSCode ever splits EH per extension).

/** Per-session user state directory (mirrors patch.ts:219 STATE_DIR). The
 *  IIFE writes <sid>.json / <sid>.offset / <sid>.tokens.json here; favorites.json
 *  joins them as a sibling. Single source of truth is patch.ts:219 — if the
 *  patcher ever moves STATE_DIR, update this constant in lockstep (and
 *  companion-config.json's schema). */
const FAV_STATE_DIR = path.join(os.homedir(), ".claude", "cc-tab-status");
const FAV_FILE = path.join(FAV_STATE_DIR, "favorites.json");

/** favorites.json schema version. Bump on schema-incompatible changes; the
 *  loader migrates forward (or rejects with a clear error) per version. */
const FAV_SCHEMA_VERSION = 1;

/** setInterval polling interval. fs.watch is unreliable on network drives
 *  and some macOS configs; poll a tiny file every 2s (mirrors the
 *  startRepatchWatcher cadence philosophy). */
const FAV_POLL_MS = 2000;

interface FavSession {
    sid: string;
    label: string;
    cwd?: string;
    transcript_path?: string;
    model?: string;
    state?: string;
    addedAt: number;
    lastSeenAt: number;
}

interface FavFile {
    fsPath: string;
    label: string;
    line?: number;
    workspace?: string;
    addedAt: number;
}

interface FavDoc {
    version: number;
    updatedAt: number;
    sessions: FavSession[];
    files: FavFile[];
}

function emptyFavDoc(): FavDoc {
    return { version: FAV_SCHEMA_VERSION, updatedAt: 0, sessions: [], files: [] };
}

/** v0.4.0 round-2 (MEDIUM future-version guard hardening): latched true the
 *  first time readFavDoc sees an on-disk favorites.json whose schema version
 *  is NEWER than this companion supports. Once latched, writeFavAtomic refuses
 *  all subsequent writes — the round-0 readFavDoc warning 'Showing an empty
 *  list to avoid clobbering newer data' was previously contradicted by every
 *  toggle/remove/open handler unconditionally calling writeFavAtomic, which
 *  would overwrite the newer file with the in-memory v1 downgrade on the very
 *  next user action. The latch survives for the EH lifetime (a window reload
 *  re-reads the file; an upgrade to a companion that supports the newer
 *  schema writes a fresh file the latch never trips on). */
let futureVersionLocked = false;

/** v0.4.0 round-3 (HIGH warning-spam fix): one-shot latch twin of
 *  futureVersionLocked for the CORRUPT-JSON branch of readFavDoc. The polling
 *  cycle is setInterval(refresh, FAV_POLL_MS=2000) → refresh() calls
 *  readFavDoc() BEFORE the signature dedupe, and VSCode separately calls
 *  getChildren() (which also calls readFavDoc) multiple times per tree render
 *  (root query + per-node child probes). Without a latch, a single corrupt
 *  favorites.json would re-fire vscode.window.showWarningMessage every ~2s
 *  for the entire EH lifetime — a steady drip of toasts with no recovery until
 *  window reload. The latch fires the warning at most once per EH lifetime on
 *  the first detection; subsequent reads stay silent and the user can act on
 *  the single toast (fix or delete favorites.json, then reload). Same pattern
 *  as futureVersionLocked below. */
let corruptFavFileWarned = false;

/** Atomic write — tmp + rename. Mirrors patch.ts:1662 writeAtomicSync
 *  discipline (the IIFE's own writer uses the same pattern via writeJsonAtomic
 *  in hooks/cc-status.js). POSIX rename is atomic by spec, so a crash mid-
 *  write at worst leaves an orphan .tmp next to FAV_FILE; favorites.json
 *  itself is never observed half-written.
 *
 *  v0.4.0 round-2 (MEDIUM fs-error UX): wraps all fs operations so a
 *  transient I/O failure (EACCES, ENOSPC, EROFS, cross-device rename) surfaces
 *  as a single user-facing error notification with a recovery hint, instead of
 *  the raw VSCode "command 'ccStatusDot.fav.toggleFile' resulted in an error"
 *  + full stack trace. Returns true on success, false on failure (callers use
 *  the boolean to roll back in-memory state and trigger a refresh() so the
 *  tree matches the on-disk truth). The future-version lock (set by
 *  readFavDoc when the on-disk schema is NEWER than this companion supports)
 *  refuses the write outright — silently downgrading a v2 file by writing v1
 *  bytes would destroy newer data the user's next companion upgrade expects
 *  to find (the round-0 warning text 'Showing an empty list to avoid
 *  clobbering newer data' is now an honest contract). */
function writeFavAtomic(doc: FavDoc): boolean {
    if (futureVersionLocked) {
        void vscode.window.showErrorMessage(
            `cc-status-dot: favorites.json was written by a newer companion. Adding, removing, or opening a favorite would overwrite it with an older schema — refusing. Upgrade the companion (or delete the file at ${FAV_FILE}) to make changes.`,
        );
        return false;
    }
    try {
        try {
            fs.mkdirSync(FAV_STATE_DIR, { recursive: true });
        } catch {
            /* dir already exists or mkdir best-effort; the write below will
             * surface a real error if the path is genuinely unwritable. */
        }
        const tmp = `${FAV_FILE}.${process.pid}.${Date.now()}.tmp`;
        const body = JSON.stringify(doc, null, 2);
        fs.writeFileSync(tmp, body, "utf8");
        try {
            fs.renameSync(tmp, FAV_FILE);
        } catch (e) {
            try {
                fs.unlinkSync(tmp);
            } catch {
                /* best-effort cleanup; orphan is no worse than today */
            }
            throw e;
        }
        return true;
    } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        void vscode.window.showErrorMessage(
            `cc-status-dot: could not save Favorites (${msg}). Check permissions / disk space on ${FAV_STATE_DIR}.`,
        );
        return false;
    }
}

/** Read + validate favorites.json. Returns a normalized FavDoc on success
 *  (defaults applied for missing fields), or null when the file is absent
 *  (first run). A corrupt/unparseable file is logged + treated as empty
 *  (companion never bricks activation on a bad favorites.json — the user can
 *  hand-edit or delete to recover). Schema-version guard: a future version
 *  bump with no migration path rejects to empty + warning. */
function readFavDoc(): FavDoc | null {
    let raw: string;
    try {
        raw = fs.readFileSync(FAV_FILE, "utf8");
    } catch {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        // v0.4.0 round-3 (HIGH warning-spam fix): one-shot latch — refresh()
        // and getChildren() are background pollers that must NEVER pop UI on
        // every read. Without this gate the 2s polling cycle + VSCode's
        // per-render getChildren probes re-fired this warning every ~2s for
        // the entire EH lifetime whenever favorites.json was corrupt.
        if (!corruptFavFileWarned) {
            corruptFavFileWarned = true;
            void vscode.window
                .showWarningMessage(
                    `cc-status-dot: favorites.json is corrupt and could not be parsed (${(e as Error).message}). Showing an empty list. Fix or delete the file at ${FAV_FILE}.`,
                )
                .then(() => undefined);
        }
        return emptyFavDoc();
    }
    if (typeof parsed !== "object" || parsed === null) return emptyFavDoc();
    const obj = parsed as Partial<FavDoc>;
    if (typeof obj.version === "number" && obj.version > FAV_SCHEMA_VERSION) {
        // v0.4.0 round-3 (HIGH warning-spam fix): gate BOTH the latch set and
        // the warning on the false→true transition, so the polling cycle
        // (refresh → readFavDoc every 2s) and VSCode's per-render getChildren
        // probes don't re-fire the toast on every read. writeFavAtomic still
        // sees futureVersionLocked === true for the rest of the EH lifetime
        // (refuses writes) — only the warning is de-duped.
        if (!futureVersionLocked) {
            futureVersionLocked = true;
            void vscode.window
                .showWarningMessage(
                    `cc-status-dot: favorites.json was written by a newer companion (schema v${obj.version}, this companion supports v${FAV_SCHEMA_VERSION}). Showing an empty list to avoid clobbering newer data. Adding/removing/opening favorites is DISABLED until you upgrade the companion or delete the file at ${FAV_FILE}.`,
                )
                .then(() => undefined);
        }
        return emptyFavDoc();
    }
    const sessions = Array.isArray(obj.sessions) ? obj.sessions.filter(isValidFavSession) : [];
    const files = Array.isArray(obj.files) ? obj.files.filter(isValidFavFile) : [];
    return {
        version: FAV_SCHEMA_VERSION,
        updatedAt: typeof obj.updatedAt === "number" ? obj.updatedAt : Date.now(),
        sessions,
        files,
    };
}

function isValidFavSession(x: unknown): x is FavSession {
    if (typeof x !== "object" || x === null) return false;
    const s = x as Partial<FavSession>;
    return (
        typeof s.sid === "string" &&
        s.sid.length > 0 &&
        typeof s.label === "string" &&
        typeof s.addedAt === "number" &&
        typeof s.lastSeenAt === "number" &&
        // v0.4.0 round-1 (LOW): type-check optional fields when present, so a
        // hand-edited or future-schema-downcast favorites.json with e.g.
        // `"state": 42` is rejected here instead of crashing the renderer
        // (`(42).slice is not a function` at line 957).
        (s.cwd === undefined || typeof s.cwd === "string") &&
        (s.transcript_path === undefined || typeof s.transcript_path === "string") &&
        (s.model === undefined || typeof s.model === "string") &&
        (s.state === undefined || typeof s.state === "string")
    );
}

function isValidFavFile(x: unknown): x is FavFile {
    if (typeof x !== "object" || x === null) return false;
    const f = x as Partial<FavFile>;
    return (
        typeof f.fsPath === "string" &&
        f.fsPath.length > 0 &&
        typeof f.label === "string" &&
        typeof f.addedAt === "number" &&
        // v0.4.0 round-1 (LOW): type-check optional fields when present, so
        // `"line": "abc"` / `"workspace": 42` is rejected here instead of
        // crashing path.basename(42) in favBrowse.
        (f.line === undefined || typeof f.line === "number") &&
        (f.workspace === undefined || typeof f.workspace === "string")
    );
}

/** Discriminated tree-node union. contextValue follows the design's
 *  ccsdFav* naming so package.json menu `when` clauses
 *  (`viewItem =~ /^ccsdFav(SessionOpen|File)$/` etc.) route the right
 *  commands to each node kind. */
type FavNode =
    | { kind: "sessionOpen"; session: FavSession }
    | { kind: "sessionClosed"; session: FavSession }
    | { kind: "file"; file: FavFile };

/** Snapshot used to detect open vs closed sessions. Built lazily on each
 *  getChildren call by reading globalThis.__ccsdSidToPanel (published by the
 *  IIFE's §A preamble — see docs/FAVORITES-DESIGN.md §4.2). */
function openSidSet(): Set<string> {
    const g = globalThis as Record<string, unknown>;
    const map = g.__ccsdSidToPanel as Record<string, unknown> | undefined;
    if (!map || typeof map !== "object") return new Set();
    return new Set(Object.keys(map));
}

class FavoritesProvider implements vscode.TreeDataProvider<FavNode> {
    private readonly emitter = new vscode.EventEmitter<FavNode | undefined | null>();
    readonly onDidChangeTreeData = this.emitter.event;

    /** Last-emitted tree signature. refresh() rebuilds a signature from the
     *  current (doc, openSidSet) snapshot and bails out when it matches
     *  lastSig — eliminating needless full-tree invalidates (which would
     *  otherwise fire every 2s and, combined with VSCode's element-reference
     *  identity fallback when TreeItem.id is absent, clear the user's
     *  selection every tick). The signature captures everything the renderer
     *  can react to: session identity + open/closed kind + label + state, and
     *  file identity + label + line. */
    private lastSig = "";

    refresh(): void {
        const doc = readFavDoc() ?? emptyFavDoc();
        const open = openSidSet();
        const sig = JSON.stringify({
            s: doc.sessions.map((s) => `${s.sid}|${open.has(s.sid) ? 1 : 0}|${s.label}|${s.state || ""}`).sort(),
            f: doc.files.map((f) => `${f.fsPath}|${f.label}|${f.line || 0}`).sort(),
        });
        if (sig === this.lastSig) return;
        this.lastSig = sig;
        // v0.4.0 round-3 (MEDIUM setContext spam fix): publish the empty-state
        // setContext HERE (once per real (doc, open) state transition), not in
        // getChildren. VSCode calls getChildren multiple times per single tree
        // render — once for the root when the tree invalidates, plus once per
        // visible node when VSCode probes for children of collapsed-state-
        // inferred elements — so the previous setContext in getChildren
        // dispatched a global command N times per render even when the
        // empty/non-empty boundary hadn't transitioned. Gating here on the
        // signature change reduces setContext dispatches from N-per-render to
        // once-per-real-transition, and keeps the 'what the renderer can react
        // to' invariant (signature + setContext) co-located in one place.
        // `all.length === 0` in the old getChildren site is equivalent to
        // `sessions.length === 0 && files.length === 0` here (both arrays are
        // already validator-filtered inside readFavDoc).
        const isEmpty = doc.sessions.length === 0 && doc.files.length === 0;
        void vscode.commands.executeCommand("setContext", "ccStatusDot.favoritesEmpty", isEmpty).then(
            () => undefined,
            () => undefined,
        );
        // Whole-tree refresh — node identity is unstable across doc edits
        // (add/remove/reorder), so we always fire with undefined. Cheap (the
        // tree is typically <50 nodes).
        this.emitter.fire(undefined);
    }

    getTreeItem(element: FavNode): vscode.TreeItem {
        if (element.kind === "file") {
            const f = element.file;
            const item = new vscode.TreeItem(vscode.Uri.file(f.fsPath), vscode.TreeItemCollapsibleState.None);
            // v0.4.0 round-1 (MEDIUM): stable id lets VSCode preserve selection
            // across refreshes even when the FavNode object reference changes
            // (getChildren rebuilds the array on every invalidate). Without an
            // explicit id, VSCode falls back to element-reference identity for
            // non-Uri-keyed nodes — which a setInterval-driven refresh would
            // clear every 2s. The ccsdFav: prefix namespaces us away from any
            // future tree contributor. File nodes already get a stable id from
            // Uri.file(fsPath), but setting it explicitly is belt-and-braces
            // and keeps the renderer symmetric across node kinds.
            item.id = "ccsdFav:file:" + f.fsPath;
            item.label = f.label || path.basename(f.fsPath);
            item.contextValue = "ccsdFavFile";
            item.iconPath = vscode.ThemeIcon.File;
            const linePart = f.line ? `:${f.line}` : "";
            item.tooltip = `${f.fsPath}${linePart}\nAdded ${new Date(f.addedAt).toLocaleString()}`;
            item.description = path.basename(f.fsPath) === f.label ? undefined : path.basename(f.fsPath);
            item.command = {
                command: "ccStatusDot.fav.open",
                title: "Open Favorite",
                arguments: [element],
            };
            return item;
        }
        // session (open or closed)
        const s = element.session;
        const isOpen = element.kind === "sessionOpen";
        const item = new vscode.TreeItem(s.label, vscode.TreeItemCollapsibleState.None);
        // v0.4.0 round-1 (MEDIUM): session nodes have NO resourceUri, so VSCode
        // cannot fall back to Uri identity — without an explicit id it uses
        // element-reference identity, which changes on every refresh, clearing
        // the user's selection every 2s. Pin the id to the sid (stable across
        // refreshes; the sid is the per-session primary key). The kind suffix
        // (open/closed) is intentionally NOT in the id — when a session
        // transitions between open/closed, keeping the id stable lets VSCode
        // preserve selection across the icon/label refresh.
        item.id = "ccsdFav:session:" + s.sid;
        item.contextValue = isOpen ? "ccsdFavSessionOpen" : "ccsdFavSessionClosed";
        // v0.5.3 (F3): closed-session icon — use "comment" (single quiet chat
        // bubble, same codicon family as the open-session "comment-discussion")
        // instead of "circle-slash" which renders as a prohibition/error glyph
        // (🚫) and misleads users into thinking the session errored. "comment"
        // reads as "inactive conversation" — visually coherent with the open
        // variant. Long-stable codicon; no fallback risk.
        item.iconPath = isOpen ? new vscode.ThemeIcon("comment-discussion") : new vscode.ThemeIcon("comment");
        item.description = isOpen
            ? `${String(s.state || "open").slice(0, 12)}`
            : `(closed)${s.state ? " " + String(s.state).slice(0, 8) : ""}`;
        const tip = [
            `sid: ${s.sid.slice(0, 8)}…`,
            s.cwd ? `cwd: ${s.cwd}` : "",
            s.model ? `model: ${s.model}` : "",
            `state: ${s.state || "(unknown)"}`,
            `added: ${new Date(s.addedAt).toLocaleString()}`,
            isOpen ? "click to focus panel" : "closed — right-click for resume cmd",
        ]
            .filter(Boolean)
            .join("\n");
        item.tooltip = tip;
        if (isOpen) {
            item.command = {
                command: "ccStatusDot.fav.open",
                title: "Focus CC Session",
                arguments: [element],
            };
        }
        return item;
    }

    getChildren(element?: FavNode): FavNode[] {
        // Root-level: surface sessions first (most useful) then files. Children
        // of a node are not used (collapsibleState=None for every node), so
        // the element param is only defined when VSCode probes for children
        // of a node — return [] in that case (no nesting in v0.4).
        if (element) return [];
        const doc = readFavDoc() ?? emptyFavDoc();
        const open = openSidSet();
        const sessions: FavNode[] = doc.sessions
            .slice()
            .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
            .map((s) =>
                open.has(s.sid) ? { kind: "sessionOpen", session: s } : { kind: "sessionClosed", session: s },
            );
        const files: FavNode[] = doc.files
            .slice()
            .sort((a, b) => b.addedAt - a.addedAt)
            .map((f) => ({ kind: "file", file: f }));
        const all = [...sessions, ...files];
        // v0.4.0 round-3 (MEDIUM setContext spam fix): the empty-state
        // setContext used to live here, but VSCode calls getChildren multiple
        // times per tree render (root query + per-node child probes), so it
        // dispatched a global command N times per render. The setContext now
        // lives in refresh() where it fires once per real (doc, open) state
        // transition (signature change). registerFavorites also calls refresh()
        // once synchronously after createTreeView so the initial empty/non-
        // empty state is published BEFORE VSCode's first getChildren probe —
        // viewsWelcome fires correctly on first reveal without waiting for the
        // first 2s polling tick.
        return all;
    }
}

/** Singleton provider — created once in activate(), referenced by handlers. */
let favoritesProvider: FavoritesProvider | null = null;
/** fs.watchFile-style polling handle (actually setInterval — see comment at
 *  the registration site for why fs.watchFile alone is insufficient). Cleared
 *  in deactivate(). */
let favoritesWatcher: NodeJS.Timeout | null = null;

/** Toggle a file in/out of favorites. Adds with label=basename + optional
 *  line cursor; removes if already present (same fsPath). Idempotent. */
function favToggleFile(uri?: vscode.Uri): void {
    if (!uri) {
        // Command palette invocation — use the active editor's URI.
        const ed = vscode.window.activeTextEditor;
        if (!ed) {
            void vscode.window.showInformationMessage(
                "cc-status-dot: open a file first, or right-click one in Explorer to favorite it.",
            );
            return;
        }
        uri = ed.document.uri;
    }
    if (uri.scheme !== "file") {
        void vscode.window.showInformationMessage(
            `cc-status-dot: only local files can be favorited (got scheme '${uri.scheme}').`,
        );
        return;
    }
    const doc = readFavDoc() ?? emptyFavDoc();
    const fsPath = uri.fsPath;
    const idx = doc.files.findIndex((f) => f.fsPath === fsPath);
    const editor = vscode.window.activeTextEditor;
    const line = editor && editor.document.uri.fsPath === fsPath ? editor.selection.active.line + 1 : undefined;
    if (idx >= 0) {
        doc.files.splice(idx, 1);
        const wrote = writeFavAtomic({ ...doc, updatedAt: Date.now() });
        if (wrote) {
            void vscode.window.setStatusBarMessage(`Removed ${path.basename(fsPath)} from Favorites`, 3000);
        }
    } else {
        doc.files.push({
            fsPath,
            label: path.basename(fsPath),
            line,
            workspace: vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath,
            addedAt: Date.now(),
        });
        const wrote = writeFavAtomic({ ...doc, updatedAt: Date.now() });
        if (wrote) {
            void vscode.window.setStatusBarMessage(`Added ${path.basename(fsPath)} to Favorites`, 3000);
        }
    }
    // Always refresh — on write success the tree picks up the new order; on
    // failure (or future-version lock) the refresh re-reads the disk truth
    // and rolls back the in-memory splice/push we just did.
    favoritesProvider?.refresh();
}

/** Derive a short, human-readable label for a favorite from the session's
 *  transcript jsonl (the first real user prompt). v0.5.3 (F2 HIGH): the
 *  pre-fix toggle fell back to `cwd basename` then `sid.slice(0,8)` (an
 *  opaque UUID prefix), so the Favorites tree showed meaningless labels.
 *  Reading the first user prompt mirrors how the user identifies the session
 *  themselves ("the chat where I asked about X").
 *
 *  Bounded + defensive: reads only the first ~256KB (the first user turn is
 *  near the top), swallows all fs/JSON errors (returns null → caller falls
 *  back to cwd/UUID), and skips tool_result user-messages (which carry
 *  `tool_use_id` and opaque payload, not a prompt). Returns null for an empty
 *  / whitespace-only / control-char-only result so the caller's cwd/UUID
 *  fallback still applies. */
function deriveLabelFromTranscript(transcriptPath: string): string | null {
    if (!transcriptPath) return null;
    let raw: string;
    try {
        // Bounded read — the first user prompt is overwhelmingly in the first
        // few KB. 256KB is a generous ceiling that still bounds I/O on huge
        // transcripts (long sessions grow to many MB).
        const fd = fs.openSync(transcriptPath, "r");
        try {
            const sz = Math.min(256 * 1024, fs.fstatSync(fd).size);
            if (sz <= 0) return null;
            const buf = Buffer.alloc(sz);
            const br = fs.readSync(fd, buf, 0, sz, 0);
            raw = buf.toString("utf8", 0, br);
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return null;
    }
    if (!raw) return null;
    const lines = raw.split("\n");
    for (const ln of lines) {
        const trim = ln.trim();
        if (!trim) continue;
        let obj: unknown;
        try {
            obj = JSON.parse(trim);
        } catch {
            continue;
        }
        if (!obj || typeof obj !== "object") continue;
        const o = obj as Record<string, unknown>;
        if (o.type !== "user") continue;
        const msg = o.message as Record<string, unknown> | undefined;
        if (!msg || typeof msg !== "object") continue;
        const content = msg.content;
        // User text prompt: content is a bare string, OR an array containing a
        // {type:"text", text:"…"} block. SKIP tool_result arrays (those are CC
        // feeding tool output back, not a user prompt) — detected via a
        // tool_use_id-bearing or type:"tool_result" block.
        let text: string | null = null;
        if (typeof content === "string") {
            text = content;
        } else if (Array.isArray(content)) {
            // If ANY block is a tool_result, this user turn is a tool reply,
            // not a prompt — skip to the next user line.
            const isToolReply = content.some(
                (b) =>
                    b &&
                    typeof b === "object" &&
                    ((b as Record<string, unknown>).type === "tool_result" ||
                        typeof (b as Record<string, unknown>).tool_use_id === "string"),
            );
            if (isToolReply) continue;
            const textBlock = content.find(
                (b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "text",
            ) as Record<string, unknown> | undefined;
            if (textBlock && typeof textBlock.text === "string") text = textBlock.text;
        }
        if (!text) continue;
        // Collapse whitespace + strip control chars; truncate to a tree-friendly
        // width. 64 chars fits the Favorites row without ellipsis-flip on most
        // sidebars; longer labels add noise, not signal.
        const cleaned = text
            .replace(/[\x00-\x1f\x7f]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        if (!cleaned) continue;
        return cleaned.length > 64 ? cleaned.slice(0, 63) + "…" : cleaned;
    }
    return null;
}

/** Toggle a CC session in/out of favorites. v0.5.3 (F1 HIGH): accepts the
 *  resourceUri that VSCode's editor/title/context menu auto-passes (was
 *  dropped on the floor pre-fix, and the handler welded the right-clicked
 *  background tab to __ccsdActiveSid — the ACTIVE tab — so right-clicking a
 *  non-active CC tab collected/removed the wrong session). Resolution order:
 *    1. best-effort: match vscode.window.tabGroups.activeTab.label against the
 *       IIFE's globalThis.__ccsdSidToTitle bridge — if VSCode activated the
 *       right-clicked tab (platform-dependent) this nails the exact sid.
 *    2. fallback: globalThis.__ccsdActiveSid / __ccsdLastActiveSid (unchanged).
 *  The resourceUri itself is not decodable for a CC webview tab (synthetic
 *  URI, no sid), so it's accepted for API correctness + forward-compat only.
 *
 *  v0.5.3 (F2 HIGH): label now prefers (a) the live title from the bridge,
 *  then (b) the transcript's first user prompt (deriveLabelFromTranscript),
 *  then (c) cwd basename, then (d) sid.slice(0,8). Pre-fix only (c)/(d) ran,
 *  so labels showed opaque UUIDs / dir names. */
function favToggleTab(resourceUri?: unknown): void {
    void resourceUri; // accepted for menu contract; CC webview URIs carry no sid
    const g = globalThis as Record<string, unknown>;
    // F1: best-effort — resolve the sid behind the right-clicked tab via the
    // title bridge + the active tab's label. VSCode's editor/title/context
    // fires after the right-clicked tab becomes tabGroups.activeTab on some
    // platforms; when it does, matching the label against __ccsdSidToTitle
    // recovers the EXACT sid (vs the welded active-sid fallback). All wrapped
    // in try/catch — vscode.window.tabGroups is EH-only and must never crash
    // the toggle.
    // v0.5.3 (F6): this handler is now ALSO bound to explorer/context (gated
    // by resourceScheme != 'file') to cover CC webview tabs in the Open Editors
    // view. The resourceUri from explorer/context is equally undecodable, so
    // the same active-sid + title-bridge fallback applies unchanged.
    let sid =
        (typeof g.__ccsdActiveSid === "string" && g.__ccsdActiveSid) ||
        (typeof g.__ccsdLastActiveSid === "string" && g.__ccsdLastActiveSid) ||
        "";
    try {
        const titleMap = g.__ccsdSidToTitle;
        if (titleMap && typeof titleMap === "object") {
            const map = titleMap as Record<string, string>;
            const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
            const activeLabel = activeTab && typeof activeTab.label === "string" ? activeTab.label : "";
            if (activeLabel) {
                // Find a known CC sid whose bridge title matches the active tab
                // label. Exact match only — a substring match would false-hit
                // when one session title contains another.
                const matched = Object.keys(map).find((k) => map[k] === activeLabel);
                if (matched) sid = matched;
            }
        }
    } catch {
        /* tabGroups unavailable (defensive) — keep the active-sid fallback */
    }
    if (!sid) {
        void vscode.window.showInformationMessage(
            "cc-status-dot: no active Claude Code session. Open a CC tab first, then re-run this command.",
        );
        return;
    }
    const doc = readFavDoc() ?? emptyFavDoc();
    const idx = doc.sessions.findIndex((s) => s.sid === sid);
    if (idx >= 0) {
        const removed = doc.sessions.splice(idx, 1)[0];
        const wrote = writeFavAtomic({ ...doc, updatedAt: Date.now() });
        if (wrote) {
            void vscode.window.setStatusBarMessage(`Removed session ${removed.sid.slice(0, 8)} from Favorites`, 3000);
        }
        favoritesProvider?.refresh();
        return;
    }
    // Snapshot from <sid>.json if available — companion already reads
    // STATE_DIR for the repatch watcher, and the schema is identical to what
    // the IIFE consumes (cwd/transcript_path/model/state). Falls back to
    // sid-derived defaults when the file is missing (rare — only when CC's
    // SessionEnd ran between the sid going active and this toggle).
    let label = sid.slice(0, 8);
    let cwd: string | undefined;
    let transcript_path: string | undefined;
    let model: string | undefined;
    let state: string | undefined;
    try {
        const raw = fs.readFileSync(path.join(FAV_STATE_DIR, `${sid}.json`), "utf8");
        const j = JSON.parse(raw) as Record<string, unknown>;
        if (typeof j.cwd === "string") cwd = j.cwd;
        if (typeof j.transcript_path === "string") transcript_path = j.transcript_path;
        if (typeof j.model === "string") model = j.model;
        else if (
            j.tokens &&
            typeof j.tokens === "object" &&
            typeof (j.tokens as Record<string, unknown>).last_model === "string"
        )
            model = ((j.tokens as Record<string, unknown>).last_model as string).trim();
        if (typeof j.state === "string") state = j.state;
    } catch {
        /* file missing/corrupt — proceed with sid-derived defaults */
    }
    // v0.5.3 (F2): label precedence — bridge title (live), then transcript's
    // first user prompt, then cwd basename, then UUID prefix. Each tier is
    // best-effort; the first non-empty wins so a favorite NEVER shows an opaque
    // UUID when a human-readable name is reachable.
    try {
        const titleMap = g.__ccsdSidToTitle as Record<string, string> | undefined;
        const bridgeTitle = titleMap && typeof titleMap === "object" ? titleMap[sid] : "";
        if (typeof bridgeTitle === "string" && bridgeTitle.trim()) {
            const t = bridgeTitle.trim();
            label = t.length > 64 ? t.slice(0, 63) + "…" : t;
        }
    } catch {
        /* bridge unreadable — fall through to transcript */
    }
    if (label === sid.slice(0, 8)) {
        const fromTranscript = transcript_path ? deriveLabelFromTranscript(transcript_path) : null;
        if (fromTranscript) label = fromTranscript;
        else if (cwd) label = path.basename(cwd) || label;
    }
    const now = Date.now();
    doc.sessions.push({
        sid,
        label,
        cwd,
        transcript_path,
        model,
        state,
        addedAt: now,
        lastSeenAt: now,
    });
    const wrote = writeFavAtomic({ ...doc, updatedAt: now });
    if (wrote) {
        void vscode.window.setStatusBarMessage(`Added session ${sid.slice(0, 8)} to Favorites`, 3000);
    }
    favoritesProvider?.refresh();
}

/** Open a favorite. Files: showTextDocument (with line cursor if set).
 *  Open sessions: reveal the live CC webview panel via the IIFE's
 *  globalThis.__ccsdSidToPanel bridge, falling back to the
 *  ccStatusDot.fav.focusSession command the IIFE registers. Closed
 *  sessions: degrade with a one-off status-bar message + offer the copy-
 *  resume command via the tree's right-click menu. */
async function favOpen(node: FavNode): Promise<void> {
    if (node.kind === "file") {
        const f = node.file;
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f.fsPath));
            const range =
                typeof f.line === "number" && f.line > 0
                    ? new vscode.Range(Math.max(0, f.line - 1), 0, Math.max(0, f.line - 1), 0)
                    : undefined;
            await vscode.window.showTextDocument(doc, { selection: range });
        } catch (e) {
            void vscode.window.showErrorMessage(`cc-status-dot: could not open ${f.fsPath} (${(e as Error).message}).`);
        }
        return;
    }
    if (node.kind === "sessionClosed") {
        void vscode.window.setStatusBarMessage(
            `Session ${node.session.sid.slice(0, 8)} is not open in this window. Right-click → Copy 'claude -r <sid>' to resume in a terminal.`,
            6000,
        );
        return;
    }
    // sessionOpen — reveal the panel.
    const sid = node.session.sid;
    const g = globalThis as Record<string, unknown>;
    const map = g.__ccsdSidToPanel as { reveal?: () => void; [k: string]: unknown } | undefined;
    const panel = map && (map[sid] as { reveal?: () => void } | undefined);
    if (panel && typeof panel.reveal === "function") {
        try {
            panel.reveal();
            // Update lastSeenAt on successful focus (companion is the sole
            // writer — no race with the IIFE). writeFavAtomic returning false
            // (future-version lock or fs error) is silent here — the panel
            // already focused; failing to persist lastSeenAt just means the
            // session may not float to the top of the list until the next
            // successful toggle. We do NOT show an error toast on this path
            // (it would interrupt a successful reveal) — the next toggle's
            // writeFavAtomic surfaces the same error if it persists.
            const doc = readFavDoc();
            if (doc) {
                const s = doc.sessions.find((x) => x.sid === sid);
                if (s) {
                    s.lastSeenAt = Date.now();
                    writeFavAtomic({ ...doc, updatedAt: Date.now() });
                }
            }
            return;
        } catch {
            /* fall through to command path */
        }
    }
    // Fallback: command bridge (works across EH boundary if VSCode ever
    // splits; the IIFE's handler returns true/false).
    try {
        const ok = (await vscode.commands.executeCommand("ccStatusDot.fav.focusSession", sid)) as boolean | undefined;
        if (ok === true) return;
    } catch {
        /* command not registered yet — IIFE hasn't run; fall through */
    }
    void vscode.window.setStatusBarMessage(
        `cc-status-dot: session ${sid.slice(0, 8)} panel not available (CC patch may still be loading). Try again in a moment.`,
        6000,
    );
}

function favRemove(node: FavNode): void {
    const doc = readFavDoc();
    if (!doc) return;
    if (node.kind === "file") {
        const before = doc.files.length;
        doc.files = doc.files.filter((f) => f.fsPath !== node.file.fsPath);
        if (doc.files.length === before) return;
    } else {
        const before = doc.sessions.length;
        doc.sessions = doc.sessions.filter((s) => s.sid !== node.session.sid);
        if (doc.sessions.length === before) return;
    }
    // writeFavAtomic reports its own error toast on failure; on success or
    // failure we still refresh() so the tree reflects the on-disk truth
    // (failure rolls back the in-memory filter; success picks up the new
    // ordering).
    writeFavAtomic({ ...doc, updatedAt: Date.now() });
    favoritesProvider?.refresh();
}

function favCopyResume(node: FavNode): void {
    if (node.kind === "file") return;
    const sid = node.session.sid;
    const cmd = `claude -r ${sid}`;
    // v0.4.0 round-2 (MEDIUM floating-promise fix): prefix `void` to match
    // the file's prevailing discipline (8 prior `void` sites). The un-prefixed
    // `.then` floated a promise whose then-rejection would surface as an
    // unhandled rejection if VSCode's clipboard IPC threw inside the then
    // callback (rare — VSCode mid-teardown). Best-effort try/catch around
    // writeText is belt-and-braces against a synchronous throw on the same
    // rare path.
    try {
        void vscode.env.clipboard.writeText(cmd).then(
            () => {
                void vscode.window.setStatusBarMessage(`Copied: ${cmd}`, 4000);
            },
            () => {
                void vscode.window.showErrorMessage(`cc-status-dot: clipboard write failed. Command was: ${cmd}`);
            },
        );
    } catch (e) {
        void vscode.window.showErrorMessage(
            `cc-status-dot: clipboard write failed (${(e as Error)?.message ?? String(e)}). Command was: ${cmd}`,
        );
    }
}

/** Refresh the tree. Used by the view/title toolbar button + the
 *  ccStatusDot.fav.refresh command. */
function favRefresh(): void {
    favoritesProvider?.refresh();
}

/** Browse — open the QuickPick with all favorites for keyboard navigation.
 *  Mirrors showTokQuickPick's UX (the IIFE's existing QuickPick pattern). */
async function favBrowse(): Promise<void> {
    const doc = readFavDoc() ?? emptyFavDoc();
    const open = openSidSet();
    type Item = vscode.QuickPickItem & { node?: FavNode };
    const items: Item[] = [];
    if (doc.sessions.length > 0) {
        items.push({ label: "sessions", kind: vscode.QuickPickItemKind.Separator });
        for (const s of doc.sessions) {
            const isOpen = open.has(s.sid);
            items.push({
                label: (isOpen ? "$(comment-discussion) " : "$(comment) ") + s.label,
                description: s.sid.slice(0, 8),
                detail: isOpen ? `state: ${s.state || "?"} — click to focus` : `closed — click for resume hint`,
                node: { kind: isOpen ? "sessionOpen" : "sessionClosed", session: s },
            });
        }
    }
    if (doc.files.length > 0) {
        items.push({ label: "files", kind: vscode.QuickPickItemKind.Separator });
        for (const f of doc.files) {
            items.push({
                label: "$(file) " + f.label,
                description: f.workspace ? path.basename(String(f.workspace)) : "",
                detail: f.fsPath + (f.line ? `:${f.line}` : ""),
                node: { kind: "file", file: f },
            });
        }
    }
    if (items.length === 0) {
        void vscode.window.showInformationMessage(
            "cc-status-dot Favorites: nothing to browse. Right-click a file in Explorer or run 'CC Favorites: Star/Unstar Current CC Tab' to add.",
        );
        return;
    }
    const picked = (await vscode.window.showQuickPick(items, {
        placeHolder: "Open a favorite",
    })) as Item | undefined;
    if (picked && picked.node) {
        await favOpen(picked.node);
    }
}

/** Register all Favorites contributions. Called from activate() AFTER
 *  detectAndPatch's fire-and-forget is set up. detectAndPatch is never
 *  blocked by Favorites I/O. The view auto-activates on first reveal — the
 *  user does not need a CC tab open to favorite files. */
function registerFavorites(ctx: vscode.ExtensionContext): void {
    favoritesProvider = new FavoritesProvider();
    const tree = vscode.window.createTreeView("ccStatusDot.favorites", {
        treeDataProvider: favoritesProvider,
        showCollapseAll: false,
        canSelectMany: false,
    });
    ctx.subscriptions.push(tree);

    ctx.subscriptions.push(
        vscode.commands.registerCommand("ccStatusDot.fav.toggleFile", favToggleFile),
        vscode.commands.registerCommand("ccStatusDot.fav.toggleTab", favToggleTab),
        vscode.commands.registerCommand("ccStatusDot.fav.open", (node?: FavNode) => {
            if (!node) return;
            void favOpen(node);
        }),
        vscode.commands.registerCommand("ccStatusDot.fav.remove", (node?: FavNode) => {
            if (!node) return;
            favRemove(node);
        }),
        vscode.commands.registerCommand("ccStatusDot.fav.copyResume", (node?: FavNode) => {
            if (!node) return;
            favCopyResume(node);
        }),
        vscode.commands.registerCommand("ccStatusDot.fav.refresh", favRefresh),
        vscode.commands.registerCommand("ccStatusDot.fav.browse", favBrowse),
    );

    // setInterval polling — refresh the tree every FAV_POLL_MS so it picks up
    // BOTH (a) external favorites.json mutations (hand-edit, multi-window
    // concurrent write, this window's own write — covered by re-reading the
    // file inside refresh()) AND (b) in-memory open/closed transitions
    // (globalThis.__ccsdSidToPanel publishes by the IIFE on panel show/dispose
    // WITHOUT touching disk, so fs.watchFile alone would miss these).
    // refresh() bails out early when the (doc, openSidSet) signature is
    // unchanged, so this tick is a no-op when the user is idle — no full-tree
    // invalidate, no selection clearing. 2s cadence mirrors the repatch
    // watcher's philosophy; fs.watch is unreliable cross-platform so polling a
    // tiny file is the robust choice.
    //
    // v0.4.0 round-2 (MEDIUM unguarded-setInterval fix): try/catch the refresh
    // so a stray throw inside vscode.EventEmitter.fire (or a future code path
    // we add to refresh()) does NOT spam an error notification every 2s for
    // the rest of the window's lifetime. refresh() itself is defensive
    // (readFavDoc swallows JSON errors), but the emitter's consumers are
    // VSCode internals whose error contract we don't control — best-effort
    // try/catch is zero-cost insurance against notification spam.
    favoritesWatcher = setInterval(() => {
        try {
            favoritesProvider?.refresh();
        } catch {
            /* best-effort — next tick retries */
        }
    }, FAV_POLL_MS);
    if (typeof (favoritesWatcher as NodeJS.Timeout).unref === "function") {
        (favoritesWatcher as NodeJS.Timeout).unref();
    }

    // v0.4.0 round-3 (MEDIUM setContext spam fix): publish the initial empty/
    // non-empty setContext synchronously upon registration so viewsWelcome
    // fires correctly on the view's first reveal — without this, the first
    // setContext would only land at the +2s polling tick, so a user opening
    // the Favorites view in the first 2s after activation would see a blank
    // view with no welcome content. Safe to call inline: refresh() is
    // defensive (readFavDoc swallows all fs/JSON errors → emptyFavDoc) and the
    // first-time signature check (sig === "" lastSig) always fires once.
    // Subsequent ticks are deduped by the signature check inside refresh().
    try {
        favoritesProvider?.refresh();
    } catch {
        /* best-effort — first polling tick retries */
    }
}

// Extension entry point. activationEvents: ["onStartupFinished"] fires once
// after VS Code startup completes (the standard, documented replacement for
// the never-standardized "onStartup" token, which VS Code silently ignored).
//
// v0.4.0 update: this extension now contributes the CC Favorites view in the
// Explorer sidebar (views/commands/menus/configuration declared in
// companion/package.json) ALONGSIDE the detect→patch→reload safety net.
// detectAndPatch() remains the first thing activate() does and is unchanged —
// Favorites initialization is fire-and-forget AFTER the detect, so a CC update
// that needs re-patching is never delayed by Favorites I/O. The pre-v0.4
// 'invisible unless it needs to act' comment was true for v0.2.3–v0.3.1 (no
// contributions declared, sole job = re-run the patcher) but is stale as of
// v0.4.0 — the Favorites view IS a declared contribution.
export function activate(_ctx: vscode.ExtensionContext): void {
    // v0.2.3: load the patcher-written config FIRST so all subsequent
    // accessors (injectMarker / injectVersion / searchDirs / ccExtIdPrefix)
    // see the refreshed values. If the config is missing (older patcher
    // install) we silently fall back to the v0.2.3 hardcoded constants.
    effectiveConfig = readCompanionConfig();
    if (effectiveConfig) {
        const cfgVer = effectiveConfig.patcherVersion;
        // v0.2.4 round-2 (ARCH-3): getCmpVerStr() returns null when the
        // config lacks semverComparatorSrc (older patcher that pre-dates the
        // field). Skip the staleness check in that case — the check is
        // best-effort; a stale patch.js is still caught by the IIFE-content-
        // -hash mismatch on the next patcher run.
        const cmp = getCmpVerStr();
        if (typeof cfgVer === "string" && cmp && cmp(cfgVer, MIN_PATCHER_VERSION) < 0) {
            // Stale INSTALL_DIR/patch.js snapshot: the user did
            // `npm install -g ...@latest` (refreshed the .vsix + companion)
            // WITHOUT re-running the bin (so INSTALL_DIR/patch.js is still
            // the older version that wrote this older config). Warn so they
            // know to re-run `npx vscode-claude-code-status-dot` — the
            // companion will otherwise keep re-execing the older patch.js
            // logic (which may lack anchor updates for newer CC versions).
            void vscode.window.showWarningMessage(
                `cc-status-dot: INSTALL_DIR/patch.js is older (v${cfgVer}) than the companion expects (v${MIN_PATCHER_VERSION}+). Run \`npx vscode-claude-code-status-dot\` to refresh the patcher copy so auto-re-patch keeps up with new Claude Code releases.`,
            );
        }
    }

    // Fire-and-forget — activation must not block the extension host.
    // detectAndPatch is fully async (patch.js is spawned, not execFileSync'd),
    // so the EH event loop stays responsive for other extensions during the
    // patch run.
    void detectAndPatch()
        .then(() => {
            // Start the cross-window repatch watcher after our own detect
            // pass — so the baseline `ts` we read reflects any patch we just
            // did (otherwise we'd immediately re-prompt for our own patch).
            const extDir = discoverCcInThisFlavor();
            if (extDir) startRepatchWatcher(extDir);
        })
        .catch((e) => {
            // Swallow to avoid breaking activation; surface to the user instead.
            vscode.window.showErrorMessage(
                `cc-status-dot companion: detection error (${(e as Error)?.message ?? String(e)})`,
            );
        });

    // v0.4.0: register Favorites (Explorer view + commands + persistence).
    // Fire-and-forget AFTER detectAndPatch is queued (NOT after it resolves —
    // Favorites must not wait for a CC update + re-patch that could take
    // seconds). Favorites has zero IIFE-coupling at registration time — the
    // sid→panel bridge is read lazily inside command handlers, so a not-yet-
    // patched CC simply shows "(closed)" for every session favorite until the
    // patch lands + the user reloads (R5 mitigation per FAVORITES-DESIGN.md).
    try {
        registerFavorites(_ctx);
    } catch (e) {
        // Surface but do not break activation — the safety net (detectAndPatch)
        // is the load-bearing half of this extension.
        vscode.window.showErrorMessage(
            `cc-status-dot companion: Favorites initialization error (${(e as Error)?.message ?? String(e)})`,
        );
    }
}

export function deactivate(): void {
    // Clear the cross-window repatch poller + any pending Later retry so the
    // EH can shut down cleanly. Both timers are .unref()'d so they wouldn't
    // block shutdown anyway, but explicit clearance is good hygiene.
    if (repatchTimer) {
        clearInterval(repatchTimer);
        repatchTimer = null;
    }
    if (laterRetryTimer) {
        clearTimeout(laterRetryTimer);
        laterRetryTimer = null;
    }
    // v0.4.0: clear the Favorites tree refresh poller (set in registerFavorites).
    if (favoritesWatcher) {
        clearInterval(favoritesWatcher);
        favoritesWatcher = null;
    }
}
