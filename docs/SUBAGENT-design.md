# Subagent / Workflow 期间保持 running 的设计

> 目标：**workflow（后台多 subagent）跑期间，主会话 tab 图标保持 `running`（黄）**，修复当前盲区——主 agent 回复"已启动"后 `Stop`→`done`（绿），但后台 workflow 仍在跑。
>
> 本文件是**查证 + 设计稿**，落地时仍以 [`STATES.md`](STATES.md) 为单一真相源；落地后须把决策结论回写 `STATES.md`。
>
> **维护状态（v0.1.14 R3 文档对账）**：本文件描述的是 v0.1.10 时期的 hybrid 设计提案。已落地为 v0.1.14 当前实现，**权威实现描述以 `STATES.md` §2 为准**（HOOK_EVENTS 自 v0.1.13 起扩到 9 个——本文件 §5.1 的 "6 → 8" 标题、`扩到 7`/`由 6 改 7` 等描述已过时）。下方 §5.1 的代码片段保留作历史参考，请勿据其判断当前 HOOK_EVENTS 数量或成员。

---

## 0. TL;DR（先读这段）

- 查证发现一个**比"SubagentStart/SubagentStop 计数"更优的官方机制**：`Stop` 与 `SubagentStop` 的 stdin payload 自 CC **v2.1.145+** 起携带 `background_tasks[]` / `session_crons[]`，权威列出当前在飞的所有后台任务（含 `type:"workflow"` / `"subagent"` / `"teammate"` 等）。本项目目标版本 **2.1.204 ≫ 2.1.145**，字段可用。
- 因此**推荐方案 B（background_tasks）为主**：`Stop` 时看 `background_tasks.length>0` → 写 `running`，否则 `done`。零计数、零漂移、零竞态、覆盖所有后台类型（不止 Agent-tool subagent）。
- 用户原方案 A（SubagentStart/SubagentStop + `activeSubagents` 计数）**仍可作补充**：用于"subagent 一启动就立刻变黄"（早于第一次 `Stop`），以及在没有 `background_tasks` 的旧版本兜底。但单独用 A 有计数漂移 + 并发竞态风险。
- **最佳落地 = B 为主 + A 早信号**（hybrid）。下方给两套完整代码草案，任选其一或合并。

**把握度速览**：

| 结论 | 把握度 |
|---|---|
| SubagentStart/SubagentStop 的 `session_id` = 主会话 | 高（官方 JSON 示例明示） |
| payload 字段（`agent_id`/`agent_type`/`stop_hook_active`/`last_assistant_message`/`agent_transcript_path`） | 高（官方 §SubagentStart/Stop input） |
| `Stop`/`SubagentStop` 携带 `background_tasks[]`（v2.1.145+） | 高（官方 §Stop input + 示例） |
| `background_tasks[].type` 含 `workflow`/`subagent`/`teammate` | 高（官方字段表） |
| workflow 后台 subagent 是否触发主会话的 SubagentStart/Stop | **中低**（文档未显式确认；SubagentStart 明示"via the Agent tool"，workflow 是独立 type） |
| "workflow 完成后会话被唤醒→再发 Stop（此时 background_tasks 空）" | 中（文档措辞"waiting for background work to wake it back up"暗示，但未给精确序列） |
| hooks 并发："All matching hooks run in parallel" | 高（官方原句） |

---

## 1. 查证结论（官方 https://code.claude.com/docs/en/hooks）

### 1.1 SubagentStart payload

