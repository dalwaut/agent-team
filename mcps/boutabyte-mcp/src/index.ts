/**
 * Boutabyte MCP Server
 * 
 * An MCP server that enables the Antigravity agent to publish projects
 * directly to the Boutabyte platform (boutabyte.com).
 * 
 * Phase 1: publish_webapp + list_projects
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';

import { PUBLISH_WEBAPP_TOOL, handlePublishWebapp } from './tools/publish-webapp.js';
import { LIST_PROJECTS_TOOL, handleListProjects } from './tools/list-projects.js';

// Load .env from server root
dotenv.config();

// Create MCP Server
const server = new Server(
    {
        name: 'boutabyte-mcp',
        version: '1.0.0',
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// ============================================
// Tool Registration
// ============================================

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            PUBLISH_WEBAPP_TOOL,
            LIST_PROJECTS_TOOL,
        ],
    };
});

// ============================================
// Tool Execution
// ============================================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        let result: any;

        switch (name) {
            case 'publish_webapp':
                result = await handlePublishWebapp(args as any);
                break;

            case 'list_projects':
                result = await handleListProjects(args as any);
                break;

            default:
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify({ error: `Unknown tool: ${name}` }),
                        },
                    ],
                    isError: true,
                };
        }

        // Check if result indicates an error
        if (result?.error) {
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(result, null, 2),
                    },
                ],
                isError: true,
            };
        }

        return {
            content: [
                {
                    type: 'text' as const,
                    text: JSON.stringify(result, null, 2),
                },
            ],
        };
    } catch (error: any) {
        return {
            content: [
                {
                    type: 'text' as const,
                    text: JSON.stringify({
                        error: error.message || 'Unknown error occurred',
                        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
                    }, null, 2),
                },
            ],
            isError: true,
        };
    }
});

// ============================================
// Server Startup
// ============================================

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('🚀 Boutabyte MCP Server running on stdio');
    console.error(`   Tools: publish_webapp, list_projects`);
}

main().catch((error) => {
    console.error('Fatal error starting MCP server:', error);
    process.exit(1);
});
