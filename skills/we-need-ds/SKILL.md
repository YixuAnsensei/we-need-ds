---
name: we-need-ds
description: 默认主入口：以 We need 满血思维链运行任务
---

按以下步骤开启拦截并执行任务：

1. 用 Bash 列出所有 provider：

node "${CLAUDE_PLUGIN_ROOT}/lib/ctl.js" list

2. 判断接管目标：
   - 若输出里标注 `⭐当前默认` 的那个 provider 同时带 `🎯含DS模型`，直接接管它（省略 --provider）；
   - 否则从 `🎯含DS模型` 的 provider 里选：只有一个就直接用它，多个则用 AskUserQuestion 让用户选一个。

3. 用 Bash 开启接管（`<id>` 换成选定的 provider id 或名称；接管当前默认时可省略）：

node "${CLAUDE_PLUGIN_ROOT}/lib/ctl.js" on --provider <id>

开启成功后，正常继续执行下面的用户任务即可（判定轮会自动进入 DSH 极简环境触发满血思维链）。

用户任务：
$ARGUMENTS
