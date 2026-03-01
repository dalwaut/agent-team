/**
 * Bx4 -- Market Wing View
 * Market analysis, SWOT, competitors, recommendations, industry news.
 */

'use strict';

async function initMarket() {
    var root = document.getElementById('view-root');
    var co = window.BX4.currentCompany;
    if (!co) { root.innerHTML = '<div class="empty-state"><div class="empty-state-title">Select a company</div></div>'; return; }

    root.innerHTML = buildMarketShell(co);

    var results = await Promise.allSettled([
        companyApi('/market/analysis/latest'),
        companyApi('/market/competitors'),
        companyApi('/recommendations?wing=market&status=pending'),
        companyApi('/market/news'),
        companyApi('/market/swot/latest')
    ]);

    var analysis    = results[0].status === 'fulfilled' ? results[0].value : null;
    var competitors = results[1].status === 'fulfilled' ? results[1].value : null;
    var recs        = results[2].status === 'fulfilled' ? results[2].value : null;
    var news        = results[3].status === 'fulfilled' ? results[3].value : null;
    var swot        = results[4].status === 'fulfilled' ? results[4].value : null;

    renderMarketAnalysis(analysis);
    renderSwot(swot || analysis);
    renderMarketNews(news);
    renderCompetitors(competitors);
    renderMarketRecs(recs);
    setupMarketEventListeners();
}

function buildMarketShell(co) {
    return '' +
        '<div class="view-header">' +
            '<div><h1 class="view-title">Market Wing</h1>' +
            '<div class="view-subtitle">' + esc(co.name) + '</div></div>' +
            '<div style="display:flex;align-items:center;gap:12px;">' +
                '<span class="text-sm text-muted" id="mkt-last-run"></span>' +
                '<button class="btn btn-primary" onclick="runMarketAnalysis()">Run Market Analysis</button>' +
            '</div>' +
        '</div>' +

        // Latest Analysis
        '<div class="card section-gap">' +
            '<div class="card-header"><h3>Latest Market Analysis</h3></div>' +
            '<div class="card-body" id="mkt-analysis"><div class="spinner"></div></div>' +
        '</div>' +

        // SWOT
        '<div class="section-gap">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
                '<div class="section-title" style="margin-bottom:0;">SWOT Analysis</div>' +
                '<button class="btn btn-sm btn-ghost" onclick="autoSwot()">Auto-Draft</button>' +
            '</div>' +
            '<div id="mkt-swot"><div class="spinner"></div></div>' +
        '</div>' +

        // Industry News
        '<div class="card section-gap">' +
            '<div class="card-header">' +
                '<h3>Industry News</h3>' +
                '<button class="btn btn-sm btn-ghost" onclick="refreshMarketNews()">Fetch Latest</button>' +
            '</div>' +
            '<div class="card-body" id="mkt-news"><div class="spinner"></div></div>' +
        '</div>' +

        // Competitors
        '<div class="card section-gap">' +
            '<div class="card-header"><h3>Competitors</h3><button class="btn btn-sm btn-ghost" onclick="toggleMktAddCompetitor()">+ Add Competitor</button></div>' +
            '<div id="mkt-add-competitor" class="hidden" style="padding:16px;border-bottom:1px solid var(--border);">' +
                '<form id="mkt-competitor-form" class="form-inline">' +
                    '<input type="text" class="form-input" id="comp-name" placeholder="Company name" required>' +
                    '<input type="url" class="form-input" id="comp-website" placeholder="https://...">' +
                    '<input type="text" class="form-input" id="comp-notes" placeholder="Notes" style="flex:2;">' +
                    '<button type="submit" class="btn btn-sm btn-primary">Add</button>' +
                '</form>' +
            '</div>' +
            '<div class="card-body" id="mkt-competitors"><div class="spinner"></div></div>' +
        '</div>' +

        // Recommendations
        '<div class="card section-gap">' +
            '<div class="card-header"><h3>Market Recommendations</h3></div>' +
            '<div class="card-body" id="mkt-recs"><div class="spinner"></div></div>' +
        '</div>' +

        // Positioning Map
        '<div class="card section-gap">' +
            '<div class="card-header">' +
                '<h3>Positioning Map</h3>' +
                '<button class="btn btn-sm btn-ghost" onclick="generatePositioningMap()">Generate Map</button>' +
            '</div>' +
            '<div class="card-body" id="mkt-positioning"><div class="text-muted text-sm">Generate a 2×2 competitive positioning map.</div></div>' +
        '</div>';
}

