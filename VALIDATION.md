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

## Version 7: 720p/30 H.265 recording

- Recording requests MP4, H.265/HEVC Main profile at level 3.1 (or the browser's supported HEVC configuration), and AAC-LC audio. Every encoder candidate explicitly requests HEVC/AAC; generic MP4 and H.264 are no longer candidates.
- Camera constraints require 1280 × 720 at 30 fps. Returned track settings are checked, accepting rotated 720 × 1280 output and nominal 29.97 fps. A different resolution or frame rate shows a camera error. Existing saved 1080p preferences migrate to the fixed 720p profile, while folder and retention choices are preserved.
- `npm test`: **12 passed**. Includes HEVC retries, incompatible/default codec rejection, and camera-profile validation.
- `npm run test:browser -- --workers=4`: **39 passed, 1 skipped** (21 passed/1 skipped in Chromium; 18 passed in WebKit). New checks verify migration from 1080p, actual simulated-camera track settings at 720p/30, explicit HEVC/AAC recorder options, saved capture metadata, rejection of an H.264-only recorder, and rejection of a wrong camera profile. Google upload, retention, and update-recovery checks still pass.
- The successful HEVC recorder lifecycle in the configuration check is mocked. The native encoded-byte/playback check skips in bundled Chromium because that build exposes no HEVC/AAC encoder. Windows WebKit does not expose MediaRecorder.
- **Additional native Brave check: 1 passed.** The same native recording test was run in the installed Brave browser using a separate temporary Playwright configuration and simulated camera. It produced real encoded video, saved an MP4 to IndexedDB, verified HEVC (`hvc1`/`hev1`) and AAC (`mp4a`) markers, decoded the video at 1280 × 720, and checked the 30 fps capture setting. This verifies desktop Brave's real encoder, but is not a physical iPhone test. Live capture may still drop frames under load.
- App and service-worker versions are 7. The existing update page activates the new shell without clearing local recordings or settings. Existing recordings are not transcoded. This format does not disable Google's preview processing.
# Oracle authentication migration — October 23, 2026

- Deployed CamSync 8 at the existing `https://vid.skrrt.party` origin on the owner's Oracle VM. Caddy issued a valid Let's Encrypt certificate; HTTP redirects to HTTPS. The root `skrrt.party` service still returns HTTP 200.
- New unauthenticated app requests return HTTP 401 with the Google sign-in gate. Only the three owner-approved Google emails can receive service sessions. Their private addresses are configured on the VM, outside source control. Public privacy, icons, manifest, and the recovery page remain available; previously downloaded offline shells still work locally.
- GitHub Pages was disabled after the migration; its Pages API now returns 404. The repository workflow runs checks and no longer deploys a public static copy.
- Real Google authorization for the owner succeeded with state, PKCE, verified email identity, and offline `drive.file` access. A fresh CamSync tab restored the connection after closing the previous tab. Artificially expiring only the stored short-lived access token caused a successful real Google refresh on reopening, without another Google prompt. Credentials were never printed or committed. The temporary workstation copy of the client JSON was removed after VM setup.
- The production authentication container passed 9 server tests: private static routes, state/callback replay protection, allowlisting, encrypted credentials, cookie flags, persistence across restart, CSRF/origin checks, refresh/revocation, disconnect, session expiry, and Google authorization parameters.
- Local checks: 12 Node tests passed; 47 Chromium/WebKit browser tests passed and 1 native-HEVC test skipped because bundled Chromium lacks the encoder. The added browser cases cover automatic restore, expired access, token rejection/retry, disconnect across reload, and offline disconnect. Existing retention, account separation, queue, and update-preservation tests still pass.
- No camera is attached to the deployment workstation. No new real recording or video upload was performed during this authentication migration. Actual iPhone installed-PWA cookie persistence and camera behavior require the user's device check. Background uploads/cleanup while iOS closes or suspends the PWA remain unavailable.
- Runtime secrets are in `/etc/camsync` and encrypted sessions in `/var/lib/camsync`; neither is inside the public project or ZIP. The VM accepts at most 4 KiB request bodies; recordings continue directly from phone to Google Drive.
