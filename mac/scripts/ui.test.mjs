import test from 'node:test';
import assert from 'node:assert/strict';
import {EventDecoder, mergeTranscript, safeLink, markdown, parseActivity, summariseInput, groupMessages, activitySummary, statusLabel, relativeTime, editDraft, prepareDelivery, afterDelivery, promptPayload, blankLocalDraft, withAttachments, slashMatches, turnPlacement, agentsFrom, usableAgent, newChatAgent, resolveOptions, supportedOptions, highlight, diffLines, resetLabel, modelName, effortName, modeHelp, liveStep, elapsedLabel, modelSpeeds, speedName, effortLabel, weeklyLimit, headlineLimit, usageRings, nextCredit, resetAttempt, settleReset, resetPrompt, resetOutcomes, hashIndex, projectTone, projectTones, avatarLetter, projectNameProblem, newProjectAttempt, unknownResult, settleProjectAttempt, projectChoices} from '../public/support.mjs';

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
  assert.deepEqual(group.steps[1].result, {id:'5', kind:'result', failed:true, text:'EADDRINUSE'});
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
  assert.deepEqual(promptPayload(pending, 'project-1'), {id: pending.id, text: 'hello!', agent:'codex', mode: 'auto', model: 'gpt-6-luna', effort: 'low', speed: null, projectId: 'project-1'});
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
  assert.deepEqual(resolveOptions(claude), {agent:'claude', mode:'bypassPermissions', model:'opus', effort:'high', speed:null});
  assert.deepEqual(resolveOptions(codex, {mode:'plan', model:'opus', effort:'max'}), {agent:'codex', mode:'readOnly', model:'gpt-6-astra', effort:'xhigh', speed:null});
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
  assert.equal(modelName({...claude, defaultModel:'gone'}, 'default'), claude.models[0].name);
  assert.equal(modelName({id:'codex', name:'Codex', models:[], defaultModel:'default'}, 'default'), 'Codex');
  assert.equal(modelName(undefined, 'default'), 'Claude');
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
  assert.deepEqual(promptPayload(sent), {id: sent.id, text:'look', agent:'claude', mode:'auto', model:'default', effort:'default', speed:null, attachments:['u1'], delivery:'steer'});
  const changed = withAttachments(sent, []);
  assert.notEqual(changed.id, sent.id); assert.equal(changed.text, 'look'); assert.equal(changed.attempted, false);
  assert.deepEqual(editDraft(sent, 'look more').attachments, [{id:'u1', type:'image/png'}]);
  assert.equal('delivery' in promptPayload(prepareDelivery(editDraft(undefined, 'x'), 'x', {})), false);
});

