const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('path'),fs=require('fs'),os=require('os'),assert=require('assert/strict');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qingmo-outline-'));app.setPath('userData',tmp);
app.whenReady().then(async()=>{
 ipcMain.handle('app:autoState',()=>({phase:'idle'}));ipcMain.handle('log:report',()=>true);ipcMain.on('app:getVersion',e=>e.returnValue='test');
 const win=new BrowserWindow({width:1360,height:850,show:false,webPreferences:{preload:path.join(__dirname,'../src/main/preload.js'),contextIsolation:true}});
 const js=code=>win.webContents.executeJavaScript(code);const wait=()=>new Promise(r=>setTimeout(r,350));
 try{
 await win.loadFile(path.join(__dirname,'../src/renderer/index.html'),{query:{test:'1'}});await wait();
 const text='# 大纲示例\n\n## **编辑**功能\n\n正文\n\n```md\n# 代码不是标题\n```\n\n旧式标题\n---\n\n## 重复标题\n\n## 重复标题';
 await js(`window.__qingmo.setDoc(${JSON.stringify(text)})`);await wait();
 assert.deepEqual(await js("[...document.querySelectorAll('#outlineList button')].map(b=>b.textContent)"),['大纲示例','编辑功能','旧式标题','重复标题','重复标题']);console.log('PASS 标题层级、行内格式、Setext、排除代码块');
 await js("document.querySelector('#outlineList button:last-child').click()");
 assert.equal(await js("Number(document.querySelector('#outlineList button.active').dataset.from)"),text.lastIndexOf('## 重复标题'));console.log('PASS 重复标题精确跳转与当前节高亮');
 await js("document.getElementById('closeOutline').click()");assert.equal(await js("document.getElementById('outline').hidden && localStorage.getItem('mdx.outline')==='0'"),true);console.log('PASS 关闭大纲并保存状态');
 await win.reload();await wait();assert.equal(await js("document.getElementById('outline').hidden"),true);console.log('PASS 重启页面保持关闭');
 await js("document.getElementById('btnOutline').click();window.__qingmo.setDoc('# 新标题')");await wait();assert.equal(await js("document.querySelector('#outlineList button').textContent"),'新标题');console.log('PASS 重新开启与编辑更新');
 await js("window.__qingmo.setDoc('没有标题')");await wait();assert.equal(await js("!!document.querySelector('.outline-empty')"),true);console.log('PASS 无标题空状态');
 await js(`window.__qingmo.setDoc(${JSON.stringify(text)})`);await wait();
 await js("document.documentElement.dataset.theme='dark'");
 fs.writeFileSync(path.join(tmp,'outline.png'),(await win.webContents.capturePage()).toPNG());
 fs.copyFileSync(path.join(tmp,'outline.png'),'/tmp/qingmo-outline-preview.png');
 win.destroy();fs.rmSync(tmp,{recursive:true,force:true});app.exit(0);
 }catch(e){console.error(e);win.destroy();fs.rmSync(tmp,{recursive:true,force:true});app.exit(1)}
});
