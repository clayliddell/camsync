'use strict';

/* ================= Config ================= */
// Optional: paste your OAuth client ID here instead of entering it in Settings.
const DEFAULT_CLIENT_ID = window.CAMSYNC_CONFIG?.googleClientId || '';
const { retentionDays, localExpiry, expiredLocalIds, receivedOffset } = CamSyncCore;
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const CHUNK_SIZE = 8 * 1024 * 1024; // must be a multiple of 256 KiB
const HISTORY_LIMIT = 40;           // uploaded entries kept in the list
const QUALITY = {
  '720':  { w: 1280, h: 720,  bps: 4000000 },
  '1080': { w: 1920, h: 1080, bps: 8000000 },
};
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm',
];
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

/* ================= Small helpers ================= */
const $ = (id) => document.getElementById(id);
const ui = {
  preview: $('preview'), overlay: $('overlay'), overlayMsg: $('overlayMsg'), retryCamBtn: $('retryCamBtn'),
  accountBtn: $('accountBtn'), queueBtn: $('queueBtn'), timer: $('timer'),
  banner: $('banner'), bannerText: $('bannerText'), bannerBtn: $('bannerBtn'),
  settingsBtn: $('settingsBtn'), recordBtn: $('recordBtn'), flipBtn: $('flipBtn'),
  backdrop: $('backdrop'), sheet: $('sheet'), closeSheet: $('closeSheet'), list: $('list'),
  clientId: $('clientId'), folderName: $('folderName'), quality: $('quality'), retentionDays: $('retentionDays'),
  appOrigin: $('appOrigin'), saveSettings: $('saveSettings'), signOutBtn: $('signOutBtn'),
  googleSignInBtn: $('googleSignInBtn'), accountDetails: $('accountDetails'), storageInfo: $('storageInfo'),
  formatInfo: $('formatInfo'), toast: $('toast'),
};
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
  json(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
};
const randomId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
const fmtSize = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(1) + ' MB');
const fmtDur = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class AuthError extends Error { constructor() { super('Google sign-in needed'); } }
class NetError extends Error { constructor(m = 'No connection, will retry') { super(m); } }

let toastTimer = 0;
function toast(msg) {
  ui.toast.textContent = msg;
  ui.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.add('hidden'), 2800);
}

/* ================= Settings ================= */
const DEFAULTS = { clientId: '', folderName: 'CamSync', quality: '1080', retentionDays: 7 };
let settings = loadSettings();
function loadSettings() {
  const s = { ...DEFAULTS, ...(ls.json('cs.settings') || {}) };
  if (!s.clientId) s.clientId = DEFAULT_CLIENT_ID;
  if (!QUALITY[s.quality]) s.quality = '1080';
  if (!s.folderName) s.folderName = DEFAULTS.folderName;
  s.retentionDays = retentionDays(s.retentionDays);
  delete s.keepLocal; // Migrate v1 without deleting any existing phone copies.
  return s;
}
const storeSettings = () => ls.set('cs.settings', JSON.stringify(settings));

/* ================= Local storage (IndexedDB) ================= */
// 'videos' holds small metadata records; 'blobs' holds the video data, so
// progress updates never rewrite the video itself.
let db = null;
function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('camsync', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('videos', { keyPath: 'id' });
      r.result.createObjectStore('blobs');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const txDone = (t) => new Promise((res, rej) => {
  let requestError;
  t.oncomplete = () => res();
  t.onerror = (event) => { requestError = event.target.error; };
  t.onabort = () => rej(t.error || requestError || new Error('Storage transaction aborted'));
});
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function addVideo(meta, blob) {
  async function write(data) {
    const t = db.transaction(['videos', 'blobs'], 'readwrite');
    t.objectStore('blobs').put(data, meta.id);
    t.objectStore('videos').put(meta);
    await txDone(t);
  }
  try { await write(blob); }
  catch (error) {
    // Some WebKit environments cannot serialize Blob objects into IndexedDB.
    // Keep the same atomic local save using binary bytes in those browsers.
    if (!['UnknownError', 'DataCloneError'].includes(error?.name)) throw error;
    await write(await blob.arrayBuffer());
  }
}
async function listVideos() {
  if (!db) return [];
  return reqP(db.transaction('videos').objectStore('videos').getAll());
}
async function getBlob(id) {
  const data = await reqP(db.transaction('blobs').objectStore('blobs').get(id));
  return data instanceof ArrayBuffer ? new Blob([data]) : data;
}
function patchVideo(id, patch, dropBlob = false) {
  const t = db.transaction(['videos', 'blobs'], 'readwrite');
  const s = t.objectStore('videos');
  const g = s.get(id);
  g.onsuccess = () => { if (g.result) s.put({ ...g.result, ...patch }); };
  if (dropBlob) t.objectStore('blobs').delete(id);
  return txDone(t);
}
function deleteVideo(id) {
  const t = db.transaction(['videos', 'blobs'], 'readwrite');
  t.objectStore('videos').delete(id);
  t.objectStore('blobs').delete(id);
  return txDone(t);
}
async function pruneHistory() {
  const done = (await listVideos()).filter((v) => v.status === 'uploaded' && !v.hasBlob)
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const v of done.slice(HISTORY_LIMIT)) await deleteVideo(v.id);
}