function renderMarketAnalysis(data) {
    var el = document.getElementById('mkt-analysis');
    var lastRunEl = document.getElementById('mkt-last-run');

    if (!data || !data.analysis) {
        el.innerHTML = '<div class="text-muted text-sm">No market analysis yet. Click "Run Market Analysis" to begin.</div>';
        lastRunEl.textContent = '';
        return;
    }

    var a = data.analysis || data;
    lastRunEl.textContent = 'Last run: ' + timeAgo(a.created_at || a.analyzed_at);

    var summary = a.summary || a.findings_json?.summary || '';
    var marketPosition = a.market_position || a.findings_json?.market_position || '';
    var trends = a.trends || a.findings_json?.trends || [];

    var html = '';
    if (summary) {
        html += '<div style="white-space:pre-wrap;font-size:13px;color:var(--text-2);line-height:1.7;margin-bottom:16px;">' + esc(summary) + '</div>';
    }
    if (marketPosition) {
        html += '<div class="mb-12"><strong>Market Position:</strong> <span class="text-muted">' + esc(marketPosition) + '</span></div>';
    }
    if (trends.length > 0) {
        html += '<div class="mb-8"><strong>Key Trends:</strong></div><ul style="list-style:disc;padding-left:20px;">';
        trends.forEach(function(t) { html += '<li class="text-sm text-muted mb-8">' + esc(typeof t === 'string' ? t : t.description || t.title || '') + '</li>'; });
        html += '</ul>';
    }
    if (!html) html = '<div class="text-muted text-sm">Analysis data available but no summary.</div>';

    el.innerHTML = html;
}

function renderSwot(data) {
    var el = document.getElementById('mkt-swot');
    var swot = data && (data.swot || (data.analysis && data.analysis.swot) || (data.findings_json && data.findings_json.swot));

    if (!swot) {
        el.innerHTML = '<div class="text-muted text-sm">SWOT analysis will appear after running a market analysis.</div>';
        return;
    }

    el.innerHTML =
        '<div class="swot-grid">' +
            buildSwotCell('Strengths', 'strengths', swot.strengths || []) +
            buildSwotCell('Weaknesses', 'weaknesses', swot.weaknesses || []) +
            buildSwotCell('Opportunities', 'opportunities', swot.opportunities || []) +
            buildSwotCell('Threats', 'threats', swot.threats || []) +
        '</div>';
}

function buildSwotCell(title, cls, items) {
    var listHtml = '';
    if (items.length === 0) {
        listHtml = '<li class="text-muted">None identified</li>';
    } else {
        items.forEach(function(item) {
            listHtml += '<li>' + esc(typeof item === 'string' ? item : item.description || item.title || '') + '</li>';
        });
    }
    return '<div class="swot-cell ' + cls + '"><h4>' + esc(title) + '</h4><ul>' + listHtml + '</ul></div>';
}

