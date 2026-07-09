# 架构简单性审核报告 — claude-code-status-dot

> 审核基准：[`架构想法/02_简单检查清单.md`](../../../架构想法/02_简单检查清单.md)（执行简报 A–E 节）
> 审核日期：2026-07-10 · 审核员：AI Agent（架构简单性审核员，fix=否，只报告不动手）
>
> **修复状态（2026-07-10）**：本报告审查的是 workflow 产出的 v0.1.0 骨架。F-1~F-6（状态枚举/SVG 命名/hook 事件集/文件契约/文档分裂）已在后续修复中**全部解决**——建立 [`STATES.md`](STATES.md) 作为唯一真相源，writer（cc-status.js）/ reader（patch.ts IIFE）/ SVG 文件名 / 文档 / package.json 全部对齐。下方 finding 描述的是**修复前**的状态，保留作为历史审查记录与回归参照。

---

## 0. 任务接入确认（简报 §任务接入）

| 输入 | 值 | 说明 |
|---|---|---|
| `repo` | `/Users/wangdong/Documents/Project/vscode-cc-提示插件/claude-code-status-dot` | 已确认存在 |
| `stack` | TypeScript / Node（脚本侧）+ 注入到 CC 扩展宿主的 vanilla JS（IIFE） | 已探测：`patch.ts` 用 `tsx` 跑；`hooks/cc-status.js` 是零依赖 Node 脚本；注入块是手写 JS 字符串 |
| `scope` | 全量 | 已遍历 `patch.ts`(633 行) / `hooks/cc-status.js`(179 行) / `resources/*.svg`(4 个) / 全部 `*.md` / `package.json` / `settings-snippet.json` |
| `depth` | 完整（§2–§6） | 见下 |
| `calibrate` | **否** | → 阈值校准状态声明见 §3 |
| `target_arch` | 未提供 | → 跳过简报第 5 步（R-DRIFT 不做偏航 diff） |
| `fix` | **否** | 只报告，未改动任何文件 |

技术栈探测依据：`package.json` `"type":"module"` + `engines.node>=18` + `npx tsx patch.ts`；`cc-status.js` 用动态 `import()` 兼容 CJS/ESM；注入块用 `require("fs"|"path"|"vscode"|"os")`（VSCode 扩展宿主环境）。未臆测。

---

## 1. 总体简单性健康度

### 1.1 各刻度命中分布

| 刻度 | 🔴 Fail | 🟡 Warn | 🔵 Review | 判读 |
|---|---|---|---|---|
| 一·交织度 R-INT | 0 | 1 | 0 | 仅开闭扇出超阈；纯函数性/接口胖/PR 半径均 PASS |
| 二·模块深度 R-DEP | 0 | 0 | 1 | 浅模块/穿堂式/信息泄漏均未触发（详见 §1.3） |
| 三·变更放大 R-CHG | 0 | 0 | 0 | 非 git 仓库，无历史可测（见 §3） |
| 四·概念完整性 R-CI | 0 | 6 | 1 | **本仓库主战场**：状态枚举 / SVG 命名 / hook 事件集 / 文件契约 / 文档各成体系 |
| 适应度函数 R-FF | 0 | 0 | 0 | 分层 N/A、循环 PASS、穿堂 PASS |
| 漂移 R-DRIFT | — | — | — | 无目标架构，跳过 |
| **合计** | **0** | **7** | **2** | — |

### 1.2 起步最小集（清单 §1，6 条）达标情况

| # | 最小集条目 | 状态 |
|---|---|---|
| 1 | R-FF-01 分层/依赖方向 | **N/A** — 本项目是「CLI 补丁脚本 + hook 脚本 + 注入 IIFE」三件套，无 UI/控制/服务/DAO 分层，规则结构不适用 |
| 2 | R-FF-02 循环依赖 | **PASS** — `patch.ts` 与 `hooks/cc-status.js` 之间零 import 边；唯一"耦合"是运行时文件契约（一写一读），不构成依赖环 |
| 3 | R-DEP-03 穿堂式方法 = 0 | **PASS** — 全局无 `return this.X(...)` / `return delegate(...)` 转发型方法（脚本风格，本就无 OOP 委托）。`printHelp` 里的 `const b=(s)=>s`（patch.ts:562）是恒等函数，不调用任何目标，**不属 R-DEP-03 的转发语义**，归入 §4 清单外观察 |
| 4 | R-CHG-01 变更放大率 | **不可测** — 非 git 仓库（`git log` 失败），无 PR 历史。静态代理见 R-INT-02（F-4）：新增一种状态需触及 ≥6 处 |
| 5 | R-CI-01 术语一致性 | **FAIL** — 见 F-1/F-2/F-3/F-6，状态枚举存在 4 套、SVG 命名存在 2 套、hook 事件集存在 ≥3 套 |
| 6 | §6.3 review 三问 | **缺失** — `CONTRIBUTING.md` 有 PR 清单，但无"是否引入第二套做法/新抽象暴露 what 还是 how/共享函数是否按 caller 分流"三问 |

