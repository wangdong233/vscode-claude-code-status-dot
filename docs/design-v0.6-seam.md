# cc-status-dot v0.6 「Seam」架构设计(D2 修订版,2026-09-03 工作流裁决定稿)

> 来源:9-agent 工作流 wf_0562294e-ba3(取证 F1×11 → 调研 F2/F3 → 设计 D1 → 对抗 V1(FAIL,15 blockers)→ 修订 D2 → 复审 V2(PASS,0 HIGH))。
> 本文为实施契约,变更须走新一轮对抗复审。

# vscode-cc-status-dot v0.6 「Seam」更新免疫注入架构设计 v2（D2 修订版）

> 目标不变：以"稳定面观察"取代"内部文本锚"，使 patch 对 CC 任意版本更新结构性免疫。
> 本版为 D1 全量重写：逐条消化对抗+否定阶段全部 HIGH/MED blocker（裁决表见 §1），新增 ADR-1（seam vs AST 结构锚正面裁决，blocker B 项要求）、遥测全规格（§7）、功能迁移契约表（§10）、上游趋同观察（§11）。
> D2 新增实证（只读，标注【D2-验】）：vscode.d.ts:10207-10220 序列化器方法名=`deserializeWebviewPanel` 且 CC 2.1.259 bundle 实现同名（grep 计 1，`resolveWebviewPanel` 计 0）；companion/extension.ts:501 版本戳正则原文=`${markerRe}:v(\\d+\\.\\d+\\.\\d+)(?::[0-9a-f]{4,16})?\\*`；patch.ts:2789 banner=`/*${INJECT_MARKER}:${INJECT_VERSION}:${hash}*/`；patch.ts:2062 桥写入原文确认 sidebar 路径会写 `undefined`；patch.ts:3270-3283 legacy 剥离器 3 形状（segA_block/segA/segB）在场；companion:2858 按 `{active?:boolean}` 消费 panelMap、companion:1077 探针=`mem.__ccsdSbi !== undefined`。
> 本文档为设计阶段产物，未写入 repo 任何文件。

---

## 0. 摘要

注入机制从"锚点字符串替换"改为 **bundle 头部 prepend（零锚）+ 模块局部 require 形参重绑 + vscode API 表面包装 + 协议消息双向观察**。核心洞察不变：CC 内部控制流每版随机变（47 天 6 次漂移、2 次结构性断裂、MTBF≈10-12 天且三轴恶化），而 S1 协议字符串（0/38 版本漂移；wire 字面量 14/14 版本可定位）与 S2 vscode 公共 API 名（API 契约）是 minifier 物理上不可混淆的稳定面。

v2 相对 D1 的实质变化：
1. **ADR-1 落地**（blocker B）：seam 与 AST wire-literal 结构锚正面对比后裁决 seam 为主通路，AST 定为**预规格继任架构**（ESM 事件触发，规格先行落档、代码不预写）。
2. **绑定层与观察层显式分离**（HIGH#1）：`__ccsdSidToPanel` 仅收 WebviewPanel；sidebar/sessions view 永不入桥。
3. **遥测全规格**（HIGH#2）：seam-state-\<pid\>.json 分层心跳 + 端到端观察计数金丝雀 + 判定矩阵，canary 红永不 re-patch。
4. **Proxy 全删**（MED）：含 fallback；一切降级走"消息源/纯观察+degraded 记录"。
5. **字节级 banner 兼容**（MED）：`/*cc-status-dot-injected:vX.Y.Z:\<hex\>*/` 原格式不动，seam 身份移至 `/*ccsd2:begin*/` 行；版本协商两方向闭合。
6. **legacy 迁移能力保留**（MED）：v0.5.x banner 解析 + 锚 IIFE 剥离（3 形状）+ isExtensionPatched 语义；锚**注入**能力退役。
7. **跨进程 O_EXCL 锁**、**P2 四判 ESM 检测**、**serializer 双名 shim**（deserializeWebviewPanel 主名，D1 错名已修正）、**装饰 setter-shadow+tick 双机制抗竞态**、**`__ccsdSbi` 模块加载即发布**、**patcher stdout 机器可读失败类**。

---

## 1. D2 blocker 裁决表

| # | severity | blocker | 裁决 | 处置（落点） |
|---|---|---|---|---|
| 1 | HIGH | sidToPanel 桥语义被改写（sidebar WebviewView 会污染桥） | **接受** | §6.4 绑定/观察分层；迁移行为差异注记；测试闸门 G7 桥形状断言 |
| 2 | HIGH | 降级遥测欠规格（绿灯下静默灭灯风险） | **接受** | §7 心跳全规格 + 判定矩阵 + canary 红不 re-patch |
| 3 | MED | banner 加 `:seam` 击穿老 companion 正则 → re-patch 死循环 | **接受** | §5.2 banner 字节级保持原格式；§8 协商两方向闭合（含 config 原子刷新使老 companion 静默）；G1 skew 矩阵闸门 |
| 4 | MED | 锚注入态→seam 迁移恢复链（无 .bak 半死态） | **接受** | §5.5 保留 legacy 三能力（解析/剥离/判定语义）+ 剥离后重建 .bak 的顺序；G2 迁移 roundtrip |
| 5 | MED | 无跨进程锁，seam 恒成功写入后有痕交错 | **接受** | §5.4 O_EXCL 锁贯穿全程 |
| 6 | MED | require 包装须镜像 .resolve/.main/.cache；createRequire 副通道 g4 | **接受** | §6.2 getter 懒绑镜像；canary 为 g4 唯一防线写入契约；P3 静态计数告警 |
| 7 | MED | panel Proxy fallback 是身份地雷 | **接受** | §6.6 Proxy 全删；降级=消息源 title / 纯入站+degradedOutbound |
| 8 | MED | 新失败类 × v0.5.53 重试机交互未闭合 | **接受** | §8.2 stdout `ccsd-fail-class:` 行；precondition 类跳过重试+专属文案；重试期轻量状态栏；ring ≥10 带 pid |
| 9 | MED | ESM 检测不完整（.mjs/import 形态）；ESM 文案须是"等待新架构" | **接受** | §5.3 P2 四判 + `cc-esm-detected` 专属失败类 + 架构寿命边界诚实标注（§9） |
| 10 | MED | 锚路径全删无回退 | **接受（选项 b）** | §9 单通路 + canary 文案给操作路径；论证不留 legacy 开关（协议漂移时锚同样死，双通路只付语义税） |
| 11 | MED | `__ccsdSbi` 须模块加载即发布；订阅生命周期；回调 try/catch | **接受** | §6.7 三硬契约 |
| 12 | MED | [A] 漏 registerWebviewPanelSerializer | **部分反驳 + 实质修正** | D1 §4.2 已含 serializer 包装（反驳"漏掉"），但 D1 方法名 `resolveWebviewPanel` 是**错的**——【D2-验】1.136 vscode.d.ts:10219 与 CC 2.1.259 实现均为 `deserializeWebviewPanel`。错名 shim 会让 EH 调用不存在的方法 → 面板恢复直接炸。修正为双名 shim（§6.3）+ G6 闸门 |
| 13 | MED | [B] AST 结构锚 14/14 达标且免疫 seam 唯一实证死期（ESM），须正面 ADR | **接受（写 ADR）** | §2 ADR-1 正面对比，裁决 seam 主通路 + AST 继任架构预规格。理由核心：锚区是 CC 主动重写的热区（257 unread/multi-panel 产品线），AST 每次重写都是重新考试；seam 对热区结构性免疫且零 CC 内作用域执行 |
| 14 | MED | [A] 落地范围低估：四灯/token/QuickPick/notify/三命令/全部桥须随迁 | **接受** | §10 功能迁移清单 + 桥契约表 + post-verify 扩展断言 |
| 15 | MED | [A] 装饰时序/最后写者冲突（观察先于 CC 写；CC 257+ 原生写 iconPath） | **接受** | §6.6 setter shadow（原 setter→重装饰→防环标记）+ §H 500ms tick 兜底双机制；G5 运行时终验闸门 |
| 16 | MED | [A] Module._load 进程级全局污染 | **反驳（D1 已解决）** | D1 §4.1 本就否决 Module._load、主通路=模块局部 require 形参重绑（天然 100% 仅-CC 过滤）。B 计划保留时吸收 blocker 三防：parent.filename 前缀过滤 / 同 namespace memoize / 全透传 trap |
| 17 | MED（截断） | 上游原生趋同（已 shipped 蓝/橙 2 态、FR #34309 open） | **接受可见实质** | §11 上游趋同观察 + 残余价值定位 + 日落判据；原生图标竞态并入 §6.6 |

