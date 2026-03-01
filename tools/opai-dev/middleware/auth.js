/**
 * OPAI Dev — Supabase JWT auth middleware (Express port of tools/shared/auth.py)
 *
 * Validates Bearer tokens via JWKS (RS256) or JWT_SECRET (HS256).
 * Enriches user with profile data from Supabase REST API.
 */

const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_JWKS_URL = process.env.SUPABASE_JWKS_URL ||
  (SUPABASE_URL ? `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` : '');
const AUTH_DISABLED = ['1', 'true', 'yes'].includes(
  (process.env.OPAI_AUTH_DISABLED || '').trim()
);

// JWKS client (caches keys internally)
const jwks = SUPABASE_JWKS_URL
  ? jwksClient({ jwksUri: SUPABASE_JWKS_URL, cache: true, cacheMaxAge: 3600000 })
  : null;

// Profile cache: { [userId]: { data, expiresAt } }
const profileCache = new Map();
const PROFILE_CACHE_TTL = 60_000; // 60s

// ── Token Decoding ───────────────────────────────────────

function getSigningKey(header, callback) {
  if (!jwks) return callback(new Error('No JWKS configured'));
  jwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function verifyWithJWKS(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(token, getSigningKey, { algorithms: ['RS256', 'ES256'], audience: 'authenticated' }, (err, decoded) => {
      if (err) return reject(err);
      resolve(decoded);
    });
  });
}

function verifyWithSecret(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(token, SUPABASE_JWT_SECRET, { algorithms: ['HS256'], audience: 'authenticated' }, (err, decoded) => {
      if (err) return reject(err);
      resolve(decoded);
    });
  });
}

async function decodeToken(token) {
  let payload = null;

  // Strategy 1: JWKS (RS256)
  if (jwks) {
    try {
      payload = await verifyWithJWKS(token);
    } catch (_) { /* fall through */ }
  }

  // Strategy 2: JWT Secret (HS256)
  if (!payload && SUPABASE_JWT_SECRET) {
    try {
      payload = await verifyWithSecret(token);
    } catch (_) { /* fall through */ }
  }

  if (!payload) {
    const err = new Error('Invalid or expired token');
    err.status = 401;
    throw err;
  }

  const appMetadata = payload.app_metadata || {};
  const userMetadata = payload.user_metadata || {};
  const email = payload.email || '';

  return {
    id: payload.sub || '',
    email,
    role: appMetadata.role || 'user',
    display_name: userMetadata.display_name || (email ? email.split('@')[0] : ''),
    is_active: true,
    allowed_apps: [],
    allowed_agents: [],
  };
}

// ── Profile Enrichment ───────────────────────────────────

async function fetchProfile(userId) {
  const cached = profileCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;

  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=is_active,allowed_apps,allowed_agents`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
        timeout: 5000,
      }
    );
    if (resp.ok) {
      const rows = await resp.json();
      if (rows.length > 0) {
        profileCache.set(userId, { data: rows[0], expiresAt: Date.now() + PROFILE_CACHE_TTL });
        return rows[0];
      }
    }
  } catch (_) { /* ignore */ }

  return null;
}

async function enrichUser(user) {
  const profile = await fetchProfile(user.id);
  if (profile) {
    user.is_active = profile.is_active !== false;
    user.allowed_apps = profile.allowed_apps || [];
    user.allowed_agents = profile.allowed_agents || [];
  }
  return user;
}

// ── Express Middleware ────────────────────────────────────

const DEV_USER = {
  id: '1c93c5fe-d304-40f2-9169-765d0d2b7638',
  email: 'dalwaut@gmail.com',
  role: 'admin',
  display_name: 'Dallas',
  is_active: true,
  allowed_apps: [],
  allowed_agents: [],
};

async function requireAuth(req, res, next) {
  if (AUTH_DISABLED) {
    req.user = DEV_USER;
    return next();
  }

  // Extract token from Authorization header or opai_dev_token cookie
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const [scheme, t] = authHeader.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && t) token = t;
  }

  // Fallback: cookie-based auth (for browser navigations like IDE proxy)
  if (!token && req.headers.cookie) {
    const match = req.headers.cookie.match(/(?:^|;\s*)opai_dev_token=([^;]+)/);
    if (match) token = decodeURIComponent(match[1]);
  }

  if (!token) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    let user = await decodeToken(token);
    user = await enrichUser(user);

    if (!user.is_active && user.role !== 'admin') {
      return res.status(403).json({ error: 'Account is disabled' });
    }

    // Check app access
    if (user.role !== 'admin' && user.allowed_apps && !user.allowed_apps.includes('dev')) {
      return res.status(403).json({ error: 'No access to OPAI Dev' });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message || 'Authentication failed' });
  }
}

/**
 * Authenticate a raw token string (for WebSocket upgrade).
 * Returns user object or throws.
 */
async function authenticateToken(token) {
  if (AUTH_DISABLED) return DEV_USER;

  let user = await decodeToken(token);
  user = await enrichUser(user);

  if (!user.is_active && user.role !== 'admin') {
    throw Object.assign(new Error('Account is disabled'), { status: 403 });
  }

  if (user.role !== 'admin' && user.allowed_apps && !user.allowed_apps.includes('dev')) {
    throw Object.assign(new Error('No access to OPAI Dev'), { status: 403 });
  }

  return user;
}

module.exports = { requireAuth, authenticateToken, decodeToken, AUTH_DISABLED, DEV_USER };
