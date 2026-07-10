# CC Webview 聚合状态色块条注入设计（WEBVIEW-injection）

> 逆向目标：`anthropic.claude-code-2.1.206-darwin-x64`
> 　· `webview/index.js`（minified, 4.81 MB, 单行）
> 　· `webview/index.css`（minified, 383 KB, 单行）
> 　· `extension.js`（minified, 2.27 MB，已被 iconPath patch 改过，见 docs/DESIGN-injection.md）
> 日期：2026-07-10
> 结论先行：**注入可行；色块条用「vanilla DOM + position:fixed 贴右下角」最稳；数据源推荐 postMessage 桥（extension.js IIFE 读状态文件 → webview）；点击切 tab 走 `claude-vscode.editor.open` 命令；最大风险 = CC 更新覆盖 webview/index.js+css + acquireVsCodeApi 锚点 minified 名漂移。**
> 把握度：结构/命令 high；数据源 high；点击机制 high；布局定位 medium（需目测验证不压输入框）。

---

## 0. 与已有 iconPath patch 的关系

| 维度 | iconPath patch（已交付） | 本色块条 patch（本次设计） |
|---|---|---|
| 改的文件 | `extension.js` | `webview/index.js` + `webview/index.css`（+ 扩展 `extension.js` 已有 IIFE） |
| 运行环境 | Node 扩展宿主（`require("fs")` 可用） | webview 浏览器沙箱（**无 fs/require**，只有 `acquireVsCodeApi()`） |
| 触发重绘 | `setInterval` 500ms 改 `panelTab.iconPath` | `window.addEventListener("message")` 收桥消息改 DOM |
| 数据源 | 直读 `~/.claude/cc-tab-status/<sid>.json` | **同一份状态文件，但由 extension.js IIFE 读后 postMessage 推进 webview** |

两套 patch 改不同文件，互不覆盖；唯一交集是**扩展 extension.js 已有 IIFE**（加桥代码，见 §6.D），属同一 patch.ts 的增量，无冲突。

---

## 1. CC webview 整体结构（已逐项 grep 确认）

### 1.1 技术栈与根挂载
- **React 18 + react-dom**（`createRoot:()=>g_e`，`hydrateRoot`，`flushSync` 均在 bundle 内）。
- 根挂载点：`<div id="root">`（`document.getElementById("root")?.dataset.initialAuthStatus` 已证实）。**`id="root"` 是全文最稳定的 DOM 锚点**。
- 入口函数 `RLt()`（webview/index.js 内）：
  ```js
  function RLt(){let e=acquireVsCodeApi(),t=new Zme(e);t.update({isFullEditor:window.IS_FULL_EDITOR});let i=new Ol,n=new Ol,...;let s=new Yme(e,i,n,o,r),...;c=new lme(a,i,async(g,v)=>{await l.activateSessionFromServer(g,v)});...}
  ```
  - `acquireVsCodeApi()` **全文仅调用 1 次**（`grep -c` = 1，在 `RLt()` 内）→ **唯一可 stash 点**。
  - `Zme` = vscode API 的 webview 封装（带 `sendRequest`/`postMessage` 等）；`Yme` = connection；`lme`/`zG` = app/session 控制器。全是 minified 名，随版本漂。

### 1.2 组件树关键标识（全部 minified，不可直接锚定）
- **无 `data-testid`**（grep 全文 0 命中）。
- className 用 **CSS Modules 哈希**（如 `footer_gGYT1w`、`footerButton_gGYT1w`、`inputFooterV2_gGYT1w`、`worktreeInputStatus_djirOA`）→ **6 位后缀随构建变，不可作锚点**。
- 会话列表/输入框/消息列表组件**无稳定 className、无 id、无 testid**。
- 结论：**任何「贴输入框容器内部」的注入都需要 DOM 查询哈希 className，版本一升就断**。故本设计放弃「贴输入框内部」，改用「`position:fixed` 贴 webview 右下角」（见 §2）。

