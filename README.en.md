# vscode-claude-code-status-dot

Adds **session status visualization** to Claude Code's VSCode extension: four-state colored dots on the tab icon + completion/interruption notifications + an aggregate status bar at the bottom-right (click to switch sessions).

> Implemented as a **patch**, not a standalone extension — VSCode does not allow a third-party extension to modify another extension's webview tab icon (see [Why a patch?](#why-a-patch)).

![screenshot](docs/screenshot.png)
> Screenshot pending (`docs/screenshot.png`).

---

## What it gives you

1. **Four-state tab icon dots**: each Claude Code session's tab icon changes color by state — 🟡 running (breathing) / 🟢 done / 🔴 interrupted (fast flash) / ⚪ idle. **Shown in both the top tab bar and the "Open Editors" view** (iconPath is a tab property, shared by both). More complete than CC's native (only blue/orange dots).
2. **Completion / interruption notifications**: when a session completes or is rate-limited, the foreground is suppressed; **when you've switched away, a system notification + sound fires** — no need to keep watching.
3. **Aggregate status bar**: a floating bar at the bottom-right of the CC panel, one dot per session (same four-state colors), **click to switch to that session's tab**.

## Status colors

| Color | Meaning | Trigger |
|---|---|---|
| 🟡 Yellow (breathing) | Running | Prompt submitted, around tool calls (heartbeat) |
| 🟢 Green (static) | Turn done | CC fires `Stop` (turns gray after 5 min) |
| 🔴 Red (fast flash) | Interrupted / errored | CC fires `StopFailure` (rate limit, overload, etc.) |
| ⚪ Gray (static) | Idle | Initial / done > 5 min ago / no state file |
| 🔵 Blue (CC native) | Awaiting approval | CC's native blue dot, **not overridden** |

Full state contract (events / SVG / IPC / notifications): [`docs/STATES.md`](docs/STATES.md).

## Quick start

**Prerequisites**: Node.js 18+; Claude Code's VSCode extension installed.

**Recommended (one-liner after publish — no need to clone)**:

```bash
npx vscode-claude-code-status-dot   # patch + auto-wire hooks + verify (idempotent)
```

**Or from source (dev)**:

```bash
git clone <this-repo> vscode-claude-code-status-dot
cd vscode-claude-code-status-dot
npx tsx patch.ts
```

Both are equivalent and idempotent. They copy the runtime files (7 SVGs + the hook script) into `~/.claude/cc-status-dot/` (`INSTALL_DIR`); the injected IIFE and the wired hook both reference that absolute path — **deleting the source project or purging the npx cache does not affect the patched extension**.

