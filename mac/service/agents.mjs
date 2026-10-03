// Agent CLIs PocketBridge can run: the official Claude Code CLI and the official Codex CLI.
// Both keep their own login. Model catalogs come from each CLI's local handshake, never an API call.
import { spawn, execFile } from 'node:child_process';
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

export const agentIds = ['claude', 'codex'];
export const agentNames = { claude: 'Claude', codex: 'Codex' };
export const agentModes = {
  claude: ['bypassPermissions', 'auto', 'plan', 'acceptEdits', 'default'],
  codex: ['bypassPermissions', 'auto', 'readOnly'],
};
const knownEfforts = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] };
// Model names are passed as their own argv entry; a leading dash could still read as a flag.
const safeModel = /^[A-Za-z0-9][\w.:-]{0,99}(\[1m\])?$/;
const clean = (value, max = 160) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Variables that would move either CLI off its own subscription login. */
export function agentEnv(agent, base = process.env) {
  const env = { ...base };
  const remove = agent === 'codex'
    ? ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID']
    : ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_RESUME_INTERRUPTED_TURN', 'CLAUDE_CODE_SKIP_PROMPT_HISTORY', 'CLAUDE_CODE_SIMPLE'];
  for (const key of remove) delete env[key];
  return env;
}

/** Runs a short JSON-lines conversation with a CLI and stops its whole process group afterwards. */
function converse({ command, args, cwd, env, signal, timeoutMs = 20_000, start, onMessage }) {
  return new Promise(resolve => {
    let child, done = false, buffer = '';
    const finish = value => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      try { child?.stdin.end(); } catch { /* already closed */ }
      const kill = name => { try { if (child?.pid) process.kill(-child.pid, name); } catch { /* exited */ } };
      kill('SIGTERM'); setTimeout(() => { if (child && child.exitCode === null && child.signalCode === null) kill('SIGKILL'); }, 2000).unref();
      resolve(value);
    };
    const abort = () => finish(null);
    const timer = setTimeout(abort, timeoutMs);
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort);
    try { child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] }); } catch { return abort(); }
    const write = value => { if (!done) child.stdin.write(JSON.stringify(value) + '\n'); };
    child.on('error', abort); child.on('close', abort); child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk; if (buffer.length > 5_000_000) return abort();
      let newline;
      while (!done && (newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (!message || typeof message !== 'object') continue;
        const result = onMessage(message, write); if (result !== undefined) finish(result);
      }
    });
    start(write);
  });
}

const preferredClaudeEffort = path => {
  if (!path) return undefined;
  try { const value = JSON.parse(readFileSync(path, 'utf8')).effortLevel; return typeof value === 'string' ? value : undefined; } catch { return undefined; }
};

/** Claude's model picker, read from the CLI's initialize handshake. "default" becomes the model it resolves to. */
export function normalizeClaude(models, preferred) {
  if (!Array.isArray(models)) return null;
  const entries = models.filter(model => model && typeof model.value === 'string' && safeModel.test(model.value));
  const fallback = entries.find(model => model.value === 'default');
  const list = entries.filter(model => model.value !== 'default').map(model => {
    const efforts = model.supportsEffort && Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.filter(effort => typeof effort === 'string' && /^[a-z]{2,12}$/.test(effort)) : [];
    const defaultEffort = efforts.includes(preferred) ? preferred : efforts.includes('high') ? 'high' : efforts.at(-1) ?? 'default';
    return { id: model.value, name: clean(model.displayName, 60) || model.value, description: clean(model.description), resolved: typeof model.resolvedModel === 'string' ? model.resolvedModel : model.value, efforts, defaultEffort };
  });
  if (!list.length) return null;
  const defaultModel = list.find(model => fallback && model.resolved === fallback.resolvedModel) ?? list[0];
  return { models: list, defaultModel: defaultModel.id, defaultEffort: defaultModel.defaultEffort };
}

export async function claudeCatalog({ command, cwd, env, signal, settingsPath, timeoutMs }) {
  const request = 'pocketbridge-models';
  const response = await converse({
    command, cwd, env, signal, timeoutMs,
    args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config'],
    start: write => write({ type: 'control_request', request_id: request, request: { subtype: 'initialize' } }),
    onMessage: message => message.type === 'control_response' && message.response?.request_id === request ? (message.response.response ?? null) : undefined,
  });
  return normalizeClaude(response?.models, preferredClaudeEffort(settingsPath));
}

