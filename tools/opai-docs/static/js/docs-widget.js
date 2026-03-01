/**
 * OPAI Docs Popup Widget — self-contained slide-in panel.
 * Add <script src="/docs/static/js/docs-widget.js" defer></script> to any tool page.
 *
 * Public API:
 *   DocsPopup.open(sectionId)   — open panel to a section
 *   DocsPopup.close()           — close panel
 *   DocsPopup.toggle(sectionId) — toggle open/close
 *
 * Triggering:
 *   - Programmatic: DocsPopup.open('chat')
 *   - Link: <a data-docs="chat">View docs</a>
 */
(function () {
  'use strict';

  const CACHE_KEY = 'opai_docs_widget_cache';
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  const PANEL_WIDTH = '600px';
  const Z_INDEX = 99998; // below navbar (99999)

  let panel = null;
  let backdrop = null;
  let navEl = null;
  let contentEl = null;
  let docsData = null;
  let wikiLinkMap = {};
  let isOpen = false;
  let markedReady = false;

  // ── Styles ──────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('docs-widget-styles')) return;
    const style = document.createElement('style');
    style.id = 'docs-widget-styles';
    style.textContent = `
      .docs-widget-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.4);
        z-index: ${Z_INDEX};
        opacity: 0;
        transition: opacity 0.25s ease;
        pointer-events: none;
      }
      .docs-widget-backdrop.open {
        opacity: 1;
        pointer-events: auto;
      }
      .docs-widget-panel {
        position: fixed; top: 0; right: 0; bottom: 0;
        width: ${PANEL_WIDTH};
        max-width: 100vw;
        background: #1a1a2e;
        color: #e0e0e0;
        z-index: ${Z_INDEX + 1};
        display: flex; flex-direction: column;
        transform: translateX(100%);
        transition: transform 0.3s cubic-bezier(0.4,0,0.2,1);
        box-shadow: -4px 0 24px rgba(0,0,0,0.5);
        font-family: 'Inter', -apple-system, sans-serif;
        font-size: 14px;
        line-height: 1.6;
      }
      .docs-widget-panel.open {
        transform: translateX(0);
      }
      .docs-widget-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        background: #16162a;
        flex-shrink: 0;
      }
      .docs-widget-header h3 {
        margin: 0; font-size: 15px; font-weight: 600; color: #fff;
      }
      .docs-widget-close {
        background: none; border: none; color: #888; cursor: pointer;
        padding: 4px; border-radius: 4px; line-height: 1;
        font-size: 20px;
      }
      .docs-widget-close:hover { color: #fff; background: rgba(255,255,255,0.08); }
      .docs-widget-body {
        display: flex; flex: 1; overflow: hidden;
      }
      .docs-widget-nav {
        width: 180px; min-width: 180px;
        border-right: 1px solid rgba(255,255,255,0.06);
        overflow-y: auto; padding: 8px 0;
        background: #14142a;
        flex-shrink: 0;
      }
      .docs-widget-nav-item {
        display: block; padding: 6px 14px;
        color: #999; text-decoration: none;
        font-size: 12px; cursor: pointer;
        border-left: 2px solid transparent;
        transition: all 0.15s;
      }
      .docs-widget-nav-item:hover {
        color: #ddd; background: rgba(255,255,255,0.03);
      }
      .docs-widget-nav-item.active {
        color: #a78bfa; border-left-color: #a78bfa;
        background: rgba(167,139,250,0.06);
      }
      .docs-widget-nav-cat {
        padding: 10px 14px 4px; font-size: 10px;
        text-transform: uppercase; letter-spacing: 0.08em;
        color: #666; font-weight: 600;
      }
      .docs-widget-content {
        flex: 1; overflow-y: auto; padding: 20px 24px;
      }
      .docs-widget-content h1 { font-size: 22px; margin: 0 0 8px; color: #fff; }
      .docs-widget-content h2 { font-size: 17px; margin: 24px 0 8px; color: #ddd; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 6px; }
      .docs-widget-content h3 { font-size: 14px; margin: 16px 0 6px; color: #ccc; }
      .docs-widget-content p { margin: 8px 0; color: #bbb; }
      .docs-widget-content a { color: #a78bfa; text-decoration: none; }
      .docs-widget-content a:hover { text-decoration: underline; }
      .docs-widget-content code {
        background: rgba(255,255,255,0.06); padding: 1px 5px;
        border-radius: 3px; font-size: 13px; font-family: 'JetBrains Mono', monospace;
      }
      .docs-widget-content pre {
        background: #0d0d1a; border: 1px solid rgba(255,255,255,0.06);
        border-radius: 6px; padding: 12px; overflow-x: auto; margin: 12px 0;
      }
      .docs-widget-content pre code {
        background: none; padding: 0; font-size: 12px;
      }
      .docs-widget-content table {
        width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px;
      }
      .docs-widget-content th {
        text-align: left; padding: 6px 10px; border-bottom: 1px solid rgba(255,255,255,0.1);
        color: #aaa; font-weight: 600;
      }
      .docs-widget-content td {
        padding: 5px 10px; border-bottom: 1px solid rgba(255,255,255,0.04); color: #bbb;
      }
      .docs-widget-content ul, .docs-widget-content ol { padding-left: 20px; margin: 8px 0; }
      .docs-widget-content li { margin: 4px 0; color: #bbb; }
      .docs-widget-content blockquote {
        border-left: 3px solid #a78bfa; margin: 12px 0; padding: 8px 16px;
        background: rgba(167,139,250,0.06); color: #aaa;
      }
      .docs-widget-content img { max-width: 100%; border-radius: 6px; }
      .docs-widget-loading {
        display: flex; align-items: center; justify-content: center;
        height: 200px; color: #666;
      }
      .docs-widget-desc {
        color: #888; font-size: 13px; margin: 0 0 16px;
      }
      .docs-widget-badge {
        display: inline-block; font-size: 10px; padding: 1px 6px;
        border-radius: 3px; background: rgba(167,139,250,0.15);
        color: #a78bfa; margin-left: 6px; vertical-align: middle;
      }
      @media (max-width: 700px) {
        .docs-widget-panel { width: 100vw; }
        .docs-widget-nav { width: 140px; min-width: 140px; }
      }
    `;
    document.head.appendChild(style);
  }

  // ── DOM construction ────────────────────────────────────

  function buildPanel() {
    if (panel) return;

    backdrop = document.createElement('div');
    backdrop.className = 'docs-widget-backdrop';
    backdrop.addEventListener('click', close);

    panel = document.createElement('div');
    panel.className = 'docs-widget-panel';
    panel.innerHTML = `
      <div class="docs-widget-header">
        <h3>Documentation</h3>
        <button class="docs-widget-close" title="Close">&times;</button>
      </div>
      <div class="docs-widget-body">
        <div class="docs-widget-nav"></div>
        <div class="docs-widget-content">
          <div class="docs-widget-loading">Loading docs...</div>
        </div>
      </div>
    `;

    panel.querySelector('.docs-widget-close').addEventListener('click', close);
    navEl = panel.querySelector('.docs-widget-nav');
    contentEl = panel.querySelector('.docs-widget-content');

    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
  }

  // ── Data fetching ───────────────────────────────────────

  async function getToken() {
    // Use opaiAuth if available (most tools)
    if (window.opaiAuth && typeof window.opaiAuth.getToken === 'function') {
      return await window.opaiAuth.getToken();
    }
    // Fallback: try Supabase directly
    if (window.supabase) {
      try {
        const client = window.supabase;
        if (client.auth) {
          const { data } = await client.auth.getSession();
          return data?.session?.access_token || null;
        }
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  function getCached() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (Date.now() - cached.ts > CACHE_TTL) {
        sessionStorage.removeItem(CACHE_KEY);
        return null;
      }
      return cached.data;
    } catch { return null; }
  }

  function setCache(data) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
    } catch { /* storage full, ignore */ }
  }

  async function fetchDocsData() {
    const cached = getCached();
    if (cached) return cached;

    const token = await getToken();
    if (!token) return null;

    const resp = await fetch('/docs/api/docs', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!resp.ok) return null;

    const data = await resp.json();
    setCache(data);
    return data;
  }

  // ── Markdown rendering ──────────────────────────────────

  async function ensureMarked() {
    if (markedReady) return;
    if (window.marked) { markedReady = true; return; }

    // Lazy-load marked from CDN
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/marked/marked.min.js';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    markedReady = true;
  }

  function buildWikiLinkMap(sections) {
    wikiLinkMap = {};
    for (const s of sections) {
      if (s.source_file) {
        wikiLinkMap[s.source_file] = s.id;
      }
    }
  }

  function renderMd(md) {
    if (!md || !window.marked) return md || '';
    const renderer = new marked.Renderer();
    renderer.link = function (token) {
      const href = token.href || '';
      const text = token.text || '';
      if (href.endsWith('.md') && wikiLinkMap[href]) {
        return '<a href="#" data-docs-nav="' + wikiLinkMap[href] + '">' + text + '</a>';
      }
      if (href.startsWith('http')) {
        return '<a href="' + href + '" target="_blank" rel="noopener">' + text + '</a>';
      }
      return '<a href="' + href + '">' + text + '</a>';
    };
    return marked.parse(md, { gfm: true, breaks: false, renderer: renderer });
  }

  // ── Rendering ───────────────────────────────────────────

  function renderNav(data) {
    const sectionMap = {};
    for (const s of data.sections) sectionMap[s.id] = s;

    let html = '';
    for (const cat of data.categories) {
      const visible = cat.sections.filter(id => sectionMap[id]);
      if (!visible.length) continue;
      html += '<div class="docs-widget-nav-cat">' + escapeHtml(cat.title) + '</div>';
      for (const sid of visible) {
        const s = sectionMap[sid];
        html += '<div class="docs-widget-nav-item" data-sid="' + sid + '">' + escapeHtml(s.title) + '</div>';
      }
    }
    navEl.innerHTML = html;

    navEl.querySelectorAll('.docs-widget-nav-item').forEach(el => {
      el.addEventListener('click', () => showSection(el.dataset.sid));
    });
  }

  function showSection(sectionId) {
    if (!docsData) return;
    const section = docsData.sections.find(s => s.id === sectionId);
    if (!section) {
      contentEl.innerHTML = '<p style="color:#888">Section not found.</p>';
      return;
    }

    let html = '<h1>' + escapeHtml(section.title) + '</h1>';
    if (section.description) {
      html += '<p class="docs-widget-desc">' + escapeHtml(section.description) + '</p>';
    }
    if (section.content_md) {
      html += renderMd(section.content_md);
    }
    if (section.technical_md) {
      html += '<details style="margin-top:20px"><summary style="cursor:pointer;color:#a78bfa;font-size:13px">Technical Details <span class="docs-widget-badge">Admin</span></summary>';
      html += '<div style="margin-top:12px">' + renderMd(section.technical_md) + '</div></details>';
    }

    contentEl.innerHTML = html;
    contentEl.scrollTop = 0;

    // Handle cross-link clicks within popup
    contentEl.querySelectorAll('[data-docs-nav]').forEach(a => {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        showSection(this.dataset.docsNav);
      });
    });

    // Highlight code if hljs available
    if (window.hljs) {
      contentEl.querySelectorAll('pre code').forEach(block => {
        hljs.highlightElement(block);
      });
    }

    // Highlight active nav
    navEl.querySelectorAll('.docs-widget-nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.sid === sectionId);
    });
  }

  // ── Public API ──────────────────────────────────────────

  async function open(sectionId) {
    injectStyles();
    buildPanel();

    if (!docsData) {
      contentEl.innerHTML = '<div class="docs-widget-loading">Loading docs...</div>';
      // Show panel immediately with loading state
      backdrop.classList.add('open');
      panel.classList.add('open');
      isOpen = true;
      document.body.style.overflow = 'hidden';

      await ensureMarked();
      docsData = await fetchDocsData();
      if (!docsData) {
        contentEl.innerHTML = '<p style="color:#ef4444">Failed to load docs. Are you logged in?</p>';
        return;
      }
      buildWikiLinkMap(docsData.sections);
      renderNav(docsData);
    } else {
      backdrop.classList.add('open');
      panel.classList.add('open');
      isOpen = true;
      document.body.style.overflow = 'hidden';
    }

    const target = sectionId || (docsData.sections.length > 0 ? docsData.sections[0].id : null);
    if (target) showSection(target);
  }

  function close() {
    if (!panel) return;
    panel.classList.remove('open');
    backdrop.classList.remove('open');
    isOpen = false;
    document.body.style.overflow = '';
  }

  function toggle(sectionId) {
    if (isOpen) close();
    else open(sectionId);
  }

  // ── Helpers ─────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ── Event listeners ─────────────────────────────────────

  // Intercept clicks on [data-docs="section-id"] links
  document.addEventListener('click', function (e) {
    const link = e.target.closest('[data-docs]');
    if (link) {
      e.preventDefault();
      open(link.dataset.docs);
    }
  });

  // Keyboard shortcut: Escape to close
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen) {
      close();
    }
  });

  // ── Export ──────────────────────────────────────────────

  window.DocsPopup = { open, close, toggle };

})();
