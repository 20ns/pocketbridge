// The composer: next-prompt options, images, "/" commands, the git line and delivery.
import {withAttachments, slashMatches, editDraft, prepareDelivery, afterDelivery, promptPayload, blankLocalDraft, usableAgent, findModel, resolveOptions, supportedOptions, modeLabels, effortLabel, modeHelp, modelName, effortName, speedName} from './support.mjs';
import {$, el, app, drafts, localChats, overrides, persist, persistDrafts, persistLocalChats, persistLastOptions, notice, api, imageUrl, rememberImage, currentChat, storedChat, agentFor, agentName, busy} from './core.mjs';
import {controls, refresh, renderState} from './app.mjs';
import {renderChatList} from './sidebar.mjs';

const optionKeys = ['agent', 'mode', 'model', 'effort', 'speed'];
export const sameOptions = (a, b) => optionKeys.every(key => (a?.[key] ?? '') === (b?.[key] ?? ''));
export const savedOptions = chat => ({agent: chat.agent || 'claude', mode: chat.mode, model: chat.model || 'default', effort: chat.effort || 'default', speed: chat.speed ?? null});
const optionsOf = draft => ({agent: draft.agent, mode: draft.mode, model: draft.model, effort: draft.effort, speed: draft.speed ?? null});

/** The open chat's next-prompt options. An attempted delivery keeps the options it was sent with. */
export function chatOptions(chat = currentChat()) {
  if (!chat) return null;
  const attempted = drafts[chat.id]?.attempted ? drafts[chat.id] : null;
  if (attempted?.mode) return {...optionsOf(attempted), agent: attempted.agent ?? chat.agent ?? 'claude'};
  const options = localChats[chat.id] ? savedOptions(localChats[chat.id]) : overrides[chat.id] ?? savedOptions(chat);
  const agent = agentFor(options.agent);
  return agent ? supportedOptions(agent, options) : options;
}
function setOptions(next) {
  const chat = currentChat(); if (!chat) return;
  if (localChats[chat.id]) { Object.assign(localChats[chat.id], next); persistLocalChats(); }
  else { if (sameOptions(next, savedOptions(chat))) delete overrides[chat.id]; else overrides[chat.id] = next; persist('pocketbridge.options', overrides); }
  persistLastOptions(next);
  renderOptions(); controls();
}
export function renderOptions() {
  const chat = currentChat(), options = chatOptions(chat);
  for (const id of ['model', 'effort', 'mode', 'speed-select']) $(id).replaceChildren();
  document.querySelector('.options').hidden = !options;
  if (!options) return;
  const agent = agentFor(options.agent) ?? {id: options.agent, name: options.agent, modes: [options.mode], models: [], defaultModel: options.model, defaultEffort: options.effort};
  // A chat that hasn't reached the Mac can still move to another agent; a saved one keeps its CLI.
  const unsent = !storedChat(chat.id) && !drafts[chat.id]?.attempted;
  const choices = unsent ? app.agents.filter(item => usableAgent(item) && item.models.length) : [agent];
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
  for (const effort of efforts.includes(shownEffort) ? efforts : [shownEffort, ...efforts]) $('effort').append(new Option(effort === shownEffort && options.effort === 'default' ? effortName(agent, options.model, 'default') : effortLabel(effort), effort));
  $('effort').value = shownEffort; $('effort').hidden = Boolean(current) && !current.efforts.length;
  renderSpeed(current?.speeds ?? [], options.speed ?? null);
  for (const mode of agent.modes.includes(options.mode) ? agent.modes : [options.mode, ...agent.modes]) { const option = new Option(modeLabels[mode] ?? mode, mode); option.title = modeHelp(agent.id, mode); $('mode').append(option); }
  $('mode').value = options.mode; $('mode').title = modeHelp(agent.id, options.mode);
  $('prompt').placeholder = `Message ${agent.name}`;
}
// Speed tiers come from the model's catalog entry: one is a toggle (Codex "Fast"), several a menu with standard first.
function renderSpeed(speeds, chosen) {
  $('speed').hidden = speeds.length !== 1; $('speed-select').hidden = speeds.length < 2;
  if (speeds.length === 1) {
    const [speed] = speeds;
    $('speed-label').textContent = speedName(speed); $('speed').title = speed.description ?? '';
    $('speed').setAttribute('aria-pressed', String(chosen === speed.id)); $('speed').dataset.speed = speed.id;
  } else if (speeds.length > 1) {
    $('speed-select').append(new Option('Standard', ''), ...speeds.map(speed => Object.assign(new Option(speedName(speed), speed.id), {title: speed.description ?? ''})));
    $('speed-select').value = chosen ?? '';
  }
}
$('model').onchange = () => {
  const [agentId, model] = $('model').value.split('|'), agent = agentFor(agentId);
  if (agent) setOptions(resolveOptions(agent, {...chatOptions(), agent: agentId, model}));
};
$('effort').onchange = () => setOptions({...chatOptions(), effort: $('effort').value});
$('mode').onchange = () => setOptions({...chatOptions(), mode: $('mode').value});
$('speed').onclick = () => { const options = chatOptions(); setOptions({...options, speed: options.speed === $('speed').dataset.speed ? null : $('speed').dataset.speed}); };
$('speed-select').onchange = () => setOptions({...chatOptions(), speed: $('speed-select').value || null});

