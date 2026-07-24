#!/usr/bin/env node
'use strict';
/*cc-status-dot-hook:v0.2.1:ee85674f*/

/**
 * cc-status.js — Claude Code per-session status hook (cross-platform).
 *
 * Version + content-hash stamp above (cc-status-dot-hook:vX.Y.Z:HASH) mirrors
 * the IIFE's INJECT_VERSION+hash banner so installRuntimeFiles can detect a
 * stale on-disk hook copy the same way patchExtension detects a stale IIFE
 * (the version banner catches inter-version drift; the content-hash suffix
 * catches intra-version drift — a dev who edited the hook body but forgot to
 * bump HOOK_VERSION). Bump HOOK_VERSION when the writer CONTRACT changes;
 * re-stamp the hash whenever the BODY changes. The hash is sha1 of the file
 * body with the banner line replaced by an empty line, truncated to 8 hex
 * chars (HOOK_HASH_LEN in patch.ts).
 *
 * Reads a CC hook event from stdin (JSON) and writes a status file to
 *   ~/.claude/cc-tab-status/<session_id>.json
 * shaped as  { state, since, error?, activeSubagents, pending?, cwd?, tokens? }
 * so an external reader (e.g. a VS Code status-dot patch) can render the
 * current state of every CC session.
 *
 * v0.2.4 additions (backward-compat — old readers ignore the new fields):
 *   cwd    : payload.cwd — current working dir, surfaced for the IIFE tooltip
 *   tokens : derived token totals + 8 windows + per-window cost + session
 *            cost + cost_partial flag. Source of truth is the CC transcript
 *            jsonl at payload.transcript_path (one line per assistant message,
 *            message.usage carries input/output/cache_read/cache_creation*).
 *            Writer maintains a byte-offset sidecar at <sid>.offset so the
 *            read is incremental (KB-level even for multi-MB transcripts) —
 *            see readTranscriptIncremental below.
 *            Subagent transcripts (payload.agent_transcript_path on
 *            SubagentStop) are merged into the parent sid's buckets so the
 *            user sees the full cost of the session they pay for (subagent
 *            runs DO bill). Per-source offset tracking isolates the parent
 *            transcript's read position from each subagent's, so SubagentStop
 *            cannot corrupt the parent's cumulative state (critical fix:
 *            previously both shared the same offset key).
 *
 * States written:  running | done | interrupted  (+ optional `pending:true` flag)
 *   (idle is inferred by the reader when no file exists / done > 5 min;
 *    `pending:true` is written by (a) the Notification event — permission /
 *    question / elicit prompt — or (b) v0.2.6 the Stop event when Claude's
 *    last_assistant_message clearly awaits user input/decision/feedback
 *    ("等你测试反馈" / "let me know" / "please confirm" / short standalone
 *    question to user — see AWAIT_USER_RE / lastMessageRequestsUserInput).
 *    It is cleared by every user/turn-driven event (UserPromptSubmit /
 *    Pre/PostToolUse / Stop[no-match] / StopFailure). SubagentStart /
 *    SubagentStop PRESERVE cur.pending instead: they are background events
 *    with no signal about whether the parent's prompt is still open. The
 *    reader counts pending INDEPENDENTLY of state so a session can be both
 *    running AND pending, which is the typical case: a running turn paused
 *    on a permission prompt, or a finished turn whose reply awaits reply.)
 *
 * Event mapping (MUST equal HOOK_EVENTS in patch.ts; see docs/STATES.md §2):
 *   UserPromptSubmit          -> running (activeSubagents: prefer payload
 *                                 background_tasks, else reset 0 — drift must
 *                                 NOT bleed across turns) + CLEAR pending
 *   PreToolUse / PostToolUse  -> running (heartbeat; refresh `since`;
 *                                 activeSubagents same rule as UserPromptSubmit)
 *                                 + CLEAR pending
 *   SubagentStart             -> running (early signal; activeSubagents+1)
 *                                 + PRESERVE cur.pending (background event —
 *                                 no signal about parent's open prompt)
 *   SubagentStop              -> persist decremented count (clamp 0); running if
 *                                 tasks remain, else keep cur.state (Stop decides)
 *                                 + PRESERVE cur.pending (background event)
 *   Notification              -> mark `pending:true` (preserve cur.state/since;
 *                                 NEW v0.1.13 — feeds the 🔵 commandCenter light)
 *   Stop                      -> done, UNLESS inflight background_tasks > 0
 *                                 -> running. The payload is the ONLY authority
 *                                 at Stop; the on-disk activeSubagents is NOT
 *                                 consulted — it can drift (SubagentStart with
 *                                 no matching SubagentStop) and false-stick at
 *                                 running. When the payload omits
 *                                 background_tasks we read done + clear the
 *                                 residual counter. Also CLEAR pending, EXCEPT
 *                                 v0.2.6: if last_assistant_message clearly
 *                                 awaits user input (AWAIT_USER_RE match or
 *                                 short standalone question), write pending:true
 *                                 instead — the reader's per-tab tick renders
 *                                 blue (pending) over green (done) and the 🔵
 *                                 SBI counts it. Skip when stop_hook_active=true
 *                                 (CC anti-loop gate).
 *   StopFailure               -> interrupted (records the error enum)
 *                                 + CLEAR pending
 *   SessionEnd                -> delete the session's status file
 *
 * Robustness contract (NEVER block or break CC):
 *   - empty stdin or invalid JSON  -> silent exit(0)
 *   - any module-load/parse/IO error -> silent exit(0), nothing on stderr
 *   - writes are atomic (tmp + rename), dir auto-created
 *   - deriveStatus is read-modify-write: reads current activeSubagents, then
 *     writes back. Hybrid — the background_tasks payload is authoritative when
 *     present (CC v2.1.145+); activeSubagents is the early-signal fallback.
 *     Cross-process races are bounded by payload correction + clamp 0
 *     (see SUBAGENT-design.md §4.3); reader never reads activeSubagents.
 *   - zero external dependencies (Node built-ins only)
 *
 * Portability: Node's built-in modules are loaded with dynamic import()
 * inside main() so this single .js file runs correctly whether the nearest
 * package.json declares "type":"module" (ESM) or not (CommonJS). A static
 * `require`/`import` would crash at load time under the wrong module system
 * and leak a stack trace to CC; dynamic import() avoids that entirely.
 */

// ----------------------------------------------------------------------------
// Pure helpers — use only language globals (no Node modules), so they are safe
// to define at module top in both CommonJS and ESM.
// ----------------------------------------------------------------------------

/**
 * Read all of stdin as a UTF-8 string.
 * Resolves to '' on any stream error so callers can treat it as "no input".
 *
 * Bounded wait (round-2 business-logic fix): if CC never sends EOF nor an
 * 'error' event (shell-integration bug, hung parent process, half-connected
 * pipe), the file-level 'NEVER block or break CC' contract would otherwise
 * be unbounded — main() awaits forever, the hook process lingers as a
 * zombie dependent on CC's own external hook-kill. The STDIN_TIMEOUT_MS
 * timeout below destroy()s stdin and resolves with '' (same path as a
 * stream error), completing the contract on every code path. 5s default
 * is well beyond any legitimate CC stdin flush (sub-ms typical) and well
 * under CC's hook-kill threshold, so it never fires in normal operation.
 * The timer is cleared on the normal 'end'/'error' paths so the handle
 * doesn't leak. CC_STATUS_STDIN_TIMEOUT_MS override exists for tests and
 * debugging (e.g. set to 60000 to disable effectively during a debugger
 * session that holds the child paused past 5s).
 */
// v0.2.4 (data-logic LOW fix): the prior form was `Number(env) || 5000`,
// which silently rewrote 0 → 5000 (treated 0 as falsy) and accepted
// negative numbers (Number(-100) is truthy → setTimeout(-100) clamps to 0
// → stdin destroyed immediately, possibly before CC finished writing).
// Mirrors the GC_INTERVAL_MS round-2 fix: only parse when the env var is
// present and non-empty; Math.max(0, ...) rejects negatives explicitly.
const STDIN_TIMEOUT_RAW = process.env.CC_STATUS_STDIN_TIMEOUT_MS;
const STDIN_TIMEOUT_MS =
  STDIN_TIMEOUT_RAW !== undefined && STDIN_TIMEOUT_RAW !== '' ? Math.max(0, Number(STDIN_TIMEOUT_RAW) || 0) : 5000;
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try {
        process.stdin.destroy();
      } catch {
        /* ignore */
      }
      finish('');
    }, STDIN_TIMEOUT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => finish(data));
    process.stdin.on('error', () => finish(''));
  });
}

// Sentinel return value meaning "delete this session's status file".
const DELETE = Symbol('delete');

// 24h retention threshold for interrupted sessions. CONTRACT: MUST equal the
// reader IIFE's INTERRUPTED_RETENTION_MS (patch.ts buildIIFE) and STATES.md §7.2
// rule 3 / §7.5. The aggregation layer decays interrupted>24h to idle for
// COUNTING but keeps the file on disk for diagnostic inspection (STATES.md §7.5
// "文件不删（保留诊断价值）" — files are kept on disk for diagnostic value);
// the writer's UserPromptSubmit GC below mirrors
// the threshold for its bounded prune. Named here (not inlined) so a search for
// INTERRUPTED_RETENTION_MS lands both files with one token and a future tuning
// edit hits both sites in lockstep. The test-iife.mjs IIFE.37c regex + the
// §INTERRUPTED-RETENTION test in test-cc-status.js both pin the literal value,
// catching drift at CI time.
// v0.2.7 (Q2 interrupted sticky): extended from 24h to 7d. User report
// "interrupted 红色自己消了" had a 24h decay as one of three suspects — the
// prior 24h window was borderline for cross-day workflows. 7d keeps the 🔴
// light sticky for "is the issue still open this week?" while still bounding
// disk residue from abandoned crashes (research warned unbounded growth if
// cancelled entirely). Mirrors GC_DRIFT_SINCE_MS for a single coherent "stale
// terminal session" horizon on both the interrupted-preservation path (§7.5)
// and the drift-prune path (§7.5 contract).
const INTERRUPTED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// v0.2.6 round-3 MEDIUM (regression §7.5 contract): drifted inflight .json
// files (Stop payload inflight=1 drift + cc-status.js:390-401 preserveSince
// keeps cur.since old + writeJsonAtomic refreshes mtime fresh on every Stop
// heartbeat) survive the mtime-based GC indefinitely — the reader long-since
// hid them from counts (decay running>15min via since), but disk residue
// grows unbounded if CC keeps re-firing Stop on the drifted workflow. The
// writer-GC therefore also prunes any .json whose `since` field is older
// than GC_DRIFT_SINCE_MS even when mtime is fresh. The 7d bound is
// intentionally longer than INTERRUPTED_RETENTION_MS (24h) so a
// legitimately-running long session whose since is <7d is NOT pruned by
// this path (it is still subject to the normal mtime rule + interrupted
// preservation). Mirrors the §7.5 contract patch.ts:309-312 documents.
// v0.2.6 round-3 follow-up: referenced in the .json GC branch below
// (isJson parse → sinceMs check). The §C.11 test pins the fresh-mtime +
// old-since case so the phantom cannot return silently.
const GC_DRIFT_SINCE_MS = 7 * 24 * 60 * 60 * 1000;

