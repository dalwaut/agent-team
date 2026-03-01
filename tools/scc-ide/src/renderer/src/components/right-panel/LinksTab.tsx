import React, { useState, useCallback } from 'react'
import {
  Globe,
  BarChart3,
  Music,
  Bot,
  ClipboardList,
  FolderOpen,
  MessageSquare,
  Boxes,
  Activity,
  BookOpen,
  ExternalLink,
  Folder,
  Brain,
  RefreshCw,
  X,
} from 'lucide-react'

// ── helpers ──────────────────────────────────────────────────────────────────

function openExternal(target: string): void {
  window.scc?.openExternal?.(target)
}

// ── sub-components ───────────────────────────────────────────────────────────

function LinkRow({ icon, label, url }: { icon: React.ReactNode; label: string; url: string }): React.ReactElement {
  return (
    <button
      onClick={() => openExternal(url)}
      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-zinc-300 hover:text-violet-400 hover:bg-zinc-900 transition-colors rounded group"
    >
      <span className="shrink-0 text-zinc-500 group-hover:text-violet-400 transition-colors">{icon}</span>
      <span className="truncate flex-1 text-left">{label}</span>
      <ExternalLink size={11} className="shrink-0 text-zinc-700 group-hover:text-zinc-500 transition-colors" />
    </button>
  )
}

function ActionRow({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }): React.ReactElement {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-zinc-300 hover:text-violet-400 hover:bg-zinc-900 transition-colors rounded group"
    >
      <span className="shrink-0 text-zinc-500 group-hover:text-violet-400 transition-colors">{icon}</span>
      <span className="truncate flex-1 text-left">{label}</span>
    </button>
  )
}

// ── usage bar ────────────────────────────────────────────────────────────────

function UsageBar({ label, pct }: { label: string; pct: number }): React.ReactElement {
  const color = pct >= 85 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-emerald-500'
  return (
    <div className="mb-2">
      <div className="flex justify-between text-[10px] text-zinc-500 mb-0.5">
        <span>{label}</span>
        <span className={pct >= 85 ? 'text-red-400' : pct >= 70 ? 'text-amber-400' : 'text-zinc-400'}>
          {pct.toFixed(1)}%
        </span>
      </div>
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  )
}

// ── status popup ─────────────────────────────────────────────────────────────

interface ServiceEntry { name: string; running: boolean; description: string }
interface UsageData {
  five_hour: { utilization: number } | null
  seven_day: { utilization: number } | null
  seven_day_sonnet: { utilization: number } | null
  extra_usage: { used_credits: number; monthly_limit: number; utilization: number } | null
}

