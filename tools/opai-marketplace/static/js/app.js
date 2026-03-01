/* OPAI Marketplace — Frontend */

let _products = [];
let _isAdmin = false;
let _adminView = false;
let _currentFilter = 'all';
let _userTier = 'free';
let _bbPlatformUrl = '';
let _bbSupabaseUrl = '';

// ── Init ──────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    // Fetch Supabase config so auth-v3.js can initialize
    const cfg = await fetch('/marketplace/api/auth/config').then(r => r.json());
    if (cfg.supabase_url && cfg.supabase_anon_key) {
        window.OPAI_SUPABASE_URL = cfg.supabase_url;
        window.OPAI_SUPABASE_ANON_KEY = cfg.supabase_anon_key;
    }
    _bbPlatformUrl = (cfg.bb_platform_url || '').replace(/\/+$/, '');
    _bbSupabaseUrl = (cfg.bb_supabase_url || '').replace(/\/+$/, '');

    const user = await opaiAuth.init({ requireApp: 'marketplace' });
    if (!user) return;
    await initApp(user);
});

async function initApp(user) {

    const el = document.getElementById('user-display');
    if (el) el.textContent = user.user_metadata?.display_name || user.email?.split('@')[0] || '';

    _isAdmin = (user.app_metadata?.role === 'admin');

    if (_isAdmin) {
        const bar = document.getElementById('admin-bar');
        if (bar) bar.style.display = 'flex';

        document.getElementById('admin-view-toggle')?.addEventListener('change', (e) => {
            _adminView = e.target.checked;
            loadProducts();
        });
    }

    // Filter tabs
    document.querySelectorAll('.filter-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            _currentFilter = tab.dataset.filter;
            renderProducts();
        });
    });

    // Modal close
    document.getElementById('modal-close-btn').addEventListener('click', closeModal);
    document.getElementById('product-modal').addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });

    await loadProducts();
}

// ── API ──────────────────────────────────────

async function authHeaders() {
    const token = await opaiAuth.getToken();
    return token ? { 'Authorization': `Bearer ${token}` } : {};
}

async function loadProducts() {
    const grid = document.getElementById('product-grid');
    grid.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Loading products...</span></div>';

    try {
        const endpoint = (_isAdmin && _adminView)
            ? '/marketplace/api/admin/products'
            : '/marketplace/api/products';

        const resp = await fetch(endpoint, { headers: await authHeaders() });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        _products = data.products || [];
        _userTier = data.user_tier || 'free';

        // Update tier display
        const tierEl = document.getElementById('user-tier-display');
        if (tierEl) {
            tierEl.innerHTML = `Your tier: <span class="tier-badge tier-${_userTier}">${_userTier}</span>`;
        }

        // Update count
        const countEl = document.getElementById('product-count');
        if (countEl) countEl.textContent = `${_products.length} products`;

        renderProducts();
    } catch (e) {
        grid.innerHTML = `<div class="empty-state">Failed to load products: ${e.message}</div>`;
    }
}

// ── Render Grid ──────────────────────────────

function renderProducts() {
    const grid = document.getElementById('product-grid');
    let filtered = _products;

    if (_currentFilter !== 'all') {
        filtered = filtered.filter(p => p.product_type === _currentFilter);
    }

    if (!filtered.length) {
        grid.innerHTML = '<div class="empty-state">No products found</div>';
        return;
    }

    grid.innerHTML = filtered.map(p => renderCard(p)).join('');
}

function renderCard(p) {
    const iconHtml = p.icon && (p.icon.startsWith('http') || p.icon.startsWith('/'))
        ? `<img src="${escHtml(p.icon)}" alt="">`
        : (p.icon || typeIcon(p.product_type));

    const tierClass = `tier-${p.tier_requirement || 'free'}`;
    const typeClass = p.product_type || 'webapp';

    const adminHtml = (_isAdmin && _adminView) ? `
        <div class="admin-controls">
            <button class="btn btn-small ${p.is_active ? 'btn-danger' : 'btn-success'}"
                    onclick="event.stopPropagation(); toggleProduct('${p.id}', ${!p.is_active})">
                ${p.is_active ? 'Disable' : 'Enable'}
            </button>
        </div>` : '';

    return `<div class="product-card" onclick="openProductDetail('${p.id}')">
        <div class="product-card-header">
            <div class="product-icon">${iconHtml}</div>
            <div class="product-title">${escHtml(p.name)}</div>
        </div>
        <div class="product-desc">${escHtml(p.description || '')}</div>
        <div class="product-footer">
            <span class="product-type-badge ${typeClass}">${typeClass}</span>
            <span class="tier-badge ${tierClass}">${p.tier_requirement || 'free'}</span>
        </div>
        ${adminHtml}
    </div>`;
}

