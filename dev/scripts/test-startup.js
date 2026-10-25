// 启动回归：IPC 不可重复；更新模块可独立加载，不依赖 electron-updater。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const channels = new Set();
for (const [, channel] of main.matchAll(/ipcMain\.handle\(['"]([^'"]+)['"]/g)) {
  assert(!channels.has(channel), `重复注册 IPC: ${channel}`);
  channels.add(channel);
}
assert(channels.has('app:repairFileAssoc'));
const { createAutoUpdater } = require('../src/main/auto-update');
assert.equal(typeof createAutoUpdater, 'function');
console.log(`启动回归通过：${channels.size} 个 IPC 无重复，更新模块不依赖 Electron 即可加载。`);
