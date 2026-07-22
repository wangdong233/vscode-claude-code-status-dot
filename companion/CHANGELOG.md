# Change Log — cc-status-dot Companion

All notable changes to the **cc-status-dot Companion** VS Code extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

> Companion releases 0.2.1 → 0.3.1 shipped incremental patcher-version/handshake bumps without a dedicated CHANGELOG entry; this file picks up at 0.4.0 with the Favorites feature. See the main project `CHANGELOG.md` for the cross-version trail (the companion version follows the patcher's lockstep).

## [0.2.0] — 2026-07-19

### Added

- Initial companion release.
- Detects Claude Code extension auto-update (missing `cc-status-dot-injected` marker in CC's `extension.js`) on VS Code startup.
- Silently re-applies the patch by re-executing `node ~/.claude/cc-status-dot/patch.js`.
- Prompts the user for a one-click **Reload Window** to activate the refreshed patch.
- Idempotent via a `globalThis.__ccsdCompanionRan` once-guard so multi-root workspaces don't multi-fire.
