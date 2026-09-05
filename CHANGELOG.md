# Changelog

All notable changes to **we-need-ds** are documented here.
本插件的所有重要变更记录于此。

## v2.1.9 — 2026-09-05

### Fixed (the real cause of "every time you change the port my session disconnects")
- **Test isolation root-cause fix** — the self-test suites (`test_full.js`, `test_consume.js`) rewrote the **production** `providers.json` and `runtime-state.json` (only the *port* was isolated via `WE_NEED_DS_TEST_PORT`, never the *files*). While a suite ran, any other live session reading `providers.json` saw test data and every message broke — exactly the repeated disconnects reported. `lib/state.js` now honors `WE_NEED_DS_PROVIDERS_PATH` and `WE_NEED_DS_DATA_DIR` env overrides; both suites point them at a fresh `os.tmpdir()` sandbox before `require`, so tests never touch production files. Verified: production `providers.json` + `runtime-state.json` md5 are byte-identical before and after all three suites.
- **`ctl boot` now re-hooks after reviving** — the boot self-heal previously restored orphan providers to their real upstreams and revived the daemon but **never re-applied interception**, so after a reboot the proxy ran idle and DSH trimming was silently off (providers pointed straight at upstreams). It now follows the same validated `recoverOrphans → enableInterception` sequence as the UserPromptSubmit hook: revive daemon → restore orphans → re-hook. Verified end-to-end in an isolated sandbox (dead-proxy-port scenario → boot → daemon up + providers re-hooked + request passes through to real upstream).

### Changed (docs)
- README / README_EN: corrected the lifecycle description — host hooks (SessionStart/UserPromptSubmit/SessionEnd) only fire on hosts that actually run plugin hooks; cc-haha has been observed not to trigger them, so **boot self-healing via a logon scheduled task is now documented as the reliable revival path**. Added a "Boot Self-Healing" section with the `schtasks /create ... /sc onlogon` command, and a "Test isolation" note under Boundaries.

### Tests
- All three suites green (test_full 74 + simulation 18 + consume 18) **with production files provably untouched** (md5 before == after).

## v2.1.8 — 2026-09-04

### Fixed (first-byte gate no longer kills slow-thinking streams)
- **The v2.1.7 "first-byte health gate" could falsely kill legitimate slow first tokens** — its single `upstreamFirstByteTimeoutMs` deadline (default 30s) started at request-send and covered *both* "no response headers" *and* "headers arrived but no body byte". Reasoning models (deepseek-v4-pro) can take well over 30s before their first output token, so a healthy-but-slow stream would be retried and eventually 502'd. Replaced with **three independent gates**:
  - `upstreamHeaderTimeoutMs` (default 30s) — connection-level stall: no response headers at all → retryable.
  - `upstreamBodyTimeoutMs` (default 30s) — **non-streaming only**: headers arrived but zero body bytes → retryable. **Streaming (`text/event-stream`) responses are exempt** — once headers arrive the proxy waits indefinitely for the first byte, so a slow-thinking stream is never killed.
  - `upstreamIdleTimeoutMs` (default 600s) — socket idle: no activity on the connection for this long → dead, destroyed (raised from the old hard-coded 120s to cover long silent thinking stretches).
  Empty-body detection and 5xx passthrough from v2.1.7 are preserved.
- **Hard-coded proxy port removed from `isSelfProxyUrl`** (both `proxy.js` and `lib/state.js`) — the redundant `127.0.0.1:20329` / `localhost:20329` literals meant that if the real upstream happened to live on the default port while the proxy ran on a different one, it was misjudged as "another proxy" and skipped. Now only the dynamic `:${config.port}` check remains. Regression test F11.
- **Dead `{ arm: true }` argument** dropped from the `/ctl on` handler (`enableInterception` never took a second parameter).

