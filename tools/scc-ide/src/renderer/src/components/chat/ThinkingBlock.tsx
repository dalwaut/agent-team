import React, { useState, useRef, useEffect } from 'react'
import { ChevronDown, Terminal } from 'lucide-react'

interface ThinkingBlockProps {
  thinking: string
  isStreaming?: boolean
  finalElapsedSec?: number // used when !isStreaming to show accurate "Thought for Xs"
  type?: 'thinking' | 'tool_call'
}

export default function ThinkingBlock({ thinking, isStreaming, finalElapsedSec, type = 'thinking' }: ThinkingBlockProps): React.ReactElement {
  const [expanded, setExpanded] = useState(true)
  const [elapsedSec, setElapsedSec] = useState(0)
  const startRef = useRef<number>(Date.now())
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isStreaming) return
    startRef.current = Date.now()
    setElapsedSec(0)
    const t = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)
    return () => clearInterval(t)
  }, [isStreaming])

  useEffect(() => {
    if (!isStreaming) setExpanded(false)
  }, [isStreaming])

  useEffect(() => {
    if (expanded && isStreaming && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [thinking, expanded, isStreaming])

  // ---- Tool call entry (compact, no expand, green) ----
  if (type === 'tool_call') {
    return (
      <div
        className="flex items-center gap-2 px-3 py-1.5 rounded-md my-0.5"
        style={{ backgroundColor: '#0a1a0f', border: '1px solid rgba(34,197,94,0.2)' }}
      >
        <Terminal size={11} className="text-emerald-500 flex-shrink-0" />
        <span className="text-xs text-emerald-400/80 font-mono truncate">{thinking}</span>
        {finalElapsedSec !== undefined && finalElapsedSec > 0 && (
          <span className="text-xs text-emerald-700 ml-auto flex-shrink-0">{finalElapsedSec}s</span>
        )}
      </div>
    )
  }

  // ---- Thinking entry (collapsible, purple) ----
  const displayedElapsed = isStreaming ? elapsedSec : (finalElapsedSec ?? elapsedSec)
  const label = isStreaming
    ? elapsedSec > 0 ? `Thinking… ${elapsedSec}s` : 'Thinking…'
    : `Thought for ${displayedElapsed > 0 ? `${displayedElapsed}s` : 'a moment'}`

  return (
    <div className="my-1 rounded-lg border border-violet-900/40 overflow-hidden" style={{ backgroundColor: '#0e0e1f' }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-white/5 transition-colors"
      >
        {isStreaming ? (
          <span className="w-3.5 h-3.5 rounded-full border-2 border-violet-500 border-t-transparent animate-spin flex-shrink-0" />
        ) : (
          <span className="w-3.5 h-3.5 rounded-full bg-violet-800/50 flex-shrink-0" />
        )}

        <span className={`text-xs font-medium flex-1 ${isStreaming ? 'thinking-shimmer' : 'text-zinc-500'}`}>
          {label}
        </span>

        <ChevronDown
          size={13}
          className={`text-zinc-600 transition-transform duration-200 flex-shrink-0 ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {expanded && (
        <div
          ref={contentRef}
          className="px-3 pb-3 pt-1 text-xs text-zinc-500 font-mono leading-relaxed max-h-56 overflow-y-auto whitespace-pre-wrap border-t border-violet-900/30"
        >
          {thinking || '…'}
        </div>
      )}
    </div>
  )
}
