const assert = require('assert/strict');
const { confirmClose } = require('../src/main/close-dialog');
(async () => {
  for (const [responses, expected] of [[[0], 'save'], [[2], 'cancel'], [[1, 0], 'discard'], [[1, 1], 'cancel'], [[-1], 'cancel'], [[1, -1], 'cancel']]) {
    const calls = [];
    const dialog = { showMessageBox: async (_parent, options) => { calls.push(options); return { response: responses[calls.length - 1] }; } };
    assert.equal(await confirmClose(dialog, {}, ['文档.md']), expected);
    assert.deepEqual(calls[0].buttons, ['保存并关闭', '放弃保存', '返回确认']);
    assert.equal(calls[0].cancelId, 2);
    if (calls[1]) { assert.equal(calls[1].defaultId, 1); assert.equal(calls[1].cancelId, 1); assert.match(calls[1].detail, /无法恢复/); }
    console.log('PASS', responses, expected);
  }
})().catch(error => {console.error(error);process.exit(1)});
