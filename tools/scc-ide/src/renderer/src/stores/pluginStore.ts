// SCC IDE — Plugin store
// Manages installed plugins, search filtering, and install/uninstall actions

import { create } from 'zustand'
import type { PluginCategory } from '../types'

// The three always-installed plugins
const ALWAYS_INSTALLED = [
  'agent-teams',
  'security-scanning',
  'full-stack-orchestration'
]

export interface PluginStore {
  installedPlugins: string[]
  searchQuery: string

  installPlugin(pluginId: string): string
  uninstallPlugin(pluginId: string): void
  setSearch(q: string): void
  getFilteredCategories(categories: PluginCategory[]): PluginCategory[]
}

export const usePluginStore = create<PluginStore>((set, get) => ({
  installedPlugins: [...ALWAYS_INSTALLED],
  searchQuery: '',

  installPlugin(pluginId: string): string {
    const { installedPlugins } = get()
    if (!installedPlugins.includes(pluginId)) {
      set({ installedPlugins: [...installedPlugins, pluginId] })
    }
    return `/plugin install ${pluginId}`
  },

  uninstallPlugin(pluginId: string) {
    // Prevent uninstalling always-installed plugins
    if (ALWAYS_INSTALLED.includes(pluginId)) return

    set((s) => ({
      installedPlugins: s.installedPlugins.filter((id) => id !== pluginId)
    }))
  },

  setSearch(q: string) {
    set({ searchQuery: q })
  },

  getFilteredCategories(categories: PluginCategory[]): PluginCategory[] {
    const { searchQuery } = get()
    const query = searchQuery.toLowerCase().trim()

    if (!query) return categories

    return categories
      .map((cat) => ({
        ...cat,
        plugins: cat.plugins.filter(
          (p) =>
            p.displayName.toLowerCase().includes(query) ||
            p.description.toLowerCase().includes(query) ||
            p.id.toLowerCase().includes(query) ||
            p.slashCommands.some((cmd) => cmd.toLowerCase().includes(query))
        )
      }))
      .filter((cat) => cat.plugins.length > 0)
  }
}))
