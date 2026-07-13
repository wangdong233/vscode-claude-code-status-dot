# 状态表（单一真相源 · Single Source of Truth）

> 本文件是 **claude-code-status-dot 的唯一状态契约**。
> **writer**（`hooks/cc-status.js`）、**reader**（`patch.ts` 注入的 IIFE）、**SVG 文件名**、**文档**（README/USAGE/CHANGELOG）、**`package.json`** 必须全部引用本表。
> 任何状态 / 事件 / SVG / 颜色的增删：**先改本表，再机械同步其余各处**。这是审查 F-1~F-6 的收敛点。

---

## 1. 状态枚举（4 态 + 1 原生）

| state | 含义 | 颜色 (hex) | SVG 文件（项目 `resources/`） | 动效 |
|---|---|---|---|---|
| `idle` | 空闲（初始 / 无状态文件 / 完成超 5 分钟） | 灰 `#808080` | `claude-logo-idle.svg` | 静态 |
| `running` | 运行中 | 黄 `#CCA700`↔`#DDB703`↔`#EEC607`↔`#FFD60A` | `claude-logo-running.svg`/`-1`/`-2`/`-bright.svg` | 呼吸（4 帧三角波 6 步，500ms/步 = 3s 周期） |
| `done` | 完成 | 绿 `#3FB950` | `claude-logo-done.svg` | 静态；**reader 在 done 超 5 分钟后渲染为 idle** |
| `interrupted` | 中断（限速 / 出错） | 红 `#F85149` | `claude-logo-error.svg` ↔ CC 默认 `claude-logo.svg` | 快闪（500ms 切换，on/off） |
| — (permission) | 待用户授权 | 蓝（CC 原生） | CC 原生 `claude-logo-pending.svg` | **reader 不覆盖**，CC 原生蓝点照常显示 |

> 设计决策：`permission` 态不纳入我们的渲染——CC 已有原生蓝点处理 `hasPendingPermissions`，reader 在"无外部状态文件 / state 未知"时 `return`（不覆盖图标），CC 蓝点自然生效。避免重复造一套 waiting 态。
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
| `SubagentStop` | `running`（若仍有在飞任务）/ **不写**（若归零） | `activeSubagents` 优先用 `background_tasks` 纠正，否则 −1（clamp 0）；归零时不抢断，终态交 `Stop` |
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

---

## 4. reader 渲染逻辑（patch.ts 注入 IIFE，每 500ms 一帧）

> **本节零改动（Subagent/workflow 支持不影响 reader）**：reader 只读 `state`（仍四态）+ `since` + `error`；`activeSubagents` 是 writer 内部记账字段，reader 不读、不渲染。workflow 跑期间保持 running 完全由 writer 在 `Stop`/`SubagentStop` 时改写 `state` 实现。`buildIIFE` 因此无任何改动。

```
读 <sid>.json → state, since, error
if prevSt && prevSt != state && state ∈ {done, interrupted}:  notify(state, error)   # 见 §4b
prevSt = state
if state == "done" and now - since > 5min:  视为 idle
switch state:
  running:     RUN_FRAMES[seq % 6]   # 6步三角波 [f0,f1,f2,f3,f2,f1]，3s周期呼吸
  interrupted: seq 偶 → claude-logo-error.svg / seq 奇 → CC claude-logo.svg（快闪 on/off）
  idle:        claude-logo-idle.svg
  done:        claude-logo-done.svg
  其它/无文件:  return（不覆盖，让 CC 原生图标显示）
RUN_FRAMES = [running, running-1, running-2, running-bright, running-2, running-1]
```

---

## 4b. reader 通知逻辑（done / interrupted 时触发）

触发条件：`prevSt && prevSt !== state && (state === "done" || state === "interrupted")`（仅状态转换时；首次读 `prevSt=null` 不触发，防陈旧文件误触）。

**策略矩阵**（IIFE 用 `vs.window.state.focused` 判定前台）：

| VSCode 前台？ | done | interrupted |
|---|---|---|
| focused | 抑制（图标变绿/红快闪已足够；`notifyWhenFocused:true` 时弹 `showInformationMessage`/`showWarningMessage`） | 同左 |
| unfocused | `showInformationMessage`（触发 dock bounce）+ osascript 系统通知（声音 Glass + 通知中心） | `showWarningMessage` + osascript（声音 Basso） |

