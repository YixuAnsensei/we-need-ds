---
description: 运行 we-need-ds 自动化两阶段裁切逻辑测试套件
allowed-tools: Bash(node *)
---

用 Bash 执行自测套件：

node "${CLAUDE_PLUGIN_ROOT}/test_simulation.js"

把 9 组测试的 PASS / FAIL 结果输出给用户，直观证明代理工具裁剪与模型放行逻辑正常工作。
