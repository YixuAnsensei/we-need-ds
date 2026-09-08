const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const HOME_DIR = process.env.USERPROFILE || process.env.HOME || os.homedir();
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const PROVIDERS_PATH = process.env.WE_NEED_DS_PROVIDERS_PATH || path.join(HOME_DIR, '.claude', 'cc-haha', 'providers.json');
const DATA_DIR = process.env.WE_NEED_DS_DATA_DIR || path.join(HOME_DIR, '.claude', 'we-need-ds');
const LOG_PATH = path.join(DATA_DIR, 'we-need-ds.log');
const STATE_PATH = path.join(DATA_DIR, 'runtime-state.json');
const LEGACY_STATE_PATH = path.join(__dirname, '..', 'runtime-state.json');
const LEGACY_LOG_PATH = path.join(__dirname, '..', 'we-need-ds.log');

try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {}

function migrateLegacyFiles() {
  const candidates = [LEGACY_STATE_PATH, path.join(HOME_DIR, '.claude', 'plugins', 'marketplaces', 'claude-plugins-official', 'plugins', 'we-need-ds', 'runtime-state.json')];
  const cacheRoot = path.join(HOME_DIR, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'we-need-ds');
  try {
    if (fs.existsSync(cacheRoot)) {
      for (const ver of fs.readdirSync(cacheRoot)) {
        candidates.push(path.join(cacheRoot, ver, 'runtime-state.json'));
      }
    }
  } catch (e) {}
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
    idleAutoShutdownMinutes: 0,
    thinkingBudget: 8000,
    upstreamRetries: 1,
    upstreamRetryBackoffMs: 500,
    upstreamHeaderTimeoutMs: 30000,
    upstreamBodyTimeoutMs: 30000,
    upstreamIdleTimeoutMs: 600000
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

async function killDaemonOnPort(port, waitMs) {
  const { execSync } = require('child_process');
  let pid = null;
  try {
    const out = execSync('netstat -ano | findstr LISTENING').toString();
    for (const line of out.trim().split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5) continue;
      const localPort = String(cols[1]).split(':').pop();
      if (localPort !== String(port)) continue;
      const candidate = cols[cols.length - 1];
      if (/^\d+$/.test(candidate)) { pid = candidate; break; }
    }
  } catch (e) {}
  if (!pid) return { killed: false, pid: null, released: true };
  try { execSync(`taskkill /F /PID ${pid}`); } catch (e) {}
  const deadline = Date.now() + (waitMs || 5000);
  let released = false;
  while (Date.now() < deadline) {
    if (!(await isProxyRunning(port))) { released = true; break; }
    await new Promise(r => setTimeout(r, 200));
  }
  log(`killDaemonOnPort :${port} pid=${pid} killed released=${released}`);
  return { killed: true, pid, released };
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

const PROVIDERS_LOCK_PATH = PROVIDERS_PATH + '.weld.lock';

function acquireProvidersLock(maxWaitMs) {
  const deadline = Date.now() + (maxWaitMs || 2000);
  while (true) {
    try {
      fs.mkdirSync(PROVIDERS_LOCK_PATH);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      try {
        const age = Date.now() - fs.statSync(PROVIDERS_LOCK_PATH).mtimeMs;
        if (age > 5000) { fs.rmdirSync(PROVIDERS_LOCK_PATH); continue; }
      } catch (e2) {}
      if (Date.now() > deadline) return false;
      const until = Date.now() + 20;
      while (Date.now() < until) {}
    }
  }
}

function releaseProvidersLock() {
  try { fs.rmdirSync(PROVIDERS_LOCK_PATH); } catch (e) {}
}

function writeProviders(data) {
  if (!data || !hasCcHahaProviders()) return;
  const locked = acquireProvidersLock(2000);
  try {
    const tmp = PROVIDERS_PATH + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, PROVIDERS_PATH);
  } catch (e) {
    log(`writeProviders failed: ${e.message}`);
  } finally {
    if (locked) releaseProvidersLock();
  }
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
    const hasDs = m.includes('deepseek') || /(^|[-_./\s])ds(?=[-_./\s]|v|\d|$)/.test(m);
    const hasV4 = norm.includes('v4') || norm.includes('4pro');
    const hasPro = norm.includes('pro');
    return hasDs && (hasV4 || hasPro);
  });
}

function isSelfProxyUrl(url, port) {
  if (!url) return false;
  return new RegExp(':' + port + '(?![0-9])').test(url);
}

const COPY_SUFFIX = ' · 直连副本';
const COPY_ID_PREFIX = 'wnd-copy-';

