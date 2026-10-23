"""CamSync's credential service. Video bytes never enter this application."""
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

import requests
from cryptography.fernet import Fernet
from flask import Flask, abort, jsonify, make_response, redirect, request, send_from_directory
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.id_token import verify_oauth2_token
from google_auth_oauthlib.flow import Flow

DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
SCOPES = ['openid', 'https://www.googleapis.com/auth/userinfo.email', DRIVE_SCOPE]
SESSION_COOKIE = '__Host-camsync'
STATE_COOKIE = '__Host-camsync-login'
SESSION_TTL = 90 * 86400
PUBLIC_FILES = {'privacy.html', 'manifest.webmanifest', 'icons/icon-192.png',
                'icons/icon-512.png', 'icons/apple-touch-icon.png', 'update.html'}
APP_FILES = {'index.html', 'app.js', 'core.js', 'config.js', 'styles.css', 'sw.js'}


@contextmanager
def connect(path, timeout=30):
    db = sqlite3.connect(path, timeout=timeout)
    try:
        with db:
            yield db
    finally:
        db.close()


class GoogleProvider:
    def __init__(self, config):
        self.client = json.loads(Path(config['CLIENT_FILE']).read_text())
        self.client_id = self.client['web']['client_id']
        self.redirect_uri = config['ORIGIN'] + '/auth/callback'

    def flow(self, verifier, state=None):
        return Flow.from_client_config(self.client, scopes=SCOPES, state=state,
                                       redirect_uri=self.redirect_uri, code_verifier=verifier)

    def authorize(self, state, verifier, nonce):
        url, _ = self.flow(verifier).authorization_url(
            access_type='offline', prompt='consent', state=state, nonce=nonce,
            include_granted_scopes='false', code_challenge_method='S256',
            code_challenge=__import__('base64').urlsafe_b64encode(
                hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode())
        return url

    def exchange(self, code, verifier, nonce):
        flow = self.flow(verifier)
        flow.fetch_token(code=code, timeout=20)
        token = dict(flow.oauth2session.token)
        identity = verify_oauth2_token(token.get('id_token'), GoogleRequest(), self.client_id)
        if not hmac.compare_digest(str(identity.get('nonce', '')), nonce):
            raise ValueError('Invalid login nonce')
        if not identity.get('email_verified') or not identity.get('sub'):
            raise ValueError('Unverified identity')
        scopes = token.get('scope', [])
        if DRIVE_SCOPE not in (scopes.split() if isinstance(scopes, str) else scopes):
            raise ValueError('Drive permission required')
        r = requests.get('https://www.googleapis.com/drive/v3/about',
                         params={'fields': 'user(permissionId,emailAddress,displayName)'},
                         headers={'Authorization': 'Bearer ' + token['access_token']}, timeout=20)
        r.raise_for_status()
        user = r.json()['user']
        if not user.get('permissionId') or user.get('emailAddress', '').lower() != identity['email'].lower():
            raise ValueError('Account identity mismatch')
        return {**token, 'profile': {'id': user['permissionId'], 'email': identity['email'].lower(),
                                    'name': user.get('displayName', '')}}

    def refresh(self, credential):
        web = self.client['web']
        r = requests.post('https://oauth2.googleapis.com/token', data={
            'grant_type': 'refresh_token', 'refresh_token': credential['refresh_token'],
            'client_id': web['client_id'], 'client_secret': web['client_secret']}, timeout=20)
        if r.status_code in (400, 401):
            raise PermissionError('Google connection revoked')
        r.raise_for_status()
        token = r.json()
        if not token.get('access_token') or (token.get('scope') and DRIVE_SCOPE not in token['scope'].split()):
            raise PermissionError('Drive permission required')
        return {**credential, **token, 'expires_at': time.time() + int(token['expires_in'])}

    def revoke(self, token):
        r = requests.post('https://oauth2.googleapis.com/revoke', data={'token': token}, timeout=15)
        if r.status_code not in (200, 400):
            r.raise_for_status()


def create_app(config=None, provider=None):
    app = Flask(__name__, static_folder=None)
    app.config.update(
        ORIGIN=os.environ.get('CAMSYNC_ORIGIN', 'https://vid.skrrt.party'),
        CLIENT_FILE=os.environ.get('CAMSYNC_CLIENT_FILE', '/run/secrets/google-client.json'),
        KEY_FILE=os.environ.get('CAMSYNC_KEY_FILE', '/run/secrets/credential.key'),
        DB_FILE=os.environ.get('CAMSYNC_DB_FILE', '/data/auth.sqlite3'),
        WEB_ROOT=os.environ.get('CAMSYNC_WEB_ROOT', str(Path(__file__).resolve().parent.parent)),
        ALLOWED_EMAILS=os.environ.get('CAMSYNC_ALLOWED_EMAILS', '').lower().split(','),
        MAX_CONTENT_LENGTH=4096,
    )
    if config:
        app.config.update(config)
    if not any(app.config['ALLOWED_EMAILS']):
        raise ValueError('An explicit Google email allowlist is required')
    origin = app.config['ORIGIN']
    cipher = Fernet(Path(app.config['KEY_FILE']).read_bytes().strip())
    google = provider or GoogleProvider(app.config)
    db_path = app.config['DB_FILE']
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    with connect(db_path) as db:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, account TEXT, payload BLOB, expires REAL);
            CREATE TABLE IF NOT EXISTS logins (id TEXT PRIMARY KEY, payload BLOB, expires REAL);
        ''')
    os.chmod(db_path, 0o600)

    def digest(value):
        return hashlib.sha256(value.encode()).hexdigest()

    def pack(value):
        return cipher.encrypt(json.dumps(value).encode())

    def unpack(value):
        return json.loads(cipher.decrypt(value))

    def cookie(response, name, value, ttl):
        response.set_cookie(name, value, max_age=ttl, secure=True, httponly=True, samesite='Lax', path='/')
        return response

    def session():
        sid = request.cookies.get(SESSION_COOKIE, '')
        if not sid or len(sid) > 128:
            return None
        with connect(db_path) as db:
            row = db.execute('SELECT payload, expires FROM sessions WHERE id=?', (digest(sid),)).fetchone()
        if not row or row[1] <= time.time():
            return None
        data = unpack(row[0])
        if data['profile']['email'] not in app.config['ALLOWED_EMAILS']:
            return None
        return sid, data

    def csrf(data):
        if request.headers.get('Origin') != origin or not hmac.compare_digest(
                request.headers.get('X-CSRF-Token', ''), data['csrf']):
            abort(403)

    @app.after_request
    def headers(response):
        response.headers['Cache-Control'] = 'no-store'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['Content-Security-Policy'] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; media-src 'self' blob:; connect-src 'self' https://www.googleapis.com; "
            "worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        # The standalone recovery page has a self-contained script, hashed rather than allowing all inline JS.
        if request.path == '/update.html':
            import base64
            import re
            html = (Path(app.config['WEB_ROOT']) / 'update.html').read_text(encoding='utf-8')
            hashes = ' '.join("'sha256-" + base64.b64encode(hashlib.sha256(s.encode()).digest()).decode() + "'"
                              for s in re.findall(r'<script>([\s\S]*?)</script>', html))
            response.headers['Content-Security-Policy'] = response.headers['Content-Security-Policy'].replace(
                "script-src 'self'", "script-src 'self' " + hashes)
        return response

    @app.get('/auth/login')
    def login():
        # One short-lived, single-use login per browser cookie; state and PKCE bind the callback.
        state, verifier, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(64), secrets.token_urlsafe(32)
        with connect(db_path) as db:
            db.execute('DELETE FROM logins WHERE expires < ? OR id=?',
                       (time.time(), digest(request.cookies.get(STATE_COOKIE, ''))))
            db.execute('DELETE FROM sessions WHERE expires < ?', (time.time(),))
            db.execute('INSERT INTO logins VALUES (?,?,?)',
                       (digest(state), pack({'verifier': verifier, 'nonce': nonce}), time.time() + 600))
            db.execute('DELETE FROM logins WHERE id IN (SELECT id FROM logins ORDER BY expires DESC LIMIT -1 OFFSET 128)')
        return cookie(redirect(google.authorize(state, verifier, nonce), 303), STATE_COOKIE, state, 600)

    @app.get('/auth/callback')
    def callback():
        state = request.args.get('state', '')
        if not state or not hmac.compare_digest(state, request.cookies.get(STATE_COOKIE, '')):
            abort(400)
        with connect(db_path) as db:
            row = db.execute('DELETE FROM logins WHERE id=? RETURNING payload, expires', (digest(state),)).fetchone()
        if not row or row[1] <= time.time():
            abort(400)
        if request.args.get('error'):
            return cookie(redirect('/?auth_error=cancelled', 303), STATE_COOKIE, '', 0)
        try:
            pending = unpack(row[0])
            token = google.exchange(request.args.get('code', ''), pending['verifier'], pending['nonce'])
            if token['profile']['email'] not in app.config['ALLOWED_EMAILS']:
                # Do not revoke the grant: a denied account might be connected in another app session.
                return cookie(make_response('This Google account is not on the CamSync access list.', 403), STATE_COOKIE, '', 0)
            if not token.get('refresh_token'):
                raise ValueError('Offline Drive permission required')
            token['expires_at'] = float(token.get('expires_at') or time.time() + int(token['expires_in']))
            token['csrf'] = secrets.token_urlsafe(32)
            token.pop('id_token', None)
            sid = secrets.token_urlsafe(32)
            with connect(db_path) as db:
                old_sid = request.cookies.get(SESSION_COOKIE, '')
                db.execute('DELETE FROM sessions WHERE id=?', (digest(old_sid),))
                db.execute('INSERT INTO sessions VALUES (?,?,?,?)',
                           (digest(sid), token['profile']['id'], pack(token), time.time() + SESSION_TTL))
            # Refresh an older installed shell after sign-in without clearing phone storage.
            response = cookie(redirect('/update.html?connected=1', 303), SESSION_COOKIE, sid, SESSION_TTL)
            return cookie(response, STATE_COOKIE, '', 0)
        except Exception:
            # Never log Google's response, credentials, authorization codes, or callback query strings.
            return cookie(make_response('Google connection failed. Return to CamSync and try signing in again.', 502), STATE_COOKIE, '', 0)

    @app.get('/auth/session')
    def status():
        current = session()
        if not current:
            return jsonify(connected=False), 401
        sid, data = current
        # Status contains no bearer credentials. Refresh tokens never leave the VM.
        return cookie(jsonify(connected=True, profile=data['profile'], csrf=data['csrf']),
                      SESSION_COOKIE, sid, SESSION_TTL)

    @app.post('/auth/token')
    def token():
        current = session()
        if not current:
            abort(401)
        sid, data = current
        csrf(data)
        # Serialize refreshes from multiple app tabs/processes; no stale write can recreate a disconnected session.
        with connect(db_path, timeout=30) as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT payload FROM sessions WHERE id=?', (digest(sid),)).fetchone()
            if not row:
                abort(401)
            data = unpack(row[0])
            try:
                if data['expires_at'] < time.time() + 90 or request.json.get('force') is True:
                    data = google.refresh(data)
            except PermissionError:
                db.execute('DELETE FROM sessions WHERE account=?', (data['profile']['id'],))
                db.commit()
                return cookie(make_response(jsonify(connected=False), 401), SESSION_COOKIE, '', 0)
            except Exception:
                return jsonify(error='Google is temporarily unavailable. Try again shortly.'), 503
            db.execute('UPDATE sessions SET payload=?, expires=? WHERE id=?',
                       (pack(data), time.time() + SESSION_TTL, digest(sid)))
        response = jsonify(access_token=data['access_token'], expires_at=data['expires_at'], profile=data['profile'])
        return cookie(response, SESSION_COOKIE, sid, SESSION_TTL)

    @app.post('/auth/logout')
    def logout():
        if request.headers.get('Origin') != origin:
            abort(403)
        current = session()
        if current:
            sid, data = current
            csrf(data)
            with connect(db_path, timeout=30) as db:
                db.execute('DELETE FROM sessions WHERE account=?', (data['profile']['id'],))
            try:
                google.revoke(data['refresh_token'])
            except Exception:
                # Local service access is still removed if Google cannot be reached.
                pass
        return cookie(make_response('', 204), SESSION_COOKIE, '', 0)

    @app.get('/healthz')
    def health():
        return jsonify(ok=True)

    @app.get('/')
    @app.get('/<path:name>')
    def static(name='index.html'):
        if name not in APP_FILES | PUBLIC_FILES:
            abort(404)
        if name not in PUBLIC_FILES and not session():
            if name != 'index.html':
                abort(401)
            return make_response('''<!doctype html><html lang="en"><meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1"><title>CamSync — Sign in</title>
                <style>body{font:18px system-ui;background:#080808;color:#eee;max-width:26rem;margin:15vh auto;padding:24px}
                a{color:#8ab4f8} .button{display:inline-block;background:#fff;color:#222;padding:14px 22px;border-radius:12px;text-decoration:none}
                p{line-height:1.6}</style><h1>CamSync</h1><p>Private video recording and Google Drive backup.</p>
                <p>Sign in with an invited Google account to open CamSync. Your recordings stay on your phone and upload directly to your Drive.</p>
                <p><a class="button" href="/auth/login">Sign in with Google</a></p><p><a href="/privacy.html">Privacy details</a></p></html>''', 401)
        return send_from_directory(app.config['WEB_ROOT'], name)

    return app
