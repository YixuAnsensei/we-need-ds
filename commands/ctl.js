const path = require('path');
const { spawn } = require('child_process');
const state = require(path.join(__dirname, '..', 'lib', 'state.js'));

if (!process.env.WE_NEED_DS_NO_REWRITE) {
  process.env.WE_NEED_DS_NO_REWRITE = '1';
}

const command = process.argv[2] || 'status';
const config = state.loadConfig();

async function main() {
  if (command === 'on') {
    const running = await state.isProxyRunning(config.port);
    if (!running) {
      const child = spawn(process.execPath, [path.join(__dirname, '..', 'proxy.js')], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 200));
        if (await state.isProxyRunning(config.port)) break;
      }
    }
    const r = state.enableInterception(config);
    if (r.ok) {
      console.log(`[we-need-ds] 拦截已开启：${r.originalUrl || '（已是代理地址）'} -> ${r.proxyUrl}`);
    } else {
      console.log(`[we-need-ds] 开启失败：${r.reason}`);
      process.exit(1);
    }
  } else if (command === 'off') {
    const r = state.disableInterception(config);
    if (r.ok) {
      console.log(r.already ? '[we-need-ds] 拦截本就未开启。' : `[we-need-ds] 拦截已关闭，baseUrl 还原为 ${r.restored}`);
    } else {
      console.log(`[we-need-ds] 关闭失败：${r.reason}`);
      process.exit(1);
    }
  } else {
    const running = await state.isProxyRunning(config.port);
    const st = state.readState();
    let originalUrl = st.originalUrl;
    try {
      const data = JSON.parse(require('fs').readFileSync(state.PROVIDERS_PATH, 'utf8'));
      const provider = (data.providers || []).find(p => p.id === data.activeId);
      if (provider) originalUrl = st.enabled ? st.originalUrl : provider.baseUrl;
    } catch (e) {}
    console.log('[we-need-ds] 状态');
    console.log(`  守护进程 :${config.port}  ${running ? '运行中' : '未运行'}`);
    console.log(`  拦截     ${st.enabled ? '开启（临时切至代理）' : '关闭'}`);
    console.log(`  原始 URL ${originalUrl || '未知'}`);
    console.log(`  目标模型 ${config.targetModels.join(', ')}`);
    console.log(`  日志     ${state.LOG_PATH}`);
  }
}

main();
