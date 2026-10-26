const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert/strict');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qingmo-close-'));app.setPath('userData',tmp);
app.whenReady().then(async()=>{
 let action='cancel', saved=0, fail=false;
 ipcMain.handle('app:autoState',()=>({phase:'idle'}));
 ipcMain.on('app:getVersion',e=>e.returnValue='test');
 ipcMain.handle('log:report',()=>true);
 ipcMain.handle('app:confirmClose',()=>action);
 ipcMain.handle('fs:saveAs',()=>{if(fail==='error')throw new Error('磁盘写入失败');if(fail)return null;saved++;return{path:'/tmp/close-test.md'}});
 ipcMain.handle('app:rebuildMenu',()=>true);
 const win=new BrowserWindow({show:false,webPreferences:{preload:path.join(__dirname,'../src/main/preload.js'),contextIsolation:true}});
 const js=code=>win.webContents.executeJavaScript(code);
 try {
  await win.loadFile(path.join(__dirname,'../src/renderer/index.html'),{query:{test:'1'}});
  await new Promise(r=>setTimeout(r,500));
  await js("window.__qingmo.setDoc('未保存正文');window.__qingmo.closeActiveTab()");
  assert.equal(await js('window.__qingmo.getDoc()'),'未保存正文');console.log('PASS 返回确认保留正文');
  action='save';fail=true;
  await js('window.__qingmo.closeActiveTab()');assert.equal(await js('window.__qingmo.getDoc()'),'未保存正文');console.log('PASS 取消另存为不关闭');
  fail='error';await js('window.__qingmo.closeActiveTab()');assert.equal(await js('window.__qingmo.getDoc()'),'未保存正文');console.log('PASS 保存失败保留文档');
  fail=false;await js('window.__qingmo.closeActiveTab()');assert.equal(saved,1);assert.equal(await js('window.__qingmo.getDoc()'),'');console.log('PASS 保存成功后关闭');
  await js("window.__qingmo.setDoc('放弃正文')");action='discard';await js('window.__qingmo.closeAllTabs()');assert.equal(await js('window.__qingmo.getDoc()'),'');console.log('PASS 放弃后全部关闭');
  async function windowClose() {
    const result=new Promise(resolve=>ipcMain.once('app:finishClose',(_e,approved)=>resolve(approved)));
    win.webContents.send('app:requestClose');return result;
  }
  await js("window.__qingmo.setDoc('窗口未保存')");action='cancel';assert.equal(await windowClose(),false);assert.equal(await js('window.__qingmo.getDoc()'),'窗口未保存');console.log('PASS 窗口关闭返回确认不批准关闭');
  action='discard';assert.equal(await windowClose(),true);assert.equal(await js("JSON.parse(localStorage.getItem('mdx.session')).list.some(t=>t.dirty||t.content)"),false);console.log('PASS 窗口放弃后批准关闭且草稿不恢复');
  win.destroy();fs.rmSync(tmp,{recursive:true,force:true});app.exit(0);
 }catch(error){console.error(error);win.destroy();fs.rmSync(tmp,{recursive:true,force:true});app.exit(1)}
});
