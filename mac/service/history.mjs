// Read-only session metadata from Claude Code and Codex on this Mac: project folders and recent sessions.
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { clean } from './util.mjs';

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

