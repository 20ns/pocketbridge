// Agent CLIs PocketBridge can run: the official Claude Code CLI and the official Codex CLI.
// Both keep their own login. Model catalogs come from each CLI's local handshake, never an API call.
import { spawn, execFile } from 'node:child_process';
import { readFileSync, accessSync, statSync, realpathSync, constants } from 'node:fs';
import { join, delimiter, isAbsolute } from 'node:path';
import { clean } from './util.mjs';

export const agentIds = ['claude', 'codex'];
export const agentNames = { claude: 'Claude', codex: 'Codex' };
// Permission modes are PocketBridge's own protocol values; neither CLI lists them.
export const agentModes = {
  claude: ['bypassPermissions', 'auto', 'plan', 'acceptEdits', 'default'],
  codex: ['bypassPermissions', 'auto', 'readOnly'],
};
// Only used before a CLI's catalog has ever been read; afterwards each model's own list applies.
const knownEfforts = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] };
// Model names are passed as their own argv entry; a leading dash could still read as a flag.
const safeModel = /^[A-Za-z0-9][\w.:-]{0,99}(\[1m\])?$/;
const safeSpeed = /^[A-Za-z0-9][\w.-]{0,39}$/;
const clientInfo = { name: 'pocketbridge', title: 'PocketBridge', version: '1' };
/** Claude's structured-input mode for short handshakes that never start a turn. */
export const claudeProbeArgs = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config'];

/** Variables that would move either CLI off its own subscription login. */
export function agentEnv(agent, base = process.env) {
  const env = { ...base };
  const remove = agent === 'codex'
    ? ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID']
    : ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_RESUME_INTERRUPTED_TURN', 'CLAUDE_CODE_SKIP_PROMPT_HISTORY', 'CLAUDE_CODE_SIMPLE'];
  for (const key of remove) delete env[key];
  return env;
}

// Newest installed CLI. The configured path comes first, so it wins a tie.
const executable = path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } };
/** A command name resolved through PATH, as a shell would, or null. */
export const onPath = (name, path = process.env.PATH ?? '') => path.split(delimiter).filter(Boolean).map(dir => join(dir, name)).find(executable) ?? null;
/** Where else each CLI is commonly installed: PATH, and for Codex the copy bundled with the ChatGPT or Codex app. */
export const extraCliPaths = agent => agent === 'codex'
  ? [onPath('codex'), '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex']
  : [onPath('claude')];
const versionOf = output => /\d+(?:\.\d+)+/.exec(output)?.[0] ?? null;
export const compareVersions = (a, b) => {
  const left = (a ?? '').split('.').map(Number), right = (b ?? '').split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) { const diff = (left[index] || 0) - (right[index] || 0); if (diff) return diff; }
  return 0;
};
const askVersion = (command, timeoutMs) => new Promise(resolveVersion => execFile(command, ['--version'], { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) => resolveVersion(error ? null : { version: versionOf(stdout) })));
/**
 * Picks the newest working CLI among candidate paths by asking each for `--version`. Duplicates (the same file
 * through a symlink) are asked once. Resolves {path, version} or null when none runs.
 */
export async function newestCli(candidates, timeoutMs = 5000) {
  const seen = new Set(), unique = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate) continue;
    const absolute = isAbsolute(candidate) ? candidate : onPath(candidate) ?? candidate;
    let key = absolute; try { key = realpathSync(absolute); } catch { if (isAbsolute(candidate)) continue; }
    if (!seen.has(key)) { seen.add(key); unique.push(absolute); }
  }
  const answers = await Promise.all(unique.map(path => askVersion(path, timeoutMs)));
  let best = null;
  answers.forEach((answer, index) => {
    if (answer && (!best || compareVersions(answer.version, best.version) > 0)) best = { path: unique[index], version: answer.version };
  });
  return best;
}

/** Runs a short JSON-lines conversation with a CLI and stops its whole process group afterwards. */
export function converse({ command, args, cwd, env, signal, timeoutMs = 20_000, start, onMessage }) {
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

/** One app-server request after the initialize handshake. Resolves {result} or {error}; null when Codex didn't answer. */
export function codexCall({ command, cwd, env, signal, timeoutMs, method, params }) {
  return converse({
    command, cwd, env, signal, timeoutMs, args: ['app-server'],
    start: write => write({ id: 0, method: 'initialize', params: { clientInfo } }),
    onMessage: (message, write) => {
      if (message.id === 0) { if (message.error) return null; write({ method: 'initialized' }); write({ id: 1, method, params }); return; }
      if (message.id === 1) return message.error ? { error: message.error } : { result: message.result ?? null };
    },
  });
}
/** A short app-server conversation for listings: Codex skills, threads in a folder, or a thread's last turn. */
export async function codexRequest(request) {
  return (await codexCall(request))?.result ?? null;
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
    // The handshake lists levels but no default; Claude's own default is high where offered.
    const defaultEffort = efforts.includes(preferred) ? preferred : efforts.includes('high') ? 'high' : efforts.at(-1) ?? 'default';
    return { id: model.value, name: clean(model.displayName, 60) || model.value, description: clean(model.description), resolved: typeof model.resolvedModel === 'string' ? model.resolvedModel : model.value, efforts, defaultEffort, speeds: [] };
  });
  if (!list.length) return null;
  const defaultModel = list.find(model => fallback && model.resolved === fallback.resolvedModel) ?? list[0];
  return { models: list, defaultModel: defaultModel.id, defaultEffort: defaultModel.defaultEffort };
}

