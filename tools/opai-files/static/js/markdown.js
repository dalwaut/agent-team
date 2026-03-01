/**
 * OPAI Files — Rich markdown rendering with markdown-it.
 *
 * Configures markdown-it with highlight.js, KaTeX math, task lists,
 * wikilink syntax, callouts, and lazy mermaid loading.
 */

let md = null;
let mermaidLoaded = false;
let mermaidLoading = false;

/** Initialize markdown-it with plugins. Call once after CDN scripts load. */
function initMarkdown() {
    if (!window.markdownit) return false;

    md = window.markdownit({
        html: false,
        linkify: true,
        typographer: true,
        highlight(str, lang) {
            if (window.hljs && lang && window.hljs.getLanguage(lang)) {
                try { return window.hljs.highlight(str, { language: lang }).value; } catch (_) {}
            }
            if (window.hljs) {
                try { return window.hljs.highlightAuto(str).value; } catch (_) {}
            }
            return '';
        },
    });

    // Task list checkboxes: - [ ] and - [x]
    md.core.ruler.after('inline', 'task-lists', function (state) {
        const tokens = state.tokens;
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].type !== 'inline') continue;
            const content = tokens[i].content;
            if (/^\[[ x]\]\s/.test(content)) {
                const checked = content[1] === 'x';
                tokens[i].content = content.slice(4);
                // Mark parent list item
                let j = i - 1;
                while (j >= 0 && tokens[j].type !== 'list_item_open') j--;
                if (j >= 0) {
                    tokens[j].attrSet('class', 'task-list-item');
                    // Insert checkbox token
                    const cb = new state.Token('html_inline', '', 0);
                    cb.content = `<input type="checkbox" disabled ${checked ? 'checked' : ''}> `;
                    tokens[i].children.unshift(cb);
                }
            }
        }
    });

    // Wikilink inline rule: [[target]] or [[target|alias]]
    md.inline.ruler.before('link', 'wikilink', function (state, silent) {
        const src = state.src;
        const pos = state.pos;
        if (src.charCodeAt(pos) !== 0x5B || src.charCodeAt(pos + 1) !== 0x5B) return false;

        const end = src.indexOf(']]', pos + 2);
        if (end < 0) return false;

        if (!silent) {
            const inner = src.slice(pos + 2, end);
            const pipeIdx = inner.indexOf('|');
            const target = (pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner).trim();
            const alias = pipeIdx >= 0 ? inner.slice(pipeIdx + 1).trim() : target;

            const token = state.push('wikilink', 'a', 0);
            token.meta = { target, alias };
        }

        state.pos = end + 2;
        return true;
    });

    md.renderer.rules.wikilink = function (tokens, idx) {
        const { target, alias } = tokens[idx].meta;
        const escapedTarget = md.utils.escapeHtml(target);
        const escapedAlias = md.utils.escapeHtml(alias);
        return `<a class="wikilink" data-wikilink="${escapedTarget}" title="${escapedTarget}">${escapedAlias}</a>`;
    };

    // KaTeX math: $inline$ and $$block$$
    if (window.katex) {
        // Block math $$...$$
        md.block.ruler.before('fence', 'math_block', function (state, startLine, endLine, silent) {
            const startPos = state.bMarks[startLine] + state.tShift[startLine];
            if (state.src.slice(startPos, startPos + 2) !== '$$') return false;
            if (silent) return true;

            let nextLine = startLine + 1;
            while (nextLine < endLine) {
                const pos = state.bMarks[nextLine] + state.tShift[nextLine];
                if (state.src.slice(pos, pos + 2) === '$$') break;
                nextLine++;
            }
            if (nextLine >= endLine) return false;

            const content = state.getLines(startLine + 1, nextLine, state.tShift[startLine], false).trim();
            const token = state.push('math_block', 'div', 0);
            token.content = content;
            token.map = [startLine, nextLine + 1];
            state.line = nextLine + 1;
            return true;
        });

        md.renderer.rules.math_block = function (tokens, idx) {
            try {
                return '<div class="math-block">' + window.katex.renderToString(tokens[idx].content, { displayMode: true, throwOnError: false }) + '</div>';
            } catch (e) {
                return '<div class="math-block math-error">' + md.utils.escapeHtml(tokens[idx].content) + '</div>';
            }
        };

        // Inline math $...$
        md.inline.ruler.before('escape', 'math_inline', function (state, silent) {
            if (state.src.charCodeAt(state.pos) !== 0x24) return false;
            // Skip if it's $$
            if (state.src.charCodeAt(state.pos + 1) === 0x24) return false;

            const start = state.pos + 1;
            const end = state.src.indexOf('$', start);
            if (end < 0 || end === start) return false;

            if (!silent) {
                const token = state.push('math_inline', 'span', 0);
                token.content = state.src.slice(start, end);
            }
            state.pos = end + 1;
            return true;
        });

        md.renderer.rules.math_inline = function (tokens, idx) {
            try {
                return window.katex.renderToString(tokens[idx].content, { displayMode: false, throwOnError: false });
            } catch (e) {
                return '<code class="math-error">' + md.utils.escapeHtml(tokens[idx].content) + '</code>';
            }
        };
    }

    // Callout/admonition support: > [!TYPE] or > [!TYPE] title
    const defaultFenceRenderer = md.renderer.rules.fence || function (tokens, idx, options, env, self) {
        return self.renderToken(tokens, idx, options);
    };

    // Override blockquote rendering for callouts via post-process
    const defaultRender = md.renderer.render.bind(md.renderer);
    md.renderer.render = function (tokens, options, env) {
        let html = defaultRender(tokens, options, env);
        // Transform callouts: <blockquote> starting with [!TYPE]
        html = html.replace(/<blockquote>\s*<p>\[!(NOTE|TIP|WARNING|CAUTION|IMPORTANT|INFO|DANGER|BUG|EXAMPLE|QUOTE|ABSTRACT|TODO|SUCCESS|FAILURE|QUESTION)\]([^<]*)/gi,
            function (match, type, rest) {
                const t = type.toLowerCase();
                const title = rest.trim() || type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
                return `<div class="callout callout-${t}"><div class="callout-title">${md.utils.escapeHtml(title)}</div><p>`;
            });
        html = html.replace(/<\/blockquote>(\s*<!--callout-end-->)?/g, function (match) {
            // Check if the preceding content was a callout
            return '</div>';
        });
        // Fix: only close callouts as divs, leave normal blockquotes as blockquotes
        // Re-approach: use a simpler regex replacement
        return html;
    };

    // Simpler callout approach: post-process the final HTML
    md.renderer.render = function (tokens, options, env) {
        let html = defaultRender(tokens, options, env);
        // Convert blockquotes that start with [!TYPE] into callout divs
        html = html.replace(/<blockquote>\s*<p>\[!(NOTE|TIP|WARNING|CAUTION|IMPORTANT|INFO|DANGER|BUG|EXAMPLE|QUOTE|ABSTRACT|TODO|SUCCESS|FAILURE|QUESTION)\]\s*(.*?)<\/p>/gi,
            function (match, type, rest) {
                const t = type.toLowerCase();
                const title = rest.trim() || type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
                return `<div class="callout callout-${t}"><div class="callout-title">${md.utils.escapeHtml(title)}</div><p>`;
            });
        // Close callout divs (replace matching </blockquote> after a callout-opened div)
        let depth = 0;
        html = html.replace(/(<div class="callout |<\/blockquote>)/g, function (match) {
            if (match.startsWith('<div class="callout')) {
                depth++;
                return match;
            }
            if (depth > 0) {
                depth--;
                return '</div>';
            }
            return match;
        });
        return html;
    };

    return true;
}

