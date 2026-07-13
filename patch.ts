#!/usr/bin/env tsx
/**
 * patch.ts — Claude Code tab status-dot patcher
 * ---------------------------------------------------------------------------
 * Patches the installed Claude Code VS Code extension so each session's tab icon
 * reflects per-session state (idle / running / done / interrupted) read from
 * `~/.claude/cc-tab-status/<session_id>.json`, which is written by the hook at
 * `hooks/cc-status.js`. Breathing (running) and fast-flash (interrupted) animations
 * are driven by a self-injected 500 ms redraw timer, because CC itself only
 * redraws the icon on sparse rename_tab events (see DESIGN §2).
 *
 * STATE CONTRACT: the four states, their events, colors and SVGs are defined
 * once in docs/STATES.md (single source of truth). This file, cc-status.js,
 * the SVG filenames and the docs must all stay in sync with it.
 *
 * RUN
 *   tsx patch.ts            # install (discover CC, backup, patch, wire hooks)
 *   tsx patch.ts --revert   # undo everything
 *   tsx patch.ts --status   # dry-run report, no changes
 *   tsx patch.ts --help
 *   # also works: bun run patch.ts  /  npx tsx patch.ts
 *
 * INJECTION STRATEGY (see docs/DESIGN-injection.md for full rationale)
 *   CC's minified extension.js redraws the panel tab icon in ONE place: the
 *   `rename_tab` handler, which only knows hasPendingPermissions /
 *   hasUnseenCompletion and carries NO sessionId. To bridge session→panel we
 *   patch the sibling `update_session_state` handler (same `ts` instance, and
 *   its request DOES carry sessionId) to stash `this.__ccSid` and start a
 *   500 ms setInterval that reads the external state file and asserts the
 *   icon. A second no-op-guarded copy of the starter is placed in the
 *   rename_tab handler to eliminate the ~500 ms flash after CC re-asserts its
 *   own icon (DESIGN §4.2, optional hardening).
 *
 *   The injected code references ZERO minified identifiers (no `ue`/`dn`/`r`);
 *   it only uses `require("fs"|"path"|"vscode"|"os")`, `this`, and `Date`. The
 *   only version-sensitive surface is therefore the two anchor strings below,
 *   which are asserted to match exactly once before any byte is written.
 *
 * SVG WIRING (DESIGN §5 — Option A: absolute path to project resources/)
 *   Our 5 SVGs (claude-logo-idle/running/running-bright/done/error.svg) live in
 *   this project's resources/ and are referenced by absolute path — so a CC
 *   auto-update (which wipes the extension dir) only requires re-running this
 *   patcher, never re-copying art. The interrupted "off-frame" reuses CC's own
 *   claude-logo.svg via this.context.extensionPath.
 *
 * LIMITATIONS (read before extending)
 *   - If the CC extension updates and the minified anchor strings drift, the
 *     patcher will refuse to write and ask the user to file an issue. It never
 *     partially mutates extension.js.
 *   - settings.json is round-tripped through JSON.parse/stringify, which drops
 *     comments. The original is preserved as settings.json.cc-status-dot.bak
 *     on first run. Revert does surgical marker-based removal (not a restore),
 *     so subsequent manual edits survive.
 *   - Each CC panel instance runs its own 500 ms timer (N tabs = N timers).
 *     Each tick is one tiny readFileSync; acceptable for normal use.
 * ------------------------------------------------------------------------- */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Project root = directory this script lives in (resources/ and hooks/ live here). */
const PROJECT_ROOT: string =
    typeof __dirname !== "undefined" && __dirname
        ? __dirname
        : path.dirname(path.resolve(process.argv[1] ?? process.cwd()));

/** Substring baked into the injected JS block. Presence in extension.js === "already patched".
 *  MUST be a block comment (/* *​/) — a // line comment would comment out the rest of the
 *  minified single line and brick the extension. */
const INJECT_MARKER = "cc-status-dot-injected";

/** Substring appended (as a shell comment) to every hook command we own in settings.json.
 *  Used for idempotent dedupe on install and surgical removal on --revert. */
const HOOK_MARKER = "cc-status-dot-managed";

/** Redraw cadence (ms). 500 = smooth breathing without meaningful fs overhead. */
const TICK_MS = 500;

/** Per-session state directory read by the injected timer. */
const STATE_DIR = path.join(os.homedir(), ".claude", "cc-tab-status");

/** The SVGs the injected timer references from this project's resources/.
 *  MUST stay in sync with docs/STATES.md §1 (single source of truth). */
