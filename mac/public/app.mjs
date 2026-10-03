import {EventDecoder, markdown, resetLabel, withAttachments, slashMatches, turnPlacement, statusLabel, relativeTime, groupMessages, activitySummary, editDraft, prepareDelivery, promptPayload, blankLocalDraft, agentsFrom, usableAgent, newChatAgent, findModel, resolveOptions, supportedOptions, modeLabels, effortLabels, modeHelp, modelName, effortName, liveStep, elapsedLabel} from './support.mjs';

const $ = id => document.getElementById(id);
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const liveText = {idle:'Finished. Ready for your next message.', running:'Working.', waiting:'Needs your answer.', stopping:'Stopping.', interrupted:'Work stopped.', error:'This turn failed.'};
let token, state, selected, online = false, sending = false, seq = 0, refreshTimer, streamController, pairLink, qrUrl;
let pendingRefresh = false, refreshing = false, messagesGeneration = 0, agents = [];
let approvalsSignature = null, announced = {};
const saved = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const persist = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage may be disabled; the live session still works. */ } };
function persistLocalChats() {
  const stored = {};
  for (const [id, chat] of Object.entries(localChats)) if (!blankLocalDraft(drafts[id])) stored[id] = chat;
  persist('pocketbridge.localChats', stored);
}
function discardBlankLocal(id) {
  if (!id || !localChats[id] || !blankLocalDraft(drafts[id])) return;
  delete localChats[id]; delete drafts[id];
  persistLocalChats(); persist('pocketbridge.drafts', drafts);
}
// Images still uploading when the page closed are dropped; finished ones are kept by id.
let drafts = Object.fromEntries(Object.entries(saved('pocketbridge.drafts', {})).map(([id, draft]) => [id, {...draft, attachments: (draft.attachments ?? []).filter(item => item.id).map(({id: uploadId, type}) => ({id: uploadId, type}))}]));
let localChats = saved('pocketbridge.localChats', {});
let preferredProject = saved('pocketbridge.project', '');
// Options for the next prompt of a saved chat, and the last choice per agent for new chats.
let overrides = saved('pocketbridge.options', {});
let lastOptions = saved('pocketbridge.lastOptions', {});
let lastAgent = saved('pocketbridge.lastAgent', 'claude');
selected = saved('pocketbridge.chat', null);

