const http = require('http');
const https = require('https');
const state = require('./lib/state.js');

const config = state.loadConfig();

function isSelfProxyUrl(url) {
  if (!url) return false;
  return url.includes(`:${config.port}`) || url.includes('127.0.0.1:20129') || url.includes('localhost:20129');
}

function resolveTargetBaseUrl(req) {
  if (config.targetBaseUrl && config.targetBaseUrl !== 'auto' && !isSelfProxyUrl(config.targetBaseUrl)) {
    return config.targetBaseUrl;
  }

  const authHeader = (req && req.headers && (req.headers['authorization'] || req.headers['x-api-key'])) || '';
  let token = authHeader.replace(/^Bearer\s+/i, '').trim();

  const st = state.readState();
  if (token && st && st.keyMap && st.keyMap[token] && !isSelfProxyUrl(st.keyMap[token])) {
    return st.keyMap[token];
  }

  if (st && st.defaultUpstream && st.defaultUpstream !== 'env/default' && !isSelfProxyUrl(st.defaultUpstream)) {
    return st.defaultUpstream;
  }

  if (process.env.ANTHROPIC_UPSTREAM_BASE_URL && !isSelfProxyUrl(process.env.ANTHROPIC_UPSTREAM_BASE_URL)) {
    return process.env.ANTHROPIC_UPSTREAM_BASE_URL;
  }

  return 'http://127.0.0.1:20128';
}

let lastActiveTime = Date.now();

setInterval(() => {
  if (config.idleAutoShutdownMinutes > 0) {
    const idleMs = Date.now() - lastActiveTime;
    if (idleMs > config.idleAutoShutdownMinutes * 60 * 1000) {
      const r = state.disableInterception(config);
      state.log(`daemon idle exit; baseUrl restored`);
      process.exit(0);
    }
  }
}, 60 * 1000);

function normalizeModelName(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/[-_\s/]/g, '');
}

function findLastIndex(arr, pred) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i;
  }
  return -1;
}

function isDeepSeekProModel(modelName) {
  if (!modelName) return false;
  const raw = modelName.toLowerCase();
  const normalized = normalizeModelName(raw);

  const isConfigured = (config.targetModels || []).some(target => {
    const normTarget = normalizeModelName(target);
    return normalized === normTarget || normalized.endsWith(normTarget) || raw.includes(target.toLowerCase());
  });
  if (isConfigured) return true;

  const hasDeepSeek = normalized.includes('deepseek') || normalized.includes('ds');
  const hasV4 = normalized.includes('v4') || normalized.includes('4pro');
  const hasPro = normalized.includes('pro');
  const hasFlash = normalized.includes('flash');

  return hasDeepSeek && (hasV4 || hasPro || hasFlash);
}

function isArmedCtlFollowup(body) {
  const toolIdx = findLastIndex(body.messages, m => m.role === 'tool');
  if (toolIdx <= 0) return false;
  const prev = body.messages[toolIdx - 1];
  if (!prev || prev.role !== 'assistant' || !Array.isArray(prev.tool_calls)) return false;
  return prev.tool_calls.some(tc => {
    const n = (tc.function && tc.function.name) || tc.name || '';
    return String(n).includes('we-need-ds') || /ctl\.js/.test(JSON.stringify(tc.function && tc.function.arguments || ''));
  });
}

function shouldFilterTools(body, customState = null) {
  if (!body || !body.model) return false;
  if (!isDeepSeekProModel(body.model)) return false;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return false;

  const st = customState || state.readState();
  const lastMsg = body.messages[body.messages.length - 1];

  if (st && state.isArmActive(st)) {
    const isUserTurn = lastMsg && lastMsg.role === 'user';
    const isCtlFollowup = lastMsg && lastMsg.role === 'tool' && isArmedCtlFollowup(body);
    if (isUserTurn || isCtlFollowup) {
      return true;
    }
  }

  const userMessages = body.messages.filter(m => m.role === 'user');
  const hasToolCalls = body.messages.some(m => m.role === 'tool' || (m.role === 'assistant' && m.tool_calls));

  return (userMessages.length <= 1) && !hasToolCalls;
}

function stripPersonaFromSystem(body) {
  const cleaned = [];
  const sysArr = Array.isArray(body.system) ? body.system : (body.system ? [body.system] : []);
  for (const blk of sysArr) {
    const text = typeof blk === 'string' ? blk : (blk && blk.text) || '';
    if (/You are Claude Code|Let me think|think step by step|interactive CLI tool/i.test(text)) continue;
    cleaned.push(blk);
  }
  if (body.system !== undefined) body.system = cleaned;

  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (m.role !== 'system') continue;
      if (typeof m.content === 'string') {
        if (/You are Claude Code|Let me think|think step by step|interactive CLI tool/i.test(m.content)) m.content = '';
      } else if (Array.isArray(m.content)) {
        m.content = m.content.filter(c => !(c && c.type === 'text' && /You are Claude Code|Let me think|think step by step|interactive CLI tool/i.test(c.text || '')));
      }
    }
    body.messages = body.messages.filter(m => !(m.role === 'system' && (m.content === '' || (Array.isArray(m.content) && m.content.length === 0))));
  }
  return body;
}

function processRequestBody(rawBody, customState = null) {
  try {
    const body = JSON.parse(rawBody);

    if (shouldFilterTools(body, customState)) {
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        const coreSet = new Set((config.bootstrapCoreTools || []).map(t => t.toLowerCase()));
        body.tools = body.tools.filter(t => {
          const name = (t.function && t.function.name) || t.name || '';
          return coreSet.has(name.toLowerCase());
        });
      }
      if (config.stripSystemPersona !== false) {
        stripPersonaFromSystem(body);
      }
      return JSON.stringify(body);
    }
    return rawBody;
  } catch (err) {
    return rawBody;
  }
}

const server = http.createServer((req, res) => {
  lastActiveTime = Date.now();

  if (req.url === '/health-check') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  const upstreamBase = resolveTargetBaseUrl(req);
  const targetUrl = new URL(req.url, upstreamBase);
  const isHttps = targetUrl.protocol === 'https:';
  const transport = isHttps ? https : http;

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let outgoingBody = rawBody;

    if (req.method === 'POST' && rawBody) {
      const before = rawBody;
      outgoingBody = processRequestBody(rawBody);
      if (outgoingBody !== before) {
        state.log(`tools filtered: ${req.url} -> upstream: ${upstreamBase}`);
      } else if (config.logDetails) {
        state.log(`passthrough: ${req.url} -> upstream: ${upstreamBase}`);
      }
    }

    const headers = { ...req.headers };
    headers.host = targetUrl.host;
    delete headers['connection'];
    delete headers['keep-alive'];
    delete headers['transfer-encoding'];

    if (req.method === 'POST' && outgoingBody) {
      headers['content-length'] = Buffer.byteLength(outgoingBody);
    }

    const proxyReq = transport.request(targetUrl, {
      method: req.method,
      headers: headers
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `we-need-ds 代理异常 (上游 ${upstreamBase}): ${err.message}` } }));
      }
    });

    if (outgoingBody) {
      proxyReq.write(outgoingBody);
    }
    proxyReq.end();
  });
});

if (require.main === module) {
  server.listen(config.port, '127.0.0.1', () => {
    state.log(`daemon listening on :${config.port}`);
  });
}

module.exports = { shouldFilterTools, processRequestBody, resolveTargetBaseUrl, config };
