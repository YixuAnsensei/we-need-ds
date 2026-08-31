---
description: 诊断 we-need-ds 运行环境、端口占用、上游 9router 连通性与配置
allowed-tools: Bash(node *)
---

用 Bash 执行诊断工具：

node "${CLAUDE_PLUGIN_ROOT}/commands/ctl.js" doctor

把诊断报告格式化展示给用户，指出发现的问题与修复建议。
