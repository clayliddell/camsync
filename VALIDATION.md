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