test('a retry keeps its id only for the same delivery, and sent images leave the next draft', () => {
  const sent = prepareDelivery(withAttachments(editDraft(undefined, 'look'), [{id:'u1', type:'image/png'}]), 'look', {agent:'claude', mode:'auto'}, 'steer');
  assert.equal(prepareDelivery(sent, 'look', {}, 'steer'), sent);
  const now = prepareDelivery(sent, 'look', {agent:'claude', mode:'auto'}, 'interrupt');
  assert.notEqual(now.id, sent.id);
  assert.equal(promptPayload(now).delivery, 'interrupt');
  assert.deepEqual(now.attachments, [{id:'u1', type:'image/png'}]);
  // Typing while the send is in flight forks a draft; once the send lands, its images aren't sent again.
  const typed = withAttachments(editDraft(sent, 'look more'), [{id:'u1', type:'image/png'}, {id:'u2', type:'image/png'}, {key:'k', uploading:true}]);
  assert.deepEqual(afterDelivery(typed, sent).attachments, [{id:'u2', type:'image/png'}, {key:'k', uploading:true}]);
  assert.equal(afterDelivery(typed, sent).text, 'look more');
  assert.equal(afterDelivery(sent, sent), null);
  assert.equal(afterDelivery(undefined, sent), null);
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

test('a named tool result after a steer joins its command in the earlier group', () => {
  const items = groupMessages([
    {id: 'c2', role: 'activity', text: 'Shell\n{"command":"pnpm test"}'},
    {id: 'n1', role: 'assistant', text: 'Noted: use staging.'},
    {id: 'c2:result', role: 'activity', text: 'Tool result\nok'},
    {id: 'f1', role: 'activity', text: 'Edit\n{"file_path":"src/http.ts"}'},
  ]);
  assert.deepEqual(items.map(item => item.type), ['activity', 'message', 'activity']);
  assert.equal(items[0].steps[0].result.id, 'c2:result');
  assert.deepEqual(items[2].steps.map(step => step.id), ['f1']);
});

test('the speed tier comes from the catalog, follows the model and is fixed with the delivery id', () => {
  const fast = {id:'priority', name:'Fast', description:'1.5x speed, increased usage'};
  const codex = {id:'codex', name:'Codex', available:true, modes:['bypassPermissions', 'auto', 'readOnly'], defaultModel:'gpt-6-astra', defaultEffort:'medium', models:[
    {id:'gpt-6-astra', name:'GPT-6-Astra', efforts:['low', 'medium'], defaultEffort:'medium', speeds:[fast]},
    {id:'gpt-6-luna', name:'GPT-6-Luna', efforts:['low', 'medium'], defaultEffort:'medium', speeds:[]}]};
  assert.equal(resolveOptions(codex, {model:'gpt-6-astra', speed:'priority'}).speed, 'priority');
  // Switching to a model without the tier drops it; an unknown tier is never sent.
  assert.equal(resolveOptions(codex, {model:'gpt-6-luna', speed:'priority'}).speed, null);
  assert.equal(resolveOptions(codex, {model:'gpt-6-astra', speed:'warp'}).speed, null);
  assert.equal(supportedOptions(codex, {agent:'codex', mode:'auto', model:'gpt-6-luna', effort:'low', speed:'priority'}).speed, null);
  const kept = {agent:'codex', mode:'auto', model:'gpt-6-astra', effort:'low', speed:'priority'};
  assert.equal(supportedOptions(codex, kept), kept);
  assert.deepEqual(modelSpeeds(codex, 'gpt-6-astra'), [fast]);
  assert.deepEqual(modelSpeeds(codex, 'gpt-6-luna'), []);
  assert.equal(speedName(fast), 'Fast');
  assert.equal(speedName({id:'priority', name:''}), 'Fast');
  assert.equal(speedName({id:'turbo', name:'Turbo'}), 'Turbo');
  assert.equal(effortLabel('ultra'), 'Ultra');
  assert.equal(effortLabel('galactic'), 'Galactic');

  const pending = prepareDelivery(editDraft(undefined, 'go'), 'go', kept, 'steer');
  assert.equal(pending.speed, 'priority');
  assert.equal(promptPayload(pending).speed, 'priority');
  // A retry repeats the attempted delivery even if the toggle has since been turned off.
  assert.equal(prepareDelivery(pending, 'go', {...kept, speed:null}, 'steer'), pending);
  assert.equal(promptPayload(prepareDelivery(pending, 'go', {...kept, speed:null}, 'steer')).speed, 'priority');
  // Standard speed is sent explicitly; a draft attempted before speeds existed leaves the chat's value alone.
  assert.equal(promptPayload(prepareDelivery(undefined, 'x', {agent:'codex', mode:'auto'})).speed, null);
  const legacy = {id:'d1', text:'x', agent:'codex', mode:'auto', model:'gpt-6-astra', effort:'low', attempted:true};
  assert.equal('speed' in promptPayload(legacy), false);
});

test('the header shows each enabled agent\'s fullest weekly window', () => {
  const claude = {id:'claude', name:'Claude', limits:[
    {id:'session', label:'5-hour session', percent:80, window:'session'},
    {id:'weekly_all', label:'Weekly', percent:61, window:'weekly'},
    {id:'weekly_scoped:Fable', label:'Weekly · Fable', percent:12, window:'weekly'}]};
  const codex = {id:'codex', name:'Codex', limits:[{id:'primary', label:'5-hour', percent:90, window:'session'}, {id:'secondary', label:'Weekly', percent:39, window:'weekly'}]};
  const off = {id:'codex', name:'Codex', limits:[]};
  assert.deepEqual(usageRings([claude, codex]).map(ring => [ring.id, ring.limit.percent]), [['claude', 61], ['codex', 39]]);
  assert.deepEqual(usageRings([claude, off]).map(ring => ring.id), ['claude']);
  // An older Mac has no window field: the label names the weekly window. No weekly window shows the fullest one.
  assert.equal(weeklyLimit({id:'primary', label:'Weekly'}), true);
  assert.equal(weeklyLimit({id:'weekly', label:'x', window:'other'}), false);
  assert.equal(headlineLimit([{id:'a', label:'5-hour', percent:20}, {id:'b', label:'Monthly', percent:70}]).id, 'b');
  assert.equal(headlineLimit([]), null);
});

test('Codex resets use the soonest-expiring credit and one idempotency key per attempt', () => {
  const resets = {available:3, credits:[{id:'c-late', expiresAt:2000}, {id:'c-none', expiresAt:null}, {id:'c-soon', expiresAt:1000}]};
  assert.equal(nextCredit(resets).id, 'c-soon');
  assert.equal(nextCredit({available:0, credits:[]}), null);
  assert.equal(nextCredit(null), null);
  const attempt = resetAttempt(null, 'c-soon');
  assert.match(attempt.id, /^[0-9a-f-]{36}$/);
  assert.equal(attempt.creditId, 'c-soon');
  // A lost answer or a timeout keeps the attempt, so the retry sends the same key.
  for (const error of [new Error('timeout'), Object.assign(new Error('x'), {status:408}), Object.assign(new Error('x'), {status:504})]) {
    const kept = settleReset(attempt, error);
    assert.equal(kept, attempt);
    assert.equal(resetAttempt(kept, 'c-late').id, attempt.id);
  }
  // A definite answer, success or refusal, ends it; the next reset is a new attempt with a new key.
  assert.equal(settleReset(attempt, null), null);
  assert.equal(settleReset(attempt, Object.assign(new Error('Codex is off'), {status:409})), null);
  // Codex refusing (for example an unknown credit) comes back as a 502 with its message: that is an answer too.
  assert.equal(settleReset(attempt, Object.assign(new Error('Unknown reset credit'), {status:502})), null);
  assert.equal(settleReset(attempt, Object.assign(new Error('Internal service error'), {status:500})), null);
  assert.notEqual(resetAttempt(null, 'c-soon').id, attempt.id);
  assert.equal(resetPrompt(3), 'Use 1 of 3 resets? Resets your Codex limits now.');
  assert.equal(resetPrompt(1), 'Use 1 of 1 reset? Resets your Codex limits now.');
  assert.deepEqual(Object.keys(resetOutcomes), ['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']);
});

test('project colours are stable, spread across the palette and letters fall back sensibly', () => {
  const ids = Array.from({length: 64}, (_, index) => `project-${index}`);
  assert.equal(projectTone('4b7929fa-9d59-41fd-9427-9b82d34a51a8'), projectTone('4b7929fa-9d59-41fd-9427-9b82d34a51a8'));
  assert.ok(ids.every(id => projectTone(id) >= 0 && projectTone(id) < projectTones));
  assert.ok(new Set(ids.map(projectTone)).size >= 6);
  assert.equal(hashIndex('', 8), hashIndex('', 8));
  assert.equal(avatarLetter('pocketBridge'), 'P');
  assert.equal(avatarLetter('  _my app'), 'M');
  assert.equal(avatarLetter('édition'), 'É');
  assert.equal(avatarLetter(''), '?');
});

test('new project names follow the Mac\'s folder rule and a retry reuses the attempt id', () => {
  for (const name of ['my-idea', 'Garden sensors 2', 'v1.2_test', 'Ünïcode']) assert.equal(projectNameProblem(name), null, name);
  assert.equal(projectNameProblem('  '), 'Enter a name');
  assert.equal(projectNameProblem('x'.repeat(65)), 'Use at most 64 characters');
  for (const name of ['.hidden', 'trailing.', 'a/b', '../up', '-dash-first', 'semi;colon']) assert.match(projectNameProblem(name), /^Use letters/, name);
  assert.equal(projectNameProblem('ends with space '), null, 'surrounding spaces are trimmed like the Mac does');
  const first = newProjectAttempt(null, 'my-idea');
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.equal(newProjectAttempt(first, 'my-idea'), first);
  assert.notEqual(newProjectAttempt(first, 'other').id, first.id);
  assert.equal(unknownResult(new Error('offline')), true);
  assert.equal(unknownResult(Object.assign(new Error('x'), {status: 504})), true);
  assert.equal(unknownResult(Object.assign(new Error('exists'), {status: 409})), false);
  assert.equal(unknownResult(null), false);
  // Creation may have happened on any 5xx or lost answer: keep the id. A 4xx answer made nothing: start over.
  const failed = status => Object.assign(new Error('x'), status ? {status} : {});
  for (const status of [undefined, 408, 500, 502, 503, 504]) assert.equal(settleProjectAttempt(first, failed(status)), first, String(status));
  for (const status of [400, 401, 404, 409]) assert.equal(settleProjectAttempt(first, failed(status)), null, String(status));
  assert.equal(settleProjectAttempt(first, null), null);
});

test('General is kept apart from the project folders, and older Macs have none', () => {
  const general = {id:'g', name:'General', path:'/Users/me', general:true}, app = {id:'a', name:'App'}, site = {id:'s', name:'Site'};
  assert.deepEqual(projectChoices([app, general, site]), {general, folders:[app, site]});
  assert.deepEqual(projectChoices([app, site]), {general:null, folders:[app, site]});
  assert.deepEqual(projectChoices(), {general:null, folders:[]});
});


test('transcript deltas update rows in place, append late results and clear metadata', () => {
  const old = {messages:[{id:'tool'}, {id:'reply', text:'Partial'}, {id:'steer'}], thinking:'Working'};
  const next = mergeTranscript(old, {full:false, cursor:'next', messages:[{id:'reply', text:'Complete'}, {id:'tool:result'}], thinking:null});
  assert.deepEqual(next.messages.map(row => row.id), ['tool', 'reply', 'steer', 'tool:result']);
  assert.equal(next.messages[1].text, 'Complete');
  assert.equal(next.thinking, null);
  assert.equal(old.messages[1].text, 'Partial');
  const full = {full:true, messages:[]};
  assert.equal(mergeTranscript(next, full), full);
  const legacy = {messages:[]};
  assert.equal(mergeTranscript(null, legacy), legacy);
  assert.throws(() => mergeTranscript(null, {full:false, messages:[]}));
});
