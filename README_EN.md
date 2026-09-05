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

## 💡 The Solution: Turn-Aware DSH Minimal Simulation (v5)

**`we-need-ds`** provides a transparent, zero-latency proxy plugin that dynamically decouples tool exposure based on request structure:

```mermaid
sequenceDiagram
    autonumber
    participant User as Developer
    participant CC as Claude Code / cc-haha
    participant Proxy as we-need-ds Proxy (:20329)
    participant Router as 9router / Upstream API / Official Endpoints

    User->>CC: Command: /we-need-ds Refactor authentication system
    Note over CC,Proxy: Session starts / Command invoked: Proxy ready, multi-provider pool attached
    CC->>Proxy: Decision Turn Request (new task text, carrying 30+ MCP tool schemas)
    
    rect rgb(235, 248, 255)
    Note over Proxy: v5 DSH Minimal Simulation (every decision turn):<br/>Target model matched → System prompt replaced with official DSH one-liner<br/>Tools trimmed to [Bash, Edit] (mirrors DSH bash + str_replace_editor)<br/>Dynamically routes to original upstream based on API Key
    end
    
    Proxy->>Router: Forward minimal request
    Router-->>CC: DeepSeek hits RL sweet-spot, emits "We need..." planning chain (SSE passthrough)
    
    Note over CC,Proxy: Execution Turn: model starts calling tools
    CC->>Proxy: Execution Turn Request (tool / tool_result)
    
    rect rgb(240, 253, 244)
    Note over Proxy: 100% Unrestricted:<br/>All MCPs and skills fully released
    end
    
    Proxy->>Router: Forward untouched
    Router-->>CC: Executes with all available MCP tools smoothly!
```

---

## ✨ Key Features

1. **⚡ Multi-Provider Pool & Dynamic Auth Routing**:
   * Automatically hooks all provider instances in `providers.json` (9Router, BAI, YJS, SenseTime, OpenCode, etc.).
   * Dynamically resolves and routes incoming requests back to each provider's real upstream URL using API Key / Auth headers. Switching providers across tabs works seamlessly.
