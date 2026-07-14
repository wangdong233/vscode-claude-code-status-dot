# Open Editors 调研复核审计（phase1 结论 + phase2 决策）

> 审计对象：[`OPEN-EDITORS-research.md`](OPEN-EDITORS-research.md) 的 phase1 结论（类 A「已满足」）与 phase2 决策（不实施）。
> 审核基准：[`/Users/wangdong/Documents/Project/架构想法/02_简单检查清单.md`](../../../../架构想法/02_简单检查清单.md)（执行简报 / §D 输出契约）。
> 审核日期：2026-07-15。输入：`repo`=`claude-code-status-dot`，`stack`=TS（patch.ts）/ JS（注入 IIFE），`scope`=Open Editors 专题，`fix`=否。

---

## 0. 审核输入确认（§"任务接入" 7 项）

| 输入 | 值 | 来源 |
|---|---|---|
| repo | `claude-code-status-dot` | 任务给定 |
| stack | TS（patch.ts）+ JS（注入 IIFE）+ SVG | 自动探测（`package.json` + `patch.ts` 头） |
| scope | Open Editors 专题（phase1 结论 + phase2 决策） | 任务给定 |
| depth | 完整复核 phase1 证据链 + phase2 决策 + 跑功能验证 | 任务给定 |
| calibrate | 否（声明"起点值未校准"） | 缺省 |
| target_arch | 无（跳过 §6.2 漂移 diff） | 缺省 |
| fix | 否（只报告） | 缺省 |

铁律遵守：必填项齐备，未臆测。

---

## 1. 功能验证（任务第 4 项，先出实证）

phase2 **无任何代码改动**（`git status`：仅 `docs/OPEN-EDITORS-research.md` 为新增 untracked；`patch.ts` / `cc-status.js` / `STATES.md` / SVG 均未触碰）。故验证目标转为"确认未引入回归 + 现有产物仍健康"：

| 命令 | 结果 | 判定 |
|---|---|---|
| `node hooks/test-cc-status.js` | **8 passed, 0 failed**（含 method A/B、interrupt 优先、SessionEnd 清理） | 无回归 |
| `npx tsx patch.ts --check-iife` | 输出完整 IIFE 字符串、**语法有效、无报错**；TICK_MS=500；`p.iconPath=vs.Uri.file(svg)` 是唯一状态写入点（`patch.ts:362`） | 无回归 |
| `npx tsx patch.ts --status` | CC v2.1.209 识别成功；**7 个状态 SVG 全部在位**；state dir 存在；进程无崩溃 | 无回归 |

**对 `--status` 中 "extension.js patched: no" 的说明**：这是已安装 CC 已自动更新到 v2.1.209、而 patch 尚未重新应用的状态——属 [`STATES.md`](STATES.md) §5 早已记录的"CC 自动更新覆盖 patched extension.js"已知限制，**与本次 Open Editors 调研无关**，非回归。用户重跑一次 `tsx patch.ts` 即恢复（不影响调研结论）。

---

## 2. phase1 结论复核：类 A「已满足」—— **确认成立（把握度 high）**

### 2.1 核心证据链逐条复核

