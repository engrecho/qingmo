// Parent owns all temporary profiles: Windows keeps Chromium files open until exit.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const childEnv = { ...process.env }; delete childEnv.ELECTRON_RUN_AS_NODE;
function run(command, args, env = childEnv) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, result.error?.message || 'Document regression child failed');
}
run(process.execPath, [path.join(__dirname, 'test-document-lifecycle.js')]);
run(process.execPath, [path.join(__dirname, 'test-app-exit.js')]);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qingmo-documents-'));
try {
  run(require('electron'), [path.join(__dirname, 'verify-document-lifecycle.js'), ...process.argv.slice(2)], {
    ...childEnv, QINGMO_DOCUMENT_TEST_ROOT: temporary
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temporary, 'renderer-proof.json'), 'utf8')), { passed: true });
  console.log('PASS complete document regression finished with explicit renderer proof');
} finally { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
