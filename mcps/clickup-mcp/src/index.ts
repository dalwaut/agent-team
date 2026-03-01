/**
 * ClickUp MCP Server
 *
 * Provides tools for reading and writing ClickUp data:
 * spaces, folders, lists, tasks, comments, members, and search.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';

import { LIST_SPACES_TOOL, handleListSpaces } from './tools/list-spaces.js';
import { LIST_FOLDERS_TOOL, handleListFolders } from './tools/list-folders.js';
import { LIST_TASKS_TOOL, handleListTasks } from './tools/list-tasks.js';
import { GET_TASK_TOOL, handleGetTask } from './tools/get-task.js';
import { CREATE_TASK_TOOL, handleCreateTask } from './tools/create-task.js';
import { UPDATE_TASK_TOOL, handleUpdateTask } from './tools/update-task.js';
import { ADD_COMMENT_TOOL, handleAddComment } from './tools/add-comment.js';
import { SEARCH_TASKS_TOOL, handleSearchTasks } from './tools/search-tasks.js';
import { GET_MEMBERS_TOOL, handleGetMembers } from './tools/get-members.js';

// Load .env from server root
dotenv.config();

const server = new Server(
    {
        name: 'clickup-mcp',
        version: '1.0.0',
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// ── Tool Registration ─────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            LIST_SPACES_TOOL,
            LIST_FOLDERS_TOOL,
            LIST_TASKS_TOOL,
            GET_TASK_TOOL,
            CREATE_TASK_TOOL,
            UPDATE_TASK_TOOL,
            ADD_COMMENT_TOOL,
            SEARCH_TASKS_TOOL,
            GET_MEMBERS_TOOL,
        ],
    };
});

// ── Tool Execution ────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        let result: any;

        switch (name) {
            case 'clickup_list_spaces':
                result = await handleListSpaces(args as any);
                break;
            case 'clickup_list_folders':
                result = await handleListFolders(args as any);
                break;
            case 'clickup_list_tasks':
                result = await handleListTasks(args as any);
                break;
            case 'clickup_get_task':
                result = await handleGetTask(args as any);
                break;
            case 'clickup_create_task':
                result = await handleCreateTask(args as any);
                break;
            case 'clickup_update_task':
                result = await handleUpdateTask(args as any);
                break;
            case 'clickup_add_comment':
                result = await handleAddComment(args as any);
                break;
            case 'clickup_search_tasks':
                result = await handleSearchTasks(args as any);
                break;
            case 'clickup_get_members':
                result = await handleGetMembers();
                break;
            default:
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ error: `Unknown tool: ${name}` }),
                    }],
                    isError: true,
                };
        }

        if (result?.error) {
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify(result, null, 2),
                }],
                isError: true,
            };
        }

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify(result, null, 2),
            }],
        };
    } catch (error: any) {
        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    error: error.message || 'Unknown error',
                }, null, 2),
            }],
            isError: true,
        };
    }
});

// ── Startup ───────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('ClickUp MCP Server running on stdio');
    console.error('Tools: list_spaces, list_folders, list_tasks, get_task, create_task, update_task, add_comment, search_tasks, get_members');
}

main().catch((error) => {
    console.error('Fatal error starting MCP server:', error);
    process.exit(1);
});
