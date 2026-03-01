/**
 * create_task — Create a new task in a ClickUp list.
 */
import { cuPost } from '../clickup-api.js';

export const CREATE_TASK_TOOL = {
    name: 'clickup_create_task',
    description: 'Create a new task in a ClickUp list.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            list_id: {
                type: 'string',
                description: 'The ClickUp list ID to create the task in',
            },
            name: {
                type: 'string',
                description: 'Task name/title',
            },
            description: {
                type: 'string',
                description: 'Task description (markdown supported)',
            },
            status: {
                type: 'string',
                description: 'Task status (e.g. "to do", "in progress", "complete")',
            },
            priority: {
                type: 'number',
                description: 'Priority: 1=urgent, 2=high, 3=normal, 4=low',
            },
            due_date: {
                type: 'string',
                description: 'Due date in YYYY-MM-DD format',
            },
            tags: {
                type: 'string',
                description: 'Comma-separated tag names',
            },
        },
        required: ['list_id', 'name'],
    },
};

export async function handleCreateTask(args: {
    list_id: string;
    name: string;
    description?: string;
    status?: string;
    priority?: number;
    due_date?: string;
    tags?: string;
}) {
    const body: any = { name: args.name };

    if (args.description) body.description = args.description;
    if (args.status) body.status = args.status;
    if (args.priority) body.priority = args.priority;
    if (args.due_date) {
        body.due_date = new Date(args.due_date).getTime();
        body.due_date_time = false;
    }
    if (args.tags) {
        body.tags = args.tags.split(',').map(t => t.trim());
    }

    const task = await cuPost(`/list/${args.list_id}/task`, body);

    return {
        id: task.id,
        name: task.name,
        status: task.status?.status,
        url: task.url,
    };
}