// v0.2.6 — blue-via-content: phrases signaling Claude's final Stop reply
// awaits explicit user input/decision/feedback/confirmation. When the Stop
// payload's last_assistant_message matches, the writer sets pending:true so
// the reader's per-tab tick renders the blue pending dot (and the bottom SBI
// 🔵 counts it) — extending the existing permission-blue (Notification →
// pending:true) to also cover "Claude replied and is clearly waiting on you".
// Done/green logic is untouched: pending=false fallback remains, so a neutral
// completion ("Done. All tests pass.") stays green.
//
// Design philosophy — SPECIFICITY > RECALL. A false blue (wrongly lit 🔵 on
// a finished turn) is more jarring than a false green (a missed 🔵 the user
// reads as "done" and moves on). So we list only unambiguous idioms:
//   - ZH uses "你" as a user-marker anchor BUT bare 2-char "你X" substrings
//     are NOT precise enough — v0.2.6 round-2 round of fixes removed
//     "你定" (matched "你定义的函数" / "你定制" / "你定位" / "你定期"),
//     "看你的" (matched "我看你的代码" — extremely high-frequency in CC
//     code-review replies), and bare "告诉我" (matched "文档告诉我 X" /
//     "你昨天告诉我的 Y"). The remaining ZH entries are either >=3 chars
//     OR carry a decision/feedback suffix that anchors the user-directed
//     intent ("你决定" / "请你授权" / "告诉我你的" + object).
//   - EN uses multi-word idioms ("let me know", "your call") so a bare
//     "decided" inside LLM self-narration ("I decided to use approach B")
//     cannot match (only "you decide" is listed). v0.2.6 round-2 also
//     removed "wait for you" (substring of "waiting for you" — redundant)
//     and tightened "your input" to "your input on" (bare "your input"
//     matched "your input handler" / "your input validation" — frequent
//     in CC code-edit replies).
//   - Fallback: a short (<=60 chars) standalone question to the user, e.g.
//     "需要继续吗？" / "Should I proceed?" — catches idioms not enumerated.
//     v0.2.6 round-2 added a semantic-anchor gate (must contain a user
//     pronoun 你/您/you OR an action verb 继续/确认/选/决定/proceed/confirm/
//     choose/need/want) so rhetorical questions ("Why?", "什么意思?",
//     "效果如何?", "How does this work?") — common inside LLM design
//     exposition — don't false-trigger.
// Code blocks (```fenced``` and `inline`) are stripped before matching so
// identifiers like `letMeKnow()` inside samples don't false-trigger.
// stop_hook_active=true MUST skip (CC's anti-loop gate: Stop hook firing on
// its own continuation leaves an empty/stale last_assistant_message).
const AWAIT_USER_PHRASES = [
  // ZH: user-directed wait (你 = user marker, vs 技术 "等待加载")
  '等你',
  // v0.2.6 round-3 MEDIUM: polite 您 form — when the LLM mirrors a polite/
  // enterprise register it produces "等您决定" / "您来选吧" which the 你-only
  // list missed (false negative). The fallback USER_DIRECTED_RE has 您 but
  // only fires for SHORT standalone questions ending in ?; declarative
  // "等您决定" → no match. Mirrors of the highest-value user-directed 你
  // entries; the rest of the 你 entries below cover their 您 forms implicitly
  // only when a substring also matches (e.g. '请确认' covers '请确认您要').
  '等您',
  // ZH: explicit decision / delegation (>=3 chars OR suffix-anchored —
  // v0.2.6 round-2: bare "你定" removed, matched "你定义/你定制/你定位/
  // 你定期"; bare "看你的" removed, matched "我看你的代码" in CC reviews;
  // bare "告诉我" removed, matched "文档告诉我" / "你昨天告诉我").
  '你决定',
  '您决定',
  '你来决定',
  '您来决定',
  '由你决定',
  '由你来决定',
  '你来定',
  '由你定',
  '你定夺',
  '你定一下',
  '你来选',
  '您来选',
  '你选',
  '由你来选',
  '你确认',
  '您确认',
  '请确认',
  '告诉我你的',
  '告诉我你决定',
  '告诉我你选',
  '请告诉',
  '给我反馈',
  '提供反馈',
  '看你怎么办',
  '你看呢',
  '你看咋办',
  '你说呢',
  '你说吧',
  '听你的',
  '需要你授权',
  '请你授权',
  '等你授权',
  '选哪个',
  '选哪一项',
  '选哪一个',
  // EN: idiomatic feedback asks (multi-word so bare "decided" cannot match).
  // v0.2.6 round-2: bare "wait for you" removed (substring of "waiting for
  // you" — pure redundancy, and also matched "wait for your input file");
  // "your input" tightened to "your input on" (bare form matched "your
  // input handler" / "your input validation" in CC code-edit replies).
  // v0.2.6 round-3 HIGH/MEDIUM: bare 'your call' / 'waiting for you' /
  // 'over to you' / 'you pick' / 'you decide' migrated to AWAIT_USER_PHRASES_RE
  // with word-boundary / negative-lookahead anchors (see comment there) —
  // bare forms matched 'your callback' / 'waiting for your input file' /
  // 'hand over to your team' / 'you picked' / 'you decided' in CC replies.
  'let me know',
  'your decision',
  'your choice',
  'your pick',
  'your take',
  'your move',
  'you choose',
  'what do you think',
  'what you think',
  'would you like',
  'want me to',
  'wait for you to',
  'your feedback',
  'your input on',
  'your thoughts',
  'please confirm',
  'please approve',
  'please authorize',
  'could you confirm',
  'can you confirm',
];
// Regex-ready phrases — joined VERBATIM into the regex source (NOT escaped).
// Used for entries needing word-boundary anchors or negative lookaheads to
// avoid substring-false-positives. Author MUST escape any regex metachars
// here (the escapeRe helper is applied only to AWAIT_USER_PHRASES, not here).
//   - '\\byour call\\b(?!back|able)' — HIGH: 'your call' matched 'your
//     callback' / 'your callable' (both common in JS/TS code-edit replies).
//   - 'waiting for you(?!r)' — HIGH: 'waiting for you' matched 'waiting for
//     your X' (because 'your' = 'you'+'r'). SAME FP class round-2 removed
//     on the bare-verb 'wait for you' side; the participle was missed.
//   - 'over to you(?!r)' — HIGH: 'over to you' matched 'hand over to your
//     team' / 'pass over to your reviewer' / 'forward over to your CI'.
//   - 'you pick(?!ed)' — MEDIUM: 'you pick' matched past-tense 'you picked'.
//   - 'you decide(?!d)' — MEDIUM: 'you decide' matched past-tense
//     'you decided' in CC code-review references to earlier user decisions.
// v0.2.6 round-3 LOW (escaping helper): escapeRe unlocks safe use of \b
// and lets future phrases include literal '?', '.', '+', etc. without
// silent regex corruption (a maintainer adding 'ok?' / 'config.json'
// would otherwise brick the joined regex).
const AWAIT_USER_PHRASES_RE = [
  '\\byour call\\b(?!back|able)',
  'waiting for you(?!r)',
  'over to you(?!r)',
  'you pick(?!ed)',
  'you decide(?!d)',
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const AWAIT_USER_RE = new RegExp(AWAIT_USER_PHRASES.map(escapeRe).concat(AWAIT_USER_PHRASES_RE).join('|'), 'i');

/**
 * v0.2.6 — Does Claude's final Stop-turn reply (last_assistant_message)
 * clearly await user input/decision/feedback? Used by the Stop case to
 * decide whether to set pending:true (reader renders blue dot + 🔵 counts).
 *
 * Strip fenced + inline code first (identifiers like `letMeKnow()` inside
 * samples must not false-trigger). Markdown bold/italic markers (* _) pass
 * through harmlessly (substring match). Empty/non-string → false (old CC
 * versions without the field simply skip this path → pending=false, the
 * historical Stop behavior).
 *
 * Returns true ONLY when the message clearly asks the user to act; a neutral
 * completion ("Done. Shipped in abc123.") returns false so the dot stays green.
 */
function lastMessageRequestsUserInput(msg) {
  if (typeof msg !== 'string' || !msg.trim()) return false;
  // Strip fenced code blocks (```...``` and ~~~...~~~), CommonMark indented
  // code blocks (4+ space / tab indent), and inline code (`...`) so code
  // samples containing identifiers like letMeKnow() cannot match.
  // v0.2.6 round-2: also strip ~~~ CommonMark alt-fence for completeness
  // (``` dominates CC output but the alternative is valid CommonMark).
  // v0.2.6 round-3 MEDIUM (indented blocks): a // or # line-comment inside
  // an indented block exposes its prose to AWAIT_USER_RE — strip those lines
  // first. Strips nested-list prose too, which is fine — user-directed
  // idioms are unlikely inside list items.
  // v0.2.6 round-3 MEDIUM (nested fences): backreference (`{3,})\1 handles
  // the legitimate nested-fence case where the outer fence is longer than
  // the inner (e.g. 4-backtick outer wrapping a 3-backtick demonstration).
  // The old /```[\s\S]*?```/ closed at the FIRST ``` (the inner fence's
  // opening), leaking the inner content into the prose pass. CommonMark
  // forbids same-length nested fences, so the backreference is correct.
  // v0.5.2 (#1 blue→yellow flash, round-2): the report-closer body-length
  // gate now covers the IDIOM path too, not only the fallback. A long
  // research/progress report whose trailing line is a SOFT feedback-ask /
  // continuer idiom ("want me to continue?" / "let me know." / "your
  // thoughts?") must NOT light blue — those close reports just as well as
  // they ask a blocking question. HARD decision/confirmation idioms (please
  // confirm / could you confirm / you choose / your decision / … and ALL ZH
  // idioms, which never match the EN-only SOFT regex below) still win
  // regardless of body length. The threshold is shared with the fallback.
  const REPORT_CLOSER_BODY_CHARS = 120;
  // EN SOFT feedback-ask / continuer idioms — subject to the report-closer
  // body gate when NO HARD idiom co-occurs. ZH idioms never match here so
  // they always win (the report-closer FP class is EN-only in practice; ZH
  // 决定/确认/选 markers are high-precision per v0.2.6 round-2/3).
  const SOFT_IDIOM_RE =
    /(want me to|let me know|your thoughts|your feedback|your input on|what do you think|what you think|would you like|your take|your move|wait for you to)/i;
  // EN HARD decision / confirmation idioms — always a blocking wait. When a
  // HARD idiom co-occurs with a SOFT one in the same message, HARD wins.
  const HARD_IDIOM_RE =
    /(please confirm|please approve|please authorize|could you confirm|can you confirm|you choose|your decision|your choice|your pick|your call|you pick|you decide)/i;
  const s = msg
    .replace(/^(?: {4}|\t).*$/gm, ' ')
    .replace(/(`{3,})[\s\S]*?\1/g, ' ')
    .replace(/(~{3,})[\s\S]*?\1/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  if (AWAIT_USER_RE.test(s)) {
    // SOFT-only (a soft idiom AND no hard idiom) → apply the same report-
    // closer body-length gate as the fallback below. Anything else (hard
    // idiom, ZH idiom, or a soft+hard co-occurrence) wins unconditionally.
    if (SOFT_IDIOM_RE.test(s) && !HARD_IDIOM_RE.test(s)) {
      const lastIdiom = s.trim().split(/\n+/).pop() || '';
      const bodyBeforeIdiom = s.trim().length - lastIdiom.length;
      if (bodyBeforeIdiom > REPORT_CLOSER_BODY_CHARS) return false;
    }
    return true;
  }
  // Fallback: short standalone question to the user (ZH/EN). Catches
  // "需要继续吗？" / "Should I proceed?" not covered by an idiom above.
  // Length gate (<=60 chars) avoids rhetorical Qs inside long expositions.
  // v0.2.6 round-2 semantic-anchor gate: require a user pronoun (你/您/you)
  // OR an action verb (继续/确认/选/决定/proceed/confirm/choose/need/want/
  // should I) so rhetorical/informational questions common in LLM design
  // exposition ("Why?", "什么意思?", "效果如何?", "How does this work?",
  // "What did the refactor break?") don't false-trigger. A bare "?" ending
  // is no longer sufficient — the question must clearly direct the user
  // to act/answer.
  //
  // v0.5.2 (#1 blue→yellow flash): split the markers into HARD (user-
  // directed / decision / confirmation — high precision, win REGARDLESS of
  // preceding body length) vs SOFT continuers (bare 继续/需要/想要/proceed/
  // continue/need/want — low precision: "要不要继续？" / "需要继续吗？" /
  // "是否继续？" match a long RESEARCH-REPORT closer just as well as a
  // genuine blocking question). When the prose BEFORE the trailing question
  // line exceeds REPORT_CLOSER_BODY_CHARS AND only a SOFT continuer matched,
  // treat the question as a report closer → false (no pending, no blue-dot
  // flash on the tab). HARD markers (你/您/you/确认/决定/选/should I/shall I/
  // can you/could you/may I) win regardless of body length, preserving
  // §AA.3/§AA.7/§AA.8 + the standalone "需要继续吗？" short-body design intent.
  // The idiom list (AWAIT_USER_RE above) is UNTOUCHED — this scopes ONLY the
  // fallback path the user's "调研报告 + 要不要继续" case actually hits (the
  // idiom list contains NO 要不要/是否继续 entry, so that case falls through
  // to here). bare confirm/choose are dropped from the fallback because their
  // common forms (please confirm / could you confirm / you choose) are already
  // covered by AWAIT_USER_PHRASES — keeping them here would only re-expose the
  // report-closer class the SOFT gate now suppresses.
  const last = s.trim().split(/\n+/).pop() || '';
  if (last.length > 60 || !/[？?]\s*$/.test(last)) return false;
  const HARD_DIRECTED_RE = /(你|您|you|确认|决定|选|should i|shall i|can you|could you|may i)/i;
  if (HARD_DIRECTED_RE.test(last)) return true;
  const SOFT_CONTINUE_RE = /(继续|需要|想要|proceed|continue|need|want)/i;
  if (!SOFT_CONTINUE_RE.test(last)) return false;
  // Report-closer exclusion: a long body preceding the trailing question is
  // strong evidence the question is a polite "要不要继续?" appended to a
  // research/progress report, not a blocking wait. bodyBefore is the byte
  // length of all prose before the last newline-separated line (includes the
  // newlines themselves — slightly over-estimates, which is conservative in
  // the right direction: more likely to classify as report → false).
  // REPORT_CLOSER_BODY_CHARS is hoisted to the top of this function (shared
  // with the idiom-path gate above).
  const bodyBefore = s.trim().length - last.length;
  if (bodyBefore > REPORT_CLOSER_BODY_CHARS) return false;
  return true;
}

/**
 * Count of in-flight background tasks carried by the payload (CC v2.1.145+:
 * Stop / SubagentStop ship `background_tasks[]` scoped to the parent session).
 * Returns null when the field is absent (old CC version / event without it),
 * meaning "no authoritative signal — fall back to activeSubagents bookkeeping".
 */
function inflightFromPayload(payload) {
  return Array.isArray(payload && payload.background_tasks) ? payload.background_tasks.length : null;
}

/**
 * Map a parsed hook payload to a status object (read-modify-write, hybrid).
 *   - Method B (primary): prefer the authoritative `background_tasks.length`
 *     from the payload when present — zero counting, zero drift, covers every
 *     background type (workflow / subagent / teammate / …).
 *   - Method A (fallback / early signal): maintain `activeSubagents` across
 *     SubagentStart/SubagentStop so the dot turns yellow the moment a subagent
 *     is spawned (before the first Stop), and old CC versions (< v2.1.145)
 *     still get reasonable behavior. B periodically overrides A, and the count
 *     is clamped at 0, so any drift is bounded and has no functional effect
 *     (the reader never reads activeSubagents).
 *
 * `cur` is the currently-on-disk status (defaulted on missing/corrupt file).
 *
 * Field-name note (v2): `activeSubagents` is a v0.x name retained on disk for
 *   IPC-shape backward compatibility. Since v2 / STATES.md §5 it is
 *   AUTHORITATIVELY OVERWRITTEN by `payload.background_tasks.length` on every
 *   event that carries it (Stop / SubagentStop), so its semantics are "any
 *   in-flight background task", not just subagents. The reader never reads it,
 *   so a rename would be a breaking IPC change for zero benefit — keep the
 *   name, read the comment.
 *
 * Returns:
 *   - { state, since, error?, activeSubagents } -> write it (atomic)
 *   - null                                      -> ignore this event (don't write)
 *   - DELETE                                    -> remove the session's status file
 */
function deriveStatus(payload, cur, now) {
  const event = payload.hook_event_name;
  const inflight = inflightFromPayload(payload);
  // Clamp non-finite AND negative to 0 — a corrupt/hand-edited file must not
  // propagate a negative counter (SubagentStart would then write a+1 = -N+1,
  // persisting the negative across events). See STATES.md §3 "activeSubagents:
  // <int> (>= 0)".
  const a = Number.isFinite(cur && cur.activeSubagents) && cur.activeSubagents >= 0 ? cur.activeSubagents : 0;

  switch (event) {
    // A new turn just began: CC is working on the user's prompt.
    // Correct activeSubagents from the authoritative payload if available;
    // otherwise reset to 0 — a prior turn's drift must NOT bleed into the new
    // turn (Stop is the authority on whether work remains, not this counter).
    // state is running regardless. Also CLEAR any inherited pending flag: a new
    // user prompt means the user has answered whatever Notification was blocking
    // (permission/question/elicit), so the 🔵 commandCenter light should go off.
    case 'UserPromptSubmit':
      return { state: 'running', since: now, activeSubagents: inflight != null ? inflight : 0, pending: false };

    // Heartbeat: keep CC marked running and refresh the timestamp.
    // activeSubagents writeback follows the same rule as UserPromptSubmit:
    // authoritative payload wins, else 0 (don't carry drift across events).
    // Also CLEAR pending — tool-use heartbeat means the user answered the
    // Notification prompt and the turn is making progress again.
    case 'PreToolUse':
    case 'PostToolUse':
      return { state: 'running', since: now, activeSubagents: inflight != null ? inflight : 0, pending: false };

    // Early signal: a subagent was just spawned — turn yellow immediately,
    // before the first Stop. Prefer the authoritative count, else increment.
    // PRESERVE cur.pending (do NOT clear): a subagent spawning is a BACKGROUND
    // event with no signal about whether the parent's permission/question/elicit
    // prompt is still open. Clearing pending here would false-negative the 🔵
    // commandCenter light if SubagentStart fires while a Notification prompt is
    // open on the parent (subagent workflows routinely spawn helpers mid-prompt).
    // Only user/turn-driven events (UserPromptSubmit / Pre/PostToolUse / Stop /
    // StopFailure) genuinely clear pending — those reflect the user having
    // answered. cur.pending defaults to false when there is no prior file, so
    // the no-prior-file path is unchanged.
    case 'SubagentStart':
      return {
        state: 'running',
        since: now,
        activeSubagents: inflight != null ? inflight : a + 1,
        pending: cur.pending === true,
      };

    // A subagent finished. Prefer the authoritative count, else decrement
    // (clamped at 0). If tasks remain, stay running; otherwise do NOT
    // preempt — let Stop decide the terminal state (null = no write).
    // PRESERVE cur.pending (do NOT clear): same rationale as SubagentStart —
    // a subagent finishing is a BACKGROUND event and carries no signal about
    // whether the parent's prompt is still open. A subagent wrapping up while
    // the parent is showing a Notification would otherwise extinguish the 🔵
    // light until the next Notification/user event fires.
    case 'SubagentStop': {
      const next = inflight != null ? inflight : Math.max(a - 1, 0);
      // Bound the fallback state to writer-emitted values ONLY. cur may carry
      // 'idle' (default cur on missing/corrupt file, or a hand-edited file) —
      // the writer contract (file header) says we only write
      // running | done | interrupted, so never persist 'idle'. 'idle' is a
      // reader-inferred state (no file / done > 5 min), not something we paint.
      const curState =
        cur && (cur.state === 'running' || cur.state === 'done' || cur.state === 'interrupted') ? cur.state : 'running';
      // Round-2 business-logic fix: refresh since=now ONLY on a genuine state
      // TRANSITION into running. The previous implementation refreshed since
      // whenever curState was 'running' (i.e. mid-turn SubagentStop), which
      // reset the per-tab tooltip's 'Turn running: Xs' metric (Date.now() -
      // tj.since) back to ~0s on every SubagentStop fire. A turn that ran 5
      // minutes showed <30s the entire time. The invariant is now: since is
      // the most-recent time the state TRANSITIONED to running (terminal→
      // running), never touched while staying in running.
      //
      // R3 data-logic fix retained: the guard previously accepted
      // `typeof cur.since === "number"` so a hand-edited / corrupt file with
      // cur.since=0 would be preserved indefinitely — and the reader's
      // `since && (now-since>DONE_TO_IDLE_MS)` tick is falsy for 0, so the
      // file NEVER decayed to idle, permanently stuck as terminal green/red.
      // Mirror Notification's strict `> 0` guard (see curSince below) —
      // cur.since=0 only arises from a corrupt file (the writer never
      // produces it via Date.now()).
      //
      // preserveSince now covers TWO cases:
      //   (a) staying in running (curState === 'running', regardless of next)
      //       — mid-turn heartbeat must not touch since;
      //   (b) terminal AND next===0 (no state transition) — preserve the
      //       reader's notify-dedup key + done→idle countdown.
      // It does NOT fire when curState is terminal AND next>0 — that is a
      // genuine terminal→running transition and since=now is correct.
      const preserveSince =
        cur &&
        typeof cur.since === 'number' &&
        cur.since > 0 &&
        (curState === 'running' || ((curState === 'done' || curState === 'interrupted') && next === 0));
      // Preserve cur.error too when we are keeping an interrupted state: an
      // orphan SubagentStop arriving AFTER StopFailure already wrote
      // {state:'interrupted', error:'tool_blocked'} would otherwise rewrite
      // the file as {state:'interrupted'} and silently drop the error enum
      // (STATES.md §4b surfaces that enum in the user-visible notification).
      // Only carried over when we are preserving the FULL interrupted state
      // (preserveSince=true AND curState==='interrupted'); any path that
      // flips state or refreshes since also drops error (matches
      // StopFailure's role as the SOLE writer of the error field).
      const preserveError = preserveSince && curState === 'interrupted' && typeof cur.error === 'string' && cur.error;
      // Always persist the decremented count. Returning null would leave a stale
      // activeSubagents on disk and mislead the following Stop into running.
      return {
        state: next > 0 ? 'running' : curState,
        since: preserveSince ? cur.since : now,
        ...(preserveError ? { error: cur.error } : {}),
        activeSubagents: next,
        pending: cur.pending === true,
      };
    }

    // CC Notification hook (permission / question / elicit prompt). NEW in
    // v0.1.13 — feeds the 🔵 commandCenter light. Mark `pending:true` while
    // PRESERVING cur.state and cur.since: Notification can fire on any state
    // (typically running — a turn paused on a permission prompt), and the
    // reader counts pending INDEPENDENTLY of state, so we must NOT mutate the
    // underlying state machine. The next non-Notification event clears the
    // flag (every other case below writes pending:false). If cur is the
    // default (no prior file — Notification can be the first event a new
    // session emits), default to running + since=now so the reader sees a
    // coherent file. The default-state rule mirrors SubagentStop's
    // curState-bound check: never persist 'idle'.
    //
    // CASE-ORDER NOTE (v0.1.13 review fix): this case is positioned between
    // SubagentStop and Stop to match HOOK_EVENTS (patch.ts:217-227) and
    // STATES.md §2 — the three-way "mechanical sync" audit should read as a
    // straight line-by-line comparison across all three sources. Earlier
    // revisions had it after StopFailure (functional no-op since cases are
    // independent with no fall-through, but it defeated the documented sync
    // contract). The SET of cases is unchanged; only the position moved.
    //
    // preserveError mirror (data-logic round-2 audit fix): when the session
    // is ALREADY interrupted (StopFailure previously wrote
    // {state:'interrupted', error:'tool_blocked', ...}), a Notification
    // arriving on the SAME session must NOT silently drop the error enum —
    // this case preserves cur.state and cur.since verbatim, so it must also
    // preserve cur.error for symmetric parity with SubagentStop's
    // preserveError guard above. Without this, writeJsonAtomic would
    // atomically overwrite the file with {state:'interrupted', since:T0,
    // pending:true} (no error), and the reader's notify() (patch.ts:
    // `err=j.error||""`) would surface generic "interrupted" wording instead
    // of the specific failure reason. STATES.md §4b's "diagnostic value
    // preserved" contract depends on this symmetry.
    case 'Notification': {
      const curState =
        cur && (cur.state === 'running' || cur.state === 'done' || cur.state === 'interrupted') ? cur.state : 'running';
      const curSince = cur && typeof cur.since === 'number' && cur.since > 0 ? cur.since : now;
      const preserveError = curState === 'interrupted' && typeof cur.error === 'string' && cur.error;
      // v0.5.3 (business-logic MEDIUM): suppress pending when curState is
      // already 'interrupted', mirroring the Stop case's preserveInterrupted
      // design (cc-status.js Stop handler + the rationale stamped there:
      // 'interrupted already dominates pending for SBI counting ... a blue dot
      // on top of a red one would mislead. Keep the red sticky.'). Pre-fix this
      // branch wrote pending:true unconditionally, so a Notification (permission
      // prompt) firing on an already-interrupted session overwrote the sticky
      // red and the per-tab tick rendered BLUE (patch.ts IIFE.12a:
      // `if(pend && st!=='idle')` fires before the interrupted branch). The
      // Stop handler deliberately suppresses pending on preserveInterrupted to
      // avoid exactly that blue-on-red flash; this aligns Notification with
      // that invariant. curState==='running'/'done' still gets pending:true
      // (the common permission-prompt path is unchanged).
      const suppressPending = curState === 'interrupted';
      return {
        state: curState,
        since: curSince,
        ...(preserveError ? { error: cur.error } : {}),
        activeSubagents: a,
        pending: !suppressPending,
      };
    }

    // Turn completed normally. State is decided by the AUTHORITATIVE payload
    // count ONLY: inflight>0 (a workflow still running in the background) ->
    // running; otherwise done — including when the payload omits
    // background_tasks entirely (inflight=null). We do NOT fall back to the
    // on-disk activeSubagents counter here: that counter can drift (e.g. a
    // SubagentStart with no matching SubagentStop leaves a stale positive
    // count) and would make an already-finished turn false-stick at running
    // (bug e434c0a2). Clear the residual instead. `null > 0` is false so the
    // single comparison covers inflight=null, 0, and N>0 correctly. Also CLEAR
    // pending — a finished turn is no longer waiting on user input.
    //
    // Round-2 business-logic fix: when inflight>0 keeps state='running' AND
    // cur was already 'running' (typical: a workflow still spinning after the
    // main user-facing Stop), preserve cur.since instead of writing now.
    // Refreshing since on every Stop heartbeat reset the per-tab tooltip's
    // 'Turn running: Xs' metric to ~0s whenever a workflow outlived the main
    // turn, hiding how long the turn had been active. A genuine *→running
    // transition (cur was done/interrupted, workflow re-arms running) still
    // refreshes since=now. cur.since=0 (corrupt file) falls through to now,
    // same defensive rule as SubagentStop.
    case 'Stop': {
      const stayRunning = inflight > 0;
      const curState =
        cur && (cur.state === 'running' || cur.state === 'done' || cur.state === 'interrupted') ? cur.state : 'running';
      const preserveSince = stayRunning && curState === 'running' && typeof cur.since === 'number' && cur.since > 0;
      // v0.2.7 (Q2 interrupted sticky): when the session is ALREADY interrupted
      // (StopFailure wrote {state:'interrupted', error:...} earlier in this same
      // turn), a subsequent Stop MUST NOT overwrite it with done. The user's
      // semantic is "interrupted stays red until I send a new prompt" — only
      // UserPromptSubmit clears red (genuine session continuation). CC's anti-
      // loop gate / stop_hook_active / delayed Stop from the failed turn would
      // otherwise silently clear the 🔴 light the moment the user looks away.
      // Mirrors SubagentStop's curState==='interrupted' && next===0 preserve
      // rule (cc-status.js:527-531) for symmetry. inflight>0 still allows the
      // terminal→running transition because a live subagent genuinely un-blocks
      // the turn (rare path; reader shows 🟡 yellow instead of 🔴 red — correct
      // because the user can now see "the workflow is making progress"). Also
      // preserve cur.error to surface the specific failure reason in §4b
      // (mirrors SubagentStop preserveError cc-status.js:541).
      const preserveInterrupted = curState === 'interrupted' && !stayRunning;
      // v0.2.6 blue-via-content: if Claude's final reply clearly awaits user
      // input/decision/feedback ("等你测试反馈" / "let me know" / "please
      // confirm" / short standalone question to user), write pending:true so
      // the reader's per-tab tick renders the blue pending dot AND the bottom
      // SBI 🔵 counts it. Done/green logic untouched when the message is
      // neutral ("Done. All tests pass.") → pending:false (the historical
      // behavior). Skip when stop_hook_active=true (CC's anti-loop gate: Stop
      // hook firing on its own continuation leaves an empty/stale message).
      // Stuck-running scenario (luceo): stayRunning=true (background_tasks
      // drift) + message "等你测试反馈" → state='running' AND pending=true →
      // reader tick renders blue (pending branch wins over running yellow).
      // v0.2.7: pending is suppressed on preserveInterrupted — interrupted
      // already dominates pending for SBI counting (§7 aggregation decays
      // interrupted→idle but does NOT promote interrupted→pending), so a blue
      // dot on top of a red one would mislead. Keep the red sticky.
      const lam = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : '';
      const awaitsUser =
        !preserveInterrupted && !payload.stop_hook_active && !!lam && lastMessageRequestsUserInput(lam);
      return {
        state: preserveInterrupted ? 'interrupted' : stayRunning ? 'running' : 'done',
        since:
          preserveInterrupted && cur && typeof cur.since === 'number' && cur.since > 0
            ? cur.since
            : preserveSince
              ? cur.since
              : now,
        ...(preserveInterrupted && cur && typeof cur.error === 'string' && cur.error ? { error: cur.error } : {}),
        activeSubagents: inflight != null ? inflight : 0,
        pending: awaitsUser,
      };
    }

    // Turn was aborted/interrupted; preserve the failure reason enum.
    // Interrupt wins regardless of subagent count. The displayed count is
    // derived symmetrically with the Stop case: prefer the authoritative
    // payload `background_tasks.length` when present (CC v2.1.145+), else
    // fall back to the on-disk cur value.
    //
    // Round-2 business-logic fix: previously this case ignored the payload
    // and wrote `activeSubagents: a` (cur — possibly drifted) unconditionally,
    // while the sibling Stop case explicitly preferred the payload ("payload
    // is the ONLY authority at Stop"). The asymmetry meant a drifted cur
    // counter (SubagentStart with no matching SubagentStop, or a cross-
    // process RMW lost update) was frozen into the interrupted file for the
    // full INTERRUPTED_RETENTION_MS (24h) window. The reader does not read
    // this field today so the change is a no-op functionally, but it removes
    // a latent inconsistency and matches the documented payload-authority
    // invariant. StopFailure still clears pending — an interrupted turn is
    // not awaiting user input.
    // Force error to a string (STATES.md §3 "error?: '<StopFailure enum>'"):
    // payload.error may be a non-string truthy (number/array/object) on a
    // broken/malformed payload, which would JSON.stringify to "[object Object]"
    // and surface as an unreadable notification. Default 'interrupted' (not
    // 'unknown') matches the reader IIFE's own fallback wording so writer and
    // reader agree on the message shown for missing error enums.
    case 'StopFailure':
      return {
        state: 'interrupted',
        since: now,
        error: typeof payload.error === 'string' && payload.error ? payload.error : 'interrupted',
        activeSubagents: inflight != null ? inflight : a,
        pending: false,
      };

    // Session is over: clean up its status file.
    // v0.2.7 (Q2 interrupted sticky): when the session is in the interrupted
    // state (StopFailure wrote it earlier), SessionEnd MUST NOT delete the
    // file — research noted interrupted is mostly a CRASH path (no SessionEnd
    // fires), but defensive preservation closes the gap for the case where CC
    // sends both StopFailure AND SessionEnd (e.g. forced exit mid-failure).
    // The user semantic: interrupted stays 🔴 red until they send a new prompt
    // (UserPromptSubmit → running, session continues). Deleting here would
    // silently clear the red the moment CC's session-close event arrives,
    // defeating the sticky contract. Returning null (instead of DELETE) keeps
    // the existing <sid>.json on disk untouched; the reader keeps rendering 🔴
    // for the full INTERRUPTED_RETENTION_MS (7d) window. Any other state
    // (running/done/pending) still goes through the normal DELETE cleanup.
    case 'SessionEnd':
      if (cur && cur.state === 'interrupted') {
        return null;
      }
      return DELETE;

    // v0.2.9 (Q4 compact-clear): CC finished /compact (or auto-compact).
    // /compact aborts the in-flight turn → CC fires StopFailure (the SOLE
    // interrupted writer) → without this clear, Q2's preserveInterrupted
    // branch in Stop keeps the 🔴 sticky until the next UserPromptSubmit.
    // Compact is NOT a real failure (the user explicitly invoked it; the
    // session continues with a compacted transcript) — clear interrupted
    // → done. Preserve running/done/pending untouched (compact is a no-op
    // for those): a running session compacted mid-turn will get its next
    // state from the upcoming Stop/UserPromptSubmit; a done session stays
    // done. Mirrors UserPromptSubmit's "session continues" semantic but
    // for the compact-resume path. Only acts when cur.state is interrupted
    // — the case we are correcting. A real rate_limit/overloaded
    // StopFailure NOT followed by PostCompact stays interrupted (Q2 7d
    // sticky intact — see test §Q.3). pinned by test-cc-status.js §Q.1-3.
    case 'PostCompact':
      if (cur && cur.state === 'interrupted') {
        return {
          state: 'done',
          since: now,
          activeSubagents: inflight != null ? inflight : a,
          pending: false,
        };
      }
      return null;

    default:
      return null;
  }
}

// ----------------------------------------------------------------------------
// Hoisted constants + pure helpers — v0.2.4 architecture cleanup.
// These have NO closure dependencies on main() (no fs/path/os, no module-
// scoped mutable state). All pure helpers with no closure dependencies on
// main() live here: matchRate / costForEntry / foldBuckets / deriveTokensField
// were hoisted in the same v0.2.4 round (the prior "follow-up will hoist"
// comment was aspirational; the hoist has shipped). Direct unit-test coverage
// of these helpers runs through the end-to-end writer tests (test-cc-status.js
// §N/§T exercise matchRate + foldBuckets via real transcript-driven fires).
// ----------------------------------------------------------------------------

const TOK_OFFSET_EXT = '.offset';
const TOK_FORCEREREAD_EXT = '.forcereread'; // QuickPick "Reset session stats" marker
// v0.2.7 (Q1 fix): independent token-snapshot file for the IIFE reader. The
// hook writes <sid>.tokens.json on every TOK_EVENT fire alongside <sid>.json,
// carrying the SAME tokens field deriveTokensField produced + a thin envelope
// (v/sid/since/cwd/transcript_path/written_at) so the IIFE can render a
// non-zero token count IMMEDIATELY after a VSCode restart (SessionStart) —
// without it, SessionEnd deletes <sid>.json (the only place tokens used to
// live), SessionStart writes a fresh <sid>.json with no tokens, and the SBI
// reads 0 until the next TOK_EVENT fire pre-warms the 256KB tail (giving only
// tail-slice totals, not cumulative). See STATES.md §8.7 v0.2.7 update.
const TOK_TOKENS_EXT = '.tokens.json';
const TOK_BUCKETS_MAX = 1000;
const TOK_TURNS_MAX = 400;
const TOK_BUCKET_MS = 5 * 60 * 1000; // 5min folding window (first progressive stage)
const TOK_BUCKET_HR_MS = 60 * 60 * 1000; // 1h folding window (second stage)
const TOK_BUCKET_DAY_MS = 24 * 60 * 60 * 1000; // 1d folding window (third stage)
const TOK_TAIL_PRESET_BYTES = 256 * 1024; // first-fire tail pre-warm slice
// v0.2.4 (code-style LOW fix): bug-9188 stale-sid mitigation threshold
// (file mtime older than srcView.lastTs by >60s + no growth = skip read).
// Previously a bare 60000 literal inline at the dedup check below; named
// now so a future tuning edit (e.g. 30s/120s) hits ONE site and reads
// clearly. Symmetric in spirit to GC_TMP_AGE_MS — both are "how stale
// before we act" knobs.
const BUG_9188_STALE_MS = 60 * 1000;
// v0.2.4 (code-style LOW fix): Anthropic prompt-caching default ratios
// used when token-rates.json omits the cacheRead/cacheCreate5m/cacheCreate1h
// fields. Previously three bare literals (0.1 / 1.25 / 2) inline in
// costForEntry — Anthropic-pegged, so a future cache-pricing change would
// have to be hunted across three sites. Named now so the rate-table
// _comment can refer to "the named consts" and a tuning edit is one-shot.
// Cache-read is debited at 0.1× the input rate; cache-create-5m at 1.25×;
// cache-create-1h at 2× (Anthropic prompt-caching public pricing ratios).
const CACHE_READ_RATIO = 0.1;
const CACHE_CREATE_5M_RATIO = 1.25;
const CACHE_CREATE_1H_RATIO = 2;
// v0.2.4 (code-style LOW fix): finite-or-default helper used three times
// in costForEntry (and once for rIn/rOut with a different default). Tiny
// extraction — drops 3 repetitions of the `r.X != null && Number.isFinite
// (r.X) ? r.X : DEFAULT` pattern, so a stricter future check (e.g.
// `typeof v === 'number'`) lands in one place.
function finiteOr(v, fallback) {
  return v != null && Number.isFinite(v) ? v : fallback;
}
// v0.2.4 (code-style MEDIUM fix): define TOK_WIN_KEYS as the single source
// of truth for the 8-window insertion order. Mirrors patch.ts IIFE's
// `TOK_WIN_KEYS` const (kept in lockstep — the writer is a standalone .js
// script that cannot import from the ESM patcher, so each side holds a
// copy; the test-version-sync.mjs §R test extracts both TOK_WIN_KEYS
// literals via regex and pins the literal sequence so drift fails CI).
// deriveTokensField iterates TOK_WINDOWS via Object.keys — insertion order
// is what the IIFE QuickPick + the docstring below document. The 3d key
// MUST sort between 24h and 7d (chronological), which it now does. Pre-fix
// it appeared after 30d (non-monotonic), which made Object.keys(TOK_WINDOWS)
// emit ['5min','10min','1h','24h','7d','30d','3d','all'] — sidecar JSON's
// cost_<window> fields inherited the same non-monotonic order, breaking the
// documented 5min..all progression.
const TOK_WIN_KEYS = ['5min', '10min', '1h', '24h', '3d', '7d', '30d', 'all'];
const TOK_WINDOWS = {
  '5min': 5 * 60 * 1000,
  '10min': 10 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  all: Infinity,
};

function zeroTotals() {
  return { in: 0, out: 0, cr: 0, cc5: 0, cc1: 0, cci: 0 };
}

function addInto(dst, src) {
  dst.in += src.in || 0;
  dst.out += src.out || 0;
  dst.cr += src.cr || 0;
  dst.cc5 += src.cc5 || 0;
  dst.cc1 += src.cc1 || 0;
  dst.cci += src.cci || 0;
}

// globMatch — minimal `*` wildcard match (token-rates.json keys like
// "claude-sonnet-*"). Returns true on match. Trivial but sufficient — keys
// are simple prefixes with optional trailing `*`.
function globMatch(glob, s) {
  if (glob === s) return true;
  if (!glob.includes('*')) return false;
  const parts = glob.split('*');
  if (parts.length === 2) {
    const [pre, post] = parts;
    return s.startsWith(pre) && s.endsWith(post) && s.length >= pre.length + post.length;
  }
  // General case: walk.
  let idx = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i === 0) {
      if (!s.startsWith(parts[i])) return false;
      idx = parts[i].length;
      continue;
    }
    const next = parts[i];
    if (next === '') continue;
    const found = s.indexOf(next, idx);
    if (found < 0) return false;
    idx = found + next.length;
  }
  return true;
}

function matchRate(model, rates) {
  if (!model) return rates._default || null;
  // v0.2.4 follow-up (round-2 business-logic fix): previously this returned
  // the FIRST glob in insertion order that matched — so a maintainer adding
  // a version-specific override (e.g. `claude-sonnet-5*`) AFTER the family
  // catch-all (`claude-sonnet-*`) would have the new entry silently shadowed.
  // Now sort candidate matches by SPECIFICITY (longest non-wildcard prefix
  // wins) so the most specific applicable glob always wins regardless of
  // JSON ordering. Falls through to _default only when no glob matches.
  let bestKey = null;
  let bestScore = -1;
  for (const k of Object.keys(rates)) {
    if (k === '_default') continue;
    if (!globMatch(k, model)) continue;
    // Specificity = length of the literal (non-`*`) portion of the glob.
    // `claude-sonnet-5*` (15 chars) beats `claude-sonnet-*` (13 chars)
    // beats `claude-*` (7 chars). Ties keep the first-seen insertion order
    // (stable: only strictly greater scores replace).
    const score = k.replace(/\*/g, '').length;
    if (score > bestScore) {
      bestScore = score;
      bestKey = k;
    }
  }
  return bestKey !== null ? rates[bestKey] : rates._default || null;
}

function costForEntry(entry, r) {
  if (!r) return 0;
  // NaN guard: a hand-edited token-rates.json missing 'in' (or any numeric
  // field) would propagate NaN through every downstream cost sum, and the
  // IIFE's fmtUsd silently hides NaN (""). Coerce non-finite inputs to 0 so
  // a malformed rate entry degrades gracefully instead of making cost
  // silently disappear across the WHOLE session.
  const rIn = finiteOr(r.in, 0);
  const rOut = finiteOr(r.out, 0);
  if (rIn === 0 && rOut === 0) return 0;
  const cacheRead = finiteOr(r.cacheRead, rIn * CACHE_READ_RATIO);
  const cacheCreate5m = finiteOr(r.cacheCreate5m, rIn * CACHE_CREATE_5M_RATIO);
  const cacheCreate1h = finiteOr(r.cacheCreate1h, rIn * CACHE_CREATE_1H_RATIO);
  const cciCost = (entry.cci || 0) * cacheCreate5m; // scalar cache_creation priced as 5m
  const cost =
    ((entry.in || 0) * rIn +
      (entry.out || 0) * rOut +
      (entry.cr || 0) * cacheRead +
      (entry.cc5 || 0) * cacheCreate5m +
      (entry.cc1 || 0) * cacheCreate1h +
      cciCost) /
    1_000_000;
  return Number.isFinite(cost) ? cost : 0;
}

// v0.2.4 (code-style MEDIUM fix): costTotalsUsd(totals, model, rates)
// deleted — it was the orphan of deriveTokensField's pre-v0.2.4 lastModel
// pricing path. The session cost is ALWAYS computed via costBucketsUsd
// (per-model, correctly handling mixed Sonnet/Opus sessions — see the
// docstring on costBucketsUsd below). costTotalsUsd had ZERO callers in
// the entire project (cc-status.js body + patch.ts IIFE + 4 test files).
// Removing it prevents future maintainers from re-introducing the
// lastModel pricing bug by reaching for the wrong helper. The dead
// `totals × lastModel rate` shape is explicitly documented as wrong in
// the costBucketsUsd docstring below.

// Sum cost across a list of buckets, looking up each bucket's model rate.
// Used for time-windowed cost AND session-total cost (different turns can
// use different models — pricing each bucket by its own model is the only
// way to get a correct mixed-model session total; using lastModel for the
// whole cumulative total was the v0.2.4 bug, overestimating Opus-then-
// Sonnet sessions by ~5x). Returns null when every bucket's model is
// unrated; returns a positive number when at least one bucket is rated
// (callers surface cost_partial=true via the parallel hasUnratedBuckets
// check so the IIFE can flag underestimation when some buckets skipped).
function costBucketsUsd(buckets, rates) {
  let total = 0;
  let any = false;
  for (const b of buckets) {
    const r = matchRate(b.model, rates);
    if (!r) continue;
    any = true;
    total += costForEntry(b, r);
  }
  return any ? total : null;
}

// True when ANY bucket's model has no rate entry (and _default is null).
// The IIFE uses this to append "(partial — some turns had no rate)" to the
// cost tooltip so the user knows the displayed $ is a lower bound.
function hasUnratedBuckets(buckets, rates) {
  if (!Array.isArray(buckets) || buckets.length === 0) return false;
  for (const b of buckets) {
    if (!matchRate(b.model, rates)) return true;
  }
  return false;
}

// v0.2.4 (data-logic + business-logic MEDIUM fix): the key is now
// `<window_floor>|<model>` instead of just `<window_floor>`. Previously
// a 5min window mixing Haiku+Opus rows folded into a single bucket
// priced at one model's rate (whichever was most-recent), producing cost
// errors up to 67% on mixed-model windows. Folding per-(window,model)
// keeps each model's pricing accurate at the cost of an O(distinct
// models per window) bucket-count increase (≤2x in practice — bounded).
// The ts is also now Math.max(byKey[key].ts, b.ts) instead of the window
// floor, so narrow-window aggregation (5min/10min) post-fold still
// reflects the actual latest activity in the window — floor-based ts
// previously over/under-counted narrow windows by treating the bucket
// as living at the window boundary instead of the latest sample.
function foldBuckets(buckets) {
  const granularities = [TOK_BUCKET_MS, TOK_BUCKET_HR_MS, TOK_BUCKET_DAY_MS];
  let folded = buckets;
  for (let g = 0; g < granularities.length; g++) {
    if (folded.length <= TOK_BUCKETS_MAX) break;
    const granularityMs = granularities[g];
    const byKey = Object.create(null);
    const result = [];
    for (const b of folded) {
      const floor = Math.floor(b.ts / granularityMs) * granularityMs;
      const key = floor + '|' + (b.model || '');
      // v0.2.4 round-2 (architecture NEW medium): track per-key src so fold
      // preserves the round-1 MAIN-reset preservation contract. Pre-fix the
      // seed omitted `src`, so progressive folding silently stripped the
      // field; the round-1 filter (`b.src && b.src !== 'main'`) then treated
      // every folded bucket as src===undefined → falsy → filtered OUT,
      // dropping ALL folded history on the next forceFull / size-shrink /
      // corrupt-sidecar recovery. Resolution: classify each input bucket as
      // 'main' (src==='main' or absent) or 'subagent' (any 'sub:*' tag), then
      // resolve the merged label after the loop:
      //   - all-main input      → 'main'      (filter drops on MAIN reset)
      //   - all-subagent input  → 'subagent'  (filter keeps)
      //   - mixed               → 'mixed'     (filter keeps; subagent
      //     preservation contract prioritizes "don't lose subagent data"
      //     over "drop every main byte on MAIN reset" — losing some main
      //     bytes from a mixed bucket is acceptable, losing subagent bytes
      //     is the round-1 bug).
      // The common case is pure-main or pure-subagent keys (a same-window
      // same-model main+subagent pair is rare); 'mixed' is the safe default.
      const bIsMain = !(b && b.src && b.src !== 'main');
      if (!byKey[key]) {
        byKey[key] = {
          ts: b.ts,
          in: 0,
          out: 0,
          cr: 0,
          cc5: 0,
          cc1: 0,
          cci: 0,
          model: b.model,
          // Seed with first-seen src; upgraded to 'mixed' below if a later
          // bucket brings a conflicting classification into the same fold key.
          src: bIsMain ? 'main' : 'subagent',
          // Tristate flag: null=only-main-seen, true=mixed, false=only-sub-seen.
          // After the loop we collapse to 'main' | 'subagent' | 'mixed'.
          seenMain: bIsMain,
          seenSub: !bIsMain,
        };
        result.push(byKey[key]);
      } else {
        if (bIsMain) byKey[key].seenMain = true;
        else byKey[key].seenSub = true;
      }
      addInto(byKey[key], b);
      // Keep the most-recent ts in the bucket (tie-break deterministic).
      // Model is stable per (window,model) key by construction.
      if (b.ts > byKey[key].ts) byKey[key].ts = b.ts;
    }
    // Finalize src labels: 'mixed' wins if both sides contributed (subagent
    // preservation contract — keep rather than drop). Pure-main → 'main',
    // pure-subagent → 'subagent'. The on-disk bucket shape keeps just `src`
    // (seenMain/seenSub flags are dropped) so readers (IIFE + tests) see the
    // same field set as a non-folded bucket.
    for (const r of result) {
      if (r.seenMain && r.seenSub) r.src = 'mixed';
      else if (r.seenSub) r.src = 'subagent';
      else r.src = 'main';
      delete r.seenMain;
      delete r.seenSub;
    }
    folded = result;
  }
  return folded;
}

/** Build the 8-window aggregates + per-window cost + session cost for the
 *  IIFE. Returns the tokens field shape:
 *  { total, windows:{5min,10min,1h,24h,3d,7d,30d,all}, cost, cost_partial,
 *    cost_5min, cost_10min, cost_1h, cost_24h, cost_3d, cost_7d, cost_30d,
 *    cost_all, last_ts, last_model, turn_count }.
 *  - cost = session-total via costBucketsUsd (per-model, correctly handles
 *    mixed Sonnet/Opus sessions — lastModel pricing was the v0.2.4 bug).
 *  - cost_partial = true when any bucket's model has no rate entry (the
 *    displayed $ is a lower bound — IIFE flags this in the tooltip).
 *  - cost_<window> = per-window cost (per-model via costBucketsUsd); the
 *    IIFE inline SBI reads cost_<tWin> for the selected window so the
 *    displayed token count and $ are from the SAME time scope.
 *  - turn_count = ctx.perTurn.length (post-FIFO cap). */
function deriveTokensField(ctx, rates, now) {
  if (!ctx) return null;
  const windows = Object.create(null);
  const costWindows = Object.create(null);
  for (const k of Object.keys(TOK_WINDOWS)) {
    const ms = TOK_WINDOWS[k];
    const cutoff = ms === Infinity ? -Infinity : now - ms;
    const sum = zeroTotals();
    const costBuckets = [];
    for (const b of ctx.buckets) {
      if (b.ts >= cutoff) {
        addInto(sum, b);
        costBuckets.push(b);
      }
    }
    windows[k] = sum;
    costWindows[k] = costBucketsUsd(costBuckets, rates);
  }
  // last_model = model of the chronologically-latest bucket (or perTurn tail).
  // Used for the tooltip's "Last model:" line ONLY — session cost now uses
  // per-bucket rates so this value does NOT affect cost calc (mixed-model
  // fix).
  //
  // v0.2.4 round-3 (business-logic MEDIUM fix): previously derived as
  // ctx.buckets[ctx.buckets.length - 1].model, which is the array tail. But
  // foldBuckets (L662-L735) produces FIRST-SIGHTING order per (window,model)
  // key — when distinct models interleave within a window, the tail reflects
  // the most-recent FIRST-sighting, NOT the model of the most-recent row.
  // Example: rows in order M2@t1, M1@t2, M2@t3 (same 5min window) yield
  // folded result [M2_bucket(seen@t1, ts=t3), M1_bucket(seen@t2, ts=t2)] —
  // tail was M1 even though the latest row was M2@t3. Tooltip's "Last model:"
  // was therefore wrong whenever models interleaved (cost unaffected: costBucketsUsd
  // uses per-bucket rates and the max ts inside each folded bucket is correct).
  // Fix: scan for the bucket with the maximum .ts. Ties (impossible across
  // distinct buckets under normal CC writes — two assistant rows with identical
  // millisecond timestamps don't both flush) resolve to first-seen order via >=.
  let lastModel = '';
  if (ctx.buckets.length > 0) {
    let maxTs = -Infinity;
    for (const b of ctx.buckets) {
      if (b && b.ts >= maxTs) {
        maxTs = b.ts;
        lastModel = b.model;
      }
    }
  } else if (ctx.perTurn.length > 0) {
    lastModel = ctx.perTurn[ctx.perTurn.length - 1].model;
  }
  // Session total cost via per-bucket per-model lookup. Mixed Sonnet/Opus
  // sessions now price each turn at its own model's rate (previously the
  // entire cumulative totals were priced at lastModel, overestimating
  // Opus-then-Sonnet by ~5x and underestimating the reverse). Falls through
  // to null when every bucket's model is unrated AND _default is null.
  const totalCost = costBucketsUsd(ctx.buckets, rates);
  const partial = hasUnratedBuckets(ctx.buckets, rates);
  const out = {
    total: ctx.totals,
    windows,
    cost: totalCost,
    cost_partial: partial,
    last_ts: ctx.lastTs,
    last_model: lastModel,
    turn_count: ctx.perTurn.length,
  };
  // Expose every window's cost as cost_<k> so the IIFE inline SBI can pick
  // the cost matching the selected window (token + cost from same scope).
  for (const k of Object.keys(TOK_WINDOWS)) {
    out['cost_' + k] = costWindows[k];
  }
  return out;
}

// ----------------------------------------------------------------------------
// Main — load modules, then act. All file I/O lives here so that any failure
// (including module loading) can be swallowed as a silent exit(0).
// ----------------------------------------------------------------------------

async function main() {
  // Dynamic import() works under both CommonJS and ESM, making the script
  // immune to package.json "type" settings. Bare specifiers ('fs' not
  // 'node:fs') maximize compatibility with older Node versions.
  let fs, os, path;
  try {
    [fs, os, path] = await Promise.all([import('fs'), import('os'), import('path')]);
  } catch {
    process.exit(0);
  }

  // One status file per session lives here. Named STATE_DIR to mirror patch.ts
  // (single shared path contract — grep lands both files with one token).
  const STATE_DIR = path.join(os.homedir(), '.claude', 'cc-tab-status');
  // v0.2.4: INSTALL_DIR mirrors patch.ts — token-rates.json (model→pricing table)
  // lives here so users can hot-edit prices without re-running the patcher.
  const INSTALL_DIR = path.join(os.homedir(), '.claude', 'cc-status-dot');
  const RATES_PATH = path.join(INSTALL_DIR, 'token-rates.json');

  /**
   * Atomically write `obj` as JSON to `filePath`.
   * Writes a sibling .tmp file first, then renames over the target so a
   * reader never observes a half-written file.
   *
   * Concurrency: the tmp name is suffixed with `process.pid + Date.now()` so
   * two hook processes racing on the same session (e.g. SubagentStart and
   * PreToolUse firing in the same ms window from a multi-subagent workflow)
   * do NOT share the same `<sid>.json.tmp` path. POSIX O_TRUNC by B over
   * A's in-progress writes would otherwise interleave two JSON payloads into
   * the same tmp and "promote" whichever rename fires first — breaking the
   * atomic-write contract. The pid suffix does NOT fix the read-modify-write
   * lost-update on `activeSubagents` (see STATES.md §5 known limitation); it
   * only guarantees each rename carries one process's complete JSON.
   */
  const writeJsonAtomic = (filePath, obj) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, filePath);
  };

  // --- v0.2.4: Token stats helpers ---------------------------------------------
  // All token logic lives INSIDE main() (after dynamic import) so it shares the
  // already-loaded fs/path/os modules. The pipeline:
  //   1. readTranscriptIncremental(sid, transcriptPath, source, opts) — byte-
  //      offset incremental read of the CC jsonl. Per-source offset state
  //      (source='main' for parent transcript, source='sub:<agentId8>' for
  //      SubagentStop agent transcripts) so the two reads NEVER share a byte
  //      offset (critical: previously both used ctx.offset, so SubagentStop
  //      could reset the parent's cumulative totals or be silently dropped by
  //      bug-9188 dedup). Skips sidechain rows in the parent transcript
  //      (subagent rows are counted via agent_transcript_path on SubagentStop
  //      so we don't double-count). Handles the cache_creation dual form
  //      (scalar glm-5.2 / object Anthropic — object form wins when both are
  //      present to prevent ~2x double-counting during Anthropic's legacy
  //      transition window) and CC bugs #41310 (early-fire, transcript
  //      absent) + #9188 (stale sid).
  //   2. foldBuckets(buckets) — progressive fold 5min → 1h → 1d when count
  //      exceeds TOK_BUCKETS_MAX, so long sessions (months of use) keep the
  //      per-tick aggregation cost bounded instead of growing unbounded.
  //   3. deriveTokensField(ctx, rates, now) — fold buckets into 8 windows
  //      (5min/10min/1h/24h/3d/7d/30d/all). All 8 are user-selectable in the
  //      IIFE QuickPick and each gets a cost_<window> field.
  //   4. loadRates() — read token-rates.json (single call per hook fire; no
  //      cache — see the comment above loadRates for why).
  //   5. costForEntry / costBucketsUsd — per-model rate lookup.
  //
  // Offset sidecar shape (at STATE_DIR/<sid>.offset, written atomically via
  //   writeJsonAtomic — same pid+ts+rename discipline as <sid>.json itself,
  //   so SIGKILL / disk-full mid-write cannot leave a truncated JSON that
  //   would otherwise reset lastTs=0 and double-count the transcript on the
  //   next fire):
  //   { offset, lastTs, lastSize, totals, buckets, perTurn,
  //     subOffsets: { 'sub:<agentId8>': {offset, lastTs, lastSize}, ... },
  //     tailWarmed?: boolean }
  //     offset/lastTs/lastSize — MAIN transcript's per-source read cursor.
  //     subOffsets[<source>]   — per-subagent read cursor (one per agentId).
  //     totals/buckets/perTurn — session-cumulative (main + all subagents).
  //     tailWarmed             — set when first-fire pre-warm skipped the
  //                              transcript prefix (256KB tail only); the
  //                              next fire backfills the prefix as a full
  //                              re-read (correcting the cumulative totals).
  // Buckets progressive-fold to 5min/1h/1d granularity when >TOK_BUCKETS_MAX
  // (1000) to bound memory + per-tick aggregation cost even for months-long
  // sessions. perTurn is capped at TOK_TURNS_MAX (400) — older turns roll
  // out (FIFO); sufficient for tooltip breakdown.
  //
  // Token-dimension abbreviations (used in totals/buckets/perTurn shapes):
  //   in  = input_tokens
  //   out = output_tokens
  //   cr  = cache_read_input_tokens
  //   cc5 = cache_creation.ephemeral_5m_input_tokens (Anthropic object form)
  //   cc1 = cache_creation.ephemeral_1h_input_tokens (Anthropic object form)
  //   cci = cache_creation_input_tokens (scalar form, glm-5.2 / legacy)
  // When the Anthropic object form is present, cci is forced to 0 to avoid
  // double-counting (legacy scalar = 5m+1h sum; using both ~2x overestimates).

  // Cost lookup — returns {in,out,cacheRead?,cacheCreate5m?,cacheCreate1h?} in
  // USD per 1M tokens, or null when model unknown AND no _default. The
  // cacheRead/5m/1h fields default to in*CACHE_READ_RATIO /
  // in*CACHE_CREATE_5M_RATIO / in*CACHE_CREATE_1H_RATIO when absent
  // (Anthropic prompt-caching pricing ratios) so a rate entry can be terse.
  //
  // v0.2.4 (code-style LOW fix): dropped the mtime cache (__ratesCache +
  // __ratesMtime). The hook is a fresh Node process per fire and calls
  // loadRates exactly once per process — the cache was dead defensive code
  // that gave maintainers the false impression that multi-call scenarios
  // were covered. If a future feature requires multiple loadRates calls
  // per process, re-add the cache then; for now the function reads cleanly.
  function loadRates() {
    try {
      return JSON.parse(fs.readFileSync(RATES_PATH, 'utf8'));
    } catch {
      // Missing / corrupt rates → return {_default: null} so cost = null for
      // every model. The IIFE hides the $ suffix when cost is null.
      return { _default: null };
    }
  }

  /** Read the transcript at `transcriptPath` starting from the last consumed
   *  byte offset (stored in <sid>.offset). Parses each line as JSON; lines
   *  that fail JSON.parse (e.g. partial flush tail) are silently skipped.
   *  Returns the updated ctx object (whether or not new bytes were found),
   *  or null when the read must be skipped (file missing / stale / size=0).
   *  Mutates + persists the sidecar.
   *
   *  `source` tags the resulting perTurn entries ("main" for parent transcript,
   *  "sub:<agentId|8>" for subagent transcripts attributed to the parent sid).
   *  Per-source offset state: main uses ctx.{offset,lastTs,lastSize} (top-level
   *  fields, backward-compatible with pre-fix sidecars); each 'sub:<agentId>'
   *  gets its own {offset,lastTs,lastSize} under ctx.subOffsets[<source>].
   *  This isolation is the critical fix for the SubagentStop path: previously
   *  both main and sub shared ctx.offset, so a SubagentStop whose transcript
   *  was smaller than the parent's offset triggered a size-shrink reset that
   *  zeroed the parent's cumulative totals/buckets/perTurn — or, when the
   *  subagent transcript's mtime was older than the parent's lastTs, bug-9188
   *  dedup silently dropped every subagent row. Per-source cursors eliminate
   *  both failure modes; the session-cumulative totals/buckets/perTurn are
   *  shared (so subagent tokens correctly merge into the parent sid).
   *
   *  `opts.forceFull` (default false) bypasses the first-fire 256KB tail pre-
   *  warm and reads the entire file from byte 0. Used by the QuickPick "Reset
   *  session stats" action (which writes a <sid>.forcereread marker) so the
   *  user gets the TRUE full-history total, not the tail slice. The marker is
   *  consumed on the next fire regardless of which event triggers it.
   *
   *  Atomic write: the sidecar is written via writeJsonAtomic (tmp + rename,
   *  same discipline as <sid>.json itself) so SIGKILL / disk-full / EPERM
   *  between truncate and rewrite cannot leave a half-written JSON that would
   *  otherwise parse-fail → reset lastTs=0 → ts-dedup guard fail → every
   *  historical row double-counted on the next fire. */
  function readTranscriptIncremental(sid, transcriptPath, source, opts) {
    if (!transcriptPath) return null;
    const forceFull = !!(opts && opts.forceFull);
    let stat;
    try {
      stat = fs.statSync(transcriptPath);
    } catch {
      // Bug #41310: SessionStart/UserPromptSubmit can fire before CC creates
      // the transcript file. Silent skip — next hook fire will catch up.
      return null;
    }
    if (!stat.isFile() || stat.size <= 0) return null;

    const offsetPath = path.join(STATE_DIR, sid + TOK_OFFSET_EXT);
    // Fresh default ctx. subOffsets is keyed by source tag ('sub:<agentId8>').
    // tailWarmed signals "first-fire pre-warm skipped the prefix; next fire
    // must backfill via a full re-read".
    let ctx = {
      offset: 0,
      lastTs: 0,
      lastSize: 0,
      totals: zeroTotals(),
      buckets: [],
      perTurn: [],
      subOffsets: Object.create(null),
      tailWarmed: false,
      // v0.2.4 (data-logic HIGH fix): tailBackfilled gates the entire
      // pre-warm/backfill block. Without it the alternation belows re-entered
      // on every MAIN fire: fire-1 pre-warms (tailWarmed=true), fire-2 back-
      // fills (resets tailWarmed=false), fire-3 sees !tailWarmed and pre-
      // warms AGAIN — every other MAIN fire reads the entire multi-MB
      // transcript from byte 0 (33MB → every other fire pays a ~1s I/O).
      // tailBackfilled is set true ONLY by the backfill branch and never
      // reset except by forceFull / size-shrink / corrupt-sidecar — the
      // MAIN cursor (srcView.offset) then bounds subsequent reads to the
      // incremental delta (KB-level even for 33MB transcripts).
      tailBackfilled: false,
    };
    if (fs.existsSync(offsetPath)) {
      try {
        const prev = JSON.parse(fs.readFileSync(offsetPath, 'utf8'));
        // Carry forward previous state but rebuild totals shape defensively.
        ctx.offset = Number.isFinite(prev.offset) ? prev.offset : 0;
        ctx.lastTs = Number.isFinite(prev.lastTs) ? prev.lastTs : 0;
        ctx.lastSize = Number.isFinite(prev.lastSize) ? prev.lastSize : 0;
        ctx.totals = Object.assign(zeroTotals(), prev.totals || {});
        ctx.buckets = Array.isArray(prev.buckets) ? prev.buckets : [];
        ctx.perTurn = Array.isArray(prev.perTurn) ? prev.perTurn : [];
        ctx.subOffsets = prev.subOffsets && typeof prev.subOffsets === 'object' ? prev.subOffsets : Object.create(null);
        ctx.tailWarmed = prev.tailWarmed === true;
        ctx.tailBackfilled = prev.tailBackfilled === true;
      } catch {
        // Corrupt sidecar — reset and re-read from the top. lastTs=0 means
        // every row passes the per-source ts dedup; combined with reading from
        // byte 0 (next paragraph) this is equivalent to a full re-read. Better
        // to over-count once (the per-source dedup catches re-fires) than to
        // silently lose data.
        ctx = {
          offset: 0,
          lastTs: 0,
          lastSize: 0,
          totals: zeroTotals(),
          buckets: [],
          perTurn: [],
          subOffsets: Object.create(null),
          tailWarmed: false,
          tailBackfilled: false,
        };
      }
    }

    const isSub = source && source !== 'main';
    // Per-source view: a small object that aliases the right slot. For 'main'
    // we copy out + write back; for 'sub:X' we mutate ctx.subOffsets[X] in
    // place (it persists when ctx is serialised at the end).
    let srcView;
    if (isSub) {
      if (!ctx.subOffsets[source]) ctx.subOffsets[source] = { offset: 0, lastTs: 0, lastSize: 0 };
      srcView = ctx.subOffsets[source];
    } else {
      srcView = { offset: ctx.offset, lastTs: ctx.lastTs, lastSize: ctx.lastSize };
    }

    // forceFull (QuickPick "Reset session stats"): re-read the WHOLE file from
    // byte 0. Reset this source's cursor + the session-cumulative state. The
    // per-source ts dedup is also reset (lastTs=0) so every historical row
    // passes — combined with readFrom=0 below this gives the user a true
    // full-history total. Only applies to the MAIN source (QuickPick reset is
    // only meaningful for the parent transcript).
    //
    // v0.2.4 (data-logic HIGH fix): reset preserves subagent contributions
    // (entries with src !== 'main'). Previously forceFull zeroed ctx.totals/
    // buckets/perTurn entirely, so subagent cost (already merged via prior
    // SubagentStop fires) was wiped. SubagentStop only fires once per
    // subagent, so the loss was permanent. We keep subagent buckets and
    // recompute their contribution to ctx.totals from the kept set.
    //
    // v0.2.4 round-3 (business-logic LOW fix): tailBackfilled is set TRUE
    // here (was FALSE). forceFull just consumed the entire [0..stat.size]
    // range — the tail pre-warm/backfill state machine has nothing left to
    // do on subsequent fires, so leaving tailBackfilled=false forced the
    // next 2 fires to redundantly re-arm and re-pay the pre-warm + backfill
    // sequence (~1s I/O each on a 33MB transcript) for no correctness gain
    // (per-source ts dedup makes the redundant reads no-ops functionally, but
    // they're a pure waste). size-shrink / corrupt-sidecar still re-arm
    // (they re-build the tail baseline after a structural file change);
    // forceFull is incorrectly grouped with them because, semantically,
    // forceFull IS already a completed backfill.
    if (forceFull && !isSub) {
      srcView.offset = 0;
      srcView.lastTs = 0;
      srcView.lastSize = 0;
      const keptBuckets = ctx.buckets.filter((b) => b && b.src && b.src !== 'main');
      const keptPerTurn = ctx.perTurn.filter((p) => p && p.src && p.src !== 'main');
      const keptTotals = zeroTotals();
      for (const b of keptBuckets) addInto(keptTotals, b);
      ctx.totals = keptTotals;
      ctx.buckets = keptBuckets;
      ctx.perTurn = keptPerTurn;
      ctx.tailWarmed = false;
      ctx.tailBackfilled = true;
      // Subagent cursors are left untouched — they track already-merged
      // subagent transcripts. Re-reading the parent must not re-merge subagent
      // contributions (their buckets live in ctx.buckets already and are
      // preserved by the filter above; only MAIN entries are cleared).
    }

    // Bug #9188 mitigation: stale sid+path. If file mtime is older than our
    // last processed timestamp by >60s AND size hasn't grown, skip this round
    // without resetting (the next real fire will catch up). Per-source so a
    // subagent transcript with older mtime than the parent's lastTs no longer
    // false-triggers the parent's mitigation (critical fix: this was the
    // second silent-drop path for SubagentStop, since the subagent's mtime is
    // typically earlier than the parent's most-recent activity).
    if (
      srcView.lastTs > 0 &&
      stat.mtimeMs < srcView.lastTs - BUG_9188_STALE_MS &&
      stat.size <= (srcView.lastSize || 0)
    ) {
      return ctx;
    }

    // Size shrank → CC compacted the transcript. Reset THIS SOURCE's offset
    // and re-read from 0. For the MAIN source we ALSO reset the session-
    // cumulative totals/buckets/perTurn, mirroring the forceFull path.
    //
    // Round-2 e2e-correctness / data-logic fix: the previous implementation
    // deliberately kept ctx.totals/buckets/perTurn across a MAIN compaction,
    // claiming "the per-source ts dedup prevents double-counting when we
    // re-read the compacted rows". The claim was wrong — the dedup baseline
    // IS srcView.lastTs, which the SAME block just zeroed. Every retained
    // compacted row (which keeps its original ts) re-passed the dedup and
    // was added ON TOP of the pre-compaction cumulative state, inflating
    // totals/cost by (1 + retained_fraction) on every compaction. Verified
    // on a 5-row transcript (in=500/out=250) compacted to last-3 rows with
    // original timestamps → next fire returned in=800/out=400.
    //
    // Resetting totals on MAIN compaction loses past subagent contributions
    // (their buckets live in ctx.buckets which we just cleared). This is
    // the SAME semantics as QuickPick Reset, and live subagents re-fire
    // SubagentStop to repopulate. The SUB-source path keeps the old
    // cursor-only reset — subagent transcripts are written once at subagent
    // end (no compaction), and a SUB size-shrink is typically a corrupt or
    // truncated file where re-reading from 0 is correct. The parent MAIN
    // fire owns the cumulative-state reset for the routine-compaction path.
    // ctx.subOffsets is left untouched — per-subagent cursors are
    // independent of the MAIN transcript's compaction.
    if (stat.size < srcView.offset) {
      srcView.offset = 0;
      srcView.lastTs = 0;
      srcView.lastSize = 0;
      if (!isSub) {
        // v0.2.4 (data-logic HIGH fix): preserve subagent contributions
        // (same filter-and-recompute as forceFull above). CC's routine
        // mid-session compaction previously dropped subagent cost perma-
        // nently because SubagentStop never re-fires for a finished
        // subagent. SUB-source size-shrink (rare: corrupt/truncated
        // subagent file) still gets the cursor-only reset — subagent
        // transcripts are written once at subagent end (no compaction),
        // and re-reading from 0 is the right thing for a truncated file.
        const keptBuckets = ctx.buckets.filter((b) => b && b.src && b.src !== 'main');
        const keptPerTurn = ctx.perTurn.filter((p) => p && p.src && p.src !== 'main');
        const keptTotals = zeroTotals();
        for (const b of keptBuckets) addInto(keptTotals, b);
        ctx.totals = keptTotals;
        ctx.buckets = keptBuckets;
        ctx.perTurn = keptPerTurn;
        // Mirror forceFull: clear tailWarmed so a compacted-then-regrown
        // transcript re-arms the pre-warm/backfill pair from scratch instead
        // of leaving a stale tailWarmed=true that would trigger an immediate
        // backfill on the next fire (which would re-read the same compacted
        // content + new bytes — correct, but confusing if you're inspecting
        // the sidecar mid-flow).
        ctx.tailWarmed = false;
        ctx.tailBackfilled = false;
      } else {
        // v0.2.4 (data-logic MEDIUM fix): SUB-source size-shrink (corrupt /
        // truncated subagent file). Previously only the cursor was reset —
        // the SUB's previously-merged buckets stayed in ctx.buckets AND
        // srcView.lastTs=0 let every retained SUB row through the per-source
        // dedup, double-counting the SUB's contribution. Now drop the SUB's
        // OWN entries (matching `src === source`) and recompute totals from
        // the survivors, so a re-read from byte 0 cleanly replaces the SUB
        // share. MAIN entries and OTHER subagents' entries are untouched.
        //
        // v0.2.4 round-3 (data-logic LOW): best-effort filter — `src ===
        // source` only matches UNFOLDED buckets still tagged with the
        // precise `sub:<agentId>`. Once progressive fold runs
        // (ctx.buckets.length > TOK_BUCKETS_MAX), foldBuckets collapses the
        // source tag on folded buckets to 'subagent' (pure-sub fold key,
        // original agentId stripped) or 'mixed' (main+sub same-window+model)
        // — see foldBuckets L726-L729. On the narrow path where SubagentStop
        // re-fires for an already-folded source whose transcript file has
        // been truncated/rewritten smaller, the filter fails to drop the
        // folded buckets; the re-read then adds fresh `sub:<agentId>`
        // buckets ON TOP of the surviving folded ones, double-counting this
        // source's contribution. The adjacent "cleanly replaces the SUB
        // share" wording is accurate only PRE-fold. The trigger is
        // essentially unreachable in normal CC operation (SubagentStop
        // fires once per agent, so srcView.offset for a sub is already at
        // file end on the only fire — a SUB-source size-shrink requires the
        // SAME agentId to re-fire against a truncated file, which CC does
        // not do), so this is documented best-effort, not a code change.
        // If exactness is later wanted, extend the folded-bucket schema
        // with a `sources: string[]` populated by unioning input buckets'
        // src during foldBuckets, then broaden the filter to
        // `!(b && (b.src === source || (Array.isArray(b.sources) &&
        // b.sources.indexOf(source) >= 0)))` (mirror for survivorPerTurn).
        const survivors = ctx.buckets.filter((b) => !(b && b.src === source));
        const survivorPerTurn = ctx.perTurn.filter((p) => !(p && p.src === source));
        const survivorTotals = zeroTotals();
        for (const b of survivors) addInto(survivorTotals, b);
        ctx.buckets = survivors;
        ctx.perTurn = survivorPerTurn;
        ctx.totals = survivorTotals;
      }
    }

    // No new bytes — nothing to do, UNLESS a first-fire tail pre-warm left a
    // pending backfill (fire 1 set ctx.tailWarmed=true after reading only
    // the last 256KB; fire 2 must backfill the prefix even when no new bytes
    // arrived — otherwise cumulative session totals are permanently stuck
    // at the partial tail-only values for any parent transcript >256KB).
    // Persist-and-return without backfilling is correct ONLY when no backfill
    // is pending.
    if (stat.size === srcView.offset && !ctx.tailWarmed) {
      if (!isSub) {
        ctx.offset = srcView.offset;
        ctx.lastTs = srcView.lastTs;
        ctx.lastSize = srcView.lastSize;
      }
      try {
        fs.mkdirSync(path.dirname(offsetPath), { recursive: true });
        writeJsonAtomic(offsetPath, ctx);
      } catch {
        /* best-effort */
      }
      return ctx;
    }

    // First-fire pre-warm (MAIN source only): if the file is large, only
    // read the tail (last TOK_TAIL_PRESET_BYTES). This bounds first-fire
    // latency to <100ms even for 33MB transcripts; the user gets immediate
    // feedback (windowed totals reflect recent activity). The trade-off
    // (skipping historical totals) is RECOVERED on the next fire:
    // tailWarmed=true triggers a full backfill read [0..stat.size] that
    // replaces the partial totals with accurate ones (see the next branch).
    // Subagent transcripts are ALWAYS read in full — they are typically small
    // and we want accurate subagent cost immediately (SubagentStop fires once
    // per subagent with no incremental follow-up).
    //
    // Round-2 e2e-correctness fix: the previous gate here also required
    // `srcView.offset === 0`. That made the backfill branch UNREACHABLE —
    // fire 1 advances srcView.offset to stat.size (see the assignment near
    // the end of this function), so on fire 2 srcView.offset was non-zero
    // regardless of whether CC appended bytes. ctx.tailWarmed stayed true
    // forever, the `else { backfill = true; ... }` block below was dead
    // code, and any session whose transcript exceeded 256KB at VS Code
    // startup displayed only ~30% of the true total forever (verified on a
    // 5000-row/885KB transcript). Gating on tailWarmed alone (with the
    // early-return-with-backfill change above) makes the backfill actually
    // fire on the second fire, with or without new bytes.
    //
    // v0.2.4 (data-logic HIGH fix): the entire pre-warm/backfill block is
    // now gated on `!ctx.tailBackfilled`. Without this gate the state
    // machine alternated forever: fire-1 pre-warms (tailWarmed=true), fire-
    // 2 backfills (tailWarmed=false), fire-3 sees !tailWarmed and pre-warms
    // AGAIN — every other MAIN fire on a large transcript did a full
    // [0..stat.size] read (33MB → ~1s of I/O every other fire, forever).
    // The two-state machine (tailWarmed flips every fire) is replaced by a
    // three-state one: pristine → preWarmed → backfilled(terminal). Once
    // tailBackfilled=true the block is skipped on every subsequent fire and
    // the read falls through to the normal incremental path (readFrom=
    // srcView.offset, KB-level even for 33MB transcripts). size-shrink /
    // corrupt-sidecar reset tailBackfilled so a fresh pre-warm/backfill pair
    // can fire after a re-read-from-zero event.
    //
    // v0.2.4 round-3 (business-logic LOW fix): forceFull NO LONGER resets
    // tailBackfilled (it now sets tailBackfilled=true in the forceFull branch
    // above). forceFull IS already a completed [0..stat.size] read, so the
    // subsequent pre-warm/backfill pair was pure redundant I/O on a 33MB
    // transcript (~1s per fire for 2 fires, with per-source ts dedup making
    // the function output a no-op). size-shrink / corrupt-sidecar keep their
    // re-arm semantics — those paths rebuild the tail baseline after a real
    // structural file change.
    let readFrom = srcView.offset;
    if (!forceFull && !isSub && stat.size > TOK_TAIL_PRESET_BYTES && !ctx.tailBackfilled) {
      if (!ctx.tailWarmed) {
        // First fire: read tail only.
        readFrom = stat.size - TOK_TAIL_PRESET_BYTES;
        ctx.tailWarmed = true;
      } else {
        // Second fire: backfill. Read the WHOLE file from byte 0 — the
        // prefix we previously skipped PLUS the incremental bytes added
        // since. To get accurate totals we reset the session-cumulative
        // state (the tail-only totals were partial) and the per-source
        // cursor+dedup, then fall through to a normal full read. Cost: one
        // extra ~1s read on a 33MB transcript on the second fire
        // (UserPromptSubmit pre-warms on fire 1; PostToolUse/Stop absorbs
        // the backfill on fire 2 since they're not CC-wait-blocking).
        // tailBackfilled=true makes this the LAST full read — fire 3+
        // skip the entire block and read only the incremental delta.
        // v0.2.4 (data-logic HIGH fix): preserve subagent contributions
        // across the backfill reset (same filter as forceFull / size-shrink).
        readFrom = 0;
        srcView.offset = 0;
        srcView.lastTs = 0;
        srcView.lastSize = 0;
        const keptBuckets = ctx.buckets.filter((b) => b && b.src && b.src !== 'main');
        const keptPerTurn = ctx.perTurn.filter((p) => p && p.src && p.src !== 'main');
        const keptTotals = zeroTotals();
        for (const b of keptBuckets) addInto(keptTotals, b);
        ctx.totals = keptTotals;
        ctx.buckets = keptBuckets;
        ctx.perTurn = keptPerTurn;
        ctx.tailWarmed = false;
        ctx.tailBackfilled = true;
      }
    }

    const newSize = stat.size - readFrom;
    let buf;
    let fd;
    let bytesRead;
    try {
      fd = fs.openSync(transcriptPath, 'r');
      buf = Buffer.allocUnsafe(newSize);
      // v0.2.6 round-3 HIGH (integrity): capture fs.readSync's return value.
      // If the file shrank between the stat() above and the read (CC compaction
      // mid-fire, concurrent truncation), readSync returns fewer bytes than
      // newSize and the trailing bytes are uninitialized pool memory. Without
      // this bound, buf.toString('utf8') and buf.lastIndexOf(0x0a) on the FULL
      // buffer would include the garbage tail — a garbage 0x0a byte would push
      // safeEndOffset past the actually-read content (advancing the sidecar
      // cursor past real data → next fire re-reads from a bogus offset), and
      // garbage text lines would pollute the JSON.parse loop. Mirrors the
      // IIFE-side computeLiveDelta read which already bounds every subsequent
      // buf operation by br.
      bytesRead = fs.readSync(fd, buf, 0, newSize, readFrom);
    } catch {
      try {
        if (fd) fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      return ctx;
    } finally {
      try {
        if (fd) fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    // Short read (file shrank mid-fire): treat as no-progress so the next fire
    // retries from the same offset. Returning ctx leaves srcView.offset /
    // ctx.offset untouched at their pre-call values; the sidecar on disk stays
    // at the previous successful advance, and the next fire re-reads the same
    // byte range once CC finishes the compaction/truncation.
    if (typeof bytesRead !== 'number' || bytesRead <= 0) {
      return ctx;
    }
    // Bound every buf operation to bytesRead so the uninitialized allocUnsafe
    // tail cannot leak into the JSON.parse loop or the offset sidecar write.
    const effectiveBuf = bytesRead < newSize ? buf.subarray(0, bytesRead) : buf;

    let text = effectiveBuf.toString('utf8');
    // Split into lines. The first segment may be a partial line (if readFrom
    // landed in the middle of a row) — JSON.parse rejects it inside the per-
    // line try/catch below, so we DON'T pre-emptively shift. Pre-emptive
    // shifting was an earlier optimization but it false-positive dropped a
    // COMPLETE row whenever readFrom happened to land exactly on a newline
    // boundary (which is the common case after a successful prior fire:
    // offset advances to stat.size which is just past the last '\n'). The
    // tail's last segment may also be a half-flushed line — same handling,
    // JSON.parse rejects it. CC finishes the write before the next hook fire
    // so the partial tail eventually parses on a subsequent fire.
    //
    // v0.2.4 round-3 (data-loss HIGH fix): the prior comment's claim ("CC
    // finishes the write before the next hook fire") was FALSE for the
    // partial-TAIL case, and advancing srcView.offset to stat.size
    // unconditionally permanently lost the tail row. Trace: fire-1 reads
    // [offset..stat.size] where the final row_X is half-flushed (no trailing
    // '\n' yet) → JSON.parse fails → old code set srcView.offset=stat.size.
    // fire-2 reads [stat.size..new_stat.size] = "lete\nrow_Y..." → "lete"
    // fails JSON.parse standalone, row_X is never reassembled. Token totals
    // and cost silently underestimated. Fix: find the last '\n' in the BYTE
    // buffer; advance srcView.offset only to just past it (readFrom +
    // lastNlByteIdx + 1). The next fire re-reads the partial tail bytes
    // concatenated with the new bytes, so the now-complete row parses once
    // and the per-source ts dedup (L1395 `ts <= srcView.lastTs`) prevents
    // double-counting the rows that already parsed.
    //
    // Edge case — buf contains NO newline at all: this happens when the read
    // window lands entirely inside a single row. Two sub-cases:
    //   (a) Partial TAIL (the common case this fix targets): readFrom is just
    //       past the last '\n' (a post-condition of every prior fire under
    //       this fix), and the bytes [readFrom..stat.size] are the partial
    //       tail of a row still being flushed. Hold offset at readFrom so
    //       the next fire re-reads these bytes + new ones.
    //   (b) Single oversized row larger than the read window (extremely
    //       unusual for assistant messages): only reachable via the
    //       first-fire tail pre-warm (readFrom = stat.size - 256KB), and
    //       the very next fire is the backfill which resets readFrom=0 and
    //       re-reads the whole file — so hold-back is correct here too
    //       (the oversized row gets parsed once the backfill supplies its
    //       prefix from byte 0).
    // Both sub-cases want the same behavior: keep offset at readFrom. This
    // is correct AND avoids an infinite same-bytes loop, because the
    // follow-up fire either (a) supplies more bytes that complete the row,
    // or (b) is the backfill which resets readFrom to 0.
    //
    // Byte-level search (Buffer.lastIndexOf) is used instead of text-level
    // (String.lastIndexOf) because a multi-byte UTF-8 char split at the read
    // boundary would make char index != byte index. v0.2.6 round-3 HIGH
    // (integrity): bound the search to bytesRead via effectiveBuf so a garbage
    // 0x0a byte in the uninitialized allocUnsafe tail cannot advance
    // safeEndOffset past the actually-read content.
    const lastNlByte = effectiveBuf.lastIndexOf(0x0a /* '\n' */);
    const safeEndOffset = lastNlByte >= 0 ? readFrom + lastNlByte + 1 : readFrom;
    const lines = text.split('\n');
    // Drop the trailing empty segment (the split produces one after the last
    // '\n' — empty string, harmless but adds a wasted parse attempt).
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    let newEntries = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || obj.type !== 'assistant') continue;
      if (obj.isSidechain === true) continue; // subagent rows: handled via SubagentStop agent_transcript_path
      const model = (obj.message && obj.message.model) || '';
      if (typeof model === 'string' && model.startsWith('<synthetic>')) continue;
      const u = (obj.message && obj.message.usage) || {};
      const ts = Date.parse(obj.timestamp);
      if (!Number.isFinite(ts)) continue;
      if (ts <= srcView.lastTs) continue; // per-source dedup across fires
      // cache_creation dual form: scalar (glm-5.2 / legacy Anthropic) OR
      // object (current Anthropic). When BOTH are present (Anthropic legacy
      // transition window: scalar = sum of 5m+1h), using both double-counts
      // ~2x. Prefer the object form when present and zero the scalar.
      const hasCcObj = u.cache_creation && typeof u.cache_creation === 'object';
      const entry = {
        ts,
        in: u.input_tokens || 0,
        out: u.output_tokens || 0,
        cr: u.cache_read_input_tokens || 0,
        cc5: hasCcObj ? u.cache_creation.ephemeral_5m_input_tokens || 0 : 0,
        cc1: hasCcObj ? u.cache_creation.ephemeral_1h_input_tokens || 0 : 0,
        cci: hasCcObj ? 0 : u.cache_creation_input_tokens || 0,
        model,
        // v0.2.4 (data-logic HIGH fix): tag the bucket with its source so the
        // MAIN reset paths (forceFull / size-shrink / backfill) can preserve
        // subagent contributions instead of zeroing the whole cumulative
        // state. CC routinely compacts transcripts mid-session; without this
        // tag every compaction permanently dropped already-merged subagent
        // cost (SubagentStop fires once per subagent — no replay), so a long
        // session's $ total could fall backward by the subagent share and
        // never recover. Mirrors the perTurn entry's `src` field already in
        // use below.
        src: source || 'main',
      };
      addInto(ctx.totals, entry);
      ctx.buckets.push(entry);
      ctx.perTurn.push(Object.assign({ src: source || 'main' }, entry));
      srcView.lastTs = ts;
      newEntries++;
    }
    // v0.2.4 (code-style LOW fix): `let backfill = false;` / `backfill = true;`
    // / `void backfill;` deleted — the variable was computed but never read
    // by any control flow (the prior comment explicitly admitted this with
    // "no separate action needed here"). Future debug logging can use an
    // inline `if (process.env.CC_STATUS_DEBUG) console.error('backfill')`
    // inside the backfill branch — no need to carry an unread local.

    // Progressive fold: 5min → 1h → 1d, applied until length <= TOK_BUCKETS_MAX.
    // Without the higher stages, a multi-month session (≈50k 5min buckets)
    // would never fold below TOK_BUCKETS_MAX and every per-tick aggregation
    // (8 windows × N buckets) would perceptibly stall the hook.
    if (ctx.buckets.length > TOK_BUCKETS_MAX) {
      ctx.buckets = foldBuckets(ctx.buckets);
    }

    // Cap perTurn (FIFO).
    if (ctx.perTurn.length > TOK_TURNS_MAX) {
      ctx.perTurn = ctx.perTurn.slice(-TOK_TURNS_MAX);
    }

    srcView.offset = safeEndOffset;
    srcView.lastSize = stat.size;
    if (!isSub) {
      ctx.offset = srcView.offset;
      ctx.lastTs = srcView.lastTs;
      ctx.lastSize = srcView.lastSize;
    }

    try {
      // Atomic write (tmp + rename) — see writeJsonAtomic. STATE_DIR may not
      // exist yet on first fire (the <sid>.json atomic write creates it lazily,
      // but the offset write can fire BEFORE writeJsonAtomic when the caller
      // caches ctx and writes the JSON later).
      fs.mkdirSync(path.dirname(offsetPath), { recursive: true });
      writeJsonAtomic(offsetPath, ctx);
    } catch {
      /* best-effort */
    }
    return ctx;
  }

  // v0.2.5 (problem 3a fix): scan ALL subagent transcripts in the parent
  // session's <sid>/subagents/ directory at every TOK_EVENT so in-flight
  // subagent token consumption becomes visible DURING the subagent's
  // lifetime (the SubagentStop path is a lump-sum catch-up that fires once
  // per subagent only after it finishes — see cc-status.js:1919-1927).
  //
  // Why a directory scan and not a SubagentStart hook?: SubagentStart's
  // payload does NOT carry agent_transcript_path (CC upstream contract —
  // see docs/SUBAGENT-design.md §1.1 official schema). At SubagentStart
  // fire time we would have nothing to read even if we had the path: the
  // subagent transcript file only contains a system-prompt user row at
  // that instant (no assistant usage rows yet). Scanning at every
  // TOK_EVENT (PostToolUse/Stop/UserPromptSubmit/PreToolUse + SubagentStop)
  // picks up subagent transcripts as soon as their FIRST assistant row
  // lands, giving ~500ms-tick visibility (limited by hook fire cadence,
  // not by SubagentStop timing).
  //
  // Why reverse-derive projects root from payload.transcript_path?: CC's
  // cwd→projects-dir escape function is not part of the public contract
  // and has changed historically (the empirical cwd.replace(/[\/\\]/g,'-')
  // is fragile). payload.transcript_path is authoritative (CC tells us
  // exactly where the parent transcript lives), so we take its dirname and
  // append <sid>/subagents/ — no escape ambiguity.
  //
  // Idempotency with SubagentStop: scanSubagentTranscripts and the
  // SubagentStop path both use source = 'sub:<basename>'. Per-source
  // offset isolation in ctx.subOffsets (cc-status.js:1055) means the
  // first reader advances the cursor and subsequent readers see 0 new
  // bytes — no double-count, no race. The SubagentStop path's role
  // narrows to "definitively catch a subagent whose filename does not
  // match the scan heuristic" (defensive parity).
  //
  // workflow type coverage (low-confidence, research-confirmed CC
  // upstream gap): the scan accepts ANY *.jsonl in <sid>/subagents/
  // (not just agent-* prefix), so if CC ever starts writing workflow
  // transcripts alongside subagent ones they are picked up
  // automatically. CC's current behavior for `type:"workflow"` is
  // undocumented — there is no evidence that workflow token usage is
  // written to a discoverable transcript file. If it is not, workflow
  // tokens are silently undercounted at the hook layer with no
  // user-visible signal — known gap, see docs/SUBAGENT-design.md §1.4
  //
  // v0.2.5 round-3 (MEDIUM): an earlier comment here claimed the IIFE
  // tooltip did NOT surface this caveat ('the IIFE tooltip does NOT
  // currently surface this caveat: §G tick only emits ttWindowTpl/...
  // ttClickConfig — there is no ttWorkflowGap line. A future ttWorkflowGap
  // tooltip key (8 languages) is the planned fix ... this comment is the
  // single source of truth about the workflow coverage gap'). That was
  // INACCURATE as of v0.2.5 round-2 — ttWorkflowGap IS now emitted by §G
  // tick (gated on tj.activeSubagents>0; 8-language dict locked by
  // hooks/test-iife.mjs IIFE.94 + IIFE.95). The round-1 comment stayed
  // stale because round-2 added the key without updating it. The actual
  // remaining gap is narrower than 'tooltip does not surface': when a
  // pure-workflow phase runs (no SubagentStart, no background_tasks
  // payload), tj.activeSubagents stays 0 so ttWorkflowGap does NOT show
  // even though workflow tokens may be undercounted — see SUBAGENT-design
  // §1.4/§1.5 (mid/low-confidence CC upstream uncertain points). The SoT
  // for THAT gap lives in docs/SUBAGENT-design.md §1.4, not here.
  //
  // Robustness: every FS operation is wrapped in try/catch. A missing
  // subagents/ dir (the common case for sessions without subagents) is
  // a silent no-op. Hook NEVER throws — CC's hook contract requires it.
  function scanSubagentTranscripts(parentSid, payload, ctxIn) {
    if (!payload || typeof payload.transcript_path !== 'string' || !payload.transcript_path) {
      return ctxIn;
    }
    let parentDir;
    try {
      parentDir = path.dirname(payload.transcript_path);
    } catch {
      return ctxIn; // malformed transcript_path — best-effort skip
    }
    // Collect candidate subagent transcript files from the CURRENT CC layout:
    //   <parentDir>/<sid>/subagents/*.jsonl (nested, per empirical research
    //   documented in docs/SUBAGENT-design.md §1.2 — agentId matches the
    //   filename's `agent-<hex>` suffix).
    //
    // The legacy CC 2.0.77 top-level layout (<parentDir>/agent-*.jsonl) is
    // INTENTIONALLY NOT scanned. Real top-level agent files contain
    // isSidechain:true throughout (per /Users/wangdong/.claude/projects/
    // empirical evidence), so readTranscriptIncremental would skip every
    // row at line ~1406 — no coverage gained. Worse, test fixtures and
    // third-party tooling may plant *.jsonl siblings of the parent
    // transcript that are NOT real subagent transcripts; scanning them by
    // default would silently mis-attribute tokens. The SubagentStop hook
    // (cc-status.js:1919-1927) remains the authoritative fallback for
    // any subagent transcript the directory scan does not cover.
    const candidates = [];
    try {
      const nestedDir = path.join(parentDir, parentSid, 'subagents');
      const entries = fs.readdirSync(nestedDir);
      for (const name of entries) {
        if (name.endsWith('.jsonl')) candidates.push(path.join(nestedDir, name));
      }
    } catch {
      /* nested dir absent — common case (no subagents in flight), silent skip */
    }
    // Read each candidate incremental. The last read's ctx is kept —
    // readTranscriptIncremental writes its sidecar atomically on each
    // call, so earlier reads are persistent in the sidecar; the final
    // ctx returned carries the cumulative totals+buckets across all
    // calls in this fire.
    let ctx = ctxIn;
    for (const candidate of candidates) {
      try {
        let base = 'unknown';
        try {
          const parsed = path.basename(candidate, '.jsonl');
          if (parsed) base = parsed;
        } catch {
          /* keep 'unknown' */
        }
        const subCtx = readTranscriptIncremental(parentSid, candidate, 'sub:' + base);
        if (subCtx) ctx = subCtx;
      } catch {
        /* skip individual failures — one corrupt subagent transcript must not abort the scan */
      }
    }
    return ctx;
  }

  // Progressive bucket fold: 5min → 1h → 1d. Applied in stages until the
  // folded length <= TOK_BUCKETS_MAX. Each stage groups buckets whose ts
  // falls in the same granularity window AND share the same model, summing
  // their token dimensions; the resulting bucket carries the most-recent
  // ts in the window (v0.2.4 fix — see below). Adds at most 3 O(N) passes
  // per fire — negligible vs the per-line JSON.parse cost it follows.
  //

  // --- Read & validate stdin (never throw on bad input) ---
  const raw = await readStdin();
  if (!raw || !raw.trim()) process.exit(0); // empty stdin -> nothing to do

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // invalid JSON -> stay quiet
  }

  // Without a session id there is nothing to key a status file on.
  // Defensive: session_id should be a bare opaque token. Reject anything that
  // could escape STATE_DIR via path traversal (CC never sends these, but a
  // hook is a passive receiver of arbitrary stdin — `path.join` would happily
  // climb out of STATE_DIR for `'../etc/foo'`, creating a JSON file outside
  // ~/.claude/cc-tab-status/). Reject path separators and the `.`/`..`
  // sentinels; allow everything else (CC's session_id is uuid-ish).
  const sid = payload && payload.session_id;
  // Also reject the empty string. Without `!sid` an empty
  // payload.session_id slips through all four clauses and `path.join(STATE_DIR,
  // '.json')` resolves to a hidden file at the dir root (verified). CC never
  // sends this, but the §B path-traversal suite exists for exactly the "hook
  // is a passive receiver of arbitrary stdin" defensive posture — the empty
  // string is the same class of edge as `.` / `..`.
  if (typeof sid !== 'string' || !sid || /[\\/]/.test(sid) || sid === '.' || sid === '..') process.exit(0);

  const filePath = path.join(STATE_DIR, sid + '.json');

  // --- Bounded GC (UserPromptSubmit prune of files > 24h) ---
  // On UserPromptSubmit (a cheap, once-per-turn event) prune status files whose
  // mtime exceeds INTERRUPTED_RETENTION_MS (24h). Crashed/killed CC processes
  // never send SessionEnd, so without this prune ~/.claude/cc-tab-status/ would
  // grow unbounded over months of daily use — every 500ms aggregation tick does
  // fs.readdirSync + per-file readFileSync + JSON.parse over the WHOLE dir, so
  // an unbounded long tail makes the SBI tick perceptibly heavier for zero
  // diagnostic value. The aggregation layer ALREADY discounts these files for
  // COUNTING (interrupted>24h→idle, running>30min→idle, done>5min→idle); this
  // prune also reclaims the bytes. Best-effort: wrapped in try/catch so a
  // transient FS error never blocks the primary write. SKIP the current
  // session's file — we're about to overwrite it with a fresh mtime anyway.
  //
  // Cross-session prune: the GC iterates the WHOLE STATE_DIR, so a
  // UserPromptSubmit for session X may unlink a stale file belonging to ANY
  // other session Y in the same CC installation. This is the SECOND writer-
  // side deletion trigger (STATES.md §2 lists SessionEnd as the first).
  // Functional rationale: there is no per-session cleanup hook besides
  // SessionEnd, and crashed sessions never fire SessionEnd — a global mtime
  // sweep is the only practical reclamation path. The skip-current rule below
  // protects only the writer's own target file; third-party files older than
  // 24h are pruned on any other session's UserPromptSubmit.
  //
  // Interrupted-preservation contract (STATES.md §7.5): INTERRUPTED_RETENTION_MS
  // (24h) is the SAME threshold the aggregation layer uses to decay
  // interrupted>24h to idle FOR COUNTING — but STATES.md §7.5 explicitly
  // guarantees "文件不删（保留诊断价值，用户可手动检查…）" (files are kept on
  // disk for diagnostic value; the user can inspect them manually). The aggregation
  // layer honors that (it filters at READ time, leaves the bytes); the writer's
  // GC must honor it too — so we PARSE the file's state and SKIP the prune
  // when state==='interrupted'. A user who comes back to inspect yesterday's
  // interrupted session via ~/.claude/cc-tab-status/<sid>.json will still find
  // the file. Running/done/idle-by-default files older than 24h remain
  // prunable (no diagnostic value, reader already discounts them).
  //
  // Throttle: UserPromptSubmit is latency-sensitive (CC waits on the hook
  // process before continuing the turn), so a full readdirSync + per-file
  // statSync + (for stale candidates) readFileSync + JSON.parse + unlinkSync
  // sweep on EVERY prompt is the wrong place for unbounded work — on an
  // install with months of accumulated stale files the first UserPromptSubmit
  // after launch pays the entire cost. A sidecar file at STATE_DIR/.gc
  // records the timestamp of the last sweep; we skip the sweep unless
  // GC_INTERVAL_MS (10 min) has elapsed. Tests can override via the
  // CC_STATUS_GC_INTERVAL_MS env var (set to 0 to force the sweep on every
  // UserPromptSubmit). The per-call unlink cap (GC_MAX_UNLINKS) bounds the
  // worst case even when the sweep does fire.
  //
  // .tmp reaping: writeJsonAtomic uses `<sid>.<pid>.<ts>.tmp` + renameSync,
  // and a SIGKILL/disk-full/EPERM between writeFileSync and renameSync leaves
  // an orphan tmp that the `.endsWith('.json')` filter would otherwise skip
  // forever. The sweep also reaps `.tmp` files older than GC_TMP_AGE_MS
  // (5 min, well beyond any legitimate renameSync latency).
  //
  // TOCTOU: the original stat→unlink sequence could race a concurrent writer
  // (session B writing between our statSync and unlinkSync). We re-statSync
  // IMMEDIATELY before unlinkSync and bail if mtimeMs moved forward — the
  // window is now bounded by the cost of a single statSync (microseconds),
  // so a freshly-written file by another process survives.
  // v0.2.4 follow-up (round-2 e2e fix): honor 0 explicitly. The prior form
  // `Number(env) || DEFAULT` treated `0` as falsy and silently fell through
  // to the default — the documented test override "set to 0 to force sweep on
  // every UserPromptSubmit" did nothing. Parse only when the env var is set
  // and non-empty; otherwise keep the 10-minute default.
  //
  // v0.2.4 round-3 (business-logic LOW fix): NaN guard added. The prior form
  // `Number(RAW)` parsed CC_STATUS_GC_INTERVAL_MS=abc to NaN, and
  // `now - lastGc >= NaN` is always false → GC never fired → STATE_DIR grew
  // unbounded on a malformed env value. Mirror the STDIN_TIMEOUT_MS form
  // (cc-status.js ~L126): `Math.max(0, Number(x) || 0)` rejects negatives
  // via Math.max AND normalizes NaN to 0 via `|| 0` (so an `abc` override
  // forces sweep on every fire — same observable behavior as the documented
  // `=0` test override, and a better failure mode than "GC silently stops").
  const GC_INTERVAL_RAW = process.env.CC_STATUS_GC_INTERVAL_MS;
  const GC_INTERVAL_MS =
    GC_INTERVAL_RAW !== undefined && GC_INTERVAL_RAW !== ''
      ? Math.max(0, Number(GC_INTERVAL_RAW) || 0)
      : 10 * 60 * 1000;
  const GC_MAX_UNLINKS = 50; // cap per-call unlinks so a single prompt never blocks on thousands
  const GC_TMP_AGE_MS = 5 * 60 * 1000; // orphan .tmp reaping threshold
  const gcSidecar = path.join(STATE_DIR, '.gc');
  const event = payload && payload.hook_event_name;
  if (event === 'UserPromptSubmit') {
    try {
      const now = Date.now();
      let lastGc = 0;
      try {
        lastGc = fs.statSync(gcSidecar).mtimeMs || 0;
      } catch {
        /* no sidecar yet — lastGc stays 0, sweep will fire */
      }
      if (now - lastGc >= GC_INTERVAL_MS) {
        const cutoff = now - INTERRUPTED_RETENTION_MS;
        const tmpCutoff = now - GC_TMP_AGE_MS;
        let unlinked = 0;
        for (const name of fs.readdirSync(STATE_DIR)) {
          if (unlinked >= GC_MAX_UNLINKS) break;
          // v0.4.0 round-2 (CRITICAL data-loss fix): favorites.json lives in
          // STATE_DIR (companion is the sole writer — see
          // companion/extension.ts:FAV_STATE_DIR / docs/FAVORITES-DESIGN.md).
          // It has shape {version,updatedAt,sessions[],files[]} with NO
          // top-level `state` field and NO `since` field, so without an
          // explicit skip the isJson branch below would parse it, find
          // preserved=false + drifted=false, and reap it once mtime is older
          // than INTERRUPTED_RETENTION_MS (7d) — silently deleting the user's
          // entire Favorites collection after a week of no activity (e.g. a
          // vacation). The §GC.favorites test pins this skip explicitly.
          // Lockstep contract: the basename MUST match companion/FAV_FILE's
          // basename; test-contract-sync.mjs §STATE_DIR pins the dir equality,
          // and the literal "favorites.json" is pinned by test-favorites.mjs
          // FAV.4 (form-only) + this new §GC.favorites test (behavioral).
          if (name === 'favorites.json') continue;
          // v0.2.7 (Q1 fix): isTokens MUST be tested BEFORE isJson — the file
          // `<sid>.tokens.json` ends with `.json` so the bare isJson check would
          // otherwise match it, then JSON.parse would treat it as a state file
          // (no .state field → fall through to prune, accidentally reaping the
          // very snapshot we just wrote). The strict order isTokens → isJson →
          // isTmp → isOffset → isForceReread is now load-bearing; the
          // §GC.Q1.isTokensOrder test pins it. Mirrors the priority discipline
          // already in place for isOffset vs isJson (a path that ends in BOTH
          // .offset and would otherwise be mis-classified).
          const isTokens = name.endsWith(TOK_TOKENS_EXT);
          const isJson = !isTokens && name.endsWith('.json');
          const isTmp = !isTokens && !isJson && name.endsWith('.tmp');
          // v0.2.4: also reap stale token sidecars `<sid>.offset` whose
          // matching `.json` is being pruned (interrupted-preservation still
          // honors the .json parse and skips interrupted → the .offset for an
          // interrupted session is also kept so the user can re-inspect totals
          // after a crash).
          // v0.2.7 (Q1 fix): .offset GC changed to PURE mtime rule. The prior
          // "look up matching .json; reap if .json is gone/stale" rule was
          // correct PRE-Q1 (when SessionEnd deleted both .json AND .offset
          // atomically). Post-Q1, SessionEnd deletes ONLY .json — .offset is
          // intentionally preserved across restart so the next resume picks up
          // the cumulative read cursor. The old rule would now see "no .json"
          // immediately after SessionEnd and reap the .offset as an "orphan",
          // destroying the cumulative state we just fought to keep. Pure mtime
          // closes the gap: reap .offset only when staler than
          // INTERRUPTED_RETENTION_MS (now 7d), regardless of .json presence.
          // This matches .forcereread / .tokens.json's mtime-only contract.
          // v0.2.4 critical-fix follow-up: also reap orphan `<sid>.forcereread`
          // markers (QuickPick "Reset session stats" writes one; if the user
          // resets then closes CC before the next hook fire consumes it, the
          // marker would otherwise linger forever). Same mtime rule as .offset.
          const isOffset = !isTokens && !isJson && !isTmp && name.endsWith('.offset');
          const isForceReread = !isTokens && !isJson && !isTmp && !isOffset && name.endsWith(TOK_FORCEREREAD_EXT);
          // v0.3.0 (lane D): GC <sid>.rate sidecar (IIFE-owned; cross-reload
          // ring buffer snapshot for the tok/s sparkline + chart webview).
          // NO collision risk with .json/.tokens.json (extension is literally
          // ".rate", not a double-suffix), but we mirror the strict-order
          // discipline of isTokens/isOffset for consistency + future-proofing
          // (a hypothetical ".rate.json" later would still need the order).
          // Pure mtime rule — same as .offset/.forcereread/.tokens.json (7d).
          // The IIFE is the sole writer (atomic tmp+rename at most every 2s
          // when state==='running'); the hook GCs but never reads this file.
          const isRate = !isTokens && !isJson && !isTmp && !isOffset && !isForceReread && name.endsWith('.rate');
          // v0.2.4 round-2 (data-logic LOW): the prior `if (name === '.gc')
          // continue;` was unreachable dead code — `.gc` does not end with
          // .json/.tmp/.offset/.forcereread, so the line above already
          // `continue`s past it. Even `.gc.json` / `.gc.tmp` would not match
          // the strict `name === '.gc'` equality check. Removed: the suffix
          // filter is the authoritative gate.
          if (!isTokens && !isJson && !isTmp && !isOffset && !isForceReread && !isRate) continue;
          const p = path.join(STATE_DIR, name);
          // v0.2.4: also skip the current session's .offset sidecar AND
          // .forcereread marker (we may be about to consume/re-write either).
          // The skip check uses the basename without extension so all of
          // `<sid>.json` / `<sid>.offset` / `<sid>.forcereread` /
          // `<sid>.tokens.json` / `<sid>.rate` map to the same logical session.
          // v0.2.7: regex now also strips the `.tokens.json` suffix — note the
          // .tokens.json branch must be greedy over `.json` (regex alternation
          // tries left-to-right, so .tokens.json|json ordering matters: the
          // alternation below lists .tokens.json BEFORE .json so a full match
          // strips both extensions and leaves the bare sid).
          // v0.3.0: alternation extended with `.rate` (IIFE-owned sidecar).
          const baseName = name.replace(/\.(tokens\.json|json|offset|forcereread|rate|tmp)$/, '');
          const currentBase = sid;
          if (baseName === currentBase) continue; // never prune the file we're about to write OR its sidecars
          try {
            let st;
            try {
              st = fs.statSync(p);
            } catch {
              continue; // stat failed — best-effort skip
            }
            if (isTokens) {
              // v0.2.7 (Q1 fix): <sid>.tokens.json GC = pure mtime rule.
              // SessionEnd intentionally preserves this file (it carries the
              // token snapshot the IIFE needs to render non-zero on first
              // post-restart tick). Reap only when staler than
              // INTERRUPTED_RETENTION_MS (now 7d). Mirrors .offset / .forcereread.
              if (st.mtimeMs >= cutoff) continue;
            } else if (isJson) {
              // v0.2.6 round-3 MEDIUM fix (regression §7.5 contract): a drifted
              // Stop payload (inflight=1 drift + cc-status.js:390-401 preserveSince
              // keeps cur.since old + writeJsonAtomic refreshes mtime fresh on
              // every Stop heartbeat) survives the mtime-based GC indefinitely.
              // The prior structure's `if (st.mtimeMs >= cutoff) continue;`
              // skipped fresh-mtime files before parsing, so drifted Stop files
              // were never pruned and disk residue grew unbounded. We now parse
              // every .json once and apply three signals in order:
              //   (a) interrupted-preservation dominates everything (§7.5);
              //   (b) drift-prune: since > GC_DRIFT_SINCE_MS (7d) → prune even
              //       with fresh mtime (the heartbeat-kept-alive case);
              //   (c) default mtime rule: fresh enough → keep, else prune.
              // Parse failure on a corrupt/empty file falls through to prune —
              // a corrupt file has no diagnostic value and the reader already
              // skips it (the prior mtime-shortcut accidentally rescued fresh
              // corrupt files; we now intentionally drop them when stale, which
              // matches the documented intent at the original parse site).
              let preserved = false;
              let drifted = false;
              let parsed = null;
              try {
                parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
                if (parsed && parsed.state === 'interrupted') preserved = true;
                const sinceMs = parsed && Number.isFinite(parsed.since) ? parsed.since : 0;
                drifted = sinceMs > 0 && now - sinceMs > GC_DRIFT_SINCE_MS;
              } catch {
                /* corrupt JSON — preserved/drifted stay false → fall through */
              }
              // (a) interrupted-preservation wins regardless of mtime or drift.
              if (preserved) continue;
              // (b)+(c) fresh mtime keeps the file UNLESS drift says otherwise.
              if (st.mtimeMs >= cutoff && !drifted) continue;
              // TOCTOU narrow: re-stat right before unlink; if another process
              // wrote the file between our first stat and now (mtimeMs moved
              // forward), keep it — they just refreshed it.
              try {
                const st2 = fs.statSync(p);
                if (st2.mtimeMs > st.mtimeMs) continue;
              } catch {
                /* re-stat failed — best-effort proceed to unlink */
              }
            } else if (isOffset) {
              // v0.2.7 (Q1 fix): .offset GC now PURE mtime. Pre-Q1 the rule
              // was "reap if older than cutoff AND matching .json is gone or
              // also stale" — correct when SessionEnd deleted both atomically,
              // but Q1 makes SessionEnd delete ONLY .json (preserving .offset
              // for the next resume's cumulative cursor). Under the old rule,
              // a post-SessionEnd orphan .offset would be reaped IMMEDIATELY
              // (no .json present), wiping the cumulative state we just kept
              // — a regression. Pure mtime closes the gap and unifies with
              // .tokens.json / .forcereread (all three are post-SessionEnd
              // survivors, all three reap on mtime only).
              if (st.mtimeMs >= cutoff) continue;
            } else if (isForceReread) {
              // .forcereread marker GC: same mtime rule as .offset. These are
              // tiny marker files written by QuickPick reset; if the user
              // resets then closes CC before the next hook fire consumes the
              // marker, it lingers — reap on the same 7d schedule.
              if (st.mtimeMs >= cutoff) continue;
            } else if (isRate) {
              // v0.3.0 (lane D): <sid>.rate GC = pure mtime rule. IIFE-owned
              // sidecar (atomic tmp+rename at most every 2s when running),
              // NOT read by the hook — sole purpose here is disk hygiene.
              // Cross-reload continuity is a nice-to-have: losing this just
              // means the sparkline/rate restarts from 0 next session, which
              // is semantically correct (rate is a "now" metric, not a
              // cumulative). Reap on the same 7d schedule as .offset /
              // .tokens.json / .forcereread for unified post-SessionEnd
              // survivor discipline.
              if (st.mtimeMs >= cutoff) continue;
            } else {
              // .tmp orphan: reap only if older than GC_TMP_AGE_MS (a legitimate
              // renameSync in flight is subsecond; 5 min is well past any
              // reasonable hold). No TOCTOU narrowing needed — a tmp file is by
              // definition not the target of any renameSync.
              if (st.mtimeMs >= tmpCutoff) continue;
            }
            try {
              fs.unlinkSync(p);
              unlinked++;
            } catch {
              /* best-effort per-file */
            }
          } catch {
            /* best-effort per-file */
          }
        }
        // Touch the sidecar so subsequent prompts within GC_INTERVAL_MS skip.
        // Best-effort: a failed touch just means the next prompt re-sweeps
        // (cheap on a healthy dir).
        try {
          fs.writeFileSync(gcSidecar, String(now));
        } catch {
          /* non-fatal */
        }
      }
    } catch {
      /* STATE_DIR missing / unreadable — nothing to prune */
    }
  }

  // --- Read current on-disk status (read-modify-write for activeSubagents + pending) ---
  // Missing/corrupt file or any read error -> benign defaults, stay silent.
  // Default state='running' (NOT 'idle') because a SubagentStop arriving with
  // no prior file should fall back to 'running' — subagents only exist within
  // a running turn. The writer contract (header line 13) forbids persisting
  // 'idle'; the explicit curState bound in deriveStatus enforces it regardless.
  // pending is loaded into cur (background events like SubagentStart/Stop
  // write `pending: cur.pending === true` and preserve the flag across
  // background events). Coerced to a strict boolean — a hand-edited / corrupt
  // file with `pending: "true"` (string) or `pending: 1` must NOT read as
  // truthy here (the reader's `j.pending === true` check would disagree).
  //
  // RMW race hazard (documented): the read-modify-write sequence is NOT atomic
  // across processes. The counter (activeSubagents) race is bounded by Method
  // B payload correction on every event that carries background_tasks, and is
  // clamped at 0, so drift has no functional effect on the reader. The SAME
  // race equally applies to `pending`, which has NO correcting signal — a
  // Notification (writes pending:true) racing a SubagentStop (preserves
  // cur.pending===false) for the same session means last-rename-wins, and if
  // SubagentStop renames last the commandCenter blue light is false-cleared
  // for the duration of the open prompt. The drift is BOUNDED: the next
  // user-driven event (UserPromptSubmit / Pre/PostToolUse / Stop / StopFailure)
  // OR a re-fired Notification from CC corrects it within one user action.
  // A structural fix would be a separate <sid>.pending sidecar written only
  // by Notification, but for a UI status flag the documented bound is the
  // pragmatic bar.
  let cur = { state: 'running', activeSubagents: 0, since: 0, pending: false, cwd: undefined, tokens: undefined };
  try {
    const prev = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    cur = {
      state: prev.state || 'running',
      // since must be a finite non-negative number — reject negative numbers
      // (would make `now - since` huge and instantly false-aged done to idle)
      // and strings/other types from a hand-edited / corrupt file (would make
      // `now - since` NaN, which fails the >DONE_TO_IDLE_MS check silently).
      since: typeof prev.since === 'number' && Number.isFinite(prev.since) && prev.since >= 0 ? prev.since : 0,
      error: prev.error,
      // Reject negative and non-finite counters (see deriveStatus note).
      activeSubagents: Number.isFinite(prev.activeSubagents) && prev.activeSubagents >= 0 ? prev.activeSubagents : 0,
      // Strict boolean coercion: only literal `true` on disk counts as pending.
      pending: prev.pending === true,
      // v0.2.4: cwd pass-through (string or undefined). Used by the IIFE tooltip
      // so the user can see which project the token count belongs to.
      cwd: typeof prev.cwd === 'string' ? prev.cwd : undefined,
      // v0.2.4 (data-logic HIGH fix): carry forward prev.tokens verbatim. The
      // cur object literal previously omitted this field, so every non-
      // TOK_EVENTS event (Notification / SubagentStart / StopFailure) wrote a
      // status file with no tokens field — the IIFE tick on the next 500ms
      // read <sid>.json and found no tokens, dropping the token SBI to its
      // "$(clock) —" placeholder for one tick. A permission prompt, question,
      // or any Notification event therefore flickered the SBI once per fire.
      // Carrying forward is correct because deriveTokensField's output is an
      // immutable snapshot shape — the next TOK_EVENTS fire overwrites it
      // atomically. The else-branch below (`else if (cur.tokens)`) already
      // expected cur.tokens to exist; without this load it was dead code.
      tokens: prev.tokens && typeof prev.tokens === 'object' ? prev.tokens : undefined,
    };
  } catch {
    /* no file / corrupt JSON -> default cur */
  }

  // --- Map event -> status action ---
  const status = deriveStatus(payload, cur, Date.now());
  if (status === null) process.exit(0); // event we don't track / not writing

  if (status === DELETE) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* file already absent — nothing to clean up */
    }
    // v0.2.7 (Q1 fix): SessionEnd no longer removes <sid>.offset — research
    // confirmed it was the root cause of tokens loss across VSCode restart:
    // SessionEnd → DELETE → unlinkSync(.offset) wipes the cumulative read
    // cursor (totals/buckets/perTurn/subOffsets); on resume, the next TOK_EVENT
    // fire sees no sidecar → readTranscriptIncremental starts at offset=0 →
    // first-fire tail pre-warm reads only the trailing 256KB (TOK_TAIL_PRESET_BYTES)
    // → the "all" window's cumulative totals are permanently under-counted
    // (only tail rows; non-tail rows are never backfilled because tailWarmed
    // is also gone). patch.ts:267-272 already documented this exact bug class
    // for the QuickPick "Reset session stats" path ("deleting it zeroed
    // ctx.buckets on the next fire... already-merged subagent tokens...
    // permanently lost"). SessionEnd walked the same dead path; we close it
    // now. The .offset stays on disk and is reclaimed by the GC sweep on the
    // mtime rule (see the isOffset branch below). <sid>.tokens.json (the Q1
    // display snapshot) is likewise preserved — see writeJsonAtomic(<sid>.json)
    // below where the tokens snapshot is written each fire.
    //
    // v0.2.4 historical note: the original "SessionEnd also removes the token
    // offset sidecar so it doesn't leak after a clean session exit" comment
    // was correct about leakage but wrong about timing — the GC sweep already
    // reaps stale .offset/.tokens.json after INTERRUPTED_RETENTION_MS (now 7d,
    // see the UserPromptSubmit GC branch), so explicit deletion at SessionEnd
    // was redundant AND destroyed the cumulative state needed for the very
    // next resume. The GC path is the single source of truth now.
    //
    // NOTE: the sidecar path is <sid>.offset (NOT <sid>.json.offset). filePath
    // ends in ".json" so we can't append TOK_OFFSET_EXT to it — build from sid.
    // Also remove any orphan <sid>.forcereread marker (QuickPick reset may
    // have written one and the user closed the session before it fired). The
    // marker is a one-shot instruction (consumed on the next fire or dropped
    // when the session ends), so deletion here is correct — but the .tokens
    // snapshot is NOT a one-shot and MUST survive (the next resume reads it
    // immediately on the first tick before any TOK_EVENT fire).
    try {
      fs.unlinkSync(path.join(STATE_DIR, sid + TOK_FORCEREREAD_EXT));
    } catch {
      /* marker already absent — fine */
    }
    process.exit(0);
  }

  // v0.2.4: attach cwd to the status so the IIFE can show the project path.
  // Prefer payload.cwd (authoritative), fall back to cur.cwd (prior file).
  status.cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : cur.cwd;

  // v0.2.5 round-2 (MEDIUM): carry forward transcript_path so the IIFE's
  // computeLiveDelta (patch.ts §G tick) can locate the parent jsonl
  // AUTHORITATIVELY instead of reverse-deriving it via the cwd-escape rule
  // (which the hook itself distrusts — see cc-status.js:1502-1507). CC tells
  // us exactly where the transcript lives on every TOK_EVENT fire; persisting
  // it lets the IIFE skip the fragile escape rule entirely on fresh turns.
  // Fallback chain: payload.transcript_path (this fire) → cur.transcript_path
  // (prior fire's carry-forward) → undefined (old <sid>.json written before
  // this fix → IIFE falls back to its escape rule, which still matches
  // current on-disk dirs).
  status.transcript_path =
    typeof payload.transcript_path === 'string' && payload.transcript_path
      ? payload.transcript_path
      : cur.transcript_path;

  // v0.2.4: token incremental read. Fire on the 5 events most likely to
  // catch every assistant flush:
  //   PostToolUse      — heartbeat after each tool call (best coverage)
  //   Stop             — terminal calibration (R2: CC may not have flushed
  //                      the last assistant line yet; UserPromptSubmit below
  //                      is the safety net)
  //   SubagentStop     — pull subagent transcript via agent_transcript_path
  //                      and merge into parent sid's totals (so the user sees
  //                      the full billed cost)
  //   UserPromptSubmit — R2 fallback: catches the previous turn's tail the
  //                      Stop event missed
  //   PreToolUse       — heartbeat before each tool call (catches tool
  //                      output induced assistant messages)
  // Notification / SessionStart / SessionEnd / SubagentStart / StopFailure
  // are intentionally excluded — they don't coincide with new assistant
  // message flushes, and skipping them bounds the per-turn hook overhead.
  const TOK_EVENTS = {
    PostToolUse: 'main',
    Stop: 'main',
    UserPromptSubmit: 'main',
    PreToolUse: 'main',
    SubagentStop: 'sub',
  };
  if (TOK_EVENTS[event]) {
    try {
      const source = TOK_EVENTS[event];
      // Carry-forward baseline (data-logic LOW fix): unconditional pre-write
      // tokens = cur.tokens, so a readTranscriptIncremental null return
      // (stat failure / size=0 / file missing) cannot silently strip the
      // tokens field from the file. The non-TOK_EVENTS branch below does the
      // same carry implicitly; the TOK_EVENT branch previously relied on
      // ctx being non-null AND tokensField being computed, which dropped
      // tokens on a transient read failure. With this baseline a failed read
      // at worst shows a stale value for one tick (then the next successful
      // fire overwrites).
      if (cur.tokens) status.tokens = cur.tokens;
      // QuickPick "Reset session stats" writes a <sid>.forcereread marker to
      // ask the next fire to do a FULL re-read (bypassing the tail pre-warm).
      // The marker is consumed regardless of which event triggers the fire.
      // Only meaningful for the MAIN source — QuickPick reset targets the
      // parent transcript; subagent reads ignore the flag.
      let forceFull = false;
      if (source === 'main') {
        const markPath = path.join(STATE_DIR, sid + TOK_FORCEREREAD_EXT);
        try {
          if (fs.existsSync(markPath)) {
            forceFull = true;
            fs.unlinkSync(markPath);
          }
        } catch {
          /* best-effort — leave the marker if unlink failed so a later fire retries */
        }
      }
      // SubagentStop: pull the subagent's transcript + attribute to parent.
      // Sidechain rows in the parent transcript are already skipped by
      // readTranscriptIncremental, so adding the subagent transcript here
      // does NOT double-count. Per-source offset isolation (subOffsets) keeps
      // the subagent's read cursor separate from the parent's — previously
      // both shared ctx.offset and SubagentStop could corrupt the parent's
      // cumulative state (critical fix).
      //
      // Round-2 e2e-correctness fix: the source key was previously truncated
      // to the first 8 hex chars of the basename's hex run, so two subagents
      // whose UUID basenames share the first 8 hex chars collided into the
      // same ctx.subOffsets['sub:<id8>'] slot — the second subagent picked up
      // the first's cursor and either silently dropped its rows (older than
      // lastTs) or read mid-row (mostly JSON.parse failures, but a few random
      // alignments emit bogus entries). Probability was ~1 in 2^32 per pair
      // of UUIDs, low but the failure mode is silent and unrecoverable.
      //
      // v0.2.4 round-3 (data-loss MEDIUM fix): the round-2 fix removed the
      // 8-char truncation but kept the regex extraction /([0-9a-fA-F]{8,})/
      // which keys by the LONGEST hex SUBSTRING of the basename. Two agent
      // transcripts whose basenames share the same hex run (e.g.
      // 'task_<hex>.jsonl' and 'worker_<hex>.jsonl' with the same hex) still
      // collide into the same ctx.subOffsets['sub:<hex>'] slot. CC's pure-UUID
      // transcripts don't normally collide, but the failure mode is silent,
      // unrecoverable, and undetectable. Resolution: use the FULL basename
      // (minus .jsonl extension) as the source key — there is no memory cost
      // (one cursor object per agent either way) and the collision class is
      // eliminated entirely. The basename is already disambiguated by CC's
      // unique per-agent naming; no further hashing needed.
      let ctx = null;
      if (event === 'SubagentStop' && payload.agent_transcript_path) {
        let agentId = 'unknown';
        try {
          const base = path.basename(payload.agent_transcript_path, '.jsonl');
          if (base) agentId = base; // full basename — no regex/truncation
        } catch {
          /* ignore */
        }
        ctx = readTranscriptIncremental(sid, payload.agent_transcript_path, 'sub:' + agentId);
      } else if (event !== 'SubagentStop') {
        // Only read the parent transcript for non-SubagentStop events.
        // v0.2.4 (e2e HIGH + data-logic MEDIUM + business-logic MEDIUM fix,
        // three dim review convergent): the prior `else` branch fell through
        // to readTranscriptIncremental(sid, payload.transcript_path, source,
        // {forceFull}) with source still === 'sub' (TOK_EVENTS['SubagentStop']
        // = 'sub'). When SubagentStop fired WITHOUT agent_transcript_path
        // (older CC versions / CC bug / agent transcript not yet created /
        // future schema change) the parent transcript was read with source
        // 'sub', which (a) created a ctx.subOffsets['sub'] cursor that did
        // NOT advance the MAIN cursor ctx.offset, so the next PostToolUse /
        // Stop / UserPromptSubmit re-read the same bytes and double-counted
        // every parent token (e2e HIGH: tested at 500/250 → next fire 1000/
        // 500); (b) polluted ctx.subOffsets['sub'] (bare key, no agentId)
        // so a later genuine SubagentStop collided into the same slot. The
        // correct behavior is to SKIP the read entirely — SubagentStop
        // without agent_transcript_path carries no subagent data, and the
        // parent's incremental bytes will be picked up by the next MAIN
        // event (PostToolUse / Stop / UserPromptSubmit / PreToolUse). ctx
        // stays null and the carry-forward baseline above preserves the
        // prior tokens field on disk (no flicker).
        ctx = readTranscriptIncremental(sid, payload.transcript_path, source, { forceFull });
      }
      // else: SubagentStop without agent_transcript_path → ctx stays null,
      // tokens carry-forward baseline keeps the last-known value.
      // v0.2.5 (problem 3a fix): scan ALL subagent transcripts at every
      // TOK_EVENT so in-flight subagents become visible without waiting for
      // SubagentStop. See scanSubagentTranscripts JSDoc above for the design.
      // Idempotent with the SubagentStop path via per-source offset isolation.
      if (ctx) {
        try {
          ctx = scanSubagentTranscripts(sid, payload, ctx);
        } catch {
          /* scan failure must not abort the fire — best-effort visibility */
        }
      }
      if (ctx) {
        const rates = loadRates();
        const tokensField = deriveTokensField(ctx, rates, Date.now());
        if (tokensField) status.tokens = tokensField;
      }
    } catch {
      /* token stats are non-critical — never block the primary status write */
    }
  } else if (cur.tokens) {
    // Carry forward existing tokens field on non-token events (Notification /
    // SubagentStart etc) so the IIFE keeps showing the last-known count.
    status.tokens = cur.tokens;
  }

  // Atomic write; swallow any error so CC is never affected.
  try {
    writeJsonAtomic(filePath, status);
  } catch {
    /* ignore */
  }
  // v0.2.7 (Q1 fix): write an INDEPENDENT token-snapshot file so the IIFE
  // reader can render a non-zero token count IMMEDIATELY after a VSCode
  // restart (SessionStart) — before any TOK_EVENT fire. <sid>.json is the
  // TRANSIENT state carrier (deleted by SessionEnd), so tokens living only
  // inside it would zero on every restart. <sid>.tokens.json survives
  // SessionEnd (only the GC sweep reclaims it after INTERRUPTED_RETENTION_MS=
  // 7d of staleness — see the UserPromptSubmit GC branch). The snapshot
  // mirrors status.tokens VERBATIM (deriveTokensField output — no separate
  // schema to invent) and adds a thin envelope for IIFE freshness display +
  // cross-restart jsonl location. v:1 is the schema anchor for future
  // migrations. Written AFTER <sid>.json so SIGKILL between the two leaves
  // the worst case as "new state + stale tokens" (one tick of stale display,
  // 500ms self-heal on next fire) — NOT "new tokens + stale state" which
  // would lie about state to the reader. Both writes use writeJsonAtomic
  // (tmp + rename) so each is individually atomic.
  if (status.tokens && typeof status.tokens === 'object') {
    try {
      const tokensPath = path.join(STATE_DIR, sid + TOK_TOKENS_EXT);
      const snap = {
        v: 1,
        sid: sid,
        since: typeof status.since === 'number' && Number.isFinite(status.since) ? status.since : 0,
        cwd: typeof status.cwd === 'string' ? status.cwd : undefined,
        transcript_path: typeof status.transcript_path === 'string' ? status.transcript_path : undefined,
        tokens: status.tokens,
        written_at: Date.now(),
      };
      writeJsonAtomic(tokensPath, snap);
    } catch {
      /* snapshot failure must not abort — primary state already written */
    }
  }

  process.exit(0);
}

// Final safety net: never let a rejection escape to CC's stderr.
main().catch(() => process.exit(0));