官方 §SubagentStart input：

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-….jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "SubagentStart",
  "agent_id": "agent-abc123",
  "agent_type": "Explore"
}
```

- **`session_id` = 主（父）会话**（不是 subagent 自己的 id）。→ 我们以 `session_id` 为 key 的 writer 会正确归档到主会话状态文件。✅
- `agent_id`：subagent 唯一标识（matcher 过滤用 `agent_type`，不是 `agent_id`）。
- `agent_type`：`general-purpose` / `Explore` / `Plan` / 自定义 agent 名 / plugin-scoped `plugin:agent`。
- 触发时机：**subagent 被 spawn 时**（文档原文 "Runs when a Claude Code subagent is spawned via the Agent tool"）。**不能阻止创建**（no block），只能注入 `additionalContext`。
- matcher 字段是 `agent_type`（见官方 matcher 表："SubagentStart | agent type | general-purpose, Explore, Plan, …"）。

### 1.2 SubagentStop payload

官方 §SubagentStop input：

```json
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../abc123.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "SubagentStop",
  "stop_hook_active": false,
  "agent_id": "def456",
  "agent_type": "Explore",
  "agent_transcript_path": "~/.claude/projects/.../abc123/subagents/agent-def456.jsonl",
  "last_assistant_message": "Analysis complete. Found 3 potential issues...",
  "background_tasks": [],
  "session_crons": []
}
```

- 同样 `session_id` = 主会话。`agent_transcript_path` 才是 subagent 自己的 transcript（嵌套 `subagents/`）。
- `stop_hook_active`：同 Stop，防死循环标志。
- `last_assistant_message`：subagent 最后一条回复文本（无需解析 transcript）。
- **`background_tasks[]` + `session_crons[]`**：v2.1.145+，**作用域是父会话**（官方原句 "scoped to the parent session, not the subagent"）。→ SubagentStop 也能看到父会话当前在飞的全部后台任务。✅
- decision：与 Stop 同格式，可 `decision:"block"` 让 subagent 继续跑。

### 1.3 关键：`background_tasks[]`（方案 B 的基础）

官方 §Stop input：`Stop` 与 `SubagentStop` 都收 `background_tasks[]` + `session_crons[]`，原文——

> let hooks distinguish "session is done" from "session is paused waiting for background work to wake it back up". Both arrays are present when the task registry is reachable and are empty when nothing is in flight or scheduled.

每个 `background_tasks` 条目字段：

| 字段 | 说明 |
|---|---|
| `id` | 任务 id |
| `type` | **友好类型标签**：`shell` / `subagent` / `monitor` / **`workflow`** / **`teammate`** / `cloud session` / `MCP task` |
| `status` | 当前状态 |
| `description` | ≤1000 字描述 |
| `command` | 仅 `shell` 类型 |
| `agent_type` | 仅 `subagent` 类型 |
| `server`/`tool` | 仅 `monitor`/`MCP task` |
| `name` | 仅 **`workflow`** 类型（workflow 名） |

**这意味着**：`Stop` 触发时，payload 自带"还有没有后台任务在跑"的权威答案。`workflow` 是独立 `type`，与 `subagent`（Agent-tool）并列——**统计 SubagentStart/Stop 未必覆盖 workflow type**（见 §4 风险 R3）。`background_tasks` 覆盖全部。

### 1.4 SubagentStart/Stop 是否在"内置 Task tool / workflow"时都触发？

- 官方：SubagentStart "spawned via the **Agent tool**"。Agent/Task tool 创建的 subagent → 触发 SubagentStart/Stop（`type:"subagent"`）。✅ 高把握。
- **workflow（background subagent）**：`background_tasks` 里是独立 `type:"workflow"`，文档**没有明示** workflow 启动/结束会触发主会话的 SubagentStart/Stop。→ **中低把握**。这正是方案 A 的最大盲区，也是推荐方案 B 的核心理由。

### 1.5 主会话 hook 序列（workflow 场景推断）

基于官方生命周期图 + §Stop 措辞，推断（标注把握）：

```
UserPromptSubmit                 → running                         [高]
(主 agent 调 Workflow 工具)
  ├─ 若 workflow 走 Agent tool → SubagentStart×N                 [中：仅当走 subagent type]
  └─ 若 workflow 是独立 type   → 可能不发 SubagentStart           [中低]
PreToolUse/PostToolUse (Workflow 工具本身) → running              [高]
(主 agent 回复"已启动")
Stop                              → payload.background_tasks=[…workflow…]  [高：字段存在]
                                    此时 background_tasks 非空 → 应写 running（而非 done）
