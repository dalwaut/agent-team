/**
 * OPAI Agent Studio — Interactive Guide / Onboarding Tour.
 *
 * Multi-slide walkthrough that teaches:
 *  0. Welcome + what Agent Studio is
 *  1. Core concepts (Agents, Squads, Prompts)
 *  2. How the execution model works
 *  3. Agent categories reference
 *  4. Interactive: Create agent — Identity
 *  5. Interactive: Create agent — Prompt
 *  6. Interactive: Create agent — Review & Create
 *  7. You're all set! (success + CLI reference)
 *
 * Auto-shows on first visit (localStorage flag).
 * Re-triggerable via the Help button in the header.
 */

const Guide = (() => {
    const STORAGE_KEY = 'opai-agents-guide-seen';
    let currentSlide = 0;

    // ── Form state ──────────────────────────────────────
    let agentFormData = {};
    let createdAgentId = null;
    let _promptManuallyEdited = false;

    const PROMPT_STARTERS = {
        quality: 'You are the {{name}} agent. Your job is to audit the codebase for quality issues.\n\nTasks:\n1. Check for code consistency and style violations\n2. Identify error handling gaps\n3. Flag unused variables and dead code\n4. Review naming conventions\n\nOutput a markdown report with findings grouped by severity (critical, warning, info).',
        planning: 'You are the {{name}} agent. Your job is to analyze the project and propose architectural plans.\n\nTasks:\n1. Review the current architecture\n2. Identify areas for improvement\n3. Propose implementation steps with clear dependencies\n4. Estimate complexity for each change\n\nOutput a markdown report with a prioritized plan.',
        research: 'You are the {{name}} agent. Your job is to research best practices and solutions.\n\nTasks:\n1. Survey current dependencies and their health\n2. Identify newer alternatives or upgrades\n3. Research industry best practices for the project domain\n4. Compile actionable recommendations\n\nOutput a markdown report with findings and recommendations.',
        operations: 'You are the {{name}} agent. Your job is to maintain workspace health and organization.\n\nTasks:\n1. Scan for structural issues (orphaned files, naming inconsistencies)\n2. Verify configuration files are valid and up to date\n3. Check cross-references between systems\n4. Flag items needing human attention\n\nOutput a markdown report with findings and suggested actions.',
        leadership: 'You are the {{name}} agent. Your job is to consolidate reports from other agents and build an action plan.\n\nTasks:\n1. Read all reports in reports/latest/\n2. Identify the highest-priority findings\n3. Group related items into workstreams\n4. Produce a prioritized implementation plan\n\nOutput a markdown plan with clear next steps.',
        content: 'You are the {{name}} agent. Your job is to produce written content for the project.\n\nTasks:\n1. Review recent changes and features\n2. Draft changelog entries\n3. Update user-facing documentation\n4. Prepare release notes\n\nOutput a markdown document with polished content ready for publication.',
        execution: 'You are the {{name}} agent. Your job is to automatically apply safe fixes to the codebase.\n\nTasks:\n1. Read reports from other agents\n2. Identify fixes that are non-breaking and low-risk\n3. Apply those fixes directly\n4. Document every change made\n\nOutput a markdown report listing all changes applied.',
        meta: 'You are the {{name}} agent. Your job is to assess the agent team itself.\n\nTasks:\n1. Review the current agent roster and their coverage\n2. Identify capability gaps\n3. Propose new agents or squad adjustments\n4. Evaluate prompt quality across agents\n\nOutput a markdown report with team improvement recommendations.',
        orchestration: 'You are the {{name}} agent. Your job is to route actions from reports to the right handlers.\n\nTasks:\n1. Read all latest reports\n2. Extract actionable items\n3. Classify each as AGENT-READY, HUMAN-REQUIRED, or BLOCKED\n4. Generate instruction files for the next processing step\n\nOutput a markdown manifest with classified actions.',
    };

    function _defaultFormData() {
        return {
            id: 'docs_checker',
            name: 'Documentation Checker',
            emoji: 'DC',
            category: 'quality',
            description: 'Validates documentation completeness and accuracy across the project.',
            prompt_content: '',
            run_order: 'parallel',
        };
    }

    // ── Slide definitions ───────────────────────────────

    const slides = [
        // ── 0: Welcome ──────────────────────────────
        {
            title: 'Welcome to Agent Studio',
            content: `
                <div class="guide-hero">
                    <div class="guide-icon-large">🧬</div>
                    <p class="guide-intro">Agent Studio is your command center for creating, managing, and orchestrating AI agent teams.</p>
                </div>
                <div class="guide-features">
                    <div class="guide-feat"><span class="gf-icon">🤖</span><div><strong>Create Agents</strong><span>Define specialist AI roles with custom prompts</span></div></div>
                    <div class="guide-feat"><span class="gf-icon">👥</span><div><strong>Build Squads</strong><span>Group agents into execution teams</span></div></div>
                    <div class="guide-feat"><span class="gf-icon">⚡</span><div><strong>Run & Monitor</strong><span>Execute squads and review agent reports</span></div></div>
                </div>
            `,
        },
        // ── 1: Core Concepts ─────────────────────────
        {
            title: 'Core Concepts',
            content: `
                <div class="guide-concepts">
                    <div class="guide-concept">
                        <div class="gc-header"><span class="gc-num">1</span><h3>Agent</h3></div>
                        <p>A single <strong>specialist AI role</strong> — like a Security Analyst, Code Reviewer, or Feature Architect. Each agent has:</p>
                        <ul>
                            <li><strong>Prompt</strong> — the instruction sent to Claude CLI telling the agent what to do</li>
                            <li><strong>Category</strong> — its specialty area (quality, planning, research, operations, etc.)</li>
                            <li><strong>Run Order</strong> — when it executes relative to other agents</li>
                        </ul>
                    </div>
                    <div class="guide-concept">
                        <div class="gc-header"><span class="gc-num">2</span><h3>Squad</h3></div>
                        <p>A <strong>named group of agents</strong> that execute together for a specific purpose. Examples:</p>
                        <ul>
                            <li><strong>audit</strong> — runs accuracy, health, security, and UX reviewers</li>
                            <li><strong>ship</strong> — pre-release checks with tests, security, and changelog generation</li>
                            <li><strong>review</strong> — post-change code review with accuracy and test validation</li>
                        </ul>
                    </div>
                    <div class="guide-concept">
                        <div class="gc-header"><span class="gc-num">3</span><h3>Prompt</h3></div>
                        <p>The <strong>text instruction</strong> that tells an agent exactly what to do. It gets piped to <code>claude -p</code> (Claude CLI). A good prompt includes:</p>
                        <ul>
                            <li>Clear role definition ("You are the Security Analyst...")</li>
                            <li>Specific tasks and checklist items</li>
                            <li>Output format instructions (markdown report)</li>
                        </ul>
                    </div>
                </div>
            `,
        },
        // ── 2: Execution Model ───────────────────────
        {
            title: 'How Execution Works',
            content: `
                <p class="guide-body">When a squad runs, agents execute in a specific order based on their <strong>run order</strong> setting:</p>
                <div class="guide-exec-diagram">
                    <div class="exec-phase">
                        <div class="ep-label">Phase 1</div>
                        <div class="ep-title">First</div>
                        <div class="ep-desc">Setup agents run one at a time.<br>Example: <em>familiarizer</em> scans the project.</div>
                    </div>
                    <div class="exec-arrow-big">&rarr;</div>
                    <div class="exec-phase phase-parallel">
                        <div class="ep-label">Phase 2</div>
                        <div class="ep-title">Parallel</div>
                        <div class="ep-desc">Multiple agents run concurrently.<br>Example: <em>security</em>, <em>accuracy</em>, <em>health</em> all audit at once.</div>
                    </div>
                    <div class="exec-arrow-big">&rarr;</div>
                    <div class="exec-phase">
                        <div class="ep-label">Phase 3</div>
                        <div class="ep-title">Last</div>
                        <div class="ep-desc">Summary agents read all reports.<br>Example: <em>manager</em> consolidates findings into a plan.</div>
                    </div>
                </div>
                <div class="guide-callout">
                    <strong>Report Passing:</strong> Each agent writes a markdown report. "Last" agents (like the Manager) read all previous reports to build consolidated action plans. This is how agents collaborate without talking to each other directly.
                </div>
            `,
        },
        // ── 3: Agent Categories ──────────────────────
        {
            title: 'Agent Categories',
            content: `
                <p class="guide-body">Every agent belongs to a category that describes its specialty. Here are the categories available:</p>
                <div class="guide-cat-grid">
                    <div class="guide-cat"><span class="gc-dot" style="background:#10b981"></span><strong>quality</strong><span>Code review, accuracy, health, security, UX, testing</span></div>
                    <div class="guide-cat"><span class="gc-dot" style="background:#3b82f6"></span><strong>planning</strong><span>Feature architecture, integration blueprints</span></div>
                    <div class="guide-cat"><span class="gc-dot" style="background:#f59e0b"></span><strong>research</strong><span>Technical research, problem solving</span></div>
                    <div class="guide-cat"><span class="gc-dot" style="background:#8b5cf6"></span><strong>operations</strong><span>GitHub, email, notes, workspace maintenance</span></div>
                    <div class="guide-cat"><span class="gc-dot" style="background:#ef4444"></span><strong>leadership</strong><span>Project management, consolidation</span></div>
                    <div class="guide-cat"><span class="gc-dot" style="background:#ec4899"></span><strong>content</strong><span>Changelogs, app store copy, social posts</span></div>
                    <div class="guide-cat"><span class="gc-dot" style="background:#06b6d4"></span><strong>execution</strong><span>Auto-apply safe fixes or all improvements</span></div>
                    <div class="guide-cat"><span class="gc-dot" style="background:#64748b"></span><strong>meta</strong><span>Self-assessment, team evolution</span></div>
                    <div class="guide-cat"><span class="gc-dot" style="background:#f97316"></span><strong>orchestration</strong><span>Report dispatch, action routing</span></div>
                </div>
            `,
        },
        // ── 4: Create — Identity ─────────────────────
        {
            title: 'Create Your First Agent',
            content: '', // rendered dynamically
        },
        // ── 5: Create — Prompt ───────────────────────
        {
            title: 'Write the Prompt',
            content: '', // rendered dynamically
        },
        // ── 6: Create — Review & Create ──────────────
        {
            title: 'Review & Create',
            content: '', // rendered dynamically
        },
        // ── 7: You're All Set ────────────────────────
        {
            title: "You're All Set!",
            content: '', // rendered dynamically
        },
    ];

    // ── Form helpers ────────────────────────────────────

    function _esc(s) { return typeof esc === 'function' ? esc(s) : s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

    function _updateField(field, value) {
        if (field === 'id') {
            value = value.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
        }
        agentFormData[field] = value;
        // Sync ID display if editing name and ID hasn't been manually changed
        if (field === 'name' && agentFormData.id === _defaultFormData().id) {
            agentFormData.id = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
            const idInput = document.getElementById('guide-agent-id');
            if (idInput) idInput.value = agentFormData.id;
        }
        // Category change → update prompt starter if not manually edited
        if (field === 'category' && !_promptManuallyEdited) {
            const starter = PROMPT_STARTERS[value] || PROMPT_STARTERS.quality;
            agentFormData.prompt_content = starter.replace(/\{\{name\}\}/g, agentFormData.name || 'Agent');
            const ta = document.getElementById('guide-prompt-editor');
            if (ta) {
                ta.value = agentFormData.prompt_content;
                _updateCharCount();
            }
        }
    }

    function _onEmojiPick(val) {
        if (val) {
            agentFormData.emoji = val;
            const textInput = document.getElementById('guide-agent-emoji');
            if (textInput) textInput.value = val;
        }
        const picker = document.getElementById('guide-emoji-picker');
        if (picker) picker.value = '';
    }

    function _setRunOrder(order) {
        agentFormData.run_order = order;
        document.querySelectorAll('#guide-content .radio-card').forEach(card => {
            card.classList.toggle('active', card.dataset.order === order);
        });
    }

    function _insertVar(varName) {
        const ta = document.getElementById('guide-prompt-editor');
        if (!ta) return;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const text = ta.value;
        const insert = '{{' + varName + '}}';
        ta.value = text.substring(0, start) + insert + text.substring(end);
        ta.selectionStart = ta.selectionEnd = start + insert.length;
        ta.focus();
        agentFormData.prompt_content = ta.value;
        _promptManuallyEdited = true;
        _updateCharCount();
    }

    function _updateCharCount() {
        const el = document.getElementById('guide-char-count');
        if (el) el.textContent = (agentFormData.prompt_content || '').length + ' characters';
    }

    async function createAgent() {
        const d = agentFormData;
        // Validate required fields
        if (!d.id || !d.id.trim()) { toast('Agent ID is required', 'error'); return; }
        if (!d.name || !d.name.trim()) { toast('Agent name is required', 'error'); return; }
        if (!/^[a-z0-9_]+$/.test(d.id)) { toast('ID must be lowercase letters, numbers, and underscores only', 'error'); return; }
        // Check for duplicates
        if (State.agents.some(a => a.id === d.id)) { toast('An agent with ID "' + d.id + '" already exists', 'error'); return; }

        try {
            const btn = document.getElementById('guide-create-btn');
            if (btn) { btn.disabled = true; btn.textContent = 'Creating...'; }
            await apiFetch('/agents', {
                method: 'POST',
                body: JSON.stringify({
                    id: d.id.trim(),
                    name: d.name.trim(),
                    emoji: (d.emoji || '').trim() || d.name.substring(0, 2).toUpperCase(),
                    category: d.category || 'quality',
                    description: (d.description || '').trim(),
                    run_order: d.run_order || 'parallel',
                    prompt_content: (d.prompt_content || '').trim(),
                    depends_on: [],
                }),
            });
            await loadAll();
            createdAgentId = d.id;
            toast('Agent "' + d.name + '" created!', 'success');
            next();
        } catch (e) {
            toast('Failed to create agent: ' + e.message, 'error');
            const btn = document.getElementById('guide-create-btn');
            if (btn) { btn.disabled = false; btn.textContent = 'Create Agent'; }
        }
    }

    // ── Slide renderers ─────────────────────────────────

    function _renderSlide4() {
        const d = agentFormData;
        const catOptions = (State.categories.length ? State.categories : ['quality','planning','research','operations','leadership','content','execution','meta','orchestration'])
            .map(c => '<option value="' + c + '"' + (c === d.category ? ' selected' : '') + '>' + c + '</option>').join('');

        return `
            <p class="guide-body">Let's create an agent right here. Fill in the identity fields below — all are optional, you can always edit later.</p>
            <div class="guide-form-grid">
                <div class="form-group">
                    <label>Agent ID</label>
                    <input type="text" id="guide-agent-id" value="${_esc(d.id)}" placeholder="e.g. docs_checker"
                        oninput="Guide._updateField('id', this.value)">
                </div>
                <div class="form-group">
                    <label>Emoji / Short Code</label>
                    <div class="emoji-input-group">
                        <select id="guide-emoji-picker" onchange="Guide._onEmojiPick(this.value)">
                            <option value="">Pick emoji...</option>
                            <option value="🤖">🤖 Robot</option>
                            <option value="🔍">🔍 Search</option>
                            <option value="🛡️">🛡️ Shield</option>
                            <option value="⚡">⚡ Lightning</option>
                            <option value="📊">📊 Chart</option>
                            <option value="📝">📝 Memo</option>
                            <option value="🧪">🧪 Test Tube</option>
                            <option value="🔧">🔧 Wrench</option>
                            <option value="🎯">🎯 Target</option>
                            <option value="📦">📦 Package</option>
                            <option value="🧹">🧹 Broom</option>
                            <option value="📚">📚 Books</option>
                            <option value="🚀">🚀 Rocket</option>
                            <option value="💡">💡 Lightbulb</option>
                            <option value="🔒">🔒 Lock</option>
                            <option value="📋">📋 Clipboard</option>
                            <option value="🎨">🎨 Palette</option>
                            <option value="🧬">🧬 DNA</option>
                            <option value="📈">📈 Trending Up</option>
                            <option value="🗂️">🗂️ File Cabinet</option>
                            <option value="✅">✅ Check</option>
                            <option value="⚙️">⚙️ Gear</option>
                            <option value="🏗️">🏗️ Construction</option>
                            <option value="📡">📡 Satellite</option>
                            <option value="🧠">🧠 Brain</option>
                            <option value="👁️">👁️ Eye</option>
                            <option value="📮">📮 Mailbox</option>
                            <option value="🔄">🔄 Refresh</option>
                            <option value="🌐">🌐 Globe</option>
                            <option value="💬">💬 Chat</option>
                        </select>
                        <input type="text" id="guide-agent-emoji" value="${_esc(d.emoji)}" placeholder="or type code" maxlength="4"
                            oninput="Guide._updateField('emoji', this.value)">
                    </div>
                </div>
                <div class="form-group">
                    <label>Display Name</label>
                    <input type="text" id="guide-agent-name" value="${_esc(d.name)}" placeholder="e.g. Documentation Checker"
                        oninput="Guide._updateField('name', this.value)">
                </div>
                <div class="form-group">
                    <label>Category</label>
                    <select id="guide-agent-category" onchange="Guide._updateField('category', this.value)">
                        ${catOptions}
                    </select>
                </div>
            </div>
            <div class="form-group">
                <label>Description</label>
                <input type="text" id="guide-agent-desc" value="${_esc(d.description)}" placeholder="What does this agent do?"
                    oninput="Guide._updateField('description', this.value)">
            </div>
            <div class="guide-callout">
                <strong>Tip:</strong> The Agent ID becomes the filename (<code>prompt_docs_checker.txt</code>) and the key in <code>team.json</code>. Use lowercase with underscores.
            </div>
        `;
    }

    function _renderSlide5() {
        const d = agentFormData;
        // Auto-populate prompt from category if empty
        if (!d.prompt_content) {
            const starter = PROMPT_STARTERS[d.category] || PROMPT_STARTERS.quality;
            d.prompt_content = starter.replace(/\{\{name\}\}/g, d.name || 'Agent');
        }

        return `
            <div class="guide-prompt-layout">
                <div class="guide-tips-panel">
                    <h4>Prompt Writing Tips</h4>
                    <div class="guide-tip"><strong>Start with a role</strong><br>"You are the [Name] agent. Your job is to..."</div>
                    <div class="guide-tip"><strong>Be specific</strong><br>List numbered tasks the agent should perform</div>
                    <div class="guide-tip"><strong>Define output</strong><br>Tell the agent to output a markdown report</div>
                    <div class="guide-tip"><strong>Use variables</strong><br>Click chips below to insert template vars</div>
                </div>
                <div class="guide-prompt-editor-wrap">
                    <div class="prompt-hints">
                        <span class="chip" onclick="Guide._insertVar('project_root')">{{project_root}}</span>
                        <span class="chip" onclick="Guide._insertVar('reports_dir')">{{reports_dir}}</span>
                        <span class="chip" onclick="Guide._insertVar('timestamp')">{{timestamp}}</span>
                    </div>
                    <textarea id="guide-prompt-editor" class="prompt-editor" rows="12"
                        oninput="Guide._onPromptInput(this.value)"
                        placeholder="Write the instruction that Claude will receive...">${_esc(d.prompt_content)}</textarea>
                    <div class="guide-char-count" id="guide-char-count">${(d.prompt_content || '').length} characters</div>
                </div>
            </div>
        `;
    }

    function _renderSlide6() {
        const d = agentFormData;
        const preview = {
            id: d.id,
            name: d.name,
            emoji: d.emoji || d.name.substring(0, 2).toUpperCase(),
            category: d.category,
            description: d.description,
            run_order: d.run_order,
        };
        const promptPreview = (d.prompt_content || '').length > 200
            ? d.prompt_content.substring(0, 200) + '...'
            : (d.prompt_content || '(no prompt)');

        return `
            <p class="guide-body">Choose when this agent runs, then review the config and create it.</p>
            <div class="form-group">
                <label>Run Order</label>
                <div class="radio-group">
                    <div class="radio-card${d.run_order === 'parallel' ? ' active' : ''}" data-order="parallel" onclick="Guide._setRunOrder('parallel')">
                        <strong>Parallel</strong>
                        <span>Runs concurrently with other parallel agents. Best for most agents.</span>
                    </div>
                    <div class="radio-card${d.run_order === 'first' ? ' active' : ''}" data-order="first" onclick="Guide._setRunOrder('first')">
                        <strong>First</strong>
                        <span>Runs before all others. Use for setup or scanning agents.</span>
                    </div>
                    <div class="radio-card${d.run_order === 'last' ? ' active' : ''}" data-order="last" onclick="Guide._setRunOrder('last')">
                        <strong>Last</strong>
                        <span>Runs after all others finish. Use for summary or manager agents.</span>
                    </div>
                </div>
            </div>
            <div class="review-section">
                <h3>Config Preview</h3>
                <div class="code-block">${_esc(JSON.stringify(preview, null, 2))}</div>
            </div>
            <div class="review-section">
                <h3>Prompt Preview</h3>
                <div class="code-block prompt-preview">${_esc(promptPreview)}</div>
            </div>
            <div class="guide-action-row">
                <button class="btn btn-primary" id="guide-create-btn" onclick="Guide.createAgent()">Create Agent</button>
                <button class="btn" onclick="Guide.next()">Skip for Now</button>
            </div>
        `;
    }

    function _renderSlide7() {
        let successCard = '';
        if (createdAgentId) {
            const agent = State.agents.find(a => a.id === createdAgentId);
            const name = agent ? agent.name : createdAgentId;
            const emoji = agent ? (agent.emoji || '?') : '?';
            successCard = `
                <div class="guide-success-card">
                    <div class="guide-success-emoji">${_esc(emoji)}</div>
                    <div>
                        <strong>${_esc(name)}</strong> has been created!
                        <br><a href="#" onclick="Guide.close(); switchView('agents'); return false;">View in Agents Tab &rarr;</a>
                    </div>
                </div>
            `;
        }

        return `
            ${successCard}
            <p class="guide-body">Here's the full flow from creation to execution:</p>
            <div class="guide-flow">
                <div class="gf-step">
                    <div class="gf-num">1</div>
                    <div><strong>Create agents</strong> with specialized prompts</div>
                </div>
                <div class="gf-arrow">&darr;</div>
                <div class="gf-step">
                    <div class="gf-num">2</div>
                    <div><strong>Group agents</strong> into squads</div>
                </div>
                <div class="gf-arrow">&darr;</div>
                <div class="gf-step">
                    <div class="gf-num">3</div>
                    <div><strong>Run a squad</strong> — agents execute and write reports</div>
                </div>
                <div class="gf-arrow">&darr;</div>
                <div class="gf-step">
                    <div class="gf-num">4</div>
                    <div><strong>Review reports</strong> in <code>reports/latest/</code></div>
                </div>
                <div class="gf-arrow">&darr;</div>
                <div class="gf-step">
                    <div class="gf-num">5</div>
                    <div><strong>Act on findings</strong> — fix issues, implement plans</div>
                </div>
            </div>
            <div class="guide-tips">
                <h4>Quick Reference</h4>
                <table class="guide-ref-table">
                    <tr><td>Run a squad (CLI)</td><td><code>./scripts/run_squad.ps1 -Squad "audit"</code></td></tr>
                    <tr><td>Run specific agents</td><td><code>./scripts/run_agents_seq.ps1 -Filter "accuracy,health"</code></td></tr>
                    <tr><td>Auto-fix (safe)</td><td><code>./scripts/run_auto.ps1 -Mode safe</code></td></tr>
                    <tr><td>Team roster</td><td><code>team.json</code></td></tr>
                    <tr><td>Agent prompts</td><td><code>scripts/prompt_*.txt</code></td></tr>
                    <tr><td>Reports</td><td><code>reports/latest/</code></td></tr>
                </table>
            </div>
            <div class="guide-callout guide-callout-accent">
                You can re-open this guide anytime using the <strong>? Help</strong> button in the header.
            </div>
        `;
    }

    // ── Prompt input handler ────────────────────────────

    function _onPromptInput(value) {
        agentFormData.prompt_content = value;
        _promptManuallyEdited = true;
        _updateCharCount();
    }

    // ── Navigation ──────────────────────────────────────

    function show() {
        currentSlide = 0;
        agentFormData = _defaultFormData();
        createdAgentId = null;
        _promptManuallyEdited = false;
        _render();
        document.getElementById('guide-overlay').classList.remove('hidden');
    }

    function close() {
        document.getElementById('guide-overlay').classList.add('hidden');
        localStorage.setItem(STORAGE_KEY, '1');
    }

    function next() {
        if (currentSlide < slides.length - 1) { currentSlide++; _render(); }
        else close();
    }

    function prev() {
        if (currentSlide > 0) { currentSlide--; _render(); }
    }

    function goTo(n) {
        if (n >= 0 && n < slides.length) { currentSlide = n; _render(); }
    }

    function _render() {
        const s = slides[currentSlide];
        document.getElementById('guide-title').textContent = s.title;

        // Dynamic content for interactive slides
        let content = s.content;
        if (currentSlide === 4) content = _renderSlide4();
        else if (currentSlide === 5) content = _renderSlide5();
        else if (currentSlide === 6) content = _renderSlide6();
        else if (currentSlide === 7) content = _renderSlide7();

        document.getElementById('guide-content').innerHTML = content;
        document.getElementById('guide-back').style.display = currentSlide > 0 ? '' : 'none';

        // Button label
        const isLast = currentSlide === slides.length - 1;
        const isReview = currentSlide === 6;
        document.getElementById('guide-next').textContent = isLast ? 'Get Started' : 'Next';
        // Hide Next on review slide (use Create/Skip buttons instead)
        document.getElementById('guide-next').style.display = isReview ? 'none' : '';

        // Progress dots
        document.getElementById('guide-dots').innerHTML = slides.map((_, i) =>
            '<span class="guide-dot' + (i === currentSlide ? ' active' : '') + '" onclick="Guide.goTo(' + i + ')"></span>'
        ).join('');

        // Counter
        document.getElementById('guide-counter').textContent = (currentSlide + 1) + ' / ' + slides.length;
    }

    function shouldAutoShow() {
        return !localStorage.getItem(STORAGE_KEY);
    }

    function init() {
        const overlay = document.createElement('div');
        overlay.id = 'guide-overlay';
        overlay.className = 'modal-overlay hidden';
        overlay.innerHTML = `
            <div class="modal guide-modal">
                <div class="guide-header">
                    <span class="guide-counter" id="guide-counter">1 / ${slides.length}</span>
                    <h2 id="guide-title"></h2>
                    <button class="btn-close" onclick="Guide.close()">&times;</button>
                </div>
                <div class="guide-body-wrap" id="guide-content"></div>
                <div class="guide-footer">
                    <button class="btn" id="guide-back" onclick="Guide.prev()" style="display:none">Back</button>
                    <div class="guide-dots" id="guide-dots"></div>
                    <button class="btn btn-primary" id="guide-next" onclick="Guide.next()">Next</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        if (shouldAutoShow()) show();
    }

    return { init, show, close, next, prev, goTo, createAgent, _updateField, _setRunOrder, _insertVar, _onPromptInput, _onEmojiPick };
})();
