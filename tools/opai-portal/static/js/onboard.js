/**
 * OPAI Onboarding Wizard — Client-side logic
 *
 * Handles the 5-step flow:
 * 1. Set password
 * 2. Storage info (informational)
 * 3. Profile setup (expertise, use case, tools, focus areas)
 * 4. Sandbox provisioning + progress
 * 5. Outcome display (workspace layout, agents, apps)
 */

(async function () {
    // ── Init Supabase ────────────────────────────────────────

    const cfgResp = await fetch('/auth/config');
    const cfg = await cfgResp.json();

    if (!cfg.supabase_url || !cfg.supabase_anon_key) {
        document.body.innerHTML = '<p style="color:#ef4444;text-align:center;padding:2rem;">Auth not configured</p>';
        return;
    }

    const sb = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);

    // Check session
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
        window.location.href = '/auth/login';
        return;
    }

    const user = session.user;
    const token = session.access_token;
    const authHeaders = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
    };

    // Keep token fresh
    sb.auth.onAuthStateChange((_event, sess) => {
        if (sess) {
            authHeaders['Authorization'] = `Bearer ${sess.access_token}`;
        }
    });

    // ── Check if already onboarded (before showing any UI) ───
    try {
        const statusResp = await fetch('/onboard/status', {
            headers: authHeaders,
        });
        if (statusResp.ok) {
            const statusData = await statusResp.json();
            if (statusData.onboarded) {
                window.location.href = '/';
                return;
            }
        }
    } catch (e) {
        // Continue with onboarding
    }

    // ── State ────────────────────────────────────────────────

    let currentStep = 0;
    let profileData = {
        expertise_level: null,
        primary_use_case: null,
        tools: [],
        focus_areas: [],
    };

    const totalSteps = 5;
    const stepDots = document.querySelectorAll('.step-dot');

    function showStep(n) {
        document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
        document.getElementById(`step-${n}`).classList.add('active');

        stepDots.forEach((dot, i) => {
            dot.classList.remove('active', 'done');
            if (i < n) dot.classList.add('done');
            if (i === n) dot.classList.add('active');
        });

        currentStep = n;
    }

    // ── Step 1: Password ─────────────────────────────────────

    const pwInput = document.getElementById('password');
    const pwConfirm = document.getElementById('password-confirm');
    const pwBar = document.getElementById('pw-bar');
    const pwError = document.getElementById('pw-error');
    const btnSetPw = document.getElementById('btn-set-password');

    pwInput.addEventListener('input', () => {
        const pw = pwInput.value;
        let strength = 0;
        if (pw.length >= 8) strength++;
        if (pw.length >= 12) strength++;
        if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) strength++;
        if (/[0-9]/.test(pw)) strength++;
        if (/[^A-Za-z0-9]/.test(pw)) strength++;

        const pct = Math.min(strength / 5 * 100, 100);
        pwBar.style.width = pct + '%';

        if (pct <= 40) pwBar.style.background = '#ef4444';
        else if (pct <= 70) pwBar.style.background = '#f59e0b';
        else pwBar.style.background = '#10b981';
    });

    btnSetPw.addEventListener('click', async () => {
        const pw = pwInput.value;
        const pwc = pwConfirm.value;

        pwError.classList.add('hidden');

        if (pw.length < 8) {
            pwError.textContent = 'Password must be at least 8 characters';
            pwError.classList.remove('hidden');
            return;
        }

        if (pw !== pwc) {
            pwError.textContent = 'Passwords do not match';
            pwError.classList.remove('hidden');
            return;
        }

        btnSetPw.disabled = true;
        btnSetPw.textContent = 'Setting password...';

        try {
            const { error } = await sb.auth.updateUser({ password: pw });
            if (error) {
                pwError.textContent = error.message;
                pwError.classList.remove('hidden');
                btnSetPw.disabled = false;
                btnSetPw.textContent = 'Set Password';
                return;
            }
            showStep(1);
        } catch (err) {
            pwError.textContent = 'Unexpected error: ' + err.message;
            pwError.classList.remove('hidden');
            btnSetPw.disabled = false;
            btnSetPw.textContent = 'Set Password';
        }
    });

    // Allow Enter key to submit password
    pwConfirm.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') btnSetPw.click();
    });

    // ── Step 2: Storage Info ─────────────────────────────────

    document.getElementById('btn-back-1').addEventListener('click', () => showStep(0));
    document.getElementById('btn-next-1').addEventListener('click', () => showStep(2));

    // ── Step 3: Profile ──────────────────────────────────────

    // Single-select grids
    function setupOptionGrid(gridId, dataKey) {
        const grid = document.getElementById(gridId);
        grid.querySelectorAll('.option-card').forEach(card => {
            card.addEventListener('click', () => {
                grid.querySelectorAll('.option-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                profileData[dataKey] = card.dataset.value;
            });
        });
    }

    // Multi-select grids
    function setupMultiSelectGrid(gridId, dataKey) {
        const grid = document.getElementById(gridId);
        grid.querySelectorAll('.option-card').forEach(card => {
            card.addEventListener('click', () => {
                card.classList.toggle('selected');
                profileData[dataKey] = Array.from(grid.querySelectorAll('.option-card.selected'))
                    .map(c => c.dataset.value);
            });
        });
    }

    setupOptionGrid('expertise-grid', 'expertise_level');
    setupOptionGrid('usecase-grid', 'primary_use_case');
    setupMultiSelectGrid('tools-grid', 'tools');
    setupMultiSelectGrid('focus-grid', 'focus_areas');

    document.getElementById('btn-back-2').addEventListener('click', () => showStep(1));
    document.getElementById('btn-next-2').addEventListener('click', () => {
        showStep(3);
        startProvisioning();
    });

    // ── Step 4: Provisioning ─────────────────────────────────

    function setProvIcon(id, state) {
        const el = document.getElementById(id);
        el.className = state; // 'pending', 'running', 'check'
        if (state === 'check') el.innerHTML = '&#10003;';
        else el.innerHTML = '&#9679;';
    }

    async function startProvisioning() {
        try {
            // Phase 1: Save profile answers
            setProvIcon('prov-sandbox-icon', 'running');

            await fetch(`/tasks/api/users/${user.id}/profile-setup`, {
                method: 'PUT',
                headers: authHeaders,
                body: JSON.stringify(profileData),
            });

            setProvIcon('prov-sandbox-icon', 'check');
            setProvIcon('prov-agents-icon', 'running');

            // Phase 2: Trigger sandbox provisioning
            const provResp = await fetch(`/tasks/api/users/${user.id}/provision-sandbox`, {
                method: 'POST',
                headers: authHeaders,
            });
            const provData = await provResp.json();

            if (!provResp.ok) {
                throw new Error(provData.detail || 'Provisioning failed');
            }

            setProvIcon('prov-agents-icon', 'check');
            setProvIcon('prov-config-icon', 'running');

            // Phase 3: Poll for completion
            let attempts = 0;
            const maxAttempts = 30;

            while (attempts < maxAttempts) {
                await new Promise(r => setTimeout(r, 2000));
                attempts++;

                try {
                    const statusResp = await fetch(`/tasks/api/users/${user.id}/sandbox-status`, {
                        headers: authHeaders,
                    });
                    const statusData = await statusResp.json();

                    if (statusData.provisioned) {
                        break;
                    }
                } catch (e) {
                    // Keep polling
                }
            }

            setProvIcon('prov-config-icon', 'check');
            setProvIcon('prov-config2-icon', 'running');

            // Small delay for wiki generation
            await new Promise(r => setTimeout(r, 1000));
            setProvIcon('prov-config2-icon', 'check');
            setProvIcon('prov-profile-icon', 'running');

            // Phase 4: Mark onboarding complete (retry up to 3 times)
            let completionSaved = false;
            for (let retry = 0; retry < 3; retry++) {
                try {
                    const saveResp = await fetch(`/tasks/api/users/${user.id}/profile-setup`, {
                        method: 'PUT',
                        headers: authHeaders,
                        body: JSON.stringify({
                            ...profileData,
                            onboarding_completed: true,
                        }),
                    });
                    if (saveResp.ok) {
                        completionSaved = true;
                        break;
                    }
                } catch (e) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }

            if (!completionSaved) {
                console.warn('Could not save onboarding completion flag');
            }

            setProvIcon('prov-profile-icon', 'check');

            // Mark all dots up to step 3 as done
            stepDots.forEach((d, i) => {
                if (i <= 3) { d.classList.remove('active'); d.classList.add('done'); }
            });

            // Build outcome display and show step 5
            buildOutcome(provData);
            showStep(4);

        } catch (err) {
            document.getElementById('step3-title').textContent = 'Setup Issue';
            document.getElementById('step3-desc').textContent =
                'There was a problem setting up your workspace: ' + err.message +
                '. Please contact your admin.';
            // Add a fallback button
            const fallbackBtn = document.createElement('div');
            fallbackBtn.className = 'btn-row';
            fallbackBtn.style.marginTop = '1rem';
            fallbackBtn.innerHTML = '<button class="btn-primary" onclick="window.location.href=\'/\'">Go to Dashboard Anyway</button>';
            document.getElementById('provision-status').after(fallbackBtn);
        }
    }

    // ── Step 5: Outcome Display ──────────────────────────────

    function buildOutcome(provData) {
        const displayName = user.user_metadata?.display_name || user.email?.split('@')[0] || 'User';
        const capName = displayName.charAt(0).toUpperCase() + displayName.slice(1);
        const sandboxPath = provData.sandbox_path || `/workspace/users/${capName}`;

        // Directory tree
        document.getElementById('outcome-tree').textContent =
`${sandboxPath}/
  CLAUDE.md            Source of truth
  files/               Personal storage (NAS)
  agents/
    team.json          Your agent roster
    prompts/           Agent behavior files
  scripts/
    run_agent.sh       Run a single agent
    run_squad.sh       Run a squad
    submit_task.sh     Submit to central queue
  reports/latest/      Agent output
  tasks/queue.json     Your task queue
  wiki/                Knowledge base
  config/              Settings & limits`;

        // Agent badges based on role
        const agentMap = {
            team: ['reviewer', 'researcher', 'features', 'health'],
            client: ['reviewer', 'researcher'],
            user: ['reviewer'],
        };
        const role = user.user_metadata?.role || 'team';
        const agents = agentMap[role] || agentMap.team;
        const agentsEl = document.getElementById('outcome-agents');
        agentsEl.innerHTML = agents.map(a =>
            `<span class="agent-badge">${a}</span>`
        ).join('');

        // App badges
        const apps = ['OPAI Chat', 'Messenger', 'File Storage', 'Agent Runner'];
        const appsEl = document.getElementById('outcome-apps');
        appsEl.innerHTML = apps.map(a =>
            `<span class="app-badge">${a}</span>`
        ).join('');
    }

    document.getElementById('btn-finish').addEventListener('click', () => {
        window.location.href = '/';
    });
})();
