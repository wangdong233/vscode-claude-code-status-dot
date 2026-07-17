<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#license)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-原理--文档)

**给 Claude Code 的 VSCode 扩展打补丁，让每个会话的 tab 图标变成四态状态点**

🟡 运行中 · 🟢 完成 · 🔴 中断快闪 · ⚪ 空闲 —— 外加完成/中断通知

**简体中文** | [English](README.en.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

## ✨ 特点

- 🔧 **一行装**——`npx vscode-claude-code-status-dot` 自动 patch CC 扩展、接 8 个 hooks、复制运行时文件，幂等可重跑
- 🛡️ **持久化不怕删源**——运行时副本落在 `~/.claude/cc-status-dot/`，删项目源 / 清 npx 缓存 / CC 自动更新都不影响已 patch 的扩展
- 🎨 **四态全覆盖**——比 CC 原生（只有蓝/橙两点）更完整：idle / running / done / interrupted 全可视化
- 🔔 **完成/中断通知**——前台抑制，切走窗口时弹 VSCode 消息 + macOS 系统通知 + 声音，不用一直盯着
- ⚙️ **workflow 跑期间保持 running**——后台 subagent/cron 在飞时不假绿，`Stop` 权威裁定
- 📂 **Open Editors 同步**——左上角"打开的编辑器"视图里的 CC tab 也带状态点
- ↩️ **零副作用一键还原**——`--revert` 从 `.bak` 完整恢复 extension.js、外科手术式移除 hooks、保留你的用户数据

> ⚠️ **诚实声明**：本项目是一个 **patch（补丁），不是独立扩展**——VSCode 不允许第三方扩展修改另一个扩展的 webview tab 图标，唯一可行路径是 patch CC 自己的 `extension.js`。代价：CC 自动更新会覆盖，需重跑命令。

---

## 💬 你能得到什么?

装上后，在 Claude Code 跑活儿时，**一眼看清每个会话在干嘛**：

| 场景 | 你看到 / 得到 |
|---|---|
| CC 跑起来（你发了 prompt） | 🟡 tab 图标变**静态黄点** `#CCA700`（无动画） |
| CC 本轮正常完成 | 🟢 tab 变绿 + **切走窗口时**收到系统通知 + 声音（前台不打扰） |
| CC 被限速 / 过载中断 | 🔴 tab 红色快闪 + 通知（文案带 `rate limit reached` 等原因） |
| workflow / 后台 subagent 还在跑 | 主会话 tab **保持黄**（不误显绿），`Stop` 权威裁定不假完成 |
| 看左上角"打开的编辑器"视图 | CC 的 tab 这里**也带状态点**，和顶部 tab 栏完全同步 |
| CC 弹出权限请求 | 🔵 蓝色点（**CC 原生，本项目不覆盖**） |

> **全部装完即得，不用配任何东西。** 想关通知 / 换声音才需要改配置。

---

## 🚀 快速开始

### ① 确认前置

- **Node.js 18+**
- **Claude Code 的 VSCode 扩展已安装**（即能在 VSCode 里开 CC 聊天面板）

### ② 一行装

```bash
npx vscode-claude-code-status-dot
```

这一行会自动完成：
1. 在 `~/.vscode/extensions`（及 insiders / cursor / vscodium 等）找到 `anthropic.claude-code-*`，选版本最高的；
2. 自动清理旧版残留（如有）；
3. **备份** `extension.js` → `extension.js.bak`（仅首次）；
4. 注入定时器（设 tab 图标 + done/interrupted 通知）；
5. 把 **8 个 hook 事件**写入 `~/.claude/settings.json`（带 `# cc-status-dot-managed` 标记，幂等）；
6. 复制运行时副本（4 个 SVG = idle + running + done + error，加 hook 脚本）到 `~/.claude/cc-status-dot/`（`INSTALL_DIR`）。

> **或从源码（开发态）**：
> ```bash
> git clone https://github.com/wangdong233/vscode-claude-code-status-dot.git
> cd vscode-claude-code-status-dot
> npx tsx patch.ts
> ```
> 两种方式等价、幂等。IIFE 与 hook 都引用 `INSTALL_DIR` 绝对路径——**删项目源 / 清 npx 缓存都不影响已 patch 的扩展**。

### ③ Reload Window

`Cmd+Shift+P`（Mac）/ `Ctrl+Shift+P`（Win/Linux）→ 输入 `Developer: Reload Window`。

### ④ 发 prompt 观察

在 CC 里发一条 prompt：
- tab 图标变 🟡 **静态黄点** → CC 完成 → 变 🟢 绿色
- **切走 VSCode 窗口**等 CC 完成 → 收到系统通知 + 声音

---

## 🎨 状态色

| 颜色 | 含义 | 触发 |
|---|---|---|
| 🟡 黄色 `#CCA700`（**静态**，无动画） | 运行中 | 发 prompt、工具调用前后（心跳）、subagent spawn |
| 🟢 绿色 `#3FB950`（静态） | 本轮完成 | CC 触发 `Stop`（**超 5 分钟自动转灰**） |
| 🔴 红色 `#F85149`（快闪） | 中断 / 出错 | CC 触发 `StopFailure`（限速、过载等） |
| ⚪ 灰色 `#808080`（静态） | 空闲 | 初始 / 完成超 5 分钟 / 无状态文件 |
| 🔵 蓝色（CC 原生） | 待授权 | CC 原生蓝点，**本项目不覆盖** |

> running 静态黄点（无动画）；interrupted 红色快闪告警。完整状态契约（事件 / SVG / IPC / 通知）见 [`docs/STATES.md`](docs/STATES.md)。

---

## 🛠️ 能力详解

### 🟡 四态 tab 图标点

每个 CC 会话的 tab 图标按状态变色，**顶部 tab 栏 + 左上角"打开的编辑器"视图都显示**。running/idle/done 是静态色点，interrupted 红色快闪。

### 🔔 完成 / 中断通知

会话转为 `done` 或 `interrupted` 时（仅状态转换那一下，不重复）：

- **VSCode 在前台**：默认抑制（图标变绿/红快闪已足够）；
- **VSCode 不在前台**：弹 VSCode 消息（触发 dock bounce）+ macOS 系统通知（通知中心 + 声音）。

done 与中断都播放 `ccStatusDot.notifySound`（默认 `Glass`）。首次系统通知 macOS 会弹一次"Script Editor 想发送通知"授权，允许即可。

### ⚙️ workflow 跑期间保持 running

后台跑 workflow / subagent 时，主会话保持黄色（不误显绿），不会假报完成。

### 📂 Open Editors 同步

左上角"打开的编辑器"视图里的 CC tab **也带状态点**，和顶部 tab 栏完全同步。

<details>
<summary>📖 持久化机制（为什么删源也不怕）</summary>

reader（注入 IIFE）引用的 SVG 路径与 settings.json 接线的 hook 命令都指向 `INSTALL_DIR`（`~/.claude/cc-status-dot/`）的**绝对路径**，而非项目源目录。安装时 patcher 从项目源（`resources/` + `hooks/`）幂等复制一份过去。所以即便：
- 删除项目源目录
- npx 缓存被清
- CC 自动更新（只覆盖扩展目录，不碰 `~/.claude/`）

已 patch 的扩展仍照常渲染。只需 CC 更新后**重跑一次** `npx vscode-claude-code-status-dot` 恢复 patch 即可。

</details>

<details>
<summary>📖 升级路径（旧版 git clone 装的怎么升级）</summary>

旧版用户直接重跑 `npx vscode-claude-code-status-dot` 即可：patcher 检测到旧版注入逻辑 → 自动还原原版 → 重新注入新版，**不用先 `--revert`**。

</details>

<details>
<summary>📖 为什么是 patch（不是独立扩展）</summary>

VSCode 的 `WebviewPanel` tab 图标（`iconPath`）由**创建该 panel 的扩展独占设置**，没有公开 API 让第三方扩展改它。CC 的 session tab 正是 CC 扩展自己创建的 WebviewPanel，其图标只能在 CC 的 `extension.js` 内部赋值。穷尽替代方案（独立扩展、proposed API、webview 拦截等）均不可达，唯一可行路径是 patch。代价：CC 自动更新会覆盖，需重跑 patch。

</details>

<details>
<summary>📖 命令一览</summary>

| 命令 | 作用 |
|---|---|
| `npx vscode-claude-code-status-dot` | 安装（patch extension.js + 接 hooks，幂等；自动清理旧版残留） |
| `npx vscode-claude-code-status-dot --revert` | 还原（从 `.bak` 恢复 + 移除 hooks + 删 INSTALL_DIR，保留用户数据） |
| `npx vscode-claude-code-status-dot --status` | dry-run 报告，不改任何文件 |

开发态把命令换成 `npx tsx patch.ts`（带同样参数）。

</details>

---

## ⚙️ 配置（可选）

写进 VSCode 的 `settings.json`（不配就用默认值）：

```json
{
  "ccStatusDot.notify": true,
  "ccStatusDot.notifyWhenFocused": false,
  "ccStatusDot.notifySound": "Glass"
}
```

| 配置项 | 默认 | 说明 |
|---|---|---|
| `ccStatusDot.notify` | `true` | 通知总开关 |
| `ccStatusDot.notifyWhenFocused` | `false` | 前台时也弹 VSCode 消息（图标已足够时保持 false） |
| `ccStatusDot.notifySound` | `"Glass"` | macOS 系统通知声音（done 与中断共用；`""` 静音；可选 Basso/Ping/Hero 等） |

---

## ❓ FAQ

**CC 更新后状态点不亮了？**
CC 自动更新整体替换扩展目录，patched 文件被原版覆盖。重跑 `npx vscode-claude-code-status-dot`（SVG/hook 运行时副本在 `~/.claude/cc-status-dot/`，CC 更新不碰它；项目源删了也不影响）。

**刚装完图标没变？**
先 `Developer: Reload Window`。还不行跑 `npx vscode-claude-code-status-dot --status`：`patched: no` 重跑；`baked RES ... (STALE)` 重跑原地改写；`hooks wired: no` 重跑；`missing SVGs` 重跑补齐。

**从旧版（git clone 装）升级？**
直接重跑 `npx vscode-claude-code-status-dot`——自动处理旧版升级，无需 `--revert` 后重装。

**状态卡在 running？**
多半是你用 Esc 中断了 CC（CC 不触发 Stop/StopFailure，无 hook）。下次发 prompt 或等正常完成会自然更正。

**`npx` 连不上？**
兜底全局安装：
```bash
npm i -g vscode-claude-code-status-dot
vscode-claude-code-status-dot        # 装好后直接跑命令
```

---

## ⚠️ 已知限制

- **手动 Esc 中断无 hook**：CC 不触发 Stop/StopFailure（[#45289](https://github.com/anthropics/claude-code/issues/45289)/[#9516](https://github.com/anthropics/claude-code/issues/9516)），状态会停在 running，靠下次 prompt/Stop 自然更正。
- **CC 自动更新覆盖**：patched `extension.js` 被原版覆盖 → 静默失效，重跑命令恢复。
- **minified anchor 脆性**：patch 依赖 CC 代码里两段精确字符串，版本漂移时 patcher 报 "Anchor mismatch" 拒绝写入（扩展不会被破坏）。
- **VSCode 完全关闭时不通知**：IIFE 跑在扩展宿主进程，VSCode 关闭则不运行 → 不通知。
- **系统通知点击不跳 tab**：osascript 无 click callback，通知仅提醒，回 VSCode 靠 tab 绿/红点定位。

---

## 🏗️ 原理 + 文档

**patch CC extension.js（注入定时器设 tab 图标）+ CC hooks 写状态 + 完成/中断通知。** 完整文档：

- [`docs/STATES.md`](docs/STATES.md)——**状态契约（唯一真相源）**：四态 / 事件映射 / IPC / 通知
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md)——图标注入原理（anchor / IIFE / SVG 绑定）
- [`docs/USAGE.md`](docs/USAGE.md)——使用指南（安装 / 排错 / 还原）

> 本项目修改 CC 扩展的 `extension.js`（已备份，`--revert` 完整还原），并写入 `~/.claude/settings.json`（首次备份）。hook 脚本**永不阻塞 CC**——任何错误静默退出。

---

## 💝 支持作者

如果 vscode-claude-code-status-dot 帮到你，欢迎请作者喝杯咖啡 ☕

<div align="center">

微信 | 支付宝
:-: | :-:
<img src="doc/support-wechat.jpg" height="200" alt="微信"> | <img src="doc/support-alipay.jpg" height="200" alt="支付宝">


</div>

或 ⭐ Star、提 Issue / PR —— 都是对作者的支持。

## License

[MIT](LICENSE) (c) wangdong