function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
function connection(connected, text) {
  online = connected;
  $('connection').dataset.state = connected ? 'online' : 'offline';
  $('connection-text').textContent = text;
  controls();
}
async function api(path, body) {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials:'same-origin', cache:'no-store',
    headers: {...(token ? {Authorization:`Bearer ${token}`} : {}), ...(body === undefined ? {} : {'Content-Type':'application/json'})},
    body: body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(15000),
  });
  // A rotated local token (for example after resetting the Mac's data) is re-fetched by the reconnect loop.
  if (response.status === 401) token = null;
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || `Mac returned ${response.status}`), {status: response.status});
  return result;
}
function currentChat() { return state?.chats.find(chat => chat.id === selected) ?? localChats[selected]; }
function projectName(chat) { return state?.projects.find(p => p.id === chat.projectId)?.name ?? 'Project'; }
const agentFor = id => agents.find(agent => agent.id === (id || 'claude'));
const agentName = chat => agentFor(chat?.agent)?.name ?? 'Claude';
const sameOptions = (a, b) => ['agent', 'mode', 'model', 'effort'].every(key => (a?.[key] ?? '') === (b?.[key] ?? ''));
const savedOptions = chat => ({agent: chat.agent || 'claude', mode: chat.mode, model: chat.model || 'default', effort: chat.effort || 'default'});
/** The open chat's next-prompt options. An attempted delivery keeps the options it was sent with. */
function chatOptions(chat = currentChat()) {
  if (!chat) return null;
  const attempted = drafts[chat.id]?.attempted ? drafts[chat.id] : null;
  if (attempted?.mode) return {agent: attempted.agent ?? chat.agent ?? 'claude', mode: attempted.mode, model: attempted.model, effort: attempted.effort};
  const options = localChats[chat.id] ? savedOptions(localChats[chat.id]) : overrides[chat.id] ?? savedOptions(chat);
  const agent = agentFor(options.agent);
  return agent ? supportedOptions(agent, options) : options;
}
function setOptions(next) {
  const chat = currentChat(); if (!chat) return;
  if (localChats[chat.id]) { Object.assign(localChats[chat.id], next); persistLocalChats(); }
  else { if (sameOptions(next, savedOptions(chat))) delete overrides[chat.id]; else overrides[chat.id] = next; persist('pocketbridge.options', overrides); }
  lastOptions[next.agent] = next; lastAgent = next.agent;
  persist('pocketbridge.lastOptions', lastOptions); persist('pocketbridge.lastAgent', lastAgent);
  renderOptions(); controls();
}
function renderOptions() {
  const chat = currentChat(), options = chatOptions(chat);
  for (const id of ['model', 'effort', 'mode']) $(id).replaceChildren();
  document.querySelector('.options').hidden = !options;
  if (!options) return;
  const agent = agentFor(options.agent) ?? {id: options.agent, name: options.agent, modes: [options.mode], models: [], defaultModel: options.model, defaultEffort: options.effort};
  // A chat that hasn't reached the Mac can still move to another agent; a saved one keeps its CLI.
  const unsent = !state?.chats.some(item => item.id === chat.id) && !drafts[chat.id]?.attempted;
  const choices = unsent ? agents.filter(item => usableAgent(item) && item.models.length) : [agent];
  const current = findModel(agent, options.model);
  for (const entry of choices.length ? choices : [agent]) {
    const group = choices.length > 1 ? Object.assign(document.createElement('optgroup'), {label: entry.name}) : $('model');
    if (group !== $('model')) $('model').append(group);
    for (const model of entry.models) { const option = new Option(model.name, `${entry.id}|${model.id}`); option.title = model.description ?? ''; group.append(option); }
  }
  if (!current) $('model').append(new Option(modelName(agent, options.model), `${agent.id}|${options.model}`));
  $('model').value = `${agent.id}|${current?.id ?? options.model}`;
  $('model').title = current?.description ?? '';
  const efforts = current ? current.efforts : [options.effort];
  // Older chats saved "default"; show the level that applies until another is chosen.
  const shownEffort = options.effort !== 'default' ? options.effort : efforts.includes(agent.defaultEffort) ? agent.defaultEffort : current?.defaultEffort ?? 'default';
  for (const effort of efforts.includes(shownEffort) ? efforts : [shownEffort, ...efforts]) $('effort').append(new Option(effort === shownEffort && options.effort === 'default' ? effortName(agent, options.model, 'default') : effortLabels[effort] ?? effort, effort));
  $('effort').value = shownEffort; $('effort').hidden = Boolean(current) && !current.efforts.length;
  for (const mode of agent.modes.includes(options.mode) ? agent.modes : [options.mode, ...agent.modes]) { const option = new Option(modeLabels[mode] ?? mode, mode); option.title = modeHelp(agent.id, mode); $('mode').append(option); }
  $('mode').value = options.mode; $('mode').title = modeHelp(agent.id, options.mode);
  $('prompt').placeholder = `Message ${agent.name}`;
}
function busy(chat = currentChat()) { return ['running','stopping','waiting'].includes(chat?.status); }
function statusBadge(status) {
  const badge = el('span', 'status'); badge.dataset.status = status ?? 'idle';
  badge.append(el('span', 'status-dot'), el('span', '', statusLabel(status)));
  badge.firstChild.setAttribute('aria-hidden', 'true');
  return badge;
}
function autosize() {
  const prompt = $('prompt');
  prompt.style.height = 'auto';
  prompt.style.height = `${prompt.scrollHeight + 2}px`;
}
function controls() {
  const chat = currentChat();
  $('new-chat').disabled = !online || !$('project-select').value;
  $('project-select').disabled = !online || !state?.projects.length;
  $('prompt').disabled = !chat;
  // A saved chat whose agent is switched off stays readable but can't continue until it's back on.
  const off = chat && state?.chats.some(item => item.id === chat.id) && agentFor(chat.agent)?.enabled === false && !drafts[selected]?.attempted;
  const images = drafts[selected]?.attachments ?? [];
  const hasContent = Boolean($('prompt').value.trim()) || images.some(item => item.id);
  const uploading = images.some(item => item.uploading);
  // While a turn runs, Send steers it (Enter does too); Send now stops the current step and runs the message next.
  const working = busy(chat) && chat?.status !== 'stopping';
  $('send').disabled = !online || !chat || (busy(chat) && !working) || sending || off || uploading || !hasContent;
  $('send').setAttribute('aria-label', sending ? 'Sending' : drafts[selected]?.attempted ? 'Retry message' : working ? 'Steer' : 'Send');
  $('send').title = drafts[selected]?.attempted ? 'Retry with the same delivery ID' : working ? 'Steer the running turn (Enter)' : 'Send (Enter)';
  $('send').classList.toggle('steer', working);
  $('send-now').hidden = !working || !hasContent;
  $('send-now').disabled = $('send').disabled;
  $('attach').disabled = !chat || !online || images.length >= 8 || Boolean(drafts[selected]?.attempted);
  $('stop').hidden = !busy(chat);
  $('send').hidden = busy(chat) && !working;
  $('stop').disabled = !online || chat?.status === 'stopping';
  $('stop').lastChild.textContent = chat?.status === 'stopping' ? 'Stopping…' : 'Stop';
  // Options apply to the next prompt, so they stay available while work runs.
  for (const id of ['model', 'effort', 'mode']) $(id).disabled = !chat || sending || Boolean(drafts[selected]?.attempted);
  const stored = chat && state?.chats.some(item => item.id === chat.id);
  $('rename').hidden = !stored; $('delete').hidden = !chat; $('delete').disabled = busy(chat) || Boolean(!stored && drafts[selected]?.attempted);
  $('delete').title = busy(chat) ? 'Stop this chat before deleting it' : 'Delete';
  $('composer-hint').textContent = !online ? 'Mac is disconnected. Your draft is saved on this device.' : off ? `${agentName(chat)} is off. Turn it on in the sidebar to continue this chat.` : chat?.status === 'waiting' ? 'Answer above, or stop this turn.' : busy(chat) ? 'Enter steers the running turn · Send now stops the current step first' : uploading ? 'Uploading images…' : drafts[selected]?.attempted ? 'Not confirmed by your Mac. Retry uses the same delivery ID.' : chat ? 'Enter to send · Shift+Enter for a new line' : 'Chats started here also appear on your phone.';
}
function renderChatList() {
  const list = $('chat-list');
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.chatId : null;
  list.replaceChildren();
  const chats = [...state.chats, ...Object.values(localChats).filter(chat => !state.chats.some(item => item.id === chat.id) && (chat.id === selected || !blankLocalDraft(drafts[chat.id])))].sort((a,b) => b.updatedAt - a.updatedAt);
  if (!chats.length) list.append(el('p', 'muted', 'New chats will appear here. They stay on this Mac.'));
  for (const chat of chats) {
    const button = el('button', 'chat-item'); button.type = 'button'; button.dataset.chatId = chat.id;
    button.classList.toggle('selected', chat.id === selected);
    if (chat.id === selected) button.setAttribute('aria-current', 'true');
    const meta = el('span', 'chat-item-meta');
    const when = el('time', '', relativeTime(chat.updatedAt)); when.dateTime = new Date(chat.updatedAt).toISOString(); when.title = new Date(chat.updatedAt).toLocaleString();
    const where = el('span', 'chat-item-where', `${projectName(chat)} · `); where.append(when);
    meta.append(where, chat.status && chat.status !== 'idle' ? statusBadge(chat.status) : el('span', 'chat-item-model', modelName(agentFor(chat.agent), chat.model || 'default')));
    const preview = chat.preview ?? (localChats[chat.id] ? drafts[chat.id]?.text : '');
    button.append(el('span', 'chat-item-title', chat.title));
    if (preview) button.append(el('span', 'chat-item-preview', preview));
    button.append(meta);
    button.onclick = () => selectChat(chat.id);
    list.append(button);
    if (chat.id === focused) button.focus();
  }
}
function renderEmpty() {
  const empty = el('div', 'empty');
  if (!state?.projects.length) {
    empty.append(el('h2', '', 'Start with a project'), el('p', '', 'Use Claude Code or Codex in a folder, or register one here. Then start a chat.'));
    const add = el('button', '', 'Add a project folder'); add.type = 'button'; add.onclick = () => { showDrawer(true); toggleProjectForm(true); };
    empty.append(add);
  } else {
    empty.append(el('h2', '', 'Open a chat'), el('p', '', 'Choose a recent chat, or pick a project and start a new one.'));
  }
  $('log').replaceChildren(empty); $('approvals').replaceChildren(); $('approvals').hidden = true; approvalsSignature = null;
}
function renderState() {
  const projectSelect = $('project-select');
  const chosenProject = state.projects.some(p => p.id === projectSelect.value) ? projectSelect.value : preferredProject;
  projectSelect.replaceChildren();
  if (!state.projects.length) projectSelect.append(new Option('Register a project folder', ''));
  for (const project of state.projects) projectSelect.append(new Option(project.name, project.id));
  if (state.projects.some(p => p.id === chosenProject)) projectSelect.value = chosenProject;
  agents = agentsFrom(state.capabilities);
  renderChatList();
  const chat = currentChat();
  $('chat-title').textContent = chat?.title ?? 'Your Mac, from anywhere';
  if (chat) {
    $('chat-meta').replaceChildren(el('span', 'chat-project', projectName(chat)), el('span', 'chat-agent', agentName(chat)), statusBadge(chat.status));
    if (chat.context?.window) {
      const share = Math.min(100, Math.round(chat.context.used * 100 / chat.context.window));
      const context = el('span', 'chat-context', `Context ${share}%`); context.title = `${chat.context.used.toLocaleString()} of ${chat.context.window.toLocaleString()} tokens after the last turn`;
      $('chat-meta').append(context);
    }
  }
  else $('chat-meta').textContent = state.projects.length ? 'Choose a chat or start a new one.' : 'Choose a project to start a chat.';
  if (chat && announced.chat === chat.id && announced.status !== chat.status) $('chat-live').textContent = liveText[chat.status] ?? '';
  announced = {chat:chat?.id, status:chat?.status};
  if (!chat) renderEmpty();
  const ready = agents.some(usableAgent);
  $('cli-status').textContent = ready ? '' : agents.some(agent => agent.available) ? 'Claude and Codex are both off. Turn one on below.' : 'Neither Claude Code nor Codex was found. Sign in with an official CLI on this Mac, then restart PocketBridge.';
  $('cli-status').hidden = ready;
  renderAgentSwitches();
  renderOptions(); autosize(); controls();
}
async function selectChat(id) {
  if (id !== selected) discardBlankLocal(selected);
  selected = id; approvalsSignature = null; persist('pocketbridge.chat', id); cancelRename();
  $('prompt').value = drafts[id]?.text ?? ''; autosize();
  $('log').replaceChildren(); $('approvals').replaceChildren(); $('approvals').hidden = true;
  if (narrow.matches) showDrawer(false);
  renderState(); renderAttachments(); hideSlash(); loadGit(true);
  try { await loadMessages(); } catch (error) { notice(error.message); }
}
function renderMessage(message, author, copyable, worked) {
  const article = el('article', `message ${message.role}${message.kind === 'imported' ? ' imported' : ''}`);
  const body = el('div', 'message-body');
  if (message.role === 'user') body.textContent = message.text; else body.append(markdown(message.text));
  const label = el('div', 'message-label', message.role === 'user' ? 'You' : author);
  if (message.kind === 'steer' || message.kind === 'interrupt') label.append(el('span', 'message-kind', message.kind === 'steer' ? 'Steered' : 'Sent now'));
  article.append(label);
  if (message.attachments?.length) {
    const strip = el('div', 'message-images');
    for (const image of message.attachments) { const thumb = el('button', 'thumb'); thumb.type = 'button'; thumb.setAttribute('aria-label', 'Open image'); const img = el('img'); img.alt = ''; imageUrl(image.id).then(url => { img.src = url; }, () => {}); thumb.append(img); thumb.onclick = () => openImage(image.id); strip.append(thumb); }
    article.append(strip);
  }
  article.append(body);
  if (copyable || worked) {
    const footer = el('div', 'message-footer');
    if (copyable) { const copy = el('button', 'quiet small copy-reply', 'Copy'); copy.type = 'button'; copy.dataset.text = message.text; footer.append(copy); }
    if (worked) footer.append(el('span', 'worked', `Worked ${elapsedLabel(worked)}`));
    article.append(footer);
  }
  return article;
}
/** One card per turn: each sub-agent with its type, model and effort, how long it ran and what it's doing. */
function renderSubagents(list) {
  const card = el('section', 'subagents');
  const running = list.filter(item => item.status === 'running').length;
  card.append(el('h3', '', running ? `Sub-agents · ${running} running` : `Sub-agents · ${list.length}`));
  const rows = el('ul');
  for (const agent of list) {
    const row = el('li', 'subagent'); row.dataset.status = agent.status;
    const mark = el('span', 'subagent-mark'); mark.setAttribute('aria-hidden', 'true');
    const text = el('div', 'subagent-text'), head = el('div', 'subagent-head');
    head.append(el('strong', '', agent.title || 'Sub-agent'));
    if (agent.kind) head.append(el('span', 'subagent-kind', agent.kind));
    const meta = el('p', 'subagent-meta', [agent.model, agent.effort ? effortLabels[agent.effort] ?? agent.effort : null].filter(Boolean).join(' · '));
    const time = el('span', 'subagent-time', `${meta.textContent ? ' · ' : ''}${agent.status === 'running' ? '' : `${{completed: 'Done', failed: 'Failed', stopped: 'Stopped'}[agent.status] ?? ''} in `}${elapsedLabel((agent.endedAt ?? Date.now()) - agent.startedAt)}`);
    if (agent.status === 'running') { time.dataset.since = agent.startedAt; time.classList.add('ticking'); }
    meta.append(time);
    text.append(head, meta);
    if (agent.activity) text.append(el('p', 'subagent-activity', agent.activity));
    row.append(mark, text); rows.append(row);
  }
  card.append(rows);
  return card;
}
function renderActivity(group, open) {
  const details = el('details', 'activity'); details.dataset.id = `g:${group.id}`; details.open = open.has(details.dataset.id);
  const {text, failed} = activitySummary(group.steps);
  const summary = el('summary'); summary.append(el('span', 'activity-title', text));
  if (failed) summary.append(el('span', 'activity-failed', `${failed} failed`));
  const steps = el('ol', 'steps');
  for (const step of group.steps) {
    const item = el('li', 'step');
    if (step.kind === 'note') { item.append(el('p', 'step-note', step.text)); steps.append(item); continue; }
    const row = el('details'); row.dataset.id = `s:${step.id}`; row.open = open.has(row.dataset.id);
    const line = el('summary');
    const result = step.kind === 'result' ? step : step.result;
    if (step.kind === 'tool') {
      const what = el('span', 'step-summary', step.summary.text); if (step.summary.title) what.title = step.summary.title;
      line.append(el('strong', 'step-name', step.name), what);
    } else line.append(el('strong', 'step-name', step.failed ? 'Tool failed' : 'Tool result'));
    if (result?.failed) line.append(el('span', 'step-failed', 'Failed'));
    row.append(line);
    if (step.kind === 'tool') row.append(el('p', 'step-label', 'Input'), el('pre', '', JSON.stringify(step.input, null, 2)));
    if (result) row.append(el('p', 'step-label', result.failed ? 'Error' : 'Result'), el('pre', result.failed ? 'failed' : '', result.text || 'No output'));
    item.append(row); steps.append(item);
  }
  details.append(summary, steps);
  return details;
}
function renderStatusNote(chat, hasApprovals, step, since, activity) {
  if (chat.status === 'running' || chat.status === 'stopping' || chat.status === 'waiting') {
    const note = el('div', 'working'); note.dataset.status = chat.status;
    const text = chat.status === 'running' ? 'Working' : chat.status === 'stopping' ? 'Stopping…' : hasApprovals ? 'Waiting for your answer below' : 'Waiting for your answer';
    note.append(el('span', 'working-mark'), el('span', '', text)); note.firstChild.setAttribute('aria-hidden', 'true');
    if (since && chat.status !== 'stopping') { const time = el('span', 'working-time', `· ${elapsedLabel(Date.now() - since)}`); time.dataset.since = since; note.append(time); }
    if (activity && chat.status === 'running') note.append(el('span', 'working-step', activity));
    else if (step && chat.status === 'running') { const now = el('span', 'working-step'); now.append(el('strong', '', step.name), document.createTextNode(` ${step.summary.text}`)); now.title = step.summary.title ?? ''; note.append(now); }
    return note;
  }
  if (chat.status === 'error') {
    const callout = el('div', 'callout danger');
    callout.append(el('strong', '', 'This turn failed'), el('p', '', chat.error || 'Claude stopped with an error.'), el('p', 'muted', 'Send a prompt to try again.'));
    return callout;
  }
  if (chat.status === 'interrupted') {
    const callout = el('div', 'callout');
    callout.append(el('strong', '', 'Stopped'), el('p', '', chat.error || 'Completed changes remain on disk.'), el('p', 'muted', 'Send a prompt to continue.'));
    return callout;
  }
  return null;
}
function showPendingChat() {
  const empty = el('div', 'empty'), chat = currentChat();
  empty.append(el('h2', '', `What should ${agentName(chat)} work on?`), el('p', 'muted', state?.projects.find(project => project.id === chat?.projectId)?.path ?? ''));
  $('log').replaceChildren(empty); $('approvals').replaceChildren(); $('approvals').hidden = true; approvalsSignature = null;
}
async function loadMessages() {
  const id = selected;
  if (!id || !currentChat()) return;
  if (!state?.chats.some(chat => chat.id === id)) { showPendingChat(); return; }
  const generation = ++messagesGeneration;
  const result = await api(`/chats/${encodeURIComponent(id)}/messages`);
  if (id !== selected || generation !== messagesGeneration) return;
  const pendingDraft = drafts[id];
  if (pendingDraft?.attempted && result.messages.some(message => message.role === 'user' && message.id === pendingDraft.id)) {
    delete drafts[id]; persist('pocketbridge.drafts',drafts); $('prompt').value = ''; autosize(); renderOptions(); controls();
  }
  const chat = currentChat();
  const scroller = $('messages'), target = $('log');
  const previousScroll = scroller.scrollTop;
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
  const open = new Set([...target.querySelectorAll('details[open]')].map(node => node.dataset.id));
  target.replaceChildren();
  if (!result.messages.length && !busy(chat)) { showPendingChat(); return; }
  const items = groupMessages(result.messages), live = busy(chat);
  const {ends, agents: subagentsByTurn} = turnPlacement(result.messages, result.turns, result.subagents);
  const indexOf = new Map(result.messages.map((message, index) => [message.id, index]));
  const lastIndexOf = item => item.type === 'message' ? indexOf.get(item.message.id) : Math.max(...item.steps.flatMap(step => [indexOf.get(step.id), step.result ? indexOf.get(step.result.id ?? '') ?? -1 : -1]));
  let shownImported = false, turnPrompt = null;
  items.forEach((item, index) => {
    if (item.type === 'message' && item.message.kind === 'imported' && !shownImported) { shownImported = true; target.append(el('p', 'imported-divider', `Continued from ${chat.agent === 'codex' ? 'Codex' : 'Claude Code'}`)); }
    if (item.type === 'message' && item.message.role === 'user' && result.turns?.some(turn => turn.id === item.message.id)) turnPrompt = item.message.id;
    const end = ends.get(lastIndexOf(item));
    if (item.type !== 'message') target.append(renderActivity(item, open));
    else {
      // A reply that closes a turn gets Copy: the next message is a prompt, or work has stopped.
      const next = items.slice(index + 1).find(other => other.type === 'message');
      const copyable = item.message.role === 'assistant' && Boolean(item.message.text.trim()) && (next ? next.message.role === 'user' : !live);
      const finished = end?.endedAt && !(live && end === result.turns?.at(-1));
      target.append(renderMessage(item.message, agentName(chat), copyable, finished ? end.endedAt - end.startedAt : null));
    }
    if (end && subagentsByTurn.get(end.id)?.length) target.append(renderSubagents(subagentsByTurn.get(end.id)));
    else if (index === items.length - 1 && turnPrompt && subagentsByTurn.get(turnPrompt)?.length && !end) target.append(renderSubagents(subagentsByTurn.get(turnPrompt)));
  });
  const pending = (result.approvals ?? []).some(approval => approval.status === 'pending');
  const since = result.turns?.at(-1)?.startedAt ?? result.messages.findLast(message => message.role === 'user')?.createdAt;
  const note = chat && renderStatusNote(chat, pending, liveStep(items), since, result.activity); if (note) target.append(note);
  renderApprovals(result.approvals ?? []);
  scroller.scrollTop = nearBottom ? scroller.scrollHeight : previousScroll;
}
function questionField(approval, question, index, restore) {
  const fieldset = el('fieldset', 'question');
  fieldset.append(el('legend', '', question.question));
  const key = part => JSON.stringify([approval.id, question.question, part]);
  const options = Array.isArray(question.options) ? question.options : [];
  if (!options.length) {
    const input = el('input', 'other-text'); input.type = 'text'; input.placeholder = 'Your answer'; input.setAttribute('aria-label', question.question);
    input.dataset.answerKey = key('text'); restore(input); fieldset.append(input);
    return {fieldset, question:question.question, value:() => input.value.trim()};
  }
  const choice = (part, label, description) => {
    const row = el('label', 'option'), input = el('input');
    input.type = question.multiSelect ? 'checkbox' : 'radio'; input.name = `${approval.id}:${index}`; input.value = label;
    input.dataset.answerKey = key(part); restore(input);
    const text = el('span', 'option-text'); text.append(el('span', 'option-label', label));
    if (description) text.append(el('span', 'option-description', description));
    row.append(input, text); fieldset.append(row);
    return input;
  };
  const inputs = options.map(option => choice(`option:${option.label}`, option.label, option.description));
  const other = choice('other', 'Other', '');
  const otherText = el('input', 'other-text'); otherText.type = 'text'; otherText.placeholder = 'Type your answer';
  otherText.setAttribute('aria-label', `Other answer: ${question.question}`); otherText.dataset.answerKey = key('other-text'); restore(otherText);
  fieldset.append(otherText);
  const sync = event => { otherText.hidden = !other.checked; if (event?.target === other && other.checked) otherText.focus(); };
  fieldset.addEventListener('change', sync); sync();
  const value = () => {
    const picked = inputs.filter(input => input.checked).map(input => input.value);
    if (other.checked && otherText.value.trim()) picked.push(otherText.value.trim());
    return picked.join(', ');
  };
  return {fieldset, question:question.question, value};
}
function approvalForm(approval, restore) {
  const form = el('form', 'approval');
  const questions = Array.isArray(approval.input?.questions) ? approval.input.questions : null;
  const plan = approval.tool === 'ExitPlanMode' && typeof approval.input?.plan === 'string' ? approval.input.plan : null;
  const title = questions ? (questions.length > 1 ? 'Claude has some questions' : 'Claude has a question') : plan !== null ? 'Review Claude\'s plan' : `Allow ${approval.tool}?`;
  form.append(el('h2', '', title));
  const answers = questions ? questions.map((question, index) => questionField(approval, question, index, restore)) : [];
  for (const answer of answers) form.append(answer.fieldset);
  if (plan !== null) { const body = el('div', 'message-body plan'); body.append(markdown(plan)); form.append(body); }
  if (!questions && plan === null) {
    const input = approval.input ?? {};
    if (typeof input.description === 'string') form.append(el('p', 'approval-description', input.description));
    const detail = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : JSON.stringify(input, null, 2);
    const pre = el('pre', 'approval-detail'); pre.append(el('code', '', detail)); form.append(pre);
  }
  const actions = el('div', 'approval-actions');
  const allow = el('button', '', questions ? 'Send answer' : plan !== null ? 'Approve plan' : 'Allow'); allow.type = 'submit';
  const deny = el('button', 'quiet', questions ? 'Decline' : plan !== null ? 'Keep planning' : 'Deny'); deny.type = 'button';
  actions.append(allow, deny); form.append(actions);
  const update = () => { allow.disabled = answers.some(answer => !answer.value()); };
  form.addEventListener('input', update); form.addEventListener('change', update); update();
  const respond = async decision => {
    allow.disabled = deny.disabled = true;
    try { await api(`/approvals/${encodeURIComponent(approval.id)}`, {decision, ...(decision === 'allow' && answers.length ? {answers:Object.fromEntries(answers.map(answer => [answer.question, answer.value()]))} : {})}); await loadMessages(); }
    catch (error) { notice(error.message); deny.disabled = false; update(); }
  };
  form.onsubmit = event => { event.preventDefault(); if (!allow.disabled) respond('allow'); };
  deny.onclick = () => respond('deny');
  return form;
}
function renderApprovals(approvals) {
  const signature = JSON.stringify([selected,approvals]);
  if (signature === approvalsSignature) return;
  approvalsSignature = signature;
  const checkable = input => input.type === 'radio' || input.type === 'checkbox';
  const previous = new Map([...$('approvals').querySelectorAll('[data-answer-key]')].map(input => [input.dataset.answerKey, checkable(input) ? input.checked : input.value]));
  const restore = input => { if (previous.has(input.dataset.answerKey)) input[checkable(input) ? 'checked' : 'value'] = previous.get(input.dataset.answerKey); };
  const pending = approvals.filter(a => a.status === 'pending');
  $('approvals').replaceChildren(...pending.map(approval => approvalForm(approval, restore)));
  $('approvals').hidden = !pending.length;
}
async function refresh() {
  if (refreshing) { pendingRefresh = true; return; }
  refreshing = true;
  try {
    state = await api('/state'); seq = Math.max(seq, state.lastSeq);
    let droppedLocal = false;
    for (const id of Object.keys(localChats)) if (state.chats.some(chat => chat.id === id)) { delete localChats[id]; droppedLocal = true; }
    for (const id of Object.keys(localChats)) if (id !== selected && blankLocalDraft(drafts[id])) { delete localChats[id]; delete drafts[id]; droppedLocal = true; }
    persistLocalChats();
    if (droppedLocal) persist('pocketbridge.drafts', drafts);
    for (const [id, options] of Object.entries(overrides)) { const chat = state.chats.find(item => item.id === id); if (!chat || sameOptions(options, savedOptions(chat))) delete overrides[id]; }
    persist('pocketbridge.options', overrides);
    if (selected && !currentChat()) { selected = null; $('prompt').value = ''; autosize(); }
    const stopped = previousBusy && !busy(currentChat()); previousBusy = busy(currentChat());
    renderState(); await loadMessages();
    if (stopped) loadGit(true);
  } finally {
    refreshing = false;
    if (pendingRefresh) { pendingRefresh = false; scheduleRefresh(); }
  }
}
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh().catch(error => notice(error.message)); }, 250);
}
// Images: picked, pasted or dropped, shrunk to 2048 px JPEG when large, uploaded at once, sent by id.
const imageUrls = new Map();
function imageUrl(id) {
  if (!imageUrls.has(id)) imageUrls.set(id, fetch(`/api/uploads/${encodeURIComponent(id)}`, {headers:{Authorization:`Bearer ${token}`}}).then(async response => { if (!response.ok) throw new Error('Image unavailable'); return URL.createObjectURL(await response.blob()); }));
  return imageUrls.get(id);
}
async function openImage(id) { $('viewer-image').src = await imageUrl(id); $('viewer').showModal(); }
$('viewer').onclick = () => $('viewer').close();
async function shrink(file) {
  if (file.size <= 1_500_000 && !/heic|heif/.test(file.type)) return file;
  const bitmap = await createImageBitmap(file), scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return await new Promise(resolveBlob => canvas.toBlob(resolveBlob, 'image/jpeg', 0.85));
}
function setImages(chatId, update) {
  drafts[chatId] = withAttachments(drafts[chatId], update(drafts[chatId]?.attachments ?? []));
  if (localChats[chatId]?.projectId) drafts[chatId].projectId = localChats[chatId].projectId;
  persist('pocketbridge.drafts', Object.fromEntries(Object.entries(drafts).map(([id, draft]) => [id, {...draft, attachments: (draft.attachments ?? []).filter(item => item.id).map(({id: uploadId, type}) => ({id: uploadId, type}))}])));
  if (localChats[chatId]) persistLocalChats();
  if (chatId === selected) { renderAttachments(); controls(); }
}
async function attach(files) {
  const chatId = selected; if (!chatId || drafts[chatId]?.attempted) return;
  for (const file of [...files].filter(item => item.type.startsWith('image/')).slice(0, 8 - (drafts[chatId]?.attachments?.length ?? 0))) {
    const key = crypto.randomUUID();
    setImages(chatId, list => [...list, {key, uploading: true, local: URL.createObjectURL(file)}]);
    try {
      const blob = await shrink(file);
      const response = await fetch('/api/uploads', {method:'POST', headers:{Authorization:`Bearer ${token}`, 'Content-Type': blob.type || file.type}, body: blob});
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Upload failed');
      imageUrls.set(result.id, Promise.resolve(URL.createObjectURL(blob)));
      setImages(chatId, list => list.map(item => item.key === key ? {id: result.id, type: result.type} : item));
    } catch (error) { setImages(chatId, list => list.filter(item => item.key !== key)); notice(`Image not attached: ${error.message}`); }
  }
}
function renderAttachments() {
  const list = drafts[selected]?.attachments ?? [];
  $('attachments').hidden = !list.length;
  $('attachments').replaceChildren(...list.map(item => {
    const thumb = el('div', `attachment${item.uploading ? ' uploading' : ''}`), img = el('img'); img.alt = '';
    if (item.local) img.src = item.local; else if (item.id) imageUrl(item.id).then(url => { img.src = url; }, () => {});
    thumb.append(img);
    if (!drafts[selected]?.attempted) { const remove = el('button', 'attachment-remove', '×'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove image'); remove.onclick = () => setImages(selected, current => current.filter(other => other !== item && (other.key ?? other.id) !== (item.key ?? item.id))); thumb.append(remove); }
    return thumb;
  }));
}
$('attach').onclick = () => $('file').click();
$('file').onchange = () => { attach($('file').files); $('file').value = ''; };
$('prompt').addEventListener('paste', event => { const files = [...event.clipboardData.files].filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); attach(files); } });
$('composer').addEventListener('dragover', event => { if ([...event.dataTransfer.items].some(item => item.type.startsWith('image/'))) { event.preventDefault(); $('composer').classList.add('dropping'); } });
$('composer').addEventListener('dragleave', () => $('composer').classList.remove('dropping'));
$('composer').addEventListener('drop', event => { $('composer').classList.remove('dropping'); const files = [...event.dataTransfer.files].filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); attach(files); } });

