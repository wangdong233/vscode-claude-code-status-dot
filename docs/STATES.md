# 状态表（单一真相源 · Single Source of Truth）

> 本文件是 **claude-code-status-dot 的唯一状态契约**。
> **writer**（`hooks/cc-status.js`）、**reader**（`patch.ts` 注入的 IIFE）、**SVG 文件名**、**文档**（README/USAGE/CHANGELOG）、**`package.json`** 必须全部引用本表。
> 任何状态 / 事件 / SVG / 颜色的增删：**先改本表，再机械同步其余各处**。这是审查 F-1~F-6 的收敛点。

---

## 1. 状态枚举（4 态 + 1 原生）

| state | 含义 | 颜色 (hex) | SVG 文件（项目 `resources/`） | 动效 |
|---|---|---|---|---|
| `idle` | 空闲（初始 / 无状态文件 / 完成超 5 分钟） | 灰 `#808080` | `claude-logo-idle.svg` | 静态 |
| `running` | 运行中 | 黄 `#CCA700` ↔ `#FFD60A` | `claude-logo-running.svg` ↔ `claude-logo-running-bright.svg` | 呼吸（500ms 切换两帧） |
| `done` | 完成 | 绿 `#3FB950` | `claude-logo-done.svg` | 静态；**reader 在 done 超 5 分钟后渲染为 idle** |
| `interrupted` | 中断（限速 / 出错） | 红 `#F85149` | `claude-logo-error.svg` ↔ CC 默认 `claude-logo.svg` | 快闪（500ms 切换，on/off） |
| — (permission) | 待用户授权 | 蓝（CC 原生） | CC 原生 `claude-logo-pending.svg` | **reader 不覆盖**，CC 原生蓝点照常显示 |

> 设计决策：`permission` 态不纳入我们的渲染——CC 已有原生蓝点处理 `hasPendingPermissions`，reader 在"无外部状态文件 / state 未知"时 `return`（不覆盖图标），CC 蓝点自然生效。避免重复造一套 waiting 态。

---

## 2. 事件 → 状态映射（writer 的 case 集 ＝ patcher 的 `HOOK_EVENTS` 接线集，二者必须逐一对齐）

| CC hook 事件 | → 写入 state | 说明 |
|---|---|---|
| `UserPromptSubmit` | `running` | 新一轮开始 |
| `PreToolUse` | `running` | 心跳，刷新 `since` |
| `PostToolUse` | `running` | 心跳，刷新 `since` |
| `Stop` | `done` | 本轮正常完成 |
| `StopFailure` | `interrupted` | 记 `error` 枚举（rate_limit/overloaded/…） |
| `SessionEnd` | （删除该 session 状态文件） | 清理 |

**故 `HOOK_EVENTS` = `["UserPromptSubmit","PreToolUse","PostToolUse","Stop","StopFailure","SessionEnd"]`**（6 个）。

**故意不接的事件**（及原因，防止死接线）：
- `Notification`：permission 由 CC 原生蓝点处理，reader 不覆盖该态。
- `SessionStart`：writer 无对应 case。

---

## 3. 状态文件 IPC 契约（writer 与 reader 共享）

- 目录：`~/.claude/cc-tab-status/`
- 文件名：`<session_id>.json`
- 字段：`{ "state": "idle|running|done|interrupted", "since": <ms 纪元>, "error"?: "<StopFailure 枚举>" }`
- 写入：**原子**（`.tmp` + `rename`），目录自动创建
- reader 读失败（文件不存在 / JSON 破损）→ 跳过本帧，**不覆盖**图标（保留 CC 原生 pending/done）

---

## 4. reader 渲染逻辑（patch.ts 注入 IIFE，每 500ms 一帧）

```
读 <sid>.json → state, since
if state == "done" and now - since > 5min:  视为 idle
switch state:
  running:     seq 偶 → claude-logo-running.svg / seq 奇 → claude-logo-running-bright.svg   （呼吸）
  interrupted: seq 偶 → claude-logo-error.svg / seq 奇 → CC claude-logo.svg（透明感）        （快闪）
  idle:        claude-logo-idle.svg
  done:        claude-logo-done.svg
  其它/无文件:  return（不覆盖，让 CC 原生图标显示）
```

---

## 5. 已知限制（诚实声明，写入文档）

- **手动 Esc 中断无 hook**：CC 不触发 Stop/StopFailure（[#45289](https://github.com/anthropics/claude-code/issues/45289)/[#9516](https://github.com/anthropics/claude-code/issues/9516)），状态会停在 `running`。reader 无 watchdog（当前版本不做主动推断），靠下一次 `UserPromptSubmit`/`Stop` 自然更正。
- **多 session**：每个 CC panel 实例各自一个 500ms 定时器，按各自 `__ccSid` 读各自状态文件，互不干扰。
- **CC 自动更新**：覆盖 patched `extension.js` → 静默失效，需重跑 `tsx patch.ts`（SVG 在本项目目录不丢）。
