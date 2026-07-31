<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#license)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-how-it-works--docs)

**See every Claude Code session's status at a glance — without cycling through tabs.**

🟡 running · 🟢 done · 🔵 awaiting your input (CC permission prompt, or CC's reply says "let me know / your call") · 🔴 interrupted flashes — **tab five-state dots + bottom 4-light aggregate (🟢🟡🔵🔴, no gray — idle isn't counted at the bottom) + completion/interruption notifications + self-healing after CC updates + real-time token refresh / $ cost estimate on the right side (workflow subagent tokens included) + QuickPick config panel that follows VSCode's UI language (zh/en/ja/de/es/fr/pt/ru)**

[简体中文](../README.md) | **English** | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

## 🖼️ See it at a glance

<div align="center">

<img src="docs/images/overview-annotated.png" alt="Overview: 6 features annotated (click to enlarge)" width="820">

</div>

**① Tab five-state status dots**　Every CC session tab's Claude icon changes color by state — 🟡 running / 🟢 done / 🔴 interrupted fast-flash / ⚪ idle / 🔵 awaiting input. 🔵 awaiting input has two triggers: (a) when CC pops a permission dialog, it yields to CC's native blue dot (never overrides it); (b) when CC's reply carries an "awaiting your decision" semantic (`let me know` / `your call` / `please confirm` / `等你确认` etc.), the tab automatically turns blue (overriding the running-yellow / done-green) — so at a glance you can tell whether it's truly done or waiting on you to say something, no need to stare at the tab guessing. Favorited session tabs get a **★** prefix on the title + a gold line under the icon; archived session tabs get a **●** prefix + a grey line under the icon (favorites and archives are mutually exclusive — a session is in at most one). Shown in both the top tab bar and the left-side "Open Editors" view, synced on both sides.

**② Sidebar CC Favorites / CC Archive views**　Two new views in the Explorer sidebar — CC Favorites + CC Archive (mutually exclusive: a session lives in at most one); the Favorites view pins frequently-used sessions/files together, the Archive view stashes sessions you don't need for now. Session icons show open = solid chat bubble / closed = outline bubble, click to jump to it or resume into a new panel; inline buttons toggle between them — Favorites view [Archive][Open][Remove], Archive view [Favorite][Open][Remove], clicking Archive/Favorite moves it to the other view automatically. Right-click a closed session to copy the `claude -r <sid>` command.

**③ Bottom 4-light aggregate**　A single block on the status bar — 🟢 done · 🟡 running · 🔵 pending · 🔴 interrupted + counts — every session's overall status at a glance, no tab-switching needed; the 4 light slots are fixed in place, counts changing never shifts the layout.

**④ ★ Favorite / ○ Archive buttons**　Two buttons next to the token count on the status bar: ★/☆ to favorite / unfavorite the currently active CC session (favorited shows solid gold ★, unfavorited shows hollow ☆), and ○/● to archive / unarchive it (archived shows solid grey ●, unarchived shows hollow grey ring ○). Favorites and archives are mutually exclusive — clicking one automatically clears the other; both auto-hide when there is no active CC session.

**⑤ Bottom-right token / $ cost**　The currently active session's token usage + optional USD estimate + streaming rate (tok/s); click to pop a QuickPick config panel (stats window / display mode / notifications / sound / copy / reset), the panel follows VSCode's UI language (zh/en/ja/de/es/fr/pt/ru).

**⑥ Completion / interruption notifications**　When a session finishes running or gets interrupted by rate-limiting, a system notification + sound pops up (macOS top-right dropdown / Windows · Linux bottom-right toast), fires in both foreground and background, so you get reminded even when you've switched away to do something else.

