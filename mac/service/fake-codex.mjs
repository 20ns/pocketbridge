#!/usr/bin/env node
// Test double for the official Codex CLI app-server: catalogs with speed tiers, usage with banked resets and their
// redemption, skills and session lists, and scripted turns with streaming replies, tools, sub-agents, steering,
// interrupts and image input. FAKE_CODEX_VERSION makes a newer copy that also lists gpt-test-nova;
// FAKE_CODEX_LIST_DELAY_MS makes model/list slow.
import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
const note = (method, params) => emit({ method, params });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const version = process.env.FAKE_CODEX_VERSION ?? '0.150.0';
if (args.includes('--version')) { console.log(`codex-cli ${version}`); process.exit(0); }
if (args[0] !== 'app-server') { console.error('fake codex only speaks app-server'); process.exit(2); }
const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort }));
const log = entry => appendFileSync('codex-calls.ndjson', JSON.stringify({ ...entry, version }) + '\n');
const fast = [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }];
// Banked resets and per-thread speed tiers outlive one app-server process, as they do for the real account and threads.
const load = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const resetsFile = 'codex-resets.json', threadsFile = 'codex-threads.json';
const resets = () => load(resetsFile, { reset: false, keys: {}, credits: [
  { id: 'credit-a', resetType: 'codexRateLimits', status: 'available', grantedAt: 1790000000, expiresAt: 1792702115, title: 'Full reset', description: 'One free rate limit reset.' },
  { id: 'credit-b', resetType: 'codexRateLimits', status: 'available', grantedAt: 1790100000, expiresAt: null, title: null, description: null },
  { id: 'credit-old', resetType: 'codexRateLimits', status: 'redeemed', grantedAt: 1780000000, expiresAt: null, title: 'Used', description: null },
] });
const tiers = () => load(threadsFile, {});
const saveTier = (threadId, tier) => writeFileSync(threadsFile, JSON.stringify({ ...tiers(), [threadId]: tier ?? null }));
let thread = null, turn = null;
const item = (id, type, fields) => ({ id, type, ...fields });
async function runTurn(threadId, input, turnId) {
  const text = input.filter(part => part.type === 'text').map(part => part.text).join('\n');
  turn = { id: turnId, interrupted: false, steer: null };
  note('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
  const done = (status = 'completed', error = null) => { note('turn/completed', { threadId, turn: { id: turnId, status, error } }); turn = null; };
  const command = (id, cmd, output, exitCode = 0) => {
    note('item/started', { threadId, turnId, item: item(id, 'commandExecution', { command: cmd, aggregatedOutput: '', exitCode: null, status: 'inProgress' }) });
    return () => note('item/completed', { threadId, turnId, item: item(id, 'commandExecution', { command: cmd, aggregatedOutput: output, exitCode, status: exitCode ? 'failed' : 'completed' }) });
  };
  const say = (id, words) => {
    note('item/started', { threadId, turnId, item: item(id, 'agentMessage', { text: '' }) });
    for (const word of words) note('item/agentMessage/delta', { threadId, turnId, itemId: id, delta: word });
    note('item/completed', { threadId, turnId, item: item(id, 'agentMessage', { text: words.join('') }) });
  };
  if (text === 'thinking') {
    note('item/reasoning/summaryTextDelta', { threadId, turnId, itemId: 'thought', summaryIndex: 0, delta: 'First partial' });
    note('item/reasoning/summaryTextDelta', { threadId: 'sub-thread', turnId, itemId: 'sub-thought', summaryIndex: 0, delta: 'Private subagent thought' });
    note('item/completed', { threadId, turnId, item: item('thought', 'reasoning', { summary: ['First thought', 'Second thought'], content: ['Raw equivalent'] }) });
    for (let waited = 0; waited < 3000 && !turn.steer && !turn.interrupted; waited += 20) await sleep(20);
    if (turn.interrupted) return done('interrupted');
    say('answer', ['Final answer']); return done();
  }
  if (text === 'hang') {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    writeFileSync('codex-child.pid', String(child.pid));
    command('cmd_sleep', "/bin/zsh -lc 'sleep 100'", '');
    while (!turn.interrupted) await sleep(20);
    child.kill(); return done('interrupted');
  }
  if (text === 'stop-queue') {
    command('cmd_queue', 'waiting for interrupt', '');
    while (!turn.interrupted) await sleep(20);
    await sleep(200); return done('interrupted');
  }
  if (text === 'fail') {
    note('error', { error: { message: 'Reconnecting... 1/5' }, willRetry: true });
    return done('failed', { message: 'Codex usage limit reached' });
  }
  if (text === 'steer-exit') { turn.exitOnSteer = true; command('cmd_wait', "/bin/zsh -lc 'sleep 1'", ''); return; }
  if (text === 'steer-wait') {
    const finish = command('cmd_wait', "/bin/zsh -lc 'sleep 1'", '');
    for (let waited = 0; waited < 3000 && !turn.steer; waited += 20) await sleep(20);
    finish();
    if (turn.steer) say('msg_steer', ['Steered: ', turn.steer]);
    return done();
  }
  if (text === 'subagent') {
    const spawnCall = { tool: 'spawnAgent', senderThreadId: threadId, receiverThreadIds: ['sub-1'], prompt: 'Count files\nthen report', model: 'gpt-test-luna', reasoningEffort: 'low', status: 'inProgress', agentsStates: { 'sub-1': { status: 'running', message: null } } };
    note('item/started', { threadId, turnId, item: item('collab_1', 'collabAgentToolCall', spawnCall) });
    note('item/completed', { threadId, turnId, item: item('collab_1', 'collabAgentToolCall', { ...spawnCall, status: 'completed' }) });
    note('item/completed', { threadId, turnId, item: item('collab_2', 'collabAgentToolCall', { tool: 'wait', senderThreadId: threadId, receiverThreadIds: ['sub-1'], status: 'completed', agentsStates: { 'sub-1': { status: 'completed', message: 'Found 2 files' } } }) });
    say('msg_sub', ['Sub-agent found 2 files.']);
    return done();
  }
  if (text === 'foreign') {
    note('turn/completed', { threadId: 'some-other-thread', turn: { id: 'other-turn', status: 'completed', error: null } });
    note('item/started', { threadId: 'some-sub-thread', turnId: 'x', item: item('sub', 'commandExecution', { command: 'ls' }) });
    say('msg_foreign', ['Codex says foreign']);
    return done();
  }
  if (text.startsWith('image')) {
    const images = input.filter(part => part.type === 'localImage');
    say('msg_image', [`images: ${images.length}`]);
    return done();
  }
  if (input[0]?.type === 'skill') { say('msg_skill', [`skill ${input[0].name} at ${input[0].path}`]); return done(); }
  const echo = command('item_0', "/bin/zsh -lc 'echo it'\\''s ok'", "it's ok\n");
  const fail = command('item_1', '/bin/zsh -lc false', '', 1);
  fail(); echo();
  note('item/completed', { threadId, turnId, item: item('item_2', 'fileChange', { changes: [{ path: 'a.txt', kind: { type: 'add' } }], status: 'completed' }) });
  note('item/completed', { threadId, turnId, item: item('item_r', 'reasoning', { summary: ['thinking'] }) });
  note('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: { inputTokens: 40000, outputTokens: 2000 }, total: {}, modelContextWindow: 400000 } });
  say('item_3', ['Codex ', `says ${text}`]);
  done();
}
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  const reply = result => emit({ id: message.id, result });
  const params = message.params ?? {};
  switch (message.method) {
    case 'initialize': reply({ userAgent: 'fake' }); break;
    case 'model/list': setTimeout(reply, Number(process.env.FAKE_CODEX_LIST_DELAY_MS ?? 0), { data: [
      ...(process.env.FAKE_CODEX_VERSION ? [{ id: 'gpt-test-nova', model: 'gpt-test-nova', displayName: 'GPT-Test-Nova', description: 'Newest', hidden: false, isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: efforts, serviceTiers: fast, additionalSpeedTiers: ['fast'] }] : []),
      { id: 'gpt-test-astra', model: 'gpt-test-astra', displayName: 'GPT-Test-Astra', description: 'Frontier', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: efforts, serviceTiers: fast, additionalSpeedTiers: ['fast'] },
      { id: 'gpt-test-luna', model: 'gpt-test-luna', displayName: 'GPT-Test-Luna', description: 'Fast', hidden: false, isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: efforts.slice(0, 3) },
      { id: 'gpt-hidden', model: 'gpt-hidden', displayName: 'Hidden', description: '', hidden: true, isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: efforts },
    ], nextCursor: null }); break;
    case 'config/read': reply({ config: { model: 'not-listed', model_reasoning_effort: 'xhigh' } }); break;
    case 'account/rateLimits/read': {
      const banked = resets(), available = banked.credits.filter(credit => credit.status === 'available');
      reply({ rateLimits: { planType: 'prolite', primary: { usedPercent: banked.reset ? 0 : 39, windowDurationMins: 10080, resetsAt: 1791580292 }, secondary: { usedPercent: banked.reset ? 0 : 92, windowDurationMins: 300, resetsAt: 1791000000 }, credits: { hasCredits: true, unlimited: false, balance: '2353.7232000000' } },
        rateLimitResetCredits: { availableCount: available.length, credits: banked.credits } });
      break;
    }
    case 'account/rateLimitResetCredit/consume': {
      log({ method: message.method, params });
      const banked = resets(), key = params.idempotencyKey;
      if (typeof key !== 'string' || !key) { emit({ id: message.id, error: { code: -32602, message: 'idempotencyKey is required' } }); break; }
      if (params.creditId && params.creditId !== 'nothing' && !banked.credits.some(credit => credit.id === params.creditId)) { emit({ id: message.id, error: { code: -32600, message: 'Unknown reset credit' } }); break; }
      let outcome = banked.keys[key] ? 'alreadyRedeemed' : null;
      const credit = banked.credits.find(item => item.status === 'available' && (!params.creditId || item.id === params.creditId));
      if (!outcome) outcome = params.creditId === 'nothing' ? 'nothingToReset' : credit ? 'reset' : 'noCredit';
      if (outcome === 'reset') { credit.status = 'redeemed'; banked.reset = true; banked.keys[key] = credit.id; }
      writeFileSync(resetsFile, JSON.stringify(banked));
      reply({ outcome }); break;
    }
    case 'skills/list': reply({ data: [{ cwd: params.cwds?.[0], errors: [], skills: [{ name: 'ship-it', description: 'Long description', shortDescription: 'Ship the build', path: '/skills/ship-it/SKILL.md', enabled: true, scope: 'repo' }, { name: 'off', description: 'Disabled', path: '/skills/off', enabled: false, scope: 'repo' }, { name: 'ship-it', description: 'User copy', path: '/user/ship-it/SKILL.md', enabled: true, scope: 'user' }] }] }); break;
    case 'thread/list': reply({ data: [
      { id: 'codex-thread-1', name: 'Fix the login page', preview: 'Make the login page load faster', updatedAt: 1791000000, cwd: params.cwd, threadSource: 'user' },
      { id: 'codex-thread-1', name: 'Fix the login page', preview: 'duplicate entry', updatedAt: 1790000000, cwd: params.cwd },
      { id: 'codex-sub', name: 'helper', preview: 'subagent', updatedAt: 1791000001, cwd: params.cwd, parentThreadId: 'codex-thread-1' },
    ], nextCursor: null }); break;
    case 'thread/turns/list': reply({ data: params.threadId === 'codex-thread-1' ? [{ id: 't9', status: 'completed', items: [
      { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Make the login page load faster' }] },
      { id: 'a0', type: 'agentMessage', text: 'Looking.' }, { id: 'c1', type: 'commandExecution', command: 'ls' },
      { id: 'a1', type: 'agentMessage', text: 'Login now loads in 300 ms.' },
    ] }] : [], nextCursor: null }); break;
    case 'thread/start': case 'thread/resume': case 'thread/fork':
      await sleep(Number(process.env.FAKE_CODEX_THREAD_DELAY_MS ?? 0));
      thread = message.method === 'thread/resume' ? params.threadId : randomUUID();
      log({ method: message.method, params });
      reply({ thread: { id: thread }, serviceTier: tiers()[thread] ?? null }); break;
    case 'turn/start':
      log({ method: 'turn/start', params });
      if ('serviceTier' in params) saveTier(params.threadId, params.serviceTier);
      { const turnId = randomUUID(); reply({ turn: { id: turnId, status: 'inProgress' } }); runTurn(params.threadId, params.input ?? [], turnId); }
      break;
    case 'turn/steer':
      if (turn?.exitOnSteer) { log({ method: 'turn/steer', params }); process.exit(1); }
      if (!turn) { emit({ id: message.id, error: { code: -32600, message: 'no active turn' } }); break; }
      turn.steer = (params.input ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      log({ method: 'turn/steer', params });
      reply({ turnId: turn.id }); break;
    case 'turn/interrupt': if (turn) turn.interrupted = true; reply({}); break;
    default: if (message.id !== undefined) emit({ id: message.id, error: { code: -32601, message: 'unknown' } });
  }
}
