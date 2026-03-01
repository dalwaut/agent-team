import React, { useState } from 'react'
import { Play, Star, Shield, Loader2, ChevronDown, ChevronRight } from 'lucide-react'
import type { Squad } from '../../types'

interface SquadsTabProps {
  onRunSquad: (squadId: string, task?: string) => void
}

// Inline squad definitions — will be replaced with opai-squads.json when available
const SQUADS: Squad[] = [
  { id: 'audit', displayName: 'Audit Squad', description: 'Security + code quality audit across all tools', agents: ['security-auditor', 'code-reviewer', 'perf-analyst'], category: 'security', hitlRequired: true, favorite: true },
  { id: 'build', displayName: 'Build Squad', description: 'Implement features from task description', agents: ['architect', 'implementer', 'tester'], category: 'development', hitlRequired: false, favorite: true, requiresTask: true },
  { id: 'review', displayName: 'Review Squad', description: 'Deep code review with multi-perspective analysis', agents: ['senior-reviewer', 'security-reviewer', 'perf-reviewer'], category: 'quality', hitlRequired: true, favorite: true },
  { id: 'deploy', displayName: 'Deploy Squad', description: 'Pre-deploy checks, build, and rollout', agents: ['deploy-lead', 'qa-gate', 'rollback-monitor'], category: 'operations', hitlRequired: true, favorite: false },
  { id: 'fix', displayName: 'Auto-Fix Squad', description: 'Self-healing loop: detect, diagnose, fix, verify', agents: ['detector', 'diagnoser', 'fixer', 'verifier'], category: 'auto-fix', hitlRequired: false, favorite: false },
  { id: 'docs', displayName: 'Docs Squad', description: 'Documentation sweep and wiki updates', agents: ['doc-writer', 'doc-reviewer'], category: 'quality', hitlRequired: false, favorite: false },
  { id: 'monitor', displayName: 'Monitor Squad', description: 'Health checks across all OPAI services', agents: ['health-checker', 'log-analyst', 'alert-manager'], category: 'operations', hitlRequired: false, favorite: true },
  { id: 'tools', displayName: 'Tools Squad', description: 'Service status check and restart if needed', agents: ['service-checker', 'restarter'], category: 'operations', hitlRequired: false, favorite: false },
  { id: 'security', displayName: 'Security Squad', description: 'Full security scan: deps, secrets, SAST, RLS', agents: ['dep-scanner', 'secret-detector', 'sast-runner', 'rls-auditor'], category: 'security', hitlRequired: true, favorite: false },
  { id: 'perf', displayName: 'Performance Squad', description: 'Performance profiling and optimization suggestions', agents: ['profiler', 'optimizer', 'benchmark-runner'], category: 'quality', hitlRequired: false, favorite: false },
]

const CATEGORY_LABELS: Record<string, string> = {
  development: 'Development',
  security: 'Security',
  quality: 'Quality',
  operations: 'Operations',
  'auto-fix': 'Auto-Fix',
}

function getCategoryIcon(cat: string): React.ReactNode {
  switch (cat) {
    case 'security':
      return <Shield size={11} className="text-red-400" />
    default:
      return null
  }
}

export default function SquadsTab({ onRunSquad }: SquadsTabProps): React.ReactElement {
  const [expandedSquad, setExpandedSquad] = useState<string | null>(null)
  const [taskInput, setTaskInput] = useState('')
  const [runningSquad, setRunningSquad] = useState<string | null>(null)
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())

  function toggleCategory(cat: string): void {
    setCollapsedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  function handleRun(squad: Squad): void {
    if (squad.requiresTask) {
      if (expandedSquad === squad.id && taskInput.trim()) {
        setRunningSquad(squad.id)
        onRunSquad(squad.id, taskInput.trim())
        setTaskInput('')
        setExpandedSquad(null)
        setTimeout(() => setRunningSquad(null), 3000)
      } else {
        setExpandedSquad(squad.id)
        setTaskInput('')
      }
      return
    }
    setRunningSquad(squad.id)
    onRunSquad(squad.id)
    setTimeout(() => setRunningSquad(null), 3000)
  }

  // Favorites first
  const favorites = SQUADS.filter((s) => s.favorite)

  // Group remaining by category
  const categoryMap = new Map<string, Squad[]>()
  for (const squad of SQUADS) {
    if (!categoryMap.has(squad.category)) categoryMap.set(squad.category, [])
    categoryMap.get(squad.category)!.push(squad)
  }

  function renderSquadRow(squad: Squad): React.ReactElement {
    const isRunning = runningSquad === squad.id
    const isExpanded = expandedSquad === squad.id

    return (
      <div key={squad.id} className="border-b border-zinc-800/30">
        <div className="flex items-center gap-2 px-3 py-2 hover:bg-zinc-900/60 transition-colors group">
          {/* Play button */}
          <button
            onClick={() => handleRun(squad)}
            disabled={isRunning}
            className="shrink-0 w-6 h-6 flex items-center justify-center rounded bg-violet-600/20 text-violet-400 hover:bg-violet-600 hover:text-white transition-colors disabled:opacity-50"
            title={`Run ${squad.displayName}`}
          >
            {isRunning ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Play size={12} className="ml-0.5" />
            )}
          </button>

          {/* Info */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-zinc-200 truncate">
                {squad.displayName}
              </span>
              {squad.hitlRequired && (
                <span className="text-[10px] px-1 py-0.5 rounded bg-amber-600/20 text-amber-400 border border-amber-600/30">
                  HITL
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-500 truncate">{squad.description}</p>
          </div>

          {/* Running indicator */}
          {isRunning && (
            <span className="text-xs text-violet-400 shrink-0">Running...</span>
          )}
        </div>

        {/* Task input for requiresTask squads */}
        {isExpanded && squad.requiresTask && (
          <div className="px-3 pb-2 flex gap-1.5">
            <input
              type="text"
              placeholder="Describe the task..."
              value={taskInput}
              onChange={(e) => setTaskInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && taskInput.trim()) handleRun(squad)
              }}
              className="flex-1 px-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-300 placeholder-zinc-600 outline-none focus:border-violet-600 transition-colors"
              autoFocus
            />
            <button
              onClick={() => handleRun(squad)}
              disabled={!taskInput.trim()}
              className="text-xs bg-violet-600 hover:bg-violet-500 text-white px-2 py-1 rounded transition-colors disabled:opacity-40"
            >
              Go
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Favorites */}
      {favorites.length > 0 && (
        <div className="mt-1">
          <div className="px-3 py-1 text-xs text-zinc-600 uppercase font-medium tracking-wider flex items-center gap-1">
            <Star size={11} className="text-amber-500" />
            Favorites
          </div>
          {favorites.map(renderSquadRow)}
        </div>
      )}

      {/* By category */}
      {[...categoryMap.entries()].map(([cat, squads]) => {
        const isCollapsed = collapsedCategories.has(cat)
        return (
          <div key={cat} className="mt-2">
            <button
              onClick={() => toggleCategory(cat)}
              className="w-full flex items-center gap-1 px-3 py-1 text-xs text-zinc-600 uppercase font-medium tracking-wider hover:text-zinc-400 transition-colors"
            >
              {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              {getCategoryIcon(cat)}
              {CATEGORY_LABELS[cat] || cat}
              <span className="text-zinc-700 ml-auto">{squads.length}</span>
            </button>
            {!isCollapsed && squads.map(renderSquadRow)}
          </div>
        )
      })}
    </div>
  )
}
