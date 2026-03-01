/**
 * HELM -- Website Builder Sub-Wizard
 * "I need a website -- build one for me" flow (Step 4, choice = 'build')
 *
 * Entry: initWebsiteBuilder(onboardingId, businessData)
 * Sub-steps: A (domain) → B (platform + hosting) → C (order + pay) → D (confirmation)
 *
 * Provider: Hostinger (domain + hosting via agency account, HITL provisioning)
 * v28
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
var WB = {
    onboardingId: null,
    businessData: {},
    // Sub A
    domainName: '',
    domainTld: '.com',
    domainAvailable: null,
    domainPrice: 14.99,
    domainBundlePrice: 1.00,
    domainCheckTimeout: null,
    // Sub B
    platform: 'wordpress',
    provider: 'hostinger',
    hostingPlan: 'pro',
    plans: [],
    recommendation: null,
    // Sub C
    wpProAddon: false,
    // Sub D
    sessionId: null,
    provisionResult: null,
};

var WB_TLDS = ['.com', '.net', '.co', '.io'];

// ── Entry Point ───────────────────────────────────────────────────────────────

function initWebsiteBuilder(onboardingId, businessData) {
    WB.onboardingId = onboardingId;
    WB.businessData = businessData || {};

    // Check if we're returning from Stripe (ws_session param)
    var urlParams = new URLSearchParams(window.location.search);
    var wsSession = urlParams.get('ws_session');
    if (wsSession) {
        WB.sessionId = wsSession;
        renderBuilderSubStep('D');
        completeAfterStripe(wsSession);
        return;
    }

    // Pre-fill domain from business name
    var bizName = (businessData.name || businessData.business_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (bizName) WB.domainName = bizName;

    renderBuilderSubStep('A');

    // Load recommendation + plans in background
    loadRecommendation();
    loadPlans();
}

// ── Sub-Step Renderer ─────────────────────────────────────────────────────────

function renderBuilderSubStep(sub) {
    var container = document.getElementById('website-subform');
    if (!container) return;
    container.style.display = '';
    switch (sub) {
        case 'A': container.innerHTML = renderSubA(); initSubA(); break;
        case 'B': container.innerHTML = renderSubB(); initSubB(); break;
        case 'C': container.innerHTML = renderSubC(); break;
        case 'D': container.innerHTML = renderSubD(); break;
    }
    // Hide the main step nav "Next" button — builder manages its own flow
    var stepNav = document.getElementById('step4-next');
    if (stepNav) stepNav.style.display = 'none';
}

// ── Sub A: Domain Search ──────────────────────────────────────────────────────

function renderSubA() {
    var tldOptions = WB_TLDS.map(function(t) {
        return '<option value="' + t + '"' + (t === WB.domainTld ? ' selected' : '') + '>' + t + '</option>';
    }).join('');

    return '<div class="card wb-card" style="margin-top:16px;">' +
        '<h3>&#127760; Find your domain name</h3>' +
        '<p style="color:var(--text-muted);font-size:13px;margin-bottom:14px;">Choose the web address for your business.</p>' +
        '<div style="display:flex;gap:8px;margin-bottom:12px;">' +
            '<input type="text" id="wb-domain-name" placeholder="boutacare" value="' + esc(WB.domainName) + '" ' +
                'style="flex:1;" oninput="wbDomainInput(this.value)" maxlength="63">' +
            '<select id="wb-domain-tld" onchange="wbTldChange(this.value)" style="width:90px;">' + tldOptions + '</select>' +
            '<button class="btn" onclick="wbCheckDomain()">Search</button>' +
        '</div>' +
        '<div id="wb-domain-result" style="min-height:44px;"></div>' +
        '<div id="wb-suggestions" style="margin-top:10px;"></div>' +
        '<div style="margin-top:16px;display:flex;justify-content:flex-end;">' +
            '<button class="btn btn-primary" id="wb-sub-a-next" onclick="wbSubANext()" disabled>Continue with this domain &rarr;</button>' +
        '</div>' +
    '</div>';
}

function initSubA() {
    // Auto-search if domain pre-filled
    if (WB.domainName) {
        setTimeout(wbCheckDomain, 200);
    }
}

function wbDomainInput(val) {
    // Strip invalid chars
    WB.domainName = val.toLowerCase().replace(/[^a-z0-9\-]/g, '');
    if (WB.domainName !== val) {
        var input = document.getElementById('wb-domain-name');
        if (input) input.value = WB.domainName;
    }
    clearTimeout(WB.domainCheckTimeout);
    WB.domainCheckTimeout = setTimeout(wbCheckDomain, 600);
}

function wbTldChange(val) {
    WB.domainTld = val;
    wbCheckDomain();
}

async function wbCheckDomain() {
    var name = WB.domainName;
    if (!name || name.length < 2) return;

    var resultEl = document.getElementById('wb-domain-result');
    if (!resultEl) return;
    resultEl.innerHTML = '<span style="color:var(--text-muted);font-size:13px;">&#8635; Checking availability...</span>';

    try {
        var params = new URLSearchParams({ name: name, tld: WB.domainTld });
        var resp = await fetch('/helm/api/website-builder/domain/check?' + params, {
            headers: HELM.token ? { 'Authorization': 'Bearer ' + HELM.token } : {},
        });
        var data = await resp.json();

        WB.domainAvailable = data.available;
        WB.domainPrice = data.price || 14.99;

        wbRenderDomainResult(data);
        wbLoadSuggestions(name);

    } catch (err) {
        resultEl.innerHTML = '<span style="color:var(--error);font-size:13px;">&#8855; Could not check availability. Try again.</span>';
    }
}

function wbRenderDomainResult(data) {
    var resultEl = document.getElementById('wb-domain-result');
    var nextBtn = document.getElementById('wb-sub-a-next');
    if (!resultEl) return;

    var fqdn = data.domain || (WB.domainName + WB.domainTld.replace(/^\.?/, '.'));
    var bundlePrice = WB.domainBundlePrice;

    if (data.available) {
        resultEl.innerHTML =
            '<div style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.3);border-radius:8px;padding:12px 14px;">' +
                '<div style="display:flex;align-items:center;justify-content:space-between;">' +
                    '<span style="color:var(--success);font-weight:600;">&#10003; ' + esc(fqdn) + ' is available</span>' +
                    '<span style="color:var(--text-muted);font-size:13px;">$' + data.price.toFixed(2) + '/yr</span>' +
                '</div>' +
                '<div style="margin-top:6px;font-size:12px;color:var(--text-muted);">&#127873; Bundle with hosting: <strong style="color:var(--accent);">$' + bundlePrice.toFixed(2) + '</strong></div>' +
            '</div>';
        if (nextBtn) nextBtn.disabled = false;
    } else if (data.available === false) {
        resultEl.innerHTML =
            '<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:12px 14px;">' +
                '<span style="color:var(--error);">&#10007; ' + esc(fqdn) + ' is taken — try a variation below</span>' +
            '</div>';
        if (nextBtn) nextBtn.disabled = true;
    } else {
        // null = unknown (mock / no API)
        resultEl.innerHTML =
            '<div style="background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.3);border-radius:8px;padding:12px 14px;">' +
                '<span style="color:#d97706;">&#9432; ' + esc(fqdn) + ' — availability check unavailable. You can still continue.</span>' +
            '</div>';
        if (nextBtn) nextBtn.disabled = false;
    }
}

async function wbLoadSuggestions(name) {
    var sugEl = document.getElementById('wb-suggestions');
    if (!sugEl) return;

    try {
        var params = new URLSearchParams({ business_name: name });
        var resp = await fetch('/helm/api/website-builder/domain/suggest?' + params, {
            headers: HELM.token ? { 'Authorization': 'Bearer ' + HELM.token } : {},
        });
        var data = await resp.json();
        var suggestions = (data.suggestions || []).filter(function(s) {
            return s.domain !== (name + WB.domainTld.replace(/^\.?/, '.'));
        }).slice(0, 4);

        if (!suggestions.length) { sugEl.innerHTML = ''; return; }

        sugEl.innerHTML =
            '<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">Suggestions:</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
                suggestions.map(function(s) {
                    return '<button class="btn btn-sm btn-ghost" onclick="wbPickSuggestion(\'' + esc(s.domain) + '\')" style="font-size:12px;">' +
                        esc(s.domain) + (s.price ? ' — $' + s.price.toFixed(2) : '') +
                    '</button>';
                }).join('') +
            '</div>';
    } catch (_) {
        sugEl.innerHTML = '';
    }
}

function wbPickSuggestion(fqdn) {
    var parts = fqdn.split('.');
    var tld = '.' + parts.slice(1).join('.');
    var name = parts[0];
    WB.domainName = name;
    WB.domainTld = WB_TLDS.includes(tld) ? tld : '.com';

    var nameInput = document.getElementById('wb-domain-name');
    var tldSelect = document.getElementById('wb-domain-tld');
    if (nameInput) nameInput.value = name;
    if (tldSelect) tldSelect.value = WB.domainTld;

    wbCheckDomain();
}

function wbSubANext() {
    if (!WB.domainName) { showToast('Please enter a domain name.', 'error'); return; }
    renderBuilderSubStep('B');
}

// ── Sub B: Platform + Hosting ─────────────────────────────────────────────────

function renderSubB() {
    return '<div class="card wb-card" style="margin-top:16px;">' +
        '<h3>&#9881; Choose your platform</h3>' +
        '<div id="wb-recommendation" style="margin-bottom:14px;font-size:13px;color:var(--text-muted);">Loading recommendation...</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px;" id="wb-platform-grid">' +
            '<div class="choice-card' + (WB.platform === 'wordpress' ? ' selected' : '') + '" onclick="wbSelectPlatform(\'wordpress\',\'hostinger\')">' +
                '<h4>&#11088; WordPress</h4>' +
                '<p style="font-size:12px;">CMS, e-commerce, blogs — most popular platform</p>' +
            '</div>' +
            '<div class="choice-card' + (WB.platform === 'static' ? ' selected' : '') + '" onclick="wbSelectPlatform(\'static\',\'hostinger\')">' +
                '<h4>&#9889; Static / Landing Page</h4>' +
                '<p style="font-size:12px;">Fast, simple site — portfolio, coming soon, one-pager</p>' +
            '</div>' +
        '</div>' +
        '<h4 style="margin-bottom:10px;">Hosting plan:</h4>' +
        '<div id="wb-plan-grid" style="display:grid;gap:8px;">' +
            '<div style="color:var(--text-muted);font-size:13px;">Loading plans...</div>' +
        '</div>' +
        '<div id="wb-bundle-badge" style="margin-top:12px;display:none;' +
            'background:rgba(var(--accent-rgb,225,29,72),0.08);border:1px solid rgba(var(--accent-rgb,225,29,72),0.25);' +
            'border-radius:8px;padding:10px 14px;font-size:13px;">' +
            '&#127873; <strong>Bundle deal:</strong> Add ' + esc(WB.domainName + WB.domainTld) + ' for <strong style="color:var(--accent);">$' + WB.domainBundlePrice.toFixed(2) + '</strong>' +
        '</div>' +
        '<div style="margin-top:18px;display:flex;justify-content:space-between;">' +
            '<button class="btn btn-ghost" onclick="renderBuilderSubStep(\'A\')">&#8592; Back</button>' +
            '<button class="btn btn-primary" onclick="renderBuilderSubStep(\'C\')">Review Order &rarr;</button>' +
        '</div>' +
    '</div>';
}

function initSubB() {
    // Apply recommendation if loaded
    if (WB.recommendation) {
        applyRecommendation(WB.recommendation);
    }
    // Render plans if loaded
    if (WB.plans.length) {
        renderPlanGrid();
        showBundleBadge();
    }
}

async function loadRecommendation() {
    try {
        var params = new URLSearchParams({ onboarding_id: WB.onboardingId });
        var data = await apiFetch('/helm/api/website-builder/recommend?' + params);
        WB.recommendation = data;
        // Apply to Sub B if it's currently shown
        var recEl = document.getElementById('wb-recommendation');
        if (recEl) applyRecommendation(data);
    } catch (_) { /* non-critical */ }
}

