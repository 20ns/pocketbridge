import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, utimesSync, statSync, realpathSync, symlinkSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createService } from './server.mjs';
import { newestCli, compareVersions } from './agents.mjs';
import { findIcons, measure, renderIcon } from './icons.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const wait = async predicate => {
  const end = Date.now() + 4000;
  while (Date.now() < end) { const result = await predicate(); if (result) return result; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Condition did not complete');
};
async function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pocketbridge-'));
  const projectPath = join(dir, 'project'); mkdirSync(projectPath);
  const claudeProjectsDir = join(dir, 'claude-projects'); mkdirSync(claudeProjectsDir);
  const codexSessionsDir = join(dir, 'codex-sessions');
  const opened = [];
  const options = () => ({ openUrl: async url => { opened.push(url); return true; }, port: 0, dataDir: join(dir, 'data'), claudePath: join(here, 'fake-claude.mjs'), codexPath: join(here, 'fake-codex.mjs'), codexSessionsDir, experimentsDir: join(dir, 'experiments'), stopTimeoutMs: 50, claudeProjectsDir, discoverIntervalMs: 60_000, writtenGraceMs: 400, ...extra });
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
  return { opened, dir, projectPath, claudeProjectsDir, codexSessionsDir, request, createChat, send, finished, get service() { return service; }, get token() { return token; }, async restart() { await service.close(); service = await createService(options()); await service.ready; } };
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

test('prompt acceptance lookup is read-only, chat-scoped and survives completion, restart and deletion', async t => {
  const f = await fixture(t), chatId = randomUUID(), promptId = randomUUID();
  const lookup = async (chat = chatId, prompt = promptId) => f.request(`/api/chats/${chat}/prompts/${prompt}`);
  assert.equal((await f.request('/api/state')).data.capabilities.promptStatus, true);
  assert.deepEqual((await lookup()).data, { accepted: false, deleted: false, status: null, startedAt: null, endedAt: null, delivery: null });
  assert.ok(!(await f.request('/api/state')).data.chats.some(chat => chat.id === chatId));
  const project = (await f.request('/api/state')).data.projects[0];
  const payload = { id: promptId, text: 'hang', projectId: project.id };
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, payload)).status, 202);
  await wait(async () => (await lookup()).data.startedAt);
  assert.equal((await lookup()).data.accepted, true); assert.equal((await lookup()).data.status, 'running');
  assert.equal((await lookup(randomUUID())).data.accepted, false);
  assert.equal((await lookup(chatId, randomUUID())).data.accepted, false);
  const unauthorized = await fetch(f.service.url + `/api/chats/${chatId}/prompts/${promptId}`); assert.equal(unauthorized.status, 401);
  await f.request(`/api/chats/${chatId}/stop`, {}); await f.finished({ id: chatId });
  const completed = (await lookup()).data; assert.equal(completed.status, 'interrupted'); assert.ok(completed.endedAt);
  assert.deepEqual(Object.keys(completed).sort(), ['accepted', 'deleted', 'delivery', 'endedAt', 'startedAt', 'status']);
  await f.restart(); assert.deepEqual((await lookup()).data, completed);
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, payload)).data.duplicate, true);
  await f.request(`/api/chats/${chatId}/delete`, {});
  assert.deepEqual((await lookup()).data, { ...completed, deleted: true, status: null });
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, payload)).status, 410);
  assert.equal(readFileSync(join(f.projectPath, 'calls.ndjson'), 'utf8').trim().split('\n').length, 1);
});

test('incremental transcripts update old messages in place, preserve inserted order, and refresh metadata across restart', async t => {
  const f = await fixture(t), chat = await f.createChat();
  const transcript = async since => (await f.request(`/api/chats/${chat.id}/messages${since ? `?since=${encodeURIComponent(since)}` : ''}`)).data;
  const db = new DatabaseSync(join(f.dir, 'data/data.sqlite')); t.after(() => db.close());
  const insert = (id, role, value, kind = null) => db.prepare('INSERT INTO messages (id,chatId,role,text,createdAt,kind) VALUES (?,?,?,?,?,?)').run(id, chat.id, role, value, Date.now(), kind);
  insert('prompt', 'user', 'Check this'); insert('reply', 'assistant', 'Partial'); insert('shell', 'activity', 'Shell\n{}');
  const first = await transcript(); assert.equal(first.full, true);
  assert.ok(first.messages.every(message => message.revision === undefined));
  insert('steer', 'user', 'Also check that', 'steer'); insert('shell:result', 'activity', 'Tool result\nDone');
  db.prepare('UPDATE messages SET text=? WHERE id=?').run('Canonical answer', 'reply');
  const delta = await transcript(first.cursor);
  assert.equal(delta.full, false);
  assert.deepEqual(delta.messages.map(message => [message.id, message.text]), [['reply', 'Canonical answer'], ['steer', 'Also check that'], ['shell:result', 'Tool result\nDone']]);
  db.prepare('UPDATE messages SET text=? WHERE id=?').run('Canonical answer', 'reply');
  db.prepare("UPDATE chats SET status='running',activity='Checking files',thinking='Live thought' WHERE id=?").run(chat.id);
  db.prepare('INSERT INTO prompts (id,chatId,text,startedAt) VALUES (?,?,?,?)').run('prompt', chat.id, 'Check this', Date.now());
  db.prepare('INSERT INTO approvals VALUES (?,?,?,?,?,?)').run('approval', chat.id, 'Bash', '{}', 'pending', Date.now());
  db.prepare('INSERT INTO subagents (id,chatId,promptId,agent,title,status,startedAt) VALUES (?,?,?,?,?,?,?)').run('sub', chat.id, 'prompt', 'claude', 'Check files', 'running', Date.now());
  const metadata = await transcript(delta.cursor);
  assert.deepEqual(metadata.messages, []); assert.equal(metadata.cursor, delta.cursor);
  assert.equal(metadata.thinking, 'Live thought'); assert.equal(metadata.activity, 'Checking files');
  assert.equal(metadata.approvals[0].status, 'pending'); assert.equal(metadata.turns[0].id, 'prompt'); assert.equal(metadata.subagents[0].status, 'running');
  await f.restart();
  const restarted = await transcript(metadata.cursor);
  assert.equal(restarted.full, false); assert.deepEqual(restarted.messages, []); assert.equal(restarted.thinking, null);
  assert.equal(restarted.approvals[0].status, 'deny'); assert.equal(restarted.subagents[0].status, 'stopped'); assert.ok(restarted.turns[0].endedAt);
  const other = await f.createChat(), wrongChat = (await f.request(`/api/chats/${other.id}/messages`)).data.cursor;
  const future = JSON.parse(Buffer.from(restarted.cursor, 'base64url').toString()); future[2]++;
  for (const cursor of ['broken', wrongChat, Buffer.from(JSON.stringify(future)).toString('base64url')]) {
    const recovered = await transcript(cursor); assert.equal(recovered.full, true); assert.equal(recovered.messages.length, 5);
  }
  db.prepare('DELETE FROM messages WHERE id=?').run('shell:result');
  const deleted = await transcript(restarted.cursor);
  assert.equal(deleted.full, true); assert.equal(deleted.messages.length, 4); assert.ok(!deleted.messages.some(message => message.id === 'shell:result'));
  assert.equal((await f.request(`/api/chats/${chat.id}/delete`, {})).status, 200);
  assert.equal((await f.request(`/api/chats/${chat.id}/messages?since=${encodeURIComponent(deleted.cursor)}`)).status, 404);
});

