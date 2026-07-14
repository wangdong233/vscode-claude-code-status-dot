# Open Editors 状态点调研（phase2 决策依据）

> 结论先行：**类 A「已满足」（把握度 high）**。我们 patch 的 `panelTab.iconPath` **已经被
> "Open Editors"（打开的编辑器）读取并显示**，且 500 ms 呼吸动画**会实时同步**到该视图。
> **无需 phase2 实施**，只需文档说明 + 建议用户肉眼复核。
>
> 下方为完整证据链（VSCode 官方文档 + 源码逐行追踪），非臆测。

---

## 0. 术语对齐

| 术语 | 指代 |
|---|---|
| Open Editors（打开的编辑器） | 资源管理器顶部列出所有打开 tab 的原生视图，view id = `workbench.explorer.openEditorsView` |
| tab 栏 | 编辑器区域顶部的 editor tab 栏（我们 r6 四态点已在此生效） |
| `iconPath` | `WebviewPanel.iconPath`（扩展 API）/ `WebviewInput.iconPath`（workbench 内部），我们 patch 的对象 |
| `editor.getIcon()` | `EditorInput.getIcon()`，Open Editors 与 tab 栏取图标的统一入口 |

---

## 1. Open Editors 是什么机制？

**原生 view，扩展不可直接改其渲染，但它复用了 editor 的图标/标题。**

- 它是 `ViewPane` 子类 `OpenEditorsView`（`src/vs/workbench/contrib/files/browser/views/openEditorsView.ts`），
  id 常量 `workbench.explorer.openEditorsView`。内容由 `WorkbenchList<OpenEditor | IEditorGroup>` 渲染。
- 数据来自 `editorGroupService.getGroups(...).editors.map(ei => new OpenEditor(ei, g))`——即**遍历每个
  打开的 editor input**（包括 CC 的 webview panel input），不是文件系统。
