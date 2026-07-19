<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#license)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-原理--文档)

**一眼看清所有 Claude Code 会话在干嘛 —— 不用逐个 tab 切过去看**

🟡 运行中 · 🟢 完成 · 🔵 待你输入 · 🔴 中断快闪 —— **tab 五态点（灰 idle / 黄 running / 绿 done / 红 interrupted / 蓝 permission）+ 底部 4 灯聚合（🟢🟡🔵🔴，无灰——idle 不计底部）+ 完成/中断通知 + CC 更新自动恢复**

**简体中文** | [English](README.en.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

> 开好几个 Claude Code 会话并行跑活儿时，挨个 tab 切过去看谁跑完了、谁卡住等授权、谁被限速中断——太累。装上这个，**每个 tab 自己告诉你它在干嘛**，底部一行还能看完所有会话的整体状态，跑完或中断顺手弹个系统通知。你可以放心切去干别的。

---

## 🖼️ 看一眼就懂

<div align="center">

<img src="docs/images/status-dots.png" alt="顶部 tab 与侧边打开的编辑器里的状态点" width="640">

**顶部 tab + 左上"打开的编辑器"侧边栏**——🟡 运行中 · 🟢 完成 · 🔵 待输入 · 🔴 中断

<br>

<img src="docs/images/completion-notification.png" alt="macOS 完成通知 + Glass 声" width="640">

**会话完成时弹出的系统通知 + 提示音**（前台后台都弹）

<!-- 底部 4 灯聚合截图占位：建议补一张窗口底部状态栏的整体块截图，展示 🟢done 🟡running 🔵pending 🔴interrupted + 数字的视觉效果。 -->

</div>

---

## 🚀 三步用上

**前置**：Node.js 18+，VSCode 里已装 Claude Code 扩展。

```bash
npx vscode-claude-code-status-dot
```

`Cmd+Shift+P`（Mac）/ `Ctrl+Shift+P`（Win/Linux）→ 输入 `Developer: Reload Window` → 在 CC 里发一条 prompt。

tab 图标立刻变 🟡 黄，跑完变 🟢 绿并弹通知；CC 弹权限授权时 tab 变 🔵 蓝（reader 让出图标给 CC 原生蓝点显示，待你授权），底部 🔵 pending 灯 +1。**装一次就生效，不用配任何东西。**

> 想关通知 / 换声音才需要看后面的[配置](#-配置可选)。

---

## 💬 你能得到什么

### 1. 每个 tab 都带五态状态点

CC 会话的 tab 图标按状态变色——🟡 运行中 / 🟢 完成 / 🔴 中断快闪 / ⚪ 空闲 / 🔵 待输入（CC 弹权限授权时 reader 让出图标，CC 原生蓝点显示，**不覆盖**）。**顶部 tab 栏 + 左上"打开的编辑器"侧边栏都显示**，两边完全同步。开几个会话并排跑，扫一眼就知道哪个还在干、哪个完事了、哪个卡在等你授权。

### 2. 底部 4 灯聚合：所有会话整体状态一眼看完

窗口底部状态栏一个整体块，4 个圆点 + 数字：

```
🟢 1   🟡 2   🔵 1   🔴 0
done   running  pending  interrupted
```

开 3 个会话——一个跑着、一个等你授权、一个完成了——底部直接看到 `🟢1 🟡1 🔵1 🔴0`，不用切 tab。**4 灯位置固定，数字变化不会让整行位移**（状态栏数字等宽）。每灯 count=0 时灰灭（占位但不亮），count>0 时亮彩球。

### 3. 完成 / 中断通知

CC 跑完或被限速中断时弹**系统通知**——前台后台都弹：

- **macOS**：屏幕右上角下拉，Glass 声，无按钮，几秒自动消失
- **Windows / Linux**：VSCode 右下角 toast，同样无按钮

你可以放心切去浏览器 / 别的窗口干别的，跑完自会提醒，不用一直盯着。

### 4. 🔵 pending：CC 等你输入时立刻让你知道

CC 弹**权限授权**、question、elicit 这种"等你输入"的场景，底部 🔵 灯 +1。tab 上 reader 让出图标给 CC 原生蓝点（**不覆盖**），底部状态栏还能独立计 pending——一眼知道有几个会话卡在等你。

### 5. companion 自愈：CC 更新覆盖后自动恢复

CC 自动更新会把 patch 整体覆盖掉。**v0.2.0 起**，`npx` 装的时候会自动装一个 **companion 扩展**进你的 VSCode 系编辑器（含 Insiders / Cursor / VSCodium）；下次 VSCode 启动时，companion 检测到 CC 把 patch 冲掉了，**自动重跑 patcher + 提示一次 Reload Window**——多数情况你什么都不用做，无感恢复。

### 6. 持久化：删源 / 清缓存 / CC 更新都不影响

运行时副本落在 `~/.claude/cc-status-dot/`（SVG 图标 + hook 脚本 + patcher）。所有 hook 命令和图标路径都指向这个**绝对路径**——删项目源、清 npx 缓存、CC 自动更新都不碰这里，已 patch 的扩展照常渲染。

### 7. workflow 跑期间不假绿

后台跑 subagent / cron 时，主会话 tab **保持黄色**（不误显完成）——`Stop` hook 只信 payload 里的 `background_tasks` 计数，不退化漂移。活儿真跑完才转绿。

### 8. 安全兜底（绝不砖 CC）

写 `extension.js` 前对完整 2.6MB 文件跑 `node --check`（assertCompiles 守卫，坏的注入直接拒绝写入），原子写（`.tmp` + rename），`INJECT_VERSION` 自动重注入。哪怕 patcher 出错，也**不会把 CC 扩展写坏**。

### 9. 一键零副作用还原

`npx vscode-claude-code-status-dot --revert` 从 `.bak` 完整恢复 `extension.js`，外科手术式移除 hooks，**保留你的所有用户数据**。

> ⚠️ **诚实声明**：这是一个 **patch（补丁），不是独立扩展**——VSCode 不允许第三方扩展修改另一个扩展的 webview tab 图标，唯一可行路径是 patch CC 自己的 `extension.js`。代价：CC 自动更新会覆盖，但 companion 自愈扩展会自动恢复（见第 5 点）。

---

## 🎨 状态色

| 颜色 | 含义 | 触发 |
|---|---|---|
| 🟡 黄色 `#CCA700`（**静态**，无动画） | 运行中 | 发 prompt、工具调用前后（心跳）、subagent spawn |
| 🟢 绿色 `#3FB950`（静态） | 本轮完成 | CC 触发 `Stop`（**超 5 分钟自动转灰**） |
| 🔴 红色 `#F85149`（快闪） | 中断 / 出错 | CC 触发 `StopFailure`（限速、过载等） |
| ⚪ 灰色 `#808080`（静态） | 空闲 | 初始 / 完成超 5 分钟 / 无状态文件 |
| 🔵 蓝色（CC 原生） | CC 弹权限授权 | reader 让出图标，CC 原生蓝点显示（**不覆盖**）；底部状态栏另独立计 pending |

> running 静态黄点（无动画）；interrupted 红色快闪告警。完整状态契约（事件 / SVG / IPC / 通知）见 [`docs/STATES.md`](docs/STATES.md)。

---

## 🛠️ 能力详解

### 🟡 五态 tab 图标点

每个 CC 会话的 tab 图标按状态变色，**顶部 tab 栏 + 左上角"打开的编辑器"视图都显示**。running/idle/done 是静态色点，interrupted 红色快闪，permission 时 reader 让出图标给 CC 原生蓝点显示（**不覆盖**）。

### 📊 底部状态栏 4 灯聚合

窗口底部状态栏（左半靠近中间）一个整体块（**单个 StatusBarItem + `parts.join(' ')` 空格拼接**）聚合显示 4 灯：**🟢 done · 🟡 running · 🔵 pending · 🔴 interrupted**，每灯紧跟数字（封顶 0/1/2/3/N，N 表示 ≥4）：

- count=0 → 灰球 ⚪ + 数字（灰灭，占位但不亮）
- count>0 → 彩球 + 数字（亮）

**4 灯位置固定，数字变化不位移**——VSCode 状态栏 CSS `font-variant-numeric:tabular-nums` 给所有 item 强制数字等宽，ASCII 0-9 在任何字体下都不抖。

🔵 pending 是独立维度（与 state 解耦）：CC 弹权限授权 / question / elicit 等"待用户输入"场景，writer 接 CC `Notification` hook 落盘 pending 标记，reader 独立计数。权限授权时 tab 图标让位给 CC 原生蓝点（不覆盖），底部状态栏仍独立计 pending。

**3 段 GC** 防止计数漂移：done 超 5 分钟 → idle（绿减 1）/ running 文件 mtime 超 30 分钟 → idle（崩溃会话回收）/ interrupted 文件 mtime 超 24 小时 → idle；pending 基于 st 字段 GC（崩溃 pending 回 idle，同时减黄 + 减蓝）。

整块通过 **1 个运行时 StatusBarItem + 拼接 text**（IIFE 每 500ms 直接 mutate SBI 的 text），无需 patch CC `package.json`，无需 ThemeColor 块。

### 🔔 完成 / 中断通知

会话转为 `done` 或 `interrupted` 时（每个新的完成/中断 `since` 触发一次，不重复）：

- **macOS**：弹**系统通知**（从屏幕右上角下拉，带声音，无任何按钮，几秒后自动消失）——**前台和后台都弹**（`notifyWhenFocused` 默认 `true`）。
- **Windows / Linux**：没有 osascript，退化为 VSCode 内置消息（右下角 toast，同样无按钮、自动消失）。

通知声音由 `ccStatusDot.notifySound` 控制（默认 `Glass`，done 与中断共用；`""` 静音）。首次 macOS 系统通知会弹一次"Script Editor 想发送通知"授权，允许即可。

### 🛡️ companion 自愈扩展（v0.2.0+）

`npx` 装的时候会自动检测 PATH 上的 `code` CLI（含 `code-insiders` / `cursor` / `codium`），把 **companion .vsix**（`cc-status-dot-companion`）`code --install-extension` 进每个检测到的 VS Code 系编辑器；同时把 `patch.js` 拷贝到 `INSTALL_DIR/patch.js`。

VSCode 每次启动时，companion 扩展检测 CC 扩展里的 `cc-status-dot-injected` marker——如果 CC 自动更新把 patch 冲掉了（marker 不见了），companion 自动跑 `node ~/.claude/cc-status-dot/patch.js` 重 patch，并提示一次 `Reload Window`。用户**无感恢复**，不用手动跑 `npx`。

### ⚙️ workflow 跑期间保持 running

后台跑 workflow / subagent 时，主会话保持黄色（不误显绿），不会假报完成——`Stop` 只信 payload 里的 `background_tasks` 计数，不退化漂移。

### 📂 Open Editors 同步

左上角"打开的编辑器"视图里的 CC tab **也带状态点**，和顶部 tab 栏完全同步。

### 🔒 持久化机制

reader（注入 IIFE）引用的 SVG 路径与 settings.json 接线的 hook 命令都指向 `INSTALL_DIR`（`~/.claude/cc-status-dot/`）的**绝对路径**，而非项目源目录。安装时 patcher 从项目源（`resources/` + `hooks/`）幂等复制一份过去。所以即便删除项目源目录、npx 缓存被清、CC 自动更新（只覆盖扩展目录，不碰 `~/.claude/`），已 patch 的扩展仍照常渲染。

### ↩️ 零副作用一键还原

`--revert` 从 `.bak` 完整恢复 extension.js、外科手术式移除 hooks、保留你的用户数据。

<details>
<summary>📖 升级路径（旧版 git clone 装的怎么升级）</summary>

旧版用户直接重跑 `npx vscode-claude-code-status-dot` 即可：patcher 检测到旧版注入逻辑 → 自动还原原版 → 重新注入新版，**不用先 `--revert`**。

</details>

<details>
<summary>📖 为什么是 patch（不是独立扩展）</summary>

VSCode 的 `WebviewPanel` tab 图标（`iconPath`）由**创建该 panel 的扩展独占设置**，没有公开 API 让第三方扩展改它。CC 的 session tab 正是 CC 扩展自己创建的 WebviewPanel，其图标只能在 CC 的 `extension.js` 内部赋值。穷尽替代方案（独立扩展、proposed API、webview 拦截等）均不可达，唯一可行路径是 patch。代价：CC 自动更新会覆盖（v0.2.0 起 companion 自愈自动恢复）。

</details>

<details>
<summary>📖 命令一览</summary>

| 命令 | 作用 |
|---|---|
| `npx vscode-claude-code-status-dot` | 安装（patch extension.js + 接 hooks + 装 companion，幂等；自动清理旧版残留） |
| `npx vscode-claude-code-status-dot --revert` | 还原（从 `.bak` 恢复 + 移除 hooks + 删 INSTALL_DIR，保留用户数据） |
| `npx vscode-claude-code-status-dot --status` | dry-run 诊断报告，不改任何文件 |

开发态把命令换成 `npx tsx patch.ts`（带同样参数）。

或从源码（开发态）：
```bash
git clone https://github.com/wangdong233/vscode-claude-code-status-dot.git
cd vscode-claude-code-status-dot
npx tsx patch.ts
```
两种方式等价、幂等。IIFE 与 hook 都引用 `INSTALL_DIR` 绝对路径——**删项目源 / 清 npx 缓存都不影响已 patch 的扩展**。

</details>

---

## ⚙️ 配置（可选）

写进 VSCode 的 `settings.json`（不配就用默认值）：

```json
{
  "ccStatusDot.notify": true,
  "ccStatusDot.notifyWhenFocused": true,
  "ccStatusDot.notifySound": "Glass"
}
```

| 配置项 | 默认 | 说明 |
|---|---|---|
| `ccStatusDot.notify` | `true` | 通知总开关 |
| `ccStatusDot.notifyWhenFocused` | `true` | 前台时也弹通知（macOS 系统通知 / Windows/Linux VSCode 消息）；设 `false` 仅后台时通知 |
| `ccStatusDot.notifySound` | `"Glass"` | macOS 系统通知声音（done 与中断共用；`""` 静音；可选 Basso/Ping/Hero 等） |

---

## ❓ FAQ

**CC 更新后状态点不亮了？**
CC 自动更新整体替换扩展目录，patched 文件被原版覆盖。**v0.2.0 起**：companion 扩展会在 VS Code 启动时检测 `cc-status-dot-injected` marker，若 CC 更新冲掉了 patch 自动重跑 `node ~/.claude/cc-status-dot/patch.js` 并提示一次 `Reload Window`——多数情况你什么都不用做。companion 没装上或想手动修：重跑 `npx vscode-claude-code-status-dot`（SVG/hook 运行时副本在 `~/.claude/cc-status-dot/`，CC 更新不碰它；项目源删了也不影响）。

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
- **CC 自动更新覆盖**：patched `extension.js` 被原版覆盖 → **v0.2.0 起 companion 扩展自动重跑 patcher + 提示 reload**（见 FAQ）；companion 没装则手动重跑命令恢复。
- **minified anchor 脆性**：patch 依赖 CC 代码里两段精确字符串，版本漂移时 patcher 报 "Anchor mismatch" 拒绝写入；写 extension.js 前还会对完整 2.6MB 文件跑 `node --check`（assertCompiles 守卫，坏 IIFE 拒绝写入），原子写（`.tmp` + rename），`INJECT_VERSION` 自动重注入——**绝不砖 CC**。
- **VSCode 完全关闭时不通知**：IIFE 跑在扩展宿主进程，VSCode 关闭则不运行 → 不通知。
- **系统通知点击不跳 tab**：osascript 无 click callback，通知仅提醒，回 VSCode 靠 tab 绿/红点定位。
- **SBI priority 无所有权**：底部状态栏块占用 `StatusBarAlignment.Left` 的 priority `-9996`（单点），VSCode StatusBarItem API 无扩展级命名空间/所有权机制——其它扩展若声明同 priority，可能把我们的 SBI 挤到角落。**单 SBI 整体块的架构消除了"行被外部分隔"失败模式**（4 个独立 SBI 会被其它扩展的 SBI 插入灯之间劈开；整行作为一个 SBI，外部插入只能落到整行两侧，不会拆开 4 灯）。主流场景下不会触发，STATES.md §7.5 已诚实声明此限制。
- **emoji 字体栈依赖**：底部状态栏圆点是 emoji 字形（🟢🟡🔵🔴⚪），依赖系统 emoji 字体栈——macOS（Apple Color Emoji）/ Windows 10+（Segoe UI Emoji）/ 主流 Linux（Noto Color Emoji）正常显示彩色；Win7 / 部分 headless Linux / 无 emoji 字体的远程 SSH 环境可能渲染为黑白字形或豆腐块。这是有意的审美取舍（圆点 emoji > 跨平台一致的色块）。

---

## 🏗️ 原理 + 文档

**patch CC extension.js（注入定时器设 tab 图标）+ CC hooks 写状态 + 完成/中断通知。** 完整文档：

- [`docs/STATES.md`](docs/STATES.md)——**状态契约（唯一真相源）**：五态（灰/黄/绿/红/蓝）+ 底部 4 灯聚合 / 事件映射 / IPC / 通知
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md)——图标注入原理（anchor / IIFE / SVG 绑定）
- [`docs/USAGE.md`](docs/USAGE.md)——使用指南（安装 / 排错 / 还原）

> 本项目修改 CC 扩展的 `extension.js`（已备份，`--revert` 完整还原），并写入 `~/.claude/settings.json`（首次备份）。hook 脚本**永不阻塞 CC**——任何错误静默退出。**9 个 hooks**（含 Notification 落盘 pending）。

---

## 💝 支持作者

如果 vscode-claude-code-status-dot 帮到你，欢迎请作者喝杯咖啡 ☕

<div align="center">

微信 | 支付宝
:-: | :-:
<img src="docs/images/support-wechat.jpg" height="200" alt="微信"> | <img src="docs/images/support-alipay.jpg" height="200" alt="支付宝">


</div>

或 ⭐ Star、提 Issue / PR —— 都是对作者的支持。

## License

[MIT](LICENSE) (c) wangdong
