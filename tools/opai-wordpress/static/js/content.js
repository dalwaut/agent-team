/* OP WordPress — Posts, Pages, Media management (full CRUD) */

WP.Content = {
    postsPage: 1,
    pagesPage: 1,
    mediaPage: 1,

    // ── Helpers ──────────────────────────────────────
    _title(obj) {
        if (!obj) return '';
        if (typeof obj === 'object') return obj.rendered || obj.raw || '';
        return obj;
    },
    _content(obj) {
        if (!obj) return '';
        if (typeof obj === 'object') return obj.rendered || obj.raw || '';
        return obj;
    },
    _statusBadge(status) {
        const cls = status === 'publish' ? 'badge-green' :
                    status === 'draft' ? 'badge-orange' :
                    status === 'private' ? 'badge-purple' :
                    status === 'pending' ? 'badge-blue' :
                    status === 'trash' ? 'badge-red' : 'badge-blue';
        return '<span class="badge ' + cls + '">' + (status || 'unknown') + '</span>';
    },

    // ══════════════════════════════════════════════════
    //  POSTS
    // ══════════════════════════════════════════════════

    async renderPosts(main) {
        if (!WP.requireSite(main)) return;

        main.innerHTML = '<div class="main-header">' +
            '<h2>Posts — ' + WP.currentSite.name + '</h2>' +
            '<div style="display:flex;gap:8px">' +
            '<input type="text" class="form-input" id="posts-search" placeholder="Search posts..." style="width:200px" onkeydown="if(event.key===\'Enter\'){WP.Content.postsPage=1;WP.Content.renderPosts(document.getElementById(\'main-content\'))}">' +
            '<select class="form-input" id="posts-status" style="width:120px" onchange="WP.Content.postsPage=1;WP.Content.renderPosts(document.getElementById(\'main-content\'))">' +
            '<option value="">All Status</option><option value="publish">Published</option><option value="draft">Draft</option><option value="pending">Pending</option><option value="private">Private</option><option value="trash">Trash</option>' +
            '</select>' +
            '<button class="btn btn-primary" onclick="WP.Content.showPostEditor()">+ New Post</button>' +
            '</div></div>' +
            '<div id="posts-content"><div class="loading-inline"><div class="spinner"></div></div></div>';

        try {
            const search = document.getElementById('posts-search')?.value || '';
            const status = document.getElementById('posts-status')?.value || '';
            let url = 'sites/' + WP.currentSite.id + '/posts?page=' + WP.Content.postsPage + '&per_page=20';
            if (search) url += '&search=' + encodeURIComponent(search);
            if (status) url += '&status=' + status;
            const result = await WP.api(url);
            const posts = result.data || result || [];
            WP.Content._renderPostsTable(posts);
        } catch (e) {
            document.getElementById('posts-content').innerHTML =
                '<p style="color:var(--red)">Failed to load posts: ' + e.message + '</p>';
        }
    },

    _renderPostsTable(posts) {
        const el = document.getElementById('posts-content');
        if (!Array.isArray(posts) || posts.length === 0) {
            el.innerHTML = '<div class="empty-state"><h3>No posts found</h3></div>';
            return;
        }

        let html = '<table class="data-table"><thead><tr>' +
            '<th>Title</th><th>Status</th><th>Date</th><th>Actions</th>' +
            '</tr></thead><tbody>';

        for (const p of posts) {
            const title = WP.Content._title(p.title);
            html += '<tr>' +
                '<td><strong>' + WP.stripHtml(title) + '</strong>' +
                (p.slug ? '<div style="font-size:11px;color:var(--text-muted)">/' + p.slug + '</div>' : '') +
                '</td>' +
                '<td>' + WP.Content._statusBadge(p.status) + '</td>' +
                '<td>' + WP.formatDate(p.date) + '</td>' +
                '<td style="white-space:nowrap">' +
                '<a class="btn-sm" href="' + (WP.currentSite.url || '').replace(/\/$/, '') + '/wp-admin/post.php?post=' + p.id + '&action=edit" target="_blank" style="color:var(--blue);text-decoration:none;border-color:var(--blue)" title="Edit in WP Admin">WP</a> ' +
                '<button class="btn-sm" onclick="WP.Content.viewPost(' + p.id + ')" title="View">&#128065;</button> ' +
                '<button class="btn-sm" onclick="WP.Content.showPostEditor(' + p.id + ')" title="Edit">&#9998;</button> ' +
                '<button class="btn-sm" style="color:var(--red)" onclick="WP.Content.deletePost(' + p.id + ')" title="Trash">&#128465;</button>' +
                '</td></tr>';
        }

        html += '</tbody></table>' +
            '<div class="pagination">' +
            '<button ' + (WP.Content.postsPage <= 1 ? 'disabled' : '') + ' onclick="WP.Content.postsPage--;WP.Content.renderPosts(document.getElementById(\'main-content\'))">Prev</button>' +
            '<span class="page-info">Page ' + WP.Content.postsPage + '</span>' +
            '<button onclick="WP.Content.postsPage++;WP.Content.renderPosts(document.getElementById(\'main-content\'))">Next</button></div>';

        el.innerHTML = html;
    },

    async viewPost(postId) {
        try {
            const result = await WP.api('sites/' + WP.currentSite.id + '/posts/' + postId);
            const p = result.data || result;
            const title = WP.Content._title(p.title);
            const content = WP.Content._content(p.content);
            const excerpt = WP.Content._content(p.excerpt);

            const html = '<div class="modal-backdrop" onclick="if(event.target===this)this.remove()">' +
                '<div class="modal" style="max-width:750px">' +
                '<h3>' + WP.stripHtml(title) + '</h3>' +
                '<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;display:flex;gap:16px">' +
                '<span>' + WP.Content._statusBadge(p.status) + '</span>' +
                '<span>Date: ' + WP.formatDate(p.date) + '</span>' +
                '<span>Slug: ' + (p.slug || '--') + '</span>' +
                (p.link ? '<a href="' + p.link + '" target="_blank" style="color:var(--blue)">View on site &#8599;</a>' : '') +
                '</div>' +
                (excerpt ? '<div style="padding:8px 12px;background:var(--bg);border-radius:6px;margin-bottom:12px;font-size:12px;color:var(--text-muted)"><strong>Excerpt:</strong> ' + excerpt + '</div>' : '') +
                '<div style="max-height:400px;overflow-y:auto;padding:12px;background:var(--bg);border-radius:6px;font-size:13px;line-height:1.6">' +
                (content || '<em>No content</em>') + '</div>' +
                '<div class="modal-actions">' +
                '<button class="btn btn-ghost" onclick="this.closest(\'.modal-backdrop\').remove()">Close</button>' +
                '<button class="btn btn-primary" onclick="this.closest(\'.modal-backdrop\').remove();WP.Content.showPostEditor(' + postId + ')">Edit</button>' +
                '</div></div></div>';
            document.body.insertAdjacentHTML('beforeend', html);
        } catch (e) {
            WP.toast('Failed to load post: ' + e.message, 'error');
        }
    },

    async showPostEditor(postId) {
        let p = { title: '', content: '', status: 'draft', excerpt: '', slug: '' };
        const isEdit = !!postId;

        if (isEdit) {
            try {
                const result = await WP.api('sites/' + WP.currentSite.id + '/posts/' + postId);
                const data = result.data || result;
                p = {
                    title: WP.Content._title(data.title),
                    content: data.content?.raw || WP.Content._content(data.content),
                    status: data.status || 'draft',
                    excerpt: data.excerpt?.raw || WP.Content._content(data.excerpt),
                    slug: data.slug || '',
                };
            } catch (e) {
                WP.toast('Failed to load post: ' + e.message, 'error');
                return;
            }
        }

        const html = '<div class="modal-backdrop" onclick="if(event.target===this)this.remove()">' +
            '<div class="modal" style="max-width:700px">' +
            '<h3>' + (isEdit ? 'Edit Post' : 'New Post') + '</h3>' +
            '<div class="form-group"><label>Title</label>' +
            '<input type="text" class="form-input" id="post-title" value="' + WP.stripHtml(p.title).replace(/"/g, '&quot;') + '"></div>' +
            '<div class="form-group"><label>Slug</label>' +
            '<input type="text" class="form-input" id="post-slug" value="' + (p.slug || '') + '" placeholder="auto-generated"></div>' +
            '<div class="form-group"><label>Content (HTML)</label>' +
            '<textarea class="form-input" id="post-content" rows="10" style="font-family:monospace;font-size:12px">' + WP.stripHtml(p.content) + '</textarea></div>' +
            '<div class="form-row">' +
            '<div class="form-group"><label>Excerpt</label>' +
            '<textarea class="form-input" id="post-excerpt" rows="2">' + WP.stripHtml(p.excerpt) + '</textarea></div>' +
            '<div class="form-group"><label>Status</label>' +
            '<select class="form-input" id="post-status">' +
            '<option value="draft"' + (p.status === 'draft' ? ' selected' : '') + '>Draft</option>' +
            '<option value="publish"' + (p.status === 'publish' ? ' selected' : '') + '>Published</option>' +
            '<option value="pending"' + (p.status === 'pending' ? ' selected' : '') + '>Pending Review</option>' +
            '<option value="private"' + (p.status === 'private' ? ' selected' : '') + '>Private</option>' +
            '</select></div></div>' +
            '<div class="modal-actions">' +
            '<button class="btn btn-ghost" onclick="this.closest(\'.modal-backdrop\').remove()">Cancel</button>' +
            '<button class="btn btn-primary" onclick="WP.Content.savePost(' + (postId || 'null') + ')">' + (isEdit ? 'Save' : 'Create') + '</button>' +
            '</div></div></div>';
        document.body.insertAdjacentHTML('beforeend', html);
    },

    async savePost(postId) {
        const body = {
            title: document.getElementById('post-title').value,
            content: document.getElementById('post-content').value,
            status: document.getElementById('post-status').value,
            excerpt: document.getElementById('post-excerpt').value,
        };
        const slug = document.getElementById('post-slug').value.trim();
        if (slug) body.slug = slug;

        if (!body.title) { WP.toast('Title is required', 'error'); return; }

        try {
            if (postId) {
                await WP.api('sites/' + WP.currentSite.id + '/posts/' + postId, { method: 'PUT', body });
                WP.toast('Post updated');
            } else {
                await WP.api('sites/' + WP.currentSite.id + '/posts', { method: 'POST', body });
                WP.toast('Post created');
            }
            document.querySelector('.modal-backdrop')?.remove();
            WP.Content.renderPosts(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Save failed: ' + e.message, 'error');
        }
    },

    async deletePost(postId) {
        if (!confirm('Move this post to trash?')) return;
        try {
            await WP.api('sites/' + WP.currentSite.id + '/posts/' + postId, { method: 'DELETE' });
            WP.toast('Post trashed');
            WP.Content.renderPosts(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Delete failed: ' + e.message, 'error');
        }
    },

    // ══════════════════════════════════════════════════
    //  PAGES
    // ══════════════════════════════════════════════════

    async renderPages(main) {
        if (!WP.requireSite(main)) return;

        main.innerHTML = '<div class="main-header">' +
            '<h2>Pages — ' + WP.currentSite.name + '</h2>' +
            '<div style="display:flex;gap:8px">' +
            '<input type="text" class="form-input" id="pages-search" placeholder="Search pages..." style="width:200px" onkeydown="if(event.key===\'Enter\'){WP.Content.pagesPage=1;WP.Content.renderPages(document.getElementById(\'main-content\'))}">' +
            '<button class="btn btn-primary" onclick="WP.Content.showPageEditor()">+ New Page</button>' +
            '</div></div>' +
            '<div id="pages-content"><div class="loading-inline"><div class="spinner"></div></div></div>';

        try {
            const search = document.getElementById('pages-search')?.value || '';
            let url = 'sites/' + WP.currentSite.id + '/pages?page=' + WP.Content.pagesPage + '&per_page=20';
            if (search) url += '&search=' + encodeURIComponent(search);
            const result = await WP.api(url);
            const pages = result.data || result || [];
            WP.Content._renderPagesTable(pages);
        } catch (e) {
            document.getElementById('pages-content').innerHTML =
                '<p style="color:var(--red)">Failed to load pages: ' + e.message + '</p>';
        }
    },

    _renderPagesTable(pages) {
        const el = document.getElementById('pages-content');
        if (!Array.isArray(pages) || pages.length === 0) {
            el.innerHTML = '<div class="empty-state"><h3>No pages found</h3></div>';
            return;
        }

        let html = '<table class="data-table"><thead><tr>' +
            '<th>Title</th><th>Status</th><th>Template</th><th>Date</th><th>Actions</th>' +
            '</tr></thead><tbody>';

        for (const p of pages) {
            const title = WP.Content._title(p.title);
            html += '<tr>' +
                '<td><strong>' + WP.stripHtml(title) + '</strong>' +
                (p.slug ? '<div style="font-size:11px;color:var(--text-muted)">/' + p.slug + '</div>' : '') +
                '</td>' +
                '<td>' + WP.Content._statusBadge(p.status) + '</td>' +
                '<td style="font-size:12px;color:var(--text-muted)">' + (p.template || 'default') + '</td>' +
                '<td>' + WP.formatDate(p.date) + '</td>' +
                '<td style="white-space:nowrap">' +
                '<a class="btn-sm" href="' + (WP.currentSite.url || '').replace(/\/$/, '') + '/wp-admin/post.php?post=' + p.id + '&action=edit" target="_blank" style="color:var(--blue);text-decoration:none;border-color:var(--blue)" title="Edit in WP Admin">WP</a> ' +
                '<button class="btn-sm" onclick="WP.Content.viewPage(' + p.id + ')" title="View">&#128065;</button> ' +
                '<button class="btn-sm" onclick="WP.Content.showPageEditor(' + p.id + ')" title="Edit">&#9998;</button> ' +
                '<button class="btn-sm" style="color:var(--red)" onclick="WP.Content.deletePage(' + p.id + ')" title="Trash">&#128465;</button>' +
                '</td></tr>';
        }

        html += '</tbody></table>' +
            '<div class="pagination">' +
            '<button ' + (WP.Content.pagesPage <= 1 ? 'disabled' : '') + ' onclick="WP.Content.pagesPage--;WP.Content.renderPages(document.getElementById(\'main-content\'))">Prev</button>' +
            '<span class="page-info">Page ' + WP.Content.pagesPage + '</span>' +
            '<button onclick="WP.Content.pagesPage++;WP.Content.renderPages(document.getElementById(\'main-content\'))">Next</button></div>';

        el.innerHTML = html;
    },

    async viewPage(pageId) {
        try {
            const result = await WP.api('sites/' + WP.currentSite.id + '/pages/' + pageId);
            const p = result.data || result;
            const title = WP.Content._title(p.title);
            const content = WP.Content._content(p.content);

            const html = '<div class="modal-backdrop" onclick="if(event.target===this)this.remove()">' +
                '<div class="modal" style="max-width:750px">' +
                '<h3>' + WP.stripHtml(title) + '</h3>' +
                '<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;display:flex;gap:16px">' +
                '<span>' + WP.Content._statusBadge(p.status) + '</span>' +
                '<span>Template: ' + (p.template || 'default') + '</span>' +
                (p.link ? '<a href="' + p.link + '" target="_blank" style="color:var(--blue)">View on site &#8599;</a>' : '') +
                '</div>' +
                '<div style="max-height:400px;overflow-y:auto;padding:12px;background:var(--bg);border-radius:6px;font-size:13px;line-height:1.6">' +
                (content || '<em>No content</em>') + '</div>' +
                '<div class="modal-actions">' +
                '<button class="btn btn-ghost" onclick="this.closest(\'.modal-backdrop\').remove()">Close</button>' +
                '<button class="btn btn-primary" onclick="this.closest(\'.modal-backdrop\').remove();WP.Content.showPageEditor(' + pageId + ')">Edit</button>' +
                '</div></div></div>';
            document.body.insertAdjacentHTML('beforeend', html);
        } catch (e) {
            WP.toast('Failed to load page: ' + e.message, 'error');
        }
    },

    async showPageEditor(pageId) {
        let p = { title: '', content: '', status: 'draft', slug: '', template: '' };
        const isEdit = !!pageId;

        if (isEdit) {
            try {
                const result = await WP.api('sites/' + WP.currentSite.id + '/pages/' + pageId);
                const data = result.data || result;
                p = {
                    title: WP.Content._title(data.title),
                    content: data.content?.raw || WP.Content._content(data.content),
                    status: data.status || 'draft',
                    slug: data.slug || '',
                    template: data.template || '',
                };
            } catch (e) {
                WP.toast('Failed to load page: ' + e.message, 'error');
                return;
            }
        }

        const html = '<div class="modal-backdrop" onclick="if(event.target===this)this.remove()">' +
            '<div class="modal" style="max-width:700px">' +
            '<h3>' + (isEdit ? 'Edit Page' : 'New Page') + '</h3>' +
            '<div class="form-group"><label>Title</label>' +
            '<input type="text" class="form-input" id="page-title" value="' + WP.stripHtml(p.title).replace(/"/g, '&quot;') + '"></div>' +
            '<div class="form-group"><label>Slug</label>' +
            '<input type="text" class="form-input" id="page-slug" value="' + (p.slug || '') + '" placeholder="auto-generated"></div>' +
            '<div class="form-group"><label>Content (HTML)</label>' +
            '<textarea class="form-input" id="page-content" rows="10" style="font-family:monospace;font-size:12px">' + WP.stripHtml(p.content) + '</textarea></div>' +
            '<div class="form-row">' +
            '<div class="form-group"><label>Status</label>' +
            '<select class="form-input" id="page-status">' +
            '<option value="draft"' + (p.status === 'draft' ? ' selected' : '') + '>Draft</option>' +
            '<option value="publish"' + (p.status === 'publish' ? ' selected' : '') + '>Published</option>' +
            '<option value="pending"' + (p.status === 'pending' ? ' selected' : '') + '>Pending Review</option>' +
            '<option value="private"' + (p.status === 'private' ? ' selected' : '') + '>Private</option>' +
            '</select></div>' +
            '<div class="form-group"><label>Template</label>' +
            '<input type="text" class="form-input" id="page-template" value="' + (p.template || '') + '" placeholder="default"></div>' +
            '</div>' +
            '<div class="modal-actions">' +
            '<button class="btn btn-ghost" onclick="this.closest(\'.modal-backdrop\').remove()">Cancel</button>' +
            '<button class="btn btn-primary" onclick="WP.Content.savePage(' + (pageId || 'null') + ')">' + (isEdit ? 'Save' : 'Create') + '</button>' +
            '</div></div></div>';
        document.body.insertAdjacentHTML('beforeend', html);
    },

    async savePage(pageId) {
        const body = {
            title: document.getElementById('page-title').value,
            content: document.getElementById('page-content').value,
            status: document.getElementById('page-status').value,
        };
        const slug = document.getElementById('page-slug').value.trim();
        if (slug) body.slug = slug;
        const template = document.getElementById('page-template').value.trim();
        if (template) body.template = template;

        if (!body.title) { WP.toast('Title is required', 'error'); return; }

        try {
            if (pageId) {
                await WP.api('sites/' + WP.currentSite.id + '/pages/' + pageId, { method: 'PUT', body });
                WP.toast('Page updated');
            } else {
                await WP.api('sites/' + WP.currentSite.id + '/pages', { method: 'POST', body });
                WP.toast('Page created');
            }
            document.querySelector('.modal-backdrop')?.remove();
            WP.Content.renderPages(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Save failed: ' + e.message, 'error');
        }
    },

    async deletePage(pageId) {
        if (!confirm('Move this page to trash?')) return;
        try {
            await WP.api('sites/' + WP.currentSite.id + '/pages/' + pageId, { method: 'DELETE' });
            WP.toast('Page trashed');
            WP.Content.renderPages(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Delete failed: ' + e.message, 'error');
        }
    },

    // ══════════════════════════════════════════════════
    //  MEDIA
    // ══════════════════════════════════════════════════

    async renderMedia(main) {
        if (!WP.requireSite(main)) return;

        main.innerHTML = '<div class="main-header">' +
            '<h2>Media — ' + WP.currentSite.name + '</h2>' +
            '<div style="display:flex;gap:8px">' +
            '<input type="text" class="form-input" id="media-search" placeholder="Search media..." style="width:200px" onkeydown="if(event.key===\'Enter\'){WP.Content.mediaPage=1;WP.Content.renderMedia(document.getElementById(\'main-content\'))}">' +
            '<select class="form-input" id="media-type" style="width:120px" onchange="WP.Content.mediaPage=1;WP.Content.renderMedia(document.getElementById(\'main-content\'))">' +
            '<option value="">All Types</option><option value="image">Images</option><option value="video">Video</option><option value="audio">Audio</option><option value="application">Documents</option>' +
            '</select>' +
            '</div></div>' +
            '<div id="media-content"><div class="loading-inline"><div class="spinner"></div></div></div>';

        try {
            const search = document.getElementById('media-search')?.value || '';
            const mediaType = document.getElementById('media-type')?.value || '';
            let url = 'sites/' + WP.currentSite.id + '/media?page=' + WP.Content.mediaPage + '&per_page=24';
            if (search) url += '&search=' + encodeURIComponent(search);
            if (mediaType) url += '&media_type=' + mediaType;
            const result = await WP.api(url);
            const items = result.data || result || [];
            WP.Content._renderMediaGrid(items);
        } catch (e) {
            document.getElementById('media-content').innerHTML =
                '<p style="color:var(--red)">Failed to load media: ' + e.message + '</p>';
        }
    },

    _renderMediaGrid(items) {
        const el = document.getElementById('media-content');
        if (!Array.isArray(items) || items.length === 0) {
            el.innerHTML = '<div class="empty-state"><div class="empty-icon">&#128247;</div><h3>No media found</h3></div>';
            return;
        }

        let html = '<div class="card-grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">';

        for (const m of items) {
            const title = WP.Content._title(m.title) || 'Untitled';
            const thumb = m.media_details?.sizes?.thumbnail?.source_url || m.source_url || '';
            const isImage = (m.mime_type || '').startsWith('image/');

            html += '<div class="card media-card" style="padding:0;overflow:hidden;cursor:pointer" onclick="WP.Content.showMediaDetail(' + m.id + ')">';
            if (isImage && thumb) {
                html += '<img src="' + thumb + '" style="width:100%;height:140px;object-fit:cover" alt="' + WP.stripHtml(title) + '" onerror="this.outerHTML=\'<div style=\\\'height:140px;background:var(--bg);display:flex;align-items:center;justify-content:center;color:var(--text-muted)\\\'>No preview</div>\'">';
            } else {
                const icon = (m.mime_type || '').startsWith('video/') ? '&#127909;' :
                             (m.mime_type || '').startsWith('audio/') ? '&#127925;' : '&#128196;';
                html += '<div style="height:140px;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:36px">' + icon + '</div>';
            }
            html += '<div style="padding:10px">' +
                '<div style="font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + WP.stripHtml(title) + '</div>' +
                '<div style="font-size:11px;color:var(--text-muted);display:flex;justify-content:space-between">' +
                '<span>' + (m.mime_type || '') + '</span>' +
                (m.media_details?.filesize ? '<span>' + WP.Automation._formatBytes(m.media_details.filesize) + '</span>' : '') +
                '</div></div></div>';
        }

        html += '</div>' +
            '<div class="pagination">' +
            '<button ' + (WP.Content.mediaPage <= 1 ? 'disabled' : '') + ' onclick="WP.Content.mediaPage--;WP.Content.renderMedia(document.getElementById(\'main-content\'))">Prev</button>' +
            '<span class="page-info">Page ' + WP.Content.mediaPage + '</span>' +
            '<button onclick="WP.Content.mediaPage++;WP.Content.renderMedia(document.getElementById(\'main-content\'))">Next</button></div>';

        el.innerHTML = html;
    },

    async showMediaDetail(mediaId) {
        try {
            const result = await WP.api('sites/' + WP.currentSite.id + '/media/' + mediaId);
            const m = result.data || result;
            const title = WP.Content._title(m.title);
            const caption = WP.Content._content(m.caption);
            const desc = WP.Content._content(m.description);
            const alt = m.alt_text || '';
            const src = m.source_url || '';
            const isImage = (m.mime_type || '').startsWith('image/');
            const dims = m.media_details ? (m.media_details.width + ' x ' + m.media_details.height) : '';
            const filesize = m.media_details?.filesize ? WP.Automation._formatBytes(m.media_details.filesize) : '';

            const html = '<div class="modal-backdrop" onclick="if(event.target===this)this.remove()">' +
                '<div class="modal" style="max-width:700px">' +
                '<h3>Media Details</h3>' +
                (isImage && src ? '<img src="' + src + '" style="width:100%;max-height:300px;object-fit:contain;border-radius:6px;margin-bottom:16px;background:var(--bg)">' : '') +
                '<div style="font-size:12px;color:var(--text-muted);margin-bottom:16px;display:flex;gap:16px;flex-wrap:wrap">' +
                '<span>' + (m.mime_type || '') + '</span>' +
                (dims ? '<span>' + dims + '</span>' : '') +
                (filesize ? '<span>' + filesize + '</span>' : '') +
                '<span>' + WP.formatDate(m.date) + '</span>' +
                '</div>' +
                '<div class="form-group"><label>Title</label>' +
                '<input type="text" class="form-input" id="media-title" value="' + WP.stripHtml(title).replace(/"/g, '&quot;') + '"></div>' +
                '<div class="form-group"><label>Alt Text</label>' +
                '<input type="text" class="form-input" id="media-alt" value="' + WP.stripHtml(alt).replace(/"/g, '&quot;') + '"></div>' +
                '<div class="form-group"><label>Caption</label>' +
                '<input type="text" class="form-input" id="media-caption" value="' + WP.stripHtml(caption).replace(/"/g, '&quot;') + '"></div>' +
                '<div class="form-group"><label>Description</label>' +
                '<textarea class="form-input" id="media-desc" rows="2">' + WP.stripHtml(desc) + '</textarea></div>' +
                '<div class="modal-actions">' +
                (src ? '<a href="' + src + '" download class="btn btn-ghost" style="text-decoration:none">Download</a>' : '') +
                '<button class="btn btn-ghost" style="color:var(--red)" onclick="this.closest(\'.modal-backdrop\').remove();WP.Content.deleteMedia(' + mediaId + ')">Delete</button>' +
                '<button class="btn btn-ghost" onclick="this.closest(\'.modal-backdrop\').remove()">Cancel</button>' +
                '<button class="btn btn-primary" onclick="WP.Content.saveMedia(' + mediaId + ')">Save</button>' +
                '</div></div></div>';
            document.body.insertAdjacentHTML('beforeend', html);
        } catch (e) {
            WP.toast('Failed to load media: ' + e.message, 'error');
        }
    },

    async saveMedia(mediaId) {
        const body = {
            title: document.getElementById('media-title').value,
            alt_text: document.getElementById('media-alt').value,
            caption: document.getElementById('media-caption').value,
            description: document.getElementById('media-desc').value,
        };
        try {
            await WP.api('sites/' + WP.currentSite.id + '/media/' + mediaId, { method: 'PUT', body });
            WP.toast('Media updated');
            document.querySelector('.modal-backdrop')?.remove();
            WP.Content.renderMedia(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Save failed: ' + e.message, 'error');
        }
    },

    async deleteMedia(mediaId) {
        if (!confirm('Permanently delete this media item?')) return;
        try {
            await WP.api('sites/' + WP.currentSite.id + '/media/' + mediaId, { method: 'DELETE' });
            WP.toast('Media deleted');
            WP.Content.renderMedia(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Delete failed: ' + e.message, 'error');
        }
    },
};
