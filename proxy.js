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

function isToolFollowup(body) {
  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return false;
  const last = msgs[msgs.length - 1];
  if (last.role === 'tool') return true;
  if (last.role === 'user' && Array.isArray(last.content)) {
    return last.content.some(c => c && c.type === 'tool_result');
  }
  return false;
}

function extractUserText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter(c => c && c.type === 'text').map(c => c.text || '').join('\n');
  }
  return '';
}

const ARM_TRIGGER = /\/we-need-ds\b|we-need-ds[\s\/:：]*(on|开启|武装)/i;

function maybeAutoArm(body) {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) return;
  if (isToolFollowup(body)) return;
  const last = body.messages[body.messages.length - 1];
  if (!last || last.role !== 'user') return;
  const text = extractUserText(last);
  if (!ARM_TRIGGER.test(text)) return;
  state.armForceWindow(config);
  state.log('auto-armed via we-need-ds command text in user turn');
}

function isDecisionTurn(body) {
  const msgs = body.messages;
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'user') return false;
  if (isToolFollowup(body)) return false;
  return true;
}

function shouldFilterTools(body, customState = null) {
  if (!body || !body.model) return false;
  if (!isDeepSeekProModel(body.model)) return false;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return false;
  if (!isDecisionTurn(body)) return false;

  const st = customState || state.readState();
  if (st && state.isArmActive(st)) return true;

  return (body.messages.filter(m => m.role === 'user').length <= 1);
}

const WENEED_GUIDE = [
  'You are a helpful software engineer assistant. We need to follow this style for all internal reasoning (chain-of-thought):',
  'First sentence rule (mandatory, highest priority): the first sentence inside <think> must open with "we need to ..." / "we need ...".',
  'Following sentences keep "we need to ..." / "we need ..." as the core pattern, one concrete action each; interleave I\'ll / I can / I should / I will.',
  'Avoid "let me ...". Prefer "we need to ..." / "we need ..." for opening steps.',
  'Short and colloquial: one sentence per step, decision-level summaries only, we / I perspective.',
  'Classify every task first: build (produce, verify, fix) / fix (read, locate, minimal change, verify) / weak (classify first, then build or fix).',
  'Scope: this shapes reasoning only. Final replies follow the user\'s language and tone. Tool use is allowed and encouraged when needed.'
].join('\n');

function stripPersonaFromSystem(body) {
  const cleaned = [];
  const sysArr = Array.isArray(body.system) ? body.system : (body.system ? [body.system] : []);
  for (const blk of sysArr) {
    const text = typeof blk === 'string' ? blk : (blk && blk.text) || '';
    if (/You are Claude Code|Let me think|think step by step|interactive CLI tool/i.test(text)) continue;
    cleaned.push(blk);
  }
  cleaned.push({ type: 'text', text: WENEED_GUIDE, cache_control: { type: 'ephemeral' } });
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

  if (req.url === '/ctl' && req.method === 'POST') {
    const ctlChunks = [];
    req.on('data', c => ctlChunks.push(c));
    req.on('end', () => {
      let action = '';
      try { action = (JSON.parse(Buffer.concat(ctlChunks).toString('utf8')) || {}).action || ''; } catch (e) {}
      let result;
      if (action === 'on') {
        result = state.enableInterception(config, { arm: true });
        if (result.ok) state.armForceWindow(config);
      } else if (action === 'off') {
        result = state.disableInterception(config);
      } else if (action === 'arm') {
        state.armForceWindow(config);
        result = { ok: true, armed: true };
      } else {
        result = { ok: false, reason: `unknown action: ${action}` };
      }
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      state.log(`ctl ${action} via daemon endpoint -> ok=${result.ok}`);
    });
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
      let parsedBody = null;
      try { parsedBody = JSON.parse(rawBody); } catch (e) {}
      if (parsedBody) maybeAutoArm(parsedBody);

      const st = state.readState();
      const armed = state.isArmActive(st);

      if (armed && parsedBody) {
        if (isToolFollowup(parsedBody)) {
          state.markChainSeen();
          state.log('execution turn during arm window: full tools passthrough');
        } else if (state.isChainSeen(st)) {
          state.consumeArmWindow();
          state.log('new user turn after execution chain: window consumed, passthrough');
        } else {
          const before = rawBody;
          outgoingBody = processRequestBody(rawBody);
          if (outgoingBody !== before) {
            state.log(`decision turn trimmed: ${req.url} -> upstream: ${upstreamBase}`);
          }
        }
      } else {
        const before = rawBody;
        outgoingBody = processRequestBody(rawBody);
        if (outgoingBody !== before) {
          state.log(`first-turn heuristic trimmed: ${req.url} -> upstream: ${upstreamBase}`);
        } else if (config.logDetails) {
          state.log(`passthrough: ${req.url} -> upstream: ${upstreamBase}`);
        }
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

module.exports = { shouldFilterTools, processRequestBody, isDecisionTurn, resolveTargetBaseUrl, config };
