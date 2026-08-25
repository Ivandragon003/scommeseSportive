import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { NextFunction, Request, Response, Router } from 'express';

const COOKIE_NAME = 'fp_admin_session';
const DEFAULT_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_LOGIN_ATTEMPTS = 5;
const DEFAULT_MAX_TRACKED_LOGIN_IPS = 5_000;
const MAX_PASSWORD_LENGTH = 256;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

export interface AdminSessionStore {
  createAdminSession(sessionHash: string, expiresAt: string): Promise<void>;
  getAdminSession(sessionHash: string): Promise<{ expiresAt?: string; expires_at?: string } | null>;
  deleteAdminSession(sessionHash: string): Promise<void>;
  purgeExpiredAdminSessions(nowIso: string): Promise<void>;
}

export interface SharedAdminAuthConfig {
  enabled: boolean;
  passwordHash: string;
  sharedDataUserId: string;
  secureCookies: boolean;
  sessionTtlMs: number;
  loginWindowMs: number;
  maxLoginAttempts: number;
  maxTrackedLoginIps: number;
}

export interface SharedAdminAuthOptions extends SharedAdminAuthConfig {
  sessionStore: AdminSessionStore;
  internalAccessToken?: string;
  allowedOrigins: ReadonlySet<string>;
}

type AttemptState = { count: number; resetAt: number };

