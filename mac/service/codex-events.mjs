// Translates Codex app-server notifications for a running chat into PocketBridge messages and sub-agents.
import { clean } from './util.mjs';

const unwrapShell = command => {
  const text = Array.isArray(command) ? command.join(' ') : String(command ?? '');
  const wrapped = /^\/bin\/(?:ba|z)?sh -lc (?:'([\s\S]*)'|(\S+))$/.exec(text);
  return wrapped ? (wrapped[1]?.replaceAll("'\\''", "'") ?? wrapped[2]) : text;
};
const contentText = value => {
  if (typeof value === 'string') return value;
  const blocks = Array.isArray(value?.content) ? value.content : Array.isArray(value) ? value : null;
  if (blocks) return blocks.map(block => typeof block?.text === 'string' ? block.text : '').filter(Boolean).join('\n');
  return value === undefined || value === null ? '' : JSON.stringify(value);
};

const subagentStatus = value => ({ pendingInit: 'running', running: 'running', inProgress: 'running', completed: 'completed', errored: 'failed', failed: 'failed', interrupted: 'stopped', shutdown: 'completed', notFound: 'failed' })[value] ?? 'running';

/**
 * Translates `codex app-server` notifications into PocketBridge messages, sub-agents and context use.
 * Result message ids are their tool message id plus ":result", as for Claude.
 */