// Git: branch and lines changed in the open chat's project, refreshed on open, after turns and every 15 s.
let gitFor = null, gitAt = 0, previousBusy = false;
async function loadGit(force = false) {
  const chat = currentChat(), projectId = chat?.projectId;
  if (!projectId || !token || (!force && gitFor === projectId && Date.now() - gitAt < 15000)) { if (!projectId) $('git-bar').hidden = true; return; }
  gitFor = projectId; gitAt = Date.now();
  try {
    const git = await api(`/projects/${encodeURIComponent(projectId)}/git`);
    if (currentChat()?.projectId !== projectId) return;
    $('git-bar').hidden = !git.repo;
    if (!git.repo) return;
    const branch = el('span', 'git-branch'); branch.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11 7"/></svg>';
    branch.append(git.branch ?? git.commit ?? 'detached');
    const parts = [branch, el('span', 'git-added', `+${git.added.toLocaleString()}`), el('span', 'git-removed', `−${git.removed.toLocaleString()}`)];
    if (git.files) parts.push(el('span', 'git-files', `${git.files} ${git.files === 1 ? 'file' : 'files'}`));
    if (git.ahead || git.behind) parts.push(el('span', 'git-sync', [git.ahead ? `↑${git.ahead}` : '', git.behind ? `↓${git.behind}` : ''].filter(Boolean).join(' ')));
    $('git-bar').replaceChildren(...parts);
    $('git-bar').title = `${git.files} changed ${git.files === 1 ? 'file' : 'files'} against ${git.commit ?? 'the first commit'}`;
  } catch { $('git-bar').hidden = true; }
}
setInterval(() => { if (!document.hidden) loadGit(); }, 15000);