function copyIdOf(id) { return COPY_ID_PREFIX + id; }

function isCopyProvider(p) {
  return !!(p && (p.weNeedDsCopy === true || (p.name && String(p.name).endsWith(COPY_SUFFIX))));
}

function proxyPorts(config, st) {
  const ports = new Set([String(config.port)]);
  try {
    if (st && st.proxyUrl) {
      const pp = new URL(st.proxyUrl).port;
      if (pp) ports.add(pp);
    }
  } catch (e) {}
  return ports;
}

function isProxiedUrl(url, ports) {
  if (!url) return false;
  for (const port of ports) {
    if (new RegExp('127\\.0\\.0\\.1:' + port + '(?![0-9])').test(url) || new RegExp('localhost:' + port + '(?![0-9])').test(url)) return true;
  }
  return false;
}

function findCopy(data, id) {
  return (data.providers || []).find(p => p.id === copyIdOf(id) || (isCopyProvider(p) && p.weNeedDsOf === id));
}

function restoreAllProxied(data, ledgerProviders, ports) {
  const restored = [];
  const unrestorable = [];
  for (const prov of data.providers) {
    if (!prov.baseUrl || !isProxiedUrl(prov.baseUrl, ports)) continue;
    if (isCopyProvider(prov)) continue;
    let real = null;
    const led = ledgerProviders[prov.id];
    if (led && led.originalUrl && !isProxiedUrl(led.originalUrl, ports)) real = led.originalUrl;
    if (!real) {
      const c = findCopy(data, prov.id);
      if (c && c.baseUrl && !isProxiedUrl(c.baseUrl, ports)) real = c.baseUrl;
    }
    if (real) {
      prov.baseUrl = real;
      restored.push({ id: prov.id, name: prov.name || prov.id, restoredUrl: real });
    } else {
      unrestorable.push({ id: prov.id, name: prov.name || prov.id });
      log(`restore SKIP: provider ${prov.name || prov.id} 指向代理但账本与副本均无可信真实上游，保持原样`);
    }
  }
  return { restored, unrestorable };
}

function removeAllCopies(data) {
  const before = data.providers.length;
  data.providers = data.providers.filter(p => !isCopyProvider(p));
  return before - data.providers.length;
}

function releaseToDirect(config) {
  const st = readState();
  const ports = proxyPorts(config, st);
  const ledger = (st && st.providers) || {};
  const data = readProviders();
  if (!data || !Array.isArray(data.providers)) return { ok: false, reason: '无法读取 providers.json 数据' };

  const { restored, unrestorable } = restoreAllProxied(data, ledger, ports);
  if (restored.length > 0) writeProviders(data);

  const verify = readProviders();
  const stillProxied = (verify.providers || []).some(p => !isCopyProvider(p) && p.baseUrl && isProxiedUrl(p.baseUrl, ports));
  let removedCopies = 0;
  if (!stillProxied) {
    const v2 = readProviders();
    removedCopies = removeAllCopies(v2);
    if (removedCopies > 0) writeProviders(v2);
  } else {
    log('release: 仍有 provider 指向代理无法还原，保留副本作为逃生口');
  }
  return { ok: true, restoredList: restored, unrestorableList: unrestorable, removedCopies };
}

