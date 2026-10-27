const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function withTimeout(operation, ms) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('PDF 导出超时，请检查图片或文档后重试')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

// Render a separate, sandboxed document so editor controls and theme never enter the PDF.
async function exportPdf({ BrowserWindow, dialog, parent, documents, html, suggestedName }) {
  let printWindow, temporary;
  try {
    if (typeof html !== 'string' || !/<head\b[^>]*>/i.test(html)) throw new Error('无效的导出内容');
    const name = path.basename(String(suggestedName || 'untitled').replace(/\\/g, '/'));
    const result = await dialog.showSaveDialog(parent, {
      title: '导出 PDF', defaultPath: path.join(documents, name + '.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (result.canceled || !result.filePath) return null;
    printWindow = new BrowserWindow({ show: false, webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false
    }});
    printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    printWindow.webContents.on('will-navigate', event => event.preventDefault());
    const policy = "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; base-uri 'none'; form-action 'none'";
    const content = html.replace(/<head\b[^>]*>/i, `<head><meta http-equiv="Content-Security-Policy" content="${policy}">`);
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qingmo-print-'));
    const documentPath = path.join(temporary, 'document.html');
    await fs.writeFile(documentPath, content, 'utf8');
    await withTimeout(printWindow.loadFile(documentPath), 15000);
    await withTimeout(printWindow.webContents.executeJavaScript(`(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images, image => new Promise((resolve, reject) => {
        const done = () => image.naturalWidth ? resolve() : reject(new Error('图片加载失败，请检查图片后重试'));
        if (image.complete) return done();
        const timeout = setTimeout(() => reject(new Error('图片加载超时，请检查网络后重试')), 10000);
        image.addEventListener('load', () => { clearTimeout(timeout); done(); }, { once: true });
        image.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('图片加载失败，请检查图片后重试')); }, { once: true });
      })));
    })()`), 15000);
    const pdf = await withTimeout(printWindow.webContents.printToPDF({
      pageSize: 'A4', printBackground: true, preferCSSPageSize: false,
      margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
    }), 30000);
    await fs.writeFile(result.filePath, pdf);
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: error.message || 'PDF 导出失败' };
  } finally {
    if (printWindow && !printWindow.isDestroyed()) printWindow.destroy();
    if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}
module.exports = { exportPdf };