注：blocker 引文中的正则 `\d++` 为转写笔误，实测文件为 `\d+`（不影响其结论成立）；blocker 12 的方法名引用正确、我的 D1 反而错了——对抗阶段在此处净赚一个 CC 级 bug。

---

## 2. ADR-1：seam（表面观察）vs AST wire-literal 结构锚（blocker B 项正面裁决）

### 2.1 候选方案

**方案 S（seam，本设计主通路）**：零锚 prepend + require 形参重绑 + vscode API 表面包装 + 双向协议观察。锚定面 = S1（协议串）+ S2（vscode 公共 API）。

**方案 A（AST 结构锚）**：以 `.request.type==="update_session_state"` wire 字面量 + `.request` 属性链为键，AST 定位 enclosing arm，捕获分发参数标识符，在 arm 内注入捕获语句（IIFE 以参数注入，近似现行 replA/replB 的 `(function(t){})(this)` 形态）。锚定面 = S1 + JS 语法结构。独立 rig 实测（14 版历史 bundle + LIVE 259）：该键在 2.1.212→259 全部 14 版恰好命中 1 次，对全部 6 次漂移（含 257 结构断裂）0 失手，与锚 C 同属 14/14 稳定类。

### 2.2 对比矩阵

| 维度 | S（seam） | A（AST 锚） | 优势方 |
|---|---|---|---|
| 历史漂移免疫（更名/形状） | 0/38 协议漂移、表面包装与内部形状无关 | 14/14 实测（wire 字面量定位） | 平 |
| CC 扩展 ESM 化 | **结构性死亡**（1.136 EH 实证：ESM 路径 'vscode' 经 module.registerHooks 重定向 data-URI shim，Module._load 不参与；静态 import 先于任何 prelude 语句执行） | 存活（文本/AST 切片与模块格式无关） | A |
| 分发风格重构（如改表驱动 `handlers[request.type]`） | 存活（观察在 API 表面，不依赖内部分发形状） | **死亡**（`.request.type==="..."` 比较形态消失；放宽为"串任意出现+enclosing function"则歧义风险大增） | S |
| handler 迁出 extension.js 入口（code-splitting） | 部分-death（模块局部 require 重绑只覆盖入口模块；需 B 计划 Module._load 补） | death（入口 literal 计数=0，patch 时 fail-closed loud 失败） | 近平 |
| 协议重设计（消息更名/载荷重构） | 双亡（canary 当日警报） | 双亡（literal 前置条件失败） | 平 |
| 爆炸半径 | **零 CC 内作用域执行**——prelude 任何错误退化为原样透传，CC 永不因我们坏 | 注入在 CC 分发函数体内；try/catch 可包但每条 CC 重写都重新接触 CC 作用域 | S |
| 信号全集 | **双向**：入站全量 + 出站 shadow（user_dialog_request / tool_permission_request / session_states_update / unread）——pending 语义完整 | 单向（handler 内）；出站信号需再加锚（每加一个锚多一份漂移面） | S |
| 热区敏感度 | **免疫**——257 的 unread/multi-panel 重写、未来的原生状态点开发都不触及 API 表面 | 敏感——锚区就是 CC 正在主动重写的产品线（47 天 6 漂移全部发生于此；FR #34309 busy 指示若落地还会再改） | S |
| 迁移成本 | 高：整个 IIFE 运行时（§10 清单）迁入 prelude | 低：IIFE 功能体基本原样，仅入口改参数注入 | A |
| patcher 新依赖 | 无 | 需要 AST 解析器（vendored ~100KB 进零依赖 patcher）或手写结构匹配（新的脆弱面） | S |
| ESM 死亡时的 UX | **当日 loud**：P2 门 patch 时失败 + `cc-esm-detected` 专属文案"等待新架构"；gap=继任实现天数 | 无 gap（存活） | A |

### 2.3 裁决

**主通路 = seam。继任架构 = AST 结构锚（预规格、不预写）。**

理由（按权重）：
1. **热区 vs 冷区**：ESM 是单次、低频、有长跑道的事件（CC 现 CJS、esbuild 输出深度固化、`require("vscode")`×32；VSCode 扩展 ESM 支持仍在沉淀期）；而"锚区被 CC 主动重写"是**正在发生、每 1-2 版一次**的持续压力（257 即此产品线自身）。把可靠性押在被持续重写的面（A）不如押在契约面（S2）。A 的 14/14 是回溯考试；下一次产品功能（busy 指示/更多原生态）落地时它要再考一次，且每次考试的失败模式可能是"放宽定位器"带来的歧义注入——比 loud 失败更危险。
2. **爆炸半径**：seam 物理上不可能写坏 CC（零内部执行）；AST 注入体每版都在 CC 的新代码形状里重新就位。对一个补丁第三方扩展而言，"永不打断宿主"是架构级属性，不是工程细节。
3. **信号完备**：pending 语义的四个源里两个（consent 期的 user_dialog_request、session_states_update 调和）只在出站方向；AST 要拿到它们须复制锚点数（漂移面 ×N）。
4. **ESM 死期的代价被三重缓解**：(a) P2 门在 patch 时当日 loud 失败（不是静默灭灯）；(b) 继任架构规格预先落档（§2.4），实现日=触发日，gap 以天计；(c) 心跳 canary 同时是发现延迟上界（即使 CC 先改内部后改模块格式，观察计数归零即告警）。
5. **用户诉求语义**：用户明令"禁止逐版本追锚的打补丁式对应，要架构级更新免疫方案"。AST 无论多稳仍是"锚"家族（in-bundle 注入点随 CC 内部结构移动）；seam 是换架构。在技术对比不呈一边倒时（如上：S 胜 4 轴、A 胜 3 轴），诉求方向是合法 tiebreaker。

