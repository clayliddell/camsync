const { test, expect } = require('@playwright/test');
const DAY = 86400000;
const clientId = '123-test.apps.googleusercontent.com';
const scope = 'https://www.googleapis.com/auth/drive.file';

async function setup(page, options = {}) {
  const state = { requests: [], chunks: [], account: 'account-a', failed: false, sessions: 0, ...options };
  if (options.emulateResume) {
    // Playwright's Windows WebKit port rejects route.fulfill({status: 308}).
    // Use a real Fetch Response for this one mocked server response instead.
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      window.__resumeQueries = [];
      window.fetch = (url, options = {}) => {
        if (String(url).includes('/upload-session/') && options.headers?.['Content-Range']?.startsWith('bytes */')) {
          window.__resumeQueries.push(options.headers['Content-Range']);
          return Promise.resolve(new Response('', { status: 308 }));
        }
        return nativeFetch(url, options);
      };
    });
  }
  await page.route('**/auth/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (data, status=200) => route.fulfill({status, contentType:'application/json', headers:{'Cache-Control':'no-store'}, body:JSON.stringify(data)});
    const profile = {id:state.account,email:state.account+'@example.com',name:'Test User'};
    if (path === '/auth/login') {
      state.connected = !state.denied;
      return route.fulfill({contentType:'text/html',body:'<script>location.replace("/")</script>'});
    }
    if (path === '/auth/logout') { state.connected=false; return route.fulfill({status:204}); }
    if (!state.connected) return json({connected:false},401);
    if (path === '/auth/session') return json({connected:true,csrf:'test-csrf',profile});
    if (path === '/auth/token') {
      state.tokenRequests = (state.tokenRequests || 0) + 1;
      if (state.refreshDenied) return json({connected:false},401);
      return json({access_token:'test-memory-only-token-'+state.tokenRequests,expires_at:Date.now()/1000+3600,profile});
    }
    return json({},404);
  });
  await page.route('https://www.googleapis.com/**', async (route) => {
    const req = route.request(), url = new URL(req.url());
    state.requests.push({ url: req.url(), method: req.method(), body: req.postData() });
    const json = (data, status = 200, headers = {}) => route.fulfill({ status, headers: { 'Access-Control-Expose-Headers': 'Location, Range', ...headers }, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname.endsWith('/about')) return json({ user: { permissionId: state.account, emailAddress: state.account + '@example.com', displayName: 'Test User' } });
    if (url.pathname === '/drive/v3/files' && req.method() === 'GET') return json({ files: state.folderMissing ? [] : [{ id: 'folder-' + state.account }] });
    if (url.pathname === '/drive/v3/files' && req.method() === 'POST') return json({ id: 'folder-' + state.account });
    if (url.pathname.startsWith('/drive/v3/files/folder-')) return json({ id: 'folder-' + state.account, trashed: false });
    if (url.pathname === '/upload/drive/v3/files') {
      if (state.unauthorized) return json({ error: { message: 'Invalid Credentials' } }, 401);
      if (state.rejectTokenOnce && !state.tokenRejected) { state.tokenRejected=true; return json({error:{message:'Expired token'}},401); }
      state.sessions++;
      state.size = Number(req.headers()['x-upload-content-length']);
      return json({}, 200, { Location: 'https://www.googleapis.com/upload-session/' + state.account + '/' + state.sessions });
    }
    if (url.pathname.startsWith('/upload-session/')) {
      const range = req.headers()['content-range'];
      state.chunks.push({ url: req.url(), range });
      if (state.delayUpload) await new Promise((resolve) => setTimeout(resolve, state.delayUpload));
      if (state.failOnce && !state.failed) { state.failed = true; return route.abort('failed'); }
      if (range.startsWith('bytes */')) {
        if (state.completed) return json({ id: 'file-' + state.account });
        return route.fulfill({ status: 308, headers: { 'Access-Control-Expose-Headers': 'Range', ...(state.resumeRange ? { Range: state.resumeRange } : {}) }, body: '' });
      }
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
      state.size = Number(match[3]);
      if (Number(match[2]) + 1 < state.size) return route.fulfill({ status: 308, headers: { 'Access-Control-Expose-Headers': 'Range', Range: 'bytes=0-' + match[2] }, body: '' });
      state.completed = true;
      return json(state.noConfirmation ? {} : { id: 'file-' + state.account });
    }
    if (url.pathname.startsWith('/drive/v3/files/file-')) return json({ id: 'file-' + state.account, size: String(state.wrongSize ? 0 : state.size), trashed: false });
    return json({ error: { message: 'Unexpected mock request' } }, 404);
  });
  await page.addInitScript(({ clientId }) => {
    if (!localStorage.getItem('cs.settings')) localStorage.setItem('cs.settings', JSON.stringify({ clientId, folderName: 'CamSync', quality: '720', retentionDays: 7 }));
  }, { clientId });
  await page.goto('/');
  await page.waitForFunction(() => typeof db !== 'undefined' && db !== null);
  await page.getByRole('button', { name: 'Google account', exact: true }).click();
  return state;
}