// Sessions from Terminal or the desktop apps in the chosen project, to continue here.
async function loadSessions() {
  const projectId = $('project-select').value;
  if (!projectId || !token) { $('sessions').hidden = true; return; }
  try {
    const {sessions} = await api(`/projects/${encodeURIComponent(projectId)}/sessions`);
    if ($('project-select').value !== projectId) return;
    $('sessions').hidden = !sessions.length;
    $('session-list').replaceChildren(...sessions.slice(0, 6).map(session => {
      const button = el('button', 'session-item'); button.type = 'button';
      button.append(el('span', 'session-title', session.title));
      const meta = el('span', 'session-meta', `${session.agent === 'codex' ? 'Codex' : 'Claude Code'} · ${relativeTime(session.updatedAt)}`);
      button.append(meta); button.title = session.preview ?? '';
      button.onclick = async () => {
        button.disabled = true;
        try { const chat = await api('/chats/continue', {projectId, agent: session.agent, sessionId: session.id}); await refresh(); await selectChat(chat.id); loadSessions(); }
        catch (error) { notice(error.message); } finally { button.disabled = false; }
      };
      return button;
    }));
  } catch { $('sessions').hidden = true; }
}

// "/" lists the project's commands and skills for the chat's agent.
const commandCache = new Map();
let slashItems = [], slashIndex = 0;
function hideSlash() { $('slash').hidden = true; slashItems = []; }
async function updateSlash() {
  const chat = currentChat(), text = $('prompt').value;
  if (!chat || !/^\/\S*$/.test(text)) { hideSlash(); return; }
  const key = `${chat.projectId}:${chat.agent || 'claude'}`;
  if (!commandCache.has(key) || Date.now() - commandCache.get(key).at > 600000) commandCache.set(key, {at: Date.now(), list: api(`/projects/${encodeURIComponent(chat.projectId)}/commands?agent=${chat.agent || 'claude'}`).then(result => result.commands, () => [])});
  const commands = await commandCache.get(key).list;
  if ($('prompt').value !== text) return;
  slashItems = slashMatches(commands, text); slashIndex = 0; renderSlash();
}
function renderSlash() {
  $('slash').hidden = !slashItems.length;
  $('slash').replaceChildren(...slashItems.map((command, index) => {
    const option = el('button', 'slash-item'); option.type = 'button'; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(index === slashIndex));
    option.append(el('span', 'slash-name', `/${command.name}`)); if (command.hint) option.append(el('span', 'slash-hint', command.hint));
    if (command.description) option.append(el('span', 'slash-description', command.description));
    option.onmousedown = event => { event.preventDefault(); chooseSlash(index); };
    return option;
  }));
}
function chooseSlash(index) {
  const command = slashItems[index]; if (!command) return;
  $('prompt').value = `/${command.name} `; hideSlash(); $('prompt').dispatchEvent(new Event('input')); $('prompt').focus();
}