混合方案（AST 主 + prelude 仅观察）被否：它保留了我们正要逃离的 CC 内作用域执行与 AST 依赖，同时维护双机制——与 §9 不留 legacy 双通路的理由同构。

### 2.4 继任架构规格（落档 docs/，代码不预写）

触发条件（任一）：patcher P2 门报 `cc-esm-detected`；或 fleet 心跳显示 seam 运行时门大面积失败（envelopeFail 超阈 + 观察归零）且非协议漂移。
规格要点（实施时直接细化）：定位键 = `request.type==="update_session_state"` 属性链形态（兼容单双引号/`.request` 前缀变体）；前置条件 = 全文件恰好 1 命中（0 或 ≥2 均 fail-closed）；捕获 = enclosing arm 的分发参数标识符（AST 动态提取，不硬编码变量名）；注入体 = 全 try/catch 包裹、零 CC 作用域假设、banner 沿用 `/*cc-status-dot-injected:...*/` 字节级格式；剥离 = 注入区间确定删除 + roundtrip 闸门。farewell-frame 语义税与本设计 §6.4 相同规则。

---

## 3. 证据基线（浓缩，含 D1/D2 验证）

### 3.1 为什么必须换（F2 量化）
- 断裂实际发生在 2.1.257（2026-09-01）；zod 时代结构断裂基率 ≈8%/版本 × 每天 1-2 版自动更新。
- 漂移三轴恶化：发布节奏 0.74→1.09→2.0 版/天；结构断裂间隔 41→12 天；锚区形似度 0.336。
- 容错层对改名类 100% 吸收（5 波/15 版零维护），对形状类 0%；"再修一次"= 买 ~1.5 周稳定。

### 3.2 稳定面
- **S1 协议字符串**（14/14 版本零漂移）：webview→host 信封 `{type:'request',channelId,requestId,request:{type,...}}`；判别族 update_session_state / rename_tab / set_session_unread / update_panel_host_session / archive_session / unarchive_session / init；wire 字段 sessionId/state/title/hasPendingPermissions/hasUnseenCompletion/isPanelInitial/panelNoLongerHosts/isFarewell/idConfirmed/unread/sessionKey；state 枚举恰 3 值 idle/running/waiting_input。
- **S2 vscode 公共 API**（API 契约）：createWebviewPanel / registerWebviewViewProvider / **registerWebviewPanelSerializer（1.136 方法名 `deserializeWebviewPanel`，【D2-验】）** / webview.postMessage / onDidReceiveMessage / onDidChangeViewState / onDidDispose / onDidChangeVisibility；viewType 标识 claudeVSCodePanel / claudeVSCodeSidebar(-Secondary) / claudeVSCodeSessionsList（排除 claudePlanPreview）。
- **S3 半稳定 this 属性**：仅诊断参照，不承重。

### 3.3 平台事实（D1 验证 + D2 增补）
1. esbuild interop 帮助器 P 把 require("vscode") 属性复制为绑定源对象的**活 getter** + WeakMap 缓存 → CC 顶层别名每次属性访问都穿透我们的包装。
2. 全 bundle `require("vscode")` 恰 32 处、无 `import("vscode")`；二级通道 `g4=QM$.createRequire(__EXT_BUNDLE_URL)` 44 调用点（41 动态参数），今日全部 Node 内置/claude-cli/npm，无 vscode——但 P1 静态门对其永久失明，**运行时 canary（§7）是唯一防线（契约级）**。
3. CJS 确认：`main:"./extension.js"`、无 `type` 字段、bundle 头无 "use strict"。
4. VSCode EH 按 caller 路由 'vscode'（1.136 源码 nodeModuleName 工厂 + _extensionPaths.findSubstr）；require 形参重绑委托原始 require → 拿本扩展实例、零跨扩展泄漏。
5. WebviewPanel 实例未冻结；title/iconPath 为原型访问器（EH 实证 `set iconPath(t){this.#t!==t&&(this.#t=t,this.#i())}`）；EH 全文件 Object.seal 计 0、freeze 均为参数对象 → 实例级 defineProperty 可行、postMessage 不可 shadow 概率极低。
6. VSCode Emitter 有 per-listener try/catch（_deliver 兜底）——但我们仍不依赖宿主内部行为（§6.7）。
7. 集成点：RC3 = companion/extension.ts:1013 30s tick（:235 重入守卫）；post-verify = :783-809；MIN_PATCHER_VERSION="0.5.53"（:112）；companion 桥消费点 :1859/:2584/:2502-2545/:2858；`__ccsdSbi` 探针 :904/:952/:1077（注释明言锁步契约）。
8. CC 257+ 原生 applyTabIcon 写 panel.iconPath（claude-logo-pending/done.svg）——装饰竞态真实存在（§6.6）。

---

## 4. 目标架构总览（v2 修订）

```
┌─ L0 注入层   patcher: bundle 头部 prepend 自包含 prelude（零锚，永远成功）
│              + O_EXCL 跨进程锁 + legacy 迁移能力（v0.5.x 解析/剥离）
├─ L1 拦截层   prelude 重绑模块局部 require("vscode") → 包装 namespace
│              （镜像 .resolve/.main/.cache；不动 Module._load；不动 EH 路由）
├─ L2 表面层   包装 window.createWebviewPanel / registerWebviewViewProvider /
│              registerWebviewPanelSerializer（deserializeWebviewPanel 双名 shim）
│              → 捕获真实 WebviewPanel / WebviewView 对象
├─ L3 观察层   ① webview.onDidReceiveMessage 纯观察（入站全量，信封形状终判）
│              ② 实例级 defineProperty shadow: panel.title / panel.iconPath
│                 （记录+透传+重装饰）与 webview.postMessage（出站白名单）
│              【Proxy 全删——任何路径都不再使用 Proxy】
├─ L4 归约层   协议消息 → 五态机（wire 3 态 × hook 文件 done/interrupted × 四 pending 源合并）
│              ═══ 绑定层与观察层分离 ═══
│              绑定（__ccsdSidToPanel）仅 editor panel 家族；sidebar/sessions 仅观察
│              sid 解绑/迁移（panelNoLongerHosts/isFarewell/teleport）+ session_states_update 调和
├─ L5 装饰层   §A..§Z 全功能移植（§10 清单）：tab 点重断言 tick、4 灯 SBI、token SBI、
│              QuickPick、notify、三命令 —— 写入目标=我们持有的真实 panel 引用
├─ L6 桥层     __ccsdSidToPanel / __ccsdSidToTitle / __ccsdActiveSid / __ccsdLastActiveSid /
│              __ccsdSbi（模块加载即创建）/ __ccsdRate* / __ccsdPanelCount（语义与写时机不变）
└─ L7 遥测层   seam-state-<pid>.json 心跳（分层字段+观察计数金丝雀）← RC3 30s tick 聚合读取
               → 分级告警（静默通道 / 协议漂移 / 装饰失配）→ 降级 UX；canary 红永不 re-patch
```