const OUR_SVGS = [
    "claude-logo-idle.svg",
    "claude-logo-running.svg",
    "claude-logo-running-1.svg",
    "claude-logo-running-2.svg",
    "claude-logo-running-bright.svg",
    "claude-logo-done.svg",
    "claude-logo-error.svg",
];

/** Extension directories to search, highest version wins. */
const SEARCH_DIRS = [
    path.join(os.homedir(), ".vscode", "extensions"),
    path.join(os.homedir(), ".vscode-insiders", "extensions"),
    path.join(os.homedir(), ".vscode-server", "extensions"), // remote/SSH scenarios
    path.join(os.homedir(), ".cursor", "extensions"),
    path.join(os.homedir(), ".vscodium", "extensions"),
];

/** CC hook events that feed session-state transitions to cc-status.js.
 *  MUST equal the event set handled by hooks/cc-status.js (docs/STATES.md §2).
 *  SubagentStart / SubagentStop feed the activeSubagents early-signal counter
 *  (and also carry background_tasks for authoritative correction) so the dot
 *  stays yellow while a workflow / background subagent runs; see
 *  docs/SUBAGENT-design.md §4–§5. Intentionally excludes Notification (CC's
 *  native blue dot handles permission, reader does not override that state) and
 *  SessionStart (no writer case — wiring it would be dead wiring, audit F-5). */
const HOOK_EVENTS = [
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "StopFailure",
    "SessionEnd",
] as const;

// --- Anchor strings (verified byte-exact against CC 2.1.204) ---------------

/**
 * Anchor A — the `update_session_state` handler. Same `ts` (per-panel) instance
 * as rename_tab, and its request carries sessionId. We wrap its body in a block
 * to (1) stash this.__ccSid and (2) start the redraw timer before the original
 * return. Exact, must match ONCE.
 */
const ANCHOR_A =
    'else if(e.request.type==="update_session_state")return this.onSessionStateChanged?.(e.request.sessionId,e.request.state,e.request.title),{type:"update_session_state_response"}';

/**
 * Anchor B — inside the `rename_tab` handler, just after the title is set and
 * before CC chooses its own icon. We insert the same guarded starter here so
 * the timer begins on the very first rename_tab (which can precede the first
 * update_session_state) and so CC's icon assignment is re-asserted within one
 * tick. Exact, must match ONCE.
 */
const ANCHOR_B =
    'this.panelTab.title=e.request.title;let r;if(e.request.hasPendingPermissions)';

// ---------------------------------------------------------------------------
// Logging — plain text, no emojis (kept terminal-friendly & greppable)
// ---------------------------------------------------------------------------

function log(msg: string): void {
    console.log(`[cc-status-dot] ${msg}`);
}
function warn(msg: string): void {
    console.warn(`[cc-status-dot][WARN] ${msg}`);
}
function fail(msg: string): never {
    // Tag anchor problems so the top-level handler can append a version hint.
    if (/anchor/i.test(msg)) throw new Error(`Anchor mismatch: ${msg}`);
    throw new Error(msg);
}

// ---------------------------------------------------------------------------
// JSONC: settings.json may contain // and /* */ comments + trailing commas.
// Strip them with a tiny scanner that respects string literals, then JSON.parse.
// ---------------------------------------------------------------------------

function stripJsonc(text: string): string {
    let out = "";
    let i = 0;
    let inString = false;
    let quote = "";
    while (i < text.length) {
        const c = text[i];
        const next = text[i + 1];
        if (inString) {
            out += c;
            if (c === "\\") {
                // Keep escaped char verbatim.
                out += next ?? "";
                i += 2;
                continue;
            }
            if (c === quote) inString = false;
            i += 1;
            continue;
        }
        if (c === '"' || c === "'") {
            inString = true;
            quote = c;
            out += c;
            i += 1;
            continue;
        }
        if (c === "/" && next === "/") {
            while (i < text.length && text[i] !== "\n") i += 1;
            continue;
        }
        if (c === "/" && next === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
            i += 2;
            continue;
        }
        out += c;
        i += 1;
    }
    // Tolerate trailing commas before } or ].
    return out.replace(/,(\s*[}\]])/g, "$1");
}

function parseJsonc(text: string, sourceLabel: string): Record<string, unknown> {
    try {
        return JSON.parse(stripJsonc(text));
    } catch (e) {
        fail(
            `Could not parse ${sourceLabel} as JSON/JSONC (${(e as Error).message}). ` +
                `Fix it manually, then re-run. No files were changed.`,
        );
    }
}

// ---------------------------------------------------------------------------
// Extension discovery — find the highest-version anthropic.claude-code-* dir
// ---------------------------------------------------------------------------

