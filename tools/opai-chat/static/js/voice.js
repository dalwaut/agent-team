// OPAI Chat — Voice Recording & Transcription
// Silently uses Gemini Flash for STT without changing the visible model selector

window.Voice = {
    mediaRecorder: null,
    audioChunks: [],
    isRecording: false,

    init() {
        // Bind to both mic buttons (welcome + chat)
        ['welcome-mic-btn', 'chat-mic-btn', 'mozart-mic-btn'].forEach(id => {
            const btn = document.getElementById(id);
            if (!btn) return;
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.isRecording) {
                    this.stopRecording();
                } else {
                    this.startRecording();
                }
            });
        });
    },

    async startRecording() {
        if (!window.isSecureContext) {
            this.showError('Voice input requires HTTPS.');
            return;
        }

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            this.showError('Your browser does not support microphone access.');
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.audioChunks = [];

            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : MediaRecorder.isTypeSupported('audio/webm')
                    ? 'audio/webm'
                    : '';

            this.mediaRecorder = mimeType
                ? new MediaRecorder(stream, { mimeType })
                : new MediaRecorder(stream);

            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) this.audioChunks.push(e.data);
            };

            this.mediaRecorder.onstop = () => {
                stream.getTracks().forEach(t => t.stop());
                this.handleRecordingComplete();
            };

            this.mediaRecorder.start();
            this.isRecording = true;
            this.updateAllMicButtons(true, false);
        } catch (err) {
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                this.showError('Microphone permission denied.');
            } else if (err.name === 'NotFoundError') {
                this.showError('No microphone found.');
            } else {
                this.showError('Mic error: ' + err.message);
            }
        }
    },

    stopRecording() {
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
        }
        this.isRecording = false;
        this.updateAllMicButtons(false, false);
    },

    async handleRecordingComplete() {
        if (this.audioChunks.length === 0) return;

        const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
        this.audioChunks = [];

        // Show transcribing state on all mic buttons
        this.updateAllMicButtons(false, true);

        try {
            const text = await this.transcribe(audioBlob);
            if (text) {
                // Insert into whichever input is currently visible
                const input = this.getActiveInput();
                const existing = input.value.trim();
                input.value = existing ? existing + ' ' + text : text;
                input.style.height = 'auto';
                input.style.height = Math.min(input.scrollHeight, 200) + 'px';
                input.focus();
            }
        } catch (err) {
            console.error('[Voice] Transcription error:', err);
            this.showError('Transcription failed.');
        } finally {
            this.updateAllMicButtons(false, false);
        }
    },

    async transcribe(audioBlob) {
        // Silently POST to transcribe endpoint — uses Gemini Flash on backend
        // Does NOT change AppState.currentModel or any visible UI state
        const formData = new FormData();
        formData.append('audio', audioBlob, 'recording.webm');

        const fetchFn = typeof authFetch !== 'undefined' ? authFetch : fetch;
        const response = await fetchFn('api/transcribe', {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || 'HTTP ' + response.status);
        }

        const data = await response.json();
        return data.text || '';
    },

    getActiveInput() {
        // If chat view is visible, use chat input; otherwise welcome input
        const chatView = document.getElementById('chat-view');
        if (chatView && !chatView.classList.contains('hidden')) {
            return document.getElementById('chat-message-input');
        }
        return document.getElementById('welcome-message-input');
    },

    updateAllMicButtons(recording, transcribing) {
        ['welcome-mic-btn', 'chat-mic-btn', 'mozart-mic-btn'].forEach(id => {
            const btn = document.getElementById(id);
            if (!btn) return;
            btn.classList.toggle('recording', recording);
            btn.classList.toggle('transcribing', transcribing);
            btn.title = recording ? 'Click to stop recording'
                : transcribing ? 'Transcribing...'
                : 'Voice input';
        });
    },

    showError(message) {
        // If chat view is visible, use inline error; otherwise alert
        const chatView = document.getElementById('chat-view');
        if (chatView && !chatView.classList.contains('hidden') && window.Chat) {
            window.Chat.addErrorMessage(message);
        } else {
            alert(message);
        }
    }
};

document.addEventListener('DOMContentLoaded', () => {
    window.Voice.init();
});
