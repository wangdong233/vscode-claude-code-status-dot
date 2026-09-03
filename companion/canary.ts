/**
 * canary.ts — v0.6 seam heartbeat canary judgment (pure, vscode-free).
 *
 * WHY PURE: the canary is the LAST line of defense (design §7.3) — the layer
 * that catches every escape the static gates cannot see (g4/createRequire,
 * code-splitting, protocol drift, payload-field drift, decoration shadow
 * death). R1's gates track proved that defense layer itself had ZERO tests
 * (the G9 mutation survived). A vscode-free pure module lets
 * hooks/test-canary-judge.mjs drive the REAL compiled judgment over a fixture
 * matrix — mirroring the retry-policy.ts seam pattern.
 *
 * Rules (design §7.3, R1-revised):
 *  - obs-silent    hooks active >10min past companion activation, but NO live
 *                  heartbeat has EVER observed a message (covers the g4/code-
 *                  split escape — R1 negation: the prelude now writes a BOOT
 *                  heartbeat at module load, so the file exists with
 *                  totalObs===0 in exactly this failure class).
 *  - obs-dropped   counters FROZEN at a positive value while hooks stay
 *                  active (R1 companion: cumulative counters can never
 *                  decrease, so "went to 0" was dead code — the fixed rule
 *                  keys on no-CHANGE for >10min instead).
 *  - env-fail      ≥10 envelope violations (protocol drift, hard form).
 *  - payload-drift messages counted but ZERO sid bindings ever succeeded
 *                  (R1 negation: obs proved only request.type parsing; a
 *                  sessionId rename kept the canary green while every dot
 *                  died — the new obs.binds counter closes it).
 *  - deco-silent   messages flow + panels exist but OUR icon writes never
 *                  happened (keys on deco.ourWrites — R1 negation fixed the
 *                  false positive: iconAsserts counts FOREIGN clobbers, so
 *                  keying on it alarmed on every healthy CC that simply
 *                  never clobbers).
 *  - degraded      NOT an alarm (design: "tooltip 透出（不打扰）") — returned
 *                  as info for logging/tooltip only.
 *
 * Every alarm is ONE-SHOT per EH lifetime (state.alarms). A red canary NEVER
 * re-patches (the failure it reports is protocol/architectural — re-running
 * the patcher on the same bytes cannot change the verdict).
 */

/** Aggregated summary of the live seam-state-<pid>.json files. */
export interface SeamHbSummary {
    files: number;
    totalObs: number;
    binds: number;
    envelopeFail: number;
    panelSurfaces: number;
    ourWrites: number;
    foreignClobbers: number;
    degraded: string[];
}

/** Per-EH canary state (module-scope in the companion, one per process). */
export interface CanaryState {
    obsPrev: number;
    /** Last ts the total obs value CHANGED (frozen-counter detection). */
    obsLastChangeTs: number;
    /** Has at least one tick seen panels+messages (deco-silent 2-tick rule). */
    sawActivePanels: boolean;
    alarms: string[];
    bootTs: number;
}

export function initCanaryState(now: number): CanaryState {
    return { obsPrev: -1, obsLastChangeTs: 0, sawActivePanels: false, alarms: [], bootTs: now };
}

export interface CanaryInput {
    /** Live summary (files with no heartbeat → files===0 → canary stays off). */
    summary: SeamHbSummary;
    hookActive: boolean;
    now: number;
    /** ms since the companion activated in this EH. */
    sinceActivateMs: number;
}

export interface CanaryVerdict {
    /** NEW alarm keys fired this tick (already added to state.alarms). */
    fired: string[];
    /** Human copy per fired alarm (rendered by the companion's UI side). */
    messages: Record<string, string>;
    /** degraded flags for passive surfacing (log/tooltip only — never a bar). */
    degradedInfo: string[];
}

export function judgeSeamCanary(state: CanaryState, input: CanaryInput): CanaryVerdict {
    const { summary: s, hookActive, now, sinceActivateMs } = input;
    const degradedInfo = [...new Set(s.degraded)].map(
        (d) => `cc-status-dot is running degraded (${d}) — dots still work; details in seam-state-*.json.`,
    );
    if (s.files === 0) {
        return { fired: [], messages: {}, degradedInfo };
    }

    if (s.totalObs !== state.obsPrev) {
        state.obsLastChangeTs = now;
        state.obsPrev = s.totalObs;
    }

    const fire = (key: string, msg: string) => {
        if (state.alarms.includes(key)) return;
        state.alarms.push(key);
        fired.push(key);
        messages[key] = msg;
    };
    const fired: string[] = [];
    const messages: Record<string, string> = {};

    // (a) observation channel never saw a message while hooks are active.
    if (hookActive && s.totalObs === 0 && sinceActivateMs > 10 * 60 * 1000) {
        fire(
            "obs-silent",
            "cc-status-dot: status-dot observation channel is silent while Claude Code sessions are active. CC likely changed its internal wiring (or routes vscode through a side channel) — wait for a cc-status-dot update. This notice will not repeat this session.",
        );
    }
    // (b) counters frozen at a positive value (mid-session drift).
    if (
        state.obsPrev > 0 &&
        s.totalObs === state.obsPrev &&
        hookActive &&
        state.obsLastChangeTs > 0 &&
        now - state.obsLastChangeTs > 10 * 60 * 1000
    ) {
        fire(
            "obs-dropped",
            "cc-status-dot: the observation channel stopped seeing messages (was working earlier). CC likely changed its protocol — wait for an update.",
        );
    }
    // (c) envelope violations (hard protocol drift).
    if (s.envelopeFail >= 10) {
        fire(
            "env-fail",
            `cc-status-dot: CC protocol drift detected (${s.envelopeFail} malformed frames). Wait for a cc-status-dot update.`,
        );
    }
    // (d) payload-field drift: messages parsed, bindings never landed. Gated
    // on panelSurfaces>0 — binds is panel-family-only by design, so a
    // sidebar-only user (CC's DEFAULT surface, never binds) must stay silent
    // (R2 false-positive finding).
    if (s.totalObs >= 10 && s.binds === 0 && s.panelSurfaces > 0) {
        fire(
            "payload-drift",
            "cc-status-dot: CC messages are arriving but session binding never succeeds — a wire field likely changed. Wait for a cc-status-dot update.",
        );
    }
    // (e) decoration silent: TWO consecutive ticks with messages + panels but
    // zero of OUR icon writes (ourWrites — not iconAsserts/foreignClobbers).
    // The first zero-write tick only LATCHES (skips the boot race where the
    // tick cadence has not fired yet); a subsequent healthy write unlatches.
    const activePanels = s.totalObs > 0 && s.panelSurfaces > 0;
    if (activePanels && s.ourWrites === 0) {
        if (state.sawActivePanels) {
            fire(
                "deco-silent",
                "cc-status-dot: messages are observed but no tab decoration was ever written — decoration shadow/tick mismatch. Heartbeat data is under ~/.claude/cc-status-dot/seam-state-*.json.",
            );
        } else {
            state.sawActivePanels = true; // latch: arm the second-tick rule
        }
    } else if (s.ourWrites > 0) {
        state.sawActivePanels = false;
    }

    return { fired, messages, degradedInfo };
}
