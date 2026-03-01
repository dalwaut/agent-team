/**
 * list_tasks — List tasks in a ClickUp list with optional filters.
 */
import { cuGet } from '../clickup-api.js';

export const LIST_TASKS_TOOL = {
    name: 'clickup_list_tasks',
    description: 'List tasks in a ClickUp list. Supports pagination and filters for status, assignees, and subtasks.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            list_id: {
                type: 'string',
                description: 'The ClickUp list ID',
            },
            include_closed: {
                type: 'boolean',
                description: 'Include closed/done tasks (default: false)',
                default: false,
            },
            include_subtasks: {
                type: 'boolean',
                description: 'Include subtasks (default: true)',
                default: true,
            },
            page: {
                type: 'number',
                description: 'Page number for pagination (0-indexed, default: 0)',
                default: 0,
            },
            statuses: {
                type: 'string',
                description: 'Comma-separated status filter (e.g. "in progress,review")',
            },
        },
        required: ['list_id'],
    },
};

export async function handleListTasks(args: {
    list_id: string;
    include_closed?: boolean;
    include_subtasks?: boolean;
    page?: number;
    statuses?: string;
}) {
    const params: Record<string, string> = {
        include_closed: args.include_closed ? 'true' : 'false',
        subtasks: args.include_subtasks !== false ? 'true' : 'false',
        page: String(args.page || 0),
    };
    if (args.statuses) {
        // ClickUp expects statuses[] params
        params['statuses[]'] = args.statuses;
    }

    const data = await cuGet(`/list/${args.list_id}/task`, params);
    const tasks = (data.tasks || []).map((t: any) => ({
        id: t.id,
        name: t.name,
        status: t.status?.status,
        priority: t.priority?.priority,
        assignees: (t.assignees || []).map((a: any) => a.username || a.email),
        due_date: t.due_date ? new Date(parseInt(t.due_date)).toISOString().split('T')[0] : null,
        tags: (t.tags || []).map((tag: any) => tag.name),
        url: t.url,
    }));

    return { count: tasks.length, last_page: data.last_page ?? true, tasks };
}
