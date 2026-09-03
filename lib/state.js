const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const HOME_DIR = process.env.USERPROFILE || process.env.HOME || os.homedir();
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const PROVIDERS_PATH = path.join(HOME_DIR, '.claude', 'cc-haha', 'providers.json');
const DATA_DIR = path.join(HOME_DIR, '.claude', 'we-need-ds');
const LOG_PATH = path.join(DATA_DIR, 'we-need-ds.log');
const STATE_PATH = path.join(DATA_DIR, 'runtime-state.json');
const LEGACY_STATE_PATH = path.join(__dirname, '..', 'runtime-state.json');
const LEGACY_LOG_PATH = path.join(__dirname, '..', 'we-need-ds.log');

try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {}

function migrateLegacyFiles() {
  const candidates = [LEGACY_STATE_PATH, path.join(HOME_DIR, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'we-need-ds', '1.0.0', 'runtime-state.json'), path.join(HOME_DIR, '.claude', 'plugins', 'marketplaces', 'claude-plugins-official', 'plugins', 'we-need-ds', 'runtime-state.json')];
  let best = null;
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      const ts = data && data.ts ? Date.parse(data.ts) : 0;
      if (!best || ts > best.ts) best = { p, data, ts };
    } catch (e) {}
  }
  if (best && best.ts > 0) {
    const cur = readState();
    const curTs = cur && cur.ts ? Date.parse(cur.ts) : 0;
    if (best.ts >= curTs && Object.keys(best.data.providers || {}).length > 0) {
      writeState(best.data);
    }
    for (const p of candidates) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
    }
    log(`migrated runtime-state from ${best.p}`);
  }
}

function migrateLegacyLog() {
  if (fs.existsSync(LOG_PATH)) return;
  try { if (fs.existsSync(LEGACY_LOG_PATH)) fs.copyFileSync(LEGACY_LOG_PATH, LOG_PATH); } catch (e) {}
}

function loadConfig() {
  let config = {
    port: 20329,
    targetBaseUrl: 'auto',
    targetModels: ['deepseek-v4-pro-0813', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-0731'],
    bootstrapCoreTools: ['Bash', 'Edit'],
    logDetails: false,
    idleAutoShutdownMinutes: 0
  };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    }
  } catch (e) {}
  if (process.env.WE_NEED_DS_TEST_PORT) {
    config.port = parseInt(process.env.WE_NEED_DS_TEST_PORT, 10);
  }
  return config;
}

