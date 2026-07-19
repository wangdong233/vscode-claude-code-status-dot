# Changelog

本项目的显著变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [0.1.17] - 2026-07-19

**底部 SBI 4 灯：单 SBI 紧凑拼接（0 像素间距），数字等宽不位移由 VSCode 自带 `tabular-nums` CSS 根治**。根因：v0.1.16 的 4 个独立 SBI（priority `-9996..-9999`）在状态栏上看起来"间隔松散"——用户反馈"4 圆点之间间隔不紧凑"。**调研 VSCode 源码（`microsoft/vscode` 仓库 `src/vs/workbench/browser/parts/statusbar/media/statusbarpart.css`）发现：每个 SBI label 的 CSS 写死了 `margin-right:3px;margin-left:3px;padding:0 5px;`，相邻 SBI 之间约 6-16px 间距，**公开 StatusBarItem API 无 `margin`/`padding`/`spacing` 字段**；VSCode 内部 `IStatusbarEntryLocation.compact` 标志存在但只对核心 entry 开放（如 Ln/Col 与 Encoding 的紧贴对），`createStatusBarItem(alignment, priority)` 签名不接受 `compact` 参数，`require("vscode")` 也 resolve 不到内部 statusbar 模块；priority 只决定排序，不影响间距。**4 SBI 路径下 6-16px 间距是 VSCode 框架硬限制**。**要紧凑必须收回到单 SBI**。

### Added / Changed

- **4 SBI → 单 SBI 紧凑拼接**：`globalThis.__ccsdSbis`（4 元素数组）→ `globalThis.__ccsdSbi`（单个 StatusBarItem）。单个 `createStatusBarItem(StatusBarAlignment.Left, SBI_PRIORITY=-9996)`，text 是 4 个 `<球><数字>` 拼接（`txt+=(n===0?DIM_EM:CFG[k].em)+(n>=4?"N":""+n)` 4 次循环）→ `🟢3🟡1⚪0⚪0`（无分隔符，**0 像素间距**）。整行宽度从 ~120px 压到 ~70px。`onDidDispose` 最后一个 panel 退出时直接 `__ccsdSbi.dispose()`（不再遍历 4 个）。
- **位置稳定性根因彻底澄清**：v0.1.14 时"单 SBI 位移"问题被错误归因到数字宽度。**实证 VSCode `statusbarpart.css`**：`.monaco-workbench .part.statusbar > .items-container > .statusbar-item` 选择器带 `font-variant-numeric: tabular-nums;`——所有 ASCII 数字 0-9 在**任何字体**下都是等宽 OpenType tabular figures。`cap()` 把 0-3 与 4+ 都映射到 1 字符宽（"0"-"3" 或 "N"），所以数字部分的宽度永远恒定——**显式需求"数字不位移"由 VSCode CSS 独立保证，与 emoji 渲染无关**。v0.1.17 不带 v0.1.14 的空格分隔符（v0.1.14 位移实际来自空格分隔符在不同字体下的宽度差），4 灯直接紧贴，无任何可变宽度空白。
- **`SBI_LIGHTS_CFG` 表 `pri` 字段移除**：v0.1.15/v0.1.16 的 `{key,em,pri}` 改回 `{key,em}`——单 SBI 不需要每灯独立 priority（4 灯共享一个 SBI 的 priority）。新增 sibling 常量 `SBI_PRIORITY = -9996`（取 v0.1.16 leftmost-done 的值，**保持整行在状态栏的屏幕位置不变**——用户对"位置固定"的隐式期望涵盖整行级别）。
- **简化 v0.1.15 round-4 的过保护**：去掉 4-SBI 创建路径下的 length-guarded 重建（`if(__ccsdSbis.length!==CFG.length)`）+ commit-atomic 提交（`if(arr.length===CFG.length)`）+ partial-failure cleanup（`else{for(f<arr.length)...dispose()}`）三层保护——单 SBI 创建只有一次 `createStatusBarItem` 调用，不存在部分失败的中间状态，三层保护变得冗余。
- **click handler 读 `__ccsdSbi.tooltip`**（不再是 `__ccsdSbis[0].tooltip`，因为只有 1 个 SBI）。
- **IIFE 版本戳 `v0.1.16` → `v0.1.17`**：已 patch 的 v0.1.16 装在下次 install 时被检测为 STALE（version 不符 + hash 不符双重保护）→ 自动从 `extension.js.bak` 还原并重注入新单 SBI IIFE。

### 保留（Preserved，v0.1.14/v0.1.15/v0.1.16 设计改进完整沿用到 v0.1.17）

