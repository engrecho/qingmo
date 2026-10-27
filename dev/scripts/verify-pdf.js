const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { exportPdf } = require('../src/main/pdf-export');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qingmo-pdf-'));
app.setPath('userData', path.join(temp, 'session'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.resolve(__dirname, '../src/main/preload.js'), contextIsolation: true
  }});
  let target = path.join(temp, 'document.pdf'), pending, exportedHtml;
  const dialog = { showSaveDialog: async () => target ? { filePath: target } : { canceled: true } };
  ipcMain.handle('app:autoState', () => ({ phase: 'idle' }));
  ipcMain.on('app:getVersion', e => { e.returnValue = 'test'; });
  ipcMain.handle('log:report', () => true);
  ipcMain.handle('fs:exportPdf', (_e, html, name) => {
    exportedHtml = html;
    pending = exportPdf({ BrowserWindow, dialog, parent: win, documents: temp, html, suggestedName: name });
    return pending;
  });
  ipcMain.handle('fs:readImage', (_e, source, documentPath) => require('../src/main/local-images').readLocalImage(source, documentPath));
  const js = code => win.webContents.executeJavaScript(code);
  async function runExport() {
    pending = null;
    await js("document.querySelector('[data-cmd=\"cmd:exportPdf\"]').click()");
    for (let i = 0; !pending && i < 100; i++) await wait(50);
    assert(pending, 'PDF toolbar should invoke the real export');
    return pending;
  }
  try {
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'), { query: { test: '1' } });
    await wait(600);
    const text = '# PDF export regression\n\n**Bold text** and 中文导出。\n\n| Name | Value |\n| --- | --- |\n| PDF | Works |\n\n' + Array.from({ length: 90 }, (_, i) => `Paragraph ${i + 1}: readable document content.\n`).join('\n');
    await js(`window.__qingmo.setDoc(${JSON.stringify(text)});document.getElementById('btnTheme').click()`);
    const result = await runExport();
    assert.equal(result.ok, true, result.error);
    assert.equal(fs.readFileSync(target).subarray(0, 5).toString(), '%PDF-');
    const pdfText = execFileSync('pdftotext', [target, '-'], { encoding: 'utf8' });
    assert.match(pdfText, /PDF export regression/); assert.match(pdfText, /Bold text/);
    assert.match(pdfText, /Paragraph 90/); assert.match(pdfText, /中文导出/);
    const info = execFileSync('pdfinfo', [target], { encoding: 'utf8' });
    assert(Number(/Pages:\s+(\d+)/.exec(info)[1]) > 1);
    assert.match(info, /A4/); assert.match(exportedHtml, /@media print/);
    assert.equal(await js('window.__qingmo.getDoc()'), text);
    console.log('PASS toolbar → preload → PDF export: real multipage A4 PDF, Chinese, headings, table, source preserved');
    target = null; assert.equal(await runExport(), null);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    console.log('PASS cancellation leaves no hidden print window');
    target = path.join(temp, 'image.pdf');
    const imagePath = path.resolve(__dirname, '../build/icons/icon-256.png');
    await js(`window.__qingmo.setDoc(${JSON.stringify('# Image export\n\n![logo](' + imagePath + ')')})`);
    assert.equal((await runExport()).ok, true);
    assert.match(exportedHtml, /src="data:image\/png;base64,/);
    const images = execFileSync('pdfimages', ['-list', target], { encoding: 'utf8' });
    assert.match(images, /image/); assert(images.trim().split('\n').length > 2);
    console.log('PASS local image embedded in the actual PDF');
    target = path.join(temp, 'missing', 'fail.pdf');
    const failed = await runExport(); assert.equal(failed.ok, false); assert.match(failed.error, /ENOENT/);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    console.log('PASS write failure reported, hidden print window cleaned');
    assert.equal(await js("document.getElementById('btnOutline').textContent.trim()"), '');
    assert.equal(await js("document.getElementById('btnOutline').getAttribute('aria-label')"), '文档大纲');
    assert.equal(await js("document.querySelector('#btnOutline use').getAttribute('href')"), '#i-outline');
    console.log('PASS outline icon retains accessible name');
    win.destroy(); await wait(300); fs.rmSync(temp, { recursive: true, force: true }); app.exit(0);
  } catch (error) {
    console.error(error); win.destroy(); await wait(300); fs.rmSync(temp, { recursive: true, force: true }); app.exit(1);
  }
});
