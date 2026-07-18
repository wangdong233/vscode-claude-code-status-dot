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
| `UserPromptSubmit` | `running` | 新一轮开始；`activeSubagents` 用 payload `background_tasks` 纠正，**否则重置 0**（防止上轮漂移 bleed 进新轮；`Stop` 才是工作是否剩余的权威——见 regression test 12 / bug e434c0a2） |
| `PreToolUse` | `running` | 心跳，刷新 `since`；`activeSubagents` 同 `UserPromptSubmit` 规则（payload 优先，否则 0） |
| `PostToolUse` | `running` | 心跳，刷新 `since`；同上 |
| `SubagentStart` | `running` | **早信号**：subagent 一 spawn 即黄；`activeSubagents` 优先用 `background_tasks` 纠正，否则 +1 |
| `SubagentStop` | `running`（若仍有在飞任务）/ **保持 cur.state（归零时不抢断，写回 activeSubagents:0）** | `activeSubagents` 优先用 `background_tasks` 纠正，否则 −1（clamp 0）；**始终写回**（落盘递减后的计数 + cur.state，cur.state 限定为 writer 实际会写的三态 running/done/interrupted，其它含默认 'idle' 一律降级 'running'，永不把 'idle' 落盘）。归零时不抢断终态、交 `Stop` 裁定；**且当 cur.state 已是 done/interrupted 且 next===0 时保留 cur.since 不刷新**（reader notify 去重以终态 since 为键，刷新会重复弹通知并重置 done→idle 5 分钟倒计时） |
| `Stop` | `done`，**除非** payload `background_tasks.length > 0` → `running`；payload 缺字段（inflight=null）也落 `done` 并清零计数 | 权威裁定：workflow 后台跑期间不假绿（v2.1.145+）；`Stop` **绝不读盘上 activeSubagents**（counter 可能漂移），只信 payload——缺 payload 也算"无在飞任务"，落 done + 清零 |
| `StopFailure` | `interrupted` | 记 `error` 枚举（`rate_limit`/`overloaded`/…）；缺 error 或非字符串一律写 `"interrupted"`（与 reader 兜底文案对齐）；中断优先，保留 `activeSubagents` |
| `SessionEnd` | （删除该 session 状态文件） | 清理 |

**故 `HOOK_EVENTS` = `["UserPromptSubmit","PreToolUse","PostToolUse","SubagentStart","SubagentStop","Stop","StopFailure","SessionEnd"]`**（8 个）。

**故意不接的事件**（及原因，防止死接线）：
- `Notification`：permission 由 CC 原生蓝点处理，reader 不覆盖该态。
- `SessionStart`：writer 无对应 case。

> **hook 命令格式（实测约定）**：patcher 写入 `~/.claude/settings.json` 的每个 hook 形如 `"<absoluteNodeBin> <INSTALL_DIR>/hooks/cc-status.js  # cc-status-dot-managed"`，全部 8 事件用 `matcher:""`。两点依赖 CC 当前实测行为：(1) CC 以 shell 解析 hook 行，故末尾 `# ...` shell 注释可用作幂等标记；(2) `matcher:""` 在 CC 的 regex 语义下表示"匹配一切事件实例"（含 SubagentStart 的 `agent_type` 维度）——空串目前等价 catch-all。若未来 CC 改用 `execFile` 直 spawn 或将空 matcher 改为"匹配空"语义，这条链会静默断（writer 不写文件、reader 永停末帧）。届时改为 `matcher:".*"` 或把标记挪进 hook 脚本自报即可。

---

## 3. 状态文件 IPC 契约（writer 与 reader 共享）

- 目录：`~/.claude/cc-tab-status/`
- 文件名：`<session_id>.json`
- 字段：`{ "state": "idle|running|done|interrupted", "since": <ms 纪元, 非负有限数>, "error"?: "<StopFailure 枚举字符串>", "activeSubagents": <int, >= 0> }`
  - `activeSubagents`（int，默认 0）：**仅供 writer 记账**（SubagentStart/Stop 计数 + `background_tasks` 纠正）。**reader 不读此字段**——state 仍四态，渲染逻辑零改动（§4）。
    - **字段名义 vs v2 语义**：名字是 v0.x 历史遗留（"活跃 subagent 数"），v2 起（§5）任何带 `background_tasks` 的事件会用 `background_tasks.length` **权威覆盖**它，语义已扩展到 workflow/subagent/teammate 全类型后台任务。reader 不读、改名是 IPC 破坏性变更无收益，故保留名字、扩语义；读字段时请以注释而非名字为准。
  - `background_tasks[]` / `session_crons[]`：**hook payload 字段（CC v2.1.145+），不落盘**——Stop/SubagentStop 时由 writer 就地读取作权威判定（覆盖 workflow/subagent/teammate 等全类型）。
