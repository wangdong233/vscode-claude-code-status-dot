# 状态表（单一真相源 · Single Source of Truth）

> 本文件是 **vscode-claude-code-status-dot 的唯一状态契约**。
> **writer**（`hooks/cc-status.js`）、**reader**（`patch.ts` 注入的 IIFE）、**SVG 文件名**、**文档**（README/USAGE）、**`package.json`** 必须全部引用本表。
> 任何状态 / 事件 / SVG / 颜色的增删：**先改本表，再机械同步其余各处**。这是审查 F-1~F-6 的收敛点。

---

## 1. 状态枚举（4 态 + 1 原生）

| state              | 含义                                                               | 颜色 (hex)    | SVG 文件（项目 `resources/`）                                | 动效                                                                                                 |
| ------------------ | ------------------------------------------------------------------ | ------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `idle`             | 空闲（初始 / 无状态文件 / 完成超 5 分钟）                          | 灰 `#808080`  | `claude-logo-idle.svg`                                       | 静态                                                                                                 |
| `running`          | 运行中                                                             | 黄 `#CCA700`  | `claude-logo-running.svg`                                    | 静态（无动画；v0.1.3 的 8 帧呼吸因 `iconPath` 切帧本质离散、读作闪烁，v0.1.4 回归静态）              |
| `done`             | 完成                                                               | 绿 `#3FB950`  | `claude-logo-done.svg`                                       | 静态；**reader 在 done 超 5 分钟后渲染为 idle**                                                      |
| `interrupted`      | 中断（限速 / 出错）                                                | 红 `#F85149`  | `claude-logo-error.svg` ↔ CC 默认 `claude-logo.svg`          | 快闪（~500ms 切换，on/off）                                                                          |
| `pending` (v0.2.6) | 待用户输入（LLM 回复内容含"等你/你决定/请确认/let me know"等语义） | 蓝 `#58A6FF`  | `claude-logo-pending.svg`                                    | 静态；**reader 在 `j.pending===true && st!=="idle"` 时渲染本蓝点**，优先于 state 的 running黄/done绿 |
| — (permission)     | 待用户授权                                                         | 蓝（CC 原生） | CC 原生 `claude-logo.svg`（permission 时由 CC 自己改色为蓝） | **reader 不覆盖**，CC 原生蓝点照常显示                                                               |

> 设计决策：`permission` 态不纳入 per-tab 渲染——CC 已有原生蓝点处理 `hasPendingPermissions`，reader 在以下两种情况 `return`（不覆盖图标），CC 蓝点自然生效：
>
> 1. **无外部状态文件 / state 未知**（原 v0.1.7 行为）。
> 2. **permission pending**（v0.1.8 新增）：reader tick 检测到 `t.__ccsdPending===true` 即 `return`。`__ccsdPending` 由 `rename_tab` handler（Anchor B）每次触发时从 `e.request.hasPendingPermissions`（CC 用来画蓝点的同一个 flag）就地刷新到 panel 实例上；IIFE 每 500ms 读这个 live flag，pending 期间不抢图标。
>
> 背景：PreToolUse 心跳会在 permission 弹窗前把 `state=running` 落盘，CC 又无 permission-pending hook 事件可纠正该文件；v0.1.7 只在"读不到文件"时 return，故 pending 期间 reader 持续用黄 `running.svg` 盖 CC 蓝点（本 bug）。v0.1.8 让 reader 直接读 CC 自己的 pending flag，不再依赖状态文件是否巧合缺失。避免重复造一套 waiting 态。
>
> **v0.1.13/v0.1.14 双重性（dual-nature）**：pending 在 per-tab（本节）由 CC 原生蓝点表达（reader `__ccsdPending` yield）；但在 **底部 SBI 聚合**（§7）里以独立 🔵 蓝灯呈现，由 writer 新增的 `Notification` hook case 写 `pending:true`（§2），reader 聚合独立计数。**per-tab 不读 `pending` 字段**（避免重复造一套 waiting 态），**聚合不读 `__ccsdPending`**（那是 per-panel-live，无窗口级通道）——同一语义，两个通道，各管各的 UI 表面。（v0.1.13 用 commandCenter 作聚合载体但 reload 后不稳；v0.1.14 回退到单 SBI（emoji+数字分开）；v0.1.15 拆成 4 个彩色块 SBI（数字内置块里）；v0.1.16 恢复 emoji 球样式保留 4 SBI 固定位置结构，pending 通道不变。）
>
> **v0.2.6 blue-via-content 扩展（pending 第三通道）**：除 permission（CC 原生蓝点 yield）和 Notification（聚合 🔵）外，新增"**reader per-tab 直接读 `j.pending`**"通道——writer 在 `Stop` 事件读 `payload.last_assistant_message`（LLM 最后回复纯文本），若含"待用户决策"语义（中英 idiom：`等你/你决定/请确认/告诉我/let me know/your call/please confirm` 等；或末行 ≤60 字符的独立问句 `需要继续吗？/Should I proceed?`），写 `pending:true`，reader per-tab tick 命中 `pend && st!=="idle"` 即渲染蓝色 `claude-logo-pending.svg`，**优先于 state 的 running-黄 / done-绿**。这覆盖了用户的核心场景："CC 回复'等你测试反馈'但 background_tasks 漂移导致 state=running 卡黄"——现在 reader 看到 `j.pending=true` 直接渲染蓝点，stuck-running 解决。**绿逻辑（done=绿）完全不动**：neutral 完成消息（"已完成。所有测试通过。" / "Done. Shipped."）→ `pending:false` → done 分支照常绿。**关键词精准设计**（高 precision 优先于 recall，假蓝比假绿更刺眼）：中文用"你"作用户锚点，干净区分"等你"(用户) vs "等待加载"(技术)；英文用多词 idiom（"let me know" 而非 "decided"），LLM 自述"我已决定"不命中。代码块（`fenced` 和 `inline`）匹配前剥离，防 `letMeKnow` 标识符误判。`stop_hook_active=true` 时跳过（CC 防死循环）。
>
> **点几何（所有 SVG 统一）**：`viewBox 0 0 24 24`，状态点 `cx=18 cy=6 r=6`，mask 挖空 `r=7.5`（margin 1.5）。16px tab 渲染下点直径 8px，视觉占比 20%（竞品角标黄金比区间：macOS dock badge ~20-25%）。pending.svg 与 done.svg 几何完全一致（同 Claude logo path + 同 mask），仅状态圆 fill 从 `#3FB950` 换为 `#58A6FF`、title 改为 `Claude (Pending)`。

---

## 1.5 per-tab 状态转换逻辑（权威定义 · v0.5.32）

> **每 tab 渲染(§H)的状态机,单一真相源。** 任何 tab 颜色争议以此为准。
> 实现:patch.ts §H per-panel 500ms tick(读 `<sid>.json` → `__ccsdDecayState` 衰减 → SVG 渲染分支)。

### 状态机（用户确认 spec）

```
初始化（sid 未设 / 读不到文件）        → 灰  claude-logo-idle.svg
初始化已有（读到文件）→ 按优先级渲染：
  需人为介入（pending）                 → 蓝  claude-logo-pending.svg   [优先级最高]
  出现问题（interrupted）              → 红  claude-logo-error.svg（快闪）
  对话开始（running）                  → 黄  claude-logo-running.svg
  对话结束（done）                     → 绿  claude-logo-done.svg
  绿 > 5 分钟（done 衰减→idle）        → 灰  claude-logo-idle.svg
```

### 渲染优先级（上方高；`st` 互斥取一,`pend` 与 `st` 正交）

1. **蓝** `if(pend && st!=="idle")`（patch.ts:2552）—— `pend` 三源 OR:`j.pending`(Notification 文件标记) ‖ `__ccsdPendingSet[sid]`/`__ps`(rename_tab `hasPendingPermissions` —— 覆盖**工具授权 + askUserQuestion**,因 askUserQuestion 走 can_use_tool→permissionRequests→hasPendingPermissions) ‖ `__ccsdUserDialogSet[sid]`(ANCHOR_C —— consent/refusal 对话框)。interrupted 时 writer 侧抑制 `j.pending`(cc-status.js preserveInterrupted),故"问题"必显红、不被蓝盖。
2. **红** `if(st==="interrupted")`（:2554）—— StopFailure 写入,sticky(直到 `UserPromptSubmit` 才清 → running)。
3. **黄** `else if(st==="running")`（:2556）。
4. **绿** `else if(st==="done")`（:2557）。
5. **灰（衰减）** `else if(st==="idle")`（:2558）—— `done` 超 `DONE_TO_IDLE_MS`(5min)或 `running` 超 `SBI_RUNNING_STALE_MS`(30min 且无 token 活动),经 `__ccsdDecayState(st,since,j,now,false)` 降级。
6. **灰（初始化）** `else`(st=null 读失败,:2559)或 `if(!sid)` 早返回(:2410)。

> **F7 (v0.5.34 文档)**: panel 关闭时正有 permission(Notification 已写 pending:true 到 .json)→ onDidDispose 不清 .json → SBI 有 ≤30min 假蓝尾(由 running-stale 衰减 SBI_RUNNING_STALE_MS 兜底)。这是已知有界行为,不是 bug;衰减链是此 crash 路径的 load-bearing 安全网。

### 关键语义（v0.5.32 定案）

- **初始化 = 灰**:sid 未设 / 读失败 → 一律灰。含会话刚建、历史重开(sid 瞬态未到)、sid 永久缺失(罕见边角 —— §H 诚实显灰,**§F 四灯始终显真相**)。**不猜绿 / 不猜黄 —— 未知即灰。**
- **绿→灰(5min)是唯一合法的"由绿转灰"路径**;初始化/读失败的灰与之同色(都是 idle.svg)但来源不同。
- **蓝覆盖一切活动态**(running/done 上的 pending 都显蓝);红(interrupted)因 writer 抑制 pending 而独占红。
- **sid 来源**:`update_session_state`(带 sessionId)设定;`rename_tab` 在 CC 2.1.220 **不携带 sessionId**(v0.2.5 注释前提已证伪)。故"初始化"窗口 = panel 建立到首次 `update_session_state` 到达。
- **底部四灯(§F)**:与 §H 同公式,但 sid-blind(`readdirSync` 扫所有 `<sid>.json`),故多 tab / sid 缺失时 §F 仍是真相。

## 2. 事件 → 状态映射（writer 的 case 集 ＝ patcher 的 `HOOK_EVENTS` 接线集，二者必须逐一对齐）

