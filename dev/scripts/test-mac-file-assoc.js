const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMacFileAssoc, EXTS } = require('../src/main/file-assoc-mac');
test('macOS repair uses bundled Launch Services helper and exact bundle path as arguments', async () => {
  const calls = [];
  const app = { isPackaged: true, getPath: () => '/Applications/轻墨 测试.app/Contents/MacOS/轻墨' };
  const results = EXTS.map(ext => ({ ext, progid: 'cn.bajiaolu.qingmo', isQingMo: true, ok: true }));
  const assoc = createMacFileAssoc({ app, resources: '/Applications/轻墨 测试.app/Contents/Resources', execute: async (...args) => { calls.push(args); return { stdout: JSON.stringify(results) }; } });
  assert.equal((await assoc.register()).ok, true);
  assert.equal(calls[0][0], '/Applications/轻墨 测试.app/Contents/Resources/mac/file-assoc');
  assert.deepEqual(calls[0][1], ['register', '/Applications/轻墨 测试.app']);
  assert.deepEqual(await assoc.check(), results);
  assert.deepEqual(calls[1][1], ['check']);
});
test('partial failures are not reported as repaired; development cannot hijack defaults', async () => {
  const app = { isPackaged: true, getPath: () => '/Applications/轻墨.app/Contents/MacOS/轻墨' };
  const assoc = createMacFileAssoc({ app, resources: '/tmp', execute: async () => ({ stdout: JSON.stringify(EXTS.map(ext => ({ ext, isQingMo: false, ok: false }))) }) });
  assert.equal((await assoc.register()).ok, false);
  await assert.rejects(createMacFileAssoc({ app: { isPackaged: false } }).register(), /Applications/);
});
