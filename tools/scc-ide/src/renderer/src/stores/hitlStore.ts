// SCC IDE — HITL (Human-in-the-Loop) store
// Manages HITL review items from reports/HITL/ directory

import { create } from 'zustand'
import type { HitlItem } from '../types'

export interface HitlStore {
  items: HitlItem[]
  unreadCount: number

  loadItems(): Promise<void>
  markDone(path: string): Promise<void>
  readItem(path: string): Promise<string>
  onNewItem(path: string): void
}

function fileToHitlItem(f: SccHITLFile): HitlItem {
  return {
    path: f.path,
    filename: f.filename,
    timestamp: f.mtime,
    preview: f.preview ?? 'Click to review',
    done: f.done ?? false,
  }
}

let hitlCallback: ((...args: unknown[]) => void) | null = null

export const useHitlStore = create<HitlStore>((set, get) => {
  // Subscribe to IPC event for new HITL items
  function setupListener(): void {
    if (typeof window === 'undefined' || !window.scc) return
    // Remove previous listener if any
    if (hitlCallback) {
      window.scc.off('hitl:new', hitlCallback)
    }
    hitlCallback = (...args: unknown[]) => {
      const path = args[0] as string
      if (path) get().onNewItem(path)
    }
    window.scc.on('hitl:new', hitlCallback)
  }

  setTimeout(setupListener, 0)

  return {
    items: [],
    unreadCount: 0,

    async loadItems() {
      try {
        const files = await window.scc.listHITL()
        const items = files.map(fileToHitlItem)
        const unreadCount = items.filter((i) => !i.done).length
        set({ items, unreadCount })
      } catch (err) {
        console.error('Failed to load HITL items:', err)
      }
    },

    async markDone(path: string) {
      try {
        await window.scc.doneHITL(path)
        set((s) => {
          const updated = s.items.map((i) =>
            i.path === path ? { ...i, done: true } : i
          )
          return {
            items: updated,
            unreadCount: updated.filter((i) => !i.done).length
          }
        })
      } catch (err) {
        console.error('Failed to mark HITL item done:', err)
      }
    },

    async readItem(path: string): Promise<string> {
      try {
        const result = await window.scc.readHITL(path)
        return result.content ?? ''
      } catch (err) {
        console.error('Failed to read HITL item:', err)
        return ''
      }
    },

    onNewItem(path: string) {
      // Extract filename from path
      const filename = path.split('/').pop() ?? path

      const newItem: HitlItem = {
        path,
        filename,
        timestamp: Date.now(),
        preview: 'New HITL item — click to review',
        done: false
      }

      set((s) => ({
        items: [newItem, ...s.items],
        unreadCount: s.unreadCount + 1
      }))
    }
  }
})