test('a long transcript fetch sends only changed rows and uses message and turn indexes', async t => {
  const f = await fixture(t), chat = await f.createChat(), db = new DatabaseSync(join(f.dir, 'data/data.sqlite')); t.after(() => db.close());
  db.exec('BEGIN');
  const insert = db.prepare('INSERT INTO messages (id,chatId,role,text,createdAt) VALUES (?,?,?,?,?)');
  for (let index = 0; index < 1000; index++) insert.run(`long-${index}`, chat.id, 'assistant', 'Earlier answer '.repeat(50), index);
  db.exec('COMMIT');
  const full = (await f.request(`/api/chats/${chat.id}/messages`)).data;
  db.prepare('UPDATE messages SET text=? WHERE id=?').run('Updated final answer', 'long-999');
  const delta = (await f.request(`/api/chats/${chat.id}/messages?since=${encodeURIComponent(full.cursor)}`)).data;
  assert.equal(full.messages.length, 1000); assert.deepEqual(delta.messages.map(message => message.id), ['long-999']);
  assert.ok(Buffer.byteLength(JSON.stringify(delta)) < Buffer.byteLength(JSON.stringify(full)) / 100);
  const messagePlan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM messages WHERE chatId=? AND revision>? ORDER BY rowid').all(chat.id, 1000);
  const turnPlan = db.prepare('EXPLAIN QUERY PLAN SELECT id,startedAt,endedAt FROM prompts WHERE chatId=? AND startedAt IS NOT NULL ORDER BY startedAt').all(chat.id);
  assert.ok(messagePlan.some(row => row.detail.includes('USING INDEX messages_chat_revision')));
  assert.ok(turnPlan.some(row => row.detail.includes('USING INDEX prompts_chat_started')));
  t.diagnostic(`Transcript JSON bytes: ${Buffer.byteLength(JSON.stringify(full))} full, ${Buffer.byteLength(JSON.stringify(delta))} incremental`);
});

for (const agent of ['claude', 'codex']) test(`${agent} thinking is live and reconnectable, separate from history, and clears on completion, stop and restart`, async t => {
  const f = await fixture(t), projectId = (await f.request('/api/state')).data.projects[0].id;
  const chat = (await f.request('/api/chats', { projectId, agent })).data;
  const transcript = async () => (await f.request(`/api/chats/${chat.id}/messages`)).data;
  const thinking = async () => wait(async () => (await transcript()).thinking === 'First thought\n\nSecond thought');
  assert.equal((await f.send(chat, 'thinking')).status, 202); await thinking();
  // Every reconnect reads the persisted live value; history and previews contain no thinking.
  assert.equal((await transcript()).thinking, 'First thought\n\nSecond thought');
  assert.deepEqual((await transcript()).messages.map(message => message.text), ['thinking']);
  assert.equal((await f.request('/api/state')).data.chats.find(item => item.id === chat.id).preview, 'thinking');
  assert.equal((await f.request(`/api/chats/${chat.id}/prompts`, { id: randomUUID(), text: 'finish', delivery: 'steer' })).status, 202);
  await f.finished(chat);
  assert.equal((await transcript()).thinking, null);
  assert.deepEqual((await transcript()).messages.filter(message => message.role === 'assistant').map(message => message.text), ['Final answer']);
  await f.send(chat, 'thinking'); await thinking();
  await f.request(`/api/chats/${chat.id}/stop`, {});
  assert.equal((await transcript()).thinking, null); await f.finished(chat);
  await f.send(chat, 'thinking'); await thinking();
  await f.restart();
  assert.equal((await transcript()).thinking, null);
});

