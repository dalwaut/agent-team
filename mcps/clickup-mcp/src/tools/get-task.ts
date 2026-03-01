/**
 * get_task — Get full details for a single ClickUp task.
 */
import { cuGet } from '../clickup-api.js';

export const GET_TASK_TOOL = {
    name: 'clickup_get_task',
    description: 'Get full details for a ClickUp task including description, custom fields, comments, and time tracking.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            task_id: {
                type: 'string',
                description: 'The ClickUp task ID',
            },
            include_comments: {
                type: 'boolean',
                description: 'Also fetch task comments (default: true)',
                default: true,
            },
        },
        required: ['task_id'],
    },
};

export async function handleGetTask(args: { task_id: string; include_comments?: boolean }) {
    const task = await cuGet(`/task/${args.task_id}`);

    const result: any = {
        id: task.id,
        name: task.name,
        description: task.description || '',
        status: task.status?.status,
        priority: task.priority?.priority,
        assignees: (task.assignees || []).map((a: any) => ({
            username: a.username,
            email: a.email,
        })),
        creator: task.creator ? { username: task.creator.username, email: task.creator.email } : null,
        due_date: task.due_date ? new Date(parseInt(task.due_date)).toISOString().split('T')[0] : null,
        start_date: task.start_date ? new Date(parseInt(task.start_date)).toISOString().split('T')[0] : null,
        time_estimate: task.time_estimate,
        tags: (task.tags || []).map((tag: any) => tag.name),
        url: task.url,
        list: task.list ? { id: task.list.id, name: task.list.name } : null,
        folder: task.folder ? { id: task.folder.id, name: task.folder.name } : null,
        space: task.space ? { id: task.space.id } : null,
        custom_fields: (task.custom_fields || []).map((cf: any) => ({
            name: cf.name,
            type: cf.type,
            value: cf.value,
        })),
        date_created: task.date_created ? new Date(parseInt(task.date_created)).toISOString() : null,
        date_updated: task.date_updated ? new Date(parseInt(task.date_updated)).toISOString() : null,
    };

    if (args.include_comments !== false) {
        try {
            const commentsData = await cuGet(`/task/${args.task_id}/comment`);
            result.comments = (commentsData.comments || []).map((c: any) => ({
                id: c.id,
                author: c.user?.username || 'unknown',
                text: c.comment_text,
                date: c.date ? new Date(parseInt(c.date)).toISOString() : null,
            }));
        } catch {
            result.comments = [];
        }
    }

    return result;
}
