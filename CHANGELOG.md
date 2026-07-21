# Changelog

本项目的显著变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [0.2.9] - 2026-07-21

**修 /compact 误显红球（Q4）+ 三项证据驱动的性能 hygiene（Q5）。** Q4：用户报告 /compact 在长会话上短暂显红球且计入底部 🔴 SBI；调研定位 `/compact` 中止 in-flight turn 触发 StopFailure（唯一 interrupted writer）→ Q2 的 preserveInterrupted 让红 sticky 直到下个 UserPromptSubmit。Q5：四轮调研（CC 源码 + 项目代码 + 真实 fixture 实测）给出"插件本身不会卡 VSCode"的证据驱动结论，并修了 3 个测得的真实浪费点（~10 IPC/sec + 1.1ms/tick）。

### Q4 — Fixed

- **HIGH /compact 误显红球**（用户实报 e434c0a2 session）：根因不是 Stop/其他事件写 interrupted（验证过——`case StopFailure` 是唯一 interrupted writer），而是 `/compact` 流程的"compact 完成、会话继续"信号被静默丢弃：(a) `HOOK_EVENTS` 缺 `PostCompact`/`SessionStart`-compact（settings.json 不接线，hook 永不收到）；(b) `deriveStatus` 无对应 case（default 返回 null 不写）。/compact 中止 in-flight turn → CC 发 StopFailure → 写 interrupted → Q2 preserveInterrupted 保持 sticky → 红球持续到下个 UserPromptSubmit。修复：HOOK_EVENTS 加入 `PostCompact`（10 个事件），deriveStatus 加 `case 'PostCompact'`：仅当 `cur.state === 'interrupted'` 时清 → `done` + 清 error/pending；否则 no-op（return null，running/done/pending 一律保留）。SessionStart 仍未接（audit F-5 intact；PostCompact 单独覆盖 /compact 路径下所有 CC 版本）。
- **风险闭环**：真 StopFailure（rate_limit/overloaded）未被 PostCompact 跟随 → 不变（Q2 7d sticky 保留）。/compact 瞬态最多 1 reader tick（500ms）的红闪（StopFailure 写入到 PostCompact 清除之间）；优于 v0.2.8 的"红到下个 prompt"（常达数分钟）。pinned by test-cc-status.js §Q.1-4（4 用例）。

### Q5 — Changed（performance hygiene, evidence-driven）

调研结论：**插件本身不会造成可感知 UI 卡顿**（worst 1.1% mean / 3.4% p99 EH CPU during streaming；<0.3% typical；writer hook 跑在 CC 子进程）。数字实测于真实 fixture（42MB jsonl + 185KB sidecar + 2.1GB outlier）。架构事实决定性：IIFE 跑在 EH（独立进程），不在 renderer——typing/copy/tab-switch 是 renderer-local 不等 EH。详见 docs/STATES.md §9（新增完整 perf 小节）+ README.md 性能小节（新增）。

挖出的 3 个**测得**浪费点（合 ~10 IPC/sec + 1.1ms/tick）一并修：

- **Fix 1（HIGH value, LOW risk）Uri 缓存**（`patch.ts:1828` 新加 `__ccsdUriCache` + `ccuri(p)` helper；`patch.ts:2240, 2249` 改 `vs.Uri.file` → `ccuri`）。VSCode EH-side `WebviewPanel.iconPath` setter 用**引用相等** dedup（`this.#iconPath !== value`，见 microsoft/vscode `extHostWebviewPanels.ts:106-116`），但 `vs.Uri.file()` 每次返新 Uri → dedup 永不触发 → 每 500ms × N panels 发 N 条冗余 $setIconPath IPC（4 panels = 8 IPC/sec 实测）。`ccuri(p)` memoize 同 path → 同 Uri 对象 → setter dedup 触发 → IPC skip。状态切换 + interrupted flash（交替 error.svg ↔ CC_DEFAULT）仍产生不同引用 → IPC 照发。CC 覆盖 iconPath 时下一 tick 500ms 内 re-assert（防橙漏出防御 intact）。Mock bench：8 IPC/sec → ~0 IPC/sec（**99.6% 降**）。
- **Fix 2（MED value, LOW risk）token SBI text dedup**（`patch.ts:2154` 4 个 `tsbi.text=` 分支统一加 dedup）。与既有 `__ccsdTokSbiLastTip` tooltip dedup 模式（v0.2.6 round-3）**不对称**——tooltip 已 dedup，text 每 tick 无条件赋值 → 稳态 ~2 IPC/sec 冗余（idle/tokens 稳定时）。镜像同款模式：`if(globalThis.__ccsdTokSbiLastText!==X){...; tsbi.text=X;}`。4 个分支（normal tlabel + no-data "$(clock) 0 tok" + 2x "$(clock) —"）统一套用，无需 cache-reset（dedup 自然处理跨分支转换）。
- **Fix 3（MED value, MED risk）`.offset` sidecar mtime+size 缓存**（`patch.ts:2006` computeLiveDelta 内）。长会话 sidecar 增至 185KB（527 buckets 实测）→ JSON.parse 每 tick **1.04ms = per-tick EH sync I/O 的 58%**（仅 streaming 时，idle/done/interrupted 早退）。镜像 §F 既有的 `__ccsdAgCache` 模式：`__ccsdOffCache` keyed on offPath，stat-first → cache hit reuse parsed sc；miss → re-read+parse+cache。Writer 原子 tmp+rename，(mtimeMs,size) 是可靠内容变更信号。Stale-cache 风险 bounded——stale offset 至多读多余 jsonl 字节，被 512KB cap 封顶，下个 hook fire（offset 唯一权威 writer）即更正，**无正确性影响**。Cache keyed on offPath（用户切 CC panel 时自然隔离）。无 prune（bounded by unique sessions per machine lifetime <100）。长会话 streaming per-tick EH I/O 1.9ms → ~0.8ms（**~2.4× 降**）。

### 显式不改的点（审查主动拒绝，复杂度风险 >> 测得收益）

- 不改 `computeLiveDelta` 为 async（fs.promises）——4-15ms sync 块有界且仅重度 streaming 时触发；async 级联重构 setInterval body + 错误处理 + per-panel tick 对称性。
- 不删/不降频 `p.iconPath=ccuri(svg)` 每 tick 赋值——故意防 CC 原生橙图标漏出的防御。Fix 1 的 Uri 缓存已让稳态 IPC → ~0，无需进一步降频。
- 不降 `TICK_MS=500`——降频延迟 running→done→idle 转换 + 破坏 notify-dedup 时序窗口。
- 不动 SBI aggregate tick——`__ccsdAgCache` mtime+size dedup 已最优（v0.2.8 round-2 修了 .tokens.json 漏 parse）。
- 不重构 `<sid>.offset` sidecar 结构（拆游标 + 历史 buckets 两文件）——是 EH parse + hook write 双开销的根因，但属 writer 侧 contract 变更，应单独提案。

### Changed

- `INJECT_VERSION` v0.2.8 → v0.2.9（IIFE body 变：Uri cache helper + ccuri() at 2 sites + token SBI text dedup at 4 branches + .offset sidecar cache in computeLiveDelta）。
- `HOOK_EVENTS` 9 → 10 事件（加 `PostCompact`）。
- `HOOK_VERSION` 保持 v0.2.1（writer IPC contract 未变——PostCompact 写 state:'done' 同 Stop 既有的 done shape；cc-status.js body 变 = 加 PostCompact case + 配套注释 → banner hash 重盖 `564ac28b → 4153997e`）。
- `companion/MIN_PATCHER_VERSION` 与 `injectVersion()` fallback 同步到 0.2.9 / v0.2.9（companion/package.json 版本 0.2.6 → 0.2.7：extension.ts 内字面量变 = 运行时行为变更，故 bump companion；既有装机用户需重装 .vsix 才拿到新的 stale-patcher 检查阈值，prepublishOnly 会自动产 `cc-status-dot-companion-0.2.7.vsix`）。
- `docs/STATES.md` §2 加 PostCompact 行 + SessionStart note refine；新增 §9 性能小节（测量数字 + 三项 hygiene 优化表 + 显式不改的点 + 数字快照）。
- `README.md` 新增性能小节（精简版，详见 STATES.md §9）；原理小节"9 个 hooks" → "10 个 hooks"。

### Tests

- **hooks/test-cc-status.js §Q.1-4**（+4，v0.2.9 Q4）：writer 侧 PostCompact 行为全锁——StopFailure → PostCompact 清 interrupted → done（红消）；PostCompact on running/done 是 no-op；real StopFailure 无 PostCompact 跟随保持 interrupted + error（Q2 sticky 不破坏）。
- **hooks/test-iife.mjs IIFE.125-132**（+8，v0.2.9 Q5）：Q5 三项 hygiene 的源码存在性 + 形态锁——`ccuri()` helper / `__ccsdUriCache` 声明 / `p.iconPath=ccuri(` 全替换；`__ccsdTokSbiLastText` dedup pattern 在 4 个 tsbi.text 分支；`__ccsdOffCache` mtime+size cache 在 computeLiveDelta（命中路径 + miss 写入路径）；唯一 `vs.Uri.file(` 出现在 ccuri 定义内（防漏改）。
- **hooks/test-iife.mjs IIFE.21c stamp regex** v0.2.8 → v0.2.9（INJECT_VERSION bump 必然导致 IIFE stamp 字面量变）。
- **hooks/test-iife.mjs IIFE.45 regex 更新**：`p.iconPath=vs.Uri.file` → `p.iconPath=ccuri`（Q5 Fix 1 改变了赋值外壳，per-tab iconPath 仍每 tick 赋值，仅 wrapping helper 变）。

---

## [0.2.8] - 2026-07-21

**INSTALL_DIR/src/ 缺失修复**。v0.2.4 把 `patch.ts` 拆成 `src/{semver,jsonc,surgical-json}.ts` 三模块,编译产物 `dist/patch.js` 通过相对 ESM specifier 导入它们(`import { cmpVerStr } from "./src/semver.js"` 等)。但 `installCompanion()` 只把 `patch.js` 拷到 `~/.claude/cc-status-dot/`,**忘了同拷 `dist/src/*.js`**——companion 在 CC 自动更新覆盖 extension.js 后跑 `node ~/.claude/cc-status-dot/patch.js --patch-only` 时,Node ESM loader 在任何代码执行前解析这些 specifier,找不到文件直接抛 `ERR_MODULE_NOT_FOUND`,companion 只能上报模糊的 "auto-patch failed"。潜在自 v0.2.4,v0.2.7 CC 自动更新触发后暴露。

