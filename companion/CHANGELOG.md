# Change Log — cc-status-dot Companion

> **ARCHIVED (2026-08-21, v0.5.48)**: entries stop at 0.5.9. From 0.5.10 on,
> version-by-version rationale lives in git commit messages
> (https://github.com/wangdong233/vscode-claude-code-status-dot/commits/main).
> This file is kept for the pre-0.5.10 history only (03 清单 §1.7.2 disposition).

All notable changes to the **cc-status-dot Companion** VS Code extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.9] — 2026-07-23

### Added — QuickPick session selector (replaces the infeasible in-webview star)

- **`ccStatusDot.fav.pickSession` command** (`favPickSession()` in `extension.ts`): command-palette entry "CC Favorites: Pick CC Session to Star/Unstar" — lists every open CC session via `globalThis.__ccsdSidToTitle` ∪ `__ccsdSidToPanel` (favorited ★ first, then open, then closed), pick one to toggle. Goes through the sole writer `writeFavAtomic` + `forceRefresh` so the tree re-renders inline. This is the zero-webview-coupling replacement for v0.5.8's in-webview star click (which was architecturally infeasible — see git history (archived file — pre-0.5.10)).

### Removed — `editor/title/context` tab right-click menu + dead config

- **`editor/title/context` menu section** (the v0.5.0 addTab/removeTab items): removed. VSCode exposes no CC-specific context key for the right-clicked tab, so the menu could only surface on ALL non-file tabs (handler no-op'ing on non-CC tabs), and the `data-vscode-context` that v0.5.8's star injection set on the webview body was removed with the injection. `explorer/context` (Open Editors) + `commandPalette` (toggleTab + pickSession) + `webview/context` (retained for forward-compat, currently dormant) remain.
- **Configuration**: `ccStatusDot.fav.includeInTabContextMenu` (the v0.5.0 opt-out) removed — its only gating target (`editor/title/context`) is gone. 8-language NLS descriptions updated; the `includeInWebviewContextMenu` description updated to note the menu is dormant pending a future context mechanism (point users at pickSession).

### Changed — 5-way version pin

- companion/package.json: `0.5.8` → `0.5.9`. `MIN_PATCHER_VERSION` + `injectVersion()` fallback synced to the patcher.

## [0.5.0] — 2026-07-22

### Added — Tab right-click favorite toggle + gold-underline favorited icon

- **`editor/title/context` menu** (`contributes.menus["editor/title/context"]`): right-click any webview tab to get "CC Favorites: Star/Unstar Current CC Tab". `when: resourceScheme == 'webview' && config.ccStatusDot.fav.includeInTabContextMenu'`. Reuses the existing `ccStatusDot.fav.toggleTab` command + `favToggleTab()` handler — the handler's `__ccsdActiveSid` check no-ops with an info message when the active tab is not a Claude Code session (no CC-specific context key exists; this is the tightest VSCode exposes).
- **Configuration**: `ccStatusDot.fav.includeInTabContextMenu` (default `true`) — opt-out for users who don't want the menu item on non-CC webview tabs.
- **5 `-fav` SVG variants** ship in the patcher's `resources/` (`claude-logo-{idle,running,done,error,pending}-fav.svg`): byte-identical base + a thin gold `<rect>` underline at the viewBox bottom (fill `#F5A623`, height 0.9 / 24 ≈ 3.7%). The IIFE's per-panel tick reads `favorites.json` via an mtime+size cache and swaps the base leaf for `-fav` when the panel's sid is favorited.

### Changed

- `MIN_PATCHER_VERSION` 0.4.0 → 0.5.0; `injectVersion()` fallback v0.4.0 → v0.5.0 (config schema + IIFE body both moved; the bump re-runs the patcher/companion handshake).

### Notes

- VSCode exposes no Claude-Code-specific context key for webview tabs. The menu item surfaces on ALL webview tabs (Copilot Chat, Redis Viewer, etc.); the handler no-ops with an info message on non-CC webviews. Users can set `ccStatusDot.fav.includeInTabContextMenu: false` to hide the item entirely.

## [0.4.0] — 2026-07-22

### Added — Favorites view + commands + persistence

- **Explorer sidebar "CC Favorites" view** (`contributes.views.explorer`). Toggle via the Explorer views menu (right-click the Explorer header → CC Favorites). Empty state shows a welcome with quick actions.
- **Commands** (all under the **CC Favorites** category in the Command Palette):
  - `CC Favorites: Add/Remove File` — toggles a file in/out of favorites (also in Explorer right-click for files; opt-out via `ccStatusDot.fav.includeInExplorerContextMenu`).
  - `CC Favorites: Star/Unstar Current CC Tab` — toggles the currently-active Claude Code session in/out of favorites (reads `globalThis.__ccsdActiveSid` published by the IIFE).
  - `CC Favorites: Open` — files open at their saved cursor line; open sessions focus the live CC webview panel.
  - `CC Favorites: Remove` — removes a node from the tree (also via the inline ✕ button).
  - `CC Favorites: Copy 'claude -r <sid>'` — copies the resume command for a closed session to the clipboard (architectural fallback: see `docs/FAVORITES-DESIGN.md` D1 — reopening a closed CC webview panel is not reachable from the public CC API; the user pastes the command into a terminal).
  - `CC Favorites: Refresh` + `CC Favorites: Browse` (QuickPick keyboard navigation).
- **`~/.claude/cc-tab-status/favorites.json`** — atomic-write persistence (tmp + rename, same discipline as the patcher's `writeAtomicSync`). Schema: `{version,updatedAt,sessions:[{sid,label,cwd,transcript_path,model,state,addedAt,lastSeenAt}],files:[{fsPath,label,line,workspace,addedAt}]}`. Companion is the sole writer; the IIFE does not read this file in v0.4 (the v0.5 tab composite-star feature will read it via mtime-cache).
- **Configuration**: `ccStatusDot.fav.includeInExplorerContextMenu` (default `true`).
- **IIFE bridge** (`patch.ts` §A preamble + §Z onDidDispose + §D.5 registerCommand): publishes `globalThis.__ccsdSidToPanel[sid] = panel` so the companion can call `.reveal()` on an open CC session (same-EH shared globalThis, established pattern); registers `ccStatusDot.fav.focusSession` as a command fallback for future EH isolation.

### Architecture

- The Favorites surface lives in the **companion** (not the IIFE) because VSCode requires `contributes.views.explorer` in a real package.json for the tree view to appear; the IIFE has no package.json to contribute into. The IIFE publishes only the minimal sid→panel bridge + the fallback command. `detectAndPatch()` is unchanged and still runs first on activation; Favorites initialization is fire-and-forget AFTER it (Favorites I/O never delays a CC update + re-patch).
- See `docs/FAVORITES-DESIGN.md` for the full design (4-track research summary, Q1-Q5 resolved, GO/NO-GO = PARTIAL-GO, MVP boundary, deferred-to-v0.5 risk parts).

### Deferred to v0.5+

- **Tab composite star icon** (Q3 option a — 5 state × 2 favorited = 10 SVG variants): v0.4 ships option (c) — star only in the Favorites view via ThemeIcon, tab icon unchanged. Trigger for v0.5: user feedback "I want the star on the tab too".
- **Tab right-click menu** (`editor/title/context` — "Star/Unstar Current CC Tab"): the design requires a PoC verifying menu-item visibility on webview-panel tabs before shipping. v0.4 ships only `ccStatusDot.fav.toggleTab` via the Command Palette.
- **Closed-session reopen as CC webview panel**: architecturally unreachable (CC has no public sid-arg command; CC viewType is private; `claude -r <sid>` opens a terminal, not a webview). v0.4 ships the `Copy 'claude -r <sid>'` degraded path; the design notes the dependency on Anthropic shipping a public `claude-vscode.session.open` command.

### Changed

- `MIN_PATCHER_VERSION` 0.3.1 → 0.4.0; `injectVersion()` fallback v0.3.1 → v0.4.0; `activationEvents` adds `onView:ccStatusDot.favorites`.

> Companion releases 0.2.1 → 0.3.1 shipped incremental patcher-version/handshake bumps without a dedicated CHANGELOG entry; this file picks up at 0.4.0 with the Favorites feature. See git history for the cross-version trail (pre-0.5.10 entries above; later rationale in commit messages) (the companion version follows the patcher's lockstep).

## [0.2.0] — 2026-07-19

### Added

- Initial companion release.
- Detects Claude Code extension auto-update (missing `cc-status-dot-injected` marker in CC's `extension.js`) on VS Code startup.
- Silently re-applies the patch by re-executing `node ~/.claude/cc-status-dot/patch.js`.
- Prompts the user for a one-click **Reload Window** to activate the refreshed patch.
- Idempotent via a `globalThis.__ccsdCompanionRan` once-guard so multi-root workspaces don't multi-fire.
