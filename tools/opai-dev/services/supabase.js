/**
 * OPAI Dev — Supabase REST API wrapper for dev_workspaces table.
 * Uses service key (bypasses RLS) via node-fetch.
 */

const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const TABLE = 'dev_workspaces';

function headers() {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

function url(query = '') {
  return `${SUPABASE_URL}/rest/v1/${TABLE}${query}`;
}

async function createWorkspace(data) {
  const resp = await fetch(url(), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(data),
  });
  if (!resp.ok) throw new Error(`Supabase insert failed: ${resp.status} ${await resp.text()}`);
  const rows = await resp.json();
  return rows[0];
}

async function getWorkspace(id) {
  const resp = await fetch(url(`?id=eq.${id}&select=*`), { headers: headers() });
  if (!resp.ok) throw new Error(`Supabase select failed: ${resp.status}`);
  const rows = await resp.json();
  return rows[0] || null;
}

async function getWorkspacesByUser(userId) {
  const resp = await fetch(
    url(`?user_id=eq.${userId}&status=not.eq.destroyed&order=created_at.desc`),
    { headers: headers() }
  );
  if (!resp.ok) throw new Error(`Supabase select failed: ${resp.status}`);
  return resp.json();
}

async function getActiveWorkspaces() {
  const resp = await fetch(
    url(`?status=in.(creating,running,stopped)&select=*`),
    { headers: headers() }
  );
  if (!resp.ok) throw new Error(`Supabase select failed: ${resp.status}`);
  return resp.json();
}

async function updateWorkspace(id, data) {
  const resp = await fetch(url(`?id=eq.${id}`), {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(data),
  });
  if (!resp.ok) throw new Error(`Supabase update failed: ${resp.status} ${await resp.text()}`);
  const rows = await resp.json();
  return rows[0];
}

async function updateLastActive(id) {
  return updateWorkspace(id, { last_active_at: new Date().toISOString() });
}

async function getRunningWorkspaces() {
  const resp = await fetch(
    url(`?status=eq.running&select=*`),
    { headers: headers() }
  );
  if (!resp.ok) throw new Error(`Supabase select failed: ${resp.status}`);
  return resp.json();
}

async function getStoppedWorkspaces() {
  const resp = await fetch(
    url(`?status=eq.stopped&select=*`),
    { headers: headers() }
  );
  if (!resp.ok) throw new Error(`Supabase select failed: ${resp.status}`);
  return resp.json();
}

module.exports = {
  createWorkspace,
  getWorkspace,
  getWorkspacesByUser,
  getActiveWorkspaces,
  updateWorkspace,
  updateLastActive,
  getRunningWorkspaces,
  getStoppedWorkspaces,
};
