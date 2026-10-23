const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// Model an already-installed v4 shell and fresh HTTP-cache entries, then deploy
// the current files without closing the old tabs or clearing phone storage.
const legacyWorker = `
  const VERSION = 'camsync-v4';
  self.addEventListener('install', e => e.waitUntil(caches.open(VERSION).then(c => c.addAll(['./', './app.js', './core.js']))));
  self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', e => {
    if (new URL(e.request.url).origin !== self.location.origin) return;
    e.respondWith(caches.open(VERSION).then(async c => await c.match(e.request, {ignoreSearch:true}) || fetch(e.request)));
  });`;
const legacyHtml = `<!doctype html><title>Older CamSync</title><h1>Older CamSync</h1>
  <script src="core.js"></script><script src="app.js"></script>
  <script>navigator.serviceWorker.register('sw.js');</script>`;

test.describe('updating an installed app', () => {
  test.use({ serviceWorkers: 'allow' });
  let server, origin, deployed, workerError, currentScripts;
  test.beforeEach(async () => {
    deployed = false; workerError = false; currentScripts = [];
    server = http.createServer(async (req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/sw.js' && workerError) { res.writeHead(503).end(); return; }
      const legacy = !deployed && ({ '/': legacyHtml, '/index.html': legacyHtml, '/sw.js': legacyWorker, '/core.js': 'window.LEGACY_CORE = true;', '/app.js': 'window.LEGACY_APP = true;' })[pathname];
      let content;
      try { content = legacy || await fs.readFile(path.join(root, pathname === '/' ? 'index.html' : pathname.slice(1))); }
      catch { res.writeHead(404).end(); return; }
      if (deployed && ['app.js', 'core.js'].includes(pathname.slice(1))) currentScripts.push(pathname);
      res.writeHead(200, {
        'Content-Type': pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.png') ? 'image/png' : 'text/html',
        'Cache-Control': pathname === '/sw.js' ? 'no-cache' : 'max-age=86400',
      });
      res.end(content);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  test.afterEach(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

  async function installLegacy(page) {
    await page.goto(origin);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.evaluate(async () => {
      localStorage.setItem('cs.settings', JSON.stringify({ folderName: 'Phone clips', quality: '720', retentionDays: 14 }));
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open('camsync', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('videos', {keyPath:'id'}); r.result.createObjectStore('blobs'); };
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      });
      const tx = db.transaction(['videos','blobs'], 'readwrite');
      tx.objectStore('videos').put({id:'phone-clip',name:'Existing.webm',status:'pending',createdAt:1,hasBlob:true,size:3});
      tx.objectStore('blobs').put(new Uint8Array([11,22,33]).buffer, 'phone-clip');
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = reject; });
      db.close();
    });
  }

  test('replaces the cached WebM app with MP4 while preserving phone data and another open tab', async ({ page, context }) => {
    await installLegacy(page);
    const oldTab = await context.newPage();
    await oldTab.goto(origin);
    expect(await oldTab.evaluate(() => window.LEGACY_APP)).toBe(true);
    deployed = true;
    await page.goto(origin + '/update.html');
    await page.getByRole('button', {name:'Update now',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('CamSync 6 is ready');
    expect(currentScripts).toEqual(expect.arrayContaining(['/app.js','/core.js']));
    expect(await oldTab.evaluate(() => window.LEGACY_APP)).toBe(true);
    await page.getByRole('link', {name:'Open CamSync',exact:true}).click();
    await page.waitForFunction(() => typeof db !== 'undefined' && db);
    await page.getByRole('button', {name:'Google account',exact:true}).click();
    await expect(page.locator('#appVersion')).toHaveText('CamSync 6');
    await expect(page.locator('#formatInfo')).not.toContainText('Records as');
    await expect(page.getByLabel('Drive folder')).toHaveValue('Phone clips');
    await expect(page.getByLabel('Delete phone copies after upload')).toHaveValue('14');
    const clip = await page.evaluate(async () => ({ data: Array.from(new Uint8Array(await (await getBlob('phone-clip')).arrayBuffer())), video: (await listVideos())[0] }));
    expect(clip.data).toEqual([11,22,33]);
    expect(clip.video.name).toBe('Existing.webm');
    expect(clip.video.status).toBe('pending');
    expect(await page.evaluate(() => typeof CamSyncCore.startMp4Recorder)).toBe('function');
    await context.setOffline(true);
    await page.reload();
    await page.getByRole('button', {name:'Google account',exact:true}).click();
    await expect(page.locator('#appVersion')).toHaveText('CamSync 6');
    await expect(page.getByLabel('Delete phone copies after upload')).toHaveValue('14');
  });

  test('a failed update can be retried without clearing the existing app or settings', async ({ page }) => {
    await installLegacy(page);
    deployed = true; workerError = true;
    await page.goto(origin + '/update.html');
    await page.getByRole('button', {name:'Update now',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('Couldn’t download the update');
    await expect(page.getByRole('button', {name:'Try again',exact:true})).toBeEnabled();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cs.settings')).retentionDays)).toBe(14);
    expect(await page.evaluate(() => caches.has('camsync-v4'))).toBe(true);
    workerError = false;
    await page.getByRole('button', {name:'Try again',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('CamSync 6 is ready');
  });
});
