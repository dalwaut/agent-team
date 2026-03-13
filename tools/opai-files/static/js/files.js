/**
 * OPAI Files — Client-side file manager logic.
 */

const API = '/files/api/files';
let currentPath = '';
let currentSort = { key: 'name', asc: true };
let editorDirty = false;
let editorPath = null;
let editorShowingPreview = false;
let editorRawContent = '';
let token = null;

// Clipboard state
let clipboard = { paths: [], mode: null }; // mode: 'copy' | 'cut'

// AI state
let aiPlanId = null;

// Admin context switching
let fileContext = ''; // '' = server workspace, 'personal' = NAS personal folder

// ── Auth ──────────────────────────────────────────────

async function initAuth() {
    const resp = await fetch('/auth/config');
    const cfg = await resp.json();
    if (!cfg.supabase_url || !cfg.supabase_anon_key) {
        showError('Auth not configured');
        return false;
    }
    window.OPAI_SUPABASE_URL = cfg.supabase_url;
    window.OPAI_SUPABASE_ANON_KEY = cfg.supabase_anon_key;
    window._sbClient = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);
    const sb = window._sbClient;
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
        const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = '/auth/login?return=' + returnUrl;
        return false;
    }
    // Check app access (non-admins only)
    const _role = session.user.app_metadata?.role || 'user';
    if (_role !== 'admin') {
        try {
            const ar = await fetch('/api/me/apps', { headers: { 'Authorization': `Bearer ${session.access_token}` } });
            if (ar.ok) {
                const ad = await ar.json();
                if (!(ad.allowed_apps || []).includes('files')) { window.location.href = '/'; return false; }
            }
        } catch (e) { /* allow on failure */ }
    }

    token = session.access_token;
    sb.auth.onAuthStateChange((_ev, sess) => {
        if (sess) token = sess.access_token;
    });
    const user = session.user;
    const name = user.user_metadata?.display_name || user.email.split('@')[0];
    const role = user.app_metadata?.role || 'user';
    document.getElementById('user-display').textContent = `${name}${role === 'admin' ? ' (admin)' : ''}`;
    return true;
}

function authHeaders() {
    const h = { 'Authorization': `Bearer ${token}` };
    if (fileContext) h['X-Files-Context'] = fileContext;
    return h;
}

async function apiFetch(url, opts = {}) {
    // Refresh token from Supabase client if available
    if (window._sbClient) {
        try {
            const { data: { session } } = await window._sbClient.auth.getSession();
            if (session) token = session.access_token;
        } catch (e) {}
    }
    opts.headers = { ...opts.headers, ...authHeaders() };
    const resp = await fetch(url, opts);
    if (resp.status === 401) {
        const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = '/auth/login?return=' + returnUrl;
        throw new Error('Unauthorized');
    }
    if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.detail || `Error ${resp.status}`);
    }
    return resp;
}

// ── Navigation ────────────────────────────────────────

async function navigateTo(path) {
    currentPath = path || '';
    closeEditor();
    await loadDirectory();
    updateBreadcrumbs();
    history.replaceState(null, '', currentPath ? `?path=${encodeURIComponent(currentPath)}` : '/files/');
}

function updateBreadcrumbs() {
    const bc = document.getElementById('breadcrumbs');
    let html = `<a onclick="navigateTo('')" title="Root">~</a>`;
    if (currentPath) {
        const parts = currentPath.split('/');
        let accum = '';
        for (let i = 0; i < parts.length; i++) {
            accum += (i > 0 ? '/' : '') + parts[i];
            const p = accum;
            if (i < parts.length - 1) {
                html += `<span class="sep">/</span><a onclick="navigateTo('${esc(p)}')">${esc(parts[i])}</a>`;
            } else {
                html += `<span class="sep">/</span><span class="current">${esc(parts[i])}</span>`;
            }
        }
    }
    bc.innerHTML = html;
    document.getElementById('path-info').textContent = `${currentItems.length} items`;
}

// ── Directory listing ─────────────────────────────────

let currentItems = [];

async function loadDirectory() {
    const el = document.getElementById('file-list-body');
    el.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-dim);padding:24px">Loading...</td></tr>';
    try {
        const resp = await apiFetch(`${API}/list?path=${encodeURIComponent(currentPath)}`);
        const data = await resp.json();
        currentItems = data.items;
        renderFileList();
    } catch (err) {
        el.innerHTML = `<tr><td colspan="3" style="color:var(--danger);padding:24px">${esc(err.message)}</td></tr>`;
    }
}

function renderFileList() {
    const el = document.getElementById('file-list-body');
    if (!currentItems.length) {
        el.innerHTML = `<tr><td colspan="3"><div class="empty-state"><div class="icon">📂</div><p>Empty directory</p></div></td></tr>`;
        return;
    }
    const sorted = [...currentItems].sort((a, b) => {
        // Directories always first
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        let va = a[currentSort.key], vb = b[currentSort.key];
        if (currentSort.key === 'name') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
        if (va < vb) return currentSort.asc ? -1 : 1;
        if (va > vb) return currentSort.asc ? 1 : -1;
        return 0;
    });
    el.innerHTML = sorted.map(item => `
        <tr ondblclick="itemDblClick('${esc(item.path)}', ${item.is_dir})"
            oncontextmenu="showContextMenu(event, '${esc(item.path)}', ${item.is_dir}, '${esc(item.name)}')"
            onclick="itemClick('${esc(item.path)}', ${item.is_dir})">
            <td><div class="file-name-cell"><span class="file-icon">${fileIcon(item)}</span><span class="file-name">${esc(item.name)}</span></div></td>
            <td class="col-size">${item.is_dir ? '--' : formatSize(item.size)}</td>
            <td class="col-modified">${formatDate(item.modified)}</td>
        </tr>
    `).join('');
}

function sortBy(key) {
    if (currentSort.key === key) {
        currentSort.asc = !currentSort.asc;
    } else {
        currentSort = { key, asc: true };
    }
    // Update header classes
    document.querySelectorAll('.file-list th').forEach(th => {
        th.classList.remove('sorted', 'desc');
    });
    const th = document.querySelector(`.file-list th[data-sort="${key}"]`);
    if (th) {
        th.classList.add('sorted');
        if (!currentSort.asc) th.classList.add('desc');
    }
    renderFileList();
}

function itemClick(path, isDir) {
    if (!isDir) openFile(path);
}

function itemDblClick(path, isDir) {
    if (isDir) navigateTo(path);
    else openFile(path);
}

// ── File operations ───────────────────────────────────

