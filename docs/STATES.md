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
| — (permission) | 待用户授权 | 蓝（CC 原生） | CC 原生 `claude-logo.svg`（permission 时由 CC 自己改色为蓝） | **reader 不覆盖**，CC 原生蓝点照常显示 |

> 设计决策：`permission` 态不纳入 per-tab 渲染——CC 已有原生蓝点处理 `hasPendingPermissions`，reader 在以下两种情况 `return`（不覆盖图标），CC 蓝点自然生效：
>
> 1. **无外部状态文件 / state 未知**（原 v0.1.7 行为）。
> 2. **permission pending**（v0.1.8 新增）：reader tick 检测到 `t.__ccPending===true` 即 `return`。`__ccPending` 由 `rename_tab` handler（Anchor B）每次触发时从 `e.request.hasPendingPermissions`（CC 用来画蓝点的同一个 flag）就地刷新到 panel 实例上；IIFE 每 500ms 读这个 live flag，pending 期间不抢图标。
>
> 背景：PreToolUse 心跳会在 permission 弹窗前把 `state=running` 落盘，CC 又无 permission-pending hook 事件可纠正该文件；v0.1.7 只在"读不到文件"时 return，故 pending 期间 reader 持续用黄 `running.svg` 盖 CC 蓝点（本 bug）。v0.1.8 让 reader 直接读 CC 自己的 pending flag，不再依赖状态文件是否巧合缺失。避免重复造一套 waiting 态。
>
> **v0.1.13 双重性（dual-nature）**：pending 在 per-tab（本节）由 CC 原生蓝点表达（reader `__ccPending` yield）；但在 **commandCenter 聚合**（§7）里以独立 🔵 蓝灯呈现，由 writer 新增的 `Notification` hook case 写 `pending:true`（§2），reader 聚合独立计数。**per-tab 不读 `pending` 字段**（避免重复造一套 waiting 态），**聚合不读 `__ccPending`**（那是 per-panel-live，无窗口级通道）——同一语义，两个通道，各管各的 UI 表面。
>
> **点几何（所有 SVG 统一）**：`viewBox 0 0 24 24`，状态点 `cx=18 cy=6 r=6`，mask 挖空 `r=7.5`（margin 1.5）。16px tab 渲染下点直径 8px，视觉占比 20%（竞品角标黄金比区间：macOS dock badge ~20-25%）。

---

## 2. 事件 → 状态映射（writer 的 case 集 ＝ patcher 的 `HOOK_EVENTS` 接线集，二者必须逐一对齐）

| CC hook 事件 | → 写入 state | 说明 |
|---|---|---|
| `UserPromptSubmit` | `running` + 清 `pending` | 新一轮开始；`activeSubagents` 用 payload `background_tasks` 纠正，**否则重置 0**（防止上轮漂移 bleed 进新轮；`Stop` 才是工作是否剩余的权威——见 regression test 12 / bug e434c0a2）。**v0.1.13 起同时写 `pending:false`**——新 prompt 表示用户已答完之前的权限/问询，🔵 commandCenter 蓝灯应熄灭 |
| `PreToolUse` | `running` + 清 `pending` | 心跳，刷新 `since`；`activeSubagents` 同 `UserPromptSubmit` 规则（payload 优先，否则 0）。**v0.1.13 清 `pending`**——tool 心跳表示用户已答 prompt，turn 重新推进 |
| `PostToolUse` | `running` + 清 `pending` | 心跳，刷新 `since`；同上 |
| `SubagentStart` | `running` + **保持 `cur.pending`** | **早信号**：subagent 一 spawn 即黄；`activeSubagents` 优先用 `background_tasks` 纠正，否则 +1。**v0.1.13 review round-2 改为保持 `cur.pending`**：subagent spawn 是 **background 事件**，对父会话的 permission/question prompt 是否仍开着无信号——若在 Notification 弹窗期间 spawn helper 却清 `pending`，🔵 commandCenter 蓝灯会假熄灭直到下一次 Notification/用户事件。仅用户/turn 驱动的事件（UserPromptSubmit / Pre/PostToolUse / Stop / StopFailure）真正清 `pending` |
| `SubagentStop` | `running`（若仍有在飞任务）/ **保持 cur.state（归零时不抢断，写回 activeSubagents:0）** + **保持 `cur.pending`** | `activeSubagents` 优先用 `background_tasks` 纠正，否则 −1（clamp 0）；**始终写回**（落盘递减后的计数 + cur.state，cur.state 限定为 writer 实际会写的三态 running/done/interrupted，其它含默认 'idle' 一律降级 'running'，永不把 'idle' 落盘）。归零时不抢断终态、交 `Stop` 裁定；**且当 cur.state 已是 done/interrupted 且 next===0 时保留 cur.since 不刷新**（reader notify 去重以终态 since 为键，刷新会重复弹通知并重置 done→idle 5 分钟倒计时）。**v0.1.13 review round-2 改为保持 `cur.pending`**——同 `SubagentStart` 理由：subagent 收尾是 background 事件，不应误清父会话 prompt 的 pending 标志 |
| `Notification`（v0.1.13 新增） | **保持 cur.state + cur.since，写 `pending:true`** | CC Notification hook = permission / question / elicit prompt。**不改 state/since**——pending 与 state 正交（一轮 running 可同时是 pending），reader 聚合独立计数（§7 蓝灯）。cur 为默认（无前文件）时降级 state='running' + since=now 写一个 coherent 文件。**仅此事件写 `pending:true`**；用户/turn 驱动事件（UserPromptSubmit / Pre/PostToolUse / Stop / StopFailure）清零；SubagentStart/Stop **保持**（见上） |
| `Stop` | `done`，**除非** payload `background_tasks.length > 0` → `running`；payload 缺字段（inflight=null）也落 `done` 并清零计数；**清 `pending`** | 权威裁定：workflow 后台跑期间不假绿（v2.1.145+）；`Stop` **绝不读盘上 activeSubagents**（counter 可能漂移），只信 payload——缺 payload 也算"无在飞任务"，落 done + 清零 |
| `StopFailure` | `interrupted` + 清 `pending` | 记 `error` 枚举（`rate_limit`/`overloaded`/…）；缺 error 或非字符串一律写 `"interrupted"`（与 reader 兜底文案对齐）；中断优先，保留 `activeSubagents` |
| `SessionEnd` | （删除该 session 状态文件） | 清理——pending 字段随文件消失，无残留 |

