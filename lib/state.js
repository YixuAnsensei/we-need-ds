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

function findActiveProvider(data, config) {
  if (!data) return null;
  const activeId = data.activeId;
  const provider = (data.providers || []).find(p => p.id === activeId);
  return provider || null;
}

function enableInterception(config) {
  const proxyUrl = `http://127.0.0.1:${config.port}`;

  if (!hasCcHahaProviders()) {
    writeState({ enabled: true, originalUrl: config.targetBaseUrl !== 'auto' ? config.targetBaseUrl : 'env/default', ts: new Date().toISOString() });
    log(`interception ON (pure Claude Code mode): listening on ${proxyUrl}`);
    return { ok: true, mode: 'env', proxyUrl, originalUrl: config.targetBaseUrl };
  }

  const data = readProviders();
  const provider = findActiveProvider(data, config);
  if (!provider) return { ok: false, reason: 'providers.json 中找不到激活 Provider' };

  const originalUrl = provider.baseUrl;
  if (originalUrl.includes(`:${config.port}`)) {
    return { ok: true, already: true, proxyUrl, originalUrl: readState().originalUrl || null };
  }

  writeState({ enabled: true, originalUrl, ts: new Date().toISOString() });
  provider.baseUrl = proxyUrl;
  writeProviders(data);
  log(`interception ON (cc-haha mode): ${originalUrl} -> ${proxyUrl}`);
  return { ok: true, originalUrl, proxyUrl };
}

function disableInterception(config) {
  const state = readState();
  if (!hasCcHahaProviders()) {
    writeState({ enabled: false, originalUrl: null });
    log(`interception OFF (pure Claude Code mode)`);
    return { ok: true, mode: 'env' };
  }

  if (!state || !state.enabled || !state.originalUrl) {
    const data = readProviders();
    const provider = findActiveProvider(data, config);
    if (provider && provider.baseUrl && provider.baseUrl.includes(`:${config.port}`)) {
      provider.baseUrl = 'http://localhost:20128';
      writeProviders(data);
    }
    return { ok: true, already: true };
  }

  const data = readProviders();
  const provider = findActiveProvider(data, config);
  if (!provider) return { ok: false, reason: 'providers.json 中找不到激活 Provider' };

  provider.baseUrl = state.originalUrl;
  writeProviders(data);
  writeState({ enabled: false, originalUrl: null });
  log(`interception OFF (cc-haha mode): restored ${state.originalUrl}`);
  return { ok: true, restored: state.originalUrl };
}

function readState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch (e) {}
  return { enabled: false, originalUrl: null };
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

module.exports = {
  loadConfig, log, isProxyRunning,
  enableInterception, disableInterception, readState, writeState,
  PROVIDERS_PATH, LOG_PATH, STATE_PATH
};
