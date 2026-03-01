
import { WordPressClient } from './src/wordpress'; // Adjust path as needed

async function findHobie() {
    const client = new WordPressClient();
    try {
        const posts = await client.getPosts(100);
        const hobie = posts.find(p => p.title.rendered.toLowerCase().includes('hobie mirage'));
        if (hobie) {
            console.log(`FOUND_HOBIE_ID:${hobie.id}`);
        } else {
            console.log("HOBIE_NOT_FOUND");
        }
    } catch (e) {
        console.error("Error finding post:", e);
    }
}

findHobie();
