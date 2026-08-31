const http = require('http');
const https = require('https');
const state = require('./lib/state.js');

const config = state.loadConfig();

function resolveTargetBaseUrl() {
  if (config.targetBaseUrl && config.targetBaseUrl !== 'auto') {
    return config.targetBaseUrl;
  }
  const st = state.readState();
  if (st && st.originalUrl && st.originalUrl !== 'env/default') {
    return st.originalUrl;
  }
  if (process.env.ANTHROPIC_UPSTREAM_BASE_URL) {
    return process.env.ANTHROPIC_UPSTREAM_BASE_URL;
  }
  try {
    if (state.PROVIDERS_PATH && require('fs').existsSync(state.PROVIDERS_PATH)) {
      const providersData = JSON.parse(require('fs').readFileSync(state.PROVIDERS_PATH, 'utf8'));
      const activeId = providersData.activeId;
      const activeProvider = (providersData.providers || []).find(p => p.id === activeId);
      if (activeProvider && activeProvider.baseUrl && !activeProvider.baseUrl.includes(`:${config.port}`)) {
        return activeProvider.baseUrl;
      }
    }
  } catch (e) {}
  return 'http://127.0.0.1:20128';
}

let lastActiveTime = Date.now();

setInterval(() => {
  if (config.idleAutoShutdownMinutes > 0) {
    const idleMs = Date.now() - lastActiveTime;
    if (idleMs > config.idleAutoShutdownMinutes * 60 * 1000) {
      const r = state.disableInterception(config);
      state.log(`daemon idle exit; baseUrl restored: ${r.restored || 'n/a'}`);
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

  return hasDeepSeek && (hasV4 || hasPro);
}

function shouldFilterTools(body) {
  if (!body || !body.model) return false;
  if (!isDeepSeekProModel(body.model)) return false;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return false;

  const userMessages = body.messages.filter(m => m.role === 'user');
  const hasToolCalls = body.messages.some(m => m.role === 'tool' || (m.role === 'assistant' && m.tool_calls));

  return (userMessages.length <= 1) && !hasToolCalls;
}

function processRequestBody(rawBody) {
  try {
    const body = JSON.parse(rawBody);

    if (shouldFilterTools(body)) {
      let modified = false;

      if (Array.isArray(body.tools) && body.tools.length > 0) {
        const coreSet = new Set((config.bootstrapCoreTools || []).map(t => t.toLowerCase()));
        body.tools = body.tools.filter(t => {
          const name = (t.function && t.function.name) || t.name || '';
          return coreSet.has(name.toLowerCase());
        });
        modified = true;
      }

      if (config.bootstrapBudget && config.bootstrapBudget > 0) {
        if (body.max_tokens) body.max_tokens = config.bootstrapBudget;
        if (body.max_completion_tokens) body.max_completion_tokens = config.bootstrapBudget;
        modified = true;
      }

      if (modified) {
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

  if (req.url === '/health-check') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  const upstreamBase = resolveTargetBaseUrl();
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
        state.log(`tools filtered: ${req.url}`);
      } else if (config.logDetails) {
        state.log(`passthrough: ${req.url}`);
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
        res.end(JSON.stringify({ error: { message: `we-need-ds 代理异常: ${err.message}` } }));
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
    state.log(`daemon listening on :${config.port}, upstream=${resolveTargetBaseUrl()}`);
  });
}

module.exports = { shouldFilterTools, processRequestBody, config };
