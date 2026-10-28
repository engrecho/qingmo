#!/usr/bin/env node
/**
 * 校验 mac 产物（.app / .zip）的结构完整性。
 *
 * 为什么需要这个：交叉打包是「逐条改 ZIP 条目」，
 * 任何一条分支的 return 写漏了（比如只给 data 没给 rename），
 * 产出的包目录结构就是乱的 —— 而 mac 上表现为「双击没反应」，
 * 在 Windows 上完全看不出来。
 *
 * 实际踩过的坑：
 *   1. Info.plist 改写分支提前 return，没走整体改名
 *      → 包里同时有 QingMo.app/ 和孤立的 Electron.app/Contents/Info.plist
 *   2. Info.plist 改写放在 startsWith('Electron.app/') 之后
 *      → 那分支会 return，改写成了死代码，CFBundleExecutable 一直是 "Electron"
 *
 * 用法：node scripts/verify-mac.js [mac-zip 路径]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');
const { execFileSync } = require('child_process');

const log = (...a) => console.error(util.format(...a));

const DEV = path.join(__dirname, '..');
const ROOT = path.join(DEV, '..');

// 没传参数就找 release/macos 里最新的 zip
const arg = process.argv[2];
let zipPath = arg;
if (!zipPath) {
  const dir = path.join(ROOT, 'release', 'macos');
  const zips = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => f.endsWith('.zip'))
        .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
    : [];
  if (!zips.length) { log('X release/macos 里没有 zip'); process.exit(1); }
  zipPath = path.join(dir, zips[0].f);
}
if (!fs.existsSync(zipPath)) { log('X 找不到 %s', zipPath); process.exit(1); }

log('校验: %s', path.basename(zipPath));

// 解到临时目录
const TMP = path.join(ROOT, '.cache', 'scratch', 'verify-mac');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
try {
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', TMP], { stdio: 'inherit' });
} catch (e) {
  log('X 解压失败（Windows 自带 tar 不认 zip，用 unzip）');
  process.exit(1);
}

const results = [];
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail || '' });

/* ---- 1. 顶层必须只有一个 .app，且名字正确 ---- */
const tops = fs.readdirSync(TMP);
const apps = tops.filter(d => d.endsWith('.app'));
check('只有一个 .app 目录', apps.length === 1, '实际: ' + JSON.stringify(tops));
check('.app 名字正确', ['QingMo.app', '轻墨.app'].includes(apps[0]), '实际: ' + apps[0]);
check('没有残留 Electron.app', !tops.includes('Electron.app'), '有 Electron.app 残留：' + JSON.stringify(tops));

if (!apps.length) { report(); process.exit(1); }
const APP = path.join(TMP, apps[0]);
const CONTENTS = path.join(APP, 'Contents');

/* ---- 2. 关键文件存在 ---- */
check('Contents/MacOS 存在', fs.existsSync(path.join(CONTENTS, 'MacOS')));
const macos = fs.existsSync(path.join(CONTENTS, 'MacOS'))
  ? fs.readdirSync(path.join(CONTENTS, 'MacOS')) : [];
check('可执行文件名称正确', macos.includes('QingMo') || macos.includes('轻墨'), '实际: ' + JSON.stringify(macos));
check('没有残留 Electron 可执行文件', !macos.includes('Electron'), '实际: ' + JSON.stringify(macos));
check('Resources/app.asar 存在', fs.existsSync(path.join(CONTENTS, 'Resources', 'app.asar')));
check('Resources/icon.icns 存在', fs.existsSync(path.join(CONTENTS, 'Resources', 'icon.icns')));
check('没有残留 electron.icns', !fs.existsSync(path.join(CONTENTS, 'Resources', 'electron.icns')));
check('没有残留 default_app.asar', !fs.existsSync(path.join(CONTENTS, 'Resources', 'default_app.asar')));

/* ---- 3. Info.plist 的关键键 ---- */
const plistPath = path.join(CONTENTS, 'Info.plist');
if (fs.existsSync(plistPath)) {
  const plist = fs.readFileSync(plistPath, 'utf8');
  const get = (k) => {
    const m = new RegExp('<key>' + k + '</key>\\s*<string>([^<]*)<\\/string>').exec(plist);
    return m ? m[1] : null;
  };
  const exe = get('CFBundleExecutable');
  check('CFBundleExecutable 正确', ['QingMo', '轻墨'].includes(exe), '实际: ' + exe);
  check('CFBundleExecutable 与实际可执行文件一致',
    exe && macos.includes(exe), 'plist=' + exe + ' / 实际文件=' + JSON.stringify(macos));
  check('CFBundleName = 轻墨', get('CFBundleName') === '轻墨', '实际: ' + get('CFBundleName'));
  check('CFBundleDisplayName = 轻墨', get('CFBundleDisplayName') === '轻墨', '实际: ' + get('CFBundleDisplayName'));
  check('CFBundleIdentifier 已改', get('CFBundleIdentifier') === 'cn.bajiaolu.qingmo', '实际: ' + get('CFBundleIdentifier'));
  check('CFBundleIconFile = icon.icns', get('CFBundleIconFile') === 'icon.icns', '实际: ' + get('CFBundleIconFile'));
  const documentIcon = get('CFBundleTypeIconFile');
  check('Markdown 文档图标为有效 ICNS', !!documentIcon && documentIcon.endsWith('.icns') && fs.existsSync(path.join(CONTENTS, 'Resources', documentIcon)), '实际: ' + documentIcon);
  check('Markdown UTI 已声明', plist.includes('<string>net.daringfireball.markdown</string>') && plist.includes('<key>LSItemContentTypes</key>') && plist.includes('<key>UTImportedTypeDeclarations</key>'));
  check('macOS 文件关联原生助手存在', fs.existsSync(path.join(CONTENTS, 'Resources/mac/file-assoc')));
  const ver = get('CFBundleShortVersionString');
  check('CFBundleShortVersionString 有值', !!ver && /^\d+\.\d+\.\d+$/.test(ver), '实际: ' + ver);
} else {
  check('Info.plist 存在', false);
}