**一句话结论**：硬不变量全绿（无循环、无穿堂、无分层越界），结构骨架对一个 ~800 行的工具是干净的；但**概念完整性严重失守**——每个跨组件契约都被裂成多份，且裂痕已渗入代码两半（reader/writer），使系统按当前产物**端到端无法正确渲染 4 态中的 3 态**。

### 1.3 重点回应任务参数："patch.ts 是否浅模块 / 穿堂式 R-DEP-03"

- **穿堂式（R-DEP-03 / R-FF-04）= 0，PASS。** 全文逐函数扫过：`log/warn/fail` 加前缀非纯转发；`backupOnce/countOccurrences/cmpVer/discoverExtension/patchExtension/buildIIFE/wireHooks/...` 均有实质逻辑；无 `this.x()` 委托链。唯一可疑的 `b=(s)=>s` 不满足转发定义（见上）。
- **不是浅模块。** `patch.ts` 是单入口脚本（`run()`），public API 面 ≈ 0（无 export），depth = 633 行 / 1 入口 → 反而是"深"的。它的问题**不是浅**，而是**低内聚的 god-script**（一个文件混了发现/备份/JSONC/CodeGen/hook 接线/CLI/状态报告 6 类关注）——这条清单无对应规则（R-DEP-02 测的是"浅"，不是"杂"），故归 §4 清单外。

---

## 2. Findings（按严重度排序）

> 每条含 rule_id / severity / location / evidence / why / suggestion / confidence，遵循清单 §D。
> **所有 🟡 均为趋势阈值命中，非硬缺陷；清单 §E 红线 #2：阈值命中默认 🟡，不因"看起来严重"升 🔴。**

---

### F-1 🟡 R-CI-03 · 同名字段 `state` 在 writer/reader 两半代码里值域互斥

- **severity**：🟡 Warn（规则级别；confidence high。注意：它**同时**造成功能性失效，但功能性失效不是清单任一 🔴 规则，按 §E 红线 #2/#3 不升 🔴、不发明规则，功能性影响在 §4 清单外声明）
- **location**：写侧 `hooks/cc-status.js:13,71-92`；读侧 `patch.ts:304-306`（注入 IIFE 的状态分支）
- **evidence**：
  - 写侧（`cc-status.js` 注释 + switch）：`States: running | waiting | done | interrupted`，case 仅覆盖 `UserPromptSubmit→running / PreToolUse,PostToolUse→running / Notification→waiting / Stop→done / StopFailure→interrupted / SessionEnd→DELETE`。
  - 读侧（注入定时器）：`if(st==="error")... else if(st==="running")... else if(st==="idle")... else{return}`。
  - 两侧交集 = `{running}`。写侧会产出的 `waiting/done/interrupted` 读侧**全部落入 `else{return}`**（不覆盖图标）；读侧认得 `idle/error` 写侧**从不产出**。
- **why（回到刻度原理）**：R-CI-03 同名实体多义——同一个 `state` 字段，writer 与 reader 的合法值集差异 > 30%（实际是 75% 不相交）。Evans"概念完整性"要求同一术语在整个系统里指代同一件事；这里同一字段名承载两套互斥语义，是概念失真的结构证据（不是"读着费劲"）。其后果（3/4 态不可渲染）是该结构的直接推论，不是偶发 bug。
- **suggestion**：建立**唯一状态枚举表**（单一 source of truth，例如 `docs/STATES.md` 或一份 TS const 并被两侧 import/复制-标注），令 `cc-status.js` 的 case 值 ⊆ 该表，注入 IIFE 的分支值 ⊆ 同一表。任何状态增删先改表、再机械同步两侧，且在表头注明"另一方必须同步"。
- **confidence**：high（字节级证据，已用 `grep` 逐 case 比对）

