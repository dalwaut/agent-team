/**
 * Eliza Hub — wizard.js
 * 7-step onboarding wizard for creating new agents.
 */

let wizardStep = 0;
const wizardData = {
  name: '', slug: '', avatar: '', description: '',
  bio: '', system: '', examples: '',
  platforms: [], platformTokens: {},
  knowledgeBranches: [], newBranchName: '',
  infoLayer: 'public', maxLength: 4096, blockedTopics: '', escalationTriggers: '',
  deploymentTier: 'local', rateLimitRpm: 60, rateLimitDaily: 1000,
  model: 'claude-sonnet-4-6', temperature: 0.7,
};

const WIZARD_STEPS = [
  { label: 'Identity', icon: '1' },
  { label: 'Personality', icon: '2' },
  { label: 'Platforms', icon: '3' },
  { label: 'Knowledge', icon: '4' },
  { label: 'Safety', icon: '5' },
  { label: 'Deployment', icon: '6' },
  { label: 'Review', icon: '7' },
];

function openWizard() {
  wizardStep = 0;
  Object.assign(wizardData, {
    name: '', slug: '', avatar: '', description: '',
    bio: '', system: '', examples: '',
    platforms: [], platformTokens: {},
    knowledgeBranches: [], newBranchName: '',
    infoLayer: 'public', maxLength: 4096, blockedTopics: '', escalationTriggers: '',
    deploymentTier: 'local', rateLimitRpm: 60, rateLimitDaily: 1000,
    model: 'claude-sonnet-4-6', temperature: 0.7,
  });
  renderWizard();
  document.getElementById('wizard-overlay').style.display = 'flex';
}

function closeWizard() {
  document.getElementById('wizard-overlay').style.display = 'none';
}

function renderWizard() {
  const panel = document.getElementById('wizard-panel');
  const progress = WIZARD_STEPS.map((s, i) => {
    const cls = i < wizardStep ? 'done' : i === wizardStep ? 'active' : '';
    return `<div class="ez-wizard-step ${cls}"></div>`;
  }).join('');

  panel.innerHTML = `
    <div class="ez-wizard-header">
      <div class="ez-wizard-title">Create New Agent</div>
      <button class="ez-detail-close" onclick="closeWizard()">&#x2715;</button>
    </div>
    <div class="ez-wizard-progress">${progress}</div>
    <div class="ez-wizard-step-label">Step ${wizardStep + 1}: ${WIZARD_STEPS[wizardStep].label}</div>
    <div class="ez-wizard-body">${renderWizardStep()}</div>
    <div class="ez-wizard-footer">
      <button class="ez-btn ez-btn-secondary" onclick="${wizardStep === 0 ? 'closeWizard()' : 'wizardPrev()'}">${wizardStep === 0 ? 'Cancel' : 'Back'}</button>
      <button class="ez-btn ez-btn-primary" onclick="${wizardStep === WIZARD_STEPS.length - 1 ? 'wizardDeploy()' : 'wizardNext()'}">${wizardStep === WIZARD_STEPS.length - 1 ? 'Deploy Agent' : 'Next'}</button>
    </div>
  `;
}