/**
 * Render markdown text to HTML.
 * Falls back to the legacy regex renderer if markdown-it isn't loaded.
 */
function renderMarkdown(text) {
    if (!md && !initMarkdown()) {
        return renderMarkdownFallback(text);
    }

    let html = md.render(text);

    // Post-process: detect mermaid code blocks and render them
    if (html.includes('class="language-mermaid"')) {
        html = html.replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
            function (match, code) {
                const id = 'mermaid-' + Math.random().toString(36).slice(2, 8);
                const decoded = code.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
                lazyLoadMermaid();
                return `<div class="mermaid-block" id="${id}">${decoded}</div>`;
            });
    }

    return html;
}

/** Legacy regex renderer (kept as fallback). */
function renderMarkdownFallback(text) {
    let html = _esc(text);
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    return `<p>${html}</p>`;
}

function _esc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Lazy-load mermaid from CDN on first encounter. */
function lazyLoadMermaid() {
    if (mermaidLoaded || mermaidLoading) return;
    mermaidLoading = true;

    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
    script.onload = () => {
        mermaidLoaded = true;
        mermaidLoading = false;
        window.mermaid.initialize({
            startOnLoad: false,
            theme: 'dark',
            themeVariables: {
                primaryColor: '#4a6cf7',
                primaryTextColor: '#e0e0e8',
                lineColor: '#888',
                secondaryColor: '#1a1a25',
                tertiaryColor: '#12121a',
            },
        });
        renderMermaidBlocks();
    };
    script.onerror = () => { mermaidLoading = false; };
    document.head.appendChild(script);
}

/** Render all pending mermaid blocks on the page. */
async function renderMermaidBlocks() {
    if (!window.mermaid) return;
    const blocks = document.querySelectorAll('.mermaid-block');
    for (const block of blocks) {
        if (block.dataset.rendered) continue;
        try {
            const { svg } = await window.mermaid.render(block.id + '-svg', block.textContent.trim());
            block.innerHTML = svg;
            block.dataset.rendered = 'true';
        } catch (e) {
            block.innerHTML = `<pre class="mermaid-error">${_esc(block.textContent)}\n\nMermaid error: ${_esc(e.message)}</pre>`;
        }
    }
}