### Tests
- New **Phase H** (test_full): an isolated small-timeout daemon proves a streaming response whose first byte arrives *after* the body gate is **not** killed (H1), while a non-streaming "headers-but-no-body" stall still fails fast as 502 (H2). Probe `probe_robustness.js` gained a `/slowstream` case (flushed headers + 5s-delayed first SSE chunk) — passes through intact while `/stall` still 502s in ~7s. All three suites green (test_full 74 + simulation 18 + consume 18).

## v2.1.7 — 2026-09-04

### Fixed (upstream robustness — the real cause of empty/hanging responses)
- **Upstream retry with exponential backoff** — the proxy previously forwarded a request to the upstream exactly once. When an unstable provider returned an empty body, reset the connection, or 5xx, the client (cc-haha / Claude Code) got a silent empty response or a hard error with no recovery. Now `forwardWithRetry` retries up to `upstreamRetries` (default 2, i.e. 3 attempts total) with exponential backoff (`upstreamRetryBackoffMs`, default 500ms), honoring the upstream `Retry-After` header when present. Only retried **before any byte is sent to the client** — once a streaming response has begun, it is never retried (avoids duplicated content).
- **First-byte health gate (fixes the 120s hang)** — previously the proxy called `res.writeHead` + `pipe` the instant the upstream sent response headers, so an upstream that sent headers then stalled left the client hanging until the 120s socket timeout. Now a `upstreamFirstByteTimeoutMs` deadline (default 30s) starts the moment the request is sent and covers both "no response headers at all" and "headers but no body". A stalled/empty upstream now fails fast, retries, and returns a clear 502 instead of hanging the client.
- **Empty-body detection** — an upstream `200` with zero-length body is treated as a retryable failure (not passed through as a malformed empty response).
- **5xx passthrough preserved** — after retries are exhausted, a real upstream HTTP response (e.g. 500) is forwarded with its **original status code and body** (transparent-proxy semantics); only connection-level failures (reset/timeout/empty/stall) get a synthesized 502. Verified by A29 and the consume 5xx test.

### Added
- **`ctl restart`** — a graceful restart command (kill the daemon holding the port → wait for release → spawn a fresh daemon → if interception was enabled, re-hook via `/ctl on`). Previously there was no way to reload the daemon without manually killing the process; a wedged daemon (e.g. full of stalled upstream requests) could not be recovered cleanly.
- New config keys: `upstreamRetries` (default 2), `upstreamRetryBackoffMs` (default 500), `upstreamFirstByteTimeoutMs` (default 30000).

### Tests
- Verified with fault-injection mock probes (`probe_robustness.js`, `probe_stream.js`): empty body → 502 after retries; stall → 502 in ~7s (was 120s hang); connection reset → 502; 500 → passthrough 500; flaky (empty,empty,ok) → recovered 200; streaming SSE → first byte 8ms, chunk-by-chunk, no buffering. All three suites green (test_full 70 + simulation 18 + consume 18).

## v2.1.6 — 2026-09-04

### Reverted
- **Reverted the v2.1.4 "D2" hook-path change** — v2.1.4 had consolidated `daemonCtl` into `lib/state.js` and switched the UserPromptSubmit hook to re-hook via `/ctl on` (dropping the `recoverOrphans` → `enableInterception` sequence). That rewrote the lifecycle takeover path that was validated end-to-end in real use (kill daemon → hook revives and re-hooks 27 providers). The new path only passed unit tests, not real-world use, and the "restore → re-hook" step was an intentional robustness measure. Restored to the original structure: `user-prompt-submit.js` and `session-start.js` back to their pre-D2 form (local `daemonCtl`, `recoverOrphans` + `enableInterception`), and `daemonCtl` removed from `lib/state.js`. The D1/D3/D5 cleanups from v2.1.4 are kept (they touch only console output, a dead migration path, and an orphan env var — none affect the takeover/passthrough path).

## v2.1.5 — 2026-09-04

