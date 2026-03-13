/**
 * Eliza Hub — settings.js
 * Settings form handlers for global config, vault status, Team Hub binding, deployment presets.
 */

function loadSettings() {
  // Vault status indicators (check connectivity)
  checkVaultStatus();
}

async function checkVaultStatus() {
  const platforms = ['telegram', 'discord', 'twitter', 'anthropic'];

  for (const platform of platforms) {
    const el = document.getElementById(`vault-${platform}`);
    if (!el) continue;

    // For now, show as unconfigured — real vault check would query vault API
    el.textContent = 'Not Set';
    el.className = 'ez-badge ez-badge-muted';
  }

  // Check Anthropic key presence via runtime
  try {
    const health = await fetchAPI('/agents/runtime/status');
    if (health) {
      const el = document.getElementById('vault-anthropic');
      if (el) {
        el.textContent = 'Connected';
        el.className = 'ez-badge ez-badge-success';
      }
    }
  } catch { /* runtime not available */ }
}

// ── Kill Switch ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('setting-kill-switch')?.addEventListener('change', async (e) => {
    if (e.target.checked) {
      if (!confirm('This will stop ALL running agents. Continue?')) {
        e.target.checked = false;
        return;
      }

      try {
        // Stop all running agents
        const running = EZ.agents.filter(a => a.status === 'running');
        for (const agent of running) {
          await fetchAPI(`/agents/${agent.id}/stop`, { method: 'POST' }).catch(() => {});
        }
        showToast(`Stopped ${running.length} agents`, 'warn');
        loadOverview();
      } catch (err) {
        showToast('Kill switch failed', 'error');
      }
    }
  });
});
