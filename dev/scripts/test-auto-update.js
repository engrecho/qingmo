const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createAutoUpdater } = require('../src/main/auto-update');
const { downloadAsset, allowedUrl } = require('../src/main/update-download');
const mac = require('../src/main/platform/mac');
const win = require('../src/main/platform/win');
const payload = Buffer.from('verified installer fixture');
const name = 'QingMo-1.7.0-mac-arm64.dmg';
const asset = { name, size: payload.length, digest: 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex'), url: 'https://github.com/engrecho/qingmo/releases/download/v1.7.0/' + name };
const release = { ok: true, current: '1.6.2', latest: '1.7.0', hasUpdate: true, newerExists: true, platformReady: true, match: asset };
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qingmo-update-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = { checks: 0, downloads: 0, opened: 0, prompts: 0, states: [] };
  const base = {
    app: { isPackaged: true, getVersion: () => '1.6.2', getPath: () => directory },
    checkRelease: async () => { calls.checks++; return structuredClone(release); },
    fetch: async () => { calls.downloads++; return new Response(payload); },
    openInstaller: async () => { calls.opened++; return ''; },
    onReady: () => { calls.prompts++; },
    onState: state => calls.states.push(state)
  };
  const updater = createAutoUpdater({ ...base, ...options });
  t.after(() => updater.stop());
  return { updater, calls, directory, base };
}

test('有新版自动下载，校验完成后只提示，不自动安装；点击后才打开安装包', async t => {
  const { updater: u, calls } = await fixture(t);
  await u.checkAndDownload();
  await u.download();
  await Promise.resolve();
  assert.equal(u.state().ready, true);
  assert.equal(u.state().progress, 100);
  assert.equal(calls.downloads, 1);
  assert.equal(calls.prompts, 1);
  assert.equal(calls.opened, 0);
  assert(calls.states.some(s => s.downloading));
  await u.checkAndDownload();
  assert.equal(calls.downloads, 1);
  assert.equal(calls.prompts, 1);
  assert.equal((await u.install()).ok, true);
  assert.equal(calls.opened, 1);
});

test('相同和更旧版本不下载，即使返回了错误的 hasUpdate 标记', async t => {
  for (const latest of ['1.6.2', '1.5.0']) {
    const { updater: u, calls } = await fixture(t, { checkRelease: async () => ({ ...release, latest }) });
    await u.checkAndDownload();
    assert.equal(u.state().available, false);
    assert.equal(calls.downloads, 0);
  }
});

test('并发检查、手动和自动下载共用同一个请求', async t => {
  const { updater: u, calls } = await fixture(t);
  await Promise.all([u.checkAndDownload(), u.checkAndDownload(), u.checkAndDownload()]);
  await Promise.all([u.download(), u.download()]);
  assert.equal(calls.checks, 1);
  assert.equal(calls.downloads, 1);
  assert.equal(calls.prompts, 1);
});

test('重启后校验并复用已下载安装包，不再消耗下载流量', async t => {
  const { updater: u, base, calls } = await fixture(t);
  await u.checkAndDownload(); await u.download();
  const restarted = createAutoUpdater({ ...base, fetch: async () => { throw new Error('不应该再次下载'); } });
  t.after(() => restarted.stop());
  await restarted.checkAndDownload();
  assert.equal((await restarted.download()).ready, true);
  assert.equal(calls.downloads, 1);
});

test('下载内容错误、截断、超出大小时清理半包，禁止安装', async t => {
  for (const body of [Buffer.alloc(payload.length, 1), payload.subarray(0, 5), Buffer.concat([payload, payload])]) {
    const { updater: u, directory, calls } = await fixture(t, { fetch: async () => new Response(body) });
    await u.checkAndDownload();
    assert.equal((await u.download()).ok, false);
    assert.equal(u.state().ready, false);
    assert.equal(calls.prompts, 0);
    assert.equal((await u.install()).ok, false);
    assert.equal(calls.opened, 0);
    assert.deepEqual(await fs.readdir(path.join(directory, 'updates')), []);
  }
});

test('网络中断后能重试，不遗留半包', async t => {
  let attempts = 0;
  const { updater: u, calls } = await fixture(t, { fetch: async () => {
    if (++attempts === 1) return new Response(new ReadableStream({ start(controller) { controller.enqueue(payload.subarray(0, 4)); controller.error(new Error('网络断开')); } }));
    return new Response(payload);
  } });
  await u.checkAndDownload();
  assert.equal((await u.download()).ok, false);
  assert.equal(u.state().downloading, false);
  await u.checkAndDownload();
  assert.equal((await u.download()).ok, true);
  assert.equal(calls.prompts, 1);
});

test('文件被修改或删除，安装前再次校验并可重新下载', async t => {
  const { updater: u, directory, calls } = await fixture(t);
  await u.checkAndDownload(); await u.download();
  await fs.writeFile(path.join(directory, 'updates', name), 'bad');
  assert.equal((await u.install()).ok, false);
  assert.equal(calls.opened, 0);
  assert.equal(u.state().ready, false);
  await u.checkAndDownload(); await u.download();
  assert.equal(u.state().ready, true);
  assert.equal(calls.downloads, 2);
});

test('检查失败不会销毁已校验的安装包', async t => {
  let fail = false;
  const { updater: u } = await fixture(t, { checkRelease: async () => { if (fail) throw new Error('离线'); return release; } });
  await u.checkAndDownload(); await u.download(); fail = true;
  await u.checkAndDownload();
  assert.equal(u.state().ready, true);
  assert.equal((await u.install()).ok, true);
});

