# 收藏/导航机制设计（FAVORITES-DESIGN）

> **目标**：为 cc-status-dot 增加"收藏/导航"机制——VSCode 资源管理器新增"CC Favorites"子视图；tab 右键收藏；收藏项（CC 会话 + 重要文件）集中列举、点击导航。
>
> **状态**：v0.4.0 已实施 MVP（详见 §12 实施摘要）。基于 4 路并行调研（A 类似插件、B VSCode API、C 架构契合、D CC 会话生态）综合产出。
>
> **结论先行（GO/NO-GO）**：**PARTIAL-GO**（MVP + 文档化边界）。架构层面**明确无问题**——companion-based 路径经四路独立验证一致；唯一架构性不可达项是"从 sid 重开已关闭的 CC webview panel"（CC 无公开 sid-arg 命令，viewType 私有不可冒充），此项**文档化、不实施**（v0.4 落地降级路径：Copy resume cmd）。tab 复合星标 SVG（Q3 方案 a）作为 v0.5 可选增强，v0.4 先以 Favorites 视图内 `$(star-full)` 表达（方案 c）。
>
> **把握度**：Q1/Q2/Q5 = high（官方 docs + 项目历史 + 源码溯源）；Q3 = high（决策明确，方案 a 推迟到 v0.5 是范围纪律而非不确定性）；Q4 已开会话导航 = high、已闭会话重开 = high（不可达）。

---

## 0. 决策速览（一屏版）

| 维度                     | 决策                                                                                                                                                                                                                                          | 把握度         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| **Q1 TreeView 注册路径** | **Path B**：用 `companion/package.json` 贡献 `views.explorer`。**否决** Path A（patch CC package.json）——v0.1.13 已试过、v0.1.14 已废弃（patch.ts:2947-2986）。                                                                               | high           |
| **Q2 webview tab 右键**  | companion 贡献 `editor/title/context`，`when: "resourceScheme == webview'"` + handler 内 `globalThis.__ccsdActiveSid` 校验。viewType 经 D 实测为 `claudeVSCodePanel`。                                                                        | high           |
| **Q3 tab 复合星标**      | v0.4 走方案 **(c)**：tab icon **不动**，星只出现在 Favorites 视图（ThemeIcon `$(star-full)`/`$(star-empty)`）。方案 (a) 笛卡尔积 10 SVG 推迟 v0.5（用户反馈驱动）。**否决** 方案 (b) title 前缀（污染 window title、与 CC rename_tab 竞态）。 | high           |
| **Q4 已开会话导航**      | IIFE 新增 `globalThis.__ccsdSidToPanel`（panel ref 注册表，§A 写、§Z 清）；companion 调 `__ccsdSidToPanel[sid].reveal()`。零新 IPC（共享 globalThis，已验证模式 companion/extension.ts:621）。                                                | high           |
| **Q4 已闭会话重开**      | **不可达**，文档化。CC 无公开 sid-arg 命令；`claude -r <sid>` 开的是**终端**非 webview panel。降级：灰显 + 一键复制 `claude -r <sid>` 到剪贴板 + 可选开集成终端。                                                                             | high（不可达） |
| **Q5 favorites.json**    | 位置：`~/.claude/cc-tab-status/favorites.json`（即 IIFE 现有 `DIR`/`STATE_DIR`，patch.ts:219）。companion 单写，IIFE 按 mtime 缓存读 `sessions[].sid` 集合。schema 见 §5。                                                                    | high           |
| **跨扩展通信**           | **共享 globalThis**（companion 与 CC 同 EH 进程，已验证）。命令兜底：IIFE `registerCommand('ccStatusDot.fav.focusSession', ...)`（沿用 patch.ts:2057/2101 已验证模式）。                                                                      | high           |

---

## 1. 五个不明确点的确定答案

### Q1 — IIFE 能否注册 Explorer TreeView？**否**；companion 是唯一合理路径

**事实（VSCode 官方贡献点文档 + 项目历史双重证据）**：

VSCode 要求 Explorer 视图必须在某扩展的 `package.json` **静态声明** `contributes.views.explorer`（视图 id 在 package.json 与 `registerTreeDataProvider(viewId, ...)` 调用中**完全一致**）。仅调 `vscode.window.registerTreeDataProvider` 而无对应 contribution，视图**永不出现**（silent no-op，不报错）。激活时 VSCode fire `onView:${viewId}` activationEvent——contribution 是激活时静态读取的，EH 运行时不能新增。

**三路对比**：

| 路                                 | 评估                                                                                                                                                                                                                                                                                                                                                                                                                         | 裁决                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Path A：patch CC 的 package.json   | 项目 v0.1.13 已试、v0.1.14 已删（patch.ts:2947-2986 原文："v0.1.13 patched CC's package.json to contribute 20 commands... v0.1.14 removed that entire surface"）。理由：(1) CC 自动更新每次整体覆盖 package.json；(2) companion 必须 re-patch manifest + 触发 reload，陷入 reload 循环；(3) phantom commands 注册到 CC EH，跨更新脆弱。`PKG_MARKER_FIELD`（patch.ts:565）仅保留为清理 v0.1.13 残留。                         | **否决**（重走已知坏架构） |
| IIFE 内 `registerTreeDataProvider` | IIFE 跑在 CC EH、是注入字符串（patch.ts:1826 `buildIIFE`，形式 `(function(t){...})(this)`）。能调 `vs.commands.registerCommand`（已用，patch.ts:2057/2101）、能 `createWebviewPanel`（patch.ts:2185 `showRateChart`），但**无 package.json 可贡献**——视图容器不存在，数据无处附体。                                                                                                                                          | **否决**（VSCode 硬约束）  |
| **Path B：companion 扩展**         | `companion/package.json` 已是合法 VSCode 扩展：`engines.vscode:^1.80.0`、`main:"./dist/extension.js"`、`activationEvents:["onStartupFinished"]`、已有 `contributes.configuration` 9 项 properties（companion/package.json:19-113 实测）。**只需在 contributes 加 `views`/`commands`/`menus`**，companion/extension.ts:activate() 调 `createTreeView`。companion 的 package.json 由项目拥有、跟 .vsix 一起发、CC 更新动不到。 | **采纳**                   |

**结论**：Q1 → Path B。决策性证据：companion/package.json:19-113 已 contributes 9 个 configuration properties，证明贡献通道现成可用。

---

### Q2 — webview panel tab 右键菜单：**可行**

**关键事实（D 直接 grep CC extension.js + B 官方文档双重确认）**：

CC 的 tab **就是** webview panel tab。CC extension.js 原文调用 `createWebviewPanel("claudeVSCodePanel","Claude Code",i,{enableScripts:!0,retainContextWhenHidden:!0,...})`。两个关键派生事实：

1. **viewType 是稳定字符串 `claudeVSCodePanel`**（在 CC 包内只出现 1 次，命名稳定）。
2. **`retainContextWhenHidden:!0`**（CC 包内出现 3 次）——panel 对象在 tab 切换时**存活**，IIFE 的 per-panel 闭包（持有 `this.__ccsdSid`）的绑定**跨 tab 切换不丢**。

**菜单机制（必须区分两件易混事）**：

| 菜单 contribution id   | 含义                                                                           | CC tab 适用？                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `editor/title/context` | **editor 标题区右键 = tab 右键**（用户右击 tab 本身）                          | **是**（webview panel tab 享受此菜单，CC tab 是 EditorInput 子类 `WebviewInput`，参见 docs/OPEN-EDITORS-research.md §2.2） |
| `webview/context`      | webview **内容区**右键（用户右击 webview 渲染的 HTML，经 `data-node-id` 触发） | 不相关（不是 tab 右键）                                                                                                    |

**`when` 子句精度（关键设计点）**：

- `activeWebviewPanelId == 'claudeVSCodePanel'`——精确，但**只在右击活动 tab 时为真**，多 panel 用户右击背景 tab 会漏。
- `resourceScheme == 'webview'`——较宽，覆盖**所有** webview tab 右击；companion 命令 handler 内自己校验 active tab 是 CC panel（读 `globalThis.__ccsdActiveSid`，非空 = CC tab 活跃）后再行动。

**裁决**：v0.4 ship `when: "resourceScheme == 'webview'"` + handler 内校验。理由：(1) 该用户场景下窗口内的 webview tab 几乎全是 CC（CC 是该用户主导的 webview-panel 扩展）；(2) 命中非 CC webview 时 handler 静默 no-op，UX 损耗极低；(3) 多 panel power-user（"同时开 3 个 CC 会话"）正是目标用户群，必须覆盖背景 tab 右击。

**命令 handler 无 URI 问题**：webview panel 无文件 URI，命令 handler 收到的是 `undefined`——必须自己查"当前 active CC tab 的 sid"，走 `globalThis.__ccsdActiveSid`（patch.ts:2361/2615 已维护）。

