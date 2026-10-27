// README GIFs: real renderer, isolated session, actual input and state assertions.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qingmo-gifs-'));
app.setPath('userData', path.join(temp, 'session'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  ipcMain.handle('app:autoState', () => ({ phase: 'idle' }));
  ipcMain.on('app:getVersion', e => { e.returnValue = require('../package.json').version; });
  ipcMain.handle('log:report', () => true);
  const win = new BrowserWindow({ width: 1120, height: 760, show: false,
    webPreferences: { preload: path.join(root, 'dev/src/main/preload.js'), contextIsolation: true } });
  const js = code => win.webContents.executeJavaScript(code);
  let frames, index;
  async function frame() {
    fs.writeFileSync(path.join(frames, `${String(index++).padStart(4, '0')}.png`),
      (await win.webContents.capturePage()).toPNG());
  }
  async function hold(count) { for (let i = 0; i < count; i++) { await wait(125); await frame(); } }
  async function begin(name, text) {
    frames = path.join(temp, name); fs.mkdirSync(frames); index = 0;
    await js(`window.__qingmo.setLiveEdit(false);window.__qingmo.setDoc(${JSON.stringify(text)});document.querySelector('[data-view=split]').click();window.__qingmo.toggleOutline(false);if(document.documentElement.dataset.theme==='dark')document.getElementById('btnTheme').click()`);
    await wait(800);
  }
  function encode(name) {
    execFileSync('ffmpeg', ['-v', 'error', '-threads', '1', '-framerate', '8', '-i', path.join(frames, '%04d.png'),
      '-filter_complex_threads', '1', '-filter_complex',
      '[0:v]scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
      '-loop', '0', '-y', path.join(root, 'docs/assets', name + '.gif')], { stdio: 'inherit' });
    console.log('PASS', name, index, 'frames');
  }
  try {
    await win.loadFile(path.join(root, 'dev/src/renderer/index.html'), { query: { test: '1' } });
    await wait(800);
    const initial = '# 即写即读\n\n在左边写 Markdown，在右边看见成稿。\n\n';
    await begin('live-preview', initial); await hold(8);
    await js(`window.__qingmo.setCursor(window.__qingmo.getDoc().length);document.querySelector('.cm-content').focus()`);
    for (const text of ['## 把想法写下来', '\n\n', '今天，', '从一句话开始。', '\n\n', '- 写下灵感', '\n- 整理结构', '\n- 保存成稿']) {
      await win.webContents.insertText(text); await hold(3);
    }
    await hold(12);
    assert.match(await js("document.getElementById('preview').innerText"), /保存成稿/);
    assert.equal(await js("document.querySelector('#preview h2').textContent"), '把想法写下来');
    encode('live-preview');

    const sample = fs.readFileSync(path.join(root, 'docs/examples/直接在预览里修改.md'), 'utf8');
    await begin('theme-switch', sample); await hold(12);
    await js("document.getElementById('btnTheme').click()");
    assert.equal(await js('document.documentElement.dataset.theme'), 'dark'); await hold(20);
    await js("document.getElementById('btnTheme').click()");
    assert.equal(await js('document.documentElement.dataset.theme'), 'light'); await hold(16);
    encode('theme-switch');

    const previewDoc = '# 在预览里，继续写\n\n读到哪里，就改到哪里。\n\n## 最后一次润色\n\n先写下来，再读一遍。\n';
    await begin('preview-edit', previewDoc);
    await js('window.__qingmo.setLiveEdit(true)'); await wait(2400); await hold(8);
    await js(`(() => { const p=document.querySelector('#preview h2 + p');document.getElementById('preview').focus();const r=document.createRange();r.selectNodeContents(p);r.collapse(false);const s=window.getSelection();s.removeAllRanges();s.addRange(r); })()`);
    const addition = ' 把真正想说的话，留下来。';
    for (const text of [' 把真正', '想说的话，', '留下来。']) { await win.webContents.insertText(text); await hold(5); }
    await hold(20);
    assert.equal(await js('window.__qingmo.getDoc()'), previewDoc.replace('先写下来，再读一遍。', '先写下来，再读一遍。' + addition));
    assert.match(await js("document.querySelector('.cm-content').innerText"), /把真正想说的话，留下来/);
    encode('preview-edit');
    win.destroy(); await wait(300); fs.rmSync(temp, { recursive: true, force: true }); app.exit(0);
  } catch (error) {
    console.error(error); win.destroy(); fs.rmSync(temp, { recursive: true, force: true }); app.exit(1);
  }
});
