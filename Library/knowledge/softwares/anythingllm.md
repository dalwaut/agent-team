# AnythingLLM

**Type:** Open-source, self-hosted AI workspace
**Repo:** github.com/Mintplex-Labs/anything-llm
**License:** MIT
**Runs on:** Desktop app (Mac/Win/Linux) or Docker self-host

---

## What It Does

All-in-one local AI workspace that bundles what normally takes 4-5 separate tools:

- **RAG pipeline** — Drag-and-drop documents (code repos, PDFs, etc.), auto-chunks/embeds/indexes. Citations point to real file paths.
- **Chat interface** — Multi-model support, swap providers mid-conversation without reindexing
- **Visual agent builder** — Wire up tools (SQL queries, web search, file ops, MCP servers) in a node-based UI
- **Workspace isolation** — Separate projects/clients/wikis into isolated workspaces
- **REST API** — Embed private RAG into SaaS, dashboards, internal tools
- **Chat widget** — Drop-in embeddable widget for products
- **VS Code extension**

## Model Support

Bring your own: Ollama, LM Studio, Grok/xAI, OpenAI, Anthropic, and others. Lance DB as default vector store (switchable to PG Vector, Qdrant).

## Inspiration Value

| Feature | How It Maps to OPAI |
|---------|-------------------|
| Drag-and-drop RAG with citations | Brain could offer simpler document ingestion UX |
| Workspace isolation per client | Pattern for AIOS consulting — each client gets isolated workspace |
| Embeddable chat widget | Potential for client-facing AI widget in WordPress sites or portals |
| Visual agent builder | Simpler alternative to n8n for non-technical users building workflows |
| Swap models mid-conversation | Multi-model flexibility pattern for Brain or future chat tools |

## Limitations Noted

- 500+ documents eats RAM on smaller machines
- Agent flows still feel beta on edge cases
- RAG sometimes needs document pinning for perfect recall

## Source

Video: "This Open-Source Tool Replaces Ollama + LangChain + Your UI" — Better Stack (2026)
