import React, { useState, useRef, useEffect } from 'react'
import { ChevronDown, Minus, Square, X, FolderOpen, PanelRight, PanelLeft } from 'lucide-react'

interface TopBarProps {
  cwd: string
  onCwdChange: (cwd: string) => void
  model: string
  onModelChange: (m: string) => void
  sidebarOpen?: boolean
  onToggleSidebar?: () => void
  rightPanelOpen?: boolean
  onToggleRightPanel?: () => void
  totalCostUsd?: number
}

const MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
]

const OPAI_WORKSPACE = '/workspace/synced/opai'

function getBasename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

function getParentBase(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  if (parts.length >= 2) return parts[parts.length - 2]
  return ''
}

function getRecentDirs(): string[] {
  try {
    const raw = localStorage.getItem('scc-recent-dirs')
    if (raw) return JSON.parse(raw) as string[]
  } catch {
    // ignore
  }
  return []
}

function addRecentDir(dir: string): void {
  const recent = getRecentDirs().filter((d) => d !== dir)
  recent.unshift(dir)
  localStorage.setItem('scc-recent-dirs', JSON.stringify(recent.slice(0, 10)))
}

export default function TopBar({
  cwd,
  onCwdChange,
  model,
  onModelChange,
  sidebarOpen,
  onToggleSidebar,
  rightPanelOpen,
  onToggleRightPanel,
  totalCostUsd,
}: TopBarProps): React.ReactElement {
  const [projectOpen, setProjectOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const projectRef = useRef<HTMLDivElement>(null)
  const modelRef = useRef<HTMLDivElement>(null)

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (projectRef.current && !projectRef.current.contains(e.target as Node)) {
        setProjectOpen(false)
      }
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) {
        setModelOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const recentDirs = getRecentDirs().filter((d) => d !== OPAI_WORKSPACE && d !== cwd)

  function selectProject(dir: string): void {
    addRecentDir(dir)
    onCwdChange(dir)
    setProjectOpen(false)
  }

  function handleBrowse(): void {
    // Fallback: prompt for path (real app would use native dialog via IPC)
    const dir = prompt('Enter project directory path:')
    if (dir && dir.trim()) {
      selectProject(dir.trim())
    }
    setProjectOpen(false)
  }

  const displayLabel =
    cwd === OPAI_WORKSPACE
      ? 'OPAI Workspace'
      : `${getParentBase(cwd)}/${getBasename(cwd)}`

  const currentModel = MODELS.find((m) => m.id === model) || MODELS[0]

  return (
    <div
      className="h-12 bg-zinc-950 border-b border-zinc-800 flex items-center px-3 select-none shrink-0"
    >
      {/* Left: sidebar toggle + logo + project dropdown */}
      <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            className={`p-1.5 rounded transition-colors ${
              sidebarOpen
                ? 'text-violet-400 bg-violet-900/20 hover:bg-violet-900/40'
                : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
            }`}
          >
            <PanelLeft size={14} />
          </button>
        )}
        <span className="bg-violet-600 text-white text-xs px-2 py-0.5 rounded font-bold tracking-wide">
          SCC
        </span>

        <div ref={projectRef} className="relative">
          <button
            onClick={() => setProjectOpen(!projectOpen)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-sm text-zinc-300 hover:bg-zinc-800 transition-colors max-w-[240px]"
          >
            <FolderOpen size={14} className="text-zinc-500 shrink-0" />
            <span className="truncate">{displayLabel}</span>
            <ChevronDown size={12} className="text-zinc-500 shrink-0" />
          </button>

          {projectOpen && (
            <div className="absolute top-full left-0 mt-1 w-72 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-50 py-1 overflow-hidden">
              <button
                onClick={() => selectProject(OPAI_WORKSPACE)}
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-zinc-800 transition-colors ${
                  cwd === OPAI_WORKSPACE ? 'text-violet-400' : 'text-zinc-300'
                }`}
              >
                <FolderOpen size={14} className="shrink-0" />
                <div className="min-w-0">
                  <div className="font-medium truncate">OPAI Workspace</div>
                  <div className="text-xs text-zinc-500 truncate">{OPAI_WORKSPACE}</div>
                </div>
              </button>

              {recentDirs.length > 0 && (
                <>
                  <div className="border-t border-zinc-700 my-1" />
                  <div className="px-3 py-1 text-xs text-zinc-600 uppercase">Recent</div>
                  {recentDirs.slice(0, 5).map((dir) => (
                    <button
                      key={dir}
                      onClick={() => selectProject(dir)}
                      className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-zinc-800 transition-colors ${
                        cwd === dir ? 'text-violet-400' : 'text-zinc-300'
                      }`}
                    >
                      <FolderOpen size={14} className="shrink-0 text-zinc-500" />
                      <div className="min-w-0">
                        <div className="truncate">{getBasename(dir)}</div>
                        <div className="text-xs text-zinc-500 truncate">{dir}</div>
                      </div>
                    </button>
                  ))}
                </>
              )}

              <div className="border-t border-zinc-700 my-1" />
              <button
                onClick={handleBrowse}
                className="w-full text-left px-3 py-2 text-sm text-violet-400 hover:bg-zinc-800 transition-colors flex items-center gap-2"
              >
                <span className="text-lg leading-none">+</span>
                <span>Browse...</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Center: draggable area with session cost */}
      <div className="flex-1 h-full flex items-center justify-center" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        {totalCostUsd != null && totalCostUsd > 0 && (
          <span
            className="text-[10px] text-zinc-500 font-mono select-none"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            title="Running session cost (USD)"
          >
            session&nbsp;
            <span className="text-zinc-400">
              ${totalCostUsd < 0.01 ? totalCostUsd.toFixed(4) : totalCostUsd.toFixed(3)}
            </span>
          </span>
        )}
      </div>

      {/* Right: model selector + panel toggle + window controls */}
      <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {/* Right panel toggle */}
        {onToggleRightPanel && (
          <button
            onClick={onToggleRightPanel}
            title={rightPanelOpen ? 'Hide right panel' : 'Show right panel'}
            className={`p-1.5 rounded transition-colors ${
              rightPanelOpen
                ? 'text-violet-400 bg-violet-900/20 hover:bg-violet-900/40'
                : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
            }`}
          >
            <PanelRight size={14} />
          </button>
        )}

        {/* Model selector */}
        <div ref={modelRef} className="relative">
          <button
            onClick={() => setModelOpen(!modelOpen)}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-300 transition-colors border border-zinc-800"
          >
            <span>{currentModel.label}</span>
            <ChevronDown size={10} />
          </button>

          {modelOpen && (
            <div className="absolute top-full right-0 mt-1 w-44 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-50 py-1">
              {MODELS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    onModelChange(m.id)
                    setModelOpen(false)
                  }}
                  className={`w-full text-left px-3 py-1.5 text-sm hover:bg-zinc-800 transition-colors ${
                    model === m.id ? 'text-violet-400' : 'text-zinc-300'
                  }`}
                >
                  {m.label}
                  {model === m.id && <span className="ml-2 text-violet-500">&#10003;</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Window controls */}
        <div className="flex items-center ml-2">
          <button
            onClick={() => window.scc?.minimize?.()}
            className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300 rounded transition-colors"
            title="Minimize"
          >
            <Minus size={14} />
          </button>
          <button
            onClick={() => window.scc?.maximize?.()}
            className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300 rounded transition-colors"
            title="Maximize"
          >
            <Square size={12} />
          </button>
          <button
            onClick={() => window.scc?.close?.()}
            className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:bg-red-600 hover:text-white rounded transition-colors"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