---

### F-2 🟡 R-CI-01 · 状态枚举术语跨产物分裂为 4 套

- **severity**：🟡 Warn（confidence high）
- **location**：`hooks/cc-status.js:13` / `patch.ts:304-306` / `package.json:4` / `README.md:33-38`（同样表述见 `CHANGELOG.md:14-18`、`docs/USAGE.md:179-184`）
- **evidence**（四套并存）：
  1. 注入 reader（`patch.ts`）：`running | idle | error`
  2. hook writer（`cc-status.js`）：`running | waiting | done | interrupted`
  3. `package.json` description：`idle/running/done/interrupted`
  4. `README.md`/`CHANGELOG.md`/`USAGE.md`：`idle/running/done/interrupted`（含颜色"灰黄绿红"）
  - 四套两两不同；其中 1 与 2 是代码两半（必须一致才能跑），3/4 是对外承诺。SVG 文件 `<title>` 里又出现 `Idle/Running/Error`（见 `resources/*.svg` 首段），即第 5 套措辞。
- **why**：R-CI-01 同概念多名 / 多义。Brooks"概念完整性"主张一个系统只能由一组连贯的概念支配；这里"CC 的状态"这一个概念被五种命名/取值表述同时占用，没有任何一处是权威源。这正是清单 §6.3 review 第一问"是否引入了第二套做同一件事的方式"的教科书案例，且已经发生。
- **suggestion**：定一份**术语表**（含状态名 + 触发事件 + 颜色 + 对应 SVG），所有代码与文档引用它；删除四套中的任何三套。建议以代码两半（writer）实际产出的为准倒推文档，而非反过来。
- **confidence**：high

---

### F-3 🟡 R-CI-01 · SVG 文件名命名两套，reader 引用的 4 个文件磁盘上全不存在

- **severity**：🟡 Warn（confidence high；同样附带功能性失效，见 §4）
- **location**：`patch.ts:84`（`OUR_SVGS`）/ `patch.ts:528-537`（`checkSvgs` 校验）/ `resources/`（实际文件）
- **evidence**：
  - 代码声明期望：`OUR_SVGS = ["cc-running.svg","cc-running-bright.svg","cc-idle.svg","cc-error.svg"]`（patch.ts:84），注入 IIFE 也引用同名（patch.ts:304-306）。
  - 磁盘实际：`claude-logo-error.svg / claude-logo-idle.svg / claude-logo-running-bright.svg / claude-logo-running.svg`（`ls resources/`）。
  - 两套前缀（`cc-*` vs `claude-logo-*`）零交集 → `checkSvgs` 必对 4 个文件全报 missing，注入定时器 `vs.Uri.file(<不存在的路径>)` 必致图标空白。
- **why**：R-CI-01 同一概念集（4 个状态图标）两套文件名术语。根因是 SVG 沿用了 CC 自家命名习惯（`claude-logo-*`，见 DESIGN-injection.md §1 对 CC 内部 `claude-logo.svg` 的逆向），而 patcher 代码却另造 `cc-*` 前缀——同一批资源、两个标识体系，未做收口。
- **suggestion**：二选一统一。考虑到这些 SVG 的 `<title>` 已经写 `Claude (Idle/Running/Error)`、且 DESIGN §5 选了"绝对路径引用本项目 resources/"，建议把 `OUR_SVGS` 改为磁盘实际的 `claude-logo-*` 名（代码改一处比改 4 个二进制资源更轻），或反之重命名资源。
- **confidence**：high

---

### F-4 🟡 R-INT-02 · 新增一种状态需触及 ≥6 处（开闭违反，扇出实测）