Then **Reload Window**: `Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Win) → `Developer: Reload Window`.

Submit a prompt, watch the tab icon breathe yellow; on completion → green + (if you've switched away) a system notification; the aggregate bar appears at the bottom-right.

## Commands

| Command | Effect |
|---|---|
| `npx vscode-claude-code-status-dot` | Install (patch `extension.js` + `webview` + wire hooks, idempotent) |
| `npx vscode-claude-code-status-dot --revert` | Restore (`extension.js` + `webview` from `.bak`, remove hooks + runtime copy) |
| `npx vscode-claude-code-status-dot --status` | Dry-run report, changes nothing |

> For dev, swap the command for `npx tsx patch.ts` (same flags).

## Notification config (optional)

Add to VSCode's `settings.json`:

```json
{
  "ccStatusDot.notify": true,
  "ccStatusDot.notifyWhenFocused": false,
  "ccStatusDot.notifySound": "Glass"
}
```

- `notify`: master switch (default `true`)
- `notifyWhenFocused`: also show a VSCode message when focused (default `false`, icon is enough)
- `notifySound`: macOS notification sound (default `"Glass"`; `""` for silent)

> The first system notification triggers a one-time macOS prompt "Script Editor wants to send notifications" — allow it.

## How it works

**Patches CC's `extension.js` + `webview/index.js` + `webview/index.css`, injecting:**

- **`extension.js`**: a 500ms timer (IIFE) — reads state files to set tab icons + aggregates all session states and pushes them to the webview + listens for "switch tab" clicks.
- **`webview`**: the bottom-right status bar (vanilla DOM, attached to body, **outside the React tree** — zero render interference) + click-to-switch messages.
- **CC hooks** write each session's state to `~/.claude/cc-tab-status/<session_id>.json` (`{state, since, error?}`); the wired hook command points at `INSTALL_DIR/hooks/cc-status.js`.
- **7 SVGs** (idle / running×4 frames / done / error) are copied into `INSTALL_DIR/resources/` at install time and referenced by that absolute path — a CC update only wipes the extension dir and deleting the source project doesn't lose them (re-run the patch to restore).

See [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md) (icon injection) + [`docs/WEBVIEW-injection.md`](docs/WEBVIEW-injection.md) (status bar injection).

## Why a patch

A VSCode `WebviewPanel` tab icon (`iconPath`) is set **exclusively by the extension that created that panel** — there is no public API for a third-party extension to modify it. CC's session tab is a WebviewPanel created by the CC extension itself, so its icon can only be assigned from inside CC's `extension.js`. We exhausted the alternatives (standalone extension, proposed APIs, webview interception, etc.) — none can reach the icon. The only viable path is a patch. Trade-off: a CC auto-update overwrites it, so you must re-run the patch.

## FAQ

**After a CC update the status dot stopped lighting up?** A CC auto-update replaces the entire extension dir, overwriting the patched files with the originals. Re-run `npx vscode-claude-code-status-dot` (the SVG/hook runtime copies live in `INSTALL_DIR`, which a CC update doesn't touch; deleting the source project doesn't matter either).

**Upgrading from an old (git clone) install?** Just re-run `npx vscode-claude-code-status-dot` — the patcher detects the stale baked path and rewrites it in place; no need to `--revert` first.

**Just installed and the icon didn't change?** First run `Developer: Reload Window`. If it still doesn't work, run `--status` and read the report.

**The patch reports "Anchor mismatch"?** CC's minified code has drifted. The patcher refuses to write, so the extension is not damaged. Open an issue with your CC version.

**State stuck on running?** Likely you interrupted CC with Esc (no hook fires). The next prompt or normal completion corrects it.

**The status bar overlaps the input box?** Tune the CSS `bottom` offset (see [`docs/WEBVIEW-injection.md` §5.2](docs/WEBVIEW-injection.md)).

## Known limitations

- **No hook for manual Esc interrupt**: CC doesn't fire Stop/StopFailure, so the state stays on running; corrected naturally by the next prompt/Stop ([anthropics/claude-code#45289](https://github.com/anthropics/claude-code/issues/45289)).
- **CC auto-update overwrite**: patched `extension.js`/`webview` overwritten by originals → silent failure, re-run the patch.
- **Minified anchor version fragility**: the patch depends on a few exact strings in CC's code; on version drift the patcher errors out and refuses to write.
- **No notification when VSCode is fully closed**: the IIFE runs in the extension host; if VSCode is closed, no notification.
- **System notification click doesn't jump to tab**: osascript has no click callback; locate the session via the tab dot back in VSCode.

## Risk disclaimer

This project modifies Claude Code's `extension.js` + `webview/index.js` + `webview/index.css` (all backed up; `--revert` fully restores), and writes to your `~/.claude/settings.json` (backed up on first run). The hook script is designed to **never block or break CC** — any error exits silently with code 0. Read the known limitations before use.

## Uninstall

```bash
npx vscode-claude-code-status-dot --revert   # restore extension.js + webview + remove hooks + delete INSTALL_DIR
```

`--revert` keeps `~/.claude/cc-tab-status/` (user data) and the first-run `.bak` safety copies (remove manually if you wish). For dev, the command is `npx tsx patch.ts --revert`.

## License

MIT (c) wangdong
