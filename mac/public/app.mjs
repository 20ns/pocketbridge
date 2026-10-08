// PocketBridge in the Mac browser: connects to the local service, keeps state in step and renders it.
// core.mjs holds shared state; sidebar, conversation, composer, usage and pairing own their parts of the page.
import {EventDecoder, agentsFrom, blankLocalDraft} from './support.mjs';
import {$, app, drafts, localChats, overrides, persist, persistDrafts, persistLocalChats, discardBlankLocal, notice, api, currentChat, busy} from './core.mjs';
import {renderProjects, renderChatList, renderCliStatus, renderAgentSwitches, loadSessions, sidebarControls, narrow, showDrawer, restoreSidebarScroll} from './sidebar.mjs';
import {renderHeader, headerControls, renderEmpty, clearConversation, loadMessages, cancelRename} from './conversation.mjs';
import {renderOptions, renderAttachments, composerControls, autosize, clearPrompt, hideSlash, loadGit, sameOptions, savedOptions, reconcileDrafts} from './composer.mjs';
import {loadUsage} from './usage.mjs';
import './pairing.mjs';

let seq = 0, refreshTimer, streamController, pendingRefresh = false, refreshing = false, previousBusy = false, refreshError = '';

export function controls() { sidebarControls(); headerControls(); composerControls(); }
function connection(connected, text) {
  app.online = connected;
  $('connection').dataset.state = connected ? 'online' : 'offline';
  $('connection-text').textContent = text;
  controls();
}

export function renderState() {
  renderProjects();
  app.agents = agentsFrom(app.state.capabilities);
  renderChatList();
  const chat = currentChat();
  renderHeader(chat);
  if (!chat) renderEmpty();
  renderCliStatus(); renderAgentSwitches(); restoreSidebarScroll();
  renderOptions(); autosize(); controls();
}
export async function selectChat(id) {
  if (id !== app.selected) discardBlankLocal(app.selected);
  app.selected = id; persist('pocketbridge.chat', id); cancelRename();
  $('prompt').value = drafts[id]?.text ?? ''; autosize();
  clearConversation();
  if (narrow.matches) showDrawer(false);
  renderState(); renderAttachments(); hideSlash(); loadGit(true);
  try { await loadMessages(); } catch (error) { notice(error.message); }
}

export async function refresh() {
  if (refreshing) { pendingRefresh = true; return; }
  refreshing = true;
  try {
    const state = app.state = await api('/state');
    let droppedLocal = false;
    for (const id of Object.keys(localChats)) if (state.chats.some(chat => chat.id === id)) { delete localChats[id]; droppedLocal = true; }
    for (const id of Object.keys(localChats)) if (id !== app.selected && blankLocalDraft(drafts[id])) { delete localChats[id]; delete drafts[id]; droppedLocal = true; }
    persistLocalChats();
    if (droppedLocal) persistDrafts();
    for (const [id, options] of Object.entries(overrides)) { const chat = state.chats.find(item => item.id === id); if (!chat || sameOptions(options, savedOptions(chat))) delete overrides[id]; }
    persist('pocketbridge.options', overrides);
    if (app.selected && !currentChat()) { app.selected = null; clearPrompt(); }
    const stopped = previousBusy && !busy(currentChat()); previousBusy = busy(currentChat());
    renderState(); await loadMessages();
    // Sequences only grow, so a lower lastSeq means a replaced database. Committed once state and messages are in.
    seq = state.lastSeq;
    if (refreshError && $('notice').textContent === refreshError) notice();
    refreshError = '';
    // A turn that ended used some of the plan, and may have hit its limit.
    if (stopped) { loadGit(true); loadUsage(true); }
  } catch (error) {
    // The stream may still look healthy: drop it so the connect loop fetches a token, refreshes and backs off.
    refreshError = error.message; streamController?.abort();
    throw error;
  } finally {
    refreshing = false;
    if (pendingRefresh) { pendingRefresh = false; scheduleRefresh(); }
  }
}
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh().catch(error => notice(error.message)); }, 250);
}

// The backoff can be cut short: coming back online or to the page retries at once, even mid-attempt.
let wake = null, woken = false;
const pause = ms => woken ? Promise.resolve(woken = false) : new Promise(resolve => {
  const timer = setTimeout(() => wake(), ms);
  wake = () => { clearTimeout(timer); wake = null; resolve(); };
});
function reconnectNow() { if (wake) wake(); else woken = true; streamController?.abort(); }
async function connect() {
  let retry = 1000;
  for (;;) {
    try {
      if (!app.token) app.token = (await api('/local-session')).token;
      await refresh();
      const controller = streamController = new AbortController();
      const opening = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(`/api/events?after=${seq}`, {headers:{Authorization:`Bearer ${app.token}`}, signal:controller.signal, cache:'no-store'}).finally(() => clearTimeout(opening));
      if (response.status === 401) app.token = null;
      if (!response.ok || !response.body) throw new Error(`Event connection failed (${response.status})`);
      connection(true, 'Connected to Mac'); notice(); retry = 1000; woken = false;
      loadUsage(); loadSessions(); loadGit(true); reconcileDrafts();
      const reader = response.body.getReader(); const decoder = new TextDecoder(); const events = new EventDecoder();
      let lastActivity = Date.now();
      const watchdog = setInterval(() => { if (Date.now() - lastActivity > 45000) controller.abort(); },10000);
      try {
        for (;;) {
          const {done,value} = await reader.read(); if (done) break;
          lastActivity = Date.now();
          for (const event of events.push(decoder.decode(value, {stream:true}))) {
            if (event.type !== 'change') continue;
            const change = JSON.parse(event.data);
            // A reset hint's sequence is committed by the refresh, once state and messages are fetched.
            if (Number.isSafeInteger(change.seq) && !change.reset) seq = Math.max(seq, change.seq);
            scheduleRefresh();
          }
        }
      } finally { clearInterval(watchdog); reader.releaseLock(); }
      throw new Error('Connection ended');
    } catch {
      connection(false, 'Reconnecting to Mac…');
      if (!app.state) notice('PocketBridge could not connect. Open this page through the Mac launcher. It will retry automatically.');
      await pause(retry); retry = Math.min(retry * 2, 10000);
    }
  }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) { scheduleRefresh(); if (!app.online) reconnectNow(); } });
window.addEventListener('online', reconnectNow);
$('prompt').value = drafts[app.selected]?.text ?? '';
// Size once styles are applied; module scripts can run before the stylesheet settles.
requestAnimationFrame(autosize); addEventListener('resize', autosize);
connect();
