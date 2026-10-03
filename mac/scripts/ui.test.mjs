import test from 'node:test';
import assert from 'node:assert/strict';
import {EventDecoder, safeLink, markdown, parseActivity, summariseInput, groupMessages, activitySummary, statusLabel, relativeTime} from '../public/support.mjs';

// A tiny DOM records writes. No browser or dependency is needed to assert the trust boundary.
const fakeDoc = () => ({
  createDocumentFragment() { return this.createElement('fragment'); },
  createTextNode(value) { return {textContent:value}; },
  createElement(tag) { return {tagName:tag.toUpperCase(),children:[],append(...children) { this.children.push(...children); }}; },
});
const nodes = fragment => { const all = []; const walk = node => { all.push(node); node.children?.forEach(walk); }; walk(fragment); return all; };
const text = node => node.textContent ?? (node.children ?? []).map(text).join('');

test('SSE handles split CRLF frames, comments, multi-line data and malformed ids', () => {
  const decoder = new EventDecoder();
  assert.deepEqual(decoder.push(': ping\r\n\r'), []);
  assert.deepEqual(decoder.push('\nid: 12\r\nevent: change\r\ndata: {"seq":\r\ndata: 12}\r\n\r'), []);
  assert.deepEqual(decoder.push('\nid: bad\0id\ndata: next\n\n'), [
    {id:'12',type:'change',data:'{"seq":\n12}'},
    {id:'',type:'message',data:'next'},
  ]);
});

test('formatting allows web links and never interprets raw HTML', () => {
  assert.equal(safeLink('javascript:alert(1)'), null);
  assert.equal(safeLink('data:text/html,bad'), null);
  assert.equal(safeLink('file:///Users/me/file'), null);
  assert.equal(safeLink('https://example.org/path'), 'https://example.org/path');
  const all = nodes(markdown('<img src=x onerror=alert(1)>\n\n**bold** [unsafe](javascript:alert)\n\n```html\n<script>bad</script>\n```', fakeDoc()));
  assert.ok(all.some(node => node.textContent === '<img src=x onerror=alert(1)>'));
  assert.ok(all.some(node => node.tagName === 'STRONG' && node.textContent === 'bold'));
  assert.ok(all.some(node => node.tagName === 'CODE' && node.textContent === '<script>bad</script>'));
  assert.ok(!all.some(node => ['IMG','SCRIPT','A'].includes(node.tagName)));
});


test('markdown renders code blocks, rules, pipe tables and nested lists as text-only nodes', () => {
  const all = nodes(markdown('```kotlin\nval x = 1\n```\n\n---\n\n| Name | Value |\n| --- | :---: |\n| `a` | <b>1</b> |\n| b | 2 |\n\n- one\n  - nested\n- two\n1. first', fakeDoc()));
  const block = all.find(node => node.className === 'code-block');
  assert.equal(text(block.children[0].children[0]), 'kotlin');
  assert.ok(all.some(node => node.className === 'copy-code' && node.type === 'button'));
  assert.ok(all.some(node => node.tagName === 'CODE' && node.textContent === 'val x = 1'));
  assert.ok(all.some(node => node.tagName === 'HR'));
  const rows = all.filter(node => node.tagName === 'TR');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].children.map(text), ['Name', 'Value']);
  assert.deepEqual(rows[1].children.map(text), ['a', '<b>1</b>']);
  const lists = all.filter(node => node.tagName === 'UL');
  assert.equal(lists.length, 2);
  assert.ok(all.find(node => node.tagName === 'LI' && node.children.includes(lists[1])));
  assert.equal(all.filter(node => node.tagName === 'OL').length, 1);
});

test('activity text parses into tool uses, results and notes', () => {
  assert.deepEqual(parseActivity('Read\n{\n  "file_path": "/a/b.kt"\n}'), {kind:'tool', name:'Read', input:{file_path:'/a/b.kt'}, text:'{\n  "file_path": "/a/b.kt"\n}'});
  assert.deepEqual(parseActivity('Tool failed\nboom'), {kind:'result', failed:true, text:'boom'});
  assert.deepEqual(parseActivity('Tool result\nok\nmore'), {kind:'result', failed:false, text:'ok\nmore'});
  assert.equal(parseActivity('Permission denied for Bash').kind, 'note');
  assert.equal(parseActivity('Read\n{not json').kind, 'note');
});