- **severity**：🟡 Warn（阈值 ≥3 处；confidence high）
- **location**：跨 `hooks/cc-status.js:69-100`（switch）+ `patch.ts:84`（`OUR_SVGS`）+ `patch.ts:304-306`（IIFE 分支）+ `resources/*.svg`（新增文件）+ `README.md:33-38`/`package.json:4`/`CHANGELOG.md`（对外枚举）+（可选）`settings-snippet.json`（事件接线）
- **evidence**：静态推演"加一种状态 `thinking`"：① `cc-status.js` switch 加 case；② `OUR_SVGS` 加文件名；③ IIFE `if/else` 链加分支；④ `resources/` 加 SVG；⑤ `README`/`package.json`/`CHANGELOG` 改状态表；⑥（若需新事件）`HOOK_EVENTS` + `settings-snippet.json` 两份事件表。= 5–6 处，超阈值 ≥3。**F-1/F-2 的四套分裂正是这条未被收敛的实证后果**——因为散点太多，人才没改齐。
- **why**：R-INT-02 开闭违反（Hickey：simple = 不交织；新增变体要改多处 = 变体逻辑与多处结构缠绕）。Ousterhout 也警示"深模块应让新变体落入同一扩展点"；此处状态枚举没有单一扩展点，而是被抄写到 N 处，每处都是"必须记得改"的隐藏依赖。
- **suggestion**：把"状态→{事件, SVG, 颜色, 动效}"抽成**一张表**（代码侧一份 const、文档侧引用同一份），让 switch/IIFE/`OUR_SVGS`/docs 都从该表派生或机械映射；新增状态 = 表加一行 + 资源加一文件。
- **confidence**：high

---

### F-5 🟡 R-CI-02 · hook 事件集存在 ≥3 套，且 patcher 接的事件脚本不处理、脚本处理的事件 patcher 不接

- **severity**：🟡 Warn（confidence high）
- **location**：`patch.ts:98`（`HOOK_EVENTS`）/ `hooks/cc-status.js:71-95`（被处理的 case）/ `hooks/settings-snippet.json:22-112`（手工接线表）/ `README.md:117-121`（文档里又只列 3 个）
- **evidence**（事件集三套不一致）：
  - `HOOK_EVENTS`（patcher 自动注入）= `SessionStart, UserPromptSubmit, Stop, Notification`（4）
  - `cc-status.js` 实际 `case` = `UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, StopFailure, SessionEnd`（7）
  - `settings-snippet.json` = 与脚本同 7 个；`README.md` = 3 个
  - **错配**：`SessionStart` 被 patcher 接线但脚本无对应 case（落 `default→null→exit`，**死接线**）；反之 `PreToolUse/PostToolUse`（running 心跳）、`StopFailure`（interrupted）、`SessionEnd`（删状态文件）脚本会处理，patcher 却不接 → 走 patcher 装的用户拿不到心跳刷新与状态文件清理。
- **why**：R-CI-02 横切关注点（"状态从事件派生"这一关注点）存在 >1 种实现/接线方式，且互不子集。Brooks/Evans：同一类操作只能有一种统一做法；这里"哪些事件喂给 hook"有 patcher 自动、snippet 手工、文档描述三个互不一致的版本。`SessionStart` 死接线是"第二套做法"派生的结构杂物（不是功能 bug 本身，是概念未统一的症状）。
- **suggestion**：定一份**唯一事件→状态映射表**（与 F-1/F-2 的状态表合一），让 `HOOK_EVENTS` 与 `settings-snippet.json` 由同一来源生成或互为镜像；删除 `SessionStart`（脚本不处理）或为脚本补 `SessionStart` case（二选一，取决于业务是否需要会话起始态）。
- **confidence**：high

---

### F-6 🟡 R-CI-01 · 文档描述的是另一套系统（脚本/路径/特性与代码不符）

- **severity**：🟡 Warn（confidence high）
- **location**：`docs/USAGE.md:119,130,141,168,179-186` / `README.md:43,98,117-127,145,175` / `CONTRIBUTING.md:68,75,121` / `CHANGELOG.md:21,22`
- **evidence**（文档承诺 vs 代码实际）：
  | 概念 | 文档说 | 代码实际 |
  |---|---|---|
  | hook 命令脚本 | `node ~/.claude/status-dot/hooks/write-state.js <state>`（USAGE 多处） | `node "<abs>/hooks/cc-status.js"`（patch.ts:416），脚本名/位置/传参方式全不同（脚本读 stdin JSON，不收位置参） |
  | 状态文件路径 | `~/.claude/status-dot/state.json`（README/USAGE/CONTRIBUTING） | `~/.claude/cc-tab-status/<session_id>.json`（patch.ts:81 / cc-status.js:124），目录名 + 多文件 per-session vs 单文件 |
  | 状态文件字段 | `{status, ts, session}`（README:126） | `{state, since, error?}`（cc-status.js），字段名都不同 |
  | watchdog 兜底 | README:43、CHANGELOG:21、USAGE:203/224 反复提及 | 代码无任何 watchdog（注入定时器只读文件，不做"Esc 中断"检测） |
  | done/interrupted 通知 | README:41、CHANGELOG:22 | 代码无任何 VSCode 通知调用 |
  | 目录结构含 `src/` | USAGE:53、`package.json:34` 的 `files` 字段含 `"src/**/*"` | 仓库无 `src/` 目录 |
  | "找到锚点 3/3" | USAGE:75 | patcher 只有 2 个锚点（Anchor A/B），且 B 可选 |
