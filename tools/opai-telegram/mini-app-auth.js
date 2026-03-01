/**
 * Mini App Auth — Telegram WebApp initData validation + session tokens.
 *
 * Flow:
 *   1. Mini App opens -> Telegram injects initData (signed by Telegram)
 *   2. Mini App POST /telegram/auth with { initData }
 *   3. Server validates HMAC-SHA256 signature using BOT_TOKEN
 *   4. Maps Telegram user -> OPAI role via access-control.js
 *   5. Issues short-lived session token (1 hour)
 *   6. Mini App uses token for all /telegram/api/* calls
 *
 * Token format: { telegramId, role, name, iat, exp } signed with local secret.
 */

const crypto = require('crypto');
const { getUserRole } = require('./access-control');

// Session secret — generated once per process lifetime.
// Not persisted (tokens invalidate on restart, which is fine for 1h sessions).
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

// Active sessions: token -> { telegramId, role, name, exp }
const sessions = new Map();

// Cleanup expired sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.exp < now) sessions.delete(token);
  }
}, 10 * 60 * 1000);

// --- initData Validation ---

/**
 * Validate Telegram WebApp initData.
 * @see https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * @param {string} initData - Raw initData string from Telegram WebApp
 * @param {string} botToken - Bot token from BotFather
 * @returns {{ valid: boolean, user?: object, error?: string }}
 */
function validateInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { valid: false, error: 'Missing hash' };

    // Remove hash from params for verification
    params.delete('hash');

    // Sort params alphabetically and join with newlines
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    // Create secret key: HMAC-SHA256("WebAppData", botToken)
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    // Calculate expected hash: HMAC-SHA256(secretKey, dataCheckString)
    const expected = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (hash !== expected) {
      return { valid: false, error: 'Invalid signature' };
    }

    // Check auth_date freshness (reject if older than 5 minutes)
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > 300) {
      return { valid: false, error: 'initData expired (>5 min)' };
    }

    // Parse user info
    const userStr = params.get('user');
    if (!userStr) return { valid: false, error: 'No user data' };

    const user = JSON.parse(userStr);
    return { valid: true, user };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

// --- Session Token Management ---

/**
 * Create a session token for a validated Telegram user.
 * @param {number} telegramId
 * @param {string} role - OPAI role
 * @param {string} name - Display name
 * @param {number} [ttlMs=3600000] - Token lifetime (default 1 hour)
 * @returns {string} Session token
 */
function createSession(telegramId, role, name, ttlMs = 3600000) {
  const payload = {
    telegramId,
    role,
    name,
    iat: Date.now(),
    exp: Date.now() + ttlMs,
  };

  // Create HMAC signature
  const data = JSON.stringify(payload);
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(data)
    .digest('hex');

  const token = Buffer.from(data).toString('base64url') + '.' + sig;
  sessions.set(token, payload);
  return token;
}

/**
 * Validate a session token.
 * @param {string} token
 * @returns {{ valid: boolean, session?: object, error?: string }}
 */
function validateSession(token) {
  if (!token) return { valid: false, error: 'No token' };

  // Check in-memory cache first (fast path)
  const cached = sessions.get(token);
  if (cached) {
    if (cached.exp < Date.now()) {
      sessions.delete(token);
      return { valid: false, error: 'Token expired' };
    }
    return { valid: true, session: cached };
  }

  // Verify signature (for tokens from a previous check cycle)
  try {
    const [dataB64, sig] = token.split('.');
    if (!dataB64 || !sig) return { valid: false, error: 'Malformed token' };

    const data = Buffer.from(dataB64, 'base64url').toString();
    const expected = crypto
      .createHmac('sha256', SESSION_SECRET)
      .update(data)
      .digest('hex');

    if (sig !== expected) return { valid: false, error: 'Invalid signature' };

    const payload = JSON.parse(data);
    if (payload.exp < Date.now()) return { valid: false, error: 'Token expired' };

    // Re-cache
    sessions.set(token, payload);
    return { valid: true, session: payload };
  } catch {
    return { valid: false, error: 'Invalid token' };
  }
}

// --- Express Middleware ---

/**
 * Express middleware that validates Mini App session tokens.
 * Sets req.miniAppUser = { telegramId, role, name } on success.
 */
function requireMiniAppAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  const token = authHeader.substring(7);
  const result = validateSession(token);

  if (!result.valid) {
    return res.status(401).json({ error: result.error });
  }

  req.miniAppUser = result.session;
  next();
}

/**
 * Express middleware that requires admin role.
 */
function requireAdmin(req, res, next) {
  if (!req.miniAppUser) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (req.miniAppUser.role !== 'owner' && req.miniAppUser.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// --- Auth Endpoint Handler ---

/**
 * Handle POST /telegram/auth
 * @param {string} botToken
 */
function createAuthHandler(botToken) {
  return (req, res) => {
    const { initData, initDataUnsafe } = req.body;

    let telegramUser;

    if (initData) {
      // Primary path: cryptographic validation of signed initData
      const validation = validateInitData(initData, botToken);
      if (!validation.valid) {
        console.log(`[TG] [AUTH] Rejected: ${validation.error}`);
        return res.status(401).json({ error: validation.error });
      }
      telegramUser = validation.user;
    } else if (initDataUnsafe && initDataUnsafe.user && initDataUnsafe.user.id) {
      // Fallback for tdesktop: initData is empty but initDataUnsafe has user info.
      // No signature verification — trust is based on whitelist + localhost-only proxy.
      console.log(`[TG] [AUTH] Using initDataUnsafe fallback (platform likely tdesktop)`);
      telegramUser = initDataUnsafe.user;
    } else {
      return res.status(400).json({ error: 'Missing initData' });
    }

    const telegramId = telegramUser.id;
    const name = telegramUser.first_name || telegramUser.username || String(telegramId);

    // Map to OPAI role
    const role = getUserRole(telegramId);
    if (!role) {
      console.log(`[TG] [AUTH] Rejected: user ${telegramId} (${name}) not whitelisted`);
      return res.status(403).json({ error: 'Not authorized. Contact admin for access.' });
    }

    // Create session token
    const token = createSession(telegramId, role, name);

    const method = initData ? 'signed' : 'unsafe-fallback';
    console.log(`[TG] [AUTH] Session created for ${name} (${telegramId}, role: ${role}, method: ${method})`);

    res.json({
      token,
      user: {
        telegramId,
        name,
        role,
        isAdmin: role === 'owner' || role === 'admin',
      },
    });
  };
}

module.exports = {
  validateInitData,
  createSession,
  validateSession,
  requireMiniAppAuth,
  requireAdmin,
  createAuthHandler,
};
