<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#license)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-how-it-works--docs)

**Patches Claude Code's VSCode extension so every session's tab icon becomes a four-state status dot**

🟡 running breathes · 🟢 done · 🔴 interrupted flashes · ⚪ idle — plus completion/interruption notifications and an aggregate status bar

**English** | [简体中文](README.md)

</div>

---

## ✨ Features

- 🔧 **One-line install** — `npx vscode-claude-code-status-dot` auto-patches the CC extension, wires 8 hooks, and copies runtime files; idempotent, re-runnable
- 🛡️ **Persistent — survives source deletion** — runtime copies land in `~/.claude/cc-status-dot/`; deleting the project / purging the npx cache / a CC auto-update won't break the patched extension
- 🎨 **All four states** — more complete than CC's native (only blue/orange dots): idle / running / done / interrupted fully visualized
- 🔔 **Completion/interruption notifications** — suppressed in the foreground; when you've switched away you get a VSCode message + macOS system notification + sound, no need to keep watching
- 🧱 **Aggregate status bar** — one dot per session at the bottom-right of the CC panel, click to jump to that tab, current session outlined in white
- ⚙️ **Stays running while workflow runs** — no false-green when background subagents/crons are in flight; `Stop` is the authoritative arbiter
- 📂 **Open Editors sync** — the CC tab in the top-left "Open Editors" view also carries the status dot (iconPath is a tab property, shared by both)
- ↩️ **Zero side effects, one-click restore** — `--revert` fully restores extension.js + webview from `.bak`, surgically removes hooks, keeps your user data

> ⚠️ **Honest disclaimer**: this project is a **patch, not a standalone extension** — VSCode does not allow a third-party extension to modify another extension's webview tab icon, so the only viable path is patching CC's own `extension.js`. Trade-off: a CC auto-update overwrites it, so you must re-run the command.

---

## 💬 What do you get?

After installing, while Claude Code is working, **see at a glance what every session is doing**:

| Scenario | What you see / get |
|---|---|
| CC starts running (you sent a prompt) | 🟡 tab icon breathes yellow + the aggregate bar pops a running dot at the bottom-right |
| CC finishes a turn normally | 🟢 tab turns green + **if you've switched away** a system notification + sound (no bother when focused) |
| CC is rate-limited / overloaded | 🔴 tab red fast-flash + notification (text carries the cause like `rate limit reached`) |
| Multiple CC sessions open | The aggregate bar shows one dot per session, **click a dot to jump to that tab**, current session outlined white |
| workflow / background subagent still running | The main session tab **stays breathing yellow** (no false green); `Stop` authoritatively avoids a false done |
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
2. Asserts anchors, then **backs up** `extension.js` → `extension.js.bak` (first run only);
3. Injects the 500ms redraw IIFE (sets tab icon + aggregates + notifications) + the webview status bar;
4. Writes **8 hook events** into `~/.claude/settings.json` (tagged `# cc-status-dot-managed`, idempotent);
5. Copies runtime files (7 SVGs + the hook script) to `~/.claude/cc-status-dot/` (`INSTALL_DIR`).

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
- the tab icon turns 🟡 breathing yellow → on completion → 🟢 green
- **switch away from VSCode** and wait for CC to finish → you get a system notification + sound
- the aggregate bar appears at the bottom-right; click a dot to switch tabs

---

## 🎨 Status colors

| Color | Meaning | Trigger |
|---|---|---|
| 🟡 Yellow `#CCA700`↔`#FFD60A` (breathing) | Running | Prompt submitted, around tool calls (heartbeat), subagent spawn |
| 🟢 Green `#3FB950` (static) | Turn done | CC fires `Stop` (**turns gray after 5 min**) |
| 🔴 Red `#F85149` (fast flash) | Interrupted / errored | CC fires `StopFailure` (rate limit, overload, etc.) |
| ⚪ Gray `#808080` (static) | Idle | Initial / done > 5 min ago / no state file |
| 🔵 Blue (CC native) | Awaiting approval | CC's native blue dot, **not overridden** |

> running is a 4-frame triangular wave (`#CCA700`↔`#DDB703`↔`#EEC607`↔`#FFD60A`), 6 steps per cycle, 500ms/step = **3s breath**. Full state contract (events / SVG / IPC / notifications): [`docs/STATES.md`](docs/STATES.md).

---

## 🛠️ Capability details

### 🟡 Four-state tab icon dots