function cmpVer(a: number[], b: number[]): number {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
}

interface DiscoveredExt {
    dir: string;
    version: string;
}

function discoverExtension(): DiscoveredExt {
    const candidates: { dir: string; version: number[] }[] = [];
    for (const base of SEARCH_DIRS) {
        let entries: string[];
        try {
            entries = fs.readdirSync(base);
        } catch {
            continue; // dir absent or unreadable
        }
        for (const name of entries) {
            // Dir name shape: anthropic.claude-code-<X.Y.Z>-<platform>
            // (publisher "anthropic" + "." + extension "claude-code" + "-<version>"...)
            // Note the hyphen between "claude" and "code" — not a dot.
            const m = name.match(/^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/);
            if (!m) continue;
            const dir = path.join(base, name);
            if (!fs.existsSync(path.join(dir, "extension.js"))) continue;
            candidates.push({ dir, version: [Number(m[1]), Number(m[2]), Number(m[3])] });
        }
    }
    if (candidates.length === 0) {
        fail(
            `No anthropic.claude-code-* (with extension.js) found under:\n` +
                SEARCH_DIRS.map((d) => "  " + d).join("\n") +
                `\nIs the Claude Code extension installed?`,
        );
    }
    candidates.sort((a, b) => cmpVer(b.version, a.version));
    const top = candidates[0];
    if (candidates.length > 1) {
        log(`Multiple CC extensions found; using highest version ${top.version.join(".")} at ${top.dir}`);
    }
    return { dir: top.dir, version: top.version.join(".") };
}

// ---------------------------------------------------------------------------
// Backup helper — copy once, never overwrite an existing .bak (keep original)
// ---------------------------------------------------------------------------

function backupOnce(srcPath: string, bakPath: string): boolean {
    if (fs.existsSync(bakPath)) {
        log(`backup already exists: ${path.basename(bakPath)}`);
        return false;
    }
    // Nothing to back up if the source doesn't exist yet (e.g. first-created
    // settings.json). In that case there's no original to preserve.
    if (!fs.existsSync(srcPath)) return false;
    fs.copyFileSync(srcPath, bakPath);
    log(`backed up → ${path.basename(bakPath)}`);
    return true;
}

function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let n = 0;
    let i = 0;
    while ((i = haystack.indexOf(needle, i)) !== -1) {
        n += 1;
        i += needle.length;
    }
    return n;
}

// ---------------------------------------------------------------------------
// Build the injected IIFE. Single line, version-robust, no minified refs.
//   t = the `ts` panel instance (has panelTab, context.extensionPath).
//   Reads ~/.claude/cc-tab-status/<sid>.json -> {state, since, error?}
//   State machine + notification mirror docs/STATES.md §1/§4/§4b — keep in sync.
//     running     -> 4-frame triangle wave (6 steps, 3s period) over running/-1/-2/-bright
//     interrupted -> flash claude-logo-error.svg <-> CC's claude-logo.svg (off-frame)
//     done        -> steady claude-logo-done.svg; if since older than 5 min -> idle
//     idle        -> steady claude-logo-idle.svg
//     missing/unknown -> return (don't fight CC's own pending/done icon)
//   On running->done/interrupted transition: notify (VSCode msg + macOS osascript
//   when unfocused). Config: ccStatusDot.{notify,notifyWhenFocused,notifySound}.
// ---------------------------------------------------------------------------

