export const meta = {
  name: 'v053-full-5dim-audit',
  description: 'v0.5.3 全项目 5 维全面代码审查(代码规范/数据逻辑/业务逻辑/端到端接通验证/简单架构审查)→ 修 critical/high/medium → 复审至零 blocking。含 Favorites 7 bug。不发布',
  phases: [
    { title: 'Review', detail: '5 维并行全面代码审查' },
    { title: 'Fix', detail: '修 blocking findings(critical/high/medium)' },
    { title: 'Re-review', detail: '复审至零 blocking(最多 5 轮)' },
  ],
}

var PROJECT = '/Users/wangdong/Documents/Project/vscode-cc-提示插件/claude-code-status-dot'
var PATCH = PROJECT + '/patch.ts'
var HOOK = PROJECT + '/hooks/cc-status.js'
var COMPANION = PROJECT + '/companion/extension.ts'
var COMPANION_PKG = PROJECT + '/companion/package.json'
var CHECKLIST = '/Users/wangdong/Documents/Project/架构想法/02_简单检查清单.md'

var SCOPE = '项目 vscode-claude-code-status-dot(当前 main HEAD = v0.5.2 commit 67f74b6, 已发 npm)。架构: patch.ts buildIIFE 注入 CC extension.js(per-panel 500ms tick: 5 态 iconPath + 底部 4 灯 SBI + token SBI 含速率内联 + v0.5.0 fav-detection 金线 + v0.5.2 transcript 活动 decay 门); hooks/cc-status.js(10 事件 writer + 内容判断蓝灯 + Stop pending); companion/extension.ts(v0.4.0 Favorites 视图/命令/menus + favorites.json + fs.watchFile 2s; v0.5.1 package.nls 8 语言)。用户反馈"bug 太多了", 要全项目 5 维审查修到零。\n\n**【范围严限】所有 agent 操作严禁超出 ' + PROJECT + ' 范围**(不碰光音/media-gen-mcp/luceo/其它本地项目)。**唯一例外: 简单架构审查维度可读 ' + CHECKLIST + '**。外部调研走 WebSearch/VSCode docs。越界 finding 无效。**'

var CONTEXT = '【近期改动(v0.4-v0.5.2, bug 高发区)】v0.4.0 收藏(Explorer 视图+命令+favorites.json+fs.watchFile); v0.5.0 tab 右键(editor/title/context when=resourceScheme!=file)+ 金线 -fav SVG + IIFE fav-detection(readFavSet mtime-cache); v0.5.1 速率内联 SBI+移图 + 右键 when 修 + package.nls i18n; v0.5.2 蓝→黄 fallback HARD/SOFT 拆 + decay 阈值统一 30min + __ccsdTranscriptFresh 活动门 + 移除死日志器 __ccsdDbg。\n\n【已知用户报的 bug(必查, 但不限于此)】F1 右键收藏不可靠(某些会话加不进, "调研..."加不进); F2 收藏名称显 UUID 非会话名; F3 收藏图标圆中斜杠(无效 ThemeIcon); F4 刷新后收藏消失; F5 刷新抢聊天框焦点(v0.5.2 review 漏查 companion 刷新路径); F6 "打开的编辑器" tab 右键缺收藏; F7 命令文案冗余(改"CC 收藏")。'

var REQUIREMENT = '【目标】5 维全面审查, 每维深挖找 issue(severity critical/high/medium/low), 修 critical/high/medium 至零 blocking。\n【通用】build 在 v0.5.2。版本: 若改代码 → v0.5.3(package+companion+INJECT+IIFE.21c stamp)+ CHANGELOG。不破坏 v0.2.7-v0.5.2 既有功能。IIFE 括号配平。不跑 npm install。不发布。\n【验证】npm run build + companion:install+build + node --check dist/patch.js + node --check companion/dist/extension.js + npm test 全绿 + standalone e2e + prettier + IIFE 括号。'

phase('Review')
var DIMS = [
  { k: 'code-standards', c: '代码规范: prettier 合规(全文件)、命名一致、注释准确(无过时/误导注释, 如残留 __ccsdDbg/SINCE_STALE_MS 注释是否对)、死代码(未用变量/函数/import)、type safety(any 滥用?非空断言?)、magic number、文件组织、跨文件一致性。patch.ts(5194+行 god-module 债, 评估但不强制拆)。' },
  { k: 'data-logic', c: '数据逻辑: favorites.json schema + 读写原子性(writeFavAtomic 真原子? readFavDoc mtime-cache 失效? **F4 刷新消失竞态**); <sid>.json/<sid>.tokens.json/<sid>.offset schema + Q1 持久(SessionEnd 不删); token counting(computeLiveDelta 增量 + windows + 速率 v0.5.1); decay 阈值(v0.5.2 统一 30min + transcript 活动门 __ccsdTranscriptFresh 正确性); state 转移数据流。' },
  { k: 'business-logic', c: '业务逻辑: 5 态机(idle/running/done/interrupted/pending)+ decay 语义(v0.5.2 活动门不假阳性); 蓝灯内容判断(v0.5.2 HARD/SOFT 拆, **F1 蓝→黄 idiom 路径 v0.5.3 缺口**); 收藏业务(**F1 toggle 可靠 activeSid 捕获 / F2 label=title / F6 打开的编辑器右键 / F7 文案**); Q1-Q7 修复完整; PostCompact 清红; permission 蓝; interrupted sticky。' },
  { k: 'e2e-integration', c: '端到端接通验证: IIFE↔companion 桥(globalThis.__ccsdActiveSid/__ccsdLastActiveSid/__ccsdSidToPanel/**__ccsdActiveTitle 是否暴露给 companion 读 F2 label**); hook↔IIFE(state file); CC 事件→hook→state file→IIFE 渲染→companion 视图 全链路; **F1 toggle: 右键 tab→activeSid→favorites.json→TreeView 显** 全通; **F3 图标 ThemeIcon 解析**; **F5 刷新路径抢焦点 re-audit**(onDidChangeTreeData/watchFile/refresh 有无 reveal/show/focus/executeCommand)。端到端断言覆盖(test 有无)。' },
]
var SCHEMA = { type: 'object', additionalProperties: false, properties: { dimension: { type: 'string' }, findings: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { file: { type: 'string' }, line: { type: 'number' }, severity: { type: 'string', enum: ['critical','high','medium','low'] }, issue: { type: 'string' }, suggest: { type: 'string' } }, required: ['file','severity','issue','suggest'] } }, summary: { type: 'string' } }, required: ['dimension','findings','summary'] }