**故 `HOOK_EVENTS` = `["UserPromptSubmit","PreToolUse","PostToolUse","SubagentStart","SubagentStop","Notification","Stop","StopFailure","SessionEnd"]`**（9 个，v0.1.13 加入 `Notification`）。

**故意不接的事件**（及原因，防止死接线）：
- `SessionStart`：writer 无对应 case（接了也是死接线，audit F-5）。

> **hook 命令格式（实测约定）**：patcher 写入 `~/.claude/settings.json` 的每个 hook 形如 `"<absoluteNodeBin> <INSTALL_DIR>/hooks/cc-status.js  # cc-status-dot-managed"`，全部 9 事件用 `matcher:""`。两点依赖 CC 当前实测行为：(1) CC 以 shell 解析 hook 行，故末尾 `# ...` shell 注释可用作幂等标记；(2) `matcher:""` 在 CC 的 regex 语义下表示"匹配一切事件实例"（含 SubagentStart 的 `agent_type` 维度）——空串目前等价 catch-all。若未来 CC 改用 `execFile` 直 spawn 或将空 matcher 改为"匹配空"语义，这条链会静默断（writer 不写文件、reader 永停末帧）。届时改为 `matcher:".*"` 或把标记挪进 hook 脚本自报即可。

---

## 3. 状态文件 IPC 契约（writer 与 reader 共享）

- 目录：`~/.claude/cc-tab-status/`
- 文件名：`<session_id>.json`
- 字段：`{ "state": "idle|running|done|interrupted", "since": <ms 纪元, 非负有限数>, "error"?: "<StopFailure 枚举字符串>", "activeSubagents": <int, >= 0>, "pending"?: <bool> }`
  - `activeSubagents`（int，默认 0）：**仅供 writer 记账**（SubagentStart/Stop 计数 + `background_tasks` 纠正）。**reader 不读此字段**——state 仍四态，渲染逻辑零改动（§4）。
    - **字段名义 vs v2 语义**：名字是 v0.x 历史遗留（"活跃 subagent 数"），v2 起（§5）任何带 `background_tasks` 的事件会用 `background_tasks.length` **权威覆盖**它，语义已扩展到 workflow/subagent/teammate 全类型后台任务。reader 不读、改名是 IPC 破坏性变更无收益，故保留名字、扩语义；读字段时请以注释而非名字为准。
  - `pending`（bool，可选，v0.1.13 新增）：`true` = 该会话正在等待用户输入（permission / question / elicit prompt）。**仅 writer 写**（`Notification` 事件写 `true`；**用户/turn 驱动事件**——UserPromptSubmit / PreToolUse / PostToolUse / Stop / StopFailure——写 `false`；SubagentStart / SubagentStop **保持 `cur.pending`**，因为它们是 background 事件，对父会话 prompt 是否仍开无信号，v0.1.13 review round-2 修正），**仅 reader 的 commandCenter 聚合读**（§7 蓝灯 🔵）；per-tab 渲染（§4）**不读**此字段——仍由 CC 原生蓝点处理（v0.1.8 `__ccPending` yield）。一个会话可同时是 `running` AND `pending`（一轮 running 卡在权限弹窗——典型场景）。writer 为 read-modify-write——**`cur.pending` 从盘上读回**（严格 `=== true`），故 background 事件能安全 preserve。
  - `background_tasks[]` / `session_crons[]`：**hook payload 字段（CC v2.1.145+），不落盘**——Stop/SubagentStop 时由 writer 就地读取作权威判定（覆盖 workflow/subagent/teammate 等全类型）。
