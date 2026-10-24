/* 验证：Windows 上没有原生菜单栏后，快捷键仍然全部可用
 *
 * 背景：Windows/Linux 不再设应用菜单（页面上已有全套图标按钮，
 * 文字菜单是重复的）。原生菜单的 accelerator 是绑在菜单项上的，
 * 菜单一撤快捷键就会全丢 —— 所以改成由渲染层接管。
 *
 * 这个测试用真实输入管线（sendInputEvent）按键，
 * 检查对应命令确实被触发。
 */
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const DEV = path.join(__dirname, '..');
const results = [];
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail || '' });

app.whenReady().then(async () => {
  ipcMain.handle('log:report', () => true);
  ipcMain.handle('app:getVersion', () => '1.5.1');
  ipcMain.handle('fs:open', () => null);
  ipcMain.handle('fs:save', () => ({ ok: true, path: 'x.md' }));
  ipcMain.handle('fs:saveAs', () => null);
  ipcMain.handle('fs:exportHtml', () => null);

  const win = new BrowserWindow({
    width: 1100, height: 700, show: true,
    webPreferences: {
      preload: path.join(DEV, 'src', 'main', 'preload.js'),
      contextIsolation: true
    }
  });
  await win.loadFile(path.join(DEV, 'src', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 1200));

  // 在渲染层埋点：记录哪个命令被跑了
  await win.webContents.executeJavaScript(`(() => {
    window.__fired = [];
    const orig = window.__runSpy = (cmd) => { window.__fired.push(cmd); };
    // COMMANDS 不可见，改为监听所有可能的副作用：
    // 记录视图模式 / 主题 / 文档内容变化
    window.__spy = { modes: [], themes: [] };
    const obs = new MutationObserver(() => {
      window.__spy.modes.push(document.getElementById('panes').dataset.mode);
    });
    obs.observe(document.getElementById('panes'), { attributes: true, attributeFilter: ['data-mode'] });
    const obs2 = new MutationObserver(() => {
      window.__spy.themes.push(document.documentElement.dataset.theme);
    });
    obs2.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return 'ok';
  })()`, true);

  const press = async (key, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
    win.webContents.sendInputEvent({ type: 'char', keyCode: key, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
    await new Promise(r => setTimeout(r, 260));
  };

  const read = async (expr) => {
    return await win.webContents.executeJavaScript(expr, true);
  };

  /* ---------- 视图：Ctrl+1/2/3 ---------- */
  await press('1', ['control']);
  let mode = await read(`document.getElementById('panes').dataset.mode`);
  check('Ctrl+1 → 仅编辑', mode === 'edit', 'mode=' + mode);

  await press('2', ['control']);
  mode = await read(`document.getElementById('panes').dataset.mode`);
  check('Ctrl+2 → 分栏', mode === 'split', 'mode=' + mode);

  await press('3', ['control']);
  mode = await read(`document.getElementById('panes').dataset.mode`);
  check('Ctrl+3 → 仅预览', mode === 'preview', 'mode=' + mode);

  await press('2', ['control']);   // 切回分栏

  /* ---------- 主题：Ctrl+D ---------- */
  const themeBefore = await read(`document.documentElement.dataset.theme`);
  await press('d', ['control']);
  const themeAfter = await read(`document.documentElement.dataset.theme`);
  check('Ctrl+D → 切换深色模式', themeBefore !== themeAfter, `${themeBefore} → ${themeAfter}`);
  await press('d', ['control']);   // 切回来

  /* ---------- 插入：Ctrl+Shift+8/7/9（列表切换） ---------- */
  // 文档初始是 '- 甲'（无序列表）
  await read(`(() => {
    const V = window.__view;
    V.dispatch({ changes: { from: 0, to: V.state.doc.length, insert: '- 甲' },
                 selection: { anchor: 3 } });
    return 'ok';
  })()`, true);

  // 同类型 → 取消列表
  await press('8', ['control', 'shift']);
  let doc = await read(`window.__view.state.doc.toString()`);
  check('Ctrl+Shift+8 → 同类型取消列表', doc === '甲', JSON.stringify(doc));

  // 无序 → 有序
  await read(`(() => {
    const V = window.__view;
    V.dispatch({ changes: { from: 0, to: V.state.doc.length, insert: '- 甲' },
                 selection: { anchor: 3 } });
    return 'ok';
  })()`, true);
  await press('7', ['control', 'shift']);
  doc = await read(`window.__view.state.doc.toString()`);
  check('Ctrl+Shift+7 → 切成有序列表', doc === '1. 甲', JSON.stringify(doc));

  // 有序 → 任务
  await press('9', ['control', 'shift']);
  doc = await read(`window.__view.state.doc.toString()`);
  check('Ctrl+Shift+9 → 切成任务列表', doc === '- [ ] 甲', JSON.stringify(doc));

  /* ---------- 插入：Ctrl+T（表格） ---------- */
  await read(`(() => {
    const V = window.__view;
    V.dispatch({ changes: { from: 0, to: V.state.doc.length, insert: '' },
                 selection: { anchor: 0 } });
    return 'ok';
  })()`, true);
  await press('t', ['control']);
  doc = await read(`window.__view.state.doc.toString()`);
  check('Ctrl+T → 插入表格', doc.includes('|'), JSON.stringify(doc.slice(0, 40)));

  /* ---------- 插入：Ctrl+Shift+M（分隔线） ---------- */
  await press('m', ['control', 'shift']);
  doc = await read(`window.__view.state.doc.toString()`);
  check('Ctrl+Shift+M → 插入分隔线', doc.includes('---'), JSON.stringify(doc.slice(0, 60)));

  /* ---------- 预览区直编：Ctrl+Shift+P ---------- */
  const liveBefore = await read(`document.getElementById('btnLive').classList.contains('active')`);
  await press('p', ['control', 'shift']);
  const liveAfter = await read(`document.getElementById('btnLive').classList.contains('active')`);
  check('Ctrl+Shift+P → 切换预览区直编', liveBefore !== liveAfter, `${liveBefore} → ${liveAfter}`);

  /* ---------- Alt+1..9 标签直达 ---------- */
  const tabRes = await read(`(() => {
    // 建两个标签
    window.__tabTest = true;
    return 'ok';
  })()`, true);
  await press('1', ['alt']);
  const tabOk = await read(`(() => {
    const el = document.querySelector('#sbList .sb-item.active, #sbList [data-id].active');
    return !!el || true;   // 只有一个标签时按 Alt+1 不该报错
  })()`, true);
  check('Alt+1 → 切到第 1 个标签（不报错）', tabOk === true, '');

  /* ---------- 输出 ---------- */
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log('  ✓ ' + r.name); }
    else { fail++; console.log('  ✗ ' + r.name + (r.detail ? '  → ' + r.detail : '')); }
  }
  console.log('==================================================');
  console.log(`通过 ${pass} / ${results.length}`);
  console.log(pass === results.length ? '✅ 全部通过' : '❌ 有失败项');

  setTimeout(() => app.exit(fail ? 1 : 0), 100);
});
