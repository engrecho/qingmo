// Real Electron transport + real 302/307 responses. No external network or installers.
const { app, net } = require('electron');
const http = require('http');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');
const { updateFetch } = require('../src/main/update-fetch');
const { downloadAsset } = require('../src/main/update-download');
const payload = Buffer.alloc(1024 * 1024 + 13, 42);
let blocked = 0, requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  if (req.url === '/start') { res.writeHead(302, { location: '/redirect' }); res.end(); }
  else if (req.url === '/redirect') { res.writeHead(307, { location: '/payload' }); res.end(); }
  else if (req.url === '/bad') { res.writeHead(302, { location: '/blocked' }); res.end(); }
  else if (req.url === '/blocked') { blocked++; res.end('unsafe'); }
  else if (req.url === '/slow') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.write(Buffer.alloc(2048)); }
  else res.end(payload);
});
const profile = process.env.QINGMO_UPDATE_TEST_PROFILE;
assert(profile, 'Use test-update-electron.js wrapper');
app.setPath('userData', profile);
const timeout = setTimeout(() => { console.error('Transport regression timed out'); app.exit(1); }, 20000);
app.whenReady().then(async () => {
  let directory;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qingmo-network-'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const local = `http://127.0.0.1:${server.address().port}`;
    const transport = (url, options) => updateFetch(net, url, options);
    console.log('Checking manual redirect');
    const redirect = await transport(local + '/start', { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), local + '/redirect');
    assert.deepEqual(requests, ['/start'], 'manual must not follow before validation');
    const name = 'QingMo-99.0.0-mac-arm64.dmg';
    const official = 'https://github.com/engrecho/qingmo/releases/download/v99.0.0/' + name;
    const asset = { name, url: official, size: payload.length, digest: 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex') };
    // Map only socket destinations; downloader still validates production URLs at every hop.
    const fetch = async (url, options) => {
      const route = url === official ? '/start' : new URL(url).pathname;
      const result = await transport(local + route, options);
      if ([302,307].includes(result.status)) {
        const route = new URL(result.headers.get('location')).pathname;
        return new Response(null, { status: result.status, headers: { location: route === '/blocked' ? 'https://example.com/blocked' : 'https://release-assets.githubusercontent.com' + route } });
      }
      return result;
    };
    console.log('Checking multi-hop download');
    const file = await downloadAsset({ asset, version: '99.0.0', directory, fetch });
    assert.deepEqual(await fs.readFile(file), payload);
    await fs.rm(file);
    console.log('Checking untrusted redirect');
    await assert.rejects(downloadAsset({ asset, version: '99.0.0', directory, fetch: (url, options) => fetch(url === official ? 'https://release-assets.githubusercontent.com/bad' : url, options) }), /来源不受信任/);
    assert.equal(blocked, 0);
    console.log('Checking stream abort');
    const ctrl = new AbortController();
    const slow = await transport(local + '/slow', { signal: ctrl.signal });
    const reading = slow.text(); ctrl.abort(new Error('test abort'));
    await assert.rejects(reading, /test abort/);
    await fs.writeFile(path.join(profile, 'passed'), path.basename(__filename));
    console.log('PASS Electron net.request: 302/307, Location, verified download, blocked redirect, stream abort');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    clearTimeout(timeout); server.closeAllConnections(); server.close();
    if (directory) await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    app.exit(process.exitCode || 0);
  }
});
