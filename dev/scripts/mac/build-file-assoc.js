const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
if (process.platform !== 'darwin') throw new Error('Launch Services helper must be built on macOS');
const output = path.resolve(__dirname, '../../build/mac/file-assoc');
fs.mkdirSync(path.dirname(output), { recursive: true });
execFileSync('xcrun', ['clang', '-fobjc-arc', '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=11.0', '-framework', 'Foundation', '-framework', 'CoreServices', path.join(__dirname, 'file-assoc.m'), '-o', output], { stdio: 'inherit' });
execFileSync('codesign', ['--force', '--sign', '-', output], { stdio: 'inherit' });
console.log('Built universal Launch Services helper');
