import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, utimesSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createService } from './server.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const wait = async predicate => {
  const end = Date.now() + 4000;
  while (Date.now() < end) { const result = await predicate(); if (result) return result; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Condition did not complete');
};
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pocketbridge-'));
  const projectPath = join(dir, 'project'); mkdirSync(projectPath);
  const claudeProjectsDir = join(dir, 'claude-projects'); mkdirSync(claudeProjectsDir);
  const options = () => ({ port: 0, dataDir: join(dir, 'data'), claudePath: join(here, 'fake-claude.mjs'), stopTimeoutMs: 50, claudeProjectsDir, discoverIntervalMs: 60_000 });
  let service = await createService(options());
  t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });
  let token = (await (await fetch(service.url + '/api/local-session')).json()).token;
  const request = async (route, data, headers = {}) => {
    if (headers.Host) return await new Promise((resolveRequest, reject) => {
      const req = http.get(service.url + route, { headers }, res => { let value = ''; res.on('data', chunk => value += chunk); res.on('end', () => resolveRequest({ status: res.statusCode, data: JSON.parse(value) })); }); req.on('error', reject);
    });
    const response = await fetch(service.url + route, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  };
  const project = (await request('/api/projects', { path: projectPath })).data;
  const createChat = async () => (await request('/api/chats', { projectId: project.id })).data;
  const send = (chat, prompt, id = randomUUID()) => request(`/api/chats/${chat.id}/prompts`, { id, text: prompt });
  const finished = chat => wait(async () => (await request('/api/state')).data.chats.find(c => c.id === chat.id && !['running', 'stopping', 'waiting'].includes(c.status)));
  return { dir, projectPath, claudeProjectsDir, request, createChat, send, finished, get service() { return service; }, get token() { return token; }, async restart() { await service.close(); service = await createService(options()); } };
}

