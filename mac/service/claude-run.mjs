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
  // A continued Terminal session is forked on its first turn so the original keeps its own history.
  const session = row.sessionStarted ? ['--resume', id] : row.forkFrom ? ['--resume', row.forkFrom, '--fork-session', '--session-id', id] : ['--session-id', id];
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
  const { run, get, change, options, message, subagent, activityFor, cancelApprovals, status } = ctx;
  const { id, row, agent, child, entry, turnStarted, turnEnded, append } = session;
  entry.written = new Map(); entry.background = 0; entry.turnOpen = false;
  const write = next => { child.stdin.write(JSON.stringify(claudeUserMessage(next.promptId, next.text, next.attachments)) + '\n'); entry.written.set(next.promptId, next); };
  // stdin closes once the last turn ended, no background sub-agent can add a turn, and every message was taken.
  const settle = (force = false) => {
    clearTimeout(entry.settleTimer);
    if (entry.finishing || entry.turnOpen || entry.background > 0) return;
    // A message the CLI never echoes (a local slash command, a discarded queued command) must not hold the run
    // open: once the turn has ended, close after a short wait; the CLI still runs input it already took.
    if (entry.written.size && !force) { entry.settleTimer = setTimeout(() => settle(true), options.writtenGraceMs ?? 10_000); return; }
    entry.finishing = true; child.stdin.end();
  };
  entry.steer = next => { if (entry.finishing) entry.after.push(next); else write(next); };
  entry.interrupt = next => {
    if (entry.finishing) { entry.after.push(next); return; }
    cancelApprovals(id);
    if (get('SELECT status FROM chats WHERE id=?', id)?.status === 'waiting') status(id, 'running');
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: `interrupt-${next.promptId}`, request: { subtype: 'interrupt' } }) + '\n');
    write(next);
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
    const malformed = () => { entry.parseError = 'Claude returned malformed structured output.'; };
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') { malformed(); return; }
    if (['assistant', 'user'].includes(event.type) && (!Array.isArray(event.message?.content) || event.message.content.some(block => !block || typeof block !== 'object' || typeof block.type !== 'string' || (block.type === 'text' && typeof block.text !== 'string')))) { malformed(); return; }
    if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta' && typeof event.event.delta.text !== 'string') { malformed(); return; }
    if (event.type === 'result' && ((event.result !== undefined && typeof event.result !== 'string') || (event.errors !== undefined && (!Array.isArray(event.errors) || event.errors.some(error => typeof error !== 'string'))))) { malformed(); return; }
    // A sub-agent's own messages describe that sub-agent; the chat shows them as its activity, not as replies.
    if (typeof event.parent_tool_use_id === 'string') { routeSubagent(event); return; }
    if (event.type === 'system' && event.subtype === 'init') { run('UPDATE chats SET sessionStarted=1 WHERE id=?', id); if (entry.turnPrompt || entry.written.size === 0) { entry.turnOpen = true; clearTimeout(entry.settleTimer); } }
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
        if (taken.kind !== 'steer' || !entry.turnOpen) { turnStarted(taken.promptId); entry.assistantId = null; }
        entry.turnOpen = true; clearTimeout(entry.settleTimer);
      }
    }
    if (event.type === 'stream_event') {
      if (event.event?.type === 'message_start') entry.assistantId = null;
      if (event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') append(event.event.delta.text);
    }
    if (event.type === 'assistant') {
      const blocks = event.message?.content ?? [], finalText = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (finalText) {
        if (!entry.assistantId) append(finalText);
        else { run('UPDATE messages SET text=? WHERE id=?', finalText, entry.assistantId); change('message', id); }
      }
      for (const block of blocks) if (block.type === 'tool_use') {
        const toolMessage = message(id, 'activity', `${block.name}\n${JSON.stringify(block.input, null, 2)}`);
        if (typeof block.id === 'string') entry.tools.set(block.id, toolMessage);
        if (['Agent', 'Task'].includes(block.name) && typeof block.id === 'string') subagent(id, entry.turnPrompt, agent, { id: block.id, title: String(block.input?.description ?? 'Sub-agent').slice(0, 100), kind: block.input?.subagent_type ?? null, model: block.input?.model ?? null, effort: row.effort === 'default' ? null : row.effort, status: 'running' });
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
      const task = typeof event.tool_use_id === 'string' && (event.task_type === 'local_agent' || event.subagent_type || get('SELECT id FROM subagents WHERE chatId=? AND id=?', id, event.tool_use_id));
      if (event.subtype === 'task_started' && task) {
        if (event.is_backgrounded) (entry.backgrounded ??= new Set()).add(event.tool_use_id);
        subagent(id, entry.turnPrompt, agent, { id: event.tool_use_id, title: event.description ? String(event.description).slice(0, 100) : null, kind: event.subagent_type ?? null, status: 'running' });
      }
      if (event.subtype === 'task_progress' && task) subagent(id, entry.turnPrompt, agent, { id: event.tool_use_id, activity: event.description ? String(event.description).slice(0, 200) : null, tokens: event.usage?.total_tokens ?? null, toolUses: event.usage?.tool_uses ?? null });
      if (event.subtype === 'task_notification' && task) subagent(id, entry.turnPrompt, agent, { id: event.tool_use_id, status: event.status === 'completed' ? 'completed' : event.status === 'failed' ? 'failed' : 'stopped', activity: event.summary ? String(event.summary).slice(0, 200) : null });
      if (event.subtype === 'background_tasks_changed' && Array.isArray(event.tasks)) {
        // Only sub-agents and workflows bring a follow-up turn; background shells and monitors don't hold the run open.
        entry.background = event.tasks.filter(task => task && !task.ambient && ['local_agent', 'local_workflow'].includes(task.task_type)).length;
        // The CLI usually starts a follow-up turn when the last background task ends; give it a moment before closing.
        if (entry.background === 0 && !entry.turnOpen) { clearTimeout(entry.settleTimer); entry.settleTimer = setTimeout(settle, options.backgroundGraceMs ?? 15_000); }
      }
      if (event.subtype === 'task_summary') activityFor(id, typeof event.detail === 'string' ? event.detail : null);
      if (['permission_denied', 'warning', 'error'].includes(event.subtype)) message(id, 'activity', typeof event.message === 'string' ? event.message : JSON.stringify(event));
    }
    if (event.type === 'result') {
      entry.result = event; entry.turnOpen = false; run('UPDATE chats SET sessionStarted=1 WHERE id=?', id); if (event.result && !entry.sawText) append(event.result);
      const context = claudeContext(event); if (context) run('UPDATE chats SET contextTokens=?,contextWindow=? WHERE id=?', context.used, context.window, id);
      // With background sub-agents still running, the turn continues in the follow-up Claude starts for them.
      if (entry.background === 0) turnEnded();
      entry.sawText = false; entry.assistantId = null; settle();
    }
  };
  write(delivery);
  return consume;
}
