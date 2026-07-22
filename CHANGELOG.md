# Changelog

本项目的显著变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [0.5.2] - 2026-07-22

**证据驱动修 4 件用户反馈 + 审计 findings。** 5 路对抗调研定位根因：#1 蓝→黄闪（writer 内容启发式对调研报告尾问过触发）、#2 焦点被抢（**证据排除——非插件锅**）、#3 拷贝延迟（**证据排除——非插件锅**，但顺手移除死调试日志器）、#4 长黄→灰（per-tab/聚合 decay 阈值分歧 + `since` 键对活动 workflow 假阳性）。审计另修 F4（死 decay 三元），记录 F5/F6/F7 为 LOW 延期。

### Fixed — Issue #4 长黄→灰 + decay 根治（HIGH，根因修非仅对齐数字）

- **decay 阈值统一**：`SINCE_STALE_MS`（per-tab 15min）退役；per-tab §H tick 与聚合 §F tick 现在**共用单一 `SBI_RUNNING_STALE_MS`（30min）**。消除 15-30min 窗口"tab 已 ⚪ 灰、底部 🟡 仍黄"的不一致（用户实测痛点）。
- **decay key 从 `since` 转移时间 → 加 transcript 活动门（根因修）**：新增 IIFE helper `__ccsdTranscriptFresh(j,sid,staleMs)`——降级前先 stat 会话 transcript（`.jsonl`）mtime，若在阈值内有写入（仍在流式输出 assistant token）则**不降级**。长 turn / 等 subagent 会冻结 `since`（无 mid-tool heartbeat）但 jsonl 持续增长，故活动 workflow 不再假阳性转灰。路径解析镜像 `computeLiveDelta`（`transcript_path` 优先，cwd-escape 兜底）。stuck-drift 案例（伪 Stop heartbeat 只刷状态文件 mtime 不刷 transcript）→ transcript 仍陈旧 → since-decay 仍正常触发（v0.2.6 修复完整保留）。statSync 仅在 since 已过阈的 decay-candidate 上触发，开销有界。
- **残余缺口**（文档化）：单个工具执行 >30min 且**无流式输出**（长静默 Bash / `sleep 1800`）期间 jsonl 不增长 → 活动门无效 → 仍假阳性；下一个 PreToolUse/PostToolUse 刷新 `since` 后恢复。完全根治需 CC 提供 mid-tool heartbeat（未来）。
- **F4 死代码移除**：§H SVG 选择的 running/done decay 三元（v0.2.6 round-2 把 decay 移到 pending check 之前后，这里的 idle 分支已成死代码）移除，单一 decay 站点消除 copy-paste-with-divergence。

### Fixed — Issue #1 蓝点闪（writer 内容启发式对报告尾问过触发，MEDIUM）

- **`hooks/cc-status.js` `lastMessageRequestsUserInput` fallback 收窄**：用户案例（长调研报告 + "要不要继续？"）走 fallback 路径（AWAIT_USER_PHRASES 习语表无 "要不要/是否继续"）。fallback 的 `USER_DIRECTED_RE` 拆为 **HARD**（你/您/you/确认/决定/选/should I/shall I/can you/could you/may I——高精度，无视正文长度始终胜）vs **SOFT** 续问词（继续/需要/想要/proceed/continue/need/want——低精度，当尾问行前的正文 > `REPORT_CLOSER_BODY_CHARS=120` 字符时判为报告结尾 → `false`）。bare `confirm`/`choose` 从 fallback 删除（其常见形式 "please confirm"/"could you confirm"/"you choose" 已被习语表覆盖）。习语表（`AWAIT_USER_RE`）**不动**——仅收紧用户案例实际命中的 fallback 路径。
- **保留的设计意图**：§AA.3（"请确认是否继续"→true，HARD 习语）/§AA.7（"Should I proceed?"→true，HARD）/§AA.8（独立短问"需要继续吗？"→true，SOFT 短正文）。不可消除的残余：CC 在一个**真实**独立问句后立即自动续跑，仍会蓝→黄闪——那是 CC 事件序，内容过滤器无法 ex ante 判知。

### Changed — Issue #3 死调试日志器移除（MEDIUM，F3）

- **移除 `__ccsdDbg` + `_panel-debug.log` + `__ccsdRenderMap`**（`patch.ts` IIFE）：该日志器自承注释 "v0.2.9-debug...Remove after root cause confirmed + fix landed"，Q7 修复已于 v0.2.9.1 落地（移除 `__ccsdPending` yield）但日志器漏删，存活到 v0.5.1。取证 857KB `_panel-debug.log`（14716 ELSE + 11873 NOSID 事件）证伪其"罕见"注释——持续 6 次/秒无节流 `fs.statSync`+`fs.appendFileSync` 打在 EH 热路径（不在 §9 性能预算内）。纯删除（日志只写不读，grep 确认无运行时读者）。用户可删 `~/.claude/cc-tab-status/_panel-debug.log`。

### Not Fixed — Issue #2 焦点被抢 & Issue #3 拷贝延迟（证据排除，非插件锅）

- **#2 焦点**：穷举 grep 两个 500ms tick body + companion 2s 轮询的抢焦点 API（`executeCommand`/`.reveal(`/`.focus(`/`clipboard`/`showTextDocument`/`activeTextEditor`/`showQuickPick`/`showInputBox`）→ 热路径**零命中**；插件从不碰 `panelTab.webview`（CC 输入框住在该 iframe 内）→ 物理上无法聚焦 CC 输入框。仅用户点击触发的命令（favOpen/QuickPick）才调 reveal/showTextDocument。焦点抢最可能是 CC 自身 webview React 在流式 chunk 重渲染时 re-focus `<input>`。**不改代码**；确认法：禁用 companion 扩展复测，若焦点仍被抢则 100% 非本插件。
- **#3 拷贝延迟**：EH（IIFE 所在）与 renderer（CC 输入框/剪贴板）进程隔离；per-500ms-tick 同步 I/O 实测 0.28ms（0.056% budget）不可能拥塞 renderer 文本输入。`ccuri` Uri 缓存健康（同路径复用同一 Uri → VSCode EH 侧 iconPath setter 引用相等去重 → 稳态 ~0 IPC/sec）；热路径不碰剪贴板。延迟更可能来自 CC webview 流式 token 渲染负载。**不改 tick**（降频/异步化不会缓解 renderer 侧延迟，反牺牲状态点响应性）。唯一真实 tick-perf 缺陷是 #3 的死日志器（已修）。

