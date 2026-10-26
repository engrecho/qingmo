const { app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeImage, net } = require('electron');
const path = require('path');
const fs = require('fs');
// 平台差异统一走这一层（mac.js / win.js），本文件不再出现 process.platform 分支
const platform = require('./platform');
const logger = require('./logger');
const fileAssoc = require('./file-assoc');
const localImages = require('./local-images');
const autoUpdate = require('./auto-update').createAutoUpdater({
  app,
  checkRelease,
  fetch: (...args) => net.fetch(...args),
  openInstaller: file => platform.openUpdateInstaller(shell, file),
  onState: state => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('app:updateState', state);
    }
  },
  onReady: async state => {
    const options = {
      type: 'info', title: '轻墨更新已下载',
      message: `轻墨 ${state.version} 已下载，是否现在安装？`,
      detail: platform.updateInstallHint,
      buttons: ['打开安装包', '稍后'], defaultId: 0, cancelId: 1, noLink: true
    };
    const result = win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (result.response === 0) {
      const installed = await autoUpdate.install();
      if (!installed.ok) dialog.showErrorBox('无法打开更新安装包', installed.error);
    }
  },
  log: (message, detail) => logger.info('[自动更新]', message, detail)
});
const { compareVersion } = require('./version');

let win = null;
let quitRequested = false;
app.on('before-quit', () => { quitRequested = true; });

// 应用图标：开发时读 build/icons，打包后读 resources 里的
function appIconPath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'build', 'icons', 'icon-256.png'),
    path.join(process.resourcesPath || '', 'icons', 'icon-256.png')
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return undefined;
}

// 最近打开文件（在 app ready 后初始化）
let recentList = [];
let recentFilePath = null;

function initRecent() {
  recentFilePath = path.join(app.getPath('userData'), 'recent.json');
  try {
    if (fs.existsSync(recentFilePath)) recentList = JSON.parse(fs.readFileSync(recentFilePath, 'utf-8')) || [];
  } catch (e) { recentList = []; }
}
function saveRecent() {
  try { fs.writeFileSync(recentFilePath, JSON.stringify(recentList.slice(0, 10), null, 2)); } catch (e) {}
}
function pushRecent(p) {
  if (!p) return;
  recentList = [p, ...recentList.filter(x => x !== p)].slice(0, 10);
  saveRecent();
}

