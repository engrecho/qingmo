#!/usr/bin/env node
// 从未加留白的共享 LOGO 生成 macOS 图标。仅调整 macOS，不修改 Windows ICO。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const DEV = path.resolve(__dirname, '../..');
const OUT = path.join(DEV, '../.cache/icons/mac.iconset');
const SOURCE = path.join(DEV, 'build/icons/logo-source.png');
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  await win.loadURL('about:blank');
  const source = fs.readFileSync(SOURCE).toString('base64');
  const images = await win.webContents.executeJavaScript(`(async () => {
    const image = new Image();
    image.src = 'data:image/png;base64,${source}';
    await image.decode();
    const result = [];
    for (const base of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const size = base * scale;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        // 整体占画布约 80%，白色底板和黑色字形一起缩小。
        const inset = Math.round(size * 0.1);
        ctx.drawImage(image, inset, inset, size - inset * 2, size - inset * 2);
        result.push({ name: 'icon_' + base + 'x' + base + (scale === 2 ? '@2x' : '') + '.png', data: canvas.toDataURL('image/png').split(',')[1] });
      }
    }
    return result;
  })()`);
  for (const image of images) fs.writeFileSync(path.join(OUT, image.name), Buffer.from(image.data, 'base64'));
  execFileSync('iconutil', ['-c', 'icns', OUT, '-o', path.join(DEV, 'build/icons/icon.icns')]);
  console.log('macOS ICNS 已生成：四周约 10% 透明留白');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