function applyRecommendation(rec) {
    var recEl = document.getElementById('wb-recommendation');
    if (recEl) {
        recEl.innerHTML = '&#129302; HELM recommends: <strong>' + esc(rec.platform === 'wordpress' ? 'WordPress' : 'Static / Landing Page') + '</strong> — ' + esc(rec.reason);
    }

    // Auto-select recommended platform
    WB.platform = rec.platform;
    WB.provider = rec.provider;
    WB.hostingPlan = rec.plan || 'starter';

    // Highlight the recommended card (index 0 = WordPress, index 1 = Static)
    var cards = document.querySelectorAll('#wb-platform-grid .choice-card');
    cards.forEach(function(c, i) {
        c.classList.toggle('selected', i === (WB.platform === 'wordpress' ? 0 : 1));
    });

    if (WB.plans.length) renderPlanGrid();
}

async function loadPlans() {
    try {
        var data = await apiFetch('/helm/api/website-builder/plans');
        WB.plans = data.hosting_plans || [];
        WB.domainBundlePrice = (data.domain || {}).bundle_price || 0.01;
        WB.domainPrice = (data.domain || {}).standard_price || 14.99;

        // Re-render plan grid if Sub B is shown
        if (document.getElementById('wb-plan-grid')) {
            renderPlanGrid();
            showBundleBadge();
        }
    } catch (_) { /* non-critical */ }
}

