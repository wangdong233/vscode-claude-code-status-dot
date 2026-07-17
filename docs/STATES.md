# 状态表（单一真相源 · Single Source of Truth）

> 本文件是 **vscode-claude-code-status-dot 的唯一状态契约**。
> **writer**（`hooks/cc-status.js`）、**reader**（`patch.ts` 注入的 IIFE）、**SVG 文件名**、**文档**（README/USAGE/CHANGELOG）、**`package.json`** 必须全部引用本表。
> 任何状态 / 事件 / SVG / 颜色的增删：**先改本表，再机械同步其余各处**。这是审查 F-1~F-6 的收敛点。

---

## 1. 状态枚举（4 态 + 1 原生）

| state | 含义 | 颜色 (hex) | SVG 文件（项目 `resources/`） | 动效 |
|---|---|---|---|---|
| `idle` | 空闲（初始 / 无状态文件 / 完成超 5 分钟） | 灰 `#808080` | `claude-logo-idle.svg` | 静态 |
| `running` | 运行中 | 黄 `#CCA700` | `claude-logo-running.svg` | 静态（无动画；v0.1.3 的 8 帧呼吸因 `iconPath` 切帧本质离散、读作闪烁，v0.1.4 回归静态） |
| `done` | 完成 | 绿 `#3FB950` | `claude-logo-done.svg` | 静态；**reader 在 done 超 5 分钟后渲染为 idle** |
| `interrupted` | 中断（限速 / 出错） | 红 `#F85149` | `claude-logo-error.svg` ↔ CC 默认 `claude-logo.svg` | 快闪（~500ms 切换，on/off） |
| — (permission) | 待用户授权 | 蓝（CC 原生） | CC 原生 `claude-logo-pending.svg` | **reader 不覆盖**，CC 原生蓝点照常显示 |

> 设计决策：`permission` 态不纳入我们的渲染——CC 已有原生蓝点处理 `hasPendingPermissions`，reader 在以下两种情况 `return`（不覆盖图标），CC 蓝点自然生效：
>
> 1. **无外部状态文件 / state 未知**（原 v0.1.7 行为）。
> 2. **permission pending**（v0.1.8 新增）：reader tick 检测到 `t.__ccPending===true` 即 `return`。`__ccPending` 由 `rename_tab` handler（Anchor B）每次触发时从 `e.request.hasPendingPermissions`（CC 用来画蓝点的同一个 flag）就地刷新到 panel 实例上；IIFE 每 500ms 读这个 live flag，pending 期间不抢图标。
>
> 背景：PreToolUse 心跳会在 permission 弹窗前把 `state=running` 落盘，CC 又无 permission-pending hook 事件可纠正该文件；v0.1.7 只在"读不到文件"时 return，故 pending 期间 reader 持续用黄 `running.svg` 盖 CC 蓝点（本 bug）。v0.1.8 让 reader 直接读 CC 自己的 pending flag，不再依赖状态文件是否巧合缺失。避免重复造一套 waiting 态。
>
> **点几何（所有 SVG 统一）**：`viewBox 0 0 24 24`，状态点 `cx=18 cy=6 r=6`，mask 挖空 `r=7.5`（margin 1.5）。16px tab 渲染下点直径 8px，视觉占比 20%（竞品角标黄金比区间：macOS dock badge ~20-25%）。

---

## 2. 事件 → 状态映射（writer 的 case 集 ＝ patcher 的 `HOOK_EVENTS` 接线集，二者必须逐一对齐）

