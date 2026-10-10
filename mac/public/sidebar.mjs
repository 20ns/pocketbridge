// The sidebar: projects, recent chats, sessions to continue and the agent switches.
import {relativeTime, blankLocalDraft, usableAgent, newChatAgent, resolveOptions, modelName, projectNameProblem, newProjectAttempt, settleProjectAttempt, projectChoices, scheduleTime} from './support.mjs';
import {$, el, app, drafts, localChats, lastOptions, persist, notice, api, projectFor, projectName, agentFor, statusBadge, projectAvatar, isGeneral} from './core.mjs';
import {controls, refresh, selectChat} from './app.mjs';
import {loadUsage} from './usage.mjs';

export function sidebarControls() {
  $('new-chat').disabled = !app.online || !$('project-select').value;
  $('project-select').disabled = !app.online || !app.state?.projects.length;
}

export function renderProjects() {
  const projectSelect = $('project-select'), projects = app.state.projects, {general, folders} = projectChoices(projects);
  const chosenProject = projects.some(p => p.id === projectSelect.value) ? projectSelect.value : app.preferredProject;
  projectSelect.replaceChildren();
  if (!projects.length) projectSelect.append(new Option('Register a project folder', ''));
  // General (no project) comes first, set apart from the project folders.
  if (general) {
    projectSelect.append(new Option(general.name || 'General', general.id));
    if (folders.length) { const group = document.createElement('optgroup'); group.label = 'Projects'; group.append(...folders.map(project => new Option(project.name, project.id))); projectSelect.append(group); }
  } else for (const project of folders) projectSelect.append(new Option(project.name, project.id));
  if (projects.some(p => p.id === chosenProject)) projectSelect.value = chosenProject;
  else if (general && folders.length) projectSelect.value = folders[0].id;
  renderProjectAvatar();
  // New projects need the Mac's experiments folder; without one the option stays hidden.
  const experiments = app.state.server?.experiments;
  $('new-project').hidden = !experiments;
  if (!experiments) toggleNewProjectForm(false);
  else if (!('problem' in $('new-project-hint').dataset)) $('new-project-hint').textContent = `Creates an empty folder in ${experiments}.`;
}
function renderProjectAvatar() {
  const project = app.state?.projects.find(item => item.id === $('project-select').value);
  $('project-avatar').replaceWith(Object.assign(projectAvatar(project, 'medium'), {id: 'project-avatar'}));
  $('project-avatar').hidden = !project;
}

export function renderChatList() {
  const list = $('chat-list'), state = app.state;
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.chatId : null;
  list.replaceChildren();
  const chats = [...state.chats, ...Object.values(localChats).filter(chat => !state.chats.some(item => item.id === chat.id) && (chat.id === app.selected || !blankLocalDraft(drafts[chat.id])))].sort((a,b) => b.updatedAt - a.updatedAt);
  if (!chats.length) list.append(el('p', 'muted', 'New chats will appear here. They stay on this Mac.'));
  for (const chat of chats) {
    const button = el('button', 'chat-item'); button.type = 'button'; button.dataset.chatId = chat.id;
    // Claude chats carry a warm hint and Codex chats a cool one.
    button.dataset.agent = chat.agent || 'claude';
    button.classList.toggle('selected', chat.id === app.selected);
    if (chat.id === app.selected) button.setAttribute('aria-current', 'true');
    const meta = el('span', 'chat-item-meta');
    const when = el('time', '', relativeTime(chat.updatedAt)); when.dateTime = new Date(chat.updatedAt).toISOString(); when.title = new Date(chat.updatedAt).toLocaleString();
    const where = el('span', 'chat-item-where');
    where.append(projectAvatar(projectFor(chat), 'tiny'), `${projectName(chat)} · `, when);
    // A chat waiting to send itself says when, in place of the model.
    meta.append(where, chat.status && chat.status !== 'idle' ? statusBadge(chat.status) : chat.scheduled ? el('span', 'chat-item-model chat-item-scheduled', `Scheduled ${scheduleTime(chat.scheduled.notBefore)}`) : el('span', 'chat-item-model', modelName(agentFor(chat.agent) ?? {name: chat.agent === 'codex' ? 'Codex' : 'Claude', models: []}, chat.model || 'default')));
    const preview = chat.preview ?? (localChats[chat.id] ? drafts[chat.id]?.text : '');
    button.append(el('span', 'chat-item-title', chat.title));
    if (preview) button.append(el('span', 'chat-item-preview', preview));
    button.append(meta);
    button.onclick = () => selectChat(chat.id);
    list.append(button);
    if (chat.id === focused) button.focus();
  }
}

