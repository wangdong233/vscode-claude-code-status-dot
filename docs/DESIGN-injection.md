# CC 扩展图标注入设计（DESIGN-injection）

> 逆向目标：`anthropic.claude-code-2.1.204-darwin-x64/extension.js`（minified, 2.27 MB）
> 日期：2026-07-10
> 结论先行：**注入可行；session↔panel 映射可达（需 1～2 锚点 patch）；最大风险 = CC 自动更新覆盖 + minified 名漂移。**

---

## 1. 完整分支逻辑（已逐字节确认）

图标切换只发生在 **1 处**（`iconPath` 全文共 4 处，仅此 1 处是 panel tab 图标；另 3 处是 terminal / panel 创建默认值，勿动）。

**精确字符串（字节偏移 ~2158836–2159078）：**
```js
if(e.request.type==="rename_tab"){if(this.panelTab){this.panelTab.title=e.request.title;let r;if(e.request.hasPendingPermissions)r="claude-logo-pending.svg";else if(e.request.hasUnseenCompletion)r="claude-logo-done.svg";else r="claude-logo.svg";this.panelTab.iconPath=ue.Uri.file(dn.join(this.context.extensionPath,"resources",r))}return{type:"rename_tab_response"}}
```

要点：
- 该 handler 属于 **class `ts extends wF`**（每个 panel/tab 一个实例，字段含 `panelTab;webview;onSessionStateChanged;isFullEditor;...`）。
- `e.request` 字段：`{type:"rename_tab", title, hasPendingPermissions, hasUnseenCompletion}` —— **不含 sessionId**。
- done 态触发条件 = `e.request.hasUnseenCompletion`（**不是** `hasError`/`lastErrorResultText`，brief 的猜测作废）。
- minified 别名：`ue` = vscode 模块（`ue.Uri.file`/`ue.workspace`/`ue.commands` 已证实）；`dn` = path 模块（`dn.join`）；`r` = 本地 SVG 文件名变量；`this.context.extensionPath` = 扩展安装目录。

## 2. 刷新时机（已确认：非周期性）

- webview 侧发送方（`webview/index.js` 偏移 3133132）：
  `renameTab(e,t,i){return this.sendRequest({type:"rename_tab",title:e,hasPendingPermissions:t,hasUnseenCompletion:i})}`
- 即 **图标刷新是事件驱动**：仅当 `hasPendingPermissions` / `hasUnseenCompletion` / `title` 变化时 webview 才发 rename_tab。
- **结论：CC 自身不做周期性重绘。** 外部状态文件（`~/.claude/cc-tab-status/<sid>.json`）变化不会触发任何重绘。呼吸/快闪动画 **必须由 patch 自己注入 `setInterval`** 实现。这是硬性依赖。

## 3. session ↔ panelTab 映射（成败关键 —— 已确认：可达）

### 3.1 两层类结构
- **class `ts`（per-panel，偏移 ~2154000）**：持有 `this.panelTab`（WebviewPanel）、`this.onSessionStateChanged`。`rename_tab` handler 在此类内。**构造器不存 sessionId**（已读构造体：存的是 `context;cwd;settings;webview;panelTab=m;requestUsageBroadcast;isFullEditor;onSessionStateChanged=g;...`，无 sid 字段）。
- **Manager 类（偏移 ~2188900）**：持有 `sessionPanels=new Map`、`sessionStates=new Map`、`activeSessionId`、`updateSessionState(e,t,r){this.sessionStates.set(e,{sessionId:e,state:t,title:r})...}`、`sessionPanels.set(e,o)`（`e`=sessionId, `o`=panel 对象=ts 实例）。

### 3.2 sessionId 在 rename_tab handler 内 **不可直接拿到**
`e.request` 无 sessionId；`this` 无 sid 字段。直接逆向 `sessionPanels` Map 需要 manager 引用，从 `ts` 内部不可达。

### 3.3 可达方案（采用）：兄弟 handler 捕获 sid
`update_session_state` handler 与 `rename_tab` handler **同属一个 `ts` 实例**（同一 panel），且其 `e.request` **含 sessionId**：
```js
else if(e.request.type==="update_session_state")return this.onSessionStateChanged?.(e.request.sessionId,e.request.state,e.request.title),{type:"update_session_state_response"}
```
webview 发送方（偏移 3133735）：`{type:"update_session_state",sessionId:e,state:t,title:i}` —— **per-panel 携带本 panel 的 sid**。

