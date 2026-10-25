// 查询官方 Release → 后台下载并校验 → 等待用户确认打开安装包。
// 不在下载完成或应用退出时静默安装，也不强制退出正在编辑的应用。
const path = require('path');
const { compareVersion } = require('./version');
const { downloadAsset, verifyFile } = require('./update-download');

function createAutoUpdater({ app, checkRelease, fetch, openInstaller, onState = () => {}, onReady = () => {}, log = () => {}, timers = globalThis }) {
  let info = {};
  let status = { checking: false, available: false, downloading: false, ready: false, installing: false, progress: 0, error: '', version: '', phase: 'idle' };
  let checking, downloading, installing, readyFile, readyAsset;
  let started = false, stopped = false, startupTimer, intervalTimer, retryTimer;
  const notified = new Set();
  const state = () => ({ ...info, ...status, ok: info.ok === true && !status.error });
  const emit = patch => {
    status = { ...status, ...patch };
    try { onState(state()); } catch (error) { log('更新状态通知失败', error.message); }
    return state();
  };
  const currentVersion = () => app.getVersion();
  const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_FILE;
  const enabled = () => app.isPackaged || !!process.env.QINGMO_FORCE_UPDATE;

  function check() {
    if (checking) return checking;
    if (downloading || installing) return Promise.resolve(state());
    if (!enabled()) {
      info = { ok: false, current: currentVersion(), reason: 'dev-mode' };
      return Promise.resolve(emit({ error: '开发模式不自动检查更新', phase: 'idle' }));
    }
    checking = (async () => {
      emit({ checking: true, error: '', phase: 'checking' });
      try {
        const result = await checkRelease();
        if (!result.ok) throw new Error(result.error || '检查更新失败');
        if (result.degraded && status.ready && readyAsset && result.latest === status.version) {
          info = { ...info, ...result, hasUpdate: true, platformReady: true, match: readyAsset };
          emit({ phase: 'ready' });
          return state();
        }
        const available = !!result.hasUpdate && compareVersion(result.latest, currentVersion()) > 0;
        const same = readyAsset && result.match && readyAsset.digest === result.match.digest && readyAsset.name === result.match.name;
        info = result;
        if (!same) { readyFile = null; readyAsset = null; }
        emit({ available, version: available ? result.latest : '', ready: available && !!same, progress: same ? 100 : 0, phase: available ? (same ? 'ready' : 'available') : 'idle' });
      } catch (error) {
        // 保留已校验的安装包，网络暂时失败不影响稍后安装。
        emit({ error: error.message, phase: status.ready ? 'ready' : 'error' });
        log('更新检查失败', error.message);
      } finally { emit({ checking: false }); }
      return state();
    })().finally(() => { checking = null; });
    return checking;
  }

  function download() {
    if (downloading) return downloading;
    downloading = (async () => {
      if (!status.available) await check();
      if (!status.available || !info.match) return { ok: false, error: status.error || '没有可下载的更新' };
      const version = status.version, asset = { ...info.match };
      emit({ downloading: true, ready: false, progress: 0, error: '', phase: 'downloading' });
      try {
        const file = await downloadAsset({ asset, version, directory: path.join(app.getPath('userData'), 'updates'), fetch, onProgress: progress => { if (progress !== status.progress) emit({ progress }); } });
        readyFile = file; readyAsset = asset;
        emit({ downloading: false, ready: true, progress: 100, phase: 'ready' });
        const key = version + ':' + asset.digest;
        if (!stopped && !notified.has(key)) {
          notified.add(key);
          Promise.resolve().then(() => onReady(state())).catch(error => log('安装提示失败', error.message));
        }
        return { ok: true, ...state() };
      } catch (error) {
        readyFile = null; readyAsset = null;
        emit({ downloading: false, ready: false, error: error.message, phase: 'error' });
        log('更新下载失败', error.message);
        scheduleRetry();
        return { ok: false, ...state() };
      }
    })().finally(() => { downloading = null; });
    return downloading;
  }

  function scheduleRetry() {
    if (!started || stopped || retryTimer) return;
    retryTimer = timers.setTimeout(() => { retryTimer = null; void checkAndDownload(); }, 15 * 60 * 1000);
    retryTimer?.unref?.();
  }

  async function checkAndDownload() {
    await check();
    if (status.error || (info.newerExists && !info.platformReady)) scheduleRetry();
    if (status.available && !status.ready && !status.error) void download();
    return state();
  }

  function install() {
    if (installing) return installing;
    installing = (async () => {
      if (!status.ready || !readyFile || !readyAsset) return { ok: false, error: '安装包尚未下载完成' };
      emit({ installing: true });
      try {
        if (!await verifyFile(readyFile, readyAsset)) {
          readyFile = null; readyAsset = null;
          emit({ ready: false, progress: 0, phase: 'error' });
          throw new Error('安装包已变更或丢失，请重新下载');
        }
        const error = await openInstaller(readyFile);
        if (error) throw new Error(error);
        return { ok: true };
      } catch (error) {
        emit({ error: error.message });
        return { ok: false, error: error.message };
      } finally { emit({ installing: false }); }
    })().finally(() => { installing = null; });
    return installing;
  }

  function start() {
    if (started || !enabled()) return;
    started = true; stopped = false;
    startupTimer = timers.setTimeout(() => { void checkAndDownload(); }, 10000);
    intervalTimer = timers.setInterval(() => { void checkAndDownload(); }, 6 * 60 * 60 * 1000);
    startupTimer?.unref?.(); intervalTimer?.unref?.();
  }
  function stop() {
    stopped = true;
    timers.clearTimeout(startupTimer); timers.clearInterval(intervalTimer);
    if (retryTimer) timers.clearTimeout(retryTimer);
    retryTimer = null;
    started = false;
  }
  return { check, checkAndDownload, download, install, state, start, stop, currentVersion, isPortable };
}
module.exports = { createAutoUpdater };