/** Codex's visible model list plus the model and reasoning effort chosen in its own config. */
export function normalizeCodex(models, config = {}) {
  if (!Array.isArray(models)) return null;
  const list = models.filter(model => model && !model.hidden && typeof (model.id ?? model.model) === 'string' && safeModel.test(model.id ?? model.model)).map(model => {
    const efforts = (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []).map(option => typeof option === 'string' ? option : option?.reasoningEffort).filter(effort => typeof effort === 'string' && /^[a-z]{2,12}$/.test(effort));
    const defaultEffort = efforts.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort : efforts.includes('medium') ? 'medium' : efforts[0] ?? 'default';
    return { id: model.id ?? model.model, name: clean(model.displayName, 60) || model.id, description: clean(model.description), resolved: model.model ?? model.id, efforts, defaultEffort, isDefault: model.isDefault === true };
  });
  if (!list.length) return null;
  const chosen = list.find(model => model.id === config?.model) ?? list.find(model => model.isDefault) ?? list[0];
  const effort = chosen.efforts.includes(config?.model_reasoning_effort) ? config.model_reasoning_effort : chosen.defaultEffort;
  return { models: list.map(({ isDefault, ...model }) => model), defaultModel: chosen.id, defaultEffort: effort };
}

export async function codexCatalog({ command, cwd, env, signal, timeoutMs }) {
  let models, config;
  const result = await converse({
    command, cwd, env, signal, timeoutMs, args: ['app-server'],
    start: write => write({ id: 0, method: 'initialize', params: { clientInfo: { name: 'pocketbridge', title: 'PocketBridge', version: '1' } } }),
    onMessage: (message, write) => {
      if (message.id === 0) { if (message.error) return null; write({ method: 'initialized' }); write({ id: 1, method: 'model/list', params: {} }); write({ id: 2, method: 'config/read', params: {} }); return; }
      if (message.id === 1) models = message.result?.data ?? null;
      if (message.id === 2) config = message.result?.config ?? {};
      if (models === null) return null;
      if (models !== undefined && config !== undefined) return true;
    },
  });
  return result ? normalizeCodex(models, config) : null;
}

/** Options for one validated value: a catalog entry when the CLI listed it, otherwise a safe pass-through. */
export function checkModel(agent, value, catalog) {
  if (typeof value !== 'string') return false;
  if (value === 'default' || (agent === 'claude' && ['opus', 'sonnet', 'haiku', 'fable'].includes(value))) return true;
  if (catalog) return catalog.models.some(model => model.id === value || model.resolved === value);
  return safeModel.test(value);
}
export function checkEffort(agent, model, effort, catalog) {
  if (effort === 'default') return true;
  const entry = catalog?.models.find(item => item.id === model || item.resolved === model) ?? (model === 'default' ? catalog?.models.find(item => item.id === catalog.defaultModel) : undefined);
  return entry ? entry.efforts.includes(effort) : knownEfforts[agent].includes(effort);
}

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
const todoText = items => ['Plan', ...(Array.isArray(items) ? items : []).map(item => `${item?.completed ? '[x]' : '[ ]'} ${clean(item?.text, 300)}`)].join('\n');

// Codex desktop keeps throwaway task folders as ~/Documents/Codex/<date>/… or ~/Documents/Codex/<date>-<task>.
const codexScratch = /\/Documents\/Codex\/\d{4}-\d{2}-\d{2}[/-]/;
const firstLine = file => {
  let fd;
  try {
    fd = openSync(file, 'r');
    let text = '';
    for (let offset = 0; offset < 512 * 1024; offset += 64 * 1024) {
      const buf = Buffer.alloc(64 * 1024), got = readSync(fd, buf, 0, buf.length, offset);
      text += buf.toString('utf8', 0, got);
      const newline = text.indexOf('\n'); if (newline >= 0) return text.slice(0, newline);
      if (got < buf.length) return text;
    }
  } catch { /* unreadable session */ } finally { if (fd !== undefined) closeSync(fd); }
  return '';
};

/**
 * Folders from Codex session metadata (sessions/YYYY/MM/DD/rollout-*.jsonl). Reads only the first line of
 * the newest `limit` sessions, caches it by file, and never imports the conversations themselves.
 */
