import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WordPressClient } from './wordpress.js';

const server = new Server(
    {
        name: "wordpress-vec",
        version: "2.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

const wpClient = new WordPressClient();

// ── Tool Definitions ──────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            // Posts
            {
                name: "list_posts",
                description: "List recent WordPress posts",
                inputSchema: {
                    type: "object",
                    properties: {
                        per_page: { type: "number", description: "Number of posts to return (default 10)" },
                    },
                },
            },
            {
                name: "get_post",
                description: "Get a specific WordPress post by ID",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "number", description: "ID of the post to retrieve" },
                    },
                    required: ["id"],
                },
            },
            {
                name: "create_post",
                description: "Create a new WordPress post",
                inputSchema: {
                    type: "object",
                    properties: {
                        title: { type: "string", description: "Title of the post" },
                        content: { type: "string", description: "Content of the post (HTML or Fusion Builder shortcode)" },
                        status: { type: "string", enum: ["publish", "future", "draft", "pending", "private"], description: "Status (default: draft)" },
                    },
                    required: ["title", "content"],
                },
            },
            {
                name: "update_post",
                description: "Update an existing WordPress post",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "number", description: "ID of the post to update" },
                        title: { type: "string", description: "New title" },
                        content: { type: "string", description: "New content (HTML or Fusion Builder shortcode)" },
                        status: { type: "string", enum: ["publish", "future", "draft", "pending", "private"], description: "New status" },
                    },
                    required: ["id"],
                },
            },
            {
                name: "delete_post",
                description: "Delete a WordPress post permanently",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "number", description: "ID of the post to delete" },
                    },
                    required: ["id"],
                },
            },

            // Pages
            {
                name: "list_pages",
                description: "List WordPress pages",
                inputSchema: {
                    type: "object",
                    properties: {
                        per_page: { type: "number", description: "Number of pages to return (default 10)" },
                    },
                },
            },
            {
                name: "get_page",
                description: "Get a specific WordPress page by ID. Returns raw content (Fusion Builder shortcode) via edit context.",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "number", description: "ID of the page to retrieve" },
                    },
                    required: ["id"],
                },
            },
            {
                name: "create_page",
                description: "Create a new WordPress page with Fusion Builder content",
                inputSchema: {
                    type: "object",
                    properties: {
                        title: { type: "string", description: "Page title" },
                        content: { type: "string", description: "Page content (Fusion Builder shortcode)" },
                        status: { type: "string", enum: ["publish", "draft", "pending", "private"], description: "Status (default: draft)" },
                        parent: { type: "number", description: "Parent page ID (for child pages)" },
                        template: { type: "string", description: "Page template file (e.g. '100-width.php')" },
                    },
                    required: ["title", "content"],
                },
            },
            {
                name: "update_page",
                description: "Update an existing WordPress page content (Fusion Builder shortcode)",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "number", description: "ID of the page to update" },
                        title: { type: "string", description: "New title" },
                        content: { type: "string", description: "New content (Fusion Builder shortcode)" },
                        status: { type: "string", enum: ["publish", "draft", "pending", "private"], description: "New status" },
                        template: { type: "string", description: "Page template file" },
                    },
                    required: ["id"],
                },
            },

            // Media
            {
                name: "list_media",
                description: "List media items in the WordPress media library",
                inputSchema: {
                    type: "object",
                    properties: {
                        per_page: { type: "number", description: "Number of items to return (default 10)" },
                    },
                },
            },
            {
                name: "upload_media",
                description: "Upload an image or file to the WordPress media library",
                inputSchema: {
                    type: "object",
                    properties: {
                        file_path: { type: "string", description: "Absolute path to the file to upload" },
                        alt_text: { type: "string", description: "Alt text for accessibility" },
                    },
                    required: ["file_path"],
                },
            },

            // Categories
            {
                name: "list_categories",
                description: "List all post/product categories",
                inputSchema: {
                    type: "object",
                    properties: {
                        per_page: { type: "number", description: "Number of categories to return (default 100)" },
                    },
                },
            },

            // WooCommerce Products
            {
                name: "list_products",
                description: "List WooCommerce products (requires WOO_CONSUMER_KEY and WOO_CONSUMER_SECRET)",
                inputSchema: {
                    type: "object",
                    properties: {
                        per_page: { type: "number", description: "Number of products to return (default 10)" },
                    },
                },
            },
            {
                name: "create_product",
                description: "Create a new WooCommerce product",
                inputSchema: {
                    type: "object",
                    properties: {
                        name: { type: "string", description: "Product name" },
                        type: { type: "string", enum: ["simple", "grouped", "external", "variable"], description: "Product type (default: simple)" },
                        regular_price: { type: "string", description: "Regular price (e.g. '29.99')" },
                        description: { type: "string", description: "Full product description (HTML)" },
                        short_description: { type: "string", description: "Short description (HTML)" },
                        status: { type: "string", enum: ["publish", "draft", "pending", "private"], description: "Status (default: draft)" },
                    },
                    required: ["name"],
                },
            },
            {
                name: "update_product",
                description: "Update an existing WooCommerce product",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "number", description: "Product ID" },
                        name: { type: "string", description: "Product name" },
                        regular_price: { type: "string", description: "Regular price" },
                        sale_price: { type: "string", description: "Sale price" },
                        description: { type: "string", description: "Full description" },
                        short_description: { type: "string", description: "Short description" },
                        status: { type: "string", enum: ["publish", "draft", "pending", "private"], description: "Status" },
                    },
                    required: ["id"],
                },
            },

            // Site Info
            {
                name: "get_site_info",
                description: "Get WordPress site metadata (name, URL, timezone). Use to verify connection.",
                inputSchema: {
                    type: "object",
                    properties: {},
                },
            },
        ],
    };
});