function buildIIFE(resDir: string): string {
    // JSON.stringify yields a safely-quoted, escaped JS string literal for the path
    // (also handles the non-ASCII chars in the project path correctly).
    const resLiteral = JSON.stringify(resDir);
    // State machine + notification mirror docs/STATES.md §1/§4/§4b. Keep in sync.
    return [
        `/*${INJECT_MARKER}*/`,
        `(function(t){`,
        `if(t.__ccDotStarted||!t.panelTab)return;`,
        `t.__ccDotStarted=true;`,
        `var fs=require("fs"),pth=require("path"),vs=require("vscode"),os=require("os");`,
        `var DIR=pth.join(os.homedir(),".claude","cc-tab-status");`,
        `var RES=${resLiteral};`,
        `var CC_DEFAULT=pth.join(t.context.extensionPath,"resources","claude-logo.svg");`,
        `var DONE_TO_IDLE_MS=5*60*1000;`,
        `var RUN_FRAMES=["claude-logo-running.svg","claude-logo-running-1.svg","claude-logo-running-2.svg","claude-logo-running-bright.svg","claude-logo-running-2.svg","claude-logo-running-1.svg"];`,
        `var seq=0,prevSt=null;`,
        `function notify(st,err){`,
        `var c=vs.workspace.getConfiguration("ccStatusDot");`,
        `if(!c.get("notify",true))return;`,
        `var focused=vs.window.state.focused;`,
        `if(focused&&!c.get("notifyWhenFocused",false))return;`,
        `var msg,sev;`,
        `if(st==="done"){sev="info";msg="Claude Code: turn complete"}`,
        `else{sev="warn";var m={rate_limit:"rate limit reached",overloaded:"server overloaded"}[err]||err||"interrupted";msg="Claude Code: "+m}`,
        `if(t.__ccTitle)msg+=" ["+t.__ccTitle+"]";`,
        `if(focused){if(sev==="info")vs.window.showInformationMessage(msg,"Dismiss");else vs.window.showWarningMessage(msg,"Dismiss")}`,
        `else{if(sev==="info")vs.window.showInformationMessage(msg);else vs.window.showWarningMessage(msg);`,
        `if(os.platform()==="darwin"){var snd=c.get("notifySound","Glass");var sndStr=snd?(' sound name "'+snd+'"'):'';try{require("child_process").execFile("osascript",["-e",'display notification "'+msg+'" with title "Claude Code"'+sndStr])}catch(e){}}}`,
        `}`,
        `setInterval(function(){`,
        `var p=t.panelTab;if(!p)return;`,
        `var sid=t.__ccSid;if(!sid)return;`,
        `var st=null,since=null,err="";`,
        `try{var j=JSON.parse(fs.readFileSync(pth.join(DIR,sid+".json"),"utf8"));st=j.state;since=j.since;err=j.error||""}catch(e){}`,
        `if(prevSt&&prevSt!==st&&(st==="done"||st==="interrupted")){try{notify(st,err)}catch(e){}}`,
        `if(st)prevSt=st;`,
        `try{var files=fs.readdirSync(DIR);var arr=[];for(var fi=0;fi<files.length;fi++){if(!files[fi].endsWith(".json"))continue;var fsid=files[fi].slice(0,-5);try{var jj=JSON.parse(fs.readFileSync(pth.join(DIR,files[fi]),"utf8"));arr.push({sid:fsid,state:jj.state,title:jj.title||"",since:jj.since||0})}catch(e){}}if(t.webview&&t.webview.postMessage){t.webview.postMessage({type:"cc_status_bar",currentSid:t.__ccSid,sessions:arr})}}catch(e){}`,
        `if(!t.__ccFocusWired&&t.webview&&t.webview.onDidReceiveMessage){t.__ccFocusWired=true;t.webview.onDidReceiveMessage(function(m){if(m&&m.type==="cc_focus_session"&&m.sessionId){try{vs.commands.executeCommand("claude-vscode.editor.open",m.sessionId)}catch(e){}}})}`,
        `var now=Date.now();`,
        `var svg;`,
        `if(st==="interrupted"){svg=(seq%2===0)?pth.join(RES,"claude-logo-error.svg"):CC_DEFAULT}`,
        `else if(st==="running"){svg=pth.join(RES,RUN_FRAMES[seq%6])}`,
        `else if(st==="done"){svg=(since&&(now-since>DONE_TO_IDLE_MS))?pth.join(RES,"claude-logo-idle.svg"):pth.join(RES,"claude-logo-done.svg")}`,
        `else if(st==="idle"){svg=pth.join(RES,"claude-logo-idle.svg")}`,
        `else{return}`,
        `seq++;`,
        `try{p.iconPath=vs.Uri.file(svg)}catch(e){}`,
        `},${TICK_MS});`,
        `})(this)`,
    ].join("");
}

// ---------------------------------------------------------------------------
// Patch / restore extension.js
// ---------------------------------------------------------------------------

function isExtensionPatched(content: string): boolean {
    return content.includes(INJECT_MARKER);
}