test('tool input summaries prefer description, command, file name, then search fields', () => {
  assert.deepEqual(summariseInput({command:'ls', description:'List files'}), {text:'List files'});
  assert.deepEqual(summariseInput({command:'pnpm   test\n--watch'}), {text:'pnpm test --watch', title:'pnpm   test\n--watch'});
  assert.deepEqual(summariseInput({file_path:'/Users/me/app/Api.kt', old_string:'x'}), {text:'Api.kt', title:'/Users/me/app/Api.kt'});
  assert.equal(summariseInput({pattern:'fun send', path:'src'}).text, 'fun send');
  assert.equal(summariseInput({url:'https://example.org'}).text, 'https://example.org');
  assert.equal(summariseInput({todos:[]}).text, '');
  assert.equal(summariseInput({prompt:'x'.repeat(200)}).text.length, 90);
});

test('consecutive activity groups by first message id and attaches results', () => {
  const m = (id, role, text) => ({id, role, text});
  const items = groupMessages([
    m('1', 'user', 'go'),
    m('2', 'activity', 'Read\n{"file_path":"/a/Api.kt"}'), m('3', 'activity', 'Tool result\nok'),
    m('4', 'activity', 'Bash\n{"command":"pnpm test"}'), m('5', 'activity', 'Tool failed\nEADDRINUSE'),
    m('6', 'activity', 'Read\n{"file_path":"/a/b"}'), m('7', 'activity', 'Grep\n{"pattern":"x"}'),
    m('8', 'activity', 'Edit\n{"file_path":"/a/c"}'), m('9', 'activity', 'Write\n{"file_path":"/a/d"}'),
    m('10', 'activity', 'Glob\n{"pattern":"*"}'), m('11', 'assistant', 'done'), m('12', 'activity', 'Tool result\norphan'),
  ]);
  assert.deepEqual(items.map(item => item.type), ['message', 'activity', 'message', 'activity']);
  const [, group, , tail] = items;
  assert.equal(group.id, '2');
  assert.equal(group.steps.length, 7);
  assert.deepEqual(group.steps[1].result, {kind:'result', failed:true, text:'EADDRINUSE'});
  assert.deepEqual(group.steps[0].summary, {text:'Api.kt', title:'/a/Api.kt'});
  assert.deepEqual(activitySummary(group.steps), {text:'7 steps · Read, Bash, Grep, Edit, +2 more', failed:1});
  assert.deepEqual(activitySummary(tail.steps), {text:'1 step', failed:0});
});

test('status labels and relative times use plain language', () => {
  assert.equal(statusLabel('idle'), 'Ready');
  assert.equal(statusLabel('running'), 'Working');
  assert.equal(statusLabel('waiting'), 'Needs your answer');
  assert.equal(statusLabel('error'), 'Failed');
  const now = new Date(2026, 9, 2, 15, 0).getTime();
  assert.equal(relativeTime(now - 20000, now, 'en'), 'Just now');
  assert.equal(relativeTime(now - 2 * 60000, now, 'en'), '2 minutes ago');
  assert.equal(relativeTime(now - 3 * 3600000, now, 'en'), '3 hours ago');
  assert.equal(relativeTime(new Date(2026, 9, 1, 23, 0).getTime(), now, 'en'), 'Yesterday');
  assert.equal(relativeTime(new Date(2026, 8, 29, 9, 0).getTime(), now, 'en'), 'Tuesday');
  assert.equal(relativeTime(new Date(2026, 7, 14).getTime(), now, 'en'), 'Aug 14');
  assert.equal(relativeTime(new Date(2025, 7, 14).getTime(), now, 'en'), 'Aug 14, 2025');
});
