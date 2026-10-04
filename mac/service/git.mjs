// Git branch and line counts for a project folder.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

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

