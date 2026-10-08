#!/usr/bin/env node
// Test double for the official Claude CLI in stream-json mode: catalog, usage and command handshakes, and turns
// that replay user messages, honour interrupts, take steers, run background sub-agents and read images.
import { writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const models = [
  { value: 'default', resolvedModel: 'claude-opus-test', displayName: 'Default (recommended)', description: 'Opus Test · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: efforts },
  { value: 'opus', resolvedModel: 'claude-opus-test', displayName: 'Opus Test', description: 'Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: efforts },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-test', displayName: 'Sonnet Test', description: 'Efficient for routine tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-test', displayName: 'Haiku Test', description: 'Fastest for quick answers' },
];
const commands = [
  { name: 'deploy', description: 'Ship the current branch (project)', argumentHint: '[env]' },
  { name: 'review-notes', description: 'Summarise review notes (user)', argumentHint: '' },
  { name: 'deploy', description: 'Deploy from the user scope (user)', argumentHint: '' },
  { name: 'model', description: 'Change the model', argumentHint: '', builtin: true },
];
const usage = { subscription_type: 'max', rate_limits: { limits: [
  { kind: 'session', percent: 14, severity: 'normal', resets_at: '2026-10-03T20:29:59.530335+00:00', scope: null },
  { kind: 'weekly_all', percent: 25, severity: 'normal', resets_at: '2026-10-08T12:59:59.530359+00:00', scope: null },
  { kind: 'weekly_scoped', percent: 0, severity: 'normal', resets_at: '2026-10-08T13:00:00+00:00', scope: { model: { id: null, display_name: 'Fable' } } },
] }, account: { email: 'private@example.com' } };
const textOf = message => message.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
const replay = message => { if (args.includes('--replay-user-messages')) emit({ type: 'user', uuid: message.uuid, message: { role: 'user', content: message.message.content.filter(block => block.type === 'text') } }); };
const result = (text, extra = {}) => emit({ type: 'result', subtype: 'success', result: text, is_error: false, ...extra });
const tool = (id, name, input, output, parent = null) => {
  emit({ type: 'assistant', parent_tool_use_id: parent, message: { model: parent ? 'claude-sonnet-test' : 'claude-opus-test', content: [{ type: 'tool_use', id, name, input }] } });
  emit({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] } });
};
let calls = 0, turn = null;
const inbox = [];
const nextMessage = timeout => new Promise(resolveMessage => {
  if (inbox.length) return resolveMessage(inbox.shift());
  const timer = setTimeout(() => { turn.waiter = null; resolveMessage(null); }, timeout);
  turn.waiter = message => { clearTimeout(timer); resolveMessage(message); };
});