function createWindow() {
  const icon = appIconPath();

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 420,
    show: false,
    backgroundColor: '#ffffff',
    title: '轻墨',
    icon: icon ? nativeImage.createFromPath(icon) : undefined,
    titleBarStyle: platform.titleBarStyle,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  let closeApproved = false;
  let closePending = false;
  win.on('close', event => {
    if (closeApproved) return;
    event.preventDefault();
    if (closePending) return;
    closePending = true;
    win.webContents.send('app:requestClose');
  });
  const finishClose = (event, approved) => {
    if (!win || event.sender !== win.webContents) return;
    closePending = false;
    if (approved === true) { closeApproved = true; if (quitRequested) app.quit(); else win.close(); }
    else quitRequested = false;
  };
  ipcMain.on('app:finishClose', finishClose);
  win.once('closed', () => ipcMain.removeListener('app:finishClose', finishClose));

  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.once('ready-to-show', () => {
    logger.info('窗口已显示');
    win.show();
  });

  // 隐藏原生菜单栏
  //
  // 页面上已经有全套可视化图标按钮（新建/打开/保存/表格/列表/…），
  // 再挂一排文字菜单是重复的，Windows 上它还会白占一整行。
  //
  // Windows / Linux：干脆不设应用菜单。
  //   ⚠ 快捷键全部由渲染层实现（app.js 里的全局 keydown），
  //     所以删菜单不会丢快捷键 —— 这一点有 verify-shortcuts.js 守着。
  // macOS：菜单栏在屏幕顶部，属于系统约定（Cmd+Q / 复制粘贴 / 窗口列表），
  //   保留显示。
  if (process.platform !== 'darwin') {
    try {
      Menu.setApplicationMenu(null);
    } catch (e) { /* 忽略 */ }
  }

  // 渲染进程崩了 / 白屏了 —— 记下来，用户反馈时能查
  win.webContents.on('render-process-gone', (_e, details) => {
    logger.error('渲染进程崩溃', details);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logger.error('页面加载失败', { code, desc, url });
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    logger.error('preload 加载失败', { preloadPath, message: error && error.message });
  });
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // 只记 warning 以上 —— info 太吵
    if (level >= 2) logger.warn('渲染进程控制台', { level, message, line, sourceId });
  });

  // 外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function buildMenu() {
  const send = (ch) => () => win && win.webContents.send(ch);
  const template = [
    ...(platform.appMenuItem ? [platform.appMenuItem] : []),
    {
      label: '文件',
      submenu: [
        { label: '新建', accelerator: 'CmdOrCtrl+N', click: send('cmd:new') },
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: send('cmd:open') },
        {
          label: '最近打开',
          submenu: recentList.length
            ? recentList.map(p => ({
                label: path.basename(p),
                click: () => { win.webContents.send('cmd:openPath', p); }
              }))
            : [{ label: '(无)', enabled: false }]
        },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: send('cmd:save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: send('cmd:saveAs') },
        { type: 'separator' },
        { label: '导出 HTML', accelerator: 'CmdOrCtrl+Shift+E', click: send('cmd:exportHtml') },
        { type: 'separator' },
        platform.quitMenuItem
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { label: '查找', accelerator: 'CmdOrCtrl+F', click: send('cmd:find') }
      ]
    },
    {
      label: '插入',
      submenu: [
        { label: '表格', accelerator: 'CmdOrCtrl+T', click: send('ins:table') },
        { label: '引用', accelerator: 'CmdOrCtrl+Shift+Q', click: send('ins:quote') },
        { label: '代码块', accelerator: 'CmdOrCtrl+Shift+K', click: send('ins:code') },
        { label: '无序列表', accelerator: 'CmdOrCtrl+Shift+8', click: send('ins:ul') },
        { label: '有序列表', accelerator: 'CmdOrCtrl+Shift+7', click: send('ins:ol') },
        { label: '任务列表', accelerator: 'CmdOrCtrl+Shift+9', click: send('ins:todo') },
        { type: 'separator' },
        { label: '分隔线', accelerator: 'CmdOrCtrl+Shift+M', click: send('ins:hr') },
        { label: '链接', accelerator: 'CmdOrCtrl+Shift+L', click: send('ins:link') },
        { label: '图片', accelerator: 'CmdOrCtrl+Shift+I', click: send('ins:image') }
      ]
    },
    {
      label: '格式',
      submenu: [
        { label: '粗体', accelerator: 'CmdOrCtrl+B', click: send('fmt:bold') },
        { label: '斜体', accelerator: 'CmdOrCtrl+I', click: send('fmt:italic') },
        { label: '行内代码', accelerator: 'CmdOrCtrl+E', click: send('fmt:code') },
        { label: '删除线', accelerator: 'CmdOrCtrl+Shift+X', click: send('fmt:strike') },
        { type: 'separator' },
        { label: 'H1', accelerator: 'CmdOrCtrl+Alt+1', click: send('fmt:h1') },
        { label: 'H2', accelerator: 'CmdOrCtrl+Alt+2', click: send('fmt:h2') },
        { label: 'H3', accelerator: 'CmdOrCtrl+Alt+3', click: send('fmt:h3') }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '编辑器', accelerator: 'CmdOrCtrl+1', click: send('view:edit') },
        { label: '分栏', accelerator: 'CmdOrCtrl+2', click: send('view:split') },
        { label: '预览', accelerator: 'CmdOrCtrl+3', click: send('view:preview') },
        { type: 'separator' },
        { label: '预览区直接编辑', accelerator: 'CmdOrCtrl+Shift+P', click: send('view:liveEdit') },
        { label: '切换深色模式', accelerator: 'CmdOrCtrl+D', click: send('view:theme') },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '检查更新…', click: send('app:checkUpdate') },
        { type: 'separator' },
        { label: 'Markdown 编辑手感', type: 'checkbox', checked: true, click: (item) => toggleMdKeymap(item) },
        { type: 'separator' },
        { label: '修复文件关联…', click: () => repairFileAssoc() },
        { label: '导出诊断日志…', click: () => exportDiagnostics() },
        { type: 'separator' },
        { label: '关于轻墨', click: send('app:about') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  // 菜单栏的隐藏在 createWindow() 里做（那时窗口才存在）。
  // 但 accelerator 靠菜单项注册，所以菜单本身必须留着 ——
  // 详见 createWindow() 里的注释。
}

/* ---------------- IPC：文件操作 ---------------- */
ipcMain.handle('fs:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] }]
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  pushRecent(p);
  return { path: p, content: fs.readFileSync(p, 'utf-8') };
});

