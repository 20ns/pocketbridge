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

// Consecutive activity messages become one group of steps; results attach to the tool use they follow.
export function groupMessages(messages) {
  const items = [];
  let group = null;
  for (const message of messages) {
    if (message.role !== 'activity') { group = null; items.push({type:'message', message}); continue; }
    if (!group) { group = {type:'activity', id:message.id, steps:[]}; items.push(group); }
    const activity = parseActivity(message.text);
    const last = group.steps.at(-1);
    if (activity.kind === 'result' && last?.kind === 'tool' && !last.result) last.result = activity;
    else group.steps.push({id:message.id, ...activity, ...(activity.kind === 'tool' ? {summary:summariseInput(activity.input)} : {})});
  }
  return items;
}

export function activitySummary(steps) {
  const names = [...new Set(steps.filter(step => step.kind === 'tool').map(step => step.name))];
  const failed = steps.filter(step => step.kind === 'result' ? step.failed : step.result?.failed).length;
  const shown = names.length > 4 ? [...names.slice(0, 4), `+${names.length - 4} more`] : names;
  const count = `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`;
  return {text:[count, shown.join(', ')].filter(Boolean).join(' · '), failed};
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
      const pre = doc.createElement('pre'); pre.append(make('code', code.join('\n')));
      block.append(head, pre); fragment.append(block);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush(); fragment.append(doc.createElement('hr'));
    } else if (/^#{1,6} /.test(line)) {
      flush(); const heading = /^(#{1,6}) (.*)$/.exec(line);
      const node = doc.createElement(`h${Math.min(heading[1].length + 1, 4)}`); inline(node, heading[2]); fragment.append(node);
    } else if (line.includes('|') && tableRule.test(lines[i + 1] ?? '')) {
      flush();
      const wrap = make('div', undefined, 'table-wrap'), table = doc.createElement('table');
      const head = doc.createElement('thead'), body = doc.createElement('tbody'), headRow = doc.createElement('tr');
      for (const cell of cells(line)) { const th = doc.createElement('th'); inline(th, cell); headRow.append(th); }
      head.append(headRow); i++;
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) {
        const row = doc.createElement('tr');
        for (const cell of cells(lines[++i])) { const td = doc.createElement('td'); inline(td, cell); row.append(td); }
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

// A delivery id is fixed once a send is attempted. Later option changes retry that same payload.
export function editDraft(previous, text, mode) {
  if (previous?.attempted && previous.text === text) return previous;
  if (previous?.attempted) return {text, id: crypto.randomUUID(), mode, model: previous.model || 'default', effort: previous.effort || 'default', attempted: false};
  return {text, id: previous?.id ?? crypto.randomUUID(), mode, model: previous?.model || 'default', effort: previous?.effort || 'default', attempted: false};
}

export function blankLocalDraft(draft) {
  return !draft?.attempted && !String(draft?.text ?? '').trim();
}

export function prepareDelivery(draft, text, mode, chat) {
  if (draft?.attempted && draft.text === text) return draft;
  const model = chat?.model || draft?.model || 'default';
  const effort = chat?.effort || draft?.effort || 'default';
  if (draft && !draft.attempted) return {...draft, text, mode: mode ?? draft.mode, model, effort, attempted: true};
  return {text, id: crypto.randomUUID(), mode, model, effort, attempted: true};
}

export function promptPayload(draft, projectId) {
  const body = {id: draft.id, text: String(draft.text ?? '').trim(), mode: draft.mode, model: draft.model || 'default', effort: draft.effort || 'default'};
  if (projectId) body.projectId = projectId;
  return body;
}