**与 CC 自身菜单竞争检查**：CC package.json 当前 `contributes.menus` 只有 `editor/title` + `commandPalette`（**没有** `editor/title/context`），我们不与 CC 抢菜单位。安全。

---

### Q3 — tab icon 复合（dot + star）：v0.4 走方案 (c)，方案 (a) 推迟 v0.5

**事实**：`WebviewPanel.iconPath` 类型 = `Uri | { light: Uri; dark: Uri } | undefined`（官方 API + 源码 `WebviewInput.getIcon(): isDark(theme) ? _iconPath.dark : (_iconPath.light ?? _iconPath.dark)`）。**light/dark 双图支持**。**每 panel 只有一个 iconPath 槽**，没有独立 overlay/badge 槽——无法把"状态点"和"星"分两层独立设置。

**三方案对比**：

| 方案                                     | 变体数                                                                | 工作量                       | 副作用                                                                                                                                                                                                                        | 评估                          |
| ---------------------------------------- | --------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **(a) 笛卡尔积 SVG** (state × favorited) | 5×2 = **10 SVG**（idle/running/done/error/pending 各加 `-star` 变体） | 中（脚本生成 + 视觉 review） | IIFE tick 加一查"sid 是否收藏"选 `…-star.svg` vs `…svg`；`__ccsdUriCache`（patch.ts:1946）处理 10 项零负担；interrupted-flash 的 off 帧（patch.ts:2421 `CC_DEFAULT`）不控、500ms 闪烁无星                                     | **v0.5 可选**（用户反馈驱动） |
| **(b) tab title 前缀 `★ `**              | 0 新 SVG                                                              | 低                           | **污染 window title**（title 同步 Open Editors / window title）；CC 的 `rename_tab` 每次 fire 覆盖 `this.panelTab.title`（patch.ts:1526 ANCHOR_B），我们要在每 500ms tick 重补前缀，与 CC 写有竞态闪烁；"★" 无法表达呼吸/快闪 | **否决**                      |
| **(c) 星只在 Favorites 视图，tab 不动**  | 0 新 SVG                                                              | 极低                         | tab 无星标；用户在 Favorites 视图看 `$(star-full)`/`$(star-empty)` 即可                                                                                                                                                       | **v0.4 采纳**                 |

**裁决**：v0.4 走 (c)。理由：

1. **02_简单检查清单.md R-CHG-01（变更放大率）**：方案 (a) 为单一功能变体新增 5 SVG 文件 + 扩展 OUR_SVGS（patch.ts:426）+ 扩展 installRuntimeFiles 清扫（patch.ts:4205/4240）+ 扩展 IIFE tick 选择逻辑 + 新增 test-iife.mjs 断言。这是一次性成本，但**收益有限**——状态点已在 tab 上，星是冗余视觉提示。
2. **方案 (c) 让 MVP 边界更干净**：companion 完整 owns 星的呈现（ThemeIcon），IIFE 零改动。Slice 1（纯文件收藏 + 视图）可完全不碰 IIFE。
3. **用户反馈驱动**：若用户反馈"tab 上也想要星"，v0.5 再做方案 (a) 的精简版——只需新增 `claude-logo-{idle,running}-star.svg` 2 个变体（done/error/pending 短暂态可省略 star 变体），而非全 5。
4. **02_简单检查清单.md §6.3 review 三问 #1**：方案 (a) 不会引入"第二套做同一件事的方式"（SVG 选择仍是单一决策点），但方案 (c) 让 v0.4 的 IIFE 改动面**归零**，概念完整性最高。

**v0.5 触发条件**：用户在 v0.4 发布后明确反馈"tab 上也要星标"。

> **v0.5.0 更新（已实施）**：v0.5.0 落地变体 **(d) 金线下划线**（方案 a 的视觉精简版——不引入星标形状，只在 viewBox 底部加细金线 `<rect>` fill #F5A623，base 5 SVG byte-identical 不动）。理由：(1) 比星标更不喧宾夺主（5 态点+状态色保持视觉主导）；(2) 5 base × 1 favorited = 5 -fav 变体（而非 a 的 10 SVG，因为状态圆 fill 不变，只需在尾部追加同一 rect）；(3) IIFE 选择逻辑同方案 a（mtime-cache 读 favorites.json，sid 命中 → leaf `.svg` → `-fav.svg`），3 处 iconPath 应用点用 `favOf(svg,sid)` 包裹。**方案 a 星标路径仍可选**（未来若用户反馈金线不够醒目可切方案 a 的 `…-star.svg`），目前金线变体是 v0.5 的默认实现。

---

### Q4 — CC 会话收藏 + 导航：已开会话可达、已闭会话不可达

**sid 已就绪**：IIFE 通过 ANCHOR_A 已 stash `t.__ccsdSid`、`t.__ccsdTitle`、`globalThis.__ccsdActiveSid`、`globalThis.__ccsdLastActiveSid`（patch.ts:2361, 2615, 2594-2617 实测）。会话 id 在 CC EH 内**随手可得**，不需新 patch anchor。

#### Q4.1 companion ↔ IIFE 通信

**关键事实**：companion 与 CC **在同一窗口的同一 EH 进程**（VSCode 所有扩展共享一个 EH），**共享 `globalThis`**。IIFE 已在 globalThis 上发布 20+ 键（`__ccsdPanelCount` patch.ts:1925、`__ccsdActiveSid`、`__ccsdSbi`、`__ccsdTokSbi`、`__ccsdRenderMap`、`__ccsdPendingSet`、`__ccsdRateChart` 等）。**companion/extension.ts:621 已在读 `globalThis.__ccsdSbi`**——这是项目已建立的、经验证的桥模式，零新基础设施。

**通道选择**：

| 通道                                                                  | 机制                                                                                                                                                                                       | 用途                                               | 采纳？                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ---------------------------- |
| 共享 `globalThis.__ccsdSidToPanel`                                    | IIFE 在 §A preamble 写 `{[sid]: t.panelTab}`、§Z onDidDispose 删；companion 直读 `globalThis.__ccsdSidToPanel[sid]?.reveal()`                                                              | 已开会话导航（热路径）                             | **是（主路径）**             |
| `vscode.commands.executeCommand('ccStatusDot.fav.focusSession', sid)` | IIFE 用 `vs.commands.registerCommand`（**registerCommand 不需 package.json contribution**，patch.ts:639-641 注释明示此点，SBI_CLICK_CMD/TOK_CLICK_CMD 已是此模式）注册命令；companion 触发 | 命令跨 EH 边界由 VSCode 编排，未来 EH 隔离化后仍稳 | **是（兜底路径，冷路径用）** |
| 共享 `favorites.json`                                                 | companion 单写，IIFE mtime-cache 读                                                                                                                                                        | 持久化（不用于实时通信）                           | **是（仅持久化）**           |

**裁决**：双通道。热路径（companion → 切 panel）走 globalThis；冷路径（点击树节点 → reveal）同时走 command 兜底，EH 未来隔离化也能 fallback。

#### Q4.2 已开会话导航（open panel）— 可达

IIFE 新增最小桥（两处，均不在 ANCHOR_A/ANCHOR_B 字符串内）：

- §A preamble 加：`globalThis.__ccsdSidToPanel=globalThis.__ccsdSidToPanel||(Object.create(null));globalThis.__ccsdSidToPanel[t.__ccsdSid]=t.panelTab;`
- §Z onDidDispose 加（在 patch.ts:2432 现有 dispose 体内）：`try{if(globalThis.__ccsdSidToPanel)delete globalThis.__ccsdSidToPanel[t.__ccsdSid]}catch(_){}`

companion 树节点点击 handler：`const p = globalThis.__ccsdSidToPanel?.[sid]; if (p) { p.reveal(vscode.ViewColumn.Active, false); p.reveal(); return; }` 失败再降级到"已闭会话"路径（见下）。

#### Q4.3 已闭会话重开（closed panel）— **不可达**，文档化

**三项证据**（D 实测）：

1. **CC 公开 VSCode 命令无 sid 参数**：CC package.json `contributes.commands` 列 23 个命令，无一带 sessionId。`claude-vscode.editor.open`、`editor.openLast`、`reopenClosedSession`（重开**最后**关闭的，LIFO 栈，非 sid 可寻址）、`newConversation`、`window.open`、`sidebar.open`、`primaryEditor.open`。
2. **CC 内部 JSON-RPC 有 `listRemoteSessions` / `resumeSessionAt` / `case "list_remote_sessions"`**（CC extension.js minified 可见）——但这些是 CC webview 前端 ↔ EH 后端的**私有协议方法**，**不暴露为 VSCode 命令**。从外部调用需 monkey-patch CC 的 request transport——侵入、脆弱、CC 每次更新都会坏。
3. **CLI `claude -r <sid>`**（`claude --help` 验证：`-r, --resume [value]  Resume a conversation by session ID`）**开的是终端会话，不是 CC webview panel**。在 VSCode 内 CC 的 UX 是 webview panel（CC 扩展的全部意义所在）；spawn 终端 CC 会话是不同表面，**不会注入我们的 IIFE**（无 panel 可注入），UX 困惑。

