# Changelog

All notable changes to **we-need-ds** are documented here.
本插件的所有重要变更记录于此。

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