function typeIcon(type) {
    const icons = {
        webapp: '&#127760;',
        automation: '&#9881;',
        plugin: '&#128268;',
        mobile: '&#128241;',
    };
    return icons[type] || '&#128230;';
}

// ── Product Detail Modal ─────────────────────

function openProductDetail(productId) {
    const p = _products.find(x => x.id === productId);
    if (!p) return;

    const m = p.metadata || {};
    const container = document.getElementById('modal-content');
    const tierClass = `tier-${p.tier_requirement || 'free'}`;
    const typeClass = p.product_type || 'webapp';

    const iconHtml = p.icon && (p.icon.startsWith('http') || p.icon.startsWith('/'))
        ? `<img src="${escHtml(p.icon)}" alt="" style="width:48px;height:48px;border-radius:10px;object-fit:cover;">`
        : `<span style="font-size:32px;">${p.icon || typeIcon(p.product_type)}</span>`;

    // Screenshots
    const screenshots = m.screenshots || [];
    let screenshotsHtml = '';
    if (screenshots.length) {
        screenshotsHtml = `
            <div class="detail-screenshots">
                ${screenshots.map(url => `<a href="${escHtml(url)}" target="_blank" rel="noopener"><img src="${escHtml(url)}" alt="Screenshot"></a>`).join('')}
            </div>`;
    }

    // Tags
    const rawTags = m.tags || m.Tags || p.tags || [];
    let tagsArr = [];
    if (typeof rawTags === 'string') {
        try { tagsArr = JSON.parse(rawTags); } catch { tagsArr = [rawTags]; }
    } else if (Array.isArray(rawTags)) {
        tagsArr = rawTags.flatMap(t => {
            if (typeof t === 'string') {
                try { return JSON.parse(t); } catch { return [t]; }
            }
            return [t];
        });
    }
    const tagsHtml = tagsArr.length
        ? `<div class="detail-tags">${tagsArr.map(t => `<span class="detail-tag">${escHtml(String(t))}</span>`).join('')}</div>`
        : '';

    // Description
    const desc = m.Description || m.description || p.description || m.excerpt || m.meta_description || '';

    // Actions per type
    let actionsHtml = '';
    let detailsHtml = '';

    if (p.product_type === 'webapp') {
        const appUrl = m.app_url;
        if (appUrl) {
            const fullUrl = appUrl.startsWith('http') ? appUrl : _bbPlatformUrl + appUrl;
            actionsHtml = `<a href="${escHtml(fullUrl)}" target="_blank" rel="noopener" class="btn btn-accent btn-action">Open App &#8599;</a>`;
        }
        if (m.demo_mode) {
            detailsHtml += `<div class="detail-meta-item"><span class="detail-meta-label">Demo Mode</span><span class="detail-meta-value">Available</span></div>`;
        }
        if (m.github_repo) {
            detailsHtml += `<div class="detail-meta-item"><span class="detail-meta-label">Source</span><a href="https://github.com/${escHtml(m.github_repo)}" target="_blank" rel="noopener" class="detail-meta-link">GitHub</a></div>`;
        }
    } else if (p.product_type === 'automation') {
        // Parse input schema to find webhook URL and input fields
        let webhookUrl = '';
        let fields = [];
        let inputSchema = null;
        try {
            inputSchema = typeof m.Input_Schema === 'string' ? JSON.parse(m.Input_Schema) : m.Input_Schema;
        } catch { /* ignore */ }

        if (Array.isArray(inputSchema)) {
            // Prefer webhook trigger (accepts JSON POST), fallback to form trigger
            const webhookTrigger = inputSchema.find(s => s.type_display === 'webhook' && s.webhook_url);
            const formTrigger = inputSchema.find(s => s.type_display === 'form' && s.webhook_url);
            if (webhookTrigger) {
                webhookUrl = webhookTrigger.webhook_url;
                if (webhookTrigger.input_fields && webhookTrigger.input_fields.length) {
                    fields = webhookTrigger.input_fields;
                }
            }
            if (!webhookUrl && formTrigger) {
                webhookUrl = formTrigger.webhook_url;
            }
            // If webhook had no fields, check if any trigger node has fields
            if (!fields.length) {
                const fieldsNode = inputSchema.find(s => s.input_fields && s.input_fields.length);
                if (fieldsNode) fields = fieldsNode.input_fields;
            }
        }
        if (!webhookUrl) webhookUrl = m.Webhook_URL || '';

        // Build the form
        if (fields.length) {
            detailsHtml += '<form id="automation-form" class="automation-form" onsubmit="return false;">';
            for (const f of fields) {
                const fieldId = 'auto-field-' + (f.field_name || '').replace(/[^a-zA-Z0-9]/g, '_');
                const req = f.required ? 'required' : '';
                detailsHtml += `<div class="auto-field-group">
                    <label class="auto-field-label" for="${fieldId}">
                        ${escHtml(f.field_label || f.field_name)}
                        ${f.required ? '<span class="auto-field-req">*</span>' : ''}
                    </label>
                    <input type="text" class="auto-field-input" id="${fieldId}"
                        data-field-name="${escHtml(f.field_name)}"
                        placeholder="${escHtml(f.placeholder || '')}"
                        ${req}>
                    ${f.description ? '<span class="auto-field-desc">' + escHtml(f.description) + '</span>' : ''}
                </div>`;
            }
            detailsHtml += '</form>';
        }

        // Response area (hidden until run)
        detailsHtml += '<div id="automation-response" class="automation-response" style="display:none;"></div>';

        if (webhookUrl) {
            actionsHtml = `<button class="btn btn-accent btn-action" id="run-automation-btn" onclick="runAutomation('${escHtml(webhookUrl)}')">Run Automation &#9654;</button>`;
        }
        if (m.Workflow_ID) {
            detailsHtml += `<div class="detail-meta-item"><span class="detail-meta-label">Workflow</span><span class="detail-meta-value">${escHtml(m.Workflow_ID)}</span></div>`;
        }
    } else if (p.product_type === 'plugin') {
        if (m.file_path && _bbSupabaseUrl) {
            const downloadUrl = _bbSupabaseUrl + '/storage/v1/object/public/plugins/' + encodeURI(m.file_path);
            actionsHtml = `<a href="${escHtml(downloadUrl)}" target="_blank" rel="noopener" class="btn btn-accent btn-action">Download Plugin &#11015;</a>`;
        }
        if (m.version) {
            detailsHtml += `<div class="detail-meta-item"><span class="detail-meta-label">Version</span><span class="detail-meta-value">${escHtml(m.version)}</span></div>`;
        }
        if (m.author) {
            const authorLink = m.author_url ? `<a href="${escHtml(m.author_url.startsWith('http') ? m.author_url : 'https://' + m.author_url)}" target="_blank" rel="noopener" class="detail-meta-link">${escHtml(m.author)}</a>` : escHtml(m.author);
            detailsHtml += `<div class="detail-meta-item"><span class="detail-meta-label">Author</span><span class="detail-meta-value">${authorLink}</span></div>`;
        }
        if (m.file_size_mb) {
            detailsHtml += `<div class="detail-meta-item"><span class="detail-meta-label">Size</span><span class="detail-meta-value">${m.file_size_mb} MB</span></div>`;
        }
        if (m.download_count != null) {
            detailsHtml += `<div class="detail-meta-item"><span class="detail-meta-label">Downloads</span><span class="detail-meta-value">${m.download_count}</span></div>`;
        }
        if (m.requires_license) {
            detailsHtml += `<div class="detail-meta-item"><span class="detail-meta-label">License</span><span class="detail-meta-value">Required</span></div>`;
        }
    } else if (p.product_type === 'mobile') {
        let btns = [];
        if (m.app_store_url) btns.push(`<a href="${escHtml(m.app_store_url)}" target="_blank" rel="noopener" class="btn btn-action">App Store</a>`);
        if (m.play_store_url) btns.push(`<a href="${escHtml(m.play_store_url)}" target="_blank" rel="noopener" class="btn btn-action">Play Store</a>`);
        if (m.expo_url) btns.push(`<a href="${escHtml(m.expo_url)}" target="_blank" rel="noopener" class="btn btn-accent btn-action">Expo Link &#8599;</a>`);
        if (m.download_url) btns.push(`<a href="${escHtml(m.download_url)}" target="_blank" rel="noopener" class="btn btn-accent btn-action">Download &#11015;</a>`);
        actionsHtml = btns.join('');

        // QR code for any available link
        const qrTarget = m.expo_url || m.play_store_url || m.app_store_url || m.download_url || '';
        if (qrTarget) {
            const qrApi = 'https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=' + encodeURIComponent(qrTarget);
            detailsHtml += `<div class="detail-qr"><img src="${qrApi}" alt="QR Code" width="160" height="160"><div class="detail-qr-label">Scan to install</div></div>`;
        }
    }

    container.innerHTML = `
        <div class="detail-header">
            <div class="detail-icon">${iconHtml}</div>
            <div class="detail-header-text">
                <div class="detail-title">${escHtml(p.name)}</div>
                <div class="detail-badges">
                    <span class="product-type-badge ${typeClass}">${typeClass}</span>
                    <span class="tier-badge ${tierClass}">${p.tier_requirement || 'free'}</span>
                    ${p.category && p.category !== p.product_type ? '<span class="detail-category">' + escHtml(p.category) + '</span>' : ''}
                </div>
            </div>
        </div>
        ${tagsHtml}
        <div class="detail-desc">${escHtml(desc)}</div>
        ${screenshotsHtml}
        ${detailsHtml ? '<div class="detail-meta">' + detailsHtml + '</div>' : ''}
        ${actionsHtml ? '<div class="detail-actions">' + actionsHtml + '</div>' : ''}
    `;

    document.getElementById('product-modal').classList.add('visible');
}

