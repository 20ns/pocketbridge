import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, statSync, realpathSync, existsSync, readFileSync, writeFileSync, rmSync, chmodSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, extname, resolve, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import QRCode from 'qrcode';
import { agentIds, agentNames, agentModes, agentEnv, claudeCatalog, codexCatalog, checkModel, checkEffort, codexPolicy, codexAppConsumer, codexSessionFolders, claudeUsage, codexUsage, claudeContext, claudeUserMessage, gitStatus, claudeSessions, codexRequest, claudeCommands } from './agents.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Legacy capability lists for clients before 0.5; agents[] carries each CLI's own catalog.
const modes = agentModes.claude;
const models = ['default', 'opus', 'sonnet', 'haiku'];
const efforts = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
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
const mode = (value, agent = 'claude') => { if (!agentModes[agent].includes(value)) throw fail(400, 'Unsupported permission mode'); return value; };
const listed = (value, allowed, label) => { if (typeof value !== 'string' || !allowed.includes(value)) throw fail(400, `Unsupported ${label}`); return value; };
// Chat list previews read as plain text: Markdown markers, code blocks and link targets are dropped.
const plainText = value => value.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`([^`\n]*)`/g, '$1').replace(/\*\*|__|~~/g, '')
  .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, '$1').replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '').replace(/\s+/g, ' ').trim();
const oneLine = (value, max = 4000) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
/** A tool call in a few words, for a sub-agent's current activity. */
const brief = input => {
  if (!input || typeof input !== 'object') return '';
  const value = ['description', 'command', 'file_path', 'pattern', 'path', 'url', 'query', 'prompt'].map(key => input[key]).find(item => typeof item === 'string' && item.trim());
  return value ? oneLine(value.includes('/') && !value.includes(' ') ? value.split('/').filter(Boolean).pop() ?? value : value, 120) : '';
};
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export async function createService(options = {}) {
  const dataDir = options.dataDir ?? process.env.POCKETBRIDGE_DATA_DIR ?? join(homedir(), 'Library/Application Support/PocketBridge');
  const defaultProjects = join(homedir(), '.claude', 'projects');
  const claudeProjectsDir = options.claudeProjectsDir ?? process.env.POCKETBRIDGE_CLAUDE_PROJECTS_DIR ?? defaultProjects;
  if (process.env.NODE_TEST_CONTEXT && resolve(claudeProjectsDir) === resolve(defaultProjects)) throw new Error('Tests must pass claudeProjectsDir and must not read Claude history');
  const testing = Boolean(process.env.NODE_TEST_CONTEXT);
  const codexSessionsDir = options.codexSessionsDir ?? process.env.POCKETBRIDGE_CODEX_SESSIONS_DIR ?? (testing ? null : join(homedir(), '.codex', 'sessions'));
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
  const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
  if (!columns('prompts').includes('mode')) db.exec('ALTER TABLE prompts ADD COLUMN mode TEXT');
  if (!columns('prompts').includes('model')) db.exec('ALTER TABLE prompts ADD COLUMN model TEXT');
  if (!columns('prompts').includes('effort')) db.exec('ALTER TABLE prompts ADD COLUMN effort TEXT');
  if (!columns('projects').includes('lastUsedAt')) db.exec('ALTER TABLE projects ADD COLUMN lastUsedAt INTEGER NOT NULL DEFAULT 0');
  if (!columns('chats').includes('model')) db.exec("ALTER TABLE chats ADD COLUMN model TEXT NOT NULL DEFAULT 'default'");
  if (!columns('chats').includes('effort')) db.exec("ALTER TABLE chats ADD COLUMN effort TEXT NOT NULL DEFAULT 'default'");
  if (!columns('chats').includes('agent')) db.exec("ALTER TABLE chats ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude'");
  if (!columns('chats').includes('agentSession')) db.exec('ALTER TABLE chats ADD COLUMN agentSession TEXT');
  if (!columns('prompts').includes('agent')) db.exec('ALTER TABLE prompts ADD COLUMN agent TEXT');
  if (!columns('chats').includes('contextTokens')) db.exec('ALTER TABLE chats ADD COLUMN contextTokens INTEGER');
  if (!columns('chats').includes('contextWindow')) db.exec('ALTER TABLE chats ADD COLUMN contextWindow INTEGER');
  for (const [table, column, type] of [['prompts', 'attachments', 'TEXT'], ['prompts', 'delivery', 'TEXT'], ['prompts', 'startedAt', 'INTEGER'], ['prompts', 'endedAt', 'INTEGER'], ['messages', 'attachments', 'TEXT'], ['messages', 'kind', 'TEXT'], ['chats', 'forkFrom', 'TEXT'], ['chats', 'activity', 'TEXT']])
    if (!columns(table).includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  db.exec(`CREATE TABLE IF NOT EXISTS deleted_chats (id TEXT PRIMARY KEY, deletedAt INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_chat ON messages(chatId);
    CREATE INDEX IF NOT EXISTS approvals_chat ON approvals(chatId);
    CREATE INDEX IF NOT EXISTS raw_events_chat ON raw_events(chatId);
    CREATE TABLE IF NOT EXISTS hidden_sessions (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, chatId TEXT, type TEXT NOT NULL, size INTEGER NOT NULL, createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS subagents (id TEXT NOT NULL, chatId TEXT NOT NULL, promptId TEXT, agent TEXT NOT NULL, title TEXT, kind TEXT, model TEXT, effort TEXT, status TEXT NOT NULL, activity TEXT, startedAt INTEGER NOT NULL, endedAt INTEGER, toolUses INTEGER, tokens INTEGER, PRIMARY KEY (chatId, id));`);
  const uploadsDir = join(dataDir, 'uploads'); mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  const uploadTypes = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
  const uploadPath = row => join(uploadsDir, `${row.id}.${uploadTypes[row.type]}`);
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const clients = new Set(), active = new Map(), waiting = new Map(), pairAttempts = new Map();
  let closed = false, eventTimer, latestPair, localUrl, lastDiscovery = 0, sessionMeta = new Map(), codexMeta = new Map();
  const internalToken = secret();
  let localToken = get('SELECT value FROM settings WHERE key=?', 'localToken')?.value;
  if (!localToken) { run('INSERT OR IGNORE INTO settings VALUES (?,?)', 'localToken', secret()); localToken = get('SELECT value FROM settings WHERE key=?', 'localToken').value; }
  const claudePath = options.claudePath ?? process.env.POCKETBRIDGE_CLAUDE_PATH ?? 'claude';
  const claudeAvailable = options.claudeAvailable ?? spawnSync(claudePath, ['--version'], { encoding: 'utf8', timeout: 3000 }).status === 0;
  // Tests never touch the real Codex install; they pass a fake codexPath.
  const codexPath = options.codexPath ?? process.env.POCKETBRIDGE_CODEX_PATH ?? (testing ? null : 'codex');
  const codexAvailable = options.codexAvailable ?? (codexPath ? spawnSync(codexPath, ['--version'], { encoding: 'utf8', timeout: 3000 }).status === 0 : false);
  const available = { claude: claudeAvailable, codex: codexAvailable };
  // The owner's switch per agent, for when only one subscription is active. Off means no probes, no discovery, no new turns.
  const enabled = Object.fromEntries(agentIds.map(agent => [agent, get('SELECT value FROM settings WHERE key=?', `agentEnabled:${agent}`)?.value !== '0']));
  const paths = { claude: claudePath, codex: codexPath };
  // Model catalogs come from each CLI's own picker. The last good one is kept for restarts and failed probes.
  const catalogs = {}, catalogAt = {}, catalogProbe = {}, probes = new AbortController();
  // Per project: Codex skills (kept with their paths so "/name" prompts can pass the skill itself) and "/" command lists.
  const codexSkills = new Map(), commandLists = new Map();
  for (const agent of agentIds) { try { catalogs[agent] = JSON.parse(get('SELECT value FROM settings WHERE key=?', `catalog:${agent}`)?.value ?? 'null'); } catch { catalogs[agent] = null; } }
  const claudeSettingsPath = options.claudeSettingsPath ?? (testing ? null : join(homedir(), '.claude', 'settings.json'));
  const refreshCatalog = (agent, force = false) => {
    if (!available[agent] || !enabled[agent] || closed || options.catalogs === false) return Promise.resolve(catalogs[agent]);
    if (catalogProbe[agent]) return catalogProbe[agent];
    const age = Date.now() - (catalogAt[agent] ?? 0);
    if (!force && age < (catalogs[agent] ? 30 * 60_000 : 60_000)) return Promise.resolve(catalogs[agent]);
    catalogAt[agent] = Date.now();
    const probe = { command: paths[agent], cwd: dataDir, env: agentEnv(agent), signal: probes.signal, timeoutMs: options.catalogTimeoutMs ?? 20_000 };
    catalogProbe[agent] = (agent === 'claude' ? claudeCatalog({ ...probe, settingsPath: claudeSettingsPath }) : codexCatalog(probe)).catch(() => null).then(result => {
      catalogProbe[agent] = null;
      if (result && !closed && JSON.stringify(result) !== JSON.stringify(catalogs[agent])) {
        catalogs[agent] = result; run('INSERT OR REPLACE INTO settings VALUES (?,?)', `catalog:${agent}`, JSON.stringify(result)); change('state');
      }
      return catalogs[agent];
    });
    return catalogProbe[agent];
  };
  // A first prompt may arrive before the startup probe answers. Validation waits briefly, well inside client
  // timeouts, then falls back to the safe pattern checks while the probe finishes in the background.
  const catalogFor = async agent => catalogs[agent] ?? await Promise.race([refreshCatalog(agent), pause(options.catalogWaitMs ?? 2500).then(() => catalogs[agent] ?? null)]);
  // Plan usage, asked of each CLI at most once a minute and again after any turn ends.
  const usage = {}, usageAt = {}, usageProbe = {};
  const refreshUsage = agent => {
    if (!available[agent] || !enabled[agent] || closed || options.usage === false) return Promise.resolve(usage[agent] ?? null);
    if (usageProbe[agent]) return usageProbe[agent];
    if (Date.now() - (usageAt[agent] ?? 0) < 60_000) return Promise.resolve(usage[agent] ?? null);
    usageAt[agent] = Date.now();
    const probe = { command: paths[agent], cwd: dataDir, env: agentEnv(agent), signal: probes.signal, timeoutMs: options.catalogTimeoutMs ?? 20_000 };
    usageProbe[agent] = (agent === 'claude' ? claudeUsage(probe) : codexUsage(probe)).catch(() => null).then(result => {
      usageProbe[agent] = null;
      if (result) usage[agent] = { ...result, updatedAt: Date.now() };
      return usage[agent] ?? null;
    });
    return usageProbe[agent];
  };
  let publicUrl = options.publicUrl ?? process.env.POCKETBRIDGE_PUBLIC_URL;
  if (publicUrl) { const address = new URL(publicUrl); if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash || address.pathname !== '/') throw new Error('POCKETBRIDGE_PUBLIC_URL must be an HTTP(S) origin'); publicUrl = address.origin; }
  const lastSeq = () => Number(get('SELECT COALESCE(MAX(seq),0) AS n FROM events').n);
  const chat = id => {
    const row = get('SELECT id,projectId,agent,title,mode,model,effort,status,updatedAt,error FROM chats WHERE id=?', id);
    if (!row) throw fail(404, 'Chat not found');
    return chatRow(row);
  };
  const replay = client => {
    if (closed || client.replaying || client.response.destroyed || client.response.writableEnded) return;
    client.replaying = true;
    const batch = () => {
      if (closed || client.response.destroyed || client.response.writableEnded) return;
      const events = all('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 128', client.seq);
      for (const event of events) {
        // A status-only stream (background alerts) skips the many message events streaming text produces.
        if (client.statusOnly && event.type === 'message') { client.seq = event.seq; continue; }
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
  const modelDisplay = (agent, value) => catalogs[agent]?.models.find(model => model.id === value || model.resolved === value)?.name ?? value;
  const chatRow = row => {
    row.agent ||= 'claude'; row.model ||= 'default'; row.effort ||= 'default';
    if (row.contextTokens > 0 && row.contextWindow > 0) row.context = { used: row.contextTokens, window: row.contextWindow };
    delete row.contextTokens; delete row.contextWindow;
    if (!row.activity) delete row.activity;
    if (!row.error) delete row.error;
    if (row.preview === null) delete row.preview; else if (typeof row.preview === 'string') row.preview = plainText(row.preview).slice(0, 160);
    return row;
  };
  const agentCatalog = agent => {
    const catalog = catalogs[agent];
    return { id: agent, name: agentNames[agent], available: available[agent], enabled: enabled[agent], modes: agentModes[agent], defaultModel: catalog?.defaultModel ?? 'default', defaultEffort: catalog?.defaultEffort ?? 'default', models: (catalog?.models ?? []).map(({ resolved, ...model }) => model) };
  };
  const state = () => {
    for (const agent of agentIds) refreshCatalog(agent);
    return {
      projects: all('SELECT id,name,path,lastUsedAt FROM projects ORDER BY name').map(row => ({ ...row, lastUsedAt: Number(row.lastUsedAt || 0) })),
      // The newest reply or prompt previews each chat; tool activity is left out.
      chats: all(`SELECT id,projectId,agent,title,mode,model,effort,status,updatedAt,error,contextTokens,contextWindow,activity,
        (SELECT substr(text,1,400) FROM messages m WHERE m.chatId=chats.id AND m.role!='activity' ORDER BY m.rowid DESC LIMIT 1) AS preview
        FROM chats ORDER BY updatedAt DESC`).map(chatRow),
      lastSeq: lastSeq(), capabilities: { modes, models, efforts, agents: agentIds.map(agentCatalog) }, server: { claudeAvailable, codexAvailable, publicUrl },
    };
  };
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
  const ignoredCwd = value => String(value).includes(`${sep}Library${sep}Application Support${sep}Claude${sep}scratch-workspaces${sep}`);
  const stamp = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
    if (typeof value === 'string' && value.trim()) { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed; }
  };
  const entryTime = (entry, fallback) => {
    for (const key of ['modified', 'updatedAt', 'fileMtime', 'mtime', 'created', 'createdAt']) {
      const value = stamp(entry[key]); if (value !== undefined) return value;
    }
    return fallback;
  };
  // ponytail: each Claude project directory maps to one cwd. Read at most sessionBudget newest session files there, and only the first 256KB of each, then stop at the first valid cwd. A main session older than that budget waits for sessions-index.json or a newer file; raise sessionBudget if sidechain files crowd it out. A cwd that starts past 256KB needs a larger read or an index entry.
  const sessionBudget = 8;
  const readIndex = file => {
    try {
      const info = statSync(file);
      if (!info.isFile() || info.size > 1_000_000) return null;
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
      if (!Array.isArray(entries)) return null;
      const records = [];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.isSidechain === true || entry.isSubagent === true || entry.agentId) continue;
        const cwd = [entry.cwd, entry.projectPath, entry.project].find(value => typeof value === 'string' && value && !value.includes('\0'));
        if (!cwd || ignoredCwd(cwd)) continue;
        records.push({ cwd, mtime: entryTime(entry, info.mtimeMs) });
      }
      return records;
    } catch { return null; }
  };
  const readCwd = file => {
    let fd;
    try {
      const info = statSync(file);
      if (!info.isFile() || info.size === 0) return;
      fd = openSync(file, 'r');
      const length = Math.min(info.size, 256 * 1024), buf = Buffer.alloc(length), got = readSync(fd, buf, 0, length, 0);
      let body = buf.toString('utf8', 0, got);
      if (got < info.size) { const cut = body.lastIndexOf('\n'); if (cut < 0) return; body = body.slice(0, cut); }
      for (const line of body.split('\n')) {
        if (!line.trim()) continue;
        let record; try { record = JSON.parse(line); } catch { continue; }
        if (!record || typeof record !== 'object' || Array.isArray(record) || record.isSidechain === true || record.isSubagent === true || record.agentId) continue;
        if (typeof record.cwd !== 'string' || !record.cwd || record.cwd.includes('\0') || ignoredCwd(record.cwd)) continue;
        return record.cwd;
      }
    } catch { /* Missing or malformed metadata is skipped. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  };
  const discoverProjects = () => {
    let entries = []; try { if (enabled.claude && existsSync(claudeProjectsDir)) entries = readdirSync(claudeProjectsDir, { withFileTypes: true }); } catch { /* unreadable Claude metadata */ }
    const found = new Map();
    const consider = (cwd, mtime) => {
      if (typeof cwd !== 'string' || ignoredCwd(cwd)) return;
      let path; try { path = realpathSync(cwd); if (!statSync(path).isDirectory()) return; } catch { return; }
      const when = Math.max(0, Math.floor(Number(mtime) || 0)), previous = found.get(path);
      if (previous === undefined || when > previous) found.set(path, when);
    };
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'subagents') continue;
      const dir = join(claudeProjectsDir, entry.name);
      let names; try { names = readdirSync(dir); } catch { continue; }
      if (names.includes('sessions-index.json')) { const indexed = readIndex(join(dir, 'sessions-index.json')); if (indexed) for (const record of indexed) consider(record.cwd, record.mtime); }
      const sessions = [];
      for (const name of names) {
        if (!name.endsWith('.jsonl') || name.includes('subagent')) continue;
        try { const info = statSync(join(dir, name)); if (info.isFile()) sessions.push({ file: join(dir, name), name, mtime: info.mtimeMs, size: info.size }); } catch { /* unreadable session */ }
      }
      if (!sessions.length) continue;
      sessions.sort((a, b) => b.mtime - a.mtime);
      const latest = sessions[0], cached = sessionMeta.get(dir);
      if (cached && cached.name === latest.name && cached.mtimeMs === latest.mtime && cached.size === latest.size) { if (cached.cwd) consider(cached.cwd, latest.mtime); continue; }
      let cwd;
      for (const file of sessions.slice(0, sessionBudget)) { cwd = readCwd(file.file); if (cwd) break; }
      sessionMeta.set(dir, { name: latest.name, mtimeMs: latest.mtime, size: latest.size, cwd });
      if (cwd) consider(cwd, latest.mtime);
    }
    if (codexSessionsDir && enabled.codex) for (const session of codexSessionFolders(codexSessionsDir, codexMeta)) consider(session.cwd, session.mtime);
    const changed = transaction(() => {
      let wrote = false;
      for (const [path, lastUsedAt] of found) {
        const existing = get('SELECT id,lastUsedAt FROM projects WHERE path=?', path);
        if (existing) { if (lastUsedAt > Number(existing.lastUsedAt || 0)) { run('UPDATE projects SET lastUsedAt=? WHERE id=?', lastUsedAt, existing.id); wrote = true; } }
        else { run('INSERT INTO projects (id,name,path,lastUsedAt) VALUES (?,?,?,?)', randomUUID(), basename(path) || path, path, lastUsedAt); wrote = true; }
      }
      return wrote;
    });
    if (changed) change('state');
  };
  const refreshDiscovery = (force = false) => {
    const now = Date.now();
    if (!force && now - lastDiscovery < (options.discoverIntervalMs ?? 15_000)) return;
    lastDiscovery = now;
    try { discoverProjects(); } catch (error) { console.error(`Project discovery failed: ${error.message}`); }
  };
  refreshDiscovery(true);
  const catalogsReady = Promise.all(agentIds.map(agent => refreshCatalog(agent, true)));
  const message = (chatId, role, value, id = randomUUID(), extra = {}) => {
    run('INSERT INTO messages (id,chatId,role,text,createdAt,attachments,kind) VALUES (?,?,?,?,?,?,?)', id, chatId, role, value, Date.now(), extra.attachments?.length ? JSON.stringify(extra.attachments) : null, extra.kind ?? null);
    change('message', chatId); return id;
  };
  /** Sub-agents a turn started: created on first sight, then patched with whatever each later event adds. */
  const subagent = (chatId, promptId, agent, patch) => {
    const existing = get('SELECT * FROM subagents WHERE chatId=? AND id=?', chatId, patch.id), now = Date.now();
    const done = patch.status && patch.status !== 'running';
    if (!existing) run('INSERT INTO subagents (id,chatId,promptId,agent,title,kind,model,effort,status,activity,startedAt,endedAt,toolUses,tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      patch.id, chatId, promptId, agent, patch.title ?? 'Sub-agent', patch.kind ?? null, patch.model ?? null, patch.effort ?? null, patch.status ?? 'running', patch.activity ?? null, patch.startedAt ?? now, done ? (patch.endedAt ?? now) : null, patch.toolUses ?? null, patch.tokens ?? null);
    else {
      const next = { ...existing };
      for (const key of ['title', 'kind', 'model', 'effort', 'activity', 'toolUses', 'tokens']) if (patch[key] !== undefined && patch[key] !== null) next[key] = patch[key];
      if (patch.status && existing.status === 'running') { next.status = patch.status; if (done) next.endedAt = patch.endedAt ?? now; }
      run('UPDATE subagents SET title=?,kind=?,model=?,effort=?,status=?,activity=?,endedAt=?,toolUses=?,tokens=? WHERE chatId=? AND id=?', next.title, next.kind, next.model, next.effort, next.status, next.activity, next.endedAt, next.toolUses, next.tokens, chatId, patch.id);
    }
    change('message', chatId);
  };
  const activityFor = (id, value) => { run('UPDATE chats SET activity=? WHERE id=?', value ? String(value).slice(0, 200) : null, id); change('state', id); };
  const cancelApprovals = id => {
    for (const [approvalId, entry] of waiting) if (entry.chatId === id) {
      run("UPDATE approvals SET status='deny' WHERE id=?", approvalId); entry.resolve({ behavior: 'deny', message: 'User stopped the task', interrupt: true }); waiting.delete(approvalId); change('approval', id);
    }
  };
  const stop = id => {
    chat(id); const entry = active.get(id); if (!entry || entry.stopped) return;
    entry.stopped = true; status(id, 'stopping'); cancelApprovals(id);
    entry.stopPromise = terminateGroup(entry.child.pid, options.stopTimeoutMs ?? 3000).catch(error => console.error(`Stop ${id}: ${error.message}`));
  };

  /**
   * Starts one CLI run for a chat. A run lives until its turns are done: steers join the running turn, an interrupt
   * ends the turn and sends the next one into the same process, and Claude's background sub-agents can add turns.
   * delivery: { promptId, text, attachments: [{ id, type, path }], kind: 'turn'|'steer'|'interrupt' }.
   */
  function start(id, delivery, later = []) {
    const row = get('SELECT * FROM chats WHERE id=?', id), project = get('SELECT * FROM projects WHERE id=?', row.projectId);
    const agent = row.agent || 'claude';
    const bridgeEnv = { POCKETBRIDGE_INTERNAL_URL: localUrl, POCKETBRIDGE_INTERNAL_TOKEN: internalToken, POCKETBRIDGE_CHAT_ID: id };
    let args;
    if (agent === 'codex') args = ['app-server'];
    else {
      const bridgePath = join(here, 'approval-bridge.mjs');
      const settings = { hooks: { PreToolUse: [{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: [{ type: 'command', command: `${shellQuote(process.execPath)} ${shellQuote(bridgePath)} --hook`, timeout: 86400 }] }] } };
      const mcp = { mcpServers: { pocketbridge: { type: 'stdio', command: process.execPath, args: [bridgePath], env: bridgeEnv } } };
      // A continued Terminal session is forked on its first turn so the original keeps its own history.
      const session = row.sessionStarted ? ['--resume', id] : row.forkFrom ? ['--resume', row.forkFrom, '--fork-session', '--session-id', id] : ['--session-id', id];
      args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-mode', row.mode === 'default' ? 'manual' : row.mode, ...session, '--settings', JSON.stringify(settings), '--mcp-config', JSON.stringify(mcp), '--permission-prompt-tool', 'mcp__pocketbridge__approve'];
      if (row.mode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
      if (row.model && row.model !== 'default') args.push('--model', row.model);
      if (row.effort && row.effort !== 'default') args.push('--effort', row.effort);
    }
    // Subscription login stays inside each official binary; inherited API overrides must not change billing.
    const env = { ...agentEnv(agent), ...(agent === 'claude' ? bridgeEnv : {}) };
    const child = spawn(paths[agent], args, { cwd: project.path, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const entry = { child, agent, stopped: false, assistantId: null, buffer: '', stderr: '', result: null, parseError: null, sawText: false, tools: new Map(), after: later, finishing: false, turnPrompt: null };
    active.set(id, entry);
    if (child.pid) run('INSERT OR REPLACE INTO runtimes VALUES (?,?,?)', id, child.pid, processStamp(child.pid) ?? '');
    const turnStarted = promptId => { entry.turnPrompt = promptId; run('UPDATE prompts SET startedAt=COALESCE(startedAt,?) WHERE id=?', Date.now(), promptId); change('message', id); };
    const turnEnded = () => { if (entry.turnPrompt) { run('UPDATE prompts SET endedAt=? WHERE id=?', Date.now(), entry.turnPrompt); change('message', id); } };
    const append = value => {
      if (!value) return; entry.sawText = true;
      if (!entry.assistantId) entry.assistantId = message(id, 'assistant', value);
      else { run('UPDATE messages SET text=text||? WHERE id=?', value, entry.assistantId); change('message', id); }
    };
    let consume;
    if (agent === 'claude') {
      entry.written = new Map(); entry.background = 0; entry.turnOpen = false;
      const write = next => { child.stdin.write(JSON.stringify(claudeUserMessage(next.promptId, next.text, next.attachments)) + '\n'); entry.written.set(next.promptId, next); };
      // stdin closes once the last turn ended, no background sub-agent can add a turn, and every message was taken.
      const settle = (force = false) => {
        clearTimeout(entry.settleTimer);
        if (entry.finishing || entry.turnOpen || entry.background > 0) return;
        // A message the CLI never echoes (a local slash command, a discarded queued command) must not hold the run
        // open: once the turn has ended, close after a short wait; the CLI still runs input it already took.
        if (entry.written.size && !force) { entry.settleTimer = setTimeout(() => settle(true), options.writtenGraceMs ?? 10_000); return; }
        entry.finishing = true; child.stdin.end();
      };
      entry.steer = next => { if (entry.finishing) entry.after.push(next); else write(next); };
      entry.interrupt = next => {
        if (entry.finishing) { entry.after.push(next); return; }
        cancelApprovals(id);
        if (get('SELECT status FROM chats WHERE id=?', id)?.status === 'waiting') status(id, 'running');
        child.stdin.write(JSON.stringify({ type: 'control_request', request_id: `interrupt-${next.promptId}`, request: { subtype: 'interrupt' } }) + '\n');
        write(next);
      };
      const routeSubagent = event => {
        const parent = event.parent_tool_use_id;
        if (event.type === 'assistant') for (const block of event.message?.content ?? []) {
          if (block?.type === 'tool_use') { const known = get('SELECT toolUses FROM subagents WHERE chatId=? AND id=?', id, parent); subagent(id, entry.turnPrompt, agent, { id: parent, model: event.message?.model ?? null, activity: `${block.name} ${brief(block.input)}`.trim().slice(0, 200), toolUses: (known?.toolUses ?? 0) + 1 }); }
          else if (event.message?.model) subagent(id, entry.turnPrompt, agent, { id: parent, model: event.message.model });
        }
      };
      consume = line => {
        let event;
        try { event = JSON.parse(line); } catch { entry.parseError = 'Claude returned malformed structured output.'; return; }
        if (!(event?.type === 'stream_event')) run('INSERT INTO raw_events (chatId,json) VALUES (?,?)', id, line);
        const malformed = () => { entry.parseError = 'Claude returned malformed structured output.'; };
        if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') { malformed(); return; }
        if (['assistant', 'user'].includes(event.type) && (!Array.isArray(event.message?.content) || event.message.content.some(block => !block || typeof block !== 'object' || typeof block.type !== 'string' || (block.type === 'text' && typeof block.text !== 'string')))) { malformed(); return; }
        if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta' && typeof event.event.delta.text !== 'string') { malformed(); return; }
        if (event.type === 'result' && ((event.result !== undefined && typeof event.result !== 'string') || (event.errors !== undefined && (!Array.isArray(event.errors) || event.errors.some(error => typeof error !== 'string'))))) { malformed(); return; }
        // A sub-agent's own messages describe that sub-agent; the chat shows them as its activity, not as replies.
        if (typeof event.parent_tool_use_id === 'string') { routeSubagent(event); return; }
        if (event.type === 'system' && event.subtype === 'init') { run('UPDATE chats SET sessionStarted=1 WHERE id=?', id); if (entry.turnPrompt || entry.written.size === 0) { entry.turnOpen = true; clearTimeout(entry.settleTimer); } }
        if (event.type === 'command_lifecycle' && ['cancelled', 'discarded', 'refused'].includes(event.state ?? event.status)) {
          for (const key of [event.uuid, event.command_uuid, event.message_uuid]) if (typeof key === 'string') entry.written.delete(key);
          settle();
        }
        if (event.type === 'user' && !event.message.content.some(block => block.type === 'tool_result')) {
          const said = event.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
          const taken = entry.written.get(event.uuid) ?? [...entry.written.values()].find(next => next.text === said);
          if (taken) {
            entry.written.delete(taken.promptId);
            // A steer taken mid-turn joins it; anything taken between turns starts the next one.
            if (taken.kind !== 'steer' || !entry.turnOpen) { turnStarted(taken.promptId); entry.assistantId = null; }
            entry.turnOpen = true; clearTimeout(entry.settleTimer);
          }
        }
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
          for (const block of blocks) if (block.type === 'tool_use') {
            const toolMessage = message(id, 'activity', `${block.name}\n${JSON.stringify(block.input, null, 2)}`);
            if (typeof block.id === 'string') entry.tools.set(block.id, toolMessage);
            if (['Agent', 'Task'].includes(block.name) && typeof block.id === 'string') subagent(id, entry.turnPrompt, agent, { id: block.id, title: String(block.input?.description ?? 'Sub-agent').slice(0, 100), kind: block.input?.subagent_type ?? null, model: block.input?.model ?? null, effort: row.effort === 'default' ? null : row.effort, status: 'running' });
          }
          entry.assistantId = null;
        }
        // A result's message id names its tool message, so parallel calls pair exactly on every client.
        if (event.type === 'user') for (const block of event.message?.content ?? []) if (block.type === 'tool_result') {
          const toolMessage = entry.tools.get(block.tool_use_id); entry.tools.delete(block.tool_use_id);
          message(id, 'activity', `${block.is_error ? 'Tool failed' : 'Tool result'}\n${typeof block.content === 'string' ? block.content : JSON.stringify(block.content)}`, toolMessage ? `${toolMessage}:result` : undefined);
          // A sub-agent that ran in the foreground ends with its tool result; a backgrounded one reports through task events.
          const sub = typeof block.tool_use_id === 'string' && get('SELECT status FROM subagents WHERE chatId=? AND id=?', id, block.tool_use_id);
          if (sub && !entry.backgrounded?.has(block.tool_use_id)) subagent(id, entry.turnPrompt, agent, { id: block.tool_use_id, status: block.is_error ? 'failed' : 'completed' });
        }
        if (event.type === 'system') {
          const task = typeof event.tool_use_id === 'string' && (event.task_type === 'local_agent' || event.subagent_type || get('SELECT id FROM subagents WHERE chatId=? AND id=?', id, event.tool_use_id));
          if (event.subtype === 'task_started' && task) {
            if (event.is_backgrounded) (entry.backgrounded ??= new Set()).add(event.tool_use_id);
            subagent(id, entry.turnPrompt, agent, { id: event.tool_use_id, title: event.description ? String(event.description).slice(0, 100) : null, kind: event.subagent_type ?? null, status: 'running' });
          }
          if (event.subtype === 'task_progress' && task) subagent(id, entry.turnPrompt, agent, { id: event.tool_use_id, activity: event.description ? String(event.description).slice(0, 200) : null, tokens: event.usage?.total_tokens ?? null, toolUses: event.usage?.tool_uses ?? null });
          if (event.subtype === 'task_notification' && task) subagent(id, entry.turnPrompt, agent, { id: event.tool_use_id, status: event.status === 'completed' ? 'completed' : event.status === 'failed' ? 'failed' : 'stopped', activity: event.summary ? String(event.summary).slice(0, 200) : null });
          if (event.subtype === 'background_tasks_changed' && Array.isArray(event.tasks)) {
            // Only sub-agents and workflows bring a follow-up turn; background shells and monitors don't hold the run open.
            entry.background = event.tasks.filter(task => task && !task.ambient && ['local_agent', 'local_workflow'].includes(task.task_type)).length;
            // The CLI usually starts a follow-up turn when the last background task ends; give it a moment before closing.
            if (entry.background === 0 && !entry.turnOpen) { clearTimeout(entry.settleTimer); entry.settleTimer = setTimeout(settle, options.backgroundGraceMs ?? 15_000); }
          }
          if (event.subtype === 'task_summary') activityFor(id, typeof event.detail === 'string' ? event.detail : null);
          if (['permission_denied', 'warning', 'error'].includes(event.subtype)) message(id, 'activity', typeof event.message === 'string' ? event.message : JSON.stringify(event));
        }
        if (event.type === 'result') {
          entry.result = event; entry.turnOpen = false; run('UPDATE chats SET sessionStarted=1 WHERE id=?', id); if (event.result && !entry.sawText) append(event.result);
          const context = claudeContext(event); if (context) run('UPDATE chats SET contextTokens=?,contextWindow=? WHERE id=?', context.used, context.window, id);
          // With background sub-agents still running, the turn continues in the follow-up Claude starts for them.
          if (entry.background === 0) turnEnded();
          entry.sawText = false; entry.assistantId = null; settle();
        }
      };
      write(delivery);
    } else {
      // Codex runs through its app-server: one thread per chat, one turn per prompt, steer and interrupt in place.
      let nextId = 1;
      const pending = new Map();
      // The first turn is on its way from the start; steers and interrupts that arrive first wait for its id.
      entry.queue = []; entry.early = []; entry.turnOpen = true; entry.turnId = null; entry.turnLive = false;
      const writable = () => !child.stdin.destroyed && !child.stdin.writableEnded && child.exitCode === null;
      const send = value => { if (writable()) child.stdin.write(JSON.stringify(value) + '\n'); };
      const call = (method, params) => new Promise((resolveCall, rejectCall) => {
        if (!writable()) { rejectCall(new Error('Codex is no longer running')); return; }
        const callId = nextId++; pending.set(callId, { resolveCall, rejectCall }); send({ id: callId, method, params });
      });
      child.on('exit', () => { for (const waiter of pending.values()) waiter.rejectCall(new Error('Codex exited')); pending.clear(); });
      const codex = codexAppConsumer({
        say: (role, value, messageId) => message(id, role, value, messageId),
        update: (messageId, value) => { run('UPDATE messages SET text=? WHERE id=?', value, messageId); change('message', id); },
        append: (messageId, value) => { run('UPDATE messages SET text=text||? WHERE id=?', value, messageId); change('message', id); },
        subagent: patch => subagent(id, entry.turnPrompt, agent, patch),
        context: (used, window) => run('UPDATE chats SET contextTokens=?,contextWindow=? WHERE id=?', used, window, id),
        activity: value => activityFor(id, value),
      });
      entry.codex = codex;
      const settings = () => {
        const current = get('SELECT mode,model,effort FROM chats WHERE id=?', id);
        return { model: current.model !== 'default' ? current.model : null, effort: current.effort !== 'default' ? current.effort : null, ...codexPolicy(current.mode) };
      };
      const skills = codexSkills.get(project.id) ?? [];
      const input = next => {
        const named = /^\/([\w:.-]+)/.exec(next.text)?.[1], skill = named && skills.find(item => item.name === named);
        return [...(skill ? [{ type: 'skill', name: skill.name, path: skill.path }] : []), { type: 'text', text: next.text, text_elements: [] }, ...next.attachments.map(item => ({ type: 'localImage', path: item.path }))];
      };
      const shutdown = () => {
        if (entry.finishing) return; entry.finishing = true; child.stdin.end();
        setTimeout(() => { if (active.get(id) === entry) terminateGroup(child.pid, options.stopTimeoutMs ?? 3000).catch(() => {}); }, 3000).unref();
      };
      const interruptNow = () => call('turn/interrupt', { threadId: entry.threadId, turnId: entry.turnId }).catch(() => {});
      const steerNow = next => call('turn/steer', { threadId: entry.threadId, expectedTurnId: entry.turnId, input: input(next) }).catch(() => {
        // The turn ended before the steer landed; it becomes the next turn instead.
        if (entry.finishing) entry.after.push(next); else if (entry.turnOpen) entry.queue.push(next); else startTurn(next).catch(failRun);
      });
      // Codex accepts steer and interrupt only once it reports the turn started, not when turn/start returns.
      const turnActive = id => {
        if (id) entry.turnId = id;
        if (!entry.turnId || entry.turnLive) return;
        entry.turnLive = true;
        for (const next of entry.early.splice(0)) steerNow(next);
        if (entry.interruptPending) { entry.interruptPending = false; interruptNow(); }
      };
      const startTurn = async next => {
        turnStarted(next.promptId); entry.turnOpen = true; entry.turnId = null; entry.turnLive = false;
        const { model, effort } = settings();
        const opened = await call('turn/start', { threadId: entry.threadId, input: input(next), ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
        if (!entry.turnLive) entry.turnId = opened?.turn?.id ?? entry.turnId;
      };
      const failRun = error => { entry.failure ??= error?.message ?? 'Codex could not start this turn.'; shutdown(); };
      entry.steer = next => {
        if (entry.finishing) entry.after.push(next);
        else if (!entry.turnOpen) entry.queue.push(next);
        else if (!entry.turnLive) entry.early.push(next);
        else steerNow(next);
      };
      entry.interrupt = next => {
        if (entry.finishing) { entry.after.push(next); return; }
        entry.queue.unshift(next);
        if (!entry.turnOpen) return;
        if (entry.turnLive) interruptNow(); else entry.interruptPending = true;
      };
      const turnCompleted = turn => {
        entry.turnOpen = false; entry.turnLive = false; turnEnded(); entry.lastTurn = turn;
        // Steers that never reached a turn id run next, in order.
        entry.queue.push(...entry.early.splice(0)); entry.interruptPending = false;
        if (turn?.status === 'failed') entry.failure = oneLine(turn.error?.message) || codex.state.failure || 'Codex could not finish this turn.';
        if (entry.queue.length && !entry.stopped) startTurn(entry.queue.shift()).catch(failRun);
        else shutdown();
      };
      consume = line => {
        let event; try { event = JSON.parse(line); } catch { return; }
        if (!event || typeof event !== 'object') return;
        if (event.method && !['item/agentMessage/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/commandExecution/outputDelta'].includes(event.method)) run('INSERT INTO raw_events (chatId,json) VALUES (?,?)', id, line.slice(0, 200_000));
        if (event.id !== undefined && !event.method) {
          const waiter = pending.get(event.id); pending.delete(event.id);
          if (waiter) { if (event.error) waiter.rejectCall(new Error(event.error.message ?? 'Codex rejected the request')); else waiter.resolveCall(event.result); }
          return;
        }
        // Codex asks only when its policy allows asking; PocketBridge runs it with approvals off, so any request is declined.
        if (event.id !== undefined && event.method) { send(event.method.endsWith('requestApproval') ? { id: event.id, result: { decision: 'decline' } } : { id: event.id, error: { code: -32601, message: 'Not supported by PocketBridge' } }); return; }
        // Sub-agent threads report on their own thread ids: they only update that sub-agent's activity line.
        const thread = event.params?.threadId;
        if (thread && entry.threadId && thread !== entry.threadId) {
          const item = event.params?.item;
          if (event.method === 'item/started' && item && get('SELECT id FROM subagents WHERE chatId=? AND id=?', id, thread)) {
            const doing = item.type === 'commandExecution' ? `Running ${oneLine(String(item.command ?? '').replace(/^\/bin\/(?:ba|z)?sh -lc /, ''), 120)}` : item.type === 'fileChange' ? 'Editing files' : item.type === 'mcpToolCall' ? `${item.server ?? ''}.${item.tool ?? ''}` : null;
            if (doing) subagent(id, entry.turnPrompt, agent, { id: thread, activity: doing });
          }
          return;
        }
        if (event.method === 'turn/started') { turnActive(event.params?.turn?.id); return; }
        if (event.method === 'turn/completed') { if (!entry.turnId || !event.params?.turn?.id || event.params.turn.id === entry.turnId) turnCompleted(event.params?.turn); return; }
        codex.consume(event.method, event.params);
      };
      (async () => {
        await call('initialize', { clientInfo: { name: 'pocketbridge', title: 'PocketBridge', version: '1' } });
        send({ method: 'initialized' });
        const { model, effort, approvalPolicy, sandbox } = settings();
        const base = { cwd: project.path, approvalPolicy, sandbox, ...(model ? { model } : {}), ...(effort ? { config: { model_reasoning_effort: effort } } : {}) };
        const opened = row.agentSession ? await call('thread/resume', { threadId: row.agentSession, ...base }) : row.forkFrom ? await call('thread/fork', { threadId: row.forkFrom, ...base }) : await call('thread/start', base);
        entry.threadId = opened?.thread?.id;
        if (!entry.threadId) throw new Error('Codex did not open a thread.');
        run('UPDATE chats SET agentSession=?,sessionStarted=1 WHERE id=?', entry.threadId, id);
        await startTurn(delivery);
      })().catch(failRun);
      entry.result = { get ok() { return entry.lastTurn?.status === 'completed' && !entry.failure; } };
    }
    // Unexpected CLI output fails this turn; it must never take the service and every other chat down with it.
    const safely = line => {
      try { consume(line); } catch (error) { entry.parseError ??= `PocketBridge could not read ${agentNames[agent]} output: ${error.message}`; console.error(`Chat ${id}: ${error.stack ?? error.message}`); }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      entry.buffer += chunk;
      if (entry.buffer.length > 10_000_000) { entry.parseError = `${agentNames[agent]} output exceeded the structured event limit.`; stop(id); return; }
      let newline; while ((newline = entry.buffer.indexOf('\n')) !== -1) { const line = entry.buffer.slice(0, newline); entry.buffer = entry.buffer.slice(newline + 1); if (line.trim()) safely(line); }
    });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { entry.stderr = (entry.stderr + chunk).slice(-16_000); });
    child.stdin.on('error', () => {}); child.on('error', error => { entry.parseError = `Could not start ${agentNames[agent]}: ${error.message}`; });
    // Once the process is gone, steers and interrupts wait for the next run instead of writing to a closed pipe.
    child.on('exit', () => { entry.finishing = true; });
    child.on('close', (code, signal) => finished(code, signal).catch(error => {
      console.error(`Chat ${id} cleanup: ${error.stack ?? error.message}`);
      active.delete(id);
      try { status(id, 'error', `PocketBridge could not finish this turn: ${error.message}`); } catch { /* database already closed */ }
    }));
    const finished = async (code, signal) => {
      entry.finishing = true;
      if (entry.buffer.trim()) safely(entry.buffer);
      clearTimeout(entry.settleTimer);
      // Tool processes can outlive the CLI even after a completed result.
      await (entry.stopPromise ?? terminateGroup(child.pid, options.stopTimeoutMs ?? 3000).catch(error => console.error(`Cleanup ${id}: ${error.message}`)));
      active.delete(id); run('DELETE FROM runtimes WHERE chatId=?', id); cancelApprovals(id); usageAt[agent] = 0; gitCache.delete(project.id);
      run("UPDATE subagents SET status='stopped',endedAt=? WHERE chatId=? AND status='running'", Date.now(), id);
      if (entry.turnPrompt) run('UPDATE prompts SET endedAt=COALESCE(endedAt,?) WHERE id=?', Date.now(), entry.turnPrompt);
      run('UPDATE chats SET activity=NULL WHERE id=?', id);
      const codex = agent === 'codex';
      // Messages sent while the run was closing start the next run rather than being lost.
      if (!entry.stopped && entry.after.length) { start(id, entry.after.shift(), entry.after); return; }
      if (entry.stopped) status(id, 'interrupted', 'Stopped by you. Completed changes remain on disk.');
      else if (codex && (entry.parseError || !entry.result.ok)) status(id, 'error', entry.parseError ?? entry.failure ?? entry.codex?.state.failure ?? (entry.stderr.trim().split('\n').slice(-12).join('\n') || `Codex exited ${code ?? signal} without a completed turn.`));
      else if (!codex && (entry.parseError || code !== 0 || entry.result?.is_error || !entry.result)) status(id, 'error', entry.parseError ?? (entry.result?.errors?.join('\n') || entry.result?.result || entry.stderr.trim() || `Claude exited ${code ?? signal} without a completed result.`));
      else status(id, 'idle');
    };
  }

  /** Validates requested options against the agent's own catalog. Omitted values stay undefined. */
  const chatOptions = async (agent, input, stored) => {
    const chosenMode = input.mode === undefined ? undefined : mode(input.mode, agent);
    if (input.model === undefined && input.effort === undefined) return { mode: chosenMode };
    const catalog = await catalogFor(agent);
    if (input.model !== undefined && !checkModel(agent, input.model, catalog)) throw fail(400, 'Unsupported model');
    const model = input.model ?? stored?.model ?? 'default';
    // Clients before 0.5 send no agent and only know the legacy effort list, so they keep its rules.
    const effortCatalog = input.agent === undefined && efforts.includes(input.effort) ? null : catalog;
    if (input.effort !== undefined && (typeof input.effort !== 'string' || !checkEffort(agent, model, input.effort, effortCatalog))) throw fail(400, 'Unsupported effort for this model');
    return { mode: chosenMode, model: input.model, effort: input.effort };
  };
  // Transcripts are mostly text; gzip keeps phone refreshes small over Tailscale.
  const json = (response, code, value) => {
    const payload = JSON.stringify(value), compress = response.gzip && payload.length > 1400;
    response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(compress ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
    response.end(compress ? gzipSync(payload, { level: 4 }) : payload);
  };
  const body = async request => {
    let value = '', size = 0; for await (const chunk of request) { size += chunk.length; if (size > 200_000) throw fail(413, 'Request too large'); value += chunk; }
    if (closed) throw fail(503, 'Mac service is shutting down');
    try { const result = JSON.parse(value); if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(); return result; } catch { throw fail(400, 'Invalid JSON body'); }
  };
  const rawBody = async (request, max) => {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > max) throw fail(413, 'Image is too large; the limit is 5 MB'); chunks.push(chunk); }
    if (closed) throw fail(503, 'Mac service is shutting down');
    return Buffer.concat(chunks);
  };
  const imageType = data => data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png' : data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff ? 'image/jpeg'
    : data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP' ? 'image/webp' : ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('latin1')) ? 'image/gif' : null;
  const project = id => { const row = get('SELECT * FROM projects WHERE id=?', id); if (!row) throw fail(404, 'Project not found'); return row; };
  const gitCache = new Map();
  /** Sessions in a project folder that PocketBridge didn't start, newest first, for continuing on the phone. */
  const externalSessions = async folder => {
    const managed = new Set(all('SELECT id FROM chats UNION SELECT agentSession FROM chats WHERE agentSession IS NOT NULL UNION SELECT forkFrom FROM chats WHERE forkFrom IS NOT NULL UNION SELECT id FROM deleted_chats UNION SELECT id FROM hidden_sessions').map(item => item.id));
    const sessions = [];
    if (available.claude && enabled.claude) {
      const encoded = join(claudeProjectsDir, folder.path.replace(/[^a-zA-Z0-9]/g, '-'));
      const dirs = new Set([encoded, ...[...sessionMeta].filter(([, meta]) => { try { return meta.cwd && realpathSync(meta.cwd) === folder.path; } catch { return false; } }).map(([dir]) => dir)]);
      for (const dir of dirs) if (existsSync(dir)) sessions.push(...claudeSessions(dir).filter(session => { try { return !session.cwd || realpathSync(session.cwd) === folder.path; } catch { return false; } }));
    }
    if (available.codex && enabled.codex && options.codexSessions !== false) {
      const listed = await codexRequest({ command: paths.codex, cwd: dataDir, env: agentEnv('codex'), signal: probes.signal, timeoutMs: options.catalogTimeoutMs ?? 20_000, method: 'thread/list', params: { cwd: folder.path, limit: 25 } });
      const seen = new Set();
      for (const thread of Array.isArray(listed?.data) ? listed.data : []) {
        if (!thread?.id || seen.has(thread.id) || thread.ephemeral || thread.parentThreadId || (thread.threadSource && thread.threadSource !== 'user')) continue;
        seen.add(thread.id);
        sessions.push({ agent: 'codex', id: thread.id, title: oneLine(thread.name || thread.preview, 100) || 'Codex session', updatedAt: Number(thread.updatedAt) * 1000 || 0, lastPrompt: oneLine(thread.preview, 4000) || null, lastReply: null });
      }
    }
    return sessions.filter(session => !managed.has(session.id)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
  };
  const pairing = () => {
    const code = randomBytes(5).toString('hex').toUpperCase();
    latestPair = { code, expiresAt: Date.now() + 600_000, url: publicUrl, link: `pocketbridge://pair?url=${encodeURIComponent(publicUrl)}&code=${code}` }; return latestPair;
  };
  const server = http.createServer(async (request, response) => {
    response.gzip = /\bgzip\b/.test(request.headers['accept-encoding'] ?? '');
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
        if (route === '/api/state' && request.method === 'GET') { refreshDiscovery(); return json(response, 200, state()); }
        if (route === '/api/pairing' && request.method === 'GET') return json(response, 200, pairing());
        if (route === '/api/usage' && request.method === 'GET') {
          const agents = await Promise.all(agentIds.map(async agent => ({ id: agent, name: agentNames[agent], available: available[agent], enabled: enabled[agent], ...(enabled[agent] ? (await refreshUsage(agent)) ?? { limits: [] } : { limits: [] }) })));
          return json(response, 200, { agents });
        }
        const agentRoute = route.match(/^\/api\/agents\/([^/]+)$/);
        if (agentRoute && request.method === 'POST') {
          const agent = listed(agentRoute[1], agentIds, 'agent'), input = await body(request);
          if (typeof input.enabled !== 'boolean') throw fail(400, 'enabled must be true or false');
          enabled[agent] = input.enabled; run('INSERT OR REPLACE INTO settings VALUES (?,?)', `agentEnabled:${agent}`, input.enabled ? '1' : '0');
          if (input.enabled) { usageAt[agent] = 0; refreshCatalog(agent, true); refreshDiscovery(true); }
          change('state'); return json(response, 200, agentCatalog(agent));
        }
        if (route === '/api/pairing/qr' && request.method === 'GET') {
          if (!latestPair || latestPair.expiresAt < Date.now() || (url.searchParams.has('code') && url.searchParams.get('code') !== latestPair.code)) throw fail(410, 'Request a new pairing code');
          response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }); response.end(await QRCode.toString(latestPair.link, { type: 'svg', margin: 2, width: 256 })); return;
        }
        if (route === '/api/uploads' && request.method === 'POST') {
          const data = await rawBody(request, 5 * 1024 * 1024), type = imageType(data);
          // Images never used in a prompt are removed after a day.
          for (const stale of all('SELECT * FROM uploads WHERE chatId IS NULL AND createdAt<?', Date.now() - 86_400_000)) { rmSync(uploadPath(stale), { force: true }); run('DELETE FROM uploads WHERE id=?', stale.id); }
          if (!type) throw fail(415, 'Only PNG, JPEG, WebP and GIF images can be attached');
          const upload = { id: randomUUID(), type, size: data.length };
          writeFileSync(uploadPath(upload), data, { mode: 0o600 });
          run('INSERT INTO uploads (id,chatId,type,size,createdAt) VALUES (?,?,?,?,?)', upload.id, null, type, data.length, Date.now());
          return json(response, 201, upload);
        }
        const uploadRoute = route.match(/^\/api\/uploads\/([0-9a-f-]{36})$/);
        if (uploadRoute && request.method === 'GET') {
          const upload = get('SELECT * FROM uploads WHERE id=?', uploadRoute[1]); if (!upload || !existsSync(uploadPath(upload))) throw fail(404, 'Image not found');
          response.writeHead(200, { 'Content-Type': upload.type, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }); response.end(readFileSync(uploadPath(upload))); return;
        }
        const projectRoute = route.match(/^\/api\/projects\/([^/]+)\/(git|commands|sessions)$/);
        if (projectRoute && request.method === 'GET') {
          const folder = project(projectRoute[1]);
          if (projectRoute[2] === 'git') {
            // Recomputed at most every few seconds; a turn ending clears it so the counts follow the agent's edits.
            const cached = gitCache.get(folder.id);
            if (!cached || Date.now() - cached.at > 4000) gitCache.set(folder.id, { at: Date.now(), value: gitStatus(folder.path) });
            const git = await gitCache.get(folder.id).value;
            return json(response, 200, git ? { repo: true, ...git } : { repo: false });
          }
          if (projectRoute[2] === 'commands') {
            const agent = listed(url.searchParams.get('agent') ?? 'claude', agentIds, 'agent'), key = `${folder.id}:${agent}`;
            if (!available[agent] || !enabled[agent]) return json(response, 200, { commands: [] });
            const cached = commandLists.get(key);
            if (!cached || Date.now() - cached.at > 10 * 60_000) {
              const probe = { command: paths[agent], cwd: folder.path, env: agentEnv(agent), signal: probes.signal, timeoutMs: options.catalogTimeoutMs ?? 20_000 };
              const value = agent === 'claude' ? claudeCommands(probe) : codexRequest({ ...probe, cwd: dataDir, method: 'skills/list', params: { cwds: [folder.path] } }).then(result => {
                const skills = (result?.data ?? []).flatMap(item => Array.isArray(item?.skills) ? item.skills : []).filter(skill => skill?.enabled !== false && typeof skill?.name === 'string' && /^[\w:.-]{1,80}$/.test(skill.name) && typeof skill.path === 'string');
                if (!result) return null;
                codexSkills.set(folder.id, skills.map(skill => ({ name: skill.name, path: skill.path })));
                return skills.map(skill => ({ name: skill.name, description: oneLine(skill.interface?.shortDescription || skill.shortDescription || skill.description, 160), hint: '' }));
              });
              commandLists.set(key, { at: Date.now(), value: value.then(list => { if (!list) commandLists.delete(key); return list ?? []; }) });
            }
            return json(response, 200, { commands: await commandLists.get(key).value });
          }
          return json(response, 200, { sessions: (await externalSessions(folder)).map(({ lastPrompt, lastReply, ...session }) => ({ ...session, preview: plainText(lastReply || lastPrompt || '').slice(0, 160) || null })) });
        }
        if (route === '/api/chats/continue' && request.method === 'POST') {
          const input = await body(request), folder = project(text(input.projectId, 'project id', 128)), agent = listed(input.agent, agentIds, 'agent'), sessionId = text(input.sessionId, 'session id', 128);
          if (!enabled[agent]) throw fail(409, `${agentNames[agent]} is turned off. Turn it on in Settings.`);
          const waitingChat = get('SELECT id FROM chats WHERE forkFrom=? AND sessionStarted=0', sessionId);
          if (waitingChat) return json(response, 200, chat(waitingChat.id));
          const session = (await externalSessions(folder)).find(item => item.id === sessionId && item.agent === agent);
          if (!session) throw fail(404, 'Session not found in this project');
          if (closed) throw fail(503, 'Mac service is shutting down');
          const created = transaction(() => {
            // Another request for the same session may have created the chat while this one listed sessions.
            const raced = get('SELECT id FROM chats WHERE forkFrom=? AND sessionStarted=0', sessionId);
            if (raced) return raced.id;
            const id = randomUUID(), defaults = catalogs[agent];
            run('INSERT INTO chats (id,projectId,agent,title,mode,model,effort,status,updatedAt,forkFrom) VALUES (?,?,?,?,?,?,?,?,?,?)', id, folder.id, agent, oneLine(session.title, 160) || 'Continued session', 'bypassPermissions', defaults?.defaultModel ?? 'default', defaults?.defaultEffort ?? 'default', 'idle', Date.now(), sessionId);
            // Only the last exchange comes along, as context; the full history stays in the session the agent resumes.
            if (session.lastPrompt) message(id, 'user', session.lastPrompt, randomUUID(), { kind: 'imported' });
            if (session.lastReply) message(id, 'assistant', session.lastReply, randomUUID(), { kind: 'imported' });
            change('state', id);
            return id;
          });
          return json(response, 201, chat(created));
        }
        if (route === '/api/projects' && request.method === 'POST') {
          if (!equal(bearer, localToken)) throw fail(403, 'Register projects on the Mac');
          const input = await body(request); let path;
          try { path = realpathSync(text(input.path, 'path', 4096)); if (!statSync(path).isDirectory()) throw new Error(); } catch { throw fail(400, 'Project must be an existing directory'); }
          const existing = get('SELECT id,name,path,lastUsedAt FROM projects WHERE path=?', path); if (existing) return json(response, 200, { ...existing, lastUsedAt: Number(existing.lastUsedAt || 0) });
          const project = { id: randomUUID(), name: input.name ? text(input.name, 'project name', 100) : basename(path), path, lastUsedAt: Date.now() };
          run('INSERT INTO projects (id,name,path,lastUsedAt) VALUES (?,?,?,?)', project.id, project.name, project.path, project.lastUsedAt); change('state'); return json(response, 201, project);
        }
        if (route === '/api/chats' && request.method === 'POST') {
          const input = await body(request); text(input.projectId, 'project id', 128); if (!get('SELECT id FROM projects WHERE id=?', input.projectId)) throw fail(404, 'Project not found');
          const agent = input.agent === undefined ? 'claude' : listed(input.agent, agentIds, 'agent'), options = await chatOptions(agent, input);
          if (!enabled[agent]) throw fail(409, `${agentNames[agent]} is turned off. Turn it on in Settings.`);
          if (closed) throw fail(503, 'Mac service is shutting down');
          const id = randomUUID();
          run('INSERT INTO chats (id,projectId,agent,title,mode,model,effort,status,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)', id, input.projectId, agent, input.title ? text(input.title, 'title', 160) : 'New chat', options.mode ?? 'bypassPermissions', options.model ?? 'default', options.effort ?? 'default', 'idle', Date.now()); change('state', id); return json(response, 201, chat(id));
        }
        const chatRoute = route.match(/^\/api\/chats\/([^/]+)\/(messages|prompts|stop|delete|rename)$/);
        if (chatRoute) {
          const [, id, action] = chatRoute;
          if (action === 'delete' && request.method === 'POST') {
            await body(request);
            const row = get('SELECT status FROM chats WHERE id=?', id);
            if (!row) { if (get('SELECT id FROM deleted_chats WHERE id=?', id)) return json(response, 200, { ok: true }); throw fail(404, 'Chat not found'); }
            if (active.has(id) || ['running', 'stopping', 'waiting'].includes(row.status)) throw fail(409, 'Stop this chat before deleting it');
            transaction(() => {
              run('DELETE FROM messages WHERE chatId=?', id); run('DELETE FROM approvals WHERE chatId=?', id); run('DELETE FROM raw_events WHERE chatId=?', id); run('DELETE FROM runtimes WHERE chatId=?', id);
              run('DELETE FROM subagents WHERE chatId=?', id);
              for (const upload of all('SELECT * FROM uploads WHERE chatId=?', id)) rmSync(uploadPath(upload), { force: true });
              run('DELETE FROM uploads WHERE chatId=?', id);
              // A deleted Codex chat's thread stays out of "On this Mac" too.
              const thread = get('SELECT agentSession FROM chats WHERE id=?', id)?.agentSession; if (thread) run('INSERT OR IGNORE INTO hidden_sessions VALUES (?)', thread);
              run('INSERT OR REPLACE INTO deleted_chats VALUES (?,?)', id, Date.now()); run('DELETE FROM chats WHERE id=?', id); change('state', id);
            });
            return json(response, 200, { ok: true });
          }
          if (action === 'prompts' && request.method === 'POST') {
            const input = await body(request);
            if (get('SELECT id FROM deleted_chats WHERE id=?', id)) throw fail(410, 'Chat was deleted');
            const attachmentIds = input.attachments === undefined ? [] : input.attachments;
            if (!Array.isArray(attachmentIds) || attachmentIds.length > 8 || attachmentIds.some(item => typeof item !== 'string' || !uuid(item))) throw fail(400, 'Attachments must be up to 8 upload ids');
            // A screenshot alone is a complete prompt; the agent gets a plain instruction to look at it.
            const imageOnly = attachmentIds.length > 0 && typeof input.text === 'string' && !input.text.trim();
            const promptId = text(input.id, 'prompt id', 128), prompt = imageOnly ? (attachmentIds.length === 1 ? 'Look at the attached image.' : 'Look at the attached images.') : text(input.text, 'prompt');
            // A retry is judged on the recorded payload alone, so a later catalog change cannot turn it into a new turn.
            const recorded = () => get('SELECT * FROM prompts WHERE id=?', promptId);
            const duplicate = previous => {
              const same = previous.chatId === id && previous.text === prompt && (previous.attachments ?? '[]') === JSON.stringify(attachmentIds) && (input.mode === undefined || previous.mode === input.mode) && (input.model === undefined || (previous.model ?? 'default') === input.model) && (input.effort === undefined || (previous.effort ?? 'default') === input.effort) && (input.agent === undefined || (previous.agent ?? 'claude') === input.agent);
              if (!same) throw fail(409, 'Prompt id was already used for different content');
              return json(response, 200, { accepted: true, duplicate: true });
            };
            if (recorded()) return duplicate(recorded());
            let stored = get('SELECT * FROM chats WHERE id=?', id);
            const agent = stored?.agent || (input.agent === undefined ? 'claude' : listed(input.agent, agentIds, 'agent'));
            if (stored && input.agent !== undefined && input.agent !== agent) throw fail(409, 'Chat already uses another agent');
            const requested = await chatOptions(agent, input, stored);
            // Validation may have waited for a model catalog: shutdown or a concurrent retry could have begun meanwhile.
            if (closed) throw fail(503, 'Mac service is shutting down');
            if (recorded()) return duplicate(recorded());
            if (get('SELECT id FROM deleted_chats WHERE id=?', id)) throw fail(410, 'Chat was deleted');
            stored = get('SELECT * FROM chats WHERE id=?', id);
            if (stored && (stored.agent || 'claude') !== agent) throw fail(409, 'Chat already uses another agent');
            let project, next;
            if (!stored) {
              if (input.projectId === undefined) throw fail(404, 'Chat not found');
              if (!uuid(id)) throw fail(400, 'Invalid chat id');
              const projectId = text(input.projectId, 'project id', 128);
              project = get('SELECT * FROM projects WHERE id=?', projectId); if (!project) throw fail(404, 'Project not found');
              next = { projectId, title: imageOnly ? (attachmentIds.length === 1 ? 'Screenshot' : 'Screenshots') : prompt.slice(0, 80), mode: requested.mode ?? 'bypassPermissions', model: requested.model ?? 'default', effort: requested.effort ?? 'default', status: 'idle' };
            } else {
              if (input.projectId !== undefined && text(input.projectId, 'project id', 128) !== stored.projectId) throw fail(409, 'Chat already belongs to another project');
              project = get('SELECT * FROM projects WHERE id=?', stored.projectId);
              next = { projectId: stored.projectId, title: stored.title === 'New chat' ? (imageOnly ? (attachmentIds.length === 1 ? 'Screenshot' : 'Screenshots') : prompt.slice(0, 80)) : stored.title, mode: requested.mode ?? stored.mode, model: requested.model ?? stored.model ?? 'default', effort: requested.effort ?? stored.effort ?? 'default', status: stored.status };
            }
            // While a turn runs, a prompt can steer it (default for clients that ask) or interrupt it and go next.
            const busy = active.has(id) || ['running', 'stopping', 'waiting'].includes(next.status);
            const runner = active.get(id), delivery = busy ? input.delivery : 'turn';
            if (busy && (!['steer', 'interrupt'].includes(delivery) || !runner || runner.stopped || next.status === 'stopping')) throw fail(409, 'Chat is busy; wait or stop it before sending another prompt');
            const uploads = attachmentIds.map(uploadId => get('SELECT * FROM uploads WHERE id=?', uploadId));
            if (uploads.some(upload => !upload || (upload.chatId && upload.chatId !== id) || !existsSync(uploadPath(upload)))) throw fail(400, 'Attachment not found');
            try { if (!statSync(project.path).isDirectory()) throw new Error(); } catch { throw fail(409, 'Project directory is missing'); }
            if (!enabled[agent]) throw fail(409, `${agentNames[agent]} is turned off. Turn it on in Settings.`);
            if (!available[agent]) throw fail(503, agent === 'codex' ? 'Codex is not installed or could not be started' : 'Claude Code is not installed or could not be started');
            transaction(() => {
              if (!stored) run('INSERT INTO chats (id,projectId,agent,title,mode,model,effort,status,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)', id, next.projectId, agent, next.title, next.mode, next.model, next.effort, 'running', Date.now());
              else if (busy) run('UPDATE chats SET mode=?,model=?,effort=?,updatedAt=? WHERE id=?', next.mode, next.model, next.effort, Date.now(), id);
              else run('UPDATE chats SET mode=?,model=?,effort=?,title=?,status=?,error=NULL,updatedAt=? WHERE id=?', next.mode, next.model, next.effort, next.title, 'running', Date.now(), id);
              run('INSERT INTO prompts (id,chatId,text,mode,model,effort,agent,attachments,delivery) VALUES (?,?,?,?,?,?,?,?,?)', promptId, id, prompt, next.mode, next.model, next.effort, agent, JSON.stringify(attachmentIds), delivery);
              for (const upload of uploads) run('UPDATE uploads SET chatId=? WHERE id=?', id, upload.id);
              message(id, 'user', prompt, promptId, { attachments: uploads.map(upload => ({ id: upload.id, type: upload.type })), kind: delivery === 'turn' ? null : delivery }); change('state', id);
            });
            const handoff = { promptId, text: prompt, attachments: uploads.map(upload => ({ id: upload.id, type: upload.type, path: uploadPath(upload) })), kind: delivery };
            try { if (busy) runner[delivery](handoff); else start(id, handoff); }
            catch (error) {
              // The prompt is recorded, so a retry stays a duplicate; the chat says why it didn't run.
              console.error(`Chat ${id} start: ${error.stack ?? error.message}`);
              if (!busy) { const failed = active.get(id); active.delete(id); if (failed?.child?.pid) terminateGroup(failed.child.pid, 1000).catch(() => {}); status(id, 'error', `Could not start ${agentNames[agent]}: ${error.message}`); }
            }
            return json(response, 202, { accepted: true, duplicate: false, delivery });
          }
          const row = { ...chat(id), activity: get('SELECT activity FROM chats WHERE id=?', id)?.activity };
          if (action === 'messages' && request.method === 'GET') {
            const messages = all('SELECT * FROM messages WHERE chatId=? ORDER BY rowid', id).map(item => {
              const { attachments, kind, ...rest } = item;
              return { ...rest, ...(attachments ? { attachments: JSON.parse(attachments) } : {}), ...(kind ? { kind } : {}) };
            });
            // Turn timing: each prompt that started a turn, with its end once the agent finished it.
            const turns = all("SELECT id,startedAt,endedAt FROM prompts WHERE chatId=? AND startedAt IS NOT NULL ORDER BY startedAt", id);
            const subagents = all('SELECT id,promptId,agent,title,kind,model,effort,status,activity,startedAt,endedAt,toolUses,tokens FROM subagents WHERE chatId=? ORDER BY startedAt', id)
              .map(item => ({ ...item, model: item.model ? modelDisplay(item.agent, item.model) : null }));
            return json(response, 200, { messages, approvals: all('SELECT * FROM approvals WHERE chatId=? ORDER BY rowid', id).map(item => ({ ...item, input: JSON.parse(item.input) })), turns, subagents, activity: row.activity ?? null });
          }
          if (action === 'stop' && request.method === 'POST') { stop(id); return json(response, 200, { ok: true }); }
          if (action === 'rename' && request.method === 'POST') {
            const input = await body(request), title = text(input.title, 'title', 160);
            run('UPDATE chats SET title=?,updatedAt=? WHERE id=?', title, Date.now(), id); change('state', id); return json(response, 200, chat(id));
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
          const client = { response, seq: Math.min(after, lastSeq()), statusOnly: url.searchParams.get('scope') === 'status' }; clients.add(client); replay(client);
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
  } catch (error) { closed = true; probes.abort(); clearTimeout(eventTimer); releaseOwner(); db.close(); throw error; }
  localUrl = `http://127.0.0.1:${server.address().port}`; publicUrl ??= localUrl;
  let closePromise;
  const close = () => closePromise ??= (async () => {
    closed = true; probes.abort(); for (const id of active.keys()) stop(id);
    while (active.size) await pause(20); clearTimeout(eventTimer);
    for (const client of clients) client.response.end();
    await new Promise(resolveClosed => {
      const deadline = setTimeout(() => server.closeAllConnections(), options.shutdownTimeoutMs ?? 1000);
      server.close(() => { clearTimeout(deadline); resolveClosed(); }); server.closeIdleConnections();
    });
    releaseOwner(); db.close();
  })();
  return { server, url: localUrl, publicUrl, close, state, ready: catalogsReady };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = await createService(); console.log(`PocketBridge listening on ${service.url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0); });
}