### Fixed

- **HIGH companion-auto-patch(`installCompanion` 缺 src/ 拷贝)**:在拷贝 `patch.js → INSTALL_DIR/patch.js` 之后,新增同源拷贝 `dist/src/{semver,jsonc,surgical-json}.js → INSTALL_DIR/src/`,复用既有 `atomicCopyFileSync`(tmp+rename,与 `patch.js`/`resources/`/`hooks/`/`token-rates.json` 同一原子保证);幂等 + 同 `installRuntimeFiles` 的 stale-sweep 模式(只清 `dstSrcDir/*.js` 中不在 `SRC_MODULES` 列表的孤儿);非致命 try/catch包裹(与现有 `patch.js` 拷贝分支一致)。
- **MEDIUM 对称清理(`uninstallCompanion` 漏 src/)**:`--uninstall-companion` 现一并 `rmSync(INSTALL_DIR/src/, {recursive,force})`;`--revert` 路径经由 `removeInstallDir`(已 recursive rm INSTALL_DIR)自然覆盖。
- **LOW 自查可观测(`reportCompanionStatus` 不显示 src/ 健康)**:`--status` 现输出 `INSTALL_DIR/src/: present (3 modules) | (missing — companion will crash with ERR_MODULE_NOT_FOUND on next --patch-only, re-run npx …)`,让用户在 companion 报错后能一眼定位。

### Changed

- `INJECT_VERSION` v0.2.7 → v0.2.8。IIFE body 未变,但 bump 是让既有 v0.2.7 装机用户自愈的关键触发器:用户重跑 `npx vscode-claude-code-status-dot@latest` 后,companion 启动时检测到 IIFE stamp v0.2.7 ≠ want v0.2.8 → 触发 restore+reinject → `installCompanion` 重跑 → 拷 `src/`(同时 `companion-config.json` 的 `patcherVersion` 写 0.2.8,companion 的 `MIN_PATCHER_VERSION` 0.2.8 检查通过)。
- `companion/MIN_PATCHER_VERSION` 与 `injectVersion()` fallback 同步到 0.2.8 / v0.2.8。既有 v0.2.7 装机的 `companion-config.json` 写的是 `patcherVersion=0.2.7 < 0.2.8` → companion warn "stale patcher snapshot, re-run npx" 引导升级。
- `HOOK_VERSION` 保持 v0.2.1(cc-status.js writer 契约未变 → hook banner hash 不变 → 无需 re-stamp)。
- `companion/package.json` 版本(0.2.6)保持不变 —— `extension.ts` 内的版本字面量未动。**注意**:Round-2 在 `companion/extension.ts` 的 `getCmpVerStr()` 里**新增**了 `SAFE_TOKEN_RE` + `DANGEROUS` 双门正则对 `new Function(src)` 做防御性校验,这**属于 .vsix 运行时行为新增**(compiled 进 `companion/dist/extension.js`)。companion 版本号虽未 bump,但既有装机用户**需手动重装 `companion/cc-status-dot-companion-*.vsix`** 才能拿到该新增运行时保护(参见下方 Round-2 的 version-sync lockstep policy)。

### Round-2(后续复审 pass)

Round-1 修的是显性崩溃(ERR_MODULE_NOT_FOUND);Round-2 在复审中又挖出一组隐性漏洞,均不影响 patcher 主路径,但都属于 round-1 修复的"周边地带",发布前一并修。

#### Fixed

- **HIGH `extractCmpVerStrBody` 生产侧 null**:`companion-config.json` 的 `semverComparatorSrc` 字段是从 `src/semver.ts` 抽取的 `cmpVerStr` 函数体,companion 用它构造 `new Function('a','b', src)` 做版本比较。但 `extractCmpVerStrBody` round-1 实现只查 `<SCRIPT_DIR>/../src/semver.{ts,js}` 等 4 个 candidate,**生产 tarball 里根本没有 `src/*.ts`**(npm `files` 白名单只放行 `dist/`),所以 v0.2.4–v0.2.7 每个生产用户的 `companion-config.json` 写的都是 `semverComparatorSrc: null`。companion 在该字段为 null 时 fallback 到内建硬编码比较器(勉强能用,但完全绕过了"单一真相源"设计意图,且 fallback 路径从未被测试覆盖)。Round-2 把 candidate 列表改为:**先查 `<SCRIPT_DIR>/src/semver.js`(dev tsx 模式)→ 再查 `<SCRIPT_DIR>/../dist/src/semver.js`(compiled prod 模式,正确命中 tarball 里实际存在的文件)**。同时加 `SAFE_TOKEN_RE`(`^[A-Za-z0-9_.,;:()?<>!=|&+\\-*/%\\s"{}\\[\\]]+$`)白名单 + `DANGEROUS`(`/\\b(?:function|import|require|process|globalThis|window|eval|Function|fetch|setTimeout|setInterval|setImmediate|this|constructor|prototype|__proto__)\\b/`)黑名单双门,任何候选 body 必须先过两道门才写入 `semverComparatorSrc`,防御 future maintainer 误把含敏感原语的代码喂进 `new Function`。
- **MEDIUM IIFE 效率回归**:round-1 给 IIFE 加了 `.tokens.json` 快照(SessionEnd 持久 token 跨 VSCode 重启),但忘记给 `aggregate()` 加 skip filter → 每 500ms tick 都把 ~50KB 的 `.tokens.json` 重新 parse 一遍做聚合,持续 CPU 占用。Round-2 在 aggregation loop 里加 `if (name === TOK_TOKENS_EXT) continue` 镜像 skip。
- **MEDIUM source-vs-dist drift gate**:`hooks/assert-companion-vsix.mjs` + `hooks/test-version-sync.mjs` 各加一条断言 —— compiled `companion/dist/extension.js` 的 `MIN_PATCHER_VERSION` 字面量与 `injectVersion()` fallback 必须与 `companion/extension.ts` source 一致,防止 maintainer 改了 source 忘 `companion:build` → 既有装机 .vsix 里仍是旧字面量。
- **MEDIUM companion-version lockstep policy**:文档化"companion/package.json 版本 ≠ patcher INJECT_VERSION"是 by-design(companion 仅在 extension.ts 行为变化时才 bump),但任何对 `companion/extension.ts` 的运行时行为变更(如本次 SAFE_TOKEN_RE 新增)**必须**在 CHANGELOG 显式记录"既有装机用户需重装 .vsix"。

### Round-3(本轮修复)

继续复审挖出的 3 项 MEDIUM(round-2 reviewer 报告):

- **MEDIUM `installRuntimeFiles` SVG 拷贝非原子**:round-2 reviewer(integrity dimension)发现 `installRuntimeFiles` 的 SVG 循环(line ~4039)是 v0.2.6 round-3 原子拷贝纪律的**唯一漏网之鱼** —— 同函数内 hook(cc-status.js)、token-rates.json 都已迁到 `atomicCopyFileSync`,唯独 SVG 循环保留 `fs.copyFileSync`。ENOSPC/EINTR/SIGKILL 中途失败会留下截断的 `claude-logo-*.svg`,状态栏渲染为 broken-emoji,且 stale-sweep 因 filename 仍匹配 `OUR_SVGS` 不会清。Round-3 改用 `atomicCopyFileSync`(tmp+rename,POSIX rename 原子)。
- **MEDIUM `test-standalone-patch.mjs` SRC_MODULES 硬编码**:round-2 reviewer(regression dimension)发现该 e2e test 用本地硬编码 `['semver.js','jsonc.js','surgical-json.js']`,未与 patch.ts 的 `SRC_MODULES` 单一真相源绑定。未来新增第 4 个 `import { foo } from "./src/foo.js"` + SRC_MODULES 条目时,`test-contract-sync.mjs` 的 §SRC_MODULES parity 会通过,但本 e2e 仍只校验原始三件套,**重新引发 v0.2.7 那类回归**(installCompanion 漏拷新模块 → companion re-patch 时 ERR_MODULE_NOT_FOUND)。Round-3 改用与 contract-sync 同款 regex 从 patch.ts 源码运行时抽取 SRC_MODULES,失败即 fail loudly。
- **MEDIUM CHANGELOG 不准**:同 reviewer 指出本节最初版本声称 round-1 "未改 .vsix 运行时行为",但 round-2 的 `SAFE_TOKEN_RE`/`DANGEROUS` 双门是 compiled 进 `companion/dist/extension.js` 的新运行时行为。已在本节 `companion/package.json` 条目里更正(见上)。

### Added — 测试

- 断言数 +9(731 → 740):
  - **hooks/test-standalone-patch.mjs(新建,6 项)**:e2e 回归门 —— 拷 `dist/patch.js + dist/src/` 到 tmp 目录,跑 `node tmp/patch.js --status` 断言 exit 0 + 无 `ERR_MODULE_NOT_FOUND` + 输出含 `[cc-status-dot]`;反向回归(删 `tmp/src/` 重跑)断言**会**崩溃,证明测试非 vacuous。v0.2.7 这个 test 会 FAIL,v0.2.8 PASS。
  - **hooks/test-patcher-io.mjs(+3 项,v0.2.8 build-integrity gate)**:`dist/src/{semver,jsonc,surgical-json}.js` 三文件存在性断言,防 build 漏拷(独立于 standalone e2e 的 runtime 层 gate);dev tsx fallback 路径 skip。
  - **hooks/test-iife.mjs IIFE.21c stamp 锁(0 项,断言迁移)**:`v0.2.7` 正则 → `v0.2.8`(INJECT_VERSION bump 必然导致 IIFE stamp 字面量变)。
  - `package.json` 的 `test` 脚本链末尾追加 `&& node hooks/test-standalone-patch.mjs`,新增 `test:standalone` 快捷脚本。

### 已知限制

- **既有 v0.2.7 装机用户无法自愈**:companion re-exec 的就是那个崩的 patch.js,起不来 → 无法自动修复。**必须用户主动重跑 `npx vscode-claude-code-status-dot@latest`** 触发 `installCompanion` 重拷 `src/`。这是设计内禀限制,已在 `--status` 的 `INSTALL_DIR/src/` 行 + companion 的 stale-patcher warn 里讲清。建议升级提示在 README/CHANGELOG 显式说明。
- **dev(tsx patch.ts)模式下不拷 `src/*.js`**:`SCRIPT_DIR=project root`,`src/` 下是 `*.ts` 而非 `*.js`,per-module `existsSync` false → 走 warn 分支(非致命,符合预期);编译模式 `dist/src/` 缺失则 warn "run `npm run build`"。