test('Claude clears completed thinking while background agents keep its run open', async t => {
  const f = await fixture(t), chat = await f.createChat();
  const transcript = async () => (await f.request(`/api/chats/${chat.id}/messages`)).data;
  await f.send(chat, 'thinking-background');
  await wait(async () => (await transcript()).thinking);
  await f.request(`/api/chats/${chat.id}/prompts`, { id: randomUUID(), text: 'finish', delivery: 'steer' });
  await wait(async () => {
    const data = await transcript();
    return data.messages.some(message => message.text === 'Final answer') && data.thinking === null;
  });
  assert.equal((await f.request('/api/state')).data.chats.find(item => item.id === chat.id).status, 'running');
  await f.finished(chat);
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

test('large durable SSE replay streams retained changes and accepts Last-Event-ID on reconnect', async t => {
  const f = await fixture(t), before = f.service.state().lastSeq;
  const db = new DatabaseSync(join(f.dir, 'data/data.sqlite'));
  db.exec('BEGIN');
  const insert = db.prepare('INSERT INTO events (chatId,type) VALUES (?,?)');
  for (let i = 0; i < 8000; i++) insert.run(randomUUID(), 'message');
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
    assert.deepEqual(ids, Array.from({ length: 8000 }, (_, i) => before + i + 1));
    const reconnect = await fetch(f.service.url + `/api/events?after=${before}`, { headers: { Authorization: `Bearer ${f.token}` }, signal: controller.signal });
    await reconnect.body.getReader().read();
    await f.service.close(); // A scheduled replay batch must not read the closed database.
  } finally { controller.abort(); }
});

test('event retention bounds hints and diagnostics, reconciles expired cursors and preserves the sequence across restart', async t => {
  const f = await fixture(t), before = f.service.state().lastSeq, db = new DatabaseSync(join(f.dir, 'data/data.sqlite')); t.after(() => db.close());
  db.exec('BEGIN');
  const hint = db.prepare('INSERT INTO events (chatId,type) VALUES (?,?)'), raw = db.prepare('INSERT INTO raw_events (chatId,json) VALUES (?,?)');
  for (let index = 0; index < 15000; index++) hint.run(null, 'message');
  for (let index = 0; index < 300; index++) raw.run('diagnostic', index === 299 ? 'x'.repeat(200010) : String(index));
  db.exec('COMMIT');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 10000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM raw_events').get().n, 200);
  assert.equal(db.prepare('SELECT MAX(length(json)) AS n FROM raw_events').get().n, 200000);
  const last = f.service.state().lastSeq;
  for (const scope of ['', '&scope=status']) {
    const controller = new AbortController();
    try {
      const response = await fetch(f.service.url + `/api/events?after=${before}${scope}`, { headers: { Authorization: `Bearer ${f.token}` }, signal: controller.signal });
      const chunk = new TextDecoder().decode((await response.body.getReader().read()).value);
      assert.deepEqual(JSON.parse(/^data: (.+)$/m.exec(chunk)[1]), {seq:last, chatId:null, type:'state', reset:true}); assert.match(chunk, new RegExp(`id: ${last}\\n`));
    } finally { controller.abort(); }
  }
  // Startup also trims databases produced by releases without retention.
  db.exec('DROP TRIGGER events_retention; DROP TRIGGER raw_events_retention; BEGIN');
  for (let index = 0; index < 100; index++) { hint.run(null, 'state'); raw.run('legacy', 'x'.repeat(index === 99 ? 200010 : 1)); }
  db.exec('COMMIT');
  const legacyLast = f.service.state().lastSeq; await f.restart();
  assert.ok(f.service.state().lastSeq >= legacyLast);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 10000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM raw_events').get().n, 200);
  assert.equal(db.prepare('SELECT MAX(length(json)) AS n FROM raw_events').get().n, 200000);
  // Even an empty hint table must keep the high-water mark, and the next hint must advance it.
  const high = f.service.state().lastSeq; db.exec('DELETE FROM events');
  assert.equal(f.service.state().lastSeq, high); await f.restart(); assert.equal(f.service.state().lastSeq, high);
  hint.run(null, 'state'); assert.equal(f.service.state().lastSeq, high + 1);
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
  db.prepare("UPDATE chats SET status='running',thinking='Interrupted thought' WHERE id=?").run(chat.id);
  db.prepare('INSERT INTO prompts (id,chatId,text,startedAt) VALUES (?,?,?,?)').run('crash-id', chat.id, 'hello', Date.now() - 5000);
  db.prepare("INSERT INTO subagents (chatId,id,promptId,agent,title,status,startedAt) VALUES (?,?,?,?,?,?,?)").run(chat.id, 'toolu_x', 'crash-id', 'claude', 'Explore', 'running', Date.now() - 4000); db.close();
  await f.restart();
  assert.equal((await f.request('/api/state')).data.chats.find(c => c.id === chat.id).status, 'interrupted');
  // The crashed turn and its sub-agents are over: nothing keeps ticking.
  const after = (await f.request(`/api/chats/${chat.id}/messages`)).data;
  assert.equal(after.thinking, null);
  assert.ok(after.turns[0].endedAt); assert.deepEqual(after.subagents.map(item => item.status), ['stopped']);
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

for (const queued of ['closing Claude run', 'Codex interrupt queue', 'Codex early steers']) test(`Stop explains accepted prompts dropped from ${queued} and retries never run them`, async t => {
  let extra = {};
  if (queued === 'Codex early steers') {
    const dir = mkdtempSync(join(tmpdir(), 'pocketbridge-slow-thread-'));
    extra = { codexPath: fakeCodexCopy(dir, 'codex', '0.150.0', { FAKE_CODEX_THREAD_DELAY_MS: '1000' }).path };
    t.after(() => rmSync(dir, { recursive: true, force: true }));
  }
  const f = await fixture(t, extra), project = (await f.request('/api/state')).data.projects[0], chatId = randomUUID();
  const claude = queued === 'closing Claude run', first = claude ? 'stop-closing' : queued === 'Codex early steers' ? 'hello' : 'stop-queue';
  assert.equal((await turnWith(f, chatId, first, { projectId: project.id, agent: claude ? 'claude' : 'codex' })).status, 202);
  if (claude) await wait(() => {
    if (!existsSync(join(f.projectPath, 'closing.pid'))) return false;
    try { process.kill(Number(readFileSync(join(f.projectPath, 'closing.pid'), 'utf8')), 0); return false; } catch { return true; }
  });
  else if (queued === 'Codex interrupt queue') await wait(async () => (await messagesOf(f, chatId)).messages.some(message => message.text.includes('waiting for interrupt')));
  const payloads = ['check staging', 'ship staging'].map(text => ({ id: randomUUID(), text, delivery: queued === 'Codex interrupt queue' ? 'interrupt' : 'steer' }));
  for (const payload of payloads) assert.equal((await f.request(`/api/chats/${chatId}/prompts`, payload)).status, 202);
  await f.request(`/api/chats/${chatId}/stop`, {}); assert.equal((await f.finished({ id: chatId })).status, 'interrupted');
  const data = await messagesOf(f, chatId);
  for (const payload of payloads) {
    assert.equal(data.messages.filter(message => message.role === 'activity' && message.text === `Stopped before "${payload.text}" ran. Send it again if you still need it.`).length, 1);
    assert.ok(!data.turns.some(turn => turn.id === payload.id));
    assert.equal((await f.request(`/api/chats/${chatId}/prompts`, payload)).data.duplicate, true);
  }
  assert.equal((await f.request('/api/state')).data.chats.find(chat => chat.id === chatId).status, 'interrupted');
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

test('bug pass regressions: split UTF-8 bodies, delivery-aware duplicates, effort on model change, dropped steers, unknown Codex steers', async t => {
  const f = await fixture(t), project = (await f.request('/api/state')).data.projects[0];
  // A character split across two network chunks is stored intact, and a retry with the same text is a duplicate.
  const chatId = randomUUID(), promptId = randomUUID(), payload = Buffer.from(JSON.stringify({ id: promptId, text: 'ship it 🙂', projectId: project.id, model: 'opus', effort: 'max' }));
  const split = payload.indexOf(Buffer.from('🙂')) + 2;
  const status = await new Promise((resolveRequest, reject) => {
    const req = http.request(f.service.url + `/api/chats/${chatId}/prompts`, { method: 'POST', headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json', 'Content-Length': payload.length } }, res => { res.resume(); res.on('end', () => resolveRequest(res.statusCode)); });
    req.on('error', reject); req.write(payload.subarray(0, split)); setTimeout(() => req.end(payload.subarray(split)), 50);
  });
  assert.equal(status, 202);
  await f.finished({ id: chatId });
  assert.equal((await messagesOf(f, chatId)).messages[0].text, 'ship it 🙂');
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, { id: promptId, text: 'ship it 🙂', model: 'opus', effort: 'max' })).data.duplicate, true);
  // A new model keeps the chat's effort only if it supports it.
  assert.equal((await turnWith(f, chatId, 'hello', { model: 'haiku' })).status, 400);
  // A turn retried as a steer is the same prompt; a steer retried as "send now" is not.
  const steerChat = randomUUID();
  assert.equal((await turnWith(f, steerChat, 'steer-discard', { projectId: project.id })).status, 202);
  await wait(async () => (await messagesOf(f, steerChat)).messages.some(m => m.text.includes('sleep 1')));
  const steerId = randomUUID();
  assert.equal((await f.request(`/api/chats/${steerChat}/prompts`, { id: steerId, text: 'use staging', delivery: 'steer' })).data.delivery, 'steer');
  assert.equal((await f.request(`/api/chats/${steerChat}/prompts`, { id: steerId, text: 'use staging', delivery: 'interrupt' })).status, 409);
  assert.equal((await f.request(`/api/chats/${steerChat}/prompts`, { id: steerId, text: 'use staging', delivery: 'steer' })).data.duplicate, true);
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, { id: promptId, text: 'ship it 🙂', delivery: 'steer' })).data.duplicate, true);
  // Claude dropping an accepted steer is reported in the chat.
  await f.finished({ id: steerChat });
  assert.ok((await messagesOf(f, steerChat)).messages.some(m => m.role === 'activity' && m.text.includes('didn\'t run "use staging"')));
  // Codex exiting before it confirms a steer: the steer is reported, never run again.
  const codexChat = randomUUID();
  assert.equal((await turnWith(f, codexChat, 'steer-exit', { agent: 'codex', projectId: project.id })).status, 202);
  await wait(async () => (await messagesOf(f, codexChat)).messages.some(m => m.text.includes('sleep 1')));
  assert.equal((await turnWith(f, codexChat, 'check staging', { delivery: 'steer' })).status, 202);
  assert.equal((await f.finished({ id: codexChat })).status, 'error');
  assert.ok((await messagesOf(f, codexChat)).messages.some(m => m.role === 'activity' && m.text.includes('Codex stopped before confirming "check staging"')));
  const calls = readFileSync(join(f.projectPath, 'codex-calls.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
});

test('bug pass regressions: Codex skills without a listing, Codex continue brings the reply, unanswered sessions, unusual git files', async t => {
  const f = await fixture(t), project = (await f.request('/api/state')).data.projects[0];
  // Unicode names are counted and empty new files add no lines.
  const git = (...args) => spawnSync('git', ['-C', f.projectPath, ...args], { encoding: 'utf8' });
  git('init', '-q'); writeFileSync(join(f.projectPath, 'ñandú.txt'), 'a\nb\n'); writeFileSync(join(f.projectPath, 'empty.txt'), '');
  const status = (await f.request(`/api/projects/${project.id}/git`)).data;
  assert.equal(status.added, 2); assert.equal(status.files, 2);
  // A "/skill" prompt works right after a restart, before any client listed commands.
  const skillChat = randomUUID();
  assert.equal((await turnWith(f, skillChat, '/ship-it now', { agent: 'codex', projectId: project.id })).status, 202);
  await f.finished({ id: skillChat });
  assert.equal((await messagesOf(f, skillChat)).messages.find(m => m.role === 'assistant').text, 'skill ship-it at /skills/ship-it/SKILL.md');
  // Continuing a Codex thread copies its last prompt and its final reply.
  const codexChat = (await f.request('/api/chats/continue', { projectId: project.id, agent: 'codex', sessionId: 'codex-thread-1' })).data;
  assert.deepEqual((await messagesOf(f, codexChat.id)).messages.map(m => [m.role, m.text]), [['user', 'Make the login page load faster'], ['assistant', 'Login now loads in 300 ms.']]);
  // A session whose last prompt went unanswered doesn't pair it with an older reply.
  const dir = join(f.claudeProjectsDir, project.path.replace(/[^a-zA-Z0-9]/g, '-')), source = randomUUID(); mkdirSync(dir, { recursive: true });
  const record = value => JSON.stringify(value) + '\n';
  writeFileSync(join(dir, `${source}.jsonl`), record({ type: 'user', cwd: project.path, isSidechain: false, message: { role: 'user', content: 'Add dark mode' } })
    + record({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'Dark mode is in.' }] } })
    + record({ type: 'user', isSidechain: false, message: { role: 'user', content: 'Now add a toggle' } }));
  const claudeChat = (await f.request('/api/chats/continue', { projectId: project.id, agent: 'claude', sessionId: source })).data;
  assert.deepEqual((await messagesOf(f, claudeChat.id)).messages.map(m => [m.role, m.text]), [['user', 'Now add a toggle']]);
});

