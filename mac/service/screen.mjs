// Locking the Mac's screen from a client, and whether it is locked now. The macOS calls sit in `macScreen` so tests
// pass a fake and never lock the real session.
import { execFile } from 'node:child_process';
import { fail, pause } from './util.mjs';

const output = (file, args, input) => new Promise((resolveRun, reject) => {
  const child = execFile(file, args, { timeout: 5000, maxBuffer: 1 << 20, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolveRun(stdout));
  if (input !== undefined) child.stdin.end(input);
});

// loginwindow's own "Lock Screen" call (the menu item and Ctrl-Cmd-Q use it). It locks at once whatever the
// "require password" delay is, and needs no Accessibility or other privacy permission. bindFunction throws if a
// future macOS removes the symbol, so a missing call fails loudly instead of doing nothing.
const lockScript = "ObjC.import('Foundation'); $.NSBundle.bundleWithPath('/System/Library/PrivateFrameworks/login.framework').load; ObjC.bindFunction('SACLockScreenImmediate', ['int', []]); $.SACLockScreenImmediate();";

export const macScreen = {
  /** true or false for this user's console session; null when it isn't on the console (another user is). */
  async locked() {
    const users = JSON.parse(await output('/usr/bin/plutil', ['-extract', 'IOConsoleUsers', 'json', '-o', '-', '-'], await output('/usr/sbin/ioreg', ['-n', 'Root', '-d1', '-a'])));
    const mine = users.find(user => user.kCGSSessionUserIDKey === process.getuid() && user.kCGSSessionOnConsoleKey);
    return mine ? mine.CGSSessionScreenIsLocked === true : null;
  },
  async lock() { await output('/usr/bin/osascript', ['-l', 'JavaScript', '-e', lockScript]); },
};

/** system is macScreen, a test fake, or null where locking isn't offered (tests, other platforms). */
export function createScreen(ctx, system, { pollMs = 15_000, settleMs = 3000 } = {}) {
  let locked = null, checkedAt = 0, checking = null, locking = null;
  const callers = new Set();
  const check = () => checking ??= (async () => {
    let value = null;
    try { value = await system.locked(); } catch { /* unknown */ }
    // The first reading is not news; later changes tell clients to fetch state.
    const changed = checkedAt > 0 && value !== locked;
    locked = value; checkedAt = Date.now();
    if (changed && !ctx.closed) ctx.change('state');
    return value;
  })().finally(() => { checking = null; });
  const timer = system ? setInterval(check, pollMs) : null;
  timer?.unref();
  if (system) check();
  return {
    available: Boolean(system),
    /** The last reading, refreshed in the background when it is a few seconds old; state never waits for it. */
    get locked() { if (system && Date.now() - checkedAt > 3000) check(); return locked; },
    /**
     * Callers waiting together share one lock. Each one's ready is asked again at the end and right before macOS is:
     * a caller that lost access meanwhile gets 401, and nothing locks unless a caller still has access.
     */
    lock: (ready = () => true) => {
      callers.add(ready);
      locking ??= lockOnce().finally(() => { locking = null; callers.clear(); });
      return locking.finally(() => { if (!ready()) throw fail(401, 'Unauthorized'); });
    },
    close() { clearInterval(timer); },
  };
  async function lockOnce() {
    if (!system) throw fail(404, 'Locking is not available on this Mac');
    if (await check() === true) return true;
    if (![...callers].some(caller => caller())) throw fail(401, 'Unauthorized');
    const log = result => { if (!ctx.testing) console.log(`Screen lock requested: ${result}`); };
    try { await system.lock(); } catch { log('refused'); throw fail(502, 'macOS refused to lock the screen'); }
    const end = Date.now() + settleMs;
    let value = await check();
    while (value === false && Date.now() < end) { await pause(200); value = await check(); }
    log(value === true ? 'locked' : value === false ? 'still unlocked' : 'unknown');
    if (value === false) throw fail(502, 'The Mac did not lock');
    return value;
  }
}
