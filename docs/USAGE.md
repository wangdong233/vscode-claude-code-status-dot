# 使用指南（USAGE）

> 本文是操作步骤。状态的权威定义见 [`STATES.md`](STATES.md)；注入原理见 [`DESIGN-injection.md`](DESIGN-injection.md)。

## 1. 安装

前置：Node.js 18+、Claude Code 的 VSCode 扩展已安装。

**推荐（发布后一行装，无需 clone 源码）**：

```bash
npx vscode-claude-code-status-dot
```

**或从源码（开发态）**：

```bash
git clone <this-repo> vscode-claude-code-status-dot
cd vscode-claude-code-status-dot
npx tsx patch.ts
```

两种方式等价、幂等，都会把运行时副本（4 个 SVG = idle + running + done + error，加 hook 脚本）复制到 `~/.claude/cc-status-dot/`（`INSTALL_DIR`），注入的 IIFE 与接线的 hook 都引用该**绝对路径**——所以即便删除项目源目录或 npx 缓存被清，已 patch 的扩展仍照常渲染。

`patch.ts` 执行流程：

1. 在 `~/.vscode/extensions`（及 insiders / server / cursor / vscodium）下查找 `anthropic.claude-code-*`，选版本最高的。
2. 若检测到 v0.1.2 装的 webview 聚合色块条残留，**自动从 `.bak` 还原 webview**（升级即清理，无需先 `--revert`）。
3. 两层锚校验 `extension.js`（三层锚 A/B/C，各为：精确字面快路径 + 容错正则兜底，协议字符串为锚、混淆器改名自动兼容；Anchor A 必须唯一命中，Anchor B/C 命中 0 或 1 次）。命中失败则**不写任何文件**并报错（验证先于备份，零足迹）。
4. 备份 `extension.js` → `extension.js.bak`（仅首次）。
5. 注入 IIFE（含 `setInterval` 500ms 重绘：running 静态黄 + done/interrupted 通知逻辑），把 `INSTALL_DIR/resources` 的绝对路径 bake 进注入块。
6. 把 **9 个 hook 事件**写入 `~/.claude/settings.json`（幂等、带 `# cc-status-dot-managed` 标记，命令指向 `INSTALL_DIR/hooks/cc-status.js`），首次备份为 `settings.json.cc-status-dot.bak`。
7. 校验 `INSTALL_DIR/resources` 下 4 个 SVG 齐全（idle + running + done + error）。

> **升级**：旧版（git clone 装的）用户直接重跑 `npx vscode-claude-code-status-dot` 即可——patcher 会检测到旧的 baked 路径过期并**原地改写** IIFE 的 `RES` 与 hook 命令，无需 `--revert` 后重装。

## 2. Reload Window

`Cmd+Shift+P`（Mac）/ `Ctrl+Shift+P`（Win/Linux）→ 输入 `Developer: Reload Window`。

## 3. 触发各状态测试

| 想测的状态    | 怎么触发                                                  | 预期图标                             |
| ------------- | --------------------------------------------------------- | ------------------------------------ |
| `running`     | 在 CC 里发一条 prompt                                     | 🟡 黄色**静态**（`#CCA700`，无动画） |
| `done`        | 等 CC 本轮正常完成                                        | 绿色静态                             |
| `idle`        | `done` 后等超过 5 分钟（reader 自动把 done 渲染为 idle）  | 灰色静态                             |
| `interrupted` | 触发 `StopFailure`（如限速 / 过载）——较难主动模拟，可跳过 | 红色快闪                             |
| permission    | CC 弹出授权请求时（CC 原生蓝点，非本项目）                | 蓝色（CC 原生）                      |

> 手动 Esc 中断**不会**触发任何 hook，状态会停在 `running`，属已知限制（见 [`STATES.md` §5](STATES.md)）。

## 3.5 通知（完成 / 中断时）