| 调研主张 | 复核结果 |
|---|---|
| **v1.26 发行说明原文**："Webviews may now provide a custom icon that is shown in the **tab bar and OPEN EDITORS view**" | ✅ **独立 web 检索逐字命中**（[code.visualstudio.com/updates/v1_26](https://code.visualstudio.com/updates/v1_26)）。这是 iconPath 自设计之初就覆盖两处视图的**契约级声明**，非实现细节。 |
| **API 参考**：`WebviewPanel.iconPath` "shown in the editor tab and **OPEN EDITORS view**" | ✅ 与发行说明一致（[vscode-api](https://code.visualstudio.com/api/references/vscode-api)）。 |
| **源码闭环**：`OpenEditorRenderer.renderElement` → `editor.getIcon()` → `WebviewInput.getIcon()` 返回 iconPath | ✅ 源文件路径可追溯（`contrib/files/browser/views/openEditorsView.ts` + `contrib/webviewPanel/browser/webviewEditorInput.ts`）。此为**佐证细节**，非承重墙——承重墙是上面的 API 契约。 |
| **500 ms 同步事件链**：iconPath setter → `_onDidChangeLabel` → `EDITOR_LABEL` → 单行重渲 | ✅ 事件链合理。即便 setter 仅在值变化时才 fire（而非无条件），`running`（6 帧 URI 每帧不同）/ `interrupted`（error.svg ↔ CC 默认，每 tick 切换）的 URI 本就每 500 ms 变化，必触发重渲；`idle`/`done` 静态无需动画。故"呼吸/快闪同步"结论对 setter 语义**不敏感**，稳健。 |
| **r6 点可见性**（viewBox 24×24，circle cx=18 cy=6 r=6，16 px 下 ≈8 px） | ✅ **逐字核对 4 个 SVG 源码**：`idle`/`running`/`done`/`error` 全部 `viewBox="0 0 24 24"` + `<circle cx="18" cy="6" r="6">`，与 [`STATES.md`](STATES.md) §1 点几何注记一致。 |

### 2.2 把握度判定

- 承重证据是 **VSCode 官方 API 契约**（两处明文"tab bar and OPEN EDITORS view"），不是源码推理。
- 用户已确认**顶部 tab 栏四态点生效**——同一 `iconPath` 属性、同一渲染契约，Open Editors 按文档定义必然同步生效。除非用户关闭了 `workbench.editor.showIcons`（此设置同时控制 tab 栏与 Open Editors 图标，关掉则两处都没图标——但 tab 栏既已生效，该设置必为开）。
- **结论：类 A「已满足」、把握度 high 站得住。** 调研自评 high 并诚实标注"未经实机截图"，此诚实度合格——契约级证据已足够支撑 high，唯一残留是 30 秒肉眼复核（零成本最终实证，不阻断决策）。

### 2.3 有没有被忽略的路径？

逐条复核 §5 五条备选路径：

| 路径 | 调研判定 | 审计意见 |
|---|---|---|
| (a) 改 `panelTab.title` 加状态后缀 | 不采纳（污染 window title、无法表达呼吸） | ✅ **代码复核确认确实未采纳**：`patch.ts` 中 `panelTab.title` 仅出现在 CC 原生 `rename_tab` handler（`:146`/`:429`，`= e.request.title`，设的是 CC 自己的标题），**无任何 `[running]` 类后缀拼接**。iconPath（`:362`）是唯一状态机制。 |
| (b) FileDecorationProvider | 不适用 | 🟡 **判定对、理由略不精确**——见 §4 观察 O1 |
| (c) patch CC webview | 无效（Open Editors 是原生 list，不在 webview 内） | ✅ 正确 |
| (d) patch VSCode 本体 DOM | 重/脆/违规 | ✅ 正确 |
| (e) proposed API | 当前无 | ✅ 正确（社区请求佐证） |

**未发现被忽略的可行增强路径**。Open Editors 的图标显示，VSCode 只暴露 `iconPath` 这一条 API 通道（已被我们用上）；其余装饰类 API 均不覆盖 webview panel input。

---

## 3. phase2 决策复核：**不实施**—— **决策正确**

### 3.1 从简单性原理看"不实施"

phase2 选择不改任何代码，本质是**拒绝引入第二套状态指示机制**。这在 [`02_简单检查清单.md`](../../../../架构想法/02_简单检查清单.md) 的语言里恰好命中两条正向约束：

- **R-CI-02（横切关注点变体：同一类操作多种做法）**——状态指示这一关注点，全项目只有 `iconPath` 一种做法（writer 写状态文件 → reader 读 → 设 iconPath）。若 phase2 采纳路径 (a)（title 后缀）或 (b)（decoration），就会在 iconPath 之外**并行引入第二种"如何把状态告诉用户"的做法**，正是 §6.3 review 三问 #1（"是否引入系统里第二套做同一件事的方式"）要拦截的退化。**决策拒绝之，是对的。**
- **R-ABS（抽象成本）**——iconPath 已表达"状态→图标"的完整共性，再叠任何机制都是 01 §3 的"为已覆盖的需求新增抽象"，净增系统复杂度而无新能力。

### 3.2 决策的副作用评估

- **一致性（与 STATES.md / HOOK_EVENTS / 现有 iconPath patch 共存）**：N/A——无代码改动，无新概念，零共存风险。reader 渲染逻辑（[`STATES.md`](STATES.md) §4）零改动，与"Open Editors 复用 iconPath"完全自洽。
- **状态机正确性**：N/A——未触碰状态机（8 个 HOOK_EVENTS、四态枚举、done→idle 5 min、interrupt 优先均不变；测试 8/8 通过为证）。
- **概念完整性**：✅ 维持单一机制（iconPath），未引入第二套做法。
- **副作用（title 后缀类）**：✅ 未采用 title 后缀，无 window title 抖动、无 tab 标题污染。

---

## 4. 清单外观察（§E #3：不冒充正式 finding，单独成区）

> 以下为文档精度/运维注记，**非简单性违例**，不进正式 finding。

**O1 — §5(b) 的否决理由略不精确（文档精度）**
- 位置：`OPEN-EDITORS-research.md` §5 路径 (b)。
- 现状：原文称 FileDecorationProvider"只对 Explorer/Tree View 中的**文件资源**生效"。
- 实情：FileDecorationProvider 可为**任意 URI scheme** 注册（包括虚拟 URI），并非只能文件资源。但**结论仍正确**——Open Editors 中 CC webview panel 的 resource 是 `webviewPanel:` 虚拟 URI，没有任何扩展为该 scheme 注册 decoration provider，且我们无法从 patch 侧低成本注册一个稳定 provider。故"不适用"的判定对，只是理由可以更准（"无 provider 注册 + patch 侧难稳定注册"，而非"API 只认文件资源"）。
- 建议：可选修订一句，非阻断。

**O2 — §3.1 定时器开销表述略夸张（文档精度）**
- 位置：`OPEN-EDITORS-research.md` §3.1"N 个 tab = N 个 500 ms 定时器，每 tick 多触发 N 次单行重渲"。
- 实情：每个 panel 的 IIFE 只设**自己**的 iconPath，每 tick 只 fire 自己那一行的 `EDITOR_LABEL`；N 个定时器启动时机不同步（随 panel 打开时间错开），并非每 tick 同步触发 N 行。
- 结论不变：单行 splice 成本极低，开销可忽略。仅表述可精简为"每 panel 每 500 ms 各触发 1 次自身单行重渲"。

**O3 — patch 当前未应用（运维注记，非代码缺陷）**
- `--status` 显示 installed CC v2.1.209 的 extension.js 未 patched。这是 [`STATES.md`](STATES.md) §5 已记录的"CC 自动更新即失效"已知限制，**与本次调研无关**。用户重跑 `tsx patch.ts` 即恢复。列出只为完整，不改任何结论。

---

## 5. 总体结论

| 维度 | 审核结论 |
|---|---|
| phase1 结论（类 A「已满足」，high） | ✅ **确认成立**。承重证据为 VSCode 官方 API 契约（v1.26 发行说明 + API 参考，已独立逐字核实），辅以可追溯源码链 + 4 个 SVG 几何核对。用户 tab 栏既已生效，Open Editors 按同一契约必然同步。 |
| phase2 决策（不实施） | ✅ **正确**。拒绝引入第二套状态指示机制，恰好守住 R-CI-02 / R-ABS / §6.3 #1——是更简单的选择。无代码改动 → 无回归（测试 8/8、IIFE 语法有效、status 健康）。 |
| 正式 finding（§D 契约） | **0 条**。phase2 无代码改动，无可审的结构违例；决策本身是简单性正向。 |
| 清单外观察 | 3 条（O1 文档精度 / O2 文档精度 / O3 运维注记），均非简单性违例。 |
| 残留 | 唯一未关闭项是调研自荐的"30 秒肉眼复核"——零成本最终实证，建议做，但不阻断决策（契约证据已足够）。 |

**一句话**：phase1 结论可靠（high），phase2"不实施"是正确且最简单的决策，零 finding、零回归。

---

## 阈值校准状态声明

本审核未触发 §2–§5.5 任何阈值规则（无代码改动），故不涉及阈值校准。若后续 phase2 改为实施某条增强路径，相关阈值（如 R-CI-02 横切关注点变体）为**起点值、未经本仓库校准**。

## 证据清单一（本次复核新增/独立核实）

- VSCode v1.26 发行说明（iconPath 覆盖 "tab bar and OPEN EDITORS view"，**独立 web 检索逐字命中**）：https://code.visualstudio.com/updates/v1_26
- VSCode API 参考（`WebviewPanel.iconPath` 定义）：https://code.visualstudio.com/api/references/vscode-api
- 本仓 `patch.ts:315-366`（`buildIIFE`：iconPath 为唯一状态机制，TICK_MS=500）
- 本仓 `patch.ts:146,429`（`panelTab.title` 仅在 CC 原生 rename_tab handler，无状态后缀）
- 本仓 4 个状态 SVG（viewBox 24×24 / circle cx=18 cy=6 r=6，逐字核对）
- 本仓 `hooks/test-cc-status.js`（8/8 pass）、`tsx patch.ts --check-iife`（IIFE 有效）、`--status`（SVG 齐备、无崩溃）
