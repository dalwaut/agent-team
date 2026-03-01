import React, { useState, useRef, useCallback } from 'react'
import { Paperclip, Image, Send, Loader2, X } from 'lucide-react'
import type { Attachment } from '../../types'

// Re-export for convenience
export type { Attachment }

interface InputAreaProps {
  onSend: (text: string, attachments: Attachment[]) => void
  disabled?: boolean
  queueSize?: number
}

const TEXT_EXTENSIONS = [
  '.md', '.txt', '.json', '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go',
  '.java', '.c', '.cpp', '.h', '.hpp', '.css', '.scss', '.html', '.xml',
  '.yaml', '.yml', '.toml', '.sh', '.bash', '.zsh', '.fish', '.sql',
  '.graphql', '.vue', '.svelte', '.astro', '.env', '.gitignore', '.csv',
]

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp']

function classifyFile(name: string, mime: string): Attachment['type'] {
  const lower = name.toLowerCase()
  if (IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext)) || mime.startsWith('image/')) {
    return 'image'
  }
  if (lower.endsWith('.pdf') || mime === 'application/pdf') {
    return 'pdf'
  }
  if (TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext)) || mime.startsWith('text/')) {
    return 'text'
  }
  return 'other'
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsText(file)
  })
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

async function processFile(file: File): Promise<Attachment> {
  const fileType = classifyFile(file.name, file.type)
  let content: string

  if (fileType === 'text') {
    content = await readFileAsText(file)
  } else {
    content = await readFileAsDataURL(file)
  }

  return {
    id: crypto.randomUUID(),
    name: file.name,
    type: fileType,
    content,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
  }
}

export default function InputArea({ onSend, disabled, queueSize = 0 }: InputAreaProps): React.ReactElement {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const lineHeight = 24
    const maxRows = 8
    const maxH = lineHeight * maxRows
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`
  }, [])

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed && attachments.length === 0) return
    onSend(trimmed, attachments)
    setText('')
    setAttachments([])
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [text, attachments, onSend])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  const handleFilesSelected = useCallback(async (files: FileList | null) => {
    if (!files) return
    const processed = await Promise.all(Array.from(files).map(processFile))
    setAttachments((prev) => [...prev, ...processed])
  }, [])

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return

      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const file = item.getAsFile()
          if (file) {
            const att = await processFile(file)
            setAttachments((prev) => [...prev, att])
          }
          return
        }
      }
    },
    []
  )

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  return (
    <div className="border-t border-zinc-800 bg-zinc-900 px-4 py-3">
      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((att) => (
            <div
              key={att.id}
              className="flex items-center gap-1.5 bg-zinc-800 rounded px-2 py-1 text-xs text-zinc-300"
            >
              {att.type === 'image' ? (
                <img
                  src={att.content}
                  alt={att.name}
                  className="w-10 h-10 object-cover rounded"
                />
              ) : (
                <span className="text-zinc-400">
                  {att.type === 'pdf' ? '(PDF)' : ''}
                </span>
              )}
              <span className="max-w-[120px] truncate">{att.name}</span>
              <span className="text-zinc-500">{formatSize(att.size)}</span>
              <button
                onClick={() => removeAttachment(att.id)}
                className="text-zinc-500 hover:text-zinc-300 ml-0.5"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end gap-2">
        {/* Attach file */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="text-zinc-500 hover:text-zinc-300 p-1.5 transition-colors"
          title="Attach file"
        >
          <Paperclip size={18} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => handleFilesSelected(e.target.files)}
        />

        {/* Attach image */}
        <button
          onClick={() => imageInputRef.current?.click()}
          className="text-zinc-500 hover:text-zinc-300 p-1.5 transition-colors"
          title="Attach image"
        >
          <Image size={18} />
        </button>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => handleFilesSelected(e.target.files)}
        />

        {/* Textarea — always enabled so user can type/queue during streaming */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            adjustHeight()
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={disabled ? 'Claude is thinking… type to queue next message' : 'Message Claude... (Enter to send, Shift+Enter for new line)'}
          rows={1}
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 resize-none focus:outline-none focus:border-violet-600 transition-colors"
          style={{ minHeight: '40px', maxHeight: '192px' }}
        />

        {/* Send — always clickable; shows queue count when buffering */}
        <div className="relative flex-shrink-0">
          <button
            onClick={handleSend}
            disabled={!text.trim() && attachments.length === 0}
            className="p-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition-colors"
            title={disabled ? 'Add to queue' : 'Send message'}
          >
            {disabled ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
          </button>
          {queueSize > 0 && (
            <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-violet-500 text-[9px] font-bold text-white leading-none">
              {queueSize}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
