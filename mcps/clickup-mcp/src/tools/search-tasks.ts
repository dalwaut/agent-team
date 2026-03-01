/**
 * search_tasks — Search tasks across the entire ClickUp team.
 */
import { cuGet, getTeamId } from '../clickup-api.js';

export const SEARCH_TASKS_TOOL = {
    name: 'clickup_search_tasks',
    description: 'Search for tasks across all ClickUp spaces by name. Returns matching tasks with their location and status.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            query: {
                type: 'string',
                description: 'Search query (matches task names)',
            },
            include_closed: {
                type: 'boolean',
                description: 'Include closed tasks in results (default: false)',
                default: false,
            },
        },
        required: ['query'],
    },
};

export async function handleSearchTasks(args: { query: string; include_closed?: boolean }) {
    // ClickUp search is team-level
    const teamId = getTeamId();

    // Use the filtered team tasks endpoint with custom_task_ids or name search
    // The ClickUp v2 API doesn't have a direct search — we use the team tasks filtered endpoint
    const params: Record<string, string> = {
        page: '0',
        include_closed: args.include_closed ? 'true' : 'false',
    };

    // ClickUp doesn't have a direct search API in v2, but we can iterate spaces
    // For now, use the team's filtered tasks if available, otherwise search space by space
    const spacesData = await cuGet(`/team/${teamId}/space`, { archived: 'false' });
    const spaces = spacesData.spaces || [];

    const results: any[] = [];
    const queryLower = args.query.toLowerCase();

    for (const space of spaces) {
        // Get folderless lists
        try {
            const listsData = await cuGet(`/space/${space.id}/list`);
            for (const list of listsData.lists || []) {
                const tasksData = await cuGet(`/list/${list.id}/task`, params);
                for (const task of tasksData.tasks || []) {
                    if (task.name.toLowerCase().includes(queryLower) ||
                        (task.description || '').toLowerCase().includes(queryLower)) {
                        results.push({
                            id: task.id,
                            name: task.name,
                            status: task.status?.status,
                            space: space.name,
                            list: list.name,
                            url: task.url,
                        });
                    }
                }
                if (results.length >= 50) break;
            }
        } catch { /* skip on error */ }

        // Get foldered lists
        try {
            const foldersData = await cuGet(`/space/${space.id}/folder`);
            for (const folder of foldersData.folders || []) {
                for (const list of folder.lists || []) {
                    const tasksData = await cuGet(`/list/${list.id}/task`, params);
                    for (const task of tasksData.tasks || []) {
                        if (task.name.toLowerCase().includes(queryLower) ||
                            (task.description || '').toLowerCase().includes(queryLower)) {
                            results.push({
                                id: task.id,
                                name: task.name,
                                status: task.status?.status,
                                space: space.name,
                                folder: folder.name,
                                list: list.name,
                                url: task.url,
                            });
                        }
                    }
                    if (results.length >= 50) break;
                }
            }
        } catch { /* skip on error */ }

        if (results.length >= 50) break;
    }

    return { count: results.length, results: results.slice(0, 50) };
}
