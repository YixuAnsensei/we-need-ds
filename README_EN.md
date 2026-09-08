# we-need-ds 🎯

> **The first native Claude Code & [cc-haha](https://github.com/NanmiCoder/cc-haha) plugin for unlocking full-power "We need" reasoning chains in DeepSeek Pro models.**

<p align="center">
  <img src="https://img.shields.io/badge/Claude%20Code-Plugin%20V2-6366f1?style=flat-square" alt="Claude Code Plugin">
  <img src="https://img.shields.io/badge/Companion-cc--haha-f43f5e?style=flat-square" alt="cc-haha">
  <img src="https://img.shields.io/badge/Target-DeepSeek--V4--Pro-0ea5e9?style=flat-square" alt="DeepSeek V4 Pro">
  <img src="https://img.shields.io/badge/Multi--Provider-Dynamic%20Routing-10b981?style=flat-square" alt="Multi-Provider">
  <img src="https://img.shields.io/badge/License-MIT-amber?style=flat-square" alt="License MIT">
</p>

[简体中文文档](README.md) | English Documentation

---

## 🧐 Background: The "We need" vs "Let me" Dilemma

Recent community research (pioneered by the DeepSeek Harness community) revealed a critical duality in **DeepSeek-V4-Pro series models** under different tool schemas:

| Mode | Characteristics | Root Cause |
| :--- | :--- | :--- |
| 🟢 **"We need..." Full-Power Deep Planning** | Deconstructs problems globally, plans architecture, handles edge cases, and demonstrates top-tier AGI-level strategic reasoning. | Model only sees a minimal essential toolset in turn 1, entering its RL **deep reasoning sweet-spot**. |
| 🔴 **"Let me..." Shallow Tool-Churning** | Gets bogged down in micro-level tool trials, excessive looping, and shallow heuristics. | Client injects dozens of MCP tools, skill schemas, and verbose docs in turn 1, over-directing attention. |

### The Problem in Claude Code Ecosystem
* **Claude Code developers rely heavily on MCPs** (databases, browsers, terminals, file editors). Disabling them manually destroys the workflow, but leaving them enabled traps DeepSeek in the "Let me" trap.
* **Prompt hypnosis fails**: System prompts cannot overcome the raw attention weight of dozens of JSON tool schemas in the request body.

---

## 💡 The Solution: Turn-Aware DSH Minimal Simulation (v5.2)

**`we-need-ds`** provides a transparent, zero-latency proxy plugin that dynamically decouples tool exposure based on request structure:

```mermaid
sequenceDiagram
    autonumber
    participant User as Developer
    participant CC as Claude Code / cc-haha
    participant Proxy as we-need-ds Proxy (:20329)
    participant Router as 9router / Upstream API / Official Endpoints

    User->>CC: Command: /we-need-ds Refactor authentication system
    Note over CC,Proxy: Session starts / Command invoked: transparent proxy ready, current default provider hooked with a direct-copy escape hatch
    CC->>Proxy: Decision Turn Request (new task text, carrying 30+ MCP tool schemas)
    
    rect rgb(235, 248, 255)
    Note over Proxy: v5.2 DSH Minimal Simulation (every decision turn):<br/>Target model matched → System prompt replaced with official DSH one-liner<br/>Tools trimmed to [Bash, Edit] (mirrors DSH bash + str_replace_editor)<br/>system-reminder noise stripped from user messages + thinking budget injected<br/>Dynamically routes to original upstream based on API Key
    end
    
    Proxy->>Router: Forward minimal request
    Router-->>CC: DeepSeek hits RL sweet-spot, emits "We need..." planning chain (SSE passthrough)
    
    Note over CC,Proxy: Execution Turn: model starts calling tools
    CC->>Proxy: Execution Turn Request (tool / tool_result)
    
    rect rgb(240, 253, 244)
    Note over Proxy: v5.1 Full release: all MCPs/skills restored<br/>Persona also switches to the DSH one-liner (executionDshPersona)
    end
    
    Proxy->>Router: Forward untouched
    Router-->>CC: Executes with all available MCP tools smoothly!
```

---

## ✨ Key Features

1. **⚡ Single-Provider Hook & Direct-Copy Escape**:
   * Hooks **only the provider that is actually in use** — the current default (`activeId`) in `providers.json` that genuinely offers DeepSeek Pro models. Every other provider keeps its real upstream `baseUrl` untouched.
   * At hook time it also clones a temporary `· direct copy` provider whose `baseUrl` points at the **original real upstream** — that's your escape hatch: if the daemon ever dies and the body points at a dead port, switch to the copy in cc-haha and you're connected directly again, then run `off`/`boot`/`on` at leisure.
   * The copy doubles as a **redundant ledger**: even if `runtime-state.json` is lost or corrupted, the body's real upstream can be recovered from the copy's `baseUrl`.
   * Incoming requests are routed back to their real upstream dynamically by API Key / Token, so switching models across windows and tabs causes zero interference.
2. **🎯 Turn-Aware DSH Minimal Simulation (v5.2, full-power trigger on decision turns)**:
   * Pure request-structure detection: last message is fresh user text = **decision turn** (model plans), last message is tool/tool_result = **execution turn** (tool follow-up);
   * **Every decision turn** (not just the first) simulates the official DeepSeek Harness minimal mode: system prompt replaced with the official DSH one-liner `You are a helpful software engineer assistant.`, tools trimmed to the `Bash + Edit` pair (mirroring DSH's bash + str_replace_editor); **new in v5.2**: `<system-reminder>` noise blocks are stripped from user messages (controlled experiments proved reminder noise suppresses the chain), and a `thinking` budget is injected on the Anthropic path (controlled experiments proved the chain cannot fire without the thinking field);
   * **Every execution turn (v5.1)** keeps full unrestricted tools while the persona is also switched to the DSH one-liner — the client only hard-validates JSON protocol structure (tool_use/tool_result blocks), never persona text, so the swap is protocol-safe; after an execution chain ends, the next new task re-enters minimal mode automatically. Set `executionDshPersona: false` to fall back to v5 behavior (execution turns fully untouched). Zero configuration.
3. **🛡️ Triple Safety Lifecycle & Zero-Deadlock Guarantee**:
   * **Host hook auto-takeover**: SessionStart hook spawns the daemon and re-hooks **only when the ledger says `enabled`** (you ran `on` and never `off`); UserPromptSubmit hook self-checks and revives it on every new message; SessionEnd hook restores proxied providers to direct at session end but **keeps the interception intent** (next session auto-re-hooks) — to close permanently run `/we-need-ds:off` explicitly (effective on hosts that support plugin hooks).
   * **Manual recovery after reboot (host-hook independent, no system-level registration)**: Windows shutdown/restart kills the daemon outright and bypasses every hook, leaving the hooked body pointing at a dead proxy port in an "orphan" state. But **all other providers and the direct copy always stay connected directly**, so you can still send messages and run recovery commands — no more "everything points at a dead port, can't even send `on`" deadlock. Recovery: switch to the direct copy (or any non-hooked provider) in cc-haha, then run `/we-need-ds:on` (or `node lib/ctl.js boot` in a terminal) — revive daemon + fix orphans + re-hook from the ledger. The plugin registers no scheduled tasks and writes nothing to the Startup folder; uninstalling leaves nothing behind (see "Manual Recovery After Reboot" below).
   * **Always-on daemon**: stays resident by default (`idleAutoShutdownMinutes: 0`).
   * **100% Zero-Touch for Non-Target Models**: Claude, GPT, Gemini, Qwen models pass through with pure byte-level streaming.

---

## 🚀 Getting Started

### 🅰️ Using with [cc-haha](https://github.com/NanmiCoder/cc-haha)

> **⚠️ Read first: takeover rewrites providers.json, and the edit persists across shutdown/reboot**
> Takeover works by **rewriting the selected provider's `baseUrl` to the local proxy address** (`http://127.0.0.1:20329`). This edit is written into cc-haha's config file `~/.claude/cc-haha/providers.json` and is **NOT automatically undone by shutting down, rebooting, or closing cc-haha**. So:
> - As long as the daemon is alive, everything works normally;
> - If the daemon dies (a reboot kills it outright) while the body still points at the proxy port, that provider becomes "unreachable" — but **nothing is fully stuck**: takeover also creates a `· direct copy` (whose `baseUrl` points at your original real upstream), and every non-hooked provider stays direct. You can always switch to the copy or any direct provider to send messages and run recovery commands.
> - **Good habit**: run `/we-need-ds:off` once before closing cc-haha / shutting down to restore the body to direct and remove the copy — clean ledger. Forget it and you're still fine; see "Manual recovery after reboot" below.

1. **Pick which provider to hook (two ways, choose one)**:
   * **Way A · Plugin-assisted selection (recommended, no manual pre-setting)**: just run `/we-need-ds:on` or `/we-need-ds`. The plugin first lists all your providers (marking which declare DeepSeek Pro models `🎯` and which is the current default `⭐`), asks you to choose if multiple DS providers exist, then hooks your pick. **Hooking a non-default provider automatically switches cc-haha's `activeId` to it** — the sidecar routes by `activeId`, so without the sync new sessions would still go to the old provider.
   * **Way B · Manual pre-setting**: first set the DeepSeek Pro provider you really use as the default in cc-haha, then run `/we-need-ds:on` (omit `--provider`) and the plugin hooks the current default.
   * Terminal equivalents: `node lib/ctl.js list` to see the roster; `node lib/ctl.js on --provider <id or name>` to hook a specific target.
   * **Takeover depends only on the `models` field the provider declares**: the plugin reads this provider's `models` map (main/haiku/sonnet/opus, etc.) from `providers.json`, and hooks it only if any declared model name matches the DeepSeek Pro check (in `targetModels`, or containing `deepseek`, or a standalone `ds` token — delimited by separators/boundaries so substrings like `models`/`adsl` don't false-match — plus a `v4|pro|flash` feature). A relay like 9Router, even if it **can actually forward** DeepSeek models, is treated as "non-DS provider" and **not hooked** (kept direct, no trimming) as long as its `models` field doesn't declare a deepseek model name. So pick a provider whose `models` actually declares a DeepSeek Pro model.
   * Every other provider's `baseUrl` stays untouched, pointing at its own real upstream — this is exactly the deadlock-prevention key: if the daemon ever dies, you still have plenty of direct entry points plus the auto-generated direct copy to switch to.
2. **Enable = hook the target + create the copy**:
   * Run `/we-need-ds:on` (or `on --provider <id>`): revives the daemon, switches the target DS provider's `baseUrl` to the proxy port, and clones a `· direct copy` (pointing at the original real upstream) as the escape hatch.
   * Switch the takeover target and run `on` again: the old body is auto-restored to direct, the new target gets hooked, and only one copy is ever kept.
3. **Run `off` before quitting (recommended habit)**:
   * Before closing cc-haha / shutting down, run `/we-need-ds:off` to restore the body to direct and remove the copy — clean ledger. Even if you forget, after a reboot you can still send messages via the copy or any non-hooked provider and run `boot`/`on` to recover; nothing gets stuck.
4. **Daily usage**:
   * Type directly in the chat box:
     ```bash
     /we-need-ds Refactor the user auth module and write test cases
     ```
   * When you want deep reasoning first without writing code:
     ```bash
     /we-need-ds:plan Plan a large-scale system refactoring
     ```

---

### 🅱️ Using with Official Vanilla Claude Code

1. Set your upstream and proxy environment variables:
   ```bash
   export ANTHROPIC_UPSTREAM_BASE_URL="http://127.0.0.1:20128"
   export ANTHROPIC_BASE_URL="http://127.0.0.1:20329"
   ```
2. Start `claude` normally. Every decision turn for `deepseek-v4-pro*` enters the DSH minimal environment triggering "We need" reasoning, tool execution turns get full tool access, and all other models (Claude 3.7, GPT, Gemini) pass through 100% untouched.

---

## 🎮 Command Matrix

| Skill Command | Description | Typical Use Case |
| :--- | :--- | :--- |
| **`/we-need-ds <task>`** | **Execute with full-power reasoning** | Primary entry point: enables interception and runs task |
| **`/we-need-ds:plan <task>`** | **Read-only planning agent** | Summons `we-need-planner` to generate Markdown blueprint |
| **`/we-need-ds:doctor`** | **Health diagnostic** | Inspects proxy port, environment mode, provider pool takeover and connectivity status |
| **`/we-need-ds:test`** | **Run test simulation suite** | Assertions covering decision-turn minimal mode, execution-turn passthrough, non-target passthrough, M1/M3 edge cases, and the non-DS safety baseline |
| **`/we-need-ds:status`** | **Inspect runtime status** | Shows daemon state, interception switch, hooked providers, and logs |
| **`/we-need-ds:list`** | **List all providers with takeover hints** | Shows which providers declare DS models `🎯`, which is the current default `⭐`, and which is already proxied `🔌`, so you can decide what to hook |
| **`/we-need-ds:on`** | **Enable interception** | Hooks the current default DS provider by default; `on --provider <id>` hooks any DS-model provider you pick (auto-syncs activeId) and creates the direct copy |
| **`/we-need-ds:off`** | **Force disable & restore** | Restores the hooked body to its real upstream and removes the direct copy |
| **`/we-need-ds:restart`** | **Gracefully restart the daemon** | When the proxy is wedged (e.g. full of stalled upstream requests) or after a code update: kills the old process → spawns a fresh daemon → re-hooks providers from the ledger |

---

## 🔌 Manual Recovery After Reboot (no system-level registration)

Windows shutdown/restart **kills the daemon outright** and bypasses every session hook — the hooked body is left in an "orphan" state pointing at a dead proxy port. This plugin **deliberately performs no system-level persistence** (no scheduled tasks, no Startup-folder entries): a plugin should be a plugin — it doesn't silently modify your system, and uninstalling leaves nothing behind.

**Since v2.2.0 the deadlock is eradicated**: the proxy hooks only the single current default provider, while all other providers and the auto-generated `· direct copy` always stay connected directly. So even after a reboot with the daemon dead, you can still send messages normally (via any non-hooked provider or the copy) and recovery commands still get through — no more "everything points at a dead port, can't even send `on`" deadlock.

Therefore **after a reboot, or after fully restarting cc-haha / Claude Code**, start interception once explicitly (same as invoking any skill):

- Run `/we-need-ds:on` in Claude Code — revives the daemon + restores orphans + re-hooks from the ledger, in one step;
- Or run `node "<CACHE>\lib\ctl.js" boot` in a terminal — the host-hook-independent equivalent, self-healing per the ledger's `enabled` flag (enabled → revive daemon + restore orphans + re-hook; disabled → clean up strays).

In-session self-healing (the UserPromptSubmit hook: every new message checks the daemon and revives + re-hooks if it's dead) still works on hosts that support plugin hooks (e.g. native Claude Code), and doesn't conflict with the manual start above. cc-haha's sidecar runs as a persistent server and does not execute plugin hooks, so under cc-haha rely on the manual `on`/`boot`.

**Fail-safe restore (no deadlock)**: every recovery path (`on` / `boot` / hooks) that fails to bring the daemon up **automatically restores any provider still pointing at the proxy port back to its real upstream** — never leaving a deadlocked state where endpoints point at a dead proxy, the app is unusable, and even the recovery command can't get through. The restore is **not one-way**: on the very next message, if the ledger says `enabled`, the daemon is alive, and zero providers are hooked, the UserPromptSubmit hook re-hooks automatically — so the first turn after recovery is proxied and trimmed again. `status` / `doctor` print a prominent warning (plus the recovery command) when providers point at the proxy port but the daemon is down.

---

## ⚙️ Configuration (`config.json`)

```json
{
  "port": 20329,
  "targetBaseUrl": "auto",
  "targetModels": [
    "deepseek-v4-pro-0813",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-v4-flash-0731"
  ],
  "bootstrapCoreTools": [
    "Bash",
    "Edit"
  ],
  "logDetails": false,
  "idleAutoShutdownMinutes": 0,
  "executionDshPersona": true,
  "thinkingBudget": 8000,
  "upstreamRetries": 1,
  "upstreamRetryBackoffMs": 500,
  "upstreamHeaderTimeoutMs": 30000,
  "upstreamBodyTimeoutMs": 30000,
  "upstreamIdleTimeoutMs": 600000
}
```

| Option | Default | Description |
| :--- | :--- | :--- |
| `port` | `20329` | Local transparent proxy port (binds 127.0.0.1 only). Change if occupied; the `WE_NEED_DS_TEST_PORT` env var overrides it for tests without touching production config. |
| `targetBaseUrl` | `"auto"` | Upstream resolution. `"auto"` = route each request back to its provider's real upstream by API Key from the ledger; a concrete URL forces all traffic to that upstream. |
| `targetModels` | DS V4 family | Models that trigger interception (normalization engine matches underscores/spaces/hyphens/path prefixes/case variants). **Every model outside this list (Claude / GPT / Gemini / Qwen, …) is passed through byte-for-byte, never modified.** |
| `bootstrapCoreTools` | `["Bash","Edit"]` | Minimal tool set kept on decision turns (mirrors DSH's bash + str_replace_editor pair). Tools already invoked in conversation history are also auto-kept to avoid protocol validation errors. |
| `logDetails` | `false` | When `true`, logs every passthrough request's URL and upstream (for routing debugging). |
| `idleAutoShutdownMinutes` | `0` | Idle auto-release switch. Default `0` = daemon stays resident; set to N to auto-restore the hooked provider(s) to direct and exit after N idle minutes — the UserPromptSubmit hook revives it on your next message. |
| `executionDshPersona` | `true` | Whether execution turns also switch to the DSH persona (default `true`; `false` restores v5 full passthrough on execution turns). |
| `thinkingBudget` | `8000` | Anthropic extended-thinking budget injected on decision turns. Controlled experiments proved the `thinking` field **must be present** for the "We need" chain to fire (budget size is irrelevant, but a missing field fails). Default `8000` = injects `thinking: {type:"enabled", budget_tokens:8000}` on the Anthropic path; `0` disables injection. A built-in `max_tokens` clamp guard skips injection when the host sends a small `max_tokens` (≤ budget — e.g. title generation), avoiding Anthropic's `max_tokens > budget_tokens` 400. The OpenAI path is always exempt (transit-400 guard). |
| `stripSystemPersona` | *(absent = on)* | Master persona-replacement switch. By default every DS-target request gets the DSH one-liner persona; set to `false` to disable persona replacement entirely (tool trimming still applies). |
| `upstreamRetries` | `1` | Upstream retry count (excluding the first attempt, so 2 total tries by default). **Only retryable failures are retried**: empty body, connection reset, 408/409/425/429, 5xx, timeouts; deterministic errors (DNS ENOTFOUND, host unreachable, invalid URL, etc.) **fail fast without retry** — retrying them only adds latency. No retry once the client disconnects. The proxy stays deliberately conservative: the upstream may already retry on its own, and stacking more retries here amplifies into a retry storm. Set `0` to disable. |
| `upstreamRetryBackoffMs` | `500` | Retry backoff base in ms, doubling per attempt (500→1000→…), capped at 60s total; when the upstream sends a `Retry-After` header the larger of the two wins (the header is clamped to 0–60s so a malicious/absurd value can't wedge the proxy). |
| `upstreamHeaderTimeoutMs` | `30000` | **Header timeout** in ms. If the upstream doesn't even return response headers within this window after the request is sent (connection-level stall), it is treated as a retryable failure and fails fast instead of hanging until the socket timeout. |
| `upstreamBodyTimeoutMs` | `30000` | **Non-streaming body timeout** in ms. Applies only to non-streaming responses (`Content-Type` is not `text/event-stream`): headers arrived but not a single body byte within this window ("headers but no body" stall) is treated as a retryable failure. **Streaming responses are exempt from this gate** — reasoning models (e.g. deepseek-v4-pro) can legitimately take tens of seconds or more before the first token; once headers arrive the proxy waits indefinitely for the first byte and never kills a slow-thinking stream. |
| `upstreamIdleTimeoutMs` | `600000` | **Socket idle timeout** in ms. An upstream connection with no activity for this long is considered dead and destroyed (default 10 minutes, covering long silent thinking stretches in a stream). |

---

## ⚠️ Boundaries & Notes

1. **Ledger trust chain**: when the plugin rewrites a provider's `baseUrl` to the proxy address, it records the baseUrl *at the moment of rewriting* as the real upstream (`originalUrl`). So **make sure every provider's baseUrl in cc-haha points to a real upstream** (official endpoint or your own relay, e.g. 9router on `:20128`). If you manually configure a provider to point at *another proxy*, the plugin will record that proxy address as the real upstream and restore to it — this is a design boundary, not a bug. Run `/we-need-ds:doctor` before enabling interception to verify each provider's original upstream.
2. **Two version lines**: **v5 / v5.1 / v5.2** throughout the docs refers to the **mechanism version** (the turn-aware DSH minimal simulation algorithm's evolution codename); the plugin itself follows **semver** (see `plugin.json` and CHANGELOG, currently `2.4.x`). They are numbered independently: mechanism v5.2 ships in plugin 2.4.4. GitHub Releases use semver.
3. **Port occupancy**: the proxy binds `127.0.0.1:20329` by default. If occupied, change `port` in `config.json`; on a port change the plugin first restores providers pointing at the old port, then re-hooks them on the new port — the proxy address is never recorded as a real upstream.
4. **Test isolation (read before running the suites)**: the self-test suites rewrite providers.json and runtime-state.json. To avoid polluting your live environment, set three isolation env vars so tests read/write a temp dir and never touch production files: `WE_NEED_DS_TEST_PORT` (test port), `WE_NEED_DS_PROVIDERS_PATH` (temp providers.json path), `WE_NEED_DS_DATA_DIR` (temp data dir). `test_full.js` / `test_consume.js` have this isolation built in (via `os.tmpdir()`), so `node test_full.js` is safe as-is; when manually running takeover commands like `ctl on/off` without touching production, set the same three vars.
5. **Interception-mode routing & drift visibility (v2.4.4)**: in interception mode (non-empty ledger `providers`) the proxy routes strictly by API Key — **if a request's key misses `keyMap`, the proxy returns 502 explicitly and never silently misroutes to `defaultUpstream`** (so that if you change the hooked provider's key, a request can't be sent to DeepSeek official with the new key and surface only a puzzling 401). No-key requests and pure-Claude-Code mode (empty `providers`) still fall back to `defaultUpstream`/env. Because cc-haha's sidecar doesn't run our hooks, if you **edit/recreate the hooked provider (id drift) or add a new DS provider and make it default**, the takeover goes stale and "We need" silently stops — `doctor` detects this and prints an **interception-drift warning** with the recovery command (re-run `on`). `boot`/`restart` cleanup is also guarded: it only kills a process confirmed to be ours (a live `/health-check` ok-response, or no response but a `node.exe` image) and skips/aborts rather than killing an unrelated program on the port.

---

## 📄 License

MIT License. Authored by [YixuAn](https://github.com/YixuAnsensei).  
Special thanks to [cc-haha](https://github.com/NanmiCoder/cc-haha) and the DeepSeek Harness community.
