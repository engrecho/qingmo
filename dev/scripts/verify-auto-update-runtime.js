// Electron 更新模块冒烟测试，不访问外网、不执行安装。
if (!process.versions.electron) {
  console.error('用 electron 跑');
  process.exit(1);
}

const path = require('path');

const DEV = path.join(__dirname, '..');
const { app } = require('electron');

const results = [];
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail || '' });

app.whenReady().then(async () => {
  const { createAutoUpdater } = require(path.join(DEV, 'src/main/auto-update'));
  const updater = createAutoUpdater({
    app,
    checkRelease: async () => ({ ok: true, current: app.getVersion(), latest: app.getVersion(), hasUpdate: false }),
    fetch: (...args) => require('electron').net.fetch(...args),
    openInstaller: () => { throw new Error('检查测试不得启动安装程序'); }
  });
  try {
    const result = await updater.checkAndDownload();
    check('模块加载及版本读取', typeof updater.currentVersion() === 'string');
    check('开发模式不下载更新', !result.downloading && !result.ready);
    check('未准备好的安装不能执行', !(await updater.install()).ok);
    for (const r of results) console.log((r.pass ? 'PASS ' : 'FAIL ') + r.name);
    app.exit(results.some(r => !r.pass) ? 1 : 0);
  } catch (error) { console.error(error); app.exit(1); }
});
