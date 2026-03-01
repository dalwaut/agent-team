#!/usr/bin/env node
import { spawn } from 'child_process';
import os from 'os';

// 1. CONFIGURATION
// Tools starting with these prefixes will be KEPT.
const ALLOWED_PREFIXES = ['vps_', 'dns_', 'domains_get', 'domains_update'];
// Tools containing these words will be REMOVED.
const FORBIDDEN_KEYWORDS = ['purchase', 'billing', 'reach', 'order', 'delete', 'cancel', 'invoice'];

// 2. WINDOWS COMPATIBILITY FIX
// On Windows, we must call 'npx.cmd'. On Mac/Linux, just 'npx'.
const command = os.platform() === 'win32' ? 'npx.cmd' : 'npx';

const proc = spawn(command, ['-y', '@hostinger/mcp-server'], {
    env: { ...process.env }, // Pass the parent environment (with APITOKEN)
    stdio: ['pipe', 'pipe', 'inherit'] // Pipe stdin/stdout, inherit stderr for logs
});

// 3. BUFFERING LOGIC (Crucial for large tool lists)
let buffer = '';

proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();

    // Try to process complete JSON messages separated by newlines
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep the last incomplete fragment in the buffer

    for (const line of lines) {
        if (!line.trim()) continue;

        try {
            const message = JSON.parse(line);

            // INTERCEPT: Filter the tool list
            if (message.result && message.result.tools) {
                const originalCount = message.result.tools.length;

                message.result.tools = message.result.tools.filter(tool => {
                    const name = tool.name.toLowerCase();
                    const isAllowed = ALLOWED_PREFIXES.some(p => name.startsWith(p));
                    const isForbidden = FORBIDDEN_KEYWORDS.some(k => name.includes(k));
                    return isAllowed && !isForbidden;
                });

                // Optional: Log to stderr so you can see it's working in the debug console
                console.error(`[Slim-Hostinger] Pruned tools from ${originalCount} to ${message.result.tools.length}`);
            }

            // Forward the (potentially modified) message to Antigravity
            process.stdout.write(JSON.stringify(message) + '\n');
        } catch (err) {
            // If a line isn't valid JSON, just pass it through raw (rare but possible)
            console.error('[Slim-Hostinger] JSON Parse Error on line:', err);
            process.stdout.write(line + '\n');
        }
    }
});

// Forward input from Antigravity to Hostinger (handshakes, function calls)
process.stdin.pipe(proc.stdin);

// Handle process exit
proc.on('exit', (code) => {
    process.exit(code);
});