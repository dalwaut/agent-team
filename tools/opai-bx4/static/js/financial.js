/**
 * Bx4 -- Financial Wing View
 * Health score, snapshots, transactions, P&L upload, accounts, recommendations.
 */

'use strict';

var _finPage = 1;
var _finPageSize = 20;

async function initFinancial() {
    var root = document.getElementById('view-root');
    var co = window.BX4.currentCompany;
    if (!co) { root.innerHTML = '<div class="empty-state"><div class="empty-state-title">Select a company</div></div>'; return; }

    root.innerHTML = buildFinancialShell(co);

    // Load data in parallel
    var results = await Promise.allSettled([
        companyApi('/financial/health'),
        companyApi('/financial/snapshots?limit=1'),
        companyApi('/financial/transactions?page=1&limit=' + _finPageSize),
        companyApi('/financial/accounts'),
        companyApi('/recommendations?wing=financial&status=pending'),
        companyApi('/financial/cashflow?days=90'),
        companyApi('/financial/revenue-breakdown'),
        companyApi('/financial/tax-estimate')
    ]);

    var health    = results[0].status === 'fulfilled' ? results[0].value : null;
    var snapshot  = results[1].status === 'fulfilled' ? results[1].value : null;
    var txns      = results[2].status === 'fulfilled' ? results[2].value : null;
    var accounts  = results[3].status === 'fulfilled' ? results[3].value : null;
    var recs      = results[4].status === 'fulfilled' ? results[4].value : null;
    var cashflow  = results[5].status === 'fulfilled' ? results[5].value : null;
    var breakdown = results[6].status === 'fulfilled' ? results[6].value : null;
    var taxEst    = results[7].status === 'fulfilled' ? results[7].value : null;

    renderFinHealthScore(health);
    renderFinSnapshot(snapshot);
    renderCashFlow(cashflow);
    renderRevenueBreakdown(breakdown);
    renderTaxEstimate(taxEst);
    renderFinTransactions(txns);
    renderFinAccounts(accounts);
    renderFinRecommendations(recs);
    setupFinEventListeners();
}

