---
name: list
description: 列出全部 provider 及接管建议（含 DS 模型标注、当前默认、代理状态）
---

用 Bash 执行：

node "${CLAUDE_PLUGIN_ROOT}/lib/ctl.js" list

把输出整理成清单展示给用户：哪些 provider 含 DeepSeek Pro 模型（🎯）、哪个是当前默认（⭐）、哪个已在代理中（🔌）。然后提示用户：要接管某个 provider，执行 `/we-need-ds:on` 并告诉我要接管哪一个。
