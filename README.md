# claude-code-status-dot

给 Claude Code 的 VSCode 扩展加上**会话状态可视化**：tab 图标四态彩色点 + 完成/中断通知 + 右下角聚合色块条（点击切换会话）。

> 实现方式：**patch（补丁）**，不是独立扩展——VSCode 不允许第三方扩展修改另一个扩展的 webview tab 图标（见[为什么是 patch](#为什么是-patch)）。

![screenshot](docs/screenshot.png)
> 截图待补（`docs/screenshot.png`）。

---

## 它给你什么

1. **tab 图标四态点**：每个 Claude Code 会话的 tab 图标按状态变色 —— 🟡 运行中（呼吸）/ 🟢 完成 / 🔴 中断（快闪）/ ⚪ 空闲。**同时显示在顶部 tab 栏和左上角"打开的编辑器"视图**（iconPath 是 tab 属性，两处共用）。比 CC 原生（只有蓝/橙两点）更完整。
2. **完成 / 中断通知**：会话完成或被限速中断时，前台抑制、**切走窗口时弹系统通知 + 声音**，不用一直盯着。
3. **聚合色块条**：CC 面板右下角浮层，每个会话一个色块（同四态色），**点击切到对应会话 tab**。

## 状态色

| 颜色 | 含义 | 触发 |
|---|---|---|
| 🟡 黄色（呼吸） | 运行中 | 发 prompt、工具调用前后（心跳） |
| 🟢 绿色（静态） | 本轮完成 | CC 触发 `Stop`（超 5 分钟转灰） |
| 🔴 红色（快闪） | 中断 / 出错 | CC 触发 `StopFailure`（限速、过载等） |
| ⚪ 灰色（静态） | 空闲 | 初始 / 完成超 5 分钟 / 无状态文件 |
| 🔵 蓝色（CC 原生） | 待授权 | CC 原生蓝点，**本项目不覆盖** |

完整状态契约（事件 / SVG / IPC / 通知）见 [`docs/STATES.md`](docs/STATES.md)。

## 快速开始

**前置**：Node.js 18+；Claude Code 的 VSCode 扩展已安装。

```bash
git clone <this-repo> claude-code-status-dot
cd claude-code-status-dot
npx tsx patch.ts          # patch + 自动接 hooks + 校验（幂等）
```

然后 **Reload Window**：`Cmd+Shift+P`（Mac）/ `Ctrl+Shift+P`（Win）→ `Developer: Reload Window`。

发一条 prompt，看 tab 图标变黄呼吸；CC 完成 → 变绿 +（切走窗口时）系统通知；右下角出现聚合色块条。

## 命令

| 命令 | 作用 |
|---|---|
| `npx tsx patch.ts` | 安装（patch `extension.js` + `webview` + 接 hooks，幂等） |
| `npx tsx patch.ts --revert` | 还原（从 `.bak` 恢复 `extension.js` + `webview`，移除 hooks） |
| `npx tsx patch.ts --status` | dry-run 报告，不改任何文件 |

## 通知配置（可选）

写进 VSCode 的 `settings.json`：

```json
{
  "ccStatusDot.notify": true,
  "ccStatusDot.notifyWhenFocused": false,
  "ccStatusDot.notifySound": "Glass"
}
```

- `notify`：总开关（默认 `true`）
- `notifyWhenFocused`：前台时也弹 VSCode 消息（默认 `false`，图标已足够）
- `notifySound`：macOS 系统通知声音（默认 `"Glass"`；`""` 静音）

> 首次收到系统通知时 macOS 会弹一次"Script Editor 想发送通知"授权，允许即可。

## 它是怎么工作的

**patch CC 的 `extension.js` + `webview/index.js` + `webview/index.css`，注入：**

- **`extension.js`**：一个 500ms 定时器（IIFE）——读状态文件设 tab 图标 + 聚合所有会话状态推给 webview + 监听"点击切 tab"消息。
- **`webview`**：右下角色块条（vanilla DOM，挂在 body，**不进 React 树**，零渲染干扰）+ 点击回传切 tab。
- **CC hooks** 把每个会话状态写入 `~/.claude/cc-tab-status/<session_id>.json`（`{state, since, error?}`）。
- **7 个 SVG**（idle / running×4 帧 / done / error）在本项目 `resources/`，按绝对路径引用（CC 更新只覆盖扩展目录，SVG 不丢）。

详见 [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md)（图标注入）+ [`docs/WEBVIEW-injection.md`](docs/WEBVIEW-injection.md)（色块条注入）。

## 为什么是 patch

VSCode 的 `WebviewPanel` tab 图标（`iconPath`）由**创建该 panel 的扩展独占设置**，没有公开 API 让第三方扩展改它。CC 的 session tab 正是 CC 扩展自己创建的 WebviewPanel，其图标只能在 CC 的 `extension.js` 内部赋值。穷尽替代方案（独立扩展、proposed API、webview 拦截等）均不可达，唯一可行路径是 patch。代价：CC 自动更新会覆盖，需重跑 patch。

## FAQ

**CC 更新后状态点不亮了？** CC 自动更新整体替换扩展目录，patched 文件被原版覆盖。重跑 `npx tsx patch.ts`（SVG 在本项目目录不丢）。

**刚装完图标没变？** 先 `Developer: Reload Window`。还不行跑 `--status` 看报告。

**patch 报 "Anchor mismatch"？** CC 的 minified 代码漂移了。patcher 拒绝写入，扩展未损坏。到 issue 区附 CC 版本号反馈。

**状态卡在 running？** 多半用 Esc 中断了 CC（无 hook）。下次 prompt 或正常完成会自然更正。

**色块条压住输入框？** 调 CSS `bottom` 偏移（见 [`docs/WEBVIEW-injection.md` §5.2](docs/WEBVIEW-injection.md)）。

## 已知限制

- **手动 Esc 中断无 hook**：CC 不触发 Stop/StopFailure，状态停在 running，靠下次 prompt/Stop 自然更正（[anthropics/claude-code#45289](https://github.com/anthropics/claude-code/issues/45289)）。
- **CC 自动更新覆盖**：patched `extension.js`/`webview` 被原版覆盖 → 静默失效，重跑 patch。
- **minified anchor 版本脆性**：patch 依赖 CC 代码里几段精确字符串，版本升级漂移时 patcher 报错拒绝写入。
- **VSCode 完全关闭时不通知**：IIFE 跑在扩展宿主，VSCode 关闭则不通知。
- **系统通知点击不跳 tab**：osascript 无 click callback，回 VSCode 靠 tab 点定位。

## 风险声明

本项目修改 Claude Code 扩展的 `extension.js` + `webview/index.js` + `webview/index.css`（均已备份，`--revert` 完整还原），并写入 `~/.claude/settings.json`（首次备份）。hook 脚本设计为**永不阻塞或中断 CC**——任何错误静默 `exit(0)`。使用前请读已知限制。

## 卸载

```bash
npx tsx patch.ts --revert   # 还原 extension.js + webview + 移除 hooks
```

然后删除本项目目录。`~/.claude/cc-tab-status/` 是用户数据，可自行删除。

## License

MIT (c) wangdong
