import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createService } from './server.mjs';

const wait = async predicate => {
  const end = Date.now() + 5000;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Claude did not reach the expected state');
};
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pocketbridge-claude-')), projectPath = join(dir, 'project');
  mkdirSync(projectPath); mkdirSync(join(dir, 'claude'));
  const service = await createService({ port: 0, dataDir: join(dir, 'data'), generalDir: dir, claudeProjectsDir: join(dir, 'claude'), codexAvailable: false, claudePath: fileURLToPath(new URL('./fake-claude.mjs', import.meta.url)), stopTimeoutMs: 50, backgroundGraceMs: 400, writtenGraceMs: 100 });
  t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });
  await service.ready;
  const token = (await (await fetch(service.url + '/api/local-session')).json()).token;
  const request = async (path, body) => {
    const response = await fetch(service.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok, `${path}: ${response.status}`); return response.json();
  };
  const project = await request('/api/projects', { path: projectPath }), chat = await request('/api/chats', { projectId: project.id });
  return {
    chat, request, projectPath,
    send: (text, extra = {}) => request(`/api/chats/${chat.id}/prompts`, { id: randomUUID(), text, ...extra }),
    messages: () => request(`/api/chats/${chat.id}/messages`),
    finished: () => wait(async () => (await request('/api/state')).chats.find(row => row.id === chat.id && !['running', 'waiting', 'stopping'].includes(row.status))),
  };
}

test('Claude terminal errors close stale background tasks and the same chat resumes normally', async t => {
  const f = await fixture(t);
  await f.send('background-error');
  assert.equal((await f.finished()).status, 'error');
  assert.ok((await f.messages()).messages.some(row => row.role === 'activity' && row.text.includes('Claude could not finish the task.')));
  await f.send('hello');
  assert.equal((await f.finished()).status, 'idle');
  assert.deepEqual((await f.messages()).messages.filter(row => row.role === 'assistant').map(row => row.text), ['Hello']);
  const calls = readFileSync(join(f.projectPath, 'calls.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2); assert.ok(calls[1].args.includes('--resume'));
});

test('Claude keeps stdin open for a late background follow-up without requiring an init event', async t => {
  const f = await fixture(t);
  await f.send('late-followup');
  await wait(async () => (await f.messages()).messages.some(row => row.text === 'The worker finished.'));
  assert.equal((await f.messages()).turns[0].endedAt, null);
  writeFileSync(join(f.projectPath, 'start-followup'), '');
  await wait(async () => (await f.messages()).subagents[0]?.status === 'running');
  assert.equal((await f.messages()).turns[0].endedAt, null);
  writeFileSync(join(f.projectPath, 'finish-followup'), '');
  assert.equal((await f.finished()).status, 'idle');
  const data = await f.messages();
  assert.deepEqual(data.messages.filter(row => row.role === 'assistant').map(row => row.text), ['The worker finished.', 'Follow-up answer']);
  assert.equal(data.turns.length, 1); assert.ok(data.turns[0].endedAt >= data.turns[0].startedAt);
  assert.equal(readFileSync(join(f.projectPath, 'calls.ndjson'), 'utf8').trim().split('\n').length, 1);
});

test('Claude conversations preserve separate completed blocks through repeated resumes, steers and background work', async t => {
  const f = await fixture(t);
  for (let turn = 0; turn < 12; turn++) {
    if (turn % 3 === 0) {
      await f.send('multi-block');
      await wait(async () => (await f.messages()).thinking === 'First thought\n\nSecond thought');
      const data = await f.messages();
      assert.deepEqual(data.messages.filter(row => row.role === 'assistant').slice(-2).map(row => row.text), ['First reply.', 'Second reply.']);
      await f.send(`Continue ${turn}`, { delivery: 'steer' });
    } else await f.send(turn % 3 === 1 ? 'subagent' : 'hello');
    assert.equal((await f.finished()).status, 'idle');
    assert.equal((await f.messages()).thinking, null);
  }
  const data = await f.messages(), calls = readFileSync(join(f.projectPath, 'calls.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(data.turns.length, 12); assert.equal(calls.length, 12);
  assert.ok(calls.slice(1).every(call => call.args.includes('--resume')));
  assert.equal(data.subagents.length, 4); assert.ok(data.subagents.every(subagent => subagent.status === 'completed'));
  assert.equal(data.messages.filter(row => row.role === 'assistant').length, 20);
});

for (const prompt of ['subagent-backgrounded', 'subagent-mixed-ids']) test(`${prompt} stays running until its task notification, including optional tool ids`, async t => {
  const f = await fixture(t);
  await f.send(prompt);
  await wait(async () => (await f.messages()).subagents[0]?.activity === 'Checking error paths');
  const running = (await f.messages()).subagents[0];
  assert.equal(running.status, 'running'); assert.equal(running.toolUses, 2); assert.equal(running.tokens, 500);
  await f.send('Finish the review', { delivery: 'steer' });
  assert.equal((await f.finished()).status, 'idle');
  const finished = (await f.messages()).subagents[0];
  assert.equal((await f.messages()).subagents.length, 1);
  assert.equal(finished.id, prompt === 'subagent-mixed-ids' ? 'moving-task' : 'moving-agent');
  assert.equal(finished.status, 'failed'); assert.equal(finished.activity, 'Review failed');
  assert.equal(finished.toolUses, 3); assert.equal(finished.tokens, 700); assert.ok(finished.endedAt);
});

for (const activity of [null, 'Reading files']) test(`official Claude retries restore ${activity ?? 'idle activity'} without transcript notices`, async t => {
  const f = await fixture(t);
  const prompt = activity ? 'api-retry' : 'api-retry-idle';
  await f.send(prompt);
  await wait(async () => (await f.messages()).activity === 'Claude is retrying (2/3) in 3 seconds.');
  assert.deepEqual((await f.messages()).messages.map(row => row.text), [prompt]);
  await f.send('Resume', { delivery: 'steer' });
  await wait(async () => (await f.messages()).messages.some(row => row.text === 'Recovered answer'));
  assert.equal((await f.messages()).activity, activity);
  await f.send('Finish', { delivery: 'steer' });
  assert.equal((await f.finished()).status, 'idle');
  const data = await f.messages();
  assert.equal(data.activity, null); assert.ok(!data.messages.some(row => row.text.includes('retrying')));
  assert.equal(readFileSync(join(f.projectPath, 'calls.ndjson'), 'utf8').trim().split('\n').length, 1);
});