(workflow 后台跑… 可能跨较长时间)
  └─ 各 subagent 结束 → SubagentStop?                              [中低：不确定 workflow type 是否触发]
(workflow 完成 → task-notification → 唤醒会话)
会话恢复 → 新一轮 agent 活动 → 再次 Stop                           [中：文档"wake it back up"暗示]
                                    此时 background_tasks=[] → 写 done
```

**关键不确定点**（影响方案 A 是否够用）：
1. workflow 跑期间主会话是否真的只发一次 Stop（带非空 background_tasks）？—— 推断是（高）。
2. workflow 完成后是否再发 Stop？—— 中把握。
3. workflow 子任务是否触发主会话 SubagentStart/Stop？—— 中低把握。

→ **方案 B（看 background_tasks）把这些不确定全部绕开**：不管序列怎样，只要 Stop/SubagentStop 一触发，直接读权威数组。

---

## 2. 方案对比

| 维度 | A：SubagentStart/Stop 计数 | B：读 background_tasks（推荐） | A+B 混合（最佳） |
|---|---|---|---|
| 新增 hook 事件 | SubagentStart, SubagentStop（8 个事件） | 无（仍 6 个） | SubagentStart（早信号），SubagentStop 可选 |
| 新增状态字段 | `activeSubagents:int` | 无 | `activeSubagents`（仅早信号/兜底） |
| writer 写法 | read-modify-write（有竞态） | 直接覆盖写（现状） | hybrid |
| 覆盖 workflow type | ⚠️ 不确定（R3） | ✅ 覆盖全部 type | ✅ |
| 计数漂移 | ⚠️ 有（R1/R2） | 无 | 有但被 B 周期性纠正 |
| 并发竞态 | ⚠️ 有（hooks 并行，R2） | 无 | 仅 A 部分有 |
| 早信号（subagent 一启动就黄） | ✅ | ❌（要等第一次 Stop） | ✅ |
| 旧版本（<v2.1.145）兜底 | ✅ | ❌（字段缺失→视作空→done） | ✅ |
| 实现复杂度 | 中 | 极低 | 中 |

**推荐：B 为主，A 作早信号补充（hybrid）。** 若只求最小改动，**只做 B**（改 `Stop` 一个 case，约 3 行）即可消除"假绿"主诉。

---

## 3. 方案 B（推荐核心）：background_tasks

### 3.1 字段

状态文件**不变**（仍是 `{state,since,error?}`）。`background_tasks` 是 hook payload 字段，不落盘。

### 3.2 deriveStatus 只改 Stop（+ SubagentStop 若接）

```js
case 'Stop': {
  const inflight = Array.isArray(payload.background_tasks) ? payload.background_tasks.length : null;
  // 有权威信号用权威；无（旧版本）则按"无后台任务"处理→done（与现状一致，不退化）
  const stillBusy = inflight != null ? inflight > 0 : false;
  return { state: stillBusy ? 'running' : 'done', since: now };
}
```

如同时接 SubagentStop：

```js
case 'SubagentStop': {
  // SubagentStop 也带 background_tasks（父会话作用域）。若仍有在飞任务→保持 running；
  // 否则不抢断（让 Stop/下一次事件决定终态），返回 null 表示"本事件不写"。
  const inflight = Array.isArray(payload.background_tasks) ? payload.background_tasks.length : null;
  if (inflight != null && inflight > 0) return { state: 'running', since: now };
  return null; // 不改写，避免把"刚 Stop 成 done"误改回 running
}
```

> 注意：SubagentStop 返回 `null`（不写）比强行写 `done` 安全——subagent 结束≠主轮次结束，终态交给 `Stop`。

### 3.3 为什么 B 够用（回应盲区）

主诉是"主 agent 回复'已启动'后 Stop 误写 done"。B 在**那个 Stop 时刻**就把 `background_tasks` 非空识别出来 → 写 `running`。盲区消除。"workflow 完成后何时变 done"靠会话被唤醒后的下一次 `Stop`（background_tasks 空）自然纠正；最坏情况延迟到下一次用户 prompt，**但绝不再假绿**（安全失败）。

---

## 4. 方案 A（用户原案）：activeSubagents 计数

> 作为 hybrid 的早信号组件，或旧版本兜底。**不建议单独使用**（见风险）。

### 4.1 状态文件字段（追加）

```jsonc
{
  "state": "running|done|interrupted",
  "since": 1719500000000,
  "error": "rate_limit",            // 可选
  "activeSubagents": 2              // 新增，int，默认 0
}
```

reader（IIFE）**不读 `activeSubagents`**——state 仍四态，reader 渲染逻辑零改动（§6 确认）。该字段仅供 writer 记账。

### 4.2 状态机（read-modify-write）

| 事件 | 操作 | 说明 |
|---|---|---|
| `UserPromptSubmit` | `state=running`；`activeSubagents` = `background_tasks?.length ?? cur` | **不重置为 0**（见建议 §4.4） |
| `PreToolUse`/`PostToolUse` | `state=running`；刷新 since；`activeSubagents` 同上（若 payload 带 background_tasks 则纠正） | 心跳 |
| `SubagentStart` | `activeSubagents=cur+1`；`state=running` | 早信号 |
| `SubagentStop` | `activeSubagents=max(cur-1,0)`；`state = (cur-1>0) ? running : 保留旧state` | 不抢断 |
| `Stop` | `activeSubagents = background_tasks?.length ?? cur.activeSubagents`；`state = activeSubagents>0 ? running : done` | **B 优先纠正** |
| `StopFailure` | `state=interrupted`（不管 subagent）；保留 activeSubagents | 中断优先 |
| `SessionEnd` | 删除文件 | 清理 |

### 4.3 并发竞态与原子性（R2 应对）

官方："All matching hooks run in parallel"（同一 event 多 hook 并行；dedup by command string）。我们每个 event 只注册 1 个 hook → 同 event 内无自竞态。但**不同 event 的 hook 进程可能并发**（如同时两个 subagent：一个 Start 一个 Stop，两个独立 node 进程读写同一 `<sid>.json`）。read-modify-write 会丢更新。

应对（按强度）：

1. **首选：用 background_tasks 纠正（hybrid）**——每次 Stop/SubagentStop/UserPromptSubmit 拿 payload 的权威 length 覆盖计数，漂移最多存活到下一个带 background_tasks 的事件，且 activeSubagents 下限 clamp 0。无需锁。
2. **次选：lockfile 自旋**。写前 `fs.openSync(lock, 'wx')`（独占创建），失败则短退避重试（≤50ms×5），写完解锁。增加复杂度 + 拖慢 hook（有 30~600s 超时但加锁仍非必要）。
3. **兜底：接受偶发 ±1 漂移**——reader 不读此字段，state 终态由 Stop（B）裁定，漂移只影响"早信号"窗口，无功能性后果。

→ 推荐组合：**hybrid（B 纠正）+ clamp 0 + 接受漂移**，不引入 lockfile（保持零依赖、静默、快）。

### 4.4 UserPromptSubmit 是否重置 activeSubagents？

**建议：不重置，而是用 `background_tasks?.length` 纠正；缺字段则保留旧值。**
- 重置为 0 的风险：若上一轮 workflow 未完成、用户又发新 prompt，会丢"仍有后台任务"的事实 → 下次 Stop 又假绿。
- 保留的风险：计数漂移累积；但被 background_tasks 周期纠正 + clamp 0 兜底。
- 结论：`activeSubagents = (payload.background_tasks?.length ?? cur.activeSubagents)`。

### 4.5 deriveStatus 改动草案（cc-status.js，hybrid 版，精确代码）

> `main()` 里需把当前文件内容读出传给 `deriveStatus`。`deriveStatus` 由纯函数升级为 `(payload, cur)`，`cur` 由 `main()` 读取现有文件构造（读失败/无文件 → `{state:'idle',activeSubagents:0,since:0}`）。

```js
// hooks/cc-status.js — deriveStatus（hybrid：B 为主 + A 早信号）
// cur: { state, since, error?, activeSubagents }  来自读当前文件（无则全默认 0/idle）
const DELETE = Symbol('delete');