export function codexSessionFolders(sessionsDir, cache, limit = 300) {
  const found = [];
  const names = dir => { try { return readdirSync(dir).sort().reverse(); } catch { return []; } };
  outer: for (const year of names(sessionsDir).filter(name => /^\d{4}$/.test(name)))
    for (const month of names(join(sessionsDir, year)).filter(name => /^\d{2}$/.test(name)))
      for (const day of names(join(sessionsDir, year, month)).filter(name => /^\d{2}$/.test(name)))
        for (const name of names(join(sessionsDir, year, month, day)).filter(name => name.startsWith('rollout-') && name.endsWith('.jsonl'))) {
          if (found.length >= limit) break outer;
          const file = join(sessionsDir, year, month, day, name);
          let mtime; try { mtime = statSync(file).mtimeMs; } catch { continue; }
          if (!cache.has(file)) {
            let cwd = null;
            try {
              const record = JSON.parse(firstLine(file));
              const payload = record?.type === 'session_meta' ? record.payload : null;
              if (payload && typeof payload.cwd === 'string' && !payload.cwd.includes('\0') && (payload.thread_source ?? 'user') === 'user' && !codexScratch.test(payload.cwd + '/')) cwd = payload.cwd;
            } catch { /* malformed metadata is skipped */ }
            cache.set(file, cwd);
          }
          found.push({ cwd: cache.get(file), mtime });
        }
  return found.filter(entry => entry.cwd);
}