function renderCompetitors(data) {
    var el = document.getElementById('mkt-competitors');
    var comps = data && data.competitors ? data.competitors : (Array.isArray(data) ? data : []);

    if (comps.length === 0) {
        el.innerHTML = '<div class="empty-state" style="padding:20px;"><div class="empty-state-title">No competitors tracked</div>' +
            '<div class="empty-state-msg">Add competitors to monitor market positioning.</div></div>';
        return;
    }

    var html = '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Website</th><th>Notes</th><th>Last Research</th><th></th></tr></thead><tbody>';
    comps.forEach(function(c) {
        html += '<tr>' +
            '<td>' +
                '<strong>' + esc(c.name) + '</strong>' +
                (c.intel_summary ? '<div class="text-sm text-muted mt-4" style="font-size:11px;line-height:1.4;max-width:300px;">' + esc(c.intel_summary.slice(0, 140)) + (c.intel_summary.length > 140 ? '…' : '') + '</div>' : '') +
            '</td>' +
            '<td>' + (c.website ? '<a href="' + esc(c.website) + '" target="_blank" style="color:var(--primary);">' + esc(c.website) + '</a>' : '--') + '</td>' +
            '<td class="text-muted">' + esc(c.notes || '--') + '</td>' +
            '<td class="text-muted">' + (c.last_research_at ? timeAgo(c.last_research_at) : '--') + '</td>' +
            '<td style="white-space:nowrap;">' +
                '<button class="btn-icon" onclick="researchCompetitor(\'' + esc(c.id) + '\')" title="Research">&#x1F50D;</button>' +
                '<button class="btn-icon" onclick="editCompetitor(\'' + esc(c.id) + '\')" title="Edit">&#x270E;</button>' +
                '<button class="btn-icon" onclick="deleteCompetitor(\'' + esc(c.id) + '\')" title="Delete" style="color:var(--danger);">&#x2715;</button>' +
            '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    el.innerHTML = html;
}

function renderMarketRecs(data) {
    var el = document.getElementById('mkt-recs');
    var items = data && data.recommendations ? data.recommendations : (Array.isArray(data) ? data : []);

    if (items.length === 0) {
        el.innerHTML = '<div class="text-muted text-sm">No market recommendations. Run an analysis to generate them.</div>';
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

function renderMarketNews(data) {
    var el = document.getElementById('mkt-news');
    if (!el) return;
    var news = Array.isArray(data) ? data : (data && data.news ? data.news : []);

    if (news.length === 0) {
        el.innerHTML = '<div class="text-muted text-sm">No industry news cached. Click "Fetch Latest" to search.</div>';
        return;
    }

    var html = '<div class="action-list">';
    news.forEach(function(item) {
        html += '<div class="action-item">' +
            '<div class="action-item-body">' +
                '<div class="action-item-title">' + esc(item.headline || item.title || '') + '</div>' +
                '<div class="action-item-summary">' + esc(item.summary || item.description || '') + '</div>' +
                '<div class="text-sm text-muted mt-8">' +
                    (item.source ? esc(item.source) : '') +
                    (item.published_date ? ' &mdash; ' + esc(item.published_date) : '') +
                '</div>' +
            '</div>' +
        '</div>';
    });
    html += '</div>';
    el.innerHTML = html;
}

// ── Event Listeners & Actions ────────────────────────────────────────────────
function setupMarketEventListeners() {
    var compForm = document.getElementById('mkt-competitor-form');
    if (compForm) {
        compForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            try {
                await companyApi('/market/competitors', {
                    method: 'POST',
                    body: {
                        name: document.getElementById('comp-name').value.trim(),
                        website: document.getElementById('comp-website').value.trim() || null,
                        notes: document.getElementById('comp-notes').value.trim() || null
                    }
                });
                showToast('Competitor added', 'success');
                compForm.reset();
                document.getElementById('mkt-add-competitor').classList.add('hidden');
                var competitors = await companyApi('/market/competitors');
                renderCompetitors(competitors);
            } catch (err) {
                showToast('Failed: ' + err.message, 'error');
            }
        });
    }
}

function toggleMktAddCompetitor() {
    document.getElementById('mkt-add-competitor').classList.toggle('hidden');
}

async function runMarketAnalysis() {
    showToast('Running market analysis...', 'info');
    try {
        await companyApi('/advisor/analyze', { method: 'POST', body: { wing: 'market' } });
        showToast('Market analysis complete', 'success');
        initMarket();
    } catch (err) {
        showToast('Analysis failed: ' + err.message, 'error');
    }
}

async function editCompetitor(id) {
    var name = prompt('Enter new name (or cancel):');
    if (name === null) return;
    try {
        await companyApi('/market/competitors/' + id, { method: 'PATCH', body: { name: name.trim() } });
        showToast('Competitor updated', 'success');
        var competitors = await companyApi('/market/competitors');
        renderCompetitors(competitors);
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

async function deleteCompetitor(id) {
    if (!confirm('Delete this competitor?')) return;
    try {
        await companyApi('/market/competitors/' + id, { method: 'DELETE' });
        showToast('Competitor deleted', 'success');
        var competitors = await companyApi('/market/competitors');
        renderCompetitors(competitors);
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

// ── News, SWOT, Positioning, Competitor Research ──────────────────────────────

async function refreshMarketNews() {
    var el = document.getElementById('mkt-news');
    el.innerHTML = '<div class="flex-center gap-8"><div class="spinner"></div> Searching for industry news...</div>';
    try {
        await companyApi('/market/news/refresh', { method: 'POST' });
        var news = await companyApi('/market/news');
        renderMarketNews(news);
        showToast('Industry news updated', 'success');
    } catch (err) {
        el.innerHTML = '<div class="text-sm" style="color:var(--danger);">Failed: ' + esc(err.message) + '</div>';
    }
}

async function autoSwot() {
    showToast('Drafting SWOT analysis...', 'info');
    try {
        var data = await companyApi('/market/swot', { method: 'POST' });
        renderSwot(data);
        showToast('SWOT analysis drafted', 'success');
    } catch (err) {
        showToast('SWOT failed: ' + err.message, 'error');
    }
}

async function generatePositioningMap() {
    var el = document.getElementById('mkt-positioning');
    el.innerHTML = '<div class="flex-center gap-8"><div class="spinner"></div> Generating map...</div>';
    try {
        var data = await companyApi('/market/positioning');
        renderPositioningMap(data, el);
    } catch (err) {
        el.innerHTML = '<div class="text-sm" style="color:var(--danger);">Failed: ' + esc(err.message) + '</div>';
    }
}

function renderPositioningMap(data, el) {
    if (!el) el = document.getElementById('mkt-positioning');
    if (!data || !data.positions || data.positions.length === 0) {
        el.innerHTML = '<div class="text-muted text-sm">No positioning data. Add competitors and generate again.</div>';
        return;
    }

    var xLabel = data.x_label || 'Price';
    var yLabel = data.y_label || 'Quality';
    var positions = data.positions || [];

    var html = '<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start;">' +
        '<div class="pos-map-wrap">' +
            '<div class="pos-quadrant pos-q-tl"></div>' +
            '<div class="pos-quadrant pos-q-tr"></div>' +
            '<div class="pos-quadrant pos-q-bl"></div>' +
            '<div class="pos-quadrant pos-q-br"></div>' +
            '<div class="pos-axis-x">' + esc(xLabel) + ' &#8594;</div>' +
            '<div class="pos-axis-y">&#8593; ' + esc(yLabel) + '</div>';

    positions.forEach(function(p) {
        var left = Math.round((p.x / 10) * 86 + 7);
        var top  = Math.round((1 - p.y / 10) * 86 + 7);
        html += '<div class="pos-dot' + (p.is_self ? ' self' : '') + '" style="left:' + left + '%;top:' + top + '%;" title="' + esc(p.name) + '"></div>' +
            '<div class="pos-dot-label" style="left:' + left + '%;top:' + top + '%;">' + esc(p.name) + '</div>';
    });

    html += '</div>' +
        // Legend
        '<div class="text-sm" style="color:var(--text-muted);line-height:1.8;">' +
            '<div style="margin-bottom:8px;font-weight:600;">Entities</div>';
    positions.forEach(function(p) {
        html += '<div style="display:flex;align-items:center;gap:6px;">' +
            '<span style="width:10px;height:10px;border-radius:50%;background:' + (p.is_self ? 'var(--primary)' : 'var(--text-muted)') + ';display:inline-block;flex-shrink:0;"></span>' +
            '<span>' + esc(p.name) + ' (' + p.x + ', ' + p.y + ')</span>' +
        '</div>';
    });
    html += '</div></div>';

    el.innerHTML = html;
}

async function researchCompetitor(compId) {
    showToast('Researching competitor...', 'info');
    try {
        await companyApi('/market/competitors/' + compId + '/research', { method: 'POST' });
        showToast('Research complete — intel saved', 'success');
        var comps = await companyApi('/market/competitors');
        renderCompetitors(comps);
    } catch (err) {
        showToast('Research failed: ' + err.message, 'error');
    }
}

// Expose globally
window.toggleMktAddCompetitor  = toggleMktAddCompetitor;
window.runMarketAnalysis        = runMarketAnalysis;
window.editCompetitor           = editCompetitor;
window.deleteCompetitor         = deleteCompetitor;
window.refreshMarketNews        = refreshMarketNews;
window.autoSwot                 = autoSwot;
window.generatePositioningMap   = generatePositioningMap;
window.researchCompetitor       = researchCompetitor;