test('prompt delivery is durable and idempotent; stream chunks reconcile with final message; resume uses same session', async t => {
  const f = await fixture(t), chat = await f.createChat(), id = randomUUID();
  assert.equal((await f.send(chat, 'hello', id)).status, 202);
  assert.equal((await f.send(chat, 'hello', id)).data.duplicate, true);
  assert.equal((await f.send(chat, 'different', id)).status, 409);
  assert.equal((await f.request(`/api/chats/${chat.id}/prompts`, { id, text: 'hello', mode: 'auto' })).status, 409);
  assert.equal((await f.finished(chat)).status, 'idle');
  let messages = (await f.request(`/api/chats/${chat.id}/messages`)).data.messages;
  assert.deepEqual(messages.filter(m => m.role === 'assistant').map(m => m.text), ['Hello']);
  assert.equal(messages.filter(m => m.role === 'activity').length, 2);
  await f.restart();
  assert.equal((await f.send(chat, 'hello', id)).data.duplicate, true);
  assert.equal((await f.send(chat, 'next')).status, 202); await f.finished(chat);
  const calls = readFileSync(join(f.projectPath, 'calls.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2); assert.ok(calls[0].args.includes('--session-id')); assert.ok(calls[1].args.includes('--resume'));
  assert.ok(calls.every(c => c.args.includes(chat.id) && c.args.includes('--dangerously-skip-permissions')));
});

test('pairing is one-time, QR matches the issued code, phone token persists, and project registration remains local', async t => {
  const f = await fixture(t), pair = (await f.request('/api/pairing')).data;
  assert.equal(new URL(pair.link).searchParams.get('code'), pair.code);
  const qr = await fetch(f.service.url + `/api/pairing/qr?code=${pair.code}`, { headers: { Authorization: `Bearer ${f.token}` } });
  assert.equal(qr.status, 200); assert.match(await qr.text(), /<svg/);
  const paired = await f.request('/api/pair', { code: pair.code }, { Authorization: '' }); assert.equal(paired.status, 200);
  assert.equal((await f.request('/api/pair', { code: pair.code })).status, 401);
  const phoneToken = paired.data.token;
  assert.equal((await f.request('/api/projects', { path: f.projectPath }, { Authorization: `Bearer ${phoneToken}` })).status, 403);
  await f.restart(); assert.equal((await f.request('/api/state', undefined, { Authorization: `Bearer ${phoneToken}` })).status, 200);
});

test('auth rejects unknown hosts, cross-origin bootstrap, proxy bootstrap, missing token, and invalid cursors', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/state', undefined, { Authorization: '' })).status, 401);
  assert.equal((await f.request('/api/local-session', undefined, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.request('/api/local-session', undefined, { Origin: 'null' })).status, 403);
  assert.equal((await f.request('/api/local-session', undefined, { 'X-Forwarded-For': '1.2.3.4' })).status, 403);
  assert.equal((await f.request('/api/local-session', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await f.request('/api/local-session', undefined, { Host: `10.0.2.2:${f.service.server.address().port}` })).status, 403);
  assert.equal((await f.request('/api/health', undefined, { Host: 'evil.test' })).status, 403);
  assert.equal((await f.request('/api/events?after=-1')).status, 400);
  assert.equal((await f.request('/api/chats', { projectId: 'missing' })).status, 404);
  assert.equal((await f.request('/api/projects', { path: '/this/does/not/exist' })).status, 400);
});

test('SSE replays durable changes strictly after cursor even when disconnected during work', async t => {
  const f = await fixture(t), before = (await f.request('/api/state')).data.lastSeq;
  const chat = await f.createChat(); await f.send(chat, 'hello'); await f.finished(chat);
  const controller = new AbortController();
  const response = await fetch(f.service.url + `/api/events?after=${before}`, { headers: { Authorization: `Bearer ${f.token}` }, signal: controller.signal });
  const reader = response.body.getReader(); const data = new TextDecoder().decode((await reader.read()).value); controller.abort();
  const ids = [...data.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]));
  assert.ok(ids.length > 2); assert.ok(ids.every(id => id > before)); assert.equal(ids.at(-1), (await f.request('/api/state')).data.lastSeq);
});

test('Stop interrupts the entire process group and duplicate delivery cannot restart it', async t => {
  const f = await fixture(t), chat = await f.createChat(), id = randomUUID();
  await f.send(chat, 'hang', id); await wait(() => existsSync(join(f.projectPath, 'child.pid')));
  const pid = Number(readFileSync(join(f.projectPath, 'child.pid'), 'utf8'));
  assert.equal((await f.send(chat, 'new task')).status, 409);
  assert.equal((await f.request(`/api/chats/${chat.id}/stop`, {})).status, 200);
  assert.equal((await f.finished(chat)).status, 'interrupted');
  await wait(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  assert.equal((await f.request(`/api/chats/${chat.id}/stop`, {})).status, 200);
  assert.equal((await f.send(chat, 'hang', id)).data.duplicate, true);
  assert.equal(readFileSync(join(f.projectPath, 'calls.ndjson'), 'utf8').trim().split('\n').length, 1);
});

test('a second service cannot interrupt a live task in the same data folder', async t => {
  const f = await fixture(t), chat = await f.createChat();
  await f.send(chat, 'hang'); await wait(() => existsSync(join(f.projectPath, 'child.pid')));
  const pid = Number(readFileSync(join(f.projectPath, 'child.pid'), 'utf8'));
  await assert.rejects(createService({ port: 0, dataDir: join(f.dir, 'data'), claudePath: join(here, 'fake-claude.mjs'), claudeProjectsDir: f.claudeProjectsDir }), /already running/);
  assert.doesNotThrow(() => process.kill(pid, 0));
  assert.equal((await f.request('/api/state')).data.chats.find(c => c.id === chat.id).status, 'running');
});

test('completed turns clean up tool processes left behind by the CLI', async t => {
  const f = await fixture(t), chat = await f.createChat();
  await f.send(chat, 'orphan'); await wait(() => existsSync(join(f.projectPath, 'child.pid')));
  const pid = Number(readFileSync(join(f.projectPath, 'child.pid'), 'utf8'));
  assert.equal((await f.finished(chat)).status, 'idle');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('failed startup releases ownership so the data folder can be reopened', async t => {
  const f = await fixture(t), dataDir = join(f.dir, 'other-data');
  await assert.rejects(createService({ port: f.service.server.address().port, dataDir, claudeAvailable: false, claudeProjectsDir: f.claudeProjectsDir }), { code: 'EADDRINUSE' });
  const service = await createService({ port: 0, dataDir, claudeAvailable: false, claudeProjectsDir: f.claudeProjectsDir });
  await service.close();
});

test('large durable SSE replay streams every change and accepts Last-Event-ID on reconnect', async t => {
  const f = await fixture(t), before = f.service.state().lastSeq;
  const db = new DatabaseSync(join(f.dir, 'data/data.sqlite'));
  db.exec('BEGIN');
  const insert = db.prepare('INSERT INTO events (chatId,type) VALUES (?,?)');
  for (let i = 0; i < 15000; i++) insert.run(randomUUID(), 'message');
  db.exec('COMMIT'); db.close();
  const last = f.service.state().lastSeq, controller = new AbortController();
  try {
    const response = await fetch(f.service.url + '/api/events', { headers: { Authorization: `Bearer ${f.token}`, 'Last-Event-ID': String(before) }, signal: controller.signal });
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', ids = [];
    while (ids.at(-1) !== last) {
      const { value, done } = await reader.read(); assert.equal(done, false);
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const id = /^id: (\d+)$/m.exec(event); if (id) ids.push(Number(id[1]));
      }
    }
    assert.deepEqual(ids, Array.from({ length: 15000 }, (_, i) => before + i + 1));
    const reconnect = await fetch(f.service.url + `/api/events?after=${before}`, { headers: { Authorization: `Bearer ${f.token}` }, signal: controller.signal });
    await reconnect.body.getReader().read();
    await f.service.close(); // A scheduled replay batch must not read the closed database.
  } finally { controller.abort(); }
});

test('deleted projects reject delivery without consuming id; malformed output and CLI failure surface errors', async t => {
  const f = await fixture(t), chat = await f.createChat(), id = randomUUID();
  rmSync(f.projectPath, { recursive: true });
  assert.equal((await f.send(chat, 'hello', id)).status, 409);
  mkdirSync(f.projectPath); assert.equal((await f.send(chat, 'hello', id)).status, 202); await f.finished(chat);
  for (const invalid of ['malformed', 'null', 'bad-content']) {
    await f.send(chat, invalid); assert.match((await f.finished(chat)).error, /malformed/);
    assert.equal((await f.request('/api/health')).status, 200);
  }
  for (const failure of ['error', 'empty-error']) {
    await f.send(chat, failure); assert.match((await f.finished(chat)).error, /subscription unavailable/);
  }
});

test('pending questions require answers, are visible after disconnect, and resolve once', async t => {
  const f = await fixture(t), chat = await f.createChat(); await f.send(chat, 'question');
  const approval = await wait(async () => (await f.request(`/api/chats/${chat.id}/messages`)).data.approvals.find(a => a.status === 'pending'));
  assert.equal((await f.request('/api/state')).data.chats.find(c => c.id === chat.id).status, 'waiting');
  assert.equal((await f.request(`/api/approvals/${approval.id}`, { decision: 'allow' })).status, 400);
  assert.equal((await f.request(`/api/approvals/${approval.id}`, { decision: 'allow', answers: { 'Which color?': 'Blue' } })).status, 200);
  assert.equal((await f.request(`/api/approvals/${approval.id}`, { decision: 'allow' })).status, 409);
  assert.equal((await f.finished(chat)).status, 'idle');
  const reply = (await f.request(`/api/chats/${chat.id}/messages`)).data.messages.find(m => m.role === 'assistant');
  assert.equal(JSON.parse(reply.text).updatedInput.answers['Which color?'], 'Blue');
});

test('restart marks durable in-flight task interrupted and never reexecutes accepted prompt', async t => {
  const f = await fixture(t), chat = await f.createChat();
  await f.service.close();
  const db = new DatabaseSync(join(f.dir, 'data/data.sqlite'));
  db.prepare("UPDATE chats SET status='running' WHERE id=?").run(chat.id);
  db.prepare('INSERT INTO prompts (id,chatId,text) VALUES (?,?,?)').run('crash-id', chat.id, 'hello'); db.close();
  await f.restart();
  assert.equal((await f.request('/api/state')).data.chats.find(c => c.id === chat.id).status, 'interrupted');
  assert.equal((await f.send(chat, 'hello', 'crash-id')).data.duplicate, true);
  assert.equal(existsSync(join(f.projectPath, 'calls.ndjson')), false);
});

test('crash recovery terminates the same orphan CLI before permitting another turn', async t => {
  const { spawn } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'pocketbridge-crash-')), projectPath = join(dir, 'project'), dataDir = join(dir, 'data'), claudeProjectsDir = join(dir, 'claude-projects'); mkdirSync(projectPath); mkdirSync(claudeProjectsDir);
  const processService = spawn(process.execPath, [join(here, 'server.mjs')], { env: { ...process.env, POCKETBRIDGE_PORT: '0', POCKETBRIDGE_DATA_DIR: dataDir, POCKETBRIDGE_CLAUDE_PATH: join(here, 'fake-claude.mjs'), POCKETBRIDGE_CLAUDE_PROJECTS_DIR: claudeProjectsDir }, stdio: ['ignore', 'pipe', 'ignore'] });
  let startup = ''; processService.stdout.on('data', chunk => startup += chunk);
  let recovery;
  t.after(async () => { if (recovery) await recovery.close(); try { processService.kill('SIGKILL'); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const url = await wait(() => startup.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]);
  const token = (await (await fetch(url + '/api/local-session')).json()).token;
  const post = async (route, data) => (await (await fetch(url + route, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).json());
  const project = await post('/api/projects', { path: projectPath }), chat = await post('/api/chats', { projectId: project.id }), id = randomUUID();
  await post(`/api/chats/${chat.id}/prompts`, { id, text: 'hang' }); await wait(() => existsSync(join(projectPath, 'child.pid')));
  const db = new DatabaseSync(join(dataDir, 'data.sqlite')), runtime = db.prepare('SELECT * FROM runtimes WHERE chatId=?').get(chat.id); db.close();
  const childPid = Number(readFileSync(join(projectPath, 'child.pid'), 'utf8'));
  const exited = new Promise(resolveExited => processService.once('exit', resolveExited)); processService.kill('SIGKILL'); await exited;
  assert.doesNotThrow(() => process.kill(runtime.pid, 0));
  recovery = await createService({ port: 0, dataDir, claudePath: join(here, 'fake-claude.mjs'), stopTimeoutMs: 50, claudeProjectsDir });
  assert.equal(recovery.state().chats.find(c => c.id === chat.id).status, 'interrupted');
  await wait(() => { try { process.kill(runtime.pid, 0); return false; } catch { return true; } });
  await wait(() => { try { process.kill(childPid, 0); return false; } catch { return true; } });
  const retry = await fetch(recovery.url + `/api/chats/${chat.id}/prompts`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id, text: 'hang' }) });
  assert.equal((await retry.json()).duplicate, true);
  assert.equal(readFileSync(join(projectPath, 'calls.ndjson'), 'utf8').trim().split('\n').length, 1);
});

test('shutdown rejects a prompt whose body finishes after shutdown begins', async t => {
  const f = await fixture(t), chat = await f.createChat();
  let request;
  const response = new Promise((resolveResponse, reject) => {
    request = http.request(f.service.url + `/api/chats/${chat.id}/prompts`, { method: 'POST', headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolveResponse(res.statusCode)); });
    request.on('error', reject);
  });
  request.write('{"id":"slow-delivery",');
  await new Promise(resolveWait => setTimeout(resolveWait, 20));
  const closing = f.service.close();
  request.end('"text":"hello"}');
  assert.equal(await response, 503);
  await closing;
  assert.equal(existsSync(join(f.projectPath, 'calls.ndjson')), false);
});

