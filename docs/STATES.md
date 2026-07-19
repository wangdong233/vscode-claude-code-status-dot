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
> 2. **permission pending**（v0.1.8 新增）：reader tick 检测到 `t.__ccsdPending===true` 即 `return`。`__ccsdPending` 由 `rename_tab` handler（Anchor B）每次触发时从 `e.request.hasPendingPermissions`（CC 用来画蓝点的同一个 flag）就地刷新到 panel 实例上；IIFE 每 500ms 读这个 live flag，pending 期间不抢图标。
>
> 背景：PreToolUse 心跳会在 permission 弹窗前把 `state=running` 落盘，CC 又无 permission-pending hook 事件可纠正该文件；v0.1.7 只在"读不到文件"时 return，故 pending 期间 reader 持续用黄 `running.svg` 盖 CC 蓝点（本 bug）。v0.1.8 让 reader 直接读 CC 自己的 pending flag，不再依赖状态文件是否巧合缺失。避免重复造一套 waiting 态。
>
> **v0.1.13/v0.1.14 双重性（dual-nature）**：pending 在 per-tab（本节）由 CC 原生蓝点表达（reader `__ccsdPending` yield）；但在 **底部 SBI 聚合**（§7）里以独立 🔵 蓝灯呈现，由 writer 新增的 `Notification` hook case 写 `pending:true`（§2），reader 聚合独立计数。**per-tab 不读 `pending` 字段**（避免重复造一套 waiting 态），**聚合不读 `__ccsdPending`**（那是 per-panel-live，无窗口级通道）——同一语义，两个通道，各管各的 UI 表面。（v0.1.13 用 commandCenter 作聚合载体但 reload 后不稳；v0.1.14 回退到单 SBI（emoji+数字分开）；v0.1.15 拆成 4 个彩色块 SBI（数字内置块里）；v0.1.16 恢复 emoji 球样式保留 4 SBI 固定位置结构，pending 通道不变。）
>
> **点几何（所有 SVG 统一）**：`viewBox 0 0 24 24`，状态点 `cx=18 cy=6 r=6`，mask 挖空 `r=7.5`（margin 1.5）。16px tab 渲染下点直径 8px，视觉占比 20%（竞品角标黄金比区间：macOS dock badge ~20-25%）。

---

## 2. 事件 → 状态映射（writer 的 case 集 ＝ patcher 的 `HOOK_EVENTS` 接线集，二者必须逐一对齐）

| CC hook 事件 | → 写入 state | 说明 |
|---|---|---|
| `UserPromptSubmit` | `running` + 清 `pending` | 新一轮开始；`activeSubagents` 用 payload `background_tasks` 纠正，**否则重置 0**（防止上轮漂移 bleed 进新轮；`Stop` 才是工作是否剩余的权威——见 regression test 12 / bug e434c0a2）。**v0.1.13 起同时写 `pending:false`**——新 prompt 表示用户已答完之前的权限/问询，🔵 SBI 蓝灯应熄灭 |
| `PreToolUse` | `running` + 清 `pending` | 心跳，刷新 `since`；`activeSubagents` 同 `UserPromptSubmit` 规则（payload 优先，否则 0）。**v0.1.13 清 `pending`**——tool 心跳表示用户已答 prompt，turn 重新推进 |
| `PostToolUse` | `running` + 清 `pending` | 心跳，刷新 `since`；同上 |
| `SubagentStart` | `running` + **保持 `cur.pending`** | **早信号**：subagent 一 spawn 即黄；`activeSubagents` 优先用 `background_tasks` 纠正，否则 +1。**v0.1.13 review round-2 改为保持 `cur.pending`**：subagent spawn 是 **background 事件**，对父会话的 permission/question prompt 是否仍开着无信号——若在 Notification 弹窗期间 spawn helper 却清 `pending`，🔵 SBI 蓝灯会假熄灭直到下一次 Notification/用户事件。仅用户/turn 驱动的事件（UserPromptSubmit / Pre/PostToolUse / Stop / StopFailure）真正清 `pending` |
| `SubagentStop` | `running`（若仍有在飞任务）/ **保持 cur.state（归零时不抢断，写回 activeSubagents:0）** + **保持 `cur.pending`** | `activeSubagents` 优先用 `background_tasks` 纠正，否则 −1（clamp 0）；**始终写回**（落盘递减后的计数 + cur.state，cur.state 限定为 writer 实际会写的三态 running/done/interrupted，其它含默认 'idle' 一律降级 'running'，永不把 'idle' 落盘）。归零时不抢断终态、交 `Stop` 裁定；**且当 cur.state 已是 done/interrupted 且 next===0 时保留 cur.since 不刷新**（reader notify 去重以终态 since 为键，刷新会重复弹通知并重置 done→idle 5 分钟倒计时）。**v0.1.13 review round-2 改为保持 `cur.pending`**——同 `SubagentStart` 理由：subagent 收尾是 background 事件，不应误清父会话 prompt 的 pending 标志 |
| `Notification`（v0.1.13 新增） | **保持 cur.state + cur.since，写 `pending:true`** | CC Notification hook = permission / question / elicit prompt。**不改 state/since**——pending 与 state 正交（一轮 running 可同时是 pending），reader 聚合独立计数（§7 蓝灯）。cur 为默认（无前文件）时降级 state='running' + since=now 写一个 coherent 文件。**仅此事件写 `pending:true`**；用户/turn 驱动事件（UserPromptSubmit / Pre/PostToolUse / Stop / StopFailure）清零；SubagentStart/Stop **保持**（见上） |
| `Stop` | `done`，**除非** payload `background_tasks.length > 0` → `running`；payload 缺字段（inflight=null）也落 `done` 并清零计数；**清 `pending`** | 权威裁定：workflow 后台跑期间不假绿（v2.1.145+）；`Stop` **绝不读盘上 activeSubagents**（counter 可能漂移），只信 payload——缺 payload 也算"无在飞任务"，落 done + 清零 |
| `StopFailure` | `interrupted` + 清 `pending` | 记 `error` 枚举（`rate_limit`/`overloaded`/…）；缺 error 或非字符串一律写 `"interrupted"`（与 reader 兜底文案对齐）；中断优先，保留 `activeSubagents` |
| `SessionEnd` | （删除该 session 状态文件） | 清理——pending 字段随文件消失，无残留 |

