const { shouldFilterTools, processRequestBody, isDecisionTurn } = require('./proxy.js');

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

function hasGuide(bodyStr) {
  const b = JSON.parse(bodyStr);
  const sys = Array.isArray(b.system) ? b.system : [];
  return sys.some(s => s && s.text && s.text.includes('we need to'));
}

const armedState = () => ({ forceArmedAt: new Date().toISOString(), armWindowMinutes: 20 });
const staleState = () => ({ forceArmedAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(), armWindowMinutes: 20 });

const cases = [
  {
    name: 'DS Pro 首轮标准名 (预期裁切至 4 + 注入引导)',
    body: { model: 'deepseek-v4-pro-0813', messages: [{ role: 'user', content: 'hello' }], tools: allTools, system: [{ type: 'text', text: 'You are Claude Code, an interactive CLI tool' }] },
    customState: null,
    expectFiltered: true,
    expectGuide: true
  },
  {
    name: 'DS Flash 首轮 (预期裁切至 4)',
    body: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }], tools: allTools },
    customState: null,
    expectFiltered: true,
    expectGuide: false
  },
  {
    name: 'DS Pro 变体 deepseek_v4_pro (预期裁切至 4)',
    body: { model: 'deepseek_v4_pro', messages: [{ role: 'user', content: 'hello' }], tools: allTools },
    customState: null,
    expectFiltered: true,
    expectGuide: false
  },
  {
    name: '非目标模型 Gemini (预期透传 8)',
    body: { model: 'Gemini-3.7-flash-ag', messages: [{ role: 'user', content: 'hello' }], tools: allTools },
    customState: null,
    expectFiltered: false,
    expectGuide: false
  },
  {
    name: '武装 + 新任务轮 (判定轮裁切至 4)',
    body: {
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: 'round 1' },
        { role: 'assistant', content: 'reply 1' },
        { role: 'user', content: 'round 2: start new task now' }
      ],
      tools: allTools
    },
    customState: armedState(),
    expectFiltered: true,
    expectGuide: false
  },
  {
    name: '武装 + 工具续跑轮 (执行轮全量放行 8)',
    body: {
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: 'task' },
        { role: 'assistant', content: 'doing', tool_calls: [{ id: '1', type: 'function', function: { name: 'Bash' } }] },
        { role: 'tool', content: 'out', tool_call_id: '1' }
      ],
      tools: allTools
    },
    customState: armedState(),
    expectFiltered: false,
    expectGuide: false
  },
  {
    name: '武装 + Anthropic 格式 tool_result 续跑轮 (执行轮全量放行 8)',
    body: {
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: 'task' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] }
      ],
      tools: allTools
    },
    customState: armedState(),
    expectFiltered: false,
    expectGuide: false
  },
  {
    name: '武装 + 多轮执行链中途 (全量放行 8)',
    body: {
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: 'task' },
        { role: 'assistant', content: 'thinking', tool_calls: [{ id: '1', type: 'function', function: { name: 'Bash' } }] },
        { role: 'tool', content: 'out', tool_call_id: '1' },
        { role: 'assistant', content: 'thinking 2', tool_calls: [{ id: '2', type: 'function', function: { name: 'Read' } }] },
        { role: 'tool', content: 'out 2', tool_call_id: '2' }
      ],
      tools: allTools
    },
    customState: armedState(),
    expectFiltered: false,
    expectGuide: false
  },
  {
    name: '无武装 + 长会话新任务轮 (预期透传 8)',
    body: {
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: 'round 1' },
        { role: 'assistant', content: 'reply 1' },
        { role: 'user', content: 'round 2' }
      ],
      tools: allTools
    },
    customState: { forceArmedAt: null },
    expectFiltered: false,
    expectGuide: false
  },
  {
    name: '武装窗口已过期 (预期透传 8)',
    body: {
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: 'round 1' },
        { role: 'assistant', content: 'reply 1' },
        { role: 'user', content: 'round 2' }
      ],
      tools: allTools
    },
    customState: staleState(),
    expectFiltered: false,
    expectGuide: false
  },
  {
    name: 'isDecisionTurn: tool_result 续跑轮 = false',
    body: {
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: 'task' },
        { role: 'assistant', content: 'doing', tool_calls: [{ id: '1', type: 'function', function: { name: 'Bash' } }] },
        { role: 'tool', content: 'out', tool_call_id: '1' }
      ]
    },
    check: () => !isDecisionTurn({
      messages: [
        { role: 'user', content: 'task' },
        { role: 'assistant', content: 'doing', tool_calls: [{ id: '1', type: 'function', function: { name: 'Bash' } }] },
        { role: 'tool', content: 'out', tool_call_id: '1' }
      ]
    })
  }
];

let failed = 0;
for (const c of cases) {
  let ok;
  if (c.check) {
    ok = c.check();
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${c.name}`);
    continue;
  }
  const orig = JSON.stringify(c.body);
  const out = processRequestBody(orig, c.customState);
  const filtered = out !== orig;
  const parsed = JSON.parse(out);
  const count = (parsed.tools || []).length;
  const guide = hasGuide(out);
  const expectCount = c.expectFiltered ? 4 : 8;
  ok = filtered === c.expectFiltered && count === expectCount && (!c.expectGuide || guide);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${c.name} | 裁切=${filtered} 剩余工具=${count} (预期 ${expectCount})${c.expectGuide ? ` 引导注入=${guide}` : ''}`);
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
