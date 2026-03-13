/**
 * OPAI Info Layer Plugin — Evaluator for inbound sanitization,
 * outbound validation, and interaction logging.
 *
 * Inbound: strips internal commands, blocks prompt injection, classifies messages.
 * Outbound: checks for accidental leaks of internal data.
 * All interactions logged to Supabase eliza_interactions table.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const ENGINE_API = process.env.ENGINE_API_URL || "http://127.0.0.1:8080";

// ── Patterns ──────────────────────────────────────────────

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+(instructions?|prompts?)/i,
  /you\s+are\s+now\s+/i,
  /system\s*prompt\s*:/i,
  /\bDAN\b.*\bmode\b/i,
  /pretend\s+you\s+(are|were)\s+/i,
  /act\s+as\s+(if|though)\s+you\s+(have\s+)?no\s+restrict/i,
  /override\s+your\s+(safety|instructions?|guidelines?|rules?)/i,
  /jailbreak/i,
];

const INTERNAL_PATTERNS = [
  /OPAI_INTERNAL:/i,
  /\/workspace\//,
  /127\.0\.0\.1:\d+/,
  /localhost:\d+/,
  /supabase\.co/i,
  /sbp_[a-zA-Z0-9]+/,  // Supabase PAT
  /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/,  // JWT tokens
  /SUPABASE_SERVICE_KEY/i,
  /opai-engine|opai-portal|opai-brain|opai-team-hub/,
];

const COMMAND_PATTERNS = [
  /^\//,  // Slash commands
  /^!!/,  // Double-bang commands
];

type InfoClass = "internal_command" | "public_response" | "escalation" | "system_event" | "knowledge_query" | "blocked";

// ── Classification ────────────────────────────────────────

function classifyInbound(text: string, agentInfoLayer: string): { classification: InfoClass; blocked: boolean; reason?: string } {
  // Check for prompt injection
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return { classification: "blocked", blocked: true, reason: "Prompt injection attempt detected" };
    }
  }

  // Check for internal commands (only block for non-internal agents)
  if (agentInfoLayer !== "internal") {
    for (const pattern of COMMAND_PATTERNS) {
      if (pattern.test(text)) {
        return { classification: "internal_command", blocked: true, reason: "Internal command blocked on public agent" };
      }
    }

    // Check for internal data in input
    for (const pattern of INTERNAL_PATTERNS) {
      if (pattern.test(text)) {
        return { classification: "blocked", blocked: true, reason: "Internal data pattern detected in input" };
      }
    }
  }

  // Knowledge query detection
  if (/\b(what|how|explain|describe|tell me about)\b/i.test(text)) {
    return { classification: "knowledge_query", blocked: false };
  }

  return { classification: "public_response", blocked: false };
}

function validateOutbound(text: string, agentInfoLayer: string): { safe: boolean; leaks: string[] } {
  if (agentInfoLayer === "internal") {
    return { safe: true, leaks: [] };
  }

  const leaks: string[] = [];
  for (const pattern of INTERNAL_PATTERNS) {
    if (pattern.test(text)) {
      leaks.push(pattern.source);
    }
  }

  return { safe: leaks.length === 0, leaks };
}

const SAFE_FALLBACK = "I'm sorry, I can't process that request. If you need help, please try rephrasing your question.";

// ── Supabase logging ──────────────────────────────────────

async function logInteraction(data: {
  agent_id: string;
  owner_id: string;
  direction: "inbound" | "outbound";
  channel: string;
  content: string;
  info_class: InfoClass;
  tokens_used?: number;
  latency_ms?: number;
}): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/eliza_interactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(data),
    });
  } catch (err: any) {
    console.error("[opai-infolayer] Failed to log interaction:", err.message);
  }
}

async function logAudit(data: {
  agent_id: string;
  owner_id: string;
  action: string;
  details: Record<string, any>;
  severity: "info" | "warn" | "error" | "critical";
}): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/eliza_audit_log`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ ...data, actor: "infolayer" }),
    });
  } catch (err: any) {
    console.error("[opai-infolayer] Failed to log audit:", err.message);
  }
}

// ── Plugin export ─────────────────────────────────────────

export const opaiInfolayerPlugin = {
  name: "opai-infolayer",
  description: "Info layer classification, sanitization, and interaction logging",

  evaluators: [
    {
      name: "inbound-sanitizer",
      description: "Classifies and sanitizes inbound messages before agent processing",
      similes: ["filter", "sanitize", "classify"],

      validate: async () => true,

      handler: async (runtime: any, message: any, _state: any) => {
        const character = runtime.character || {};
        const agentInfoLayer = character.info_layer || "public";
        const text = message.content?.text || "";

        const result = classifyInbound(text, agentInfoLayer);

        // Log the inbound interaction
        await logInteraction({
          agent_id: character.id || runtime.agentId || "unknown",
          owner_id: character.owner_id || SUPABASE_SERVICE_KEY ? "system" : "unknown",
          direction: "inbound",
          channel: message.roomId || "rest",
          content: text.slice(0, 500), // Truncate for storage
          info_class: result.classification,
        });

        if (result.blocked) {
          // Log blocked attempt to audit
          await logAudit({
            agent_id: character.id || "unknown",
            owner_id: character.owner_id || "system",
            action: "message_blocked",
            details: { reason: result.reason, classification: result.classification, input_preview: text.slice(0, 100) },
            severity: result.classification === "blocked" ? "warn" : "info",
          });

          // Replace message content with safe fallback indicator
          message.content.text = `[BLOCKED: ${result.reason}]`;
          message._blocked = true;
          message._blockReason = result.reason;
        }

        message._infoClass = result.classification;
        return result;
      },

      examples: [],
    },

    {
      name: "outbound-validator",
      description: "Validates outbound responses for accidental internal data leaks",
      similes: ["validate", "check output", "leak detection"],

      validate: async () => true,

      handler: async (runtime: any, message: any, _state: any) => {
        const character = runtime.character || {};
        const agentInfoLayer = character.info_layer || "public";
        const text = message.content?.text || "";

        const result = validateOutbound(text, agentInfoLayer);

        // Log the outbound interaction
        await logInteraction({
          agent_id: character.id || runtime.agentId || "unknown",
          owner_id: character.owner_id || "system",
          direction: "outbound",
          channel: message.roomId || "rest",
          content: result.safe ? text.slice(0, 500) : "[REDACTED — leak detected]",
          info_class: result.safe ? "public_response" : "blocked",
        });

        if (!result.safe) {
          // Log leak to audit
          await logAudit({
            agent_id: character.id || "unknown",
            owner_id: character.owner_id || "system",
            action: "output_leak_blocked",
            details: { leaked_patterns: result.leaks, response_preview: text.slice(0, 100) },
            severity: "warn",
          });

          // Replace response with safe fallback
          message.content.text = SAFE_FALLBACK;
        }

        return result;
      },

      examples: [],
    },
  ],
};

export default opaiInfolayerPlugin;
