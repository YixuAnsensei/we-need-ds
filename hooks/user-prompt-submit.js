const { spawn } = require('child_process');
const path = require('path');
const state = require('../lib/state.js');

const PROXY_SCRIPT = path.join(__dirname, '..', 'proxy.js');

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
      const r = state.recoverOrphans(config);
      state.enableInterception(config);
      state.log(`user-prompt-submit: daemon revived and re-hooked (${r.restoredList ? r.restoredList.length : 0} orphans restored first)`);
      console.log('[we-need-ds] 检测到代理已失效，已自动拉起并重新接管（裁剪恢复生效）');
    } else {
      state.log('user-prompt-submit: daemon failed to revive');
      const ds = state.detectDeadState(config);
      if (ds.dead) {
        const off = state.disableInterception(config);
        const n = off && off.restoredList ? off.restoredList.length : 0;
        state.log(`user-prompt-submit: revive failed, ${n} providers restored to direct (avoid deadlock)`);
        console.log(`[we-need-ds] 代理复活失败；已把 ${n} 个指向代理的 provider 还原直连（避免死锁）`);
      }
    }
  } else {
    const st = state.readState();
    if (st.enabled && !state.detectDeadState(config).dead) {
      const re = state.enableInterception(config);
      const n = re.interceptedList ? re.interceptedList.length : 0;
      if (n > 0) {
        state.log(`user-prompt-submit: enabled but zero hooked (previous fail-safe restore), re-hooked ${n}`);
        console.log(`[we-need-ds] 检测到拦截开启但未被接管（上次失败已还原直连），daemon 存活，已重新接管 ${n} 个（当轮裁剪恢复生效）`);
      }
    }
  }
}

main();
