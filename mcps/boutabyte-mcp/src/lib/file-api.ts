/**
 * VPS File API client for Boutabyte MCP
 * Wraps the file.boutabyte.com REST API for uploading, listing, and deleting files.
 */
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

function getBaseUrl(): string {
    const url = process.env.FILE_API_URL;
    if (!url) {
        throw new Error('Missing FILE_API_URL environment variable.');
    }
    return url.replace(/\/$/, ''); // strip trailing slash
}

function getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const apiKey = process.env.FILE_API_KEY;
    if (apiKey) {
        headers['x-api-key'] = apiKey;
    }
    return headers;
}

/**
 * Upload a single file to the VPS.
 * Uses multipart/form-data matching the file API's multer config.
 */
export async function uploadFile(
    filePath: string,
    remotePath: string
): Promise<{ success: boolean; name: string; size: number }> {
    const baseUrl = getBaseUrl();
    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);

    // Build FormData manually for Node.js
    const boundary = '----BoutaByteMCP' + Date.now();
    const CRLF = '\r\n';

    const header = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="files"; filename="${fileName}"`,
        `Content-Type: application/octet-stream`,
        '',
        '',
    ].join(CRLF);

    const footer = CRLF + `--${boundary}--` + CRLF;

    const headerBuffer = Buffer.from(header, 'utf-8');
    const footerBuffer = Buffer.from(footer, 'utf-8');
    const body = Buffer.concat([headerBuffer, fileBuffer, footerBuffer]);

    const url = `${baseUrl}/upload?path=${encodeURIComponent(remotePath)}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            ...getHeaders(),
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`File upload failed (${res.status}): ${errText}`);
    }

    const data = await res.json() as any;
    return { success: true, name: fileName, size: fileBuffer.length };
}

/**
 * Upload a buffer directly (for in-memory files like generated ZIPs).
 */
export async function uploadBuffer(
    buffer: Buffer,
    fileName: string,
    remotePath: string
): Promise<{ success: boolean; name: string; size: number }> {
    const baseUrl = getBaseUrl();

    const boundary = '----BoutaByteMCP' + Date.now();
    const CRLF = '\r\n';

    const header = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="files"; filename="${fileName}"`,
        `Content-Type: application/octet-stream`,
        '',
        '',
    ].join(CRLF);

    const footer = CRLF + `--${boundary}--` + CRLF;

    const headerBuffer = Buffer.from(header, 'utf-8');
    const footerBuffer = Buffer.from(footer, 'utf-8');
    const body = Buffer.concat([headerBuffer, buffer, footerBuffer]);

    const url = `${baseUrl}/upload?path=${encodeURIComponent(remotePath)}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            ...getHeaders(),
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Buffer upload failed (${res.status}): ${errText}`);
    }

    return { success: true, name: fileName, size: buffer.length };
}

/**
 * Upload an entire directory (recursively) to the VPS.
 * Returns the number of files uploaded and total size.
 */
export async function uploadDirectory(
    localDir: string,
    remoteBasePath: string
): Promise<{ filesUploaded: number; totalBytes: number; files: string[] }> {
    const allFiles = getAllFiles(localDir);
    let totalBytes = 0;
    const uploadedFiles: string[] = [];

    for (const filePath of allFiles) {
        // Calculate relative path from localDir
        const relativePath = path.relative(localDir, filePath).replace(/\\/g, '/');
        const fileDir = path.dirname(relativePath);

        // Remote path is base + subdirectory
        const remotePath = fileDir === '.'
            ? remoteBasePath
            : `${remoteBasePath}/${fileDir}`;

        const result = await uploadFile(filePath, remotePath);
        totalBytes += result.size;
        uploadedFiles.push(relativePath);
    }

    return {
        filesUploaded: uploadedFiles.length,
        totalBytes,
        files: uploadedFiles,
    };
}

/**
 * List files at a given VPS path.
 */
export async function listFiles(remotePath: string): Promise<any[]> {
    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/list?path=${encodeURIComponent(remotePath)}`;

    const res = await fetch(url, { headers: getHeaders() });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`List files failed (${res.status}): ${errText}`);
    }

    const data = await res.json() as any;
    return data.items || [];
}

/**
 * Delete a file or directory from the VPS.
 */
export async function deleteRemotePath(remotePath: string): Promise<boolean> {
    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/delete?path=${encodeURIComponent(remotePath)}`;

    const res = await fetch(url, {
        method: 'DELETE',
        headers: getHeaders(),
    });

    if (!res.ok && res.status !== 404) {
        const errText = await res.text();
        throw new Error(`Delete failed (${res.status}): ${errText}`);
    }

    return true;
}

/**
 * Clear all contents of a remote directory (but keep the dir itself).
 */
export async function clearRemoteDirectory(remotePath: string): Promise<number> {
    const items = await listFiles(remotePath);
    let deleted = 0;

    for (const item of items) {
        const itemPath = `${remotePath}/${item.name}`;
        await deleteRemotePath(itemPath);
        deleted++;
    }

    return deleted;
}

// ============================================
// Helpers
// ============================================

/**
 * Recursively get all files in a directory.
 */
function getAllFiles(dir: string): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip common junk
        if (entry.name.startsWith('.') || entry.name === '__MACOSX' || entry.name === 'node_modules') {
            continue;
        }

        if (entry.isDirectory()) {
            results.push(...getAllFiles(fullPath));
        } else {
            results.push(fullPath);
        }
    }

    return results;
}