function inflightFromPayload(payload) {
  // 权威在飞任务数（v2.1.145+）；旧版本/缺失 → null（表示"不知道"）
  return Array.isArray(payload && payload.background_tasks) ? payload.background_tasks.length : null;
}

function deriveStatus(payload, cur) {
  const event = payload.hook_event_name;
  const now = Date.now();
  const inflight = inflightFromPayload(payload);
  const a = Number.isFinite(cur && cur.activeSubagents) ? cur.activeSubagents : 0;

  switch (event) {
    case 'UserPromptSubmit':
      // 新一轮：running。计数用权威纠正，否则保留（不重置 0）。
      return { state: 'running', since: now, activeSubagents: inflight != null ? inflight : a };

    case 'PreToolUse':
    case 'PostToolUse':
      return { state: 'running', since: now, activeSubagents: inflight != null ? inflight : a };

    case 'SubagentStart':
      // 早信号：一 spawn 就黄。优先用权威纠正，否则 +1。
      return { state: 'running', since: now, activeSubagents: inflight != null ? inflight : (a + 1) };

    case 'SubagentStop': {
      // 一个 subagent 结束。优先权威纠正，否则 -1（clamp 0）。
      const next = inflight != null ? inflight : Math.max(a - 1, 0);
      if (next > 0) return { state: 'running', since: now, activeSubagents: next };
      // next==0：不抢断，让 Stop 裁定终态。返回 null=不写。
      return null;
    }

    case 'Stop':
      // 权威裁定：有后台任务→running，否则 done。旧版本无字段→退化为 done（与现状一致）。
      return { state: (inflight != null ? inflight : a) > 0 ? 'running' : 'done', since: now,
               activeSubagents: inflight != null ? inflight : a };

    case 'StopFailure':
      return { state: 'interrupted', since: now, error: payload.error || 'unknown', activeSubagents: a };

    case 'SessionEnd':
      return DELETE;

    default:
      return null;
  }
}
```

`main()` 配套改动（在现有 `const status = deriveStatus(payload);` 处）：

```js
// 读当前文件，构造 cur（无/破损 → 默认）
let cur = { state: 'idle', activeSubagents: 0, since: 0 };
try {
  const prev = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  cur = {
    state: prev.state || 'idle',
    since: prev.since || 0,
    error: prev.error,
    activeSubagents: Number.isFinite(prev.activeSubagents) ? prev.activeSubagents : 0,
  };
} catch { /* 无文件或破损 → 默认 cur */ }

