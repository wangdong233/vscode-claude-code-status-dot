# Changelog

本项目的显著变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/)。

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

### 已知限制

- 手动 Esc 中断无 hook，状态停在 `running`，靠下一次 `UserPromptSubmit` / `Stop` 自然更正。
- CC 自动更新覆盖 patched `extension.js`，需重跑 patch。
- minified anchor 的版本脆性：anchor 失配时报错拒写，引导提 issue。