export function autosize() {
  const prompt = $('prompt');
  prompt.style.height = 'auto';
  prompt.style.height = `${prompt.scrollHeight + 2}px`;
}

export function composerControls() {
  const chat = currentChat(), selected = app.selected, online = app.online;
  $('prompt').disabled = !chat;
  // A saved chat whose agent is switched off stays readable but can't continue until it's back on.
  const off = chat && storedChat(chat.id) && agentFor(chat.agent)?.enabled === false && !drafts[selected]?.attempted;
  const images = drafts[selected]?.attachments ?? [];
  const hasContent = Boolean($('prompt').value.trim()) || images.some(item => item.id);
  const uploading = images.some(item => item.uploading);
  // While a turn runs, Send steers it (Enter does too); Send now stops the current step and runs the message next.
  const working = busy(chat) && chat?.status !== 'stopping';
  $('send').disabled = !online || !chat || (busy(chat) && !working) || app.sending || off || uploading || !hasContent;
  $('send').setAttribute('aria-label', app.sending ? 'Sending' : drafts[selected]?.attempted ? 'Retry message' : working ? 'Steer' : 'Send');
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
  for (const id of ['model', 'effort', 'mode', 'speed', 'speed-select']) $(id).disabled = !chat || app.sending || Boolean(drafts[selected]?.attempted);
  $('composer-hint').textContent = !online ? 'Mac is disconnected. Your draft is saved on this device.' : off ? `${agentName(chat)} is off. Turn it on in the sidebar to continue this chat.` : chat?.status === 'waiting' ? 'Answer above, or stop this turn.' : busy(chat) ? 'Enter steers the running turn · Send now stops the current step first' : uploading ? 'Uploading images…' : drafts[selected]?.attempted ? 'Not confirmed by your Mac. Retry uses the same delivery ID.' : chat ? 'Enter to send · Shift+Enter for a new line' : 'Chats started here also appear on your phone.';
}