**第二个 writer-side 删除触发（v0.1.14 R3 文档加固，见 cc-status.js `Bounded GC`）**：`UserPromptSubmit` 在写当前 session 文件之前，会扫描整个 STATE_DIR，**删除**所有 mtime > `INTERRUPTED_RETENTION_MS`（24h）且 `state !== "interrupted"` 的 `.json` 文件——这是跨 session 的全局清理（一个 session X 的 UserPromptSubmit 可能 unlink 另一个 session Y 的陈旧文件）。理由：崩溃 / 被杀的 CC 进程不发 SessionEnd，没有这层全局扫描 `~/.claude/cc-tab-status/` 会无界增长。**例外**：`state === "interrupted"` 的文件**不删**（即使 >24h）——保留诊断价值，与下文 §7.5 "中断态文件不删（保留诊断价值）" 契约一致；聚合层也已经把它们降级为 idle 不计入 🔴。当前 session 文件也跳过（即将被覆写）。

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
  - `pending`（bool，可选，v0.1.13 新增）：`true` = 该会话正在等待用户输入（permission / question / elicit prompt）。**仅 writer 写**（`Notification` 事件写 `true`；**用户/turn 驱动事件**——UserPromptSubmit / PreToolUse / PostToolUse / Stop / StopFailure——写 `false`；SubagentStart / SubagentStop **保持 `cur.pending`**，因为它们是 background 事件，对父会话 prompt 是否仍开无信号，v0.1.13 review round-2 修正），**仅 reader 的 SBI 聚合读**（§7 蓝灯 🔵）；per-tab 渲染（§4）**不读**此字段——仍由 CC 原生蓝点处理（v0.1.8 `__ccsdPending` yield）。一个会话可同时是 `running` AND `pending`（一轮 running 卡在权限弹窗——典型场景）。writer 为 read-modify-write——**`cur.pending` 从盘上读回**（严格 `=== true`），故 background 事件能安全 preserve。
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
if __ccsdPending (rename_tab hasPendingPermissions=true):  return（不覆盖，让 CC 原生蓝点显示）  # v0.1.8
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

**消息文案**：末尾追加 `[<panel 当前 title>]`——`__ccsdTitle` 由 `update_session_state`（Anchor A）首次写入，并由 `rename_tab`（Anchor B）每次刷新（CC 可能多次 rename），保证通知里展示的是当前 tab 标题而非陈旧值。`done` → `Claude Code: turn complete [<title>]`；`interrupted` → 按 error 映射（`rate_limit`→"rate limit reached"、`overloaded`→"server overloaded"、其它→原值；writer 缺 error 字段或非字符串时双方兜底都为 `"interrupted"`）。

**配置项**（VSCode settings.json `ccStatusDot.*`）：
- `ccStatusDot.notify`（bool，默认 true）：总开关
- `ccStatusDot.notifyWhenFocused`（bool，默认 true）：前台时也通知（"聚焦于 VSCode 窗口"≠"盯着 CC tab"，原默认 `false` 让通知在最常见场景下永远不触发，等同于功能失效）。设 `false` 仅后台时通知。
- `ccStatusDot.notifySound`（string，默认 `"Glass"`）：macOS 系统通知声音（`done` 与 `interrupted` 共用，矩阵不区分声音；`""`=静音；可选 Basso/Ping/Hero 等）。

通知是 reader（IIFE）的职责，**hook 不改**（保持零依赖/跨平台/静默契约）。

---

## 5. 已知限制（诚实声明，写入文档）

**v2 新特性 — workflow / 后台 subagent 跑期间保持 running**：主 agent 回复"已启动"后 `Stop` 不再误写 `done`（假绿）。实现 = hybrid：`Stop`/`SubagentStop` 时优先读 payload 的 `background_tasks[]`（CC v2.1.145+ 权威，覆盖 workflow/subagent/teammate 全类型），缺失时退化为 `activeSubagents` 计数 + `SubagentStart` 早信号。reader 不读 `activeSubagents`，state 仍四态。详见 [`SUBAGENT-design.md`](SUBAGENT-design.md)。

