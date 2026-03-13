/* OPAI Docs — Static SPA */
(function () {
    'use strict';

    const MANIFEST_URL = '/docs/manifest.json';
    const WIKI_BASE = '/docs/wiki/';

    const CAT_LABELS = {
        index: 'Index',
        core: 'Core',
        tools: 'Tools',
        agents: 'Agents',
        integrations: 'Integrations',
        infra: 'Infrastructure',
        plans: 'Plans',
    };

    let manifest = null;
    let fuse = null;
    let currentPath = null;
    let searchActiveIdx = -1;

    // ── Navbar Detection ──────────────────────────────────────────────
    function detectNavbar() {
        var nav = document.querySelector('.opai-navbar');
        if (nav) {
            document.documentElement.style.setProperty('--navbar-h', nav.offsetHeight + 'px');
        }
        // Also watch for late injection
        var observer = new MutationObserver(function () {
            var el = document.querySelector('.opai-navbar');
            if (el) {
                document.documentElement.style.setProperty('--navbar-h', el.offsetHeight + 'px');
                observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: false });
    }

    // ── Auth ──────────────────────────────────────────────────────────
    async function initAuth() {
        if (typeof opaiAuth !== 'undefined' && opaiAuth.init) {
            try { await opaiAuth.init({ allowAnonymous: true }); } catch (e) { /* proceed without auth */ }
        }
    }

    // ── Manifest & Sidebar ───────────────────────────────────────────
    async function loadManifest() {
        try {
            const resp = await fetch(MANIFEST_URL);
            if (!resp.ok) throw new Error('Manifest not found');
            manifest = await resp.json();
        } catch (e) {
            document.getElementById('main').innerHTML =
                '<div class="doc-error">Could not load docs manifest. Run: <code>python3 tools/opai-docs/build-manifest.py</code></div>';
            return;
        }

        buildSidebar();
        buildSearch();
        showWelcomeStats();

        // Route to hash if present
        if (location.hash && location.hash.length > 1) {
            navigateTo(location.hash.slice(1));
        }
    }

    function buildSidebar() {
        const sidebar = document.getElementById('sidebar');
        if (!manifest || !manifest.docs) return;

        // Group by category
        const groups = {};
        for (const doc of manifest.docs) {
            const cat = doc.category || 'other';
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(doc);
        }

        // Render in category order
        const order = ['index', 'core', 'tools', 'agents', 'integrations', 'infra', 'plans'];
        let html = '';

        for (const cat of order) {
            const docs = groups[cat];
            if (!docs || !docs.length) continue;

            const label = CAT_LABELS[cat] || cat;
            html += '<div class="sidebar-category" data-cat="' + cat + '">';
            html += '<div class="sidebar-cat-header" onclick="window._docsToggleCat(this)">';
            html += '<span class="sidebar-chevron">&#9660;</span>';
            html += label + '<span class="sidebar-count">(' + docs.length + ')</span>';
            html += '</div>';
            html += '<div class="sidebar-cat-items">';
            for (const doc of docs) {
                const slug = doc.path.replace(/\.md$/, '');
                html += '<a class="sidebar-link" href="#' + slug + '" data-path="' + doc.path + '">';
                html += escHtml(doc.title);
                html += '</a>';
            }
            html += '</div></div>';
        }

        sidebar.innerHTML = html;

        // Click handlers
        sidebar.addEventListener('click', function (e) {
            const link = e.target.closest('.sidebar-link');
            if (!link) return;
            e.preventDefault();
            const path = link.dataset.path;
            const slug = path.replace(/\.md$/, '');
            location.hash = '#' + slug;
            closeMobileSidebar();
        });
    }

    window._docsToggleCat = function (header) {
        header.parentElement.classList.toggle('collapsed');
    };

    function highlightSidebarLink(path) {
        document.querySelectorAll('.sidebar-link').forEach(function (el) {
            el.classList.toggle('active', el.dataset.path === path);
        });
    }

    // ── Search (Fuse.js — full-text indexed) ─────────────────────────
    function buildSearch() {
        if (!manifest || !manifest.docs) return;

        var items = manifest.docs.map(function (doc) {
            return {
                path: doc.path,
                title: doc.title,
                description: doc.description || '',
                category: CAT_LABELS[doc.category] || doc.category,
                sections: (doc.sections || []).join(' '),
                searchText: doc.search_text || '',
            };
        });

        fuse = new Fuse(items, {
            keys: [
                { name: 'title', weight: 0.35 },
                { name: 'sections', weight: 0.25 },
                { name: 'searchText', weight: 0.2 },
                { name: 'description', weight: 0.1 },
                { name: 'category', weight: 0.1 },
            ],
            threshold: 0.4,
            includeScore: true,
            includeMatches: true,
        });
    }

    function getSnippet(text, query, maxLen) {
        maxLen = maxLen || 120;
        if (!text || !query) return '';

        // Find the query (case-insensitive) in text and extract surrounding context
        var lower = text.toLowerCase();
        var qLower = query.toLowerCase().split(/\s+/)[0]; // use first word for matching
        var idx = lower.indexOf(qLower);

        if (idx === -1) return text.slice(0, maxLen) + (text.length > maxLen ? '...' : '');

        // Window around match
        var start = Math.max(0, idx - 40);
        var end = Math.min(text.length, idx + qLower.length + 80);
        var snippet = (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');

        // Highlight all query words in the snippet
        var words = query.toLowerCase().split(/\s+/).filter(Boolean);
        for (var i = 0; i < words.length; i++) {
            var w = words[i];
            var re = new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
            snippet = snippet.replace(re, '<mark>$1</mark>');
        }

        return snippet;
    }

    function doSearch(query) {
        var resultsEl = document.getElementById('search-results');
        if (!query || !fuse) {
            resultsEl.classList.remove('open');
            searchActiveIdx = -1;
            return;
        }

        var hits = fuse.search(query, { limit: 15 });
        if (!hits.length) {
            resultsEl.innerHTML = '<div class="search-result-item"><span class="search-result-title" style="color:var(--text-dim)">No results for &ldquo;' + escHtml(query) + '&rdquo;</span></div>';
            resultsEl.classList.add('open');
            searchActiveIdx = -1;
            return;
        }

        resultsEl.innerHTML = hits.map(function (hit, i) {
            // Build snippet from the best matching field
            var snippet = '';
            var item = hit.item;

            // Try search_text first for content matches
            if (item.searchText) {
                snippet = getSnippet(item.searchText, query);
            } else if (item.description) {
                snippet = getSnippet(item.description, query);
            }

            return '<div class="search-result-item" data-idx="' + i + '" data-path="' + item.path + '">' +
                '<div class="search-result-title">' + escHtml(item.title) + '</div>' +
                '<div class="search-result-cat">' + escHtml(item.category) + ' &middot; ' + escHtml(item.path) + '</div>' +
                (snippet ? '<div class="search-result-snippet">' + snippet + '</div>' : '') +
                '</div>';
        }).join('');

        resultsEl.classList.add('open');
        searchActiveIdx = -1;
    }

    function selectSearchResult(path) {
        var slug = path.replace(/\.md$/, '');
        location.hash = '#' + slug;
        document.getElementById('search-input').value = '';
        document.getElementById('search-results').classList.remove('open');
        searchActiveIdx = -1;
    }

    // ── Navigation ───────────────────────────────────────────────────
    function navigateTo(slug) {
        // slug is like "core/portal" or "tools/brain"
        var path = slug.endsWith('.md') ? slug : slug + '.md';
        currentPath = path;
        highlightSidebarLink(path);
        loadDoc(path);
    }

    async function loadDoc(path) {
        var mainEl = document.getElementById('main');
        mainEl.innerHTML = '<div class="doc-loading">Loading...</div>';
        mainEl.scrollTop = 0;

        try {
            var resp = await fetch(WIKI_BASE + path);
            if (!resp.ok) throw new Error('Not found: ' + path);
            var md = await resp.text();
            renderDoc(md, path);
        } catch (e) {
            mainEl.innerHTML = '<div class="doc-error">Could not load: ' + escHtml(path) + '</div>';
        }
    }

    function renderDoc(md, path) {
        var mainEl = document.getElementById('main');

        // Find doc metadata from manifest
        var docMeta = manifest ? manifest.docs.find(function (d) { return d.path === path; }) : null;

        // Build meta bar
        var metaHtml = '';
        if (docMeta) {
            metaHtml = '<div class="doc-meta">';
            if (docMeta.category) {
                metaHtml += '<span class="doc-meta-tag">' + escHtml(CAT_LABELS[docMeta.category] || docMeta.category) + '</span>';
            }
            if (docMeta.port) {
                metaHtml += '<span class="doc-meta-tag">Port ' + docMeta.port + '</span>';
            }
            if (docMeta.source) {
                metaHtml += '<span class="doc-meta-tag">' + escHtml(docMeta.source) + '</span>';
            }
            if (docMeta.last_updated) {
                metaHtml += '<span class="doc-meta-tag">Updated ' + escHtml(docMeta.last_updated) + '</span>';
            }
            metaHtml += '</div>';
        }

        // Configure marked
        var renderer = new marked.Renderer();

        // Rewrite internal .md links to hash routes
        renderer.link = function (token) {
            var href = token.href || '';
            var text = token.text || '';

            if (href.endsWith('.md') && !href.startsWith('http')) {
                // Relative link: resolve relative to current doc's directory
                if (!href.startsWith('/')) {
                    var parts = path.split('/');
                    parts.pop(); // remove filename
                    var linkParts = href.split('/');
                    for (var j = 0; j < linkParts.length; j++) {
                        var p = linkParts[j];
                        if (p === '..') parts.pop();
                        else if (p !== '.') parts.push(p);
                    }
                    href = parts.join('/');
                }
                var slug = href.replace(/\.md$/, '');
                return '<a href="#' + slug + '">' + text + '</a>';
            }

            // External links
            var target = href.startsWith('http') ? ' target="_blank" rel="noopener"' : '';
            return '<a href="' + href + '"' + target + '>' + text + '</a>';
        };

        var html = marked.parse(md, { renderer: renderer, gfm: true, breaks: false });

        mainEl.innerHTML = '<div class="doc-content">' + metaHtml +
            '<div class="markdown-body">' + html + '</div></div>';
    }

    function showWelcomeStats() {
        if (!manifest) return;
        var statsEl = document.getElementById('welcome-stats');
        if (!statsEl) return;

        var catCounts = {};
        for (var i = 0; i < manifest.docs.length; i++) {
            var c = manifest.docs[i].category || 'other';
            catCounts[c] = (catCounts[c] || 0) + 1;
        }

        var cats = manifest.categories || {};
        var html = '<div class="welcome-stat"><div class="welcome-stat-num">' + manifest.count + '</div>' +
            '<div class="welcome-stat-label">Documents</div></div>';

        for (var key in cats) {
            if (cats.hasOwnProperty(key) && catCounts[key]) {
                html += '<div class="welcome-stat"><div class="welcome-stat-num">' + catCounts[key] + '</div>' +
                    '<div class="welcome-stat-label">' + escHtml(cats[key]) + '</div></div>';
            }
        }

        statsEl.innerHTML = html;
    }

    // ── Mobile Sidebar ───────────────────────────────────────────────
    function closeMobileSidebar() {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('sidebar-overlay').classList.remove('open');
    }

    // ── Utilities ────────────────────────────────────────────────────
    function escHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── Event Wiring ─────────────────────────────────────────────────
    function init() {
        // Detect navbar and set CSS variable
        detectNavbar();

        // Hash change
        window.addEventListener('hashchange', function () {
            if (location.hash && location.hash.length > 1) {
                navigateTo(location.hash.slice(1));
            }
        });

        // Search input
        var searchTimer;
        var searchInput = document.getElementById('search-input');
        var searchResults = document.getElementById('search-results');

        searchInput.addEventListener('input', function () {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(function () {
                doSearch(searchInput.value.trim());
            }, 150);
        });

        searchInput.addEventListener('keydown', function (e) {
            var items = searchResults.querySelectorAll('.search-result-item[data-path]');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                searchActiveIdx = Math.min(searchActiveIdx + 1, items.length - 1);
                updateSearchActive(items);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                searchActiveIdx = Math.max(searchActiveIdx - 1, 0);
                updateSearchActive(items);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (searchActiveIdx >= 0 && items[searchActiveIdx]) {
                    selectSearchResult(items[searchActiveIdx].dataset.path);
                } else if (items.length > 0) {
                    selectSearchResult(items[0].dataset.path);
                }
            } else if (e.key === 'Escape') {
                searchResults.classList.remove('open');
                searchInput.blur();
            }
        });

        searchInput.addEventListener('focus', function () {
            if (searchInput.value.trim()) doSearch(searchInput.value.trim());
        });

        // Click search result
        searchResults.addEventListener('click', function (e) {
            var item = e.target.closest('.search-result-item[data-path]');
            if (item) selectSearchResult(item.dataset.path);
        });

        // Close search on outside click
        document.addEventListener('click', function (e) {
            if (!e.target.closest('.search-wrapper')) {
                searchResults.classList.remove('open');
            }
        });

        // Ctrl+K shortcut
        document.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                searchInput.focus();
                searchInput.select();
            }
        });

        // Mobile sidebar toggle
        document.getElementById('mobile-toggle').addEventListener('click', function () {
            document.getElementById('sidebar').classList.toggle('open');
            document.getElementById('sidebar-overlay').classList.toggle('open');
        });

        document.getElementById('sidebar-overlay').addEventListener('click', closeMobileSidebar);
    }

    function updateSearchActive(items) {
        items.forEach(function (el, i) {
            el.classList.toggle('active', i === searchActiveIdx);
        });
        if (items[searchActiveIdx]) {
            items[searchActiveIdx].scrollIntoView({ block: 'nearest' });
        }
    }

    // ── Boot ─────────────────────────────────────────────────────────
    initAuth().then(function () {
        init();
        loadManifest();
    });
})();