## [0.2.6] - 2026-07-20

**回复内容驱动的蓝灯（blue-via-content）+ 卡黄修复 + 关键词精度收紧**。v0.2.5 之前蓝灯只来自 Notification/permission；v0.2.6 把 Claude 最后一条 Stop 回复的语义匹配也纳入 pending 来源（"等你测试反馈"/"let me know" 等明确待用户决策/反馈时亮蓝）。同时修复 v0.2.5 round-1 引入的两个正确性缺口：per-tab tick pending 检查未应用 decay 导致旧 done+pending 永假蓝，以及关键词表 3 个 HIGH 中文子串假阳性（"你定"/"看你的"/"告诉我"）。

### Added — blue-via-content（pending 第三通道）

- **writer 侧**（`hooks/cc-status.js`）：Stop case 读 `payload.last_assistant_message`，经 `lastMessageRequestsUserInput(msg)` 判断后写 `pending:true`。判断逻辑：(1) strip 代码块（`fenced` / `inline` / ~~~alt-fence~~~）；(2) 命中 `AWAIT_USER_PHRASES`（38 条中英 idiom：`等你` / `你决定` / `请确认` / `let me know` / `your call` / `please confirm` 等）→ true；(3) fallback：末行 ≤60 字符独立问句且含用户代词（你/您/you）或动作动词（继续/确认/选/决定/proceed/confirm/choose 等）→ true；(4) `stop_hook_active=true` 跳过（CC 防死循环门）。设计哲学 **SPECIFICITY > RECALL**：假蓝比假绿更糟，故只列无歧义 idiom。
- **reader 侧**（`patch.ts` buildIIFE §H）：per-tab tick 优先级链 `__ccsdPending yield`（CC 原生蓝）→ `pend && st!=="idle"`（新 blue-via-content 渲染 `claude-logo-pending.svg` #58A6FF）→ state if-chain（running 黄 / done 绿 / interrupted 红 / idle 灰）。
- **SVG 资源**：新增 `resources/claude-logo-pending.svg`（与 `done.svg` 几何完全一致，仅 badge-circle fill `#3FB950→#58A6FF` + `<title>` 文本）。`OUR_SVGS` 5 项（4 + pending）。
- **聚合层**：底部 🔵 SBI 通过既有的 `j.pending===true || __ps[sid]` OR 链自动覆盖新通道，无新增代码。

### Fixed

- **HIGH reader-logic（per-tab tick decay 前置）**：v0.2.6 round-1 把 `done>5min→idle` / `running-stale-15min→idle` 的 decay 放在了 SVG 选择分支内（pending 检查之后），导致 `st` 在 `pend && st!=="idle"` 检查处仍是 RAW 值（writer 永不写 `state:'idle'`），守卫变 dead code，`done+pending` 会话永久假蓝。round-2 把 decay 链提到 pending 检查之前（镜像 SBI tick 的 decay 顺序），用 per-tab 常量（`DONE_TO_IDLE_MS` / `SINCE_STALE_MS`，**不**引用 `SBI_RUNNING_STALE_MS` / `INTERRUPTED_RETENTION_MS`，保留 IIFE.46b 的命名分歧锁）。
- **HIGH keyword-accuracy（中文子串假阳性）**：移除裸 `'你定'`（命中 `你定义的函数` / `你定制` / `你定位` / `你定期`）、`'看你的'`（命中 `我看你的代码`，CC 代码审查里高频）、`'告诉我'`（命中 `文档告诉我` / `你昨天告诉我`，第三人称 / 过去式）。改用后缀锚定形式：`你来定` / `由你定` / `你定夺` / `你定一下` / `告诉我你的` / `告诉我你决定` / `告诉我你选`。补充同义委派：`你说呢` / `你说吧` / `听你的`（与既入表的 `你看呢` 语义同构）。
- **MEDIUM keyword-accuracy（英文 / fallback）**：移除裸 `'wait for you'`（已是 `'waiting for you'` 的子串，纯冗余；且命中 `wait for your input file`）；`'your input'` 收紧为 `'your input on'`（裸形式命中 `your input handler` / `your input validation`，CC 改代码回复里高频）；fallback `?` 结尾规则加语义锚（必须含用户代词或动作动词），排除修辞性 / 信息性短问句（`Why?` / `什么意思?` / `效果如何?` / `How does this work?` / `What did the refactor break?` / `为什么这样设计?`）。补充 EN 决策习语：`what do you think` / `over to you` / `your move` / `your take` / `would you like` / `want me to` / `wait for you to`。
- **卡黄（stuck-yellow）round-1 修复（保留）**：`patch.ts` 新增 `SINCE_STALE_MS=15*60*1000` 常量（独立于 `SBI_RUNNING_STALE_MS=30min`），per-tab running 分支在 `since>SINCE_STALE_MS` 时渲染 idle.svg 而非 running.svg，捕捉 CC 上游 `Stop inflight=1` 漂移 + `preserveSince` 导致的永黄场景（luceo 实测卡黄 2h）。
- **聚合 decay key 对齐**：聚合层 running decay 从 mtime 改为 since（与 per-tab 一致），根因同上 —— `Stop preserveSince` 路径刷 mtime 不刷 since，mtime-decay 永不触发。

### Changed

- `INJECT_VERSION` v0.2.5 → v0.2.6（IIFE body 变：decay 前置 + pending 渲染分支 + SINCE_STALE_MS 常量 + `var now=Date.now()` 提前 + SVG 选择分支保留 round-1 decay 注释 / `claude-logo-pending.svg` 资源引用）。
- `HOOK_VERSION` 保持 v0.2.0（hook contract 未变；cc-status.js body 变 = AWAIT_USER_PHRASES 重列 + `lastMessageRequestsUserInput` helper + Stop case 读 `last_assistant_message` + `~~~` fence strip + fallback 语义锚 + banner hash 重盖 `a94cb290→ebb27508`）。
- `companion/MIN_PATCHER_VERSION` 与 `injectVersion()` fallback 同步到 0.2.6 / v0.2.6。

### Added — 测试

- 断言 **654 → 682**（+28）：
  - **hooks/test-cc-status.js §AA.1-21**（v0.2.6 round-1，已在 round-1 入库）：writer 侧 pending 行为全锁——`等你测试反馈`/`你决定`/`请确认`/`let me know`/`please confirm`/`your call` 命中 → pending:true；短问句 fallback；中性完成 / 技术"等待加载"/ LLM 自述 / 缺字段 / 非字符串 / `stop_hook_active=true` / 代码块 `letMeKnow()` 标识符剥离 → pending:false；stuck-running（luceo）+`等你` → state=running AND pending=true；跨事件清零（UserPromptSubmit 清 pending）；StopFailure 不走 Stop pending 路径。
  - **hooks/test-cc-status.js §AB.1-7**（+24，v0.2.6 round-2）：keyword-accuracy 双向回归锁——3 个 HIGH 假阳性向量（`你定` / `看你的` / `告诉我` 的技术词命中）+ 3 个 MEDIUM 假阳性向量（`wait for your X` / `your input handler` / 修辞性短问句）现在全部 pending:false；同时 7 个新精准条目（`你来定` / `听你的` / `你说呢` / `告诉我你的` / `what do you think` / `over to you` / `wait for you to`）保持 pending:true（防过收紧回归）。
  - **hooks/test-iife.mjs IIFE.12d-g**（+4，v0.2.6 round-2）：per-tab tick decay 前置的位置锁——decay 链必须在 pend 检查之前、`__ccsdPending` yield 之后、`var now=Date.now()` 之后。
  - **hooks/test-iife.mjs IIFE.46c/d + IIFE.110-117**（v0.2.6 round-1，已在 round-1 入库）：per-tab running decay 用 `SINCE_STALE_MS`（since-based，15min）；`claude-logo-pending.svg` 资源断言——文件存在 / `<title>` 文本 / badge fill `#58A6FF` / logo path d= 与 done.svg 一致 / mask 几何一致 / `OUR_SVGS` 含 pending 5 项。

### 已知限制

- **关键词覆盖 ZH+EN only**：8 个 README 多语（zh/en/ja/de/es/fr/pt/ru），但 `AWAIT_USER_PHRASES` 只列中英 idiom。若用户用日韩西法德俄语与 CC 对话，蓝灯可能不亮（待后续扩展，至少补日文 `教えて`/`決めて` 与西法德 `dime`/`decide`/`sag mir` 等）。
- **`interrupted+pending` 仍渲染蓝（round-2 LOW 未修）**：StopFailure 路径已清 pending，故实际罕见；若文件被手编为该组合，per-tab 会显示蓝（覆盖中断红闪）。SBI 聚合层会经 24h decay 正常归零。
- **`state:'unknown'+pending` 仍渲染蓝（round-2 LOW 未修）**：per-tab tick 缺 SBI 的 unknown-state catch-all；罕见（需文件被手编或未来 writer 新增 state 名）。

## [0.2.5] - 2026-07-20

**蓝灯统一 / token 实时增量 / workflow 子代理可见 / 默认窗口改 all**。v0.2.4 用户反馈 3 个问题：(1) 权限弹窗时底部蓝灯不计（per-tab 已亮、聚合读文件 pending 滞后）；(2) CC 流式生成时右下角 token 凝固（hook 只在 5 个事件点触发，流式期间无信号）；(3a) workflow/subagent 跑期间 token 不可见（SubagentStop 才归并）；(3b) 选 "all" 仍清零是 per-session scope，但默认 1h 滚动窗口让用户误以为是 bug。v0.2.5 全部修复并新增 19 项断言（527 → 553）。

### Fixed

