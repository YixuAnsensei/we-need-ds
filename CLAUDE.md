# CLAUDE.md — we-need-ds 开发规范

Claude Code / cc-haha 双宿主插件：在 DeepSeek-V4-Pro 系模型上动态模拟 DeepSeek Harness (DSH) 极简模式，稳定触发 "We need..." 深度思维链。完整工程史见 `docs/ENGINEERING_REPORT.md`（权威，先读）。

## 项目目的

不关闭任何 MCP，通过本地代理在"判定轮"把请求体裁剪成 DSH 官方极简形态（单行人格 + Bash/Edit 两件套），"执行轮"全量放行，从而在 Claude Code / cc-haha 中逼近 DSH 极简模式的效果。非目标模型（Claude/GPT/Gemini/Qwen 等）字节级原样透传。

## 架构速览

```
双轨分治:
  cc-haha GUI 轨  → 单服务商接管 providers.json activeId 本体 → :20329
  Claude Code CLI 轨 → hooks (SessionStart/UserPromptSubmit/SessionEnd) 驱动 → :20329
  proxy.js   代理网关: 轮次判定 + DSH 塑形 + keyMap 路由 + 三道超时门 + 重试
  lib/state.js  状态机: 接管/两段式释放/副本体系/文件锁/原子写/账本迁移
  lib/ctl.js    on/off/status/doctor/boot/restart
  hooks/*.js    仅官方 CC 生效 (cc-haha sidecar 不执行插件 hooks)
  skills/       cc-haha 下唯一可用的指令入口 (commands 斜杠指令在 cc-haha 不可用)
```

- 代理端口 `20329`，仅绑 `127.0.0.1`
- 账本 `~/.claude/we-need-ds/runtime-state.json`（跨插件版本持久化；插件目录内禁止写状态——`${CLAUDE_PLUGIN_ROOT}` 随更新变路径）
- 接管 = 本体 baseUrl→代理 + 建 `wnd-copy-<id>` 直连副本（逃生口兼冗余账本）；释放 = 两段式（还原验证通过才删副本）
- 任何失败路径 → 立即还原直连防死锁；还原可逆，账本 enabled 时下条消息钩子自动重接管

## 常用命令

```bash
node test_full.js          # 主测试套件，隔离运行 (tmp 目录 + 端口 21329)，须全绿
node test_consume.js       # 消费方视角请求形态测试
node test_stress.js        # 并发/极端场景压力审查 (隔离端口 21340/21341/21342)
node lib/ctl.js on|off|status|doctor|boot|restart
```

测试禁止触碰生产 daemon (:20329)、生产 `~/.claude/cc-haha/providers.json` 与生产账本。隔离三环境变量：`WE_NEED_DS_TEST_PORT` / `WE_NEED_DS_PROVIDERS_PATH` / `WE_NEED_DS_DATA_DIR`（test_full.js 与 test_consume.js 已内置）。

## 宿主适配规范（开发铁律）

**官方 Claude Code**（来源: code.claude.com/docs/en/plugins-reference）：
- 组件目录（skills/commands/agents/hooks 等）必须放插件根目录，严禁放 `.claude-plugin/`（只放 plugin.json）
- plugin.json 唯一必填字段 `name`；`author` 必须是对象 `{name, url}`
- hooks.json 三层嵌套：`hooks` → 事件名 → `{matcher, hooks:[...]}` → handler 数组（我们 hooks/hooks.json 已是此格式，勿改平）
- `${CLAUDE_PLUGIN_ROOT}` = 安装缓存绝对路径，只读；`${CLAUDE_PLUGIN_DATA}` = `~/.claude/plugins/data/<id>/`，可持久写
- skills/commands/agents/*.md 的 frontmatter：`---` 必须是文件第一行

**cc-haha**（来源: NanmiCoder/cc-haha `src/utils/plugins/`）：
- 官方机制同构：安装即复制到 `~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/`，`${CLAUDE_PLUGIN_ROOT}` 指向该缓存路径
- sidecar 常驻 HTTP server，剥 `/proxy/providers/<activeId>/` 前缀转发到 provider.baseUrl，**不执行插件 hooks** → cc-haha 轨的接管只能靠手动 on/boot + daemon 常驻
- 代理收到请求不含"当前激活哪个 provider"信息 → 只能按 API Key 路由（keyMap），接管锚定 activeId
- cc-haha 下 commands 斜杠指令不可用，skills 可用 → 所有用户入口走 skills/
- 9router 的 `/v1/messages` 非流式返回 OpenAI 格式 → 协议判定必须路径优先于 body 特征（formatFromRequestPath）
- 600s 流超时是 sidecar 客户端硬编码行为，插件无法解除；裁剪只提高收敛概率

## 设计边界（用户已明确否决/确立，勿再提）

1. **不做任何系统级注册**（无 Startup 文件夹、无计划任务、无开机自启）——用户明确否决；重启后恢复由用户显式 `on`/`boot`
2. 失败即还原、还原可逆：绝不把 provider 留在"指向死代理"状态；502 显式失败优于静默错发
3. 非 DS 模型零侵入：不碰人格、不碰 tools、不碰 thinking
4. 判定轮保留历史已调用工具（collectUsedToolNames），防模型续写引用未声明工具导致协议校验失败
5. 流式响应豁免 body 超时门（推理模型首 token 可合法慢到几十秒）；首字节后不重试，中途断开对客户端透明 destroy
6. 无可信还原来源的孤儿不瞎猜还原，保持原样并列警告

## 代码风格

- 无构建步骤、无第三方依赖，纯 Node.js 内置模块（http/https/fs/path/os）
- 编辑 `D:\claude-code-haha\` 下任何文件**不加注释**
- 面向 Windows（taskkill/netstat）但逻辑保持跨平台可读
- 文档/README/CHANGELOG 与 semver（plugin.json）同步更新；机制版本号（v5/v5.1）与 semver 是两条独立编号线

## 已知坑（改代码前必看，详见报告第 6/9 节）

- 测试曾污染生产 config.json → 一切测试走隔离环境变量，动生产文件前先备份
- 残留测试进程会引发 EADDRINUSE 假失败 → 假失败先查残留进程，别急着改代码
- 账本散落在版本化 cache 路径导致升级"失忆" → 已由 migrateLegacyFiles 迁移；新数据一律写 `~/.claude/we-need-ds/`
- 端口变更场景：真实上游恰好等于旧代理端口时，靠 proxyPorts 集合（config.port ∪ 账本 proxyUrl）区分，勿用单端口判断
- 上游解析优先级固定：config.targetBaseUrl > keyMap[apiKey] > 账本 defaultUpstream > env ANTHROPIC_UPSTREAM_BASE_URL > 502