- 写入：**原子**（`.tmp` + `rename`，tmp 名带 `pid+Date.now()` 后缀防同 session 并发 hook 共用 tmp 路径），目录自动创建；writer 为 **read-modify-write**（读当前 `activeSubagents` + `pending` → 改 → 原子写回）
- reader 读失败（文件不存在 / JSON 破损）→ 跳过本帧，**不覆盖**图标（保留 CC 原生 pending/done）

### 3a. `~/.claude/` 路径地图（两个目录，勿混淆）

| 目录 | 内容 | 由谁创建 | `--revert` 是否清理 |
|---|---|---|---|
| `~/.claude/cc-tab-status/` | **状态 IPC 文件**（本节 §3，每 session 一个 `<sid>.json`） | writer（hook）首次写入 | **否**（用户数据，保留） |
| `~/.claude/cc-status-dot/`（`INSTALL_DIR`） | **运行时副本**：`resources/*.svg`（4 个 = idle + running + done + error，reader 引用）+ `hooks/cc-status.js`（settings.json 接线的 hook 目标） | patcher 安装时从项目源复制（幂等覆盖） | **是**（删整个目录） |

> **持久化设计（v0.2）**：reader（注入 IIFE）的 `RES` 与 settings.json 接线的 hook 命令都指向 `INSTALL_DIR` 的**绝对路径**，而非项目源目录。这样即使用户删除项目目录或 npx 缓存被清，已 patch 的扩展仍能照常渲染。安装一行：`npx vscode-claude-code-status-dot`。`PROJECT_ROOT` 仅用于"复制源"（安装时读一次），编译后从 `dist/patch.js` 运行时自动回溯到包根目录。

---

## 4. reader 渲染逻辑（patch.ts 注入 IIFE，每 500ms 一帧）

> **reader 只读 `state`（仍四态）+ `since` + `error`**；`activeSubagents` 是 writer 内部记账字段，reader 不读、不渲染。workflow 跑期间保持 running 完全由 writer 在 `Stop`/`SubagentStop` 时改写 `state` 实现。v0.1.4 起 running 渲染为**静态黄点** `#CCA700`（v0.1.3 的 8 帧正弦呼吸因 `iconPath` 切帧本质离散、帧间不连续，肉眼读作闪烁而非渐变，故回归静态；和 idle/done/error 一样无动画）。500ms 定时器仍在跑——interrupted 的 `flashSeq%2` 快闪需要它，静态态每 tick 重新赋同一个路径（廉价 no-op）。

```
读 <sid>.json → state, since, error
# notify 去重（v0.1.5+：以终态 since 时间戳为键，旧的 prevSt 转换检查已废弃）：
if !seeded:
  seeded = true
  if state ∈ {done, interrupted}:  lastTermSince = since   # 首帧种子，防 reload 进陈旧 done 误触
else if state ∈ {done, interrupted} && since !== lastTermSince:
  lastTermSince = since;  notify(state, error)              # 见 §4b
if __ccPending (rename_tab hasPendingPermissions=true):  return（不覆盖，让 CC 原生蓝点显示）  # v0.1.8
if state == "done" and now - since > 5min:  视为 idle
switch state:
  running:     RES/claude-logo-running.svg   # 静态黄 #CCA700（无动画）
  interrupted: flashSeq 偶 → claude-logo-error.svg / flashSeq 奇 → CC claude-logo.svg（快闪 on/off，~500ms）
  idle:        claude-logo-idle.svg
  done:        claude-logo-done.svg
  其它/无文件:  return（不覆盖，让 CC 原生图标显示）
flashSeq++   # 每 tick 自增，仅供 interrupted 的 flashSeq%2 判定
```

> **为什么 v0.1.4 回归静态**：VSCode 的 `tab.iconPath` 在每次赋值后触发一次图标重渲染，帧间没有插值/过渡——所以"呼吸动画"本质是一串离散静态图被快速切换，相邻帧色差再小也读作闪烁（flicker），而非连续渐变（fade）。静态黄点和 idle/done/error 视觉语言一致，最干净。interrupted 保留快闪是因为它携带真实的"告警"语义（出错 / 限速），值得打破静态。`flashSeq` 仍保留并每 tick 自增，仅供 interrupted 的 `flashSeq%2` 判定。