- 写入：**原子**（`.tmp` + `rename`，tmp 名带 `pid+Date.now()` 后缀防同 session 并发 hook 共用 tmp 路径），目录自动创建；writer 为 **read-modify-write**（读当前 `activeSubagents` → 改 → 原子写回）
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

## 7. 状态栏聚合统计（v0.1.10，v0.1.11 重构；与 §6 的废弃条无关）

> **本节是 v0.1.10 新增的右下角聚合统计 item**，**不是** §6 那条 v0.1.3 已废弃的 webview 色块条。二者完全不同：
> - §6（废弃）：v0.1.2 在 CC 的 **webview `index.js`/`index.css`** 上独立打补丁的"色块条"，v0.1.3 已删除。
> - 本节（现行）：v0.1.10 在 **`extension.js` 的 IIFE 内**创建的 VSCode `StatusBarItem`，与 per-tab 四态色点**共存互补**。
>
> **v0.1.11 修订要点**（详见各小节）：
> - **§7.1/§7.2**：聚合同步应用 §4 的 `done` 超 5 分钟→idle 渲染规则，并新增"running 文件 mtime 超 30 分钟→idle"启发式（§7.5），使聚合计数与 per-tab 点显示**一致**。tooltip 在 `ag.idle>0` 时追加 ` / idle N`。
> - **§7.3**：item（`globalThis.__ccsdSbi`）与刷新定时器（`globalThis.__ccsdSbiTimer`）**同为窗口级单例**——v0.1.10 时刷新工作仍跑在每个 panel 的 per-tab tick 内（O(P×S) 读放大），v0.1.11 提升为单例定时器后 P 个 panel 每 500ms **只刷一次**（O(S)）。`__ccsdPanelCount` 计数器让"最后一个 panel 关闭"时立即 `clearInterval` + `sbi.hide()`，bar 不再冻结陈旧值。
> - **命名**：`__cc*` → 项目级 `__ccsd*` 前缀，避免占用 CC 自己的 `__cc*` 全局命名空间（见 patch.ts `restoreWebview()` 内 `cc-status-bar-injected` 墓碑注释的警示）。

### 7.1 位置与显示

- **位置**：VSCode 状态栏**右下角**（`StatusBarAlignment.Right`，priority `0`）。
- **格式**：`🟢{done} 🟡{running} 🔴{interrupted}`，段间空格分隔，**0 计数段省略**（如无中断不显红段）。
  - 🟢 绿 `#3FB950` = `done` 会话数；🟡 黄 `#CCA700` = `running`；🔴 红 `#F85149` = `interrupted`。
  - 当 `done`/`running`/`interrupted` 三态计数全为 0、但 `idle` 会话数 > 0 时，退化为 `⚪{idle}`（白圈 + idle 数）——一眼知"有会话但都在空闲"。
  - 当状态目录里**零个可成功解析的 `*.json`**（无文件、或全部 JSON 破损/读失败）时，item **`hide()`** 隐藏，避免在没开 CC 的窗口里留杂物。
- **tooltip**：`Claude Code sessions: done N / running N / interrupted N`，**`ag.idle > 0` 时末尾追加 ` / idle N`**（与可见文本 `⚪{idle}` 兜底对齐，让 hover 能解释白圈含义）。跨 panel 的 per-session title 在 reader 不可得，故不列每会话名。

> **颜色保真度非对称（已知差异）**：per-tab 四态点用 SVG 嵌入 hex 颜色（`#3FB950`/`#CCA700`/`#F85149`/`#808080`）保证跨平台保真；聚合 item 用 emoji 码点（U+1F7E2/1F7E1/1F534/26AA）委托颜色，**渲染依赖 OS 的 emoji 字体栈**——Win7/无 emoji 字体的 Linux/headless 环境可能渲染为黑白或豆腐块（U+26AA 白圈尤其不一致）。VSCode `StatusBarItem.text` 无 color-aware markdown，故此 asymmetry 是当前最佳折衷：颜色丢失时形状 + 数字仍承载信息。同作者在 per-tab 选 SVG 而非 emoji 正是此因。

### 7.2 数据源与刷新

