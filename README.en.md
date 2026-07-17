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

- 🔧 **One-line install** — `npx vscode-claude-code-status-dot` auto-patches the CC extension, wires 8 hooks, and copies runtime files; idempotent, re-runnable
- 🛡️ **Persistent — survives source deletion** — runtime copies land in `~/.claude/cc-status-dot/`; deleting the project / purging the npx cache / a CC auto-update won't break the patched extension
- 🎨 **All four states** — more complete than CC's native (only blue/orange dots): idle / running / done / interrupted fully visualized
- 🔔 **Completion/interruption notifications** — suppressed in the foreground; when you've switched away you get a VSCode message + macOS system notification + sound, no need to keep watching
- ⚙️ **Stays running while workflow runs** — no false-green when background subagents/crons are in flight; `Stop` is the authoritative arbiter
- 📂 **Open Editors sync** — the CC tab in the top-left "Open Editors" view also carries the status dot (iconPath is a tab property, shared by both)
- ↩️ **Zero side effects, one-click restore** — `--revert` fully restores extension.js from `.bak`, surgically removes hooks, keeps your user data

> ⚠️ **Honest disclaimer**: this project is a **patch, not a standalone extension** — VSCode does not allow a third-party extension to modify another extension's webview tab icon, so the only viable path is patching CC's own `extension.js`. Trade-off: a CC auto-update overwrites it, so you must re-run the command.

---

## 💬 What do you get?

After installing, while Claude Code is working, **see at a glance what every session is doing**:

| Scenario | What you see / get |
|---|---|
| CC starts running (you sent a prompt) | 🟡 tab icon turns to a **static yellow dot** `#CCA700` (no animation, same as idle/done — iconPath frame-switching is inherently discrete, static is cleanest) |
| CC finishes a turn normally | 🟢 tab turns green + **if you've switched away** a system notification + sound (no bother when focused) |
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
2. If a v0.1.2 install left a leftover aggregate status bar in `webview/`, **auto-restores webview** from `.bak` (upgrade cleans it, no `--revert` needed first);
3. Asserts anchors, then **backs up** `extension.js` → `extension.js.bak` (first run only);
4. Injects the 500ms redraw IIFE (sets tab icon + done/interrupted notifications);
5. Writes **8 hook events** into `~/.claude/settings.json` (tagged `# cc-status-dot-managed`, idempotent);
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
- **switch away from VSCode** and wait for CC to finish → you get a system notification + sound

---

## 🎨 Status colors

| Color | Meaning | Trigger |
|---|---|---|
| 🟡 Yellow `#CCA700` (**static**, no animation) | Running | Prompt submitted, around tool calls (heartbeat), subagent spawn |
| 🟢 Green `#3FB950` (static) | Turn done | CC fires `Stop` (**turns gray after 5 min**) |
| 🔴 Red `#F85149` (fast flash) | Interrupted / errored | CC fires `StopFailure` (rate limit, overload, etc.) |
| ⚪ Gray `#808080` (static) | Idle | Initial / done > 5 min ago / no state file |
| 🔵 Blue (CC native) | Awaiting approval | CC's native blue dot, **not overridden** |

> As of v0.1.4 running is again a **static yellow dot** `#CCA700` (no animation, same as idle/done/error). v0.1.3 tried an 8-frame sine breathing, but `iconPath` frame-switching is inherently discrete — VSCode re-renders the icon on each assignment, so the inter-frame transition is not continuous and the eye reads it as flicker rather than a fade. Reverted to the cleanest static form. Interrupted still fast-flashes at ~500ms for alert semantics. Full state contract (events / SVG / IPC / notifications): [`docs/STATES.md`](docs/STATES.md).

---

## 🛠️ Capability details

### 🟡 Four-state tab icon dots

Each CC session's tab icon changes color by state, **shown in both the top tab bar and the top-left "Open Editors" view** (iconPath is a tab property, shared by both). The injected 500ms timer reads `~/.claude/cc-tab-status/<session_id>.json` and redraws — because CC itself only redraws the icon on sparse `rename_tab` events, which isn't smooth enough. running/idle/done are all **static dots** (as of v0.1.4 running reverted to a static yellow `#CCA700` — reason: iconPath frame-switching is discrete and non-continuous, so the breathing animation read as flicker); interrupted uses seq%2 fast-flash.

### 🔔 Completion / interruption notifications

When a session transitions to `done` or `interrupted` (only at the transition, no repeats):

- **VSCode focused**: suppressed by default (the icon turning green/red-flash is enough);
- **VSCode unfocused**: pops a VSCode message (triggers dock bounce) + a macOS system notification (notification center + sound).

Both done and interrupted play `ccStatusDot.notifySound` (default `Glass`). The first system notification triggers a one-time macOS prompt "Script Editor wants to send notifications" — allow it.

### ⚙️ Stays running while workflow runs

