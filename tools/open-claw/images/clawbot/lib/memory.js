/**
 * 3-Layer Memory System — Felix-inspired persistent memory for ClawBot.
 *
 * Layer 1: Knowledge Graph — Entities, relationships, facts about the client
 * Layer 2: Daily Notes    — Chronological log of interactions and events
 * Layer 3: Tacit Knowledge — Learned patterns, preferences, communication style
 *
 * All data stored as JSON in /app/workspace/memory/ (volume-mounted, persists
 * across container restarts).
 *
 * Usage:
 *   const memory = require('./lib/memory');
 *   await memory.init();
 *   memory.addEntity('project', 'Website Redesign', { status: 'active', deadline: '2026-03-15' });
 *   memory.addDailyNote('Client approved the wireframes');
 *   memory.addTacitKnowledge('communication', 'Client prefers bullet points over paragraphs');
 *   const ctx = memory.buildContext('website project status');
 */

const fs = require('fs');
const path = require('path');

const MEMORY_DIR = '/app/workspace/memory';

// ── In-memory state (loaded from disk on init) ─────────────

let knowledgeGraph = { entities: {}, relationships: [] };
let dailyNotes = {};    // { "2026-02-27": [{ts, text, tags}] }
let tacitKnowledge = {};  // { category: [{ts, insight, confidence}] }

let initialized = false;

// ── File I/O ────────────────────────────────────────────────

function _ensureDir() {
    if (!fs.existsSync(MEMORY_DIR)) {
        fs.mkdirSync(MEMORY_DIR, { recursive: true });
    }
}

function _load(filename) {
    const filepath = path.join(MEMORY_DIR, filename);
    if (fs.existsSync(filepath)) {
        try {
            return JSON.parse(fs.readFileSync(filepath, 'utf8'));
        } catch {
            return null;
        }
    }
    return null;
}

