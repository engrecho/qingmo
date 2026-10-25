/* ============================================
   版本更新检测
   ============================================ */

let updateInfo = null;
let updateBanner = null;
let dismissedUpdateKey = null;
const updateKey = state => `${state.version || state.latest}:${state.ready ? 'ready' : 'download'}`;

// 主进程负责启动与周期检查。设置面板与菜单只触发同一流程。
async function checkUpdate(force = false) {
  if (!window.api?.checkUpdate) return null;
  try {
    if (force) dismissedUpdateKey = null;
    const result = await window.api.checkUpdate();
    receiveUpdateState(result);
    if (force) {
      if (result.hasUpdate || result.newerExists) showUpdateDialog(result);
      else if (!result.ok) toast('检查失败：' + (result.error || '更新服务暂不可用'));
      else toast('已是最新版本 ' + result.current);
    }
    return result;
  } catch (error) {
    if (force) toast('检查失败：' + error.message);
    return { ok: false, error: error.message };
  }
}
window.qingmoCheckUpdate = () => checkUpdate(true);

function receiveUpdateState(state) {
  if (!state) return;
  updateInfo = state;
  if ((state.hasUpdate || state.available) && dismissedUpdateKey !== updateKey(state)) showUpdateBanner(state);
  else if (state.phase === 'idle' && !state.checking) hideUpdateBanner();
  applyDialogState(state);
}
window.api.on('app:updateState', (_channel, state) => receiveUpdateState(state));
if (window.api.autoState) window.api.autoState().then(receiveUpdateState).catch(() => {});

/* ---------- 顶部提示条 ---------- */
function showUpdateBanner(info) {
  let bar = updateBanner;
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'update-bar';
    bar.innerHTML = `<span class="ub-text"></span>
      <button class="ub-btn primary" data-act="download"></button>
      <button class="ub-btn" data-act="details">查看详情</button>
      <button class="ub-btn" data-act="dismiss" title="暂时收起">×</button>`;
    bar.addEventListener('click', async event => {
      const action = event.target.closest('[data-act]')?.dataset.act;
      if (action === 'details') showUpdateDialog(updateInfo);
      if (action === 'dismiss') { dismissedUpdateKey = updateKey(updateInfo); hideUpdateBanner(); }
      if (action === 'download') {
        if (!updateInfo.match) { window.api.openExternal(updateInfo.releaseUrl); return; }
        const button = bar.querySelector('[data-act="download"]');
        button.disabled = true;
        try {
          const result = updateInfo.ready ? await window.api.installUpdate() : await window.api.autoUpdate();
          if (!result.ok) toast(result.error || '更新失败，请重试');
        } catch (error) { toast('更新失败：' + error.message); }
        finally { button.disabled = false; }
      }
    });
    document.body.appendChild(bar);
    updateBanner = bar;
    requestAnimationFrame(() => bar.classList.add('show'));
  }
  const version = info.version || info.latest;
  bar.querySelector('.ub-text').textContent = info.ready
    ? `轻墨 ${version} 已下载，可以安装`
    : info.downloading ? `轻墨 ${version} 正在后台下载 ${info.progress}%`
    : info.error ? `轻墨 ${version} 下载失败：${info.error}`
    : info.match ? `发现轻墨 ${version}，准备后台下载`
    : `新版本 ${version} 已发布，当前平台安装包暂不可用`;
  const button = bar.querySelector('[data-act="download"]');
  button.textContent = info.ready ? '打开安装包' : info.downloading ? '下载中…' : info.match ? '重试下载' : '查看发布页';
  button.disabled = !!info.downloading || !!info.installing;
}

function hideUpdateBanner() {
  if (!updateBanner) return;
  const el = updateBanner;
  updateBanner = null;
  el.classList.remove('show');
  setTimeout(() => el.remove(), 260);
}

