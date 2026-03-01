
import { WordPressClient, Post, Page } from './src/wordpress';
import axios from 'axios';
import * as cheerio from 'cheerio';

async function check404s() {
    console.log("Starting 404 check...");
    const client = new WordPressClient();

    // Helper to fetch all items (same as before)
    async function fetchAll(fetcher: (page: number) => Promise<any[]>) {
        // Reuse fetch logic or just fetch 100 for now
        // Simplified for this script
        try {
            return await fetcher(100);
        } catch (e) {
            console.error("Error fetching items:", e);
            return [];
        }
    }

    try {
        const posts = await client.getPosts(100);
        const pages = await client.getPages(100);
        const allContent = [...posts, ...pages];

        console.log(`Analyzing ${allContent.length} items for broken links...`);

        const brokenLinks: { source: string, sourceId: number, link: string, error: string }[] = [];

        for (const item of allContent) {
            const contentConfig = item.content.rendered;
            if (!contentConfig) continue;

            const $ = cheerio.load(contentConfig);
            const links = $('a').map((i, el) => $(el).attr('href')).get();

            for (const link of links) {
                if (!link || link.startsWith('#') || link.startsWith('mailto:') || link.startsWith('tel:')) continue;

                // Only check internal links or all links? User asked about "404 links on the site". 
                // Let's check ALL links to be safe, but be gentle.
                try {
                    await axios.head(link, { timeout: 5000 });
                } catch (error: any) {
                    if (error.response && error.response.status === 404) {
                        console.log(`[404] Found broken link: ${link} in "${item.title.rendered}"`);
                        brokenLinks.push({
                            source: item.title.rendered,
                            sourceId: item.id,
                            link: link,
                            error: '404 Not Found'
                        });
                    } else if (error.code === 'ENOTFOUND') {
                        console.log(`[DNS] Domain not found: ${link} in "${item.title.rendered}"`);
                        brokenLinks.push({
                            source: item.title.rendered,
                            sourceId: item.id,
                            link: link,
                            error: 'DNS Error'
                        });
                    }
                    // Ignore other errors for now (timeouts, 403s etc) to reduce noise
                }
            }
        }

        console.log("\n--- BROKEN LINK REPORT ---");
        if (brokenLinks.length === 0) {
            console.log("No broken links found!");
        } else {
            console.table(brokenLinks);
        }

    } catch (error) {
        console.error("Fatal error:", error);
    }
}

check404s();