const deriveScrypt = (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> => new Promise((resolve, reject) => {
  nodeScrypt(password, salt, keyLength, options, (error, derivedKey) => {
    if (error) reject(error);
    else resolve(derivedKey);
  });
});

const positiveInteger = (value: unknown, fallback: number): number => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const loadSharedAdminAuthConfig = (
  env: Record<string, string | undefined> = process.env,
): SharedAdminAuthConfig => {
  const production = String(env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
  const requestedState = String(env.SHARED_ADMIN_AUTH_ENABLED ?? '').trim().toLowerCase();
  const enabled = production || requestedState !== 'false';
  const passwordHash = String(env.SHARED_ADMIN_PASSWORD_HASH ?? '').trim();

  if (enabled && !passwordHash) {
    throw new Error('SHARED_ADMIN_PASSWORD_HASH is required when shared admin authentication is enabled.');
  }

  return {
    enabled,
    passwordHash,
    sharedDataUserId: String(env.SHARED_DATA_USER_ID ?? 'user1').trim() || 'user1',
    secureCookies: production,
    sessionTtlMs: positiveInteger(env.SHARED_ADMIN_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS),
    loginWindowMs: positiveInteger(env.SHARED_ADMIN_LOGIN_WINDOW_MS, DEFAULT_LOGIN_WINDOW_MS),
    maxLoginAttempts: positiveInteger(env.SHARED_ADMIN_MAX_LOGIN_ATTEMPTS, DEFAULT_MAX_LOGIN_ATTEMPTS),
    maxTrackedLoginIps: positiveInteger(env.SHARED_ADMIN_MAX_TRACKED_LOGIN_IPS, DEFAULT_MAX_TRACKED_LOGIN_IPS),
  };
};

export const createPasswordHash = async (
  password: string,
  options: { salt?: Buffer } = {},
): Promise<string> => {
  if (String(password ?? '').length < 12) {
    throw new Error('La password condivisa deve contenere almeno 12 caratteri.');
  }
  const salt = options.salt ?? randomBytes(16);
  const derived = await deriveScrypt(String(password), salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    'scrypt',
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
};

export const verifyPassword = async (password: string, encodedHash: string): Promise<boolean> => {
  try {
    const [algorithm, nRaw, rRaw, pRaw, saltRaw, expectedRaw, ...rest] = String(encodedHash ?? '').split('$');
    if (algorithm !== 'scrypt' || rest.length > 0 || !saltRaw || !expectedRaw) return false;
    const N = positiveInteger(nRaw, 0);
    const r = positiveInteger(rRaw, 0);
    const p = positiveInteger(pRaw, 0);
    if (N < 16_384 || r < 8 || p < 1) return false;
    const salt = Buffer.from(saltRaw, 'base64');
    const expected = Buffer.from(expectedRaw, 'base64');
    if (salt.length < 16 || expected.length < 32) return false;
    const derived = await deriveScrypt(String(password ?? ''), salt, expected.length, {
      N,
      r,
      p,
      maxmem: Math.max(64 * 1024 * 1024, 128 * N * r + 1024 * 1024),
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
};

const hashSessionToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

const readCookie = (request: Request, name: string): string | null => {
  const header = String(request.headers.cookie ?? '');
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
};

const safeTokenEquals = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

export const isLoopbackAddress = (value: unknown): boolean => {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1';
};

export const createSharedAdminAuth = (options: SharedAdminAuthOptions) => {
  const publicRouter = Router();
  const attempts = new Map<string, AttemptState>();
  const sameSite = options.secureCookies ? 'none' as const : 'lax' as const;
  const cookieOptions = {
    httpOnly: true,
    secure: options.secureCookies,
    sameSite,
    partitioned: options.secureCookies,
    path: '/api',
    maxAge: options.sessionTtlMs,
  };

  const isUnsafeMethod = (req: Request): boolean =>
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase());

  const isTrustedInternalRequest = (req: Request): boolean => {
    const suppliedInternalToken = String(req.header('x-internal-admin-token') ?? '');
    return Boolean(
      options.internalAccessToken
      && suppliedInternalToken
      && isLoopbackAddress(req.socket.remoteAddress)
      && safeTokenEquals(suppliedInternalToken, options.internalAccessToken)
    );
  };

  const hasAllowedOrigin = (req: Request): boolean => {
    const origin = String(req.header('origin') ?? '').trim();
    return Boolean(origin && options.allowedOrigins.has(origin));
  };

  publicRouter.use('/auth', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (isUnsafeMethod(_req) && !hasAllowedOrigin(_req)) {
      res.status(403).json({ success: false, error: 'Origine richiesta non autorizzata.' });
      return;
    }
    next();
  });

  const authenticateRequest = async (req: Request): Promise<boolean> => {
    if (!options.enabled) return true;

    if (isTrustedInternalRequest(req)) return true;

    const token = readCookie(req, COOKIE_NAME);
    if (!token) return false;
    const sessionHash = hashSessionToken(token);
    const session = await options.sessionStore.getAdminSession(sessionHash);
    if (!session) return false;
    const expiresAt = String(session.expiresAt ?? session.expires_at ?? '');
    if (!expiresAt || Date.parse(expiresAt) <= Date.now()) {
      await options.sessionStore.deleteAdminSession(sessionHash).catch(() => undefined);
      return false;
    }
    return true;
  };

  const sendUnauthorized = (res: Response): Response =>
    res.status(401).json({ success: false, error: 'Autenticazione richiesta.' });

  publicRouter.get('/auth/session', async (req, res) => {
    try {
      if (!await authenticateRequest(req)) return sendUnauthorized(res);
      return res.json({
        success: true,
        data: { authenticated: true, sharedDataUserId: options.sharedDataUserId },
      });
    } catch {
      return sendUnauthorized(res);
    }
  });

  publicRouter.post('/auth/login', async (req, res) => {
    if (!options.enabled) {
      return res.json({
        success: true,
        data: { authenticated: true, sharedDataUserId: options.sharedDataUserId },
      });
    }

    const now = Date.now();
    const key = String(req.ip || req.socket.remoteAddress || 'unknown');
    for (const [trackedKey, state] of attempts) {
      if (state.resetAt <= now) attempts.delete(trackedKey);
    }
    if (!attempts.has(key) && attempts.size >= options.maxTrackedLoginIps) {
      const oldestKey = attempts.keys().next().value;
      if (oldestKey) attempts.delete(oldestKey);
    }
    const current = attempts.get(key);
    if (current && current.resetAt > now && current.count >= options.maxLoginAttempts) {
      const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ success: false, error: 'Troppi tentativi. Riprova più tardi.' });
    }
    if (current && current.resetAt <= now) attempts.delete(key);

    const suppliedPassword = String(req.body?.password ?? '');
    const valid = suppliedPassword.length <= MAX_PASSWORD_LENGTH
      && await verifyPassword(suppliedPassword, options.passwordHash);
    if (!valid) {
      const next = attempts.get(key);
      attempts.set(key, {
        count: (next?.count ?? 0) + 1,
        resetAt: next?.resetAt && next.resetAt > now ? next.resetAt : now + options.loginWindowMs,
      });
      return res.status(401).json({ success: false, error: 'Credenziali non valide.' });
    }

    attempts.delete(key);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now + options.sessionTtlMs).toISOString();
    await options.sessionStore.purgeExpiredAdminSessions(new Date(now).toISOString()).catch(() => undefined);
    await options.sessionStore.createAdminSession(hashSessionToken(token), expiresAt);
    res.cookie(COOKIE_NAME, token, cookieOptions);
    return res.json({
      success: true,
      data: { authenticated: true, sharedDataUserId: options.sharedDataUserId },
    });
  });

  publicRouter.post('/auth/logout', async (req, res) => {
    const token = readCookie(req, COOKIE_NAME);
    if (token) {
      await options.sessionStore.deleteAdminSession(hashSessionToken(token)).catch(() => undefined);
    }
    res.clearCookie(COOKIE_NAME, {
      httpOnly: true,
      secure: options.secureCookies,
      sameSite,
      partitioned: options.secureCookies,
      path: '/api',
    });
    return res.status(204).send();
  });

  const requireAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (isUnsafeMethod(req) && !hasAllowedOrigin(req) && !isTrustedInternalRequest(req)) {
        res.status(403).json({ success: false, error: 'Origine richiesta non autorizzata.' });
        return;
      }
      if (!await authenticateRequest(req)) {
        sendUnauthorized(res);
        return;
      }
      res.locals.sharedDataUserId = options.sharedDataUserId;
      next();
    } catch {
      sendUnauthorized(res);
    }
  };

  return { publicRouter, requireAdmin };
};