2. **🎯 Turn-Aware DSH Minimal Simulation (v5.1, unified persona on all turns)**:
   * Pure request-structure detection: last message is fresh user text = **decision turn** (model plans), last message is tool/tool_result = **execution turn** (tool follow-up);
   * **Every decision turn** (not just the first) simulates the official DeepSeek Harness minimal mode: system prompt replaced with the official DSH one-liner `You are a helpful software engineer assistant.`, tools trimmed to the `Bash + Edit` pair (mirroring DSH's bash + str_replace_editor);
   * **Every execution turn (v5.1)** keeps full unrestricted tools while the persona is also switched to the DSH one-liner — the client only hard-validates JSON protocol structure (tool_use/tool_result blocks), never persona text, so the swap is protocol-safe; after an execution chain ends, the next new task re-enters minimal mode automatically. Set `executionDshPersona: false` to fall back to v5 behavior (execution turns fully untouched). Zero configuration.
3. **🛡️ Triple Safety Lifecycle & Zero-Deadlock Guarantee**:
   * **Host Hooks (where supported)**: SessionStart hook initializes the background proxy; UserPromptSubmit hook revives it automatically if dead; SessionEnd hook restores all provider URLs.
   * **Boot Self-Healing (host-hook independent)**: Windows shutdown/restart kills the daemon and bypasses every hook, leaving providers.json pointing at a dead proxy port. `node lib/ctl.js boot` self-heals from the ledger's `enabled` flag — revives the daemon + restores orphans + re-hooks, or cleans up a stray process when disabled. After a reboot, run `/we-need-ds:on` (or `node lib/ctl.js boot`) once to recover — the plugin deliberately registers nothing at the system level (see "Manual Recovery After Reboot" below).
   * **Always-on daemon**: stays resident by default (`idleAutoShutdownMinutes: 0`).
   * **100% Zero-Touch for Non-Target Models**: Claude, GPT, Gemini, Qwen models pass through with pure byte-level streaming.

---

## 🚀 Getting Started

### 🅰️ Using with [cc-haha](https://github.com/NanmiCoder/cc-haha) (Zero Config)

1. **Zero configuration required**: Keep your provider `baseUrl` pointing to your normal 9router / API port (e.g., `http://localhost:20128`).
2. **Multi-window flexibility**: The plugin manages all providers concurrently.
3. **Usage**:
   ```bash
   /we-need-ds Build a complete unit test suite for the payment service
   ```
   Or for pure architecture planning without modifying code:
   ```bash
   /we-need-ds:plan Plan large scale refactoring
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
| **`/we-need-ds:doctor`** | **Health diagnostic** | Inspects proxy port, environment mode, 25-provider pool status |
| **`/we-need-ds:test`** | **Run test simulation suite** | Assertions covering decision-turn minimal mode, execution-turn passthrough, non-target passthrough, M1/M3 edge cases, and the non-DS safety baseline |
| **`/we-need-ds:status`** | **Inspect runtime status** | Shows daemon state, interception switch, hooked providers, and logs |
| **`/we-need-ds:on`** | **Enable interception** | Hooks all providers; decision turns enter minimal simulation by default |
| **`/we-need-ds:off`** | **Force disable & restore** | Restores all providers to their original upstream URLs |
| **`/we-need-ds:restart`** | **Gracefully restart the daemon** | When the proxy is wedged (e.g. full of stalled upstream requests) or after a code update: kills the old process → spawns a fresh daemon → re-hooks providers from the ledger |

---

## 🔌 Manual Recovery After Reboot (no system-level registration)

Windows shutdown/restart **kills the daemon outright** and bypasses every session hook — providers.json is left pointing at a dead proxy port. This plugin **deliberately performs no system-level persistence** (no scheduled tasks, no Startup-folder entries): a plugin should be a plugin — it doesn't silently modify your system, and uninstalling leaves nothing behind.

So **after a reboot, or after fully restarting cc-haha / Claude Code**, start interception once explicitly (same as invoking any skill):

- Run `/we-need-ds:on` in Claude Code — revives the daemon + restores orphans + re-hooks from the ledger, in one step;
- Or run `node "<CACHE>\lib\ctl.js" boot` in a terminal — the host-hook-independent equivalent, self-healing per the ledger's `enabled` flag (enabled → revive daemon + restore orphans + re-hook; disabled → clean up strays).

In-session self-healing (the UserPromptSubmit hook: every new message checks the daemon and revives + re-hooks if it's dead) still works on hosts that support plugin hooks, and doesn't conflict with the manual start above.

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
  "thinkingBudget": 0,
  "upstreamRetries": 2,
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
| `idleAutoShutdownMinutes` | `0` | Idle auto-release switch. Default `0` = daemon stays resident; set to N to auto-restore all providers and exit after N idle minutes — the UserPromptSubmit hook revives it on your next message. |
| `executionDshPersona` | `true` | Whether execution turns also switch to the DSH persona (default `true`; `false` restores v5 full passthrough on execution turns). |
| `thinkingBudget` | `0` | Optional Anthropic extended-thinking budget on decision turns. Default `0` = off (no thinking field injected; relies on the model's native chain). A positive N injects `thinking: {type:"enabled", budget_tokens:N}` as an optional reinforcement for deep reasoning. |
| `stripSystemPersona` | *(absent = on)* | Master persona-replacement switch. By default every DS-target request gets the DSH one-liner persona; set to `false` to disable persona replacement entirely (tool trimming still applies). |
| `upstreamRetries` | `2` | Upstream retry count (excluding the first attempt, so 3 total tries by default). Retries on empty body, connection reset, 5xx, or timeout (see the three gates below). **Only retried before any byte reaches the client** — once a streaming response has started forwarding it is never retried (avoids duplicated content). Set `0` to disable. |
| `upstreamRetryBackoffMs` | `500` | Retry backoff base in ms, doubling per attempt (500→1000→…); takes the larger of this and the upstream `Retry-After` header when present. |
| `upstreamHeaderTimeoutMs` | `30000` | **Header timeout** in ms. If the upstream doesn't even return response headers within this window after the request is sent (connection-level stall), it is treated as a retryable failure and fails fast instead of hanging until the socket timeout. |
| `upstreamBodyTimeoutMs` | `30000` | **Non-streaming body timeout** in ms. Applies only to non-streaming responses (`Content-Type` is not `text/event-stream`): headers arrived but not a single body byte within this window ("headers but no body" stall) is treated as a retryable failure. **Streaming responses are exempt from this gate** — reasoning models (e.g. deepseek-v4-pro) can legitimately take tens of seconds or more before the first token; once headers arrive the proxy waits indefinitely for the first byte and never kills a slow-thinking stream. |
| `upstreamIdleTimeoutMs` | `600000` | **Socket idle timeout** in ms. An upstream connection with no activity for this long is considered dead and destroyed (default 10 minutes, covering long silent thinking stretches in a stream). |

---

## ⚠️ Boundaries & Notes

1. **Ledger trust chain**: when the plugin rewrites a provider's `baseUrl` to the proxy address, it records the baseUrl *at the moment of rewriting* as the real upstream (`originalUrl`). So **make sure every provider's baseUrl in cc-haha points to a real upstream** (official endpoint or your own relay, e.g. 9router on `:20128`). If you manually configure a provider to point at *another proxy*, the plugin will record that proxy address as the real upstream and restore to it — this is a design boundary, not a bug. Run `/we-need-ds:doctor` before enabling interception to verify each provider's original upstream.
2. **Two version lines**: **v5 / v5.1** throughout the docs refers to the **mechanism version** (the turn-aware DSH minimal simulation algorithm's evolution codename); the plugin itself follows **semver** (see `plugin.json` and CHANGELOG, currently `2.1.x`). They are numbered independently: mechanism v5.1 corresponds to plugin 2.1.x. GitHub Releases use semver.
3. **Port occupancy**: the proxy binds `127.0.0.1:20329` by default. If occupied, change `port` in `config.json`; on a port change the plugin first restores providers pointing at the old port, then re-hooks them on the new port — the proxy address is never recorded as a real upstream.
4. **Test isolation (read before running the suites)**: the self-test suites rewrite providers.json and runtime-state.json. To avoid polluting your live environment, set three isolation env vars so tests read/write a temp dir and never touch production files: `WE_NEED_DS_TEST_PORT` (test port), `WE_NEED_DS_PROVIDERS_PATH` (temp providers.json path), `WE_NEED_DS_DATA_DIR` (temp data dir). `test_full.js` / `test_consume.js` have this isolation built in (via `os.tmpdir()`), so `node test_full.js` is safe as-is; when manually running takeover commands like `ctl on/off` without touching production, set the same three vars.

---

## 📄 License

MIT License. Authored by [YixuAn](https://github.com/YixuAnsensei).  
Special thanks to [cc-haha](https://github.com/NanmiCoder/cc-haha) and the DeepSeek Harness community.
