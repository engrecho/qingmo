// Electron 33 的 net.fetch({redirect:'manual'}) 遇到 302 会抛出
// “Redirect was cancelled”，并不返回可读取 Location 的 Response。
// 用 net.request 明确暴露重定向；调用方逐跳检查来源后再发起下一次请求。
function updateFetch(net, url, { signal, headers = {}, redirect = 'manual' } = {}) {
  if (redirect !== 'manual') return net.fetch(url, { signal, headers, redirect });
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'manual' });
    let settled = false, finished = false, body;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const fail = error => {
      if (finished) return;
      finished = true;
      cleanup();
      if (!settled) reject(error);
      else body?.error(error);
    };
    const abort = () => { fail(signal.reason || new Error('更新请求已取消')); request.abort(); };
    request.on('error', fail);
    request.on('redirect', (status, _method, location) => {
      settled = finished = true;
      cleanup();
      resolve(new Response(null, { status, headers: { location } }));
      request.abort();
    });
    request.on('response', response => {
      const responseHeaders = new Headers();
      for (const [key, values] of Object.entries(response.headers)) {
        for (const value of Array.isArray(values) ? values : [values]) responseHeaders.append(key, value);
      }
      const stream = new ReadableStream({
        start(controller) {
          body = controller;
          response.on('end', () => { if (!finished) { finished = true; cleanup(); controller.close(); } });
          response.on('error', fail);
          response.on('aborted', () => fail(new Error('更新下载连接已中断')));
          response.on('data', chunk => { if (!finished) controller.enqueue(chunk); });
        },
        cancel() { finished = true; cleanup(); request.abort(); }
      });
      settled = true;
      resolve(new Response([204, 205, 304].includes(response.statusCode) ? null : stream, { status: response.statusCode, headers: responseHeaders }));
    });
    for (const [key, value] of Object.entries(headers)) request.setHeader(key, value);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else request.end();
  });
}
module.exports = { updateFetch };
