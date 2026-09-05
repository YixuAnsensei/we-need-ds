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
        if (res.statusCode !== 200) { resolve({ reachable: false, status: res.statusCode }); return; }
        try { resolve({ reachable: true, status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ reachable: false, status: res.statusCode }); }
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
    result = {
      ok: false,
      reason: `端口 ${config.port} 上的进程不响应 /ctl（可能被其他程序占用，拦截已放弃）`
    };
  }
  if (result.ok) {
    console.log(`[we-need-ds] 拦截已开启：baseUrl 临时切至 :${config.port}（会话结束自动还原）`);
  } else {
    const ds = state.detectDeadState(config);
    if (ds.dead) {
      const off = state.disableInterception(config);
      const n = off && off.restoredList ? off.restoredList.length : 0;
      console.log(`[we-need-ds] 拦截开启失败：${result.reason}；已把 ${n} 个指向代理的 provider 还原直连（避免死锁，可随时 /we-need-ds:on 重试）`);
    } else {
      console.log(`[we-need-ds] 拦截开启失败：${result.reason}；providers 未指向代理，保持直连`);
    }
  }
}

main();
