/**
 * retry-policy.ts — v0.5.53 auto-patch retry state machine (pure, vscode-free).
 *
 * WHY: the 2026-09-01 incident class — a TRANSIENT post-backup patch failure
 * (resource-starved patcher killed by the companion's own 30s SIGTERM during
 * the timeout-less assertCompiles, at the exact moment a mid-session CC
 * update landed) was recorded by the OLD ranDirs Set as "done for this EH
 * lifetime". Zero self-heal for 4h22m until a manual run; the user saw a
 * scary "Run npx manually" toast for what was a 1-retry-away fix.
 *
 * Policy (adjudicated):
 * - Per-dir state {status:'ok'|'failed', attempts, lastAttemptMs} replaces
 *   the Set. 'ok' is recorded ONLY after the post-verify marker check passes;
 *   every failure (spawn error / non-zero exit / marker-absent) records
 *   {failed, attempts+1, now}.
 * - shouldRetry: 'ok' → 'wait' forever (steady-state tick stays one Map
 *   lookup — the v0.5.45.1 cost win is preserved); 'failed' → 'run' when
 *   attempts < MAX and the exponential backoff has elapsed, 'wait' inside
 *   the backoff window, 'done' when attempts are exhausted (toast fires
 *   there — once per dir per EH).
 * - classifyClose: distinguishes exit-code errors (hard, stderr expected)
 *   from signal deaths (transient class — empty stderr is their signature)
 *   and our own timeout SIGTERM; the toast Detail leads with the class so a
 *   signal-death can never again masquerade as a content problem.
 *
 * vscode-FREE (node only) so hooks/test-companion-retry.mjs tests the REAL
 * compiled module headlessly, mirroring the keepalive.ts seam pattern.
 */

/** Max patch attempts per dir per EH lifetime (1 initial + 4 retries ≈ 11min). */
export const RETRY_MAX_ATTEMPTS = 5;
/** Backoff base: 30s · 2^min(attempts-1, 4), capped at 4min. */
export const RETRY_BACKOFF_BASE_MS = 30_000;
export const RETRY_BACKOFF_CAP_MS = 4 * 60_000;

export interface DirPatchState {
    status: "ok" | "failed";
    attempts: number;
    lastAttemptMs: number;
}

export type RetryDecision = "run" | "wait" | "done";

export function backoffDelayMs(attempts: number): number {
    const exp = RETRY_BACKOFF_BASE_MS * Math.pow(2, Math.min(Math.max(attempts - 1, 0), 4));
    return Math.min(exp, RETRY_BACKOFF_CAP_MS);
}

export function shouldRetry(state: DirPatchState | undefined, now: number): RetryDecision {
    if (!state || state.status !== "failed") return "wait"; // ok/absent → never re-run via the tick
    if (state.attempts >= RETRY_MAX_ATTEMPTS) return "done";
    return now - state.lastAttemptMs >= backoffDelayMs(state.attempts) ? "run" : "wait";
}

export type CloseKind = "ok" | "hard-error" | "timeout" | "external-signal";

export interface CloseClass {
    kind: CloseKind;
    /** Leading line for the toast Detail — class first, evidence after. */
    firstLine: string;
}

export function classifyClose(code: number | null, signal: NodeJS.Signals | null, timerFired: boolean): CloseClass {
    if (code === 0) return { kind: "ok", firstLine: "patch.js exited 0" };
    if (signal === "SIGTERM" && timerFired) {
        return {
            kind: "timeout",
            firstLine:
                "patch.js was killed by our own 30s timeout (machine under load / stalled step) — a TRANSIENT class, not a content problem",
        };
    }
    if (signal) {
        return {
            kind: "external-signal",
            firstLine: `patch.js was killed by ${signal} (external — OOM killer / user / system), no error output was produced`,
        };
    }
    return { kind: "hard-error", firstLine: `patch.js exited with code ${code}` };
}

/** Compose the toast Detail: class line first, then stderr tail, then stdout tail. */
export function composeFailureDetail(
    cls: CloseClass,
    stderr: string,
    stdout: string,
    tailChars = 500,
): string {
    const parts = [cls.firstLine];
    const errTail = (stderr || "").trim().slice(-tailChars);
    const outTail = (stdout || "").trim().slice(-tailChars);
    if (errTail) parts.push(`stderr(tail): ${errTail}`);
    if (outTail) parts.push(`stdout(tail): ${outTail}`);
    if (!errTail && !outTail) parts.push("(no output captured)");
    if (cls.kind !== "hard-error" && !errTail) {
        parts.push("note: empty stderr + signal death = the failure produced no in-process error");
    }
    return parts.join("\n").slice(-tailChars * 3);
}
