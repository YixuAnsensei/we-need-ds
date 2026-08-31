---
description: 调用 we-need-planner 深度规划器对复杂任务进行只读调研与结构化规划
argument-name: task
allowed-tools: Agent(we-need-ds:we-need-planner)
---

请立即调用 we-need-planner 子代理（Agent 工具，subagent_type 为 "we-need-ds:we-need-planner"），将用户的任务完整传给它。

用户任务：
$ARGUMENTS

等子代理产出结构化计划后，将其完整展示给用户，并询问是否按该计划开始执行。