**CC panel 的 viewType 由 CC 扩展私有注册**，companion 不能用 `vscode.window.createWebviewPanel("claudeVSCodePanel", ...)` 冒充——VSCode 会拒（viewType 注册是扩展私有行为，未注册的扩展不能用别人的 viewType）。

**裁决**：已闭会话**不实施重开**。Favorites 视图中已闭会话灰显（`$(comment)` + 文案"(closed)"），右键菜单提供：

- **"Copy `claude -r <sid>` to Clipboard"**（companion 调 `vscode.env.clipboard.writeText`）
- **"Open Terminal with `claude -r <sid>`"**（companion 调 `vscode.window.createTerminal`，cwd 用 sid 的 `cwd` 字段，预填命令）——用户在集成终端继续，明确不是 webview panel。

**未来 hook**：在 CHANGELOG 注明"已闭会话重开依赖 CC 上游暴露公开 `claude-vscode.session.open` 命令（带 sid 参数）——已向 Anthropic 提 feature request；CC 上线该命令后本扩展可在 24h 内接入"。CC 2.1.216 已声明 `claude-sessions-sidebar`（gated by `claude-vscode.sessionsListEnabled`），是 Anthropic 自建会话列表的信号——持续观察。

---

### Q5 — favorites.json schema

**位置**：`~/.claude/cc-tab-status/favorites.json`（即 IIFE 现有 `STATE_DIR` / `DIR`，patch.ts:219 `STATE_DIR = path.join(os.homedir(), ".claude", "cc-tab-status")`）。

**为什么是 STATE_DIR 而非 INSTALL_DIR**：

- **语义正确**：STATE_DIR 是**每会话用户状态**（`<sid>.json` / `<sid>.offset` / `<sid>.tokens.json` 已在此目录，D 实测确认）；favorites 是用户状态，归属一致。INSTALL_DIR（`~/.claude/cc-status-dot/`）是**扩展管理**（patch.js / companion-config.json / last-repatch.json / hooks/ / resources/），不该混入用户状态。
- **IIFE 零新路径**：IIFE 的 `DIR` 变量已指向 STATE_DIR，读 favorites.json 即 `pth.join(DIR, "favorites.json")`——零新常量、零新路径 plumbing。
- **companion 已熟**：companion 已读 STATE_DIR（D 调研实证：sid JSON 在此）。

**Schema**（版本化，前向兼容）：

```json
{
  "version": 1,
  "updatedAt": 1784652163606,
  "sessions": [
    {
      "sid": "90cc10fb-1d9a-4397-9be1-ea98b0685bb2",
      "label": "cc-status-dot favorites feature",
      "cwd": "/Users/wangdong/Documents/Project/vscode-cc-提示插件/claude-code-status-dot",
      "transcript_path": "/Users/wangdong/.claude/projects/-Users-...-project/90cc10fb-….jsonl",
      "model": "glm-5.2",
      "state": "done",
      "addedAt": 1784652163606,
      "lastSeenAt": 1784652163606
    }
  ],
  "files": [
    {
      "fsPath": "/Users/wangdong/Documents/Project/vscode-cc-提示插件/claude-code-status-dot/patch.ts",
      "label": "patcher entry",
      "line": 1503,
      "workspace": "/Users/wangdong/Documents/Project/vscode-cc-提示插件/claude-code-status-dot",
      "addedAt": 1784652163606
    }
  ]
}
```

**字段说明**：

- `version` — schema 演进预留（项目已用 INJECT_VERSION 版本化 IIFE 契约，同纪律）。
- `sessions[].sid` — UUID，单一稳定主键（= `~/.claude/cc-tab-status/<sid>.json` 文件名）。`label` 可变（默认取 transcript 首条 user prompt 或 sid 前 8 位）。
- `sessions[].cwd` + `transcript_path` — **收藏时**从活动 sid JSON 快照（不靠 sid 推导），让条目**自包含**。CC 删 sid JSON 后（SessionEnd 清理，`.tokens.json` 快照活下来）仍能拼出 `claude -r` 命令。
- `sessions[].model` — tooltip 展示（镜像现有 token SBI tooltip 模式）。
- `sessions[].state` — 收藏时的状态快照（仅展示用，不订阅更新）。
- `sessions[].addedAt` / `lastSeenAt` — 排序 + dedupe；`lastSeenAt` 每次 IIFE 在 `__ccsdSidToPanel[sid]` 命中时刷新（异步、best-effort）。
- `files[].fsPath` — 绝对路径。
- `files[].line` — 可选游标位置（reveal at line），支持"收藏一个 TODO 位置"工作流。
- `files[].workspace` — 多根工作区过滤用。

**读写分工**：

| 角色      | 读                                                                                                                                 | 写                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| companion | 完整 schema（启动加载 + fs.watch 2s 轮询刷新树）                                                                                   | **唯一写者**（atomic write，复用 patch.ts:1662 `writeAtomicSync` 模式：tmp + rename）                         |
| IIFE      | **仅** `sessions[].sid` 集合（mtime-cache 进 `globalThis.__ccsdFavorites`，每 N tick 刷新，复用 patch.ts §F `__ccsdAgCache` 模式） | **不写**（包括不刷 `lastSeenAt`——避免读写竞态；`lastSeenAt` 由 companion 在用户打开Favorites 视图时批量更新） |

**竞态保护**：companion 是唯一写者 + atomic write（tmp + rename）。用户手编 favorites.json 时 fs.watch fire → companion reload。多窗口同时写：last-writer-wins（可接受，favorites 是用户偏好不是关键数据）。

---

## 2. 架构决策：companion-based

### 2.1 组件分工

