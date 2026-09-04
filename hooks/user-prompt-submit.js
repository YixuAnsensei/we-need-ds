const { spawn } = require('child_process');
const path = require('path');
const state = require('../lib/state.js');

const PROXY_SCRIPT = path.join(__dirname, '..', 'proxy.js');
const daemonCtl = state.daemonCtl;

async function main() {
  const config = state.loadConfig();
  const running = await state.isProxyRunning(config.port);

  if (!running) {
    const st = state.readState();
    if (!st.enabled) return;

    const child = spawn(process.execPath, [PROXY_SCRIPT], { detached: true, stdio: 'ignore' });
    child.unref();
    let up = false;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (await state.isProxyRunning(config.port)) { up = true; break; }
    }

    if (up) {
      const r = await daemonCtl(config.port, 'on');
      if (r.reachable && r.body && r.body.ok) {
        state.log('user-prompt-submit: daemon revived, re-hooked via /ctl on (daemon is single writer)');
      } else {
        const direct = state.enableInterception(config);
        state.log(`user-prompt-submit: /ctl on not usable (reachable=${r.reachable}), direct re-hook ok=${direct && direct.ok}`);
      }
      console.log('[we-need-ds] 检测到代理已失效，已自动拉起并重新接管（裁剪恢复生效）');
    } else {
      state.log('user-prompt-submit: daemon failed to revive');
    }
  }
}

main();
