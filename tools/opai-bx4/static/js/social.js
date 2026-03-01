/**
 * Bx4 -- Social Wing View
 * Platform health cards, social accounts, manual snapshots, analysis, recommendations.
 */

'use strict';

async function initSocial() {
    var root = document.getElementById('view-root');
    var co = window.BX4.currentCompany;
    if (!co) { root.innerHTML = '<div class="empty-state"><div class="empty-state-title">Select a company</div></div>'; return; }

    root.innerHTML = buildSocialShell(co);

    var results = await Promise.allSettled([
        companyApi('/social/accounts'),
        companyApi('/social/snapshots/latest'),
        companyApi('/recommendations?wing=social&status=pending')
    ]);

    var accounts = results[0].status === 'fulfilled' ? results[0].value : null;
    var snapshots = results[1].status === 'fulfilled' ? results[1].value : null;
    var recs = results[2].status === 'fulfilled' ? results[2].value : null;

    renderPlatformCards(accounts, snapshots);
    renderSocialRecs(recs);
    setupSocialEventListeners();
}

function buildSocialShell(co) {
    return '' +
        '<div class="view-header">' +
            '<div><h1 class="view-title">Social Wing</h1>' +
            '<div class="view-subtitle">' + esc(co.name) + '</div></div>' +
            '<button class="btn btn-primary" onclick="runSocialAnalysis()">Run Social Analysis</button>' +
        '</div>' +

        // Platform Health Cards
        '<div id="social-platforms" class="section-gap"><div class="spinner"></div></div>' +

        // Follower Trend Chart
        '<div class="card section-gap">' +
            '<div class="card-header">' +
                '<h3>Follower Trend</h3>' +
                '<div style="display:flex;align-items:center;gap:8px;">' +
                    '<select id="social-trend-platform" class="form-select" style="width:auto;" onchange="loadSocialTrend()">' +
                        '<option value="">Select platform...</option>' +
                    '</select>' +
                    '<select id="social-trend-days" class="form-select" style="width:auto;" onchange="loadSocialTrend()">' +
                        '<option value="30">30 days</option>' +
                        '<option value="60">60 days</option>' +
                        '<option value="90">90 days</option>' +
                    '</select>' +
                '</div>' +
            '</div>' +
            '<div class="card-body" id="social-trend"><div class="text-muted text-sm">Select a platform above to view trend.</div></div>' +
        '</div>' +

        // Add Social Account
        '<div class="card section-gap">' +
            '<div class="card-header"><h3>Social Accounts</h3><button class="btn btn-sm btn-ghost" onclick="toggleSocialAddAcct()">+ Add Account</button></div>' +
            '<div id="social-add-acct" class="hidden" style="padding:16px;border-bottom:1px solid var(--border);">' +
                '<form id="social-acct-form" class="form-inline">' +
                    '<select class="form-select" id="social-platform" required>' +
                        '<option value="">Platform...</option>' +
                        '<option value="instagram">Instagram</option>' +
                        '<option value="twitter">Twitter/X</option>' +
                        '<option value="facebook">Facebook</option>' +
                        '<option value="linkedin">LinkedIn</option>' +
                        '<option value="tiktok">TikTok</option>' +
                        '<option value="youtube">YouTube</option>' +
                        '<option value="threads">Threads</option>' +
                        '<option value="bluesky">Bluesky</option>' +
                    '</select>' +
                    '<input type="text" class="form-input" id="social-handle" placeholder="@handle or URL" required style="flex:2;">' +
                    '<button type="submit" class="btn btn-sm btn-primary">Add</button>' +
                '</form>' +
            '</div>' +
            '<div class="card-body" id="social-acct-list"></div>' +
        '</div>' +

        // Manual Snapshot Entry
        '<div class="section-gap">' +
            '<div class="collapsible-header" onclick="toggleCollapsible(this)">' +
                '<span class="arrow">&#9654;</span> Enter Analytics Data Manually' +
            '</div>' +
            '<div class="collapsible-body">' +
                '<div class="card"><div class="card-body">' +
                    '<form id="social-snapshot-form" class="form">' +
                        '<div class="form-row">' +
                            '<label class="form-label">Platform<select class="form-select" id="snap-social-platform" required>' +
                                '<option value="">Select...</option>' +
                            '</select></label>' +
                            '<label class="form-label">Date<input type="date" class="form-input" id="snap-social-date"></label>' +
                        '</div>' +
                        '<div class="form-row">' +
                            '<label class="form-label">Followers<input type="number" class="form-input" id="snap-followers" placeholder="0"></label>' +
                            '<label class="form-label">Engagement Rate (%)<input type="number" step="0.01" class="form-input" id="snap-engagement" placeholder="0.00"></label>' +
                        '</div>' +
                        '<div class="form-row">' +
                            '<label class="form-label">Posts This Week<input type="number" class="form-input" id="snap-posts" placeholder="0"></label>' +
                            '<label class="form-label">Impressions<input type="number" class="form-input" id="snap-impressions" placeholder="0"></label>' +
                        '</div>' +
                        '<div><button type="submit" class="btn btn-primary">Save Snapshot</button></div>' +
                    '</form>' +
                '</div></div>' +
            '</div>' +
        '</div>' +

        // Recommendations
        '<div class="card section-gap">' +
            '<div class="card-header"><h3>Social Recommendations</h3></div>' +
            '<div class="card-body" id="social-recs"><div class="spinner"></div></div>' +
        '</div>';
}

