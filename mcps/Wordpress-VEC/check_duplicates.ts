
import { WordPressClient, Post, Page } from './src/wordpress'; // Adjust path as needed
import * as fs from 'fs';
import * as path from 'path';

async function checkDuplicates() {
    console.log("Starting duplicate check...");
    const client = new WordPressClient();

    // Helper to fetch all items (pagination handling)
    async function fetchAll(fetcher: (page: number) => Promise<any[]>, typeName: string) {
        let allItems: any[] = [];
        let page = 1;
        while (true) {
            console.log(`Fetching ${typeName} page ${page}...`);
            try {
                // The client methods only take per_page right now, not page number.
                // We need to modify the client or just fetch a large number for now.
                // Let's modify the client on the fly or just assume < 100 items for this MVP.
                // Actually, the client implementation was simple:
                // async getPosts(perPage: number = 10): Promise<Post[]> {
                //   const response = await this.client.get('/posts', { params: { per_page: perPage } });
                //   return response.data;
                // }
                // It doesn't support pagination properly yet! 
                // I will fetch 100 items for now, which is the max per page usually.

                // Hack: direct access to client to add page param if needed, 
                // OR just call the client method with a large per_page and hope it's enough for MVP.
                // Let's try to fetch 100.
                const items = await fetcher(100);
                if (items.length === 0) break;
                allItems = allItems.concat(items);
                // Since our client doesn't support paging offset yet, we break after one big fetch.
                // To do this properly I should update the client.
                break;
            } catch (e) {
                console.error(`Error fetching page ${page}:`, e);
                break;
            }
        }
        return allItems;
    }

    try {
        const posts = await client.getPosts(100);
        const pages = await client.getPages(100);

        console.log(`Fetched ${posts.length} posts and ${pages.length} pages.`);

        const analyze = (items: (Post | Page)[], type: string) => {
            const seenTitles = new Map<string, number[]>();
            const seenSlugs = new Map<string, number[]>();

            items.forEach(item => {
                const title = item.title.rendered.trim();
                const slug = item.slug;

                if (!seenTitles.has(title)) seenTitles.set(title, []);
                seenTitles.get(title)?.push(item.id);

                if (!seenSlugs.has(slug)) seenSlugs.set(slug, []);
                seenSlugs.get(slug)?.push(item.id);
            });

            console.log(`\n--- ${type} Duplicates by TITLE ---`);
            let foundTitleDupes = false;
            seenTitles.forEach((ids, title) => {
                if (ids.length > 1) {
                    console.log(`"${title}": IDs ${ids.join(', ')}`);
                    foundTitleDupes = true;
                }
            });
            if (!foundTitleDupes) console.log("None found.");

            console.log(`\n--- ${type} Duplicates by SLUG ---`);
            let foundSlugDupes = false;
            seenSlugs.forEach((ids, slug) => {
                if (ids.length > 1) {
                    console.log(`"${slug}": IDs ${ids.join(', ')}`);
                    foundSlugDupes = true;
                }
            });
            if (!foundSlugDupes) console.log("None found.");
        };

        analyze(posts, 'POSTS');
        analyze(pages, 'PAGES');

    } catch (error) {
        console.error("Fatal error during check:", error);
    }
}

checkDuplicates();
