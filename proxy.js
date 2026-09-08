const http = require('http');
const https = require('https');
const state = require('./lib/state.js');

const config = state.loadConfig();

function isSelfProxyUrl(url) {
  return state.isSelfProxyUrl(url, config.port);
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

  if (token && st && st.providers && Object.keys(st.providers).length > 0) {
    state.log(`resolve blocked: key 未命中 keyMap 且处于接管态，拒绝 defaultUpstream 兜底以避免错发`);
    return null;
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

  const hasDeepSeek = raw.includes('deepseek') || /(^|[-_./\s])ds(?=[-_./\s]|v|\d|$)/.test(raw);
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

const NON_RETRYABLE_NET_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'EACCES', 'EPERM', 'ERR_INVALID_URL', 'ERR_INVALID_ARG_TYPE']);

function isRetryableNetError(err) {
  return !NON_RETRYABLE_NET_CODES.has(err && err.code);
}

function computeBackoffMs(baseBackoff, attempt, retryAfterHeader) {
  let backoff = baseBackoff * Math.pow(2, attempt - 1);
  if (retryAfterHeader) {
    const ra = parseInt(retryAfterHeader, 10);
    if (!isNaN(ra)) {
      const raMs = Math.min(Math.max(ra, 0), 60) * 1000;
      backoff = Math.max(backoff, raMs);
    }
  }
  return Math.min(backoff, 60000);
}