var PLATFORM_ICONS = {
    instagram: '&#x1F4F7;',
    twitter: '&#x1F426;',
    facebook: '&#x1F465;',
    linkedin: '&#x1F4BC;',
    tiktok: '&#x1F3B5;',
    youtube: '&#x25B6;&#xFE0F;',
    threads: '&#x1F9F5;',
    bluesky: '&#x1F30D;'
};

function renderPlatformCards(accountsData, snapshotsData) {
    var el = document.getElementById('social-platforms');
    var accounts = accountsData && accountsData.accounts ? accountsData.accounts : (Array.isArray(accountsData) ? accountsData : []);
    var snapshots = snapshotsData && snapshotsData.snapshots ? snapshotsData.snapshots : (Array.isArray(snapshotsData) ? snapshotsData : []);

    // Populate the trend platform dropdown
    var trendSelect = document.getElementById('social-trend-platform');
    if (trendSelect) {
        trendSelect.innerHTML = '<option value="">Select platform...</option>';
        accounts.forEach(function(a) {
            trendSelect.innerHTML += '<option value="' + esc(a.id) + '">' + esc(a.platform) + (a.handle ? ' - ' + esc(a.handle) : '') + '</option>';
        });
    }

    // Also populate the snapshot form platform dropdown
    var snapSelect = document.getElementById('snap-social-platform');
    if (snapSelect) {
        snapSelect.innerHTML = '<option value="">Select...</option>';
        accounts.forEach(function(a) {
            snapSelect.innerHTML += '<option value="' + esc(a.id) + '">' + esc(a.platform) + ' - ' + esc(a.handle) + '</option>';
        });
    }

    // Render account list
    var acctListEl = document.getElementById('social-acct-list');
    if (accounts.length === 0) {
        acctListEl.innerHTML = '<div class="text-muted text-sm">No social accounts connected yet.</div>';
    } else {
        var listHtml = '<div class="table-wrap"><table><thead><tr><th>Platform</th><th>Handle</th><th>Status</th><th>Last Sync</th><th></th></tr></thead><tbody>';
        accounts.forEach(function(a) {
            var syncBtn = a.property_id
                ? '<button class="btn btn-sm btn-ghost" onclick="syncGaSocial(\'' + esc(a.id) + '\')">Sync GA4</button> '
                : '';
            listHtml += '<tr>' +
                '<td>' + (PLATFORM_ICONS[a.platform] || '') + ' ' + esc(a.platform) + '</td>' +
                '<td>' + esc(a.handle || '--') + '</td>' +
                '<td><span class="badge badge-success">Active</span></td>' +
                '<td>' + (a.last_sync_at ? timeAgo(a.last_sync_at) : '--') + '</td>' +
                '<td>' + syncBtn + '<button class="btn-icon" onclick="deleteSocialAcct(\'' + esc(a.id) + '\')" title="Remove" style="color:var(--danger);">&#x2715;</button></td>' +
            '</tr>';
        });
        listHtml += '</tbody></table></div>';
        acctListEl.innerHTML = listHtml;
    }

    if (accounts.length === 0) {
        el.innerHTML =
            '<div class="empty-state">' +
                '<span class="empty-state-icon">&#x1F4F1;</span>' +
                '<div class="empty-state-title">No Social Accounts</div>' +
                '<div class="empty-state-msg">Add your social media accounts to track performance.</div>' +
                '<button class="btn btn-outline" onclick="toggleSocialAddAcct()">+ Add Social Account</button>' +
            '</div>';
        return;
    }

    // Build snapshot lookup by account id
    var snapMap = {};
    snapshots.forEach(function(s) {
        var key = s.account_id || s.platform;
        if (!snapMap[key]) snapMap[key] = s;
    });

    var html = '<div class="platform-grid">';
    accounts.forEach(function(acct) {
        var snap = snapMap[acct.id] || snapMap[acct.platform] || {};
        var prevSnap = snap.previous || {};
        var followers = snap.followers || 0;
        var prevFollowers = prevSnap.followers || 0;
        var delta = followers - prevFollowers;
        var deltaStr = delta > 0 ? '+' + fmtNum(delta) : (delta < 0 ? fmtNum(delta) : '0');
        var deltaCls = delta > 0 ? 'positive' : (delta < 0 ? 'negative' : '');
        var engRate = snap.engagement_rate || 0;
        var freqGrade = snap.frequency_grade || '--';
        var healthScore = snap.health_score || 0;

        html += '<div class="platform-card">' +
            '<div class="platform-header">' +
                '<span class="platform-icon">' + (PLATFORM_ICONS[acct.platform] || '&#x1F4F1;') + '</span>' +
                '<span class="platform-name">' + esc(acct.platform) + '</span>' +
            '</div>' +
            '<div class="platform-stat">' +
                '<span class="platform-stat-label">Followers</span>' +
                '<span class="platform-stat-value">' + fmtNum(followers) + ' <span class="platform-delta ' + deltaCls + '">' + deltaStr + ' WoW</span></span>' +
            '</div>' +
            '<div class="platform-stat">' +
                '<span class="platform-stat-label">Engagement Rate</span>' +
                '<span class="platform-stat-value">' + engRate.toFixed(2) + '%</span>' +
            '</div>' +
            '<div class="platform-stat">' +
                '<span class="platform-stat-label">Frequency Grade</span>' +
                '<span class="platform-stat-value"><span class="wing-grade ' + gradeClass(freqGrade) + '">' + esc(freqGrade) + '</span></span>' +
            '</div>' +
            '<div class="mt-12">' +
                '<div class="progress-wrap">' +
                    '<div class="progress-header"><span class="progress-label">Health</span><span class="progress-value">' + Math.round(healthScore) + '</span></div>' +
                    '<div class="progress-bar"><div class="progress-fill ' + fillClass(healthScore) + '" style="width:' + healthScore + '%;"></div></div>' +
                '</div>' +
            '</div>' +
        '</div>';
    });
    html += '</div>';
    el.innerHTML = html;
}