- **问题 1（蓝灯统一项目方案）**：底部 4 灯聚合的 pending 计数现在 **OR 两源**——`<sid>.json.pending`（Notification hook 异步写盘，跨窗口覆盖）+ `globalThis.__ccsdPendingSet`（Anchor B 从 `rename_tab.hasPendingPermissions` 同步刷新，本窗口覆盖）。Anchor B 维护 set（per-panel `__ccsdPending` flag 的全局镜像），onDidDispose 清理。底部聚合读 set 时用 `files[i].slice(0,-5)` 去掉 `.json` 后缀恢复 sid 作为 set key。decay（`st!=="idle"`）在 OR 之后仍生效，30min/5min/24h GC 不被绕过。**保留 per-tab yield 给 CC 原生蓝点**（调研 R1：去掉 yield 会与 CC 原生蓝点 500ms 周期闪烁）。
- **问题 2（token SBI 实时）**：IIFE 内联 `computeLiveDelta(tj, sid)` helper，读 `<sid>.offset` sidecar 的 offset，增量读 jsonl 文件 `[offset..size]` 字节区间（512KB 硬上限），按 assistant 行的 `message.usage` 累加 delta。显示 = `sumTok(window) + delta`（零双计：IIFE 只读 hook 尚未消费的字节）。skip 条件：`!tj.tokens` / `tj.state!=='running'` / `sidecar.offset<=0` / `jsonl.size<=offset` / 半行（无 trailing `\n`）。cwd→projects 路径 escape = `/[^a-zA-Z0-9._-]/g`（实测匹配 CC 当前 escape，含中文路径）。`tokenLiveDeltaEnabled` 配置开关（默认开）。
- **问题 3a（workflow / 子代理 token 可见）**：新增 `scanSubagentTranscripts(parentSid, payload, ctx)` hook helper，在每个 TOK_EVENT（PostToolUse / Stop / UserPromptSubmit / PreToolUse / SubagentStop）扫描 `<parentDir>/<sid>/subagents/*.jsonl`，对每个文件调用 `readTranscriptIncremental(sid, fullPath, 'sub:'+basename)`。per-source offset 隔离使其与 SubagentStop 路径幂等（同 source key 共享 cursor）。**不扫顶层 `agent-*.jsonl`**（CC 2.0.77 旧版布局，文件内 isSidechain:true 全跳过，无实际增益；且会误读测试 fixture / 第三方工具所 plant 的 *.jsonl）。SubagentStart payload 不带 `agent_transcript_path`（CC 上游契约），无法在 SubagentStart hook 实时——目录扫描是唯一路径。workflow type token 若 CC 不写专属 transcript 仍 invisible（CC 上游限制）。
- **问题 3b（窗口语义）**：默认统计窗口从 `1h` 改为 `all`（累积，符合"状态栏持续显示本会话总量"心智）。QuickPick + §G tick 同时改默认。`all` 是 per-session 累积（CC 重启清零，by design）；5min/10min/1h/24h/3d/7d/30d 是 rolling（旧数据滑出，by design）。tooltip 已通过 `ttWindowTpl` 显示当前窗口，用户可自行切换。无 bug 需修。

### Changed

- `INJECT_VERSION` v0.2.4 → v0.2.5（IIFE body 变：aggregation OR / onDidDispose set 清理 / `computeLiveDelta` helper / §G tick 增量累加 / 默认窗口改 all / 新增 `ttLiveDeltaTpl` i18n key）。
- `HOOK_VERSION` v0.1.15 → v0.2.0（hook contract 变：新增 `scanSubagentTranscripts` helper + 调用点；banner hash 重盖）。
- `companion/MIN_PATCHER_VERSION` 与 `injectVersion()` fallback 同步到 0.2.5 / v0.2.5。
- `stripIifeInPlace` 正则 widening：Anchor B segment 接受可选 `try{...}catch(_){}` 块（v0.2.5 set sync 引入），保留向后兼容（pre-v0.2.5 仍能剥离）。

### Added

- `ttLiveDeltaTpl` i18n key × 8 语言（zh/en/ja/de/es/fr/pt/ru）：tooltip 在 dSum>0 时追加 `$(pulse) +{fmt} tok live (pending settlement)` 一行，让用户看到实时增量与已结算基线的区分。
- `computeLiveDelta` IIFE helper（约 40 行）：只读 jsonl 尾部、零状态、零写盘、严格 invariant、524288 字节硬上限。
- `scanSubagentTranscripts` hook helper（约 70 行）：nested `<sid>/subagents/` 目录扫描 + per-source offset 隔离。
- 测试断言：527 → **553**（+26）：
  - IIFE.80-92（+13）：`computeLiveDelta` 签名 / 5 个 skip invariant / cache_creation 双形式镜像 / 512KB 硬上限 / 半行 guard / cwd escape rule / §G tick 集成 3 处 / `tokenLiveDeltaEnabled` 配置 / 默认窗口 `all` × 2 处 / `ttLiveDeltaTpl` key。
  - IIFE.29c-29d（+2）：Anchor B 维护 set + onDidDispose 清理。
  - test-sbi-aggregation §5.1-5.6（+6）：set-only / file-only / both / neither / decay 仍生效 / 多 sid 累积。
  - test-cc-status §Z.1-5（+5）：scanSubagentTranscripts 在 PostToolUse 即可见 + sidecar 多 cursor + 幂等 + 增量 + 缺目录 no-op。

## [0.2.4] - 2026-07-20

**右下角 token / $ cost SBI + QuickPick 配置面板**。v0.2.3 之前项目只显示会话状态（5 态点 + 4 灯聚合），用户对"我这个会话烧了多少 token / 多少钱"的痛点依赖 CC `/cost` 命令——但 `/cost` 不能跨会话累计、不能持续可见、不能设阈值。v0.2.4 用 CC transcript jsonl（每条 assistant 行的 `message.usage` 100% 携带 token）作为唯一权威源，通过 writer hook 增量读（byte-offset sidecar，33MB 大文件 < 100ms）把派生 token 总量 + 6 时间窗口 + USD 估算写到现有 `<sid>.json`（向后兼容），IIFE 在右下角新增第二个 SBI 显示。

### Added

- **右下角 token SBI**（`StatusBarAlignment.Right`，priority `-9995`）：显示当前激活 CC panel 的 token 用量 + 可选 USD 估算。与左下角 4 灯 SBI 分占状态栏两侧（左 = 会话状态，右 = 用量成本）。3 种显示模式：`token` / `cost` / `both`（默认）。
- **6 时间窗口**：5min / 10min / 1h（默认）/ 24h / 3d / all，QuickPick 即时切换。窗口仅切显示，buckets 始终全量维护。
- **USD cost 估算**：`~/.claude/cc-status-dot/token-rates.json` 热更定价表（无需重 patch，writer 按 mtime 缓存重读）。Anthropic 官方价（Sonnet / Opus / Haiku）已预置；GLM 等未匹配 model `_default: null` → 自动隐藏 `$`，只显 token。
- **QuickPick 配置面板**（点击 token SBI 触发）：window 切换 / display 模式 / token SBI 可见性 / notify / notifyWhenFocused / sound 选择 + 当次会话 total / 今日 / 7 日 / 30 日累计 $ + turn-running 计时 + 快速命令（Copy token count / Reset session stats / Open state dir / Open Settings）。
- **限额告警**：`ccStatusDot.warnThresholdUsd`（默认 0 禁用）→ cost 跨阈触发一次通知，cost 跌破后再跨越重新触发。
- **turn 计时器**：tooltip 显示当前轮（state=running 时）已跑多久。
- **`<sid>.json` 加 `tokens` 字段**（向后兼容）：`{total, windows:{5min,10min,1h,24h,3d,7d,30d,all}, cost, cost_5min, cost_1h, cost_24h, cost_7d, cost_30d, last_ts, last_model, turn_count}`。老 reader 忽略该字段。
- **`<sid>.offset` 字节偏移 sidecar**：`{offset, lastTs, lastSize, totals, buckets[], perTurn[]}`。增量读核心——只读自上次 fire 以来新增的字节，33MB jsonl 也能 < 100ms。
- **`payload.cwd` 透传到 `status.cwd`**：IIFE tooltip 显示当前 project path，多 project 并行时一眼分辨。
- **companion/package.json contributes.configuration schema**：8 项配置全部声明 type/default/enum/description，VSCode Settings UI 现在能搜到 + autocomplete + 显示描述（修复 v0.2.3 之前的"配置无 schema"体验债）。

### Changed

- `INJECT_VERSION` `v0.2.3` → `v0.2.4`；`HOOK_VERSION` `v0.1.14` → `v0.1.15`（writer schema 变更：tokens/cwd 字段并入 + offset sidecar + 5 事件 token 触发）。
- `package.json` / `companion/package.json` / `MIN_PATCHER_VERSION` 0.2.3 → 0.2.4。
- writer hook 触发 token 增量读的 5 个事件：`PostToolUse`（主 heartbeat）/ `PreToolUse`（副 heartbeat）/ `Stop`（终态校准）/ `UserPromptSubmit`（R2 兜底）/ `SubagentStop`（读 `agent_transcript_path` 归父 sid）。
- writer GC（UserPromptSubmit 10min throttle）扩展：也扫 `.offset` 文件，与 `.json` 同步 prune（24h mtime + interrupted-preserve 例外）。
- writer `SessionEnd` DELETE 分支：同步 unlink `<sid>.offset`（之前只删 `<sid>.json`）。
- ANCHOR_A `replA` 多一段 `globalThis.__ccsdActiveSid=e.request.sessionId`，让窗口级 active-sid 跟踪在每个 update_session_state fire 时刷新；`stripIifeInPlace` 的 segA 正则放宽为 optional 容纳新旧两种形式（前向 + 后向兼容）。

### Token stats 数据流（v0.2.4 新增）

```
CC jsonl (SoT)
  └─ message.usage (per assistant line)
       │
       ▼ (writer hook 增量读)
  ~/.claude/cc-tab-status/<sid>.offset  (派生缓存：offset/totals/buckets/perTurn)
       │
       ▼ (writer 每事件 fire 后写)
  ~/.claude/cc-tab-status/<sid>.json .tokens  (主状态文件新字段，向后兼容)
       │
       ▼ (IIFE 500ms tick 共享 __ccsdSbiTimer 读)
  右下角 token SBI  ($(clock) 12.3k tok · $0.42)
```

### Bug 缓解（来自 CC 官方 issue）

- **#41310 早火 transcript 不存在**：writer `fs.statSync` 失败 → return null 静默跳过。
- **#9188 `claude --continue` 陈旧 sid+path**：`mtimeMs < lastTs - 60s && size 无增长` → 跳过本轮不归零。
- **R2 Stop transcript 未 flush**：跨事件触发增量读（PostToolUse + Stop + 下次 UserPromptSubmit 兜底）。
- **cache_creation 双形式**：`u.cache_creation?.ephemeral_5m_input_tokens || 0` + `u.cache_creation?.ephemeral_1h_input_tokens || 0` + `u.cache_creation_input_tokens || 0`，glm-5.2（标量）与 Anthropic（对象）都兼容。
- **sidechain 双计防御**：父 transcript 的 sidechain 行跳过；subagent token 通过 `SubagentStop + agent_transcript_path` 单独归并。
- **`<synthetic>` model 行过滤**：CC 内部合成行不计费。
- **首火大文件预热**：offset=0 且 size > 256KB → 只读尾部 256KB，避免 33MB 文件首火阻塞 ~1s。
- **size shrank → reset offset 0**：CC compacted transcript 时全量重读。
- **buckets 折叠**：> 1000 条时按 5min 桶折叠（保留浮点累计，仅展示四舍五入）。
- **perTurn FIFO 上限**：400 条（足够 tooltip 显示 + 趋势分析；超了老的滚出）。