function renderPlanGrid() {
    var el = document.getElementById('wb-plan-grid');
    if (!el || !WB.plans.length) return;

    el.innerHTML = WB.plans.map(function(p) {
        var sel = p.id === WB.hostingPlan;
        return '<div class="choice-card ' + (sel ? 'selected' : '') + '" style="padding:12px 14px;cursor:pointer;" onclick="wbSelectPlan(\'' + p.id + '\')">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;">' +
                '<strong>' + esc(p.name) + '</strong>' +
                '<span style="color:var(--accent);font-weight:700;">$' + p.price.toFixed(2) + '<span style="font-size:11px;font-weight:400;color:var(--text-muted);">/mo</span></span>' +
            '</div>' +
            '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + p.features.join(' &bull; ') + '</div>' +
        '</div>';
    }).join('');
}

function wbSelectPlatform(platform, provider) {
    WB.platform = platform;
    WB.provider = provider;

    var cards = document.querySelectorAll('#wb-platform-grid .choice-card');
    cards.forEach(function(c, i) {
        c.classList.toggle('selected', i === (platform === 'wordpress' ? 0 : 1));
    });
}

function wbSelectPlan(planId) {
    WB.hostingPlan = planId;
    renderPlanGrid();
}

function showBundleBadge() {
    var badge = document.getElementById('wb-bundle-badge');
    if (badge && WB.domainName) {
        badge.style.display = '';
        badge.innerHTML = '&#127873; <strong>Bundle deal:</strong> Add <strong>' + esc(WB.domainName + WB.domainTld) + '</strong> for <strong style="color:var(--accent);">$' + WB.domainBundlePrice.toFixed(2) + '</strong>';
    }
}

