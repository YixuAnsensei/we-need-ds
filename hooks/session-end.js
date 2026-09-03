const state = require('../lib/state.js');

const config = state.loadConfig();
const result = state.disableInterception(config);
if (result.ok) {
  const n = (result.restoredList && result.restoredList.length) || 0;
  if (n > 0) {
    console.log(`[we-need-ds] 会话结束：已还原 ${n} 个 provider 到各自真实上游`);
  } else {
    console.log(`[we-need-ds] 会话结束：无需还原的 provider（已是直连状态）`);
  }
  const u = (result.unrestorableList && result.unrestorableList.length) || 0;
  if (u > 0) {
    console.log(`[we-need-ds] 警告：${u} 个 provider 指向代理但账本无真实上游记录，保持原样待人工核对`);
  }
} else {
  console.log(`[we-need-ds] 会话结束还原失败：${result.reason || '未知原因'}`);
}