function buildFinancialShell(co) {
    return '' +
        '<div class="view-header">' +
            '<div><h1 class="view-title">Financial Wing</h1>' +
            '<div class="view-subtitle">' + esc(co.name) + '</div></div>' +
            '<button class="btn btn-primary" onclick="runFinancialAnalysis()">Run Financial Analysis</button>' +
        '</div>' +

        // Health Score
        '<div class="card section-gap">' +
            '<div class="card-header"><h3>Financial Health Score</h3></div>' +
            '<div class="card-body" id="fin-health"><div class="spinner"></div></div>' +
        '</div>' +

        // Snapshot Row
        '<div id="fin-snapshot" class="section-gap"><div class="spinner"></div></div>' +

        // Cash Flow Chart
        '<div class="card section-gap">' +
            '<div class="card-header">' +
                '<h3>Cash Flow — 90 Day View</h3>' +
                '<span class="text-muted text-sm">Actuals + 3-band forecast</span>' +
            '</div>' +
            '<div class="card-body" id="fin-cashflow"><div class="spinner"></div></div>' +
        '</div>' +

        // Revenue Breakdown
        '<div class="card section-gap">' +
            '<div class="card-header"><h3>Revenue Breakdown</h3></div>' +
            '<div class="card-body" id="fin-revenue-breakdown"><div class="spinner"></div></div>' +
        '</div>' +

        // Add Snapshot (collapsible)
        '<div class="section-gap">' +
            '<div class="collapsible-header" onclick="toggleCollapsible(this)">' +
                '<span class="arrow">&#9654;</span> Add Financial Snapshot' +
            '</div>' +
            '<div class="collapsible-body">' +
                '<div class="card"><div class="card-body">' +
                    '<form id="fin-snapshot-form" class="form">' +
                        '<div class="form-row">' +
                            '<label class="form-label">Revenue<input type="number" step="0.01" class="form-input" id="snap-revenue" placeholder="0.00"></label>' +
                            '<label class="form-label">Expenses<input type="number" step="0.01" class="form-input" id="snap-expenses" placeholder="0.00"></label>' +
                        '</div>' +
                        '<div class="form-row">' +
                            '<label class="form-label">Cash on Hand<input type="number" step="0.01" class="form-input" id="snap-cash" placeholder="0.00"></label>' +
                            '<label class="form-label">Period<input type="month" class="form-input" id="snap-period"></label>' +
                        '</div>' +
                        '<div><button type="submit" class="btn btn-primary">Save Snapshot</button></div>' +
                    '</form>' +
                '</div></div>' +
            '</div>' +
        '</div>' +

        // Transactions
        '<div class="card section-gap">' +
            '<div class="card-header">' +
                '<h3>Transactions</h3>' +
                '<button class="btn btn-sm btn-ghost" onclick="toggleFinAddTxn()">+ Add</button>' +
            '</div>' +
            '<div id="fin-add-txn" class="hidden" style="padding:16px;border-bottom:1px solid var(--border);">' +
                '<form id="fin-txn-form" class="form-inline">' +
                    '<input type="date" class="form-input" id="txn-date" required>' +
                    '<input type="text" class="form-input" id="txn-desc" placeholder="Description" required style="flex:2;">' +
                    '<input type="text" class="form-input" id="txn-category" placeholder="Category">' +
                    '<input type="number" step="0.01" class="form-input" id="txn-amount" placeholder="Amount" required style="width:120px;">' +
                    '<button type="submit" class="btn btn-sm btn-primary">Add</button>' +
                '</form>' +
            '</div>' +
            '<div class="card-body" id="fin-transactions"><div class="spinner"></div></div>' +
        '</div>' +

        // P&L Upload
        '<div class="card section-gap">' +
            '<div class="card-header"><h3>P&L Upload</h3></div>' +
            '<div class="card-body">' +
                '<div class="drop-zone" id="fin-drop-zone">' +
                    '<span class="drop-zone-icon">&#x1F4C4;</span>' +
                    'Drag & drop your P&L statement here, or click to browse' +
                    '<input type="file" id="fin-file-input" accept=".csv,.xlsx,.xls,.pdf">' +
                '</div>' +
                '<div id="fin-upload-result" class="mt-16 hidden"></div>' +
            '</div>' +
        '</div>' +

        // Financial Accounts
        '<div class="card section-gap">' +
            '<div class="card-header"><h3>Financial Accounts</h3><button class="btn btn-sm btn-ghost" onclick="toggleFinAddAccount()">+ Add Account</button></div>' +
            '<div id="fin-add-account" class="hidden" style="padding:16px;border-bottom:1px solid var(--border);">' +
                '<form id="fin-account-form" class="form-inline">' +
                    '<input type="text" class="form-input" id="acct-name" placeholder="Account name" required>' +
                    '<select class="form-select" id="acct-type"><option value="bank">Bank</option><option value="stripe">Stripe</option><option value="paypal">PayPal</option><option value="other">Other</option></select>' +
                    '<button type="submit" class="btn btn-sm btn-primary">Add</button>' +
                '</form>' +
            '</div>' +
            '<div class="card-body" id="fin-accounts"><div class="spinner"></div></div>' +
        '</div>' +

        // Tax Estimate
        '<div class="section-gap">' +
            '<div class="collapsible-header" onclick="toggleCollapsible(this)">' +
                '<span class="arrow">&#9654;</span> Tax Estimate (Quarterly)' +
            '</div>' +
            '<div class="collapsible-body">' +
                '<div class="card"><div class="card-body" id="fin-tax-estimate"><div class="spinner"></div></div></div>' +
            '</div>' +
        '</div>' +

        // Recommendations
        '<div class="card section-gap">' +
            '<div class="card-header"><h3>Financial Recommendations</h3></div>' +
            '<div class="card-body" id="fin-recs"><div class="spinner"></div></div>' +
        '</div>' +

        // Expense Audit (collapsible)
        '<div class="section-gap">' +
            '<div class="collapsible-header" onclick="toggleCollapsible(this)">' +
                '<span class="arrow">&#9654;</span> Expense Audit (AI Fat-Trim)' +
            '</div>' +
            '<div class="collapsible-body">' +
                '<div class="card"><div class="card-body">' +
                    '<p class="text-sm text-muted mb-16">Claude will analyze your expense history and identify cost-reduction opportunities.</p>' +
                    '<button class="btn btn-primary" onclick="runExpenseAudit()">Run Expense Audit</button>' +
                    '<div id="fin-audit-result" class="mt-16"></div>' +
                '</div></div>' +
            '</div>' +
        '</div>' +

        // Scenario Modeler (collapsible)
        '<div class="section-gap">' +
            '<div class="collapsible-header" onclick="toggleCollapsible(this)">' +
                '<span class="arrow">&#9654;</span> Scenario Modeler (What-If)' +
            '</div>' +
            '<div class="collapsible-body">' +
                '<div class="card"><div class="card-body">' +
                    '<div class="form">' +
                        '<div class="form-row">' +
                            '<label class="form-label">Variable' +
                                '<select class="form-select" id="scenario-var">' +
                                    '<option value="revenue">Revenue</option>' +
                                    '<option value="expenses">Expenses</option>' +
                                    '<option value="burn_rate">Burn Rate</option>' +
                                    '<option value="headcount">Headcount Cost</option>' +
                                '</select>' +
                            '</label>' +
                            '<label class="form-label">Change' +
                                '<div style="display:flex;align-items:center;gap:8px;">' +
                                    '<input type="range" id="scenario-slider" min="-50" max="100" value="10" step="5" oninput="document.getElementById(\'scenario-pct\').textContent = this.value + \'%\'">' +
                                    '<span id="scenario-pct" style="min-width:48px;font-weight:600;">10%</span>' +
                                '</div>' +
                            '</label>' +
                        '</div>' +
                        '<button class="btn btn-outline" onclick="runScenario()">Model Scenario</button>' +
                    '</div>' +
                    '<div id="fin-scenario-result" class="mt-16"></div>' +
                '</div></div>' +
            '</div>' +
        '</div>';
}