// One switch per agent, shared with the phone. Off skips its probes, discovery and new turns.
function renderAgentSwitches() {
  $('agent-switches').replaceChildren(...agents.map(agent => {
    const row = el('label', 'agent-switch'), input = el('input');
    input.type = 'checkbox'; input.role = 'switch'; input.checked = agent.enabled !== false; input.disabled = !agent.available || !online;
    input.onchange = async () => {
      input.disabled = true;
      try { await api(`/agents/${agent.id}`, {enabled: input.checked}); usageAt = 0; await refresh(); loadUsage(true); notice(); }
      catch (error) { input.checked = !input.checked; notice(error.message); }
      finally { input.disabled = !agent.available || !online; }
    };
    const text = el('span', 'agent-switch-text'); text.append(el('span', '', agent.id === 'claude' ? 'Claude Code' : agent.name), el('span', 'muted', !agent.available ? 'Not installed' : agent.enabled === false ? 'Off' : modelName(agent, agent.defaultModel)));
    row.append(text, input);
    return row;
  }));
}

// Plan usage from each CLI on the Mac. The header shows the fullest limit; the panel lists them all.
let usageAt = 0;
async function loadUsage(force = false) {
  if (!token || (!force && Date.now() - usageAt < 60000)) return;
  usageAt = Date.now();
  try { renderUsage((await api('/usage')).agents ?? []); } catch { /* An older Mac service has no usage; keep the header quiet. */ }
}
function renderUsage(agentsUsage) {
  const listed = agentsUsage.filter(agent => agent.limits?.length);
  $('usage-toggle').hidden = !listed.length;
  if (!listed.length) return;
  const fullest = listed.flatMap(agent => agent.limits.map(limit => ({...limit, agent: agent.name}))).sort((a, b) => b.percent - a.percent)[0];
  $('usage-fill').style.width = `${fullest.percent}%`; $('usage-fill').dataset.severity = fullest.severity;
  $('usage-summary').textContent = `${fullest.percent}%`; $('usage-toggle').title = `${fullest.agent} ${fullest.label.toLowerCase()}: ${fullest.percent}% used`;
  $('usage-panel').replaceChildren(...listed.map(agent => {
    const section = el('section', 'usage-agent');
    const head = el('h2', '', agent.name); if (agent.plan) head.append(el('span', 'usage-plan', agent.plan));
    section.append(head);
    for (const limit of agent.limits) {
      const row = el('div', 'usage-limit'); row.dataset.severity = limit.severity;
      const line = el('div', 'usage-line'); line.append(el('span', '', limit.label), el('strong', '', `${limit.percent}%`));
      const bar = el('div', 'usage-bar'); const fill = el('span'); fill.style.width = `${limit.percent}%`; bar.append(fill);
      bar.setAttribute('role', 'meter'); bar.setAttribute('aria-valuenow', limit.percent); bar.setAttribute('aria-valuemin', 0); bar.setAttribute('aria-valuemax', 100); bar.setAttribute('aria-label', `${agent.name} ${limit.label}`);
      row.append(line, bar, el('p', 'usage-reset', resetLabel(limit.resetsAt)));
      section.append(row);
    }
    if (typeof agent.credits === 'number') section.append(el('p', 'usage-credits', `${agent.credits.toLocaleString(undefined, {maximumFractionDigits: 2})} credits left`));
    return section;
  }));
}
$('usage-panel').addEventListener('toggle', event => { if (event.newState === 'open') loadUsage(true); });
setInterval(() => loadUsage(), 120000);

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect() {
  let retry = 1000;
  for (;;) {
    try {
      if (!token) token = (await api('/local-session')).token;
      await refresh();
      connection(true, 'Connected to Mac'); notice(); retry = 1000; loadUsage(); loadSessions(); loadGit(true);
      streamController = new AbortController();
      const response = await fetch(`/api/events?after=${seq}`, {headers:{Authorization:`Bearer ${token}`}, signal:streamController.signal, cache:'no-store'});
      if (response.status === 401) token = null;
      if (!response.ok || !response.body) throw new Error(`Event connection failed (${response.status})`);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); const events = new EventDecoder();
      let lastActivity = Date.now();
      const watchdog = setInterval(() => { if (Date.now() - lastActivity > 45000) streamController.abort(); },10000);
      try {
        for (;;) {
          const {done,value} = await reader.read(); if (done) break;
          lastActivity = Date.now();
          for (const event of events.push(decoder.decode(value, {stream:true}))) {
            if (event.type !== 'change') continue;
            const change = JSON.parse(event.data);
            if (Number.isSafeInteger(change.seq)) seq = Math.max(seq, change.seq);
            scheduleRefresh();
          }
        }
      } finally { clearInterval(watchdog); reader.releaseLock(); }
      throw new Error('Connection ended');
    } catch (error) {
      connection(false, 'Reconnecting to Mac…');
      if (!state) notice('PocketBridge could not connect. Open this page through the Mac launcher. It will retry automatically.');
      await pause(retry); retry = Math.min(retry * 2, 10000);
    }
  }
}