/* 选择本地图片（插入图片时用）
 *
 * 返回相对当前文档的路径 —— 直接写绝对路径太啰嗦，
 * 而且文档一挪动就全失效。 */
ipcMain.handle('fs:pickImage', async (_e, baseDir) => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] }]
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  return { path: localImages.markdownImagePath(p, baseDir, platform.imagePaths), absolute: p };
});

ipcMain.handle('fs:readImage', (_event, source, documentPath) =>
  localImages.readLocalImage(source, documentPath, platform.imagePaths));

ipcMain.handle('fs:openPath', async (_e, p) => {
  try {
    logger.info('fs:openPath 读取文件', { path: p });
    pushRecent(p);
    const content = fs.readFileSync(p, 'utf-8');
    logger.info('fs:openPath 读取成功', { path: p, bytes: content.length });
    return { path: p, content };
  } catch (err) {
    logger.error('fs:openPath 读取失败', { path: p, message: err.message });
    return { error: String(err) };
  }
});

/* ---------- 诊断日志 ---------- */

/** 渲染进程上报异常 */
ipcMain.handle('log:report', (_e, payload) => {
  logger.fromRenderer(payload);
  return true;
});

/** 导出诊断日志：复制到剪贴板 + 打开日志目录
 *
 *  实现只有一份 —— exportDiagnostics()。
 *  之前这里另写了一遍，跟 exportDiagnostics 逻辑重复还略有差别。 */
ipcMain.handle('log:export', async () => exportDiagnostics());

/** 只取日志文本（不打扰用户） */
ipcMain.handle('log:tail', async () => logger.tail(800));

/**
 * 切换「Markdown 编辑手感」（列表续行 / Backspace 取消标记 / 表格跳格）。
 *
 * 这些增强会「抢」默认按键行为，万一在某种输入场景下出问题
 * （最典型是中文输入法），用户需要能立刻关掉 —— 不用重启、不用改配置。
 *
 * 状态存在渲染层的 localStorage 里，主进程通过 IPC 问渲染层要当前值，
 * 再据此更新菜单的勾选状态。
 */
async function toggleMdKeymap(menuItem) {
  if (!win || win.isDestroyed()) return;
  try {
    const cur = await win.webContents.executeJavaScript(
      'window.__mdKeymapEnabled ? window.__mdKeymapEnabled() : true');
    const next = !cur;
    win.webContents.send('app:setMdKeymap', next);
    menuItem.checked = next;
    logger.info('切换 Markdown 编辑手感', { enabled: next });
  } catch (e) {
    logger.warn('切换 Markdown 编辑手感失败', { message: e.message });
  }
}

/** 渲染层问当前状态（菜单初始化时同步勾选） */
ipcMain.handle('app:getMdKeymap', async () => {
  if (!win || win.isDestroyed()) return true;
  try {
    return await win.webContents.executeJavaScript(
      'window.__mdKeymapEnabled ? window.__mdKeymapEnabled() : true');
  } catch (e) { return true; }
});

/* ---------- 自动更新 ---------- */

/** 手动检查和后台检查共用同一更新流程。 */
ipcMain.handle('app:autoCheck', () => autoUpdate.checkAndDownload());
ipcMain.handle('app:autoUpdate', () => autoUpdate.download());
ipcMain.handle('app:installUpdate', () => autoUpdate.install());
ipcMain.handle('app:autoState', () => autoUpdate.state());