function renderFinHealthScore(health) {
    var el = document.getElementById('fin-health');
    if (!health || health.score == null) {
        el.innerHTML = '<div class="health-gauge">' +
            '<div class="health-gauge-value" style="color:var(--text-faint);">--</div>' +
            '<div class="health-gauge-label">Financial Health</div>' +
            '<div class="text-muted text-sm mt-12">Run a financial analysis to calculate.</div></div>';
        return;
    }

    var score = Math.round(health.score);
    var grade = health.grade || '--';
    var breakdown = health.breakdown || {};

    var barsHtml = '';
    Object.keys(breakdown).forEach(function(k) {
        var val = Math.round(breakdown[k] || 0);
        var label = k.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
        barsHtml +=
            '<div class="progress-wrap">' +
                '<div class="progress-header"><span class="progress-label">' + esc(label) + '</span><span class="progress-value">' + val + '</span></div>' +
                '<div class="progress-bar"><div class="progress-fill ' + fillClass(val) + '" style="width:' + val + '%;"></div></div>' +
            '</div>';
    });

    el.innerHTML =
        '<div class="grid-2">' +
            '<div class="health-gauge">' +
                '<div class="health-gauge-value ' + scoreClass(score) + '">' + score + '</div>' +
                '<span class="wing-grade ' + gradeClass(grade) + '" style="font-size:18px;">' + esc(grade) + '</span>' +
                '<div class="health-gauge-label">Financial Health</div>' +
                '<div class="health-gauge-bar"><div class="health-gauge-fill ' + fillClass(score) + '" style="width:' + score + '%;"></div></div>' +
            '</div>' +
            '<div>' + barsHtml + '</div>' +
        '</div>';
}

function renderFinSnapshot(data) {
    var el = document.getElementById('fin-snapshot');
    var snap = data && data.snapshots ? data.snapshots[0] : (data && data.snapshot ? data.snapshot : data);
    if (!snap || !snap.revenue) {
        el.innerHTML = '<div class="text-muted text-sm mb-16">No financial snapshot yet. Add one below.</div>';
        return;
    }

    var net = (snap.revenue || 0) - (snap.expenses || 0);
    var burnRate = snap.burn_rate || (snap.expenses ? snap.expenses : null);
    var runway = snap.runway_months || (snap.cash_on_hand && burnRate ? (snap.cash_on_hand / burnRate) : null);

    el.innerHTML =
        '<div class="section-title">Latest Snapshot (' + esc(snap.period || fmtDate(snap.created_at)) + ')</div>' +
        '<div class="snapshot-grid">' +
            buildSnapshotItem('Revenue', fmtCurrency(snap.revenue), 'amount-positive') +
            buildSnapshotItem('Expenses', fmtCurrency(snap.expenses), 'amount-negative') +
            buildSnapshotItem('Net', fmtCurrency(net), net >= 0 ? 'amount-positive' : 'amount-negative') +
            buildSnapshotItem('Cash on Hand', fmtCurrency(snap.cash_on_hand), '') +
            buildSnapshotItem('Burn Rate', burnRate ? fmtCurrency(burnRate) + '/mo' : '--', '') +
            buildSnapshotItem('Runway', runway ? Math.round(runway) + ' months' : '--',
                runway && runway < 3 ? 'amount-negative' : '') +
        '</div>';
}

function buildSnapshotItem(label, value, cls) {
    return '<div class="snapshot-item">' +
        '<div class="snapshot-label">' + esc(label) + '</div>' +
        '<div class="snapshot-value ' + cls + '">' + value + '</div>' +
    '</div>';
}

function renderFinTransactions(data) {
    var el = document.getElementById('fin-transactions');
    var items = data && data.transactions ? data.transactions : (Array.isArray(data) ? data : []);
    var total = data && data.total ? data.total : items.length;

    if (items.length === 0) {
        el.innerHTML = '<div class="empty-state" style="padding:20px;"><div class="empty-state-title">No transactions</div>' +
            '<div class="empty-state-msg">Add transactions manually or upload a P&L.</div></div>';
        return;
    }

    var html = '<div class="table-wrap"><table><thead><tr>' +
        '<th>Date</th><th>Description</th><th>Category</th><th class="text-right">Amount</th>' +
        '</tr></thead><tbody>';

    items.forEach(function(txn) {
        var amt = Number(txn.amount || 0);
        var cls = amt >= 0 ? 'amount-positive' : 'amount-negative';
        html += '<tr>' +
            '<td>' + fmtDate(txn.date || txn.created_at) + '</td>' +
            '<td>' + esc(txn.description || '') + '</td>' +
            '<td>' + esc(txn.category || '--') + '</td>' +
            '<td class="text-right ' + cls + '">' + fmtCurrency(amt) + '</td>' +
        '</tr>';
    });

    html += '</tbody></table></div>';

    // Pagination
    var totalPages = Math.ceil(total / _finPageSize);
    if (totalPages > 1) {
        html += '<div class="pagination">' +
            '<button onclick="loadFinTxnPage(' + (_finPage - 1) + ')"' + (_finPage <= 1 ? ' disabled' : '') + '>&laquo; Prev</button>' +
            '<span class="page-info">Page ' + _finPage + ' of ' + totalPages + '</span>' +
            '<button onclick="loadFinTxnPage(' + (_finPage + 1) + ')"' + (_finPage >= totalPages ? ' disabled' : '') + '>Next &raquo;</button>' +
        '</div>';
    }

    el.innerHTML = html;
}