- **🔵 pending 第 4 灯 + Notification hook case**：聚合层独立计数 pending，与 state 正交（v0.1.13 引入，v0.1.14 沿用）。count>0 → 🔵 蓝球 + 数字。
- **done/running/interrupted 三路陈旧会话 GC**：done >5min→idle（§4）；running mtime >30min→idle（§7.2，变量名 `SBI_RUNNING_STALE_MS` 保留）；interrupted mtime >24h→idle（`INTERRUPTED_RETENTION_MS`）。per-tab 渲染**不应用**后两条，聚合层应用。
- **聚合单例 + panel 计数 lifecycle**：`__ccsdSbi`（单个 StatusBarItem，v0.1.17）+ `__ccsdSbiTimer` 窗口级单例；`__ccsdPanelCount` 入口 +1 / `onDidDispose` -1，归零时清理（v0.1.17：dispose 单 SBI）。
- **三层独立 try/catch 隔离**：(1) 单 SBI 创建；(2) 单例 timer 注册；(3) aggregation body。
- **lastKey memo short-circuit**：per-tick 更新在 UNcapped 计数 tuple 不变时直接 short-circuit，steady-state IPC 写入从 ~40/s 降到 0。
- **0-3+N 封顶规则**：`cap(n){return n>=4?4:n}` 把 4+ 截到 4，`text` 规则 `(n>=4?"N":""+n)` 把 4 渲染为 `N`。
- **共享 tooltip `Claude Code: X done, Y running, Z pending, W interrupted`**（未截顶的真实计数）+ 共享 click command `ccStatusDot.sbiClick`（运行时注册，无 package.json contribution）。

### 改善（v0.1.17 相对 v0.1.16 的额外收益）

- **priority 碰撞窗口从 4 单位缩到 1 单位**：v0.1.16 占用 `-9996..-9999` 4 单位相邻 priority 区间，v0.1.17 只占用 `-9996` 一个 priority 点——其它扩展声明同 priority 把我们的 SBI 挤到角落的概率降低到 1/4。
- **消除了 v0.1.16 的"行被外部分隔"失败模式**：v0.1.16 的 4 个独立 SBI 可能被其它扩展的 SBI 插入 done 与 interrupted 之间劈开成两半；v0.1.17 整行是一个 SBI，外部插入只能插到整行两侧，不会拆开 4 灯。
- **代码量减少**：单 SBI 创建路径去掉了 v0.1.15 round-4 的 length-guarded 重建 + commit-atomic + partial-failure cleanup 三层 ~50 行 IIFE 字节；onDidDispose teardown 从 4-元素遍历简化为单次 dispose。
- **真正的紧凑视觉**：4 圆点从"间隔松散"变成"紧贴成串"——v0.1.16 的视觉痛点根治。

### 已知限制（沿用 v0.1.16 同款）

- **依赖 emoji 字体栈**：v0.1.15 的 ThemeColor 块**完全跟随 VSCode 主题色**，跨平台稳定；v0.1.16 因用户反馈"色块不如球好看"切回 emoji 球，v0.1.17 在此基础上合并到单 SBI 但保留 emoji 球——Win7/无 emoji 字体的 Linux/headless 环境可能黑白或豆腐块。macOS（Apple Color Emoji）/ Windows 10+（Segoe UI Emoji）/ 主流 Linux（Noto Color Emoji）正常显示彩色。
- **`⚪`（U+26AA）跨 Unicode 块的潜在宽度差**：`🟢🟡` 属 Geometric Shapes Extended，`🔵🔴` 属 Miscellaneous Symbols And Pictographs，`⚪` 属 Miscellaneous Symbols——5 个球分属 3 个不同 Unicode 块。**实测现代 emoji 字体把所有 emoji 渲染成 1em 正方形 glyph，跨块宽度一致**（这是 v0.1.17 选择保留 `⚪` 的依据）。**理论风险**：某些冷门字体可能让 `⚪` 与彩球宽度略差，导致整行因计数变化（某灯 0↔非0）而左右位移 1-2 像素——但**显式需求"数字不位移"由 VSCode CSS `tabular-nums` 独立保证**，与此风险正交。**根治方案预留**：若用户反馈观察到实际位移，v0.1.18 把 `SBI_DIM_EM` 改为 `🟤`（U+1F7E4，与 `🟢🟡` 同属 Geometric Shapes Extended，**保证**等宽）即可——一处常量改 + 同步 STATES.md §7.1。
- **形状是 emoji 字形正圆**（沿用 v0.1.16）：相比 v0.1.15 的 SBI 圆角矩形块，球是 emoji 字体提供的正圆 glyph（在支持的字体下）。

### 引用（VSCode 源码实证）

