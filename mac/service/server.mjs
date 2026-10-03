import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, statSync, realpathSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, extname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import QRCode from 'qrcode';

const here = dirname(fileURLToPath(import.meta.url));
const modes = ['bypassPermissions', 'auto', 'plan', 'acceptEdits', 'default'];
const secret = () => randomBytes(32).toString('base64url');
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (status, message) => Object.assign(new Error(message), { status });
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const text = (value, label, max = 100_000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw fail(400, `Invalid ${label}`);
  return value.trim();
};
const processStamp = pid => spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000 }).stdout?.trim();
const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch { return false; } };
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
const terminateGroup = async (pid, timeout) => {
  if (!pid) return;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) {
    try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; return; }
    const end = Date.now() + (signal === 'SIGKILL' ? 100 : timeout);
    while (groupAlive(pid) && Date.now() < end) await pause(20);
    if (!groupAlive(pid)) return;
  }
};
const mode = value => { if (!modes.includes(value)) throw fail(400, 'Unsupported permission mode'); return value; };

export async function createService(options = {}) {
  const dataDir = options.dataDir ?? process.env.POCKETBRIDGE_DATA_DIR ?? join(homedir(), 'Library/Application Support/PocketBridge');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dbPath = join(dataDir, 'data.sqlite');
  const db = new DatabaseSync(dbPath); chmodSync(dbPath, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, updatedAt INTEGER NOT NULL, error TEXT, sessionStarted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, chatId TEXT NOT NULL REFERENCES chats(id), role TEXT NOT NULL, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS prompts (id TEXT PRIMARY KEY, chatId TEXT NOT NULL, text TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, chatId TEXT NOT NULL REFERENCES chats(id), tool TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, chatId TEXT, type TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtimes (chatId TEXT PRIMARY KEY, pid INTEGER NOT NULL, startTime TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS raw_events (id INTEGER PRIMARY KEY AUTOINCREMENT, chatId TEXT NOT NULL, json TEXT NOT NULL);
  `);
  if (!db.prepare('PRAGMA table_info(prompts)').all().some(column => column.name === 'mode')) db.exec("ALTER TABLE prompts ADD COLUMN mode TEXT");
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const clients = new Set(), active = new Map(), waiting = new Map(), pairAttempts = new Map();
  let closed = false, eventTimer, latestPair, localUrl;
  const internalToken = secret();
  let localToken = get('SELECT value FROM settings WHERE key=?', 'localToken')?.value;
  if (!localToken) { run('INSERT OR IGNORE INTO settings VALUES (?,?)', 'localToken', secret()); localToken = get('SELECT value FROM settings WHERE key=?', 'localToken').value; }
  const claudePath = options.claudePath ?? process.env.POCKETBRIDGE_CLAUDE_PATH ?? 'claude';
  const claudeAvailable = options.claudeAvailable ?? spawnSync(claudePath, ['--version'], { encoding: 'utf8', timeout: 3000 }).status === 0;
  let publicUrl = options.publicUrl ?? process.env.POCKETBRIDGE_PUBLIC_URL;
  if (publicUrl) { const address = new URL(publicUrl); if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash || address.pathname !== '/') throw new Error('POCKETBRIDGE_PUBLIC_URL must be an HTTP(S) origin'); publicUrl = address.origin; }
  const lastSeq = () => Number(get('SELECT COALESCE(MAX(seq),0) AS n FROM events').n);
  const chat = id => {
    const row = get('SELECT id,projectId,title,mode,status,updatedAt,error FROM chats WHERE id=?', id);
    if (!row) throw fail(404, 'Chat not found'); if (!row.error) delete row.error; return row;
  };
  const replay = client => {
    if (closed || client.replaying || client.response.destroyed || client.response.writableEnded) return;
    client.replaying = true;
    const batch = () => {
      if (closed || client.response.destroyed || client.response.writableEnded) return;
      const events = all('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 128', client.seq);
      for (const event of events) {
        const ready = client.response.write(`id: ${event.seq}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`); client.seq = event.seq;
        if (!ready) { client.response.once('drain', batch); return; }
      }
      if (events.length === 128) setImmediate(batch);
      else client.replaying = false;
    };
    batch();
  };
  const change = (type, chatId = null) => {
    run('INSERT INTO events (chatId,type) VALUES (?,?)', chatId, type);
    // Durable rows precede notification; batch UI refreshes to avoid token-rate fetching.
    if (!eventTimer) eventTimer = setTimeout(() => { eventTimer = undefined; for (const client of clients) replay(client); }, 200);
  };
  const state = () => ({ projects: all('SELECT * FROM projects ORDER BY name'), chats: all('SELECT id,projectId,title,mode,status,updatedAt,error FROM chats ORDER BY updatedAt DESC').map(row => { if (!row.error) delete row.error; return row; }), lastSeq: lastSeq(), capabilities: { modes }, server: { claudeAvailable, publicUrl } });
  const status = (id, value, error = null) => { run('UPDATE chats SET status=?,error=?,updatedAt=? WHERE id=?', value, error, Date.now(), id); change('state', id); };
  const startTime = processStamp(process.pid);
  if (!startTime) { db.close(); throw new Error('Could not verify the Mac service process identity'); }
  const owner = JSON.stringify({ pid: process.pid, startTime });
  try {
    transaction(() => {
      const previous = get('SELECT value FROM settings WHERE key=?', 'serviceOwner');
      if (previous) {
        const processOwner = JSON.parse(previous.value);
        if (processOwner.startTime && processStamp(processOwner.pid) === processOwner.startTime) throw new Error('PocketBridge is already running with this data folder');
      } else if (existsSync(join(dataDir, 'service.pid'))) {
        const pid = Number(readFileSync(join(dataDir, 'service.pid'), 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
          const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 }).stdout?.trim();
          if (command?.includes('/scripts/run.mjs')) throw new Error('PocketBridge is already running. Stop the older service before starting this update');
        }
      }
      run('INSERT OR REPLACE INTO settings VALUES (?,?)', 'serviceOwner', owner);
    });
  } catch (error) { db.close(); throw error; }
  const releaseOwner = () => run('DELETE FROM settings WHERE key=? AND value=?', 'serviceOwner', owner);
  try {
    // A crashed service may leave its detached CLI running. Kill only the same OS process, never a reused PID.
    for (const runtime of all('SELECT * FROM runtimes')) if (runtime.startTime && processStamp(runtime.pid) === runtime.startTime) await terminateGroup(runtime.pid, options.stopTimeoutMs ?? 1000);
    run('DELETE FROM runtimes');
    for (const row of all("SELECT id FROM chats WHERE status IN ('running','stopping','waiting')")) {
      status(row.id, 'interrupted', 'Mac service restarted during this task. Review the conversation before continuing.');
      run("UPDATE approvals SET status='deny' WHERE chatId=? AND status='pending'", row.id);
    }
  } catch (error) { clearTimeout(eventTimer); releaseOwner(); db.close(); throw error; }
  const message = (chatId, role, value, id = randomUUID()) => { run('INSERT INTO messages VALUES (?,?,?,?,?)', id, chatId, role, value, Date.now()); change('message', chatId); return id; };
  const cancelApprovals = id => {
    for (const [approvalId, entry] of waiting) if (entry.chatId === id) {
      run("UPDATE approvals SET status='deny' WHERE id=?", approvalId); entry.resolve({ behavior: 'deny', message: 'User stopped the task', interrupt: true }); waiting.delete(approvalId); change('approval', id);
    }
  };
  const stop = id => {
    chat(id); const entry = active.get(id); if (!entry || entry.stopped) return;
    entry.stopped = true; status(id, 'stopping'); cancelApprovals(id);
    entry.stopPromise = terminateGroup(entry.child.pid, options.stopTimeoutMs ?? 3000);
  };

  function start(id, prompt) {
    const row = get('SELECT * FROM chats WHERE id=?', id), project = get('SELECT * FROM projects WHERE id=?', row.projectId);
    const bridgePath = join(here, 'approval-bridge.mjs');
    const bridgeEnv = { POCKETBRIDGE_INTERNAL_URL: localUrl, POCKETBRIDGE_INTERNAL_TOKEN: internalToken, POCKETBRIDGE_CHAT_ID: id };
    const settings = { hooks: { PreToolUse: [{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: [{ type: 'command', command: `${shellQuote(process.execPath)} ${shellQuote(bridgePath)} --hook`, timeout: 86400 }] }] } };
    const mcp = { mcpServers: { pocketbridge: { type: 'stdio', command: process.execPath, args: [bridgePath], env: bridgeEnv } } };
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', row.mode, row.sessionStarted ? '--resume' : '--session-id', id, '--settings', JSON.stringify(settings), '--mcp-config', JSON.stringify(mcp), '--permission-prompt-tool', 'mcp__pocketbridge__approve'];
    if (row.mode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
    const env = { ...process.env, ...bridgeEnv };
    // Subscription login stays inside the official binary; inherited API overrides must not change billing.
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_RESUME_INTERRUPTED_TURN', 'CLAUDE_CODE_SKIP_PROMPT_HISTORY', 'CLAUDE_CODE_SIMPLE']) delete env[key];
    const child = spawn(claudePath, args, { cwd: project.path, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const entry = { child, stopped: false, assistantId: null, buffer: '', stderr: '', result: null, parseError: null, sawText: false };
    active.set(id, entry);
    if (child.pid) run('INSERT OR REPLACE INTO runtimes VALUES (?,?,?)', id, child.pid, processStamp(child.pid) ?? '');
    const append = value => {
      if (!value) return; entry.sawText = true;
      if (!entry.assistantId) entry.assistantId = message(id, 'assistant', value);
      else { run('UPDATE messages SET text=text||? WHERE id=?', value, entry.assistantId); change('message', id); }
    };
    const consume = line => {
      if (!line.trim()) return; let event;
      try { event = JSON.parse(line); } catch { entry.parseError = 'Claude returned malformed structured output.'; return; }
      run('INSERT INTO raw_events (chatId,json) VALUES (?,?)', id, line);
      const malformed = () => { entry.parseError = 'Claude returned malformed structured output.'; };
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') { malformed(); return; }
      if (['assistant', 'user'].includes(event.type) && (!Array.isArray(event.message?.content) || event.message.content.some(block => !block || typeof block !== 'object' || typeof block.type !== 'string' || (block.type === 'text' && typeof block.text !== 'string')))) { malformed(); return; }
      if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta' && typeof event.event.delta.text !== 'string') { malformed(); return; }
      if (event.type === 'result' && ((event.result !== undefined && typeof event.result !== 'string') || (event.errors !== undefined && (!Array.isArray(event.errors) || event.errors.some(error => typeof error !== 'string'))))) { malformed(); return; }
      if (event.type === 'system' && event.subtype === 'init') run('UPDATE chats SET sessionStarted=1 WHERE id=?', id);
      if (event.type === 'stream_event') {
        if (event.event?.type === 'message_start') entry.assistantId = null;
        if (event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') append(event.event.delta.text);
      }
      if (event.type === 'assistant') {
        const blocks = event.message?.content ?? [], finalText = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
        if (finalText) {
          if (!entry.assistantId) append(finalText);
          else { run('UPDATE messages SET text=? WHERE id=?', finalText, entry.assistantId); change('message', id); }
        }
        for (const block of blocks) if (block.type === 'tool_use') message(id, 'activity', `${block.name}\n${JSON.stringify(block.input, null, 2)}`);
        entry.assistantId = null;
      }
      if (event.type === 'user') for (const block of event.message?.content ?? []) if (block.type === 'tool_result') message(id, 'activity', `${block.is_error ? 'Tool failed' : 'Tool result'}\n${typeof block.content === 'string' ? block.content : JSON.stringify(block.content)}`);
      if (event.type === 'system' && ['permission_denied', 'warning', 'error'].includes(event.subtype)) message(id, 'activity', typeof event.message === 'string' ? event.message : JSON.stringify(event));
      if (event.type === 'result') { entry.result = event; run('UPDATE chats SET sessionStarted=1 WHERE id=?', id); if (event.result && !entry.sawText) append(event.result); }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      entry.buffer += chunk;
      if (entry.buffer.length > 10_000_000) { entry.parseError = 'Claude output exceeded the structured event limit.'; stop(id); return; }
      let newline; while ((newline = entry.buffer.indexOf('\n')) !== -1) { consume(entry.buffer.slice(0, newline)); entry.buffer = entry.buffer.slice(newline + 1); }
    });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { entry.stderr = (entry.stderr + chunk).slice(-16_000); });
    child.stdin.on('error', () => {}); child.on('error', error => { entry.parseError = `Could not start Claude: ${error.message}`; });
    child.on('close', async (code, signal) => {
      if (entry.buffer.trim()) consume(entry.buffer);
      // Tool processes can outlive the CLI even after a completed result.
      await (entry.stopPromise ?? terminateGroup(child.pid, options.stopTimeoutMs ?? 3000));
      active.delete(id); run('DELETE FROM runtimes WHERE chatId=?', id); cancelApprovals(id);
      if (entry.stopped) status(id, 'interrupted', 'Stopped by you. Completed changes remain on disk.');
      else if (entry.parseError || code !== 0 || entry.result?.is_error || !entry.result) status(id, 'error', entry.parseError ?? (entry.result?.errors?.join('\n') || entry.result?.result || entry.stderr.trim() || `Claude exited ${code ?? signal} without a completed result.`));
      else status(id, 'idle');
    });
    child.stdin.end(prompt);
  }

  const json = (response, code, value) => { response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
  const body = async request => {
    let value = '', size = 0; for await (const chunk of request) { size += chunk.length; if (size > 200_000) throw fail(413, 'Request too large'); value += chunk; }
    if (closed) throw fail(503, 'Mac service is shutting down');
    try { const result = JSON.parse(value); if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(); return result; } catch { throw fail(400, 'Invalid JSON body'); }
  };
  const pairing = () => {
    const code = randomBytes(5).toString('hex').toUpperCase();
    latestPair = { code, expiresAt: Date.now() + 600_000, url: publicUrl, link: `pocketbridge://pair?url=${encodeURIComponent(publicUrl)}&code=${code}` }; return latestPair;
  };
  const server = http.createServer(async (request, response) => {
    try {
      if (closed) throw fail(503, 'Mac service is shutting down');
      const port = server.address().port;
      const allowedHosts = new Set([new URL(localUrl).host, `localhost:${port}`, `10.0.2.2:${port}`, new URL(publicUrl).host]);
      if (!allowedHosts.has(request.headers.host)) throw fail(403, 'Unknown host');
      if (request.headers.origin && ![localUrl, localUrl.replace('127.0.0.1', 'localhost'), publicUrl].includes(request.headers.origin)) throw fail(403, 'Unknown origin');
      const url = new URL(request.url, localUrl), route = url.pathname, bearer = request.headers.authorization?.replace(/^Bearer /, '');
      if (route === '/internal/approval' && request.method === 'POST') {
        if (!loopback(request.socket.remoteAddress) || !equal(bearer, internalToken)) throw fail(401, 'Unauthorized');
        const input = await body(request);
        if (!active.has(input.chatId) || active.get(input.chatId).stopped) throw fail(409, 'Task is no longer running');
        const tool = text(input.tool, 'tool', 200), toolInput = input.input && typeof input.input === 'object' && !Array.isArray(input.input) ? input.input : {}, id = randomUUID();
        run('INSERT INTO approvals VALUES (?,?,?,?,?,?)', id, input.chatId, tool, JSON.stringify(toolInput), 'pending', Date.now()); status(input.chatId, 'waiting'); change('approval', input.chatId);
        const answer = await new Promise(resolveDecision => {
          waiting.set(id, { chatId: input.chatId, resolve: resolveDecision });
          response.once('close', () => {
            if (waiting.has(id)) { waiting.delete(id); run("UPDATE approvals SET status='deny' WHERE id=?", id); change('approval', input.chatId); resolveDecision({ behavior: 'deny', message: 'Permission host disconnected' }); }
          });
        });
        if (!response.destroyed) json(response, 200, answer); return;
      }
      if (route === '/api/health' && request.method === 'GET') return json(response, 200, { ok: true, version: 1 });
      if (route === '/api/local-session' && request.method === 'GET') {
        if (!loopback(request.socket.remoteAddress) || ![new URL(localUrl).host, `localhost:${port}`].includes(request.headers.host) || Object.keys(request.headers).some(key => key.startsWith('x-forwarded-') || key === 'forwarded') || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) throw fail(403, 'Local session is only available directly on this Mac');
        return json(response, 200, { token: localToken });
      }
      if (route === '/api/pair' && request.method === 'POST') {
        const key = request.socket.remoteAddress, attempt = pairAttempts.get(key) ?? { count: 0, until: Date.now() + 60_000 };
        if (attempt.until < Date.now()) { attempt.count = 0; attempt.until = Date.now() + 60_000; } attempt.count++; pairAttempts.set(key, attempt);
        if (attempt.count > 10) throw fail(429, 'Too many pairing attempts; wait a minute');
        const input = await body(request);
        if (!latestPair || latestPair.expiresAt < Date.now() || !equal(typeof input.code === 'string' ? input.code.toUpperCase() : undefined, latestPair.code)) throw fail(401, 'Pairing code is invalid or expired');
        latestPair = undefined; const token = secret(); run('INSERT INTO tokens VALUES (?,?)', token, Date.now()); return json(response, 200, { token });
      }
      if (route.startsWith('/api/')) {
        if (!equal(bearer, localToken) && !(typeof bearer === 'string' && get('SELECT token FROM tokens WHERE token=?', bearer))) throw fail(401, 'Unauthorized');
        if (route === '/api/state' && request.method === 'GET') return json(response, 200, state());
        if (route === '/api/pairing' && request.method === 'GET') return json(response, 200, pairing());
        if (route === '/api/pairing/qr' && request.method === 'GET') {
          if (!latestPair || latestPair.expiresAt < Date.now() || (url.searchParams.has('code') && url.searchParams.get('code') !== latestPair.code)) throw fail(410, 'Request a new pairing code');
          response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }); response.end(await QRCode.toString(latestPair.link, { type: 'svg', margin: 2, width: 256 })); return;
        }
        if (route === '/api/projects' && request.method === 'POST') {
          if (!equal(bearer, localToken)) throw fail(403, 'Register projects on the Mac');
          const input = await body(request); let path;
          try { path = realpathSync(text(input.path, 'path', 4096)); if (!statSync(path).isDirectory()) throw new Error(); } catch { throw fail(400, 'Project must be an existing directory'); }
          const existing = get('SELECT * FROM projects WHERE path=?', path); if (existing) return json(response, 200, existing);
          const project = { id: randomUUID(), name: input.name ? text(input.name, 'project name', 100) : basename(path), path };
          run('INSERT INTO projects VALUES (?,?,?)', project.id, project.name, project.path); change('state'); return json(response, 201, project);
        }
        if (route === '/api/chats' && request.method === 'POST') {
          const input = await body(request); text(input.projectId, 'project id', 128); if (!get('SELECT id FROM projects WHERE id=?', input.projectId)) throw fail(404, 'Project not found');
          const id = randomUUID(); run('INSERT INTO chats (id,projectId,title,mode,status,updatedAt) VALUES (?,?,?,?,?,?)', id, input.projectId, input.title ? text(input.title, 'title', 160) : 'New chat', mode(input.mode ?? 'bypassPermissions'), 'idle', Date.now()); change('state', id); return json(response, 201, chat(id));
        }
        const chatRoute = route.match(/^\/api\/chats\/([^/]+)\/(messages|prompts|stop)$/);
        if (chatRoute) {
          const [, id, action] = chatRoute, row = chat(id);
          if (action === 'messages' && request.method === 'GET') return json(response, 200, { messages: all('SELECT * FROM messages WHERE chatId=? ORDER BY rowid', id), approvals: all('SELECT * FROM approvals WHERE chatId=? ORDER BY rowid', id).map(row => ({ ...row, input: JSON.parse(row.input) })) });
          if (action === 'stop' && request.method === 'POST') { stop(id); return json(response, 200, { ok: true }); }
          if (action === 'prompts' && request.method === 'POST') {
            const input = await body(request), promptId = text(input.id, 'prompt id', 128), prompt = text(input.text, 'prompt'), requestedMode = input.mode === undefined ? undefined : mode(input.mode), previous = get('SELECT * FROM prompts WHERE id=?', promptId);
            if (previous) { if (previous.chatId !== id || previous.text !== prompt || (requestedMode !== undefined && previous.mode !== requestedMode)) throw fail(409, 'Prompt id was already used for different content'); return json(response, 200, { accepted: true, duplicate: true }); }
            if (active.has(id) || ['running', 'stopping', 'waiting'].includes(row.status)) throw fail(409, 'Chat is busy; wait or stop it before sending another prompt');
            const project = get('SELECT * FROM projects WHERE id=?', row.projectId);
            try { if (!statSync(project.path).isDirectory()) throw new Error(); } catch { throw fail(409, 'Project directory is missing'); }
            if (!claudeAvailable) throw fail(503, 'Claude Code is not installed or could not be started');
            transaction(() => { run('INSERT INTO prompts (id,chatId,text,mode) VALUES (?,?,?,?)', promptId, id, prompt, requestedMode ?? row.mode); run('UPDATE chats SET mode=?,title=?,status=?,error=NULL,updatedAt=? WHERE id=?', requestedMode ?? row.mode, row.title === 'New chat' ? prompt.slice(0, 80) : row.title, 'running', Date.now(), id); message(id, 'user', prompt, promptId); change('state', id); });
            start(id, prompt); return json(response, 202, { accepted: true, duplicate: false });
          }
        }
        const approvalRoute = route.match(/^\/api\/approvals\/([^/]+)$/);
        if (approvalRoute && request.method === 'POST') {
          const id = approvalRoute[1], row = get('SELECT * FROM approvals WHERE id=?', id); if (!row) throw fail(404, 'Approval not found');
          const input = await body(request); if (!['allow', 'deny'].includes(input.decision)) throw fail(400, 'Decision must be allow or deny');
          if (row.status !== 'pending' || !waiting.has(id)) throw fail(409, 'Approval is no longer pending');
          const toolInput = JSON.parse(row.input);
          if (row.tool === 'AskUserQuestion' && input.decision === 'allow' && (!input.answers || typeof input.answers !== 'object' || Array.isArray(input.answers) || (toolInput.questions ?? []).some(q => typeof input.answers[q.question] !== 'string' || !input.answers[q.question].trim()))) throw fail(400, 'Answer every question before continuing');
          run('UPDATE approvals SET status=? WHERE id=?', input.decision, id);
          waiting.get(id).resolve(input.decision === 'allow' ? { behavior: 'allow', updatedInput: { ...toolInput, ...(input.answers ? { answers: input.answers } : {}) } } : { behavior: 'deny', message: 'Denied by the PocketBridge user' }); waiting.delete(id);
          if (active.has(row.chatId) && !active.get(row.chatId).stopped) status(row.chatId, 'running'); change('approval', row.chatId); return json(response, 200, { ok: true });
        }
        if (route === '/api/events' && request.method === 'GET') {
          const after = Number(url.searchParams.get('after') ?? request.headers['last-event-id'] ?? 0); if (!Number.isSafeInteger(after) || after < 0) throw fail(400, 'Invalid event cursor');
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); response.write(': connected\n\n');
          const client = { response, seq: Math.min(after, lastSeq()) }; clients.add(client); replay(client);
          const heartbeat = setInterval(() => { if (!client.replaying) response.write(': keepalive\n\n'); }, 15_000); response.on('close', () => { clearInterval(heartbeat); clients.delete(client); }); return;
        }
        throw fail(404, 'Route not found');
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw fail(405, 'Method not allowed');
      const uiDir = options.uiDir ?? join(here, '../public'), path = resolve(uiDir, `.${route === '/' ? '/index.html' : route}`);
      if (!path.startsWith(resolve(uiDir) + '/') || !existsSync(path) || !statSync(path).isFile()) throw fail(404, 'File not found');
      response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); response.end(request.method === 'HEAD' ? undefined : readFileSync(path));
    } catch (error) { if (response.destroyed) return; if (!response.headersSent) json(response, error.status ?? 500, { error: error.status ? error.message : 'Internal service error' }); else response.destroy(); if (!error.status) console.error(error); }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 20_000;
  try {
    await new Promise((resolveListening, reject) => { server.once('error', reject); server.listen(options.port ?? Number(process.env.POCKETBRIDGE_PORT ?? 8787), options.host ?? '127.0.0.1', resolveListening); });
  } catch (error) { closed = true; clearTimeout(eventTimer); releaseOwner(); db.close(); throw error; }
  localUrl = `http://127.0.0.1:${server.address().port}`; publicUrl ??= localUrl;
  let closePromise;
  const close = () => closePromise ??= (async () => {
    closed = true; for (const id of active.keys()) stop(id);
    while (active.size) await pause(20); clearTimeout(eventTimer);
    for (const client of clients) client.response.end();
    await new Promise(resolveClosed => {
      const deadline = setTimeout(() => server.closeAllConnections(), options.shutdownTimeoutMs ?? 1000);
      server.close(() => { clearTimeout(deadline); resolveClosed(); }); server.closeIdleConnections();
    });
    releaseOwner(); db.close();
  })();
  return { server, url: localUrl, publicUrl, close, state };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = await createService(); console.log(`PocketBridge listening on ${service.url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0); });
}
