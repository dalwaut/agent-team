import axios, { AxiosInstance } from 'axios';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

export interface Post {
    id: number;
    date: string;
    slug: string;
    status: string;
    title: { rendered: string };
    content: { rendered: string };
    excerpt: { rendered: string };
    link: string;
}

export interface Page {
    id: number;
    date: string;
    slug: string;
    status: string;
    title: { rendered: string };
    content: { rendered: string; protected: boolean };
    link: string;
    parent: number;
    menu_order: number;
    template: string;
}

export interface Media {
    id: number;
    date: string;
    slug: string;
    status: string;
    title: { rendered: string };
    source_url: string;
    mime_type: string;
    media_details?: {
        width: number;
        height: number;
        file: string;
    };
}

export interface Category {
    id: number;
    name: string;
    slug: string;
    count: number;
    parent: number;
    description: string;
}

export interface Product {
    id: number;
    name: string;
    slug: string;
    status: string;
    type: string;
    description: string;
    short_description: string;
    price: string;
    regular_price: string;
    sale_price: string;
    categories: { id: number; name: string; slug: string }[];
    images: { id: number; src: string; alt: string }[];
}

export interface SiteInfo {
    name: string;
    description: string;
    url: string;
    home: string;
    gmt_offset: number;
    timezone_string: string;
}

const MIME_TYPES: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
};

export class WordPressClient {
    private client: AxiosInstance;
    private wooClient: AxiosInstance | null = null;
    private baseURL: string;

    constructor() {
        const baseURL = process.env.WORDPRESS_URL;
        const username = process.env.WORDPRESS_USERNAME;
        const password = process.env.WORDPRESS_APPLICATION_PASSWORD;

        if (!baseURL || !username || !password) {
            throw new Error(
                'Missing WordPress credentials. Set WORDPRESS_URL, WORDPRESS_USERNAME, and WORDPRESS_APPLICATION_PASSWORD in .env'
            );
        }

        this.baseURL = baseURL;

        this.client = axios.create({
            baseURL: `${baseURL}/wp-json/wp/v2`,
            auth: { username, password },
            timeout: 30000,
        });

        // WooCommerce uses separate API keys (optional)
        const wooKey = process.env.WOO_CONSUMER_KEY;
        const wooSecret = process.env.WOO_CONSUMER_SECRET;
        if (wooKey && wooSecret) {
            this.wooClient = axios.create({
                baseURL: `${baseURL}/wp-json/wc/v3`,
                auth: { username: wooKey, password: wooSecret },
                timeout: 30000,
            });
        }
    }

    // ── Posts ──────────────────────────────────────────────

    async getPosts(perPage: number = 10): Promise<Post[]> {
        const response = await this.client.get('/posts', {
            params: { per_page: perPage },
        });
        return response.data;
    }

    async getPost(id: number): Promise<Post> {
        const response = await this.client.get(`/posts/${id}`);
        return response.data;
    }

    async createPost(title: string, content: string, status: string = 'draft'): Promise<Post> {
        const response = await this.client.post('/posts', { title, content, status });
        return response.data;
    }

    async updatePost(id: number, data: Partial<{ title: string; content: string; status: string }>): Promise<Post> {
        const response = await this.client.post(`/posts/${id}`, data);
        return response.data;
    }

    async deletePost(id: number): Promise<void> {
        await this.client.delete(`/posts/${id}`, { params: { force: true } });
    }

    // ── Pages ─────────────────────────────────────────────

    async getPages(perPage: number = 10): Promise<Page[]> {
        const response = await this.client.get('/pages', {
            params: { per_page: perPage },
        });
        return response.data;
    }

    async getPage(id: number): Promise<Page> {
        const response = await this.client.get(`/pages/${id}`, {
            params: { context: 'edit' }, // returns raw content (Fusion Builder shortcode)
        });
        return response.data;
    }

    async createPage(
        title: string,
        content: string,
        status: string = 'draft',
        parent?: number,
        template?: string
    ): Promise<Page> {
        const data: Record<string, any> = { title, content, status };
        if (parent !== undefined) data.parent = parent;
        if (template) data.template = template;
        const response = await this.client.post('/pages', data);
        return response.data;
    }

    async updatePage(
        id: number,
        data: Partial<{ title: string; content: string; status: string; parent: number; template: string }>
    ): Promise<Page> {
        const response = await this.client.post(`/pages/${id}`, data);
        return response.data;
    }

    async deletePage(id: number): Promise<void> {
        await this.client.delete(`/pages/${id}`, { params: { force: true } });
    }

    // ── Media ─────────────────────────────────────────────

    async getMedia(perPage: number = 10): Promise<Media[]> {
        const response = await this.client.get('/media', {
            params: { per_page: perPage },
        });
        return response.data;
    }

    async uploadMedia(filePath: string, altText?: string): Promise<Media> {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        const fileName = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
        const fileBuffer = fs.readFileSync(filePath);

        const response = await this.client.post('/media', fileBuffer, {
            headers: {
                'Content-Disposition': `attachment; filename="${fileName}"`,
                'Content-Type': mimeType,
            },
        });

        // Set alt text if provided
        if (altText && response.data.id) {
            await this.client.post(`/media/${response.data.id}`, { alt_text: altText });
        }

        return response.data;
    }

    // ── Categories ────────────────────────────────────────

    async getCategories(perPage: number = 100): Promise<Category[]> {
        const response = await this.client.get('/categories', {
            params: { per_page: perPage },
        });
        return response.data;
    }

    // ── WooCommerce Products ──────────────────────────────

    private requireWoo(): AxiosInstance {
        if (!this.wooClient) {
            throw new Error(
                'WooCommerce not configured. Set WOO_CONSUMER_KEY and WOO_CONSUMER_SECRET in .env'
            );
        }
        return this.wooClient;
    }

    async getProducts(perPage: number = 10): Promise<Product[]> {
        const woo = this.requireWoo();
        const response = await woo.get('/products', {
            params: { per_page: perPage },
        });
        return response.data;
    }

    async createProduct(data: {
        name: string;
        type?: string;
        regular_price?: string;
        description?: string;
        short_description?: string;
        categories?: { id: number }[];
        images?: { src: string; alt?: string }[];
        status?: string;
    }): Promise<Product> {
        const woo = this.requireWoo();
        const response = await woo.post('/products', data);
        return response.data;
    }

    async updateProduct(
        id: number,
        data: Partial<{
            name: string;
            regular_price: string;
            sale_price: string;
            description: string;
            short_description: string;
            status: string;
            categories: { id: number }[];
            images: { src: string; alt?: string }[];
        }>
    ): Promise<Product> {
        const woo = this.requireWoo();
        const response = await woo.put(`/products/${id}`, data);
        return response.data;
    }

    // ── Site Info ─────────────────────────────────────────

    async getSiteInfo(): Promise<SiteInfo> {
        // Use the base WP REST API root (not /wp/v2/)
        const response = await axios.get(`${this.baseURL}/wp-json`, {
            auth: this.client.defaults.auth as { username: string; password: string },
            timeout: 15000,
        });
        return response.data;
    }
}
