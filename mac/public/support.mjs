// SSE frames can cross fetch chunk boundaries; comments are keep-alives.
export class EventDecoder {
  buffer = '';
  push(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 1024 * 1024) throw new Error('Event stream frame is too large');
    const events = [];
    for (;;) {
      const separator = /\r?\n\r?\n/.exec(this.buffer);
      if (!separator) return events;
      const frame = this.buffer.slice(0, separator.index);
      this.buffer = this.buffer.slice(separator.index + separator[0].length);
      const event = {data: '', id: '', type: 'message'};
      const data = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'data') data.push(value);
        if (field === 'event') event.type = value;
        if (field === 'id' && !value.includes('\0')) event.id = value;
      }
      if (data.length) events.push({...event, data: data.join('\n')});
    }
  }
}

export function safeLink(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

// Shared with Android: protocol status values become plain-language labels.
export const statusLabels = {idle:'Ready', running:'Working', waiting:'Needs your answer', stopping:'Stopping', interrupted:'Interrupted', error:'Failed'};
export const statusLabel = status => statusLabels[status] ?? 'Ready';

export function relativeTime(time, now = Date.now(), locale = undefined) {
  const minutes = Math.round((now - time) / 60000);
  if (minutes < 1) return 'Just now';
  const words = new Intl.RelativeTimeFormat(locale, {numeric:'auto'});
  if (minutes < 60) return words.format(-minutes, 'minute');
  const day = value => { const date = new Date(value); date.setHours(0, 0, 0, 0); return date.getTime(); };
  const days = Math.round((day(now) - day(time)) / 86400000);
  if (days === 0) return words.format(-Math.floor(minutes / 60), 'hour');
  if (days === 1) { const text = words.format(-1, 'day'); return text[0].toUpperCase() + text.slice(1); }
  const date = new Date(time);
  if (days < 7) return date.toLocaleDateString(locale, {weekday:'long'});
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(locale, {month:'short', day:'numeric', ...(sameYear ? {} : {year:'numeric'})});
}

// Activity text from the Mac: "<Tool>\n<JSON input>", "Tool result\n…", "Tool failed\n…" or a plain system note.
export function parseActivity(text) {
  const value = String(text ?? '');
  const newline = value.indexOf('\n');
  const head = newline < 0 ? value : value.slice(0, newline);
  const body = newline < 0 ? '' : value.slice(newline + 1);
  if (head === 'Tool result' || head === 'Tool failed') return {kind:'result', failed:head === 'Tool failed', text:body};
  if (/^[A-Za-z][\w.:-]{0,80}$/.test(head) && body.trimStart().startsWith('{')) {
    try { const input = JSON.parse(body); if (input && typeof input === 'object') return {kind:'tool', name:head, input, text:body}; } catch { /* Not a tool input; show it as a note. */ }
  }
  return {kind:'note', text:value};
}

const clip = (value, max = 90) => { const line = String(value).replace(/\s+/g, ' ').trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };

export function summariseInput(input = {}) {
  const text = key => typeof input?.[key] === 'string' && input[key].trim() ? input[key] : null;
  const path = text('file_path') ?? text('notebook_path');
  if (text('description')) return {text:clip(text('description'))};
  if (text('command')) return {text:clip(text('command')), title:input.command};
  if (path) return {text:clip(path.split('/').filter(Boolean).pop() ?? path), title:path};
  for (const key of ['pattern', 'url', 'query', 'prompt']) if (text(key)) return {text:clip(text(key)), title:input[key]};
  return {text:''};
}

// Consecutive activity messages become one group of steps. The Mac gives a result the id "<tool message id>:result";
// older transcripts pair each result with the oldest tool call still waiting, the order parallel calls return in.
export function groupMessages(messages) {
  const items = [];
  let group = null;
  for (const message of messages) {
    if (message.role !== 'activity') { group = null; items.push({type:'message', message}); continue; }
    const activity = parseActivity(message.text);
    const named = typeof message.id === 'string' && message.id.endsWith(':result') ? message.id.slice(0, -7) : null;
    const open = step => step.kind === 'tool' && !step.result && (named === null || step.id === named);
    // A steer or note can land while a command runs; its named result still belongs to that earlier group.
    const waiting = activity.kind === 'result' && (group?.steps.find(open) ?? (named ? items.findLast(item => item.type === 'activity' && item.steps.some(open))?.steps.find(open) : null));
    if (waiting) { waiting.result = {id:message.id, ...activity}; continue; }
    if (!group) { group = {type:'activity', id:message.id, steps:[]}; items.push(group); }
    group.steps.push({id:message.id, ...activity, ...(activity.kind === 'tool' ? {summary:summariseInput(activity.input)} : {})});
  }
  return items;
}

/** The tool call still running at the end of a transcript, for the working line. */
export function liveStep(items) {
  const last = items.at(-1);
  return last?.type === 'activity' ? last.steps.findLast(step => step.kind === 'tool' && !step.result) ?? null : null;
}

export function elapsedLabel(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}m`;
}

export function activitySummary(steps) {
  const names = [...new Set(steps.filter(step => step.kind === 'tool').map(step => step.name))];
  const failed = steps.filter(step => step.kind === 'result' ? step.failed : step.result?.failed).length;
  const shown = names.length > 4 ? [...names.slice(0, 4), `+${names.length - 4} more`] : names;
  const count = `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`;
  return {text:[count, shown.join(', ')].filter(Boolean).join(' · '), failed};
}

// Lightweight highlighting for the languages agents write most. Tokens are plain text; the DOM layer adds classes.
const words = list => new Set(list.split(' '));
const keywordSets = {
  kotlin: words('fun val var if else when for while do return class object interface data sealed private public protected internal override suspend import package try catch finally throw is in as by companion const lateinit enum open abstract inline reified typealias init get set this super null true false'),
  js: words('const let var function return if else for while do switch case break continue new class extends implements interface type import export from default async await try catch finally throw typeof instanceof in of as readonly public private protected static yield this super null undefined true false void enum declare keyof'),
  python: words('def class return if elif else for while in not and or is import from as with try except finally raise lambda yield async await pass break continue global nonlocal None True False self'),
  bash: words('if then else elif fi for while do done case esac function in return export local set unset echo cd source exit'),
  swift: words('func let var if else guard for while return class struct enum protocol extension import switch case default try catch throw throws async await self nil true false private public internal static override init'),
  go: words('func package import var const type struct interface map chan go defer return if else for range switch case default break continue nil true false'),
  rust: words('fn let mut pub struct enum impl trait use mod match if else for while loop return self Self crate super where async await move ref true false None Some Ok Err'),
  json: words('true false null'),
};
const languageAliases = {kt:'kotlin', kts:'kotlin', kotlin:'kotlin', java:'kotlin', scala:'kotlin', ts:'js', tsx:'js', typescript:'js', js:'js', jsx:'js', mjs:'js', javascript:'js', json:'json', jsonc:'json', sh:'bash', bash:'bash', zsh:'bash', shell:'bash', console:'bash', py:'python', python:'python', swift:'swift', go:'go', golang:'go', rs:'rust', rust:'rust'};
export function highlight(code, language = '') {
  const lang = languageAliases[String(language).toLowerCase()];
  if (!lang) return [{text: code, kind: ''}];
  const hash = lang === 'bash' || lang === 'python';
  const pattern = new RegExp([
    hash ? '(#[^\n]*)' : '(\\/\\/[^\n]*|\\/\\*[\\s\\S]*?\\*\\/)',
    '("(?:[^"\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)',
    '(\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b|\\b0x[\\da-fA-F]+\\b)',
    '(@[A-Za-z_]\\w*|\\$\\{?[A-Za-z_]\\w*\\}?)',
    '([A-Za-z_]\\w*)',
  ].join('|'), 'g');
  const tokens = [];
  let offset = 0;
  const push = (text, kind) => { if (!text) return; const last = tokens.at(-1); if (last && last.kind === kind) last.text += text; else tokens.push({text, kind}); };
  for (const match of code.matchAll(pattern)) {
    push(code.slice(offset, match.index), '');
    const [token, comment, string, number, annotation, word] = match;
    const kind = comment ? 'comment' : string ? (lang === 'json' && /^\s*:/.test(code.slice(match.index + token.length)) ? 'property' : 'string')
      : number ? 'number' : annotation ? (lang === 'bash' ? 'variable' : 'annotation')
      : keywordSets[lang].has(word) ? 'keyword' : /^[A-Z][A-Za-z0-9]*[a-z]/.test(word) && lang !== 'bash' ? 'type' : '';
    push(token, kind); offset = match.index + token.length;
  }
  push(code.slice(offset), '');
  return tokens;
}

/** Diff lines keep their text; additions, removals and hunk headers get a kind for line backgrounds. */
export function diffLines(code) {
  return code.split('\n').map(line => ({text: line, kind: line.startsWith('+++') || line.startsWith('---') ? 'meta' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}));
}

export function markdown(text, doc = document) {
  // Safe Markdown subset: every value goes through textContent and only http(s) links become anchors.
  const fragment = doc.createDocumentFragment();
  const make = (tag, value, className) => { const node = doc.createElement(tag); if (value !== undefined) node.textContent = value; if (className) node.className = className; return node; };
  const inline = (node, value) => {
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
    let offset = 0;
    for (const match of value.matchAll(pattern)) {
      node.append(doc.createTextNode(value.slice(offset, match.index)));
      const token = match[0];
      if (token.startsWith('`')) node.append(make('code', token.slice(1, -1)));
      else if (token.startsWith('**')) node.append(make('strong', token.slice(2, -2)));
      else if (token.startsWith('*')) node.append(make('em', token.slice(1, -1)));
      else {
        const link = /^\[(.*?)\]\((.*?)\)$/.exec(token);
        const href = safeLink(link[2]);
        const anchor = make(href ? 'a' : 'span', link[1]);
        if (href) { anchor.href = href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
        node.append(anchor);
      }
      offset = match.index + token.length;
    }
    node.append(doc.createTextNode(value.slice(offset)));
  };
  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
  const tableRule = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  const lines = String(text).split('\n');
  let paragraph = [], lists = [], quote = null;
  const flush = () => {
    if (paragraph.length) { const p = doc.createElement('p'); inline(p, paragraph.join('\n')); fragment.append(p); paragraph = []; }
    lists = []; quote = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      flush(); const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      const block = make('div', undefined, 'code-block');
      const head = make('div', undefined, 'code-head');
      const copy = make('button', 'Copy', 'copy-code'); copy.type = 'button';
      head.append(make('span', fence[1] || 'Code'), copy);
      const pre = doc.createElement('pre'), source = code.join('\n'), codeNode = make('code');
      const language = fence[1].toLowerCase();
      if (language === 'diff' || language === 'patch') for (const line of diffLines(source)) { codeNode.append(make('span', line.text + '\n', `diff-line${line.kind ? ` diff-${line.kind}` : ''}`)); }
      else { const tokens = highlight(source, language); if (tokens.some(token => token.kind)) for (const token of tokens) codeNode.append(token.kind ? make('span', token.text, `tok-${token.kind}`) : doc.createTextNode(token.text)); else codeNode.textContent = source; }
      pre.append(codeNode); block.append(head, pre); fragment.append(block);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush(); fragment.append(doc.createElement('hr'));
    } else if (/^#{1,6} /.test(line)) {
      flush(); const heading = /^(#{1,6}) (.*)$/.exec(line);
      const node = doc.createElement(`h${Math.min(heading[1].length + 1, 4)}`); inline(node, heading[2]); fragment.append(node);
    } else if (line.includes('|') && tableRule.test(lines[i + 1] ?? '')) {
      flush();
      const wrap = make('div', undefined, 'table-wrap'), table = doc.createElement('table');
      const head = doc.createElement('thead'), body = doc.createElement('tbody'), headRow = doc.createElement('tr');
      // ":---:" centres a column and "---:" right-aligns it, which keeps numbers lined up.
      const align = cells(lines[i + 1]).map(rule => rule.endsWith(':') ? (rule.startsWith(':') ? 'align-center' : 'align-right') : '');
      cells(line).forEach((cell, column) => { const th = doc.createElement('th'); if (align[column]) th.className = align[column]; inline(th, cell); headRow.append(th); });
      head.append(headRow); i++;
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) {
        const row = doc.createElement('tr');
        cells(lines[++i]).forEach((cell, column) => { const td = doc.createElement('td'); if (align[column]) td.className = align[column]; inline(td, cell); row.append(td); });
        body.append(row);
      }
      table.append(head, body); wrap.append(table); fragment.append(wrap);
    } else if (/^\s*([-*+] |\d+\. )/.test(line)) {
      if (paragraph.length || quote) flush();
      const item = /^(\s*)([-*+]|\d+\.) (.*)$/.exec(line);
      const indent = item[1].replace(/\t/g, '    ').length;
      const tag = /^\d/.test(item[2]) ? 'ol' : 'ul';
      while (lists.length && indent < lists.at(-1).indent) lists.pop();
      let level = lists.at(-1);
      if (!level || (indent >= level.indent + 2 && level.item)) {
        const parent = level?.item ?? fragment;
        level = {indent, tag, parent, node:doc.createElement(tag), item:null}; parent.append(level.node); lists.push(level);
      } else if (level.tag !== tag) {
        level.tag = tag; level.node = doc.createElement(tag); level.parent.append(level.node);
      }
      const li = doc.createElement('li'); inline(li, item[3]); level.node.append(li); level.item = li;
    } else if (/^> ?/.test(line)) {
      if (!quote) { flush(); quote = doc.createElement('blockquote'); fragment.append(quote); } else quote.append(doc.createElement('br'));
      inline(quote, line.replace(/^> ?/, ''));
    } else if (!line.trim()) flush();
    else { lists = []; quote = null; paragraph.push(line); }
  }
  flush();
  return fragment;
}