// ── Tool Handlers ─────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            // Posts
            case "list_posts": {
                const posts = await wpClient.getPosts(Number(args?.per_page) || 10);
                return { content: [{ type: "text", text: JSON.stringify(posts, null, 2) }] };
            }
            case "get_post": {
                const post = await wpClient.getPost(Number(args?.id));
                return { content: [{ type: "text", text: JSON.stringify(post, null, 2) }] };
            }
            case "create_post": {
                const post = await wpClient.createPost(
                    String(args?.title),
                    String(args?.content),
                    String(args?.status || "draft")
                );
                return { content: [{ type: "text", text: `Post created — ID: ${post.id}, slug: ${post.slug}` }] };
            }
            case "update_post": {
                const updateData: any = {};
                if (args?.title) updateData.title = String(args.title);
                if (args?.content) updateData.content = String(args.content);
                if (args?.status) updateData.status = String(args.status);
                const post = await wpClient.updatePost(Number(args?.id), updateData);
                return { content: [{ type: "text", text: `Post updated — ID: ${post.id}` }] };
            }
            case "delete_post": {
                await wpClient.deletePost(Number(args?.id));
                return { content: [{ type: "text", text: `Post ${args?.id} deleted` }] };
            }

            // Pages
            case "list_pages": {
                const pages = await wpClient.getPages(Number(args?.per_page) || 10);
                return { content: [{ type: "text", text: JSON.stringify(pages, null, 2) }] };
            }
            case "get_page": {
                const page = await wpClient.getPage(Number(args?.id));
                return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }] };
            }
            case "create_page": {
                const page = await wpClient.createPage(
                    String(args?.title),
                    String(args?.content),
                    String(args?.status || "draft"),
                    args?.parent ? Number(args.parent) : undefined,
                    args?.template ? String(args.template) : undefined
                );
                return { content: [{ type: "text", text: `Page created — ID: ${page.id}, slug: ${page.slug}` }] };
            }
            case "update_page": {
                const data: any = {};
                if (args?.title) data.title = String(args.title);
                if (args?.content) data.content = String(args.content);
                if (args?.status) data.status = String(args.status);
                if (args?.template) data.template = String(args.template);
                const page = await wpClient.updatePage(Number(args?.id), data);
                return { content: [{ type: "text", text: `Page updated — ID: ${page.id}` }] };
            }

            // Media
            case "list_media": {
                const media = await wpClient.getMedia(Number(args?.per_page) || 10);
                return { content: [{ type: "text", text: JSON.stringify(media, null, 2) }] };
            }
            case "upload_media": {
                const media = await wpClient.uploadMedia(
                    String(args?.file_path),
                    args?.alt_text ? String(args.alt_text) : undefined
                );
                return { content: [{ type: "text", text: `Media uploaded — ID: ${media.id}, URL: ${media.source_url}` }] };
            }

            // Categories
            case "list_categories": {
                const cats = await wpClient.getCategories(Number(args?.per_page) || 100);
                return { content: [{ type: "text", text: JSON.stringify(cats, null, 2) }] };
            }

            // WooCommerce Products
            case "list_products": {
                const products = await wpClient.getProducts(Number(args?.per_page) || 10);
                return { content: [{ type: "text", text: JSON.stringify(products, null, 2) }] };
            }
            case "create_product": {
                const productData: any = { name: String(args?.name) };
                if (args?.type) productData.type = String(args.type);
                if (args?.regular_price) productData.regular_price = String(args.regular_price);
                if (args?.description) productData.description = String(args.description);
                if (args?.short_description) productData.short_description = String(args.short_description);
                if (args?.status) productData.status = String(args.status);
                const product = await wpClient.createProduct(productData);
                return { content: [{ type: "text", text: `Product created — ID: ${product.id}, slug: ${product.slug}` }] };
            }
            case "update_product": {
                const data: any = {};
                if (args?.name) data.name = String(args.name);
                if (args?.regular_price) data.regular_price = String(args.regular_price);
                if (args?.sale_price) data.sale_price = String(args.sale_price);
                if (args?.description) data.description = String(args.description);
                if (args?.short_description) data.short_description = String(args.short_description);
                if (args?.status) data.status = String(args.status);
                const product = await wpClient.updateProduct(Number(args?.id), data);
                return { content: [{ type: "text", text: `Product updated — ID: ${product.id}` }] };
            }

            // Site Info
            case "get_site_info": {
                const info = await wpClient.getSiteInfo();
                return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
            }

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    } catch (error: any) {
        const status = error.response?.status ? ` (HTTP ${error.response.status})` : '';
        const detail = error.response?.data?.message || error.message;
        return {
            content: [{ type: "text", text: `Error${status}: ${detail}` }],
            isError: true,
        };
    }
});

async function run() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("WordPress MCP Server v2.0.0 running on stdio");
}

run().catch((error) => {
    console.error("Fatal error running server:", error);
    process.exit(1);
});
