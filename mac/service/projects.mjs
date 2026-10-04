// Project folders: discovery from Claude and Codex session metadata, sessions to continue, "/" commands,
// git status and the project's own icon.
import { statSync, realpathSync, existsSync, readFileSync, readdirSync, openSync, readSync, closeSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, basename, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { codexRequest, claudeCommands } from './agents.mjs';
import { codexSessionFolders, claudeSessions } from './history.mjs';
import { gitStatus } from './git.mjs';
import { findIcons, renderIcon, iconTypes } from './icons.mjs';
import { fail, oneLine } from './util.mjs';

const ignoredCwd = value => String(value).includes(`${sep}Library${sep}Application Support${sep}Claude${sep}scratch-workspaces${sep}`);
const stamp = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value.trim()) { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed; }
};
const entryTime = (entry, fallback) => {
  for (const key of ['modified', 'updatedAt', 'fileMtime', 'mtime', 'created', 'createdAt']) {
    const value = stamp(entry[key]); if (value !== undefined) return value;
  }
  return fallback;
};
// ponytail: each Claude project directory maps to one cwd. Read at most sessionBudget newest session files there, and only the first 256KB of each, then stop at the first valid cwd. A main session older than that budget waits for sessions-index.json or a newer file; raise sessionBudget if sidechain files crowd it out. A cwd that starts past 256KB needs a larger read or an index entry.
const sessionBudget = 8;
const readIndex = file => {
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size > 1_000_000) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
    if (!Array.isArray(entries)) return null;
    const records = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.isSidechain === true || entry.isSubagent === true || entry.agentId) continue;
      const cwd = [entry.cwd, entry.projectPath, entry.project].find(value => typeof value === 'string' && value && !value.includes('\0'));
      if (!cwd || ignoredCwd(cwd)) continue;
      records.push({ cwd, mtime: entryTime(entry, info.mtimeMs) });
    }
    return records;
  } catch { return null; }
};
const readCwd = file => {
  let fd;
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size === 0) return;
    fd = openSync(file, 'r');
    const length = Math.min(info.size, 256 * 1024), buf = Buffer.alloc(length), got = readSync(fd, buf, 0, length, 0);
    let body = buf.toString('utf8', 0, got);
    if (got < info.size) { const cut = body.lastIndexOf('\n'); if (cut < 0) return; body = body.slice(0, cut); }
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      let record; try { record = JSON.parse(line); } catch { continue; }
      if (!record || typeof record !== 'object' || Array.isArray(record) || record.isSidechain === true || record.isSubagent === true || record.agentId) continue;
      if (typeof record.cwd !== 'string' || !record.cwd || record.cwd.includes('\0') || ignoredCwd(record.cwd)) continue;
      return record.cwd;
    }
  } catch { /* Missing or malformed metadata is skipped. */ }
  finally { if (fd !== undefined) closeSync(fd); }
};