### 1.3 session 模型（webview 内部确实有，但用不上 —— 见 §3）
- 响应式信号：`sessionStates=kn(()=>this.connection.value?.sessionStates)`、`activeSessionId=kn(()=>this.connection.value?.activeSessionId)`（`kn`=computed，`lt`=signal）。
- 推送协议：扩展侧 `broadcastSessionStates()` 发 `{type:"session_states_update",sessions,activeSessionId}`；webview 侧 handler：
  ```js
  case"session_states_update":this.sessionStates.value=e.request.sessions,this.activeSessionId.value=e.request.activeSessionId;break
  ```
- **但 webview 内 `state` 枚举只有 `p4.Idle`/`p4.Typing`（输入框状态）与 `g4.Closed`/`g4.None`（连接状态）** —— 是 CC 原生的「输入态/连接态」，**不是我们的四态（idle/running/done/interrupted）**。CC 不知道 done/interrupted（那是我们 hook 从 Stop/StopFailure 推的）。
- 切换会话的 webview 内方法：`activateSessionFromServer(e,t){let i=this.sessions.value.find(l=>l.sessionId.value===e);if(i){...return this.activeSession.value=i,!0}...}` —— 存在，但**挂在 app 实例上，无全局 handle 暴露**（`window` 上无 `app`/`connection`/`cc` 等句柄，grep 确认 `window.*=` 仅 `IS_FULL_EDITOR`/`IS_SESSION_LIST_ONLY` 等布尔标志）。**沙箱 IIFE 够不到 React 信号系统**。

### 1.4 webview 视图形态开关
- `window.IS_FULL_EDITOR`（8 处引用）：是否全屏编辑器形态。
- `window.IS_SESSION_LIST_ONLY`（1 处）：会话列表侧栏的小 webview（`claudeVSCodeSessionsList` view provider）。**色块条不应渲染于此** → IIFE 加 `if(window.IS_SESSION_LIST_ONLY)return`。

> 把握度：high（全部 grep 实证）。

---

## 2. 注入点：`position:fixed` 贴 webview 右下角（推荐）

### 2.1 为什么不贴输入框容器内部
- 输入框/底部容器全是 CSS-Module 哈希 className（`inputFooterV2_gGYT1w` 等），无 id/testid → 任何 `querySelector(".footer_xxx")` 锚点随版本即断。
- 「贴输入框旁」若用 DOM 查询定位输入框，脆性 = high 且不可降（哈希是构建期随机）。

### 2.2 推荐锚点：`document.body` + `position:fixed`
- 色块条 = 一个 `<div id="cc-status-bar">`，`appendChild` 到 `document.body`，CSS `position:fixed;bottom:0;right:0;z-index:10001`（CC 全文最高 z-index=10000，取 10001 浮于其上）。
- **不进 React 树**：vanilla DOM 节点挂在 body 下，React 的 `createRoot(#root)` 不会 reconcile 它 → **React 重渲染零影响**（这是相对 React 注入的一大优势）。
- 视觉位置 = webview iframe 视口右下角，紧贴输入框右下方区域，满足「右下角，输入框旁」。
- 守卫：`if(window.IS_SESSION_LIST_ONLY)return;`（不在会话列表侧栏渲染）。

### 2.3 锚点字符串（patch.ts 用）
| 用途 | 文件 | 锚点 | 操作 |
|---|---|---|---|
| stash vscode API | webview/index.js | `let e=acquireVsCodeApi(),t=new Zme(e)`（唯一，count=1） | 见 §6.A（regex 版本鲁棒） |
| 色块条 IIFE | webview/index.js | EOF 追加 | 见 §6.B |
| 样式 | webview/index.css | EOF 追加 | 见 §6.C |

> 把握度：注入可行性 high；具体视觉定位（不压输入框/不挡发送按钮）medium —— 需在真实 webview 目测，可能要调 `bottom` 偏移（如 `bottom:48px` 让出输入框行）。