| CC hook 事件                   | → 写入 state                                                                                                                                                                                                                                                                        | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UserPromptSubmit`             | `running` + 清 `pending`                                                                                                                                                                                                                                                            | 新一轮开始；`activeSubagents` 用 payload `background_tasks` 纠正，**否则重置 0**（防止上轮漂移 bleed 进新轮；`Stop` 才是工作是否剩余的权威——见 regression test 12 / bug e434c0a2）。**v0.1.13 起同时写 `pending:false`**——新 prompt 表示用户已答完之前的权限/问询，🔵 SBI 蓝灯应熄灭                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `PreToolUse`                   | `running` + 清 `pending`                                                                                                                                                                                                                                                            | 心跳，刷新 `since`；`activeSubagents` 同 `UserPromptSubmit` 规则（payload 优先，否则 0）。**v0.1.13 清 `pending`**——tool 心跳表示用户已答 prompt，turn 重新推进                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PostToolUse`                  | `running` + 清 `pending`                                                                                                                                                                                                                                                            | 心跳，刷新 `since`；同上                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SubagentStart`                | `running` + **保持 `cur.pending`**                                                                                                                                                                                                                                                  | **早信号**：subagent 一 spawn 即黄；`activeSubagents` 优先用 `background_tasks` 纠正，否则 +1。**v0.1.13 review round-2 改为保持 `cur.pending`**：subagent spawn 是 **background 事件**，对父会话的 permission/question prompt 是否仍开着无信号——若在 Notification 弹窗期间 spawn helper 却清 `pending`，🔵 SBI 蓝灯会假熄灭直到下一次 Notification/用户事件。仅用户/turn 驱动的事件（UserPromptSubmit / Pre/PostToolUse / Stop / StopFailure）真正清 `pending`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SubagentStop`                 | `running`（若仍有在飞任务）/ **保持 cur.state（归零时不抢断，写回 activeSubagents:0）** + **保持 `cur.pending`**                                                                                                                                                                    | `activeSubagents` 优先用 `background_tasks` 纠正，否则 −1（clamp 0）；**始终写回**（落盘递减后的计数 + cur.state，cur.state 限定为 writer 实际会写的三态 running/done/interrupted，其它含默认 'idle' 一律降级 'running'，永不把 'idle' 落盘）。归零时不抢断终态、交 `Stop` 裁定；**且当 cur.state 已是 done/interrupted 且 next===0 时保留 cur.since 不刷新**（reader notify 去重以终态 since 为键，刷新会重复弹通知并重置 done→idle 5 分钟倒计时）。**v0.1.13 review round-2 改为保持 `cur.pending`**——同 `SubagentStart` 理由：subagent 收尾是 background 事件，不应误清父会话 prompt 的 pending 标志                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Notification`（v0.1.13 新增） | **保持 cur.state + cur.since，写 `pending:true`**                                                                                                                                                                                                                                   | CC Notification hook = permission / question / elicit prompt。**不改 state/since**——pending 与 state 正交（一轮 running 可同时是 pending），reader 聚合独立计数（§7 蓝灯）。cur 为默认（无前文件）时降级 state='running' + since=now 写一个 coherent 文件。**仅此事件写 `pending:true`**；用户/turn 驱动事件（UserPromptSubmit / Pre/PostToolUse / Stop / StopFailure）清零；SubagentStart/Stop **保持**（见上）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Stop`                         | `done`，**除非** payload `background_tasks.length > 0` → `running`；payload 缺字段（inflight=null）也落 `done` 并清零计数；**清 `pending`（v0.5.29 移除 v0.2.6 文本启发式例外，Stop 现总清）**；**v0.2.7：cur.state===interrupted 且 !stayRunning 时保持 interrupted（Q2 sticky）** | 权威裁定：workflow 后台跑期间不假绿（v2.1.145+）；`Stop` **绝不读盘上 activeSubagents**（counter 可能漂移），只信 payload——缺 payload 也算"无在飞任务"，落 done + 清零。**[v0.5.29 已移除此文本启发式 — Stop 现总清 `pending`；下面为历史记录]** v0.2.6 blue-via-content（已废弃）：若 `payload.last_assistant_message`（LLM 最后回复纯文本）含"待用户决策"语义（`AWAIT_USER_RE` 匹配中英 idiom `等你/你决定/请确认/let me know/your call/please confirm` 等，或末行 ≤60 字符的独立问句 `需要继续吗？/Should I proceed?`）→ 改写 **`pending:true`**（reader 蓝点优先于 done-绿/running-黄，底部 🔵 也计）。`stop_hook_active=true` 时跳过（CC 防死循环门）。neutral 完成（"已完成"/"Done."）→ `pending:false`（绿逻辑不动）。代码块在匹配前剥离防 `letMeKnow` 误判。stuck-running（luceo）：inflight>0 + "等你测试反馈" → state=running + pending=true → reader 蓝（用户核心场景）。**v0.2.7（Q2 interrupted sticky）**：用户报告"interrupted 红色自己消了"，三嫌疑之一是 CC 自动 Stop 覆盖 interrupted→done。修复：`cur.state==='interrupted'` 且 `!stayRunning`（无 inflight）→ 保持 interrupted + cur.since + cur.error（不抢断、不刷新 since、不清 error）。inflight>0 仍允许 interrupted→running（rare：workflow 真解除了阻塞，黄比红更准）。`UserPromptSubmit` 才是用户语义的"会话继续"触发器（清 interrupted→running）；Stop 只是同轮延迟事件。镜像 `SubagentStop` 的 preserveSince/preserveError 模式（对称契约） |
| `StopFailure`                  | `interrupted` + 清 `pending`                                                                                                                                                                                                                                                        | 记 `error` 枚举（`rate_limit`/`overloaded`/…）；缺 error 或非字符串一律写 `"interrupted"`（与 reader 兜底文案对齐）；中断优先，保留 `activeSubagents`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SessionEnd`                   | **v0.2.7：仅在 `cur.state !== 'interrupted'` 时删除该 session 状态文件**；interrupted 时返回 null（不删不写，保留 🔴 sticky 直到用户发新 prompt）。无论删否，**`<sid>.offset`（累积读游标）+ `<sid>.tokens.json`（token 展示快照）都不删**——见 §8.7 v0.2.7 持久化契约               | 清理瞬态 state（running/done/pending）；保留累积 token 状态 + interrupted 红灯 sticky。pending 字段随 .json 消失（仅在非 interrupted 时）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PostCompact`（v0.2.9 新增）   | **仅当 `cur.state === 'interrupted'` 时**：写 `done` + 清 `error`/`pending` + 刷新 `since`；否则 **no-op**（返回 null，不写盘，running/done/pending 一律保留）                                                                                                                      | /compact（或 auto-compact）完成信号。/compact 中止 in-flight turn 触发 `StopFailure`（唯一 interrupted writer）→ 没有此 case 时 Q2 的 `preserveInterrupted` 分支会保持 🔴 sticky 直到下一个 UserPromptSubmit。compact 不是真失败（用户主动发起，会话继续带 compacted transcript），PostCompact 是"compact 完成、会话继续"的语义信号，清除 compact 误判的红球。**真 StopFailure（rate_limit/overloaded）未被 PostCompact 跟随时不变**（Q2 7d sticky 保留，见 test §Q.3）。SessionStart 仍未接（audit F-5）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**第二个 writer-side 删除触发（v0.1.14 R3 文档加固，见 cc-status.js `Bounded GC`；v0.2.7 阈值由 24h 延至 7d）**：`UserPromptSubmit` 在写当前 session 文件之前，会扫描整个 STATE_DIR，**删除**所有 mtime > `INTERRUPTED_RETENTION_MS`（**v0.2.7：7d**）且 `state !== "interrupted"` 的 `.json` 文件——这是跨 session 的全局清理（一个 session X 的 UserPromptSubmit 可能 unlink 另一个 session Y 的陈旧文件）。理由：崩溃 / 被杀的 CC 进程不发 SessionEnd，没有这层全局扫描 `~/.claude/cc-tab-status/` 会无界增长。**例外**：`state === "interrupted"` 的文件**不删**（即使 >7d）——保留诊断价值，与下文 §7.5 "中断态文件不删（保留诊断价值）" 契约一致；聚合层也已经把它们降级为 idle 不计入 🔴。当前 session 文件也跳过（即将被覆写）。**v0.2.7 同步扫描 `.offset` / `.tokens.json` / `.forcereread`**：三者用**纯 mtime 规则**（>7d reap），**不再看 `.json` 是否存在**——SessionEnd 删 `.json` 但保留这三者，旧"按 .json 孤儿判"会立即 reap post-SessionEnd 的 `.offset` 等于没修。`isTokens` 判断必须先于 `isJson`（`.tokens.json` 也 endsWith `.json`），见 §8.7。

**故 `HOOK_EVENTS` = `["UserPromptSubmit","PreToolUse","PostToolUse","SubagentStart","SubagentStop","Notification","Stop","StopFailure","SessionEnd","PostCompact"]`**（10 个，v0.1.13 加入 `Notification`，v0.2.9 加入 `PostCompact`）。

**故意不接的事件**（及原因，防止死接线）：

- `SessionStart`：writer 无对应 case（接了也是死接线，audit F-5）。v0.2.9 接入了 `PostCompact`（compact 完成信号），SessionStart 仍未接——PostCompact 单独覆盖 /compact 路径下所有 CC 版本；若未来发现某些 CC 版本 /compact 仅发 SessionStart(source=compact) 而不发 PostCompact，可在 follow-up 加 SessionStart case 带 `payload.source === 'compact'` 过滤（initial-session /resume /clear 的 SessionStart 仍 no-op）。

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

| 目录                                        | 内容                                                                                                                                           | 由谁创建                               | `--revert` 是否清理      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------ |
| `~/.claude/cc-tab-status/`                  | **状态 IPC 文件**（本节 §3，每 session 一个 `<sid>.json`）                                                                                     | writer（hook）首次写入                 | **否**（用户数据，保留） |
| `~/.claude/cc-status-dot/`（`INSTALL_DIR`） | **运行时副本**：`resources/*.svg`（4 个 = idle + running + done + error，reader 引用）+ `hooks/cc-status.js`（settings.json 接线的 hook 目标） | patcher 安装时从项目源复制（幂等覆盖） | **是**（删整个目录）     |

> **持久化设计（v0.2）**：reader（注入 IIFE）的 `RES` 与 settings.json 接线的 hook 命令都指向 `INSTALL_DIR` 的**绝对路径**，而非项目源目录。这样即使用户删除项目目录或 npx 缓存被清，已 patch 的扩展仍能照常渲染。安装一行：`npx vscode-claude-code-status-dot`。`PROJECT_ROOT` 仅用于"复制源"（安装时读一次），编译后从 `dist/patch.js` 运行时自动回溯到包根目录。

---

## 4. reader 渲染逻辑（patch.ts 注入 IIFE，每 500ms 一帧）

> **reader 只读 `state`（仍四态）+ `since` + `error` + `pending`（v0.2.6 新增）**；`activeSubagents` 是 writer 内部记账字段，reader 不读、不渲染。workflow 跑期间保持 running 完全由 writer 在 `Stop`/`SubagentStop` 时改写 `state` 实现。v0.1.4 起 running 渲染为**静态黄点** `#CCA700`（v0.1.3 的 8 帧正弦呼吸因 `iconPath` 切帧本质离散、帧间不连续，肉眼读作闪烁而非渐变，故回归静态；和 idle/done/error 一样无动画）。500ms 定时器仍在跑——interrupted 的 `flashSeq%2` 快闪需要它，静态态每 tick 重新赋同一个路径（廉价 no-op）。

