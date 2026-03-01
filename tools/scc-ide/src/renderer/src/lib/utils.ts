// SCC IDE — Utility functions

import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge class names with clsx + tailwind-merge.
 * Handles conditional classes and deduplicates Tailwind utilities.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * Format a unix-ms timestamp as a human-readable relative time string.
 * Examples: "just now", "2 minutes ago", "Yesterday", "3 days ago", "Feb 14"
 */
export function formatRelativeTime(ms: number): string {
  const now = Date.now()
  const diff = now - ms

  if (diff < 0) return 'just now'

  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return 'just now'
  if (minutes === 1) return '1 minute ago'
  if (minutes < 60) return `${minutes} minutes ago`
  if (hours === 1) return '1 hour ago'
  if (hours < 24) return `${hours} hours ago`
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`

  // Older than a week: show short date
  const date = new Date(ms)
  const monthNames = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ]
  return `${monthNames[date.getMonth()]} ${date.getDate()}`
}

/**
 * Truncate a string to maxLen characters, appending an ellipsis if truncated.
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 1) + '\u2026'
}

/**
 * Parse a single JSON line from Claude's stream-json output.
 * Returns the parsed object or null on parse error.
 */
export function parseStreamLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Extract a conversation title from JSONL content.
 * Finds the first user message and returns its text, truncated.
 */
export function extractTitle(jsonlContent: string): string {
  const lines = jsonlContent.split('\n')
  for (const line of lines) {
    const parsed = parseStreamLine(line)
    if (!parsed) continue

    // Look for user role messages
    if (parsed.role === 'user' || parsed.type === 'human') {
      // Content can be a string or array of blocks
      if (typeof parsed.content === 'string') {
        return truncate(parsed.content, 80)
      }
      if (Array.isArray(parsed.content)) {
        for (const block of parsed.content) {
          if (
            block &&
            typeof block === 'object' &&
            'type' in block &&
            block.type === 'text' &&
            'text' in block &&
            typeof block.text === 'string'
          ) {
            return truncate(block.text, 80)
          }
        }
      }
    }
  }
  return 'Untitled conversation'
}

/**
 * Base64-encode a file path.
 * Used for matching Claude session directories which are base64-encoded paths.
 */
export function encodePathToBase64(path: string): string {
  // In browser context, use btoa; handle unicode with TextEncoder
  const bytes = new TextEncoder().encode(path)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}