### Tests

- **`hooks/test-iife.mjs`**：IIFE.21c stamp v0.5.1→v0.5.2；IIFE.12b/12c 重写（__ccsdDbg 移除后的 no-sid/else 路径 regex）+ 新增 IIFE.12b2（__ccsdDbg/`_panel-debug.log`/`__ccsdRenderMap` 全 absent 的负面断言）；IIFE.12e per-tab running decay literal 改为 SBI_RUNNING_STALE_MS + `__ccsdTranscriptFresh` 门；IIFE.37b §F running decay regex 加 transcript 门；§18 decay 锁块整体重写——IIFE.46（SINCE_STALE_MS 全 IIFE absent）/IIFE.46a（`__ccsdTranscriptFresh` helper 定义）/IIFE.46b（SBI 引用 SBI_RUNNING_STALE_MS+INTERRUPTED_RETENTION_MS）/IIFE.46b2（per-tab 引用 SBI_RUNNING_STALE_MS+`__ccsdTranscriptFresh`，仍不引用 INTERRUPTED_RETENTION_MS）/IIFE.46c（F4 简化 running 分支 + 死三元 absent）/IIFE.46d（无 `var SINCE_STALE_MS=`）。
- **`hooks/test-cc-status.js`**：新增 §AA.22a-g 7 例（长报告+"要不要继续？"→false；长报告+"请确认是否继续"→true HARD 习语；长报告+"是否继续？"→false SOFT；独立短问"需要继续吗？"→true；EN 长报告+"want to continue?"→false；中正文+"需要继续吗？"→true 阈下；EN 长报告+"Should I continue?"→true HARD）。`cc-status.js` banner hash 重算（9fa57b5c → 6027b21f，HOOK_VERSION v0.2.1 不变——hash 门检测 drift）。

### Version

- **版本 5-way pin** bump：`package.json` 0.5.1→0.5.2；`patch.ts INJECT_VERSION` v0.5.1→v0.5.2；`companion/package.json` 0.5.1→0.5.2（lockstep）；`companion/extension.ts MIN_PATCHER_VERSION` 0.5.1→0.5.2 + `injectVersion()` fallback v0.5.1→v0.5.2（test-version-sync.mjs 强制）。`HOOK_VERSION`（v0.2.1）不变；`cc-status.js` 内容变 → banner hash 重算。IIFE body bytes 变 → INJECT banner sha1 自动重算。
- **立场红线全守**：5 态点 / 4 灯 / permission / token SBI 既有 / Q1-Q7 / v0.2.8 src/v0.3.1 nonce/v0.4.0 收藏视图+导航 / v0.5.0 金线+右键 / v0.5.1 内联速率 全保留；IIFE 括号配平。
- **LOW findings 记录延期**：F5（per-tab interrupted decay 7d 对齐——abandoned interrupted+pending 蓝点，7d 边缘场景）；F6（`__ccsdOffCache`/rate maps onDidDispose prune——跨 panel 共享 sid 的 prune 风险，`__ccsdRenderMap` 泄漏已随 F3 闭合）；F7（`decayState`/`statCache` 共享 helper 架构重构——独立 PR）。

## [0.5.1] - 2026-07-22

**三件修复 + i18n：token SBI 内联速率（图表移除）+ 右键 tab 修复 + companion package.nls 8 语言。** 实施前做了对抗调研（结论：速率本已内联——真正的诉求是"图表冗余 + 分隔符不一致"；右键 `resourceScheme == 'webview'` 是永久 false 因为 plain WebviewPanel 不填该 context key；package.nls 只覆盖 contributes 表面）。

### Fixed — Issue #2 右键 tab 收藏从未显示（HIGH，根因确认）

- **`companion/package.json` `editor/title/context` when 子句**：`resourceScheme == 'webview'` → `resourceScheme != 'file'`。根因：CC tab 是 plain `vscode.window.createWebviewPanel('claudeVSCodePanel', ...)`，而 plain WebviewPanel **不**把 `resourceScheme` context key 填为 `'webview'`（`'webview'` scheme 属于另一种罕见的 custom-editor-via-`openTextDocument` 机制）。CC tab 的 editor input 没有真实 resource URI，所以 `resourceScheme` 在 `editor/title/context` 里是**未定义/空** → `== 'webview'` 永久 false → 该项永远不渲染。这是长期 VSCode 行为（webview panels 不传播 `resource*` context keys；内嵌 iframe 用 `vscode-webview://` 但不暴露为 `resourceScheme`）。新门控 `resourceScheme != 'file'` 让项在 webview/untitled/output-style tabs（含 CC tab，无论其 scheme 解析成什么）上显，在普通 file-editor tabs 上不显（避免常见情况噪声）。`favToggleTab` handler 内 `globalThis.__ccsdActiveSid` 校验仍是 no-op 安全网（非 CC 会话信息提示）。
- **为何 setContext `ccStatusDot.ccTabActive` 是错的修法（rejected）**：在 `editor/title/context` 里，custom `setContext` keys 解析对的是 **ACTIVE editor**，不是被右键的 tab（只有内建 `resource*` keys 才 scope 到被右键的 tab）。所以全局 `ccTabActive=true`（CC panel 活跃时设）会 (a) 让用户右键非 CC tab 时该项也显，(b) 让用户右键非活跃/后台 CC tab 时该项不显。这个 ceiling 已记录在项目 memory 里。

### Changed — Issue #1 token SBI 内联速率（移图 + 分隔符对齐）