// ── Sub C: Order Summary + Pay ────────────────────────────────────────────────

function renderSubC() {
    var plan = WB.plans.find(function(p) { return p.id === WB.hostingPlan; }) || { name: WB.hostingPlan, price: 10.00 };
    var fqdn = WB.domainName + WB.domainTld;
    var domainLine = WB.domainBundlePrice;
    var hostingLine = plan.price;

    var platformLabel = WB.platform === 'wordpress' ? 'WordPress' : 'Static / Landing Page';
    var providerLabel = 'Hostinger';

    return '<div class="card wb-card" style="margin-top:16px;">' +
        '<h3>Order Summary</h3>' +
        '<table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:14px;">' +
            '<tr>' +
                '<td style="padding:8px 0;color:var(--text2);">' + esc(fqdn) + ' (bundle)</td>' +
                '<td style="text-align:right;font-weight:600;">$' + domainLine.toFixed(2) + '</td>' +
            '</tr>' +
            '<tr>' +
                '<td style="padding:8px 0;color:var(--text2);">' + platformLabel + ' Hosting — ' + plan.name + ' (' + providerLabel + ')</td>' +
                '<td style="text-align:right;font-weight:600;">$' + hostingLine.toFixed(2) + '<span style="font-size:11px;font-weight:400;color:var(--text-muted);">/mo</span></td>' +
            '</tr>' +
        '</table>' +

        // WP Pro add-on — only for WordPress
        (WB.platform === 'wordpress'
            ? '<div style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:14px;">' +
                '<label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin:0;">' +
                    '<input type="checkbox" id="wb-wp-addon" onchange="wbToggleAddon(this.checked)" style="margin-top:2px;flex-shrink:0;">' +
                    '<div>' +
                        '<div style="font-weight:600;font-size:13px;">Add WP Pro Updates &amp; Backup <span style="color:var(--accent);">+$15.00/mo</span></div>' +
                        '<div style="font-size:12px;color:var(--text-muted);margin-top:3px;">Automated updates, daily backups, malware scans — by BoutaByte.<br>Site added to OP WordPress admin for plugin management.</div>' +
                    '</div>' +
                '</label>' +
              '</div>'
            : '') +

        '<div style="border-top:1px solid var(--border);padding-top:12px;display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">' +
            '<span style="font-weight:600;">Total today</span>' +
            '<span id="wb-total" style="font-weight:700;font-size:16px;">$' + (domainLine + hostingLine).toFixed(2) + '</span>' +
        '</div>' +

        '<div style="display:flex;gap:10px;justify-content:space-between;flex-wrap:wrap;">' +
            '<button class="btn btn-ghost" onclick="renderBuilderSubStep(\'B\')">&#8592; Back</button>' +
            '<div style="display:flex;gap:10px;">' +
                '<button class="btn" onclick="wbExport()">Export Setup Guide</button>' +
                '<button class="btn btn-primary" onclick="wbStartCheckout()">Pay with Card &rarr;</button>' +
            '</div>' +
        '</div>' +
    '</div>';
}