async function run(message) {
  const prompt = textOf(message);
  if (calls++ === 0) appendFileSync('calls.ndjson', JSON.stringify({ args, prompt }) + '\n');
  turn = { interrupted: false, waiter: null };
  replay(message);
  if (prompt === 'stop-closing') {
    // Keep stdout open after the CLI exits so a prompt can arrive during run cleanup.
    spawn(process.execPath, ['-e', 'setTimeout(()=>{},2000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
    writeFileSync('closing.pid', String(process.pid)); result('Done'); process.exit(0);
  }
  if (prompt === 'thinking' || prompt === 'thinking-background') {
    emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'thought-1' } } });
    emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } });
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'First partial' } } });
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'private-signature' } } });
    emit({ type: 'assistant', message: { id: 'thought-1', content: [{ type: 'thinking', thinking: 'First thought', signature: 'private-signature' }] } });
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Late duplicate' } } });
    emit({ type: 'assistant', parent_tool_use_id: 'sub-1', message: { content: [{ type: 'thinking', thinking: 'Private subagent thought' }] } });
    emit({ type: 'assistant', message: { id: 'thought-2', content: [{ type: 'redacted_thinking', data: 'private-encrypted' }, { type: 'thinking', thinking: 'Second thought' }] } });
    const steer = await nextMessage(3000);
    if (steer) replay(steer);
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Final answer' }] } });
    if (prompt === 'thinking-background') {
      emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_type: 'local_agent' }] });
      result('Final answer'); await sleep(1000);
      emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
      emit({ type: 'system', subtype: 'init' });
    }
    return result('Final answer');
  }
  if (prompt === 'hang' || prompt === 'orphan' || prompt === 'slow') {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    writeFileSync('child.pid', String(child.pid));
    if (prompt === 'orphan') { child.unref(); return result('Done'); }
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_sleep', name: 'Bash', input: { command: 'sleep 100' } }] } });
    while (!turn.interrupted) await sleep(20);
    child.kill();
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
    return emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' });
  }
  if (prompt === 'question') {
    const response = await fetch(`${process.env.POCKETBRIDGE_INTERNAL_URL}/internal/approval`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.POCKETBRIDGE_INTERNAL_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: process.env.POCKETBRIDGE_CHAT_ID, tool: 'AskUserQuestion', input: { questions: [{ question: 'Which color?', options: [{ label: 'Blue' }, { label: 'Red' }] }] } }),
    });
    const answer = await response.json();
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(answer) }] } });
    return result('Answered');
  }
  if (prompt === 'null' || prompt === 'bad-content') { emit(prompt === 'null' ? null : { type: 'assistant', message: { content: {} } }); return result('Bad'); }
  if (prompt === 'malformed') { process.stdout.write('{garbage}\n'); return result('Bad'); }
  if (prompt === 'error' || prompt === 'empty-error') {
    process.stderr.write('Claude subscription unavailable');
    if (prompt === 'empty-error') emit({ type: 'result', result: '', errors: [], is_error: true });
    process.exit(1);
  }
  if (prompt === 'steer-wait') {
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_wait', name: 'Bash', input: { command: 'sleep 1' } }] } });
    const steer = await nextMessage(3000);
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_wait', content: '' }] } });
    if (steer) { replay(steer); emit({ type: 'assistant', message: { content: [{ type: 'text', text: `Steered: ${textOf(steer)}` }] } }); }
    return result('Steered');
  }
  if (prompt === 'subagent') {
    emit({ type: 'assistant', message: { model: 'claude-opus-test', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'Count files here', subagent_type: 'general-purpose', model: 'haiku', prompt: 'Run ls' } }] } });
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', task_type: 'local_agent', description: 'Count files here' }] });
    emit({ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_agent', description: 'Count files here', subagent_type: 'general-purpose', is_backgrounded: true, task_type: 'local_agent' });
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] } });
    emit({ type: 'system', subtype: 'task_summary', detail: 'Counting files here' });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'The agent is running.' }] } });
    result('The agent is running.');
    await sleep(50);
    tool('toolu_sub_ls', 'Bash', { command: 'ls | wc -l', description: 'Count the files' }, '2', 'toolu_agent');
    emit({ type: 'assistant', parent_tool_use_id: 'toolu_agent', message: { model: 'claude-sonnet-test', content: [{ type: 'text', text: 'There are 2 files.' }] } });
    emit({ type: 'system', subtype: 'task_progress', task_id: 't1', tool_use_id: 'toolu_agent', description: 'Running Count the files', usage: { total_tokens: 2000, tool_uses: 1 } });
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    emit({ type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_agent', status: 'completed', summary: 'Found 2 files' });
    emit({ type: 'system', subtype: 'init' });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'There are 2 files.' }] } });
    return result('There are 2 files.');
  }
  if (prompt === 'bg-shell') {
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'dev server' }, { task_id: 'm1', task_type: 'local_agent', ambient: true }] });
    return result('Started the dev server in the background.');
  }
  if (prompt === 'steer-discard') {
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_wait', name: 'Bash', input: { command: 'sleep 1' } }] } });
    const steer = await nextMessage(3000);
    if (steer) emit({ type: 'command_lifecycle', state: 'discarded', uuid: steer.uuid });
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_wait', content: '' }] } });
    return result('Finished without the steer');
  }
  if (prompt === 'steer-swallow') {
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_wait', name: 'Bash', input: { command: 'sleep 1' } }] } });
    await nextMessage(3000);
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_wait', content: '' }] } });
    return result('Took the steer without echoing it');
  }
  if (prompt === 'odd-output') {
    emit({ type: 'user', message: { content: [{ type: 'tool_result', content: 'no id' }] } });
    emit({ type: 'system', subtype: 'task_progress', tool_use_id: 42, description: 'not a string id' });
    return result('odd');
  }
  if (prompt.startsWith('image')) {
    const images = message.message.content.filter(block => block.type === 'image');
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: `images: ${images.length} ${images.map(block => `${block.source.media_type}:${block.source.data.length}`).join(' ')}` }] } });
    return result('ok');
  }
  emit({ type: 'stream_event', event: { type: 'message_start' } });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } });
  const line = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } }) + '\n';
  process.stdout.write(line.slice(0, 20)); await sleep(20); process.stdout.write(line.slice(20));
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'a.txt' } }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'contents' }] } });
  result('Hello', { usage: { input_tokens: 2, output_tokens: 12, iterations: [{ input_tokens: 1000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 500 }] }, modelUsage: { 'claude-haiku-test': { inputTokens: 5, cacheReadInputTokens: 0, contextWindow: 200000 }, 'claude-opus-test': { inputTokens: 100, cacheReadInputTokens: 9000, contextWindow: 1000000 } } });
}

let running = Promise.resolve();
emit({ type: 'system', subtype: 'init' });
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    const kind = message.request?.subtype;
    // A test can set the limits with fake-usage.json in the folder usage is asked from (the data folder).
    const limits = () => existsSync('fake-usage.json') ? { subscription_type: 'max', rate_limits: { limits: JSON.parse(readFileSync('fake-usage.json', 'utf8')) } } : usage;
    const response = kind === 'initialize' ? { models, commands, account: { email: 'private@example.com' } } : kind === 'get_usage' ? limits() : {};
    if (kind === 'interrupt' && turn) turn.interrupted = true;
    // fake-usage-delay holds milliseconds to wait before answering a usage request.
    const delay = kind === 'get_usage' && existsSync('fake-usage-delay') ? Number(readFileSync('fake-usage-delay', 'utf8')) : 0;
    const answer = () => emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } });
    if (delay) setTimeout(answer, delay); else answer();
    continue;
  }
  if (message.type !== 'user') continue;
  // A message during a turn that waits for one is a steer; otherwise it queues as the next turn, like the CLI.
  if (turn?.waiter) { turn.waiter(message); continue; }
  running = running.then(() => run(message));
}
await running;