- **速率分隔符 space → `·`**（`patch.ts` §G tick）：`rateSuffix` 从 `(sp?" "+sp:"")+(nm?" "+nm:"")`（空格分隔，渲染 `12.3k tok ▂▄▆█ 1.2k/s`）改为 `[sp,nm].filter(...).join(" ")` 然后前缀 `" · "`（渲染 `12.3k tok · ▂▄▆█ 1.2k/s · ~$0.42`）。速率段现在与 cost 段在同一 divider 级别。
- **`rateDisplayMode` 默认 `both` → `numeric`**（`companion/package.json` schema default + IIFE `cfg.get("rateDisplayMode","numeric")` fallback）：SBI 更清爽；要 sparkline 的用户 opt-in `both`/`sparkline`。schema default 与 IIFE fallback 仍由 `test-version-sync.mjs` 锁死一致。
- **图表面板整体移除**（`patch.ts` §E.2 + §F QuickPick）：删 `showRateChart` / `__ccsdRateChartHtml` / `__ccsdRateChartCss` / `__ccsdRateChartJs` / `__ccsdGetNonce`（form C webview：pure-SVG + CSP nonce + 500ms postMessage timer）+ QuickPick `$(graph) Show live rate chart` entry + 对应 `else if(label.indexOf(tr("qpShowChartLabel"))>=0){showRateChart()...}` 分支 + 11 个 chart-only i18n key（qpShowChart*/ttRateTpl/ttSparklineHint/wv*，9 种 language）。SBI click 仍走 `showTokQuickPick`（v0.3.0 前行为），只是 QuickPick 里不再有图表入口。
- **速率采样 infra 保留**（`__ccsdRateSample` / `__ccsdRateFromBuf` / `__ccsdRateSpark` / `__ccsdRateFlush` / `__ccsdRateLoad` + `RATE_BUF_CAP`/`RATE_WINDOW_MS`/`RATE_FLUSH_MS` 常量 + `<sid>.rate` sidecar）：这些函数既驱动内联 tok/s 后缀，也提供 cross-reload 连续性；chart 只是它们的消费者之一，删 chart 不影响它们。setInterval 数从 3（`__ccsdSbiTimer` + per-panel tick + chart-panel msgTimer）回到 2。
- **§E.2 commentary + I18N_DICT 注释** 同步更新反映 chart 移除 + 速率采样 infra 保留。

### Added — Issue #3 companion package.nls 8 语言本地化

- **8 个 `companion/package.nls{,.zh-cn,.ja,.de,.es,.fr,.pt-br,.ru}.json`**：26 key/语言，覆盖 displayName/description/view name/contextualTitle/viewsWelcome contents/7 个 command title + shared category/configuration title/12 个 configuration property description。翻译对齐 IIFE `I18N_DICT` 既有术语（token→tok 不译、cost→费用/Kosten/coste/coût/custo/стоимость、session→会话/Session/sesión/session/sessão/сессия、Favorite→收藏/Favorit/Favorito/Favori/Favorito/Избранное）。
- **`companion/package.json` 26 处 user-visible literal → `%ccsd.*%` 引用**：所有 view/command/configuration 字符串。`main` field 不变；无 `extension.ts` 改动（VSCode 自动从 extension root 加载 nls 文件，locale fallback → en）。
- **关键差异**：package.nls **不**像 IIFE 那样 collapse `zh-cn→zh` / `pt-br→pt`（IIFE 通过 `split("-")[0]` 做），所以区域 filename `package.nls.zh-cn.json` / `package.nls.pt-br.json` 是强制的——否则该 locale 静默回退到 EN。
- **scope ceiling**：package.nls 只本地化 `contributes` 表面（views / command palette / Settings UI）。**不**本地化 `extension.ts` runtime 字符串（如 "no active Claude Code session..." 信息提示）—— 那需要 `vscode.l10n.t(...)` API + `package.nls.l10n.bundle.{locale}.json` 集，是独立更大的 scope，留作可选 follow-up。

### Tests

- **`hooks/test-iife.mjs`**：IIFE.66 setInterval 3→2（chart timer 移除）；IIFE.140 默认 `both`→`numeric`；IIFE.145-150/152/153a/b/c 删除（chart 断言）；新增 IIFE.145a-f（chart panel 已移除的负面断言：showRateChart/__ccsdRateChartHtml/__ccsdGetNonce/qpShowChartLabel/wvChartTitle/<svg literal 全 absent）；新增 IIFE.160（rate suffix 用 `·` 分隔符，镜像 cost divider）；IIFE.151 保留（`__ccsdRateFromBuf` helper 仍驱动 inline suffix）；IIFE.21c stamp v0.5.0 → v0.5.1；IIFE.141/142/143/144/136/137/138/139 全保留（速率采样 infra 完整）。
- **`hooks/test-favorites.mjs` FAV.31** 翻转：从断言 `resourceScheme == 'webview'` 改为断言 `resourceScheme != 'file'` 且 **不**含 `== 'webview'`（避免回归）。FAV.31a/b（config gate + default true）零改动仍有效。

### Version

- **版本 5-way pin** 同步 bump：`package.json` 0.5.0 → 0.5.1；`patch.ts INJECT_VERSION` v0.5.0 → v0.5.1；`companion/package.json` 0.5.0 → 0.5.1（lockstep）；`companion/extension.ts MIN_PATCHER_VERSION` 0.5.0 → 0.5.1 + `injectVersion()` fallback v0.5.0 → v0.5.1（test-version-sync.mjs 强制 MIN_PATCHER_VERSION + injectVersion fallback === companion package.json.version）。`HOOK_VERSION`（v0.2.1）+ `cc-status.js` hash 不变（writer 无改动）。IIFE body bytes 变 → INJECT banner sha1 自动重算。
- **立场红线全守**：5 态点 / 4 灯 / permission / token SBI 既有（总数/cost）/ Q1-Q7 / v0.2.8 src/v0.3.1 nonce/v0.4.0 收藏视图+导航 / v0.5.0 金线+右键（修后）全保留。

## [0.5.0] - 2026-07-22