设计原则：**CC 拿到的每一个对象都是真实对象**（仅 title/iconPath/postMessage 被实例级 shadow 记录/透传/重装饰）；观察者只读不拦截；任何 prelude 内部错误退化为"原样透传"；**Proxy 零使用**（身份地雷，MED#7 裁决）。

---

## 5. 注入机制（L0，硬要求 1）

### 5.1 prepend 位置与指令序（同 D1）
对 extension.js 原文头部扫描：跳过 BOM/空白/注释后若为字符串字面量指令序言（"use strict" 等），插入点=全部指令之后；否则字节 0（当前 2.1.259 为字节 0）。prelude 形态（v2 修订 banner 分层）：

```
/*cc-status-dot-injected:v0.6.0:<hash8>*/
;/*ccsd2:begin:seam:v0.6.0*/
(function(){ ... })();
/*ccsd2:end*/
```

- **第 1 行 banner 与现行格式字节级一致**（`/*` + marker + `:v` + semver + `:` + 4-16 位 hex + `*/`）——companion:501 正则【D2-验】`(?::[0-9a-f]{4,16})?\*` 完整解析，**版本区段后不得追加任何字符**。
- seam 身份（`seam` 标识、prelude 版本）放第 2 行 `/*ccsd2:begin:seam:vX.Y.Z*/`，仅供新 patcher/companion 识别，老代码不读。
- 以 `;` 开头防 ASI；全自包含；末尾换行保证后续 `var __EXT_BUNDLE_URL` 独立成句。
- revert/strip = 剥除第 1 行 banner + ccsd2:begin..end 区间（确定区间，按构造零歧义，接现有 strip-roundtrip 闸门）。

### 5.2 marker 兼容
banner 保留裸子串 `cc-status-dot-injected`（companion 检测 :164 与 post-verify :783-809 的 grep 语义不变）→ 检测/复查代码零改动；`injectedVersion/injectedIifeHash/currentIifeHash` 机制原样平移（hash = sha1(prelude body)[:STAMP_HASH_LEN]）。

### 5.3 patcher 流程（含锁与前置条件）
1. **acquire 锁**（§5.4）。
2. discoverExtension → 读 extension.js。
3. **静态前置条件（fail-closed）**：
   - **P1**：`require("vscode")`（双引号形）出现 ≥1 次；同时统计 `createRequire(` 出现次数，>0 则写 warning 日志"二级 require 通道在场（n 处），运行时 canary 为探测器"（P3，仅告警）。
   - **P2 四判**（任一命中 → 失败类）：① 文件扩展名 `.mjs`；② package.json `type:"module"`；③ 文件头部（指令序言后）存在顶层 `export ` 语句；④ 同区域存在顶层 `import ` 语句（ESM 苗头早期预警，同时上报维护渠道）。细分失败类：④（或 ①+②）命中 → `cc-esm-detected`；其余 P1/P2 不满足 → `seam-precondition-failed`。
   - 失败时**不写盘、exit 1、stderr 人话 + stdout 机器行 `ccsd-fail-class:<class>`**（§8.2）。
4. 幂等：当前版本+hash 的 ccsd2 区间在场 → no-op exit 0。
5. 陈旧处理（三态）：
   - 旧 seam prelude（v0.6.x 早期）在场 → .bak 在则还原原件再重注入；无 .bak 则剥除 ccsd2 区间后以剥离产物重建 .bak（backupOnce 语义：.bak 只写一次、绝不覆盖）再注入。
   - **v0.5.x 锚注入态（迁移路径，MED#4）**：用 legacy 正则族解析老 banner 版本+hash（与 companion :501 同族）；.bak 在 → 还原原件 → prepend；.bak 缺失 → **stripLegacyIifeInPlace**（原样保留 patch.ts:3270-3283 的 segA_block/segA/segB 三形状剥离器及其后继吸收语义）→ 以剥离产物重建 .bak → prepend。isExtensionPatched 判定语义不变（marker 子串 grep）。
   - marker 在但两种解析都失败 → `stale-unknown-format` 失败类（不写盘，人工介入文案）。
6. backupOnce → 按 §5.1 插入 → **node --check 语法闸**（assertCompiles 原样）→ writeAtomicSync 原子落盘 → 写 last-repatch。
7. **release 锁**。失败零足迹纪律不变（"no half-written file, no .bak"）。

### 5.4 跨进程锁（MED#5）
- 锁文件 `<extension.js>.ccsd.lock`，`fs.openSync(..., 'wx')` O_EXCL 创建，内容 `{pid, ts}`。
- 持锁覆盖 读→判→备份→注入→语法闸→落盘→last-repatch 全程。
- 争用：第二进程读锁存在 → 检查锁 stat 年龄，<60s → **exit 0**（"另一进程正在打补丁"，非失败、不计入重试）；≥60s 视为陈旧（写者被 SIGKILL）→ 删除重建抢占。
- finally 释放；进程异常退出的残留由 60s 陈旧判定回收。

### 5.5 与现有机器衔接
- RC3 30s tick（companion:1013）增加 `readSeamState()`（§7 聚合），享受 :235 重入守卫；检测→重试→post-verify 主循环不动。
- v0.5.53 重试机：按 stdout fail-class 分流（§8.2），退避公式/静默至耗尽/toast 门控不变。seam 装好后 patch exit 0 + marker 在 = 成功，重试机无事可做。
- **运行时集完整性（MED#3）**：companion VSIX 内嵌与自身版本同源的**完整运行时集**（dist/patch.js + resources/ SVG 全集 + companion-config.json 模板）；activate 时若 `config.patcherVersion < MIN_PATCHER_VERSION` → 自动复制刷新，**复制为原子集替换且逐项版本取 max**（禁止盲覆盖：npx 先行装的 0.6.1 不被 VSIX 内嵌 0.6.0 降级；config.patcherVersion 跟随实际写入的最高版本），消灭"VSIX 升级而 INSTALL_DIR 仍旧锚"与"图标资源缺失"两类断链。
- 心跳目录：patch 时将 INSTALL_DIR 绝对路径烘焙进 prelude 常量（我方配置，非锚）。

---

## 6. seam 数据流（硬要求 2）

