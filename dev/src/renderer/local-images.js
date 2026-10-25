// 先保留本地 src，再统一清洗 HTML；显示用 data URL，源码仍保留原路径。
export function imageHtml(raw, sanitize) {
  const template = document.createElement('template');
  template.innerHTML = raw;
  for (const image of template.content.querySelectorAll('img')) {
    image.removeAttribute('data-qingmo-image');
    const source = image.getAttribute('src') || '';
    if (source && !/^(?:https?:|data:|\/\/)/i.test(source) && (!/^[a-z][a-z0-9+.-]*:/i.test(source) || /^(?:file:|[a-z]:[\\/])/i.test(source))) {
      image.setAttribute('data-qingmo-image', source);
      image.removeAttribute('src');
    }
  }
  return sanitize(template.innerHTML);
}

export async function loadLocalImages(container, documentPath, readImage) {
  const pending = new Map();
  await Promise.all([...container.querySelectorAll('img[data-qingmo-image]')].map(async image => {
    const source = image.getAttribute('data-qingmo-image');
    if (!pending.has(source)) pending.set(source, readImage(source, documentPath));
    try {
      const result = await pending.get(source);
      if (!result?.ok || !/^data:image\/(?:png|jpeg|gif|webp|svg\+xml|bmp);base64,/i.test(result.dataUrl)) throw new Error(result?.error || '图片读取失败');
      image.src = result.dataUrl;
    } catch (error) { image.title = '图片无法显示：' + error.message; }
  }));
}
