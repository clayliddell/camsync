'use strict';

// Shared by the browser app and dependency-free tests.
(function (root) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const RETENTION_DAYS = Object.freeze([7, 14, 30]);
  const retentionDays = (value) => RETENTION_DAYS.includes(Number(value)) ? Number(value) : 7;

  function localExpiry(video, days) {
    // Never expire a queued, failed, unconfirmed, or already-removed recording.
    if (video.status !== 'uploaded' || !video.hasBlob || !video.driveId ||
        !Number.isFinite(video.uploadedAt) || video.uploadedAt <= 0) return null;
    return video.uploadedAt + retentionDays(days) * DAY_MS;
  }

  function expiredLocalIds(videos, days, now = Date.now()) {
    return videos.filter((video) => {
      const expiry = localExpiry(video, days);
      return expiry !== null && expiry <= now;
    }).map((video) => video.id);
  }

  // Drive's Range is authoritative. No Range means no bytes were received.
  function receivedOffset(range, total) {
    if (!range) return 0;
    const match = /^bytes=0-(\d+)$/.exec(range);
    const next = match ? Number(match[1]) + 1 : NaN;
    if (!Number.isSafeInteger(next) || next < 1 || next > total) {
      throw new Error('Drive returned an invalid upload position');
    }
    return next;
  }

  const RECORDING_PROFILE = Object.freeze({ width: 1280, height: 720, frameRate: 30, videoBitsPerSecond: 4000000, audioBitsPerSecond: 128000 });
  // Main profile, level 3.1 supports 720p/30. Keep every attempt on HEVC/AAC.
  const HEVC_MIME_TYPES = Object.freeze([
    'video/mp4;codecs=hvc1.1.6.L93.B0,mp4a.40.2',
    'video/mp4;codecs=hev1.1.6.L93.B0,mp4a.40.2',
    'video/mp4;codecs=hvc1,mp4a.40.2',
    'video/mp4;codecs=hev1,mp4a.40.2',
  ]);
  function compatibleHevcMp4(type) {
    if (!/^video\/mp4(?:\s*;|$)/i.test(type || '')) return false;
    const codecs = /codecs\s*=\s*"?([^";]+)/i.exec(type)?.[1]?.split(',').map((codec) => codec.trim());
    return !!codecs && codecs.length === 2 && codecs.some((codec) => /^(hvc1|hev1)(\.[a-z0-9]+)*$/i.test(codec)) && codecs.some((codec) => /^mp4a\.40\.2$/i.test(codec));
  }
  function matchesRecordingProfile(settings) {
    const dimensions = [settings.width, settings.height].sort((a, b) => a - b);
    // Portrait camera output may report the same dimensions in reverse order.
    return dimensions[0] === RECORDING_PROFILE.height && dimensions[1] === RECORDING_PROFILE.width && Math.abs(settings.frameRate - RECORDING_PROFILE.frameRate) < 0.1;
  }
  function startHevcRecorder(Recorder, stream, options, configure) {
    const failure = 'H.265 (HEVC) recording could not start. Update your phone and browser, then try again.';
    if (!Recorder) throw new Error(failure);
    for (const mimeType of HEVC_MIME_TYPES) {
      let rec;
      try {
        if (!Recorder.isTypeSupported(mimeType)) continue;
        rec = new Recorder(stream, { ...options, mimeType });
        if (rec.mimeType && !compatibleHevcMp4(rec.mimeType)) continue;
        configure(rec, mimeType);
        // Some encoders advertise support but fail at construction or start.
        rec.start(1000);
        if (rec.mimeType && !compatibleHevcMp4(rec.mimeType)) throw new Error('Unexpected recording format');
        return rec;
      } catch {
        if (rec) {
          rec.ondataavailable = rec.onstop = rec.onerror = null;
          try { if (rec.state === 'recording') rec.stop(); } catch {}
        }
      }
    }
    // Generic MP4 can select H.264, so it is not a fallback for this profile.
    throw new Error(failure);
  }

  const core = Object.freeze({ DAY_MS, RETENTION_DAYS, retentionDays, localExpiry, expiredLocalIds, receivedOffset, RECORDING_PROFILE, HEVC_MIME_TYPES, compatibleHevcMp4, matchesRecordingProfile, startHevcRecorder });
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  else root.CamSyncCore = core;
})(globalThis);
