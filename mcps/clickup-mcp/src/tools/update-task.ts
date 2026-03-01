/**
 * update_task — Update an existing ClickUp task.
 */
import { cuPut } from '../clickup-api.js';

export const UPDATE_TASK_TOOL = {
    name: 'clickup_update_task',
    description: 'Update an existing ClickUp task (name, description, status, priority, due date).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            task_id: {
                type: 'string',
                description: 'The ClickUp task ID to update',
            },
            name: {
                type: 'string',
                description: 'New task name',
            },
            description: {
                type: 'string',
                description: 'New description',
            },
            status: {
                type: 'string',
                description: 'New status',
            },
            priority: {
                type: 'number',
                description: 'New priority: 1=urgent, 2=high, 3=normal, 4=low',
            },
            due_date: {
                type: 'string',
                description: 'New due date (YYYY-MM-DD) or "none" to clear',
            },
        },
        required: ['task_id'],
    },
};

export async function handleUpdateTask(args: {
    task_id: string;
    name?: string;
    description?: string;
    status?: string;
    priority?: number;
    due_date?: string;
}) {
    const body: any = {};

    if (args.name) body.name = args.name;
    if (args.description !== undefined) body.description = args.description;
    if (args.status) body.status = args.status;
    if (args.priority) body.priority = args.priority;
    if (args.due_date) {
        if (args.due_date === 'none') {
            body.due_date = null;
        } else {
            body.due_date = new Date(args.due_date).getTime();
            body.due_date_time = false;
        }
    }

    const task = await cuPut(`/task/${args.task_id}`, body);

    return {
        id: task.id,
        name: task.name,
        status: task.status?.status,
        url: task.url,
        updated: true,
    };
}
