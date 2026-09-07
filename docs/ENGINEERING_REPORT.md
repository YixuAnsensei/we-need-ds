# we-need-ds 插件工程开发报告

> 文档版本：对应插件 semver `2.4.2` / 机制版本 `v5.1`
> 撰写日期：2026-09-07
> 文档性质：完整工程实现说明。面向接手/评审的工程师与智能体，实事求是描述"实现了什么、如何实现、为什么这样设计、遇到过什么问题、当前边界在哪"，不包含开发方向上的倾向性建议。

---

## 1. 项目背景与开发目的

### 1.1 模型机制发现（问题的源头）

DeepSeek Harness（DSH）社区的观察与本项目实测共同确认：**DeepSeek-V4-Pro 系列模型的推理表现对"首轮工具上下文规模"高度敏感，存在显著双面性**：

| 模式 | 表现 | 触发条件 |
| :--- | :--- | :--- |
| 🟢 "We need..." 满血深度规划 | 面对复杂工程任务先做宏观拆解、边界推演、架构设计，思维链以 "We need..." 展开 | 请求中工具集极简（DSH 官方模式仅 bash + str_replace_editor 两件套 + 一行系统人格），命中 RL 训练的深度推理甜点区 |
| 🔴 "Let me..." 浅层工具试探 | 陷入微观工具调用纠结、频繁试错、思维链退化为 Tool-Churning | 请求体携带数十个 MCP 工具 Schema + 数千行系统提示词，注意力被工具列表牵引 |

### 1.2 生态矛盾与开发目的

现代开发者在 Claude Code / cc-haha 中普遍挂载大量 MCP（数据库、浏览器、绘图、终端等）。矛盾在于：

- 手动关掉全部 MCP 来诱导 "We need" → 开发体验直接报废；
- 不关 → DeepSeek 永远陷在 "Let me"；
- 纯提示词催眠无效 → 只要 JSON 请求体里还带一长串 Tool Schemas，模型注意力就被强制牵引回工具试探。

**开发目的**：做一个全自动本地代理插件，**不关闭任何 MCP**，在"模型应当做深度规划的轮次"动态把请求体裁剪成 DSH 官方极简形态，在"模型正在执行工具链的轮次"原样放行全量工具，从而在真实开发工作流中稳定唤醒满血思维链。同时必须兼容两条宿主产品线（cc-haha GUI 与官方 Claude Code CLI），且在任何异常路径（进程被杀、断电重启、端口被占）下不得把用户的 provider 配置锁死在不可用状态。

### 1.3 核心设计原则

1. **轮次结构感知（Turn-Aware）**：不依赖会话状态记忆，纯靠请求体结构判定当前轮次类型（见 3.1.3）。
2. **常态模拟而非首轮模拟**：每个判定轮都进入极简环境，不限会话首轮（v5 机制修正了早期"仅首轮"的设计）。
3. **非目标模型零侵入**：Claude / GPT / Gemini / Qwen 等一律字节级原样透传，绝不修改。
4. **失败即还原、还原可逆**：任何恢复路径失败都自动退回直连，绝不留"端点指向死代理"的死锁；且还原不是单向终点，daemon 复活后自动重新接管。
5. **插件不做系统级注册**：不写计划任务、不写 Startup 文件夹，卸载即干净；重启后的恢复由用户显式触发（这是用户明确否决了开机自启动方案后确立的边界）。

---

## 2. 总体架构

### 2.1 双轨分治

```
                   ┌──────────────────────────────────────┐
                   │           用户请求发起层               │
                   └──────────────────┬───────────────────┘
                                      │
               ┌──────────────────────┴──────────────────────┐
               ▼                                             ▼
    【cc-haha GUI 轨】                             【Claude Code CLI 轨】
  • 底层: 常驻 sidecar HTTP 转发                 • 底层: 原生 Node.js 命令行进程
  • 特性: 不触发插件 lifecycle hooks              • 特性: 毫秒级触发钩子 (user-prompt-submit)
  • 接管策略: 单服务商接管 + 直连副本逃生口       • 接管策略: 环境变量驱动 / 账本按需接管
  • 运行策略: 守护进程常驻 (0 自动退出)          • 运行策略: 消息级自愈复活 (前置拦截防跳轮)
  • 交互方式: 界面设为默认 + 手动 /on /off      • 交互方式: 原生无感全自动 / 命令控流
               │                                             │
               └──────────────────────┬──────────────────────┘
                                      ▼
                      【we-need-ds 本地智能代理网关】
                                (端口: 20329, 仅绑定 127.0.0.1)
                                      │
        ┌─────────────────────────────┴─────────────────────────────┐
        ▼                                                           ▼
  【DeepSeek 模型 (判定轮)】                                  【其他所有情况】
  • 识别: 末条消息为新 user 文本                              • 非 DS 模型 (Claude/GPT/Gemini)
  • 动作:                                                     • DS 执行轮 (末条 tool/tool_result)
    1. 工具集裁剪至 Bash + Edit                               • 动作:
    2. 系统词替换为 DSH 单行人格                                1. 执行轮: 工具全量放行, 人格同步 DSH 单行
  • 效果: 迫使 DS 触发 "We need..." 深度规划链                  2. 非 DS: 100% 原始字节流无损透传
                                      │
                                      ▼
                      【真实上游 / 中转站 / 9Router / 官方端点】
```

### 2.2 组件清单

