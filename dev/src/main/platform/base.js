/**
 * 跨平台默认实现
 *
 * 这里放「所有平台行为一致」的那部分。只有真正存在差异的点，
 * 才在 mac.js / win.js 里覆盖。
 *
 * 新增平台时：在 index.js 里加一条 require，再写一个 <平台>.js，
 * main.js 本身不需要改动。
 */
module.exports = {
  id: 'base',
  imagePaths: require('path'),

  matchUpdateInstaller() { return null; },
  openUpdateInstaller(shell, file) { return shell.openPath(file); },
  updateInstallHint: '安装前请先保存正在编辑的文档。',

  /** BrowserWindow.titleBarStyle */
  titleBarStyle: 'default',

  /** 应用级菜单（macOS 的「轻墨」菜单）。其他平台为 null。 */
  appMenuItem: null,

  /** 「文件」菜单末尾项：macOS 用 close（关窗口不退出应用），其他平台用 quit。 */
  quitMenuItem: { role: 'quit' },

  /** 任务栏 / Dock 图标 */
  setAppIcon(app, nativeImage, icon) {},

  /**
   * 注册「双击文件用本应用打开」的入口
   *
   * 默认实现 = 命令行传参（mac / win 都支持：
   * `轻墨.app file.md`、`轻墨.exe file.md`）。
   * macOS 的 Finder 双击走 open-file 事件，由 mac.js 在此基础上追加。
   */
  registerFileOpen(app, isDocPath, openPathInApp) {
    // 跳过可执行文件本身和 electron 开关
    for (const a of process.argv.slice(1)) {
      if (isDocPath(a)) {
        app.whenReady().then(() => openPathInApp(a));
        break;
      }
    }
  },

  /** 所有窗口关闭后是否退出应用（macOS 惯例：不退出） */
  quitOnAllWindowsClosed: true,

  /** 更新检查时，从 GitHub Release 资产里挑当前平台的那一个 */
  matchUpdateAsset(assets, arch) { return null; }
};