async function openFile(path) {
    const ext = path.split('.').pop().toLowerCase();
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'];

    if (imageExts.includes(ext)) {
        openImagePreview(path);
        return;
    }

    try {
        const resp = await apiFetch(`${API}/read?path=${encodeURIComponent(path)}`);
        const data = await resp.json();
        showEditor(data);
    } catch (err) {
        if (err.message.includes('too large') || err.message.includes('Binary')) {
            toast(`${err.message}. Starting download...`);
            downloadFile(path);
        } else {
            toast(err.message, 'error');
        }
    }
}

function showEditor(data) {
    const panel = document.getElementById('editor-panel');
    const textarea = document.getElementById('editor-textarea');
    const title = document.getElementById('editor-title');
    const badge = document.getElementById('editor-badge');
    const preview = document.getElementById('preview-area');
    const toggleBtn = document.getElementById('btn-toggle-preview');

    editorPath = data.path;
    editorDirty = false;
    editorRawContent = data.content;
    editorShowingPreview = false;
    title.textContent = data.path.split('/').pop();
    title.title = data.path;

    const ext = data.path.split('.').pop().toLowerCase();
    const hasPreview = ['md', 'json'].includes(ext);

    if (data.protected) {
        badge.textContent = 'Protected';
        badge.className = 'editor-badge protected';
    } else {
        badge.textContent = ext.toUpperCase();
        badge.className = 'editor-badge';
    }

    // Always show the editor textarea
    textarea.style.display = 'block';
    preview.style.display = 'none';
    textarea.value = data.content;
    textarea.readOnly = !!data.protected;

    // Show preview toggle for markdown/json
    if (hasPreview) {
        toggleBtn.style.display = '';
        toggleBtn.textContent = '👁️ Preview';
    } else {
        toggleBtn.style.display = 'none';
    }

    // Show TeamTask button for text-like files
    const ttBtn = document.getElementById('btn-team-task');
    ttBtn.style.display = TT_TEXT_EXTS.has(ext) ? '' : 'none';

    // Show markdown toolbar for .md files
    const mdToolbar = document.getElementById('md-toolbar');
    if (ext === 'md' && !data.protected) {
        mdToolbar.classList.add('visible');
    } else {
        mdToolbar.classList.remove('visible');
    }

    panel.classList.add('open');
    textarea.focus();

    // Fetch backlinks for .md files
    if (ext === 'md') {
        fetchBacklinks(data.path);
    } else {
        document.getElementById('backlinks-panel').style.display = 'none';
    }
}

function closeEditor() {
    if (editorDirty && !confirm('Unsaved changes. Discard?')) return;
    document.getElementById('editor-panel').classList.remove('open');
    document.getElementById('md-toolbar').classList.remove('visible');
    document.getElementById('backlinks-panel').style.display = 'none';
    document.getElementById('wikilink-autocomplete').classList.remove('active');
    document.getElementById('graph-overlay').classList.remove('with-editor');
    editorPath = null;
    editorDirty = false;
    editorShowingPreview = false;
}

function togglePreview() {
    const textarea = document.getElementById('editor-textarea');
    const textareaWrap = document.getElementById('editor-wrap');
    const preview = document.getElementById('preview-area');
    const toggleBtn = document.getElementById('btn-toggle-preview');
    const ext = editorPath ? editorPath.split('.').pop().toLowerCase() : '';

    editorShowingPreview = !editorShowingPreview;

    if (editorShowingPreview) {
        const content = textarea.value;
        if (ext === 'md') {
            preview.innerHTML = `<div class="markdown-body">${renderMarkdown(content)}</div>`;
            // Attach wikilink click handlers
            preview.querySelectorAll('a[data-wikilink]').forEach(a => {
                a.addEventListener('click', (e) => {
                    e.preventDefault();
                    handleWikilinkClick(a.dataset.wikilink);
                });
            });
            // Render any pending mermaid blocks
            if (typeof renderMermaidBlocks === 'function') renderMermaidBlocks();
        } else if (ext === 'json') {
            try {
                const formatted = JSON.stringify(JSON.parse(content), null, 2);
                preview.innerHTML = `<pre><code>${esc(formatted)}</code></pre>`;
            } catch (e) {
                preview.innerHTML = `<pre style="color:var(--danger)">Invalid JSON: ${esc(e.message)}</pre><pre><code>${esc(content)}</code></pre>`;
            }
        }
        textareaWrap.style.display = 'none';
        textarea.style.display = 'none';
        preview.style.display = 'block';
        toggleBtn.textContent = '📝 Edit';
    } else {
        textareaWrap.style.display = 'flex';
        textarea.style.display = 'block';
        preview.style.display = 'none';
        toggleBtn.textContent = '👁️ Preview';
        textarea.focus();
    }
}

async function saveFile() {
    if (!editorPath) return;
    const content = document.getElementById('editor-textarea').value;
    try {
        await apiFetch(`${API}/write`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: editorPath, content }),
        });
        editorDirty = false;
        const badge = document.getElementById('editor-badge');
        badge.textContent = 'Saved';
        badge.className = 'editor-badge saved';
        setTimeout(() => {
            if (!editorDirty) {
                const ext = editorPath.split('.').pop().toUpperCase();
                badge.textContent = ext;
                badge.className = 'editor-badge';
            }
        }, 2000);
        toast('File saved', 'success');
        loadDirectory();
    } catch (err) {
        toast(err.message, 'error');
    }
}

function downloadFile(path) {
    const a = document.createElement('a');
    a.href = `${API}/download?path=${encodeURIComponent(path)}`;
    // Attach token via fetch + blob for auth
    apiFetch(`${API}/download?path=${encodeURIComponent(path)}`)
        .then(r => r.blob())
        .then(blob => {
            const url = URL.createObjectURL(blob);
            a.href = url;
            a.download = path.split('/').pop();
            a.click();
            URL.revokeObjectURL(url);
        })
        .catch(err => toast(err.message, 'error'));
}

