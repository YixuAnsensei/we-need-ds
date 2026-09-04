const http = require('http');
const https = require('https');
const state = require('./lib/state.js');

const config = state.loadConfig();

function isSelfProxyUrl(url) {
  if (!url) return false;
  return url.includes(`:${config.port}`) || url.includes(`:${config.port}/`) || url.includes('127.0.0.1:20329') || url.includes('localhost:20329');
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

  return null;
}

let lastActiveTime = Date.now();
let activeRequests = 0;

setInterval(() => {
  if (config.idleAutoShutdownMinutes > 0) {
    if (activeRequests > 0) return;
    const idleMs = Date.now() - lastActiveTime;
    if (idleMs > config.idleAutoShutdownMinutes * 60 * 1000) {
      const r = state.disableInterception(config);
      const n = (r && r.restoredList && r.restoredList.length) || 0;
      state.log(`daemon idle exit after ${config.idleAutoShutdownMinutes}min: restored ${n} providers, next new message will auto-revive`);
      process.exit(0);
    }
  }
}, 60 * 1000);

function normalizeModelName(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/[-_\s/]/g, '');
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

function isDecisionTurn(body) {
  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return false;
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'user') return false;
  if (isToolFollowup(body)) return false;
  return true;
}

function shouldFilterTools(body) {
  if (!body || !body.model) return false;
  if (!isDeepSeekProModel(body.model)) return false;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return false;
  return isDecisionTurn(body);
}

const DSH_MINIMAL_PROMPT = 'You are a helpful software engineer assistant.';

function isOpenAiStyle(body) {
  if (!Array.isArray(body.messages)) return false;
  return body.messages.some(m => {
    if (m.role === 'system') return true;
    if (m.role === 'tool') return true;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) return true;
    return false;
  });
}

function formatFromRequestPath(reqUrl) {
  if (!reqUrl) return null;
  const p = reqUrl.split('?')[0].toLowerCase();
  if (p.includes('/messages')) return 'anthropic';
  if (p.includes('/chat/completions') || p.includes('/responses') || p.includes('/completions')) return 'openai';
  return null;
}

function buildTargetUrl(upstreamBase, reqUrl) {
  const base = new URL(upstreamBase);
  const basePath = base.pathname.replace(/\/+$/, '');
  return new URL(basePath + reqUrl, base.origin);
}

function applyDshMinimalSystem(body, format) {
  let openAiStyle;
  if (format === 'openai') openAiStyle = true;
  else if (format === 'anthropic') openAiStyle = false;
  else openAiStyle = body.system === undefined && isOpenAiStyle(body);
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.filter(m => m.role !== 'system');
  }
  if (openAiStyle) {
    body.messages = [{ role: 'system', content: DSH_MINIMAL_PROMPT }, ...(body.messages || [])];
  } else {
    body.system = [{ type: 'text', text: DSH_MINIMAL_PROMPT, cache_control: { type: 'ephemeral' } }];
  }
  return body;
}

function shouldApplyMinimalPersona(body, isExecution) {
  if (config.stripSystemPersona === false) return false;
  if (!isExecution) return true;
  return config.executionDshPersona !== false;
}

function collectUsedToolNames(messages) {
  const used = new Set();
  if (!Array.isArray(messages)) return used;
  for (const m of messages) {
    if (m && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c && c.type === 'tool_use' && c.name) used.add(c.name.toLowerCase());
      }
    }
    if (m && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const n = tc && tc.function && tc.function.name;
        if (n) used.add(n.toLowerCase());
      }
    }
  }
  return used;
}

function applyThinkingBudget(body) {
  const budget = config.thinkingBudget;
  if (typeof budget === 'number' && budget > 0) {
    body.thinking = { type: 'enabled', budget_tokens: budget };
  }
  return body;
}

function processRequestBody(rawBody, reqUrl) {
  try {
    const body = JSON.parse(rawBody);

    const format = formatFromRequestPath(reqUrl);
    const isExecution = isToolFollowup(body);
    if (isDeepSeekProModel(body && body.model) && Array.isArray(body && body.messages) && body.messages.length > 0) {
      if (isExecution) {
          if (shouldApplyMinimalPersona(body, true)) {
            applyDshMinimalSystem(body, format);
          return JSON.stringify(body);
        }
        return rawBody;
      }
      if (shouldFilterTools(body)) {
        if (Array.isArray(body.tools) && body.tools.length > 0) {
          const coreSet = new Set((config.bootstrapCoreTools || []).map(t => t.toLowerCase()));
          const usedNames = collectUsedToolNames(body.messages);
          body.tools = body.tools.filter(t => {
            const name = (t.function && t.function.name) || t.name || '';
            const lower = name.toLowerCase();
            return coreSet.has(lower) || usedNames.has(lower);
          });
        }
        if (shouldApplyMinimalPersona(body, false)) {
          applyDshMinimalSystem(body, format);
        }
        applyThinkingBudget(body);
        return JSON.stringify(body);
      }
    }
    return rawBody;
  } catch (err) {
    return rawBody;
  }
}