// Agent catalogs come from the Mac. A Mac before 0.5 lists only Claude's aliases.
export function agentsFrom(capabilities = {}) {
  if (Array.isArray(capabilities.agents) && capabilities.agents.length) return capabilities.agents;
  const efforts = (capabilities.efforts ?? []).filter(effort => effort !== 'default');
  const models = (capabilities.models ?? []).filter(model => model !== 'default').map(id => {
    const supported = id === 'haiku' ? [] : efforts;
    return {id, name: id[0].toUpperCase() + id.slice(1), description: '', efforts: supported, defaultEffort: supported.includes('high') ? 'high' : supported.at(-1) ?? 'default'};
  });
  return [{id:'claude', name:'Claude', available:true, modes:capabilities.modes ?? ['bypassPermissions'], models, defaultModel:models[0]?.id ?? 'default', defaultEffort:'default'}];
}
export const findModel = (agent, id) => agent?.models.find(model => model.id === id) ?? (id === 'default' ? agent?.models.find(model => model.id === agent.defaultModel) : undefined);

/** Concrete options: the wanted choice where the agent still offers it, otherwise its defaults. Same rules as Android. */
export function resolveOptions(agent, wanted = {}) {
  const model = wanted.model && wanted.model !== 'default' && (!agent.models.length || agent.models.some(item => item.id === wanted.model)) ? wanted.model : agent.defaultModel;
  const info = findModel(agent, model);
  const effort = !info ? wanted.effort ?? agent.defaultEffort
    : !info.efforts.length ? 'default'
    : info.efforts.includes(wanted.effort) ? wanted.effort
    : model === agent.defaultModel && info.efforts.includes(agent.defaultEffort) ? agent.defaultEffort
    : info.defaultEffort;
  return {agent: agent.id, mode: equivalentMode(wanted.mode, agent.modes), model, effort, speed: offeredSpeed(info, wanted.speed)};
}