function wbToggleAddon(checked) {
    WB.wpProAddon = checked;
    var plan = WB.plans.find(function(p) { return p.id === WB.hostingPlan; }) || { price: 10.00 };
    var base = WB.domainBundlePrice + plan.price;
    var total = base + (checked ? 15.00 : 0);
    var totalEl = document.getElementById('wb-total');
    if (totalEl) totalEl.textContent = '$' + total.toFixed(2);
}

async function wbStartCheckout() {
    try {
        var btn = event && event.target;
        if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }

        var payload = {
            onboarding_id: WB.onboardingId,
            domain: WB.domainName,
            tld: WB.domainTld,
            hosting_plan: WB.hostingPlan,
            platform: WB.platform,
            provider: WB.provider,
            include_domain_bundle: true,
            wp_pro_addon: WB.wpProAddon,
        };

        var data = await apiFetch('/helm/api/website-builder/checkout', {
            method: 'POST',
            body: payload,
        });

        if (data.checkout_url) {
            window.location.href = data.checkout_url;
        } else {
            throw new Error('No checkout URL returned');
        }
    } catch (err) {
        showToast(err.message, 'error');
        var btn = event && event.target;
        if (btn) { btn.disabled = false; btn.textContent = 'Pay with Card →'; }
    }
}

async function wbExport() {
    try {
        var params = new URLSearchParams({
            onboarding_id: WB.onboardingId,
            domain: WB.domainName,
            tld: WB.domainTld,
            hosting_plan: WB.hostingPlan,
            platform: WB.platform,
            provider: WB.provider,
        });
        var resp = await fetch('/helm/api/website-builder/export?' + params, {
            headers: HELM.token ? { 'Authorization': 'Bearer ' + HELM.token } : {},
        });
        if (!resp.ok) throw new Error('Export failed');

        var blob = await resp.blob();
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'HELM-Website-Setup-' + WB.domainName + WB.domainTld + '.md';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // Mark as exported and advance onboarding
        showToast('Setup guide downloaded. Advancing to Step 5.', 'success');
        setTimeout(function() { nextStep(); }, 1500);

    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ── Sub D: Confirmation (post-payment) ────────────────────────────────────────

var WB_STEPS = [
    { id: 'verify',       label: 'Verifying payment' },
    { id: 'subscription', label: 'Registering subscription' },
    { id: 'provision',    label: 'Queuing site provisioning' },
];

function renderSubD() {
    var stepsHtml = WB_STEPS.map(function(s) {
        return '<div id="wb-step-' + s.id + '" style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);">' +
            '<span id="wb-step-icon-' + s.id + '" style="font-size:18px;min-width:22px;text-align:center;">&#8635;</span>' +
            '<span style="font-size:13px;color:var(--text2);">' + esc(s.label) + '</span>' +
        '</div>';
    }).join('');

    return '<div class="card wb-card" style="margin-top:16px;">' +
        '<h3 style="margin-bottom:16px;">Completing your order</h3>' +
        '<div id="wb-steps-list" style="margin-bottom:16px;">' + stepsHtml + '</div>' +
        '<div id="wb-confirm-result" style="display:none;"></div>' +
    '</div>';
}

function _wbSetStep(stepId, state) {
    // state: 'spin' | 'done' | 'error' | 'skip'
    var icons = { spin: '&#8635;', done: '&#10003;', error: '&#9888;', skip: '&#8212;' };
    var colors = { spin: 'var(--text-muted)', done: 'var(--success)', error: 'var(--error)', skip: 'var(--text-muted)' };
    var iconEl = document.getElementById('wb-step-icon-' + stepId);
    if (iconEl) {
        iconEl.innerHTML = icons[state] || icons.spin;
        iconEl.style.color = colors[state] || '';
    }
}

async function completeAfterStripe(sessionId) {
    // Animate all steps spinning initially
    WB_STEPS.forEach(function(s) { _wbSetStep(s.id, 'spin'); });

    var fqdn = WB.domainName ? (WB.domainName + WB.domainTld) : 'your site';
    var resultEl = document.getElementById('wb-confirm-result');

    try {
        // Step 1: Verify payment (we're already here — mark done)
        _wbSetStep('verify', 'done');
        await new Promise(function(r) { setTimeout(r, 400); });

        // Step 2 + 3: Notify backend to provision + register subscription
        var data = await apiFetch('/helm/api/website-builder/webhook/complete', {
            method: 'POST',
            body: { session_id: sessionId },
        });

        _wbSetStep('subscription', 'done');
        await new Promise(function(r) { setTimeout(r, 300); });
        _wbSetStep('provision', 'done');
        await new Promise(function(r) { setTimeout(r, 400); });

        // Build rich confirmation
        var sub = data.subscription || {};
        var order = data.order_summary || {};
        var isLive = data.provision_status === 'live';
        var isSandbox = sub.is_test || order.sandbox;
        var siteUrl = data.website_url || '';
        var planName = order.hosting_plan || sub.plan || WB.hostingPlan;

        // Format subscription period end
        var periodEndStr = '';
        if (sub.period_end) {
            var d = new Date(typeof sub.period_end === 'number' ? sub.period_end * 1000 : sub.period_end);
            periodEndStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }

        // Order lines
        var orderLines = '';
        if (order.domain) {
            orderLines += '<tr><td style="padding:6px 0;color:var(--text2);">' + esc(order.domain) + ' (bundle)</td>' +
                '<td style="text-align:right;font-weight:600;">$' + (order.domain_price || 1).toFixed(2) + '</td></tr>';
        }
        if (planName) {
            orderLines += '<tr><td style="padding:6px 0;color:var(--text2);">' + esc(planName.charAt(0).toUpperCase() + planName.slice(1)) + ' Hosting (Hostinger)</td>' +
                '<td style="text-align:right;font-weight:600;">$' + (order.hosting_price || 10).toFixed(2) + '/mo</td></tr>';
        }
        if (order.wp_pro_addon) {
            orderLines += '<tr><td style="padding:6px 0;color:var(--text2);">WP Pro Updates &amp; Backup</td>' +
                '<td style="text-align:right;font-weight:600;">$15.00/mo</td></tr>';
        }

        // Provisioning status note
        var provisionNote = isLive
            ? '<p style="color:var(--success);font-size:13px;margin-bottom:0;">&#10003; Site is live — visit <a href="' + esc(siteUrl) + '" target="_blank">' + esc(siteUrl) + '</a></p>'
            : '<p style="font-size:13px;color:var(--text2);margin-bottom:6px;">&#128274; A provisioning task has been queued in the HITL panel.</p>' +
              '<p style="font-size:12px;color:var(--text-muted);">Your site will be set up on <strong>' + esc(fqdn) + '</strong> — you\'ll be notified when it\'s live.</p>';

        if (resultEl) {
            resultEl.style.display = '';
            resultEl.innerHTML =
                // Main success header
                '<div style="text-align:center;margin-bottom:20px;">' +
                    '<div style="font-size:48px;margin-bottom:8px;">&#127881;</div>' +
                    '<h3 style="color:var(--success);margin-bottom:4px;">' + (isLive ? 'Site is live!' : 'Order confirmed!') + '</h3>' +
                    '<p style="color:var(--text-muted);font-size:13px;">' + esc(fqdn) + ' — everything is set up.</p>' +
                '</div>' +

                // Subscription badge
                (sub.status
                    ? '<div style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.3);border-radius:8px;padding:10px 14px;margin-bottom:14px;display:flex;align-items:center;gap:10px;">' +
                        '<span style="font-size:18px;">&#9989;</span>' +
                        '<div>' +
                            '<div style="font-weight:600;font-size:13px;">HELM Subscription Active</div>' +
                            '<div style="font-size:12px;color:var(--text-muted);">' +
                                esc(planName ? planName.charAt(0).toUpperCase() + planName.slice(1) + ' plan' : 'Active') +
                                (periodEndStr ? ' &bull; Renews ' + esc(periodEndStr) : '') +
                                (isSandbox ? ' &bull; <em>Sandbox / Test mode</em>' : '') +
                            '</div>' +
                        '</div>' +
                    '</div>'
                    : '') +

                // Order summary
                (orderLines
                    ? '<div style="background:var(--surface2);border-radius:8px;padding:12px 14px;margin-bottom:14px;">' +
                        '<div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em;">Order Summary</div>' +
                        '<table style="width:100%;border-collapse:collapse;font-size:13px;">' + orderLines + '</table>' +
                      '</div>'
                    : '') +

                // Provisioning status
                '<div style="background:var(--surface2);border-radius:8px;padding:12px 14px;margin-bottom:16px;">' +
                    '<div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em;">Site Status</div>' +
                    provisionNote +
                '</div>' +

                // Sandbox notice
                (isSandbox
                    ? '<div style="background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.3);border-radius:8px;padding:10px 14px;font-size:12px;color:#d97706;margin-bottom:14px;">' +
                        '&#9432; <strong>Sandbox mode</strong> — test card used, no real charge.' +
                        ((data.provision_data && data.provision_data.sandbox_subdomain)
                            ? ' Staging site: <strong>' + esc(data.provision_data.sandbox_subdomain) + '</strong>' +
                              (data.provision_data.dns_created ? ' (DNS ✓ auto-created)' : ' (DNS pending)') +
                              ' — WordPress install queued in HITL panel. You\'ll receive credentials by email.'
                            : ' A staging site will be created on boutabyte.cloud and access shared to your email.') +
                      '</div>'
                    : '') +

                '<p style="text-align:center;color:var(--text-muted);font-size:12px;">Advancing to social accounts setup in 3 seconds...</p>' +
                '<div style="text-align:center;margin-top:12px;">' +
                    '<button class="btn btn-primary" onclick="showStep(5)">Continue to Step 5 &rarr;</button>' +
                '</div>';
        }

        // Clean up URL params + advance
        window.history.replaceState({}, '', window.location.pathname);
        setTimeout(function() { showStep(5); }, 4000);

    } catch (err) {
        // Mark all remaining steps as error / skip
        WB_STEPS.forEach(function(s) {
            var iconEl = document.getElementById('wb-step-icon-' + s.id);
            if (iconEl && iconEl.innerHTML === '↻') _wbSetStep(s.id, 'skip');
        });
        _wbSetStep('provision', 'error');

        if (resultEl) {
            resultEl.style.display = '';
            resultEl.innerHTML =
                '<div style="background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.3);border-radius:8px;padding:14px;text-align:center;">' +
                    '<div style="font-size:28px;margin-bottom:8px;">&#9888;</div>' +
                    '<h4 style="margin-bottom:6px;">Payment received</h4>' +
                    '<p style="font-size:13px;color:var(--text-muted);margin-bottom:14px;">' +
                        'Your payment was processed successfully. There was a delay registering your site — our team will follow up shortly.' +
                    '</p>' +
                    '<button class="btn btn-primary" onclick="showStep(5)">Continue to Step 5 &rarr;</button>' +
                '</div>';
        }
    }
}
