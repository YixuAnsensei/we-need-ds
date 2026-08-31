---
description: 开启 we-need-ds 拦截（启动守护进程并把 baseUrl 临时切至 :20129）
allowed-tools: Bash(node *)
---

用 Bash 执行控制脚本：

node "${CLAUDE_PLUGIN_ROOT}/commands/ctl.js" on

把命令输出原样展示给用户。若输出包含"拦截已开启"，说明守护进程已运行且 providers.json 的激活 Provider baseUrl 已临时切至 http://127.0.0.1:20129，会话结束后自动还原。
