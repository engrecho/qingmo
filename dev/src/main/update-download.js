// GitHub Release 安装包下载：限制来源、原子落盘、校验大小与 SHA256。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

function allowedUrl(value, initial = false) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('更新下载地址不安全');
  if (initial) {
    if (url.hostname !== 'github.com' || !url.pathname.startsWith('/engrecho/qingmo/releases/download/')) throw new Error('安装包不属于轻墨官方 Release');
  } else if (!['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) {
    throw new Error('更新下载重定向来源不受信任');
  }
  return url.href;
}

function validateAsset(asset, version) {
  if (!asset || !/^[A-Za-z0-9._-]+\.(exe|dmg)$/i.test(asset.name) || !asset.name.includes(`-${version}-`)) throw new Error('安装包名称与版本不匹配');
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 1024 ** 3) throw new Error('安装包大小无效');
  if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '')) throw new Error('Release 缺少安装包 SHA256，请前往发布页下载');
  allowedUrl(asset.url, true);
}

async function verifyFile(file, asset) {
  try {
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.size !== asset.size) return false;
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return 'sha256:' + hash.digest('hex') === asset.digest.toLowerCase();
  } catch { return false; }
}

async function downloadAsset({ asset, version, directory, fetch, onProgress = () => {}, idleMs = 60000, totalMs = 30 * 60 * 1000 }) {
  validateAsset(asset, version);
  await fs.promises.mkdir(directory, { recursive: true });
  const file = path.join(directory, asset.name);
  if (await verifyFile(file, asset)) { onProgress(100); return file; }
  const temp = file + '.' + process.pid + '.part';
  await fs.promises.rm(temp, { force: true });
  const controller = new AbortController();
  let idleTimer;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error('更新下载长时间无响应')), idleMs);
  };
  const totalTimer = setTimeout(() => controller.abort(new Error('更新下载超时')), totalMs);
  try {
    let url = allowedUrl(asset.url, true);
    let response;
    for (let redirects = 0; redirects <= 5; redirects++) {
      resetIdle();
      response = await fetch(url, { signal: controller.signal, redirect: 'manual', headers: { 'User-Agent': 'QingMo-Updater' } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 5) throw new Error('更新下载重定向异常');
      url = allowedUrl(new URL(location, url).href);
    }
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
    let received = 0;
    const hash = crypto.createHash('sha256');
    const monitor = new Transform({ transform(chunk, _encoding, next) {
      received += chunk.length;
      if (received > asset.size) { next(new Error('安装包大小超出 Release 声明')); return; }
      resetIdle();
      hash.update(chunk);
      onProgress(Math.min(99, Math.floor(received * 100 / asset.size)));
      next(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), monitor, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
    if (received !== asset.size || 'sha256:' + hash.digest('hex') !== asset.digest.toLowerCase()) throw new Error('安装包校验失败，请重试下载');
    await fs.promises.rm(file, { force: true });
    await fs.promises.rename(temp, file);
    onProgress(100);
    return file;
  } catch (error) {
    await fs.promises.rm(temp, { force: true });
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
  }
}
module.exports = { downloadAsset, verifyFile, validateAsset, allowedUrl };