function renderWizardStep() {
  switch (wizardStep) {
    case 0: return `
      <div class="ez-form-group"><label>Agent Name *</label><input class="ez-input" id="wiz-name" value="${escHtml(wizardData.name)}" placeholder="e.g., SalesBot"></div>
      <div class="ez-form-group"><label>Slug (auto-generated)</label><input class="ez-input" id="wiz-slug" value="${escHtml(wizardData.slug)}" placeholder="auto from name" style="color:var(--text-dim)"></div>
      <div class="ez-form-group"><label>Avatar (emoji or initial)</label><input class="ez-input" id="wiz-avatar" value="${escHtml(wizardData.avatar)}" placeholder="e.g., S or emoji"></div>
      <div class="ez-form-group"><label>Description</label><input class="ez-input" id="wiz-description" value="${escHtml(wizardData.description)}" placeholder="Short description of this agent"></div>
    `;
    case 1: return `
      <div class="ez-form-group"><label>Bio / Backstory</label><textarea class="ez-textarea" id="wiz-bio" placeholder="Who is this agent? Background, personality...">${escHtml(wizardData.bio)}</textarea></div>
      <div class="ez-form-group"><label>System Prompt</label><textarea class="ez-textarea" id="wiz-system" placeholder="System instructions for the agent..." style="min-height:120px">${escHtml(wizardData.system)}</textarea></div>
      <div class="ez-form-group"><label>Example Responses (one per line)</label><textarea class="ez-textarea" id="wiz-examples" placeholder="Example response 1\nExample response 2">${escHtml(wizardData.examples)}</textarea></div>
    `;
    case 2: return `
      <p style="font-size:13px;color:var(--text-dim);margin-bottom:16px">Select platforms this agent will be available on.</p>
      ${['rest', 'telegram', 'discord', 'twitter', 'slack'].map(p => `
        <div class="ez-form-group">
          <label class="ez-checkbox-label">
            <input type="checkbox" class="wiz-platform-cb" value="${p}" ${wizardData.platforms.includes(p) ? 'checked' : ''}>
            ${p.charAt(0).toUpperCase() + p.slice(1)}${p === 'rest' ? ' API' : ''}
          </label>
          ${p !== 'rest' ? `<input class="ez-input" placeholder="Token or Vault key (optional)" value="${escHtml(wizardData.platformTokens[p] || '')}" data-platform="${p}" style="margin-top:4px;display:${wizardData.platforms.includes(p) ? '' : 'none'}">` : ''}
        </div>
      `).join('')}
    `;
    case 3: return `
      <p style="font-size:13px;color:var(--text-dim);margin-bottom:16px">Select or create knowledge branches for this agent.</p>
      <div class="ez-form-group"><label>New Branch Name</label><div style="display:flex;gap:8px"><input class="ez-input" id="wiz-new-branch" value="${escHtml(wizardData.newBranchName)}" placeholder="e.g., sales-kb" style="flex:1"><button class="ez-btn ez-btn-secondary ez-btn-sm" onclick="wizardAddBranch()">Add</button></div></div>
      <div id="wiz-branches-list">${wizardData.knowledgeBranches.map(b => `<div class="ez-badge ez-badge-accent" style="margin:2px">${escHtml(b)} <span onclick="wizardRemoveBranch('${escHtml(b)}')" style="cursor:pointer;margin-left:4px">&#x2715;</span></div>`).join('')}</div>
    `;
    case 4: return `
      <div class="ez-form-group"><label>Info Layer Level</label><select class="ez-select" id="wiz-info-layer"><option value="public" ${wizardData.infoLayer === 'public' ? 'selected' : ''}>Public</option><option value="internal" ${wizardData.infoLayer === 'internal' ? 'selected' : ''}>Internal</option><option value="agent_specific" ${wizardData.infoLayer === 'agent_specific' ? 'selected' : ''}>Agent-Specific</option></select></div>
      <div class="ez-form-group"><label>Max Response Length (tokens)</label><input type="number" class="ez-input" id="wiz-max-length" value="${wizardData.maxLength}"></div>
      <div class="ez-form-group"><label>Escalation Triggers (comma-separated)</label><input class="ez-input" id="wiz-escalation" value="${escHtml(wizardData.escalationTriggers)}" placeholder="e.g., refund, complaint, urgent"></div>
      <div class="ez-form-group"><label>Blocked Topics (comma-separated)</label><input class="ez-input" id="wiz-blocked" value="${escHtml(wizardData.blockedTopics)}" placeholder="e.g., politics, religion"></div>
    `;
    case 5: return `
      <div class="ez-form-group"><label>Deployment Tier</label>
        ${['local', 'docker', 'cloud'].map(t => `
          <label class="ez-checkbox-label" style="margin-bottom:8px"><input type="radio" name="wiz-deploy" value="${t}" ${wizardData.deploymentTier === t ? 'checked' : ''}> ${t.charAt(0).toUpperCase() + t.slice(1)} ${t === 'local' ? '(HP Z420)' : t === 'docker' ? '(VPS Container)' : '(AWS/Cloud)'}</label>
        `).join('')}
      </div>
      <div class="ez-form-row">
        <div class="ez-form-group"><label>Model</label><select class="ez-select" id="wiz-model"><option value="claude-sonnet-4-6" ${wizardData.model === 'claude-sonnet-4-6' ? 'selected' : ''}>Claude Sonnet 4.6</option><option value="claude-haiku-4-5-20251001" ${wizardData.model === 'claude-haiku-4-5-20251001' ? 'selected' : ''}>Claude Haiku 4.5</option></select></div>
        <div class="ez-form-group"><label>Temperature</label><input type="number" class="ez-input" id="wiz-temp" value="${wizardData.temperature}" step="0.1" min="0" max="2"></div>
      </div>
      <div class="ez-form-row">
        <div class="ez-form-group"><label>Rate Limit (RPM)</label><input type="number" class="ez-input" id="wiz-rpm" value="${wizardData.rateLimitRpm}"></div>
        <div class="ez-form-group"><label>Daily Limit</label><input type="number" class="ez-input" id="wiz-daily" value="${wizardData.rateLimitDaily}"></div>
      </div>
    `;
    case 6: return renderWizardReview();
    default: return '';
  }
}

function renderWizardReview() {
  const char = buildCharacterJSON();
  return `
    <div style="font-size:13px">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:6px 8px;color:var(--text-dim)">Name</td><td style="padding:6px 8px;font-weight:500">${escHtml(wizardData.name)}</td></tr>
        <tr><td style="padding:6px 8px;color:var(--text-dim)">Slug</td><td style="padding:6px 8px;font-family:var(--font-mono)">${escHtml(wizardData.slug)}</td></tr>
        <tr><td style="padding:6px 8px;color:var(--text-dim)">Platforms</td><td style="padding:6px 8px">${wizardData.platforms.join(', ') || 'None'}</td></tr>
        <tr><td style="padding:6px 8px;color:var(--text-dim)">Info Layer</td><td style="padding:6px 8px">${wizardData.infoLayer}</td></tr>
        <tr><td style="padding:6px 8px;color:var(--text-dim)">Deploy</td><td style="padding:6px 8px">${wizardData.deploymentTier}</td></tr>
        <tr><td style="padding:6px 8px;color:var(--text-dim)">Model</td><td style="padding:6px 8px">${wizardData.model}</td></tr>
        <tr><td style="padding:6px 8px;color:var(--text-dim)">Knowledge</td><td style="padding:6px 8px">${wizardData.knowledgeBranches.join(', ') || 'None'}</td></tr>
      </table>
    </div>
    <div class="ez-detail-section" style="margin-top:16px">
      <div class="ez-detail-section-title">Character JSON Preview</div>
      <textarea class="ez-config-editor" style="min-height:160px" readonly>${JSON.stringify(char, null, 2)}</textarea>
    </div>
  `;
}

// ── Navigation ─────────────────────────────────────────────
function wizardNext() {
  saveCurrentStep();
  if (!validateStep()) return;
  wizardStep = Math.min(wizardStep + 1, WIZARD_STEPS.length - 1);
  renderWizard();
}

function wizardPrev() {
  saveCurrentStep();
  wizardStep = Math.max(wizardStep - 1, 0);
  renderWizard();
}

function saveCurrentStep() {
  switch (wizardStep) {
    case 0:
      wizardData.name = document.getElementById('wiz-name')?.value || '';
      wizardData.slug = document.getElementById('wiz-slug')?.value || wizardData.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      wizardData.avatar = document.getElementById('wiz-avatar')?.value || '';
      wizardData.description = document.getElementById('wiz-description')?.value || '';
      break;
    case 1:
      wizardData.bio = document.getElementById('wiz-bio')?.value || '';
      wizardData.system = document.getElementById('wiz-system')?.value || '';
      wizardData.examples = document.getElementById('wiz-examples')?.value || '';
      break;
    case 2:
      wizardData.platforms = Array.from(document.querySelectorAll('.wiz-platform-cb:checked')).map(cb => cb.value);
      document.querySelectorAll('[data-platform]').forEach(inp => {
        wizardData.platformTokens[inp.dataset.platform] = inp.value;
      });
      break;
    case 4:
      wizardData.infoLayer = document.getElementById('wiz-info-layer')?.value || 'public';
      wizardData.maxLength = parseInt(document.getElementById('wiz-max-length')?.value || '4096');
      wizardData.escalationTriggers = document.getElementById('wiz-escalation')?.value || '';
      wizardData.blockedTopics = document.getElementById('wiz-blocked')?.value || '';
      break;
    case 5:
      wizardData.deploymentTier = document.querySelector('input[name="wiz-deploy"]:checked')?.value || 'local';
      wizardData.model = document.getElementById('wiz-model')?.value || 'claude-sonnet-4-6';
      wizardData.temperature = parseFloat(document.getElementById('wiz-temp')?.value || '0.7');
      wizardData.rateLimitRpm = parseInt(document.getElementById('wiz-rpm')?.value || '60');
      wizardData.rateLimitDaily = parseInt(document.getElementById('wiz-daily')?.value || '1000');
      break;
  }
}

function validateStep() {
  if (wizardStep === 0 && !wizardData.name.trim()) {
    showToast('Agent name is required', 'error');
    return false;
  }
  return true;
}

// ── Knowledge helpers ──────────────────────────────────────
function wizardAddBranch() {
  const input = document.getElementById('wiz-new-branch');
  const name = input.value.trim();
  if (name && !wizardData.knowledgeBranches.includes(name)) {
    wizardData.knowledgeBranches.push(name);
    input.value = '';
    renderWizard();
  }
}

function wizardRemoveBranch(name) {
  wizardData.knowledgeBranches = wizardData.knowledgeBranches.filter(b => b !== name);
  renderWizard();
}

// ── Build character JSON ───────────────────────────────────
function buildCharacterJSON() {
  return {
    name: wizardData.name,
    slug: wizardData.slug,
    description: wizardData.description,
    bio: wizardData.bio,
    system: wizardData.system,
    modelProvider: 'anthropic',
    platforms: wizardData.platforms,
    settings: {
      model: wizardData.model,
      maxTokens: wizardData.maxLength,
      temperature: wizardData.temperature,
    },
    info_layer: wizardData.infoLayer,
    deployment_tier: wizardData.deploymentTier,
    knowledge_branches: wizardData.knowledgeBranches,
    safety: {
      escalation_triggers: wizardData.escalationTriggers.split(',').map(s => s.trim()).filter(Boolean),
      blocked_topics: wizardData.blockedTopics.split(',').map(s => s.trim()).filter(Boolean),
    },
  };
}

// ── Deploy ─────────────────────────────────────────────────
async function wizardDeploy() {
  saveCurrentStep();
  const character = buildCharacterJSON();

  try {
    const agent = await fetchAPI('/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: wizardData.name,
        slug: wizardData.slug || wizardData.name.toLowerCase().replace(/\s+/g, '-'),
        character_file: character,
        deployment_tier: wizardData.deploymentTier,
        model: wizardData.model,
        plugins: ['opai-knowledge', 'opai-teamhub', 'opai-infolayer'],
        platforms: wizardData.platforms,
        rate_limit_rpm: wizardData.rateLimitRpm,
        rate_limit_daily: wizardData.rateLimitDaily,
        max_tokens: wizardData.maxLength,
        temperature: wizardData.temperature,
      }),
    });

    showToast(`Agent "${wizardData.name}" created successfully!`, 'success');
    closeWizard();
    loadAgents();
    loadOverview();
  } catch (err) {
    showToast(`Failed to create agent: ${err.message}`, 'error');
  }
}