export function codexAppConsumer({ say, update, append, subagent, context, activity, thinking = () => {} }) {
  const turns = new Map(), state = { failure: null };
  const reasoning = new Map();
  const showThinking = () => thinking([...reasoning.values()].flatMap(({ summary, content }) => {
    const parts = [...summary.values()].some(Boolean) ? summary : content;
    return [...parts].sort(([a], [b]) => a - b).map(([, text]) => text);
  }).filter(Boolean).join('\n\n'));
  const tool = (items, item, name, input) => { if (!items.has(item.id)) items.set(item.id, say('activity', `${name}\n${JSON.stringify(input, null, 2)}`)); return items.get(item.id); };
  const finish = (items, item, failed, text) => {
    const id = items.get(item.id); if (!id || items.get(`${item.id}:done`)) return;
    items.set(`${item.id}:done`, true); say('activity', `${failed ? 'Tool failed' : 'Tool result'}\n${text}`, `${id}:result`);
  };
  const kindOf = kind => typeof kind === 'string' ? kind : kind?.type ?? 'update';
  const consume = (method, params = {}) => {
    if (!params || typeof params !== 'object') return;
    if (method === 'turn/started') { state.failure = null; reasoning.clear(); thinking(null); return; }
    if (method === 'turn/completed') {
      for (const item of Array.isArray(params.turn?.items) ? params.turn.items : []) consume('item/completed', { ...params, turnId: params.turn.id, item });
      reasoning.clear(); thinking(null);
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      const last = params.tokenUsage?.last, window = Number(params.tokenUsage?.modelContextWindow);
      const used = (Number(last?.inputTokens) || 0) + (Number(last?.outputTokens) || 0);
      if (used > 0 && window > 0) context(used, window);
      return;
    }
    if (method === 'error' && params.willRetry !== true) { state.failure = clean(params.error?.message ?? params.message, 4000) || 'Codex reported an error.'; return; }
    if (!['item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'item/started', 'item/completed'].includes(method)) return;
    const turnId = params.turnId ?? '';
    if (!turns.has(turnId)) turns.set(turnId, new Map());
    const items = turns.get(turnId);
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const summary = method === 'item/reasoning/summaryTextDelta', index = summary ? params.summaryIndex : params.contentIndex;
      if (typeof params.itemId !== 'string' || !params.itemId || typeof params.delta !== 'string' || !Number.isSafeInteger(index) || index < 0 || items.has(`${params.itemId}:done`)) return;
      if (!reasoning.has(params.itemId)) reasoning.set(params.itemId, { summary: new Map(), content: new Map() });
      const parts = reasoning.get(params.itemId)[summary ? 'summary' : 'content'];
      parts.set(index, (parts.get(index) ?? '') + params.delta); showThinking(); return;
    }
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string' && typeof params.itemId === 'string' && params.itemId) {
      if (items.has(`${params.itemId}:done`)) return;
      if (!items.has(params.itemId)) items.set(params.itemId, say('assistant', ''));
      append(items.get(params.itemId), params.delta); return;
    }
    if (method !== 'item/started' && method !== 'item/completed') return;
    const item = params.item, completed = method === 'item/completed';
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') return;
    if (item.type === 'reasoning') {
      if (!reasoning.has(item.id)) reasoning.set(item.id, { summary: new Map(), content: new Map() });
      for (const key of ['summary', 'content']) if (Array.isArray(item[key]) && item[key].every(part => typeof part === 'string')) reasoning.get(item.id)[key] = new Map(item[key].map((part, index) => [index, part]));
      showThinking();
      if (completed) items.set(`${item.id}:done`, true);
    }
    if (item.type === 'agentMessage') {
      if (!items.has(item.id) && (item.text || completed)) items.set(item.id, say('assistant', item.text ?? ''));
      else if (completed && typeof item.text === 'string') update(items.get(item.id), item.text);
      if (completed) items.set(`${item.id}:done`, true);
    }
    if (item.type === 'commandExecution') {
      tool(items, item, 'Shell', { command: unwrapShell(item.command) });
      if (completed) {
        const failed = item.status === 'failed' || item.status === 'declined' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
        const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
        finish(items, item, failed, output || (failed ? `Exit code ${item.exitCode ?? 'unknown'}` : ''));
      }
    }
    if (item.type === 'fileChange' && completed) {
      const changes = (Array.isArray(item.changes) ? item.changes : []).map(change => ({ path: String(change?.path ?? ''), kind: kindOf(change?.kind) }));
      tool(items, item, 'Edit', changes.length === 1 ? { file_path: changes[0].path, kind: changes[0].kind } : { description: `Edited ${changes.length} files`, changes });
      finish(items, item, item.status === 'failed' || item.status === 'declined', changes.map(change => `${change.kind} ${change.path}`).join('\n'));
    }
    if (item.type === 'mcpToolCall') {
      const name = `${item.server ?? 'mcp'}.${item.tool ?? 'tool'}`.replace(/[^\w.:-]/g, '_').slice(0, 80);
      tool(items, item, /^[A-Za-z]/.test(name) ? name : `mcp.${name}`, item.arguments && typeof item.arguments === 'object' ? item.arguments : {});
      if (completed) finish(items, item, item.status === 'failed' || Boolean(item.error), item.error ? contentText(item.error.message ?? item.error) : contentText(item.result));
    }
    if (item.type === 'webSearch' && completed && !items.has(item.id)) items.set(item.id, say('activity', `Searched the web for "${clean(item.query, 200)}"`));
    if (item.type === 'contextCompaction' && completed && !items.has(item.id)) items.set(item.id, say('activity', 'Context compacted'));
    if (item.type === 'plan' && completed && typeof item.text === 'string' && !items.has(item.id)) items.set(item.id, say('activity', `Plan\n${clean(item.text, 2000)}`));
    if (item.type === 'collabAgentToolCall') {
      const states = item.agentsStates && typeof item.agentsStates === 'object' ? item.agentsStates : {};
      for (const thread of Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []) {
        const known = states[thread];
        if (item.tool === 'spawnAgent') subagent({ id: thread, title: clean(String(item.prompt ?? '').split('\n')[0], 80) || 'Sub-agent', model: item.model ?? null, effort: item.reasoningEffort ?? null, status: known ? subagentStatus(known.status) : 'running', activity: clean(known?.message, 200) || null });
        else if (known) subagent({ id: thread, status: subagentStatus(known.status), activity: clean(known.message, 200) || null });
      }
      for (const [thread, known] of Object.entries(states)) if (!(item.receiverThreadIds ?? []).includes(thread)) subagent({ id: thread, status: subagentStatus(known?.status), activity: clean(known?.message, 200) || null });
    }
    if (item.type === 'commandExecution' && !completed) activity(`Running ${clean(unwrapShell(item.command), 80)}`);
  };
  return { consume, state };
}
