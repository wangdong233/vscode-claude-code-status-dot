<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#license)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-how-it-works--docs)

**Patches Claude Code's VSCode extension so every session's tab icon becomes a four-state status dot**

🟡 running · 🟢 done · 🔴 interrupted flashes · ⚪ idle — plus completion/interruption notifications

[简体中文](README.md) | **English** | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

## ✨ Features

- 🔧 **One-line install** — `npx vscode-claude-code-status-dot` auto-patches the CC extension, wires 9 hooks, and copies runtime files; idempotent, re-runnable
- 🛡️ **Persistent — survives source deletion** — runtime copies land in `~/.claude/cc-status-dot/`; deleting the project / purging the npx cache / a CC auto-update won't break the patched extension
- 🎨 **All four states** — more complete than CC's native (only blue/orange dots): idle / running / done / interrupted fully visualized
- 🔔 **Completion/interruption notifications** — on macOS a native system notification drops down from the top-right corner (with sound, buttonless, auto-dismisses); on Windows/Linux it falls back to a VSCode toast — fires whether VSCode is in the foreground or background by default, no need to keep watching
- ⚙️ **Stays running while workflow runs** — no false-green when background subagents/crons are in flight; `Stop` is the authoritative arbiter
- 📂 **Open Editors sync** — the CC tab in the top-left "Open Editors" view also carries the status dot
- 📊 **Bottom SBI 4 emoji balls (ball+digit, position-fixed)** — the status bar's left side (`StatusBarAlignment.Left` + 4 slots at priority `-9996..-9999`, near the visible center) renders 4 **emoji balls with a digit beside each** side-by-side (v0.1.16 restores the v0.1.14 emoji-ball style, keeping the v0.1.15 4-SBI independent structure for position stability): 🟢done / 🟡running / 🔵pending / 🔴interrupted. Each slot's text is `<ball><digit>` (the ball carries its own color — **the v0.1.15 themed background block + white text is REMOVED**); counts cap at 0/1/2/3/N (>=4 shows N); count>0 → ball lit (🟢/🟡/🔵/🔴 pre-colored + digit right beside it), count=0 → gray ball ⚪ + "0" (placeholder matches non-zero width, **position never shifts** — this is the core advantage of 4 SBI over v0.1.14 single SBI: v0.1.14's `🟢N 🟡N 🔵N 🔴N` join lurched the whole row left/right as digit widths changed; 4 SBI gives each light its own fixed `<ball><1-digit>` slot that never moves). 🔵 = awaiting user input (permission/question/elicit, fed by the Notification hook case). Done older than 5 min counts as idle (not green). v0.1.16 uses **4 independent runtime StatusBarItem instances + emoji balls** (no CC package.json patch, no ThemeColor block, the IIFE mutates each slot's text directly every 500ms) — the emoji ball carries its own color so the render path is simpler than v0.1.15 (no backgroundColor, no color cache, no lit/dim flip).
- ↩️ **Zero side effects, one-click restore** — `--revert` fully restores extension.js from `.bak`, surgically removes hooks, keeps your user data

> ⚠️ **Honest disclaimer**: this project is a **patch, not a standalone extension** — VSCode does not allow a third-party extension to modify another extension's webview tab icon, so the only viable path is patching CC's own `extension.js`. Trade-off: a CC auto-update overwrites it, so you must re-run the command.

---

## 🖼️ Preview

<div align="center">

<img src="docs/images/status-dots.png" width="640" alt="Four-state status dots">

**Four-state status dots on every CC session** — shown in both the top tab bar and the left-side "Open Editors" view: 🟡 yellow = running, 🟢 green = done, 🔴 red = interrupted, ⚪ gray = idle.

<br>

<img src="docs/images/completion-notification.png" width="640" alt="Completion notification">

**Session-completion notification** — a native macOS system notification (with sound) drops down the moment a turn finishes.

</div>

---

## 💬 What do you get?

After installing, while Claude Code is working, **see at a glance what every session is doing**:

