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
3. 校验 `extension.js` 中两段 anchor 字符串的命中数（Anchor A 必须唯一命中，Anchor B 命中 0 或 1 次）。命中失败则**不写任何文件**并报错。
4. 备份 `extension.js` → `extension.js.bak`（仅首次）。
5. 注入 IIFE（含 `setInterval` 500ms 重绘：running 静态黄 + done/interrupted 通知逻辑），把 `INSTALL_DIR/resources` 的绝对路径 bake 进注入块。
6. 把 **8 个 hook 事件**写入 `~/.claude/settings.json`（幂等、带 `# cc-status-dot-managed` 标记，命令指向 `INSTALL_DIR/hooks/cc-status.js`），首次备份为 `settings.json.cc-status-dot.bak`。
7. 校验 `INSTALL_DIR/resources` 下 4 个 SVG 齐全（idle + running + done + error）。

> **升级**：旧版（git clone 装的）用户直接重跑 `npx vscode-claude-code-status-dot` 即可——patcher 会检测到旧的 baked 路径过期并**原地改写** IIFE 的 `RES` 与 hook 命令，无需 `--revert` 后重装。

## 2. Reload Window

`Cmd+Shift+P`（Mac）/ `Ctrl+Shift+P`（Win/Linux）→ 输入 `Developer: Reload Window`。

## 3. 触发各状态测试

| 想测的状态 | 怎么触发 | 预期图标 |
|---|---|---|
| `running` | 在 CC 里发一条 prompt | 🟡 黄色**静态**（`#CCA700`，无动画） |
| `done` | 等 CC 本轮正常完成 | 绿色静态 |
| `idle` | `done` 后等超过 5 分钟（reader 自动把 done 渲染为 idle） | 灰色静态 |
| `interrupted` | 触发 `StopFailure`（如限速 / 过载）——较难主动模拟，可跳过 | 红色快闪 |
| permission | CC 弹出授权请求时（CC 原生蓝点，非本项目） | 蓝色（CC 原生） |

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

## 4. 排错

**图标完全没变**
- 先 `Developer: Reload Window`。
- 跑 `npx vscode-claude-code-status-dot --status`（开发态 `npx tsx patch.ts --status`）：
  - `extension.js patched: no` → 没装上，重跑。
  - `baked RES: ... (STALE ...)` → baked 路径过期（通常是旧版升级），重跑会原地改写。
  - `hooks wired: no` → settings.json 接线丢失，重跑。
  - `missing SVGs` → `INSTALL_DIR/resources` 缺文件，重跑会从源补齐。

**patch 报 "Anchor mismatch"**
- CC 的 minified 代码漂移了。patcher 已拒绝写入，扩展未被破坏。到项目 issue 区提 issue 并附 CC 版本号。

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