| 组件 | 路径 | 职责 |
| :--- | :--- | :--- |
| 代理网关 | `proxy.js` | 请求拦截、轮次判定、DSH 塑形、上游路由、超时重试、流式透传、`/health-check`、`/ctl` |
| 状态机 | `lib/state.js` | 配置加载、账本读写、接管/释放算法、副本体系、迁移、文件锁与原子写 |
| 命令行 | `lib/ctl.js` | `on/off/status/doctor/boot/restart` 六个子命令 |
| 宿主钩子 | `hooks/*.js` + `hooks/hooks.json` | SessionStart / UserPromptSubmit / SessionEnd 三钩子（仅支持 hooks 的宿主生效） |
| 技能入口 | `skills/*/SKILL.md` | `/we-need-ds`、`:on`、`:off`、`:status`、`:doctor`、`:test`、`:restart` |
| 子代理 | `agents/we-need-planner.md` | `/we-need-ds:plan` 只读深度规划器 |
| 测试 | `test_full.js`、`test_consume.js`、`test_simulation.js`、`test_stress.js` | 135 项断言主套件 + 25 项并发压力审查等 |

### 2.3 数据文件布局

```
~/.claude/
├── cc-haha/providers.json          # cc-haha 的 provider 路由表（被接管对象）
├── we-need-ds/                     # 插件集中数据目录（跨版本持久化）
│   ├── runtime-state.json          # 运行时账本
│   └── we-need-ds.log              # 运行日志
└── plugins/
    ├── cache/claude-plugins-official/we-need-ds/<version>/   # 插件运行时代码
    └── marketplaces/claude-plugins-official/plugins/we-need-ds/  # marketplace 源
```

账本 `runtime-state.json` 结构：

```json
{
  "enabled": true,
  "proxyUrl": "http://127.0.0.1:20329",
  "providers": { "<activeId>": { "name": "...", "originalUrl": "https://真实上游", "apiKey": "sk-..." } },
  "keyMap": { "sk-...": "https://真实上游" },
  "defaultUpstream": "https://真实上游",
  "ts": "ISO 时间戳"
}
```

---

## 3. 核心实现细节

### 3.1 代理网关 `proxy.js`

#### 3.1.1 上游解析与路由（`resolveTargetBaseUrl`，proxy.js:12-34）

优先级链（每一级都做 `isSelfProxyUrl` 防回环校验，绝不把代理自身地址当上游）：

1. `config.targetBaseUrl` 非 `"auto"` → 强制所有请求回源该地址；
2. 请求头 `authorization`（剥 `Bearer ` 前缀）或 `x-api-key` 的 token，在账本 `keyMap` 中精确命中 → 该 provider 的真实上游；
3. 账本 `defaultUpstream`（非占位值 `'env/default'`）；
4. 环境变量 `ANTHROPIC_UPSTREAM_BASE_URL`；
5. 全部落空 → **502 显式拒绝**（proxy.js:406-411），错误信息说明"apiKey 未在账本中且无兜底，已拒绝以避免错发到其他服务商"。设计意图：宁可显式失败，绝不静默错发。

路由依据是 API Key 而非请求路径，原因见第 5 节（cc-haha sidecar 会剥掉路径前缀，代理无法从请求知道来源 provider）。

URL 重建（`buildTargetUrl`，proxy.js:113-117）：保留上游 baseUrl 的路径前缀（如 `https://x/anthropic` + `/v1/messages` → `https://x/anthropic/v1/messages`），query string 原样保留。

#### 3.1.2 模型识别（proxy.js:52-74）

- `normalizeModelName`：小写 + 剥离 `- _ 空格 /`，归一化变体；
- `isDeepSeekProModel`：先与 `config.targetModels` 列表匹配（全等 / endsWith / 原始小写 includes），命中即目标；未命中走启发式兜底：`(deepseek|ds) && (v4|4pro|pro|flash)`；
- 列表之外的模型（claude-*、gpt-*、gemini-* 等）一律不命中 → 走透传分支。

#### 3.1.3 轮次判定（proxy.js:76-101）

纯请求结构判定，无状态：

- `isToolFollowup`：末条消息 `role === 'tool'`（OpenAI 风格），或末条 `role === 'user'` 且 content 数组含 `type: 'tool_result'` 块（Anthropic 风格）→ **执行轮**；
- `isDecisionTurn`：末条 `role === 'user'` 且非 tool followup → **判定轮**（等待模型规划）；
- `shouldFilterTools` = DS 目标模型 && 有 messages && 判定轮。

边界处理（测试 E4 覆盖）：末条为 `tool_result` + 文本混合时仍判执行轮，不误砍进行中的工具链。

#### 3.1.4 请求体处理管线（`processRequestBody`，proxy.js:171-211）

```
JSON.parse 失败 → 原样返回 rawBody（透传保底）
非 DS 模型 / 无 messages → 原样返回 rawBody（字节级透传，"三不原则"：不改人格、不改 tools、不碰 thinking）
DS + 执行轮:
  executionDshPersona=true  → 仅替换人格为 DSH 单行，工具全量保留
  executionDshPersona=false → 完全透传（v5 行为）
DS + 判定轮:
  1. 工具裁剪: body.tools 过滤为 bootstrapCoreTools(Bash/Edit, 大小写不敏感)
     ∪ collectUsedToolNames(会话历史中已出现过的 tool_use/tool_calls 名称)
     —— 保留历史已调用工具是防止模型续写引用未声明工具导致协议校验失败
  2. 人格替换: applyDshMinimalSystem
  3. thinkingBudget>0 且 anthropic 路径 → 注入 thinking:{type:"enabled",budget_tokens:N}
     （OpenAI 路径不注入，防中转站 400，测试 E7 覆盖）
DS + 其他(末条非 user 的异常结构):
  executionDshPersona=true → 仅替换人格
```

压缩请求体（`content-encoding` 非 identity）不做任何修改直接透传（proxy.js:426-428）。

#### 3.1.5 双协议人格适配（proxy.js:105-136）

