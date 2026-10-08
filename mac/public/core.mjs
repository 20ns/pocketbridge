// Shared by the browser client's modules: DOM helpers, saved state, the live session and the Mac API.
import {blankLocalDraft, statusLabel, avatarLetter, projectTone} from './support.mjs';

const generalIcon = '<svg viewBox="0 0 24 24"><path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/></svg>';

export const $ = id => document.getElementById(id);
export const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };

const saved = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
// Storage may be disabled or full; the live session still works, and false tells a sender its delivery ID wasn't kept.
// A tab another one took over writes nothing, so it can't overwrite that tab's delivery IDs.
export const persist = (key, value) => { if (app.passive) return false; try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };

/** The live session: what the Mac last reported and what this page is doing now. */
export const app = {
  token: null, state: null, online: false, sending: false, passive: false, agents: [],
  selected: saved('pocketbridge.chat', null),
  preferredProject: saved('pocketbridge.project', ''),
  lastAgent: saved('pocketbridge.lastAgent', 'claude'),
};

// Images still uploading when the page closed are dropped; finished ones are kept by id.
const storedDraft = draft => ({...draft, attachments: (draft.attachments ?? []).filter(item => item.id).map(({id, type}) => ({id, type}))});
export const drafts = Object.fromEntries(Object.entries(saved('pocketbridge.drafts', {})).map(([id, draft]) => [id, storedDraft(draft)]));
export const localChats = saved('pocketbridge.localChats', {});
// Options for the next prompt of a saved chat, and the last choice per agent for new chats.
export const overrides = saved('pocketbridge.options', {});
export const lastOptions = saved('pocketbridge.lastOptions', {});

export const persistDrafts = () => persist('pocketbridge.drafts', Object.fromEntries(Object.entries(drafts).map(([id, draft]) => [id, storedDraft(draft)])));
export function persistLocalChats() {
  const stored = {};
  for (const [id, chat] of Object.entries(localChats)) if (!blankLocalDraft(drafts[id])) stored[id] = chat;
  persist('pocketbridge.localChats', stored);
}
export function persistLastOptions(options) {
  lastOptions[options.agent] = options; app.lastAgent = options.agent;
  persist('pocketbridge.lastOptions', lastOptions); persist('pocketbridge.lastAgent', app.lastAgent);
}
export function discardBlankLocal(id) {
  if (!id || !localChats[id] || !blankLocalDraft(drafts[id])) return;
  delete localChats[id]; delete drafts[id];
  persistLocalChats(); persistDrafts();
}

export function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }

export async function api(path, body) {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials:'same-origin', cache:'no-store',
    headers: {...(app.token ? {Authorization:`Bearer ${app.token}`} : {}), ...(body === undefined ? {} : {'Content-Type':'application/json'})},
    body: body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(15000),
  });
  // A rotated local token (for example after resetting the Mac's data) is re-fetched by the reconnect loop.
  if (response.status === 401) app.token = null;
  const result = await readJson(response);
  if (!response.ok) throw Object.assign(new Error(result.error || `Mac returned ${response.status}`), {status: response.status});
  return result;
}

// An error page may not be JSON; its status still makes the message. A success must be JSON.
export const readJson = response => response.ok ? response.json() : response.json().catch(() => ({}));

// Images and project icons need the bearer token, so they load as object URLs. A failed load is tried again next time.
const blobs = new Map();
export function blobUrl(path) {
  if (!blobs.has(path)) {
    const loading = fetch(`/api${path}`, {headers:{Authorization:`Bearer ${app.token}`}}).then(async response => { if (!response.ok) throw new Error('Image unavailable'); return URL.createObjectURL(await response.blob()); });
    loading.catch(() => { if (blobs.get(path) === loading) blobs.delete(path); });
    blobs.set(path, loading);
  }
  return blobs.get(path);
}
export const imageUrl = id => blobUrl(`/uploads/${encodeURIComponent(id)}`);
export const rememberImage = (id, url) => blobs.set(`/uploads/${encodeURIComponent(id)}`, Promise.resolve(url));
// One icon per project: a new version replaces the old entry and frees its object URL.
const icons = new Map();
function iconUrl(project) {
  const path = `/projects/${encodeURIComponent(project.id)}/icon?v=${encodeURIComponent(project.icon)}`;
  const previous = icons.get(project.id);
  if (previous && previous !== path) { blobs.get(previous)?.then(url => URL.revokeObjectURL(url), () => {}); blobs.delete(previous); }
  icons.set(project.id, path);
  return blobUrl(path);
}

export const currentChat = () => app.state?.chats.find(chat => chat.id === app.selected) ?? localChats[app.selected];
export const storedChat = id => Boolean(app.state?.chats.some(chat => chat.id === id));
export const projectFor = chat => app.state?.projects.find(project => project.id === chat?.projectId);
export const projectName = chat => projectFor(chat)?.name ?? 'Project';
export const isGeneral = projectId => Boolean(app.state?.projects.find(project => project.id === projectId)?.general);
export const agentFor = id => app.agents.find(agent => agent.id === (id || 'claude'));
export const agentName = chat => agentFor(chat?.agent)?.name ?? 'Claude';
export const busy = (chat = currentChat()) => ['running','stopping','waiting'].includes(chat?.status);

export function statusBadge(status) {
  const badge = el('span', 'status'); badge.dataset.status = status ?? 'idle';
  badge.append(el('span', 'status-dot'), el('span', '', statusLabel(status)));
  badge.firstChild.setAttribute('aria-hidden', 'true');
  return badge;
}

/** A project's own logo when the Mac found one, else its first letter on a colour that stays with the project. */
export function projectAvatar(project, size = 'small') {
  const avatar = el('span', `avatar ${size}`); avatar.setAttribute('aria-hidden', 'true');
  if (!project) return avatar;
  // General chats belong to no project, so they get a plain chat mark instead of a project's colour or logo.
  if (project.general) { avatar.classList.add('general'); avatar.innerHTML = generalIcon; return avatar; }
  avatar.dataset.tone = projectTone(project.id); avatar.textContent = avatarLetter(project.name);
  if (project.icon) {
    // The icon tag versions the URL, so a changed logo isn't served from the browser cache.
    iconUrl(project).then(url => {
      const img = el('img'); img.alt = ''; img.src = url; avatar.replaceChildren(img); avatar.classList.add('logo');
    }, () => {});
  }
  return avatar;
}
