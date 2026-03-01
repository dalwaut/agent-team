"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const zod_1 = require("zod");
const wordpress_js_1 = require("./wordpress.js");
const server = new index_js_1.Server({
    name: "wordpress-vec",
    version: "1.0.0",
}, {
    capabilities: {
        tools: {},
    },
});
const wpClient = new wordpress_js_1.WordPressClient();
server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "list_posts",
                description: "List recent WordPress posts",
                inputSchema: zodToJsonSchema(zod_1.z.object({
                    per_page: zod_1.z.number().optional().default(10).describe("Number of posts to return"),
                })),
            },
            {
                name: "get_post",
                description: "Get a specific WordPress post by ID",
                inputSchema: zodToJsonSchema(zod_1.z.object({
                    id: zod_1.z.number().describe("ID of the post to retrieve"),
                })),
            },
            {
                name: "create_post",
                description: "Create a new WordPress post",
                inputSchema: zodToJsonSchema(zod_1.z.object({
                    title: zod_1.z.string().describe("Title of the post"),
                    content: zod_1.z.string().describe("Content of the post"),
                    status: zod_1.z.enum(["publish", "future", "draft", "pending", "private"]).optional().default("draft").describe("Status of the post"),
                })),
            },
            {
                name: "update_post",
                description: "Update an existing WordPress post",
                inputSchema: zodToJsonSchema(zod_1.z.object({
                    id: zod_1.z.number().describe("ID of the post to update"),
                    title: zod_1.z.string().optional().describe("New title of the post"),
                    content: zod_1.z.string().optional().describe("New content of the post"),
                    status: zod_1.z.enum(["publish", "future", "draft", "pending", "private"]).optional().describe("New status of the post"),
                })),
            },
            {
                name: "delete_post",
                description: "Delete a WordPress post",
                inputSchema: zodToJsonSchema(zod_1.z.object({
                    id: zod_1.z.number().describe("ID of the post to delete"),
                })),
            },
            {
                name: "list_pages",
                description: "List WordPress pages",
                inputSchema: zodToJsonSchema(zod_1.z.object({
                    per_page: zod_1.z.number().optional().default(10).describe("Number of pages to return"),
                })),
            },
            // simple upload implementation for now, might need more robust file handling
            // {
            //   name: "upload_media",
            //   description: "Upload a media file to WordPress",
            //   inputSchema: zodToJsonSchema(z.object({
            //     filePath: z.string().describe("Absolute path to the file to upload"),
            //   })),
            // },
        ],
    };
});
// Helper to convert Zod schema to JSON schema
function zodToJsonSchema(schema) {
    // basic implementation, in a real app use zod-to-json-schema package
    // But for MCP SDK, we can often just pass the shape if we construct it carefully,
    // or use a library. For simplicity here:
    // ... actually the SDK expects specific JSON schema format.
    // Let's use a simpler approach for now to avoid extra dependencies if possible,
    // or just rely on 'zod-to-json-schema' if I installed it? I didn't.
    // I'll manually construct the schema for now to avoid the extra dep.
    // A hacky manual conversion for the specific schemas we used above:
    if (schema instanceof zod_1.z.ZodObject) {
        const shape = schema.shape;
        const properties = {};
        const required = [];
        for (const key in shape) {
            const field = shape[key];
            let description = field.description;
            let type = 'string'; // default
            if (field instanceof zod_1.z.ZodNumber || (field._def && field._def.typeName === 'ZodNumber'))
                type = 'number';
            if (field instanceof zod_1.z.ZodString || (field._def && field._def.typeName === 'ZodString'))
                type = 'string';
            if (field instanceof zod_1.z.ZodEnum || (field._def && field._def.typeName === 'ZodEnum'))
                type = 'string'; // enums are strings
            // Handle optional
            if (!field.isOptional()) {
                required.push(key);
            }
            properties[key] = { type, description };
            if (field instanceof zod_1.z.ZodEnum) {
                properties[key].enum = field._def.values;
            }
        }
        return {
            type: 'object',
            properties,
            required: required.length > 0 ? required : undefined
        };
    }
    return {};
}
server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        switch (name) {
            case "list_posts": {
                const perPage = Number(args?.per_page) || 10;
                const posts = await wpClient.getPosts(perPage);
                return {
                    content: [{ type: "text", text: JSON.stringify(posts, null, 2) }],
                };
            }
            case "get_post": {
                const id = Number(args?.id);
                const post = await wpClient.getPost(id);
                return {
                    content: [{ type: "text", text: JSON.stringify(post, null, 2) }],
                };
            }
            case "create_post": {
                const title = String(args?.title);
                const content = String(args?.content);
                const status = String(args?.status || "draft");
                const post = await wpClient.createPost(title, content, status);
                return {
                    content: [{ type: "text", text: `Post created with ID: ${post.id}` }],
                };
            }
            case "update_post": {
                const id = Number(args?.id);
                const updateData = {};
                if (args?.title)
                    updateData.title = String(args.title);
                if (args?.content)
                    updateData.content = String(args.content);
                if (args?.status)
                    updateData.status = String(args.status);
                const post = await wpClient.updatePost(id, updateData);
                return {
                    content: [{ type: "text", text: `Post updated: ${JSON.stringify(post.title)}` }]
                };
            }
            case "delete_post": {
                const id = Number(args?.id);
                await wpClient.deletePost(id);
                return {
                    content: [{ type: "text", text: `Post deleted: ${id}` }],
                };
            }
            case "list_pages": {
                const perPage = Number(args?.per_page) || 10;
                const pages = await wpClient.getPages(perPage);
                return {
                    content: [{ type: "text", text: JSON.stringify(pages, null, 2) }],
                };
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
    catch (error) {
        return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
        };
    }
});
async function run() {
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    console.error("WordPress MCP Server running on stdio");
}
run().catch((error) => {
    console.error("Fatal error running server:", error);
    process.exit(1);
});
