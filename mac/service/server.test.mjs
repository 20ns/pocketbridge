import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, utimesSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
  const codexSessionsDir = join(dir, 'codex-sessions');
  const options = () => ({ port: 0, dataDir: join(dir, 'data'), claudePath: join(here, 'fake-claude.mjs'), codexPath: join(here, 'fake-codex.mjs'), codexSessionsDir, stopTimeoutMs: 50, claudeProjectsDir, discoverIntervalMs: 60_000, writtenGraceMs: 400 });
  let service = await createService(options()); await service.ready;
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
  return { dir, projectPath, claudeProjectsDir, codexSessionsDir, request, createChat, send, finished, get service() { return service; }, get token() { return token; }, async restart() { await service.close(); service = await createService(options()); await service.ready; } };
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

test('bulk concurrent retries execute each first and resumed turn once, including after deletion', async t => {
  const f = await fixture(t), project = (await f.request('/api/state')).data.projects[0];
  const chats = Array.from({ length: 10 }, () => ({ id: randomUUID() })), deliveries = [];
  for (let turn = 0; turn < 6; turn++) await Promise.all(chats.map(async chat => {
    const delivery = { id: randomUUID(), text: `${chat.id}:${turn}`, projectId: project.id, model: 'opus', effort: 'high' };
    const replies = await Promise.all(Array.from({ length: 3 }, () => f.request(`/api/chats/${chat.id}/prompts`, delivery)));
    assert.equal(replies.filter(reply => reply.status === 202 && !reply.data.duplicate).length, 1);
    assert.equal(replies.filter(reply => reply.status === 200 && reply.data.duplicate).length, 2);
    assert.equal((await f.request(`/api/chats/${chat.id}/prompts`, { ...delivery, model: 'sonnet' })).status, 409);
    assert.equal((await f.finished(chat)).status, 'idle');
    deliveries.push(delivery);
  }));
  const calls = () => readFileSync(join(f.projectPath, 'calls.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls().map(call => call.prompt).sort(), deliveries.map(delivery => delivery.text).sort());
  const db = new DatabaseSync(join(f.dir, 'data/data.sqlite'), { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages WHERE role='user'").get().n, 60);
  assert.deepEqual(db.prepare('SELECT id FROM prompts').all().map(row => row.id).sort(), deliveries.map(delivery => delivery.id).sort());
  db.close();
  for (const chat of chats) {
    assert.equal((await f.request(`/api/chats/${chat.id}/rename`, { title: 'Renamed' })).status, 200);
    assert.equal((await f.request(`/api/chats/${chat.id}/delete`, {})).status, 200);
    assert.equal((await f.request(`/api/chats/${chat.id}/prompts`, { ...deliveries[0], id: randomUUID(), projectId: project.id })).status, 410);
  }
  assert.equal(calls().length, 60);
  assert.equal((await f.request('/api/state')).data.chats.length, 0);
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

test('model catalogs come from each CLI picker without account details or a default placeholder', async t => {
  const f = await fixture(t), state = (await f.request('/api/state')).data;
  const [claude, codex] = state.capabilities.agents;
  assert.deepEqual(state.capabilities.models, ['default', 'opus', 'sonnet', 'haiku']);
  assert.equal(claude.id, 'claude'); assert.equal(claude.available, true);
  assert.deepEqual(claude.models.map(model => model.id), ['opus', 'sonnet', 'haiku']);
  assert.equal(claude.defaultModel, 'opus'); assert.equal(claude.models[0].name, 'Opus Test');
  assert.deepEqual(claude.models[2].efforts, []); assert.equal(claude.models[2].defaultEffort, 'default');
  assert.equal(codex.id, 'codex'); assert.deepEqual(codex.modes, ['bypassPermissions', 'auto', 'readOnly']);
  assert.deepEqual(codex.models.map(model => model.id), ['gpt-test-astra', 'gpt-test-luna']);
  assert.equal(codex.defaultModel, 'gpt-test-astra'); assert.equal(codex.defaultEffort, 'xhigh');
  assert.ok(!JSON.stringify(state).includes('private@example.com'));
  assert.ok(!JSON.stringify(state.capabilities.agents).includes('resolved'));
  const { project } = { project: state.projects[0] }, prompt = (body, chatId = randomUUID()) => f.request(`/api/chats/${chatId}/prompts`, { id: randomUUID(), text: 'hello', projectId: project.id, ...body });
  assert.equal((await prompt({ agent: 'claude', model: 'sonnet', effort: 'xhigh' })).status, 400);
  assert.equal((await prompt({ agent: 'claude', model: 'haiku', effort: 'high' })).status, 400);
  assert.equal((await prompt({ agent: 'codex', model: 'gpt-test-luna', effort: 'ultra' })).status, 400);
  assert.equal((await prompt({ agent: 'codex', model: 'gpt-hidden' })).status, 400);
  assert.equal((await prompt({ agent: 'codex', mode: 'plan' })).status, 400);
  assert.equal((await prompt({ agent: 'gemini' })).status, 400);
  const haiku = await prompt({ model: 'haiku', effort: 'default' }); assert.equal(haiku.status, 202);
  await f.restart();
  assert.equal((await f.request('/api/state')).data.capabilities.agents[0].models[0].name, 'Opus Test');
});

test('Codex chats run through the official app-server, resume their thread and pair out-of-order tool results', async t => {
  const f = await fixture(t), project = (await f.request('/api/state')).data.projects[0], chatId = randomUUID();
  const first = { id: randomUUID(), text: 'hello', agent: 'codex', model: 'gpt-test-luna', effort: 'high', mode: 'bypassPermissions', projectId: project.id };
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, first)).status, 202);
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, first)).data.duplicate, true);
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, { ...first, agent: 'claude' })).status, 409);
  assert.equal((await f.finished({ id: chatId })).status, 'idle');
  const chat = (await f.request('/api/state')).data.chats.find(item => item.id === chatId);
  assert.equal(chat.agent, 'codex'); assert.equal(chat.model, 'gpt-test-luna'); assert.equal(chat.preview, 'Codex says hello');
  assert.deepEqual(chat.context, { used: 42000, window: 400000 });
  const { messages, turns } = (await f.request(`/api/chats/${chatId}/messages`)).data;
  const echo = messages.find(m => m.text.startsWith('Shell') && m.text.includes("echo it's ok")), fail = messages.find(m => m.text === 'Shell\n{\n  "command": "false"\n}');
  assert.ok(echo && fail);
  assert.equal(messages.find(m => m.id === `${echo.id}:result`).text, "Tool result\nit's ok\n");
  assert.equal(messages.find(m => m.id === `${fail.id}:result`).text, 'Tool failed\nExit code 1');
  assert.ok(messages.findIndex(m => m.id === `${fail.id}:result`) < messages.findIndex(m => m.id === `${echo.id}:result`));
  assert.ok(messages.some(m => m.text.startsWith('Edit\n') && m.text.includes('a.txt') && m.text.includes('"add"')));
  assert.deepEqual(messages.filter(m => m.role === 'assistant').map(m => m.text), ['Codex says hello']);
  assert.ok(!messages.some(m => m.text.includes('thinking')));
  assert.equal(turns.length, 1); assert.equal(turns[0].id, first.id); assert.ok(turns[0].endedAt >= turns[0].startedAt);
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, { id: randomUUID(), text: 'again', mode: 'auto', projectId: project.id })).status, 202);
  await f.finished({ id: chatId });
  const calls = readFileSync(join(f.projectPath, 'codex-calls.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  const [opened, turn, resumed, again] = calls;
  assert.equal(opened.method, 'thread/start');
  assert.deepEqual({ ...opened.params, cwd: undefined }, { cwd: undefined, approvalPolicy: 'never', sandbox: 'danger-full-access', model: 'gpt-test-luna', config: { model_reasoning_effort: 'high' } });
  assert.equal(turn.method, 'turn/start'); assert.equal(turn.params.input[0].text, 'hello'); assert.equal(turn.params.effort, 'high'); assert.equal(turn.params.model, 'gpt-test-luna');
  assert.equal(resumed.method, 'thread/resume'); assert.equal(resumed.params.threadId, turn.params.threadId); assert.equal(resumed.params.sandbox, 'workspace-write');
  assert.equal(again.params.input[0].text, 'again');
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, { id: randomUUID(), text: 'fail' })).status, 202);
  const failed = await f.finished({ id: chatId });
  assert.equal(failed.status, 'error'); assert.equal(failed.error, 'Codex usage limit reached');
});

