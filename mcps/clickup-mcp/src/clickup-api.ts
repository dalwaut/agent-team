/**
 * ClickUp API client — shared HTTP helpers with rate-limit handling.
 */

const CLICKUP_BASE = 'https://api.clickup.com/api/v2';

function getApiKey(): string {
    const key = process.env.CLICKUP_API_KEY;
    if (!key) throw new Error('CLICKUP_API_KEY not set');
    return key;
}

function getTeamId(): string {
    return process.env.CLICKUP_TEAM_ID || '8500473';
}

async function cuFetch(path: string, options: RequestInit = {}): Promise<any> {
    const url = `${CLICKUP_BASE}${path}`;
    const headers: Record<string, string> = {
        'Authorization': getApiKey(),
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string> || {}),
    };

    let resp = await fetch(url, { ...options, headers });

    // Rate limit handling
    if (resp.status === 429) {
        const wait = parseInt(resp.headers.get('Retry-After') || '5', 10);
        await new Promise(r => setTimeout(r, wait * 1000));
        resp = await fetch(url, { ...options, headers });
    }

    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`ClickUp API ${resp.status}: ${body.slice(0, 300)}`);
    }

    return resp.json();
}

export async function cuGet(path: string, params?: Record<string, string>): Promise<any> {
    let url = path;
    if (params) {
        const qs = new URLSearchParams(params).toString();
        url = `${path}?${qs}`;
    }
    return cuFetch(url);
}

export async function cuPost(path: string, body: any): Promise<any> {
    return cuFetch(path, {
        method: 'POST',
        body: JSON.stringify(body),
    });
}

export async function cuPut(path: string, body: any): Promise<any> {
    return cuFetch(path, {
        method: 'PUT',
        body: JSON.stringify(body),
    });
}

export { getTeamId };
