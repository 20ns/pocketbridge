// Plan usage from each CLI on the Mac. The header shows each agent's weekly ring; the panel lists every limit
// and Codex's banked limit resets.
import {resetLabel, usageRings, nextCredit, resetAttempt, settleReset, resetPrompt, resetOutcomes} from './support.mjs';
import {$, el, app, persist, api} from './core.mjs';

let usageAt = 0, latest = [], resetMessage = '', resetting = false;
// A reset request whose answer never arrived; retrying sends the same idempotency key.
let pendingReset = (() => { try { return JSON.parse(localStorage.getItem('pocketbridge.pendingReset')); } catch { return null; } })();

export async function loadUsage(force = false) {
  if (!app.token || (!force && Date.now() - usageAt < 60000)) return;
  usageAt = Date.now();
  try { latest = (await api('/usage')).agents ?? []; renderUsage(); usageListeners.forEach(listener => listener()); } catch { /* An older Mac service has no usage; keep the header quiet. */ }
}
/** The last plan limits the Mac reported for an agent, for "Send at reset". */
export const limitsOf = agentId => latest.find(agent => agent.id === agentId)?.limits ?? [];
const usageListeners = new Set();
export const onUsage = listener => usageListeners.add(listener);

function ring(agentId, percent) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('usage-ring'); svg.dataset.agent = agentId;
  for (const [className, length] of [['ring-track', 100], ['ring-fill', percent]]) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    Object.entries({cx: 10, cy: 10, r: 7.5, pathLength: 100, 'stroke-dasharray': `${length} 100`, class: className}).forEach(([key, value]) => circle.setAttribute(key, value));
    svg.append(circle);
  }
  return svg;
}

function renderUsage() {
  const listed = latest.filter(agent => agent.limits?.length);
  $('usage-toggle').hidden = !listed.length;
  if (!listed.length) return;
  const rings = usageRings(latest);
  $('usage-toggle').replaceChildren(...rings.map(({id, limit}) => {
    const item = el('span', 'usage-item'); item.dataset.severity = limit.severity;
    item.append(ring(id, limit.percent), el('span', 'usage-percent', `${limit.percent}%`));
    return item;
  }));
  $('usage-toggle').title = rings.map(({name, limit}) => `${name} ${limit.label.toLowerCase()}: ${limit.percent}% used`).join('\n');
  $('usage-toggle').setAttribute('aria-label', `Plan usage. ${rings.map(({name, limit}) => `${name} ${limit.label}: ${limit.percent}%`).join(', ')}`);
  $('usage-panel').replaceChildren(...listed.map(agent => {
    const section = el('section', 'usage-agent'); section.dataset.agent = agent.id;
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
    if (agent.id === 'codex' && agent.resets) section.append(renderResets(agent.resets));
    return section;
  }));
}

// Banked Codex resets clear its limits at once. Each attempt has one idempotency key, kept until the Mac answers.
function renderResets(resets) {
  const box = el('div', 'usage-resets');
  const line = el('div', 'usage-line');
  line.append(el('span', '', 'Limit resets'), el('strong', '', resets.available ? `${resets.available} available` : 'None'));
  box.append(line);
  const credit = nextCredit(resets);
  if (credit?.expiresAt) box.append(el('p', 'usage-reset', `Next expires ${new Date(credit.expiresAt).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})}`));
  if (resets.available > 0 || pendingReset) {
    const button = el('button', 'quiet small usage-use-reset', resetting ? 'Resetting…' : pendingReset ? 'Retry reset' : 'Use a reset');
    button.type = 'button'; button.disabled = resetting || !app.online;
    if (credit?.title || credit?.description) button.title = [credit.title, credit.description].filter(Boolean).join('. ');
    button.onclick = () => useReset(resets);
    box.append(button);
  }
  if (resetMessage) box.append(el('p', 'usage-outcome', resetMessage));
  return box;
}
async function useReset(resets) {
  if (resetting) return;
  if (!pendingReset && !confirm(resetPrompt(resets.available))) return;
  pendingReset = resetAttempt(pendingReset, nextCredit(resets)?.id ?? null);
  persist('pocketbridge.pendingReset', pendingReset);
  resetting = true; resetMessage = ''; renderUsage();
  let failure = null;
  try {
    const {outcome} = await api('/usage/codex/reset', {id: pendingReset.id, ...(pendingReset.creditId ? {creditId: pendingReset.creditId} : {})});
    resetMessage = resetOutcomes[outcome] ?? 'Reset finished.';
  } catch (error) { failure = error; }
  pendingReset = settleReset(pendingReset, failure);
  persist('pocketbridge.pendingReset', pendingReset);
  if (failure) resetMessage = pendingReset ? `${failure.message}. Retry uses the same request, so at most one reset is used.` : failure.message;
  resetting = false; renderUsage();
  await loadUsage(true);
}

$('usage-panel').addEventListener('toggle', event => { if (event.newState === 'open') loadUsage(true); else resetMessage = ''; });
setInterval(() => loadUsage(), 120000);
