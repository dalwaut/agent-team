/**
 * Voice Transcriber — Groq Whisper API integration.
 *
 * Transcribes Telegram voice messages (OGG/Opus) using Groq's
 * OpenAI-compatible Whisper endpoint. No extra npm deps needed
 * (Node 18+ native fetch + FormData via undici).
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-large-v3';

/**
 * Transcribe an audio buffer using Groq Whisper API.
 * @param {Buffer} buffer - Audio file buffer (OGG/Opus from Telegram)
 * @returns {Promise<{ text: string, language?: string, duration?: number } | { error: string }>}
 */
async function transcribeVoice(buffer) {
  if (!GROQ_API_KEY) {
    return { error: 'GROQ_API_KEY not configured' };
  }

  try {
    // Build multipart form data
    const blob = new Blob([buffer], { type: 'audio/ogg' });
    const form = new FormData();
    form.append('file', blob, 'voice.ogg');
    form.append('model', WHISPER_MODEL);
    form.append('response_format', 'verbose_json');

    const res = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: form,
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[TG] [VOICE] Groq API error ${res.status}:`, errBody.substring(0, 300));
      return { error: `Transcription failed (${res.status})` };
    }

    const data = await res.json();
    return {
      text: data.text || '',
      language: data.language || null,
      duration: data.duration || null,
    };
  } catch (err) {
    console.error('[TG] [VOICE] Transcription error:', err.message);
    return { error: `Transcription error: ${err.message}` };
  }
}

module.exports = { transcribeVoice };
