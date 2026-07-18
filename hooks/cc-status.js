#!/usr/bin/env node
'use strict';
/*cc-status-dot-hook:v0.1.14:58d356e5*/

/**
 * cc-status.js — Claude Code per-session status hook (cross-platform).
 *
 * Version + content-hash stamp above (cc-status-dot-hook:vX.Y.Z:HASH) mirrors
 * the IIFE's INJECT_VERSION+hash banner so installRuntimeFiles can detect a
 * stale on-disk hook copy the same way patchExtension detects a stale IIFE
 * (architecture-review round-2 added the version banner; round-3 added the
 * content-hash suffix to close the asymmetry the round-2 review left —
 * previously a dev could edit the hook body and forget to bump HOOK_VERSION,
 * and the patcher would silently overwrite an installed hook whose body
 * differed, no warn. The hash detects intra-version drift). Bump HOOK_VERSION
 * in lockstep with INJECT_VERSION in patch.ts when the writer CONTRACT
 * changes; re-stamp the hash whenever the BODY changes. The hash is sha1 of
 * the file body with the banner line replaced by an empty line, truncated to
 * 8 hex chars (HOOK_HASH_LEN in patch.ts).
 *
 * Reads a CC hook event from stdin (JSON) and writes a status file to
 *   ~/.claude/cc-tab-status/<session_id>.json
 * shaped as  { state, since, error?, activeSubagents, pending? }
 * so an external reader (e.g. a VS Code status-dot patch) can render the
 * current state of every CC session.
 *
 * States written:  running | done | interrupted  (+ optional `pending:true` flag)
 *   (idle is inferred by the reader when no file exists / done > 5 min;
 *    `pending:true` is written by the Notification event to mean "awaiting user
 *    input" — permission / question / elicit prompt — and cleared by every
 *    user/turn-driven event (UserPromptSubmit / Pre/PostToolUse / Stop /
 *    StopFailure). SubagentStart / SubagentStop PRESERVE cur.pending instead:
 *    they are background events with no signal about whether the parent's prompt
 *    is still open. The reader counts pending INDEPENDENTLY of state so a
 *    session can be both running AND pending, which is the typical case: a
 *    running turn paused on a permission prompt.)
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
 *                                 residual counter. Also CLEAR pending.
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
 */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

// Sentinel return value meaning "delete this session's status file".
const DELETE = Symbol('delete');