```
┌─────────────────────────────────────────────────────────────────┐
│  companion/package.json (静态贡献，CC 更新动不到)               │
│    contributes.views.explorer: [{ id:"ccStatusDot.favorites" }] │
│    contributes.commands: fav.* (6 个)                           │
│    contributes.menus: editor/title/context + view/item/context  │
│    + explorer/context + view/title + commandPalette             │
│    contributes.configuration: ccStatusDot.fav.* (新增)          │
└─────────────────────────────────────────────────────────────────┘
                              ↓ activate()
┌─────────────────────────────────────────────────────────────────┐
│  companion/extension.ts (EH 进程，与 CC 同 EH)                  │
│    · createTreeView('ccStatusDot.favorites', provider)          │
│    · FavoritesProvider implements TreeDataProvider              │
│    · 命令 handlers: toggleFile / toggleTab / open / remove /    │
│      copyResume / refresh                                       │
│    · favorites.json atomic read/write (STATE_DIR)               │
│    · 读 globalThis.__ccsdActiveSid 拿当前 CC sid               │
│    · 读 globalThis.__ccsdSidToPanel[sid] 调 .reveal()          │
│    · detectAndPatch() 自愈主线 **保留不动**                     │
└─────────────────────────────────────────────────────────────────┘
                              ↕ 共享 globalThis（已验证桥）
┌─────────────────────────────────────────────────────────────────┐
│  IIFE (跑在 CC EH，patch.ts buildIIFE 注入)                     │
│    [新增] §A preamble: 写 globalThis.__ccsdSidToPanel[sid]      │
│    [新增] §Z onDidDispose: 删 globalThis.__ccsdSidToPanel[sid]  │
│    [可选 v0.5] §H tick: mtime-cache 读 favorites.json 选星 SVG  │
│    [保留] 不动 ANCHOR_A / ANCHOR_B 字符串                       │
└─────────────────────────────────────────────────────────────────┘
                              ↕ favorites.json (持久化)
┌─────────────────────────────────────────────────────────────────┐
│  ~/.claude/cc-tab-status/favorites.json (STATE_DIR)             │
│    companion 单写、IIFE 单读 sid 集合                           │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 为什么 companion-based 是唯一合理路径

四路调研（A/B/C/D）**独立收敛**到同一结论：

1. **VSCode 公开 API 硬约束**（B）：`registerTreeDataProvider` 无对应 package.json contribution → 视图 silent no-op。
2. **项目历史教训**（C）：v0.1.13 已试 patch CC package.json，v0.1.14 已废弃。重走 = 复活已知坏架构。
3. **companion 现成可用**（A/B/C/D）：已是合法 .vsix，已 contributes 9 项 configuration，加 views/commands/menus 是正常版本 bump，**不是架构变更**。
4. **分发链不变**（D）：companion 已随 npm 包发、patch.ts:installCompanion 已自动装。加贡献点不需要新分发机制。
5. **CC 更新隔离**（B/C/D）：companion 走 VSCode 扩展管理，**完全不受 CC 自动更新影响**。IIFE 那侧的新增（`__ccsdSidToPanel` 桥）跟着 CC extension.js 走，已有自愈机制覆盖。

### 2.3 否决的其他架构

| 备选                                             | 否决理由                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 单开新扩展 `cc-status-favorites`（A 提示的权衡） | companion 已在装、已在跑、已自愈。新开扩展 = 新 .vsix、新激活事件、新 globalThis 命名空间隔离（实际不会隔离，仍同 EH），徒增分发复杂度。companion 当前 README 声明"没命令没视图"是历史定位，**定位随产品演进是正常的**——v0.3.0 已把 companion 从"纯自愈"扩到"自愈 + 图表面板 webview"，v0.4.0 再扩到"自愈 + 收藏视图"是同一节奏。**02_简单检查清单.md §E #11**：这是演进迁移，不是熵退化。 |
| IIFE 内 registerTreeDataProvider                 | VSCode 硬约束否决（见 Q1）。                                                                                                                                                                                                                                                                                                                                                               |
| patch CC package.json                            | 项目历史否决（见 Q1）。                                                                                                                                                                                                                                                                                                                                                                    |

---

## 3. MVP 范围 vs 完整范围 vs 文档化不实施

### 3.1 MVP 必做（v0.4.0，低风险）

| #   | 工作项                                                                                                                                                                                                      | 风险                                           | 涉及文件                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| M1  | companion Explorer 视图（`views.explorer`）                                                                                                                                                                 | 低                                             | companion/package.json                          |
| M2  | companion 命令：`fav.toggleFile` / `fav.open` / `fav.remove` / `fav.refresh` / `fav.copyResume`                                                                                                             | 低                                             | companion/package.json + companion/extension.ts |
| M3  | companion 菜单：`explorer/context`（文件右键加入收藏）、`view/item/context`（树节点右键 remove/copyResume）、`view/title`（refresh）、`commandPalette`                                                      | 低                                             | companion/package.json                          |
| M4  | FavoritesProvider（TreeDataProvider）+ TreeItem（ThemeIcon `$(star-full)`/`$(star-empty)`/`$(file)`/`$(comment-discussion)`）+ viewsWelcome 空态                                                            | 低                                             | companion/extension.ts                          |
| M5  | favorites.json atomic 读写（schema version 1）+ fs.watch 2s 轮询                                                                                                                                            | 低                                             | companion/extension.ts                          |
| M6  | 文件导航：`vscode.window.showTextDocument(uri, {selection: lineRange})`                                                                                                                                     | 低                                             | companion/extension.ts                          |
| M7  | IIFE `__ccsdSidToPanel` 桥（§A preamble + §Z onDidDispose）+ IIFE `registerCommand('ccStatusDot.fav.focusSession', ...)` 兜底                                                                               | 中（IIFE 字节变动，需新增 test-iife.mjs 断言） | patch.ts                                        |
| M8  | companion tab 右键菜单：`editor/title/context` + `fav.toggleTab` handler（查 `globalThis.__ccsdActiveSid`）                                                                                                 | 中（Q2 when 子句精度依赖实测）                 | companion/package.json + companion/extension.ts |
| M9  | 已开会话导航：`globalThis.__ccsdSidToPanel[sid].reveal()`                                                                                                                                                   | 中（依赖 M7 桥）                               | companion/extension.ts                          |
| M10 | 测试：test-favorites.mjs（schema round-trip + companion 树渲染确定性）+ test-iife.mjs 新增 4 项断言（__ccsdSidToPanel publish/dispose + fs.watch 兜底）+ test-contract-sync.mjs pin companion 视图/命令存在 | 低                                             | hooks/                                          |

### 3.2 完整范围（v0.5+，中风险，用户反馈驱动）

| #   | 工作项                                                                                    | 触发条件                                                                                              |
| --- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| F1  | tab 复合星标 SVG（Q3 方案 a 精简版：只新增 `claude-logo-{idle,running}-star.svg` 2 变体） | 用户反馈"tab 上也想要星"                                                                              |
| F2  | IIFE tick 按 sid 查 favorites.json（mtime-cache）选 `-star.svg` 变体                      | 同上                                                                                                  |
| F3  | 会话 alias / rename / 分组                                                                | 用户反馈"收藏太多需要分组"                                                                            |
| F4  | 跨切面 tag（抄 alefragnani/project-manager `tags` 模式）                                  | 用户反馈"想按 Personal/Work 分类"                                                                     |
| F5  | 已闭会话重开为 CC webview panel                                                           | **依赖 CC 上游**：CC 暴露公开 `claude-vscode.session.open` 命令（带 sid 参数）。在 CHANGELOG 注明依赖 |

### 3.3 文档化不实施（架构性不可达）

| #   | 项目                                                            | 原因                                                                                           | 替代                                                     |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| D1  | 从 sid 单方面重开已闭会话为 CC webview panel                    | CC 无公开 sid-arg 命令；viewType 私有不可冒充；CLI `claude -r <sid>` 开终端非 panel            | 灰显 + Copy resume cmd + Open Terminal                   |
| D2  | 精确把 `editor/title/context` 限定到 CC tab（不含其他 webview） | `when` 子句无 CC 专属键（`activeWebviewPanelId` 只匹配 active tab；非 active CC tab 右击会漏） | `resourceScheme == 'webview'` + handler 内校验（已采纳） |
| D3  | 拦截 CC rename_tab 同步重补 title 前缀星标（方案 b 零变体路径） | 与 CC 写竞态、污染 window title                                                                | 方案 (c) 已替代；v0.5 走方案 (a) 而非 (b)                |

---

## 4. 风险与缓解

> 级别：🔴 = 阻断合并 / 🟡 = 需关注 / 🔵 = review 把关

### 4.1 实施期风险

| #   | 风险                                                                                                                                                                                                                 | 级别 | 缓解                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **190 个 IIFE.\* 测试断言**（hooks/test-iife.mjs）锁 IIFE 字节形状。新增 `__ccsdSidToPanel` 桥 = IIFE 字节膨胀，必须新增对应断言、不破坏既有 190 项。IIFE 括号配平敏感（patch.ts:1826 `(function(t){...})(this)`）。 | 🔴   | 新增 4 项断言：`IIFE.<n> __ccsdSidToPanel published in §A`、`IIFE.<n> __ccsdSidToPanel delete in §Z`、`IIFE.<n> focusSession command registered`、`IIFE.<n> assertCompiles passes`。`npm test` 必须全绿才合并。 |
| R2  | **companion/package.json 改了必须重跑 `companion:package`**，否则 hooks/assert-companion-vsix.mjs FAIL。                                                                                                             | 🔴   | 在 hooks/ 加 assertion：companion/package.json 内有 `views.explorer` / `commands` 中含 `ccStatusDot.fav.*` / `menus."editor/title/context"`。CI 闸门。                                                          |
| R3  | **version-sync 锁**（hooks/test-version-sync.mjs：companion/package.json schema 与 IIFE `cfg.get` 键平价锁，行 238-253）。新增 `ccStatusDot.fav.*` cfg 键必须双端同步。                                              | 🟡   | 新增 cfg 键时同步加锁；companion/package.json 配置项 + IIFE cfg.get fallback 双写。                                                                                                                             |
| R4  | **favorites.json 读写竞态**：companion 写 + IIFE 读。                                                                                                                                                                | 🟡   | companion atomic write（tmp+rename，复用 patch.ts:1662 `writeAtomicSync`）；IIFE mtime-cache（复用 §F `__ccsdAgCache` 模式）；IIFE ≤500ms 内拾取新状态，可接受。                                                |
| R5  | **CC 启动晚于 companion**：companion `onStartupFinished` 激活时，CC 可能尚未首次激活 → `globalThis.__ccsdActiveSid === undefined`、`globalThis.__ccsdSidToPanel === undefined`。                                     | 🟡   | 命令 handler 容错降级：`fav.toggleTab` 提示"先打开一个 CC tab"；`fav.open(session)` 树节点灰显 + "等待 CC patch 就绪"。文件收藏分支（M1-M6）完全不依赖 IIFE，slice 1 独立可用。                                 |

### 4.2 运行期风险

| #   | 风险                                                                                                                                                                        | 级别 | 缓解                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R6  | **CC 更新 wipe IIFE**：CC 自动更新覆盖 extension.js，IIFE 新增的 `__ccsdSidToPanel` 桥跟着丢。                                                                              | 🟡   | 已有自愈机制（companion detect → re-patch → reload）自动恢复。re-patch 完成前 Favorites 视图会话分支显示"等待 CC patch 就绪"短暂窗口；文件收藏分支不受影响。        |
| R7  | **CC 更新改名 `__ccsdSid` 或重构 handler**：Anchor A/B 失配 → 整套 IIFE 失活（不仅收藏）。                                                                                  | 🟡   | 非新增风险——既有 patch.ts 版本戳 + companion 自动 re-patch 兜底。                                                                                                   |
| R8  | **CC 未来自建 first-party Favorites/Pinned**：CC 2.1.216 已声明 `claude-sessions-sidebar`（gated by `claude-vscode.sessionsListEnabled`）。Anthropic 可能发布官方会话列表。 | 🔵   | 命名用强品牌前缀 `ccStatusDot.*`；README 明示"非官方"；定位差异为"**跨资源 pinning（sessions AND files）**"而非"会话列表复制"。CC 上线 first-party 后重新评估范围。 |
| R9  | **多窗口跨窗口同步**：多窗口 VSCode 共享 STATE_DIR（同一份 favorites.json），但每窗口 IIFE 独立。窗口 A 收藏的 panel 在窗口 B 没打开。                                      | 🔵   | `focusSession` 失败时降级提示"该会话未在本窗口打开，是否终端 resume？"。                                                                                            |
| R10 | **transcript GC**：CC 有自己的会话保留策略（24h/48h/30d 多档过期）。过期 sid 的 `claude -r <sid>` 会失败。                                                                  | 🔵   | Favorites 树定期（每分钟）检查 `transcript_path` 存在性，过期项灰显并标"transcript expired"。                                                                       |
| R11 | **registerCommand id 冲突**：CC 注册了同名 command（极低概率，`ccStatusDot.*` 前缀理论可撞）。                                                                              | 🔵   | 沿用 globalThis flag 守卫模式（patch.ts:2054 `__ccsdSbiCmdRegistered` 已是此模式），异常时 degrade。                                                                |
| R12 | **CC 更新周期 vs IIFE 新增行数**：每加一行 IIFE = 自愈机制多恢复一份内容。                                                                                                  | 🔵   | 新增行集中在清晰 banner 的 §A/§Z 小节（`/*FAV BRIDGE*/` 注释块），hooks/test-iife.mjs pin 新 global 存在；既有 intra-version drift 检测覆盖。                       |

### 4.3 调研局限性（诚实声明）

| #   | 项目                                               | 状态                                                                                                                                                                                                                           |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1  | CC viewType 字符串                                 | D 实测 = `claudeVSCodePanel`（CC 2.1.216）。但未在实机跑过 setContext 验证（设计稿阶段）。Slice 2 落地时先做最小 PoC：1 颗 menu item + 1 个 console.log 命令验证 `editor/title/context` 在 webview tab 上 menu item 真的可见。 |
| L2  | `claude --resume <sid>` 在 VSCode 集成终端内的行为 | CLI 文档确认 `--resume, -r` 真实稳定。但**未实机验证**它会复用 transcript 还是 fork 新 sid。Slice 3 落地时实测。                                                                                                               |
| L3  | CC 是否有未公开的 `openChat` 类 command            | 未在 CC extension.js grep 全量搜索（超出本次设计范围）。Slice 3 前补一次 grep。                                                                                                                                                |
| L4  | CC 会话生态完整 survey                             | WebSearch 主搜索限流（2026-07-24 重置）；CCswitch 仓库 web reader 500。"无成熟 CC 会话收藏扩展"是基于有限证据的 best-effort 判断，非穷尽结论。                                                                                 |

---

## 5. 实施次序（3 个 slice，每个可独立 merge）

### Slice 1 — 文件收藏 only（零 IIFE 改动）

**范围**：M1-M6 + M10 的 schema/test 部分。完全不碰 IIFE。

**交付物**：

- companion/package.json 加 views/commands/menus/configuration
- companion/extension.ts 加 FavoritesProvider + 文件 toggle/open/remove + favorites.json atomic 读写
- hooks/test-favorites.mjs 新增（schema round-trip + 树渲染）
- hooks/assert-companion-vsix.mjs 扩展（pin 新贡献点）
- hooks/test-contract-sync.mjs 扩展（pin companion 视图/命令存在）

**风险**：最低。文件收藏走标准 VSCode API（`showTextDocument`），无 IIFE 依赖、无 CC 耦合。**最快交付**。

**验收**：

- 资源管理器头部出现"CC Favorites"勾选项 ✓
- 勾选后左侧出现 Favorites 视图，空态显示欢迎页 ✓
- 文件右键 → "Add to Favorites" → 出现在视图 ✓
- 点击文件节点 → 跳到该文件（支持 line 定位）✓
- 树节点右键 → Remove ✓
- 重启 VSCode 后收藏仍在 ✓

### Slice 2 — 会话收藏 + 已开 panel 切换 + tab 右键

**范围**：M7-M9 + M10 的 IIFE 断言部分。**首次**改 IIFE（加 `__ccsdSidToPanel` 桥）。

**前置 PoC**（R1 缓解）：先做最小验证——

1. companion 暂加 1 颗 `editor/title/context` menu item（命令只 `console.log`）；
2. 打开 CC tab 右击，确认 menu item 可见；
3. 打开普通文件 tab 右击，确认 menu item **也**可见（验证 `resourceScheme == 'webview'` 的宽度）；
4. PoC 通过后再做完整 handler。

**交付物**：

- patch.ts §A preamble 加 `__ccsdSidToPanel` 注册
- patch.ts §Z onDidDispose 加清理
- patch.ts IIFE `registerCommand('ccStatusDot.fav.focusSession', ...)` 兜底
- companion `fav.toggleTab` / `fav.open(session)` handler
- companion `editor/title/context` menu
- hooks/test-iife.mjs 新增 4 项断言

**风险**：中。IIFE 字节变动需测试把关；tab 右键 menu 可见性需 PoC 验证。

**验收**：

- CC tab 右键 → "Star Current CC Tab" → 当前会话进 Favorites ✓
- 树点击已开会话节点 → 切到该 panel ✓
- CC tab 关闭后，对应树节点变灰显"(closed)" ✓
- 重启 VSCode，收藏的会话仍在（已闭的灰显）✓

### Slice 3 — 已闭会话 resume（终端）

**范围**：D1 的降级实现（不重开 panel，只一键开终端 + 复制命令）。

**前置**（L3 缓解）：grep CC extension.js 找有无未公开的 openChat 类 command。若有，进 F5 范围（重开 panel）；若无，按降级方案 ship。

**交付物**：

- companion `fav.copyResume` handler（`vscode.env.clipboard.writeText("claude -r " + sid)`）
- companion `fav.openTerminal` handler（`vscode.window.createTerminal({name:"CC resume", cwd, isTransient:true})` + `terminal.sendText("claude -r " + sid)`）
- 树节点右键菜单加这两项
- transcript 存在性定期检查（R10 缓解）

**风险**：低（终端操作是 VSCode 标准 API）。

**验收**：

- 灰显的已闭会话右键 → "Copy `claude -r <sid>`" → 剪贴板 ✓
- 灰显的已闭会话右键 → "Open Terminal with `claude -r <sid>`" → 集成终端打开 + 命令预填 ✓
- 过期 transcript 项标"transcript expired" ✓

---

## 6. companion/package.json 贡献点详图（实施时直接抄）

> 命名一律 `ccStatusDot.fav.*` 前缀；图标用内置 codicon（`$(star-full)` 等），不新增 SVG 资源（v0.4）。

```jsonc
{
  "contributes": {
    "views": {
      "explorer": [
        {
          "id": "ccStatusDot.favorites",
          "name": "CC Favorites",
          "icon": "$(star-full)",
          "contextualTitle": "CC Favorites",
        },
      ],
    },
    "viewsWelcome": [
      {
        "view": "ccStatusDot.favorites",
        "contents": "No favorites yet.\nRight-click a file in Explorer or a CC tab to add it.\n[Add Command to Palette](command:ccStatusDot.fav.browse)",
        "when": "ccStatusDot.favoritesEmpty == true",
      },
    ],
    "commands": [
      { "command": "ccStatusDot.fav.toggleFile", "title": "Add/Remove File to Favorites", "icon": "$(star-full)" },
      { "command": "ccStatusDot.fav.toggleTab", "title": "Star/Unstar Current CC Tab", "icon": "$(star-full)" },
      { "command": "ccStatusDot.fav.open", "title": "Open Favorite", "icon": "$(go-to-file)" },
      { "command": "ccStatusDot.fav.remove", "title": "Remove from Favorites", "icon": "$(close)" },
      { "command": "ccStatusDot.fav.copyResume", "title": "Copy 'claude -r <sid>'", "icon": "$(copy)" },
      {
        "command": "ccStatusDot.fav.openTerminal",
        "title": "Open Terminal with 'claude -r <sid>'",
        "icon": "$(terminal)",
      },
      { "command": "ccStatusDot.fav.refresh", "title": "Refresh Favorites", "icon": "$(refresh)" },
      { "command": "ccStatusDot.fav.browse", "title": "Favorites: Browse", "icon": "$(list-filter)" },
    ],
    "menus": {
      "explorer/context": [
        { "command": "ccStatusDot.fav.toggleFile", "when": "!explorerResourceIsFolder", "group": "ccsd_favorites@1" },
        // v0.5.3 (F6): also bind toggleTab here (gated resourceScheme != 'file')
        // so CC webview tabs in the Open Editors view get the favorite command
        // on right-click. toggleTab handler ignores resourceUri → safe reuse.
      ],
      "editor/title/context": [
        { "command": "ccStatusDot.fav.toggleTab", "when": "resourceScheme == webview", "group": "ccsd_favorites@1" },
      ],
      "view/title": [
        { "command": "ccStatusDot.fav.refresh", "when": "view == ccStatusDot.favorites", "group": "navigation@1" },
        { "command": "ccStatusDot.fav.browse", "when": "view == ccStatusDot.favorites", "group": "navigation@2" },
      ],
      "view/item/context": [
        {
          "command": "ccStatusDot.fav.open",
          "when": "view == ccStatusDot.favorites && viewItem =~ /^ccsdFav(favSessionOpen|favFile)$/",
          "group": "inline@1",
        },
        {
          "command": "ccStatusDot.fav.remove",
          "when": "view == ccStatusDot.favorites && viewItem =~ /^ccsdFav/",
          "group": "inline@2",
        },
        {
          "command": "ccStatusDot.fav.copyResume",
          "when": "view == ccStatusDot.favorites && viewItem =~ /^ccsdFavfavSession/",
          "group": "9_cuts@1",
        },
        {
          "command": "ccStatusDot.fav.openTerminal",
          "when": "view == ccStatusDot.favorites && viewItem == ccsdFavfavSessionClosed",
          "group": "9_cuts@2",
        },
      ],
      "commandPalette": [
        { "command": "ccStatusDot.fav.toggleFile", "when": "resourceLangId != undefined" },
        { "command": "ccStatusDot.fav.toggleTab", "when": "activeEditor == 'claudeVSCodePanel'" },
        { "command": "ccStatusDot.fav.refresh" },
        { "command": "ccStatusDot.fav.browse" },
      ],
    },
    "configuration": {
      "title": "cc-status-dot",
      "properties": {
        "ccStatusDot.fav.includeInEditorTabContextMenu": {
          "type": "boolean",
          "default": true,
          "description": "Show the 'Star/Unstar Current CC Tab' item in the CC tab right-click menu.",
        },
        "ccStatusDot.fav.includeInExplorerContextMenu": {
          "type": "boolean",
          "default": true,
          "description": "Show 'Add/Remove File to Favorites' in the Explorer file right-click menu.",
        },
      },
    },
  },
}
```

**TreeItem `contextValue` 命名约定**（viewItem 分型，抄 kdcro101 FAVORITE_FILE/GROUP 模式）：

- `ccsdFavfavSessionOpen` — 已开会话（图标 `$(comment-discussion)` + 金星 `$(star-full)` overlay 通过 description 实现）
- `ccsdFavfavSessionClosed` — 已闭会话（灰显，`$(comment)`）
- `ccsdFavfavFile` — 文件（`$(file)`）

---

## 7. 架构简单性自审（按 02_简单检查清单.md）

> 本节按 `/Users/wangdong/Documents/Project/架构想法/02_简单检查清单.md` 的四刻度 + 适应度函数自审。

| 规则 ID  | 规则                                          | 起点      | 本设计命中                                                                                                                                                                                         | 评估                                                                                                                                      |
| -------- | --------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| R-INT-02 | 开闭违反（新增变体要改多处 ≥3）               | ≥3 处     | 新增一个收藏类型（如"snippet 收藏"）：改 schema + TreeItem 分型 + provider getChildren + 命令 handler ≈ 4 处                                                                                       | 🟡 命中阈值。**缓解**：viewItem 正则 `=~ /^ccsdFav/` 让 menu 共享（只加一处），schema 用 discriminated union。可接受。                    |
| R-INT-05 | PR blast radius（文件 >10 或跨 >3 模块）      | —         | 完整 v0.4 拆 3 slice，单 slice ≤ 6 文件                                                                                                                                                            | ✅ 不命中（slice 纪律）                                                                                                                   |
| R-DEP-01 | public API 表面过大（>7 方法 或 >4 构造参数） | —         | FavoritesProvider 实现 TreeDataProvider（2 方法 getTreeItem/getChildren）+ 命令 handlers（6 个独立函数，非类方法）                                                                                 | ✅ 不命中                                                                                                                                 |
| R-DEP-03 | 穿堂式方法 = 0                                | =0        | 命令 handlers 都含实质逻辑（读写 favorites.json + 调 VSCode API + 调 IIFE 桥）                                                                                                                     | ✅ 不命中                                                                                                                                 |
| R-DEP-05 | 信息泄漏（实现细节跨模块 >0）                 | —         | IIFE 仅读 sid 集合（schema 子集），不读 files[]/label/cwd；favorites.json 格式细节不跨 EH 边界                                                                                                     | ✅ 不命中                                                                                                                                 |
| R-CHG-01 | touches-per-change ≥5 文件                    | ≥5        | 新增功能：companion/package.json + companion/extension.ts + patch.ts + hooks/test-favorites.mjs + hooks/test-iife.mjs + hooks/test-contract-sync.mjs = 6 文件（**新增**功能，非 per-variant 改动） | 🟡 命中阈值。**评估**：02_简单检查清单.md 原文"周期级按 feature 聚合"——这是 1 个 feature 触及 6 文件，是合理的 feature 体量，不是熵退化。 |
| R-CI-01  | 术语一致性（同概念多名字）                    | 同义名 >1 | 全前缀 `ccStatusDot.fav.*` / 全文 `Favorites`（非 Favourites/Star/Pin 混用）；命名表 1 份                                                                                                          | ✅ 不命中                                                                                                                                 |
| R-CI-02  | 横切关注点变体（同一类操作多种做法 >1）       | >1 种     | 跨扩展通信 = 共享 globalThis（**唯一**模式，已建立）；写文件 = `writeAtomicSync`（**唯一**模式，复用 patch.ts:1662）                                                                               | ✅ 不命中                                                                                                                                 |
| R-FF-01  | 分层/依赖方向                                 | 🔴        | UI 层（companion 命令/视图）→ 服务层（FavoritesProvider 逻辑）→ 数据层（favorites.json）；IIFE 仅暴露 `__ccsdSidToPanel`（只读 ref）。无 UI 层直读 sid JSON（经 provider）。                       | ✅ 不命中                                                                                                                                 |
| R-FF-02  | 循环依赖                                      | 🔴        | companion → globalThis（单向）；IIFE → favorites.json（单向，只读 sid 集合）。无环。                                                                                                               | ✅ 不命中                                                                                                                                 |
| R-FF-04  | 穿堂式方法 = 0（= R-DEP-03）                  | 🔴        | 同 R-DEP-03                                                                                                                                                                                        | ✅ 不命中                                                                                                                                 |

**自审结论**：无 🔴 违例；2 项 🟡 命中阈值但均有合理理由（slice 纪律已最小化 blast radius；新增功能触 6 文件是 feature 体量非退化）。**架构层面简单性达标**。

**review 三问**（§6.3，挂 PR 模板）：

1. _是否引入"第二套做同一件事的方式"？_ — 否。跨扩展通信复用既有 globalThis 桥；持久化复用 `writeAtomicSync`；视图贡献复用 companion package.json 既有 contributes.configuration 通道。
2. _新增抽象暴露 what 还是 how？_ — what。FavoritesProvider 暴露"列/增/删收藏项"语义；调用方不知 favorites.json 路径/schema/序列化细节。
3. _共享函数新增参数/caller 分流？_ — 否。命令 handler 一对一，无 flag 参数蔓延。

---

## 8. 版本与发布

- **版本 bump**：patch.ts COMPANION_VERSION @502 + INJECT_VERSION @147 + 主 package.json + companion/package.json 同步 `0.3.1 → 0.4.0`（minor bump，向后兼容）。
- **README/CHANGELOG/STATES.md** 同步更新（项目惯例：9 个 README locale 全更新；本次新增 §"Favorites View"小节）。
- **companion/README.md** 当前文案"没有状态栏、没有命令、没有设置，纯粹的自愈看护"（companion/README.md:16-17）**必须改**——这是定位演进，不是文档漂移（02 §E #11）。
- **发布顺序**：Slice 1 → 0.4.0-alpha.1；Slice 2 → 0.4.0-beta.1；Slice 3 → 0.4.0 正式。

---

## 9. 不破坏清单（实施时回归验证）

实施期间每 slice merge 前必须验证以下功能不退化：

- [ ] 5 态点（idle/running/done/error/pending）色彩语义不变（v0.4 不动 tab icon，零风险）
- [ ] 底部 4 灯 SBI、token SBI、图表面板（v0.3.0）完整保留
- [ ] Q1-Q7 全部历史修复（v0.2.4 ~ v0.2.9.1 + v0.3.0）保留
- [ ] v0.2.8 src 拷贝（`companion:package` 流程不变）
- [ ] v0.3.1 nonce CSP 最佳实践（若 Favorites 视图引 webview 必须沿用 nonce 模式；v0.4 用 TreeView 非 webview，不涉及）
- [ ] IIFE 括号配平（`assertCompiles` patch.ts:1761 通过）
- [ ] companion 自愈主线（`detectAndPatch`）不被收藏逻辑阻塞或干扰——收藏逻辑写在 `detectAndPatch()` 之后、fire-and-forget
- [ ] standalone patch.js 可独立跑（`npm run test:standalone` 通过）
- [ ] 680+ 既有测试不退化（`npm test` 全绿）
- [ ] 190 个 `IIFE.*` 断言不破坏（Slice 2 新增 4 项后总计 194 项全绿）
- [ ] version-sync 平价锁（companion/package.json cfg ↔ IIFE cfg.get）维持

---

## 10. 附录：调研交叉引用表

| 问题                | 主证据来源                                                                         | 把握度                                  |
| ------------------- | ---------------------------------------------------------------------------------- | --------------------------------------- |
| Q1 Path B           | B（官方 docs）+ C（项目历史 patch.ts:2947-2986）+ D（companion/package.json 实测） | high（三路独立收敛）                    |
| Q2 webview tab 右键 | B（官方 menus 文档）+ D（CC extension.js grep `claudeVSCodePanel` 实测）           | high                                    |
| Q3 方案 c           | B（推荐 v0.4 走 c）+ C（推荐 a 但承认工作量）+ D（推荐 a）+ 02 R-CHG-01（推 c）    | high（决策明确，方案 a 推迟是范围纪律） |
| Q4 已开 panel       | B/C/D 一致：globalThis 桥 + reveal()                                               | high                                    |
| Q4 已闭 panel       | D（CC package.json 命令枚举 + CLI 文档 + viewType 私有）                           | high（不可达）                          |
| Q5 favorites.json   | C/D（STATE_DIR 位置）+ A/B（schema 字段建议）                                      | high                                    |

---

## 11. GO/NO-GO 最终判定

### 裁决：**PARTIAL-GO**（MVP + 文档化边界）

**GO（全量实施）于**：

- ✅ Q1 companion-based 视图贡献（架构明确无问题）
- ✅ Q2 webview tab 右键（架构可行 + `when` 子句策略明确）
- ✅ Q3 方案 (c) 星在 Favorites 视图（v0.4 MVP）
- ✅ Q4 已开会话导航（globalThis 桥 + reveal）
- ✅ Q5 favorites.json schema（已定）

**PARTIAL（MVP + 文档）于**：

- 🟡 Q3 方案 (a) tab 复合星标 SVG → 推迟 v0.5（用户反馈驱动）
- 🟡 Q4 已闭会话重开为 panel → 不可达，文档化降级（copy cmd + terminal）

**NO-GO（仅设计文档，不实施）于**：

- ❌ 无。所有架构性问题已解清，不存在阻断实施的未决点。

**判定依据**：四个独立调研流（A/B/C/D）在 Q1/Q2/Q4/Q5 上**完全收敛**；Q3 是范围选择（c vs a）而非架构未知；架构性不可达项（Q4 已闭会话重开）已**文档化降级**。**架构层面明确无问题**——满足 GO 条件，但因范围纪律（02 §5.5 R-ABS 抽象成本）将方案 (a) 推迟 v0.5，故为 PARTIAL-GO 而非全量 GO。

**下一步**：按 §5 三个 slice 实施。Slice 1 可立即开工（零 IIFE 改动、零 CC 耦合）。

---

## 12. v0.4.0 实施摘要（落地范围 vs 推迟清单）

**实施裁决**：采纳 PARTIAL-GO 的"安全 MVP"路径——实施 Slice 1（文件收藏）+ Slice 2 安全部分（IIFE 桥 + 已开会话 reveal + toggleTab via 命令面板），推迟 Slice 2 风险部分（tab 右键 menu）+ Slice 3（terminal open）+ Q3 方案 a（tab 复合星标）至 v0.5。

### 12.1 已实施（v0.4.0 落地）

| #       | 设计工作项                                                                    | 实施位置                                                                               | 状态           |
| ------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------- |
| M1      | companion Explorer 视图                                                       | `companion/package.json` `contributes.views.explorer`                                  | ✅             |
| M2      | companion 命令                                                                | `companion/extension.ts` `registerFavorites()` 注册 7 命令                             | ✅             |
| M3a     | `explorer/context` 菜单（文件右键）                                           | `companion/package.json` `contributes.menus["explorer/context"]`                       | ✅             |
| M3b     | `view/item/context` 菜单（树节点右键 inline open/remove + 9_cuts copyResume） | `companion/package.json` `contributes.menus["view/item/context"]`                      | ✅             |
| M3c     | `view/title` 菜单（refresh/browse）                                           | `companion/package.json` `contributes.menus["view/title"]`                             | ✅             |
| M3d     | `commandPalette` 公开 toggleFile/toggleTab                                    | `companion/package.json` `contributes.menus["commandPalette"]`                         | ✅             |
| M4      | FavoritesProvider + TreeItem（ThemeIcon）+ viewsWelcome 空态                  | `companion/extension.ts` `class FavoritesProvider`                                     | ✅             |
| M5      | favorites.json atomic 读写 + fs.watchFile 2s 轮询                             | `companion/extension.ts` `writeFavAtomic`/`readFavDoc` + setInterval                   | ✅             |
| M6      | 文件导航：`showTextDocument(uri, {selection})`                                | `companion/extension.ts` `favOpen` file 分支                                           | ✅             |
| M7a     | IIFE `__ccsdSidToPanel` 桥 §A preamble 发布                                   | `patch.ts` buildIIFE §A（在 `globalThis.__ccsdPanelCount=...` 之后）                   | ✅             |
| M7b     | IIFE `__ccsdSidToPanel` 桥 §Z onDidDispose 清理                               | `patch.ts` buildIIFE §Z（在 `delete globalThis.__ccsdPendingSet[...]` 之后）           | ✅             |
| M7c     | IIFE `ccStatusDot.fav.focusSession` 命令兜底                                  | `patch.ts` buildIIFE §D.5（在 `TOK_CLICK_CMD` 注册之后）                               | ✅             |
| M8      | `fav.toggleTab` 命令面板入口（替代 Slice 2 的 tab 右键）                      | `companion/extension.ts` `favToggleTab` 读 `globalThis.__ccsdActiveSid`                | ✅（替代方案） |
| M9      | 已开会话导航：`__ccsdSidToPanel[sid].reveal()` + 命令兜底                     | `companion/extension.ts` `favOpen` sessionOpen 分支                                    | ✅             |
| D1 降级 | 已闭会话 Copy `claude -r <sid>` 到剪贴板                                      | `companion/extension.ts` `favCopyResume`                                               | ✅             |
| M10a    | 新测试 `hooks/test-favorites.mjs` 31 项                                       | schema round-trip + atomic + corrupt/future 降级 + provider/handlers 覆盖 + 负面 guard | ✅             |
| M10b    | `hooks/test-iife.mjs` IIFE.154-157 新增 4 项 FAV BRIDGE 断言                  | §A 发布 / §Z 清理 / focusSession 命令 / handler fail-safe                              | ✅             |
| M10c    | `hooks/test-contract-sync.mjs` 新增 3 项 FAV_FOCUS_CMD 跨文件平价锁           | patch.ts const === companion executeCommand 字面量 === IIFE 烘焙字节                   | ✅             |

### 12.2 推迟到 v0.5+（按设计 §3.2 / §5 Slice 排期）

| #            | 推迟项                                                                                                                                                                                                                                                                                                                     | 触发条件                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| F1/F2        | ✅ **已实施 v0.5.0**（采用变体 d 金线下划线，非方案 a 星标；base SVG 不动，5 -fav 变体 + `<rect>` 金线 fill #F5A623）。方案 a 笛卡尔积 10 SVG 的 IIFE 选择逻辑亦落地（mtime-cache 读 favorites.json）。                                                                                                                    | 已实施（v0.5.0）                                                           |
| Slice 2      | ✅ **已实施 v0.5.0**（`editor/title/context` tab 右键 menu，`when: resourceScheme == 'webview' && config.ccStatusDot.fav.includeInTabContextMenu'`）。PoC 期间验证的最小路径——`resourceScheme == 'webview'` 是 VSCode 暴露的最精确 context key（无 CC 专属 key）；handler 内 `__ccsdActiveSid` 校验对非 CC webview no-op。 | 已实施（v0.5.0）                                                           |
| F3/F4        | 会话 alias / rename / 分组                                                                                                                                                                                                                                                                                                 | 用户反馈"收藏太多需要分组"                                                 |
| F5/D1 完整版 | 已闭会话重开为 CC webview panel                                                                                                                                                                                                                                                                                            | **依赖 CC 上游**：CC 暴露公开 `claude-vscode.session.open` 命令带 sid 参数 |
| Slice 3 可选 | `fav.openTerminal`（在 VSCode 集成终端预填 `claude -r <sid>`）                                                                                                                                                                                                                                                             | v0.4 仅复制命令到剪贴板；用户偏好差异大，剪贴板最中性                      |

