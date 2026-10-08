// Scheduled prompts: recorded like any prompt, then run once when their time comes, usually a plan limit reset.
// The Mac owns the schedule, so it runs with the phone off. A prompt marked started is never run again.
import { existsSync, statSync } from 'node:fs';
import { agentNames } from './agents.mjs';
import { fail, oneLine } from './util.mjs';

/** Runs a little after the reset the CLI reported, so the plan has really reset by then. */
export const resetMarginMs = 2 * 60_000;
/** Explicit times can be up to this far ahead: a weekly limit resets within a week. */
export const scheduleHorizonMs = 8 * 86_400_000;
// Timers stop while a Mac sleeps, so a long wait is checked again at least this often.
const recheckMs = 60_000;

/**
 * The reset a prompt for this agent should wait for. Limits scoped to a model ("weekly_scoped:Fable") count only
 * for that model. When some limits are used up, every one of them has to reset, so the latest of their resets wins;
 * otherwise the fullest limit's reset, the sooner on a tie. Null when no future reset is known.
 */
export function resetFor(limits, now, modelName = '') {
  const applies = limit => {
    const scope = String(limit.id ?? '').split(':').slice(1).join(':').trim().toLowerCase();
    return !scope || modelName.toLowerCase().includes(scope);
  };
  const known = (limits ?? []).filter(limit => applies(limit) && Number.isFinite(limit.resetsAt) && limit.resetsAt > now);
  const used = known.filter(limit => limit.percent >= 100);
  const pick = used.length ? used.reduce((a, b) => b.resetsAt > a.resetsAt ? b : a)
    : known.reduce((a, b) => !a || b.percent > a.percent || (b.percent === a.percent && b.resetsAt < a.resetsAt) ? b : a, null);
  return pick ? { at: pick.resetsAt + resetMarginMs, limit: pick } : null;
}

/** The schedule a prompt request asks for, as recorded in the ledger: 'reset', an epoch ms string, or null. */
export function scheduleRequest(value, now = Date.now()) {
  if (value === undefined || value === null) return null;
  if (value === 'reset') return 'reset';
  if (Number.isSafeInteger(value) && value > 0) {
    if (value > now + scheduleHorizonMs) throw fail(400, 'Schedule a prompt at most a week ahead');
    return String(value);
  }
  throw fail(400, "schedule must be 'reset' or a time in milliseconds");
}

