const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const state = require(path.join(__dirname, '..', 'lib', 'state.js'));

const command = process.argv[2] || 'status';
const config = state.loadConfig();

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
  if (command === 'boot') {
    const st = state.readState();
    const running = await state.isProxyRunning(config.port);

    if (st.enabled) {
      if (!running) {
        const child = spawn(process.execPath, [path.join(__dirname, '..', 'proxy.js')], { detached: true, stdio: 'ignore' });
        child.unref();
        for (let i = 0; i < 15; i++) {
          await new Promise(r2 => setTimeout(r2, 200));
          if (await state.isProxyRunning(config.port)) break;
        }
      }
      const alive = await state.isProxyRunning(config.port);
      if (!alive) {
        const ds = state.detectDeadState(config);
        let restored = 0;
        if (ds.dead) {
          const r2 = state.recoverOrphans(config);
          restored = r2.restoredList ? r2.restoredList.length : 0;
        }
        console.log(`[we-need-ds] boot: 拦截处于开启状态，但 daemon 拉起失败(:${config.port})，已把 ${restored} 个指向代理的 provider 还原直连（避免死锁，稍后可重试 on/boot）`);
        return;
      }
      const r = state.recoverOrphans(config);
      const re = state.enableInterception(config);
      const hooked = re.interceptedList ? re.interceptedList.length : 0;
      const orphans = r.restoredList ? r.restoredList.length : 0;
      console.log(`[we-need-ds] boot: 拦截处于开启状态，daemon ${running ? '已在运行' : '已重新拉起'}${orphans ? `，先修复孤儿 provider ${orphans} 个` : ''}，已重新接管 ${hooked} 个 provider 到 :${config.port}`);
    } else {
      const r = state.recoverOrphans(config);
      const hooked = r.restoredList ? r.restoredList.length : 0;
      if (running) {
        console.log(`[we-need-ds] boot: 拦截已关闭但 daemon 残留，正在停止残留进程`);
        const { exec } = require('child_process');
        const pid = await new Promise((resolve) => {
          exec(`netstat -ano | findstr ":${config.port}" | findstr "LISTENING"`, (err, stdout) => {
            const m = stdout.trim().split(/\s+/).pop();
            resolve(m && /^\d+$/.test(m) ? m : null);
          });
        });
        if (pid) {
          const { execSync } = require('child_process');
          try { execSync(`taskkill /F /PID ${pid}`); } catch (e) {}
        }
      }
      console.log(hooked ? `[we-need-ds] boot: 拦截已关闭，修复孤儿 provider ${hooked} 个` : `[we-need-ds] boot: 状态一致，无需修复`);
    }
    return;
  }

  if (command === 'restart') {
    const st = state.readState();
    const { exec, execSync } = require('child_process');

    const pid = await new Promise((resolve) => {
      exec(`netstat -ano | findstr ":${config.port}" | findstr "LISTENING"`, (err, stdout) => {
        const m = stdout.trim().split(/\s+/).pop();
        resolve(m && /^\d+$/.test(m) ? m : null);
      });
    });
    if (pid) {
      console.log(`[we-need-ds] restart: 停止旧 daemon (PID ${pid})`);
      try { execSync(`taskkill /F /PID ${pid}`); } catch (e) {}
      for (let i = 0; i < 25; i++) {
        await new Promise(r => setTimeout(r, 200));
        if (!(await state.isProxyRunning(config.port))) break;
      }
    } else {
      console.log(`[we-need-ds] restart: 端口 :${config.port} 无运行中的 daemon，直接拉起`);
    }

    const child = spawn(process.execPath, [path.join(__dirname, '..', 'proxy.js')], { detached: true, stdio: 'ignore' });
    child.unref();
    let up = false;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (await state.isProxyRunning(config.port)) { up = true; break; }
    }
    if (!up) {
      console.log(`[we-need-ds] restart 失败：新 daemon 未能监听 :${config.port}`);
      process.exit(1);
    }

    if (st.enabled) {
      const r = await daemonCtl(config.port, 'on');
      const ok = r.reachable && r.body && r.body.ok;
      const n = ok && Array.isArray(r.body.interceptedList) ? r.body.interceptedList.length : 0;
      console.log(`[we-need-ds] restart 完成：daemon 已重启 (:${config.port})，拦截开启中，${ok ? `已重新接管 ${n} 个 provider` : '重接管未确认（请检查 daemon 状态）'}`);
    } else {
      console.log(`[we-need-ds] restart 完成：daemon 已重启 (:${config.port})，拦截处于关闭状态（直连上游）`);
    }
    return;
  }

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

    let r = await daemonCtl(config.port, 'on');
    if (r.reachable) {
      r = r.body || { ok: false, reason: 'daemon 响应格式异常' };
    } else {
      r = { ok: false, reason: `端口 ${config.port} 无 we-need-ds daemon 响应 (可能被其他程序占用)` };
    }
    if (r.ok) {
      console.log(`\n======================================================`);
      console.log(` [we-need-ds] 满血拦截代理已就绪 (端口 :${config.port})`);
      console.log(`======================================================`);
      console.log(`⚡ DSH 极简模拟待命：判定轮(新任务)自动切换极简环境，执行轮(工具续跑)全量放行 (we-need-ds:v5)`);
      if (r.mode === 'cc-haha' && Array.isArray(r.interceptedList)) {
        console.log(`已接管 Provider 实例 (共 ${r.interceptedList.length} 个)，支持多窗口自由切换`);
      }
      console.log(`目标模型: ${config.targetModels.join(', ')}`);
      console.log(`极简工具集: ${config.bootstrapCoreTools.join(', ')} (对齐 DSH bash + str_replace_editor)`);
      console.log(`======================================================\n`);
      return;
    } else {
      const ds = state.detectDeadState(config);
      let restored = 0;
      if (ds.dead) {
        const r2 = state.recoverOrphans(config);
        restored = r2.restoredList ? r2.restoredList.length : 0;
      }
      console.log(`[we-need-ds] 开启失败：${r.reason}；已把 ${restored} 个指向代理的 provider 还原直连（避免死锁，请排查端口占用后重试）`);
      process.exit(1);
    }
  } else if (command === 'off') {
    let r = await daemonCtl(config.port, 'off');
    if (r.reachable) {
      r = r.body || { ok: true };
    } else {
      r = state.disableInterception(config);
    }
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
      if (r.unrestorableList && r.unrestorableList.length > 0) {
        console.log(`\n⚠️ 警告：以下 ${r.unrestorableList.length} 个 Provider 仍指向代理端口，但账本无真实上游记录，无法自动还原：`);
        r.unrestorableList.forEach((item, idx) => {
          console.log(`  [${idx + 1}] ${item.name || item.id}  （请在 cc-haha 中手动改回真实上游地址后再使用）`);
        });
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

    const dsWarn = state.detectDeadState(config);
    if (dsWarn.dead && !running) {
      console.log(`\n⚠️ 死状态告警：${dsWarn.orphanCount} 个 provider 指向 :${config.port} 但代理未运行 → 当前不可用！`);
      console.log(`   恢复：执行 /we-need-ds:on，或终端跑 node lib/ctl.js boot（会拉起代理并重新接管）`);
    }

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
        console.log(`5. 极简模式: ⚡ v5 常态生效 (每个判定轮=DSH 极简环境；每个执行轮=全量工具)`);

        let matched = [];
        for (const prov of (data.providers || [])) {
          if (state.providerHasTargetModels(prov, config.targetModels)) {
            const isHooked = prov.baseUrl && prov.baseUrl.includes(`:${config.port}`);
            matched.push({ name: prov.name, isHooked, baseUrl: prov.baseUrl });
          }
        }
        console.log(`\n6. 检测到包含 DeepSeek Pro 模型的 Provider 池 (共 ${matched.length} 个)：`);
        matched.forEach(m => {
          console.log(`   - ${m.name}: ${m.isHooked ? `[代理中 :${config.port}]` : `[直连 ${m.baseUrl}]`}`);
        });
      } catch (e) {
        console.log(`3. 读取 providers.json 失败: ${e.message}`);
      }
    }

    console.log(`\n7. 目标拦截模型列表: ${config.targetModels.join(', ')}`);
    console.log(`8. 极简工具集 (DSH 对齐): ${config.bootstrapCoreTools.join(', ')}`);
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
    console.log(`极简模式          : ⚡ v5 常态生效 (判定轮=DSH 极简；执行轮=全量放行)`);

    if (st.enabled && hookedProviders.length > 0) {
      console.log(`\n当前被代理接管的 Provider (${hookedProviders.length} 个):`);
      hookedProviders.forEach((p, idx) => {
        console.log(`  ${idx + 1}. ${p.name} (原始上游: ${p.originalUrl})`);
      });
    } else {
      console.log(`\n当前所有 Provider 均直连真实上游，未开启代理转发。`);
    }

    const ds = state.detectDeadState(config);
    if (ds.dead && !running) {
      console.log(`\n⚠️ 检测到死状态：${ds.orphanCount} 个 provider 指向 :${config.port} 但代理未运行 → 当前不可用！`);
      console.log(`   恢复：执行 /we-need-ds:on，或终端跑 node lib/ctl.js boot（会拉起代理并重新接管）`);
    }

    console.log(`\n目标模型: ${config.targetModels.join(', ')}`);
    console.log(`运行日志: ${state.LOG_PATH}`);
    console.log(`======================================================\n`);
  }
}

main();
