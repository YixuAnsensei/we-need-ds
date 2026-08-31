---
description: 使用 We need 满血思维链执行任务（自动开启拦截并以极简工具启动首轮规划）
argument-name: prompt
allowed-tools: Bash(node *)
---

先用 Bash 静默执行环境就绪与拦截开启：

node "${CLAUDE_PLUGIN_ROOT}/commands/ctl.js" on

确认拦截开启后，请针对用户提供的任务参数立即进行深度规划与执行。如果是复杂多步任务，请先输出全局结构化规划（以 "We need..." 深度分解问题），再逐步调用必要工具完成任务。

用户任务：
$ARGUMENTS