async function connect(page) {
  await page.getByRole('button', { name: 'Sign in with Google', exact: true }).click();
  await page.waitForFunction(() => typeof db !== 'undefined' && db && getToken());
  await page.getByRole('button', {name:'Google account',exact:true}).click();
  await expect(page.locator('#accountDetails')).toContainText('Connected');
}
async function record(page) {
  await page.evaluate(async () => {
    await saveRecording([new Blob(['recorded-video-bytes'])], 'video/mp4', Date.now() - 1500, Date.now());
  });
}
async function clips(page) {
  return page.evaluate(async () => Promise.all((await listVideos()).map(async (v) => ({ ...v, blobExists: !!(await getBlob(v.id)) }))));
}

test('Google sign-in automatically uploads a recording, verifies it, and keeps the phone copy', async ({ page }) => {
  const state = await setup(page);
  await connect(page);
  await record(page);
  await expect.poll(async () => (await clips(page))[0]?.status).toBe('uploaded');
  const [clip] = await clips(page);
  expect(clip.blobExists).toBe(true);
  expect(clip.hasBlob).toBe(true);
  expect(clip.uploadedAt).toBeGreaterThan(clip.createdAt);
  expect(clip.driveAccountId).toBe('account-a');
  const start = state.requests.find((r) => r.url.includes('uploadType=resumable'));
  expect(JSON.parse(start.body).parents).toEqual(['folder-account-a']);
  expect(state.requests.some((r) => r.url.includes('fields=id,size,webViewLink,trashed'))).toBe(true);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('test-memory-only-token');
  await expect(page.locator('#list')).toContainText('Phone copy kept until');
});

for (const days of [7, 14, 30]) {
  test(`saving ${days}-day retention deletes only expired uploaded phone bytes`, async ({ page }) => {
    const state = await setup(page);
    await page.evaluate(async ({ days, DAY }) => {
      for (const [id, age, status] of [['expired', days, 'uploaded'], ['recent', days - 1, 'uploaded'], ['queued', 90, 'pending'], ['failed', 90, 'failed'], ['unverified', 90, 'uploaded']]) {
        await addVideo({ id, name: id + '.mp4', status, createdAt: 1, uploadedAt: Date.now() - age * DAY, hasBlob: true, driveId: id === 'unverified' ? null : 'drive-' + id }, new Blob(['phone-copy']));
      }
      await refresh();
    }, { days, DAY });
    await page.getByLabel('Delete phone copies after upload').selectOption(String(days));
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await clips(page)).find((v) => v.id === 'expired')?.hasBlob).toBe(false);
    const rows = await clips(page);
    expect(rows.find((v) => v.id === 'expired').blobExists).toBe(false);
    for (const id of ['recent', 'queued', 'failed', 'unverified']) expect(rows.find((v) => v.id === id).blobExists).toBe(true);
    expect(state.requests).toHaveLength(0);
    await page.reload();
    await page.getByRole('button', { name: 'Google account', exact: true }).click();
    await expect(page.getByLabel('Delete phone copies after upload')).toHaveValue(String(days));
  });
}

test('offline startup cleans up expired backups but preserves queued recordings', async ({ page, context }) => {
  const state = await setup(page);
  await page.evaluate(async (DAY) => {
    await addVideo({ id: 'old', name: 'old.mp4', status: 'uploaded', createdAt: 1, uploadedAt: Date.now() - 8 * DAY, driveId: 'safe-drive-copy', hasBlob: true }, new Blob(['old']));
    await addVideo({ id: 'waiting', name: 'waiting.mp4', status: 'pending', createdAt: 1, hasBlob: true }, new Blob(['waiting']));
  }, DAY);
  await context.setOffline(true);
  await page.evaluate(() => maintenance());
  expect((await clips(page)).find((v) => v.id === 'old').blobExists).toBe(false);
  expect((await clips(page)).find((v) => v.id === 'waiting').blobExists).toBe(true);
  expect(state.requests).toHaveLength(0);
});

