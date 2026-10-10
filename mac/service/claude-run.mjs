// One Claude Code run: `claude -p` with stream-json input, so steers and interrupts reach the running turn.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeContext, claudeUserMessage } from './agents.mjs';
import { shellQuote, oneLine, brief } from './util.mjs';

const bridgePath = join(dirname(fileURLToPath(import.meta.url)), 'approval-bridge.mjs');

/** CLI arguments for a chat's run: its session, permission mode, model and effort, and the question bridge. */
export function claudeArgs(row, id, bridgeEnv) {
  const settings = { hooks: { PreToolUse: [{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: [{ type: 'command', command: `${shellQuote(process.execPath)} ${shellQuote(bridgePath)} --hook`, timeout: 86400 }] }] } };
  const mcp = { mcpServers: { pocketbridge: { type: 'stdio', command: process.execPath, args: [bridgePath], env: bridgeEnv } } };
  // A continued Terminal or desktop session runs in place (agentSession), so its turns show up there too.
  const session = row.agentSession ? ['--resume', row.agentSession] : row.sessionStarted ? ['--resume', id] : ['--session-id', id];
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-mode', row.mode === 'default' ? 'manual' : row.mode, ...session, '--settings', JSON.stringify(settings), '--mcp-config', JSON.stringify(mcp), '--permission-prompt-tool', 'mcp__pocketbridge__approve'];
  if (row.mode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  if (row.model && row.model !== 'default') args.push('--model', row.model);
  if (row.effort && row.effort !== 'default') args.push('--effort', row.effort);
  return args;
}

/**
 * Wires a started Claude process to its chat: writes the first prompt, sets entry.steer and entry.interrupt, and
 * returns the consumer for each stdout line.
 */
export function claudeRun(ctx, session, delivery) {
  const { run, get, change, options, message, subagent, activityFor, thinkingFor, cancelApprovals, status } = ctx;
  const { id, row, agent, child, entry, turnStarted, turnEnded, append } = session;
  entry.written = new Map(); entry.background = 0; entry.turnOpen = false;
  const taskTools = new Map(); let backgroundTasks = new Set();
  let retryActivity;
  const thoughts = new Map(), completedThoughts = new Set(); let thoughtMessage = null, thoughtIndex = null, messageIndex = 0, backgroundUntil = 0, awaitingFollowup = false;
  const showThinking = () => thinkingFor(id, [...thoughts.values()].flatMap(parts => [...parts].sort(([a], [b]) => a - b).map(([, text]) => text)).filter(Boolean).join('\n\n'));
  const write = next => { child.stdin.write(JSON.stringify(claudeUserMessage(next.promptId, next.text, next.attachments)) + '\n'); entry.written.set(next.promptId, next); };
  // stdin closes once the last turn ended, no background sub-agent can add a turn, and every message was taken.
  const settle = (force = false) => {
    clearTimeout(entry.settleTimer);
    if (entry.finishing || entry.turnOpen || entry.background > 0) return;
    // A message the CLI never echoes (a local slash command, a discarded queued command) must not hold the run
    // open: once the turn has ended, close after a short wait; the CLI still runs input it already took.
    const wait = Math.max(backgroundUntil - Date.now(), entry.written.size && !force ? options.writtenGraceMs ?? 10_000 : 0);
    if (wait > 0) { entry.settleTimer = setTimeout(() => settle(true), wait); return; }
    entry.finishing = true; child.stdin.end();
  };
  entry.steer = next => { if (entry.finishing) entry.after.push(next); else { write(next); if (!entry.turnOpen) settle(); } };
  entry.interrupt = next => {
    if (entry.finishing) { entry.after.push(next); return; }
    cancelApprovals(id);
    if (get('SELECT status FROM chats WHERE id=?', id)?.status === 'waiting') status(id, 'running');
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: `interrupt-${next.promptId}`, request: { subtype: 'interrupt' } }) + '\n');
    write(next);
    if (!entry.turnOpen) settle();
  };
  const routeSubagent = event => {
    const parent = event.parent_tool_use_id;
    if (event.type === 'assistant') for (const block of event.message?.content ?? []) {
      if (block?.type === 'tool_use') { const known = get('SELECT toolUses FROM subagents WHERE chatId=? AND id=?', id, parent); subagent(id, entry.turnPrompt, agent, { id: parent, model: event.message?.model ?? null, activity: `${block.name} ${brief(block.input)}`.trim().slice(0, 200), toolUses: (known?.toolUses ?? 0) + 1 }); }
      else if (event.message?.model) subagent(id, entry.turnPrompt, agent, { id: parent, model: event.message.model });
    }
  };
  const consume = line => {
    let event;
    try { event = JSON.parse(line); } catch { entry.parseError = 'Claude returned malformed structured output.'; return; }
    if (!(event?.type === 'stream_event')) run('INSERT INTO raw_events (chatId,json) VALUES (?,?)', id, line);
    // Claude replays messages it queues itself, like a background task's <task-notification>, with string content.
    if (event?.type === 'user' && typeof event.message?.content === 'string') event.message.content = [{ type: 'text', text: event.message.content }];
    const malformed = () => { entry.parseError = `Claude returned malformed structured output${typeof event?.type === 'string' ? ` (${oneLine(event.type, 40)}${typeof event.subtype === 'string' ? `/${oneLine(event.subtype, 40)}` : ''})` : ''}.`; };
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') { malformed(); return; }
    if (['assistant', 'user'].includes(event.type) && (!Array.isArray(event.message?.content) || event.message.content.some(block => !block || typeof block !== 'object' || typeof block.type !== 'string' || (block.type === 'text' && typeof block.text !== 'string') || (block.type === 'thinking' && typeof block.thinking !== 'string')))) { malformed(); return; }
    if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta' && typeof event.event.delta.text !== 'string') { malformed(); return; }
    if (event.type === 'stream_event' && (event.event?.delta?.type === 'thinking_delta' || event.event?.content_block?.type === 'thinking') && (!Number.isSafeInteger(event.event.index) || event.event.index < 0 || typeof (event.event.delta?.thinking ?? event.event.content_block?.thinking) !== 'string')) { malformed(); return; }
    if (event.type === 'result' && ((event.result !== undefined && typeof event.result !== 'string') || (event.errors !== undefined && (!Array.isArray(event.errors) || event.errors.some(error => typeof error !== 'string'))))) { malformed(); return; }
    // A sub-agent's own messages describe that sub-agent; the chat shows them as its activity, not as replies.
    if (event.parent_tool_use_id != null) { if (typeof event.parent_tool_use_id === 'string') routeSubagent(event); else malformed(); return; }
    if (retryActivity !== undefined && (event.type === 'assistant' || event.type === 'result' || (event.type === 'stream_event' && event.event?.type === 'message_start'))) { activityFor(id, retryActivity); retryActivity = undefined; }
    if (event.type === 'system' && event.subtype === 'init') run('UPDATE chats SET sessionStarted=1 WHERE id=?', id);
    if (event.type === 'command_lifecycle' && ['cancelled', 'discarded', 'refused'].includes(event.state ?? event.status)) {
      // Claude dropped a message it had accepted; say so instead of leaving it looking delivered.
      for (const key of [event.uuid, event.command_uuid, event.message_uuid]) if (typeof key === 'string' && entry.written.has(key)) {
        message(id, 'activity', `Claude didn't run "${oneLine(entry.written.get(key).text, 80)}". Send it again if you still need it.`);
        entry.written.delete(key);
      }
      settle();
    }
    if (event.type === 'user' && !event.message.content.some(block => block.type === 'tool_result')) {
      const said = event.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const taken = entry.written.get(event.uuid) ?? [...entry.written.values()].find(next => next.text === said);
      if (taken) {
        entry.written.delete(taken.promptId);
        // A steer taken mid-turn joins it; anything taken between turns starts the next one.
        if (taken.kind !== 'steer' || !entry.turnOpen) { thoughts.clear(); completedThoughts.clear(); thoughtMessage = null; turnStarted(taken.promptId); entry.assistantId = null; }
        entry.turnOpen = true; backgroundUntil = 0; awaitingFollowup = false; clearTimeout(entry.settleTimer);
      }
    }
    // A background task can start its follow-up without another init or user replay.
    if (event.type === 'assistant' || (event.type === 'stream_event' && event.event?.type === 'message_start')) { entry.turnOpen = true; backgroundUntil = 0; awaitingFollowup = false; clearTimeout(entry.settleTimer); }
    if (event.type === 'stream_event') {
      if (event.event?.type === 'message_start') { entry.assistantId = null; thoughtIndex = null; thoughtMessage = typeof event.event.message?.id === 'string' ? event.event.message.id : `message-${++messageIndex}`; }
      if (event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') append(event.event.delta.text);
      if (entry.turnOpen && thoughtMessage && !completedThoughts.has(`${thoughtMessage}:${event.event?.index}`) && (event.event?.content_block?.type === 'thinking' || event.event?.delta?.type === 'thinking_delta')) {
        if (!thoughts.has(thoughtMessage)) thoughts.set(thoughtMessage, new Map());
        const parts = thoughts.get(thoughtMessage), index = event.event.index;
        thoughtIndex = index;
        parts.set(index, event.event.delta?.type === 'thinking_delta' ? (parts.get(index) ?? '') + event.event.delta.thinking : event.event.content_block.thinking); showThinking();
      }
    }
    if (event.type === 'assistant') {
      const blocks = event.message?.content ?? [], finalText = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (entry.turnOpen && blocks.some(block => block.type === 'thinking')) {
        const key = typeof event.message.id === 'string' ? event.message.id : thoughtMessage ?? `message-${++messageIndex}`;
        if (!thoughts.has(key)) thoughts.set(key, new Map());
        const parts = thoughts.get(key);
        for (const [position, block] of blocks.entries()) if (block.type === 'thinking') {
          // The CLI completes one block at a time; several blocks can share the same message id.
          const index = blocks.length === 1 ? (key === thoughtMessage && thoughtIndex !== null ? thoughtIndex : parts.size) : position;
          parts.set(index, block.thinking); completedThoughts.add(`${key}:${index}`);
        }
        thoughtIndex = null;
        showThinking();
      }
      if (finalText) {
        if (!entry.assistantId) append(finalText);
        else { run('UPDATE messages SET text=? WHERE id=?', finalText, entry.assistantId); change('message', id); }
      }
      for (const block of blocks) if (block.type === 'tool_use') {
        const toolMessage = message(id, 'activity', `${block.name}\n${JSON.stringify(block.input, null, 2)}`);
        if (typeof block.id === 'string') entry.tools.set(block.id, toolMessage);
        if (['Agent', 'Task'].includes(block.name) && typeof block.id === 'string') {
          if (block.input?.run_in_background) (entry.backgrounded ??= new Set()).add(block.id);
          subagent(id, entry.turnPrompt, agent, { id: block.id, title: String(block.input?.description ?? 'Sub-agent').slice(0, 100), kind: block.input?.subagent_type ?? null, model: block.input?.model ?? null, effort: row.effort === 'default' ? null : row.effort, status: 'running' });
        }
      }
      entry.assistantId = null;
    }
    // A result's message id names its tool message, so parallel calls pair exactly on every client.
    if (event.type === 'user') for (const block of event.message?.content ?? []) if (block.type === 'tool_result') {
      const toolMessage = entry.tools.get(block.tool_use_id); entry.tools.delete(block.tool_use_id);
      message(id, 'activity', `${block.is_error ? 'Tool failed' : 'Tool result'}\n${typeof block.content === 'string' ? block.content : JSON.stringify(block.content)}`, toolMessage ? `${toolMessage}:result` : undefined);
      // A sub-agent that ran in the foreground ends with its tool result; a backgrounded one reports through task events.
      const sub = typeof block.tool_use_id === 'string' && get('SELECT status FROM subagents WHERE chatId=? AND id=?', id, block.tool_use_id);
      if (sub && !entry.backgrounded?.has(block.tool_use_id)) subagent(id, entry.turnPrompt, agent, { id: block.tool_use_id, status: block.is_error ? 'failed' : 'completed' });
    }
    if (event.type === 'system') {
      if (event.subtype === 'api_retry' && [event.attempt, event.max_retries, event.retry_delay_ms].every(Number.isSafeInteger) && event.attempt > 0 && event.attempt <= event.max_retries && event.retry_delay_ms >= 0) {
        if (retryActivity === undefined) retryActivity = get('SELECT activity FROM chats WHERE id=?', id)?.activity ?? null;
        activityFor(id, `Claude is retrying (${event.attempt}/${event.max_retries}) in ${Math.ceil(event.retry_delay_ms / 1000)} seconds.`);
      }
      const toolId = taskTools.get(event.task_id) ?? (typeof event.tool_use_id === 'string' ? event.tool_use_id : event.task_type === 'local_agent' || event.subagent_type ? event.task_id : null);
      const task = typeof toolId === 'string' && !event.ambient && (event.task_type === 'local_agent' || event.subagent_type || get('SELECT id FROM subagents WHERE chatId=? AND id=?', id, toolId));
      if (event.subtype === 'task_started' && task) {
        if (typeof event.task_id === 'string') taskTools.set(event.task_id, toolId);
        if (event.is_backgrounded || backgroundTasks.has(event.task_id)) (entry.backgrounded ??= new Set()).add(toolId);
        subagent(id, entry.turnPrompt, agent, { id: toolId, title: event.description ? String(event.description).slice(0, 100) : null, kind: event.subagent_type ?? null, status: 'running' });
      }
      if (event.subtype === 'task_updated' && task && event.patch?.is_backgrounded) (entry.backgrounded ??= new Set()).add(toolId);
      if (event.subtype === 'task_progress' && task) subagent(id, entry.turnPrompt, agent, { id: toolId, activity: String(event.summary ?? event.description ?? '').slice(0, 200) || null, tokens: event.usage?.total_tokens ?? null, toolUses: event.usage?.tool_uses ?? null });
      if (event.subtype === 'task_notification' && task) subagent(id, entry.turnPrompt, agent, { id: toolId, status: event.status === 'completed' ? 'completed' : event.status === 'failed' ? 'failed' : 'stopped', activity: event.summary ? String(event.summary).slice(0, 200) : null, tokens: event.usage?.total_tokens ?? null, toolUses: event.usage?.tool_uses ?? null });
      if (event.subtype === 'background_tasks_changed' && Array.isArray(event.tasks)) {
        // Only sub-agents and workflows bring a follow-up turn; background shells and monitors don't hold the run open.
        const previous = entry.background;
        const tasks = event.tasks.filter(task => task && !task.ambient && ['local_agent', 'local_workflow'].includes(task.task_type));
        entry.background = tasks.length; backgroundTasks = new Set(tasks.map(task => task.task_id));
        for (const taskId of backgroundTasks) if (taskTools.has(taskId)) (entry.backgrounded ??= new Set()).add(taskTools.get(taskId));
        // The CLI usually starts a follow-up turn when the last background task ends; give it a moment before closing.
        if (previous > 0 && entry.background === 0) backgroundUntil = Date.now() + (options.backgroundGraceMs ?? 15_000);
        if (!entry.turnOpen) settle();
      }
      if (event.subtype === 'task_summary') activityFor(id, typeof event.detail === 'string' ? event.detail : null);
      if (['permission_denied', 'warning', 'error'].includes(event.subtype)) message(id, 'activity', typeof event.message === 'string' ? event.message : JSON.stringify(event));
    }
    if (event.type === 'result') {
      thoughts.clear(); completedThoughts.clear(); thoughtMessage = null; thinkingFor(id, null);
      // A follow-up may contain only a result, with no assistant blocks to clear its grace period.
      if (awaitingFollowup) backgroundUntil = 0;
      awaitingFollowup = entry.background > 0 || backgroundUntil > Date.now();
      entry.result = event; entry.turnOpen = false; run('UPDATE chats SET sessionStarted=1 WHERE id=?', id); if (event.result && !entry.sawText) append(event.result);
      if (event.is_error) {
        // An error is terminal even when the CLI leaves an old background task in its list.
        entry.background = 0; backgroundUntil = 0; awaitingFollowup = false;
        const detail = event.errors?.join('\n') || event.result;
        if (detail || ![...entry.written.values()].some(next => next.kind === 'interrupt')) message(id, 'activity', `Claude could not finish this turn.${detail ? `\n${detail}` : ''}`);
      }
      const context = claudeContext(event); if (context) run('UPDATE chats SET contextTokens=?,contextWindow=? WHERE id=?', context.used, context.window, id);
      // With background sub-agents still running, the turn continues in the follow-up Claude starts for them.
      if (entry.background === 0 && !awaitingFollowup) turnEnded();
      entry.sawText = false; entry.assistantId = null; settle();
    }
  };
  write(delivery);
  return consume;
}