> **Reliability safeguards**: When a CC auto-update overwrites the patch, the companion self-healing extension automatically re-patches and prompts a reload (invisible recovery); before every patch the full 2.6MB `extension.js` is validated with `node --check` + written atomically (**never bricks CC**); `--revert` is a one-click, zero-side-effect restore; the runtime copies live in `~/.claude/cc-status-dot/` (deleting the source / purging the cache / a CC update won't affect an installed copy). While a workflow runs subagents, the main session stays 🟡 — no false green.

---

## 🚀 Get running in 30 seconds

```bash
npx vscode-claude-code-status-dot
```

Then **reload the window** — `Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → `Developer: Reload Window` — send any prompt to Claude Code, and watch the tab turn 🟡 yellow → 🟢 green. When CC asks for approval, the tab turns 🔵 blue (and the bottom bar's 🔵 pending light ticks up). That's it.

> **Prerequisites:** Node.js 18+, and the Claude Code VSCode extension installed.

Want it back to stock? `npx vscode-claude-code-status-dot --revert`.

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

## ⚙️ Configuration (optional)

**Two ways to change config**: ① Click the bottom-right token SBI → a QuickPick panel pops up (graphical, follows VSCode's UI language zh/en/ja/de/es/fr/pt/ru); ② Edit `settings.json` directly (tables in each feature block below). Leave defaults if you don't configure anything.

### 1. Notifications (feature ⑥)

System notifications + sound when a session finishes or gets interrupted (macOS top-right dropdown / Win·Linux bottom-right toast, fires in both foreground and background).

| Option | Default | Description |
|---|---|---|
| `ccStatusDot.notify` | `true` | Master notification switch |
| `ccStatusDot.notifyWhenFocused` | `true` | Also fire when VSCode is focused; set `false` to notify only when in the background |
| `ccStatusDot.notifySound` | `"Glass"` | macOS notification sound (shared by done & interrupted; `""` for silent; options: Basso/Ping/Hero, etc.) |

### 2. Token stats & costs (feature ⑤)

The bottom-right token SBI shows the currently active session's token usage + optional $ estimate + streaming rate; workflow subagent tokens are included (won't be "invisible").

| Option | Default | Description |
|---|---|---|
| `ccStatusDot.tokenStatsWindow` | `"all"` | Time window: `all` = cumulative (whole session, never resets); `5min/10min/1h/24h/3d/7d/30d` = rolling windows (old turns slide out when they expire, looks like the count "resetting") |
| `ccStatusDot.tokenDisplayMode` | `"both"` | Display mode: `token` (tokens only) / `cost` ($ only) / `both` (both) |
| `ccStatusDot.rateDisplayMode` | `"numeric"` | Streaming rate rendering: `off` / `numeric` (e.g. `1.2k/s`) / `sparkline` (▁▂▃▄▅▆▇█ mini-chart) / `both`; switch to `off` on a crowded status bar |
| `ccStatusDot.tokenSbiVisible` | `true` | Show / hide the token SBI |
| `ccStatusDot.tokenLiveDeltaEnabled` | `true` | Update tokens with live deltas while streaming; set `false` on perf-sensitive machines |
| `ccStatusDot.showCost` | `true` | Show `$` (unknown models auto-hide; requires a matching `token-rates.json` entry) |
| `ccStatusDot.warnThresholdUsd` | `0` | Cross-threshold cost notification (`0` = disabled; positive number = USD threshold, fires once per crossing) |

> **Custom model pricing**: `~/.claude/cc-status-dot/token-rates.json` is a hot-reload pricing table (covers Anthropic's official prices by default; unmatched models like GLM auto-hide the `$`). Add a glob to display `$`:
>
> ```jsonc
> { "_default": null, "claude-sonnet-*": {"in":3,"out":15,"cacheRead":0.3,"cacheCreate5m":3.75,"cacheCreate1h":6}, "glm-*": {"in":0.5,"out":1.5} }
> ```

### 3. Favorites / Archive (features ②④)

Sidebar CC Favorites + CC Archive views (mutually exclusive) + tab ★/● markers + status-bar ★/○ buttons. Archive mirrors Favorites — no extra config.

| Option | Default | Description |
|---|---|---|
| `ccStatusDot.fav.includeInExplorerContextMenu` | `true` | Show "Add/Remove CC Favorite" in the Explorer right-click menu; set `false` if the menu gets crowded |

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
