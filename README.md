<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#license)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-原理--文档)

**一眼看清所有 Claude Code 会话在干嘛 —— 不用逐个 tab 切过去看**

🟡 运行中 · 🟢 完成 · 🔵 待你输入（CC 弹授权，或 CC 回复"等你确认 / let me know"）· 🔴 中断快闪 —— **tab 五态点 + 底部 4 灯聚合（🟢🟡🔵🔴，无灰——idle 不计底部）+ 完成/中断通知 + CC 更新自愈 + 右下角 token 实时刷新 / $ cost 估算（workflow 子代理 token 也算进来）+ QuickPick 配置面板跟随 VSCode 语言（中/英/日/德/西/法/葡/俄）**

**简体中文** | [English](docs/README.en.md) | [Deutsch](docs/README.de.md) | [Español](docs/README.es.md) | [Français](docs/README.fr.md) | [日本語](docs/README.ja.md) | [Português](docs/README.pt.md) | [Русский](docs/README.ru.md)

</div>

---

> 开好几个 Claude Code 会话并行跑活儿时，挨个 tab 切过去看谁跑完了、谁卡住等授权、谁被限速中断——太累。装上这个，**每个 tab 自己告诉你它在干嘛**，底部一行还能看完所有会话的整体状态，跑完或中断顺手弹个系统通知。你可以放心切去干别的。

---

## 🖼️ 看一眼就懂

<div align="center">

<img src="docs/images/overview-annotated.png" alt="总览：6 个功能点标注（点击放大）" width="820">

</div>

**① Tab 五态状态点**　每个 CC 会话 tab 的 Claude 图标按状态变色——🟡 运行中 / 🟢 完成 / 🔴 中断快闪 / ⚪ 空闲 / 🔵 待输入。🔵 待输入有两类触发：(a) CC 弹权限授权框时让位给 CC 原生蓝点（不覆盖）；(b) CC 回复含"等你确认 / let me know / your call"等**待你决策**语义时 tab 自动转蓝（覆盖原 running-黄 / done-绿）——一眼区分"真跑完"还是"等我说啥"，不用盯着 tab 猜。收藏会话 tab 标题加 **★** 前缀 + 图标底部金线。顶部 tab 栏 + 左侧"打开的编辑器"都显示，两边同步。

**② 侧边栏 CC 收藏视图**　Explorer 侧边新增 CC Favorites，把常用文件/会话 pin 在一起；会话图标 open=实心气泡 / closed=轮廓气泡，点击即跳转或 resume 到新 panel；右键已闭会话可复制 `claude -r <sid>` 命令。

**③ 底部 4 灯聚合**　状态栏一个整体块 🟢 done · 🟡 running · 🔵 pending · 🔴 interrupted + 计数，所有会话整体状态一眼看完，不用切 tab；4 灯位置固定，数字变化不位移。

**④ ★ 一键收藏按钮**　状态栏 token 旁的 ★/☆ 按钮，一键收藏/取消当前活动 CC 会话（已收藏显金色 ★，未收藏显空心 ☆）；无活动 CC 会话时自动隐藏。

**⑤ 右下角 token / $ cost**　当前激活会话的 token 用量 + 可选 USD 估算 + 流式速率（tok/s）；点击弹 QuickPick 配置面板（统计窗口 / 显示模式 / 通知 / 声音 / 复制 / 重置），面板跟随 VSCode 界面语言（中/英/日/德/西/法/葡/俄）。

**⑥ 完成 / 中断通知**　会话跑完或被限速中断时弹系统通知 + 提示音（macOS 屏幕右上角下拉 / Windows·Linux 右下角 toast），前台后台都弹，切去干别的也能被提醒。

> **可靠性保障**：CC 自动更新覆盖 patch 时，companion 自愈扩展自动重 patch + 提示 reload（无感恢复）；patch 前对完整 2.6MB `extension.js` 跑 `node --check` 校验 + 原子写（**绝不砖 CC**）；`--revert` 一键零副作用还原；运行时副本在 `~/.claude/cc-status-dot/`（删源 / 清缓存 / CC 更新都不影响已装）。workflow 跑子代理期间主会话保持 🟡 不假绿。

---

## 🚀 三步用上

**前置**：Node.js 18+，VSCode 里已装 Claude Code 扩展。

```bash
npx -y vscode-claude-code-status-dot@latest
```

`-y` 跳过 npx 首次安装确认，全程零交互（patcher 本身无任何提示）。**位置:必须在 `npx` 之后、包名之前** —— `npx -y <pkg>`；放包名后（`npx <pkg> -y`）不生效。首次安装也可不带 `-y`：`npx vscode-claude-code-status-dot`。

`Cmd+Shift+P`（Mac）/ `Ctrl+Shift+P`（Win/Linux）→ 输入 `Developer: Reload Window` → 在 CC 里发一条 prompt。

tab 图标立刻变 🟡 黄，跑完变 🟢 绿并弹通知；CC 弹权限授权时 tab 变 🔵 蓝（reader 让出图标给 CC 原生蓝点显示，待你授权），底部 🔵 pending 灯 +1。**装一次就生效，不用配任何东西。**

