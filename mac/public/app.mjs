import {EventDecoder, markdown, statusLabel, relativeTime, groupMessages, activitySummary} from './support.mjs';

const $ = id => document.getElementById(id);
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const labels = {bypassPermissions:'Bypass permissions', auto:'Auto', acceptEdits:'Accept edits', plan:'Plan', default:'Manual'};
const modeHelp = {
  bypassPermissions:'Claude can run commands and edit files without asking.',
  auto:'Claude works on its own while a safety check blocks risky actions.',
  acceptEdits:'Claude edits files freely and asks before running commands.',
  plan:'Claude explores and proposes a plan before changing anything.',
  default:'Claude asks before editing files or running commands.',
};
const liveText = {idle:'Claude finished. Ready for your next message.', running:'Claude is working.', waiting:'Claude needs your answer.', stopping:'Stopping.', interrupted:'Work stopped.', error:'This turn failed.'};
let token, state, selected, online = false, sending = false, seq = 0, refreshTimer, streamController, pairLink, qrUrl;
let pendingRefresh = false, refreshing = false, messagesGeneration = 0;
let draftMode = null, approvalsSignature = null, modesKey = null, announced = {};
const saved = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const persist = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage may be disabled; the live session still works. */ } };
let drafts = saved('pocketbridge.drafts', {});
let preferredProject = saved('pocketbridge.project', '');
let preferredMode = saved('pocketbridge.mode', 'bypassPermissions');
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
  if (!response.ok) throw new Error(result.error || `Mac returned ${response.status}`);
  return result;
}
function currentChat() { return state?.chats.find(chat => chat.id === selected); }
function projectName(chat) { return state?.projects.find(p => p.id === chat.projectId)?.name ?? 'Project'; }
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
  $('send').disabled = !online || !chat || busy(chat) || sending || !$('prompt').value.trim();
  $('send').textContent = sending ? 'Sending…' : drafts[selected]?.attempted ? 'Retry message' : 'Send message';
  $('stop').hidden = !busy(chat);
  $('stop').disabled = !online || chat?.status === 'stopping';
  $('stop').lastChild.textContent = chat?.status === 'stopping' ? 'Stopping…' : 'Stop';
  $('mode').disabled = busy(chat) || sending || Boolean(drafts[selected]?.attempted);
  $('composer-hint').textContent = !online ? 'Mac is disconnected. Your draft is saved on this device.' : chat?.status === 'waiting' ? 'Answer Claude above, or stop this turn.' : busy(chat) ? 'Claude is working. Stop this turn before sending another message.' : chat ? 'Enter to send · Shift+Enter for a new line' : 'Chats started here also appear on your phone.';
}
function renderChatList() {
  const list = $('chat-list');
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.chatId : null;
  list.replaceChildren();
  const chats = [...state.chats].sort((a,b) => b.updatedAt - a.updatedAt);
  if (!chats.length) list.append(el('p', 'muted', 'New chats will appear here. They stay on this Mac.'));
  for (const chat of chats) {
    const button = el('button', 'chat-item'); button.type = 'button'; button.dataset.chatId = chat.id;
    button.classList.toggle('selected', chat.id === selected);
    if (chat.id === selected) button.setAttribute('aria-current', 'true');
    const meta = el('span', 'chat-item-meta');
    const when = el('time', '', relativeTime(chat.updatedAt)); when.dateTime = new Date(chat.updatedAt).toISOString(); when.title = new Date(chat.updatedAt).toLocaleString();
    const where = el('span', 'chat-item-where', `${projectName(chat)} · `); where.append(when);
    meta.append(where, statusBadge(chat.status));
    button.append(el('span', 'chat-item-title', chat.title), meta);
    button.onclick = () => selectChat(chat.id);
    list.append(button);
    if (chat.id === focused) button.focus();
  }
}
function renderEmpty() {
  const empty = el('div', 'empty');
  if (!state?.projects.length) {
    empty.append(el('h2', '', 'Start with a project'), el('p', '', 'Register a folder on this Mac, then create a chat. Claude works here while your phone comes and goes.'));
    const add = el('button', '', 'Add a project folder'); add.type = 'button'; add.onclick = () => { showDrawer(true); toggleProjectForm(true); };
    empty.append(add);
  } else {
    empty.append(el('h2', '', 'Open a chat'), el('p', '', 'Choose a recent chat, or pick a project and start a new one. Claude keeps working on this Mac while your phone comes and goes.'));
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
  const available = state.capabilities?.modes ?? Object.keys(labels);
  const modeValue = drafts[selected]?.attempted ? drafts[selected].mode ?? currentChat()?.mode : draftMode ?? currentChat()?.mode ?? preferredMode;
  if (modesKey !== available.join()) {
    modesKey = available.join(); $('mode').replaceChildren();
    for (const mode of Object.keys(labels)) {
      const option = new Option(labels[mode] + (available.includes(mode) ? '' : ' · unavailable'), mode);
      option.disabled = !available.includes(mode); $('mode').append(option);
    }
  }
  $('mode').value = modeValue;
  $('mode-help').textContent = modeHelp[$('mode').value] ?? '';
  renderChatList();
  const chat = currentChat();
  $('chat-title').textContent = chat?.title ?? 'Your Mac, from anywhere';
  if (chat) $('chat-meta').replaceChildren(el('span', 'chat-project', projectName(chat)), statusBadge(chat.status));
  else $('chat-meta').textContent = state.projects.length ? 'Choose a chat or start a new one.' : 'Choose a project to start a chat.';
  if (chat && announced.chat === chat.id && announced.status !== chat.status) $('chat-live').textContent = liveText[chat.status] ?? '';
  announced = {chat:chat?.id, status:chat?.status};
  if (!chat) renderEmpty();
  $('cli-status').textContent = state.server.claudeAvailable ? '' : 'Claude Code was not found. Sign in with the official CLI on this Mac, then restart PocketBridge.';
  $('cli-status').hidden = state.server.claudeAvailable;
  controls();
}
async function selectChat(id) {
  selected = id; draftMode = drafts[id]?.mode ?? null; approvalsSignature = null; persist('pocketbridge.chat', id);
  $('prompt').value = drafts[id]?.text ?? ''; autosize();
  $('log').replaceChildren(); $('approvals').replaceChildren(); $('approvals').hidden = true;
  if (narrow.matches) showDrawer(false);
  renderState();
  try { await loadMessages(); } catch (error) { notice(error.message); }
}
function renderMessage(message) {
  const article = el('article', `message ${message.role}`);
  const body = el('div', 'message-body');
  if (message.role === 'user') body.textContent = message.text; else body.append(markdown(message.text));
  article.append(el('div', 'message-label', message.role === 'user' ? 'You' : 'Claude'), body);
  return article;
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
function renderStatusNote(chat, hasApprovals) {
  if (chat.status === 'running' || chat.status === 'stopping' || chat.status === 'waiting') {
    const note = el('div', 'working'); note.dataset.status = chat.status;
    const text = chat.status === 'running' ? 'Claude is working…' : chat.status === 'stopping' ? 'Stopping…' : hasApprovals ? 'Waiting for your answer below' : 'Waiting for your answer';
    note.append(el('span', 'working-mark'), el('span', '', text)); note.firstChild.setAttribute('aria-hidden', 'true');
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
async function loadMessages() {
  const id = selected;
  if (!id || !currentChat()) return;
  const generation = ++messagesGeneration;
  const result = await api(`/chats/${encodeURIComponent(id)}/messages`);
  if (id !== selected || generation !== messagesGeneration) return;
  const pendingDraft = drafts[id];
  if (pendingDraft?.attempted && result.messages.some(message => message.role === 'user' && message.id === pendingDraft.id)) {
    delete drafts[id]; persist('pocketbridge.drafts',drafts); $('prompt').value = ''; autosize(); draftMode = null; controls();
  }
  const chat = currentChat();
  const scroller = $('messages'), target = $('log');
  const previousScroll = scroller.scrollTop;
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
  const open = new Set([...target.querySelectorAll('details[open]')].map(node => node.dataset.id));
  target.replaceChildren();
  if (!result.messages.length && !busy(chat)) {
    const empty = el('div', 'empty');
    empty.append(el('h2', '', 'What should Claude do?'), el('p', '', 'Send a task or ask a question about this project. Work continues if you leave the app.'));
    target.append(empty);
  }
  for (const item of groupMessages(result.messages)) target.append(item.type === 'message' ? renderMessage(item.message) : renderActivity(item, open));
  const pending = (result.approvals ?? []).some(approval => approval.status === 'pending');
  const note = chat && renderStatusNote(chat, pending); if (note) target.append(note);
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
    if (selected && !state.chats.some(chat => chat.id === selected)) { selected = null; $('prompt').value = ''; autosize(); }
    renderState(); await loadMessages();
  } finally {
    refreshing = false;
    if (pendingRefresh) { pendingRefresh = false; scheduleRefresh(); }
  }
}
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh().catch(error => notice(error.message)); }, 250);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect() {
  let retry = 1000;
  for (;;) {
    try {
      if (!token) token = (await api('/local-session')).token;
      await refresh();
      connection(true, 'Connected to Mac'); notice(); retry = 1000;
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

$('project-select').onchange = () => { preferredProject = $('project-select').value; persist('pocketbridge.project', preferredProject); controls(); };
$('mode').onchange = () => {
  draftMode = preferredMode = $('mode').value; persist('pocketbridge.mode', preferredMode);
  $('mode-help').textContent = modeHelp[draftMode] ?? '';
  if (drafts[selected] && !drafts[selected].attempted) { drafts[selected].mode = draftMode; persist('pocketbridge.drafts',drafts); }
};
function toggleProjectForm(show = $('project-form').hidden) { $('project-form').hidden = !show; $('add-project').setAttribute('aria-expanded', String(show)); if (show) $('project-path').focus(); }
$('add-project').onclick = () => toggleProjectForm();
$('project-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { const project = await api('/projects', {path:$('project-path').value.trim(),name:$('project-name').value.trim() || undefined}); preferredProject = project.id; persist('pocketbridge.project', project.id); $('project-form').reset(); $('project-form').hidden = true; $('add-project').setAttribute('aria-expanded','false'); await refresh(); notice(); }
  catch (error) { notice(error.message); } finally { button.disabled = false; }
};
$('new-chat').onclick = async () => {
  $('new-chat').disabled = true;
  try { const chat = await api('/chats', {projectId:$('project-select').value,mode:$('mode').value}); await refresh(); await selectChat(chat.id); notice(); $('prompt').focus(); }
  catch (error) { notice(error.message); } finally { controls(); }
};
$('prompt').oninput = () => {
  autosize();
  if (!selected) return;
  drafts[selected] = {text:$('prompt').value,id:crypto.randomUUID(),mode:$('mode').value,attempted:false}; persist('pocketbridge.drafts',drafts); controls();
};
$('prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); } };
$('composer').onsubmit = async event => {
  event.preventDefault(); if ($('send').disabled) return;
  const chatId = selected;
  const draft = drafts[chatId] ?? {text:$('prompt').value,id:crypto.randomUUID(),mode:$('mode').value};
  draft.mode ??= $('mode').value;
  draft.attempted = true; drafts[chatId] = draft; persist('pocketbridge.drafts',drafts); sending = true; controls();
  try {
    await api(`/chats/${encodeURIComponent(chatId)}/prompts`, {id:draft.id,text:draft.text.trim(),mode:draft.mode});
    draftMode = null;
    if (drafts[chatId]?.id === draft.id) { delete drafts[chatId]; persist('pocketbridge.drafts',drafts); if (selected === chatId) { $('prompt').value = ''; autosize(); } }
    notice(); await refresh();
  } catch (error) {
    if (drafts[chatId]?.id === draft.id) notice(`${error.message}. Your message is saved. Retry will use the same delivery ID.`);
    else notice();
  }
  finally { sending = false; controls(); }
};
$('stop').onclick = async () => { $('stop').disabled = true; try { await api(`/chats/${encodeURIComponent(selected)}/stop`, {}); await refresh(); } catch (error) { notice(error.message); controls(); } };
$('messages').addEventListener('click', async event => {
  const button = event.target.closest('.copy-code'); if (!button) return;
  try { await navigator.clipboard.writeText(button.closest('.code-block').querySelector('code').textContent); button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy'; }, 1500); }
  catch { notice('Clipboard is unavailable. Select the code to copy it.'); }
});

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
autosize();
connect();
