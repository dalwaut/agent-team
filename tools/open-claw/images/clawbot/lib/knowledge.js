/**
 * Knowledge Base Search — Searches the read-only /app/knowledge/ volume.
 *
 * The knowledge directory is populated by the broker at provisioning time
 * with client-specific documents, SOPs, FAQs, and reference material.
 *
 * Supports: .txt, .md, .json files
 * Search: Simple keyword matching with relevance scoring.
 *
 * Usage:
 *   const kb = require('./lib/knowledge');
 *   kb.index();  // Build search index from knowledge files
 *   const results = kb.search('shipping policy');
 */

const fs = require('fs');
const path = require('path');

const KNOWLEDGE_DIR = '/app/knowledge';

// In-memory search index: [{file, title, content, words}]
let _index = [];
let _indexed = false;

// ── Indexing ────────────────────────────────────────────────

/**
 * Build the search index from all files in the knowledge directory.
 * Call this on startup and after any knowledge updates.
 */
function index() {
    _index = [];

    if (!fs.existsSync(KNOWLEDGE_DIR)) {
        _indexed = true;
        return;
    }

    const files = _listFiles(KNOWLEDGE_DIR);
    for (const file of files) {
        try {
            const content = fs.readFileSync(file, 'utf8');
            const relative = path.relative(KNOWLEDGE_DIR, file);
            const title = _extractTitle(relative, content);
            const words = _tokenize(content);

            _index.push({
                file: relative,
                title,
                content,
                words,
                size: content.length,
            });
        } catch {
            // Skip unreadable files
        }
    }

    _indexed = true;
}

function _listFiles(dir) {
    const results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(..._listFiles(full));
        } else if (/\.(txt|md|json|csv)$/i.test(entry.name)) {
            results.push(full);
        }
    }
    return results;
}

function _extractTitle(filename, content) {
    // Try to extract a markdown heading
    const match = content.match(/^#\s+(.+)/m);
    if (match) return match[1].trim();
    // Fall back to filename without extension
    return path.basename(filename, path.extname(filename)).replace(/[-_]/g, ' ');
}

function _tokenize(text) {
    return text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2);
}

// ── Search ──────────────────────────────────────────────────

/**
 * Search the knowledge base for relevant documents.
 * @param {string} query - Search query
 * @param {number} [limit=5] - Maximum results to return
 * @returns {Array<{file: string, title: string, score: number, snippet: string}>}
 */
function search(query, limit = 5) {
    if (!_indexed) index();

    const queryWords = _tokenize(query);
    if (queryWords.length === 0) return [];

    const scored = _index.map(doc => {
        let score = 0;

        // Word frequency scoring
        for (const qw of queryWords) {
            // Exact word matches in content
            const wordCount = doc.words.filter(w => w === qw).length;
            score += wordCount * 2;

            // Partial matches (contains)
            const partialCount = doc.words.filter(w => w.includes(qw)).length;
            score += partialCount * 0.5;

            // Title boost
            if (doc.title.toLowerCase().includes(qw)) {
                score += 10;
            }

            // Filename boost
            if (doc.file.toLowerCase().includes(qw)) {
                score += 5;
            }
        }

        // Normalize by document length (prefer concise, relevant docs)
        if (doc.words.length > 0) {
            score = score / Math.sqrt(doc.words.length);
        }

        return { ...doc, score };
    });

    // Filter, sort, and limit
    return scored
        .filter(d => d.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(d => ({
            file: d.file,
            title: d.title,
            score: Math.round(d.score * 100) / 100,
            snippet: _getSnippet(d.content, queryWords),
            size: d.size,
        }));
}

/**
 * Get the full content of a knowledge file.
 * @param {string} filename - Relative path within the knowledge directory
 * @returns {string|null}
 */
function getFile(filename) {
    const filepath = path.join(KNOWLEDGE_DIR, filename);
    if (!filepath.startsWith(KNOWLEDGE_DIR)) return null;  // Path traversal guard
    try {
        return fs.readFileSync(filepath, 'utf8');
    } catch {
        return null;
    }
}

function _getSnippet(content, queryWords, maxLength = 200) {
    // Find the best matching region
    const lines = content.split('\n');
    let bestLine = '';
    let bestScore = 0;

    for (const line of lines) {
        const lower = line.toLowerCase();
        let score = 0;
        for (const qw of queryWords) {
            if (lower.includes(qw)) score++;
        }
        if (score > bestScore) {
            bestScore = score;
            bestLine = line;
        }
    }

    if (bestLine.length > maxLength) {
        return bestLine.substring(0, maxLength) + '...';
    }
    return bestLine || content.substring(0, maxLength) + '...';
}

// ── List & Stats ────────────────────────────────────────────

/**
 * List all indexed knowledge files.
 */
function listFiles() {
    if (!_indexed) index();
    return _index.map(d => ({
        file: d.file,
        title: d.title,
        size: d.size,
        words: d.words.length,
    }));
}

/**
 * Get knowledge base stats.
 */
function getStats() {
    if (!_indexed) index();
    return {
        files: _index.length,
        total_words: _index.reduce((sum, d) => sum + d.words.length, 0),
        total_bytes: _index.reduce((sum, d) => sum + d.size, 0),
    };
}

module.exports = { index, search, getFile, listFiles, getStats };