### Fixed
- **DS persona now applies on every turn** — previously the DSH one-line persona was only swapped on decision turns and execution turns (last message is `user`/`tool`). A DS request whose last message is `assistant` (a malformed/edge turn) fell through to byte-for-byte passthrough, keeping the original CC persona. Now any DS-target request with a non-empty `messages` array gets the persona swap regardless of turn shape (tool trimming still only happens on decision turns). This makes "DeepSeek models always keep the DSH persona" hold unconditionally.
- **OpenAI-style execution turn no longer leaves a stale top-level `system` field** — when an OpenAI-format request carried a top-level `system` field, the DSH persona was injected as a `messages` system entry but the original top-level `system` was not removed, producing a double persona. Now `delete body.system` in the OpenAI branch.

### Tests
- Added E8 (OpenAI execution turn drops the stale top-level system) and E9 (DS malformed turn — last message `assistant` — still gets the DSH persona, tools not trimmed). All three suites green (test_full 70 + simulation 18 + consume 18).

## v2.1.4 — 2026-09-04

### Security
- **Removed `test_upstream.js` from the repository** — the #34 experiment script hardcoded personal provider names and a relay domain, and at runtime read the local ledger to make real (billable) upstream calls. It contained no API keys (full git-history scan confirmed zero leaked secrets), but it leaked privacy. Moved out of the repo.

### Fixed
- **D1** — dead branch in ctl.js `on` output (`r.body && r.body.mode` was unreachable after the body was already unwrapped); now guards `interceptedList` with `Array.isArray`.
- **D2** — `daemonCtl` deduplicated into `lib/state.js` as the single implementation (was copy-pasted in ctl.js and session-start.js). The UserPromptSubmit hook now re-hooks via `/ctl on` after reviving the daemon (daemon stays the single writer; direct `enableInterception` remains only as fallback when the daemon is unreachable), and the redundant restore→re-hook `recoverOrphans` churn was removed.
- **D3** — `migrateLegacyFiles` no longer hardcodes the `1.0.0` cache path (which never matched the real `2.0.0`/hash dirs); it now scans every version directory under the cache root.
- **D5** — removed the orphan `WE_NEED_DS_NO_REWRITE` env var that was set but never read anywhere.

### Docs
- README / README_EN: added a "Boundaries & Notes" section — ledger trust chain (providers must point at real upstreams, not another proxy), the two version lines (mechanism v5.1 vs plugin semver 2.1.x), and port-change behavior.

### Tests
- Added G1 (repeated `on` is idempotent, `originalUrl` never polluted with the proxy address) and G2 (ledger under `cache/<hash>/` migrates correctly). All three suites green (test_full 68 + simulation 18 + consume 18).

## v2.1.3 — 2026-09-04

### Fixed
- **thinkingBudget no longer leaks to OpenAI upstream** — the Anthropic-only `thinking: {type:"enabled", budget_tokens:N}` field was previously injected on every decision turn regardless of request format; an OpenAI-style endpoint would reject it with 400. Now gated by `if (!openAiStyle)`.
- **Format detection single source of truth** — extracted `resolveOpenAiStyle(body, format)`; both the persona rewrite and the thinking gate now derive OpenAI-vs-Anthropic from the same function (path signal first, `system` field fallback), eliminating the risk of the two paths disagreeing.

### Tests
- Added E6 (Anthropic path injects thinking) and E7 (OpenAI path does not). Full suite 70 green.

## v2.1.2 — 2026-09-04

### Fixed
- **Format default flipped to OpenAI** — when the request path carries no format signal, presence of a top-level `system` field → Anthropic, otherwise → OpenAI. Real Anthropic traffic always has `/messages` or a `system` field, so the residual bucket is almost entirely OpenAI. Removed the weak `isOpenAiStyle` body sniffing; format is now decided only by strong signals (path / `system` field).
- **env upstream no longer shadowed** — in pure-Claude-Code mode, `defaultUpstream` now prefers `ANTHROPIC_UPSTREAM_BASE_URL` instead of being overridden by the hardcoded `20128` fallback, so the env-var fallback documented in the README actually takes effect.
- **boot orphan cleanup port** — ctl.js `netstat` now uses `config.port` instead of hardcoded `20329`, so stale-daemon cleanup works after a port change.

