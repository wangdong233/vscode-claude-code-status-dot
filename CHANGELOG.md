# Changelog

本项目的显著变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/)。

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
