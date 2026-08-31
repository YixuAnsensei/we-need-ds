---
description: 关闭 we-need-ds 拦截并还原 baseUrl
allowed-tools: Bash(node *)
---

用 Bash 执行控制脚本：

node "${CLAUDE_PLUGIN_ROOT}/commands/ctl.js" off

把命令输出原样展示给用户。若输出包含"拦截已关闭"，说明 baseUrl 已还原为 providers.json 中的原始地址。