test('discovered folders come from session cwd metadata, keep manual names, and survive bad metadata', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pocketbridge-discover-'));
  const projectsDir = join(dir, 'claude'), dataDir = join(dir, 'data'), marker = 'SESSION-PROMPT-MARKER-DO-NOT-STORE';
  const kept = join(dir, 'kept'), broken = join(dir, 'Broken Meta'), nested = join(dir, 'Broken Meta', 'nested'), agent = join(dir, 'agent-only');
  const indexed = join(dir, 'from-index'), ignored = join(dir, 'ignored-cwd'), late = join(dir, 'late'), gone = join(dir, 'gone');
  const worktree = join(broken, '.claude', 'worktrees', 'agent-x'), sideWorktree = join(broken, '.claude', 'worktrees', 'side-agent');
  const scratchNamed = join(dir, 'scratchpad'), scratchpad = join(dir, 'Library', 'Application Support', 'Claude', 'scratch-workspaces', 'session');
  const stale = join(dir, 'stale-index'), newer = join(dir, 'newer-jsonl'), busy = join(dir, 'busy'), quiet = join(dir, 'quiet'), agentMeta = join(dir, 'agent-meta');
  for (const path of [kept, broken, nested, agent, indexed, ignored, late, gone, worktree, sideWorktree, scratchNamed, scratchpad, stale, newer, busy, quiet, agentMeta]) mkdirSync(path, { recursive: true });
  rmSync(gone, { recursive: true });
  const session = (folder, cwd, { extra, sidechain = false, mtime } = {}) => {
    const folderDir = join(projectsDir, folder); mkdirSync(folderDir, { recursive: true });
    const file = join(folderDir, `${randomUUID()}.jsonl`);
    const lines = ['not-json', JSON.stringify({ type: 'user', cwd, isSidechain: sidechain, timestamp: '2020-01-01T00:00:00.000Z' })];
    if (extra) lines.push(JSON.stringify({ type: 'user', cwd: extra, timestamp: '2024-01-01T00:00:00.000Z' }));
    writeFileSync(file, `${lines.join('\n')}\n`); if (mtime) utimesSync(file, mtime, mtime); return file;
  };
  session('zzz-not-the-cwd', broken, { extra: nested });
  session('side-only', agent, { sidechain: true });
  session('worktree-folder', worktree);
  session('side-worktree', sideWorktree, { sidechain: true });
  session('scratch-name', scratchNamed);
  session('scratchpad-folder', scratchpad);
  session('gone-folder', gone);
  writeFileSync(join(projectsDir, 'zzz-not-the-cwd', 'sessions-index.json'), '{');
  mkdirSync(join(projectsDir, 'zzz-not-the-cwd', 'subagents'), { recursive: true });
  writeFileSync(join(projectsDir, 'zzz-not-the-cwd', 'subagents', 'agent-1.jsonl'), `${JSON.stringify({ type: 'user', isSidechain: true, cwd: agent })}\n`);
  const indexDir = join(projectsDir, 'indexed-folder'); mkdirSync(indexDir, { recursive: true });
  writeFileSync(join(indexDir, 'sessions-index.json'), JSON.stringify({ version: 1, entries: [
    { sessionId: randomUUID(), projectPath: indexed, modified: 1893456000000, firstPrompt: marker },
    { cwd: agent, isSidechain: true, modified: 1893456000000, firstPrompt: marker },
    { cwd: agent, agentId: 'agent-1', projectPath: agent, firstPrompt: marker },
  ] }));
  writeFileSync(join(indexDir, `${randomUUID()}.jsonl`), `${JSON.stringify({ type: 'user', cwd: ignored })}\n`);
  const staleWhen = Date.parse('2020-01-01T00:00:00.000Z'), newerWhen = new Date('2026-06-01T00:00:00.000Z');
  const staleDir = join(projectsDir, 'stale-indexed'); mkdirSync(staleDir);
  writeFileSync(join(staleDir, 'sessions-index.json'), JSON.stringify({ entries: [{ projectPath: stale, modified: staleWhen }] }));
  const newerFile = join(staleDir, `${randomUUID()}.jsonl`);
  writeFileSync(newerFile, `${JSON.stringify({ type: 'user', cwd: newer, isSidechain: false })}\n`);
  utimesSync(newerFile, newerWhen, newerWhen);
  const busyDir = join(projectsDir, 'busy-slug'); mkdirSync(busyDir);
  let newestBusy;
  for (let i = 0; i < 401; i++) {
    newestBusy = join(busyDir, `${String(i).padStart(4, '0')}.jsonl`);
    writeFileSync(newestBusy, `${JSON.stringify({ type: 'user', cwd: busy })}\n`);
  }
  const quietDir = join(projectsDir, 'quiet-slug'); mkdirSync(quietDir);
  const quietFile = join(quietDir, `${randomUUID()}.jsonl`);
  writeFileSync(quietFile, `${JSON.stringify({ type: 'user', cwd: quiet })}\n`);
  utimesSync(quietFile, new Date(staleWhen), new Date(staleWhen));
  const agentDir = join(projectsDir, 'agent-meta-sessions'); mkdirSync(agentDir);
  writeFileSync(join(agentDir, `${randomUUID()}.jsonl`), `${JSON.stringify({ type: 'user', cwd: agentMeta, agentId: 'agent-1' })}\n`);
  const base = { claudePath: join(here, 'fake-claude.mjs'), claudeProjectsDir: projectsDir, stopTimeoutMs: 50 };
  let service = await createService({ ...base, port: 0, dataDir, discoverIntervalMs: 60_000 });
  t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });
  const absent = await createService({ ...base, port: 0, dataDir: join(dir, 'absent'), claudeProjectsDir: join(dir, 'missing-claude'), claudeAvailable: false });
  t.after(() => absent.close());
  const token = (await (await fetch(service.url + '/api/local-session')).json()).token;
  const request = async (route, data) => fetch(service.url + route, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }).then(async response => ({ status: response.status, data: await response.json() }));
  const paths = snapshot => new Set(snapshot.projects.map(project => project.path));
  let state = (await request('/api/state')).data;
  assert.equal(state.chats.length, 0);
  assert.deepEqual(paths(state), new Set([realpathSync(broken), realpathSync(indexed), realpathSync(ignored), realpathSync(worktree), realpathSync(scratchNamed), realpathSync(stale), realpathSync(newer), realpathSync(busy), realpathSync(quiet)]));
  assert.equal(paths(state).has(realpathSync(scratchpad)), false);
  assert.equal(paths(state).has(realpathSync(sideWorktree)), false);
  assert.equal(paths(state).has(realpathSync(agentMeta)), false);
  assert.equal(state.projects.find(project => project.path === realpathSync(broken)).name, 'Broken Meta');
  assert.equal(state.projects.find(project => project.path === realpathSync(indexed)).lastUsedAt, 1893456000000);
  assert.equal(state.projects.find(project => project.path === realpathSync(stale)).lastUsedAt, staleWhen);
  assert.equal(state.projects.find(project => project.path === realpathSync(newer)).lastUsedAt, Math.floor(statSync(newerFile).mtimeMs));
  assert.equal(state.projects.find(project => project.path === realpathSync(quiet)).lastUsedAt, staleWhen);
  assert.equal(state.projects.find(project => project.path === realpathSync(busy)).lastUsedAt, Math.floor(statSync(newestBusy).mtimeMs));
  assert.equal(readFileSync(join(dataDir, 'data.sqlite')).includes(marker), false);
  const registered = await request('/api/projects', { path: kept, name: 'Kept' });
  assert.equal(registered.status, 201);
  const keptSession = session('kept-folder', kept, { mtime: new Date('2026-12-01T00:00:00.000Z') });
  session('late-folder', late);
  state = (await request('/api/state')).data;
  assert.equal(paths(state).has(realpathSync(late)), false);
  assert.equal(state.projects.find(project => project.id === registered.data.id).name, 'Kept');
  assert.ok(state.projects.find(project => project.id === registered.data.id).lastUsedAt < Date.parse('2026-11-01T00:00:00.000Z'));
  await service.close();
  service = await createService({ ...base, port: 0, dataDir, discoverIntervalMs: 0 });
  state = service.state();
  const keptProject = state.projects.find(project => project.id === registered.data.id);
  assert.equal(keptProject.name, 'Kept');
  assert.equal(keptProject.lastUsedAt, Math.floor(statSync(keptSession).mtimeMs));
  assert.equal(state.projects.some(project => project.path === realpathSync(late)), true);
  assert.equal(state.chats.length, 0);
  const absentToken = (await (await fetch(absent.url + '/api/local-session')).json()).token;
  assert.equal((await fetch(absent.url + '/api/state', { headers: { Authorization: `Bearer ${absentToken}` } })).status, 200);
});

