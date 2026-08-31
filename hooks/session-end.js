const state = require('../lib/state.js');

const config = state.loadConfig();
const result = state.disableInterception(config);
if (result.ok && !result.already) {
  console.log(`[we-need-ds] 会话结束：baseUrl 已还原为 ${result.restored}`);
}
