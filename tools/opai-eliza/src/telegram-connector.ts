/**
 * TelegramConnector — connects an Eliza agent to Telegram via grammY.
 *
 * Runs in parallel with the main OPAI Telegram bot (@OPAIBot).
 * Uses long polling for testing, can switch to webhooks for production.
 * Routes all messages to a specified Eliza agent via RuntimeManager.
 */

import { Bot, Context } from "grammy";
import type { RuntimeManager } from "./runtime-manager";

interface TelegramConfig {
  token: string;
  agentId?: string;          // Which agent handles messages (auto-selects first running if not set)
  characterFile?: string;    // Auto-start this character on boot
  allowedChatIds?: string[]; // Restrict to specific chats/groups (empty = allow all)
  testTopicId?: number;      // If set, only respond in this forum topic
}

/** In-character thinking messages — picked randomly per request */
const DEFAULT_THINKING_MESSAGES = [
  "Processing...",
  "Working on it...",
  "One moment...",
];

/** Character JSON schema template for Claude to fill */
const CHARACTER_SCHEMA_TEMPLATE = `{
  "name": "Character Name",
  "slug": "character-name",
  "description": "One-line description",
  "bio": "Longer bio paragraph",
  "modelProvider": "anthropic",
  "platforms": ["rest", "telegram"],
  "plugins": ["opai-knowledge", "opai-infolayer"],
  "settings": { "model": "claude-sonnet-4-6", "maxTokens": 2048, "temperature": 0.3 },
  "system": "Full system prompt for the character",
  "style": { "all": ["Style trait 1", "Style trait 2"], "chat": ["Chat-specific trait"] },
  "thinkingMessages": ["Processing...", "Working on it..."],
  "info_layer": "public",
  "rate_limits": { "rpm": 30, "daily": 500 }
}`;

interface PendingCharacter {
  character: any;
  timestamp: number;
}

export class TelegramConnector {
  private bot: Bot;
  private runtime: RuntimeManager;
  private config: TelegramConfig;
  private activeAgentId: string | null = null;
  private started = false;
  private pendingCharacters: Map<number, PendingCharacter> = new Map();

  constructor(runtime: RuntimeManager, config: TelegramConfig) {
    this.runtime = runtime;
    this.config = config;
    this.bot = new Bot(config.token);

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Command handlers
    this.bot.command("start", (ctx) => this.handleStart(ctx));
    this.bot.command("help", (ctx) => this.handleHelp(ctx));
    this.bot.command("status", (ctx) => this.handleStatus(ctx));
    this.bot.command("agent", (ctx) => this.handleAgentInfo(ctx));
    this.bot.command("switch", (ctx) => this.handleSwitch(ctx));
    this.bot.command("agents", (ctx) => this.handleListAgents(ctx));
    this.bot.command("restart", (ctx) => this.handleRestart(ctx));
    this.bot.command("fresh", (ctx) => this.handleFresh(ctx));
    this.bot.command("chars", (ctx) => this.handleListChars(ctx));
    this.bot.command("create_char", (ctx) => this.handleCreateChar(ctx));
    this.bot.command("edit_char", (ctx) => this.handleEditChar(ctx));
    this.bot.command("delete_char", (ctx) => this.handleDeleteChar(ctx));

    // Message handler — route to Eliza agent (also handles confirmation flow)
    this.bot.on("message:text", (ctx) => this.handleMessage(ctx));

    // Error handler
    this.bot.catch((err) => {
      console.error("[telegram] Bot error:", err.message || err);
    });
  }

  // ── Command Handlers ──────────────────────────────────

  private async handleStart(ctx: Context): Promise<void> {
    if (!this.shouldRespond(ctx)) return;

    const agent = this.getActiveAgent();
    const name = agent?.name || "Eliza Agent";

    await ctx.reply(
      `Hi! I'm ${name}.\n\n` +
      `I'm an OPAI autonomous agent powered by ElizaOS. ` +
      `Send me a message and I'll respond in character.\n\n` +
      `Commands: /help`
    );
  }