- **手动 Esc 中断无 hook**：CC 不触发 Stop/StopFailure（[#45289](https://github.com/anthropics/claude-code/issues/45289)/[#9516](https://github.com/anthropics/claude-code/issues/9516)），状态会停在 `running`。reader 无 watchdog（当前版本不做主动推断），靠下一次 `UserPromptSubmit`/`Stop` 自然更正。
- **多 session**：每个 CC panel 实例各自一个 500ms 定时器，按各自 `__ccsdSid` 读各自状态文件，互不干扰。
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

## 7. 底部 SBI 4 灯（v0.1.17 单 SBI 紧凑拼接：4 圆点近距拼接 + 位置固定 + 数字等宽不位移；v0.1.13→v0.1.14→v0.1.15→v0.1.16→v0.1.17→v0.1.18→v0.1.19 沿用设计改进）

> **本节是 v0.1.17+ 的底部 StatusBarItem（SBI）4 灯**。v0.1.16 用 4 个独立 SBI 渲染"球+数字"（每灯一个 `createStatusBarItem`，priority `-9996..-9999`），用户反馈"4 圆点之间间隔不紧凑"——根因：**VSCode `statusbarpart.css` 给每个 SBI 硬编码 `margin:0 3px;padding:0 5px`，相邻 SBI 之间约 6-16px 间距，公开 API 无法控制**（扩展拿不到 `margin`/`padding`/`spacing` 字段；内部 `IStatusbarEntryLocation.compact` 标志存在但只对 VSCode 自身核心 entry 开放，扩展上下文 resolve 不到 `vs/workbench/services/statusbar/browser/statusbar` 模块）。priority `-9996..-9999` **只决定排序**，相邻 priority 的 SBI 与 priority 差 100 的 SBI 间距完全相同——priority 技巧无法压缩间距。**4 SBI 路径下 6-16px 间距是 VSCode 框架硬限制**。
>
> **v0.1.17 关键变化：单 SBI 紧凑拼接**——回到 1 个 SBI（`globalThis.__ccsdSbi`，单个 `createStatusBarItem(StatusBarAlignment.Left, -9996)`），但 text 是 4 个 `<球><数字>` token 拼接（v0.1.17 紧贴无分隔；**v0.1.18 起每两个 token 之间加一个空格** —— `parts.join(" ")`，让 4 灯之间有清晰的小间隙，仍远紧凑于 v0.1.16 的 4-SBI 6-16px 空白；dim 球为 ⚪，v0.1.19 reverted v0.1.17 ⚪→🟤 pivot 回到灰球，见 §7.5）。整行宽度从 v0.1.16 的 ~120px（4 块 × 25-30px + 3 个 ~6-16px item 间隔 ≈ 48px 空白）压到 ~75px（含 3 个 token 间空格，无框架空白），4 个圆点视觉上紧贴成"一串彩色珠子"。
>
> **位置稳定性（"数字不位移"）的根因彻底澄清**：
> - **VSCode `statusbarpart.css` 给所有状态栏 item 强制 `font-variant-numeric: tabular-nums`**（源码实证 `microsoft/vscode` 仓库）→ ASCII 数字 0-9 在**任何字体**下都是等宽 OpenType tabular figures。这是"数字宽度变化导致整行位移"问题的**根治**：`cap()` 把 0-3 → 1 字符、4+ → `N`（也是 1 字符），无论计数怎么变化，每灯的"数字部分"宽度永远恒定 1 字符。
> - **dim 球用 ⚪（U+26AA）**（v0.1.19 现状）。历史上 v0.1.17 曾 pivot 到 🟤（U+1F7E4，与 🟢🟡 同属 Geometric Shapes Extended 块）以"用 Unicode 块级分配保证等宽"；v0.1.19 因用户偏好灰球而 revert（commit 55e18b4）。**当前现实**：5 球分属 3 个 Unicode 块（Geometric Shapes Extended: 🟢🟡；Miscellaneous Symbols And Pictographs: 🔵🔴；Miscellaneous Symbols: ⚪）——**实测现代 emoji 字体**（Apple Color Emoji / Noto Color Emoji / Segoe UI Emoji）把所有 emoji 渲染成 1em 正方形 glyph，跨块宽度一致，理论风险在主流字体上不显现（详见 §7.5）。
> - **数字部分的等宽由 VSCode CSS 强制保证**，独立于 emoji 字体——所以"数字不位移"这一**显式需求**得到 100% 满足，与 emoji 渲染无关。
>
> **历史**：v0.1.16 用 4 SBI 渲染球+数字（用户反馈"间隔不紧凑"）；v0.1.15 用 4 SBI 渲染色块+白字数字（用户反馈"色块不如球好看"）；v0.1.14 用单 SBI 拼接 `🟢N 🟡N 🔵N 🔴N`（带空格，用户反馈"数字位移"——根因当时未查明 tabular-nums 兜底，错误归因到数字宽度）；v0.1.13 用 commandCenter 顶部居中（reload 后不稳，已弃）；v0.1.10-v0.1.12 用 SBI 动态 text。**v0.1.17 是"球 + 紧凑 + 数字等宽"的三合一**；**v0.1.18 在 v0.1.17 紧贴无分隔基础上加回 token 间空格**（token 间清晰间隔，但远小于 v0.1.16 的 6-16px 框架间距），因为 tabular-nums 已根治位移，空格只影响视觉透气感不再影响位置稳定；**v0.1.19 把 dim 球从 🟤 revert 回 ⚪**（用户偏好灰球）。
>
> **与 §6 废弃条无关**：§6 是 v0.1.2 在 CC webview 上的色块条（v0.1.3 已删）；本节是 v0.1.17+ 在运行时创建的底部单个 SBI。v0.1.13 在 CC extension `package.json` 上的 commandCenter 4 灯在 v0.1.14 已删（install 自动清理残留）。

### 7.1 位置与显示

- **位置**：VSCode **状态栏左侧**（`StatusBarAlignment.Left` + 单 SBI priority `-9996` → 在所有 Left 项中排序最靠右，故最接近可见中心）。整行 `🟢N 🟡N 🔵N 🔴N` 拼接（v0.1.18+ token 间一个空格），4 灯顺序固定左→右：**🟢done 🟡running 🔵pending 🔴interrupted**。
- **整行渲染**（计数封顶 0/1/2/3/N，N=4+）：
  - **拼接规则**：`for(k=0;k<CFG.length;k++){parts.push((n===0?DIM_EM:CFG[k].em)+(n>=4?"N":""+n));} sbi.text=parts.join(" ");` → 单 text `"🟢3 🟡1 ⚪0 ⚪0"` 等（⚪ 为 v0.1.19 reverted pivot 后的 dim 球）。
  - **计数 0（dim 球 + 0）**：拼接里这一段是 `⚪0`（DIM_EM + "0"）——⚪ U+26AA white/gray medium circle（Miscellaneous Symbols 块；v0.1.19 reverted v0.1.17 ⚪→🟤 pivot 回到灰球）+ 数字 "0"。
  - **计数 1/2/3（彩球 + 数字）**：拼接里这一段是 `🟢1`/`🟡2`/`🔵3`/`🔴1` 等（CFG[k].em + 数字）。球自带色（绿/黄/蓝/红），数字紧跟球右侧。
  - **计数 >=4（彩球 + "N"）**：拼接里这一段是 `🟢N` 等（CFG[k].em + "N"）。`cap(n){return n>=4?4:n}` 把 4+ 截到 4，拼接规则 `(n>=4?"N":""+n)` 把 4 渲染为 `N`。`n===0?DIM_EM:CFG[k].em` 选球（0 用 dim 球 ⚪，非0 用该灯的彩球）。
  - **初始（无任何状态文件时）**：text 是 `DIM_EM+"0"+DIM_EM+"0"+DIM_EM+"0"+DIM_EM+"0"` = `"⚪0⚪0⚪0⚪0"`（4 灯全灭，无空格 —— 创建位点与 tick 位点的拼接形态存在已知 500ms 内不一致，见 §7.5），首 tick 即推真实计数（带空格）。
- **位置固定（v0.1.17 核心优势，根治 v0.1.14 位移错觉）**：每灯 token 长度恒为 `<球><1数字>`（数字都是 1 字符：0-3 或 N，由 VSCode CSS `font-variant-numeric: tabular-nums` **强制等宽**），4 灯拼接后整行总长度恒定（v0.1.18+ 加上 3 个等宽 token-间空格，总长不变）。**无论计数怎么变化，整行不会左右位移**——这是 v0.1.14 单 SBI 失败后的重新尝试，关键差异是：v0.1.17 实证查明了 VSCode 自带 `tabular-nums` 已根治"数字位移"问题（v0.1.14 当时未查明，误把位移归因到数字宽度，实际数字一直等宽，位移的真凶是字体间空格宽度差，且 v0.1.14 时已带空格但当时未发现空格才是位移源）。v0.1.18+ 重新加回空格分隔：tabular-nums 已根治数字位移，剩下的"空格在不同字体下宽度差"在 tabular-nums 之外仍**可能**有亚像素级位移，但实测主流字体下不可见；权衡是"视觉透气感" > "亚像素稳定"，用户在 v0.1.18 commit `e6cc62e` 显式选择了空格分隔。
- **tooltip**：整行共享同一 tooltip——`Claude Code: X done, Y running, Z pending, W interrupted`（未截顶的真实计数）。悬停即见全部分类明细。
- **click**：SBI 的 `.command` 字段设为 `ccStatusDot.sbiClick`（运行时 `vs.commands.registerCommand` 注册，**无需** package.json contribution）。点击弹 `InformationMessage`（读 `__ccsdSbi.tooltip`）。不打断、不开 modal、不切 tab。
- **配色映射**（`SBI_LIGHTS_CFG` patch.ts 单一真相源，`JSON.stringify` 烘焙进 IIFE 的 `var CFG=[...]`；v0.1.17 删了 `pri` 字段，单 SBI 用 sibling 常量 `SBI_PRIORITY = -9996`）：
  - 🟢 done → `\u{1F7E2}`（绿色大圆，U+1F7E2）
  - 🟡 running → `\u{1F7E1}`（黄色大圆，U+1F7E1）
  - 🔵 pending → `\u{1F535}`（蓝色大圆，U+1F535）
  - 🔴 interrupted → `\u{1F534}`（红色大圆，U+1F534）
  - ⚪ dim/zero → `\u{26AA}`（white/gray medium circle，U+26AA；v0.1.17 ⚪→🟤 pivot，v0.1.19 revert 回 ⚪——用户偏好灰球）
- **为何切回单 SBI（用户反馈 + VSCode 框架实证）**：v0.1.16 的 4 SBI 让用户觉得"间隔不紧凑"——VSCode `statusbarpart.css` 给每个 SBI 写死 `margin-right:3px;margin-left:3px;padding:0 5px;`，相邻 SBI 之间约 6-16px 间距（取决于背景色是否覆盖 padding），**公开 API 无 `margin`/`padding`/`spacing` 字段**；VSCode 内部 `compact` 标志存在（`.compact-left` / `.compact-right` CSS 能把间距压到 ~6px）但**只对核心 entry 开放**（如 Ln/Col 与 Encoding 的紧贴对），`createStatusBarItem(alignment, priority)` 签名不接受 `compact` 参数，且 `require("vscode")` 也 resolve 不到内部 statusbar 模块。**4 SBI 路径下，6-16px 间距是 VSCode 框架硬限制，无法绕开**——要紧凑**必须**收回到单 SBI。v0.1.17 在保留 emoji 球审美（用户要的）的同时回到单 SBI 拼接，达成"紧凑 + 球 + 位置稳定"三合一。
- **为何 v0.1.14 单 SBI 有位移错觉而 v0.1.17+ 不会有**：v0.1.14 时未查明 VSCode 自带 `tabular-nums` CSS 兜底，错误归因到数字宽度。**实证**：VSCode `statusbarpart.css` 的 `.monaco-workbench .part.statusbar > .items-container > .statusbar-item` 选择器带 `font-variant-numeric: tabular-nums;`——所有 ASCII 数字 0-9 在任何字体下都是等宽 OpenType tabular figures（见 [MDN font-variant-numeric](https://developer.mozilla.org/en-US/docs/Web/CSS/font-variant-numeric) + [VSCode issue #73700](https://github.com/microsoft/vscode/issues/73700)）。`cap()` 把 0-3 与 4+ 都映射到 1 字符宽（"0"-"3" 或 "N"），所以数字部分的宽度永远恒定。v0.1.14 看到的位移实际来自**带空格分隔符的拼接** `🟢N 🟡N 🔵N 🔴N` 中**空格本身的渲染宽度差**（不同字体下空格宽度可能不同）。**v0.1.17 紧贴无分隔以最严格地消除该位移**；**v0.1.18 加回 token 间空格**（commit `e6cc62e`）：tabular-nums 已根治数字位移，剩下空格宽度差在主流字体下实测不可见，权衡后用户选择了"视觉透气感"。dim 球 v0.1.17 用 🟤、v0.1.19 revert 回 ⚪——见 §7.5 关于该 pivot 的完整历史。
- **配色保真**：emoji 球在 macOS（Apple Color Emoji）/ Windows 10+（Segoe UI Emoji）/ Linux（Noto Color Emoji）走系统彩色 emoji 字体栈。Win7 或无 emoji 字体的 headless 环境可能黑白或豆腐块（v0.1.14/v0.1.16 同款限制）。

### 7.2 数据源与刷新

- **复用窗口级单例定时器** `globalThis.__ccsdSbiTimer`（500ms，`TICK_MS`；v0.1.13 时是 `__ccsdCcTimer`，v0.1.14 重命名为 SBI 语义）——P 个 CC panel 共享一个 timer，每 500ms 触发**一次**聚合（O(S) 文件读，S = 会话数），不再 v0.1.10 的 O(P×S) 读放大。
- 每 tick `fs.readdirSync(DIR)` 列 `~/.claude/cc-tab-status/*.json`，逐文件 `JSON.parse` 读 `state` + `since` + `pending` 字段，**先应用与 per-tab 一致的渲染规则再分桶**：
  1. `state === "done"` 且 `now - since > DONE_TO_IDLE_MS`（5 分钟）→ **不计入 🟢 done**（idle 不算绿，避免陈旧完成永远占绿——只有活跃 done 计绿）。
  2. `state === "running"` 且 `mtime > SBI_RUNNING_STALE_MS`（30 分钟，见 §7.5）→ **不计入 🟡 running**（崩溃/被杀未发 SessionEnd 的会话治理）。
  3. `state === "interrupted"` 且 `mtime > INTERRUPTED_RETENTION_MS`（24 小时，v0.1.13 review fix，见 §7.5）→ **不计入 🔴 interrupted**（🔴 灯不再随累积的 abandoned 中断会话单调增长；文件不删，保留诊断价值）。
  4. 其余按字面 `state` 分桶（`running`/`done`/`interrupted`；`idle` 不参与任何灯——既不算绿也不算黄）。
  5. **`pending` 独立计数 + 同款 GC**（v0.1.13 review fix）：`j.pending === true && st !== "idle"` → `ag.pending++`。`st` 是上面 3 条 decay 规则**已修正过**的值——崩溃/killed 会话（无论原 state 是 running/done/interrupted，只要 mtime 触发 decay 即降级为 idle）的 pending 自动被跳过。这关掉了"🔵 永久粘在 1"的假阳性（一个在权限弹窗时被强杀的会话 state=running/pending=true，running 桶被规则 2 治理但 pending 仍被计入——review 发现并修复）。**与 state 正交**：一个活会话（st 非 idle）可同时计入 🟡 running AND 🔵 pending（典型：running turn 卡在权限弹窗）。
- 4 个计数各自 `cap(n)` 截顶到 4，组 `counts=[cd,cr,cp,ci]`，IIFE **遍历 `CFG`（4 元素配置表）拼接 4 段 token 到单 SBI 的 `.text`**（`parts.push((n===0?DIM_EM:CFG[k].em)+(n>=4?"N":""+n))` 4 次 + `parts.join(" ")` → `🟢3 🟡1 ⚪0 ⚪0`；⚪ 为 v0.1.19 reverted v0.1.17 ⚪→🟤 pivot 后的 dim 球；token 间空格为 v0.1.18 引入）+ `.tooltip`（共享）+ `.show()`。**仅 mutate text**——v0.1.17 不再触碰 `.color` / `.backgroundColor`（球 emoji 自带色，无需主题块/白字）。**直接赋值**——无 setContext 中介，无 when-clause 切换，无 reload 韧性问题（reload 后第一个 CC panel 打开即重建单 SBI + timer，首 tick 即推真实计数）。
- 失败文件 try/catch 跳过（与 reader 一贯风格，不崩扩展）。

### 7.3 全局单例 + click command 注册

- **单 SBI + timer 单例**：`globalThis.__ccsdSbi`（单个 StatusBarItem，v0.1.17 从 v0.1.15/v0.1.16 的 4 元素 `__ccsdSbis` 数组合并回单 SBI）+ `globalThis.__ccsdSbiTimer` 守卫——IIFE 入口检测，第一个 CC panel 创建单个 SBI（一次 `createStatusBarItem(StatusBarAlignment.Left, SBI_PRIORITY=-9996)`，初始 text `"⚪0⚪0⚪0⚪0"`——v0.1.19 reverted v0.1.17 ⚪→🟤 pivot 后；v0.1.17 pivot 期间是 `"🟤0🟤0🟤0🟤0"`；首 tick 立即覆写为带空格的 `⚪0 ⚪0 ⚪0 ⚪0`）+ `setInterval`，后续 panel 复用。`__ccsdPanelCount` 计数器：IIFE 入口 `+1`，`onDidDispose` 内 `-1`；归零（窗口里**最后一个** CC panel 关闭）时立即 `clearInterval(__ccsdSbiTimer)` + **`__ccsdSbi.dispose()` 并置为 null**——整行消失，不会冻结在陈旧计数上（典型场景：CC 崩溃、被强杀）。新 panel 打开时 SBI + timer 重建，首 tick 自然推真实计数。
- **click command 单例**：`globalThis.__ccsdSbiCmdRegistered` 守卫——首个 CC panel 的 IIFE 调 `vs.commands.registerCommand("ccStatusDot.sbiClick", handler)` 一次。`registerCommand` 无需 package.json contribution（palette/menu/keybinding 才需要）；同 host 重复注册同 ID 会抛错，故必须 guard。handler 读 `__ccsdSbi.tooltip`（单 SBI 的 tooltip，每 500ms 刷新）作 `InformationMessage` 弹出——点击 SBI 即见当前 4 灯计数。SBI 的 `.command` 字段设为该 ID，VSCode 点击时自动 execute。
- **命名空间**：`__ccsd*` 项目级前缀（沿用 v0.1.11 决策）——避免占用 CC 自己的 `__cc*` 全局命名空间（见 patch.ts `restoreWebview()` 内 `cc-status-bar-injected` 墓碑注释的警示）。

### 7.4 与 per-tab 四态点的关系（共存，不替代）

| 维度 | per-tab 四态色点（§1 / §4） | 底部 SBI 4 灯（本节） |
|---|---|---|
| 位置 | 每个 CC tab 图标 + Open Editors 视图 | 状态栏左侧（near-center），全局唯一 |
| 灯数 | 4（idle/running/done/interrupted，permission 走 CC 原生蓝） | 4（🟢done 🟡running 🔵pending 🔴interrupted），固定显示 |
| 粒度 | 单 session | 全部 session 汇总计数（0-3+N 封顶） |
| 渲染 | `panelTab.iconPath`（SVG） | 单 SBI `text`（4 段 `<球><数字>` 拼接，直接 mutate `.text`——无 `.color`/`.backgroundColor`） |
| 中断闪烁 | 红色快闪（`flashSeq%2`） | 仅静态彩球+数字（不闪） |
| 颜色保真 | SVG 嵌入 hex，跨平台稳定 | emoji 球自带色，依赖 OS emoji 字体栈（v0.1.17 沿用 v0.1.16 的 emoji 路径） |
| permission 处理 | `__ccsdPending` yield→CC 原生蓝点（per-panel-live） | 🔵 pending 灯（writer 写 `pending:true`，reader 聚合独立计数） |
| 陈旧 running 治理（>30min mtime） | **不应用**——tab 保持 🟡 黄提醒"此会话可能已死" | **应用 §7.2 启发式**——不计 🟡，避免单个崩溃会话永久占黄 1（两者计数因此可能差 1） |
| 陈旧 interrupted 治理（>24h mtime） | **不应用**——tab 保持 🔴 红快闪提醒"此会话被中断过" | **应用 §7.2 规则 3**——不计 🔴，避免累积的 abandoned 中断会话让 🔴 单调增长（两者计数因此可能差 N） |
| done>5min 归 idle | 应用（§4） | 应用（§7.2，不计 🟢） |
| 刷新来源 | 每 panel 一个 per-tab `setInterval`（500ms） | 窗口级单例 `setInterval`（500ms） |
| 失败隔离 | per-tab setInterval 的 `p.iconPath=` 单行 try/catch；onDidDispose 注册也在 try/catch 内 | SBI 创建 + SBI timer 创建 + aggregation body + onDidDispose 各自独立 try/catch（§7.5） |
| reload 韧性 | 高（per-tab 渲染不依赖 window-scoped state） | **高（v0.1.14 改进，v0.1.17 沿用）**——SBI 直接 mutate text，无 setContext key 在 reload 后丢失的问题 |

**互补**：tab 点告诉你"是哪个会话在跑/停了"；SBI 4 灯告诉你"全局总共有几个在跑/停/等输入/中断了"，不用数 tab。

### 7.5 异常安全 + 已知限制（v0.1.11；v0.1.12 加固；v0.1.13 沿用；v0.1.14 重组；v0.1.15 4-SBI 适配；v0.1.16 emoji-ball 切换；v0.1.17 单 SBI 紧凑拼接）

**异常安全（v0.1.17 当前层次）**：v0.1.12 给 SBI 创建 + SBI 单例 timer 创建各加一层独立 try/catch（v0.1.13 重组为 Cc 单例 timer，v0.1.14 重组回 SBI 创建 + SBI 单例 timer，v0.1.15 把单 SBI 创建改为 4-SBI 创建循环，v0.1.16 在此基础上移除了 `.color`/`.backgroundColor` 的赋值，v0.1.17 把 4-SBI 循环合并回单 SBI 创建——同时去掉了 v0.1.15 round-4 的 length-guarded 重建 + commit-atomic 提交 + partial-failure cleanup 三层保护，因为单 SBI 创建只有一次 `createStatusBarItem` 调用，不存在部分失败的中间状态——timer 创建 + aggregation body + onDidDispose 注册的 try/catch 模式完整沿用）。当前结构（自内向外）：
1. **单 SBI 创建 try/catch**（v0.1.12 沿用，v0.1.15 适配为循环，v0.1.16 简化为只设 text/tooltip/command/show，v0.1.17 合并回单 SBI 单次 create）：吞单次 `createStatusBarItem` / `.command=` / `.show()` 的抛出（disposed host、API 暂态失败），让 IIFE 继续走到 per-tab tick + onDidDispose 注册。
2. **SBI 单例 timer 创建 try/catch**（v0.1.12 沿用）：吞掉 `setInterval` 注册的抛出，让 IIFE 继续走到 per-tab tick + onDidDispose 注册。
3. **Aggregation body try/catch**（v0.1.11）：包住 readdirSync/statSync/JSON.parse/单 SBI text mutate 等所有 filesystem + JSON + SBI-mutate 操作。
4. **SBI click command 注册 try/catch**（v0.1.13 新增，v0.1.14/v0.1.15/v0.1.16/v0.1.17 沿用）：包住单次 `vs.commands.registerCommand` 调用——注册抛错（重复、API 暂态）只跳过，不传播到 SBI 创建或 SBI timer 创建。
5. **per-tab setInterval** + **onDidDispose 注册** 各自的 try/catch（v0.1.9 起）。

这 5 层互相独立：聚合链路上的任何失败都不会拖垮 per-tab 主链路，反之亦然；SBI 创建 / timer 创建失败也不会传播到 CC 的 `update_session_state` handler（否则会经逗号操作符链向上抛出，砖化会话状态追踪 + 跳过 per-tab setInterval + 跳过 onDidDispose 注册导致 panel 计数永久泄漏）。

**已知限制（诚实声明）**：

- **v0.1.17 沿用 v0.1.16 的 emoji 字体栈依赖**：v0.1.15 改用 4 个内置 `statusBarItem.*Background` ThemeColor + 白字数字，**完全跟随 VSCode 主题色**，跨平台稳定；v0.1.16 因用户反馈"色块效果不如圆点好看"切回 emoji 球，v0.1.17 在此基础上合并到单 SBI 但保留 emoji 球——Win7/无 emoji 字体的 Linux/headless 环境可能黑白或豆腐块。macOS（Apple Color Emoji）/ Windows 10+（Segoe UI Emoji）/ 主流 Linux（Noto Color Emoji）正常显示彩色。形状是 emoji 字形自带的正圆。
- **`⚪`（U+26AA）跨 Unicode 块的潜在宽度差（v0.1.17 ⚪→🟤 pivot、v0.1.19 revert 回 ⚪）**：`🟢🟡` 属 Geometric Shapes Extended（U+1F780-U+1F7FF），`🔵🔴` 属 Miscellaneous Symbols And Pictographs（U+1F300-U+1F5FF）。v0.1.17 **初版**用 `⚪`（Miscellaneous Symbols U+2600-U+26FF）作为 dim 球——**5 个球分属 3 个不同 Unicode 块**。**实测现代 emoji 字体**（Apple Color Emoji / Noto Color Emoji / Segoe UI Emoji）把所有 emoji 渲染成 1em 正方形 glyph，跨块宽度一致——这是 v0.1.17 初版选择保留 `⚪` 的依据。**理论风险**：某些冷门或老式字体可能让 `⚪` 与彩球宽度略差，导致整行因计数变化（某灯 0↔非0）而左右位移 1-2 像素。**显式需求"数字不位移"由 VSCode CSS `tabular-nums` 独立保证**，与此风险正交；emoji 位移仅是隐式观感问题。
  - **v0.1.17 pivot 到 🟤**（U+1F7E4，与 `🟢🟡` 同属 Geometric Shapes Extended，**理论上**等宽）——5 球缩减到 2 块（Geometric Shapes Extended: 🟢🟡🟤；Miscellaneous Symbols And Pictographs: 🔵🔴），跨块宽度差风险从源头消除。
  - **v0.1.19 revert 回 ⚪**（commit 55e18b4）：用户偏好灰球而非棕球。**这意味着 §7.1 的"块级等宽保证"不再成立**——5 球回到 3 块分布，宽度一致性**完全依赖字体厂商把不同块的 emoji 渲染成 1em 正方形**（实测在 Apple Color Emoji / Noto Color Emoji / Segoe UI Emoji 三家主流字体上均成立；冷门/老式字体理论上仍有位移风险）。**显式需求"数字不位移"由 tabular-nums 兜底，与此风险无关**——emoji 1-2px 位移仅是隐式观感问题，不影响数字部分的等宽。下次 install 时 patcher 会通过 content-hash 检测 IIFE body 漂移并自动 re-inject。
  - 维护契约：`SBI_DIM_EM` 改动时需同步 patch.ts JSDoc（SBI_LIGHTS_CFG + SBI_DIM_EM）+ buildIIFE 注释 + test-iife.mjs 镜像常量 + 本节 §7.1/§7.5。
- **SBI 位置受状态栏拥挤度影响（v0.1.17 改善：碰撞窗口从 4 单位缩到 1 单位）**：单 SBI priority `-9996`（v0.1.17 从 v0.1.16 的 `-9996..-9999` 4 单位区间缩到 1 单位点）让 SBI 在 Left 项里最靠右、最接近可见中心，但 VSCode StatusBarItem API 无真正的"居中"槽位——若用户装了大量其它 Left 项 SBI，或其它扩展声明了恰好 `-9996` 的 priority（无所有权/命名空间机制），SBI 可能被高优 Left 项**挤到角落**。**v0.1.17 的单 SBI 架构消除了 v0.1.16 的"行被外部分隔"失败模式**（v0.1.16 的 4 个独立 SBI 可能被其它扩展的 SBI 插入 done 与 interrupted 之间劈开成两半；v0.1.17 整行是一个 SBI，外部插入只能插到整行两侧，不会把 4 灯拆开）。VSCode StatusBarItem.priority 无所有权/命名空间，碰撞完全静默，`--status` 也不检测——若见到被高优项挤到角落的情况，请在 issue 里上报。这是 API 限制，无法绕开。
- **click command 需 IIFE 注册**：reload 后若用户未打开 CC panel，`ccStatusDot.sbiClick` 未注册，此时点 SBI 不响应（VSCode 静默 no-op）。但 SBI 本身也未创建（IIFE 仅由 panel 打开触发），所以一致性 OK。
- **30-min 陈旧 running 启发式对单工具 >30min 假阳性（v0.1.14 R3 文档加固）**：`PreToolUse`/`PostToolUse` 只在工具调用前后各触发一次——单个工具执行期间 writer 没有 heartbeat，状态文件 mtime 停在 PreToolUse 时刻。任何执行超过 30 分钟的单一工具（长 Bash 命令、慢 MCP 工具、长视频渲染、大测试套件、用户故意写的 `sleep 1800`）期间，聚合层会把该会话从 🟡 running 误判为 idle 并降级，黄色灯熄灭，即便 CC 仍在真实工作。这是 **聚合层** 的偏差——per-tab 仍保持 🟡 黄（§7.4 表"陈旧 running 治理"行的有意分歧恰好兜底：用户看到 tab 黄就知道该会话还活着，只是 SBI 不计它）。缓解措施：(a) 30min 阈值覆盖了绝大多数真实工具调用；(b) 下一次 PreToolUse/PostToolUse（多步工具链的下一步）会刷新 mtime 并让聚合重新计入；(c) 阈值若上调（如 60min）可在 `SBI_RUNNING_STALE_MS` 一处改 + 同步本文档 §7.2 即可。未来若引入工具执行中 heartbeat 可根治。这是 v0.1.10 引入该启发式时遗漏的已知反例，并非新缺陷。
- **崩溃/被杀 CC 会话的残留状态文件治理（v0.1.13 review 加固，v0.1.14 沿用）**：`SessionEnd` 删除文件是 writer 契约（§2），但 CC 崩溃 / 被强杀 / hook pipe 断裂不发 `SessionEnd` 的 session，其 `<sid>.json` 会残留。v0.1.13 review 前只治理 🟡 running（§7.2 的 30-min mtime 启发式）和 🟢 done（§4 的 5-min 规则），🔵 pending 与 🔴 interrupted 都有缺口；review 后补齐为完整四态 GC（聚合层，不动 per-tab 渲染）：
  - 🟡 running：30-min mtime 启发式（§7.2 规则 2）→ idle，不计黄。**仅聚合**——per-tab 保持 🟡 黄提醒"此会话可能已死"（见 §7.4 表"陈旧 running 治理"行的有意分歧）。
  - 🟢 done：5-min since 规则（§4 / §7.2 规则 1）→ idle，不计绿。**聚合 + per-tab 都应用**（一致）。
  - 🔵 pending（**v0.1.13 review 新增**）：`j.pending===true && st!=="idle"` → 复用上面 running/done decay 已算出的 `st`。一个在权限弹窗期间被强杀的会话（state=running、pending=true、mtime>30min）在 🟡 不计（规则 2 降级 idle）的同时，🔵 也不计（`st==="idle"` 跳过 pending）。死会话的 pending 标志对用户零价值（用户根本不知道它存在），无"需保持可见"的辩护理由——故与 🟡/🟢 同款治理。
  - 🔴 interrupted（**v0.1.13 review 新增**）：mtime > `INTERRUPTED_RETENTION_MS`（24 小时）→ idle，不计红。文件**不删**（保留诊断价值，用户可手动检查 `~/.claude/cc-tab-status/<sid>.json` 或清理）。阈值 24h 是"今天的 🔴 保持可见"（原 v0.1.13 设计意图："中断态需保持可见以提醒用户"）与"长期 abandoned 中断会话不应让 🔴 单调增长"的折衷；比 SBI_RUNNING_STALE_MS(30min) 大得多，因为 interrupted 是终态、用户可能想事后检查，而 running 是 live heartbeat、staleness 信号明确。**仅聚合**——per-tab 保持 🔴 红快闪提醒（见 §7.4 表"陈旧 interrupted 治理"行的有意分歧，与 🟡 running 同款）。
  - **per-tab vs 聚合的有意分歧仍存两项**（🟡 running 与 🔴 interrupted，见 §7.4 表对应两行）：tab 保持黄/红提醒、聚合不计——用户看到该状态的 tab 可手动检查并关闭。聚合层 GC 的正当性恰建立在 per-tab **有**独立呈现这一事实上：用户可以肉眼看到哪个 tab 是黄/红并自行处理，聚合灯只需反映"还有多少 live session 处于该态"，故把崩溃/陈旧的会话从聚合计数剔除不引入可见不一致。🔵 pending 是第三种态但**无此分歧**——pending 的 decay 复用 running/done 的 `st`（`j.pending===true && st!=="idle"`），与 per-tab 的 `__ccsdPending` yield→CC 原生蓝点同步降级。
  - 如需手动清理可删 `~/.claude/cc-tab-status/<sid>.json`，或下次 `Stop`/`SessionEnd` 触发 writer 重写/删除该文件。
- **聚合 vs per-tab 的 permission 一致性（v0.1.13 改进，v0.1.14 沿用）**：v0.1.10-v0.1.12 时聚合对 permission-pending 期间计为 🟡 running（无窗口级通道读 pending），per-tab 显示 CC 原生蓝点——同一会话两处 UI 不同色，是有意分歧。**v0.1.13 通过 writer 新增 `Notification` 写 `pending:true` 解决**（v0.1.14 沿用）：聚合现在独立计 🔵 pending 灯，与 per-tab CC 原生蓝点**语义一致**（都表示"该会话在等用户输入"），只是颜色载体不同（emoji vs CC 原生 SVG）。
- **聚合刷新定时器的"第一 panel 闭包"绑定**：单例定时器由第一个 CC panel 的 IIFE 创建，闭包捕获该 panel 的 `DIR`/`fs`/`vs` 等局部（这些值在所有 panel 间是确定的、无 panel-specific 状态，故无泄漏问题）。最后 panel 关闭时 `clearInterval` 释放定时器 + `dispose()` 释放 SBI；新 panel 打开时由其 IIFE 重建，首 tick 即推真实计数。
- **SBI 点击反馈轻量**：点 SBI 只弹一句 `InformationMessage`（当前 tooltip = 4 灯计数明细），不打开 modal、不切 tab、不跳 CC——和"统计指示器"的角色一致。如需操作，用户回到对应 CC tab 处理。
