/**
 * OPAI Team Hub Plugin — Actions for creating tasks, adding comments,
 * and updating status via Team Hub internal API.
 *
 * All operations are scoped to the OPAI Workers workspace by default.
 */

const TEAMHUB_API = process.env.TEAMHUB_API_URL || "http://127.0.0.1:8089";
const WORKERS_WORKSPACE_ID = process.env.WORKERS_WORKSPACE_ID || "d27944f3-8079-4e40-9e5d-c323d6cf7b0f";
const SYSTEM_USER_ID = "1c93c5fe-d304-40f2-9169-765d0d2b7638";

async function teamhubRequest(endpoint: string, method: string, body?: any): Promise<any> {
  try {
    const resp = await fetch(`${TEAMHUB_API}/api/internal${endpoint}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[opai-teamhub] ${method} ${endpoint} failed: ${resp.status} — ${text}`);
      return null;
    }

    return resp.json();
  } catch (err: any) {
    console.error(`[opai-teamhub] Error:`, err.message);
    return null;
  }
}

export const opaiTeamhubPlugin = {
  name: "opai-teamhub",
  description: "Create tasks, add comments, and manage items in OPAI Team Hub",

  actions: [
    {
      name: "CREATE_TASK",
      description: "Create a new task in the OPAI Workers workspace",
      similes: ["create task", "add task", "new task", "make task", "create ticket"],

      validate: async (_runtime: any, message: any) => {
        const text = message.content?.text || "";
        return /\b(create|add|make|new)\b.*\b(task|ticket|item)\b/i.test(text);
      },

      handler: async (runtime: any, message: any, _state: any, _options: any, callback: any) => {
        const text = message.content?.text || "";
        const character = runtime.character || {};
        const workspaceId = character.workspace_id || WORKERS_WORKSPACE_ID;

        // Extract title from message (after "create task" phrase)
        const titleMatch = text.match(/(?:create|add|make|new)\s+(?:a\s+)?(?:task|ticket|item)\s*(?:for|to|:)?\s*(.+)/i);
        const title = titleMatch?.[1]?.trim() || text;

        const result = await teamhubRequest("/create-item", "POST", {
          workspace_id: workspaceId,
          type: "task",
          title,
          status: "open",
          priority: "medium",
          description: `Created by Eliza agent: ${character.name || "unknown"}`,
          author_id: SYSTEM_USER_ID,
        });

        if (result) {
          await callback({
            text: `Task created: "${title}" in OPAI Workers workspace (ID: ${result.id || "created"}).`,
          });
        } else {
          await callback({
            text: `Failed to create task. The Team Hub might be unavailable.`,
          });
        }

        return true;
      },

      examples: [
        [
          { user: "user", content: { text: "Create a task for reviewing the API docs" } },
          { user: "agent", content: { text: "Task created: \"reviewing the API docs\" in OPAI Workers workspace." } },
        ],
      ],
    },

    {
      name: "ADD_COMMENT",
      description: "Add a comment to an existing Team Hub item",
      similes: ["add comment", "comment on", "note on"],

      validate: async (_runtime: any, message: any) => {
        const text = message.content?.text || "";
        return /\b(add|post)\b.*\b(comment|note)\b/i.test(text);
      },

      handler: async (runtime: any, message: any, _state: any, _options: any, callback: any) => {
        const text = message.content?.text || "";
        const character = runtime.character || {};

        // Extract item ID and comment content
        const match = text.match(/(?:comment|note)\s+(?:on|to)\s+([a-f0-9-]+)\s*[:\s]\s*(.+)/i);
        if (!match) {
          await callback({ text: "Please specify the item ID and comment. Format: 'add comment on <item-id>: <comment>'" });
          return true;
        }

        const [, itemId, content] = match;
        const result = await teamhubRequest("/add-comment", "POST", {
          item_id: itemId,
          content: `[${character.name || "Eliza Agent"}] ${content}`,
          author_id: SYSTEM_USER_ID,
        });

        if (result) {
          await callback({ text: `Comment added to item ${itemId}.` });
        } else {
          await callback({ text: `Failed to add comment. Check the item ID.` });
        }

        return true;
      },

      examples: [],
    },

    {
      name: "UPDATE_STATUS",
      description: "Update the status of a Team Hub item",
      similes: ["update status", "change status", "mark as", "set status"],

      validate: async (_runtime: any, message: any) => {
        const text = message.content?.text || "";
        return /\b(update|change|set|mark)\b.*\b(status|as)\b/i.test(text);
      },

      handler: async (_runtime: any, message: any, _state: any, _options: any, callback: any) => {
        const text = message.content?.text || "";
        const match = text.match(/(?:mark|update|change|set)\s+([a-f0-9-]+)\s+(?:as|to|status)\s+(\S+)/i);

        if (!match) {
          await callback({ text: "Format: 'update <item-id> status to <status>' — valid statuses: open, assigned, in-progress, review, done" });
          return true;
        }

        const [, itemId, status] = match;
        const validStatuses = ["open", "awaiting-human", "assigned", "in-progress", "blocked", "review", "done", "dismissed", "failed"];
        if (!validStatuses.includes(status)) {
          await callback({ text: `Invalid status "${status}". Valid: ${validStatuses.join(", ")}` });
          return true;
        }

        const result = await teamhubRequest("/update-item", "PATCH", {
          item_id: itemId,
          status,
        });

        if (result) {
          await callback({ text: `Item ${itemId} status updated to "${status}".` });
        } else {
          await callback({ text: `Failed to update status. Check the item ID.` });
        }

        return true;
      },

      examples: [],
    },
  ],
};

export default opaiTeamhubPlugin;
