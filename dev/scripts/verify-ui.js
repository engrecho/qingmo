#!/usr/bin/env node
/**
 * 真机 UI 验证（Electron 真实窗口）
 *
 * 覆盖那些纯 DOM 测试跑不到、必须在真实编辑器里验的行为：
 *   1. 列表 / 任务 / 引用：光标在行中间时，作用于**行首**而不是光标处
 *   2. 同类前缀再点一次能撤掉（toggle）
 *   3. live-edit 预览区打字时不丢焦点（旧版 80ms 一次 innerHTML 重建会吃掉焦点）
 *   4. 顺手截标题栏，检查 LOGO 显示尺寸
 *
 * 用法：npx electron --no-sandbox --disable-gpu scripts/verify-ui.js
 */
if (!process.versions.electron) {
  console.error('用 electron 跑：npx electron --no-sandbox --disable-gpu scripts/verify-ui.js');
  process.exit(1);
}

const path = require('path');
const fs = require('fs');
const DEV = path.join(__dirname, '..');
const { app, BrowserWindow, ipcMain } = require('electron');

app.whenReady().then(async () => {
  ipcMain.handle('app:autoState', () => ({ phase: 'idle', ready: false }));
  const win = new BrowserWindow({
    width: 1280, height: 820, show: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(DEV, 'src', 'main', 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  win.loadFile(path.join(DEV, 'src', 'renderer', 'index.html'), { query: { test: '1' } });
  await new Promise(res => win.webContents.once('did-finish-load', res));
  await new Promise(res => setTimeout(res, 700));

  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail || '' });
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const ready = await js('!!window.__qingmo');
  if (!ready) {
    check('测试钩子注入', false, 'window.__qingmo 不存在');
  } else {
    check('测试钩子注入', true);

    /* ---------- 1. 无序列表：在行首插入，不动光标 ---------- */
    let r = await js(`(() => {
      const q = window.__qingmo;
      q.setDoc('第一行\\n第二行内容', 0);
      q.setCursor(6);            // 落在「第二行内容」的中间
      q.run('ins:ul');
      return q.getDoc();
    })()`);
    check('列表/行首插入', r === '第一行\n- 第二行内容', JSON.stringify(r));

    /* ---------- 2. 再点一次撤掉 ---------- */
    r = await js(`(() => {
      const q = window.__qingmo;
      q.run('ins:ul');
      return q.getDoc();
    })()`);
    check('列表/再次点击撤销', r === '第一行\n第二行内容', JSON.stringify(r));

    /* ---------- 3. 有序列表带序号 ---------- */
    r = await js(`(() => {
      const q = window.__qingmo;
      q.setDoc('甲\\n乙', 0);
      q.setCursor(1);
      q.run('ins:ol');
      return q.getDoc();
    })()`);
    check('有序列表/行首带序号', r === '1. 甲\n乙', JSON.stringify(r));

    /* ---------- 4. 多行选区：每行都加，序号递增 ---------- */
    r = await js(`(() => {
      const q = window.__qingmo;
      q.setDoc('甲\\n乙\\n丙', 0);
      q.setCursor(0);
      q.run('ins:ol');          // 无选区 → 只影响第一行
      return q.getDoc();
    })()`);
    check('有序列表/无选区只改当前行', r === '1. 甲\n乙\n丙', JSON.stringify(r));

    /* ---------- 5. 任务列表 ---------- */
    r = await js(`(() => {
      const q = window.__qingmo;
      q.setDoc('待办一行', 0);
      q.setCursor(3);
      q.run('ins:todo');
      return q.getDoc();
    })()`);
    check('任务列表/行首插入', r === '- [ ] 待办一行', JSON.stringify(r));

    /* ---------- 6. 引用 ---------- */
    r = await js(`(() => {
      const q = window.__qingmo;
      q.setDoc('引文一行', 0);
      q.setCursor(2);
      q.run('ins:quote');
      return q.getDoc();
    })()`);
    check('引用/行首插入', r === '> 引文一行', JSON.stringify(r));

    /* ---------- 7. live-edit 打字不丢焦点 ---------- */
    await js(`(() => {
      const q = window.__qingmo;
      q.setLiveEdit(true);
      q.setDoc('# 标题\\n\\n这一段用来验证焦点', 0);
      return true;
    })()`);
    await new Promise(res => setTimeout(res, 300));
    r = await js(`(async () => {
      const q = window.__qingmo;
      const preview = document.getElementById('preview');
      q.focusInPreview(1);                    // 聚焦宿主 + 选区放到第 2 个 block 末尾
      const before = document.activeElement;
      const inPreviewBefore = preview.contains(before);
      document.execCommand('insertText', false, '啊');
      await new Promise(r2 => setTimeout(r2, 300));   // 等过 80ms 的重渲染窗口
      const after = document.activeElement;
      return {
        inPreviewBefore,
        stillInPreview: preview.contains(after),
        sameNode: before === after,
        doc: q.getDoc()
      };
    })()`);
    check('live-edit/打字前焦点在预览区', r && r.inPreviewBefore, JSON.stringify(r));
    check('live-edit/打字后焦点仍在预览区', r && r.stillInPreview && r.sameNode, JSON.stringify(r));
    check('live-edit/输入内容回写源码', r && /验证焦点啊/.test(r.doc), JSON.stringify(r && r.doc));
  }

  /* ---------- 8. 标题栏截图（看 LOGO 尺寸）---------- */
  const shot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(DEV, '..', '.cache', 'verify-ui-titlebar.png'),
    shot.crop({ x: 0, y: 0, width: shot.getSize().width, height: 170 }).toPNG());

  const pass = results.filter(x => x.pass).length;
  const fail = results.filter(x => !x.pass).length;
  for (const r of results) {
    console.log((r.pass ? '  PASS ' : '  FAIL ') + r.name + (r.detail ? '  → ' + r.detail : ''));
  }
  console.log('\n' + (fail ? 'FAIL' : 'OK') + ': ' + pass + ' / ' + (pass + fail));
  app.exit(fail ? 1 : 0);
}).catch(e => { console.error('ERR: ' + (e.stack || e.message)); app.exit(1); });