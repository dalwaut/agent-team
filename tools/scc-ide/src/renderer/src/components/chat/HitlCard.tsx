import React, { useState } from 'react'
import { ShieldAlert, Check, X, Terminal } from 'lucide-react'

interface HitlCardProps {
  action: string
  path?: string
  content?: string
  requestId?: string
  toolName?: string
  filename?: string
  onApprove: () => void
  onDeny: () => void
}

export default function HitlCard({
  action,
  path,
  content,
  requestId,
  toolName,
  filename,
  onApprove,
  onDeny,
}: HitlCardProps): React.ReactElement {
  const [decided, setDecided] = useState<'approved' | 'denied' | null>(null)

  const preview = content
    ? content.split('\n').slice(0, 6).join('\n') + (content.split('\n').length > 6 ? '\n...' : '')
    : null

  const handleApprove = (): void => {
    if (decided) return
    setDecided('approved')
    onApprove()
  }

  const handleDeny = (): void => {
    if (decided) return
    setDecided('denied')
    onDeny()
  }

  return (
    <div
      className="rounded-lg my-2 overflow-hidden"
      style={{
        backgroundColor: decided === 'approved' ? '#071a10' : decided === 'denied' ? '#1a0707' : '#100a1a',
        border: decided === 'approved'
          ? '1px solid rgba(34,197,94,0.3)'
          : decided === 'denied'
            ? '1px solid rgba(239,68,68,0.3)'
            : '1px solid rgba(168,85,247,0.25)',
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5">
        <ShieldAlert
          size={13}
          className={decided === 'approved' ? 'text-emerald-500' : decided === 'denied' ? 'text-red-500' : 'text-violet-400'}
        />
        <span className={`text-xs font-semibold ${decided === 'approved' ? 'text-emerald-400' : decided === 'denied' ? 'text-red-400' : 'text-violet-300'}`}>
          {decided === 'approved' ? 'Approved' : decided === 'denied' ? 'Denied' : 'Permission Required'}
        </span>
        {(toolName || filename) && !decided && (
          <span className="ml-auto flex items-center gap-1 text-[10px] text-zinc-600 font-mono">
            <Terminal size={9} />
            {toolName || filename}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="px-3 py-2">
        <p className="text-zinc-200 text-sm leading-snug mb-1.5">{action}</p>

        {path && (
          <p className="text-zinc-500 text-[11px] font-mono mb-1.5">{path}</p>
        )}

        {preview && !decided && (
          <pre className="text-[11px] font-mono text-zinc-400 rounded px-2.5 py-2 mt-1 mb-2.5 max-h-36 overflow-y-auto whitespace-pre-wrap"
            style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}>
            {preview}
          </pre>
        )}

        {/* Buttons or outcome */}
        {!decided ? (
          <div className="flex gap-2 mt-2">
            <button
              onClick={handleApprove}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded font-medium bg-emerald-700 hover:bg-emerald-600 text-white transition-colors"
            >
              <Check size={11} />
              Approve
            </button>
            <button
              onClick={handleDeny}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded font-medium bg-red-800 hover:bg-red-700 text-white transition-colors"
            >
              <X size={11} />
              Deny
            </button>
          </div>
        ) : (
          <div className={`flex items-center gap-1.5 text-xs mt-1 ${decided === 'approved' ? 'text-emerald-500' : 'text-red-500'}`}>
            {decided === 'approved' ? <Check size={11} /> : <X size={11} />}
            <span>{decided === 'approved' ? 'Approved — Claude continuing' : 'Denied — Claude stopped'}</span>
          </div>
        )}
      </div>
    </div>
  )
}