| CC hook 事件 | → 写入 state | 说明 |
|---|---|---|
| `UserPromptSubmit` | `running` | 新一轮开始；`activeSubagents` 用 payload `background_tasks` 纠正，否则保留（不重置 0） |
| `PreToolUse` | `running` | 心跳，刷新 `since` |
| `PostToolUse` | `running` | 心跳，刷新 `since` |
| `SubagentStart` | `running` | **早信号**：subagent 一 spawn 即黄；`activeSubagents` 优先用 `background_tasks` 纠正，否则 +1 |
| `SubagentStop` | `running`（若仍有在飞任务）/ **保持 cur.state（归零时不抢断，写回 activeSubagents:0）** | `activeSubagents` 优先用 `background_tasks` 纠正，否则 −1（clamp 0）；**始终写回**（落盘递减后的计数 + cur.state），归零时不抢断终态、交 `Stop` 裁定。绝不返回 null，否则磁盘上残留陈旧非零计数会误导下一条 `Stop` 误判 running |
| `Stop` | `done`，**除非** `background_tasks`/`activeSubagents > 0` → `running` | 权威裁定：workflow 后台跑期间不假绿（v2.1.145+）；旧版本退化为 `activeSubagents` 计数 |
| `StopFailure` | `interrupted` | 记 `error` 枚举（rate_limit/overloaded/…）；中断优先，保留 `activeSubagents` |
| `SessionEnd` | （删除该 session 状态文件） | 清理 |

**故 `HOOK_EVENTS` = `["UserPromptSubmit","PreToolUse","PostToolUse","SubagentStart","SubagentStop","Stop","StopFailure","SessionEnd"]`**（8 个）。

**故意不接的事件**（及原因，防止死接线）：
- `Notification`：permission 由 CC 原生蓝点处理，reader 不覆盖该态。
- `SessionStart`：writer 无对应 case。

---

## 3. 状态文件 IPC 契约（writer 与 reader 共享）

- 目录：`~/.claude/cc-tab-status/`
- 文件名：`<session_id>.json`
- 字段：`{ "state": "idle|running|done|interrupted", "since": <ms 纪元>, "error"?: "<StopFailure 枚举>", "activeSubagents": <int> }`
  - `activeSubagents`（int，默认 0）：**仅供 writer 记账**（SubagentStart/Stop 计数 + `background_tasks` 纠正）。**reader 不读此字段**——state 仍四态，渲染逻辑零改动（§4）。
  - `background_tasks[]` / `session_crons[]`：**hook payload 字段（CC v2.1.145+），不落盘**——Stop/SubagentStop 时由 writer 就地读取作权威判定（覆盖 workflow/subagent/teammate 等全类型）。
- 写入：**原子**（`.tmp` + `rename`），目录自动创建；writer 为 **read-modify-write**（读当前 `activeSubagents` → 改 → 原子写回）
- reader 读失败（文件不存在 / JSON 破损）→ 跳过本帧，**不覆盖**图标（保留 CC 原生 pending/done）

### 3a. `~/.claude/` 路径地图（两个目录，勿混淆）

| 目录 | 内容 | 由谁创建 | `--revert` 是否清理 |
|---|---|---|---|
| `~/.claude/cc-tab-status/` | **状态 IPC 文件**（本节 §3，每 session 一个 `<sid>.json`） | writer（hook）首次写入 | **否**（用户数据，保留） |
| `~/.claude/cc-status-dot/`（`INSTALL_DIR`） | **运行时副本**：`resources/*.svg`（4 个 = idle + running + done + error，reader 引用）+ `hooks/cc-status.js`（settings.json 接线的 hook 目标） | patcher 安装时从项目源复制（幂等覆盖） | **是**（删整个目录） |

> **持久化设计（v0.2）**：reader（注入 IIFE）的 `RES` 与 settings.json 接线的 hook 命令都指向 `INSTALL_DIR` 的**绝对路径**，而非项目源目录。这样即使用户删除项目目录或 npx 缓存被清，已 patch 的扩展仍能照常渲染。安装一行：`npx vscode-claude-code-status-dot`。`PROJECT_ROOT` 仅用于"复制源"（安装时读一次），编译后从 `dist/patch.js` 运行时自动回溯到包根目录。

---

## 4. reader 渲染逻辑（patch.ts 注入 IIFE，每 500ms 一帧）