- **v0.1.11 起复用一个窗口级单例定时器** `globalThis.__ccsdSbiTimer`（500ms，`TICK_MS`）刷新聚合 item——**不再**像 v0.1.10 那样在每个 per-panel tick 内重复刷新。第一个 CC panel 的 IIFE 创建定时器，后续 panel 复用同一个。P 个 panel 每 500ms **只**触发一次聚合读取（O(S) 文件读，S = 会话数），不再 v0.1.10 的 O(P×S)。
- 每 tick `fs.readdirSync(DIR)` 列 `~/.claude/cc-tab-status/*.json`，逐文件 `JSON.parse` 读 `state` + `since` 字段，**先应用与 per-tab 一致的渲染规则再分桶**：
  1. `state === "done"` 且 `now - since > DONE_TO_IDLE_MS`（5 分钟）→ 计入 `idle` 桶（与 §4 per-tab done→idle 一致，避免"tab 已褪灰、聚合仍计 🟢"的口径分歧）。
  2. `state === "running"` 且 `mtime > SBI_RUNNING_STALE_MS`（30 分钟，见 §7.5）→ 计入 `idle` 桶（崩溃/被杀未发 SessionEnd 的会话治理）。
  3. 其余按字面 `state` 分桶（`running`/`done`/`interrupted`/`idle`）。
- 失败文件 try/catch 跳过（与 reader 一贯风格，不崩扩展）。
- 状态字段契约同 §3（`state` ∈ `idle|running|done|interrupted`）。`permission` 不落盘，故不参与聚合；但 PreToolUse 心跳会在 permission 弹窗前把 `state=running` 落盘——此期间该会话会被聚合计为 🟡 running（per-tab 则通过 `__ccPending` yield 让 CC 原生蓝点显示）——这是聚合 vs per-tab 的**有意分歧**，因为 pending 信号无窗口级广播通道。

### 7.3 全局单例（关键设计）

- IIFE 在 **per-panel** 跑（每个 CC panel 一个 per-tab `setInterval`），但聚合 item 通过 **`globalThis.__ccsdSbi` 守卫**、聚合刷新定时器通过 **`globalThis.__ccsdSbiTimer` 守卫**双双确保**全窗口唯一**：第一个 panel 的 IIFE 各创建一次，后续 panel 的 IIFE 完全跳过创建分支。
- **v0.1.11 起 item 与 timer 作用域对齐**：均为窗口级单例。v0.1.10 时 item 是单例但刷新工作不是，每个 panel 每 tick 各自重算并写入同一个 item——值相同（读同一目录）无竞态问题，但读放大是 O(P×S)；v0.1.11 单例定时器后变成 O(S)。
- item 生命周期与窗口绑定（`globalThis` 上的引用），VSCode reload 后由首个 panel 的 IIFE 重建。**`onDidDispose` 不释放 item**——它不属于某个 panel。
- **v0.1.11 面板计数器 `__ccsdPanelCount`**：IIFE 入口 `+1`，`onDidDispose` 内 `-1`；当计数归零（窗口里**最后一个** CC panel 关闭）时立即 `clearInterval(__ccsdSbiTimer)` + `sbi.hide()`——bar 不再像 v0.1.10 那样因"无存活 panel 继续刷新"而**冻结在最后一次写入的陈旧值**（典型场景：CC 崩溃、被强杀、手动 Esc 不发 SessionEnd 的已知限制 §5）。新 panel 打开时首个 tick 自然 `show` 回来。

### 7.4 与 per-tab 四态点的关系（共存，不替代）

| 维度 | per-tab 四态色点（§1 / §4） | 右下角聚合 item（本节） |
|---|---|---|
| 位置 | 每个 CC tab 图标 + Open Editors 视图 | 状态栏右下角，全局唯一 |
| 粒度 | 单 session | 全部 session 汇总计数 |
| 渲染 | `panelTab.iconPath`（SVG） | `StatusBarItem.text`（emoji + 数字） |
| 中断闪烁 | 红色快闪（`flashSeq%2`） | 仅静态数字（不闪） |
| 颜色保真 | SVG 嵌入 hex，跨平台稳定 | emoji 字体依赖，可能黑白（§7.1 已知差异） |
| permission 处理 | `__ccPending` yield→CC 原生蓝点 | 计为 🟡 running（pending 无窗口级通道，§7.2 有意分歧） |
| 陈旧 running 治理（>30min mtime） | **不应用**——tab 保持 🟡 黄作为"此会话可能已死"的可见提醒，用户可自行关闭 | **应用 §7.2 启发式**——计入 idle 桶，避免单个崩溃会话永久占 🟡1（per-tab 仍保持黄，所以两者计数会差 1） |
| done>5min 归 idle | 应用（§4） | 应用（§7.2，与 per-tab 一致） |
| 刷新来源 | 每 panel 一个 per-tab `setInterval`（500ms） | 窗口级单例 `setInterval`（500ms，v0.1.11） |
| 失败隔离 | per-tab setInterval 的 `p.iconPath=` 单行 try/catch；onDidDispose 注册也在 try/catch 内 | SBI 创建 + SBI timer 创建各自独立 try/catch（v0.1.12）；aggregation body 另有独立 try/catch（v0.1.11） |

