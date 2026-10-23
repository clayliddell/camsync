# Oracle deployment

The PWA stays at **https://vid.skrrt.party/**. Keeping this origin preserves access to existing phone recordings. GitHub holds source and runs checks; Oracle hosts the app and authentication service. GitHub Pages is disabled after migration to remove its alternate public app URL.

## Infrastructure

- SSH alias `oracle-vps`, Ubuntu, reached over the existing Tailscale connection.
- Porkbun DNS: `A vid → 64.181.199.141`, TTL 600. The apex record is separate.
- Code: `/opt/camsync`; Docker Compose: `server/compose.yaml`.
- Container `camsync`: non-root UID 10001, read-only image, 256 MiB limit, no published host port. Caddy reaches it over the existing `open-webui_app-network`.
- The `vid.skrrt.party` Caddy host proxies to `camsync:4180`. Add `server/Caddyfile.fragment` alongside existing hosts. The 4 KiB request limit prevents video uploads to this service. Caddy manages HTTPS and renewal.
- Existing root-domain game and other hosts keep their original containers.

## Secrets and sessions

- `/etc/camsync/google-client.json`: Google's web-client JSON, mode 0600, UID 10001. Never commit, package, or serve it.
- `/etc/camsync/credential.key`: Fernet encryption key generated on the VM, mode 0600, UID 10001. Losing it requires reconnecting users.
- `/etc/camsync/service.env`: `CAMSYNC_ALLOWED_EMAILS` with the owner's three invited addresses. Private; not copied into the public repository. Restart the container after editing it. An empty list fails startup.
- `/var/lib/camsync/auth.sqlite3`: opaque sessions and single-use login attempts. Credential/profile payloads are encrypted. Directory 0700; database 0600. Preserve the directory and key across updates.

Back up credentials only to an owner-approved encrypted destination. Do not put the encryption key or database in source control or public files.

Google project: `camsync-512516`. The existing web client uses origin `https://vid.skrrt.party` and callback `https://vid.skrrt.party/auth/callback`. Scopes are `openid`, email identity, and `drive.file`. The service verifies the ID token, email, nonce, and Drive permission ID. State, a short-lived HttpOnly cookie, and PKCE protect the callback. Access logs are disabled to avoid logging callback credentials.

Session cookies are Secure, HttpOnly, SameSite=Lax, and host-scoped. Sessions expire after 90 days without use and renew when the app reconnects. Google revocation, security policies, clearing browser data, or allowlist removal can require reconnecting sooner. Access tokens are returned only to same-origin POST requests with a session CSRF token. Refresh tokens never leave the VM. Recordings upload directly from the phone to Drive.

## Updating

1. Run Node, browser, and Python tests. Increment both app and service-worker versions when changing app files.
2. Copy application files, icons, and `server/` to `/opt/camsync`, excluding secrets and caches.
3. Run `cd /opt/camsync && sudo docker compose -f server/compose.yaml up -d --build`. Preserve `/etc/camsync` and `/var/lib/camsync`.
4. Verify container health, signed-out HTTP 401, Google sign-in, and reopening. Keep the hostname unchanged and never clear phone storage to update.

`/update.html` loads from the network, connects Google if necessary, and installs the new shell without clearing phone data. Google callbacks pass through it to upgrade older installed versions.

Roll back by redeploying a prior tested Oracle image while preserving credentials and sessions. Validate Caddy before reloading any proxy change. Restoring old GitHub DNS would restore only the static app, without persistent authentication or private access.

## Cost

This reuses the existing Oracle VM. No new paid compute, subscription, or storage service is provisioned. It uses existing VM resources and bandwidth. Recordings count against each user's Drive quota. Normal low-volume Google API usage is expected to stay within standard limits; a linked billing account is not a spending cap.