test('first prompt creates a chat atomically and retries keep the recorded model and effort', async t => {
  const f = await fixture(t), project = (await f.request('/api/state')).data.projects[0];
  assert.deepEqual((await f.request('/api/state')).data.capabilities.models, ['default', 'opus', 'sonnet', 'haiku']);
  assert.deepEqual((await f.request('/api/state')).data.capabilities.efforts, ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
  const legacy = await f.createChat();
  await f.send(legacy, 'hello'); await f.finished(legacy);
  const calls = () => readFileSync(join(f.projectPath, 'calls.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const legacyArgs = calls().find(call => call.args.includes(legacy.id)).args;
  assert.equal(legacyArgs.includes('--model'), false);
  assert.equal(legacyArgs.includes('--effort'), false);
  assert.equal(legacyArgs.includes('--bare'), false);
  assert.equal((await f.request(`/api/chats/${legacy.id}/prompts`, { id: randomUUID(), text: 'legacy-manual', mode: 'default' })).status, 202);
  await f.finished(legacy);
  const manualArgs = calls().find(call => call.prompt === 'legacy-manual').args;
  assert.equal(manualArgs[manualArgs.indexOf('--permission-mode') + 1], 'manual');
  const chatId = randomUUID(), promptId = randomUUID();
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, { id: promptId, text: 'hello', model: 'gpt', projectId: project.id })).status, 400);
  assert.equal((await f.request('/api/state')).data.chats.some(chat => chat.id === chatId), false);
  const created = await f.request(`/api/chats/${chatId}/prompts`, { id: promptId, text: 'hello', mode: 'plan', model: 'opus', effort: 'max', projectId: project.id });
  assert.equal(created.status, 202);
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, { id: promptId, text: 'hello', mode: 'plan', model: 'sonnet', effort: 'low', projectId: project.id })).status, 409);
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, { id: promptId, text: 'hello', mode: 'plan', model: 'opus', effort: 'max', projectId: project.id })).data.duplicate, true);
  const chat = await f.finished({ id: chatId });
  assert.equal(chat.status, 'idle');
  assert.equal(chat.model, 'opus'); assert.equal(chat.effort, 'max'); assert.equal(chat.mode, 'plan'); assert.equal(chat.projectId, project.id);
  const createdArgs = calls().find(call => call.args.includes(chatId)).args;
  assert.equal(createdArgs[createdArgs.indexOf('--model') + 1], 'opus');
  assert.equal(createdArgs[createdArgs.indexOf('--effort') + 1], 'max');
  assert.equal(calls().filter(call => call.args.includes(chatId)).length, 1);
  const otherDir = join(f.dir, 'other'); mkdirSync(otherDir);
  const other = (await f.request('/api/projects', { path: otherDir, name: 'Other' })).data;
  assert.equal((await f.request(`/api/chats/${legacy.id}/prompts`, { id: randomUUID(), text: 'switch', projectId: other.id })).status, 409);
  assert.equal((await f.request('/api/state')).data.chats.find(item => item.id === legacy.id).projectId, project.id);
  assert.equal(calls().filter(call => call.args.includes(legacy.id)).length, 2);
  rmSync(otherDir, { recursive: true });
  const missingId = randomUUID(), missingPrompt = randomUUID();
  assert.equal((await f.request(`/api/chats/${missingId}/prompts`, { id: missingPrompt, text: 'hello', projectId: other.id })).status, 409);
  assert.equal((await f.request('/api/state')).data.chats.some(item => item.id === missingId), false);
  mkdirSync(otherDir);
  assert.equal((await f.request(`/api/chats/${missingId}/prompts`, { id: missingPrompt, text: 'hello', projectId: other.id })).status, 202);
  await f.finished({ id: missingId });
  const offline = await createService({ port: 0, dataDir: join(f.dir, 'offline'), claudeAvailable: false, claudeProjectsDir: f.claudeProjectsDir, claudePath: join(here, 'fake-claude.mjs') });
  t.after(() => offline.close());
  const offlineToken = (await (await fetch(offline.url + '/api/local-session')).json()).token;
  const offlineProject = await (await fetch(offline.url + '/api/projects', { method: 'POST', headers: { Authorization: `Bearer ${offlineToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: f.projectPath }) })).json();
  const offlineChat = randomUUID();
  const rejected = await fetch(offline.url + `/api/chats/${offlineChat}/prompts`, { method: 'POST', headers: { Authorization: `Bearer ${offlineToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), text: 'hello', projectId: offlineProject.id }) });
  assert.equal(rejected.status, 503);
  assert.equal(offline.state().chats.some(item => item.id === offlineChat), false);
});