const planNames = { pro: 'Pro', max: 'Max', plus: 'Plus', prolite: 'Pro Lite', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', free: 'Free' };
const planName = value => typeof value === 'string' && value ? planNames[value.toLowerCase()] ?? value.replace(/(^|[_\s-])(\w)/g, (_, gap, letter) => (gap ? ' ' : '') + letter.toUpperCase()) : '';
const percent = value => Math.max(0, Math.min(100, Math.round(Number(value))));
const severity = (value, used) => ['normal', 'warning', 'critical'].includes(value) ? value : used >= 90 ? 'critical' : used >= 75 ? 'warning' : 'normal';

/** Plan limits from Claude's own /usage data: session, weekly and any per-model weekly limit. */
export function normalizeClaudeUsage(response) {
  const limits = response?.rate_limits?.limits;
  if (!Array.isArray(limits)) return null;
  const label = limit => {
    const model = clean(limit.scope?.model?.display_name, 40);
    if (limit.kind === 'session') return '5-hour session';
    if (limit.kind === 'weekly_all') return 'Weekly';
    if (model) return `Weekly · ${model}`;
    return clean(String(limit.kind ?? 'Limit').replace(/_/g, ' '), 40);
  };
  return {
    plan: planName(response.subscription_type),
    limits: limits.filter(limit => limit && Number.isFinite(Number(limit.percent))).map(limit => {
      const used = percent(limit.percent);
      return { id: `${limit.kind}${limit.scope?.model?.display_name ? `:${limit.scope.model.display_name}` : ''}`, label: label(limit), percent: used, resetsAt: Date.parse(limit.resets_at) || null, severity: severity(limit.severity, used) };
    }),
  };
}

export async function claudeUsage({ command, cwd, env, signal, timeoutMs }) {
  const response = await converse({
    command, cwd, env, signal, timeoutMs,
    args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config'],
    start: write => { write({ type: 'control_request', request_id: 'pocketbridge-init', request: { subtype: 'initialize' } }); write({ type: 'control_request', request_id: 'pocketbridge-usage', request: { subtype: 'get_usage' } }); },
    onMessage: message => message.type === 'control_response' && message.response?.request_id === 'pocketbridge-usage' ? (message.response.response ?? null) : undefined,
  });
  return normalizeClaudeUsage(response);
}

/** Codex plan windows (usually 5-hour and weekly) and any prepaid credit balance. */
export function normalizeCodexUsage(result) {
  const limits = result?.rateLimits;
  if (!limits || typeof limits !== 'object') return null;
  const label = minutes => minutes === 300 ? '5-hour' : minutes === 10080 ? 'Weekly' : minutes >= 1440 ? `${Math.round(minutes / 1440)}-day` : `${Math.max(1, Math.round(minutes / 60))}-hour`;
  const windows = [['primary', limits.primary], ['secondary', limits.secondary]].filter(([, window]) => window && Number.isFinite(Number(window.usedPercent)));
  const credits = limits.credits?.hasCredits && !limits.credits.unlimited && Number.isFinite(Number(limits.credits.balance)) ? Number(limits.credits.balance) : undefined;
  return {
    plan: planName(limits.planType),
    limits: windows.map(([id, window]) => {
      const used = percent(window.usedPercent);
      return { id, label: label(Number(window.windowDurationMins)), percent: used, resetsAt: Number(window.resetsAt) > 0 ? Number(window.resetsAt) * 1000 : null, severity: severity(null, used) };
    }),
    ...(credits !== undefined ? { credits } : {}),
  };
}

export async function codexUsage({ command, cwd, env, signal, timeoutMs }) {
  const result = await converse({
    command, cwd, env, signal, timeoutMs, args: ['app-server'],
    start: write => write({ id: 0, method: 'initialize', params: { clientInfo: { name: 'pocketbridge', title: 'PocketBridge', version: '1' } } }),
    onMessage: (message, write) => {
      if (message.id === 0) { if (message.error) return null; write({ method: 'initialized' }); write({ id: 1, method: 'account/rateLimits/read', params: {} }); return; }
      if (message.id === 1) return message.result ?? null;
    },
  });
  return normalizeCodexUsage(result);
}

/** Context in use after a Claude turn: the last request's prompt and output against the main model's window. */
export function claudeContext(result) {
  const models = Object.values(result?.modelUsage ?? {}).filter(model => model && Number(model.contextWindow) > 0);
  const main = models.sort((a, b) => (Number(b.inputTokens) + Number(b.cacheReadInputTokens) || 0) - (Number(a.inputTokens) + Number(a.cacheReadInputTokens) || 0))[0];
  const iterations = result?.usage?.iterations;
  const last = Array.isArray(iterations) && iterations.length ? iterations.at(-1) : result?.usage;
  const used = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'].reduce((sum, key) => sum + (Number(last?.[key]) || 0), 0);
  return main && used > 0 ? { used, window: Number(main.contextWindow) } : null;
}

/** Codex sandbox and approval settings for a PocketBridge permission mode. Codex never stops to ask. */
export const codexPolicy = mode => ({ approvalPolicy: 'never', sandbox: mode === 'bypassPermissions' ? 'danger-full-access' : mode === 'readOnly' ? 'read-only' : 'workspace-write' });

const subagentStatus = value => ({ pendingInit: 'running', running: 'running', inProgress: 'running', completed: 'completed', errored: 'failed', failed: 'failed', interrupted: 'stopped', shutdown: 'completed', notFound: 'failed' })[value] ?? 'running';

/**
 * Translates `codex app-server` notifications into PocketBridge messages, sub-agents and context use.
 * Result message ids are their tool message id plus ":result", as for Claude.
 */
export function codexAppConsumer({ say, update, append, subagent, context, activity }) {
  const items = new Map(), state = { failure: null };
  const tool = (item, name, input) => { if (!items.has(item.id)) items.set(item.id, say('activity', `${name}\n${JSON.stringify(input, null, 2)}`)); return items.get(item.id); };
  const finish = (item, failed, text) => {
    const id = items.get(item.id); if (!id || items.get(`${item.id}:done`)) return;
    items.set(`${item.id}:done`, true); say('activity', `${failed ? 'Tool failed' : 'Tool result'}\n${text}`, `${id}:result`);
  };
  const kindOf = kind => typeof kind === 'string' ? kind : kind?.type ?? 'update';
  const consume = (method, params = {}) => {
    if (method === 'thread/tokenUsage/updated') {
      const last = params.tokenUsage?.last, window = Number(params.tokenUsage?.modelContextWindow);
      const used = (Number(last?.inputTokens) || 0) + (Number(last?.outputTokens) || 0);
      if (used > 0 && window > 0) context(used, window);
      return;
    }
    if (method === 'error' && params.willRetry !== true) { state.failure = clean(params.error?.message ?? params.message, 4000) || 'Codex reported an error.'; return; }
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      if (!items.has(params.itemId)) items.set(params.itemId, say('assistant', ''));
      append(items.get(params.itemId), params.delta); return;
    }
    if (method !== 'item/started' && method !== 'item/completed') return;
    const item = params.item, completed = method === 'item/completed';
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') return;
    if (item.type === 'agentMessage') {
      if (!items.has(item.id) && (item.text || completed)) items.set(item.id, say('assistant', item.text ?? ''));
      else if (completed && typeof item.text === 'string') update(items.get(item.id), item.text);
    }
    if (item.type === 'commandExecution') {
      tool(item, 'Shell', { command: unwrapShell(item.command) });
      if (completed) {
        const failed = item.status === 'failed' || item.status === 'declined' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
        const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
        finish(item, failed, output || (failed ? `Exit code ${item.exitCode ?? 'unknown'}` : ''));
      }
    }
    if (item.type === 'fileChange' && completed) {
      const changes = (Array.isArray(item.changes) ? item.changes : []).map(change => ({ path: String(change?.path ?? ''), kind: kindOf(change?.kind) }));
      tool(item, 'Edit', changes.length === 1 ? { file_path: changes[0].path, kind: changes[0].kind } : { description: `Edited ${changes.length} files`, changes });
      finish(item, item.status === 'failed' || item.status === 'declined', changes.map(change => `${change.kind} ${change.path}`).join('\n'));
    }
    if (item.type === 'mcpToolCall') {
      const name = `${item.server ?? 'mcp'}.${item.tool ?? 'tool'}`.replace(/[^\w.:-]/g, '_').slice(0, 80);
      tool(item, /^[A-Za-z]/.test(name) ? name : `mcp.${name}`, item.arguments && typeof item.arguments === 'object' ? item.arguments : {});
      if (completed) finish(item, item.status === 'failed' || Boolean(item.error), item.error ? contentText(item.error.message ?? item.error) : contentText(item.result));
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

/** One user message for Claude's stream-json input: text then any images, base64 from the upload files. */
export function claudeUserMessage(id, text, images = []) {
  return { type: 'user', uuid: id, parent_tool_use_id: null, session_id: '', message: { role: 'user', content: [{ type: 'text', text }, ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.type, data: readFileSync(image.path).toString('base64') } }))] } };
}