### 6.1 L1 拦截：require 形参重绑（主通路，维持 D1）
```js
var __ccsdRawRequire = require;
var __ccsdVsCache = new WeakMap();
function __ccsdWrapVs(ns){ /* 仅包装 window 子命名空间; 其余属性活 getter 透传; memoize */ }
try {
  require = function(id){ var m = __ccsdRawRequire(id);
    if (id === "vscode") try { return __ccsdWrapVs(m); } catch(_) { return m; }
    return m; };
  // 镜像三属性（MED#6a）：裸函数会让未来 CC 的 require.resolve/main/cache 调用 TypeError
  Object.defineProperties(require, {
    resolve: { get: function(){ return __ccsdRawRequire.resolve; }, configurable: true },
    main:    { get: function(){ return __ccsdRawRequire.main; },    configurable: true },
    cache:   { get: function(){ return __ccsdRawRequire.cache; },   configurable: true } });
} catch(_) { /* 形参重绑失败=完全退化, CC 不受影响; 心跳记 degraded.requireRebind */ }
```
- 不用 Module._load（进程全局、泄漏同 EH 其它扩展）；B 计划（仅当 R1 类调查确认必要，如 CC 改用 createRequire 自造 require 拉 vscode）：`Module._load` 链式包装 + caller 判定 `parent.filename.startsWith(__dirname)` 仅 CC 目录放行 + 同 namespace memoize（`require("vscode")===require("vscode")` 恒真）+ Proxy 级全透传 trap 仅限此 B 计划内的 namespace 包装——**永不用于 panel/webview 实例**（MED#16 三防吸收进 B 计划规格）。
- 自我引用：prelude 自身一律走 `__ccsdRawRequire`（含心跳写文件的 `__ccsdRawRequire("node:fs")`，与重绑成败解耦）。
- g4 副通道：静态 P3 告警 + 运行时 canary 契约兜底（§7）。

### 6.2 L2 表面包装（window 三函数 + 双名 serializer）
- `createWebviewPanel(viewType,...)`：调原函数 → `armSurface(panel, viewType, "panel")` → 返回真实 panel。
- `registerWebviewViewProvider(viewId, provider, opts)`：shim.resolveWebviewView 先 `armSurface(view, viewId, "view")` 再委托原 provider（shim 原型链挂 provider 透传其余成员）。
- **`registerWebviewPanelSerializer(viewType, serializer)`（reload/重启恢复路径，MED#12）**：shim 上**双名齐备**——主名 `deserializeWebviewPanel(panel, state)`（【D2-验】1.136 API 与 CC 2.1.259 实现名）+ 别名 `resolveWebviewPanel`（旧版 VSCode/前向兼容，委托给原 serializer 上实际存在的方法）。两个名字都先 `armSurface(panel, viewType, "restore")` 再调原方法。恢复面板不经过 createWebviewPanel——不包此处则"patch 后 reload 灯灭"（companion 全套提示 reload，用户第一天就撞）。
- **三重"仅 CC"门**：①require 形参重绑（本 bundle 词法作用域）；②viewType/viewId 白名单 `claudeVSCodePanel`（前缀匹配容忍后缀变体）/`claudeVSCodeSidebar`/`claudeVSCodeSidebarSecondary`/`claudeVSCodeSessionsList`，排除 `claudePlanPreview`；③信封形状终判（§6.3）。三层全过才激活装饰；任何一层不过=纯观察零装饰。

### 6.3 L3 观察与信封终判
**入站（webview→host）**：armSurface 立即用原始 `webview.onDidReceiveMessage(cb)` 注册（先于 CC 注册，但正确性不依赖次序——VSCode Event 多播、彼此独立）。回调纪律：首行 try/catch 包整个函数体（§6.7）；信封终判 `{type, channelId?, requestId?, request:{type}}` 不过则 envelopeFail 计数 + 早退；按 request.type 分发到 L4（update_session_state / rename_tab / set_session_unread / update_panel_host_session；default 计数不处理）。**每个消息类型独立计数**喂心跳（§7 金丝雀数据源）。

**出站（host→webview）**：`user_dialog_request`（consent/refusal 期间 state 与 hasPendingPermissions 均为 false——旧锚 C 唯一等价源）、`tool_permission_request`、`session_states_update` 只在 postMessage 方向 → 实例级 defineProperty shadow webview.postMessage：函数体第一行 2-3 次属性读早退（白名单 3 值外原样 `d.value.apply`，热路径 io_message 每 token 一帧不订阅不解析），命中白名单才调 onOutbound 并透传。**shadow 失败（descriptor 不可配置——实测概率极低）→ 降级为纯入站观察 + 心跳 `degraded.outboundShadow=true`，不引入任何 Proxy**（MED#7）。

### 6.4 L4 归约：绑定层与观察层分离（HIGH#1 裁决核心）

**表面分类**（armSurface 时按来源+viewType 标定，终身不变）：
- **panel 家族**（"panel" via createWebviewPanel ＋ "restore" via serializer，viewType=claudeVSCodePanel*）：可绑定、可装饰。
- **view 家族**（"view"，sidebar/sessions-list）：**仅观察，永不入桥、永不装饰**（CC 对 sidebar panelTab=undefined 不改名，与现行行为一致）。

**绑定规则（仅 panel 家族）**：
- `update_session_state` 到达的 panel 家族 surface ⇒ `sidToPanel[sid]=panel`（同 sid 多 panel 存 Set，最新者主装饰）；**view 家族到达同消息只更新 state/title，绝不写桥**。
- `{panelNoLongerHosts:true}` / `{isFarewell:true}` ⇒ 解绑该 surface 的 sid（farewell 帧不 stash——257 已破坏旧"块首无条件 stash"语义，此为再锚定路线做不到的语义修正）。
- `update_panel_host_session`（teleport_resolved/abandoned/restore_declined）⇒ 跨 panel 迁移绑定。
- `onDidDispose` ⇒ 清理该 surface 全部状态（panel 计数递减、末 panel 撤 SBI，§Z 等价）。
- `session_states_update.openSessionIds`（出站聚合帧）⇒ 权威并集调和防泄漏条目。
- **迁移行为差异注记**：旧 IIFE（patch.ts:2062【D2-验】）在 sidebar host 上会写 `sidToPanel[sid]=undefined`（可能覆盖同 sid 的合法 panel 绑定）；新规则"非 panel 不写"严格更优—— Bridges 中永无 undefined/WebviewView 条目。已列入迁移验收。
- `set_session_unread` 的 sessionKey 为 `remote:` 前缀 sid——仅观察计数，不改行为（unread 徽章由 CC 原生承担）。

**五态合并表**（优先级沿用 STATES.md：pending 蓝 > interrupted 红闪 > running 黄 > done 绿 > idle 灰）：

| 输入源 | 通道 | 贡献 |
|---|---|---|
| update_session_state.state ∈ {idle,running,waiting_input} | 入站 | waiting_input→pending 源；running/idle 直映射 |
| ~/.claude/cc-tab-status/\<sid\>.json | hook 文件（不变） | done/interrupted（wire 无此二态，终态唯一源）+ tokens |
| rename_tab.hasPendingPermissions | 入站 | pending 源（旧锚 B 等价） |
| user_dialog_request 活跃期 | 出站 shadow | pending 源（旧锚 C 等价） |
| tool_permission_request | 出站 shadow | pending 源（新增，粒度更细） |

