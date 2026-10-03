#!/usr/bin/env node
import { writeFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
if (process.argv.includes('--version')) { console.log('fake-claude'); process.exit(0); }
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
appendFileSync('calls.ndjson', JSON.stringify({ args: process.argv.slice(2), prompt }) + '\n');
emit({ type: 'system', subtype: 'init' });
if (prompt === 'hang' || prompt === 'orphan') {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  writeFileSync('child.pid', String(child.pid));
  if (prompt === 'hang') setInterval(() => {}, 1000);
  else { child.unref(); emit({ type: 'result', result: 'Done', is_error: false }); }
} else if (prompt === 'question') {
  const response = await fetch(`${process.env.POCKETBRIDGE_INTERNAL_URL}/internal/approval`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.POCKETBRIDGE_INTERNAL_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: process.env.POCKETBRIDGE_CHAT_ID, tool: 'AskUserQuestion', input: { questions: [{ question: 'Which color?', options: [{ label: 'Blue' }, { label: 'Red' }] }] } }),
  });
  const answer = await response.json();
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(answer) }] } });
  emit({ type: 'result', result: 'Answered', is_error: false });
} else if (prompt === 'null' || prompt === 'bad-content') {
  emit(prompt === 'null' ? null : { type: 'assistant', message: { content: {} } });
  emit({ type: 'result', result: 'Bad', is_error: false });
} else if (prompt === 'malformed') {
  process.stdout.write('{garbage}\n'); emit({ type: 'result', result: 'Bad', is_error: false });
} else if (prompt === 'error' || prompt === 'empty-error') {
  process.stderr.write('Claude subscription unavailable'); process.exitCode = 1;
  if (prompt === 'empty-error') emit({ type: 'result', result: '', errors: [], is_error: true });
} else {
  emit({ type: 'stream_event', event: { type: 'message_start' } });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } });
  const line = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } }) + '\n';
  process.stdout.write(line.slice(0, 20)); await new Promise(r => setTimeout(r, 20)); process.stdout.write(line.slice(20));
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a.txt' } }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', content: 'contents' }] } });
  process.stdout.write(JSON.stringify({ type: 'result', result: 'Hello', is_error: false }));
}