- `formatFromRequestPath`：路径含 `/messages` → anthropic；含 `/chat/completions`、`/responses`、`/completions` → openai。**路径判定强于 body 特征**（测试 F5/F6 覆盖，解决 9router 等中转站 body 形态与端点不一致的问题）；
- `resolveOpenAiStyle`：路径优先；路径未知时以 `body.system === undefined` 推断；
- `applyDshMinimalSystem`：
  - 先剔除 messages 内所有 `role: 'system'`（防重复 system 消息）；
  - OpenAI 风格：`delete body.system` + messages 头部注入 `{role:'system', content: DSH_MINIMAL_PROMPT}`；
  - Anthropic 风格：顶层 `body.system = [{type:'text', text: DSH_MINIMAL_PROMPT, cache_control:{type:'ephemeral'}}]`，保留 cache_control 以兼容 Anthropic prompt caching，绝不在 messages 里塞非法 role:system；
- `DSH_MINIMAL_PROMPT = 'You are a helpful software engineer assistant.'`（DSH 官方单行）。

人格替换总开关 `config.stripSystemPersona === false` 时完全关闭（仅保留工具裁剪）。

#### 3.1.6 上游转发：三道超时门 + 重试（proxy.js:213-369）

| 门 | 默认值 | 语义 | 适用 |
| :--- | :--- | :--- | :--- |
| `upstreamHeaderTimeoutMs` | 30s | 请求发出后响应头都不到（连接级挂起）→ 可重试失败 | 全部 |
| `upstreamBodyTimeoutMs` | 30s | 头已到但一个 body 字节都不到（"只发头不发体"stall）→ 可重试失败 | **仅非流式**（Content-Type 非 text/event-stream） |
| `upstreamIdleTimeoutMs` | 600s | socket 连续无活动 → 死连接销毁，可重试 | 全部（活动计时，有数据即重置） |

关键设计：**流式响应豁免 body 门**——推理模型首 token 可能合法地慢到几十秒以上，头到齐后代理无限等待首字节，绝不误杀慢思考流（测试 H1 验证流式慢首字完整透传、H2 验证非流式 stall 快速 502）。

重试策略（`forwardWithRetry`，v2.4.0 分级化）：
- **分级重试**：可重试失败 = 空 body、连接重置类错误、408/409/425/429/5xx、三道门超时；**确定性错误不重试**（`isRetryableNetError` 排除 ENOTFOUND/EAI_AGAIN/EHOSTUNREACH/EACCES/EPERM/ERR_INVALID_URL/ERR_INVALID_ARG_TYPE，这类重试只叠加延迟）；`ECONNREFUSED` 刻意保留可重试（覆盖本地中继重启窗口）；
- `upstreamRetries=1`（共 2 次尝试，v2.4.0 由 2 降为 1——代理夹在重试 10 次的 CLI 与可能自带重试的上游之间，多重试放大成风暴），指数退避 `500ms × 2^(n-1)` 封顶 60s，上游带 `Retry-After` 时取较大值（该头 clamp 到 0–60s 防异常值挂死代理）；
- **客户端断开取消**：顶层 `ctx.clientGone`（`res` close 时置位）在每次尝试前、响应到达后、catch 内三处检查——断开后不再发起重试、不再半转发；
- **仅在尚未向客户端吐出任何字节前重试**；`attemptUpstream` 拿到首 chunk 即 `resolve` 并 `pause()` 流，主流程 `writeHead + write(firstChunk) + pipe(res)` 建立透传；
- 流中途错误/aborted → 记日志后 `res.destroy()`，**对客户端透明断开**（不伪造完成、不重试造成内容重复）；
- 重试耗尽：已发头则 destroy；未发头则透传上游错误响应（若有）或 502，错误体按请求路径输出 anthropic/openai 标准格式（`buildErrorBody`）。

#### 3.1.7 控制端点与进程韧性

- `GET /health-check` → `{status:'ok'}`（存活探测，hooks/ctl 均用它）；
- `POST /ctl` `{action:'on'|'off'|'arm', providerId?}` → 进程内直接调 `state.enableInterception(config, {providerId})/disableInterception`；`on` 可携带 `providerId` 指定接管目标（v2.3.0）；`arm` 为兼容保留，返回"v5 轮次结构判定，无需 arm 窗口"；未知 action → 400；
- `uncaughtException` / `unhandledRejection` 捕获记日志、daemon 存活（proxy.js:467-472）；`server` 的 `EADDRINUSE` → 记日志 exit(1)；`clientError` → 销毁 socket；
- 空闲自毁：`idleAutoShutdownMinutes > 0` 且无活跃请求且空闲超时 → `disableInterception`（还原+清副本）后 `process.exit(0)`；默认 `0` = 常驻不自毁。

### 3.2 状态机 `lib/state.js`

#### 3.2.1 路径与配置

- `PROVIDERS_PATH`：`~/.claude/cc-haha/providers.json`，可被 `WE_NEED_DS_PROVIDERS_PATH` 覆盖（测试隔离）；
- `DATA_DIR`：`~/.claude/we-need-ds`，可被 `WE_NEED_DS_DATA_DIR` 覆盖；账本与日志集中于此，跨插件版本持久化；
- `loadConfig`：内置默认值 ⊕ `config.json` 合并 ⊕ `WE_NEED_DS_TEST_PORT` 端口覆盖（测试专用，不污染生产配置）；
- `migrateLegacyFiles`：启动时扫描旧账本位置（插件目录、marketplace 目录、cache 下**全部版本目录**），取 `ts` 最新者迁入集中目录并删除旧文件——解决账本散落在版本化 cache 路径导致升级后"失忆"的问题（测试 G2 覆盖）。

