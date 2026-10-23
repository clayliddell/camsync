# CamSync

A phone web app that records video locally and backs it up directly to the user's Google Drive. No application server, user database, analytics, or third-party recording storage is used.

The live deployment is **https://vid.skrrt.party/**, with source at **https://github.com/clayliddell/camsync**. Google OAuth is configured for that HTTPS origin. See `DEPLOYMENT.md` for hosting details.

## What changed in v2

- **Sign in with Google** connects the user's own Drive using Google Identity Services and the limited `drive.file` scope.
- Each finished recording is saved to IndexedDB on the phone before entering the upload queue. Uploads start automatically when connected and signed in.
- A configurable Drive folder (default **CamSync**) is found or created in the connected account. Account changes use separate folder caches and restart partial uploads in the new account.
- Uploads use resumable 8 MiB chunks. The completed file's ID and byte count are checked with Drive before it is marked uploaded.
- **Settings → Delete phone copies after upload** offers **7, 14, or 30 days**, defaulting to 7. The clock starts at the verified upload time. Only the phone's video bytes expire; Drive backups stay intact. Queued, failed, and unconfirmed recordings never expire.
- Cleanup runs on startup, return to the app, after an upload, after settings changes, and every minute while visible. Shortening the setting applies immediately to existing uploaded copies; lengthening it keeps remaining copies longer. Previously removed bytes cannot be restored by changing the setting.
- Recordings display their local removal date and a link to the Drive backup. Up to 40 history entries whose phone bytes have been removed are kept.
- Tokens are held in memory only. Legacy v1 persisted tokens are removed; existing recordings and settings are preserved. The old “keep local” switch is replaced by timed retention. Previously removed phone copies cannot be recovered locally.

## Recording format

Recordings request **MP4 with H.265 (HEVC) video and AAC audio, at 720p and 30 fps**. The camera requests 1280 × 720 at 30 fps and checks the returned track settings; portrait output may report 720 × 1280. Existing 1080p settings migrate to this fixed profile. The video bitrate target remains 4 Mb/s, with 128 kb/s AAC audio. Live capture can drop frames under load; this is not an offline constant-frame-rate conversion.

