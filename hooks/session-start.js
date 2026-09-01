const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const state = require('../lib/state.js');

const PROXY_SCRIPT = path.join(__dirname, '..', 'proxy.js');

function daemonCtl(port, action) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/ctl',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      timeout: 4000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ reachable: true, status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ reachable: true, status: res.statusCode, body: null }); }
      });
    });
    req.on('error', () => resolve({ reachable: false }));
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false }); });
    req.end(JSON.stringify({ action }));
  });
}

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
    result = state.enableInterception(config);
  }
  if (result.ok) {
    console.log(`[we-need-ds] 拦截已开启：baseUrl 临时切至 :${config.port}（会话结束自动还原）`);
  } else {
    console.log(`[we-need-ds] 拦截开启失败：${result.reason}`);
  }
}

main();
