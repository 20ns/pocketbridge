import test from 'node:test';
import assert from 'node:assert/strict';
import {EventDecoder, safeLink, markdown, parseActivity, summariseInput, groupMessages, activitySummary, statusLabel, relativeTime, editDraft, prepareDelivery, promptPayload, blankLocalDraft, withAttachments, slashMatches, turnPlacement, agentsFrom, usableAgent, newChatAgent, resolveOptions, supportedOptions, highlight, diffLines, resetLabel, modelName, effortName, modeHelp, liveStep, elapsedLabel} from '../public/support.mjs';

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
  assert.ok(all.some(node => node.tagName === 'CODE' && text(node) === 'val x = 1'));
  assert.ok(all.some(node => node.tagName === 'SPAN' && node.className === 'tok-keyword' && node.textContent === 'val'));
  assert.ok(all.some(node => node.tagName === 'HR'));
  const rows = all.filter(node => node.tagName === 'TR');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].children.map(text), ['Name', 'Value']);
  assert.deepEqual(rows[1].children.map(text), ['a', '<b>1</b>']);
  assert.deepEqual(rows[0].children.map(cell => cell.className), [undefined, 'align-center']);
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

test('draft delivery keeps an attempted id and its options, and sends the project only before the chat exists', () => {
  const typed = editDraft(undefined, 'hello');
  const edited = editDraft(typed, 'hello!');
  assert.equal(edited.id, typed.id);
  assert.equal(edited.attempted, false);
  const options = {agent:'codex', mode:'auto', model:'gpt-6-luna', effort:'low'};
  const pending = prepareDelivery(edited, 'hello!', options);
  assert.equal(pending.id, typed.id);
  assert.equal(pending.attempted, true);
  assert.deepEqual([pending.agent, pending.mode, pending.model, pending.effort], ['codex', 'auto', 'gpt-6-luna', 'low']);
  assert.equal(prepareDelivery(pending, 'hello!', {mode:'plan', model:'opus'}), pending);
  const changed = prepareDelivery(pending, 'different', {mode:'plan'});
  assert.notEqual(changed.id, pending.id);
  assert.deepEqual([changed.agent, changed.mode, changed.model, changed.effort], ['claude', 'plan', 'default', 'default']);
  assert.deepEqual(promptPayload(pending, 'project-1'), {id: pending.id, text: 'hello!', agent:'codex', mode: 'auto', model: 'gpt-6-luna', effort: 'low', projectId: 'project-1'});
  assert.equal('projectId' in promptPayload(pending), false);
  assert.notEqual(editDraft(pending, 'hello again').id, pending.id);
  assert.equal(editDraft(pending, 'hello!'), pending);
  assert.equal(blankLocalDraft(undefined), true);
  assert.equal(blankLocalDraft({text:'  ', attempted:false}), true);
  assert.equal(blankLocalDraft({text:'hello', attempted:false}), false);
  assert.equal(blankLocalDraft({text:'', attempted:true}), false);
});

