/**
 * Engine & Brain API — Shared HTTP helpers for OPAI Engine and 2nd Brain.
 *
 * Engine: http://127.0.0.1:8080/api  (orchestrator, workers, tasks, usage)
 * Brain:  http://127.0.0.1:8101/api  (search, inbox, suggestions)
 */

const http = require('http');

const ENGINE = 'http://127.0.0.1:8080/api';
const BRAIN  = 'http://127.0.0.1:8101/api';

function httpRequest(url, method, body, headers, timeout) {
  return new Promise((resolve, reject) => {
    const opts = { method, timeout, headers: { ...headers } };
    if (body && method !== 'GET') {
      opts.headers['Content-Type'] = 'application/json';
    }

    const req = http.request(url, opts, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          } else {
            resolve({ raw: data });
          }
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body && method !== 'GET') req.write(JSON.stringify(body));
    req.end();
  });
}

function engineGet(path, timeout = 5000) {
  return httpRequest(`${ENGINE}${path}`, 'GET', null, {}, timeout);
}

function enginePost(path, body = {}, timeout = 10000) {
  return httpRequest(`${ENGINE}${path}`, 'POST', body, {}, timeout);
}

function brainGet(path, timeout = 5000) {
  const headers = {};
  if (process.env.SUPABASE_SERVICE_KEY) {
    headers['Authorization'] = `Bearer ${process.env.SUPABASE_SERVICE_KEY}`;
  }
  return httpRequest(`${BRAIN}${path}`, 'GET', null, headers, timeout);
}

function brainPost(path, body = {}, timeout = 5000) {
  const headers = {};
  if (process.env.SUPABASE_SERVICE_KEY) {
    headers['Authorization'] = `Bearer ${process.env.SUPABASE_SERVICE_KEY}`;
  }
  return httpRequest(`${BRAIN}${path}`, 'POST', body, headers, timeout);
}

module.exports = { engineGet, enginePost, brainGet, brainPost };