- **why**：R-CI-01 术语/概念一致性。文档与代码描述了两个不同的系统——这不是"个别笔误"，是"概念完整性"层面的偏移：对外承诺的产物形态（单文件 state.json + 位置参脚本 + watchdog + 通知 + src 目录）与实际交付（per-session 文件 + stdin JSON 脚本 + 无 watchdog + 无通知 + 无 src）系统性不符。Evans：模型与实现如果各自演化、无人对账，概念完整性即丧失。
- **suggestion**：以代码为权威重写文档（USAGE/README/CONTRIBUTING 同步），或显式标注"文档描述的是规划目标，当前 v0.1.0 实现见 DESIGN-injection.md"。`package.json` 的 `"files": [...,"src/**/*"]` 应删去不存在的 `src/`。
- **confidence**：high

---

### F-7 🔵 R-CI-07 · PR 模板缺"新概念准入"强制字段

- **severity**：🔵 Review（CI 判不了；confidence high）
- **location**：`CONTRIBUTING.md:92-100`（PR 清单）
- **evidence**：PR 清单 7 条全部围绕"锚点/还原/CC 版本/中英文同步"，无一条问"你引入的新名词/新抽象/新组件替代或归属哪条已有设计原则"。`CONTRIBUTING.md:7-13` 的"项目心法"3 条（最小侵入/完全可逆/版本韧性）也未在 PR 清单里被回扣。
- **why**：R-CI-07 新概念准入门槛缺失。本项目当前的概念分裂（F-1~F-6）恰恰是"没有准入闸"会累积出的结局；挂一道"新状态/新文件名必须标注归属"的门槛，是机器判不了、但能拦住下一次分裂的低成本防线（清单 §6.3 第三层）。
- **suggestion**：在 PR 清单加一项："如本次引入新术语/新状态/新文件命名约定，已说明它与现有约定的关系（替代/合并/归属），并同步到唯一术语表。"
- **confidence**：high

---

### F-8 🔵 R-DEP-05 · 状态文件 schema 跨进程边界复制，无共享契约

- **severity**：🔵 Review（confidence medium）
- **location**：写侧 `hooks/cc-status.js:9,65-101,131-136`（`{state, since, error?}` + 注释 + `writeJsonAtomic`）；读侧 `patch.ts:81,302`（`STATE_DIR` + IIFE `JSON.parse(...).state`）
- **evidence**：同一个 IPC 文件契约（目录名、文件名模式 `<sid>.json`、字段 `{state, since, error?}`）在 writer 与 reader 各硬编码一份，无共享 schema/类型/防腐层。`patch.ts` 的 `STATE_DIR` 常量与 `cc-status.js` 的 `STATUS_DIR` 是两条独立字面量（值相同纯属人工对齐）。
- **why**：R-DEP-05 信息泄漏——内部数据结构（per-session JSON 文件格式）跨边界出现于两个独立组件，且无任何一方声明"我是契约的所有者"。它正是 F-1（`state` 值域分裂）得以发生的结构温床：契约没被一处持有，两边就可以各自漂移。**部分受客观约束**：注入块跑在 CC 扩展宿主里，无法 import 本仓库模块，自包含是被迫的——故降为 🔵 而非 🟡。
- **suggestion**：在 `docs/` 下落一份显式契约（`STATE-FILE.md`：路径、文件名、字段、值域、原子写约定），让两侧注释都指向它；考虑给 `cc-status.js` 的写出加一个 `// CONTRACT: see docs/STATE-FILE.md` 锚点，便于 grep 对账。
- **confidence**：medium（是否属"泄漏"取决于是否认可"文件 IPC 也该有契约层"，判读空间存在，按 §E 红线 #5 归 🔵）

