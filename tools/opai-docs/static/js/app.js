/**
 * OPAI Docs — Main application.
 * Init auth, fetch docs, render sidebar + content, hash routing.
 */
(function () {
  'use strict';

  let sb = null;       // Supabase client
  let session = null;  // Current session
  let docsData = null; // Full docs response
  let isAdmin = false;

  const $loading = document.getElementById('loading');
  const $app = document.getElementById('app');
  const $sidebarNav = document.getElementById('sidebar-nav');
  const $content = document.getElementById('content-inner');
  const $generated = document.getElementById('generated-at');
  const $btnRegen = document.getElementById('btn-regenerate');
  const $sidebar = document.getElementById('sidebar');
  const $overlay = document.getElementById('sidebar-overlay');

  // ── Auth ────────────────────────────────────────────────

  async function initAuth() {
    // Fetch Supabase config
    const resp = await fetch('/docs/api/auth/config');
    const cfg = await resp.json();

    sb = supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);

    const { data } = await sb.auth.getSession();
    if (!data.session) {
      window.location.href = '/auth/login?return=/docs/';
      return null;
    }

    session = data.session;
    isAdmin = session.user?.app_metadata?.role === 'admin';

    // Listen for token refresh
    sb.auth.onAuthStateChange((event, s) => {
      if (s) session = s;
    });

    return session;
  }

  // ── Fetch docs ─────────────────────────────────────────

  async function fetchDocs() {
    const resp = await fetch('/docs/api/docs', {
      headers: { 'Authorization': 'Bearer ' + session.access_token },
    });
    if (!resp.ok) throw new Error('Failed to fetch docs: ' + resp.status);
    return resp.json();
  }

  // ── Sidebar ────────────────────────────────────────────

  function renderSidebar(docs) {
    const sectionMap = {};
    for (const s of docs.sections) {
      sectionMap[s.id] = s;
    }

    let html = '';
    for (const cat of docs.categories) {
      // Only show categories that have visible sections
      const visibleSections = cat.sections.filter(id => sectionMap[id]);
      if (visibleSections.length === 0) continue;

      html += '<div class="nav-category">';
      html += '<div class="nav-category-title">' + escapeHtml(cat.title) + '</div>';

      for (const sid of visibleSections) {
        const section = sectionMap[sid];
        html += '<a class="nav-item" data-section="' + sid + '" href="#' + sid + '">';
        html += '<span class="nav-item-icon">' + getIcon(section.icon) + '</span>';
        html += escapeHtml(section.title);
        html += '</a>';
      }
      html += '</div>';
    }

    $sidebarNav.innerHTML = html;

    // Click handlers
    $sidebarNav.querySelectorAll('.nav-item').forEach(el => {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        navigateTo(this.dataset.section);
        closeMobileSidebar();
      });
    });
  }

  function highlightNavItem(sectionId) {
    $sidebarNav.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.section === sectionId);
    });
  }

  // ── Content rendering ──────────────────────────────────

  function renderSection(sectionId) {
    const section = docsData.sections.find(s => s.id === sectionId);
    if (!section) {
      $content.innerHTML = '<p style="color:var(--text-muted)">Section not found.</p>';
      return;
    }

    let html = '';

    // Header
    html += '<div class="section-header">';
    html += '<div class="section-icon-row">';
    html += '<div class="section-icon-badge">' + getIcon(section.icon) + '</div>';
    html += '<h1 class="section-title">' + escapeHtml(section.title) + '</h1>';
    html += '</div>';
    if (section.description) {
      html += '<p class="section-description">' + escapeHtml(section.description) + '</p>';
    }
    html += '</div>';

    // User-facing content
    if (section.content_md) {
      html += '<div class="md-content">' + renderMarkdown(section.content_md) + '</div>';
    }

    // Technical accordion (admin only)
    if (section.technical_md && isAdmin) {
      html += '<div class="tech-accordion">';
      html += '<button class="tech-accordion-toggle" onclick="this.classList.toggle(\'open\');this.nextElementSibling.classList.toggle(\'open\')">';
      html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>';
      html += 'Technical Details';
      html += '<span class="badge">Admin</span>';
      html += '</button>';
      html += '<div class="tech-accordion-body">';
      html += '<div class="md-content">' + renderMarkdown(section.technical_md) + '</div>';
      html += '</div>';
      html += '</div>';
    }

    $content.innerHTML = html;

    // Highlight code blocks
    $content.querySelectorAll('pre code').forEach(block => {
      hljs.highlightElement(block);
    });

    // Scroll content to top
    document.getElementById('content').scrollTop = 0;
  }

  // ── Wiki cross-link resolution ─────────────────────────

  let wikiLinkMap = {};  // "chat.md" → "chat", etc.

  function buildWikiLinkMap(sections) {
    wikiLinkMap = {};
    for (const s of sections) {
      if (s.source_file) {
        wikiLinkMap[s.source_file] = s.id;
      }
    }
  }

  function renderMarkdown(md) {
    if (!md) return '';
    const renderer = new marked.Renderer();
    renderer.link = function (token) {
      const href = token.href || '';
      const text = token.text || '';
      // Resolve wiki .md cross-links to hash navigation
      if (href.endsWith('.md') && wikiLinkMap[href]) {
        return '<a href="#' + wikiLinkMap[href] + '">' + text + '</a>';
      }
      // External links open in new tab
      if (href.startsWith('http')) {
        return '<a href="' + href + '" target="_blank" rel="noopener">' + text + '</a>';
      }
      return '<a href="' + href + '">' + text + '</a>';
    };
    return marked.parse(md, {
      gfm: true,
      breaks: false,
      renderer: renderer,
    });
  }

  // ── Navigation ─────────────────────────────────────────

  function navigateTo(sectionId) {
    window.location.hash = sectionId;
    renderSection(sectionId);
    highlightNavItem(sectionId);
  }

  function handleHashChange() {
    const hash = window.location.hash.replace('#', '');
    if (hash && docsData) {
      renderSection(hash);
      highlightNavItem(hash);
    }
  }

  // ── Mobile sidebar ─────────────────────────────────────

  function openMobileSidebar() {
    $sidebar.classList.add('open');
    $overlay.classList.remove('hidden');
  }

  function closeMobileSidebar() {
    $sidebar.classList.remove('open');
    $overlay.classList.add('hidden');
  }

  // ── Regenerate ─────────────────────────────────────────

  async function regenerateDocs() {
    $btnRegen.disabled = true;
    $btnRegen.textContent = 'Regenerating...';
    try {
      await fetch('/docs/api/docs/regenerate', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + session.access_token },
      });
      docsData = await fetchDocs();
      buildWikiLinkMap(docsData.sections);
      renderSidebar(docsData);
      window.DocsSearch.init(docsData.sections, navigateTo);
      // Re-render current section
      const hash = window.location.hash.replace('#', '');
      if (hash) renderSection(hash);
      $generated.textContent = 'Updated: ' + new Date(docsData.generated_at).toLocaleString();
    } catch (e) {
      console.error('Regenerate failed:', e);
    } finally {
      $btnRegen.disabled = false;
      $btnRegen.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg> Regenerate';
    }
  }

  // ── Icons (simple SVG) ─────────────────────────────────

  const ICONS = {
    'home': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    'log-in': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>',
    'hard-drive': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/></svg>',
    'message-circle': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>',
    'folder': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>',
    'send': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    'users': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>',
    'activity': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    'check-square': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>',
    'terminal': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
    'shield': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    'code': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
    'message-square': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>',
    'lock': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>',
    'cpu': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>',
    'server': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
    'zap': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    'menu': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
    'mail': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>',
    'layout': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>',
    'book-open': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/></svg>',
    'user-plus': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>',
    'shopping-bag': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>',
    'box': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
    'trello': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><rect x="7" y="7" width="3" height="9"/><rect x="14" y="7" width="3" height="5"/></svg>',
  };

  function getIcon(name) {
    return ICONS[name] || ICONS['home'];
  }

  // ── Helpers ─────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ── Init ────────────────────────────────────────────────

  async function init() {
    try {
      const s = await initAuth();
      if (!s) return; // Redirecting to login

      docsData = await fetchDocs();

      // Build wiki cross-link map from source_file → section id
      buildWikiLinkMap(docsData.sections);

      // Render sidebar
      renderSidebar(docsData);

      // Init search
      window.DocsSearch.init(docsData.sections, navigateTo);

      // Show generated timestamp
      if (docsData.generated_at) {
        $generated.textContent = 'Generated: ' + new Date(docsData.generated_at).toLocaleString();
      }

      // Show regenerate button for admins
      if (isAdmin) {
        $btnRegen.classList.remove('hidden');
        $btnRegen.addEventListener('click', regenerateDocs);
      }

      // Mobile sidebar handlers
      document.getElementById('hamburger').addEventListener('click', openMobileSidebar);
      document.getElementById('sidebar-close').addEventListener('click', closeMobileSidebar);
      $overlay.addEventListener('click', closeMobileSidebar);

      // Navigate to hash or first section
      const hash = window.location.hash.replace('#', '');
      if (hash && docsData.sections.find(s => s.id === hash)) {
        renderSection(hash);
        highlightNavItem(hash);
      } else if (docsData.sections.length > 0) {
        const firstId = docsData.sections[0].id;
        navigateTo(firstId);
      }

      // Hash change listener
      window.addEventListener('hashchange', handleHashChange);

      // Show app
      $loading.classList.add('hidden');
      $app.classList.remove('hidden');

    } catch (err) {
      console.error('Init failed:', err);
      $loading.innerHTML = '<p style="color:#ef4444">Failed to load documentation. Please refresh.</p>';
    }
  }

  // Run
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
