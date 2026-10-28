// Launch Services paths are always POSIX, including cross-platform test fixtures.
const path = require('path').posix;
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);
const EXTS = ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdtxt', 'mdtext'];
const PROGID = 'cn.bajiaolu.qingmo';
function createMacFileAssoc({ app, execute = run, resources = process.resourcesPath }) {
  const helper = () => app.isPackaged
    ? path.join(resources, 'mac', 'file-assoc')
    : path.resolve(__dirname, '../../build/mac/file-assoc');
  async function invoke(action) {
    if (action === 'register' && !app.isPackaged) throw new Error('请先将轻墨安装到 Applications，再修复文件关联');
    const args = [action];
    if (action === 'register') args.push(path.resolve(app.getPath('exe'), '../../..'));
    const { stdout } = await execute(helper(), args, { timeout: 15000, maxBuffer: 128 * 1024 });
    const list = JSON.parse(stdout);
    if (!Array.isArray(list) || list.length !== EXTS.length || EXTS.some(ext => !list.some(r => r.ext === ext))) throw new Error('macOS 文件关联检查结果无效');
    return list;
  }
  return {
    check: () => invoke('check'),
    register: async () => {
      const registered = await invoke('register');
      let results = registered;
      // Launch Services may propagate defaults asynchronously. Query from a new
      // helper process rather than relying on the setter process's cached view.
      for (let attempt = 0; attempt < 6; attempt++) {
        results = await invoke('check');
        if (results.every(r => r.isQingMo)) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return { ok: registered.every(r => r.ok) && results.every(r => r.isQingMo), results };
    }
  };
}
module.exports = { EXTS, PROGID, createMacFileAssoc,
  check: () => createMacFileAssoc({ app: require('electron').app }).check(),
  register: () => createMacFileAssoc({ app: require('electron').app }).register()
};
