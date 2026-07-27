<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#license)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-how-it-works--docs)

**See every Claude Code session's status at a glance — without cycling through tabs.**

🟡 running · 🟢 done · 🔵 awaiting your input (CC permission prompt, or CC's reply says "let me know / your call") · 🔴 interrupted flashes — **tab five-state dots + bottom 4-light aggregate (🟢🟡🔵🔴, no gray — idle isn't counted at the bottom) + completion/interruption notifications + self-healing after CC updates + real-time token refresh / $ cost estimate on the right side (workflow subagent tokens included) + QuickPick config panel that follows VSCode's UI language (zh/en/ja/de/es/fr/pt/ru)**

[简体中文](README.md) | **English** | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

## 🖼️ See it at a glance

<div align="center">

<img src="docs/images/overview-annotated.png" alt="Overview: 6 features annotated (click to enlarge)" width="820">

</div>

**① Tab five-state status dots**　Every CC session tab's Claude icon changes color by state — 🟡 running / 🟢 done / 🔴 interrupted fast-flash / ⚪ idle / 🔵 awaiting input (yields to CC's native blue dot when CC pops a permission dialog, never overrides it); favorited session tabs get a **★** prefix on the title + a gold line under the icon. Shown in both the top tab bar and the left-side "Open Editors" view, synced on both sides.

**② Sidebar CC Favorites view**　A new CC Favorites in the Explorer sidebar pins frequently-used files and sessions together; session icons show open = solid chat bubble / closed = outline bubble, click to jump to it or resume into a new panel; right-click a closed session to copy the `claude -r <sid>` command.

**③ Bottom 4-light aggregate**　A single block on the status bar — 🟢 done · 🟡 running · 🔵 pending · 🔴 interrupted + counts — every session's overall status at a glance, no tab-switching needed; the 4 light slots are fixed in place, counts changing never shifts the layout.

**④ ★ One-click favorite button**　The ★/☆ button next to the token count on the status bar — one click to favorite / unfavorite the currently active CC session (favorited shows solid gold ★, unfavorited shows hollow ☆); auto-hides when there is no active CC session.

**⑤ Bottom-right token / $ cost**　The currently active session's token usage + optional USD estimate + streaming rate (tok/s); click to pop a QuickPick config panel (stats window / display mode / notifications / sound / copy / reset), the panel follows VSCode's UI language (zh/en/ja/de/es/fr/pt/ru).

**⑥ Completion / interruption notifications**　When a session finishes running or gets interrupted by rate-limiting, a system notification + sound pops up (macOS top-right dropdown / Windows · Linux bottom-right toast), fires in both foreground and background, so you get reminded even when you've switched away to do something else.

---

## 🚀 Get running in 30 seconds

```bash
npx vscode-claude-code-status-dot
```