function enableInterception(config, opts) {
  const proxyUrl = `http://127.0.0.1:${config.port}`;
  const providerId = opts && opts.providerId ? String(opts.providerId) : null;

  if (!hasCcHahaProviders()) {
    writeState({
      enabled: true,
      proxyUrl,
      providers: {},
      keyMap: {},
      defaultUpstream: config.targetBaseUrl !== 'auto' ? config.targetBaseUrl : (process.env.ANTHROPIC_UPSTREAM_BASE_URL || 'http://127.0.0.1:20128'),
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
  const ports = proxyPorts(config, currentState);

  let activeProv = null;
  let switchedActive = false;
  if (providerId) {
    activeProv = (data.providers || []).find(p => p.id === providerId && !isCopyProvider(p))
      || (data.providers || []).find(p => !isCopyProvider(p) && String(p.name || '') === providerId);
    if (!activeProv) {
      return { ok: false, reason: `未找到 id 或名称为「${providerId}」的 provider（可用 list 查看清单）。当前接管状态未受影响。` };
    }
    if (!providerHasTargetModels(activeProv, config.targetModels)) {
      return { ok: false, reason: `provider「${activeProv.name}」的 models 字段未声明 DeepSeek Pro 模型，接管无意义（裁剪不适用）。请从 list 清单里选一个含 DS 模型的。当前接管状态未受影响。` };
    }
    if (!activeProv.baseUrl) {
      return { ok: false, reason: `provider「${activeProv.name}」没有有效的 baseUrl，无法接管。当前接管状态未受影响。` };
    }
  }

  const pre = restoreAllProxied(data, savedProviders, ports);
  const removedCopies = removeAllCopies(data);
  if (pre.restored.length || removedCopies) {
    log(`interception ON: 迁移/清理旧状态 — 还原 ${pre.restored.length} 个指向代理的 provider，移除 ${removedCopies} 个旧副本`);
  }

  if (providerId) {
    if (data.activeId !== activeProv.id) {
      data.activeId = activeProv.id;
      switchedActive = true;
    }
  } else {
    activeProv = (data.providers || []).find(p => p.id === data.activeId && !isCopyProvider(p));
    if (!activeProv || !activeProv.baseUrl) {
      writeProviders(data);
      writeState({ ...currentState, enabled: true, proxyUrl, providers: {}, keyMap, defaultUpstream: null, ts: new Date().toISOString() });
      log('interception ON: 无有效 activeId provider，未接管任何 provider（全部保持直连）');
      return { ok: true, mode: 'cc-haha', proxyUrl, interceptedList: [], activeHooked: null, note: '当前默认 provider 无效，未接管' };
    }
    if (!providerHasTargetModels(activeProv, config.targetModels)) {
      writeProviders(data);
      writeState({ ...currentState, enabled: true, proxyUrl, providers: {}, keyMap, defaultUpstream: null, ts: new Date().toISOString() });
      log(`interception ON: activeId provider「${activeProv.name}」不含 DeepSeek Pro 模型，无需接管（保持直连，裁剪不适用）`);
      return { ok: true, mode: 'cc-haha', proxyUrl, interceptedList: [], activeHooked: null, note: `默认 provider「${activeProv.name}」非 DeepSeek Pro，未接管；要触发裁剪请指定 DS provider（on --provider <id>）或把它设为默认` };
    }
  }

  const realOriginal = activeProv.baseUrl;
  const freshLedger = {};
  freshLedger[activeProv.id] = {
    name: activeProv.name || activeProv.id,
    originalUrl: realOriginal,
    apiKey: activeProv.apiKey || ''
  };
  if (activeProv.apiKey) keyMap[activeProv.apiKey] = realOriginal;

  const liveKeys = new Set((data.providers || []).map(p => p.apiKey).filter(Boolean));
  let prunedKeys = 0;
  for (const k of Object.keys(keyMap)) {
    if (!liveKeys.has(k)) { delete keyMap[k]; prunedKeys++; }
  }
  if (prunedKeys) log(`interception ON: 剪枝 keyMap 中 ${prunedKeys} 个已不存在于 provider 池的陈旧 key`);

  activeProv.baseUrl = proxyUrl;

  const copy = {
    ...JSON.parse(JSON.stringify(activeProv)),
    id: copyIdOf(activeProv.id),
    name: (activeProv.name || activeProv.id) + COPY_SUFFIX,
    baseUrl: realOriginal,
    weNeedDsCopy: true,
    weNeedDsOf: activeProv.id
  };
  data.providers.push(copy);

  writeState({
    enabled: true,
    proxyUrl,
    providers: freshLedger,
    keyMap,
    defaultUpstream: realOriginal,
    ts: new Date().toISOString()
  });
  writeProviders(data);

  log(`interception ON (cc-haha single-provider): 接管「${activeProv.name}」→ :${config.port}，并建直连副本「${copy.name}」(原始 ${realOriginal})${switchedActive ? '，并把 activeId 切换为该 provider' : ''}`);
  return {
    ok: true,
    mode: 'cc-haha',
    proxyUrl,
    interceptedList: [{ id: activeProv.id, name: activeProv.name, originalUrl: realOriginal }],
    activeHooked: activeProv.name,
    copyName: copy.name,
    activeSwitched: switchedActive,
    totalHooked: 1
  };
}

function listProviders(config) {
  if (!hasCcHahaProviders()) return { ok: false, reason: '未找到 cc-haha 的 providers.json（当前可能是纯 Claude Code 环境）' };
  const data = readProviders();
  if (!data || !Array.isArray(data.providers)) return { ok: false, reason: '无法读取 providers.json 数据' };
  const st = readState();
  const ports = proxyPorts(config, st);
  const items = [];
  for (const prov of data.providers) {
    if (isCopyProvider(prov)) continue;
    const isDs = providerHasTargetModels(prov, config.targetModels);
    const models = prov.models ? Object.entries(prov.models).map(([k, v]) => `${k}=${v}`).join(', ') : '';
    items.push({
      id: prov.id,
      name: prov.name || prov.id,
      baseUrl: prov.baseUrl || '',
      isDefault: prov.id === data.activeId,
      isHooked: !!(prov.baseUrl && isProxiedUrl(prov.baseUrl, ports)),
      hasTargetModels: isDs,
      models
    });
  }
  items.sort((a, b) => (b.hasTargetModels - a.hasTargetModels) || (b.isDefault - a.isDefault) || String(a.name).localeCompare(String(b.name)));
  return { ok: true, activeId: data.activeId, providers: items };
}

function disableInterception(config) {
  const state = readState();
  if (!hasCcHahaProviders()) {
    writeState({ enabled: false, providers: {}, keyMap: {}, defaultUpstream: null });
    log(`interception OFF (pure Claude Code mode)`);
    return { ok: true, mode: 'env', restoredList: [] };
  }

  const r = releaseToDirect(config);
  if (!r.ok) return r;
  writeState({ ...state, enabled: false, ts: new Date().toISOString() });
  log(`interception OFF (cc-haha mode): ${r.restoredList.length} restored, ${r.removedCopies} copies removed (ledger kept for boot recovery)`);
  return { ok: true, mode: 'cc-haha', restoredList: r.restoredList, unrestorableList: r.unrestorableList, removedCopies: r.removedCopies };
}

function recoverOrphans(config) {
  if (!hasCcHahaProviders()) return { ok: true, mode: 'env', restoredList: [] };
  const r = releaseToDirect(config);
  if (!r.ok) return r;
  const orphan = r.restoredList.length > 0;
  if (orphan) log(`orphan recovery: ${r.restoredList.length} providers restored (ledger+copy dual-source), ${r.removedCopies} copies removed`);
  return { ok: true, mode: 'cc-haha', restoredList: r.restoredList, unrestorableList: r.unrestorableList, removedCopies: r.removedCopies, orphan };
}

function detectDeadState(config) {
  if (!hasCcHahaProviders()) return { dead: false, orphanCount: 0 };
  const st = readState();
  const ports = proxyPorts(config, st);
  const data = readProviders();
  if (!data || !Array.isArray(data.providers)) return { dead: false, orphanCount: 0 };
  let orphanCount = 0;
  for (const prov of data.providers) {
    if (isCopyProvider(prov)) continue;
    if (prov.baseUrl && isProxiedUrl(prov.baseUrl, ports)) orphanCount++;
  }
  return { dead: orphanCount > 0, orphanCount };
}

function readState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch (e) {}
  return { enabled: false, providers: {}, keyMap: {}, defaultUpstream: null };
}

const LOCK_PATH = STATE_PATH + '.lock';

function acquireLock(maxWaitMs) {
  const deadline = Date.now() + (maxWaitMs || 2000);
  while (true) {
    try {
      fs.mkdirSync(LOCK_PATH);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      try {
        const age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
        if (age > 5000) { fs.rmdirSync(LOCK_PATH); continue; }
      } catch (e2) {}
      if (Date.now() > deadline) return false;
      const until = Date.now() + 20;
      while (Date.now() < until) {}
    }
  }
}

function releaseLock() {
  try { fs.rmdirSync(LOCK_PATH); } catch (e) {}
}

function writeState(state) {
  const locked = acquireLock(2000);
  try {
    const tmp = STATE_PATH + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_PATH);
  } catch (e) {
    log(`writeState failed: ${e.message}`);
  } finally {
    if (locked) releaseLock();
  }
}

function updateState(mutator) {
  const locked = acquireLock(2000);
  try {
    let cur;
    try {
      cur = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : { enabled: false, providers: {}, keyMap: {}, defaultUpstream: null };
    } catch (e) {
      cur = { enabled: false, providers: {}, keyMap: {}, defaultUpstream: null };
    }
    const next = mutator(cur) || cur;
    const tmp = STATE_PATH + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_PATH);
    return next;
  } catch (e) {
    log(`updateState failed: ${e.message}`);
    return null;
  } finally {
    if (locked) releaseLock();
  }
}

migrateLegacyFiles();
migrateLegacyLog();

module.exports = {
  loadConfig, log, isProxyRunning, killDaemonOnPort,
  enableInterception, disableInterception, recoverOrphans, readState, writeState, updateState, detectDeadState,
  isSelfProxyUrl, isProxiedUrl, listProviders,
  providerHasTargetModels,
  isCopyProvider, copyIdOf, COPY_SUFFIX,
  PROVIDERS_PATH, LOG_PATH, STATE_PATH, DATA_DIR
};