**Favorites tab 右键 + 金线下划线标记：tab 右键直接 star/unstar + 收藏会话的 tab icon 底部加细金线。** 推翻 v0.4 设计 §5 Slice 2 的"先做 PoC"推迟理由——`resourceScheme == 'webview'` 已是 VSCode 暴露的最精确 context key（无 CC 专属 key，handler 内 `__ccsdActiveSid` 校验是唯一过滤器，非 CC webview no-op）。Q3 方案 (a) 落地：每 panel 只一个 iconPath 槽，5 state × 1 favorited = 10 SVG（base 5 不动 + 5 -fav 变体加金线 `<rect>`）。

### Added — Favorites tab 体验补全（v0.5.0 实施范围，设计 §5 Slice 2 + §Q3 方案 a）

- **`editor/title/context` tab 右键菜单**（`companion/package.json` `contributes.menus["editor/title/context"]`）：webview tab 右键加 "CC Favorites: Star/Unstar Current CC Tab"。`when: resourceScheme == 'webview' && config.ccStatusDot.fav.includeInTabContextMenu'`。复用既有 `ccStatusDot.fav.toggleTab` 命令 + `favToggleTab()` handler——handler 内 `__ccsdActiveSid` 校验对非 CC webview（Copilot Chat / Redis Viewer 等）no-op + 信息提示，零副作用。新配置 `ccStatusDot.fav.includeInTabContextMenu`（默认 true）给用户 opt-out 通道。
- **5 个 `-fav` SVG 变体**（`resources/claude-logo-{idle,running,done,error,pending}-fav.svg`）：base SVG byte-copy + 单个 `<rect x="4" y="22" width="16" height="0.9" rx="0.3" fill="#F5A623"/>` 金线（viewBox 高的 3.7%，不遮 logo asterisk 底部尖端，不遮顶右角状态圆）。`viewBox` 保持 `0 0 24 24` 不扩高，零 aspect ratio 变形。`<title>` 加 "Favorited" 后缀做 a11y 区分。
- **IIFE fav-detection**（`patch.ts` §A preamble）：3 处新增——(1) `var FAVF=pth.join(DIR,"favorites.json")` 常量（沿用 DIR bake，避免第 4 处硬编码路径）；(2) `readFavSet()` helper（mtime+size 缓存镜像 `__ccsdAgCache`/`__ccsdOffCache` 范式，companion 的 atomic tmp+rename 写入是可靠的 content-change 信号；返回 null-prototype object，keys 为 favorited sids）；(3) `favOf(svgPath, sid)` helper（命中收藏且 leaf 匹配 5 base SVG 之一 → 替换为 `-fav.svg`，否则直返；`CC_DEFAULT` off 帧短路返回保持 interrupted flash 序列完整）。
- **§H per-panel tick 3 处 iconPath 应用点用 `favOf` 包裹**：pending 早返（`favOf(...pending.svg, sid)`）+ interrupted on-帧（`favOf(...error.svg, sid)`，off 帧 CC_DEFAULT 直返）+ 最终应用（`favOf(svg, sid)`）。状态分支 line 2497-2499 不动——favOf 在最终应用点统一重映射，5 态色/形完全不变，只在 sid∈favorites 时把 leaf `.svg` → `-fav.svg`。
- **新测试断言**（`hooks/test-iife.mjs` + `hooks/test-favorites.mjs`）：IIFE.117 翻转（5 → 10 entries）+ IIFE.117a-k 新增（OUR_SVGS 含 5 -fav + IIFE helpers 形态 + 3 处 favOf 包裹）+ IIFE.117c-e SVG 几何 parity（path d= byte-identical to base + 金线 `<rect>` 形态断言）+ FAV.31 翻转（v0.4 ABSENCE → v0.5 PRESENCE）+ FAV.31a/b（config key + default === true）。

### Changed

- **`patch.ts OUR_SVGS`** 5 → 10 entries（加 5 -fav 变体）。`installRuntimeFiles` 拷贝循环 + stale SVG sweep 零改动（已通用 OUR_SVGS 驱动）。`log(... ${OUR_SVGS.length} SVGs ...)` 计数自动跟随。
- **版本 4-way pin** 同步 bump：`package.json` 0.4.0 → 0.5.0；`patch.ts INJECT_VERSION` v0.4.0 → v0.5.0；`companion/package.json` 0.4.0 → 0.5.0（lockstep）；`companion/extension.ts MIN_PATCHER_VERSION` 0.4.0 → 0.5.0 + `injectVersion()` fallback v0.4.0 → v0.5.0。`HOOK_VERSION`（v0.2.1）+ `cc-status.js` hash 不变（writer 无改动）。IIFE body bytes 变 → INJECT banner sha1 自动重算。

### Architecture

- **持久化分工延续**（设计 §4.1 演进）：companion 仍是 favorites.json 单写者（atomic tmp+rename）；IIFE 现在是 reader（v0.4 是不读，v0.5 mtime-cache 读 `sessions[].sid` 集合）。零新 IPC——读盘 + 单元素缓存（`globalThis.__ccsdFavCache.last`）。
- **handler 无改动**（`favToggleTab()` 已完备）：v0.4 已实现 `__ccsdActiveSid || __ccsdLastActiveSid` 校验 + `favorites.json` 原子写 + 已在 favorites splice / 未在 push，v0.5 仅通过新 menu 暴露同一命令给 webview tab 右键。
- **5 态色/形完全不变**：状态分支 5 base SVG 选择逻辑（line 2503-2508）零改动；`favOf` 仅在 sid∈favorites 时把 leaf `.svg` → `-fav.svg`，gold underline 是叠加而非替换。状态圆 fill 色（amber/绿/红/灰/蓝）byte-identical。

### Risks

