// SCC IDE — Shared TypeScript types
// All interfaces used across stores, components, and utilities

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/** A conversation maps to a Claude Code session */
export interface Conversation {
  sessionId: string
  cwd: string
  title: string
  pinned: boolean
  createdAt: number // unix ms
  lastAt: number // unix ms
  messageCount: number
  totalCostUsd?: number | null
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** A single message in the chat */
export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: MessageContent[]
  timestamp: number
  sessionId?: string
  costUsd?: number
}

/** One item inside a thought_group block */
export interface ThoughtItem {
  kind: 'thought' | 'tool'
  text: string       // thought: full text; tool: the detail/path/command
  toolName?: string  // tool kind only: e.g. "Read", "Bash", "Write"
  elapsedSec: number
}

/** Content block types — mirrors Claude stream-json format */
export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'image'; dataUrl: string; name: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'thought_group'; items: ThoughtItem[] }  // collapsed thoughts+tools between messages
  | { type: 'tool_use'; toolName: string; input: Record<string, unknown>; toolUseId: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'hitl'; action: string; path?: string; content?: string; requestId?: string; toolName?: string; filename?: string }
  | { type: 'squad_run'; squad: string; output: string; done: boolean }

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** A pending file attachment on the chat input */
export interface Attachment {
  id: string
  name: string
  type: 'image' | 'pdf' | 'text' | 'other'
  content: string // base64 for images, text for others
  mimeType: string
  size: number
}

// ---------------------------------------------------------------------------
// Plugins (wshobson catalog)
// ---------------------------------------------------------------------------

/** A single plugin from the wshobson agents catalog */
export interface Plugin {
  id: string
  displayName: string
  description: string
  slashCommands: string[]
  installCommand: string
  category: string
  opaiPriority: 'always-installed' | 'high' | 'medium' | 'low' | 'not-relevant'
  whenToUse?: string
}

/** A group of plugins by category */
export interface PluginCategory {
  name: string
  priority: number
  plugins: Plugin[]
}

// ---------------------------------------------------------------------------
// Squads
// ---------------------------------------------------------------------------

/** An OPAI squad definition */
export interface Squad {
  id: string
  displayName: string
  description: string
  agents: string[]
  schedule?: string
  category: 'development' | 'security' | 'quality' | 'operations' | 'auto-fix'
  hitlRequired?: boolean
  favorite?: boolean
  requiresTask?: boolean
}

// ---------------------------------------------------------------------------
// HITL
// ---------------------------------------------------------------------------

/** A human-in-the-loop review item */
export interface HitlItem {
  path: string
  filename: string
  timestamp: number
  preview: string
  done: boolean
}

declare global {
  // window.scc is declared authoritatively in src/preload/index.d.ts
  // Do not redeclare here to avoid type conflicts.
}