> **v0.1.5 notify 去重算法升级**：旧逻辑 `prevSt && prevSt !== state && state ∈ {done, interrupted}` 要求 500ms 轮询**采样到** `running` 再切到 `done`/`interrupted` 才触发——若一轮跑得太快（两次 poll 之间已完成 running→done）或 reload 落在旧 `done` 上，转换永远观测不到，通知丢失。新逻辑以**终态 `since` 时间戳**为去重键（`Stop`/`StopFailure` 每次刷新 `since`；`SubagentStop` 在 cur.state 已终态且 next===0 时保留 cur.since 防误触），首帧种子防 reload 误报，之后每个**新的终态 `since`** 触发一次。覆盖快速完成、reload、连续多轮等全部路径，且不重复弹。详见 CHANGELOG[Unreleased]。

---

## 4b. reader 通知逻辑（done / interrupted 时触发）

触发条件：**`since` 时间戳去重**——首次 poll 时 `seeded=true` 记录当前终态 `since`（防 reload 进陈旧 `done` 误触）；之后仅当 `done`/`interrupted` 的终态 `since` 发生变化（`Stop`/`StopFailure` 每次刷新 `since`，`SubagentStop` 在 cur.state 已终态且 next===0 时**保留 cur.since** 防误触）才触发一次 notify。

**渲染通道与焦点正交**——IIFE 的实际分支以 `os.platform()` 选渲染通道，以 `vs.window.state.focused` × `notifyWhenFocused` 决定是否抑制：

| 平台 | VSCode 前台 + `notifyWhenFocused:true`（默认） | 前台 + `notifyWhenFocused:false` / 后台 |
|---|---|---|
| **macOS**（`os.platform()==="darwin"`） | osascript 系统通知（屏幕右上角下拉，带声音，无按钮，几秒自动消失）；osascript 异步或同步失败时**回落 VSCode `showInformation/WarningMessage`**（防权限被拒/二进制缺失/转义 bug 让通知功能彻底静默） | 后台同左（osascript）；前台+`notifyWhenFocused:false` 抑制 |
| **Windows / Linux**（无 osascript） | VSCode `showInformationMessage`（done）/ `showWarningMessage`（interrupted），右下角 toast | 同左 |

**消息文案**：末尾追加 `[<panel 当前 title>]`——`__ccTitle` 由 `update_session_state`（Anchor A）首次写入，并由 `rename_tab`（Anchor B）每次刷新（CC 可能多次 rename），保证通知里展示的是当前 tab 标题而非陈旧值。`done` → `Claude Code: turn complete [<title>]`；`interrupted` → 按 error 映射（`rate_limit`→"rate limit reached"、`overloaded`→"server overloaded"、其它→原值；writer 缺 error 字段或非字符串时双方兜底都为 `"interrupted"`）。

**配置项**（VSCode settings.json `ccStatusDot.*`）：
- `ccStatusDot.notify`（bool，默认 true）：总开关
- `ccStatusDot.notifyWhenFocused`（bool，默认 true）：前台时也通知（"聚焦于 VSCode 窗口"≠"盯着 CC tab"，原默认 `false` 让通知在最常见场景下永远不触发，等同于功能失效）。设 `false` 仅后台时通知。
- `ccStatusDot.notifySound`（string，默认 `"Glass"`）：macOS 系统通知声音（`done` 与 `interrupted` 共用，矩阵不区分声音；`""`=静音；可选 Basso/Ping/Hero 等）。

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
> **升级即清理**：旧版（v0.1.2）用户重跑 `npx vscode-claude-code-status-dot`，patcher 会自动检测 webview 残留的聚合条标记（`cc-status-bar-injected` 墓碑注释，patch.ts `LEGACY_WV_MARKER`）并从 `.bak` 还原 webview，无需先手动 `--revert`。`--revert` 也会还原 webview（保留这条路径以清理 v0.1.2 安装）。
>
> **为何不用 `window.__ccVsApi=`**：v0.1.2 的注入确实用了该字面量，但它遵循 CC 自己的 `__cc*` 命名约定，未来 CC 原生可能复用该名导致误判，从而拿陈旧 `.bak` 砸掉新 CC webview。墓碑注释 `cc-status-bar-injected` 是我们独有的、CC minified bundle 永远产不出的字符串，前向安全。
>
> 历史设计记录见 [`WEBVIEW-injection.md`](WEBVIEW-injection.md)（同样已标注废弃）。

---

## 7. commandCenter 顶部 4 灯（v0.1.13；替代 v0.1.10-v0.1.12 的 SBI 右下角条）