const server = http.createServer((req, res) => {
  lastActiveTime = Date.now();
  activeRequests++;
  res.on('close', () => { activeRequests--; });

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
      } else if (action === 'off') {
        result = state.disableInterception(config);
      } else if (action === 'arm') {
        result = { ok: true, armed: true, note: 'v5: trimming is per-turn structural, no arm window needed' };
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
  if (!upstreamBase) {
    state.log(`resolve fail: ${req.url} 无法确定真实上游（keyMap/defaultUpstream/env 均无），拒绝静默错发`);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'we-need-ds 无法确定该请求的真实上游地址（apiKey 未在账本中、且无 defaultUpstream/环境变量兜底），已拒绝以避免错发到其他服务商。请重新开启拦截或检查 provider 配置。' } }));
    return;
  }
  const targetUrl = buildTargetUrl(upstreamBase, req.url);
  const isHttps = targetUrl.protocol === 'https:';
  const transport = isHttps ? https : http;

  const chunks = [];
  req.on('error', (err) => {
    state.log(`client req error: ${req.url} -> ${err.message}`);
    if (!res.headersSent) { try { res.writeHead(400); res.end(); } catch (e) {} }
  });
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const rawBuffer = Buffer.concat(chunks);
    let outgoingBuffer = rawBuffer;

    const contentEncoding = (req.headers['content-encoding'] || '').toLowerCase();
    const isCompressed = contentEncoding && contentEncoding !== 'identity';

    if (req.method === 'POST' && rawBuffer.length > 0 && !isCompressed) {
      const rawBody = rawBuffer.toString('utf8');
      const processed = processRequestBody(rawBody, req.url);
      if (processed !== rawBody) {
        outgoingBuffer = Buffer.from(processed, 'utf8');
        state.log(`decision turn DSH-minimal: ${req.url} -> upstream: ${upstreamBase}`);
      } else if (config.logDetails) {
        state.log(`passthrough: ${req.url} -> upstream: ${upstreamBase}`);
      }
    }

    const headers = { ...req.headers };
    headers.host = targetUrl.host;
    delete headers['connection'];
    delete headers['keep-alive'];
    delete headers['transfer-encoding'];

    if (req.method === 'POST' && outgoingBuffer.length > 0) {
      headers['content-length'] = outgoingBuffer.length;
    }

    const proxyReq = transport.request(targetUrl, {
      method: req.method,
      headers: headers
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      proxyRes.on('error', (err) => {
        state.log(`upstream res error: ${upstreamBase}${req.url} -> ${err.message}`);
        try { res.destroy(); } catch (e) {}
      });
    });

    proxyReq.setTimeout(120000, () => {
      state.log(`upstream timeout: ${upstreamBase}${req.url}`);
      proxyReq.destroy(new Error('upstream timeout after 120s'));
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `we-need-ds 代理异常 (上游 ${upstreamBase}): ${err.message}` } }));
      } else {
        try { res.destroy(); } catch (e) {}
      }
    });

    res.on('error', (err) => {
      state.log(`client res error: ${req.url} -> ${err.message}`);
      try { proxyReq.destroy(); } catch (e) {}
    });

    if (outgoingBuffer.length > 0) {
      proxyReq.write(outgoingBuffer);
    }
    proxyReq.end();
  });
});

if (require.main === module) {
  process.on('uncaughtException', (err) => {
    state.log(`uncaughtException (daemon survives): ${err && err.stack ? err.stack : err}`);
  });
  process.on('unhandledRejection', (reason) => {
    state.log(`unhandledRejection (daemon survives): ${reason && reason.stack ? reason.stack : reason}`);
  });
  server.on('error', (err) => {
    state.log(`server error: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      state.log(`端口 ${config.port} 被占用，daemon 无法启动`);
      process.exit(1);
    }
  });
  server.on('clientError', (err, socket) => {
    state.log(`clientError: ${err.message}`);
    try { socket.destroy(); } catch (e) {}
  });
  server.listen(config.port, '127.0.0.1', () => {
    state.log(`daemon listening on :${config.port}`);
  });
}

module.exports = { shouldFilterTools, processRequestBody, isDecisionTurn, isToolFollowup, resolveTargetBaseUrl, formatFromRequestPath, buildTargetUrl, config };