/* ---- 4. asar 里的 bundle 是最新的（不能是旧构建） ---- */
try {
  const asarPath = path.join(CONTENTS, 'Resources', 'app.asar');
  const b = fs.readFileSync(asarPath);
  const jsonLen = b.readUInt32LE(12);
  const root = JSON.parse(b.toString('utf8', 16, 16 + jsonLen)).files;
  const readEntry = (p) => {
    let n = { files: root };
    for (const seg of p.split('/')) { n = n.files[seg]; if (!n) return null; }
    const st = 8 + b.readUInt32LE(4) + parseInt(n.offset, 10);
    return b.toString('utf8', st, st + parseInt(n.size, 10));
  };
  // 交叉打包的 asar 结构是 resources/renderer/...
  const bundle = readEntry('resources/renderer/app.bundle.js') || readEntry('src/renderer/app.bundle.js');
  check('asar 里有 app.bundle.js', !!bundle, bundle ? '' : '两个路径都没找到');
  if (bundle) {
    check('bundle 含 v1.5.0 的 toggleLinePrefix', bundle.includes('toggleLinePrefix'), '');
    check('bundle 含 live-edit 的 standalone 修复', bundle.includes('standalone'), '');
  }
} catch (e) {
  check('asar 可解析', false, e.message);
}

/* ---- 5. Framework 的符号链接还在 ----
 *
 * 交叉打包必须原样保留符号链接（Versions/Current -> A），
 * 解压再压会丢 —— 这正是当初选「逐条改 ZIP」而不是「解压重压」的原因。
 *
 * 但【不能靠解压后检查】：Windows 的 unzip 不支持符号链接，
 * 解出来必然是普通文件或缺失。这里直接读 zip 的中央目录，
 * 看链接条目的 external attributes 里有没有 S_IFLNK 标志。
 */
{
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  let count = buf.readUInt16LE(eocd + 10);
  let cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff || count === 0xffff) {
    const locOff = buf.readUInt32LE(eocd - 4);
    if (buf.readUInt32LE(locOff) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(locOff + 8));
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cdOff = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }
  const S_IFLNK = 0xa000;   // 符号链接
  const S_IFDIR = 0x4000;
  let p = cdOff;
  let links = 0, dirs = 0, files = 0, currentEntry = null;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const nl = buf.readUInt16LE(p + 28);
    const el = buf.readUInt16LE(p + 30);
    const cl = buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const extAttr = buf.readUInt32LE(p + 38);
    const mode = (extAttr >>> 16) & 0xffff;
    if ((mode & 0xf000) === S_IFLNK) links++;
    else if ((mode & 0xf000) === S_IFDIR || name.endsWith('/')) dirs++;
    else files++;
    if (name.endsWith('/Versions/Current')) currentEntry = { name, mode };
    p += 46 + nl + el + cl;
  }
  check('zip 里有符号链接条目（>=10）', links >= 10, '实际: ' + links);
  check('zip 里有目录条目（>=100）', dirs >= 100, '实际: ' + dirs);
  // 不固定条目数：arm64 / x64 的官方框架文件数量不同。
  // 用关键入口、框架链接及解压后签名校验确认完整性。
  check('Versions/Current 是符号链接',
    !!currentEntry && (currentEntry.mode & 0xf000) === S_IFLNK,
    currentEntry ? 'mode=0x' + currentEntry.mode.toString(16) : '(条目不存在)');
}

if (process.platform === 'darwin') {
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', APP], { stdio: 'pipe' });
    check('应用签名完整', true);
  } catch (e) {
    check('应用签名完整', false, e.stderr ? e.stderr.toString() : e.message);
  }
}

report();
function report() {
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log('  ✓ ' + r.name); }
    else { fail++; console.log('  ✗ ' + r.name + (r.detail ? '  → ' + r.detail : '')); }
  }
  console.log('\n' + '='.repeat(50));
  console.log('通过 ' + pass + ' / ' + results.length);
  if (fail) { console.log('失败 ' + fail); process.exit(1); }
  console.log('✅ mac 产物结构完好');
}
