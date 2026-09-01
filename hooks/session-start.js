const { spawn } = require('child_process');
const path = require('path');
const state = require('../lib/state.js');

const PROXY_SCRIPT = path.join(__dirname, '..', 'proxy.js');

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

  const result = state.enableInterception(config);
  if (result.ok) {
    console.log(`[we-need-ds] 拦截已开启：baseUrl 临时切至 :${config.port}（会话结束自动还原为 ${result.originalUrl || '原地址'}）`);
  } else {
    console.log(`[we-need-ds] 拦截开启失败：${result.reason}`);
  }
}

main();
