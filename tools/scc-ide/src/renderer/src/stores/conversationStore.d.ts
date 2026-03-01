import type { Conversation } from '../types';
export interface ConversationStore {
    conversations: Conversation[];
    activeSessionId: string | null;
    isLoading: boolean;
    loadConversations(): Promise<void>;
    setActive(sessionId: string): void;
    createNew(cwd: string): void;
    deleteConversation(sessionId: string): Promise<void>;
    pinConversation(sessionId: string): Promise<void>;
    upsertConversation(conv: Partial<Conversation> & {
        sessionId: string;
    }): Promise<void>;
}
export declare const useConversationStore: import("zustand").UseBoundStore<import("zustand").StoreApi<ConversationStore>>;
