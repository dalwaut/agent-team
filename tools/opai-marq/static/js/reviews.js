/**
 * Marq — Review Dashboard (Phase 5)
 *
 * Review monitoring, star distribution, AI response drafting with approval gate.
 */
(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════
  // Reviews Tab
  // ═══════════════════════════════════════════════════════════

  window.renderReviewsTab = function (el) {
    var app = window.marqState.currentApp;
    if (!app) {
      el.innerHTML = emptyState('\u2B50', 'Select an app first', 'Go to Dashboard and click on an app to view reviews.');
      return;
    }

    el.innerHTML = '<div class="metadata-header">' +
      '<h2>Reviews — ' + esc(app.name) + '</h2>' +
      '<div style="display:flex;gap:8px">' +
        '<button class="btn" onclick="batchDraftReviews(\'' + app.id + '\')">AI Draft All Pending</button>' +
        '<button class="btn" onclick="loadReviewsTab(\'' + app.id + '\')">Refresh</button>' +
      '</div>' +
    '</div>' +
    '<div id="review-stats"><div class="loading">Loading stats...</div></div>' +
    '<div id="review-filters" style="margin:12px 0"></div>' +
    '<div id="review-list"><div class="loading">Loading reviews...</div></div>' +
    '<div id="review-events-area"></div>';

    loadReviewStats(app.id);
    loadReviewList(app.id);
    loadReviewEvents(app.id);
  };

  window.loadReviewsTab = function (appId) {
    loadReviewStats(appId);
    loadReviewList(appId);
    loadReviewEvents(appId);
  };

  // ── Stats & Star Distribution ────────────────────────────

  async function loadReviewStats(appId) {
    var el = document.getElementById('review-stats');
    if (!el) return;

    try {
      var stats = await marqFetch('/apps/' + appId + '/review-stats');

      var stars = stats.star_distribution || {};
      var total = stats.total || 0;
      var avg = stats.average_rating || 0;

      // Star distribution bars
      var barsHtml = '';
      for (var i = 5; i >= 1; i--) {
        var count = stars[i] || 0;
        var pct = total > 0 ? Math.round((count / total) * 100) : 0;
        barsHtml += '<div class="star-row">' +
          '<span class="star-label">' + i + ' \u2605</span>' +
          '<div class="star-bar-track"><div class="star-bar-fill" style="width:' + pct + '%;background:' + starColor(i) + '"></div></div>' +
          '<span class="star-count">' + count + '</span>' +
        '</div>';
      }

      // Status counts
      var byStatus = stats.by_status || {};
      var statusHtml = '';
      var statusKeys = ['pending', 'draft_ready', 'approved', 'sent', 'skipped'];
      for (var j = 0; j < statusKeys.length; j++) {
        var k = statusKeys[j];
        var c = byStatus[k] || 0;
        if (c > 0) {
          statusHtml += '<div class="review-stat-chip">' +
            '<span class="review-stat-num">' + c + '</span>' +
            '<span class="review-stat-label">' + k.replace(/_/g, ' ') + '</span>' +
          '</div>';
        }
      }

      // Store counts
      var byStore = stats.by_store || {};
      var storeHtml = '';
      if (byStore.google) storeHtml += '<span class="badge badge-android">' + byStore.google + ' Google</span> ';
      if (byStore.apple) storeHtml += '<span class="badge badge-ios">' + byStore.apple + ' Apple</span>';

      el.innerHTML = '<div class="card review-stats-card">' +
        '<div class="review-stats-grid">' +
          '<div class="review-avg">' +
            '<div class="review-avg-num">' + avg.toFixed(1) + '</div>' +
            '<div class="review-avg-stars">' + starIcons(avg) + '</div>' +
            '<div class="review-avg-total">' + total + ' reviews</div>' +
            '<div style="margin-top:6px">' + storeHtml + '</div>' +
          '</div>' +
          '<div class="star-distribution">' + barsHtml + '</div>' +
          '<div class="review-status-chips">' + statusHtml + '</div>' +
        '</div>' +
      '</div>';

      // Render filter buttons
      var filtersEl = document.getElementById('review-filters');
      if (filtersEl) {
        filtersEl.innerHTML = '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
          filterBtn('All', '', appId) +
          filterBtn('Pending', 'pending', appId) +
          filterBtn('Drafts Ready', 'draft_ready', appId) +
          filterBtn('Approved', 'approved', appId) +
          filterBtn('Sent', 'sent', appId) +
          filterBtn('\u2605 1-2', 'low_rating', appId) +
          filterBtn('\u2605 4-5', 'high_rating', appId) +
        '</div>';
      }
    } catch (e) {
      el.innerHTML = '<div class="text-muted">Failed to load stats: ' + esc(e.message) + '</div>';
    }
  }

  function filterBtn(label, filter, appId) {
    var active = (window.marqState._reviewFilter || '') === filter;
    return '<button class="btn btn-sm' + (active ? ' btn-primary' : '') + '" onclick="filterReviews(\'' + appId + '\',\'' + filter + '\')">' + label + '</button>';
  }

  window.filterReviews = function (appId, filter) {
    window.marqState._reviewFilter = filter;
    loadReviewList(appId);
    // Update filter buttons
    var filtersEl = document.getElementById('review-filters');
    if (filtersEl) {
      filtersEl.innerHTML = '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
        filterBtn('All', '', appId) +
        filterBtn('Pending', 'pending', appId) +
        filterBtn('Drafts Ready', 'draft_ready', appId) +
        filterBtn('Approved', 'approved', appId) +
        filterBtn('Sent', 'sent', appId) +
        filterBtn('\u2605 1-2', 'low_rating', appId) +
        filterBtn('\u2605 4-5', 'high_rating', appId) +
      '</div>';
    }
  };

  // ── Review List ──────────────────────────────────────────

  async function loadReviewList(appId) {
    var listEl = document.getElementById('review-list');
    if (!listEl) return;

    var filter = window.marqState._reviewFilter || '';
    var query = '/apps/' + appId + '/reviews?limit=50';
    if (filter === 'pending' || filter === 'draft_ready' || filter === 'approved' || filter === 'sent') {
      query += '&status=' + filter;
    } else if (filter === 'low_rating') {
      query += '&max_rating=2';
    } else if (filter === 'high_rating') {
      query += '&min_rating=4';
    }

    try {
      var reviews = await marqFetch(query);

      if (!reviews || reviews.length === 0) {
        listEl.innerHTML = '<div class="empty-state" style="padding:30px"><p class="text-muted">No reviews found' +
          (filter ? ' for this filter' : '') + '. Reviews are fetched automatically by the scheduler.</p></div>';
        return;
      }

      var html = '';
      for (var i = 0; i < reviews.length; i++) {
        html += renderReviewCard(reviews[i]);
      }
      listEl.innerHTML = html;
    } catch (e) {
      listEl.innerHTML = '<div class="text-muted">Failed to load reviews: ' + esc(e.message) + '</div>';
    }
  }

  function renderReviewCard(r) {
    var ratingStars = starIcons(r.rating || 0);
    var storeBadge = '<span class="badge ' + (r.store === 'apple' ? 'badge-ios' : 'badge-android') + '">' + esc(r.store) + '</span>';
    var statusBadge = reviewStatusBadge(r.status);

    var html = '<div class="card review-card">' +
      '<div class="review-card-header">' +
        '<div class="review-rating">' + ratingStars + '</div>' +
        storeBadge + ' ' + statusBadge +
        '<span class="text-muted" style="margin-left:auto;font-size:11px">' + formatDate(r.created_at) + '</span>' +
      '</div>' +
      '<div class="review-text">' + esc(r.review_text || '(no text)') + '</div>';

    // Show draft if exists
    if (r.response_draft && r.status === 'draft_ready') {
      html += '<div class="review-draft">' +
        '<div class="review-draft-label">AI Draft Response</div>' +
        '<div class="review-draft-text">' + esc(r.response_draft) + '</div>' +
        '<div class="review-draft-actions">' +
          '<button class="btn btn-sm btn-primary" onclick="approveReview(\'' + r.id + '\')">Approve & Send</button>' +
          '<button class="btn btn-sm" onclick="editReviewDraft(\'' + r.id + '\')">Edit</button>' +
          '<button class="btn btn-sm" onclick="skipReview(\'' + r.id + '\')">Skip</button>' +
        '</div>' +
      '</div>';
    } else if (r.response_sent && (r.status === 'sent' || r.status === 'approved')) {
      html += '<div class="review-draft review-sent">' +
        '<div class="review-draft-label">' + (r.status === 'sent' ? 'Sent Response' : 'Approved (sending...)') + '</div>' +
        '<div class="review-draft-text">' + esc(r.response_sent) + '</div>' +
      '</div>';
    } else if (r.status === 'pending') {
      html += '<div class="review-actions">' +
        '<button class="btn btn-sm" onclick="generateDraft(\'' + r.id + '\')">Generate AI Draft</button>' +
        '<button class="btn btn-sm" onclick="skipReview(\'' + r.id + '\')">Skip</button>' +
      '</div>';
    }

    html += '</div>';
    return html;
  }

  // ── AI Draft Actions ─────────────────────────────────────

  window.generateDraft = async function (reviewId) {
    showToast('Generating AI draft...', 'success');
    try {
      var result = await marqFetch('/reviews/' + reviewId + '/generate-draft', { method: 'POST', body: JSON.stringify({ tone: 'professional' }) });
      showToast('Draft generated (' + result.length + '/' + result.char_limit + ' chars)', 'success');
      if (window.marqState.currentApp) loadReviewList(window.marqState.currentApp.id);
    } catch (e) {
      showToast('Draft failed: ' + e.message, 'error');
    }
  };

  window.batchDraftReviews = async function (appId) {
    showToast('Generating drafts for all pending reviews...', 'success');
    try {
      var result = await marqFetch('/apps/' + appId + '/reviews/batch-draft', { method: 'POST', body: JSON.stringify({ tone: 'professional' }) });
      showToast('Drafted ' + result.drafted + ' of ' + result.total_pending + ' pending reviews', 'success');
      loadReviewList(appId);
      loadReviewStats(appId);
    } catch (e) {
      showToast('Batch draft failed: ' + e.message, 'error');
    }
  };

  window.approveReview = async function (reviewId) {
    if (!confirm('Approve and send this response to the store?')) return;
    try {
      await marqFetch('/reviews/' + reviewId + '/approve', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'approved' }),
      });
      showToast('Response approved — sending to store', 'success');
      if (window.marqState.currentApp) loadReviewList(window.marqState.currentApp.id);
    } catch (e) {
      showToast('Approve failed: ' + e.message, 'error');
    }
  };

  window.skipReview = async function (reviewId) {
    try {
      await marqFetch('/reviews/' + reviewId + '/approve', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'skipped' }),
      });
      showToast('Review skipped', 'success');
      if (window.marqState.currentApp) loadReviewList(window.marqState.currentApp.id);
    } catch (e) {
      showToast('Skip failed: ' + e.message, 'error');
    }
  };

  window.editReviewDraft = function (reviewId) {
    // Find the review in DOM and get the draft text
    var reviews = window.marqState._lastReviews || [];
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.id = 'edit-draft-modal';
    overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };

    overlay.innerHTML = '<div class="modal" style="max-width:520px">' +
      '<h2>Edit Response Draft</h2>' +
      '<div class="form-group">' +
        '<label>Response Text</label>' +
        '<textarea id="edit-draft-text" rows="6" placeholder="Loading..."></textarea>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">' +
          '<span id="edit-draft-chars">0</span> characters' +
        '</div>' +
      '</div>' +
      '<div class="modal-actions">' +
        '<button class="btn" onclick="document.getElementById(\'edit-draft-modal\').remove()">Cancel</button>' +
        '<button class="btn btn-primary" onclick="sendEditedDraft(\'' + reviewId + '\')">Approve & Send</button>' +
      '</div>' +
    '</div>';

    document.body.appendChild(overlay);

    // Load current draft
    marqFetch('/apps/' + (window.marqState.currentApp ? window.marqState.currentApp.id : '') + '/reviews?limit=100')
      .then(function (reviews) {
        var found = reviews.find(function (r) { return r.id === reviewId; });
        if (found) {
          var ta = document.getElementById('edit-draft-text');
          ta.value = found.response_draft || '';
          document.getElementById('edit-draft-chars').textContent = ta.value.length;
          ta.oninput = function () {
            document.getElementById('edit-draft-chars').textContent = ta.value.length;
          };
        }
      });
  };

  window.sendEditedDraft = async function (reviewId) {
    var text = document.getElementById('edit-draft-text').value.trim();
    if (!text) { showToast('Response text is required', 'error'); return; }

    try {
      await marqFetch('/reviews/' + reviewId + '/approve', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'approved', response_text: text }),
      });
      showToast('Response approved — sending to store', 'success');
      document.getElementById('edit-draft-modal').remove();
      if (window.marqState.currentApp) loadReviewList(window.marqState.currentApp.id);
    } catch (e) {
      showToast('Failed: ' + e.message, 'error');
    }
  };

  // ── Review Events ──────────────────────────────────────────

  async function loadReviewEvents(appId) {
    var area = document.getElementById('review-events-area');
    if (!area) return;

    try {
      var events = await marqFetch('/apps/' + appId + '/review-events?limit=20');
      if (!events || events.length === 0) {
        area.innerHTML = '';
        return;
      }

      var html = '<div class="card" style="margin-top:20px">' +
        '<h3 style="font-size:14px;margin-bottom:12px">Recent Review Events</h3>' +
        '<div style="max-height:240px;overflow-y:auto">';

      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var sourceClass = ev.source === 'webhook' ? 'badge-purple' : ev.source === 'poll' ? 'badge-blue' : 'badge-gray';
        html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">' +
          '<span class="badge ' + (ev.store === 'apple' ? 'badge-ios' : 'badge-android') + '" style="font-size:10px">' + esc(ev.store) + '</span>' +
          '<span>' + esc(ev.parsed_summary || ev.event_type) + '</span>' +
          '<span class="badge ' + sourceClass + '" style="font-size:10px">' + esc(ev.source) + '</span>' +
          '<span class="text-muted" style="margin-left:auto;white-space:nowrap">' + formatDate(ev.created_at) + '</span>' +
        '</div>';
      }

      html += '</div></div>';
      area.innerHTML = html;
    } catch (e) {
      area.innerHTML = '';
    }
  }

  // ── Helpers ──────────────────────────────────────────────

  function starColor(rating) {
    if (rating >= 4) return 'var(--green)';
    if (rating === 3) return 'var(--yellow)';
    return 'var(--red)';
  }

  function starIcons(rating) {
    var html = '';
    for (var i = 1; i <= 5; i++) {
      html += '<span style="color:' + (i <= rating ? '#f5a623' : 'var(--text-dim)') + '">\u2605</span>';
    }
    return html;
  }

  function reviewStatusBadge(status) {
    var map = {
      pending: 'badge-gray',
      draft_ready: 'badge-blue',
      approved: 'badge-yellow',
      sent: 'badge-green',
      skipped: 'badge-gray',
    };
    return '<span class="badge ' + (map[status] || 'badge-gray') + '">' + (status || 'unknown').replace(/_/g, ' ') + '</span>';
  }

})();
