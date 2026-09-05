const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ISOL_DIR = path.join(os.tmpdir(), 'wnd-test-isolation-' + process.pid);
fs.mkdirSync(path.join(ISOL_DIR, 'cc-haha'), { recursive: true });
fs.mkdirSync(path.join(ISOL_DIR, 'we-need-ds'), { recursive: true });
process.env.WE_NEED_DS_PROVIDERS_PATH = path.join(ISOL_DIR, 'cc-haha', 'providers.json');
process.env.WE_NEED_DS_DATA_DIR = path.join(ISOL_DIR, 'we-need-ds');

const state = require('./lib/state.js');

let failed = 0;
function check(name, cond) {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}`);
}

const STATE_PATH = state.STATE_PATH;
const BACKUP = STATE_PATH + '.test-bak';

const seenBodies = [];
const upstream = http.createServer((req, res) => {
  let data = '';
  req.on('data', c => data += c);
  req.on('end', () => {
    if (req.url.includes('/fail')) { res.writeHead(500); res.end('{}'); return; }
    try { seenBodies.push(JSON.parse(data)); } catch (e) { seenBodies.push(null); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

function lastBody() {
  return seenBodies[seenBodies.length - 1];
}

function lastToolCount() {
  const b = lastBody();
  return b && Array.isArray(b.tools) ? b.tools.length : -1;
}

function lastIsDshMinimal() {
  const b = lastBody();
  if (!b) return false;
  if (Array.isArray(b.system)) {
    return b.system.length === 1 && b.system[0].text === 'You are a helpful software engineer assistant.';
  }
  const sysMsg = (b.messages || []).find(m => m.role === 'system');
  return sysMsg && sysMsg.content === 'You are a helpful software engineer assistant.';
}

function post(pathName, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 21329, path: pathName, method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(body);
  });
}

async function waitProxy() {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (await state.isProxyRunning(21329)) return true;
  }
  return false;
}

function killDaemon() {
  try {
    const out = execSync('powershell -Command "(Get-NetTCPConnection -LocalPort 21329 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"').toString().trim();
    if (/^\d+$/.test(out)) { try { execSync(`taskkill /F /PID ${out}`); } catch (e) {} }
  } catch (e) {}
}

const tools4 = [
  { type: 'function', function: { name: 'Bash' } },
  { type: 'function', function: { name: 'Edit' } },
  { type: 'function', function: { name: 'mcp__foo' } },
  { type: 'function', function: { name: 'Workflow' } }
];

const multiTurnBody = JSON.stringify({
  model: 'deepseek-v4-pro',
  messages: [
    { role: 'user', content: 'round 1' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'round 2' }
  ],
  tools: tools4
});
const singleTurnBody = JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hello' }], tools: tools4 });
const toolFollowupBody = JSON.stringify({
  model: 'deepseek-v4-pro',
  messages: [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: 'doing', tool_calls: [{ id: '1', type: 'function', function: { name: 'Bash' } }] },
    { role: 'tool', content: 'out', tool_call_id: '1' }
  ],
  tools: tools4
});
const anthropicFollowupBody = JSON.stringify({
  model: 'deepseek-v4-pro',
  messages: [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] }
  ],
  tools: tools4
});

async function main() {
  const PROVIDERS_BAK = state.PROVIDERS_PATH + '.test-bak';
  const hadProviders = fs.existsSync(state.PROVIDERS_PATH);
  if (hadProviders) fs.copyFileSync(state.PROVIDERS_PATH, PROVIDERS_BAK);
  try { fs.copyFileSync(STATE_PATH, BACKUP); } catch (e) {}

  await new Promise(r => upstream.listen(2099, '127.0.0.1', r));
  killDaemon();
  await new Promise(r => setTimeout(r, 500));

  spawn(process.execPath, [path.join(__dirname, 'proxy.js')], { detached: true, stdio: 'ignore', env: { ...process.env, WE_NEED_DS_TEST_PORT: '21329' } }).unref();
  check('daemon 拉起', await waitProxy());

  state.writeState({ enabled: true, providers: {}, keyMap: {}, defaultUpstream: 'http://127.0.0.1:2099' });

  await post('/v1/messages', singleTurnBody);
  check('首轮判定轮: 裁切至 2 (Bash+Edit)', lastToolCount() === 2);
  check('首轮判定轮: DSH 单行系统提示词', lastIsDshMinimal());

  await post('/v1/messages', multiTurnBody);
  check('长会话第 N 次判定轮: 同样裁切 (v5 常态极简)', lastToolCount() === 2);
  check('长会话判定轮: DSH 单行系统提示词', lastIsDshMinimal());

  await post('/v1/messages', toolFollowupBody);
  check('执行轮 OpenAI 格式: 全量放行 (4 tools)', lastToolCount() === 4);
  check('执行轮 OpenAI 格式: DSH 人格替换 (v5.1)', lastIsDshMinimal());

  await post('/v1/messages', anthropicFollowupBody);
  check('执行轮 Anthropic 格式: 全量放行 (4 tools)', lastToolCount() === 4);
  check('执行轮 Anthropic 格式: DSH 人格替换 (v5.1)', lastIsDshMinimal());

  await post('/v1/messages', toolFollowupBody);
  check('多轮执行链中途: 全量放行 (4 tools)', lastToolCount() === 4);

  await post('/v1/messages', multiTurnBody);
  check('执行链结束后的新判定轮: 重新进入极简 (2 tools)', lastToolCount() === 2);
  check('新判定轮: DSH 提示词回归', lastIsDshMinimal());

  const r1 = await post('/v1/messages/fail', multiTurnBody);
  check('5xx 返回上游错误码', r1.status === 500);
  await post('/v1/messages', multiTurnBody);
  check('失败后重试: 判定轮依然极简 (2 tools)', lastToolCount() === 2);

  const ctl = (action) => post('/ctl', JSON.stringify({ action }));

  const cOn1 = await ctl('on');
  check('/ctl on 第一次 ok', cOn1.status === 200 && state.readState().enabled === true);
  const cOn2 = await ctl('on');
  check('/ctl on 重复执行幂等', cOn2.status === 200 && state.readState().enabled === true);
  const cOff = await ctl('off');
  check('/ctl off ok', cOff.status === 200 && state.readState().enabled === false);
  const cArm = await ctl('arm');
  check('/ctl arm 兼容保留 (ok:true)', cArm.status === 200);

  killDaemon();
  upstream.close();

  try { fs.copyFileSync(BACKUP, STATE_PATH); fs.unlinkSync(BACKUP); } catch (e) {}
  if (hadProviders) fs.copyFileSync(PROVIDERS_BAK, state.PROVIDERS_PATH); else { try { fs.unlinkSync(state.PROVIDERS_PATH); } catch (e) {} }
  try { fs.unlinkSync(PROVIDERS_BAK); } catch (e) {}
  try { fs.rmSync(ISOL_DIR, { recursive: true, force: true }); } catch (e) {}

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  try { fs.copyFileSync(BACKUP, STATE_PATH); } catch (e2) {}
  try { if (fs.existsSync(PROVIDERS_BAK)) fs.copyFileSync(PROVIDERS_BAK, state.PROVIDERS_PATH); } catch (e2) {}
  try { fs.rmSync(ISOL_DIR, { recursive: true, force: true }); } catch (e2) {}
  console.error('FATAL', e);
  process.exit(1);
});