**title 三源**：panel.title shadow 记录（显示名）＋ rename_tab.title（webview 截 24 字符版）＋ update_session_state.title（zod 截 200 前 wire 原值）。桥 `__ccsdSidToTitle` 写时机=消息观察到即写（等价旧"handler 层同步写、守卫前"纪律，v0.5.44 BUG 修复语义保留）；view 家族消息同样可更新 title 桥（title 是字符串，无 panel 形状假设）。

### 6.5 active 态
`panel.onDidChangeViewState`（公共 API，armSurface 时订阅）＋ `session_states_update.activeSessionId` 调和 → `__ccsdActiveSid`/`__ccsdLastActiveSid`（token SBI readTok 依赖，§A 语义保留，含 `__switching__` 哨兵）。

### 6.6 L5 装饰：setter shadow + tick 双机制抗竞态（MED#15）
**问题**：seam 观察者在 onDidReceiveMessage 层先于 CC 的 processRequest 链收到消息——同步装饰会被 CC 随后的 `panelTab.title=$.request.title` 与 applyTabIcon 覆盖（257+ 原生写 iconPath）。
**机制 1（快路径）——实例级 defineProperty shadow，记录+透传+重装饰**：
```js
function shadowAccessor(obj, prop, onAfterOriginalSet){
  var proto = Object.getPrototypeOf(obj);
  var d = Object.getOwnPropertyDescriptor(obj, prop) ||
          Object.getOwnPropertyDescriptor(proto, prop);
  if (!d || !d.set || !d.configurable) return false;   // 不可配置 → 降级, 不 Proxy
  Object.defineProperty(obj, prop, {
    get: function(){ return d.get.call(obj); },
    set: function(v){ d.set.call(obj, v);              // 先让 CC 的写原样落地
      try { onAfterOriginalSet(prop, v); } catch(_){} }, // 再触发我方重装饰(走 d.set 直写, 绕过本 shadow → 防环)
    configurable: true });
  return true; }
```
- **iconPath**：onAfterOriginalSet = 用缓存的点图标 Uri 直调 `d.set`（Uri 相等性去重防抖，复用 patch.ts:2086-2102 的引用去重缓存）→ 我方总是最后写者（与现行生产行为一致，只是从"≤500ms tick 追平"提速为即时）。
- **title**：记录 baseTitle + 原样透传（零闪烁、零改名竞态）；仅当产品配置要求装饰文本时才 `d.set(decorate(v))`（compare baseTitle 防环）。
- **机制 2（兜底）**：§H per-panel 500ms tick 重断言保留——现行生产已证轮询能胜 CC 的 applyTabIcon；两机制共存，tick 是正确性兜底、shadow 是延迟优化。
- shadow 失败 → 降级为消息源 title（功能等价、零身份风险）+ tick 独扛装饰 + 心跳 `degraded.titleShadow=true`。**Proxy 零使用**。

### 6.7 三硬契约（MED#11）
1. **`__ccsdSbi` 于 prelude 初始化段同步创建**（模块加载即、早于任何面板/companion 探针——companion:1077 跨窗口 reload 抑制探针只查 `!== undefined`，零项 SBI 即合法）。
2. **所有订阅纳入 per-surface disposables**（onDidReceiveMessage / onDidChangeViewState / onDidDispose / shadow 生命周期标记），onDidDispose 统一清理——多面板生命周期零监听器泄漏。
3. **一切观察回调首行 try/catch 包整个函数体**（含 postMessage shadow 的属性读段）——不依赖 VSCode Emitter 的 per-listener 兜底，避免逐消息错误日志刷屏。

---

## 7. 遥测与降级规格（L7，HIGH#2 裁决全文）

### 7.1 心跳文件
- 路径：`<INSTALL_DIR>/seam-state-<pid>.json`（pid=本 EH 进程；多窗口=多 EH=多文件，天然隔离）。
- 写者：prelude（用 `__ccsdRawRequire("node:fs")`，与 require 重绑成败解耦）；触发=状态变化 + 至多 30s 节流刷新。
- 读者：companion RC3 30s tick `readSeamState()` 聚合全部 `seam-state-*.json`；pid 存活探测（`process.kill(pid,0)` 包 try）或 mtime<5min 判活；>24h 残留文件由读者 GC。

### 7.2 字段分层
```json
{
  "v": "0.6.0", "pid": 12345, "bootTs": 1693700000000, "writtenTs": 1693700600000,
  "surfaces": { "panel": 2, "sidebar": false, "sessionsList": false },
  "armed": 3, "envelopeFail": 0,
  "obs": { "update_session_state": 42, "rename_tab": 7, "set_session_unread": 0,
           "update_panel_host_session": 0, "session_states_update": 15,
           "outboundFiltered": 0 },
  "deco": { "sbiCreated": true, "titleShadowOk": 2, "iconAsserts": 38, "lastIconAssertTs": 1693700595000 },
  "degraded": { "requireRebind": false, "outboundShadow": false, "titleShadow": false },
  "lastMsgTs": 1693700590000
}
```
语义分层：prelude 活（v/pid）→ 表面活（surfaces/armed）→ **通道活（obs 按类型计数——端到端金丝雀：从 webview 消息到我们观察回调的整链路证明）**→ 装饰活（deco 断言计数随 obs 增长）→ 降级旗标（degraded）。

### 7.3 判定矩阵（companion 侧，RC3 tick 内执行）
| 条件 | 判定 | 动作 |
|---|---|---|
| 任一活文件 obs.update_session_state>0 且窗口内增长 | 健康 | 无 |
| 活文件 armed==0 且 hook 状态目录无近 5min 会话 | 未开面板 | 无（宽限态，不告警） |
| hook 状态目录有活跃会话（≥1 \<sid\>.json mtime<5min）且全部活文件 obs 总数为 0 且距本 companion activate >10min 宽限 | **观察通道静默**（含 g4 逃逸/ESM 内部漂移/信封变更的统一表现） | **一次性**状态栏+日志告警"状态点观察通道静默——CC 可能已变更内部通道，等待 companion 更新"；**永不触发 re-patch**；每会话最多一次，不循环 |
| envelopeFail ≥10 或 obs 曾>0 后归零 >10min（hook 仍活跃） | **协议漂移（canary 红）** | 告警"CC 协议漂移，等待更新"（§9 文案）；**永不 re-patch**（re-patch 对协议漂移无意义且烧 toast 配额误导） |
| obs 增长但 deco.iconAsserts 恒 0 且 surfaces.panel>0 | 装饰链静默失败 | 告警一次 + 心跳供诊断（titleShadow/iconPath shadow 失配或 tick 故障） |
| degraded.* 任一 true | 降级运行 | 状态栏 tooltip 透出（不打扰） |