const git = (cwd, args, timeout = 4000) => new Promise(resolveGit => execFile('git', ['-C', cwd, ...args], { timeout, maxBuffer: 32_000_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } }, (error, stdout) => resolveGit(error ? { error } : { stdout })));

/** Branch, ahead/behind and lines changed against HEAD, including new files. Null when the folder isn't a repo. */
export async function gitStatus(cwd) {
  // A folder with a huge untracked tree falls back to listing untracked folders rather than every file.
  // Counts cover the project folder only, even when it sits inside a larger repository.
  // -z keeps unusual file names unquoted so they can be read back.
  let listed = await git(cwd, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--', '.']);
  if (listed.error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') listed = await git(cwd, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal', '--', '.']);
  if (listed.error) return null;
  const status = listed.stdout;
  let branch = null, oid = null, ahead = 0, behind = 0, files = 0;
  const untracked = [];
  const records = status.split('\0');
  for (let index = 0; index < records.length; index++) {
    const line = records[index];
    if (line.startsWith('# branch.head ')) branch = line.slice(14);
    else if (line.startsWith('# branch.oid ')) oid = line.slice(13);
    else if (line.startsWith('# branch.ab ')) { const [, a, b] = /\+(\d+) -(\d+)/.exec(line) ?? []; ahead = Number(a) || 0; behind = Number(b) || 0; }
    else if (line.startsWith('? ')) { untracked.push(line.slice(2)); files++; }
    else if (/^[12u] /.test(line)) { files++; if (line.startsWith('2 ')) index++; } // a rename's original path follows it
  }
  const base = oid && oid !== '(initial)' ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  // With -z, paths are relative to the repository root even when the project is a folder inside it.
  const top = ((await git(cwd, ['rev-parse', '--show-toplevel'])).stdout ?? '').replace(/\n$/, '') || cwd;
  let added = 0, removed = 0;
  for (const line of ((await git(cwd, ['diff', '--numstat', base, '--', '.'])).stdout ?? '').split('\n')) {
    const [plus, minus] = line.split('\t'); if (/^\d+$/.test(plus)) added += Number(plus); if (/^\d+$/.test(minus)) removed += Number(minus);
  }
  // New files count as added lines. Reads are async and capped so a big untracked tree can't stall the service.
  let budget = 4_000_000;
  for (const file of untracked.slice(0, 200)) {
    try {
      const path = join(top, file), info = await stat(path);
      if (!info.isFile() || info.size > 1_000_000 || info.size > budget) continue;
      budget -= info.size;
      const text = await readFile(path); if (!text.length || text.includes(0)) continue;
      added += text.toString('utf8').split('\n').length - (text.at(-1) === 10 ? 1 : 0);
    } catch { /* vanished */ }
  }
  return { branch: branch === '(detached)' ? null : branch, detached: branch === '(detached)', commit: oid && oid !== '(initial)' ? oid.slice(0, 7) : null, ahead, behind, files, added, removed };
}

