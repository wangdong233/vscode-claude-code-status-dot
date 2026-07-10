# 改进方案报告 — 状态点增大 + 审美优化 + 通知功能

> 基于 4 维度调研（状态点审美 / iconPath 渲染技术约束 / 通知形式 / 通知实现架构）综合而成。
> 所有关键事实均已 Read 源文件确认，非臆测。
> 日期：2026-07-10

---

## 目录

1. [状态点增大 + 审美优化方案](#1-状态点增大--审美优化方案)
2. [通知方案](#2-通知方案)
3. [落地清单](#3-落地清单)
4. [风险与待解](#4-风险与待解)

---

## 1. 状态点增大 + 审美优化方案

### 1.0 现状确认（已 Read）

5 个 SVG 结构完全一致（以 `claude-logo-done.svg` 为例）：

- `viewBox="0 0 24 24"`，spark path `fill="#D97757"`（Claude 橙色星芒）
- mask：`<rect 24x24 white>` + `<circle cx=19.5 cy=4.5 r=6.5 black>`（右上角挖空 spark）
- 状态点：`<circle cx=19.5 cy=4.5 r=4.5 fill=状态色>`，绘制在 path 之后
- 几何验证：`cx+r = 24`（贴右边），`cy-r = 0`（贴顶边）→ **点与顶/右两边相切**，mask margin=2
- 16px 渲染下点直径 = `4.5×2/24×16 = 6px`（半径 3px）→ **偏小**

IIFE 动画（`patch.ts` L306-339）：单定时器 `TICK_MS=500`，`seq%2` 两帧切换。running 用 `running.svg(#CCA700)↔running-bright.svg(#FFD60A)`；interrupted 用 `error.svg(#F85149)↔CC默认claude-logo.svg`。

### 1.1 关键技术约束（已查证）

| 约束 | 结论 | 依据 |
|---|---|---|
| VSCode iconPath SVG 动画（SMIL `<animate>` / CSS keyframes） | **不执行**。VSCode 把 iconPath SVG 当 `background-image` 静态光栅化 | VSCode 源码 `iconLabel.ts`：`iconNode.style.backgroundImage = asCSSUrl(...)` + `backgroundSize:contain`；CSS-Tricks SMIL 指南 |
| `fill-opacity` / `opacity` 属性 | **支持**。半透明光晕会渲染 | MDN fill-opacity；background-image 静态光栅化处理 |
| 渲染容器尺寸 | **16×16px**（容器 16×22px，`contain` 居中） | VSCode 源码 `iconlabel.css`：`width:16px;height:22px` |
| `{light, dark}` 双 URI 主题自适应 | **原生支持**（当前未用） | VSCode 源码 `webviewEditorInput.ts` `getIcon()` 按 `isDark` 选 URI + `onDidColorThemeChange` 重渲染 |
| `currentColor` 主题感知 | **不可用**（background-image 外部资源不继承容器色） | VSCode issue #190679 |

**核心结论**：动画只能靠 IIFE 文件切换（setInterval 换 iconPath）。要顺滑呼吸 → 加帧数，不能靠 SMIL/CSS。增大点 + 审美优化只需改 SVG 几何与填色，不动 patch 架构。

### 1.2 推荐方案：候选 A — 实心增大 + 4 帧三角波呼吸

#### 参数

| 参数 | 现状 | **推荐值** | 说明 |
|---|---|---|---|
| 点 r | 4.5 | **6.0** | 16px 下直径 6px→8px（+33%） |
| cx | 19.5 | **18.0** | `cx = 24 - r`（保持贴右边相切） |
| cy | 4.5 | **6.0** | `cy = r`（保持贴顶边相切） |
| mask r | 6.5 | **7.5** | margin 2→1.5（16px 下 1px 间隙，仍够分隔，少挖 spark） |
| 样式 | 实心圆 + mask 挖空 | **同（不变）** | 竞品主流，最稳 |
| 16px 点直径 | 6px | **8px** | 视觉占比 11%→20%（竞品角标黄金比区间） |

#### 视觉占比分析

点面积 / 24×24 viewBox 总面积：
- 现状 r=4.5：π·4.5²/576 = **11%**
- 推荐 r=6.0：π·6²/576 = **20%**（macOS dock badge 约 20-25%、iOS 角标约 22%、Slack presence 24px 头像里约 8px = 1/3 → **r=6 正好落在竞品区间**）
- 激进 r=6.5：23%（挖掉右上 1/3 星芒，logo 略残）
- 过大 r=7.0：28%（spark 主体被吞，不可取）

#### 呼吸帧方案（running）

现状 2 帧 500ms = 1Hz 方波，跳变生硬。改为 **4 个唯一色阶 + 6 步三角波**：

| 帧 | 文件名 | hex | rgb | 状态 |
|---|---|---|---|---|
| f0 暗 | `claude-logo-running.svg`（现有） | `#CCA700` | 204,167,0 | 不改 |
| f1 | `claude-logo-running-1.svg`（**新增**） | `#DDB703` | 221,183,3 | 新增 |
| f2 | `claude-logo-running-2.svg`（**新增**） | `#EEC607` | 238,198,7 | 新增 |
| f3 亮 | `claude-logo-running-bright.svg`（现有） | `#FFD60A` | 255,214,10 | 不改 |

**6 步三角波索引**：`[f0, f1, f2, f3, f2, f1]`，`svg = frames[seq % 6]`。

- 500ms × 6 = **3 秒/周期**（吸气 1.5s + 呼气 1.5s），接近人类呼吸 3-5s/周期，自然不急躁
- 对比现状 1s 方波：更慢更柔，"稳态工作中"而非"闪烁"

#### interrupted（不改）

维持 2 帧 on/off（`error.svg #F85149` ↔ CC 默认）。告警频闪 1-2Hz 是惯例，**生硬反而是对的**，不平滑化。把优化预算全投在 running 呼吸上。

#### SVG 片段（以 done 绿为例，其余态只换 fill 色）

```xml
<defs><mask id="badge-mask"><rect width="24" height="24" fill="white"/><circle cx="18" cy="6" r="7.5" fill="black"/></mask></defs>
<path mask="url(#badge-mask)" d="M4.709 15.955..." fill="#D97757" fill-rule="nonzero"/>
<circle cx="18" cy="6" r="6" fill="#3FB950"/>
```

新增 running 中间帧（`claude-logo-running-1.svg`，仅 fill 不同）：
```xml
<circle cx="18" cy="6" r="6" fill="#DDB703"/>
```

#### 审美理由

1. **8px 直径落在竞品角标黄金比区间**（macOS/iOS/Slack 均在 20-25%），可见度提升 33%
2. **mask margin 收到 1.5** 兼顾分隔与星芒完整（1px 间隙在 16px 下仍清晰）
3. **4 帧三角波**把方波跳变变成 3 秒自然呼吸，是"稳态工作"该有的节奏
4. **实心 + 颜色** 是小尺寸下竞品共识（macOS dock badge / Slack presence / GitHub Copilot 全用实心，不用渐变/双层/动画静态帧）
5. **改动量最小**：只加 2 个 SVG + IIFE 一处改，无光晕渲染风险

### 1.3 备选方案简述

| 候选 | 核心差异 | 适用场景 | 风险 |
|---|---|---|---|
| **B 高级项**（实心核 r=5.5 + 光晕 r=8） | running 态叠加 `fill-opacity` 半透明光晕，让点"看起来 10px 实际只挖 7px"，区分活动态 | 想要 running 与 idle/done 有动静态层级差异 | 16px 栅格化后半透明环可能偏脏，**需实机验证** |
| **C 激进项**（r=6.5 + 白描边 stroke=0.6） | 最大可见度 8.7px，iOS 角标语言 | 追求最大醒目度 | mask r=8 挖掉右上 ~1/3 星芒；白描边深色背景有效、浅色几乎不可见（主题不一致） |

**若 r=6 星芒仍嫌残** → 退 r=5.5 / mask 7.0（候选 A 的保守档）。

### 1.4 竞品审美提炼

| 竞品 | 设计语言 | 可借鉴点 |
|---|---|---|
| macOS dock badge | 纯红实心、无描边、贴右上角、约图标 1/4 | 实心、贴角、红=告警 |
| Slack presence | 8px 实心绿/灰，空心环=away | 实心=活跃、颜色唯一语义 |
| GitHub Copilot status | 绿/灰/红实心小点 | 颜色语义（本项目已对齐） |

**共识**：小尺寸下竞品全用**实心 + 颜色**，不用渐变/双层/动画静态帧。

---

## 2. 通知方案

### 2.0 前置事实：两个执行上下文，能力不同

| | hook（`hooks/cc-status.js`） | IIFE（`patch.ts` buildIIFE） |
|---|---|---|
| 运行环境 | CC 触发事件时拉起的**独立 node 进程** | 注入 CC 扩展，跑在**扩展宿主进程内** |
| vscode API | ❌ 无（不能弹 toast、不能读焦点） | ✅ 已 `require("vscode")`，可调 `showWarningMessage`/`state.focused`/`getConfiguration` |
| 触发时机 | 事件即时（Stop/StopFailure） | 500ms 轮询延迟（对"完成"通知无感知差异） |
| VSCode 关闭时 | ✅ 独立进程仍可通知 | ❌ panel 不存在→IIFE 不运行 |
| 前台判定 | ❌ 无法知道 VSCode 是否前台 | ✅ `vs.window.state.focused` 精确知道 |
| 系统通知/声音 | ✅ 可 spawn osascript/afplay | ✅ 可 require child_process spawn |

**AUDIT.md F-6（L148）已诚实记录**："done/interrupted 通知 | README:41、CHANGELOG:22 | 代码无任何 VSCode 通知调用"——文档曾虚假描述有通知，代码本就没实现。本方案即补这条。

### 2.1 推荐方案：IIFE 单触发点 + 双通道

#### 为什么选 IIFE 而非 hook

1. **防打扰的命门是前台判定**——只有 IIFE 能调 `vs.window.state.focused`。hook 无法知道用户是否正盯着 CC tab，会在用户已经看到结果时还弹通知 = 必然打扰。
2. IIFE 已 `require("vscode")`，加通知是"在已有能力上加逻辑"，零新外部依赖（`child_process` 是 Node 内建）。
3. **单触发点 = 天然去重**（`prevSt` 对比），不需要跨进程协调。
4. **不破坏 hook 的零依赖/跨平台/静默契约**。
5. 95% 场景（用户开着 VSCode 但切去别的窗口）被 IIFE 完全覆盖。唯一盲区（VSCode 完全关闭）是低频场景，留给 v2 hook 补位。

#### 通知策略矩阵

| VSCode 前台？ | done | interrupted |
|---|---|---|
| **focused**（用户在看） | 抑制（图标变绿已足够；`notifyWhenFocused:true` 时弹 `showInformationMessage`） | 抑制（图标变红快闪已足够；`notifyWhenFocused:true` 时弹 `showWarningMessage`） |
| **unfocused**（用户切走了） | `showInformationMessage`（触发 macOS dock bounce）+ osascript 系统通知（声音 Glass + 通知中心） | `showWarningMessage`（dock bounce）+ osascript 系统通知（声音 Basso + 通知中心） |

**依据**：[VSCode 通知 UX 文档](https://code.visualstudio.com/api/ux-guidelines/notifications) 确认 `showInformationMessage` 在窗口未聚焦时 macOS 会 bounce dock 图标；但不进通知中心、无声。osascript `display notification ... sound name "Glass"` 补这两个缺口。

#### 触发点

IIFE 闭包新增 `var prevSt=null`，每 tick 读到 `st` 后判断：
```
if (prevSt && prevSt !== st && (st === "done" || st === "interrupted")) → notify(st, err)
```

#### 去重 / 防打扰（4 层保证）

1. **转换检测**：`prevSt && prevSt!==st` 才通知。首次读（`prevSt===null`）不通知——防陈旧文件误触。
2. **连续 Stop 不重复**：Stop→done，prevSt 变 "done"；若再 Stop（无 running 间隔），`prevSt===st`→不通知。
3. **前台抑制**：`vs.window.state.focused===true` 且 `notifyWhenFocused===false`（默认）→完全抑制。
4. **每 panel 独立**：一个 IIFE = 一个 panel = 一个 sid，`prevSt` 天然 per-session。

#### 可配置项（VSCode settings.json，IIFE 用 `vs.workspace.getConfiguration("ccStatusDot")` 读）

| 配置键 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `ccStatusDot.notify` | boolean | `true` | 总开关 |
| `ccStatusDot.notifyWhenFocused` | boolean | `false` | 前台时也弹 VSCode 消息（默认关：图标已足够） |
| `ccStatusDot.notifySound` | string | `"Glass"` | macOS 系统通知声音名（`""`=静音；可选 Ping/Hero/Basso/Glass/Funk/…） |

> 注：因不 patch CC 的 `package.json`（最小侵入），这些 key 不会出现在 Settings UI，但 `getConfiguration` 仍能读到 settings.json 里的值。用户手写进 settings.json 即可。

#### error 枚举 → 文案映射（与 STATES.md §2 对齐）

| state | error 枚举 | 通知文案 | VSCode API |
|---|---|---|---|
| `done` | — | `Claude Code: turn complete` (+ `[title]` 若有) | `showInformationMessage` |
| `interrupted` | `rate_limit` | `Claude Code: rate limit reached` | `showWarningMessage` |
| `interrupted` | `overloaded` | `Claude Code: server overloaded` | `showWarningMessage` |
| `interrupted` | `unknown` / 其他 / 缺失 | `Claude Code: interrupted` | `showWarningMessage` |

未列举的 error 值原样显示（`{rate_limit:…,overloaded:…}[err]||err||"interrupted"`），保证 CC 未来新增枚举不崩。

#### 代码草案

**修改 `buildIIFE`**（patch.ts L306-339）— 新增 `prevSt`、`notify()` 函数、转换检测：

```js
// 闭包顶部：var seq=0;  →  var seq=0,prevSt=null;
// 新增 notify 函数（在 setInterval 之前定义）：
function notify(st,err){
  var c=vs.workspace.getConfiguration("ccStatusDot");
  if(!c.get("notify",true))return;
  var focused=vs.window.state.focused;
  if(focused&&!c.get("notifyWhenFocused",false))return;
  var msg,sev;
  if(st==="done"){sev="info";msg="Claude Code: turn complete"}
  else{sev="warn";var m={rate_limit:"rate limit reached",overloaded:"server overloaded"}[err]||err||"interrupted";msg="Claude Code: "+m}
  if(t.__ccTitle)msg+=" ["+t.__ccTitle+"]";
  if(focused){
    if(sev==="info")vs.window.showInformationMessage(msg,"Dismiss");
    else vs.window.showWarningMessage(msg,"Dismiss");
  }else{
    if(sev==="info")vs.window.showInformationMessage(msg);
    else vs.window.showWarningMessage(msg);
    if(os.platform()==="darwin"){
      var snd=c.get("notifySound","Glass");
      var sndStr=snd?(" sound name \""+snd+"\""):"";
      try{require("child_process").execFile("osascript",
        ["-e","display notification \""+msg+"\" with title \"Claude Code\""+sndStr])}catch(e){}
    }
  }
}
// setInterval 内，读出 st/err 后、icon switch 前：
if(prevSt&&prevSt!==st&&(st==="done"||st==="interrupted")){try{notify(st,err)}catch(e){}}
if(st)prevSt=st;
```

**修改 `replA`**（patch.ts L391-395）— 额外 stash `__ccTitle`：

```typescript
const replA =
    'else if(e.request.type==="update_session_state")return ' +
    "this.__ccSid=e.request.sessionId,this.__ccTitle=e.request.title," +   // ← 新增 __ccTitle
    iife +
    ',this.onSessionStateChanged?.(e.request.sessionId,e.request.state,e.request.title),{type:"update_session_state_response"}';
```

> `e.request.title` 在 `update_session_state` 请求中已确认存在（DESIGN-injection.md §3.3），原代码已将其传给 `onSessionStateChanged`，这里只是同时 stash 一份。

**不改 `hooks/cc-status.js`**：hook 保持原样（零依赖、跨平台、静默写文件后 exit(0)）。通知是 reader 的职责。

### 2.2 备选：hook 侧系统通知（v2 增强，补 VSCode 关闭盲区）

若未来要覆盖"VSCode 完全关闭"场景，可在 hook 的 `main()` 写状态文件后加 osascript spawn。但需配合 `pgrep -x Code` 检测 VSCode 是否运行+前台，避免双重通知。MVP 不做。

---

## 3. 落地清单

### 3.1 SVG 文件（`resources/` 目录）

| 文件 | 操作 | 改动 |
|---|---|---|
| `claude-logo-idle.svg` | 改 | mask r 6.5→7.5、点 r 4.5→6、cx/cy 19.5/4.5→18/6 |
| `claude-logo-done.svg` | 改 | 同上 |
| `claude-logo-error.svg` | 改 | 同上 |
| `claude-logo-running.svg` | 改 | 同上（fill 保持 `#CCA700`） |
| `claude-logo-running-bright.svg` | 改 | 同上（fill 保持 `#FFD60A`） |
| `claude-logo-running-1.svg` | **新增** | fill `#DDB703`，其余参数同上 |
| `claude-logo-running-2.svg` | **新增** | fill `#EEC607`，其余参数同上 |

绝对路径前缀：`/Users/wangdong/Documents/Project/vscode-cc-提示插件/claude-code-status-dot/resources/`

### 3.2 patch.ts

| 位置 | 操作 | 改动 |
|---|---|---|
| L89-95 `OUR_SVGS` 数组 | 改 | 加 `"claude-logo-running-1.svg"`、`"claude-logo-running-2.svg"` |
| L321 闭包变量 | 改 | `var seq=0;` → `var seq=0,prevSt=null;` |
| L326 读状态 | 改 | 增加 `err=j.error\|\|""`（当前未读 err） |
| L330 running 分支 | 改 | `seq%2` 两帧 → 6 步三角波索引 `[f0,f1,f2,f3,f2,f1]`（见 §1.2） |
| L322-336 setInterval 内 | **新增** | 转换检测 + `notify()` 调用（见 §2.1 代码草案） |
| buildIIFE 函数体 | **新增** | `notify()` 函数定义（见 §2.1 代码草案） |
| L393 replA | 改 | 加 `this.__ccTitle=e.request.title,` |

绝对路径：`/Users/wangdong/Documents/Project/vscode-cc-提示插件/claude-code-status-dot/patch.ts`

### 3.3 hooks/cc-status.js

**不改。** 保持零依赖、跨平台、静默契约。通知是 reader（IIFE）的职责。

绝对路径：`/Users/wangdong/Documents/Project/vscode-cc-提示插件/claude-code-status-dot/hooks/cc-status.js`

### 3.4 文档

| 文件 | 操作 | 改动 |
|---|---|---|
| `docs/STATES.md` §1 表 | 改 | running 行 SVG 列加 `claude-logo-running-1.svg`、`claude-logo-running-2.svg`；动效描述改"4 帧三角波 3s 周期" |
| `docs/STATES.md` §4 伪代码 | 改 | `seq%2`→`seq%6` 索引表；新增 `prevSt` 转换检测 + `notify()` 调用说明 |
| `docs/STATES.md` | **新增 §4b** | reader 通知逻辑（触发条件 / 策略矩阵 / 去重 / 配置项） |
| `docs/STATES.md` §5 | 改 | 新增限制条"VSCode 完全关闭时不通知" |
| `docs/USAGE.md` | 改 | 新增通知功能说明（macOS 首次授权提示 / 配置项 / 声音可选） |
| `docs/AUDIT.md` F-6 | 改 | 标注"已实现"（补完虚假描述） |

绝对路径前缀：`/Users/wangdong/Documents/Project/vscode-cc-提示插件/claude-code-status-dot/docs/`

### 3.5 验证步骤

1. 改完后 `tsx patch.ts --status` 确认 7 个 SVG 齐（`OUR_SVGS` 校验 L556）
2. reload VSCode，目测 16px tab 图标下：点直径、星芒残缺程度、呼吸顺滑度
3. 触发 done（CC 完成一轮）→ 切走 VSCode 窗口 → 确认收到系统通知 + Glass 声
4. 触发 interrupted（模拟 rate_limit）→ 确认 warning toast + Basso 声
5. 前台时完成一轮 → 确认无通知（图标变绿已足够）
6. 若 r=6 星芒仍嫌残 → 退 r=5.5/mask 7.0

---

## 4. 风险与待解

### 4.1 状态点增大

| 风险 | 严重度 | 缓解 |
|---|---|---|
| r=6 挖掉右上星芒，logo 识别度下降 | 中 | mask margin 收到 1.5 减少挖空；实机目测后可退 r=5.5/mask 7.0 |
| 16px 下 mask 边缘可能轻微锯齿 | 低 | SVG 矢量 + Chromium 抗锯齿，实测影响极小 |
| 不同主题背景下点色对比不一致 | 中 | MVP 硬编码 hex（idle 灰在浅色背景下可能偏淡）；v2 可用 `{light,dark}` 双 URI 做主题适配（VSCode 原生支持，IIFE 改 `p.iconPath={light,dark}` 即可，无需自己监听主题） |

### 4.2 呼吸动画

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 6 步三角波 3s 周期偏慢，不够灵动 | 低 | 备选：TICK_MS 改 350 → 周期 2.1s。但 350ms 下 6 次/秒换 iconPath 需验证不闪烁。建议先上 500ms 稳态版 |
| 500ms 切帧性能（多 tab 多定时器） | 极低 | DOM 复用 + SVG 缓存命中（iconLabel.ts `setLabel` 不重建 DOM，仅更新 `backgroundImage`）；单 tab 极轻量 |
| 新增 2 个 SVG 文件未在 `OUR_SVGS` 注册 → patch 校验失败 | 中 | 同步改 `OUR_SVGS`（L89-95），`--status` 会校验 |

### 4.3 通知功能

| 风险 | 严重度 | 缓解 |
|---|---|---|
| **VSCode 完全关闭时不通知**（IIFE 不运行） | 中 | MVP 接受（低频场景）；v2 由 hook 补位（hook spawn osascript，需 `pgrep` 检测 VSCode 是否运行） |
| **系统通知点击不可跳转**到 CC session tab | 中 | osascript `display notification` 无 click callback；`terminal-notifier -open` 在 Sonoma+ 已失效。通知视为"仅提醒"，回到 VSCode 后靠 tab 绿/红点定位 |
| **系统通知图标非 Claude**（显示 "Code Helper"/"Script Editor"） | 低 | osascript 限制，无法自定义图标；写入 USAGE 文档说明 |
| **macOS 首次授权摩擦**（弹"X 想发送通知"） | 低 | 一次性，写入 USAGE 文档 |
| **非 macOS 无系统通知声音** | 中 | Linux/Windows fallback 到纯 `showWarningMessage`（有 dock bounce/taskbar flash，无声）；v2 可加 `notify-send`/powershell 分支 |
| **手动 Esc 中断无通知** | 中 | CC 不触发 Stop/StopFailure（STATES.md §5 已声明），patch 层无法解决（CC 缺 hook） |
| **Settings UI 无入口**（`contributes.configuration` 未声明） | 低 | `getConfiguration` 能读 settings.json 值；v2 可 patch CC `package.json` 加 configuration contribution |
| **多 panel 同 sid 理论双重通知** | 极低 | 一个 sid 通常对应一个 panel；若异常多 panel，各 IIFE 独立 `prevSt` 会各通知一次。v2 可在状态文件加 `notified:true` 字段做跨 panel 去重 |
| **IIFE 新增 `child_process` 依赖** | 极低 | 当前 IIFE 已 require fs/path/vscode/os，`child_process` 是 Node 内建，扩展宿主支持 |
| **声音与 CC 自身提示冲突** | 极低 | 只在 Stop/StopFailure 触发，不与 permission 蓝点重叠（STATES.md §2 故意不接 Notification 事件） |

### 4.4 待解问题

1. **明暗主题适配**：当前硬编码 hex，idle 灰 `#808080` 在浅色 tab 背景下可能偏淡。是否值得用 `{light,dark}` 双 URI？（VSCode 原生支持，IIFE 已具备 `require("vscode")` 能力，改 `p.iconPath={light,dark}` 即可。但需为每个状态生成两套 SVG，工作量翻倍。）
2. **光晕版（候选 B）是否值得做**：16px 栅格化后半透明环观感待实机验证。若 candidate A 效果好，B 可不做。
3. **interrupted 心跳 3 帧**（`[error, error-dim, CC默认]`）：比纯 on/off 稍精致，但告警本该刺眼，收益有限。暂不做。
4. **CC view container id**：若未来想让 StatusBarItem 的 `command` 点击跳转到 CC tab，需先探明 CC view container id（当前被混淆/脆弱）。

---

## 附：决策摘要

| 维度 | 推荐 | 一句话理由 |
|---|---|---|
| 状态点尺寸 | r=6, cx=18, cy=6, mask r=7.5 | 8px 直径达竞品黄金比 20%，+33% 可见度，星芒完整度可接受 |
| 呼吸动画 | 4 帧三角波 6 步 @500ms = 3s 周期 | 把方波跳变变成自然呼吸，"稳态工作"该有的节奏 |
| interrupted | 不改（2 帧 on/off） | 告警频闪本该刺眼，不平滑化 |
| 通知架构 | IIFE 单触发点 + 双通道 | 只有 IIFE 能做前台判定（防打扰命门），单触发点天然去重 |
| 通知形式 | focused 抑制 / unfocused VSCode msg + osascript 声音 | 前台温和、后台醒目 |
| hook | 不改 | 保持零依赖/跨平台/静默契约 |
