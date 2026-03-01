/**
 * Bx4 -- Portfolio View (admin only)
 * Multi-company health overview at a glance.
 */

'use strict';

async function initPortfolio() {
    var root = document.getElementById('view-root');
    if (!window.BX4.isAdmin) {
        root.innerHTML = '<div class="empty-state"><div class="empty-state-title">Admin Only</div><div class="empty-state-msg">Portfolio view is available to administrators.</div></div>';
        return;
    }

    root.innerHTML = buildPortfolioShell();

    try {
        var data = await api('/api/portfolio');
        renderPortfolio(data);
    } catch (err) {
        document.getElementById('portfolio-grid').innerHTML =
            '<div class="text-sm" style="color:var(--danger);">Failed to load portfolio: ' + esc(err.message) + '</div>';
    }
}

function buildPortfolioShell() {
    return '' +
        '<div class="view-header">' +
            '<div><h1 class="view-title">Portfolio Overview</h1>' +
            '<div class="view-subtitle">All companies — admin view</div></div>' +
            '<button class="btn btn-sm btn-outline" onclick="initPortfolio()">&#x21BB; Refresh</button>' +
        '</div>' +

        // Summary Bar
        '<div class="card section-gap">' +
            '<div class="card-body" id="portfolio-summary"><div class="spinner"></div></div>' +
        '</div>' +

        // Company Grid
        '<div id="portfolio-grid" class="section-gap"><div class="spinner"></div></div>';
}

function renderPortfolio(data) {
    var companies = data && data.companies ? data.companies : (Array.isArray(data) ? data : []);

    // Summary
    var summaryEl = document.getElementById('portfolio-summary');
    var total = companies.length;
    var healthy = companies.filter(function(c) { return (c.health_score || 0) >= 70; }).length;
    var warning = companies.filter(function(c) { var s = c.health_score || 0; return s >= 40 && s < 70; }).length;
    var critical = companies.filter(function(c) { return (c.health_score || 0) < 40; }).length;

    summaryEl.innerHTML =
        '<div class="snapshot-grid">' +
            buildSnapshotItem('Total Companies', total, '') +
            buildSnapshotItem('Healthy (≥70)', healthy, 'amount-positive') +
            buildSnapshotItem('Warning (40-69)', warning, '') +
            buildSnapshotItem('Critical (<40)', critical, critical > 0 ? 'amount-negative' : '') +
        '</div>';

    if (companies.length === 0) {
        document.getElementById('portfolio-grid').innerHTML =
            '<div class="empty-state"><div class="empty-state-title">No companies</div><div class="empty-state-msg">Create a company to get started.</div></div>';
        return;
    }

    // Sort: critical first, then by health score asc
    companies.sort(function(a, b) { return (a.health_score || 0) - (b.health_score || 0); });

    var html = '<div class="platform-grid">';
    companies.forEach(function(co) {
        var score = co.health_score != null ? Math.round(co.health_score) : null;
        var grade = co.health_grade || '--';
        var triage = score != null && score < 40;

        html += '<div class="platform-card' + (triage ? ' triage-card' : '') + '" style="cursor:pointer;" onclick="switchToCompany(\'' + esc(co.id) + '\')">' +
            '<div class="platform-header">' +
                '<span class="platform-icon">' + esc((co.name || 'Co')[0].toUpperCase()) + '</span>' +
                '<span class="platform-name">' + esc(co.name) + '</span>' +
                (triage ? '<span class="badge badge-danger" style="margin-left:auto;font-size:10px;">TRIAGE</span>' : '') +
            '</div>' +
            '<div class="platform-stat">' +
                '<span class="platform-stat-label">Health</span>' +
                '<span class="platform-stat-value ' + scoreClass(score) + '">' + (score != null ? score + '/100' : '--') + ' <span class="wing-grade ' + gradeClass(grade) + '">' + esc(grade) + '</span></span>' +
            '</div>' +
            (co.industry ? '<div class="platform-stat"><span class="platform-stat-label">Industry</span><span class="platform-stat-value text-muted">' + esc(co.industry) + '</span></div>' : '') +
            (co.stage ? '<div class="platform-stat"><span class="platform-stat-label">Stage</span><span class="platform-stat-value text-muted">' + esc(co.stage) + '</span></div>' : '') +
            '<div class="mt-12">' +
                '<div class="progress-bar"><div class="progress-fill ' + fillClass(score || 0) + '" style="width:' + (score || 0) + '%;"></div></div>' +
            '</div>' +
            '<div class="text-sm text-muted mt-8" style="font-size:11px;">Click to open</div>' +
        '</div>';
    });
    html += '</div>';
    document.getElementById('portfolio-grid').innerHTML = html;
}

function buildSnapshotItem(label, value, cls) {
    return '<div class="snapshot-item">' +
        '<div class="snapshot-label">' + esc(label) + '</div>' +
        '<div class="snapshot-value ' + cls + '">' + value + '</div>' +
    '</div>';
}

function switchToCompany(companyId) {
    // Switch current company and go to dashboard
    if (window.BX4 && window.BX4.companies) {
        var co = window.BX4.companies.find(function(c) { return c.id === companyId; });
        if (co) {
            window.BX4.currentCompany = co;
            var sel = document.getElementById('company-select');
            if (sel) sel.value = companyId;
            renderView('dashboard');
        }
    }
}

// Expose globally
window.initPortfolio   = initPortfolio;
window.switchToCompany = switchToCompany;
