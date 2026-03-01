import type { PluginCategory } from '../types';
export interface PluginStore {
    installedPlugins: string[];
    searchQuery: string;
    installPlugin(pluginId: string): string;
    uninstallPlugin(pluginId: string): void;
    setSearch(q: string): void;
    getFilteredCategories(categories: PluginCategory[]): PluginCategory[];
}
export declare const usePluginStore: import("zustand").UseBoundStore<import("zustand").StoreApi<PluginStore>>;