export function createProjects(ctx) {
  const { options, dataDir, get, all, run, transaction, agents, claudeProjectsDir, codexSessionsDir } = ctx;
  const { enabled, available } = agents;
  let lastDiscovery = 0;
  const sessionMeta = new Map(), codexMeta = new Map();
  const project = id => { const row = get('SELECT * FROM projects WHERE id=?', id); if (!row) throw fail(404, 'Project not found'); return row; };
  const projectRow = row => ({ id: row.id, name: row.name, path: row.path, lastUsedAt: Number(row.lastUsedAt || 0), icon: row.general ? null : row.icon ?? null, ...(row.general ? { general: true } : {}) });
  const list = () => all('SELECT id,name,path,lastUsedAt,icon,general FROM projects ORDER BY name').map(projectRow);
  /** The General project: one per Mac, at [path]. A folder already listed there (say, the home folder) becomes it. */
  const ensureGeneral = path => transaction(() => {
    const general = get('SELECT id,path FROM projects WHERE general=1'), atPath = get('SELECT id FROM projects WHERE path=?', path);
    if (general && general.path === path) return;
    if (general && !atPath) { run('UPDATE projects SET path=? WHERE id=?', path, general.id); return; }
    if (general) run('UPDATE projects SET general=0 WHERE id=?', general.id);
    if (atPath) run("UPDATE projects SET general=1,name='General' WHERE id=?", atPath.id);
    else run("INSERT INTO projects (id,name,path,lastUsedAt,general) VALUES (?,'General',?,0,1)", randomUUID(), path);
  });

  const discoverProjects = () => {
    let entries = []; try { if (enabled.claude && existsSync(claudeProjectsDir)) entries = readdirSync(claudeProjectsDir, { withFileTypes: true }); } catch { /* unreadable Claude metadata */ }
    const found = new Map();
    const consider = (cwd, mtime) => {
      if (typeof cwd !== 'string' || ignoredCwd(cwd)) return;
      let path; try { path = realpathSync(cwd); if (!statSync(path).isDirectory()) return; } catch { return; }
      const when = Math.max(0, Math.floor(Number(mtime) || 0)), previous = found.get(path);
      if (previous === undefined || when > previous) found.set(path, when);
    };
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'subagents') continue;
      const dir = join(claudeProjectsDir, entry.name);
      let names; try { names = readdirSync(dir); } catch { continue; }
      if (names.includes('sessions-index.json')) { const indexed = readIndex(join(dir, 'sessions-index.json')); if (indexed) for (const record of indexed) consider(record.cwd, record.mtime); }
      const sessions = [];
      for (const name of names) {
        if (!name.endsWith('.jsonl') || name.includes('subagent')) continue;
        try { const info = statSync(join(dir, name)); if (info.isFile()) sessions.push({ file: join(dir, name), name, mtime: info.mtimeMs, size: info.size }); } catch { /* unreadable session */ }
      }
      if (!sessions.length) continue;
      sessions.sort((a, b) => b.mtime - a.mtime);
      const latest = sessions[0], cached = sessionMeta.get(dir);
      if (cached && cached.name === latest.name && cached.mtimeMs === latest.mtime && cached.size === latest.size) { if (cached.cwd) consider(cached.cwd, latest.mtime); continue; }
      let cwd;
      for (const file of sessions.slice(0, sessionBudget)) { cwd = readCwd(file.file); if (cwd) break; }
      sessionMeta.set(dir, { name: latest.name, mtimeMs: latest.mtime, size: latest.size, cwd });
      if (cwd) consider(cwd, latest.mtime);
    }
    if (codexSessionsDir && enabled.codex) for (const session of codexSessionFolders(codexSessionsDir, codexMeta)) consider(session.cwd, session.mtime);
    const changed = transaction(() => {
      let wrote = false;
      for (const [path, lastUsedAt] of found) {
        const existing = get('SELECT id,lastUsedAt FROM projects WHERE path=?', path);
        if (existing) { if (lastUsedAt > Number(existing.lastUsedAt || 0)) { run('UPDATE projects SET lastUsedAt=? WHERE id=?', lastUsedAt, existing.id); wrote = true; } }
        else { run('INSERT INTO projects (id,name,path,lastUsedAt) VALUES (?,?,?,?)', randomUUID(), basename(path) || path, path, lastUsedAt); wrote = true; }
      }
      return wrote;
    });
    if (changed) ctx.change('state');
  };
  const refreshDiscovery = (force = false) => {
    const now = Date.now();
    if (!force && now - lastDiscovery < (options.discoverIntervalMs ?? 15_000)) return;
    lastDiscovery = now;
    try { discoverProjects(); } catch (error) { console.error(`Project discovery failed: ${error.message}`); }
  };

  // Project icons are found and converted in the background, one project at a time, and checked again every
  // ten minutes. State responses only read the saved tag, so a large folder never delays them.
  const iconsDir = join(dataDir, 'icons'); mkdirSync(iconsDir, { recursive: true, mode: 0o700 });
  const iconFile = (id, type) => join(iconsDir, `${id}.${iconTypes[type]}`);
  let iconScan = null;
  const updateIcon = async row => {
    let chosen = null;
    let candidates = [];
    try { if (statSync(row.path).isDirectory()) candidates = await findIcons(row.path); } catch { /* missing folder: no icon */ }
    for (const candidate of candidates.slice(0, 3)) {
      if (ctx.closed) return;
      const source = `${candidate.rel}:${candidate.size}:${Math.floor(candidate.mtimeMs)}`;
      if (source === row.iconSource && row.icon && existsSync(iconFile(row.id, row.iconType))) { chosen = { same: true }; break; }
      const rendered = await renderIcon(candidate, iconsDir, ctx.probes.signal);
      if (rendered) { chosen = { source, ...rendered }; break; }
    }
    if (ctx.closed) return;
    const now = Date.now();
    if (chosen?.same) { run('UPDATE projects SET iconCheckedAt=? WHERE id=?', now, row.id); return; }
    for (const type of Object.keys(iconTypes)) if (!chosen || type !== chosen.type) rmSync(iconFile(row.id, type), { force: true });
    if (!chosen) {
      run('UPDATE projects SET icon=NULL,iconType=NULL,iconSource=NULL,iconCheckedAt=? WHERE id=?', now, row.id);
      if (row.icon) ctx.change('state');
      return;
    }
    const file = iconFile(row.id, chosen.type), temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, chosen.data, { mode: 0o600 }); renameSync(temporary, file);
    const tag = createHash('sha256').update(chosen.data).digest('hex').slice(0, 12);
    run('UPDATE projects SET icon=?,iconType=?,iconSource=?,iconCheckedAt=? WHERE id=?', tag, chosen.type, chosen.source, now, row.id);
    if (tag !== row.icon) ctx.change('state');
  };
  const refreshIcons = () => {
    if (iconScan || ctx.closed || options.icons === false) return;
    const due = all('SELECT id,path,icon,iconType,iconSource,iconCheckedAt FROM projects WHERE general=0').filter(row => Date.now() - Number(row.iconCheckedAt ?? 0) > (options.iconIntervalMs ?? 600_000));
    if (!due.length) return;
    iconScan = (async () => {
      for (const row of due) {
        if (ctx.closed) return;
        await updateIcon(row).catch(error => { if (!ctx.closed) console.error(`Project icon ${row.path}: ${error.message}`); });
      }
    })().finally(() => { iconScan = null; });
  };
  // Checked on a timer too, so a changed logo is noticed while no client is asking for state.
  const iconTimer = options.icons === false ? null : setInterval(refreshIcons, Math.max(100, options.iconIntervalMs ?? 600_000));
  iconTimer?.unref();
  const iconOf = id => {
    const row = project(id);
    if (!row.icon || !iconTypes[row.iconType] || !existsSync(iconFile(row.id, row.iconType))) throw fail(404, 'No icon for this project');
    return { type: row.iconType, data: readFileSync(iconFile(row.id, row.iconType)) };
  };

  // Per project: Codex skills (kept with their paths so "/name" prompts can pass the skill itself) and "/" command lists.
  const codexSkills = new Map(), commandLists = new Map(), gitCache = new Map();
  /** Enabled Codex skills for a folder, remembered for "/name" prompts. Null when Codex didn't answer. */
  const loadCodexSkills = async folder => {
    const result = await codexRequest({ ...agents.probe('codex'), method: 'skills/list', params: { cwds: [folder.path] } });
    if (!result) return null;
    // The same skill name can exist in several scopes; the first listed wins, as names must be unique to pick one.
    const seen = new Set(), skills = (result.data ?? []).flatMap(item => Array.isArray(item?.skills) ? item.skills : []).filter(skill => skill?.enabled !== false && typeof skill?.name === 'string' && /^[\w:.-]{1,80}$/.test(skill.name) && typeof skill.path === 'string' && !seen.has(skill.name) && seen.add(skill.name));
    codexSkills.set(folder.id, { at: Date.now(), list: skills.map(skill => ({ name: skill.name, path: skill.path })) });
    return skills;
  };
  const freshSkills = folder => { const cached = codexSkills.get(folder.id); return cached && Date.now() - cached.at < 600_000 ? cached.list : null; };
  const knownSkills = folder => codexSkills.get(folder.id)?.list;
  const commands = async (folder, agent) => {
    const key = `${folder.id}:${agent}`;
    if (!available[agent] || !enabled[agent]) return [];
    const cached = commandLists.get(key);
    if (!cached || Date.now() - cached.at > 10 * 60_000) {
      const value = agent === 'claude' ? claudeCommands(agents.probe(agent, folder.path)) : loadCodexSkills(folder).then(skills => skills && skills.map(skill => ({ name: skill.name, description: oneLine(skill.interface?.shortDescription || skill.shortDescription || skill.description, 160), hint: '' })));
      commandLists.set(key, { at: Date.now(), value: value.then(list => { if (!list) commandLists.delete(key); return list ?? []; }) });
    }
    return commandLists.get(key).value;
  };
  /** Recomputed at most every few seconds; a turn ending clears it so the counts follow the agent's edits. */
  const git = async folder => {
    if (folder.general) return null; // a home folder is no repository to count
    const cached = gitCache.get(folder.id);
    if (!cached || Date.now() - cached.at > 4000) gitCache.set(folder.id, { at: Date.now(), value: gitStatus(folder.path) });
    return gitCache.get(folder.id).value;
  };
  const changed = id => gitCache.delete(id);

  /** The last prompt and reply of a Codex thread, read from its newest turn. */
  const codexLastExchange = async threadId => {
    const listed = await codexRequest({ ...agents.probe('codex'), method: 'thread/turns/list', params: { threadId, limit: 1, itemsView: 'full' } }).catch(() => null);
    const items = Array.isArray(listed?.data?.[0]?.items) ? listed.data[0].items : [];
    const textOf = item => (Array.isArray(item.content) ? item.content : []).filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
    const askedAt = items.findLastIndex(item => item?.type === 'userMessage' && textOf(item)), said = askedAt >= 0 ? textOf(items[askedAt]) : null;
    // Only a reply after the last prompt answers it; an unanswered steer brings no older reply along.
    const reply = items.slice(askedAt + 1).filter(item => item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()).at(-1)?.text;
    return said || reply ? { lastPrompt: said ? said.slice(0, 4000) : null, lastReply: reply ? reply.slice(0, 8000) : null } : null;
  };
  /** Sessions in a project folder that PocketBridge didn't start, newest first, for continuing on the phone. */
  const externalSessions = async folder => {
    // Every session ever started in the home folder would land in General; it lists only its own chats.
    if (folder.general) return [];
    const managed = new Set(all('SELECT id FROM chats UNION SELECT agentSession FROM chats WHERE agentSession IS NOT NULL UNION SELECT forkFrom FROM chats WHERE forkFrom IS NOT NULL UNION SELECT id FROM deleted_chats UNION SELECT id FROM hidden_sessions').map(item => item.id));
    const sessions = [];
    if (available.claude && enabled.claude) {
      const encoded = join(claudeProjectsDir, folder.path.replace(/[^a-zA-Z0-9]/g, '-'));
      const dirs = new Set([encoded, ...[...sessionMeta].filter(([, meta]) => { try { return meta.cwd && realpathSync(meta.cwd) === folder.path; } catch { return false; } }).map(([dir]) => dir)]);
      for (const dir of dirs) if (existsSync(dir)) sessions.push(...claudeSessions(dir).filter(session => { try { return !session.cwd || realpathSync(session.cwd) === folder.path; } catch { return false; } }));
    }
    if (available.codex && enabled.codex && options.codexSessions !== false) {
      const listed = await codexRequest({ ...agents.probe('codex'), method: 'thread/list', params: { cwd: folder.path, limit: 25 } });
      const seen = new Set();
      for (const thread of Array.isArray(listed?.data) ? listed.data : []) {
        if (!thread?.id || seen.has(thread.id) || thread.ephemeral || thread.parentThreadId || (thread.threadSource && thread.threadSource !== 'user')) continue;
        seen.add(thread.id);
        sessions.push({ agent: 'codex', id: thread.id, title: oneLine(thread.name || thread.preview, 100) || 'Codex session', updatedAt: Number(thread.updatedAt) * 1000 || 0, lastPrompt: oneLine(thread.preview, 4000) || null, lastReply: null });
      }
    }
    return sessions.filter(session => !managed.has(session.id)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
  };

  return { project, projectRow, list, ensureGeneral, refreshDiscovery, refreshIcons, iconOf, close: () => { clearInterval(iconTimer); return iconScan ?? Promise.resolve(); }, loadCodexSkills, freshSkills, knownSkills, commands, git, changed, codexLastExchange, externalSessions };
}
