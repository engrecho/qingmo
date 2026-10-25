// 启动回归：IPC 不可重复；更新依赖缺失不可阻止主模块加载。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const channels = new Set();
for (const [, channel] of main.matchAll(/ipcMain\.handle\(['"]([^'"]+)['"]/g)) {
  assert(!channels.has(channel), `重复注册 IPC: ${channel}`);
  channels.add(channel);
}
assert(channels.has('app:repairFileAssoc'));
let loads = 0;
const context = {
  module: { exports: {} }, __dirname, process: { env: {} },
  require(name) {
    if (name === 'electron-updater') { loads++; throw new Error('missing updater fixture'); }
    if (name === 'electron') return { app: { isPackaged: true, requestSingleInstanceLock: () => true } };
    if (name === './logger') return { info() {} };
    return require(name);
  }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/auto-update.js'), 'utf8'), context);
assert.equal(loads, 0, '启动时不应加载更新依赖');
(async () => {
  const state = await context.module.exports.check(false);
  assert.equal(loads, 1);
  assert.match(state.error, /missing updater fixture/);
  assert.equal(context.module.exports.state().checking, false);
  console.log(`启动回归通过：${channels.size} 个 IPC 无重复，缺失更新依赖可恢复。`);
})().catch(error => { console.error(error); process.exitCode = 1; });
