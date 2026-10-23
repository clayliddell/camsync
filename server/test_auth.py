import json
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from cryptography.fernet import Fernet
from app import connect, create_app, GoogleProvider, STATE_COOKIE, SESSION_COOKIE, DRIVE_SCOPE

ORIGIN = 'https://vid.skrrt.party'


class Provider:
    email = 'owner@example.com'
    refreshed = 0
    revoked = False
    denied = False

    def authorize(self, state, verifier, nonce):
        self.verifier, self.nonce = verifier, nonce
        return 'https://accounts.google.com/auth?state=' + state

    def exchange(self, code, verifier, nonce):
        assert code == 'test-code' and verifier == self.verifier and nonce == self.nonce
        return {'access_token': 'private-access', 'refresh_token': 'private-refresh',
                'expires_in': 3600, 'scope': DRIVE_SCOPE,
                'profile': {'id': 'drive-owner', 'email': self.email, 'name': 'Owner'}}

    def refresh(self, data):
        if self.denied:
            raise PermissionError()
        self.refreshed += 1
        return {**data, 'access_token': 'refreshed-access', 'expires_at': time.time() + 3600}

    def revoke(self, token):
        self.revoked = token == 'private-refresh'


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)
        (self.path / 'key').write_bytes(Fernet.generate_key())
        self.provider = Provider()
        self.config = {'TESTING': True, 'ORIGIN': ORIGIN, 'KEY_FILE': str(self.path / 'key'),
                       'DB_FILE': str(self.path / 'auth.db'), 'ALLOWED_EMAILS': ['owner@example.com'],
                       'WEB_ROOT': str(Path(__file__).resolve().parent.parent)}
        self.app = create_app(self.config, self.provider)
        self.client = self.app.test_client()

    def tearDown(self):
        self.temp.cleanup()

    def get(self, path):
        response = self.client.get(path, base_url=ORIGIN)
        response.get_data()
        response.close()
        return response

    def post(self, path, csrf=None, origin=ORIGIN, **kwargs):
        return self.client.post(path, base_url=ORIGIN, json=kwargs.get('json', {}),
                                headers={'Origin': origin, 'X-CSRF-Token': csrf or ''})

    def connect(self):
        r = self.get('/auth/login')
        state = parse_qs(urlparse(r.location).query)['state'][0]
        result = self.get('/auth/callback?code=test-code&state=' + state)
        return result, state

    def test_private_shell_and_static_allowlist(self):
        self.assertEqual(self.get('/').status_code, 401)
        self.assertIn(b'Sign in with Google', self.get('/').data)
        for path in ['/app.js', '/zoom.js', '/sw.js']:
            self.assertEqual(self.get(path).status_code, 401)
        for path in ['/server/app.py', '/.git/config', '/package.json', '/.env', '/etc/passwd']:
            self.assertEqual(self.get(path).status_code, 404)
        self.assertEqual(self.get('/privacy.html').status_code, 200)
        self.assertEqual(self.get('/auth/session').status_code, 401)

    def test_state_cookie_pkce_nonce_and_single_use_callback(self):
        r, state = self.connect()
        self.assertEqual(r.status_code, 303)
        self.assertEqual(r.location, '/update.html?connected=1')
        self.assertEqual(self.get('/auth/callback?code=test-code&state=' + state).status_code, 400)
        self.assertEqual(self.get('/auth/callback?code=test-code&state=attacker').status_code, 400)
        self.assertGreaterEqual(len(self.provider.verifier), 43)
        self.assertEqual(self.get('/').status_code, 200)

    def test_invitation_list_denies_other_verified_google_accounts(self):
        self.provider.email = 'uninvited@example.com'
        r, _ = self.connect()
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.get('/auth/session').status_code, 401)
        with connect(self.config['DB_FILE']) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0], 0)

    def test_secure_cookie_encrypted_credentials_and_session_survives_restart(self):
        r, _ = self.connect()
        cookie = next(s for s in r.headers.getlist('Set-Cookie') if s.startswith(SESSION_COOKIE))
        for value in ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=7776000']:
            self.assertIn(value, cookie)
        with connect(self.config['DB_FILE']) as db:
            blob = db.execute('SELECT payload FROM sessions').fetchone()[0]
            self.assertNotIn(b'private-refresh', blob)
            self.assertNotIn(b'private-access', blob)
        sid = self.client.get_cookie(SESSION_COOKIE, domain='vid.skrrt.party').value
        restarted = create_app(self.config, self.provider).test_client()
        restarted.set_cookie(SESSION_COOKIE, sid, domain='vid.skrrt.party')
        status = restarted.get('/auth/session', base_url=ORIGIN)
        self.assertTrue(status.json['connected'])
        self.assertNotIn('access_token', status.json)
        self.assertNotIn('refresh_token', status.json)
        self.assertEqual(status.headers['Cache-Control'], 'no-store')

    def test_csrf_and_origin_required_for_token_and_disconnect(self):
        self.connect()
        csrf = self.get('/auth/session').json['csrf']
        for path in ['/auth/token', '/auth/logout']:
            self.assertEqual(self.post(path).status_code, 403)
            self.assertEqual(self.post(path, csrf, 'https://other.example').status_code, 403)
        r = self.post('/auth/token', csrf)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json['access_token'], 'private-access')
        self.assertNotIn('refresh_token', r.json)
        self.assertEqual(r.headers['Cache-Control'], 'no-store')

    def test_expired_access_refreshes_and_revocation_clears_session(self):
        self.connect()
        csrf = self.get('/auth/session').json['csrf']
        r = self.post('/auth/token', csrf, json={'force': True})
        self.assertEqual(r.json['access_token'], 'refreshed-access')
        self.assertEqual(self.provider.refreshed, 1)
        self.provider.denied = True
        self.assertEqual(self.post('/auth/token', csrf, json={'force': True}).status_code, 401)
        self.assertEqual(self.get('/auth/session').status_code, 401)

    def test_disconnect_deletes_credentials_and_blocks_reopen(self):
        self.connect()
        csrf = self.get('/auth/session').json['csrf']
        self.assertEqual(self.post('/auth/logout', csrf).status_code, 204)
        self.assertTrue(self.provider.revoked)
        self.assertEqual(self.get('/auth/session').status_code, 401)
        with connect(self.config['DB_FILE']) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0], 0)

    def test_expired_session_or_removed_allowlist_blocks_access(self):
        self.connect()
        with connect(self.config['DB_FILE']) as db:
            db.execute('UPDATE sessions SET expires=?', (time.time() - 1,))
        self.assertEqual(self.get('/auth/session').status_code, 401)
        self.connect()
        self.app.config['ALLOWED_EMAILS'] = ['someone-else@example.com']
        self.assertEqual(self.get('/auth/session').status_code, 401)

    def test_google_url_requests_offline_access_with_pkce_and_exact_callback(self):
        client = self.path / 'client.json'
        client.write_text(json.dumps({'web': {'client_id': 'test.apps.googleusercontent.com',
                         'client_secret': 'test-secret', 'auth_uri': 'https://accounts.google.com/o/oauth2/auth',
                         'token_uri': 'https://oauth2.googleapis.com/token'}}))
        google = GoogleProvider({**self.config, 'CLIENT_FILE': str(client)})
        query = parse_qs(urlparse(google.authorize('random-state', 'v' * 64, 'nonce')).query)
        self.assertEqual(query['access_type'], ['offline'])
        self.assertEqual(query['code_challenge_method'], ['S256'])
        self.assertEqual(query['redirect_uri'], [ORIGIN + '/auth/callback'])
        self.assertIn(DRIVE_SCOPE, query['scope'][0].split())
        self.assertEqual(query['nonce'], ['nonce'])


if __name__ == '__main__':
    unittest.main()
