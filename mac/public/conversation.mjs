// The open conversation: its header, transcript, tool activity, sub-agents and pending answers.
import {markdown, turnPlacement, groupMessages, activitySummary, effortLabel, liveStep, elapsedLabel} from './support.mjs';
import {$, el, app, drafts, localChats, overrides, persist, persistDrafts, persistLocalChats, notice, api, imageUrl, currentChat, storedChat, projectFor, projectName, agentName, busy, statusBadge, projectAvatar} from './core.mjs';
import {refresh, controls} from './app.mjs';
import {renderOptions, clearPrompt} from './composer.mjs';
import {showDrawer, toggleProjectForm} from './sidebar.mjs';

const liveText = {idle:'Finished. Ready for your next message.', running:'Working.', waiting:'Needs your answer.', stopping:'Stopping.', interrupted:'Work stopped.', error:'This turn failed.'};
let approvalsSignature = null, announced = {}, messagesGeneration = 0;

/** Title, the project folder under it, then agent, status and context use. */
export function renderHeader(chat) {
  $('chat-title').textContent = chat?.title ?? 'Your Mac, from anywhere';
  const project = projectFor(chat);
  $('chat-folder').hidden = !chat;
  $('chat-folder').title = project?.path ?? '';
  if (chat) $('chat-folder').replaceChildren(projectAvatar(project, 'tiny'), el('span', '', projectName(chat)));
  document.querySelector('.chat-header').dataset.agent = chat ? chat.agent || 'claude' : '';
  if (chat) {
    $('chat-meta').replaceChildren(el('span', 'chat-agent', agentName(chat)), statusBadge(chat.status));
    if (chat.context?.window) {
      const share = Math.min(100, Math.round(chat.context.used * 100 / chat.context.window));
      const context = el('span', 'chat-context', `Context ${share}%`); context.title = `${chat.context.used.toLocaleString()} of ${chat.context.window.toLocaleString()} tokens after the last turn`;
      $('chat-meta').append(context);
    }
  }
  else $('chat-meta').textContent = app.state.projects.length ? 'Choose a chat or start a new one.' : 'Choose a project to start a chat.';
  if (chat && announced.chat === chat.id && announced.status !== chat.status) $('chat-live').textContent = liveText[chat.status] ?? '';
  announced = {chat:chat?.id, status:chat?.status};
}
export function headerControls() {
  const chat = currentChat(), stored = chat && storedChat(chat.id);
  $('desktop').hidden = !stored || (chat.agent ?? 'claude') !== 'claude'; $('desktop').disabled = busy(chat);
  $('desktop').title = busy(chat) ? 'Open in Claude Desktop once this turn finishes' : 'Open in Claude Desktop';
  $('rename').hidden = !stored; $('delete').hidden = !chat; $('delete').disabled = busy(chat) || Boolean(!stored && drafts[app.selected]?.attempted);
  $('delete').title = busy(chat) ? 'Stop this chat before deleting it' : 'Delete';
}

/** Empties the transcript and pending answers, for a newly opened chat. */
export function clearConversation() { $('log').replaceChildren(); $('approvals').replaceChildren(); $('approvals').hidden = true; approvalsSignature = null; }
export function renderEmpty() {
  const empty = el('div', 'empty');
  if (!app.state?.projects.length) {
    empty.append(el('h2', '', 'Start with a project'), el('p', '', 'Use Claude Code or Codex in a folder, or register one here. Then start a chat.'));
    const add = el('button', '', 'Add a project folder'); add.type = 'button'; add.onclick = () => { showDrawer(true); toggleProjectForm(true); };
    empty.append(add);
  } else {
    empty.append(el('h2', '', 'Open a chat'), el('p', '', 'Choose a recent chat, or pick a project and start a new one.'));
  }
  clearConversation(); $('log').append(empty);
}
function showPendingChat() {
  const empty = el('div', 'empty'), chat = currentChat();
  empty.append(el('h2', '', `What should ${agentName(chat)} work on?`), el('p', 'muted', projectFor(chat)?.path ?? ''));
  clearConversation(); $('log').append(empty);
}

