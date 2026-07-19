<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#license)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-how-it-works--docs)

**See every Claude Code session's status at a glance — without cycling through tabs.**

🟡 running · 🟢 done · 🔴 interrupted flashes · ⚪ idle — plus a one-glance bottom bar, system notifications, and self-healing after Claude Code updates.

[简体中文](README.md) | **English** | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

## Stop tab-switching. Start seeing.

When you've got several Claude Code sessions going in parallel — one coding, one reviewing, one quietly waiting on permission — it's easy to lose track of which is done, which is still working, and which is stalled on you.

**vscode-claude-code-status-dot lights up every CC session's tab icon, adds a single-glance aggregate at the bottom of the window, and pings you with a system notification when a turn ends.** You always know the state of every session without leaving what you're doing.

<div align="center">

<img src="docs/images/status-dots.png" width="640" alt="Four-state status dots on every CC session">

*Every CC session's tab — in both the top tab bar and the left-side "Open Editors" view — shows its live state. 🟡 yellow = running, 🟢 green = done, 🔴 red = interrupted, ⚪ gray = idle.*

<br>

<img src="docs/images/completion-notification.png" width="640" alt="Completion notification">

*A native macOS notification drops the moment a turn ends — foreground or background, with sound, no buttons, auto-dismisses.*

<!-- SCREENSHOT-TODO: bottom status bar 4-light aggregate is a new visual not yet captured. Suggested shot: VSCode window with 2+ CC sessions running, bottom-left status bar showing the 4-light row (🟢done · 🟡running · 🔵pending · 🔴interrupted + per-light counts). Drop the file at docs/images/bottom-bar-aggregate.png and reference it here. -->

</div>

---

## 🚀 Get running in 30 seconds

```bash
npx vscode-claude-code-status-dot
```

Then **reload the window** — `Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → `Developer: Reload Window` — send any prompt to Claude Code, and watch the tab turn 🟡 yellow → 🟢 green. That's it.

> **Prerequisites:** Node.js 18+, and the Claude Code VSCode extension installed.

Want it back to stock? `npx vscode-claude-code-status-dot --revert`.

---

## 💬 What you get

### 1. Per-session status dots on every tab

Each Claude Code session's tab icon — **in both the top tab bar and the top-left "Open Editors" view** — shows its live state:

- 🟡 **Yellow** while CC is working
- 🟢 **Green** when the turn finished cleanly
- 🔴 **Red, fast-flashing** when interrupted or rate-limited
- ⚪ **Gray** when idle

No more opening each tab just to check "is this one done?"

### 2. One-glance bottom bar with every session at once

The bottom of the window carries a single block with four lights, each followed by a count:

**🟢 done · 🟡 running · 🔵 pending · 🔴 interrupted**

Three sessions working and two waiting on you? The bar reads `🟡3 🔵2` and you instantly know two sessions need your input. The four slots are fixed in place — counts changing never shifts the layout.

### 3. Notifications when a turn ends

When a session transitions to done or interrupted (only at the transition — no repeats):

- **macOS** — a native system notification drops from the top-right corner, with sound, no buttons, auto-dismissing. Fires whether VSCode is in the foreground or background.
- **Windows / Linux** — falls back to a VSCode toast in the bottom-right corner.

You can mute while focused, go silent, or change the sound — see [Configuration](#-configuration-optional).

### 4. Pending state for "your move" moments

The blue 🔵 light catches anything where Claude Code is waiting on you — a permission request, a question, or an input elicitation. The moment it happens, the bottom bar's blue count ticks up, so nothing stalls silently.

When CC pops its native authorization prompt, the reader **gracefully yields** the icon so CC's own blue dot shows — we never override it.

### 5. Self-healing after Claude Code updates

Claude Code auto-updates, and each update used to wipe this patch. **Since v0.2.0**, a companion extension watches for that: the next time VSCode starts, it detects the missing patch, silently re-applies it, and prompts a one-click reload. You usually don't have to do anything.

### 6. It just stays installed

The runtime lives in `~/.claude/cc-status-dot/` — outside CC's extension directory. Deleting this project, purging the npx cache, or a CC auto-update won't break the dots.

### 7. Safe and fully reversible

Every patch is preceded by a syntax check (we never ship a broken `extension.js`), written atomically, and tagged with `INJECT_VERSION` so stale injections get refreshed automatically. One command — `--revert` — fully restores the original.

> ⚠️ **Honest disclaimer**: this project is a **patch, not a standalone extension** — VSCode has no API for a third-party extension to modify another extension's webview tab icon, so the only viable path is patching CC's own `extension.js`. The trade-off (CC auto-update overwriting it) is exactly what the v0.2.0 companion extension auto-recovers from.

---

## 🎨 Status colors

| Color | Meaning | Trigger |
|---|---|---|
| 🟡 Yellow `#CCA700` (**static**, no animation) | Running | Prompt submitted, around tool calls (heartbeat), subagent spawn |
| 🟢 Green `#3FB950` (static) | Turn done | CC fires `Stop` (**turns gray after 5 min**) |
| 🔴 Red `#F85149` (fast flash) | Interrupted / errored | CC fires `StopFailure` (rate limit, overload, etc.) |
| ⚪ Gray `#808080` (static) | Idle | Initial / done > 5 min ago / no state file |
| 🔵 Blue (CC native) | Awaiting approval | CC's native blue dot, **not overridden** |

