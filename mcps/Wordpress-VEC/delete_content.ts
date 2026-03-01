
import { WordPressClient } from './src/wordpress';

async function deleteContent() {
    const client = new WordPressClient();
    const idsToDelete = [27881, 26975]; // Duplicate post ID and Hobie Mirage ID

    // Add Hobie ID if found (will be passed as arg or hardcoded after finding)
    // For now, this script just deletes the known duplicate.

    for (const id of idsToDelete) {
        console.log(`Deleting post ${id}...`);
        try {
            await client.deletePost(id);
            console.log(`Deleted post ${id}.`);
        } catch (e) {
            console.error(`Error deleting post ${id}:`, e);
        }
    }
}

deleteContent();