/**
 * 修复文件关联 —— 用户点了「帮助 → 修复文件关联」走这里。
 *
 * 写 HKCU（用户级），不需要管理员权限。
 * 失败时把 reg.exe 的错误原文记进日志 —— 这样能看出是权限问题还是参数问题。
 */
async function repairFileAssoc() {
  logger.info('用户请求修复文件关联');
  let r;
  try {
    r = await fileAssoc.register();
  } catch (e) {
    logger.error('修复文件关联失败', { message: e.message, stack: e.stack });
    try {
      const { dialog } = require('electron');
      dialog.showErrorBox('修复文件关联失败', e.message);
    } catch (e2) { /* 忽略 */ }
    return { ok: false, error: e.message };
  }
  logger.info('修复文件关联完成', { ok: r.ok, exe: r.exe, 明细: r.results });

  // 再查一遍确认
  const after = await fileAssoc.check();
  const md = after.find(x => x.ext === 'md');
  logger.info('修复后关联状态', { md关联: md && md.progid, 是否指向轻墨: md && md.isQingMo });

  try {
    const { dialog } = require('electron');
    dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: r.ok ? 'info' : 'warning',
      title: '修复文件关联',
      message: r.ok ? '文件关联已修复' : '部分关联修复失败',
      detail: [
        r.ok ? '现在双击 .md 文件会用轻墨打开。' : '有部分扩展名没能写入注册表。',
        '',
        '.md 当前关联：' + (md ? md.progid : '(未知)'),
        '打开命令：' + (md ? md.command : '(未知)'),
        '',
        '提示：Windows 可能会缓存关联，修复后如果仍不生效，',
        '可在「设置 → 应用 → 默认应用」里重新指定。'
      ].join('\n'),
      buttons: ['好']
    });
  } catch (e) { /* 忽略 */ }

  return { ok: r.ok, results: r.results, after };
}

/** 查询关联状态（给渲染层用） */
ipcMain.handle('app:checkFileAssoc', async () => {
  if (process.platform !== 'win32') return { supported: false, list: [] };
  const list = await fileAssoc.check();
  return { supported: true, list };
});

/** 执行修复（给渲染层用） */
ipcMain.handle('app:repairFileAssoc', async () => repairFileAssoc());

/**
 * 导出诊断日志 —— 用户点了「导出诊断日志」时走这里。
 *
 * 做三件事，让用户能直接把日志发给我：
 *   1. 复制最近日志到剪贴板
 *   2. 打开日志所在文件夹
 *   3. 弹窗告诉用户日志在哪、怎么发
 */
async function exportDiagnostics() {
  const text = logger.tail(800);
  const lines = text ? text.split('\n').length : 0;
  logger.info('用户导出诊断日志', { 行数: lines });

  let copied = false;
  try {
    const { clipboard } = require('electron');
    clipboard.writeText(text);
    copied = true;
  } catch (e) {
    logger.warn('复制到剪贴板失败', { message: e.message });
  }

  let opened = false;
  try {
    await shell.openPath(logger.dir());
    opened = true;
  } catch (e) {
    logger.warn('打开日志目录失败', { message: e.message });
  }

  const msg = [
    '诊断日志已准备好：',
    '',
    '· 日志文件：' + (logger.file() || '(无)'),
    '· 已复制最近 ' + lines + ' 行到剪贴板' + (copied ? '' : '（复制失败）'),
    '· 已打开日志文件夹' + (opened ? '' : '（打开失败）'),
    '',
    '把日志文件发给我即可定位问题。'
  ].join('\n');

  try {
    const { dialog } = require('electron');
    dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'info',
      title: '诊断日志',
      message: '诊断日志已导出',
      detail: msg,
      buttons: ['好']
    });
  } catch (e) { /* 弹窗失败就算了，日志已经落盘 */ }

  return { text, file: logger.file(), dir: logger.dir(), lines, copied, opened };
}

ipcMain.handle('fs:save', async (_e, p, content) => {
  fs.writeFileSync(p, content, 'utf-8');
  pushRecent(p);
  return { ok: true, path: p };
});

