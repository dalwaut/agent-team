// OPAI Messenger - File upload with drag-and-drop

async function uploadFile(file) {
    if (!App.activeChannel) return;
    if (file.size > 10 * 1024 * 1024) {
        alert('File too large (max 10MB)');
        return;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
        const resp = await authFetch(
            `api/upload?channel_id=${App.activeChannel.id}`,
            { method: 'POST', body: formData }
        );

        if (!resp.ok) {
            const err = await resp.json();
            alert(err.detail || 'Upload failed');
            return;
        }

        const data = await resp.json();

        // Send as a message with file attachment
        const msgResp = await authFetch(`api/channels/${App.activeChannel.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: file.name,
            }),
        });

        // The file URL needs to be stored in the message
        // For now, we send the URL as message content
        // In a full implementation, we'd use the file_url/file_name/file_type columns
        const msg = await msgResp.json();

        // Update the message with file info via a PATCH
        await authFetch(`api/messages/${msg.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: `📎 [${data.file_name}](${data.url})`,
            }),
        });

        // Reload messages to show the file
        await loadMessages();
        scrollToBottom();
    } catch (e) {
        console.error('Upload failed:', e);
        alert('Upload failed');
    }
}

function setupDragDrop() {
    const dropZone = document.getElementById('drop-zone');
    let dragCounter = 0;

    document.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        if (App.activeChannel) {
            dropZone.classList.add('visible');
        }
    });

    document.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            dropZone.classList.remove('visible');
        }
    });

    document.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    document.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        dropZone.classList.remove('visible');

        if (!App.activeChannel) return;

        const files = e.dataTransfer?.files;
        if (files?.length) {
            uploadFile(files[0]);
        }
    });
}