// Narrow windows show projects and chats as a drawer.
const narrow = matchMedia('(max-width: 759px)');
function showDrawer(show) {
  if (!narrow.matches) show = false;
  document.body.classList.toggle('drawer-open', show);
  $('chats-toggle').setAttribute('aria-expanded', String(show));
  $('scrim').hidden = !show;
  if (show) ($('chat-list').querySelector('.selected') ?? $('new-chat')).focus();
}
$('chats-toggle').onclick = () => showDrawer(!document.body.classList.contains('drawer-open'));
$('scrim').onclick = () => showDrawer(false);
narrow.addEventListener('change', () => showDrawer(false));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.body.classList.contains('drawer-open')) { showDrawer(false); $('chats-toggle').focus(); } });

$('project-select').onchange = () => { preferredProject = $('project-select').value; persist('pocketbridge.project', preferredProject); controls(); loadSessions(); };
$('model').onchange = () => {
  const [agentId, model] = $('model').value.split('|'), agent = agentFor(agentId);
  if (agent) setOptions(resolveOptions(agent, {...chatOptions(), agent: agentId, model}));
};
$('effort').onchange = () => setOptions({...chatOptions(), effort: $('effort').value});
$('mode').onchange = () => setOptions({...chatOptions(), mode: $('mode').value});
function cancelRename() { $('rename-form').hidden = true; $('chat-title').hidden = false; }
$('rename').onclick = () => {
  const chat = currentChat(); if (!chat) return;
  $('rename-input').value = chat.title; $('chat-title').hidden = true; $('rename-form').hidden = false; $('rename-input').select();
};
$('rename-input').onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); cancelRename(); $('rename').focus(); } };
$('rename-input').onblur = () => { if (!$('rename-form').hidden) $('rename-form').requestSubmit(); };
$('rename-form').onsubmit = async event => {
  event.preventDefault(); const chat = currentChat(), title = $('rename-input').value.trim();
  cancelRename(); if (!chat || !title || title === chat.title) return;
  try { await api(`/chats/${encodeURIComponent(chat.id)}/rename`, {title}); await refresh(); } catch (error) { notice(error.message); }
};
$('delete').onclick = async () => {
  const chat = currentChat(); if (!chat || busy(chat)) return;
  const local = !state?.chats.some(item => item.id === chat.id);
  if (!confirm(local ? `Delete "${chat.title}" from this browser? It has not been sent.` : `Delete "${chat.title}" from PocketBridge on this Mac and your phone?`)) return;
  try {
    if (!local) await api(`/chats/${encodeURIComponent(chat.id)}/delete`, {});
    delete localChats[chat.id]; delete drafts[chat.id]; delete overrides[chat.id];
    persistLocalChats(); persist('pocketbridge.drafts', drafts); persist('pocketbridge.options', overrides);
    selected = null; persist('pocketbridge.chat', null); $('prompt').value = ''; autosize();
    await refresh(); notice();
  } catch (error) { notice(error.message); }
};
function toggleProjectForm(show = $('project-form').hidden) { $('project-form').hidden = !show; $('add-project').setAttribute('aria-expanded', String(show)); if (show) $('project-path').focus(); }
$('add-project').onclick = () => toggleProjectForm();
$('project-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { const project = await api('/projects', {path:$('project-path').value.trim(),name:$('project-name').value.trim() || undefined}); preferredProject = project.id; persist('pocketbridge.project', project.id); $('project-form').reset(); $('project-form').hidden = true; $('add-project').setAttribute('aria-expanded','false'); await refresh(); notice(); }
  catch (error) { notice(error.message); } finally { button.disabled = false; }
};
$('new-chat').onclick = async () => {
  const projectId = $('project-select').value;
  if (!projectId) return;
  $('new-chat').disabled = true;
  const id = crypto.randomUUID();
  // New chats start from the last model, effort and mode used with that agent.
  const agentId = newChatAgent(agents, lastAgent);
  if (!agentId) { notice('Claude and Codex are both off. Turn one on in the sidebar.'); controls(); return; }
  const agent = agentFor(agentId);
  const options = agent ? resolveOptions(agent, lastOptions[agent.id]) : {agent:'claude', mode:'bypassPermissions', model:'default', effort:'default'};
  localChats[id] = {id, projectId, title:'New chat', ...options, status:'idle', updatedAt:Date.now()};
  try { await selectChat(id); notice(); $('prompt').focus(); }
  finally { controls(); }
};
$('prompt').oninput = () => {
  autosize(); updateSlash();
  if (!selected) return;
  const wasBlank = blankLocalDraft(drafts[selected]);
  const next = editDraft(drafts[selected], $('prompt').value);
  if (next !== drafts[selected]) {
    if (localChats[selected]?.projectId) next.projectId = localChats[selected].projectId;
    drafts[selected] = next; persist('pocketbridge.drafts', drafts);
    if (localChats[selected]) persistLocalChats();
    if (wasBlank !== blankLocalDraft(next)) renderChatList();
  }
  controls();
};
$('prompt').onkeydown = event => {
  if (slashItems.length) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); slashIndex = (slashIndex + (event.key === 'ArrowDown' ? 1 : slashItems.length - 1)) % slashItems.length; renderSlash(); return; }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) { event.preventDefault(); chooseSlash(slashIndex); return; }
    if (event.key === 'Escape') { event.preventDefault(); hideSlash(); return; }
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); }
};
$('prompt').addEventListener('blur', () => setTimeout(hideSlash, 150));
$('send-now').onclick = () => submit('interrupt');
$('composer').onsubmit = event => { event.preventDefault(); submit(busy() ? 'steer' : null); };
async function submit(delivery) {
  if ($('send').disabled) return;
  const chatId = selected;
  const options = chatOptions();
  const draft = prepareDelivery(drafts[chatId], $('prompt').value, options, delivery);
  if (localChats[chatId]?.projectId) draft.projectId ??= localChats[chatId].projectId;
  drafts[chatId] = draft; persist('pocketbridge.drafts', drafts); if (localChats[chatId]) persistLocalChats(); sending = true; controls();
  const projectId = state?.chats.some(chat => chat.id === chatId) ? undefined : (localChats[chatId]?.projectId ?? draft.projectId);
  try {
    await api(`/chats/${encodeURIComponent(chatId)}/prompts`, promptPayload(draft, projectId));
    delete overrides[chatId]; persist('pocketbridge.options', overrides);
    lastOptions[draft.agent] = {agent: draft.agent, mode: draft.mode, model: draft.model, effort: draft.effort}; lastAgent = draft.agent;
    persist('pocketbridge.lastOptions', lastOptions); persist('pocketbridge.lastAgent', lastAgent);
    if (drafts[chatId]?.id === draft.id) { delete drafts[chatId]; persist('pocketbridge.drafts', drafts); if (selected === chatId) { $('prompt').value = ''; autosize(); renderAttachments(); } }
    notice(); await refresh();
  } catch (error) {
    if (error.status === 410) {
      delete drafts[chatId]; delete localChats[chatId];
      persist('pocketbridge.drafts', drafts); persistLocalChats();
      if (selected === chatId) { selected = null; persist('pocketbridge.chat', null); $('prompt').value = ''; autosize(); }
      notice(error.message); renderState();
    } else if (drafts[chatId]?.id === draft.id && error.status >= 400 && error.status < 500 && error.status !== 408) {
      // A definitive rejection ran nothing: unlock the draft so its text and options can change.
      drafts[chatId] = {...drafts[chatId], attempted: false}; persist('pocketbridge.drafts', drafts);
      notice(error.message); renderOptions();
    } else if (drafts[chatId]?.id === draft.id) notice(`${error.message}. Your message is saved. Retry will use the same delivery ID.`);
    else notice();
  }
  finally { sending = false; controls(); }
}
$('stop').onclick = async () => { $('stop').disabled = true; try { await api(`/chats/${encodeURIComponent(selected)}/stop`, {}); await refresh(); } catch (error) { notice(error.message); controls(); } };
$('messages').addEventListener('click', async event => {
  const button = event.target.closest('.copy-code, .copy-reply'); if (!button) return;
  const text = button.classList.contains('copy-reply') ? button.dataset.text : button.closest('.code-block').querySelector('code').textContent;
  try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy'; }, 1500); }
  catch { notice('Clipboard is unavailable. Select the text to copy it.'); }
});
setInterval(() => {
  for (const time of document.querySelectorAll('.working-time')) time.textContent = `· ${elapsedLabel(Date.now() - Number(time.dataset.since))}`;
  for (const time of document.querySelectorAll('.subagent-time.ticking')) time.textContent = ` · ${elapsedLabel(Date.now() - Number(time.dataset.since))}`;
}, 1000);

