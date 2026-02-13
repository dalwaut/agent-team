"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WordPressClient = void 0;
const axios_1 = __importDefault(require("axios"));
const dotenv = __importStar(require("dotenv"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
dotenv.config();
class WordPressClient {
    client;
    constructor() {
        const baseURL = process.env.WORDPRESS_URL;
        const username = process.env.WORDPRESS_USERNAME;
        const password = process.env.WORDPRESS_APPLICATION_PASSWORD;
        if (!baseURL || !username || !password) {
            throw new Error('Missing WordPress credentials in .env file');
        }
        this.client = axios_1.default.create({
            baseURL: `${baseURL}/wp-json/wp/v2`,
            auth: {
                username,
                password,
            },
        });
    }
    async getPosts(perPage = 10) {
        const response = await this.client.get('/posts', {
            params: { per_page: perPage },
        });
        return response.data;
    }
    async getPost(id) {
        const response = await this.client.get(`/posts/${id}`);
        return response.data;
    }
    async createPost(title, content, status = 'draft') {
        const response = await this.client.post('/posts', {
            title,
            content,
            status,
        });
        return response.data;
    }
    async updatePost(id, data) {
        const response = await this.client.post(`/posts/${id}`, data);
        return response.data;
    }
    async getPages(perPage = 10) {
        const response = await this.client.get('/pages', {
            params: { per_page: perPage },
        });
        return response.data;
    }
    async uploadMedia(filePath) {
        try {
            const fileExists = fs.existsSync(filePath);
            if (!fileExists) {
                throw new Error(`File not found at path: ${filePath}`);
            }
            const fileName = path.basename(filePath);
            const fileBuffer = fs.readFileSync(filePath);
            // Required headers for WP REST API media upload
            const headers = {
                'Content-Disposition': `attachment; filename="${fileName}"`,
                'Content-Type': 'image/jpeg' // This might need dynamic detection
            };
            const response = await this.client.post('/media', fileBuffer, {
                headers
            });
            return response.data;
        }
        catch (error) {
            console.error("Upload error details:", error.response ? error.response.data : error.message);
            throw error;
        }
    }
    async deletePost(id) {
        await this.client.delete(`/posts/${id}`, {
            params: { force: true } // force=true bypasses trash and deletes permanently
        });
    }
}
exports.WordPressClient = WordPressClient;
