# we-need-ds 🎯

> **首个专为 Claude Code 与 [cc-haha](https://github.com/NanmiCoder/cc-haha) 打造的 DeepSeek Pro 满血 "We need" 深度思维链原生增强插件**

<p align="center">
  <img src="https://img.shields.io/badge/Claude%20Code-Plugin%20V2-6366f1?style=flat-square" alt="Claude Code Plugin">
  <img src="https://img.shields.io/badge/Companion-cc--haha-f43f5e?style=flat-square" alt="cc-haha">
  <img src="https://img.shields.io/badge/Target-DeepSeek--V4--Pro-0ea5e9?style=flat-square" alt="DeepSeek V4 Pro">
  <img src="https://img.shields.io/badge/Multi--Provider-Dynamic%20Routing-10b981?style=flat-square" alt="Multi-Provider">
  <img src="https://img.shields.io/badge/License-MIT-amber?style=flat-square" alt="License MIT">
</p>

[English Documentation](README_EN.md) | 简体中文

---

## 🧐 背景：为什么你的 DeepSeek 总是“不聪明”？

近期开源社区（参考 DeepSeek Harness 社区的深入研究）发现了一个极其关键的模型机制：**DeepSeek-V4-Pro 系列模型在不同工具上下文下的推理能力存在显著的“双面性”**：

| 模式 | 表现特征 | 核心原因 |
| :--- | :--- | :--- |
| 🟢 **"We need..." 满血深度规划** | 面对复杂工程任务，首先自发进行宏观全局拆解、边界推演、架构设计，展现极高水准的 AGI 战略规划能力。 | 模型首轮仅看到基础必要工具，触发 RL（强化学习）训练中的**深度推理甜点区**。 |
| 🔴 **"Let me..." 浅层工具试探** | 陷入微观琐碎的工具调用纠结，输出频繁试错、不断摸索，思维链退化为机械式的工具调用循环（Tool-Churning）。 | 客户端首轮注入数十个 MCP 工具、技能扩展、复杂 Schema，模型的注意力机制被过度牵引。 |

### 行业现状与生态空白
* **DSH 社区验证了原理，但 Claude Code 生态依然缺席**：现有的解决方案大多停留在 Python 独立运行脚本或专有终端框架中。
* **Claude Code 生态的巨大矛盾**：现代开发者在 Claude Code 中普遍挂载了大量 MCP 工具（数据库、浏览器、绘图、终端等）。如果为了诱导 "We need" 而手动把 MCP 全关掉，开发体验直接报废；如果不关，DeepSeek 就会永远陷在 "Let me" 的泥潭里。
* **提示词（Prompt 催眠）治标不治本**：无论在 System Prompt 里如何强调“请使用 We need 思考”，只要底层的 JSON 请求体里依然带有一长串复杂的 Tool Schemas，模型就会被注意力机制强制牵引回工具试探中。

---

## 💡 我们的解决方案：轮次结构感知动态解耦（Turn-Aware DSH Minimal Simulation, v5）

**`we-need-ds`** 是专为 Claude Code 与 [cc-haha](https://github.com/NanmiCoder/cc-haha) 原生设计的全自动增强插件，**无需关闭任何 MCP，零感知唤醒满血 DeepSeek**：

```mermaid
sequenceDiagram
    autonumber
    participant User as 开发者
    participant CC as Claude Code / cc-haha 宿主
    participant Proxy as we-need-ds 代理 (:20329)
    participant Router as 9router / 中转商 / 官方端点

    User->>CC: 输入任务: /we-need-ds 重构登录与鉴权系统
    Note over CC,Proxy: 会话开启/执行指令：透明代理就绪，多 Provider 池自动接管
    CC->>Proxy: 判定轮请求 (新任务文本, 包含全部 30+ 个 MCP 工具 Schema)
    
    rect rgb(235, 248, 255)
    Note over Proxy: v5 DSH 极简模拟（常态化，不限首轮）：<br/>命中 DS Pro 目标模型 + 判定轮 → 系统提示词替换为 DSH 官方单行<br/>工具裁切为 [Bash, Edit] 两件套 (对齐 DSH 极简模式)<br/>根据 API Key 自动反向路由到真实的对应上游
    end
    
    Proxy->>Router: 转发极简后的纯净请求
    Router-->>CC: DeepSeek 触发 RL 甜点区，吐出 "We need..." 深度规划链 (SSE 零延迟直通)
    
    Note over CC,Proxy: 模型开始执行具体步骤或调用工具
    CC->>Proxy: 执行轮请求 (tool / tool_result 回传)
    
    rect rgb(240, 253, 244)
    Note over Proxy: v5.1 全量放行：全量 MCP/Skill 恢复可用<br/>人格同步切换为 DSH 单行 (executionDshPersona)
    end
    
    Proxy->>Router: 原样透传
    Router-->>CC: 正常调用 ComfyUI/数据库/各种 MCP 完成执行！
```

---

## ✨ 核心特性矩阵

1. **⚡ 全量 Provider 映射池与动态路由（Multi-Provider Pool & Dynamic Auth Routing）**：
   * 自动接管 `providers.json` 中的所有服务商（9Router、BAI、YJS、商汤、OpenCode 等）；
   * 收到请求时根据 API Key / Token 动态回源到各自真实的官方/中转上游地址，多窗口、多标签页切换模型零干扰。
2. **🎯 轮次结构感知极简模拟（Turn-Aware DSH Minimal, v5.1 全轮次人格统一）**：
   * 纯请求结构判定：末条为新 user 文本 = **判定轮**（等待模型规划），末条为 tool/tool_result = **执行轮**（工具续跑）；
   * **每个判定轮**（不限会话首轮）自动模拟 DeepSeek Harness 官方极简模式：系统提示词替换为 DSH 官方单行 `You are a helpful software engineer assistant.`，工具裁切为 `Bash + Edit` 两件套（映射 DSH 的 bash + str_replace_editor）；
   * **每个执行轮（v5.1）**保留全量工具放行，同时人格也切换为 DSH 单行——客户端只校验 JSON 协议结构（tool_use/tool_result），人格文本不做硬校验，替换协议安全；执行链结束后下一次新任务重新进入极简，全程零配置。`executionDshPersona: false` 可退回 v5 行为（执行轮完全透传）。
3. **🛡️ 三重防呆生命周期与无死锁保障**：
   * **自动启动挂载 + 消息级自愈**：SessionStart 钩子开箱自启动；UserPromptSubmit 钩子每条新消息自检复活；
   * **会话结束自动还原**：SessionEnd 钩子触发批量恢复；
   * **常驻守护 + 消息级自愈**：daemon 默认常驻不退出；UserPromptSubmit 钩子在你每条新消息时自检，daemon 若失效自动拉起并重新接管；SessionEnd/会话结束自动安全还原；
   * **非目标模型 100% 零侵入**：Claude / GPT / Gemini / Qwen 纯字节流直通。

---

## 📂 Claude Code 配置文件组织体系

```
~/.claude/                          # Claude Code 用户全局配置根目录
├── settings.json                   # 官方设置文件 (管理 enabledPlugins, permissions 等)
├── cc-haha/                        # cc-haha 定制目录 (https://github.com/NanmiCoder/cc-haha)
│   └── providers.json              # Provider 路由表 (baseUrl, activeId, 模型映射等)
└── plugins/                        # 插件系统根目录 (Plugin V2 规范)
    ├── installed_plugins.json      # 已安装插件注册表与 cache 映射
    ├── known_marketplaces.json     # 插件市场源列表
    └── cache/                      # 插件运行时隔离沙盒
        └── claude-plugins-official/
            └── we-need-ds/1.0.0/   # we-need-ds 运行时代码与状态文件
                ├── config.json     # 插件核心配置
                ├── proxy.js        # 拦截代理核心
                ├── lib/state.js    # 状态机与映射池
                ├── skills/         # 官方标准技能入口
                └── runtime-state.json # 运行时临时状态 (记录原始 URL 映射表)
```

---

## 🚀 使用指南

### 🅰️ 在 [cc-haha](https://github.com/NanmiCoder/cc-haha) 中使用（极致懒人模式）

1. **零配置开箱即用**：
   * 你的所有 Provider（9Router、YJS、商汤等）的 `baseUrl` 保持原本设置即可，无需任何手动改动！
2. **多窗口自由切换**：
   * 插件自动进行全量多 Provider 接管，你在任何窗口任意切换服务商，均可直接触发。
3. **日常使用**：
   * 在聊天框直接输入：
     ```bash
     /we-need-ds 帮我重构用户鉴权模块并编写测试用例
     ```
   * 想要先行进行深度推演不写代码时：
     ```bash
     /we-need-ds:plan 规划大型系统重构方案
     ```

---

### 🅱️ 在纯正官方 Claude Code 中使用

1. **设置上游与代理**：
   * 在环境变量中指定上游中转地址（如 9router 或商业 API）：
     ```bash
     export ANTHROPIC_UPSTREAM_BASE_URL="http://127.0.0.1:20128"
     ```
   * 将 Claude Code 端点指向 `we-need-ds` 代理：
     ```bash
     export ANTHROPIC_BASE_URL="http://127.0.0.1:20329"
     ```
2. **运行与体验**：
   * 正常启动 `claude` 即可，所有 `deepseek-v4-pro*` 判定轮请求自动进入 DSH 极简环境触发 "We need" 思维链，工具执行轮全量放行，其他模型（Claude / GPT / Gemini 等）全量透传直通。

---

## 🎮 命令矩阵全景

| 技能命令 | 功能说明 | 典型使用场景 |
| :--- | :--- | :--- |
| **`/we-need-ds <任务>`** | **一键启动满血思维链并执行** | 默认主入口，附带任务，自动开启拦截并执行 |
| **`/we-need-ds:plan <任务>`** | **调用只读规划专家子代理** | 超大项目、重构任务，想先看 Markdown 蓝图而不动代码 |
| **`/we-need-ds:doctor`** | **一键深度体检** | 排查代理端口、环境模式、25 个 Provider 池接管与连通状态 |
| **`/we-need-ds:test`** | **运行轮次结构感知自测试套件** | 12 组包含判定轮极简、执行轮放行、非目标模型透传的完整断言 |
| **`/we-need-ds:status`** | **查看当前运行与拦截状态** | 查看当前代理进程、拦截开关、被接管的提供商清单与日志 |
| **`/we-need-ds:on`** | **手动开启拦截环境** | 显式开启全量接管，判定轮常态进入极简模拟 |
| **`/we-need-ds:off`** | **手动关闭拦截并还原端点** | 随时手动将所有 Provider 恢复到各自原有的真实地址 |

---

## ⚙️ 配置文件说明 (`config.json`)

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
  "thinkingBudget": 0
}
```

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `port` | `20329` | 本地透明代理监听端口（仅绑定 127.0.0.1）。若被其他程序占用请改此值；测试环境变量 `WE_NEED_DS_TEST_PORT` 可临时覆盖，不影响生产配置。 |
| `targetBaseUrl` | `"auto"` | 上游解析策略。`"auto"` = 按请求携带的 API Key 在账本中动态路由回各 Provider 真实上游；设为具体 URL 则强制所有请求回源到该地址。 |
| `targetModels` | DS V4 全家桶 | 需要触发拦截处理的模型列表（内置归一化引擎，下划线/空格/连字符/路径前缀/大小写变体均能精准匹配）。**列表之外的模型（Claude / GPT / Gemini / Qwen 等）一律字节级原样透传，绝不修改。** |
| `bootstrapCoreTools` | `["Bash","Edit"]` | 判定轮保留的极简工具集（对齐 DSH 极简模式的 bash + str_replace_editor 两件套）。此外，会话历史中已被调用过的工具也会自动保留，防止协议校验失败。 |
| `logDetails` | `false` | 设为 `true` 时在日志中记录每个透传请求的 URL 与上游（调试路由问题用）。 |
| `idleAutoShutdownMinutes` | `0` | 空闲自动释放开关。默认 `0` = 常驻不退出；设为正数 N 则代理空闲超过 N 分钟后自动还原所有 Provider 并退出，下次新消息由 UserPromptSubmit 钩子自动拉起并重新接管。 |
| `executionDshPersona` | `true` | 执行轮（工具续跑）是否也同步切换为 DSH 极简人格。默认 `true`（全程 DSH 人格，仅工具集不同）；设为 `false` 则执行轮完全原样透传（保留 Claude Code 原始人格）。 |
| `thinkingBudget` | `0` | 判定轮是否附带 Anthropic extended thinking 预算。默认 `0` = 关闭（不注入任何 thinking 字段，依赖模型原生思维链）；设为正数 N 则在判定轮请求中注入 `thinking: {type:"enabled", budget_tokens:N}`，作为触发深度推理链的可选增强手段。 |
| `stripSystemPersona` | *(缺省=生效)* | 人格替换总开关。默认所有命中 DS 目标模型的请求都替换为 DSH 单行人格；显式设为 `false` 可完全关闭人格替换（仅保留工具裁切）。 |

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。欢迎提交 PR 与 Issue！

**作者**: [YixuAn](https://github.com/YixuAnsensei)
**鸣谢**: [cc-haha 客户端项目](https://github.com/NanmiCoder/cc-haha) & DeepSeek Harness (DSH) 社区
