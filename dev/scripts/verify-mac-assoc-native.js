// Run only on an isolated macOS CI runner: validate the shipped helper and actual
// Launch Services registration using the packaged app, not a registry mock.
const { execFileSync } = require('child_process');
const path = require('path');
const assert = require('assert/strict');
const app = path.resolve(process.argv[2]);
const helper = path.join(app, 'Contents/Resources/mac/file-assoc');
const run = action => JSON.parse(execFileSync(helper, [action, ...(action === 'register' ? [app] : [])], { encoding: 'utf8', timeout: 15000 }));
assert.equal(run('check').length, 7);
const registered = run('register');
assert(registered.every(row => row.ok && row.isQingMo), JSON.stringify(registered));
assert(run('check').every(row => row.isQingMo));
console.log('PASS macOS native Launch Services register + check for all seven Markdown extensions');
