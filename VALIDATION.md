# CamSync v2 validation

Verified on October 23, 2026.

- `npm test`: **7 passed**. Covers 7/14/30-day boundaries, uploaded-only deletion, setting changes, invalid settings, and resumable offsets.
- `npm run test:browser -- --workers=4`: **33 passed**, comprising 17 Chromium checks and 16 WebKit checks.
- Browser coverage includes Google authorization, permission denial, account switching, folder creation, resumable retry, token expiry/401 recovery, missing upload confirmation, wrong remote file size, persisted settings, local-only cleanup, offline service-worker reopening, and phone-width layout.
- The Chromium recording check uses the browser's simulated camera and real MediaRecorder output, then verifies the encoded bytes were saved to IndexedDB before Google was configured.
- Phone settings were visually inspected at 390 × 844.
- JavaScript syntax checks passed for the app, retention module, and service worker.

Google authorization and Drive responses were mocked. No real Google account was connected and no real Drive upload was performed. WebKit is the desktop test engine, not a physical iPhone. Its Windows test adapter requires a Fetch Response shim for a mocked HTTP 308; the application itself uses normal Drive requests.

Deployment setup is complete: GitHub Pages hosts `https://vid.skrrt.party`, HTTPS is enforced, Google Drive API is enabled, and an OAuth web client is configured for that exact origin. The OAuth app is in production with only the non-sensitive `drive.file` scope. The deployment workflow's tests pass. The offline-shell checks also passed again in Chromium and WebKit after adding the privacy notice.

The live Google client ID and current service-worker version were verified over HTTPS with normal certificate validation. Public DNS resolves correctly; the local router still caches the earlier NXDOMAIN response. No real user consent or Drive upload was performed. Verify consent, recording, upload/reconnect, and cleanup on the target phones.

Cleanup intentionally removes only phone video bytes after the selected number of days from a verified upload. Drive backups are kept. This PWA performs uploads and cleanup while running; overdue cleanup occurs on reopening.

## MP4 recording update

- The reported sample was downloaded from the CamSync Drive folder for metadata inspection. Its binary headers identify WebM, VP8 video, and Opus audio. No video contents were published.
- The prior constructor error path discarded the selected MP4 format and used the unconstrained browser default. Recording now retries MP4 configurations, rejects known incompatible output types/codecs, and reports failure instead of silently using WebM.
- `npm test`: **11 passed**, including constructor/start failures, incompatible codecs, and a WebM-only browser.
- `npm run test:browser -- --workers=4`: **34 passed** (18 Chromium, 16 WebKit). The actual simulated-camera recording test checks the MP4 `ftyp` signature, H.264 `avc1` and AAC `mp4a` tracks, saved bytes, and successful video decoding. Another check verifies a failed MP4 startup leaves the record button usable.
- Service-worker cache advanced to `camsync-v5`. Close existing CamSync windows and reopen to activate the new shell after it downloads.
- Real iPhone recording with the new encoder selection and the resulting Google Drive preview latency still require confirmation. MP4 compatibility does not guarantee that Google's preview processing is instant.

## Cached-app update recovery

The phone reported the old “Records as…” settings text, confirming an older loaded app. Version 6 adds a standalone update page and a visible loaded-app version. Shell installation revalidates HTTP-cached assets, worker update checks bypass the HTTP cache, and the update button explicitly activates a waiting worker. No local recording/settings stores are cleared.

- `npm test`: **11 passed**.
- `npm run test:browser -- --workers=4`: **38 passed** (20 Chromium, 18 WebKit).
- Four new checks install a simulated old cache and fresh HTTP-cache entries, leave another old tab open, then replace the shell using the update page. They verify current scripts were downloaded, old recording bytes and 14-day settings were preserved, the app reopens offline as version 6, and a failed download can be retried without clearing the previous cache/settings.
- Encoder behavior is unchanged from the MP4 update. Fresh recording on the user's physical iPhone still needs confirmation after the cached app is replaced.