当某 session 转为 `done` 或 `interrupted` 时，patch 注入的 IIFE 会发通知（每个新的完成/中断 `since` 触发一次，不重复）：

- **VSCode 在前台**（你在看）：默认**弹 VSCode 消息**（`notifyWhenFocused` 默认 `true`）——"聚焦于窗口"并不等于"盯着 CC tab"，所以前台也提醒。
- **VSCode 不在前台**（你切走了）：弹 VSCode 消息（触发 dock bounce）+ macOS 系统通知（进通知中心 + 声音）。

> 想前台彻底安静：把 `ccStatusDot.notifyWhenFocused` 设 `false`（图标变绿/红快闪即足够），或直接关 `ccStatusDot.notify`。

> 注：通知触发判定已由"采样到 running→done 的状态转换"改为"终态 `since` 时间戳去重"——即便一轮跑得很快（两次 500ms 轮询之间完成）或 reload 落在旧 `done` 上，也不会漏报或误报。

**macOS 首次授权**：第一次收到系统通知时，系统会弹"Script Editor 想发送通知"——点允许（一次性）。

**配置**（写进 VSCode `settings.json`，可选）：

```json
{
  "ccStatusDot.notify": true,
  "ccStatusDot.notifyWhenFocused": true,
  "ccStatusDot.notifySound": "Glass"
}
```

- `notify`：总开关（默认 true）。
- `notifyWhenFocused`：前台时也弹 VSCode 消息（默认 **true**）。
- `notifySound`：macOS 系统通知声音（默认 `"Glass"`；`""` 静音；可选 Basso/Ping/Hero 等）。

> 限制：VSCode 完全关闭时不通知（IIFE 不运行）；系统通知点击不能跳转到 CC tab（仅提醒，回 VSCode 靠 tab 点定位）。详见 [`STATES.md` §4b/§5](STATES.md)。

## 3.6 Token 统计与 $ cost 估算（v0.2.4 新增）

v0.2.4 在状态栏**右下角**新增第二个 SBI，显示当前激活 CC panel 的 token 用量（按时间窗口）+ 可选 USD 估算。左下角的 4 灯聚合（§7）保持不变——左 = 会话状态，右 = 用量成本。**QuickPick 配置面板 + token SBI tooltip 跟随 VSCode 界面语言**（zh/en/ja/de/es/fr/pt/ru，未知语言 fallback en；由 `vscode.env.language` 决定，如 zh-cn→zh、pt-br→pt）。

### 3.6.1 显示内容

- **默认格式** `both`：`$(clock) 12.3k tok · $0.42`
- **`token` 模式**：`$(clock) 12.3k tok`（隐藏 $）
- **`cost` 模式**：`$(pulse) $0.42`（隐藏 token）
- **无激活 panel / 暂无数据**：`$(clock) —`

切换显示模式：点击 token SBI → QuickPick → "Display: both" → 选 token / cost / both。

### 3.6.2 时间窗口

QuickPick → "Statistics window: all" → 选 5min / 10min / 1h / 24h / 3d / 7d / 30d / all（默认 `all`，累积——整个会话不清零）。`5min..30d` 是滚动窗口（旧 turn 到期滑出，看起来像"清零"），`all` 是累积（会话级单调增长）。窗口决定 SBI 显示的 token 是"最近多久内的累计"。

### 3.6.3 Tooltip（鼠标悬停）

```
Window: all
Session total: 1.2M tok
Session cost: ~$3.45
24h: ~$3.45
7-day: ~$15.20
30-day: ~$42.10
Last model: claude-sonnet-4-5-20250929
Project: /Users/me/my-app
Turn running: 47s
(click to configure)
```

### 3.6.4 配置项（settings.json）