### 12.3 不破坏清单验证（设计 §9 回归项）

实施完成后所有以下既有功能保留不退化（`npm test` 全绿 845 断言 + `npm run test:standalone` 通过 + `node --check dist/patch.js + companion/dist/extension.js` 通过 + prettier 全绿 + IIFE 括号配平）：

- ✅ 5 态点（idle/running/done/error/pending）色彩语义不变（v0.4 不动 tab icon）
- ✅ 底部 4 灯 SBI、token SBI、图表面板（v0.3.0）完整保留
- ✅ Q1-Q7 全部历史修复（v0.2.4 ~ v0.2.9.1 + v0.3.0/0.3.1）保留
- ✅ v0.2.8 src 拷贝（`companion:package` 流程不变）
- ✅ v0.3.1 nonce CSP 最佳实践保留（v0.4 未引入新 webview）
- ✅ IIFE 括号配平（`assertCompiles` 通过 + test-iife.mjs IIFE.1 通过）
- ✅ companion 自愈主线 `detectAndPatch` 不被收藏逻辑阻塞（fire-and-forget 之后注册）
- ✅ standalone patch.js 可独立跑
- ✅ version-sync 平价锁维持（package.json 0.4.0 ↔ INJECT_VERSION v0.4.0 ↔ companion 0.4.0 ↔ MIN_PATCHER_VERSION 0.4.0 ↔ injectVersion fallback v0.4.0）