function patchExtension(extDir: string): void {
    const extJs = path.join(extDir, "extension.js");
    if (!fs.existsSync(extJs)) fail(`extension.js not found in ${extDir}`);

    const src = fs.readFileSync(extJs, "utf8");
    if (isExtensionPatched(src)) {
        log("extension.js already patched — skipping injection");
        return;
    }

    // Validate anchors BEFORE creating any backup or writing anything, so a
    // failed run leaves zero footprint on disk (no half-written file, no .bak).
    const aCount = countOccurrences(src, ANCHOR_A);
    if (aCount !== 1) {
        fail(
            `Anchor A (update_session_state handler) matched ${aCount} time(s), expected 1. ` +
                `The CC extension has likely changed. No files were modified.`,
        );
    }
    const bCount = countOccurrences(src, ANCHOR_B);
    if (bCount > 1) {
        fail(
            `Anchor B (rename_tab icon branch) matched ${bCount} times, expected 0 or 1. ` +
                `No files were modified.`,
        );
    }
    if (bCount === 0) {
        warn("Anchor B not found — installing with Anchor A only (~500 ms flash may occur after CC rename_tab).");
    }

    // One-time original backup, only after we know injection will succeed.
    backupOnce(extJs, extJs + ".bak");

    const iife = buildIIFE(path.join(PROJECT_ROOT, "resources"));

    // Anchor A: splice side effects into the return expression via the comma operator.
    // IMPORTANT: we must NOT wrap the consequent in a block. The original chain is
    //   `else if(update_session_state)return ...,{...};else if(show_notification){...}`
    // where the trailing `;` ends the ReturnStatement and the following `else` still
    // binds to this if. If we replaced the consequent with `{...}` the `};` would
    // complete the IfStatement and orphan the next `else` → SyntaxError. Keeping the
    // consequent as a single `return a,b,c,d` expression preserves the binding.
    const replA =
        'else if(e.request.type==="update_session_state")return ' +
        "this.__ccSid=e.request.sessionId,this.__ccTitle=e.request.title," +
        iife +
        ',this.onSessionStateChanged?.(e.request.sessionId,e.request.state,e.request.title),{type:"update_session_state_response"}';

    let next = src.replace(ANCHOR_A, replA);
    if (!next.includes(INJECT_MARKER)) fail("Anchor A replacement did not apply. No files were modified.");

    // Anchor B (optional hardening): start the same guarded timer from rename_tab too.
    if (bCount === 1) {
        const replB = "this.panelTab.title=e.request.title;" + iife + ";let r;if(e.request.hasPendingPermissions)";
        next = next.replace(ANCHOR_B, replB);
        if (countOccurrences(next, INJECT_MARKER) < 2) {
            fail("Anchor B replacement did not apply. No files were modified.");
        }
    }

    fs.writeFileSync(extJs, next, "utf8");
    log(`patched extension.js (anchors injected: A${bCount === 1 ? "+B" : " only"})`);
}

function restoreExtension(extDir: string): void {
    const extJs = path.join(extDir, "extension.js");
    const bak = extJs + ".bak";
    if (!fs.existsSync(bak)) {
        log("no extension.js.bak found — extension.js was not patched by this tool (nothing to restore)");
        return;
    }
    fs.copyFileSync(bak, extJs);
    log("restored extension.js from extension.js.bak");
    // Intentionally keep extension.js.bak as a safety net.
}

// ---------------------------------------------------------------------------
// Webview patch — aggregate status bar (see docs/WEBVIEW-injection.md)
//   Patches webview/index.js (stash acquireVsCodeApi + inject bar IIFE) and
//   webview/index.css (bar styles). Different files from extension.js, zero
//   overlap with the iconPath patch.
// ---------------------------------------------------------------------------

/** Regex matching CC's single acquireVsCodeApi() call site. Captures the
 *  minified var names so we only depend on the stable API name. Must hit 1x. */
const ACQUIRE_RE = /let (\w+)=acquireVsCodeApi\(\),(\w+)=new (\w+)\(\1\)/;

/** Idempotency markers (presence === already patched). */
const WV_JS_MARKER = "cc-status-bar-injected";
const WV_API_MARKER = "window.__ccVsApi=";
const WV_CSS_MARKER = "cc-status-bar-css";