```
读 <sid>.json → state, since, error, pend(v0.5.30 = j.pending OR __ps[sid] OR __ccsdUserDialogSet[sid])
# notify 去重（v0.1.5+：以终态 since 时间戳为键，旧的 prevSt 转换检查已废弃）：
if !seeded:
  seeded = true
  if state ∈ {done, interrupted}:  lastTermSince = since   # 首帧种子，防 reload 进陈旧 done 误触
else if state ∈ {done, interrupted} && since !== lastTermSince:
  lastTermSince = since;  notify(state, error)              # 见 §4b
if __ccsdPending (rename_tab hasPendingPermissions=true):  return（不覆盖，让 CC 原生蓝点显示）  # v0.1.8
# v0.5.29: pend = (j.pending===true) OR (__ccsdPendingSet[sid]===true)。j.pending 仅由 Notification
# hook 写（真实权限/选择 prompt）；Stop 已不再写 pending（移除 v0.2.6 AWAIT_USER_RE 文本启发式——
# 它对问候回复过度触发，是"hi tab 变蓝"bug 根因）。__ps 由 rename_tab hasPendingPermissions /
# update_session_state waiting_input 喂入（源自 permissionRequests.length>0 真实对话框）：
#
# v0.5.30: 三个独立 OR 源（R-INT-07: 三个 single-writer，每个 reader 每 tick fresh 读）。
#   (1) j.pending —— Notification hook 写（cross-window 文件标志；覆盖真实权限/选择 prompt
#       与 askUserQuestion 路径的 can_use_tool 部分；**不**覆盖 consent/refusal——Notification
#       notification_type 枚举排除它们）。
#   (2) __ps（__ccsdPendingSet）—— rename_tab hasPendingPermissions / update_session_state
#       waiting_input 喂入（per-window IPC；**隐式覆盖 askUserQuestion**——CC 2.1.220 把
#       askUserQuestion 走 can_use_tool → tool_permission_request → permissionRequests →
#       rename_tab hasPendingPermissions → __ps；这是 Fact-1 路径）。
#   (3) __ccsdUserDialogSet（v0.5.30 ANCHOR_C）—— requestUserDialog 的 user_dialog_request
#       IPC 喂入（per-window IPC；覆盖 Notification hook **看不到**的 consent/refusal 对话框——
#       fable_overage_consent_prompt、refusal_fallback_prompt）。try/finally wrap：sendRequest
#       前置 set，finally 删除（覆盖所有出口：用户响应 / abort / 通道关闭）。onDidDispose 兜底
#       删除防止面板关闭中失序。
# 三个源都按 SAME sid（真实 session UUID）keying；__ccsdUserDialogSet 用 this.__ccsdSid
# （== replA/replB 写入的 sid），**不是** requestUserDialog 首参 e（channelId，随机串）。
#
# MCP elicitation（2.1.220）**不被覆盖**：spawnClaude 不传 onElicitation → SDK 自动
# decline → 不发任何 IPC 到 webview → 没东西能变蓝。预期行为：elicitation 永远不会
# 阻塞用户。**未来 CC 若 wire onElicitation，需重新审计**（elicitation 会走 user_dialog_
# request 还是其它 IPC？若是前者，自动被 __ccsdUserDialogSet 覆盖）。
#
# askUserQuestion **隐式**覆盖（经 __ps，见 Fact 1）。**未来 CC 若把 askUserQuestion 从
# can_use_tool 改路由到 user_dialog_request，覆盖会从 __ps 转到 __ccsdUserDialogSet
# （仍变蓝，但走新 term）—— 上述三个源都被本注记 + test-iife.mjs 的 IIFE.12b/IIFE.29b2
# 锁定，shift 会被检测到（一个 term 失去 justification），而非静默。
if pend && st !== "idle":  视为 pending                       # 蓝点优先于 state（优先级在 __ccsdPending yield 之后、state if-chain 之前）
  RES/claude-logo-pending.svg  # 静态蓝 #58A6FF（无动画）；return
if state == "done" and now - since > 5min:  视为 idle
switch state:
  running:     RES/claude-logo-running.svg   # 静态黄 #CCA700（无动画）
  interrupted: flashSeq 偶 → claude-logo-error.svg / flashSeq 奇 → CC claude-logo.svg（快闪 on/off，~500ms）
  idle:        claude-logo-idle.svg
  done:        claude-logo-done.svg
  其它/无文件:  return（不覆盖，让 CC 原生图标显示）
flashSeq++   # 每 tick 自增，仅供 interrupted 的 flashSeq%2 判定
```

> **v0.2.6 blue-via-content 优先级链**（高 → 低）：(1) `t.__ccsdPending`（CC 原生 permission 蓝点）→ `return` 让 CC 蓝点显示；(2) `pend && st!=="idle"`（reader 直接读 `j.pending`，writer 由 Notification 或 Stop last-message 语义匹配写入）→ 渲染蓝色 `claude-logo-pending.svg`，`return`；(3) 按 state 渲染 running/done/interrupted/idle。即"**蓝优先 state**"——stuck-running 场景（state=running 漂移 + last_message"等你"→ pending=true）下 reader 渲染蓝而非黄。**绿逻辑（done=绿）完全不动**：pending=false 时 done 分支照常走 → 绿。

> **为什么 v0.1.4 回归静态**：VSCode 的 `tab.iconPath` 在每次赋值后触发一次图标重渲染，帧间没有插值/过渡——所以"呼吸动画"本质是一串离散静态图被快速切换，相邻帧色差再小也读作闪烁（flicker），而非连续渐变（fade）。静态黄点和 idle/done/error 视觉语言一致，最干净。interrupted 保留快闪是因为它携带真实的"告警"语义（出错 / 限速），值得打破静态。`flashSeq` 仍保留并每 tick 自增，仅供 interrupted 的 `flashSeq%2` 判定。

> **v0.1.5 notify 去重算法升级**：旧逻辑 `prevSt && prevSt !== state && state ∈ {done, interrupted}` 要求 500ms 轮询**采样到** `running` 再切到 `done`/`interrupted` 才触发——若一轮跑得太快（两次 poll 之间已完成 running→done）或 reload 落在旧 `done` 上，转换永远观测不到，通知丢失。新逻辑以**终态 `since` 时间戳**为去重键（`Stop`/`StopFailure` 每次刷新 `since`；`SubagentStop` 在 cur.state 已终态且 next===0 时保留 cur.since 防误触），首帧种子防 reload 误报，之后每个**新的终态 `since`** 触发一次。覆盖快速完成、reload、连续多轮等全部路径，且不重复弹。详见 git log。

---

## 4b. reader 通知逻辑（done / interrupted 时触发）

触发条件：**`since` 时间戳去重**——首次 poll 时 `seeded=true` 记录当前终态 `since`（防 reload 进陈旧 `done` 误触）；之后仅当 `done`/`interrupted` 的终态 `since` 发生变化（`Stop`/`StopFailure` 每次刷新 `since`，`SubagentStop` 在 cur.state 已终态且 next===0 时**保留 cur.since** 防误触）才触发一次 notify。

**渲染通道与焦点正交**——IIFE 的实际分支以 `os.platform()` 选渲染通道，以 `vs.window.state.focused` × `notifyWhenFocused` 决定是否抑制：

