# 贡献指南（CONTRIBUTING）

感谢参与！本项目是一个小工具：`patch.ts`（patcher）+ `hooks/cc-status.js`（状态写入 hook）+ 5 个 SVG + 注入 IIFE。动手前请先读 [`docs/STATES.md`](docs/STATES.md)（唯一状态契约）和 [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md)（注入原理）。

## 项目心法

1. **最小侵入**：只改 CC `extension.js` 一处必要位置；注入代码不引用任何 minified 标识符（仅用 `require("fs"|"path"|"vscode"|"os")` + `this` + `Date`）。
2. **完全可逆**：`--revert` 必须能干净还原 `extension.js` 与 `settings.json`（基于标记的精确移除，不是整体覆盖）。
3. **版本韧性**：anchor 失配时报错并拒绝写入，绝不留下半改文件。

## 代码风格（quote 风格约定）

**TS 文件用双引号，JS hook/test 用单引号——这是有意的、文件类型各侧自洽的约定**，不是疏漏：

- `patch.ts`（patcher，TS）：双引号 + 4 空格缩进（Prettier TS 默认）。
- `hooks/*.js` / `hooks/*.mjs`（hook + test，JS）：单引号 + 2 空格缩进（Node/JS 社区惯例）。
- `*.md`：2 空格，`proseWrap: preserve`（不重排段落）。

**防漂移的工具契约**：

- `.prettierrc.json` 通过 `overrides` 把每类文件的 quote/缩进偏好固定下来——任何贡献者跑 `prettier --write` 时它**保留**现有 quote 风格而非"纠正"（这是 M6 finding 真正担心的漂移点：TS 文件被 flip 成单引号或 JS 被 flip 成双引号）。
- `.editorconfig` 提供跨编辑器（VSCode/JetBrains/vim/…）的基线，保存时不与 Prettier 打架。
- `npm run format:check`（不阻塞 `npm test`，CI 可选接入）当前会对**预先存在的**非-quote 风格选择（多行数组/三元、超出 `printWidth: 120` 的拼接等）报警——这些与 M6 无关，是历史风格，可在后续独立 PR 里逐步收敛或一次性 `prettier --write` 全文 reformat。本轮只引入契约，不改既有代码风格。

**选择契约而非全局 reformat 的理由**：每侧文件内部已经自洽且符合各语言社区惯例，reformat 一侧去迎合另一侧会产生大 diff、污染 `git blame`、徒增审查负担；契约方式 0 行代码改动，未来漂移由工具自动报警。

## patch anchor 的 CC 版本脆性

整个 patch 的版本敏感面收敛在 `patch.ts` 里的三层锚（A/B/C，各为两层：精确字面快路径 + 容错正则兜底）：

- **Anchor A**（`update_session_state` handler，必须唯一命中）：注入点，捕获 `sessionId` + 启动 500ms 重绘定时器。
- **Anchor B**（`rename_tab` 图标分支，可选，命中 0 或 1 次）：加固，消除 CC 重设图标后 ~500ms 的闪烁。
- **Anchor C**（`requestUserDialog` consent/refusal 蓝点；命中 0 或 1 次）：可选加固锚，失配软降级（A+B 安装继续，consent 蓝点不生效）。

CC 每次 minified 代码漂移都可能导致 anchor 对不上。规则：

- 锚点两层：tier-1 **精确字面**（快路径，唯一命中）；tier-2 **容错正则**（以 IPC 协议字符串为字面锚、minified 标识符为 `[A-Za-z0-9_$]+` 捕获）——混淆器改名类漂移自动兼容，任一层命中数非唯一即 fail-closed（Anchor A 必须 == 1，Anchor B/C ∈ {0, 1}）。
- 失配时**立即抛错、不写任何文件**，并在错误信息里提示用户提 issue 附 CC 版本。
- 更新 anchor 时，先用 `npx tsx patch.ts --status` 确认在新版 CC 上的命中情况，再改常量。

## 本地测试方法

1. `npx tsx patch.ts` 装补丁。
2. `Developer: Reload Window`。
3. 在 CC 里触发各状态，肉眼核对图标颜色：
   - 发一条 prompt → **黄色呼吸**（`running`）。
   - 等本轮正常完成 → **绿色**（`done`）。
   - 等 5 分钟以上 → **灰色**（reader 把超时 `done` 渲染为 `idle`）。
   - 触发授权请求 → **蓝色**（CC 原生，reader 不覆盖）。
4. `npx tsx patch.ts --status` 确认报告正常。
5. `npx tsx patch.ts --revert` 确认能干净还原，Reload 后图标回到 CC 原生。

## PR 规范

- 一个 PR 只做一件事。状态 / SVG / 事件 / 颜色的任何增删，**先改 [`docs/STATES.md`](docs/STATES.md)**，再机械同步以下各处：
  - `patch.ts`：`OUR_SVGS`、`HOOK_EVENTS`、`buildIIFE` 的状态分支。
  - `hooks/cc-status.js`：`deriveStatus` 的 case。
  - `resources/`：新增 / 改名 SVG 文件。
  - `README.md` / `README.en.md` / `docs/USAGE.md` / `companion/CHANGELOG.md (archived at 0.5.9)` / `package.json`。
- 中英文 README 保持同步。
- 改 `extension.js` 相关逻辑时，确保 `--revert` 路径仍能干净还原。
- **不要引入**已被架构审查否决的概念（见 [`docs/AUDIT.md`](docs/AUDIT.md) F-6）：watchdog、VSCode 通知 / `showInformationMessage`、`src/` 目录、独立 VSCode 扩展、`status-dot/` 目录、`write-state.js`。

## 架构 review 三问（每个 PR 必答）

提交前在 PR 描述里回答这三问（源自架构简单性审核清单 §6.3）：

1. **本次是否引入了第二套状态 / 术语 / 做法？** 如果加了新状态名、新事件、新文件命名约定，说明它与 [`docs/STATES.md`](docs/STATES.md) 的关系（替代 / 合并 / 归属），并已同步到唯一真相源。
2. **新抽象暴露的是 what 还是 how？** 对外契约（状态、事件、颜色）应暴露 what；注入 IIFE 里绕 minified 的实现细节属于 how，不应渗入文档与对外承诺。
3. **共享逻辑是否按 caller 分流？** 注入块跑在 CC 扩展宿主里、无法 import 本仓库模块，自包含是被迫的合理重复；除此之外的共享逻辑（状态枚举、SVG 名单、事件集）必须收敛到单一来源（[`docs/STATES.md`](docs/STATES.md)），而不是在多处复制。

## License

提交即表示你同意以 MIT 许可发布（见 [LICENSE](LICENSE)）。
