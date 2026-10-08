import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createService } from './server.mjs';
import { resetFor, resetMarginMs, scheduleRequest, scheduleHorizonMs } from './schedules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
const wait = async predicate => {
  const end = Date.now() + 5000;
  while (Date.now() < end) { const result = await predicate(); if (result) return result; await pause(20); }
  throw new Error('Condition did not complete');
};

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pocketbridge-schedule-'));
  const projectPath = join(dir, 'project'); mkdirSync(projectPath);
  const claudeProjectsDir = join(dir, 'claude-projects'); mkdirSync(claudeProjectsDir);
  const options = () => ({ port: 0, dataDir: join(dir, 'data'), claudePath: join(here, 'fake-claude.mjs'), codexPath: join(here, 'fake-codex.mjs'), codexSessionsDir: join(dir, 'codex-sessions'), stopTimeoutMs: 50, claudeProjectsDir, discoverIntervalMs: 60_000, writtenGraceMs: 400 });
  let service = await createService(options()); await service.ready;
  t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });
  const token = (await (await fetch(service.url + '/api/local-session')).json()).token;
  const request = async (route, data) => {
    const response = await fetch(service.url + route, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  };
  const project = (await request('/api/projects', { path: projectPath })).data;
  const createChat = async () => (await request('/api/chats', { projectId: project.id })).data;
  const prompt = (chatId, body) => request(`/api/chats/${chatId}/prompts`, body);
  const chatOf = async chatId => (await request('/api/state')).data.chats.find(chat => chat.id === chatId);
  const transcript = async chatId => (await request(`/api/chats/${chatId}/messages`)).data;
  const lookup = async (chatId, promptId) => (await request(`/api/chats/${chatId}/prompts/${promptId}`)).data;
  const runs = () => existsSync(join(projectPath, 'calls.ndjson')) ? readFileSync(join(projectPath, 'calls.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const idle = chatId => wait(async () => { const chat = await chatOf(chatId); return chat && !['running', 'stopping', 'waiting'].includes(chat.status) ? chat : null; });
  return {
    dir, projectPath, project, request, createChat, prompt, chatOf, transcript, lookup, runs, idle,
    get service() { return service; },
    async stop() { await service.close(); },
    async start() { service = await createService(options()); await service.ready; },
  };
}

test('the reset to wait for is the latest of the used-up limits, else the fullest, and model limits count only for their model', () => {
  const now = 1_000_000_000_000, hour = 3_600_000;
  const session = { id: 'session', window: 'session', percent: 100, resetsAt: now + 3 * hour };
  const weekly = { id: 'weekly_all', window: 'weekly', percent: 40, resetsAt: now + 72 * hour };
  assert.equal(resetFor([session, weekly], now).at, now + 3 * hour + resetMarginMs);
  assert.equal(resetFor([session, { ...weekly, percent: 100 }], now).limit.id, 'weekly_all');
  // Nothing used up: the fullest limit, the sooner reset on a tie.
  assert.equal(resetFor([{ ...session, percent: 92 }, weekly], now).limit.id, 'session');
  assert.equal(resetFor([{ ...session, percent: 40 }, weekly], now).limit.id, 'session');
  // A limit that already reset, or has no time, says nothing.
  assert.equal(resetFor([{ ...session, resetsAt: now - 1 }, { ...weekly, resetsAt: null }], now), null);
  assert.equal(resetFor([], now), null); assert.equal(resetFor(undefined, now), null);
  const fable = { id: 'weekly_scoped:Fable', window: 'weekly', percent: 100, resetsAt: now + 100 * hour };
  assert.equal(resetFor([session, fable], now, 'Opus Test').limit.id, 'session');
  assert.equal(resetFor([session, fable], now, 'Fable 5').limit.id, 'weekly_scoped:Fable');
  // Codex windows have plain ids.
  assert.equal(resetFor([{ id: 'primary', percent: 100, resetsAt: now + hour }, { id: 'secondary', percent: 30, resetsAt: now + 2 * hour }], now).limit.id, 'primary');
});

test('schedule requests are reset or a time within a week', () => {
  const now = Date.now();
  assert.equal(scheduleRequest(undefined), null); assert.equal(scheduleRequest(null), null);
  assert.equal(scheduleRequest('reset'), 'reset');
  assert.equal(scheduleRequest(now + 1000, now), String(now + 1000));
  for (const bad of ['later', -5, 1.5, {}, now + scheduleHorizonMs + 1]) assert.throws(() => scheduleRequest(bad, now), error => error.status === 400);
});

test('a scheduled prompt is recorded and shown at once, runs once at its time, and a retry stays a duplicate', async t => {
  const f = await fixture(t), chat = await f.createChat(), id = randomUUID(), notBefore = Date.now() + 600;
  assert.equal((await f.request('/api/state')).data.capabilities.scheduledPrompts, true);
  const accepted = await f.prompt(chat.id, { id, text: 'finish the refactor', schedule: notBefore, delivery: 'steer' });
  assert.equal(accepted.status, 202);
  assert.deepEqual(accepted.data, { accepted: true, duplicate: false, delivery: 'scheduled', schedule: { notBefore, state: 'scheduled' } });
  const waiting = await f.chatOf(chat.id);
  assert.equal(waiting.status, 'idle'); assert.deepEqual(waiting.scheduled, { id, notBefore }); assert.equal(waiting.preview, 'finish the refactor');
  let log = await f.transcript(chat.id);
  assert.deepEqual(log.messages.map(m => [m.id, m.kind]), [[id, 'scheduled']]);
  assert.deepEqual(log.scheduled, [{ id, notBefore }]);
  assert.deepEqual((await f.lookup(chat.id, id)).schedule, { notBefore, state: 'scheduled' });
  // Retries: the same request is a duplicate; without its schedule it is different content.
  const retry = await f.prompt(chat.id, { id, text: 'finish the refactor', schedule: notBefore });
  assert.deepEqual(retry.data, { accepted: true, duplicate: true, schedule: { notBefore, state: 'scheduled' } });
  assert.equal((await f.prompt(chat.id, { id, text: 'finish the refactor' })).status, 409);
  assert.equal((await f.prompt(chat.id, { id, text: 'finish the refactor', schedule: notBefore + 1 })).status, 409);
  // One scheduled prompt per chat.
  const second = await f.prompt(chat.id, { id: randomUUID(), text: 'another', schedule: notBefore });
  assert.equal(second.status, 409); assert.match(second.data.error, /already has a scheduled prompt/);
  assert.equal(f.runs().length, 0);
  await wait(async () => (await f.lookup(chat.id, id)).schedule.state === 'started');
  assert.ok(Date.now() >= notBefore);
  assert.equal((await f.idle(chat.id)).status, 'idle');
  log = await f.transcript(chat.id);
  assert.deepEqual(log.messages.filter(m => m.role !== 'activity').map(m => [m.role, m.kind ?? null]), [['user', null], ['assistant', null]]);
  assert.deepEqual(log.scheduled, []); assert.deepEqual(log.turns.map(turn => turn.id), [id]);
  assert.equal((await f.chatOf(chat.id)).scheduled, undefined);
  assert.equal((await f.prompt(chat.id, { id, text: 'finish the refactor', schedule: notBefore })).data.duplicate, true);
  await pause(200);
  assert.deepEqual(f.runs().map(call => call.prompt), ['finish the refactor']);
});

test('a new chat can start with a scheduled first prompt, and a deleted chat never runs or comes back', async t => {
  const f = await fixture(t), chatId = randomUUID(), id = randomUUID(), body = { id, text: 'first', projectId: f.project.id, agent: 'claude', schedule: Date.now() + 400 };
  assert.equal((await f.prompt(chatId, body)).status, 202);
  const created = await f.chatOf(chatId);
  assert.equal(created.status, 'idle'); assert.equal(created.title, 'first'); assert.equal(created.scheduled.id, id);
  assert.equal((await f.request(`/api/chats/${chatId}/delete`, {})).status, 200);
  assert.deepEqual((await f.lookup(chatId, id)).schedule.state, 'cancelled');
  assert.equal((await f.prompt(chatId, body)).status, 410);
  assert.equal((await f.request(`/api/chats/${chatId}/prompts/${id}/cancel`, {})).data.state, 'cancelled');
  await pause(700);
  assert.equal(f.runs().length, 0);
  assert.equal((await f.chatOf(chatId)), undefined);
});

test('cancel and send now are safe to repeat and settle a race with the due time one way only', async t => {
  const f = await fixture(t), chat = await f.createChat(), action = (promptId, name, chatId = chat.id) => f.request(`/api/chats/${chatId}/prompts/${promptId}/${name}`, {});
  // Cancelled before its time: the bubble goes, nothing runs, a retry is a duplicate.
  const early = randomUUID(), body = { id: early, text: 'cancel me', schedule: Date.now() + 400 };
  await f.prompt(chat.id, body);
  assert.deepEqual((await action(early, 'cancel')).data, { ok: true, notBefore: body.schedule, state: 'cancelled' });
  assert.equal((await action(early, 'cancel')).status, 200);
  assert.equal((await action(early, 'send-now')).status, 409);
  assert.deepEqual((await f.transcript(chat.id)).messages, []);
  assert.equal((await f.chatOf(chat.id)).scheduled, undefined);
  assert.deepEqual((await f.prompt(chat.id, body)).data.schedule, { notBefore: body.schedule, state: 'cancelled' });
  assert.equal((await action(randomUUID(), 'cancel')).status, 404);
  assert.equal((await action(early, 'cancel', randomUUID())).status, 404);
  // Send now on a prompt far ahead runs it at once; after that it can't be cancelled.
  const later = randomUUID();
  await f.prompt(chat.id, { id: later, text: 'send me now', schedule: Date.now() + 3_600_000 });
  const now = await action(later, 'send-now');
  assert.equal(now.status, 200); assert.equal(now.data.state, 'started'); assert.ok(now.data.notBefore <= Date.now());
  assert.equal((await action(later, 'send-now')).data.state, 'started');
  const refused = await action(later, 'cancel'); assert.equal(refused.status, 409); assert.match(refused.data.error, /already started/);
  await f.idle(chat.id);
  const unscheduled = randomUUID(); await f.prompt(chat.id, { id: unscheduled, text: 'plain' }); await f.idle(chat.id);
  assert.equal((await action(unscheduled, 'cancel')).status, 409);
  await pause(600);
  assert.deepEqual(f.runs().map(call => call.prompt), ['send me now', 'plain']);
  // Cancelling right at the due time: either it was cancelled and never runs, or it started and runs once.
  for (let round = 0; round < 3; round++) {
    const racing = randomUUID(), at = Date.now() + 120, before = f.runs().length;
    await f.prompt(chat.id, { id: racing, text: `race ${round}`, schedule: at });
    await pause(Math.max(0, at - Date.now()));
    const answer = await action(racing, 'cancel');
    await f.idle(chat.id); await pause(300);
    const state = (await f.lookup(chat.id, racing)).schedule.state;
    if (answer.status === 200) { assert.equal(state, 'cancelled'); assert.equal(f.runs().length, before); }
    else { assert.equal(answer.status, 409); assert.equal(state, 'started'); assert.equal(f.runs().length, before + 1); }
  }
});

test('a prompt due while the service was down runs on startup; one that started before a crash is never repeated', async t => {
  const f = await fixture(t), chat = await f.createChat(), overdue = randomUUID(), future = randomUUID(), other = await f.createChat();
  await f.prompt(chat.id, { id: overdue, text: 'overdue', schedule: Date.now() + 300 });
  await f.prompt(other.id, { id: future, text: 'still ahead', schedule: Date.now() + 1500 });
  await f.stop();
  await pause(500);
  // A third prompt was marked started with its chat running when the service died.
  const crashed = randomUUID(), db = new DatabaseSync(join(f.dir, 'data/data.sqlite'));
  const third = randomUUID();
  db.prepare("INSERT INTO chats (id,projectId,agent,title,mode,status,updatedAt) VALUES (?,?,?,?,?,?,?)").run(third, f.project.id, 'claude', 'Crashed', 'bypassPermissions', 'running', Date.now());
  db.prepare("INSERT INTO prompts (id,chatId,text,schedule,scheduledAt,scheduleState,startedAt) VALUES (?,?,?,?,?,?,?)").run(crashed, third, 'crashed', 'reset', Date.now() - 1000, 'started', Date.now() - 900);
  db.close();
  await f.start();
  await wait(async () => (await f.lookup(chat.id, overdue)).schedule.state === 'started');
  await f.idle(chat.id);
  assert.equal((await f.lookup(other.id, future)).schedule.state, 'scheduled');
  assert.equal((await f.chatOf(third)).status, 'interrupted');
  await wait(async () => (await f.lookup(other.id, future)).schedule.state === 'started');
  await f.idle(other.id); await pause(200);
  assert.deepEqual(f.runs().map(call => call.prompt).sort(), ['overdue', 'still ahead']);
  assert.equal((await f.lookup(third, crashed)).schedule.state, 'started');
});

test('a running turn holds a due prompt until it ends, and the bubble moves below prompts sent meanwhile', async t => {
  const f = await fixture(t), chat = await f.createChat(), hang = randomUUID(), scheduled = randomUUID();
  await f.prompt(chat.id, { id: hang, text: 'hang' }); await wait(() => existsSync(join(f.projectPath, 'child.pid')));
  // Scheduled while a turn runs: accepted, not a steer, and the running chat stays running.
  const accepted = await f.prompt(chat.id, { id: scheduled, text: 'after the turn', schedule: Date.now() + 100, delivery: 'steer' });
  assert.equal(accepted.data.delivery, 'scheduled'); assert.equal((await f.chatOf(chat.id)).status, 'running');
  await pause(400);
  assert.equal((await f.lookup(chat.id, scheduled)).schedule.state, 'scheduled');
  assert.equal(f.runs().length, 1);
  await f.request(`/api/chats/${chat.id}/stop`, {});
  await wait(async () => (await f.lookup(chat.id, scheduled)).schedule.state === 'started');
  await f.idle(chat.id);
  assert.deepEqual(f.runs().map(call => call.prompt), ['hang', 'after the turn']);
  // Scheduled first, then a prompt that runs now: the scheduled one runs last and its bubble sits above its reply.
  const waiting = randomUUID(), now = randomUUID();
  await f.prompt(chat.id, { id: waiting, text: 'later one', schedule: Date.now() + 500 });
  await f.prompt(chat.id, { id: now, text: 'right now' }); await f.idle(chat.id);
  const before = (await f.transcript(chat.id)).cursor;
  await wait(async () => (await f.lookup(chat.id, waiting)).schedule.state === 'started'); await f.idle(chat.id);
  const log = await f.request(`/api/chats/${chat.id}/messages?since=${encodeURIComponent(before)}`);
  assert.equal(log.data.full, true);
  const users = log.data.messages.filter(m => m.role !== 'activity').map(m => m.role === 'user' ? m.text : 'reply');
  assert.deepEqual(users.slice(-4), ['right now', 'reply', 'later one', 'reply']);
});

test('an agent turned off by the due time skips the prompt and says so; reset times come from the CLI usage', async t => {
  const f = await fixture(t), chat = await f.createChat(), id = randomUUID();
  await f.prompt(chat.id, { id, text: 'while off', schedule: Date.now() + 300 });
  assert.equal((await f.request('/api/agents/claude', { enabled: false })).status, 200);
  await wait(async () => (await f.lookup(chat.id, id)).schedule.state === 'cancelled');
  const skipped = await f.chatOf(chat.id);
  assert.equal(skipped.status, 'error'); assert.match(skipped.error, /Claude is turned off/);
  const log = await f.transcript(chat.id);
  assert.equal(log.messages[0].kind, undefined); assert.match(log.messages[1].text, /wasn't sent at its scheduled time: Claude is turned off/);
  const off = await f.prompt(chat.id, { id: randomUUID(), text: 'reset while off', schedule: 'reset' });
  assert.equal(off.status, 409); assert.match(off.data.error, /turned off/);
  assert.equal(f.runs().length, 0);
  // Back on: the used-up session limit decides, plus the margin.
  await f.request('/api/agents/claude', { enabled: true });
  const sessionReset = Date.now() + 3_600_000, weeklyReset = Date.now() + 3 * 86_400_000;
  writeFileSync(join(f.dir, 'data', 'fake-usage.json'), JSON.stringify([
    { kind: 'session', percent: 100, severity: 'critical', resets_at: new Date(sessionReset).toISOString(), scope: null },
    { kind: 'weekly_all', percent: 61, severity: 'normal', resets_at: new Date(weeklyReset).toISOString(), scope: null },
  ]));
  const reset = randomUUID();
  const queued = await f.prompt(chat.id, { id: reset, text: 'at reset', schedule: 'reset' });
  assert.equal(queued.status, 202); assert.equal(queued.data.schedule.notBefore, sessionReset + resetMarginMs);
  assert.equal((await f.chatOf(chat.id)).status, 'idle');
  // The retry is judged on the request, not on a newly resolved time.
  assert.equal((await f.prompt(chat.id, { id: reset, text: 'at reset', schedule: 'reset' })).data.duplicate, true);
  assert.equal((await f.request(`/api/chats/${chat.id}/prompts/${reset}/cancel`, {})).data.state, 'cancelled');
});

test('a reset can only be scheduled when the CLI reports one', async t => {
  const f = await fixture(t), chat = await f.createChat();
  writeFileSync(join(f.dir, 'data', 'fake-usage.json'), JSON.stringify([{ kind: 'session', percent: 100, resets_at: new Date(Date.now() - 60_000).toISOString(), scope: null }]));
  const refused = await f.prompt(chat.id, { id: randomUUID(), text: 'when?', schedule: 'reset' });
  assert.equal(refused.status, 409); assert.match(refused.data.error, /hasn't reported when its limit resets/);
  assert.equal((await f.prompt(chat.id, { id: randomUUID(), text: 'bad', schedule: 'tomorrow' })).status, 400);
  assert.deepEqual((await f.transcript(chat.id)).messages, []);
});

test('a reset waits for the limits of the model the prompt runs with, even when the chat changes meanwhile', async t => {
  const f = await fixture(t), hour = 3_600_000, sessionReset = Date.now() + hour, opusReset = Date.now() + 72 * hour;
  writeFileSync(join(f.dir, 'data', 'fake-usage.json'), JSON.stringify([
    { kind: 'session', percent: 100, severity: 'critical', resets_at: new Date(sessionReset).toISOString(), scope: null },
    { kind: 'weekly_scoped', percent: 100, severity: 'critical', resets_at: new Date(opusReset).toISOString(), scope: { model: { id: null, display_name: 'Opus' } } },
  ]));
  // "default" is the catalog's default model, Opus Test, so its used-up weekly limit decides.
  const plain = await f.createChat(), first = randomUUID();
  assert.equal((await f.prompt(plain.id, { id: first, text: 'default model', schedule: 'reset' })).data.schedule.notBefore, opusReset + resetMarginMs);
  assert.equal((await f.prompt(plain.id, { id: randomUUID(), text: 'sonnet', model: 'sonnet', schedule: 'reset' })).status, 409);
  await f.request(`/api/chats/${plain.id}/prompts/${first}/cancel`, {});
  assert.equal((await f.prompt(plain.id, { id: randomUUID(), text: 'on sonnet', model: 'sonnet', schedule: 'reset' })).data.schedule.notBefore, sessionReset + resetMarginMs);
  // A chat on Sonnet switches to Opus while the usage report is awaited: the recorded time is Opus's.
  const chat = await f.createChat();
  await f.prompt(chat.id, { id: randomUUID(), text: 'pick sonnet', model: 'sonnet' }); await f.idle(chat.id);
  writeFileSync(join(f.dir, 'data', 'fake-usage-delay'), '600');
  const scheduled = f.prompt(chat.id, { id: randomUUID(), text: 'at reset', schedule: 'reset' });
  await pause(200);
  assert.equal((await f.prompt(chat.id, { id: randomUUID(), text: 'switch to opus', model: 'opus' })).status, 202);
  const queued = await scheduled;
  assert.equal(queued.status, 202); assert.equal(queued.data.schedule.notBefore, opusReset + resetMarginMs);
  assert.equal((await f.chatOf(chat.id)).model, 'opus');
});

test('a reset lookup that fails for the old model is retried after the chat changes model', async t => {
  const f = await fixture(t), opusReset = Date.now() + 72 * 3_600_000;
  // Only Opus has a future reset, so a lookup for Sonnet alone would be refused.
  writeFileSync(join(f.dir, 'data', 'fake-usage.json'), JSON.stringify([
    { kind: 'session', percent: 100, resets_at: new Date(Date.now() - 60_000).toISOString(), scope: null },
    { kind: 'weekly_scoped', percent: 100, severity: 'critical', resets_at: new Date(opusReset).toISOString(), scope: { model: { id: null, display_name: 'Opus' } } },
  ]));
  const chat = await f.createChat();
  await f.prompt(chat.id, { id: randomUUID(), text: 'pick sonnet', model: 'sonnet' }); await f.idle(chat.id);
  writeFileSync(join(f.dir, 'data', 'fake-usage-delay'), '600');
  const scheduled = f.prompt(chat.id, { id: randomUUID(), text: 'at reset', schedule: 'reset' });
  await pause(200);
  assert.equal((await f.prompt(chat.id, { id: randomUUID(), text: 'switch to opus', model: 'opus' })).status, 202);
  const queued = await scheduled;
  assert.equal(queued.status, 202); assert.equal(queued.data.schedule.notBefore, opusReset + resetMarginMs);
});