function closeModal() {
    document.getElementById('product-modal').classList.remove('visible');
}

async function runAutomation(webhookUrl) {
    const form = document.getElementById('automation-form');
    const btn = document.getElementById('run-automation-btn');
    const responseEl = document.getElementById('automation-response');

    // Collect field values
    const payload = {};
    if (form) {
        const inputs = form.querySelectorAll('.auto-field-input');
        for (const input of inputs) {
            const name = input.dataset.fieldName;
            const val = input.value.trim();
            if (input.required && !val) {
                input.focus();
                input.classList.add('auto-field-error');
                showToast('Please fill in all required fields');
                return;
            }
            input.classList.remove('auto-field-error');
            if (name) payload[name] = val;
        }
    }

    // Update UI state
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-spinner"></span> Running...';
    responseEl.style.display = 'none';

    try {
        const resp = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        const contentType = resp.headers.get('content-type') || '';
        let result;
        if (contentType.includes('application/json')) {
            result = await resp.json();
        } else {
            result = await resp.text();
        }

        responseEl.style.display = 'block';
        if (resp.ok) {
            const display = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
            responseEl.className = 'automation-response automation-response-success';
            responseEl.innerHTML = '<div class="auto-resp-label">Response</div><pre class="auto-resp-body">' + escHtml(display) + '</pre>';
            showToast('Automation executed successfully');
        } else {
            const display = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
            responseEl.className = 'automation-response automation-response-error';
            responseEl.innerHTML = '<div class="auto-resp-label">Error (' + resp.status + ')</div><pre class="auto-resp-body">' + escHtml(display) + '</pre>';
            showToast('Automation returned an error');
        }
    } catch (e) {
        responseEl.style.display = 'block';
        responseEl.className = 'automation-response automation-response-error';
        responseEl.innerHTML = '<div class="auto-resp-label">Error</div><pre class="auto-resp-body">' + escHtml(e.message) + '</pre>';
        showToast('Failed to reach automation');
    }

    btn.disabled = false;
    btn.innerHTML = 'Run Automation &#9654;';
}

// ── Admin Actions ─────────────────────────────

async function toggleProduct(productId, isActive) {
    try {
        const resp = await fetch(`/marketplace/api/products/${productId}/toggle`, {
            method: 'POST',
            headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: isActive }),
        });
        if (!resp.ok) throw new Error('Toggle failed');
        showToast(isActive ? 'Product enabled' : 'Product disabled');
        await loadProducts();
    } catch (e) {
        showToast('Error: ' + e.message);
    }
}

async function triggerSync() {
    try {
        showToast('Syncing catalog...');
        const resp = await fetch('/marketplace/api/products/sync', {
            method: 'POST',
            headers: await authHeaders(),
        });
        if (!resp.ok) throw new Error('Sync failed');
        showToast('Catalog synced successfully');
        await loadProducts();
    } catch (e) {
        showToast('Sync error: ' + e.message);
    }
}

// ── Utils ────────────────────────────────────

function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function showToast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
}
