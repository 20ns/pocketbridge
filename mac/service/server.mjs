// PocketBridge Mac service: owns chats and their saved state, runs the official Claude and Codex CLIs, and serves
// the phone and browser clients over HTTP and Server-Sent Events. See PROTOCOL.md.
import http from 'node:http';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { agentIds, agentModes } from './agents.mjs';
import { openDatabase } from './database.mjs';
import { createAgents, legacyModels, legacyEfforts } from './catalogs.mjs';
import { createProjects } from './projects.mjs';
import { createRuns } from './runs.mjs';
import { createRoutes } from './routes.mjs';
import { secret, fail, plainText, pause, processStamp, terminateGroup } from './util.mjs';

export async function createService(options = {}) {
  const dataDir = options.dataDir ?? process.env.POCKETBRIDGE_DATA_DIR ?? join(homedir(), 'Library/Application Support/PocketBridge');
  const defaultProjects = join(homedir(), '.claude', 'projects');
  const claudeProjectsDir = options.claudeProjectsDir ?? process.env.POCKETBRIDGE_CLAUDE_PROJECTS_DIR ?? defaultProjects;
  if (process.env.NODE_TEST_CONTEXT && resolve(claudeProjectsDir) === resolve(defaultProjects)) throw new Error('Tests must pass claudeProjectsDir and must not read Claude history');
  const testing = Boolean(process.env.NODE_TEST_CONTEXT);
  const codexSessionsDir = options.codexSessionsDir ?? process.env.POCKETBRIDGE_CODEX_SESSIONS_DIR ?? (testing ? null : join(homedir(), '.codex', 'sessions'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const database = openDatabase(dataDir), { db, get, all, run, transaction, setting, saveSetting } = database;
  // Shared by the service modules. Each adds its own part: agents, projects, runs.
  const ctx = { ...database, options, dataDir, testing, claudeProjectsDir, codexSessionsDir, closed: false, probes: new AbortController(), internalToken: secret(), clients: new Set(), active: new Map(), waiting: new Map() };
  let eventTimer;
  ctx.localToken = setting('localToken');
  if (!ctx.localToken) { run('INSERT OR IGNORE INTO settings VALUES (?,?)', 'localToken', secret()); ctx.localToken = setting('localToken'); }
  const agents = ctx.agents = createAgents(ctx);
  await agents.select();
  let publicUrl = options.publicUrl ?? process.env.POCKETBRIDGE_PUBLIC_URL;
  if (publicUrl) { const address = new URL(publicUrl); if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash || address.pathname !== '/') throw new Error('POCKETBRIDGE_PUBLIC_URL must be an HTTP(S) origin'); publicUrl = address.origin; }
  ctx.publicUrl = publicUrl;

  const lastSeq = ctx.lastSeq = () => Number(get('SELECT COALESCE(MAX(seq),0) AS n FROM events').n);
  ctx.replay = client => {
    if (ctx.closed || client.replaying || client.response.destroyed || client.response.writableEnded) return;
    client.replaying = true;
    const batch = () => {
      if (ctx.closed || client.response.destroyed || client.response.writableEnded) return;
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
  const change = ctx.change = (type, chatId = null) => {
    run('INSERT INTO events (chatId,type) VALUES (?,?)', chatId, type);
    // Durable rows precede notification; batch UI refreshes to avoid token-rate fetching.
    if (!eventTimer) eventTimer = setTimeout(() => { eventTimer = undefined; for (const client of ctx.clients) ctx.replay(client); }, 200);
  };
  const chatRow = row => {
    row.agent ||= 'claude'; row.model ||= 'default'; row.effort ||= 'default'; row.speed ||= null;
    if (row.contextTokens > 0 && row.contextWindow > 0) row.context = { used: row.contextTokens, window: row.contextWindow };
    delete row.contextTokens; delete row.contextWindow;
    if (!row.activity) delete row.activity;
    if (!row.error) delete row.error;
    if (row.preview === null) delete row.preview; else if (typeof row.preview === 'string') row.preview = plainText(row.preview).slice(0, 160);
    return row;
  };
  ctx.chat = id => {
    const row = get('SELECT id,projectId,agent,title,mode,model,effort,speed,status,updatedAt,error FROM chats WHERE id=?', id);
    if (!row) throw fail(404, 'Chat not found');
    return chatRow(row);
  };
  const state = ctx.state = () => {
    for (const agent of agentIds) agents.refreshCatalog(agent);
    return {
      projects: ctx.projects.list(),
      // The newest reply or prompt previews each chat; tool activity is left out.
      chats: all(`SELECT id,projectId,agent,title,mode,model,effort,speed,status,updatedAt,error,contextTokens,contextWindow,activity,
        (SELECT substr(text,1,400) FROM messages m WHERE m.chatId=chats.id AND m.role!='activity' ORDER BY m.rowid DESC LIMIT 1) AS preview
        FROM chats ORDER BY updatedAt DESC`).map(chatRow),
      lastSeq: lastSeq(), capabilities: { modes: agentModes.claude, models: legacyModels, efforts: legacyEfforts, agents: agentIds.map(agents.agentCatalog) },
      server: { claudeAvailable: agents.available.claude, codexAvailable: agents.available.codex, publicUrl: ctx.publicUrl },
    };
  };
  const status = ctx.status = (id, value, error = null) => { run('UPDATE chats SET status=?,error=?,updatedAt=? WHERE id=?', value, error, Date.now(), id); change('state', id); };

  // One service per data folder: a live owner (same PID and start time) blocks a second one.
  const startTime = processStamp(process.pid);
  if (!startTime) { db.close(); throw new Error('Could not verify the Mac service process identity'); }
  const owner = JSON.stringify({ pid: process.pid, startTime });
  try {
    transaction(() => {
      const previous = setting('serviceOwner');
      if (previous) {
        const processOwner = JSON.parse(previous);
        if (processOwner.startTime && processStamp(processOwner.pid) === processOwner.startTime) throw new Error('PocketBridge is already running with this data folder');
      } else if (existsSync(join(dataDir, 'service.pid'))) {
        const pid = Number(readFileSync(join(dataDir, 'service.pid'), 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
          const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 }).stdout?.trim();
          if (command?.includes('/scripts/run.mjs')) throw new Error('PocketBridge is already running. Stop the older service before starting this update');
        }
      }
      saveSetting('serviceOwner', owner);
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
      // Its turn and any sub-agents ended with the old process; nothing should keep ticking.
      run("UPDATE subagents SET status='stopped',endedAt=? WHERE chatId=? AND status='running'", Date.now(), row.id);
      run('UPDATE prompts SET endedAt=? WHERE chatId=? AND startedAt IS NOT NULL AND endedAt IS NULL', Date.now(), row.id);
    }
  } catch (error) { clearTimeout(eventTimer); releaseOwner(); db.close(); throw error; }

  const projects = ctx.projects = createProjects(ctx);
  projects.refreshDiscovery(true);
  const catalogsReady = agents.load();
  ctx.runs = createRuns(ctx);
  const server = ctx.server = http.createServer(createRoutes(ctx));
  server.requestTimeout = 30_000; server.headersTimeout = 20_000;
  try {
    await new Promise((resolveListening, reject) => { server.once('error', reject); server.listen(options.port ?? Number(process.env.POCKETBRIDGE_PORT ?? 8787), options.host ?? '127.0.0.1', resolveListening); });
  } catch (error) { ctx.closed = true; ctx.probes.abort(); projects.close(); clearTimeout(eventTimer); releaseOwner(); db.close(); throw error; }
  ctx.localUrl = `http://127.0.0.1:${server.address().port}`; ctx.publicUrl ??= ctx.localUrl;
  projects.refreshIcons();
  let closePromise;
  const close = () => closePromise ??= (async () => {
    ctx.closed = true; ctx.probes.abort(); for (const id of ctx.active.keys()) ctx.runs.stop(id);
    while (ctx.active.size) await pause(20);
    await projects.close(); clearTimeout(eventTimer);
    for (const client of ctx.clients) client.response.end();
    await new Promise(resolveClosed => {
      const deadline = setTimeout(() => server.closeAllConnections(), options.shutdownTimeoutMs ?? 1000);
      server.close(() => { clearTimeout(deadline); resolveClosed(); }); server.closeIdleConnections();
    });
    releaseOwner(); db.close();
  })();
  return { server, url: ctx.localUrl, publicUrl: ctx.publicUrl, close, state, ready: catalogsReady };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = await createService(); console.log(`PocketBridge listening on ${service.url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0); });
}