function openImagePreview(path) {
    const panel = document.getElementById('editor-panel');
    const textarea = document.getElementById('editor-textarea');
    const preview = document.getElementById('preview-area');
    const title = document.getElementById('editor-title');
    const badge = document.getElementById('editor-badge');

    editorPath = null;
    editorDirty = false;
    title.textContent = path.split('/').pop();
    badge.textContent = 'Preview';
    badge.className = 'editor-badge';

    textarea.style.display = 'none';
    preview.style.display = 'block';

    // Use blob fetch for auth
    apiFetch(`${API}/download?path=${encodeURIComponent(path)}`)
        .then(r => r.blob())
        .then(blob => {
            const url = URL.createObjectURL(blob);
            preview.innerHTML = `<img src="${url}" alt="${esc(path.split('/').pop())}">`;
        })
        .catch(err => {
            preview.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`;
        });

    panel.classList.add('open');
}

// ── New Folder ────────────────────────────────────────

function showNewFolderModal() {
    showModal('New Folder', 'Folder name:', '', async (name) => {
        if (!name) return;
        const path = currentPath ? `${currentPath}/${name}` : name;
        try {
            await apiFetch(`${API}/mkdir`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path }),
            });
            toast('Folder created', 'success');
            loadDirectory();
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}

// ── New File ──────────────────────────────────────────

function showNewFileModal() {
    showModal('New File', 'File name:', '', async (name) => {
        if (!name) return;
        const path = currentPath ? `${currentPath}/${name}` : name;
        try {
            await apiFetch(`${API}/write`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path, content: '' }),
            });
            toast('File created', 'success');
            loadDirectory();
            openFile(path);
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}

// ── Rename ────────────────────────────────────────────

function showRenameModal(oldPath, oldName) {
    showModal('Rename', 'New name:', oldName, async (newName) => {
        if (!newName || newName === oldName) return;
        const dir = oldPath.includes('/') ? oldPath.substring(0, oldPath.lastIndexOf('/') + 1) : '';
        const newPath = dir + newName;
        try {
            await apiFetch(`${API}/rename`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: oldPath, new_path: newPath }),
            });
            toast('Renamed', 'success');
            loadDirectory();
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}

// ── Delete ────────────────────────────────────────────

async function deleteItem(path, name) {
    if (!confirm(`Delete "${name}"?`)) return;
    try {
        await apiFetch(`${API}/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
        });
        toast('Deleted', 'success');
        if (editorPath === path) {
            editorDirty = false;
            closeEditor();
        }
        loadDirectory();
    } catch (err) {
        toast(err.message, 'error');
    }
}

function deleteEditorFile() {
    if (!editorPath) return;
    const name = editorPath.split('/').pop();
    editorDirty = false; // prevent unsaved-changes prompt during close
    deleteItem(editorPath, name);
}

// ── Upload ────────────────────────────────────────────

function triggerUpload() {
    const input = document.getElementById('upload-input');
    input.click();
}

async function handleUpload(files) {
    if (!files || !files.length) return;
    const form = new FormData();
    for (const f of files) form.append('files', f);
    try {
        const resp = await apiFetch(`${API}/upload?path=${encodeURIComponent(currentPath)}`, {
            method: 'POST',
            body: form,
        });
        const data = await resp.json();
        const ok = data.files.filter(f => f.ok).length;
        const fail = data.files.filter(f => !f.ok).length;
        toast(`Uploaded ${ok} file(s)${fail ? `, ${fail} failed` : ''}`, fail ? 'error' : 'success');
        loadDirectory();
    } catch (err) {
        toast(err.message, 'error');
    }
    hideUploadOverlay();
}

function showUploadOverlay() { document.getElementById('upload-overlay').classList.add('active'); }
function hideUploadOverlay() { document.getElementById('upload-overlay').classList.remove('active'); }

// ── Search ────────────────────────────────────────────

let searchTimeout = null;

function onSearchInput(val) {
    clearTimeout(searchTimeout);
    const results = document.getElementById('search-results');
    if (!val.trim()) {
        results.classList.remove('active');
        return;
    }
    searchTimeout = setTimeout(async () => {
        try {
            let html = '';
            if (searchMode === 'content') {
                const resp = await apiFetch(`${API}/search-content?q=${encodeURIComponent(val)}&path=${encodeURIComponent(currentPath)}`);
                const data = await resp.json();
                if (!data.results.length) {
                    html = '<div class="search-result-item" style="color:var(--text-dim)">No results</div>';
                } else {
                    html = data.results.map(r => `
                        <div class="search-result-item" onclick="searchResultClick('${esc(r.path)}', false)">
                            <span class="file-icon">${fileIcon({ name: r.name, is_dir: false })}</span>
                            <div style="flex:1;min-width:0">
                                <div>${esc(r.name)} <span class="sr-path">${esc(r.path)}</span></div>
                                ${r.matches ? r.matches.map(m => `<div style="font-size:0.75rem;color:var(--text-dim);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">L${m.line}: ${esc(m.text)}</div>`).join('') : ''}
                            </div>
                        </div>
                    `).join('');
                }
            } else {
                const resp = await apiFetch(`${API}/search?q=${encodeURIComponent(val)}&path=${encodeURIComponent(currentPath)}`);
                const data = await resp.json();
                if (!data.results.length) {
                    html = '<div class="search-result-item" style="color:var(--text-dim)">No results</div>';
                } else {
                    html = data.results.map(r => `
                        <div class="search-result-item" onclick="searchResultClick('${esc(r.path)}', ${r.is_dir})">
                            <span class="file-icon">${fileIcon(r)}</span>
                            <span>${esc(r.name)}</span>
                            <span class="sr-path">${esc(r.path)}</span>
                        </div>
                    `).join('');
                }
            }
            results.innerHTML = html;
            results.classList.add('active');
        } catch (err) {
            results.classList.remove('active');
        }
    }, 300);
}

function searchResultClick(path, isDir) {
    document.getElementById('search-results').classList.remove('active');
    document.getElementById('search-input').value = '';
    if (isDir) {
        navigateTo(path);
    } else {
        // Navigate to parent dir, then open file
        const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
        navigateTo(dir).then(() => openFile(path));
    }
}

// ── Cut / Copy / Paste ────────────────────────────────

function cutItem(path, name) {
    clipboard = { paths: [path], mode: 'cut' };
    updateClipboardUI();
    toast(`Cut: ${name}`, 'success');
}

function copyItem(path, name) {
    clipboard = { paths: [path], mode: 'copy' };
    updateClipboardUI();
    toast(`Copied: ${name}`, 'success');
}

async function pasteItems() {
    if (!clipboard.paths.length || !clipboard.mode) return;

    const results = [];
    for (const srcPath of clipboard.paths) {
        const name = srcPath.split('/').pop();
        const destPath = currentPath ? `${currentPath}/${name}` : name;

        try {
            if (clipboard.mode === 'copy') {
                await apiFetch(`${API}/copy`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ source: srcPath, dest: destPath }),
                });
                results.push({ name, ok: true });
            } else {
                // cut = move (rename)
                await apiFetch(`${API}/rename`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: srcPath, new_path: destPath }),
                });
                results.push({ name, ok: true });
            }
        } catch (err) {
            results.push({ name, ok: false, error: err.message });
        }
    }

    const ok = results.filter(r => r.ok).length;
    const fail = results.filter(r => !r.ok);

    if (fail.length) {
        toast(`Pasted ${ok}, failed ${fail.length}: ${fail[0].error}`, 'error');
    } else {
        toast(`Pasted ${ok} item(s)`, 'success');
    }

    // Clear clipboard after cut (not after copy)
    if (clipboard.mode === 'cut') {
        clipboard = { paths: [], mode: null };
    }
    updateClipboardUI();
    loadDirectory();
}

