const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
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

function lastToolCount() {
  const b = seenBodies[seenBodies.length - 1];
  return b && Array.isArray(b.tools) ? b.tools.length : -1;
}

function post(pathName, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 20129, path: pathName, method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 5000 }, (res) => {
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
    if (await state.isProxyRunning(20129)) return true;
  }
  return false;
}

function killDaemon() {
  try {
    const out = execSync('powershell -Command "(Get-NetTCPConnection -LocalPort 20129 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"').toString().trim();
    if (/^\d+$/.test(out)) { try { execSync(`taskkill /F /PID ${out}`); } catch (e) {} }
  } catch (e) {}
}

const tools4 = [
  { type: 'function', function: { name: 'Bash' } },
  { type: 'function', function: { name: 'Read' } },
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
const autoArmBody = JSON.stringify({
  model: 'deepseek-v4-pro',
  messages: [
    { role: 'user', content: 'earlier chat' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: '/we-need-ds 开启 然后执行任务X' }
  ],
  tools: tools4
});

async function main() {
  try { fs.copyFileSync(STATE_PATH, BACKUP); } catch (e) {}

  await new Promise(r => upstream.listen(2099, '127.0.0.1', r));
  killDaemon();
  await new Promise(r => setTimeout(r, 500));

  spawn(process.execPath, [path.join(__dirname, 'proxy.js')], { detached: true, stdio: 'ignore' }).unref();
  check('daemon 拉起', await waitProxy());

  state.writeState({ enabled: true, providers: {}, keyMap: {}, defaultUpstream: 'http://127.0.0.1:2099', forceArmedAt: null, chainSeen: false });

  await post('/v1/messages', multiTurnBody);
  check('基线: 无窗口多轮不裁 (4 tools)', lastToolCount() === 4);

  await post('/v1/messages', singleTurnBody);
  check('首轮启发式: 单用户轮裁切 (2 tools)', lastToolCount() === 2);

  state.armForceWindow({ armWindowMinutes: 20 });
  await post('/v1/messages', multiTurnBody);
  check('武装后首个判定轮裁切 (2 tools)', lastToolCount() === 2);

  await post('/v1/messages', toolFollowupBody);
  check('执行轮全量放行 (4 tools)', lastToolCount() === 4);
  check('执行轮标记 chainSeen', state.isChainSeen(state.readState()));
  check('窗口保持开放', state.isArmActive(state.readState()));

  await post('/v1/messages', toolFollowupBody);
  check('执行链中途继续全量放行 (4 tools)', lastToolCount() === 4);
  check('窗口仍开放', state.isArmActive(state.readState()));

  await post('/v1/messages', multiTurnBody);
  check('执行链结束后新用户轮: 窗口消耗', !state.isArmActive(state.readState()));
  check('消耗后不裁 (4 tools)', lastToolCount() === 4);
  check('chainSeen 已重置', !state.isChainSeen(state.readState()));

  state.armForceWindow({ armWindowMinutes: 20 });
  const r1 = await post('/v1/messages/fail', multiTurnBody);
  check('5xx 返回上游错误码', r1.status === 500);
  check('5xx 不消耗窗口', state.isArmActive(state.readState()));
  await post('/v1/messages', multiTurnBody);
  check('失败重试: 判定轮依然裁切 (2 tools)', lastToolCount() === 2);

  state.consumeArmWindow();

  await post('/v1/messages', autoArmBody);
  check('auto-arm: /we-need-ds 指令轮同请求被裁 (2 tools)', lastToolCount() === 2);
  check('auto-arm: 窗口已开启', state.isArmActive(state.readState()));
  state.consumeArmWindow();

  check('consumeArmWindow 无窗返回 false', state.consumeArmWindow() === false);

  const ctl = (action) => post('/ctl', JSON.stringify({ action }));

  const cArm = await ctl('arm');
  check('/ctl arm 可达且 ok', cArm.status === 200 && state.isArmActive(state.readState()));
  state.consumeArmWindow();

  const cOn1 = await ctl('on');
  check('/ctl on 第一次 ok', cOn1.status === 200 && state.readState().enabled === true);
  const cOn2 = await ctl('on');
  check('/ctl on 重复执行幂等', cOn2.status === 200 && state.readState().enabled === true);
  const cOff = await ctl('off');
  check('/ctl off ok 且窗口清除', cOff.status === 200 && state.readState().enabled === false && !state.isArmActive(state.readState()));

  killDaemon();
  upstream.close();

  try { fs.copyFileSync(BACKUP, STATE_PATH); fs.unlinkSync(BACKUP); } catch (e) {}

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  try { fs.copyFileSync(BACKUP, STATE_PATH); } catch (e2) {}
  console.error('FATAL', e);
  process.exit(1);
});
