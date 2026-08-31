const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const st = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'we-need-ds', 'runtime-state.json'), 'utf8'));
const byName = {};
for (const p of Object.values(st.providers || {})) byName[p.name] = p;

const PROMPT = '为一个日活百万的短视频App设计评论区系统：存储模型、热点计数、审核与防刷分别该怎么设计？请给出完整架构与关键推演。';

const coreTools = ['Bash', 'Edit', 'Read', 'Write'].map(n => ({
  type: 'function',
  function: { name: n, description: n + ' tool', parameters: { type: 'object', properties: {} } }
}));

function request(base, method, apiPath, key, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const mod = u.protocol === 'https:' ? https : require('http');
    const data = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')) + apiPath,
      method,
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      },
      timeout: 180000
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, text: buf }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function chat(label, base, paths, key, model, withTools) {
  const body = { model, messages: [{ role: 'user', content: PROMPT }], stream: false };
  if (withTools) { body.tools = coreTools; body.tool_choice = 'auto'; }
  const t0 = Date.now();
  for (const p of paths) {
    try {
      const r = await request(base, 'POST', p, key, body);
      if (r.status === 404) continue;
      console.log('=== ' + label + ' | ' + p + ' | HTTP ' + r.status + ' | ' + (Date.now() - t0) + 'ms');
      let j = null;
      try { j = JSON.parse(r.text); } catch (e) { console.log('RAW: ' + r.text.slice(0, 400)); return; }
      if (r.status !== 200) { console.log('ERR: ' + JSON.stringify(j).slice(0, 400)); return; }
      console.log('model field: ' + j.model);
      const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
      const rc = msg.reasoning_content || msg.reasoning || '';
      console.log('--- reasoning 开头 500 字 ---');
      console.log(rc ? rc.slice(0, 500) : '(无 reasoning 字段)');
      console.log('--- content 开头 200 字 ---');
      console.log((msg.content || '').slice(0, 200));
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) console.log('tool_calls: ' + msg.tool_calls.map(t => (t.function || {}).name).join(','));
      return;
    } catch (e) {
      console.log('=== ' + label + ' | ' + p + ' | FAILED: ' + e.message);
    }
  }
}

async function listModels(label, base, key) {
  for (const p of ['/models', '/v1/models']) {
    try {
      const r = await request(base, 'GET', p, key, null);
      if (r.status === 200) {
        const j = JSON.parse(r.text);
        const ids = (j.data || j.models || []).map(m => m.id || m.name || m).map(String);
        const ds = ids.filter(i => /deepseek|v4/i.test(i));
        console.log('=== ' + label + ' models (' + p + '): ' + (ds.length ? ds.slice(0, 30).join(', ') : '共' + ids.length + '个,无deepseek/v4相关'));
        return ids;
      }
    } catch (e) {}
  }
  console.log('=== ' + label + ' models: 不可用');
  return [];
}

async function main() {
  const yjs = byName['DSV4-0'] || byName['YJS-高权'];
  const off = byName['DeepSeek'];
  if (!yjs || !off) { console.log('缺少 DSV4-0 或 DeepSeek provider: ' + Object.keys(byName).join(',')); return; }
  const yjsBase = 'https://api.yjs.im';
  const offBase = (off.originalUrl || 'https://api.deepseek.com').replace(/\/anthropic\/?$/, '');
  console.log('对照实验 prompt: ' + PROMPT + '\n');
  const offIds = await listModels('官方DeepSeek', offBase, off.apiKey);
  const yjsIds = await listModels('yjs中转', yjsBase, yjs.apiKey);
  const offModel = offIds.find(i => /v4/i.test(i) && /pro/i.test(i)) || 'deepseek-v4-pro-0813';
  console.log('\n[实验1] 官方裸调 (无工具, 基准组)');
  await chat('官方 bare', offBase, ['/chat/completions', '/v1/chat/completions'], off.apiKey, offModel, false);
  console.log('\n[实验2] yjs 裸调 (无工具, 同题对照)');
  await chat('yjs bare', yjsBase, ['/v1/chat/completions'], yjs.apiKey, 'deepseek-v4-pro-0813', false);
  console.log('\n[实验3] yjs 带4工具 (模拟裁切后形态)');
  await chat('yjs 4tools', yjsBase, ['/v1/chat/completions'], yjs.apiKey, 'deepseek-v4-pro-0813', true);
}

main();
