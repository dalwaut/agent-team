import React, { useEffect, useRef, useState, useCallback } from 'react'
import type { Message, MessageContent, Attachment } from '../../types'
import MessageBubble from './MessageBubble'
import ThinkingBlock from './ThinkingBlock'
import ThoughtGroup from './ThoughtGroup'
import InputArea from './InputArea'

// ---- Types ----

interface ThinkingEntry {
  id: string
  type: 'thinking' | 'tool_call'
  text: string       // thinking text, or tool summary ("Read: /path/to/file")
  isActive: boolean  // true = spinner (thinking in progress)
  elapsedSec: number
}

interface QueuedMessage {
  text: string
  attachments: Attachment[]
}

interface ChatState {
  messages: Message[]
  isStreaming: boolean
  thinkingEntries: ThinkingEntry[] // newest first
  streamingContent: string         // current turn's text only (shown immediately)
  queueSize: number
}

interface ChatAreaProps {
  sessionId?: string | null
  cwd?: string
  model?: string
  onSessionCreated?: (sessionId: string) => void
  onCostChange?: (totalUsd: number) => void
}

const DEFAULT_CWD = '/workspace/synced/opai'
const DEFAULT_MODEL = 'claude-sonnet-4-6'

function buildPrompt(text: string, attachments: Attachment[]): string {
  const parts: string[] = []
  for (const att of attachments) {
    if (att.type === 'image') {
      // Images are passed as vision content blocks via stream-json input — skip in prompt text
      continue
    } else if (att.type === 'text') {
      const ext = att.name.split('.').pop() || 'txt'
      parts.push(`[File: ${att.name}]`)
      parts.push('```' + ext)
      parts.push(att.content)
      parts.push('```')
      parts.push('')
    } else if (att.type === 'pdf') {
      parts.push(`[File: ${att.name}] (PDF -- Claude will receive extracted text)`)
      parts.push(att.content)
      parts.push('')
    } else {
      parts.push(`[File: ${att.name}]`)
      parts.push(att.content)
      parts.push('')
    }
  }
  if (text) parts.push(text)
  return parts.join('\n')
}

/** Produce a short human-readable label for a tool_use block */
function summarizeToolCall(block: { type: string; name?: string; input?: Record<string, unknown> }): string {
  const name = block.name || 'tool'
  const inp = block.input || {}
  if (inp.file_path) return `${name}: ${String(inp.file_path)}`
  if (inp.command)   return `${name}: ${String(inp.command).slice(0, 70)}`
  if (inp.pattern)   return `${name}: ${String(inp.pattern)}`
  if (inp.path)      return `${name}: ${String(inp.path)}`
  if (inp.url)       return `${name}: ${String(inp.url)}`
  if (inp.query)     return `${name}: ${String(inp.query)}`
  const keys = Object.keys(inp)
  if (keys.length > 0) return `${name}: ${String(inp[keys[0]]).slice(0, 70)}`
  return name
}

