# 🚀 Anti-Gravity Handoff Protocol

## System Context
This workspace is part of a hybrid agentic workflow. 
* **Upstream:** Logic, research, and task management happen in **Obsidian** (Markdown).
* **Downstream:** Code generation, testing, and deployment happen here in **Google Antigravity**.

## 👷 Instructions for Antigravity Builder (You)

You are the **Lead Developer Agent**. Your source of truth is the `.md` file located in the root directory (e.g., `MyApp-2025.md`).

**Your Protocol:**

1.  **Read the Spec:**
    * Locate the Project file in the root.
    * Read `## I. Research & Planning` and `## II. Application Specification`.
    * *Do not deviate from these specs without asking.*
    * *If the user has updated the spec, update the markdown file and ask for approval.*

2.  **Manager View / Artifacts:**
    * Create a **Task List Artifact** in the Antigravity Manager View that matches the `### Agent Task List` in the markdown file.
    * As you complete tasks (e.g., "Build Auth Module"), mark them complete in the Artifact.

3.  **Code Generation:**
    * When generating code, prefer **verifiable artifacts** (Task Lists, Implementation Plans) before writing raw code.
    * Ensure all new files are linked or referenced back in `## III. Development & Code (WIP)` in the markdown file.

4.  **Reporting:**
    * If you encounter a blocking issue, do not just stop. Write a brief report in the `## IV. Test & Verification` section of the markdown file and await human input.