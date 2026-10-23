const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DAY_MS, retentionDays, localExpiry, expiredLocalIds, receivedOffset, MP4_MIME_TYPES, compatibleMp4, startMp4Recorder } = require('../core.js');
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

test('a failing MP4 constructor or start retries MP4 without using the browser default', () => {
  const attempts = [];
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(stream, options) {
      attempts.push(options.mimeType);
      if (attempts.length === 1) throw new Error('encoder unavailable');
      this.mimeType = options.mimeType;
    }
    start() { if (attempts.length === 2) throw new Error('profile unavailable'); }
  }
  const rec = startMp4Recorder(Recorder, {}, {}, () => {});
  assert.equal(rec.mimeType, MP4_MIME_TYPES[2]);
  assert.deepEqual(attempts, MP4_MIME_TYPES.slice(0, 3));
});

test('a WebM-only browser reports failure instead of starting an unwanted recording', () => {
  class Recorder {
    static isTypeSupported(type) { return type.startsWith('video/webm'); }
    constructor() { assert.fail('must not use a default recorder'); }
  }
  assert.throws(() => startMp4Recorder(Recorder, {}, {}, () => {}), /MP4 recording could not start/);
});

test('an encoder reporting a different container or codec is rejected', () => {
  assert.equal(compatibleMp4('video/mp4;codecs="avc1.424028,mp4a.40.2"'), true);
  assert.equal(compatibleMp4('video/mp4'), true);
  for (const type of ['video/webm', 'video/mp4;codecs=avc1,opus', 'video/mp4;codecs=hvc1,mp4a.40.2']) {
    class Recorder {
      static isTypeSupported() { return true; }
      constructor() { this.mimeType = type; }
      start() { assert.fail('must not start incompatible encoding'); }
    }
    assert.throws(() => startMp4Recorder(Recorder, {}, {}, () => {}), /MP4/);
  }
});

test('a recorder that changes to an incompatible codec at startup is stopped', () => {
  let stopped = 0;
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.mimeType = 'video/mp4'; }
    start() { this.state = 'recording'; this.mimeType = 'video/mp4;codecs=avc1,opus'; }
    stop() { stopped++; assert.equal(this.onstop, null); }
  }
  assert.throws(() => startMp4Recorder(Recorder, {}, {}, () => {}), /MP4/);
  assert.equal(stopped, MP4_MIME_TYPES.length);
});