function renderSocialRecs(data) {
    var el = document.getElementById('social-recs');
    var items = data && data.recommendations ? data.recommendations : (Array.isArray(data) ? data : []);

    if (items.length === 0) {
        el.innerHTML = '<div class="text-muted text-sm">No social recommendations. Run an analysis to generate them.</div>';
        return;
    }

    var html = '<div class="rec-cards">';
    items.forEach(function(rec) {
        html += '<div class="rec-card">' +
            '<div class="rec-card-header">' + urgencyBadge(rec.urgency) + ' <span class="rec-card-title">' + esc(rec.title) + '</span></div>' +
            '<div class="rec-card-reasoning">' + esc(rec.reasoning || rec.summary || '') + '</div>' +
        '</div>';
    });
    html += '</div>';
    el.innerHTML = html;
}

// ── Event Listeners & Actions ────────────────────────────────────────────────
function setupSocialEventListeners() {
    // Add account form
    var acctForm = document.getElementById('social-acct-form');
    if (acctForm) {
        acctForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            try {
                await companyApi('/social/accounts', {
                    method: 'POST',
                    body: {
                        platform: document.getElementById('social-platform').value,
                        handle: document.getElementById('social-handle').value.trim()
                    }
                });
                showToast('Social account added', 'success');
                acctForm.reset();
                document.getElementById('social-add-acct').classList.add('hidden');
                initSocial();
            } catch (err) {
                showToast('Failed: ' + err.message, 'error');
            }
        });
    }

    // Manual snapshot form
    var snapForm = document.getElementById('social-snapshot-form');
    if (snapForm) {
        snapForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            var accountId = document.getElementById('snap-social-platform').value;
            if (!accountId) { showToast('Select a platform', 'warning'); return; }
            try {
                await companyApi('/social/snapshots', {
                    method: 'POST',
                    body: {
                        account_id: accountId,
                        date: document.getElementById('snap-social-date').value || null,
                        followers: parseInt(document.getElementById('snap-followers').value) || 0,
                        engagement_rate: parseFloat(document.getElementById('snap-engagement').value) || 0,
                        posts_count: parseInt(document.getElementById('snap-posts').value) || 0,
                        impressions: parseInt(document.getElementById('snap-impressions').value) || 0
                    }
                });
                showToast('Snapshot saved', 'success');
                snapForm.reset();
                initSocial();
            } catch (err) {
                showToast('Failed: ' + err.message, 'error');
            }
        });
    }
}