### Tests
- E2/E3 pass explicit paths; added E5 (default-OpenAI fallback) and F10 (env not shadowed). Full suite 70 green.

## v2.1.1 — 2026-09-04

### Fixed
- **A1 (severe)** — `buildTargetUrl` now preserves the baseUrl path prefix when forwarding (e.g. `api.deepseek.com/anthropic` no longer loses `/anthropic`). Format detection is driven by the **request path** (`/messages` → Anthropic, `/chat/completions`|`/responses` → OpenAI) as the strongest signal, overriding body heuristics — Anthropic and OpenAI endpoints each keep their full correct URL, never cross-routed.
- **A2 (severe)** — `writeProviders` now uses atomic tmp+rename + a dedicated cross-process lock, eliminating providers.json corruption under concurrent multi-window on/off.
- **B1** — `enableInterception` restores providers pointing at a stale proxy port before re-hooking on the new port, so changing `port` while the daemon runs no longer records the proxy address as a real upstream.
- **B2** — active-request counter prevents the idle auto-shutdown timer from killing an in-flight streaming response.

### Tests
- Phase F added (9 assertions): URL prefix restoration, path-based format detection, atomic write, port-change recovery. Full suite now 68 green.

## v2.1.0 — 2026-09-04

### Fixed
- **M1** — `applyDshMinimalSystem` now detects OpenAI-style requests via structural features (`system`/`tool` role, `tool_calls`). Featureless requests use the top-level `system` field (Anthropic-legal) instead of injecting an illegal `system` message that upstream would reject with 400.
- **M2** — Decision-turn tool trimming now also preserves any tool already invoked in conversation history (`collectUsedToolNames`), preventing "unknown tool" protocol errors mid-chain.
- **M3** — Mixed `tool_result` + text messages are correctly classified as execution turns, so an in-progress tool chain is never mis-trimmed.
- **M5** — `off` now surfaces an `unrestorableList` warning (ctl.js + session-end hook) for providers pointing at the proxy without a trusted ledger record.
- Idle auto-shutdown now logs the restore count before exiting.

### Added
- `thinkingBudget` config switch (default `0` = off): optionally injects Anthropic extended-thinking budget on decision turns as a reinforcement for deep reasoning.
- Full `config.json` option reference table in README / README_EN.
- Phase E regression suite: byte-identical passthrough baseline for all non-DS models + M1/M3 boundary tests.

### Tests
- Three suites green: `test_simulation` (18), `test_consume` (18), `test_full` (59, Phases A–E).

## v2.0.0 — 2026-09-03

### Fixed
- **S1–S5 severe**: compressed-body passthrough corruption (content-encoding guard), binary/JSON write corruption (raw Buffer passthrough when unmodified), runtime-state ledger races (cross-process lock + atomic tmp/rename), upstream hang (120s timeout + error listeners), client socket errors (req/res error handlers).
- Provider mapping no longer depends on hardcoded id whitelist — new/unknown providers route to their real upstream (no more mis-routing to 9Router).
- Test suite fully isolated from production (`WE_NEED_DS_TEST_PORT=21329`, providers.json backup/restore).
- Default port migrated **20129 → 20329** (20129 was held by VS Code, causing false-positive takeover).

### Changed
- Default port is now `20329`.
- Idle auto-shutdown retired as default (daemon stays resident; `idleAutoShutdownMinutes` opt-in).

## v1.x — earlier

- v5.1: execution turns also adopt DSH persona with full tools (`executionDshPersona`).
- v5: turn-aware DSH minimal simulation — every decision turn gets the official DSH one-line prompt + Bash/Edit pair; arm-window state machine retired.
- Multi-provider mapping pool with dynamic auth-token routing; anti-self-proxy loop guards; boot recovery for OS-restart orphans; official skills command architecture.