→ **在此 handler 内把 sid 挂到 `this.__ccSid`**，后续 `setInterval` 读取 `this.__ccSid` 即可。映射 **可达**，无需触碰 manager 的 Map。

> 边界：`update_session_state` 需至少触发 1 次才能捕获 sid + 启动定时器（会话状态 running/idle 切换频繁，可靠）。兜底：把同一注入块也放到 `rename_tab` handler（首次设 title 即触发），用 `this.__ccDotStarted` 守卫防重复。

## 4. 注入点与代码草案

### 4.1 推荐方案：**单锚点 patch**（update_session_state 捕获 sid + 启动定时器）
仅改 1 处，定时器每 500ms 重绘并覆盖 CC 的赋值（CC 的 rename_tab 稀疏触发，500ms 内必被重断言）。

**Anchor A（match 串，需 escape 引号）：**
```
else if(e.request.type==="update_session_state")return this.onSessionStateChanged?.(e.request.sessionId,e.request.state,e.request.title),{type:"update_session_state_response"}
```
**Replace 为：**
```js
else if(e.request.type==="update_session_state"){this.__ccSid=e.request.sessionId;(function(t){if(t.__ccDotStarted||!t.panelTab)return;t.__ccDotStarted=true;var fs=require("fs"),os=require("os"),pth=require("path"),vs=require("vscode");var DIR=pth.join(os.homedir(),".claude","cc-tab-status");/*SVG_ABS_DIR*/var RES="/abs/path/to/project/resources";var seq=0;setInterval(function(){var p=t.panelTab;if(!p)return;var sid=t.__ccSid;if(!sid)return;var st=null;try{var j=JSON.parse(fs.readFileSync(pth.join(DIR,sid+".json"),"utf8"));st=j.state}catch(e){}var map={running:"cc-running.svg",idle:"cc-idle.svg",error:"cc-error.svg"};var svg;if(st==="error"){svg=(seq%2===0)?"cc-error.svg":"claude-logo.svg"}else if(st==="running"){svg=(seq%2===0)?"cc-running.svg":"cc-running-bright.svg"}else if(st&&map[st]){svg=map[st]}else{return}seq++;try{p.iconPath=vs.Uri.file(pth.join(RES,svg))}catch(e){}},500)})(this);return this.onSessionStateChanged?.(e.request.sessionId,e.request.state,e.request.title),{type:"update_session_state_response"}}
```

要点：
- 注入代码 **只依赖 `require("fs"|"os"|"path"|"vscode")` + `this` + `Date/seq`**，**完全不依赖 minified 名 `ue`/`dn`/`r`** → 版本鲁棒（VSCode 扩展宿主为 Node，`require` node 内建 + vscode 均可用）。
- `RES` 为 SVG 绝对目录（patch 时由 patch.ts 用自身 `__dirname` 拼出，bake 进字符串，替换占位 `/*SVG_ABS_DIR*/`）。
- 状态映射：`running`→呼吸（running↔running-bright），`error`→快闪（error↔默认），`idle`→静止，文件不存在/无状态→`return` 不覆盖（让 CC 原逻辑保留 pending/done）。
- 守卫 `t.__ccDotStarted` 防多次启动；`if(!t.panelTab)return` 兼容非 tab 模式。

### 4.2 可选加固（第 2 锚点，消除 ~500ms 闪烁）
**Anchor B（match 串）：**
```
this.panelTab.title=e.request.title;let r;if(e.request.hasPendingPermissions)
```
在 `;let r;` 前插入同样的 `(function(t){...})(this)` 启动块（已由 `__ccDotStarted` 去重）。这样 CC 在 rename_tab 重设图标后，本帧已启动的定时器仍会在下个 tick 重断言。**非必需**，单锚点已可用。