### 12.4 版本与文件清单

**版本 bump**：`package.json` / `patch.ts INJECT_VERSION` / `companion/package.json` / `companion/extension.ts MIN_PATCHER_VERSION` + `injectVersion()` fallback 全部 `0.3.1 → 0.4.0`（minor bump，向后兼容）。`HOOK_VERSION`（v0.2.1）+ `cc-status.js` hash 不变。

**改动文件**（按 02_简单检查清单.md R-CHG-01 "周期级按 feature 聚合"，单一 feature 7 文件是合理体量）：

1. `patch.ts` — IIFE §A/§Z/§D.5 桥 + FAV_FOCUS_CMD const + INJECT_VERSION v0.4.0
2. `companion/package.json` — views/commands/menus/configuration + version 0.4.0 + activationEvents
3. `companion/extension.ts` — FavoritesProvider + handlers + favorites.json + registerFavorites + deactivate 清理 + scope 注释更新 + MIN_PATCHER_VERSION/injectVersion fallback bump
4. `hooks/test-favorites.mjs` — 新文件 31 项断言
5. `hooks/test-iife.mjs` — IIFE.154-157 新增 + IIFE.21c stamp v0.4.0
6. `hooks/test-contract-sync.mjs` — FAV_FOCUS_CMD 跨文件平价锁
7. `package.json`（main）— version 0.4.0 + test script 加 test-favorites + test:favorites 子脚本