Then **reload the window** — `Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → `Developer: Reload Window` — send any prompt to Claude Code, and watch the tab turn 🟡 yellow → 🟢 green. When CC asks for approval, the tab turns 🔵 blue (and the bottom bar's 🔵 pending light ticks up). That's it.

> **Prerequisites:** Node.js 18+, and the Claude Code VSCode extension installed.

Want it back to stock? `npx vscode-claude-code-status-dot --revert`.

---

## 💬 What you get

### 1. Per-session status dots on every tab

Each Claude Code session's tab icon — **in both the top tab bar and the top-left "Open Editors" view** — shows its live state:

- 🟡 **Yellow** while CC is working
- 🟢 **Green** when the turn finished cleanly
- 🔵 **Blue** when CC is waiting on you (permission / question / elicit)
- 🔴 **Red, fast-flashing** when interrupted or rate-limited
- ⚪ **Gray** when idle

No more opening each tab just to check "is this one done?"

### 2. One-glance bottom bar with every session at once

The bottom of the window carries a single block with four lights, each followed by a count:

**🟢 done · 🟡 running · 🔵 pending · 🔴 interrupted**

Three sessions working and two waiting on you? The bar reads `🟡3 🔵2` and you instantly know two sessions need your input. The four slots are fixed in place — counts changing never shifts the layout. Idle (gray) is intentionally not counted in the bottom aggregate — idle means no active session, so there is nothing to aggregate.

### 3. Notifications when a turn ends

When a session transitions to done or interrupted (only at the transition — no repeats):

- **macOS** — a native system notification drops from the top-right corner, with sound, no buttons, auto-dismissing. Fires whether VSCode is in the foreground or background.
- **Windows / Linux** — falls back to a VSCode toast in the bottom-right corner.

You can mute while focused, go silent, or change the sound — see [Configuration](#-configuration-optional).

### 4. Pending state for "your move" moments

The bottom bar's 🔵 light ticks up and the tab turns blue the moment Claude Code is waiting on you — **two triggers**:

**(a) CC pops an authorization dialog** (permission / question / elicit) — the reader **gracefully yields** the tab icon so CC's own native blue dot shows (we never override it), and the bottom status bar independently counts it as pending. One glance tells you how many sessions are stalled waiting on you.

**(b) CC's final reply clearly awaits your decision / feedback** — e.g. CC finishes with `waiting for your test feedback`, `you decide whether to continue`, `let me know`, `your call`, `please confirm`, `Should I proceed?` — the tab automatically turns blue (overriding the running-yellow / done-green). **You don't have to stare at the tab guessing "is it actually done, or is it waiting on me to say something?"** — this is the single most-requested pain point (CC falsely reporting "done" when it's really waiting on input); now the tab just tells you.

**How we tell neutral completion apart from "awaiting your reply"**:

- Neutral completion (`Done.`, `Shipped.`, `All tests pass.`) → tab stays 🟢 green
- Awaiting your decision / feedback (EN idioms `let me know` / `your call` / `please confirm` / `what do you think` / `over to you`, ZH idioms `等你` / `你决定` / `请确认` / `告诉我` / `听你的`, or a short standalone closing question like `Should I proceed?` / `需要继续吗?`) → tab turns 🔵 blue

**Won't false-trigger**: code-block identifiers like `letMeKnow()` are stripped before matching; rhetorical / informational questions (`Why?`, `什么意思?`, `效果如何?`) don't trigger either — so CC talking to itself never goes falsely blue.

### 4.5. 🪙 Right-side token / $ cost

A second status bar item on the **right side** of the status bar shows the token usage and (optional) USD cost estimate for the currently active CC panel:

```
$(clock) 12.3k tok · 1.2k/s · ~$0.42
```

- **v0.3.0 new: instantaneous tok/s rate + optional unicode sparkline** — every 500ms tick samples input+output tokens (deliberately excludes cache_read/cache_creation; otherwise cache spikes produce meaningless multi-M tok/s readings). The last 8 samples (4s) can render as an 8-block `▁▂▃▄▅▆▇█` mini-chart; the tok/s value comes from a 5-second sliding window. `ccStatusDot.rateDisplayMode` (`off|numeric|sparkline|both`, default `numeric`) controls the rendering; switch to `both` or `sparkline` for the mini-chart, or `off` on a crowded status bar. While streaming the rate shows (e.g. `· 1.2k/s`); when idle the rate hides and cost shows (e.g. `· ~$0.42`) — rate and cost share the same `·` divider.
- **v0.3.0 new: B/T units** — `fmtTok` extended from {k, M} to {k, M, B, T} 4-significant-figure adaptive formatting. 1.5B renders as "1.50B" instead of "1500.0M"; 796M renders as "796M" instead of "796.0M".
- **Token grows in real time while CC is streaming** — it doesn't wait for the reply to finish; every tick reads the transcript tail for the delta. Tooltip stays static (no flicker, already optimized). On perf-sensitive machines you can disable `tokenLiveDeltaEnabled`.
- **Default window is `all` (cumulative, never resets)** — pick from 5min / 10min / 1h / 24h / 3d / 7d / 30d / all. `all` is whole-session cumulative (monotonically grows at the session level, like a ledger that only goes up); `5min..30d` are rolling windows (old turns slide out when they expire, which can look like the count "resetting" — useful for "how much have I spent in the last X").
- **Workflow subagent tokens are included** — tokens burned by background subagents / teammates are merged into the parent session's stats (what you paid for them won't be "invisible").
- USD estimate runs off the `token-rates.json` hot-reload pricing table (Anthropic official prices preset; unknown models like GLM auto-hide the `$` and show tokens only).
- Tooltip shows the current session's total / 24h / 7d / 30d cumulative `$` + model + project + how long this turn has been running.
- Click the SBI for a QuickPick config panel: window switch / display mode (token / cost / both) / notify toggle / sound pick / copy token count / reset stats / open state dir / open settings.
- **The QuickPick config panel + tooltip follow VSCode's UI language** (zh/en/ja/de/es/fr/pt/ru, unknown falls back to en) — VSCode in Chinese → panel in Chinese. Config values (5min / all / token / cost / both / sound names) are language-neutral and never translated.
- Threshold alert: `ccStatusDot.warnThresholdUsd` fires a notification when crossed (disabled by default).
- **v0.5.36 new: instant tracking on tab switch** — when you switch to another session, the token SBI immediately reflects the new session's data (scans `__ccsdSidToPanel` for the real-time active panel + event-driven refresh, same pattern as the favorites star); switching to a session that's **still initializing** (sid not yet captured) shows ⟳ loading instead of leaving stale numbers from the previous session. Once loaded, switching back and forth between two sessions has **no loading flicker** (instant switch).

**Data source**: CC's transcript jsonl is the single authoritative source (each `assistant` row's `message.usage` carries 100% of input/output/cache_read/cache_creation). The writer hook reads it incrementally via a byte-offset sidecar (a 33MB file still costs < 100ms). CC `/resume` reuses the same sid → stats carry over naturally; a fresh session starts from 0.

See [USAGE.md §3.6](docs/USAGE.md) and [STATES.md §8](docs/STATES.md) for details.

### 5. Self-healing after Claude Code updates

Claude Code auto-updates, and each update used to wipe this patch. **Since v0.2.0**, a companion extension watches for that: the next time VSCode starts, it detects the missing patch, silently re-applies it, and prompts a one-click reload. You usually don't have to do anything.

### 6. It just stays installed

The runtime lives in `~/.claude/cc-status-dot/` — outside CC's extension directory. Deleting this project, purging the npx cache, or a CC auto-update won't break the dots.

### 7. No false green while a workflow is running

While a subagent / background task is in flight, the main session's tab **stays yellow** (no false "done") — the `Stop` hook only trusts the `background_tasks` count in the payload, never drifts. It only turns green when the work is actually finished.

### 8. Safe and fully reversible

Every patch is preceded by a syntax check (we never ship a broken `extension.js`), written atomically, and tagged with `INJECT_VERSION` so stale injections get refreshed automatically. One command — `--revert` — fully restores the original.

> ⚠️ **Honest disclaimer**: this project is a **patch, not a standalone extension** — VSCode has no API for a third-party extension to modify another extension's webview tab icon, so the only viable path is patching CC's own `extension.js`. The trade-off (CC auto-update overwriting it) is exactly what the v0.2.0 companion extension auto-recovers from.

---

## 🎨 Status colors

| Color                                          | Meaning                            | Trigger                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🟡 Yellow `#CCA700` (**static**, no animation) | Running                            | Prompt submitted, around tool calls (heartbeat), subagent spawn                                                                                                                                                                                                                                                                                                                                       |
| 🟢 Green `#3FB950` (static)                    | Turn done (not awaiting user)      | CC fires `Stop` and the final reply is a neutral completion (`Done.` / `Shipped.`); **auto-turns gray after 5 min**                                                                                                                                                                                                                                                                                   |
| 🔴 Red `#F85149` (fast flash)                  | Interrupted / errored              | CC fires `StopFailure` (rate limit, overload, etc.)                                                                                                                                                                                                                                                                                                                                                   |
| ⚪ Gray `#808080` (static)                     | Idle                               | Initial / done > 5 min ago / no state file                                                                                                                                                                                                                                                                                                                                                            |
| 🔵 Blue `#58A6FF` (static)                     | Awaiting your input (two triggers) | (a) **CC pops an authorization dialog**: reader yields the icon to CC's native blue dot (**never overrides**); (b) **CC's final reply carries an "awaiting your decision" semantic** (`let me know` / `your call` / `please confirm` / `等你` / `你决定` etc.) → reader renders the blue `claude-logo-pending.svg` (overrides running-yellow / done-green). The bottom 🔵 light counts both triggers. |