CamSync tries explicit HEVC/AAC MIME configurations and rejects known H.264, WebM, unspecified-codec MP4, and other reported codecs. It shows an error when the device cannot start HEVC recording. [Recent iPhone WebKit supports HEVC MediaRecorder output](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/); support still depends on the phone, OS, and browser. Existing recordings keep their original format. [Google Drive may still process a playback preview](https://support.google.com/drive/answer/2423694?hl=en); this profile does not guarantee instant Drive previews.

## Run locally

Install Node.js 20 or later, then run from this folder:

```sh
npm start
```

Open **http://localhost:4173**. There is no production build step and no runtime npm dependency. The development server listens only on the local computer.

Phone camera access requires an HTTPS deployment. Host the app shell on any static HTTPS host; no recordings or account data are sent to that host by the application. Keep the same origin when updating so users retain access to their local IndexedDB data. A different origin gets separate storage.

## Configure Google sign-in before publishing

The live deployment's Google client is already configured. For a fork or a different hostname, complete this setup with your own client (or add the new origin to the existing client you control):

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project and enable the **Google Drive API**.
2. Configure branding, audience, and the OAuth consent screen. Request only `https://www.googleapis.com/auth/drive.file`. While in Testing, add the intended accounts as test users. Complete Google's applicable publishing steps before broad release.
3. Create a **Web application** OAuth client. Under **Authorized JavaScript origins**, add the exact app origin, such as `https://camsync.example.com`. For local development add `http://localhost:4173` (and `http://127.0.0.1:4173` if used). This version uses a Google dialog, not an application redirect URI.
4. Set the public client ID in `config.js`:

   ```js
   window.CAMSYNC_CONFIG = {
     googleClientId: 'YOUR_CLIENT_ID.apps.googleusercontent.com',
   };
   ```

   Alternatively, enter it under **Settings → App setup** on one device and tap **Save**. A client ID is public configuration; never put a client secret in this app.
5. Open the deployed app, tap the Google account chip, then **Sign in with Google**, choose an account, and approve Drive access. New recordings upload automatically to that account's configured folder.

The `drive.file` scope permits access to files created by, opened with, or explicitly shared with the app, rather than unrestricted Drive access. The app creates its own folder if no accessible folder matches the chosen name. It does not use a broad Drive scope or Google Picker.

Google tokens expire. Reconnect using the sign-in button after expiration or a full reload/reopen; recording offline still works and queued files stay on the phone. The app never silently opens sign-in windows. If a home-screen browser blocks Google's dialog, allow the window or open the same app URL in Safari or Chrome. Confirm installed-phone behavior before release.

## Phone behavior and local data

- **Uploads and cleanup need the app running.** This web app does not schedule OS background jobs. If closed when a phone copy expires, it removes that copy on the next successful local cleanup. Uploads resume when reopened and Google is reconnected. Exact cleanup while closed would require a native mobile implementation.
- **Local storage:** IndexedDB `camsync` holds `videos` metadata and `blobs` binary data. `localStorage` contains settings, basic display information for the last connected account, and account-specific folder IDs. Resumable session URLs stay in local upload metadata and are never cached by the service worker. Access tokens live in memory; no refresh tokens are used.
- **Storage protection:** CamSync requests persistent storage; the browser decides whether to grant it. Clearing site/app data, uninstalling in some browsers, or storage eviction can remove phone data. Drive backups remain. There is no separate CamSync cloud copy.
- **Recording:** The fixed profile is MP4/H.265/AAC at 720p/30 fps. Unsupported encoders or camera profiles show an error. Chunks stay in memory until Stop, then are saved atomically to IndexedDB. Prefer shorter clips for long sessions. Switching away can stop the camera; visibility/page events trigger saving, but force-closing before a recording is saved can lose it. Local recording metadata includes the reported codec MIME type and capture dimensions/frame rate for diagnosis.
- **Storage failures:** A failed local save is kept in memory for export using **Save it**; recording is disabled until exported. Keep the app open until that recording is saved.
- **Disconnecting:** Cancels further requests, revokes the current Google authorization when available, and clears the connected-account display. Local recordings and Drive backups remain. A request Drive already accepted may complete remotely; the phone file stays until a later upload pass verifies its backup.
- **Existing history:** An uploaded v1 entry with missing upload time or Drive ID is kept locally rather than guessing an expiry. Pending legacy sessions without an account identity restart in the selected account.
- **Multiple tabs:** Web Locks serialize upload passes across same-origin tabs in supported browsers. Use one tab on older browsers without Web Locks.

## Tests

```sh
npm ci
npm test
npx playwright install chromium webkit
npm run test:browser
```

Node tests verify retention boundaries and safe resumable offsets. Browser tests exercise actual IndexedDB, settings, queue processing, and UI in Chromium and WebKit with **mocked Google authorization and Drive responses**. A Chromium test records encoded video from a simulated camera. These tests do not sign in to a real account. Windows WebKit's test adapter cannot fulfill HTTP 308 responses, so that one mocked resume response uses a Fetch `Response` shim. WebKit also exercises the binary-storage fallback when Blob serialization fails. See `VALIDATION.md` for the verification results.

Before production, configure a real client and test consent, camera recording, interrupted uploads, Drive playback, token expiration/reconnect, and cleanup on the target iPhone/Android devices. No real Google upload has been performed in this workspace.

## Files and updates

| File | Purpose |
| --- | --- |
| `config.js` | Public Google OAuth client ID |
| `index.html`, `styles.css` | Camera UI, Google connection, retention settings |
| `app.js` | Local storage, recording, Google authorization, queue, cleanup |
| `core.js` | Shared retention and resumable-offset rules |
| `sw.js` | Versioned offline app shell |
| `update.html` | Downloads and activates the latest app without clearing local phone data |
| `manifest.webmanifest`, `icons/` | Home-screen installation |
| `scripts/serve.cjs` | Development server |
| `tests/`, `playwright.config.cjs` | Automated verification |

Publish the static app files (including `update.html`), manifest, and icons; tests and npm packages are development-only. Bump `VERSION` in `sw.js` and `APP_VERSION` in `app.js` whenever app files or configuration change. New shells download with HTTP-cache revalidation, and worker update checks bypass the HTTP cache. Workers normally wait for existing tabs to close.

If a phone still shows the old app, open **https://vid.skrrt.party/update.html** in the same browser, finish recordings in any other CamSync windows, tap **Update now**, then **Open CamSync**. This activates the newly downloaded shell without clearing IndexedDB or localStorage. Settings show the loaded app version and a permanent update link. Failed downloads leave the old app/data available and can be retried. Existing videos keep their original file format.

## Implementation references

- [Google Identity Services token model and expiry](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [Google Identity Services setup](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid)
- [Drive resumable uploads and Range headers](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Browser persistent storage](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)