function buildErrorBody(reqUrl, statusCode, message) {
  const fmt = formatFromRequestPath(reqUrl);
  if (fmt === 'openai') {
    return JSON.stringify({ error: { message, type: 'api_error', code: null } });
  }
  return JSON.stringify({ type: 'error', error: { type: 'api_error', message } });
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

function resolveOpenAiStyle(body, format) {
  if (format === 'openai') return true;
  if (format === 'anthropic') return false;
  return body.system === undefined;
}

function applyDshMinimalSystem(body, openAiStyle) {
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.filter(m => m.role !== 'system');
  }
  if (openAiStyle) {
    delete body.system;
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

const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function stripReminderText(text) {
  if (typeof text !== 'string') return text;
  return text.replace(REMINDER_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

function stripSystemReminders(body) {
  if (!Array.isArray(body.messages)) return body;
  for (const m of body.messages) {
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') {
      const stripped = stripReminderText(m.content);
      if (stripped.length > 0) m.content = stripped;
      continue;
    }
    if (Array.isArray(m.content)) {
      const kept = [];
      for (const c of m.content) {
        if (c && c.type === 'text' && typeof c.text === 'string') {
          const stripped = stripReminderText(c.text);
          if (stripped.length > 0) kept.push({ ...c, text: stripped });
        } else {
          kept.push(c);
        }
      }
      if (kept.length > 0) m.content = kept;
    }
  }
  return body;
}

function applyThinkingBudget(body) {
  const budget = config.thinkingBudget;
  if (typeof budget === 'number' && budget > 0) {
    const mt = body.max_tokens;
    if (typeof mt === 'number' && mt > 0 && mt <= budget) {
      return body;
    }
    body.thinking = { type: 'enabled', budget_tokens: budget };
  }
  return body;
}

function processRequestBody(rawBody, reqUrl) {
  try {
    const body = JSON.parse(rawBody);

    const format = formatFromRequestPath(reqUrl);
    const openAiStyle = resolveOpenAiStyle(body, format);
    const isExecution = isToolFollowup(body);
    if (isDeepSeekProModel(body && body.model) && Array.isArray(body && body.messages) && body.messages.length > 0) {
      if (isExecution) {
        if (shouldApplyMinimalPersona(body, true)) {
          applyDshMinimalSystem(body, openAiStyle);
          return JSON.stringify(body);
        }
        return rawBody;
      }
      if (shouldFilterTools(body)) {
        stripSystemReminders(body);
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
          applyDshMinimalSystem(body, openAiStyle);
        }
        if (!openAiStyle) applyThinkingBudget(body);
        return JSON.stringify(body);
      }
      if (shouldApplyMinimalPersona(body, true)) {
        applyDshMinimalSystem(body, openAiStyle);
        return JSON.stringify(body);
      }
    }
    return rawBody;
  } catch (err) {
    return rawBody;
  }
}

function attemptUpstream(transport, targetUrl, method, headers, outgoingBuffer, ctx, headerTimeoutMs, bodyTimeoutMs, idleTimeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let gotFirst = false;
    let proxyRes = null;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(headerTimer);
      clearTimeout(bodyTimer);
      try { if (ctx.proxyReq) ctx.proxyReq.destroy(); } catch (e) {}
      reject(err);
    };
    const succeed = (chunk) => {
      if (settled) return;
      settled = true;
      clearTimeout(headerTimer);
      clearTimeout(bodyTimer);
      resolve({ proxyRes, firstChunk: chunk });
    };

    let bodyTimer = null;
    const headerTimer = setTimeout(() => {
      if (proxyRes) return;
      const err = new Error(`upstream header timeout (${headerTimeoutMs}ms, no response headers)`);
      err.retryable = true;
      fail(err);
    }, headerTimeoutMs);

    const onData = (chunk) => {
      if (gotFirst) return;
      gotFirst = true;
      proxyRes.removeListener('data', onData);
      proxyRes.removeListener('end', onEnd);
      proxyRes.pause();
      succeed(chunk);
    };
    const onEnd = () => {
      if (gotFirst) return;
      gotFirst = true;
      proxyRes.removeListener('data', onData);
      const err = new Error('upstream returned empty body');
      err.retryable = true;
      fail(err);
    };

    const req2 = transport.request(targetUrl, { method, headers }, (res) => {
      proxyRes = res;
      clearTimeout(headerTimer);
      const status = res.statusCode;
      const retryableStatus = status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599);
      if (retryableStatus) {
        gotFirst = true;
        let bodyBuf = Buffer.alloc(0);
        res.on('data', c => { bodyBuf = Buffer.concat([bodyBuf, c]); });
        res.on('end', () => {
          const err = new Error(`upstream ${status}`);
          err.retryable = true;
          err.retryAfter = res.headers['retry-after'];
          err.upstreamResponse = { status, headers: res.headers, body: bodyBuf };
          fail(err);
        });
        return;
      }
      if (method === 'HEAD' || status === 204 || status === 304) {
        succeed(null);
        return;
      }
      const isStreaming = /text\/event-stream/i.test(res.headers['content-type'] || '');
      if (!isStreaming) {
        bodyTimer = setTimeout(() => {
          if (gotFirst) return;
          const err = new Error(`upstream stalled after headers (${bodyTimeoutMs}ms, no body bytes)`);
          err.retryable = true;
          fail(err);
        }, bodyTimeoutMs);
      }
      res.on('data', onData);
      res.on('end', onEnd);
      res.on('error', (e) => {
        if (gotFirst) return;
        gotFirst = true;
        const err = new Error('upstream response error: ' + e.message);
        err.retryable = true;
        fail(err);
      });
    });
    ctx.proxyReq = req2;

    req2.setTimeout(idleTimeoutMs, () => {
      if (settled) { try { req2.destroy(); } catch (e) {} return; }
      const err = new Error(`upstream socket idle timeout (${idleTimeoutMs}ms, no activity)`);
      err.retryable = true;
      fail(err);
    });
    req2.on('error', (e) => {
      const err = new Error('upstream request error: ' + e.message);
      err.code = e.code;
      err.retryable = isRetryableNetError(e);
      fail(err);
    });

    if (outgoingBuffer.length > 0) req2.write(outgoingBuffer);
    req2.end();
  });
}