function buildWebviewJsIIFE(): string {
    // Vanilla DOM bar, mounted on document.body (outside React tree → zero
    // reconcile interference). Reads state via postMessage bridge from the
    // extension.js IIFE. See docs/WEBVIEW-injection.md §6.B.
    return [
        `/*${WV_JS_MARKER}*/`,
        `(function(){`,
        `if(window.__ccBarStarted)return;window.__ccBarStarted=true;`,
        `if(window.IS_SESSION_LIST_ONLY)return;`,
        `var API=window.__ccVsApi;if(!API)return;`,
        `var COLORS={idle:"#808080",running:"#CCA700",done:"#3FB950",interrupted:"#F85149"};`,
        `var bar=document.createElement("div");bar.id="cc-status-bar";`,
        `bar.style.cssText="position:fixed;bottom:0;right:0;display:flex;gap:4px;padding:4px 6px;z-index:10001;";`,
        `var hideT=null;`,
        `function mount(){if(!document.body){setTimeout(mount,50);return;}document.body.appendChild(bar);hideT=setTimeout(function(){bar.style.display="none";},2000);}`,
        `if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mount);else mount();`,
        `function render(p){if(hideT){clearTimeout(hideT);hideT=null;}bar.style.display="flex";bar.innerHTML="";var ss=p.sessions||[];var cur=p.currentSid;ss.sort(function(a,b){return (b.since||0)-(a.since||0);});for(var i=0;i<ss.length;i++){var s=ss[i];var d=document.createElement("div");d.className="cc-status-dot";d.style.background=COLORS[s.state]||COLORS.idle;d.dataset.state=s.state||"";d.dataset.sid=s.sid;if(s.sid===cur)d.classList.add("cc-status-dot-active");d.title=(s.title||s.sid)+" ["+(s.state||"?")+"]";d.addEventListener("click",function(ev){var sid=ev.currentTarget.dataset.sid;try{API.postMessage({type:"cc_focus_session",sessionId:sid});}catch(e){}});bar.appendChild(d);}}`,
        `window.addEventListener("message",function(ev){var d=ev.data;if(d&&d.type==="cc_status_bar"){try{render(d);}catch(e){}}});`,
        `})();`,
    ].join("");
}

function buildWebviewCss(): string {
    // EOF-append to webview/index.css. z-index 10001 > CC's max 10000.
    // bottom:0 may overlap the input row — tune to bottom:44px if it does.
    return [
        `/*${WV_CSS_MARKER}*/`,
        `#cc-status-bar{position:fixed;bottom:0;right:0;display:flex;flex-direction:row;gap:4px;padding:4px 6px;z-index:10001;background:transparent;pointer-events:none;}`,
        `#cc-status-bar .cc-status-dot{width:10px;height:10px;border-radius:3px;cursor:pointer;pointer-events:auto;opacity:.85;transition:transform .12s,opacity .12s;border:1px solid rgba(0,0,0,.25);}`,
        `#cc-status-bar .cc-status-dot:hover{opacity:1;transform:scale(1.25);}`,
        `#cc-status-bar .cc-status-dot:active{transform:scale(.9);}`,
        `#cc-status-bar .cc-status-dot-active{outline:2px solid #fff;outline-offset:1px;opacity:1;}`,
        `@keyframes cc-breath{0%{filter:brightness(1);}50%{filter:brightness(1.5);}100%{filter:brightness(1);}}`,
        `#cc-status-bar .cc-status-dot[data-state="running"]{animation:cc-breath 1.5s ease-in-out infinite;}`,
    ].join("");
}

function patchWebview(extDir: string): void {
    const wvJs = path.join(extDir, "webview", "index.js");
    const wvCss = path.join(extDir, "webview", "index.css");
    if (!fs.existsSync(wvJs)) { warn("webview/index.js not found — skipping webview patch"); return; }
    if (!fs.existsSync(wvCss)) { warn("webview/index.css not found — skipping webview CSS"); return; }

    // --- index.js: stash acquireVsCodeApi + append bar IIFE ---
    let js = fs.readFileSync(wvJs, "utf8");
    if (js.includes(WV_API_MARKER)) {
        log("webview/index.js already patched — skipping");
    } else {
        const acquireCount = (js.match(/acquireVsCodeApi\(\)/g) || []).length;
        if (acquireCount !== 1) {
            fail(`Expected exactly 1 acquireVsCodeApi() call in webview/index.js, found ${acquireCount}. No files were modified.`);
        }
        const m = js.match(ACQUIRE_RE);
        if (!m) {
            fail(`acquireVsCodeApi() call site regex did not match in webview/index.js (anchor drift). No files were modified.`);
        }
        const repl = `let ${m![1]}=acquireVsCodeApi();window.__ccVsApi=${m![1]};let ${m![2]}=new ${m![3]}(${m![1]})`;
        backupOnce(wvJs, wvJs + ".bak");
        js = js.replace(ACQUIRE_RE, repl) + buildWebviewJsIIFE();
        fs.writeFileSync(wvJs, js, "utf8");
        log("patched webview/index.js (stashed vscode API + injected status bar)");
    }

    // --- index.css: append bar styles ---
    let css = fs.readFileSync(wvCss, "utf8");
    if (css.includes(WV_CSS_MARKER)) {
        log("webview/index.css already patched — skipping");
    } else {
        backupOnce(wvCss, wvCss + ".bak");
        css = css + buildWebviewCss();
        fs.writeFileSync(wvCss, css, "utf8");
        log("patched webview/index.css (status bar styles)");
    }
}