- **menu 误显（scope 太宽）**：`resourceScheme == 'webview'` 让命令出现在所有 webview tab 右键菜单（不仅 CC）。handler `__ccsdActiveSid` 校验对非 CC webview 调用会信息提示 + no-op。用户可设 `ccStatusDot.fav.includeInTabContextMenu: false` opt-out。**LOW**。
- **mtime-cache 时延**：用户右键 toggle 后，companion writeFavAtomic 改 favorites.json 的 mtime+size，IIFE 下一个 500ms tick 才检测到并 swap -fav.svg。最坏 500ms 内 icon 还是旧变体——用户感知不到。**LOW**。
- **interrupted flash 视觉**：on 帧显 error-fav.svg（带金线），off 帧显 CC_DEFAULT（无金线），500ms 交替闪烁时金线随之闪。用户 spec 明确"可接受"。**LOW**。
- **FAV.31 翻转**：`hooks/test-favorites.mjs` 的 v0.4 ABSENCE 断言在同 PR 翻转为 v0.5 PRESENCE 断言，否则新增 menu 会让旧断言失败。

### Version

- `package.json` 0.4.0 → 0.5.0；`patch.ts INJECT_VERSION` v0.4.0 → v0.5.0；`companion/package.json` 0.4.0 → 0.5.0；`companion/extension.ts MIN_PATCHER_VERSION` 0.4.0 → 0.5.0 + `injectVersion()` fallback v0.4.0 → v0.5.0。`HOOK_VERSION`（v0.2.1）+ `cc-status.js` hash 不变（writer 无改动）。

### Tests

- **`hooks/test-iife.mjs`**：IIFE.21c stamp v0.4.0 → v0.5.0；IIFE.117 翻转（5 → 10 entries）；新增 IIFE.117a-k 共 13 项断言（OUR_SVGS 含 5 `-fav` + IIFE helpers 形态 `readFavSet`/`favOf`/`FAVF` + 3 处 `favOf` 包裹校验 + 5 SVG 几何 parity path d= byte-identical to base + 5 金线 `<rect fill="#F5A623">` 形态断言）。
- **`hooks/test-favorites.mjs`**：FAV.31 翻转（v0.4 ABSENCE → v0.5 PRESENCE）+ FAV.31a/b（`editor/title/context` 被 `config.ccStatusDot.fav.includeInTabContextMenu` 门控 + schema default === true）。
- **`hooks/test-version-sync.mjs`**：自动验证 4-way version pin（package.json + INJECT_VERSION + companion MIN_PATCHER_VERSION + companion injectVersion fallback），无需新增断言。
- 总测试断言数：**902**（v0.4 的 ~845 + IIFE 13 + favorites 3 + 现有测试增量）。

### Documentation

- **`docs/FAVORITES-DESIGN.md`** §12.2 Slice 2 行 + §Q3 方案 (a) 行标注"✅ v0.5.0 已实施（金线下划线变体 = 方案 d，base SVG 不动）"；新增 §13 实施摘要（已实施/边界/不破坏清单/版本与文件清单）。
- **companion/README.md** 列出 tab 右键 menu + 金线变体。

## [0.4.0] - 2026-07-22

**新增"收藏/导航"机制：Explorer 侧边栏的 CC Favorites 视图 + 文件/会话收藏 + 跨面板导航。** 基于 4 路并行调研（类似插件/VSCode API/cc-status-dot 架构契合/CC 会话生态）综合产出（设计全文 `docs/FAVORITES-DESIGN.md`，裁决 PARTIAL-GO：MVP + 文档化边界）。架构层面明确无问题——companion-based 路径四路独立收敛，companion/package.json 已是合法扩展宿主，加 views/commands/menus 是正常版本 bump 不是架构变更。

### Added — Favorites MVP（v0.4.0 实施范围，按设计 §5 Slice 1 + Slice 2 安全部分）

- **companion Explorer 视图**（`companion/package.json` `contributes.views.explorer`）：左侧资源管理器新增 "CC Favorites" 勾选项，viewsWelcome 空态引导。图标 `$(star-full)`。
- **companion 命令**（`companion/extension.ts` `registerFavorites`）：`ccStatusDot.fav.toggleFile` / `toggleTab` / `open` / `remove` / `copyResume` / `refresh` / `browse`，全前缀 `ccStatusDot.fav.*` 命名一致性。
- **companion 菜单**：`explorer/context`（文件右键加入收藏，gated by `config.ccStatusDot.fav.includeInExplorerContextMenu`）+ `view/item/context`（树节点 inline open/remove + 9_cuts copyResume for sessions）+ `view/title`（refresh/browse）+ `commandPalette`（toggleFile/toggleTab 公开，open/remove/copyResume 仅树内 `when:false` 隐藏）。
- **FavoritesProvider**（`companion/extension.ts`）：实现 `vscode.TreeDataProvider<FavNode>`，discriminated union `sessionOpen` / `sessionClosed` / `file`，按 `lastSeenAt`/`addedAt` 倒序。空态 setContext `ccStatusDot.favoritesEmpty=true` 驱动 viewsWelcome。
- **favorites.json 持久化**（`companion/extension.ts` `writeFavAtomic`/`readFavDoc`）：位置 `~/.claude/cc-tab-status/favorites.json`（= IIFE 现有 STATE_DIR `patch.ts:219`，语义正确 + IIFE 零新路径 plumbing）。companion 单写者，atomic tmp+rename 镜像 `patch.ts:1662 writeAtomicSync` 纪律。Schema v1：`{version,updatedAt,sessions:[{sid,label,cwd,transcript_path,model,state,addedAt,lastSeenAt}],files:[{fsPath,label,line,workspace,addedAt}]}`。前向 schema-version guard 防止未来版本被静默降级。fs.watchFile 2s 轮询刷新树。
- **IIFE `__ccsdSidToPanel` 桥**（`patch.ts` §A preamble + §Z onDidDispose）：发布 `globalThis.__ccsdSidToPanel[sid] = t.panelTab`，companion 经共享 globalThis（同 EH，沿用 `companion/extension.ts:621 __ccsdSbi` 已验证桥模式）调 `.reveal()` 焦点已开会话。零新 IPC。
- **IIFE `ccStatusDot.fav.focusSession` 命令兜底**（`patch.ts` §D.5）：`vs.commands.registerCommand`（不需 package.json contribution，沿用 `SBI_CLICK_CMD`/`TOK_CLICK_CMD` 已验证模式），companion 在 globalThis 桥不可用时（如未来 VSCode 把 EH 按扩展隔离）通过 `executeCommand` 兜底。Handler fail-safe：sid 不在 map 中返回 false 不抛错（race 与 panel 关闭是常态）。
- **配置项**：`ccStatusDot.fav.includeInExplorerContextMenu`（默认 true）让用户在拥挤右键菜单里 opt-out。
- **新测试套件**（`hooks/test-favorites.mjs`，31 项）：schema shape pin、FAV_FILE 位置、atomic write、round-trip、corrupt/future-schema 降级、FavoritesProvider/handlers/commands 覆盖、package.json 贡献点完整、负面 guard（v0.4 **不**贡献 `editor/title/context`，设计 §5 Slice 2 需 L1 PoC 才 ship）。

