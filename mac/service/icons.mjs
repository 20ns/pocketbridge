// A project's own logo: favicon, logo or app icon files in the usual places, read without following symlinks,
// measured from their headers, and served as a small raster image. ICO, ICNS and SVG become PNG with macOS tools.
import { readdir, lstat, open, readFile, writeFile, mkdtemp, rm, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, extname, basename, dirname, sep } from 'node:path';

// Folders that commonly hold a project's logo, checked one level deep, in order of preference.
const places = ['', 'public', 'static', 'assets', 'src/assets', 'app', 'src/app', 'web', 'docs', '.github', 'src', 'resources', 'build', 'images', 'img', 'icons', 'media', 'branding',
  'assets/images', 'assets/icons', 'assets/img', 'public/images', 'public/img', 'public/icons', 'static/img', 'static/images', 'docs/assets', 'docs/images', '.github/assets', 'src-tauri/icons'];
const iconName = /^(favicon|logo|icon|app[-_]?icon|apple-touch-icon(-precomposed)?|android-chrome|ic_launcher|mstile|brand|mark)([-_.@ ][\w@. -]*)?\.(png|jpe?g|webp|gif|ico|icns|svg)$/i;
const layer = /foreground|background|monochrome|maskable|mask|shadow/i;
// Never descended into while looking for Android launcher or Xcode app icons.
const skipped = new Set(['node_modules', 'build', 'dist', 'out', 'Pods', 'DerivedData', 'vendor', 'target', 'venv', 'env', '__pycache__', 'coverage', 'tmp', 'intermediates', 'generated', 'bower_components', 'Carthage', 'site-packages', 'logs']);
const rasters = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
export const iconTypes = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const maxSource = 5 * 1024 * 1024, maxServed = 512 * 1024, maxSide = 512;

const head = async (path, length = 256 * 1024) => {
  let handle;
  try { handle = await open(path, 'r'); const buf = Buffer.alloc(length); const { bytesRead } = await handle.read(buf, 0, length, 0); return buf.subarray(0, bytesRead); }
  catch { return null; } finally { await handle?.close(); }
};
/**
 * Reads a project file only if it is still a regular file inside the project: its folder must resolve inside the
 * root and the file itself is opened without following a symlink, so a file swapped for a link after the scan is
 * refused. Resolves {data, info} with at most `length` bytes, or null.
 */