---

## 3. 数据源：postMessage 桥（推荐）vs 内部 sessionStates vs 直读文件

### 3.1 三选项评估
| 方案 | 可行？ | 把握度 | 问题 |
|---|---|---|---|
| **A. 内部 `sessionStates` 信号** | 否 | high 不可行 | (1) state 枚举是 Idle/Typing，**非我方四态**；(2) app 实例无全局 handle，沙箱 IIFE 够不到 React 信号；(3) 即便够到，强耦合 minified 信号名，极脆 |
| **B. webview 直读 `~/.claude/cc-tab-status/*.json`** | 否 | high 不可行 | webview 是浏览器沙箱，**无 `require("fs")`、无 Node**；`~/.claude/` 未注册为 `localResourceRoots`，`vscode-webview://` 也读不到（要改 extension.js 注册 FS provider，比桥还重） |
| **C. postMessage 桥（extension.js IIFE → webview）** | **是（推荐）** | high | 复用已有 iconPath IIFE 的文件读取；webview 侧只需 `addEventListener("message")`；单一真相源仍是 `~/.claude/cc-tab-status/*.json`（与 STATES.md 一致） |

### 3.2 方案 C 数据流
```
~/.claude/cc-tab-status/*.json   （STATES.md 契约，hook 写）
        │ fs.readdirSync + JSON.parse（每 500ms，复用 iconPath 定时器帧）
        ▼
extension.js IIFE（ts 实例内，t.webview.postMessage）
        │  this.webview.postMessage({type:"cc_status_bar", currentSid, sessions:[{sid,state,title,since}]})
        ▼
webview IIFE（window.addEventListener("message")）
        │  重渲染 <div id="cc-status-bar"> 的色块
        ▼
色块条（每 session 一个色块，颜色=四态）
```
- payload 字段：`currentSid`（当前 panel 的 sid，用于高亮「自己」）、`sessions`（全部，按 lastModified 降序）。
- 每个色块：`{sid, state, title, since}` —— state 即 STATES.md §1 四态。
- webview 收到即 `setState` 式重绘（直接改 DOM textContent/style，非 React）。

### 3.3 桥的实现位置
- 桥代码加进**已有 iconPath IIFE**（patch.ts 的 `buildIIFE`），即 §6.D。每个 `ts` panel 实例的定时器既刷图标又推色块条。N 个 panel = N 个 500ms 定时器，每个做 1 次 `readdirSync` + K 次 `readFileSync`（K=session 数），开销可接受（典型 K≤10）。
- 优化（可选，暂不做）：全局单定时器 + 遍历 `sessionPanels` Map，但需 manager 引用，复杂度上升。

> 把握度：high。

---

## 4. 点击切换 tab：`claude-vscode.editor.open` 命令（已验证）

### 4.1 webview 侧限制
- webview 的 `acquireVsCodeApi()` 实例**只有 3 个方法**：`postMessage` / `getState` / `setState`。**不能 `executeCommand`**。
- `acquireVsCodeApi()` **每个 webview 只能调 1 次**（再调抛异常）→ CC 已在 `RLt()` 调过。**必须 stash 复用**（§6.A），不能重新 acquire。

### 4.2 点击 → 切 tab 链路（已验证）
```
色块 onclick
  → window.__ccVsApi.postMessage({type:"cc_focus_session",sessionId:sid})
  → extension.js IIFE 的 this.webview.onDidReceiveMessage 监听器（新增第 2 个监听器，不打扰 CC 原监听器）
  → vs.commands.executeCommand("claude-vscode.editor.open", sid)
  → u.createPanel(sid, undefined, undefined)
  → if(sid){ let a=this.sessionPanels.get(sid); if(a){ a.reveal(); return } }   ← 已存在则 reveal（切到该 tab）
```

