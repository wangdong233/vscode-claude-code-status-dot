# 贡献指南（CONTRIBUTING）

感谢参与！本项目是一个小工具：`patch.ts`（patcher，v0.6.0 起 seam 零锚架构——prelude 头部注入 + `require` 形参重绑 + 协议消息观察，架构决策见 [`docs/ADR-001-seam-architecture.md`](docs/ADR-001-seam-architecture.md)）+ `hooks/cc-status.js`（状态写入 hook）+ 30 个 SVG（15 基础 × 含齿轮徽标变体）+ seam 注入 IIFE。动手前请先读 [`docs/STATES.md`](docs/STATES.md)（唯一状态契约）和 [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md)（注入原理）。

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

## CC 版本更新的韧性（v0.6.0 seam 架构）

> v0.5.x 的三层锚注入（A/B/C）已退役（CC 2.1.259 第三次锚区形状漂移所致），本节描述现行机制；历史锚方案见 [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md)（已标注退役）与 git 历史。

v0.6.0 起 patch 对 CC `extension.js` 的版本敏感面收敛为 **seam 零锚注入**（决策记录 [`docs/ADR-001-seam-architecture.md`](docs/ADR-001-seam-architecture.md)）：

- bundle 头部 prepend 零锚 prelude + 模块局部 `require` 形参重绑 + vscode API 表面包装（`createWebviewPanel` / view-provider / serializer 双名）+ 协议消息双向观察（入站 `onDidReceiveMessage` / 出站 `postMessage` 白名单 shadow）。
- 战斗逻辑（§A..§Z IIFE body）从锚时代字节级复用，观察者合成 `t` 上下文供值——**CC minified 内部标识符零引用**，CC 常规更新不需要改本仓库任何常量（已实证穿越 2.1.259→2.1.266）。
- 架构寿命边界：patcher 四判 ESM 检测，CC 若整体转 ESM 模块化则报 `cc-esm-detected` 并停止自动重试（fail-closed），继任方案见 ADR-001。
- 失配/失败时 fail-closed 报错类别（stdout 机器行），绝不留半改文件；companion 据此自愈分流。

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
- **不要引入**已被架构审查否决的概念（审查记录 AUDIT.md F-6 已随文档清理删除，见 git 历史）：watchdog、VSCode 通知 / `showInformationMessage`、`src/` 目录、独立 VSCode 扩展、`status-dot/` 目录、`write-state.js`。

## 架构 review 三问（每个 PR 必答）

提交前在 PR 描述里回答这三问（源自架构简单性审核清单 §6.3）：

1. **本次是否引入了第二套状态 / 术语 / 做法？** 如果加了新状态名、新事件、新文件命名约定，说明它与 [`docs/STATES.md`](docs/STATES.md) 的关系（替代 / 合并 / 归属），并已同步到唯一真相源。
2. **新抽象暴露的是 what 还是 how？** 对外契约（状态、事件、颜色）应暴露 what；注入 IIFE 里绕 minified 的实现细节属于 how，不应渗入文档与对外承诺。
3. **共享逻辑是否按 caller 分流？** 注入块跑在 CC 扩展宿主里、无法 import 本仓库模块，自包含是被迫的合理重复；除此之外的共享逻辑（状态枚举、SVG 名单、事件集）必须收敛到单一来源（[`docs/STATES.md`](docs/STATES.md)），而不是在多处复制。

## License

提交即表示你同意以 MIT 许可发布（见 [LICENSE](LICENSE)）。
