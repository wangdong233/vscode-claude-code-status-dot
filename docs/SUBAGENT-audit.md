# Subagent / Workflow Phase-2 实施审计

> 审计对象：SubagentStart/SubagentStop + activeSubagents 计数（hybrid 方案 A）落地。
> 审计依据：[`STATES.md`](STATES.md)（唯一真相源）、[`SUBAGENT-design.md`](SUBAGENT-design.md)、[架构想法/02_简单检查清单.md](../../../架构想法/02_简单检查清单.md) §D 输出契约。
> 审计范围：一致性（R-CI）、状态机正确性、概念完整性。阈值"均为起点值，未经本仓库校准"。
> 授权范围：仅审查 + 测试（fix=否），未改动实施代码（test-cc-status.js 为新增测试件，非被审代码）。

---

## 0. 总体结论

| 维度 | 结论 |
|---|---|
| 三方一致性（cc-status.js case / patch.ts HOOK_EVENTS / STATES.md §2） | ✅ 全对齐，8=8=8，含新增 SubagentStart/Stop |
| reader 是否读 activeSubagents | ✅ 不读（patch.ts IIFE line 349 仅读 state/since/error） |
| 概念完整性 | ✅ activeSubagents 是 writer 内部记账计数，非"第二套状态"；state 仍四态 |
| IIFE 语法 | ✅ `node --check` 通过（3058 bytes） |
| 核心需求（workflow 跑期间保持 running） | ✅ 场景 2 通过（SubagentStart→Stop 保持 running） |
| 状态机正确性 | ❌ **发现 1 个 🔴 缺陷**：SubagentStop 归零时 `return null` 丢失计数递减，致 Stop 误判 running |

**命中统计**：🔴 1（状态机缺陷）｜🟡 0｜🔵 1（设计稿标题计数笔误）。8 项测试 7 通过 1 失败（场景 3，直击该 🔴）。

---

## 1. Findings

### 🔴 F-1 · SubagentStop 归零分支丢失计数递减 → Stop 读到陈旧计数误判 running

| 字段 | 内容 |
|---|---|
| rule_id | SM-01（状态机正确性；对应 02 清单 R-INT-01 纯函数性/状态正确性精神） |
| severity | 🔴 Fail |
| location | `hooks/cc-status.js:126-130`（deriveStatus `case 'SubagentStop'`） |
| evidence | `const next = inflight != null ? inflight : Math.max(a - 1, 0); if (next > 0) return {...}; return null;` —— 当 `next===0` 时 `return null`（不写文件），**递减后的计数 0 从未落盘**，文件保留旧 `activeSubagents`。 |
| why | 设计意图（SUBAGENT-design §4.5"next==0 不抢断，让 Stop 裁定终态"）本身正确——SubagentStop 不该写终态 `done`。但实现把"不定终态"与"不写文件"耦合：`return null` 同时丢弃了 (a) 终态决策（预期）和 (b) 计数递减（**非预期**）。于是紧随其后的 `Stop` 读到陈旧 `a=1`，`1>0 → running`，违背"subagent 已结束应转 done"。这破坏了 hybrid 方案 A 的核心契约"旧版本/无 background_tasks 时退化为 activeSubagents 计数"——退化路径给出错误状态。状态机不再是"同输入→同输出"的可靠映射：同一事件序列在不同 SubagentStop 写法下结果不同。 |
| failure_scenario | 实测复现：序列 `UserPromptSubmit→SubagentStart→SubagentStop→Stop`（test 场景 3）输出 `state=running, activeSubagents=1`，期望 `done`。更糟：一旦任一 subagent 曾启动并停止，主会话在该轮内**永久卡在 running**（计数永远不归零，每次 Stop 都见 a≥1）。 |
| 影响边界 | CC v2.1.204 生产环境被方法 B 遮蔽（Stop 的 `background_tasks` 权威，不依赖陈旧计数）；但**文档明示的旧版本（<v2.1.145）/无 background_tasks 事件路径**完全暴露。本审计要求的测试场景 3 直接命中。 |
| suggestion | 解耦"不定终态"与"持久化计数"。SubagentStop 归零时仍写回递减后的计数，但**保留 cur.state 不抢断**：`case 'SubagentStop': { const next = inflight!=null ? inflight : Math.max(a-1,0); return { state: next>0 ? 'running' : (cur.state||'running'), since: now, activeSubagents: next }; }`。验证：(a) 场景 3 → SubagentStop 写 `{running,0}`，Stop 见 a=0 → done ✓；(b) Stop 已写 `{done,0}` 后迟到的 SubagentStop → 写 `{done,0}`，不 un-done ✓。修复后 8 项测试应全过。 |
| confidence | high（实测复现 + 代码逐行追踪 + 修复方案可验证） |

---

### 🔵 F-2 · 设计稿 §5.1 标题计数笔误（"6 → 7" 实为 8）

| 字段 | 内容 |
|---|---|
| rule_id | DOC-01（文档一致性；02 清单 R-CI-06 rejected-by-design/文档精度精神） |
| severity | 🔵 Review |
| location | `docs/SUBAGENT-design.md:321`（§5.1 标题"HOOK_EVENTS（hybrid 版：6 → 7）"） |
| evidence | 标题写"6 → 7"，但同节代码块列出 8 个事件（UserPromptSubmit/PreToolUse/PostToolUse/SubagentStart/SubagentStop/Stop/StopFailure/SessionEnd）；真相源 STATES.md §2 footer 明确"（8 个）"；patch.ts HOOK_EVENTS 实际 8 个。 |
| why | 设计稿是"查证+设计稿"非真相源（其 §0 已声明"落地以 STATES.md 为准"），落地实现与 STATES.md 三方一致（8），故**无功能影响**。但标题计数笔误可能误导后续读者怀疑事件集规模。 |
| suggestion | 把 §5.1 标题改为"6 → 8"，或删除计数括注。confidence: high。 |

