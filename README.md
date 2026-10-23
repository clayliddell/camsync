# CamSync

A browser-installed phone PWA for local video recording and direct Google Drive backup. Live app: **https://vid.skrrt.party/**. Source: **https://github.com/clayliddell/camsync**.

Recordings, settings, upload progress, and upload history stay on the phone. A small authentication service on the owner's existing Oracle VM stores encrypted Google credentials and sessions so users can reopen CamSync without signing in on every launch. Only invited Google accounts can obtain sessions. Each user grants access to their own Drive.

## Recording and backup

- MP4, H.265 (HEVC) video, AAC audio, 720p at 30 fps. The camera requests 1280 × 720, accepting the equivalent portrait dimensions. Devices without the requested encoder/profile show an error. Live capture can drop frames under load. Existing recordings retain their format.
- A finished recording is saved atomically to phone IndexedDB before uploading. Resumable uploads send 8 MiB chunks directly to Drive, bypassing the Oracle VM. The folder defaults to **CamSync**.
- The uploaded file's ID and byte count must be verified before its retention clock starts. Choose **7, 14, or 30 days** in Settings. Only verified phone copies expire; **Drive backups are kept**. Failed, queued, or unverified recordings remain on the phone.
- Cleanup runs while the app is open or when next reopened. iOS does not let this PWA reliably upload or run cleanup while closed. Keep the app open for uploads.
- Account-specific folders and resumable sessions prevent account switching from reusing another account's upload. Web Locks serialize uploads across supported browser tabs.

Google Drive still creates its own playback previews. HEVC/MP4 does not bypass Drive processing.

## Google connection and private access

Sign-in uses a top-level authorization redirect, offline access, state, PKCE, and a verified Google ID token. The server creates an opaque Secure/HttpOnly session cookie. On reopening, the app obtains a short-lived access token without another Google prompt. Expired tokens renew automatically; a rejected Drive token refreshes and retries once. Revoked grants require reconnecting.

The VM never receives recordings, recording settings, upload progress, or upload history. It stores encrypted Google credentials, account identity, and session information. Access tokens stay in browser memory; refresh tokens and the client secret stay server-side. No analytics or advertising trackers are added.

Sessions last up to 90 days without use and renew when connected. Google or browser policies can require earlier sign-in. Browser and installed-PWA cookie stores may be separate; connect once from the installed app after updating. Removing an email from the private server allowlist blocks service access. Previously installed offline copies can still record; an access gate cannot recall downloaded code or phone files.

Disconnecting clears this account's stored service sessions and attempts to revoke its Google grant. An offline disconnect finishes when connectivity returns. Phone recordings and Drive backups are retained. Clearing browser data can remove unsynced recordings; never clear storage to update.

## Development and tests

`npm start` serves the static UI at **http://localhost:4173**. It does not implement real authentication. Browser tests mock `/auth/*` and Drive. Production runs the Python service in `server/` over HTTPS; see `DEPLOYMENT.md`.

```sh
npm ci
npm test
npx playwright install chromium webkit
npm run test:browser
python -m pip install -r server/requirements.txt
python -m unittest discover -s server -p test_auth.py
```

Tests cover retention, codec/profile selection, IndexedDB, offline shell updates, automatic reconnection, refresh, revocation, account switching, state/CSRF protection, private access, and encrypted credentials. Most Google responses and camera bytes are mocked. Actual target iPhone behavior still needs verification. See `VALIDATION.md`.

## Updating an installed app

Open **https://vid.skrrt.party/update.html** from the same browser or installed app. Finish any recording first. Sign in once if requested; the update preserves phone recordings and settings. Keep the hostname unchanged to preserve IndexedDB access.
