import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Plus, Search, MessageSquare } from 'lucide-react'
import ConversationItem from './ConversationItem'
import type { Conversation } from '../../types'

interface ConversationListProps {
  activeSessionId: string | null
  onSelect: (sessionId: string) => void
  onNewChat: () => void
}

interface GroupedConversations {
  label: string
  conversations: Conversation[]
}

function groupConversations(
  conversations: Conversation[],
  activeSessionId: string | null
): GroupedConversations[] {
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const yesterdayStart = new Date(todayStart)
  yesterdayStart.setDate(yesterdayStart.getDate() - 1)
  const weekStart = new Date(todayStart)
  weekStart.setDate(weekStart.getDate() - 7)

  // Active conversation gets its own "Current" group — excluded from time groups
  const active = activeSessionId ? conversations.find((c) => c.sessionId === activeSessionId) : null
  const rest = active ? conversations.filter((c) => c.sessionId !== activeSessionId) : conversations

  const pinned: Conversation[] = []
  const today: Conversation[] = []
  const yesterday: Conversation[] = []
  const thisWeek: Conversation[] = []
  const older: Conversation[] = []

  for (const conv of rest) {
    if (conv.pinned) { pinned.push(conv); continue }
    const ts = conv.lastAt || 0
    if (ts >= todayStart.getTime()) today.push(conv)
    else if (ts >= yesterdayStart.getTime()) yesterday.push(conv)
    else if (ts >= weekStart.getTime()) thisWeek.push(conv)
    else older.push(conv)
  }

  const groups: GroupedConversations[] = []
  if (active) groups.push({ label: 'Current', conversations: [active] })
  if (pinned.length > 0) groups.push({ label: 'Pinned', conversations: pinned })
  if (today.length > 0) groups.push({ label: 'Today', conversations: today })
  if (yesterday.length > 0) groups.push({ label: 'Yesterday', conversations: yesterday })
  if (thisWeek.length > 0) groups.push({ label: 'This Week', conversations: thisWeek })
  if (older.length > 0) groups.push({ label: 'Older', conversations: older })

  return groups
}

export default function ConversationList({
  activeSessionId,
  onSelect,
  onNewChat,
}: ConversationListProps): React.ReactElement {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [search, setSearch] = useState('')
  const [newSessionIds, setNewSessionIds] = useState<Set<string>>(new Set())

  // seenSessionIds: tracks sessions the user has already seen (opened or were present on first load)
  const seenSessionIdsRef = useRef<Set<string>>(new Set())
  const initialLoadDone = useRef(false)

  const loadConversations = useCallback(async () => {
    try {
      const rows = await window.scc.listConversations()
      const list: Conversation[] = rows.map((row) => ({
        sessionId: row.session_id,
        cwd: row.cwd,
        title: row.title,
        pinned: Boolean(row.pinned),
        createdAt: row.created_at,
        lastAt: row.last_at,
        messageCount: row.message_count,
        totalCostUsd: row.total_cost_usd ?? null,
      }))
      list.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))

      if (!initialLoadDone.current) {
        // First load: mark all existing sessions as seen (no green highlight on first open)
        initialLoadDone.current = true
        for (const c of list) seenSessionIdsRef.current.add(c.sessionId)
      } else {
        // Subsequent loads: any session not previously seen is "new"
        const newIds = new Set<string>()
        for (const c of list) {
          if (!seenSessionIdsRef.current.has(c.sessionId)) {
            newIds.add(c.sessionId)
          }
        }
        if (newIds.size > 0) {
          setNewSessionIds((prev) => {
            const merged = new Set(prev)
            for (const id of newIds) merged.add(id)
            return merged
          })
        }
      }

      setConversations(list)
    } catch {
      // IPC not ready yet — ignore
    }
  }, [])

  // Load on mount + poll every 30s
  useEffect(() => {
    loadConversations()
    const interval = setInterval(loadConversations, 30_000)
    return () => clearInterval(interval)
  }, [loadConversations])

  // Reload when a conversation stream ends
  useEffect(() => {
    function onConvUpdated(...args: unknown[]): void {
      const payload = args[0] as { sessionId?: string; totalCostUsd?: number } | undefined
      if (payload?.sessionId && payload.totalCostUsd != null) {
        setConversations((prev) =>
          prev.map((c) =>
            c.sessionId === payload.sessionId ? { ...c, totalCostUsd: payload.totalCostUsd } : c
          )
        )
      }
      loadConversations()
    }
    window.scc.on('conversation-updated', onConvUpdated)
    return () => { window.scc.off('conversation-updated', onConvUpdated) }
  }, [loadConversations])

  // When user opens a conversation, mark it as seen and clear green highlight
  function handleSelect(sessionId: string): void {
    seenSessionIdsRef.current.add(sessionId)
    setNewSessionIds((prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
    onSelect(sessionId)
  }

  async function handleDelete(sessionId: string): Promise<void> {
    try {
      await window.scc.deleteConversation(sessionId)
      seenSessionIdsRef.current.delete(sessionId)
      setNewSessionIds((prev) => { const n = new Set(prev); n.delete(sessionId); return n })
      setConversations((prev) => prev.filter((c) => c.sessionId !== sessionId))
    } catch { /* ignore */ }
  }

  async function handlePin(sessionId: string, currentPinned: boolean): Promise<void> {
    try {
      await window.scc.pinConversation(sessionId, !currentPinned as boolean)
      setConversations((prev) =>
        prev.map((c) => c.sessionId === sessionId ? { ...c, pinned: !currentPinned } : c)
      )
    } catch { /* ignore */ }
  }

  const filtered = search.trim()
    ? conversations.filter(
        (c) =>
          c.title.toLowerCase().includes(search.toLowerCase()) ||
          c.cwd.toLowerCase().includes(search.toLowerCase())
      )
    : conversations

  const groups = groupConversations(filtered, search.trim() ? null : activeSessionId)

  return (
    <div className="w-full min-w-0 bg-zinc-950 border-r border-zinc-800 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-zinc-800">
        <span className="text-sm font-semibold text-zinc-200 tracking-wide">Conversations</span>
        <button
          onClick={onNewChat}
          className="w-7 h-7 flex items-center justify-center rounded text-zinc-400 hover:bg-violet-600 hover:text-white transition-colors"
          title="New chat"
        >
          <Plus size={16} />
        </button>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" />
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-zinc-900 border border-zinc-800 rounded text-zinc-300 placeholder-zinc-600 outline-none focus:border-violet-600 transition-colors"
          />
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-6">
            <MessageSquare size={28} className="text-zinc-700 mb-3" />
            <p className="text-xs text-zinc-500">No conversations yet</p>
            <button
              onClick={onNewChat}
              className="mt-2 text-xs text-violet-400 hover:text-violet-300 transition-colors"
            >
              Start a new chat +
            </button>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label}>
              <div className="px-3 pt-2 pb-0.5 text-[10px] text-zinc-600 uppercase font-semibold tracking-wider">
                {group.label}
              </div>
              {group.conversations.map((conv) => (
                <ConversationItem
                  key={conv.sessionId}
                  conversation={conv}
                  isActive={activeSessionId === conv.sessionId}
                  isNew={newSessionIds.has(conv.sessionId)}
                  onClick={() => handleSelect(conv.sessionId)}
                  onDelete={() => handleDelete(conv.sessionId)}
                  onPin={() => handlePin(conv.sessionId, conv.pinned)}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