var findings = await parallel(DIMS.map(function (d) {
  return function () { return agent('全面审查 [' + d.k + '] 维度。\n' + SCOPE + '\n【近期改动+已知 bug】' + CONTEXT + '\n\n【本维审查重点】' + d.c + '\n\n深读 ' + PATCH + ' + ' + HOOK + ' + ' + COMPANION + ' + ' + COMPANION_PKG + ' + hooks/test-*.mjs, 找本维所有 issue(给 file/line/severity/issue/suggest)。**不限于已知 bug, 主动发现新问题**。给 schema。', { label: 'review:' + d.k, phase: 'Review', schema: SCHEMA }) }
}))
// 简单架构审查(可读 CHECKLIST)
var archReview = await agent('简单架构审查维度(可读 ' + CHECKLIST + ' + ' + PROJECT + ' 下文件)。这是唯一允许读项目外文件的 agent。读 ' + CHECKLIST + ' 检查清单, 应用到全项目(重点 v0.4-v0.5.2 改动)。按清单四刻度(架构合理/边界/耦合/可维护)+ 变更放大率(R-CHG-01)+ 不变量 + 适应度函数 审。给 findings(schema, file 用项目内路径或 architecture-general)。\n' + SCOPE + '\n【近期改动】' + CONTEXT, { label: 'review:simple-arch', phase: 'Review', schema: SCHEMA })
findings.push(archReview)

function isBlocking(x) { return x && (x.severity === 'critical' || x.severity === 'high' || x.severity === 'medium') }
function anyBlocking(arr) { return arr.filter(Boolean).some(function (f) { return (f.findings || []).some(isBlocking) }) }
function countBlocking(arr) { return arr.filter(Boolean).reduce(function (n, f) { return n + (f.findings || []).filter(isBlocking).length }, 0) }
function inScope(f) { return typeof f === 'string' && (f.indexOf('claude-code-status-dot') !== -1 || f === 'architecture-general') }

var round = 0
var current = findings
var fixLogs = []
// 先修一轮(初次审查肯定有 blocking)
phase('Fix')
while (round < 5 && anyBlocking(current)) {
  round = round + 1
  // 过滤越界 finding
  current = current.filter(Boolean).map(function (f) {
    f.findings = (f.findings || []).filter(function (x) { return inScope(x.file) })
    return f
  })
  if (!anyBlocking(current)) break
  log('round ' + round + '/5: ' + countBlocking(current) + ' in-scope blocking -> fix')
  phase('Fix round ' + round)
  var fl = await agent('修复(第 ' + round + '/5 轮, 只 cc-status-dot, 不越界)。\n【需求】' + REQUIREMENT + '\n【findings】\n' + JSON.stringify(current) + '\n\n修 critical/high/medium。不破坏 v0.2.7-v0.5.2 既有。IIFE 括号配平。不跑 npm install。\n【验证】npm run build + companion:install+build + node --check dist/patch.js + node --check companion/dist/extension.js + npm test 全绿 + standalone e2e + prettier + IIFE 括号。\n返回:每 finding 修了啥 + 改哪些文件 + 验证输出(npm test 通过数 + prettier + e2e)。', { label: 'fix:' + round, phase: 'Fix round ' + round })
  fixLogs.push(fl)
  phase('Re-review round ' + round)
  current = await parallel(DIMS.map(function (d) {
    return function () { return agent('复审 [' + d.k + '] 第 ' + round + '/5 轮(只 cc-status-dot)。验上轮 findings 修了没 + 有无新问题。给剩余 findings(schema)。', { label: 'rereview:' + d.k + ':' + round, phase: 'Re-review round ' + round, schema: SCHEMA }) }
  }))
  current.push(await agent('简单架构复审第 ' + round + '/5 轮(可读 ' + CHECKLIST + ')。给剩余 findings。', { label: 'rereview:simple-arch:' + round, phase: 'Re-review round ' + round, schema: SCHEMA }))
}
var clean = !anyBlocking(current)
log('after ' + round + ' round(s): ' + (clean ? 'CLEAN (zero blocking)' : countBlocking(current) + ' blocking remain (low-only or cap reached)'))
return { rounds: round, clean: clean, fixLogs: fixLogs, finalFindings: current.filter(Boolean) }