function clearClipboard() {
    clipboard = { paths: [], mode: null };
    updateClipboardUI();
}

function updateClipboardUI() {
    const pasteBtn = document.getElementById('btn-paste');
    const clipInfo = document.getElementById('clipboard-info');
    if (clipboard.paths.length && clipboard.mode) {
        pasteBtn.style.display = '';
        const name = clipboard.paths[0].split('/').pop();
        const label = clipboard.mode === 'cut' ? 'Cut' : 'Copied';
        clipInfo.textContent = `${label}: ${name}`;
        clipInfo.style.display = '';
    } else {
        pasteBtn.style.display = 'none';
        clipInfo.style.display = 'none';
    }
}

// ── Wikilink Navigation ───────────────────────────────

async function handleWikilinkClick(target) {
    try {
        const resp = await apiFetch(`/files/api/links/resolve?name=${encodeURIComponent(target)}`);
        const data = await resp.json();
        if (data.exists && data.path) {
            const dir = data.path.includes('/') ? data.path.substring(0, data.path.lastIndexOf('/')) : '';
            await navigateTo(dir);
            await openFile(data.path);
        } else {
            // Offer to create the file
            if (confirm(`"${target}" doesn't exist yet. Create it?`)) {
                const newPath = currentPath ? `${currentPath}/${target}.md` : `${target}.md`;
                await apiFetch(`${API}/write`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: newPath, content: `# ${target}\n\n` }),
                });
                toast('File created', 'success');
                loadDirectory();
                openFile(newPath);
            }
        }
    } catch (err) {
        toast(`Link error: ${err.message}`, 'error');
    }
}

// ── Backlinks ─────────────────────────────────────────

let backlinksCollapsed = false;

async function fetchBacklinks(path) {
    const panel = document.getElementById('backlinks-panel');
    const list = document.getElementById('backlinks-list');
    const badge = document.getElementById('backlinks-count');

    panel.style.display = '';
    list.innerHTML = '<div style="padding:8px 8px;color:var(--text-muted);font-size:0.75rem">Loading...</div>';
    badge.textContent = '...';

    try {
        const resp = await apiFetch(`/files/api/links/backlinks?path=${encodeURIComponent(path)}`);
        const data = await resp.json();
        const bl = data.backlinks || [];
        badge.textContent = bl.length;

        if (!bl.length) {
            list.innerHTML = '<div style="padding:8px 8px;color:var(--text-muted);font-size:0.75rem">No backlinks</div>';
            return;
        }

        list.innerHTML = bl.map(b => `
            <div class="backlink-item" onclick="backlinkClick('${esc(b.path)}')">
                <span class="backlink-name">${esc(b.name)}</span>
                <span class="backlink-path">${esc(b.path)}</span>
                ${b.context ? `<span class="backlink-context">${esc(b.context)}</span>` : ''}
            </div>
        `).join('');
    } catch (err) {
        list.innerHTML = `<div style="padding:8px 8px;color:var(--danger);font-size:0.75rem">${esc(err.message)}</div>`;
        badge.textContent = '!';
    }
}

function backlinkClick(path) {
    const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
    navigateTo(dir).then(() => openFile(path));
}

function toggleBacklinks() {
    const panel = document.getElementById('backlinks-panel');
    const toggle = document.getElementById('backlinks-toggle');
    backlinksCollapsed = !backlinksCollapsed;
    if (backlinksCollapsed) {
        panel.classList.add('collapsed');
        toggle.innerHTML = '&#x25B6;';
    } else {
        panel.classList.remove('collapsed');
        toggle.innerHTML = '&#x25BC;';
    }
}

// ── Quick Switcher ────────────────────────────────────

let qsFiles = null;
let qsSelectedIdx = 0;

async function openQuickSwitcher() {
    const overlay = document.getElementById('quick-switcher-overlay');
    const input = document.getElementById('qs-input');
    const results = document.getElementById('qs-results');

    overlay.classList.add('active');
    input.value = '';
    results.innerHTML = '';
    qsSelectedIdx = 0;
    setTimeout(() => input.focus(), 50);

    // Load file names if not cached
    if (!qsFiles) {
        try {
            const resp = await apiFetch('/files/api/files/names');
            const data = await resp.json();
            qsFiles = data.files || [];
        } catch (err) {
            results.innerHTML = `<div class="qs-item" style="color:var(--text-dim)">Failed to load files</div>`;
        }
    }
}

function closeQuickSwitcher() {
    document.getElementById('quick-switcher-overlay').classList.remove('active');
}

function filterQuickSwitcher(query) {
    const results = document.getElementById('qs-results');
    if (!qsFiles || !query.trim()) {
        results.innerHTML = '';
        return;
    }

    const q = query.toLowerCase();
    const filtered = qsFiles.filter(f =>
        f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
    ).slice(0, 20);

    qsSelectedIdx = 0;
    results.innerHTML = filtered.map((f, i) => `
        <div class="qs-item${i === 0 ? ' selected' : ''}" data-idx="${i}" onclick="qsSelect('${esc(f.path)}')">
            <span class="file-icon">${fileIcon({ name: f.name, is_dir: false })}</span>
            <span class="qs-name">${esc(f.name)}</span>
            <span class="qs-path">${esc(f.path)}</span>
        </div>
    `).join('');
}

function qsSelect(path) {
    closeQuickSwitcher();
    const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
    navigateTo(dir).then(() => openFile(path));
}

function qsNavigate(delta) {
    const items = document.querySelectorAll('#qs-results .qs-item');
    if (!items.length) return;
    items[qsSelectedIdx]?.classList.remove('selected');
    qsSelectedIdx = Math.max(0, Math.min(items.length - 1, qsSelectedIdx + delta));
    items[qsSelectedIdx]?.classList.add('selected');
    items[qsSelectedIdx]?.scrollIntoView({ block: 'nearest' });
}

function qsConfirm() {
    const items = document.querySelectorAll('#qs-results .qs-item');
    if (items[qsSelectedIdx]) {
        const path = qsFiles?.find((f, i) => {
            const filtered = qsFiles.filter(f2 => {
                const q = document.getElementById('qs-input').value.toLowerCase();
                return f2.name.toLowerCase().includes(q) || f2.path.toLowerCase().includes(q);
            });
            return filtered[qsSelectedIdx] === f;
        });
        // Simpler: get from the rendered element text
        const el = items[qsSelectedIdx];
        const pathSpan = el.querySelector('.qs-path');
        if (pathSpan) qsSelect(pathSpan.textContent);
    }
}

// ── Markdown Toolbar ──────────────────────────────────