> **本节是 v0.1.13 新增的 commandCenter 顶部 4 灯**，替代 v0.1.10-v0.1.12 的右下角 StatusBarItem（SBI）。v0.1.13 把 SBI 的"全 session 汇总"语义保留下来，迁到 VSCode **commandCenter（标题栏顶部居中）**——更显眼、不与终端/状态栏其它条目挤位、与 CC tab 自带的 4 态色点形成"全局总览 + 单 tab 细节"双层。
>
> **v0.1.13 关键变化**：
> - **位置迁移**：状态栏右下角 → commandCenter 顶部居中（替代 v0.1.12 SBI `Right`）。
> - **灯数扩展 3→4**：v0.1.10-v0.1.12 的 🟢done 🟡running 🔴interrupted 三灯之外，**新增 🔵pending**（待用户输入——permission/question/elicit），由 writer 新增的 `Notification` hook case（§2）写 `pending:true` 标记，reader 独立计数。
> - **计数封顶**：每灯 0/1/2/3/N（>=4 显示 N），5 种 text，4 灯 = 20 种状态。VSCode commandCenter 无 per-menu-item title override（issue #34048 open），故 5 种 text 必须 5 个独立 command + 5 个独立 menu item 实现，4 灯 × 5 = **20 commands + 20 menu items + 20 palette hide-entries**，全部由 `patchPackageJson` 注入 CC `package.json`。
> - **可见性切换**：IIFE 每 500ms 统计 4 态计数 → `vs.commands.executeCommand("setContext","ccStatusDot.<key>",N)` 推 4 个 context key（N ∈ 0..4，4=N）。每个 menu item 的 `when: "ccStatusDot.<key> == K"` 选中对应变体——任意时刻每灯恰有 1 个变体可见。
> - **patcher 扩展**：除 patcher.ts 既有 `patchExtension`（注入 IIFE）外，新增 `patchPackageJson`（注入 20 commands + 20 menu items + 20 palette hides，marker `__ccStatusDotPkgManaged` + .bak + 版本戳重注入模型，同 extension.js）。
>
> **与 §6 废弃条无关**：§6 是 v0.1.2 在 CC webview 上的色块条，v0.1.3 已删；本节是 v0.1.13 在 CC extension package.json 上的 commandCenter 4 灯。

### 7.1 位置与显示

- **位置**：VSCode **commandCenter 顶部居中**（标题栏正中搜索框区域；`contributes.menus.commandCenter`，`group: "navigation"`）。4 灯并排，固定左→右顺序：**🟢done 🟡running 🔵pending 🔴interrupted**。
- **每灯 5 种 text**（计数封顶 0/1/2/3/N，N=4+）：
  - 计数 0：灯灭——显示 `⚪`（暗/灰白圈，无数字）。`ccStatusDot.<key> == 0` 选中此变体。
  - 计数 1：`🟢 1` / `🟡 1` / `🔵 1` / `🔴 1`（彩色 + 数字）。
  - 计数 2、3：同上数字替换。
  - 计数 >=4：`🟢 N` / `🟡 N` / `🔵 N` / `🔴 N`（`N` 字面量；`ccStatusDot.<key> == 4` 选中此变体，IIFE `cap(n){return n>=4?4:n}` 把 4+ 截到 4）。