function StatusPopup({ onClose }: { onClose: () => void }): React.ReactElement {
  const [services, setServices] = useState<ServiceEntry[] | null>(null)
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [svcRes, usageRes] = await Promise.all([
        window.scc.getServiceStatus(),
        window.scc.getUsage(),
      ])
      if (svcRes.ok) setServices(svcRes.services)
      if (usageRes.ok && usageRes.usage) setUsage(usageRes.usage as UsageData)
      if (!svcRes.ok && !usageRes.ok) setError(svcRes.error ?? 'Failed to fetch status')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch on mount
  React.useEffect(() => { fetchAll() }, [fetchAll])

  return (
    <div className="mx-2 mb-2 rounded-lg border border-zinc-700 overflow-hidden" style={{ backgroundColor: '#0e0e1f' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <span className="text-xs font-semibold text-zinc-300">Server Status</span>
        <div className="flex items-center gap-1">
          <button
            onClick={fetchAll}
            disabled={loading}
            className="p-1 rounded text-zinc-500 hover:text-violet-400 hover:bg-zinc-800 transition-colors"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            <X size={11} />
          </button>
        </div>
      </div>

      <div className="px-3 py-2 max-h-72 overflow-y-auto">
        {error && <p className="text-xs text-red-400 mb-2">{error}</p>}

        {/* Claude Usage */}
        {usage && (
          <div className="mb-3">
            <p className="text-[10px] text-zinc-600 uppercase font-medium tracking-wider mb-1.5">Claude Usage</p>
            {usage.five_hour && <UsageBar label="5-hour session" pct={usage.five_hour.utilization} />}
            {usage.seven_day && <UsageBar label="7-day all models" pct={usage.seven_day.utilization} />}
            {usage.seven_day_sonnet && <UsageBar label="7-day Sonnet" pct={usage.seven_day_sonnet.utilization} />}
            {usage.extra_usage && (
              <div className="mt-1 text-[10px] text-zinc-500">
                Extra: ${(usage.extra_usage.used_credits / 100).toFixed(2)} / ${(usage.extra_usage.monthly_limit / 100).toFixed(0)}
                {' '}({usage.extra_usage.utilization.toFixed(1)}%)
              </div>
            )}
          </div>
        )}

        {/* Services */}
        {services && (
          <div>
            <p className="text-[10px] text-zinc-600 uppercase font-medium tracking-wider mb-1.5">
              Services ({services.filter((s) => s.running).length}/{services.length} running)
            </p>
            <div className="space-y-0.5">
              {services.map((svc) => (
                <div key={svc.name} className="flex items-center gap-2 py-0.5">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${svc.running ? 'bg-emerald-500' : 'bg-red-500'}`} />
                  <span className="text-[11px] text-zinc-400 truncate">
                    {svc.name.replace('opai-', '').replace('.service', '')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {!services && !usage && !error && loading && (
          <p className="text-xs text-zinc-500 text-center py-4">Loading…</p>
        )}
      </div>
    </div>
  )
}

// ── main component ────────────────────────────────────────────────────────────

export default function LinksTab(): React.ReactElement {
  const [statusOpen, setStatusOpen] = useState(false)

  return (
    <div className="flex-1 overflow-y-auto py-1">

      {/* OPAI Tools */}
      <div className="px-3 py-1 mt-1 text-xs text-zinc-600 uppercase font-medium tracking-wider">OPAI Tools</div>
      <div className="px-1">
        <LinkRow icon={<Globe size={14} />}        label="Portal"       url="https://opai.boutabyte.com/dashboard" />
        <LinkRow icon={<BarChart3 size={14} />}    label="Monitor"      url="https://opai.boutabyte.com/monitor/" />
        <LinkRow icon={<Music size={14} />}        label="Orchestra"    url="https://opai.boutabyte.com/orchestra/" />
        <LinkRow icon={<Bot size={14} />}          label="Agent Studio" url="https://opai.boutabyte.com/agents/" />
        <LinkRow icon={<ClipboardList size={14} />} label="Task Control" url="https://opai.boutabyte.com/tasks/" />
        <LinkRow icon={<FolderOpen size={14} />}   label="Files"        url="https://opai.boutabyte.com/files/" />
        <LinkRow icon={<MessageSquare size={14} />} label="Chat"        url="https://opai.boutabyte.com/chat/" />
        <LinkRow icon={<Boxes size={14} />}        label="Bot Space"    url="https://opai.boutabyte.com/bot-space/" />
        <LinkRow icon={<Brain size={14} />}        label="2nd Brain"    url="https://opai.boutabyte.com/brain/" />
      </div>

      {/* Quick Actions */}
      <div className="px-3 py-1 mt-3 text-xs text-zinc-600 uppercase font-medium tracking-wider">Quick Actions</div>
      <div className="px-1">
        <ActionRow
          icon={<Activity size={14} />}
          label="Server Status"
          onClick={() => setStatusOpen((v) => !v)}
        />
      </div>

      {/* Inline status popup */}
      {statusOpen && <StatusPopup onClose={() => setStatusOpen(false)} />}

      {/* Workspace */}
      <div className="px-3 py-1 mt-3 text-xs text-zinc-600 uppercase font-medium tracking-wider">Local</div>
      <div className="px-1">
        <ActionRow
          icon={<FolderOpen size={14} />}
          label="Open Workspace"
          onClick={() => openExternal('/workspace/users')}
        />
        <ActionRow
          icon={<Folder size={14} />}
          label="OPAI"
          onClick={() => openExternal('/workspace/synced/opai')}
        />
      </div>

      {/* Docs */}
      <div className="px-3 py-1 mt-3 text-xs text-zinc-600 uppercase font-medium tracking-wider">Docs</div>
      <div className="px-1">
        <LinkRow icon={<BookOpen size={14} />} label="OPAI Wiki"      url="https://opai.boutabyte.com/docs/" />
        <LinkRow icon={<BookOpen size={14} />} label="Mobile API Ref" url="https://opai.boutabyte.com/docs/mobile-api-reference" />
      </div>

    </div>
  )
}
