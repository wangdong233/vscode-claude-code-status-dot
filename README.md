# claude-code-status-dot

给 Claude Code 的 VSCode 扩展的 session tab 图标加上**四态彩色状态点**，让你一眼看出每个会话当前在干什么。

> 实现方式：**patch（补丁）**，不是独立 VSCode 扩展。原因见下文 [为什么是 patch](#为什么是-patch)。

![screenshot](docs/screenshot.png)

> 截图待补（`docs/screenshot.png`）。

---

## 功能

Claude Code 原生的 session tab 图标只在零散时机刷新，且只区分"待授权 / 有未读完成"。本项目通过 patch 注入一个 500ms 重绘定时器，把图标颜色扩展为四种状态：

| 状态 | 含义 | 颜色 | 动效 | SVG |
|---|---|---|---|---|
| `idle` | 空闲（初始 / 无状态文件 / 完成超 5 分钟） | 灰 `#808080` | 静态 | `claude-logo-idle.svg` |
| `running` | 运行中 | 黄 `#CCA700` ↔ `#FFD60A` | 呼吸（500ms 切换两帧） | `claude-logo-running.svg` ↔ `claude-logo-running-bright.svg` |
| `done` | 完成 | 绿 `#3FB950` | 静态 | `claude-logo-done.svg` |
| `interrupted` | 中断（限速 / 出错） | 红 `#F85149` | 快闪（500ms 切换，on/off） | `claude-logo-error.svg` ↔ CC 默认 `claude-logo.svg` |

> **permission（待用户授权）**：由 Claude Code 原生蓝点处理，本项目**不覆盖**。当没有外部状态文件或状态未知时，注入定时器直接 `return`，不覆盖 CC 原生图标，CC 蓝点自然显示。

完整状态契约见 [`docs/STATES.md`](docs/STATES.md)（单一真相源）。

## 原理

一句话：**patch CC 的 `extension.js` 注入一段 IIFE（每 500ms 读状态文件设 `iconPath`） + CC hooks 写状态文件 + 5 个 SVG。**

- **写侧**：CC hooks 把每个 session 的状态写入 `~/.claude/cc-tab-status/<session_id>.json`（字段 `{state, since, error?}`）。
- **读侧**：注入的定时器按各自 session 读取上面的状态文件，切换对应 SVG 的绝对路径。
- **素材**：5 个 SVG 放在本项目 `resources/`，按绝对路径引用（CC 自动更新只覆盖扩展目录，SVG 不丢）。

详见 [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md)。

## 为什么是 patch

VSCode 的 `WebviewPanel` tab 图标（`iconPath`）由**创建该 panel 的扩展独占设置**，VSCode **没有提供任何公开 API** 让一个第三方扩展去修改另一个扩展拥有的 webview tab 图标。Claude Code 的 session tab 正是 CC 扩展自己创建的 `WebviewPanel`，其 `iconPath` 只能在 CC 的 `extension.js` 内部赋值。

我们已详尽调研替代方案（独立 VSCode 扩展、proposed API、webview 拦截等），均不可达。因此唯一可行的路径是 patch CC 的 `extension.js`，注入我们的重绘逻辑。代价是 CC 自动更新会覆盖 patched 文件，需要重跑 patch（见 [FAQ](#faq)）。

## 前置要求

- **Node.js 18+**：hook 脚本 `hooks/cc-status.js` 零依赖，只用 Node 内建模块。
- **Claude Code 的 VSCode 扩展已安装**：patcher 会在 `~/.vscode/extensions`（及 insiders / server / cursor / vscodium）下查找 `anthropic.claude-code-*`。
- 可用 `npx tsx` 运行 TypeScript 脚本（无需全局安装，`npx` 会自动拉取）。

## 安装

```bash
git clone <this-repo> claude-code-status-dot
cd claude-code-status-dot
npx tsx patch.ts
```

`patch.ts` 会依次：发现 CC 扩展 → 备份 `extension.js` → 注入 IIFE → 把 6 个 hook 事件写入 `~/.claude/settings.json` → 校验 5 个 SVG 齐全。

安装完成后 **Reload Window** 生效：`Cmd+Shift+P`（Mac）/ `Ctrl+Shift+P`（Win/Linux）→ 输入 `Developer: Reload Window`。

> hook 接线由 patcher **自动写入** `~/.claude/settings.json`（幂等、带 `# cc-status-dot-managed` 标记，可安全重复运行）。如果你想手工接线或了解接线格式，参考 [`hooks/settings-snippet.json`](hooks/settings-snippet.json)。

## 状态色含义

| 看到的颜色 | 含义 | 触发 |
|---|---|---|
| 灰色（静态） | 空闲 | 初始 / 完成超过 5 分钟 / 无状态文件 |
| 黄色（呼吸） | 正在运行 | 发送 prompt、工具调用前后（心跳） |
| 绿色（静态） | 本轮完成 | CC 触发 `Stop` |
| 红色（快闪） | 中断 / 出错 | CC 触发 `StopFailure`（如限速、过载） |
| 蓝色（CC 原生） | 待授权 | CC 原生蓝点，非本项目 |

## 还原

```bash
npx tsx patch.ts --revert
```

从 `extension.js.bak` 恢复 `extension.js`，并从 `settings.json` 中基于标记精确移除本项目写入的 hook 条目（不影响你其它手工 hook）。

## 查看状态（不改动任何文件）

```bash
npx tsx patch.ts --status
```

dry-run 报告：CC 扩展版本、是否已 patch、hooks 是否已接、SVG 是否齐全、状态目录。

## FAQ

**Q：Claude Code 更新后，状态点不亮了？**
A：CC 自动更新会整体替换扩展目录，patched `extension.js` 被原版覆盖 → 静默失效。重跑 `npx tsx patch.ts` 即可（SVG 在本项目目录不丢，无需重新拷贝）。

**Q：刚装完，图标没变化？**
A：先 `Developer: Reload Window`。如果还不行，跑 `npx tsx patch.ts --status` 看报告：是否检测到 CC 扩展、是否已 patch、hooks 是否接上、SVG 是否齐。

**Q：patch 报 "Anchor mismatch" 错误？**
A：说明 CC 的 minified 代码漂移了（anchor 字符串对不上）。patcher 会拒绝写入任何文件，不会破坏扩展。请到项目 issue 区提 issue 并附上你的 CC 版本号，等待 anchor 更新。

**Q：状态卡在 `running` 不动？**
A：多半是你用 Esc 手动中断了 CC（无 hook 触发）。下次发 prompt 或等正常完成会自然更正。详见[已知限制](#已知限制)。

## 已知限制

- **手动 Esc 中断无 hook**：用 Esc 强制中断 CC 时，CC 不触发 `Stop`/`StopFailure`，状态会停在 `running`。注入定时器不做主动推断，靠下一次 `UserPromptSubmit`（新一轮）或 `Stop`（下次正常完成）自然更正。
- **CC 自动更新覆盖**：见 FAQ，需重跑 patch。
- **minified anchor 的版本脆性**：patch 依赖 CC `extension.js` 里两段精确字符串（Anchor A/B）。CC 版本升级导致 minified 代码漂移时，patcher 会报错并拒绝写入，引导你提 issue。

## 风险声明

本项目修改 Claude Code 扩展的 `extension.js`（已做备份，可 `--revert` 完整还原），并写入你的 `~/.claude/settings.json`（首次备份为 `settings.json.cc-status-dot.bak`）。hook 脚本设计为**永不阻塞或中断 CC**——任何错误（空 stdin、非法 JSON、IO 失败、模块加载失败）都静默 `exit(0)`，不向 CC 的 stderr 输出任何内容。使用前请阅读上述已知限制。

## 卸载

```bash
npx tsx patch.ts --revert   # 还原 extension.js + 移除 hooks
```

之后删除本项目目录即可。状态文件目录 `~/.claude/cc-tab-status/` 属于用户数据，可自行删除。

## License

MIT (c) wangdong