| Scenario | What you see / get |
|---|---|
| CC starts running (you sent a prompt) | 🟡 tab icon turns to a **static yellow dot** `#CCA700` (no animation) |
| CC finishes a turn normally | 🟢 tab turns green + a system notification + sound (fires whether VSCode is focused or in the background) |
| CC is rate-limited / overloaded | 🔴 tab red fast-flash + notification (text carries the cause like `rate limit reached`) |
| workflow / background subagent still running | The main session tab **stays yellow** (no false green); `Stop` authoritatively avoids a false done |
| Looking at the "Open Editors" view (top-left) | The CC tab here **also carries the status dot**, fully in sync with the top tab bar |
| CC pops a permission request | 🔵 blue dot (**CC native, not overridden by this project**) |

> **All of this works out of the box — configure nothing.** Only touch config to mute notifications or change the sound.

---

## 🚀 Quick start

### ① Check prerequisites

- **Node.js 18+**
- **Claude Code's VSCode extension installed** (i.e. you can open the CC chat panel in VSCode)

### ② One-line install

```bash
npx vscode-claude-code-status-dot
```

This single line automatically:
1. Finds `anthropic.claude-code-*` under `~/.vscode/extensions` (and insiders / cursor / vscodium), picks the highest version;
2. Auto-cleans leftover files from old versions (if any);
3. **Backs up** `extension.js` → `extension.js.bak` (first run only);
4. Injects a timer (sets tab icon + done/interrupted notifications);
5. Writes **9 hook events** into `~/.claude/settings.json` (tagged `# cc-status-dot-managed`, idempotent);
6. Copies runtime files (4 SVGs = idle + running + done + error, plus the hook script) to `~/.claude/cc-status-dot/` (`INSTALL_DIR`).

> **Or from source (dev)**:
> ```bash
> git clone https://github.com/wangdong233/vscode-claude-code-status-dot.git
> cd vscode-claude-code-status-dot
> npx tsx patch.ts
> ```
> Both paths are equivalent and idempotent. The IIFE and the hook both reference the `INSTALL_DIR` absolute path — **deleting the source project or purging the npx cache does not affect the patched extension**.

### ③ Reload Window

`Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → type `Developer: Reload Window`.

### ④ Send a prompt and watch

Send a prompt in CC:
- the tab icon turns to a 🟡 **static yellow dot** → on completion → 🟢 green
- a system notification + sound fires when the turn finishes (whether VSCode is focused or in the background)

---

## 🎨 Status colors

| Color | Meaning | Trigger |
|---|---|---|
| 🟡 Yellow `#CCA700` (**static**, no animation) | Running | Prompt submitted, around tool calls (heartbeat), subagent spawn |
| 🟢 Green `#3FB950` (static) | Turn done | CC fires `Stop` (**turns gray after 5 min**) |
| 🔴 Red `#F85149` (fast flash) | Interrupted / errored | CC fires `StopFailure` (rate limit, overload, etc.) |
| ⚪ Gray `#808080` (static) | Idle | Initial / done > 5 min ago / no state file |
| 🔵 Blue (CC native) | Awaiting approval | CC's native blue dot, **not overridden** |

> running is a static yellow dot (no animation); interrupted flashes red as an alert. Full state contract (events / SVG / IPC / notifications): [`docs/STATES.md`](docs/STATES.md).

---

## 🛠️ Capability details

### 🟡 Four-state tab icon dots

Each CC session's tab icon changes color by state, **shown in both the top tab bar and the top-left "Open Editors" view**. running/idle/done are static dots; interrupted fast-flashes red.

### 🔔 Completion / interruption notifications

When a session transitions to `done` or `interrupted` (only at the transition, no repeats):

- **macOS**: a native system notification drops down from the top-right corner of the screen, with sound, **no buttons**, auto-dismisses after a few seconds — **fires whether VSCode is in the foreground or background** (`notifyWhenFocused` defaults to `true`).
- **Windows / Linux** (no `osascript`): falls back to VSCode's built-in toast (bottom-right, also buttonless and auto-dismissing).

Both done and interrupted play `ccStatusDot.notifySound` (default `Glass`). The first system notification triggers a one-time macOS prompt "Script Editor wants to send notifications" — allow it.

### ⚙️ Stays running while workflow runs

While a workflow / subagent runs in the background, the main session stays yellow (no false green) and never falsely reports done.

### 📂 Open Editors sync