function mdInsert(before, after) {
    const ta = document.getElementById('editor-textarea');
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end);
    const replacement = before + (selected || 'text') + after;
    ta.value = ta.value.substring(0, start) + replacement + ta.value.substring(end);
    ta.selectionStart = start + before.length;
    ta.selectionEnd = start + before.length + (selected || 'text').length;
    ta.focus();
    if (!editorDirty) {
        editorDirty = true;
        const badge = document.getElementById('editor-badge');
        badge.textContent = 'Modified';
        badge.className = 'editor-badge modified';
    }
}

function mdInsertLine(prefix) {
    const ta = document.getElementById('editor-textarea');
    const start = ta.selectionStart;
    // Find the beginning of the current line
    const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
    ta.value = ta.value.substring(0, lineStart) + prefix + ta.value.substring(lineStart);
    ta.selectionStart = ta.selectionEnd = lineStart + prefix.length;
    ta.focus();
    if (!editorDirty) {
        editorDirty = true;
        const badge = document.getElementById('editor-badge');
        badge.textContent = 'Modified';
        badge.className = 'editor-badge modified';
    }
}

function mdInsertBlock(before, after) {
    const ta = document.getElementById('editor-textarea');
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end) || 'code';
    const replacement = '\n' + before + selected + after + '\n';
    ta.value = ta.value.substring(0, start) + replacement + ta.value.substring(end);
    ta.selectionStart = start + before.length + 1;
    ta.selectionEnd = start + before.length + 1 + selected.length;
    ta.focus();
    if (!editorDirty) {
        editorDirty = true;
        const badge = document.getElementById('editor-badge');
        badge.textContent = 'Modified';
        badge.className = 'editor-badge modified';
    }
}

// ── Wikilink Autocomplete ─────────────────────────────

let wlAutoFiles = null;
let wlSelectedIdx = -1;

function checkWikilinkAutocomplete(ta) {
    const pos = ta.selectionStart;
    const textBefore = ta.value.substring(0, pos);
    const match = textBefore.match(/\[\[([^\]]*?)$/);

    const dropdown = document.getElementById('wikilink-autocomplete');

    if (!match) {
        dropdown.classList.remove('active');
        return;
    }

    const query = match[1].toLowerCase();
    if (!wlAutoFiles) {
        // Fetch file names lazily
        apiFetch('/files/api/files/names')
            .then(r => r.json())
            .then(data => {
                wlAutoFiles = data.files || [];
                showWlDropdown(query, ta);
            })
            .catch(() => {});
        return;
    }

    showWlDropdown(query, ta);
}

function showWlDropdown(query, ta) {
    const dropdown = document.getElementById('wikilink-autocomplete');
    const filtered = wlAutoFiles.filter(f =>
        f.stem.toLowerCase().includes(query) || f.name.toLowerCase().includes(query)
    ).slice(0, 10);

    if (!filtered.length) {
        dropdown.classList.remove('active');
        return;
    }

    wlSelectedIdx = 0;
    dropdown.innerHTML = filtered.map((f, i) => `
        <div class="wl-item${i === 0 ? ' selected' : ''}" data-stem="${esc(f.stem)}" onclick="wlComplete('${esc(f.stem)}')">
            ${esc(f.name)} <span style="color:var(--text-muted);font-size:0.75rem;margin-left:8px">${esc(f.path)}</span>
        </div>
    `).join('');

    // Position near the cursor
    const rect = ta.getBoundingClientRect();
    dropdown.style.top = '50%';
    dropdown.style.left = '16px';
    dropdown.classList.add('active');
}

function wlComplete(stem) {
    const ta = document.getElementById('editor-textarea');
    const pos = ta.selectionStart;
    const textBefore = ta.value.substring(0, pos);
    const match = textBefore.match(/\[\[([^\]]*?)$/);
    if (!match) return;

    const replaceStart = pos - match[1].length;
    ta.value = ta.value.substring(0, replaceStart) + stem + ']]' + ta.value.substring(pos);
    ta.selectionStart = ta.selectionEnd = replaceStart + stem.length + 2;
    ta.focus();

    document.getElementById('wikilink-autocomplete').classList.remove('active');

    if (!editorDirty) {
        editorDirty = true;
        const badge = document.getElementById('editor-badge');
        badge.textContent = 'Modified';
        badge.className = 'editor-badge modified';
    }
}

function wlNavigate(delta) {
    const items = document.querySelectorAll('#wikilink-autocomplete .wl-item');
    if (!items.length) return;
    items[wlSelectedIdx]?.classList.remove('selected');
    wlSelectedIdx = Math.max(0, Math.min(items.length - 1, wlSelectedIdx + delta));
    items[wlSelectedIdx]?.classList.add('selected');
    items[wlSelectedIdx]?.scrollIntoView({ block: 'nearest' });
}

function wlConfirmSelected() {
    const items = document.querySelectorAll('#wikilink-autocomplete .wl-item');
    if (items[wlSelectedIdx]) {
        wlComplete(items[wlSelectedIdx].dataset.stem);
    }
}

// ── Content Search Toggle ─────────────────────────────

let searchMode = 'filename'; // 'filename' or 'content'

function toggleSearchMode() {
    searchMode = searchMode === 'filename' ? 'content' : 'filename';
    const input = document.getElementById('search-input');
    input.placeholder = searchMode === 'filename' ? 'Search files...' : 'Search content...';
    input.value = '';
    document.getElementById('search-results').classList.remove('active');
}

// ── Instruct AI ───────────────────────────────────────

function showAIModal(path, name) {
    const overlay = document.getElementById('ai-overlay');
    const pathEl = document.getElementById('ai-target-path');
    const input = document.getElementById('ai-instruction');
    const planArea = document.getElementById('ai-plan-area');
    const planText = document.getElementById('ai-plan-text');
    const approveBtn = document.getElementById('ai-approve-btn');
    const submitBtn = document.getElementById('ai-submit-btn');
    const spinner = document.getElementById('ai-spinner');

    pathEl.textContent = path || '(current directory)';
    input.value = '';
    planArea.style.display = 'none';
    planText.textContent = '';
    approveBtn.style.display = 'none';
    submitBtn.style.display = '';
    submitBtn.disabled = false;
    spinner.style.display = 'none';
    aiPlanId = null;

    overlay.dataset.targetPath = path || currentPath;
    overlay.classList.add('active');
    setTimeout(() => input.focus(), 50);
}

function closeAIModal() {
    document.getElementById('ai-overlay').classList.remove('active');
    aiPlanId = null;
}

async function aiSubmitInstruction() {
    const overlay = document.getElementById('ai-overlay');
    const input = document.getElementById('ai-instruction');
    const planArea = document.getElementById('ai-plan-area');
    const planText = document.getElementById('ai-plan-text');
    const approveBtn = document.getElementById('ai-approve-btn');
    const submitBtn = document.getElementById('ai-submit-btn');
    const spinner = document.getElementById('ai-spinner');

    const instruction = input.value.trim();
    if (!instruction) { toast('Enter an instruction', 'error'); return; }

    const targetPath = overlay.dataset.targetPath || '';

    submitBtn.disabled = true;
    spinner.style.display = 'inline';
    planArea.style.display = 'block';
    planText.textContent = 'Thinking...';

    try {
        const resp = await apiFetch(`${API}/ai/plan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: targetPath, instruction }),
        });
        const data = await resp.json();
        aiPlanId = data.plan_id;
        planText.textContent = data.plan;
        approveBtn.style.display = '';
        submitBtn.style.display = 'none';
    } catch (err) {
        planText.textContent = `Error: ${err.message}`;
    } finally {
        spinner.style.display = 'none';
        submitBtn.disabled = false;
    }
}

async function aiApproveExecution() {
    if (!aiPlanId) return;

    const planText = document.getElementById('ai-plan-text');
    const approveBtn = document.getElementById('ai-approve-btn');
    const spinner = document.getElementById('ai-spinner');

    approveBtn.disabled = true;
    spinner.style.display = 'inline';
    planText.textContent += '\n\n--- Executing... ---';

    try {
        const resp = await apiFetch(`${API}/ai/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ plan_id: aiPlanId }),
        });
        const data = await resp.json();
        planText.textContent += `\n\n--- Result ---\n${data.result}`;
        toast('AI task completed', 'success');
        loadDirectory();
    } catch (err) {
        planText.textContent += `\n\nExecution error: ${err.message}`;
        toast(err.message, 'error');
    } finally {
        spinner.style.display = 'none';
        approveBtn.style.display = 'none';
        aiPlanId = null;
    }
}