---

## 3. 阈值校准状态声明（清单 §E 红线 #9）

**本报告所用全部阈值（R-INT-02 ≥3 处、R-CI-03 字段差异 >30%、R-INT-04 >3 文件、R-DEP-02 深度 <5 等）均为清单给定的"起点校准值"，未经本仓库历史数据回测、未固化。**

特别声明：
- 本仓库**非 git 仓库**（`git log` 失败），R-CHG-01（touches-per-change）与 R-FF-06（趋势告警）**无历史可测**，本报告未对其下任何结论；F-4 是用"静态扇出代理"对 R-INT-02 的等价度量，不是 R-CHG-01 的历史统计。
- 未执行简报第 4 步（阈值校准，因 `calibrate=否`）。
- 未执行简报第 5 步（目标架构偏航 diff，因 `target_arch` 未提供）。

命中 🟡 的各条，其阈值未校准意味着"建议审视"而非"已定罪"；但本次命中的证据多为**字节级代码-vs-代码、代码-vs-磁盘**不一致（非阈值边界擦边），校准与否不改变结论方向。

---

## 4. 清单外观察（非 finding，不冒充规则）

> 按 §E 红线 #3，以下现象清单无对应规则，单独成区。

1. **概念完整性失效附带的功能性后果（不属于清单任一 🔴 规则，故不升 🔴，仅记录）**：F-1/F-3 的代码两半不一致，使系统**按当前 v0.1.0 产物端到端不可用**——hook 永远不会写出 `idle` 或 `error`，reader 永远不会认 `waiting/done/interrupted`；4 个 SVG 文件名 reader 一个都找不到。即 4 态里只有 `running` 可能被渲染，且即便 `running` 命中，`cc-running.svg` 文件也不存在（磁盘是 `claude-logo-running.svg`）。这是"结构失真→功能失效"的直接链路， Severity 上比 🟡 更重，但**清单没有给"功能性失效"配 🔴 规则**，审核员不越权发明。
2. **`patch.ts` 是低内聚 god-script（清单未覆盖）**：633 行单文件混了扩展发现 / 备份 / JSONC 解析 / 锚点校验 / 代码生成 / hook 接线 / CLI / 状态报告 / 还原 9 类关注。R-DEP-02 测的是"浅模块"，不是"杂模块"，故不触发；但若后续要扩到第 5 个状态或第 3 个锚点，这个文件会继续膨胀。建议（非强制）按"纯函数工具 / 副作用 IO / CLI"三刀切分。**当前不算简单性违例，只是规模预警。**
3. **`patch.ts:562` 的 `const b=(s)=>s`**：恒等函数，应是早期"加粗"helper 的遗留死抽象，未删。非 R-DEP-03 转发（不调用任何目标），故不计入 finding；建议直接内联删除。
4. **零测试 / 零 CI 适应度函数**：仓库无任何测试，`package.json` 无 test/lint 脚本，无 `dependency-cruiser`/`madge` 等循环检测。R-CI-05（测试命名）因无测试而 N/A；R-FF-01/02/04 适应度函数未落地。F-2~F-6 这类分裂，一个 5 行的"状态表一致性"测试本可在 CI 拦住。
5. **注入 IIFE 与 `cc-status.js` 的 fs/path/os DIR 重复**（R-DEP-04 候选）：两层各 `require` fs/path/os、各拼 `~/.claude/cc-tab-status`。但注入块受部署约束（不能 import 本仓库），且两层职责不同（一层 codegen、一层 runtime reader）——满足"different layer, different abstraction"，**判定为被逼的合理重复，不立 finding**。
6. **README.en.md 未单独验证**：本次未读 `README.en.md`（中文 README 已足以为 F-6 取证）；若存在同样漂移，CONTRIBUTING 的"中英文同步"要求意味着它应与中文版同步修正。

---

## 5. 一句话总结

硬不变量全绿、骨架干净，但概念完整性是重灾区：状态枚举 / SVG 命名 / hook 事件集 / 文件契约 / 文档各跑各的，且代码两半对不上——系统按当前产物 4 态只能渲染 0~1 态。最优先动作：建一张唯一状态表（含事件/SVG/颜色），让 writer、reader、`OUR_SVGS`、文档、`package.json` 全部引用它，其余分裂会随之收敛。