test('a finished Claude chat opens in Claude Desktop through its resume link; others are refused', async t => {
  const f = await fixture(t), project = (await f.request('/api/state')).data.projects[0];
  const draft = await f.createChat();
  assert.equal((await f.request(`/api/chats/${draft.id}/desktop`, {})).status, 409);
  const chatId = randomUUID();
  assert.equal((await turnWith(f, chatId, 'slow', { projectId: project.id })).status, 202);
  await wait(async () => (await messagesOf(f, chatId)).messages.some(m => m.text.includes('sleep 100')));
  assert.equal((await f.request(`/api/chats/${chatId}/desktop`, {})).status, 409);
  await f.request(`/api/chats/${chatId}/stop`, {}); await f.finished({ id: chatId });
  assert.equal((await f.request(`/api/chats/${chatId}/desktop`, {})).status, 200);
  assert.deepEqual(f.opened, [`claude://resume?session=${chatId}`]);
  const codexChat = randomUUID();
  await turnWith(f, codexChat, 'hello', { agent: 'codex', projectId: project.id }); await f.finished({ id: codexChat });
  assert.equal((await f.request(`/api/chats/${codexChat}/desktop`, {})).status, 409);
  assert.equal(f.opened.length, 1);
});

const pngOf = (width, height) => {
  const chunk = (type, data) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const row = Buffer.alloc(1 + width * 4); for (let x = 0; x < width; x++) { row[1 + x * 4] = 200; row[4 + x * 4] = 255; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
};
/** A Vista-style ICO holding one PNG image. */
const icoOf = image => {
  const header = Buffer.alloc(22), side = image.readUInt32BE(16); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  header[6] = side >= 256 ? 0 : side; header[7] = side >= 256 ? 0 : side; header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(image.length, 14); header.writeUInt32LE(22, 18);
  return Buffer.concat([header, image]);
};
/** A copy of the fake Codex CLI that reports another version, read from a file so a test can "update" it in place. */
const fakeCodexCopy = (dir, name, version, env = {}) => {
  const path = join(dir, name), versionFile = join(dir, `${name}.version`);
  writeFileSync(versionFile, version);
  writeFileSync(path, `#!/usr/bin/env node\nObject.assign(process.env, ${JSON.stringify(env)});\nprocess.env.FAKE_CODEX_VERSION = require('node:fs').readFileSync(${JSON.stringify(versionFile)}, 'utf8').trim();\nimport(${JSON.stringify(join(here, 'fake-codex.mjs'))});\n`.replace("require('node:fs')", "process.getBuiltinModule('node:fs')"), { mode: 0o755 });
  return { path, update: next => writeFileSync(versionFile, next) };
};

test('the newest installed CLI runs: versions are compared, duplicates asked once, and an update is picked up on refresh', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pocketbridge-cli-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const newer = fakeCodexCopy(dir, 'codex-app', '0.160.0'), older = fakeCodexCopy(dir, 'codex-old', '0.9.0');
  symlinkSync(newer.path, join(dir, 'codex-link'));
  assert.ok(compareVersions('0.160.0', '0.157.1') > 0 && compareVersions('2.1.10', '2.1.9') > 0 && compareVersions('1.0', '1.0.0') === 0);
  assert.deepEqual(await newestCli([join(here, 'fake-codex.mjs'), older.path, join(dir, 'codex-link'), newer.path, join(dir, 'missing')]), { path: join(dir, 'codex-link'), version: '0.160.0' });
  assert.equal(await newestCli([join(dir, 'missing')]), null);
  // Configured path first: a tie keeps it.
  assert.equal((await newestCli([join(here, 'fake-codex.mjs'), fakeCodexCopy(dir, 'same', '0.150.0').path])).path, join(here, 'fake-codex.mjs'));

  const f = await fixture(t, { cliCandidates: { codex: [older.path, newer.path] } }), project = (await f.request('/api/state')).data.projects[0];
  let [claude, codex] = (await f.request('/api/state')).data.capabilities.agents;
  assert.equal(claude.version, '2.1.0'); assert.equal(codex.version, '0.160.0');
  assert.equal(codex.models[0].id, 'gpt-test-nova');
  const chatId = randomUUID();
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, { id: randomUUID(), text: 'hello', agent: 'codex', model: 'gpt-test-nova', projectId: project.id })).status, 202);
  await f.finished({ id: chatId });
  const calls = readFileSync(join(f.projectPath, 'codex-calls.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(call => call.version === '0.160.0'));
  // The app's copy updates in place; turning Codex on again (or the 30-minute refresh) asks every candidate again.
  newer.update('0.161.2');
  await f.request('/api/agents/codex', { enabled: true });
  await wait(async () => (await f.request('/api/state')).data.capabilities.agents[1].version === '0.161.2');
  // Without a working candidate the last good choice stays.
  newer.update('broken'); writeFileSync(newer.path, '#!/bin/sh\nexit 1\n');
  await f.request('/api/agents/codex', { enabled: true });
  await new Promise(r => setTimeout(r, 300));
  [, codex] = (await f.request('/api/state')).data.capabilities.agents;
  assert.equal(codex.available, true);
});

