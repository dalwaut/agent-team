import type { HitlItem } from '../types';
export interface HitlStore {
    items: HitlItem[];
    unreadCount: number;
    loadItems(): Promise<void>;
    markDone(path: string): Promise<void>;
    readItem(path: string): Promise<string>;
    onNewItem(path: string): void;
}
export declare const useHitlStore: import("zustand").UseBoundStore<import("zustand").StoreApi<HitlStore>>;
