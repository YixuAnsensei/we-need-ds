const fs = require('fs');
const path = require('path');
const os = require('os');

const ENTRY_NAME = 'we-need-ds-boot.vbs';

function startupDir() {
  if (process.env.WE_NEED_DS_STARTUP_DIR) return process.env.WE_NEED_DS_STARTUP_DIR;
  const appdata = process.env.APPDATA || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function entryPath() {
  return path.join(startupDir(), ENTRY_NAME);
}

function buildVbs(nodePath, ctlPath) {
  const cmd = `"${nodePath}" "${ctlPath}" boot`;
  const vbsLiteral = '"' + cmd.replace(/"/g, '""') + '"';
  return `Set sh = CreateObject("WScript.Shell")\r\nsh.Run ${vbsLiteral}, 0, False\r\n`;
}

function install(nodePath, ctlPath) {
  const dir = startupDir();
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const target = entryPath();
    const content = buildVbs(nodePath || process.execPath, ctlPath || path.join(__dirname, 'ctl.js'));
    const tmp = target + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, target);
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function uninstall() {
  try {
    const target = entryPath();
    if (fs.existsSync(target)) { fs.unlinkSync(target); return { ok: true, removed: target }; }
    return { ok: true, removed: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function status() {
  const target = entryPath();
  return { installed: fs.existsSync(target), path: target, dir: startupDir() };
}

module.exports = { install, uninstall, status, startupDir, entryPath };