#### 3.2.2 并发与持久化安全

- 文件锁：`mkdir` 原子性实现（providers 用 `.weld.lock`，state 用 `.lock`），5 秒陈旧锁自动窃取，20ms 自旋，最长等待 2s；
- 原子写：`<path>.<pid>.tmp` + `rename`，防半写损坏（测试 F7 覆盖：产出合法 JSON 且无残留 tmp）。

#### 3.2.3 单服务商接管算法（`enableInterception`，state.js:267-355）

**纯 CC 模式**（无 providers.json）：不碰任何文件，仅写账本 `enabled=true` + `defaultUpstream`（config.targetBaseUrl 非 auto → env → `http://127.0.0.1:20128` 兜底），返回 `mode:'env'`。

**cc-haha 模式**，按序：

1. **迁移旧状态**：`restoreAllProxied`（把一切指向代理端口的非副本 provider 还原真实上游，双数据源：账本 `originalUrl` 或对应副本的 `baseUrl`）+ `removeAllCopies`（清除旧副本）。这一步保证从 v2.1.x 全量接管态、或任何残留态，幂等地收敛到干净起点；
2. **锚定 activeId**：取 `data.activeId` 指向的非副本 provider。找不到 → 不接管，账本 enabled 但 providers 清空，返回 note"当前默认 provider 无效"；
3. **DS 模型校验**：`providerHasTargetModels`（模型值归一化匹配 targetModels + 启发式 `deepseek|ds && v4|pro`）。不含 DS Pro → **不接管不建副本**，返回 note"默认 provider 非 DeepSeek Pro，未接管；要触发裁剪请把 DS provider 设为默认"（测试 J10 覆盖）；
4. **接管 + 建副本**：
   - `realOriginal = activeProv.baseUrl`（改写瞬间的 baseUrl 记为真实上游——账本信任链，见 9.1）；
   - 账本剪枝为**单条** `freshLedger`（旧版 27 条全量账本在此被清掉）；`keyMap[apiKey] = realOriginal`；`defaultUpstream = realOriginal`；
   - 本体 `baseUrl → http://127.0.0.1:<port>`；
   - 深克隆副本：`id: 'wnd-copy-<id>'`、`name: '<名> · 直连副本'`、`baseUrl: realOriginal`、`weNeedDsCopy: true`、`weNeedDsOf: <本体id>`，push 进 providers；
   - 返回 `{activeHooked, copyName, totalHooked: 1}`。

幂等性：重复 `on` 先走第 1 步迁移（本体从代理还原回 realOriginal、旧副本删除），再重新接管+重建副本，不产生多副本、不把代理地址污染进 `originalUrl`（测试 J6/G1 覆盖）。

切换默认服务商后再 `on`：旧本体在第 1 步被还原直连，新默认被接管，副本始终只有一份。

#### 3.2.4 两段式安全释放（`releaseToDirect`，state.js:244-265）

`off` / `recoverOrphans` / 失败兜底共用此路径：

1. **第一阶段**：`restoreAllProxied` 还原本体 → `writeProviders` 落盘；
2. **第二阶段**：**重新读盘**验证无本体仍指向代理端口（`stillProxied`）→ 验证通过才 `removeAllCopies` 删副本并落盘；验证失败则**坚决保留副本**（用户手头永远有备用出口），日志说明原因。

还原数据源双保险：账本 `originalUrl` 优先，账本丢失/损坏时回落到副本 `baseUrl`（测试 J9 覆盖：账本丢失时副本充当冗余账本救回本体）。

无可信来源（既无账本记录、副本 baseUrl 也指向代理）的孤儿 → 列入 `unrestorable`，**保持原样不瞎猜还原**，ctl 输出警告提示人工核对（测试 D6 覆盖）。

#### 3.2.5 死状态检测（`detectDeadState`，state.js:381-393）

遍历非副本 provider，`baseUrl` 命中 `proxyPorts`（当前 config.port ∪ 账本 proxyUrl 端口，覆盖端口变更场景）即计孤儿。`status`/`doctor`/各钩子在"有孤儿且 daemon 未运行"时打印醒目告警 + 恢复命令。

### 3.3 命令行 `lib/ctl.js`

| 命令 | 行为 |
| :--- | :--- |
| `on` | daemon 未活则 spawn（detached + 轮询 `/health-check` 最多 3s）→ `POST /ctl on` → 打印接管结果（`activeHooked` + 副本名，或非 DS note）。**失败兜底**：daemon 起不来且存在孤儿 → `recoverOrphans` 还原直连，打印"避免死锁"提示，exit(1) |
| `off` | `POST /ctl off`（daemon 活着走进程内）否则直接调 `disableInterception` → 打印还原清单、`removedCopies`、`unrestorableList` 警告 |
| `boot` | 读账本自愈：`enabled` → 拉起 daemon（若死）+ `recoverOrphans` 修孤儿 + `enableInterception` 重接管；daemon 起不来 → 还原直连防死锁。`!enabled` → 修孤儿 + 若端口有残留 daemon 进程则 netstat 找 PID taskkill 清理 |
| `restart` | netstat 找 PID → taskkill → 等端口释放 → spawn 新 daemon → 等就绪 → 账本 enabled 则 `/ctl on` 重接管。用于代理卡死或代码更新后重载 |
| `status` | daemon 活度、拦截开关、被接管清单（含原始上游）、副本清单（标注"代理死掉时切到它即可直连恢复"）、死状态告警 |
| `doctor` | 端口活度、死状态告警、环境模式（cc-haha / 纯 CC）、当前默认 provider、接管状态、DS provider 池（逐个标注代理中/直连）、配置摘要 |

