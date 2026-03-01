/** A conversation maps to a Claude Code session */
export interface Conversation {
    sessionId: string;
    cwd: string;
    title: string;
    pinned: boolean;
    createdAt: number;
    lastAt: number;
    messageCount: number;
}
/** A single message in the chat */
export interface Message {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: MessageContent[];
    timestamp: number;
    sessionId?: string;
    costUsd?: number;
}
/** Content block types — mirrors Claude stream-json format */
export type MessageContent = {
    type: 'text';
    text: string;
} | {
    type: 'thinking';
    thinking: string;
} | {
    type: 'tool_use';
    toolName: string;
    input: Record<string, unknown>;
    toolUseId: string;
} | {
    type: 'tool_result';
    toolUseId: string;
    content: string;
    isError?: boolean;
} | {
    type: 'hitl';
    action: string;
    path?: string;
    content?: string;
} | {
    type: 'squad_run';
    squad: string;
    output: string;
    done: boolean;
};
/** A pending file attachment on the chat input */
export interface Attachment {
    id: string;
    name: string;
    type: 'image' | 'pdf' | 'text' | 'other';
    content: string;
    mimeType: string;
    size: number;
}
/** A single plugin from the wshobson agents catalog */
export interface Plugin {
    id: string;
    displayName: string;
    description: string;
    slashCommands: string[];
    installCommand: string;
    category: string;
    opaiPriority: 'always-installed' | 'high' | 'medium' | 'low' | 'not-relevant';
    whenToUse?: string;
}
/** A group of plugins by category */
export interface PluginCategory {
    name: string;
    priority: number;
    plugins: Plugin[];
}
/** An OPAI squad definition */
export interface Squad {
    id: string;
    displayName: string;
    description: string;
    agents: string[];
    schedule?: string;
    category: 'development' | 'security' | 'quality' | 'operations' | 'auto-fix';
    hitlRequired?: boolean;
    favorite?: boolean;
    requiresTask?: boolean;
}
/** A human-in-the-loop review item */
export interface HitlItem {
    path: string;
    filename: string;
    timestamp: number;
    preview: string;
    done: boolean;
}
declare global {
}