function _save(filename, data) {
    _ensureDir();
    const filepath = path.join(MEMORY_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n');
}

// ── Init ────────────────────────────────────────────────────

function init() {
    _ensureDir();
    knowledgeGraph = _load('knowledge-graph.json') || { entities: {}, relationships: [] };
    dailyNotes = _load('daily-notes.json') || {};
    tacitKnowledge = _load('tacit-knowledge.json') || {};
    initialized = true;
}

function _checkInit() {
    if (!initialized) init();
}

// ── Layer 1: Knowledge Graph ────────────────────────────────

/**
 * Add or update an entity in the knowledge graph.
 * @param {string} type - Entity type (person, project, company, tool, etc.)
 * @param {string} name - Entity name (unique within type)
 * @param {object} properties - Key-value properties
 */
function addEntity(type, name, properties = {}) {
    _checkInit();
    const key = `${type}::${name}`;
    const existing = knowledgeGraph.entities[key] || {};
    knowledgeGraph.entities[key] = {
        type,
        name,
        ...existing,
        ...properties,
        updated_at: new Date().toISOString(),
    };
    _save('knowledge-graph.json', knowledgeGraph);
}

/**
 * Get an entity by type and name.
 */
function getEntity(type, name) {
    _checkInit();
    return knowledgeGraph.entities[`${type}::${name}`] || null;
}

/**
 * Search entities by type and/or text match.
 */
function searchEntities(query, type = null) {
    _checkInit();
    const q = query.toLowerCase();
    return Object.values(knowledgeGraph.entities).filter(e => {
        if (type && e.type !== type) return false;
        const text = `${e.name} ${JSON.stringify(e)}`.toLowerCase();
        return text.includes(q);
    });
}

/**
 * Add a relationship between two entities.
 * @param {string} fromKey - "type::name" of source entity
 * @param {string} relation - Relationship type (e.g. "owns", "works_on", "prefers")
 * @param {string} toKey - "type::name" of target entity
 */
function addRelationship(fromKey, relation, toKey) {
    _checkInit();
    // Avoid duplicates
    const exists = knowledgeGraph.relationships.some(
        r => r.from === fromKey && r.relation === relation && r.to === toKey
    );
    if (!exists) {
        knowledgeGraph.relationships.push({
            from: fromKey,
            relation,
            to: toKey,
            created_at: new Date().toISOString(),
        });
        _save('knowledge-graph.json', knowledgeGraph);
    }
}

/**
 * Get all relationships involving an entity.
 */
function getRelationships(entityKey) {
    _checkInit();
    return knowledgeGraph.relationships.filter(
        r => r.from === entityKey || r.to === entityKey
    );
}

// ── Layer 2: Daily Notes ────────────────────────────────────

/**
 * Add a daily note entry.
 * @param {string} text - The note content
 * @param {string[]} [tags] - Optional tags for categorization
 */
function addDailyNote(text, tags = []) {
    _checkInit();
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    if (!dailyNotes[today]) dailyNotes[today] = [];
    dailyNotes[today].push({
        ts: new Date().toISOString(),
        text,
        tags,
    });
    _save('daily-notes.json', dailyNotes);
}

/**
 * Get notes for a specific date or recent N days.
 */
function getDailyNotes(date = null, recentDays = 7) {
    _checkInit();
    if (date) {
        return dailyNotes[date] || [];
    }
    // Return notes from recent N days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - recentDays);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    const result = {};
    for (const [d, notes] of Object.entries(dailyNotes)) {
        if (d >= cutoffStr) result[d] = notes;
    }
    return result;
}

/**
 * Search daily notes by text.
 */
function searchDailyNotes(query, limit = 20) {
    _checkInit();
    const q = query.toLowerCase();
    const results = [];

    // Search newest first
    const dates = Object.keys(dailyNotes).sort().reverse();
    for (const date of dates) {
        for (const note of dailyNotes[date]) {
            if (note.text.toLowerCase().includes(q)) {
                results.push({ date, ...note });
                if (results.length >= limit) return results;
            }
        }
    }
    return results;
}

// ── Layer 3: Tacit Knowledge ────────────────────────────────

/**
 * Record a learned pattern or preference.
 * @param {string} category - Category (communication, workflow, preferences, technical, etc.)
 * @param {string} insight - The learned insight
 * @param {number} [confidence=0.7] - Confidence level 0-1
 */
function addTacitKnowledge(category, insight, confidence = 0.7) {
    _checkInit();
    if (!tacitKnowledge[category]) tacitKnowledge[category] = [];

    // Check for duplicate/similar insights
    const existing = tacitKnowledge[category].find(
        k => k.insight.toLowerCase() === insight.toLowerCase()
    );
    if (existing) {
        // Reinforce existing insight — boost confidence
        existing.confidence = Math.min(1, existing.confidence + 0.1);
        existing.reinforced_at = new Date().toISOString();
        existing.reinforcements = (existing.reinforcements || 0) + 1;
    } else {
        tacitKnowledge[category].push({
            insight,
            confidence,
            created_at: new Date().toISOString(),
            reinforcements: 0,
        });
    }
    _save('tacit-knowledge.json', tacitKnowledge);
}

/**
 * Get all tacit knowledge, optionally filtered by category.
 */
function getTacitKnowledge(category = null) {
    _checkInit();
    if (category) return tacitKnowledge[category] || [];
    return tacitKnowledge;
}

/**
 * Get high-confidence insights across all categories.
 */
function getStrongInsights(minConfidence = 0.8) {
    _checkInit();
    const results = [];
    for (const [cat, insights] of Object.entries(tacitKnowledge)) {
        for (const insight of insights) {
            if (insight.confidence >= minConfidence) {
                results.push({ category: cat, ...insight });
            }
        }
    }
    return results.sort((a, b) => b.confidence - a.confidence);
}

// ── Context Builder ─────────────────────────────────────────

/**
 * Build a context string for the LLM by searching across all memory layers.
 * This is injected into the system prompt to give the LLM relevant context.
 *
 * @param {string} query - What the user is asking about
 * @param {object} opts - Options
 * @param {number} [opts.maxEntities=5] - Max knowledge graph entities
 * @param {number} [opts.maxNotes=10] - Max daily notes
 * @param {number} [opts.maxInsights=10] - Max tacit insights
 * @returns {string} Formatted context block
 */
function buildContext(query, opts = {}) {
    _checkInit();
    const maxEntities = opts.maxEntities || 5;
    const maxNotes = opts.maxNotes || 10;
    const maxInsights = opts.maxInsights || 10;

    const sections = [];

    // Knowledge graph matches
    const entities = searchEntities(query).slice(0, maxEntities);
    if (entities.length > 0) {
        sections.push('## Known Facts');
        for (const e of entities) {
            const props = Object.entries(e)
                .filter(([k]) => !['type', 'name', 'updated_at'].includes(k))
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ');
            sections.push(`- [${e.type}] ${e.name}${props ? ': ' + props : ''}`);

            // Include relationships
            const rels = getRelationships(`${e.type}::${e.name}`);
            for (const r of rels.slice(0, 3)) {
                sections.push(`  -> ${r.relation} ${r.to || r.from}`);
            }
        }
    }

    // Recent daily notes
    const notes = searchDailyNotes(query, maxNotes);
    if (notes.length > 0) {
        sections.push('\n## Recent Notes');
        for (const n of notes) {
            sections.push(`- [${n.date}] ${n.text}`);
        }
    }

    // Tacit knowledge (high confidence)
    const insights = getStrongInsights(0.6).slice(0, maxInsights);
    if (insights.length > 0) {
        sections.push('\n## Known Preferences & Patterns');
        for (const i of insights) {
            sections.push(`- [${i.category}] ${i.insight} (confidence: ${i.confidence.toFixed(1)})`);
        }
    }

    return sections.join('\n');
}

// ── Stats ───────────────────────────────────────────────────

function getStats() {
    _checkInit();
    const noteCount = Object.values(dailyNotes).reduce((sum, arr) => sum + arr.length, 0);
    const insightCount = Object.values(tacitKnowledge).reduce((sum, arr) => sum + arr.length, 0);

    return {
        entities: Object.keys(knowledgeGraph.entities).length,
        relationships: knowledgeGraph.relationships.length,
        daily_notes: noteCount,
        note_days: Object.keys(dailyNotes).length,
        tacit_insights: insightCount,
        tacit_categories: Object.keys(tacitKnowledge).length,
    };
}

module.exports = {
    init,
    // Layer 1: Knowledge Graph
    addEntity, getEntity, searchEntities,
    addRelationship, getRelationships,
    // Layer 2: Daily Notes
    addDailyNote, getDailyNotes, searchDailyNotes,
    // Layer 3: Tacit Knowledge
    addTacitKnowledge, getTacitKnowledge, getStrongInsights,
    // Context
    buildContext,
    // Stats
    getStats,
};
