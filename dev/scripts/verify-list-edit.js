const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qingmo-lists-'));
app.setPath('userData', tmp);
app.whenReady().then(async () => {
  ipcMain.handle('app:autoState', () => ({ phase: 'idle' }));
  ipcMain.handle('log:report', () => true);
  ipcMain.on('app:getVersion', event => { event.returnValue = 'test'; });
  const win = new BrowserWindow({ show: true, webPreferences: { preload: path.join(__dirname, '../src/main/preload.js'), contextIsolation: true } });
  const js = code => win.webContents.executeJavaScript(code);
  const pause = () => new Promise(resolve => setTimeout(resolve, 130));
  const doc = () => js('window.__qingmo.getDoc()');
  async function seed(text) {
    await js(`document.getElementById('listStartDialog')?.remove(); window.__qingmo.setLiveEdit(false); window.__qingmo.setDoc(${JSON.stringify(text)});`);
    await pause();
    await js('window.__qingmo.setLiveEdit(true)');
  }
  async function caret(selector, end = true) {
    await js(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); document.getElementById('preview').focus(); const r=document.createRange(); r.selectNodeContents(el); r.collapse(${!end}); const s=window.getSelection();s.removeAllRanges();s.addRange(r); })()`);
  }
  async function enter() { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }); await pause(); }
  try {
    await win.loadFile(path.join(__dirname, '../src/renderer/index.html'), { query: { test: '1' } }); await pause();
    await seed('- 甲\n- 乙\n\n后文');
    await caret('#preview li:first-child'); await enter(); await win.webContents.insertText('新增'); await pause();
    assert.match(await doc(), /- 甲\n- 新增\n- 乙/); assert.match(await doc(), /后文$/);
    await enter(); await win.webContents.insertText('再新增'); await pause();
    assert.match(await doc(), /- 新增\n- 再新增\n- 乙/);
    console.log('PASS 预览无序列表连续 Enter 续写，后续文档未损坏');
    await seed('5. 甲\n6. 乙'); await caret('#preview li:first-child'); await enter(); await win.webContents.insertText('新增'); await pause();
    assert.match(await doc(), /5\. 甲\n6\. 新增\n7\. 乙/);
    console.log('PASS 自定义起点有序列表续写与后续重编号');
    await seed('- 甲'); await caret('#preview li'); await enter(); await enter(); await win.webContents.insertText('正文'); await pause();
    assert.match(await doc(), /- 甲\n\n正文/);
    console.log('PASS 空列表项 Enter 退出并继续普通段落');
    await seed('- 父\n  - 子\n- 后'); await caret('#preview li li'); await enter(); await win.webContents.insertText('新子项'); await pause();
    assert.match(await doc(), /  - 子\n  - 新子项/);
    console.log('PASS 嵌套列表续写保持层级');
    await seed('0. 甲'); await caret('#preview li'); await enter(); await win.webContents.insertText('乙'); await pause();
    assert.match(await doc(), /0\. 甲\n1\. 乙/);
    console.log('PASS 从零开始的自定义编号保持不变');

    await seed('2. 乙\n3. 丙'); await caret('#preview li:first-child');
    const marker = await js("(() => {const r=document.querySelector('#preview li').getBoundingClientRect(); return {x:Math.round(r.left-10),y:Math.round(r.top+10)}})()");
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...marker});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...marker});
    await pause();
    await js("document.querySelector('#listStartDialog [data-act=apply]').click()");
    assert.equal(await doc(), '1. 乙\n2. 丙');
    await js("window.__qingmo.run('list:start'); const input=document.getElementById('listStartNumber');input.value='7';input.dispatchEvent(new Event('input'));document.querySelector('#listStartDialog [data-act=apply]').click()");
    assert.equal(await doc(), '7. 乙\n8. 丙');
    console.log('PASS 删除第一项后可从 1 或指定数字重新编号');
    assert.equal(await js("!!document.querySelector('[data-cmd=\"list:start\"]')"), false);
    await js(`window.__qingmo.setLiveEdit(false);window.__qingmo.setDoc(${JSON.stringify('2. 源码甲\n3. 源码乙')},0)`); await pause();
    const sourceMarker = await js("(() => {const el=document.querySelector('.cm-line'); const text=document.createTreeWalker(el,NodeFilter.SHOW_TEXT).nextNode();const range=document.createRange();range.selectNode(text); const r=range.getBoundingClientRect();return {x:Math.round(r.left+2),y:Math.round((r.top+r.bottom)/2)}})()");
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...sourceMarker});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...sourceMarker});await pause();
    assert.equal(await js("!!document.getElementById('listStartDialog')"),true);
    await js("document.querySelector('#listStartDialog [data-act=apply]').click()");
    assert.equal(await doc(),'1. 源码甲\n2. 源码乙');
    console.log('PASS 源码序号可直接点击，且工具栏起始按钮已移除');

    await seed('- **保留**\n- **清除** [链接](https://example.com)'); await caret('#preview li:nth-child(2)');
    await js("document.querySelector('[data-cmd=\"fmt:clear\"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));document.querySelector('[data-cmd=\"fmt:clear\"]').click()");
    assert.equal(await doc(), '- **保留**\n清除 链接');
    console.log('PASS 预览工具栏只清除光标当前行，保留其他行');
    await js("window.__qingmo.setLiveEdit(false);window.__qingmo.setDoc('## **第一行**\\n> - __第二行__', 25)");
    await pause(); await js("window.__qingmo.run('fmt:clear')");
    assert.equal(await doc(), '## **第一行**\n第二行');
    console.log('PASS 源码一键清除当前行复合格式');
    await seed('- 甲'); await caret('#preview li');
    const prevented = await js("(() => {const e=new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true});document.getElementById('preview').dispatchEvent(e);return e.defaultPrevented})()");
    assert.equal(prevented, false);
    console.log('PASS 中文输入法确认不会被列表续写拦截');
    win.destroy(); fs.rmSync(tmp,{recursive:true,force:true}); app.exit(0);
  } catch (error) { console.error(error); win.destroy();fs.rmSync(tmp,{recursive:true,force:true});app.exit(1); }
});