**互补**：tab 点告诉你"是哪个会话在跑/停了"；聚合 item 告诉你"全局总共有几个在跑/停了"，不用数 tab。

### 7.5 异常安全 + 已知限制（v0.1.11；v0.1.12 加固）

**异常安全（v0.1.12 加固后层次）**：v0.1.11 的 aggregation-body try/catch 之外，v0.1.12 给 SBI 创建 + SBI 单例 timer 创建各加了一层独立 try/catch（与 per-tab tick 自 v0.1.9 起就有的失败隔离对齐）。当前结构（自内向外）：
1. **SBI 创建 try/catch**（v0.1.12 新增）：吞掉 `vs.window.createStatusBarItem` 的抛出（disposed extension host、API 暂态失败等），让 IIFE 继续走到 per-tab tick。
2. **SBI 单例 timer 创建 try/catch**（v0.1.12 新增）：同样吞掉 `setInterval` 的抛出。
3. **Aggregation body try/catch**（v0.1.11）：包住 readdirSync/statSync/JSON.parse 等所有 filesystem + JSON 操作。
4. **per-tab setInterval** + **onDidDispose 注册** 各自的 try/catch（v0.1.9 起）。

这 4 层互相独立：聚合链路上的任何失败都不会拖垮 per-tab 主链路，反之亦然；SBI 创建失败也不会传播到 CC 的 `update_session_state` handler（否则会经逗号操作符链向上抛出，砖化会话状态追踪 + 跳过 per-tab setInterval + 跳过 onDidDispose 注册导致 panel 计数永久泄漏）。

**已知限制（诚实声明）**：

- **emoji 颜色保真度依赖 OS 字体栈**：见 §7.1 末段。Win7/无 emoji 字体的 Linux/headless 环境可能黑白或豆腐块；U+26AA 白圈尤其不一致。颜色丢失时形状 + 数字仍承载信息。
- **崩溃/被杀 CC 会话的 `interrupted` 文件无 GC**：`SessionEnd` 删除文件是 writer 契约（§2），但 CC 崩溃 / 被强杀 / hook pipe 断裂不发 `SessionEnd` 的 session，其 `<sid>.json` 会**永久残留**并被聚合**永久计入**对应桶。§7.2 的 30-min `mtime` 启发式**仅治理 `running` 桶**（崩溃的 running 会话会被降级为 idle，不再假 🟡）；**`done` 桶**靠 §4 的 5 分钟规则自动归 idle；**`interrupted` 桶**暂无 GC（中断态在 UI 上需要保持可见以提醒用户，加 mtime 截止会丢信息）。**该 30-min 启发式仅作用于聚合 item（SBI），不作用于 per-tab 渲染**——见 §7.4 表里"陈旧 running 治理"行的有意分歧：per-tab 保持 🟡 黄以提醒用户"此会话可能已死"（用户看到可手动关 tab），SBI 折扣为 idle 以避免崩溃会话永久占 🟡1。两者计数因此可能差 1（一个黄 tab + SBI 显示 🟡0），是设计折衷而非 bug。如需清理可手动删 `~/.claude/cc-tab-status/<sid>.json`，或下次 `Stop`/`SessionEnd` 触发 writer 重写/删除该文件。per-tab 因只读自己 sid，单个死 session 的残留只影响它自己一个 tab 的点，不会被放大；聚合把它计入**全局**计数，影响所有 tab 看到的数字。
- **聚合 vs per-tab 的 permission 分歧**：见 §7.2 末段。permission-pending 期间聚合计为 🟡 running，per-tab 显示 CC 原生蓝点——同一会话两处 UI 不同色，因 pending 信号是 per-panel-live，无窗口级广播通道让聚合读取。无功能性 bug，是设计折衷。
- **聚合刷新定时器的"第一 panel 闭包"绑定**：单例定时器由第一个 CC panel 的 IIFE 创建，闭包捕获该 panel 的 `DIR`/`fs`/`vs` 等局部（这些值在所有 panel 间是确定的、无 panel-specific 状态，故无泄漏问题）。最后 panel 关闭时 `clearInterval` 释放定时器；新 panel 打开时由其 IIFE 重建（item 仍复用，timer 重建），首 tick 即 `show` 回来。