test('stopping a Codex turn interrupts its process group', async t => {
  const f = await fixture(t), project = (await f.request('/api/state')).data.projects[0], chatId = randomUUID();
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, { id: randomUUID(), text: 'hang', agent: 'codex', projectId: project.id })).status, 202);
  const pidFile = join(f.projectPath, 'codex-child.pid');
  await wait(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'));
  await wait(async () => (await f.request(`/api/chats/${chatId}/messages`)).data.messages.some(m => m.text.includes('sleep 100')));
  assert.equal((await f.request(`/api/chats/${chatId}/stop`, {})).status, 200);
  assert.equal((await f.finished({ id: chatId })).status, 'interrupted');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await wait(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
});

test('Claude tool results carry their tool message id and large JSON responses are gzipped', async t => {
  const f = await fixture(t), chat = await f.createChat();
  await f.send(chat, 'hello'); await f.finished(chat);
  const messages = (await f.request(`/api/chats/${chat.id}/messages`)).data.messages, read = messages.find(m => m.text.startsWith('Read\n'));
  assert.equal(messages.find(m => m.text.startsWith('Tool result')).id, `${read.id}:result`);
  assert.equal((await f.request('/api/state')).data.chats[0].preview, 'Hello');
  const db = new DatabaseSync(join(f.dir, 'data/data.sqlite'));
  db.prepare("INSERT INTO messages (id,chatId,role,text,createdAt) VALUES (?,?,?,?,?)").run(randomUUID(), chat.id, 'assistant', '## Done\n\nRaised it to **30 seconds** in `src/http.ts`. See [docs](https://x.dev).\n\n```sh\npnpm test\n```\n- one', Date.now()); db.close();
  assert.equal((await f.request('/api/state')).data.chats[0].preview, 'Done Raised it to 30 seconds in src/http.ts. See docs. one');
  const big = 'x'.repeat(5000);
  await f.send(chat, big); await f.finished(chat);
  const response = await fetch(f.service.url + `/api/chats/${chat.id}/messages`, { headers: { Authorization: `Bearer ${f.token}`, 'Accept-Encoding': 'gzip' } });
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.ok((await response.json()).messages.some(m => m.text === big));
  const plain = await new Promise((resolveRequest, reject) => http.get(f.service.url + `/api/chats/${chat.id}/messages`, { headers: { Authorization: `Bearer ${f.token}` } }, res => { res.resume(); resolveRequest(res.headers['content-encoding']); }).on('error', reject));
  assert.equal(plain, undefined);
});

