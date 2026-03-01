import React, { useState, useRef, useEffect } from 'react'
import { Pin, Trash2, Copy } from 'lucide-react'
import { formatRelativeTime } from '../../lib/utils'
import type { Conversation } from '../../types'

interface ConversationItemProps {
  conversation: Conversation
  isActive: boolean
  isNew: boolean
  onClick: () => void
  onDelete: () => void
  onPin: () => void
}

export default function ConversationItem({
  conversation,
  isActive,
  isNew,
  onClick,
  onDelete,
  onPin,
}: ConversationItemProps): React.ReactElement {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [hovered, setHovered] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!contextMenu) return
    function handleClick(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [contextMenu])

  function handleContextMenu(e: React.MouseEvent): void {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  function handleCopySessionId(): void {
    navigator.clipboard.writeText(conversation.sessionId)
    setContextMenu(null)
  }

  function handlePin(): void { onPin(); setContextMenu(null) }
  function handleDelete(): void { onDelete(); setContextMenu(null) }

  // Derive left-border + background color based on state priority: active > new > default
  const borderColor = isActive
    ? 'border-l-violet-500'
    : isNew
      ? 'border-l-emerald-500'
      : 'border-l-transparent'

  const bgColor = isActive
    ? 'bg-violet-900/20'
    : isNew
      ? 'bg-emerald-950/25'
      : hovered
        ? 'bg-zinc-900'
        : 'bg-transparent'

  return (
    <>
      <button
        onClick={onClick}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={`
          w-full px-3 py-2 text-left flex flex-col justify-center relative
          border-l-2 ${borderColor} ${bgColor}
          transition-colors cursor-pointer min-h-[52px]
        `}
      >
        {/* Top-right: pin icon (when pinned) OR hover action buttons */}
        <div className="absolute top-1.5 right-2 flex items-center gap-0.5">
          {conversation.pinned && !hovered && (
            <span className="text-amber-500/70" title="Pinned">
              <Pin size={11} />
            </span>
          )}
          {hovered && (
            <>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); onPin() }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onPin() } }}
                className={`p-0.5 transition-colors ${conversation.pinned ? 'text-amber-500 hover:text-amber-400' : 'text-zinc-600 hover:text-amber-500'}`}
                title={conversation.pinned ? 'Unpin' : 'Pin'}
              >
                <Pin size={11} />
              </span>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); onDelete() }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onDelete() } }}
                className="p-0.5 text-zinc-600 hover:text-red-500 transition-colors"
                title="Delete"
              >
                <Trash2 size={11} />
              </span>
            </>
          )}
        </div>

        {/* Title */}
        <div className={`text-xs leading-snug truncate pr-10 ${isActive ? 'text-zinc-100 font-medium' : isNew ? 'text-emerald-300' : 'text-zinc-300'}`}>
          {conversation.title || 'Untitled conversation'}
        </div>

        {/* Subtitle: time · msgs · cost */}
        <div className="flex items-center gap-1 mt-0.5 text-[10px] text-zinc-600 truncate pr-10">
          <span>{formatRelativeTime(conversation.lastAt)}</span>
          {conversation.messageCount > 0 && (
            <>
              <span className="text-zinc-700">·</span>
              <span>{conversation.messageCount} msg{conversation.messageCount !== 1 ? 's' : ''}</span>
            </>
          )}
          {conversation.totalCostUsd != null && conversation.totalCostUsd > 0 && (
            <>
              <span className="text-zinc-700">·</span>
              <span className={isActive ? 'text-violet-500/60' : 'text-zinc-600'}>
                ${conversation.totalCostUsd < 0.01
                  ? conversation.totalCostUsd.toFixed(4)
                  : conversation.totalCostUsd.toFixed(3)}
              </span>
            </>
          )}
          {isNew && (
            <>
              <span className="text-zinc-700">·</span>
              <span className="text-emerald-500 font-medium">new</span>
            </>
          )}
        </div>
      </button>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-[100] bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            onClick={handlePin}
            className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 flex items-center gap-2 transition-colors"
          >
            <Pin size={12} />
            {conversation.pinned ? 'Unpin' : 'Pin'}
          </button>
          <button
            onClick={handleDelete}
            className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-zinc-800 flex items-center gap-2 transition-colors"
          >
            <Trash2 size={12} />
            Delete
          </button>
          <div className="border-t border-zinc-800 my-1" />
          <button
            onClick={handleCopySessionId}
            className="w-full text-left px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-800 flex items-center gap-2 transition-colors"
          >
            <Copy size={12} />
            Copy session ID
          </button>
        </div>
      )}
    </>
  )
}
