const state = require('../lib/state.js');

const config = state.loadConfig();
const st = state.readState();
if (!st.enabled) {
  console.log(`[we-need-ds] 会话结束：拦截本就处于关闭状态，无需处理`);
  return;
}
const result = state.recoverOrphans(config);
if (result.ok) {
  const n = (result.restoredList && result.restoredList.length) || 0;
  if (n > 0) {
    console.log(`[we-need-ds] 会话结束：已把 ${n} 个指向代理的 provider 还原直连（拦截意图保留，下个会话自动重接管；永久关闭请执行 /we-need-ds:off）`);
  } else {
    console.log(`[we-need-ds] 会话结束：provider 已是直连状态，拦截意图保留`);
  }
  const u = (result.unrestorableList && result.unrestorableList.length) || 0;
  if (u > 0) {
    console.log(`[we-need-ds] 警告：${u} 个 provider 指向代理但账本与副本均无真实上游记录，保持原样待人工核对`);
  }
} else {
  console.log(`[we-need-ds] 会话结束还原失败：${result.reason || '未知原因'}`);
}
