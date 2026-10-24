#!/usr/bin/env node
/**
 * 诊断日志真机测试
 *
 * 验证三件事：
 *   1. 日志文件真的落盘了
 *   2. 启动 header 里有版本 / 平台 / argv
 *   3. 「打开文件」的各种失败原因都被记录了（这是用户反馈的核心）
 *
 * 用法：npx electron --no-sandbox --disable-gpu scripts/verify-log.js
 */
if (!process.versions.electron) {
  console.error('用 electron 跑');
  process.exit(1);
}

const path = require('path');
const fs = require('fs');
const util = require('util');
const log = (...a) => console.error(util.format(...a));

const DEV = path.join(__dirname, '..');
const { app, BrowserWindow, ipcMain } = require('electron');

const results = [];
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail || '' });

app.whenReady().then(async () => {
  const logger = require(path.join(DEV, 'src', 'main', 'logger.js'));

  // 这个脚本没有跑 main.js，所以 IPC handler 要自己注册一份
  // （否则渲染层 reportLog 会报 "No handler registered"）
  ipcMain.handle('log:report', (_e, payload) => {
    logger.fromRenderer(payload);
    return true;
  });
  ipcMain.handle('log:tail', async () => logger.tail(800));
  ipcMain.handle('log:export', async () => ({ text: logger.tail(800) }));

  // 1. 初始化
  const inited = logger.init(app);
  check('日志系统初始化', inited);
  // ⚠ 日志是「合并写盘」—— 缓冲 300ms 后才 appendFileSync。
  //   所以 init 之后立刻 existsSync 会是 false（当天第一个日志文件时必失败，
  //   之后就因为文件已存在而侥幸通过）。这里等落盘完成再断言。
  await new Promise(r => setTimeout(r, 500));
  check('日志文件已创建', !!logger.file() && fs.existsSync(logger.file()), logger.file());

  // 2. 写几条不同级别的
  logger.info('测试 INFO', { a: 1 });
  logger.warn('测试 WARN', { b: 2 });
  logger.error('测试 ERROR', { c: 3 });

  // 3. 文件打开的失败原因
  logger.fileOpenAttempt('/tmp/xxx.md', false, '扩展名不支持（支持: .md）');
  logger.fileOpenAttempt('/tmp/nope.md', false, '文件不存在');
  logger.fileOpenAttempt('/tmp/ok.md', true, '已投喂渲染层');

  // 4. 渲染进程上报
  logger.fromRenderer({ kind: 'live-edit', message: '模拟的渲染错误', stack: 'stack here' });
  logger.fromRenderer({ kind: 'info', message: '模拟的渲染信息' });
  logger.fromRenderer({ kind: 'warn', message: '模拟的渲染警告' });

  // 5. 刷盘后读回
  logger.flush();
  const text = logger.tail(100);
  check('日志内容非空', text.length > 0, '长度 ' + text.length);
  check('含启动 header', text.includes('轻墨 QingMo 启动'), '');
  check('含版本号', text.includes('version'), '');
  check('含启动参数', text.includes('启动参数 argv'), '');
  check('含 INFO 记录', text.includes('测试 INFO'), '');
  check('含 WARN 记录', text.includes('测试 WARN'), '');
  check('含 ERROR 记录', text.includes('测试 ERROR'), '');
  check('含扩展名失败原因', text.includes('扩展名不支持'), '');
  check('含文件不存在原因', text.includes('文件不存在'), '');
  check('含成功记录', text.includes('已投喂渲染层'), '');
  check('含渲染进程错误', text.includes('模拟的渲染错误'), '');
  check('info 不被记成 ERROR', /\[INFO\].*模拟的渲染信息/.test(text), 'info 级别被错误地记成了 ERROR');
  check('warn 不被记成 ERROR', /\[WARN\].*模拟的渲染警告/.test(text), 'warn 级别被错误地记成了 ERROR');
  check('error 仍是 ERROR', /\[ERROR\].*模拟的渲染错误/.test(text), '');

  // 6. tail 只返回末尾
  const all = fs.readFileSync(logger.file(), 'utf8').split('\n');
  const t = logger.tail(3).split('\n').filter(Boolean);
  check('tail 限制行数', t.length <= 3, '实际 ' + t.length + ' 行');

  // 7. 清理旧日志
  const removed = logger.cleanup(14);
  check('清理旧日志不报错', typeof removed === 'number', '移除 ' + removed + ' 个');

  // 8. 渲染层 logger 的 IPC 上报
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(DEV, 'src', 'main', 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  await win.loadFile(path.join(DEV, 'src', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 800));

  // 触发一个渲染层异常，看能不能进日志
  await win.webContents.executeJavaScript(`(() => {
    window.dispatchEvent(new ErrorEvent('error', {
      message: '测试用渲染异常', filename: 'test.js', lineno: 1, colno: 1
    }));
  })()`);
  await new Promise(r => setTimeout(r, 600));

  logger.flush();
  const text2 = logger.tail(200);
  check('渲染进程异常已进日志', text2.includes('测试用渲染异常'),
    text2.slice(-300));

  // 9. 文件名用【本地日期】而不是 UTC
  {
    const day = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const local = day.getFullYear() + '-' + pad(day.getMonth() + 1) + '-' + pad(day.getDate());
    check('日志文件名用本地日期', logger.file().includes(local),
      logger.file() + ' 期望含 ' + local);
    // UTC 日期在东八区凌晨会差一天 —— 这是当初的 bug
    const utc = new Date().toISOString().slice(0, 10);
    if (local !== utc) {
      check('（当前 UTC 与本地日期不同，正是回归场景）', true, 'local=' + local + ' utc=' + utc);
    }
  }

  // 10. 日志目录位置
  check('日志在 userData 下',
    logger.dir().includes(app.getPath('userData')),
    logger.dir() + ' vs ' + app.getPath('userData'));

  // 汇报
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log('  ✓ ' + r.name); }
    else { fail++; console.log('  ✗ ' + r.name + (r.detail ? '  → ' + r.detail : '')); }
  }
  console.log('\n' + '='.repeat(50));
  console.log('通过 ' + pass + ' / ' + results.length);
  console.log('日志文件: ' + logger.file());
  if (fail) { console.log('失败 ' + fail); setTimeout(() => app.exit(1), 100); return; }
  console.log('✅ 全部通过');
  setTimeout(() => app.exit(0), 100);
});
