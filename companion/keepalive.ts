/**
 * keepalive.ts — v0.5.51 transcript keep-alive for favorited/archived sessions.
 *
 * WHY: CC's default retention (cleanupPeriodDays=30) reaps transcript jsonls by
 * mtime with unlink-only semantics (2.1.241 binary-verified: stat → mtime < t →
 * unlink). A favorited/archived session whose transcript gets swept silently
 * degrades click-to-resume into click-to-new-session (CC's webview converts an
 * unresolvable sid into createSession). The user's directive: CC's policy is
 * FINE and untouched — but the moment a session is starred/archived in THIS
 * plugin, the plugin keeps it alive.
 *
 * MECHANISM (D2+ hybrid, empirically adjudicated):
 * - HARDLINK keepalive/<sid>.jsonl (same inode, 0 extra bytes) is THE
 *   guarantee: survives CC unlink AND companion downtime, and can resurrect a
 *   swept session on click (link back + utimes-freshen — the freshen is
 *   MANDATORY: the restored link carries the old inode mtime and the next
 *   sweep would re-delete it).
 * - TOUCH BELT (hourly utimes on the LIVE transcript of owned rows) keeps
 *   live favorited transcripts (and their <sid>/ sidecar cascade) from being
 *   swept at all while the companion runs. This is CC's OWN native keep-alive
 *   primitive (QQi: CC utimes the current session file hourly) — we extend
 *   the same courtesy to the user's starred sessions.
 * - INODE-RESYNC: /compact writes a new file and renames over the original
 *   (GE rename fn) — the live inode diverges from the keepalive link, which
 *   would pin PRE-compact content forever. reconcile() detects divergence by
 *   inode number and re-links to the fresh inode.
 *
 * OWNERSHIP: keepalive/<sid>.jsonl exists IFF sid ∈ favorites ∪ archive
 * (keyed by sid — mutex moves between the two files keep protection with zero
 * work). Orphan links are pruned by reconcile(). Rows are NEVER pruned.
 *
 * vscode-FREE by design (node:fs/node:path only + injected doc IO) so
 * hooks/test-keepalive.mjs can exercise the REAL module headlessly.
 */
import fs from "fs";
import path from "path";

/** A row observed in one of the two docs (union membership = keep-alive). */
export interface KeepaliveRow {
    sid: string;
    /** Undefined for pre-v0.5.13 legacy rows — scanBackfill can recover it. */
    transcript_path?: string;
    doc: "fav" | "arch";
}

/** Injected doc IO so this module stays vscode-free and CAS-safe in the EH. */
export interface KeepaliveIO {
    stateDir: string;
    projectsDir: string;
    /** Current union of rows from both docs (read fresh). */
    readRows(): KeepaliveRow[];
    /** CAS-safe persist of a backfilled transcript_path (best-effort). */
    persistTranscriptPath?(doc: "fav" | "arch", sid: string, tp: string): boolean;
}

export function keepaliveDir(stateDir: string): string {
    return path.join(stateDir, "keepalive");
}

export function keepalivePath(stateDir: string, sid: string): string {
    return path.join(keepaliveDir(stateDir), sid + ".jsonl");
}

function inodeOf(p: string): number | null {
    try {
        return fs.statSync(p).ino;
    } catch {
        return null;
    }
}

/**
 * Ensure a keepalive hardlink for (sid, live transcript path). Returns the
 * outcome for tests/diagnostics:
 * - "linked"    — first link created
 * - "resynced"  — inode divergence detected (post-/compact rename) → re-linked
 * - "fresh"     — link already shares the live inode (belt touched the live file)
 * - "missing"   — live transcript absent (swept or never existed) — caller
 *                 decides (restore path / expired UX)
 * EXDEV/EPERM (cross-device / FS without hardlinks) falls back to a full copy.
 */
export function ensureKeepalive(
    stateDir: string,
    sid: string,
    tp: string,
): "linked" | "resynced" | "fresh" | "missing" {
    let liveIno: number | null;
    try {
        liveIno = fs.statSync(tp).ino;
    } catch {
        return "missing";
    }
    const ka = keepalivePath(stateDir, sid);
    fs.mkdirSync(keepaliveDir(stateDir), { recursive: true });
    const kaIno = inodeOf(ka);
    if (kaIno !== null) {
        if (kaIno === liveIno) {
            // Same inode — belt: keep the LIVE transcript's mtime fresh so CC's
            // sweep never reaps it (the sidecar cascade stays alive too).
            touch(tp);
            return "fresh";
        }
        // Diverged (live file was replaced by rename — /compact) OR the ka is
        // an EXDEV-mode COPY (its inode can never equal the live one). A copy
        // is current iff its SIZE matches (jsonl is append-only; our own
        // touches make mtime comparisons meaningless) — belt instead of
        // unlink+recopy, which would re-copy the full transcript every pass.
        try {
            if (fs.statSync(ka).size === fs.statSync(tp).size) {
                touch(tp);
                return "fresh";
            }
        } catch {
            /* stat race — fall through to relink */
        }
        // Truly diverged (rename — /compact): the old link pins pre-compact
        // content; re-link to the fresh inode.
        try {
            fs.unlinkSync(ka);
        } catch {
            /* best-effort; linkSync below overwrites via EEXIST handling */
        }
    }
    try {
        fs.linkSync(tp, ka);
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
            // Raced with another window's ensure — treat as done.
            touch(tp);
            return "fresh";
        }
        if (code === "EXDEV" || code === "EPERM") {
            // Hardlinks impossible — full-copy fallback (storage unconstrained
            // per user directive; re-copy is gated by the pre-unlink SIZE
            // check above, so it fires only when content actually grew).
            try {
                fs.copyFileSync(tp, ka);
            } catch {
                return "missing";
            }
            touch(tp);
            return "linked";
        }
        return "missing";
    }
    touch(tp);
    return kaIno === null ? "linked" : "resynced";
}

