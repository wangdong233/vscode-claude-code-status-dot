# cc-status-dot 配套扩展

**简体中文** | [English](#english)

配套 VS Code 扩展，属于 [`vscode-claude-code-status-dot`](https://github.com/wangdong233/vscode-claude-code-status-dot)。

**不在应用市场发布**。打包在 npm 包内，`npx vscode-claude-code-status-dot` 安装时由 patcher 通过 `code --install-extension` 顺便装进 VS Code。

## 作用

Claude Code 的 VS Code 扩展自动更新时，`extension.js` 被替换为全新副本，cc-status-dot 的 patch 会丢失。本配套扩展负责看护：

1. VS Code 启动时检查 CC `extension.js` 是否有 `cc-status-dot-injected` 标记。
2. 若标记缺失（CC 更新覆盖了），自动重跑 patcher（`node ~/.claude/cc-status-dot/patch.js`）。
3. 提示一次 **Reload Window** 激活新 patch。

就这些——没有状态栏、没有命令、没有设置，纯粹的自愈看护。

## 安装

```
npx vscode-claude-code-status-dot
```

patcher 自动检测 `code` CLI（含 `cursor` / `codium` / VS Code Insiders），跑 `code --install-extension`。若 PATH 上没有 `code` CLI，patcher 会告警并继续——IIFE patch 没有 companion 也能工作。

## 卸载

```
npx vscode-claude-code-status-dot --revert
```

会同时 `code --uninstall-extension cc-status-dot-companion`（每个检测到的 VS Code 系 CLI）。

## 维护者构建

```
cd companion
npm install
npm run build
npm run package:vsix   # → cc-status-dot-companion-0.2.0.vsix
```

## .vsix 内容

仅编译后的 `dist/extension.js` + `package.json` + LICENSE + README + CHANGELOG。源码 `.ts`、`tsconfig.json`、`node_modules/` 被 `.vscodeignore` 剔除。

---

<a name="english"></a>
# cc-status-dot Companion (English)

[简体中文](#) | **English**

Companion VS Code extension for [`vscode-claude-code-status-dot`](https://github.com/wangdong233/vscode-claude-code-status-dot).

**Not published to the Marketplace.** Ships inside the npm package; the patcher installs it into VS Code via `code --install-extension` at `npx` install time.

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

The patcher auto-detects the `code` CLI (and `cursor` / `codium` / VS Code Insiders) and runs `code --install-extension`. If no `code` CLI is on PATH, the patcher warns and continues — the IIFE patch still works without the companion.

## Uninstall

```
npx vscode-claude-code-status-dot --revert
```

Also runs `code --uninstall-extension cc-status-dot-companion` for every detected VS Code-family CLI.

## Build (maintainers)

```
cd companion
npm install
npm run build
npm run package:vsix
```

## What's in the .vsix

Just the compiled `dist/extension.js` + `package.json` + LICENSE + README + CHANGELOG. Source `.ts`, `tsconfig.json`, `node_modules/` stripped by `.vscodeignore`.
