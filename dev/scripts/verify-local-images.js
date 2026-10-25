const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { pathToFileURL } = require('url');
const { markdownImagePath, resolveImagePath, readLocalImage } = require('../src/main/local-images');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qingmo-images-'));
app.setPath('userData', path.join(tmp, 'profile'));
const image = path.join(tmp, '图片 空格 (1) #%图.png');
fs.copyFileSync(path.join(__dirname, '../build/icons/icon-256.png'), image);
const doc = path.join(tmp, '笔记.md'); fs.writeFileSync(doc, '');
let exported;
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => handle(channel, channel === 'fs:exportHtml' ? (_e, html) => { exported = html; return { path: 'fixture.html' }; } : fn);
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [image] });
const load = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function(file, options = {}) { return load.call(this, file, { ...options, query: { test: '1' } }); };
const deadline = setTimeout(() => { console.error('本地图片测试超时'); app.exit(1); }, 20000);
require('../src/main/main');
app.whenReady().then(async () => {
  let win;
  const js = code => win.webContents.executeJavaScript(code);
  const wait = async expression => {
    for (let i = 0; i < 100; i++) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error('等待失败：' + expression);
  };
  try {
    win = BrowserWindow.getAllWindows()[0];
    if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await wait('!!window.__qingmo');
    const insert = async () => {
      await js("window.__qingmo.setDoc(''); window.__qingmo.run('ins:image'); document.querySelector('[data-act=local]').click()");
      await wait("document.querySelector('#preview img')?.complete && document.querySelector('#preview img').naturalWidth > 0");
      return js('window.__qingmo.getDoc()');
    };
    let markdown = await insert();
    assert(markdown.includes(encodeURI(tmp)), markdown);
    assert(!markdown.includes('base64,'));
    console.log('PASS 未保存文档插入本地图片，特殊字符路径可显示');
    win.webContents.send('cmd:openPath', doc);
    await wait(`document.getElementById('stPath').textContent.includes(${JSON.stringify(doc)})`);
    markdown = await insert();
    assert(markdown.includes(markdownImagePath(image, tmp)), markdown);
    assert(!markdown.includes(tmp), markdown);
    console.log('PASS 已保存文档使用相对路径且实际图片加载成功');
    await js(`window.__qingmo.setDoc(${JSON.stringify('![图片](<' + pathToFileURL(image).href + '>)')})`);
    await wait("document.querySelector('#preview img')?.naturalWidth > 0");
    console.log('PASS 现有 file URL 图片可显示，未放宽 CSP');
    await js("window.__qingmo.setLiveEdit(true); const p = document.querySelector('#preview p'); p.appendChild(document.createTextNode(' 增加文字')); p.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:'增加文字'}))");
    await new Promise(resolve => setTimeout(resolve, 300));
    const edited = await js('window.__qingmo.getDoc()');
    assert(!edited.includes('base64,'));
    assert(edited.includes(pathToFileURL(image).href));
    console.log('PASS 预览编辑保留原始图片路径');
    await js("window.__qingmo.run('cmd:exportHtml')");
    for (let i = 0; i < 100 && !exported; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(exported, /src="data:image\/png;base64,/);
    assert(!exported.includes('data-qingmo-image'));
    console.log('PASS 导出 HTML 内嵌本地图片');
    assert.equal(resolveImagePath('../图片.png', 'C:\\笔记\\子目录\\文档.md', path.win32), 'C:\\笔记\\图片.png');
    assert.equal(resolveImagePath('D:/图片%20(1).png', 'C:\\笔记.md', path.win32), 'D:\\图片 (1).png');
    assert.equal(markdownImagePath('\\\\server\\share\\a b.png', '', path.win32), 'file://server/share/a%20b.png');
    assert.equal((await readLocalImage('https://example.com/a.png', '')).ok, false);
    assert.equal((await readLocalImage(path.join(tmp, 'missing.png'), '')).ok, false);
    console.log('PASS Windows 相对路径、跨盘、UNC 路径与无效图片错误处理');
    clearTimeout(deadline); win.destroy(); fs.rmSync(tmp, { recursive: true, force: true }); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(deadline); win?.destroy(); fs.rmSync(tmp, { recursive: true, force: true }); app.exit(1); }
});