---

## 2. 已验证正确的项（非 finding，正面记录）

- **R-CI-01 三方事件集对齐**：cc-status.js deriveStatus 的 8 个 case（含 default→null）＝ patch.ts `HOOK_EVENTS`（line 116-125）8 个 ＝ STATES.md §2 事件表 8 行。新增 SubagentStart/SubagentStop 三处同步到位，无遗漏、无多余。
- **activeSubagents 字段契约一致**：cc-status.js 写 `{state,since,error?,activeSubagents}`（每 case 均带）；STATES.md §3 字段表声明该字段"仅供 writer 记账，reader 不读"。reader 侧实测：patch.ts IIFE line 349 仅解构 `state/since/error`，line 352 聚合推送也只取 `{sid,state,title,since}`，**不读 activeSubagents**——契约闭环。
- **概念完整性（review 三问 #1）**：activeSubagents 未引入"第二套状态"。它是 writer 决策 state 时的一个累加器输入，渲染契约仍是单一四态 state。reader 零改动（STATES.md §4 明示，patch.ts buildIIFE 确实未改）。不构成 R-CI 概念完整性违例。
- **状态机其余路径正确**：UserPromptSubmit/PreToolUse/PostToolUse→running ✓；Stop `background_tasks>0→running` 权威裁定 ✓（场景 7 证 B 独立于 A）；StopFailure 一律 interrupted 且保留计数 ✓（场景 5）；SessionEnd 删文件 ✓（场景 6）；read-modify-write 在 main() line 210-221 正确读 cur、line 224 传 deriveStatus ✓；原子写（tmp+rename）保留 ✓；clamp 0（Math.max(a-1,0)）逻辑本身正确（缺陷仅在 null 分支未落盘）；初始无文件 cur 默认 `{idle,0,0}` ✓。
- **并发竞态（设计 §4.3 R2）**：实现采纳了"hybrid 权威纠正 + clamp 0 + 接受 ±1 漂移"组合，未引入 lockfile（保持零依赖/快）。该决策合理；但注意 F-1 的 null 分支使漂移**超出 ±1**（计数完全不减），需先修 F-1，clamp 0 才真正生效。

---

## 3. 测试结果

测试件：`hooks/test-cc-status.js`（新增）。方法：spawn 真实 `cc-status.js`，每事件一个 node 进程（与 CC 触发 hook 的真实方式一致），HOME 指向临时目录隔离，stdin 喂 hook JSON，逐事件回读状态文件断言。**不复制逻辑**，测试的就是真实 hook。

```
$ node hooks/test-cc-status.js
Phase-2 state machine integration tests
(real hooks/cc-status.js, isolated HOME, method A counting path)

  PASS  1. UserPromptSubmit -> Stop = done (no subagent)            -> state=done
  PASS  2. UserPromptSubmit -> SubagentStart -> Stop = running [CORE]-> state=running
  FAIL  3. UserPromptSubmit -> SubagentStart -> SubagentStop -> Stop = done
                                                          expected=done got=running (activeSubagents=1)
  PASS  4. 2xStart -> SubagentStop -> Stop = running (1 left)       -> state=running
  PASS  5. SubagentStart -> StopFailure = interrupted (interrupt wins)-> state=interrupted
  PASS  6. SessionEnd deletes status file                           -> (no file)
  PASS  7. Stop w/ background_tasks=[workflow] = running (method B) -> state=running
  PASS  8. SubagentStop w/ background_tasks=2 = running (B corrects A)-> state=running

7 passed, 1 failed   (exit 1)
```

- **场景 2（核心需求）通过**：workflow 跑期间 Stop 不转 done。
- **场景 3 失败**：直击 F-1 —— `activeSubagents=1` 是 SubagentStop 未落盘递减的铁证。
- **场景 4 通过**：因 `next=1>0` 命中写入分支，恰好绕过 F-1；这也反证缺陷精准落在"归零分支"。
- **场景 7/8 通过**：方法 B（background_tasks 权威）独立工作，证明生产环境（v2.1.204）下 F-1 被遮蔽——但 A 退化路径仍须修复。

## 4. IIFE 语法检查

```
$ npx tsx patch.ts --check-iife > /tmp/cc-iife.js && node --check /tmp/cc-iife.js
IIFE node --check: OK (syntax valid)   3058 bytes
```

reader IIFE 未被 Phase-2 改动破坏（buildIIFE 确实零改动，符合 STATES.md §4"reader 零改动"声明）。

---

## 5. 收尾建议（优先级序）

1. **修 F-1**（🔴，阻断 A 退化路径正确性）：按 suggestion 改 SubagentStop 归零分支，重跑 `node hooks/test-cc-status.js` 至 8/8 通过。
2. **修 F-2**（🔵）：SUBAGENT-design §5.1 标题 6→8。
3. F-1 修复后，可考虑把 test-cc-status.js 接入 `npm test` / CI（它是端到端、零依赖、可复现的回归门）。