**文档同步**：`CHANGELOG.md`（v0.4.0 条目）、`companion/CHANGELOG.md`（v0.4.0 条目）、`companion/README.md`（定位演进：自愈 + Favorites 视图）、本文件（§12 实施摘要）、主 `README.md`（§Favorites View 小节）。

---

## 13. v0.5.0 实施摘要（tab 右键 + 金线下划线）

### 13.1 已实施（v0.5.0 落地）

| 编号       | 实施项                                                                                                            | 落点                                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slice 2    | ✅ `editor/title/context` tab 右键 menu（复用 `ccStatusDot.fav.toggleTab`）                                       | `companion/package.json contributes.menus["editor/title/context"]`，`when: resourceScheme == 'webview' && config.ccStatusDot.fav.includeInTabContextMenu'` |
| Q3 (a→d)   | ✅ tab 复合变体（采用变体 d 金线下划线，非方案 a 星标；5 base SVG byte-identical + 5 -fav 变体只加尾部 `<rect>`） | `resources/claude-logo-{state}-fav.svg` + `patch.ts OUR_SVGS` + IIFE `favOf()` helper                                                                      |
| 持久化分工 | ✅ IIFE 现在读 favorites.json（v0.4 不读；v0.5 mtime-cache 读 `sessions[].sid` 集合）                             | `patch.ts` IIFE §A preamble `readFavSet()` + `favOf()` + 3 处 `iconPath` 应用点包裹                                                                        |
| 配置       | ✅ `ccStatusDot.fav.includeInTabContextMenu`（默认 true）                                                         | `companion/package.json contributes.configuration.properties`                                                                                              |