// Delete only the local video bytes, atomically updating their metadata.
// No Drive request is ever made by retention cleanup, even when offline.
async function cleanupLocalCopies(now = Date.now()) {
  if (!db) return;
  const ids = expiredLocalIds(await listVideos(), settings.retentionDays, now);
  for (const id of ids) {
    await patchVideo(id, { hasBlob: false, localDeletedAt: now }, true);
  }
  await pruneHistory();
}

/* ================= Google Identity Services ================= */
// Tokens live only in memory. Never store a client secret or refresh token.
let authMessage = '';
let auth = null;
let authEpoch = 0;
let authController = new AbortController();
let signingIn = false;
let googleScript = null;

function getToken() {
  return auth && auth.exp > Date.now() ? auth.token : null;
}
function clearToken() {
  authEpoch++;
  authController.abort();
  authController = new AbortController();
  auth = null;
  signingIn = false;
}

function loadGoogleIdentity() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (googleScript) return googleScript;
  googleScript = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = resolve;
    script.onerror = () => { script.remove(); googleScript = null; reject(new Error('Google sign-in unavailable')); };
    document.head.append(script);
  });
  return googleScript;
}

function authFailed(message) {
  clearToken();
  authMessage = message;
  render();
}

function signIn() {
  if (isRecording() || signingIn) return;
  if (!settings.clientId) {
    openSheet('settings');
    $('developerSetup').open = true;
    toast('The app owner needs to configure Google sign-in first.');
    return;
  }
  if (!navigator.onLine) { toast('Connect to the internet to sign in. Your recordings stay on this phone.'); return; }
  if (!window.google?.accounts?.oauth2) {
    loadGoogleIdentity().then(() => toast('Google is ready. Tap Sign in with Google again.'))
      .catch(() => toast('Couldn’t load Google sign-in. Check your connection and try again.'));
    return;
  }
  clearToken();
  const epoch = authEpoch;
  signingIn = true;
  authMessage = '';
  const client = google.accounts.oauth2.initTokenClient({
    client_id: settings.clientId,
    scope: SCOPE,
    include_granted_scopes: false,
    callback: async (response) => {
      if (epoch !== authEpoch) return;
      if (response.error) { authFailed(response.error === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in failed. Please try again.'); return; }
      if (!response.access_token || !google.accounts.oauth2.hasGrantedAllScopes(response, SCOPE)) {
        authFailed('Drive access wasn’t granted. Sign in again and allow CamSync to create its backups.');
        return;
      }
      const ttl = Number(response.expires_in);
      if (!Number.isFinite(ttl) || ttl <= 60) { authFailed('Google returned an expired session. Please sign in again.'); return; }
      auth = { token: response.access_token, exp: Date.now() + (ttl - 60) * 1000, profile: null };
      try {
        const profile = await fetchAccount();
        if (epoch !== authEpoch) return;
        auth.profile = profile;
        ls.set('cs.account', JSON.stringify(profile));
        ls.set('cs.signedIn', '1');
        signingIn = false;
        render();
        toast('Connected to Google Drive. Uploads will start automatically.');
        processQueue();
      } catch (error) {
        if (epoch === authEpoch) authFailed(error instanceof AuthError ? 'Please reconnect Google Drive.' : 'Couldn’t connect to Google Drive. Check your connection and try again.');
      }
    },
    error_callback: (error) => {
      if (epoch !== authEpoch) return;
      authFailed(error.type === 'popup_closed' ? 'Google sign-in was cancelled.' : 'Allow Google’s sign-in window, then try again. If needed, open CamSync in Safari or Chrome.');
    },
  });
  try { client.requestAccessToken({ prompt: 'select_account' }); }
  catch { authFailed('Couldn’t open Google sign-in. Please try again.'); }
  render();
}

function signOut() {
  const token = getToken();
  clearToken();
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
  ['cs.signedIn', 'cs.account', 'cs.email'].forEach((key) => ls.del(key));
  authMessage = '';
  render();
  toast('Google disconnected. Phone recordings and Drive backups are kept.');
}

/* ================= Drive API ================= */
async function api(url, opts = {}) {
  const token = getToken();
  const epoch = authEpoch;
  if (!token) throw new AuthError();
  let r;
  try {
    r = await fetch(url, { ...opts, signal: authController.signal, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
  } catch (error) { if (error.name === 'AbortError') throw new AuthError(); throw new NetError(); }
  if (epoch !== authEpoch) throw new AuthError();
  if (r.status === 401) { clearToken(); authMessage = 'Please reconnect Google Drive. Your recordings stay on this phone.'; render(); throw new AuthError(); }
  return r;
}
async function apiError(r, what) {
  let msg = '';
  try { msg = (await r.json()).error?.message || ''; } catch {}
  if (r.status === 403 && /insufficient/i.test(msg)) { clearToken(); authMessage = 'Please sign in again and allow Google Drive access.'; render(); return new AuthError(); }
  if (r.status === 429 || r.status >= 500 || (r.status === 403 && /rate limit/i.test(msg))) return new NetError('Drive is busy, will retry');
  return new Error(`${what} (${r.status}${msg ? ': ' + msg : ''})`);
}

async function fetchAccount() {
  const r = await api(`${DRIVE}/about?fields=user(emailAddress,displayName,permissionId)`);
  if (!r.ok) throw await apiError(r, 'Couldn’t read Google account');
  const user = (await r.json()).user;
  if (!user?.permissionId) throw new Error('Google account identity unavailable');
  return { id: user.permissionId, email: user.emailAddress || '', name: user.displayName || '' };
}

async function ensureFolder() {
  const name = settings.folderName;
  const key = 'cs.folder:' + auth.profile.id + ':' + name;
  const cached = ls.get(key);
  if (cached) {
    const r = await api(`${DRIVE}/files/${encodeURIComponent(cached)}?fields=id,trashed`);
    if (r.ok && !(await r.json()).trashed) return cached;
    if (!r.ok && r.status !== 404) throw await apiError(r, 'Couldn’t check Drive folder');
    ls.del(key);
  }
  const q = `name='${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const found = await api(`${DRIVE}/files?` + new URLSearchParams({ q, fields: 'files(id)', spaces: 'drive' }));
  if (!found.ok) throw await apiError(found, 'Couldn’t look up Drive folder');
  let id = (await found.json()).files?.[0]?.id;
  if (!id) {
    const made = await api(`${DRIVE}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
    });
    if (!made.ok) throw await apiError(made, 'Couldn’t create Drive folder');
    id = (await made.json()).id;
  }
  ls.set(key, id);
  return id;
}

// Ask the upload session how much it already has (used when resuming).
async function queryOffset(url, total) {
  const r = await api(url, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}` } });
  if (r.ok) return { done: await r.json() };
  if (r.status === 308) {
    return { offset: receivedOffset(r.headers.get('Range'), total) };
  }
  if (r.status === 404 || r.status === 410) return { expired: true };
  throw await apiError(r, 'Couldn’t resume upload');
}

// Resumable, chunked upload. Progress is saved after every chunk so an
// interrupted upload continues where it left off next time the app opens.
async function uploadOne(v, blob, onProgress) {
  const total = blob.size;
  const epoch = authEpoch;
  const accountId = auth?.profile?.id;
  if (!accountId || !getToken()) throw new AuthError();
  // A resumable session belongs to the account that created it. Legacy v1
  // sessions have no owner and must also be restarted safely.
  let url = v.uploadAccountId === accountId ? v.uploadUrl || null : null;
  let offset = 0;

  if (url) {
    const s = await queryOffset(url, total);
    if (s.done) return s.done;
    if (s.expired) url = null;
    else offset = s.offset;
  }
  if (!url) {
    const folderId = await ensureFolder();
    const r = await api(`${UPLOAD}/files?uploadType=resumable&fields=id,webViewLink,size`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': v.mime,
        'X-Upload-Content-Length': String(total),
      },
      body: JSON.stringify({ name: v.name, mimeType: v.mime, parents: [folderId], appProperties: { camsyncRecordingId: v.id } }),
    });
    if (!r.ok) throw await apiError(r, 'Couldn’t start upload');
    url = r.headers.get('Location');
    if (!url) throw new Error('Drive didn’t return an upload address');
    offset = 0;
    await patchVideo(v.id, { uploadUrl: url, offset: 0, uploadAccountId: accountId });
  }

  onProgress(offset / total);
  while (offset < total) {
    if (epoch !== authEpoch) throw new AuthError();
    const end = Math.min(offset + CHUNK_SIZE, total);
    const r = await api(url, { method: 'PUT', headers: { 'Content-Type': v.mime, 'Content-Range': `bytes ${offset}-${end - 1}/${total}` }, body: blob.slice(offset, end) });

    if (r.status === 308) {
      const next = receivedOffset(r.headers.get('Range'), total);
      if (next <= offset) throw new NetError('Upload paused, will retry');
      offset = next;
      await patchVideo(v.id, { offset });
      onProgress(offset / total);
      continue;
    }
    if (r.ok) { onProgress(1); return r.json(); }
    if (r.status >= 500 || r.status === 429) throw new NetError('Drive is busy, will retry');
    await patchVideo(v.id, { uploadUrl: null, offset: 0 });
    if (r.status === 404 || r.status === 410) throw new NetError('Upload expired, will restart');
    throw await apiError(r, 'Upload failed');
  }
  const s = await queryOffset(url, total);
  if (s.done) return s.done;
  throw new NetError('Upload didn’t finish, will retry');
}

/* ================= Upload queue ================= */
const progress = new Map();
let videos = [];
let busy = false;
let rerun = false;

const isPending = (v) => v.status === 'pending' || v.status === 'uploading' || v.status === 'failed';
const pendingCount = () => videos.filter(isPending).length;

async function refresh() { videos = await listVideos(); render(); }

async function processQueue() {
  if (!db) return;
  if (busy) { rerun = true; return; }
  busy = true;
  rerun = false;
  try {
    // Two open tabs must never upload the same local recording simultaneously.
    if (navigator.locks) {
      await navigator.locks.request('camsync-upload-queue', { ifAvailable: true }, (lock) => lock ? drainQueue() : undefined);
    } else await drainQueue();
  } finally {
    busy = false;
    // A recording may arrive while the previous pass is doing final cleanup,
    // after its queue loop has already ended. Do not lose that wake-up.
    if (rerun) { rerun = false; processQueue(); }
  }
}

async function drainQueue() {
  try {
    outer: do {
      rerun = false;
      if (!navigator.onLine || !getToken() || !auth?.profile) break;
      const queue = (await listVideos()).filter(isPending).sort((a, b) => a.createdAt - b.createdAt);
      for (const v of queue) {
        if (!getToken() || !auth?.profile) break outer;
        const blob = await getBlob(v.id);
        if (!blob) { await patchVideo(v.id, { status: 'missing', error: 'Video data is missing on this device' }); continue; }
        await patchVideo(v.id, { status: 'uploading', error: null });
        await refresh();
        try {
          const epoch = authEpoch;
          const res = await uploadOne(v, blob, (f) => { progress.set(v.id, f); renderProgress(v.id); });
          if (epoch !== authEpoch) throw new AuthError();
          if (!res.id) throw new Error('Drive did not confirm the uploaded file. Phone copy kept.');
          // Check the remote size before starting the local retention clock.
          const confirmed = await api(`${DRIVE}/files/${encodeURIComponent(res.id)}?fields=id,size,webViewLink,trashed`);
          if (!confirmed.ok) throw await apiError(confirmed, 'Couldn’t verify uploaded recording');
          const file = await confirmed.json();
          if (epoch !== authEpoch) throw new AuthError();
          if (file.id !== res.id || file.trashed || Number(file.size) !== blob.size) {
            throw new Error('Drive backup could not be verified. Phone copy kept.');
          }
          const link = `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`;
          await patchVideo(v.id, { status: 'uploaded', uploadUrl: null, offset: 0, error: null, driveId: file.id, driveAccountId: auth.profile.id, link, uploadedAt: Date.now(), hasBlob: true });
          progress.delete(v.id);
          await refresh();
        } catch (e) {
          progress.delete(v.id);
          if (e instanceof AuthError) {
            await patchVideo(v.id, { status: 'pending' });
            await refresh();
            break outer;
          }
          await patchVideo(v.id, { status: 'failed', error: e.message });
          await refresh();
          if (e instanceof NetError) break outer;
        }
      }
    } while (rerun);
  } catch (e) {
    console.error(e);
  } finally {
    try { await cleanupLocalCopies(); } catch (error) { console.error('Local cleanup failed', error); }
    await refresh();
  }
}

/* ================= Camera & recording ================= */
let stream = null;
let recorder = null;
let finalizing = false;
let facing = 'environment';
let recStartedAt = 0;
let timerId = 0;
let wakeLock = null;
let unsavedFile = null;

const isRecording = () => !!recorder && recorder.state === 'recording';

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of MIME_CANDIDATES) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
  }
  return '';
}

function showOverlay(msg, canRetry) {
  ui.overlayMsg.textContent = msg;
  ui.retryCamBtn.classList.toggle('hidden', !canRetry);
  ui.overlay.classList.remove('hidden');
}

function stopStream() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  ui.preview.srcObject = null;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showOverlay('This browser can’t use the camera. On iPhone, open the app in Safari.', false);
    return;
  }
  stopStream();
  ui.recordBtn.disabled = true;
  const q = QUALITY[settings.quality];
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { facingMode: { ideal: facing }, width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: 30 } },
    });
  } catch (e) {
    showOverlay(e.name === 'NotAllowedError'
      ? 'Camera or microphone access was blocked. Allow it and try again.'
      : `Couldn’t start the camera (${e.message || e.name}).`, true);
    return;
  }
  ui.preview.srcObject = stream;
  ui.preview.classList.toggle('mirror', facing === 'user');
  try { await ui.preview.play(); } catch {}
  ui.overlay.classList.add('hidden');
  ui.recordBtn.disabled = finalizing || !!unsavedFile;
}

function tick() {
  const s = Math.floor((Date.now() - recStartedAt) / 1000);
  ui.timer.textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

async function requestWakeLock() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {} }
function releaseWakeLock() { try { wakeLock?.release(); } catch {} wakeLock = null; }

function startRecording() {
  if (!stream || isRecording() || finalizing || unsavedFile) return;
  const mime = pickMime();
  if (mime === null) { toast('Recording isn’t supported in this browser.'); return; }
  const q = QUALITY[settings.quality];
  const opts = { videoBitsPerSecond: q.bps, audioBitsPerSecond: 128000 };
  if (mime) opts.mimeType = mime;
  let rec;
  try { rec = new MediaRecorder(stream, opts); } catch { rec = new MediaRecorder(stream); }
  const startedAt = Date.now();
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    finalizing = true;
    ui.recordBtn.disabled = true;
    try { await saveRecording(chunks, rec.mimeType || mime, startedAt, Date.now()); }
    finally {
      finalizing = false;
      ui.recordBtn.disabled = !stream || !!unsavedFile;
      ui.flipBtn.disabled = false;
      ui.settingsBtn.disabled = false;
    }
  };
  rec.onerror = (e) => toast('Recording error: ' + (e.error?.message || 'unknown'));
  recorder = rec;
  rec.start(1000);

  recStartedAt = startedAt;
  ui.recordBtn.classList.add('on');
  ui.recordBtn.setAttribute('aria-label', 'Stop recording');
  ui.flipBtn.disabled = true;
  ui.settingsBtn.disabled = true;
  ui.timer.classList.remove('hidden');
  tick();
  timerId = setInterval(tick, 500);
  requestWakeLock();
}

function stopRecording() {
  if (isRecording()) { finalizing = true; ui.recordBtn.disabled = true; recorder.stop(); }
  ui.recordBtn.classList.remove('on');
  ui.recordBtn.setAttribute('aria-label', 'Start recording');
  ui.flipBtn.disabled = finalizing;
  ui.settingsBtn.disabled = finalizing;
  ui.timer.classList.add('hidden');
  clearInterval(timerId);
  releaseWakeLock();
}

async function saveRecording(parts, mimeType, startedAt, stoppedAt) {
  const type = (mimeType || parts[0]?.type || 'video/mp4').split(';')[0];
  const blob = new Blob(parts, { type });
  if (!blob.size) { toast('Nothing was recorded.'); return; }
  const ext = type.includes('mp4') ? 'mp4' : type.includes('webm') ? 'webm' : 'mov';
  const meta = {
    id: randomId(),
    name: `Video ${stamp(new Date(startedAt))}.${ext}`,
    mime: type,
    size: blob.size,
    duration: stoppedAt - startedAt,
    createdAt: startedAt,
    status: 'pending',
    hasBlob: true,
  };
  try {
    if (!db) throw new Error('storage unavailable');
    await addVideo(meta, blob);
  } catch {
    unsavedFile = new File([blob], meta.name, { type });
    ui.recordBtn.disabled = true;
    render();
    return;
  }
  toast(getToken() && navigator.onLine ? 'Saved · uploading' : 'Saved · will upload when connected');
  await refresh();
  processQueue();
}

async function shareFile(file) {
  try {
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] });
    else {
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    return true;
  } catch (e) {
    if (e.name !== 'AbortError') toast('Couldn’t share the video.');
    return false;
  }
}

/* ================= Rendering ================= */
function setChip(btn, dotClass, text) {
  btn.querySelector('.dot').className = 'dot' + (dotClass ? ' ' + dotClass : '');
  btn.querySelector('span').textContent = text;
}

function render() {
  const token = getToken();
  const pending = pendingCount();
  const uploading = videos.some((v) => v.status === 'uploading');

  if (!settings.clientId) setChip(ui.accountBtn, '', 'Google account');
  else if (signingIn) setChip(ui.accountBtn, 'busy', 'Connecting');
  else if (token && auth.profile) setChip(ui.accountBtn, 'ok', auth.profile.email || 'Drive');
  else if (ls.get('cs.signedIn') === '1') setChip(ui.accountBtn, 'warn', 'Reconnect');
  else setChip(ui.accountBtn, '', 'Sign in');

  const account = auth?.profile || ls.json('cs.account');
  ui.accountDetails.textContent = token && auth?.profile
    ? `Connected${account.email ? ' as ' + account.email : ''}. New recordings upload automatically.`
    : signingIn ? 'Connecting to Google Drive…'
      : account ? `Reconnect${account.email ? ' ' + account.email : ' Google Drive'} to resume uploads.`
        : 'Sign in to automatically back up your recordings.';
  ui.googleSignInBtn.classList.toggle('hidden', !!token && !!auth?.profile);
  ui.googleSignInBtn.disabled = signingIn;
  ui.signOutBtn.classList.toggle('hidden', !token && !account && !signingIn);

  if (uploading) setChip(ui.queueBtn, 'busy', `Uploading ${pending}`);
  else if (pending) setChip(ui.queueBtn, 'warn', `${pending} waiting`);
  else if (videos.length) setChip(ui.queueBtn, 'ok', 'All uploaded');
  else setChip(ui.queueBtn, '', 'No videos');

  let banner = null;
  if (unsavedFile) banner = ['Couldn’t store this video. Save it before leaving or recording again.', 'Save it', () => shareFile(unsavedFile).then((saved) => { if (saved) { unsavedFile = null; ui.recordBtn.disabled = !stream || finalizing; render(); } })];
  else if (authMessage) banner = [authMessage, 'OK', () => { authMessage = ''; render(); }];
  else if (!settings.clientId && pending) banner = ['Saved on this phone. Google Drive backup needs app setup.', 'Settings', () => openSheet('settings')];
  else if (pending && !navigator.onLine) banner = [`Offline. ${pending} video${pending > 1 ? 's' : ''} will upload when you’re back online.`, 'OK', null];
  else if (pending && !token) banner = [`${pending} video${pending > 1 ? 's' : ''} saved on this phone, waiting for Google Drive.`, 'Sign in', () => openSheet('settings')];
  if (banner && !isRecording()) {
    ui.bannerText.textContent = banner[0];
    ui.bannerBtn.textContent = banner[1];
    ui.bannerBtn.onclick = banner[2] || (() => ui.banner.classList.add('hidden'));
    ui.banner.classList.remove('hidden');
  } else {
    ui.banner.classList.add('hidden');
  }

  renderList();
}

function statusText(v) {
  switch (v.status) {
    case 'uploading': return `Uploading ${Math.round((progress.get(v.id) || 0) * 100)}%`;
    case 'pending': return 'Waiting to upload';
    case 'failed': return v.error || 'Upload failed';
    case 'missing': return v.error || 'Missing';
    case 'uploaded': return 'Uploaded';
    default: return v.status;
  }
}

function renderList() {
  const items = [...videos].sort((a, b) => b.createdAt - a.createdAt);
  if (!items.length) {
    ui.list.innerHTML = '<div class="empty">Videos you record show up here.</div>';
    return;
  }
  const canShare = !!navigator.canShare;
  ui.list.innerHTML = items.map((v) => {
    const when = new Date(v.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const err = v.status === 'failed' || v.status === 'missing';
    const acts = [];
    if (v.status === 'uploaded' && v.driveId) acts.push(`<a href="https://drive.google.com/file/d/${encodeURIComponent(v.driveId)}/view" target="_blank" rel="noopener">Drive</a>`);
    if (v.status === 'failed') acts.push(`<button data-act="retry" data-id="${esc(v.id)}">Retry</button>`);
    if (v.hasBlob && canShare && v.status !== 'uploading') acts.push(`<button data-act="share" data-id="${esc(v.id)}">Share</button>`);
    if (v.status !== 'uploading' && v.status !== 'uploaded') acts.push(`<button class="danger" data-act="delete" data-id="${esc(v.id)}">Delete</button>`);
    const expiry = localExpiry(v, settings.retentionDays);
    const note = v.status === 'uploaded'
      ? !v.hasBlob ? 'Phone copy removed · Drive backup kept'
        : expiry ? `Phone copy kept until ${new Date(expiry).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
          : 'Phone copy kept · upload date unavailable'
      : 'Saved on this phone';
    return `<div class="item" data-id="${esc(v.id)}">
      <div class="meta">
        <div class="name">${esc(v.name)}</div>
        <div class="sub${err ? ' err' : ''}">${esc(when)} · ${fmtDur(v.duration || 0)} · ${fmtSize(v.size || 0)} · <span class="st">${esc(statusText(v))}</span></div>
        <div class="local-note">${esc(note)}</div>
        ${v.status === 'uploading' ? `<div class="bar"><i style="width:${Math.round((progress.get(v.id) || 0) * 100)}%"></i></div>` : ''}
      </div>
      <div class="acts">${acts.join('')}</div>
    </div>`;
  }).join('');
}

