/* OP WordPress — AI Agents: live progress, tabbed results, actionable reports */

WP.Agents = {

    // Currently polling scan
    _pollTimer: null,
    _activeScanId: null,

    // Agent template definitions
    _templates: [
        {
            id: 'article-writer',
            icon: '\u270D\uFE0F',
            name: 'Article Writer',
            tagline: 'AI writes and publishes articles on your site',
            description: 'Generate fully written blog posts based on a topic or keyword.',
            color: 'var(--accent)',
            implemented: false,
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
            description: 'Automatically reply to new comments on your WordPress posts.',
            color: 'var(--green)',
            implemented: false,
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
            description: 'Audits your existing posts for missing meta, weak titles, and readability issues.',
            color: 'var(--orange)',
            implemented: false,
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
            description: 'Crawls all posts and pages looking for 404s, redirects, and unreachable external links.',
            color: '#e17055',
            implemented: true,
            configFields: [
                { key: 'scope',         label: 'Scan Scope',           type: 'select', options: ['All posts & pages', 'Posts only', 'Pages only', 'Recently published (30 days)'] },
                { key: 'report',        label: 'Report Format',        type: 'select', options: ['In-app report', 'Email report', 'Both'] },
                { key: 'report_email',  label: 'Report Email',         type: 'text',   placeholder: 'e.g. you@example.com (for email reports)', showIf: { key: 'report', values: ['Email report', 'Both'] } },
                { key: 'flag_posts',    label: 'Flag affected posts',  type: 'toggle', default: true },
                { key: 'schedule',      label: 'Run Schedule',         type: 'select', options: ['Manual only', 'Weekly', 'Monthly'] },
            ],
        },
        {
            id: 'performance-auditor',
            icon: '\u26A1',
            name: 'Performance Auditor',
            tagline: 'Diagnoses slow load times and provides actionable speed fixes',
            description: 'Audits Core Web Vitals, server performance, images, caching, and database health. Produces a prioritized report with fix recommendations.',
            color: '#00b894',
            implemented: true,
            configFields: [
                { key: 'scope',         label: 'Audit Scope',          type: 'select', options: ['Complete (all pages)', 'Thorough (up to 20 pages)', 'Essential (homepage + 5 key pages)', 'Homepage only'] },
                { key: 'strategy',      label: 'Test Device',          type: 'select', options: ['Mobile', 'Desktop', 'Both'] },
                { key: 'report',        label: 'Report Format',        type: 'select', options: ['In-app report', 'Email report', 'Both'] },
                { key: 'report_email',  label: 'Report Email',         type: 'text',   placeholder: 'e.g. you@example.com', showIf: { key: 'report', values: ['Email report', 'Both'] } },
                { key: 'schedule',      label: 'Run Schedule',         type: 'select', options: ['Manual only', 'Weekly', 'Monthly'] },
            ],
        },
    ],

    // ── Main render ─────────────────────────────────────────────────────────

    async render(main) {
        if (!WP.requireSite(main)) return;
        main.innerHTML = '<div class="loading">Loading agents...</div>';
        WP.Agents._stopPolling();
        await WP.Agents._renderPage(main);
    },

    async _renderPage(main) {
        const siteId = WP.currentSite.id;
        let myAgents = [];
        try {
            myAgents = await WP.api(`sites/${siteId}/agents`);
        } catch (e) {
            console.error('Failed to load agents:', e);
        }

        main.innerHTML = `
            <div class="main-header">
                <h2>Agents \u2014 ${WP.currentSite.name}</h2>
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
            <div id="agent-results-panel"></div>
        `;
    },

    _renderMyAgents(agents) {
        let html = '<div class="agents-section-label"><span>Active Agents</span></div>';
        html += '<div class="my-agents-list">';
        for (const a of agents) {
            const tpl = WP.Agents._templates.find(t => t.id === a.template_id);
            const statusClass = a.status === 'running' ? 'agent-status-running' :
                                a.status === 'idle'    ? 'agent-status-idle' :
                                a.status === 'failed'  ? 'agent-status-off' :
                                                         'agent-status-off';
            const statusLabel = a.status === 'running' ? 'Running' :
                                a.status === 'idle'    ? 'Idle' :
                                a.status === 'failed'  ? 'Failed' : 'Off';
            const lastRun = a.last_run_at
                ? new Date(a.last_run_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                : 'Never';
            const scheduleLabel = a.schedule === 'manual' ? 'Manual' : a.schedule;
            html += `
                <div class="my-agent-row" id="agent-row-${a.id}">
                    <div class="my-agent-icon" style="background:${tpl?.color || 'var(--accent)'}22;color:${tpl?.color || 'var(--accent)'}">${tpl?.icon || '\uD83E\uDD16'}</div>
                    <div class="my-agent-info">
                        <div class="my-agent-name">${WP.stripHtml(a.name)}</div>
                        <div class="my-agent-meta">${tpl?.name || a.template_id} &middot; ${scheduleLabel} &middot; Last run: ${lastRun}</div>
                    </div>
                    <span class="agent-status-badge ${statusClass}">${statusLabel}</span>
                    <div class="my-agent-actions">
                        <button class="btn-sm btn-primary" onclick="WP.Agents.runAgent('${a.id}')" ${a.status === 'running' ? 'disabled' : ''}>&#9654; Run</button>
                        <button class="btn-sm" onclick="WP.Agents.viewScans('${a.id}')">Results</button>
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
        const badge = tpl.implemented ? '' : '<span style="font-size:10px;background:var(--bg-hover);padding:2px 6px;border-radius:4px;margin-left:6px">Coming Soon</span>';
        return `
            <div class="agent-template-card" onclick="WP.Agents.openConfig('${tpl.id}')">
                <div class="atc-icon" style="background:${tpl.color}22;color:${tpl.color}">${tpl.icon}</div>
                <div class="atc-body">
                    <div class="atc-name">${tpl.name}${badge}</div>
                    <div class="atc-tagline">${tpl.tagline}</div>
                    <div class="atc-desc">${tpl.description}</div>
                </div>
                <div class="atc-footer">
                    <button class="btn btn-primary" style="width:100%" onclick="event.stopPropagation();WP.Agents.openConfig('${tpl.id}')">${tpl.implemented ? 'Configure & Add' : 'Coming Soon'}</button>
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
            const hidden = f.showIf ? !f.showIf.values.includes(vals[f.showIf.key] || tpl.configFields.find(x => x.key === f.showIf.key)?.options?.[0] || '') : false;
            fieldsHtml += '<div class="agent-field" id="acf-wrap-' + f.key + '" style="' + (hidden ? 'display:none' : '') + '">';
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
                            <div class="acp-name">${isEdit ? 'Edit \u2014 ' : ''}${tpl.name}</div>
                            <div class="acp-sub">${tpl.tagline}</div>
                        </div>
                    </div>
                    <button class="acp-close" onclick="WP.Agents.closeConfig()">&times;</button>
                </div>

                <div class="acp-body">
                    <div class="agent-field">
                        <label class="agent-field-label">Agent Name <span style="color:var(--red)">*</span></label>
                        <input class="form-input" id="acf-agent-name" type="text" placeholder="e.g. Weekly Link Check" value="${WP.stripHtml(existingAgent?.name || '')}">
                    </div>
                    ${fieldsHtml}
                </div>

                <div class="acp-footer">
                    <button class="btn btn-ghost" onclick="WP.Agents.closeConfig()">Cancel</button>
                    <button class="btn btn-primary" onclick="WP.Agents.${isEdit ? 'saveEdit(\'' + existingAgent.id + '\',\'' + templateId + '\')' : 'addAgent(\'' + templateId + '\')'}">${isEdit ? 'Save Changes' : 'Add Agent'}</button>
                </div>
            </div>
        `;

        // Wire up showIf listeners
        for (const f of tpl.configFields) {
            if (!f.showIf) continue;
            const controller = document.getElementById('acf-' + f.showIf.key);
            if (!controller) continue;
            controller.addEventListener('change', () => {
                const wrap = document.getElementById('acf-wrap-' + f.key);
                if (!wrap) return;
                wrap.style.display = f.showIf.values.includes(controller.value) ? '' : 'none';
            });
        }

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

    _mapSchedule(scheduleLabel) {
        const map = { 'Manual only': 'manual', 'Weekly': 'weekly', 'Monthly': 'monthly', 'Daily': 'daily' };
        return map[scheduleLabel] || 'manual';
    },

    // ── Add / Edit / Delete ──────────────────────────────────────────────────

    async addAgent(templateId) {
        const tpl = WP.Agents._templates.find(t => t.id === templateId);
        if (!tpl) return;

        const nameEl = document.getElementById('acf-agent-name');
        const name = nameEl?.value.trim();
        if (!name) { WP.toast('Give your agent a name', 'error'); nameEl?.focus(); return; }

        const agentConfig = WP.Agents._readConfig(tpl);
        const schedule = WP.Agents._mapSchedule(agentConfig.schedule || 'Manual only');

        const siteId = WP.currentSite.id;
        try {
            await WP.api(`sites/${siteId}/agents`, {
                method: 'POST',
                body: {
                    template_id: templateId,
                    name,
                    config: agentConfig,
                    schedule,
                },
            });
            WP.toast(name + ' agent added!');
            WP.Agents.closeConfig();
            WP.Agents._renderPage(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Failed to add agent: ' + (e.message || e), 'error');
        }
    },

    async editAgent(agentId) {
        const siteId = WP.currentSite.id;
        try {
            const agent = await WP.api(`sites/${siteId}/agents/${agentId}`);
            WP.Agents.openConfig(agent.template_id, agent);
        } catch (e) {
            WP.toast('Failed to load agent', 'error');
        }
    },

    async saveEdit(agentId, templateId) {
        const tpl = WP.Agents._templates.find(t => t.id === templateId);
        if (!tpl) return;

        const nameEl = document.getElementById('acf-agent-name');
        const name = nameEl?.value.trim();
        if (!name) { WP.toast('Agent name is required', 'error'); return; }

        const agentConfig = WP.Agents._readConfig(tpl);
        const schedule = WP.Agents._mapSchedule(agentConfig.schedule || 'Manual only');

        const siteId = WP.currentSite.id;
        try {
            await WP.api(`sites/${siteId}/agents/${agentId}`, {
                method: 'PATCH',
                body: { name, config: agentConfig, schedule },
            });
            WP.toast('Agent updated');
            WP.Agents.closeConfig();
            WP.Agents._renderPage(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Failed to update agent: ' + (e.message || e), 'error');
        }
    },

    async deleteAgent(agentId) {
        if (!confirm('Remove this agent and all its scan history?')) return;
        const siteId = WP.currentSite.id;
        try {
            await WP.api(`sites/${siteId}/agents/${agentId}`, { method: 'DELETE' });
            WP.toast('Agent removed');
            WP.Agents._renderPage(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Failed to remove agent', 'error');
        }
    },

    // ── Run + Live Progress ─────────────────────────────────────────────────

    async runAgent(agentId) {
        const siteId = WP.currentSite.id;
        const btn = document.querySelector(`#agent-row-${agentId} .btn-primary`);
        if (btn) { btn.disabled = true; btn.textContent = '\u23F3 Running...'; }

        const badge = document.querySelector(`#agent-row-${agentId} .agent-status-badge`);
        if (badge) { badge.className = 'agent-status-badge agent-status-running'; badge.textContent = 'Running'; }

        try {
            await WP.api(`sites/${siteId}/agents/${agentId}/run`, { method: 'POST' });
            WP.toast('Scan started');

            // Open live progress panel immediately
            WP.Agents._showLiveProgress(agentId, siteId);
        } catch (e) {
            WP.toast('Failed to start: ' + (e.message || e), 'error');
            if (btn) { btn.disabled = false; btn.innerHTML = '&#9654; Run'; }
            if (badge) { badge.className = 'agent-status-badge agent-status-idle'; badge.textContent = 'Idle'; }
        }
    },

    _stopPolling() {
        if (WP.Agents._pollTimer) {
            clearInterval(WP.Agents._pollTimer);
            WP.Agents._pollTimer = null;
        }
        WP.Agents._activeScanId = null;
    },

    async _showLiveProgress(agentId, siteId) {
        const panel = document.getElementById('agent-results-panel');
        if (!panel) return;
        WP.Agents._stopPolling();

        // Detect template
        let agentTemplate = 'broken-link-scanner';
        try {
            const agent = await WP.api(`sites/${siteId}/agents/${agentId}`);
            agentTemplate = agent.template_id || 'broken-link-scanner';
        } catch {}

        const isPerf = agentTemplate === 'performance-auditor';
        const progressLabel = isPerf ? 'Auditing pages... this may take a few minutes' : 'Checking links... this may take a few minutes';
        const progressTitle = isPerf ? 'Audit In Progress' : 'Scan In Progress';

        panel.style.display = '';
        panel.innerHTML = `
            <div class="agent-config-panel" style="max-width:100%">
                <div class="acp-header">
                    <div>
                        <div class="acp-name">${progressTitle}</div>
                        <div class="acp-sub">${progressLabel}</div>
                    </div>
                </div>
                <div class="acp-body" id="live-progress-body" style="padding:20px">
                    <div style="text-align:center;padding:20px">
                        <div class="agent-status-badge agent-status-running" style="font-size:14px;padding:6px 16px;margin-bottom:12px">Initializing...</div>
                    </div>
                </div>
            </div>
        `;
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

        // Find the running record for this agent
        const endpoint = isPerf ? 'audits' : 'scans';
        let recordId = null;
        let attempts = 0;
        const findRecord = async () => {
            try {
                const records = await WP.api(`sites/${siteId}/agents/${agentId}/${endpoint}?limit=1`);
                if (records.length && records[0].status === 'running') {
                    recordId = records[0].id;
                    WP.Agents._activeScanId = recordId;
                }
            } catch {}
        };

        while (!recordId && attempts < 10) {
            await findRecord();
            if (!recordId) await new Promise(r => setTimeout(r, 1500));
            attempts++;
        }

        if (!recordId) {
            WP.Agents._pollAgentFallback(agentId, siteId, panel);
            return;
        }

        // Start polling
        const apiEndpoint = isPerf ? `audits/${recordId}` : `scans/${recordId}`;
        WP.Agents._pollTimer = setInterval(async () => {
            try {
                const record = await WP.api(apiEndpoint);
                if (isPerf) {
                    WP.Agents._updateAuditProgress(record);
                } else {
                    WP.Agents._updateLiveProgress(record);
                }

                if (record.status !== 'running') {
                    WP.Agents._stopPolling();
                    if (isPerf) {
                        WP.Agents._onAuditComplete(agentId, siteId, record);
                    } else {
                        WP.Agents._onScanComplete(agentId, siteId, record);
                    }
                }
            } catch {}
        }, 3000);
    },

    _updateLiveProgress(scan) {
        const body = document.getElementById('live-progress-body');
        if (!body) return;

        const checked = scan.checked_links || 0;
        const total = scan.total_links || 0;
        const broken = scan.results || [];
        const pct = total > 0 ? Math.round((checked / total) * 100) : 0;

        // Group broken by severity and error_type
        const byType = {};
        let brokenCount = 0, warningCount = 0;
        for (const b of broken) {
            const t = b.error_type || 'unknown';
            byType[t] = (byType[t] || 0) + 1;
            if (b.severity === 'warning') warningCount++;
            else brokenCount++;
        }

        // Sort by count desc
        const sortedTypes = Object.entries(byType).sort((a, b) => b[1] - a[1]);

        let countersHtml = '';
        if (sortedTypes.length) {
            countersHtml = '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;justify-content:center">';
            for (const [type, count] of sortedTypes) {
                const color = WP.Agents._typeColors[type] || '#6c5ce7';
                countersHtml += `<div style="background:${color}18;color:${color};padding:6px 14px;border-radius:6px;font-size:13px;font-weight:600;border:1px solid ${color}33">
                    ${type.replace(/_/g, ' ')}: ${count}
                </div>`;
            }
            countersHtml += '</div>';
        }

        const issueLabel = brokenCount > 0
            ? `${brokenCount} broken` + (warningCount > 0 ? ` + ${warningCount} warnings` : '')
            : warningCount > 0 ? `${warningCount} warnings` : '0 issues';

        body.innerHTML = `
            <div style="text-align:center">
                <div style="font-size:28px;font-weight:700;color:var(--text);margin-bottom:4px">${checked} / ${total}</div>
                <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">links checked</div>
                <div style="background:var(--bg-hover);border-radius:8px;height:10px;width:100%;max-width:400px;margin:0 auto;overflow:hidden">
                    <div style="background:var(--accent);height:100%;border-radius:8px;width:${pct}%;transition:width .3s ease"></div>
                </div>
                <div style="font-size:12px;color:var(--text-muted);margin-top:6px">${pct}% &middot; ${issueLabel} so far</div>
                ${countersHtml}
            </div>
        `;
    },

    async _pollAgentFallback(agentId, siteId, panel) {
        // Simpler fallback if we can't find the scan record
        let attempts = 0;
        WP.Agents._pollTimer = setInterval(async () => {
            attempts++;
            if (attempts > 120) { WP.Agents._stopPolling(); return; }
            try {
                const agent = await WP.api(`sites/${siteId}/agents/${agentId}`);
                if (agent.status !== 'running') {
                    WP.Agents._stopPolling();
                    WP.Agents._resetAgentRow(agentId, agent);
                    WP.toast(agent.status === 'idle' ? 'Scan completed!' : 'Scan failed', agent.status === 'idle' ? 'success' : 'error');
                    WP.Agents.viewScans(agentId);
                }
            } catch {}
        }, 5000);
    },

    _onScanComplete(agentId, siteId, scan) {
        WP.Agents._resetAgentRow(agentId, { status: 'idle' });

        if (scan.status === 'completed') {
            WP.toast('Scan completed!', 'success');
            WP.Agents.viewScanDetail(scan.id);
        } else {
            WP.toast('Scan failed', 'error');
            WP.Agents.viewScans(agentId);
        }
    },

    _resetAgentRow(agentId, agent) {
        const btn = document.querySelector(`#agent-row-${agentId} .btn-primary`);
        if (btn) { btn.disabled = false; btn.innerHTML = '&#9654; Run'; }
        const badge = document.querySelector(`#agent-row-${agentId} .agent-status-badge`);
        if (badge) {
            badge.className = 'agent-status-badge ' + (agent.status === 'idle' ? 'agent-status-idle' : 'agent-status-off');
            badge.textContent = agent.status === 'idle' ? 'Idle' : 'Failed';
        }
    },

    // ── Scan History ────────────────────────────────────────────────────────

    async viewScans(agentId) {
        const siteId = WP.currentSite.id;
        const panel = document.getElementById('agent-results-panel');
        if (!panel) return;
        WP.Agents._stopPolling();

        panel.style.display = '';
        panel.innerHTML = '<div class="loading" style="padding:20px">Loading history...</div>';
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

        // Detect agent template
        let agentTemplate = 'broken-link-scanner';
        try {
            const agent = await WP.api(`sites/${siteId}/agents/${agentId}`);
            agentTemplate = agent.template_id || 'broken-link-scanner';
        } catch {}

        if (agentTemplate === 'performance-auditor') {
            return WP.Agents._viewAuditHistory(agentId, siteId, panel);
        }

        try {
            const scans = await WP.api(`sites/${siteId}/agents/${agentId}/scans?limit=10`);

            if (!scans.length) {
                panel.innerHTML = `
                    <div class="agent-config-panel" style="max-width:100%">
                        <div class="acp-header">
                            <div class="acp-name">Scan History</div>
                            <button class="acp-close" onclick="WP.Agents.closeResults()">&times;</button>
                        </div>
                        <div class="acp-body" style="text-align:center;padding:40px">
                            <p style="color:var(--text-muted)">No scans yet. Click Run to start the first scan.</p>
                        </div>
                    </div>
                `;
                return;
            }

            let historyHtml = '';
            for (const s of scans) {
                const date = new Date(s.started_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
                const isRunning = s.status === 'running';
                const statusIcon = s.status === 'completed' ? '\u2705' : isRunning ? '\u23F3' : '\u274C';

                const brokenBadge = isRunning
                    ? '<span class="agent-status-badge agent-status-running">In Progress</span>'
                    : s.broken_links > 0
                        ? `<span style="background:#e1705522;color:#e17055;padding:2px 8px;border-radius:4px;font-size:12px">${s.broken_links} broken</span>`
                          + (s.warning_links ? `<span style="background:#fdcb6e22;color:#e67e22;padding:2px 8px;border-radius:4px;font-size:12px;margin-left:4px">${s.warning_links} warnings</span>` : '')
                        : s.warning_links > 0
                            ? `<span style="background:#fdcb6e22;color:#e67e22;padding:2px 8px;border-radius:4px;font-size:12px">${s.warning_links} warnings</span>`
                            : '<span style="color:var(--green);font-size:12px">All clear</span>';

                const onclick = isRunning
                    ? `WP.Agents._resumeLiveProgress('${agentId}','${s.id}')`
                    : `WP.Agents.viewScanDetail('${s.id}')`;

                historyHtml += `
                    <div class="my-agent-row" style="cursor:pointer" onclick="${onclick}">
                        <div style="flex:1">
                            <div style="font-weight:500">${statusIcon} ${date}</div>
                            <div style="font-size:12px;color:var(--text-muted)">${s.total_links || 0} links checked &middot; ${s.scope || 'All'}</div>
                        </div>
                        ${brokenBadge}
                    </div>
                `;
            }

            panel.innerHTML = `
                <div class="agent-config-panel" style="max-width:100%">
                    <div class="acp-header">
                        <div class="acp-name">Scan History</div>
                        <button class="acp-close" onclick="WP.Agents.closeResults()">&times;</button>
                    </div>
                    <div class="acp-body" style="padding:0">
                        ${historyHtml}
                    </div>
                </div>
            `;
        } catch (e) {
            panel.innerHTML = `<div class="agent-config-panel"><div class="acp-body" style="color:var(--red);padding:20px">Failed to load scans: ${e.message || e}</div></div>`;
        }
    },

    async _resumeLiveProgress(agentId, scanId) {
        const siteId = WP.currentSite.id;
        const panel = document.getElementById('agent-results-panel');
        if (!panel) return;
        WP.Agents._stopPolling();
        WP.Agents._activeScanId = scanId;

        panel.style.display = '';
        panel.innerHTML = `
            <div class="agent-config-panel" style="max-width:100%">
                <div class="acp-header">
                    <div>
                        <div class="acp-name">Scan In Progress</div>
                        <div class="acp-sub">Checking links...</div>
                    </div>
                </div>
                <div class="acp-body" id="live-progress-body" style="padding:20px">
                    <div style="text-align:center"><div class="agent-status-badge agent-status-running" style="font-size:14px;padding:6px 16px">Loading...</div></div>
                </div>
            </div>
        `;

        WP.Agents._pollTimer = setInterval(async () => {
            try {
                const scan = await WP.api(`scans/${scanId}`);
                WP.Agents._updateLiveProgress(scan);
                if (scan.status !== 'running') {
                    WP.Agents._stopPolling();
                    WP.Agents._onScanComplete(agentId, siteId, scan);
                }
            } catch {}
        }, 3000);
    },

    // ── Scan Detail — Tabbed Full-Width Results ─────────────────────────────

    // Shared tooltip/color maps
    _errorTooltips: {
        broken_404: 'Page not found — the linked URL no longer exists',
        broken_410: 'Gone — content permanently removed',
        connection_error: 'Connection failed — server unreachable or DNS failure',
        auth_required: 'Requires authentication — not a broken link',
        forbidden: 'Access denied — often just bot-blocking, not a broken link',
        rate_limited: 'Rate limited — too many requests to this server',
        timeout: 'Timed out — the server took too long to respond',
        ssl_error: 'SSL/TLS error — invalid or expired certificate',
        redirect_chain: 'Too many redirects — the URL redirects more than 5 times',
        valid: 'False positive — link is actually working',
        repaired: 'Fixed — correct URL was found and applied',
        unlinked: 'Unlinked — no working URL found, link text preserved',
    },

    _typeColors: {
        broken_404: '#e17055', broken_410: '#e17055',
        connection_error: '#d63031', redirect_chain: '#0984e3',
        auth_required: '#6c5ce7', forbidden: '#e67e22', rate_limited: '#fdcb6e',
        timeout: '#fdcb6e', ssl_error: '#e84393',
        valid: '#00b894', repaired: '#00b894', unlinked: '#636e72',
    },

    _activeTab: 'all',

    async viewScanDetail(scanId) {
        const panel = document.getElementById('agent-results-panel');
        if (!panel) return;
        WP.Agents._stopPolling();
        WP.Agents._activeTab = 'all';

        panel.innerHTML = '<div class="loading" style="padding:20px">Loading scan results...</div>';

        try {
            const scan = await WP.api(`scans/${scanId}`);
            const broken = scan.results || [];
            const scanDate = new Date(scan.started_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
            const duration = scan.completed_at && scan.started_at
                ? Math.round((new Date(scan.completed_at) - new Date(scan.started_at)) / 1000)
                : null;

            // Group by error type and severity
            const byType = {};
            const bySeverity = { broken: [], warning: [] };
            for (const b of broken) {
                const t = b.error_type || 'unknown';
                if (!byType[t]) byType[t] = [];
                byType[t].push(b);
                const sev = b.severity || 'broken';
                if (!bySeverity[sev]) bySeverity[sev] = [];
                bySeverity[sev].push(b);
            }
            const typeKeys = Object.keys(byType).sort((a, b) => byType[b].length - byType[a].length);

            // Summary badges
            let summaryHtml = '';
            if (bySeverity.broken.length) {
                summaryHtml += `<span style="display:inline-block;background:#e1705522;color:#e17055;padding:3px 10px;border-radius:4px;margin:2px;font-size:12px;font-weight:700">${bySeverity.broken.length} broken</span>`;
            }
            if (bySeverity.warning.length) {
                summaryHtml += `<span style="display:inline-block;background:#fdcb6e44;color:#e67e22;padding:3px 10px;border-radius:4px;margin:2px;font-size:12px;font-weight:700">${bySeverity.warning.length} warnings</span>`;
            }
            summaryHtml += '<span style="margin:0 4px;color:var(--text-muted)">|</span>';
            for (const t of typeKeys) {
                const color = WP.Agents._typeColors[t] || '#6c5ce7';
                const tip = WP.Agents._errorTooltips[t] || '';
                summaryHtml += `<span style="display:inline-block;background:${color}18;color:${color};padding:3px 10px;border-radius:4px;margin:2px;font-size:12px;font-weight:600;cursor:help" title="${tip}">${t.replace(/_/g, ' ')}: ${byType[t].length}</span>`;
            }

            // Tab buttons — severity tabs first, then by type
            let tabsHtml = `<button class="tab-btn active" data-agent-tab="all" onclick="WP.Agents._switchTab('all')">All (${broken.length})</button>`;
            if (bySeverity.broken.length) {
                tabsHtml += `<button class="tab-btn" data-agent-tab="sev-broken" onclick="WP.Agents._switchTab('sev-broken')" style="color:#e17055">Broken (${bySeverity.broken.length})</button>`;
            }
            if (bySeverity.warning.length) {
                tabsHtml += `<button class="tab-btn" data-agent-tab="sev-warning" onclick="WP.Agents._switchTab('sev-warning')" style="color:#e67e22">Warnings (${bySeverity.warning.length})</button>`;
            }
            for (const t of typeKeys) {
                tabsHtml += `<button class="tab-btn" data-agent-tab="${t}" onclick="WP.Agents._switchTab('${t}')">${t.replace(/_/g, ' ')} (${byType[t].length})</button>`;
            }

            // Format duration
            let durationStr = '';
            if (duration) {
                durationStr = duration >= 60
                    ? Math.floor(duration / 60) + 'm ' + (duration % 60) + 's'
                    : duration + 's';
            }

            const siteUrl = WP.currentSite?.url?.replace(/\/$/, '') || '';

            panel.innerHTML = `
                <div class="agent-config-panel" style="max-width:100%">
                    <div class="acp-header">
                        <div>
                            <div class="acp-name">Scan Results \u2014 ${scanDate}</div>
                            <div class="acp-sub">
                                ${scan.total_links || 0} links checked &middot;
                                ${bySeverity.broken.length} broken${bySeverity.warning.length ? ' + ' + bySeverity.warning.length + ' warnings' : ''}
                                ${durationStr ? ' &middot; ' + durationStr : ''}
                                ${scan.report_sent ? ' &middot; Email sent' : ''}
                            </div>
                        </div>
                        <button class="acp-close" onclick="WP.Agents.viewScans('${scan.agent_id}')">&larr; Back</button>
                    </div>
                    <div class="acp-body" style="display:block;padding:12px">
                        ${broken.length === 0
                            ? '<div style="text-align:center;padding:30px;color:var(--green)"><div style="font-size:32px">\u2705</div><p>No broken links found!</p></div>'
                            : `
                                <div style="margin-bottom:12px">${summaryHtml}</div>
                                <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">
                                    <div class="tab-bar" style="flex:1;display:flex;gap:4px;flex-wrap:wrap">${tabsHtml}</div>
                                    <button class="btn btn-primary" id="bulk-fix-btn" onclick="WP.Agents.bulkFix()" style="font-size:12px;white-space:nowrap">AI Fix Tab</button>
                                </div>
                                <div id="bulk-fix-status"></div>
                                <div id="agent-results-table"></div>
                            `
                        }
                    </div>
                </div>
            `;

            if (broken.length) {
                WP.Agents._renderResultsTable(broken, siteUrl, scan.id);
            }

            WP.Agents._scanData = { broken, byType, bySeverity, siteUrl, scanId: scan.id };

        } catch (e) {
            panel.innerHTML = `<div class="agent-config-panel"><div class="acp-body" style="color:var(--red);padding:20px">Failed to load results: ${e.message || e}</div></div>`;
        }
    },

    _switchTab(tab) {
        WP.Agents._activeTab = tab;
        document.querySelectorAll('[data-agent-tab]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.agentTab === tab);
        });

        const data = WP.Agents._scanData;
        if (!data) return;

        const items = tab === 'all' ? data.broken
            : tab === 'sev-broken' ? (data.bySeverity?.broken || [])
            : tab === 'sev-warning' ? (data.bySeverity?.warning || [])
            : (data.byType[tab] || []);
        WP.Agents._renderResultsTable(items, data.siteUrl, data.scanId);
    },

    _renderResultsTable(items, siteUrl, scanId) {
        const container = document.getElementById('agent-results-table');
        if (!container) return;

        if (!items.length) {
            container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">No results in this category</div>';
            return;
        }

        let rows = '';
        for (const b of items) {
            const showUrl = b.new_url || b.url;
            const displayUrl = showUrl.length > 70 ? showUrl.slice(0, 70) + '...' : showUrl;
            const editPath = '/wp-admin/post.php?post=' + b.post_id + '&action=edit';
            const postTitle = (b.post_title || 'Untitled').slice(0, 50);
            const siteId = WP.currentSite?.id || '';
            const statusBadge = b.status_code
                ? `<span style="font-weight:600;color:${b.status_code >= 500 ? '#d63031' : b.status_code === 404 ? '#e17055' : '#6c5ce7'}">${b.status_code}</span>`
                : '\u2014';

            // Context column — show fix result or original error type with tooltip
            const isFixed = ['valid', 'repaired', 'unlinked'].includes(b.error_type);
            const contextLabel = b.context || b.error_type.replace(/_/g, ' ');
            const tooltip = WP.Agents._errorTooltips[b.error_type] || 'HTTP ' + (b.status_code || 'error') + ' \u2014 unexpected response';
            const contextColor = isFixed
                ? (WP.Agents._typeColors[b.error_type] || '#636e72')
                : 'inherit';
            const contextStyle = isFixed
                ? `font-size:11px;font-weight:600;color:${contextColor}`
                : 'font-size:11px;cursor:help;border-bottom:1px dotted var(--text-muted)';

            // Row styling for fixed items and severity
            const sevBorder = b.severity === 'warning' ? 'border-left:3px solid #fdcb6e;' : b.severity === 'broken' ? 'border-left:3px solid #e17055;' : '';
            const rowStyle = isFixed ? 'opacity:0.6;' + sevBorder : sevBorder;
            const rowId = `link-row-${b.post_id}-${btoa(b.url).slice(0, 12)}`;

            // Source URL — show new_url with indicator if replaced
            let urlHtml;
            if (b.new_url && b.new_url !== b.url) {
                urlHtml = `<a href="${WP.stripHtml(b.new_url)}" target="_blank" rel="noopener" title="${WP.stripHtml(b.new_url)}" style="color:var(--green)">${WP.stripHtml(displayUrl)}</a>
                    <div style="font-size:10px;color:var(--text-muted);text-decoration:line-through">${WP.stripHtml(b.url.length > 50 ? b.url.slice(0, 50) + '...' : b.url)}</div>`;
            } else {
                urlHtml = `<a href="${WP.stripHtml(b.url)}" target="_blank" rel="noopener" title="${WP.stripHtml(b.url)}">${WP.stripHtml(displayUrl)}</a>`;
            }

            rows += `
                <tr id="${rowId}" style="${rowStyle}">
                    <td style="word-break:break-all">${urlHtml}</td>
                    <td style="text-align:center">${statusBadge}</td>
                    <td><span style="${contextStyle}" title="${tooltip}">${contextLabel}</span></td>
                    <td>
                        <a href="${WP.stripHtml(b.post_url)}" target="_blank" rel="noopener">${WP.stripHtml(postTitle)}</a>
                        <div style="font-size:10px;color:var(--text-muted)">${b.post_type}</div>
                    </td>
                    <td style="white-space:nowrap">
                        ${isFixed ? '<span style="font-size:11px;color:var(--text-muted)">Done</span>' : `
                        <div style="display:flex;gap:4px;flex-wrap:nowrap">
                            <button class="btn-sm btn-primary" style="font-size:11px" onclick="WP.Agents.aiFix('${siteId}',${b.post_id},'${b.post_type}','${btoa(b.url)}','${scanId}')">AI Fix</button>
                            <button class="btn-sm" style="font-size:11px" onclick="WP.wpAdminOpen('${WP.stripHtml(editPath)}')">Edit</button>
                            <button class="btn-sm btn-ghost" style="font-size:11px" onclick="WP.Agents.dismissBroken('${siteId}','${scanId}','${btoa(b.url)}',${b.post_id})">Dismiss</button>
                        </div>`}
                    </td>
                </tr>
            `;
        }

        container.innerHTML = `
            <div style="overflow-x:auto">
                <table class="data-table" style="width:100%;min-width:700px">
                    <thead><tr>
                        <th style="min-width:200px">Source URL</th>
                        <th style="width:60px">Status</th>
                        <th style="width:130px">Context</th>
                        <th style="min-width:140px">Found In</th>
                        <th style="width:170px">Actions</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    },

    // ── AI Fix (single + bulk) ──────────────────────────────────────────────

    async aiFix(siteId, postId, postType, urlB64, scanId) {
        const url = atob(urlB64);
        const rowId = 'link-row-' + postId + '-' + urlB64.slice(0, 12);
        const row = document.getElementById(rowId);

        // Show spinner in the actions cell
        if (row) {
            const actionsCell = row.querySelector('td:last-child');
            if (actionsCell) actionsCell.innerHTML = '<span class="agent-status-badge agent-status-running" style="font-size:11px">Fixing...</span>';
        }

        try {
            const result = await WP.api(`sites/${siteId}/ai-fix-link`, {
                method: 'POST',
                body: { post_id: postId, post_type: postType, broken_url: url, scan_id: scanId },
            });

            // Update the in-memory scan data
            const data = WP.Agents._scanData;
            if (data) {
                for (const b of data.broken) {
                    if (b.url === url && b.post_id === postId) {
                        b.error_type = result.status;  // valid | repaired | missing → unlinked
                        if (result.status === 'missing') b.error_type = 'unlinked';
                        b.context = result.message;
                        if (result.new_url) b.new_url = result.new_url;
                        break;
                    }
                }
                // Regroup by type
                data.byType = {};
                for (const b of data.broken) {
                    const t = b.error_type || 'unknown';
                    if (!data.byType[t]) data.byType[t] = [];
                    data.byType[t].push(b);
                }
            }

            // Re-render current tab
            WP.Agents._switchTab(WP.Agents._activeTab);

            const label = result.status === 'valid' ? 'Valid (false positive)'
                        : result.status === 'repaired' ? 'Repaired'
                        : 'Unlinked';
            WP.toast(`${label}: ${url.slice(0, 60)}`, result.status === 'missing' ? 'info' : 'success');

            return result;
        } catch (e) {
            WP.toast('AI Fix failed: ' + (e.message || e), 'error');
            if (row) {
                const actionsCell = row.querySelector('td:last-child');
                if (actionsCell) actionsCell.innerHTML = '<span style="font-size:11px;color:var(--red)">Error</span>';
            }
            return null;
        }
    },

    async bulkFix() {
        const data = WP.Agents._scanData;
        if (!data) return;

        const tab = WP.Agents._activeTab;
        const items = tab === 'all' ? data.broken
            : tab === 'sev-broken' ? (data.bySeverity?.broken || [])
            : tab === 'sev-warning' ? (data.bySeverity?.warning || [])
            : (data.byType[tab] || []);

        // Filter to unfixed items only
        const fixable = items.filter(b => !['valid', 'repaired', 'unlinked'].includes(b.error_type));
        if (!fixable.length) {
            WP.toast('All items in this tab are already fixed', 'info');
            return;
        }

        const tabLabel = tab === 'all' ? 'all' : tab.replace(/_/g, ' ');
        if (!confirm(`AI Fix ${fixable.length} links in the "${tabLabel}" tab?\n\nThis will re-verify each link with a browser-like request, find correct URLs where possible, and unlink dead links.`)) return;

        const btn = document.getElementById('bulk-fix-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Fixing...'; }

        const statusEl = document.getElementById('bulk-fix-status');
        const siteId = WP.currentSite?.id || '';
        let done = 0, repaired = 0, valid = 0, unlinked = 0, errors = 0;

        for (const b of fixable) {
            done++;
            if (statusEl) {
                statusEl.innerHTML = `<div style="font-size:12px;padding:6px 0;color:var(--text-muted)">
                    Processing ${done}/${fixable.length}...
                    <span style="color:var(--green)">${valid} valid</span> &middot;
                    <span style="color:var(--accent)">${repaired} repaired</span> &middot;
                    <span style="color:var(--text-muted)">${unlinked} unlinked</span>
                    ${errors ? ` &middot; <span style="color:var(--red)">${errors} errors</span>` : ''}
                </div>`;
            }

            try {
                const result = await WP.Agents.aiFix(siteId, b.post_id, b.post_type, btoa(b.url), data.scanId);
                if (result) {
                    if (result.status === 'valid') valid++;
                    else if (result.status === 'repaired') repaired++;
                    else unlinked++;
                } else {
                    errors++;
                }
            } catch {
                errors++;
            }

            // Small delay between requests
            await new Promise(r => setTimeout(r, 200));
        }

        if (btn) { btn.disabled = false; btn.textContent = 'AI Fix Tab'; }
        if (statusEl) {
            statusEl.innerHTML = `<div style="font-size:12px;padding:6px 0;color:var(--green);font-weight:500">
                Bulk fix complete: ${valid} valid, ${repaired} repaired, ${unlinked} unlinked${errors ? ', ' + errors + ' errors' : ''}
            </div>`;
        }

        WP.toast(`Bulk fix done \u2014 ${valid} valid, ${repaired} repaired, ${unlinked} unlinked`, 'success');
    },

    // ── Link Actions ────────────────────────────────────────────────────────

    async dismissBroken(siteId, scanId, urlB64, postId) {
        const url = atob(urlB64);
        try {
            await WP.api(`sites/${siteId}/dismiss-link`, {
                method: 'POST',
                body: { scan_id: scanId, broken_url: url, post_id: postId },
            });
            WP.toast('Link dismissed');
            const rowId = 'link-row-' + postId + '-' + urlB64.slice(0, 12);
            const row = document.getElementById(rowId);
            if (row) { row.style.opacity = '0.3'; row.style.pointerEvents = 'none'; }
        } catch (e) {
            WP.toast('Failed to dismiss: ' + (e.message || e), 'error');
        }
    },

    // ── Performance Audit — Progress + History + Detail ────────────────────

    _updateAuditProgress(audit) {
        const body = document.getElementById('live-progress-body');
        if (!body) return;

        const checked = audit.pages_checked || 0;
        const total = audit.pages_audited || 0;
        const pct = total > 0 ? Math.round((checked / total) * 100) : 0;

        body.innerHTML = `
            <div style="text-align:center">
                <div style="font-size:28px;font-weight:700;color:var(--text);margin-bottom:4px">${checked} / ${total}</div>
                <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">pages audited</div>
                <div style="background:var(--bg-hover);border-radius:8px;height:10px;width:100%;max-width:400px;margin:0 auto;overflow:hidden">
                    <div style="background:#00b894;height:100%;border-radius:8px;width:${pct}%;transition:width .3s ease"></div>
                </div>
                <div style="font-size:12px;color:var(--text-muted);margin-top:6px">${pct}% complete</div>
            </div>
        `;
    },

    _onAuditComplete(agentId, siteId, audit) {
        WP.Agents._resetAgentRow(agentId, { status: 'idle' });
        if (audit.status === 'completed') {
            WP.toast('Audit completed!', 'success');
            WP.Agents.viewAuditDetail(audit.id, agentId);
        } else {
            WP.toast('Audit failed', 'error');
            WP.Agents.viewScans(agentId);
        }
    },

    async _viewAuditHistory(agentId, siteId, panel) {
        try {
            const audits = await WP.api(`sites/${siteId}/agents/${agentId}/audits?limit=10`);

            if (!audits.length) {
                panel.innerHTML = `
                    <div class="agent-config-panel" style="max-width:100%">
                        <div class="acp-header">
                            <div class="acp-name">Audit History</div>
                            <button class="acp-close" onclick="WP.Agents.closeResults()">&times;</button>
                        </div>
                        <div class="acp-body" style="text-align:center;padding:40px">
                            <p style="color:var(--text-muted)">No audits yet. Click Run to start the first audit.</p>
                        </div>
                    </div>
                `;
                return;
            }

            let historyHtml = '';
            for (const a of audits) {
                const date = new Date(a.started_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
                const isRunning = a.status === 'running';
                const statusIcon = a.status === 'completed' ? '\u2705' : isRunning ? '\u23F3' : '\u274C';

                const scoreColor = (a.overall_score || 0) >= 90 ? '#00b894' : (a.overall_score || 0) >= 50 ? '#fdcb6e' : '#e17055';
                const scoreBadge = isRunning
                    ? '<span class="agent-status-badge agent-status-running">In Progress</span>'
                    : a.overall_score != null
                        ? `<span style="background:${scoreColor}22;color:${scoreColor};padding:2px 10px;border-radius:4px;font-size:14px;font-weight:700">${a.overall_score}</span>`
                        : '<span style="color:var(--text-muted);font-size:12px">N/A</span>';

                const issuesBadge = !isRunning && a.issues_found
                    ? `<span style="font-size:12px;color:var(--text-muted);margin-left:8px">${a.issues_found} issues${a.critical_issues ? ` (${a.critical_issues} critical)` : ''}</span>`
                    : '';

                const onclick = isRunning
                    ? `WP.Agents._resumeAuditProgress('${agentId}','${a.id}')`
                    : `WP.Agents.viewAuditDetail('${a.id}','${agentId}')`;

                historyHtml += `
                    <div class="my-agent-row" style="cursor:pointer" onclick="${onclick}">
                        <div style="flex:1">
                            <div style="font-weight:500">${statusIcon} ${date}</div>
                            <div style="font-size:12px;color:var(--text-muted)">${a.pages_audited || 0} pages &middot; ${a.scope || 'Thorough'}</div>
                        </div>
                        <div style="display:flex;align-items:center">${scoreBadge}${issuesBadge}</div>
                    </div>
                `;
            }

            panel.innerHTML = `
                <div class="agent-config-panel" style="max-width:100%">
                    <div class="acp-header">
                        <div class="acp-name">Audit History</div>
                        <button class="acp-close" onclick="WP.Agents.closeResults()">&times;</button>
                    </div>
                    <div class="acp-body" style="padding:0">
                        ${historyHtml}
                    </div>
                </div>
            `;
        } catch (e) {
            panel.innerHTML = `<div class="agent-config-panel"><div class="acp-body" style="color:var(--red);padding:20px">Failed to load audits: ${e.message || e}</div></div>`;
        }
    },

    async _resumeAuditProgress(agentId, auditId) {
        const siteId = WP.currentSite.id;
        const panel = document.getElementById('agent-results-panel');
        if (!panel) return;
        WP.Agents._stopPolling();
        WP.Agents._activeScanId = auditId;

        panel.style.display = '';
        panel.innerHTML = `
            <div class="agent-config-panel" style="max-width:100%">
                <div class="acp-header">
                    <div>
                        <div class="acp-name">Audit In Progress</div>
                        <div class="acp-sub">Auditing pages...</div>
                    </div>
                </div>
                <div class="acp-body" id="live-progress-body" style="padding:20px">
                    <div style="text-align:center"><div class="agent-status-badge agent-status-running" style="font-size:14px;padding:6px 16px">Loading...</div></div>
                </div>
            </div>
        `;

        WP.Agents._pollTimer = setInterval(async () => {
            try {
                const audit = await WP.api(`audits/${auditId}`);
                WP.Agents._updateAuditProgress(audit);
                if (audit.status !== 'running') {
                    WP.Agents._stopPolling();
                    WP.Agents._onAuditComplete(agentId, siteId, audit);
                }
            } catch {}
        }, 3000);
    },

    async viewAuditDetail(auditId, agentId) {
        const panel = document.getElementById('agent-results-panel');
        if (!panel) return;
        WP.Agents._stopPolling();

        panel.innerHTML = '<div class="loading" style="padding:20px">Loading audit results...</div>';

        try {
            const audit = await WP.api(`audits/${auditId}`);
            const results = audit.results || {};
            const pages = results.pages || [];
            const findings = results.findings || [];
            const serverMetrics = results.server_metrics || {};
            const psiAvailable = results.psi_available !== false && pages.some(p => p.score != null);
            const auditDate = new Date(audit.started_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
            const duration = audit.completed_at && audit.started_at
                ? Math.round((new Date(audit.completed_at) - new Date(audit.started_at)) / 1000)
                : null;
            let durationStr = '';
            if (duration) {
                durationStr = duration >= 60
                    ? Math.floor(duration / 60) + 'm ' + (duration % 60) + 's'
                    : duration + 's';
            }

            const score = audit.overall_score;
            const scoreColor = score != null
                ? (score >= 90 ? '#00b894' : score >= 50 ? '#fdcb6e' : '#e17055')
                : '#636e72';
            const backAgent = agentId || audit.agent_id;

            // CWV strip — only show when PSI data is present
            let cwvHtml = '';
            if (psiAvailable) {
                const cwvCards = [
                    { label: 'LCP', value: audit.avg_lcp, unit: 'ms', good: 2500, poor: 4000,
                      tip: 'Largest Contentful Paint — time until the biggest visible element loads. Under 2.5s is good. Directly affects Google search ranking.' },
                    { label: 'FCP', value: audit.avg_fcp, unit: 'ms', good: 1800, poor: 3000,
                      tip: 'First Contentful Paint — time until the first text or image appears. Under 1.8s is good. Shows how fast the page starts rendering.' },
                    { label: 'CLS', value: audit.avg_cls, unit: '', good: 0.1, poor: 0.25, decimal: 3,
                      tip: 'Cumulative Layout Shift — measures visual stability. Under 0.1 is good. High CLS means elements jump around as the page loads.' },
                    { label: 'TTFB', value: audit.avg_ttfb, unit: 'ms', good: 800, poor: 1800,
                      tip: 'Time to First Byte — how long the server takes to respond. Under 800ms is acceptable, under 200ms with caching is ideal.' },
                    { label: 'TBT', value: audit.avg_tbt, unit: 'ms', good: 200, poor: 600,
                      tip: 'Total Blocking Time — how long the main thread is blocked by JavaScript. Under 200ms is good. Proxy for Google\'s INP metric.' },
                ];
                cwvHtml = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:16px 0">';
                for (const c of cwvCards) {
                    const val = c.value != null ? (c.decimal ? Number(c.value).toFixed(c.decimal) : Math.round(c.value)) : 'N/A';
                    const color = c.value == null ? 'var(--text-muted)' : c.value <= c.good ? '#00b894' : c.value <= c.poor ? '#fdcb6e' : '#e17055';
                    const goodLabel = c.decimal ? c.good : c.good + c.unit;
                    cwvHtml += `<div style="flex:1;min-width:100px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:12px;text-align:center;cursor:help;position:relative" title="${c.tip}">
                        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${c.label} <span style="font-size:9px;opacity:.6">&#9432;</span></div>
                        <div style="font-size:20px;font-weight:700;color:${color}">${val}${c.value != null ? c.unit : ''}</div>
                        <div style="font-size:9px;color:var(--text-muted);margin-top:2px">Good: &le;${goodLabel}</div>
                    </div>`;
                }
                cwvHtml += '</div>';
            } else {
                cwvHtml = `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin:16px 0;display:flex;align-items:center;gap:10px">
                    <span style="font-size:18px">&#9432;</span>
                    <div>
                        <div style="font-weight:600;font-size:13px">Core Web Vitals data unavailable</div>
                        <div style="font-size:12px;color:var(--text-muted)">PageSpeed Insights API quota was exhausted or no API key is configured. HTML-based and server-side findings below are still accurate.</div>
                    </div>
                </div>`;
            }

            // Fix type labels and icons
            const _fixLabel = (ft) => {
                const map = { plugin_install: 'Install Plugin', server_config: 'Server Config', manual: 'Manual Fix', informational: 'Info' };
                return map[ft] || ft || 'Manual Fix';
            };
            const _fixColor = (ft) => {
                const map = { plugin_install: '#6c5ce7', server_config: '#0984e3', manual: '#00b894', informational: '#636e72' };
                return map[ft] || '#636e72';
            };
            const _impactLabel = (imp) => {
                const map = { high: 'High Impact', medium: 'Medium Impact', low: 'Low Impact' };
                return map[imp] || '';
            };
            const _impactColor = (imp) => {
                const map = { high: '#e17055', medium: '#fdcb6e', low: '#636e72' };
                return map[imp] || '#636e72';
            };

            // Action URL fallback — generate client-side for old audits missing action_url
            const siteUrl = (WP.currentSite && WP.currentSite.url || '').replace(/\/$/, '');
            const adminUrl = siteUrl ? siteUrl + '/wp-admin' : '';
            const detectedBuilder = (pages.find(p => p.page_builder) || {}).page_builder || '';
            const _pluginSearch = (q) => adminUrl ? `${adminUrl}/plugin-install.php?s=${q}&tab=search` : '';
            // Avada deep-links: #field_id scrolls to the exact option, #tab-section opens the section
            const _avadaOpts = adminUrl ? `${adminUrl}/themes.php?page=avada_options` : '';
            const _avada = (fieldId) => _avadaOpts ? `${_avadaOpts}#${fieldId}` : '';
            const _avadaTab = (sectionId) => _avadaOpts ? `${_avadaOpts}#tab-${sectionId}` : '';
            const isAvada = detectedBuilder === 'avada';
            const isElementor = detectedBuilder === 'elementor';
            const _elPerf = () => adminUrl && isElementor ? `${adminUrl}/admin.php?page=elementor#tab-performance` : '';
            const _actionFallback = {
                'no-page-cache':       { url: () => _pluginSearch('litespeed+cache'), label: 'Install Cache Plugin' },
                'no-object-cache':     { url: () => _pluginSearch('redis+object+cache'), label: 'Install Redis Plugin' },
                'large-autoload':      { url: () => _pluginSearch('wp-optimize'), label: 'Install WP-Optimize' },
                'expired-transients':  { url: () => _pluginSearch('transient+cleaner'), label: 'Install Transient Cleaner' },
                'excessive-revisions': { url: () => _pluginSearch('wp-optimize'), label: 'Install WP-Optimize' },
                'too-many-plugins':    { url: () => adminUrl ? `${adminUrl}/plugins.php` : '', label: 'Manage Plugins' },
                'heavy-plugins':       { url: () => adminUrl ? `${adminUrl}/plugins.php` : '', label: 'View Plugins' },
                'high-ttfb':           { url: () => _pluginSearch('litespeed+cache'), label: 'Install Cache Plugin' },
                'poor-lcp':            { url: () => isAvada ? _avada('lazy_load') : _elPerf(), label: isAvada ? 'Avada: Lazy Loading' : 'Lazy Load Settings' },
                'needs-improvement-lcp': { url: () => isAvada ? _avada('lazy_load') : _elPerf(), label: isAvada ? 'Avada: Lazy Loading' : 'Lazy Load Settings' },
                'poor-cls':            { url: () => isAvada ? _avada('lazy_load') : _elPerf(), label: isAvada ? 'Avada: Lazy Loading' : 'Performance Settings' },
                'needs-improvement-cls': { url: () => isAvada ? _avada('lazy_load') : _elPerf(), label: isAvada ? 'Avada: Lazy Loading' : 'Performance Settings' },
                'poor-tbt':            { url: () => isAvada ? _avada('defer_jquery') : _elPerf(), label: isAvada ? 'Avada: Defer jQuery' : 'Performance Settings' },
                'needs-improvement-tbt': { url: () => isAvada ? _avada('js_compiler') : _elPerf(), label: isAvada ? 'Avada: JS Compiler' : 'Performance Settings' },
                'large-dom':           { url: () => isAvada ? _avada('lazy_load') : _elPerf(), label: isAvada ? 'Avada: Lazy Loading' : 'Lazy Load Settings' },
                'unoptimized-images':  { url: () => _pluginSearch('shortpixel+image+optimizer'), label: 'Install ShortPixel' },
                'render-blocking':     { url: () => isAvada ? _avada('critical_css') : _pluginSearch('autoptimize'), label: isAvada ? 'Avada: Critical CSS' : 'Install Autoptimize' },
                'page-builder':        { url: () => isAvada ? _avadaTab('heading_performance') : _elPerf(), label: isAvada ? 'Avada: Performance' : 'Performance Settings' },
                'large-options-table': { url: () => _pluginSearch('wp-optimize'), label: 'Install WP-Optimize' },
            };

            // Enrich findings with action URLs (backend-provided take priority)
            for (const f of findings) {
                if (!f.action_url && adminUrl) {
                    const fb = _actionFallback[f.id];
                    if (fb) {
                        const u = typeof fb.url === 'function' ? fb.url() : fb.url;
                        if (u) { f.action_url = u; f.action_label = fb.label; }
                    }
                }
            }

            // Findings — expandable cards with badges
            const sevColors = { critical: '#e17055', high: '#d63031', medium: '#fdcb6e', low: '#636e72' };
            let findingsHtml = '';
            if (findings.length) {
                findingsHtml = '<h3 style="margin:20px 0 8px;font-size:14px">Findings (' + findings.length + ')</h3>';
                findings.forEach((f, i) => {
                    const sc = sevColors[f.severity] || '#636e72';
                    const fc = _fixColor(f.fix_type);
                    const ic = _impactColor(f.impact_estimate);
                    const detailId = `finding-detail-${auditId}-${i}`;
                    findingsHtml += `
                        <div style="border:1px solid var(--border);border-left:3px solid ${sc};border-radius:6px;margin-bottom:6px;overflow:hidden">
                            <div style="padding:10px 12px;cursor:pointer;display:flex;align-items:center;gap:8px;flex-wrap:wrap" onclick="document.getElementById('${detailId}').style.display=document.getElementById('${detailId}').style.display==='none'?'block':'none'">
                                <span style="background:${sc}22;color:${sc};padding:1px 8px;border-radius:3px;font-size:11px;font-weight:600;text-transform:uppercase">${f.severity}</span>
                                ${f.impact_estimate ? `<span style="background:${ic}18;color:${ic};padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600">${_impactLabel(f.impact_estimate)}</span>` : ''}
                                <span style="background:${fc}18;color:${fc};padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600">${_fixLabel(f.fix_type)}</span>
                                <span style="font-weight:600;font-size:13px;flex:1">${WP.stripHtml(f.title)}</span>
                                <span style="font-size:11px;color:var(--text-muted)">&#9662;</span>
                            </div>
                            <div id="${detailId}" style="display:none;padding:0 12px 10px 12px;border-top:1px solid var(--border)">
                                <div style="font-size:12px;color:var(--text-muted);margin:8px 0 6px">${WP.stripHtml(f.detail)}</div>
                                <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                                    <div style="font-size:12px;color:var(--accent);flex:1"><strong>Fix:</strong> ${WP.stripHtml(f.recommendation)}</div>
                                    ${f.action_url ? `<a href="${WP.stripHtml(f.action_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:#fff;background:var(--accent);padding:4px 12px;border-radius:4px;text-decoration:none;white-space:nowrap">${WP.stripHtml(f.action_label || 'Fix This')} &#8599;</a>` : ''}
                                </div>
                            </div>
                        </div>
                    `;
                });
            }

            // Page-by-page table — hide all-null CWV columns, color-code, sortable, hover tooltips
            let pageTableHtml = '';
            if (pages.length) {
                // Determine which CWV columns have any data
                const hasCWV = (key) => pages.some(p => p[key] != null);
                const hasScore = hasCWV('score');
                const hasLcp = hasCWV('lcp_ms');
                const hasCls = hasCWV('cls');
                const hasTtfb = hasCWV('ttfb_ms');

                // Color helpers
                const domColor = (v) => !v ? '' : v > 1500 ? 'color:#e17055;font-weight:600' : v > 800 ? 'color:#e2b93b' : '';
                const blockColor = (v) => !v ? '' : v > 8 ? 'color:#e17055;font-weight:600' : v > 5 ? 'color:#e2b93b' : '';
                const scoreColorFn = (v) => v == null ? 'color:var(--text-muted)' : v >= 90 ? 'color:#00b894' : v >= 50 ? 'color:#fdcb6e' : 'color:#e17055';

                // Per-page issue builder for hover tooltips
                const _pageIssues = (p) => {
                    const issues = [];
                    if (p.score != null && p.score < 50) issues.push(`Score: ${p.score} (poor)`);
                    else if (p.score != null && p.score < 90) issues.push(`Score: ${p.score} (needs improvement)`);
                    if (p.lcp_ms != null && p.lcp_ms > 4000) issues.push(`LCP: ${Math.round(p.lcp_ms)}ms (poor — over 4s)`);
                    else if (p.lcp_ms != null && p.lcp_ms > 2500) issues.push(`LCP: ${Math.round(p.lcp_ms)}ms (needs improvement)`);
                    if (p.cls != null && p.cls > 0.25) issues.push(`CLS: ${p.cls.toFixed(3)} (poor — major layout shift)`);
                    else if (p.cls != null && p.cls > 0.1) issues.push(`CLS: ${p.cls.toFixed(3)} (needs improvement)`);
                    if (p.ttfb_ms != null && p.ttfb_ms > 1800) issues.push(`TTFB: ${Math.round(p.ttfb_ms)}ms (slow server response)`);
                    else if (p.ttfb_ms != null && p.ttfb_ms > 800) issues.push(`TTFB: ${Math.round(p.ttfb_ms)}ms (needs improvement)`);
                    if (p.dom_elements && p.dom_elements > 1500) issues.push(`DOM: ${p.dom_elements.toLocaleString()} elements (heavy)`);
                    else if (p.dom_elements && p.dom_elements > 800) issues.push(`DOM: ${p.dom_elements.toLocaleString()} elements (moderate)`);
                    if (p.render_blocking > 8) issues.push(`${p.render_blocking} render-blocking resources (high)`);
                    else if (p.render_blocking > 5) issues.push(`${p.render_blocking} render-blocking resources`);
                    if (p.unoptimized_images > 0) issues.push(`${p.unoptimized_images} of ${p.total_images} images not in WebP/AVIF`);
                    if (p.iframes > 0) issues.push(`${p.iframes} iframe${p.iframes > 1 ? 's' : ''} embedded`);
                    if (p.third_party_scripts >= 5) issues.push(`${p.third_party_scripts} third-party scripts`);
                    return issues;
                };

                // Column definitions (conditionally included)
                const cols = [
                    { key: 'label', hdr: 'Page', width: '150px', show: true, align: 'left' },
                    { key: 'score', hdr: 'Score', width: '60px', show: hasScore },
                    { key: 'lcp_ms', hdr: 'LCP', width: '70px', show: hasLcp },
                    { key: 'cls', hdr: 'CLS', width: '60px', show: hasCls },
                    { key: 'ttfb_ms', hdr: 'TTFB', width: '70px', show: hasTtfb },
                    { key: 'dom_elements', hdr: 'DOM', width: '60px', show: true },
                    { key: 'total_images', hdr: 'Imgs', width: '55px', show: true },
                    { key: 'render_blocking', hdr: 'Block', width: '55px', show: true },
                ];
                const visCols = cols.filter(c => c.show);

                const thCells = visCols.map(c =>
                    `<th style="min-width:${c.width};text-align:${c.align || 'center'};cursor:pointer;user-select:none;position:sticky;top:0;background:var(--bg-card);z-index:1" data-sort-key="${c.key}">${c.hdr} <span style="font-size:10px;color:var(--text-muted)">&#8597;</span></th>`
                ).join('');

                const renderCell = (p, col) => {
                    const k = col.key;
                    if (k === 'label') {
                        const builder = p.page_builder ? ` <span style="font-size:10px;background:var(--bg-hover);padding:1px 4px;border-radius:3px">${p.page_builder}</span>` : '';
                        const unopt = p.unoptimized_images > 0 ? ` <span style="font-size:10px;color:#e17055">&#9679;${p.unoptimized_images}</span>` : '';
                        return `<td style="word-break:break-all"><a href="${WP.stripHtml(p.url)}" target="_blank" rel="noopener">${WP.stripHtml(p.label || p.url.split('/').pop() || '/')}</a>${builder}${unopt}</td>`;
                    }
                    if (k === 'score') {
                        const v = p.score;
                        return `<td style="text-align:center;font-weight:700;${scoreColorFn(v)}">${v != null ? v : '<span style="color:var(--text-muted)">N/A</span>'}</td>`;
                    }
                    if (k === 'lcp_ms') return `<td style="text-align:center">${p.lcp_ms != null ? Math.round(p.lcp_ms) + 'ms' : '<span style="color:var(--text-muted)">—</span>'}</td>`;
                    if (k === 'cls') return `<td style="text-align:center">${p.cls != null ? p.cls.toFixed(3) : '<span style="color:var(--text-muted)">—</span>'}</td>`;
                    if (k === 'ttfb_ms') return `<td style="text-align:center">${p.ttfb_ms != null ? Math.round(p.ttfb_ms) + 'ms' : '<span style="color:var(--text-muted)">—</span>'}</td>`;
                    if (k === 'dom_elements') return `<td style="text-align:center;${domColor(p.dom_elements)}">${p.dom_elements || '<span style="color:var(--text-muted)">—</span>'}</td>`;
                    if (k === 'total_images') return `<td style="text-align:center">${p.total_images || 0}</td>`;
                    if (k === 'render_blocking') return `<td style="text-align:center;${blockColor(p.render_blocking)}">${p.render_blocking || 0}</td>`;
                    return '<td>—</td>';
                };

                // Build rows with data-index for tooltip wiring
                const pageRows = pages.map((p, idx) => {
                    const issues = _pageIssues(p);
                    const issueCount = issues.length;
                    const rowStyle = issueCount > 0 ? 'cursor:help' : '';
                    return `<tr data-page-idx="${idx}" style="${rowStyle}">${visCols.map(c => renderCell(p, c)).join('')}</tr>`;
                }).join('');

                const tableId = `audit-page-table-${auditId}`;
                pageTableHtml = `
                    <h3 style="margin:20px 0 8px;font-size:14px">Page-by-Page Results</h3>
                    <div style="overflow-x:auto;max-height:400px;overflow-y:auto;position:relative" id="${tableId}-wrap">
                        <table id="${tableId}" class="data-table" style="width:100%;min-width:500px">
                            <thead><tr>${thCells}</tr></thead>
                            <tbody>${pageRows}</tbody>
                        </table>
                        <div id="${tableId}-tooltip" style="display:none;position:absolute;z-index:10;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:10px 14px;box-shadow:0 4px 12px rgba(0,0,0,.15);max-width:360px;pointer-events:none"></div>
                    </div>
                `;

                // Stash page issues for tooltip wiring after DOM insert
                WP.Agents._auditPageIssues = pages.map(p => _pageIssues(p));
                WP.Agents._auditTableId = tableId;
            }

            // Server health
            let serverHtml = '';
            if (Object.keys(serverMetrics).length) {
                const sm = serverMetrics;
                const cacheIcon = sm.page_cache_detected && sm.page_cache_detected !== 'none' ? '\u2705' : '\u274C';
                const objIcon = sm.object_cache ? '\u2705' : '\u274C';
                serverHtml = `
                    <h3 style="margin:20px 0 8px;font-size:14px">Server Health</h3>
                    <div style="display:flex;gap:8px;flex-wrap:wrap">
                        <div style="flex:1;min-width:120px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:12px">
                            <div style="color:var(--text-muted);margin-bottom:4px">Page Cache</div>
                            <div style="font-weight:600">${cacheIcon} ${sm.page_cache_detected || 'none'}</div>
                        </div>
                        <div style="flex:1;min-width:120px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:12px">
                            <div style="color:var(--text-muted);margin-bottom:4px">Object Cache</div>
                            <div style="font-weight:600">${objIcon} ${sm.object_cache_type || (sm.object_cache ? 'Yes' : 'No')}</div>
                        </div>
                        <div style="flex:1;min-width:120px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:12px">
                            <div style="color:var(--text-muted);margin-bottom:4px">Plugins</div>
                            <div style="font-weight:600">${sm.active_plugin_count || '?'} active</div>
                        </div>
                        <div style="flex:1;min-width:120px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:12px">
                            <div style="color:var(--text-muted);margin-bottom:4px">PHP / WP</div>
                            <div style="font-weight:600">${sm.php_version || '?'} / ${sm.wp_version || '?'}</div>
                        </div>
                        <div style="flex:1;min-width:120px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:12px">
                            <div style="color:var(--text-muted);margin-bottom:4px">Autoload</div>
                            <div style="font-weight:600">${sm.autoload_size_bytes ? Math.round(sm.autoload_size_bytes / 1024) + 'KB' : '?'}</div>
                        </div>
                        <div style="flex:1;min-width:120px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:12px">
                            <div style="color:var(--text-muted);margin-bottom:4px">Revisions</div>
                            <div style="font-weight:600">${sm.revision_count != null ? sm.revision_count.toLocaleString() : '?'}</div>
                        </div>
                    </div>
                `;
            }

            const critCount = findings.filter(f => f.severity === 'critical').length;
            const highCount = findings.filter(f => f.severity === 'high').length;

            // Score circle — N/A in gray when null
            const scoreCircle = score != null
                ? `<div style="display:inline-block;width:90px;height:90px;border-radius:50%;
                    border:5px solid ${scoreColor};line-height:90px;font-size:32px;font-weight:700;
                    color:${scoreColor}">${score}</div>`
                : `<div style="display:inline-block;width:90px;height:90px;border-radius:50%;
                    border:5px solid #636e72;line-height:90px;font-size:22px;font-weight:700;
                    color:#636e72" title="PageSpeed Insights data unavailable">N/A</div>`;

            panel.innerHTML = `
                <div class="agent-config-panel" style="max-width:100%">
                    <div class="acp-header">
                        <div>
                            <div class="acp-name">Audit Results \u2014 ${auditDate}</div>
                            <div class="acp-sub">
                                ${audit.pages_audited || 0} pages &middot;
                                ${findings.length} issues (${critCount} critical, ${highCount} high)
                                ${durationStr ? ' &middot; ' + durationStr : ''}
                                ${audit.report_sent ? ' &middot; Email sent' : ''}
                            </div>
                        </div>
                        <button class="acp-close" onclick="WP.Agents.viewScans('${backAgent}')">&larr; Back</button>
                    </div>
                    <div class="acp-body" style="display:block;padding:16px">
                        <div style="text-align:center;margin-bottom:16px">
                            ${scoreCircle}
                            <div style="font-size:12px;color:var(--text-muted);margin-top:6px">Performance Score</div>
                        </div>
                        ${cwvHtml}
                        ${findingsHtml}
                        ${pageTableHtml}
                        ${serverHtml}
                    </div>
                </div>
            `;

            // Wire up sortable table headers + hover tooltips
            if (pages.length) {
                const tableId = `audit-page-table-${auditId}`;
                const table = document.getElementById(tableId);
                if (table) {
                    // Sort
                    const headers = table.querySelectorAll('thead th[data-sort-key]');
                    let sortState = { key: null, asc: true };
                    headers.forEach(th => {
                        th.addEventListener('click', () => {
                            const key = th.dataset.sortKey;
                            if (sortState.key === key) sortState.asc = !sortState.asc;
                            else { sortState.key = key; sortState.asc = false; }

                            const tbody = table.querySelector('tbody');
                            const rows = Array.from(tbody.querySelectorAll('tr'));
                            const colIdx = Array.from(th.parentNode.children).indexOf(th);

                            rows.sort((a, b) => {
                                const aText = a.children[colIdx]?.textContent?.trim() || '';
                                const bText = b.children[colIdx]?.textContent?.trim() || '';
                                const aNum = parseFloat(aText);
                                const bNum = parseFloat(bText);
                                const aVal = isNaN(aNum) ? aText.toLowerCase() : aNum;
                                const bVal = isNaN(bNum) ? bText.toLowerCase() : bNum;
                                const aEmpty = aText === '—' || aText === 'N/A' || aText === '';
                                const bEmpty = bText === '—' || bText === 'N/A' || bText === '';
                                if (aEmpty && !bEmpty) return 1;
                                if (!aEmpty && bEmpty) return -1;
                                if (aVal < bVal) return sortState.asc ? -1 : 1;
                                if (aVal > bVal) return sortState.asc ? 1 : -1;
                                return 0;
                            });

                            rows.forEach(r => tbody.appendChild(r));
                            headers.forEach(h => {
                                const arrow = h.querySelector('span');
                                if (arrow) arrow.innerHTML = h === th ? (sortState.asc ? '&#9650;' : '&#9660;') : '&#8597;';
                            });
                        });
                    });

                    // Hover tooltips — per-page issue list
                    const tooltip = document.getElementById(`${tableId}-tooltip`);
                    const wrap = document.getElementById(`${tableId}-wrap`);
                    const pageIssueData = WP.Agents._auditPageIssues || [];
                    if (tooltip && wrap) {
                        const rows = table.querySelectorAll('tbody tr[data-page-idx]');
                        rows.forEach(row => {
                            row.addEventListener('mouseenter', (e) => {
                                const idx = parseInt(row.dataset.pageIdx);
                                const issues = pageIssueData[idx] || [];
                                if (!issues.length) { tooltip.style.display = 'none'; return; }
                                const pageLabel = pages[idx]?.label || 'Page';
                                const bullets = issues.map(iss => `<li style="margin:3px 0">${WP.stripHtml(iss)}</li>`).join('');
                                tooltip.innerHTML = `
                                    <div style="font-weight:600;font-size:12px;margin-bottom:6px;color:var(--text-primary)">Issues on ${WP.stripHtml(pageLabel)}</div>
                                    <ul style="margin:0;padding-left:18px;font-size:11px;color:var(--text-muted);list-style:disc">${bullets}</ul>
                                `;
                                // Position below the row
                                const rowRect = row.getBoundingClientRect();
                                const wrapRect = wrap.getBoundingClientRect();
                                tooltip.style.display = 'block';
                                tooltip.style.left = Math.min(
                                    Math.max(0, rowRect.left - wrapRect.left),
                                    wrapRect.width - tooltip.offsetWidth
                                ) + 'px';
                                tooltip.style.top = (rowRect.bottom - wrapRect.top + wrap.scrollTop + 4) + 'px';
                            });
                            row.addEventListener('mouseleave', () => {
                                tooltip.style.display = 'none';
                            });
                        });
                    }
                }
            }
        } catch (e) {
            panel.innerHTML = `<div class="agent-config-panel"><div class="acp-body" style="color:var(--red);padding:20px">Failed to load audit: ${e.message || e}</div></div>`;
        }
    },

    closeResults() {
        WP.Agents._stopPolling();
        const panel = document.getElementById('agent-results-panel');
        if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
    },
};
