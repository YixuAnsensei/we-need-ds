const { spawn } = require('child_process');
const path = require('path');
const state = require('../lib/state.js');

const PROXY_SCRIPT = path.join(__dirname, '..', 'proxy.js');
const daemonCtl = state.daemonCtl;

async function main() {
  const config = state.loadConfig();

  try {
    const r = state.recoverOrphans(config);
    if (r && r.orphan && r.restoredList.length > 0) {
      state.log(`session-start: ${r.restoredList.length} orphan providers restored`);
    }
  } catch (e) {
    state.log(`session-start orphan recovery failed: ${e.message}`);
  }

  const running = await state.isProxyRunning(config.port);

  if (!running) {
    const child = spawn(process.execPath, [PROXY_SCRIPT], { detached: true, stdio: 'ignore' });
    child.unref();
    let up = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (await state.isProxyRunning(config.port)) { up = true; break; }
    }
    state.log(up ? 'daemon started via session-start' : 'daemon failed to start');
  }

  let result = await daemonCtl(config.port, 'on');
  if (result.reachable) {
    result = result.body || { ok: true };
  } else {
    result = {
      ok: false,
      reason: `端口 ${config.port} 上的进程不响应 /ctl（可能被其他程序占用，拦截已放弃，providers 保持真实地址）`
    };
  }
  if (result.ok) {
    console.log(`[we-need-ds] 拦截已开启：baseUrl 临时切至 :${config.port}（会话结束自动还原）`);
  } else {
    console.log(`[we-need-ds] 拦截开启失败：${result.reason}`);
  }
}

main();