function renderProgress(id) {
  const row = ui.list.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
  if (!row) return;
  const pct = Math.round((progress.get(id) || 0) * 100);
  const bar = row.querySelector('.bar i');
  if (bar) bar.style.width = pct + '%';
  const st = row.querySelector('.st');
  if (st) st.textContent = `Uploading ${pct}%`;
}

/* ================= Sheet & settings ================= */
function openSheet(tab = 'uploads') {
  if (isRecording()) return;
  switchTab(tab);
  ui.sheet.classList.remove('hidden');
  ui.backdrop.classList.remove('hidden');
  ui.closeSheet.focus();
}
function closeSheet() {
  ui.sheet.classList.add('hidden');
  ui.backdrop.classList.add('hidden');
}
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('tab-uploads').classList.toggle('hidden', tab !== 'uploads');
  $('tab-settings').classList.toggle('hidden', tab !== 'settings');
  if (tab === 'settings') fillSettingsForm();
}
function fillSettingsForm() {
  ui.clientId.value = settings.clientId;
  ui.folderName.value = settings.folderName;
  ui.quality.value = settings.quality;
  ui.retentionDays.value = String(settings.retentionDays);
  ui.appOrigin.textContent = location.origin;
  const mime = pickMime();
  ui.formatInfo.textContent = mime === null ? 'This browser can’t record video.' : `Records as ${mime ? mime.split(';')[0] : 'the browser default'}.`;
}
async function saveSettingsForm() {
  const prev = { ...settings };
  const clientId = ui.clientId.value.trim();
  if (clientId && !/^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    toast('Enter a valid Google OAuth client ID.');
    ui.clientId.focus();
    return;
  }
  settings = {
    clientId,
    folderName: ui.folderName.value.trim().replace(/[\\/]/g, '-') || DEFAULTS.folderName,
    quality: QUALITY[ui.quality.value] ? ui.quality.value : '1080',
    retentionDays: retentionDays(ui.retentionDays.value),
  };
  storeSettings();
  if (settings.quality !== prev.quality && !isRecording()) startCamera();
  if (settings.clientId !== prev.clientId) {
    clearToken();
    ls.del('cs.signedIn');
    ls.del('cs.account');
  }
  closeSheet();
  try { await cleanupLocalCopies(); await refresh(); }
  catch { toast('Settings saved. Phone cleanup will retry when the app reopens.'); return; }
  toast('Settings saved. Drive backups are kept.');
  render();
  processQueue();
}

