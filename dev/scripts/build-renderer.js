const esbuild = require('esbuild');
const path = require('path');

const R = path.join(__dirname, '../src/renderer');

esbuild.build({
  entryPoints: [path.join(R, 'app.js')],
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  outfile: path.join(R, 'app.bundle.js'),
  minify: false,
  legalComments: 'none',
  logLevel: 'info'
}).then(() => {
  // update.js 依赖 DOM 与 window.api，独立成一个包
  return esbuild.build({
    entryPoints: [path.join(R, 'update.js')],
    bundle: true,
    format: 'iife',
    target: ['chrome110'],
    outfile: path.join(R, 'update.bundle.js'),
    minify: false,
    legalComments: 'none',
    logLevel: 'info'
  });
}).then(() => {
  console.log('✓ renderer bundle built');
}).catch(e => {
  console.error(e);
  process.exit(1);
});
