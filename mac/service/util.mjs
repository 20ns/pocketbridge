// Small helpers shared by the service modules.
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { spawnSync, execFile } from 'node:child_process';

export const secret = () => randomBytes(32).toString('base64url');
// Phone tokens are kept only as this hash: a copy of the data folder (a backup) can't be used to reach the Mac.
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
export const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
export const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const fail = (status, message) => Object.assign(new Error(message), { status });
export const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
export const text = (value, label, max = 100_000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw fail(400, `Invalid ${label}`);
  return value.trim();
};
export const processStamp = pid => spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000 }).stdout?.trim();
const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch { return false; } };
export const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
export const terminateGroup = async (pid, timeout) => {
  if (!pid) return;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) {
    try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; return; }
    const end = Date.now() + (signal === 'SIGKILL' ? 100 : timeout);
    while (groupAlive(pid) && Date.now() < end) await pause(20);
    if (!groupAlive(pid)) return;
  }
};
export const listed = (value, allowed, label) => { if (typeof value !== 'string' || !allowed.includes(value)) throw fail(400, `Unsupported ${label}`); return value; };
// Chat list previews read as plain text: Markdown markers, code blocks and link targets are dropped.
export const plainText = value => value.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`([^`\n]*)`/g, '$1').replace(/\*\*|__|~~/g, '')
  .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, '$1').replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '').replace(/\s+/g, ' ').trim();
export const oneLine = (value, max = 4000) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
/** A tool call in a few words, for a sub-agent's current activity. */
export const brief = input => {
  if (!input || typeof input !== 'object') return '';
  const value = ['description', 'command', 'file_path', 'pattern', 'path', 'url', 'query', 'prompt'].map(key => input[key]).find(item => typeof item === 'string' && item.trim());
  return value ? oneLine(value.includes('/') && !value.includes(' ') ? value.split('/').filter(Boolean).pop() ?? value : value, 120) : '';
};
export const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
/** Opens a URL with macOS's `open`, as the Claude CLI does for its desktop hand-off. */
export const openUrl = url => new Promise(resolveOpen => execFile('open', [url], { timeout: 10_000 }, error => resolveOpen(!error)));
/** The image type of uploaded bytes, read from their signature rather than a client-supplied header. */
export const imageType = data => data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png' : data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff ? 'image/jpeg'
  : data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP' ? 'image/webp' : ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('latin1')) ? 'image/gif' : null;
export const imageExtensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
/** One line of CLI-provided text, trimmed to a display length. */
export const clean = (value, max = 160) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