export function createSchedules(ctx, uploadPath) {
  const { get, all, run, transaction, change, status, active, agents } = ctx;
  let timer = null;
  const busy = chat => active.has(chat.id) || ['running', 'stopping', 'waiting'].includes(chat.status);
  const view = row => row?.scheduleState ? { notBefore: row.scheduledAt, state: row.scheduleState } : null;

  /** When a prompt for [agent] can run after its plan limit resets, from the CLI's own usage report. */
  const resolveReset = async (agent, model) => {
    const usage = await agents.refreshUsage(agent);
    const found = resetFor(usage?.limits, Date.now(), agents.modelDisplay(agent, model ?? 'default'));
    if (!found) throw fail(409, `${agentNames[agent]} hasn't reported when its limit resets. Choose a time instead.`);
    return found.at;
  };

  /** Why a due prompt can't run now, or null. Checked again at its time, since anything may change while it waits. */
  const blocker = (chat, prompt) => {
    const agent = chat.agent || 'claude';
    if (!agents.enabled[agent]) return `${agentNames[agent]} is turned off`;
    if (!agents.available[agent]) return `${agentNames[agent]} could not be started`;
    const project = get('SELECT path FROM projects WHERE id=?', chat.projectId);
    try { if (!project || !statSync(project.path).isDirectory()) throw new Error(); } catch { return 'its project folder is missing'; }
    const uploads = JSON.parse(prompt.attachments || '[]').map(id => get('SELECT * FROM uploads WHERE id=?', id));
    if (uploads.some(upload => !upload || !existsSync(uploadPath(upload)))) return 'an attached image is no longer on the Mac';
    return null;
  };

  /** Starts one due prompt. Resolves 'started', 'waiting' (its chat is busy) or 'skipped'. */
  const fire = prompt => {
    const chat = get('SELECT * FROM chats WHERE id=?', prompt.chatId);
    if (!chat) { run("UPDATE prompts SET scheduleState='cancelled' WHERE id=? AND scheduleState='scheduled'", prompt.id); return 'skipped'; }
    if (busy(chat)) return 'waiting';
    const reason = blocker(chat, prompt);
    if (reason) {
      // Never run later on its own: the owner decides again, with the prompt still in the conversation.
      transaction(() => {
        run("UPDATE prompts SET scheduleState='cancelled' WHERE id=?", prompt.id);
        run('UPDATE messages SET kind=NULL WHERE id=?', prompt.id); change('message', chat.id);
        ctx.message(chat.id, 'activity', `"${oneLine(prompt.text, 80)}" wasn't sent at its scheduled time: ${reason}. Send it again if you still need it.`);
        status(chat.id, 'error', `Scheduled prompt not sent: ${reason}.`);
      });
      return 'skipped';
    }
    const uploads = JSON.parse(prompt.attachments || '[]').map(id => get('SELECT * FROM uploads WHERE id=?', id));
    transaction(() => {
      // Marked started with the chat running, in one transaction: after a crash it is interrupted, never repeated.
      run("UPDATE prompts SET scheduleState='started' WHERE id=?", prompt.id);
      const saved = get('SELECT rowid,* FROM messages WHERE id=?', prompt.id), now = Date.now();
      // Prompts sent meanwhile ran first, so the bubble moves below them to where its reply will appear.
      if (saved && get('SELECT 1 FROM messages WHERE chatId=? AND rowid>? LIMIT 1', chat.id, saved.rowid)) {
        run('DELETE FROM messages WHERE id=?', prompt.id);
        run('INSERT INTO messages (id,chatId,role,text,createdAt,attachments,kind) VALUES (?,?,?,?,?,?,NULL)', saved.id, saved.chatId, saved.role, saved.text, now, saved.attachments);
      } else if (saved) run('UPDATE messages SET kind=NULL,createdAt=? WHERE id=?', now, prompt.id);
      run("UPDATE chats SET status='running',error=NULL,updatedAt=? WHERE id=?", now, chat.id);
      change('message', chat.id); change('state', chat.id);
    });
    ctx.runs.launch(chat.id, { promptId: prompt.id, text: prompt.text, attachments: uploads.map(upload => ({ id: upload.id, type: upload.type, path: uploadPath(upload) })), kind: 'turn' });
    return 'started';
  };

  /** Runs every due prompt whose chat is free, then sleeps until the next one is due. */
  const tick = () => {
    clearTimeout(timer); timer = null;
    if (ctx.closed) return;
    let next = Infinity;
    for (const prompt of all("SELECT * FROM prompts WHERE scheduleState='scheduled' ORDER BY scheduledAt, rowid")) {
      if (prompt.scheduledAt > Date.now()) { next = Math.min(next, prompt.scheduledAt); break; }
      // A busy chat wakes the scheduler when its run ends; the recheck covers anything missed.
      let outcome;
      try { outcome = fire(prompt); } catch (error) { console.error(`Scheduled prompt ${prompt.id}: ${error.stack ?? error.message}`); outcome = 'waiting'; }
      if (outcome === 'waiting') next = Math.min(next, Date.now() + recheckMs);
    }
    if (next < Infinity) { timer = setTimeout(tick, Math.max(0, Math.min(next - Date.now(), recheckMs))); timer.unref?.(); }
  };
  const wake = () => { if (ctx.closed) return; clearTimeout(timer); timer = setTimeout(tick, 0); timer.unref?.(); };

  const recorded = (chatId, promptId) => {
    const prompt = get('SELECT * FROM prompts WHERE chatId=? AND id=?', chatId, promptId);
    if (!prompt) throw fail(404, 'Prompt not found');
    if (!prompt.scheduleState) throw fail(409, 'This prompt was not scheduled');
    return prompt;
  };
  /** Cancels a prompt that hasn't started. Repeating it is harmless; a started prompt can only be stopped. */
  const cancel = (chatId, promptId) => {
    const prompt = recorded(chatId, promptId);
    if (prompt.scheduleState === 'started') throw fail(409, 'This prompt already started');
    if (prompt.scheduleState === 'scheduled') transaction(() => {
      run("UPDATE prompts SET scheduleState='cancelled' WHERE id=?", promptId);
      // The text goes back to the owner's composer; the conversation keeps no trace of a prompt that never ran.
      run('DELETE FROM messages WHERE id=?', promptId);
      change('message', chatId); change('state', chatId);
    });
    return { ok: true, ...view(get('SELECT * FROM prompts WHERE id=?', promptId)) };
  };
  /** Makes a scheduled prompt due now: it runs at once, or as soon as a running turn in its chat ends. */
  const sendNow = (chatId, promptId) => {
    const prompt = recorded(chatId, promptId);
    if (prompt.scheduleState === 'cancelled') throw fail(409, 'This prompt was cancelled');
    if (prompt.scheduleState === 'scheduled') {
      const chat = get('SELECT * FROM chats WHERE id=?', chatId), reason = chat && blocker(chat, prompt);
      if (reason) throw fail(409, `Can't send it now: ${reason}.`);
      run('UPDATE prompts SET scheduledAt=? WHERE id=?', Date.now(), promptId); change('state', chatId);
      tick();
    }
    return { ok: true, ...view(get('SELECT * FROM prompts WHERE id=?', promptId)) };
  };
  const close = () => { clearTimeout(timer); timer = null; };
  return { resolveReset, wake, cancel, sendNow, close, view };
}