### Deferred — 风险部分（v0.5+，按设计 §3.2 / §5 Slice 排期）

- **F1/F2 tab 复合星标 SVG**（Q3 方案 a）：每 panel 只一个 iconPath 槽，复合需 5 state × 2 favorited = 10 SVG 笛卡尔积。v0.4 走方案 (c)：星只在 Favorites 视图（ThemeIcon `$(star-full)`/`$(star-empty)`），tab 不动。方案 (a) 推迟 v0.5，触发条件 = 用户反馈"tab 上也要星"。
- **`editor/title/context` tab 右键菜单**（设计 §5 Slice 2，风险 R1/L1）：menu item 在 webview tab 上的可见性需实机 PoC（设计稿阶段未验证）。v0.4 不 ship，先做最小 PoC（1 颗 menu item + console.log 命令）确认可见性 + `resourceScheme == 'webview'` 宽度后再做完整 handler。
- **D1 已闭会话重开为 CC webview panel**（架构性不可达）：CC 23 个公开命令无一接 sid 参数；CC 内部 `resumeSessionAt` 是私有 JSON-RPC；CLI `claude -r <sid>` 开终端非 panel；CC viewType 私有不可冒充。**降级实现**：灰显 + `fav.copyResume` 一键复制 `claude -r <sid>` 到剪贴板（companion `vscode.env.clipboard.writeText`）。
- **F3-F4 会话 alias / tag 分组**：v0.4 单层平铺，分组推迟用户反馈驱动。
- **`fav.openTerminal`**（设计 Slice 3 可选）：v0.4 仅复制命令到剪贴板，不开集成终端（用户偏好差异大，剪贴板最中性）。

### Changed

- **companion README** 从"没有状态栏、没有命令、没有设置"重写为"自愈看护 + Favorites 视图"——这是定位演进不是文档漂移（02_简单检查清单.md §E #11：演进迁移不是熵退化）。v0.3.0 已把 companion 从"纯自愈"扩到"自愈 + 图表面板 webview"，v0.4.0 再扩到"自愈 + 收藏视图"是同一节奏。
- **companion/package.json** `activationEvents` 加 `onView:ccStatusDot.favorites`（views 启动 hook）；`engines.vscode` 从 `^1.80.0` 升到 `^1.84.0`（`favBrowse` 用 `vscode.QuickPickItemKind.Separator` 是 1.84 新增 API；`@types/vscode` 同步升 `^1.84.0`）。**破坏性变更**：VSCode 1.80–1.83 用户升级到本版后 companion 将报告 "incompatible VSCode version"——这些用户须继续使用 v0.3.1（5 态点 / SBI / 图表面板不受影响）或升级 VSCode 到 1.84+。
- **companion/extension.ts** `MIN_PATCHER_VERSION` 0.3.1 → 0.4.0；`injectVersion()` fallback v0.3.1 → v0.4.0；`activate()` 在 `detectAndPatch()` fire-and-forget 之后调 `registerFavorites()`（Favorites I/O 永不阻塞 CC 更新自愈）；`deactivate()` 清 `favoritesWatcher` interval。

### Architecture

- **companion-based**（设计 §2.1）：所有 Favorites UI 在 companion；IIFE 仅最小桥（`__ccsdSidToPanel` 发布 + `focusSession` 命令）。不动 ANCHOR_A/ANCHOR_B 字符串（`patch.ts:1503/1526`）。companion 自愈主线 `detectAndPatch` 完全保留。
- **跨扩展通信双通道**（设计 §4.1）：热路径（焦点已开会话）走 globalThis `__ccsdSidToPanel[sid].reveal()`；冷路径（命令兜底）走 `vscode.commands.executeCommand("ccStatusDot.fav.focusSession", sid)`，VSCode 命令桥处理 EH 边界编排（未来 VSCode 把 EH 按扩展隔离时仍可用）。
- **持久化分工**：companion 单写者（atomic tmp+rename）；IIFE 在 v0.4 不读 favorites.json（Q3 方案 c 让 IIFE 改动面归零，概念完整性最高）。v0.5 复合星标落地后 IIFE 将按 mtime-cache 读 `sessions[].sid` 集合。

### Tests

- **`hooks/test-iife.mjs` 新增 IIFE.154-157**（4 项 FAV BRIDGE 断言）：`__ccsdSidToPanel` §A 初始化+发布、§Z onDidDispose 删除、`ccStatusDot.fav.focusSession` registerCommand、handler fail-safe（miss 返回 false 不抛错）。`IIFE.21c` banner stamp v0.3.1 → v0.4.0。
- **`hooks/test-contract-sync.mjs` 新增 3 项 FAV_FOCUS_CMD 跨文件平价锁**（`patch.ts FAV_FOCUS_CMD const` === `companion/extension.ts executeCommand("ccStatusDot.fav.focusSession")` === IIFE `JSON.stringify(FAV_FOCUS_CMD)` 烘焙字节三处一致）。
- **`hooks/test-favorites.mjs` 新文件 31 项**（schema round-trip + atomic write + corrupt/future 降级 + provider/handlers 覆盖 + package.json 贡献点 + 负面 guard）。
- 总测试断言数：845（v0.3.1 的 ~778 + FAV BRIDGE 4 + contract 3 + favorites 31 + 现有测试增量）。

### Version

