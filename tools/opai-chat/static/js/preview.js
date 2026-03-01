// OPAI Chat - Live Preview for HTML/CSS/JS

window.Preview = {
    debounceTimer: null,

    update(html) {
        // Debounce updates
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.render(html);
        }, 500);
    },

    render(html) {
        const iframe = document.getElementById('preview-iframe');

        // Wrap HTML in a complete document if needed
        let fullHtml = html;
        if (!html.toLowerCase().includes('<!doctype') && !html.toLowerCase().includes('<html')) {
            fullHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            margin: 0;
            padding: 20px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
    </style>
</head>
<body>
${html}
</body>
</html>
            `;
        }

        // Set iframe content
        iframe.srcdoc = fullHtml;
    }
};
