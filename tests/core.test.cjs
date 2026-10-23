const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DAY_MS, retentionDays, localExpiry, expiredLocalIds, receivedOffset } = require('../core.js');
const now = Date.UTC(2026, 9, 23, 12);
const video = { id: 'clip', status: 'uploaded', hasBlob: true, driveId: 'drive-file', uploadedAt: now - 7 * DAY_MS };

for (const days of [7, 14, 30]) {
  test(`${days} day boundary uses successful upload time, not recording time`, () => {
    const clip = { ...video, createdAt: 1, uploadedAt: now - days * DAY_MS };
    assert.deepEqual(expiredLocalIds([clip], days, now - 1), []);
    assert.deepEqual(expiredLocalIds([clip], days, now), ['clip']);
  });
}
test('unuploaded and unverified recordings never expire', () => {
  const clips = ['pending', 'failed', 'uploading', 'missing'].map((status) => ({ ...video, status }));
  clips.push({ ...video, driveId: null }, { ...video, uploadedAt: null }, { ...video, uploadedAt: NaN }, { ...video, hasBlob: false });
  assert.deepEqual(expiredLocalIds(clips, 7, now + 90 * DAY_MS), []);
});
test('shortening and lengthening retention applies to existing phone copies', () => {
  assert.equal(localExpiry(video, 14), now + 7 * DAY_MS);
  assert.deepEqual(expiredLocalIds([video], 30, now), []);
  assert.deepEqual(expiredLocalIds([video], 7, now), ['clip']);
});
test('retention accepts only 7, 14, 30 and safely migrates old settings', () => {
  for (const value of [undefined, null, '', 0, 1, 90, 'invalid']) assert.equal(retentionDays(value), 7);
  assert.equal(retentionDays('14'), 14);
});
test('resuming without a Range starts at byte zero', () => {
  assert.equal(receivedOffset(null, 100), 0);
  assert.equal(receivedOffset('bytes=0-41', 100), 42);
  assert.throws(() => receivedOffset('bytes=0-100', 100));
  assert.throws(() => receivedOffset('garbage', 100));
});
