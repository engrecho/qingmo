// 打包与开发共用此前置检查：缺少运行依赖时立即中止，禁止产出坏包。
require.resolve('electron-updater');
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const R = path.join(__dirname, '../src/renderer');
const DEV = path.join(__dirname, '..');
const ROOT = path.join(DEV, '..');

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
  genDevUpdateConfig();
}).catch(e => {
  console.error(e);
  process.exit(1);
});

/* ---------- 生成 dev-app-update.yml（开发模式测自动更新用） ----------
 *
 * electron-updater 在未打包时会跳过检查（"application is not packed"），
 * 除非提供 dev-app-update.yml。
 * 它由 dist/latest.yml 派生（版本号每次打包都变），所以是派生产物、不入库。
 * 这里自动生成，省得每次手动改。
 */
function genDevUpdateConfig() {
  const candidates = [
    path.join(ROOT, 'dist', 'latest.yml'),
    path.join(ROOT, '.cache', 'build', 'win', 'latest.yml'),
    path.join(ROOT, 'release', 'windows', 'latest.yml')
  ];
  const src = candidates.find(p => fs.existsSync(p));
  if (!src) return;   // 还没打包过，跳过
  const yml = fs.readFileSync(src, 'utf8');
  const out = 'provider: github\nowner: engrecho\nrepo: qingmo\n' +
              'updaterCacheDirName: qingmo-updater\n' + yml;
  fs.writeFileSync(path.join(DEV, 'dev-app-update.yml'), out);
  console.log('  dev-app-update.yml 已生成（来自 ' + path.relative(ROOT, src) + '）');
}