### 13.2 边界（保留 v0.4 决策）

- **F3/F4 会话 alias / rename / 分组**：未实施，待用户反馈。
- **F5/D1 已闭会话重开为 CC webview panel**：架构性不可达，仍走 Copy 'claude -r <sid>' 降级路径。
- **Slice 3 可选 `fav.openTerminal`**：未实施，剪贴板最中性。

### 13.3 不破坏清单验证（v0.5.0 回归项）

实施完成后所有以下既有功能保留不退化（`npm test` 全绿 884+ 断言 + `npm run test:standalone` 通过 + `node --check dist/patch.js + companion/dist/extension.js` 通过 + prettier 全绿 + IIFE 括号配平）：

- ✅ 5 态点（idle/running/done/error/pending）色彩语义不变（v0.5 仅在 sid∈favorites 时把 leaf `.svg` → `-fav.svg`，状态色/状态圆 fill byte-identical）
- ✅ 底部 4 灯 SBI、token SBI、图表面板（v0.3.0）完整保留
- ✅ Q1-Q7 全部历史修复（v0.2.4 ~ v0.2.9.1 + v0.3.0/0.3.1）保留
- ✅ v0.2.8 src 拷贝（`companion:package` 流程不变）
- ✅ v0.3.1 nonce CSP 最佳实践保留（v0.5 未引入新 webview）
- ✅ IIFE 括号配平（`assertCompiles` 通过 + test-iife.mjs IIFE.1/IIFE.2 通过）
- ✅ companion 自愈主线 `detectAndPatch` 不被收藏逻辑阻塞
- ✅ standalone patch.js 可独立跑
- ✅ version-sync 平价锁维持（package.json 0.5.0 ↔ INJECT_VERSION v0.5.0 ↔ companion 0.5.0 ↔ MIN_PATCHER_VERSION 0.5.0 ↔ injectVersion fallback v0.5.0）
- ✅ v0.4.0 收藏视图/命令/favorites.json schema/导航全保留（v0.5 仅扩 menu + 加 -fav SVG，handler 零改动）

### 13.4 版本与文件清单

**版本 bump**：`package.json` / `patch.ts INJECT_VERSION` / `companion/package.json` / `companion/extension.ts MIN_PATCHER_VERSION` + `injectVersion()` fallback 全部 `0.4.0 → 0.5.0`。`HOOK_VERSION`（v0.2.1）+ `cc-status.js` hash 不变（writer 无改动）。

**改动文件**（按 02_简单检查清单.md R-CHG-01 "周期级按 feature 聚合"，单一 feature 9 文件是合理体量）：

1. `patch.ts` — INJECT_VERSION v0.5.0 + OUR_SVGS 扩 10 项 + IIFE §A preamble `FAVF` / `readFavSet()` / `favOf()` helper + §H tick 3 处 `iconPath` 包裹
2. `resources/claude-logo-{idle,running,done,error,pending}-fav.svg` — 5 新文件（base byte-copy + `<rect fill="#F5A623">` 金线）
3. `companion/package.json` — `editor/title/context` menu + `ccStatusDot.fav.includeInTabContextMenu` 配置 + version 0.5.0
4. `companion/extension.ts` — MIN_PATCHER_VERSION/injectVersion fallback bump（handler 零改动）
5. `hooks/test-iife.mjs` — IIFE.117 翻转（5 → 10 entries）+ IIFE.117a-k 新增 + IIFE.117c-e SVG 几何 parity + IIFE.21c stamp v0.5.0
6. `hooks/test-favorites.mjs` — FAV.31 翻转（v0.4 ABSENCE → v0.5 PRESENCE）+ FAV.31a/b（config + default）
7. `package.json`（main）— version 0.5.0
8. `CHANGELOG.md` — v0.5.0 条目
9. `companion/CHANGELOG.md` — v0.5.0 条目
10. `companion/README.md` + `docs/FAVORITES-DESIGN.md`（本文件 §13 + §12.2/§Q3 标注 + §13.4）— 文档同步

**文档同步**：`CHANGELOG.md`（v0.5.0 条目）、`companion/CHANGELOG.md`（v0.5.0 条目）、`companion/README.md`（v0.5.0 小节）、本文件（§13 实施摘要 + §12.2/§Q3 标注已实施）。
