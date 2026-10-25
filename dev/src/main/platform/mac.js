/**
 * macOS 专属实现
 *
 * 与 Windows 的主要差异：
 *   1. 标题栏用 hiddenInset（内容延伸到标题栏后面）
 *   2. 多一个应用级菜单（「轻墨」菜单）
 *   3. 「文件」菜单末尾是 close 而不是 quit（关窗口不退出应用）
 *   4. Dock 图标用 app.dock.setIcon
 *   5. 双击 .md 走 open-file 事件，不是命令行参数
 *   6. 窗口全关后应用仍留在 Dock
 *   7. 更新资产是 mac-arm64 / mac-x64 的 zip
 */
const base = require('./base');

module.exports = {
  ...base,
  id: 'mac',

  matchUpdateInstaller(assets, arch) {
    if (!['arm64', 'x64'].includes(arch)) return null;
    return assets.find(asset => new RegExp('mac-' + arch + '\\.dmg$', 'i').test(asset.name));
  },
  updateInstallHint: '请先保存文档。打开 DMG 后，将轻墨拖入 Applications 替换旧版；替换前请退出轻墨。',

  titleBarStyle: 'hiddenInset',
  appMenuItem: { role: 'appMenu' },
  quitMenuItem: { role: 'close' },

  // Dock 使用应用包内的 macOS ICNS，保留平台专属透明留白。
  // 不用共享的满幅 Windows PNG 覆盖系统加载的图标。
  setAppIcon() {},

  /**
   * macOS 的打开方式有两条，两条都要支持：
   *   1. 命令行传参 —— `轻墨.app file.md`（base 的默认实现）
   *   2. Finder 双击 / 「打开方式」—— 发 open-file 事件（macOS 特有）
   *
   * 注意：open-file 事件可能早于 app ready（此时 win 还是 null），
   * 所以必须在模块顶层注册，不能等 whenReady 之后再挂。
   */
  registerFileOpen(app, isDocPath, openPathInApp) {
    base.registerFileOpen(app, isDocPath, openPathInApp);

    app.on('open-file', (e, p) => {
      e.preventDefault();
      openPathInApp(p);
    });
  },

  quitOnAllWindowsClosed: false,

  matchUpdateAsset(assets, arch) {
    const isArm = arch === 'arm64';
    return assets.find(a => /mac.*(arm64|x64)/i.test(a.name) && (isArm ? /arm64/i.test(a.name) : /x64/i.test(a.name)))
        || assets.find(a => /mac/i.test(a.name));
  }
};