- 行渲染器 `OpenEditorRenderer.renderElement` 把每个 editor 的名字/资源/**图标**交给 `ResourceLabels.setResource`：

```ts
// openEditorsView.ts -> OpenEditorRenderer.renderElement
templateData.root.setResource({
    resource: EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.BOTH }),
    name: editor.getName(),
    description: editor.getDescription(Verbosity.MEDIUM)
}, {
    // ...
    icon: editor.getIcon()   // <<< 关键：图标取自 editor.getIcon()
});
```

→ **Open Editors 与 tab 栏读的是同一个 `editor.getIcon()`**。对 webview panel，
`getIcon()` 返回的就是 `iconPath`（见 §2）。

来源：microsoft/vscode `src/vs/workbench/contrib/files/browser/views/openEditorsView.ts`（master）

---

## 2. iconPath 在 Open Editors 是否生效？—— **生效（high）**

### 2.1 官方文档（两处明文）

- **v1.26（2018-07）发行说明**原文：
  > **Webview icons** — Webviews may now provide a custom icon that is shown in the
  > **tab bar and OPEN EDITORS view**.
  - https://code.visualstudio.com/updates/v1_26
- **API 参考**对 `WebviewPanel.iconPath` 的定义：
  > An icon to show in the editor tab and **OPEN EDITORS view**.
  - https://code.visualstudio.com/api/references/vscode-api

> iconPath 自设计之初就是**同时**作用于 tab 栏与 Open Editors 的单一属性。

### 2.2 源码逐行确认（`WebviewInput.getIcon`）

```ts
// src/vs/workbench/contrib/webviewPanel/browser/webviewEditorInput.ts
override getIcon(): URI | ThemeIcon | undefined {
    if (!this._iconPath) return;
    if (ThemeIcon.isThemeIcon(this._iconPath)) return this._iconPath;
    return isDark(this._themeService.getColorTheme().type)
        ? this._iconPath.dark
        : (this._iconPath.light ?? this._iconPath.dark);
}
```

→ `getIcon()` 返回 `iconPath` 指定的 URI。§1 已证 Open Editors 行渲染调用 `editor.getIcon()`。
**闭环成立：iconPath → getIcon() → Open Editors 显示。**

---

## 3. 500 ms 呼吸动画是否同步到 Open Editors？—— **同步（high）**

完整事件链（逐段源码确认）：

```
[扩展宿主] 我们的 IIFE 每 500ms:  p.iconPath = vs.Uri.file(svg)
        │  (跨进程：ext host → main thread webview)
        ▼
[main] WebviewInput.iconPath setter:
        public set iconPath(value) {
            this._iconPath = value;
            this._onDidChangeLabel.fire();   // <<< 显式 fire label 变更
        }
        │  (EditorInput._onDidChangeLabel → editor group onDidModelChange)
        ▼
[editor group] onDidModelChange { kind: GroupModelChangeKind.EDITOR_LABEL }
        ▼
[OpenEditorsView.registerUpdateEvents] 该 case 分支:
        case GroupModelChangeKind.EDITOR_LABEL:
            this.list.splice(index, 1, [new OpenEditor(e.editor!, group)]); // 重渲单行
            this.focusActiveEditor();
        ▼
[OpenEditorRenderer.renderElement] 再次执行 -> icon: editor.getIcon() -> 取到新 SVG URI
```

关键点：
- `WebviewInput.iconPath` 的 **setter 显式 fire `_onDidChangeLabel`**（webviewEditorInput.ts，逐字引用见上）。
- OpenEditorsView 的 `EDITOR_LABEL` 分支 **立即 splice 重渲该单行**（受 `structuralRefreshDelay`，默认 0；受
  `listRefreshScheduler.isScheduled()` 短路保护——仅对结构重排类事件，不影响 label 单行重渲）。
- 视图不可见时置 `needsRefresh=true`，重新可见时整体刷新——所以即使视图当时折叠，展开后也会显示最新态。

→ **呼吸/快闪动画会在 Open Editors 实时跟随**（500 ms 一帧，与 tab 栏一致）。

### 3.1 副作用评估（诚实记录）

- 每 500 ms 触发一次 `EDITOR_LABEL`，OpenEditorsView 的 label 分支额外调用一次 `focusActiveEditor()`——
  仅"保持焦点行高亮在 active editor"，**无害**。
- 排序模式为 `alphabetical`/`fullPath` 时，label 变更会 `schedule()` 一次重排（默认 `editorOrder` 不受影响）。
  CC 的 tab 标题不随状态变，故排序键不变，重排无实际位移，开销可忽略。
- N 个 tab = N 个 500 ms 定时器，每 tick 多触发 N 次单行重渲——单行 splice 成本极低，可接受
  （与 patch.ts 现有 LIMITATIONS 记录的 timer 模型一致，无新增负担）。

---

## 4. 图标尺寸：r6 点在 Open Editors 是否可见？—— **清晰可见**

### 4.1 渲染尺寸

- Open Editors 行高 `OpenEditorsDelegate.ITEM_HEIGHT = 22`（`openeditors.css`: `.open-editor { height:22px; line-height:22px }`）。
- 容器带 `show-file-icons` class，`ResourceLabels` 把 `icon` URI 渲染为文件图标尺寸——VSCode 文件图标标准为 **16×16 px**。

### 4.2 我们的 SVG 点占比

`resources/*.svg` 均为 `viewBox="0 0 24 24"`，状态点是 `<circle cx="18" cy="6" r="6">`：
- r=6 → 直径 12，占 viewBox 宽 12/24 = **50%**。
- 在 16 px 图标下，状态点有效直径 ≈ **8 px**（tab 栏图标通常更大，点更醒目；Open Editors 稍小但 8 px 仍远超可辨阈值）。

→ **Open Editors 中四态点清晰可辨，呼吸切换可见**。无需为 Open Editors 单独放大点。

---

## 5. 备选增强路径评估（因已满足，仅留档，不实施）

| 路径 | 是否可行 | 评估 |
|---|---|---|
| **(a) patch `panelTab.title` 加状态后缀**（如 `标题 [running]`） | 可行但**不必要 + 有副作用** | title 同步影响 tab 栏 / Open Editors / window title；500 ms 切换会持续抖动 window title；且"呼吸/快闪"无法用文字表达。当前已用 iconPath 表达，title 冗余。**不采纳。** |
| **(b) FileDecorationProvider** | **不适用** | 该 API 只对 Explorer/Tree View 中的**文件资源**生效（badge/颜色）。CC webview panel 的 resource 是 `webviewPanel:` scheme 的虚拟 URI，**不是文件系统资源**，Open Editors 不对其应用 FileDecorationProvider。 |
| **(c) patch CC webview** | **无效** | Open Editors 是 VSCode 原生 list，DOM/逻辑都不在 CC webview 内；改 CC webview 影响不到它。 |
| **(d) patch VSCode 本体 DOM 改 Open Editors 渲染** | 理论可行但**重/脆/违规** | 无 API，需改 workbench 产物；升级即失效；与 iconPath 已生效的事实重复。**唯一不需要走的路。** |
| **(e) proposed API / Open Editors 装饰 API** | **无** | 社区已请求（vscode-discussions #1122：为 Open Editors 菜单加 API），目前无稳定/proposed API 直接装饰 Open Editors tab。但因 iconPath 已覆盖需求，缺口不影响本项目。 |

---

## 6. 结论：phase2 决策

### 类 A「已满足」（把握度 high）

| 维度 | 判定 |
|---|---|
| iconPath 在 Open Editors 生效 | ✅ 文档（v1.26 发行说明 + API 参考）+ 源码（`OpenEditorRenderer`→`getIcon()`）双重确认 |
| 500 ms 呼吸/快闪同步 | ✅ 源码事件链确认：`iconPath` setter → `_onDidChangeLabel` → `EDITOR_LABEL` → 单行重渲 |
| r6 点可见性 | ✅ 占图标 50%，16 px 下 ≈8 px，清晰可辨 |

### 决策

- **不实施 phase2**。当前 patch 已天然覆盖 Open Editors。
- **唯一收尾动作（可选）**：
  1. 在 `README.md` / `docs/USAGE.md` 增加一句说明："状态点同时显示在顶部 tab 栏与资源管理器的『打开的编辑器』视图"。
  2. 请用户**肉眼复核**：打开 Open Editors 视图（资源管理器顶部，若无则在 `view` 菜单勾选），确认 CC tab 行的四态点 + 呼吸与 tab 栏一致——这是零成本的最终实证。

### 不确定项（诚实标注）

- 上述为源码逻辑链推理，**把握度 high**，但未经本项目实机截图验证。最廉价验证方式即用户直接看 Open Editors
  视图（30 秒），若四态点已出现并呼吸，即完成确认；若因某 VSCode 版本/设置差异未显示，再回看本文件 §3 事件链排查。

---

## 证据清单（sources）

- VSCode v1.26 发行说明（iconPath 引入，明文"tab bar and OPEN EDITORS view"）：
  https://code.visualstudio.com/updates/v1_26
- VSCode API 参考（`WebviewPanel.iconPath` 定义）：
  https://code.visualstudio.com/api/references/vscode-api
- VSCode 源码 `src/vs/workbench/contrib/files/browser/views/openEditorsView.ts`（`OpenEditorRenderer.renderElement` 调 `editor.getIcon()`；`EDITOR_LABEL` 单行重渲）：
  https://github.com/microsoft/vscode/blob/master/src/vs/workbench/contrib/files/browser/views/openEditorsView.ts
- VSCode 源码 `src/vs/workbench/contrib/webviewPanel/browser/webviewEditorInput.ts`（`iconPath` setter fire `_onDidChangeLabel`；`getIcon()` 返回 iconPath）：
  https://github.com/microsoft/vscode/blob/master/src/vs/workbench/contrib/webviewPanel/browser/webviewEditorInput.ts
- VSCode 源码 `src/vs/workbench/contrib/files/browser/views/media/openeditors.css`（行高 22px）：
  https://github.com/microsoft/vscode/blob/master/src/vs/workbench/contrib/files/browser/views/media/openeditors.css
- 社区请求 Open Editors 装饰 API（佐证当前无直接 API，但本项目无需）：
  https://github.com/microsoft/vscode-discussions/discussions/1122

---

## 7. 验证说明（phase2 收尾，2026-07-15）

> 本节为类 A「已满足」决策的落地说明，**未改动任何代码**（`patch.ts` / `cc-status.js` / `STATES.md`
> 均未触碰）。原因：phase1 已证明我们 patch 的 `panelTab.iconPath` 天然被 Open Editors 复用，
> 无需新增 patch 路径。

### 结论

**Open Editors（资源管理器顶部的"打开的编辑器"视图）里 CC 的 tab 图标，已自动显示四态点 +
呼吸动画，与顶部 tab 栏完全一致，无需任何额外实施。**

依据见上方 §1–§4 的证据链（VSCode v1.26 发行说明明文「tab bar and OPEN EDITORS view」+
源码 `OpenEditorRenderer.renderElement` → `editor.getIcon()` → `WebviewInput.getIcon()` 返回
iconPath 的闭环）。

### 如何肉眼复核（30 秒，零成本实证）

1. 确保资源管理器侧栏可见，顶部应有"打开的编辑器"分组；若没有，菜单 `查看 → 外观 → 显示打开的编辑器`
   （或命令面板搜 `Open Editors: Focus`）。
2. 打开任意 CC session tab（让它出现在 Open Editors 列表中）。
3. 观察该行的图标：应看到右上角的四态点（idle 灰 / running 绿呼吸 / done 蓝 / interrupted 红快闪），
   且每 500 ms 与顶部 tab 栏同步切换。
4. 若四态点出现并呼吸 → 确认完成；若因某 VSCode 版本/主题差异未显示，回看 §3 事件链排查。

### 需留意的点（尺寸）

- Open Editors 行高 22 px，文件图标标准 **16×16 px**（比 tab 栏图标小）。
- 我们的 SVG 状态点占 viewBox 宽 50%，在 16 px 图标下有效直径 ≈ **8 px**——仍远超可辨阈值，
  四态颜色切换清晰可见；但相比 tab 栏，点会**偏小一点**，请勿误判为"未生效"。
- 这是 VSCode 原生渲染尺寸，**非我们可控制的范围**；如需在 Open Editors 中更显眼，无 API 可走
  （见 §5 备选路径全部否决），只能接受 16 px 的原生表现。

### 未做的事（诚实记录）

- 未为 Open Editors 单独放大状态点（无 API，§5 路径 b/c/d/e 全否决；路径 a「改 title 加后缀」
  会污染 window title 且无法表达呼吸，不采纳）。
- 未改 `patch.ts` 的注入逻辑（iconPath 已统一覆盖两处视图，再加任何 patch 都是冗余且有副作用）。
- 未跑 `tsx --check-iife` / `--status` / 测试——因为**没有任何代码改动**，现有 CI 产物不变。

### 决策一句话

**无需实施，已满足。** 现有 patch 一处注入（`panelTab.iconPath`），tab 栏与 Open Editors 两处同时生效。
