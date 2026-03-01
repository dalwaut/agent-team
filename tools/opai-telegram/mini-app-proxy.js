/**
 * Mini App API Proxy — Routes authenticated Mini App requests to internal OPAI services.
 *
 * Strips the /telegram/api/ prefix and forwards to the appropriate backend:
 *   /telegram/api/wp/*  -> http://127.0.0.1:8096/api/*  (OP WordPress)
 *   /telegram/api/hub/* -> http://127.0.0.1:8089/api/*  (Team Hub)
 *
 * Adds service-level auth (Supabase service key for WordPress, none for Team Hub).
 */

const http = require('http');

const BACKENDS = {
  wp: {
    host: '127.0.0.1',
    port: 8096,
    pathPrefix: '/api',
    auth: () => process.env.SUPABASE_SERVICE_KEY || '',
  },
  hub: {
    host: '127.0.0.1',
    port: 8089,
    pathPrefix: '/api/internal',
    auth: () => null, // No auth needed (localhost)
  },
};

/**
 * Create an Express handler that proxies Mini App API requests.
 */
function createProxyHandler() {
  return (req, res) => {
    // Parse: /telegram/api/{backend}/{rest}
    const fullPath = req.path; // e.g., /telegram/api/wp/sites
    const match = fullPath.match(/^\/telegram\/api\/(\w+)\/?(.*)/);

    if (!match) {
      return res.status(400).json({ error: 'Invalid API path' });
    }

    const backendKey = match[1];
    const restPath = match[2] ? '/' + match[2] : '';
    const backend = BACKENDS[backendKey];

    if (!backend) {
      return res.status(404).json({ error: `Unknown backend: ${backendKey}` });
    }

    const targetPath = backend.pathPrefix + restPath;
    const queryString = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';

    const options = {
      hostname: backend.host,
      port: backend.port,
      path: targetPath + queryString,
      method: req.method,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    // Add service auth if needed
    const authToken = backend.auth();
    if (authToken) {
      options.headers['Authorization'] = `Bearer ${authToken}`;
    }

    const proxyReq = http.request(options, (proxyRes) => {
      // Forward status code
      res.status(proxyRes.statusCode || 200);

      // Forward content-type
      if (proxyRes.headers['content-type']) {
        res.set('Content-Type', proxyRes.headers['content-type']);
      }

      // Pipe response body
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error(`[TG] [PROXY] Error (${backendKey}): ${err.message}`);
      if (!res.headersSent) {
        res.status(502).json({ error: `Backend unavailable: ${backendKey}` });
      }
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({ error: 'Backend timeout' });
      }
    });

    // Forward request body for POST/PUT/PATCH
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      const body = JSON.stringify(req.body);
      proxyReq.setHeader('Content-Length', Buffer.byteLength(body));
      proxyReq.write(body);
    }

    proxyReq.end();
  };
}

module.exports = { createProxyHandler };
