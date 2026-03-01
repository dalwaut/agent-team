import type { Message, Attachment } from '../types';
export interface ChatStore {
    messages: Message[];
    isStreaming: boolean;
    thinkingText: string;
    isThinking: boolean;
    streamingContent: string;
    attachments: Attachment[];
    addMessage(msg: Message): void;
    appendThinking(text: string): void;
    setThinking(value: boolean): void;
    appendStreaming(text: string): void;
    flushStreaming(): void;
    clearChat(): void;
    setStreaming(value: boolean): void;
    addAttachment(a: Attachment): void;
    removeAttachment(id: string): void;
    clearAttachments(): void;
}
export declare const useChatStore: import("zustand").UseBoundStore<import("zustand").StoreApi<ChatStore>>;
