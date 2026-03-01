import { app, BrowserWindow, ipcMain, shell, screen, Menu, MenuItem } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { spawn, spawnSync } from 'child_process'
import { readFileSync, readdirSync, mkdirSync, renameSync, existsSync, unlinkSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { randomUUID } from 'crypto'
import * as chokidar from 'chokidar'

process.on('unhandledRejection', (reason) => {
  console.warn('[main] unhandledRejection (non-fatal):', reason)
})

const Database = require('better-sqlite3')

const WORKSPACE_DIR = '/workspace/synced/opai'
const HITL_DIR = join(WORKSPACE_DIR, 'reports/HITL')
const HITL_DONE_DIR = join(HITL_DIR, 'done')
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude/projects')
const DB_DIR = join(homedir(), '.scc-ide')
const DB_PATH = join(DB_DIR, 'conversations.db')
const TEMP_UPLOAD_DIR = join(tmpdir(), 'scc-ide-uploads')

function findClaudeBin(): string {
  const nvmPath = join(homedir(), '.nvm/versions/node/v20.19.5/bin/claude')
  if (existsSync(nvmPath)) return nvmPath
  return 'claude'
}

const CLAUDE_BIN = findClaudeBin()

let mainWindow: BrowserWindow | null = null
let claudeProcess: ReturnType<typeof spawn> | null = null
let squadProcess: ReturnType<typeof spawn> | null = null
let hitlWatcher: chokidar.FSWatcher | null = null
let db: any = null
let preMaximizeBounds: Electron.Rectangle | null = null

function initDB(): void {
  mkdirSync(DB_DIR, { recursive: true })
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      session_id TEXT PRIMARY KEY,
      cwd TEXT,
      title TEXT,
      pinned INTEGER DEFAULT 0,
      created_at INTEGER,
      last_at INTEGER,
      message_count INTEGER,
      deleted INTEGER DEFAULT 0
    )
  `)
  // Migrate existing DBs that lack new columns
  try { db.exec(`ALTER TABLE conversations ADD COLUMN deleted INTEGER DEFAULT 0`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE conversations ADD COLUMN total_cost_usd REAL`) } catch { /* already exists */ }
}

function getWorkArea(): Electron.Rectangle {
  try {
    const result = spawnSync('xprop', ['-root', '_NET_WORKAREA'], { encoding: 'utf8' })
    if (result.status === 0 && result.stdout) {
      const match = result.stdout.match(/=\s*([\d,\s]+)/)
      if (match) {
        const nums = match[1].split(',').map((n) => parseInt(n.trim(), 10))
        if (nums.length >= 4 && nums.every((n) => !isNaN(n))) {
          return { x: nums[0], y: nums[1], width: nums[2], height: nums[3] }
        }
      }
    }
  } catch {
    // ignore
  }
  return screen.getPrimaryDisplay().workArea
}

function getWindowBounds(): Electron.Rectangle {
  const wa = getWorkArea()
  const bottomMargin = Math.round(wa.height * 0.1)
  return {
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height - bottomMargin,
  }
}