function showSettings(show) {
  const dialog = $('settings');
  if (show && !dialog.open) dialog.showModal();
  if (!show && dialog.open) dialog.close();
  $('settings-toggle').setAttribute('aria-expanded', String(show));
}
$('settings-toggle').onclick = () => showSettings(true);
$('settings-close').onclick = () => showSettings(false);
$('settings').addEventListener('close', () => $('settings-toggle').setAttribute('aria-expanded', 'false'));
$('settings').addEventListener('click', event => { if (event.target === $('settings')) showSettings(false); });
$('pair-button').onclick = async () => {
  const button = $('pair-button'); button.disabled = true;
  try {
    const pairing = await api('/pairing'); pairLink = pairing.link;
    $('pair-url').textContent = pairing.url; $('pair-code').textContent = pairing.code;
    const local = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:|\/|$)/i.test(pairing.url);
    $('pair-expiry').textContent = local ? 'This is a local address. Configure your private Tailscale HTTPS address before pairing your phone.' : `Expires ${new Date(pairing.expiresAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}. Pairing stays saved after connecting.`;
    $('pair-details').hidden = false; $('pair-qr').hidden = true; button.textContent = 'Create new code';
    if (!local) {
      const response = await fetch(`/api/pairing/qr?code=${encodeURIComponent(pairing.code)}`, {headers:{Authorization:`Bearer ${token}`}});
      if (response.ok) { if (qrUrl) URL.revokeObjectURL(qrUrl); qrUrl = URL.createObjectURL(await response.blob()); const qr = new Image(184,184); qr.src = qrUrl; qr.alt = 'Scan to connect PocketBridge on Android'; $('pair-qr').replaceChildren(qr); $('pair-qr').hidden = false; }
      else notice('Pairing code is ready. QR could not load; enter the address and code on your phone.');
    }
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
};
$('copy-pair').onclick = async () => { try { await navigator.clipboard.writeText(pairLink); $('copy-pair').textContent = 'Copied'; setTimeout(() => $('copy-pair').textContent = 'Copy connection link',1500); } catch { notice('Clipboard is unavailable. Enter the address and pairing code on your phone.'); } };
document.addEventListener('visibilitychange', () => { if (!document.hidden) { scheduleRefresh(); if (!online) streamController?.abort(); } });
window.addEventListener('online', () => streamController?.abort());
setInterval(() => { if (state) renderChatList(); }, 60000);
$('prompt').value = drafts[selected]?.text ?? '';
// Size once styles are applied; module scripts can run before the stylesheet settles.
requestAnimationFrame(autosize); addEventListener('resize', autosize);
connect();
