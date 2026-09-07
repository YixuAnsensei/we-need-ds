const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ISOL = path.join(os.tmpdir(), 'wnd-stress-' + process.pid);
fs.mkdirSync(path.join(ISOL, 'cc-haha'), { recursive: true });
fs.mkdirSync(path.join(ISOL, 'we-need-ds'), { recursive: true });
process.env.WE_NEED_DS_PROVIDERS_PATH = path.join(ISOL, 'cc-haha', 'providers.json');
process.env.WE_NEED_DS_DATA_DIR = path.join(ISOL, 'we-need-ds');
process.env.WE_NEED_DS_TEST_PORT = '21340';

const state = require('./lib/state.js');
const PORT = 21340, UA = 21341, UB = 21342;
const KEY_A = 'sk-aaaa-1111', KEY_B = 'sk-bbbb-2222';

let failed = 0;
function check(name, cond, extra) {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`);
}

const hits = { A: 0, B: 0 };
function makeUpstream(port, tag, delayMs) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let data = '';
      req.on('data', c => data += c);
      req.on('end', () => {
        hits[tag]++;
        const send = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, tag, n: hits[tag] })); };
        if (delayMs) setTimeout(send, delayMs); else send();
      });
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function writeFixture(providers, activeId) {
  fs.writeFileSync(state.PROVIDERS_PATH, JSON.stringify({ activeId, providers }, null, 2), 'utf8');
}
function readProv() { return JSON.parse(fs.readFileSync(state.PROVIDERS_PATH, 'utf8')); }
function baseProv(id, name, key, url) {
  return { id, name, baseUrl: url, apiKey: key, models: { sonnet: 'deepseek-v4-pro', main: 'deepseek-v4-flash' } };
}

function post(port, pathName, bodyStr, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathName, method: 'POST', headers: { 'content-type': 'application/json', ...(headers || {}) }, timeout: 15000 }, (res) => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(bodyStr);
  });
}
function ctlViaDaemon(action, extra) { return post(PORT, '/ctl', JSON.stringify({ action, ...(extra || {}) })); }
function msgBody(model) { return JSON.stringify({ model, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }); }

async function waitProxy() { for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 200)); if (await state.isProxyRunning(PORT)) return true; } return false; }
function killPort(port) { try { const out = execSync(`powershell -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"`).toString().trim(); if (/^\d+$/.test(out)) { try { execSync(`taskkill /F /PID ${out}`); } catch (e) {} } } catch (e) {} }
function spawnDaemon() { const c = spawn(process.execPath, [path.join(__dirname, 'proxy.js')], { detached: true, stdio: 'ignore', env: { ...process.env, WE_NEED_DS_TEST_PORT: String(PORT) } }); c.unref(); return c; }
function ctlProc(args) { return new Promise((resolve) => { const c = spawn(process.execPath, [path.join(__dirname, 'lib', 'ctl.js'), ...args], { env: { ...process.env, WE_NEED_DS_TEST_PORT: String(PORT) } }); let out = ''; c.stdout.on('data', d => out += d); c.stderr.on('data', d => out += d); c.on('close', code => resolve({ code, out })); }); }

function isProxied(u) { return u && /127\.0\.0\.1:21340(?![0-9])/.test(u); }
function copiesOf(d) { return d.providers.filter(p => state.isCopyProvider(p)); }
function realOf(d) { return d.providers.filter(p => !state.isCopyProvider(p)); }

(async () => {
  const upA = await makeUpstream(UA, 'A', 0);
  const upB = await makeUpstream(UB, 'B', 1200);
  const cfg = state.loadConfig();

  try {
    console.log('\n=== S1 接管态并发转发（20 并发，无串扰无丢包） ===');
    writeFixture([baseProv('pa', 'DS-A', KEY_A, `http://127.0.0.1:${UA}`), baseProv('pb', 'DS-B', KEY_B, `http://127.0.0.1:${UB}`)], 'pa');
    spawnDaemon();
    state.enableInterception(cfg);
    if (!(await waitProxy())) { check('S1 daemon 起', false); throw new Error('no daemon'); }
    const before = hits.A;
    const results = await Promise.all(Array.from({ length: 20 }, () => post(PORT, '/v1/messages', msgBody('deepseek-v4-pro'), { 'x-api-key': KEY_A })));
    const okAll = results.every(r => r.status === 200 && JSON.parse(r.body).ok === true);
    check('S1a 20 并发全部 200 且上游应答完整', okAll, `statuses=${[...new Set(results.map(r => r.status))].join('/')}`);
    check('S1b 上游 A 恰好收到 20 次（无丢包无重复）', hits.A - before === 20, `delta=${hits.A - before}`);
    check('S1c 接管态下并发读 providers.json 不被破坏', (() => { try { readProv(); return true; } catch (e) { return false; } })());
    state.disableInterception(cfg);
  } catch (e) { check('S1 异常', false, e.message); }

  try {
    console.log('\n=== S2 反复 on/off 抖动（10 轮，每轮校验一致态） ===');
    writeFixture([baseProv('pa', 'DS-A', KEY_A, `http://127.0.0.1:${UA}`)], 'pa');
    if (!(await waitProxy())) spawnDaemon();
    await waitProxy();
    let consistent = true, copyLeak = 0;
    for (let i = 0; i < 10; i++) {
      await ctlViaDaemon('on');
      let d = readProv(); const stOn = state.readState();
      const onOk = realOf(d).every(p => p.id !== 'pa' || isProxied(p.baseUrl)) && copiesOf(d).length === 1 && stOn.enabled;
      await ctlViaDaemon('off');
      d = readProv(); const stOff = state.readState();
      const offOk = realOf(d).every(p => !isProxied(p.baseUrl)) && copiesOf(d).length === 0 && !stOff.enabled;
      if (!onOk || !offOk) { consistent = false; copyLeak += copiesOf(d).length; }
    }
    check('S2a 10 轮 on/off 每轮均收敛到一致态', consistent);
    check('S2b 无副本泄漏（最终副本数 0）', copiesOf(readProv()).length === 0);
  } catch (e) { check('S2 异常', false, e.message); }

  try {
    console.log('\n=== S3 多进程并发 ctl（8 进程 on/off 混打，最终收敛） ===');
    writeFixture([baseProv('pa', 'DS-A', KEY_A, `http://127.0.0.1:${UA}`)], 'pa');
    if (!(await waitProxy())) spawnDaemon();
    await waitProxy();
    const procs = [];
    for (let i = 0; i < 4; i++) procs.push(ctlProc(['on']));
    for (let i = 0; i < 4; i++) procs.push(ctlProc(['off']));
    const all = await Promise.all(procs);
    check('S3a 8 个并发 ctl 进程全部退出无崩溃', all.every(p => p.code === 0 || p.code === 1), `codes=${all.map(p => p.code).join(',')}`);
    await new Promise(r => setTimeout(r, 400));
    const d = readProv(), st = state.readState();
    const proxied = realOf(d).filter(p => isProxied(p.baseUrl)).length;
    const copies = copiesOf(d).length;
    const coherent = (st.enabled && proxied === 1 && copies === 1) || (!st.enabled && proxied === 0 && copies === 0);
    check('S3b 并发后状态收敛（enabled↔接管↔副本 三者一致）', coherent, `enabled=${st.enabled} proxied=${proxied} copies=${copies}`);
    check('S3c providers.json 仍是合法 JSON 无残留 tmp', (() => { try { readProv(); return !fs.readdirSync(path.dirname(state.PROVIDERS_PATH)).some(f => f.startsWith('providers.json.') && f.endsWith('.tmp')); } catch (e) { return false; } })());
    await ctlViaDaemon('off');
  } catch (e) { check('S3 异常', false, e.message); }

  try {
    console.log('\n=== S4 在途慢请求 vs 并发 off（互不阻塞） ===');
    writeFixture([baseProv('pa', 'DS-A', KEY_A, `http://127.0.0.1:${UA}`), baseProv('pb', 'DS-B', KEY_B, `http://127.0.0.1:${UB}`)], 'pa');
    state.enableInterception(cfg);
    await waitProxy();
    const slowP = post(PORT, '/v1/messages', msgBody('deepseek-v4-pro'), { 'x-api-key': KEY_B });
    await new Promise(r => setTimeout(r, 300));
    const offP = ctlViaDaemon('off');
    const [slow, off] = await Promise.all([slowP, offP]);
    check('S4a off 在慢请求飞行中成功返回', off.status === 200 && JSON.parse(off.body).ok === true);
    check('S4b 在途慢请求仍正常完成（不被 off 打断）', slow.status === 200 && JSON.parse(slow.body).ok === true);
    const d = readProv();
    check('S4c off 后本体已还原直连', realOf(d).every(p => !isProxied(p.baseUrl)));
  } catch (e) { check('S4 异常', false, e.message); }

  try {
    console.log('\n=== S5 接管后用户手改 providers.json（删本体/改 activeId）再 off ===');
    writeFixture([baseProv('pa', 'DS-A', KEY_A, `http://127.0.0.1:${UA}`), baseProv('pb', 'DS-B', KEY_B, `http://127.0.0.1:${UB}`)], 'pa');
    state.enableInterception(cfg);
    await waitProxy();
    let d = readProv();
    d.providers = d.providers.filter(p => p.id !== 'pa');
    d.activeId = 'pb';
    fs.writeFileSync(state.PROVIDERS_PATH, JSON.stringify(d, null, 2), 'utf8');
    const r = state.disableInterception(cfg);
    check('S5a 本体被删后 off 不崩溃', r.ok === true);
    check('S5b 账本仍记录了被删 provider 的原始上游（可还原信息未丢）', !!(state.readState().providers && state.readState().providers.pa));
    d = readProv();
    check('S5c 幸存 provider pb 未被误改', realOf(d).find(p => p.id === 'pb').baseUrl === `http://127.0.0.1:${UB}`);
  } catch (e) { check('S5 异常', false, e.message); }

  try {
    console.log('\n=== S6 daemon 中途被杀 → 死状态检测 → boot 恢复 ===');
    writeFixture([baseProv('pa', 'DS-A', KEY_A, `http://127.0.0.1:${UA}`)], 'pa');
    state.enableInterception(cfg);
    await waitProxy();
    killPort(PORT);
    await new Promise(r => setTimeout(r, 600));
    const dead = state.detectDeadState(cfg);
    check('S6a daemon 死后检出孤儿（本体指向死代理）', dead.dead === true && dead.orphanCount === 1, `orphan=${dead.orphanCount}`);
    let refused = false;
    try { await post(PORT, '/v1/messages', msgBody('deepseek-v4-pro'), { 'x-api-key': KEY_A }); } catch (e) { refused = /ECONNREFUSED|timeout/.test(e.message); }
    check('S6b 死代理期间请求 ECONNREFUSED（不假通）', refused);
    const boot = await ctlProc(['boot']);
    check('S6c boot 恢复接管成功', /重新接管|已在运行|已重新拉起/.test(boot.out), boot.out.split(/\r?\n/).find(l => /boot:/.test(l)) || '');
    const d = readProv();
    check('S6d boot 后本体重新指向代理', realOf(d).some(p => p.id === 'pa' && isProxied(p.baseUrl)));
    await ctlViaDaemon('off');
  } catch (e) { check('S6 异常', false, e.message); }

  try {
    console.log('\n=== S7 并发接管切换（A→B 快速连打，无副本堆积） ===');
    writeFixture([baseProv('pa', 'DS-A', KEY_A, `http://127.0.0.1:${UA}`), baseProv('pb', 'DS-B', KEY_B, `http://127.0.0.1:${UB}`)], 'pa');
    state.enableInterception(cfg);
    await waitProxy();
    const sw = await Promise.all([ctlViaDaemon('on', { providerId: 'pb' }), ctlViaDaemon('on', { providerId: 'pa' }), ctlViaDaemon('on', { providerId: 'pb' })]);
    check('S7a 三次并发切换全部 ok', sw.every(r => r.status === 200 && JSON.parse(r.body).ok === true));
    const d = readProv();
    check('S7b 副本不堆积（恰好 1 个）', copiesOf(d).length === 1, `copies=${copiesOf(d).length}`);
    const proxied = realOf(d).filter(p => isProxied(p.baseUrl));
    check('S7c 仅 1 个本体被接管（单服务商不变量）', proxied.length === 1, `proxied=${proxied.length}`);
    check('S7d 未被接管的本体保持直连', realOf(d).filter(p => !isProxied(p.baseUrl)).every(p => p.baseUrl.includes(String(UA)) || p.baseUrl.includes(String(UB))));
    await ctlViaDaemon('off');
  } catch (e) { check('S7 异常', false, e.message); }

  try {
    console.log('\n=== S8 高并发混合（接管+转发+status 读 交织 30 请求） ===');
    writeFixture([baseProv('pa', 'DS-A', KEY_A, `http://127.0.0.1:${UA}`)], 'pa');
    state.enableInterception(cfg);
    await waitProxy();
    const before = hits.A;
    const mixed = await Promise.all(Array.from({ length: 30 }, (_, i) => {
      if (i % 3 === 0) return post(PORT, '/health-check', '');
      if (i % 3 === 1) return post(PORT, '/v1/messages', msgBody('deepseek-v4-pro'), { 'x-api-key': KEY_A });
      return ctlViaDaemon('on');
    }));
    check('S8a 30 混合请求无 5xx 无崩溃', mixed.every(r => r.status < 500), `statuses=${[...new Set(mixed.map(r => r.status))].join('/')}`);
    check('S8b 交织 on 未破坏转发（上游收到 ≥10 次）', hits.A - before >= 10, `delta=${hits.A - before}`);
    const d = readProv();
    check('S8c 高并发后仍单服务商不变量', copiesOf(d).length === 1 && realOf(d).filter(p => isProxied(p.baseUrl)).length === 1);
    await ctlViaDaemon('off');
  } catch (e) { check('S8 异常', false, e.message); }

  state.disableInterception(cfg);
  upA.close(); upB.close();
  killPort(PORT);
  await new Promise(r => setTimeout(r, 300));
  try { fs.rmSync(ISOL, { recursive: true, force: true }); } catch (e) {}
  console.log(failed === 0 ? '\n★ 压力审查全部通过' : `\n★ ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
})();