function restoreWebview(extDir: string): void {
    for (const name of ["index.js", "index.css"]) {
        const f = path.join(extDir, "webview", name);
        const bak = f + ".bak";
        if (fs.existsSync(bak)) {
            fs.copyFileSync(bak, f);
            log(`restored webview/${name} from .bak`);
        } else {
            log(`no webview/${name}.bak — was not patched (nothing to restore)`);
        }
    }
}

// ---------------------------------------------------------------------------
// Hooks in ~/.claude/settings.json — idempotent, marker-tagged
// ---------------------------------------------------------------------------

interface HookGroup {
    matcher?: string;
    hooks: { type: string; command: string }[];
}

type HooksMap = Record<string, HookGroup[]>;

function settingsPath(): string {
    return path.join(os.homedir(), ".claude", "settings.json");
}

function hookCommand(hookAbs: string): string {
    // CC pipes the hook JSON via stdin; the script reads hook_event_name from
    // stdin, so no positional arg is needed. `# ${HOOK_MARKER}` is a shell
    // comment — harmless at runtime, greppable for idempotent removal.
    return `node "${hookAbs}"  # ${HOOK_MARKER}`;
}

/** Build our owned hooks entries (one group per event in HOOK_EVENTS). */
function buildOurHooks(hookAbs: string): HooksMap {
    const out: HooksMap = {};
    for (const ev of HOOK_EVENTS) {
        out[ev] = [{ matcher: "", hooks: [{ type: "command", command: hookCommand(hookAbs) }] }];
    }
    return out;
}

/** Does a group contain a command we own? */
function groupIsOurs(g: unknown): boolean {
    if (!g || typeof g !== "object") return false;
    const hooks = (g as HookGroup).hooks;
    if (!Array.isArray(hooks)) return false;
    return hooks.some((h) => typeof h?.command === "string" && h.command.includes(HOOK_MARKER));
}

function wireHooks(): void {
    const settings = settingsPath();
    const hookAbs = path.join(PROJECT_ROOT, "hooks", "cc-status.js");

    let raw = "{}";
    if (fs.existsSync(settings)) raw = fs.readFileSync(settings, "utf8");
    const obj = parseJsonc(raw, settings) as Record<string, unknown>;

    const ourHooks = buildOurHooks(hookAbs);
    const existing = obj.hooks as HooksMap | undefined;
    let changed = false;

    if (!existing || typeof existing !== "object") {
        obj.hooks = ourHooks;
        changed = true;
    } else {
        for (const ev of Object.keys(ourHooks)) {
            const arr = Array.isArray(existing[ev]) ? existing[ev] : (existing[ev] = []);
            const already = arr.some(groupIsOurs);
            if (!already) {
                arr.push(ourHooks[ev][0]);
                changed = true;
            }
        }
    }

    if (!changed) {
        log("settings.json hooks already wired — skipping");
        return;
    }

    backupOnce(settings, settings + ".cc-status-dot.bak");
    fs.writeFileSync(settings, JSON.stringify(obj, null, 2) + "\n", "utf8");
    log(`wrote ${HOOK_EVENTS.length} hook event(s) into ${settings}`);
    if (!fs.existsSync(hookAbs)) {
        warn(`hook target does not exist yet: ${hookAbs}`);
        warn("create it (it receives JSON on stdin, writes ~/.claude/cc-tab-status/<sid>.json).");
    }
}

function unwireHooks(): void {
    const settings = settingsPath();
    if (!fs.existsSync(settings)) {
        log("no settings.json — nothing to revert");
        return;
    }
    const raw = fs.readFileSync(settings, "utf8");
    let obj: Record<string, unknown>;
    try {
        obj = JSON.parse(stripJsonc(raw));
    } catch {
        warn("settings.json unreadable — skipping hook removal (remove entries with " + HOOK_MARKER + " manually)");
        return;
    }
    const hooks = obj.hooks as HooksMap | undefined;
    if (!hooks || typeof hooks !== "object") {
        log("no hooks key in settings.json — nothing to revert");
        return;
    }

    let changed = false;
    for (const ev of Object.keys(hooks)) {
        const arr = hooks[ev];
        if (!Array.isArray(arr)) continue;
        const kept = arr.filter((g) => !groupIsOurs(g));
        if (kept.length !== arr.length) changed = true;
        if (kept.length === 0) delete hooks[ev];
        else hooks[ev] = kept;
    }
    if (Object.keys(hooks).length === 0) delete obj.hooks;

    if (changed) {
        fs.writeFileSync(settings, JSON.stringify(obj, null, 2) + "\n", "utf8");
        log("removed cc-status-dot hook entries from settings.json");
    } else {
        log("no cc-status-dot hook entries found in settings.json");
    }
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function ensureStateDir(): void {
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
    } catch {
        // Non-fatal — the hook is responsible for this dir at runtime too.
    }
}