  private async handleHelp(ctx: Context): Promise<void> {
    if (!this.shouldRespond(ctx)) return;

    await ctx.reply(
      "*Available Commands*\n\n" +
      "*Agents*\n" +
      "/status \u2014 Runtime status\n" +
      "/agent \u2014 Current agent details\n" +
      "/agents \u2014 List running agents\n" +
      "/chars \u2014 All characters (running + available)\n\n" +
      "*Switching*\n" +
      "/switch <name> \u2014 Switch agent (fresh)\n" +
      "/switch <name> -k \u2014 Switch + keep history\n" +
      "/switch <name> --with-context \"...\" \u2014 Switch + context\n\n" +
      "*Character Management*\n" +
      "/create\\_char \u2014 Create new character\n" +
      "/create\\_char from template <name> \u2014 From template\n" +
      "/edit\\_char <slug> --field \"value\" \u2014 Edit character\n" +
      "/delete\\_char <slug> \u2014 Delete character\n\n" +
      "*Session*\n" +
      "/restart \u2014 Restart agent (fresh)\n" +
      "/restart --keep \u2014 Restart + preserve history\n" +
      "/fresh \u2014 Clear history only\n\n" +
      "Or just send a message to chat!",
      { parse_mode: "Markdown" }
    );
  }

  private async handleStatus(ctx: Context): Promise<void> {
    if (!this.shouldRespond(ctx)) return;

    const agents = this.runtime.listAgents();
    const running = agents.filter((a) => a.status === "running");

    let text = `Eliza Runtime\n\n`;
    text += `Agents: ${agents.length} total, ${running.length} running\n\n`;

    for (const agent of agents) {
      const dot = agent.status === "running" ? "🟢" : agent.status === "error" ? "🔴" : "⚪";
      text += `${dot} ${agent.name} — ${agent.status}`;
      if (agent.interactionCount > 0) {
        text += ` (${agent.interactionCount} interactions)`;
      }
      text += "\n";
    }

    await ctx.reply(text);
  }

  private async handleAgentInfo(ctx: Context): Promise<void> {
    if (!this.shouldRespond(ctx)) return;

    const agent = this.getActiveAgent();
    if (!agent) {
      await ctx.reply("No active agent. Start one via the Eliza Hub dashboard.");
      return;
    }

    const char = agent.character || {};
    let text = `🤖 ${agent.name}\n\n`;
    text += `Status: ${agent.status}\n`;
    text += `Slug: ${agent.slug}\n`;
    if (char.description) text += `\n${char.description}\n`;
    if (char.platforms?.length) text += `\nPlatforms: ${char.platforms.join(", ")}\n`;
    if (agent.startedAt) text += `\nStarted: ${new Date(agent.startedAt).toLocaleString()}\n`;
    text += `Interactions: ${agent.interactionCount}`;

    await ctx.reply(text);
  }

  private async handleSwitch(ctx: Context): Promise<void> {
    if (!this.shouldRespond(ctx)) return;

    const text = ctx.message?.text || "";
    const raw = text.replace(/^\/switch\s*/i, "").trim();

    // No args — show agent list (same as /agents)
    if (!raw) {
      return this.handleListAgents(ctx);
    }

    // Parse flags
    const keepHistory = raw.includes("--keep-history") || raw.includes("-k");
    const contextMatch = raw.match(/--with-context\s+"([^"]+)"/);
    const withContext = contextMatch?.[1] || null;

    // Strip flags to get agent name
    const agentName = raw
      .replace(/--keep-history/g, "")
      .replace(/-k\b/g, "")
      .replace(/--with-context\s+"[^"]*"/g, "")
      .trim();

    const agents = this.runtime.listAgents();
    const running = agents.filter((a) => a.status === "running");

