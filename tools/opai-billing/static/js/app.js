/**
 * OPAI Billing — Admin Dashboard JS
 */
'use strict';

let _token = null;
let _products = [];
let _txnPage = 0;

// ── Auth ──────────────────────────────────────────────────
async function billingInit() {
  // Fetch Supabase config
  try {
    const cfg = await fetch('/auth/config').then(r => r.json());
    if (cfg.supabase_url && cfg.supabase_anon_key) {
      window.OPAI_SUPABASE_URL = cfg.supabase_url;
      window.OPAI_SUPABASE_ANON_KEY = cfg.supabase_anon_key;
    }
  } catch (e) {
    document.body.innerHTML = '<div style="padding:40px;color:#e17055;">Failed to load auth config</div>';
    return;
  }

  // Wait for auth-v3.js defer script
  const maxWait = 5000;
  const start = Date.now();
  while (typeof opaiAuth === 'undefined' && Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (typeof opaiAuth === 'undefined') {
    document.body.innerHTML = '<div style="padding:40px;color:#e17055;">Auth not loaded</div>';
    return;
  }

  // Initialize auth (handles login redirect + admin check)
  const user = await opaiAuth.init({ requireAdmin: true });
  if (!user) return; // redirected

  _token = await opaiAuth.getToken();
  document.getElementById('user-display').textContent = user.email || '';

  // Setup tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Load dashboard
  loadDashboard();
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + tab));

  if (tab === 'products') loadProducts();
  else if (tab === 'subscriptions') loadSubscriptions();
  else if (tab === 'transactions') { _txnPage = 0; loadTransactions(); }
  else if (tab === 'dashboard') loadDashboard();
}

async function api(path, opts = {}) {
  // Refresh token on each call in case it expired
  const token = await opaiAuth.getToken();
  if (token) _token = token;

  const resp = await fetch('/billing' + path, {
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + _token,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ detail: resp.statusText }));
    throw new Error(err.detail || 'Request failed');
  }
  return resp.json();
}