const readInside = async (root, path, length) => {
  let handle;
  try {
    const top = await realpath(root), folder = await realpath(dirname(path));
    if (folder !== top && !folder.startsWith(top + sep)) return null;
    handle = await open(join(folder, basename(path)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0 || info.size > maxSource) return null;
    const want = Math.min(length ?? info.size, info.size), buf = Buffer.alloc(want);
    const { bytesRead } = await handle.read(buf, 0, want, 0);
    return { data: buf.subarray(0, bytesRead), info };
  } catch { return null; } finally { await handle?.close(); }
};
/** Width and height from an image's own header; SVG reports its aspect at a nominal 512 px. */
export function measure(data, ext) {
  if (!data || data.length < 10) return null;
  const be16 = at => data.readUInt16BE(at), le16 = at => data.readUInt16LE(at), le24 = at => data[at] | data[at + 1] << 8 | data[at + 2] << 16;
  if (ext === 'png' && data.length >= 24 && data.subarray(1, 4).toString('latin1') === 'PNG') return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (ext === 'gif' && data.subarray(0, 3).toString('latin1') === 'GIF') return { width: le16(6), height: le16(8) };
  if (ext === 'webp' && data.length >= 30 && data.subarray(8, 12).toString('latin1') === 'WEBP') {
    const chunk = data.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8 ') return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (chunk === 'VP8L') return { width: 1 + (((data[22] & 0x3f) << 8) | data[21]), height: 1 + (((data[24] & 0xf) << 10) | (data[23] << 2) | ((data[22] & 0xc0) >> 6)) };
    if (chunk === 'VP8X') return { width: 1 + le24(24), height: 1 + le24(27) };
    return null;
  }
  if ((ext === 'jpg' || ext === 'jpeg') && data[0] === 0xff && data[1] === 0xd8) {
    for (let at = 2; at + 9 < data.length;) {
      if (data[at] !== 0xff) { at++; continue; }
      const marker = data[at + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: be16(at + 7), height: be16(at + 5) };
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { at += marker === 0xff ? 1 : 2; continue; }
      at += 2 + be16(at + 2);
    }
    return null;
  }
  if (ext === 'ico' && le16(0) === 0 && le16(2) === 1) {
    let side = 0;
    for (let index = 0; index < Math.min(le16(4), 64) && 6 + index * 16 + 2 <= data.length; index++) side = Math.max(side, data[6 + index * 16] || 256);
    return side ? { width: side, height: side } : null;
  }
  if (ext === 'icns' && data.subarray(0, 4).toString('latin1') === 'icns') return { width: 512, height: 512 };
  if (ext === 'svg') {
    const source = data.toString('utf8');
    if (!/<svg[\s>]/i.test(source)) return null;
    const box = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(source);
    const width = Number(box?.[1] ?? /<svg[^>]*\swidth\s*=\s*["']([\d.]+)/i.exec(source)?.[1]) || 1, height = Number(box?.[2] ?? /<svg[^>]*\sheight\s*=\s*["']([\d.]+)/i.exec(source)?.[1]) || 1;
    return { width: Math.round(512 * Math.min(1, width / height)), height: Math.round(512 * Math.min(1, height / width)) };
  }
  return null;
}

/** Entries of a folder that is really inside the project: symlinked folders and files are never followed. */
const entries = async (root, rel = '') => {
  let dir = root;
  try {
    for (const part of ['', ...rel.split('/').filter(Boolean)]) { dir = join(dir, part); if (!(await lstat(dir)).isDirectory()) return []; }
    return await readdir(dir, { withFileTypes: true });
  } catch { return []; }
};

/**
 * Icon candidates in a project folder, best first. Looks in the common places, Android `res/mipmap-*` launcher
 * icons and Xcode `AppIcon.appiconset`, visiting at most `budget` folders no deeper than `depth`.
 */
export async function findIcons(root, { budget = 400, depth = 6 } = {}) {
  const found = [];
  const consider = async (path, rel, rank, weight) => {
    const ext = extname(path).slice(1).toLowerCase();
    const read = await readInside(root, path, ext === 'svg' ? 64 * 1024 : 256 * 1024);
    if (!read) return;
    const info = read.info, size = measure(read.data, ext);
    if (!size || Math.min(size.width, size.height) < 16) return;
    const side = Math.min(size.width, size.height), square = Math.max(size.width, size.height) / side <= 1.25;
    found.push({ root, path, rel, ext, size: info.size, mtimeMs: info.mtimeMs, width: size.width, height: size.height, rank, score: Math.min(side, maxSide) * (square ? 1 : 0.3) * weight });
  };
  const weight = name => /^(apple-touch-icon|app[-_]?icon|ic_launcher|icon|android-chrome)/i.test(name) ? 1 : /^logo/i.test(name) ? 0.9 : 0.8;
  for (const [rank, place] of places.entries()) {
    for (const entry of await entries(root, place)) {
      if (entry.isFile() && iconName.test(entry.name) && !layer.test(entry.name)) await consider(join(root, place, entry.name), join(place, entry.name), rank, weight(entry.name));
    }
  }
  // App icons sit deeper: android/app/src/main/res/mipmap-xxxhdpi, ios/Runner/Assets.xcassets/AppIcon.appiconset.
  let visited = 0;
  const queue = [{ dir: root, rel: '', level: 0 }];
  while (queue.length && visited < budget) {
    const { dir, rel, level } = queue.shift(); visited++;
    for (const entry of await entries(dir)) {
      if (!entry.isDirectory()) continue;
      const appIcons = /^mipmap-/.test(entry.name) || /^AppIcon.*\.appiconset$/.test(entry.name);
      // Icon folders are read here rather than queued, and they count against the same budget.
      if (appIcons && ++visited > budget) break;
      const path = join(dir, entry.name), next = join(rel, entry.name);
      if (/^mipmap-/.test(entry.name)) {
        for (const file of await entries(path)) if (file.isFile() && /^ic_launcher(_round)?\.(png|webp)$/.test(file.name)) await consider(join(path, file.name), join(next, file.name), places.length, file.name.includes('round') ? 0.95 : 1);
      } else if (/^AppIcon.*\.appiconset$/.test(entry.name)) {
        for (const file of await entries(path)) if (file.isFile() && /\.png$/i.test(file.name)) await consider(join(path, file.name), join(next, file.name), places.length, 1);
      } else if (level + 1 < depth && !skipped.has(entry.name) && (!entry.name.startsWith('.') || entry.name === '.github')) queue.push({ dir: path, rel: next, level: level + 1 });
    }
  }
  return found.sort((a, b) => b.score - a.score || a.rank - b.rank || a.rel.localeCompare(b.rel));
}

const tool = (command, args, signal) => new Promise(resolveTool => execFile(command, args, { timeout: 15_000, signal }, error => resolveTool(!error)));
/**
 * The icon as served bytes: a small PNG, JPEG, WebP or GIF as it is, anything larger or in another format as a
 * PNG of at most 256 px from `sips` (or `qlmanage` for SVG). Resolves {type, data} or null.
 */
export async function renderIcon(candidate, workDir, signal) {
  // The scan may be stale: the bytes are read again, from inside the project only, and measured again.
  const read = await readInside(candidate.root, candidate.path);
  const size = read && measure(read.data, candidate.ext);
  if (!size) return null;
  const type = rasters[candidate.ext];
  if (type && read.data.length <= maxServed && Math.max(size.width, size.height) <= maxSide) return { type, data: read.data };
  // Converters only ever see a private copy of those bytes, never the project's own path.
  const scratch = await mkdtemp(join(workDir, 'render-'));
  try {
    const source = join(scratch, `source.${candidate.ext}`);
    await writeFile(source, read.data, { mode: 0o600 });
    let output = join(scratch, 'icon.png');
    if (candidate.ext === 'svg') {
      if (!await tool('/usr/bin/qlmanage', ['-t', '-s', '256', '-o', scratch, source], signal)) return null;
      output = `${source}.png`;
    } else {
      if (!await tool('/usr/bin/sips', ['-s', 'format', 'png', source, '--out', output], signal)) return null;
      // Shrunk, never enlarged: a 32 px favicon stays 32 px.
      const converted = measure(await head(output, 64), 'png');
      if (converted && Math.max(converted.width, converted.height) > 256 && !await tool('/usr/bin/sips', ['-Z', '256', output], signal)) return null;
    }
    const data = await readFile(output).catch(() => null);
    return data && data.length <= maxServed && data.subarray(1, 4).toString('latin1') === 'PNG' ? { type: 'image/png', data } : null;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
