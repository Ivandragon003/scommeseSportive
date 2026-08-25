const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  createPasswordHash,
  createSharedAdminAuth,
  isLoopbackAddress,
  loadSharedAdminAuthConfig,
  verifyPassword,
} = require('../dist/security/SharedAdminAuth.js');

class MemorySessionStore {
  constructor() {
    this.sessions = new Map();
  }

  async createAdminSession(sessionHash, expiresAt) {
    this.sessions.set(sessionHash, { expiresAt });
  }

  async getAdminSession(sessionHash) {
    return this.sessions.get(sessionHash) ?? null;
  }

  async deleteAdminSession(sessionHash) {
    this.sessions.delete(sessionHash);
  }

  async purgeExpiredAdminSessions(nowIso) {
    const now = Date.parse(nowIso);
    for (const [key, session] of this.sessions.entries()) {
      if (Date.parse(session.expiresAt) <= now) this.sessions.delete(key);
    }
  }
}

const startServer = async (options = {}) => {
  const store = options.store ?? new MemorySessionStore();
  const passwordHash = options.passwordHash ?? await createPasswordHash('shared-secret', {
    salt: Buffer.from('0123456789abcdef', 'utf8'),
  });
  const auth = createSharedAdminAuth({
    enabled: true,
    passwordHash,
    sharedDataUserId: 'user1',
    sessionStore: store,
    secureCookies: options.secureCookies ?? false,
    sessionTtlMs: options.sessionTtlMs ?? 60_000,
    maxLoginAttempts: options.maxLoginAttempts ?? 3,
    loginWindowMs: 60_000,
    maxTrackedLoginIps: options.maxTrackedLoginIps ?? 100,
    internalAccessToken: 'internal-only-token-that-is-long-enough',
    allowedOrigins: new Set(['https://localhost', 'https://scommese-sportive-frontend.hostless.site']),
  });

  const app = express();
  if (options.trustProxy) app.set('trust proxy', 1);
  app.use(express.json());
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api', auth.publicRouter);
  app.use('/api', auth.requireAdmin);
  app.get('/api/private', (_req, res) => {
    res.json({ sharedDataUserId: res.locals.sharedDataUserId });
  });
  app.post('/api/private', (_req, res) => {
    res.json({ sharedDataUserId: res.locals.sharedDataUserId });
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/api`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

test('scrypt hash verifies the right password and rejects a wrong one', async () => {
  const encoded = await createPasswordHash('correct horse battery staple', {
    salt: Buffer.from('0123456789abcdef', 'utf8'),
  });

  assert.match(encoded, /^scrypt\$/);
  assert.equal(await verifyPassword('correct horse battery staple', encoded), true);
  assert.equal(await verifyPassword('wrong password', encoded), false);
  assert.equal(await verifyPassword('anything', 'not-a-valid-hash'), false);
});

test('login creates an HttpOnly session that authorizes the shared user', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const anonymous = await fetch(`${baseUrl}/private`);
    assert.equal(anonymous.status, 401);

    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://localhost' },
      body: JSON.stringify({ password: 'shared-secret' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /fp_admin_session=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.doesNotMatch(cookie, /shared-secret/);

    const session = await fetch(`${baseUrl}/auth/session`, { headers: { cookie } });
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), {
      success: true,
      data: { authenticated: true, sharedDataUserId: 'user1' },
    });

    const authorized = await fetch(`${baseUrl}/private`, { headers: { cookie } });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), { sharedDataUserId: 'user1' });

    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { cookie, origin: 'https://localhost' },
    });
    assert.equal(logout.status, 204);
    const afterLogout = await fetch(`${baseUrl}/private`, { headers: { cookie } });
    assert.equal(afterLogout.status, 401);
  } finally {
    await close();
  }
});

test('production cookies are secure, partitioned and never cache auth responses', async () => {
  const { baseUrl, close } = await startServer({ secureCookies: true });
  try {
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://localhost' },
      body: JSON.stringify({ password: 'shared-secret' }),
    });

    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /Secure/i);
    assert.match(login.headers.get('set-cookie'), /SameSite=None/i);
    assert.match(login.headers.get('set-cookie'), /Partitioned/i);
    assert.equal(login.headers.get('cache-control'), 'no-store');
  } finally {
    await close();
  }
});

test('invalid login stays generic and becomes rate limited', async () => {
  const { baseUrl, close } = await startServer({ maxLoginAttempts: 2 });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://localhost' },
        body: JSON.stringify({ password: 'wrong' }),
      });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, 'Credenziali non valide.');
    }

    const limited = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://localhost' },
      body: JSON.stringify({ password: 'shared-secret' }),
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  } finally {
    await close();
  }
});

test('unsafe browser requests reject hostile origins and accept configured origins', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const hostileLogin = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ password: 'shared-secret' }),
    });
    assert.equal(hostileLogin.status, 403);

    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://localhost' },
      body: JSON.stringify({ password: 'shared-secret' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');

    const missingOriginMutation = await fetch(`${baseUrl}/private`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(missingOriginMutation.status, 403);

    const hostileMutation = await fetch(`${baseUrl}/private`, {
      method: 'POST',
      headers: { cookie, origin: 'https://attacker.example' },
    });
    assert.equal(hostileMutation.status, 403);

    const allowedMutation = await fetch(`${baseUrl}/private`, {
      method: 'POST',
      headers: { cookie, origin: 'https://localhost' },
    });
    assert.equal(allowedMutation.status, 200);
  } finally {
    await close();
  }
});

test('login attempt tracking remains bounded across many proxy client IPs', async () => {
  const { baseUrl, close } = await startServer({
    trustProxy: true,
    maxLoginAttempts: 1,
    maxTrackedLoginIps: 2,
  });
  try {
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': ip,
          origin: 'https://localhost',
        },
        body: JSON.stringify({ password: 'wrong' }),
      });
      assert.equal(response.status, 401);
    }

    const evictedIpCanRetry = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.1',
        origin: 'https://localhost',
      },
      body: JSON.stringify({ password: 'shared-secret' }),
    });
    assert.equal(evictedIpCanRetry.status, 200);
  } finally {
    await close();
  }
});

test('only literal loopback socket addresses qualify for the internal bypass', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('10.0.0.4'), false);
  assert.equal(isLoopbackAddress('198.51.100.1'), false);
});

test('the private middleware accepts only the process-internal token bypass', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const wrong = await fetch(`${baseUrl}/private`, {
      headers: { 'x-internal-admin-token': 'wrong' },
    });
    assert.equal(wrong.status, 401);

    const internal = await fetch(`${baseUrl}/private`, {
      headers: { 'x-internal-admin-token': 'internal-only-token-that-is-long-enough' },
    });
    assert.equal(internal.status, 200);
    assert.deepEqual(await internal.json(), { sharedDataUserId: 'user1' });

    const internalMutation = await fetch(`${baseUrl}/private`, {
      method: 'POST',
      headers: { 'x-internal-admin-token': 'internal-only-token-that-is-long-enough' },
    });
    assert.equal(internalMutation.status, 200);
  } finally {
    await close();
  }
});

test('login and logout reject mutation requests without an allowed Origin', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'shared-secret' }),
    });
    assert.equal(login.status, 403);

    const logout = await fetch(`${baseUrl}/auth/logout`, { method: 'POST' });
    assert.equal(logout.status, 403);
  } finally {
    await close();
  }
});

test('production configuration fails closed when the password hash is missing', () => {
  assert.throws(
    () => loadSharedAdminAuthConfig({}),
    /SHARED_ADMIN_PASSWORD_HASH/,
  );
  assert.throws(
    () => loadSharedAdminAuthConfig({ NODE_ENV: 'production' }),
    /SHARED_ADMIN_PASSWORD_HASH/,
  );

  const config = loadSharedAdminAuthConfig({
    NODE_ENV: 'production',
    SHARED_ADMIN_PASSWORD_HASH: 'scrypt$16384$8$1$AA==$AA==',
    SHARED_DATA_USER_ID: 'shared-bankroll',
  });
  assert.equal(config.enabled, true);
  assert.equal(config.secureCookies, true);
  assert.equal(config.sharedDataUserId, 'shared-bankroll');

  const localOptOut = loadSharedAdminAuthConfig({ SHARED_ADMIN_AUTH_ENABLED: 'false' });
  assert.equal(localOptOut.enabled, false);
});
