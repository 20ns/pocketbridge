// The sidebar: projects, recent chats, sessions to continue and the agent switches.
import {relativeTime, blankLocalDraft, usableAgent, newChatAgent, resolveOptions, modelName} from './support.mjs';
import {$, el, app, drafts, localChats, lastOptions, persist, notice, api, projectFor, projectName, agentFor, statusBadge, projectAvatar} from './core.mjs';
import {controls, refresh, selectChat} from './app.mjs';
import {loadUsage} from './usage.mjs';

export function sidebarControls() {
  $('new-chat').disabled = !app.online || !$('project-select').value;
  $('project-select').disabled = !app.online || !app.state?.projects.length;
}

export function renderProjects() {
  const projectSelect = $('project-select'), projects = app.state.projects;
  const chosenProject = projects.some(p => p.id === projectSelect.value) ? projectSelect.value : app.preferredProject;
  projectSelect.replaceChildren();
  if (!projects.length) projectSelect.append(new Option('Register a project folder', ''));
  for (const project of projects) projectSelect.append(new Option(project.name, project.id));
  if (projects.some(p => p.id === chosenProject)) projectSelect.value = chosenProject;
  renderProjectAvatar();
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
    meta.append(where, chat.status && chat.status !== 'idle' ? statusBadge(chat.status) : el('span', 'chat-item-model', modelName(agentFor(chat.agent) ?? {name: chat.agent === 'codex' ? 'Codex' : 'Claude', models: []}, chat.model || 'default')));
    const preview = chat.preview ?? (localChats[chat.id] ? drafts[chat.id]?.text : '');
    button.append(el('span', 'chat-item-title', chat.title));
    if (preview) button.append(el('span', 'chat-item-preview', preview));
    button.append(meta);
    button.onclick = () => selectChat(chat.id);
    list.append(button);
    if (chat.id === focused) button.focus();
  }
}
setInterval(() => { if (app.state) renderChatList(); }, 60000);

/** The setup note when neither agent can start a chat. */
export function renderCliStatus() {
  const ready = app.agents.some(usableAgent);
  $('cli-status').textContent = ready ? '' : app.agents.some(agent => agent.available) ? 'Claude and Codex are both off. Turn one on below.' : 'Neither Claude Code nor Codex was found. Sign in with an official CLI on this Mac, then restart PocketBridge.';
  $('cli-status').hidden = ready;
}

// Sessions from Terminal or the desktop apps in the chosen project, to continue here.
export async function loadSessions() {
  const projectId = $('project-select').value;
  if (!projectId || !app.token) { $('sessions').hidden = true; return; }
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
export function toggleProjectForm(show = $('project-form').hidden) { $('project-form').hidden = !show; $('add-project').setAttribute('aria-expanded', String(show)); if (show) $('project-path').focus(); }
$('add-project').onclick = () => toggleProjectForm();
$('project-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { const project = await api('/projects', {path:$('project-path').value.trim(),name:$('project-name').value.trim() || undefined}); app.preferredProject = project.id; persist('pocketbridge.project', project.id); $('project-form').reset(); $('project-form').hidden = true; $('add-project').setAttribute('aria-expanded','false'); await refresh(); notice(); }
  catch (error) { notice(error.message); } finally { button.disabled = false; }
};
$('new-chat').onclick = async () => {
  const projectId = $('project-select').value;
  if (!projectId) return;
  $('new-chat').disabled = true;
  const id = crypto.randomUUID();
  // New chats start from the last model, effort, speed and mode used with that agent.
  const agentId = newChatAgent(app.agents, app.lastAgent);
  if (!agentId) { notice('Claude and Codex are both off. Turn one on in the sidebar.'); controls(); return; }
  const agent = agentFor(agentId);
  const options = agent ? resolveOptions(agent, lastOptions[agent.id]) : {agent:'claude', mode:'bypassPermissions', model:'default', effort:'default', speed:null};
  localChats[id] = {id, projectId, title:'New chat', ...options, status:'idle', updatedAt:Date.now()};
  try { await selectChat(id); notice(); $('prompt').focus(); }
  finally { controls(); }
};
