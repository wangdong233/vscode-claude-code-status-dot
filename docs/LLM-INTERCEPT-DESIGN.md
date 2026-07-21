# LLM-Call-Layer Intercept — Design Note (NOT IMPLEMENTED)

**Status**: design documentation only. v0.3.0 does NOT ship an LLM-call-layer
intercept. This page records the investigation, the verdict, and the conditions
under which the project would revisit the decision.

**Owner decision required before any implementation work begins.**

## Why this doc exists

User proposal 1 (during v0.3.0 research) asked for "在 LLM 调用层做底层拦截
旁路异步实时统计" — intercept Claude Code's HTTPS calls to api.anthropic.com
at the LLM layer to get sub-100ms streaming-chunk-level token usage, bypassing
the jsonl+hook+IIFE-tick path entirely.

Five-lane research (A realtime audit, B intercept feasibility, C OSS survey,
D rate/chart design, E unit formatting) was commissioned. Lane B ruled the
proposal **NO-GO for self-integration in this plugin**. This doc records why.

## The architecture fact that decides everything

Claude Code's VSCode extension is a **two-process** architecture:

```
VSCode extension.js  (UI shell; what cc-status-dot patches)
      │  stdin/stdout JSON-RPC + IPC events
      │  (update_session_state / rename_tab / Notification / Stop …)
      ▼
CC CLI process  (cli.js, compiled artifact, independent child process)
      │  HTTPS → api.anthropic.com (streaming SSE)
      │  fs.write → ~/.claude/projects/<esc>/<sid>.jsonl
      ▼
Anthropic API
```

The cc-status-dot patcher touches **only `extension.js`** — the UI shell.
All LLM API calls are issued by the **CLI child process**, not by the
extension host. cc-status.js (the writer hook) reads the transcript jsonl
that the CLI writes. The reader IIFE (in extension.js) reads the jsonl's
growing tail via `computeLiveDelta`.

This split is verified by:
- `hooks/cc-status.js:18-32` documents the jsonl as the single source of
  truth for tokens (one line per assistant message, `message.usage` field).
- `grep -n 'fetch|undici|http\\.request|HTTPS_PROXY|Anthropic|api\\.anthropic'
  patch.ts` returns zero hits — the patcher does not touch any network code.
- Web research confirms across multiple sources: "the VSCode extension is a
  UI shell; LLM inference HTTPS calls happen in the spawned CLI process".

## The four intercept strategies, ranked

| # | Strategy | Verdict | Reason |
|---|----------|---------|--------|
| 1 | `globalThis.fetch` / undici dispatcher monkey-patch in extension.js IIFE | **INEFFECTIVE** | Patching fetch in the extension host only catches fetch calls issued IN the extension host. The CLI's fetch happens in a different process — invisible cross-process. Zero benefit. |
| 2 | Splice CC's internal API client (wrap its fetch call site) | **INEFFECTIVE** | Same reason as #1: the API client lives in the CLI, not in `extension.js`. The patcher never touches the CLI (it's a compiled artifact that changes opaque across CC versions). |
| 3 | `HTTPS_PROXY` + local HTTP CONNECT proxy + MITM TLS | **THEORETICALLY FEASIBLE, VERY HIGH RISK** | Would work if CC honors `HTTPS_PROXY` and trusts a user-installed CA. But: (a) injects a self-signed CA into the system keychain — affects ALL HTTPS trust decisions on the machine, not just CC; (b) CC's CLI is a compiled binary that MAY cert-pin or use native roots that bypass system trust; (c) a proxy bottleneck/timeout DIRECTLY breaks CC's API calls — user loses CC responses, much worse than a "slow token counter"; (d) MITM on Anthropic's API likely touches their acceptable-use policy; (e) CC auto-update would break the integration silently (the companion self-heal covers extension.js only, not the proxy). |
| 4 | Anthropic SDK middleware | **NOT APPLICABLE** | CC's CLI uses a custom HTTP client, not the public Anthropic SDK with middleware hooks. Even if it did, the SDK runs in the CLI process, not extension.js. |

## The verdict

**No self-integration.** None of the four strategies has a risk/reward ratio
that justifies shipping it inside a token-display plugin:

- **#1, #2, #4** are architecturally ineffective — they intercept in the
  wrong process.
