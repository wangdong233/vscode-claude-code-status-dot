// companion/extension.ts — cc-status-dot companion VS Code extension.
//
// PURPOSE (v0.2.1)
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
//   This extension does NOT duplicate any IIFE logic. It does exactly three
//   things:
//     1. Detect (grep the CC extension.js for `cc-status-dot-injected`).
//     2. If absent/stale, exec the patcher in --patch-only mode
//        (`node <INSTALL_DIR>/patch.js --patch-only`).
//     3. Reload the window once and show an informational message.
//   That's it. No status bar, no commands, no settings — the patcher's IIFE is
//   the only thing that should paint UI.
//
// ACTIVATION
//   activationEvents: ["onStartupFinished"] (VS Code 1.74+; fires once after
//   startup completes, asynchronously — does not block the EH like onStartup
//   would, and is the documented replacement for the never-standardized
//   "onStartup" token which VS Code silently ignored in early v0.2.1 builds
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
 *  v0.2.1: this constant is now a FALLBACK. The patcher writes its actual
 *  INSTALL_DIR (along with all other constants the companion needs) to
 *  `INSTALL_DIR/companion-config.json` at install time; the companion reads
 *  that file at activate() and prefers its values. The fallback is taken only
 *  when the config is missing (e.g. the companion was installed by an older
 *  patcher that pre-dates the config write — in that case we behave exactly
 *  like v0.2.1). */
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
const MIN_PATCHER_VERSION = "0.2.1";

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
}

/** Read INSTALL_DIR/companion-config.json. Returns null if missing / corrupt
 *  (the companion falls back to its hardcoded constants in that case — same
 *  behavior as v0.2.1). Logs nothing on failure; the caller decides whether
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

/** Marker grepped in CC's extension.js. Falls back to the v0.2.1 hardcoded
 *  value if the config is missing. */
function injectMarker(): string {
    return effectiveConfig?.injectMarker ?? "cc-status-dot-injected";
}

/** Expected IIFE version stamp. Falls back to the v0.2.1 hardcoded value if
 *  the config is missing. Returned (not const) because it depends on the
 *  runtime-loaded config. */
function injectVersion(): string {
    return effectiveConfig?.injectVersion ?? "v0.2.1";
}

/** Effective CC extension id prefix (`anthropic.claude-code`). Used by
 *  discoverCcInThisFlavor's vscode.extensions.all scan. */
function ccExtIdPrefix(): string {
    return effectiveConfig?.ccExtIdPrefix ?? CC_EXT_ID_PREFIX_FALLBACK;
}

/** Effective SEARCH_DIRS for the disk-only fallback scan. Returns the
 *  config's list if present (so new flavors added by a future patcher flow
 *  through without a .vsix rebuild), else the v0.2.1 hardcoded list. */
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
 *  without reloading the window. v0.2.1 changed from a single boolean to a
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
 *  v0.2.1: this is now a fallback default; the effective value is read from
 *  companion-config.json (ccExtIdPrefix accessor). Kept as a const so the
 *  fallback has a stable name (vs an inline string). */
const CC_EXT_ID_PREFIX_FALLBACK = "anthropic.claude-code";

/** Find the Claude Code extension installed in THIS VS Code flavor (the one
 *  whose extension host we're running in), preferring the vscode.extensions
 *  API (which scopes to the current flavor automatically) and falling back to
 *  a SEARCH_DIRS scan if the API can't see CC for any reason.
 *
 *  v0.2.1 fix (architecture review, was HIGH): the pre-fix version scanned ALL
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
    // version globally, same as pre-v0.2.1; not ideal for stable+insiders
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

/** Compare two `X.Y.Z` version strings numerically. Returns >0 if a>b, <0 if
 *  a<b, 0 if equal. Used to detect a stale INSTALL_DIR/patch.js snapshot
 *  (config.patcherVersion < MIN_PATCHER_VERSION).
 *
 *  MIRROR HEADER (DRY contract): this function MUST stay byte-for-byte
 *  equivalent to patch.ts:cmpSemver / cmpVerStr. The companion compiles
 *  standalone into a .vsix so it cannot import the canonical helper at
 *  runtime — the price of distribution isolation is a mirror copy. A future
 *  4-segment or pre-release-tag change touches BOTH files; if you change
 *  the body, mirror it here. See hooks/test-version-sync.mjs for the CI
 *  assertion that the two implementations agree on a fixed test corpus. */
function cmpVerStr(a: string, b: string): number {
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

/** Freshness check for the on-disk CC extension.js.
 *   "fresh"  — marker present AND version stamp matches the effective
 *              INJECT_VERSION (from companion-config.json, falling back to
 *              the v0.2.1 hardcoded default if config is missing).
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
 *  v0.2.1: marker + expected version are taken from accessors (which read
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
 *  JSDoc correction (v0.2.1 architecture review): the prior comment claimed
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
            const anchorBMissing =
                /Anchor B not found/i.test(stdout) || /anchors injected: A only/i.test(stdout);
            resolve({ ok: code === 0, stdout, stderr, anchorBMissing });
        });
    });
}

/** Detect → patch → reload, gated by the per-extDir globalThis Set. Designed
 *  to be safe to call from activation on every startup. */
async function detectAndPatch(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
 *  patch reload message with "Later". Closes the v0.2.1 half-state gap:
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
 *  patcher that pre-dates the flag write — same v0.2.1 behavior, no
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// Extension entry point. activationEvents: ["onStartupFinished"] fires once
// after VS Code startup completes (the standard, documented replacement for
// the never-standardized "onStartup" token, which VS Code silently ignored).
// We deliberately do not declare contributions — this extension is invisible
// unless it needs to act.
export function activate(_ctx: vscode.ExtensionContext): void {
    // v0.2.1: load the patcher-written config FIRST so all subsequent
    // accessors (injectMarker / injectVersion / searchDirs / ccExtIdPrefix)
    // see the refreshed values. If the config is missing (older patcher
    // install) we silently fall back to the v0.2.1 hardcoded constants.
    effectiveConfig = readCompanionConfig();
    if (effectiveConfig) {
        const cfgVer = effectiveConfig.patcherVersion;
        if (typeof cfgVer === "string" && cmpVerStr(cfgVer, MIN_PATCHER_VERSION) < 0) {
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
}