### 4.3 关键证据（grep 实证）
- 命令注册：`registerCommand("claude-vscode.editor.open",async(g,b,_)=>{...u.createPanel(g,b,_)...})` —— **首参 g = sessionId**。
- 复用路径：`createPanel(e,t,r){if(e){let a=this.sessionPanels.get(e);if(a){if(a.reveal(),t)...;return{startedInNewColumn:!1}}}}` —— **已开的 session 调 reveal()（切 tab，不新建）**。
- URI handler 反证：`case"/open":{let _=b.get("session")??void 0...;Se.commands.executeCommand("claude-vscode.primaryEditor.open",_,w)}` —— `session` 参数即作为命令首参 → 坐实首参 = sessionId。
- 备选命令：`claude-vscode.primaryEditor.open`（在当前列打开）、`claude-vscode.editor.openLast`（无参，开上一个）。**主用 `claude-vscode.editor.open`**（带 sid 最精确）。

### 4.4 监听器共存
- `webview.onDidReceiveMessage` 基于 VSCode `EventEmitter`，**可挂多个监听器**。CC 原监听器（`s?.fromClient(a)`）照常；IIFE 加的监听器只处理 `type==="cc_focus_session"`，其它 type 忽略。零干扰。

> 把握度：high（命令、复用、首参全部 grep 实证）。唯一 medium 点：`claude-vscode.editor.open` 对**已存在但位于其它窗口/列**的 panel，`reveal()` 是否能跨窗口聚焦 —— VSCode 行为是 reveal 到所在列；极端跨窗口 case 可能需额外 `workbench.action.focus...`，但同窗口内切 tab 无问题。

---

## 5. CSS 注入：index.css EOF 追加

### 5.1 文件形态
- `webview/index.css`：**单行**（`wc -l` = 1），383 KB。首字符 `html{display:flex;...}`，末尾 `...worktreeInputError_djirOA{...}`。
- 追加点：**文件末尾**直接拼我们的规则（无需找锚点，EOF 即安全）。用 `/*cc-status-bar-css*/` 注释做幂等标记。

### 5.2 样式草案
- z-index：CC 全文最高 `z-index:10000`（grep），色块条取 **10001** 浮于最上。
- 横向 flex、gap、圆角、悬停高亮、点击态、active 高亮（当前 session）。
- 配色严格对齐 STATES.md §1：idle `#808080`、running `#CCA700`（可加呼吸 animation）、done `#3FB950`、interrupted `#F85149`。
- `bottom` 偏移：默认 `0`；若目测压住输入框发送行，调 `bottom:44px`（输入框大约高度）—— 标注为待目测定参。

> 把握度：high（EOF 追加无锚点风险）；布局定参 medium。

---

## 6. 注入代码草案（可落地 string.replace）

### 6.A webview/index.js —— stash vscode API（版本鲁棒 regex）

**问题**：字面锚点 `let e=acquireVsCodeApi(),t=new Zme(e)` 含 minified 名 `e`/`t`/`Zme`，版本一升即漂。

**方案**：patch.ts 用 regex 捕获 minified 名，重排声明：
```js
// patch.ts:
const ACQUIRE_RE = /let (\w+)=acquireVsCodeApi\(\),(\w+)=new (\w+)\(\1\)/;
// 校验：src.match(ACQUIRE_RE) 命中数必须 === 1
const m = src.match(ACQUIRE_RE); // m[1]=e, m[2]=t, m[3]=Zme
const repl = `let ${m[1]}=acquireVsCodeApi();window.__ccVsApi=${m[1]};let ${m[2]}=new ${m[3]}(${m[1]})`;
src = src.replace(ACQUIRE_RE, repl);
```
- 效果：`let e=acquireVsCodeApi();window.__ccVsApi=e;let t=new Zme(e)` —— 多一个 `;window.__ccVsApi=e;`，并把第二个 `let` 独立出来（原 `,t=` 改 `;let t=`）。
- 只用到 `acquireVsCodeApi()` 字面量（稳定 API 名），minified 名由捕获组代入 → **版本鲁棒**。
- 幂等标记：`window.__ccVsApi=` 在文件内存在即视为已 patch。

