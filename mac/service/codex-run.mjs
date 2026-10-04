// One Codex run: `codex app-server` with one thread per chat and one turn per prompt; steer and interrupt in place.
import { codexPolicy } from './agents.mjs';
import { codexAppConsumer } from './codex-events.mjs';
import { oneLine, terminateGroup } from './util.mjs';

/**
 * Wires a started app-server to its chat: opens or resumes the thread, starts the first turn, sets entry.steer and
 * entry.interrupt, and returns the consumer for each stdout line.
 */
export function codexRun(ctx, session, delivery) {
  const { run, get, change, options, message, subagent, activityFor, active, projects } = ctx;
  const { id, row, agent, child, entry, project, turnStarted, turnEnded, promptOptions } = session;
  let nextId = 1;
  const pending = new Map();
  // The first turn is on its way from the start; steers and interrupts that arrive first wait for its id.
  entry.queue = []; entry.early = []; entry.turnOpen = true; entry.turnId = null; entry.turnLive = false;
  const writable = () => !child.stdin.destroyed && !child.stdin.writableEnded && child.exitCode === null;
  const send = value => { if (writable()) child.stdin.write(JSON.stringify(value) + '\n'); };
  const call = (method, params) => new Promise((resolveCall, rejectCall) => {
    if (!writable()) { rejectCall(new Error('Codex is no longer running')); return; }
    const callId = nextId++; pending.set(callId, { resolveCall, rejectCall }); send({ id: callId, method, params });
  });
  // An exit leaves a request's outcome unknown: Codex may have applied it before going away.
  child.on('exit', () => { for (const waiter of pending.values()) waiter.rejectCall(Object.assign(new Error('Codex exited'), { unknown: true })); pending.clear(); });
  const codex = codexAppConsumer({
    say: (role, value, messageId) => message(id, role, value, messageId),
    update: (messageId, value) => { run('UPDATE messages SET text=? WHERE id=?', value, messageId); change('message', id); },
    append: (messageId, value) => { run('UPDATE messages SET text=text||? WHERE id=?', value, messageId); change('message', id); },
    subagent: patch => subagent(id, entry.turnPrompt, agent, patch),
    context: (used, window) => run('UPDATE chats SET contextTokens=?,contextWindow=? WHERE id=?', used, window, id),
    activity: value => activityFor(id, value),
  });
  entry.codex = codex;
  const settings = promptId => {
    const current = promptOptions(promptId);
    return { model: current.model !== 'default' ? current.model : null, effort: current.effort !== 'default' ? current.effort : null, speed: current.speed || null, ...codexPolicy(current.mode) };
  };
  // A "/name" prompt passes that skill. The list is kept ten minutes; a new turn waits for a fresh one, while a
  // steer must go out at once (its turn may end meanwhile), so it uses what is known and refreshes for next time.
  const skillName = next => /^\/([\w:.-]+)/.exec(next.text)?.[1];
  const fresh = () => projects.freshSkills(project);
  const inputFor = (next, skills) => {
    const skill = skills?.find(item => item.name === skillName(next));
    return [...(skill ? [{ type: 'skill', name: skill.name, path: skill.path }] : []), { type: 'text', text: next.text, text_elements: [] }, ...next.attachments.map(item => ({ type: 'localImage', path: item.path }))];
  };
  const withSkills = async next => inputFor(next, !skillName(next) ? null : fresh() ?? (await projects.loadCodexSkills(project).catch(() => null)) ?? projects.knownSkills(project));
  const steerInput = next => {
    if (skillName(next) && !fresh()) projects.loadCodexSkills(project).catch(() => {});
    return inputFor(next, projects.knownSkills(project));
  };
  const shutdown = () => {
    if (entry.finishing) return; entry.finishing = true; child.stdin.end();
    setTimeout(() => { if (active.get(id) === entry) terminateGroup(child.pid, options.stopTimeoutMs ?? 3000).catch(() => {}); }, 3000).unref();
  };
  // A rejected interrupt is tried once more; if the turn still won't stop, the queued prompt runs when it ends.
  const interruptNow = (retry = true) => {
    const turnId = entry.turnId;
    call('turn/interrupt', { threadId: entry.threadId, turnId }).catch(error => {
      if (retry && !error.unknown) setTimeout(() => { if (entry.turnLive && entry.turnId === turnId && !entry.finishing) interruptNow(false); }, 1000).unref();
    });
  };
  const steerNow = next => call('turn/steer', { threadId: entry.threadId, expectedTurnId: entry.turnId, input: steerInput(next) }).catch(error => {
    // Codex may have taken a steer it never answered; running it again could repeat its work.
    if (error.unknown) { message(id, 'activity', `Codex stopped before confirming "${oneLine(next.text, 80)}". Check the chat before sending it again.`); return; }
    // The turn ended before the steer landed; it becomes the next turn instead.
    if (entry.finishing) entry.after.push(next); else if (entry.turnOpen) entry.queue.push(next); else startTurn(next).catch(failRun);
  });
  // Codex accepts steer and interrupt only once it reports the turn started, not when turn/start returns.
  const turnActive = id => {
    if (id) entry.turnId = id;
    if (!entry.turnId || entry.turnLive) return;
    entry.turnLive = true;
    for (const next of entry.early.splice(0)) steerNow(next);
    if (entry.interruptPending) { entry.interruptPending = false; interruptNow(); }
  };
  const startTurn = async next => {
    turnStarted(next.promptId); entry.turnOpen = true; entry.turnId = null; entry.turnLive = false;
    const { model, effort, speed } = settings(next.promptId);
    const input = await withSkills(next);
    // A speed tier sticks to the thread, so standard speed is asked for explicitly only once a tier was in use. The
    // tier is noted as it is sent: a turn can finish, and the next start, before turn/start's reply is handled.
    const tier = speed ? { serviceTier: speed } : entry.serviceTier ? { serviceTier: null } : {};
    entry.serviceTier = speed;
    const opened = await call('turn/start', { threadId: entry.threadId, input, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...tier });
    if (!entry.turnLive) entry.turnId = opened?.turn?.id ?? entry.turnId;
  };
  const failRun = error => { entry.failure ??= error?.message ?? 'Codex could not start this turn.'; shutdown(); };
  entry.steer = next => {
    if (entry.finishing) entry.after.push(next);
    else if (!entry.turnOpen) entry.queue.push(next);
    else if (!entry.turnLive) entry.early.push(next);
    else steerNow(next);
  };
  entry.interrupt = next => {
    if (entry.finishing) { entry.after.push(next); return; }
    entry.queue.unshift(next);
    if (!entry.turnOpen) return;
    if (entry.turnLive) interruptNow(); else entry.interruptPending = true;
  };
  const turnCompleted = turn => {
    entry.turnOpen = false; entry.turnLive = false; turnEnded(); entry.lastTurn = turn;
    // Steers that never reached a turn id run next, in order.
    entry.queue.push(...entry.early.splice(0)); entry.interruptPending = false;
    if (turn?.status === 'failed') entry.failure = oneLine(turn.error?.message) || codex.state.failure || 'Codex could not finish this turn.';
    if (entry.queue.length && !entry.stopped) startTurn(entry.queue.shift()).catch(failRun);
    else shutdown();
  };
  const consume = line => {
    let event; try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== 'object') return;
    if (event.method && !['item/agentMessage/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/commandExecution/outputDelta'].includes(event.method)) run('INSERT INTO raw_events (chatId,json) VALUES (?,?)', id, line.slice(0, 200_000));
    if (event.id !== undefined && !event.method) {
      const waiter = pending.get(event.id); pending.delete(event.id);
      if (waiter) { if (event.error) waiter.rejectCall(new Error(event.error.message ?? 'Codex rejected the request')); else waiter.resolveCall(event.result); }
      return;
    }
    // Codex asks only when its policy allows asking; PocketBridge runs it with approvals off, so any request is declined.
    if (event.id !== undefined && event.method) { send(event.method.endsWith('requestApproval') ? { id: event.id, result: { decision: 'decline' } } : { id: event.id, error: { code: -32601, message: 'Not supported by PocketBridge' } }); return; }
    // Sub-agent threads report on their own thread ids: they only update that sub-agent's activity line.
    const thread = event.params?.threadId;
    if (thread && entry.threadId && thread !== entry.threadId) {
      const item = event.params?.item;
      if (event.method === 'item/started' && item && get('SELECT id FROM subagents WHERE chatId=? AND id=?', id, thread)) {
        const doing = item.type === 'commandExecution' ? `Running ${oneLine(String(item.command ?? '').replace(/^\/bin\/(?:ba|z)?sh -lc /, ''), 120)}` : item.type === 'fileChange' ? 'Editing files' : item.type === 'mcpToolCall' ? `${item.server ?? ''}.${item.tool ?? ''}` : null;
        if (doing) subagent(id, entry.turnPrompt, agent, { id: thread, activity: doing });
      }
      return;
    }
    if (event.method === 'turn/started') { turnActive(event.params?.turn?.id); return; }
    if (event.method === 'turn/completed') { if (!entry.turnId || !event.params?.turn?.id || event.params.turn.id === entry.turnId) turnCompleted(event.params?.turn); return; }
    codex.consume(event.method, event.params);
  };
  (async () => {
    await call('initialize', { clientInfo: { name: 'pocketbridge', title: 'PocketBridge', version: '1' } });
    send({ method: 'initialized' });
    const { model, effort, approvalPolicy, sandbox } = settings(delivery.promptId);
    const base = { cwd: project.path, approvalPolicy, sandbox, ...(model ? { model } : {}), ...(effort ? { config: { model_reasoning_effort: effort } } : {}) };
    const opened = row.agentSession ? await call('thread/resume', { threadId: row.agentSession, ...base }) : row.forkFrom ? await call('thread/fork', { threadId: row.forkFrom, ...base }) : await call('thread/start', base);
    entry.threadId = opened?.thread?.id; entry.serviceTier = typeof opened?.serviceTier === 'string' ? opened.serviceTier : null;
    if (!entry.threadId) throw new Error('Codex did not open a thread.');
    run('UPDATE chats SET agentSession=?,sessionStarted=1 WHERE id=?', entry.threadId, id);
    await startTurn(delivery);
  })().catch(failRun);
  entry.result = { get ok() { return entry.lastTurn?.status === 'completed' && !entry.failure; } };
  return consume;
}
