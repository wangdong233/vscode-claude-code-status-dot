# ADR-001: 注入架构从锚点替换迁移到 Seam(零锚 prepend + require 重绑 + 表面观察)

日期: 2026-09-03 · 状态: 已接受(实施中)

## 背景
CC 2.1.259 第三次锚区形状漂移致锚 A/B 双灭(结构性,容错层不可吸收)。47 天 6 次漂移、
MTBF≈10-12 天且三轴恶化。锚区是 CC 主动重写的热区——再修一次只买 ~1.5 周。

## 决策
Seam 为主通路(bundle 头部 prepend 零锚 + 模块局部 require 形参重绑 + vscode API 表面包装
+ 协议消息双向观察)。完整设计见 docs/design-v0.6-seam.md。

## 锚注入能力退役
v0.5.x 锚注入态保留迁移读取能力(banner 解析 + 三形状剥离),锚注入机制退役,无 legacy 开关。

## 继任架构(触发=cc-esm-detected,规格落档、代码不预写)

### 2.4 继任架构规格（落档 docs/，代码不预写）

触发条件（任一）：patcher P2 门报 `cc-esm-detected`；或 fleet 心跳显示 seam 运行时门大面积失败（envelopeFail 超阈 + 观察归零）且非协议漂移。
规格要点（实施时直接细化）：定位键 = `request.type==="update_session_state"` 属性链形态（兼容单双引号/`.request` 前缀变体）；前置条件 = 全文件恰好 1 命中（0 或 ≥2 均 fail-closed）；捕获 = enclosing arm 的分发参数标识符（AST 动态提取，不硬编码变量名）；注入体 = 全 try/catch 包裹、零 CC 作用域假设、banner 沿用 `/*cc-status-dot-injected:...*/` 字节级格式；剥离 = 注入区间确定删除 + roundtrip 闸门。farewell-frame 语义税与本设计 §6.4 相同规则。

---