function checkSvgs(resDir: string): void {
    const missing = OUR_SVGS.filter((f) => !fs.existsSync(path.join(resDir, f)));
    if (missing.length === 0) {
        log(`all ${OUR_SVGS.length} status SVGs present in ${path.relative(PROJECT_ROOT, resDir) || resDir}`);
        return;
    }
    warn(`missing SVGs in ${resDir}:`);
    for (const f of missing) warn(`  - ${f}`);
    warn("The injected timer references these files; the tab icon may go blank for the");
    warn("corresponding state until they are added. See docs/DESIGN-injection.md §5.");
}

function isHooksWired(): boolean {
    const settings = settingsPath();
    if (!fs.existsSync(settings)) return false;
    try {
        return fs.readFileSync(settings, "utf8").includes(HOOK_MARKER);
    } catch {
        return false;
    }
}

function reportStatus(): void {
    const { dir, version } = discoverExtension();
    log(`CC extension: v${version}`);
    log(`  ${dir}`);
    const extJs = path.join(dir, "extension.js");
    const patched = fs.existsSync(extJs) && isExtensionPatched(fs.readFileSync(extJs, "utf8"));
    log(`extension.js patched: ${patched ? "YES" : "no"}`);
    const wvJs = path.join(dir, "webview", "index.js");
    const wvPatched = fs.existsSync(wvJs) && fs.readFileSync(wvJs, "utf8").includes(WV_API_MARKER);
    log(`webview patched (status bar): ${wvPatched ? "YES" : "no"}`);
    log(`hooks wired: ${isHooksWired() ? "YES" : "no"}`);
    checkSvgs(path.join(PROJECT_ROOT, "resources"));
    log(`state dir: ${STATE_DIR} ${fs.existsSync(STATE_DIR) ? "(exists)" : "(will be created on first hook fire)"}`);
}

function printHelp(): void {
    console.log(
        [
            "cc-status-dot patcher",
            "",
            "Usage:",
            "  tsx patch.ts            install patch + wire hooks (idempotent)",
            "  tsx patch.ts --revert   restore extension.js, remove hooks",
            "  tsx patch.ts --status   show detection results, change nothing",
            "  tsx patch.ts --help     this message",
            "",
            "After install/revert, reload VS Code: Cmd+Shift+P → 'Developer: Reload Window'.",
        ].join("\n"),
    );
}

function reloadHint(): void {
    log("Done. Reload VS Code to apply: Cmd+Shift+P → 'Developer: Reload Window'.");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function run(argv: string[]): void {
    const args = argv.slice(2);
    if (args.includes("-h") || args.includes("--help")) {
        printHelp();
        return;
    }
    if (args.includes("--check-iife")) {
        // Dev: dump the injected IIFE string for syntax verification (node --check).
        console.log(buildIIFE(path.join(PROJECT_ROOT, "resources")));
        return;
    }
    if (args.includes("--status")) {
        reportStatus();
        return;
    }
    if (args.includes("--revert")) {
        log("Reverting…");
        const { dir, version } = discoverExtension();
        log(`CC extension v${version}: ${dir}`);
        restoreExtension(dir);
        restoreWebview(dir);
        unwireHooks();
        // Option A (absolute SVG path) copies nothing into CC resources, so there
        // are no SVGs to delete. State dir left in place (user data).
        log("No SVGs were copied into the CC extension dir (absolute-path mode) — nothing to remove there.");
        reloadHint();
        return;
    }

    // Default: install.
    log("Installing…");
    const { dir, version } = discoverExtension();
    log(`CC extension v${version}: ${dir}`);
    ensureStateDir();
    patchExtension(dir);
    patchWebview(dir);
    wireHooks();
    checkSvgs(path.join(PROJECT_ROOT, "resources"));
    reloadHint();
}

try {
    run(process.argv);
} catch (e) {
    const msg = (e as Error).message || String(e);
    console.error(`\n[cc-status-dot][ERROR] ${msg}`);
    if (/anchor/i.test(msg)) {
        console.error(
            "\nThis usually means the Claude Code extension updated and its minified code shifted.\n" +
                "No files were changed. Please open an issue with your CC version so anchors can be updated:\n" +
                "  https://github.com/anthropics/claude-code/issues  (or this project's issue tracker).",
        );
    }
    process.exit(1);
}
