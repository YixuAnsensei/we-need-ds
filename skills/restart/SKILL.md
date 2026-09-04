---
name: restart
description: 优雅重启 we-need-ds 代理 daemon（换新进程、清理卡死连接、按账本重新接管）
---

用 Bash 执行：

node "${CLAUDE_PLUGIN_ROOT}/lib/ctl.js" restart
