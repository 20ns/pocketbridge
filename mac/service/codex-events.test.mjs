import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { codexAppConsumer } from './codex-events.mjs';
import { codexRun } from './codex-run.mjs';

function transcript() {
  const messages = new Map();
  return { messages, say: (role, text, id = `message-${messages.size}`) => { messages.set(id, { role, text }); return id; },
    update: (id, text) => { messages.get(id).text = text; }, append: (id, text) => { messages.get(id).text += text; },
    subagent() {}, context() {}, activity() {} };
}

test('Codex item ids are scoped to their turn, with separate assistant text and tool results', () => {
  const output = transcript(), consumer = codexAppConsumer(output);
  for (const turnId of ['first', 'second']) {
    consumer.consume('item/agentMessage/delta', { turnId, itemId: 'reply', delta: `${turnId} partial` });
    consumer.consume('item/completed', { turnId, item: { type: 'agentMessage', id: 'reply', text: turnId } });
    consumer.consume('item/completed', { turnId, item: { type: 'commandExecution', id: 'shell', command: 'pwd', aggregatedOutput: turnId, exitCode: 0 } });
  }
  const messages = [...output.messages.values()];
  assert.deepEqual(messages.filter(item => item.role === 'assistant').map(item => item.text), ['first', 'second']);
  assert.deepEqual(messages.filter(item => item.text.startsWith('Tool result')).map(item => item.text), ['Tool result\nfirst', 'Tool result\nsecond']);
});

test('Codex final snapshots replace partial text and completed messages reject late deltas', () => {
  const output = transcript(), consumer = codexAppConsumer(output);
  consumer.consume('item/agentMessage/delta', { turnId: 'turn', itemId: 'reply', delta: 'Incomplete ' });
  consumer.consume('turn/completed', { turn: { id: 'turn', items: [{ type: 'agentMessage', id: 'reply', text: 'Canonical answer' }] } });
  consumer.consume('item/agentMessage/delta', { turnId: 'turn', itemId: 'reply', delta: 'late duplicate' });
  consumer.consume('turn/completed', { turn: { id: 'turn', items: [{ type: 'agentMessage', id: 'reply', text: 'Canonical answer' }] } });
  consumer.consume('item/agentMessage/delta', { turnId: 'turn', delta: 'Missing item id' });
  assert.deepEqual([...output.messages.values()], [{ role: 'assistant', text: 'Canonical answer' }]);
  consumer.consume('error', { error: { message: 'Earlier turn failed' } });
  consumer.consume('turn/started', { turn: { id: 'next' } });
  assert.equal(consumer.state.failure, null);
});

test('Codex thinking reconciles indexed summaries, uses readable content as fallback and clears each turn', () => {
  const output = transcript(), values = [], consumer = codexAppConsumer({ ...output, thinking: value => values.push(value) });
  const delta = (method, fields) => consumer.consume(`item/reasoning/${method}`, { turnId: 'turn', itemId: 'thought', ...fields });
  consumer.consume('turn/started', { turn: { id: 'turn' } });
  delta('textDelta', { contentIndex: 0, delta: 'Raw thinking' });
  assert.equal(values.at(-1), 'Raw thinking');
  delta('summaryTextDelta', { summaryIndex: 1, delta: 'Second' });
  delta('summaryTextDelta', { summaryIndex: 0, delta: 'First ' });
  delta('summaryTextDelta', { summaryIndex: 0, delta: 'part' });
  assert.equal(values.at(-1), 'First part\n\nSecond');
  delta('summaryTextDelta', { summaryIndex: -1, delta: 'invalid' });
  delta('summaryTextDelta', { summaryIndex: 0, delta: { encrypted: 'private' } });
  assert.equal(values.at(-1), 'First part\n\nSecond');
  consumer.consume('item/completed', { turnId: 'turn', item: { type: 'reasoning', id: 'thought', summary: ['Canonical summary'], content: ['Raw thinking'] } });
  assert.equal(values.at(-1), 'Canonical summary');
  delta('summaryTextDelta', { summaryIndex: 0, delta: 'late duplicate' });
  assert.equal(values.at(-1), 'Canonical summary');
  assert.equal(output.messages.size, 0);
  consumer.consume('turn/completed', { turn: { id: 'turn', items: [] } });
  assert.equal(values.at(-1), null);
  consumer.consume('turn/started', { turn: { id: 'next' } });
  consumer.consume('item/completed', { turnId: 'next', item: { type: 'reasoning', id: 'thought', summary: [], content: ['Next thought'] } });
  assert.equal(values.at(-1), 'Next thought');
});

for (const lateReply of ['success', 'error']) test(`Codex queued turns ignore stale start ${lateReply}, duplicate completions and prior-turn text`, async () => {
  const output = transcript(), calls = [], entry = { after: [] }, ended = [];
  const child = new EventEmitter();
  child.exitCode = null;
  child.stdin = { destroyed: false, writableEnded: false, write: line => calls.push(JSON.parse(line)), end() { this.writableEnded = true; } };
  const session = { id: 'chat', row: {}, agent: 'codex', child, entry, project: { path: '/tmp' },
    turnStarted: id => { entry.turnPrompt = id; }, turnEnded: () => ended.push(entry.turnPrompt),
    promptOptions: () => ({ mode: 'bypassPermissions', model: 'default', effort: 'default', speed: null }) };
  const consume = codexRun({ run() {}, get() {}, change() {}, options: {}, message: (_chat, ...args) => output.say(...args),
    subagent() {}, activityFor() {}, active: new Map(), projects: {} }, session, { promptId: 'first', text: 'first', attachments: [] });
  const send = event => consume(JSON.stringify(event));
  const answer = async (method, result) => {
    const call = calls.find(call => call.method === method);
    assert.ok(call, `${method} was sent`);
    send({ id: call.id, result }); await setImmediate(); return call;
  };
  await answer('initialize', {});
  await answer('thread/start', { thread: { id: 'thread' } });
  const firstStart = calls.find(call => call.method === 'turn/start');
  send({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'first-turn' } } });
  entry.interrupt({ promptId: 'second', text: 'second', attachments: [] });
  send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'first-turn', status: 'interrupted', items: [] } } });
  send({ id: firstStart.id, ...(lateReply === 'success' ? { result: { turn: { id: 'first-turn' } } } : { error: { message: 'Late RPC failure' } }) });
  await setImmediate();
  assert.equal(entry.turnId, null);
  assert.equal(entry.failure, undefined);
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 2);
  send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'first-turn', status: 'interrupted' } } });
  send({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'first-turn', itemId: 'reply', delta: 'stale text' } });
  send({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'second-turn' } } });
  assert.equal(entry.turnId, 'second-turn');
  send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'second-turn', status: 'completed', items: [{ type: 'agentMessage', id: 'reply', text: 'Final answer' }] } } });
  assert.deepEqual(ended, ['first', 'second']);
  assert.deepEqual([...output.messages.values()], [{ role: 'assistant', text: 'Final answer' }]);
  assert.equal(entry.result.ok, true);
  child.emit('exit');
  await setImmediate();
  assert.equal(entry.result.ok, true);
});
