const { shouldFilterTools, processRequestBody } = require('./proxy.js');

const allTools = [
  { type: 'function', function: { name: 'Bash' } },
  { type: 'function', function: { name: 'Read' } },
  { type: 'function', function: { name: 'Edit' } },
  { type: 'function', function: { name: 'Write' } },
  { type: 'function', function: { name: 'mcp__brave_search' } },
  { type: 'function', function: { name: 'mcp__postgres_query' } },
  { type: 'function', function: { name: 'Skill' } },
  { type: 'function', function: { name: 'Workflow' } }
];

function toolCount(bodyStr) {
  return JSON.parse(bodyStr).tools.length;
}

const cases = [
  {
    name: 'DS Pro 首轮标准名 (预期裁切至 4)',
    body: { model: 'deepseek-v4-pro-0813', messages: [{ role: 'user', content: 'hello' }], tools: allTools },
    expectFiltered: true
  },
  {
    name: 'DS Pro 下划线变体 deepseek_v4_pro (预期裁切至 4)',
    body: { model: 'deepseek_v4_pro', messages: [{ role: 'user', content: 'hello' }], tools: allTools },
    expectFiltered: true
  },
  {
    name: 'DS Pro 空格变体 "DeepSeek V4 Pro" (预期裁切至 4)',
    body: { model: 'DeepSeek V4 Pro', messages: [{ role: 'user', content: 'hello' }], tools: allTools },
    expectFiltered: true
  },
  {
    name: 'DS Pro 无分隔符 deepseekv4pro (预期裁切至 4)',
    body: { model: 'deepseekv4pro', messages: [{ role: 'user', content: 'hello' }], tools: allTools },
    expectFiltered: true
  },
  {
    name: 'DS Pro 路径前缀 models/deepseek-ai/deepseek-v4-pro (预期裁切至 4)',
    body: { model: 'models/deepseek-ai/deepseek-v4-pro', messages: [{ role: 'user', content: 'hello' }], tools: allTools },
    expectFiltered: true
  },
  {
    name: 'DS Pro 第二轮 (预期全量放行 8)',
    body: {
      model: 'deepseek-v4-pro-0813',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'Hi', tool_calls: [{ id: '1', type: 'function', function: { name: 'Bash' } }] },
        { role: 'tool', content: 'file list', tool_call_id: '1' }
      ],
      tools: allTools
    },
    expectFiltered: false
  },
  {
    name: '非目标模型 Gemini (预期透传 8)',
    body: { model: 'Gemini-3.7-flash-ag', messages: [{ role: 'user', content: 'hello' }], tools: allTools },
    expectFiltered: false
  },
  {
    name: '非目标模型 Claude (预期透传 8)',
    body: { model: 'claude-3-7-sonnet', messages: [{ role: 'user', content: 'hello' }], tools: allTools },
    expectFiltered: false
  },
  {
    name: '目标模型但两条 user 消息 (预期透传)',
    body: { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }], tools: allTools },
    expectFiltered: false
  }
];

let failed = 0;
for (const c of cases) {
  const out = processRequestBody(JSON.stringify(c.body));
  const filtered = out !== JSON.stringify(c.body);
  const parsed = JSON.parse(out);
  const count = (parsed.tools || []).length;
  const expectCount = c.expectFiltered ? 4 : 8;
  const ok = filtered === c.expectFiltered && count === expectCount;

  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${c.name} | 裁切=${filtered} 剩余工具=${count} (预期 ${expectCount})`);
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
