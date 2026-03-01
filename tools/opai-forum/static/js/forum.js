/* OPAI Forum — Client logic (SPA with hash routing, Reddit-style layout) */

(function () {
    'use strict';

    // ── State ──────────────────────────────────────────
    let currentUser = null;
    let categories = [];
    let supabase = null;

    const EMOJIS = ['👍', '👎', '🔥', '❤️', '😂', '🤔', '🎉', '🚀', '👀', '💯', '🐛', '✅', '💡', '⚡', '🙏', '😍'];

    const SVG_UP = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 4l-8 8h5v8h6v-8h5z" fill="currentColor" stroke="none"/></svg>';
    const SVG_DOWN = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 20l8-8h-5V4H9v8H4z" fill="currentColor" stroke="none"/></svg>';
    const SVG_COMMENT = '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>';
    const SVG_EYE = '<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    const SVG_SHARE = '<svg viewBox="0 0 24 24"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13"/></svg>';
    const SVG_EDIT = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';

    // ── Auth ───────────────────────────────────────────
    async function initAuth() {
        const resp = await fetch('/auth/config');
        const cfg = await resp.json();
        if (!cfg.supabase_url || !cfg.supabase_anon_key) {
            document.getElementById('app').innerHTML = '<div class="empty-state"><p>Auth not configured</p></div>';
            return false;
        }

        supabase = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);
        const { data: { session } } = await supabase.auth.getSession();

        if (!session) {
            window.location.href = '/auth/login';
            return false;
        }

        // Check app access (non-admins only)
        if (session.user.app_metadata?.role !== 'admin') {
            try {
                const ar = await fetch('/api/me/apps', { headers: { 'Authorization': `Bearer ${session.access_token}` } });
                if (ar.ok) {
                    const ad = await ar.json();
                    if (!(ad.allowed_apps || []).includes('forum')) { window.location.href = '/'; return false; }
                }
            } catch (e) { /* allow on failure */ }
        }

        currentUser = {
            id: session.user.id,
            email: session.user.email,
            name: session.user.user_metadata?.display_name || session.user.email.split('@')[0],
            role: session.user.app_metadata?.role || 'user',
            token: session.access_token,
        };

        supabase.auth.onAuthStateChange((_event, sess) => {
            if (sess) currentUser.token = sess.access_token;
        });

        document.getElementById('user-display').textContent = currentUser.name;
        return true;
    }

    // ── API helpers ────────────────────────────────────
    async function api(method, path, body) {
        const opts = {
            method,
            headers: {
                'Authorization': `Bearer ${currentUser.token}`,
                'Content-Type': 'application/json',
            },
        };
        if (body) opts.body = JSON.stringify(body);
        const resp = await fetch(`/forum/api${path}`, opts);
        if (!resp.ok) {
            const err = await resp.text();
            throw new Error(err);
        }
        return resp.json();
    }

    async function apiUpload(file) {
        const form = new FormData();
        form.append('file', file);
        const resp = await fetch('/forum/api/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${currentUser.token}` },
            body: form,
        });
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json();
    }

    // ── Toast ──────────────────────────────────────────
    function toast(msg, type = '') {
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 3000);
    }

    // ── Unsaved-input guard ─────────────────────────────
    // Returns true if user confirms discard (or nothing to lose), false to cancel
    let skipNavGuard = false; // set by cancelNewPost to avoid double-prompting

    function confirmDiscardInput(textareaId) {
        const el = document.getElementById(textareaId);
        if (!el) return true;
        if (!el.value.trim()) return true;
        return confirm('You have unsaved input. Are you sure you want to close?');
    }

    // Check if the new-post form has any content worth protecting
    function hasNewPostContent() {
        const title = document.getElementById('post-title');
        const content = document.getElementById('post-content');
        const tags = document.getElementById('post-tags');
        const code = document.getElementById('code-snippet');
        const pollQ = document.getElementById('poll-question');
        return (title && title.value.trim()) ||
               (content && content.value.trim()) ||
               (tags && tags.value.trim()) ||
               (code && code.value.trim()) ||
               (pollQ && pollQ.value.trim());
    }

    // Check if any comment/reply textarea has unsaved content
    function hasUnsavedComment() {
        const main = document.getElementById('comment-input');
        if (main && main.value.trim()) return true;
        const replies = document.querySelectorAll('textarea[id^="reply-input-"]');
        for (const r of replies) {
            if (r.value.trim()) return true;
        }
        return false;
    }

    // ── Markdown rendering ─────────────────────────────
    function renderMd(text, format) {
        if (format === 'plain') {
            return escapeHtml(text).replace(/\n/g, '<br>');
        }
        if (window.marked) {
            const dirty = window.marked.parse(text);
            return window.DOMPurify ? window.DOMPurify.sanitize(dirty) : dirty;
        }
        return escapeHtml(text).replace(/\n/g, '<br>');
    }

    function escapeHtml(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    function stripMd(text) {
        return text.replace(/[#*_~`>\[\]()!]/g, '').replace(/\n/g, ' ').trim();
    }

    function timeAgo(dateStr) {
        const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
        if (diff < 60) return 'just now';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
        if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
        return new Date(dateStr).toLocaleDateString();
    }

    function scoreClass(score) {
        if (score > 0) return 'positive';
        if (score < 0) return 'negative';
        return '';
    }

    // ── Sidebar ──────────────────────────────────────
    async function loadSidebar(activeSlug) {
        if (!categories.length) {
            try { categories = await api('GET', '/categories'); } catch (e) { /* continue */ }
        }

        const container = document.getElementById('sidebar-categories');
        if (!container) return;

        let html = '';
        html += `<a class="cat-item ${!activeSlug ? 'active' : ''}" href="#/">`;
        html += '<span class="cat-icon">🏠</span><span class="cat-name">All Posts</span></a>';

        for (const cat of categories) {
            const active = activeSlug === cat.slug ? 'active' : '';
            html += `<a class="cat-item ${active}" href="#/category/${cat.slug}">`;
            html += `<span class="cat-icon">${cat.icon || '📁'}</span>`;
            html += `<span class="cat-name">${escapeHtml(cat.name)}</span>`;
            html += '</a>';
        }
        container.innerHTML = html;
    }

    // ── Router ─────────────────────────────────────────
    function route() {
        const hash = window.location.hash || '#/';
        const app = document.getElementById('app');

        if (hash === '#/new') {
            loadSidebar(null);
            renderNewPost(app);
        } else if (hash.startsWith('#/post/')) {
            const id = hash.split('/')[2];
            loadSidebar(null);
            renderPostDetail(app, id);
        } else if (hash.startsWith('#/category/')) {
            const slug = hash.split('/')[2];
            loadSidebar(slug);
            renderFeed(app, slug);
        } else if (hash.startsWith('#/user/')) {
            const uid = hash.split('/')[2];
            loadSidebar(null);
            renderFeed(app, null, uid);
        } else {
            loadSidebar(null);
            renderFeed(app);
        }
    }

    // ── Feed view ──────────────────────────────────────
    let feedSort = 'newest';
    let feedPage = 1;

    async function renderFeed(container, categorySlug, authorId) {
        container.innerHTML = '<div class="loading"><div class="spinner"></div><span>Loading posts...</span></div>';

        try {
            if (!categories.length) {
                categories = await api('GET', '/categories');
            }

            let categoryId = null;
            let categoryName = null;
            if (categorySlug) {
                const cat = categories.find(c => c.slug === categorySlug);
                if (cat) {
                    categoryId = cat.id;
                    categoryName = `${cat.icon || ''} ${cat.name}`;
                }
            }

            let url = `/posts?sort=${feedSort}&page=${feedPage}&limit=20`;
            if (categoryId) url += `&category=${categoryId}`;
            if (authorId) url += `&author=${authorId}`;

            const data = await api('GET', url);

            let html = '';

            // Sort/filter bar
            html += '<div class="feed-header">';
            html += sortButton('newest', '🕐', 'New');
            html += sortButton('top', '🔝', 'Top');
            html += sortButton('hot', '🔥', 'Hot');
            if (categoryName) {
                html += '<span class="feed-spacer"></span>';
                html += `<span class="feed-category-label">${categoryName}</span>`;
            }
            html += '</div>';

            // Posts
            if (!data.posts || data.posts.length === 0) {
                html += '<div class="empty-state">';
                html += '<div class="empty-state-icon">📭</div>';
                html += '<h3>No posts yet</h3>';
                html += '<p>Be the first to start a discussion!</p>';
                html += '<button class="btn btn-accent" onclick="window.location.hash=\'#/new\'">Create Post</button>';
                html += '</div>';
            } else {
                for (const post of data.posts) {
                    html += renderPostCard(post);
                }

                // Pagination
                const totalPages = Math.ceil(data.total / 20);
                if (totalPages > 1) {
                    html += '<div class="pagination">';
                    if (feedPage > 1) {
                        html += `<button class="btn btn-sm" data-page="${feedPage - 1}">Prev</button>`;
                    }
                    html += `<span class="page-info">${feedPage} / ${totalPages}</span>`;
                    if (feedPage < totalPages) {
                        html += `<button class="btn btn-sm" data-page="${feedPage + 1}">Next</button>`;
                    }
                    html += '</div>';
                }
            }

            container.innerHTML = html;

            // Bind sort buttons
            container.querySelectorAll('.sort-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    feedSort = btn.dataset.sort;
                    feedPage = 1;
                    route();
                });
            });

            // Bind pagination
            container.querySelectorAll('[data-page]').forEach(btn => {
                btn.addEventListener('click', () => {
                    feedPage = parseInt(btn.dataset.page);
                    route();
                });
            });

            // Bind vote arrows in feed (stop propagation so card click doesn't fire)
            container.querySelectorAll('.vote-arrow[data-vote]').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const id = btn.dataset.id;
                    const value = parseInt(btn.dataset.vote);
                    try {
                        await api('POST', `/posts/${id}/vote`, { value });
                        route();
                    } catch (err) {
                        toast('Vote failed', 'error');
                    }
                });
            });

        } catch (err) {
            container.innerHTML = `<div class="empty-state"><p>Error loading posts: ${escapeHtml(err.message)}</p></div>`;
        }
    }

    function sortButton(key, icon, label) {
        const active = feedSort === key ? 'active' : '';
        return `<button class="sort-btn ${active}" data-sort="${key}">${icon} ${label}</button>`;
    }

    function renderPostCard(post) {
        const pinned = post.is_pinned ? 'pinned' : '';
        const preview = stripMd(post.content).slice(0, 200);
        const catInfo = post.category || {};
        const authorName = post.author?.display_name || 'Unknown';
        const score = post.vote_score || 0;

        let html = `<div class="post-card ${pinned}" onclick="window.location.hash='#/post/${post.id}'">`;

        // Vote column
        html += '<div class="post-vote-col">';
        html += `<button class="vote-arrow" data-vote="1" data-id="${post.id}" title="Upvote">${SVG_UP}</button>`;
        html += `<span class="vote-score ${scoreClass(score)}">${score}</span>`;
        html += `<button class="vote-arrow" data-vote="-1" data-id="${post.id}" title="Downvote">${SVG_DOWN}</button>`;
        html += '</div>';

        // Content column
        html += '<div class="post-content-col">';

        // Meta line
        html += '<div class="post-meta-line">';
        if (post.is_pinned) html += '<span class="pin-indicator">📌 Pinned</span><span>·</span>';
        html += `<span class="post-category-link" onclick="event.stopPropagation();window.location.hash='#/category/${catInfo.slug || ''}'">`;
        html += `${catInfo.icon || ''} ${escapeHtml(catInfo.name || '')}</span>`;
        html += `<span>·</span>`;
        html += `<span class="post-author">${escapeHtml(authorName)}</span>`;
        html += `<span>·</span>`;
        html += `<span>${timeAgo(post.created_at)}</span>`;
        html += '</div>';

        // Title
        html += `<h3>${escapeHtml(post.title)}</h3>`;

        // Tags
        if (post.tags && post.tags.length > 0) {
            html += '<div class="post-tags">';
            for (const tag of post.tags.slice(0, 4)) {
                html += `<span class="tag">${escapeHtml(tag)}</span>`;
            }
            html += '</div>';
        }

        // Preview
        if (preview) {
            html += `<div class="post-preview">${escapeHtml(preview)}</div>`;
        }

        // Image thumbnail
        if (post.image_url) {
            html += `<img class="post-thumb" src="${escapeHtml(post.image_url)}" alt="">`;
        }

        // Action buttons (Reddit-style footer)
        html += '<div class="post-actions">';
        html += `<span class="action-btn">${SVG_COMMENT} ${post.comment_count} Comments</span>`;
        html += `<span class="action-btn">${SVG_EYE} ${post.view_count}</span>`;

        // Inline reactions
        if (post.reactions && Object.keys(post.reactions).length > 0) {
            html += '<span class="post-reactions-row">';
            for (const [emoji, count] of Object.entries(post.reactions).slice(0, 4)) {
                html += `<span class="reaction-pill">${emoji} ${count}</span>`;
            }
            html += '</span>';
        }

        html += '</div>'; // end post-actions
        html += '</div>'; // end post-content-col
        html += '</div>'; // end post-card
        return html;
    }

    // ── Edit mode state ─────────────────────────────────
    let editMode = false;
    let editOriginalTitle = '';
    let editOriginalContent = '';
    let editContentFormat = 'markdown';

    function enterEditMode(postId) {
        editMode = true;
        const titleEl = document.getElementById('post-detail-title');
        const bodyEl = document.getElementById('post-detail-content');
        if (titleEl) {
            editOriginalTitle = titleEl.textContent;
            titleEl.contentEditable = 'true';
            titleEl.classList.add('editable-active');
        }
        if (bodyEl) {
            editOriginalContent = bodyEl.dataset.rawContent || bodyEl.innerText;
            bodyEl.contentEditable = 'true';
            bodyEl.classList.add('editable-active');
            bodyEl.innerText = editOriginalContent;
        }
        document.getElementById('edit-btn-bar').classList.add('editing');
        const actionBtn = document.getElementById('edit-action-btn');
        if (actionBtn) actionBtn.classList.add('hidden-editing');
    }

    // Check if edit mode has unsaved changes
    function hasEditChanges() {
        if (!editMode) return false;
        const titleEl = document.getElementById('post-detail-title');
        const bodyEl = document.getElementById('post-detail-content');
        const currentTitle = titleEl ? titleEl.textContent.trim() : '';
        const currentContent = bodyEl ? bodyEl.innerText.trim() : '';
        return currentTitle !== editOriginalTitle.trim() || currentContent !== editOriginalContent.trim();
    }

    function cancelEditMode(skipConfirm) {
        if (!skipConfirm && hasEditChanges()) {
            if (!confirm('You have unsaved changes. Are you sure you want to discard them?')) return;
        }
        editMode = false;
        const titleEl = document.getElementById('post-detail-title');
        const bodyEl = document.getElementById('post-detail-content');
        if (titleEl) {
            titleEl.contentEditable = 'false';
            titleEl.classList.remove('editable-active');
            titleEl.textContent = editOriginalTitle;
        }
        if (bodyEl) {
            bodyEl.contentEditable = 'false';
            bodyEl.classList.remove('editable-active');
            bodyEl.innerHTML = renderMd(editOriginalContent, editContentFormat);
        }
        document.getElementById('edit-btn-bar').classList.remove('editing');
        const actionBtn = document.getElementById('edit-action-btn');
        if (actionBtn) actionBtn.classList.remove('hidden-editing');
    }

    async function saveEditMode(postId) {
        const titleEl = document.getElementById('post-detail-title');
        const bodyEl = document.getElementById('post-detail-content');
        const newTitle = titleEl ? titleEl.textContent.trim() : '';
        const newContent = bodyEl ? bodyEl.innerText.trim() : '';

        if (!newTitle || !newContent) {
            toast('Title and content cannot be empty', 'error');
            return;
        }

        const saveBtn = document.getElementById('save-btn');
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

        try {
            await api('PUT', `/posts/${postId}`, { title: newTitle, content: newContent });
            editMode = false;
            toast('Post updated!', 'success');
            route();
        } catch (err) {
            toast('Failed to save: ' + err.message, 'error');
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
        }
    }

    // ── Post detail ────────────────────────────────────
    async function renderPostDetail(container, postId) {
        container.innerHTML = '<div class="loading"><div class="spinner"></div><span>Loading post...</span></div>';
        editMode = false;

        try {
            const post = await api('GET', `/posts/${postId}`);
            const comments = await api('GET', `/posts/${postId}/comments`);
            editContentFormat = post.content_format || 'markdown';

            let html = '';

            // Back link
            html += '<a class="detail-back" href="#/">← Back to feed</a>';

            // Edit mode Save/Cancel bar (hidden until edit mode is active)
            if (post.author_id === currentUser.id) {
                html += '<div class="edit-btn-bar" id="edit-btn-bar">';
                html += '<button class="btn btn-accent btn-sm save-mode-btn" id="save-btn" onclick="forumApp.saveEdit(\'' + postId + '\')">Save</button>';
                html += '<button class="btn btn-sm cancel-mode-btn" id="cancel-btn" onclick="forumApp.cancelEdit()">Cancel</button>';
                html += '</div>';
            }

            // Post detail card
            html += '<div class="post-detail">';
            html += '<div class="post-detail-inner">';

            // Vote column
            const userVote = post.user_vote || 0;
            html += '<div class="post-detail-vote">';
            html += `<button class="vote-arrow ${userVote === 1 ? 'upvoted' : ''}" data-vote="1" data-target="post" data-id="${postId}">${SVG_UP}</button>`;
            html += `<span class="vote-score ${scoreClass(post.vote_score)}">${post.vote_score}</span>`;
            html += `<button class="vote-arrow ${userVote === -1 ? 'downvoted' : ''}" data-vote="-1" data-target="post" data-id="${postId}">${SVG_DOWN}</button>`;
            html += '</div>';

            // Body column
            html += '<div class="post-detail-body">';

            // Meta
            html += '<div class="post-meta-line">';
            if (post.is_pinned) html += '<span class="pin-indicator">📌 Pinned</span><span>·</span>';
            if (post.is_locked) html += '<span class="pin-indicator">🔒 Locked</span><span>·</span>';
            const catInfo = post.category || {};
            html += `<span class="post-category-link" onclick="window.location.hash='#/category/${catInfo.slug || ''}'">`;
            html += `${catInfo.icon || ''} ${escapeHtml(catInfo.name || '')}</span>`;
            html += '<span>·</span>';
            html += `<span class="post-author">${escapeHtml(post.author?.display_name || 'Unknown')}</span>`;
            html += '<span>·</span>';
            html += `<span>${timeAgo(post.created_at)}</span>`;
            html += '<span>·</span>';
            html += `<span>👁 ${post.view_count + 1}</span>`;
            html += '</div>';

            // Tags
            if (post.tags && post.tags.length > 0) {
                html += '<div class="post-tags">';
                for (const tag of post.tags) {
                    html += `<span class="tag">${escapeHtml(tag)}</span>`;
                }
                html += '</div>';
            }

            // Title (editable target)
            html += '<h2 id="post-detail-title">' + escapeHtml(post.title) + '</h2>';

            // Content (editable target — stores raw content in data attribute)
            html += '<div class="post-body" id="post-detail-content" data-raw-content="' + escapeHtml(post.content).replace(/"/g, '&quot;') + '">' + renderMd(post.content, post.content_format) + '</div>';

            // Image
            if (post.image_url) {
                html += `<div class="post-image"><img src="${escapeHtml(post.image_url)}" alt="${escapeHtml(post.image_name || 'Image')}"></div>`;
            }

            // Code snippet
            if (post.code_snippet) {
                html += '<div class="code-block">';
                html += `<div class="code-block-header"><span>${escapeHtml(post.code_language || 'code')}</span></div>`;
                html += `<pre><code class="language-${escapeHtml(post.code_language || '')}">${escapeHtml(post.code_snippet)}</code></pre>`;
                html += '</div>';
            }

            // Poll
            if (post.poll) {
                html += renderPoll(post.poll, postId);
            }

            html += '</div>'; // end post-detail-body
            html += '</div>'; // end post-detail-inner

            // Actions bar
            html += '<div class="detail-actions-bar">';
            html += `<span class="action-btn">${SVG_COMMENT} ${post.comment_count} Comments</span>`;
            html += `<button class="action-btn" onclick="forumApp.copyLink('${postId}')">${SVG_SHARE} Share</button>`;

            // Owner edit button (in the actions bar where users expect it)
            if (post.author_id === currentUser.id) {
                html += `<button class="action-btn edit-post-action" id="edit-action-btn" onclick="forumApp.enterEdit('${postId}')">${SVG_EDIT} Edit</button>`;
            }

            // Admin actions
            if (currentUser.role === 'admin') {
                html += '<div class="admin-actions">';
                html += `<button class="btn btn-sm" onclick="forumApp.pinPost('${postId}', ${!post.is_pinned})">${post.is_pinned ? 'Unpin' : 'Pin'}</button>`;
                html += `<button class="btn btn-sm" onclick="forumApp.lockPost('${postId}', ${!post.is_locked})">${post.is_locked ? 'Unlock' : 'Lock'}</button>`;
                html += `<button class="btn btn-sm btn-danger" onclick="forumApp.adminDeletePost('${postId}')">Delete</button>`;
                html += '</div>';
            }

            // Own post actions
            if (post.author_id === currentUser.id && currentUser.role !== 'admin') {
                html += '<div class="admin-actions">';
                html += `<button class="btn btn-sm btn-danger" onclick="forumApp.deletePost('${postId}')">Delete</button>`;
                html += '</div>';
            }
            html += '</div>'; // end detail-actions-bar

            // Reactions
            html += renderReactionsBar(post.reactions || {}, post.user_reactions || [], 'post', postId);

            html += '</div>'; // end post-detail

            // Comments section
            html += '<div class="comments-section">';
            html += '<div class="comments-card">';
            html += `<div class="comments-header">Comments (${post.comment_count})</div>`;

            if (!post.is_locked) {
                html += '<div class="comment-form" id="main-comment-form">';
                html += `<textarea id="comment-input" placeholder="What are your thoughts?"></textarea>`;
                html += '<div class="comment-form-actions">';
                html += `<button class="btn btn-accent btn-sm" onclick="forumApp.submitComment('${postId}')">Comment</button>`;
                html += '</div></div>';
            }

            html += '<div id="comments-list">';
            html += renderCommentTree(comments, postId, post.is_locked);
            html += '</div>';

            html += '</div>'; // end comments-card
            html += '</div>'; // end comments-section

            container.innerHTML = html;

            // Bind vote buttons
            container.querySelectorAll('.vote-arrow[data-vote]').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const target = btn.dataset.target;
                    const id = btn.dataset.id;
                    const value = parseInt(btn.dataset.vote);
                    const endpoint = target === 'post' ? `/posts/${id}/vote` : `/comments/${id}/vote`;
                    try {
                        await api('POST', endpoint, { value });
                        route();
                    } catch (err) {
                        toast('Vote failed: ' + err.message, 'error');
                    }
                });
            });

            // Syntax highlight code blocks
            if (window.Prism) {
                window.Prism.highlightAll();
            }

        } catch (err) {
            container.innerHTML = `<div class="empty-state"><p>Error: ${escapeHtml(err.message)}</p></div>`;
        }
    }

    function renderPoll(poll, postId) {
        const options = (poll.options || []).sort((a, b) => a.sort_order - b.sort_order);
        const totalVotes = options.reduce((sum, o) => sum + o.vote_count, 0);
        const userVotes = poll.user_votes || [];
        const hasVoted = userVotes.length > 0;
        const isClosed = poll.closes_at && new Date(poll.closes_at) < new Date();

        let html = '<div class="poll-widget">';
        html += `<div class="poll-question">${escapeHtml(poll.question)}</div>`;

        for (const opt of options) {
            const pct = totalVotes > 0 ? Math.round((opt.vote_count / totalVotes) * 100) : 0;
            const voted = userVotes.includes(opt.id) ? 'voted' : '';

            html += `<div class="poll-option ${voted}" data-option="${opt.id}" data-postid="${postId}" ${isClosed ? '' : 'onclick="forumApp.votePoll(this)"'}>`;

            if (hasVoted || isClosed) {
                html += `<div class="poll-option-bg" style="width:${pct}%"></div>`;
                html += `<div class="poll-label">${escapeHtml(opt.label)}</div>`;
                html += `<span class="poll-pct">${pct}%</span>`;
            } else {
                html += `<div class="poll-radio"></div>`;
                html += `<div class="poll-label">${escapeHtml(opt.label)}</div>`;
            }
            html += '</div>';
        }

        html += `<div class="poll-total">${totalVotes} vote${totalVotes !== 1 ? 's' : ''}`;
        if (poll.closes_at) {
            html += isClosed ? ' · Poll closed' : ` · Closes ${timeAgo(poll.closes_at)}`;
        }
        html += '</div></div>';
        return html;
    }

    function renderReactionsBar(reactions, userReactions, targetType, targetId) {
        let html = '<div class="reactions-bar" style="position:relative;">';
        for (const [emoji, count] of Object.entries(reactions)) {
            const userReacted = userReactions.includes(emoji) ? 'user-reacted' : '';
            html += `<span class="reaction-chip ${userReacted}" onclick="forumApp.react('${targetType}', '${targetId}', '${emoji}')">${emoji} ${count}</span>`;
        }
        html += `<button class="add-reaction-btn" onclick="forumApp.showEmojiPicker(this, '${targetType}', '${targetId}')">+ React</button>`;
        html += '</div>';
        return html;
    }

    function renderCommentTree(comments, postId, isLocked, depth) {
        depth = depth || 0;
        let html = '';
        for (const c of comments) {
            const nested = depth > 0 ? 'comment-nested' : '';
            html += `<div class="comment ${nested}">`;
            html += '<div class="comment-header">';
            html += `<span class="comment-author">${escapeHtml(c.author?.display_name || 'Unknown')}</span>`;
            html += `<span class="comment-time">· ${timeAgo(c.created_at)}</span>`;
            html += '</div>';
            html += `<div class="comment-body">${renderMd(c.content, c.content_format)}</div>`;

            // Comment actions
            html += '<div class="comment-actions">';
            const uv = c.user_vote || 0;
            html += `<button class="vote-arrow ${uv === 1 ? 'upvoted' : ''}" data-vote="1" data-target="comment" data-id="${c.id}" style="width:22px;height:20px;">${SVG_UP}</button>`;
            html += `<span class="vote-score ${scoreClass(c.vote_score)}" style="font-size:0.72rem;">${c.vote_score}</span>`;
            html += `<button class="vote-arrow ${uv === -1 ? 'downvoted' : ''}" data-vote="-1" data-target="comment" data-id="${c.id}" style="width:22px;height:20px;">${SVG_DOWN}</button>`;

            if (!isLocked && depth < 3) {
                html += `<button class="action-btn" onclick="forumApp.showReplyForm('${postId}', '${c.id}', this)">Reply</button>`;
            }

            // Reactions (inline)
            if (c.reactions && Object.keys(c.reactions).length > 0) {
                for (const [emoji, count] of Object.entries(c.reactions)) {
                    const ur = (c.user_reactions || []).includes(emoji) ? 'mine' : '';
                    html += `<span class="reaction-pill ${ur}" onclick="forumApp.react('comment', '${c.id}', '${emoji}')" style="font-size:0.7rem;">${emoji}${count}</span>`;
                }
            }
            html += `<button class="action-btn" onclick="forumApp.showEmojiPicker(this, 'comment', '${c.id}')" style="font-size:0.7rem;">+</button>`;

            if (c.author_id === currentUser.id) {
                html += `<button class="action-btn btn-danger" onclick="forumApp.deleteComment('${c.id}')" style="margin-left:auto;">Delete</button>`;
            }
            html += '</div>';

            // Reply form placeholder
            html += `<div id="reply-form-${c.id}"></div>`;

            // Children
            if (c.children && c.children.length > 0) {
                html += renderCommentTree(c.children, postId, isLocked, depth + 1);
            }
            html += '</div>';
        }
        return html;
    }

    // ── New post form ──────────────────────────────────
    async function renderNewPost(container) {
        if (!categories.length) {
            try { categories = await api('GET', '/categories'); } catch (e) { /* continue */ }
        }

        let html = '';
        html += '<a class="detail-back" href="#/">← Back to feed</a>';
        html += '<div class="form-card">';
        html += '<h2>Create Post</h2>';

        // Title
        html += '<div class="form-group"><label>Title</label>';
        html += '<input type="text" id="post-title" placeholder="An interesting title..." maxlength="200"></div>';

        // Category + Format row
        html += '<div class="form-row">';
        html += '<div class="form-group"><label>Category</label>';
        html += '<select id="post-category">';
        for (const cat of categories) {
            html += `<option value="${cat.id}">${cat.icon || ''} ${cat.name}</option>`;
        }
        html += '</select></div>';
        html += '<div class="form-group"><label>Format</label>';
        html += '<select id="post-format"><option value="markdown">Markdown</option><option value="plain">Plain Text</option></select></div>';
        html += '</div>';

        // Content
        html += '<div class="form-group"><label>Content</label>';
        html += '<textarea id="post-content" placeholder="What\'s on your mind?"></textarea></div>';

        // Tags
        html += '<div class="form-group"><label>Tags (comma separated)</label>';
        html += '<input type="text" id="post-tags" placeholder="e.g. react, supabase, help"></div>';

        // Image upload
        html += '<div class="form-group"><label>Image (optional)</label>';
        html += '<div class="upload-area" id="upload-area" onclick="document.getElementById(\'file-input\').click()">';
        html += '<p>Click or drop image here (max 5MB)</p>';
        html += '<input type="file" id="file-input" accept="image/*" style="display:none">';
        html += '</div>';
        html += '<div class="upload-preview" id="upload-preview"></div></div>';

        // Code snippet
        html += '<div class="form-group">';
        html += '<div class="form-check"><input type="checkbox" id="has-code" onchange="document.getElementById(\'code-section\').classList.toggle(\'hidden\')"><label>Add code snippet</label></div>';
        html += '<div id="code-section" class="hidden" style="margin-top:0.75rem;">';
        html += '<div class="form-row">';
        html += '<div class="form-group"><label>Language</label>';
        html += '<select id="code-lang"><option value="">Auto</option>';
        for (const lang of ['javascript', 'typescript', 'python', 'html', 'css', 'sql', 'bash', 'json', 'rust', 'go', 'java', 'c', 'cpp']) {
            html += `<option value="${lang}">${lang}</option>`;
        }
        html += '</select></div>';
        html += '<div></div></div>';
        html += '<div class="form-group"><label>Code</label>';
        html += '<textarea id="code-snippet" style="font-family:monospace;min-height:120px;" placeholder="Paste your code..."></textarea></div>';
        html += '</div></div>';

        // Poll
        html += '<div class="form-group">';
        html += '<div class="form-check"><input type="checkbox" id="has-poll" onchange="document.getElementById(\'poll-section\').classList.toggle(\'hidden\')"><label>Add poll</label></div>';
        html += '<div id="poll-section" class="hidden">';
        html += '<div class="poll-builder">';
        html += '<div class="form-group"><label>Question</label>';
        html += '<input type="text" id="poll-question" placeholder="What do you think?"></div>';
        html += '<div id="poll-options">';
        html += '<div class="poll-option-input"><input type="text" placeholder="Option 1"><button class="btn-remove" onclick="this.parentElement.remove()">×</button></div>';
        html += '<div class="poll-option-input"><input type="text" placeholder="Option 2"><button class="btn-remove" onclick="this.parentElement.remove()">×</button></div>';
        html += '</div>';
        html += '<button class="btn btn-sm" style="margin-top:0.5rem;" onclick="forumApp.addPollOption()">+ Add Option</button>';
        html += '<div class="form-check" style="margin-top:0.5rem;"><input type="checkbox" id="poll-multiple"><label>Allow multiple choices</label></div>';
        html += '</div></div></div>';

        // Submit
        html += '<div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1.25rem;">';
        html += '<button class="btn" onclick="forumApp.cancelNewPost()">Cancel</button>';
        html += '<button class="btn btn-accent" id="submit-post-btn" onclick="forumApp.submitPost()">Post</button>';
        html += '</div>';
        html += '</div>'; // end form-card

        container.innerHTML = html;

        // File upload handler
        const fileInput = document.getElementById('file-input');
        const uploadArea = document.getElementById('upload-area');

        fileInput.addEventListener('change', () => handleFileSelect(fileInput.files[0]));

        uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.style.borderColor = 'var(--accent)'; });
        uploadArea.addEventListener('dragleave', () => { uploadArea.style.borderColor = ''; });
        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.style.borderColor = '';
            if (e.dataTransfer.files.length) handleFileSelect(e.dataTransfer.files[0]);
        });
    }

    let uploadedImageUrl = null;
    let uploadedImageName = null;

    async function handleFileSelect(file) {
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
            toast('File too large (max 5MB)', 'error');
            return;
        }

        const area = document.getElementById('upload-area');
        area.innerHTML = '<p>Uploading...</p>';

        try {
            const result = await apiUpload(file);
            uploadedImageUrl = result.url;
            uploadedImageName = result.name;
            area.classList.add('has-file');
            area.innerHTML = `<p>✓ ${escapeHtml(file.name)}</p>`;
            document.getElementById('upload-preview').innerHTML = `<img src="${escapeHtml(result.url)}" alt="preview">`;
        } catch (err) {
            area.innerHTML = '<p>Upload failed. Click to try again.</p>';
            toast('Upload failed: ' + err.message, 'error');
        }
    }

    // ── Public API (window-accessible functions) ──────
    window.forumApp = {
        // Edit mode methods
        enterEdit(postId) { enterEditMode(postId); },
        saveEdit(postId) { saveEditMode(postId); },
        cancelEdit() { cancelEditMode(); },

        async submitPost() {
            const title = document.getElementById('post-title').value.trim();
            const content = document.getElementById('post-content').value.trim();
            const categoryId = document.getElementById('post-category').value;
            const format = document.getElementById('post-format').value;
            const tagsRaw = document.getElementById('post-tags').value;
            const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

            if (!title || !content) {
                toast('Title and content are required', 'error');
                return;
            }

            const body = {
                title, content,
                category_id: categoryId,
                content_format: format,
                tags,
            };

            if (uploadedImageUrl) {
                body.image_url = uploadedImageUrl;
                body.image_name = uploadedImageName;
            }

            const hasCode = document.getElementById('has-code').checked;
            if (hasCode) {
                body.code_snippet = document.getElementById('code-snippet').value;
                body.code_language = document.getElementById('code-lang').value;
            }

            const hasPoll = document.getElementById('has-poll').checked;
            if (hasPoll) {
                const question = document.getElementById('poll-question').value.trim();
                const optionEls = document.querySelectorAll('#poll-options .poll-option-input input');
                const options = Array.from(optionEls).map(el => el.value.trim()).filter(Boolean);

                if (question && options.length >= 2) {
                    body.poll = {
                        question,
                        options,
                        allow_multiple: document.getElementById('poll-multiple').checked,
                    };
                }
            }

            const btn = document.getElementById('submit-post-btn');
            btn.disabled = true;
            btn.textContent = 'Posting...';

            try {
                const post = await api('POST', '/posts', body);
                uploadedImageUrl = null;
                uploadedImageName = null;
                toast('Post created!', 'success');
                window.location.hash = `#/post/${post.id}`;
            } catch (err) {
                toast('Failed: ' + err.message, 'error');
                btn.disabled = false;
                btn.textContent = 'Post';
            }
        },

        async submitComment(postId, parentId) {
            const inputId = parentId ? `reply-input-${parentId}` : 'comment-input';
            const input = document.getElementById(inputId);
            const content = input.value.trim();
            if (!content) return;

            try {
                await api('POST', `/posts/${postId}/comments`, {
                    content,
                    parent_id: parentId || null,
                });
                toast('Comment added', 'success');
                route();
            } catch (err) {
                toast('Failed: ' + err.message, 'error');
            }
        },

        async deletePost(postId) {
            if (!confirm('Delete this post?')) return;
            try {
                await api('DELETE', `/posts/${postId}`);
                toast('Post deleted', 'success');
                window.location.hash = '#/';
            } catch (err) {
                toast('Failed: ' + err.message, 'error');
            }
        },

        async deleteComment(commentId) {
            if (!confirm('Delete this comment?')) return;
            try {
                await api('DELETE', `/comments/${commentId}`);
                toast('Comment deleted', 'success');
                route();
            } catch (err) {
                toast('Failed: ' + err.message, 'error');
            }
        },

        async pinPost(postId, value) {
            try {
                await api('PUT', `/posts/${postId}/pin`, { value });
                toast(value ? 'Pinned' : 'Unpinned', 'success');
                route();
            } catch (err) { toast('Failed', 'error'); }
        },

        async lockPost(postId, value) {
            try {
                await api('PUT', `/posts/${postId}/lock`, { value });
                toast(value ? 'Locked' : 'Unlocked', 'success');
                route();
            } catch (err) { toast('Failed', 'error'); }
        },

        async adminDeletePost(postId) {
            if (!confirm('Permanently delete this post? This cannot be undone.')) return;
            try {
                await api('DELETE', `/posts/${postId}/admin`);
                toast('Permanently deleted', 'success');
                window.location.hash = '#/';
            } catch (err) { toast('Failed', 'error'); }
        },

        async react(targetType, targetId, emoji) {
            const endpoint = targetType === 'post' ? `/posts/${targetId}/react` : `/comments/${targetId}/react`;
            try {
                await api('POST', endpoint, { emoji });
                route();
            } catch (err) { toast('Failed', 'error'); }
        },

        showEmojiPicker(btn, targetType, targetId) {
            document.querySelectorAll('.emoji-picker').forEach(el => el.remove());

            const picker = document.createElement('div');
            picker.className = 'emoji-picker';
            for (const emoji of EMOJIS) {
                const opt = document.createElement('button');
                opt.className = 'emoji-option';
                opt.textContent = emoji;
                opt.onclick = (e) => {
                    e.stopPropagation();
                    picker.remove();
                    forumApp.react(targetType, targetId, emoji);
                };
                picker.appendChild(opt);
            }

            btn.parentElement.appendChild(picker);
            setTimeout(() => {
                document.addEventListener('click', function close(e) {
                    if (!picker.contains(e.target)) {
                        picker.remove();
                        document.removeEventListener('click', close);
                    }
                });
            }, 0);
        },

        async votePoll(el) {
            const optionId = el.dataset.option;
            const postId = el.dataset.postid;
            try {
                await api('POST', `/posts/${postId}/poll/vote`, { option_id: optionId });
                route();
            } catch (err) { toast('Failed: ' + err.message, 'error'); }
        },

        showReplyForm(postId, parentId, btn) {
            const container = document.getElementById('reply-form-' + parentId);
            if (container.children.length > 0) {
                if (!confirmDiscardInput('reply-input-' + parentId)) return;
                container.innerHTML = '';
                return;
            }
            container.innerHTML = '<div class="comment-form" style="margin-top:0.5rem;border-top:none;padding:0.5rem 0;">'
                + '<textarea id="reply-input-' + parentId + '" placeholder="Write a reply..." style="min-height:60px;"></textarea>'
                + '<div class="comment-form-actions">'
                + '<button class="btn btn-sm" onclick="forumApp.cancelReply(\'' + parentId + '\')">Cancel</button>'
                + '<button class="btn btn-accent btn-sm" onclick="forumApp.submitComment(\'' + postId + '\', \'' + parentId + '\')">Reply</button>'
                + '</div></div>';
        },

        cancelReply(parentId) {
            if (!confirmDiscardInput('reply-input-' + parentId)) return;
            var container = document.getElementById('reply-form-' + parentId);
            if (container) container.innerHTML = '';
        },

        cancelNewPost() {
            if (hasNewPostContent()) {
                if (!confirm('You have unsaved input. Are you sure you want to leave?')) return;
            }
            skipNavGuard = true;
            window.location.hash = '#/';
        },

        addPollOption() {
            const container = document.getElementById('poll-options');
            const idx = container.children.length + 1;
            const div = document.createElement('div');
            div.className = 'poll-option-input';
            div.innerHTML = `<input type="text" placeholder="Option ${idx}"><button class="btn-remove" onclick="this.parentElement.remove()">×</button>`;
            container.appendChild(div);
        },

        copyLink(postId) {
            const url = `${window.location.origin}/forum/#/post/${postId}`;
            navigator.clipboard.writeText(url).then(() => {
                toast('Link copied!', 'success');
            }).catch(() => {
                toast('Could not copy link', 'error');
            });
        },
    };

    // ── Escape key handler ──────────────────────────────
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;

        // Close feedback modal (from shared navbar) with unsaved-input guard
        const fbOverlay = document.querySelector('.opai-fb-overlay');
        if (fbOverlay) {
            const fbTextarea = fbOverlay.querySelector('.opai-fb-text');
            if (fbTextarea && fbTextarea.value.trim()) {
                if (!confirm('You have unsaved input. Are you sure you want to close?')) return;
            }
            fbOverlay.classList.remove('open');
            setTimeout(() => fbOverlay.remove(), 200);
            return;
        }

        // Close emoji picker (no confirmation needed — no text input)
        const picker = document.querySelector('.emoji-picker');
        if (picker) { picker.remove(); return; }

        // Cancel edit mode (with confirmation if changes exist)
        if (editMode) { cancelEditMode(); return; }

        // Close any open reply form (with confirmation if has content)
        const openReply = document.querySelector('[id^="reply-form-"] .comment-form');
        if (openReply) {
            const textarea = openReply.querySelector('textarea');
            if (textarea && textarea.value.trim()) {
                if (!confirm('You have unsaved input. Are you sure you want to close?')) return;
            }
            openReply.parentElement.innerHTML = '';
            return;
        }
    });

    // ── Init ───────────────────────────────────────────
    async function init() {
        const ok = await initAuth();
        if (!ok) return;
        window.addEventListener('hashchange', function (e) {
            // Guard: leaving the new-post form with unsaved content
            if (skipNavGuard) {
                skipNavGuard = false;
                route();
                return;
            }
            const oldHash = new URL(e.oldURL).hash || '#/';
            if (oldHash === '#/new' && hasNewPostContent()) {
                if (!confirm('You have unsaved input. Are you sure you want to leave?')) {
                    skipNavGuard = true;
                    history.pushState(null, '', '#/new');
                    return;
                }
            }
            // Guard: leaving post detail with unsaved edit
            if (oldHash.startsWith('#/post/') && hasEditChanges()) {
                if (!confirm('You have unsaved changes. Are you sure you want to discard them?')) {
                    skipNavGuard = true;
                    history.pushState(null, '', oldHash);
                    return;
                }
                editMode = false; // discard confirmed — reset state
            }
            // Guard: leaving post detail with unsaved comment
            if (oldHash.startsWith('#/post/') && hasUnsavedComment()) {
                if (!confirm('You have unsaved input. Are you sure you want to leave?')) {
                    skipNavGuard = true;
                    history.pushState(null, '', oldHash);
                    return;
                }
            }
            route();
        });
        route();
    }

    init();
})();
