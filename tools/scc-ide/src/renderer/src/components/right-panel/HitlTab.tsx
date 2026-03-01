import React, { useState, useEffect, useCallback } from 'react'
import { CheckCircle2, Eye, Check, RefreshCw } from 'lucide-react'
import { formatRelativeTime } from '../../lib/utils'
import type { HitlItem } from '../../types'

export default function HitlTab(): React.ReactElement {
  const [items, setItems] = useState<HitlItem[]>([])
  const [loading, setLoading] = useState(true)

  const loadItems = useCallback(async () => {
    try {
      const files = await window.scc.listHITL()
      const list: HitlItem[] = files.map((f) => ({
        path: f.path,
        filename: f.filename,
        timestamp: f.mtime,
        preview: f.preview ?? 'Click to review',
        done: f.done ?? false,
      }))
      // Sort by timestamp descending (newest first), undone first
      list.sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1
        return (b.timestamp || 0) - (a.timestamp || 0)
      })
      setItems(list)
    } catch {
      // IPC not ready
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadItems()
    function onHitlUpdate(): void { loadItems() }
    window.scc.on('hitl-update', onHitlUpdate)
    return () => { window.scc.off('hitl-update', onHitlUpdate) }
  }, [loadItems])

  async function handleMarkDone(path: string): Promise<void> {
    try {
      await window.scc.doneHITL(path)
      setItems((prev) =>
        prev.map((item) => (item.path === path ? { ...item, done: true } : item))
      )
    } catch {
      // ignore
    }
  }

  function handleViewFull(path: string): void {
    try {
      window.scc?.openExternal?.(path)
    } catch {
      // ignore
    }
  }

  function isRecent(timestamp: number): boolean {
    return Date.now() - timestamp < 5 * 60 * 1000 // 5 minutes
  }

  const pendingCount = items.filter((i) => !i.done).length

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw size={20} className="text-zinc-600 animate-spin" />
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <CheckCircle2 size={32} className="text-emerald-600/50 mb-3" />
        <p className="text-sm text-zinc-500">No pending approvals</p>
        <p className="text-xs text-zinc-600 mt-1">HITL items will appear here when agents request review</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Summary */}
      <div className="px-3 py-2 border-b border-zinc-800 text-xs text-zinc-500">
        {pendingCount > 0 ? (
          <span>
            <span className="text-amber-400 font-medium">{pendingCount}</span> pending approval{pendingCount !== 1 ? 's' : ''}
          </span>
        ) : (
          <span className="text-emerald-400">All items reviewed</span>
        )}
      </div>

      {items.map((item) => (
        <div
          key={item.path}
          className={`px-3 py-2.5 border-b border-zinc-800/50 transition-colors ${
            item.done ? 'opacity-50' : 'hover:bg-zinc-900/60'
          }`}
        >
          {/* Header */}
          <div className="flex items-center gap-2">
            {/* Red dot for recent items */}
            {!item.done && isRecent(item.timestamp) && (
              <span className="w-2 h-2 rounded-full bg-red-500 shrink-0 animate-pulse" />
            )}
            <span className="text-sm font-medium text-zinc-200 truncate flex-1">
              {item.filename}
            </span>
            {item.done && (
              <Check size={14} className="text-emerald-400 shrink-0" />
            )}
          </div>

          {/* Timestamp */}
          <div className="text-xs text-zinc-500 mt-0.5">
            {formatRelativeTime(item.timestamp)}
          </div>

          {/* Preview */}
          {item.preview && (
            <div className="mt-1.5 px-2 py-1.5 bg-zinc-900 rounded text-xs text-zinc-400 font-mono truncate leading-relaxed">
              {item.preview.length > 100 ? item.preview.slice(0, 100) + '\u2026' : item.preview}
            </div>
          )}

          {/* Actions */}
          {!item.done && (
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={() => handleViewFull(item.path)}
                className="flex items-center gap-1 text-xs text-zinc-400 hover:text-violet-400 transition-colors px-2 py-1 rounded hover:bg-zinc-800"
              >
                <Eye size={12} />
                View Full
              </button>
              <button
                onClick={() => handleMarkDone(item.path)}
                className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 transition-colors px-2 py-1 rounded hover:bg-zinc-800"
              >
                <Check size={12} />
                Mark Done
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
