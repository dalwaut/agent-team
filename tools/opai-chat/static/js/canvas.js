// OPAI Chat - Canvas Editor

window.Canvas = {
    items: [],
    activeItemId: null,

    openCode(code, language, filename) {
        const itemId = `canvas_${Date.now()}`;

        const item = {
            id: itemId,
            type: 'code',
            language: language,
            filename: filename,
            content: code
        };

        this.items.push(item);
        this.activeItemId = itemId;
        this.render();
        this.show();
    },

    show() {
        document.getElementById('canvas-panel').classList.remove('hidden');
    },

    hide() {
        document.getElementById('canvas-panel').classList.add('hidden');
    },

    render() {
        this.renderTabs();
        this.renderContent();
    },

    renderTabs() {
        const tabsContainer = document.getElementById('canvas-tabs');
        tabsContainer.innerHTML = '';

        this.items.forEach(item => {
            const tab = document.createElement('div');
            tab.className = 'canvas-tab';
            if (item.id === this.activeItemId) {
                tab.classList.add('active');
            }

            tab.textContent = item.filename;
            tab.addEventListener('click', () => {
                this.activeItemId = item.id;
                this.render();
            });

            tabsContainer.appendChild(tab);
        });
    },

    renderContent() {
        const activeItem = this.items.find(i => i.id === this.activeItemId);
        if (!activeItem) return;

        // Set language
        const langSelect = document.getElementById('canvas-language');
        langSelect.value = activeItem.language;

        // Set content
        const textarea = document.getElementById('canvas-textarea');
        textarea.value = activeItem.content;

        // Show/hide preview toggle for HTML
        const modeToggle = document.getElementById('canvas-mode-toggle');
        if (activeItem.language === 'html') {
            modeToggle.classList.remove('hidden');
        } else {
            modeToggle.classList.add('hidden');
            this.showEditor();
        }

        // Update preview if in preview mode
        if (activeItem.language === 'html' && !document.getElementById('canvas-preview').classList.contains('hidden')) {
            window.Preview.update(activeItem.content);
        }
    },

    showEditor() {
        document.getElementById('canvas-editor').classList.remove('hidden');
        document.getElementById('canvas-preview').classList.add('hidden');
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === 'code');
        });
    },

    showPreview() {
        const activeItem = this.items.find(i => i.id === this.activeItemId);
        if (!activeItem) return;

        document.getElementById('canvas-editor').classList.add('hidden');
        document.getElementById('canvas-preview').classList.remove('hidden');
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === 'preview');
        });

        window.Preview.update(activeItem.content);
    },

    updateContent(content) {
        const activeItem = this.items.find(i => i.id === this.activeItemId);
        if (!activeItem) return;

        activeItem.content = content;

        // Update preview if visible
        if (activeItem.language === 'html' && !document.getElementById('canvas-preview').classList.contains('hidden')) {
            window.Preview.update(content);
        }
    },

    copyToClipboard() {
        const activeItem = this.items.find(i => i.id === this.activeItemId);
        if (!activeItem) return;

        navigator.clipboard.writeText(activeItem.content).then(() => {
            alert('Copied to clipboard!');
        });
    },

    async saveToFile() {
        const activeItem = this.items.find(i => i.id === this.activeItemId);
        if (!activeItem) return;

        const filename = prompt('Enter filename:', activeItem.filename);
        if (!filename) return;

        const path = prompt('Enter full path:', `/workspace/synced/opai/${filename}`);
        if (!path) return;

        try {
            const response = await fetch('api/files/write', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: path,
                    content: activeItem.content
                })
            });

            if (response.ok) {
                alert(`Saved to ${path}`);
            } else {
                alert('Error saving file');
            }
        } catch (error) {
            console.error('Error saving file:', error);
            alert('Error saving file');
        }
    },

    insertIntoChat() {
        const activeItem = this.items.find(i => i.id === this.activeItemId);
        if (!activeItem) return;

        // Use whichever input is currently visible
        const chatView = document.getElementById('chat-view');
        const inputId = (chatView && !chatView.classList.contains('hidden'))
            ? 'chat-message-input' : 'welcome-message-input';
        const input = document.getElementById(inputId);
        const codeBlock = '```' + activeItem.language + '\n' + activeItem.content + '\n```';
        input.value = (input.value ? input.value + '\n\n' : '') + codeBlock;
        input.focus();
    }
};

// Setup canvas event listeners
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('canvas-close-btn').addEventListener('click', () => {
        window.Canvas.hide();
    });

    document.getElementById('canvas-textarea').addEventListener('input', (e) => {
        window.Canvas.updateContent(e.target.value);
    });

    document.getElementById('canvas-language').addEventListener('change', (e) => {
        const activeItem = window.Canvas.items.find(i => i.id === window.Canvas.activeItemId);
        if (activeItem) {
            activeItem.language = e.target.value;
        }
    });

    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.mode === 'code') {
                window.Canvas.showEditor();
            } else {
                window.Canvas.showPreview();
            }
        });
    });

    document.getElementById('canvas-copy-btn').addEventListener('click', () => {
        window.Canvas.copyToClipboard();
    });

    document.getElementById('canvas-save-btn').addEventListener('click', () => {
        window.Canvas.saveToFile();
    });

    document.getElementById('canvas-insert-btn').addEventListener('click', () => {
        window.Canvas.insertIntoChat();
    });
});
