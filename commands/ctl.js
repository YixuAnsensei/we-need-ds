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
  } else if (command === 'doctor') {
    console.log('[we-need-ds] 开始深度体检...\n');

    const running = await state.isProxyRunning(config.port);
    console.log(`1. 代理守护进程 (端口 ${config.port}): ${running ? '✅ 正常运行中' : '⚠️ 未运行 (会在使用时自动拉起)'}`);

    const hasCc = require('fs').existsSync(state.PROVIDERS_PATH);
    console.log(`2. 运行环境模式: ${hasCc ? '✅ cc-haha 环境 (已检测到 providers.json)' : 'ℹ️ 纯正 Claude Code 环境 (环境变量/直连模式)'}`);

    let upstreamUrl = config.targetBaseUrl;
    if (hasCc) {
      try {
        const data = JSON.parse(require('fs').readFileSync(state.PROVIDERS_PATH, 'utf8'));
        const active = (data.providers || []).find(p => p.id === data.activeId);
        if (active) {
          const st = state.readState();
          upstreamUrl = st.enabled && st.originalUrl ? st.originalUrl : active.baseUrl;
          console.log(`3. 激活 Provider: ✅ ID ${active.id} (格式: ${active.apiFormat || 'openai_chat'})`);
          console.log(`   原始上游地址: ${upstreamUrl}`);
        }
      } catch (e) {
        console.log(`3. providers.json 读取异常: ${e.message}`);
      }
    }

    if (upstreamUrl && upstreamUrl !== 'auto' && upstreamUrl !== 'env/default') {
      try {
        const u = new URL(upstreamUrl);
        const probePort = u.port || (u.protocol === 'https:' ? 443 : 80);
        const reachable = await new Promise((resolve) => {
          const s = require('net').createConnection(probePort, u.hostname, () => {
            s.end();
            resolve(true);
          });
          s.on('error', () => resolve(false));
          s.setTimeout(1000, () => { s.destroy(); resolve(false); });
        });
        console.log(`4. 上游网关连通性 (${u.hostname}:${probePort}): ${reachable ? '✅ 通畅' : '❌ 不通 (请确认 9router/中转网关已启动)'}`);
      } catch (e) {
        console.log(`4. 上游地址解析异常: ${e.message}`);
      }
    }

    console.log(`\n5. 目标模型拦截列表: ${config.targetModels.join(', ')}`);
    console.log(`6. 首轮诱导核心工具: ${config.bootstrapCoreTools.join(', ')}`);
    console.log('\n体检完成。');
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