### 6.B webview/index.js —— 色块条 IIFE（EOF 追加）

```js
/*cc-status-bar-injected*/
(function(){
  if(window.__ccBarStarted)return; window.__ccBarStarted=true;
  if(window.IS_SESSION_LIST_ONLY)return;            // 不在会话列表侧栏渲染
  var API=window.__ccVsApi;                          // §6.A stash 的 vscode API
  if(!API){return;}                                 // API 未就绪则放弃（异常情况）
  var COLORS={idle:"#808080",running:"#CCA700",done:"#3FB950",interrupted:"#F85149"};
  var bar=document.createElement("div");
  bar.id="cc-status-bar";
  bar.setAttribute("data-cc","1");
  // 样式见 §6.C（这里只兜底 inline，主样式靠 CSS 注入）
  bar.style.cssText="position:fixed;bottom:0;right:0;display:flex;gap:4px;padding:4px 6px;z-index:10001;";
  var hideT=null;
  function mount(){
    if(!document.body){setTimeout(mount,50);return;}
    document.body.appendChild(bar);
    // 2 秒内未收到任何状态 → 隐藏（如 sidebar 无桥推送的场合，避免空条）
    hideT=setTimeout(function(){bar.style.display="none";},2000);
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mount);
  else mount();
  function render(payload){
    if(hideT){clearTimeout(hideT);hideT=null;}
    bar.style.display="flex";
    bar.innerHTML="";
    var sessions=payload.sessions||[];
    var cur=payload.currentSid;
    sessions.sort(function(a,b){return (b.since||0)-(a.since||0);});
    for(var i=0;i<sessions.length;i++){
      var s=sessions[i];
      var dot=document.createElement("div");
      dot.className="cc-status-dot";
      dot.style.background=COLORS[s.state]||COLORS.idle;
      if(s.sid===cur)dot.classList.add("cc-status-dot-active");
      dot.title=(s.title||s.sid)+" ["+(s.state||"?")+"]";
      dot.dataset.sid=s.sid;
      dot.addEventListener("click",function(ev){
        var sid=ev.currentTarget.dataset.sid;
        try{API.postMessage({type:"cc_focus_session",sessionId:sid});}catch(e){}
      });
      bar.appendChild(dot);
    }
  }
  window.addEventListener("message",function(ev){
    var d=ev.data;
    if(d&&d.type==="cc_status_bar"){try{render(d);}catch(e){}}
  });
})();
```
- 要点：
  - **不进 React 树**，纯 vanilla DOM；React 重渲染不影响。
  - `window.__ccVsApi` 来自 §6.A stash；不重复 acquire。
  - 点击只 `postMessage`，不直接调命令（webview 无此能力）。
  - 2 秒空数据自动隐藏（兼容 sidebar 等无桥 webview）。
  - 排序：`since` 倒序（最近活跃靠左）。
  - active 色块加 `cc-status-dot-active` 类（CSS 加边框高亮）。

### 6.C webview/index.css —— 样式（EOF 追加）

```css
/*cc-status-bar-css*/
#cc-status-bar{position:fixed;bottom:0;right:0;display:flex;flex-direction:row;gap:4px;
  padding:4px 6px;z-index:10001;background:transparent;pointer-events:none;}
#cc-status-bar .cc-status-dot{width:10px;height:10px;border-radius:3px;cursor:pointer;
  pointer-events:auto;opacity:.85;transition:transform .12s,opacity .12s;
  border:1px solid rgba(0,0,0,.25);}
#cc-status-bar .cc-status-dot:hover{opacity:1;transform:scale(1.25);}
#cc-status-bar .cc-status-dot:active{transform:scale(.9);}
#cc-status-bar .cc-status-dot-active{outline:2px solid #fff;outline-offset:1px;opacity:1;}
@keyframes cc-breath{0%{filter:brightness(1);}50%{filter:brightness(1.5);}100%{filter:brightness(1);}}
#cc-status-bar .cc-status-dot[data-state="running"]{animation:cc-breath 1.5s ease-in-out infinite;}
```
- 注：`data-state` 需在 §6.B render 里补 `dot.dataset.state=s.state;`（草案漏写，落地时补）。
- `bottom:0` 若压输入框，改 `bottom:44px`（待目测）。