function renderFinAccounts(data) {
    var el = document.getElementById('fin-accounts');
    var accounts = data && data.accounts ? data.accounts : (Array.isArray(data) ? data : []);

    if (accounts.length === 0) {
        el.innerHTML = '<div class="text-muted text-sm">No financial accounts connected.</div>';
        return;
    }

    var html = '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Last Sync</th><th>Actions</th></tr></thead><tbody>';
    accounts.forEach(function(acct) {
        var statusCls = acct.status === 'active' ? 'badge-success' : (acct.status === 'error' ? 'badge-danger' : 'badge-info');
        var isStripe  = (acct.type === 'stripe' || acct.source === 'stripe');
        var actions   = '';
        if (isStripe) {
            actions =
                '<button class="btn btn-sm btn-ghost" onclick="finSyncAccount(\'' + acct.id + '\')">Sync</button> ' +
                '<button class="btn btn-sm btn-ghost" onclick="finViewBalance(\'' + acct.id + '\')">Balance</button>';
        }
        html += '<tr>' +
            '<td>' + esc(acct.name || acct.account_label || '') + (acct.is_internal ? ' <span class="badge badge-info" style="font-size:10px;">Internal</span>' : '') + '</td>' +
            '<td>' + esc(acct.type || acct.source || '--') + '</td>' +
            '<td><span class="badge ' + statusCls + '">' + esc(acct.status || 'unknown') + '</span></td>' +
            '<td>' + (acct.last_sync_at || acct.last_sync ? timeAgo(acct.last_sync_at || acct.last_sync) : '--') + '</td>' +
            '<td>' + actions + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    el.innerHTML = html;
}

function renderFinRecommendations(data) {
    var el = document.getElementById('fin-recs');
    var items = data && data.recommendations ? data.recommendations : (Array.isArray(data) ? data : []);

    if (items.length === 0) {
        el.innerHTML = '<div class="text-muted text-sm">No financial recommendations. Run an analysis to generate them.</div>';
        return;
    }

    var html = '<div class="rec-cards">';
    items.forEach(function(rec) {
        var actionsList = '';
        if (rec.action_items && rec.action_items.length > 0) {
            actionsList = '<ul class="rec-card-actions-list">';
            rec.action_items.forEach(function(ai) { actionsList += '<li>' + esc(ai) + '</li>'; });
            actionsList += '</ul>';
        }
        html += '<div class="rec-card">' +
            '<div class="rec-card-header">' +
                urgencyBadge(rec.urgency) + ' ' +
                '<span class="rec-card-title">' + esc(rec.title) + '</span>' +
                (rec.financial_impact ? ' ' + impactBadge(rec.financial_impact) : '') +
            '</div>' +
            '<div class="rec-card-reasoning">' + esc(rec.reasoning || rec.summary || '') + '</div>' +
            actionsList +
            '<div class="rec-card-footer">' +
                '<button class="btn btn-sm btn-outline" onclick="pushRecToTeamHub(\'' + esc(rec.id) + '\')">Push to Team Hub</button>' +
                '<button class="btn btn-sm btn-ghost" onclick="actionRec(\'' + esc(rec.id) + '\', \'dismissed\')">Dismiss</button>' +
            '</div>' +
        '</div>';
    });
    html += '</div>';
    el.innerHTML = html;
}

// ── Event Listeners & Actions ────────────────────────────────────────────────
function setupFinEventListeners() {
    // Snapshot form
    var snapForm = document.getElementById('fin-snapshot-form');
    if (snapForm) {
        snapForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            try {
                await companyApi('/financial/snapshots', {
                    method: 'POST',
                    body: {
                        revenue: parseFloat(document.getElementById('snap-revenue').value) || 0,
                        expenses: parseFloat(document.getElementById('snap-expenses').value) || 0,
                        cash_on_hand: parseFloat(document.getElementById('snap-cash').value) || 0,
                        period: document.getElementById('snap-period').value || null
                    }
                });
                showToast('Snapshot saved', 'success');
                snapForm.reset();
                initFinancial();
            } catch (err) {
                showToast('Failed to save snapshot: ' + err.message, 'error');
            }
        });
    }

    // Transaction form
    var txnForm = document.getElementById('fin-txn-form');
    if (txnForm) {
        txnForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            try {
                await companyApi('/financial/transactions', {
                    method: 'POST',
                    body: {
                        date: document.getElementById('txn-date').value,
                        description: document.getElementById('txn-desc').value,
                        category: document.getElementById('txn-category').value || null,
                        amount: parseFloat(document.getElementById('txn-amount').value)
                    }
                });
                showToast('Transaction added', 'success');
                txnForm.reset();
                document.getElementById('fin-add-txn').classList.add('hidden');
                var txns = await companyApi('/financial/transactions?page=1&limit=' + _finPageSize);
                _finPage = 1;
                renderFinTransactions(txns);
            } catch (err) {
                showToast('Failed: ' + err.message, 'error');
            }
        });
    }

    // Account form
    var acctForm = document.getElementById('fin-account-form');
    if (acctForm) {
        acctForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            try {
                await companyApi('/financial/accounts', {
                    method: 'POST',
                    body: {
                        name: document.getElementById('acct-name').value,
                        type: document.getElementById('acct-type').value
                    }
                });
                showToast('Account added', 'success');
                acctForm.reset();
                document.getElementById('fin-add-account').classList.add('hidden');
                var accounts = await companyApi('/financial/accounts');
                renderFinAccounts(accounts);
            } catch (err) {
                showToast('Failed: ' + err.message, 'error');
            }
        });
    }

    // P&L drop zone
    var dropZone = document.getElementById('fin-drop-zone');
    var fileInput = document.getElementById('fin-file-input');
    if (dropZone && fileInput) {
        dropZone.addEventListener('click', function() { fileInput.click(); });
        dropZone.addEventListener('dragover', function(e) { e.preventDefault(); dropZone.classList.add('dragover'); });
        dropZone.addEventListener('dragleave', function() { dropZone.classList.remove('dragover'); });
        dropZone.addEventListener('drop', function(e) {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            if (e.dataTransfer.files.length > 0) uploadPL(e.dataTransfer.files[0]);
        });
        fileInput.addEventListener('change', function() {
            if (fileInput.files.length > 0) uploadPL(fileInput.files[0]);
        });
    }
}