test('当前平台缺少资产或限流降级时不下载', async t => {
  const { updater: u, calls } = await fixture(t, { checkRelease: async () => ({ ...release, hasUpdate: false, match: null, platformReady: false, degraded: true }) });
  await u.checkAndDownload();
  assert.equal(calls.downloads, 0);
  assert.equal(u.state().newerExists, true);
  assert.equal(u.state().ready, false);
});

test('缺少 digest、不属于官方仓库或危险名称时拒绝下载', async t => {
  for (const override of [{ digest: null }, { url: 'https://github.com/attacker/project/releases/download/v1/a.exe' }, { name: '../a.exe' }]) {
    const { updater: u, calls } = await fixture(t, { checkRelease: async () => ({ ...release, match: { ...asset, ...override } }) });
    await u.checkAndDownload();
    assert.equal((await u.download()).ok, false);
    assert.equal(calls.downloads, 0);
    assert.equal(calls.prompts, 0);
  }
  assert.throws(() => allowedUrl('http://github.com/engrecho/qingmo/releases/download/v1/a.exe', true));
});

test('只允许 GitHub 可信重定向，拒绝第三方地址', async t => {
  const { directory } = await fixture(t);
  let count = 0;
  const file = await downloadAsset({ asset, version: '1.7.0', directory, fetch: async () => ++count === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture' } }) : new Response(payload) });
  assert.deepEqual(await fs.readFile(file), payload);
  await fs.rm(file);
  await assert.rejects(downloadAsset({ asset, version: '1.7.0', directory, fetch: async () => new Response(null, { status: 302, headers: { location: 'https://example.com/fake.exe' } }) }), /来源不受信任/);
});

test('响应超时能终止等待，且不会标记下载完成', async t => {
  const { directory } = await fixture(t);
  await assert.rejects(downloadAsset({ asset, version: '1.7.0', directory, idleMs: 15, totalMs: 100, fetch: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))) }), /无响应/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('调度：启动后 10 秒和每 6 小时检查；重复启动不会多注册', async t => {
  const recorded = [], cleared = [];
  const timers = { setTimeout: (fn, ms) => { recorded.push({ fn, ms }); return 1; }, setInterval: (fn, ms) => { recorded.push({ fn, ms }); return 2; }, clearTimeout: id => cleared.push(id), clearInterval: id => cleared.push(id) };
  const { updater: u, calls } = await fixture(t, { timers });
  u.start(); u.start();
  assert.deepEqual(recorded.map(x => x.ms), [10000, 21600000]);
  await recorded[0].fn(); await u.download();
  assert.equal(calls.checks, 1);
  u.stop(); assert.deepEqual(cleared, [1, 2]);
});

test('开发模式不触发后台网络请求', async t => {
  const { updater: u, calls } = await fixture(t, { app: { isPackaged: false, getVersion: () => '1.6.2' } });
  u.start();
  const state = await u.checkAndDownload();
  assert.equal(state.reason, 'dev-mode');
  assert.equal(calls.checks, 0);
  assert.equal(calls.downloads, 0);
});

test('跨平台资产匹配：Mac 只选对应架构 DMG，Windows 只选对应架构 setup', () => {
  const assets = ['QingMo-1.7.0-mac-x64.zip', 'QingMo-1.7.0-mac-arm64.dmg', 'QingMo-1.7.0-mac-x64.dmg', 'QingMo-1.7.0-win-setup.exe', 'QingMo-1.7.0-win-arm64-setup.exe'].map(name => ({ name }));
  assert.equal(mac.matchUpdateInstaller(assets, 'arm64').name, assets[1].name);
  assert.equal(mac.matchUpdateInstaller(assets, 'x64').name, assets[2].name);
  assert.equal(mac.matchUpdateInstaller([assets[2]], 'arm64'), undefined);
  assert.equal(mac.matchUpdateInstaller([assets[0]], 'x64'), undefined);
  assert.equal(win.matchUpdateInstaller(assets, 'x64').name, assets[3].name);
  assert.equal(win.matchUpdateInstaller(assets, 'arm64').name, assets[4].name);
  assert.equal(win.matchUpdateInstaller([assets[3]], 'arm64'), undefined);
});

test('后台网络失败会安排一次 15 分钟重试，退出时取消', async t => {
  const recorded = [], cleared = [];
  const timers = { setTimeout: (fn, ms) => { recorded.push({ fn, ms }); return recorded.length; }, setInterval: (fn, ms) => { recorded.push({ fn, ms }); return recorded.length; }, clearTimeout: id => cleared.push(id), clearInterval: id => cleared.push(id) };
  const { updater: u } = await fixture(t, { timers, checkRelease: async () => { throw new Error('离线'); } });
  u.start();
  await u.checkAndDownload(); await u.checkAndDownload();
  assert.deepEqual(recorded.map(item => item.ms), [10000, 21600000, 900000]);
  u.stop(); assert(cleared.includes(3));
});

test('限流降级仍能继续安装已校验的同版本缓存', async t => {
  let degraded = false;
  const { updater: u } = await fixture(t, { checkRelease: async () => degraded ? { ...release, hasUpdate: false, match: null, platformReady: false, degraded: true } : release });
  await u.checkAndDownload(); await u.download();
  degraded = true; await u.checkAndDownload();
  assert.equal(u.state().ready, true);
  assert.equal((await u.install()).ok, true);
});