The CC tab in VSCode's top-left "Open Editors" view **also carries the status dot**, fully in sync with the top tab bar.

<details>
<summary>📖 Persistence mechanism (why deleting the source is safe)</summary>

The SVG path referenced by the reader (injected IIFE) and the hook command wired in settings.json both point at the `INSTALL_DIR` (`~/.claude/cc-status-dot/`) **absolute path**, not the project source. At install time the patcher idempotently copies a set from the project source (`resources/` + `hooks/`) there. So even if you:
- delete the project source directory
- purge the npx cache
- let CC auto-update (which only wipes the extension dir, not `~/.claude/`)

the patched extension keeps rendering normally. You only need to **re-run** `npx vscode-claude-code-status-dot` once after a CC update to restore the patch.

</details>

<details>
<summary>📖 Upgrade path (for old git-clone installs)</summary>

Old-version users can just re-run `npx vscode-claude-code-status-dot` — the patcher detects the old injection logic → auto-restores the original → re-injects the new version (**no need to `--revert` first**).

</details>

<details>
<summary>📖 Why a patch (not a standalone extension)</summary>

A VSCode `WebviewPanel` tab icon (`iconPath`) is set **exclusively by the extension that created that panel** — there is no public API for a third-party extension to modify it. CC's session tab is a WebviewPanel created by the CC extension itself, so its icon can only be assigned from inside CC's `extension.js`. We exhausted the alternatives (standalone extension, proposed APIs, webview interception, etc.) — none can reach the icon. The only viable path is a patch. Trade-off: a CC auto-update overwrites it, so you must re-run the patch.

</details>

<details>
<summary>📖 Command reference</summary>

| Command | Effect |
|---|---|
| `npx vscode-claude-code-status-dot` | Install (patch extension.js + wire hooks, idempotent; auto-cleans leftover files from old versions) |
| `npx vscode-claude-code-status-dot --revert` | Restore (from `.bak` + remove hooks + delete INSTALL_DIR, keeps user data) |
| `npx vscode-claude-code-status-dot --status` | Dry-run report, changes nothing |

For dev, swap the command for `npx tsx patch.ts` (same flags).

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
A CC auto-update replaces the entire extension dir, overwriting patched files with the originals. Re-run `npx vscode-claude-code-status-dot` (the SVG/hook runtime copies live in `~/.claude/cc-status-dot/`, which a CC update doesn't touch; deleting the source project doesn't matter either).

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
- **CC auto-update overwrite**: patched `extension.js` overwritten by the original → silent failure; re-run the command to restore.
- **Minified anchor fragility**: the patch depends on two exact strings in CC's code; on version drift the patcher reports "Anchor mismatch" and refuses to write (the extension is not damaged).
- **No notification when VSCode is fully closed**: the IIFE runs in the extension host process; if VSCode is closed it doesn't run → no notification.
- **System notification click doesn't jump to tab**: osascript has no click callback; the notification only reminds — locate the session via the tab green/red dot back in VSCode.
- **SBI priority namespace not owned** (v0.1.16): the bottom 4 dots occupy the `StatusBarAlignment.Left` priority range `-9996..-9999` (4 adjacent units). The VSCode StatusBarItem API has no extension-level namespace/ownership — another extension declaring the same priority range could insert a separator between the 4 slots, visually splitting done/running/pending/interrupted. (This is the core architectural tradeoff of 4-SBI vs single-SBI: it cures "row lurch on digit-width change" but introduces a new failure mode "row split by an outsider", and the collision window is 4× wider. Rare in practice; documented honestly in STATES.md §7.5.)
- **Emoji font-stack dependency** (v0.1.16): the bottom SBI dots are emoji glyphs (🟢🟡🔵🔴⚪) that depend on the system emoji font stack — macOS (Apple Color Emoji) / Windows 10+ (Segoe UI Emoji) / mainstream Linux (Noto Color Emoji) render them in color; Win7 / some headless Linux / emoji-font-less remote SSH environments may render them as monochrome glyphs or tofu boxes. The v0.1.15 `ThemeColor` path was cross-platform-stable; v0.1.16's return to emoji balls is a deliberate tradeoff (user aesthetic preference > cross-platform uniformity).

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