// ── TeamTask ──────────────────────────────────────────

const TT_TEXT_EXTS = new Set([
    'md', 'txt', 'rtf', 'json', 'yaml', 'yml', 'toml', 'csv', 'log',
    'html', 'css', 'js', 'ts', 'py', 'sh', 'sql', 'xml', 'ini', 'cfg',
    'conf', 'env', 'dockerfile', 'makefile'
]);

function showTeamTaskModal() {
    if (!editorPath) return;
    const overlay = document.getElementById('tt-overlay');
    const pathEl = document.getElementById('tt-file-path');
    const titleInput = document.getElementById('tt-title');
    const submitBtn = document.getElementById('tt-submit-btn');

    // Pre-fill
    const filename = editorPath.split('/').pop();
    const stem = filename.includes('.') ? filename.substring(0, filename.lastIndexOf('.')) : filename;
    titleInput.value = stem;
    pathEl.textContent = editorPath;
    submitBtn.disabled = false;

    overlay.classList.add('active');
    setTimeout(() => titleInput.focus(), 50);

    // Load spaces
    ttLoadSpaces();
}

function closeTeamTaskModal() {
    document.getElementById('tt-overlay').classList.remove('active');
}

async function ttLoadSpaces() {
    const sel = document.getElementById('tt-space');
    sel.innerHTML = '<option value="">Loading...</option>';
    try {
        const resp = await apiFetch('/team-hub/api/workspaces');
        const data = await resp.json();
        const spaces = data.workspaces || data;
        if (!spaces.length) {
            sel.innerHTML = '<option value="">No spaces found</option>';
            return;
        }
        sel.innerHTML = spaces.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
        ttSpaceChanged();
    } catch (err) {
        sel.innerHTML = '<option value="">Error loading spaces</option>';
        toast('Failed to load spaces: ' + err.message, 'error');
    }
}

async function ttSpaceChanged() {
    const spaceId = document.getElementById('tt-space').value;
    const listSel = document.getElementById('tt-list');
    if (!spaceId) {
        listSel.innerHTML = '<option value="">Select a space first</option>';
        return;
    }
    listSel.innerHTML = '<option value="">Loading...</option>';
    try {
        const resp = await apiFetch('/team-hub/api/workspaces/' + encodeURIComponent(spaceId) + '/folders');
        const data = await resp.json();
        const folders = data.folders || [];
        const folderlessLists = data.lists || [];

        let options = '';
        // Folder lists
        for (const folder of folders) {
            if (folder.id === '__uncategorized__') continue;
            const lists = folder.lists || [];
            for (const list of lists) {
                options += `<option value="${esc(list.id)}">${esc(folder.name)} / ${esc(list.name)}</option>`;
            }
        }
        // Folderless lists
        for (const list of folderlessLists) {
            options += `<option value="${esc(list.id)}">${esc(list.name)}</option>`;
        }

        if (!options) {
            listSel.innerHTML = '<option value="">No lists found</option>';
        } else {
            listSel.innerHTML = options;
        }
    } catch (err) {
        listSel.innerHTML = '<option value="">Error loading lists</option>';
        toast('Failed to load lists: ' + err.message, 'error');
    }
}