test('Codex session metadata adds project folders without importing conversations', async t => {
  const f = await fixture(t), day = join(f.codexSessionsDir, '2026', '10', '03'); mkdirSync(day, { recursive: true });
  const folder = join(f.dir, 'codex-project'), scratch = join(f.dir, 'Documents', 'Codex', '2026-10-01', 'task'), named = join(f.dir, 'Documents', 'Codex', '2026-09-17-open-the-app'), sub = join(f.dir, 'subagent-only');
  for (const path of [folder, scratch, named, sub]) mkdirSync(path, { recursive: true });
  const meta = (cwd, extra = {}) => JSON.stringify({ type: 'session_meta', payload: { id: randomUUID(), cwd, base_instructions: { text: 'y'.repeat(70_000) }, ...extra } }) + '\n{"type":"response_item","payload":{"text":"secret chat"}}\n';
  writeFileSync(join(day, 'rollout-2026-10-03T10-00-00-a.jsonl'), meta(folder));
  writeFileSync(join(day, 'rollout-2026-10-03T10-00-01-b.jsonl'), meta(scratch));
  writeFileSync(join(day, 'rollout-2026-10-03T10-00-02-c.jsonl'), meta(sub, { thread_source: 'subagent' }));
  writeFileSync(join(day, 'rollout-2026-10-03T10-00-03-d.jsonl'), '{broken');
  writeFileSync(join(day, 'rollout-2026-10-03T10-00-04-e.jsonl'), meta(named));
  await f.restart();
  const state = (await f.request('/api/state')).data, paths = state.projects.map(project => project.path);
  assert.ok(paths.includes(realpathSync(folder)));
  assert.ok(![scratch, named, sub].some(path => paths.includes(realpathSync(path))));
  assert.ok(!JSON.stringify(state).includes('secret chat'));
});