canary 同时是 g4 副通道（§6.1）与 ESM 内部苗头的发现延迟上界——设计契约：**静态门失明的逃逸路径，一律由观察计数金丝雀兜底**。

---

## 8. companion 协商、重试机与版本 skew（MED#3/#8）

### 8.1 版本协商两方向闭合
设 WANT=companion 期待的注入版本（源=INSTALL_DIR companion-config.json injectVersion，:468-470）；FILE=banner 解析版本（:501 正则，banner 格式字节级保留故两代 companion 都能解析）。

| 场景 | WANT | FILE | 结果 |
|---|---|---|---|
| 老 companion 0.5.53 驻留 + npx 0.6.0 先行 | npx 原子刷新 config → WANT=0.6.0 | v0.6.0 | **fresh → 老 companion 静默**（不再 spawn 老 patcher；MIN_PATCHER_VERSION 检查 0.6.0>0.5.53 仅通过）。config 原子刷新是闭合关键——banner 兼容 + config 同步升版双管齐下 |
| 新 companion 0.6.0 + INSTALL_DIR 仍旧 0.5.x | 自动复制完整运行时集（§5.5，逐项版本取 max）→ WANT=0.6.0 | v0.6.0 | fresh |
| 新 companion + npx 更高版（0.6.1）已装 | 版本取 max 不降级覆盖 | v0.6.1 | fresh，无 hash-mismatch 连锁 |
| 残余：老 companion + 老 config 未被刷新（用户只拷了 patch.js） | 0.5.53 | v0.6.0 | stale → 老 patcher restore+老锚失败（fail-closed 零足迹，CC 健康）→ 5 次重试耗尽 → 静默 | 此为非法安装路径，post-verify stale-forever 探测器（下）会浮出提示 |

**post-verify 扩展**：现有只判 `==="absent"`（:784）之外，增加 stale-forever 探测——连续 3 次 activate 后状态仍 stale 且版本无变化 → 一次性提示"版本协商死锁，请完整重装（npx 或 VSIX 二选一完整执行）"。

### 8.2 重试机与新失败类
- **patcher 契约**：失败 = exit 1 + stderr 人类可读（retryComposeDetail 拼接依赖）+ **stdout 机器行 `ccsd-fail-class:<class>`**。类：`seam-precondition-failed` / `cc-esm-detected` / `stale-unknown-format` / 既有运行时类。
- companion 解析 fail-class：
  - `cc-esm-detected` → attempts 直接置 MAX（**跳过全部重试**——静态确定性失败重试无意义）+ 专属文案"**CC 扩展已改为 ESM 架构：状态点需要新版注入架构，正在等待更新——手动重跑 patcher 无效**"。
  - `seam-precondition-failed` / `stale-unknown-format` → 同上跳过重试 + 文案"CC 架构发生变化，patcher 需要更新；手动重跑无效"。
  - 运行时类 → 维持 5 次指数退避 + a5 toast。
- **重试窗口可见性**：重试进行中挂轻量状态栏项 `cc-status-dot: 正在重试注入 (n/5)`（填 F3 指出的静默窗口）。
- last-failure ring 缓冲扩容 ≥10 条，每条带 pid + EH 标识（F3 建议，正式立项）。

---

## 9. 回退策略与架构寿命边界（MED#10/#9 裁决）

**单通路，无 legacy 锚开关（选项 b）**。理由：
1. 协议级漂移（消息更名/载荷重构）发生时，**锚路径同样死**——旧锚掏的就是协议载荷本身；留 legacy 开关换不回任何场景，只付 F1-REFIX-SURVIVAL 的语义税（两套注入语义、farewell 帧两套处理、双倍测试矩阵）。
2. seam 特定失败（个别机器运行时门不过）由 §7 判定矩阵细分呈现，文案给出操作路径：
   - 观察通道静默 / 协议漂移 → "等待 companion 更新"（不 re-patch、不误导）。
   - 环境级降级（degraded 旗标）→ tooltip 透出 + 心跳数据供 issue 诊断。
   - 彻底回退 = companion 卸载/uninstall 现有 strip 流程（§5.1 区间剥除 + legacy 剥离器，双向可逆）。
3. `cc-esm-detected` 是**架构寿命边界，非可修复事件**：ESM 下扩展内 loader 钩子无解（1.136 EH 实证）。文案必须是"等待新架构（继任方案已预研）"，且 ADR-1 §2.4 的继任规格已落档——触发日=实现日，gap 以天计。P1 扫描同时上报 ESM 苗头（顶层 import 语句特征）给维护渠道，争取更早启动。

---

## 10. IIFE 功能迁移清单与桥契约表（MED#14，迁移验收 checklist）

**范围澄清**：companion 对 favorites/archive 走文件直读（favorites.json + \<sid\>.json，FAV_STATE_DIR）不依赖 IIFE；但以下全部依赖——一项不迁即静默缺失。prelude 内逐项端口，§10 即验收 checklist。

### 10.1 桥契约表（globalThis 名 = companion 硬耦合锁步契约）

| 桥/全局 | 写者 | 读者（companion） | 语义要点 |
|---|---|---|---|
| `__ccsdSbi` | prelude 初始化段同步创建；4 灯聚合 | :904/:952/:1077（探针 `!== undefined` 抑制跨窗口 reload 提示） | **模块加载即建**（§6.7-1）；改名须 lockstep 更新探针（companion 注释明示） |
| `__ccsdSidToPanel` | L4 绑定层（仅 panel 家族） | :1859/:1863/:2858（按 `{active?:boolean}` 消费；消费方调 .reveal()） | **值恒为 WebviewPanel 形状**（有 active/viewColumn/reveal）；view 家族永不写入；旧版 sidebar 写 undefined 的行为废除（迁移差异注记 §6.4） |
| `__ccsdSidToTitle` | L4（消息观察到即写）＋tick 刷新 | :2584/:2630（favToggleTab 右键后台 tab 解析） | 字符串值，panel 无关 |
| `__ccsdActiveSid` / `__ccsdLastActiveSid` | onDidChangeViewState + session_states_update 调和 | :2502-2545（token SBI readTok） | 含 `__switching__` 哨兵语义 |
| `__ccsdRate*` 速率采样族 / `__ccsdPanelCount` | prelude §E/§A 等价段 | 遥测/诊断 | 语义与写时机不变 |

### 10.2 功能迁移清单（§A..§Z → prelude 段）