// Images: picked, pasted or dropped, shrunk to 2048 px JPEG when large, uploaded at once, sent by id.
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
  persistDrafts();
  if (localChats[chatId]) persistLocalChats();
  if (chatId === app.selected) { renderAttachments(); controls(); }
}
async function attach(files) {
  const chatId = app.selected; if (!chatId || drafts[chatId]?.attempted) return;
  for (const file of [...files].filter(item => item.type.startsWith('image/'))) {
    // Pastes can overlap, so the limit is checked against the draft as each image starts.
    if ((drafts[chatId]?.attachments?.length ?? 0) >= 8 || drafts[chatId]?.attempted) break;
    const key = crypto.randomUUID();
    setImages(chatId, list => [...list, {key, uploading: true, local: URL.createObjectURL(file)}]);
    try {
      const blob = await shrink(file);
      const response = await fetch('/api/uploads', {method:'POST', headers:{Authorization:`Bearer ${app.token}`, 'Content-Type': blob.type || file.type}, body: blob});
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Upload failed');
      rememberImage(result.id, URL.createObjectURL(blob));
      setImages(chatId, list => list.map(item => item.key === key ? {id: result.id, type: result.type} : item));
    } catch (error) { setImages(chatId, list => list.filter(item => item.key !== key)); notice(`Image not attached: ${error.message}`); }
  }
}
export function renderAttachments() {
  const list = drafts[app.selected]?.attachments ?? [];
  $('attachments').hidden = !list.length;
  $('attachments').replaceChildren(...list.map(item => {
    const thumb = el('div', `attachment${item.uploading ? ' uploading' : ''}`), img = el('img'); img.alt = '';
    if (item.local) img.src = item.local; else if (item.id) imageUrl(item.id).then(url => { img.src = url; }, () => {});
    thumb.append(img);
    if (!drafts[app.selected]?.attempted) { const remove = el('button', 'attachment-remove', '×'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove image'); remove.onclick = () => setImages(app.selected, current => current.filter(other => other !== item && (other.key ?? other.id) !== (item.key ?? item.id))); thumb.append(remove); }
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
let gitFor = null, gitAt = 0;
export async function loadGit(force = false) {
  const chat = currentChat(), projectId = chat?.projectId;
  if (!projectId || !app.token || (!force && gitFor === projectId && Date.now() - gitAt < 15000)) { if (!projectId) $('git-bar').hidden = true; return; }
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

// "/" lists the project's commands and skills for the chat's agent.
const commandCache = new Map();
let slashItems = [], slashIndex = 0;
export function hideSlash() { $('slash').hidden = true; slashItems = []; }
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
function moveSlash(step) {
  slashIndex = (slashIndex + step + slashItems.length) % slashItems.length; renderSlash();
  $('slash').children[slashIndex]?.scrollIntoView({block: 'nearest'});
}
function chooseSlash(index) {
  const command = slashItems[index]; if (!command) return;
  $('prompt').value = `/${command.name} `; hideSlash(); $('prompt').dispatchEvent(new Event('input')); $('prompt').focus();
}

/** Clears the prompt box, for a sent draft or a chat that is gone. */
export function clearPrompt() { $('prompt').value = ''; autosize(); }

$('prompt').oninput = () => {
  autosize(); updateSlash();
  const selected = app.selected;
  if (!selected) return;
  const wasBlank = blankLocalDraft(drafts[selected]);
  const next = editDraft(drafts[selected], $('prompt').value);
  if (next !== drafts[selected]) {
    if (localChats[selected]?.projectId) next.projectId = localChats[selected].projectId;
    drafts[selected] = next; persistDrafts();
    if (localChats[selected]) persistLocalChats();
    if (wasBlank !== blankLocalDraft(next)) renderChatList();
  }
  controls();
};
$('prompt').onkeydown = event => {
  // Keys during IME composition belong to the input method.
  if (slashItems.length && !event.isComposing) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveSlash(event.key === 'ArrowDown' ? 1 : -1); return; }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) { event.preventDefault(); chooseSlash(slashIndex); return; }
    if (event.key === 'Escape') { event.preventDefault(); hideSlash(); return; }
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); }
};
$('prompt').addEventListener('blur', () => setTimeout(hideSlash, 150));
$('send-now').onclick = () => submit('interrupt');
// Always ask to steer: the Mac runs it as a normal turn when idle, so a stale busy state can't make it 409.
// A retry keeps the delivery it was sent with, and so its id; Send now on a retry is a new delivery.
$('composer').onsubmit = event => { event.preventDefault(); submit(drafts[app.selected]?.attempted ? drafts[app.selected].delivery ?? null : 'steer'); };
async function submit(delivery) {
  if ($('send').disabled) return;
  const chatId = app.selected;
  const draft = prepareDelivery(drafts[chatId], $('prompt').value, chatOptions(), delivery);
  if (localChats[chatId]?.projectId) draft.projectId ??= localChats[chatId].projectId;
  drafts[chatId] = draft; persistDrafts(); if (localChats[chatId]) persistLocalChats(); app.sending = true; controls();
  const projectId = storedChat(chatId) ? undefined : (localChats[chatId]?.projectId ?? draft.projectId);
  try {
    await api(`/chats/${encodeURIComponent(chatId)}/prompts`, promptPayload(draft, projectId));
    delete overrides[chatId]; persist('pocketbridge.options', overrides);
    persistLastOptions(optionsOf(draft));
    // Text typed while sending stays; the images that were just sent don't.
    const left = afterDelivery(drafts[chatId], draft);
    if (left) drafts[chatId] = left; else delete drafts[chatId];
    persistDrafts();
    if (app.selected === chatId) { if (!left) clearPrompt(); renderAttachments(); }
    notice(); await refresh();
  } catch (error) {
    if (error.status === 410) {
      delete drafts[chatId]; delete localChats[chatId];
      persistDrafts(); persistLocalChats();
      if (app.selected === chatId) { app.selected = null; persist('pocketbridge.chat', null); clearPrompt(); }
      notice(error.message); renderState();
    } else if (drafts[chatId]?.id === draft.id && error.status >= 400 && error.status < 500 && error.status !== 408) {
      // A definitive rejection ran nothing: unlock the draft so its text and options can change.
      drafts[chatId] = {...drafts[chatId], attempted: false}; persistDrafts();
      notice(error.message); renderOptions();
    } else if (drafts[chatId]?.id === draft.id) notice(`${error.message}. Your message is saved. Retry will use the same delivery ID.`);
    else notice();
  }
  finally { app.sending = false; controls(); }
}
$('stop').onclick = async () => { $('stop').disabled = true; try { await api(`/chats/${encodeURIComponent(app.selected)}/stop`, {}); await refresh(); } catch (error) { notice(error.message); controls(); } };