### 文档

- 新增 [`docs/STATES.md` §8](docs/STATES.md)：token 统计 SBI 字段契约 + 数据流 + 与 §7 4 灯 SBI 共存核对表。
- 更新 [`docs/USAGE.md` §3.6](docs/USAGE.md)：操作步骤（显示模式 / 时间窗口 / tooltip / 配置项 / 自定义定价 / QuickPick 操作 / 数据源与持久化）。
- 更新 [`README.md`](README.md) + 8 语言版：加 token SBI 卖点（§4.5）+ 配置项扩展。

### 升级

旧版（0.2.3 及更早）已 install 的用户重跑 `npx vscode-claude-code-status-dot@latest`：

1. `patchExtension` 检测 stamped version `v0.2.3` 与 `INJECT_VERSION v0.2.4` 不符 → 从 `extension.js.bak` 还原 → 重注入 v0.2.4 IIFE（含 token SBI）。
2. `installRuntimeFiles` 复制新 hook（v0.1.15）+ 新 `token-rates.json`。
3. companion 检测 `MIN_PATCHER_VERSION 0.2.4 > config.patcherVersion` → 提示用户重跑（已有 stale-detect 机制）。
4. Reload Window → token SBI 出现右下角。

无破坏性变更——所有现有 5 态点 / 4 灯 SBI / notify / permission yield / companion 自愈保持原样。

## [0.1.17] - 2026-07-19

**底部 SBI 4 灯：单 SBI 紧凑拼接（0 像素间距），数字等宽不位移由 VSCode 自带 `tabular-nums` CSS 根治**。根因：v0.1.16 的 4 个独立 SBI（priority `-9996..-9999`）在状态栏上看起来"间隔松散"——用户反馈"4 圆点之间间隔不紧凑"。**调研 VSCode 源码（`microsoft/vscode` 仓库 `src/vs/workbench/browser/parts/statusbar/media/statusbarpart.css`）发现：每个 SBI label 的 CSS 写死了 `margin-right:3px;margin-left:3px;padding:0 5px;`，相邻 SBI 之间约 6-16px 间距，**公开 StatusBarItem API 无 `margin`/`padding`/`spacing` 字段**；VSCode 内部 `IStatusbarEntryLocation.compact` 标志存在但只对核心 entry 开放（如 Ln/Col 与 Encoding 的紧贴对），`createStatusBarItem(alignment, priority)` 签名不接受 `compact` 参数，`require("vscode")` 也 resolve 不到内部 statusbar 模块；priority 只决定排序，不影响间距。**4 SBI 路径下 6-16px 间距是 VSCode 框架硬限制**。**要紧凑必须收回到单 SBI**。

### Added / Changed

- **4 SBI → 单 SBI 紧凑拼接**：`globalThis.__ccsdSbis`（4 元素数组）→ `globalThis.__ccsdSbi`（单个 StatusBarItem）。单个 `createStatusBarItem(StatusBarAlignment.Left, SBI_PRIORITY=-9996)`，text 是 4 个 `<球><数字>` 拼接（`txt+=(n===0?DIM_EM:CFG[k].em)+(n>=4?"N":""+n)` 4 次循环）→ `🟢3🟡1⚪0⚪0`（无分隔符，**0 像素间距**）。整行宽度从 ~120px 压到 ~70px。`onDidDispose` 最后一个 panel 退出时直接 `__ccsdSbi.dispose()`（不再遍历 4 个）。
- **位置稳定性根因彻底澄清**：v0.1.14 时"单 SBI 位移"问题被错误归因到数字宽度。**实证 VSCode `statusbarpart.css`**：`.monaco-workbench .part.statusbar > .items-container > .statusbar-item` 选择器带 `font-variant-numeric: tabular-nums;`——所有 ASCII 数字 0-9 在**任何字体**下都是等宽 OpenType tabular figures。`cap()` 把 0-3 与 4+ 都映射到 1 字符宽（"0"-"3" 或 "N"），所以数字部分的宽度永远恒定——**显式需求"数字不位移"由 VSCode CSS 独立保证，与 emoji 渲染无关**。v0.1.17 不带 v0.1.14 的空格分隔符（v0.1.14 位移实际来自空格分隔符在不同字体下的宽度差），4 灯直接紧贴，无任何可变宽度空白。
- **`SBI_LIGHTS_CFG` 表 `pri` 字段移除**：v0.1.15/v0.1.16 的 `{key,em,pri}` 改回 `{key,em}`——单 SBI 不需要每灯独立 priority（4 灯共享一个 SBI 的 priority）。新增 sibling 常量 `SBI_PRIORITY = -9996`（取 v0.1.16 leftmost-done 的值，**保持整行在状态栏的屏幕位置不变**——用户对"位置固定"的隐式期望涵盖整行级别）。
- **简化 v0.1.15 round-4 的过保护**：去掉 4-SBI 创建路径下的 length-guarded 重建（`if(__ccsdSbis.length!==CFG.length)`）+ commit-atomic 提交（`if(arr.length===CFG.length)`）+ partial-failure cleanup（`else{for(f<arr.length)...dispose()}`）三层保护——单 SBI 创建只有一次 `createStatusBarItem` 调用，不存在部分失败的中间状态，三层保护变得冗余。
- **click handler 读 `__ccsdSbi.tooltip`**（不再是 `__ccsdSbis[0].tooltip`，因为只有 1 个 SBI）。
- **IIFE 版本戳 `v0.1.16` → `v0.1.17`**：已 patch 的 v0.1.16 装在下次 install 时被检测为 STALE（version 不符 + hash 不符双重保护）→ 自动从 `extension.js.bak` 还原并重注入新单 SBI IIFE。

### 保留（Preserved，v0.1.14/v0.1.15/v0.1.16 设计改进完整沿用到 v0.1.17）

- **🔵 pending 第 4 灯 + Notification hook case**：聚合层独立计数 pending，与 state 正交（v0.1.13 引入，v0.1.14 沿用）。count>0 → 🔵 蓝球 + 数字。
- **done/running/interrupted 三路陈旧会话 GC**：done >5min→idle（§4）；running mtime >30min→idle（§7.2，变量名 `SBI_RUNNING_STALE_MS` 保留）；interrupted mtime >24h→idle（`INTERRUPTED_RETENTION_MS`）。per-tab 渲染**不应用**后两条，聚合层应用。
- **聚合单例 + panel 计数 lifecycle**：`__ccsdSbi`（单个 StatusBarItem，v0.1.17）+ `__ccsdSbiTimer` 窗口级单例；`__ccsdPanelCount` 入口 +1 / `onDidDispose` -1，归零时清理（v0.1.17：dispose 单 SBI）。
- **三层独立 try/catch 隔离**：(1) 单 SBI 创建；(2) 单例 timer 注册；(3) aggregation body。
- **lastKey memo short-circuit**：per-tick 更新在 UNcapped 计数 tuple 不变时直接 short-circuit，steady-state IPC 写入从 ~40/s 降到 0。
- **0-3+N 封顶规则**：`cap(n){return n>=4?4:n}` 把 4+ 截到 4，`text` 规则 `(n>=4?"N":""+n)` 把 4 渲染为 `N`。
- **共享 tooltip `Claude Code: X done, Y running, Z pending, W interrupted`**（未截顶的真实计数）+ 共享 click command `ccStatusDot.sbiClick`（运行时注册，无 package.json contribution）。

### 改善（v0.1.17 相对 v0.1.16 的额外收益）

- **priority 碰撞窗口从 4 单位缩到 1 单位**：v0.1.16 占用 `-9996..-9999` 4 单位相邻 priority 区间，v0.1.17 只占用 `-9996` 一个 priority 点——其它扩展声明同 priority 把我们的 SBI 挤到角落的概率降低到 1/4。
- **消除了 v0.1.16 的"行被外部分隔"失败模式**：v0.1.16 的 4 个独立 SBI 可能被其它扩展的 SBI 插入 done 与 interrupted 之间劈开成两半；v0.1.17 整行是一个 SBI，外部插入只能插到整行两侧，不会拆开 4 灯。
- **代码量减少**：单 SBI 创建路径去掉了 v0.1.15 round-4 的 length-guarded 重建 + commit-atomic + partial-failure cleanup 三层 ~50 行 IIFE 字节；onDidDispose teardown 从 4-元素遍历简化为单次 dispose。
- **真正的紧凑视觉**：4 圆点从"间隔松散"变成"紧贴成串"——v0.1.16 的视觉痛点根治。

### 已知限制（沿用 v0.1.16 同款）

- **依赖 emoji 字体栈**：v0.1.15 的 ThemeColor 块**完全跟随 VSCode 主题色**，跨平台稳定；v0.1.16 因用户反馈"色块不如球好看"切回 emoji 球，v0.1.17 在此基础上合并到单 SBI 但保留 emoji 球——Win7/无 emoji 字体的 Linux/headless 环境可能黑白或豆腐块。macOS（Apple Color Emoji）/ Windows 10+（Segoe UI Emoji）/ 主流 Linux（Noto Color Emoji）正常显示彩色。
- **`⚪`（U+26AA）跨 Unicode 块的潜在宽度差**：`🟢🟡` 属 Geometric Shapes Extended，`🔵🔴` 属 Miscellaneous Symbols And Pictographs，`⚪` 属 Miscellaneous Symbols——5 个球分属 3 个不同 Unicode 块。**实测现代 emoji 字体把所有 emoji 渲染成 1em 正方形 glyph，跨块宽度一致**（这是 v0.1.17 选择保留 `⚪` 的依据）。**理论风险**：某些冷门字体可能让 `⚪` 与彩球宽度略差，导致整行因计数变化（某灯 0↔非0）而左右位移 1-2 像素——但**显式需求"数字不位移"由 VSCode CSS `tabular-nums` 独立保证**，与此风险正交。**根治方案预留**：若用户反馈观察到实际位移，v0.1.18 把 `SBI_DIM_EM` 改为 `🟤`（U+1F7E4，与 `🟢🟡` 同属 Geometric Shapes Extended，**保证**等宽）即可——一处常量改 + 同步 STATES.md §7.1。
- **形状是 emoji 字形正圆**（沿用 v0.1.16）：相比 v0.1.15 的 SBI 圆角矩形块，球是 emoji 字体提供的正圆 glyph（在支持的字体下）。

