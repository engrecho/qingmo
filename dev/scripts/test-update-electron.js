// The Node parent owns Chromium profiles until Electron has exited (Windows locks).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qingmo-update-regression-'));
const env = { ...process.env, QINGMO_UPDATE_TEST_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
try {
  const script = process.argv[2];
  assert(['verify-update-network.js', 'verify-update-flow.js'].includes(script));
  const result = spawnSync(require('electron'), [path.join(__dirname, script), ...process.argv.slice(3)], { env, encoding: 'utf8', timeout: 40000, maxBuffer: 4 * 1024 * 1024 });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  assert.equal(result.status, 0, result.error?.message || 'Electron update regression failed');
  assert.equal(fs.readFileSync(path.join(profile, 'passed'), 'utf8'), script);
} finally { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