// The sidebar keeps its scroll position across reloads. It is restored once the whole sidebar has rendered and again
// when the sessions list arrives, unless the sidebar has been scrolled by then; only the owner's scrolling is saved.
const scrollTarget = (() => { try { return Number(localStorage.getItem('pocketbridge.sidebarScroll')) || 0; } catch { return 0; } })();
const restoredPhases = new Set();
let ownScroll = false;
export function restoreSidebarScroll(phase = 'render') {
  if (ownScroll || restoredPhases.has(phase)) return;
  restoredPhases.add(phase);
  $('sidebar').scrollTop = scrollTarget;
}
const markOwnScroll = () => { ownScroll = true; };
for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) $('sidebar').addEventListener(type, markOwnScroll, {passive: true});
let scrollSave;
$('sidebar').addEventListener('scroll', () => {
  if (!ownScroll) return;
  clearTimeout(scrollSave); scrollSave = setTimeout(() => persist('pocketbridge.sidebarScroll', $('sidebar').scrollTop), 200);
}, {passive: true});
setInterval(() => { if (app.state) renderChatList(); }, 60000);

/** The setup note when neither agent can start a chat. */
export function renderCliStatus() {
  const ready = app.agents.some(usableAgent);
  $('cli-status').textContent = ready ? '' : app.agents.some(agent => agent.available) ? 'Claude and Codex are both off. Turn one on below.' : 'Neither Claude Code nor Codex was found. Sign in with an official CLI on this Mac, then restart Felva.';
  $('cli-status').hidden = ready;
}

// Sessions from Terminal or the desktop apps in the chosen project, to continue here.
export async function loadSessions() {
  const projectId = $('project-select').value;
  // General chats run in the home folder; its sessions aren't offered to continue.
  if (!projectId || !app.token || isGeneral(projectId)) { $('sessions').hidden = true; return; }
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
    restoreSidebarScroll('sessions');
  } catch { $('sessions').hidden = true; }
}

// One switch per agent, shared with the phone. Off skips its probes, discovery and new turns.
export function renderAgentSwitches() {
  $('agent-switches').replaceChildren(...app.agents.map(agent => {
    const row = el('label', 'agent-switch'), input = el('input');
    row.dataset.agent = agent.id;
    input.type = 'checkbox'; input.role = 'switch'; input.checked = agent.enabled !== false; input.disabled = !agent.available || !app.online;
    input.onchange = async () => {
      input.disabled = true;
      try { await api(`/agents/${agent.id}`, {enabled: input.checked}); await refresh(); loadUsage(true); notice(); }
      catch (error) { input.checked = !input.checked; notice(error.message); }
      finally { input.disabled = !agent.available || !app.online; }
    };
    const text = el('span', 'agent-switch-text'); text.append(el('span', 'agent-switch-name', agent.id === 'claude' ? 'Claude Code' : agent.name), el('span', 'muted', !agent.available ? 'Not installed' : agent.enabled === false ? 'Off' : modelName(agent, agent.defaultModel)));
    row.append(text, input);
    return row;
  }));
}

