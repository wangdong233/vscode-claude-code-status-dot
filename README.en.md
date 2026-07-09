# claude-code-status-dot

Adds **four-state colored status dots** to the session tab icon of Claude Code's VSCode extension, so you can see at a glance what each session is doing.

> Implemented as a **patch**, not a standalone VSCode extension. See [Why a patch?](#why-a-patch) below.

![screenshot](docs/screenshot.png)

> Screenshot pending (`docs/screenshot.png`).

---

## Features

Claude Code's native session tab icon refreshes only on sparse events and distinguishes little more than "pending permission / unseen completion". This project injects a 500ms redraw timer that expands the icon into four states:

| State | Meaning | Color | Animation | SVG |
|---|---|---|---|---|
| `idle` | Idle (initial / no state file / done > 5 min) | Gray `#808080` | Static | `claude-logo-idle.svg` |
| `running` | Running | Yellow `#CCA700` ↔ `#FFD60A` | Breathing (500ms two-frame toggle) | `claude-logo-running.svg` ↔ `claude-logo-running-bright.svg` |
| `done` | Done | Green `#3FB950` | Static | `claude-logo-done.svg` |
| `interrupted` | Interrupted (rate-limited / errored) | Red `#F85149` | Fast flash (500ms on/off toggle) | `claude-logo-error.svg` ↔ CC default `claude-logo.svg` |

> **permission (awaiting user approval)**: handled by Claude Code's native blue dot — this project **does not override it**. When there is no external state file or the state is unknown, the injected timer simply `return`s and does not touch CC's icon, so CC's blue dot shows naturally.

Full state contract: [`docs/STATES.md`](docs/STATES.md) (single source of truth).

## How it works

One sentence: **patch CC's `extension.js` to inject an IIFE (reads a state file every 500ms and sets `iconPath`) + CC hooks write the state file + 5 SVGs.**

- **Writer side**: CC hooks write each session's state to `~/.claude/cc-tab-status/<session_id>.json` (fields `{state, since, error?}`).
- **Reader side**: the injected timer reads the state file for its own session and swaps the corresponding SVG by absolute path.
- **Assets**: 5 SVGs live in this project's `resources/`, referenced by absolute path (a CC auto-update only wipes the extension dir, so the SVGs are never lost).

See [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md) for details.

## Why a patch

A VSCode `WebviewPanel` tab icon (`iconPath`) is set **exclusively by the extension that created that panel**. VSCode **exposes no public API** for one third-party extension to modify another extension's webview tab icon. Claude Code's session tab is a `WebviewPanel` created by the CC extension itself, so its `iconPath` can only be assigned from inside CC's `extension.js`.

We exhausted the alternatives (a standalone VSCode extension, proposed APIs, webview interception, etc.) — none can reach the icon. The only viable path is to patch CC's `extension.js` and inject our redraw logic. The trade-off is that a CC auto-update overwrites the patched file and you must re-run the patch (see [FAQ](#faq)).

## Prerequisites

- **Node.js 18+**: the hook script `hooks/cc-status.js` is zero-dependency and uses only Node built-ins.
- **Claude Code's VSCode extension installed**: the patcher searches `~/.vscode/extensions` (and insiders / server / cursor / vscodium) for `anthropic.claude-code-*`.
- `npx tsx` to run the TypeScript script (no global install needed; `npx` fetches it).

## Install

```bash
git clone <this-repo> claude-code-status-dot
cd claude-code-status-dot
npx tsx patch.ts
```

`patch.ts` will: discover the CC extension → back up `extension.js` → inject the IIFE → write 6 hook events into `~/.claude/settings.json` → verify all 5 SVGs are present.

After install, **Reload Window** to apply: `Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → type `Developer: Reload Window`.

> Hook wiring is **written automatically** into `~/.claude/settings.json` by the patcher (idempotent, tagged with `# cc-status-dot-managed`, safe to re-run). To wire hooks manually or inspect the format, see [`hooks/settings-snippet.json`](hooks/settings-snippet.json).

## State colors

| Color you see | Meaning | Trigger |
|---|---|---|
| Gray (static) | Idle | Initial / done more than 5 min ago / no state file |
| Yellow (breathing) | Running | Prompt submitted, around tool calls (heartbeat) |
| Green (static) | Turn done | CC fires `Stop` |
| Red (fast flash) | Interrupted / errored | CC fires `StopFailure` (e.g. rate limit, overload) |
| Blue (CC native) | Awaiting approval | CC's native blue dot, not this project |

## Revert

```bash
npx tsx patch.ts --revert
```

Restores `extension.js` from `extension.js.bak` and surgically removes this project's hook entries from `settings.json` based on the marker (your other manual hooks are left untouched).

## Status (changes nothing)

```bash
npx tsx patch.ts --status
```

Dry-run report: CC extension version, whether patched, whether hooks are wired, whether SVGs are present, and the state directory.

## FAQ

**Q: After a Claude Code update, the status dot stopped lighting up?**
A: A CC auto-update replaces the entire extension directory, so the patched `extension.js` is overwritten by the original → silent failure. Re-run `npx tsx patch.ts` (the SVGs live in this project's directory and are not lost, so no re-copy is needed).

**Q: I just installed it and the icon didn't change?**
A: First run `Developer: Reload Window`. If it still doesn't work, run `npx tsx patch.ts --status` and read the report: is the CC extension detected, is it patched, are hooks wired, are SVGs present?

**Q: The patch reports "Anchor mismatch"?**
A: CC's minified code has drifted (the anchor strings no longer match). The patcher refuses to write any file, so the extension is not damaged. Please open an issue on this project's issue tracker with your CC version and wait for an anchor update.

**Q: The state is stuck on `running`?**
A: Most likely you interrupted CC with Esc (no hook fires). The next prompt or normal completion will correct it naturally. See [Known limitations](#known-limitations).

## Known limitations

- **No hook for manual Esc interrupt**: interrupting CC with Esc does not fire `Stop`/`StopFailure`, so the state stays on `running`. The injected timer makes no active inference; it is corrected naturally by the next `UserPromptSubmit` (new turn) or `Stop` (next normal completion).
- **CC auto-update overwrite**: see FAQ; re-run the patch.
- **Minified anchor version fragility**: the patch relies on two exact strings (Anchor A/B) in CC's `extension.js`. When a CC version upgrade shifts the minified code, the patcher errors out and refuses to write, and asks you to open an issue.

## Risk disclaimer

This project modifies Claude Code's extension `extension.js` (a backup is taken; `--revert` fully restores it) and writes to your `~/.claude/settings.json` (backed up as `settings.json.cc-status-dot.bak` on first run). The hook script is designed to **never block or break CC** — any error (empty stdin, invalid JSON, IO failure, module-load failure) exits silently with code 0 and writes nothing to CC's stderr. Please read the known limitations above before use.

## Uninstall

```bash
npx tsx patch.ts --revert   # restore extension.js + remove hooks
```

Then delete this project's directory. The state directory `~/.claude/cc-tab-status/` is user data; delete it yourself if you wish.

## License

MIT (c) wangdong
