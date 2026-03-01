/**
 * Marq — Assets Tab
 *
 * Upload and manage app icons, screenshots (per store/device type), and feature graphics.
 */
(function () {
  'use strict';

  var DEVICE_TYPES = {
    apple: [
      { value: 'iphone_6_5',    label: 'iPhone 6.5"',   dims: '1284x2778' },
      { value: 'iphone_5_5',    label: 'iPhone 5.5"',   dims: '1242x2208' },
      { value: 'ipad_12_9',     label: 'iPad 12.9"',    dims: '2048x2732' },
      { value: 'ipad_11',       label: 'iPad 11"',      dims: '1668x2388' },
    ],
    google: [
      { value: 'phone',         label: 'Phone',         dims: '1080x1920' },
      { value: 'tablet_7',      label: '7" Tablet',     dims: '1200x1920' },
      { value: 'tablet_10',     label: '10" Tablet',    dims: '1800x2560' },
    ],
  };

  window.renderAssetsTab = function (el) {
    var app = window.marqState.currentApp;
    if (!app) {
      el.innerHTML = emptyState('\uD83D\uDDBC', 'Select an app first', 'Go to Dashboard and click on an app to manage assets.');
      return;
    }

    var platform = app.platform || 'both';

    var html = '<div class="assets-header">' +
      '<div><h2>Assets</h2><span class="text-muted">Icons, screenshots, and graphics for ' + esc(app.name) + '</span></div>' +
    '</div>';

    // Icon section
    html += renderIconSection(app);

    // Screenshots — Apple
    if (platform === 'ios' || platform === 'both') {
      html += renderScreenshotSection(app, 'apple', 'Apple App Store');
    }

    // Screenshots — Google
    if (platform === 'android' || platform === 'both') {
      html += renderScreenshotSection(app, 'google', 'Google Play Store');
    }

    // Feature Graphic — Google only
    if (platform === 'android' || platform === 'both') {
      html += renderFeatureGraphicSection(app);
    }

    el.innerHTML = html;

    // Bind drag-drop zones after render
    bindDropZones();
    // Load existing screenshots
    loadScreenshots(app.id);
  };

  // ── Icon Section ──────────────────────────────────────────
  function renderIconSection(app) {
    var iconUrl = app.icon_storage_key ? '/marq/api/assets/' + app.id + '/icon.png?t=' + Date.now() : null;

    return '<div class="card asset-section">' +
      '<h3>App Icon</h3>' +
      '<p class="text-muted" style="font-size:12px;margin:4px 0 12px">Apple: 1024x1024 PNG, no alpha. Google: 512x512 PNG.</p>' +
      '<div class="asset-icon-row">' +
        (iconUrl
          ? '<img class="asset-icon-preview" src="' + iconUrl + '" alt="App Icon">'
          : '<div class="asset-icon-placeholder">\uD83D\uDDBC</div>') +
        '<div class="asset-drop-zone" data-upload-type="icon" data-app-id="' + app.id + '">' +
          '<div class="drop-zone-content">' +
            '<span class="drop-zone-icon">\u2B06</span>' +
            '<span>Drop icon here or <label class="drop-zone-browse">browse<input type="file" accept="image/png" style="display:none" onchange="handleIconUpload(this)"></label></span>' +
          '</div>' +
        '</div>' +
        '<button class="btn btn-sm asset-pick-btn" onclick="pickFileForIcon(\'' + app.id + '\')">\uD83D\uDCC2 Choose from Files</button>' +
      '</div>' +
    '</div>';
  }

  // ── Screenshot Section ────────────────────────────────────
  function renderScreenshotSection(app, store, storeLabel) {
    var types = DEVICE_TYPES[store] || [];
    var badge = store === 'apple' ? '<span class="badge badge-ios">iOS</span>' : '<span class="badge badge-android">Android</span>';

    var html = '<div class="card asset-section">' +
      '<div class="asset-section-header">' +
        '<h3>' + badge + ' ' + esc(storeLabel) + ' Screenshots</h3>' +
      '</div>';

    for (var i = 0; i < types.length; i++) {
      var dt = types[i];
      html += '<div class="asset-device-group" data-store="' + store + '" data-device="' + dt.value + '">' +
        '<div class="device-group-header">' +
          '<strong>' + esc(dt.label) + '</strong>' +
          '<span class="text-muted" style="font-size:11px">' + dt.dims + '</span>' +
        '</div>' +
        '<div class="screenshot-grid" id="ss-grid-' + store + '-' + dt.value + '"></div>' +
        '<div class="asset-drop-zone asset-drop-zone-sm" data-upload-type="screenshot" data-app-id="' + app.id + '" data-store="' + store + '" data-device="' + dt.value + '">' +
          '<div class="drop-zone-content">' +
            '<span>Drop screenshots or <label class="drop-zone-browse">browse<input type="file" accept="image/png,image/jpeg,image/webp" multiple style="display:none" onchange="handleScreenshotUpload(this)"></label></span>' +
          '</div>' +
        '</div>' +
        '<button class="btn btn-sm asset-pick-btn" onclick="pickFileForScreenshot(\'' + app.id + '\', \'' + store + '\', \'' + dt.value + '\')">\uD83D\uDCC2 Choose from Files</button>' +
      '</div>';
    }

    html += '</div>';
    return html;
  }

  // ── Feature Graphic ───────────────────────────────────────
  function renderFeatureGraphicSection(app) {
    return '<div class="card asset-section">' +
      '<h3>Feature Graphic <span class="badge badge-android">Android</span></h3>' +
      '<p class="text-muted" style="font-size:12px;margin:4px 0 12px">1024x500 PNG or JPEG. Required for Google Play.</p>' +
      '<div id="feature-graphic-preview"></div>' +
      '<div class="asset-drop-zone" data-upload-type="feature_graphic" data-app-id="' + app.id + '">' +
        '<div class="drop-zone-content">' +
          '<span class="drop-zone-icon">\u2B06</span>' +
          '<span>Drop feature graphic or <label class="drop-zone-browse">browse<input type="file" accept="image/png,image/jpeg" style="display:none" onchange="handleFeatureGraphicUpload(this)"></label></span>' +
        '</div>' +
      '</div>' +
      '<button class="btn btn-sm asset-pick-btn" onclick="pickFileForFeatureGraphic(\'' + app.id + '\')">\uD83D\uDCC2 Choose from Files</button>' +
    '</div>';
  }

  // ── Load existing screenshots ─────────────────────────────
  async function loadScreenshots(appId) {
    try {
      var shots = await marqFetch('/apps/' + appId + '/screenshots');
      window.marqState._screenshots = shots;
      renderScreenshotThumbnails(shots);
    } catch (e) {
      console.error('Failed to load screenshots:', e);
    }
  }

  function renderScreenshotThumbnails(shots) {
    // Group by store + device_type
    var groups = {};
    for (var i = 0; i < shots.length; i++) {
      var s = shots[i];
      var key = s.store + '-' + s.device_type;
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    }

    // Render into each grid
    for (var gkey in groups) {
      var grid = document.getElementById('ss-grid-' + gkey);
      if (!grid) continue;
      var items = groups[gkey].sort(function(a, b) { return (a.display_order || 0) - (b.display_order || 0); });
      var html = '';
      for (var j = 0; j < items.length; j++) {
        var ss = items[j];
        var imgUrl = ss.storage_key ? '/marq/api/assets/' + ss.storage_key + '?t=' + Date.now() : '';
        html += '<div class="screenshot-thumb" data-id="' + ss.id + '" data-order="' + (ss.display_order || 0) + '">' +
          (imgUrl ? '<img src="' + imgUrl + '" alt="Screenshot">' : '<div class="thumb-placeholder">?</div>') +
          '<div class="thumb-meta">' +
            '<span class="text-muted" style="font-size:10px">' + (ss.width || '?') + 'x' + (ss.height || '?') + '</span>' +
            (ss.is_valid === false ? '<span class="badge badge-red" style="font-size:9px">invalid</span>' : '') +
          '</div>' +
          '<div class="thumb-actions">' +
            (j > 0 ? '<button class="btn btn-sm" onclick="event.stopPropagation(); reorderScreenshot(\'' + ss.id + '\', -1)" title="Move left">\u2190</button>' : '') +
            (j < items.length - 1 ? '<button class="btn btn-sm" onclick="event.stopPropagation(); reorderScreenshot(\'' + ss.id + '\', 1)" title="Move right">\u2192</button>' : '') +
            '<button class="btn btn-sm btn-danger" onclick="event.stopPropagation(); deleteScreenshot(\'' + ss.id + '\')" title="Delete">\u2715</button>' +
          '</div>' +
        '</div>';
      }
      grid.innerHTML = html;
    }

    // Clean grids that have no items
    var allGrids = document.querySelectorAll('.screenshot-grid');
    allGrids.forEach(function(g) {
      var id = g.id.replace('ss-grid-', '');
      if (!groups[id]) g.innerHTML = '';
    });
  }

  // ── Icon Upload ───────────────────────────────────────────
  window.handleIconUpload = async function (input) {
    var file = input.files[0];
    if (!file) return;
    var app = window.marqState.currentApp;
    if (!app) return;

    var zone = input.closest('.asset-drop-zone');
    if (zone) zone.classList.add('uploading');

    var formData = new FormData();
    formData.append('file', file);

    try {
      await uploadAsset('/apps/' + app.id + '/icon', formData);
      showToast('Icon uploaded', 'success');
      // Refresh app data to get icon_storage_key
      var apps = await marqFetch('/apps');
      window.marqState.apps = apps;
      var updated = apps.find(function(a) { return a.id === app.id; });
      if (updated) window.marqState.currentApp = updated;
      renderAssetsTab(document.getElementById('content'));
    } catch (e) {
      showToast('Icon upload failed: ' + e.message, 'error');
    } finally {
      if (zone) zone.classList.remove('uploading');
    }
  };

  // ── Screenshot Upload ─────────────────────────────────────
  window.handleScreenshotUpload = async function (input) {
    var files = input.files;
    if (!files || !files.length) return;
    var zone = input.closest('.asset-drop-zone');
    var appId = zone.dataset.appId;
    var store = zone.dataset.store;
    var device = zone.dataset.device;

    zone.classList.add('uploading');

    var existing = (window.marqState._screenshots || []).filter(function(s) {
      return s.store === store && s.device_type === device;
    });
    var nextOrder = existing.length;

    for (var i = 0; i < files.length; i++) {
      var formData = new FormData();
      formData.append('file', files[i]);
      formData.append('store', store);
      formData.append('device_type', device);
      formData.append('locale', 'en-US');
      formData.append('display_order', String(nextOrder + i));

      try {
        await uploadAsset('/apps/' + appId + '/screenshots', formData);
      } catch (e) {
        showToast('Upload failed: ' + e.message, 'error');
      }
    }

    showToast(files.length + ' screenshot(s) uploaded', 'success');
    zone.classList.remove('uploading');
    loadScreenshots(appId);
  };

  // ── Feature Graphic Upload ────────────────────────────────
  window.handleFeatureGraphicUpload = async function (input) {
    var file = input.files[0];
    if (!file) return;
    var app = window.marqState.currentApp;
    if (!app) return;

    var zone = input.closest('.asset-drop-zone');
    if (zone) zone.classList.add('uploading');

    var formData = new FormData();
    formData.append('file', file);
    formData.append('store', 'google');
    formData.append('device_type', 'feature_graphic');
    formData.append('locale', 'en-US');
    formData.append('display_order', '0');

    try {
      await uploadAsset('/apps/' + app.id + '/screenshots', formData);
      showToast('Feature graphic uploaded', 'success');
      loadScreenshots(app.id);
    } catch (e) {
      showToast('Feature graphic upload failed: ' + e.message, 'error');
    } finally {
      if (zone) zone.classList.remove('uploading');
    }
  };

  // ── Reorder ───────────────────────────────────────────────
  window.reorderScreenshot = async function (id, direction) {
    try {
      await marqFetch('/screenshots/' + id + '/reorder', {
        method: 'PATCH',
        body: JSON.stringify({ direction: direction }),
      });
      var app = window.marqState.currentApp;
      if (app) loadScreenshots(app.id);
    } catch (e) {
      showToast('Reorder failed: ' + e.message, 'error');
    }
  };

  // ── Delete ────────────────────────────────────────────────
  window.deleteScreenshot = async function (id) {
    if (!confirm('Delete this screenshot?')) return;
    try {
      await marqFetch('/screenshots/' + id, { method: 'DELETE' });
      showToast('Screenshot deleted', 'success');
      var app = window.marqState.currentApp;
      if (app) loadScreenshots(app.id);
    } catch (e) {
      showToast('Delete failed: ' + e.message, 'error');
    }
  };

  // ── Upload helper (multipart) ─────────────────────────────
  async function uploadAsset(path, formData) {
    var headers = {};
    if (window.marqState.token) {
      headers['Authorization'] = 'Bearer ' + window.marqState.token;
    }
    // Do NOT set Content-Type — let browser set multipart boundary
    var res = await fetch('/marq/api' + path, {
      method: 'POST',
      headers: headers,
      body: formData,
    });
    if (!res.ok) {
      var errMsg = 'Upload error: ' + res.status;
      try {
        var errBody = await res.json();
        if (errBody.detail) errMsg = errBody.detail;
      } catch (_) {}
      throw new Error(errMsg);
    }
    return res.json();
  }

  // ── File Picker (OPAI files) ─────────────────────────────
  window.pickFileForIcon = function (appId) {
    openFilePicker({
      mode: 'all',
      title: 'Choose Icon Image',
      onSelect: function (path) {
        importFromPath(appId, path, 'icon');
      },
    });
  };

  window.pickFileForScreenshot = function (appId, store, deviceType) {
    openFilePicker({
      mode: 'all',
      title: 'Choose Screenshot Image',
      onSelect: function (path) {
        var existing = (window.marqState._screenshots || []).filter(function(s) {
          return s.store === store && s.device_type === deviceType;
        });
        importFromPath(appId, path, 'screenshot', { store: store, device_type: deviceType, display_order: existing.length });
      },
    });
  };

  window.pickFileForFeatureGraphic = function (appId) {
    openFilePicker({
      mode: 'all',
      title: 'Choose Feature Graphic',
      onSelect: function (path) {
        importFromPath(appId, path, 'feature_graphic', { store: 'google', device_type: 'feature_graphic' });
      },
    });
  };

  async function importFromPath(appId, filePath, assetType, extra) {
    var body = { file_path: filePath, asset_type: assetType };
    if (extra) {
      if (extra.store) body.store = extra.store;
      if (extra.device_type) body.device_type = extra.device_type;
      if (extra.display_order !== undefined) body.display_order = extra.display_order;
    }

    try {
      var result = await marqFetch('/apps/' + appId + '/import-from-path', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (result.ok) {
        showToast('Imported ' + assetType + ' from files', 'success');
        if (assetType === 'icon') {
          // Refresh app to get new icon_storage_key
          var apps = await marqFetch('/apps');
          window.marqState.apps = apps;
          var updated = apps.find(function(a) { return a.id === appId; });
          if (updated) window.marqState.currentApp = updated;
        }
        renderAssetsTab(document.getElementById('content'));
      } else {
        showToast('Import failed', 'error');
      }
    } catch (e) {
      showToast('Import failed: ' + e.message, 'error');
    }
  }

  // ── Drag and Drop ─────────────────────────────────────────
  function bindDropZones() {
    var zones = document.querySelectorAll('.asset-drop-zone');
    zones.forEach(function (zone) {
      zone.addEventListener('dragover', function (e) {
        e.preventDefault();
        zone.classList.add('drop-zone-active');
      });
      zone.addEventListener('dragleave', function () {
        zone.classList.remove('drop-zone-active');
      });
      zone.addEventListener('drop', function (e) {
        e.preventDefault();
        zone.classList.remove('drop-zone-active');
        var files = e.dataTransfer.files;
        if (!files || !files.length) return;

        var type = zone.dataset.uploadType;
        if (type === 'icon') {
          // Create a fake input-like object
          handleIconUpload({ files: [files[0]], closest: function() { return zone; } });
        } else if (type === 'screenshot') {
          handleScreenshotUpload({ files: files, closest: function() { return zone; } });
        } else if (type === 'feature_graphic') {
          handleFeatureGraphicUpload({ files: [files[0]], closest: function() { return zone; } });
        }
      });
    });
  }

})();