// Narrow windows show projects and chats as a drawer.
export const narrow = matchMedia('(max-width: 759px)');
export function showDrawer(show) {
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

$('project-select').onchange = () => { app.preferredProject = $('project-select').value; persist('pocketbridge.project', app.preferredProject); renderProjectAvatar(); controls(); loadSessions(); };
export function toggleProjectForm(show = $('project-form').hidden) { $('project-form').hidden = !show; $('add-project').setAttribute('aria-expanded', String(show)); if (show) { toggleNewProjectForm(false); $('project-path').focus(); } }
$('add-project').onclick = () => toggleProjectForm();
function toggleNewProjectForm(show = $('new-project-form').hidden) { $('new-project-form').hidden = !show; $('new-project').setAttribute('aria-expanded', String(show)); if (show) { toggleProjectForm(false); $('new-project-name').focus(); } }
$('new-project').onclick = () => toggleNewProjectForm();

// New project: an empty folder in the Mac's experiments folder, then a new chat in it.
// One id per attempt; an unknown result keeps it, so retrying the same name can't make a second folder.
// A pending attempt survives a reload, so retrying the same name after an unknown result still reuses its id.
let projectAttempt = (() => { try { return JSON.parse(localStorage.getItem('pocketbridge.projectAttempt')); } catch { return null; } })();
const keepAttempt = attempt => { projectAttempt = attempt; persist('pocketbridge.projectAttempt', attempt); };
function showNameProblem(problem) {
  const hint = $('new-project-hint');
  if (problem) { hint.dataset.problem = problem; hint.textContent = problem; }
  else { delete hint.dataset.problem; hint.textContent = `Creates an empty folder in ${app.state?.server?.experiments ?? 'the experiments folder'}.`; }
  $('new-project-name').setAttribute('aria-invalid', String(Boolean(problem)));
}
$('new-project-name').oninput = () => { const value = $('new-project-name').value; showNameProblem(value.trim() ? projectNameProblem(value) : null); };
$('new-project-form').onsubmit = async event => {
  event.preventDefault();
  const name = $('new-project-name').value.trim(), problem = projectNameProblem(name);
  showNameProblem(problem); if (problem) { $('new-project-name').focus(); return; }
  const button = event.submitter ?? $('new-project-form').querySelector('button'); button.disabled = true;
  keepAttempt(newProjectAttempt(projectAttempt, name));
  try {
    const project = await api('/projects/new', {id: projectAttempt.id, name});
    keepAttempt(null);
    app.preferredProject = project.id; persist('pocketbridge.project', project.id);
    $('new-project-form').reset(); showNameProblem(null); toggleNewProjectForm(false);
    await refresh(); notice();
    $('project-select').value = project.id; renderProjectAvatar(); loadSessions();
    await startChat(project.id);
  } catch (error) {
    keepAttempt(settleProjectAttempt(projectAttempt, error));
    if (error.status === 400 || error.status === 409) showNameProblem(error.message); else notice(projectAttempt ? `${error.message}. Create again to retry; it won't make a second folder.` : error.message);
  } finally { button.disabled = false; }
};
$('project-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { const project = await api('/projects', {path:$('project-path').value.trim(),name:$('project-name').value.trim() || undefined}); app.preferredProject = project.id; persist('pocketbridge.project', project.id); $('project-form').reset(); $('project-form').hidden = true; $('add-project').setAttribute('aria-expanded','false'); await refresh(); notice(); }
  catch (error) { notice(error.message); } finally { button.disabled = false; }
};
$('new-chat').onclick = () => startChat($('project-select').value);
/** A local draft chat in the project; it reaches the Mac with its first prompt. */
async function startChat(projectId) {
  if (!projectId) return;
  $('new-chat').disabled = true;
  const id = crypto.randomUUID();
  // New chats start from the last model, effort, speed and mode used with that agent.
  const agentId = newChatAgent(app.agents, app.lastAgent);
  if (!agentId) { notice('Claude and Codex are both off. Turn one on in the sidebar.'); controls(); return; }
  const agent = agentFor(agentId);
  const options = agent ? resolveOptions(agent, lastOptions[agent.id]) : {agent:'claude', mode:'bypassPermissions', model:'default', effort:'default', speed:null};
  localChats[id] = {id, projectId, title:'New chat', ...options, status:'idle', updatedAt:Date.now()};
  try { await selectChat(id); notice(); markOwnScroll(); $('chat-list').querySelector('.selected')?.scrollIntoView({block: 'nearest'}); $('prompt').focus(); }
  finally { controls(); }
}
