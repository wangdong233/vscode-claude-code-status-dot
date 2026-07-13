#!/usr/bin/env node
'use strict';

/**
 * cc-status.js — Claude Code per-session status hook (cross-platform).
 *
 * Reads a CC hook event from stdin (JSON) and writes a status file to
 *   ~/.claude/cc-tab-status/<session_id>.json
 * shaped as  { state, since, error?, activeSubagents }
 * so an external reader (e.g. a VS Code status-dot patch) can render the
 * current state of every CC session.
 *
 * States written:  running | done | interrupted
 *   (idle is inferred by the reader when no file exists / done > 5 min;
 *    permission is left to CC's native blue pending dot — not written here)
 *
 * Event mapping (MUST equal HOOK_EVENTS in patch.ts; see docs/STATES.md §2):
 *   UserPromptSubmit          -> running (activeSubagents: prefer payload
 *                                 background_tasks, else keep — don't reset 0)
 *   PreToolUse / PostToolUse  -> running (heartbeat; refresh `since`)
 *   SubagentStart             -> running (early signal; activeSubagents+1)
 *   SubagentStop              -> persist decremented count (clamp 0); running if
 *                                 tasks remain, else keep cur.state (Stop decides)
 *   Stop                      -> done, UNLESS background_tasks / activeSubagents
 *                                 > 0 -> running (workflow still in flight)
 *   StopFailure               -> interrupted (records the error enum)
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

/**
 * Count of in-flight background tasks carried by the payload (CC v2.1.145+:
 * Stop / SubagentStop ship `background_tasks[]` scoped to the parent session).
 * Returns null when the field is absent (old CC version / event without it),
 * meaning "no authoritative signal — fall back to activeSubagents bookkeeping".
 */
function inflightFromPayload(payload) {
  return Array.isArray(payload && payload.background_tasks)
    ? payload.background_tasks.length
    : null;
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
 * Returns:
 *   - { state, since, error?, activeSubagents } -> write it (atomic)
 *   - null                                      -> ignore this event (don't write)
 *   - DELETE                                    -> remove the session's status file
 */
function deriveStatus(payload, cur) {
  const event = payload.hook_event_name;
  const now = Date.now();
  const inflight = inflightFromPayload(payload);
  const a = Number.isFinite(cur && cur.activeSubagents) ? cur.activeSubagents : 0;

  switch (event) {
    // A new turn just began: CC is working on the user's prompt.
    // Don't reset activeSubagents to 0 — a prior workflow may still be running.
    // Correct it from the authoritative payload if available, else keep it.
    case 'UserPromptSubmit':
      return { state: 'running', since: now, activeSubagents: inflight != null ? inflight : a };

    // Heartbeat: keep CC marked running and refresh the timestamp.
    case 'PreToolUse':
    case 'PostToolUse':
      return { state: 'running', since: now, activeSubagents: inflight != null ? inflight : a };

    // Early signal: a subagent was just spawned — turn yellow immediately,
    // before the first Stop. Prefer the authoritative count, else increment.
    case 'SubagentStart':
      return { state: 'running', since: now, activeSubagents: inflight != null ? inflight : (a + 1) };

    // A subagent finished. Prefer the authoritative count, else decrement
    // (clamped at 0). If tasks remain, stay running; otherwise do NOT
    // preempt — let Stop decide the terminal state (null = no write).
    case 'SubagentStop': {
      const next = inflight != null ? inflight : Math.max(a - 1, 0);
      // Always persist the decremented count. Returning null would leave a stale
      // activeSubagents on disk and mislead the following Stop into running.
      // Don't preempt the terminal state — keep cur.state, let Stop decide done.
      return {
        state: next > 0 ? 'running' : (cur && cur.state) || 'running',
        since: now,
        activeSubagents: next,
      };
    }

    // Turn completed normally. Authoritative call: if background tasks are
    // still in flight (a workflow running in the background), stay running
    // instead of falsely going green. Old CC versions degrade to activeSubagents.
    case 'Stop':
      return {
        state: (inflight != null ? inflight : a) > 0 ? 'running' : 'done',
        since: now,
        activeSubagents: inflight != null ? inflight : a,
      };

    // Turn was aborted/interrupted; preserve the failure reason enum.
    // Interrupt wins regardless of subagent count; keep the count for resume.
    case 'StopFailure':
      return { state: 'interrupted', since: now, error: payload.error || 'unknown', activeSubagents: a };

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
    [fs, os, path] = await Promise.all([
      import('fs'),
      import('os'),
      import('path'),
    ]);
  } catch {
    process.exit(0);
  }

  // One status file per session lives here.
  const STATUS_DIR = path.join(os.homedir(), '.claude', 'cc-tab-status');

  /**
   * Atomically write `obj` as JSON to `filePath`.
   * Writes a sibling .tmp file first, then renames over the target so a
   * reader never observes a half-written file.
   */
  const writeJsonAtomic = (filePath, obj) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
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
  const sid = payload && payload.session_id;
  if (!sid) process.exit(0);

  const filePath = path.join(STATUS_DIR, sid + '.json');

  // --- Read current on-disk status (read-modify-write for activeSubagents) ---
  // Missing/corrupt file or any read error -> benign defaults, stay silent.
  let cur = { state: 'idle', activeSubagents: 0, since: 0 };
  try {
    const prev = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    cur = {
      state: prev.state || 'idle',
      since: prev.since || 0,
      error: prev.error,
      activeSubagents: Number.isFinite(prev.activeSubagents) ? prev.activeSubagents : 0,
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
