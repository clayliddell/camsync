const { test, expect } = require('@playwright/test');

test('native HEVC camera recording is saved and decoded when a hardware encoder is available', async ({ page }) => {
  await page.route('https://accounts.google.com/gsi/client', (route) => route.abort());
  await page.goto('/');
  test.skip(await page.evaluate(() => pickMime() === null), 'This test browser has no HEVC/AAC encoder; run on a supported device for real encoded-byte verification.');
  const record = page.getByRole('button', { name: 'Start recording', exact: true });
  await expect(record).toBeEnabled();
  await record.click();
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
  // Wait for actual encoded camera data rather than fabricating a saved clip.
  await page.waitForFunction(() => recorder && recorder.state === 'recording' && Date.now() - recStartedAt >= 1200);
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(record).toBeEnabled();
  const clip = await page.evaluate(async () => {
    const [video] = await listVideos();
    return { ...video, savedBytes: (await getBlob(video.id)).size };
  });
  expect(clip.status).toBe('pending');
  expect(clip.savedBytes).toBeGreaterThan(0);
  expect(clip.savedBytes).toBe(clip.size);
  expect(clip.hasBlob).toBe(true);
  expect(clip.mime).toBe('video/mp4');
  expect(clip.name).toMatch(/\.mp4$/);
  const media = await page.evaluate(async () => {
    const [clip] = await listVideos();
    const bytes = new Uint8Array(await (await getBlob(clip.id)).arrayBuffer());
    const text = new TextDecoder('latin1').decode(bytes);
    const video = document.createElement('video');
    const url = URL.createObjectURL(new Blob([bytes], { type: clip.mime }));
    video.src = url;
    try {
      await new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = () => reject(new Error('Recorded MP4 could not be decoded'));
        video.load();
      });
      return { signature: text.slice(4, 8), hevc: text.includes('hvc1') || text.includes('hev1'), aac: text.includes('mp4a'), width: video.videoWidth, height: video.videoHeight };
    } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
  });
  expect(media.signature).toBe('ftyp');
  expect(media.hevc).toBe(true);
  expect(media.aac).toBe(true);
  expect([media.width,media.height].sort((a,b)=>a-b)).toEqual([720,1280]);
  expect(clip.captureSettings.frameRate).toBeCloseTo(30, 0);
});

test('an H.264-only browser leaves the recorder button usable and explains the HEVC requirement', async ({ page }) => {
  await page.route('https://accounts.google.com/gsi/client', (route) => route.abort());
  await page.addInitScript(() => {
    window.MediaRecorder = class {
      static isTypeSupported(type) { return type.includes('avc1') || type === 'video/mp4'; }
    };
  });
  await page.goto('/');
  const record = page.getByRole('button', { name: 'Start recording', exact: true });
  await expect(record).toBeEnabled();
  await record.click();
  await expect(page.getByRole('status')).toContainText('HEVC) recording could not start');
  await expect(record).toBeEnabled();
  expect(await page.evaluate(() => isRecording())).toBe(false);
});

test('an old 1080p setting migrates to 720p/30 with explicit HEVC/AAC recorder options', async ({ page }) => {
  await page.route('https://accounts.google.com/gsi/client', (route) => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('cs.settings', JSON.stringify({quality:'1080',folderName:'Existing folder',retentionDays:14}));
    // Tests recorder configuration/storage only, not real HEVC encoding.
    window.MediaRecorder = class {
      static isTypeSupported(type) { return type.includes('hvc1') && type.includes('mp4a.40.2'); }
      constructor(stream, options) { this.mimeType=options.mimeType; this.state='inactive'; window.__recordingOptions=options; window.__captureSettings=stream.getVideoTracks()[0].getSettings(); }
      start() { this.state='recording'; }
      stop() { this.state='inactive'; this.ondataavailable({data:new Blob(['mock-HEVC-output'],{type:this.mimeType})}); this.onstop(); }
    };
  });
  await page.goto('/');
  const record = page.getByRole('button', {name:'Start recording',exact:true});
  await expect(record).toBeEnabled();
  await record.click();
  expect(await page.evaluate(() => window.__recordingOptions.mimeType)).toContain('hvc1');
  const capture = await page.evaluate(() => window.__captureSettings);
  expect([capture.width,capture.height].sort((a,b)=>a-b)).toEqual([720,1280]);
  expect(capture.frameRate).toBe(30);
  await page.getByRole('button',{name:'Stop recording',exact:true}).click();
  await expect(record).toBeEnabled();
  const saved = await page.evaluate(async () => ({video:(await listVideos())[0],settings:JSON.parse(localStorage.getItem('cs.settings'))}));
  expect(saved.settings.quality).toBe('720');
  expect(saved.settings.retentionDays).toBe(14);
  expect(saved.settings.folderName).toBe('Existing folder');
  expect(saved.video.name).toMatch(/\.mp4$/);
  expect(saved.video.recordingMime).toContain('hvc1');
  expect(saved.video.captureSettings).toEqual({width:1280,height:720,frameRate:30});
  await page.getByRole('button',{name:'Google account',exact:true}).click();
  await expect(page.locator('#recordingProfile')).toHaveText('MP4 · 720p · 30 fps · H.265 (HEVC)');
  await expect(page.locator('#appVersion')).toHaveText('CamSync 8');
});

test('a camera returning the wrong resolution is rejected before recording', async ({ page }) => {
  await page.route('https://accounts.google.com/gsi/client', (route) => route.abort());
  await page.addInitScript(() => {
    const track = {getSettings:()=>({width:1920,height:1080,frameRate:60}),stop:()=>{window.__cameraStopped=true;}};
    navigator.mediaDevices.getUserMedia=async constraints=>{window.__cameraConstraints=constraints;return{getTracks:()=>[track],getVideoTracks:()=>[track]};};
  });
  await page.goto('/');
  await expect(page.locator('#overlayMsg')).toContainText('did not provide 720p at 30 fps');
  await expect(page.getByRole('button',{name:'Start recording',exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>window.__cameraStopped)).toBe(true);
  const requested=await page.evaluate(()=>window.__cameraConstraints.video);
  expect(requested.width).toEqual({exact:1280});
  expect(requested.height).toEqual({exact:720});
  expect(requested.frameRate).toEqual({exact:30});
});