> Running is a static yellow dot (no animation); interrupted flashes red as an alert. Full state contract (events / SVG / IPC / notifications): [`docs/STATES.md`](docs/STATES.md).

---

## 🛠️ Capability details

### 📊 Bottom status bar 4-light aggregate

One `StatusBarItem` on the bottom status bar (left half, near the center) renders four emoji lights separated by small spaces: 🟢 done · 🟡 running · 🔵 pending · 🔴 interrupted. Each light is a `<ball><count>` pair; counts cap at `0/1/2/3/N` (`N` for 4+). When a count is `0`, both the ball (gray ⚪) and the digit go dim; when non-zero, the ball takes its color and the digit lights up. 🔵 = awaiting user input (permission / question / elicit, fed by the Notification hook). VSCode's status bar applies `tabular-nums`, so digits 0–9 are equal-width regardless of font — counts changing never shifts the layout.

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

| Command | Effect |
|---|---|
| `npx vscode-claude-code-status-dot` | Install (patch extension.js + wire hooks, idempotent; auto-cleans leftover files from old versions) |
| `npx vscode-claude-code-status-dot --revert` | Restore (from `.bak` + remove hooks + delete INSTALL_DIR, keeps user data) |
| `npx vscode-claude-code-status-dot --status` | Dry-run report, changes nothing |

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

Add to VSCode's `settings.json` (skip to keep defaults):

```json
{
  "ccStatusDot.notify": true,
  "ccStatusDot.notifyWhenFocused": true,
  "ccStatusDot.notifySound": "Glass"
}
```

| Option | Default | Description |
|---|---|---|
| `ccStatusDot.notify` | `true` | Master notification switch |
| `ccStatusDot.notifyWhenFocused` | `true` | Also fire the notification when VSCode is focused (notifications fire in both foreground and background by default; set `false` to mute while focused) |
| `ccStatusDot.notifySound` | `"Glass"` | macOS notification sound (used for both done & interrupted; `""` for silent; options: Basso/Ping/Hero, etc.) |

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
- **SBI priority namespace not owned**: the bottom status bar item sits at a single priority (`-9996`). The VSCode StatusBarItem API has no extension-level namespace/ownership — another extension declaring the same priority could push our item to a corner. Because the whole 4-light row is one SBI, an external insertion can only land on the side, never *between* the four lights. Rare in practice; documented honestly in STATES.md §7.5.
- **Emoji font-stack dependency**: the bottom status bar dots are emoji glyphs (🟢🟡🔵🔴⚪) that depend on the system emoji font stack — macOS (Apple Color Emoji) / Windows 10+ (Segoe UI Emoji) / mainstream Linux (Noto Color Emoji) render them in color; Win7 / some headless Linux / emoji-font-less remote SSH environments may render them as monochrome glyphs or tofu boxes. A deliberate tradeoff (user aesthetic preference > cross-platform uniformity).

---

## 🏗️ How it works + docs

**Patches CC's extension.js (injects a timer to set tab icons) + CC hooks write state + completion/interruption notifications.** Full docs:

- [`docs/STATES.md`](docs/STATES.md) — **state contract (single source of truth)**: four states / event mapping / IPC / notifications
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md) — icon injection rationale (anchors / IIFE / SVG wiring)
- [`docs/USAGE.md`](docs/USAGE.md) — usage guide (install / troubleshooting / revert)

> This project modifies CC's `extension.js` (backed up; `--revert` fully restores) and writes to `~/.claude/settings.json` (backed up on first run). The hook script **never blocks CC** — any error exits silently.

---

## 💝 Support the author

If vscode-claude-code-status-dot helps you, consider buying the author a coffee ☕

<div align="center">

WeChat | Alipay
:-: | :-:
<img src="docs/images/support-wechat.jpg" height="200" alt="WeChat"> | <img src="docs/images/support-alipay.jpg" height="200" alt="Alipay">


</div>

Or ⭐ Star, open an Issue / PR — all of it supports the author.

## License

[MIT](LICENSE) (c) wangdong
