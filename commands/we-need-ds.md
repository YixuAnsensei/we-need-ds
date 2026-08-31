---
description: 默认主入口：以 We need 满血思维链运行任务
argument-hint: 你的具体开发/重构/分析任务
---

请用 Bash 执行控制脚本开启拦截环境：

node "${CLAUDE_PLUGIN_ROOT}/commands/ctl.js" on

开启后，请针对用户的任务展开深度战略规划（以 "We need..." 满血思维链分解问题），再逐步调用必要工具执行完成。

用户任务：
$ARGUMENTS
