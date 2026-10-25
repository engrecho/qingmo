/* 验证本次 UI 改动：
 *   ① 深色模式 gutter 不是白底、光标是白色
 *   ② 主题按钮在第二行末尾
 *   ③ 标题栏没有 logo
 *   ④ 清除格式命令
 *   ⑤ 列表类型三者互相切换
 *   ⑥ 插入图片弹窗有「本地 / 远程」两个选项
 *   ⑦ 设置面板能打开，且收纳了页面上没有的功能
 */
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const DEV = path.join(__dirname, '..');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
}

app.whenReady().then(async () => {
  ipcMain.handle('app:autoState', () => ({ phase: 'idle' }));
  ipcMain.on('app:getVersion', event => { event.returnValue = 'test'; });
  // 渲染层会调这些 IPC
  ipcMain.handle('log:report', () => true);
  ipcMain.handle('fs:pickImage', () => null);
  ipcMain.handle('app:fileAssocStatus', () => ({ ok: true, progid: 'QingMo', isQingMo: true }));
  ipcMain.handle('app:repairFileAssoc', () => ({ ok: true }));
  ipcMain.handle('app:devtools', () => true);
  ipcMain.handle('log:export', () => ({ ok: true }));
  ipcMain.handle('app:checkUpdate', () => ({ ok: false, error: '测试环境不联网' }));

  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: {
      preload: path.join(DEV, 'src', 'main', 'preload.js'),
      contextIsolation: true
    }
  });
  await win.loadFile(path.join(DEV, 'src', 'renderer', 'index.html'), { query: { test: '1' } });
  await new Promise(r => setTimeout(r, 1200));

  /* ============ A. 深色模式的 gutter 与光标 ============ */
  const a = await win.webContents.executeJavaScript(`(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const gut = document.querySelector('.cm-gutters');
    const cs = gut ? getComputedStyle(gut) : null;
    const cur = document.querySelector('.cm-cursor');
    return {
      gutterBg: cs ? cs.backgroundColor : null,
      // CodeMirror 用 .cm-cursor 画光标（原生 caret 是 transparent），
      // 所以光标颜色要看 .cm-cursor 的 border-left-color
      cursorBorder: cur ? getComputedStyle(cur).borderLeftColor : null,
      themeVar: getComputedStyle(document.documentElement).getPropertyValue('--caret').trim()
    };
  })()`, true);

  // 深色下 gutter 背景应该是深色（c-25 = #191c21 = rgb(25,28,33)）
  const bg = a.gutterBg || '';
  const nums = bg.match(/\d+/g);
  const lum = nums ? (Number(nums[0]) + Number(nums[1]) + Number(nums[2])) / 3 : 255;
  check('A/深色模式 gutter 不是白底', lum < 100, `gutterBg=${bg} 亮度=${lum.toFixed(0)}`);
  check('A/深色模式 --caret 是白色', a.themeVar.toLowerCase() === '#ffffff', '--caret=' + a.themeVar);
  check('A/光标是白色',
    a.cursorBorder === 'rgb(255, 255, 255)',
    'cursorBorder=' + a.cursorBorder);

  /* ============ B. 工具栏布局 ============ */
  const b = await win.webContents.executeJavaScript(`(() => {
    const theme = document.getElementById('btnTheme');
    const settings = document.getElementById('btnSettings');
    const row2 = document.querySelector('.tb-row-2');
    const row1 = document.querySelector('.tb-row-1');
    const clear = document.querySelector('[data-cmd="fmt:clear"]');
    const logo = document.querySelector('.logo');
    const tr = theme.getBoundingClientRect();
    const sr = settings.getBoundingClientRect();
    return {
      themeInRow2: row2.contains(theme),
      themeInRow1: row1.contains(theme),
      settingsInRow2: row2.contains(settings),
      // 主题按钮应该在第二行最右边（后面只有设置按钮）
      themeRight: tr.right, settingsRight: sr.right, winW: window.innerWidth,
      hasLogo: !!logo,
      hasClearBtn: !!clear,
      titlebarText: (document.querySelector('.brand') || {}).textContent || ''
    };
  })()`, true);

  check('B/主题按钮在第二行', b.themeInRow2 && !b.themeInRow1, JSON.stringify({ row2: b.themeInRow2, row1: b.themeInRow1 }));
  check('B/主题按钮在行末尾（设置按钮之后就是窗口右缘）',
    b.settingsRight <= b.winW - 4 && b.themeRight < b.settingsRight,
    `theme.right=${b.themeRight} settings.right=${b.settingsRight} win=${b.winW}`);
  check('B/设置按钮在第二行', b.settingsInRow2, '');
  check('B/标题栏没有 logo', !b.hasLogo, 'brand 文本=' + JSON.stringify(b.titlebarText));
  check('B/有清除格式按钮', b.hasClearBtn, '');

  /* ============ C. 清除格式 ============ */
  const c = await win.webContents.executeJavaScript(`(() => {
    const V = window.__view;
    const setDoc = (d, p) => V.dispatch({
      changes: { from: 0, to: V.state.doc.length, insert: d }, selection: { anchor: p }
    });
    const get = () => V.state.doc.toString();

    // ## 标题 + **粗体** + ~~删除~~
    setDoc('## 标题 **粗体** ~~删~~', 0);
    document.querySelector('[data-cmd="fmt:clear"]').click();
    const afterHead = get();

    // 列表 + 引用
    setDoc('- 列表项', 0);
    document.querySelector('[data-cmd="fmt:clear"]').click();
    const afterList = get();

    return JSON.stringify({ afterHead, afterList });
  })()`, true);
  const cj = JSON.parse(c);
  check('C/清除格式去掉标题标记', cj.afterHead === '标题 粗体 删', JSON.stringify(cj.afterHead));
  check('C/清除格式去掉列表标记', cj.afterList === '列表项', JSON.stringify(cj.afterList));

  /* ============ D. 列表类型互相切换 ============ */
  const d = await win.webContents.executeJavaScript(`(() => {
    const V = window.__view;
    const setDoc = (d, p) => V.dispatch({
      changes: { from: 0, to: V.state.doc.length, insert: d }, selection: { anchor: p }
    });
    const get = () => V.state.doc.toString();
    const click = (cmd) => document.querySelector('[data-cmd="' + cmd + '"]').click();
    const out = {};

    // 无序 → 有序
    setDoc('- 甲', 3); click('ins:ol');  out.ul2ol = get();
    // 有序 → 任务
    setDoc('1. 甲', 4); click('ins:todo'); out.ol2todo = get();
    // 任务 → 无序
    setDoc('- [ ] 甲', 6); click('ins:ul'); out.todo2ul = get();
    // 无序 → 任务
    setDoc('- 甲', 3); click('ins:todo'); out.ul2todo = get();
    // 任务 → 有序
    setDoc('- [ ] 甲', 6); click('ins:ol'); out.todo2ol = get();
    // 同类型 → 取消
    setDoc('- 甲', 3); click('ins:ul'); out.sameCancel = get();
    // 有序 → 有序（应取消，不是保持）
    setDoc('1. 甲', 4); click('ins:ol'); out.ol2ol = get();
    // 普通行 → 无序
    setDoc('甲', 1); click('ins:ul'); out.plain2ul = get();
    // 多行有序 → 无序（编号应重排）—— 要真的选中两行
    setDoc('1. 甲\\n2. 乙', 0);
    V.dispatch({ selection: { anchor: 0, head: V.state.doc.length } });
    click('ins:ul'); out.multiOl2ul = get();

    return JSON.stringify(out);
  })()`, true);
  const dj = JSON.parse(d);
  check('D/无序转有序', dj.ul2ol === '1. 甲', JSON.stringify(dj.ul2ol));
  check('D/有序转任务', dj.ol2todo === '- [ ] 甲', JSON.stringify(dj.ol2todo));
  check('D/任务转无序', dj.todo2ul === '- 甲', JSON.stringify(dj.todo2ul));
  check('D/无序转任务', dj.ul2todo === '- [ ] 甲', JSON.stringify(dj.ul2todo));
  check('D/任务转有序', dj.todo2ol === '1. 甲', JSON.stringify(dj.todo2ol));
  check('D/同类型点两次取消', dj.sameCancel === '甲', JSON.stringify(dj.sameCancel));
  check('D/有序点有序取消', dj.ol2ol === '甲', JSON.stringify(dj.ol2ol));
  check('D/普通行加无序', dj.plain2ul === '- 甲', JSON.stringify(dj.plain2ul));
  check('D/多行有序转无序', dj.multiOl2ul === '- 甲\n- 乙', JSON.stringify(dj.multiOl2ul));

  /* ============ E. 插入图片弹窗 ============ */
  const e = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-cmd="ins:image"]').click();
    const dlg = document.querySelector('.modal-mask');
    if (!dlg) return JSON.stringify({ ok: false });
    const choices = Array.from(dlg.querySelectorAll('.img-choice')).map(b => b.dataset.act);
    const r = { ok: true, choices };
    dlg.remove();
    return JSON.stringify(r);
  })()`, true);
  const ej = JSON.parse(e);
  check('E/插入图片弹出弹窗', ej.ok, '');
  check('E/弹窗有本地/远程两个选项',
    ej.choices && ej.choices.length === 2 && ej.choices.includes('local') && ej.choices.includes('remote'),
    JSON.stringify(ej.choices));

  /* ============ F. 设置面板 ============ */
  const f = await win.webContents.executeJavaScript(`(() => {
    document.getElementById('btnSettings').click();
    const dlg = document.getElementById('settingsDialog');
    if (!dlg) return JSON.stringify({ ok: false });
    const acts = Array.from(dlg.querySelectorAll('[data-act]')).map(b => b.dataset.act);
    const sets = Array.from(dlg.querySelectorAll('[data-set]')).map(b => b.dataset.set);
    const r = { ok: true, acts, sets };
    dlg.remove();
    return JSON.stringify(r);
  })()`, true);
  const fj = JSON.parse(f);
  check('F/设置面板能打开', fj.ok, '');
  check('F/设置面板有深色开关', fj.sets && fj.sets.includes('dark'), JSON.stringify(fj.sets));
  check('F/设置面板有编辑手感开关', fj.sets && fj.sets.includes('mdkeymap'), JSON.stringify(fj.sets));
  check('F/设置面板收纳了检查更新', fj.acts && fj.acts.includes('check-update'), JSON.stringify(fj.acts));
  check('F/设置面板收纳了导出日志', fj.acts && fj.acts.includes('export-log'), JSON.stringify(fj.acts));
  check('F/设置面板收纳了修复文件关联', fj.acts && fj.acts.includes('repair-assoc'), JSON.stringify(fj.acts));

  /* ============ 输出 ============ */
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