function buildTaskDescription(filePath, content) {
    const downloadUrl = window.location.origin + '/files/?path=' + encodeURIComponent(filePath);
    const ext = filePath.includes('.') ? filePath.split('.').pop().toLowerCase() : '';

    let header = '**Source file:** `' + filePath + '`\n'
        + '**Open in Files:** ' + downloadUrl + '\n\n---\n\n';

    // Markdown files: extract headings + bullet/numbered items as action items
    if (ext === 'md' || ext === 'markdown') {
        const lines = content.split('\n');
        const headings = [];
        const actionItems = [];

        for (const line of lines) {
            const trimmed = line.trim();
            // Extract headings for summary
            if (/^#{1,3}\s+/.test(trimmed)) {
                headings.push(trimmed.replace(/^#+\s+/, ''));
            }
            // Extract bullet/numbered items as action items
            if (/^[-*]\s+\[[ x]\]/i.test(trimmed)) {
                // Already a checkbox item — keep as-is
                actionItems.push(trimmed.replace(/^[-*]\s+/, '- '));
            } else if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
                const itemText = trimmed.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '');
                if (itemText.length > 5) actionItems.push('- [ ] ' + itemText);
            }
        }

        // Build summary from first heading or first meaningful paragraph
        let summary = '';
        if (headings.length) {
            summary = '## Summary\n' + headings.slice(0, 5).map(h => '- ' + h).join('\n');
        } else {
            const firstPara = lines.find(l => l.trim().length > 20 && !/^[#\-*|>]/.test(l.trim()));
            if (firstPara) summary = '## Summary\n' + firstPara.trim().substring(0, 300);
        }

        let body = summary;
        if (actionItems.length) {
            body += '\n\n## Action Items\n' + actionItems.slice(0, 20).join('\n');
        }
        if (!body.trim()) {
            body = '> ' + content.substring(0, 300).replace(/\n/g, '\n> ');
        }
        return header + body;
    }

    // Code files: filename + first comment block as summary
    const codeExts = ['js','ts','py','jsx','tsx','css','html','sh','rb','go','rs','java','c','cpp','cs'];
    if (codeExts.includes(ext)) {
        const lines = content.split('\n');
        const commentLines = [];
        for (const line of lines.slice(0, 30)) {
            const trimmed = line.trim();
            if (/^(\/\/|#|\/\*|\*|--)\s*/.test(trimmed) && trimmed.length > 3) {
                commentLines.push(trimmed.replace(/^(\/\/|#|\/\*|\*|--)\s*/, '').replace(/\*\/\s*$/, ''));
            } else if (commentLines.length > 0) break;
        }
        let summary = commentLines.length
            ? '## Summary\n' + commentLines.join('\n')
            : '## Summary\n`' + filePath.split('/').pop() + '` — ' + lines.length + ' lines';
        return header + summary;
    }

    // Other text: first ~300 chars as blockquote
    const snippet = content.substring(0, 300).replace(/\n/g, '\n> ');
    return header + '> ' + snippet + (content.length > 300 ? '...' : '');
}

async function submitTeamTask() {
    const title = document.getElementById('tt-title').value.trim();
    const listId = document.getElementById('tt-list').value;
    const spaceId = document.getElementById('tt-space').value;
    const priority = document.getElementById('tt-priority').value;
    const submitBtn = document.getElementById('tt-submit-btn');

    if (!title) { toast('Enter a task title', 'error'); return; }
    if (!listId) { toast('Select a list', 'error'); return; }

    const fileContent = document.getElementById('editor-textarea').value;
    const description = buildTaskDescription(editorPath, fileContent);

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating...';

    try {
        // 1. Create the task
        const resp = await apiFetch('/team-hub/api/lists/' + encodeURIComponent(listId) + '/items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title,
                type: 'task',
                description,
                status: 'open',
                priority
            })
        });
        const taskData = await resp.json();
        const itemId = taskData.id || (taskData[0] && taskData[0].id);

        // 2. Upload file to Supabase Storage if we have a client and space
        if (window._sbClient && spaceId && editorPath) {
            try {
                const fileName = editorPath.split('/').pop();
                const storagePath = spaceId + '/' + Date.now() + '_' + fileName;
                const blob = new Blob([fileContent], { type: 'text/plain' });

                const { error: uploadError } = await window._sbClient.storage
                    .from('team-files')
                    .upload(storagePath, blob);

                if (!uploadError) {
                    // 3. Register file in team_files table
                    await apiFetch('/team-hub/api/workspaces/' + encodeURIComponent(spaceId) + '/files', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            file_name: fileName,
                            file_path: storagePath,
                            file_size: blob.size,
                            mime_type: 'text/plain',
                            item_id: itemId || null
                        })
                    });
                }
            } catch (fileErr) {
                // Task was created successfully, file attachment is best-effort
                console.warn('File attachment failed:', fileErr);
            }
        }

        toast('Task created in Team Hub', 'success');
        closeTeamTaskModal();
    } catch (err) {
        toast('Failed to create task: ' + err.message, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Task';
    }
}

// ── Context Menu ──────────────────────────────────────

function showContextMenu(e, path, isDir, name) {
    e.preventDefault();
    e.stopPropagation();
    const menu = document.getElementById('context-menu');

    let html = '';
    if (isDir) {
        html += `<div class="ctx-item" onclick="navigateTo('${esc(path)}')">📂 Open</div>`;
    } else {
        html += `<div class="ctx-item" onclick="openFile('${esc(path)}')">📄 Open</div>`;
        html += `<div class="ctx-item" onclick="downloadFile('${esc(path)}')">⬇️ Download</div>`;
    }
    html += `<div class="ctx-divider"></div>`;
    html += `<div class="ctx-item" onclick="cutItem('${esc(path)}', '${esc(name)}')">✂️ Cut</div>`;
    html += `<div class="ctx-item" onclick="copyItem('${esc(path)}', '${esc(name)}')">📋 Copy</div>`;
    if (clipboard.paths.length) {
        html += `<div class="ctx-item" onclick="pasteItems()">📌 Paste here</div>`;
    }
    html += `<div class="ctx-divider"></div>`;
    html += `<div class="ctx-item" onclick="showRenameModal('${esc(path)}', '${esc(name)}')">✏️ Rename</div>`;
    html += `<div class="ctx-item danger" onclick="deleteItem('${esc(path)}', '${esc(name)}')">🗑️ Delete</div>`;
    html += `<div class="ctx-divider"></div>`;
    html += `<div class="ctx-item" onclick="showAIModal('${esc(path)}', '${esc(name)}')">🤖 Instruct AI</div>`;

    menu.innerHTML = html;
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.classList.add('active');
}

// ── Modal ─────────────────────────────────────────────

function showModal(title, label, defaultVal, onConfirm) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-label').textContent = label;
    const input = document.getElementById('modal-input');
    input.value = defaultVal;
    overlay.classList.add('active');
    setTimeout(() => { input.focus(); input.select(); }, 50);

    window._modalConfirm = () => {
        overlay.classList.remove('active');
        onConfirm(input.value.trim());
    };
}

function modalCancel() {
    document.getElementById('modal-overlay').classList.remove('active');
}

function modalConfirm() {
    if (window._modalConfirm) window._modalConfirm();
}

// ── Toast ─────────────────────────────────────────────

function toast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

function showError(msg) {
    document.getElementById('loading-screen').innerHTML = `<p style="color:var(--danger)">${esc(msg)}</p>`;
}

// ── Utilities ─────────────────────────────────────────

function esc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fileIcon(item) {
    if (item.is_dir) return '📁';
    const ext = item.name.split('.').pop().toLowerCase();
    const icons = {
        js: '📜', ts: '📜', py: '🐍', md: '📝', json: '🔧', html: '🌐', css: '🎨',
        txt: '📄', sh: '⚙️', yml: '⚙️', yaml: '⚙️', toml: '⚙️',
        png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
        pdf: '📕', zip: '📦', gz: '📦', tar: '📦',
        env: '🔒', log: '📋', sql: '🗄️',
    };
    return icons[ext] || '📄';
}

function formatSize(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0) + ' ' + sizes[i];
}