> 想关通知 / 换声音才需要看后面的[配置](#-配置可选)。

---

## 🎨 状态色

| 颜色                                  | 含义                   | 触发                                                                                                                                                                                                                                                         |
| ------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 🟡 黄色 `#CCA700`（**静态**，无动画） | 运行中                 | 发 prompt、工具调用前后（心跳）、subagent spawn                                                                                                                                                                                                              |
| 🟢 绿色 `#3FB950`（静态）             | 本轮完成（不待用户）   | CC 触发 `Stop` 且最后回复是中性完成（`已完成`/`Done.`）；**超 5 分钟自动转灰**                                                                                                                                                                               |
| 🔴 红色 `#F85149`（快闪）             | 中断 / 出错            | CC 触发 `StopFailure`（限速、过载等）                                                                                                                                                                                                                        |
| ⚪ 灰色 `#808080`（静态）             | 空闲                   | 初始 / 完成超 5 分钟 / 无状态文件                                                                                                                                                                                                                            |
| 🔵 蓝色 `#58A6FF`（静态）             | 待用户输入（两类触发） | (a) **CC 弹授权框**：reader 让出图标给 CC 原生蓝点（**不覆盖**）；(b) **CC 最后回复含"待你决策"语义**（`等你`/`你决定`/`请确认`/`let me know`/`your call` 等）→ reader 渲染蓝色 `claude-logo-pending.svg`（覆盖 running-黄 / done-绿）。底部 🔵 灯两类都计数 |

> running 静态黄点（无动画）；interrupted 红色快闪告警。完整状态契约（事件 / SVG / IPC / 通知）见 [`docs/STATES.md`](docs/STATES.md)。

---

## ⚙️ 配置（可选）

**两种改配置的方式**：① 点击右下角 token SBI → 弹 QuickPick 面板（图形化，跟随 VSCode 界面语言中/英/日/德/西/法/葡/俄）；② 直接编辑 `settings.json`（下方各功能块表格）。不配都用默认值。

### 1. 通知（对应功能⑥）

跑完 / 中断时弹系统通知 + 提示音（macOS 屏幕右上角 / Win·Linux 右下角 toast，前台后台都弹）。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `ccStatusDot.notify` | `true` | 通知总开关 |
| `ccStatusDot.notifyWhenFocused` | `true` | 前台时也弹；设 `false` 仅后台时通知 |
| `ccStatusDot.notifySound` | `"Glass"` | macOS 通知声音（done 与中断共用；`""` 静音；可选 Basso/Ping/Hero 等） |

### 2. Token 统计与费用（对应功能⑤）

右下角 token SBI 显示当前激活会话的 token 用量 + 可选 $ 估算 + 流式速率；workflow 子代理 token 也算进来（不会"隐形"）。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `ccStatusDot.tokenStatsWindow` | `"all"` | 时间窗口：`all` = 累积（整个会话不清零）；`5min/10min/1h/24h/3d/7d/30d` = 滚动窗口（旧 turn 到期滑出，像"清零"） |
| `ccStatusDot.tokenDisplayMode` | `"both"` | 显示模式：`token` 仅 token / `cost` 仅 $ / `both` 两者 |
| `ccStatusDot.rateDisplayMode` | `"numeric"` | 流式速率呈现：`off` / `numeric`（如 `1.2k/s`）/ `sparkline`（▁▂▃▄▅▆▇█ 迷你图）/ `both`；状态栏拥挤可切 `off` |
| `ccStatusDot.tokenSbiVisible` | `true` | 显示 / 隐藏 token SBI |
| `ccStatusDot.tokenLiveDeltaEnabled` | `true` | 流式输出时实时增量更新 token；性能敏感机器可设 `false` |
| `ccStatusDot.showCost` | `true` | 显示 $（未知 model 自动隐藏，需 `token-rates.json` 有匹配条目） |
| `ccStatusDot.warnThresholdUsd` | `0` | cost 跨阈通知（`0` = 禁用；正数 = USD 阈值，每次跨越触发一次） |

> **自定义模型定价**：`~/.claude/cc-status-dot/token-rates.json` 是热更定价表（默认覆盖 Anthropic 官方价；GLM 等未匹配 model 自动隐藏 `$`）。加一条 glob 即可显示 `$`：
>
> ```jsonc
> { "_default": null, "claude-sonnet-*": {"in":3,"out":15,"cacheRead":0.3,"cacheCreate5m":3.75,"cacheCreate1h":6}, "glm-*": {"in":0.5,"out":1.5} }
> ```

### 3. 收藏（对应功能②④）

侧边栏 CC Favorites 视图 + tab ★ 标记 + 状态栏 ★ 按钮。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `ccStatusDot.fav.includeInExplorerContextMenu` | `true` | Explorer 右键菜单显示"加入/退出 CC 收藏"；菜单拥挤可设 `false` 关闭 |

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

- [`docs/STATES.md`](docs/STATES.md)——**状态契约（唯一真相源）**：五态（灰/黄/绿/红/蓝）+ 底部 4 灯聚合 / 事件映射 / IPC / 通知 / 性能（§9）
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md)——图标注入原理（anchor / IIFE / SVG 绑定）
- [`docs/USAGE.md`](docs/USAGE.md)——使用指南（安装 / 排错 / 还原）

> 本项目修改 CC 扩展的 `extension.js`（已备份，`--revert` 完整还原），并写入 `~/.claude/settings.json`（首次备份）。hook 脚本**永不阻塞 CC**——任何错误静默退出。**10 个 hooks**（v0.2.9 加 `PostCompact` 清 /compact 误判红球；含 Notification 落盘 pending）。

---

## 💝 支持作者

如果 vscode-claude-code-status-dot 帮到你，欢迎请作者喝杯咖啡 ☕

<div align="center">

|                                微信                                |                                支付宝                                |
| :----------------------------------------------------------------: | :------------------------------------------------------------------: |
| <img src="docs/images/support-wechat.jpg" height="200" alt="微信"> | <img src="docs/images/support-alipay.jpg" height="200" alt="支付宝"> |

</div>

或 ⭐ Star、提 Issue / PR —— 都是对作者的支持。

## License

[MIT](LICENSE) (c) wangdong