After the main agent replies "started", `Stop` **no longer falsely writes done (no false green)**: on `Stop`/`SubagentStop` it first reads the hook payload's `background_tasks[]` (CC v2.1.145+ authoritative, covers workflow/subagent/teammate), falling back to an `activeSubagents` count + the `SubagentStart` early signal. The reader never reads the count; state stays four-state.

### 📂 Open Editors sync

The CC tab in VSCode's top-left "Open Editors" view **also carries the status dot** — because `iconPath` is a tab-level property shared by the top tab bar and Open Editors, no extra injection needed.

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

Old-version users can just re-run `npx vscode-claude-code-status-dot` — both staleness axes are handled automatically, **no need to `--revert` first**:

1. **IIFE logic version stale** — the injected block carries a version stamp `cc-status-dot-injected:v0.1.4`. If the patcher detects a mismatched stamp (e.g. v0.1.3's 8-frame breathing IIFE vs. v0.1.4's static IIFE), it restores the original from `extension.js.bak` and re-injects the current IIFE.
2. **Baked path stale** — old (v0.1 git-clone) installs baked the project source dir; the patcher rewrites the `RES` literal inside the IIFE and the hook command in settings.json in place, pointing at `INSTALL_DIR`.

</details>

<details>
<summary>📖 Why a patch (not a standalone extension)</summary>

A VSCode `WebviewPanel` tab icon (`iconPath`) is set **exclusively by the extension that created that panel** — there is no public API for a third-party extension to modify it. CC's session tab is a WebviewPanel created by the CC extension itself, so its icon can only be assigned from inside CC's `extension.js`. We exhausted the alternatives (standalone extension, proposed APIs, webview interception, etc.) — none can reach the icon. The only viable path is a patch. Trade-off: a CC auto-update overwrites it, so you must re-run the patch.

</details>

<details>
<summary>📖 Command reference</summary>

| Command | Effect |
|---|---|
| `npx vscode-claude-code-status-dot` | Install (patch extension.js + wire hooks, idempotent; auto-cleans any legacy v0.1.2 webview bar) |
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
  "ccStatusDot.notifyWhenFocused": false,
  "ccStatusDot.notifySound": "Glass"
}
```

| Option | Default | Description |
|---|---|---|
| `ccStatusDot.notify` | `true` | Master notification switch |
| `ccStatusDot.notifyWhenFocused` | `false` | Also pop a VSCode message when focused (keep false if the icon is enough) |
| `ccStatusDot.notifySound` | `"Glass"` | macOS notification sound (used for both done & interrupted; `""` for silent; options: Basso/Ping/Hero, etc.) |

---

## ❓ FAQ

**After a CC update the status dot stopped lighting up?**
A CC auto-update replaces the entire extension dir, overwriting patched files with the originals. Re-run `npx vscode-claude-code-status-dot` (the SVG/hook runtime copies live in `~/.claude/cc-status-dot/`, which a CC update doesn't touch; deleting the source project doesn't matter either).

**Just installed and the icon didn't change?**
First run `Developer: Reload Window`. If it still doesn't work, run `npx vscode-claude-code-status-dot --status`: `patched: no` → re-run; `baked RES ... (STALE)` → re-run to rewrite in place; `hooks wired: no` → re-run; `missing SVGs` → re-run to refill.

**Upgrading from an old (git clone) install?**
Just re-run `npx vscode-claude-code-status-dot` — the patcher detects the stale baked path and rewrites it in place; no need to `--revert` first.

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

---

## 🏗️ How it works + docs

**Patches CC's `extension.js` (injects a 500ms IIFE: reads state files to set tab icons, with running as a static yellow dot + done/interrupted notifications) + 8 CC hooks (write state to `~/.claude/cc-tab-status/`).** Full docs:

- [`docs/STATES.md`](docs/STATES.md) — **state contract (single source of truth)**: four states / event mapping / IPC / notifications
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md) — icon injection rationale (anchors / IIFE / SVG wiring)
- [`docs/WEBVIEW-injection.md`](docs/WEBVIEW-injection.md) — status bar injection rationale (**deprecated in v0.1.3**, kept as a historical design record)
- [`docs/USAGE.md`](docs/USAGE.md) — usage guide (install / troubleshooting / revert)

> This project modifies CC's `extension.js` (backed up; `--revert` fully restores) and writes to `~/.claude/settings.json` (backed up on first run). The hook script is designed to **never block or break CC** — any error exits silently with code 0.

---

## 💝 Support the author

If vscode-claude-code-status-dot helps you, consider buying the author a coffee ☕

<div align="center">

WeChat | Alipay
:-: | :-:
<img src="doc/support-wechat.jpg" height="200" alt="WeChat"> | <img src="doc/support-alipay.jpg" height="200" alt="Alipay">


</div>

Or ⭐ Star, open an Issue / PR — all of it supports the author.

## License

[MIT](LICENSE) (c) wangdong