function toggleFinAddTxn() {
    document.getElementById('fin-add-txn').classList.toggle('hidden');
}

function toggleFinAddAccount() {
    document.getElementById('fin-add-account').classList.toggle('hidden');
}

async function loadFinTxnPage(page) {
    if (page < 1) return;
    _finPage = page;
    try {
        var txns = await companyApi('/financial/transactions?page=' + page + '&limit=' + _finPageSize);
        renderFinTransactions(txns);
    } catch (err) {
        showToast('Failed to load transactions: ' + err.message, 'error');
    }
}

async function uploadPL(file) {
    var resultEl = document.getElementById('fin-upload-result');
    resultEl.classList.remove('hidden');
    resultEl.innerHTML = '<div class="flex-center gap-8"><div class="spinner"></div> Uploading and parsing...</div>';

    var formData = new FormData();
    formData.append('file', file);

    try {
        var result = await companyApi('/financial/upload-pl', {
            method: 'POST',
            body: formData,
            headers: {} // Let browser set Content-Type for FormData
        });

        var parsed = result.parsed || result;
        resultEl.innerHTML =
            '<div class="card"><div class="card-header"><h3>Parse Results</h3></div><div class="card-body">' +
            '<div class="text-sm mb-12">Found ' + (parsed.transactions_count || 0) + ' transactions</div>' +
            '<div class="text-sm mb-12">Revenue: ' + fmtCurrency(parsed.total_revenue) + ' | Expenses: ' + fmtCurrency(parsed.total_expenses) + '</div>' +
            '<button class="btn btn-success" onclick="confirmPLImport()">Confirm Import</button>' +
            '<button class="btn btn-ghost" onclick="cancelPLImport()" style="margin-left:8px;">Cancel</button>' +
            '</div></div>';
    } catch (err) {
        resultEl.innerHTML = '<div class="text-sm" style="color:var(--danger);">Upload failed: ' + esc(err.message) + '</div>';
    }
}

async function confirmPLImport() {
    try {
        await companyApi('/financial/confirm-pl-import', { method: 'POST' });
        showToast('P&L data imported', 'success');
        initFinancial();
    } catch (err) {
        showToast('Import failed: ' + err.message, 'error');
    }
}

function cancelPLImport() {
    document.getElementById('fin-upload-result').classList.add('hidden');
}

async function runFinancialAnalysis() {
    showToast('Running financial analysis...', 'info');
    try {
        await companyApi('/advisor/analyze', { method: 'POST', body: { wing: 'financial' } });
        showToast('Financial analysis complete', 'success');
        initFinancial();
    } catch (err) {
        showToast('Analysis failed: ' + err.message, 'error');
    }
}