> **reader 只读 `state`（仍四态）+ `since` + `error`**；`activeSubagents` 是 writer 内部记账字段，reader 不读、不渲染。workflow 跑期间保持 running 完全由 writer 在 `Stop`/`SubagentStop` 时改写 `state` 实现。v0.1.4 起 running 渲染为**静态黄点** `#CCA700`（v0.1.3 的 8 帧正弦呼吸因 `iconPath` 切帧本质离散、帧间不连续，肉眼读作闪烁而非渐变，故回归静态；和 idle/done/error 一样无动画）。500ms 定时器仍在跑——interrupted 的 seq%2 快闪需要它，静态态每 tick 重新赋同一个路径（廉价 no-op）。

```
读 <sid>.json → state, since, error
if prevSt && prevSt != state && state ∈ {done, interrupted}:  notify(state, error)   # 见 §4b
prevSt = state
if __ccPending (rename_tab hasPendingPermissions=true):  return（不覆盖，让 CC 原生蓝点显示）  # v0.1.8
if state == "done" and now - since > 5min:  视为 idle
switch state:
  running:     RES/claude-logo-running.svg   # 静态黄 #CCA700（无动画）
  interrupted: seq 偶 → claude-logo-error.svg / seq 奇 → CC claude-logo.svg（快闪 on/off，~500ms）
  idle:        claude-logo-idle.svg
  done:        claude-logo-done.svg
  其它/无文件:  return（不覆盖，让 CC 原生图标显示）
```

> **为什么 v0.1.4 回归静态**：VSCode 的 `tab.iconPath` 在每次赋值后触发一次图标重渲染，帧间没有插值/过渡——所以"呼吸动画"本质是一串离散静态图被快速切换，相邻帧色差再小也读作闪烁（flicker），而非连续渐变（fade）。静态黄点和 idle/done/error 视觉语言一致，最干净。interrupted 保留快闪是因为它携带真实的"告警"语义（出错 / 限速），值得打破静态。`seq` 仍保留并每 tick 自增，仅供 interrupted 的 seq%2 判定。

---

## 4b. reader 通知逻辑（done / interrupted 时触发）

触发条件：`prevSt && prevSt !== state && (state === "done" || state === "interrupted")`（仅状态转换时；首次读 `prevSt=null` 不触发，防陈旧文件误触）。

**策略矩阵**（IIFE 用 `vs.window.state.focused` 判定前台）：

| VSCode 前台？ | done | interrupted |
|---|---|---|
| focused | 默认弹 `showInformationMessage`/`showWarningMessage`（`notifyWhenFocused:true`）；设 `false` 则前台抑制，仅图标变绿/红快闪 | 同左 |
| unfocused | `showInformationMessage`（触发 dock bounce）+ osascript 系统通知（声音 Glass + 通知中心） | `showWarningMessage` + osascript（声音 Basso） |

**配置项**（VSCode settings.json `ccStatusDot.*`）：
- `ccStatusDot.notify`（bool，默认 true）：总开关
- `ccStatusDot.notifyWhenFocused`（bool，默认 true）：前台时也弹 VSCode 消息（想前台彻底安静设 false）
- `ccStatusDot.notifySound`（string，默认 `"Glass"`）：macOS 系统通知声音（`""`=静音）

**error → 文案**：done → `Claude Code: turn complete`；interrupted → 按 error 映射（`rate_limit`→"rate limit reached"、`overloaded`→"server overloaded"、其它→原值或 "interrupted"）。

通知是 reader（IIFE）的职责，**hook 不改**（保持零依赖/跨平台/静默契约）。

---

## 5. 已知限制（诚实声明，写入文档）

