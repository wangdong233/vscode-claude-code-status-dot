#!/usr/bin/env node
'use strict';

/**
 * cc-status.js — Claude Code per-session status hook (cross-platform).
 *
 * Reads a CC hook event from stdin (JSON) and writes a status file to
 *   ~/.claude/cc-tab-status/<session_id>.json
 * shaped as  { state, since, error? }
 * so an external reader (e.g. a VS Code status-dot patch) can render the
 * current state of every CC session.
 *
 * States written:  running | done | interrupted
 *   (idle is inferred by the reader when no file exists / done > 5 min;
 *    permission is left to CC's native blue pending dot — not written here)
 *
 * Event mapping (MUST equal HOOK_EVENTS in patch.ts; see docs/STATES.md §2):
 *   UserPromptSubmit          -> running
 *   PreToolUse / PostToolUse  -> running (heartbeat; refresh `since`)
 *   Stop                      -> done
 *   StopFailure               -> interrupted (records the error enum)
 *   SessionEnd                -> delete the session's status file
 *
 * Robustness contract (NEVER block or break CC):
 *   - empty stdin or invalid JSON  -> silent exit(0)
 *   - any module-load/parse/IO error -> silent exit(0), nothing on stderr
 *   - writes are atomic (tmp + rename), dir auto-created
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
 * Map a parsed hook payload to a status object.
 * Returns:
 *   - { state, since, error? }  -> write it
 *   - null                      -> ignore this event
 *   - DELETE                    -> remove the session's status file
 */
function deriveStatus(payload) {
  const event = payload.hook_event_name;
  const now = Date.now();

  switch (event) {
    // A new turn just began: CC is working on the user's prompt.
    case 'UserPromptSubmit':
      return { state: 'running', since: now };

    // Heartbeat: keep CC marked running and refresh the timestamp.
    case 'PreToolUse':
    case 'PostToolUse':
      return { state: 'running', since: now };

    // Turn completed normally.
    case 'Stop':
      return { state: 'done', since: now };

    // Turn was aborted/interrupted; preserve the failure reason enum.
    case 'StopFailure':
      return { state: 'interrupted', since: now, error: payload.error || 'unknown' };

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

  // --- Map event -> status action ---
  const status = deriveStatus(payload);
  if (status === null) process.exit(0); // event we don't track

  const filePath = path.join(STATUS_DIR, sid + '.json');

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