const status = deriveStatus(payload, cur);   // 注意：filePath 须在读 cur 之前确定
if (status === null) process.exit(0);
```

> 原子写不变（`.tmp`+`rename`）。读-改-写在单进程内串行；跨进程并发靠"权威纠正 + clamp 0 + 接受漂移"（§4.3）。

---

## 5. patch.ts 改动

### 5.1 HOOK_EVENTS（hybrid 版：6 → 8）

```ts
const HOOK_EVENTS = [
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "SubagentStart",   // 新增：早信号（A）
    "SubagentStop",    // 新增：纠正/释放（A）；也带 background_tasks（B）
    "Stop",
    "StopFailure",
    "SessionEnd",
] as const;
```

> 若只做方案 B（最小改动）：**HOOK_EVENTS 不变**（仍 6 个），只改 `Stop` case 即可。SubagentStop 的 background_tasks 纠正需接 SubagentStop → 才需扩到 7。

### 5.2 其他

- `buildIIFE`：**不改**。reader 不读 `activeSubagents`，state 四态不变。
- `wireHooks`：自动按 `HOOK_EVENTS` 数量写 settings.json（现有逻辑已泛型），扩到 7 无需额外改。
- log 行 `wrote ${HOOK_EVENTS.length} hook event(s)` 自动反映 7。

---

## 6. STATES.md 改动点（落地后回写）

- **§2 事件→状态表**：若接 A，加 2 行
  - `SubagentStart → running`（注明：activeSubagents+1，早信号）
  - `SubagentStop → running（若仍有在飞）/ 不写（若归零）`（注明：优先 background_tasks 纠正）
  - `HOOK_EVENTS` 由 6 改 7（若只做 B 则不变）。
- **§3 IPC 契约**：字段表追加 `activeSubagents`（int，默认 0，reader 不读，仅供 writer 记账）+ 说明 `background_tasks` 是 hook payload（不落盘）。
- **§4 reader 渲染逻辑**：加一句"reader 不读 activeSubagents；state 仍四态，本节零改动"。
- **§5 已知限制**：新增特性条目——
  - "workflow / 后台 subagent 跑期间保持 running（靠 Stop/SubagentStop 的 `background_tasks` 权威判定，v2.1.145+；旧版本退化为现状）"。
  - 补充限制："workflow 完成后→done 的转换依赖会话被唤醒后的下一次 Stop；若会话不被唤醒，图标可能停在 running 直到下一次 prompt（安全失败，不再假绿）"。
- **§1 状态枚举**：不变。

---

## 7. 风险与边界

- **R1 计数漂移（仅 A）**：SubagentStart/Stop 不配对（subagent 崩溃/被杀未发 Stop）→ activeSubagents 虚高。缓解：每次带 background_tasks 的事件用权威值覆盖；clamp 0。**B 无此风险。**
- **R2 并发竞态（仅 A）**：多 subagent 并发 Start/Stop → 多 node 进程 read-modify-write 同一文件丢更新。缓解：hybrid 的权威纠正 + 接受 ±1 漂移（reader 不读此字段）。**B 无此风险（覆盖写）。**
- **R3 workflow type 不触发 SubagentStart/Stop（A 盲区）**：官方只说 SubagentStart "via the Agent tool"。`background_tasks.type:"workflow"` 是独立类型，**不确定**是否触发主会话 SubagentStart/Stop。→ **这是推荐 B 的决定性理由**：B 覆盖 workflow，A 可能漏。
- **R4 background_tasks 缺失（旧版本 <v2.1.145）**：`inflight=null`。Stop 退化为 `done`（=现状），不引入新 bug；A 的计数仍可作为兜底早信号。目标版本 2.1.204 不受影响。
- **R5 workflow 完成后 done 延迟**：若会话不被唤醒，图标停 running。安全失败（优于假绿）；可由 reader watchdog（未来 v2）或下一次 prompt 纠正。
- **R6 SubagentStop 的 decision:block 反作用**：SubagentStop hook 若返回 `decision:"block"` 会让 subagent 继续跑——但我们的 writer 只读 stdin、不输出 JSON、exit 0，**不触发任何 decision**。安全。
- **R7 多 session**：每会话独立 `<sid>.json`，互不干扰（与现状一致）。
- **R8 初始无文件**：`cur.activeSubagents` 视为 0（readCurrent 的 catch 分支）。

---

## 8. 落地建议（给实施者）

1. **第一步（最小、最高 ROI）**：只做方案 B——改 `cc-status.js` 的 `Stop` case 读 `background_tasks.length`（§3.2 上半段）。`HOOK_EVENTS` 不变。验证：启一个 workflow，主 agent 回复后图标应保持黄（而非变绿）。
2. **第二步（可选早信号）**：接 `SubagentStart`（→7 事件），subagent 一启动就黄，不必等第一次 Stop。
3. **第三步（可选精细）**：接 `SubagentStop` + `activeSubagents` 记账（hybrid 全量，§4.5），获得"最后一个 subagent 结束即考虑转 done"的更细粒度（仍由 Stop 终裁）。
4. 回写 `STATES.md`（§6）。

---

## 来源

- 官方 hooks 参考：https://code.claude.com/docs/en/hooks （§SubagentStart input / §SubagentStop input / §Stop input / §Common fields / "All matching hooks run in parallel"）
- payload 实例参考：https://github.com/disler/claude-code-hooks-mastery （13 事件 JSON 捕获）