function toggleSocialAddAcct() {
    document.getElementById('social-add-acct').classList.toggle('hidden');
}

async function runSocialAnalysis() {
    showToast('Running social analysis...', 'info');
    try {
        await companyApi('/advisor/analyze', { method: 'POST', body: { wing: 'social' } });
        showToast('Social analysis complete', 'success');
        initSocial();
    } catch (err) {
        showToast('Analysis failed: ' + err.message, 'error');
    }
}

async function deleteSocialAcct(id) {
    if (!confirm('Remove this social account?')) return;
    try {
        await companyApi('/social/accounts/' + id, { method: 'DELETE' });
        showToast('Account removed', 'success');
        initSocial();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

// ── Trend Chart ──────────────────────────────────────────────────────────────

async function loadSocialTrend() {
    var acctId = document.getElementById('social-trend-platform').value;
    var days   = document.getElementById('social-trend-days').value || '30';
    var el     = document.getElementById('social-trend');
    if (!acctId) { el.innerHTML = '<div class="text-muted text-sm">Select a platform above.</div>'; return; }
    el.innerHTML = '<div class="spinner"></div>';
    try {
        var data = await companyApi('/social/snapshots/trend?account_id=' + acctId + '&days=' + days);
        var points = Array.isArray(data) ? data : (data.trend || []);
        if (points.length === 0) {
            el.innerHTML = '<div class="text-muted text-sm">No trend data yet — sync or enter snapshots for this platform.</div>';
            return;
        }
        var maxF = Math.max.apply(null, points.map(function(p) { return p.followers || 0; }));
        var maxE = Math.max.apply(null, points.map(function(p) { return p.engagement_rate || 0; }));
        if (maxF === 0) maxF = 1;
        if (maxE === 0) maxE = 1;

        var html = '<div class="social-trend-chart">';
        points.forEach(function(p) {
            var fPct = Math.round(((p.followers || 0) / maxF) * 100);
            var ePct = Math.round(((p.engagement_rate || 0) / maxE) * 80); // cap at 80% so both bars visible
            var label = (p.date || p.created_at || '').slice(5, 10);
            html += '<div class="stb-bar-group">' +
                '<div class="stb-bars">' +
                    '<div class="stb-bar stb-followers" style="height:' + fPct + '%;" title="Followers: ' + fmtNum(p.followers || 0) + '"></div>' +
                    '<div class="stb-bar stb-engagement" style="height:' + ePct + '%;" title="Engagement: ' + (p.engagement_rate || 0).toFixed(2) + '%"></div>' +
                '</div>' +
                '<div class="stb-label">' + esc(label) + '</div>' +
            '</div>';
        });
        html += '</div>' +
            '<div class="cf-legend mt-8">' +
                '<span class="cf-leg-dot" style="background:var(--primary);"></span> Followers &nbsp;&nbsp;' +
                '<span class="cf-leg-dot" style="background:#9b59b6;"></span> Engagement Rate' +
            '</div>';
        el.innerHTML = html;
    } catch (err) {
        el.innerHTML = '<div class="text-sm" style="color:var(--danger);">Failed: ' + esc(err.message) + '</div>';
    }
}

async function syncGaSocial(accountId) {
    showToast('Syncing GA4 data...', 'info');
    try {
        var data = await companyApi('/social/accounts/' + accountId + '/sync', { method: 'POST' });
        var users = data && data.snapshot ? fmtNum(data.snapshot.followers || 0) : '—';
        showToast('GA4 synced — ' + users + ' total users', 'success');
        initSocial();
    } catch (err) {
        showToast('GA4 sync failed: ' + err.message, 'error');
    }
}

// Expose globally
window.toggleSocialAddAcct = toggleSocialAddAcct;
window.runSocialAnalysis    = runSocialAnalysis;
window.deleteSocialAcct     = deleteSocialAcct;
window.loadSocialTrend      = loadSocialTrend;
window.syncGaSocial         = syncGaSocial;
