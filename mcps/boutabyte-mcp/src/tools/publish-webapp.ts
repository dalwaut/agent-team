/**
 * publish-webapp tool
 * Uploads a local project's dist/build folder to the Boutabyte VPS
 * and creates a sub_apps database record.
 */
import fs from 'fs';
import path from 'path';
import { uploadDirectory, clearRemoteDirectory } from '../lib/file-api.js';
import { createSubApp, getSubAppBySlug, updateSubApp } from '../lib/supabase.js';

export const PUBLISH_WEBAPP_TOOL = {
    name: 'publish_webapp',
    description: `Publish a local web application project to the Boutabyte platform.
Uploads the project's build output (dist/ folder) to the VPS file server and creates a database record in sub_apps.
The app will be accessible at boutabyte.com/apps/{slug} after publishing.

Use this when the user says things like:
- "Add [project] to Boutabyte"
- "Publish [project] to Boutabyte"  
- "Deploy [project] as a webapp on Boutabyte"`,
    inputSchema: {
        type: 'object' as const,
        properties: {
            project_path: {
                type: 'string',
                description: 'Absolute path to the project directory. The tool will look for a dist/, build/, or out/ subfolder automatically. You can also point directly to the build output folder.',
            },
            name: {
                type: 'string',
                description: 'Display name for the web app on Boutabyte (e.g. "ThisKitchen", "Icon Architect AI")',
            },
            slug: {
                type: 'string',
                description: 'URL-friendly slug (e.g. "thiskitchen"). Auto-generated from name if not provided.',
            },
            description: {
                type: 'string',
                description: 'Description of the web app. Shown on the marketplace and detail pages.',
            },
            entry_point: {
                type: 'string',
                description: 'Main HTML file relative to the upload root (default: "index.html"). Use "dist/index.html" if your build outputs to a dist subfolder within the artifact.',
            },
            tier_requirement: {
                type: 'string',
                enum: ['free', 'starter', 'pro', 'ultimate'],
                description: 'Minimum subscription tier required to access the app (default: "free")',
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Tags for categorization and search',
            },
            demo_mode: {
                type: 'boolean',
                description: 'If true, the app is accessible without authentication (default: false)',
            },
            frontend_display: {
                type: 'boolean',
                description: 'If true, the app appears in the public marketplace (default: true)',
            },
            force_update: {
                type: 'boolean',
                description: 'If true and the slug already exists, overwrite the existing app files and update the record. Otherwise, return an error if slug exists.',
            },
        },
        required: ['project_path', 'name'],
    },
};

interface PublishWebappInput {
    project_path: string;
    name: string;
    slug?: string;
    description?: string;
    entry_point?: string;
    tier_requirement?: string;
    tags?: string[];
    demo_mode?: boolean;
    frontend_display?: boolean;
    force_update?: boolean;
}

export async function handlePublishWebapp(input: PublishWebappInput) {
    const { project_path, name, force_update = false } = input;

    // 1. Generate slug
    const slug = (input.slug || name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    if (!slug) {
        return { error: 'Could not generate a valid slug from the name.' };
    }

    // 2. Find the build output directory
    const buildDir = findBuildDirectory(project_path);
    if (!buildDir) {
        return {
            error: `Could not find a build output directory in "${project_path}". ` +
                `Looked for: dist/, build/, out/, .next/standalone/, or the path itself if it contains index.html. ` +
                `Make sure to build the project first (e.g. "npm run build").`,
        };
    }

    // 3. Check if slug already exists
    const existing = await getSubAppBySlug(slug);
    if (existing && !force_update) {
        return {
            error: `A web app with slug "${slug}" already exists (ID: ${existing.id}). ` +
                `Set force_update=true to overwrite it, or choose a different slug.`,
            existing: {
                id: existing.id,
                name: existing.name,
                slug: existing.slug,
                url: `https://boutabyte.com/apps/${existing.slug}`,
            },
        };
    }

    // 4. Calculate total size
    const totalSize = getDirectorySize(buildDir);
    const sizeMB = Math.round((totalSize / (1024 * 1024)) * 100) / 100;

    // 5. Clear old files if updating
    const remotePath = `apps/${slug}`;
    if (existing) {
        try {
            await clearRemoteDirectory(remotePath);
        } catch (e) {
            // Directory might not exist yet, that's fine
        }
    }

    // 6. Upload all files
    const uploadResult = await uploadDirectory(buildDir, remotePath);

    // 7. Create or update database record
    if (existing) {
        const updated = await updateSubApp(existing.id, {
            name,
            description: input.description ?? existing.description,
            storage_path: remotePath,
            entry_point: input.entry_point || existing.entry_point || 'index.html',
            bundle_size_mb: sizeMB,
            tags: input.tags ?? existing.tags,
            tier_requirement: input.tier_requirement ?? existing.tier_requirement,
            demo_mode: input.demo_mode ?? existing.demo_mode,
            frontend_display: input.frontend_display ?? existing.frontend_display,
        });

        return {
            success: true,
            action: 'updated',
            app: {
                id: updated.id,
                name: updated.name,
                slug: updated.slug,
                url: `https://boutabyte.com/apps/${updated.slug}`,
                storage_path: remotePath,
                entry_point: updated.entry_point,
                bundle_size_mb: sizeMB,
            },
            upload: {
                files_uploaded: uploadResult.filesUploaded,
                total_bytes: uploadResult.totalBytes,
                source_directory: buildDir,
            },
        };
    } else {
        const created = await createSubApp({
            name,
            slug,
            description: input.description,
            storage_type: 'server',
            storage_path: remotePath,
            entry_point: input.entry_point || 'index.html',
            tier_requirement: input.tier_requirement || 'free',
            tags: input.tags,
            demo_mode: input.demo_mode ?? false,
            frontend_display: input.frontend_display ?? true,
            approved: true,
            bundle_size_mb: sizeMB,
        });

        return {
            success: true,
            action: 'created',
            app: {
                id: created.id,
                name: created.name,
                slug: created.slug,
                url: `https://boutabyte.com/apps/${created.slug}`,
                storage_path: remotePath,
                entry_point: input.entry_point || 'index.html',
                bundle_size_mb: sizeMB,
            },
            upload: {
                files_uploaded: uploadResult.filesUploaded,
                total_bytes: uploadResult.totalBytes,
                source_directory: buildDir,
            },
        };
    }
}

// ============================================
// Helpers
// ============================================

/**
 * Finds the build output directory within a project.
 * Checks common build output folder names.
 */
function findBuildDirectory(projectPath: string): string | null {
    const normalized = path.resolve(projectPath);

    // If the path itself has index.html, use it directly
    if (fs.existsSync(path.join(normalized, 'index.html'))) {
        return normalized;
    }

    // Common build output directories
    const candidates = ['dist', 'build', 'out', '.next/standalone', 'public'];

    for (const candidate of candidates) {
        const candidatePath = path.join(normalized, candidate);
        if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
            return candidatePath;
        }
    }

    // If none found, check if the path itself is a directory with files
    if (fs.existsSync(normalized) && fs.statSync(normalized).isDirectory()) {
        const files = fs.readdirSync(normalized);
        // If it has typical web files, use it
        if (files.some(f => f.endsWith('.html') || f.endsWith('.js') || f.endsWith('.css'))) {
            return normalized;
        }
    }

    return null;
}

/**
 * Calculate total size of a directory in bytes.
 */
function getDirectorySize(dirPath: string): number {
    let total = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

        if (entry.isDirectory()) {
            total += getDirectorySize(fullPath);
        } else {
            total += fs.statSync(fullPath).size;
        }
    }

    return total;
}