test('interrupted upload retries from Drive’s confirmed byte position', async ({ page, browserName }) => {
  const state = await setup(page, { failOnce: true, emulateResume: browserName === 'webkit' });
  await connect(page);
  await record(page);
  await expect.poll(async () => (await clips(page))[0]?.status).toBe('failed');
  expect((await clips(page))[0].blobExists).toBe(true);
  await page.evaluate(() => processQueue());
  await expect.poll(async () => (await clips(page))[0]?.status).toBe('uploaded');
  expect(state.sessions).toBe(1);
  if (browserName === 'webkit') {
    expect(await page.evaluate(() => window.__resumeQueries)).toEqual(['bytes */20']);
    expect(state.chunks.map((x) => x.range)).toEqual(['bytes 0-19/20', 'bytes 0-19/20']);
  } else expect(state.chunks.map((x) => x.range)).toEqual(['bytes 0-19/20', 'bytes */20', 'bytes 0-19/20']);
});

test('changing accounts never reuses another account’s upload session or folder', async ({ page }) => {
  const state = await setup(page, { failOnce: true });
  await connect(page);
  await record(page);
  await expect.poll(async () => (await clips(page))[0]?.status).toBe('failed');
  await page.getByRole('button', { name: 'Disconnect Google', exact: true }).click();
  state.account = 'account-b';
  await connect(page);
  await expect.poll(async () => (await clips(page))[0]?.status).toBe('uploaded');
  expect(state.sessions).toBe(2);
  expect(state.chunks.filter((x) => x.url.includes('account-a'))).toHaveLength(1);
  const uploads = state.requests.filter((r) => r.url.includes('uploadType=resumable'));
  expect(JSON.parse(uploads[1].body).parents).toEqual(['folder-account-b']);
  expect((await clips(page))[0].driveAccountId).toBe('account-b');
});

test('denied Drive permission preserves the recording without making Drive requests', async ({ page }) => {
  const state = await setup(page, {denied:true});
  await record(page);
  const returned = page.waitForEvent('framenavigated', {predicate:frame=>frame===page.mainFrame() && new URL(frame.url()).pathname==='/'});
  await page.getByRole('button', {name:'Sign in with Google',exact:true}).click();
  await returned;
  await page.waitForURL('/');
  await page.waitForFunction(() => typeof db !== 'undefined' && db);
  expect(await page.evaluate(() => getToken())).toBeNull();
  expect((await clips(page))[0].blobExists).toBe(true);
  expect(state.requests).toHaveLength(0);
});

test('unconfirmed or wrong-size Drive uploads never start retention', async ({ page }) => {
  await setup(page, { wrongSize: true });
  await connect(page);
  await record(page);
  await expect.poll(async () => (await clips(page))[0]?.status).toBe('failed');
  const [clip] = await clips(page);
  expect(clip.blobExists).toBe(true);
  expect(clip.uploadedAt).toBeUndefined();
  await page.evaluate((DAY) => cleanupLocalCopies(Date.now() + 90 * DAY), DAY);
  expect((await clips(page))[0].blobExists).toBe(true);
});

test('reopening restores the Google connection without persisting bearer credentials', async ({ page }) => {
  const state = await setup(page);
  await connect(page);
  await page.reload();
  await page.waitForFunction(() => getToken());
  await page.getByRole('button', {name:'Google account',exact:true}).click();
  await expect(page.locator('#accountDetails')).toContainText('Connected');
  const storage = await page.evaluate(() => JSON.stringify({...localStorage}));
  expect(storage).not.toContain('test-memory-only-token');
  expect(storage).not.toContain('test-csrf');
  await record(page);
  await expect.poll(async () => (await clips(page))[0]?.status).toBe('uploaded');
  expect(state.tokenRequests).toBeGreaterThanOrEqual(2);
});

test('expired access automatically refreshes before uploading', async ({ page }) => {
  const state = await setup(page);
  await connect(page);
  const initial = state.tokenRequests;
  await page.evaluate(() => {auth.exp=Date.now()-1;});
  await record(page);
  await expect.poll(async () => (await clips(page))[0]?.status).toBe('uploaded');
  expect(state.tokenRequests).toBe(initial+1);
});

test('disconnect survives reopening and cannot silently reconnect', async ({ page }) => {
  await setup(page);
  await connect(page);
  await page.getByRole('button', {name:'Disconnect Google',exact:true}).click();
  await expect(page.locator('#accountDetails')).not.toContainText('Connected');
  await page.reload();
  await page.waitForFunction(() => typeof db !== 'undefined' && db);
  expect(await page.evaluate(() => getToken())).toBeNull();
  await record(page);
  expect((await clips(page))[0].status).toBe('pending');
});

