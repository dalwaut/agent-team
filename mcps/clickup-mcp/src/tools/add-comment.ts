/**
 * add_comment — Add a comment to a ClickUp task.
 */
import { cuPost } from '../clickup-api.js';

export const ADD_COMMENT_TOOL = {
    name: 'clickup_add_comment',
    description: 'Add a comment to a ClickUp task.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            task_id: {
                type: 'string',
                description: 'The ClickUp task ID',
            },
            comment_text: {
                type: 'string',
                description: 'The comment text to add',
            },
        },
        required: ['task_id', 'comment_text'],
    },
};

export async function handleAddComment(args: { task_id: string; comment_text: string }) {
    const result = await cuPost(`/task/${args.task_id}/comment`, {
        comment_text: args.comment_text,
    });
    return { success: true, comment_id: result.id };
}
