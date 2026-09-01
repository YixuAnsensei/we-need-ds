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

function isDshMinimalSystem(bodyStr) {
  const b = JSON.parse(bodyStr);
  if (Array.isArray(b.system)) {
    return b.system.length === 1 && b.system[0].text === 'You are a helpful software engineer assistant.';
  }
  const sysMsg = (b.messages || []).find(m => m.role === 'system');
  return sysMsg && sysMsg.content === 'You are a helpful software engineer assistant.';
}

const decisionBody = {
  model: 'deepseek-v4-pro',
  messages: [
    { role: 'user', content: 'round 1' },
    { role: 'assistant', content: 'reply 1' },
    { role: 'user', content: 'round 2: start new task now' }
  ],
  tools: allTools,
  system: [{ type: 'text', text: 'You are Claude Code, an interactive CLI tool' }]
};

const executionBody = {
  model: 'deepseek-v4-pro',
  messages: [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: 'doing', tool_calls: [{ id: '1', type: 'function', function: { name: 'Bash' } }] },
    { role: 'tool', content: 'out', tool_call_id: '1' }
  ],
  tools: allTools
};

const anthropicExecutionBody = {
  model: 'deepseek-v4-pro',
  messages: [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] }
  ],
  tools: allTools
};

const cases = [
  {
    name: 'DS Pro 长会话判定轮 (裁至 2 + DSH 单行提示词)',
    body: decisionBody,
    expectFiltered: true,
    expectMinimal: true,
    expectCount: 2
  },
  {
    name: 'DS Pro 首轮 (同样是判定轮，裁至 2)',
    body: { model: 'deepseek-v4-pro-0813', messages: [{ role: 'user', content: 'hello' }], tools: allTools, system: [{ type: 'text', text: 'You are Claude Code, an interactive CLI tool' }] },
    expectFiltered: true,
    expectMinimal: true,
    expectCount: 2
  },
  {
    name: 'DS Flash 判定轮 (裁至 2)',
    body: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }], tools: allTools },
    expectFiltered: true,
    expectMinimal: true,
    expectCount: 2
  },
  {
    name: '非目标模型 Gemini (透传 8)',
    body: { model: 'Gemini-3.7-flash-ag', messages: [{ role: 'user', content: 'hello' }], tools: allTools },
    expectFiltered: false,
    expectCount: 8
  },
  {
    name: '判定轮保留 Bash+Edit (DSH 两件套映射)',
    check: () => {
      const out = JSON.parse(processRequestBody(JSON.stringify(decisionBody)));
      const names = (out.tools || []).map(t => (t.function && t.function.name) || t.name).sort();
      return JSON.stringify(names) === JSON.stringify(['Bash', 'Edit']);
    }
  },
  {
    name: 'DSH 单行提示词替换整个人格 (非拼接)',
    check: () => {
      const out = JSON.parse(processRequestBody(JSON.stringify(decisionBody)));
      return Array.isArray(out.system) && out.system.length === 1 && !JSON.stringify(out.system).includes('Claude Code');
    }
  },
  {
    name: 'OpenAI 格式 (无 system 字段) 注入 system 消息',
    check: () => {
      const body = { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }], tools: allTools };
      const out = JSON.parse(processRequestBody(JSON.stringify(body)));
      return out.messages[0].role === 'system' && out.messages[0].content === 'You are a helpful software engineer assistant.';
    }
  },
  {
    name: '执行轮 OpenAI 格式 (tool 结尾, 透传 8)',
    body: executionBody,
    expectFiltered: false,
    expectCount: 8
  },
  {
    name: '执行轮 Anthropic 格式 (tool_result, 透传 8)',
    body: anthropicExecutionBody,
    expectFiltered: false,
    expectCount: 8
  },
  {
    name: '多轮执行链中途 (透传 8)',
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
    expectFiltered: false,
    expectCount: 8
  },
  {
    name: 'isDecisionTurn: tool_result 续跑轮 = false',
    check: () => !isDecisionTurn(anthropicExecutionBody)
  },
  {
    name: 'isDecisionTurn: 长会话新用户轮 = true (v5 常态极简关键)',
    check: () => isDecisionTurn(decisionBody)
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
  const out = processRequestBody(orig);
  const filtered = out !== orig;
  const parsed = JSON.parse(out);
  const count = (parsed.tools || []).length;
  const minimal = isDshMinimalSystem(out);
  ok = filtered === c.expectFiltered && count === c.expectCount && (!c.expectMinimal || minimal);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${c.name} | 裁切=${filtered} 剩余工具=${count} (预期 ${c.expectCount})${c.expectMinimal ? ` DSH提示词=${minimal}` : ''}`);
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