- `package.json` 0.3.1 → 0.4.0；`patch.ts INJECT_VERSION` v0.3.1 → v0.4.0；`companion/package.json` 0.3.1 → 0.4.0；`companion/extension.ts MIN_PATCHER_VERSION` 0.3.1 → 0.4.0 + `injectVersion()` fallback v0.3.1 → v0.4.0。`HOOK_VERSION`（v0.2.1）+ `cc-status.js` hash 不变（writer 无改动）。

### Documentation

- **`docs/FAVORITES-DESIGN.md`**：补 "v0.4.0 实施摘要" 小节，标记已实施 vs 推迟。
- **companion/README.md**：定位演进（自愈 + Favorites 视图），列出命令 + 配置项 + favorites.json 位置。
- **主 `README.md`**：新增 §"Favorites View"小节。

## [0.3.1] - 2026-07-21

**图表 webview CSP hardening：script-src 从 `unsafe-inline` 改为 VSCode nonce 最佳实践。** v0.3.0 引入的 token 速率图表 webview panel 原先用 `script-src 'unsafe-inline'`（功能正常，webview 数据是 postMessage 传数字无 XSS 向量，但 unsafe-inline 非最佳安全姿态）。本版按 VSCode 官方 webview CSP 指南改 nonce：每 panel 创建生成新 nonce，inline script 标签带 `nonce` 属性，CSP meta 用 `script-src 'nonce-NONCE'`。调研裁决 `style-src 'unsafe-inline'` 保留（VSCode 自身注入主题 CSS 变量为 inline style，非cing style-src 需同时 pin VSCode 注入样式，不现实；CSS XSS 风险远低于 JS，且无不可信输入流入 webview）。

### Changed — CSP nonce hardening（v0.3.0 webview panel 安全姿态提升）

- **`script-src` 从 `unsafe-inline` 改为 per-call nonce**（`patch.ts` `__ccsdRateChartHtml`）：每次 `panel.webview.html = ...` 赋值生成新 nonce，注入 CSP meta + inline `<script>` 标签的 `nonce` 属性。去掉 `script-src 'unsafe-inline'`，符合 VSCode 官方 webview CSP 示例。
- **`__ccsdGetNonce()` helper 新增**（IIFE 顶层 sibling）：主路径 `require("crypto").randomBytes(16).toString("base64")`（128 bit 熵 / 24 字符，IIFE 跑 Extension Host 真 Node.js，crypto 恒可用）；fallback 路径 32 字符 Math.random alphanumeric（防御性——crypto 异常时兜底）。nonce 在 `__ccsdRateChartHtml` 内生成（非 module scope），保证每次 HTML 构建都 mint 新 nonce（不缓存 HTML 字符串、不跨 panel 重用）。
- **`style-src 'unsafe-inline'` 保留**：调研裁决（VSCode 自身注入主题 CSS 变量为 inline style + VSCode 官方示例也用 `style-src ${cspSource} 'unsafe-inline'` + CSS XSS 风险远低于 JS + 无不可信输入流入 webview）。

### Tests

- **`test-iife.mjs` IIFE.147 翻转**：原断言 `script-src 'unsafe-inline'` 存在 → 翻转为断言 `script-src 'nonce-` + `<script ... nonce=` 配对（nonce 形式）。
- **`test-iife.mjs` IIFE.153a/b/c 新增**：153a 断言 `__ccsdGetNonce` helper 存在且用 `crypto.randomBytes`；153b 回归 guard `style-src 'unsafe-inline'` 未被误删；153c 负向 guard `script-src 'unsafe-inline'` 不再出现（belt + suspenders，防止未来编辑静默回退 hardening）。
- **`test-iife.mjs` IIFE.21c stamp** v0.3.0 → v0.3.1（banner stamp 同步）。

### Version

- `package.json` 0.3.0 → 0.3.1；`patch.ts` `INJECT_VERSION` v0.3.0 → v0.3.1；`companion/package.json` 0.3.0 → 0.3.1；`companion/extension.ts` `MIN_PATCHER_VERSION` 0.3.0 → 0.3.1 + `injectVersion()` fallback v0.3.0 → v0.3.1。`HOOK_VERSION`（v0.2.1）+ `cc-status.js` hash 不变（writer 无改动）。

## [0.3.0] - 2026-07-21

**右下角 token 计数：B/T 单位 + 瞬时 tok/s 速率 + sparkline + webview 大图。** 基于 5 路深度调研（A 实时性审计 + B LLM 拦截可行性 + C OSS 调研 + D 速率/图表设计 + E 单位格式）。用户两提案：提案1（LLM 调用层拦截）→ 调研 B 裁决 NO-GO（架构错位——CC 的 API 调用在 CLI 子进程，patch 触不到；只文档化路径于 `docs/LLM-INTERCEPT-DESIGN.md`）；提案2（瞬时速率 + 动态图表）→ 全面落地。

### Added — 速率与图表（提案 2，按调研 D 落地）

- **瞬时 tok/s 滑动窗口速率**（`patch.ts` `__ccsdRateSample`）：每 §G tick（500ms）采样 `realNow = (w.in+w.out) + (dIn+dOut)` —— 故意排除 cache_read/cache_creation（调研 D R2 critical：用户 796M session 中 cache_read 占 85%，包含会产出无意义的数十 M tok/s spike）。ring buffer 容量 16 = 8s 历史；5s 滑动窗口算 `rate_real = Σ last(10).d / 5s`。EMA peak（τ≈2s，`max*0.85+delta*0.15`）auto-scale 防 burst peg █ / idle 趋零。
- **状态栏 unicode sparkline**（`__ccsdRateSpark`）：`▁▂▃▄▅▆▇█`（U+2581..U+2588）8 块，渲染最近 8 个采样点（4s）。零依赖、零 CSP 风险、单色字体 tabular-nums 兜底宽度恒定。示例：`$(clock) 12.3k tok ▂▄▆█ 1.2k/s · $0.42`。
- **`<sid>.rate` sidecar**（IIFE 唯一 writer）：ring buffer 快照 throttled 2s 写盘（仅 `state==='running'`），跨 reload 续 sparkline。schema：`{v:1,sid,last_ts,recent_max,samples:[{t,d,total}]}`。原子 tmp+rename 镜像 `writeJsonAtomic` 纪律。
- **webview 大图面板**（`showRateChart`，调研 D form C）：点击 token SBI → QuickPick → `$(graph) Show live rate chart`。pure-SVG（无外部库——uPlot/Chart.js 故意避开，零 CSP remote-script 风险），~80 行内联 JS+SVG。两 series：累计 token 折线（#4fc3f7）+ 瞬时 tok/s 柱状（#ffb74d）。严格 CSP `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:`。单例（`globalThis.__ccsdRateChart`），onDidDispose 清 timer + msgHandler。
- **i18n 9 新键 × 8 语言**：`qpShowChartLabel/Detail`、`ttRateTpl`、`ttSparklineHint`、`wvChartTitle`、`wvSeriesCumulative/Rate`、`wvTotalLabel`、`wvRateLabel`、`wvSidLabel`、`wvSampleLabel`。符号（`tok` / `/s` / unicode 块）跨语言不译。