export async function claudeCatalog({ command, cwd, env, signal, settingsPath, timeoutMs }) {
  const request = 'pocketbridge-models';
  const response = await converse({
    command, cwd, env, signal, timeoutMs, args: claudeProbeArgs,
    start: write => write({ type: 'control_request', request_id: request, request: { subtype: 'initialize' } }),
    onMessage: message => message.type === 'control_response' && message.response?.request_id === request ? (message.response.response ?? null) : undefined,
  });
  return normalizeClaude(response?.models, preferredClaudeEffort(settingsPath));
}

/** Codex's visible model list, with each model's speed tiers, plus the model and reasoning effort chosen in its own config. */
export function normalizeCodex(models, config = {}) {
  if (!Array.isArray(models)) return null;
  const list = models.filter(model => model && !model.hidden && typeof (model.id ?? model.model) === 'string' && safeModel.test(model.id ?? model.model)).map(model => {
    const efforts = (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []).map(option => typeof option === 'string' ? option : option?.reasoningEffort).filter(effort => typeof effort === 'string' && /^[a-z]{2,12}$/.test(effort));
    const defaultEffort = efforts.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort : efforts.includes('medium') ? 'medium' : efforts[0] ?? 'default';
    const speeds = (Array.isArray(model.serviceTiers) ? model.serviceTiers : []).filter(tier => tier && typeof tier.id === 'string' && safeSpeed.test(tier.id))
      .map(tier => ({ id: tier.id, name: clean(tier.name, 30) || tier.id, description: clean(tier.description) }));
    return { id: model.id ?? model.model, name: clean(model.displayName, 60) || model.id, description: clean(model.description), resolved: model.model ?? model.id, efforts, defaultEffort, speeds, isDefault: model.isDefault === true };
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
    start: write => write({ id: 0, method: 'initialize', params: { clientInfo } }),
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

/** The catalog entry a chat's model refers to; "default" means the catalog's default model. */
export const modelEntry = (catalog, model) => catalog?.models.find(item => item.id === model || item.resolved === model) ?? (model === 'default' ? catalog?.models.find(item => item.id === catalog.defaultModel) : undefined);
/** Options for one validated value: a catalog entry when the CLI listed it, otherwise a safe pass-through. */
export function checkModel(agent, value, catalog) {
  if (typeof value !== 'string') return false;
  // Claude's CLI resolves these aliases itself; clients before 0.5 only know them.
  if (value === 'default' || (agent === 'claude' && ['opus', 'sonnet', 'haiku', 'fable'].includes(value))) return true;
  if (catalog) return catalog.models.some(model => model.id === value || model.resolved === value);
  return safeModel.test(value);
}
export function checkEffort(agent, model, effort, catalog) {
  if (effort === 'default') return true;
  const entry = modelEntry(catalog, model);
  return entry ? entry.efforts.includes(effort) : knownEfforts[agent].includes(effort);
}
/** A speed tier id the model offers. Null (standard) always fits. Without a catalog, a safe id is let through. */
export function checkSpeed(agent, model, speed, catalog) {
  if (speed === null) return true;
  if (typeof speed !== 'string' || agent !== 'codex') return false;
  const entry = modelEntry(catalog, model);
  return entry ? (entry.speeds ?? []).some(item => item.id === speed) : !catalog && safeSpeed.test(speed);
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

/** One user message for Claude's stream-json input: text then any images, base64 from the upload files. */
export function claudeUserMessage(id, text, images = []) {
  return { type: 'user', uuid: id, parent_tool_use_id: null, session_id: '', message: { role: 'user', content: [{ type: 'text', text }, ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.type, data: readFileSync(image.path).toString('base64') } }))] } };
}

/** Claude's custom commands and skills for a folder, from its initialize handshake run there. Built-ins are left out. */
export async function claudeCommands({ command, cwd, env, signal, timeoutMs }) {
  const response = await converse({
    command, cwd, env, signal, timeoutMs, args: claudeProbeArgs,
    start: write => write({ type: 'control_request', request_id: 'pocketbridge-commands', request: { subtype: 'initialize' } }),
    onMessage: message => message.type === 'control_response' && message.response?.request_id === 'pocketbridge-commands' ? (message.response.response ?? null) : undefined,
  });
  if (!Array.isArray(response?.commands)) return null;
  // A user and a project command can share a name; list it once.
  const seen = new Set();
  return response.commands.filter(item => item && typeof item.name === 'string' && /^[\w:.-]{1,80}$/.test(item.name) && !item.builtin && !seen.has(item.name) && seen.add(item.name))
    .map(item => ({ name: item.name, description: clean(String(item.description ?? '').replace(/\s*\((user|project|plugin|dynamic workflow)\)\s*$/, ''), 160), hint: clean(item.argumentHint, 60) }));
}
