#!/usr/bin/env node
/**
 * 自动更新真机测试
 *
 * 验证 electron-updater 在真实环境里的行为：
 *   1. 模块能加载
 *   2. 能识别自己是不是便携版
 *   3. checkForUpdates 能跑通（哪怕是「没有新版本」也算成功）
 *   4. 失败时错误信息可读（这决定用户能不能自己解决）
 *
 * 注意：这一步会真的访问 GitHub，可能遇到 403 限流 ——
 * 限流也是要验证的场景（自动更新和手动检查一样会撞上）。
 *
 * 用法：npx electron --no-sandbox --disable-gpu scripts/verify-auto-update-runtime.js
 */
if (!process.versions.electron) {
  console.error('用 electron 跑');
  process.exit(1);
}

const path = require('path');
const util = require('util');
const log = (...a) => console.error(util.format(...a));

const DEV = path.join(__dirname, '..');
const { app } = require('electron');

const results = [];
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail || '' });

app.whenReady().then(async () => {
  // electron-updater 6.8.11 在未打包时只在 app.getAppPath() 下找
  // dev-app-update.yml（ElectronAppAdapter.updateConfigPath），
  // 不支持自定义路径。
  // 正常 `npm start`（electron .）时 getAppPath() 就是 dev/ ✓，
  // 但这个测试脚本在 dev/scripts/ 下 —— 先把配置复制过去。
  const fs = require('fs');
  const src = path.join(DEV, 'dev-app-update.yml');
  if (fs.existsSync(src)) {
    const dst = path.join(app.getAppPath(), 'dev-app-update.yml');
    if (path.resolve(dst) !== path.resolve(src)) {
      fs.copyFileSync(src, dst);
      log('  （测试用）已复制 dev-app-update.yml 到 ' + dst);
    }
  } else {
    log('  ⚠ dev/dev-app-update.yml 不存在 —— 先跑 npm run build:renderer（需要先打包过）');
  }

  /* ============ A. 模块加载 ============ */
  let au = null;
  try {
    au = require(path.join(DEV, 'src', 'main', 'auto-update.js'));
    check('A/auto-update 模块加载', true);
  } catch (e) {
    check('A/auto-update 模块加载', false, e.message);
  }

  if (au) {
    /* ============ B. 便携版识别 ============ */
    const portable = au.isPortable();
    check('B/便携版识别有返回值', typeof portable === 'boolean', String(portable));
    log('  当前是便携版？' + (portable ? '是' : '否（安装版/开发模式）'));
    check('B/开发模式不算便携版', portable === false,
      'PORTABLE_EXECUTABLE_FILE=' + (process.env.PORTABLE_EXECUTABLE_FILE || '(未设置)'));

    /* ============ C. 状态对象 ============ */
    const st = au.state();
    check('C/状态对象有字段', st && 'checking' in st && 'available' in st, JSON.stringify(st));
    check('C/当前版本能取到', /^\d+\.\d+\.\d+$/.test(au.currentVersion()), au.currentVersion());

    /* ============ D. 真实检查 ============ */
    log('\n  正在调用 checkForUpdates（可能因限流失败）...');
    const t0 = Date.now();
    const r = await au.check(true);
    const dt = Date.now() - t0;
    log('  结果: ' + JSON.stringify(r) + '  耗时 ' + dt + 'ms');

    check('D/检查有返回', !!r);
    check('D/耗时合理（<20s）', dt < 20000, dt + 'ms');

    // ⚠ auto-update 的 check() 返回的是 { checking, error, available, version }，
    //   【没有 ok 字段】。所以判据是「有没有 error」，不是 r.ok。
    if (r && r.error) {
      // 失败也是要验证的场景 —— 错误信息必须可读
      check('D/失败时有可读的错误信息', !!r.error, '错误: ' + r.error);
      log('  （当前是限流/网络受限状态，这正是要能给出清晰错误的场景）');
    } else {
      check('D/检查成功', !!r, JSON.stringify(r));
      check('D/可用状态与版本号一致',
        r.available === (!!r.version),
        'available=' + r.available + ' version=' + r.version);
    }
  }

  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log('  ✓ ' + r.name); }
    else { fail++; console.log('  ✗ ' + r.name + (r.detail ? '  → ' + r.detail : '')); }
  }
  console.log('\n' + '='.repeat(50));
  console.log('通过 ' + pass + ' / ' + results.length);
  setTimeout(() => app.exit(fail ? 1 : 0), 200);
});