async function openImage(id) {
  try { $('viewer-image').src = await imageUrl(id); $('viewer').showModal(); } catch (error) { notice(error.message); }
}
$('viewer').onclick = () => $('viewer').close();

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
    const meta = el('p', 'subagent-meta', [agent.model, agent.effort ? effortLabel(agent.effort) : null].filter(Boolean).join(' · '));
    const lead = meta.textContent ? ' · ' : '';
    const time = el('span', 'subagent-time', `${lead}${agent.status === 'running' ? '' : `${{completed: 'Done', failed: 'Failed', stopped: 'Stopped'}[agent.status] ?? ''} in `}${elapsedLabel((agent.endedAt ?? Date.now()) - agent.startedAt)}`);
    if (agent.status === 'running') { time.dataset.since = agent.startedAt; time.dataset.lead = lead; time.classList.add('ticking'); }
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
    callout.append(el('strong', '', 'This turn failed'), el('p', '', chat.error || `${agentName(chat)} stopped with an error.`), el('p', 'muted', 'Send a prompt to try again.'));
    return callout;
  }
  if (chat.status === 'interrupted') {
    const callout = el('div', 'callout');
    callout.append(el('strong', '', 'Stopped'), el('p', '', chat.error || 'Completed changes remain on disk.'), el('p', 'muted', 'Send a prompt to continue.'));
    return callout;
  }
  return null;
}
export async function loadMessages() {
  const id = app.selected;
  if (!id || !currentChat()) return;
  if (!storedChat(id)) { showPendingChat(); return; }
  const generation = ++messagesGeneration;
  const result = await api(`/chats/${encodeURIComponent(id)}/messages`);
  if (id !== app.selected || generation !== messagesGeneration) return;
  const pendingDraft = drafts[id];
  if (pendingDraft?.attempted && result.messages.some(message => message.role === 'user' && message.id === pendingDraft.id)) {
    delete drafts[id]; persistDrafts(); clearPrompt(); renderOptions(); controls();
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
  const lastIndexOf = item => item.type === 'message' ? indexOf.get(item.message.id) : Math.max(...item.steps.flatMap(step => [indexOf.get(step.id), step.result ? indexOf.get(step.result.id) ?? -1 : -1]));
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
  // A turn that already ended isn't the work in progress; a new prompt not yet picked up counts from when it was sent.
  const since = result.turns?.findLast(turn => !turn.endedAt)?.startedAt ?? result.messages.findLast(message => message.role === 'user')?.createdAt;
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
  const signature = JSON.stringify([app.selected, approvals]);
  if (signature === approvalsSignature) return;
  approvalsSignature = signature;
  const checkable = input => input.type === 'radio' || input.type === 'checkbox';
  const previous = new Map([...$('approvals').querySelectorAll('[data-answer-key]')].map(input => [input.dataset.answerKey, checkable(input) ? input.checked : input.value]));
  const restore = input => { if (previous.has(input.dataset.answerKey)) input[checkable(input) ? 'checked' : 'value'] = previous.get(input.dataset.answerKey); };
  const pending = approvals.filter(a => a.status === 'pending');
  $('approvals').replaceChildren(...pending.map(approval => approvalForm(approval, restore)));
  $('approvals').hidden = !pending.length;
}

// Header actions: open in Claude Desktop, rename and delete.
$('desktop').onclick = async () => {
  const chat = currentChat(); if (!chat) return;
  try { await api(`/chats/${encodeURIComponent(chat.id)}/desktop`, {}); notice('Opened in Claude Desktop.'); } catch (error) { notice(error.message); }
};
export function cancelRename() { $('rename-form').hidden = true; $('chat-title').hidden = false; }
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
  const local = !storedChat(chat.id);
  if (!confirm(local ? `Delete "${chat.title}" from this browser? It has not been sent.` : `Delete "${chat.title}" from PocketBridge on this Mac and your phone?`)) return;
  try {
    if (!local) await api(`/chats/${encodeURIComponent(chat.id)}/delete`, {});
    delete localChats[chat.id]; delete drafts[chat.id]; delete overrides[chat.id];
    persistLocalChats(); persistDrafts(); persist('pocketbridge.options', overrides);
    app.selected = null; persist('pocketbridge.chat', null); clearPrompt();
    await refresh(); notice();
  } catch (error) { notice(error.message); }
};

$('messages').addEventListener('click', async event => {
  const button = event.target.closest('.copy-code, .copy-reply'); if (!button) return;
  const text = button.classList.contains('copy-reply') ? button.dataset.text : button.closest('.code-block').querySelector('code').textContent;
  try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy'; }, 1500); }
  catch { notice('Clipboard is unavailable. Select the text to copy it.'); }
});
setInterval(() => {
  for (const time of document.querySelectorAll('.working-time')) time.textContent = `· ${elapsedLabel(Date.now() - Number(time.dataset.since))}`;
  for (const time of document.querySelectorAll('.subagent-time.ticking')) time.textContent = `${time.dataset.lead}${elapsedLabel(Date.now() - Number(time.dataset.since))}`;
}, 1000);