- **5 种 text 必须 5 个 command**：VSCode commandCenter 无 per-menu-item title override（issue [#34048](https://github.com/microsoft/vscode/issues/34048) 仍 open），title 只能从 command 自身的 `title` 字段读取。故每灯 5 个独立 command（`ccStatusDot.<key>.<variant>`，如 `ccStatusDot.done.0`、`ccStatusDot.running.N`），4 灯 × 5 变体 = 20 commands + 20 menu items。
- **emoji 渲染**：🟢🟡🔵🔴⚪ 用 \u{...} 码点（U+1F7E2/1F7E1/1F535/1F534/26AA），commandCenter 由 Chromium 渲染（macOS 走 Apple Color Emoji 彩色，Win10+ 走 Segoe UI Emoji 彩色；Win7/无 emoji 字体的 Linux/headless 可能黑白或豆腐块——同 v0.1.12 SBI 已知差异，形状 + 数字仍承载信息）。
- **palette 隐藏**：20 commands 全部加 `commandPalette` 入口 `when: "false"`——否则命令面板会列出 20 个噪声条目。点击 commandCenter 灯本身（非 palette）触发对应 command，IIFE 注册 20 个 info-message no-op 处理器（见 §7.3），点击给一句简短解释（`cc-status-dot <key>: <count> <label>`），不打开 modal、不切 tab。
- **reload 韧性（v0.1.13 review fix）**：`setContext` 是 VSCode window-scoped 运行时状态，extension host 重启即丢失（key 变回 `undefined`）。VSCode 的 when 子句语义下 `ccStatusDot.X == 0` 在 key 为 undefined 时**不 match**——reload 后若无 CC panel 打开（IIFE 仅由 update_session_state / rename_tab handler 触发，无 activate-time 入口），20 个 menu item 一个也不可见，commandCenter 完全空白（连 ⚪ dim 都不显示），违背"4 灯恒显"契约。修复：dim 变体（variant==="0"）的 when 改为 `!ccStatusDot.<key> || ccStatusDot.<key> == 0`——`!key` 是 VSCode 的 falsy 测试，undefined/false/0/"""" 都 match，因此 dim 在 reload 盲窗里也恒显（其它 4 个彩色变体仍用 `== K` 精确匹配，未受影响）。zero-cost：只改 buildCcContribs 一行，无需新增 anchor。`test-pkg-contribs.mjs` PKG.7 锁死 4 灯各自的 dim when 字面量。

### 7.2 数据源与刷新

- **复用窗口级单例定时器** `globalThis.__ccsdCcTimer`（500ms，`TICK_MS`，v0.1.11 SBI timer 命名延续为 grep continuity）——P 个 CC panel 共享一个 timer，每 500ms 触发**一次**聚合（O(S) 文件读，S = 会话数），不再 v0.1.10 的 O(P×S) 读放大。
- 每 tick `fs.readdirSync(DIR)` 列 `~/.claude/cc-tab-status/*.json`，逐文件 `JSON.parse` 读 `state` + `since` + `pending` 字段，**先应用与 per-tab 一致的渲染规则再分桶**：
  1. `state === "done"` 且 `now - since > DONE_TO_IDLE_MS`（5 分钟）→ **不计入 🟢 done**（idle 不算绿，避免陈旧完成永远占绿——只有活跃 done 计绿）。
  2. `state === "running"` 且 `mtime > SBI_RUNNING_STALE_MS`（30 分钟，见 §7.5）→ **不计入 🟡 running**（崩溃/被杀未发 SessionEnd 的会话治理）。
  3. `state === "interrupted"` 且 `mtime > INTERRUPTED_RETENTION_MS`（24 小时，v0.1.13 review fix，见 §7.5）→ **不计入 🔴 interrupted**（🔴 灯不再随累积的 abandoned 中断会话单调增长；文件不删，保留诊断价值）。
  4. 其余按字面 `state` 分桶（`running`/`done`/`interrupted`；`idle` 不参与任何灯——既不算绿也不算黄）。
  5. **`pending` 独立计数 + 同款 GC**（v0.1.13 review fix）：`j.pending === true && st !== "idle"` → `ag.pending++`。`st` 是上面 3 条 decay 规则**已修正过**的值——崩溃/killed 会话（无论原 state 是 running/done/interrupted，只要 mtime 触发 decay 即降级为 idle）的 pending 自动被跳过。这关掉了"🔵 永久粘在 1"的假阳性（一个在权限弹窗时被强杀的会话 state=running/pending=true，running 桶被规则 2 治理但 pending 仍被计入——review 发现并修复）。**与 state 正交**：一个活会话（st 非 idle）可同时计入 🟡 running AND 🔵 pending（典型：running turn 卡在权限弹窗）。
- 4 个计数各自 `cap(n)` 截顶到 4，推 4 个 `setContext` key：`vs.commands.executeCommand("setContext","ccStatusDot.<key>",N)`，N ∈ 0..4。VSCode 据此 `when` 子句切换可见变体——**setContext 幂等**，重复推同值是 no-op，500ms tick 廉价。
- 失败文件 try/catch 跳过（与 reader 一贯风格，不崩扩展）。

### 7.3 全局单例 + command 注册

- **聚合 timer 单例**：`globalThis.__ccsdCcTimer` 守卫——IIFE 入口检测，第一个 CC panel 创建 `setInterval`，后续 panel 复用。`__ccsdPanelCount` 计数器：IIFE 入口 `+1`，`onDidDispose` 内 `-1`；归零（窗口里**最后一个** CC panel 关闭）时立即 `clearInterval(__ccsdCcTimer)` + **重置全部 4 个 `setContext` key 为 0**——所有灯立刻熄灭，commandCenter 不会冻结在陈旧计数上（典型场景：CC 崩溃、被强杀）。新 panel 打开时 timer 重建，首 tick 自然推真实计数。
- **20 command 处理器单例**：`globalThis.__ccsdCcCmdsRegistered` 守卫——首个 CC panel 的 IIFE 调 `vs.commands.registerCommand("ccStatusDot.<key>.<variant>", no-op)` 20 次（4 灯 × 5 变体）。VSCode 要求 contributed command 必须有 handler，否则点击弹 `"command 'X' not found"`。handler 仅显示一句 `InformationMessage` 解释该灯含义（`cc-status-dot <key>: <count> <label>`）——不打断、不开 modal。后续 panel 复用（`registerCommand` 在同一 host 重复注册会抛错，所以必须 guard）。
- **命名空间**：`__ccsd*` 项目级前缀（沿用 v0.1.11 决策）——避免占用 CC 自己的 `__cc*` 全局命名空间（见 patch.ts `restoreWebview()` 内 `cc-status-bar-injected` 墓碑注释的警示）。

### 7.4 与 per-tab 四态点的关系（共存，不替代）

| 维度 | per-tab 四态色点（§1 / §4） | commandCenter 顶部 4 灯（本节） |
|---|---|---|
| 位置 | 每个 CC tab 图标 + Open Editors 视图 | 标题栏顶部居中，全局唯一 |
| 灯数 | 4（idle/running/done/interrupted，permission 走 CC 原生蓝） | 4（🟢done 🟡running 🔵pending 🔴interrupted），固定显示 |
| 粒度 | 单 session | 全部 session 汇总计数（0-3+N 封顶） |
| 渲染 | `panelTab.iconPath`（SVG） | `commandCenter` menu item `title`（emoji + 数字） |
| 中断闪烁 | 红色快闪（`flashSeq%2`） | 仅静态数字（不闪） |
| 颜色保真 | SVG 嵌入 hex，跨平台稳定 | emoji 字体依赖，可能黑白（§7.1 已知差异） |
| permission 处理 | `__ccPending` yield→CC 原生蓝点（per-panel-live） | 🔵 pending 灯（writer 写 `pending:true`，reader 聚合独立计数） |
| 陈旧 running 治理（>30min mtime） | **不应用**——tab 保持 🟡 黄提醒"此会话可能已死" | **应用 §7.2 启发式**——不计 🟡，避免单个崩溃会话永久占黄 1（两者计数因此可能差 1） |
| 陈旧 interrupted 治理（>24h mtime） | **不应用**——tab 保持 🔴 红快闪提醒"此会话被中断过"（`flashSeq%2` 在 `claude-logo-error.svg` ↔ CC 默认 logo 之间闪烁） | **应用 §7.2 规则 3**——不计 🔴，避免累积的 abandoned 中断会话让 🔴 单调增长（两者计数因此可能差 N） |
| done>5min 归 idle | 应用（§4） | 应用（§7.2，不计 🟢） |
| 刷新来源 | 每 panel 一个 per-tab `setInterval`（500ms） | 窗口级单例 `setInterval`（500ms） |
| 失败隔离 | per-tab setInterval 的 `p.iconPath=` 单行 try/catch；onDidDispose 注册也在 try/catch 内 | Cc timer 创建 + aggregation body + onDidDispose 各自独立 try/catch（§7.5） |

**互补**：tab 点告诉你"是哪个会话在跑/停了"；commandCenter 4 灯告诉你"全局总共有几个在跑/停/等输入/中断了"，不用数 tab。

### 7.5 异常安全 + 已知限制（v0.1.11；v0.1.12 加固；v0.1.13 沿用）

**异常安全（v0.1.13 当前层次）**：v0.1.12 给 SBI 创建 + SBI 单例 timer 创建各加一层独立 try/catch（v0.1.13 把"SBI 创建"换成"Cc 单例 timer 创建"——SBI 已删，但 timer 创建 + aggregation body + onDidDispose 注册的 try/catch 模式完整沿用）。当前结构（自内向外）：
1. **Cc 单例 timer 创建 try/catch**（v0.1.12 沿用）：吞掉 `setInterval` 注册的抛出（disposed host、API 暂态失败），让 IIFE 继续走到 per-tab tick + onDidDispose 注册。
2. **Aggregation body try/catch**（v0.1.11）：包住 readdirSync/statSync/JSON.parse/setContext 等所有 filesystem + JSON + command 操作。
3. **Cc command 注册 try/catch**（v0.1.13 新增）：包住 20 次 `vs.commands.registerCommand` 调用——单次注册抛错（重复、API 暂态）只跳过那一项，不影响其它 19 项，也不传播到 Cc timer 创建。
4. **per-tab setInterval** + **onDidDispose 注册** 各自的 try/catch（v0.1.9 起）。

这 4 层互相独立：聚合链路上的任何失败都不会拖垮 per-tab 主链路，反之亦然；Cc timer 创建失败也不会传播到 CC 的 `update_session_state` handler（否则会经逗号操作符链向上抛出，砖化会话状态追踪 + 跳过 per-tab setInterval + 跳过 onDidDispose 注册导致 panel 计数永久泄漏）。

**已知限制（诚实声明）**：

- **emoji 颜色保真度依赖 OS 字体栈**：见 §7.1。Win7/无 emoji 字体的 Linux/headless 环境可能黑白或豆腐块；U+26AA 白圈尤其不一致。颜色丢失时形状 + 数字仍承载信息。
- **崩溃/被杀 CC 会话的残留状态文件治理（v0.1.13 review 加固）**：`SessionEnd` 删除文件是 writer 契约（§2），但 CC 崩溃 / 被强杀 / hook pipe 断裂不发 `SessionEnd` 的 session，其 `<sid>.json` 会残留。v0.1.13 review 前只治理 🟡 running（§7.2 的 30-min mtime 启发式）和 🟢 done（§4 的 5-min 规则），🔵 pending 与 🔴 interrupted 都有缺口；review 后补齐为完整四态 GC（聚合层，不动 per-tab 渲染）：
  - 🟡 running：30-min mtime 启发式（§7.2 规则 2）→ idle，不计黄。**仅聚合**——per-tab 保持 🟡 黄提醒"此会话可能已死"（见 §7.4 表"陈旧 running 治理"行的有意分歧）。
  - 🟢 done：5-min since 规则（§4 / §7.2 规则 1）→ idle，不计绿。**聚合 + per-tab 都应用**（一致）。
  - 🔵 pending（**v0.1.13 review 新增**）：`j.pending===true && st!=="idle"` → 复用上面 running/done decay 已算出的 `st`。一个在权限弹窗期间被强杀的会话（state=running、pending=true、mtime>30min）在 🟡 不计（规则 2 降级 idle）的同时，🔵 也不计（`st==="idle"` 跳过 pending）。死会话的 pending 标志对用户零价值（用户根本不知道它存在），无"需保持可见"的辩护理由——故与 🟡/🟢 同款治理。
  - 🔴 interrupted（**v0.1.13 review 新增**）：mtime > `INTERRUPTED_RETENTION_MS`（24 小时）→ idle，不计红。文件**不删**（保留诊断价值，用户可手动检查 `~/.claude/cc-tab-status/<sid>.json` 或清理）。阈值 24h 是"今天的 🔴 保持可见"（原 v0.1.13 设计意图："中断态需保持可见以提醒用户"）与"长期 abandoned 中断会话不应让 🔴 单调增长"的折衷；比 SBI_RUNNING_STALE_MS(30min) 大得多，因为 interrupted 是终态、用户可能想事后检查，而 running 是 live heartbeat、staleness 信号明确。**仅聚合**——per-tab 保持 🔴 红快闪提醒（见 §7.4 表"陈旧 interrupted 治理"行的有意分歧，与 🟡 running 同款）。
  - **per-tab vs 聚合的有意分歧仍存两项**（🟡 running 与 🔴 interrupted，见 §7.4 表对应两行）：tab 保持黄/红提醒、聚合不计——用户看到该状态的 tab 可手动检查并关闭。聚合层 GC 的正当性恰建立在 per-tab **有**独立呈现这一事实上：用户可以肉眼看到哪个 tab 是黄/红并自行处理，聚合灯只需反映"还有多少 live session 处于该态"，故把崩溃/陈旧的会话从聚合计数剔除不引入可见不一致。🔵 pending 是第三种态但**无此分歧**——pending 的 decay 复用 running/done 的 `st`（`j.pending===true && st!=="idle"`），与 per-tab 的 `__ccPending` yield→CC 原生蓝点同步降级。
  - 如需手动清理可删 `~/.claude/cc-tab-status/<sid>.json`，或下次 `Stop`/`SessionEnd` 触发 writer 重写/删除该文件。
- **聚合 vs per-tab 的 permission 一致性（v0.1.13 改进）**：v0.1.10-v0.1.12 时聚合对 permission-pending 期间计为 🟡 running（无窗口级通道读 pending），per-tab 显示 CC 原生蓝点——同一会话两处 UI 不同色，是有意分歧。**v0.1.13 通过 writer 新增 `Notification` 写 `pending:true` 解决**：聚合现在独立计 🔵 pending 灯，与 per-tab CC 原生蓝点**语义一致**（都表示"该会话在等用户输入"），只是颜色载体不同（emoji vs CC 原生 SVG）。
- **reload 后的 setContext 恢复（v0.1.13 review fix，见 §7.1 reload 韧性条目）**：`setContext` 是 window-scoped 运行时状态，extension host 重启即丢失。IIFE 仅由 update_session_state / rename_tab handler 触发，无 activate-time 入口——reload 后若用户未打开 CC panel，4 个 `ccStatusDot.*` key 全是 undefined。修复前 20 个 menu item 一个不显（连 dim ⚪ 都不显，因 `ccStatusDot.X == 0` 在 undefined 时不 match）；修复后 dim 变体用 `!ccStatusDot.X || ccStatusDot.X == 0` 让 undefined 也 match dim，commandCenter 在 reload 盲窗里仍恒显 4 个 ⚪。
- **聚合刷新定时器的"第一 panel 闭包"绑定**：单例定时器由第一个 CC panel 的 IIFE 创建，闭包捕获该 panel 的 `DIR`/`fs`/`vs` 等局部（这些值在所有 panel 间是确定的、无 panel-specific 状态，故无泄漏问题）。最后 panel 关闭时 `clearInterval` 释放定时器；新 panel 打开时由其 IIFE 重建，首 tick 即推真实计数。
- **commandCenter 点击反馈轻量**：点灯只弹一句 `InformationMessage`（解释该灯含义 + 当前计数），不打开 modal、不切 tab、不跳 CC——和"统计指示器"的角色一致。如需操作，用户回到对应 CC tab 处理。