| key                                 | 类型   | 默认      | 作用                                                         |
| ----------------------------------- | ------ | --------- | ------------------------------------------------------------ |
| `ccStatusDot.tokenStatsWindow`      | enum   | `"all"`   | SBI 显示的时间窗口（`all` 累积 / `5min..30d` 滚动）          |
| `ccStatusDot.tokenDisplayMode`      | enum   | `"both"`  | SBI 显示模式：token / cost / both                            |
| `ccStatusDot.tokenSbiVisible`       | bool   | `true`    | 显示 / 隐藏 token SBI                                        |
| `ccStatusDot.tokenLiveDeltaEnabled` | bool   | `true`    | 流式输出期间实时读 transcript 尾部增量（性能敏感机器可关闭） |
| `ccStatusDot.showCost`              | bool   | `true`    | 显示 $（未知 model 自动隐藏）                                |
| `ccStatusDot.warnThresholdUsd`      | number | `0`       | cost 跨阈通知（0=禁用）                                      |
| `ccStatusDot.notify`                | bool   | `true`    | 完成 / 中断通知                                              |
| `ccStatusDot.notifyWhenFocused`     | bool   | `true`    | VSCode 聚焦时也通知                                          |
| `ccStatusDot.notifySound`           | enum   | `"Glass"` | macOS 通知声音                                               |

### 3.6.5 自定义模型定价（`token-rates.json`）

`~/.claude/cc-status-dot/token-rates.json` 是 USD-per-1M-tokens 定价表，**热更**（无需重 patch；writer 按 mtime 缓存重读）。默认覆盖 Anthropic 官方价：

```jsonc
{
  "_default": null,
  "claude-sonnet-*": { "in": 3, "out": 15, "cacheRead": 0.3, "cacheCreate5m": 3.75, "cacheCreate1h": 6 },
  "claude-opus-*": { "in": 5, "out": 25, "cacheRead": 0.5, "cacheCreate5m": 6.25, "cacheCreate1h": 10 },
  "claude-haiku-*": { "in": 1, "out": 5, "cacheRead": 0.1, "cacheCreate5m": 1.25, "cacheCreate1h": 2 },
}
```

**GLM / 第三方模型**：默认未匹配 → `cost=null` → SBI 隐藏 $，只显 token。要显示 $，编辑 `token-rates.json` 加一条（glob 用 `*` 通配）：

```jsonc
"glm-*":           { "in": 0.5, "out": 1.5 }
```

`cacheRead` / `cacheCreate5m` / `cacheCreate1h` 字段可省——writer 按官方比例自动派生（0.1x / 1.25x / 2x input）。

### 3.6.6 QuickPick 操作（点击 token SBI）

```
cc-status-dot — token stats & config
 Statistics window: all
 Display: both
 ── ── ──
 $(eye) Token SBI visible: on
 ✓ Notify on completion
 ✓ Notify when focused
 Sound: Glass
 ── ── ──
 $(pulse) Session total: 1.2M tok · $3.45
 $(calendar) 24h: $3.45
 $(calendar) 7-day: $15.20
 $(calendar) 30-day: $42.10
 $(clock) Turn running: 47s
 ── ── ──
 $(clippy) Copy token count
 $(trash) Reset session stats
 $(go-to-file) Open state dir
 ── ── ──
 $(settings-gear) Open Settings
```

- **Copy token count**：当前会话 all-time total 复制到剪贴板。
- **Reset session stats**：删除 `<sid>.offset`（下次 hook fire 全量重读 transcript 重建）。
- **Open state dir**：在 Finder/Explorer 中打开 `~/.claude/cc-tab-status/`。
- **Open Settings**：VSCode Settings UI 过滤 `ccStatusDot`。

### 3.6.7 数据源与持久化