### 3.4 宿主钩子（仅支持插件 hooks 的宿主生效，即原生 Claude Code）

`hooks.json` 注册三个钩子（注意其结构为嵌套 `hooks` 数组，这是 cc-haha 插件管线验证过的格式）：

- **SessionStart**（matcher `startup|resume`，`hooks/session-start.js`）：`recoverOrphans` 修孤儿 → daemon 未活则 spawn+轮询 → `POST /ctl on` → 打印接管结果；失败且存在孤儿 → `disableInterception` 还原直连。
- **UserPromptSubmit**（`hooks/user-prompt-submit.js`）：每条新消息发送前自检——
  - daemon 死：账本 `enabled` 才处理；spawn + 轮询最多 3s；成功 → `recoverOrphans` + `enableInterception`，**当轮请求即命中刚自愈的代理，100% 享受裁剪，不跳轮**；失败 → 还原直连防死锁；
  - daemon 活：账本 enabled 且无死状态但零接管（上次失败兜底还原过）→ 幂等 `enableInterception` 重接管，当轮恢复裁剪（测试 I1 覆盖）。
- **SessionEnd**（`hooks/session-end.js`）：`disableInterception` 还原 + 清副本，打印还原清单与 unrestorable 警告。

### 3.5 技能与命令入口

- `skills/we-need-ds/SKILL.md` 为主入口（裸 `/we-need-ds <任务>` 经 shim 转发）；`:on/:off/:status/:doctor/:test/:restart` 各自对应 ctl 子命令；
- `commands/plan.md` + `agents/we-need-planner.md`：`/we-need-ds:plan` 调用只读规划子代理（工具环境仅 Read/Glob/Grep，产出 Markdown 蓝图不动代码）；
- **实测事实**：cc-haha 下 commands 斜杠指令不可用，仅 skills 路径可用（见 9.6）。

---

## 4. 生命周期状态机

```
                    ┌──────────────┐
        /on 或钩子   │  直连态      │  ← 初始 / off 后 / 重启后(仅本体成孤儿)
      ┌─────────────► (全部provider │
      │              │  baseUrl=真实)│
      │              └──────┬───────┘
      │                     │ on: 仅 activeId 的 DS provider 本体→代理端口
      │                     │     + 建直连副本(baseUrl=真实上游) + 账本单条
      │              ┌──────▼───────┐
      │   off/boot   │  接管态      │  判定轮→裁剪+DSH人格; 执行轮→全量+DSH人格
      │ ◄─────────── │ (daemon 常驻) │  非DS模型→字节透传
      │  两段式释放   └──────┬───────┘
      │  (还原验证后才删副本) │
      │                     │ daemon 被杀(关机/重启/taskkill), 绕过所有钩子
      │              ┌──────▼───────┐
      └───────────── │  孤儿态      │  仅 1 个本体指向死端口;
   boot/on 自愈      │ (本体→死代理) │  其余 provider + 副本全部直连可用
   (修孤儿+重接管)    └──────────────┘  → 用户切副本/任意直连 provider 发消息
                                        → /on 或 ctl boot 一步恢复
```

失败路径统一原则：**任何路径拉不起 daemon → 立即把指向代理的 provider 还原直连**（不留死链）；**还原后账本仍 enabled → 下一条消息钩子（CC 轨）或下次 boot/on（cc-haha 轨）自动重新接管**（还原非单向终点）。

---

## 5. cc-haha sidecar 调查结论（关键外部事实）

以下结论来自对 sidecar 二进制与运行日志的实测，直接决定了接管策略的设计：

1. **sidecar 是常驻 server 模式**：cc-haha 内嵌的 `claude-sidecar-x86_64-pc-windows-msvc.exe`（约 114MB，完整 Claude Code 二进制）以持久 HTTP server 运行，**不执行插件 lifecycle hooks**（自 09-05 起无任何钩子日志痕迹）。因此 cc-haha 轨的接管/自愈只能靠手动 `on`/`boot` 与代理自身常驻，不能依赖钩子。
2. **sidecar 剥路径前缀转发**：claude 子进程 → sidecar `:55396` 的 `/proxy/providers/<activeId>/...` → sidecar 剥掉前缀，以干净路径（`/v1/messages` 等）转发到 provider 的 `baseUrl`。代理收到的请求**不含"当前激活哪个 provider"的信息**，只能靠 API Key 识别来源——这是"以 activeId 为接管标记 + 文档要求用户先把当前服务商设为默认"设计的直接原因。
3. **600s 流超时是客户端行为**：`Stream max duration exceeded - no completion received after 600s (last event: thinking_delta, ...)` 字符串存在于 sidecar 二进制内（客户端流总时长硬上限）；代理日志中该字符串 0 次出现。事故样本含 1553 个 delta，说明 socket 持续活跃，代理的空闲门（活动计时）从未触发。**该超时不在 we-need-ds 控制范围内**，代理侧无法解除；唯一可控缓解是裁剪提高思维链收敛概率（不保证时长）。
4. **9router anthropic 门缺陷**（关联事实）：9router 的 `/v1/messages` 非流式返回 OpenAI 格式，cc-haha 必须选 OpenAI 格式接 9router——这解释了代理为何要做路径优先的协议判定（3.1.5）。

---

## 6. 开发过程中遇到的问题与修复（实事求是）

