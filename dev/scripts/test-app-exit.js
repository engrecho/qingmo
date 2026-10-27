const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qingmo-actual-quit-'));
try {
  const childEnv = { ...process.env }; delete childEnv.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.join(__dirname, 'verify-app-exit.js'), '--profile', temporary, '--no-sandbox', '--disable-gpu'], {
    env: childEnv, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024
  });
  if (result.status !== 0) console.error(result.stdout, result.stderr, result.error || '');
  assert.equal(result.status, 0, 'Actual main process must exit successfully');
  const proof = JSON.parse(fs.readFileSync(path.join(temporary, 'proof.json'), 'utf8'));
  assert.deepEqual(proof, { passed: true, canceledQuit: true, savedOnQuit: true, restoredWindow: true });
  console.log('PASS actual main process: hide/restore without prompt, cancel app.quit, save document before real exit');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