ipcMain.handle('fs:saveAs', async (_e, content, suggestedName) => {
  const r = await dialog.showSaveDialog(win, {
    title: '另存为',
    defaultPath: path.join(app.getPath('documents'), suggestedName || 'untitled.md'),
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, content, 'utf-8');
  pushRecent(r.filePath);
  return { ok: true, path: r.filePath };
});

ipcMain.handle('fs:exportHtml', async (_e, html, suggestedName) => {
  const r = await dialog.showSaveDialog(win, {
    title: '导出 HTML',
    defaultPath: path.join(app.getPath('documents'), (suggestedName || 'untitled') + '.html'),
    filters: [{ name: 'HTML', extensions: ['html'] }]
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, html, 'utf-8');
  return { ok: true, path: r.filePath };
});

ipcMain.handle('app:rebuildMenu', () => { buildMenu(); return recentList; });

// 同步取版本号（渲染层启动时用）
ipcMain.on('app:getVersion', (e) => { e.returnValue = app.getVersion(); });

/* ============ 版本更新检测 ============ */
// 从 GitHub Releases 拉取最新版本信息
// 接口：GET https://api.github.com/repos/{owner}/{repo}/releases/latest
const UPDATE_REPO = 'engrecho/qingmo';
const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
// 降级路径：GitHub 的 releases/latest 是 302 重定向到具体 tag，
// 从 Location 头就能拿到版本号 —— 不走 API，没有 60 次/小时的匿名限流。
const UPDATE_REDIRECT = `https://github.com/${UPDATE_REPO}/releases/latest`;

/**
 * 限流时的降级检查：只拿版本号，拿不到资源列表。
 *
 * 为什么需要：GitHub API 匿名请求是 60 次/小时/IP，
 * 装机量一大必然撞上 403。那时代码会直接报「检查失败」，
 * 用户还以为没有新版本。
 */
async function checkUpdateFallback(current) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await net.fetch(UPDATE_REDIRECT, {
      redirect: 'manual',      // 不自动跟随，从 Location 头里读 tag
      signal: ctrl.signal,
      headers: { 'User-Agent': 'QingMo-Update-Check' }
    });
    clearTimeout(timer);
    // 手动重定向时是 302，Location 形如 .../releases/tag/v1.5.1
    const loc = res.headers.get('location') || '';
    const m = /\/releases\/tag\/([^/?#]+)/.exec(loc);
    if (!m) return { ok: false, current, error: `HTTP ${res.status}（且拿不到版本号）` };
    const latest = m[1].replace(/^v/i, '');
    return {
      ok: true,
      current,
      latest,
      hasUpdate: false,          // 拿不到资源列表 → 不知道能不能直接更新
      newerExists: compareVersion(latest, current) > 0,
      platformReady: false,
      degraded: true,            // 标记：这是降级结果
      releaseUrl: `https://github.com/${UPDATE_REPO}/releases/latest`,
      releaseName: `v${latest}`,
      notes: '',
      assets: [],
      match: null
    };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, current, error: e.name === 'AbortError' ? '请求超时' : e.message };
  }
}

async function checkRelease() {
  const current = app.getVersion();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await net.fetch(UPDATE_API, {
      signal: ctrl.signal,
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'QingMo-Update-Check'
      }
    });
    if (!res.ok) {
      // 403 = 触发速率限制（匿名 60 次/小时）→ 走降级
      if (res.status === 403 || res.status === 429) {
        logger.warn('更新检查触发 GitHub 限流，改用降级路径', { status: res.status });
        clearTimeout(timer);
        return await checkUpdateFallback(current);
      }
      return { ok: false, current, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    const latest = String(data.tag_name || '').replace(/^v/i, '');
    if (!/^\d+\.\d+\.\d+$/.test(latest) || data.draft || data.prerelease) return { ok: false, current, error: 'Release 不是有效的正式版本' };

    // 找当前平台的资源（匹配规则按平台分派，见 platform/）
    const assets = (data.assets || []).filter(a => a.state === 'uploaded').map(a => ({
      name: a.name,
      size: a.size,
      url: a.browser_download_url,
      digest: a.digest
    }));

    const match = platform.matchUpdateInstaller(assets, process.arch);

    // ⚠ 有新版 ≠ 当前平台能下载到新版。
    //
    // 实际踩过：v1.5.0 / v1.5.1 的 GitHub Release 只发了 mac 的资源，
    // Windows 用户检查更新会看到「发现新版本 v1.5.1」，点下载却跳到
    // release 页面 —— 里面一个 .exe 都没有。
    //
    // 所以要把「版本更高」和「当前平台有对应资源」分开：
    //   hasUpdate     —— 有新版本【且】当前平台能拿到，可以直接更新
    //   newerExists   —— 有新版本，但当前平台还没发（提示用户去 release 页看）
    const newer = compareVersion(latest, current) > 0;
    const platformReady = !!match;

    return {
      ok: true,
      current,
      latest,
      hasUpdate: newer && platformReady,
      newerExists: newer,
      platformReady,
      portable: autoUpdate.isPortable(),
      platformName: platform.id === 'win' ? 'Windows' : (platform.id === 'mac' ? 'macOS' : platform.id),
      releaseUrl: data.html_url,
      releaseName: data.name,
      notes: (data.body || '').slice(0, 2000),
      publishedAt: data.published_at,
      assets,
      match
    };
  } catch (e) {
    // 网络异常也走降级 —— GitHub API 挂了就至少还能告诉用户「有没有新版」
    const err = e.name === 'AbortError' ? '请求超时' : e.message;
    logger.warn('更新检查失败，尝试降级路径', { error: err });
    clearTimeout(timer);
    const fb = await checkUpdateFallback(current);
    if (fb.ok) return fb;
    return { ok: false, current, error: err };
  } finally { clearTimeout(timer); }
}

ipcMain.handle('app:checkUpdate', () => autoUpdate.checkAndDownload());

/* compareVersion 已移到 ./version —— 测试要复用同一份实现，
   避免「测试里复制一份」导致实现改了测试没改。 */

/** 在系统浏览器打开下载页 */
ipcMain.handle('app:openExternal', async (_e, url) => {
  // 只允许 http(s)，防止渲染层传入 file:// / javascript: 之类的协议
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});

/* ---------------- 设置面板用的 IPC ----------------
 *
 * 页面上没有图标入口的功能（检查更新、修复文件关联、导出诊断日志、
 * 开发者工具）统一收进「设置」弹窗，由渲染层调这些。
 */

// 设置面板复用上方已注册的 app:repairFileAssoc。

/** 导出诊断日志（设置面板用） */
ipcMain.handle('app:exportLog', async () => exportDiagnostics());

/** 打开开发者工具 */
ipcMain.handle('app:devtools', async () => {
  if (win && !win.isDestroyed()) {
    win.webContents.toggleDevTools();
    return true;
  }
  return false;
});

/** 当前文件关联状态（设置面板显示用） */
ipcMain.handle('app:fileAssocStatus', async () => {
  try {
    const list = await fileAssoc.check();
    const md = list.find(x => x.ext === 'md');
    return {
      ok: true,
      progid: md ? md.progid : '(未关联)',
      isQingMo: md ? md.isQingMo : false
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.whenReady().then(() => {
  // 日志系统先初始化 —— 后面的每一步都要能记录
  logger.init(app);
  logger.cleanup(14);

  // 任务栏 / Dock 图标（Windows 主要看这个）
  const icon = appIconPath();
  if (icon) {
    try { app.setAppUserModelId('cn.bajiaolu.qingmo'); } catch (e) {}
    platform.setAppIcon(app, nativeImage, icon);
  }
  logger.info('应用就绪', {
    icon: icon || '(未找到)',
    pendingOpenPath: pendingOpenPath || '(无)'
  });

  initRecent();
  buildMenu();
  createWindow();
  autoUpdate.start();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // 检查文件关联 —— 「双击 md 打不开」最常见的原因就是关联没指向轻墨。
  // 记进日志，用户下次反馈时一眼就能看出来。
  if (process.platform === 'win32') {
    fileAssoc.check().then((list) => {
      const md = list.find(r => r.ext === 'md');
      const bad = list.filter(r => !r.isQingMo);
      if (md) {
        logger.info('文件关联检查', {
          md关联: md.progid,
          md命令: md.command,
          是否指向轻墨: md.isQingMo,
          未关联的扩展名: bad.map(r => r.ext).join(',') || '(无)'
        });
      }
      if (md && !md.isQingMo) {
        logger.warn('⚠ .md 没有关联到轻墨 —— 双击 md 很可能打不开',
          { 当前关联: md.progid, 建议: '菜单「帮助 → 修复文件关联」' });
      }
    }).catch(e => logger.warn('文件关联检查失败', { message: e.message }));
  }

  // 冷启动时通过命令行 / open-file 收到过文件，等窗口加载完再送进去
  if (pendingOpenPath) {
    const p = pendingOpenPath;
    pendingOpenPath = null;
    const send = () => win && win.webContents.send('cmd:openPath', p);
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
  }
});

/* ============ 文件关联：Finder 双击 / 打开方式 / 命令行传参 ============ */
//
// macOS 双击 .md 时系统不会把路径塞进 argv，而是：
//   1. 先发 open-file 事件（可能早于 app ready，win 还是 null）
//   2. 已经开着实例时，Launch Services 会把事件送到那个实例
// 所以 open-file 必须在模块顶层注册（早于 whenReady），并且要把
// ready 之前收到的路径暂存起来，等窗口 did-finish-load 再投喂。
//
// macOS 与 Windows 的入口差异收在 platform/ 里：
//   mac.js → app.on('open-file')
//   win.js → 扫命令行参数
// 本模块保留「暂存 + 投喂」的通用逻辑，两端共用。
const DOC_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdtxt', '.mdtext', '.text', '.txt']);

let pendingOpenPath = null;

function isDocPath(p) {
  return typeof p === 'string' && DOC_EXTS.has(path.extname(p).toLowerCase());
}

/**
 * 把文件投给渲染层：窗口没建好就先暂存，好了就直接送。
 *
 * ⚠ 每一处失败都必须留下日志 —— 原来全是裸的 `return false`，
 * 用户反馈「双击 md 有时候打不开」时，没有任何线索可查。
 * 现在失败原因会明确写进日志（扩展名不支持 / 文件不存在 / 读失败）。
 */
function openPathInApp(p) {
  if (!isDocPath(p)) {
    logger.fileOpenAttempt(p, false, '扩展名不支持（支持: ' +
      [...DOC_EXTS].join(', ') + '）');
    return false;
  }
  try {
    if (!fs.existsSync(p)) {
      logger.fileOpenAttempt(p, false, '文件不存在');
      return false;
    }
  } catch (e) {
    logger.fileOpenAttempt(p, false, '检查文件时异常: ' + e.message);
    return false;
  }

  if (!win || win.isDestroyed()) {
    logger.fileOpenAttempt(p, true, '窗口未就绪，已暂存待投喂');
    pendingOpenPath = p;
    return true;
  }
  const send = () => {
    try {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send('cmd:openPath', p);
      logger.fileOpenAttempt(p, true, '已投喂渲染层');
    } catch (e) {
      logger.fileOpenAttempt(p, false, '投喂渲染层失败: ' + e.message);
    }
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
  return true;
}

// 注册「双击文件用本应用打开」的入口（macOS 走 open-file 事件，
// Windows / Linux 走命令行参数，差异见 platform/）。
// 必须在模块顶层调用 —— macOS 的 open-file 可能早于 app ready。
platform.registerFileOpen(app, isDocPath, openPathInApp);

app.on('window-all-closed', () => { if (platform.quitOnAllWindowsClosed) app.quit(); });
app.on('will-quit', () => autoUpdate.stop());

// 渲染层只能请求固定的关闭提示，不能注入系统弹窗选项。
ipcMain.handle('app:confirmClose', async (event, names) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  if (!parent || !Array.isArray(names) || !names.length) return 'cancel';
  return require('./close-dialog').confirmClose(dialog, parent, names.map(name => String(name).slice(0, 200)));
});