// 24h retention threshold for interrupted sessions. CONTRACT: MUST equal the
// reader IIFE's INTERRUPTED_RETENTION_MS (patch.ts buildIIFE) and STATES.md §7.2
// rule 3 / §7.5. The aggregation layer decays interrupted>24h to idle for
// COUNTING but keeps the file on disk for diagnostic inspection (STATES.md §7.5
// "文件不删（保留诊断价值）"); the writer's UserPromptSubmit GC below mirrors
// the threshold for its bounded prune. Named here (not inlined) so a search for
// INTERRUPTED_RETENTION_MS lands both files with one token and a future tuning
// edit hits both sites in lockstep. The test-iife.mjs IIFE.37c regex + the
// §INTERRUPTED-RETENTION test in test-cc-status.js both pin the literal value,
// catching drift at CI time.
const INTERRUPTED_RETENTION_MS = 24 * 60 * 60 * 1000;

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
function deriveStatus(payload, cur) {
  const event = payload.hook_event_name;
  const now = Date.now();
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
      // When cur.state is ALREADY terminal (done/interrupted — typically a
      // late/orphan SubagentStop arriving AFTER Stop already wrote done) AND
      // next just zeroed, preserve cur.since instead of writing `now`. The
      // reader's notify-dedup keys on the terminal `since` (STATES.md §4b),
      // so refreshing it here would (a) re-fire a duplicate "turn complete"
      // notification for the same turn, and (b) reset the done→idle 5-min
      // countdown. When next>0 we DO flip state to running and refresh since
      // (a remaining task re-arms the yellow dot). R3 data-logic fix: the
      // guard previously accepted `typeof cur.since === "number"` so a
      // hand-edited / corrupt file with cur.since=0 would be preserved
      // indefinitely — and the reader's `since && (now-since>DONE_TO_IDLE_MS)`
      // tick is falsy for 0, so the file NEVER decayed to idle, permanently
      // stuck as terminal green/red. Mirror Notification's strict `> 0`
      // guard (see curSince below) — cur.since=0 only arises from a corrupt
      // file (the writer never produces it via Date.now()).
      const preserveSince =
        (curState === 'done' || curState === 'interrupted') &&
        next === 0 &&
        cur &&
        typeof cur.since === 'number' &&
        cur.since > 0;
      // Always persist the decremented count. Returning null would leave a stale
      // activeSubagents on disk and mislead the following Stop into running.
      return {
        state: next > 0 ? 'running' : curState,
        since: preserveSince ? cur.since : now,
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
    case 'Notification': {
      const curState =
        cur && (cur.state === 'running' || cur.state === 'done' || cur.state === 'interrupted') ? cur.state : 'running';
      const curSince = cur && typeof cur.since === 'number' && cur.since > 0 ? cur.since : now;
      return {
        state: curState,
        since: curSince,
        activeSubagents: a,
        pending: true,
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
    case 'Stop':
      return {
        state: inflight > 0 ? 'running' : 'done',
        since: now,
        activeSubagents: inflight != null ? inflight : 0,
        pending: false,
      };

    // Turn was aborted/interrupted; preserve the failure reason enum.
    // Interrupt wins regardless of subagent count; keep the count for resume.
    // Force error to a string (STATES.md §3 "error?: '<StopFailure enum>'"):
    // payload.error may be a non-string truthy (number/array/object) on a
    // broken/malformed payload, which would JSON.stringify to "[object Object]"
    // and surface as an unreadable notification. Default 'interrupted' (not
    // 'unknown') matches the reader IIFE's own fallback wording so writer and
    // reader agree on the message shown for missing error enums.
    // CLEAR pending — an interrupted turn is not awaiting user input.
    case 'StopFailure':
      return {
        state: 'interrupted',
        since: now,
        error: typeof payload.error === 'string' && payload.error ? payload.error : 'interrupted',
        activeSubagents: a,
        pending: false,
      };

    // Session is over: clean up its status file.
    case 'SessionEnd':
      return DELETE;

    default:
      return null;
  }
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
  if (typeof sid !== 'string' || /[\\/]/.test(sid) || sid === '.' || sid === '..') process.exit(0);

  const filePath = path.join(STATE_DIR, sid + '.json');

  // --- Bounded GC (architecture-review round-2 finding: STATE_DIR had no GC) ---
  // On UserPromptSubmit (a cheap, once-per-turn event) prune status files whose
  // mtime exceeds INTERRUPTED_RETENTION_MS (24h). Crashed/killed CC processes
  // never send SessionEnd, so without this prune ~/.claude/cc-tab-status/ would
  // grow unbounded over months of daily use — every 500ms aggregation tick does
  // fs.readdirSync + per-file readFileSync + JSON.parse over the WHOLE dir, so
  // an unbounded long tail makes the SBI tick perceptibly heavier for zero
  // diagnostic value (the user cannot map an old UUID to a session after the
  // fact). The aggregation layer ALREADY discounts these files for COUNTING
  // (interrupted>24h→idle, running>30min→idle, done>5min→idle); this prune also
  // reclaims the bytes. Best-effort: wrapped in try/catch so a transient FS
  // error never blocks the primary write. SKIP the current session's file —
  // we're about to overwrite it with a fresh mtime anyway, and racing a prune
  // against our own write would be pointless churn.
  //
  // Cross-session prune (round-3 review fix): the GC iterates the WHOLE
  // STATE_DIR, so a UserPromptSubmit for session X may unlink a stale file
  // belonging to ANY other session Y in the same CC installation. This is the
  // SECOND writer-side deletion trigger (STATES.md §2 lists SessionEnd as the
  // first). Functional rationale: there is no per-session cleanup hook besides
  // SessionEnd, and crashed sessions never fire SessionEnd — a global mtime
  // sweep is the only practical reclamation path. The skip-current rule below
  // protects only the writer's own target file; third-party files older than
  // 24h are pruned on any other session's UserPromptSubmit.
  //
  // Interrupted-preservation contract (round-3 review fix, STATES.md §7.5):
  // INTERRUPTED_RETENTION_MS(24h) is the SAME threshold the aggregation layer
  // uses to decay interrupted>24h to idle FOR COUNTING — but STATES.md §7.5
  // explicitly guarantees "文件不删（保留诊断价值，用户可手动检查…）". The
  // aggregation layer honors that (it filters at READ time, leaves the bytes);
  // the writer's GC must honor it too — so we PARSE the file's state and SKIP
  // the prune when state==='interrupted'. A user who comes back to inspect
  // yesterday's interrupted session via ~/.claude/cc-tab-status/<sid>.json will
  // still find the file. Running/done/idle-by-default files older than 24h
  // remain prunable (no diagnostic value, reader already discounts them).
  const event = payload && payload.hook_event_name;
  if (event === 'UserPromptSubmit') {
    try {
      const cutoff = Date.now() - INTERRUPTED_RETENTION_MS;
      for (const name of fs.readdirSync(STATE_DIR)) {
        if (!name.endsWith('.json')) continue;
        const p = path.join(STATE_DIR, name);
        if (p === filePath) continue; // never prune the file we're about to write
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs >= cutoff) continue; // fresh enough — keep
          // Interrupted-preservation: parse the state and skip interrupted
          // files so the §7.5 "do not delete (diagnostic value preserved)"
          // contract holds at the writer layer too. Parse failure on a
          // corrupt/empty file falls through to prune — a corrupt file has
          // no diagnostic value and the reader already skips it.
          let preserved = false;
          try {
            const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (parsed && parsed.state === 'interrupted') preserved = true;
          } catch {
            /* corrupt JSON — fall through to prune */
          }
          if (!preserved) fs.unlinkSync(p);
        } catch {
          /* best-effort per-file */
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
  // v0.1.13 review fix: pending is now loaded into cur (previously the writer
  // was structurally write-only on pending and every event picked true/false,
  // so background events like SubagentStart/SubagentStop false-cleared a
  // parent's open permission prompt). Loading pending lets the Subagent*
  // cases write `pending: cur.pending === true` and preserve the flag across
  // background events. Coerced to a strict boolean — a hand-edited / corrupt
  // file with `pending: "true"` (string) or `pending: 1` must NOT read as
  // truthy here (the reader's `j.pending === true` check would disagree).
  let cur = { state: 'running', activeSubagents: 0, since: 0, pending: false };
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
    };
  } catch {
    /* no file / corrupt JSON -> default cur */
  }

  // --- Map event -> status action ---
  const status = deriveStatus(payload, cur);
  if (status === null) process.exit(0); // event we don't track / not writing

  if (status === DELETE) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* file already absent — nothing to clean up */
    }
    process.exit(0);
  }

  // Atomic write; swallow any error so CC is never affected.
  try {
    writeJsonAtomic(filePath, status);
  } catch {
    /* ignore */
  }

  process.exit(0);
}

// Final safety net: never let a rejection escape to CC's stderr.
main().catch(() => process.exit(0));