// ── Dashboard ─────────────────────────────────────────────
async function loadDashboard() {
  try {
    const data = await api('/api/dashboard');
    document.getElementById('stat-mrr').textContent = '$' + (data.mrr || 0).toFixed(2);
    document.getElementById('stat-subs').textContent = data.active_subscriptions || 0;
    document.getElementById('stat-products').textContent = data.total_products || 0;

    const tbody = document.getElementById('recent-transactions');
    if (!data.recent_transactions || data.recent_transactions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-muted" style="text-align:center;padding:40px;">No transactions yet</td></tr>';
      return;
    }
    tbody.innerHTML = data.recent_transactions.map(tx => `
      <tr>
        <td>${formatDate(tx.created_at)}</td>
        <td>${esc(tx.customer_email || '-')}</td>
        <td>${formatAmount(tx.amount, tx.currency)}</td>
        <td><span class="badge badge-${tx.status}">${tx.status}</span></td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('Dashboard error:', e);
  }
}

// ── Products ──────────────────────────────────────────────
async function loadProducts() {
  const grid = document.getElementById('product-grid');
  grid.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Loading...</span></div>';
  try {
    const data = await api('/api/products');
    _products = data.products || [];
    if (_products.length === 0) {
      grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128230;</div><div>No products yet. Create one or import from Stripe.</div></div>';
      return;
    }
    grid.innerHTML = _products.map(p => {
      const price = p.prices?.[0];
      const priceStr = price ? formatAmount(price.unit_amount, price.currency) : 'No price';
      const interval = price?.recurring_interval ? '/' + price.recurring_interval : '';
      const isActive = p.active !== false;
      const statusLabel = isActive ? 'active' : 'archived';
      const statusCls = isActive ? 'badge-active' : 'badge-archived';
      return `
        <div class="product-card">
          <div class="product-card-header">
            <div>
              <div class="product-name">${esc(p.name)}</div>
              <span class="badge ${statusCls}" style="margin-top:4px;">${statusLabel}</span>
            </div>
            <span class="tier-badge tier-${p.tier_mapping || 'starter'}">${p.tier_mapping || 'starter'}</span>
          </div>
          <div class="product-desc">${esc(p.description || 'No description')}</div>
          <div style="margin-bottom:12px;">
            <span class="product-price">${priceStr}</span>
            <span class="product-price-interval">${interval}</span>
          </div>
          <div class="product-footer">
            <span class="text-muted" style="font-size:11px;">${p.stripe_product_id ? 'Synced' : 'Local only'}</span>
            <div class="product-actions">
              <button class="btn btn-small btn-outline" onclick="editProduct('${p.id}')">Edit</button>
              ${!p.stripe_product_id ? '<button class="btn btn-small btn-accent" onclick="pushProduct(\'' + p.id + '\')">Push to Stripe</button>' : ''}
              <button class="btn btn-small btn-danger" onclick="archiveProduct('${p.id}')">Archive</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    grid.innerHTML = '<div class="empty-state text-red">' + esc(e.message) + '</div>';
  }
}

// ── Subscriptions ─────────────────────────────────────────
async function loadSubscriptions() {
  const tbody = document.getElementById('subscriptions-tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="text-muted" style="text-align:center;padding:40px;"><div class="spinner" style="margin:0 auto;"></div></td></tr>';
  try {
    const data = await api('/api/subscriptions');
    const subs = data.subscriptions || [];
    if (subs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-muted" style="text-align:center;padding:40px;">No subscriptions</td></tr>';
      return;
    }
    tbody.innerHTML = subs.map(s => {
      const statusCls = 'badge-' + (s.status || 'pending');
      const periodEnd = s.current_period_end ? new Date(s.current_period_end * 1000).toLocaleDateString() : '-';
      return `
        <tr>
          <td>${esc(s.user_display_name || s.user_id || '-')}</td>
          <td>${esc(s.tier_mapping || '-')}</td>
          <td><span class="badge ${statusCls}">${s.status || 'unknown'}</span></td>
          <td>${formatAmount(s.unit_amount, s.currency)}</td>
          <td>${periodEnd}</td>
          <td>
            <div style="display:flex;gap:4px;">
              ${s.status === 'active' ? `
                <button class="btn btn-small btn-outline" onclick="cancelSub('${s.id}')">Cancel</button>
                <button class="btn btn-small btn-outline" onclick="pauseSub('${s.id}')">Pause</button>
              ` : ''}
              ${s.status === 'paused' ? `
                <button class="btn btn-small btn-success" onclick="resumeSub('${s.id}')">Resume</button>
              ` : ''}
              <button class="btn btn-small btn-danger" onclick="revokeSub('${s.id}')">Revoke</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-red">' + esc(e.message) + '</td></tr>';
  }
}

// ── Transactions ──────────────────────────────────────────
async function loadTransactions(append) {
  const tbody = document.getElementById('transactions-tbody');
  if (!append) tbody.innerHTML = '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:40px;"><div class="spinner" style="margin:0 auto;"></div></td></tr>';
  try {
    const data = await api('/api/transactions?page=' + _txnPage + '&limit=25');
    const txns = data.transactions || [];
    const rows = txns.map(tx => `
      <tr>
        <td>${formatDate(tx.created_at)}</td>
        <td>${esc(tx.customer_email || '-')}</td>
        <td>${esc(tx.stripe_payment_intent_id || '-')}</td>
        <td>${formatAmount(tx.amount, tx.currency)}</td>
        <td><span class="badge badge-${tx.status}">${tx.status}</span></td>
      </tr>
    `).join('');

    if (append) {
      tbody.insertAdjacentHTML('beforeend', rows);
    } else if (txns.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:40px;">No transactions</td></tr>';
    } else {
      tbody.innerHTML = rows;
    }

    document.getElementById('load-more-btn').style.display = txns.length >= 25 ? '' : 'none';
  } catch (e) {
    if (!append) tbody.innerHTML = '<tr><td colspan="5" class="text-red">' + esc(e.message) + '</td></tr>';
  }
}

// ── Product Modal ─────────────────────────────────────────
function openProductModal(product) {
  const modal = document.getElementById('product-modal');
  const title = document.getElementById('product-modal-title');
  const submit = document.getElementById('pf-submit');
  document.getElementById('pf-id').value = '';
  document.getElementById('pf-name').value = '';
  document.getElementById('pf-desc').value = '';
  document.getElementById('pf-category').value = 'opai';
  document.getElementById('pf-tier').value = 'starter';
  document.getElementById('pf-price').value = '';
  document.getElementById('pf-type').value = 'recurring';
  document.getElementById('pf-interval').value = 'month';
  document.getElementById('pf-image').value = '';

  if (product) {
    title.textContent = 'Edit Product';
    submit.textContent = 'Save Changes';
    document.getElementById('pf-id').value = product.id;
    document.getElementById('pf-name').value = product.name || '';
    document.getElementById('pf-desc').value = product.description || '';
    document.getElementById('pf-category').value = product.category || 'opai';
    document.getElementById('pf-tier').value = product.tier_mapping || 'starter';
    document.getElementById('pf-image').value = (product.images && product.images[0]) || '';
  } else {
    title.textContent = 'New Product';
    submit.textContent = 'Create Product';
  }

  modal.classList.add('active');
}

function closeProductModal() {
  document.getElementById('product-modal').classList.remove('active');
}

async function saveProduct(e) {
  e.preventDefault();
  const id = document.getElementById('pf-id').value;
  const body = {
    name: document.getElementById('pf-name').value,
    description: document.getElementById('pf-desc').value,
    category: document.getElementById('pf-category').value,
    tier_mapping: document.getElementById('pf-tier').value,
    image_url: document.getElementById('pf-image').value || null,
  };

  try {
    if (id) {
      await api('/api/products/' + id, { method: 'PUT', body: JSON.stringify(body) });
      toast('Product updated', 'success');
    } else {
      body.price_amount = parseInt(document.getElementById('pf-price').value) || null;
      body.price_type = document.getElementById('pf-type').value;
      body.price_interval = document.getElementById('pf-interval').value;
      await api('/api/products', { method: 'POST', body: JSON.stringify(body) });
      toast('Product created', 'success');
    }
    closeProductModal();
    loadProducts();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function editProduct(id) {
  const product = _products.find(p => p.id === id);
  if (product) openProductModal(product);
}

async function archiveProduct(id) {
  if (!confirm('Archive this product?')) return;
  try {
    await api('/api/products/' + id, { method: 'DELETE' });
    toast('Product archived', 'success');
    loadProducts();
  } catch (e) { toast(e.message, 'error'); }
}

async function pushProduct(id) {
  try {
    await api('/api/products/' + id + '/push', { method: 'POST' });
    toast('Pushed to Stripe', 'success');
    loadProducts();
  } catch (e) { toast(e.message, 'error'); }
}

async function importFromStripe() {
  try {
    const data = await api('/api/products/import', { method: 'POST' });
    toast('Imported ' + data.imported_products + ' products, ' + data.imported_prices + ' prices', 'success');
    loadProducts();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Subscription Actions ──────────────────────────────────
async function cancelSub(id) {
  if (!confirm('Cancel this subscription at period end?')) return;
  try {
    await api('/api/subscriptions/' + id + '/cancel', { method: 'POST' });
    toast('Subscription will cancel at period end', 'success');
    loadSubscriptions();
  } catch (e) { toast(e.message, 'error'); }
}

async function pauseSub(id) {
  try {
    await api('/api/subscriptions/' + id + '/pause', { method: 'POST' });
    toast('Subscription paused', 'success');
    loadSubscriptions();
  } catch (e) { toast(e.message, 'error'); }
}

async function resumeSub(id) {
  try {
    await api('/api/subscriptions/' + id + '/resume', { method: 'POST' });
    toast('Subscription resumed', 'success');
    loadSubscriptions();
  } catch (e) { toast(e.message, 'error'); }
}

async function revokeSub(id) {
  if (!confirm('Revoke this subscription? This will cancel AND deactivate the user.')) return;
  try {
    await api('/api/subscriptions/' + id + '/revoke', { method: 'DELETE' });
    toast('Subscription revoked and user deactivated', 'success');
    loadSubscriptions();
  } catch (e) { toast(e.message, 'error'); }
}

function loadMoreTransactions() {
  _txnPage++;
  loadTransactions(true);
}

// ── Billing Type Toggle ───────────────────────────────────
document.getElementById('pf-type')?.addEventListener('change', function () {
  document.getElementById('pf-interval-group').style.display = this.value === 'recurring' ? '' : 'none';
});

// ── Helpers ───────────────────────────────────────────────
function formatAmount(cents, currency) {
  if (!cents) return '$0.00';
  const amt = (cents / 100).toFixed(2);
  const sym = currency === 'eur' ? '\u20ac' : '$';
  return sym + amt;
}

function formatDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function toast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (type || '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast'; }, 3000);
}

// ── Init ──────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', billingInit);
} else {
  billingInit();
}