/* ---------- 详情弹窗 ---------- */
function showUpdateDialog(info) {
  const old = document.getElementById('updateDialog');
  if (old) old.remove();

  const assets = (info.assets || []).filter(a => /\.(exe|dmg|zip)$/i.test(a.name)).map(a => `
    <li>
      <span class="ua-name">${escapeHtml(a.name)}</span>
      <span class="ua-size">${(a.size / 1048576).toFixed(1)} MB</span>
      <button class="ub-btn" data-url="${escapeHtml(a.url)}">下载</button>
    </li>`).join('');

  // 安装入口仅在当前平台存在更高版本的安装包时显示。
  const canAuto = !!info.hasUpdate && !!info.match && info.platformReady !== false;

  const dlg = document.createElement('div');
  dlg.id = 'updateDialog';
  dlg.className = 'modal-mask';
  dlg.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <span class="modal-title">版本更新</span>
        <button class="ub-btn icon" data-act="close" title="关闭">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <p class="ud-ver">当前 <b>${info.current}</b> → 最新 <b class="ud-new">${info.latest}</b></p>
        ${info.publishedAt ? `<p class="ud-date">发布于 ${new Date(info.publishedAt).toLocaleDateString('zh-CN')}</p>` : ''}
        ${info.platformReady === false && !info.degraded ? `<p class="ud-warn">${info.platformName || '当前平台'}版暂未提供，可先看看其他平台的包</p>` : ''}
        ${info.degraded ? '<p class="ud-warn">GitHub 接口暂时限流，只取到了版本号。点「打开发布页」可直接下载。</p>' : ''}
        ${info.notes ? `<pre class="ud-notes">${escapeHtml(info.notes)}</pre>` : ''}
        <div class="ud-progress" id="udProgress" style="display:none">
          <div class="udp-bar"><div class="udp-fill" id="udpFill"></div></div>
          <div class="udp-text" id="udpText">准备下载…</div>
        </div>
        ${info.degraded ? '' : `
        <div class="ud-assets">
          <div class="ud-assets-title">下载</div>
          <ul class="ua-list">${assets || '<li class="ua-empty">该版本没有附件</li>'}</ul>
        </div>`}
      </div>
      <div class="modal-foot">
        <button class="ub-btn" data-act="close">稍后再说</button>
        ${canAuto ? '<button class="ub-btn primary" data-act="auto">下载更新</button>' : ''}
        <button class="ub-btn ${canAuto ? '' : 'primary'}" data-act="release">打开发布页</button>
      </div>
    </div>
  `;

  dlg.addEventListener('click', async (e) => {
    const urlBtn = e.target.closest('[data-url]');
    if (urlBtn) { window.api.openExternal(urlBtn.dataset.url); return; }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'close') dlg.remove();
    if (btn.dataset.act === 'release') window.api.openExternal(info.releaseUrl);
    if (btn.dataset.act === 'auto') {
      await startAutoUpdate(dlg, btn);
    }
  });

  document.body.appendChild(dlg);
  applyDialogState(info);
  requestAnimationFrame(() => dlg.classList.add('show'));
}

function applyDialogState(state) {
  const dialog = document.getElementById('updateDialog');
  if (!dialog) return;
  const button = dialog.querySelector('[data-act="auto"]');
  if (!button) return;
  const box = dialog.querySelector('#udProgress');
  const fill = dialog.querySelector('#udpFill');
  const text = dialog.querySelector('#udpText');
  box.style.display = '';
  fill.style.width = (state.progress || 0) + '%';
  text.textContent = state.error ? '更新失败：' + state.error
    : state.ready ? '安装包已下载。请先保存文档，再打开安装包。'
    : state.downloading ? `后台下载中 ${state.progress || 0}%`
    : state.checking ? '正在检查更新…' : '准备下载更新…';
  button.textContent = state.ready ? '打开安装包' : state.downloading ? '下载中…' : state.error ? '重试下载' : '下载更新';
  button.disabled = !!state.downloading || !!state.installing;
}

async function startAutoUpdate(dlg, button) {
  button.disabled = true;
  try {
    const result = updateInfo?.ready ? await window.api.installUpdate() : await window.api.autoUpdate();
    if (!result.ok) {
      const text = dlg.querySelector('#udpText');
      if (text) text.textContent = '更新失败：' + (result.error || '请重试');
    }
  } catch (error) {
    const text = dlg.querySelector('#udpText');
    if (text) text.textContent = '更新失败：' + error.message;
  } finally { button.disabled = false; }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 菜单入口：帮助 → 检查更新 ---------- */
window.api.on('app:checkUpdate', () => checkUpdate(true));

/* ---------- 关于对话框 ---------- */
window.api.on('app:about', () => {
  const old = document.getElementById('aboutDialog');
  if (old) old.remove();

  let ver = '—';
  try { ver = window.api.version ? window.api.version() : '—'; } catch (e) {}

  const dlg = document.createElement('div');
  dlg.id = 'aboutDialog';
  dlg.className = 'modal-mask';
  dlg.innerHTML = `
    <div class="modal" style="width:min(400px,100%)">
      <div class="modal-body" style="text-align:center;padding:30px 24px 24px">
        <div class="about-logo">
          <img src="data:image/png;base64,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" alt="轻墨" width="52" height="52" />
        </div>
        <div class="about-name">轻墨 QingMo</div>
        <div class="about-ver">版本 ${ver}</div>
        <p class="about-desc">简洁轻量的跨平台 Markdown 编辑器<br>左边写，右边即时看到成品</p>
        <div class="about-links">
          <button class="ub-btn" data-url="https://github.com/engrecho/qingmo">项目主页</button>
          <button class="ub-btn" data-url="https://github.com/engrecho/qingmo/releases">版本发布</button>
        </div>
        <div class="diag-box" id="diagBox">
          <div class="diag-title">诊断</div>
          <div class="diag-row" id="diagAssoc">文件关联：检查中…</div>
          <div class="diag-actions">
            <button class="ub-btn" data-act="repair-assoc">修复文件关联</button>
            <button class="ub-btn" data-act="export-log">导出诊断日志</button>
          </div>
        </div>
      </div>
      <div class="modal-foot" style="justify-content:center">
        <button class="ub-btn" data-act="close">关闭</button>
      </div>
    </div>
  `;

  dlg.addEventListener('click', async (e) => {
    const u = e.target.closest('[data-url]');
    if (u) { window.api.openExternal(u.dataset.url); return; }
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'close') { dlg.remove(); return; }
      if (a === 'repair-assoc') {
        const box = document.getElementById('diagAssoc');
        if (box) box.textContent = '文件关联：正在修复…';
        try {
          const r = await window.api.repairFileAssoc();
          if (box) {
            box.textContent = r && r.ok
              ? '文件关联：已修复 ✅'
              : '文件关联：修复未完全成功，请看日志';
          }
        } catch (err) {
          if (box) box.textContent = '文件关联：修复出错 — ' + (err && err.message);
        }
        return;
      }
      if (a === 'export-log') {
        const box = document.getElementById('diagAssoc');
        if (box) box.textContent = '正在导出日志…';
        try {
          const r = await window.api.exportLog();
          if (box) box.textContent = '诊断日志：已复制到剪贴板并打开文件夹';
        } catch (err) {
          if (box) box.textContent = '导出日志失败 — ' + (err && err.message);
        }
        return;
      }
    }
  });

  document.body.appendChild(dlg);
  requestAnimationFrame(() => dlg.classList.add('show'));

  // 显示文件关联状态 —— 「双击 md 打不开」时能一眼看出关联指向谁
  (async () => {
    const box = document.getElementById('diagAssoc');
    if (!box) return;
    try {
      const r = await window.api.checkFileAssoc();
      if (!r || !r.supported) {
        box.textContent = '文件关联：当前系统不支持检查';
        return;
      }
      const md = r.list.find(x => x.ext === 'md');
      const bad = r.list.filter(x => !x.isQingMo);
      if (md && md.isQingMo) {
        box.textContent = '文件关联：正常 ✅（.md → 轻墨）';
      } else {
        box.textContent = '文件关联：.md 当前关联到 ' +
          (md ? md.progid : '(未关联)') + '，双击 md 可能打不开';
      }
      if (bad.length > 1) {
        box.textContent += '（' + bad.length + ' 个扩展名未指向轻墨）';
      }
    } catch (e) {
      box.textContent = '文件关联：检查失败 — ' + (e && e.message);
    }
  })();
});
