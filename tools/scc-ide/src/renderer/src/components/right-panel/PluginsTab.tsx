import React, { useState } from 'react'
import { Search, Check, ChevronDown, ChevronRight, X } from 'lucide-react'
import pluginsData from '../../data/wshobson-plugins.json'
import type { PluginCategory, Plugin } from '../../types'

interface PluginsTabProps {
  onInstallPlugin: (command: string) => void
}

const categories = pluginsData.categories as PluginCategory[]

function getPriorityColor(priority: string): string {
  switch (priority) {
    case 'always-installed':
      return 'bg-violet-600/20 text-violet-400 border-violet-600/30'
    case 'high':
      return 'bg-emerald-600/20 text-emerald-400 border-emerald-600/30'
    case 'medium':
      return 'bg-amber-600/20 text-amber-400 border-amber-600/30'
    case 'low':
      return 'bg-zinc-600/20 text-zinc-400 border-zinc-600/30'
    default:
      return 'bg-zinc-600/20 text-zinc-400 border-zinc-600/30'
  }
}

export default function PluginsTab({ onInstallPlugin }: PluginsTabProps): React.ReactElement {
  const [search, setSearch] = useState('')
  const [installed, setInstalled] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('scc-installed-plugins')
      if (raw) return new Set(JSON.parse(raw) as string[])
    } catch {
      // ignore
    }
    return new Set<string>()
  })
  const [expandedPlugin, setExpandedPlugin] = useState<string | null>(null)
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())

  function persistInstalled(next: Set<string>): void {
    setInstalled(next)
    localStorage.setItem('scc-installed-plugins', JSON.stringify([...next]))
  }

  function handleInstall(plugin: Plugin): void {
    const next = new Set(installed)
    next.add(plugin.id)
    persistInstalled(next)
    onInstallPlugin(plugin.installCommand)
  }

  function handleRemove(pluginId: string): void {
    const next = new Set(installed)
    next.delete(pluginId)
    persistInstalled(next)
  }

  function toggleCategory(name: string): void {
    setCollapsedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  // Gather all plugins flat for search
  const allPlugins: Plugin[] = categories.flatMap((c) => c.plugins)
  const query = search.trim().toLowerCase()

  // Installed plugins list
  const installedPlugins = allPlugins.filter((p) => installed.has(p.id))

  // Filter by search
  function matchesSearch(p: Plugin): boolean {
    if (!query) return true
    return (
      p.displayName.toLowerCase().includes(query) ||
      p.description.toLowerCase().includes(query) ||
      p.category.toLowerCase().includes(query)
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="px-3 py-2 border-b border-zinc-800">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            placeholder="Search plugins..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-zinc-900 border border-zinc-700 rounded-md text-zinc-300 placeholder-zinc-600 outline-none focus:border-violet-600 transition-colors"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Installed this session */}
        {installedPlugins.length > 0 && !query && (
          <div className="px-3 pt-3 pb-1">
            <div className="text-xs text-zinc-600 uppercase font-medium tracking-wider mb-1.5">
              Installed This Session
            </div>
            {installedPlugins.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between py-1.5 px-2 rounded bg-zinc-900/50 mb-1"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <Check size={13} className="text-emerald-400 shrink-0" />
                  <span className="text-xs text-zinc-300 truncate">{p.displayName}</span>
                </div>
                <button
                  onClick={() => handleRemove(p.id)}
                  className="text-xs text-zinc-600 hover:text-red-400 transition-colors shrink-0 ml-2"
                  title="Remove"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Categories */}
        {categories.map((cat) => {
          const filtered = cat.plugins.filter(matchesSearch)
          if (filtered.length === 0) return null

          const isCollapsed = collapsedCategories.has(cat.name)

          return (
            <div key={cat.name} className="mt-2">
              <button
                onClick={() => toggleCategory(cat.name)}
                className="w-full flex items-center gap-1 px-3 py-1 text-xs text-zinc-600 uppercase font-medium tracking-wider hover:text-zinc-400 transition-colors"
              >
                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                {cat.name}
                <span className="text-zinc-700 ml-auto">{filtered.length}</span>
              </button>

              {!isCollapsed &&
                filtered.map((plugin) => {
                  const isInstalled = installed.has(plugin.id)
                  const isExpanded = expandedPlugin === plugin.id

                  return (
                    <div
                      key={plugin.id}
                      className="px-3 py-2 hover:bg-zinc-900/60 transition-colors cursor-pointer border-b border-zinc-800/30"
                      onClick={() => setExpandedPlugin(isExpanded ? null : plugin.id)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-medium text-zinc-200 truncate">
                              {plugin.displayName}
                            </span>
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded border ${getPriorityColor(
                                plugin.opaiPriority
                              )}`}
                            >
                              {plugin.category}
                            </span>
                          </div>
                          <p className="text-xs text-zinc-400 mt-0.5 truncate">
                            {plugin.description}
                          </p>
                        </div>

                        {isInstalled ? (
                          <span className="shrink-0 text-xs text-emerald-400 flex items-center gap-0.5 mt-0.5">
                            <Check size={12} />
                          </span>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleInstall(plugin)
                            }}
                            className="shrink-0 text-xs bg-violet-600 hover:bg-violet-500 text-white px-2 py-0.5 rounded transition-colors mt-0.5"
                          >
                            Install
                          </button>
                        )}
                      </div>

                      {/* Expanded: show slash commands */}
                      {isExpanded && plugin.slashCommands.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {plugin.slashCommands.map((cmd) => (
                            <span
                              key={cmd}
                              className="text-xs text-violet-400 bg-violet-900/20 px-1.5 py-0.5 rounded font-mono"
                            >
                              {cmd}
                            </span>
                          ))}
                        </div>
                      )}

                      {isExpanded && plugin.whenToUse && (
                        <p className="mt-1.5 text-xs text-zinc-500 italic">
                          {plugin.whenToUse}
                        </p>
                      )}
                    </div>
                  )
                })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
