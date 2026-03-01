import React, { useState, useEffect, useCallback, useRef } from 'react'
import './assets/index.css'

// ─── Lazy imports (components built by parallel agents) ──────────────────────
// We use React.lazy for graceful degradation during development
const TopBar = React.lazy(() => import('./components/TopBar'))
const ConversationList = React.lazy(() => import('./components/sidebar/ConversationList'))
const ChatArea = React.lazy(() => import('./components/chat/ChatArea'))
const RightPanel = React.lazy(() => import('./components/right-panel/RightPanel'))

// ─── Context for app-wide settings ───────────────────────────────────────────
interface AppSettings {
  cwd: string
  model: string
  sidebarOpen: boolean
  rightPanelOpen: boolean
}

const DEFAULT_CWD = '/workspace/synced/opai'
const DEFAULT_MODEL = 'claude-sonnet-4-6'

function LoadingFallback({ label }: { label: string }): React.ReactElement {
  return (
    <div className="flex items-center justify-center h-full w-full">
      <div className="text-zinc-600 text-xs animate-pulse">{label}</div>
    </div>
  )
}

function ErrorBoundaryFallback({ error }: { error: Error }): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 p-4">
      <div className="text-red-400 text-sm font-mono">Component failed to load</div>
      <div className="text-zinc-600 text-xs font-mono max-w-sm text-center">{error.message}</div>
    </div>
  )
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode; label?: string },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode; label?: string }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) return <ErrorBoundaryFallback error={this.state.error} />
    return this.props.children
  }
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App(): React.ReactElement {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionCost, setSessionCost] = useState<number>(0)
  const [settings, setSettings] = useState<AppSettings>(() => ({
    cwd: localStorage.getItem('scc:cwd') || DEFAULT_CWD,
    model: localStorage.getItem('scc:model') || DEFAULT_MODEL,
    sidebarOpen: localStorage.getItem('scc:sidebar') !== 'false',
    rightPanelOpen: localStorage.getItem('scc:rightPanel') !== 'false',
  }))

  // Sidebar width (resizable)
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const [rightWidth, setRightWidth] = useState(288)
  const isResizingLeft = useRef(false)
  const isResizingRight = useRef(false)

  // Persist settings
  useEffect(() => {
    localStorage.setItem('scc:cwd', settings.cwd)
    localStorage.setItem('scc:model', settings.model)
    localStorage.setItem('scc:sidebar', String(settings.sidebarOpen))
    localStorage.setItem('scc:rightPanel', String(settings.rightPanelOpen))
  }, [settings])

  // ── Resize handlers ──
  const startResizeLeft = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizingLeft.current = true
  }, [])

  const startResizeRight = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizingRight.current = true
  }, [])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (isResizingLeft.current) {
        const w = Math.min(Math.max(e.clientX, 180), 400)
        setSidebarWidth(w)
      }
      if (isResizingRight.current) {
        const w = Math.min(Math.max(window.innerWidth - e.clientX, 240), 480)
        setRightWidth(w)
      }
    }
    const onMouseUp = () => {
      isResizingLeft.current = false
      isResizingRight.current = false
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  const handleInstallPlugin = useCallback(
    (command: string) => {
      // Dispatch a custom event that ChatArea listens to, injecting the command as a user message
      window.dispatchEvent(new CustomEvent('scc:inject-message', { detail: { text: command } }))
    },
    []
  )

  const handleRunSquad = useCallback(
    async (squadId: string, task?: string) => {
      if (!window.scc) return
      try {
        await window.scc.runSquad({ squadName: squadId, task })
      } catch (err) {
        console.error('Squad run failed:', err)
      }
    },
    [settings.cwd]
  )

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#0a0a0a]">

      {/* ── Top Bar ── */}
      <ErrorBoundary label="TopBar">
        <React.Suspense fallback={
          <div className="h-12 bg-zinc-950 border-b border-zinc-800 flex items-center px-4">
            <span className="text-violet-400 text-xs font-bold">SCC IDE</span>
          </div>
        }>
          <TopBar
            cwd={settings.cwd}
            onCwdChange={(cwd) => setSettings(s => ({ ...s, cwd }))}
            model={settings.model}
            onModelChange={(model) => setSettings(s => ({ ...s, model }))}
            sidebarOpen={settings.sidebarOpen}
            onToggleSidebar={() => setSettings(s => ({ ...s, sidebarOpen: !s.sidebarOpen }))}
            rightPanelOpen={settings.rightPanelOpen}
            onToggleRightPanel={() => setSettings(s => ({ ...s, rightPanelOpen: !s.rightPanelOpen }))}
            totalCostUsd={sessionCost}
          />
        </React.Suspense>
      </ErrorBoundary>

      {/* ── Main 3-panel body ── */}
      <div className="flex flex-1 overflow-hidden min-h-0">

        {/* Left sidebar — CSS-hidden when closed (never unmounts to avoid IPC cleanup crashes) */}
        <div
          className="flex-shrink-0 overflow-hidden transition-[width] duration-150 select-none"
          style={{ width: settings.sidebarOpen ? sidebarWidth : 0 }}
        >
          <ErrorBoundary label="Sidebar">
            <React.Suspense fallback={<LoadingFallback label="Loading conversations..." />}>
              <ConversationList
                activeSessionId={activeSessionId}
                onSelect={setActiveSessionId}
                onNewChat={() => setActiveSessionId(null)}
              />
            </React.Suspense>
          </ErrorBoundary>
        </div>

        {/* Left resize handle — hidden when sidebar closed */}
        {settings.sidebarOpen && (
          <div className="resize-handle" onMouseDown={startResizeLeft} />
        )}

        {/* Center — chat area, always full remaining space */}
        <div className="flex-1 overflow-hidden min-w-0 min-h-0 flex flex-col">
          <ErrorBoundary label="Chat">
            <React.Suspense fallback={<LoadingFallback label="Loading chat..." />}>
              <ChatArea
                sessionId={activeSessionId}
                cwd={settings.cwd}
                model={settings.model}
                onSessionCreated={setActiveSessionId}
                onCostChange={setSessionCost}
              />
            </React.Suspense>
          </ErrorBoundary>
        </div>

        {/* Right resize handle — hidden when panel closed */}
        {settings.rightPanelOpen && (
          <div className="resize-handle" onMouseDown={startResizeRight} />
        )}

        {/* Right panel — CSS-hidden when closed (never unmounts) */}
        <div
          className="flex-shrink-0 overflow-hidden transition-[width] duration-150 select-none"
          style={{ width: settings.rightPanelOpen ? rightWidth : 0 }}
        >
          <ErrorBoundary label="RightPanel">
            <React.Suspense fallback={<LoadingFallback label="Loading panel..." />}>
              <RightPanel
                onInstallPlugin={handleInstallPlugin}
                onRunSquad={handleRunSquad}
                cwd={settings.cwd}
              />
            </React.Suspense>
          </ErrorBoundary>
        </div>
      </div>
    </div>
  )
}
