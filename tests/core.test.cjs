const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DAY_MS, retentionDays, localExpiry, expiredLocalIds, receivedOffset, HEVC_MIME_TYPES, compatibleHevcMp4, matchesRecordingProfile, startHevcRecorder } = require('../core.js');
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

test('a failing HEVC constructor or start retries HEVC without using the browser default', () => {
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
  const rec = startHevcRecorder(Recorder, {}, {}, () => {});
  assert.equal(rec.mimeType, HEVC_MIME_TYPES[2]);
  assert.deepEqual(attempts, HEVC_MIME_TYPES.slice(0, 3));
});

test('a WebM-only browser reports failure instead of starting an unwanted recording', () => {
  class Recorder {
    static isTypeSupported(type) { return type.startsWith('video/webm'); }
    constructor() { assert.fail('must not use a default recorder'); }
  }
  assert.throws(() => startHevcRecorder(Recorder, {}, {}, () => {}), /HEVC.*recording could not start/);
});

test('an encoder reporting a different container or codec is rejected', () => {
  assert.equal(compatibleHevcMp4('video/mp4;codecs="hvc1.1.6.L93.B0,mp4a.40.2"'), true);
  assert.equal(compatibleHevcMp4('video/mp4;codecs=hev1.1.6.L93.B0,mp4a.40.2'), true);
  for (const type of ['video/webm', 'video/mp4', 'video/mp4;codecs=hvc1,opus', 'video/mp4;codecs=avc1,mp4a.40.2']) {
    class Recorder {
      static isTypeSupported() { return true; }
      constructor() { this.mimeType = type; }
      start() { assert.fail('must not start incompatible encoding'); }
    }
    assert.throws(() => startHevcRecorder(Recorder, {}, {}, () => {}), /HEVC/);
  }
});

test('a recorder that changes to an incompatible codec at startup is stopped', () => {
  let stopped = 0;
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.mimeType = 'video/mp4;codecs=hvc1,mp4a.40.2'; }
    start() { this.state = 'recording'; this.mimeType = 'video/mp4;codecs=avc1,mp4a.40.2'; }
    stop() { stopped++; assert.equal(this.onstop, null); }
  }
  assert.throws(() => startHevcRecorder(Recorder, {}, {}, () => {}), /HEVC/);
  assert.equal(stopped, HEVC_MIME_TYPES.length);
});

test('the camera profile accepts only 720p at 30 fps in landscape or portrait', () => {
  for (const [width,height] of [[1280,720],[720,1280]]) {
    assert.equal(matchesRecordingProfile({width,height,frameRate:30}), true);
    assert.equal(matchesRecordingProfile({width,height,frameRate:29.97}), true);
  }
  for (const settings of [{width:1920,height:1080,frameRate:30},{width:1280,height:720,frameRate:60},{width:640,height:480,frameRate:30},{}]) assert.equal(matchesRecordingProfile(settings), false);
});
