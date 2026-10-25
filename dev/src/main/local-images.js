const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };

function markdownImagePath(file, baseDir, paths = path) {
  const relative = baseDir && paths.isAbsolute(baseDir) ? paths.relative(baseDir, file) : file;
  const encoded = encodeURI(relative.replace(/\\/g, '/')).replace(/[()#?]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  return relative.startsWith('\\\\') ? 'file:' + encoded : encoded;
}

function resolveImagePath(source, documentPath, paths = path) {
  if (typeof source !== 'string' || !source || source.length > 32768) throw new Error('图片路径无效');
  if (/^file:/i.test(source)) return fileURLToPath(source);
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) throw new Error('仅支持读取本地图片');
  const file = decodeURIComponent(source.split(/[?#]/, 1)[0]);
  if (paths.isAbsolute(file)) return paths.normalize(file);
  if (!documentPath || !paths.isAbsolute(documentPath)) throw new Error('请先保存文档，以确定相对图片路径的位置');
  return paths.resolve(paths.dirname(documentPath), file);
}

async function readLocalImage(source, documentPath, paths = path) {
  try {
    const file = resolveImagePath(source, documentPath, paths);
    const mime = TYPES[paths.extname(file).toLowerCase()];
    if (!mime) throw new Error('不支持的图片格式');
    const handle = await fs.promises.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('图片必须为不超过 20 MB 的文件');
      const data = await handle.readFile();
      if (data.length > 20 * 1024 * 1024) throw new Error('图片超过 20 MB');
      return { ok: true, dataUrl: `data:${mime};base64,${data.toString('base64')}` };
    } finally { await handle.close(); }
  } catch (error) { return { ok: false, error: error.message }; }
}
module.exports = { markdownImagePath, resolveImagePath, readLocalImage };