Each CC session's tab icon changes color by state, **shown in both the top tab bar and the top-left "Open Editors" view** (iconPath is a tab property, shared by both). The injected 500ms timer reads `~/.claude/cc-tab-status/<session_id>.json` and redraws — because CC itself only redraws the icon on sparse `rename_tab` events, which isn't smooth enough.

### 🔔 Completion / interruption notifications

When a session transitions to `done` or `interrupted` (only at the transition, no repeats):

- **VSCode focused**: suppressed by default (the icon turning green/red-flash is enough);
- **VSCode unfocused**: pops a VSCode message (triggers dock bounce) + a macOS system notification (notification center + sound).

Both done and interrupted play `ccStatusDot.notifySound` (default `Glass`). The first system notification triggers a one-time macOS prompt "Script Editor wants to send notifications" — allow it.

### 🧱 Aggregate status bar (bottom-right overlay)

A status bar is injected at the bottom-right of the CC panel (vanilla DOM `position:fixed`, **outside the React tree** — zero render interference): one small dot per session, same four-state colors, **click to jump to that tab** (existing panels reveal, no new tab), current session outlined in white. Auto-hides after 2s with no data (compatible with sidebar webviews that receive no bridge).

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

Old-version users can just re-run `npx vscode-claude-code-status-dot` — the patcher detects the stale baked path and **rewrites it in place** (both the IIFE's SVG path and the hook command); no need to `--revert` first.

</details>

<details>
<summary>📖 Why a patch (not a standalone extension)</summary>

A VSCode `WebviewPanel` tab icon (`iconPath`) is set **exclusively by the extension that created that panel** — there is no public API for a third-party extension to modify it. CC's session tab is a WebviewPanel created by the CC extension itself, so its icon can only be assigned from inside CC's `extension.js`. We exhausted the alternatives (standalone extension, proposed APIs, webview interception, etc.) — none can reach the icon. The only viable path is a patch. Trade-off: a CC auto-update overwrites it, so you must re-run the patch.

</details>

<details>
<summary>📖 Command reference</summary>

| Command | Effect |
|---|---|
| `npx vscode-claude-code-status-dot` | Install (patch extension.js + webview + wire hooks, idempotent) |
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

**The status bar overlaps the input send button?**
Tune the CSS `bottom` offset (see [`docs/WEBVIEW-injection.md` §5.2](docs/WEBVIEW-injection.md)).

**`npx` can't connect?**
Fall back to a global install:
```bash
npm i -g vscode-claude-code-status-dot
vscode-claude-code-status-dot        # run the command directly after install
```

---

## ⚠️ Known limitations

- **No hook for manual Esc interrupt**: CC doesn't fire Stop/StopFailure ([#45289](https://github.com/anthropics/claude-code/issues/45289)/[#9516](https://github.com/anthropics/claude-code/issues/9516)), so the state stays on running; corrected naturally by the next prompt/Stop.
- **CC auto-update overwrite**: patched `extension.js`/webview overwritten by originals → silent failure; re-run the command to restore.
- **Minified anchor fragility**: the patch depends on two exact strings in CC's code; on version drift the patcher reports "Anchor mismatch" and refuses to write (the extension is not damaged).
- **No notification when VSCode is fully closed**: the IIFE runs in the extension host process; if VSCode is closed it doesn't run → no notification.
- **System notification click doesn't jump to tab**: osascript has no click callback; the notification only reminds — locate the session via the tab green/red dot back in VSCode.

---

## 🏗️ How it works + docs

**Patches CC's `extension.js` (injects a 500ms IIFE: reads state files to set tab icons + aggregates via postMessage + click-to-switch) + webview `index.js`/`index.css` (the status bar) + 8 CC hooks (write state to `~/.claude/cc-tab-status/`).** Full docs:

- [`docs/STATES.md`](docs/STATES.md) — **state contract (single source of truth)**: four states / event mapping / IPC / notifications
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md) — icon injection rationale (anchors / IIFE / SVG wiring)
- [`docs/WEBVIEW-injection.md`](docs/WEBVIEW-injection.md) — status bar injection rationale
- [`docs/USAGE.md`](docs/USAGE.md) — usage guide (install / troubleshooting / revert)

> This project modifies CC's `extension.js` + `webview/index.js` + `webview/index.css` (all backed up; `--revert` fully restores), and writes to `~/.claude/settings.json` (backed up on first run). The hook script is designed to **never block or break CC** — any error exits silently with code 0.

---

## License

[MIT](LICENSE) (c) wangdong
