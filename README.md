# we-need-ds 🎯

> **首个专为 Claude Code 与 [cc-haha](https://github.com/NanmiCoder/cc-haha) 打造的 DeepSeek Pro 满血 "We need" 深度思维链原生增强插件**

<p align="center">
  <img src="https://img.shields.io/badge/Claude%20Code-Plugin%20V2-6366f1?style=flat-square" alt="Claude Code Plugin">
  <img src="https://img.shields.io/badge/Companion-cc--haha-f43f5e?style=flat-square" alt="cc-haha">
  <img src="https://img.shields.io/badge/Target-DeepSeek--V4--Pro-0ea5e9?style=flat-square" alt="DeepSeek V4 Pro">
  <img src="https://img.shields.io/badge/Zero--Config-Auto--Bootstrap-10b981?style=flat-square" alt="Zero Config">
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

## 💡 我们的解决方案：双阶段动态解耦（Two-Phase Bootstrap）

**`we-need-ds`** 是专为 Claude Code 与 [cc-haha](https://github.com/NanmiCoder/cc-haha) 原生设计的全自动增强插件，**无需关闭任何 MCP，零感知唤醒满血 DeepSeek**：

```mermaid
sequenceDiagram
    autonumber
    participant User as 开发者
    participant CC as Claude Code / cc-haha 宿主
    participant Proxy as we-need-ds 代理 (:20129)
    participant Router as 9router / API 服务商 (:20128)

    User->>CC: 输入任务: /we-need-ds:run 重构登录与鉴权系统
    Note over CC,Proxy: 会话开启：插件自适应启动，临时切入透明代理
    CC->>Proxy: 第 1 轮请求 (包含全部 30+ 个 MCP 工具 Schema)
    
    rect rgb(235, 248, 255)
    Note over Proxy: 协议层动态解耦：<br/>命中 DS Pro 首轮 → 裁切为 [Bash, Edit, Read, Write] 4 基础工具
    end
    
    Proxy->>Router: 转发裁切后的纯净请求
    Router-->>CC: DeepSeek 触发 RL 甜点区，吐出 "We need..." 深度规划链 (SSE 零延迟直通)
    
    Note over CC,Proxy: 第 2 轮起：模型开始执行具体步骤或调用工具
    CC->>Proxy: 第 2 轮请求 (工具结果回传)
    
    rect rgb(240, 253, 244)
    Note over Proxy: 100% 全量放行：解除限制，全量 MCP/Skill 恢复可用
    end
    
    Proxy->>Router: 原样透传
    Router-->>CC: 正常调用 ComfyUI/数据库/各种 MCP 完成执行！
```

---

## 📂 Claude Code 配置文件组织体系

为了让大家清晰了解插件在本地是如何运作的，以下是 Claude Code 与 [cc-haha](https://github.com/NanmiCoder/cc-haha) 的配置目录分布：

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
                ├── lib/state.js    # 自适应环境状态机
                └── runtime-state.json # 运行时临时状态 (记录原始 URL，防回环)
```

---

## 🚀 两种环境下的使用指南

### 🅰️ 在 [cc-haha](https://github.com/NanmiCoder/cc-haha) 中使用（极致懒人模式）

[cc-haha](https://github.com/NanmiCoder/cc-haha) 是目前社区最流行的 Claude Code 增强客户端，支持多 Provider 管理与模型一键切换。

1. **零配置开箱即用**：
   * 你的 9Router / 中转 Provider 的 `baseUrl` **保持原样（如 `http://localhost:20128`）不变，无需手动修改任何设置**！
2. **自动生命周期管理**：
   * 插件在检测到 `~/.claude/cc-haha/providers.json` 后，会在每次开启拦截时**自动且安全地将当前激活 Provider 临时切换至 `127.0.0.1:20129`**，并在 `runtime-state.json` 中记下原始地址。
   * 会话结束、退出客户端或守护进程空闲 30 分钟退出时，**会自动将 `baseUrl` 还原为原地址**，绝不残留脏数据。
3. **日常使用**：
   * 在聊天框直接输入：
     ```
     /we-need-ds:run 帮我重构用户鉴权模块并编写测试用例
     ```

---

### 🅱️ 在纯正官方 Claude Code 中使用

对于直接使用官方 CLI 的极客开发者：

1. **设置上游与代理**：
   * 在环境变量中指定上游中转地址（如 9router 或商业 API）：
     ```bash
     export ANTHROPIC_UPSTREAM_BASE_URL="http://127.0.0.1:20128"
     ```
   * 将 Claude Code 端点指向 `we-need-ds` 代理：
     ```bash
     export ANTHROPIC_BASE_URL="http://127.0.0.1:20129"
     ```
2. **运行与体验**：
   * 正常启动 `claude` 即可，首轮所有 `deepseek-v4-pro*` 请求自动触发 "We need" 思维链，其他模型（Claude / GPT / Gemini 等）全量透传直通。

---

## 🎮 命令矩阵全景

| 斜杠命令 | 功能说明 | 典型使用场景 |
| :--- | :--- | :--- |
| **`/we-need-ds:run <任务>`** | **一键启动满血思维链并执行** | 日常最常用入口，直接附带任务，自动拉起拦截并完成任务 |
| **`/we-need-ds:plan <任务>`** | **调用只读规划专家子代理** | 超大项目、重构任务，想先看 Markdown 规划而不动代码 |
| **`/we-need-ds:doctor`** | **一键深度体检** | 排查端口占用、9router 连通性、环境模式、激活 Provider 状态 |
| **`/we-need-ds:test`** | **运行两阶段解耦自测试套件** | 9 组模型归一化与工具裁切/放行断言，直观查看拦截效果 |
| **`/we-need-ds:status`** | **查看当前运行与拦截状态** | 查看当前代理是否在跑、拦截开关、原始 URL 与日志文件 |
| **`/we-need-ds:on`** | **手动强制开启拦截** | 手动将当前 Provider baseUrl 切换到代理端口 |
| **`/we-need-ds:off`** | **手动关闭拦截并还原** | 随时手动恢复原始 baseUrl 端点 |

---

## ⚙️ 配置文件说明 (`config.json`)

```json
{
  "port": 20129,
  "targetBaseUrl": "auto",
  "targetModels": [
    "deepseek-v4-pro-0813",
    "deepseek-v4-pro"
  ],
  "bootstrapCoreTools": [
    "Bash",
    "Edit",
    "Read",
    "Write"
  ],
  "logDetails": false,
  "idleAutoShutdownMinutes": 30
}
```

* `targetBaseUrl`：默认为 `"auto"`，自动读取当前激活 Provider 的原始上游 URL（跳过 20129 自身防回环）；也可手动配置为任意中转商/9router 地址。
* `targetModels`：需要触发拦截的模型列表（内置正则归一化引擎，无论下划线、空格、连字符还是路径前缀均能精准匹配）。
* `bootstrapCoreTools`：首轮保留的核心诱导工具集（默认 `Bash, Edit, Read, Write`）。
* `idleAutoShutdownMinutes`：无请求空闲退出时间（默认 30 分钟，退出前会自动还原配置）。

---

## 🔒 安全与隐私

* **纯本地监听**：代理仅绑定 `127.0.0.1:20129`，绝不对外暴露端口。
* **零延迟直通**：SSE 流式响应采用 Node.js 原生 Stream `pipe()` 直通转发，无任何二次封装延迟。
* **安全可回退**：修改均带状态记录（`runtime-state.json`），任何时候敲 `/we-need-ds:off` 或关掉终端都会自动还原。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。欢迎提交 PR 与 Issue！

**作者**: [YixuAn](https://github.com/YixuAnsensei)
**鸣谢**: [cc-haha 客户端项目](https://github.com/NanmiCoder/cc-haha) & DeepSeek Harness (DSH) 社区