export default function ChatArea({ sessionId, cwd: cwdProp, model: modelProp, onSessionCreated, onCostChange }: ChatAreaProps): React.ReactElement {
  const [state, setState] = useState<ChatState>({
    messages: [],
    isStreaming: false,
    thinkingEntries: [],
    streamingContent: '',
    queueSize: 0,
  })

  // ---- Refs ----
  const lockedTextPrefixRef  = useRef('')          // text from completed turns, shown instantly
  const thinkingClosedRef    = useRef(false)        // true after text arrives; next thinking = new entry
  const thinkingStartRef     = useRef(0)            // timestamp for elapsed time calc
  const processedToolIdsRef  = useRef<Set<string>>(new Set())  // dedup tool_use entries
  const pendingQueueRef      = useRef<QueuedMessage[]>([])
  const isStreamingRef       = useRef(false)
  const processMessageRef    = useRef<((text: string, attachments: Attachment[]) => void) | null>(null)
  const prevSessionIdRef     = useRef<string | null | undefined>(undefined) // tracks previous session
  const scrollRef            = useRef<HTMLDivElement>(null)
  const bottomRef            = useRef<HTMLDivElement>(null)
  const handleSendRef        = useRef<((text: string, attachments: Attachment[]) => void) | null>(null)
  const onSessionCreatedRef  = useRef(onSessionCreated)
  const onCostChangeRef      = useRef(onCostChange)
  // Tracks which session the active Claude process belongs to.
  // null = idle, 'pending' = new conversation (session ID not yet assigned), '<id>' = known session
  const streamingForSessionRef = useRef<string | null>('pending'.slice(0, 0) || null)
  useEffect(() => { onSessionCreatedRef.current = onSessionCreated }, [onSessionCreated])
  useEffect(() => { onCostChangeRef.current = onCostChange }, [onCostChange])

  // Auto-scroll to bottom whenever feed or messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [state.messages, state.streamingContent, state.thinkingEntries])

  // Inject messages from right panel (plugin installs, etc.)
  useEffect(() => {
    const handler = (e: Event): void => {
      const { text } = (e as CustomEvent).detail
      if (text && handleSendRef.current) handleSendRef.current(text, [])
    }
    window.addEventListener('scc:inject-message', handler)
    return () => window.removeEventListener('scc:inject-message', handler)
  }, [])

  // ---- Stream event listeners (stable, no deps) ----
  useEffect(() => {
    const handleStream = (...args: unknown[]): void => {
      const raw = args[0] as { data: string; sessionId: string | null } | string
      const rawData = typeof raw === 'string' ? raw : raw.data
      const eventSessionId = typeof raw === 'string' ? null : raw.sessionId

      // Filter out events from a different conversation's stream.
      // Allow if: we're in pending state (new chat), IDs match, or event has no ID (legacy).
      const streamSess = streamingForSessionRef.current
      if (
        eventSessionId !== null &&
        streamSess !== null &&
        streamSess !== 'pending' &&
        eventSessionId !== streamSess
      ) return

      try {
        const parsed = typeof rawData === 'string' ? JSON.parse(rawData) : rawData

        // system/init: Claude Code announces the session_id at the start of every run
        if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
          streamingForSessionRef.current = parsed.session_id  // lock in this stream's session
          onSessionCreatedRef.current?.(parsed.session_id)
          return
        }

        // assistant event: snapshot of full assistant message content so far
        if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
          const content = parsed.message.content as Array<{
            type: string; thinking?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>
          }>

          // ---- Thinking block ----
          const thinkingBlock = content.find((b) => b.type === 'thinking')
          if (thinkingBlock?.thinking !== undefined) {
            const thinkingText = thinkingBlock.thinking
            setState((prev) => {
              const hasActiveThinking = prev.thinkingEntries.some((e) => e.isActive && e.type === 'thinking')
              if (thinkingClosedRef.current || !hasActiveThinking) {
                // New thinking turn — lock any accumulated text, start fresh entry
                if (thinkingClosedRef.current && prev.streamingContent) {
                  lockedTextPrefixRef.current = lockedTextPrefixRef.current
                    ? lockedTextPrefixRef.current + '\n\n' + prev.streamingContent
                    : prev.streamingContent
                }
                thinkingClosedRef.current = false
                thinkingStartRef.current = Date.now()
                const newEntry: ThinkingEntry = { id: crypto.randomUUID(), type: 'thinking', text: thinkingText, isActive: true, elapsedSec: 0 }
                return { ...prev, thinkingEntries: [newEntry, ...prev.thinkingEntries], streamingContent: '' }
              }
              // Same turn — update active thinking entry with latest snapshot
              return {
                ...prev,
                thinkingEntries: prev.thinkingEntries.map((e) =>
                  (e.isActive && e.type === 'thinking') ? { ...e, text: thinkingText } : e
                ),
              }
            })
          }

          // ---- Tool use blocks — add each new one to the live feed ----
          const toolUseBlocks = content.filter((b) => b.type === 'tool_use')
          for (const toolBlock of toolUseBlocks) {
            const toolId = toolBlock.id || `tool-${toolBlock.name}`
            if (!processedToolIdsRef.current.has(toolId)) {
              processedToolIdsRef.current.add(toolId)
              const elapsed = Math.floor((Date.now() - thinkingStartRef.current) / 1000)
              const toolEntry: ThinkingEntry = {
                id: toolId,
                type: 'tool_call',
                text: summarizeToolCall(toolBlock),
                isActive: false,
                elapsedSec: elapsed,
              }
              setState((prev) => ({
                ...prev,
                // Close any active thinking entry and prepend the tool call
                thinkingEntries: [
                  toolEntry,
                  ...prev.thinkingEntries.map((e) =>
                    e.isActive ? { ...e, isActive: false, elapsedSec: elapsed } : e
                  ),
                ],
              }))
              thinkingClosedRef.current = true
            }
          }

          // ---- Text block — show immediately (no typing delay) ----
          const textBlock = content.find((b) => b.type === 'text')
          if (textBlock?.text !== undefined) {
            const elapsed = Math.floor((Date.now() - thinkingStartRef.current) / 1000)
            thinkingClosedRef.current = true
            setState((prev) => ({
              ...prev,
              thinkingEntries: prev.thinkingEntries.map((e) =>
                e.isActive ? { ...e, isActive: false, elapsedSec: elapsed } : e
              ),
              streamingContent: textBlock.text ?? prev.streamingContent,
            }))
          }
          return
        }

        // Fallback: direct content block events (some Claude Code versions)
        if (parsed.type === 'thinking') {
          setState((prev) => {
            const hasActive = prev.thinkingEntries.some((e) => e.isActive && e.type === 'thinking')
            if (thinkingClosedRef.current || !hasActive) {
              if (thinkingClosedRef.current && prev.streamingContent) {
                lockedTextPrefixRef.current = lockedTextPrefixRef.current
                  ? lockedTextPrefixRef.current + '\n\n' + prev.streamingContent
                  : prev.streamingContent
              }
              thinkingClosedRef.current = false
              thinkingStartRef.current = Date.now()
              const newEntry: ThinkingEntry = { id: crypto.randomUUID(), type: 'thinking', text: parsed.thinking ?? '', isActive: true, elapsedSec: 0 }
              return { ...prev, thinkingEntries: [newEntry, ...prev.thinkingEntries], streamingContent: '' }
            }
            return {
              ...prev,
              thinkingEntries: prev.thinkingEntries.map((e) =>
                (e.isActive && e.type === 'thinking') ? { ...e, text: e.text + (parsed.thinking ?? '') } : e
              ),
            }
          })
          return
        }

        if (parsed.type === 'text') {
          const elapsed = Math.floor((Date.now() - thinkingStartRef.current) / 1000)
          thinkingClosedRef.current = true
          setState((prev) => ({
            ...prev,
            thinkingEntries: prev.thinkingEntries.map((e) =>
              e.isActive ? { ...e, isActive: false, elapsedSec: elapsed } : e
            ),
            streamingContent: prev.streamingContent + (parsed.text ?? ''),
          }))
          return
        }
      } catch {
        // Non-JSON chunk — append as raw text
        setState((prev) => ({ ...prev, streamingContent: prev.streamingContent + String(data) }))
      }
    }

    const handleDone = (...args: unknown[]): void => {
      isStreamingRef.current = false
      streamingForSessionRef.current = null  // stream finished, idle
      const payload = args[0] as { costUsd?: number | null } | undefined
      const costUsd = payload?.costUsd ?? undefined

      setState((prev) => {
        const prefix = lockedTextPrefixRef.current
        const finalText = prefix
          ? prefix + (prev.streamingContent ? '\n\n' + prev.streamingContent : '')
          : prev.streamingContent

        const contentBlocks: MessageContent[] = []

        // Build a collapsed thought_group from all entries (oldest-first, newest is index 0)
        const orderedEntries = [...prev.thinkingEntries].reverse()
        if (orderedEntries.length > 0) {
          contentBlocks.push({
            type: 'thought_group',
            items: orderedEntries.map((e) => {
              if (e.type === 'thinking') {
                return { kind: 'thought' as const, text: e.text, elapsedSec: e.elapsedSec }
              }
              // tool_call: text is "ToolName: detail" — split for separate fields
              const colonIdx = e.text.indexOf(': ')
              const toolName = colonIdx >= 0 ? e.text.slice(0, colonIdx) : e.text
              const detail = colonIdx >= 0 ? e.text.slice(colonIdx + 2) : ''
              return { kind: 'tool' as const, text: detail, toolName, elapsedSec: e.elapsedSec }
            }),
          })
        }

        if (finalText) contentBlocks.push({ type: 'text', text: finalText })

        const msgs = [...prev.messages]
        const lastMsg = msgs[msgs.length - 1]
        if (lastMsg && lastMsg.role === 'assistant' && contentBlocks.length > 0) {
          msgs[msgs.length - 1] = { ...lastMsg, content: [...contentBlocks, ...lastMsg.content], costUsd }
        } else if (contentBlocks.length > 0) {
          msgs.push({ id: crypto.randomUUID(), role: 'assistant', content: contentBlocks, timestamp: Date.now(), costUsd })
        }

        lockedTextPrefixRef.current = ''
        thinkingClosedRef.current = false

        // Report running total to parent
        const total = msgs.reduce((sum, m) => sum + (m.costUsd ?? 0), 0)
        if (total > 0) setTimeout(() => onCostChangeRef.current?.(total), 0)

        return { ...prev, messages: msgs, isStreaming: false, thinkingEntries: [], streamingContent: '', queueSize: pendingQueueRef.current.length }
      })

      const next = pendingQueueRef.current.shift()
      if (next && processMessageRef.current) {
        setTimeout(() => processMessageRef.current!(next.text, next.attachments), 0)
      }
    }

    const handleError = (...args: unknown[]): void => {
      const err = String(args[0])
      isStreamingRef.current = false
      streamingForSessionRef.current = null  // stream errored, idle
      lockedTextPrefixRef.current = ''
      thinkingClosedRef.current = false
      pendingQueueRef.current = []
      setState((prev) => ({
        ...prev,
        isStreaming: false,
        thinkingEntries: [],
        streamingContent: '',
        queueSize: 0,
        messages: [...prev.messages, { id: crypto.randomUUID(), role: 'system', content: [{ type: 'text', text: `Error: ${err}` }], timestamp: Date.now() }],
      }))
    }

    const handleSquadOutput = (...args: unknown[]): void => {
      const data = args[0]
      try {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data
        setState((prev) => {
          const msgs = [...prev.messages]
          const lastMsg = msgs[msgs.length - 1]
          const squadBlock = { type: 'squad_run' as const, squad: parsed.squad || 'unknown', output: parsed.output || '', done: false }
          if (lastMsg && lastMsg.role === 'assistant') {
            const existingIdx = lastMsg.content.findIndex(
              (b) => b.type === 'squad_run' && (b as { squad: string }).squad === squadBlock.squad
            )
            if (existingIdx >= 0) {
              const existing = lastMsg.content[existingIdx] as typeof squadBlock
              const updatedContent = [...lastMsg.content]
              updatedContent[existingIdx] = { ...existing, output: existing.output + squadBlock.output }
              msgs[msgs.length - 1] = { ...lastMsg, content: updatedContent }
            } else {
              msgs[msgs.length - 1] = { ...lastMsg, content: [...lastMsg.content, squadBlock] }
            }
          } else {
            msgs.push({ id: crypto.randomUUID(), role: 'assistant', content: [squadBlock], timestamp: Date.now() })
          }
          return { ...prev, messages: msgs }
        })
      } catch { /* ignore */ }
    }

    const handleSquadDone = (): void => {
      isStreamingRef.current = false
      setState((prev) => {
        const msgs = [...prev.messages]
        const lastMsg = msgs[msgs.length - 1]
        if (lastMsg && lastMsg.role === 'assistant') {
          msgs[msgs.length - 1] = { ...lastMsg, content: lastMsg.content.map((b) => b.type === 'squad_run' ? { ...b, done: true } : b) }
        }
        return { ...prev, messages: msgs, isStreaming: false }
      })
    }

    // File-based HITL: OPAI orchestrator drops files into reports/HITL/ → watcher fires hitl:new
    const handleHitlNew = (...args: unknown[]): void => {
      const data = args[0] as { filename: string; path: string }
      // Read the file content then surface a HITL card in chat
      window.scc.readHITL(data.filename).then((result) => {
        const hitlBlock: MessageContent = {
          type: 'hitl',
          action: `Review: ${data.filename}`,
          path: data.path,
          content: result.content || undefined,
          filename: data.filename,
        }
        setState((prev) => ({
          ...prev,
          messages: [
            ...prev.messages,
            { id: crypto.randomUUID(), role: 'assistant', content: [hitlBlock], timestamp: Date.now() },
          ],
        }))
      }).catch(() => {
        // Show card without content if read fails
        const hitlBlock: MessageContent = {
          type: 'hitl',
          action: `Review: ${data.filename}`,
          path: data.path,
          filename: data.filename,
        }
        setState((prev) => ({
          ...prev,
          messages: [
            ...prev.messages,
            { id: crypto.randomUUID(), role: 'assistant', content: [hitlBlock], timestamp: Date.now() },
          ],
        }))
      })
    }

    const handlePermissionRequest = (...args: unknown[]): void => {
      const perm = args[0] as { requestId: string; toolUseId?: string; toolName: string; content: string }
      const hitlBlock: MessageContent = {
        type: 'hitl',
        action: perm.content || `Allow: ${perm.toolName}`,
        requestId: perm.requestId,
        toolName: perm.toolName,
      }
      setState((prev) => {
        const msgs = [...prev.messages]
        // Attach to last assistant message if one is open, otherwise append as new message
        const lastMsg = msgs[msgs.length - 1]
        if (lastMsg && lastMsg.role === 'assistant') {
          msgs[msgs.length - 1] = { ...lastMsg, content: [...lastMsg.content, hitlBlock] }
        } else {
          msgs.push({ id: crypto.randomUUID(), role: 'assistant', content: [hitlBlock], timestamp: Date.now() })
        }
        return { ...prev, messages: msgs }
      })
    }

    window.scc.on('claude:stream', handleStream)
    window.scc.on('claude:done', handleDone)
    window.scc.on('claude:error', handleError)
    window.scc.on('claude:permission-request', handlePermissionRequest)
    window.scc.on('hitl:new', handleHitlNew)
    window.scc.on('squad:output', handleSquadOutput)
    window.scc.on('squad:done', handleSquadDone)
    return () => {
      window.scc.off('claude:stream', handleStream)
      window.scc.off('claude:done', handleDone)
      window.scc.off('claude:error', handleError)
      window.scc.off('claude:permission-request', handlePermissionRequest)
      window.scc.off('hitl:new', handleHitlNew)
      window.scc.off('squad:output', handleSquadOutput)
      window.scc.off('squad:done', handleSquadDone)
    }
  }, [])

  // ---- Core send logic ----
  const processMessage = useCallback(
    async (text: string, attachments: Attachment[]) => {
      const userContent: MessageContent[] = []
      // Add image blocks first so they appear above the text
      for (const att of attachments) {
        if (att.type === 'image') {
          userContent.push({ type: 'image', dataUrl: att.content, name: att.name })
        }
      }
      if (text) userContent.push({ type: 'text', text })

      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: userContent,
        timestamp: Date.now(),
      }

      isStreamingRef.current = true
      streamingForSessionRef.current = sessionId || 'pending'  // will be updated by system/init
      lockedTextPrefixRef.current = ''
      thinkingClosedRef.current = false
      processedToolIdsRef.current = new Set()

      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage],
        isStreaming: true,
        thinkingEntries: [],
        streamingContent: '',
        queueSize: pendingQueueRef.current.length,
      }))

      // Collect image attachments as base64 for direct vision input via stream-json
      const imageInputs: Array<{ base64: string; mimeType: string; name: string }> = []
      for (const att of attachments) {
        if (att.type === 'image') {
          // att.content is "data:image/png;base64,..." — strip the prefix
          const base64 = att.content.includes(',') ? att.content.split(',')[1] : att.content
          imageInputs.push({ base64, mimeType: att.mimeType || 'image/png', name: att.name })
        }
      }

      const prompt = buildPrompt(text, attachments)
      try {
        await window.scc.spawn({
          cwd: cwdProp || DEFAULT_CWD,
          prompt,
          sessionId: sessionId || undefined,
          model: modelProp || DEFAULT_MODEL,
          images: imageInputs.length > 0 ? imageInputs : undefined,
        } as any)
      } catch (err) {
        isStreamingRef.current = false
        setState((prev) => ({
          ...prev,
          isStreaming: false,
          messages: [
            ...prev.messages,
            { id: crypto.randomUUID(), role: 'system', content: [{ type: 'text', text: `Failed to spawn Claude: ${err}` }], timestamp: Date.now() },
          ],
        }))
      }
    },
    [sessionId, cwdProp, modelProp]
  )

  processMessageRef.current = processMessage

  // ---- Session change: load history when user picks a past conversation ----
  // Key insight: when prev===null → new session just got assigned an ID mid-conversation
  //              → DON'T reset, messages are already in state.
  //              When prev===undefined → app just mounted with a sessionId → load it.
  //              When prev is a different non-null ID → user switched sessions → load it.
  useEffect(() => {
    const prev = prevSessionIdRef.current
    prevSessionIdRef.current = sessionId ?? null

    if (!sessionId) {
      // User clicked "New Chat" (and this isn't the initial mount)
      if (prev !== undefined) {
        setState({ messages: [], isStreaming: false, thinkingEntries: [], streamingContent: '', queueSize: 0 })
        lockedTextPrefixRef.current = ''
        thinkingClosedRef.current = false
        pendingQueueRef.current = []
        isStreamingRef.current = false
        onCostChangeRef.current?.(0)
      }
      return
    }

    if (prev === null && isStreamingRef.current) {
      // A new conversation just received its session ID mid-stream — keep current messages, don't reload
      return
    }

    // Either initial mount with a sessionId, or user clicked a different session
    window.scc.loadMessages(sessionId).then((result) => {
      if (result.ok && result.messages.length > 0) {
        // Conversion to thought_group format is done in db:load-messages (main process).
        // Messages arrive already in the correct format — just map types.
        const loaded = result.messages.map((m) => ({
          id: m.id,
          role: m.role as 'user' | 'assistant',
          content: m.content as import('../../types').MessageContent[],
          timestamp: m.timestamp,
          costUsd: m.costUsd,
        }))
        setState((prev) => ({
          ...prev,
          messages: loaded,
          isStreaming: false,
          thinkingEntries: [],
          streamingContent: '',
        }))
        // Report total cost of loaded conversation
        const total = loaded.reduce((sum, m) => sum + (m.costUsd ?? 0), 0)
        if (total > 0) onCostChangeRef.current?.(total)
      } else {
        onCostChangeRef.current?.(0)
      }
    }).catch(() => { /* silent */ })
  }, [sessionId])

  // ---- handleSend: queue if streaming ----
  const handleSend = useCallback(
    (text: string, attachments: Attachment[]) => {
      if (isStreamingRef.current) {
        pendingQueueRef.current.push({ text, attachments })
        setState((prev) => ({ ...prev, queueSize: pendingQueueRef.current.length }))
        return
      }
      processMessage(text, attachments)
    },
    [processMessage]
  )

  handleSendRef.current = handleSend

  // ---- Render ----
  const hasMessages = state.messages.length > 0 || state.isStreaming

  // Text shown in streaming ghost: locked prefix (from prior turns) + current turn (immediate)
  const lockedPrefix = lockedTextPrefixRef.current
  const fullStreamingText = lockedPrefix
    ? lockedPrefix + (state.streamingContent ? '\n\n' + state.streamingContent : '')
    : state.streamingContent

  const hasThinking = state.thinkingEntries.length > 0
  const hasText = !!fullStreamingText

  return (
    <div className="flex flex-col flex-1 min-h-0" style={{ backgroundColor: '#0d0d1a' }}>
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-4 py-4 scroll-smooth">
        {!hasMessages ? (
          <div className="flex flex-col items-center justify-center h-full select-none">
            <h1 className="text-5xl font-bold text-violet-500 mb-2">SCC IDE</h1>
            <p className="text-zinc-500 text-lg mb-1">Squad Claude Code</p>
            <p className="text-zinc-600 text-sm mt-4">Start a conversation or run a squad to begin.</p>
          </div>
        ) : (
          <>
            {state.messages.map((msg) => {
              // Assistant messages: render thought_group blocks as standalone separator bars,
              // then Claude's actual text response separately beneath them.
              if (msg.role === 'assistant') {
                const tgBlocks = msg.content.filter(
                  (b): b is Extract<MessageContent, { type: 'thought_group' }> => b.type === 'thought_group'
                )
                const responseBlocks = msg.content.filter((b) => b.type !== 'thought_group')
                return (
                  <React.Fragment key={msg.id}>
                    {tgBlocks.map((block, i) => (
                      <ThoughtGroup key={`${msg.id}-tg-${i}`} items={block.items} />
                    ))}
                    {responseBlocks.length > 0 && (
                      <MessageBubble message={{ ...msg, content: responseBlocks }} />
                    )}
                  </React.Fragment>
                )
              }
              return <MessageBubble key={msg.id} message={msg} />
            })}

            {/* Live streaming area */}
            {state.isStreaming && (
              <div className="w-full px-1 py-1 mb-3">

                {/* Rolling feed: newest at top — thinking + tool calls */}
                {hasThinking && (
                  <div className="flex flex-col gap-0.5">
                    {state.thinkingEntries.map((entry) => (
                      <ThinkingBlock
                        key={entry.id}
                        type={entry.type}
                        thinking={entry.text}
                        isStreaming={entry.isActive}
                        finalElapsedSec={entry.isActive ? undefined : entry.elapsedSec}
                      />
                    ))}
                  </div>
                )}

                {/* Response text — shown immediately, no typing delay */}
                {hasText ? (
                  <div className="prose prose-invert prose-sm max-w-none mt-2">
                    <p className="text-zinc-100 text-sm leading-relaxed whitespace-pre-wrap">
                      {fullStreamingText}
                      <span className="inline-block w-[2px] h-[14px] ml-0.5 bg-violet-400 align-middle animate-pulse" />
                    </p>
                  </div>
                ) : !hasThinking ? (
                  <div className="flex items-center gap-2 px-1 py-2 text-zinc-500 text-sm">
                    <span className="flex gap-1">
                      <span className="w-1.5 h-1.5 bg-violet-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-1.5 h-1.5 bg-violet-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-1.5 h-1.5 bg-violet-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </span>
                    Waiting for Claude...
                  </div>
                ) : null}
              </div>
            )}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      <InputArea onSend={handleSend} disabled={state.isStreaming} queueSize={state.queueSize} />
    </div>
  )
}