test('Codex speed tiers come from model/list, are saved per chat and prompt, and reach turn/start as serviceTier', async t => {
  const f = await fixture(t), state = (await f.request('/api/state')).data, project = state.projects[0];
  const [claude, codex] = state.capabilities.agents;
  assert.ok(claude.models.every(model => Array.isArray(model.speeds) && model.speeds.length === 0));
  assert.deepEqual(codex.models.find(model => model.id === 'gpt-test-astra').speeds, [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }]);
  assert.deepEqual(codex.models.find(model => model.id === 'gpt-test-luna').speeds, []);
  // New chats and drafts.
  const draft = await f.request('/api/chats', { projectId: project.id, agent: 'codex', model: 'gpt-test-astra', speed: 'priority' });
  assert.equal(draft.status, 201); assert.equal(draft.data.speed, 'priority');
  assert.equal((await f.request('/api/chats', { projectId: project.id })).data.speed, null);
  const refused = await f.request('/api/chats', { projectId: project.id, agent: 'codex', model: 'gpt-test-luna', speed: 'priority' });
  assert.equal(refused.status, 400); assert.equal(refused.data.error, 'Unsupported speed for this model');
  assert.equal((await f.request('/api/chats', { projectId: project.id, agent: 'claude', speed: 'priority' })).status, 400);
  assert.equal((await f.request('/api/chats', { projectId: project.id, agent: 'codex', speed: 42 })).status, 400);
  // The default model's tiers apply when no model is named.
  assert.equal((await f.request('/api/chats', { projectId: project.id, agent: 'codex', speed: 'priority' })).status, 201);

  const chatId = randomUUID(), first = { id: randomUUID(), text: 'hello', agent: 'codex', model: 'gpt-test-astra', speed: 'priority', projectId: project.id };
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, first)).status, 202);
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, first)).data.duplicate, true);
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, { ...first, speed: null })).status, 409);
  await f.finished({ id: chatId });
  assert.equal((await f.request('/api/state')).data.chats.find(chat => chat.id === chatId).speed, 'priority');
  // A model without the tier runs at standard speed, and Codex is told so because the thread was fast.
  const luna = await f.request(`/api/chats/${chatId}/prompts`, { id: randomUUID(), text: 'again', model: 'gpt-test-luna' });
  assert.equal(luna.status, 202); await f.finished({ id: chatId });
  assert.equal((await f.request('/api/state')).data.chats.find(chat => chat.id === chatId).speed, null);
  await f.request(`/api/chats/${chatId}/prompts`, { id: randomUUID(), text: 'third' }); await f.finished({ id: chatId });
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, { id: randomUUID(), text: 'fast', model: 'gpt-test-astra', speed: 'priority' })).status, 202);
  await f.finished({ id: chatId });
  const turns = readFileSync(join(f.projectPath, 'codex-calls.ndjson'), 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.method === 'turn/start');
  assert.deepEqual(turns.map(turn => 'serviceTier' in turn.params ? turn.params.serviceTier : 'omitted'), ['priority', null, 'omitted', 'priority']);
  const db = new DatabaseSync(join(f.dir, 'data/data.sqlite'), { readOnly: true });
  assert.deepEqual(db.prepare('SELECT speed FROM prompts WHERE chatId=? ORDER BY rowid').all(chatId).map(row => row.speed), ['priority', null, null, 'priority']);
  db.close();
  // Clients before 0.7 send no speed and keep the chat's.
  const keep = await f.request(`/api/chats/${chatId}/prompts`, { id: randomUUID(), text: 'keep' });
  assert.equal(keep.status, 202); await f.finished({ id: chatId });
  assert.equal((await f.request('/api/state')).data.chats.find(chat => chat.id === chatId).speed, 'priority');
});

test('an older data folder gains new columns and keeps its chats and messages', async t => {
  const f = await fixture(t), chat = await f.createChat();
  await f.send(chat, 'hello'); await f.finished(chat);
  const before = (await f.request(`/api/chats/${chat.id}/messages`)).data;
  await f.service.close();
  const db = new DatabaseSync(join(f.dir, 'data/data.sqlite'));
  db.exec('DROP TRIGGER messages_insert_revision; DROP TRIGGER messages_update_revision; DROP TRIGGER messages_delete_revision; DROP INDEX messages_chat_revision; DROP TABLE message_clock; ALTER TABLE messages DROP COLUMN revision;');
  for (const [table, column] of [['chats', 'speed'], ['prompts', 'speed'], ['projects', 'icon'], ['projects', 'iconType'], ['projects', 'iconSource'], ['projects', 'iconCheckedAt']]) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.close();
  await f.restart();
  const state = (await f.request('/api/state')).data;
  assert.equal(state.chats.find(item => item.id === chat.id).speed, null);
  assert.equal(state.projects[0].icon, null);
  const migrated = (await f.request(`/api/chats/${chat.id}/messages?since=${encodeURIComponent(before.cursor)}`)).data;
  assert.equal(migrated.full, true); assert.deepEqual(migrated.messages, before.messages);
  assert.equal((await f.send(chat, 'hello')).status, 202); await f.finished(chat);
  const delta = (await f.request(`/api/chats/${chat.id}/messages?since=${encodeURIComponent(migrated.cursor)}`)).data;
  assert.equal(delta.full, false); assert.ok(delta.messages.length);
  assert.ok(delta.messages.every(message => !before.messages.some(old => old.id === message.id)));
});