| 平台                                    | VSCode 前台 + `notifyWhenFocused:true`（默认）                                                                                                                                                      | 前台 + `notifyWhenFocused:false` / 后台                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **macOS**（`os.platform()==="darwin"`） | osascript 系统通知（屏幕右上角下拉，带声音，无按钮，几秒自动消失）；osascript 异步或同步失败时**回落 VSCode `showInformation/WarningMessage`**（防权限被拒/二进制缺失/转义 bug 让通知功能彻底静默） | 后台同左（osascript）；前台+`notifyWhenFocused:false` 抑制 |
| **Windows / Linux**（无 osascript）     | VSCode `showInformationMessage`（done）/ `showWarningMessage`（interrupted），右下角 toast                                                                                                          | 同左                                                       |

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
>
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
  2. `state === "running"` 且 `since > SBI_RUNNING_STALE_MS`（30 分钟，见 §7.5）→ **不计入 🟡 running**（崩溃/被杀未发 SessionEnd 的会话治理；**v0.2.6：decay key 从 mtime 改为 `since`**——Stop preserveSince 路径 cc-status.js:390-401 在 inflight>0 时保留 cur.since 但 writeJsonAtomic 每次都刷新 mtime，CC 对漂移 inflight workflow 重复 fire Stop → mtime 永远新、mtime-decay 永不触发；`since` 是 *→running 的真实转移时间，被 preserveSince 保留（不刷新），故 since-decay 在同路径下正常触发。与规则 1（done since>5min）/ 规则 3（interrupted since>24h）对称）。**v0.5.2 (#4)：降级前再过 `__ccsdTranscriptFresh` 活动门**——若该会话的 transcript（`.jsonl`）在 `SBI_RUNNING_STALE_MS` 内被写过（mtime 新），说明仍在流式输出（长 turn / 等待 subagent 会冻结 `since` 但 jsonl 持续增长）→ **不降级**。这是对"长活动 workflow 因 `since` 陈旧被误判 idle"的根治：stuck-drift 案例的伪 Stop heartbeat 只刷新状态文件 mtime 不刷新 transcript，故 transcript 仍陈旧 → 仍正常 decay（v0.2.6 的 since-decay 修复完整保留）。该 statSync 仅在 since 已过阈的 decay-candidate 上触发，开销有界。
  3. `state === "interrupted"` 且 `since > INTERRUPTED_RETENTION_MS`（**v0.2.7：7 天**，v0.1.13 review fix，v0.2.4 round-2 since-key 修正，v0.2.7 阈值延至 7d 见 §7.5）→ **不计入 🔴 interrupted**（🔴 灯不再随累积的 abandoned 中断会话单调增长；文件不删，保留诊断价值。**decay key 是 `since`**——orphan SubagentStop/Notification 写刷新 mtime 但保留 since cc-status.js preserveSince/preserveError 路径，mtime-decay 永不触发）。
  4. 其余按字面 `state` 分桶（`running`/`done`/`interrupted`；`idle` 不参与任何灯——既不算绿也不算黄）。
  5. **`pending` 独立计数 + 同款 GC**（v0.1.13 review fix）：`j.pending === true && st !== "idle"` → `ag.pending++`。`st` 是上面 3 条 decay 规则**已修正过**的值——崩溃/killed 会话（无论原 state 是 running/done/interrupted，只要 `since` 触发 decay 即降级为 idle；v0.2.6 running decay key 从 mtime 改 since）的 pending 自动被跳过。这关掉了"🔵 永久粘在 1"的假阳性（一个在权限弹窗时被强杀的会话 state=running/pending=true，running 桶被规则 2 治理但 pending 仍被计入——review 发现并修复）。**与 state 正交**：一个活会话（st 非 idle）可同时计入 🟡 running AND 🔵 pending（典型：running turn 卡在权限弹窗）。
- 4 个计数各自 `cap(n)` 截顶到 4，组 `counts=[cd,cr,cp,ci]`，IIFE **遍历 `CFG`（4 元素配置表）拼接 4 段 token 到单 SBI 的 `.text`**（`parts.push((n===0?DIM_EM:CFG[k].em)+(n>=4?"N":""+n))` 4 次 + `parts.join(" ")` → `🟢3 🟡1 ⚪0 ⚪0`；⚪ 为 v0.1.19 reverted v0.1.17 ⚪→🟤 pivot 后的 dim 球；token 间空格为 v0.1.18 引入）+ `.tooltip`（共享）+ `.show()`。**仅 mutate text**——v0.1.17 不再触碰 `.color` / `.backgroundColor`（球 emoji 自带色，无需主题块/白字）。**直接赋值**——无 setContext 中介，无 when-clause 切换，无 reload 韧性问题（reload 后第一个 CC panel 打开即重建单 SBI + timer，首 tick 即推真实计数）。
- 失败文件 try/catch 跳过（与 reader 一贯风格，不崩扩展）。

### 7.3 全局单例 + click command 注册

- **单 SBI + timer 单例**：`globalThis.__ccsdSbi`（单个 StatusBarItem，v0.1.17 从 v0.1.15/v0.1.16 的 4 元素 `__ccsdSbis` 数组合并回单 SBI）+ `globalThis.__ccsdSbiTimer` 守卫——IIFE 入口检测，第一个 CC panel 创建单个 SBI（一次 `createStatusBarItem(StatusBarAlignment.Left, SBI_PRIORITY=-9996)`，初始 text `"⚪0⚪0⚪0⚪0"`——v0.1.19 reverted v0.1.17 ⚪→🟤 pivot 后；v0.1.17 pivot 期间是 `"🟤0🟤0🟤0🟤0"`；首 tick 立即覆写为带空格的 `⚪0 ⚪0 ⚪0 ⚪0`）+ `setInterval`，后续 panel 复用。`__ccsdPanelCount` 计数器：IIFE 入口 `+1`，`onDidDispose` 内 `-1`；归零（窗口里**最后一个** CC panel 关闭）时立即 `clearInterval(__ccsdSbiTimer)` + **`__ccsdSbi.dispose()` 并置为 null**——整行消失，不会冻结在陈旧计数上（典型场景：CC 崩溃、被强杀）。新 panel 打开时 SBI + timer 重建，首 tick 自然推真实计数。
- **click command 单例**：`globalThis.__ccsdSbiCmdRegistered` 守卫——首个 CC panel 的 IIFE 调 `vs.commands.registerCommand("ccStatusDot.sbiClick", handler)` 一次。`registerCommand` 无需 package.json contribution（palette/menu/keybinding 才需要）；同 host 重复注册同 ID 会抛错，故必须 guard。handler 读 `__ccsdSbi.tooltip`（单 SBI 的 tooltip，每 500ms 刷新）作 `InformationMessage` 弹出——点击 SBI 即见当前 4 灯计数。SBI 的 `.command` 字段设为该 ID，VSCode 点击时自动 execute。
- **命名空间**：`__ccsd*` 项目级前缀（沿用 v0.1.11 决策）——避免占用 CC 自己的 `__cc*` 全局命名空间（见 patch.ts `restoreWebview()` 内 `cc-status-bar-injected` 墓碑注释的警示）。

### 7.4 与 per-tab 四态点的关系（共存，不替代）

| 维度                                                   | per-tab 四态色点（§1 / §4）                                                                                                                                                                                                                                                                                                                                                                                                           | 底部 SBI 4 灯（本节）                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 位置                                                   | 每个 CC tab 图标 + Open Editors 视图                                                                                                                                                                                                                                                                                                                                                                                                  | 状态栏左侧（near-center），全局唯一                                                                                                                                                                                                                                                   |
| 灯数                                                   | 4（idle/running/done/interrupted，permission 走 CC 原生蓝）                                                                                                                                                                                                                                                                                                                                                                           | 4（🟢done 🟡running 🔵pending 🔴interrupted），固定显示                                                                                                                                                                                                                               |
| 粒度                                                   | 单 session                                                                                                                                                                                                                                                                                                                                                                                                                            | 全部 session 汇总计数（0-3+N 封顶）                                                                                                                                                                                                                                                   |
| 渲染                                                   | `panelTab.iconPath`（SVG）                                                                                                                                                                                                                                                                                                                                                                                                            | 单 SBI `text`（4 段 `<球><数字>` 拼接，直接 mutate `.text`——无 `.color`/`.backgroundColor`）                                                                                                                                                                                          |
| 中断闪烁                                               | 红色快闪（`flashSeq%2`）                                                                                                                                                                                                                                                                                                                                                                                                              | 仅静态彩球+数字（不闪）                                                                                                                                                                                                                                                               |
| 颜色保真                                               | SVG 嵌入 hex，跨平台稳定                                                                                                                                                                                                                                                                                                                                                                                                              | emoji 球自带色，依赖 OS emoji 字体栈（v0.1.17 沿用 v0.1.16 的 emoji 路径）                                                                                                                                                                                                            |
| permission 处理                                        | `__ccsdPending` yield→CC 原生蓝点（per-panel-live）                                                                                                                                                                                                                                                                                                                                                                                   | 🔵 pending 灯（**v0.2.5：OR 两源**——`<sid>.json.pending` 异步写盘跨窗口覆盖 + `globalThis.__ccsdPendingSet` 由 Anchor B 从 `rename_tab.hasPendingPermissions` 同步刷新本窗口覆盖；底部聚合 `files[i].slice(0,-5)` 去掉 `.json` 后缀作 set key；decay `st!=="idle"` 在 OR 之后仍生效） |
| 陈旧 running 治理（>30min since，v0.2.6；v0.5.2 统一） | **应用 SBI_RUNNING_STALE_MS（30min since）decay + `__ccsdTranscriptFresh` 活动门**——tab 与底部 🟡 现在**共用同一阈值 + 同一活动谓词**（v0.5.2 #4：原 per-tab 15min `SINCE_STALE_MS` 已退役，15-30min 窗口的 tab-灰/底部-黄不一致窗口消除）。活动门：若 transcript（`.jsonl`）在阈值内有写入（仍在流式输出）则不降级——根治"长活动 workflow 因 `since` 冻结被误判 idle"（stuck-drift 只刷状态文件 mtime 不刷 transcript，仍正常 decay） | **应用 §7.2 启发式（30min since）+ 同款 `__ccsdTranscriptFresh` 活动门**——与 per-tab 完全一致（v0.5.2 统一；两者计数不再因阈值分歧差 1）                                                                                                                                              |
| 陈旧 interrupted 治理（>7d since，v0.2.7）             | **不应用**——tab 保持 🔴 红快闪提醒"此会话被中断过"                                                                                                                                                                                                                                                                                                                                                                                    | **应用 §7.2 规则 3**——不计 🔴，避免累积的 abandoned 中断会话让 🔴 单调增长（两者计数因此可能差 N）                                                                                                                                                                                    |
| done>5min 归 idle                                      | 应用（§4）                                                                                                                                                                                                                                                                                                                                                                                                                            | 应用（§7.2，不计 🟢）                                                                                                                                                                                                                                                                 |
| 刷新来源                                               | 每 panel 一个 per-tab `setInterval`（500ms）                                                                                                                                                                                                                                                                                                                                                                                          | 窗口级单例 `setInterval`（500ms）                                                                                                                                                                                                                                                     |
| 失败隔离                                               | per-tab setInterval 的 `p.iconPath=` 单行 try/catch；onDidDispose 注册也在 try/catch 内                                                                                                                                                                                                                                                                                                                                               | SBI 创建 + SBI timer 创建 + aggregation body + onDidDispose 各自独立 try/catch（§7.5）                                                                                                                                                                                                |
| reload 韧性                                            | 高（per-tab 渲染不依赖 window-scoped state）                                                                                                                                                                                                                                                                                                                                                                                          | **高（v0.1.14 改进，v0.1.17 沿用）**——SBI 直接 mutate text，无 setContext key 在 reload 后丢失的问题                                                                                                                                                                                  |

**互补**：tab 点告诉你"是哪个会话在跑/停了"；SBI 4 灯告诉你"全局总共有几个在跑/停/等输入/中断了"，不用数 tab。

### 7.5 异常安全 + 已知限制（v0.1.11；v0.1.12 加固；v0.1.13 沿用；v0.1.14 重组；v0.1.15 4-SBI 适配；v0.1.16 emoji-ball 切换；v0.1.17 单 SBI 紧凑拼接）

**异常安全（v0.1.17 当前层次）**：v0.1.12 给 SBI 创建 + SBI 单例 timer 创建各加一层独立 try/catch（v0.1.13 重组为 Cc 单例 timer，v0.1.14 重组回 SBI 创建 + SBI 单例 timer，v0.1.15 把单 SBI 创建改为 4-SBI 创建循环，v0.1.16 在此基础上移除了 `.color`/`.backgroundColor` 的赋值，v0.1.17 把 4-SBI 循环合并回单 SBI 创建——同时去掉了 v0.1.15 round-4 的 length-guarded 重建 + commit-atomic 提交 + partial-failure cleanup 三层保护，因为单 SBI 创建只有一次 `createStatusBarItem` 调用，不存在部分失败的中间状态——timer 创建 + aggregation body + onDidDispose 注册的 try/catch 模式完整沿用）。当前结构（自内向外）：

1. **单 SBI 创建 try/catch**（v0.1.12 沿用，v0.1.15 适配为循环，v0.1.16 简化为只设 text/tooltip/command/show，v0.1.17 合并回单 SBI 单次 create）：吞单次 `createStatusBarItem` / `.command=` / `.show()` 的抛出（disposed host、API 暂态失败），让 IIFE 继续走到 per-tab tick + onDidDispose 注册。
2. **SBI 单例 timer 创建 try/catch**（v0.1.12 沿用）：吞掉 `setInterval` 注册的抛出，让 IIFE 继续走到 per-tab tick + onDidDispose 注册。
3. **Aggregation body try/catch**（v0.1.11）：包住 readdirSync/statSync/JSON.parse/单 SBI text mutate 等所有 filesystem + JSON + SBI-mutate 操作。
4. **SBI click command 注册 try/catch**（v0.1.13 新增，v0.1.14/v0.1.15/v0.1.16/v0.1.17 沿用）：包住单次 `vs.commands.registerCommand` 调用——注册抛错（重复、API 暂态）只跳过，不传播到 SBI 创建或 SBI timer 创建。
5. **per-tab setInterval** + **onDidDispose 注册** 各自的 try/catch（v0.1.9 起）。

这 5 层互相独立：聚合链路上的任何失败都不会拖垮 per-tab 主链路，反之亦然；SBI 创建 / timer 创建失败也不会传播到 CC 的 `update_session_state` handler（v0.5.47 起：我们的语句以普通 statement 形式插在 CC 2.1.238 块状 consequent 的块首——任何一行抛错同样会沿语句执行向上传播进 CC 的请求分发，砖化会话状态追踪 + 跳过 per-tab setInterval + 跳过 onDidDispose 注册导致 panel 计数永久泄漏；pre-2.1.238 时期该传播经逗号操作符链，机制已随锚点改形退役）。

**已知限制（诚实声明）**：

- **v0.1.17 沿用 v0.1.16 的 emoji 字体栈依赖**：v0.1.15 改用 4 个内置 `statusBarItem.*Background` ThemeColor + 白字数字，**完全跟随 VSCode 主题色**，跨平台稳定；v0.1.16 因用户反馈"色块效果不如圆点好看"切回 emoji 球，v0.1.17 在此基础上合并到单 SBI 但保留 emoji 球——Win7/无 emoji 字体的 Linux/headless 环境可能黑白或豆腐块。macOS（Apple Color Emoji）/ Windows 10+（Segoe UI Emoji）/ 主流 Linux（Noto Color Emoji）正常显示彩色。形状是 emoji 字形自带的正圆。
- **`⚪`（U+26AA）跨 Unicode 块的潜在宽度差（v0.1.17 ⚪→🟤 pivot、v0.1.19 revert 回 ⚪）**：`🟢🟡` 属 Geometric Shapes Extended（U+1F780-U+1F7FF），`🔵🔴` 属 Miscellaneous Symbols And Pictographs（U+1F300-U+1F5FF）。v0.1.17 **初版**用 `⚪`（Miscellaneous Symbols U+2600-U+26FF）作为 dim 球——**5 个球分属 3 个不同 Unicode 块**。**实测现代 emoji 字体**（Apple Color Emoji / Noto Color Emoji / Segoe UI Emoji）把所有 emoji 渲染成 1em 正方形 glyph，跨块宽度一致——这是 v0.1.17 初版选择保留 `⚪` 的依据。**理论风险**：某些冷门或老式字体可能让 `⚪` 与彩球宽度略差，导致整行因计数变化（某灯 0↔非0）而左右位移 1-2 像素。**显式需求"数字不位移"由 VSCode CSS `tabular-nums` 独立保证**，与此风险正交；emoji 位移仅是隐式观感问题。
  - **v0.1.17 pivot 到 🟤**（U+1F7E4，与 `🟢🟡` 同属 Geometric Shapes Extended，**理论上**等宽）——5 球缩减到 2 块（Geometric Shapes Extended: 🟢🟡🟤；Miscellaneous Symbols And Pictographs: 🔵🔴），跨块宽度差风险从源头消除。
  - **v0.1.19 revert 回 ⚪**（commit 55e18b4）：用户偏好灰球而非棕球。**这意味着 §7.1 的"块级等宽保证"不再成立**——5 球回到 3 块分布，宽度一致性**完全依赖字体厂商把不同块的 emoji 渲染成 1em 正方形**（实测在 Apple Color Emoji / Noto Color Emoji / Segoe UI Emoji 三家主流字体上均成立；冷门/老式字体理论上仍有位移风险）。**显式需求"数字不位移"由 tabular-nums 兜底，与此风险无关**——emoji 1-2px 位移仅是隐式观感问题，不影响数字部分的等宽。下次 install 时 patcher 会通过 content-hash 检测 IIFE body 漂移并自动 re-inject。
  - 维护契约：`SBI_DIM_EM` 改动时需同步 patch.ts JSDoc（SBI_LIGHTS_CFG + SBI_DIM_EM）+ buildIIFE 注释 + test-iife.mjs 镜像常量 + 本节 §7.1/§7.5。
- **SBI 位置受状态栏拥挤度影响（v0.1.17 改善：碰撞窗口从 4 单位缩到 1 单位）**：单 SBI priority `-9996`（v0.1.17 从 v0.1.16 的 `-9996..-9999` 4 单位区间缩到 1 单位点）让 SBI 在 Left 项里最靠右、最接近可见中心，但 VSCode StatusBarItem API 无真正的"居中"槽位——若用户装了大量其它 Left 项 SBI，或其它扩展声明了恰好 `-9996` 的 priority（无所有权/命名空间机制），SBI 可能被高优 Left 项**挤到角落**。**v0.1.17 的单 SBI 架构消除了 v0.1.16 的"行被外部分隔"失败模式**（v0.1.16 的 4 个独立 SBI 可能被其它扩展的 SBI 插入 done 与 interrupted 之间劈开成两半；v0.1.17 整行是一个 SBI，外部插入只能插到整行两侧，不会把 4 灯拆开）。VSCode StatusBarItem.priority 无所有权/命名空间，碰撞完全静默，`--status` 也不检测——若见到被高优项挤到角落的情况，请在 issue 里上报。这是 API 限制，无法绕开。
- **click command 需 IIFE 注册**：reload 后若用户未打开 CC panel，`ccStatusDot.sbiClick` 未注册，此时点 SBI 不响应（VSCode 静默 no-op）。但 SBI 本身也未创建（IIFE 仅由 panel 打开触发），所以一致性 OK。
- **30-min 陈旧 running 启发式对单工具 >30min 假阳性（v0.1.14 R3 文档加固；v0.2.6 decay key 由 mtime 改为 since）**：`PreToolUse`/`PostToolUse` 只在工具调用前后各触发一次——单个工具执行期间 writer 没有 heartbeat，状态文件 `since`（v0.2.6 前：mtime）停在 PreToolUse 时刻。任何执行超过 30 分钟的单一工具（长 Bash 命令、慢 MCP 工具、长视频渲染、大测试套件、用户故意写的 `sleep 1800`）期间，聚合层会把该会话从 🟡 running 误判为 idle 并降级，黄色灯熄灭，即便 CC 仍在真实工作。**v0.2.6 之前 per-tab 仍保持 🟡 黄作为兜底**（§7.4 表"陈旧 running 治理"行的有意分歧）；**v0.2.6 起 per-tab 也应用同款 decay（15min SINCE_STALE_MS）**——故此假阳性现在同时影响聚合与 per-tab：长工具执行 >15min 会让 tab 也转 ⚪ idle 灰。缓解措施：(a) 15min/30min 阈值覆盖了绝大多数真实工具调用；(b) 下一次 PreToolUse/PostToolUse（多步工具链的下一步）会刷新 `since`（不是 mtime——PreToolUse 也走 *→running 转移路径写 since=now）并让聚合 + per-tab 都重新计入；(c) 阈值若上调（如聚合 60min、per-tab 30min）可在 `SBI_RUNNING_STALE_MS` / `SINCE_STALE_MS` 各一处改 + 同步本文档 §7.2 / §7.4 即可。未来若引入工具执行中 heartbeat 可根治。**为何 mtime→since**：mtime 被 cc-status.js:390-401 Stop preserveSince 路径污染（inflight>0 时 cur.since 保留、mtime 每次 Stop heartbeat 都刷新），CC 对漂移 inflight workflow 重复 fire Stop → mtime 永远新、mtime-decay 永不触发（用户实测 stuck-yellow 2h 的根因）；`since` 在同路径下被保留不刷新，decay 正常工作。这是 v0.1.10 引入该启发式时遗漏的 mtime-decay 缺陷，v0.2.6 修正。**v0.5.2 (#4) 根治流式假阳性**：降级前新增 `__ccsdTranscriptFresh(j,sid,staleMs)` 活动门——若该会话 transcript（`.jsonl`）在 `SBI_RUNNING_STALE_MS` 内有写入（仍在流式输出 assistant token），则**不降级**。长 turn / 等 subagent 会冻结 `since` 但 jsonl 持续增长，故流式场景的假阳性被消除。残余缺口：单个工具执行 >30min 且**无任何流式输出**（长静默 Bash / `sleep 1800`）期间 jsonl 不增长 → 活动门无效 → 仍假阳性；缓解同上文 (b)，且下一个 PreToolUse/PostToolUse 刷新 `since` 后恢复。stuck-drift 案例的伪 Stop heartbeat 只刷状态文件 mtime 不刷 transcript，活动门不误判 → since-decay 仍正常触发。**v0.5.2 同时统一阈值**：per-tab 与聚合共用 `SBI_RUNNING_STALE_MS`（30min），原 per-tab 15min `SINCE_STALE_MS` 退役 → 15-30min 窗口的"tab 已灰、底部仍黄"不一致消除（两者 now 共用同一阈值 + 同一活动谓词，永不在该窗口分歧）。
- **崩溃/被杀 CC 会话的残留状态文件治理（v0.1.13 review 加固，v0.1.14 沿用；v0.2.6 decay key 改 since）**：`SessionEnd` 删除文件是 writer 契约（§2），但 CC 崩溃 / 被强杀 / hook pipe 断裂不发 `SessionEnd` 的 session，其 `<sid>.json` 会残留。v0.1.13 review 前只治理 🟡 running（§7.2 的 30-min mtime 启发式）和 🟢 done（§4 的 5-min 规则），🔵 pending 与 🔴 interrupted 都有缺口；review 后补齐为完整四态 GC（聚合层；v0.2.6 起 per-tab 也应用 running decay，见下文每条注解）：
  - 🟡 running：30-min since 启发式（§7.2 规则 2；v0.2.6：原 mtime-key 改为 since-key——Stop preserveSince 路径刷 mtime 不刷 since，导致 stuck-yellow bug）→ idle，不计黄。**v0.5.2 (#4) 起 per-tab 与聚合统一**——共用 `SBI_RUNNING_STALE_MS`（30min）+ `__ccsdTranscriptFresh` 活动门（原 per-tab 15min `SINCE_STALE_MS` 退役，见 §7.4 表"陈旧 running 治理"行）；阈值分歧消除，活动门根治长活动 workflow 的假阳性。
  - 🟢 done：5-min since 规则（§4 / §7.2 规则 1）→ idle，不计绿。**聚合 + per-tab 都应用**（一致）。
  - 🔵 pending（**v0.1.13 review 新增**）：`j.pending===true && st!=="idle"` → 复用上面 running/done decay 已算出的 `st`。一个在权限弹窗期间被强杀的会话（state=running、pending=true、since>30min）在 🟡 不计（规则 2 降级 idle）的同时，🔵 也不计（`st==="idle"` 跳过 pending）。死会话的 pending 标志对用户零价值（用户根本不知道它存在），无"需保持可见"的辩护理由——故与 🟡/🟢 同款治理。
  - 🔴 interrupted（**v0.1.13 review 新增；v0.2.4 round-2 decay key 改 since；v0.2.7 阈值由 24h 延至 7d**）：`since` > `INTERRUPTED_RETENTION_MS`（**v0.2.7：7 天**）→ idle，不计红。文件**不删**（保留诊断价值，用户可手动检查 `~/.claude/cc-tab-status/<sid>.json` 或清理）。**v0.2.7 阈值变更动机**：用户报告"interrupted 红色自己消了"，三个嫌疑之一是 24h decay 对跨天 workflow 过短；7d 保持"本周红灯 sticky"语义同时有界回收（研究警告完全取消 decay 会让 abandoned 崩溃会话无界增长）。与 `GC_DRIFT_SINCE_MS`（7d）取齐为同一"陈旧终态会话"视界。阈值比 SBI_RUNNING_STALE_MS(30min) 大得多，因为 interrupted 是终态、用户可能想事后检查，而 running 是 live heartbeat、staleness 信号明确。decay key 用 since（非 mtime）因 orphan SubagentStop/Notification 写刷新 mtime 但保留 since，mtime-decay 在 orphan 写下永不触发。**仅聚合**——per-tab 保持 🔴 红快闪提醒（见 §7.4 表"陈旧 interrupted 治理"行的有意分歧）。
  - **per-tab vs 聚合的有意分歧 v0.5.2 起仅剩一项**（🔴 interrupted；见 §7.4 表对应行）：tab 保持红提醒、聚合不计——用户看到该状态的 tab 可手动检查并关闭。聚合层 GC 的正当性恰建立在 per-tab **有**独立呈现这一事实上：用户可以肉眼看到哪个 tab 是红并自行处理，聚合灯只需反映"还有多少 live session 处于该态"，故把崩溃/陈旧的会话从聚合计数剔除不引入可见不一致。🟡 running 的阈值分歧 v0.5.2 (#4) 已消除（per-tab 与聚合统一 30min + 同款 `__ccsdTranscriptFresh` 活动门）；🔵 pending 是第三种态但**无此分歧**——pending 的 decay 复用 running/done 的 `st`（`j.pending===true && st!=="idle"`），与 per-tab 的 `__ccsdPending` yield→CC 原生蓝点同步降级。
  - 如需手动清理可删 `~/.claude/cc-tab-status/<sid>.json`，或下次 `Stop`/`SessionEnd` 触发 writer 重写/删除该文件。
- **聚合 vs per-tab 的 permission 一致性（v0.1.13 改进，v0.1.14 沿用）**：v0.1.10-v0.1.12 时聚合对 permission-pending 期间计为 🟡 running（无窗口级通道读 pending），per-tab 显示 CC 原生蓝点——同一会话两处 UI 不同色，是有意分歧。**v0.1.13 通过 writer 新增 `Notification` 写 `pending:true` 解决**（v0.1.14 沿用）：聚合现在独立计 🔵 pending 灯，与 per-tab CC 原生蓝点**语义一致**（都表示"该会话在等用户输入"），只是颜色载体不同（emoji vs CC 原生 SVG）。
- **聚合刷新定时器的"第一 panel 闭包"绑定**：单例定时器由第一个 CC panel 的 IIFE 创建，闭包捕获该 panel 的 `DIR`/`fs`/`vs` 等局部（这些值在所有 panel 间是确定的、无 panel-specific 状态，故无泄漏问题）。最后 panel 关闭时 `clearInterval` 释放定时器 + `dispose()` 释放 SBI；新 panel 打开时由其 IIFE 重建，首 tick 即推真实计数。
- **SBI 点击反馈轻量**：点 SBI 只弹一句 `InformationMessage`（当前 tooltip = 4 灯计数明细），不打开 modal、不切 tab、不跳 CC——和"统计指示器"的角色一致。如需操作，用户回到对应 CC tab 处理。

---

## 8. Token 统计 SBI（v0.2.4 右下角 token/cost 显示）

> v0.2.4 在 §7 的 4 灯聚合 SBI（左下角）之外，新增了第二个 SBI 显示当前激活 CC panel 的 token 用量与 USD 估算，位于右下角 `StatusBarAlignment.Right` 优先级 `-9995`。两者完全独立（独立 SBI 实例、独立 text/tooltip、独立 click 命令），共享同一个 500ms tick（`__ccsdSbiTimer`）不新增 setInterval。

### 8.1 数据源与状态文件 schema 扩展

**唯一 token 权威源**：`~/.claude/projects/<escaped-cwd>/<sid>.jsonl`，每条 assistant 行的 `message.usage` 100% 携带 `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`（标量，GLM 等第三方模型）+ 可选 `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`（对象，Anthropic 原生）。top-level `usage` 在 15082 文件采样中 0 次出现 → **必须读 `message.usage`**。

**派生缓存**（`~/.claude/cc-tab-status/<sid>.offset`，writer 维护）：

```jsonc
{
  "offset": 12345678,        // 字节偏移
  "lastTs": 1721410203000,   // 最后处理的 timestamp（毫秒，去重 key）
  "lastSize": 12345678,      // 上次 stat.size（bug #9188 检测）
  "totals": { "in":.., "out":.., "cr":.., "cc5":.., "cc1":.., "cci":.. },  // 全量累计
  "buckets": [ { "ts":.., "in":.., "out":.., "cr":.., "cc5":.., "cc1":.., "cci":.., "model":".." }, ... ],  // 时间序列（≤1000，超则 5min 折叠）
  "perTurn": [ { "ts":.., "model":.., "in":.., "out":.., "cr":.., "cc5":.., "cc1":.., "cci":.., "src":"main|sub:<8hex>" }, ... ]  // ≤400（FIFO）
}
```

**主状态文件 `<sid>.json` 扩展（向后兼容，老 reader 忽略新字段）**：

```jsonc
{
  // 现有字段（不变）
  "state": "running", "since": .., "error": null,
  "activeSubagents": 0, "pending": null,
  // v0.2.4 新增
  "cwd": "/path/to/project",  // payload.cwd 透传
  "tokens": {
    "total": { "in":.., "out":.., "cr":.., "cc5":.., "cc1":.., "cci":.. },
    "windows": {
      "5min": {..}, "10min": {..}, "1h": {..}, "24h": {..}, "3d": {..},
      "7d": {..}, "30d": {..}, "all": {..}
    },
    "cost": null,             // USD 或 null（未知 model 隐藏 $）
    "cost_5min": .., "cost_10min": .., "cost_1h": .., "cost_24h": .., "cost_3d": .., "cost_7d": .., "cost_30d": .., "cost_all": ..,
    "last_ts": ..,            // 最近一条 assistant 行的 timestamp
    "last_model": "glm-5.2",  // 最近一条 assistant 行的 model
    "turn_count": ..          // perTurn 长度（≤400）
  }
}
```

### 8.2 Writer 触发与增量读

writer (`hooks/cc-status.js`) 在以下 5 个事件触发 token 增量读：

| 事件               | 来源标签     | 用途                                                                                                          |
| ------------------ | ------------ | ------------------------------------------------------------------------------------------------------------- |
| `PostToolUse`      | `main`       | 主 heartbeat——每个工具调用后 CC 落盘 assistant 行                                                             |
| `PreToolUse`       | `main`       | 副 heartbeat——工具调用前补充捕获                                                                              |
| `Stop`             | `main`       | 终态校准（注意 R2：可能漏最后一行，UserPromptSubmit 兜底）                                                    |
| `UserPromptSubmit` | `main`       | R2 兜底——捕获上一轮 Stop 漏掉的尾巴 + 新轮预热                                                                |
| `SubagentStop`     | `sub:<8hex>` | 用 `payload.agent_transcript_path` 读子代理 transcript，归并到父 sid 的 buckets（用户为 subagent token 付费） |

`Notification` / `SessionStart` / `SessionEnd` / `SubagentStart` / `StopFailure` 不触发增量读（无新 assistant flush）；非 token 事件保留 `cur.tokens` 字段（"carry-forward"）让 IIFE 显示不闪烁。

**首火预热**：若 offset=0 且 stat.size > 256KB，只读尾部 256KB（避免 33MB 大文件首次 fire 阻塞）。代价：历史 totals 不全；优点：用户 < 100ms 见到反馈。后续增量读逐步补齐。

**Bug #41310**（早火 transcript 不存在）→ `fs.statSync` 失败 → return null 静默跳过。
**Bug #9188**（`claude --continue` 陈旧 sid+path）→ 若 `mtimeMs < lastTs - 60s` 且 size 无增长 → 跳过本轮不归零。
**Size shrank**（CC compacted）→ 重置 offset=0 全量重读。
**cache_creation 双形式兼容**：`u.cache_creation?.ephemeral_5m_input_tokens || 0` + `u.cache_creation?.ephemeral_1h_input_tokens || 0` + `u.cache_creation_input_tokens || 0`。
**sidechain 跳过**：父 transcript 中的 sidechain 行（实测 15082 文件 0 次出现，但代码防御性跳过）；子代理 token 通过 `SubagentStop + agent_transcript_path` 单独归并。
**synthetic 过滤**：`<synthetic>` model 行（CC 内部合成）不计费。

### 8.3 Cost 估算（`token-rates.json` 热更）

`~/.claude/cc-status-dot/token-rates.json`：

```jsonc
{
  "_default": null, // 未知 model → cost=null → SBI 隐藏 $
  "claude-sonnet-*": { "in": 3, "out": 15, "cacheRead": 0.3, "cacheCreate5m": 3.75, "cacheCreate1h": 6 },
  "claude-opus-*": { "in": 5, "out": 25, "cacheRead": 0.5, "cacheCreate5m": 6.25, "cacheCreate1h": 10 },
  "claude-haiku-*": { "in": 1, "out": 5, "cacheRead": 0.1, "cacheCreate5m": 1.25, "cacheCreate1h": 2 },
  // cacheRead/cacheCreate5m/cacheCreate1h 可省——writer 按 Anthropic 官方比例自动派生（0.1x / 1.25x / 2x input）
}
```

**用户机器（glm-5.2）**：无匹配条目 → `_default: null` → `cost=null` → SBI 显示 `$(clock) X tok`（无 $）。用户可在 settings.json 加 `"ccStatusDot.pricing": { "glm-*": { "in": 0.5, "out": 1.5 } }` 或直接编辑 `token-rates.json`（热更，无需重 patch；writer 按 mtime 缓存重读）。

writer 按 mtime cache `loadRates()`，每 fire 重读一次（mtime 不变则用缓存）。

### 8.4 SBI 渲染

**位置**：`StatusBarAlignment.Right`，优先级 `-9995`（右下角最靠右，紧邻可见中心）。与 §7 的 4 灯 SBI（Left -9996）分占状态栏两侧——"左 = 会话，右 = 成本"。

**文本格式**（依赖 `ccStatusDot.tokenDisplayMode`，默认 `both`）：

- `token`：`$(clock) 12.3k tok`
- `cost`：`$(pulse) $0.42`（cost=null 时回退 `$(clock) —`）
- `both`：`$(clock) 12.3k tok · $0.42`（cost=null 时省略 $ 段）

**无激活 panel**：`$(clock) —` + tooltip "no active CC panel"。

**Tooltip**（多行）：Window / Session total / Session cost / 24h / 7-day / 30-day / Last model / Project / Turn running (when state=running) / `(click to configure)`。

**QuickPick 配置面板**（点击 SBI 触发，跟随 VSCode 界面语言 zh/en/ja/de/es/fr/pt/ru，未知语言 fallback en）：

- Statistics window 选择（5min/10min/1h/24h/3d/7d/30d/all）
- Display 模式（token/cost/both）
- Token SBI visible 开关
- Notify on completion / Notify when focused 开关
- Sound 选择（15 种 macOS 系统音）
- 当次会话统计（Session total / 24h / 7-day / 30-day / Turn running）
- 快速命令（Copy token count / Reset session stats / Open state dir / Open Settings）

> i18n 机制：IIFE 顶部检测 `vs.env.language`，取 BCP-47 主子标签（zh-cn→zh、pt-br→pt、en-us→en），通过 `t(key)` helper 查 `I18N` 字典（8 语言齐全，断言于 test-iife.mjs IIFE.68-78）；未知语言走 `e[LANG]||e.en||k` fallback 链。配置值（5min/all/token/cost/both/声音名）与 SBI text 符号（`$(clock)`/emoji/tok/$）跨语言统一不译。

### 8.5 限额告警

`ccStatusDot.warnThresholdUsd`（默认 0=禁用）→ 当 session cost 估算跨过阈值时触发一次通知（`notify("warn", "CC cost alert: ~$X.XX")`）。每跨一次只通知一次（`globalThis.__ccsdLastWarnTs` 去重），cost 跌破后再次跨越会重新触发。

### 8.6 Active sid 跟踪

IIFE 维护 `globalThis.__ccsdActiveSid`（窗口级"当前激活 CC panel 的 sid"）：

1. ANCHOR_A `update_session_state` handler 每次 fire 都更新（CC 切 panel 会触发）。
2. 每 panel 的 per-panel tick 在 `panelTab.active===true`（或 active 字段 undefined 时无条件）时更新。

token SBI tick（共享 `__ccsdSbiTimer`）每 500ms 读 `globalThis.__ccsdActiveSid` 对应的 `<sid>.json`。

### 8.7 持久化与 GC

- **v0.2.7（Q1 修复）**：`<sid>.offset`（累积读游标 totals/buckets/perTurn/subOffsets）+ 新增 `<sid>.tokens.json`（IIFE 展示快照）**都不再被 `SessionEnd` 删除**。pre-v0.2.7 SessionEnd 同时 unlink 两者，导致 VSCode 重启后：
  - `<sid>.offset` 丢失 → 下次 `readTranscriptIncremental` 从 offset=0 开始 → 首火只读尾部 256KB（`TOK_TAIL_PRESET_BYTES`）→ "all" 窗口的累积 totals 永久欠计（非尾部行不被 backfill）
  - `<sid>.tokens.json` 不存在 / 旧版 `<sid>.json` 无 tokens → IIFE 首个 tick 显示 `$(clock) 0 tok`，直到下一次 `TOK_EVENT` 触发（"0-window"）
  - v0.2.7 改动：`<sid>.json`（瞬态 state 载体）仍被 SessionEnd 删除（正确）；`<sid>.offset` + `<sid>.tokens.json` 留在盘上，下次 resume 的首个 tick 即生效。
- **`<sid>.tokens.json` 写入时机**：每次 `TOK_EVENT` 写完 `<sid>.json` 后，hook 把 `status.tokens` 快照到 `<sid>.tokens.json`（envelope: `{v:1, sid, since, cwd, transcript_path, tokens, written_at}`）。`status.tokens` undefined 时跳过（`StopFailure` 等无 tokens 字段的事件不写快照）。两次写都是 `writeJsonAtomic`（tmp + rename），各自原子。
- **`<sid>.tokens.json` schema（v1）**：
  ```jsonc
  {
    "v": 1,                    // schema 锚点（未来迁移用）
    "sid": "<session-id>",
    "since": <ms>,             // 来自 status.since（IIFE 回退展示用）
    "cwd": "/abs/project/path",
    "transcript_path": "/path/<sid>.jsonl",  // 跨重启定位 jsonl
    "tokens": {                // === deriveTokensField 原样输出
      "total": {"in","out","cr","cc5","cc1","cci"},
      "windows": {"5min","10min","1h","24h","3d","7d","30d","all" 各为同 shape},
      "cost": <usd|null>, "cost_5min".."cost_all": <usd|null>,
      "cost_partial": <bool|null>, "last_model": <string|null>
    },
    "written_at": <ms>
  }
  ```
- **IIFE 读侧三级回退**：`readTok()`（QuickPick 用）+ §G tick（token SBI 用）都先尝试 `<sid>.tokens.json`，失败回退 `<sid>.json`，再失败返回 null。`<sid>.json` 仍是 state（running/done/interrupted/pending）的权威源；tokens 走 `.tokens.json || .json` 解耦——`.json` 被 SessionEnd 删了不影响 tokens 展示。
- **GC 契约**（UserPromptSubmit 扫描，10min throttle）：
  - `<sid>.json`：state=interrupted 永远不删（§7.5；**v0.2.2 例外**：headless 残留在文件 mtime>7d 后由回溯收割删除，见 §7.6——新鲜残留最多等一个 7d 周期+10min 节流）；否则 mtime > `INTERRUPTED_RETENTION_MS`（v0.2.7=7d）或 since > `GC_DRIFT_SINCE_MS`（7d）则 unlink。
  - `<sid>.offset` + `<sid>.tokens.json` + `<sid>.forcereread`：**纯 mtime 规则**——mtime > 7d 则 unlink（**v0.2.7 改动**：`.offset` 的旧"按 .json 是否存在判孤儿"规则废除，否则 SessionEnd 删 `.json` 后会立即被旧规则 reap 等于没修）。
  - **isTokens 判断顺序陷阱**：`.tokens.json` 也 `endsWith('.json')`，必须先于 isJson 判断（否则被 isJson 分支当无 state 文件误 reap）。
- **手动操作**：
  - 用户删 `<sid>.offset` → 下次 hook fire 全量重读 jsonl（首火延迟 ~100ms 可接受）。
  - 用户删 `<sid>.json` → IIFE 读 `<sid>.tokens.json` 回退，仍显示历史 token；state 走 undefined（不渲染状态点直到下次 hook fire）。
  - 用户删 `<sid>.tokens.json` → IIFE 回退 `<sid>.json`（活跃会话无影响；post-SessionEnd 短窗 0 显示直到下次 TOK_EVENT）。

### 8.8 与 §7 4 灯 SBI 的共存（零冲突核对）

| 维度       | §7 4 灯 SBI                                   | §8 token SBI                                |
| ---------- | --------------------------------------------- | ------------------------------------------- |
| 位置       | Left -9996                                    | Right -9995                                 |
| SBI 实例   | `globalThis.__ccsdSbi`                        | `globalThis.__ccsdTokSbi`                   |
| Click 命令 | `ccStatusDot.sbiClick`                        | `ccStatusDot.tokClick`                      |
| Tick       | 共享 `__ccsdSbiTimer`（500ms）                | 同上（不新增 setInterval）                  |
| Tooltip    | 4 灯计数明细                                  | token + cost + 历史 $                       |
| Dispose    | last-panel-out dispose                        | last-panel-out dispose（同一 onDidDispose） |
| 失败隔离   | 独立 try/catch（创建/tick/teardown 各自包裹） | 独立 try/catch（同款分层）                  |

两者完全独立，token SBI 失败不会影响 4 灯 SBI；反之亦然。

---

## 9. 性能影响（v0.2.9 证据驱动审查）

> **结论先行**：插件本身**不会造成可感知的 UI 卡顿**。EH（extension host）占用最坏 1.1% mean / 3.4% p99 CPU（重度 streaming 时），typical <0.3% CPU；writer hook 在 CC 子进程里跑 ~1-2ms/event，不触 EH/renderer。下面所有数字均实测于 2026-07-21 用户开发机（Darwin 21.6.0, Node v24.12.0），真实 fixture（42MB jsonl + 185KB sidecar + 2.1GB outlier）。本节是**给用户的诚实承诺**：怀疑插件卡 VSCode 时，先看这里。

### 9.1 架构事实（决定性）

IIFE 跑在 VSCode 的 **extension host（EH，独立 Node 进程）**，**不是 renderer**。用户在 CC webview 里打字、切 tab、复制都是 **renderer-local** 操作，**不等 EH**。插件能造成 UI 卡顿的唯一路径是：(a) EH CPU 被 peg 死 → EH→renderer IPC 响应（language-server / 其他扩展）排队；(b) IPC 洪流让 renderer 重绘 churn。实测都不触发。

### 9.2 实测热点（block 2，EH sync I/O）

`computeLiveDelta` 的 per-line JSON.parse 循环。**成本随 delta 大小（自上次 hook fire 以来的字节数）线性增长，与 jsonl 文件大小无关**——读被 512KB 上限 + offset-based 随机读封顶 = O(1) in file size（实测验证：2.1GB jsonl 的 open+read 512KB tail = 296µs，42MB jsonl = 277µs，几乎相同）。delta 在 PostToolUse 之间典型 2-32KB（assistant 行均值 4.3KB → 8KB delta ≈ 2 行）；512KB cap（≈120 行）只在异常大 tool 输出时触发。

**次要热点**：`.offset` sidecar 的 JSON.parse 随会话长度增长（527 buckets → 185KB sidecar → 1.04ms parse）。该文件在 active streaming（state==='running'）期间每 token SBI tick 读一次；idle/done/interrupted 在到达它之前早退出。

### 9.3 v0.2.9 三项 hygiene 优化（基于测量，非凭感觉）

审查挖出 3 个**真实可测**的浪费点，每项单独小但合起来~10 IPC/sec + 1.1ms/tick 的可避免 EH 开销。**Q5 改代码**是因为有数字支撑，不是凭直觉。

| Fix                                                           | 测得浪费（v0.2.8 baseline）                                                                                                                                                                         | 修法（v0.2.9）                                                                                                                                                                                                                             | 预期收益（实测/模拟）                                                      | 风险                                                                                                                                 |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Fix 1 Uri 缓存**（p.iconPath）                              | EH 端 iconPath setter `this.#iconPath !== value` 是**引用相等**；`vs.Uri.file()` 每次返新 Uri → dedup 永不触发 → **每 500ms × N panels 发 N 条 redundant $setIconPath IPC**（4 panels = 8 IPC/sec） | 加 `__ccsdUriCache` + `ccuri(p)` helper；同路径 reuse 同 Uri 对象 → EH setter dedup 触发 → IPC skip。状态切换 + interrupted flash（交替 error.svg ↔ CC_DEFAULT）仍产生不同引用 → IPC 照发。CC 覆盖 iconPath 时下一 tick 500ms 内 re-assert | Mock bench（240 ticks × 4 panels）：8 IPC/sec → ~0 IPC/sec（**99.6% 降**） | LOW                                                                                                                                  |
| **Fix 2 token SBI text dedup**（tsbi.text）                   | `tsbi.text=tlabel` 每 tick 无条件赋值（与 tooltip 的 `__ccsdTokSbiLastTip` dedup 模式**不对称**）→ **稳态 ~2 IPC/sec 冗余**（idle/tokens 稳定时）                                                   | 镜像 tooltip dedup：`if(globalThis.__ccsdTokSbiLastText!==tlabel){...; tsbi.text=tlabel;}`。4 个分支（normal tlabel + 3 错误/空 literal）统一套用                                                                                          | 稳态 2 IPC/sec → 0 IPC/sec                                                 | LOW                                                                                                                                  |
| **Fix 3 .offset sidecar mtime+size 缓存**（computeLiveDelta） | 186KB 长会话 sidecar JSON.parse 每 tick **1.04ms = per-tick EH sync I/O 的 58%**（仅 streaming 时）                                                                                                 | 镜像 §F 既有的 `__ccsdAgCache` 模式：`__ccsdOffCache` keyed on offPath，stat-first → cache hit reuse parsed sc；miss → re-read+parse+cache。Writer 原子 tmp+rename，所以 (mtimeMs,size) 是可靠内容变更信号                                 | 长会话 streaming 时 per-tick EH I/O 1.9ms → ~0.8ms（**~2.4× 降**）         | MED（cache invalidation 依赖 mtime+size，与既有 __ccsdAgCache 同假设；stale 至多读多余 jsonl 字节，被 512KB cap 封顶，无正确性影响） |

### 9.4 显式**不**改的点（审查主动拒绝）

下列"看似优化"的修改**复杂度风险 >> 测得收益**，v0.2.9 明确不动：

- **不改 computeLiveDelta 为 async**（fs.promises.open + read）。4-15ms sync 块有界且仅在重度 streaming 时触发；改 async 会级联重构 setInterval body + 错误处理 + per-panel tick 对称性。
- **不删/不 dedup `p.iconPath=ccuri(svg)` 每 tick 赋值**。这是**故意**防 CC 原生橙图标漏出的防御（`else{return}` 当 st=null 时**不**赋 iconPath，让原生橙显；每 tick 重申 ccuri(ourSvg) 确保 CC 覆盖后 500ms 内 re-assert）。Fix 1 的 Uri 缓存已让稳态 IPC → ~0，无需进一步降频。
- **不降 per-panel tick 频率**（TICK_MS=500）。降频会延迟用户可见的 running→done→idle 转换 + 破坏 notify-dedup 时序窗口。当前 0.06-3.4% CPU 范围不值。
- **不动 SBI aggregate tick**——`__ccsdAgCache` mtime+size dedup 已最优（v0.2.8 round-2 修了 .tokens.json 漏 parse）。
- **不重构 `<sid>.offset` sidecar 结构**（如拆 `{offset,lastTs}` 游标 + 历史 buckets 两文件）。这是 EH parse + hook write 双开销的根因，但属 writer 侧 contract 变更（跨文件 + 测试契约同步），应单独提案。

### 9.5 数字快照（v0.2.8 baseline → v0.2.9 after-fix 估）

| 场景（4 panels，1 active running）  | v0.2.8 EH 占用 / 500ms tick                 | v0.2.9（估算）                          |
| ----------------------------------- | ------------------------------------------- | --------------------------------------- |
| idle / done / interrupted（早退）   | ~0.3ms = 0.06% CPU                          | ~0.3ms = 0.06% CPU（不变）              |
| typical streaming（8KB delta）      | 1.40ms = 0.28% CPU                          | ~0.7ms = 0.14% CPU                      |
| worst-case streaming（512KB delta） | 5.52ms = 1.10% mean / 3.45% p99             | ~4.4ms = 0.88% mean                     |
| 长会话（185KB sidecar）streaming    | +1.04ms/tick = ~2.5ms total                 | +0.01ms/tick（cache hit）= ~1.5ms total |
| **renderer IPC churn（稳态）**      | **~10 IPC/sec**（8 iconPath + 2 token-SBI） | **~0 IPC/sec**（全部 dedup）            |

EH ≠ renderer：typing/copy/tab-switch 是 renderer-local，不等 EH。即便是 worst-case 17ms p99 EH 阻塞，也只延迟其他扩展的 EH→renderer IPC 17ms，对用户不可见。

---

## 10. Favorites 持久化契约（v0.4.0+，`favorites.json`）

> 本节是 **v0.4.0+ Favorites 功能**的持久化契约。`favorites.json` 是 §3a STATE_DIR (`~/.claude/cc-tab-status/`) 下新增的 **非会话状态文件**——它不是 `<sid>.json` 系列，不参与 §7.5 异常保留 / GC prune，但因为落在同一目录，必须显式登记为 GC-skip 项。设计细节见 `docs/FAVORITES-DESIGN.md`；本节只列**契约**。

### 10.1 路径与命名

| 维度        | 值                                                                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 路径        | `~/.claude/cc-tab-status/favorites.json`（= §3a STATE_DIR）                                                                                                |
| Sole writer | companion 扩展（`companion/extension.ts:writeFavAtomic`）                                                                                                  |
| Reader      | companion（`readFavDoc`）；IIFE **不读**（v0.4 Q3 方案 c，复合星标推迟 v0.5）                                                                              |
| GC skip     | `hooks/cc-status.js` GC 循环 `if (name === 'favorites.json') continue;`（§7.5 GC 必须 skip，否则 7d 后被误删——见 `hooks/test-cc-status.js §GC.favorites`） |

跨文件路径契约：STATE_DIR 同时在 `patch.ts:219`、`hooks/cc-status.js:1166`、`companion/extension.ts:FAV_STATE_DIR`、`patch.ts buildIIFE` 烘焙的 IIFE `var DIR=...;` 4 处独立存在；`hooks/test-contract-sync.mjs §STATE_DIR` (v0.4.0 round-2 HIGH) 提取四份表达式的路径尾巴做字节相等断言，锁定重命名场景。

### 10.2 Schema（v1）

```jsonc
{
  "version": 1, // FAV_SCHEMA_VERSION — bump on incompatible change
  "updatedAt": 1719000000000, // epoch ms of last write (for mtime diagnostics)
  "sessions": [
    {
      "sid": "uuid-string", // CC session id (primary key, dedup)
      "label": "basename or sid8", // cwd basename (v0.4); transcript first-prompt is v0.5
      "cwd": "/abs/path", // optional, snapshotted from <sid>.json at add-time
      "transcript_path": "...", // optional
      "model": "glm-5.2", // optional
      "state": "done", // optional, snapshotted at add-time (frozen)
      "addedAt": 1719000000000,
      "lastSeenAt": 1719000000000, // updated by favOpen primary path on successful reveal
    },
  ],
  "files": [
    {
      "fsPath": "/abs/path/to/file", // primary key, dedup
      "label": "basename.ts",
      "line": 50, // optional, add-time cursor snapshot
      "workspace": "/abs/path", // optional
      "addedAt": 1719000000000,
    },
  ],
}
```

字段语义 + 验证详见 `companion/extension.ts:isValidFavSession` / `isValidFavFile`（round-1 LOW：可选字段需类型检查，防止 hand-edit 的 `"state": 42` 崩渲染器）。

### 10.3 原子写

`writeFavAtomic(doc)`：`fs.writeFileSync(tmp, body)` → `fs.renameSync(tmp, FAV_FILE)`，POSIX rename 原子。镜像 `patch.ts:1662 writeAtomicSync` / `hooks/cc-status.js:writeJsonAtomic`。失败回滚：unlink tmp 后 throw（v0.4.0 round-2 MED：包 try/catch 后返 boolean，调用者根据 false 回滚 in-memory + refresh）。

### 10.4 Schema-version 前向守卫（v0.4.0 round-2 MED hardening）

`readFavDoc` 检测到 `obj.version > FAV_SCHEMA_VERSION` → latch `futureVersionLocked = true`（模块级，EH 生命期内不再复位）+ 返回 `emptyFavDoc()` + warning。

`writeFavAtomic` 开头检查 latch：true 则拒写 + 显示 "upgrade or delete the file at <path>" 错误提示。这兑现 round-0 警告文案 "Showing an empty list to avoid clobbering newer data" 的承诺——v0.4.0 round-1 前的 toggle/remove/open 调用会以 v1 schema 覆盖磁盘上的 v2 文件，造成版本降级场景下的真实数据丢失。

`hooks/test-favorites.mjs FAV.17` 验证 READ 返回 empty；round-2 未补 "subsequent WRITE 是否保留 future data" 的行为测试（latch 是 module-level singleton，replica 测试框架难以注入），由 source-shape 检查 + 该文档 §10.4 共同覆盖。

### 10.5 IIFE 桥（不改 STATE_DIR 文件）

IIFE 仅 publish `globalThis.__ccsdSidToPanel[sid] = panel`（§A preamble）+ register `ccStatusDot.fav.focusSession` 命令（§D.5，handler fail-safe：sid miss 返 false 不抛）。companion 经共享 globalThis（同 EH）调 `.reveal()` 焦点已开会话；EH 隔离时走 `executeCommand` 兜底。**IIFE 不读不写 `favorites.json`**。

跨文件命令 id 契约：`patch.ts FAV_FOCUS_CMD const` === `companion/extension.ts executeCommand("ccStatusDot.fav.focusSession")` === IIFE `JSON.stringify(FAV_FOCUS_CMD)` 烘焙字节三处一致——`hooks/test-contract-sync.mjs` 末尾 3 项断言锁定。

## 7.6 v0.2.2 headless-session exclusion (red-lamp noise fix)

SDK-spawned sessions (`entrypoint: sdk-cli|sdk-ts` in the transcript tail — cron jobs, external programs like the OpenClaw repair agent) are **other programs' sessions**: the hook classifies them once at the session's first decisive event (UserPromptSubmit / StopFailure), drops a `<sid>.headless` marker, and exits before ANY state write — they never paint the four lamps in any state, never leave state files, and their markers reap on the GC 7d mtime rule. Pre-existing headless `interrupted` residue is retroactively reaped by the GC sweep. INTERACTIVE sessions (claude-vscode / cli, or any transcript that cannot be proven headless) keep the §7.5 sticky-7d contract byte-identical — classification keys on headless-ness only, NEVER on error strings. Root cause of the Aug-22 incident: the local LLM gateway outage made each hourly OpenClaw repair session fail with `API Error (ConnectionRefused)` → StopFailure(error=unknown) → sticky red, +1/hour — the first hook-covered failure run in the plugin's lifetime.
