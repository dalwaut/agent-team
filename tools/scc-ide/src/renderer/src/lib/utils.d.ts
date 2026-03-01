import { type ClassValue } from 'clsx';
/**
 * Merge class names with clsx + tailwind-merge.
 * Handles conditional classes and deduplicates Tailwind utilities.
 */
export declare function cn(...inputs: ClassValue[]): string;
/**
 * Format a unix-ms timestamp as a human-readable relative time string.
 * Examples: "just now", "2 minutes ago", "Yesterday", "3 days ago", "Feb 14"
 */
export declare function formatRelativeTime(ms: number): string;
/**
 * Truncate a string to maxLen characters, appending an ellipsis if truncated.
 */
export declare function truncate(str: string, maxLen: number): string;
/**
 * Parse a single JSON line from Claude's stream-json output.
 * Returns the parsed object or null on parse error.
 */
export declare function parseStreamLine(line: string): Record<string, unknown> | null;
/**
 * Extract a conversation title from JSONL content.
 * Finds the first user message and returns its text, truncated.
 */
export declare function extractTitle(jsonlContent: string): string;
/**
 * Base64-encode a file path.
 * Used for matching Claude session directories which are base64-encoded paths.
 */
export declare function encodePathToBase64(path: string): string;