test('usage marks weekly and session windows, lists Codex resets, and redeems one reset per attempt', async t => {
  const f = await fixture(t);
  const usage = async () => (await f.request('/api/usage')).data.agents;
  let [claude, codex] = await usage();
  assert.deepEqual(claude.limits.map(limit => limit.window), ['session', 'weekly', 'weekly']);
  assert.equal(claude.resets, undefined);
  assert.deepEqual(codex.limits.map(limit => [limit.id, limit.window]), [['primary', 'weekly'], ['secondary', 'session']]);
  assert.deepEqual(codex.resets, { available: 2, credits: [
    { id: 'credit-a', title: 'Full reset', description: 'One free rate limit reset.', expiresAt: 1792702115000 },
    { id: 'credit-b', title: null, description: null, expiresAt: null },
  ] });
  const reset = body => f.request('/api/usage/codex/reset', body);
  assert.equal((await reset({ id: 'not-a-uuid' })).status, 400);
  assert.equal((await reset({ id: randomUUID(), creditId: 'bad id!' })).status, 400);
  assert.equal((await reset({ id: randomUUID(), creditId: 'nothing' })).data.outcome, 'nothingToReset');
  const unknown = await reset({ id: randomUUID(), creditId: 'credit-zzz' });
  assert.equal(unknown.status, 502); assert.equal(unknown.data.error, 'Unknown reset credit');
  // Concurrent retries of one attempt redeem once.
  const attempt = randomUUID();
  const answers = await Promise.all([reset({ id: attempt, creditId: 'credit-a' }), reset({ id: attempt, creditId: 'credit-a' })]);
  assert.deepEqual(answers.map(answer => [answer.status, answer.data.outcome]), [[200, 'reset'], [200, 'reset']]);
  assert.equal((await reset({ id: attempt, creditId: 'credit-a' })).data.outcome, 'alreadyRedeemed');
  await wait(async () => (await usage())[1].resets.available === 1);
  [, codex] = await usage();
  assert.deepEqual(codex.resets.credits.map(credit => credit.id), ['credit-b']);
  assert.deepEqual(codex.limits.map(limit => limit.percent), [0, 0]);
  assert.equal((await reset({ id: randomUUID() })).data.outcome, 'reset');
  assert.equal((await reset({ id: randomUUID() })).data.outcome, 'noCredit');
  const consumed = readFileSync(join(f.dir, 'data', 'codex-calls.ndjson'), 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.method === 'account/rateLimitResetCredit/consume');
  assert.equal(consumed.filter(call => call.params.idempotencyKey === attempt).length, 2);
  assert.deepEqual(consumed[0].params, { idempotencyKey: consumed[0].params.idempotencyKey, creditId: 'nothing' });
  await f.request('/api/agents/codex', { enabled: false });
  assert.equal((await reset({ id: randomUUID() })).status, 409);
  assert.equal((await usage())[1].resets, null);
});

test('project icons: the best square logo inside the folder, converted when needed, served by tag and never through symlinks', async t => {
  const f = await fixture(t, { iconIntervalMs: 0 });
  const plain = (await f.request('/api/state')).data.projects[0];
  assert.equal(plain.icon, null);
  assert.equal((await f.request(`/api/projects/${plain.id}/icon`)).status, 404);
  const outside = join(f.dir, 'outside'), folder = join(f.dir, 'site'); mkdirSync(outside); writeFileSync(join(outside, 'logo.png'), pngOf(512, 512));
  mkdirSync(join(folder, 'public'), { recursive: true }); mkdirSync(join(folder, 'docs'));
  symlinkSync(join(outside, 'logo.png'), join(folder, 'logo.png'));
  symlinkSync(outside, join(folder, 'static'));
  writeFileSync(join(folder, 'public', 'favicon.ico'), icoOf(pngOf(48, 48)));
  writeFileSync(join(folder, 'public', 'apple-touch-icon.png'), pngOf(180, 180));
  writeFileSync(join(folder, 'docs', 'logo-wide.png'), pngOf(400, 100));
  const project = (await f.request('/api/projects', { path: folder })).data;
  assert.equal(project.icon, null);
  const tagged = async previous => wait(async () => { const icon = (await f.request('/api/state')).data.projects.find(item => item.id === project.id).icon; return icon && icon !== previous ? icon : null; });
  const icon = () => fetch(`${f.service.url}/api/projects/${project.id}/icon`, { headers: { Authorization: `Bearer ${f.token}` } });
  const first = await tagged(null), served = await icon();
  assert.equal(served.status, 200); assert.equal(served.headers.get('content-type'), 'image/png'); assert.equal(served.headers.get('cache-control'), 'private, max-age=86400');
  assert.ok(Buffer.from(await served.arrayBuffer()).equals(pngOf(180, 180)));
  // Only the ICO and a wide logo left: the ICO becomes a PNG of its own size.
  rmSync(join(folder, 'public', 'apple-touch-icon.png'));
  const second = await tagged(first);
  assert.deepEqual(measure(Buffer.from(await (await icon()).arrayBuffer()), 'png'), { width: 48, height: 48 });
  assert.notEqual(second, first);
  // No icon left: the tag clears and the route says so.
  rmSync(join(folder, 'public'), { recursive: true }); rmSync(join(folder, 'docs'), { recursive: true });
  await wait(async () => (await f.request('/api/state')).data.projects.find(item => item.id === project.id).icon === null);
  assert.equal((await icon()).status, 404);
});