async function pushRecToTeamHub(recId) {
    try {
        await companyApi('/recommendations/' + recId + '/push-to-team-hub', { method: 'POST' });
        showToast('Pushed to Team Hub', 'success');
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

// ── Cash Flow Chart ──────────────────────────────────────────────────────────

function renderCashFlow(data) {
    var el = document.getElementById('fin-cashflow');
    if (!el) return;

    var actuals  = data && data.actuals  ? data.actuals  : [];
    var forecast = data && data.forecast ? data.forecast : {};

    if (actuals.length === 0) {
        el.innerHTML = '<div class="text-muted text-sm">No transaction data yet. Import transactions or connect a financial account.</div>';
        return;
    }

    // Summary metrics
    var totalRev  = actuals.reduce(function(s, d) { return s + (d.revenue  || 0); }, 0);
    var totalExp  = actuals.reduce(function(s, d) { return s + (d.expenses || 0); }, 0);
    var totalNet  = actuals.reduce(function(s, d) { return s + (d.net      || 0); }, 0);
    var lastEntry = actuals[actuals.length - 1] || {};

    var html = '<div class="snapshot-grid" style="margin-bottom:20px;">' +
        buildSnapshotItem('90-Day Revenue',  fmtCurrency(totalRev),  'amount-positive') +
        buildSnapshotItem('90-Day Expenses', fmtCurrency(totalExp),  'amount-negative') +
        buildSnapshotItem('Net Cash Flow',   fmtCurrency(totalNet),  totalNet >= 0 ? 'amount-positive' : 'amount-negative') +
        buildSnapshotItem('Cumulative',      fmtCurrency(lastEntry.cumulative_net || totalNet), '') +
    '</div>';

    // Bar chart — weekly buckets (group by 7 days)
    var buckets = [];
    for (var i = 0; i < actuals.length; i += 7) {
        var slice = actuals.slice(i, i + 7);
        var bRev = slice.reduce(function(s, d) { return s + (d.revenue  || 0); }, 0);
        var bExp = slice.reduce(function(s, d) { return s + (d.expenses || 0); }, 0);
        buckets.push({ label: slice[0] ? slice[0].date.slice(5) : '', revenue: bRev, expenses: bExp });
    }

    var maxVal = Math.max.apply(null, buckets.map(function(b) { return Math.max(b.revenue, b.expenses); }));
    if (maxVal === 0) maxVal = 1;

    html += '<div class="cf-chart">';
    buckets.forEach(function(b) {
        var rPct = Math.round((b.revenue  / maxVal) * 100);
        var ePct = Math.round((b.expenses / maxVal) * 100);
        html += '<div class="cf-bar-group">' +
            '<div class="cf-bars">' +
                '<div class="cf-bar cf-bar-rev" style="height:' + rPct + '%;" title="Revenue: ' + fmtCurrency(b.revenue) + '"></div>' +
                '<div class="cf-bar cf-bar-exp" style="height:' + ePct + '%;" title="Expenses: ' + fmtCurrency(b.expenses) + '"></div>' +
            '</div>' +
            '<div class="cf-label">' + esc(b.label) + '</div>' +
        '</div>';
    });
    html += '</div>' +
        '<div class="cf-legend">' +
            '<span class="cf-leg-dot cf-leg-rev"></span> Revenue &nbsp;&nbsp;' +
            '<span class="cf-leg-dot cf-leg-exp"></span> Expenses' +
        '</div>';

    // Forecast summary table
    var bands = ['conservative', 'baseline', 'optimistic'];
    var bandLabels = { conservative: 'Conservative', baseline: 'Baseline', optimistic: 'Optimistic' };
    var forecastRows = '';
    bands.forEach(function(band) {
        var pts = forecast[band] || [];
        if (!pts.length) return;
        var fNet = pts.reduce(function(s, d) { return s + (d.net || 0); }, 0);
        forecastRows += '<tr><td>' + bandLabels[band] + '</td><td class="text-right">' + fmtCurrency(fNet) + '</td></tr>';
    });

    if (forecastRows) {
        html += '<div class="section-title mt-16">90-Day Forecast</div>' +
            '<div class="table-wrap"><table><thead><tr><th>Scenario</th><th class="text-right">Projected Net</th></tr></thead>' +
            '<tbody>' + forecastRows + '</tbody></table></div>';
    }

    el.innerHTML = html;
}


// ── Revenue Breakdown ────────────────────────────────────────────────────────

function renderRevenueBreakdown(data) {
    var el = document.getElementById('fin-revenue-breakdown');
    if (!el) return;

    var byCat    = data && data.by_category ? data.by_category : {};
    var bySrc    = data && data.by_source   ? data.by_source   : {};
    var byMonth  = data && data.by_month    ? data.by_month    : {};

    if (!Object.keys(byCat).length && !Object.keys(bySrc).length) {
        el.innerHTML = '<div class="text-muted text-sm">No revenue data yet.</div>';
        return;
    }

    var html = '<div class="grid-2">';

    // By category
    if (Object.keys(byCat).length) {
        html += '<div><div class="section-title mb-8">By Category</div><div class="table-wrap"><table><thead><tr><th>Category</th><th class="text-right">Total</th><th class="text-right">%</th></tr></thead><tbody>';
        Object.keys(byCat).sort(function(a, b) { return (byCat[b].total || 0) - (byCat[a].total || 0); }).forEach(function(cat) {
            var row = byCat[cat];
            html += '<tr><td>' + esc(cat) + '</td><td class="text-right">' + fmtCurrency(row.total || 0) + '</td><td class="text-right">' + (row.pct || 0).toFixed(1) + '%</td></tr>';
        });
        html += '</tbody></table></div></div>';
    }

    // By source
    if (Object.keys(bySrc).length) {
        html += '<div><div class="section-title mb-8">By Source</div><div class="table-wrap"><table><thead><tr><th>Source</th><th class="text-right">Total</th><th class="text-right">%</th></tr></thead><tbody>';
        Object.keys(bySrc).sort(function(a, b) { return (bySrc[b].total || 0) - (bySrc[a].total || 0); }).forEach(function(src) {
            var row = bySrc[src];
            html += '<tr><td>' + esc(src) + '</td><td class="text-right">' + fmtCurrency(row.total || 0) + '</td><td class="text-right">' + (row.pct || 0).toFixed(1) + '%</td></tr>';
        });
        html += '</tbody></table></div></div>';
    }

    html += '</div>';

    // Monthly trend
    var months = Object.keys(byMonth).sort();
    if (months.length > 1) {
        html += '<div class="mt-16"><div class="section-title mb-8">Monthly Trend</div><div class="table-wrap"><table><thead><tr><th>Month</th><th class="text-right">Revenue</th><th class="text-right">Expenses</th><th class="text-right">Net</th></tr></thead><tbody>';
        months.forEach(function(m) {
            var row = byMonth[m] || {};
            var net = (row.revenue || 0) - (row.expenses || 0);
            html += '<tr>' +
                '<td>' + esc(m) + '</td>' +
                '<td class="text-right amount-positive">' + fmtCurrency(row.revenue || 0) + '</td>' +
                '<td class="text-right amount-negative">' + fmtCurrency(row.expenses || 0) + '</td>' +
                '<td class="text-right ' + (net >= 0 ? 'amount-positive' : 'amount-negative') + '">' + fmtCurrency(net) + '</td>' +
            '</tr>';
        });
        html += '</tbody></table></div></div>';
    }

    el.innerHTML = html;
}


// ── Expense Audit ────────────────────────────────────────────────────────────

async function runExpenseAudit() {
    var resultEl = document.getElementById('fin-audit-result');
    resultEl.innerHTML = '<div class="flex-center gap-8"><div class="spinner"></div> Analyzing expenses with Claude...</div>';
    try {
        var data = await companyApi('/financial/expense-audit', { method: 'POST' });
        renderExpenseAudit(data, resultEl);
    } catch (err) {
        resultEl.innerHTML = '<div class="text-sm" style="color:var(--danger);">Audit failed: ' + esc(err.message) + '</div>';
    }
}

function renderExpenseAudit(data, el) {
    if (!data) { el.innerHTML = '<div class="text-muted text-sm">No results.</div>'; return; }

    var findings = data.findings || [];
    var savings  = data.potential_savings || 0;
    var analyzed = data.expenses_analyzed || 0;

    var html = '<div class="alert-bar" style="background:var(--surface-2);border:1px solid var(--border);padding:12px 16px;border-radius:8px;margin-bottom:16px;">' +
        '<strong>' + analyzed + '</strong> expenses analyzed &mdash; ' +
        'potential savings: <strong class="amount-positive">' + fmtCurrency(savings) + '</strong>' +
    '</div>';

    if (findings.length) {
        html += '<div class="rec-cards">';
        findings.forEach(function(f) {
            html += '<div class="rec-card">' +
                '<div class="rec-card-header">' +
                    (f.priority === 'high' ? '<span class="badge badge-danger">High</span>' :
                     f.priority === 'medium' ? '<span class="badge badge-warn">Medium</span>' :
                     '<span class="badge badge-info">Low</span>') +
                    ' <span class="rec-card-title">' + esc(f.category || 'Finding') + '</span>' +
                    (f.potential_saving ? ' <span class="badge badge-success">Save ' + fmtCurrency(f.potential_saving) + '</span>' : '') +
                '</div>' +
                '<div class="rec-card-reasoning">' + esc(f.finding || '') + '</div>' +
                (f.action ? '<div class="text-sm mt-8" style="color:var(--primary);">Action: ' + esc(f.action) + '</div>' : '') +
            '</div>';
        });
        html += '</div>';
    } else {
        html += '<div class="text-muted text-sm">No significant savings opportunities identified.</div>';
    }

    if (data.report_text) {
        html += '<div class="collapsible-header mt-16" onclick="toggleCollapsible(this)" style="background:transparent;padding:8px 0;">' +
            '<span class="arrow">&#9654;</span> Full Report' +
        '</div>' +
        '<div class="collapsible-body">' +
            '<pre style="white-space:pre-wrap;font-size:13px;line-height:1.5;color:var(--text-muted);">' + esc(data.report_text) + '</pre>' +
        '</div>';
    }

    el.innerHTML = html;
}


// ── Scenario Modeler ─────────────────────────────────────────────────────────

async function runScenario() {
    var varName  = document.getElementById('scenario-var').value;
    var changePct = parseInt(document.getElementById('scenario-slider').value, 10);
    var resultEl  = document.getElementById('fin-scenario-result');
    resultEl.innerHTML = '<div class="flex-center gap-8"><div class="spinner"></div> Modeling scenario...</div>';
    try {
        var data = await companyApi('/financial/scenario', {
            method: 'POST',
            body: { variable: varName, change_pct: changePct }
        });
        renderScenarioResult(data, changePct, resultEl);
    } catch (err) {
        resultEl.innerHTML = '<div class="text-sm" style="color:var(--danger);">Scenario failed: ' + esc(err.message) + '</div>';
    }
}

function renderScenarioResult(data, changePct, el) {
    if (!data) { el.innerHTML = ''; return; }

    var before = data.before || {};
    var after  = data.after  || {};

    function row(label, bVal, aVal, fmt) {
        var better = (aVal > bVal);
        // For expenses/burn_rate, lower is better
        if (label === 'Expenses' || label === 'Burn Rate') better = (aVal < bVal);
        var cls = better ? 'amount-positive' : (aVal < bVal ? 'amount-negative' : '');
        return '<tr><td>' + label + '</td>' +
            '<td class="text-right">' + (fmt ? fmt(bVal) : bVal) + '</td>' +
            '<td class="text-right ' + cls + '">' + (fmt ? fmt(aVal) : aVal) + '</td>' +
        '</tr>';
    }

    var html = '<div class="table-wrap"><table>' +
        '<thead><tr><th>Metric</th><th class="text-right">Before</th><th class="text-right">After (' + (changePct >= 0 ? '+' : '') + changePct + '%)</th></tr></thead>' +
        '<tbody>' +
        row('Revenue',       before.revenue      || 0, after.revenue      || 0, fmtCurrency) +
        row('Expenses',      before.expenses     || 0, after.expenses     || 0, fmtCurrency) +
        row('Net Profit',    before.net_profit   || 0, after.net_profit   || 0, fmtCurrency) +
        row('Burn Rate',     before.burn_rate    || 0, after.burn_rate    || 0, fmtCurrency) +
        row('Runway',        before.runway_months || 0, after.runway_months || 0, function(v) { return Math.round(v) + ' mo'; }) +
        row('Health Score',  before.health_score || 0, after.health_score || 0, function(v) { return Math.round(v) + '/100'; }) +
        '</tbody></table></div>';

    if (data.summary) {
        html += '<div class="mt-12 text-sm" style="color:var(--text-muted);line-height:1.5;">' + esc(data.summary) + '</div>';
    }

    el.innerHTML = html;
}


// Expose globally
async function finSyncAccount(accountId) {
    showToast('Syncing account...', 'info');
    try {
        var data = await companyApi('/financial/accounts/' + accountId + '/sync', { method: 'POST' });
        showToast('Synced: ' + (data.synced_count || 0) + ' new, ' + (data.skipped_count || 0) + ' skipped', 'success');
        var accounts = await companyApi('/financial/accounts');
        renderFinAccounts(accounts);
    } catch (err) {
        showToast('Sync failed: ' + err.message, 'error');
    }
}

async function finViewBalance(accountId) {
    try {
        var data = await companyApi('/financial/accounts/' + accountId + '/balance');
        if (data.error) { showToast('Balance error: ' + data.error, 'error'); return; }
        showToast(
            'Available: ' + fmtCurrency(data.available || 0) +
            ' | Pending: ' + fmtCurrency(data.pending || 0),
            'info'
        );
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

// ── Tax Estimate ──────────────────────────────────────────────────────────────

function renderTaxEstimate(data) {
    var el = document.getElementById('fin-tax-estimate');
    if (!el) return;

    if (!data || !data.quarters || data.quarters.length === 0) {
        el.innerHTML = '<div class="text-muted text-sm">No snapshot data yet. Add financial snapshots to see a tax estimate.</div>';
        return;
    }

    var quarters = data.quarters;
    var rate = Math.round((data.rate || 0.25) * 100);

    var html = '<div class="snapshot-grid" style="margin-bottom:20px;">' +
        '<div class="snapshot-item"><div class="snapshot-label">Annual Net Income</div><div class="snapshot-value">' + fmtCurrency(data.annual_net || 0) + '</div></div>' +
        '<div class="snapshot-item"><div class="snapshot-label">Taxable Income</div><div class="snapshot-value">' + fmtCurrency(data.annual_taxable || 0) + '</div></div>' +
        '<div class="snapshot-item"><div class="snapshot-label">Est. Annual Tax (' + rate + '%)</div><div class="snapshot-value amount-negative">' + fmtCurrency(data.annual_estimated_tax || 0) + '</div></div>' +
    '</div>';

    html += '<div class="table-wrap"><table><thead><tr><th>Quarter</th><th class="text-right">Net Income</th><th class="text-right">Taxable</th><th class="text-right">Est. Tax</th></tr></thead><tbody>';
    quarters.forEach(function(q) {
        html += '<tr>' +
            '<td><strong>' + esc(q.quarter) + '</strong></td>' +
            '<td class="text-right">' + fmtCurrency(q.net_income || 0) + '</td>' +
            '<td class="text-right">' + fmtCurrency(q.taxable_income || 0) + '</td>' +
            '<td class="text-right amount-negative">' + fmtCurrency(q.estimated_tax || 0) + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';

    if (data.disclaimer) {
        html += '<div class="text-muted text-sm mt-12" style="font-style:italic;">' + esc(data.disclaimer) + '</div>';
    }

    el.innerHTML = html;
}

// Expose globally
window.toggleFinAddTxn     = toggleFinAddTxn;
window.toggleFinAddAccount = toggleFinAddAccount;
window.loadFinTxnPage      = loadFinTxnPage;
window.runFinancialAnalysis = runFinancialAnalysis;
window.pushRecToTeamHub    = pushRecToTeamHub;
window.confirmPLImport     = confirmPLImport;
window.cancelPLImport      = cancelPLImport;
window.runExpenseAudit     = runExpenseAudit;
window.runScenario         = runScenario;
window.finSyncAccount      = finSyncAccount;
window.finViewBalance      = finViewBalance;
