/* OP WordPress — AI Agents: builder & runner for site-specific automation */

WP.Agents = {

    // Agents saved per site (keyed by site id)
    _agents: {},

    // Agent template definitions
    _templates: [
        {
            id: 'article-writer',
            icon: '\u270D\uFE0F',
            name: 'Article Writer',
            tagline: 'AI writes and publishes articles on your site',
            description: 'Generate fully written blog posts based on a topic or keyword. The agent writes in your chosen tone, targets a word count, and can auto-publish or save as draft.',
            color: 'var(--accent)',
            configFields: [
                { key: 'topic',       label: 'Topic / Keyword',     type: 'text',   placeholder: 'e.g. 10 tips for better sleep', required: true },
                { key: 'tone',        label: 'Writing Tone',         type: 'select', options: ['Professional', 'Casual', 'Educational', 'Conversational', 'Persuasive'] },
                { key: 'word_count',  label: 'Target Word Count',    type: 'select', options: ['500', '800', '1200', '1500', '2000', '2500'] },
                { key: 'category',    label: 'Post Category',        type: 'text',   placeholder: 'e.g. Health & Wellness' },
                { key: 'status',      label: 'Publish Status',       type: 'select', options: ['Draft', 'Publish immediately'] },
                { key: 'schedule',    label: 'Run Schedule',         type: 'select', options: ['Manual only', 'Daily', 'Weekly', 'Monthly'] },
            ],
        },
        {
            id: 'auto-commenter',
            icon: '\uD83D\uDCAC',
            name: 'Auto Commenter',
            tagline: 'AI responds to comments left on your posts',
            description: 'Automatically reply to new comments on your WordPress posts. The agent reads each comment, generates a contextual and on-brand reply, and posts it as the site admin.',
            color: 'var(--green)',
            configFields: [
                { key: 'style',       label: 'Reply Style',          type: 'select', options: ['Friendly & welcoming', 'Professional', 'Supportive', 'Brief acknowledgement', 'Detailed & helpful'] },
                { key: 'scope',       label: 'Apply To',             type: 'select', options: ['All posts', 'Posts published in last 30 days', 'Posts published in last 7 days'] },
                { key: 'delay',       label: 'Reply After',          type: 'select', options: ['5 minutes', '30 minutes', '1 hour', '4 hours', '24 hours'] },
                { key: 'skip_spam',   label: 'Skip flagged spam',    type: 'toggle', default: true },
                { key: 'sign_off',    label: 'Sign-off Name',        type: 'text',   placeholder: 'e.g. The Team, Sarah from Support' },
                { key: 'schedule',    label: 'Run Schedule',         type: 'select', options: ['Always on', 'Weekdays only', 'Manual only'] },
            ],
        },
        {
            id: 'seo-optimizer',
            icon: '\uD83D\uDD0D',
            name: 'SEO Optimizer',
            tagline: 'Scans posts and improves meta, titles, and readability',
            description: 'Audits your existing posts for missing meta descriptions, weak title tags, and readability issues. Can auto-apply fixes or present suggestions for review.',
            color: 'var(--orange)',
            configFields: [
                { key: 'mode',        label: 'Action Mode',          type: 'select', options: ['Suggest only (report)', 'Auto-fix safe issues', 'Auto-fix all issues'] },
                { key: 'scope',       label: 'Posts to Audit',       type: 'select', options: ['All posts', 'Posts without meta descriptions', 'Posts modified in last 30 days', 'Posts with low readability'] },
                { key: 'focus_key',   label: 'Focus Keyword',        type: 'text',   placeholder: 'Optional — target keyword for the audit' },
                { key: 'schedule',    label: 'Run Schedule',         type: 'select', options: ['Manual only', 'Weekly', 'Monthly'] },
            ],
        },
        {
            id: 'broken-link-scanner',
            icon: '\uD83D\uDD17',
            name: 'Broken Link Scanner',
            tagline: 'Finds and reports dead links across all your content',
            description: 'Crawls all posts and pages looking for 404s, redirects, and unreachable external links. Generates a report and optionally flags posts for editing.',
            color: '#e17055',
            configFields: [
                { key: 'scope',       label: 'Scan Scope',           type: 'select', options: ['All posts & pages', 'Posts only', 'Pages only', 'Recently published (30 days)'] },
                { key: 'report',      label: 'Report Format',        type: 'select', options: ['In-app report', 'Email report', 'Both'] },
                { key: 'flag_posts',  label: 'Flag affected posts',  type: 'toggle', default: true },
                { key: 'schedule',    label: 'Run Schedule',         type: 'select', options: ['Manual only', 'Weekly', 'Monthly'] },
            ],
        },
    ],

    // ── Main render ─────────────────────────────────────────────────────────

    render(main) {
        if (!WP.requireSite(main)) return;
        const siteId = WP.currentSite.id;
        if (!WP.Agents._agents[siteId]) WP.Agents._agents[siteId] = [];
        WP.Agents._renderPage(main);
    },

    _renderPage(main) {
        const siteId = WP.currentSite.id;
        const myAgents = WP.Agents._agents[siteId] || [];

        main.innerHTML = `
            <div class="main-header">
                <h2>Agents — ${WP.currentSite.name}</h2>
                <div style="display:flex;gap:8px;align-items:center">
                    <span style="font-size:12px;color:var(--text-muted)">AI automation for this site</span>
                </div>
            </div>

            ${myAgents.length > 0 ? WP.Agents._renderMyAgents(myAgents) : ''}

            <div class="agents-section-label">
                <span>Available Agents</span>
                <span style="font-size:12px;color:var(--text-muted);font-weight:400">Click any agent to configure and add it to this site</span>
            </div>
            <div class="agent-template-grid" id="agent-template-grid">
                ${WP.Agents._templates.map(t => WP.Agents._renderTemplateCard(t)).join('')}
            </div>

            <div id="agent-config-panel"></div>
        `;
    },

    _renderMyAgents(agents) {
        let html = '<div class="agents-section-label"><span>Active Agents</span></div>';
        html += '<div class="my-agents-list">';
        for (const a of agents) {
            const tpl = WP.Agents._templates.find(t => t.id === a.templateId);
            const statusClass = a.status === 'running' ? 'agent-status-running' :
                                a.status === 'idle'    ? 'agent-status-idle' :
                                                         'agent-status-off';
            const statusLabel = a.status === 'running' ? 'Running' :
                                a.status === 'idle'    ? 'Idle' : 'Off';
            html += `
                <div class="my-agent-row" id="agent-row-${a.id}">
                    <div class="my-agent-icon" style="background:${tpl?.color || 'var(--accent)'}22;color:${tpl?.color || 'var(--accent)'}">${tpl?.icon || '\uD83E\uDD16'}</div>
                    <div class="my-agent-info">
                        <div class="my-agent-name">${WP.stripHtml(a.name)}</div>
                        <div class="my-agent-meta">${tpl?.name || ''} &middot; ${a.schedule || 'Manual'} &middot; Last run: ${a.lastRun || 'Never'}</div>
                    </div>
                    <span class="agent-status-badge ${statusClass}">${statusLabel}</span>
                    <div class="my-agent-actions">
                        <button class="btn-sm btn-primary" onclick="WP.Agents.runAgent('${a.id}')">&#9654; Run</button>
                        <button class="btn-sm" onclick="WP.Agents.editAgent('${a.id}')">Edit</button>
                        <button class="btn-sm btn-ghost" onclick="WP.Agents.deleteAgent('${a.id}')">Remove</button>
                    </div>
                </div>
            `;
        }
        html += '</div>';
        return html;
    },

    _renderTemplateCard(tpl) {
        return `
            <div class="agent-template-card" onclick="WP.Agents.openConfig('${tpl.id}')">
                <div class="atc-icon" style="background:${tpl.color}22;color:${tpl.color}">${tpl.icon}</div>
                <div class="atc-body">
                    <div class="atc-name">${tpl.name}</div>
                    <div class="atc-tagline">${tpl.tagline}</div>
                    <div class="atc-desc">${tpl.description}</div>
                </div>
                <div class="atc-footer">
                    <button class="btn btn-primary" style="width:100%" onclick="event.stopPropagation();WP.Agents.openConfig('${tpl.id}')">Configure &amp; Add</button>
                </div>
            </div>
        `;
    },

    // ── Config panel ────────────────────────────────────────────────────────

    openConfig(templateId, existingAgent) {
        const tpl = WP.Agents._templates.find(t => t.id === templateId);
        if (!tpl) return;

        const panel = document.getElementById('agent-config-panel');
        if (!panel) return;

        const vals = existingAgent?.config || {};
        const isEdit = !!existingAgent;

        let fieldsHtml = '';
        for (const f of tpl.configFields) {
            fieldsHtml += '<div class="agent-field">';
            fieldsHtml += '<label class="agent-field-label">' + f.label + (f.required ? ' <span style="color:var(--red)">*</span>' : '') + '</label>';

            if (f.type === 'text') {
                fieldsHtml += '<input class="form-input" id="acf-' + f.key + '" type="text" placeholder="' + (f.placeholder || '') + '" value="' + WP.stripHtml(vals[f.key] || '') + '">';
            } else if (f.type === 'select') {
                fieldsHtml += '<select class="form-input" id="acf-' + f.key + '">';
                for (const opt of f.options) {
                    const sel = (vals[f.key] || f.options[0]) === opt ? ' selected' : '';
                    fieldsHtml += '<option value="' + opt + '"' + sel + '>' + opt + '</option>';
                }
                fieldsHtml += '</select>';
            } else if (f.type === 'toggle') {
                const checked = vals[f.key] !== undefined ? vals[f.key] : (f.default || false);
                fieldsHtml += '<label class="agent-toggle"><input type="checkbox" id="acf-' + f.key + '"' + (checked ? ' checked' : '') + '><span class="agent-toggle-track"></span></label>';
            }

            fieldsHtml += '</div>';
        }

        panel.style.display = '';
        panel.innerHTML = `
            <div class="agent-config-panel">
                <div class="acp-header">
                    <div class="acp-title-row">
                        <div class="acp-icon" style="background:${tpl.color}22;color:${tpl.color}">${tpl.icon}</div>
                        <div>
                            <div class="acp-name">${isEdit ? 'Edit — ' : ''}${tpl.name}</div>
                            <div class="acp-sub">${tpl.tagline}</div>
                        </div>
                    </div>
                    <button class="acp-close" onclick="WP.Agents.closeConfig()">&times;</button>
                </div>

                <div class="acp-body">
                    <div class="agent-field">
                        <label class="agent-field-label">Agent Name <span style="color:var(--red)">*</span></label>
                        <input class="form-input" id="acf-agent-name" type="text" placeholder="e.g. Weekly Health Articles" value="${WP.stripHtml(existingAgent?.name || '')}">
                    </div>
                    ${fieldsHtml}
                </div>

                <div class="acp-footer">
                    <button class="btn btn-ghost" onclick="WP.Agents.closeConfig()">Cancel</button>
                    <button class="btn btn-ghost" onclick="WP.Agents.testRun('${tpl.id}')">&#9654; Test Run</button>
                    <button class="btn btn-primary" onclick="WP.Agents.${isEdit ? 'saveEdit(\'' + existingAgent.id + '\',\'' + templateId + '\')' : 'addAgent(\'' + templateId + '\')'}">${isEdit ? 'Save Changes' : 'Add Agent'}</button>
                </div>
            </div>
        `;

        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    closeConfig() {
        const panel = document.getElementById('agent-config-panel');
        if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
    },

    _readConfig(tpl) {
        const config = {};
        for (const f of tpl.configFields) {
            const el = document.getElementById('acf-' + f.key);
            if (!el) continue;
            config[f.key] = f.type === 'toggle' ? el.checked : el.value;
        }
        return config;
    },

    // ── Add / Edit / Delete ──────────────────────────────────────────────────

    addAgent(templateId) {
        const tpl = WP.Agents._templates.find(t => t.id === templateId);
        if (!tpl) return;

        const nameEl = document.getElementById('acf-agent-name');
        const name = nameEl?.value.trim();
        if (!name) { WP.toast('Give your agent a name', 'error'); nameEl?.focus(); return; }

        const config = WP.Agents._readConfig(tpl);

        const siteId = WP.currentSite.id;
        const agent = {
            id: 'ag-' + Date.now(),
            templateId,
            name,
            config,
            schedule: config.schedule || 'Manual only',
            status: 'idle',
            lastRun: null,
        };

        if (!WP.Agents._agents[siteId]) WP.Agents._agents[siteId] = [];
        WP.Agents._agents[siteId].push(agent);

        WP.toast(name + ' agent added!');
        WP.Agents.closeConfig();
        WP.Agents._renderPage(document.getElementById('main-content'));
    },

    editAgent(agentId) {
        const siteId = WP.currentSite.id;
        const agent = (WP.Agents._agents[siteId] || []).find(a => a.id === agentId);
        if (!agent) return;
        WP.Agents.openConfig(agent.templateId, agent);
    },

    saveEdit(agentId, templateId) {
        const tpl = WP.Agents._templates.find(t => t.id === templateId);
        if (!tpl) return;

        const nameEl = document.getElementById('acf-agent-name');
        const name = nameEl?.value.trim();
        if (!name) { WP.toast('Agent name is required', 'error'); return; }

        const siteId = WP.currentSite.id;
        const agents = WP.Agents._agents[siteId] || [];
        const agent = agents.find(a => a.id === agentId);
        if (!agent) return;

        agent.name = name;
        agent.config = WP.Agents._readConfig(tpl);
        agent.schedule = agent.config.schedule || 'Manual only';

        WP.toast('Agent updated');
        WP.Agents.closeConfig();
        WP.Agents._renderPage(document.getElementById('main-content'));
    },

    deleteAgent(agentId) {
        if (!confirm('Remove this agent?')) return;
        const siteId = WP.currentSite.id;
        WP.Agents._agents[siteId] = (WP.Agents._agents[siteId] || []).filter(a => a.id !== agentId);
        WP.toast('Agent removed');
        WP.Agents._renderPage(document.getElementById('main-content'));
    },

    // ── Run ─────────────────────────────────────────────────────────────────

    async runAgent(agentId) {
        const siteId = WP.currentSite.id;
        const agent = (WP.Agents._agents[siteId] || []).find(a => a.id === agentId);
        if (!agent) return;

        const tpl = WP.Agents._templates.find(t => t.id === agent.templateId);
        agent.status = 'running';
        WP.Agents._updateAgentRow(agent, tpl);
        WP.toast('Running ' + agent.name + '...');

        // Simulate agent execution
        await new Promise(r => setTimeout(r, 2800 + Math.random() * 1400));

        agent.status = 'idle';
        agent.lastRun = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        WP.Agents._updateAgentRow(agent, tpl);
        WP.toast(agent.name + ' completed', 'success');
    },

    async testRun(templateId) {
        const tpl = WP.Agents._templates.find(t => t.id === templateId);
        if (!tpl) return;

        WP.toast('Test running ' + tpl.name + '...');
        const footer = document.querySelector('.acp-footer');
        const testBtn = footer?.querySelector('button:nth-child(2)');
        if (testBtn) { testBtn.disabled = true; testBtn.textContent = '\u23F3 Running...'; }

        await new Promise(r => setTimeout(r, 3000));

        if (testBtn) { testBtn.disabled = false; testBtn.innerHTML = '&#9654; Test Run'; }
        WP.toast('Test run complete — agent is ready to use', 'success');
    },

    _updateAgentRow(agent, tpl) {
        const row = document.getElementById('agent-row-' + agent.id);
        if (!row) return;
        const badge = row.querySelector('.agent-status-badge');
        if (badge) {
            badge.className = 'agent-status-badge ' + (agent.status === 'running' ? 'agent-status-running' : 'agent-status-idle');
            badge.textContent = agent.status === 'running' ? 'Running' : 'Idle';
        }
        const meta = row.querySelector('.my-agent-meta');
        if (meta) {
            meta.textContent = (tpl?.name || '') + ' \u00b7 ' + (agent.schedule || 'Manual') + ' \u00b7 Last run: ' + (agent.lastRun || 'Never');
        }
    },
};