test('icon search reads image headers, finds Android and Xcode app icons and stays within its folder budget', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pocketbridge-icons-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const res = join(dir, 'android', 'app', 'src', 'main', 'res'); mkdirSync(join(res, 'mipmap-xxxhdpi'), { recursive: true }); mkdirSync(join(res, 'mipmap-mdpi'));
  writeFileSync(join(res, 'mipmap-xxxhdpi', 'ic_launcher.png'), pngOf(192, 192)); writeFileSync(join(res, 'mipmap-mdpi', 'ic_launcher.png'), pngOf(48, 48));
  writeFileSync(join(res, 'mipmap-xxxhdpi', 'ic_launcher_foreground.png'), pngOf(432, 432));
  const appIcon = join(dir, 'ios', 'Runner', 'Assets.xcassets', 'AppIcon.appiconset'); mkdirSync(appIcon, { recursive: true });
  writeFileSync(join(appIcon, 'Icon-1024.png'), pngOf(1024, 1024));
  mkdirSync(join(dir, 'node_modules', 'pkg', 'res', 'mipmap-xxxhdpi'), { recursive: true }); writeFileSync(join(dir, 'node_modules', 'pkg', 'res', 'mipmap-xxxhdpi', 'ic_launcher.png'), pngOf(512, 512));
  writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50"></svg>');
  const found = await findIcons(dir);
  assert.equal(found[0].rel, join('ios', 'Runner', 'Assets.xcassets', 'AppIcon.appiconset', 'Icon-1024.png'));
  assert.ok(found.some(item => item.rel.endsWith(join('mipmap-xxxhdpi', 'ic_launcher.png'))));
  assert.ok(!found.some(item => item.rel.includes('node_modules') || item.rel.includes('foreground')));
  assert.ok(found.find(item => item.ext === 'svg').score < found.find(item => item.rel.includes('mipmap-mdpi')).score);
  assert.deepEqual((await findIcons(dir, { budget: 2 })).map(item => item.ext), ['svg']);
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc0001108002a003803012200021101031101', 'hex');
  assert.deepEqual(measure(jpeg, 'jpg'), { width: 56, height: 42 });
  assert.deepEqual(measure(Buffer.from('GIF89a\x20\x00\x10\x00', 'latin1'), 'gif'), { width: 32, height: 16 });
  assert.equal(measure(Buffer.from('not an image at all'), 'png'), null);
  // Large rasters shrink to 256 px; SVG is drawn by Quick Look.
  const big = (await renderIcon(found[0], dir)).data;
  assert.deepEqual(measure(big, 'png'), { width: 256, height: 256 });
  writeFileSync(join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#e60"/></svg>');
  const drawn = await renderIcon((await findIcons(dir)).find(item => item.rel === 'logo.svg'), dir);
  // Quick Look may be unavailable on a headless CI runner; then the SVG is simply not used.
  if (drawn || !process.env.CI) { assert.equal(drawn.type, 'image/png'); assert.ok(Math.max(...Object.values(measure(drawn.data, 'png'))) <= 256); }
});

test('review regressions: each Codex turn uses its own prompt speed, a tier is cleared even when a turn ends at once, and merged options are revalidated', async t => {
  const f = await fixture(t), project = (await f.request('/api/state')).data.projects[0];
  const turns = () => readFileSync(join(f.projectPath, 'codex-calls.ndjson'), 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.method === 'turn/start');
  // A Fast first turn, then a standard steer sent before Codex has even started: the steer becomes the next turn.
  const chatId = randomUUID();
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, { id: randomUUID(), text: 'hello', agent: 'codex', model: 'gpt-test-astra', speed: 'priority', projectId: project.id })).status, 202);
  assert.equal((await f.request(`/api/chats/${chatId}/prompts`, { id: randomUUID(), text: 'second', delivery: 'steer', speed: null })).status, 202);
  await f.finished({ id: chatId });
  assert.deepEqual(turns().map(turn => [turn.params.input[0].text, 'serviceTier' in turn.params ? turn.params.serviceTier : 'omitted']), [['hello', 'priority'], ['second', null]]);
  // And the other way round: a standard first prompt stays standard although a Fast steer changed the chat meanwhile.
  const other = randomUUID();
  await f.request(`/api/chats/${other}/prompts`, { id: randomUUID(), text: 'steer-wait', agent: 'codex', model: 'gpt-test-astra', projectId: project.id });
  await f.request(`/api/chats/${other}/prompts`, { id: randomUUID(), text: 'go fast', delivery: 'steer', speed: 'priority' });
  await f.finished({ id: other });
  assert.ok(!('serviceTier' in turns().find(turn => turn.params.input[0].text === 'steer-wait').params));

  // Two steers wait on a slow catalog: one moves to a model without speeds, the next asks for Fast without a model.
  const dir = join(f.dir, 'slow-list'); mkdirSync(join(dir, 'project'), { recursive: true });
  const slow = fakeCodexCopy(dir, 'codex', '0.150.0', { FAKE_CODEX_LIST_DELAY_MS: '700' });
  const service = await createService({ port: 0, dataDir: join(dir, 'data'), claudePath: join(here, 'fake-claude.mjs'), codexPath: slow.path, claudeProjectsDir: f.claudeProjectsDir, stopTimeoutMs: 50 });
  t.after(() => service.close());
  const token = (await (await fetch(service.url + '/api/local-session')).json()).token;
  const post = async (route, data) => { const response = await fetch(service.url + route, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); return { status: response.status, data: await response.json() }; };
  const registered = (await post('/api/projects', { path: join(dir, 'project') })).data, busy = randomUUID();
  assert.equal((await post(`/api/chats/${busy}/prompts`, { id: randomUUID(), text: 'hang', agent: 'codex', projectId: registered.id })).status, 202);
  const luna = post(`/api/chats/${busy}/prompts`, { id: randomUUID(), text: 'use luna', delivery: 'steer', model: 'gpt-test-luna' });
  await new Promise(r => setTimeout(r, 50));
  const fast = post(`/api/chats/${busy}/prompts`, { id: randomUUID(), text: 'go fast', delivery: 'steer', speed: 'priority' });
  const [first, second] = await Promise.all([luna, fast]);
  assert.equal(first.status, 202); assert.equal(second.status, 400); assert.equal(second.data.error, 'Unsupported speed for this model');
  await post(`/api/chats/${busy}/stop`, {});
  const db = new DatabaseSync(join(dir, 'data', 'data.sqlite'), { readOnly: true });
  assert.deepEqual({ ...db.prepare('SELECT model,speed FROM chats WHERE id=?').get(busy) }, { model: 'gpt-test-luna', speed: null });
  assert.ok(db.prepare('SELECT model,speed FROM prompts WHERE chatId=?').all(busy).every(row => !(row.model === 'gpt-test-luna' && row.speed)));
  db.close();
});

test('review regressions: icons are reread inside the project at render time, app icon folders count against the budget, and idle projects are rechecked', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pocketbridge-icons-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'project'), secret = join(dir, 'private'); mkdirSync(join(root, 'public'), { recursive: true }); mkdirSync(secret);
  writeFileSync(join(secret, 'key.png'), pngOf(64, 64)); writeFileSync(join(secret, 'big.png'), pngOf(600, 600));
  writeFileSync(join(root, 'logo.png'), pngOf(128, 128)); writeFileSync(join(root, 'public', 'icon.png'), pngOf(700, 700));
  const found = await findIcons(root), logo = found.find(item => item.rel === 'logo.png'), big = found.find(item => item.rel === join('public', 'icon.png'));
  assert.ok(logo && big);
  // Swapped for links after the scan: neither the served copy nor the converter's input may come from outside.
  rmSync(logo.path); symlinkSync(join(secret, 'key.png'), logo.path);
  assert.equal(await renderIcon(logo, dir), null);
  rmSync(join(root, 'public'), { recursive: true }); symlinkSync(secret, join(root, 'public')); writeFileSync(join(secret, 'icon.png'), pngOf(600, 600));
  assert.equal(await renderIcon(big, dir), null);
  // Thousands of icon folders side by side still stop at the folder budget.
  const res = join(dir, 'many'); mkdirSync(res);
  for (let index = 0; index < 20; index++) { mkdirSync(join(res, `mipmap-${index}`)); writeFileSync(join(res, `mipmap-${index}`, 'ic_launcher.png'), pngOf(48, 48)); }
  assert.equal((await findIcons(res, { budget: 3 })).length, 2);

  const f = await fixture(t, { iconIntervalMs: 200 }), project = (await f.request('/api/state')).data.projects[0];
  await new Promise(r => setTimeout(r, 300));
  writeFileSync(join(f.projectPath, 'favicon.png'), pngOf(64, 64));
  // Nothing asks for state here; the timer finds the new logo.
  await wait(async () => (await fetch(`${f.service.url}/api/projects/${project.id}/icon`, { headers: { Authorization: `Bearer ${f.token}` } })).status === 200);
});