### 6.D extension.js —— 扩展已有 IIFE 加桥（patch.ts 的 `buildIIFE` 增量）

在 docs/DESIGN-injection.md §4.1 的 IIFE 内，**定时器回调里追加**（复用同一帧，不新增定时器）：

```js
// 在现有 setInterval(function(){ ... 读 this.__ccSid 的 <sid>.json 之后 ... }) 内追加：
// —— 聚合所有 session 状态，推给本 panel 的 webview ——
try{
  var files=fs.readdirSync(DIR);  // ~/.claude/cc-tab-status/
  var arr=[];
  for(var fi=0;fi<files.length;fi++){
    if(!files[fi].endsWith(".json"))continue;
    var fsid=files[fi].slice(0,-5);
    try{
      var jj=JSON.parse(fs.readFileSync(pth.join(DIR,files[fi]),"utf8"));
      arr.push({sid:fsid,state:jj.state,title:jj.title||"",since:jj.since||0});
    }catch(e){}
  }
  if(t.webview&&t.webview.postMessage){
    t.webview.postMessage({type:"cc_status_bar",currentSid:t.__ccSid,sessions:arr});
  }
}catch(e){}
// —— 注册一次点击监听器（onDidReceiveMessage 可多挂，不打扰 CC 原监听器）——
if(!t.__ccFocusWired&&t.webview&&t.webview.onDidReceiveMessage){
  t.__ccFocusWired=true;
  t.webview.onDidReceiveMessage(function(m){
    if(m&&m.type==="cc_focus_session"&&m.sessionId){
      try{vs.commands.executeCommand("claude-vscode.editor.open",m.sessionId);}catch(e){}
    }
  });
}
```
- 锚点不变：仍是 docs/DESIGN-injection.md 的 Anchor A（`update_session_state` handler）。`buildIIFE` 字符串里加这几段即可。
- `t.webview` 已证实存在于 `ts` 实例（构造器 `this.webview=i`）。
- 把握度：high。

---

## 7. 风险与脆性（逐条）

1. **CC 自动更新覆盖 webview/index.js+css（最高风险）**：扩展更新整体替换目录 → 色块条 + API stash 全丢，静默失效。
   - 缓解：patcher 启动自检 `webview/index.js` 是否含 `cc-status-bar-injected` 标记、`index.css` 是否含 `cc-status-bar-css` 标记；缺失则自动重 patch（与 extension.js 自检同机制）。
2. **acquireVsCodeApi 锚点 minified 名漂移**：`Zme`/`e`/`t` 随版本变。
   - 缓解：§6.A 用 regex `/let (\w+)=acquireVsCodeApi\(\),(\w+)=new (\w+)\(\1\)/` 捕获 minified 名，**只依赖 `acquireVsCodeApi()` 字面量**（稳定 API）。要求唯一命中。
3. **`acquireVsCodeApi()` 单次调用约束**：若 CC 未来改为多入口 acquire，stash 点漂。
   - 缓解：patcher 校验 `acquireVsCodeApi()` 全文 count === 1；若 >1，降级为「在每处 acquire 后都 stash 到同名 window 变量」（regex global 替换）。
4. **布局压住输入框/发送按钮（medium）**：`position:fixed;bottom:0` 可能盖住 CC 输入区底栏。
   - 缓解：目测定参 `bottom`（如 `44px`）；或改贴右下角但 `right:8px;bottom:52px` 让出输入框。需真实 webview 验证。