function log(msg) {
  try {
    const ts = new Date().toISOString();
    fs.appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`);
  } catch (e) {}
}

function isProxyRunning(port) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: '/health-check',
      method: 'GET',
      timeout: 2000
    }, (res) => {
      const ok = res.statusCode === 200;
      res.resume();
      resolve(ok);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function hasCcHahaProviders() {
  return fs.existsSync(PROVIDERS_PATH);
}

function readProviders() {
  if (!hasCcHahaProviders()) return null;
  try {
    return JSON.parse(fs.readFileSync(PROVIDERS_PATH, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeProviders(data) {
  if (!data || !hasCcHahaProviders()) return;
  fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function providerHasTargetModels(provider, targetModels) {
  if (!provider || !provider.models) return false;
  const models = Object.values(provider.models).map(m => String(m).toLowerCase());
  return models.some(m => {
    const norm = m.replace(/[-_\s/]/g, '');
    const isTarget = targetModels.some(t => {
      const normT = t.toLowerCase().replace(/[-_\s/]/g, '');
      return norm === normT || norm.endsWith(normT) || m.includes(t.toLowerCase());
    });
    if (isTarget) return true;
    const hasDs = norm.includes('deepseek') || norm.includes('ds');
    const hasV4 = norm.includes('v4') || norm.includes('4pro');
    const hasPro = norm.includes('pro');
    return hasDs && (hasV4 || hasPro);
  });
}

function isSelfProxyUrl(url, port) {
  if (!url) return false;
  return url.includes(`:${port}`) || url.includes(`:${port}/`) || url.includes('127.0.0.1:20329') || url.includes('localhost:20329');
}

function enableInterception(config) {
  const proxyUrl = `http://127.0.0.1:${config.port}`;

  if (!hasCcHahaProviders()) {
    writeState({
      enabled: true,
      proxyUrl,
      providers: {},
      keyMap: {},
      defaultUpstream: config.targetBaseUrl !== 'auto' ? config.targetBaseUrl : 'http://127.0.0.1:20128',
      ts: new Date().toISOString()
    });
    log(`interception ON (pure Claude Code mode): listening on ${proxyUrl}`);
    return { ok: true, mode: 'env', interceptedCount: 0, proxyUrl };
  }

  const data = readProviders();
  if (!data || !Array.isArray(data.providers)) {
    return { ok: false, reason: '无法读取 providers.json 数据' };
  }

  const currentState = readState();
  const savedProviders = currentState.providers || {};
  const keyMap = currentState.keyMap || {};

  let interceptedList = [];
  let skippedList = [];

  for (const prov of data.providers) {
    if (!prov.baseUrl) continue;

    let realOriginal = null;
    if (!isSelfProxyUrl(prov.baseUrl, config.port)) {
      realOriginal = prov.baseUrl;
    } else if (savedProviders[prov.id] && !isSelfProxyUrl(savedProviders[prov.id].originalUrl, config.port)) {
      realOriginal = savedProviders[prov.id].originalUrl;
    } else {
      skippedList.push({ id: prov.id, name: prov.name || prov.id });
      log(`interception SKIP: provider ${prov.name || prov.id} 已是代理地址且无可信真实上游记录，保持原样不接管`);
      continue;
    }

    savedProviders[prov.id] = {
      name: prov.name || prov.id,
      originalUrl: realOriginal,
      apiKey: prov.apiKey || ''
    };

    prov.baseUrl = proxyUrl;

    if (prov.apiKey && !isSelfProxyUrl(realOriginal, config.port)) {
      keyMap[prov.apiKey] = realOriginal;
    }

    interceptedList.push({ id: prov.id, name: prov.name, originalUrl: realOriginal });
  }

  let defaultUpstream = (config.targetBaseUrl && config.targetBaseUrl !== 'auto' && !isSelfProxyUrl(config.targetBaseUrl, config.port)) ? config.targetBaseUrl : null;
  const activeProv = (data.providers || []).find(p => p.id === data.activeId);
  if (activeProv && savedProviders[activeProv.id] && !isSelfProxyUrl(savedProviders[activeProv.id].originalUrl, config.port)) {
    defaultUpstream = savedProviders[activeProv.id].originalUrl;
  }

  writeState({
    enabled: true,
    proxyUrl,
    providers: savedProviders,
    keyMap,
    defaultUpstream,
    ts: new Date().toISOString()
  });

  writeProviders(data);
  log(`interception ON (cc-haha mode): ${interceptedList.length} providers hooked`);
  return {
    ok: true,
    mode: 'cc-haha',
    proxyUrl,
    interceptedList,
    totalHooked: Object.keys(savedProviders).length
  };
}

function disableInterception(config) {
  const state = readState();
  if (!hasCcHahaProviders()) {
    writeState({ enabled: false, providers: {}, keyMap: {}, defaultUpstream: null });
    log(`interception OFF (pure Claude Code mode)`);
    return { ok: true, mode: 'env', restoredList: [] };
  }

  const data = readProviders();
  if (!data || !Array.isArray(data.providers)) {
    return { ok: false, reason: '无法读取 providers.json 数据' };
  }

  const savedProviders = (state && state.providers) || {};
  const keyMap = state.keyMap || {};
  const restoredList = [];

  const unrestorableList = [];
  for (const prov of data.providers) {
    if (!prov.baseUrl || !isSelfProxyUrl(prov.baseUrl, config.port)) continue;
    if (savedProviders[prov.id] && savedProviders[prov.id].originalUrl && !isSelfProxyUrl(savedProviders[prov.id].originalUrl, config.port)) {
      prov.baseUrl = savedProviders[prov.id].originalUrl;
      restoredList.push({ id: prov.id, name: prov.name, restoredUrl: prov.baseUrl });
    } else {
      unrestorableList.push({ id: prov.id, name: prov.name });
      log(`interception OFF WARN: provider ${prov.name || prov.id} 指向代理但账本无可信真实上游，保持原样待人工核对`);
    }
  }

  if (restoredList.length === 0) {
    writeState({ ...state, enabled: false, ts: new Date().toISOString() });
    log(`interception OFF (cc-haha mode): no restorable providers, ledger kept`);
    return { ok: true, mode: 'cc-haha', restoredList, unrestorableList };
  }

  writeProviders(data);
  writeState({ ...state, enabled: false, ts: new Date().toISOString() });
  log(`interception OFF (cc-haha mode): ${restoredList.length} providers restored (ledger kept for boot recovery)`);
  return { ok: true, mode: 'cc-haha', restoredList, unrestorableList };
}

function recoverOrphans(config) {
  if (!hasCcHahaProviders()) return { ok: true, mode: 'env', restoredList: [] };
  const data = readProviders();
  if (!data || !Array.isArray(data.providers)) return { ok: false, reason: '无法读取 providers.json' };
  const st = readState();
  const savedProviders = (st && st.providers) || {};
  const restoredList = [];

  for (const prov of data.providers) {
    if (!prov.baseUrl || !isSelfProxyUrl(prov.baseUrl, config.port)) continue;
    if (savedProviders[prov.id] && savedProviders[prov.id].originalUrl && !isSelfProxyUrl(savedProviders[prov.id].originalUrl, config.port)) {
      prov.baseUrl = savedProviders[prov.id].originalUrl;
      restoredList.push({ id: prov.id, name: prov.name, restoredUrl: prov.baseUrl });
    } else {
      log(`orphan recovery WARN: provider ${prov.name || prov.id} 指向代理但账本无可信真实上游，跳过（保持原样）`);
    }
  }

  if (restoredList.length === 0) return { ok: true, mode: 'cc-haha', restoredList, orphan: false };

  writeProviders(data);
  log(`orphan recovery: ${restoredList.length} providers restored from ledger`);
  return { ok: true, mode: 'cc-haha', restoredList, orphan: true };
}

function readState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch (e) {}
  return { enabled: false, providers: {}, keyMap: {}, defaultUpstream: null };
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {}
}

migrateLegacyFiles();
migrateLegacyLog();

module.exports = {
  loadConfig, log, isProxyRunning,
  enableInterception, disableInterception, recoverOrphans, readState, writeState,
  isSelfProxyUrl,
  providerHasTargetModels,
  PROVIDERS_PATH, LOG_PATH, STATE_PATH, DATA_DIR
};