> Running is a static yellow dot (no animation); interrupted flashes red as an alert. Full state contract (events / SVG / IPC / notifications): [`docs/STATES.md`](docs/STATES.md).

---

## 🛠️ Capability details

### 🟡 Five-state tab icon dots

Each Claude Code session's tab icon is colored by its state, **shown in both the top tab bar and the top-left "Open Editors" view**. running / idle / done are static color dots, interrupted flashes red, and on permission the reader gracefully yields the icon to CC's native blue dot (**never overrides** it).

### 📊 Bottom status bar 4-light aggregate

One `StatusBarItem` on the bottom status bar (left half, near the center) renders four emoji lights separated by small spaces: 🟢 done · 🟡 running · 🔵 pending · 🔴 interrupted. Each light is a `<ball><count>` pair; counts cap at `0/1/2/3/N` (`N` for 4+). When a count is `0`, both the ball (gray ⚪) and the digit go dim; when non-zero, the ball takes its color and the digit lights up.

**The four slots are fixed in place — counts changing never shifts the layout.** VSCode's status bar CSS applies `font-variant-numeric: tabular-nums` to every item, so digits 0–9 are equal-width regardless of font.

🔵 pending is an independent dimension (decoupled from state), and **both triggers count**: (a) CC pops a permission / question / elicit dialog (the `Notification` hook writes `pending:true`); (b) CC's final reply carries an "awaiting your decision" semantic (the `Stop` hook reads the last assistant message, matches keywords like `let me know` / `your call` / `等你`, and writes `pending:true`). **The bottom aggregate counts both sources** — CC's real-time pending flag (synced within this window) + the on-disk `<sid>.json.pending` (async across windows) — so the moment a permission dialog pops, the light goes on, with no undercounting. The tab icon (a) yields to CC's native blue dot (no override), and (b) renders the blue dot directly (overrides yellow / green).

