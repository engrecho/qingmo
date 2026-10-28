// 用真实 Electron 主进程、IPC 和渲染 UI 验证完整流程。
// 网络与系统安装器替换为夹具，不访问外网，不执行安装。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const assert = require('assert/strict');
const { app, net, ipcMain, dialog, shell, BrowserWindow } = require('electron');
const tmp = process.env.QINGMO_UPDATE_TEST_PROFILE;
assert(tmp, 'Use test-update-electron.js wrapper');
app.setPath('userData', tmp);
process.env.QINGMO_FORCE_UPDATE = '1';
const platform = require('../src/main/platform');
// Linux cloud host has no distributed installer; exercise the Windows selector.
if (platform.id === 'base') platform.matchUpdateInstaller = require('../src/main/platform/win').matchUpdateInstaller;
const version = '99.0.0';
const payload = Buffer.from('integration installer fixture');
const name = platform.id === 'mac' ? `QingMo-${version}-mac-${process.arch}.dmg` : `QingMo-${version}-win-setup.exe`;
const url = `https://github.com/engrecho/qingmo/releases/download/v${version}/${name}`;
let checks = 0, downloads = 0, prompts = 0, installs = 0, rateLimited = false;
const handlers = new Map();
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => { assert(!handlers.has(channel), channel); handlers.set(channel, fn); handle(channel, fn); };
const releaseData = { tag_name: 'v' + version, html_url: 'https://github.com/engrecho/qingmo/releases/tag/v' + version, assets: [{ name, size: payload.length, state: 'uploaded', digest: 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex'), browser_download_url: url }] };
const server = http.createServer((request, response) => {
  if (request.url === '/latest') { response.writeHead(302, { location: 'https://github.com/engrecho/qingmo/releases/tag/v' + version }); response.end(); }
  else if (request.url === '/release') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(releaseData));
  } else if (request.url === '/installer') { response.writeHead(302, { location: 'https://release-assets.githubusercontent.com/payload' }); response.end(); } else { response.end(payload); }
});
const listening = new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const realFetch = net.fetch.bind(net);
net.fetch = async (target, options) => {
  await listening;
  const local = `http://127.0.0.1:${server.address().port}`;
  if (target === 'https://api.github.com/repos/engrecho/qingmo/releases/latest') {
    checks++;
    if (rateLimited) return new Response(null, { status: 403 });
    return realFetch(local + '/release', options);
  }
  if (target === url) { downloads++; return realFetch(local + '/installer', options); }
  throw new Error('测试中不允许其他网络请求：' + target);
};

const realRequest = net.request.bind(net);
net.request = options => {
  const target = typeof options === 'string' ? options : options.url;
  const local = `http://127.0.0.1:${server.address().port}`;
  if (target === 'https://github.com/engrecho/qingmo/releases/latest') return realRequest({ ...options, url: local + '/latest' });
  if (target === url) { downloads++; return realRequest({ ...options, url: local + '/installer' }); }
  if (target === 'https://release-assets.githubusercontent.com/payload') return realRequest({ ...options, url: local + '/payload' });
  if (target.startsWith(local + '/')) return realRequest(options);
  throw new Error('Unexpected request: ' + target);
};

dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  if (options.title === '轻墨更新已下载') prompts++;
  return { response: 1 }; // “稍后”不执行安装
};
shell.openPath = async file => { assert.equal(path.basename(file), name); installs++; return ''; };
app.on('window-all-closed', event => event.preventDefault());
const deadline = setTimeout(() => { console.error('更新集成测试超时'); app.exit(1); }, 20000);
async function finish(code) {
  clearTimeout(deadline);
  server.closeAllConnections();
  server.close();
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  if (code === 0) fs.writeFileSync(path.join(tmp, 'passed'), path.basename(__filename));
  app.exit(code);
}
process.on('uncaughtException', error => { console.error(error); void finish(1); });
require('../src/main/main');
app.whenReady().then(async () => {
  try {
    const result = await handlers.get('app:checkUpdate')();
    assert.equal(result.latest, version);
    const until = Date.now() + 10000;
    while (!handlers.get('app:autoState')().ready && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    const state = handlers.get('app:autoState')();
    assert.equal(state.ready, true);
    assert.equal(state.progress, 100);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(prompts, 1);
    assert.equal(installs, 0, '选择稍后不得安装');
    const window = BrowserWindow.getAllWindows()[0];
    if (window.webContents.isLoading()) await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    await window.webContents.executeJavaScript('window.api.autoState().then(s => window.__updateTestState = s)');
    assert.equal((await window.webContents.executeJavaScript('window.__updateTestState')).ready, true);
    // 通过 preload IPC 触发检查，并确认渲染层展示已下载和安装入口。
    await window.webContents.executeJavaScript('window.qingmoCheckUpdate()');
    await new Promise(resolve => setTimeout(resolve, 100));
    const ui = await window.webContents.executeJavaScript(`({ banner: document.querySelector('.update-bar')?.textContent, action: document.querySelector('#updateDialog [data-act="auto"]')?.textContent })`);
    assert.match(ui.banner, /已下载/);
    assert.equal(ui.action, '打开安装包');
    const installed = await handlers.get('app:installUpdate')();
    assert.equal(installed.ok, true);
    assert.equal(installs, 1);
    assert.equal(downloads, 1);
    assert.equal(checks, 2);
    rateLimited = true;
    const fallback = await handlers.get('app:checkUpdate')();
    assert.equal(fallback.degraded, true);
    assert.equal(fallback.latest, version);
    assert.equal(fallback.ready, true, '限流仍保留已校验的安装包');
    console.log('PASS 真实主进程→Release 查询→后台下载→校验→稍后→UI 安装入口→用户确认后打开安装包');
    await finish(0);
  } catch (error) { console.error(error); await finish(1); }
});
