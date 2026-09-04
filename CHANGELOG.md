# Changelog

All notable changes to **we-need-ds** are documented here.
本插件的所有重要变更记录于此。

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