**3-stage GC** prevents count drift: done > 5 min → idle (green −1) / running unchanged > 30 min → idle (reclaims crashed sessions) / interrupted > 24 h → idle; pending GCs on the `st` field (a crashed pending goes idle, simultaneously decrementing both yellow and blue).

The whole block is rendered via **one runtime StatusBarItem + concatenated text** (an IIFE directly mutates the SBI's text every 500ms) — no need to patch CC's `package.json`, no ThemeColor block needed.

### 🔔 Completion / interruption notifications

- **macOS**: native system notification, top-right, with sound, no buttons, auto-dismisses — fires whether VSCode is foregrounded or backgrounded (`notifyWhenFocused` defaults to `true`).
- **Windows / Linux** (no `osascript`): VSCode's built-in toast (bottom-right, also buttonless and auto-dismissing).

Both done and interrupted play `ccStatusDot.notifySound` (default `Glass`). The first system notification triggers a one-time macOS prompt "Script Editor wants to send notifications" — allow it.

### ⚙️ Stays running while workflow runs

While a workflow / background subagent is in flight, the main session stays yellow — no false green the moment a long task is dispatched. `Stop` (from CC's hook payload) is the authoritative arbiter.

### 📂 Open Editors sync

The CC tab in VSCode's top-left "Open Editors" view **also carries the status dot**, fully in sync with the top tab bar.

### 🛡️ Persistent against CC auto-updates

Runtime files (4 SVGs + hook script + patcher) live in `~/.claude/cc-status-dot/`. CC's auto-update only wipes its own extension dir — `~/.claude/` is untouched. Deleting the source project or purging the npx cache also has no effect. **Plus**, since v0.2.0, the companion extension silently re-applies the patch on next VSCode start.

### ⭐ CC Favorites view (v0.4.0+) + tab right-click / gold-line marker (v0.5.0+)

A new **CC Favorites** view in VSCode's Explorer sidebar — pin frequently-used files and CC sessions together, and jump back to them quickly across panels and restarts.

- **Add a file**: right-click any file in Explorer → **CC Favorites: Add/Remove File** (setting `ccStatusDot.fav.includeInExplorerContextMenu` is on by default; turn it off if the menu gets crowded).
- **Add a CC session** (three entry points):
  - Command palette: **CC Favorites: Star/Unstar Current CC Tab** — adds/removes the currently active session to/from Favorites.
  - Command palette: **CC Favorites: Pick CC Session to Star/Unstar** (v0.5.9+) — a QuickPick listing every open CC session (already-favorited ones ★ to the top); pick one to toggle, **independent of the currently active tab** — the reliable entry point for starring a session from inside itself.
  - **Status-bar ★ button (v0.5.10+, handiest)** — a ★/☆ button on the bottom-right status bar (next to the token count) that **one-click** favorites/unfavorites the currently active CC session: favorited shows a solid gold ★ (gold, aligned with the gold-line marker), unfavorited shows a hollow ☆. It always acts on the currently active session (sidestepping the platform limits of webview write-once / right-click picking the wrong tab), and toggles on click (catches up to state within ≤500ms after switching tabs, v0.5.11); auto-hides when there is no active CC session.
  - Right-click a CC tab in Explorer's **Open Editors** area → **Add to / Remove from CC Favorites** (dynamic label, setting `ccStatusDot.fav.includeInExplorerContextMenu`).
- **★ title prefix (v0.5.9+)**: a favorited CC session automatically gets a `★ ` prepended to its tab **title** (the five-state dot color/shape stays unchanged, and the gold-line marker remains). An IIFE syncs from `favorites.json` every 500ms tick (mtime cache → shows within ≤1s after a favorite is written). The v0.5.8 "clickable star inside the webview" was forensically proven architecturally infeasible (CC only sets webview.html once when creating the panel; any reset triggers a full-page reload that destroys the session) and was abandoned; the title prefix is its reload-free replacement.
- **Jump**: click a file node → jump to that file (with line-number positioning); **click a session node → switch to it if open, or resume-open if closed (resume into a new panel, v0.5.11+)**; right-click a closed session → **Copy 'claude -r <sid>'** copies the resume command to the clipboard (terminal fallback).
- **Browse**: command palette **CC Favorites: Browse** for QuickPick keyboard navigation (opens favorited items).
- **Gold-line marker (v0.5.0+)**: a favorited CC session gets a thin gold line at the bottom of its tab icon (the five-state dot color/shape stays completely unchanged), synced automatically from `favorites.json` by an IIFE every 500ms tick.
- **Session-tree icon differentiation (v0.5.36 new)**: in the sidebar CC Favorites view, **open sessions** (initialized and in use) show a solid light-gray chat bubble (solid foreground + outline background), while **closed sessions** show a single-outline bubble — tell at a glance which sessions are still alive and which are closed.

Favorites are stored in `~/.claude/cc-tab-status/favorites.json` (atomic writes, preserved across restarts). Full design in [`docs/FAVORITES-DESIGN.md`](docs/FAVORITES-DESIGN.md).

> As of v0.5.11, clicking a closed session directly resumes it into a panel — going through CC's own `claude-vscode.editor.open(sid)` → `createPanel(sid)`, launching the CLI with `--session-id=<sid>` to load that session's history. The right-click Copy cmd is kept as a terminal fallback.

### 🔒 Safe writes

Every patch is preceded by `node --check` (the `assertCompiles` guard): if the IIFE we're about to write isn't syntactically valid, we refuse the write — the extension is never left broken. Writes are atomic, and `INJECT_VERSION` ensures stale patches get automatically re-injected on the next run.

### ↩️ Zero side effects, one-click restore

`--revert` fully restores `extension.js` from `.bak`, surgically removes the **9 managed hooks** (tagged `# cc-status-dot-managed` in `~/.claude/settings.json`, including the Notification hook that powers the 🔵 pending light), and keeps your user data.

<details>
<summary>📖 Why a patch (not a standalone extension)</summary>

A VSCode `WebviewPanel` tab icon (`iconPath`) is set **exclusively by the extension that created that panel** — there is no public API for a third-party extension to modify it. CC's session tab is a WebviewPanel created by the CC extension itself, so its icon can only be assigned from inside CC's `extension.js`. We exhausted the alternatives (standalone extension, proposed APIs, webview interception, etc.) — none can reach the icon. The only viable path is a patch. Trade-off: a CC auto-update overwrites it — which is exactly what the v0.2.0 companion extension auto-recovers from.

</details>

<details>
<summary>📖 Command reference</summary>

| Command                                      | Effect                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `npx vscode-claude-code-status-dot`          | Install (patch extension.js + wire hooks, idempotent; auto-cleans leftover files from old versions) |
| `npx vscode-claude-code-status-dot --revert` | Restore (from `.bak` + remove hooks + delete INSTALL_DIR, keeps user data)                          |
| `npx vscode-claude-code-status-dot --status` | Dry-run report, changes nothing                                                                     |

For dev, swap the command for `npx tsx patch.ts` (same flags).

Or from source:

```bash
git clone https://github.com/wangdong233/vscode-claude-code-status-dot.git
cd vscode-claude-code-status-dot
npx tsx patch.ts
```

Old git-clone installs can just re-run `npx vscode-claude-code-status-dot` — the patcher detects the old injection logic → auto-restores the original → re-injects the new version (**no need to `--revert` first**).

</details>

<details>
<summary>📖 What that one-line install actually does</summary>

1. Finds `anthropic.claude-code-*` under `~/.vscode/extensions` (and insiders / cursor / vscodium), picks the highest version;
2. Auto-cleans leftover files from old versions (if any);
3. **Backs up** `extension.js` → `extension.js.bak` (first run only);
4. Injects a timer (sets tab icon + done/interrupted notifications);
5. Writes **9 hook events** into `~/.claude/settings.json` (tagged `# cc-status-dot-managed`, idempotent — including the `Notification` hook that powers the 🔵 pending light);
6. Copies runtime files (4 SVGs = idle + running + done + error, plus the hook script) to `~/.claude/cc-status-dot/` (`INSTALL_DIR`);
7. **v0.2.0+**: detects every VS Code-family CLI on PATH (`code`, `code-insiders`, `cursor`, `codium`) and runs `code --install-extension` for the **companion .vsix** (`cc-status-dot-companion`) into each; also copies `patch.js` to `INSTALL_DIR/patch.js` so the companion can silently re-patch after a CC auto-update.

Both paths (npx and source) are equivalent and idempotent. The injected IIFE and the hook both reference the `INSTALL_DIR` absolute path — **deleting the source project or purging the npx cache does not affect the patched extension**.

</details>

---

## ⚙️ Configuration (optional)

**Two ways to change config**:

1. **Click the right-side token SBI** → a QuickPick config panel pops up (see the screenshot in "See it at a glance" above) — graphically switch the stats window / display mode / notifications / sound, or copy the token count / reset stats / open the state dir / open settings. Changes are written to `settings.json` automatically. The panel follows VSCode's UI language (zh/en/ja/de/es/fr/pt/ru, unknown falls back to en).
2. **Edit `settings.json` directly** (table below) — for batch config or version control.

Add to VSCode's `settings.json` (skip to keep defaults):

```json
{
  "ccStatusDot.notify": true,
  "ccStatusDot.notifyWhenFocused": true,
  "ccStatusDot.notifySound": "Glass",

  "ccStatusDot.tokenStatsWindow": "all",
  "ccStatusDot.tokenDisplayMode": "both",
  "ccStatusDot.tokenSbiVisible": true,
  "ccStatusDot.tokenLiveDeltaEnabled": true,
  "ccStatusDot.showCost": true,
  "ccStatusDot.warnThresholdUsd": 0
}
```

| Option                              | Default   | Description                                                                                                                                                                                                            |
| ----------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ccStatusDot.notify`                | `true`    | Master notification switch                                                                                                                                                                                             |
| `ccStatusDot.notifyWhenFocused`     | `true`    | Also fire the notification when VSCode is focused (notifications fire in both foreground and background by default; set `false` to mute while focused)                                                                 |
| `ccStatusDot.notifySound`           | `"Glass"` | macOS notification sound (used for both done & interrupted; `""` for silent; options: Basso/Ping/Hero, etc.)                                                                                                           |
| `ccStatusDot.tokenStatsWindow`      | `"all"`   | Time window for the right-side token SBI. `all` = cumulative (whole session, never resets, default); `5min/10min/1h/24h/3d/7d/30d` = rolling windows (old turns slide out, which can look like the count "resetting"). |
| `ccStatusDot.tokenDisplayMode`      | `"both"`  | token SBI display mode: `token` (tokens only) / `cost` ($ only) / `both` (both)                                                                                                                                        |
| `ccStatusDot.tokenSbiVisible`       | `true`    | Show / hide the token SBI                                                                                                                                                                                              |
| `ccStatusDot.tokenLiveDeltaEnabled` | `true`    | During streaming, the IIFE reads the transcript tail every tick so token counts update between hook fires; set `false` on perf-sensitive machines                                                                      |
| `ccStatusDot.showCost`              | `true`    | Show `$` (unknown models auto-hide; requires a matching entry in `token-rates.json`)                                                                                                                                   |
| `ccStatusDot.warnThresholdUsd`      | `0`       | Cross-threshold cost notification (0 = disabled; positive number = USD threshold, fires once per crossing)                                                                                                             |

> **Custom model pricing**: `~/.claude/cc-status-dot/token-rates.json` is a hot-reload pricing table — by default it covers Anthropic's official prices; unmatched models like GLM auto-hide the `$`. Add a glob to display `$` for them:

```jsonc
{
  "_default": null,
  "claude-sonnet-*": { "in": 3, "out": 15, "cacheRead": 0.3, "cacheCreate5m": 3.75, "cacheCreate1h": 6 },
  "glm-*": { "in": 0.5, "out": 1.5 },
}
```

---

## ❓ FAQ

**After a CC update the status dot stopped lighting up?**
Since v0.2.0, the companion extension checks the `cc-status-dot-injected` marker at VS Code startup and, if CC wiped the patch, silently re-runs `node ~/.claude/cc-status-dot/patch.js` and prompts a one-click `Reload Window` — most of the time you don't need to do anything. If the companion isn't installed (or you want to fix manually), re-run `npx vscode-claude-code-status-dot` (the SVG/hook runtime copies live in `~/.claude/cc-status-dot/`, which a CC update doesn't touch; deleting the source project doesn't matter either).

**Just installed and the icon didn't change?**
First run `Developer: Reload Window`. If it still doesn't work, run `npx vscode-claude-code-status-dot --status`: `patched: no` → re-run; `baked RES ... (STALE)` → re-run to rewrite in place; `hooks wired: no` → re-run; `missing SVGs` → re-run to refill.

**Upgrading from an old (git clone) install?**
Just re-run `npx vscode-claude-code-status-dot` — old-version upgrades are handled automatically; no need to `--revert` first.

**State stuck on running?**
Likely you interrupted CC with Esc (CC doesn't fire Stop/StopFailure, so no hook fires). The next prompt or a normal completion corrects it naturally.

**`npx` can't connect?**
Fall back to a global install:

```bash
npm i -g vscode-claude-code-status-dot
vscode-claude-code-status-dot        # run the command directly after install
```

---

## ⚠️ Known limitations

- **No hook for manual Esc interrupt**: CC doesn't fire Stop/StopFailure ([#45289](https://github.com/anthropics/claude-code/issues/45289)/[#9516](https://github.com/anthropics/claude-code/issues/9516)), so the state stays on running; corrected naturally by the next prompt/Stop.
- **CC auto-update overwrite**: patched `extension.js` is overwritten by the original → **since v0.2.0 the companion extension auto-re-runs the patcher + prompts a reload** (see FAQ); without the companion, re-run the command manually to restore.
- **Minified anchor fragility**: the patch depends on two exact strings in CC's code; on version drift the patcher reports "Anchor mismatch" and refuses to write (the extension is not damaged).
- **No notification when VSCode is fully closed**: the IIFE runs in the extension host process; if VSCode is closed it doesn't run → no notification.
- **System notification click doesn't jump to tab**: osascript has no click callback; the notification only reminds — locate the session via the tab green/red dot back in VSCode.
- **SBI priority namespace not owned**: the bottom status bar item sits at a single priority (`-9996`). The VSCode StatusBarItem API has no extension-level namespace/ownership — another extension declaring the same priority could push our item to a corner. Because the whole 4-light row is one SBI, an external insertion can only land on the side, never _between_ the four lights. Rare in practice; documented honestly in STATES.md §7.5.
- **Emoji font-stack dependency**: the bottom status bar dots are emoji glyphs (🟢🟡🔵🔴⚪) that depend on the system emoji font stack — macOS (Apple Color Emoji) / Windows 10+ (Segoe UI Emoji) / mainstream Linux (Noto Color Emoji) render them in color; Win7 / some headless Linux / emoji-font-less remote SSH environments may render them as monochrome glyphs or tofu boxes. A deliberate tradeoff (user aesthetic preference > cross-platform uniformity).

---

## 🏗️ How it works + docs

**Patches CC's extension.js (injects a timer to set tab icons) + CC hooks write state + completion/interruption notifications.** Full docs:

- [`docs/STATES.md`](docs/STATES.md) — **state contract (single source of truth)**: five states / event mapping / IPC / notifications
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md) — icon injection rationale (anchors / IIFE / SVG wiring)
- [`docs/USAGE.md`](docs/USAGE.md) — usage guide (install / troubleshooting / revert)

> This project modifies CC's `extension.js` (backed up; `--revert` fully restores) and writes to `~/.claude/settings.json` (backed up on first run). The hook script **never blocks CC** — any error exits silently.

---

## 💝 Support the author

If vscode-claude-code-status-dot helps you, consider buying the author a coffee ☕

<div align="center">

|                                WeChat                                |                                Alipay                                |
| :------------------------------------------------------------------: | :------------------------------------------------------------------: |
| <img src="docs/images/support-wechat.jpg" height="200" alt="WeChat"> | <img src="docs/images/support-alipay.jpg" height="200" alt="Alipay"> |

</div>

Or ⭐ Star, open an Issue / PR — all of it supports the author.

## License

[MIT](LICENSE) (c) wangdong
