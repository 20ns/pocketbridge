// Prompt delivery: the durable ledger of client delivery ids, duplicate detection, chat creation on a first prompt,
// and handing the prompt to a new run or to the running one as a steer or interrupt.
import { existsSync, statSync } from 'node:fs';
import { agentIds, agentNames } from './agents.mjs';
import { scheduleRequest } from './schedules.mjs';
import { fail, text, listed, uuid } from './util.mjs';

/** Long pastes are welcome; 500,000 characters is about as much as a model's context can take in one prompt. */
export const MAX_PROMPT = 500_000;

export function createPrompts(ctx, uploadPath) {
  const { get, run, transaction, change, active, agents, runs, schedules } = ctx;
  const { available, enabled } = agents;
  const { launch, message } = runs;
  /** Resolves [status code, response body] for POST /api/chats/:id/prompts. */
  return async (id, input) => {
    if (get('SELECT id FROM deleted_chats WHERE id=?', id)) throw fail(410, 'Chat was deleted');
    const attachmentIds = input.attachments === undefined ? [] : input.attachments;
    if (!Array.isArray(attachmentIds) || attachmentIds.length > 8 || attachmentIds.some(item => typeof item !== 'string' || !uuid(item))) throw fail(400, 'Attachments must be up to 8 upload ids');
    // A screenshot alone is a complete prompt; the agent gets a plain instruction to look at it.
    const imageOnly = attachmentIds.length > 0 && typeof input.text === 'string' && !input.text.trim();
    if (typeof input.text === 'string' && input.text.length > MAX_PROMPT) throw fail(400, `Prompt is too long: ${input.text.length.toLocaleString('en-US')} characters, the limit is ${MAX_PROMPT.toLocaleString('en-US')}`);
    const promptId = text(input.id, 'prompt id', 128), prompt = imageOnly ? (attachmentIds.length === 1 ? 'Look at the attached image.' : 'Look at the attached images.') : text(input.text, 'prompt', MAX_PROMPT);
    // A scheduled prompt is recorded now and run once at its time; the request, not the resolved time, identifies it.
    const schedule = scheduleRequest(input.schedule);
    // A retry is judged on the recorded payload alone, so a later catalog change cannot turn it into a new turn.
    const recorded = () => get('SELECT * FROM prompts WHERE id=?', promptId);
    const duplicate = previous => {
      const same = previous.chatId === id && previous.text === prompt && (previous.attachments ?? '[]') === JSON.stringify(attachmentIds) && (input.mode === undefined || previous.mode === input.mode) && (input.model === undefined || (previous.model ?? 'default') === input.model) && (input.effort === undefined || (previous.effort ?? 'default') === input.effort) && (input.speed === undefined || (previous.speed ?? null) === input.speed) && (input.agent === undefined || (previous.agent ?? 'claude') === input.agent)
        && (previous.schedule ?? null) === schedule
        // A prompt that ran as a new turn ignored any delivery; a steer retried as "send now" (or back) is different content.
        && (!['steer', 'interrupt'].includes(previous.delivery) || !['steer', 'interrupt'].includes(input.delivery) || previous.delivery === input.delivery)
        && (input.projectId === undefined || get('SELECT projectId FROM chats WHERE id=?', id)?.projectId === input.projectId);
      if (!same) throw fail(409, 'Prompt id was already used for different content');
      const scheduled = schedules.view(previous);
      return [200, { accepted: true, duplicate: true, ...(scheduled ? { schedule: scheduled } : {}) }];
    };
    if (recorded()) return duplicate(recorded());
    let stored = get('SELECT * FROM chats WHERE id=?', id);
    const agent = stored?.agent || (input.agent === undefined ? 'claude' : listed(input.agent, agentIds, 'agent'));
    if (stored && input.agent !== undefined && input.agent !== agent) throw fail(409, 'Chat already uses another agent');
    let notBefore = schedule === null || schedule === 'reset' ? null : Number(schedule);
    if (schedule === 'reset') {
      if (!enabled[agent]) throw fail(409, `${agentNames[agent]} is turned off. Turn it on in Settings.`);
      notBefore = await schedules.resolveReset(agent, input.model ?? stored?.model);
    }
    // Validation may wait for a model catalog, and another prompt can change the chat meanwhile. The options are
    // checked again against the chat as it is now, so a merged model, effort and speed is always a valid one.
    const optionsOf = row => row && JSON.stringify([row.model, row.effort, row.speed]);
    let requested;
    for (let attempt = 0; ; attempt++) {
      requested = await agents.chatOptions(agent, input, stored);
      // Shutdown or a concurrent retry could have begun meanwhile.
      if (ctx.closed) throw fail(503, 'Mac service is shutting down');
      if (recorded()) return duplicate(recorded());
      if (get('SELECT id FROM deleted_chats WHERE id=?', id)) throw fail(410, 'Chat was deleted');
      const latest = get('SELECT * FROM chats WHERE id=?', id), changed = optionsOf(latest) !== optionsOf(stored);
      stored = latest;
      if (!changed) break;
      if (attempt === 2) throw fail(409, 'Chat options are changing; send again');
    }
    if (stored && (stored.agent || 'claude') !== agent) throw fail(409, 'Chat already uses another agent');
    let project, next;
    if (!stored) {
      if (input.projectId === undefined) throw fail(404, 'Chat not found');
      if (!uuid(id)) throw fail(400, 'Invalid chat id');
      const projectId = text(input.projectId, 'project id', 128);
      project = get('SELECT * FROM projects WHERE id=?', projectId); if (!project) throw fail(404, 'Project not found');
      next = { projectId, title: imageOnly ? (attachmentIds.length === 1 ? 'Screenshot' : 'Screenshots') : prompt.slice(0, 80), mode: requested.mode ?? 'bypassPermissions', model: requested.model ?? 'default', effort: requested.effort ?? 'default', speed: requested.speed ?? null, status: 'idle' };
    } else {
      if (input.projectId !== undefined && text(input.projectId, 'project id', 128) !== stored.projectId) throw fail(409, 'Chat already belongs to another project');
      project = get('SELECT * FROM projects WHERE id=?', stored.projectId);
      next = { projectId: stored.projectId, title: stored.title === 'New chat' ? (imageOnly ? (attachmentIds.length === 1 ? 'Screenshot' : 'Screenshots') : prompt.slice(0, 80)) : stored.title, mode: requested.mode ?? stored.mode, model: requested.model ?? stored.model ?? 'default', effort: requested.effort ?? stored.effort ?? 'default', speed: requested.speed !== undefined ? requested.speed : stored.speed ?? null, status: stored.status };
    }
    // While a turn runs, a prompt can steer it (default for clients that ask) or interrupt it and go next.
    // A scheduled prompt waits for its time and then for the chat to be free, so it never joins a running turn.
    const busy = active.has(id) || ['running', 'stopping', 'waiting'].includes(next.status);
    const runner = active.get(id), delivery = busy && schedule === null ? input.delivery : 'turn';
    if (busy && schedule === null && (!['steer', 'interrupt'].includes(delivery) || !runner || runner.stopped || next.status === 'stopping')) throw fail(409, 'Chat is busy; wait or stop it before sending another prompt');
    if (schedule !== null && stored && get("SELECT id FROM prompts WHERE chatId=? AND scheduleState='scheduled'", id)) throw fail(409, 'This chat already has a scheduled prompt. Cancel it or send it now first.');
    const uploads = attachmentIds.map(uploadId => get('SELECT * FROM uploads WHERE id=?', uploadId));
    if (uploads.some(upload => !upload || (upload.chatId && upload.chatId !== id) || !existsSync(uploadPath(upload)))) throw fail(400, 'Attachment not found');
    try { if (!statSync(project.path).isDirectory()) throw new Error(); } catch { throw fail(409, 'Project directory is missing'); }
    if (!enabled[agent]) throw fail(409, `${agentNames[agent]} is turned off. Turn it on in Settings.`);
    if (!available[agent]) throw fail(503, agent === 'codex' ? 'Codex is not installed or could not be started' : 'Claude Code is not installed or could not be started');
    const scheduled = schedule !== null;
    // Scheduling acknowledges the owner's next step, so a failed or interrupted chat reads as ready again.
    const status = scheduled ? (busy ? next.status : 'idle') : 'running';
    transaction(() => {
      if (!stored) run('INSERT INTO chats (id,projectId,agent,title,mode,model,effort,speed,status,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)', id, next.projectId, agent, next.title, next.mode, next.model, next.effort, next.speed, status, Date.now());
      else if (busy) run('UPDATE chats SET mode=?,model=?,effort=?,speed=?,updatedAt=? WHERE id=?', next.mode, next.model, next.effort, next.speed, Date.now(), id);
      else run('UPDATE chats SET mode=?,model=?,effort=?,speed=?,title=?,status=?,error=NULL,updatedAt=? WHERE id=?', next.mode, next.model, next.effort, next.speed, next.title, status, Date.now(), id);
      run('INSERT INTO prompts (id,chatId,text,mode,model,effort,speed,agent,attachments,delivery,schedule,scheduledAt,scheduleState) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', promptId, id, prompt, next.mode, next.model, next.effort, next.speed, agent, JSON.stringify(attachmentIds), delivery, schedule, notBefore, scheduled ? 'scheduled' : null);
      for (const upload of uploads) run('UPDATE uploads SET chatId=? WHERE id=?', id, upload.id);
      message(id, 'user', prompt, promptId, { attachments: uploads.map(upload => ({ id: upload.id, type: upload.type })), kind: scheduled ? 'scheduled' : delivery === 'turn' ? null : delivery }); change('state', id);
    });
    if (scheduled) { schedules.wake(); return [202, { accepted: true, duplicate: false, delivery: 'scheduled', schedule: { notBefore, state: 'scheduled' } }]; }
    const handoff = { promptId, text: prompt, attachments: uploads.map(upload => ({ id: upload.id, type: upload.type, path: uploadPath(upload) })), kind: delivery };
    // The prompt is recorded, so a retry stays a duplicate; a failed start says why on the chat.
    if (busy) {
      try { runner[delivery](handoff); } catch (error) { console.error(`Chat ${id} ${delivery}: ${error.stack ?? error.message}`); }
    } else launch(id, handoff);
    return [202, { accepted: true, duplicate: false, delivery }];
  };
}
