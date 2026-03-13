/**
 * OPAI ElizaOS Runtime
 *
 * Express server on :8085 that manages ElizaOS AgentRuntime instances.
 * Provides REST API for agent lifecycle (start/stop/message) and health.
 */

import express from "express";
import { RuntimeManager } from "./runtime-manager";
import { TelegramConnector } from "./telegram-connector";

// Prevent unhandled errors from crashing the process (grammY polling errors)
process.on("unhandledRejection", (err: any) => {
  console.error("[opai-eliza] Unhandled rejection:", err?.message || err);
});
process.on("uncaughtException", (err: any) => {
  // grammY throws uncaught exceptions on polling conflicts (409)
  // These are recoverable — don't crash the process
  if (err?.error_code === 409) {
    console.warn("[opai-eliza] Telegram polling conflict — will retry");
    return;
  }
  console.error("[opai-eliza] Uncaught exception:", err?.message || err);
  // For non-409 errors, exit to let systemd restart
  process.exit(1);
});

const PORT = parseInt(process.env.ELIZA_PORT || "8085", 10);
const CHARACTERS_DIR = process.env.CHARACTERS_DIR || "./characters";

const app = express();
app.use(express.json({ limit: "1mb" }));

const manager = new RuntimeManager(CHARACTERS_DIR);

// ── Health ─────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  const agents = manager.listAgents();
  res.json({
    service: "opai-eliza",
    status: "ok",
    uptime: process.uptime(),
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      platforms: a.platforms,
      startedAt: a.startedAt,
      interactions: a.interactionCount,
    })),
    totalAgents: agents.length,
    runningAgents: agents.filter((a) => a.status === "running").length,
  });
});

// ── List agents ────────────────────────────────────────────
app.get("/api/agents", (_req, res) => {
  res.json({ agents: manager.listAgents() });
});

// ── Get agent details ──────────────────────────────────────
app.get("/api/agents/:id", (req, res) => {
  const agent = manager.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  res.json(agent);
});

// ── Start agent from character file or inline config ───────
app.post("/api/agents/start", async (req, res) => {
  try {
    const { characterFile, character, agentId } = req.body;

    if (!characterFile && !character) {
      return res.status(400).json({
        error: "Provide either characterFile (filename) or character (inline JSON)",
      });
    }

    const agent = await manager.startAgent({
      characterFile,
      character,
      agentId,
    });

    res.json({ success: true, agent });
  } catch (err: any) {
    console.error("[start-agent]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Stop agent ─────────────────────────────────────────────
app.post("/api/agents/:id/stop", async (req, res) => {
  try {
    await manager.stopAgent(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Restart agent ──────────────────────────────────────────
app.post("/api/agents/:id/restart", async (req, res) => {
  try {
    const agent = await manager.restartAgent(req.params.id);
    res.json({ success: true, agent });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Send message to agent ──────────────────────────────────
app.post("/api/agents/:id/message", async (req, res) => {
  try {
    const { message, userId, channel } = req.body;
    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }

    const response = await manager.sendMessage(req.params.id, {
      message,
      userId: userId || "api-user",
      channel: channel || "rest",
    });

    res.json(response);
  } catch (err: any) {
    console.error("[message]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Update agent character/config ──────────────────────────
app.patch("/api/agents/:id", async (req, res) => {
  try {
    const agent = await manager.updateAgent(req.params.id, req.body);
    res.json({ success: true, agent });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delete agent ───────────────────────────────────────────
app.delete("/api/agents/:id", async (req, res) => {
  try {
    await manager.deleteAgent(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── List available character files ─────────────────────────
app.get("/api/characters", async (_req, res) => {
  const characters = await manager.listAllCharacters();
  res.json({ characters });
});

// ── Create a new character ────────────────────────────────
app.post("/api/characters", async (req, res) => {
  try {
    const { character, startImmediately = true } = req.body;
    if (!character) {
      return res.status(400).json({ error: "character object is required" });
    }
    const result = await manager.createCharacter(character, startImmediately);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Update a character file ───────────────────────────────
app.patch("/api/characters/:slug", async (req, res) => {
  try {
    const character = await manager.updateCharacterFile(req.params.slug, req.body);
    res.json({ success: true, character });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Delete a character file ───────────────────────────────
app.delete("/api/characters/:slug", async (req, res) => {
  try {
    await manager.deleteCharacterFile(req.params.slug);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Start server ───────────────────────────────────────────
app.listen(PORT, "127.0.0.1", async () => {
  console.log(`[opai-eliza] Runtime server listening on 127.0.0.1:${PORT}`);
  console.log(`[opai-eliza] Characters dir: ${CHARACTERS_DIR}`);

  // ── Telegram bot (optional — starts when token is set) ────
  const tgToken = process.env.ELIZA_TELEGRAM_BOT_TOKEN;
  if (tgToken) {
    const tgConnector = new TelegramConnector(manager, {
      token: tgToken,
      characterFile: process.env.ELIZA_TELEGRAM_CHARACTER || "op-worker.json",
      allowedChatIds: process.env.ELIZA_TELEGRAM_ALLOWED_CHATS
        ? process.env.ELIZA_TELEGRAM_ALLOWED_CHATS.split(",")
        : [],
      testTopicId: process.env.ELIZA_TELEGRAM_TOPIC_ID
        ? parseInt(process.env.ELIZA_TELEGRAM_TOPIC_ID, 10)
        : undefined,
    });

    // Small delay to let ElizaOS runtime initialize first
    setTimeout(async () => {
      try {
        await tgConnector.start();
      } catch (err: any) {
        console.error("[opai-eliza] Failed to start Telegram bot:", err.message);
      }
    }, 3000);
  }
});