function formatDate(ts) {
    if (!ts) return '--';
    const d = new Date(ts * 1000);
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

// renderMarkdown() is now provided by markdown.js (loaded before this file).
// It uses markdown-it with highlight.js, KaTeX, wikilinks, callouts, and mermaid.
// Falls back to a built-in regex renderer if CDN fails to load.

// ── Event handlers ────────────────────────────────────

function initEvents() {
    // Editor keyboard shortcuts
    const editorTA = document.getElementById('editor-textarea');
    editorTA.addEventListener('keydown', (e) => {
        const wlDropdown = document.getElementById('wikilink-autocomplete');
        const wlActive = wlDropdown.classList.contains('active');

        // Wikilink autocomplete navigation
        if (wlActive) {
            if (e.key === 'ArrowDown') { e.preventDefault(); wlNavigate(1); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); wlNavigate(-1); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); wlConfirmSelected(); return; }
            if (e.key === 'Escape') { e.preventDefault(); wlDropdown.classList.remove('active'); return; }
        }

        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            saveFile();
        }
        // Ctrl+B for bold
        if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
            e.preventDefault();
            mdInsert('**', '**');
        }
        // Ctrl+I for italic
        if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
            e.preventDefault();
            mdInsert('*', '*');
        }
        // Tab support
        if (e.key === 'Tab') {
            e.preventDefault();
            const ta = e.target;
            const start = ta.selectionStart;
            ta.value = ta.value.substring(0, start) + '    ' + ta.value.substring(ta.selectionEnd);
            ta.selectionStart = ta.selectionEnd = start + 4;
        }
    });

    // Wikilink autocomplete on input
    editorTA.addEventListener('input', () => {
        checkWikilinkAutocomplete(editorTA);
    });

    editorTA.addEventListener('input', () => {
        if (!editorDirty) {
            editorDirty = true;
            const badge = document.getElementById('editor-badge');
            badge.textContent = 'Modified';
            badge.className = 'editor-badge modified';
        }
    });

    // Close context menu on click outside
    document.addEventListener('click', () => {
        document.getElementById('context-menu').classList.remove('active');
    });

    // Close search results on click outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-box')) {
            document.getElementById('search-results').classList.remove('active');
        }
    });

    // Modal enter key
    document.getElementById('modal-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') modalConfirm();
        if (e.key === 'Escape') modalCancel();
    });

    // Drag & drop upload
    document.addEventListener('dragenter', (e) => {
        e.preventDefault();
        showUploadOverlay();
    });

    document.getElementById('upload-overlay').addEventListener('dragleave', (e) => {
        if (e.target === document.getElementById('upload-overlay')) hideUploadOverlay();
    });

    document.getElementById('upload-overlay').addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    document.getElementById('upload-overlay').addEventListener('drop', (e) => {
        e.preventDefault();
        handleUpload(e.dataTransfer.files);
    });

    // File input change
    document.getElementById('upload-input').addEventListener('change', (e) => {
        handleUpload(e.target.files);
        e.target.value = '';
    });

    // Search
    document.getElementById('search-input').addEventListener('input', (e) => {
        onSearchInput(e.target.value);
    });

    // Escape to close overlays, Ctrl+O quick switcher
    document.addEventListener('keydown', (e) => {
        // Ctrl+O — Quick Switcher
        if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
            e.preventDefault();
            openQuickSwitcher();
            return;
        }

        if (e.key === 'Escape') {
            if (document.getElementById('tt-overlay').classList.contains('active')) {
                closeTeamTaskModal();
            } else if (document.getElementById('quick-switcher-overlay').classList.contains('active')) {
                closeQuickSwitcher();
            } else if (document.getElementById('graph-overlay').classList.contains('active')) {
                closeGraph();
            } else if (document.getElementById('modal-overlay').classList.contains('active')) {
                modalCancel();
            } else if (document.getElementById('editor-panel').classList.contains('open')) {
                closeEditor();
            }
        }
    });

    // Backspace to go up (when not focused on input)
    document.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

        if (e.key === 'Backspace') {
            e.preventDefault();
            goUp();
        }

        // Ctrl+V to paste
        if ((e.ctrlKey || e.metaKey) && e.key === 'v' && clipboard.paths.length) {
            e.preventDefault();
            pasteItems();
        }
    });

    // AI modal keyboard
    document.getElementById('ai-instruction').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (aiPlanId) aiApproveExecution();
            else aiSubmitInstruction();
        }
        if (e.key === 'Escape') closeAIModal();
    });

    // Quick switcher input
    document.getElementById('qs-input').addEventListener('input', (e) => {
        filterQuickSwitcher(e.target.value);
    });
    document.getElementById('qs-input').addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { closeQuickSwitcher(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); qsNavigate(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); qsNavigate(-1); return; }
        if (e.key === 'Enter') { e.preventDefault(); qsConfirm(); return; }
    });

    // Quick switcher overlay click to close
    document.getElementById('quick-switcher-overlay').addEventListener('click', (e) => {
        if (e.target === document.getElementById('quick-switcher-overlay')) closeQuickSwitcher();
    });

    // Search mode toggle: double-click on search input to toggle filename/content
    document.getElementById('search-input').addEventListener('dblclick', () => {
        toggleSearchMode();
        toast(`Search mode: ${searchMode}`, 'info');
    });
}

function goUp() {
    if (!currentPath) return;
    const parts = currentPath.split('/');
    parts.pop();
    navigateTo(parts.join('/'));
}

// ── Init ──────────────────────────────────────────────

// ── Admin context switching ───────────────────────────────────

async function initContextSwitcher() {
    try {
        const resp = await apiFetch('/files/api/files/contexts');
        const data = await resp.json();
        if (!data.is_admin) return;
        const personal = data.contexts.find(c => c.id === 'personal');
        if (!personal) return;
        const btn = document.getElementById('btn-context-switch');
        btn.style.display = '';
        updateContextButton();
    } catch (e) { /* non-critical */ }
}

function updateContextButton() {
    const btn = document.getElementById('btn-context-switch');
    if (!btn) return;
    if (fileContext === 'personal') {
        btn.textContent = 'Server Files';
        btn.title = 'Switch to server workspace';
        btn.classList.add('context-personal');
    } else {
        btn.textContent = 'My Files';
        btn.title = 'Switch to personal NAS folder';
        btn.classList.remove('context-personal');
    }
}

async function toggleFileContext() {
    fileContext = fileContext === 'personal' ? '' : 'personal';
    updateContextButton();
    currentPath = '';
    await navigateTo('');
    toast(fileContext === 'personal' ? 'Viewing personal files' : 'Viewing server workspace', 'info');
}

(async () => {
    const ok = await initAuth();
    if (!ok) return;

    document.getElementById('loading-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    initEvents();
    await initContextSwitcher();

    // Check for path in URL
    const params = new URLSearchParams(window.location.search);
    const initPath = params.get('path') || '';
    await navigateTo(initPath);
})();
