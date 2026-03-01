/**
 * list_folders — List folders and their lists in a ClickUp space.
 */
import { cuGet } from '../clickup-api.js';

export const LIST_FOLDERS_TOOL = {
    name: 'clickup_list_folders',
    description: 'List all folders (and their lists) in a ClickUp space. Also returns folderless lists.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            space_id: {
                type: 'string',
                description: 'The ClickUp space ID',
            },
        },
        required: ['space_id'],
    },
};

export async function handleListFolders(args: { space_id: string }) {
    // Foldered lists
    const foldersData = await cuGet(`/space/${args.space_id}/folder`);
    const folders = (foldersData.folders || []).map((f: any) => ({
        id: f.id,
        name: f.name,
        lists: (f.lists || []).map((l: any) => ({
            id: l.id,
            name: l.name,
            task_count: l.task_count,
        })),
    }));

    // Folderless lists
    const listsData = await cuGet(`/space/${args.space_id}/list`);
    const folderless_lists = (listsData.lists || []).map((l: any) => ({
        id: l.id,
        name: l.name,
        task_count: l.task_count,
    }));

    return { folders, folderless_lists };
}
