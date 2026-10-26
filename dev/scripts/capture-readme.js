// 真实渲染器截图：只使用独立演示文档，不接触用户会话或文件。
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qingmo-readme-'));
const examples = ['把想法写下来.md', '让阅读安静一点.md', '直接在预览里修改.md'];
app.setPath('userData', temporary);
app.whenReady().then(async () => {
  ipcMain.handle('app:autoState', () => ({ phase: 'idle' }));
  ipcMain.on('app:getVersion', e => { e.returnValue = require('../package.json').version; });
  ipcMain.handle('log:report', () => true);
  ipcMain.handle('fs:openPath', (_event, filename) => {
    assert(examples.includes(filename));
    return { path: '示例文档/' + filename, content: fs.readFileSync(path.join(root, 'docs/examples', filename), 'utf8') };
  });
  const win = new BrowserWindow({ width: 1440, height: 960, show: false, webPreferences: {
    preload: path.join(root, 'dev/src/main/preload.js'), contextIsolation: true
  }});
  const js = text => win.webContents.executeJavaScript(text);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const output = path.join(root, 'docs/assets');
  async function open(filename) {
    win.webContents.send('cmd:openPath', filename);
    await wait(500);
    assert.equal(await js('window.__qingmo.getDoc()'), fs.readFileSync(path.join(root, 'docs/examples', filename), 'utf8'));
  }
  async function capture(name) {
    await wait(600);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(output, name), image.toPNG());
    console.log('已生成', name, image.getSize());
  }
  try {
    await win.loadFile(path.join(root, 'dev/src/renderer/index.html'), { query: { test: '1' } });
    await wait(600);
    // 初始化独立演示会话，随后打开三个真实示例文件。
    await js('window.__qingmo.setDoc("")');
    for (const filename of examples.slice().reverse()) await open(filename);
    await js(`document.querySelector('[data-view=split]').click();window.__qingmo.toggleOutline(true);if(document.documentElement.dataset.theme==='dark')document.getElementById('btnTheme').click()`);
    await capture('writing-light.png');

    await open(examples[1]);
    await js(`document.querySelector('[data-view=preview]').click();document.getElementById('btnTheme').click();document.getElementById('btnCollapse').click();window.__qingmo.toggleOutline(false)`);
    assert.equal(await js('document.documentElement.dataset.theme'), 'dark');
    await capture('reading-dark.png');

    await open(examples[2]);
    await js(`document.getElementById('btnTheme').click();window.__qingmo.toggleOutline(true);window.__qingmo.setLiveEdit(true)`);
    await wait(2400); // 等真实模式切换提示消失。
    await js(`(() => {const preview=document.getElementById('preview');preview.focus();const paragraph=preview.querySelector('h2 + p');const range=document.createRange();range.selectNodeContents(paragraph);range.collapse(false);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range)})()`);
    await win.webContents.insertText(' 让每一句话，更接近你的本意。');
    await wait(500);
    assert.match(await js('window.__qingmo.getDoc()'), /让每一句话，更接近你的本意/);
    await capture('preview-edit.png');
    win.destroy(); fs.rmSync(temporary, { recursive: true, force: true }); app.exit(0);
  } catch (error) { console.error(error); win.destroy(); fs.rmSync(temporary, { recursive: true, force: true }); app.exit(1); }
});