5. **sidebar webview 无桥推送**：`claudeVSCodeSidebar`（非 `ts` panel）不走 `ts` 的 IIFE → 其 webview 收不到 `cc_status_bar` → 色块条空。
   - 缓解：§6.B 的 2 秒空数据自动隐藏；如需 sidebar 也显示，另在 manager 的 sidebar webview 引用处加同样的 postMessage 推送（二期，需定位 `resolveWebviewView` 路径，medium 把握）。
6. **多 panel 重复 readdir**：N 个 tab = N 个 500ms `readdirSync`+K 次 `readFileSync`。
   - 缓解：典型 N≤5、K≤10，开销可忽略；极端可改全局单定时器（需 manager 引用，暂不做）。
7. **`claude-vscode.editor.open` 跨窗口 reveal**：目标 session panel 在另一窗口时，`reveal()` 行为不确定（可能只激活原列）。
   - 缓解：同窗口内切 tab 无问题（主场景）；跨窗口可补 `workbench.action.focus` 系列，二期。
8. **与 iconPath patch 共存**：webview patch 改 `index.js`/`index.css`，iconPath patch 改 `extension.js` —— **不同文件，零覆盖**。唯一交集是 §6.D 给 `extension.js` 已有 IIFE 加桥代码（同 patch.ts 的 `buildIIFE` 增量），与 iconPath 逻辑同函数体内顺序执行，互不干扰（图标赋值在前，桥推送在后，共用 `fs` 读结果）。
9. **React 重渲染影响**：色块条在 body 下、React 树外，**不受 reconcile** → 无影响（优势项）。
10. **消息竞态**：扩展推送与 webview 渲染异步，旧消息可能覆盖新。
    - 缓解：payload 带 `since` 或递增 seq，webview 丢弃 stale（二期；当前 500ms 帧率下肉眼无感）。

---

## 附：关键 grep 偏移/证据速查（2.1.206）

| 内容 | 证据 | 把握度 |
|---|---|---|
| `acquireVsCodeApi()` 唯一调用点 | `function RLt(){let e=acquireVsCodeApi(),t=new Zme(e);...}` count=1 | high |
| React 根 `id="root"` | `document.getElementById("root")?.dataset.initialAuthStatus` | high |
| `session_states_update` 推送 | `case"session_states_update":this.sessionStates.value=e.request.sessions,this.activeSessionId.value=e.request.activeSessionId` | high |
| 内部 state 枚举非四态 | 仅 `p4.Idle`/`p4.Typing`/`g4.Closed`/`g4.None` | high |
| `ts` 实例持有 `this.webview` | 构造器 `this.context=e;...;this.webview=i;...` | high |
| `this.webview.postMessage` 可用 | `this.webview.postMessage({type:"from-extension",message:e})` | high |
| 切 tab 命令 `claude-vscode.editor.open` | `registerCommand("claude-vscode.editor.open",async(g,b,_)=>{...u.createPanel(g,b,_)...})` | high |
| createPanel 复用已存在 panel | `createPanel(e,t,r){if(e){let a=this.sessionPanels.get(e);if(a){if(a.reveal(),t)...;return{startedInNewColumn:!1}}}}` | high |
| 首参 = sessionId | URI handler `/open?session=_` → `executeCommand("claude-vscode.primaryEditor.open",_,w)` | high |
| CSS z-index 上限 10000 | grep `z-index:` 排序 tail = 10000 | high |
| `IS_SESSION_LIST_ONLY` 守卫可用 | `window.IS_SESSION_LIST_ONLY`（1 处） | high |
| 无 `data-testid` | grep 全文 0 命中 | high |
| className 全 CSS-Module 哈希 | `footer_gGYT1Q`/`inputFooterV2_gGYT1Q`/`worktreeInputStatus_djirOA` 等 | high |