test('the phone creates a new project as an empty folder in the experiments folder, once per id', async t => {
  const f = await fixture(t), id = randomUUID();
  assert.equal((await f.request('/api/state')).data.server.experiments, join(f.dir, 'experiments'));
  const created = await f.request('/api/projects/new', { id, name: 'Weather bot' });
  assert.equal(created.status, 201); assert.equal(created.data.name, 'Weather bot');
  assert.equal(created.data.path, realpathSync(join(f.dir, 'experiments', 'Weather bot')));
  assert.equal((await f.request('/api/projects/new', { id, name: 'Weather bot' })).status, 200);
  assert.equal((await f.request('/api/projects/new', { id: randomUUID(), name: 'Weather bot' })).status, 409);
  for (const name of ['../escape', '.hidden', 'a/b', 'trailing.', '']) assert.equal((await f.request('/api/projects/new', { id: randomUUID(), name })).status, 400, name);
  assert.ok((await f.request('/api/state')).data.projects.some(project => project.id === id));
  // A registration whose folder never got made (a crash in between) is finished by a retry with the same id.
  rmSync(join(f.dir, 'experiments', 'Weather bot'), { recursive: true });
  assert.equal((await f.request('/api/projects/new', { id, name: 'Weather bot' })).status, 200);
  assert.ok(existsSync(join(f.dir, 'experiments', 'Weather bot')));
  const chatId = randomUUID();
  assert.equal((await turnWith(f, chatId, 'hello', { projectId: id })).status, 202);
  await f.finished({ id: chatId });
});

test('General chats run in their own folder, outside any project, without git, sessions or icon', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pocketbridge-general-')), generalDir = join(dir, 'home'); mkdirSync(generalDir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = { port: 0, dataDir: join(dir, 'data'), claudePath: join(here, 'fake-claude.mjs'), codexPath: join(here, 'fake-codex.mjs'), claudeProjectsDir: join(dir, 'claude'), generalDir, stopTimeoutMs: 50, writtenGraceMs: 400 };
  mkdirSync(options.claudeProjectsDir);
  let service = await createService(options); await service.ready;
  const token = (await (await fetch(service.url + '/api/local-session')).json()).token;
  const call = async (route, data) => { const response = await fetch(service.url + route, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) }); return { status: response.status, data: await response.json() }; };
  let general = (await call('/api/state')).data.projects.filter(project => project.general);
  assert.equal(general.length, 1); assert.equal(general[0].name, 'General'); assert.equal(general[0].path, realpathSync(generalDir));
  assert.deepEqual((await call(`/api/projects/${general[0].id}/git`)).data, { repo: false });
  assert.deepEqual((await call(`/api/projects/${general[0].id}/sessions`)).data.sessions, []);
  const chatId = randomUUID();
  assert.equal((await call(`/api/chats/${chatId}/prompts`, { id: randomUUID(), text: 'hello', projectId: general[0].id })).status, 202);
  await wait(async () => (await call('/api/state')).data.chats.find(chat => chat.id === chatId)?.status === 'idle');
  assert.ok(existsSync(join(generalDir, 'calls.ndjson')));
  // A restart keeps the same single General project.
  await service.close(); service = await createService(options); await service.ready;
  t.after(() => service.close());
  const again = (await (await fetch(service.url + '/api/state', { headers: { Authorization: `Bearer ${(await (await fetch(service.url + '/api/local-session')).json()).token}` } })).json()).projects.filter(project => project.general);
  assert.deepEqual(again.map(project => project.id), [general[0].id]);
});

test('a paired phone locks the Mac through the screen interface; state reports the lock and its capability', async t => {
  const calls = [];
  const screen = { isLocked: false, failLock: false, ignoreLock: false,
    async locked() { calls.push('check'); return this.isLocked; },
    async lock() { calls.push('lock'); if (this.failLock) throw new Error('osascript: internal detail'); if (!this.ignoreLock) this.isLocked = true; } };
  const f = await fixture(t, { screen, screenSettleMs: 300 });
  const pair = (await f.request('/api/pairing')).data, phone = { Authorization: `Bearer ${(await f.request('/api/pair', { code: pair.code }, { Authorization: '' })).data.token}` };
  const state = (await f.request('/api/state', undefined, phone)).data;
  assert.deepEqual(state.capabilities.mac, { lock: true, unlock: false });
  assert.equal(state.server.locked, false);
  assert.equal((await fetch(f.service.url + '/api/mac/lock', { method: 'POST', body: '{}' })).status, 401);
  assert.deepEqual(await f.request('/api/mac/lock', {}, phone), { status: 200, data: { locked: true } });
  assert.equal(calls.filter(call => call === 'lock').length, 1);
  // Already locked: nothing is sent to macOS again.
  assert.deepEqual((await f.request('/api/mac/lock', {}, phone)).data, { locked: true });
  assert.equal(calls.filter(call => call === 'lock').length, 1);
  await wait(async () => (await f.request('/api/state', undefined, phone)).data.server.locked === true);
  // A change seen by the background check tells clients to fetch state.
  const before = (await f.request('/api/state')).data.lastSeq;
  screen.isLocked = false;
  await wait(async () => { const now = (await f.request('/api/state')).data; return now.server.locked === false && now.lastSeq > before; });
  // A refusal or a lock that doesn't take is an error, without macOS's own message.
  screen.failLock = true;
  assert.deepEqual(await f.request('/api/mac/lock', {}), { status: 502, data: { error: 'macOS refused to lock the screen' } });
  screen.failLock = false; screen.ignoreLock = true;
  assert.deepEqual(await f.request('/api/mac/lock', {}), { status: 502, data: { error: 'The Mac did not lock' } });
});

test('without a screen interface (tests, other platforms) locking is not offered, and tests cannot use the real one', async t => {
  const f = await fixture(t);
  const state = (await f.request('/api/state')).data;
  assert.deepEqual(state.capabilities.mac, { lock: false, unlock: false });
  assert.equal(state.server.locked, null);
  assert.equal((await f.request('/api/mac/lock', {})).status, 404);
  const { macScreen } = await import('./screen.mjs');
  await assert.rejects(createService({ screen: macScreen, port: 0, dataDir: join(f.dir, 'other'), claudeProjectsDir: f.claudeProjectsDir }), /must not lock the real screen/);
});
