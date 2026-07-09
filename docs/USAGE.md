# 使用指南（USAGE）

> 本文是操作步骤。状态的权威定义见 [`STATES.md`](STATES.md)；注入原理见 [`DESIGN-injection.md`](DESIGN-injection.md)。

## 1. 安装

前置：Node.js 18+、Claude Code 的 VSCode 扩展已安装。

```bash
git clone <this-repo> claude-code-status-dot
cd claude-code-status-dot
npx tsx patch.ts
```

`patch.ts` 执行流程：

1. 在 `~/.vscode/extensions`（及 insiders / server / cursor / vscodium）下查找 `anthropic.claude-code-*`，选版本最高的。
2. 校验 `extension.js` 中两段 anchor 字符串的命中数（Anchor A 必须唯一命中，Anchor B 命中 0 或 1 次）。命中失败则**不写任何文件**并报错。
3. 备份 `extension.js` → `extension.js.bak`（仅首次）。
4. 注入 IIFE（含 `setInterval` 500ms 重绘逻辑），把 `resources/` 的绝对路径 bake 进注入块。
5. 把 6 个 hook 事件写入 `~/.claude/settings.json`（幂等、带 `# cc-status-dot-managed` 标记），首次备份为 `settings.json.cc-status-dot.bak`。
6. 校验 `resources/` 下 5 个 SVG 齐全。

> hook 接线由 patcher 自动完成。如果你想手工接线，参考 [`../hooks/settings-snippet.json`](../hooks/settings-snippet.json)。

## 2. Reload Window

`Cmd+Shift+P`（Mac）/ `Ctrl+Shift+P`（Win/Linux）→ 输入 `Developer: Reload Window`。

## 3. 触发各状态测试

| 想测的状态 | 怎么触发 | 预期图标 |
|---|---|---|
| `running` | 在 CC 里发一条 prompt | 黄色呼吸 |
| `done` | 等 CC 本轮正常完成 | 绿色静态 |
| `idle` | `done` 后等超过 5 分钟（reader 自动把 done 渲染为 idle） | 灰色静态 |
| `interrupted` | 触发 `StopFailure`（如限速 / 过载）——较难主动模拟，可跳过 | 红色快闪 |
| permission | CC 弹出授权请求时（CC 原生蓝点，非本项目） | 蓝色（CC 原生） |

> 手动 Esc 中断**不会**触发任何 hook，状态会停在 `running`，属已知限制（见 [`STATES.md` §5](STATES.md)）。

## 4. 排错

**图标完全没变**
- 先 `Developer: Reload Window`。
- 跑 `npx tsx patch.ts --status`：
  - `extension.js patched: no` → 没装上，重跑 `npx tsx patch.ts`。
  - `hooks wired: no` → settings.json 接线丢失，重跑 patch。
  - `missing SVGs` → `resources/` 缺文件，从仓库补齐。

**patch 报 "Anchor mismatch"**
- CC 的 minified 代码漂移了。patcher 已拒绝写入，扩展未被破坏。到项目 issue 区提 issue 并附 CC 版本号。

**状态卡在 `running`**
- 多半是你用 Esc 中断了 CC（无 hook）。下次发 prompt 或等正常完成会自然更正。

**CC 更新后失效**
- CC 自动更新覆盖了 patched `extension.js`。重跑 `npx tsx patch.ts`（SVG 不丢）。

## 5. 还原

```bash
npx tsx patch.ts --revert
```

- 从 `extension.js.bak` 恢复原版 `extension.js`。
- 从 `settings.json` 中基于标记精确移除本项目 hook 条目（不影响你其它 hook）。

## 6. 卸载

```bash
npx tsx patch.ts --revert
```

然后删除本项目目录。`~/.claude/cc-tab-status/` 是用户数据，可自行删除。