/** A speed tier (Codex "Fast") the model offers, else null for standard. Without a catalog entry the choice stands. */
function offeredSpeed(info, speed) {
  if (!info) return speed ?? null;
  return (info.speeds ?? []).some(item => item.id === speed) ? speed : null;
}
export const modelSpeeds = (agent, model) => findModel(agent, model)?.speeds ?? [];
/** The catalog's name for a speed; "Fast" only as a fallback for a nameless priority tier. */
export const speedName = speed => speed?.name || (speed?.id === 'priority' ? 'Fast' : speed?.id ?? '');

// Moving a chat between agents never widens what it may do: Plan and Read only map to each other, Accept edits to
// Auto, Manual to Read only, and anything else unknown to the most restrictive mode on offer.
const sameIntent = {plan: 'readOnly', readOnly: 'plan', acceptEdits: 'auto', default: 'readOnly'};
const strictest = ['readOnly', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'];
export function equivalentMode(mode, modes) {
  if (!modes.length) return mode ?? 'bypassPermissions';
  if (modes.includes(mode)) return mode;
  if (mode === undefined) return modes.includes('bypassPermissions') ? 'bypassPermissions' : modes[0];
  if (modes.includes(sameIntent[mode])) return sameIntent[mode];
  return strictest.find(item => modes.includes(item)) ?? modes[0];
}

/** Saved options with an effort the model doesn't list (chats from older clients) send the model's own default. */
export function supportedOptions(agent, options) {
  const info = findModel(agent, options.model);
  const speed = offeredSpeed(info, options.speed);
  if (!info || options.effort === 'default' || info.efforts.includes(options.effort)) return speed === (options.speed ?? null) ? options : {...options, speed};
  return {...options, effort: info.efforts.length ? info.defaultEffort : 'default', speed};
}

export const modeLabels = {bypassPermissions:'Bypass permissions', auto:'Auto', acceptEdits:'Accept edits', plan:'Plan', default:'Manual', readOnly:'Read only'};
export const effortLabels = {default:'Auto', minimal:'Minimal', low:'Low', medium:'Medium', high:'High', xhigh:'Extra high', max:'Max', ultra:'Ultra'};
/** Display names for effort ids; an id the labels don't know yet is shown capitalised. */
export const effortLabel = effort => effortLabels[effort] ?? (effort ? effort[0].toUpperCase() + effort.slice(1) : '');
export function modeHelp(agent, mode) {
  return {
    bypassPermissions: agent === 'codex' ? 'No sandbox and no prompts.' : 'Runs commands and edits files without asking.',
    auto: agent === 'codex' ? 'Edits inside the project folder; nothing outside it.' : 'Works alone while a safety check blocks risky actions.',
    acceptEdits: 'Edits files freely, asks before commands.',
    plan: 'Explores and proposes a plan before changing anything.',
    readOnly: 'Reads and answers. Changes nothing.',
    default: 'Asks before every edit and command.',
  }[mode] ?? '';
}
/** "Default" is never shown: an unlisted default is the catalog's first model, else the agent itself. */
export const modelName = (agent, id) => findModel(agent, id)?.name ?? (id === 'default' ? agent?.models?.[0]?.name ?? agent?.name ?? 'Claude' : id);
export function effortName(agent, model, effort) {
  if (effort !== 'default') return effortLabel(effort);
  const info = findModel(agent, model);
  if (!info?.efforts.length) return 'Auto';
  if (info.efforts.includes(agent.defaultEffort)) return effortLabel(agent.defaultEffort);
  return effortLabels[info.defaultEffort] ?? 'Auto';
}

/** Installed and switched on. Catalogs from a Mac before the switch existed count as on. */
export const usableAgent = agent => Boolean(agent?.available) && agent.enabled !== false;
/** A new chat starts with the last agent used while it's on, else the first one on; null when none is. */
export function newChatAgent(agents, last) {
  if (!agents.length) return 'claude';
  return agents.find(agent => agent.id === last && usableAgent(agent))?.id ?? agents.find(usableAgent)?.id ?? null;
}

// A delivery id is fixed once a send is attempted; that attempt keeps its options. Editing the text starts a new delivery.
export function editDraft(previous, text) {
  if (previous?.attempted && previous.text === text) return previous;
  if (previous?.attempted) return {text, id: crypto.randomUUID(), attempted: false, attachments: previous.attachments ?? [], ...(previous.projectId ? {projectId: previous.projectId} : {})};
  return {...previous, text, id: previous?.id ?? crypto.randomUUID(), attempted: false};
}

/** The same draft with a new set of images; an attempted delivery keeps its own and starts a new one instead. */
export function withAttachments(previous, attachments) {
  if (previous?.attempted) return {text: previous.text, id: crypto.randomUUID(), attempted: false, attachments, ...(previous.projectId ? {projectId: previous.projectId} : {})};
  return {text: '', ...previous, id: previous?.id ?? crypto.randomUUID(), attempted: false, attachments};
}

/** The draft left after a delivery is accepted: none if it was the one sent, else without the images that went with it. */
export function afterDelivery(current, sent) {
  if (!current || current.id === sent.id) return null;
  const sentIds = new Set((sent.attachments ?? []).map(item => item.id));
  return {...current, attachments: (current.attachments ?? []).filter(item => !item.id || !sentIds.has(item.id))};
}

export function blankLocalDraft(draft) {
  return !draft?.attempted && !String(draft?.text ?? '').trim() && !draft?.attachments?.length;
}

// A retry keeps its id only for the same text and delivery: the Mac rejects a recorded id sent with other content.
// The options, speed included, are fixed with the id, so a retry repeats exactly what was first sent.
export function prepareDelivery(draft, text, options = {}, delivery = null) {
  if (draft?.attempted && draft.text === text && (draft.delivery ?? null) === delivery) return draft;
  const id = draft && !draft.attempted ? draft.id : crypto.randomUUID();
  const attachments = (draft?.attachments ?? []).filter(item => item.id).map(({id: uploadId, type}) => ({id: uploadId, type}));
  return {...(draft?.projectId ? {projectId: draft.projectId} : {}), text, id, agent: options.agent ?? 'claude', mode: options.mode ?? 'bypassPermissions', model: options.model || 'default', effort: options.effort || 'default', speed: options.speed ?? null, attachments, ...(delivery ? {delivery} : {}), attempted: true};
}

export function promptPayload(draft, projectId) {
  const body = {id: draft.id, text: String(draft.text ?? '').trim(), agent: draft.agent ?? 'claude', mode: draft.mode, model: draft.model || 'default', effort: draft.effort || 'default'};
  // Drafts attempted before speeds existed omit it, which keeps the chat's own value.
  if (draft.speed !== undefined) body.speed = draft.speed;
  if (draft.attachments?.length) body.attachments = draft.attachments.map(item => item.id);
  if (draft.delivery) body.delivery = draft.delivery;
  if (projectId) body.projectId = projectId;
  return body;
}

/** "/" commands that start with what's typed after the slash; name matches come before description matches. */
export function slashMatches(commands, text) {
  const typed = /^\/([^\s]*)$/.exec(text)?.[1];
  if (typed === undefined) return [];
  const query = typed.toLowerCase();
  const starts = commands.filter(command => command.name.toLowerCase().startsWith(query));
  const contains = commands.filter(command => !starts.includes(command) && (command.name.toLowerCase().includes(query) || command.description?.toLowerCase().includes(query)));
  return [...starts, ...contains].slice(0, 12);
}

/**
 * Where turn timing and sub-agents go in a transcript: for each message index that closes a finished turn, its
 * duration; and for each turn, its sub-agents. A turn runs from its prompt to the next prompt that starts a turn.
 */
export function turnPlacement(messages, turns = [], subagents = []) {
  const starts = new Map(turns.map(turn => [turn.id, turn]));
  const ends = new Map(), agents = new Map();
  let current = null, lastIndex = -1;
  const close = () => { if (current) ends.set(lastIndex, current); };
  messages.forEach((message, index) => {
    if (message.role === 'user' && starts.has(message.id)) { close(); current = starts.get(message.id); }
    lastIndex = index;
  });
  close();
  for (const agent of subagents) { const list = agents.get(agent.promptId) ?? []; list.push(agent); agents.set(agent.promptId, list); }
  return {ends, agents};
}

/** "in 2h 24m" within a day, otherwise the weekday and time, or the date beyond a week. */
export function resetLabel(resetsAt, now = Date.now(), locale = undefined) {
  if (!resetsAt) return '';
  const minutes = Math.max(0, Math.round((resetsAt - now) / 60000));
  if (minutes < 60) return `Resets in ${minutes}m`;
  if (minutes < 24 * 60) return `Resets in ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
  const date = new Date(resetsAt);
  const day = minutes < 7 * 24 * 60 ? date.toLocaleDateString(locale, {weekday:'short'}) : date.toLocaleDateString(locale, {month:'short', day:'numeric'});
  return `Resets ${day} ${date.toLocaleTimeString(locale, {hour:'numeric', minute:'2-digit'})}`;
}

/** Weekly windows from the Mac's window field; an older Mac only names them. */
export const weeklyLimit = limit => limit.window ? limit.window === 'weekly' : /week/i.test(`${limit.id} ${limit.label}`);
/** The limit a header ring shows for an agent: its fullest weekly window, else its fullest limit. */
export function headlineLimit(limits = []) {
  const weekly = limits.filter(weeklyLimit);
  return [...(weekly.length ? weekly : limits)].sort((a, b) => b.percent - a.percent)[0] ?? null;
}
/** One ring per agent that reports limits; an agent that is off reports none. */
export const usageRings = agentsUsage => agentsUsage.filter(agent => agent.limits?.length).map(agent => ({id: agent.id, name: agent.name, limit: headlineLimit(agent.limits)}));

/** Codex reset credits: the one expiring soonest is used first. */
export function nextCredit(resets) {
  const credits = [...(resets?.credits ?? [])];
  return credits.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))[0] ?? null;
}
/** One idempotency key per attempt: a retry after a lost answer reuses the pending attempt and its key. */
export const resetAttempt = (pending, creditId = null) => pending ?? {id: crypto.randomUUID(), creditId};
/** Only an unknown result (no answer, a timeout or a gateway timeout) keeps the attempt for a retry with the same key.
 * Any other answer, including Codex refusing with a 502, is definite: the attempt ends and the next one gets a new key. */
export const settleReset = (pending, error) => error && (error.status === undefined || error.status === 408 || error.status === 504) ? pending : null;
export const resetPrompt = available => `Use 1 of ${available} ${available === 1 ? 'reset' : 'resets'}? Resets your Codex limits now.`;
export const resetOutcomes = {reset: 'Codex limits reset.', nothingToReset: 'Nothing to reset. No reset was used.', noCredit: 'No resets left.', alreadyRedeemed: 'That reset was already used.'};

/** A stable palette slot for an id (FNV-1a), so a project keeps its colour everywhere. */
export function hashIndex(text, size) {
  let hash = 0x811c9dc5;
  for (const char of String(text)) hash = Math.imul((hash ^ char.codePointAt(0)) >>> 0, 0x01000193) >>> 0;
  return hash % size;
}
export const projectTones = 8;
export const projectTone = id => hashIndex(id, projectTones);
export const avatarLetter = name => (/[\p{L}\p{N}]/u.exec(name ?? '')?.[0] ?? '?').toUpperCase();