function createWindow(): void {
  const wb = getWindowBounds()
  mainWindow = new BrowserWindow({
    x: wb.x,
    y: wb.y,
    width: wb.width,
    height: wb.height,
    minWidth: 800,
    minHeight: 500,
    show: false,
    frame: false, // frameless — renderer draws custom titlebar
    autoHideMenuBar: true,
    backgroundColor: '#0d0d1a',
    title: 'SCC IDE',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: true,
      contextIsolation: true,
      spellcheck: true,
    },
  })

  mainWindow.on('ready-to-show', () => {
    const wb2 = getWindowBounds()
    const elec = screen.getPrimaryDisplay()
    console.log('[scc] windowBounds (10% bottom margin):', JSON.stringify(wb2))
    console.log('[scc] electron bounds:', JSON.stringify(elec.bounds))
    console.log('[scc] electron workArea:', JSON.stringify(elec.workArea))
    mainWindow!.setBounds(wb2)
    mainWindow!.show()
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setBounds(getWindowBounds())
        console.log('[scc] post-show bounds:', JSON.stringify(mainWindow.getBounds()))
      }
    }, 150)
    if (!preMaximizeBounds) {
      preMaximizeBounds = {
        x: wb2.x + Math.round(wb2.width * 0.1),
        y: wb2.y + Math.round(wb2.height * 0.1),
        width: Math.round(wb2.width * 0.8),
        height: Math.round(wb2.height * 0.8),
      }
    }
  })

  screen.on('display-metrics-changed', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const updated = getWorkArea()
    const b = mainWindow.getBounds()
    const wb2 = getWindowBounds()
    if (!preMaximizeBounds) {
      mainWindow.setBounds(wb2)
    } else {
      preMaximizeBounds = {
        x: Math.max(wb2.x, Math.min(preMaximizeBounds.x, wb2.x + wb2.width - 400)),
        y: Math.max(wb2.y, Math.min(preMaximizeBounds.y, wb2.y + wb2.height - 300)),
        width: Math.min(preMaximizeBounds.width, wb2.width),
        height: Math.min(preMaximizeBounds.height, wb2.height),
      }
      const newB = {
        x: Math.max(updated.x, Math.min(b.x, updated.x + updated.width - b.width)),
        y: Math.max(updated.y, Math.min(b.y, updated.y + updated.height - b.height)),
        width: Math.min(b.width, updated.width),
        height: Math.min(b.height, updated.height),
      }
      if (newB.x !== b.x || newB.y !== b.y || newB.width !== b.width || newB.height !== b.height) {
        mainWindow.setBounds(newB)
      }
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('context-menu', (_event, params) => {
    const menu = new Menu()
    if (params.misspelledWord) {
      if (params.dictionarySuggestions.length > 0) {
        for (const suggestion of params.dictionarySuggestions) {
          menu.append(
            new MenuItem({
              label: suggestion,
              click: () => mainWindow!.webContents.replaceMisspelling(suggestion),
            })
          )
        }
      } else {
        menu.append(new MenuItem({ label: 'No suggestions', enabled: false }))
      }
      menu.append(
        new MenuItem({
          label: 'Add to Dictionary',
          click: () =>
            mainWindow!.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        })
      )
      menu.append(new MenuItem({ type: 'separator' }))
    }
    if (params.isEditable) {
      menu.append(new MenuItem({ label: 'Undo', role: 'undo' }))
      menu.append(new MenuItem({ label: 'Redo', role: 'redo' }))
      menu.append(new MenuItem({ type: 'separator' }))
      menu.append(
        new MenuItem({ label: 'Cut', role: 'cut', enabled: params.selectionText.length > 0 })
      )
      menu.append(
        new MenuItem({ label: 'Copy', role: 'copy', enabled: params.selectionText.length > 0 })
      )
      menu.append(new MenuItem({ label: 'Paste', role: 'paste' }))
      menu.append(new MenuItem({ type: 'separator' }))
      menu.append(new MenuItem({ label: 'Select All', role: 'selectAll' }))
    } else if (params.selectionText.length > 0) {
      menu.append(new MenuItem({ label: 'Copy', role: 'copy' }))
    }
    if (menu.items.length > 0) {
      menu.popup({ window: mainWindow! })
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function startHITLWatcher(): void {
  mkdirSync(HITL_DONE_DIR, { recursive: true })
  hitlWatcher = chokidar.watch(HITL_DIR, {
    depth: 0, // only top-level, not done/ subdirectory
    ignoreInitial: true,
    ignored: [HITL_DONE_DIR, join(HITL_DONE_DIR, '**')],
    usePolling: true, // polling avoids inotify limit on busy systems
    interval: 10000, // check every 10s
  })
  hitlWatcher.on('error', (err: any) => {
    console.warn('HITL watcher error (non-fatal):', err.message)
  })
  hitlWatcher.on('add', (filePath: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hitl:new', {
        filename: filePath.split('/').pop(),
        path: filePath,
      })
    }
  })
}

function registerIPC(): void {
  // -- Spawn claude CLI --
  ipcMain.handle('claude:spawn', async (_event, opts: {
    prompt: string
    sessionId?: string
    cwd?: string
    model?: string
    images?: Array<{ base64: string; mimeType: string; name: string }>
  }) => {
    if (claudeProcess) {
      claudeProcess.kill('SIGTERM')
      claudeProcess = null
    }

    const hasImages = Array.isArray(opts.images) && opts.images.length > 0

    const args = ['--output-format', 'stream-json', '--verbose']
    if (opts.sessionId) {
      args.push('--resume', opts.sessionId)
    }
    if (hasImages) {
      // Multimodal: -p enables print mode; --input-format stream-json means the actual prompt
      // comes from stdin as a JSON event (written after spawn). The -p argument is intentionally
      // empty — content comes exclusively from the stdin JSON message.
      args.push('-p', '')
      args.push('--input-format', 'stream-json')
    } else {
      args.push('-p', opts.prompt)
    }
    if (opts.model) {
      args.push('--model', opts.model)
    }
    // Pre-approve safe read-only tools so they don't block on permission cards.
    // Write/Edit/Bash still require explicit HITL approval.
    args.push('--allowedTools', 'Read', 'Glob', 'Grep', 'LS')

    const env = { ...process.env }
    delete env['CLAUDECODE']

    claudeProcess = spawn(CLAUDE_BIN, args, {
      cwd: opts.cwd,
      env,
      // stdin=pipe so permission responses can be written back to Claude.
      // IMPORTANT: we must call stdin.end() after the result event, otherwise
      // Claude Code's stdin reader keeps its event loop alive and the process hangs.
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stderrBuf = ''
    let capturedSessionId: string | null = opts.sessionId || null
    let capturedCostUsd: number | null = null
    let messageCount = 0

    claudeProcess.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        // Parse for session tracking (don't block on failure)
        try {
          const parsed = JSON.parse(trimmed)
          // system/init gives us the session_id immediately — upsert right away so sidebar shows it
          if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
            capturedSessionId = parsed.session_id
            if (db) {
              try {
                const initTitle = opts.prompt.slice(0, 80).trim() || 'Untitled'
                const now = Date.now()
                db.prepare(`
                  INSERT INTO conversations (session_id, cwd, title, created_at, last_at, message_count, deleted)
                  VALUES (@session_id, @cwd, @title, @created_at, @last_at, @message_count, 0)
                  ON CONFLICT(session_id) DO UPDATE SET last_at = @last_at WHERE deleted = 0
                `).run({ session_id: capturedSessionId, cwd: opts.cwd || WORKSPACE_DIR, title: initTitle, created_at: now, last_at: now, message_count: 1 })
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('conversation-updated', { sessionId: capturedSessionId, title: initTitle })
                }
              } catch { /* non-fatal */ }
            }
          }
          // permission_request: Claude needs human approval before using a tool
          // Claude Code 2.x sends {type:'system', subtype:'permission_request'} or {type:'permission_request'}
          if ((parsed.type === 'system' && parsed.subtype === 'permission_request') || parsed.type === 'permission_request') {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('claude:permission-request', {
                requestId: parsed.request_id,
                toolUseId: parsed.tool_use_id,
                toolName: parsed.tool_name || 'tool',
                content: parsed.content || `Allow: ${parsed.tool_name}`,
              })
            }
          }
          // result event confirms completion and carries cost
          if (parsed.type === 'result') {
            if (parsed.session_id) capturedSessionId = parsed.session_id
            // Claude Code uses various field names across versions
            const cost = parsed.cost_usd ?? parsed.total_cost_usd ?? parsed.costUSD ?? null
            if (cost != null) capturedCostUsd = cost
            // Close stdin so Claude Code's event loop can end and the process exits.
            // Without this, Claude Code's stdin reader keeps the process alive indefinitely.
            if (claudeProcess?.stdin) claudeProcess.stdin.end()
          }
          if (parsed.type === 'user' || parsed.type === 'assistant') {
            messageCount++
          }
        } catch {
          // ignore
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('claude:stream', { data: trimmed, sessionId: capturedSessionId })
        }
      }
    })

    claudeProcess.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString()
    })

    claudeProcess.on('close', (code: number | null) => {
      if (capturedSessionId && code === 0 && db) {
        try {
          const now = Date.now()
          let title = 'Untitled'
          let totalMessages = messageCount
          try {
            const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
            for (const dir of projectDirs) {
              if (!dir.isDirectory()) continue
              const filePath = join(CLAUDE_PROJECTS_DIR, dir.name, `${capturedSessionId}.jsonl`)
              if (existsSync(filePath)) {
                const content = readFileSync(filePath, 'utf8')
                const lines = content.split('\n').filter((l) => l.trim())
                totalMessages = Math.max(totalMessages, lines.length)
                let totalCost = 0
                for (const l of lines) {
                  try {
                    const p = JSON.parse(l)
                    // Sum costUSD from all assistant lines
                    if (p.costUSD != null) totalCost += Number(p.costUSD)
                    // Extract title from first user message
                    if (title === 'Untitled' && (p.type === 'user' || p.role === 'user') && p.message) {
                      const blocks = Array.isArray(p.message.content) ? p.message.content : []
                      const textBlock = blocks.find((b: any) => b.type === 'text')
                      if (textBlock?.text) title = String(textBlock.text).slice(0, 80).trim() || 'Untitled'
                    }
                  } catch { /* ignore */ }
                }
                // Use capturedCostUsd (from live result event) if JSONL didn't have it
                if (totalCost === 0 && capturedCostUsd != null) totalCost = capturedCostUsd
                capturedCostUsd = totalCost > 0 ? totalCost : capturedCostUsd
                break
              }
            }
          } catch {
            // ignore
          }
          const stmt = db.prepare(`
            INSERT INTO conversations (session_id, cwd, title, created_at, last_at, message_count, deleted, total_cost_usd)
            VALUES (@session_id, @cwd, @title, @created_at, @last_at, @message_count, 0, @total_cost_usd)
            ON CONFLICT(session_id) DO UPDATE SET
              title = @title,
              last_at = @last_at,
              message_count = @message_count,
              total_cost_usd = COALESCE(@total_cost_usd, total_cost_usd)
            WHERE deleted = 0
          `)
          stmt.run({
            session_id: capturedSessionId,
            cwd: opts.cwd || WORKSPACE_DIR,
            title,
            created_at: now,
            last_at: now,
            message_count: totalMessages,
            total_cost_usd: capturedCostUsd,
          })
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('conversation-updated', {
              sessionId: capturedSessionId,
              title,
              totalCostUsd: capturedCostUsd,
            })
          }
        } catch (err: any) {
          console.warn('[scc] auto-upsert conversation failed:', err.message)
        }
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('claude:done', {
          code,
          stderr: stderrBuf,
          sessionId: capturedSessionId,
          costUsd: capturedCostUsd,
        })
      }
      claudeProcess = null
    })

    claudeProcess.on('error', (err: Error) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('claude:error', { message: err.message })
      }
      claudeProcess = null
    })

    // Write the initial multimodal user message to stdin when using --input-format stream-json.
    // Claude Code's stream-json input expects: {"type":"user","message":{"role":"user","content":[...]}}
    // Image blocks come first (vision), then the text block.
    if (hasImages && claudeProcess.stdin) {
      const contentBlocks: Array<Record<string, unknown>> = []
      for (const img of opts.images!) {
        contentBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType || 'image/png', data: img.base64 },
        })
      }
      if (opts.prompt) {
        contentBlocks.push({ type: 'text', text: opts.prompt })
      }
      const userMsg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: contentBlocks },
      }) + '\n'
      claudeProcess.stdin.write(userMsg)
      // stdin stays open for permission responses; closed after result event as normal
    }

    return { started: true }
  })

  ipcMain.handle('claude:stop', async () => {
    if (claudeProcess) {
      claudeProcess.kill('SIGTERM')
      claudeProcess = null
      return { stopped: true }
    }
    return { stopped: false }
  })

  ipcMain.handle('claude:permission-respond', async (_event, data: { requestId: string; approved: boolean }) => {
    if (!data.approved) {
      // Denied: kill the process immediately
      if (claudeProcess) {
        claudeProcess.kill('SIGTERM')
        claudeProcess = null
      }
      return { sent: true, approved: false }
    }
    // Approved: write permission_response JSON to stdin
    if (!claudeProcess?.stdin || claudeProcess.stdin.destroyed) return { sent: false }
    try {
      const response = JSON.stringify({
        type: 'permission_response',
        request_id: data.requestId,
        approved: true,
        reason: '',
      }) + '\n'
      claudeProcess.stdin.write(response)
      return { sent: true, approved: true }
    } catch (err: any) {
      console.error('[scc] permission-respond write error:', err.message)
      return { sent: false }
    }
  })

  ipcMain.handle('sessions:list', async () => {
    try {
      if (!existsSync(CLAUDE_PROJECTS_DIR)) return []
      const results: any[] = []
      const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue
        const projectPath = join(CLAUDE_PROJECTS_DIR, dir.name)
        let files: string[]
        try {
          files = readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'))
        } catch {
          continue
        }
        let cwd = ''
        try {
          cwd = Buffer.from(dir.name, 'base64').toString('utf8')
        } catch {
          cwd = dir.name
        }
        for (const file of files) {
          const filePath = join(projectPath, file)
          try {
            const content = readFileSync(filePath, 'utf8')
            const lines = content.split('\n').filter((l) => l.trim())
            if (lines.length === 0) continue
            let title = 'Untitled'
            let messageCount = 0
            for (const line of lines) {
              try {
                const parsed = JSON.parse(line)
                if (parsed.type === 'human' || parsed.role === 'user') {
                  messageCount++
                  if (title === 'Untitled') {
                    const text =
                      typeof parsed.message === 'string'
                        ? parsed.message
                        : parsed.content || parsed.text || ''
                    title = text.slice(0, 120) || 'Untitled'
                  }
                } else if (parsed.type === 'assistant' || parsed.role === 'assistant') {
                  messageCount++
                }
              } catch {
                // ignore
              }
            }
            const stat = statSync(filePath)
            const sessionId = file.replace('.jsonl', '')
            results.push({ sessionId, cwd, title, lastAt: stat.mtimeMs, messageCount })
          } catch {
            // ignore
          }
        }
      }
      results.sort((a, b) => b.lastAt - a.lastAt)
      return results
    } catch (err: any) {
      console.error('sessions:list error:', err.message)
      return []
    }
  })

  ipcMain.handle('sessions:delete', async (_event, sessionId: string) => {
    try {
      if (!existsSync(CLAUDE_PROJECTS_DIR)) return { deleted: false }
      const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue
        const filePath = join(CLAUDE_PROJECTS_DIR, dir.name, `${sessionId}.jsonl`)
        if (existsSync(filePath)) {
          unlinkSync(filePath)
          return { deleted: true }
        }
      }
      return { deleted: false }
    } catch (err: any) {
      return { deleted: false, error: err.message }
    }
  })

  ipcMain.handle('shell:open', async (_event, target: string) => {
    await shell.openExternal(target)
  })

  // -- Run a squad --
  ipcMain.handle('squad:run', async (_event, opts: { squadName: string; task?: string }) => {
    if (squadProcess) {
      squadProcess.kill('SIGTERM')
      squadProcess = null
    }
    const args = ['-s', opts.squadName]
    if (opts.task) {
      args.push('--task', opts.task)
    }
    squadProcess = spawn('./scripts/run_squad.sh', args, {
      cwd: WORKSPACE_DIR,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    squadProcess.stdout?.on('data', (chunk: Buffer) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('squad:output', chunk.toString())
      }
    })
    squadProcess.stderr?.on('data', (chunk: Buffer) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('squad:output', chunk.toString())
      }
    })
    squadProcess.on('close', (code: number | null) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('squad:done', { code })
      }
      squadProcess = null
    })
    return { started: true }
  })

  ipcMain.handle('hitl:list', async () => {
    try {
      mkdirSync(HITL_DIR, { recursive: true })
      const entries = readdirSync(HITL_DIR, { withFileTypes: true })
      return entries
        .filter((e) => e.isFile())
        .map((e) => ({
          filename: e.name,
          path: join(HITL_DIR, e.name),
          mtime: statSync(join(HITL_DIR, e.name)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime)
    } catch (err: any) {
      console.error('hitl:list error:', err.message)
      return []
    }
  })

  ipcMain.handle('hitl:done', async (_event, filename: string) => {
    try {
      mkdirSync(HITL_DONE_DIR, { recursive: true })
      const src = join(HITL_DIR, filename)
      const dest = join(HITL_DONE_DIR, filename)
      if (existsSync(src)) {
        renameSync(src, dest)
        return { moved: true }
      }
      return { moved: false }
    } catch (err: any) {
      return { moved: false, error: err.message }
    }
  })

  ipcMain.handle('hitl:read', async (_event, filename: string) => {
    try {
      const filePath = join(HITL_DIR, filename)
      if (!existsSync(filePath)) return { content: null }
      return { content: readFileSync(filePath, 'utf8') }
    } catch (err: any) {
      return { content: null, error: err.message }
    }
  })

  ipcMain.handle('app:version', async () => {
    return app.getVersion()
  })

  ipcMain.handle('window:minimize', async () => {
    mainWindow?.minimize()
  })

  ipcMain.handle('window:maximize', async () => {
    if (!mainWindow) return
    if (preMaximizeBounds) {
      mainWindow.setBounds(preMaximizeBounds)
      preMaximizeBounds = null
    } else {
      preMaximizeBounds = mainWindow.getBounds()
      mainWindow.setBounds(getWindowBounds())
    }
  })

  ipcMain.handle('window:close', async () => {
    mainWindow?.close()
  })

  // -- Upsert a conversation record --
  ipcMain.handle('db:upsert-conversation', async (_event, data: any) => {
    try {
      const now = Date.now()
      const stmt = db.prepare(`
        INSERT INTO conversations (session_id, cwd, title, created_at, last_at, message_count)
        VALUES (@session_id, @cwd, @title, @created_at, @last_at, @message_count)
        ON CONFLICT(session_id) DO UPDATE SET
          cwd = @cwd,
          title = @title,
          last_at = @last_at,
          message_count = @message_count
      `)
      stmt.run({
        session_id: data.session_id,
        cwd: data.cwd || WORKSPACE_DIR,
        title: data.title || 'Untitled',
        created_at: data.created_at || now,
        last_at: data.last_at || now,
        message_count: data.message_count || 0,
      })
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  // -- List all conversations: scan JSONL files + merge with SQLite for pinned/cached titles --
  ipcMain.handle('db:list-conversations', async () => {
    try {
      // 1. Build a map from SQLite (pinned status, cached titles, deleted flag, cost)
      const dbMap: Record<string, { pinned: number; title: string; message_count: number; deleted: number; total_cost_usd: number | null }> = {}
      const deletedSet = new Set<string>()
      try {
        const dbRows = db.prepare('SELECT session_id, pinned, title, message_count, deleted, total_cost_usd FROM conversations').all() as any[]
        for (const row of dbRows) {
          dbMap[row.session_id] = { pinned: row.pinned, title: row.title, message_count: row.message_count, deleted: row.deleted ?? 0, total_cost_usd: row.total_cost_usd ?? null }
          if (row.deleted) deletedSet.add(row.session_id)
        }
      } catch { /* ignore */ }

      // 2. Scan JSONL files from all Claude Code project dirs
      const sessions: any[] = []
      if (existsSync(CLAUDE_PROJECTS_DIR)) {
        const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
        for (const dir of projectDirs) {
          if (!dir.isDirectory()) continue
          const projectPath = join(CLAUDE_PROJECTS_DIR, dir.name)
          let files: string[]
          try { files = readdirSync(projectPath).filter((f) => f.endsWith('.jsonl')) } catch { continue }

          for (const file of files) {
            const sessionId = file.replace('.jsonl', '')
            // Skip sessions the user has deleted
            if (deletedSet.has(sessionId)) continue
            const filePath = join(projectPath, file)
            let stat: ReturnType<typeof statSync>
            try { stat = statSync(filePath) } catch { continue }

            const dbEntry = dbMap[sessionId]
            let title = (dbEntry?.title && dbEntry.title !== 'Untitled') ? dbEntry.title : null

            // Read first 4KB to extract cwd + title if not cached
            let cwd = dir.name.replace(/-/g, '/')
            if (!title) {
              try {
                const buf = Buffer.alloc(4096)
                const fd = openSync(filePath, 'r')
                const bytesRead = readSync(fd, buf, 0, 4096, 0)
                closeSync(fd)
                const chunk = buf.slice(0, bytesRead).toString('utf8')
                for (const line of chunk.split('\n')) {
                  const t = line.trim()
                  if (!t) continue
                  try {
                    const p = JSON.parse(t)
                    // Extract cwd from any line that has it
                    if (!cwd && p.cwd) cwd = p.cwd
                    if (p.cwd) cwd = p.cwd
                    // Extract title from first user message
                    if (!title && (p.type === 'user') && p.message) {
                      const content = p.message.content
                      if (typeof content === 'string' && content.trim()) {
                        title = content.slice(0, 80).trim()
                      } else if (Array.isArray(content)) {
                        const textBlock = content.find((b: any) => b.type === 'text')
                        if (textBlock?.text) title = String(textBlock.text).slice(0, 80).trim()
                      }
                    }
                    if (title && cwd) break
                  } catch { /* skip malformed */ }
                }
              } catch { /* unreadable — skip */ }
            }

            sessions.push({
              session_id: sessionId,
              cwd: cwd || WORKSPACE_DIR,
              title: title || 'Untitled',
              pinned: dbEntry?.pinned ?? 0,
              created_at: stat.birthtimeMs || stat.mtimeMs,
              last_at: stat.mtimeMs,
              message_count: dbEntry?.message_count ?? 0,
              total_cost_usd: dbEntry?.total_cost_usd ?? null,
            })
          }
        }
      }

      // 3. Cache any newly extracted titles back to SQLite (fire-and-forget)
      for (const s of sessions) {
        if (!dbMap[s.session_id] || dbMap[s.session_id].title === 'Untitled') {
          try {
            db.prepare(`
              INSERT INTO conversations (session_id, cwd, title, created_at, last_at, message_count)
              VALUES (@session_id, @cwd, @title, @created_at, @last_at, @message_count)
              ON CONFLICT(session_id) DO UPDATE SET title = @title, last_at = @last_at
            `).run(s)
          } catch { /* non-fatal */ }
        }
      }

      // 4. Sort: pinned first, then by recency
      sessions.sort((a, b) => (b.pinned - a.pinned) || (b.last_at - a.last_at))
      return sessions
    } catch (err: any) {
      console.error('db:list-conversations error:', err.message)
      return []
    }
  })

  // -- Toggle pinned status --
  ipcMain.handle('db:pin-conversation', async (_event, sessionId: string) => {
    try {
      const row = db.prepare('SELECT pinned FROM conversations WHERE session_id = ?').get(sessionId) as any
      if (!row) return { ok: false }
      const newVal = row.pinned ? 0 : 1
      db.prepare('UPDATE conversations SET pinned = ? WHERE session_id = ?').run(newVal, sessionId)
      return { ok: true, pinned: newVal }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  // -- Delete a conversation: mark deleted=1 so JSONL scan skips it --
  ipcMain.handle('db:delete-conversation', async (_event, sessionId: string) => {
    try {
      // Upsert with deleted=1 so even sessions not yet in DB are excluded on next list
      db.prepare(`
        INSERT INTO conversations (session_id, deleted) VALUES (?, 1)
        ON CONFLICT(session_id) DO UPDATE SET deleted = 1, pinned = 0
      `).run(sessionId)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  // -- Load messages from JSONL file --
  ipcMain.handle('db:load-messages', async (_event, sessionId: string) => {
    try {
      if (!existsSync(CLAUDE_PROJECTS_DIR)) return { ok: true, messages: [] }
      const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue
        const filePath = join(CLAUDE_PROJECTS_DIR, dir.name, `${sessionId}.jsonl`)
        if (!existsSync(filePath)) continue
        const content = readFileSync(filePath, 'utf8')
        const rawLines = content.split('\n').filter((l) => l.trim())

        // Claude Code JSONL is snapshot-based: a single assistant turn produces multiple lines
        // with the same uuid as content accumulates. Deduplicate by uuid, keeping only the last
        // (most complete) snapshot per message, preserving original message order.
        const uuidOrder: string[] = []
        const uuidLastLine = new Map<string, string>()
        for (const line of rawLines) {
          try {
            const p = JSON.parse(line)
            const uuid = p.uuid || null
            if (!uuid) {
              // No uuid — treat as unique (use position as key)
              const key = `__pos_${uuidOrder.length}`
              uuidOrder.push(key)
              uuidLastLine.set(key, line)
            } else {
              if (!uuidLastLine.has(uuid)) uuidOrder.push(uuid)
              uuidLastLine.set(uuid, line) // overwrite = keep last snapshot
            }
          } catch { /* skip malformed */ }
        }
        const lines = uuidOrder.map((k) => uuidLastLine.get(k)!)

        const messages: any[] = []
        for (const line of lines) {
          try {
            const p = JSON.parse(line)
            const role = p.type === 'user' ? 'user' : p.type === 'assistant' ? 'assistant' : null
            if (!role || !p.message) continue

            let content: any[]

            if (role === 'user') {
              // In Claude Code's JSONL, human-typed messages always have STRING content.
              // Array-content user messages are tool results / injected agent outputs — never show them.
              if (typeof p.message.content !== 'string') continue
              // Strip embedded data-URL lines (legacy: old prompts embedded raw base64 image content)
              const txt = p.message.content.split('\n')
                .filter((line: string) => !line.startsWith('data:image/'))
                .join('\n')
                .trim()
              if (!txt) continue
              // Skip agent/system injections (XML-tagged content like <task-notification>, <result>, etc.)
              if (/^<[a-zA-Z]/.test(txt)) continue
              content = [{ type: 'text', text: txt }]
            } else {
              // Assistant messages: convert thinking + tool_use blocks → thought_group format.
              // This guarantees loaded history always matches the live-stream format.
              if (!Array.isArray(p.message.content)) continue
              const thoughtItems: Array<{ kind: 'thought' | 'tool'; text: string; toolName?: string; elapsedSec: number }> = []
              const textBlocks: any[] = []
              for (const b of p.message.content) {
                if (b.type === 'thinking' && b.thinking) {
                  thoughtItems.push({ kind: 'thought', text: b.thinking, elapsedSec: 0 })
                } else if (b.type === 'tool_use') {
                  const name: string = b.name || 'tool'
                  const inp: Record<string, unknown> = b.input || {}
                  let detail = ''
                  if (inp.file_path) detail = String(inp.file_path)
                  else if (inp.command) detail = String(inp.command).slice(0, 120)
                  else if (inp.pattern) detail = String(inp.pattern)
                  else if (inp.path) detail = String(inp.path)
                  else if (inp.url) detail = String(inp.url)
                  else if (inp.query) detail = String(inp.query)
                  else { const keys = Object.keys(inp); if (keys.length > 0) detail = String(inp[keys[0]]).slice(0, 80) }
                  thoughtItems.push({ kind: 'tool', text: detail, toolName: name, elapsedSec: 0 })
                } else if (b.type === 'text' && b.text) {
                  textBlocks.push({ type: 'text', text: b.text })
                }
              }
              content = []
              if (thoughtItems.length > 0) content.push({ type: 'thought_group', items: thoughtItems })
              content.push(...textBlocks)
              if (content.length === 0) continue
            }

            messages.push({
              id: p.uuid || crypto.randomUUID(),
              role,
              content,
              timestamp: p.timestamp ? new Date(p.timestamp).getTime() : Date.now(),
              costUsd: p.costUSD,
            })
          } catch { /* skip malformed lines */ }
        }
        return { ok: true, messages }
      }
      return { ok: true, messages: [] }
    } catch (err: any) {
      console.error('db:load-messages error:', err.message)
      return { ok: false, messages: [], error: err.message }
    }
  })

  ipcMain.handle('status:services', async () => {
    try {
      const result = spawnSync(
        'systemctl',
        ['--user', 'list-units', 'opai-*', '--no-pager', '--no-legend', '--plain'],
        { encoding: 'utf8' }
      )
      const lines = (result.stdout || '').split('\n').filter((l) => l.trim())
      const services = lines
        .map((line) => {
          const parts = line.trim().split(/\s+/)
          const name = parts[0] ?? ''
          const active = parts[2] ?? 'unknown'
          const sub = parts[3] ?? 'unknown'
          const description = parts.slice(4).join(' ')
          const running = active === 'active' && sub === 'running'
          return { name, active, sub, running, description }
        })
        .filter((s) => s.name.endsWith('.service'))
      return { ok: true, services }
    } catch (err: any) {
      return { ok: false, error: err.message, services: [] }
    }
  })

  // -- Write temp image file for vision intake --
  ipcMain.handle('files:write-temp', async (_event, data: { dataUrl: string; name: string }) => {
    try {
      mkdirSync(TEMP_UPLOAD_DIR, { recursive: true })
      const safeName = data.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
      const filename = `${randomUUID()}-${safeName}`
      const filePath = join(TEMP_UPLOAD_DIR, filename)
      const base64 = data.dataUrl.includes(',') ? data.dataUrl.split(',')[1] : data.dataUrl
      writeFileSync(filePath, Buffer.from(base64, 'base64'))
      return { ok: true, path: filePath }
    } catch (err: any) {
      return { ok: false, error: err.message, path: null }
    }
  })

  ipcMain.handle('status:usage', async () => {
    try {
      const http = require('http')
      const data = await new Promise<string>((resolve, reject) => {
        const req = http.get('http://127.0.0.1:8081/api/monitor/claude/plan-usage', (res: any) => {
          let body = ''
          res.on('data', (chunk: Buffer) => { body += chunk.toString() })
          res.on('end', () => resolve(body))
        })
        req.on('error', reject)
        req.setTimeout(4000, () => { req.destroy(); reject(new Error('timeout')) })
      })
      return { ok: true, usage: JSON.parse(data) }
    } catch (err: any) {
      return { ok: false, error: err.message, usage: null }
    }
  })
}

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  console.log('[scc] Another instance is running. Exiting.')
  app.quit()
  process.exit(0)
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.opai.scc-ide')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
    window.webContents.on('before-input-event', (_evt, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        window.webContents.toggleDevTools()
      }
    })
  })

  initDB()
  registerIPC()
  createWindow()
  startHITLWatcher()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (claudeProcess) claudeProcess.kill('SIGTERM')
  if (squadProcess) squadProcess.kill('SIGTERM')
  if (hitlWatcher) hitlWatcher.close()
  if (db) db.close()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