| # | 问题 | 根因 | 修复与版本 |
| :--- | :--- | :--- | :--- |
| 1 | **重启全局死锁**（最核心问题）：v2.1.x 及以前 `on` 把 providers.json 全部 27 个服务商的 baseUrl 批量改成代理端口；Windows 关机直接杀 daemon 且绕过钩子，重启后全部指向死端口，连 `/we-need-ds:on` 都发不出去 | 静态 baseUrl 与动态代理端口的强耦合 + 全量接管放大故障面 | v2.2.0 单服务商接管 + 直连副本：只接管 activeId 本体，其余 26 个 + 副本始终物理直连；死锁从"全局"降为"单点且自带逃生口" |
| 2 | 开机自启动方案被否 | v2.1.10 曾实现 Startup 文件夹自启动，用户明确否决（插件不应有系统级副作用） | v2.1.11 revert，确立"不做任何系统级注册，重启后显式手动 on/boot"边界 |
| 3 | 失败还原导致"跳轮" | 兜底还原直连是单向终点：还原后当轮及后续消息裸发上游，丧失裁剪 | v2.1.13 还原可逆：账本 enabled + daemon 活 + 零接管时，UserPromptSubmit 钩子自动重接管，当轮恢复裁剪（测试 I1/I2） |
| 4 | 非 DS 模型"空返回"疑云 | 实为 daemon 死亡 / keyMap 未命中 → 502，并非透传逻辑缺陷；早期一次"验证"因在另一会话运行时改端口而无效 | 实测非 DS 的 anthropic/openai/流式请求全部透传成功；keyMap 未命中改为显式 502 拒绝而非静默错发 |
| 5 | 测试污染生产 config.json | `test_full.js` Phase B 把 `idleAutoShutdownMinutes` 临时改为 0.02 测空闲自毁，finally 恢复；但一次 kill 残留测试进程打断了 finally，0.02 残留；后续测试又"忠实恢复"了污染值 | 手工重写 config.json 为干净值（0 + 行尾换行）；确立测试隔离三环境变量规范（`WE_NEED_DS_TEST_PORT` / `WE_NEED_DS_PROVIDERS_PATH` / `WE_NEED_DS_DATA_DIR`），test_full/test_consume 内置 `os.tmpdir()` 隔离 |
| 6 | 测试端口 EADDRINUSE 2099/2100 | 被中断的残留 test_full.js 进程持有 mock 上游端口与测试 daemon 21329，并发实例互相串扰产生假失败 | 清理全部残留测试进程（保留生产 daemon）后单实例干净运行，89/89 通过 |
| 7 | 硬编码 20128 兜底遮蔽 env | 纯 CC 模式设了 `ANTHROPIC_UPSTREAM_BASE_URL` 却被硬编码值抢先 | 上游解析优先级修正（测试 F10）；端口变更场景：真实上游恰好等于旧代理端口时正确记为真实上游而非误判代理（F11） |
| 8 | 流式慢首 token 被误杀风险 | 统一 body 超时会杀死合法慢思考的推理模型流 | 三道门分离：body 门仅非流式生效，流式无限等首字节（H1/H2） |
| 9 | 中途断开被伪装成正常完成 | 上游流中途 error/aborted 时若静默吞掉，客户端收到截断内容无感知 | 首字节后不重试，error/aborted 记日志并 `res.destroy()` 透明断开（v2.1.13） |
| 10 | 账本散落 cache 版本目录 | 早期账本写在 `cache/.../1.0.0/` 硬编码路径，升级即"失忆" | `migrateLegacyFiles` 扫描 cache 全部版本目录取最新 ts 迁入集中目录（G2） |
| 11 | 提示注入事件 | 会话中收到伪造 system-reminder（假 ComfyUI 工具目录要求按捏造格式调用工具） | 识别为注入内容，拒绝执行并向用户报告 |
| 12 | **H1：无效 `--provider` 破坏既有接管**（v2.3.0 引入） | `enableInterception` 在校验目标 provider 之前就执行了 `restoreAllProxied`/`removeAllCopies`，非法 id 会先清掉当前接管再报错 | v2.4.0 校验前置，所有拒绝路径在任何写操作之前返回（回归 L9a/L9b） |
| 13 | **重试风暴**（三方对照发现） | 代理夹在"重试 10 次的 CLI"与"自身可能重试的上游"之间，旧逻辑对任意错误一律重试，最坏 3×10=30 次 | v2.4.0 分级重试：确定性错误（ENOTFOUND 等）快速失败、默认重试 2→1、客户端断开取消重试、Retry-After clamp 0–60s（L1/L2/L5/L6/L7） |
| 14 | **ctx 遮蔽致断开取消失效** | `req.on('end')` 回调内 `const ctx = {}` 遮蔽了顶层含 `clientGone` 的 ctx，断开信号永远传不进重试循环 | v2.4.0 删除遮蔽声明，clientGone 正常传播（L7） |
| 15 | **M2：`ds` 子串误伤** | 归一化后 `includes('ds')` 使 `models`/`adsl` 等误命中 DS 判定 | v2.4.0 收紧为独立词元（分隔符/边界界定）（L4a–L4e） |
| 16 | **M1：钩子意图不一致** | SessionEnd 调 `disableInterception` 清掉 enabled，下个会话 SessionStart 又无条件 `on` 重开——用户显式 `off` 被静默撤销 | v2.4.0 SessionEnd 改 `recoverOrphans`（还原但保留意图）、SessionStart 仅在 enabled 时接管（L10/L11） |
| 17 | **端口子串误匹配（M5 同类残留）** | `isSelfProxyUrl`/`isProxiedUrl` 用 `includes(':20329')`，会误命中端口 `:203290`（真实上游恰在该端口时被误判为代理→拒绝→502，fail-safe 但错误） | v2.4.1 改 `:${port}(?![0-9])` 精确边界（M1a-c/M2a-c）；同时补 M4 畸形路径守卫的端到端测试（此前守卫存在但无覆盖） |

---

## 7. 测试体系

