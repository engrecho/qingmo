const { app, BrowserWindow, ipcMain } = require('electron');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { attachWindowClose } = require('../src/main/window-close');
const { renameFile } = require('../src/main/rename-file');
const { preferences } = require('../src/main/preferences');
const temporary = process.env.QINGMO_DOCUMENT_TEST_ROOT;
if (!temporary) { console.error('Run this regression using npm run test:documents'); app.exit(1); }
app.setPath('userData', path.join(temporary, 'profile'));
app.on('window-all-closed', () => {});
app.on('before-quit', event => event.preventDefault());
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Document lifecycle regression timed out'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  let action = 'cancel', prompts = [];
  const settings = preferences(app);
  ipcMain.handle('app:autoState', () => ({ phase: 'idle' }));
  ipcMain.on('app:getVersion', e => { e.returnValue = 'test'; });
  ipcMain.handle('log:report', () => true);
  ipcMain.handle('app:rebuildMenu', () => true);
  ipcMain.handle('app:fileAssocStatus', () => ({ ok: true, isQingMo: true }));
  ipcMain.handle('app:confirmClose', (_event, names) => { prompts.push(names); return action; });
  ipcMain.handle('app:getPreferences', () => settings.get());
  ipcMain.handle('app:setPreferences', (_event, patch) => settings.set(patch));
  ipcMain.handle('fs:openPath', (_event, file) => {
    try { return { path: file, content: fs.readFileSync(file, 'utf8') }; }
    catch (error) { return { error: error.message }; }
  });
  ipcMain.handle('fs:save', (_event, file, content) => { fs.writeFileSync(file, content); return { ok: true, path: file }; });
  ipcMain.handle('fs:rename', async (_event, file, name) => {
    try { return await renameFile(file, name); }
    catch (error) { return { ok: false, error: error.code === 'EEXIST' ? '同名文件已存在' : error.message }; }
  });
  const win = new BrowserWindow({ show: true, width: 1200, height: 800, webPreferences: {
    preload: path.resolve(__dirname, '../src/main/preload.js'), contextIsolation: true
  }});
  const js = code => win.webContents.executeJavaScript(code);
  async function until(expression) {
    for (let i = 0; i < 120; i++) { if (await js(expression)) return; await wait(40); }
    throw new Error('Timed out: ' + expression);
  }
  const fileA = path.join(temporary, '甲.md'), fileB = path.join(temporary, '乙.md');
  fs.writeFileSync(fileA, 'saved A'); fs.writeFileSync(fileB, 'saved B');
  async function open(file) {
    win.webContents.send('cmd:openPath', file);
    await until(`window.__qingmo.tabs().some(t=>t.path===${JSON.stringify(file)})`);
    return js(`window.__qingmo.tabs().find(t=>t.path===${JSON.stringify(file)}).id`);
  }
  async function rename(id, name, viaTitle = false) {
    if (viaTitle) {
      const point = await js("(() => {const r=document.getElementById('fileName').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
      win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 2 });
      win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 2 });
      await until("!!document.getElementById('renameDialog')");
    } else await js(`window.__qingmo.renameTab(${id})`);
    await js(`document.querySelector('#renameInput').value=${JSON.stringify(name)};document.querySelector('#renameDialog [data-act=rename]').click()`);
  }
  try {
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'), { query: { test: '1' } });
    await until('window.__qingmo && window.__qingmo.tabCount()===1');
    await js("window.__qingmo.setDoc('\\n  \\n')");
    await js('window.__qingmo.closeActiveTab()'); assert.equal(prompts.length, 0);
    await js("window.__qingmo.setDoc('temporary');window.__qingmo.setDoc('')");
    await js('window.__qingmo.closeActiveTab()'); assert.equal(prompts.length, 0);
    console.log('PASS fresh and erased empty untitled documents close without a prompt');
    const emptyId = await js('window.__qingmo.addTab().id');
    await js(`Promise.all([window.__qingmo.closeTab(${emptyId}),window.__qingmo.closeTab(${emptyId})])`);
    assert.equal(await js('window.__qingmo.tabCount()'), 1);
    console.log('PASS overlapping close requests cannot remove the adjacent tab');

    const idA = await open(fileA), idB = await open(fileB);
    await js(`window.__qingmo.switchTab(${idA});window.__qingmo.switchTab(${idB})`); await wait(350);
    assert.equal(await js('window.__qingmo.tabs().some(t=>t.dirty)'), false);
    assert.equal(await js("document.querySelectorAll('.sb-dot').length"), 0);
    await js("document.querySelector('.cm-content').focus()");
    const modifier = process.platform === 'darwin' ? 'meta' : 'control';
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: [modifier] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: [modifier] }); await wait(100);
    assert.equal(await js('window.__qingmo.getDoc()'), 'saved B');
    console.log('PASS opening/switching files stays clean and undo cannot pull content from another tab');

    await js("window.__qingmo.setDoc('edited B')");
    await until("!!document.querySelector('.sb-item.active .sb-dot')");
    assert(await js("document.querySelector('.sb-item.active .sb-dot').getBoundingClientRect().width > 0"));
    await js("document.querySelector('.cm-content').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: [modifier] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: [modifier] }); await wait(350);
    assert.equal(await js('window.__qingmo.getDoc()'), 'saved B');
    assert.equal(await js('window.__qingmo.tabs().some(t=>t.dirty)'), false);
    await js("window.__qingmo.setDoc('saved B v2');window.__qingmo.saveFile(false)"); await wait(350);
    assert.equal(fs.readFileSync(fileB, 'utf8'), 'saved B v2');
    assert.equal(await js('window.__qingmo.tabs().some(t=>t.dirty)'), false);
    console.log('PASS visible dirty marker, undo to baseline and immediate save stay accurate after delayed sidebar refresh');

    await js(`window.__qingmo.switchTab(${idA});window.__qingmo.setDoc('unsaved A');window.__qingmo.switchTab(${idB})`); await wait(350);
    assert.equal(await js(`window.__qingmo.tabs().find(t=>t.id===${idB}).dirty`), false);
    await js("window.__qingmo.setDoc('unsaved B')");
    assert.equal(await js('window.__qingmo.closeAllTabs()'), false);
    assert.equal(prompts.at(-1).length, 2); assert(prompts.at(-1).some(n => n.includes('甲.md'))); assert(prompts.at(-1).some(n => n.includes('乙.md')));
    action = 'save'; assert.equal(await js('window.__qingmo.closeAllTabs()'), true);
    assert.equal(fs.readFileSync(fileA, 'utf8'), 'unsaved A'); assert.equal(fs.readFileSync(fileB, 'utf8'), 'unsaved B');
    console.log('PASS close-all names only dirty files; cancel preserves tabs; save writes all and closes');

    assert.equal(await js('window.__qingmo.reopenClosed()'), true);
    assert.equal(await js('window.__qingmo.getDoc()'), 'unsaved B');
    await js("document.getElementById('sbClosedHistory').click()");
    assert.match(await js("document.getElementById('closedHistoryDialog').innerText"), /甲.md/);
    await js("document.querySelector('#closedHistoryDialog .closed-file').click()");
    await until("!document.getElementById('closedHistoryDialog')");
    assert.equal(await js('window.__qingmo.getDoc()'), 'unsaved A');
    await js('window.__qingmo.closeActiveTab()'); fs.unlinkSync(fileA);
    assert.equal(await js(`window.__qingmo.reopenClosed(${JSON.stringify(fileA)})`), false);
    assert.equal(await js('window.__qingmo.getDoc()'), 'unsaved B'); fs.writeFileSync(fileA, 'unsaved A');
    console.log('PASS closed-history list and reopen-last read disk; missing files do not alter current content');

    const currentId = await js(`window.__qingmo.tabs().find(t=>t.path===${JSON.stringify(fileB)}).id`);
    await js("window.__qingmo.setDoc('unsaved rename content')");
    await rename(currentId, '重命名', true); await until("!document.getElementById('renameDialog')");
    const newPath = path.join(temporary, '重命名.md');
    assert.equal(fs.existsSync(fileB), false); assert.equal(fs.readFileSync(newPath, 'utf8'), 'unsaved B');
    assert.equal(await js('window.__qingmo.getDoc()'), 'unsaved rename content');
    assert.equal(await js(`window.__qingmo.tabs().find(t=>t.id===${currentId}).dirty`), true);
    await js('window.__qingmo.saveFile(false)'); assert.equal(fs.readFileSync(newPath, 'utf8'), 'unsaved rename content');
    await rename(currentId, '甲.md'); await until("document.getElementById('renameError').textContent.includes('同名')");
    assert.equal(fs.readFileSync(fileA, 'utf8'), 'unsaved A');
    await js("document.querySelector('#renameDialog [data-act=cancel]').click()");
    const blank = await js('window.__qingmo.addTab().id'); await rename(blank, '草稿'); await until("!document.getElementById('renameDialog')");
    const before = prompts.length; await js('window.__qingmo.closeActiveTab()'); assert.equal(prompts.length, before);
    console.log('PASS rename preserves unsaved edits, saves to new path, refuses collisions and supports untitled names');

    await open(fileA); await js("window.__qingmo.setDoc('')"); action = 'cancel';
    await js('window.__qingmo.closeActiveTab()'); assert(prompts.at(-1).some(n => n.includes('甲.md')));
    await js('localStorage.setItem("mdx.session",localStorage.getItem("mdx.session"))');
    await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.reload(); });
    await until('window.__qingmo && window.__qingmo.tabs().some(t=>t.dirty)');
    assert.equal(await js('window.__qingmo.getDoc()'), '');
    assert.equal(await js(`window.__qingmo.tabs().find(t=>t.path===${JSON.stringify(fileA)}).dirty`), true);
    await js("document.getElementById('sbClosedHistory').click()");
    assert(await js("document.querySelector('#closedHistoryDialog .closed-file').textContent.includes('甲.md')"));
    await js("document.querySelector('#closedHistoryDialog [data-act=cancel]').click()");
    console.log('PASS clearing a saved file still warns; empty dirty draft survives reload');
    await js(`(() => { const session=JSON.parse(localStorage.getItem('mdx.session'));const item=session.list.find(t=>t.path===${JSON.stringify(fileA)});item.content='unsaved A';item.dirty=true;localStorage.setItem('mdx.session',JSON.stringify(session)); })()`);
    await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.reload(); });
    await until('window.__qingmo && window.__qingmo.tabs().some(t=>t.path)');
    assert.equal(await js('window.__qingmo.tabs().some(t=>t.dirty)'), false);
    await js("window.__qingmo.setDoc('')");
    console.log('PASS legacy false-dirty session is corrected by comparing with disk content');

    await js("window.__qingmo.run('app:settings')"); await until("!document.querySelector('[data-set=background]').disabled");
    await js("document.querySelector('[data-set=background]').click()");
    for (let i = 0; !settings.get().closeToBackground && i < 100; i++) await wait(25);
    assert.equal(settings.get().closeToBackground, true);
    await js("document.querySelector('#settingsDialog [data-act=close]').click()");
    const fakeApp = new EventEmitter(); let quitApproved = false;
    fakeApp.quit = () => { quitApproved = true; win.close(); };
    attachWindowClose({ app: fakeApp, window: win, ipcMain, keepInBackground: () => settings.get().closeToBackground });
    const priorPrompts = prompts.length;
    win.close(); assert.equal(win.isVisible(), false); assert.equal(prompts.length, priorPrompts);
    fakeApp.emit('before-quit'); win.close();
    for (let i = 0; (!win.isVisible() || prompts.length === priorPrompts) && i < 100; i++) await wait(25);
    assert.equal(win.isVisible(), true); assert.equal(quitApproved, false);
    assert.equal(await js(`window.__qingmo.tabs().find(t=>t.path===${JSON.stringify(fileA)}).dirty`), true);
    action = 'discard'; fakeApp.emit('before-quit'); win.close();
    for (let i = 0; !win.isDestroyed() && i < 100; i++) await wait(25);
    assert.equal(quitApproved, true); assert.equal(win.isDestroyed(), true);
    assert.equal(fs.readFileSync(fileA, 'utf8'), 'unsaved A');
    console.log('PASS settings toggle persists; background close retains tabs; quit cancel restores window; approved quit closes all');
    clearTimeout(deadline); await wait(300); fs.writeFileSync(path.join(temporary, 'renderer-proof.json'), JSON.stringify({ passed: true })); app.exit(0);
  } catch (error) {
    console.error(error); clearTimeout(deadline); if (!win.isDestroyed()) win.destroy(); await wait(300);
    app.exit(1);
  }
});