- VSCode `statusbarpart.css`（master）：[github.com/microsoft/vscode/blob/master/src/vs/workbench/browser/parts/statusbar/media/statusbarpart.css](https://github.com/microsoft/vscode/blob/master/src/vs/workbench/browser/parts/statusbar/media/statusbarpart.css) — `.statusbar-item` 的 `margin:0 3px;padding:0 5px` 与 `.part.statusbar > .items-container > .statusbar-item` 的 `font-variant-numeric: tabular-nums`
- VSCode 内部 statusbar 接口：[github.com/microsoft/vscode/blob/master/src/vs/workbench/services/statusbar/browser/statusbar.ts](https://github.com/microsoft/vscode/blob/master/src/vs/workbench/services/statusbar/browser/statusbar.ts) — `IStatusbarEntryLocation.compact` 字段（未公开）
- VSCode Issue #73700（tabular-nums for digits）：[github.com/microsoft/vscode/issues/73700](https://github.com/microsoft/vscode/issues/73700)
- MDN `font-variant-numeric`：[developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/font-variant-numeric](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/font-variant-numeric)

## [0.1.16] - 2026-07-19

**底部 SBI 4 灯：恢复圆点 emoji 样式，保留 v0.1.15 的 4 SBI 固定位置结构**。根因：v0.1.15 把 4 个独立 SBI 渲染成"数字内置彩色块"（白字数字 + `statusBarItem.*Background` 主题色块），用户反馈"色块效果不如圆点好看"，要求恢复 v0.1.14 的圆点 emoji 样式。v0.1.14 的单 SBI 拼接 `🟢N 🟡N 🔵N 🔴N` 有位移问题（任何数字宽度变化都会让整行左右挪），v0.1.16 不能简单回退——而是**合流**：视觉切回球（v0.1.14 验证好看）+ 架构保留 4 SBI 独立 slot（v0.1.15 验证位置稳定）。每灯 text 改为 `<球><数字>`（如 `🟢3`、`⚪0`），球自带色——🟢🟡🔵🔴 是预填充彩色的 Unicode 字符，**移除了 v0.1.15 的 `backgroundColor` 色块 + `color` 白字赋值**。

### 变更（Changed）

- **视觉原语：彩色块 → emoji 球**：v0.1.15 每灯 text 是数字本身（`0`/`1`/`2`/`3`/`N`）+ 主题色块背景 + 白字前景；v0.1.16 每灯 text 是 `<球><数字>`——非0 用该灯的彩球（CFG[k].em，🟢/🟡/🔵/🔴 之一）+ 数字，0 用共享灰球 ⚪（DIM_EM）+ "0"。球 emoji 自带颜色（绿/黄/蓝/红/灰），无需主题色块、无需白字。
- **位置固定（v0.1.16 核心优势，沿用 v0.1.15 4 SBI 架构）**：每 slot 长度恒为 `<球><1数字>`（数字都是 1 字符：0-3 或 N），无论计数怎么变化，4 个 slot 的位置永远不动。v0.1.14 的单 SBI `🟢N 🟡N 🔵N 🔴N` 拼接会让整行因数字宽度变化而左右位移（如某灯 9→N，整行短 1 字符，后续灯全往左挪）；4 SBI 把每灯放进独立 slot，slot 之间是状态栏标准间隔，是"4 个独立徽章"观感而非黏在一起的色带。
- **`SBI_LIGHTS_CFG` 表 `bg` → `em`**：`{key,bg,pri}` 改为 `{key,em,pri}`，每灯的 `bg`（ThemeColor id 如 `statusBarItem.remoteBackground`）被 `em`（emoji codepoint 如 `\u{1F7E2}` 🟢）取代。新增 `SBI_DIM_EM` 常量（共享"灭"球 ⚪ `\u{26AA}`）。两个表都通过 `JSON.stringify` 烘焙进 IIFE 的 `var CFG=[...]` + `var DIM_EM=...`，emoji codepoint 以 `\uXXXX` 代理对形式出现在 IIFE 源码（ASCII-only）。
- **创建循环简化**：每个 `createStatusBarItem` 不再设 `.color` / `.backgroundColor` / `new vs.ThemeColor(...)`，只设 `.text`（初始 `DIM_EM+"0"` = `"⚪0"`，固定 slot 宽度避免 500ms 不可见窗口）+ `.tooltip` + `.command` + `.show()`。删 `litBgs` 数组（4 个 ThemeColor 缓存）+ `dimClr`（deactivatedForeground ThemeColor）。
- **per-tick 更新简化**：每个 SBI 的 mutate 不再触碰 `.color` / `.backgroundColor`，只 mutate `.text`（`(n===0?DIM_EM:CFG[k].em)+(n>=4?"N":""+n)` → `🟢3` / `⚪0` / `🟡N`）+ `.tooltip` + `.show()`。保留 v0.1.15 round-4 的 per-iteration try/catch + lastKey short-circuit memo（位置稳定性 + 性能优化不变）。删 `__ccsdSbiLitBgs` / `__ccsdSbiDimClr` 全局缓存（无 ThemeColor 要缓存）。
- **`onDidDispose` 简化**：最后 panel 退出时仍 dispose 全部 4 SBI + 清 timer，但不再 null-reset `__ccsdSbiLitBgs` / `__ccsdSbiDimClr`（这两个全局已不存在）。保留 `__ccsdSbis=null` + `__ccsdSbiLastKey=null` 的清理。
- **IIFE 版本戳 `v0.1.15` → `v0.1.16`**：已 patch 的 v0.1.15 装在下次 install 时被检测为 STALE（version 不符 + hash 不符双重保护）→ 自动从 `extension.js.bak` 还原并重注入新 emoji-ball IIFE。

### 保留（Preserved，v0.1.14/v0.1.15 设计改进完整沿用到 v0.1.16）

- **🔵 pending 第 4 灯**（writer 的 `Notification` hook case + reader 独立计数 + 与 state 正交）。
- **done/running/interrupted 三路陈旧会话 GC**：done >5min→idle（§4）；running mtime >30min→idle（§7.2，变量名 `SBI_RUNNING_STALE_MS` 保留）；interrupted mtime >24h→idle（`INTERRUPTED_RETENTION_MS`）。per-tab 渲染**不应用**后两条，聚合层应用。
- **pending 与 idle GC 联动**：`j.pending===true && st!=="idle"`——防止被强杀的权限弹窗会话在 🟡 不计的同时 🔵 仍假粘。
- **聚合单例 + panel 计数 lifecycle**：`__ccsdSbis`（4 元素数组） + `__ccsdSbiTimer` 窗口级单例；`__ccsdPanelCount` 入口 +1 / `onDidDispose` -1，归零时清理（v0.1.16：遍历 4 slot dispose）。
- **三层独立 try/catch 隔离**：(1) 4-SBI 创建（循环）；(2) 单例 timer 注册；(3) aggregation body。
- **per-tab 4 态色点、`__ccsdPending` yield、notify、`__ccsdTitle` 刷新**：完全不变。
- **cap() 截顶规则不变**：`cap(n){return n>=4?4:n}`，0-3 passthrough、4+ 截到 4 触发 "N" 变体。
- **tooltip 文案不变**：`Claude Code: X done, Y running, Z pending, W interrupted`（未截顶的真实计数）。
- **click command 不变**：`ccStatusDot.sbiClick` runtime 注册，handler 读 `__ccsdSbis[0].tooltip` 弹 InformationMessage。

### 改进（Improved）

- **渲染路径更简单**：v0.1.15 每 tick 要分配/缓存 4 个 ThemeColor 实例 + 切换 lit/dim 翻转（白字+色块 vs 灰字+透明）；v0.1.16 直接读 CFG[k].em / DIM_EM（字符串字面量），无 ThemeColor、无缓存、无翻转。代码量减少，可读性提升。
- **视觉回到用户喜欢的球**：v0.1.14 的 emoji 球反馈正面（用户要的样式），v0.1.16 在保留位置稳定性的同时恢复此样式。

### 已知限制（回归 v0.1.14 同款）

- **重新依赖 emoji 字体栈**：v0.1.15 改用 ThemeColor 块**完全跟随 VSCode 主题色**，跨平台稳定；v0.1.16 切回 emoji 球，重新引入 v0.1.14 同款的 emoji 字体依赖——Win7/无 emoji 字体的 Linux/headless 环境可能黑白或豆腐块。macOS（Apple Color Emoji）/ Windows 10+（Segoe UI Emoji）/ 主流 Linux（Noto Color Emoji）正常显示彩色。这是用户审美的有意取舍：球好看 > 跨平台一致。
- **形状是 emoji 字形正圆**：相比 v0.1.15 的 SBI 圆角矩形块，v0.1.16 的球是 emoji 字体提供的正圆 glyph（在支持的字体下）。不再是 SBI 容器的 CSS 圆角——视觉更"球"。

## [0.1.15] - 2026-07-18

**底部 SBI 4 灯：把数字内置到彩色块里**。根因：v0.1.14 用单个 SBI 渲染 `🟢N 🟡N 🔵N 🔴N`（emoji 球 + 数字作为分开的 token 挤在一个 `StatusBarItem.text` 里），用户反馈"球+数字分开"不满意，要"数字直接内置在彩色块里"。VSCode `StatusBarItem.backgroundColor` 字段类型是 `ThemeColor | undefined`（**不接 hex 字符串**——已核对 `mainThreadStatusBar.ts` `$setEntry` 签名），所以"4 块用任意 hex"不可能；但前景 `color` 接 `string | ThemeColor`，故**白字数字 + ThemeColor 彩色背景**可行。v0.1.15 **拆成 4 个独立 SBI**（每灯一个 `createStatusBarItem`），每块 text 就是数字本身，count>0 时块亮（`backgroundColor=ThemeColor` + `color="#ffffff"` 白字），count=0 时块暗（透明底 + `statusBarItem.deactivatedForeground` 灰字 `"0"`，块仍可见）。

### 变更（Changed）

- **单 SBI → 4 SBI**：`globalThis.__ccsdSbi`（单个 StatusBarItem）→ `globalThis.__ccsdSbis`（4 元素数组）。IIFE 遍历 `CFG`（新增配置表 `SBI_LIGHTS_CFG`）创建 4 个 `createStatusBarItem(StatusBarAlignment.Left, pri)`，priority `-9996`/`-9997`/`-9998`/`-9999` 让 4 块并排在 Left 项最右端（done 最左 / interrupted 最右——priority 越高越靠左）。`onDidDispose` 最后一个 panel 退出时遍历 4 块逐个 `dispose()` 并置数组为 null。
- **数字内置彩色块**：每块 text = `n===0?"0":(n>=4?"N":""+n)`；count>0 → `backgroundColor=new ThemeColor(CFG[k].bg)` + `color="#ffffff"`；count=0 → `backgroundColor=undefined`（透明）+ `color=new ThemeColor("statusBarItem.deactivatedForeground")`（灰）。v0.1.14 的 `disp(em,n)` / `var EM=[🟢,🟡,🔵,🔴]` / `var DIM=⚪` / `var text=disp(...).join(" ")` 全部删除——4 块各自独立，无拼接。
- **4 个内置 `statusBarItem.*Background` 主题色**（`SBI_LIGHTS_CFG` patch.ts 单一真相源，`JSON.stringify` 烘焙进 IIFE 的 `var CFG=[...]`）：
  - 🟢 done → `statusBarItem.remoteBackground`（绿；SSH/WSL 远程指示器色，所有内置主题里都是绿）
  - 🟡 running → `statusBarItem.warningBackground`（黄/橙；VSCode 1.66 加入的 SBI 警告色）
  - 🔵 pending → `statusBarItem.prominentBackground`（饱和蓝；少数深色主题偏紫，仍可区分）
  - 🔴 interrupted → `statusBarItem.errorBackground`（红；标准 SBI 错误色）
- **click handler 适配 4 块**：`ccStatusDot.sbiClick` 的 handler 改读 `globalThis.__ccsdSbis[0].tooltip`（4 块共享同一 tooltip，每 500ms 刷新）。4 块的 `.command` 字段都设为该 ID，点击任一块都弹 `InformationMessage`。
- **`SBI_LIGHTS` / `SBI_DIM_EMOJI` / `SBI_LEFT_PRIORITY` 常量删除**：被 `SBI_LIGHTS_CFG`（`{key,bg,pri}` 表）取代。`SBI_CLICK_CMD` 不变。
- **IIFE 版本戳 `v0.1.14` → `v0.1.15`**：已 patch 的 v0.1.14 装在下次 install 时被检测为 STALE（version 不符 + hash 不符双重保护）→ 自动从 `extension.js.bak` 还原并重注入新 4-SBI IIFE。

### 保留（Preserved，v0.1.14 设计改进完整沿用到 v0.1.15）

- **🔵 pending 第 4 灯**（writer 的 `Notification` hook case + reader 独立计数 + 与 state 正交）。
- **done/running/interrupted 三路陈旧会话 GC**：done >5min→idle（§4）；running mtime >30min→idle（§7.2，变量名 `SBI_RUNNING_STALE_MS` 保留）；interrupted mtime >24h→idle（`INTERRUPTED_RETENTION_MS`）。per-tab 渲染**不应用**后两条，聚合层应用。
- **pending 与 idle GC 联动**：`j.pending===true && st!=="idle"`——防止被强杀的权限弹窗会话在 🟡 不计的同时 🔵 仍假粘。
- **聚合单例 + panel 计数 lifecycle**：`__ccsdSbis`（4 元素数组） + `__ccsdSbiTimer` 窗口级单例；`__ccsdPanelCount` 入口 +1 / `onDidDispose` -1，归零时清理（v0.1.15：遍历 4 块 dispose）。
- **三层独立 try/catch 隔离**：(1) 4-SBI 创建（循环）；(2) 单例 timer 注册；(3) aggregation body。
- **per-tab 4 态色点、`__ccsdPending` yield、notify、`__ccsdTitle` 刷新**：完全不变。

### 改进（Improved）

- **配色跨平台稳定**：v0.1.14 及更早的 🟢🟡🔵🔴 emoji 在 Win7/无 emoji 字体的 Linux/headless 可能黑白或豆腐块；v0.1.15 改用 `statusBarItem.*Background` ThemeColor，**完全跟随 VSCode 主题色**，跨平台稳定。这是 v0.1.15 相对 v0.1.14 的额外收益（用户要的是"数字内置块"，附带消除了 emoji 字体依赖）。

### 已知限制

- **形状是圆角矩形不是正圆**：VSCode `StatusBarItem` 无 `border-radius` API、无 overlay API——"球状块"在 SBI 限制下接受最接近方案（SBI 容器自带的轻微圆角矩形）。每块约 25-30px 宽，4 块约 110-130px 总宽。
- **`prominentBackground` 在少数深色主题偏紫**：🔵 pending 块在大多数主题是饱和蓝，某些深色主题可能偏紫；仍可与绿/黄/红区分。若不爽可在 `SBI_LIGHTS_CFG` 一处改为 `editor.selectionBackground` 或 `activityBarBadge.background`。
- **`statusBarItem.remoteBackground` 语义复用**：这个色本意是"远程 SSH/WSL 指示器"，我们借色不借义。若用户自定义了这色（覆盖 SSH 按钮色），我们的"done 绿"会跟着变——这其实是 feature（主题一致），不是 bug。

## [0.1.14] - 2026-07-18

**commandCenter 4 灯回退到底部 SBI 4 灯**。根因：v0.1.13 的 commandCenter 顶部居中 4 灯在 Reload Window + 完全重启 VSCode 后**根本不显示**——失败面太多（VSCode commandCenter 可见性开关、标题栏宽度预算、setContext→when 滤链、IIFE 仅在 CC panel 打开时才触发），在没有 VSCode 集成测试架的情况下无法定位。v0.1.12 的底部 SBI（动态 text）此前已验证可靠。v0.1.14 **保留 v0.1.13 全部设计改进**（新增 🔵 pending 第 4 灯、done/running/interrupted 三路陈旧会话 GC、pending 与 state 独立计数），**仅切换显示载体**回到单个运行时 `StatusBarItem`（`StatusBarAlignment.Left` + 极负 priority `-9999` → 在 Left 项里最靠右、最接近可见中心）。

### 变更（Changed）

- **IIFE 顶部 4 灯（commandCenter）→ 底部 4 灯（SBI）**：删 `globalThis.__ccsdCcTimer` + 4 个 `setContext` 推送 + `onDidDispose` 内的 4 个 setContext 重置；改为单个 `globalThis.__ccsdSbi = vs.window.createStatusBarItem(vs.StatusBarAlignment.Left, -9999)`，IIFE 每 500ms 直接 mutate `.text` / `.tooltip` / `.show()`。文本格式 `🟢N 🟡N 🔵N 🔴N`（count 0 → ⚪ 暗；1/2/3 → 彩色 + 空格 + 数字；>=4 → 彩色 + ` N`，`cap()` 截到 4）。tooltip 承载未截顶的真实计数（`X done, Y running, Z pending, W interrupted`）。`onDidDispose` 最后一个 panel 退出时 `clearInterval(__ccsdSbiTimer)` + `__ccsdSbi.dispose()`——SBI 不会冻结在陈旧计数。
- **click 反馈：20 个 package.json command → 1 个运行时 `registerCommand`**：删 `ccStatusDot.<key>.<variant>` 20 个命令的 package.json contrib + IIFE 注册块；改为单个 `ccStatusDot.sbiClick`，通过运行时 `vs.commands.registerCommand` 注册（`registerCommand` 无需 package.json contribution 即可被 `executeCommand` 查到），handler 把当前 tooltip 作 `InformationMessage` 弹出。`__ccsdSbiCmdRegistered` 守卫防同 host 重注册抛错。
- **install 不再 patch CC `package.json`**：删 `buildCcContribs` / `patchPackageJson` / `writePkgInject` / `injectedPkgVersion` / `injectedPkgHash` / `currentPkgHash` 及 `PKG_HASH_FIELD` 常量、`--check-pkg-contribs` dev flag、`test-pkg-contribs.mjs`、`test-smoke-v0.1.13.mjs`（两个测试都覆盖被移除的 install-side commandCenter contribs / setContext 端到端）。保留 `PKG_MARKER_FIELD` (`__ccStatusDotPkgManaged`) 常量 + `isPackageJsonPatched` + `restorePackageJson`，**仅用于检测并清理 v0.1.13 残留**——install 在 patch extension.js 前若发现 package.json 仍带 v0.1.13 marker，自动从 `package.json.bak` 还原（v0.1.13 升级用户重跑 `npx vscode-claude-code-status-dot` 即清理，无需先 `--revert`）；`--revert` 同样清理残留。
- **`SBI_LIGHTS` / `SBI_DIM_EMOJI` 取代 `CC_LIGHTS` / `CC_DIM_EMOJI` / `CC_COUNT_VARIANTS` / `CcLight`**：去掉 `key`（不再需要 setContext key 后缀）与 `variant` 维度（不再需要 5 种 text 变体）；只保留 emoji + tooltip。emoji 通过 `JSON.stringify` 烘焙进 IIFE 的 `var EM=[...]` + `var DIM="..."`，IIFE 源码仍不含原始 `\u{...}` 转义。
- **IIFE 版本戳 `v0.1.13` → `v0.1.14`**：已 patch 的 v0.1.13 装在下次 install 时被检测为 STALE（version 不符）→ 自动从 `extension.js.bak` 还原并重注入新 SBI IIFE（hash 也会变，双重保护）。

### 保留（Preserved，v0.1.13 设计改进完整沿用到 v0.1.14）

- **🔵 pending 第 4 灯**（writer 的 `Notification` hook case + reader 独立计数 + 与 state 正交）。
- **done/running/interrupted 三路陈旧会话 GC**：done >5min→idle（§4）；running mtime >30min→idle（§7.2，变量名 `SBI_RUNNING_STALE_MS` 保留）；interrupted mtime >24h→idle（`INTERRUPTED_RETENTION_MS`，§7.5）。per-tab 渲染**不应用**后两条（tab 保持黄/红提醒），聚合层应用——用户可肉眼看到具体哪个 tab 是黄/红并自行处理。
- **pending 与 idle GC 联动**：`j.pending===true && st!=="idle"`（`st` 是上面三条 decay 规则**已修正过**的值）——防止被强杀的权限弹窗会话 state=running/pending=true/mtime>30min 在 🟡 不计的同时 🔵 仍假粘 1。
- **聚合单例 + panel 计数 lifecycle**：`__ccsdSbi` + `__ccsdSbiTimer` 窗口级单例（P 个 panel 共享 1 个 timer）；`__ccsdPanelCount` 入口 +1 / `onDidDispose` -1，归零时清理。
- **三层独立 try/catch 隔离**（v0.1.12 round-3 review 沿用）：(1) SBI 创建；(2) 单例 timer 注册；(3) aggregation body。任何一层失败都不会传播到 CC 的 `update_session_state` handler，也不影响 per-tab 主链路。
- **per-tab 4 态色点、`__ccPending` yield、notify、`__ccTitle` 刷新**：完全不变。

### 移除（Removed）

- **commandCenter 顶部居中 4 灯**：v0.1.13 的 `contributes.menus.commandCenter` 20 项 + `contributes.commands` 20 项 + `contributes.menus.commandPalette` 20 项 hide。install 自动清理残留；`--revert` 也清理。
- **`setContext` 驱动**：`vs.commands.executeCommand("setContext","ccStatusDot.<key>",N)` 全部删除（包括 `onDidDispose` 内的 4 个重置）。SBI 直接 mutate text，无需 context key 中介。

### 已知限制

- **emoji 颜色保真度依赖 OS 字体栈**：🟢🟡🔵🔴⚪ 在 macOS 走 Apple Color Emoji 彩色，Win10+ Segoe UI Emoji 彩色；Win7/无 emoji 字体的 Linux/headless 可能黑白或豆腐块。颜色丢失时形状 + 数字仍承载信息（与 v0.1.12-v0.1.13 同款差异）。
- **SBI 位置受状态栏拥挤度影响**：极负 priority 让 SBI 在 Left 项里最靠右、最接近可见中心，但若用户装了大量其它 Left 项 SBI 仍可能被挤到角落——这是 StatusBarItem API 限制（无真正的"居中"槽位）。
- **click command 需 IIFE 注册**：reload 后若用户未打开 CC panel，`ccStatusDot.sbiClick` 未注册，此时点 SBI 不响应（VSCode 静默 no-op）。但 SBI 本身也未创建（IIFE 仅由 panel 打开触发），所以一致性 OK。

## [Unreleased]

修复「完成/中断通知不生效」。根因：`notifyWhenFocused` 默认 `false`，导致用户在 VSCode 前台（最常见场景）时**所有**通知被抑制——hook 正确写了 `done`/`interrupted`（`~/.claude/cc-tab-status/<sid>.json`），但 IIFE 在前台一律不弹。

### 变更（Changed）

- **`notifyWhenFocused` 默认值 `false` → `true`**（patch.ts `buildIIFE` 内 `c.get("notifyWhenFocused",true)`）。前台时也会弹 VSCode 消息，完成/中断不再静默。"聚焦于 VSCode 窗口"≠"盯着 CC tab"，原默认让通知在最常见场景下永远不触发，等同于功能失效。想恢复"前台不打扰"的用户把 `ccStatusDot.notifyWhenFocused` 设回 `false` 即可（`notify` 总开关仍在）。
- **通知触发逻辑由 `prevSt` 状态转换改为 `since` 时间戳去重**（注入 IIFE）。原 `prevSt` 逻辑要求 500ms 轮询**采样到** `running` 再转到 `done`/`interrupted` 才触发——若一轮跑得太快（两次轮询之间已完成 running→done）或 reload 落在旧 `done` 上，转换永远观测不到，通知丢失。新逻辑：首次轮询用当前终态的 `since` 做种子（避免 reload 对陈旧状态误报），之后每个**新的终态 `since`** 触发一次（`done` 的 `since` 在 `Stop` 时刷新、`Stop` 前 heartbeat 写的是 `running` 不影响）。覆盖快速完成、reload、连续多轮等全部路径，且不重复弹。
- **IIFE 版本戳 `v0.1.4` → `v0.1.5`**：已 patch 的旧装在下次 `npx vscode-claude-code-status-dot` 时会被检测为 STALE 并自动重注入新 IIFE（无需先 `--revert`）。

### 修复（Fixed）

- **macOS `osascript` 系统通知被特殊字符静默打断**：`__ccTitle`（注入到通知文案）若含 `"` 或 `\`，原代码把 `msg` 直接拼进 AppleScript 字符串字面量 → `osascript` 语法错 → 被 `try/catch` 吞掉，系统通知不弹（VSCode 消息仍弹，但前台被抑制时则全军覆没）。改为先用 `replace(/["\\]/g, c => "\\"+c)` 转义再拼。已用 `osascript -e` 实跑含引号/反斜杠标题验证通过。

## [0.1.3] - 2026-07-17

减法 + 重做版本：去掉「聚合色块条」webview 注入，把 running 从 0.1.2 的「2 帧大跳变」重做为「8 帧正弦渐变 + 三角波」的流畅呼吸，并铺设 IIFE 版本戳以便后续升级能正确重注入。

### 变更（Changed）

- **running 改为流畅呼吸**（`#8A6A00` 暗 ↔ `#FFD60A` 亮，8 帧正弦 ease-in-out 渐变）。0.1.2 的呼吸只有 2 帧（dim↔bright）——两帧色差大、1500ms/帧的离散切换视觉上更像闪烁。0.1.3 改为 8 帧（相邻帧每通道 Δ ≤ ~10%），用 14 步三角波播放（`0,1,2,3,4,5,6,7,6,5,4,3,2,1`），峰值（亮）/谷值（暗）各一次，其余帧各两次/周期。`TICK_MS` 由 500 调整为 450：14 步 × 450ms = **~6.3s 一个呼吸周期**（缓慢、肉眼连续渐变）。interrupted 仍走 `seq%2` 快闪（450ms on/off，仍是告警级快闪，仅比旧的 500ms 快 10%，肉眼无感）。
- **`TICK_MS`：500 → 450**（同时驱动呼吸切帧、interrupted 快闪、done→idle 5 分钟轮询、prevSt 转换检测）。

### 移除（Removed）

- **聚合状态条 webview 注入**（v0.1.2 引入的右下角色块条）：`patchWebview` / `buildWebviewJsIIFE` / `buildWebviewCss` 及相关常量（`ACQUIRE_RE` / `WV_JS_MARKER` / `WV_API_MARKER` / `WV_CSS_MARKER`）全部删除。每个 session 的状态由 tab 图标四态点 + 完成/中断通知完整表达；色块条是冗余而非增量信息，且在 webview `index.js`/`index.css` 上独立打补丁，维护成本与脆弱性都高于 extension.js 的 iconPath 注入。
- **旧 running 静态/2 帧呼吸 SVG**：v0.1.0/0.1.2 的 `claude-logo-running.svg`（静态 `#CCA700`）/ `claude-logo-running-dim.svg` / `-1.svg` / `-2.svg` / `-bright.svg` 等均删除，由新的 8 帧 `claude-logo-running-{0..7}.svg` 取代。`OUR_SVGS` 变为 11 个（idle + 8 running 帧 + done + error）。
- IIFE 注入中的聚合桥（`readdirSync` 多 session 聚合 / `postMessage` 推 webview / `onDidReceiveMessage` 监听 `cc_focus_session`）删除。

### 新增（Added）

- **8 帧 running 呼吸 SVG**：`claude-logo-running-0.svg` … `claude-logo-running-7.svg`，色值按 `sin(i·π/14)` 正弦插值（i=0..7）：`#8A6A00` `#A48202` `#BD9904` `#D3AD06` `#E5BE08` `#F3CB09` `#FCD30A` `#FFD60A`。
- **IIFE 切帧逻辑**：注入块内 bake 进 `RUN_FRAMES`（8 帧文件名数组）+ `RUN_IDX`（14 步三角波索引数组）两个常量，running 分支 `svg = RES/RUN_FRAMES[RUN_IDX[seq%14]]`。周期可调（改 `RUN_IDX` 或 `TICK_MS`）。
- **install 自动清理旧聚合条**：install 时检测 webview 仍带 v0.1.2 注入标记（`cc-status-bar-injected` 墓碑注释）→ 自动从 `.bak` 还原 webview。v0.1.2 用户重跑 `npx vscode-claude-code-status-dot` 即升级即清理，无需先手动 `--revert`。
- **install 清理过期 SVG**：`installRuntimeFiles` 收尾时扫描 `INSTALL_DIR/resources`，删除任何不在 `OUR_SVGS` 内的 `claude-logo-*.svg`（只清自身命名空间，安全）。升级时也会清掉旧的静态 `claude-logo-running.svg`。
- **IIFE 版本戳**：注入块首行 banner 改为 `/*cc-status-dot-injected:v0.1.3*/`。`patchExtension` 检测到旧版本 IIFE（marker 在但版本缺失或偏旧）时，自动从 `.bak` 还原并完整重注入——避免「bare marker 命中 → 跳过 → 旧 IIFE 逻辑残留」的静默回归。`--status` 同步报告 `injected IIFE: <ver>` 行，旧版标注 STALE。
- **`--status` 输出新增 `injected IIFE` 行**：显示当前注入版本，旧版/无版本戳标 STALE 提示重跑。

### 保留（ unchanged，未误伤）

- `notify`（done/interrupted 完成/中断通知，依赖 prevSt 转换检测 + focused 抑制 + macOS osascript + 声音）
- workflow / 后台 subagent 跑期间保持 running（`Stop`/`SubagentStop` 权威裁定 + `activeSubagents` 早信号）
- `done` 超 5 分钟由 reader 渲染为 `idle`
- 持久化 `INSTALL_DIR`（删项目源 / 清 npx 缓存 / CC 自动更新都不影响已 patch 扩展）
- `hookCommand(process.execPath)` 绝对路径（macOS Finder/Spotlight 启动的 PATH 兜底）
- `--revert` 链路完整（restoreExtension → restoreWebview → unwireHooks → removeInstallDir → reportResidualBaks，保留 STATE_DIR 用户数据）

## [0.1.0] - 2026-07-10

初版发布。

### 新增

- 四态 session tab 图标：`idle`（灰 `#808080`）/ `running`（黄 `#CCA700`↔`#FFD60A` 呼吸）/ `done`（绿 `#3FB950`）/ `interrupted`（红 `#F85149` 快闪）。
- `permission` 态交由 Claude Code 原生蓝点处理；注入 reader 在无状态文件 / 状态未知时 `return` 不覆盖，CC 蓝点自然显示。
- hooks 状态源：`hooks/cc-status.js`（Node 跨平台零依赖，读 stdin JSON），按 session 写 `~/.claude/cc-tab-status/<session_id>.json` = `{state, since, error?}`（原子写，目录自动创建）。
- 接线 6 个 CC hook 事件：`UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `StopFailure` / `SessionEnd`。
- patcher `npx tsx patch.ts`：发现 CC 扩展、备份 `extension.js`、anchor 唯一性校验、注入 IIFE（500ms 重绘定时器）、自动写 `~/.claude/settings.json` hooks（幂等带标记）、校验 5 个 SVG。
- 5 个 SVG：`claude-logo-idle.svg` / `claude-logo-running.svg` / `claude-logo-running-bright.svg` / `claude-logo-done.svg` / `claude-logo-error.svg`（按绝对路径引用本项目 `resources/`，CC 更新不丢）。
- `done` 超 5 分钟由 reader 自动渲染为 `idle`。
- `--revert`：从 `extension.js.bak` 干净还原 `extension.js`，并基于标记精确移除 `settings.json` 中的 hooks（不影响其它 hook）。
- `--status`：dry-run 报告（CC 版本 / 是否已 patch / hooks 是否接 / SVG 是否齐 / 状态目录）。

> 注：0.1.0 的「呼吸」「5 个 SVG」描述已于 [0.1.3] **更新**：running 改为 8 帧正弦渐变 + 三角波的流畅呼吸（取代 0.1.2 的 2 帧大跳变），SVG 增至 11 个；6 hook 事件也于后续版本扩展为 8 个（增加 `SubagentStart` / `SubagentStop`）。

### 已知限制

- 手动 Esc 中断无 hook，状态停在 `running`，靠下一次 `UserPromptSubmit` / `Stop` 自然更正。
- CC 自动更新覆盖 patched `extension.js`，需重跑 patch。
- minified anchor 的版本脆性：anchor 失配时报错拒写，引导提 issue。