**v2 新特性 — workflow / 后台 subagent 跑期间保持 running**：主 agent 回复"已启动"后 `Stop` 不再误写 `done`（假绿）。实现 = hybrid：`Stop`/`SubagentStop` 时优先读 payload 的 `background_tasks[]`（CC v2.1.145+ 权威，覆盖 workflow/subagent/teammate 全类型），缺失时退化为 `activeSubagents` 计数 + `SubagentStart` 早信号。reader 不读 `activeSubagents`，state 仍四态。详见 [`SUBAGENT-design.md`](SUBAGENT-design.md)。

- **手动 Esc 中断无 hook**：CC 不触发 Stop/StopFailure（[#45289](https://github.com/anthropics/claude-code/issues/45289)/[#9516](https://github.com/anthropics/claude-code/issues/9516)），状态会停在 `running`。reader 无 watchdog（当前版本不做主动推断），靠下一次 `UserPromptSubmit`/`Stop` 自然更正。
- **多 session**：每个 CC panel 实例各自一个 500ms 定时器，按各自 `__ccSid` 读各自状态文件，互不干扰。
- **CC 自动更新**：覆盖 patched `extension.js` → 静默失效，需重跑 `npx vscode-claude-code-status-dot`（或开发态 `npx tsx patch.ts`）。SVG/hook 运行时副本在 `INSTALL_DIR`（`~/.claude/cc-status-dot/`），CC 更新不碰它；项目源目录删了也不影响已 patch 的扩展。
- **运行时副本与源解耦**：reader（IIFE 的 `RES`）与 settings.json 接线的 hook 命令都引用 `INSTALL_DIR` 绝对路径。`INSTALL_DIR` 在安装时由 patcher 从 `PROJECT_ROOT`（包根的 `resources/`+`hooks/`）幂等复制；`--revert` 删除整个 `INSTALL_DIR`，但**保留** `~/.claude/cc-tab-status/`（用户数据）。
- **VSCode 完全关闭时不通知**：IIFE 跑在 CC 扩展宿主进程，VSCode 关闭则 IIFE 不运行 → 不通知（v2 可由 hook 补位）。
- **系统通知点击不可跳转 CC tab**：osascript 无 click callback；通知仅提醒，回 VSCode 后靠 tab 绿/红点定位。
- **macOS 首次授权**：首次 osascript 通知会弹"X 想发送通知"授权，一次性。
- **activeSubagents 计数漂移（hybrid 的 A 部分）**：SubagentStart/Stop 不配对（subagent 崩溃/被杀未发 Stop）→ 计数虚高；多 subagent 并发 Start/Stop 的 read-modify-write 也可能丢更新。缓解：每次带 `background_tasks` 的事件用权威值覆盖 + clamp 0；reader 不读此字段，漂移只影响"早信号"窗口，无功能性后果（B 的 `Stop` 终裁）。
- **workflow 收尾后→done 的转换依赖会话被唤醒**：workflow 完成后若主会话不被 task-notification 唤醒、不再发 `Stop`，图标可能停在 `running` 直到下一次用户 prompt。**安全失败**（停黄优于假绿），不再出现"workflow 还在跑却显示绿"。

---

## 6. 聚合状态条（v0.1.3 已废弃）

> **本节特性在 v0.1.3 移除**：右下角的"聚合色块条"webview 注入已被删除。tab 图标四态点 + 完成/中断通知已经把每个 session 的状态表达清楚；色块条更多是冗余而非增量信息，且它在 webview `index.js`/`index.css` 上独立打补丁，维护成本与脆弱性都高于 extension.js 的 iconPath 注入。
>
> **升级即清理**：旧版（v0.1.2）用户重跑 `npx vscode-claude-code-status-dot`，patcher 会自动检测 webview 残留的聚合条标记（`window.__ccVsApi=`）并从 `.bak` 还原 webview，无需先手动 `--revert`。`--revert` 也会还原 webview（保留这条路径以清理 v0.1.2 安装）。
>
> 历史设计记录见 [`WEBVIEW-injection.md`](WEBVIEW-injection.md)（同样已标注废弃）。