`test_full.js` 共 **135 项断言**，全程隔离（端口 21329/21330/21331/21332、`os.tmpdir()` 临时 providers/state、config 备份恢复），当前全部通过。分阶段覆盖：

| Phase | 覆盖 |
| :--- | :--- |
| A | 判定轮裁剪/DSH 人格/双协议注入/cache_control/空工具/`/ctl` 端点（A1-A34） |
| B | 空闲自毁生命周期（自毁前还原 provider、enabled=false） |
| C | 上游解析优先级（config.targetBaseUrl > keyMap > env 兜底） |
| D | provider 映射根治（全新 provider 正确入账本、无硬编码白名单、孤儿不瞎猜还原） |
| E | M1/M3 轮次边界、thinkingBudget 仅 anthropic 注入 |
| F | URL 前缀/路径格式判定、原子写、端口变更先还原再接管、env 遮蔽、硬编码根治 |
| G | 重复 on 幂等（originalUrl 不被污染）、账本迁移扫描 cache 版本目录 |
| H | 首字节门三段语义（流式慢首字不误杀 / 非流式 stall 快速 502） |
| I | UserPromptSubmit 失败还原后自动重接管（当轮恢复裁剪）、daemon 死复活、端口被占还原直连 |
| J | **单服务商接管 + 直连副本十项**：只接管 activeId、非 active 不动、副本字段语义、账本剪枝、幂等不重复建副本、off 还原+清副本、账本丢失副本救援、非 DS active 不接管 |
| K | **接管时可选 provider 八项**：listProviders 标注/排序、指定非默认 DS 接管、activeId 同步、其余直连、副本携带真实上游、按名称指定、非 DS/未知拒绝、拒绝零污染 |
| L | **v2.4.0 修复回归二十八项**：退避指数/Retry-After clamp、重试分级（ENOTFOUND 不重试 / ECONNREFUSED 重试）、标准错误体（anthropic/openai）、M2 独立 ds 词元、5xx 重试计数、客户端断开取消重试、`/ctl on` providerId 端到端、H1 拒绝不破坏既有接管、session-end 保留意图、session-start 尊重 off |
| M | **v2.4.1 端口边界与路径守卫八项**：isSelfProxyUrl/isProxiedUrl 精确端口匹配（`:20329` 不误伤 `:203290`）、畸形路径 `//` 绝对形式 400 拒绝、正常单斜杠路径仍透传 |

另有 `test_consume.js`（消费方视角请求形态）、`test_simulation.js`（早期模拟套件）与 `test_stress.js`（并发/极端场景压力审查，25 项断言，端口 21340/21341/21342 隔离）：接管态 20 并发转发无串扰无丢包、10 轮 on/off 抖动收敛、8 进程并发 ctl 竞态、在途慢请求 vs 并发 off、接管后用户手改 providers.json（删本体/改 activeId）再 off、daemon 中途被杀→死状态检出→boot 恢复、并发接管切换无副本堆积、30 请求混合交织。

---

## 8. 配置参考（`config.json`）

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `port` | `20329` | 代理监听端口（仅 127.0.0.1）。`WE_NEED_DS_TEST_PORT` 可临时覆盖 |
| `targetBaseUrl` | `"auto"` | `"auto"`=按 apiKey 动态回源；具体 URL=强制统一上游 |
| `targetModels` | DS V4 全家桶 | 触发拦截的模型列表，归一化引擎匹配变体；列表外一律透传 |
| `bootstrapCoreTools` | `["Bash","Edit"]` | 判定轮保留的极简工具集（对齐 DSH bash + str_replace_editor）；历史已调用工具自动额外保留 |
| `logDetails` | `false` | 记录每个透传请求的 URL 与上游 |
| `idleAutoShutdownMinutes` | `0` | `0`=常驻；正数 N=空闲 N 分钟后还原并退出 |
| `executionDshPersona` | `true` | 执行轮是否同步 DSH 人格（`false`=执行轮完全透传，v5 行为） |
| `thinkingBudget` | `0` | `0`=不注入；正数=判定轮 anthropic 路径注入 extended thinking 预算 |
| `stripSystemPersona` | *(缺省=生效)* | 人格替换总开关，`false` 完全关闭 |
| `upstreamRetries` | `1` | 重试次数（不含首次），仅可重试失败、仅首字节前重试；确定性网络错误快速失败 |
| `upstreamRetryBackoffMs` | `500` | 退避基数，2 的幂递增封顶 60s，Retry-After clamp 0–60s 取较大值 |
| `upstreamHeaderTimeoutMs` | `30000` | 响应头超时 |
| `upstreamBodyTimeoutMs` | `30000` | 非流式 body 超时（流式豁免） |
| `upstreamIdleTimeoutMs` | `600000` | socket 空闲超时（活动计时） |

---

## 9. 已知边界与残留风险

1. **账本信任链**：接管瞬间的 `baseUrl` 被记为真实上游。若用户把某 provider 手动配成*另一个代理地址*，插件会把该代理地址当真实上游记录并还原——设计边界，非 bug。开启前用 `doctor` 核对。
2. **activeId 锚定假设**：用户在 cc-haha 切换 provider 但未改默认时，被接管的是默认服务商而非当前实际使用者。文档已要求"开启前把当前真正要用的 DS 服务商设为默认"。
3. **600s 客户端超时不可控**：sidecar 硬编码流总时长上限，插件无法解除；裁剪仅提高收敛概率，不保证思维链时长。
4. **生产 providers.json 尚处旧全量接管态**（25 个孤儿 + 27 条账本，截至本报告撰写时）：新代码在下次 `on`/`boot` 时自动迁移收敛，未主动触碰以免打断进行中的会话。
5. **副本名称显示**：`· 直连副本` 后缀在 cc-haha 下拉框的渲染宽度未实测，存在截断可能。
6. **cc-haha 不支持 commands 斜杠指令**：仅 skills 路径可用；裸 `/we-need-ds` 依赖 shim 转发。
7. **钩子仅 CC 轨生效**：cc-haha 下 SessionStart/UserPromptSubmit/SessionEnd 均不执行，会话结束不会自动还原，依赖用户 `off` 习惯或重启后 `boot` 自愈。
8. **两段式释放的极端窗口**：第一阶段还原落盘后、第二阶段验证前进程被杀 → 副本残留（无害，下次 on/boot 清理）；本体还原失败 → 副本保留作逃生口（设计意图）。