### Changed — 单位（提案 E）

- **fmtTok 加 B/T 阶**（`patch.ts:2034`）：v0.2.9 fmtTok 上限 M → 1.5B 显 "1500.0M"（用户实报，796M→1B 临界必须修）。新 tiers `1e3→k`、`1e6→M`、`1e9→B`、`1e12→T`，3-4 sig figs（`m<10?m.toFixed(2):m<100?m.toFixed(1):Math.floor(m)`），trailing-zero strip regex `/\.0+$/` 清噪声。Locale-independent 手写（`Intl.NumberFormat` 跨 locale 抖动：zh→"8亿"、de→"796 Mio." 破坏 SBI 视觉稳定）。样例：1234→"1.23k"、1234567→"1.23M"、1234567890→"1.23B"、796007504→"796M"、1500000000→"1.50B"、1e12→"1T"。
- **fmtRate / fmtBytes 新增 helpers**：`fmtRate` 速率显示（`<1→"0"`、`<1000→整数`、`>=1000→fmtTok`）；`fmtBytes` 留作未来 pendingBytes 显示。

### Documentation

- **`docs/LLM-INTERCEPT-DESIGN.md`（新）**：调研 B 裁决——LLM 调用层拦截在 CC 双进程架构下 4 种策略全部失效或极高风险（fetch monkey-patch / SDK middleware 跨进程不可见；HTTPS_PROXY+MITM 污染整机信任链 + 可能 cert-pin + 打断 CC 调用 + 触 ToS）。文档化路径 + 风险 + 4 个未来重启条件（CC 官方 streaming usage hook / SDK middleware / statusline final usage / 独立签名 companion binary）+ 4 个实施前必查项（CC 是否 honor HTTPS_PROXY / cert-pin / 代理延迟 / ToS）。
- **`docs/STATES.md` §10**（新）：速率 + sparkline + sidecar + webview panel 的契约面（数据流图、采样算法、不变量、CSP、性能预算）。
- **`README.md` / `README.en.md`** 同步：单位示例（B/T）、新 SBI 形态（含速率 + sparkline）、新菜单项（Show live rate chart）、新配置项（`rateDisplayMode`）。
- **`CHANGELOG.md`** v0.3.0 条目（本条）。

### Config

- 新增 `ccStatusDot.rateDisplayMode`（enum `off|numeric|sparkline|both`，默认 `both`）：控制 token SBI 速率后缀呈现。`both` = `▂▄▆█ 1.2k/s`；`numeric` = `1.2k/s`；`sparkline` = `▂▄▆█`；`off` = 无后缀（perf 敏感机器或状态栏拥挤时降级）。

### Architecture invariants preserved

5 态点 / 4 灯 / permission blue / token SBI 既有 / Q1 跨重启持久 / Q2 interrupted sticky / PostCompact / v0.2.8 src/ 自愈 — **零冲突**。速率功能是 §G tick 内的纯加法（采样、推 buffer、拼字符串）+ 一个新 webview 命令，不改 state 渲染、不改 hook 契约、不改 `<sid>.json` / `<sid>.offset` / `<sid>.tokens.json` schema。

### Tests

- 新增 16 个 IIFE 测试（IIFE.133-149）：fmtTok B/T tier、trailing-zero strip、__ccsdRateSample 函数签名、RATE_BUF_CAP、sparkline chars、§G tick 调用采样、cfg.rateDisplayMode 读取、INPUT+OUTPUT 采样（lane D R2 invariant）、__ccsdRateSpark 渲染器、__ccsdRateFlush 原子写、__ccsdRateLoad 单次 sidecar 加载、QuickPick chart 项、showRateChart 函数、CSP strict、inline SVG 无外部库、单例 globalThis.__ccsdRateChart。
- 更新 IIFE.21c（v0.2.9 → v0.3.0 banner）、IIFE.56（fmtTok label 反映新 tiers）、IIFE.66（setInterval count 2 → 3：加 chart-panel timer）。
- 全套 654+ assertions 全绿（240 IIFE + 71 cc-status + 148 smoke + 34 patcher-io + 40 version-sync + 37 contract-sync + 14 standalone）。

### Changed

- `INJECT_VERSION` v0.2.9 → v0.3.0（IIFE body 变：fmtTok B/T + fmtRate/fmtBytes + __ccsdRateSample/Spark/Flush/Load + showRateChart + __ccsdRateChartHtml/Css/Js + 9 i18n 键 + §G tick 加采样 + chart QuickPick 项 + chart handler）。
- `HOOK_VERSION` 保持 v0.2.1（writer IPC contract 未变——仅 GC 加 `.rate` 扩展，writer 本身不读写此文件；cc-status.js body 变 = 加 isRate GC 分支 + baseName 正则扩展 → banner hash 重盖 `4153997e → a8fe2726`）。
- `companion/package.json` 0.2.7 → 0.3.0；`companion/extension.ts` `MIN_PATCHER_VERSION` 0.2.9 → 0.3.0 + `injectVersion()` fallback `v0.2.9 → v0.3.0`。

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
