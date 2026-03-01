/**
 * list-projects tool
 * Lists all projects on the Boutabyte platform by type.
 */
import { listSubApps, listMobileApps, listPlugins, listAutomations, listCategories } from '../lib/supabase.js';

export const LIST_PROJECTS_TOOL = {
    name: 'list_projects',
    description: `List projects currently published on the Boutabyte platform.
Returns a summary of all web apps, mobile apps, plugins, and/or automations.

Use this when the user asks things like:
- "What's on Boutabyte?"
- "List all apps on Boutabyte"
- "Show me the Boutabyte projects"
- "What web apps are published?"`,
    inputSchema: {
        type: 'object' as const,
        properties: {
            type: {
                type: 'string',
                enum: ['webapp', 'mobile', 'plugin', 'automation', 'category', 'all'],
                description: 'Type of projects to list. Use "all" to list everything. Default: "all"',
            },
        },
        required: [],
    },
};

interface ListProjectsInput {
    type?: string;
}

export async function handleListProjects(input: ListProjectsInput) {
    const type = input.type || 'all';
    const result: Record<string, any> = {};

    if (type === 'all' || type === 'webapp') {
        const apps = await listSubApps();
        result.webapps = {
            count: apps.length,
            items: apps.map(a => ({
                id: a.id,
                name: a.name,
                slug: a.slug,
                url: `https://boutabyte.com/apps/${a.slug}`,
                approved: a.approved,
                tier: a.tier_requirement,
                demo: a.demo_mode,
                frontend: a.frontend_display,
                storage: a.storage_type,
                updated: a.updated_at,
            })),
        };
    }

    if (type === 'all' || type === 'mobile') {
        const apps = await listMobileApps();
        result.mobile_apps = {
            count: apps.length,
            items: apps.map(a => ({
                id: a.id,
                name: a.name,
                slug: a.slug,
                platform: a.platform,
                version: a.version,
                approved: a.approved,
                tier: a.tier_requirement,
                storage: a.storage_type,
                updated: a.updated_at,
            })),
        };
    }

    if (type === 'all' || type === 'plugin') {
        const plugins = await listPlugins();
        result.plugins = {
            count: plugins.length,
            items: plugins.map(p => ({
                id: p.id,
                name: p.name,
                slug: p.slug,
                version: p.version,
                active: p.is_active,
                tier: p.tier_requirement,
                updated: p.updated_at,
            })),
        };
    }

    if (type === 'all' || type === 'automation') {
        const automations = await listAutomations();
        result.automations = {
            count: automations.length,
            items: automations.map(a => ({
                id: a.ID,
                name: a.Name,
                category: a.Category,
                active: a.is_active,
                updated: a.updatedAt,
            })),
        };
    }

    if (type === 'category') {
        const categories = await listCategories();
        result.categories = {
            count: categories.length,
            items: categories.map(c => ({
                id: c.id,
                name: c.name,
                slug: c.slug,
                icon: c.icon,
                order: c.display_order,
            })),
        };
    }

    return result;
}
