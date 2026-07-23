# cc-status-dot 配套扩展

**简体中文** | [English](#english)

配套 VS Code 扩展，属于 [`vscode-claude-code-status-dot`](https://github.com/wangdong233/vscode-claude-code-status-dot)。

**不在应用市场发布**。打包在 npm 包内，`npx vscode-claude-code-status-dot` 安装时由 patcher 通过 `code --install-extension` 顺便装进 VS Code。

## 作用

Claude Code 的 VS Code 扩展自动更新时，`extension.js` 被替换为全新副本，cc-status-dot 的 patch 会丢失。本配套扩展负责看护：

1. VS Code 启动时检查 CC `extension.js` 是否有 `cc-status-dot-injected` 标记。
2. 若标记缺失（CC 更新覆盖了），自动重跑 patcher（`node ~/.claude/cc-status-dot/patch.js`）。
3. 提示一次 **Reload Window** 激活新 patch。

## v0.5.0 tab 收藏标记 + v0.5.9 ★ 标题前缀

v0.5.0 补全 Favorites 体验（设计 [`docs/FAVORITES-DESIGN.md`](../docs/FAVORITES-DESIGN.md) §5 Slice 2 + §Q3）；v0.5.9 修订收藏入口（见下）：

- **★ 标题前缀（v0.5.9+，推荐）**：收藏的 CC 会话，tab **标题**前自动加 `★ `。IIFE 每 500ms tick 经 mtime-cache 读 `favorites.json`，sid 命中 → 给 `panelTab.title` 加 `★ ` 前缀（基于缓存逻辑标题，无 ★★ 叠加）。这是 reload-free 的收藏可视信号。v0.5.8 曾尝试在 webview 内注入可点击星标，经取证证明架构不可行（CC 只设一次 webview.html，重设触发整页重载摧毁会话）已废弃。
- **金线下划线标记（v0.5.0+）**：收藏的 CC 会话，tab icon 底部加一条细金线 `<rect fill="#F5A623">`（5 态点色/形完全不变）。IIFE 每 500ms tick 经 mtime-cache 读 `favorites.json`，sid 命中 → 把 leaf `claude-logo-<state>.svg` 替换为 `claude-logo-<state>-fav.svg`。
- **QuickPick 会话选择器（v0.5.9+）**：命令面板 **CC Favorites: Pick CC Session to Star/Unstar**——列出所有打开的 CC 会话（已收藏 ★ 在前），选一个即 toggle，不依赖当前活动 tab。
- **tab 右键菜单（v0.5.0 引入，v0.5.9 移除）**：`editor/title/context` 的 addTab/removeTab 已在 v0.5.9 移除——VSCode 不对被右键的 tab 暴露 CC 专属 context key（菜单只能对所有非文件 tab 出现，handler 靠 `__ccsdActiveSid` 对非 CC tab no-op），且 v0.5.8 用星标注入设的 `data-vscode-context` 随注入一起废弃。配置项 `ccStatusDot.fav.includeInTabContextMenu` 同步删除。可靠的收藏入口现在是上面三条。

## v0.4.0：CC Favorites 视图

自 v0.4.0 起，本配套扩展额外承载 **收藏/导航** 功能（设计全文见 [`docs/FAVORITES-DESIGN.md`](../docs/FAVORITES-DESIGN.md)）：

- **资源管理器（Explorer）侧边栏新增 "CC Favorites" 视图**——在 Explorer 头部右键勾选即可显示。
- **收藏文件**：在 Explorer 中右键任意文件 → **CC Favorites: Add/Remove File**。配置项 `ccStatusDot.fav.includeInExplorerContextMenu`（默认开）可 opt-out。
- **收藏 CC 会话**：当前活动的 Claude Code 会话，从命令面板运行 **CC Favorites: Star/Unstar Current CC Tab**。
- **导航**：点击文件节点跳到该文件（带行号定位）；点击已开会话节点焦点切到该 webview panel；右键已闭会话节点 → **CC Favorites: Copy 'claude -r <sid>'** 把 resume 命令复制到剪贴板（重开已闭会话为 webview panel 是 CC 上游架构性限制，详见设计文档 D1）。
- **命令面板**浏览：**CC Favorites: Browse** 用 QuickPick 键盘导航。

收藏存储在 `~/.claude/cc-tab-status/favorites.json`（atomic 写）。本扩展是唯一写者；IIFE 在 v0.4 不读此文件（Q3 方案 c：星标只在 Favorites 视图用 ThemeIcon，tab icon 不变；v0.5 复合星标落地后 IIFE 才会读）。

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

## v0.5.0 favorite indicators + v0.5.9 ★ title prefix

v0.5.0 completes the Favorites UX (design [`docs/FAVORITES-DESIGN.md`](../docs/FAVORITES-DESIGN.md) §5 Slice 2 + §Q3); v0.5.9 revises the toggle entrypoints (see below):

- **★ Title prefix (v0.5.9+, recommended)**: favorited CC sessions get a `★ ` prefix on the tab **title**. The IIFE's 500ms tick reads `favorites.json` via an mtime-cache and prefixes `panelTab.title` (based on the cached logical title, so no ★★ stacking). This is the reload-free favorited signal. v0.5.8 tried to inject a clickable star inside the CC webview; forensics proved that architecturally infeasible (CC sets webview.html once at panel creation; any reassignment triggers a destructive full reload of the session), so it was removed.
- **Gold-underline indicator (v0.5.0+)**: favorited CC sessions get a thin gold `<rect fill="#F5A623">` underline at the tab icon's viewBox bottom (5 state colors/shapes unchanged). The IIFE's 500ms tick reads `favorites.json` via an mtime-cache and swaps the base leaf `claude-logo-<state>.svg` for `claude-logo-<state>-fav.svg` when the panel's sid is favorited.
- **QuickPick session selector (v0.5.9+)**: command palette → **CC Favorites: Pick CC Session to Star/Unstar** — lists every open CC session (favorited ★ first), pick one to toggle, independent of the active tab.
- **Tab right-click menu (added v0.5.0, REMOVED v0.5.9)**: the `editor/title/context` addTab/removeTab items were removed in v0.5.9 — VSCode exposes no CC-specific context key for the right-clicked tab (the menu could only surface on ALL non-file tabs, with the handler no-op'ing on non-CC tabs), and the `data-vscode-context` that v0.5.8's star injection set was removed with it. The `ccStatusDot.fav.includeInTabContextMenu` setting was removed too. The reliable toggle entrypoints are the three above.

## v0.4.0: CC Favorites view

Starting at v0.4.0 this companion also hosts the **Favorites/navigation** feature (full design: [`docs/FAVORITES-DESIGN.md`](../docs/FAVORITES-DESIGN.md)):

- **A "CC Favorites" view in the Explorer sidebar** — toggle it on via the Explorer header right-click menu.
- **Favorite files**: right-click any file in Explorer → **CC Favorites: Add/Remove File**. The setting `ccStatusDot.fav.includeInExplorerContextMenu` (default on) lets you opt out of a crowded menu.
- **Favorite CC sessions**: with a Claude Code tab active, run **CC Favorites: Star/Unstar Current CC Tab** from the Command Palette.
- **Navigation**: clicking a file node jumps to it (with line cursor); clicking an open session node focuses its webview panel; right-clicking a closed session offers **CC Favorites: Copy 'claude -r <sid>'** to put the resume command on the clipboard (reopening a closed session as a webview panel is an upstream-CC architectural limit — see the design doc D1).
- **Browse via QuickPick**: run **CC Favorites: Browse** for keyboard navigation.

Favorites are stored at `~/.claude/cc-tab-status/favorites.json` (atomic writes). This extension is the sole writer; the IIFE does not read it in v0.4 (Q3 option c: stars are a ThemeIcon in the Favorites view only, the tab icon is unchanged; v0.5's tab composite-star feature will read it via mtime-cache).

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