/* ================= Wiring ================= */
function bindUI() {
  ui.recordBtn.addEventListener('click', () => (isRecording() ? stopRecording() : startRecording()));
  ui.flipBtn.addEventListener('click', () => { if (isRecording()) return; facing = facing === 'user' ? 'environment' : 'user'; startCamera(); });
  ui.retryCamBtn.addEventListener('click', startCamera);
  ui.settingsBtn.addEventListener('click', () => openSheet('uploads'));
  ui.queueBtn.addEventListener('click', () => openSheet('uploads'));
  ui.accountBtn.addEventListener('click', () => openSheet('settings'));
  ui.googleSignInBtn.addEventListener('click', signIn);
  ui.closeSheet.addEventListener('click', closeSheet);
  ui.backdrop.addEventListener('click', closeSheet);
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  ui.saveSettings.addEventListener('click', saveSettingsForm);
  ui.signOutBtn.addEventListener('click', () => { signOut(); fillSettingsForm(); });

  ui.list.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const v = videos.find((x) => x.id === id);
    if (!v) return;
    if (btn.dataset.act === 'retry') {
      await patchVideo(id, { status: 'pending', error: null });
      await refresh();
      if (!getToken()) openSheet('settings'); else processQueue();
    } else if (btn.dataset.act === 'share') {
      const blob = await getBlob(id);
      if (blob) shareFile(new File([blob], v.name, { type: v.mime }));
    } else if (btn.dataset.act === 'delete') {
      if (confirm(`Delete “${v.name}” from this device? It hasn’t been uploaded.`)) { await deleteVideo(id); await refresh(); }
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (isRecording()) stopRecording(); return; }
    if (!stream || stream.getVideoTracks().every((t) => t.readyState === 'ended')) {
      if (ui.retryCamBtn.classList.contains('hidden')) startCamera();
    }
    maintenance();
  });
  window.addEventListener('pagehide', () => { if (isRecording()) stopRecording(); });
  window.addEventListener('online', () => { loadGoogleIdentity().catch(() => {}); maintenance(); });
  window.addEventListener('offline', render);
  document.addEventListener('keydown', (event) => {
    if (ui.sheet.classList.contains('hidden')) return;
    if (event.key === 'Escape') closeSheet();
    if (event.key === 'Tab') {
      const focusable = [...ui.sheet.querySelectorAll('button, input, select, summary, a[href]')]
        .filter((element) => !element.disabled && element.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  setInterval(() => { if (!document.hidden) maintenance(); }, 60000);
}

async function maintenance() {
  try { await cleanupLocalCopies(); await refresh(); await processQueue(); }
  catch (error) { console.error('Local maintenance failed', error); }
}

async function init() {
  // Remove credentials left behind by v1. Returning users reconnect once.
  ['cs.token', 'cs.oauthState', 'cs.lastAuthAttempt', 'cs.email'].forEach((key) => ls.del(key));
  if (/(^#|&)(access_token|error)=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  storeSettings();
  bindUI();
  try { db = await openDB(); } catch (e) { toast('Local storage unavailable: ' + (e?.message || e)); }
  try {
    const persistent = await navigator.storage?.persist?.();
    ui.storageInfo.textContent = persistent ? 'Persistent local storage is enabled on this device.' : 'Phone storage is managed by your browser. Clearing app data removes phone recordings, settings, and history. Drive backups are kept.';
  } catch {}
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // Recover interrupted status only when another tab is not actively uploading.
  const recover = async () => {
    if (db) for (const v of await listVideos()) if (v.status === 'uploading') await patchVideo(v.id, { status: 'pending' });
  };
  if (navigator.locks) await navigator.locks.request('camsync-upload-queue', { ifAvailable: true }, (lock) => lock ? recover() : undefined);
  else await recover();
  await cleanupLocalCopies();
  await refresh();
  if (navigator.onLine) loadGoogleIdentity().catch(() => {});
  startCamera();
  processQueue();
}

init();
