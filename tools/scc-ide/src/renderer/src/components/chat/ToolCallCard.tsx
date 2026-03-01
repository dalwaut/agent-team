import React, { useState } from 'react'
import { ChevronRight, Wrench } from 'lucide-react'

interface ToolCallCardProps {
  toolName: string
  input: Record<string, unknown>
  isResult?: boolean
  result?: string
  isError?: boolean
}

export default function ToolCallCard({
  toolName,
  input,
  isResult,
  result,
  isError,
}: ToolCallCardProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false)

  const borderColor = isError ? 'border-red-500' : 'border-blue-500'
  const textColor = isError ? 'text-red-400' : 'text-blue-400'

  const content = isResult ? result : JSON.stringify(input, null, 2)

  return (
    <div
      className={`border-l-2 ${borderColor} rounded-r my-1`}
      style={{ backgroundColor: '#0f172a' }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 px-3 py-1.5 w-full text-left text-sm hover:bg-white/5 transition-colors rounded-r"
      >
        <ChevronRight
          size={14}
          className={`text-zinc-500 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />
        <Wrench size={14} className={textColor} />
        <span className={`${textColor} font-medium`}>
          {isResult ? `Result: ${toolName}` : toolName}
        </span>
        {isError && (
          <span className="text-red-500 text-xs ml-2">Error</span>
        )}
      </button>

      {expanded && content && (
        <div className="mx-3 mb-2 px-3 py-2 rounded bg-black/40 overflow-x-auto">
          <pre className="text-xs font-mono text-zinc-300 whitespace-pre-wrap break-words">
            {content}
          </pre>
        </div>
      )}
    </div>
  )
}
