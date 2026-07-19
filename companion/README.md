# cc-status-dot Companion

Companion VS Code extension for [`vscode-claude-code-status-dot`](https://github.com/wangdong233/vscode-claude-code-status-dot).

This extension is **not published to the Marketplace**. It ships inside the npm package and is installed into VS Code by the patcher at `npx` install time.

## What it does

When Claude Code's VS Code extension auto-updates, its `extension.js` is replaced with a fresh copy and the cc-status-dot patch is lost. This companion watches for that:

1. On VS Code startup it greps the CC `extension.js` for the `cc-status-dot-injected` marker.
2. If the marker is missing (CC update wiped it), it re-runs the patcher (`node ~/.claude/cc-status-dot/patch.js`).
3. Offers a one-click **Reload Window** to activate the fresh patch.

That's the whole feature surface. No status bar, no commands, no settings.

## Install

```
npx vscode-claude-code-status-dot
```

The patcher auto-detects the `code` CLI (and `cursor` / `codium` / VS Code Insiders) and runs `code --install-extension companion/cc-status-dot-companion-0.2.0.vsix`. If no `code` CLI is on PATH, the patcher warns and continues — the IIFE patch still works without the companion.

## Uninstall

```
npx vscode-claude-code-status-dot --revert
```

This also runs `code --uninstall-extension cc-status-dot-companion` for every detected VS Code-family CLI.

## Build (maintainers)

```
cd companion
npm install
npm run build
npm run package:vsix   # → cc-status-dot-companion-0.2.0.vsix
```

## What's in the .vsix

Just the compiled `dist/extension.js` + `package.json` + LICENSE + README + CHANGELOG. Source `.ts`, `tsconfig.json`, and `node_modules/` are stripped by `.vscodeignore`.