function touch(p: string): void {
    try {
        const now = new Date();
        fs.utimesSync(p, now, now);
    } catch {
        /* belt is best-effort */
    }
}

/**
 * Machine-wide scan for a sid's transcript, mirroring CC's OWN resolution
 * algorithm (NLT: readdir the projects root, filter *.jsonl, sid-shaped
 * names). NEVER derive the escaped path — CC's escaping has historically
 * diverged from the naive /[^a-zA-Z0-9._-]/g rule (observed live).
 * Returns the found absolute path or null.
 */
export function scanBackfill(projectsDir: string, sid: string): string | null {
    let dirs: string[];
    try {
        dirs = fs.readdirSync(projectsDir);
    } catch {
        return null;
    }
    const want = sid + ".jsonl";
    for (const d of dirs) {
        const p = path.join(projectsDir, d, want);
        try {
            if (fs.statSync(p).isFile()) return p;
        } catch {
            /* not here */
        }
    }
    return null;
}

export type RestoreOutcome = "live" | "restored" | "expired";

/**
 * Click-time ensure: the CC path must exist before claude-vscode.editor.open.
 * "live"     — transcript already at its CC path (normal case)
 * "restored" — was swept; keepalive link resurrected it (mtime freshened)
 * "expired"  — neither path nor keepalive (pre-keep-alive death, e.g. the
 *              b91a11aa class) — caller shows the honest expired UX and does
 *              NOT call editor.open (CC would silently start a NEW session).
 */
export function restoreForClick(
    stateDir: string,
    projectsDir: string,
    sid: string,
    transcriptPath: string | undefined,
): RestoreOutcome {
    const tp = transcriptPath || scanBackfill(projectsDir, sid);
    if (tp) {
        if (fs.existsSync(tp)) return "live";
        const ka = keepalivePath(stateDir, sid);
        if (fs.existsSync(ka)) {
            try {
                fs.mkdirSync(path.dirname(tp), { recursive: true });
                try {
                    fs.linkSync(ka, tp);
                } catch (e) {
                    const code = (e as NodeJS.ErrnoException).code;
                    if (code === "EEXIST") {
                        // R1: the path was recreated concurrently (another
                        // window resumed it) — the LIVE file wins; a copy here
                        // would clobber fresh content with the stale snapshot.
                        return "live";
                    }
                    fs.copyFileSync(ka, tp);
                }
                touch(tp); // MANDATORY: old inode mtime would re-reap next sweep
                return "restored";
            } catch {
                /* fall through to expired */
            }
        }
    }
    return "expired";
}

/**
 * The full reconcile pass (after any doc mutation + hourly + activation):
 * 1. For every union row: resolve transcript (row field → scan); on scan
 *    recovery, persist transcript_path back into the owning doc (idempotent).
 * 2. ensureKeepalive every resolvable row (link/resync/belt).
 * 3. Prune keepalive files whose sid left the union.
 * Cost: O(rows) stats + (scan only for unresolved rows) + O(keepalive dir)
 * readdir — measured 1.3-2.0ms steady-state (7-8.7ms pre-migration with
 * unresolved legacy rows) against local FS; no network, no vscode. Called
 * per mutation + hourly, never per 2s tick.
 */
export function reconcile(io: KeepaliveIO): {
    linked: number;
    resynced: number;
    fresh: number;
    missing: number;
    pruned: number;
} {
    const stateDir = io.stateDir;
    const rows = io.readRows();
    const owned = new Set<string>();
    const stats = { linked: 0, resynced: 0, fresh: 0, missing: 0, pruned: 0 };
    for (const row of rows) {
        owned.add(row.sid);
        // Resolve in order: row field (if the file still exists) → machine-wide
        // scan (legacy rows never carried a path). On scan recovery, persist
        // transcript_path back into the owning doc (idempotent) so future
        // restores don't rescan.
        let tp: string | null = null;
        if (row.transcript_path) {
            try {
                if (fs.statSync(row.transcript_path).isFile()) tp = row.transcript_path;
            } catch {
                /* swept — fall to scan */
            }
        }
        if (!tp) {
            const found = scanBackfill(io.projectsDir, row.sid);
            if (found) {
                tp = found;
                // R1: heal BOTH unset and STALE row paths (a swept old-dir path
                // would otherwise force an hourly rescan forever).
                if (row.transcript_path !== found && io.persistTranscriptPath) {
                    io.persistTranscriptPath(row.doc, row.sid, found);
                }
            }
        }
        if (!tp) {
            // Either already swept pre-keep-alive (expired-UX class) or the
            // keepalive link is the only survivor — ensure nothing to link.
            stats.missing++;
            continue;
        }
        const r = ensureKeepalive(stateDir, row.sid, tp);
        if (r === "linked") stats.linked++;
        else if (r === "resynced") stats.resynced++;
        else if (r === "fresh") stats.fresh++;
        else stats.missing++;
    }
    // Prune orphans (sid no longer favorited/archived).
    const dir = keepaliveDir(stateDir);
    let names: string[] = [];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return stats;
    }
    for (const n of names) {
        if (!n.endsWith(".jsonl")) continue;
        const sid = n.slice(0, -6);
        if (!owned.has(sid)) {
            try {
                fs.unlinkSync(path.join(dir, n));
                stats.pruned++;
            } catch {
                /* best-effort */
            }
        }
    }
    return stats;
}
