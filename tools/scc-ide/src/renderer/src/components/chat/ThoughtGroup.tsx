import React, { useState } from 'react'
import {
  ChevronRight,
  Brain,
  Wrench,
  FileText,
  FilePen,
  Terminal,
  Search,
  FolderSearch,
  Globe,
  Cpu,
  FileCode,
  ScanSearch,
} from 'lucide-react'
import type { ThoughtItem } from '../../types'

// ── Tool icon mapping ────────────────────────────────────────────────────────
type LucideIcon = React.ComponentType<{ size?: number; className?: string }>

function getToolIcon(toolName: string): LucideIcon {
  const n = (toolName || '').toLowerCase()
  if (n === 'read') return FileText
  if (n === 'write') return FilePen
  if (n === 'edit') return FilePen
  if (n === 'bash') return Terminal
  if (n === 'grep') return Search
  if (n === 'glob') return FolderSearch
  if (n === 'task') return Cpu
  if (n === 'webfetch' || n === 'websearch') return Globe
  if (n === 'notebookedit') return FileCode
  if (n === 'multiedit') return FilePen
  if (n === 'scantext' || n === 'scanimage') return ScanSearch
  return Wrench
}

function getToolColor(toolName: string): string {
  const n = (toolName || '').toLowerCase()
  if (n === 'read') return 'text-sky-500/60'
  if (n === 'write' || n === 'edit' || n === 'multiedit' || n === 'notebookedit') return 'text-amber-500/60'
  if (n === 'bash') return 'text-emerald-500/60'
  if (n === 'grep' || n === 'glob') return 'text-violet-400/60'
  if (n === 'webfetch' || n === 'websearch') return 'text-blue-400/60'
  if (n === 'task') return 'text-orange-400/60'
  return 'text-zinc-500/60'
}

// ── Main component ────────────────────────────────────────────────────────────
interface ThoughtGroupProps {
  items: ThoughtItem[]
}

export default function ThoughtGroup({ items }: ThoughtGroupProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false)

  const thoughts = items.filter((i) => i.kind === 'thought')
  const tools = items.filter((i) => i.kind === 'tool')

  return (
    <div className="w-full my-1">
      {/* ── Collapsed bar ── */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors rounded group"
        style={{
          backgroundColor: '#0d0d18',
          border: '1px solid rgba(255,255,255,0.05)',
        }}
      >
        <ChevronRight
          size={10}
          className={`text-zinc-600 flex-shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />

        <span className="flex items-center gap-2.5 flex-1 min-w-0">
          {thoughts.length > 0 && (
            <span className="flex items-center gap-1 text-violet-500/50">
              <Brain size={10} className="flex-shrink-0" />
              <span className="text-[10px] font-mono tabular-nums">
                {thoughts.length} thought{thoughts.length !== 1 ? 's' : ''}
              </span>
            </span>
          )}
          {thoughts.length > 0 && tools.length > 0 && (
            <span className="text-zinc-700 text-[10px]">—</span>
          )}
          {tools.length > 0 && (
            <span className="flex items-center gap-1 text-zinc-500/50">
              <Wrench size={10} className="flex-shrink-0" />
              <span className="text-[10px] font-mono tabular-nums">
                {tools.length} action{tools.length !== 1 ? 's' : ''}
              </span>
            </span>
          )}
        </span>

        <span className="text-[9px] text-zinc-700 flex-shrink-0 group-hover:text-zinc-500 transition-colors font-mono">
          {expanded ? 'hide' : 'show'}
        </span>
      </button>

      {/* ── Expanded body ── */}
      {expanded && (
        <div
          className="mt-px rounded overflow-hidden"
          style={{
            backgroundColor: '#0d0d18',
            border: '1px solid rgba(255,255,255,0.05)',
            borderTop: 'none',
          }}
        >
          {/* Thoughts section */}
          {thoughts.length > 0 && (
            <div style={{ borderLeft: '2px solid rgba(139,92,246,0.2)' }}>
              {thoughts.map((item, i) => (
                <ThoughtRow key={i} item={item} isLast={i === thoughts.length - 1} />
              ))}
            </div>
          )}

          {/* Separator between thoughts and tools */}
          {thoughts.length > 0 && tools.length > 0 && (
            <div className="flex items-center gap-1 px-3 py-0.5">
              <span className="text-[10px] text-zinc-800">├</span>
              <div className="flex-1 border-t" style={{ borderColor: 'rgba(255,255,255,0.04)' }} />
            </div>
          )}

          {/* Tools section */}
          {tools.length > 0 && (
            <div style={{ borderLeft: '2px solid rgba(255,255,255,0.04)' }}>
              {tools.map((item, i) => (
                <ToolRow key={i} item={item} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Thought row (collapsible if long) ────────────────────────────────────────
const THOUGHT_PREVIEW_LEN = 120

function ThoughtRow({ item, isLast }: { item: ThoughtItem; isLast: boolean }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const isLong = item.text.length > THOUGHT_PREVIEW_LEN
  const preview = isLong && !open ? item.text.slice(0, THOUGHT_PREVIEW_LEN).trimEnd() + '…' : item.text

  return (
    <div
      className={`px-3 py-2 ${!isLast ? 'border-b' : ''}`}
      style={{
        backgroundColor: 'rgba(139,92,246,0.04)',
        borderColor: 'rgba(255,255,255,0.03)',
      }}
    >
      <div className="flex items-start gap-2">
        <Brain size={10} className="text-violet-500/40 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-[10px] text-zinc-500 font-mono leading-relaxed whitespace-pre-wrap break-words">
            {preview}
          </p>
          {isLong && (
            <button
              onClick={() => setOpen((v) => !v)}
              className="text-[9px] text-violet-500/40 hover:text-violet-400/60 mt-0.5 transition-colors"
            >
              {open ? 'show less' : 'show more'}
            </button>
          )}
        </div>
        {item.elapsedSec > 0 && (
          <span className="text-[9px] text-zinc-800 flex-shrink-0 tabular-nums">{item.elapsedSec}s</span>
        )}
      </div>
    </div>
  )
}

// ── Tool row ─────────────────────────────────────────────────────────────────
function ToolRow({ item }: { item: ThoughtItem }): React.ReactElement {
  const name = item.toolName || 'tool'
  const Icon = getToolIcon(name)
  const color = getToolColor(name)

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b last:border-b-0"
      style={{ borderColor: 'rgba(255,255,255,0.03)' }}
    >
      <Icon size={10} className={`${color} flex-shrink-0`} />
      <span className={`text-[10px] font-mono flex-shrink-0 ${color}`}>{name}</span>
      {item.text && (
        <>
          <span className="text-[10px] text-zinc-700 flex-shrink-0">›</span>
          <span className="text-[10px] text-zinc-500 font-mono truncate">{item.text}</span>
        </>
      )}
      {item.elapsedSec > 0 && (
        <span className="text-[9px] text-zinc-800 flex-shrink-0 ml-auto tabular-nums">{item.elapsedSec}s</span>
      )}
    </div>
  )
}