const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
const promptLike = text => text && !/^\s*(<|Caveat:|\[Request interrupted)/.test(text);

/** Claude sessions in one project directory, newest first, with a title and their last exchange. Sidechains are skipped. */
export function claudeSessions(dir, limit = 20) {
  let names; try { names = readdirSync(dir).filter(name => name.endsWith('.jsonl') && !name.includes('subagent')); } catch { return []; }
  const files = names.map(name => { try { const info = statSync(join(dir, name)); return { name, mtime: info.mtimeMs, size: info.size }; } catch { return null; } }).filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  const sessions = [];
  for (const file of files) {
    let fd, head = '', tail = '';
    try {
      fd = openSync(join(dir, file.name), 'r');
      const headLength = Math.min(file.size, 256 * 1024), headBuf = Buffer.alloc(headLength); readSync(fd, headBuf, 0, headLength, 0); head = headBuf.toString('utf8');
      const tailLength = Math.min(file.size, 512 * 1024), tailBuf = Buffer.alloc(tailLength); readSync(fd, tailBuf, 0, tailLength, file.size - tailLength); tail = tailBuf.toString('utf8');
    } catch { continue; } finally { if (fd !== undefined) closeSync(fd); }
    const records = text => text.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(record => record && typeof record === 'object');
    const first = records(head), last = records(tail);
    if (first.some(record => record.isSidechain === true) && !first.some(record => record.type === 'user' && record.isSidechain === false)) continue;
    const userText = record => record.type === 'user' && !record.isSidechain && record.message?.role === 'user' ? textOf(record.message.content) : '';
    const summary = [...first, ...last].reverse().find(record => record.type === 'summary' && typeof record.summary === 'string')?.summary;
    const firstPrompt = first.map(userText).find(promptLike);
    if (!firstPrompt && !summary) continue;
    const promptAt = last.findLastIndex(record => promptLike(userText(record))), lastPrompt = promptAt >= 0 ? userText(last[promptAt]) : undefined;
    // The reply belongs to that prompt only if it came after it; an unanswered last prompt has none.
    const lastReply = last.slice(promptAt + 1).reverse().find(record => record.type === 'assistant' && !record.isSidechain && textOf(record.message?.content).trim());
    const cwd = first.find(record => typeof record.cwd === 'string')?.cwd ?? null;
    sessions.push({ agent: 'claude', id: file.name.slice(0, -6), cwd, title: clean(summary || firstPrompt, 100), updatedAt: Math.floor(file.mtime), lastPrompt: lastPrompt ? lastPrompt.slice(0, 4000) : null, lastReply: lastReply ? textOf(lastReply.message.content).slice(0, 8000) : null });
  }
  return sessions;
}

/** A short app-server conversation for listings: Codex skills, threads in a folder, or a thread's last turn. */
export async function codexRequest({ command, cwd, env, signal, timeoutMs, method, params }) {
  return converse({
    command, cwd, env, signal, timeoutMs, args: ['app-server'],
    start: write => write({ id: 0, method: 'initialize', params: { clientInfo: { name: 'pocketbridge', title: 'PocketBridge', version: '1' } } }),
    onMessage: (message, write) => {
      if (message.id === 0) { if (message.error) return null; write({ method: 'initialized' }); write({ id: 1, method, params }); return; }
      if (message.id === 1) return message.result ?? null;
    },
  });
}

/** Claude's custom commands and skills for a folder, from its initialize handshake run there. Built-ins are left out. */
export async function claudeCommands({ command, cwd, env, signal, timeoutMs }) {
  const response = await converse({
    command, cwd, env, signal, timeoutMs,
    args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config'],
    start: write => write({ type: 'control_request', request_id: 'pocketbridge-commands', request: { subtype: 'initialize' } }),
    onMessage: message => message.type === 'control_response' && message.response?.request_id === 'pocketbridge-commands' ? (message.response.response ?? null) : undefined,
  });
  if (!Array.isArray(response?.commands)) return null;
  // A user and a project command can share a name; list it once.
  const seen = new Set();
  return response.commands.filter(item => item && typeof item.name === 'string' && /^[\w:.-]{1,80}$/.test(item.name) && !item.builtin && !seen.has(item.name) && seen.add(item.name))
    .map(item => ({ name: item.name, description: clean(String(item.description ?? '').replace(/\s*\((user|project|plugin|dynamic workflow)\)\s*$/, ''), 160), hint: clean(item.argumentHint, 60) }));
}