test('delete blocks active work and a later prompt cannot recreate it; rename stays available', async t => {
  const f = await fixture(t), chat = await f.createChat(), project = (await f.request('/api/state')).data.projects.find(item => item.id === chat.projectId);
  assert.equal((await f.request(`/api/chats/${chat.id}/rename`, { title: '   ' })).status, 400);
  assert.equal((await f.request(`/api/chats/${chat.id}/rename`, { title: 'x'.repeat(161) })).status, 400);
  const db = new DatabaseSync(join(f.dir, 'data/data.sqlite'));
  db.prepare('UPDATE chats SET updatedAt=1 WHERE id=?').run(chat.id); db.close();
  const renamed = await f.request(`/api/chats/${chat.id}/rename`, { title: 'Renamed chat' });
  assert.equal(renamed.status, 200); assert.equal(renamed.data.title, 'Renamed chat'); assert.ok(renamed.data.updatedAt > 1);
  const promptId = randomUUID();
  await f.send(chat, 'hang', promptId); await wait(() => existsSync(join(f.projectPath, 'child.pid')));
  assert.equal((await f.request(`/api/chats/${chat.id}/delete`, {})).status, 409);
  const running = await f.request(`/api/chats/${chat.id}/rename`, { title: 'Still running' });
  assert.equal(running.data.title, 'Still running'); assert.equal(running.data.status, 'running');
  assert.equal((await f.request(`/api/chats/${chat.id}/stop`, {})).status, 200);
  assert.equal((await f.finished(chat)).status, 'interrupted');
  const before = (await f.request('/api/state')).data.lastSeq;
  assert.equal((await f.request(`/api/chats/${chat.id}/delete`, {})).status, 200);
  assert.equal((await f.request(`/api/chats/${chat.id}/delete`, {})).status, 200);
  assert.equal((await f.request(`/api/chats/${randomUUID()}/delete`, {})).status, 404);
  assert.equal((await f.request(`/api/chats/${chat.id}/messages`)).status, 404);
  assert.equal((await f.request(`/api/chats/${chat.id}/prompts`, { id: promptId, text: 'hang', projectId: project.id })).status, 410);
  assert.equal((await f.request(`/api/chats/${chat.id}/prompts`, { id: randomUUID(), text: 'again', projectId: project.id })).status, 410);
  assert.equal((await f.request('/api/state')).data.chats.some(item => item.id === chat.id), false);
  assert.equal(readFileSync(join(f.projectPath, 'calls.ndjson'), 'utf8').trim().split('\n').length, 1);
  const ledger = new DatabaseSync(join(f.dir, 'data/data.sqlite'));
  assert.equal(ledger.prepare('SELECT text,model,effort FROM prompts WHERE id=?').get(promptId).text, 'hang');
  assert.ok(ledger.prepare('SELECT id FROM deleted_chats WHERE id=?').get(chat.id));
  assert.equal(ledger.prepare('SELECT COUNT(*) AS n FROM messages WHERE chatId=?').get(chat.id).n, 0);
  assert.ok(ledger.prepare('SELECT seq FROM events WHERE seq>? AND type=? AND chatId=?').get(before, 'state', chat.id));
  ledger.close();
});

test('shutdown finishes even when a request never finishes uploading', async t => {
  const f = await fixture(t), chat = await f.createChat();
  const request = http.request(f.service.url + `/api/chats/${chat.id}/prompts`, { method: 'POST', headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' } });
  const disconnected = new Promise(resolveDisconnect => request.once('error', resolveDisconnect));
  request.write('{"id":"unfinished-delivery",');
  await new Promise(resolveWait => setTimeout(resolveWait, 20));
  await Promise.all([f.service.close(), f.service.close()]);
  assert.equal((await disconnected).code, 'ECONNRESET');
  assert.equal(existsSync(join(f.projectPath, 'calls.ndjson')), false);
});
