// SCC IDE — Chat store
// Manages the active chat session: messages, streaming state, thinking, attachments
// Subscribes to IPC events for real-time stream processing

import { create } from 'zustand'
import type { Message, MessageContent, Attachment } from '../types'
import { parseStreamLine } from '../lib/utils'

export interface ChatStore {
  messages: Message[]
  isStreaming: boolean
  thinkingText: string
  isThinking: boolean
  streamingContent: string
  attachments: Attachment[]

  addMessage(msg: Message): void
  appendThinking(text: string): void
  setThinking(value: boolean): void
  appendStreaming(text: string): void
  flushStreaming(): void
  clearChat(): void
  setStreaming(value: boolean): void
  addAttachment(a: Attachment): void
  removeAttachment(id: string): void
  clearAttachments(): void
}

let streamCallback: ((...args: unknown[]) => void) | null = null
let doneCallback: (() => void) | null = null

export const useChatStore = create<ChatStore>((set, get) => {
  // ---------------------------------------------------------------------------
  // IPC event subscriptions — set up once on store creation
  // ---------------------------------------------------------------------------
  function setupListeners(): void {
    // Guard: only subscribe if window.scc is available (renderer process)
    if (typeof window === 'undefined' || !window.scc) return

    // Clean up previous listeners if any
    if (streamCallback) window.scc.off('claude:stream', streamCallback)
    if (doneCallback) window.scc.off('claude:done', doneCallback)

    // Subscribe to streaming data from Claude CLI
    streamCallback = (...args: unknown[]) => {
      const line = args[0] as string
      if (!line) return
      const parsed = parseStreamLine(line)
      if (!parsed) return
      processStreamEvent(parsed)
    }
    window.scc.on('claude:stream', streamCallback)

    // Subscribe to stream completion
    doneCallback = () => {
      const state = get()
      if (state.isStreaming) {
        state.flushStreaming()
        set({ isStreaming: false, isThinking: false, thinkingText: '' })
      }
    }
    window.scc.on('claude:done', doneCallback)
  }

  /**
   * Process a parsed stream-json event from Claude CLI.
   * Detects thinking blocks, text blocks, tool use/result blocks.
   */
  function processStreamEvent(event: Record<string, unknown>): void {
    const eventType = event.type as string | undefined

    // --- Thinking block ---
    if (eventType === 'content_block_start') {
      const block = event.content_block as Record<string, unknown> | undefined
      if (block?.type === 'thinking') {
        set({ isThinking: true, thinkingText: '' })
        return
      }
    }

    if (eventType === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined
      if (!delta) return

      const deltaType = delta.type as string | undefined

      // Thinking delta
      if (deltaType === 'thinking_delta') {
        const text = delta.thinking as string
        if (text) {
          set((s) => ({ thinkingText: s.thinkingText + text }))
        }
        return
      }

      // Text delta
      if (deltaType === 'text_delta') {
        const text = delta.text as string
        if (text) {
          set((s) => ({ streamingContent: s.streamingContent + text }))
        }
        return
      }
    }

    if (eventType === 'content_block_stop') {
      const state = get()
      // If we were thinking, finalize the thinking block
      if (state.isThinking && state.thinkingText) {
        appendContentToCurrentMessage({
          type: 'thinking',
          thinking: state.thinkingText
        })
        set({ isThinking: false, thinkingText: '' })
      }
      return
    }

    // --- Tool use ---
    if (eventType === 'tool_use' || (eventType === 'content_block_start' &&
      (event.content_block as Record<string, unknown>)?.type === 'tool_use')) {
      const block = (event.content_block as Record<string, unknown>) ?? event
      const toolUse: MessageContent = {
        type: 'tool_use',
        toolName: (block.name as string) ?? 'unknown',
        input: (block.input as Record<string, unknown>) ?? {},
        toolUseId: (block.id as string) ?? ''
      }
      appendContentToCurrentMessage(toolUse)
      return
    }

    // --- Tool result ---
    if (eventType === 'tool_result') {
      const toolResult: MessageContent = {
        type: 'tool_result',
        toolUseId: (event.tool_use_id as string) ?? '',
        content: (event.content as string) ?? '',
        isError: (event.is_error as boolean) ?? false
      }
      appendContentToCurrentMessage(toolResult)
      return
    }

    // --- Message start (set up assistant message) ---
    if (eventType === 'message_start') {
      const msg = event.message as Record<string, unknown> | undefined
      if (msg?.role === 'assistant') {
        const newMsg: Message = {
          id: (msg.id as string) ?? `msg_${Date.now()}`,
          role: 'assistant',
          content: [],
          timestamp: Date.now(),
          costUsd: undefined
        }
        set((s) => ({ messages: [...s.messages, newMsg] }))
      }
      return
    }

    // --- Message stop / message_delta with usage ---
    if (eventType === 'message_delta') {
      const usage = event.usage as Record<string, unknown> | undefined
      if (usage) {
        // Could extract cost info here if available
      }
      return
    }
  }

  /**
   * Append a content block to the most recent assistant message.
   */
  function appendContentToCurrentMessage(block: MessageContent): void {
    set((s) => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last && last.role === 'assistant') {
        msgs[msgs.length - 1] = {
          ...last,
          content: [...last.content, block]
        }
      }
      return { messages: msgs }
    })
  }

  // Initialize listeners after a micro-tick so the store is fully created
  setTimeout(setupListeners, 0)

  // ---------------------------------------------------------------------------
  // Store definition
  // ---------------------------------------------------------------------------
  return {
    messages: [],
    isStreaming: false,
    thinkingText: '',
    isThinking: false,
    streamingContent: '',
    attachments: [],

    addMessage(msg: Message) {
      set((s) => ({ messages: [...s.messages, msg] }))
    },

    appendThinking(text: string) {
      set((s) => ({ thinkingText: s.thinkingText + text }))
    },

    setThinking(value: boolean) {
      set({ isThinking: value })
      if (!value) set({ thinkingText: '' })
    },

    appendStreaming(text: string) {
      set((s) => ({ streamingContent: s.streamingContent + text }))
    },

    flushStreaming() {
      const { streamingContent } = get()
      if (!streamingContent) return

      // Append the accumulated text as a content block on the last assistant message
      appendContentToCurrentMessage({ type: 'text', text: streamingContent })
      set({ streamingContent: '' })
    },

    clearChat() {
      set({
        messages: [],
        isStreaming: false,
        thinkingText: '',
        isThinking: false,
        streamingContent: '',
        attachments: []
      })
    },

    setStreaming(value: boolean) {
      set({ isStreaming: value })
    },

    addAttachment(a: Attachment) {
      set((s) => ({ attachments: [...s.attachments, a] }))
    },

    removeAttachment(id: string) {
      set((s) => ({
        attachments: s.attachments.filter((a) => a.id !== id)
      }))
    },

    clearAttachments() {
      set({ attachments: [] })
    }
  }
})
