---
name: on
description: 手动开启 we-need-ds 拦截环境（可选择要接管的 provider）
---

按以下步骤开启拦截：

1. 用 Bash 列出所有 provider：

node "${CLAUDE_PLUGIN_ROOT}/lib/ctl.js" list

2. 从输出中筛出标注了 `🎯含DS模型` 的 provider。若只有一个，直接接管它；若有多个，用 AskUserQuestion 让用户选择要接管哪一个（把当前默认 `⭐` 的那个作为推荐项）。

3. 用 Bash 执行接管（`<id>` 换成用户选定的 provider id 或名称）：

node "${CLAUDE_PLUGIN_ROOT}/lib/ctl.js" on --provider <id>

说明：接管非默认 provider 时插件会自动把 cc-haha 的 activeId 切到它（sidecar 按 activeId 路由，必须同步）。若用户就想接管当前默认且它已含 DS 模型，也可省略 `--provider` 直接 `on`。
