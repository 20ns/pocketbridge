// HTTP routes: the JSON API, the event stream, uploads and the local browser client's static files.
import { randomUUID, randomBytes } from 'node:crypto';
import { statSync, realpathSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join, extname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import QRCode from 'qrcode';
import { agentIds, agentNames } from './agents.mjs';
import { createPrompts } from './prompts.mjs';
import { secret, loopback, equal, fail, text, listed, plainText, oneLine, uuid, openUrl, imageType, imageExtensions } from './util.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export function createRoutes(ctx) {
  const { options, dataDir, get, all, run, transaction, change, status, chat, active, waiting, agents, projects, runs } = ctx;
  const { available, enabled, catalogs } = agents;
  const { stop, message } = runs;
  const uploadsDir = join(dataDir, 'uploads'); mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  const uploadPath = row => join(uploadsDir, `${row.id}.${imageExtensions[row.type]}`);
  const pairAttempts = new Map();
  let latestPair;
  const deliver = createPrompts(ctx, uploadPath);
  // Transcripts are mostly text; gzip keeps phone refreshes small over Tailscale.
  const json = (response, code, value) => {
    const payload = JSON.stringify(value), compress = response.gzip && payload.length > 1400;
    response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(compress ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
    response.end(compress ? gzipSync(payload, { level: 4 }) : payload);
  };
  const body = async request => {
    // Chunks are joined as bytes first: a character split across two network chunks must not be corrupted.
    const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > 200_000) throw fail(413, 'Request too large'); chunks.push(chunk); }
    if (ctx.closed) throw fail(503, 'Mac service is shutting down');
    try { const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(); return result; } catch { throw fail(400, 'Invalid JSON body'); }
  };
  const rawBody = async (request, max) => {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > max) throw fail(413, 'Image is too large; the limit is 5 MB'); chunks.push(chunk); }
    if (ctx.closed) throw fail(503, 'Mac service is shutting down');
    return Buffer.concat(chunks);
  };
  const pairing = () => {
    const code = randomBytes(5).toString('hex').toUpperCase();
    latestPair = { code, expiresAt: Date.now() + 600_000, url: ctx.publicUrl, link: `pocketbridge://pair?url=${encodeURIComponent(ctx.publicUrl)}&code=${code}` }; return latestPair;
  };
  return async (request, response) => {
    response.gzip = /\bgzip\b/.test(request.headers['accept-encoding'] ?? '');
    try {
      if (ctx.closed) throw fail(503, 'Mac service is shutting down');
      const port = ctx.server.address().port, localUrl = ctx.localUrl, publicUrl = ctx.publicUrl;
      const allowedHosts = new Set([new URL(localUrl).host, `localhost:${port}`, `10.0.2.2:${port}`, new URL(publicUrl).host]);
      if (!allowedHosts.has(request.headers.host)) throw fail(403, 'Unknown host');
      if (request.headers.origin && ![localUrl, localUrl.replace('127.0.0.1', 'localhost'), publicUrl].includes(request.headers.origin)) throw fail(403, 'Unknown origin');
      const url = new URL(request.url, localUrl), route = url.pathname, bearer = request.headers.authorization?.replace(/^Bearer /, '');
      if (route === '/internal/approval' && request.method === 'POST') {
        if (!loopback(request.socket.remoteAddress) || !equal(bearer, ctx.internalToken)) throw fail(401, 'Unauthorized');
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
        return json(response, 200, { token: ctx.localToken });
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
        if (!equal(bearer, ctx.localToken) && !(typeof bearer === 'string' && get('SELECT token FROM tokens WHERE token=?', bearer))) throw fail(401, 'Unauthorized');
        if (route === '/api/state' && request.method === 'GET') { projects.refreshDiscovery(); projects.refreshIcons(); return json(response, 200, ctx.state()); }
        if (route === '/api/pairing' && request.method === 'GET') return json(response, 200, pairing());
        if (route === '/api/usage' && request.method === 'GET') return json(response, 200, { agents: await agents.usageReport() });
        if (route === '/api/usage/codex/reset' && request.method === 'POST') {
          const input = await body(request);
          if (!uuid(input.id)) throw fail(400, 'id must be a UUID for this reset attempt');
          if (input.creditId !== undefined && input.creditId !== null && (typeof input.creditId !== 'string' || !/^[\w.:-]{1,200}$/.test(input.creditId))) throw fail(400, 'Invalid credit id');
          const answer = await agents.redeemReset(input.id.toLowerCase(), input.creditId ?? null);
          if (!answer) throw fail(504, 'Codex did not answer. Try again; the same attempt cannot use a second reset.');
          if (answer.error) throw fail(502, answer.error);
          return json(response, 200, { outcome: answer.outcome });
        }
        const agentRoute = route.match(/^\/api\/agents\/([^/]+)$/);
        if (agentRoute && request.method === 'POST') {
          const agent = listed(agentRoute[1], agentIds, 'agent'), input = await body(request);
          if (typeof input.enabled !== 'boolean') throw fail(400, 'enabled must be true or false');
          agents.setEnabled(agent, input.enabled);
          if (input.enabled) projects.refreshDiscovery(true);
          change('state'); return json(response, 200, agents.agentCatalog(agent));
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
        const projectRoute = route.match(/^\/api\/projects\/([^/]+)\/(git|commands|sessions|icon)$/);
        if (projectRoute && request.method === 'GET') {
          const folder = projects.project(projectRoute[1]);
          if (projectRoute[2] === 'icon') {
            const icon = projects.iconOf(folder.id);
            response.writeHead(200, { 'Content-Type': icon.type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' }); response.end(icon.data); return;
          }
          if (projectRoute[2] === 'git') {
            const git = await projects.git(folder);
            return json(response, 200, git ? { repo: true, ...git } : { repo: false });
          }
          if (projectRoute[2] === 'commands') return json(response, 200, { commands: await projects.commands(folder, listed(url.searchParams.get('agent') ?? 'claude', agentIds, 'agent')) });
          return json(response, 200, { sessions: (await projects.externalSessions(folder)).map(({ lastPrompt, lastReply, ...session }) => ({ ...session, preview: plainText(lastReply || lastPrompt || '').slice(0, 160) || null })) });
        }
        if (route === '/api/chats/continue' && request.method === 'POST') {
          const input = await body(request), folder = projects.project(text(input.projectId, 'project id', 128)), agent = listed(input.agent, agentIds, 'agent'), sessionId = text(input.sessionId, 'session id', 128);
          if (!enabled[agent]) throw fail(409, `${agentNames[agent]} is turned off. Turn it on in Settings.`);
          const waitingChat = get('SELECT id FROM chats WHERE forkFrom=? AND sessionStarted=0', sessionId);
          if (waitingChat) return json(response, 200, chat(waitingChat.id));
          const session = (await projects.externalSessions(folder)).find(item => item.id === sessionId && item.agent === agent);
          if (!session) throw fail(404, 'Session not found in this project');
          if (agent === 'codex') Object.assign(session, await projects.codexLastExchange(sessionId) ?? {});
          if (ctx.closed) throw fail(503, 'Mac service is shutting down');
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
        // A new project is a new, empty folder in the experiments folder. The client's id makes a retry return the same project.
        if (route === '/api/projects/new' && request.method === 'POST') {
          if (!ctx.experimentsDir) throw fail(404, 'New projects are not set up on this Mac');
          const input = await body(request), id = text(input.id, 'project id', 64), name = text(input.name, 'project name', 64).trim();
          if (!uuid(id)) throw fail(400, 'Invalid project id');
          // A retry whose first attempt registered the project but stopped before its folder existed finishes the folder.
          const known = get('SELECT * FROM projects WHERE id=?', id); if (known) { mkdirSync(known.path, { recursive: true }); return json(response, 200, projects.projectRow(known)); }
          if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name) || /[. ]$/.test(name)) throw fail(400, 'Use letters, numbers, spaces, dots, dashes or underscores');
          mkdirSync(ctx.experimentsDir, { recursive: true });
          const folder = join(realpathSync(ctx.experimentsDir), name);
          if (existsSync(folder)) throw fail(409, 'A folder with that name already exists');
          // Registered first, so a crash before the folder exists leaves a record a retry with the same id completes.
          const project = { id, name, path: folder, lastUsedAt: Date.now(), icon: null };
          run('INSERT INTO projects (id,name,path,lastUsedAt) VALUES (?,?,?,?)', project.id, project.name, project.path, project.lastUsedAt);
          try { mkdirSync(folder); } catch (error) { run('DELETE FROM projects WHERE id=?', id); throw error.code === 'EEXIST' ? fail(409, 'A folder with that name already exists') : error; }
          change('state');
          return json(response, 201, project);
        }
        if (route === '/api/projects' && request.method === 'POST') {
          if (!equal(bearer, ctx.localToken)) throw fail(403, 'Register projects on the Mac');
          const input = await body(request); let path;
          try { path = realpathSync(text(input.path, 'path', 4096)); if (!statSync(path).isDirectory()) throw new Error(); } catch { throw fail(400, 'Project must be an existing directory'); }
          const existing = get('SELECT * FROM projects WHERE path=?', path); if (existing) return json(response, 200, projects.projectRow(existing));
          const project = { id: randomUUID(), name: input.name ? text(input.name, 'project name', 100) : basename(path), path, lastUsedAt: Date.now(), icon: null };
          run('INSERT INTO projects (id,name,path,lastUsedAt) VALUES (?,?,?,?)', project.id, project.name, project.path, project.lastUsedAt); change('state'); projects.refreshIcons(); return json(response, 201, project);
        }
        if (route === '/api/chats' && request.method === 'POST') {
          const input = await body(request); text(input.projectId, 'project id', 128); if (!get('SELECT id FROM projects WHERE id=?', input.projectId)) throw fail(404, 'Project not found');
          const agent = input.agent === undefined ? 'claude' : listed(input.agent, agentIds, 'agent'), options = await agents.chatOptions(agent, input);
          if (!enabled[agent]) throw fail(409, `${agentNames[agent]} is turned off. Turn it on in Settings.`);
          if (ctx.closed) throw fail(503, 'Mac service is shutting down');
          const id = randomUUID();
          run('INSERT INTO chats (id,projectId,agent,title,mode,model,effort,speed,status,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)', id, input.projectId, agent, input.title ? text(input.title, 'title', 160) : 'New chat', options.mode ?? 'bypassPermissions', options.model ?? 'default', options.effort ?? 'default', options.speed ?? null, 'idle', Date.now()); change('state', id); return json(response, 201, chat(id));
        }
        const chatRoute = route.match(/^\/api\/chats\/([^/]+)\/(messages|prompts|stop|delete|rename|desktop)$/);
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
          if (action === 'prompts' && request.method === 'POST') { const [code, value] = await deliver(id, await body(request)); return json(response, code, value); }
          const row = { ...chat(id), activity: get('SELECT activity FROM chats WHERE id=?', id)?.activity };
          if (action === 'messages' && request.method === 'GET') {
            const messages = all('SELECT * FROM messages WHERE chatId=? ORDER BY rowid', id).map(item => {
              const { attachments, kind, ...rest } = item;
              return { ...rest, ...(attachments ? { attachments: JSON.parse(attachments) } : {}), ...(kind ? { kind } : {}) };
            });
            // Turn timing: each prompt that started a turn, with its end once the agent finished it.
            const turns = all("SELECT id,startedAt,endedAt FROM prompts WHERE chatId=? AND startedAt IS NOT NULL ORDER BY startedAt", id);
            const subagents = all('SELECT id,promptId,agent,title,kind,model,effort,status,activity,startedAt,endedAt,toolUses,tokens FROM subagents WHERE chatId=? ORDER BY startedAt', id)
              .map(item => ({ ...item, model: item.model ? agents.modelDisplay(item.agent, item.model) : null }));
            return json(response, 200, { messages, approvals: all('SELECT * FROM approvals WHERE chatId=? ORDER BY rowid', id).map(item => ({ ...item, input: JSON.parse(item.input) })), turns, subagents, activity: row.activity ?? null });
          }
          if (action === 'stop' && request.method === 'POST') { stop(id); return json(response, 200, { ok: true }); }
          // Claude Desktop lists only sessions handed to it; this is the same claude://resume link the CLI's /desktop opens.
          if (action === 'desktop' && request.method === 'POST') {
            const row = get('SELECT agent,status,sessionStarted FROM chats WHERE id=?', id);
            if (!row) throw fail(404, 'Chat not found');
            if ((row.agent || 'claude') !== 'claude') throw fail(409, 'Only Claude chats open in Claude Desktop');
            if (!row.sessionStarted) throw fail(409, 'Send a prompt first');
            if (active.has(id) || ['running', 'waiting', 'stopping'].includes(row.status)) throw fail(409, 'Wait for this chat to finish, so both apps don\'t write to it at once');
            const opened = await (options.openUrl ?? openUrl)(`claude://resume?session=${encodeURIComponent(id)}`);
            if (!opened) throw fail(502, 'Couldn\'t open Claude Desktop on the Mac');
            return json(response, 200, { ok: true });
          }
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
          const client = { response, seq: Math.min(after, ctx.lastSeq()), statusOnly: url.searchParams.get('scope') === 'status' }; ctx.clients.add(client); ctx.replay(client);
          const heartbeat = setInterval(() => { if (!client.replaying) response.write(': keepalive\n\n'); }, 15_000); response.on('close', () => { clearInterval(heartbeat); ctx.clients.delete(client); }); return;
        }
        throw fail(404, 'Route not found');
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw fail(405, 'Method not allowed');
      const uiDir = options.uiDir ?? join(here, '../public'), path = resolve(uiDir, `.${route === '/' ? '/index.html' : route}`);
      if (!path.startsWith(resolve(uiDir) + '/') || !existsSync(path) || !statSync(path).isFile()) throw fail(404, 'File not found');
      response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); response.end(request.method === 'HEAD' ? undefined : readFileSync(path));
    } catch (error) { if (response.destroyed) return; if (!response.headersSent) json(response, error.status ?? 500, { error: error.status ? error.message : 'Internal service error' }); else response.destroy(); if (!error.status) console.error(error); }
  };
}