test('older clients keep legacy effort rules, and a prompt waiting on a catalog cannot start after shutdown', async t => {
  const f = await fixture(t), project = (await f.request('/api/state')).data.projects[0];
  // Sonnet Test lists no xhigh, but a 0.4 client was told xhigh is valid for every model.
  assert.equal((await f.request(`/api/chats/${randomUUID()}/prompts`, { id: randomUUID(), text: 'hello', model: 'sonnet', effort: 'xhigh', projectId: project.id })).status, 202);
  assert.equal((await f.request(`/api/chats/${randomUUID()}/prompts`, { id: randomUUID(), text: 'hello', agent: 'claude', model: 'sonnet', effort: 'xhigh', projectId: project.id })).status, 400);
  // A Codex CLI whose catalog probe never answers: validation stops waiting quickly and shutdown wins.
  const dir = join(f.dir, 'slow'); mkdirSync(join(dir, 'project'), { recursive: true });
  const slow = join(dir, 'slow-codex.mjs');
  writeFileSync(slow, `#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log('slow'); process.exit(0); }\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const service = await createService({ port: 0, dataDir: join(dir, 'data'), claudePath: join(here, 'fake-claude.mjs'), codexPath: slow, claudeProjectsDir: f.claudeProjectsDir, catalogWaitMs: 300, stopTimeoutMs: 50 });
  const token = (await (await fetch(service.url + '/api/local-session')).json()).token;
  const post = (route, data) => fetch(service.url + route, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const registered = await (await post('/api/projects', { path: join(dir, 'project') })).json();
  const started = Date.now();
  const reply = await post(`/api/chats/${randomUUID()}/prompts`, { id: randomUUID(), text: 'hello', agent: 'codex', model: 'gpt-anything', effort: 'high', projectId: registered.id });
  assert.equal(reply.status, 202); assert.ok(Date.now() - started < 5000);
  const pending = post(`/api/chats/${randomUUID()}/prompts`, { id: randomUUID(), text: 'late', agent: 'codex', model: 'gpt-late', projectId: registered.id }).then(r => r.status, () => 'closed');
  await service.close();
  assert.notEqual(await pending, 202);
});

test('usage reports each CLI plan limits without account details, and Claude chats record context use', async t => {
  const f = await fixture(t), chat = await f.createChat();
  const usage = (await f.request('/api/usage')).data;
  const [claude, codex] = usage.agents;
  assert.equal(claude.plan, 'Max');
  assert.deepEqual(claude.limits.map(limit => [limit.label, limit.percent]), [['5-hour session', 14], ['Weekly', 25], ['Weekly · Fable', 0]]);
  assert.equal(claude.limits[0].resetsAt, Date.parse('2026-10-03T20:29:59.530335+00:00'));
  assert.equal(codex.plan, 'Pro Lite'); assert.equal(codex.credits, 2353.7232);
  assert.deepEqual(codex.limits.map(limit => [limit.label, limit.percent, limit.severity]), [['Weekly', 39, 'normal'], ['5-hour', 92, 'critical']]);
  assert.equal(codex.limits[0].resetsAt, 1791580292000);
  assert.ok(!JSON.stringify(usage).includes('private@example.com'));
  await f.send(chat, 'hello'); await f.finished(chat);
  assert.deepEqual((await f.request('/api/state')).data.chats.find(item => item.id === chat.id).context, { used: 10500, window: 1000000 });
});

test('an agent can be turned off: no probes, no discovery, no new turns, and the switch survives restart', async t => {
  const f = await fixture(t), project = (await f.request('/api/state')).data.projects[0];
  const day = join(f.codexSessionsDir, '2026', '10', '03'), folder = join(f.dir, 'codex-only'); mkdirSync(day, { recursive: true }); mkdirSync(folder);
  writeFileSync(join(day, 'rollout-2026-10-03T10-00-00-a.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd: folder } }) + '\n');
  const codexChat = randomUUID();
  assert.equal((await f.request(`/api/chats/${codexChat}/prompts`, { id: randomUUID(), text: 'hello', agent: 'codex', projectId: project.id })).status, 202);
  await f.finished({ id: codexChat });
  assert.equal((await f.request('/api/agents/gemini', { enabled: false })).status, 400);
  assert.equal((await f.request('/api/agents/codex', { enabled: 'no' })).status, 400);
  const off = await f.request('/api/agents/codex', { enabled: false });
  assert.equal(off.status, 200); assert.equal(off.data.enabled, false);
  const blocked = await f.request(`/api/chats/${codexChat}/prompts`, { id: randomUUID(), text: 'again' });
  assert.equal(blocked.status, 409); assert.match(blocked.data.error, /Codex is turned off/);
  assert.equal((await f.request(`/api/chats/${randomUUID()}/prompts`, { id: randomUUID(), text: 'new', agent: 'codex', projectId: project.id })).status, 409);
  assert.equal((await f.request('/api/chats', { projectId: project.id, agent: 'codex' })).status, 409);
  assert.equal((await f.request('/api/chats', { projectId: project.id })).status, 201);
  assert.deepEqual((await f.request('/api/usage')).data.agents.find(agent => agent.id === 'codex').limits, []);
  await f.restart();
  const state = (await f.request('/api/state')).data;
  assert.equal(state.capabilities.agents.find(agent => agent.id === 'codex').enabled, false);
  assert.equal(state.capabilities.agents.find(agent => agent.id === 'claude').enabled, true);
  assert.ok(!state.projects.some(item => item.path === realpathSync(folder)));
  assert.equal(readFileSync(join(f.projectPath, 'codex-calls.ndjson'), 'utf8').trim().split('\n').filter(line => line.includes('turn/start')).length, 1);
  assert.equal((await f.request('/api/agents/codex', { enabled: true })).data.enabled, true);
  assert.equal((await f.request(`/api/chats/${codexChat}/prompts`, { id: randomUUID(), text: 'back on' })).status, 202);
  await f.finished({ id: codexChat });
  await wait(async () => (await f.request('/api/state')).data.projects.some(item => item.path === realpathSync(folder)));
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const upload = async (f, data = png, type = 'image/png') => { const response = await fetch(f.service.url + '/api/uploads', { method: 'POST', headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': type }, body: data }); return { status: response.status, data: await response.json() }; };
const turnWith = (f, chatId, text, extra = {}) => f.request(`/api/chats/${chatId}/prompts`, { id: randomUUID(), text, ...extra });
const messagesOf = async (f, chatId) => (await f.request(`/api/chats/${chatId}/messages`)).data;

test('a prompt sent while Claude works steers the turn or interrupts it, in the same run', async t => {
  const f = await fixture(t), project = (await f.request('/api/state')).data.projects[0], chatId = randomUUID();
  assert.equal((await turnWith(f, chatId, 'steer-wait', { projectId: project.id })).status, 202);
  await wait(async () => (await messagesOf(f, chatId)).messages.some(m => m.text.includes('sleep 1')));
  assert.equal((await turnWith(f, chatId, 'without delivery')).status, 409);
  const steer = await turnWith(f, chatId, 'also check the tests', { delivery: 'steer' });
  assert.equal(steer.status, 202); assert.equal(steer.data.delivery, 'steer');
  await f.finished({ id: chatId });
  let data = await messagesOf(f, chatId);
  assert.equal(data.messages.find(m => m.text === 'also check the tests').kind, 'steer');
  assert.ok(data.messages.some(m => m.role === 'assistant' && m.text === 'Steered: also check the tests'));
  assert.equal(data.turns.length, 1);
  assert.equal((await turnWith(f, chatId, 'slow')).status, 202);
  await wait(async () => (await messagesOf(f, chatId)).messages.some(m => m.text.includes('sleep 100')));
  const interrupt = await turnWith(f, chatId, 'hello', { delivery: 'interrupt' });
  assert.equal(interrupt.data.delivery, 'interrupt');
  assert.equal((await f.finished({ id: chatId })).status, 'idle');
  data = await messagesOf(f, chatId);
  assert.equal(data.messages.find(m => m.text === 'hello').kind, 'interrupt');
  assert.ok(data.messages.some(m => m.role === 'assistant' && m.text === 'Hello'));
  assert.equal(data.turns.length, 3);
  assert.ok(data.turns[1].endedAt <= data.turns[2].startedAt && data.turns[2].endedAt >= data.turns[2].startedAt);
  assert.equal(readFileSync(join(f.projectPath, 'calls.ndjson'), 'utf8').trim().split('\n').length, 2);
  // A steer for a turn that already ended simply runs as the next turn.
  assert.equal((await turnWith(f, chatId, 'hello', { delivery: 'steer' })).data.delivery, 'turn');
  await f.finished({ id: chatId });
});

test('Codex prompts steer or interrupt the running app-server turn', async t => {
  const f = await fixture(t), project = (await f.request('/api/state')).data.projects[0], chatId = randomUUID();
  assert.equal((await turnWith(f, chatId, 'steer-wait', { agent: 'codex', projectId: project.id })).status, 202);
  await wait(async () => (await messagesOf(f, chatId)).messages.some(m => m.text.includes('sleep 1')));
  assert.equal((await turnWith(f, chatId, 'use the staging config', { delivery: 'steer' })).status, 202);
  await f.finished({ id: chatId });
  assert.ok((await messagesOf(f, chatId)).messages.some(m => m.role === 'assistant' && m.text === 'Steered: use the staging config'));
  assert.equal((await turnWith(f, chatId, 'hang')).status, 202);
  await wait(async () => (await messagesOf(f, chatId)).messages.some(m => m.text.includes('sleep 100')));
  assert.equal((await turnWith(f, chatId, 'world', { delivery: 'interrupt' })).status, 202);
  assert.equal((await f.finished({ id: chatId })).status, 'idle');
  const data = await messagesOf(f, chatId);
  assert.ok(data.messages.some(m => m.role === 'assistant' && m.text === 'Codex says world'));
  assert.equal(data.turns.length, 3);
});

test('image attachments upload once, reach both agents, stay with their chat and go when it is deleted', async t => {
  const f = await fixture(t), project = (await f.request('/api/state')).data.projects[0];
  assert.equal((await upload(f, Buffer.from('not an image'), 'image/png')).status, 415);
  const image = (await upload(f)).data;
  assert.equal(image.type, 'image/png'); assert.equal(image.size, png.length);
  const fetched = await fetch(f.service.url + `/api/uploads/${image.id}`, { headers: { Authorization: `Bearer ${f.token}` } });
  assert.equal(fetched.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), png);
  assert.equal((await fetch(f.service.url + `/api/uploads/${image.id}`)).status, 401);
  const claudeChat = randomUUID(), delivery = { id: randomUUID(), text: 'image please', attachments: [image.id], projectId: project.id };
  assert.equal((await f.request(`/api/chats/${claudeChat}/prompts`, delivery)).status, 202);
  assert.equal((await f.request(`/api/chats/${claudeChat}/prompts`, { ...delivery, attachments: [] })).status, 409);
  await f.finished({ id: claudeChat });
  const claudeData = await messagesOf(f, claudeChat);
  assert.deepEqual(claudeData.messages.find(m => m.role === 'user').attachments, [{ id: image.id, type: 'image/png' }]);
  assert.equal(claudeData.messages.find(m => m.role === 'assistant').text, `images: 1 image/png:${png.toString('base64').length}`);
  assert.equal((await turnWith(f, randomUUID(), 'image again', { attachments: [image.id], projectId: project.id })).status, 400);
  const alone = (await upload(f)).data, aloneChat = randomUUID();
  assert.equal((await turnWith(f, aloneChat, '  ', { attachments: [alone.id], projectId: project.id })).status, 202);
  await f.finished({ id: aloneChat });
  assert.equal((await messagesOf(f, aloneChat)).messages[0].text, 'Look at the attached image.');
  assert.equal((await f.request('/api/state')).data.chats.find(c => c.id === aloneChat).title, 'Screenshot');
  assert.equal((await turnWith(f, randomUUID(), '  ', { projectId: project.id })).status, 400);
  const second = (await upload(f)).data, codexChat = randomUUID();
  assert.equal((await turnWith(f, codexChat, 'image for codex', { agent: 'codex', attachments: [second.id], projectId: project.id })).status, 202);
  await f.finished({ id: codexChat });
  assert.equal((await messagesOf(f, codexChat)).messages.find(m => m.role === 'assistant').text, 'images: 1');
  assert.ok(readFileSync(join(f.projectPath, 'codex-calls.ndjson'), 'utf8').includes(`${second.id}.png`));
  assert.equal((await f.request(`/api/chats/${claudeChat}/delete`, {})).status, 200);
  assert.equal(existsSync(join(f.dir, 'data', 'uploads', `${image.id}.png`)), false);
  assert.equal((await fetch(f.service.url + `/api/uploads/${image.id}`, { headers: { Authorization: `Bearer ${f.token}` } })).status, 404);
});

test('sub-agents report title, model, effort, timing and activity, and stay out of the transcript', async t => {
  const f = await fixture(t), project = (await f.request('/api/state')).data.projects[0], claudeChat = randomUUID(), codexChat = randomUUID();
  assert.equal((await turnWith(f, claudeChat, 'subagent', { projectId: project.id, effort: 'high', model: 'opus' })).status, 202);
  assert.equal((await f.finished({ id: claudeChat })).status, 'idle');
  let data = await messagesOf(f, claudeChat);
  const [claudeAgent] = data.subagents;
  assert.equal(claudeAgent.title, 'Count files here'); assert.equal(claudeAgent.kind, 'general-purpose');
  assert.equal(claudeAgent.model, 'Sonnet Test'); assert.equal(claudeAgent.effort, 'high'); assert.equal(claudeAgent.status, 'completed');
  assert.equal(claudeAgent.activity, 'Found 2 files'); assert.ok(claudeAgent.endedAt >= claudeAgent.startedAt); assert.equal(claudeAgent.toolUses, 1);
  assert.deepEqual(data.messages.filter(m => m.role === 'assistant').map(m => m.text), ['The agent is running.', 'There are 2 files.']);
  assert.ok(!data.messages.some(m => m.text.includes('ls | wc -l')));
  assert.equal(data.turns.length, 1); assert.equal(data.activity, null);
  assert.ok(data.turns[0].endedAt >= claudeAgent.endedAt);
  assert.equal((await turnWith(f, codexChat, 'subagent', { agent: 'codex', projectId: project.id })).status, 202);
  await f.finished({ id: codexChat });
  data = await messagesOf(f, codexChat);
  assert.deepEqual(data.subagents.map(item => [item.id, item.title, item.model, item.effort, item.status, item.activity]), [['sub-1', 'Count files', 'GPT-Test-Luna', 'low', 'completed', 'Found 2 files']]);
});

test('git status counts lines changed against HEAD, new files included, and non-repos say so', async t => {
  const f = await fixture(t), project = (await f.request('/api/state')).data.projects[0];
  assert.deepEqual((await f.request(`/api/projects/${project.id}/git`)).data, { repo: false });
  const git = (...args) => spawnSync('git', ['-C', f.projectPath, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'work'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  writeFileSync(join(f.projectPath, 'a.txt'), 'one\ntwo\nthree\n'); git('add', 'a.txt'); git('commit', '-qm', 'start');
  writeFileSync(join(f.projectPath, 'a.txt'), 'one\n2\nthree\nfour\n'); writeFileSync(join(f.projectPath, 'new.txt'), 'x\ny\n');
  await new Promise(r => setTimeout(r, 4100));
  const status = (await f.request(`/api/projects/${project.id}/git`)).data;
  assert.equal(status.repo, true); assert.equal(status.branch, 'work'); assert.equal(status.added, 4); assert.equal(status.removed, 1);
  assert.ok(status.files >= 2); assert.match(status.commit, /^[0-9a-f]{7}$/);
  assert.equal((await f.request('/api/projects/nope/git')).status, 404);
  // A project inside a larger repository counts only its own folder.
  const inner = join(f.projectPath, 'inner'); mkdirSync(inner); writeFileSync(join(inner, 'b.txt'), 'b\n');
  const nested = (await f.request('/api/projects', { path: inner })).data;
  const scoped = (await f.request(`/api/projects/${nested.id}/git`)).data;
  assert.equal(scoped.added, 1); assert.equal(scoped.removed, 0); assert.equal(scoped.files, 1);
});

test('"/" commands list Claude custom commands and Codex skills, and a Codex skill prompt passes the skill', async t => {
  const f = await fixture(t), project = (await f.request('/api/state')).data.projects[0];
  const claude = (await f.request(`/api/projects/${project.id}/commands?agent=claude`)).data.commands;
  assert.deepEqual(claude, [{ name: 'deploy', description: 'Ship the current branch', hint: '[env]' }, { name: 'review-notes', description: 'Summarise review notes', hint: '' }]);
  const codex = (await f.request(`/api/projects/${project.id}/commands?agent=codex`)).data.commands;
  assert.deepEqual(codex, [{ name: 'ship-it', description: 'Ship the build', hint: '' }]);
  const chatId = randomUUID();
  assert.equal((await turnWith(f, chatId, '/ship-it to staging', { agent: 'codex', projectId: project.id })).status, 202);
  await f.finished({ id: chatId });
  assert.equal((await messagesOf(f, chatId)).messages.find(m => m.role === 'assistant').text, 'skill ship-it at /skills/ship-it/SKILL.md');
  assert.equal((await f.request(`/api/projects/${project.id}/commands?agent=gemini`)).status, 400);
});

test('continuing a Terminal session forks it into a new chat that brings the last exchange along', async t => {
  const f = await fixture(t), project = (await f.request('/api/state')).data.projects[0];
  const dir = join(f.claudeProjectsDir, project.path.replace(/[^a-zA-Z0-9]/g, '-')), source = randomUUID(); mkdirSync(dir, { recursive: true });
  const record = value => JSON.stringify(value) + '\n';
  writeFileSync(join(dir, `${source}.jsonl`), record({ type: 'user', cwd: project.path, isSidechain: false, message: { role: 'user', content: 'Add dark mode to the settings page' } })
    + record({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'Dark mode is in.' }] } })
    + record({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'text', text: 'Now make the toggle remember its value' }] } })
    + record({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'It now persists in preferences.' }] } }));
  const sessions = (await f.request(`/api/projects/${project.id}/sessions`)).data.sessions;
  assert.deepEqual(sessions.map(item => [item.agent, item.id, item.title, item.preview]), [['claude', source, 'Add dark mode to the settings page', 'It now persists in preferences.'], ['codex', 'codex-thread-1', 'Fix the login page', 'Make the login page load faster']]);
  const created = await f.request('/api/chats/continue', { projectId: project.id, agent: 'claude', sessionId: source });
  assert.equal(created.status, 201);
  assert.equal((await f.request('/api/chats/continue', { projectId: project.id, agent: 'claude', sessionId: source })).data.id, created.data.id);
  let data = await messagesOf(f, created.data.id);
  assert.deepEqual(data.messages.map(m => [m.role, m.text, m.kind]), [['user', 'Now make the toggle remember its value', 'imported'], ['assistant', 'It now persists in preferences.', 'imported']]);
  assert.equal((await turnWith(f, created.data.id, 'hello')).status, 202);
  await f.finished(created.data);
  const args = readFileSync(join(f.projectPath, 'calls.ndjson'), 'utf8').trim().split('\n').map(JSON.parse)[0].args;
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 5), ['--resume', source, '--fork-session', '--session-id', created.data.id]);
  assert.ok(!(await f.request(`/api/projects/${project.id}/sessions`)).data.sessions.some(item => item.id === source));
  const codexChat = (await f.request('/api/chats/continue', { projectId: project.id, agent: 'codex', sessionId: 'codex-thread-1' })).data;
  assert.equal((await turnWith(f, codexChat.id, 'hello')).status, 202);
  await f.finished(codexChat);
  const forked = readFileSync(join(f.projectPath, 'codex-calls.ndjson'), 'utf8').trim().split('\n').map(JSON.parse).find(call => call.method === 'thread/fork');
  assert.equal(forked.params.threadId, 'codex-thread-1');
  assert.equal((await f.request('/api/chats/continue', { projectId: project.id, agent: 'claude', sessionId: randomUUID() })).status, 404);
});

test('a status-only event stream skips streaming text events', async t => {
  const f = await fixture(t), chat = await f.createChat(), before = f.service.state().lastSeq;
  await f.send(chat, 'hello'); await f.finished(chat);
  const read = async scope => {
    const controller = new AbortController(), response = await fetch(f.service.url + `/api/events?after=${before}${scope}`, { headers: { Authorization: `Bearer ${f.token}` }, signal: controller.signal });
    const reader = response.body.getReader(); let text = '';
    const end = Date.now() + 1500;
    while (Date.now() < end) { const { value } = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ value: new Uint8Array() }), 300))]); text += new TextDecoder().decode(value); }
    controller.abort(); return [...text.matchAll(/"type":"(\w+)"/g)].map(match => match[1]);
  };
  const all = await read(''), status = await read('&scope=status');
  assert.ok(all.includes('message')); assert.ok(!status.includes('message')); assert.ok(status.includes('state'));
});

test('unexpected CLI output fails only that turn and the service keeps answering', async t => {
  const f = await fixture(t), chat = await f.createChat();
  await f.send(chat, 'odd-output');
  const ended = await f.finished(chat);
  assert.equal(ended.status, 'idle');
  assert.equal((await f.request('/api/health')).status, 200);
  assert.ok((await f.request(`/api/chats/${chat.id}/messages`)).data.messages.some(m => m.text === 'Tool result\nno id'));
});

test('review regressions: shells do not hold a run, unechoed steers close, answers reset on Send now, foreign Codex threads are ignored', async t => {
  const f = await fixture(t), project = (await f.request('/api/state')).data.projects[0];
  const shell = randomUUID();
  assert.equal((await turnWith(f, shell, 'bg-shell', { projectId: project.id })).status, 202);
  assert.equal((await f.finished({ id: shell })).status, 'idle');
  const swallow = randomUUID();
  assert.equal((await turnWith(f, swallow, 'steer-swallow', { projectId: project.id })).status, 202);
  await wait(async () => (await messagesOf(f, swallow)).messages.some(m => m.text.includes('sleep 1')));
  assert.equal((await turnWith(f, swallow, '/local-only', { delivery: 'steer' })).status, 202);
  assert.equal((await f.finished({ id: swallow })).status, 'idle');
  const asking = randomUUID();
  assert.equal((await turnWith(f, asking, 'question', { projectId: project.id })).status, 202);
  await wait(async () => (await f.request('/api/state')).data.chats.find(c => c.id === asking)?.status === 'waiting');
  assert.equal((await turnWith(f, asking, 'hello', { delivery: 'interrupt' })).status, 202);
  assert.equal((await f.request('/api/state')).data.chats.find(c => c.id === asking).status, 'running');
  assert.equal((await f.finished({ id: asking })).status, 'idle');
  const foreign = randomUUID();
  assert.equal((await turnWith(f, foreign, 'foreign', { agent: 'codex', projectId: project.id })).status, 202);
  assert.equal((await f.finished({ id: foreign })).status, 'idle');
  assert.ok((await messagesOf(f, foreign)).messages.some(m => m.role === 'assistant' && m.text === 'Codex says foreign'));
});

test('review regressions: one chat per continued session under concurrency, sessions filtered by folder, deleted Codex threads stay hidden', async t => {
  const f = await fixture(t), project = (await f.request('/api/state')).data.projects[0];
  const dir = join(f.claudeProjectsDir, project.path.replace(/[^a-zA-Z0-9]/g, '-')), mine = randomUUID(), other = randomUUID(); mkdirSync(dir, { recursive: true });
  const session = cwd => JSON.stringify({ type: 'user', cwd, isSidechain: false, message: { role: 'user', content: 'Do the thing' } }) + '\n';
  writeFileSync(join(dir, `${mine}.jsonl`), session(project.path));
  writeFileSync(join(dir, `${other}.jsonl`), session(project.path.replace(/project$/, 'pro_ject')));
  const listed = (await f.request(`/api/projects/${project.id}/sessions`)).data.sessions.map(item => item.id);
  assert.ok(listed.includes(mine)); assert.ok(!listed.includes(other));
  const [a, b] = await Promise.all([0, 1].map(() => f.request('/api/chats/continue', { projectId: project.id, agent: 'claude', sessionId: mine })));
  assert.equal(a.data.id, b.data.id);
  const codexChat = (await f.request('/api/chats/continue', { projectId: project.id, agent: 'codex', sessionId: 'codex-thread-1' })).data;
  assert.equal((await turnWith(f, codexChat.id, 'hello')).status, 202); await f.finished(codexChat);
  const thread = new DatabaseSync(join(f.dir, 'data/data.sqlite'), { readOnly: true }).prepare('SELECT agentSession FROM chats WHERE id=?').get(codexChat.id).agentSession;
  assert.equal((await f.request(`/api/chats/${codexChat.id}/delete`, {})).status, 200);
  const db = new DatabaseSync(join(f.dir, 'data/data.sqlite'), { readOnly: true });
  assert.ok(db.prepare('SELECT id FROM hidden_sessions WHERE id=?').get(thread)); db.close();
  const big = Buffer.alloc(5 * 1024 * 1024 + 10, 0); png.copy(big);
  assert.equal((await upload(f, big)).status, 413);
});