**配置项**（VSCode settings.json `ccStatusDot.*`）：
- `ccStatusDot.notify`（bool，默认 true）：总开关
- `ccStatusDot.notifyWhenFocused`（bool，默认 false）：前台时也弹 VSCode 消息
- `ccStatusDot.notifySound`（string，默认 `"Glass"`）：macOS 系统通知声音（`""`=静音）

**error → 文案**：done → `Claude Code: turn complete`；interrupted → 按 error 映射（`rate_limit`→"rate limit reached"、`overloaded`→"server overloaded"、其它→原值或 "interrupted"）。

通知是 reader（IIFE）的职责，**hook 不改**（保持零依赖/跨平台/静默契约）。

---

## 5. 已知限制（诚实声明，写入文档）

**v2 新特性 — workflow / 后台 subagent 跑期间保持 running**：主 agent 回复"已启动"后 `Stop` 不再误写 `done`（假绿）。实现 = hybrid：`Stop`/`SubagentStop` 时优先读 payload 的 `background_tasks[]`（CC v2.1.145+ 权威，覆盖 workflow/subagent/teammate 全类型），缺失时退化为 `activeSubagents` 计数 + `SubagentStart` 早信号。reader 不读 `activeSubagents`，state 仍四态。详见 [`SUBAGENT-design.md`](SUBAGENT-design.md)。

- **手动 Esc 中断无 hook**：CC 不触发 Stop/StopFailure（[#45289](https://github.com/anthropics/claude-code/issues/45289)/[#9516](https://github.com/anthropics/claude-code/issues/9516)），状态会停在 `running`。reader 无 watchdog（当前版本不做主动推断），靠下一次 `UserPromptSubmit`/`Stop` 自然更正。
- **多 session**：每个 CC panel 实例各自一个 500ms 定时器，按各自 `__ccSid` 读各自状态文件，互不干扰。
- **CC 自动更新**：覆盖 patched `extension.js` → 静默失效，需重跑 `tsx patch.ts`（SVG 在本项目目录不丢）。
- **VSCode 完全关闭时不通知**：IIFE 跑在 CC 扩展宿主进程，VSCode 关闭则 IIFE 不运行 → 不通知（v2 可由 hook 补位）。
- **系统通知点击不可跳转 CC tab**：osascript 无 click callback；通知仅提醒，回 VSCode 后靠 tab 绿/红点定位。
- **macOS 首次授权**：首次 osascript 通知会弹"X 想发送通知"授权，一次性。
- **activeSubagents 计数漂移（hybrid 的 A 部分）**：SubagentStart/Stop 不配对（subagent 崩溃/被杀未发 Stop）→ 计数虚高；多 subagent 并发 Start/Stop 的 read-modify-write 也可能丢更新。缓解：每次带 `background_tasks` 的事件用权威值覆盖 + clamp 0；reader 不读此字段，漂移只影响"早信号"窗口，无功能性后果（B 的 `Stop` 终裁）。
- **workflow 收尾后→done 的转换依赖会话被唤醒**：workflow 完成后若主会话不被 task-notification 唤醒、不再发 `Stop`，图标可能停在 `running` 直到下一次用户 prompt。**安全失败**（停黄优于假绿），不再出现"workflow 还在跑却显示绿"。

---

## 6. 聚合状态条（webview 右下角浮层，可选展示）

除 tab 图标点外，patch 还在 CC webview 右下角注入一个**聚合色块条**（vanilla DOM `position:fixed`，不进 React 树）：每个 session 一个小色块，颜色同 §1 四态，点击切到对应 session tab。

- **数据源**：复用本表状态文件，由 extension.js IIFE 聚合后 postMessage 推给 webview（webview 沙箱无 fs）。
- **点击切 tab**：webview postMessage `cc_focus_session` → extension.js `onDidReceiveMessage` → `vscode.commands.executeCommand("claude-vscode.editor.open", sid)`（已存在 panel 走 reveal）。
- **2 秒无数据自动隐藏**（兼容 sidebar 等无桥 webview）。
- 详见 [`WEBVIEW-injection.md`](WEBVIEW-injection.md)。