### 4.3 patch.ts 流程
1. `readFileSync(extension.js)` 为文本。
2. 校验 Anchor A（及可选 B）命中数 == 1（防误伤）。
3. `String.prototype.replace` 注入；把 `RES` 占位替换为 `path.join(__dirname,"..","resources")` 的绝对路径。
4. 写回 extension.js（先备份 `extension.js.bak`）。
5. 把 `cc-running.svg`/`cc-running-bright.svg`/`cc-idle.svg`/`cc-error.svg` 放入项目 `resources/`。

## 5. SVG 引用方式：**绝对路径引用本项目 resources/**（推荐）

| 方案 | 优 | 劣 |
|---|---|---|
| **A. 绝对路径 → 本项目 resources/**（推荐） | CC 自动更新只覆盖扩展目录，**SVG 不丢**（只需重 patch extension.js）；iconPath=`Uri.file(abs)` 对任意绝对路径生效（不受 webview `localResourceRoots` 限制）；SVG 单一源头、便于迭代动画 | 用户移动项目目录后需重跑 patcher bake 新路径 |
| B. 复制进 CC `resources/` | 与 CC 现有 `Uri.file(join(extensionPath,"resources",x))` 模式一致 | CC 每次自动更新 **整个扩展目录被清空**，SVG 连同 patched extension.js 一起丢；反正必须重 patch，复制无额外收益 |

**选 A**。`iconPath` 仅需合法 `Uri`，绝对路径无任何限制；且把"动画素材"留在我们可控的项目里，更新扩展时只需一行重 patch。

## 6. 风险与脆性（逐条）

1. **CC 自动更新覆盖（最高风险）**：扩展更新会整体替换目录，patched `extension.js` 被原版覆盖 → 静默失效。
   - 缓解：patcher 检测 CC 版本号目录（`anthropic.claude-code-*`），启动时自检 `extension.js` 是否含 Anchor A，缺失则自动重 patch 并提示。
2. **minified 名漂移**：`ue`/`dn`/`r`/`e`/`ts` 随版本变。
   - 缓解：注入代码 **不引用任何 minified 名**（仅用 `require` + `this`）。脆弱面收窄到 **Anchor match 串**——把 Anchor A 做成正则匹配（容忍空白/引号微调），并要求唯一命中。
3. **`update_session_state` 首次触发延迟**：新空 panel 若长期无状态变更，sid 迟迟不捕获 → 定时器不启动。
   - 缓解：4.2 的 Anchor B 兜底（rename_tab 在首次设 title 即触发）；或改为在 panel 创建点（偏移 2195593 `iconPath:{light:a,dark:a}`）旁注入启动块。
4. **多 panel 竞态**：每个 `ts` 实例各自启动 1 个 setInterval（已去重），N 个 tab = N 个 500ms 定时器。开销可接受（仅 fs.readFileSync 小文件），但极端多 tab 时可考虑全局单定时器 + 遍历 `sessionPanels`（需 manager 引用，复杂度上升，暂不取）。
5. **状态文件竞态**：外部进程写 `<sid>.json` 与 patch 读取并发时可能读到半截 JSON。
   - 缓解：注入代码用 `try{JSON.parse}catch{return}`，读失败即跳过本帧。
6. **iconPath 被光速覆盖感**：CC rename_tab 设默认图标后到下次 500ms tick 间有 ≤500ms 闪烁。
   - 缓解：可选 Anchor B；或定时器周期降到 200ms（fs 开销仍可接受）。
7. **非 tab 模式（`isFullEditor`/无 panelTab）**：注入块已 `if(!t.panelTab)return` 守卫，安全 no-op。

---

## 附：关键偏移速查（2.1.204）
| 内容 | 偏移 |
|---|---|
| `rename_tab` handler + 图标分支（**Anchor 区**） | 2158815 / 2158836–2159078 |
| `hasUnseenCompletion`（唯一） | 2158969 |
| `update_session_state` handler（**Anchor A**） | 2159080 |
| `claude-logo.svg` panel 首次创建默认图标 | 2195573 |
| terminal 图标（勿动） | 2167650 / 2207056 |
| class `ts` 字段声明 | 2154000–2155300 |
| Manager: `sessionPanels`/`sessionStates`/`activeSessionId` | 2188900 / 2193586 / 2196884 |