async function forwardWithRetry(transport, targetUrl, method, headers, outgoingBuffer, res, ctx) {
  const maxRetries = typeof config.upstreamRetries === 'number' ? config.upstreamRetries : 2;
  const baseBackoff = typeof config.upstreamRetryBackoffMs === 'number' ? config.upstreamRetryBackoffMs : 500;
  const headerTimeout = typeof config.upstreamHeaderTimeoutMs === 'number' ? config.upstreamHeaderTimeoutMs : 30000;
  const bodyTimeout = typeof config.upstreamBodyTimeoutMs === 'number' ? config.upstreamBodyTimeoutMs : 30000;
  const idleTimeout = typeof config.upstreamIdleTimeoutMs === 'number' ? config.upstreamIdleTimeoutMs : 600000;
  let attempt = 0;
  while (true) {
    if (ctx.clientGone) {
      state.log(`client gone before attempt ${attempt + 1}, aborting upstream: ${targetUrl.href}`);
      return;
    }
    try {
      const { proxyRes, firstChunk } = await attemptUpstream(transport, targetUrl, method, headers, outgoingBuffer, ctx, headerTimeout, bodyTimeout, idleTimeout);
      if (ctx.clientGone) {
        state.log(`client gone after upstream responded, discarding response: ${targetUrl.href}`);
        try { proxyRes.destroy(); } catch (e) {}
        return;
      }
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      if (firstChunk && firstChunk.length > 0) res.write(firstChunk);
      proxyRes.pipe(res);
      proxyRes.on('error', (err) => {
        state.log(`upstream res error after first byte (transparent disconnect to client): ${targetUrl.href} -> ${err.message}`);
        try { res.destroy(); } catch (e) {}
      });
      proxyRes.on('aborted', () => {
        state.log(`upstream res aborted mid-stream (transparent disconnect to client): ${targetUrl.href}`);
        try { res.destroy(); } catch (e) {}
      });
      if (attempt > 0) state.log(`upstream recovered on attempt ${attempt + 1}: ${targetUrl.href}`);
      return;
    } catch (err) {
      attempt++;
      if (ctx.clientGone) {
        state.log(`client gone after attempt ${attempt} failed, not retrying: ${targetUrl.href}`);
        return;
      }
      if (!err.retryable || attempt > maxRetries) {
        state.log(`upstream failed (attempts=${attempt}, retryable=${!!err.retryable}): ${targetUrl.href} -> ${err.message}`);
        if (res.headersSent) {
          try { res.destroy(); } catch (e) {}
          return;
        }
        if (err.upstreamResponse) {
          const ur = err.upstreamResponse;
          res.writeHead(ur.status, ur.headers);
          res.end(ur.body);
          return;
        }
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(buildErrorBody(ctx.reqUrl, 502, `we-need-ds 上游经 ${attempt} 次尝试仍不可用 (${targetUrl.href}): ${err.message}`));
        return;
      }
      const backoff = computeBackoffMs(baseBackoff, attempt, err.retryAfter);
      state.log(`upstream attempt ${attempt} failed (${err.message}), retry in ${backoff}ms: ${targetUrl.href}`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
}

const server = http.createServer((req, res) => {
  lastActiveTime = Date.now();
  activeRequests++;
  const ctx = { clientGone: false, reqUrl: req.url };
  res.on('close', () => {
    activeRequests--;
    ctx.clientGone = true;
    if (ctx.proxyReq) { try { ctx.proxyReq.destroy(); } catch (e) {} }
  });

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
      let ctlBody = {};
      try { ctlBody = JSON.parse(Buffer.concat(ctlChunks).toString('utf8')) || {}; } catch (e) {}
      action = ctlBody.action || '';
      let result;
      if (action === 'on') {
        result = state.enableInterception(config, { providerId: ctlBody.providerId || null });
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

  if (!/^\/(?!\/)/.test(req.url || '')) {
    state.log(`reject malformed request path: ${JSON.stringify(req.url)}`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(buildErrorBody(req.url, 400, 'we-need-ds 仅接受以单斜杠开头的请求路径'));
    return;
  }

  const upstreamBase = resolveTargetBaseUrl(req);
  if (!upstreamBase) {
    state.log(`resolve fail: ${req.url} 无法确定真实上游（keyMap/defaultUpstream/env 均无），拒绝静默错发`);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(buildErrorBody(req.url, 502, 'we-need-ds 无法确定该请求的真实上游地址（apiKey 未在账本中、且无 defaultUpstream/环境变量兜底），已拒绝以避免错发到其他服务商。请重新开启拦截或检查 provider 配置。'));
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

    res.on('error', (err) => {
      state.log(`client res error: ${req.url} -> ${err.message}`);
      try { if (ctx.proxyReq) ctx.proxyReq.destroy(); } catch (e) {}
    });

    forwardWithRetry(transport, targetUrl, req.method, headers, outgoingBuffer, res, ctx)
      .catch(err => {
        state.log(`forwardWithRetry unexpected: ${req.url} -> ${err && err.message}`);
        if (!res.headersSent) {
          try { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(buildErrorBody(ctx.reqUrl, 502, `we-need-ds 代理异常: ${err.message}`)); } catch (e) {}
        }
      });
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

module.exports = { shouldFilterTools, processRequestBody, isDecisionTurn, isToolFollowup, resolveTargetBaseUrl, formatFromRequestPath, buildTargetUrl, config, computeBackoffMs, isRetryableNetError, buildErrorBody, isDeepSeekProModel };
