'use strict';

// Shared by the browser app and the dependency-free retention tests.
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

  const core = Object.freeze({ DAY_MS, RETENTION_DAYS, retentionDays, localExpiry, expiredLocalIds, receivedOffset });
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  else root.CamSyncCore = core;
})(globalThis);
