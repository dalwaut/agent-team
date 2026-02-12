# Discord Bot Setup Guide for n8n

To harness the "Discord Orchestrator," you need to create a Bot Application in discord.

## 1. Create Discord Application
1.  Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2.  Click **New Application**.
3.  Name it (e.g., `Orchestrator-Bot`).

## 2. Create Bot User
1.  Go to the **Bot** tab (left sidebar).
2.  Click **Add Bot**.
3.  **IMPORTANT**: Scroll down to "Privileged Gateway Intents" and enable:
    *   **Message Content Intent** (Required to read your chats).
    *   **Server Members Intent** (Optional, good for knowing who you are).
4.  Click **Reset Token** to get your **Bot Token**. Copy this immediately! You will need it for n8n.

## 3. Invite Bot to Server
1.  Go to **OAuth2** -> **URL Generator**.
2.  Scopes: Select `bot`.
3.  Bot Permissions: Select `Send Messages`, `Read Message History`, `View Channels` (permissions value: `68608`).
4.  Copy the URL and open it in your browser to invite the bot to your private server.

**Our bot invite URL:** `https://discord.com/oauth2/authorize?client_id=1470540768547700920&permissions=68608&integration_type=0&scope=bot`

## 4. Configure n8n
1.  Open n8n.
2.  Go to **Credentials**.
3.  Add new **Discord Bot** credential.
4.  Paste your **Bot Token**.

## 5. Import Workflow
1.  Import `discord_orchestrator.json` (located at `Library/n8n/Workflows/discord_orchestrator.json`).
2.  Open the **AI Orchestrator** node and ensure the Model implementation is set (e.g., Gemini Chat).
3.  Open the **Execute Email Agent** node and set the `Workflow ID` to your actual Email Agent workflow ID.
4.  Activate the workflow!

## Usage
Chat with your bot in a channel:
*   "Send an email to Bob saying hi" -> Triggers Email Agent.
*   "How are you?" -> AI replies directly.
