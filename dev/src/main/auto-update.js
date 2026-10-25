/**
 * 自动更新（Windows）
 *
 * 走 electron-updater 的 autoUpdater：
 *   检查 → 下载 → 静默安装 → 重启
 *
 * ⚠ 三个前提，缺一个就静默失败：
 *
 *   1. **必须是 NSIS 安装版**
 *      portable（免安装）版没有升级通道，electron-updater 会直接报错。
 *      所以要先判断自己是哪种版本 —— 看 process.env.PORTABLE_EXECUTABLE_FILE，
 *      electron-builder 打 portable 时会注入这个环境变量。
 *
 *   2. **Release 上必须有 latest.yml**
 *      electron-updater 不是去翻 Release 的资源列表，而是去读 Release 里的
 *      `latest.yml`，里面记着版本号、文件名、sha512。
 *      没有这个文件 → 检查直接失败。
 *      （所以发布脚本必须把 latest.yml 一起传上去）
 *
 *   3. **文件名必须和 latest.yml 里一致**
 *      latest.yml 里的 path 是 electron-builder 生成时的原始文件名。
 *      发布脚本如果把资源改名了，下载就会 404。
 *      （已在 package.json 里用 artifactName 固定成 ASCII 名）
 *
 * macOS 不做自动更新：需要 Apple Developer 证书 + 公证，
 * 否则 Gatekeeper 会拦下自动下载的 app（用户还得手动右键打开）。
 * mac 上只做「检查更新 + 引导下载」。
 */
// 更新依赖只在实际更新时加载，避免更新组件故障阻止编辑器启动。
let autoUpdater;
function loadUpdater() {
  if (!autoUpdater) autoUpdater = require('electron-updater').autoUpdater;
  return autoUpdater;
}
const { app } = require('electron');
const path = require('path');
const logger = require('./logger');

// 自动更新是「装完重启」，不是热更新 —— 单实例，否则两个进程抢同一个安装目录
const gotLock = app.requestSingleInstanceLock();

// 开发模式（未打包）下 electron-updater 会在 app.getAppPath() 下找
// dev-app-update.yml。正常 `npm start`（electron .）时 getAppPath() 就是 dev/，
// 但跑 scripts/ 下的测试脚本时是 dev/scripts/ —— 所以显式指到 dev/ 根目录。


let updateState = {
  checking: false,
  available: false,
  downloading: false,
  progress: 0,
  error: '',
  version: ''
};

function isPortable() {
  return !!process.env.PORTABLE_EXECUTABLE_FILE;
}

function log(...a) { logger.info('[自动更新]', ...a); }

/**
 * 检查更新。
 *
 * @param {boolean} silent 静默模式（启动时自动检查）—— 出错不打扰用户
 * @returns {Promise<object>} 状态
 */
async function check(silent) {
  if (updateState.checking) return updateState;
  if (isPortable()) {
    return {
      ...updateState,
      error: '便携版不支持自动更新',
      reason: 'portable'
    };
  }
  // ⚠ 开发模式（未打包）下 electron-updater 会直接跳过检查：
  //   "Skip checkForUpdates because application is not packed"
  //   这时 checkForUpdates() 什么都不返回 —— 之前代码把它当成「已是最新」，
  //   用户会以为检查过了，其实根本没查。要如实说明。
  if (!app.isPackaged && !process.env.QINGMO_FORCE_UPDATE) {
    return {
      ...updateState,
      error: '开发模式不检查更新',
      reason: 'dev-mode'
    };
  }

  updateState.checking = true;
  updateState.error = '';
  try {
    loadUpdater();
    autoUpdater.autoDownload = false;          // 只查不下载，等用户点
    autoUpdater.autoInstallOnAppQuit = true;   // 用户点了「稍后」→ 退出时自动装
    autoUpdater.allowPrerelease = false;

    // 开发模式（未打包）：强制走真实配置，才能真的连上 GitHub 验证。
    //
    // dev-app-update.yml 的位置：electron-updater 默认在 app.getAppPath() 下找，
    // 正常 `npm start`（electron .）时就是 dev/ ✓；
    // 但跑 scripts/ 下的脚本时 getAppPath() 是 dev/scripts/ —— 所以显式指过去。
    if (!app.isPackaged) {
      autoUpdater.forceDevUpdateConfig = true;
      try {
        autoUpdater.devUpdateConfigPath = path.join(__dirname, '..', 'dev-app-update.yml');
      } catch (e) { /* 老版本没这个属性，忽略 */ }
      log('开发模式，使用 dev-app-update.yml', {
        path: autoUpdater.devUpdateConfigPath,
        exists: require('fs').existsSync(autoUpdater.devUpdateConfigPath || '')
      });
    }

    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.updateInfo) {
      // electron-updater 在某些情况下会返回空 —— 别当成「已是最新」
      updateState.error = '更新服务没有返回版本信息';
      log('检查结果为空');
      return { ...updateState };
    }
    const info = result.updateInfo;
    if (info && info.version) {
      updateState.available = true;
      updateState.version = info.version;
      log('发现新版本', { from: currentVersion(), to: info.version });
    } else {
      updateState.available = false;
      log('已是最新', { version: currentVersion() });
    }
    return { ...updateState };
  } catch (e) {
    // 静默模式下的错误只记日志，不弹窗
    updateState.error = e && e.message ? e.message : String(e);
    log('检查失败', { message: updateState.error, code: e && e.code });
    if (!silent) {
      // 常见原因：Release 里没有 latest.yml（发布脚本漏传）
      if (/latest\.yml|HttpError|404|not found/i.test(updateState.error)) {
        updateState.error += '（可能是 Release 缺少 latest.yml）';
      }
    }
    return { ...updateState };
  } finally {
    updateState.checking = false;
  }
}

/** 下载并安装 */
async function downloadAndInstall() {
  if (!updateState.available) {
    const r = await check(false);
    if (!r.available) return { ok: false, error: r.error || '没有可安装的新版本' };
  }
  try {
    updateState.downloading = true;
    autoUpdater.on('download-progress', (p) => {
      updateState.progress = p && p.percent ? Math.round(p.percent) : 0;
    });
    autoUpdater.on('update-downloaded', () => {
      log('下载完成，准备安装');
      updateState.downloading = false;
      // 立刻退出并安装
      autoUpdater.quitAndInstall(false, true);
    });
    await autoUpdater.downloadUpdate();
    return { ok: true, downloading: true };
  } catch (e) {
    updateState.downloading = false;
    updateState.error = e && e.message ? e.message : String(e);
    log('下载失败', { message: updateState.error });
    return { ok: false, error: updateState.error };
  }
}

function currentVersion() {
  try { return app.getVersion(); } catch (e) { return '?'; }
}

/** 装好后重启 */
function onUpdateDownloaded() {
  logger.info('自动更新：下载完成，退出并安装');
}

module.exports = {
  check, downloadAndInstall, isPortable, currentVersion,
  state: () => ({ ...updateState }),
  onUpdateDownloaded
};