### 引用（VSCode 源码实证）

- VSCode `statusbarpart.css`（master）：[github.com/microsoft/vscode/blob/master/src/vs/workbench/browser/parts/statusbar/media/statusbarpart.css](https://github.com/microsoft/vscode/blob/master/src/vs/workbench/browser/parts/statusbar/media/statusbarpart.css) — `.statusbar-item` 的 `margin:0 3px;padding:0 5px` 与 `.part.statusbar > .items-container > .statusbar-item` 的 `font-variant-numeric: tabular-nums`
- VSCode 内部 statusbar 接口：[github.com/microsoft/vscode/blob/master/src/vs/workbench/services/statusbar/browser/statusbar.ts](https://github.com/microsoft/vscode/blob/master/src/vs/workbench/services/statusbar/browser/statusbar.ts) — `IStatusbarEntryLocation.compact` 字段（未公开）
- VSCode Issue #73700（tabular-nums for digits）：[github.com/microsoft/vscode/issues/73700](https://github.com/microsoft/vscode/issues/73700)
- MDN `font-variant-numeric`：[developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/font-variant-numeric](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/font-variant-numeric)

## [0.1.16] - 2026-07-19

**底部 SBI 4 灯：恢复圆点 emoji 样式，保留 v0.1.15 的 4 SBI 固定位置结构**。根因：v0.1.15 把 4 个独立 SBI 渲染成"数字内置彩色块"（白字数字 + `statusBarItem.*Background` 主题色块），用户反馈"色块效果不如圆点好看"，要求恢复 v0.1.14 的圆点 emoji 样式。v0.1.14 的单 SBI 拼接 `🟢N 🟡N 🔵N 🔴N` 有位移问题（任何数字宽度变化都会让整行左右挪），v0.1.16 不能简单回退——而是**合流**：视觉切回球（v0.1.14 验证好看）+ 架构保留 4 SBI 独立 slot（v0.1.15 验证位置稳定）。每灯 text 改为 `<球><数字>`（如 `🟢3`、`⚪0`），球自带色——🟢🟡🔵🔴 是预填充彩色的 Unicode 字符，**移除了 v0.1.15 的 `backgroundColor` 色块 + `color` 白字赋值**。

### 变更（Changed）

- **视觉原语：彩色块 → emoji 球**：v0.1.15 每灯 text 是数字本身（`0`/`1`/`2`/`3`/`N`）+ 主题色块背景 + 白字前景；v0.1.16 每灯 text 是 `<球><数字>`——非0 用该灯的彩球（CFG[k].em，🟢/🟡/🔵/🔴 之一）+ 数字，0 用共享灰球 ⚪（DIM_EM）+ "0"。球 emoji 自带颜色（绿/黄/蓝/红/灰），无需主题色块、无需白字。
- **位置固定（v0.1.16 核心优势，沿用 v0.1.15 4 SBI 架构）**：每 slot 长度恒为 `<球><1数字>`（数字都是 1 字符：0-3 或 N），无论计数怎么变化，4 个 slot 的位置永远不动。v0.1.14 的单 SBI `🟢N 🟡N 🔵N 🔴N` 拼接会让整行因数字宽度变化而左右位移（如某灯 9→N，整行短 1 字符，后续灯全往左挪）；4 SBI 把每灯放进独立 slot，slot 之间是状态栏标准间隔，是"4 个独立徽章"观感而非黏在一起的色带。
- **`SBI_LIGHTS_CFG` 表 `bg` → `em`**：`{key,bg,pri}` 改为 `{key,em,pri}`，每灯的 `bg`（ThemeColor id 如 `statusBarItem.remoteBackground`）被 `em`（emoji codepoint 如 `\u{1F7E2}` 🟢）取代。新增 `SBI_DIM_EM` 常量（共享"灭"球 ⚪ `\u{26AA}`）。两个表都通过 `JSON.stringify` 烘焙进 IIFE 的 `var CFG=[...]` + `var DIM_EM=...`，emoji codepoint 以 `\uXXXX` 代理对形式出现在 IIFE 源码（ASCII-only）。
- **创建循环简化**：每个 `createStatusBarItem` 不再设 `.color` / `.backgroundColor` / `new vs.ThemeColor(...)`，只设 `.text`（初始 `DIM_EM+"0"` = `"⚪0"`，固定 slot 宽度避免 500ms 不可见窗口）+ `.tooltip` + `.command` + `.show()`。删 `litBgs` 数组（4 个 ThemeColor 缓存）+ `dimClr`（deactivatedForeground ThemeColor）。
- **per-tick 更新简化**：每个 SBI 的 mutate 不再触碰 `.color` / `.backgroundColor`，只 mutate `.text`（`(n===0?DIM_EM:CFG[k].em)+(n>=4?"N":""+n)` → `🟢3` / `⚪0` / `🟡N`）+ `.tooltip` + `.show()`。保留 v0.1.15 round-4 的 per-iteration try/catch + lastKey short-circuit memo（位置稳定性 + 性能优化不变）。删 `__ccsdSbiLitBgs` / `__ccsdSbiDimClr` 全局缓存（无 ThemeColor 要缓存）。
- **`onDidDispose` 简化**：最后 panel 退出时仍 dispose 全部 4 SBI + 清 timer，但不再 null-reset `__ccsdSbiLitBgs` / `__ccsdSbiDimClr`（这两个全局已不存在）。保留 `__ccsdSbis=null` + `__ccsdSbiLastKey=null` 的清理。
- **IIFE 版本戳 `v0.1.15` → `v0.1.16`**：已 patch 的 v0.1.15 装在下次 install 时被检测为 STALE（version 不符 + hash 不符双重保护）→ 自动从 `extension.js.bak` 还原并重注入新 emoji-ball IIFE。

### 保留（Preserved，v0.1.14/v0.1.15 设计改进完整沿用到 v0.1.16）

- **🔵 pending 第 4 灯**（writer 的 `Notification` hook case + reader 独立计数 + 与 state 正交）。
- **done/running/interrupted 三路陈旧会话 GC**：done >5min→idle（§4）；running mtime >30min→idle（§7.2，变量名 `SBI_RUNNING_STALE_MS` 保留）；interrupted mtime >24h→idle（`INTERRUPTED_RETENTION_MS`）。per-tab 渲染**不应用**后两条，聚合层应用。
- **pending 与 idle GC 联动**：`j.pending===true && st!=="idle"`——防止被强杀的权限弹窗会话在 🟡 不计的同时 🔵 仍假粘。
- **聚合单例 + panel 计数 lifecycle**：`__ccsdSbis`（4 元素数组） + `__ccsdSbiTimer` 窗口级单例；`__ccsdPanelCount` 入口 +1 / `onDidDispose` -1，归零时清理（v0.1.16：遍历 4 slot dispose）。
- **三层独立 try/catch 隔离**：(1) 4-SBI 创建（循环）；(2) 单例 timer 注册；(3) aggregation body。
- **per-tab 4 态色点、`__ccsdPending` yield、notify、`__ccsdTitle` 刷新**：完全不变。
- **cap() 截顶规则不变**：`cap(n){return n>=4?4:n}`，0-3 passthrough、4+ 截到 4 触发 "N" 变体。
- **tooltip 文案不变**：`Claude Code: X done, Y running, Z pending, W interrupted`（未截顶的真实计数）。
- **click command 不变**：`ccStatusDot.sbiClick` runtime 注册，handler 读 `__ccsdSbis[0].tooltip` 弹 InformationMessage。

### 改进（Improved）

- **渲染路径更简单**：v0.1.15 每 tick 要分配/缓存 4 个 ThemeColor 实例 + 切换 lit/dim 翻转（白字+色块 vs 灰字+透明）；v0.1.16 直接读 CFG[k].em / DIM_EM（字符串字面量），无 ThemeColor、无缓存、无翻转。代码量减少，可读性提升。
- **视觉回到用户喜欢的球**：v0.1.14 的 emoji 球反馈正面（用户要的样式），v0.1.16 在保留位置稳定性的同时恢复此样式。

### 已知限制（回归 v0.1.14 同款）

- **重新依赖 emoji 字体栈**：v0.1.15 改用 ThemeColor 块**完全跟随 VSCode 主题色**，跨平台稳定；v0.1.16 切回 emoji 球，重新引入 v0.1.14 同款的 emoji 字体依赖——Win7/无 emoji 字体的 Linux/headless 环境可能黑白或豆腐块。macOS（Apple Color Emoji）/ Windows 10+（Segoe UI Emoji）/ 主流 Linux（Noto Color Emoji）正常显示彩色。这是用户审美的有意取舍：球好看 > 跨平台一致。
- **形状是 emoji 字形正圆**：相比 v0.1.15 的 SBI 圆角矩形块，v0.1.16 的球是 emoji 字体提供的正圆 glyph（在支持的字体下）。不再是 SBI 容器的 CSS 圆角——视觉更"球"。

## [0.1.15] - 2026-07-18

**底部 SBI 4 灯：把数字内置到彩色块里**。根因：v0.1.14 用单个 SBI 渲染 `🟢N 🟡N 🔵N 🔴N`（emoji 球 + 数字作为分开的 token 挤在一个 `StatusBarItem.text` 里），用户反馈"球+数字分开"不满意，要"数字直接内置在彩色块里"。VSCode `StatusBarItem.backgroundColor` 字段类型是 `ThemeColor | undefined`（**不接 hex 字符串**——已核对 `mainThreadStatusBar.ts` `$setEntry` 签名），所以"4 块用任意 hex"不可能；但前景 `color` 接 `string | ThemeColor`，故**白字数字 + ThemeColor 彩色背景**可行。v0.1.15 **拆成 4 个独立 SBI**（每灯一个 `createStatusBarItem`），每块 text 就是数字本身，count>0 时块亮（`backgroundColor=ThemeColor` + `color="#ffffff"` 白字），count=0 时块暗（透明底 + `statusBarItem.deactivatedForeground` 灰字 `"0"`，块仍可见）。

### 变更（Changed）

- **单 SBI → 4 SBI**：`globalThis.__ccsdSbi`（单个 StatusBarItem）→ `globalThis.__ccsdSbis`（4 元素数组）。IIFE 遍历 `CFG`（新增配置表 `SBI_LIGHTS_CFG`）创建 4 个 `createStatusBarItem(StatusBarAlignment.Left, pri)`，priority `-9996`/`-9997`/`-9998`/`-9999` 让 4 块并排在 Left 项最右端（done 最左 / interrupted 最右——priority 越高越靠左）。`onDidDispose` 最后一个 panel 退出时遍历 4 块逐个 `dispose()` 并置数组为 null。
- **数字内置彩色块**：每块 text = `n===0?"0":(n>=4?"N":""+n)`；count>0 → `backgroundColor=new ThemeColor(CFG[k].bg)` + `color="#ffffff"`；count=0 → `backgroundColor=undefined`（透明）+ `color=new ThemeColor("statusBarItem.deactivatedForeground")`（灰）。v0.1.14 的 `disp(em,n)` / `var EM=[🟢,🟡,🔵,🔴]` / `var DIM=⚪` / `var text=disp(...).join(" ")` 全部删除——4 块各自独立，无拼接。
- **4 个内置 `statusBarItem.*Background` 主题色**（`SBI_LIGHTS_CFG` patch.ts 单一真相源，`JSON.stringify` 烘焙进 IIFE 的 `var CFG=[...]`）：
  - 🟢 done → `statusBarItem.remoteBackground`（绿；SSH/WSL 远程指示器色，所有内置主题里都是绿）
  - 🟡 running → `statusBarItem.warningBackground`（黄/橙；VSCode 1.66 加入的 SBI 警告色）
  - 🔵 pending → `statusBarItem.prominentBackground`（饱和蓝；少数深色主题偏紫，仍可区分）
  - 🔴 interrupted → `statusBarItem.errorBackground`（红；标准 SBI 错误色）
- **click handler 适配 4 块**：`ccStatusDot.sbiClick` 的 handler 改读 `globalThis.__ccsdSbis[0].tooltip`（4 块共享同一 tooltip，每 500ms 刷新）。4 块的 `.command` 字段都设为该 ID，点击任一块都弹 `InformationMessage`。
- **`SBI_LIGHTS` / `SBI_DIM_EMOJI` / `SBI_LEFT_PRIORITY` 常量删除**：被 `SBI_LIGHTS_CFG`（`{key,bg,pri}` 表）取代。`SBI_CLICK_CMD` 不变。
- **IIFE 版本戳 `v0.1.14` → `v0.1.15`**：已 patch 的 v0.1.14 装在下次 install 时被检测为 STALE（version 不符 + hash 不符双重保护）→ 自动从 `extension.js.bak` 还原并重注入新 4-SBI IIFE。

### 保留（Preserved，v0.1.14 设计改进完整沿用到 v0.1.15）

- **🔵 pending 第 4 灯**（writer 的 `Notification` hook case + reader 独立计数 + 与 state 正交）。
- **done/running/interrupted 三路陈旧会话 GC**：done >5min→idle（§4）；running mtime >30min→idle（§7.2，变量名 `SBI_RUNNING_STALE_MS` 保留）；interrupted mtime >24h→idle（`INTERRUPTED_RETENTION_MS`）。per-tab 渲染**不应用**后两条，聚合层应用。
- **pending 与 idle GC 联动**：`j.pending===true && st!=="idle"`——防止被强杀的权限弹窗会话在 🟡 不计的同时 🔵 仍假粘。
- **聚合单例 + panel 计数 lifecycle**：`__ccsdSbis`（4 元素数组） + `__ccsdSbiTimer` 窗口级单例；`__ccsdPanelCount` 入口 +1 / `onDidDispose` -1，归零时清理（v0.1.15：遍历 4 块 dispose）。
- **三层独立 try/catch 隔离**：(1) 4-SBI 创建（循环）；(2) 单例 timer 注册；(3) aggregation body。
- **per-tab 4 态色点、`__ccsdPending` yield、notify、`__ccsdTitle` 刷新**：完全不变。

### 改进（Improved）

- **配色跨平台稳定**：v0.1.14 及更早的 🟢🟡🔵🔴 emoji 在 Win7/无 emoji 字体的 Linux/headless 可能黑白或豆腐块；v0.1.15 改用 `statusBarItem.*Background` ThemeColor，**完全跟随 VSCode 主题色**，跨平台稳定。这是 v0.1.15 相对 v0.1.14 的额外收益（用户要的是"数字内置块"，附带消除了 emoji 字体依赖）。

### 已知限制

- **形状是圆角矩形不是正圆**：VSCode `StatusBarItem` 无 `border-radius` API、无 overlay API——"球状块"在 SBI 限制下接受最接近方案（SBI 容器自带的轻微圆角矩形）。每块约 25-30px 宽，4 块约 110-130px 总宽。
- **`prominentBackground` 在少数深色主题偏紫**：🔵 pending 块在大多数主题是饱和蓝，某些深色主题可能偏紫；仍可与绿/黄/红区分。若不爽可在 `SBI_LIGHTS_CFG` 一处改为 `editor.selectionBackground` 或 `activityBarBadge.background`。
- **`statusBarItem.remoteBackground` 语义复用**：这个色本意是"远程 SSH/WSL 指示器"，我们借色不借义。若用户自定义了这色（覆盖 SSH 按钮色），我们的"done 绿"会跟着变——这其实是 feature（主题一致），不是 bug。

## [0.1.14] - 2026-07-18

**commandCenter 4 灯回退到底部 SBI 4 灯**。根因：v0.1.13 的 commandCenter 顶部居中 4 灯在 Reload Window + 完全重启 VSCode 后**根本不显示**——失败面太多（VSCode commandCenter 可见性开关、标题栏宽度预算、setContext→when 滤链、IIFE 仅在 CC panel 打开时才触发），在没有 VSCode 集成测试架的情况下无法定位。v0.1.12 的底部 SBI（动态 text）此前已验证可靠。v0.1.14 **保留 v0.1.13 全部设计改进**（新增 🔵 pending 第 4 灯、done/running/interrupted 三路陈旧会话 GC、pending 与 state 独立计数），**仅切换显示载体**回到单个运行时 `StatusBarItem`（`StatusBarAlignment.Left` + 极负 priority `-9999` → 在 Left 项里最靠右、最接近可见中心）。

### 变更（Changed）

- **IIFE 顶部 4 灯（commandCenter）→ 底部 4 灯（SBI）**：删 `globalThis.__ccsdCcTimer` + 4 个 `setContext` 推送 + `onDidDispose` 内的 4 个 setContext 重置；改为单个 `globalThis.__ccsdSbi = vs.window.createStatusBarItem(vs.StatusBarAlignment.Left, -9999)`，IIFE 每 500ms 直接 mutate `.text` / `.tooltip` / `.show()`。文本格式 `🟢N 🟡N 🔵N 🔴N`（count 0 → ⚪ 暗；1/2/3 → 彩色 + 空格 + 数字；>=4 → 彩色 + ` N`，`cap()` 截到 4）。tooltip 承载未截顶的真实计数（`X done, Y running, Z pending, W interrupted`）。`onDidDispose` 最后一个 panel 退出时 `clearInterval(__ccsdSbiTimer)` + `__ccsdSbi.dispose()`——SBI 不会冻结在陈旧计数。
- **click 反馈：20 个 package.json command → 1 个运行时 `registerCommand`**：删 `ccStatusDot.<key>.<variant>` 20 个命令的 package.json contrib + IIFE 注册块；改为单个 `ccStatusDot.sbiClick`，通过运行时 `vs.commands.registerCommand` 注册（`registerCommand` 无需 package.json contribution 即可被 `executeCommand` 查到），handler 把当前 tooltip 作 `InformationMessage` 弹出。`__ccsdSbiCmdRegistered` 守卫防同 host 重注册抛错。
- **install 不再 patch CC `package.json`**：删 `buildCcContribs` / `patchPackageJson` / `writePkgInject` / `injectedPkgVersion` / `injectedPkgHash` / `currentPkgHash` 及 `PKG_HASH_FIELD` 常量、`--check-pkg-contribs` dev flag、`test-pkg-contribs.mjs`、`test-smoke-v0.1.13.mjs`（两个测试都覆盖被移除的 install-side commandCenter contribs / setContext 端到端）。保留 `PKG_MARKER_FIELD` (`__ccStatusDotPkgManaged`) 常量 + `isPackageJsonPatched` + `restorePackageJson`，**仅用于检测并清理 v0.1.13 残留**——install 在 patch extension.js 前若发现 package.json 仍带 v0.1.13 marker，自动从 `package.json.bak` 还原（v0.1.13 升级用户重跑 `npx vscode-claude-code-status-dot` 即清理，无需先 `--revert`）；`--revert` 同样清理残留。
- **`SBI_LIGHTS` / `SBI_DIM_EMOJI` 取代 `CC_LIGHTS` / `CC_DIM_EMOJI` / `CC_COUNT_VARIANTS` / `CcLight`**：去掉 `key`（不再需要 setContext key 后缀）与 `variant` 维度（不再需要 5 种 text 变体）；只保留 emoji + tooltip。emoji 通过 `JSON.stringify` 烘焙进 IIFE 的 `var EM=[...]` + `var DIM="..."`，IIFE 源码仍不含原始 `\u{...}` 转义。
- **IIFE 版本戳 `v0.1.13` → `v0.1.14`**：已 patch 的 v0.1.13 装在下次 install 时被检测为 STALE（version 不符）→ 自动从 `extension.js.bak` 还原并重注入新 SBI IIFE（hash 也会变，双重保护）。

### 保留（Preserved，v0.1.13 设计改进完整沿用到 v0.1.14）

- **🔵 pending 第 4 灯**（writer 的 `Notification` hook case + reader 独立计数 + 与 state 正交）。
- **done/running/interrupted 三路陈旧会话 GC**：done >5min→idle（§4）；running mtime >30min→idle（§7.2，变量名 `SBI_RUNNING_STALE_MS` 保留）；interrupted mtime >24h→idle（`INTERRUPTED_RETENTION_MS`，§7.5）。per-tab 渲染**不应用**后两条（tab 保持黄/红提醒），聚合层应用——用户可肉眼看到具体哪个 tab 是黄/红并自行处理。
- **pending 与 idle GC 联动**：`j.pending===true && st!=="idle"`（`st` 是上面三条 decay 规则**已修正过**的值）——防止被强杀的权限弹窗会话 state=running/pending=true/mtime>30min 在 🟡 不计的同时 🔵 仍假粘 1。
- **聚合单例 + panel 计数 lifecycle**：`__ccsdSbi` + `__ccsdSbiTimer` 窗口级单例（P 个 panel 共享 1 个 timer）；`__ccsdPanelCount` 入口 +1 / `onDidDispose` -1，归零时清理。
- **三层独立 try/catch 隔离**（v0.1.12 round-3 review 沿用）：(1) SBI 创建；(2) 单例 timer 注册；(3) aggregation body。任何一层失败都不会传播到 CC 的 `update_session_state` handler，也不影响 per-tab 主链路。
- **per-tab 4 态色点、`__ccPending` yield、notify、`__ccTitle` 刷新**：完全不变。

### 移除（Removed）

- **commandCenter 顶部居中 4 灯**：v0.1.13 的 `contributes.menus.commandCenter` 20 项 + `contributes.commands` 20 项 + `contributes.menus.commandPalette` 20 项 hide。install 自动清理残留；`--revert` 也清理。
- **`setContext` 驱动**：`vs.commands.executeCommand("setContext","ccStatusDot.<key>",N)` 全部删除（包括 `onDidDispose` 内的 4 个重置）。SBI 直接 mutate text，无需 context key 中介。

### 已知限制

- **emoji 颜色保真度依赖 OS 字体栈**：🟢🟡🔵🔴⚪ 在 macOS 走 Apple Color Emoji 彩色，Win10+ Segoe UI Emoji 彩色；Win7/无 emoji 字体的 Linux/headless 可能黑白或豆腐块。颜色丢失时形状 + 数字仍承载信息（与 v0.1.12-v0.1.13 同款差异）。
- **SBI 位置受状态栏拥挤度影响**：极负 priority 让 SBI 在 Left 项里最靠右、最接近可见中心，但若用户装了大量其它 Left 项 SBI 仍可能被挤到角落——这是 StatusBarItem API 限制（无真正的"居中"槽位）。
- **click command 需 IIFE 注册**：reload 后若用户未打开 CC panel，`ccStatusDot.sbiClick` 未注册，此时点 SBI 不响应（VSCode 静默 no-op）。但 SBI 本身也未创建（IIFE 仅由 panel 打开触发），所以一致性 OK。

## [0.1.4] - 2026-07-17 — archival note

> 历史记录：v0.1.4 时代「完成/中断通知不生效」修复（`notifyWhenFocused` 默认 false→true + 通知触发改为 `since` 时间戳去重 + macOS `osascript` 引号/反斜杠转义）。这些修复已合入 v0.1.5+ baseline 并由后续版本继承；此条目保留为档案，不再单独维护。

- **macOS `osascript` 系统通知被特殊字符静默打断**：`__ccTitle`（注入到通知文案）若含 `"` 或 `\`，原代码把 `msg` 直接拼进 AppleScript 字符串字面量 → `osascript` 语法错 → 被 `try/catch` 吞掉，系统通知不弹（VSCode 消息仍弹，但前台被抑制时则全军覆没）。改为先用 `replace(/["\\]/g, c => "\\"+c)` 转义再拼。已用 `osascript -e` 实跑含引号/反斜杠标题验证通过。

## [0.1.3] - 2026-07-17

减法 + 重做版本：去掉「聚合色块条」webview 注入，把 running 从 0.1.2 的「2 帧大跳变」重做为「8 帧正弦渐变 + 三角波」的流畅呼吸，并铺设 IIFE 版本戳以便后续升级能正确重注入。

### 变更（Changed）

- **running 改为流畅呼吸**（`#8A6A00` 暗 ↔ `#FFD60A` 亮，8 帧正弦 ease-in-out 渐变）。0.1.2 的呼吸只有 2 帧（dim↔bright）——两帧色差大、1500ms/帧的离散切换视觉上更像闪烁。0.1.3 改为 8 帧（相邻帧每通道 Δ ≤ ~10%），用 14 步三角波播放（`0,1,2,3,4,5,6,7,6,5,4,3,2,1`），峰值（亮）/谷值（暗）各一次，其余帧各两次/周期。`TICK_MS` 由 500 调整为 450：14 步 × 450ms = **~6.3s 一个呼吸周期**（缓慢、肉眼连续渐变）。interrupted 仍走 `seq%2` 快闪（450ms on/off，仍是告警级快闪，仅比旧的 500ms 快 10%，肉眼无感）。
- **`TICK_MS`：500 → 450**（同时驱动呼吸切帧、interrupted 快闪、done→idle 5 分钟轮询、prevSt 转换检测）。

### 移除（Removed）

- **聚合状态条 webview 注入**（v0.1.2 引入的右下角色块条）：`patchWebview` / `buildWebviewJsIIFE` / `buildWebviewCss` 及相关常量（`ACQUIRE_RE` / `WV_JS_MARKER` / `WV_API_MARKER` / `WV_CSS_MARKER`）全部删除。每个 session 的状态由 tab 图标四态点 + 完成/中断通知完整表达；色块条是冗余而非增量信息，且在 webview `index.js`/`index.css` 上独立打补丁，维护成本与脆弱性都高于 extension.js 的 iconPath 注入。
- **旧 running 静态/2 帧呼吸 SVG**：v0.1.0/0.1.2 的 `claude-logo-running.svg`（静态 `#CCA700`）/ `claude-logo-running-dim.svg` / `-1.svg` / `-2.svg` / `-bright.svg` 等均删除，由新的 8 帧 `claude-logo-running-{0..7}.svg` 取代。`OUR_SVGS` 变为 11 个（idle + 8 running 帧 + done + error）。
- IIFE 注入中的聚合桥（`readdirSync` 多 session 聚合 / `postMessage` 推 webview / `onDidReceiveMessage` 监听 `cc_focus_session`）删除。

### 新增（Added）

- **8 帧 running 呼吸 SVG**：`claude-logo-running-0.svg` … `claude-logo-running-7.svg`，色值按 `sin(i·π/14)` 正弦插值（i=0..7）：`#8A6A00` `#A48202` `#BD9904` `#D3AD06` `#E5BE08` `#F3CB09` `#FCD30A` `#FFD60A`。
- **IIFE 切帧逻辑**：注入块内 bake 进 `RUN_FRAMES`（8 帧文件名数组）+ `RUN_IDX`（14 步三角波索引数组）两个常量，running 分支 `svg = RES/RUN_FRAMES[RUN_IDX[seq%14]]`。周期可调（改 `RUN_IDX` 或 `TICK_MS`）。
- **install 自动清理旧聚合条**：install 时检测 webview 仍带 v0.1.2 注入标记（`cc-status-bar-injected` 墓碑注释）→ 自动从 `.bak` 还原 webview。v0.1.2 用户重跑 `npx vscode-claude-code-status-dot` 即升级即清理，无需先手动 `--revert`。
- **install 清理过期 SVG**：`installRuntimeFiles` 收尾时扫描 `INSTALL_DIR/resources`，删除任何不在 `OUR_SVGS` 内的 `claude-logo-*.svg`（只清自身命名空间，安全）。升级时也会清掉旧的静态 `claude-logo-running.svg`。
- **IIFE 版本戳**：注入块首行 banner 改为 `/*cc-status-dot-injected:v0.1.3*/`。`patchExtension` 检测到旧版本 IIFE（marker 在但版本缺失或偏旧）时，自动从 `.bak` 还原并完整重注入——避免「bare marker 命中 → 跳过 → 旧 IIFE 逻辑残留」的静默回归。`--status` 同步报告 `injected IIFE: <ver>` 行，旧版标注 STALE。
- **`--status` 输出新增 `injected IIFE` 行**：显示当前注入版本，旧版/无版本戳标 STALE 提示重跑。

### 保留（ unchanged，未误伤）

- `notify`（done/interrupted 完成/中断通知，依赖 prevSt 转换检测 + focused 抑制 + macOS osascript + 声音）
- workflow / 后台 subagent 跑期间保持 running（`Stop`/`SubagentStop` 权威裁定 + `activeSubagents` 早信号）
- `done` 超 5 分钟由 reader 渲染为 `idle`
- 持久化 `INSTALL_DIR`（删项目源 / 清 npx 缓存 / CC 自动更新都不影响已 patch 扩展）
- `hookCommand(process.execPath)` 绝对路径（macOS Finder/Spotlight 启动的 PATH 兜底）
- `--revert` 链路完整（restoreExtension → restoreWebview → unwireHooks → removeInstallDir → reportResidualBaks，保留 STATE_DIR 用户数据）

## [0.1.0] - 2026-07-10

初版发布。

### 新增

- 四态 session tab 图标：`idle`（灰 `#808080`）/ `running`（黄 `#CCA700`↔`#FFD60A` 呼吸）/ `done`（绿 `#3FB950`）/ `interrupted`（红 `#F85149` 快闪）。
- `permission` 态交由 Claude Code 原生蓝点处理；注入 reader 在无状态文件 / 状态未知时 `return` 不覆盖，CC 蓝点自然显示。
- hooks 状态源：`hooks/cc-status.js`（Node 跨平台零依赖，读 stdin JSON），按 session 写 `~/.claude/cc-tab-status/<session_id>.json` = `{state, since, error?}`（原子写，目录自动创建）。
- 接线 6 个 CC hook 事件：`UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `StopFailure` / `SessionEnd`。
- patcher `npx tsx patch.ts`：发现 CC 扩展、备份 `extension.js`、anchor 唯一性校验、注入 IIFE（500ms 重绘定时器）、自动写 `~/.claude/settings.json` hooks（幂等带标记）、校验 5 个 SVG。
- 5 个 SVG：`claude-logo-idle.svg` / `claude-logo-running.svg` / `claude-logo-running-bright.svg` / `claude-logo-done.svg` / `claude-logo-error.svg`（按绝对路径引用本项目 `resources/`，CC 更新不丢）。
- `done` 超 5 分钟由 reader 自动渲染为 `idle`。
- `--revert`：从 `extension.js.bak` 干净还原 `extension.js`，并基于标记精确移除 `settings.json` 中的 hooks（不影响其它 hook）。
- `--status`：dry-run 报告（CC 版本 / 是否已 patch / hooks 是否接 / SVG 是否齐 / 状态目录）。

> 注：0.1.0 的「呼吸」「5 个 SVG」描述已于 [0.1.3] **更新**：running 改为 8 帧正弦渐变 + 三角波的流畅呼吸（取代 0.1.2 的 2 帧大跳变），SVG 增至 11 个；6 hook 事件也于后续版本扩展为 8 个（增加 `SubagentStart` / `SubagentStop`）。

### 已知限制

- 手动 Esc 中断无 hook，状态停在 `running`，靠下一次 `UserPromptSubmit` / `Stop` 自然更正。
- CC 自动更新覆盖 patched `extension.js`，需重跑 patch。
- minified anchor 的版本脆性：anchor 失配时报错拒写，引导提 issue。
