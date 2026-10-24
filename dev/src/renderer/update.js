/* ============================================
   版本更新检测
   ============================================ */

const UPDATE_KEY = 'qingmo.update.lastCheck';
const UPDATE_DAY = 24 * 60 * 60 * 1000;   // 24 小时检查一次

let updateInfo = null;      // 最近一次检查结果
let updateBanner = null;    // 顶部提示条元素

/** 判断是否该检查（距上次检查超过 24 小时） */
function shouldCheckUpdate() {
  try {
    const last = parseInt(localStorage.getItem(UPDATE_KEY) || '0', 10);
    return Date.now() - last > UPDATE_DAY;
  } catch (e) { return true; }
}

function markChecked() {
  try { localStorage.setItem(UPDATE_KEY, String(Date.now())); } catch (e) {}
}

/** 检查更新 */
async function checkUpdate(force = false) {
  if (!window.api || !window.api.checkUpdate) return null;
  if (!force && !shouldCheckUpdate()) return updateInfo;

  try {
    const r = await window.api.checkUpdate();
    markChecked();
    updateInfo = r;
    if (r && r.ok) {
      if (r.hasUpdate) showUpdateBanner(r);
      else hideUpdateBanner();
    }
    return r;
  } catch (e) {
    updateInfo = { ok: false, error: e.message };
    return updateInfo;
  }
}

/* 暴露给 app.js 的设置面板 ——
 * app.js 和 update.js 是两个独立 bundle，彼此看不见对方的内部函数，
 * 只能通过 window 搭桥。 */
window.qingmoCheckUpdate = checkUpdate;

/* ---------- 顶部提示条 ---------- */
function showUpdateBanner(info) {
  hideUpdateBanner();

  // 当前平台没发对应资源时，措辞要诚实 ——
  // 不能让用户以为点「前往下载」就能拿到本平台的包。
  const canDownload = !!info.match;
  let text;
  if (canDownload) {
    text = `发现新版本 <b>${info.latest}</b>（当前 ${info.current}）`;
  } else if (info.degraded) {
    // 降级模式：只拿到了版本号，不知道有没有本平台的包
    text = `新版本 <b>${info.latest}</b> 可用（当前 ${info.current}）`;
  } else {
    text = `新版本 <b>${info.latest}</b> 已发布（当前 ${info.current}），`
      + `<b>${info.platformName || '当前平台'}</b> 版暂未提供`;
  }

  const bar = document.createElement('div');
  bar.className = 'update-bar';
  bar.innerHTML = `
    <span class="ub-icon"><svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M4 20h16"/></svg></span>
    <span class="ub-text">${text}</span>
    <button class="ub-btn primary" data-act="download">${canDownload ? '前往下载' : '查看发布页'}</button>
    <button class="ub-btn" data-act="details">查看详情</button>
    <button class="ub-btn icon" data-act="dismiss" title="忽略此版本">
      <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
  `;

  bar.addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'download') {
      // 有匹配资源就直接下载；没有就打开 release 页（里面有说明）
      const url = (info.match && info.match.url) || info.releaseUrl;
      window.api.openExternal(url);
    } else if (act === 'details') {
      showUpdateDialog(info);
    } else if (act === 'dismiss') {
      hideUpdateBanner();
    }
  });

  document.body.appendChild(bar);
  updateBanner = bar;
  requestAnimationFrame(() => bar.classList.add('show'));
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

  const assets = (info.assets || []).map(a => `
    <li>
      <span class="ua-name">${escapeHtml(a.name)}</span>
      <span class="ua-size">${(a.size / 1048576).toFixed(1)} MB</span>
      <button class="ub-btn" data-url="${escapeHtml(a.url)}">下载</button>
    </li>`).join('');

  // 一键更新按钮：只在「当前平台有对应资源」且「不是便携版」时出现
  const canAuto = !!info.match && info.platformReady !== false && !info.portable;

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
        ${canAuto ? '<button class="ub-btn primary" data-act="auto">一键更新</button>' : ''}
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
  requestAnimationFrame(() => dlg.classList.add('show'));
}

/**
 * 一键更新：下载 → 静默安装 → 重启。
 *
 * 走的是 electron-updater，所以：
 *   · 只在 NSIS 安装版可用（便携版按钮根本不出现）
 *   · 依赖 Release 上有 latest.yml（发布脚本要传）
 *   · 装完会自动重启应用
 */
async function startAutoUpdate(dlg, btn) {
  const box = dlg.querySelector('#udProgress');
  const fill = dlg.querySelector('#udpFill');
  const text = dlg.querySelector('#udpText');
  btn.disabled = true;
  btn.textContent = '准备中…';
  if (box) box.style.display = '';

  try {
    const r = await window.api.autoUpdate();
    if (!r || !r.ok) {
      text.textContent = '无法自动更新：' + ((r && r.error) || '未知错误');
      btn.disabled = false;
      btn.textContent = '重试';
      return;
    }
    text.textContent = '下载中 0%';

    // 轮询进度
    const timer = setInterval(async () => {
      try {
        const s = await window.api.autoState();
        if (s && s.downloading) {
          text.textContent = `下载中 ${s.progress}%`;
          if (fill) fill.style.width = s.progress + '%';
        } else if (s && s.progress > 0 && !s.downloading) {
          text.textContent = '下载完成，正在安装…';
        }
      } catch (err) { /* 忽略 */ }
    }, 500);

    // 下载完成后主进程会 quitAndInstall，界面到这里就结束了
    setTimeout(() => clearInterval(timer), 10 * 60 * 1000);
  } catch (e) {
    text.textContent = '更新失败：' + (e && e.message);
    btn.disabled = false;
    btn.textContent = '重试';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 菜单入口：帮助 → 检查更新 ---------- */
window.api.on('app:checkUpdate', async () => {
  const r = await checkUpdate(true);
  if (!r) { toast('无法连接更新服务'); return; }
  if (!r.ok) { toast('检查失败：' + (r.error || '未知错误')); return; }
  if (r.hasUpdate) { showUpdateDialog(r); return; }
  if (r.degraded && r.newerExists) {
    // 降级模式：知道有新版但拿不到资源列表
    toast(`新版本 ${r.latest} 可用，详细见发布页`);
    showUpdateDialog(r);
    return;
  }
  if (r.newerExists && !r.platformReady) {
    // 有新版但当前平台还没发 —— 说清楚，别让用户白跑一趟
    toast(`新版本 ${r.latest} 已发布，${r.platformName || '当前平台'}版暂未提供`);
    showUpdateDialog(r);
    return;
  }
  toast('已是最新版本 ' + r.current);
});

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