- **#3** is the only theoretically-working path, and it is high-risk AND
  produces user-visible regressions (CC stalls / broken HTTPS trust chain)
  that are far worse than the "token counter feels slow" problem it
  attempts to solve.

The "feels slow" problem is dominated by **B1** (CC flushes jsonl per
content-block, not per SSE chunk — see STATES.md §9.4 for the latency budget
breakdown). Even a perfect LLM-layer intercept would only shave the 500ms
IIFE tick floor, which is the SMALLEST of the four latency barriers.

## What v0.3.0 ships INSTEAD

The actual fixes that landed in v0.3.0:

1. **fmtTok B/T** (lane E) — pure display fix, 1.5B renders as "1.50B"
   instead of "1500.0M". Cosmetic but explicitly requested.
2. **tok/s sliding-window rate + unicode sparkline** (lane D form A) —
   "12.3k tok ▂▄▆█ 1.2k/s". Per-tick sampling of INPUT+OUTPUT (excludes
   cache_read per lane D R2 — cache spikes would dominate otherwise).
   Ring buffer cap 16 (8s @ 500ms tick), EMA peak auto-scale.
3. **`<sid>.rate` sidecar** (lane D) — cross-reload ring buffer continuity,
   throttled write every 2s when state==='running'.
4. **Webview chart panel** (lane D form C) — pure-SVG (no external libs),
   strict CSP `default-src 'none' + script-src 'unsafe-inline'`. Click the
   token SBI → QuickPick → "$(graph) Show live rate chart".
5. **i18n** — 9 new keys × 8 languages.

These deliver the user's perceived-realtime + chart goals within the
existing architecture, without any LLM-layer intercept.

## Future revisit conditions

This decision would be revisited IF ANY of:

1. **Anthropic ships an official streaming-usage hook.** If Claude Code
   adds a `usage` event in the hook system (analogous to the existing
   `Stop` / `PostToolUse` events but carrying live `message_delta`
   cumulative `output_tokens`), the cc-status-dot writer hook can consume
   it directly. No intercept needed.
2. **CC adopts the public Anthropic SDK with middleware support.** If the
   CLI ever exposes a middleware/plugin API, cc-status-dot could register
   a usage-tap middleware without process-boundary problems.
3. **CC publishes a statusline JSON hook with per-message_stop usage**.
   The existing statusLine hook carries `context_window.current_usage`
   but lacks `message_stop` finality semantics (v2.1.132 made
   `total_input_tokens` mean "current context" not "session cumulative").
   A finalized-usage field would let us close the B1 gap from the
   existing data path.
4. **The proxy approach gets a dedicated, signed companion binary** with
   its own narrow CA scope (NOT system-wide trust), explicit user opt-in,
   and clear documentation of the trade-offs. This would be a SEPARATE
   npm package (`cc-status-proxy`), not part of the main plugin, so the
   main plugin stays zero-dependency and zero-trust-impact.

## Pre-conditions before any implementation work

If a future contributor picks this up, they MUST verify BEFORE coding:

1. **Does CC's CLI honor `HTTPS_PROXY`?** Test by setting the env var and
   pointing it at a known-good proxy. If CC ignores it, strategy #3 is dead.
2. **Does CC's CLI cert-pin?** Test by installing a self-signed CA and
   pointing CC at a TLS-terminating proxy with a cert signed by that CA.
   If CC rejects it, strategy #3 is dead.
3. **What is the latency overhead of localhost CONNECT proxying?** If it
   adds >50ms per request, the "realtime" benefit is partially eaten.
4. **What does Anthropic's acceptable-use policy say about MITM on their
   API endpoints, even for personal-use token monitoring?** Get a clear
   answer before publishing anything.

If any of these checks fail, do not invest engineering time in #3.

## References

- Lane B verdict in v0.3.0 research notes (5-lane research, 2026-07-21).
- `hooks/cc-status.js` lines 18-32 (writer-side source-of-truth doc).
- `patch.ts` `computeLiveDelta` (the reader-side live-delta path that any
  intercept would augment, not replace).
- Anthropic Messages API streaming SSE contract: `message_start` carries
  input/cache tokens at request start; `message_delta` carries cumulative
  `output_tokens` during generation; `message_stop` carries final usage.
- Helicone / Langfuse / OpenRouter — production LLM-observability proxies
  that use the SDK-middleware or proxy mode. They work because the calling
  application is the SDK user. CC is not.