| 现功能 | 旧信号源/入口 | 新信号源 | 出口 |
|---|---|---|---|
| §A 前导：requires/panel 计数/桥初始化 | replA/replB `(function(t){})(this)`, `t.panelTab`,`t.__ccsdSid` | prelude 模块加载即初始化；panel 由 L2 捕获；sid 由 L4 绑定 | 同名桥（零改动消费） |
| §B dispatchNotify/notify | hook 文件状态变迁 | 不变（hook 文件） | 同 |
| §C 4 灯聚合 SBI | hook 文件聚合 | 不变 + wire state 直通（waiting_input 计 pending 灯） | `__ccsdSbi` |
| §D/§E token SBI / QuickPick | \<sid\>.tokens.json / .offset / transcript | 不变（纯文件通道） | 同 |
| §F per-tick 聚合（500ms） | tick 扫描 | 不变（**装饰兜底机制保留**，§6.6） | 同 |
| §G 焦点切换即时刷新 | onDidChangeViewState 事件驱动 | 同（公共 API 直订） | `__ccsdActiveSid` 等 |
| §H per-panel 点图标重断言 tick + iconPath Uri 缓存 | tick + 引用去重缓存（:2086-2102） | 不变 + setter shadow 快路径（§6.6） | panel.iconPath |
| 通知去重 | IIFE | 原样端口 | 同 |
| 三命令 `ccStatusDot.sbiClick` / `.tokClick` / `.fav.focusSession`（patch.ts:697/:721/:745） | IIFE registerCommand | prelude 原样端口 | commands |
| §Z onDidChangeViewState 清理 | panel 计数递减、末 panel 撤 SBI | 同 + per-surface disposables 统一清理（§6.7-2） | 同 |

### 10.3 post-verify 扩展
注入后 companion 侧探针断言：`__ccsdSbi !== undefined` 且三命令 `getCommands` 可见且 `__ccsdSidToPanel` 为 Object.create(null) 形状——失败类 `post-verify-bridge-absent`（伴随后续 tick 重试）。prelude 侧自检同步写 `deco.sbiCreated` 入心跳。

---

## 11. 上游趋同观察（截断 blocker 可见实质）

事实：官方已原生 shipped 2/5 态（蓝=pending、橙=done 点缀 spark 图标；bundle 实证 claude-logo-pending/done.svg + applyTabIcon；官方文档明载）；FR #34309（busy 指示）open；257 的锚区大改（unread/multi-panel）正是该产品线本身。
含义与对策：
1. **估值折算**："seam 一劳永逸"的收益窗口受上游覆盖进度约束。本设计的 ADR-1 论证（热区免疫）反而因上游持续开发而增强——上游每版都在重写内部，正是文本/AST 锚的死亡压力来源。
2. **残余价值定位**：5 态 vs 原生 2 态（interrupted 红闪/done 语义差异）、token SBI、QuickPick、notify、favorites/archive UI、hook 文件通道——在原生覆盖 ≥4/5 态且 FR #34309 落地前，本项目价值成立。
3. **日落判据**：上游原生状态覆盖达到核心功能（4/5 态 + busy）时，发起 sunset 评审（README 引导用户转原生）。人工盯 CC release notes；是否自动化（发版 notes 关键词监控）列入 openQuestions。
4. **原生图标竞态**：由 §6.6 双机制处理（setter shadow 即时胜出 + tick 持久胜出），非新增风险。

---

## 12. 测试闸门清单（hooks/，实施阶段落地）

| # | 闸门 | 内容 |
|---|---|---|
| G1 | banner skew 矩阵 | 老 companion 正则（:501 原文）× 新 banner（v0.6.0:hash8 / hash16 / 无 hash）× 老 banner（v0.5.x）全部 fresh-parse 通过；`:seam` 类变体必须不出现（负例钉死） |
| G2 | 锚注入态→seam 迁移 roundtrip | 用 2.1.252 原件 + patch.ts 旧锚逻辑构造锚注入输入（含 3 stash 形状）→ seam patcher（.bak 在/缺两路）→ strip → 与原扩展等价；无 .bak 路径 .bak 重建语义断言 |
| G3 | prelude 语法/指令序 | node --check；"use strict" 前置 fixture（构造带指令头的假 bundle）插入点正确；strip 幂等 |
| G4 | P2 四判 fixtures | .mjs / type:module / 顶层 export / 顶层 import / 正常 CJS 五类样本 → 对应失败类/通过 |
| G5 | 装饰防环与最后写者 | shadow setter 单测：CC 写→原 setter 落地→我方重装饰→再断言无循环；tick+shadow 共存；shadow 不可配置降级路径（**运行时终验在 mktemp 快照 + 独立 VSCode 实例执行，本阶段只读未跑**） |
| G6 | serializer 双名 shim | deserializeWebviewPanel 主路径（1.136 API 名）+ resolveWebviewPanel 别名委托 + 原对象无方法时的安全行为 |
| G7 | 桥类型断言 | `__ccsdSidToPanel` 条目形状断言（有 onDidChangeViewState && viewColumn，即 WebviewPanel）；view 家族消息后桥无新增/无 undefined 条目（钉死 HIGH#1） |
| G8 | 锁争用 | 双进程并发 spawn patch.js：一胜一 exit 0；60s 陈旧抢占；写者 SIGKILL 残锁回收 |
| G9 | canary 判定矩阵 | 模拟心跳文件组合（活/死 pid、obs 零/正、envelopeFail 阈值、degraded 旗标）→ companion 判定输出与一次性告警语义 |
| G10 | require 镜像 | 包装函数 .resolve/.main/.cache 存在且委托原值；重绑失败退化路径心跳旗标 |
| G11 | 版本协商矩阵 | §8.1 全表场景自动化（config 原子刷新、版本取 max、stale-forever 探测） |
| G12 | 现有闸门 | test-version-sync / test-transcode-args 等既有闸门继续全绿；strip-roundtrip 扩展 ccsd2 区间 |

---

## 13. Notes（LOW/次要）

- blocker 3 引文的 `\d++` 为转写笔误（实测 `\d+`），不影响结论。
- blocker 12 揭示 D1 错名（resolveWebviewPanel）；正确名来自本机 vscode.d.ts:10219 与 CC 2.1.259 实现双源确认。
- 心跳节流 30s 与 RC3 tick 30s 同频即可，无需更密；写放大可忽略（小 JSON、同目录）。
- sidebar 观察消息是否驱动 sidToTitle 高频更新——实施时按消息量决定节流（openQuestion）。
- `stale-unknown-format` 的极端场景（第三方注入了同名 marker）概率可忽略，fail-closed 人工文案足够。
- 心跳文件 GC 的跨重启残留已由 24h 规则覆盖；无需 EH 退出钩子。

---

## 14. 实施阶段划分（建议）

- **P0**：ADR-1 + 继任架构规格落档 docs/（先行，锁决策可追溯）。
- **P1**：prelude 骨架（L1-L4 + 心跳最小集）+ patcher seam 路径（锁/P1-P3/legacy 迁移/banner）+ G1-G4/G8/G10/G12 闸门。
- **P2**：L5/L6 全功能端口（§10 清单）+ G5-G7/G11 + post-verify 扩展。
- **P3**：companion 协商/重试机/fail-class 分流/重试状态栏 + G9。
- **P4**：mktemp 快照 + 独立 VSCode 实例运行时终验（G5 运行时部分 + 端到端灯亮）→ 分阶段发布（先 npx 后 VSIX）。
- 里程碑门：P4 未过运行时终验不发布。