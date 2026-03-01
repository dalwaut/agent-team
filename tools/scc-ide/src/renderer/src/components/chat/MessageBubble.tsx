import React from 'react'
import ReactMarkdown from 'react-markdown'
import type { Message, MessageContent } from '../../types'
import ThinkingBlock from './ThinkingBlock'
import ToolCallCard from './ToolCallCard'
import HitlCard from './HitlCard'
import SquadRunCard from './SquadRunCard'

// Re-export Message for convenience
export type { Message }

interface MessageBubbleProps {
  message: Message
  isStreaming?: boolean
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function MessageBubble({ message, isStreaming }: MessageBubbleProps): React.ReactElement {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  return (
    <div className={`flex w-full mb-3 ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`relative ${
          isUser
            ? 'max-w-[75%] bg-violet-900/40 border border-violet-700/30 rounded-lg px-4 py-2.5'
            : isSystem
              ? 'max-w-[90%] text-zinc-500 italic text-sm px-4 py-1'
              : 'w-full px-1 py-1'
        }`}
      >
        {/* Timestamp */}
        <span className="absolute top-1 right-2 text-zinc-600 text-[10px] select-none">
          {formatTime(message.timestamp)}
        </span>

        {/* Content blocks */}
        <div className={`select-text cursor-text ${isUser ? 'pr-12' : 'pr-0'}`}>
          {message.content.map((block: MessageContent, i: number) => {
            const key = `${message.id}-${i}`

            switch (block.type) {
              case 'image':
                return (
                  <div key={key} className="mb-2">
                    <img
                      src={block.dataUrl}
                      alt={block.name}
                      className="max-w-full max-h-64 rounded-lg object-contain border border-zinc-700/50 cursor-pointer"
                      title={block.name}
                      onClick={() => window.scc.openExternal(block.dataUrl)}
                    />
                    <div className="text-[10px] text-zinc-600 mt-0.5 truncate">{block.name}</div>
                  </div>
                )

              case 'text':
                return (
                  <div key={key} className="prose prose-invert prose-sm max-w-none">
                    <ReactMarkdown
                      components={{
                        code({ className, children, ...props }) {
                          const isInline = !className
                          if (isInline) {
                            return (
                              <code
                                className="bg-zinc-800 px-1 py-0.5 rounded text-sm text-zinc-200"
                                {...props}
                              >
                                {children}
                              </code>
                            )
                          }
                          return (
                            <pre className="bg-zinc-900 rounded p-3 my-2 overflow-x-auto">
                              <code className={`${className || ''} text-sm`} {...props}>
                                {children}
                              </code>
                            </pre>
                          )
                        },
                        p({ children }) {
                          return <p className="text-zinc-100 text-sm leading-relaxed mb-2 last:mb-0">{children}</p>
                        },
                        a({ href, children }) {
                          return (
                            <a
                              href={href}
                              onClick={(e) => {
                                e.preventDefault()
                                if (href) window.scc.openExternal(href)
                              }}
                              className="text-violet-400 hover:text-violet-300 underline"
                            >
                              {children}
                            </a>
                          )
                        },
                      }}
                    >
                      {block.text}
                    </ReactMarkdown>
                  </div>
                )

              case 'thinking':
                return (
                  <ThinkingBlock
                    key={key}
                    thinking={block.thinking}
                    isStreaming={isStreaming}
                  />
                )

              case 'thought_group':
                // Rendered at conversation level in ChatArea — skip here
                return null

              case 'tool_use':
                return (
                  <ToolCallCard
                    key={key}
                    toolName={block.toolName}
                    input={block.input}
                  />
                )

              case 'tool_result':
                return (
                  <ToolCallCard
                    key={key}
                    toolName={block.toolUseId}
                    input={{}}
                    isResult
                    result={block.content}
                    isError={block.isError}
                  />
                )

              case 'hitl':
                return (
                  <HitlCard
                    key={key}
                    action={block.action}
                    path={block.path}
                    content={block.content}
                    requestId={block.requestId}
                    toolName={block.toolName}
                    filename={block.filename}
                    onApprove={() => {
                      if (block.requestId) window.scc.permissionRespond(block.requestId, true)
                      if (block.filename) window.scc.doneHITL(block.filename)
                    }}
                    onDeny={() => {
                      if (block.requestId) window.scc.permissionRespond(block.requestId, false)
                      // File-based HITL: deny = dismiss without moving to done
                    }}
                  />
                )

              case 'squad_run':
                return (
                  <SquadRunCard
                    key={key}
                    squad={block.squad}
                    output={block.output}
                    done={block.done}
                  />
                )

              default:
                return null
            }
          })}
        </div>

        {/* Cost indicator */}
        {message.costUsd != null && message.costUsd > 0 && (
          <div className={`mt-1.5 flex items-center gap-1 ${isUser ? 'justify-end' : 'justify-start'}`}>
            <span className="text-[10px] text-zinc-600 font-mono">
              ${message.costUsd < 0.01 ? message.costUsd.toFixed(4) : message.costUsd.toFixed(3)}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