    // Find by slug or name (case-insensitive)
    const target = running.find(
      (a) =>
        a.slug?.toLowerCase() === agentName.toLowerCase() ||
        a.name?.toLowerCase() === agentName.toLowerCase()
    );

    if (!target) {
      const available = running.map((a) => a.slug || a.name).join(", ");
      await ctx.reply(
        `Agent "${agentName}" not found or not running.\n\n` +
        `Available: ${available || "none"}`
      );
      return;
    }

    // Save history from current agent if --keep-history
    const previousAgentId = this.activeAgentId;
    if (keepHistory && previousAgentId) {
      const history = this.runtime.getHistory(previousAgentId);
      if (history.length > 0) {
        this.runtime.injectHistory(target.id, history);
      }
    }

    // Inject context summary if --with-context
    if (withContext) {
      this.runtime.injectContext(target.id, withContext);
    }

    this.activeAgentId = target.id;
    const char = target.character || {};
    const desc = char.description ? `\n${char.description}` : "";

    let statusMsg = "Starting fresh.";
    if (keepHistory) statusMsg = "Loaded conversation history.";
    else if (withContext) statusMsg = "Context loaded.";

    await ctx.reply(
      `Switched to *${target.name}*${desc}\n\n${statusMsg}`,
      { parse_mode: "Markdown" }
    );
  }

  private async handleListAgents(ctx: Context): Promise<void> {
    if (!this.shouldRespond(ctx)) return;

    const agents = this.runtime.listAgents();
    if (agents.length === 0) {
      await ctx.reply("No agents loaded. Start one via the Eliza Hub dashboard.");
      return;
    }

    let text = "Agents\n\n";
    for (const agent of agents) {
      const dot = agent.status === "running" ? "🟢" : agent.status === "error" ? "🔴" : "⚪";
      const active = agent.id === this.activeAgentId ? " ← active" : "";
      const slug = agent.slug ? ` (${agent.slug})` : "";
      text += `${dot} ${agent.name}${slug}${active}\n`;
    }

    text += `\nSwitch: /switch <name>`;
    await ctx.reply(text);
  }

  // ── Character Listing ────────────────────────────────

  private async handleListChars(ctx: Context): Promise<void> {
    if (!this.shouldRespond(ctx)) return;

    const chars = await this.runtime.listAllCharacters();

    if (chars.length === 0) {
      await ctx.reply("No characters found. Create one with /create_char");
      return;
    }

    let text = "*All Characters*\n\n";
    for (const c of chars) {
      const icon = c.status === "running" ? "\u{1F7E2}" : c.status === "error" ? "\u{1F534}" : "\u{26AA}";
      const active = this.activeAgentId && c.slug === this.getActiveAgent()?.slug ? " \u2190 active" : "";
      text += `${icon} *${c.name}* (${c.slug}) \u2014 ${c.status}${active}\n`;
    }

    text += "\nStart: `/switch <slug>`\nCreate: `/create_char`";
    await ctx.reply(text, { parse_mode: "Markdown" });
  }

  // ── Character Creation ───────────────────────────────

  private async handleCreateChar(ctx: Context): Promise<void> {
    if (!this.shouldRespond(ctx)) return;

    const text = ctx.message?.text || "";
    const args = text.replace(/^\/create_char\s*/i, "").trim();
    const userId = ctx.from?.id;
    if (!userId) return;

    // From template: /create_char from template <name>
    const templateMatch = args.match(/^from\s+template\s+(\S+)$/i);
    if (templateMatch) {
      return this.createFromTemplate(ctx, templateMatch[1]);
    }

    // Quick create: inline JSON
    if (args.startsWith("{")) {
      try {
        const charDef = JSON.parse(args);
        return this.createAndStartCharacter(ctx, charDef);
      } catch (err: any) {
        await ctx.reply(`Invalid JSON: ${err.message}`);
        return;
      }
    }

    // No description — prompt the user
    if (!args) {
      await ctx.reply(
        "*Character Builder*\n\n" +
        "Describe the character you want to create. Include:\n" +
        "- Purpose (what does it do?)\n" +
        "- Personality/tone\n" +
        "- Any specific knowledge areas\n\n" +
        "Example: _Sales closer for BoutaByte. Confident, persuasive, knows our hosting plans._\n\n" +
        "Or paste raw JSON for quick create.",
        { parse_mode: "Markdown" }
      );
      // Set a flag so the next message from this user goes through character builder
      this.pendingCharacters.set(userId, { character: null, timestamp: Date.now() });
      return;
    }

    // Natural language description — use Claude to generate character JSON
    await this.generateCharacterFromDescription(ctx, args);
  }

  private async generateCharacterFromDescription(ctx: Context, description: string): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.reply("Building character...");

    const prompt = `You are a character designer for the OPAI ElizaOS platform.
Based on the user's description, generate a character JSON following this exact schema:
${CHARACTER_SCHEMA_TEMPLATE}

Rules:
- Generate a creative but appropriate name if not specified
- The slug must be lowercase, hyphenated, no special chars
- The system prompt should be detailed and define the character's behavior
- info_layer should be "public" for customer-facing, "internal" for ops
- Include 3-5 thinkingMessages that match the character's personality
- Include relevant style traits
- Keep it professional

User's description: ${description}

Return ONLY valid JSON. No markdown fences, no explanation.`;

    try {
      const charJson = await this.callClaudeForCharacter(prompt);
      const character = JSON.parse(charJson);

      // Store as pending for confirmation
      this.pendingCharacters.set(userId, { character, timestamp: Date.now() });

      // Show preview
      const styles = character.style?.all?.join(", ") || "Default";
      let preview = `*${character.name}*\n\n`;
      preview += `Slug: \`${character.slug}\`\n`;
      preview += `Type: ${character.info_layer || "public"}\n`;
      preview += `Style: ${styles}\n`;
      if (character.description) preview += `\n${character.description}\n`;
      preview += "\nReply *Yes* to create, *Edit* to modify, or *Cancel* to discard.";

      await ctx.reply(preview, { parse_mode: "Markdown" });
    } catch (err: any) {
      this.pendingCharacters.delete(userId);
      await ctx.reply(`Failed to generate character: ${err.message}`);
    }
  }

  private async createAndStartCharacter(ctx: Context, character: any): Promise<void> {
    const userId = ctx.from?.id;
    if (userId) this.pendingCharacters.delete(userId);

    try {
      const result = await this.runtime.createCharacter(character, true);
      this.activeAgentId = result.agent?.id || null;

      await ctx.reply(
        `Character *${character.name}* created and started.\n` +
        `Switched to *${character.name}*. Say something to test!`,
        { parse_mode: "Markdown" }
      );
    } catch (err: any) {
      await ctx.reply(`Failed to create character: ${err.message}`);
    }
  }

  /**
   * Handle confirmation replies for pending character creation.
   * Returns true if the message was consumed by the confirmation flow.
   */
  private async handleCharacterConfirmation(ctx: Context): Promise<boolean> {
    const userId = ctx.from?.id;
    if (!userId) return false;

    const pending = this.pendingCharacters.get(userId);
    if (!pending) return false;

    // Expire after 5 minutes
    if (Date.now() - pending.timestamp > 5 * 60 * 1000) {
      this.pendingCharacters.delete(userId);
      return false;
    }

    const text = (ctx.message?.text || "").trim().toLowerCase();

    // Waiting for description (character is null)
    if (pending.character === null) {
      const description = ctx.message?.text || "";
      if (description.startsWith("{")) {
        try {
          const charDef = JSON.parse(description);
          await this.createAndStartCharacter(ctx, charDef);
        } catch (err: any) {
          await ctx.reply(`Invalid JSON: ${err.message}`);
        }
      } else {
        await this.generateCharacterFromDescription(ctx, description);
      }
      return true;
    }

    // Character generated, waiting for confirmation
    if (text === "yes" || text === "y" || text === "confirm") {
      await this.createAndStartCharacter(ctx, pending.character);
      return true;
    }

    if (text === "cancel" || text === "no" || text === "n") {
      this.pendingCharacters.delete(userId);
      await ctx.reply("Character creation cancelled.");
      return true;
    }

    if (text === "edit") {
      await ctx.reply(
        "Describe what you'd like to change. For example:\n" +
        "_Make it more casual_ or _Change the name to Sales Pro_",
        { parse_mode: "Markdown" }
      );
      return true;
    }

    // Treat as edit instruction — regenerate with modifications
    if (pending.character) {
      const editPrompt = `Modify this character JSON based on the user's feedback.

Current character:
${JSON.stringify(pending.character, null, 2)}

User's edit request: ${ctx.message?.text}

Return the complete modified JSON only. No markdown fences.`;

      try {
        await ctx.reply("Updating character...");
        const updated = await this.callClaudeForCharacter(editPrompt);
        const character = JSON.parse(updated);
        this.pendingCharacters.set(userId, { character, timestamp: Date.now() });

        const styles = character.style?.all?.join(", ") || "Default";
        let preview = `*${character.name}* (updated)\n\n`;
        preview += `Slug: \`${character.slug}\`\n`;
        preview += `Style: ${styles}\n`;
        if (character.description) preview += `\n${character.description}\n`;
        preview += "\nReply *Yes* to create, *Edit* to modify, or *Cancel*.";

        await ctx.reply(preview, { parse_mode: "Markdown" });
      } catch (err: any) {
        await ctx.reply(`Failed to update: ${err.message}`);
      }
      return true;
    }

    return false;
  }

  /**
   * Call Claude CLI specifically for character generation (no agent context).
   */
  private callClaudeForCharacter(prompt: string): Promise<string> {
    const { execFile } = require("child_process");
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;

      const child = execFile(
        "claude",
        ["-p"],
        { timeout: 30000, maxBuffer: 512 * 1024, env },
        (error: any, stdout: string, stderr: string) => {
          if (error) {
            reject(new Error(`Claude CLI error: ${stderr || error.message}`));
            return;
          }
          const response = stdout.trim();
          if (!response) {
            reject(new Error("Empty response from Claude"));
            return;
          }
          resolve(response);
        }
      );
      child.stdin?.write(prompt);
      child.stdin?.end();
    });
  }

  private async createFromTemplate(ctx: Context, templateName: string): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const { readFile } = require("fs/promises");
    const { join, resolve } = require("path");
    const { existsSync } = require("fs");

    // Look for template file
    const templatesDir = resolve(join(__dirname, "..", "templates"));
    const templateFile = join(templatesDir, `${templateName}.template.json`);

    if (!existsSync(templateFile)) {
      // List available templates
      try {
        const { readdir } = require("fs/promises");
        const files = await readdir(templatesDir);
        const templates = files
          .filter((f: string) => f.endsWith(".template.json"))
          .map((f: string) => f.replace(".template.json", ""));

        await ctx.reply(
          `Template "${templateName}" not found.\n\n` +
          `Available templates:\n${templates.map((t: string) => `- \`${t}\``).join("\n")}\n\n` +
          `Usage: \`/create_char from template <name>\``,
          { parse_mode: "Markdown" }
        );
      } catch {
        await ctx.reply(`Template "${templateName}" not found.`);
      }
      return;
    }

    try {
      const raw = await readFile(templateFile, "utf-8");
      const template = JSON.parse(raw);

      // Store as pending — user needs to provide name + customize
      this.pendingCharacters.set(userId, { character: template, timestamp: Date.now() });

      await ctx.reply(
        `*Template: ${templateName}*\n\n` +
        `${template.description || ""}\n\n` +
        `Give this character a name (e.g., _BoutaByte Sales Pro_) or describe customizations.\n` +
        `Or reply *Cancel* to discard.`,
        { parse_mode: "Markdown" }
      );
    } catch (err: any) {
      await ctx.reply(`Failed to load template: ${err.message}`);
    }
  }

  // ── Character Edit / Delete ──────────────────────────

  private async handleEditChar(ctx: Context): Promise<void> {
    if (!this.shouldRespond(ctx)) return;

    const text = ctx.message?.text || "";
    const args = text.replace(/^\/edit_char\s*/i, "").trim();

    if (!args) {
      await ctx.reply(
        "Usage: `/edit_char <slug> --field \"value\"`\n\n" +
        "Fields: `--name`, `--system`, `--bio`, `--description`\n\n" +
        "Example:\n`/edit_char op-worker --system \"You are now more casual\"`",
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Parse slug and field updates
    const slug = args.split(/\s+/)[0];
    const updates: Record<string, any> = {};

    const nameMatch = args.match(/--name\s+"([^"]+)"/);
    const systemMatch = args.match(/--system\s+"([^"]+)"/);
    const bioMatch = args.match(/--bio\s+"([^"]+)"/);
    const descMatch = args.match(/--description\s+"([^"]+)"/);

    if (nameMatch) updates.name = nameMatch[1];
    if (systemMatch) updates.system = systemMatch[1];
    if (bioMatch) updates.bio = bioMatch[1];
    if (descMatch) updates.description = descMatch[1];

    if (Object.keys(updates).length === 0) {
      await ctx.reply("No field updates provided. Use `--name`, `--system`, `--bio`, or `--description`.", { parse_mode: "Markdown" });
      return;
    }

    try {
      await this.runtime.updateCharacterFile(slug, updates);

      // Restart the running agent if it exists
      const agents = this.runtime.listAgents();
      const running = agents.find((a) => a.slug === slug);
      let restarted = false;

      if (running) {
        await this.runtime.restartAgent(running.id);
        restarted = true;
      }

      const fields = Object.keys(updates).join(", ");
      await ctx.reply(
        `Updated *${slug}* (${fields}).${restarted ? " Agent restarted." : ""}`,
        { parse_mode: "Markdown" }
      );
    } catch (err: any) {
      await ctx.reply(`Failed to update: ${err.message}`);
    }
  }

  private pendingDeletes: Map<number, { slug: string; timestamp: number }> = new Map();

  private async handleDeleteChar(ctx: Context): Promise<void> {
    if (!this.shouldRespond(ctx)) return;

    const userId = ctx.from?.id;
    if (!userId) return;

    const text = ctx.message?.text || "";
    const slug = text.replace(/^\/delete_char\s*/i, "").trim();

    if (!slug) {
      await ctx.reply("Usage: `/delete_char <slug>`", { parse_mode: "Markdown" });
      return;
    }

    // Check if pending confirmation
    const pending = this.pendingDeletes.get(userId);
    if (pending && pending.slug === slug && Date.now() - pending.timestamp < 60000) {
      // Already confirmed
      try {
        await this.runtime.deleteCharacterFile(slug);
        this.pendingDeletes.delete(userId);
        await ctx.reply(`Deleted *${slug}*. Character file and agent removed.`, { parse_mode: "Markdown" });
      } catch (err: any) {
        await ctx.reply(`Failed to delete: ${err.message}`);
      }
      return;
    }

    // First call — ask for confirmation
    this.pendingDeletes.set(userId, { slug, timestamp: Date.now() });
    await ctx.reply(
      `Delete *${slug}*? This removes the character file and stops the agent.\n\n` +
      `Run \`/delete_char ${slug}\` again to confirm.`,
      { parse_mode: "Markdown" }
    );
  }

  // ── Restart / Fresh ──────────────────────────────────

  private async handleRestart(ctx: Context): Promise<void> {
    if (!this.shouldRespond(ctx)) return;

    const text = ctx.message?.text || "";
    const keep = text.includes("--keep") || text.includes("-k");
    const agent = this.getActiveAgent();

    if (!agent) {
      await ctx.reply("No active agent to restart.");
      return;
    }

    let savedHistory: any[] = [];
    if (keep) {
      savedHistory = this.runtime.getHistory(agent.id);
    }

    await ctx.reply(`Restarting *${agent.name}*...`, { parse_mode: "Markdown" });

    try {
      const restarted = await this.runtime.restartAgent(agent.id);
      this.activeAgentId = restarted.id;

      if (keep && savedHistory.length > 0) {
        this.runtime.injectHistory(restarted.id, savedHistory);
      }

      await ctx.reply(
        `Restarted *${restarted.name}*.${keep ? " History preserved." : " Fresh start."}`,
        { parse_mode: "Markdown" }
      );
    } catch (err: any) {
      await ctx.reply(`Failed to restart: ${err.message}`);
    }
  }

  private async handleFresh(ctx: Context): Promise<void> {
    if (!this.shouldRespond(ctx)) return;

    const agent = this.getActiveAgent();
    if (!agent) {
      await ctx.reply("No active agent.");
      return;
    }

    this.runtime.clearHistory(agent.id);
    await ctx.reply(
      `*${agent.name}* conversation wiped. Starting fresh.`,
      { parse_mode: "Markdown" }
    );
  }

  // ── Message Handler ───────────────────────────────────

  private async handleMessage(ctx: Context): Promise<void> {
    if (!this.shouldRespond(ctx)) return;

    const text = ctx.message?.text;
    if (!text) return;

    // Check if this message is part of a character creation flow
    const consumed = await this.handleCharacterConfirmation(ctx);
    if (consumed) return;

    const agent = this.getActiveAgent();
    if (!agent) {
      await ctx.reply("No agent is currently running. Start one via the Eliza Hub dashboard.");
      return;
    }

    const threadId = ctx.message?.message_thread_id;
    const threadOpts = threadId ? { message_thread_id: threadId } : {};

    // Send in-character thinking message
    const thinkingText = this.getThinkingMessage(agent);
    const thinkingMsg = await ctx.reply(thinkingText, threadOpts);

    // Keep typing indicator alive while Claude processes
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);

    const userId = String(ctx.from?.id || "unknown");
    const userName = ctx.from?.first_name || ctx.from?.username || userId;
    const chatId = String(ctx.chat?.id || "telegram");
    const channel = threadId ? `tg-${chatId}-${threadId}` : `tg-${chatId}`;

    try {
      const result = await this.runtime.sendMessage(agent.id, {
        message: text,
        userId: userName,
        channel,
      });

      clearInterval(typingInterval);

      if (result.response) {
        const chunks = this.splitMessage(result.response, 4000);

        // Replace thinking message with first chunk
        try {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            thinkingMsg.message_id,
            chunks[0],
          );
        } catch {
          // If edit fails (e.g. message too old), send as new message
          await ctx.reply(chunks[0], threadOpts);
        }

        // Send remaining chunks as new messages
        for (let i = 1; i < chunks.length; i++) {
          await ctx.reply(chunks[i], threadOpts);
        }
      } else {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          thinkingMsg.message_id,
          "No response generated.",
        );
      }
    } catch (err: any) {
      clearInterval(typingInterval);
      console.error(`[telegram] Message error:`, err.message);

      try {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          thinkingMsg.message_id,
          `Sorry, I encountered an error. Please try again.`,
        );
      } catch {
        // Fallback if edit fails
        await ctx.reply(`Sorry, I encountered an error. Please try again.`, threadOpts);
      }
    }
  }

  /**
   * Get an in-character thinking message for the active agent.
   * Characters can define custom messages via character.thinkingMessages array.
   */
  private getThinkingMessage(agent: any): string {
    const custom = agent.character?.thinkingMessages;
    const pool = Array.isArray(custom) && custom.length > 0
      ? custom
      : DEFAULT_THINKING_MESSAGES;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ── Lifecycle ─────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;

    // Auto-start character if configured
    if (this.config.characterFile && !this.config.agentId) {
      try {
        const agent = await this.runtime.startAgent({
          characterFile: this.config.characterFile,
        });
        this.activeAgentId = agent.id;
        console.log(`[telegram] Auto-started agent: ${agent.name} (${agent.id})`);
      } catch (err: any) {
        console.error(`[telegram] Failed to auto-start agent:`, err.message);
      }
    } else if (this.config.agentId) {
      this.activeAgentId = this.config.agentId;
    }

    // Start polling with auto-retry on conflict errors
    await this.startPolling();
  }

  /**
   * Manual polling loop — bypasses grammY's bot.start() which has
   * uncatchable 409 errors that crash the process.
   */
  private async startPolling(): Promise<void> {
    // Initialize bot (required for handleUpdate to work)
    await this.bot.init();
    console.log(`[telegram] Bot started: @${this.bot.botInfo.username} (${this.bot.botInfo.first_name})`);
    this.started = true;

    // Drop pending updates
    try {
      await this.bot.api.deleteWebhook({ drop_pending_updates: true });
      // Consume any remaining updates
      await this.bot.api.getUpdates({ offset: -1, limit: 1 });
    } catch {}

    let offset = 0;
    while (this.started) {
      try {
        const updates = await this.bot.api.getUpdates({
          offset,
          timeout: 30,
          allowed_updates: ["message"],
        });

        if (updates.length > 0) {
          console.log(`[telegram] Received ${updates.length} update(s)`);
        }
        for (const update of updates) {
          offset = update.update_id + 1;
          const text = update.message?.text?.slice(0, 50) || "(non-text)";
          const from = update.message?.from?.username || update.message?.from?.id || "?";
          console.log(`[telegram] Processing: ${from}: ${text}`);
          // Feed update to grammY's middleware stack
          try {
            await this.bot.handleUpdate(update);
          } catch (err: any) {
            console.error("[telegram] Handler error:", err.message);
          }
        }
      } catch (err: any) {
        if (err?.error_code === 409) {
          console.warn("[telegram] Polling conflict, waiting 5s...");
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        console.error("[telegram] Poll error:", err.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.bot.stop();
    this.started = false;
    console.log("[telegram] Bot stopped");
  }

  // ── Helpers ───────────────────────────────────────────

  private getActiveAgent(): any {
    // If specific agent ID set, use it
    if (this.activeAgentId) {
      const agent = this.runtime.getAgent(this.activeAgentId);
      if (agent?.status === "running") return agent;
    }

    // Fall back to first running agent
    const agents = this.runtime.listAgents();
    const running = agents.find((a) => a.status === "running");
    if (running) {
      this.activeAgentId = running.id;
      return running;
    }

    return null;
  }

  private shouldRespond(ctx: Context): boolean {
    // Check chat ID whitelist
    if (this.config.allowedChatIds?.length) {
      const chatId = String(ctx.chat?.id);
      if (!this.config.allowedChatIds.includes(chatId)) return false;
    }

    // Check forum topic restriction
    if (this.config.testTopicId) {
      const threadId = ctx.message?.message_thread_id;
      if (threadId !== this.config.testTopicId) return false;
    }

    return true;
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      // Find a good split point (newline or space)
      let splitAt = remaining.lastIndexOf("\n", maxLen);
      if (splitAt < maxLen * 0.5) {
        splitAt = remaining.lastIndexOf(" ", maxLen);
      }
      if (splitAt < maxLen * 0.3) {
        splitAt = maxLen;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    return chunks;
  }

}
