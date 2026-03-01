import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

// Channels the renderer may listen to for streaming data
const STREAM_CHANNELS = [
  'claude:stream',
  'claude:done',
  'claude:error',
  'claude:permission-request',
  'squad:output',
  'squad:done',
  'hitl:new',
  'hitl-update',
  'conversation-updated'
] as const

type StreamChannel = (typeof STREAM_CHANNELS)[number]

// Validate channel to prevent arbitrary IPC listening
function isValidChannel(channel: string): channel is StreamChannel {
  return (STREAM_CHANNELS as readonly string[]).includes(channel)
}

const scc = {
  // -- Claude CLI --
  spawn: (opts: { cwd: string; prompt: string; sessionId?: string; model?: string }) =>
    ipcRenderer.invoke('claude:spawn', opts),
  stop: () => ipcRenderer.invoke('claude:stop'),

  // -- Sessions --
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  deleteSession: (sessionId: string) => ipcRenderer.invoke('sessions:delete', sessionId),

  // -- Shell --
  openExternal: (target: string) => ipcRenderer.invoke('shell:open', target),

  // -- Squad --
  runSquad: (opts: { squadName: string; task?: string }) =>
    ipcRenderer.invoke('squad:run', opts),

  // -- HITL --
  listHITL: () => ipcRenderer.invoke('hitl:list'),
  doneHITL: (filename: string) => ipcRenderer.invoke('hitl:done', filename),
  readHITL: (filename: string) => ipcRenderer.invoke('hitl:read', filename),
  permissionRespond: (requestId: string, approved: boolean) =>
    ipcRenderer.invoke('claude:permission-respond', { requestId, approved }),

  // -- App --
  getVersion: () => ipcRenderer.invoke('app:version'),

  // -- Window controls (frameless titlebar) --
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),

  // -- Conversation DB --
  upsertConversation: (data: {
    session_id: string
    cwd: string
    title: string
    created_at?: number
    last_at?: number
    message_count?: number
  }) => ipcRenderer.invoke('db:upsert-conversation', data),
  listConversations: () => ipcRenderer.invoke('db:list-conversations'),
  pinConversation: (sessionId: string) => ipcRenderer.invoke('db:pin-conversation', sessionId),
  deleteConversation: (sessionId: string) =>
    ipcRenderer.invoke('db:delete-conversation', sessionId),
  loadMessages: (sessionId: string) => ipcRenderer.invoke('db:load-messages', sessionId),

  // -- File intake --
  writeTempFile: (dataUrl: string, name: string) =>
    ipcRenderer.invoke('files:write-temp', { dataUrl, name }),

  // -- Status --
  getServiceStatus: () => ipcRenderer.invoke('status:services'),
  getUsage: () => ipcRenderer.invoke('status:usage'),

  // -- Event listeners for streaming channels --
  on: (channel: string, callback: (...args: any[]) => void): void => {
    if (!isValidChannel(channel)) {
      console.warn(`scc.on: invalid channel "${channel}"`)
      return
    }
    const listener = (_event: IpcRendererEvent, ...args: any[]): void => callback(...args)
    ipcRenderer.on(channel, listener)
    // Store reference so off() can remove the correct listener
    ;(callback as any).__sccListener = listener
  },

  off: (channel: string, callback: (...args: any[]) => void) => {
    if (!isValidChannel(channel)) return
    const listener = (callback as any).__sccListener
    if (listener) {
      ipcRenderer.removeListener(channel, listener)
      delete (callback as any).__sccListener
    }
  }
}

// Expose as window.scc via contextBridge
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('scc', scc)
  } catch (error) {
    console.error('Failed to expose scc API:', error)
  }
} else {
  // @ts-ignore fallback for non-isolated contexts
  window.scc = scc
}
