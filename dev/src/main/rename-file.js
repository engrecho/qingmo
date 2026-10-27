const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
function validName(name) {
  return typeof name === 'string' && name.trim() === name && name.length > 0 &&
    !/[<>:"/\\|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}
async function renameFile(source, name) {
  if (typeof source !== 'string' || !path.isAbsolute(source) || !validName(name)) throw new Error('文件名无效，请勿包含路径或特殊字符');
  const target = path.join(path.dirname(source), name);
  if (target === source) return { ok: true, path: target };
  const stat = await fs.lstat(source);
  if (!stat.isFile()) throw new Error('只能重命名普通文件');
  // Exclusive creation prevents silently overwriting another document on any platform.
  try { await fs.link(source, target); }
  catch (error) {
    if (error.code === 'EEXIST' && path.basename(source).toLowerCase() === name.toLowerCase()) {
      const entries = await fs.readdir(path.dirname(source));
      const targetStat = await fs.lstat(target);
      if (!entries.includes(name) && targetStat.ino === stat.ino && targetStat.dev === stat.dev) {
        await fs.rename(source, target);
        return { ok: true, path: target };
      }
    }
    if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error;
    await fs.copyFile(source, target, constants.COPYFILE_EXCL);
  }
  try { await fs.unlink(source); }
  catch (error) { await fs.unlink(target).catch(() => {}); throw error; }
  return { ok: true, path: target };
}
module.exports = { renameFile, validName };