- **唯一权威源**：CC transcript jsonl（`~/.claude/projects/<escaped-cwd>/<sid>.jsonl`）每条 assistant 行的 `message.usage`。CC 的 hook payload 不携带 usage（GitHub issue #11008）。
- **派生缓存**：`~/.claude/cc-tab-status/<sid>.offset`（字节偏移 + totals + buckets + perTurn）。增量读（仅读自上次 fire 以来新增的字节），33MB 大文件也能 < 100ms。
- **主状态文件**：`~/.claude/cc-tab-status/<sid>.json` 加 `tokens` 字段（与现有 `state`/`since`/`error`/`activeSubagents`/`pending` 同对象，向后兼容）。
- **跨会话**：CC `/resume` 或 `--continue` 复用同一 sid → 统计天然延续；开新会话（新 sid）→ 从 0 起。
- **崩溃恢复**：`SessionEnd` 同步删 `<sid>.json` 和 `<sid>.offset`；崩溃未发 `SessionEnd` 的会话由 writer GC（24h mtime 阈值）异步清理（`interrupted` 状态保留诊断价值）。

详细字段契约与异常安全见 [`STATES.md` §8](STATES.md)。

## 4. 排错

**图标完全没变**

- 先 `Developer: Reload Window`。
- 跑 `npx vscode-claude-code-status-dot --status`（开发态 `npx tsx patch.ts --status`）：
  - `extension.js patched: no` → 没装上，重跑。
  - `baked RES: ... (STALE ...)` → baked 路径过期（通常是旧版升级），重跑会原地改写。
  - `hooks wired: no` → settings.json 接线丢失，重跑。
  - `missing SVGs` → `INSTALL_DIR/resources` 缺文件，重跑会从源补齐。

**收藏的会话点击后提示"转录已被清理"？**

- 该会话在收藏/归档**之前**就已被 CC 的 30 天保留策略清理（v0.5.51 之前的收藏不受保活保护）——点击会明确询问是否开新会话。v0.5.51+ 新收藏/归档的会话受硬链接保活，永不过期。如希望未收藏的长会话也保得住，可在 `~/.claude/settings.json` 加 `"cleanupPeriodDays": 3650`。

**CC 更新后自动修补失败/提示 auto-patch failed？**

- v0.5.53 起自动修补带重试：失败后按 30s→4min 指数退避自动重试至多 5 次（约 11 分钟有界窗口），仅当重试耗尽才提示；瞬时类失败（机器高负载被 30s 超时杀 / 外部 OOM kill）通常在下一次重试自愈。诊断记录在 `~/.claude/cc-status-dot/last-failure.log`（最近 5 次尝试的退出码/信号/输出尾）。

**patch 报 "Anchor mismatch"**

- CC 的 minified 代码发生了结构性漂移（改名类漂移会被容错正则层自动兼容，不会报此错）。patcher 已零足迹拒绝写入，扩展未被破坏。到项目 issue 区提 issue 并附 CC 版本号。

**状态卡在 `running`**

- 多半是你用 Esc 中断了 CC（无 hook）。下次发 prompt 或等正常完成会自然更正。

**CC 更新后失效**

- CC 自动更新覆盖了 patched `extension.js`。重跑 `npx vscode-claude-code-status-dot`（SVG/hook 运行时副本在 `INSTALL_DIR`，CC 更新不碰它；项目源目录删了也不影响）。

## 5. 还原

```bash
npx vscode-claude-code-status-dot --revert
# 开发态：npx tsx patch.ts --revert
```

- 从 `extension.js.bak` 恢复原版 `extension.js`。若 webview 残留 v0.1.2 装的聚合色块条，也一并从 `.bak` 还原。
- 从 `settings.json` 中基于标记精确移除本项目 hook 条目（不影响你其它 hook）。
- 删除 `INSTALL_DIR`（运行时副本）；**保留** `~/.claude/cc-tab-status/`（用户数据）。
- 末尾会列出残留的 `.bak` 安全副本及手动删除命令（可选清理）。

## 6. 卸载

```bash
npx vscode-claude-code-status-dot --revert
```

然后可选删除项目源目录。`~/.claude/cc-tab-status/` 是用户数据，可自行删除。