test('model catalogs resolve to concrete choices with real names', () => {
  const claude = {id:'claude', name:'Claude', available:true, modes:['bypassPermissions', 'auto', 'plan'], defaultModel:'opus', defaultEffort:'high', models:[
    {id:'opus', name:'Opus 5.5', efforts:['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort:'high'},
    {id:'sonnet', name:'Sonnet 5.5', efforts:['low', 'medium', 'high'], defaultEffort:'high'},
    {id:'haiku', name:'Haiku 4.5', efforts:[], defaultEffort:'default'}]};
  const codex = {id:'codex', name:'Codex', available:true, modes:['bypassPermissions', 'auto', 'readOnly'], defaultModel:'gpt-6-astra', defaultEffort:'xhigh', models:[
    {id:'gpt-6-astra', name:'GPT-6-Astra', efforts:['low', 'medium', 'high', 'xhigh', 'ultra'], defaultEffort:'medium'}]};
  assert.deepEqual(resolveOptions(claude), {agent:'claude', mode:'bypassPermissions', model:'opus', effort:'high'});
  assert.deepEqual(resolveOptions(codex, {mode:'plan', model:'opus', effort:'max'}), {agent:'codex', mode:'readOnly', model:'gpt-6-astra', effort:'xhigh'});
  assert.equal(resolveOptions(claude, {mode:'readOnly'}).mode, 'plan');
  assert.equal(resolveOptions(codex, {mode:'acceptEdits'}).mode, 'auto');
  assert.equal(resolveOptions(codex, {mode:'default'}).mode, 'readOnly');
  assert.equal(resolveOptions(codex, {mode:'bypassPermissions'}).mode, 'bypassPermissions');
  assert.deepEqual(supportedOptions(claude, {agent:'claude', mode:'auto', model:'sonnet', effort:'xhigh'}).effort, 'high');
  assert.equal(supportedOptions(claude, {agent:'claude', mode:'auto', model:'haiku', effort:'max'}).effort, 'default');
  assert.equal(supportedOptions(claude, {agent:'claude', mode:'auto', model:'default', effort:'default'}).effort, 'default');
  assert.equal(resolveOptions(claude, {model:'sonnet', effort:'max'}).effort, 'high');
  assert.equal(resolveOptions(claude, {model:'haiku', effort:'max'}).effort, 'default');
  assert.equal(resolveOptions(claude, {mode:'auto', model:'sonnet', effort:'low'}).mode, 'auto');
  assert.equal(modelName(claude, 'default'), 'Opus 5.5');
  assert.equal(effortName(claude, 'default', 'default'), 'High');
  assert.equal(effortName(codex, 'gpt-6-astra', 'ultra'), 'Ultra');
  assert.equal(modeHelp('codex', 'readOnly'), 'Reads and answers. Changes nothing.');
  const legacy = agentsFrom({modes:['bypassPermissions'], models:['default', 'opus', 'haiku'], efforts:['default', 'low', 'high']});
  assert.deepEqual(legacy[0].models.map(model => [model.id, model.efforts.length]), [['opus', 2], ['haiku', 0]]);
  assert.equal(agentsFrom({agents:[codex]})[0], codex);
});

test('exact result ids pair out-of-order results and expose the running step', () => {
  const m = (id, text) => ({id, role:'activity', text});
  const items = groupMessages([m('a', 'Shell\n{"command":"sleep 9"}'), m('b', 'Shell\n{"command":"false"}'), m('b:result', 'Tool failed\nExit code 1'), m('x:result', 'Tool result\norphan')]);
  const [first, second, orphan] = items[0].steps;
  assert.equal(first.result, undefined);
  assert.equal(second.result.failed, true);
  assert.equal(orphan.kind, 'result');
  assert.equal(liveStep(items), first);
  const parallel = groupMessages([m('1', 'Read\n{"file_path":"a"}'), m('2', 'Read\n{"file_path":"b"}'), m('3', 'Tool result\nA'), m('4', 'Tool result\nB')]);
  assert.deepEqual(parallel[0].steps.map(step => step.result.text), ['A', 'B']);
  assert.equal(elapsedLabel(65_000), '1m 05s');
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

test('code highlighting tokenizes common languages without changing the text', () => {
  const kotlin = 'fun send(id: String) = "x" // retry\nval n = 42';
  const tokens = highlight(kotlin, 'kotlin');
  assert.equal(tokens.map(token => token.text).join(''), kotlin);
  const kind = text => tokens.find(token => token.text.includes(text))?.kind;
  assert.equal(kind('fun'), 'keyword'); assert.equal(kind('"x"'), 'string'); assert.equal(kind('// retry'), 'comment'); assert.equal(kind('42'), 'number'); assert.equal(kind('String'), 'type');
  const bash = highlight('echo $HOME # home', 'sh');
  assert.equal(bash.find(token => token.text === '$HOME').kind, 'variable'); assert.equal(bash.at(-1).kind, 'comment');
  const json = highlight('{"ok": true, "n": "v"}', 'json');
  assert.equal(json.find(token => token.text === '"ok"').kind, 'property'); assert.equal(json.find(token => token.text === '"v"').kind, 'string');
  assert.deepEqual(highlight('<b>x</b>', 'html'), [{text:'<b>x</b>', kind:''}]);
  assert.deepEqual(diffLines('@@ -1 +1 @@\n-a\n+b\n c').map(line => line.kind), ['hunk', 'del', 'add', '']);
});

test('usage reset times read as a countdown within a day', () => {
  const now = new Date(2026, 9, 3, 18, 0).getTime();
  assert.equal(resetLabel(now + 25 * 60000, now, 'en'), 'Resets in 25m');
  assert.equal(resetLabel(now + (2 * 60 + 24) * 60000, now, 'en'), 'Resets in 2h 24m');
  assert.match(resetLabel(new Date(2026, 9, 8, 13, 0).getTime(), now, 'en'), /^Resets Thu 1:00\s?PM$/);
  assert.equal(resetLabel(null, now), '');
});

test('agent switches decide which agent a new chat starts with', () => {
  const claude = {id:'claude', available:true, enabled:true}, codex = {id:'codex', available:true, enabled:true};
  assert.equal(newChatAgent([claude, codex], 'codex'), 'codex');
  assert.equal(newChatAgent([claude, {...codex, enabled:false}], 'codex'), 'claude');
  assert.equal(newChatAgent([{...claude, available:false}, codex], 'claude'), 'codex');
  assert.equal(newChatAgent([{...claude, enabled:false}, {...codex, enabled:false}], 'claude'), null);
  assert.equal(newChatAgent([], 'codex'), 'claude');
  assert.equal(usableAgent({id:'claude', available:true}), true);
});

test('drafts carry images, attempted deliveries keep theirs, and steer or interrupt rides along', () => {
  const draft = withAttachments(editDraft(undefined, 'look'), [{id:'u1', type:'image/png'}, {id:null, uploading:true}]);
  assert.equal(blankLocalDraft(withAttachments(undefined, [{id:'u1'}])), false);
  const sent = prepareDelivery(draft, 'look', {agent:'claude', mode:'auto'}, 'steer');
  assert.deepEqual(sent.attachments, [{id:'u1', type:'image/png'}]);
  assert.deepEqual(promptPayload(sent), {id: sent.id, text:'look', agent:'claude', mode:'auto', model:'default', effort:'default', attachments:['u1'], delivery:'steer'});
  const changed = withAttachments(sent, []);
  assert.notEqual(changed.id, sent.id); assert.equal(changed.text, 'look'); assert.equal(changed.attempted, false);
  assert.deepEqual(editDraft(sent, 'look more').attachments, [{id:'u1', type:'image/png'}]);
  assert.equal('delivery' in promptPayload(prepareDelivery(editDraft(undefined, 'x'), 'x', {})), false);
});

test('slash matches prefer name prefixes and stop at the first space', () => {
  const commands = [{name:'release', description:'Ship it'}, {name:'review-pr', description:'Review'}, {name:'unslop', description:'Release notes cleanup'}];
  assert.deepEqual(slashMatches(commands, '/re').map(command => command.name), ['release', 'review-pr', 'unslop']);
  assert.deepEqual(slashMatches(commands, '/').map(command => command.name), ['release', 'review-pr', 'unslop']);
  assert.deepEqual(slashMatches(commands, '/release now'), []);
  assert.deepEqual(slashMatches(commands, 'release'), []);
});

test('turn timing lands after the last message of each turn and sub-agents group by prompt', () => {
  const m = (id, role) => ({id, role, text:id});
  const messages = [m('p1', 'user'), m('a', 'assistant'), m('s', 'user'), m('b', 'assistant'), m('p2', 'user'), m('c', 'activity')];
  const turns = [{id:'p1', startedAt:0, endedAt:5000}, {id:'p2', startedAt:6000, endedAt:null}];
  const {ends, agents} = turnPlacement(messages, turns, [{id:'x', promptId:'p1'}, {id:'y', promptId:'p1'}]);
  assert.deepEqual([...ends.keys()], [3, 5]);
  assert.equal(ends.get(3).endedAt, 5000);
  assert.equal(agents.get('p1').length, 2);
});
