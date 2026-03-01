import React from 'react'
import { Play, CheckCircle2, ExternalLink } from 'lucide-react'

interface SquadRunCardProps {
  squad: string
  output: string
  done: boolean
}

export default function SquadRunCard({ squad, output, done }: SquadRunCardProps): React.ReactElement {
  const handleViewReports = (): void => {
    window.scc.openExternal('/workspace/synced/opai/reports/latest')
  }

  return (
    <div className="border-l-2 border-violet-600 rounded-r my-2" style={{ backgroundColor: '#0f0a1a' }}>
      <div className="flex items-center gap-2 px-3 py-2">
        {done ? (
          <CheckCircle2 size={14} className="text-green-400" />
        ) : (
          <Play size={14} className="text-violet-400" />
        )}
        <span className="text-zinc-200 text-sm font-medium">
          Squad: {squad}
        </span>
        <span
          className={`text-xs px-1.5 py-0.5 rounded-full ${
            done
              ? 'bg-green-900/40 text-green-400'
              : 'bg-violet-900/40 text-violet-300'
          }`}
        >
          {done ? 'Done' : 'Running'}
        </span>
      </div>

      {output && (
        <div className="mx-3 mb-2 px-3 py-2 rounded bg-black/50 max-h-48 overflow-y-auto">
          <pre className="text-xs font-mono text-green-400 whitespace-pre-wrap">{output}</pre>
        </div>
      )}

      {done && (
        <button
          onClick={handleViewReports}
          className="flex items-center gap-1 mx-3 mb-2 text-xs text-violet-400 hover:text-violet-300 transition-colors"
        >
          View Reports <ExternalLink size={12} />
        </button>
      )}
    </div>
  )
}
