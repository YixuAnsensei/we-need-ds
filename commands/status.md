---
description: 查看 we-need-ds 守护进程与拦截状态
allowed-tools: Bash(node *)
---

用 Bash 执行控制脚本：

node "${CLAUDE_PLUGIN_ROOT}/commands/ctl.js" status

把输出以代码块形式展示给用户，并按需解释：守护进程运行状态、拦截开关、原始 URL、目标模型列表、日志位置。
