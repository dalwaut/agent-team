/**
 * OPAI Knowledge Plugin — Provider that fetches brain nodes from a knowledge branch.
 *
 * Reads nodes assigned to the agent's knowledge branch via the Brain API,
 * caches them, refreshes every 15 minutes, and hard-filters by info_layer.
 */

const BRAIN_API = process.env.BRAIN_API_URL || "http://127.0.0.1:8101";
const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

interface KnowledgeNode {
  id: string;
  title: string;
  content: string;
  type: string;
  tags: string[];
  info_layer: string;
  metadata: Record<string, any>;
}

interface KnowledgeCache {
  nodes: KnowledgeNode[];
  lastRefresh: number;
  branchId: string;
}

const caches = new Map<string, KnowledgeCache>();

async function fetchBranchNodes(branchId: string, agentInfoLayer: string): Promise<KnowledgeNode[]> {
  try {
    // Fetch nodes from the Supabase-backed knowledge branch
    const url = `${BRAIN_API}/api/nodes?tag=branch:${branchId}&limit=200`;
    const resp = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        // Internal API — no auth needed on localhost
      },
    });

    if (!resp.ok) {
      console.warn(`[opai-knowledge] Failed to fetch branch ${branchId}: ${resp.status}`);
      return [];
    }

    const data = await resp.json();
    const nodes: KnowledgeNode[] = (data.nodes || data || []);

    // Hard filter: NEVER return internal nodes to non-internal agents
    if (agentInfoLayer !== "internal") {
      return nodes.filter((n: any) => n.info_layer !== "internal");
    }

    return nodes;
  } catch (err: any) {
    console.error(`[opai-knowledge] Error fetching nodes:`, err.message);
    return [];
  }
}

function getOrRefreshCache(branchId: string, agentInfoLayer: string): KnowledgeNode[] | null {
  const cached = caches.get(branchId);
  if (cached && Date.now() - cached.lastRefresh < REFRESH_INTERVAL_MS) {
    return cached.nodes;
  }
  return null; // Needs refresh
}

/**
 * Knowledge Provider for ElizaOS.
 * Attaches to the agent's runtime and provides context from Brain knowledge branches.
 */
export const opaiKnowledgePlugin = {
  name: "opai-knowledge",
  description: "Provides knowledge from OPAI Brain knowledge branches",

  // Provider: called by ElizaOS when building agent context
  providers: [
    {
      name: "opai-knowledge-provider",
      description: "Fetches knowledge from the agent's assigned Brain branch",

      async get(runtime: any, _message: any, _state: any): Promise<string> {
        const character = runtime.character || {};
        const branchId = character.knowledge_branch || character.settings?.knowledgeBranch;
        const infoLayer = character.info_layer || "public";

        if (!branchId) return "";

        // Check cache
        let nodes = getOrRefreshCache(branchId, infoLayer);

        if (!nodes) {
          // Refresh from API
          nodes = await fetchBranchNodes(branchId, infoLayer);
          caches.set(branchId, {
            nodes,
            lastRefresh: Date.now(),
            branchId,
          });
        }

        if (nodes.length === 0) return "";

        // Format knowledge for agent context
        const formatted = nodes
          .map((n) => `## ${n.title}\n${n.content}`)
          .join("\n\n---\n\n");

        return `[Knowledge Base — ${nodes.length} nodes]\n\n${formatted}`;
      },
    },
  ],
};

export default opaiKnowledgePlugin;
