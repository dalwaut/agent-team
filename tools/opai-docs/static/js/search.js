/**
 * OPAI Docs — Fuzzy search module using Fuse.js.
 */
(function () {
  'use strict';

  let fuse = null;
  let onSelect = null;

  /**
   * Initialize search with docs sections.
   * @param {Array} sections - Array of section objects from docs.json
   * @param {Function} selectCallback - Called with section id when result selected
   */
  function init(sections, selectCallback) {
    onSelect = selectCallback;

    // Build search index from sections
    const items = sections.map(s => ({
      id: s.id,
      title: s.title,
      description: s.description || '',
      content: (s.content_md || '').replace(/[#*`|>\-\[\]()]/g, ' ').substring(0, 2000),
      technical: (s.technical_md || '').replace(/[#*`|>\-\[\]()]/g, ' ').substring(0, 1000),
    }));

    fuse = new Fuse(items, {
      keys: [
        { name: 'title', weight: 3 },
        { name: 'description', weight: 2 },
        { name: 'content', weight: 1 },
        { name: 'technical', weight: 0.5 },
      ],
      threshold: 0.4,
      includeMatches: true,
      minMatchCharLength: 2,
    });

    // Wire up input
    const input = document.getElementById('search-input');
    const results = document.getElementById('search-results');

    input.addEventListener('input', function () {
      const query = this.value.trim();
      if (query.length < 2) {
        results.classList.add('hidden');
        results.innerHTML = '';
        return;
      }
      const hits = fuse.search(query, { limit: 8 });
      renderResults(hits, results);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        this.value = '';
        results.classList.add('hidden');
        results.innerHTML = '';
        this.blur();
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        navigateResults(e.key === 'ArrowDown' ? 1 : -1, results);
      }
      if (e.key === 'Enter') {
        const active = results.querySelector('.search-result-item.active');
        if (active) {
          active.click();
        }
      }
    });

    // Close on click outside
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.sidebar-search')) {
        results.classList.add('hidden');
      }
    });

    // Ctrl+K shortcut
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        input.focus();
        input.select();
      }
    });
  }

  function renderResults(hits, container) {
    if (hits.length === 0) {
      container.innerHTML = '<div class="search-result-item"><span class="search-result-title" style="color:var(--text-muted)">No results found</span></div>';
      container.classList.remove('hidden');
      return;
    }

    container.innerHTML = hits.map((hit, i) => {
      const item = hit.item;
      // Find a relevant match snippet
      let matchSnippet = '';
      if (hit.matches) {
        for (const m of hit.matches) {
          if (m.key === 'content' && m.value) {
            const idx = m.indices[0];
            if (idx) {
              const start = Math.max(0, idx[0] - 30);
              const end = Math.min(m.value.length, idx[1] + 50);
              matchSnippet = '...' + m.value.substring(start, end).trim() + '...';
            }
            break;
          }
        }
      }

      return '<div class="search-result-item' + (i === 0 ? ' active' : '') + '" data-id="' + item.id + '">'
        + '<div class="search-result-title">' + escapeHtml(item.title) + '</div>'
        + (item.description ? '<div class="search-result-desc">' + escapeHtml(item.description.substring(0, 100)) + '</div>' : '')
        + (matchSnippet ? '<div class="search-result-match">' + escapeHtml(matchSnippet) + '</div>' : '')
        + '</div>';
    }).join('');

    container.classList.remove('hidden');

    // Click handlers
    container.querySelectorAll('.search-result-item[data-id]').forEach(el => {
      el.addEventListener('click', function () {
        const id = this.dataset.id;
        container.classList.add('hidden');
        document.getElementById('search-input').value = '';
        if (onSelect) onSelect(id);
      });
    });
  }

  function navigateResults(dir, container) {
    const items = container.querySelectorAll('.search-result-item[data-id]');
    if (items.length === 0) return;
    let idx = -1;
    items.forEach((el, i) => { if (el.classList.contains('active')) idx = i; });
    items.forEach(el => el.classList.remove('active'));
    idx = (idx + dir + items.length) % items.length;
    items[idx].classList.add('active');
    items[idx].scrollIntoView({ block: 'nearest' });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  window.DocsSearch = { init: init };
})();
