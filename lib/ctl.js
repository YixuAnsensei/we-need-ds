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
      console.log(`\n======================================================`);
      console.log(` [we-need-ds] 满血拦截代理已成功启动 (端口 :${config.port})`);
      console.log(`======================================================`);
      if (r.mode === 'cc-haha') {
        console.log(`\n已全量接管当前所有 Provider 实例 (共 ${r.interceptedList.length} 个)：`);
        r.interceptedList.forEach((item, idx) => {
          console.log(`  [${idx + 1}] ${item.name || item.id}`);
          console.log(`      原上游: ${item.originalUrl}  --->  现代理: ${r.proxyUrl}`);
        });
        console.log(`\n提示：现在你在任何窗口随意切换任意 Provider，均可直接触发 We need 思维链！`);
      } else {
        console.log(`\n运行于纯 Claude Code 模式，代理正在监听 ${r.proxyUrl}`);
      }
      console.log(`目标拦截模型: ${config.targetModels.join(', ')}`);
      console.log(`首轮保留核心工具: ${config.bootstrapCoreTools.join(', ')}`);
      console.log(`======================================================\n`);
    } else {
      console.log(`[we-need-ds] 开启失败：${r.reason}`);
      process.exit(1);
    }
  } else if (command === 'off') {
    const r = state.disableInterception(config);
    if (r.ok) {
      console.log(`\n======================================================`);
      console.log(` [we-need-ds] 拦截环境已关闭，配置已安全还原`);
      console.log(`======================================================`);
      if (r.restoredList && r.restoredList.length > 0) {
        console.log(`\n已将以下 Provider 还原为各自原始上游地址：`);
        r.restoredList.forEach((item, idx) => {
          console.log(`  [${idx + 1}] ${item.name || item.id}  --->  ${item.restoredUrl}`);
        });
      } else {
        console.log(`\n当前没有被修改的 Provider 端点需要还原。`);
      }
      console.log(`======================================================\n`);
    } else {
      console.log(`[we-need-ds] 关闭失败：${r.reason}`);
      process.exit(1);
    }
  } else if (command === 'doctor') {
    console.log(`\n======================================================`);
    console.log(` [we-need-ds] 系统深度体检报告`);
    console.log(`======================================================\n`);

    const running = await state.isProxyRunning(config.port);
    console.log(`1. 本地代理进程 (:${config.port}): ${running ? '✅ 运行正常' : '⚠️ 未运行 (使用时会自动拉起)'}`);

    const hasCc = require('fs').existsSync(state.PROVIDERS_PATH);
    console.log(`2. 客户端环境: ${hasCc ? '✅ cc-haha 客户端 (已发现 providers.json)' : 'ℹ️ 纯正 Claude Code 环境'}`);

    if (hasCc) {
      try {
        const data = JSON.parse(require('fs').readFileSync(state.PROVIDERS_PATH, 'utf8'));
        const activeProv = (data.providers || []).find(p => p.id === data.activeId);
        console.log(`3. 当前活跃 Provider: ${activeProv ? activeProv.name : '未知'} (${activeProv ? activeProv.baseUrl : ''})`);

        const st = state.readState();
        const hookedCount = st.enabled && st.providers ? Object.keys(st.providers).length : 0;
        console.log(`4. 拦截接管状态: ${st.enabled ? `✅ 已开启 (接管 ${hookedCount} 个 Provider)` : '⚪ 已关闭 (直连上游)'}`);

        let matched = [];
        for (const prov of (data.providers || [])) {
          if (state.providerHasTargetModels(prov, config.targetModels)) {
            const isHooked = prov.baseUrl && prov.baseUrl.includes(`:${config.port}`);
            matched.push({ name: prov.name, isHooked, baseUrl: prov.baseUrl });
          }
        }
        console.log(`\n5. 检测到包含 DeepSeek Pro 模型的 Provider 池 (共 ${matched.length} 个)：`);
        matched.forEach(m => {
          console.log(`   - ${m.name}: ${m.isHooked ? `[代理中 :${config.port}]` : `[直连 ${m.baseUrl}]`}`);
        });
      } catch (e) {
        console.log(`3. 读取 providers.json 失败: ${e.message}`);
      }
    }

    console.log(`\n6. 目标拦截模型列表: ${config.targetModels.join(', ')}`);
    console.log(`7. 首轮诱导核心工具: ${config.bootstrapCoreTools.join(', ')}`);
    console.log(`\n======================================================\n`);
  } else {
    const running = await state.isProxyRunning(config.port);
    const st = state.readState();
    const hookedProviders = st.enabled && st.providers ? Object.values(st.providers) : [];

    console.log(`\n======================================================`);
    console.log(` [we-need-ds] 运行与拦截状态面板`);
    console.log(`======================================================`);
    console.log(`代理进程 (:${config.port}) : ${running ? '✅ 运行中' : '⚪ 未运行'}`);
    console.log(`拦截总开关        : ${st.enabled ? '🟢 开启' : '⚪ 关闭'}`);

    if (st.enabled && hookedProviders.length > 0) {
      console.log(`\n当前被代理接管的 Provider (${hookedProviders.length} 个):`);
      hookedProviders.forEach((p, idx) => {
        console.log(`  ${idx + 1}. ${p.name} (原始上游: ${p.originalUrl})`);
      });
    } else {
      console.log(`\n当前所有 Provider 均直连真实上游，未开启代理转发。`);
    }

    console.log(`\n目标模型: ${config.targetModels.join(', ')}`);
    console.log(`运行日志: ${state.LOG_PATH}`);
    console.log(`======================================================\n`);
  }
}

main();
