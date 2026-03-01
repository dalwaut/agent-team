/// <reference types="vite/client" />

// ─── window.scc — IPC bridge exposed by Electron contextBridge ───────────────
// Ambient declaration (no imports/exports) — augments Window globally.

interface SccImageInput {
  base64: string
  mimeType: string
  name: string
}

interface SccSpawnOpts {
  cwd: string
  prompt: string
  sessionId?: string
  model?: string
  images?: SccImageInput[]
}

interface SccSquadOpts {
  squadName: string
  task?: string
}

interface SccConversationData {
  session_id: string
  cwd: string
  title: string
  created_at?: number
  last_at?: number
  message_count?: number
}

interface SccConversationRow {
  session_id: string
  cwd: string
  title: string
  pinned: number
  created_at: number
  last_at: number
  message_count: number
  total_cost_usd?: number | null
}

interface SccSessionInfo {
  sessionId: string
  cwd: string
  title: string
  lastAt: number
  messageCount: number
}

interface SccHITLFile {
  filename: string
  path: string
  mtime: number
  done?: boolean
  preview?: string
}

type SccStreamChannel =
  | 'claude:stream'
  | 'claude:done'
  | 'claude:error'
  | 'claude:permission-request'
  | 'squad:output'
  | 'squad:done'
  | 'hitl:new'
  | 'hitl-update'
  | 'conversation-updated'

interface SccServiceStatus {
  name: string
  active: string
  sub: string
  running: boolean
  description: string
}

interface SccUsage {
  five_hour: { utilization: number; resets_at: string } | null
  seven_day: { utilization: number; resets_at: string } | null
  seven_day_sonnet: { utilization: number; resets_at: string } | null
  extra_usage: { is_enabled: boolean; monthly_limit: number; used_credits: number; utilization: number } | null
}

interface SccLoadedMessage {
  id: string
  role: 'user' | 'assistant'
  content: Array<{ type: string; [key: string]: unknown }>
  timestamp: number
  costUsd?: number
}

interface SccAPI {
  spawn(opts: SccSpawnOpts): Promise<{ started: boolean }>
  stop(): Promise<{ stopped: boolean }>
  listSessions(): Promise<SccSessionInfo[]>
  deleteSession(sessionId: string): Promise<{ deleted: boolean; error?: string }>
  openExternal(target: string): Promise<void>
  runSquad(opts: SccSquadOpts): Promise<{ started: boolean }>
  listHITL(): Promise<SccHITLFile[]>
  doneHITL(filename: string): Promise<{ moved: boolean; error?: string }>
  readHITL(filename: string): Promise<{ content: string | null; error?: string }>
  permissionRespond(requestId: string, approved: boolean): Promise<{ sent: boolean }>
  getVersion(): Promise<string>
  minimize(): Promise<void>
  maximize(): Promise<void>
  close(): Promise<void>
  upsertConversation(data: SccConversationData): Promise<{ ok: boolean; error?: string }>
  listConversations(): Promise<SccConversationRow[]>
  pinConversation(sessionId: string, pinned?: boolean): Promise<{ ok: boolean; pinned?: number; error?: string }>
  deleteConversation(sessionId: string): Promise<{ ok: boolean; error?: string }>
  loadMessages(sessionId: string): Promise<{ ok: boolean; messages: SccLoadedMessage[]; error?: string }>
  getServiceStatus(): Promise<{ ok: boolean; services: SccServiceStatus[]; error?: string }>
  getUsage(): Promise<{ ok: boolean; usage: SccUsage | null; error?: string }>
  on(channel: SccStreamChannel, callback: (...args: unknown[]) => void): void
  off(channel: SccStreamChannel, callback: (...args: unknown[]) => void): void
}

// Top-level interface augmentation (ambient file — no declare global wrapper needed)
interface Window {
  scc: SccAPI
}
