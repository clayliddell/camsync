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
});
