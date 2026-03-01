// SCC IDE — Conversation list store
// Manages the sidebar conversation list, active selection, pinning, and CRUD

import { create } from 'zustand'
import type { Conversation } from '../types'

export interface ConversationStore {
  conversations: Conversation[]
  activeSessionId: string | null
  isLoading: boolean

  loadConversations(): Promise<void>
  setActive(sessionId: string): void
  createNew(cwd: string): void
  deleteConversation(sessionId: string): Promise<void>
  pinConversation(sessionId: string): Promise<void>
  upsertConversation(conv: Partial<Conversation> & { sessionId: string }): Promise<void>
}

function rowToConversation(row: SccConversationRow): Conversation {
  return {
    sessionId: row.session_id,
    cwd: row.cwd,
    title: row.title,
    pinned: Boolean(row.pinned),
    createdAt: row.created_at,
    lastAt: row.last_at,
    messageCount: row.message_count,
  }
}

export const useConversationStore = create<ConversationStore>((set, get) => ({
  conversations: [],
  activeSessionId: null,
  isLoading: false,

  async loadConversations() {
    set({ isLoading: true })
    try {
      // Load from IPC bridge — listConversations returns our stored metadata,
      // listSessions returns raw Claude session info for cross-reference
      const [stored, sessionInfos] = await Promise.all([
        window.scc.listConversations(),
        window.scc.listSessions()
      ])

      // Build a map of stored conversations by sessionId
      const storedMap = new Map<string, Conversation>()
      for (const row of stored) {
        const conv = rowToConversation(row)
        storedMap.set(conv.sessionId, conv)
      }

      // Merge: include all stored conversations; also add any sessions
      // found on disk that we don't have metadata for yet
      const merged: Conversation[] = [...storedMap.values()]
      for (const info of sessionInfos) {
        if (!storedMap.has(info.sessionId)) {
          merged.push({
            sessionId: info.sessionId,
            cwd: info.cwd,
            title: info.title || 'Untitled',
            pinned: false,
            createdAt: Date.now(),
            lastAt: info.lastAt,
            messageCount: info.messageCount,
          })
        }
      }

      // Sort: pinned first, then by lastAt descending
      merged.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.lastAt - a.lastAt
      })

      set({ conversations: merged, isLoading: false })
    } catch (err) {
      console.error('Failed to load conversations:', err)
      set({ isLoading: false })
    }
  },

  setActive(sessionId: string) {
    set({ activeSessionId: sessionId })
  },

  createNew(_cwd: string) {
    // Setting activeSessionId to null signals "new chat" mode
    // The chat store will create a new session on first message send
    set({ activeSessionId: null })
  },

  async deleteConversation(sessionId: string) {
    try {
      await window.scc.deleteConversation(sessionId)
      const { conversations, activeSessionId } = get()
      const updated = conversations.filter((c) => c.sessionId !== sessionId)
      set({
        conversations: updated,
        // Clear active if we deleted the active conversation
        activeSessionId: activeSessionId === sessionId ? null : activeSessionId
      })
    } catch (err) {
      console.error('Failed to delete conversation:', err)
    }
  },

  async pinConversation(sessionId: string) {
    const { conversations } = get()
    const conv = conversations.find((c) => c.sessionId === sessionId)
    if (!conv) return

    const newPinned = !conv.pinned
    try {
      await window.scc.pinConversation(sessionId, newPinned)

      const updated = conversations.map((c) =>
        c.sessionId === sessionId ? { ...c, pinned: newPinned } : c
      )
      // Re-sort after pin change
      updated.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.lastAt - a.lastAt
      })
      set({ conversations: updated })
    } catch (err) {
      console.error('Failed to pin conversation:', err)
    }
  },

  async upsertConversation(conv: Partial<Conversation> & { sessionId: string }) {
    try {
      await window.scc.upsertConversation({
        session_id: conv.sessionId,
        cwd: conv.cwd ?? '',
        title: conv.title ?? 'Untitled',
        created_at: conv.createdAt,
        last_at: conv.lastAt,
        message_count: conv.messageCount,
      })
      const { conversations } = get()
      const idx = conversations.findIndex((c) => c.sessionId === conv.sessionId)

      let updated: Conversation[]
      if (idx >= 0) {
        // Update existing
        updated = conversations.map((c) =>
          c.sessionId === conv.sessionId ? { ...c, ...conv } : c
        )
      } else {
        // Insert new
        const full: Conversation = {
          cwd: conv.cwd ?? '',
          title: conv.title ?? 'Untitled',
          pinned: conv.pinned ?? false,
          createdAt: conv.createdAt ?? Date.now(),
          lastAt: conv.lastAt ?? Date.now(),
          messageCount: conv.messageCount ?? 0,
          ...conv
        }
        updated = [full, ...conversations]
      }

      // Re-sort
      updated.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.lastAt - a.lastAt
      })
      set({ conversations: updated })
    } catch (err) {
      console.error('Failed to upsert conversation:', err)
    }
  }
}))
