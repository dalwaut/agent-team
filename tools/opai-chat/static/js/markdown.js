// OPAI Chat - Markdown Rendering

window.Markdown = {
    render(text) {
        // Configure marked
        marked.setOptions({
            highlight: function (code, lang) {
                if (lang && hljs.getLanguage(lang)) {
                    return hljs.highlight(code, { language: lang }).value;
                }
                return hljs.highlightAuto(code).value;
            },
            breaks: true,
            gfm: true
        });

        // Render markdown
        let html = marked.parse(text);

        // Add "Open in Canvas" buttons to code blocks
        html = this.addCanvasButtons(html);

        return html;
    },

    addCanvasButtons(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        doc.querySelectorAll('pre code').forEach((codeBlock, index) => {
            const pre = codeBlock.parentElement;

            // Get language
            const classes = codeBlock.className.split(' ');
            const langClass = classes.find(c => c.startsWith('language-'));
            const language = langClass ? langClass.replace('language-', '') : 'text';

            // Get code content
            const code = codeBlock.textContent;

            // Create wrapper
            const wrapper = document.createElement('div');
            wrapper.className = 'code-block-wrapper';
            wrapper.style.position = 'relative';

            // Create button
            const button = document.createElement('button');
            button.className = 'open-canvas-btn';
            button.textContent = 'Open in Canvas';
            button.style.cssText = `
                position: absolute;
                top: 8px;
                right: 8px;
                padding: 6px 12px;
                background: linear-gradient(135deg, var(--color-purple-deep), var(--color-purple-bright));
                border: none;
                border-radius: 6px;
                color: white;
                font-size: 0.875rem;
                cursor: pointer;
                opacity: 0;
                transition: opacity 0.2s;
            `;

            button.addEventListener('click', () => {
                if (window.Canvas) {
                    window.Canvas.openCode(code, language, `code_${index}.${language}`);
                }
            });

            // Show button on hover
            wrapper.addEventListener('mouseenter', () => {
                button.style.opacity = '1';
            });
            wrapper.addEventListener('mouseleave', () => {
                button.style.opacity = '0';
            });

            // Wrap pre and add button
            pre.parentNode.insertBefore(wrapper, pre);
            wrapper.appendChild(pre);
            wrapper.appendChild(button);
        });

        return doc.body.innerHTML;
    },

    extractCanvasTags(text) {
        // Extract <canvas> XML tags from Claude's response
        const canvasRegex = /<canvas\s+language="([^"]+)"\s+filename="([^"]+)">([\s\S]*?)<\/canvas>/g;
        const items = [];
        let match;

        while ((match = canvasRegex.exec(text)) !== null) {
            items.push({
                language: match[1],
                filename: match[2],
                content: match[3].trim()
            });
        }

        return items;
    }
};
