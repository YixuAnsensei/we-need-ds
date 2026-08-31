const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const HOME_DIR = process.env.USERPROFILE || process.env.HOME || os.homedir();
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const PROVIDERS_PATH = path.join(HOME_DIR, '.claude', 'cc-haha', 'providers.json');
const LOG_PATH = path.join(__dirname, '..', 'we-need-ds.log');
const STATE_PATH = path.join(__dirname, '..', 'runtime-state.json');

function loadConfig() {
  let config = {
    port: 20129,
    targetBaseUrl: 'auto',
    targetModels: ['deepseek-v4-pro-0813', 'deepseek-v4-pro'],
    bootstrapCoreTools: ['Bash', 'Edit', 'Read', 'Write'],
    logDetails: false,
    idleAutoShutdownMinutes: 30
  };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    }
  } catch (e) {}
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
      timeout: 500
    }, (res) => resolve(true));
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

  for (const prov of data.providers) {
    if (!prov.baseUrl) continue;

    if (!prov.baseUrl.includes(`:${config.port}`)) {
      savedProviders[prov.id] = {
        name: prov.name || prov.id,
        originalUrl: prov.baseUrl,
        apiKey: prov.apiKey || ''
      };
      prov.baseUrl = proxyUrl;
    }
    if (prov.apiKey) {
      keyMap[prov.apiKey] = savedProviders[prov.id]?.originalUrl || prov.baseUrl;
    }
    interceptedList.push({ id: prov.id, name: prov.name, originalUrl: savedProviders[prov.id]?.originalUrl });
  }

  let defaultUpstream = 'http://127.0.0.1:20128';
  const activeProv = (data.providers || []).find(p => p.id === data.activeId);
  if (activeProv && savedProviders[activeProv.id]) {
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
  const restoredList = [];

  for (const prov of data.providers) {
    if (savedProviders[prov.id] && savedProviders[prov.id].originalUrl) {
      prov.baseUrl = savedProviders[prov.id].originalUrl;
      restoredList.push({ id: prov.id, name: prov.name, restoredUrl: prov.baseUrl });
    } else if (prov.baseUrl && prov.baseUrl.includes(`:${config.port}`)) {
      prov.baseUrl = 'http://localhost:20128';
      restoredList.push({ id: prov.id, name: prov.name, restoredUrl: prov.baseUrl });
    }
  }

  writeProviders(data);
  writeState({ enabled: false, providers: {}, keyMap: {}, defaultUpstream: null });
  log(`interception OFF (cc-haha mode): ${restoredList.length} providers restored`);
  return { ok: true, mode: 'cc-haha', restoredList };
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

module.exports = {
  loadConfig, log, isProxyRunning,
  enableInterception, disableInterception, readState, writeState,
  providerHasTargetModels,
  PROVIDERS_PATH, LOG_PATH, STATE_PATH
};
