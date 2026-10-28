// Child process: exercise the actual main process and Electron before-quit events.
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const directory = process.argv[process.argv.indexOf('--profile') + 1];
app.setPath('userData', path.join(directory, 'profile'));
const output = path.join(directory, 'proof.json');
const saved = path.join(directory, '退出时保存.md');
let phase = 'cancel', prompts = [];
dialog.showMessageBox = async (_parent, options) => { prompts.push(options); return { response: phase === 'cancel' ? 2 : 0 }; };
dialog.showSaveDialog = async () => ({ canceled: false, filePath: saved });
// Network updates are unrelated to the close lifecycle under test.
const update = require('../src/main/auto-update');
const create = update.createAutoUpdater;
update.createAutoUpdater = options => { const updater = create(options); updater.start = () => {}; return updater; };
const timeout = setTimeout(() => { console.error('Actual app quit timed out'); app.exit(1); }, 20000);
require('../src/main/main');
app.whenReady().then(async () => {
  const window = BrowserWindow.getAllWindows()[0];
  const js = code => window.webContents.executeJavaScript(code);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(test) { for (let i = 0; i < 150; i++) { if (await test()) return; await wait(40); } throw Error('Actual app condition timed out'); }
  try {
    // Test mode is deliberately loaded only in this isolated child profile.
    await window.loadFile(path.resolve(__dirname, '../src/renderer/index.html'), { query: { test: '1' } });
    await until(() => js('!!window.__qingmo && window.__qingmo.tabCount()===1'));
    await js("window.__qingmo.setDoc('退出前必须保存的正文');window.api.setPreferences({closeToBackground:true})");
    window.close(); assert.equal(window.isVisible(), false); assert.equal(prompts.length, 0);
    app.emit('activate'); assert.equal(window.isVisible(), true);
    assert.equal(await js('window.__qingmo.getDoc()'), '退出前必须保存的正文');
    window.close(); assert.equal(window.isVisible(), false);
    const reopened = path.join(directory, '已保存的文件.md'); fs.writeFileSync(reopened, '只读打开不应询问保存');
    app.emit('second-instance', {}, [process.execPath, reopened]);
    await until(async () => window.isVisible() && await js(`window.__qingmo.tabs().some(t=>t.path===${JSON.stringify(reopened)})`));
    assert.equal(await js('window.__qingmo.tabs().filter(t=>t.dirty).length'), 1);
    window.close(); assert.equal(window.isVisible(), false);
    app.quit();
    await until(async () => window.isVisible() && prompts.length === 1 && await js("window.__qingmo.tabs().some(t=>t.dirty&&t.content==='退出前必须保存的正文')"));
    assert.match(prompts[0].detail, /未命名.md/);
    phase = 'save';
    app.once('will-quit', () => {
      try {
        assert.equal(fs.readFileSync(saved, 'utf8'), '退出前必须保存的正文');
        assert.equal(prompts.length, 2);
        fs.writeFileSync(output, JSON.stringify({ passed: true, canceledQuit: true, savedOnQuit: true, restoredWindow: true }));
        clearTimeout(timeout);
      } catch (error) { console.error(error); app.exit(1); }
    });
    app.quit();
  } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
});
