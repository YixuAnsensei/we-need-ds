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

function post(path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 20129, path, method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode }));
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

const multiTurnBody = JSON.stringify({
  model: 'deepseek-v4-pro',
  messages: [
    { role: 'user', content: 'round 1' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'round 2' }
  ],
  tools: [
    { type: 'function', function: { name: 'Bash' } },
    { type: 'function', function: { name: 'Read' } },
    { type: 'function', function: { name: 'mcp__foo' } },
    { type: 'function', function: { name: 'Workflow' } }
  ]
});

async function main() {
  try { fs.copyFileSync(STATE_PATH, BACKUP); } catch (e) {}

  await new Promise(r => upstream.listen(2099, '127.0.0.1', r));
  killDaemon();
  await new Promise(r => setTimeout(r, 500));

  spawn(process.execPath, [path.join(__dirname, 'proxy.js')], { detached: true, stdio: 'ignore' }).unref();
  check('daemon 拉起', await waitProxy());

  state.writeState({ enabled: true, providers: {}, keyMap: {}, defaultUpstream: 'http://127.0.0.1:2099', forceArmedAt: null, forceNextTurn: false });

  await post('/v1/messages', multiTurnBody);
  check('基线: 无窗口多轮不裁 (4 tools)', lastToolCount() === 4);

  state.armForceWindow({ armWindowMinutes: 20 });
  check('armForceWindow 开窗', state.isArmActive(state.readState()));
  await post('/v1/messages', multiTurnBody);
  check('武装中多轮被裁 (2 tools)', lastToolCount() === 2);
  check('2xx 成功响应消耗窗口', !state.isArmActive(state.readState()));
  await post('/v1/messages', multiTurnBody);
  check('消耗后同请求恢复放行 (4 tools)', lastToolCount() === 4);

  state.armForceWindow({ armWindowMinutes: 20 });
  const r1 = await post('/v1/messages/fail', multiTurnBody);
  check('5xx 返回上游错误码', r1.status === 500);
  check('5xx 失败不消耗窗口', !!state.readState().forceArmedAt);
  await post('/v1/messages', multiTurnBody);
  check('失败后重试依然被裁 (2 tools)', lastToolCount() === 2);
  check('重试成功后窗口消耗', !state.isArmActive(state.readState()));

  state.armForceWindow({ armWindowMinutes: 20 });
  check('consumeArmWindow 有窗返回 true', state.consumeArmWindow() === true);
  check('consumeArmWindow 无窗返回 false', state.consumeArmWindow() === false);

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