---

## 10. 版本演进摘要

| semver | 机制 | 要点 |
| :--- | :--- | :--- |
| ≤2.0.x | v4 及以前 | 全量接管 providers.json；首轮 arm 窗口裁剪 |
| 2.1.x | **v5 → v5.1** | 轮次结构感知常态模拟（不限首轮）；执行轮全量+DSH 人格（v5.1）；失败即还原（2.1.12）；还原可逆+中途断开透明化（2.1.13）；开机自启动实现后又被彻底移除（2.1.10→2.1.11） |
| **2.2.0** | v5.1 | **单服务商接管 + 直连副本逃生口**：根治重启死锁；两段式安全释放；账本剪枝与旧态自动迁移；hooks/ctl 输出与中英 README 同步 |
| 2.2.1 | v5.1 | 统一 daemon 端口释放：`killDaemonOnPort` 杀进程后轮询确认端口真正释放，根治残留进程占端口导致的假接管 |
| 2.3.0 | v5.1 | **接管时可选任意 provider**：`ctl list` 清单（🎯含DS/⭐默认/🔌代理中）+ `on --provider <id|名称>`；接管非默认 provider 自动同步 activeId（sidecar 按 activeId 路由）；拒绝路径零污染；中英 README 顶部显式告知"接管改写 providers.json 且关机后持久保留"根因与副本兜底 |
| 2.4.0 | v5.1 | **深度审计 + 三方重试对照修复**：H1 无效 `--provider` 不再破坏既有接管（校验前置）；重试分级根治重试风暴（确定性错误快速失败、默认重试 2→1、客户端断开取消重试、Retry-After clamp 0–60s）；标准错误体（anthropic/openai 按路径）；M2 `ds` 子串误伤收紧为独立词元；M1 钩子意图一致（session-end 保留 enabled、session-start 尊重 off）；M3 keyMap 剪枝；M4 畸形路径 400；M5 端口精确匹配；L2 `env/default` 哨兵恢复；L3 `--provider` 缺值校验；测试 99→127 |
| 2.4.1 | v5.1 | **端口边界精确化 + 守卫补测**：`isSelfProxyUrl`/`isProxiedUrl` 由子串匹配改 `:${port}(?![0-9])` 精确边界（根治 `:20329` 误伤 `:203290`，与 M5 同类）；补 M4 畸形路径守卫的端到端测试（守卫此前存在但无覆盖）；测试 127→135（新增 Phase M 八项） |
| **2.4.2** | v5.1 | **并发/极端场景压力审查**：新增 `test_stress.js`（25 断言，端口 21340/21341/21342 隔离）覆盖主套件达不到的进程级并发与恶意状态变更——接管态 20 并发无串扰、10 轮 on/off 抖动收敛、8 进程并发 ctl 竞态、在途慢请求 vs 并发 off、接管中手改 providers.json（删本体/改 activeId）再 off、daemon 被杀→死状态检出→boot 恢复、并发切换无副本堆积、30 请求混合交织；生产 fresh off→on 端到端复验（真实上游、DSH 裁剪、We need 链、工具集收敛）。产品代码零改动 |

> 两条编号线独立：文档中的 v5/v5.1 是**机制版本**（轮次感知 DSH 极简模拟算法的演进代号）；插件遵循 semver（`plugin.json`/CHANGELOG）。GitHub Releases 以 semver 为准。

---

## 附录：文件清单

```
we-need-ds/
├── .claude-plugin/plugin.json      # 插件元数据 (name/version=2.4.2/keywords)
├── config.json                     # 运行时配置
├── proxy.js                        # 代理网关 (分级重试/断开取消/标准错误体/DSH 塑形)
├── lib/state.js                    # 状态机 (接管/两段式释放/副本/锁/原子写/迁移)
├── lib/ctl.js                      # 命令行 (on/off/status/doctor/boot/restart/list)
├── hooks/hooks.json                # 钩子注册
├── hooks/session-start.js          # 会话启动: 修孤儿+拉 daemon+按意图接管
├── hooks/user-prompt-submit.js     # 每条消息: 自愈复活/幂等重接管/失败还原
├── hooks/session-end.js            # 会话结束: 还原孤儿+保留意图
├── skills/{we-need-ds,on,off,status,doctor,test,restart}/SKILL.md
├── commands/{plan,run}.md          # 斜杠指令 (CC 轨)
├── agents/we-need-planner.md       # 只读深度规划子代理
├── test_full.js                    # 135 断言主套件 (Phase A-M)
├── test_consume.js                 # 消费方视角测试
├── test_simulation.js              # 早期模拟测试
├── test_stress.js                  # 并发/极端场景压力审查 (25 断言)
├── README.md / README_EN.md        # 中英使用文档 (已对齐 v2.4.2)
├── CHANGELOG.md                    # 版本日志
├── LICENSE                         # MIT
└── docs/alipay_qr.jpeg             # README 赞助二维码
```

**仓库**：`https://github.com/YixuAnsensei/we-need-ds`（main 分支，v2.4.2）。