test('Drive token rejection refreshes once and continues uploading without sign-in', async ({page}) => {
  const state=await setup(page,{rejectTokenOnce:true});
  await connect(page);
  const initial=state.tokenRequests;
  await record(page);
  await expect.poll(async () => (await clips(page))[0]?.status).toBe('uploaded');
  expect(state.tokenRequests).toBe(initial+1);
  expect(state.tokenRejected).toBe(true);
});

test('offline disconnect is completed on reconnect before queued uploads resume', async ({page,context}) => {
  const state=await setup(page);
  await connect(page);
  await context.setOffline(true);
  // Model the unavailable authentication service independently of Playwright's routes.
  await page.route('**/auth/logout',route=>route.abort('internetdisconnected'));
  await page.getByRole('button',{name:'Disconnect Google',exact:true}).click();
  await expect.poll(() => page.evaluate(()=>ls.get('cs.disconnectPending'))).toBe('1');
  await record(page);
  await page.unroute('**/auth/logout');
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(()=>ls.get('cs.disconnectPending'))).toBeNull();
  expect(state.connected).toBe(false);
  expect((await clips(page))[0].status).toBe('pending');
  expect((await clips(page))[0].blobExists).toBe(true);
});

test('mobile settings fit without horizontal overflow', async ({ page }) => {
  await setup(page);
  await expect(page.getByLabel('Delete phone copies after upload')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#sheet')).toBeHidden();
});

test('a missing Drive folder is created before uploading', async ({ page }) => {
  const state = await setup(page, { folderMissing: true });
  await connect(page);
  await record(page);
  await expect.poll(async () => (await clips(page))[0]?.status).toBe('uploaded');
  const made = state.requests.find((r) => r.method === 'POST' && new URL(r.url).pathname === '/drive/v3/files');
  expect(JSON.parse(made.body)).toEqual({ name: 'CamSync', mimeType: 'application/vnd.google-apps.folder' });
});

test('an expired Google session keeps recordings until the user reconnects', async ({ page }) => {
  const state = await setup(page);
  await connect(page);
  state.refreshDenied = true;
  await page.evaluate(() => { auth.exp = Date.now() - 1; });
  await record(page);
  expect((await clips(page))[0].status).toBe('pending');
  expect((await clips(page))[0].blobExists).toBe(true);
  await expect(page.getByRole('button', { name: 'Sign in with Google', exact: true })).toBeVisible();
  state.refreshDenied = false;
  await connect(page);
  await expect.poll(async () => (await clips(page))[0]?.status).toBe('uploaded');
});

test('Drive rejecting a token pauses uploads and preserves the phone copy', async ({ page }) => {
  const state = await setup(page);
  await connect(page);
  state.unauthorized = true;
  await record(page);
  await expect(page.locator('#bannerText')).toContainText('reconnect Google Drive');
  expect((await clips(page))[0].blobExists).toBe(true);
  expect((await clips(page))[0].uploadedAt).toBeUndefined();
  state.unauthorized = false;
  await connect(page);
  await expect.poll(async () => (await clips(page))[0]?.status).toBe('uploaded');
});

test('missing completion confirmation cannot expire a recording', async ({ page }) => {
  await setup(page, { noConfirmation: true });
  await connect(page);
  await record(page);
  await expect.poll(async () => (await clips(page))[0]?.status).toBe('failed');
  expect((await clips(page))[0].error).toContain('did not confirm');
  expect((await clips(page))[0].uploadedAt).toBeUndefined();
  expect((await clips(page))[0].blobExists).toBe(true);
});

test.describe('offline shell', () => {
  test.use({ serviceWorkers: 'allow' });
  test('reopens offline and runs local retention without Google', async ({ page, context }) => {
    await page.route('https://accounts.google.com/gsi/client', (route) => route.abort());
    await page.goto('/');
    await page.waitForFunction(() => typeof db !== 'undefined' && db);
    await page.evaluate(async (DAY) => {
      await navigator.serviceWorker.ready;
      await addVideo({ id: 'expired-offline', name: 'old.mp4', status: 'uploaded', createdAt: 1, uploadedAt: Date.now() - 8 * DAY, driveId: 'backed-up', hasBlob: true }, new Blob(['video']));
      await addVideo({ id: 'queued-offline', name: 'waiting.mp4', status: 'pending', createdAt: 1, hasBlob: true }, new Blob(['waiting']));
    }, DAY);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await context.setOffline(true);
    await page.reload();
    await expect.poll(async () => (await clips(page)).find((v) => v.id === 'expired-offline')?.blobExists).toBe(false);
    expect((await clips(page)).find((v) => v.id === 'queued-offline').blobExists).toBe(true);
    await page.getByRole('button', { name: 'Google account', exact: true }).click();
    await expect(page.getByLabel('Delete phone copies after upload')).toHaveValue('7');
  });
});
