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

  // Let the encoder select an H.264 profile before trying explicit profiles.
  // Generic MP4 supports older Safari versions that don't recognize codecs.
  const MP4_MIME_TYPES = Object.freeze([
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=avc1.424028,mp4a.40.2',
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4',
  ]);
  function compatibleMp4(type) {
    if (!/^video\/mp4(?:\s*;|$)/i.test(type || '')) return false;
    const codecs = /codecs\s*=\s*"?([^";]+)/i.exec(type)?.[1];
    return !codecs || codecs.split(',').every((codec) => /^(avc[13](\.[\da-f]+)?|mp4a\.40\.2)$/i.test(codec.trim()));
  }
  function startMp4Recorder(Recorder, stream, options, configure) {
    if (!Recorder) throw new Error('This browser cannot record MP4 video. On iPhone, use an updated Safari.');
    for (const mimeType of MP4_MIME_TYPES) {
      let rec;
      try {
        if (!Recorder.isTypeSupported(mimeType)) continue;
        rec = new Recorder(stream, { ...options, mimeType });
        if (rec.mimeType && !compatibleMp4(rec.mimeType)) continue;
        configure(rec, mimeType);
        // Some encoders advertise support but fail at construction or start.
        rec.start(1000);
        if (rec.mimeType && !compatibleMp4(rec.mimeType)) throw new Error('Unexpected recording format');
        return rec;
      } catch {
        if (rec) {
          rec.ondataavailable = rec.onstop = rec.onerror = null;
          try { if (rec.state === 'recording') rec.stop(); } catch {}
        }
      }
    }
    // Never silently switch to the browser default (which can be WebM/Opus).
    throw new Error('MP4 recording could not start. On iPhone, try an updated Safari. No video was recorded.');
  }

  const core = Object.freeze({ DAY_MS, RETENTION_DAYS, retentionDays, localExpiry, expiredLocalIds, receivedOffset, MP4_MIME_TYPES, compatibleMp4, startMp4Recorder });
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  else root.CamSyncCore = core;
})(globalThis);
