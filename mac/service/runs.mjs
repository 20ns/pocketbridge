// Agent runs: one CLI process per chat while it has turns to do. Messages, sub-agents and turn timing are saved
// before clients are told; a run's end settles the chat's status.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { agentNames, agentEnv } from './agents.mjs';
import { claudeArgs, claudeRun } from './claude-run.mjs';
import { codexRun } from './codex-run.mjs';
import { oneLine, processStamp, terminateGroup } from './util.mjs';

export const restarted = 'Mac service restarted during this task. Review the conversation before continuing.';

export function createRuns(ctx) {
  const { options, get, run, change, status, agents, projects, active, waiting } = ctx;
  const message = (chatId, role, value, id = randomUUID(), extra = {}) => {
    run('INSERT INTO messages (id,chatId,role,text,createdAt,attachments,kind) VALUES (?,?,?,?,?,?,?)', id, chatId, role, value, Date.now(), extra.attachments?.length ? JSON.stringify(extra.attachments) : null, extra.kind ?? null);
    change('message', chatId);
    // Status-only streams skip message events; a tool step or notice still tells them the chat's current step moved.
    if (role === 'activity') change('step', chatId);
    return id;
  };
  /** Sub-agents a turn started: created on first sight, then patched with whatever each later event adds. */
  const subagent = (chatId, promptId, agent, patch) => {
    const existing = get('SELECT * FROM subagents WHERE chatId=? AND id=?', chatId, patch.id), now = Date.now();
    const done = patch.status && patch.status !== 'running';
    if (!existing) run('INSERT INTO subagents (id,chatId,promptId,agent,title,kind,model,effort,status,activity,startedAt,endedAt,toolUses,tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      patch.id, chatId, promptId, agent, patch.title ?? 'Sub-agent', patch.kind ?? null, patch.model ?? null, patch.effort ?? null, patch.status ?? 'running', patch.activity ?? null, patch.startedAt ?? now, done ? (patch.endedAt ?? now) : null, patch.toolUses ?? null, patch.tokens ?? null);
    else {
      const next = { ...existing };
      for (const key of ['title', 'kind', 'model', 'effort', 'activity', 'toolUses', 'tokens']) if (patch[key] !== undefined && patch[key] !== null) next[key] = patch[key];
      if (patch.status && existing.status === 'running') { next.status = patch.status; if (done) next.endedAt = patch.endedAt ?? now; }
      run('UPDATE subagents SET title=?,kind=?,model=?,effort=?,status=?,activity=?,endedAt=?,toolUses=?,tokens=? WHERE chatId=? AND id=?', next.title, next.kind, next.model, next.effort, next.status, next.activity, next.endedAt, next.toolUses, next.tokens, chatId, patch.id);
    }
    change('message', chatId);
  };
  const activityFor = (id, value) => { run('UPDATE chats SET activity=? WHERE id=?', value ? String(value).slice(0, 200) : null, id); change('state', id); };
  const thinkingFor = (id, value) => {
    if (value && (!active.get(id)?.turnOpen || active.get(id)?.stopped)) return;
    run('UPDATE chats SET thinking=? WHERE id=?', value || null, id); change('message', id);
  };
  const cancelApprovals = id => {
    for (const [approvalId, entry] of waiting) if (entry.chatId === id) {
      run("UPDATE approvals SET status='deny' WHERE id=?", approvalId); entry.resolve({ behavior: 'deny', message: 'User stopped the task', interrupt: true }); waiting.delete(approvalId); change('approval', id);
    }
  };
  // reason 'shutdown': the service is quitting (restart, update, logout), not the owner pressing Stop.
  const stop = (id, reason = 'user') => {
    ctx.chat(id); const entry = active.get(id); if (!entry || entry.stopped) return;
    entry.stopped = reason; thinkingFor(id, null); status(id, 'stopping'); cancelApprovals(id);
    entry.stopPromise = terminateGroup(entry.child.pid, options.stopTimeoutMs ?? 3000).catch(error => console.error(`Stop ${id}: ${error.message}`));
  };

  /**
   * Starts one CLI run for a chat. A run lives until its turns are done: steers join the running turn, an interrupt
   * ends the turn and sends the next one into the same process, and Claude's background sub-agents can add turns.
   * delivery: { promptId, text, attachments: [{ id, type, path }], kind: 'turn'|'steer'|'interrupt' }.
   */
  function start(id, delivery, later = []) {
    // A run and each of its turns use the options recorded with that prompt; the chat row may already hold a later one's.
    const promptOptions = promptId => {
      const chat = get('SELECT mode,model,effort,speed FROM chats WHERE id=?', id), recorded = get('SELECT mode,model,effort,speed FROM prompts WHERE id=?', promptId);
      return recorded ? { mode: recorded.mode ?? chat.mode, model: recorded.model ?? chat.model, effort: recorded.effort ?? chat.effort, speed: recorded.speed ?? null } : chat;
    };
    const row = { ...get('SELECT * FROM chats WHERE id=?', id), ...promptOptions(delivery.promptId) }, project = get('SELECT * FROM projects WHERE id=?', row.projectId);
    const agent = row.agent || 'claude';
    const bridgeEnv = { POCKETBRIDGE_INTERNAL_URL: ctx.localUrl, POCKETBRIDGE_INTERNAL_TOKEN: ctx.internalToken, POCKETBRIDGE_CHAT_ID: id };
    const args = agent === 'codex' ? ['app-server'] : claudeArgs(row, id, bridgeEnv);
    // Subscription login stays inside each official binary; inherited API overrides must not change billing.
    const env = { ...agentEnv(agent), ...(agent === 'claude' ? bridgeEnv : {}) };
    const child = spawn(agents.paths[agent], args, { cwd: project.path, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const entry = { child, agent, stopped: false, assistantId: null, buffer: '', stderr: '', result: null, parseError: null, sawText: false, tools: new Map(), after: later, finishing: false, turnPrompt: null };
    active.set(id, entry);
    thinkingFor(id, null);
    if (child.pid) run('INSERT OR REPLACE INTO runtimes VALUES (?,?,?)', id, child.pid, processStamp(child.pid) ?? '');
    // Idle sleep on battery would suspend the turn; -i holds it off only while this run lives. A closed lid still sleeps.
    if (child.pid && process.platform === 'darwin' && !ctx.testing && process.env.POCKETBRIDGE_KEEP_AWAKE !== '0') spawn('/usr/bin/caffeinate', ['-i', '-w', String(child.pid)], { stdio: 'ignore' }).on('error', () => {}).unref();
    const turnStarted = promptId => { thinkingFor(id, null); entry.turnPrompt = promptId; run('UPDATE prompts SET startedAt=COALESCE(startedAt,?) WHERE id=?', Date.now(), promptId); change('message', id); };
    const turnEnded = () => { thinkingFor(id, null); if (entry.turnPrompt) { run('UPDATE prompts SET endedAt=? WHERE id=?', Date.now(), entry.turnPrompt); change('message', id); } };
    const append = value => {
      if (!value) return; entry.sawText = true;
      if (!entry.assistantId) entry.assistantId = message(id, 'assistant', value);
      else { run('UPDATE messages SET text=text||? WHERE id=?', value, entry.assistantId); change('message', id); }
    };
    const session = { id, row, project, agent, child, entry, turnStarted, turnEnded, append, promptOptions };
    const consume = agent === 'claude' ? claudeRun(ctx, session, delivery) : codexRun(ctx, session, delivery);
    // Unexpected CLI output fails this turn; it must never take the service and every other chat down with it.
    const safely = line => {
      try { consume(line); } catch (error) { entry.parseError ??= `PocketBridge could not read ${agentNames[agent]} output: ${error.message}`; console.error(`Chat ${id}: ${error.stack ?? error.message}`); }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      entry.buffer += chunk;
      if (entry.buffer.length > 10_000_000) { entry.parseError = `${agentNames[agent]} output exceeded the structured event limit.`; stop(id); return; }
      let newline; while ((newline = entry.buffer.indexOf('\n')) !== -1) { const line = entry.buffer.slice(0, newline); entry.buffer = entry.buffer.slice(newline + 1); if (line.trim()) safely(line); }
    });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { entry.stderr = (entry.stderr + chunk).slice(-16_000); });
    child.stdin.on('error', () => {}); child.on('error', error => { entry.parseError = `Could not start ${agentNames[agent]}: ${error.message}`; });
    // Once the process is gone, steers and interrupts wait for the next run instead of writing to a closed pipe.
    // A tool process still holding stdout or stderr would keep 'close' away and the chat running forever.
    child.on('exit', () => { entry.finishing = true; setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, options.pipeGraceMs ?? 5000).unref(); });
    child.on('close', (code, signal) => finished(code, signal).catch(error => {
      console.error(`Chat ${id} cleanup: ${error.stack ?? error.message}`);
      active.delete(id);
      try { status(id, 'error', `PocketBridge could not finish this turn: ${error.message}`); } catch { /* database already closed */ }
    }));
    const finished = async (code, signal) => {
      entry.finishing = true;
      if (entry.buffer.trim()) safely(entry.buffer);
      clearTimeout(entry.settleTimer);
      // Tool processes can outlive the CLI even after a completed result.
      await (entry.stopPromise ?? terminateGroup(child.pid, options.stopTimeoutMs ?? 3000).catch(error => console.error(`Cleanup ${id}: ${error.message}`)));
      active.delete(id); run('DELETE FROM runtimes WHERE chatId=?', id); cancelApprovals(id); agents.usageChanged(agent); projects.changed(project.id);
      run("UPDATE subagents SET status='stopped',endedAt=? WHERE chatId=? AND status='running'", Date.now(), id);
      if (entry.turnPrompt) run('UPDATE prompts SET endedAt=COALESCE(endedAt,?) WHERE id=?', Date.now(), entry.turnPrompt);
      run('UPDATE chats SET activity=NULL,thinking=NULL WHERE id=?', id);
      const codex = agent === 'codex';
      // Messages sent while the run was closing start the next run rather than being lost.
      if (!entry.stopped && entry.after.length) { start(id, entry.after.shift(), entry.after); return; }
      if (entry.stopped) {
        // These prompts never reached the CLI; written but unacknowledged steers remain uncertain.
        const dropped = new Map([...entry.after, ...(entry.queue ?? []), ...(entry.early ?? [])].map(next => [next.promptId, next])), shutdown = entry.stopped === 'shutdown';
        for (const next of dropped.values()) message(id, 'activity', `${shutdown ? 'Mac service restarted' : 'Stopped'} before "${oneLine(next.text, 80)}" ran. Send it again if you still need it.`);
        status(id, 'interrupted', shutdown ? restarted : 'Stopped by you. Completed changes remain on disk.');
      }
      else if (codex && (entry.parseError || !entry.result.ok)) status(id, 'error', entry.parseError ?? entry.failure ?? entry.codex?.state.failure ?? (entry.stderr.trim().split('\n').slice(-12).join('\n') || `Codex exited ${code ?? signal} without a completed turn.`));
      else if (!codex && (entry.parseError || code !== 0 || entry.result?.is_error || !entry.result)) status(id, 'error', entry.parseError ?? (entry.result?.errors?.join('\n') || entry.result?.result || entry.stderr.trim() || `Claude exited ${code ?? signal} without a completed result.`));
      else status(id, 'idle');
      // A scheduled prompt that came due while this run worked goes next.
      ctx.schedules?.wake();
    };
  }

  /** Starts a run for a prompt that is already recorded. A failure to start says why on the chat; the prompt is never retried. */
  function launch(id, delivery) {
    try { start(id, delivery); }
    catch (error) {
      console.error(`Chat ${id} start: ${error.stack ?? error.message}`);
      const failed = active.get(id); active.delete(id);
      if (failed?.child?.pid) terminateGroup(failed.child.pid, 1000).catch(() => {});
      status(id, 'error', `Could not start ${agentNames[get('SELECT agent FROM chats WHERE id=?', id)?.agent || 'claude']}: ${error.message}`);
    }
  }

  Object.assign(ctx, { message, subagent, activityFor, thinkingFor, cancelApprovals });
  return { start, launch, stop, message };
}
