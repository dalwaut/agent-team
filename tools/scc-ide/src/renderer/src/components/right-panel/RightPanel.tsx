import React, { useState, useEffect } from 'react'
import { Puzzle, Users, Link2, ShieldAlert } from 'lucide-react'
import PluginsTab from './PluginsTab'
import SquadsTab from './SquadsTab'
import LinksTab from './LinksTab'
import HitlTab from './HitlTab'

interface RightPanelProps {
  onInstallPlugin: (command: string) => void
  onRunSquad: (squadId: string, task?: string) => void
  cwd?: string
}

type TabId = 'plugins' | 'squads' | 'links' | 'hitl'

interface TabDef {
  id: TabId
  label: string
  icon: React.ReactNode
}

const TABS: TabDef[] = [
  { id: 'plugins', label: 'Plugins', icon: <Puzzle size={14} /> },
  { id: 'squads', label: 'Squads', icon: <Users size={14} /> },
  { id: 'links', label: 'Links', icon: <Link2 size={14} /> },
  { id: 'hitl', label: 'HITL', icon: <ShieldAlert size={14} /> },
]

function getStoredTab(): TabId {
  try {
    const stored = localStorage.getItem('scc-right-panel-tab')
    if (stored && ['plugins', 'squads', 'links', 'hitl'].includes(stored)) {
      return stored as TabId
    }
  } catch {
    // ignore
  }
  return 'plugins'
}

export default function RightPanel({
  onInstallPlugin,
  onRunSquad,
}: RightPanelProps): React.ReactElement {
  const [activeTab, setActiveTab] = useState<TabId>(getStoredTab)
  const [hitlCount, setHitlCount] = useState(0)

  // Persist active tab
  function selectTab(tab: TabId): void {
    setActiveTab(tab)
    localStorage.setItem('scc-right-panel-tab', tab)
  }

  // Poll HITL count for badge
  useEffect(() => {
    async function checkHitl(): Promise<void> {
      try {
        const items = await window.scc.listHITL()
        setHitlCount(items.filter((i) => !i.done).length)
      } catch {
        // ignore
      }
    }
    checkHitl()
    const interval = setInterval(checkHitl, 30_000)

    function onHitlUpdate(): void { checkHitl() }
    window.scc.on('hitl-update', onHitlUpdate)

    return () => {
      clearInterval(interval)
      window.scc.off('hitl-update', onHitlUpdate)
    }
  }, [])

  return (
    <div className="w-72 bg-zinc-950 border-l border-zinc-800 flex flex-col h-full shrink-0">
      {/* Tab bar */}
      <div className="flex items-center border-b border-zinc-800 shrink-0">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => selectTab(tab.id)}
            className={`
              flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors relative
              ${
                activeTab === tab.id
                  ? 'text-white'
                  : 'text-zinc-500 hover:text-zinc-300'
              }
            `}
          >
            {tab.icon}
            <span>{tab.label}</span>

            {/* HITL badge */}
            {tab.id === 'hitl' && hitlCount > 0 && (
              <span className="absolute -top-0.5 right-1 min-w-[16px] h-4 flex items-center justify-center bg-red-600 text-white text-[10px] font-bold rounded-full px-1">
                {hitlCount > 9 ? '9+' : hitlCount}
              </span>
            )}

            {/* Active underline */}
            {activeTab === tab.id && (
              <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-violet-500 rounded-t" />
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 flex flex-col">
        {activeTab === 'plugins' && <PluginsTab onInstallPlugin={onInstallPlugin} />}
        {activeTab === 'squads' && <SquadsTab onRunSquad={onRunSquad} />}
        {activeTab === 'links' && <LinksTab />}
        {activeTab === 'hitl' && <HitlTab />}
      </div>
    </div>
  )
}
