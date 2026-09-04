const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const state = require('./lib/state.js');

let failed = 0;
function check(name, cond, extra) {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`);
}

const STATE_PATH = state.STATE_PATH;
const STATE_BAK = STATE_PATH + '.fulltest-bak';
const CONFIG_PATH = path.join(__dirname, 'config.json');
const CONFIG_BAK = CONFIG_PATH + '.fulltest-bak';
const hadState = fs.existsSync(STATE_PATH);
if (hadState) fs.copyFileSync(STATE_PATH, STATE_BAK);
fs.copyFileSync(CONFIG_PATH, CONFIG_BAK);

const hits = [];
function makeUpstream(port, tag) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let data = '';
      req.on('data', c => data += c);
      req.on('end', () => {
        hits.push({ tag, url: req.url, method: req.method, host: req.headers.host, contentLength: req.headers['content-length'], raw: data });
        if (req.url.includes('/fail')) { res.writeHead(500); res.end('{}'); return; }
        if (req.url.includes('/stream')) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('event: message_start\n\n');
          setTimeout(() => res.write('data: chunk2\n\n'), 50);
          setTimeout(() => res.end('data: [DONE]\n\n'), 120);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function lastHit() { return hits[hits.length - 1]; }
function lastBody() { const h = lastHit(); if (!h || !h.raw) return null; try { return JSON.parse(h.raw); } catch (e) { return null; } }
function lastToolCount() { const b = lastBody(); return b && Array.isArray(b.tools) ? b.tools.length : -1; }
function lastIsDshMinimal() {
  const b = lastBody();
  if (!b) return false;
  if (Array.isArray(b.system)) return b.system.length === 1 && b.system[0].text === 'You are a helpful software engineer assistant.';
  const sysMsg = (b.messages || []).find(m => m.role === 'system');
  return sysMsg && sysMsg.content === 'You are a helpful software engineer assistant.';
}

function post(pathName, bodyStr, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 21329, path: pathName, method: 'POST', headers: { 'content-type': 'application/json', ...(headers || {}) }, timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(bodyStr);
  });
}
function get(pathName) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 21329, path: pathName, method: 'GET', timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function waitProxy() {
  for (let i = 0; i < 25; i++) {
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
function spawnDaemon(extraEnv) {
  spawn(process.execPath, [path.join(__dirname, 'proxy.js')], { detached: true, stdio: 'ignore', env: { ...process.env, ...(extraEnv || {}), WE_NEED_DS_TEST_PORT: '21329' } }).unref();
}

const bashTool = { type: 'function', function: { name: 'Bash', parameters: { type: 'object' } } };
const editTool = { type: 'function', function: { name: 'Edit', parameters: { type: 'object' } } };
const bigTools = [bashTool, editTool, ...Array.from({ length: 28 }, (_, i) => ({ type: 'function', function: { name: 'mcp__tool_' + i } }))];

const ccSystem = [{ type: 'text', text: 'You are Claude Code, an interactive CLI tool' }, { type: 'text', text: 'second persona block' }, { type: 'text', text: 'third persona block' }];
const decisionAnthropic = JSON.stringify({
  model: 'deepseek-v4-pro',
  system: ccSystem,
  messages: [{ role: 'user', content: 'refactor the auth module' }],
  tools: bigTools
});
const execAnthropic = JSON.stringify({
  model: 'deepseek-v4-pro',
  system: ccSystem,
  messages: [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] }
  ],
  tools: bigTools
});
const execOpenAI = JSON.stringify({
  model: 'deepseek-v4-pro',
  messages: [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: 'doing', tool_calls: [{ id: '1', type: 'function', function: { name: 'Bash' } }] },
    { role: 'tool', content: 'out', tool_call_id: '1' }
  ],
  tools: bigTools
});
const geminiBody = JSON.stringify({ model: 'gemini-3.7-flash-ag', messages: [{ role: 'user', content: 'hello' }], tools: bigTools });
const streamDecision = JSON.stringify({
  model: 'deepseek-v4-pro',
  system: ccSystem,
  messages: [{ role: 'user', content: 'plan something big' }],
  tools: bigTools,
  stream: true
});
const openAINoSystem = JSON.stringify({
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'hello' }],
  tools: bigTools
});

async function main() {
  const PROVIDERS_BAK = state.PROVIDERS_PATH + '.fulltest-bak';
  const hadProviders = fs.existsSync(state.PROVIDERS_PATH);
  if (hadProviders) fs.copyFileSync(state.PROVIDERS_PATH, PROVIDERS_BAK);
  try {
    const upstreamMain = await makeUpstream(2099, 'main');
    const upstreamSecond = await makeUpstream(2100, 'second');

    killDaemon();
    await new Promise(r => setTimeout(r, 500));

    console.log('===== Phase A: 核心链路 =====');
    spawnDaemon();
    check('A0 daemon 拉起', await waitProxy());

    state.writeState({
      enabled: true,
      providers: {},
      keyMap: {
        'sk-test-key-a': 'http://127.0.0.1:2099',
        'sk-test-key-b': 'http://127.0.0.1:2100',
        'sk-loop': 'http://127.0.0.1:21329'
      },
      defaultUpstream: 'http://127.0.0.1:2099'
    });

    const hc = await get('/health-check');
    check('A1 /health-check 内部处理 200 不经过上游', hc.status === 200 && JSON.parse(hc.body).status === 'ok' && hits.length === 0);

    await post('/v1/messages', decisionAnthropic, { authorization: 'Bearer sk-test-key-a' });
    check('A2 判定轮 30 工具裁至 2', lastToolCount() === 2);
    check('A3 保留的正是 Bash+Edit 且 schema 原样', JSON.stringify(lastBody().tools) === JSON.stringify([bashTool, editTool]));
    check('A4 Anthropic system 三块替换为 DSH 单行', lastIsDshMinimal());
    check('A5 cache_control 保留', lastBody().system[0].cache_control && lastBody().system[0].cache_control.type === 'ephemeral');
    check('A6 原 CC 人格块全部移除', !JSON.stringify(lastBody()).includes('Claude Code'));
    check('A7 content-length 与实际转发字节一致', parseInt(lastHit().contentLength) === Buffer.byteLength(lastHit().raw));
    check('A8 host 头重写为上游', lastHit().host === '127.0.0.1:2099');
    check('A9 响应体透传', (await post('/v1/messages', decisionAnthropic)).body === '{"ok":true}');

    await post('/v1/messages', execAnthropic, { authorization: 'Bearer sk-test-key-a' });
    check('A10 执行轮 Anthropic: 30 工具全量保留', lastToolCount() === 30 && JSON.stringify(lastBody().tools) === JSON.stringify(bigTools));
    check('A11 执行轮 Anthropic: DSH 人格替换', lastIsDshMinimal());

    await post('/v1/messages', execOpenAI, { authorization: 'Bearer sk-test-key-a' });
    check('A12 执行轮 OpenAI: 30 工具全量保留', lastToolCount() === 30);
    check('A13 执行轮 OpenAI: DSH 人格替换', lastIsDshMinimal());

    await post('/v1/messages', JSON.stringify({
      model: 'deepseek-v4-pro',
      system: ccSystem,
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }, { type: 'text', text: '<system-reminder>token warning</system-reminder>' }] }
      ],
      tools: bigTools
    }), { authorization: 'Bearer sk-test-key-a' });
    check('A14 tool_result+text 混合 → 执行轮不裁 (30)', lastToolCount() === 30);

    await post('/v1/messages', JSON.stringify({
      model: 'deepseek-v4-pro',
      system: ccSystem,
      messages: [
        { role: 'user', content: 'task' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] },
        { role: 'assistant', content: 'done, summary' },
        { role: 'user', content: '<task-notification>background job finished</task-notification>' }
      ],
      tools: bigTools
    }), { authorization: 'Bearer sk-test-key-a' });
    check('A15 后台通知轮 → 判定轮裁至 2', lastToolCount() === 2);

    await post('/v1/messages', geminiBody, { authorization: 'Bearer sk-test-key-a' });
    check('A16 非目标模型字节级透传', lastHit().raw === geminiBody && lastToolCount() === 30);

    await post('/v1/messages', JSON.stringify({ model: 'DeepSeek-V4-Pro-0813', system: ccSystem, messages: [{ role: 'user', content: 'hi' }], tools: bigTools }));
    check('A17 模型名大小写变体命中', lastToolCount() === 2);
    await post('/v1/messages', JSON.stringify({ model: 'deepseek_v4_flash', system: ccSystem, messages: [{ role: 'user', content: 'hi' }], tools: bigTools }));
    check('A18 模型名下划线变体命中', lastToolCount() === 2);

    await post('/v1/messages', openAINoSystem);
    check('A19 M1: 无特征请求 → 顶层 system 字段 (不插非法 system 消息)', Array.isArray(lastBody().system) && lastBody().system[0].text === 'You are a helpful software engineer assistant.' && !lastBody().messages.some(m => m.role === 'system'));
    check('A20 原 user 消息未被破坏', lastBody().messages[0].role === 'user' && lastBody().messages[0].content === 'hello');

    await post('/v1/messages', openAINoSystem, { authorization: 'Bearer sk-test-key-b' });
    check('A21 Bearer Key 动态路由到 second 上游', lastHit().tag === 'second');
    await post('/v1/messages', openAINoSystem, { 'x-api-key': 'sk-test-key-b' });
    check('A22 x-api-Key 同样动态路由', lastHit().tag === 'second');
    await post('/v1/messages', openAINoSystem);
    check('A23 无 Key 走 defaultUpstream', lastHit().tag === 'main');

    await post('/v1/messages', openAINoSystem, { authorization: 'Bearer sk-loop' });
    check('A24 keyMap 指向自身 → 防自环回落 default', lastHit().tag === 'main');
    check('A25 防自环后代理仍存活', await state.isProxyRunning(21329));

    await post('/v1/messages', streamDecision, { authorization: 'Bearer sk-test-key-a' });
    check('A26 判定轮 SSE: 上游收到裁剪后 body', lastToolCount() === 2 && lastIsDshMinimal());

    const sse = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: 21329, path: '/v1/messages/stream', method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 8000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      });
      req.on('error', reject);
      req.end(streamDecision);
    });
    check('A27 SSE 流式完整透传', sse.status === 200 && sse.body.includes('message_start') && sse.body.includes('chunk2') && sse.body.includes('[DONE]'));
    check('A28 SSE content-type 透传', (sse.headers['content-type'] || '').includes('text/event-stream'));

    const failRes = await post('/v1/messages/fail', decisionAnthropic);
    check('A29 上游 5xx 状态码透传', failRes.status === 500);

    await post('/v1/messages', 'not-json{{{', { authorization: 'Bearer sk-test-key-a' });
    check('A30 非法 JSON 原样透传', lastHit().raw === 'not-json{{{');

    await post('/v1/messages', JSON.stringify({ model: 'deepseek-v4-pro', tools: bigTools }));
    check('A31 缺 messages 字段 → 透传不处理', lastHit().raw === JSON.stringify({ model: 'deepseek-v4-pro', tools: bigTools }));

    await post('/v1/messages', JSON.stringify({ model: 'deepseek-v4-pro', system: ccSystem, messages: [{ role: 'user', content: 'hi' }], tools: [] }));
    check('A32 空工具判定轮: 人格替换仍生效', lastBody().tools.length === 0 && lastIsDshMinimal());

    const armRes = await post('/ctl', JSON.stringify({ action: 'arm' }));
    check('A33 /ctl arm 兼容 ok', armRes.status === 200);
    const badRes = await post('/ctl', JSON.stringify({ action: 'bogus' }));
    check('A34 /ctl 未知动作 400', badRes.status === 400);

    killDaemon();

    console.log('===== Phase B: 空闲自毁生命周期 =====');
    const cfg = JSON.parse(fs.readFileSync(CONFIG_BAK, 'utf8'));
    cfg.idleAutoShutdownMinutes = 0.02;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    spawnDaemon();
    check('B1 daemon 二次拉起', await waitProxy());
    await post('/v1/messages', decisionAnthropic);
    check('B2 空闲期请求正常处理', lastToolCount() === 2);
    await new Promise(r => setTimeout(r, 65000));
    check('B3 空闲后 daemon 自毁退出', !(await state.isProxyRunning(21329)));
    check('B4 自毁前执行了还原 (enabled=false)', state.readState().enabled === false);

    console.log('===== Phase C: 上游解析优先级 =====');
    const cfgC = JSON.parse(fs.readFileSync(CONFIG_BAK, 'utf8'));
    cfgC.targetBaseUrl = 'http://127.0.0.1:2099';
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfgC, null, 2));
    state.writeState({ enabled: true, providers: {}, keyMap: {}, defaultUpstream: 'env/default' });
    spawnDaemon();
    check('C1 daemon 三次拉起', await waitProxy());
    await post('/v1/messages', openAINoSystem, { authorization: 'Bearer sk-whatever' });
    check('C2 config.targetBaseUrl 优先级最高', lastHit().tag === 'main');
    killDaemon();
    await new Promise(r => setTimeout(r, 300));

    const cfgC2 = JSON.parse(fs.readFileSync(CONFIG_BAK, 'utf8'));
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfgC2, null, 2));
    spawnDaemon({ ANTHROPIC_UPSTREAM_BASE_URL: 'http://127.0.0.1:2100' });
    check('C3 daemon 四次拉起', await waitProxy());
    await post('/v1/messages', openAINoSystem);
    check('C4 环境变量兜底路由', lastHit().tag === 'second');

    killDaemon();

    console.log('===== Phase D: provider 映射根治 (无硬编码白名单/无9Router错发) =====');
    const provBak = state.PROVIDERS_PATH + '.phaseD-bak';
    const hadProv = fs.existsSync(state.PROVIDERS_PATH);
    if (hadProv) fs.copyFileSync(state.PROVIDERS_PATH, provBak);
    try {
      state.writeState({ enabled: false, providers: {}, keyMap: {}, defaultUpstream: null });
      fs.writeFileSync(state.PROVIDERS_PATH, JSON.stringify({
        activeId: 'd-new-9999',
        providers: [
          { id: 'd-new-9999', name: 'D全新中转', baseUrl: 'https://api.dbrandnew.example', apiKey: 'sk-d-new', models: { a: 'deepseek-v4-pro' } },
          { id: 'd-proxy-orphan', name: 'D孤儿', baseUrl: 'http://127.0.0.1:21329', apiKey: 'sk-d-orphan', models: { a: 'gpt-5' } }
        ]
      }, null, 2));
      const cfgD = state.loadConfig();
      cfgD.port = 21329;
      const rOn = state.enableInterception(cfgD);
      const stD = state.readState();
      const afterOn = JSON.parse(fs.readFileSync(state.PROVIDERS_PATH, 'utf8'));
      check('D1 全新provider真实url正确入账本 (非9Router)', stD.providers['d-new-9999'].originalUrl === 'https://api.dbrandnew.example');
      check('D2 全新provider keyMap正确路由 (非9Router)', stD.keyMap['sk-d-new'] === 'https://api.dbrandnew.example');
      check('D3 全新provider baseUrl改写为代理', afterOn.providers[0].baseUrl.includes('21329'));
      check('D4 已是代理地址且无账本的孤儿被跳过不接管 (不瞎猜9Router)', !stD.providers['d-proxy-orphan']);
      const rOff = state.disableInterception(cfgD);
      const afterOff = JSON.parse(fs.readFileSync(state.PROVIDERS_PATH, 'utf8'));
      check('D5 off还原全新provider为真实url (非9Router)', afterOff.providers[0].baseUrl === 'https://api.dbrandnew.example');
      check('D6 无可信记录的孤儿off时列入unrestorable而非错还原', Array.isArray(rOff.unrestorableList) && rOff.unrestorableList.some(x => x.id === 'd-proxy-orphan'));
    } finally {
      if (hadProv) fs.copyFileSync(provBak, state.PROVIDERS_PATH); else { try { fs.unlinkSync(state.PROVIDERS_PATH); } catch (e) {} }
      try { fs.unlinkSync(provBak); } catch (e) {}
    }

    console.log('===== Phase E: 非DS底线 + M1/M3 边界 (纯函数) =====');
    const { processRequestBody: prbE, isToolFollowup: itf } = require('./proxy.js');
    const nonDsModels = ['claude-3-5-sonnet', 'gpt-5', 'gemini-2.5-flash', 'qwen3.8-max', 'glm-5.3', 'kimi-k3'];
    let nonDsAllPass = true;
    for (const mdl of nonDsModels) {
      const raw = JSON.stringify({ model: mdl, system: [{ type: 'text', text: 'You are Claude Code CLI' }], messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'Bash' }, { name: 'X' }] });
      const out = prbE(raw);
      if (out !== raw || out.includes('helpful software engineer')) { nonDsAllPass = false; console.log(`   ✗ ${mdl} 被修改!`); }
    }
    check('E1 所有非DS模型带CC人格+工具仍字节级原样透传 (安全底线)', nonDsAllPass);

    const anthNoSystem = JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'Bash' }, { name: 'Edit' }, { name: 'X' }] });
    const outAnth = JSON.parse(prbE(anthNoSystem));
    check('E2 M1: Anthropic无system判定轮→用顶层system字段(不插非法system消息)', Array.isArray(outAnth.system) && outAnth.system[0].text === 'You are a helpful software engineer assistant.' && !(outAnth.messages || []).some(m => m.role === 'system'));

    const openAiNoSystem = JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'assistant', content: 'x', tool_calls: [{ id: '1', type: 'function', function: { name: 'Bash' } }] }, { role: 'tool', content: 'out', tool_call_id: '1' }], tools: [{ type: 'function', function: { name: 'Bash' } }] });
    const outOai = JSON.parse(prbE(openAiNoSystem));
    check('E3 M1: OpenAI无system执行轮→插system消息(合法)', (outOai.messages || []).some(m => m.role === 'system' && m.content === 'You are a helpful software engineer assistant.'));

    const mixedTr = { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 't' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'o' }, { type: 'text', text: '<system-reminder>warn</system-reminder>' }] }] };
    check('E4 M3: tool_result+文本混合仍判执行轮(不误砍进行中的工具链)', itf(mixedTr) === true);

    console.log('===== Phase F: A1 URL前缀/路径格式判定 + A2 原子写 + B1 端口变更 =====');
    const { buildTargetUrl, formatFromRequestPath, processRequestBody: prbF } = require('./proxy.js');
    check('F1 A1: baseUrl带/anthropic前缀转发保留前缀', buildTargetUrl('https://api.deepseek.com/anthropic', '/v1/messages').href === 'https://api.deepseek.com/anthropic/v1/messages');
    check('F2 A1: baseUrl无前缀不受影响', buildTargetUrl('https://api.yjs.im', '/v1/chat/completions').href === 'https://api.yjs.im/v1/chat/completions');
    check('F3 A1: query string 保留', buildTargetUrl('https://api.deepseek.com/anthropic', '/v1/messages?stream=1').href === 'https://api.deepseek.com/anthropic/v1/messages?stream=1');
    check('F4 A1: 路径判定 /messages=anthropic /chat/completions=/responses=openai', formatFromRequestPath('/v1/messages') === 'anthropic' && formatFromRequestPath('/v1/chat/completions') === 'openai' && formatFromRequestPath('/v1/responses') === 'openai');
    const oaiBodyAnthPath = JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'x', tool_calls: [{ id: '1', type: 'function', function: { name: 'Bash' } }] }, { role: 'tool', content: 'o', tool_call_id: '1' }], tools: [{ type: 'function', function: { name: 'Bash' } }] });
    const outF5 = JSON.parse(prbF(oaiBodyAnthPath, '/v1/messages'));
    check('F5 A1: 路径=/v1/messages 强制anthropic顶层system(路径强于body特征)', Array.isArray(outF5.system) && !(outF5.messages || []).some(m => m.role === 'system'));
    const plainBodyOaiPath = JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'Bash' } }] });
    const outF6 = JSON.parse(prbF(plainBodyOaiPath, '/v1/chat/completions'));
    check('F6 A1: 路径=/v1/chat/completions 强制openai注入system消息', (outF6.messages || []).some(m => m.role === 'system' && m.content === 'You are a helpful software engineer assistant.'));

    const provBakF = state.PROVIDERS_PATH + '.phaseF-bak';
    const hadProvF = fs.existsSync(state.PROVIDERS_PATH);
    if (hadProvF) fs.copyFileSync(state.PROVIDERS_PATH, provBakF);
    try {
      fs.writeFileSync(state.PROVIDERS_PATH, JSON.stringify({ activeId: 'f1', providers: [{ id: 'f1', name: 'F前缀', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-f', models: { a: 'deepseek-v4-pro' } }] }, null, 2));
      const cfgF = state.loadConfig(); cfgF.port = 21329;
      state.enableInterception(cfgF);
      const afterOn = JSON.parse(fs.readFileSync(state.PROVIDERS_PATH, 'utf8'));
      check('F7 A2: writeProviders 产出合法JSON且无残留tmp', afterOn.providers[0].baseUrl.includes('21329') && !fs.readdirSync(require('path').dirname(state.PROVIDERS_PATH)).some(f => f.startsWith('providers.json.') && f.endsWith('.tmp')));
      state.disableInterception(cfgF);
      const afterOff = JSON.parse(fs.readFileSync(state.PROVIDERS_PATH, 'utf8'));
      check('F8 A1: off还原保留完整前缀URL', afterOff.providers[0].baseUrl === 'https://api.deepseek.com/anthropic');

      state.writeState({ enabled: true, proxyUrl: 'http://127.0.0.1:20329', providers: { f1: { name: 'F前缀', originalUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-f' } }, keyMap: {}, defaultUpstream: null });
      fs.writeFileSync(state.PROVIDERS_PATH, JSON.stringify({ activeId: 'f1', providers: [{ id: 'f1', name: 'F前缀', baseUrl: 'http://127.0.0.1:20329', apiKey: 'sk-f', models: { a: 'deepseek-v4-pro' } }] }, null, 2));
      const cfgF2 = state.loadConfig(); cfgF2.port = 21329;
      state.enableInterception(cfgF2);
      const afterB1 = JSON.parse(fs.readFileSync(state.PROVIDERS_PATH, 'utf8'));
      check('F9 B1: 运行中改端口→旧代理地址provider先还原再按新端口接管(不记成真实上游)', afterB1.providers[0].baseUrl.includes('21329') && state.readState().providers.f1.originalUrl === 'https://api.deepseek.com/anthropic');
    } finally {
      if (hadProvF) fs.copyFileSync(provBakF, state.PROVIDERS_PATH); else { try { fs.unlinkSync(state.PROVIDERS_PATH); } catch (e) {} }
      try { fs.unlinkSync(provBakF); } catch (e) {}
    }

    upstreamMain.close();
    upstreamSecond.close();
  } finally {
    if (hadState) fs.copyFileSync(STATE_BAK, STATE_PATH); else { try { fs.unlinkSync(STATE_PATH); } catch (e) {} }
    try { fs.unlinkSync(STATE_BAK); } catch (e) {}
    fs.copyFileSync(CONFIG_BAK, CONFIG_PATH);
    try { fs.unlinkSync(CONFIG_BAK); } catch (e) {}
    if (hadProviders) fs.copyFileSync(PROVIDERS_BAK, state.PROVIDERS_PATH); else { try { fs.unlinkSync(state.PROVIDERS_PATH); } catch (e) {} }
    try { fs.unlinkSync(PROVIDERS_BAK); } catch (e) {}
    killDaemon();
  }

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  try { if (fs.existsSync(STATE_BAK)) fs.copyFileSync(STATE_BAK, STATE_PATH); } catch (e2) {}
  try { fs.copyFileSync(CONFIG_BAK, CONFIG_PATH); } catch (e2) {}
  try { if (fs.existsSync(PROVIDERS_BAK)) fs.copyFileSync(PROVIDERS_BAK, state.PROVIDERS_PATH); } catch (e2) {}
  killDaemon();
  console.error('FATAL', e);
  process.exit(1);
});
