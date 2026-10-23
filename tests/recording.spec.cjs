const { test, expect } = require('@playwright/test');

test('camera recording is saved on the device before Google is configured', async ({ page }) => {
  await page.route('https://accounts.google.com/gsi/client', (route) => route.abort());
  await page.goto('/');
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
      return { signature: text.slice(4, 8), h264: text.includes('avc1'), aac: text.includes('mp4a'), width: video.videoWidth, height: video.videoHeight };
    } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
  });
  expect(media.signature).toBe('ftyp');
  expect(media.h264).toBe(true);
  expect(media.aac).toBe(true);
  expect(media.width).toBeGreaterThan(0);
  expect(media.height).toBeGreaterThan(0);
});

test('MP4 failure leaves the recorder button usable and explains the problem', async ({ page }) => {
  await page.route('https://accounts.google.com/gsi/client', (route) => route.abort());
  await page.addInitScript(() => {
    window.MediaRecorder = class {
      static isTypeSupported(type) { return type.startsWith('video/webm'); }
    };
  });
  await page.goto('/');
  const record = page.getByRole('button', { name: 'Start recording', exact: true });
  await expect(record).toBeEnabled();
  await record.click();
  await expect(page.getByRole('status')).toContainText('MP4 recording could not start');
  await expect(record).toBeEnabled();
  expect(await page.evaluate(() => isRecording())).toBe(false);
});
